import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAttachmentStorage } from "../attachment-storage.mjs";

const bucket = process.env.OSS_ATTACHMENT_BUCKET || "";
const endpoint = process.env.OSS_ENDPOINT || "";
if (!bucket || !endpoint) throw new Error("OSS_ATTACHMENT_BUCKET and OSS_ENDPOINT are required");

const storage = createAttachmentStorage({ mode: "oss" });
const ownerId = "__smoke__";
const name = `probe-${Date.now()}-${crypto.randomUUID()}.txt`;
const localFile = `/nonexistent/${name}`;
const data = crypto.randomBytes(48);
const key = storage.objectKey(ownerId, name);

let uploaded = false;
try {
  await storage.put({ ownerId, name, data, mimeType: "application/octet-stream", localFile });
  uploaded = true;
  assert.deepEqual(await storage.get({ ownerId, name, localFile }), data);

  const endpointUrl = new URL(endpoint);
  const publicUrl = new URL(`/${key.split("/").map(encodeURIComponent).join("/")}`, `${endpointUrl.protocol}//${bucket}.${endpointUrl.host}`);
  const anonymous = await fetch(publicUrl, { signal: AbortSignal.timeout(8000) });
  assert.notEqual(anonymous.status, 200, "OSS attachment object is anonymously readable");

  await storage.remove({ ownerId, name, localFile });
  uploaded = false;
  let removed = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await storage.get({ ownerId, name, localFile });
    } catch (error) {
      if (["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404) {
        removed = true;
        break;
      }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(removed, true, "Deleted OSS attachment remained readable");
  console.log(JSON.stringify({ ok: true, checks: ["ram-role-put", "authenticated-get", "anonymous-denied", "delete"] }));
} finally {
  if (uploaded) await storage.remove({ ownerId, name, localFile }).catch(() => {});
}
