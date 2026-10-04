import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get as httpGet } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";
import { createAttachmentHttp } from "../src/http/index.mjs";
import { createAttachmentStorage, createImageAttachments } from "../src/shared/attachments/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-attachment-range-"));
const localDir = path.join(root, "attachments");
const localFile = path.join(localDir, "voice.m4a");
const payload = Buffer.from("0123456789abcdef");

const collect = async stream => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const listen = async attachments => {
  const http = createAttachmentHttp({
    attachments,
    bodyJson: async () => ({}),
    sendJson: (res, status, body) => {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length) });
      res.end(data);
    },
    uploadBodyMaxBytes: 1024,
    uploadImageMaxBytes: 1024,
    contentType: () => "audio/mp4"
  });
  const server = createServer((req, res) => {
    http.handle(req, res, new URL(req.url, "http://127.0.0.1")).then(handled => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    }).catch(error => {
      if (!res.headersSent) {
        res.writeHead(error.statusCode || 500);
        res.end(error.message);
      } else {
        res.destroy(error);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`
  };
};

let originalGetCredential;
let originalGetObjectMeta;
let originalGetStream;
let originalGet;

try {
  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(localFile, payload);

  const local = createAttachmentStorage({ mode: "local" });
  const localSource = await local.openRead({ ownerId: "local", name: "voice.m4a", localFile });
  assert.equal(localSource.bytes, payload.length);
  assert.match(localSource.etag, /^"[^"]+"$/);
  assert.ok(Number.isFinite(Date.parse(localSource.lastModified)));
  assert.deepEqual(await collect(await localSource.createReadStream({ start: 3, end: 7 })), payload.subarray(3, 8));
  assert.deepEqual(await collect(await localSource.createReadStream()), payload);
  await localSource.close();

  const linkedFile = path.join(localDir, "linked.m4a");
  await fs.symlink(localFile, linkedFile);
  await assert.rejects(
    local.openRead({ ownerId: "local", name: "linked.m4a", localFile: linkedFile }),
    /regular file/
  );

  const service = createImageAttachments({
    storage: local,
    getContext: () => ({ ownerId: "local", attachmentsDir: localDir })
  });
  const serviceSource = await service.openRead("/attachments/voice.m4a");
  assert.equal(serviceSource.bytes, payload.length);
  assert.match(serviceSource.etag, /^"[^"]+"$/);
  assert.deepEqual(await collect(await serviceSource.createReadStream({ start: 1, end: 2 })), payload.subarray(1, 3));
  await serviceSource.close();

  const ossCalls = [];
  let ossObject = {
    body: payload,
    etag: "\"oss-v1\"",
    versionId: "version-1",
    lastModified: "Mon, 05 Oct 2026 00:00:00 GMT"
  };
  let replaceBeforeNextStream = null;
  let missingBeforeNextStream = false;
  originalGetCredential = Credential.default.prototype.getCredential;
  originalGetObjectMeta = OSS.prototype.getObjectMeta;
  originalGetStream = OSS.prototype.getStream;
  originalGet = OSS.prototype.get;
  Credential.default.prototype.getCredential = async () => (
    { accessKeyId: "test-access-key", accessKeySecret: "test-access-secret", securityToken: "test-token" }
  );
  OSS.prototype.getObjectMeta = async function getObjectMeta(name) {
    ossCalls.push({ method: "getObjectMeta", name });
    return {
      status: 200,
      res: {
        headers: {
          "content-length": String(ossObject.body.length),
          etag: ossObject.etag,
          "last-modified": ossObject.lastModified,
          "x-oss-version-id": ossObject.versionId
        }
      }
    };
  };
  OSS.prototype.getStream = async function getStream(name, options) {
    const range = options?.headers?.Range || "";
    const ifMatch = options?.headers?.["If-Match"] || "";
    ossCalls.push({ method: "getStream", name, range, ifMatch });
    if (missingBeforeNextStream) {
      missingBeforeNextStream = false;
      throw Object.assign(new Error("No such key"), { status: 404, code: "NoSuchKey" });
    }
    if (replaceBeforeNextStream) {
      ossObject = replaceBeforeNextStream;
      replaceBeforeNextStream = null;
    }
    if (ifMatch !== ossObject.etag) {
      throw Object.assign(new Error("Pre condition failed"), {
        status: 412,
        code: "PreconditionFailed"
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    const body = match
      ? ossObject.body.subarray(Number(match[1]), Number(match[2]) + 1)
      : ossObject.body;
    return {
      stream: Readable.from([body]),
      res: {
        status: range ? 206 : 200,
        headers: {
          "content-length": String(body.length),
          etag: ossObject.etag,
          "x-oss-version-id": ossObject.versionId,
          ...(range ? {
            "content-range": `bytes ${match[1]}-${match[2]}/${ossObject.body.length}`
          } : {})
        }
      }
    };
  };
  OSS.prototype.get = async function get() {
    throw new Error("Range streaming must not call OSS get()");
  };

  const oss = createAttachmentStorage({
    mode: "oss", bucket: "private-test", endpoint: "https://oss.example.invalid",
    prefix: "attachments", roleName: "test-role"
  });
  const ossSource = await oss.openRead({ ownerId: "account-a", name: "voice.m4a", localFile });
  assert.equal(ossSource.bytes, payload.length);
  assert.equal(ossSource.etag, "\"oss-v1\"");
  assert.equal(ossSource.lastModified, ossObject.lastModified);
  assert.deepEqual(await collect(await ossSource.createReadStream({ start: 4, end: 9 })), payload.subarray(4, 10));
  assert.deepEqual(await collect(await ossSource.createReadStream()), payload);
  assert.deepEqual(ossCalls, [
    {
      method: "getObjectMeta",
      name: "attachments/account-a/voice.m4a"
    },
    {
      method: "getStream",
      name: "attachments/account-a/voice.m4a",
      range: "bytes=4-9",
      ifMatch: "\"oss-v1\""
    },
    {
      method: "getStream",
      name: "attachments/account-a/voice.m4a",
      range: "",
      ifMatch: "\"oss-v1\""
    }
  ]);

  const ossService = createImageAttachments({
    storage: oss,
    getContext: () => ({ ownerId: "account-a", attachmentsDir: localDir })
  });
  const ossApp = await listen(ossService);
  try {
    ossCalls.length = 0;
    const replacementPayload = Buffer.from("replacement-object-v2");
    replaceBeforeNextStream = {
      body: replacementPayload,
      etag: "\"oss-v2\"",
      versionId: "version-2",
      lastModified: "Mon, 05 Oct 2026 00:01:00 GMT"
    };
    const changed = await fetch(`${ossApp.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=4-9" }
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("content-range"), null);
    assert.equal(changed.headers.get("content-length"), String(replacementPayload.length));
    assert.equal(changed.headers.get("etag"), "\"oss-v2\"");
    assert.deepEqual(Buffer.from(await changed.arrayBuffer()), replacementPayload);
    assert.deepEqual(ossCalls, [
      {
        method: "getObjectMeta",
        name: "attachments/account-a/voice.m4a"
      },
      {
        method: "getStream",
        name: "attachments/account-a/voice.m4a",
        range: "bytes=4-9",
        ifMatch: "\"oss-v1\""
      },
      {
        method: "getObjectMeta",
        name: "attachments/account-a/voice.m4a"
      },
      {
        method: "getStream",
        name: "attachments/account-a/voice.m4a",
        range: "",
        ifMatch: "\"oss-v2\""
      }
    ]);
  } finally {
    ossApp.server.close();
    await once(ossApp.server, "close");
  }

  const fallbackApp = await listen(createImageAttachments({
    storage: oss,
    getContext: () => ({ ownerId: "account-a", attachmentsDir: localDir })
  }));
  try {
    ossCalls.length = 0;
    ossObject = {
      body: payload,
      etag: "\"oss-deleted\"",
      versionId: "version-deleted",
      lastModified: "Mon, 05 Oct 2026 00:02:00 GMT"
    };
    missingBeforeNextStream = true;
    const fallback = await fetch(`${fallbackApp.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=2-5" }
    });
    assert.equal(fallback.status, 206);
    assert.equal(fallback.headers.get("content-range"), `bytes 2-5/${payload.length}`);
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), payload.subarray(2, 6));
    assert.deepEqual(ossCalls.map(call => call.method), ["getObjectMeta", "getStream"]);
  } finally {
    fallbackApp.server.close();
    await once(fallbackApp.server, "close");
  }

  let bufferedReads = 0;
  const streamOptions = [];
  const routeAttachments = {
    ...service,
    read: async resourcePath => {
      bufferedReads += 1;
      return service.read(resourcePath);
    },
    openRead: async resourcePath => {
      const source = await service.openRead(resourcePath);
      return {
        ...source,
        createReadStream: options => {
          streamOptions.push(options);
          return source.createReadStream(options);
        }
      };
    }
  };
  const app = await listen(routeAttachments);
  try {
    const full = await fetch(`${app.base}/attachments/voice.m4a`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(payload.length));
    assert.match(full.headers.get("etag") || "", /^"[^"]+"$/);
    assert.ok(Number.isFinite(Date.parse(full.headers.get("last-modified") || "")));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);
    const localEtag = full.headers.get("etag");
    const localLastModified = full.headers.get("last-modified");

    const headCalls = streamOptions.length;
    const head = await fetch(`${app.base}/attachments/voice.m4a`, {
      method: "HEAD"
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(payload.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(streamOptions.length, headCalls);

    const partial = await fetch(`${app.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=4-7" }
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 4-7/${payload.length}`);
    assert.equal(partial.headers.get("content-length"), "4");
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), payload.subarray(4, 8));

    const suffix = await fetch(`${app.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=-4" }
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes 12-15/${payload.length}`);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(-4));

    const clamped = await fetch(`${app.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=12-999" }
    });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers.get("content-range"), `bytes 12-15/${payload.length}`);
    assert.equal(clamped.headers.get("content-length"), "4");
    assert.deepEqual(Buffer.from(await clamped.arrayBuffer()), payload.subarray(12));

    const rangeHeadCalls = streamOptions.length;
    const rangeHead = await fetch(`${app.base}/attachments/voice.m4a`, {
      method: "HEAD",
      headers: { range: "bytes=2-5" }
    });
    assert.equal(rangeHead.status, 200);
    assert.equal(rangeHead.headers.get("content-range"), null);
    assert.equal(rangeHead.headers.get("content-length"), String(payload.length));
    assert.equal((await rangeHead.arrayBuffer()).byteLength, 0);
    assert.equal(streamOptions.length, rangeHeadCalls);

    const matchingIfRange = await fetch(`${app.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=2-5", "if-range": localEtag }
    });
    assert.equal(matchingIfRange.status, 206);
    assert.equal(matchingIfRange.headers.get("content-range"), `bytes 2-5/${payload.length}`);
    assert.deepEqual(Buffer.from(await matchingIfRange.arrayBuffer()), payload.subarray(2, 6));

    const matchingIfRangeDate = await fetch(`${app.base}/attachments/voice.m4a`, {
      headers: { range: "bytes=6-7", "if-range": localLastModified }
    });
    assert.equal(matchingIfRangeDate.status, 206);
    assert.deepEqual(Buffer.from(await matchingIfRangeDate.arrayBuffer()), payload.subarray(6, 8));

    const staleDate = new Date(Date.parse(localLastModified) - 1000).toUTCString();
    for (const ifRange of ["\"stale-etag\"", `W/${localEtag}`, staleDate]) {
      const stale = await fetch(`${app.base}/attachments/voice.m4a`, {
        headers: { range: "bytes=2-5", "if-range": ifRange }
      });
      assert.equal(stale.status, 200);
      assert.equal(stale.headers.get("content-range"), null);
      assert.equal(stale.headers.get("content-length"), String(payload.length));
      assert.deepEqual(Buffer.from(await stale.arrayBuffer()), payload);
    }

    for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=invalid", "bytes=8-4"]) {
      const ignored = await fetch(`${app.base}/attachments/voice.m4a`, {
        headers: { range }
      });
      assert.equal(ignored.status, 200);
      assert.equal(ignored.headers.get("content-range"), null);
      assert.equal(ignored.headers.get("content-length"), String(payload.length));
      assert.deepEqual(Buffer.from(await ignored.arrayBuffer()), payload);
    }

    for (const range of [`bytes=${payload.length}-`, "bytes=-0", "bytes=99-100"]) {
      const unsatisfiable = await fetch(`${app.base}/attachments/voice.m4a`, {
        headers: { range }
      });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${payload.length}`);
      assert.equal(unsatisfiable.headers.get("content-length"), "0");
      assert.equal((await unsatisfiable.arrayBuffer()).byteLength, 0);
    }

    const changedLocalPayload = Buffer.from("local-object-v2");
    await fs.writeFile(localFile, changedLocalPayload);
    try {
      const changedLocal = await fetch(`${app.base}/attachments/voice.m4a`, {
        headers: { range: "bytes=2-5", "if-range": localEtag }
      });
      assert.equal(changedLocal.status, 200);
      assert.equal(changedLocal.headers.get("content-range"), null);
      assert.notEqual(changedLocal.headers.get("etag"), localEtag);
      assert.deepEqual(Buffer.from(await changedLocal.arrayBuffer()), changedLocalPayload);
    } finally {
      await fs.writeFile(localFile, payload);
    }

    assert.equal(bufferedReads, 0);
    assert.deepEqual(streamOptions, [
      {},
      { start: 4, end: 7 },
      { start: 12, end: 15 },
      { start: 12, end: 15 },
      { start: 2, end: 5 },
      { start: 6, end: 7 },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {}
    ]);
  } finally {
    app.server.close();
    await once(app.server, "close");
  }

  let upstream;
  let resolveDestroyed;
  const destroyed = new Promise(resolve => {
    resolveDestroyed = resolve;
  });
  const interruptedApp = await listen({
    read: async () => {
      throw new Error("Interrupted streaming must not buffer the attachment");
    },
    openRead: async () => ({
      bytes: 1024 * 1024,
      createReadStream: () => {
        upstream = new PassThrough();
        const timer = setInterval(() => {
          if (!upstream.destroyed) upstream.write(Buffer.alloc(1024, 1));
        }, 2);
        upstream.once("close", () => {
          clearInterval(timer);
          resolveDestroyed();
        });
        return upstream;
      }
    })
  });
  try {
    await new Promise((resolve, reject) => {
      const request = httpGet(`${interruptedApp.base}/attachments/voice.m4a`, response => {
        response.once("data", () => {
          response.destroy();
          request.destroy();
          resolve();
        });
        response.on("error", () => {});
      });
      request.on("error", error => {
        if (error.code !== "ECONNRESET") reject(error);
      });
    });
    await Promise.race([
      destroyed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Client disconnect did not destroy the attachment stream")),
        1000
      ))
    ]);
    assert.equal(upstream.destroyed, true);
  } finally {
    interruptedApp.server.close();
    await once(interruptedApp.server, "close");
  }

  console.log("Attachment Range checks passed: GET-only ranges, validators, If-Range, OSS replacement downgrade and disconnect cleanup.");
} finally {
  if (originalGetCredential) Credential.default.prototype.getCredential = originalGetCredential;
  if (originalGetObjectMeta) OSS.prototype.getObjectMeta = originalGetObjectMeta;
  if (originalGetStream) OSS.prototype.getStream = originalGetStream;
  if (originalGet) OSS.prototype.get = originalGet;
  await fs.rm(root, { recursive: true, force: true });
}
