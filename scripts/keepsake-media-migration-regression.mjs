import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createKeepsakeMediaMigration } from "../src/app/index.mjs";

const clone = value => structuredClone(value);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const legacy = (id, overrides = {}) => ({
  id,
  title: `private-${id}`,
  originalPath: `/attachments/${id}-original.png`,
  cutoutPath: `/attachments/${id}-cutout.png`,
  thumbPath: `/attachments/${id}-cutout.png`,
  displayPath: `/attachments/${id}-cutout.png`,
  editPath: `/attachments/${id}-original.png`,
  alphaMaskPath: `/attachments/${id}-cutout.png`,
  derivativeState: "legacy",
  version: 2,
  mediaVersion: 0,
  ...overrides
});

function repositoryFor(initial, { beforeUpdate = () => {} } = {}) {
  let value = clone(initial);
  let updates = 0;
  return {
    async read() {
      return clone(value);
    },
    async update(mutator) {
      beforeUpdate(value);
      const result = await mutator(value);
      updates += 1;
      return clone(result);
    },
    snapshot() {
      return clone(value);
    },
    updates() {
      return updates;
    }
  };
}

const previews = [];
const derivations = [];
const discarded = [];
let generated = 0;
const mediaReceipt = () => ({
  source: {
    original: { bytes: 4000, sha256: "a".repeat(64) },
    alphaMask: { bytes: 1000, sha256: "b".repeat(64) }
  },
  derivatives: {
    thumb: { bytes: 100, width: 100, height: 80, quality: 80, sha256: "c".repeat(64) },
    display: { bytes: 200, width: 200, height: 160, quality: 84, sha256: "d".repeat(64) },
    edit: { bytes: 250, width: 200, height: 160, quality: 84, sha256: "e".repeat(64) },
    alphaMask: { bytes: 50, width: 200, height: 160, quality: 90, sha256: "f".repeat(64) }
  }
});
const attachments = {
  async previewKeepsakeSet(input) {
    previews.push(clone(input));
    if (input.originalPath.includes("blocked")) {
      throw Object.assign(new Error("mask mismatch"), { code: "ALPHA_MASK_DIMENSION_MISMATCH" });
    }
    return mediaReceipt();
  },
  async deriveKeepsakeSet(input) {
    derivations.push(clone(input));
    generated += 1;
    const prefix = `/attachments/generated-${generated}`;
    return {
      paths: {
        originalPath: input.originalPath,
        thumbPath: `${prefix}-thumb.webp`,
        displayPath: `${prefix}-display.webp`,
        editPath: `${prefix}-edit.webp`,
        alphaMaskPath: `${prefix}-mask.webp`
      },
      ...mediaReceipt()
    };
  },
  async discard(paths) {
    discarded.push([...paths]);
  }
};

let clock = 0;
const repository = repositoryFor({
  keepsakes: [
    legacy("legacy-a"),
    legacy("ready", { derivativeState: "ready" }),
    legacy("missing", { cutoutPath: "" })
  ]
});
const migration = createKeepsakeMediaMigration({
  repository,
  attachments,
  accountId: "account-a",
  now: () => `2026-10-01T00:00:0${clock++}.000Z`
});
const plan = await migration.plan({ requirePrimaryStorage: true });
assert.equal(repository.updates(), 0, "dry-run planning must not write the repository");
assert.equal(plan.summary.planned, 1);
assert.equal(plan.summary.blocked, 0);
assert.equal(plan.items[0].id, "legacy-a");
assert.equal(plan.items[0].version, 2);
assert.equal(plan.items[0].mediaVersion, 0);
assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
assert.match(plan.items[0].mediaSha256, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(plan).includes("private-legacy-a"), false, "plan must not expose keepsake text");
assert.deepEqual(previews[0], {
  originalPath: "/attachments/legacy-a-original.png",
  alphaMaskPath: "/attachments/legacy-a-cutout.png",
  requirePrimaryStorage: true
});

await assert.rejects(
  migration.apply(plan, { expectedPlanSha256: "0".repeat(64) }),
  { code: "MIGRATION_PLAN_MISMATCH" }
);
assert.equal(derivations.length, 0, "hash mismatch must fail before generating files");

const applied = await migration.apply(plan, { expectedPlanSha256: plan.planSha256 });
assert.deepEqual(applied.summary, { migrated: 1, conflicted: 0, failed: 0 });
const migrated = repository.snapshot().keepsakes.find(item => item.id === "legacy-a");
assert.equal(migrated.derivativeState, "ready");
assert.equal(migrated.mediaVersion, 1);
assert.equal(migrated.version, 3);
assert.equal(migrated.cutoutPath, "/attachments/legacy-a-cutout.png", "apply must retain the legacy rollback asset");
assert.equal(migrated.alphaMaskPath, "/attachments/generated-1-mask.webp");
assert.deepEqual(discarded, []);
assert.equal((await migration.plan()).summary.planned, 0, "a completed item must not be planned again");

const blockedRepository = repositoryFor({ keepsakes: [legacy("blocked")] });
const blockedMigration = createKeepsakeMediaMigration({
  repository: blockedRepository,
  attachments,
  accountId: "account-b"
});
const blockedPlan = await blockedMigration.plan();
assert.equal(blockedPlan.summary.blocked, 1);
assert.equal(blockedPlan.items[0].errorCode, "ALPHA_MASK_DIMENSION_MISMATCH");
await assert.rejects(
  blockedMigration.apply(blockedPlan, { expectedPlanSha256: blockedPlan.planSha256 }),
  { code: "MIGRATION_PLAN_BLOCKED" }
);
assert.equal(blockedRepository.updates(), 0);

