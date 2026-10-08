import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAttachmentDelivery } from "../src/shared/attachments/index.mjs";
import { runMediaDeliverySmoke, verifySourceAbsence } from "./media-delivery-live-smoke.mjs";

const config = { mode: "cdn-signed", bucket: "synthetic-distribution", endpoint: "https://oss-cn-beijing.aliyuncs.com",
  cdnOrigin: "https://synthetic.invalid", cdnKey: "localMockSecret123" };
const origin = "https://77liu.top";
const md5 = value => crypto.createHash("md5").update(value).digest("hex");
const missing = () => Object.assign(new Error("synthetic missing"), { code: "NoSuchKey", status: 404 });

async function scenario(fault = "none", mode = "cdn-signed", { configuredTtl = 60, headDelayMs = 0, fractionalMs = 0 } = {}) {
  let clock = 1_800_000_000_000 + fractionalMs, nonce = 0, putCount = 0, deleteCount = 0, verificationCount = 0;
  let removed = false, fullReads = 0, warm = false, cancelCount = 0;
  const objects = new Map(), reports = [], sleeps = [], requests = [];
  const store = {
    async put(key, data, options) {
      putCount += 1; assert.equal(data.length, 256);
      assert.equal(options.headers["x-oss-object-acl"], "private");
      objects.set(key, Buffer.from(data));
      if (fault === "put-false") throw new Error("uncertain upload contains no loggable secrets");
    },
    async getObjectMeta(key) {
      if (removed) {
        verificationCount += 1;
        if (fault === "cleanup-403") throw Object.assign(new Error("secret URL must not be logged"), { status: 403 });
        if (fault === "cleanup-timeout") throw Object.assign(new Error("secret URL must not be logged"), { code: "ETIMEDOUT" });
        if (fault === "cleanup-unknown") throw new Error("secret URL must not be logged");
        if (fault === "cleanup-still-present") return { res: { headers: { "content-length": "256" } } };
        if (fault === "cleanup-404") throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (!objects.has(key)) throw missing();
      if (fault === "sign-null") throw Object.assign(new Error("cannot sign"), { status: 403 });
      return { res: { headers: { "content-length": String(objects.get(key).length) } } };
    },
    async delete(key) {
      deleteCount += 1;
      if (["cleanup-delete", "full-and-cleanup-delete"].includes(fault)) throw new Error("signed URL and credential values must stay private");
      if (fault !== "cleanup-client404") objects.delete(key); removed = true;
    },
    async signatureUrlV4(method, ttl, _, key) {
      const url = new URL(`/${key}`, config.cdnOrigin);
      url.searchParams.set("x-oss-signature-version", "OSS4-HMAC-SHA256");
      url.searchParams.set("x-oss-expires", String(ttl));
      url.searchParams.set("x-oss-date", new Date(clock).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""));
      return url.href;
    }
  };
  const actualDelivery = createAttachmentDelivery({ config: { ...config, mode }, sourceBucket: "synthetic-source",
    getClient: async () => store, now: () => clock, nonce: () => (++nonce).toString(16).padStart(16, "0") });
  const delivery = { ...actualDelivery, sign: async request => {
    if (request.method === "HEAD") clock += headDelayMs;
    return actualDelivery.sign(request);
  } };
  const read = async (value, options = {}) => {
    if (fault === "read-error") throw new Error("secret URL must not be logged");
    if (fault === "body-error") return { arrayBuffer: async () => { throw new Error("secret URL must not be logged"); },
      body: { cancel: async () => { cancelCount += 1; } } };
    const url = new URL(value), range = options.headers?.Range, method = options.method || "GET";
    const key = decodeURIComponent(url.pathname).slice(1);
    const data = objects.get(key) || (fault === "hot-path" ? objects.values().next().value : null);
    let invalid = "unsigned", expired = false;
    if (mode === "cdn-signed" && url.searchParams.has("auth_key")) {
      const [timestamp, random, uid, digest] = url.searchParams.get("auth_key").split("-");
      expired = Math.floor(clock / 1000) > Number(timestamp) + configuredTtl;
      const signaturePath = fault === "alias-canonical" ? decodeURIComponent(url.pathname) : url.pathname;
      const expected = md5(`${signaturePath}-${timestamp}-${random}-${uid}-${config.cdnKey}`);
      invalid = digest === expected ? null : !objects.has(key) ? "path"
        : Number(timestamp) * 1000 > clock ? "timestamp" : "digest";
    } else if (mode === "oss-signed" && url.search) {
      invalid = null; const date = url.searchParams.get("x-oss-date").replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
      expired = Math.floor(clock / 1000) > Date.parse(date) / 1000 + configuredTtl;
    }
    requests.push({ method, range, invalid, expired, warm });
    if (fault === "all-denied") return new Response("denied", { status: 403 });
    if (expired && fault === "slow-response") clock += 1_000;
    const bypass = warm && fault === `hot-${invalid}` || expired && fault === `expiry-${range ? "range" : method.toLowerCase()}`;
    if ((invalid || expired) && !bypass) return new Response("denied", { status: 403 });
    if (!data) return new Response("missing", { status: 404 });
    const headers = { "content-length": "256", "access-control-expose-headers": "content-range, content-length, accept-ranges" };
    if (options.headers?.Origin === origin || fault === "cors-foreign") headers["access-control-allow-origin"] = options.headers?.Origin;
    if (fault === "cors-static" && options.headers?.Origin) headers["access-control-allow-origin"] = origin;
    if (fault === "cors-allowed" && options.headers?.Origin === origin) delete headers["access-control-allow-origin"];
    if (method === "HEAD") {
      if (fault === "head-length") headers["content-length"] = "255";
      return new Response(fault === "head-body" ? Buffer.alloc(1) : null, { status: 200, headers });
    }
    if (range) {
      if (range === "bytes=256-") return new Response(null, { status: fault === "range-416" ? 200 : 416,
        headers: { "content-range": "bytes */256" } });
      const start = range === "bytes=0-15" ? 0 : 240, end = start + 15;
      headers["content-length"] = "16"; headers["content-range"] = `bytes ${start}-${end}/256`;
      const body = Buffer.from(data.subarray(start, end + 1));
      if (fault === "range-bytes" || fault === "hot-range-bytes" && warm) body.reverse();
      if (fault === "range-header") headers["content-range"] = "bytes 1-16/256";
      if (fault === "range-length") headers["content-length"] = "15";
      return new Response(body, { status: fault === "range-200" ? 200 : 206, headers });
    }
    fullReads += 1;
    headers["x-cache"] = mode === "cdn-signed" && fullReads > 1 ? "TCP_HIT" : "MISS";
    if (["MISS", "NOT_HIT", "HIT_BYPASS"].includes(fault)) headers["x-cache"] = fault;
    warm ||= headers["x-cache"] === "TCP_HIT";
    const body = Buffer.from(data);
    if (["full-bytes", "full-and-cleanup-delete"].includes(fault) || fault === "hot-full-bytes" && warm) body[1] ^= 1;
    return new Response(body, { status: 200, headers });
  };
  const result = await runMediaDeliverySmoke({ delivery, deliveryMode: mode, read,
    verifyAbsent: request => verifySourceAbsence(async () => {
      if (fault === "cleanup-client404") throw Object.assign(new Error("client unavailable"), { status: 404 });
      return store;
    }, delivery.objectKey(request.ownerId, request.name)),
    now: () => clock, wait: async duration => { sleeps.push(duration); clock += duration + (fault === "late-boundary" && duration < 15_000 ? 1_000 : 0); },
    report: value => reports.push(value) });
  assert.equal(putCount, 1); assert.equal(deleteCount, 1);
  assert.ok(objects.size === 0 || ["cleanup-delete", "full-and-cleanup-delete", "cleanup-client404"].includes(fault));
  assert.equal(cancelCount, fault === "body-error" ? 1 : 0);
  assert.equal(reports.at(-1), result); assert.equal(result.cleanup.cdnCacheCleared, false);
  const serialized = JSON.stringify(reports);
  for (const secret of [config.cdnKey, config.cdnOrigin, "auth_key", "x-oss-signature", "secret URL"]) assert.ok(!serialized.includes(secret));
  assert.ok(result.operations.httpRequests <= 24);
  return { result, reports, sleeps, requests, verificationCount };
}

