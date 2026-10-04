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
  assert.deepEqual(await collect(await localSource.createReadStream({ start: 3, end: 7 })), payload.subarray(3, 8));
  assert.deepEqual(await collect(await localSource.createReadStream()), payload);

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
  assert.deepEqual(await collect(await serviceSource.createReadStream({ start: 1, end: 2 })), payload.subarray(1, 3));

  const ossCalls = [];
  originalGetCredential = Credential.default.prototype.getCredential;
  originalGetObjectMeta = OSS.prototype.getObjectMeta;
  originalGetStream = OSS.prototype.getStream;
  originalGet = OSS.prototype.get;
  Credential.default.prototype.getCredential = async () => (
    { accessKeyId: "test-access-key", accessKeySecret: "test-access-secret", securityToken: "test-token" }
  );
  OSS.prototype.getObjectMeta = async function getObjectMeta(name) {
    ossCalls.push({ method: "getObjectMeta", name });
    return { status: 200, res: { headers: { "content-length": String(payload.length) } } };
  };
  OSS.prototype.getStream = async function getStream(name, options) {
    const range = options?.headers?.Range || "";
    ossCalls.push({ method: "getStream", name, range });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    const body = match
      ? payload.subarray(Number(match[1]), Number(match[2]) + 1)
      : payload;
    return {
      stream: Readable.from([body]),
      res: { status: range ? 206 : 200, headers: {} }
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
      range: "bytes=4-9"
    },
    {
      method: "getStream",
      name: "attachments/account-a/voice.m4a",
      range: ""
    }
  ]);

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
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);

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
    assert.equal(rangeHead.status, 206);
    assert.equal(rangeHead.headers.get("content-range"), `bytes 2-5/${payload.length}`);
    assert.equal(rangeHead.headers.get("content-length"), "4");
    assert.equal((await rangeHead.arrayBuffer()).byteLength, 0);
    assert.equal(streamOptions.length, rangeHeadCalls);

    for (const range of [`bytes=${payload.length}-`, "bytes=0-1,4-5", "items=0-1"]) {
      const invalid = await fetch(`${app.base}/attachments/voice.m4a`, {
        headers: { range }
      });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get("content-range"), `bytes */${payload.length}`);
      assert.equal(invalid.headers.get("content-length"), "0");
      assert.equal((await invalid.arrayBuffer()).byteLength, 0);
    }
    assert.equal(bufferedReads, 0);
    assert.deepEqual(streamOptions, [
      {},
      { start: 4, end: 7 },
      { start: 12, end: 15 },
      { start: 12, end: 15 }
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

  console.log("Attachment Range checks passed: local and OSS streams, exact HTTP ranges, full GET compatibility and disconnect cleanup.");
} finally {
  if (originalGetCredential) Credential.default.prototype.getCredential = originalGetCredential;
  if (originalGetObjectMeta) OSS.prototype.getObjectMeta = originalGetObjectMeta;
  if (originalGetStream) OSS.prototype.getStream = originalGetStream;
  if (originalGet) OSS.prototype.get = originalGet;
  await fs.rm(root, { recursive: true, force: true });
}
