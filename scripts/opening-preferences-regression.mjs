import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createServerRuntime } from "../src/app/index.mjs";
import { OPENING_DEFAULTS, openingPreferences } from "../public/frontend/shared/opening/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-opening-"));
const previousEnv = { ...process.env };
let runtime;
try {
  Object.assign(process.env, {
    NODE_ENV: "test", DATA_DIR: root, PORT: "0", APP_BASE_PATH: "/now", AUTH_REQUIRED: "1",
    INVITE_CODE_HASH: crypto.createHash("sha256").update("synthetic-invite").digest("hex"),
    COOKIE_SECURE: "0", ATTACHMENT_STORAGE: "local", MEDIA_DELIVERY_MODE: "proxy",
    MEDIA_DELIVERY_BUCKET: "", DEBUG_SERVER_URL: "", LOCAL_TEST_MODE: "0", UPSTREAM_ORIGIN: "",
    PERSISTENCE_BACKEND: "json", SPEECH_CACHE_SWEEP_ENABLED: "0", PERIODIC_ANALYSIS_ENABLED: "0"
  });
  runtime = createServerRuntime({ rootUrl: pathToFileURL(path.resolve("server.mjs")).href });
  const { port } = await runtime.start(); await runtime.ready();
  const base = `http://127.0.0.1:${port}/now`;
  const json = async (url, { cookie = "", method = "GET", body, etag } = {}) => {
    const response = await fetch(base + url, { method, headers: {
      cookie, "content-type": "application/json", ...(etag ? { "if-match": etag } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  };
  const register = async username => {
    const result = await json("/api/auth/register", { method: "POST", body: {
      username, password: "Synthetic12345", invitation: "synthetic-invite"
    } });
    assert.equal(result.response.status, 201);
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  assert.equal((await json("/api/opening-preferences")).response.status, 401);
  const owner = await register("opening-owner"), other = await register("opening-other");
  for (const method of ["GET", "PUT"]) {
    assert.equal((await json("/api/opening-preferences", { cookie: other, method,
      ...(method === "PUT" ? { body: openingPreferences() } : {}) })).response.status, 403);
  }
  const first = await json("/api/opening-preferences", { cookie: owner });
  assert.equal(first.response.status, 200); assert.deepEqual(first.body, openingPreferences());
  assert.match(first.response.headers.get("cache-control"), /(?:^|,\s*)no-store(?:,|$)/);
  assert.equal(first.response.headers.get("etag"), '"opening-0"');
  const input = { ...first.body, enabled: false, showBrand: false, config: { density: 500, speed: -5 } };
  const noEtag = await json("/api/opening-preferences", { cookie: owner, method: "PUT", body: input });
  assert.equal(noEtag.response.status, 409);
  const results = await Promise.all([1, 2].map(() => json("/api/opening-preferences", {
    cookie: owner, method: "PUT", body: input, etag: first.response.headers.get("etag")
  })));
  assert.deepEqual(results.map(v => v.response.status).sort(), [200, 409]);
  const saved = results.find(v => v.response.status === 200).body;
  assert.equal(saved.revision, 1); assert.equal(saved.config.density, 10); assert.equal(saved.config.speed, 15);
  assert.equal(saved.config.contrast, OPENING_DEFAULTS.config.contrast);
  // AI settings and ordinary preferences cannot overwrite the private opening document.
  await json("/api/settings", { cookie: owner, method: "POST", body: { assistantName: "新名字", opening: openingPreferences() } });
  await json("/api/preferences", { cookie: owner, method: "PATCH", body: { opening: openingPreferences(), automaticAnswers: { thoughtAnswer: true } } });
  assert.deepEqual((await json("/api/opening-preferences", { cookie: owner })).body, saved);
  assert.equal((await json("/api/preferences", { cookie: other })).body.opening, undefined);
  assert.equal((await json("/api/preferences", { cookie: owner })).body.opening, undefined);
  assert.equal((await json("/api/settings", { cookie: owner })).body.opening, undefined);
  // Successful CAS persists across a complete server restart.
  await runtime.stop({ signal: "test" }); runtime = createServerRuntime({ rootUrl: pathToFileURL(path.resolve("server.mjs")).href });
  const restarted = await runtime.start(); await runtime.ready();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/now/api/opening-preferences`, { headers: { cookie: owner } });
  assert.deepEqual(await response.json(), saved);
  console.log("Opening preferences passed: authenticated Owner-only routes, no-store, default fallback, atomic revision/ETag conflicts, bounded config, persistence and AI-write isolation.");
} finally {
  await runtime?.stop({ signal: "test" });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await fs.rm(root, { recursive: true, force: true });
}
