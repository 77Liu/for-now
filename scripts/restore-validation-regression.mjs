import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-restore-validation-"));
const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics"];
try {
  const users = [{ id: "first", username: "first" }, { id: "second", username: "second" }];
  await fs.writeFile(path.join(dataDir, "auth.json"), JSON.stringify({ version: 1, users, sessions: [] }));
  for (const user of users) {
    const dir = path.join(dataDir, "users", user.id), attachments = path.join(dir, "attachments");
    await fs.mkdir(attachments, { recursive: true });
    const store = Object.fromEntries(collections.map(key => [key, []]));
    store.version = 12;
    if (user.id === "first") {
      store.captures.push({ id: "capture", content: "restored" });
      store.books.push({ id: "book", imagePath: "/attachments/cover.png" });
      await fs.writeFile(path.join(attachments, "cover.png"), "image");
    } else store.journals.push({ id: "journal", content: "second" });
    await fs.writeFile(path.join(dir, "store.json"), JSON.stringify(store));
  }
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
    records: 2,
    totalRecords: 3,
    attachmentReferences: 1,
    localAttachments: 1,
    firstAttachment: "/attachments/cover.png"
  });
  const auth = JSON.parse(await fs.readFile(path.join(dataDir, "auth.json"), "utf8"));
  assert.equal(auth.sessions.length, 1);
  assert.notEqual(auth.sessions[0].tokenHash, result.sessionToken);
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);
  console.log("Restore validation checks passed: account/store parsing, aggregate counts, attachment references and temporary authenticated session.");
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
