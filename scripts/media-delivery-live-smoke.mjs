import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";
import { loadAttachmentConfig } from "../src/config/index.mjs";
import { createAttachmentDelivery, validateDeliveryConfig, MEDIA_DELIVERY_TTL_SECONDS } from "../src/shared/attachments/index.mjs";

const ttlSeconds = MEDIA_DELIVERY_TTL_SECONDS;
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const signatureSecond = (url, mode) => {
  const target = new URL(url);
  if (mode === "cdn-signed") {
    const second = Number(target.searchParams.get("auth_key")?.split("-")[0]);
    assert.ok(Number.isSafeInteger(second) && second > 0); return second;
  }
  const date = target.searchParams.get("x-oss-date");
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date || "");
  assert.ok(parts); assert.equal(Number(target.searchParams.get("x-oss-expires")), ttlSeconds);
  const second = Date.UTC(...parts.slice(1).map((value, index) => Number(value) - (index === 1 ? 1 : 0))) / 1000;
  assert.ok(Number.isSafeInteger(second)); return second;
};
const payload = () => Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const defaultRead = (url, options = {}) => fetch(url, {
  redirect: "manual", ...options, signal: AbortSignal.timeout(10_000)
});
const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hitHeader = response => /(?:^|[\s,])(?:TCP_)?HIT(?:[\s,]|$)/i.test(
  response.headers.get("x-cache") || response.headers.get("x-cache-status") || ""
);

