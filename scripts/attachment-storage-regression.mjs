import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAttachmentStorage } from "../attachment-storage.mjs";

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

  process.env.NODE_ENV = "test";
  const mockDir = path.join(root, "oss");
  const mock = createAttachmentStorage({ mode: "mock", mockDir, prefix: "/attachments/" });
  const mockLocalFile = path.join(localDir, "not-created.png");
  await mock.put({ ownerId: "../account", name: "../photo.png", data: payload, mimeType: "image/png", localFile: mockLocalFile });
  assert.equal(mock.objectKey("../account", "../photo.png"), "attachments/.._account/.._photo.png");
  assert.deepEqual(await mock.get({ ownerId: "../account", name: "../photo.png", localFile: mockLocalFile }), payload);
  assert.equal(await mock.usageBytes({ ownerId: "../account", localDir }), payload.length);
  await assert.rejects(fs.access(mockLocalFile));
  await mock.remove({ ownerId: "../account", name: "../photo.png", localFile: mockLocalFile });
  assert.equal(await mock.usageBytes({ ownerId: "../account", localDir }), 0);

  assert.throws(() => createAttachmentStorage({ mode: "unknown" }), /local, oss, or mock/);
  assert.throws(() => createAttachmentStorage({ mode: "oss" }), /requires OSS_ATTACHMENT_BUCKET and OSS_ENDPOINT/);
  console.log("Attachment storage checks passed: private local files, mock object isolation, usage accounting, read/delete and configuration validation.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