let cases = 0;
for (const mode of ["cdn-signed", "oss-signed"]) {
  const { result, reports, sleeps, requests, verificationCount } = await scenario("none", mode);
  assert.equal(result.status, "passed"); assert.equal(result.cleanup.state, "source-absence-verified");
  assert.equal(result.cleanup.sourceAbsenceVerified, true); assert.equal(verificationCount, 1);
  assert.equal(result.operations.put, 1); assert.equal(result.operations.delete, 1);
  assert.ok(sleeps.every(value => value > 0 && value <= 15_000));
  assert.equal(sleeps.reduce((total, value) => total + value, 0), 61_000);
  assert.deepEqual(reports.filter(value => value.status === "waiting").map(value => value.secondsRemaining), [61, 46, 31, 16, 1]);
  assert.equal(result.observations.cloudClockVerified, false);
  assert.ok(result.observations.expiry.every(probe => probe.timing === "within-local-boundary-second"));
  for (const check of ["full-body-sha256", "cold-range", "head", "suffix-range", "open-range", "unsatisfiable-range",
    "expired-get-denial", "expired-head-denial", "expired-range-denial", "source-cleanup"]) assert.ok(result.checks.includes(check));
  if (mode === "cdn-signed") for (const variant of ["unsigned", "digest", "timestamp", "path"]) {
    assert.ok(result.checks.includes(`hot-${variant}-denial`));
    assert.ok(requests.some(request => request.warm && request.invalid === variant));
  }
  cases += 1;
}
const failures = { "full-bytes": "full-body-sha256", "hot-full-bytes": "cache-hit", "range-bytes": "cold-range",
  "hot-range-bytes": "hot-range", "range-header": "cold-range", "range-length": "cold-range", "range-200": "cold-range",
  "range-416": "unsatisfiable-range", "head-length": "head", "head-body": "head", "all-denied": "cold-range",
  MISS: "cache-hit", NOT_HIT: "cache-hit", HIT_BYPASS: "cache-hit", "cors-allowed": "cold-range", "cors-foreign": "foreign-origin",
  "hot-unsigned": "hot-unsigned-denial", "hot-digest": "hot-digest-denial", "hot-timestamp": "hot-timestamp-denial",
  "hot-path": "hot-path-denial", "expiry-get": "expired-get-denial", "expiry-head": "expired-head-denial",
  "expiry-range": "expired-range-denial", "put-false": "upload", "sign-null": "sign",
  "cleanup-delete": "cleanup", "cleanup-403": "cleanup", "cleanup-timeout": "cleanup", "cleanup-unknown": "cleanup",
  "cleanup-still-present": "cleanup", "cleanup-client404": "cleanup", "late-boundary": "expiry-timing-uncertain", "slow-response": "expiry-timing-uncertain", "read-error": "anonymous-denial", "body-error": "anonymous-denial" };