// Dependencies are injected only at the tool boundary; local regression never contacts OSS/CDN.
export async function runMediaDeliverySmoke({ delivery, verifyAbsent, deliveryMode,
  mode = "local-live", origin = "https://77liu.top", read = defaultRead,
  wait = defaultWait, now = () => Date.now(), report = value => console.log(JSON.stringify(value)) }) {
  const ownerId = `__media_smoke_${crypto.randomUUID()}`;
  const name = `${crypto.randomUUID()}.thumb.webp`;
  const data = payload();
  const request = { ownerId, name, bytes: data.length, method: "GET" };
  const checks = [], observations = { cloudClockVerified: false, expiry: [] };
  const operations = { put: 0, sign: 0, delete: 0, verificationRead: 0, httpRequests: 0 };
  let phase = "configuration", failedPhase = null, uploadAttempted = false;
  let cleanup = { state: "not-attempted", sourceAbsenceVerified: false, cdnCacheCleared: false };
  const sign = async value => { operations.sign += 1; return delivery.sign(value); };
  const readBody = async (url, options) => {
    operations.httpRequests += 1;
    const response = await read(url, options);
    try { return { response, body: Buffer.from(await response.arrayBuffer()) }; }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  };
  const denied = async (url, options) => {
    const { response } = await readBody(url, options);
    assert.ok((deliveryMode === "cdn-signed" ? [403] : [401, 403]).includes(response.status));
  };
  const cors = response => {
    if (deliveryMode !== "cdn-signed") return;
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const exposed = String(response.headers.get("access-control-expose-headers") || "").toLowerCase().split(/\s*,\s*/);
    for (const header of ["content-range", "content-length", "accept-ranges"]) assert.ok(exposed.includes(header));
  };
  const full = async url => {
    const { response, body } = await readBody(url, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "256");
    assert.equal(body.length, data.length); assert.equal(digest(body), digest(data));
    cors(response); return response;
  };
  const range = async (url, value, start, end) => {
    const { response, body } = await readBody(url, { headers: { Range: value, Origin: origin } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/256`);
    assert.equal(response.headers.get("content-length"), String(end - start + 1));
    assert.equal(body.length, end - start + 1); assert.equal(digest(body), digest(data.subarray(start, end + 1)));
    cors(response);
  };
  try {
    assert.notEqual(deliveryMode, "proxy"); assert.equal(typeof verifyAbsent, "function");
    phase = "upload"; uploadAttempted = true; operations.put += 1;
    assert.equal(await delivery.put({ ...request, data, mimeType: "image/webp" }), true);
    phase = "sign";
    const signed = await sign(request);
    assert.ok(signed?.url); assert.equal(signed.ttlSeconds, ttlSeconds);
    const unsigned = new URL(signed.url); unsigned.search = "";
    phase = "anonymous-denial"; await denied(unsigned); checks.push(phase);
    phase = "cold-range"; await range(signed.url, "bytes=0-15", 0, 15); checks.push(phase);
    phase = "full-body-sha256"; let response = await full(signed.url); checks.push(phase);
    phase = "head";
    const head = await sign({ ...request, method: "HEAD" }); assert.ok(head?.url);
    assert.equal(head.ttlSeconds, ttlSeconds);
    const headResult = await readBody(head.url, { method: "HEAD", headers: { Origin: origin } });
    assert.equal(headResult.response.status, 200); assert.equal(headResult.response.headers.get("content-length"), "256");
    assert.equal(headResult.body.length, 0); cors(headResult.response); checks.push(phase);
    if (deliveryMode === "cdn-signed") {
      phase = "cache-hit";
      for (let attempt = 1; !hitHeader(response) && attempt < 5; attempt += 1) response = await full(signed.url);
      assert.equal(hitHeader(response), true); checks.push(phase);
      phase = "fresh-nonce-cache-hit";
      const fresh = await sign(request); assert.ok(fresh?.url);
      assert.notEqual(new URL(fresh.url).searchParams.get("auth_key"), new URL(signed.url).searchParams.get("auth_key"));
      assert.equal(new URL(fresh.url).pathname, new URL(signed.url).pathname);
      assert.equal(hitHeader(await full(fresh.url)), true); checks.push(phase);
      for (const variant of ["unsigned", "digest", "timestamp", "path"]) {
        phase = `hot-${variant}-denial`;
        const invalid = new URL(signed.url);
        const parts = invalid.searchParams.get("auth_key").split("-");
        assert.equal(parts.length, 4);
        if (variant === "unsigned") invalid.search = "";
        if (variant === "digest") { parts[3] = `${parts[3][0] === "0" ? "1" : "0"}${parts[3].slice(1)}`; invalid.searchParams.set("auth_key", parts.join("-")); }
        if (variant === "timestamp") { parts[0] = String(Number(parts[0]) + 1); invalid.searchParams.set("auth_key", parts.join("-")); }
        if (variant === "path") invalid.pathname = invalid.pathname.replace(/(\/delivery\/)([a-f0-9])/, (_, prefix, first) => `${prefix}${first === "0" ? "1" : "0"}`);
        await denied(invalid); checks.push(phase);
      }
      phase = "encoded-alias-observation";
      const alias = new URL(signed.url); alias.pathname = alias.pathname.replace("/delivery/", "/%64elivery/");
      const aliasResult = await readBody(alias);
      observations.encodedAlias = { status: aliasResult.response.status,
        bodyMatches: aliasResult.body.length === 256 && digest(aliasResult.body) === digest(data) };
      phase = "foreign-origin";
      const foreignOrigin = "https://unapproved.invalid";
      const foreign = await readBody(signed.url, { headers: { Origin: foreignOrigin } });
      assert.equal(foreign.response.status, 200); assert.equal(foreign.body.length, 256);
      assert.equal(foreign.response.headers.get("content-length"), "256"); assert.equal(digest(foreign.body), digest(data));
      assert.ok(![foreignOrigin, "*"].includes(foreign.response.headers.get("access-control-allow-origin"))); checks.push(phase);
    }
    for (const [label, value, start, end] of [["hot-range", "bytes=0-15", 0, 15],
      ["suffix-range", "bytes=-16", 240, 255], ["open-range", "bytes=240-", 240, 255]]) {
      phase = label; await range(signed.url, value, start, end); checks.push(phase);
    }
    phase = "unsatisfiable-range";
    const invalid = await readBody(signed.url, { headers: { Range: "bytes=256-" } });
    assert.equal(invalid.response.status, 416); assert.equal(invalid.response.headers.get("content-range"), "bytes */256"); checks.push(phase);
    phase = "expiry";
    const probes = [["expired-get-denial", signed.url, {}],
      ["expired-range-denial", signed.url, { headers: { Range: "bytes=0-15" } }],
      ["expired-head-denial", head.url, { method: "HEAD" }]]
      .map(([label, url, options]) => ({ label, url, options, second: signatureSecond(url, deliveryMode) }));
    // Type A's integer comparison expires after timestamp+TTL: +1 is the first
    // expired integer second, not an extra second of permitted configured TTL.
    const boundaries = [...new Set(probes.map(probe => probe.second + ttlSeconds + 1))].sort((a, b) => a - b);
    for (const boundary of boundaries) {
      phase = "expiry";
      while (now() < boundary * 1000) {
        const remaining = boundary * 1000 - now();
        report({ mode, status: "waiting", phase, secondsRemaining: Math.ceil(remaining / 1000) });
        await wait(Math.min(15_000, remaining));
      }
      const group = probes.filter(probe => probe.second + ttlSeconds + 1 === boundary);
      const results = await Promise.allSettled(group.map(async probe => {
        const startedAt = now();
        const { response } = await readBody(probe.url, probe.options);
        const receivedAt = now();
        const withinBoundary = Math.floor(startedAt / 1000) === boundary && Math.floor(receivedAt / 1000) === boundary;
        const responseDate = Date.parse(response.headers.get("date") || "");
        observations.expiry.push({ check: probe.label, signatureTimestamp: probe.second, targetTimestamp: boundary,
          requestStartedMs: startedAt, responseReceivedMs: receivedAt, responseDateMs: Number.isFinite(responseDate) ? responseDate : null,
          status: response.status,
          timing: withinBoundary ? "within-local-boundary-second" : "timing-uncertain" });
        assert.ok((deliveryMode === "cdn-signed" ? [403] : [401, 403]).includes(response.status));
        if (!withinBoundary) throw Object.assign(new Error("Boundary observation delayed"), { code: "SMOKE_TIMING_UNCERTAIN" });
      }));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          failedPhase ||= result.reason?.code === "SMOKE_TIMING_UNCERTAIN" ? "expiry-timing-uncertain" : group[index].label;
        } else checks.push(group[index].label);
      }
      if (failedPhase) break;
    }
  } catch { failedPhase = phase; }
  finally {
    if (uploadAttempted) {
      cleanup = { ...cleanup, state: "delete-failed" }; operations.delete += 1;
      try {
        await delivery.remove(request);
        cleanup.state = "verification-pending"; operations.verificationRead += 1;
        assert.equal(await verifyAbsent(request), true);
        cleanup.state = "source-absence-verified"; cleanup.sourceAbsenceVerified = true;
        checks.push("source-cleanup");
      } catch { failedPhase ||= "cleanup"; }
      if (!cleanup.sourceAbsenceVerified) cleanup.recovery = { syntheticOwnerId: ownerId, name, objectKey: delivery.objectKey(ownerId, name) };
    }
  }
  const result = { mode, status: failedPhase ? "failed" : "passed", phase: failedPhase || "complete",
    deliveryMode, ttlSeconds, syntheticBytes: data.length, payloadSha256: digest(data), checks, observations, operations, cleanup };
  report(result); return result;
}

function cloudClient(source, settings) {
  const credentials = new Credential.default(source.roleName
    ? { type: "ecs_ram_role", roleName: source.roleName, disableIMDSv1: source.disableIMDSv1 } : null);
  return async () => {
    const value = await credentials.getCredential();
    return new OSS({ accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret,
      stsToken: value.securityToken, bucket: settings.bucket, endpoint: settings.endpoint,
      region: settings.region.startsWith("oss-") ? settings.region : `oss-${settings.region}`,
      secure: true, retryMax: 1, timeout: 5000 });
  };
}

export async function verifySourceAbsence(getClient, key) {
  const client = await getClient();
  try { await client.getObjectMeta(key); return false; }
  catch (error) { if (error?.code === "NoSuchKey" || Number(error?.status) === 404) return true; throw error; }
}

export async function main(args = process.argv.slice(2)) {
  const production = args.includes("--production"), live = args.includes("--live") || production;
  const mode = production ? "production-live" : live ? "local-live" : "plan-only";
  const source = loadAttachmentConfig();
  let settings;
  try { settings = validateDeliveryConfig(source.delivery, source.bucket); }
  catch {
    console.log(JSON.stringify({ mode, status: "not-configured", phase: "configuration", externalCalls: 0 }));
    if (live) process.exitCode = 1; return;
  }
  if (!live) {
    console.log(JSON.stringify({ mode, status: settings.mode === "proxy" ? "not-configured" : "ready-for-live",
      deliveryMode: settings.mode, ttlSeconds, syntheticPayloadMaxBytes: 256,
      remoteWrites: "one synthetic distribution object; cleanup attempted and failures reported",
      checks: ["body-sha256", "GET/HEAD", "206/416", "CORS", "cache-HIT", "hot-invalid-signature/path-denial",
        "expired-GET/HEAD/Range-denial", "independent-source-absence"], externalCalls: 0 }));
    return;
  }
  if (settings.mode === "proxy") {
    console.log(JSON.stringify({ mode, status: "not-configured", phase: "configuration", externalCalls: 0 }));
    process.exitCode = 1; return;
  }
  const getClient = cloudClient(source, settings);
  const delivery = createAttachmentDelivery({ config: source.delivery, sourceBucket: source.bucket, getClient });
  const verifyAbsent = request => verifySourceAbsence(getClient, delivery.objectKey(request.ownerId, request.name));
  const result = await runMediaDeliverySmoke({ delivery, verifyAbsent, deliveryMode: settings.mode, mode,
    origin: process.env.MEDIA_LIVE_ALLOWED_ORIGIN || "https://77liu.top" });
  if (result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
