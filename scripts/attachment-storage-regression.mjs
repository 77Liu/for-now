import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-storage-"));
const localDir = path.join(root, "local");
const localFile = path.join(localDir, "photo.png");
const payload = Buffer.from("private-image");

try {
  await fs.mkdir(localDir, { recursive: true });
  const local = createAttachmentStorage({ mode: "local" });
  await local.put({ ownerId: "ignored", name: "photo.png", data: payload, mimeType: "image/png", localFile });
  assert.deepEqual(await local.get({ ownerId: "ignored", name: "photo.png", localFile }), payload);
  assert.equal(await local.usageBytes({ ownerId: "ignored", localDir }), payload.length);
  assert.equal((await fs.stat(localFile)).mode & 0o777, 0o600);
  await local.remove({ ownerId: "ignored", name: "photo.png", localFile });
  await assert.rejects(fs.access(localFile));

  const mockDir = path.join(root, "oss");
  const mock = createAttachmentStorage({ mode: "mock", testMode: true, mockDir, prefix: "/attachments/" });
  const mockLocalFile = path.join(localDir, "not-created.png");
  await mock.put({ ownerId: "../account", name: "../photo.png", data: payload, mimeType: "image/png", localFile: mockLocalFile });
  assert.equal(mock.objectKey("../account", "../photo.png"), "attachments/.._account/.._photo.png");
  assert.deepEqual(await mock.get({ ownerId: "../account", name: "../photo.png", localFile: mockLocalFile }), payload);
  assert.equal(await mock.usageBytes({ ownerId: "../account", localDir }), payload.length);
  await assert.rejects(fs.access(mockLocalFile));
  await mock.remove({ ownerId: "../account", name: "../photo.png", localFile: mockLocalFile });
  assert.equal(await mock.usageBytes({ ownerId: "../account", localDir }), 0);

  // Migrated installations may still have the private local fallback.
  await local.put({ name: "photo.png", data: payload, localFile });
  assert.deepEqual(await mock.get({ ownerId: "migrated", name: "photo.png", localFile }), payload);
  await mock.put({ ownerId: "migrated", name: "photo.png", data: payload, localFile });
  await mock.remove({ ownerId: "migrated", name: "photo.png", localFile });
  await assert.rejects(mock.get({ ownerId: "migrated", name: "photo.png", localFile }), { code: "ENOENT" });
  await assert.rejects(fs.access(localFile), { code: "ENOENT" });
  await fs.mkdir(localFile);
  await mock.put({ ownerId: "migrated", name: "photo.png", data: payload, localFile });
  await assert.rejects(mock.remove({ ownerId: "migrated", name: "photo.png", localFile }));
  await fs.rmdir(localFile);
  await fs.writeFile(localFile, payload);
  await mock.remove({ ownerId: "migrated", name: "photo.png", localFile });
  await assert.rejects(fs.access(localFile), { code: "ENOENT" });
  await mock.remove({ ownerId: "migrated", name: "photo.png", localFile });

  assert.throws(() => createAttachmentStorage({ mode: "unknown" }), /local, oss, or mock/);
  assert.throws(() => createAttachmentStorage({ mode: "mock", mockDir }), /test-only/);
  assert.throws(() => createAttachmentStorage({ mode: "oss" }), /requires OSS_ATTACHMENT_BUCKET and OSS_ENDPOINT/);
  console.log("Attachment storage checks passed: private files, object isolation, usage, fallback reads, complete deletion with retry and configuration validation.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