for (const [fault, phase] of Object.entries(failures)) {
  const { result, verificationCount } = await scenario(fault);
  assert.equal(result.status, "failed", fault); assert.equal(result.phase, phase, fault);
  if (fault.startsWith("cleanup-")) {
    assert.equal(result.cleanup.sourceAbsenceVerified, false);
    assert.equal(result.cleanup.state, fault === "cleanup-delete" ? "delete-failed" : "verification-pending");
    assert.ok(result.cleanup.recovery.syntheticOwnerId.startsWith("__media_smoke_"));
    assert.match(result.cleanup.recovery.objectKey, /^delivery\/[a-f0-9]{64}\/[\w-]+\.thumb\.webp$/);
    assert.equal(verificationCount, ["cleanup-delete", "cleanup-client404"].includes(fault) ? 0 : 1);
    assert.ok(!result.checks.includes("source-cleanup"));
  } else { assert.equal(result.cleanup.sourceAbsenceVerified, true); assert.equal(verificationCount, 1); }
  console.log(JSON.stringify({ fault, status: result.status, phase, cleanup: result.cleanup.state })); cases += 1;
}
for (const fault of ["cleanup-404", "cors-static", "alias-canonical"]) { assert.equal((await scenario(fault)).result.status, "passed"); cases += 1; }
const uncertain = (await scenario("late-boundary", "cdn-signed", { configuredTtl: 61 })).result;
assert.equal(uncertain.status, "failed"); assert.equal(uncertain.phase, "expiry-timing-uncertain"); cases += 1;
for (const configuredTtl of [61, 64]) for (const headDelayMs of [0, 2_000]) {
  const { result } = await scenario("none", "cdn-signed", { configuredTtl, headDelayMs });
  assert.equal(result.status, "failed"); assert.equal(result.phase, "expired-get-denial");
  assert.ok(!result.checks.includes("expired-get-denial"));
  console.log(JSON.stringify({ configuredTtl, headDelayMs, status: result.status, phase: result.phase })); cases += 1;
}
for (const mode of ["cdn-signed", "oss-signed"]) {
  const { result } = await scenario("none", mode, { headDelayMs: 2_000, fractionalMs: 750 });
  assert.equal(result.status, "passed");
  for (const probe of result.observations.expiry) {
    assert.equal(probe.targetTimestamp, probe.signatureTimestamp + 61);
    assert.equal(probe.requestStartedMs, probe.targetTimestamp * 1000);
  }
  const first = result.observations.expiry.find(probe => probe.check === "expired-get-denial");
  const later = result.observations.expiry.find(probe => probe.check === "expired-head-denial");
  assert.equal(later.signatureTimestamp - first.signatureTimestamp, 2); cases += 1;
}
const combined = (await scenario("full-and-cleanup-delete")).result;
assert.equal(combined.status, "failed"); assert.equal(combined.phase, "full-body-sha256");
assert.equal(combined.cleanup.state, "delete-failed"); assert.ok(combined.cleanup.recovery.objectKey);
assert.ok(!combined.checks.includes("source-cleanup")); cases += 1;
for (const error of [Object.assign(new Error(), { code: "ENOENT" }), Object.assign(new Error(), { status: 403 }),
  Object.assign(new Error(), { code: "ETIMEDOUT" }), new Error()]) {
  await assert.rejects(verifySourceAbsence(async () => ({ getObjectMeta: async () => { throw error; } }), "synthetic")); cases += 1;
}
for (const error of [Object.assign(new Error(), { status: 404 }), Object.assign(new Error(), { code: "NoSuchKey" })]) {
  await assert.rejects(verifySourceAbsence(async () => { throw error; }, "synthetic"), value => value === error); cases += 1;
}
for (const [mode, args, expectedStatus, exitCode] of [["cdn-signed", [], "ready-for-live", 0],
  ["proxy", ["--live"], "not-configured", 1], ["invalid", ["--production"], "not-configured", 1]]) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./media-delivery-live-smoke.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env: { OSS_ATTACHMENT_BUCKET: "synthetic-source", MEDIA_DELIVERY_MODE: mode,
      MEDIA_DELIVERY_BUCKET: mode === "proxy" ? "" : config.bucket, MEDIA_DELIVERY_OSS_ENDPOINT: config.endpoint,
      MEDIA_CDN_ORIGIN: config.cdnOrigin, MEDIA_CDN_AUTH_KEY: config.cdnKey } });
  assert.equal(child.status, exitCode); assert.equal(child.stderr, "");
  const output = JSON.parse(child.stdout);
  assert.equal(output.status, expectedStatus); assert.equal(output.externalCalls, 0);
  assert.ok(!child.stdout.includes(config.cdnKey)); assert.ok(!child.stdout.includes(config.cdnOrigin)); cases += 1;
}
console.log(JSON.stringify({ suite: "media-delivery-live-smoke-regression", status: "passed", cases, externalCalls: 0 }));
