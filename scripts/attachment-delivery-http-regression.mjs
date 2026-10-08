import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";
import { createServerRuntime } from "../src/app/index.mjs";
import { speechTextForCapture } from "../src/shared/speech/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-delivery-http-"));
const previousEnv = { ...process.env };
const originals = {
  credential: Credential.default.prototype.getCredential,
  meta: OSS.prototype.getObjectMeta,
  put: OSS.prototype.put,
  delete: OSS.prototype.delete
};
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const objects = new Map();
let failed = false;
let holdMetadata = null;
let metadataEntered = null;
let runtime;
try {
  Object.assign(process.env, {
    NODE_ENV: "test", DATA_DIR: root, PORT: "0", APP_BASE_PATH: "/now",
    AUTH_REQUIRED: "1", INVITE_CODE_HASH: hash("synthetic-invite"), COOKIE_SECURE: "0",
    ATTACHMENT_STORAGE: "local", MEDIA_DELIVERY_MODE: "cdn-signed",
    ALIBABA_CLOUD_ECS_RAM_ROLE: "synthetic-role",
    MEDIA_DELIVERY_BUCKET: "synthetic-delivery", MEDIA_DELIVERY_OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com",
    MEDIA_CDN_ORIGIN: "https://media.synthetic.test", MEDIA_CDN_AUTH_KEY: "syntheticKey123456",
    DEBUG_SERVER_URL: "", LOCAL_TEST_MODE: "0", UPSTREAM_ORIGIN: "", PERSISTENCE_BACKEND: "json",
    SPEECH_CACHE_SWEEP_ENABLED: "0", PERIODIC_ANALYSIS_ENABLED: "0"
  });
  Credential.default.prototype.getCredential = async () => ({
    accessKeyId: "synthetic-id", accessKeySecret: "synthetic-secret", securityToken: "synthetic-token"
  });
  OSS.prototype.put = async function(key, data) { objects.set(key, Buffer.from(data)); return {}; };
  OSS.prototype.delete = async function(key) { objects.delete(key); return {}; };
  OSS.prototype.getObjectMeta = async function(key) {
    if (failed) throw new Error("synthetic signing outage");
    metadataEntered?.();
    if (holdMetadata) await holdMetadata;
    if (!objects.has(key)) throw Object.assign(new Error("synthetic missing"), { code: "NoSuchKey" });
    return { res: { headers: { "content-length": objects.get(key).length } } };
  };
  runtime = createServerRuntime({ rootUrl: pathToFileURL(path.resolve("server.mjs")).href });
  const { port } = await runtime.start();
  await runtime.ready();
  const base = `http://127.0.0.1:${port}/now`;
  const json = async (url, { cookie = "", method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method, redirect: "manual", headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  };
  const register = async username => {
    const result = await json("/api/auth/register", { method: "POST", body: {
      username, password: "Synthetic12345", invitation: "synthetic-invite"
    } });
    assert.equal(result.response.status, 201);
    return { ...result.body.user, cookie: result.response.headers.get("set-cookie").split(";")[0] };
  };
  const owner = await register("delivery-owner");
  const other = await register("delivery-other");
  const dataDir = path.join(root, "users", owner.id);
  const storeFile = path.join(dataDir, "store.json");
  const name = "synthetic-1.thumb.webp";
  const resource = `/attachments/${name}`;
  const payload = Buffer.from("12345678");
  await fs.writeFile(path.join(dataDir, "attachments", name), payload, { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, "attachments", "synthetic-original.m4a"), payload, { mode: 0o600 });
  const key = `delivery/${hash(owner.id)}/${name}`;
  objects.set(key, payload);
  const mutate = async callback => {
    const store = JSON.parse(await fs.readFile(storeFile, "utf8")); callback(store);
    await fs.writeFile(storeFile, JSON.stringify(store), { mode: 0o600 });
  };
  await mutate(store => {
    store.keepsakes = [{ id: "synthetic-keepsake", title: "合成媒体", tags: [],
      thumbPath: resource, displayPath: resource, originalPath: "/attachments/synthetic-original.m4a",
      createdAt: "2026-10-08T00:00:00.000Z", occurredAt: "2026-10-08T00:00:00.000Z", version: 1 }];
  });
  const media = (url = resource, cookie = owner.cookie, options = {}) => fetch(base + url, {
    redirect: "manual", headers: { cookie, ...options.headers }, method: options.method || "GET"
  });
  assert.equal((await media(resource, "")).status, 401);
  assert.equal((await media(resource, other.cookie)).status, 404);
  let response = await media();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(new URL(response.headers.get("location")).origin, "https://media.synthetic.test");
  assert.equal((await media(resource, owner.cookie, { method: "HEAD" })).status, 302);
  assert.equal((await media(resource, owner.cookie, { headers: { range: "bytes=2-4" } })).status, 302);
  response = await media(resource, owner.cookie, { headers: { range: "bytes=2-4", "if-range": '"old-version"' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "12345678");
  response = await media(resource, owner.cookie, { headers: { range: "bytes=99-" } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */8");
  response = await media("/attachments/synthetic-original.m4a");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "12345678");
  failed = true;
  response = await media(resource, owner.cookie, { headers: { range: "bytes=2-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-4/8");
  assert.equal(await response.text(), "345");
  failed = false;
  let release;
  holdMetadata = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { metadataEntered = resolve; });
  const inFlight = media();
  await entered;
  await mutate(store => {
    store.trash.push({ id: "synthetic-trash", type: "keepsake", payload: store.keepsakes[0] });
    store.keepsakes = [];
    store.aiTasks = [];
  });
  release(); holdMetadata = null; metadataEntered = null;
  response = await inFlight;
  assert.notEqual(response.status, 302, "deleted source must cancel a signing result held at cloud HEAD");
  await response.arrayBuffer();
  assert.notEqual((await media()).status, 302, "trash cannot authorize a new URL");
  const ttsPath = "/attachments/synthetic-tts.tts.mp3";
  await fs.writeFile(path.join(dataDir, "attachments", "synthetic-tts.tts.mp3"), payload, { mode: 0o600 });
  objects.set(`delivery/${hash(owner.id)}/synthetic-tts.tts.mp3`, payload);
  await mutate(store => {
    const capture = { id: "synthetic-capture", content: "合成朗读来源", version: 1 };
    store.captures = [capture];
    store.speechCache = [{ id: "synthetic-tts", sourceType: "capture", sourceId: capture.id,
      ownerHash: hash(owner.id), textHash: hash(speechTextForCapture(capture)), attachmentPath: ttsPath,
      createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", bytes: 8 }];
  });
  assert.equal((await media(ttsPath)).status, 302);
  await mutate(store => { store.captures[0].content = "已更新的朗读原文"; });
  assert.notEqual((await media(ttsPath)).status, 302, "changed TTS text cannot authorize the old recording");
  await mutate(store => { store.captures = []; });
  assert.notEqual((await media(ttsPath)).status, 302, "deleted TTS source cannot authorize a URL");
  console.log("Attachment delivery HTTP checks passed: production auth/account gates, body-free 302, HEAD/Range/416, original proxy, signing outage fallback, concurrent deletion, trash and stale TTS denial. External calls: 0.");
} finally {
  await runtime?.stop({ signal: "test" });
  Credential.default.prototype.getCredential = originals.credential;
  OSS.prototype.getObjectMeta = originals.meta;
  OSS.prototype.put = originals.put;
  OSS.prototype.delete = originals.delete;
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await fs.rm(root, { recursive: true, force: true });
}
