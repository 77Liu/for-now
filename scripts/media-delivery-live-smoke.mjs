import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadAttachmentConfig } from "../src/config/index.mjs";
import { createAttachmentDelivery, validateDeliveryConfig } from "../src/shared/attachments/index.mjs";

const source = loadAttachmentConfig();
const production = process.argv.includes("--production");
const live = process.argv.includes("--live") || production;
let phase = "configuration";
let settings;
try { settings = validateDeliveryConfig(source.delivery, source.bucket); }
catch {
  console.log(JSON.stringify({ mode: production ? "production-live" : live ? "local-live" : "plan-only",
    status: "not-configured", phase, externalCalls: 0 }));
  if (live) process.exitCode = 1;
}
if (settings && !live) {
  console.log(JSON.stringify({ mode: "plan-only", status: settings.mode === "proxy" ? "not-configured" : "ready-for-live",
    deliveryMode: settings.mode, ttlSeconds: 60, syntheticPayloadMaxBytes: 256,
    remoteWrites: "one synthetic distribution object, always cleaned",
    checks: ["private-origin", "unsigned-cache-denial", "GET/HEAD", "206/416", "CORS", "cache-HIT", "expired-cache-denial", "cleanup"],
    externalCalls: 0 }));
}
if (settings && live) {
  const ownerId = `__media_smoke_${crypto.randomUUID()}`;
  const name = `${crypto.randomUUID()}.thumb.webp`;
  const data = Buffer.alloc(256, 42);
  const delivery = createAttachmentDelivery({ config: source.delivery, sourceBucket: source.bucket,
    roleName: source.roleName, disableIMDSv1: source.disableIMDSv1 });
  const request = { ownerId, name, bytes: data.length, method: "GET" };
  let cleanupNeeded = false;
  const checks = [];
  const origin = process.env.MEDIA_LIVE_ALLOWED_ORIGIN || "https://77liu.top";
  const read = (url, options = {}) => fetch(url, {
    redirect: "manual", ...options, signal: AbortSignal.timeout(10_000)
  });
  try {
    assert.notEqual(settings.mode, "proxy");
    phase = "upload"; cleanupNeeded = true;
    assert.equal(await delivery.put({ ...request, data, mimeType: "image/webp" }), true);
    phase = "sign";
    const signed = await delivery.sign(request);
    assert.ok(signed);
    const unsigned = new URL(signed.url); unsigned.search = "";
    phase = "anonymous-denial";
    assert.ok([401, 403].includes((await read(unsigned)).status));
    checks.push(phase);
    phase = "range";
    const partial = await read(signed.url, { headers: { Range: "bytes=0-15", Origin: origin } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-15/256");
    assert.equal((await partial.arrayBuffer()).byteLength, 16);
    if (settings.mode === "cdn-signed") {
      assert.equal(partial.headers.get("access-control-allow-origin"), origin);
      const exposed = String(partial.headers.get("access-control-expose-headers") || "").toLowerCase();
      assert.ok(exposed.includes("content-range") && exposed.includes("accept-ranges"));
    }
    checks.push(phase);
    phase = "unsatisfiable-range";
    const invalid = await read(signed.url, { headers: { Range: "bytes=999-" } });
    assert.equal(invalid.status, 416);
    await invalid.arrayBuffer(); checks.push(phase);
    phase = "head";
    const head = await delivery.sign({ ...request, method: "HEAD" });
    assert.equal((await read(head.url, { method: "HEAD" })).status, 200); checks.push(phase);
    phase = "cache-hit";
    if (settings.mode === "cdn-signed") {
      let hit = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await read(signed.url);
        assert.equal(result.status, 200);
        hit ||= /HIT/i.test(result.headers.get("x-cache") || result.headers.get("x-cache-status") || "");
        await result.arrayBuffer();
        if (hit) break;
      }
      assert.equal(hit, true);
      assert.ok([401, 403].includes((await read(unsigned)).status));
      checks.push("cache-HIT-and-unsigned-denial");
    }
    phase = "expiry";
    await new Promise(resolve => setTimeout(resolve, 65_000));
    assert.ok([401, 403].includes((await read(signed.url)).status));
    checks.push("expired-cache-denial");
    phase = "cleanup";
    await delivery.remove(request); cleanupNeeded = false;
    assert.equal(await delivery.sign(request), null); checks.push(phase);
    console.log(JSON.stringify({ mode: production ? "production-live" : "local-live", status: "passed",
      deliveryMode: settings.mode, ttlSeconds: 60, syntheticBytes: data.length, checks, cleanup: "verified" }));
  } catch {
    process.exitCode = 1;
    console.log(JSON.stringify({ mode: production ? "production-live" : "local-live", status: "failed", phase, checks }));
  } finally {
    if (cleanupNeeded) {
      try { await delivery.remove(request); }
      catch {
        process.exitCode = 1;
        console.log(JSON.stringify({ status: "cleanup-pending", syntheticOwnerId: ownerId, name }));
      }
    }
  }
}
