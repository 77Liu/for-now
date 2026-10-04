import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createAttachmentStorage,
  stageAttachmentCompleteBackup
} from "../src/shared/attachments/index.mjs";
import { publicKeepsake } from "../src/modules/keepsakes/index.mjs";

const run = promisify(execFile), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "growth-restore-validation-"));
const sourceDir = path.join(temporary, "source"), dataDir = path.join(temporary, "backup");
const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger"];
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : objectValue(value)
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
try {
  const users = [{ id: "first", username: "first" }, { id: "second", username: "second" }];
  const aiBudget = {
    version: 1,
    periods: [{ key: "2026-10-03", knownCostMicros: 1_250_000 }],
    reservations: []
  };
  const relationalAccounts = [];
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "auth.json"), JSON.stringify({ version: 1, users, sessions: [] }));
  await fs.writeFile(path.join(sourceDir, "ai-budget.json"), JSON.stringify(aiBudget));
  for (const user of users) {
    const dir = path.join(sourceDir, "users", user.id), attachments = path.join(dir, "attachments");
    await fs.mkdir(attachments, { recursive: true });
    const store = Object.fromEntries(collections.map(key => [key, []]));
    const documents = {};
    store.version = 15;
    if (user.id === "first") {
      store.captures.push({
        id: "capture",
        content: "restored",
        transcription: {
          status: "ready",
          provider: "legacy",
          rawText: "raw",
          polishedText: "polished",
          updatedAt: "2026-09-29T09:00:00.000Z",
          errorCode: ""
        },
        speechCache: [{ cacheKey: "private-cache-entry" }]
      });
      store.books.push({ id: "book", imagePath: "/attachments/cover.png" });
      store.keepsakes.push({
        id: "keepsake",
        title: "restored keepsake",
        occurredAt: "2026-09-29T09:00:00.000Z",
        occurredOn: "2026-09-29",
        originalPath: "/attachments/cover.png",
        cutoutPath: "/attachments/cover.png",
        thumbPath: "/attachments/cover.png",
        displayPath: "/attachments/cover.png",
        editPath: "/attachments/cover.png",
        alphaMaskPath: "/attachments/cover.png"
      });
      store.actions.push({ id: "action", title: "restored action" });
      store.habits.push({ id: "habit", title: "restored habit" });
      store.habitCheckins.push({ id: "habit-checkin", habitId: "habit", occurredOn: "2026-09-29" });
      store.feedback.push({ id: "feedback", body: "restored feedback" });
      store.validationLedger.push({ id: "validation", participantRef: "member-01" });
      const settings = { version: 1, profiles: {}, scenarios: {}, responseStyles: {} };
      await fs.writeFile(path.join(dir, "llm-settings.json"), JSON.stringify(settings));
      documents.settings = digest(settings);
      await fs.writeFile(path.join(attachments, "cover.png"), "image");
    } else store.journals.push({ id: "journal", content: "second" });
    await fs.writeFile(path.join(dir, "store.json"), JSON.stringify(store));
    relationalAccounts.push({
      accountId: user.id,
      storeSha256: digest(store),
      documents,
      attachments: []
    });
  }
  await fs.writeFile(path.join(sourceDir, "export-manifest.json"), JSON.stringify({
    format: "for-now-relational-export-v1",
    createdAt: "2026-09-29T09:00:00.000Z",
    aiBudget: { file: "ai-budget.json", sha256: digest(aiBudget) },
    accounts: relationalAccounts
  }));
  await stageAttachmentCompleteBackup({
    sourceDir,
    outputDir: dataDir,
    storage: createAttachmentStorage({ mode: "local" }),
    sourceAttachmentStorage: "local",
    now: () => "2026-09-29T09:00:00.000Z"
  });
  const cliBackup = path.join(temporary, "cli-backup");
  const cliResult = await run(process.execPath, [
    path.join(root, "scripts/stage-backup-data.mjs"),
    "--source-dir", sourceDir,
    "--output-dir", cliBackup,
    "--source-storage", "local"
  ], {
    env: { ...process.env, ATTACHMENT_STORAGE: "local" }
  });
  assert.equal(JSON.parse(cliResult.stdout).status, "staged");
  assert.equal(JSON.parse(await fs.readFile(path.join(cliBackup, "backup-manifest.json"), "utf8")).complete, true);
  const validator = path.join(root, "scripts/validate-restored-data.mjs");
  const validationArgs = [validator, dataDir, "--require-relational-export"];
  const { stdout } = await run(process.execPath, validationArgs);
  const result = JSON.parse(stdout);
  assert.deepEqual({
    users: result.users,
    records: result.records,
    totalRecords: result.totalRecords,
    attachmentReferences: result.attachmentReferences,
    localAttachments: result.localAttachments,
    firstAttachment: result.firstAttachment
  }, {
    users: 2,
    records: 8,
    totalRecords: 9,
    attachmentReferences: 1,
    localAttachments: 1,
    firstAttachment: "/attachments/cover.png"
  });
  for (const key of collections) {
    assert.equal(result.collectionEvidence[key].count, ["captures", "books", "keepsakes", "actions", "habits", "habitCheckins", "feedback", "validationLedger"].includes(key) ? 1 : 0);
    assert.match(result.collectionEvidence[key].idsSha256, /^[a-f0-9]{64}$/);
    assert.match(result.collectionEvidence[key].contentSha256, /^[a-f0-9]{64}$/);
  }
  const restoredKeepsakes = JSON.parse(await fs.readFile(path.join(dataDir, "users", "first", "store.json"), "utf8")).keepsakes;
  const restoredCaptures = JSON.parse(await fs.readFile(path.join(dataDir, "users", "first", "store.json"), "utf8")).captures;
  const expectedCaptures = restoredCaptures.map(item => {
    const { speechCache: _speechCache, ...capture } = item;
    return {
      ...capture,
      transcription: {
        ...capture.transcription,
        condensedText: "",
        condenseErrorCode: ""
      }
    };
  });
  assert.equal(result.collectionEvidence.captures.contentSha256, digest(expectedCaptures));
  assert.notEqual(result.collectionEvidence.captures.contentSha256, digest(restoredCaptures));
  assert.equal("originalPath" in publicKeepsake(restoredKeepsakes[0]), false);
  assert.equal(result.collectionEvidence.keepsakes.contentSha256, digest(restoredKeepsakes.map(publicKeepsake)));
  assert.notEqual(result.collectionEvidence.keepsakes.contentSha256, digest(restoredKeepsakes));
  assert.equal(result.attachmentManifest.format, "for-now-attachment-complete-backup-v1");
  assert.equal(result.attachmentManifest.attachments, 1);
  assert.equal(result.attachmentManifest.sourceAttachmentStorage, "local");
  assert.equal(result.aiBudgetSha256, digest(aiBudget));
  assert.equal(result.relationalExport, true);
  const budgetFile = path.join(dataDir, "ai-budget.json");
  await fs.rename(budgetFile, `${budgetFile}.missing`);
  await assert.rejects(
    run(process.execPath, validationArgs),
    /no valid AI budget document/
  );
  await fs.rename(`${budgetFile}.missing`, budgetFile);
  await fs.writeFile(budgetFile, JSON.stringify({ ...aiBudget, tampered: true }));
  await assert.rejects(
    run(process.execPath, validationArgs),
    /AI budget hash does not match/
  );
  await fs.writeFile(budgetFile, JSON.stringify(aiBudget));
  const exportManifestFile = path.join(dataDir, "export-manifest.json");
  await fs.rename(exportManifestFile, `${exportManifestFile}.missing`);
  await assert.rejects(
    run(process.execPath, validationArgs),
    /no valid relational export manifest/
  );
  await fs.rename(`${exportManifestFile}.missing`, exportManifestFile);
  const validExportManifest = JSON.parse(await fs.readFile(exportManifestFile, "utf8"));
  const invalidAccountManifest = structuredClone(validExportManifest);
  invalidAccountManifest.accounts[0].accountId = 123;
  await fs.writeFile(exportManifestFile, JSON.stringify(invalidAccountManifest));
  await assert.rejects(
    run(process.execPath, validationArgs),
    /relational export manifest is invalid/
  );
  await fs.writeFile(exportManifestFile, JSON.stringify(validExportManifest));
  const firstStoreFile = path.join(dataDir, "users", "first", "store.json");
  const firstStore = await fs.readFile(firstStoreFile, "utf8");
  await fs.writeFile(firstStoreFile, JSON.stringify({ ...JSON.parse(firstStore), tampered: true }));
  await assert.rejects(
    run(process.execPath, validationArgs),
    /store content does not match/
  );
  await fs.writeFile(firstStoreFile, firstStore);
  const settingsFile = path.join(dataDir, "users", "first", "llm-settings.json");
  const settings = await fs.readFile(settingsFile, "utf8");
  await fs.writeFile(settingsFile, JSON.stringify({ ...JSON.parse(settings), tampered: true }));
  await assert.rejects(
    run(process.execPath, validationArgs),
    /account document does not match/
  );
  await fs.writeFile(settingsFile, settings);
  const manifestFile = path.join(dataDir, "backup-manifest.json");
  await fs.rename(manifestFile, `${manifestFile}.missing`);
  await assert.rejects(
    run(process.execPath, validationArgs),
    /no valid attachment manifest/
  );
  await fs.rename(`${manifestFile}.missing`, manifestFile);
  const restoredAttachment = path.join(dataDir, "users", "first", "attachments", "cover.png");
  await fs.unlink(restoredAttachment);
  await assert.rejects(
    run(process.execPath, validationArgs),
    /Restored attachment is missing/
  );
  await fs.writeFile(restoredAttachment, "tampered");
  await assert.rejects(
    run(process.execPath, validationArgs),
    /Restored attachment content does not match/
  );
  await fs.writeFile(restoredAttachment, "image");
  const brokenDir = path.join(dataDir, "users", "second");
  const brokenStore = JSON.parse(await fs.readFile(path.join(brokenDir, "store.json"), "utf8"));
  delete brokenStore.feedback;
  await fs.writeFile(path.join(brokenDir, "store.json"), JSON.stringify(brokenStore));
  const brokenExportManifest = JSON.parse(await fs.readFile(exportManifestFile, "utf8"));
  brokenExportManifest.accounts.find(account => account.accountId === "second").storeSha256 = digest(brokenStore);
  await fs.writeFile(exportManifestFile, JSON.stringify(brokenExportManifest));
  await assert.rejects(
    run(process.execPath, validationArgs),
    /Restored store is missing feedback/
  );
  const auth = JSON.parse(await fs.readFile(path.join(dataDir, "auth.json"), "utf8"));
  assert.equal(auth.sessions.length, 1);
  assert.notEqual(auth.sessions[0].tokenHash, result.sessionToken);
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);

  const remoteSource = path.join(temporary, "remote-source");
  const remoteBackup = path.join(temporary, "remote-backup");
  const mockDir = path.join(temporary, "mock-oss");
  await fs.mkdir(path.join(remoteSource, "users", "remote", "attachments"), { recursive: true });
  await fs.writeFile(path.join(remoteSource, "auth.json"), JSON.stringify({
    version: 1,
    users: [{ id: "remote", username: "remote" }],
    sessions: []
  }));
  const remoteStore = Object.fromEntries(collections.map(key => [key, []]));
  remoteStore.version = 15;
  remoteStore.captures.push({ id: "remote-capture", attachmentPaths: ["/attachments/remote.png"] });
  await fs.writeFile(path.join(remoteSource, "users", "remote", "store.json"), JSON.stringify(remoteStore));
  const localFallback = path.join(remoteSource, "users", "remote", "attachments", "remote.png");
  await fs.writeFile(localFallback, "stale-local-fallback");
  const mock = createAttachmentStorage({ mode: "mock", testMode: true, mockDir, prefix: "attachments" });
  await mock.put({ ownerId: "remote", name: "remote.png", data: Buffer.from("current-remote"), localFile: localFallback });
  await mock.put({ ownerId: "remote", name: "unreferenced.webp", data: Buffer.from("remote-orphan"), localFile: path.join(path.dirname(localFallback), "unreferenced.webp") });
  const remoteManifest = await stageAttachmentCompleteBackup({
    sourceDir: remoteSource,
    outputDir: remoteBackup,
    storage: mock,
    sourceAttachmentStorage: "oss",
    now: () => "2026-09-29T09:30:00.000Z"
  });
  assert.equal(remoteManifest.summary.attachments, 2, "unreferenced remote objects remain recoverable");
  assert.equal(await fs.readFile(path.join(remoteBackup, "users", "remote", "attachments", "remote.png"), "utf8"), "current-remote");
  assert.equal(await fs.readFile(path.join(remoteBackup, "users", "remote", "attachments", "unreferenced.webp"), "utf8"), "remote-orphan");
  await mock.remove({ ownerId: "remote", name: "remote.png", localFile: path.join(temporary, "unused") });
  await assert.rejects(
    stageAttachmentCompleteBackup({
      sourceDir: remoteSource,
      outputDir: path.join(temporary, "missing-remote-backup"),
      storage: mock,
      sourceAttachmentStorage: "oss"
    }),
    /Referenced attachment is missing from primary storage/
  );

  const restoreScript = await fs.readFile(path.join(root, "deploy/restore-drill.sh"), "utf8");
  const backupScript = await fs.readFile(path.join(root, "deploy/backup-to-oss.sh"), "utf8");
  assert.match(backupScript, /stage-backup-data\.mjs/);
  assert.doesNotMatch(backupScript, /tar[^\n]*"\$DATA_DIR"/);
  assert.match(restoreScript, /ATTACHMENT_STORAGE=local/);
  assert.match(restoreScript, /--require-relational-export/);
  assert.doesNotMatch(restoreScript, /ATTACHMENT_STORAGE="\$\{ATTACHMENT_STORAGE/);
  console.log("Restore validation checks passed: AI budget and relational hashes, complete attachment manifest, missing/tampered rejection, remote materialization, local-only drill and temporary authenticated session.");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