let drifted = false;
const conflictRepository = repositoryFor(
  { keepsakes: [legacy("conflict")] },
  {
    beforeUpdate(store) {
      if (!drifted) {
        drifted = true;
        store.keepsakes[0].mediaVersion = 1;
      }
    }
  }
);
const conflictMigration = createKeepsakeMediaMigration({
  repository: conflictRepository,
  attachments,
  accountId: "account-c"
});
const conflictPlan = await conflictMigration.plan();
const conflicted = await conflictMigration.apply(conflictPlan, {
  expectedPlanSha256: conflictPlan.planSha256
});
assert.deepEqual(conflicted.summary, { migrated: 0, conflicted: 1, failed: 0 });
assert.equal(discarded.length, 1);
assert.equal(discarded[0].length, 4, "a conflicted record must discard every generated derivative");
assert.equal(conflictRepository.snapshot().keepsakes[0].derivativeState, "legacy");
assert.equal(discarded[0].includes("/attachments/conflict-original.png"), false);

const sourceDriftRepository = repositoryFor({ keepsakes: [legacy("source-drift")] });
const sourceDriftMigration = createKeepsakeMediaMigration({
  repository: sourceDriftRepository,
  attachments: {
    ...attachments,
    async deriveKeepsakeSet(input) {
      const derived = await attachments.deriveKeepsakeSet(input);
      derived.source.original.sha256 = "9".repeat(64);
      return derived;
    }
  },
  accountId: "account-d"
});
const sourceDriftPlan = await sourceDriftMigration.plan();
const sourceDrift = await sourceDriftMigration.apply(sourceDriftPlan, {
  expectedPlanSha256: sourceDriftPlan.planSha256
});
assert.deepEqual(sourceDrift.summary, { migrated: 0, conflicted: 1, failed: 0 });
assert.equal(sourceDrift.results[0].errorCode, "MIGRATION_MEDIA_CHANGED");
assert.equal(sourceDriftRepository.updates(), 0, "source drift must stop before a repository write");
assert.equal(sourceDriftRepository.snapshot().keepsakes[0].derivativeState, "legacy");
assert.equal(discarded.at(-1).includes("/attachments/source-drift-original.png"), false);

const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), "keepsake-media-dry-run-"));
try {
  const attachmentsDir = path.join(cliRoot, "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });
  const width = 320, height = 240;
  const pixels = crypto.randomBytes(width * height * 3);
  const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const mask = await sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  }).png().toBuffer();
  await Promise.all([
    fs.writeFile(path.join(attachmentsDir, "legacy-original.jpg"), original),
    fs.writeFile(path.join(attachmentsDir, "legacy-mask.png"), mask)
  ]);
  const storeFile = path.join(cliRoot, "store.json");
  await fs.writeFile(storeFile, `${JSON.stringify({
    version: 15,
    keepsakes: [legacy("cli", {
      originalPath: "/attachments/legacy-original.jpg",
      cutoutPath: "/attachments/legacy-mask.png"
    })],
    trash: [],
    attachmentCleanup: []
  }, null, 2)}\n`);
  const before = await fs.readFile(storeFile, "utf8");
  const output = execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "migrate-keepsake-media.mjs"),
    "--dry-run"
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: cliRoot,
      AUTH_REQUIRED: "0",
      INVITE_CODE_HASH: "",
      PERSISTENCE_BACKEND: "json",
      ATTACHMENT_STORAGE: "local",
      LOCAL_TEST_MODE: "0",
      UPSTREAM_ORIGIN: ""
    }
  });
  const cliPlan = JSON.parse(output);
  assert.equal(cliPlan.mode, "dry-run");
  assert.equal(cliPlan.accounts[0].summary.planned, 1);
  assert.match(cliPlan.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(storeFile, "utf8"), before, "CLI dry-run must not rewrite the source store");
  const appliedOutput = execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "migrate-keepsake-media.mjs"),
    "--apply",
    "--expected-plan-sha256",
    cliPlan.planSha256
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: cliRoot,
      AUTH_REQUIRED: "0",
      INVITE_CODE_HASH: "",
      PERSISTENCE_BACKEND: "json",
      ATTACHMENT_STORAGE: "local",
      LOCAL_TEST_MODE: "0",
      UPSTREAM_ORIGIN: ""
    }
  });
  const cliApplied = JSON.parse(appliedOutput);
  assert.deepEqual(cliApplied.results[0].summary, { migrated: 1, conflicted: 0, failed: 0 });
  const updatedStore = JSON.parse(await fs.readFile(storeFile, "utf8"));
  const updatedKeepsake = updatedStore.keepsakes[0];
  assert.equal(updatedKeepsake.derivativeState, "ready");
  assert.equal(updatedKeepsake.cutoutPath, "/attachments/legacy-mask.png");
  assert.equal(updatedKeepsake.version, 3);
  assert.equal(updatedKeepsake.mediaVersion, 1);
  for (const key of ["thumbPath", "displayPath", "editPath", "alphaMaskPath"]) {
    assert.match(updatedKeepsake[key], /^\/attachments\/.+\.webp$/);
    await fs.access(path.join(attachmentsDir, path.basename(updatedKeepsake[key])));
  }
  await fs.access(path.join(attachmentsDir, "legacy-original.jpg"));
  await fs.access(path.join(attachmentsDir, "legacy-mask.png"));
} finally {
  await fs.rm(cliRoot, { recursive: true, force: true });
}

console.log("Keepsake media migration checks passed: read-only plans, hash confirmation, rollback asset retention, blocked inputs, idempotent selection and conflict cleanup.");
