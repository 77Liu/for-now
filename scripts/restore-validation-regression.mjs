import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createAttachmentStorage,
  stageAttachmentCompleteBackup
} from "../src/shared/attachments/index.mjs";

const run = promisify(execFile), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "growth-restore-validation-"));
const sourceDir = path.join(temporary, "source"), dataDir = path.join(temporary, "backup");
const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger"];
try {
  const users = [{ id: "first", username: "first" }, { id: "second", username: "second" }];
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "auth.json"), JSON.stringify({ version: 1, users, sessions: [] }));
  for (const user of users) {
    const dir = path.join(sourceDir, "users", user.id), attachments = path.join(dir, "attachments");
    await fs.mkdir(attachments, { recursive: true });
    const store = Object.fromEntries(collections.map(key => [key, []]));
    store.version = 15;
    if (user.id === "first") {
      store.captures.push({ id: "capture", content: "restored" });
      store.books.push({ id: "book", imagePath: "/attachments/cover.png" });
      store.actions.push({ id: "action", title: "restored action" });
      store.habits.push({ id: "habit", title: "restored habit" });
      store.habitCheckins.push({ id: "habit-checkin", habitId: "habit", occurredOn: "2026-09-29" });
      store.feedback.push({ id: "feedback", body: "restored feedback" });
      store.validationLedger.push({ id: "validation", participantRef: "member-01" });
      await fs.writeFile(path.join(attachments, "cover.png"), "image");
    } else store.journals.push({ id: "journal", content: "second" });
    await fs.writeFile(path.join(dir, "store.json"), JSON.stringify(store));
  }
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
  const { stdout } = await run(process.execPath, [path.join(root, "scripts/validate-restored-data.mjs"), dataDir]);
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
    records: 7,
    totalRecords: 8,
    attachmentReferences: 1,
    localAttachments: 1,
    firstAttachment: "/attachments/cover.png"
  });
  for (const key of collections) {
    assert.equal(result.collectionEvidence[key].count, key === "captures" || key === "books" || ["actions", "habits", "habitCheckins", "feedback", "validationLedger"].includes(key) ? 1 : 0);
    assert.match(result.collectionEvidence[key].idsSha256, /^[a-f0-9]{64}$/);
    assert.match(result.collectionEvidence[key].contentSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(result.attachmentManifest.format, "for-now-attachment-complete-backup-v1");
  assert.equal(result.attachmentManifest.attachments, 1);
  assert.equal(result.attachmentManifest.sourceAttachmentStorage, "local");
  const manifestFile = path.join(dataDir, "backup-manifest.json");
  await fs.rename(manifestFile, `${manifestFile}.missing`);
  await assert.rejects(
    run(process.execPath, [path.join(root, "scripts/validate-restored-data.mjs"), dataDir]),
    /no valid attachment manifest/
  );
  await fs.rename(`${manifestFile}.missing`, manifestFile);
  const restoredAttachment = path.join(dataDir, "users", "first", "attachments", "cover.png");
  await fs.unlink(restoredAttachment);
  await assert.rejects(
    run(process.execPath, [path.join(root, "scripts/validate-restored-data.mjs"), dataDir]),
    /Restored attachment is missing/
  );
  await fs.writeFile(restoredAttachment, "tampered");
  await assert.rejects(
    run(process.execPath, [path.join(root, "scripts/validate-restored-data.mjs"), dataDir]),
    /Restored attachment content does not match/
  );
  await fs.writeFile(restoredAttachment, "image");
  const brokenDir = path.join(dataDir, "users", "second");
  const brokenStore = JSON.parse(await fs.readFile(path.join(brokenDir, "store.json"), "utf8"));
  delete brokenStore.feedback;
  await fs.writeFile(path.join(brokenDir, "store.json"), JSON.stringify(brokenStore));
  await assert.rejects(
    run(process.execPath, [path.join(root, "scripts/validate-restored-data.mjs"), dataDir]),
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
  assert.doesNotMatch(restoreScript, /ATTACHMENT_STORAGE="\$\{ATTACHMENT_STORAGE/);
  console.log("Restore validation checks passed: complete attachment manifest, missing/tampered rejection, remote materialization, local-only drill and temporary authenticated session.");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
