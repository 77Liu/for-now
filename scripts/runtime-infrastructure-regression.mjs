import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadAppConfig, loadAttachmentConfig } from "../src/config/index.mjs";
import { createObservability, pruneLogs } from "../src/shared/observability/index.mjs";
import { createJsonHttp, createRequestHandler } from "../src/http/index.mjs";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-infrastructure-"));
const config = env => loadAppConfig({ rootDir: root, env });
const defaults = config({});
assert.equal(defaults.dataDir, path.join(root, "data"));
assert.equal(defaults.basePath, "/");
assert.equal(defaults.port, 4173);
assert.equal(defaults.version, "development");
assert.equal(defaults.promptCatalogVersion, "");
assert.equal(defaults.persistenceBackend, "json");
assert.deepEqual(defaults.features, { incrementalSync: true });
assert.equal(config({ INCREMENTAL_SYNC_ENABLED: "0" }).features.incrementalSync, false);
assert.deepEqual(defaults.limits, {
  aiQps: 20, aiConcurrency: 20, segmentationQps: 5, segmentationConcurrency: 5,
  speechQps: 5, speechConcurrency: 5, ocrQps: 10, ocrConcurrency: 10,
  documentQps: 2, documentConcurrency: 2,
  aiDailyCalls: 200, usdCny: 7.2, aiDailyCostCny: 14.4, attachmentBytes: 1024 ** 3
});
assert.equal(config({ AI_USER_DAILY_COST_LIMIT_USD: "2", AI_COST_CNY_PER_USD: "8" }).limits.aiDailyCostCny, 16);
assert.equal(config({ AI_USER_DAILY_COST_LIMIT_USD: "2", AI_USER_DAILY_COST_LIMIT_CNY: "11" }).limits.aiDailyCostCny, 11);
assert.equal(config({ AI_USER_DAILY_COST_LIMIT_CNY: "0" }).limits.aiDailyCostCny, null);
assert.equal(config({ AI_USER_DAILY_COST_LIMIT_USD: "0" }).limits.aiDailyCostCny, null);
assert.equal(config({ AI_USER_DAILY_COST_LIMIT_USD: "" }).limits.aiDailyCostCny, 14.4);
assert.equal(config({ AI_GLOBAL_QPS: "bad" }).limits.aiQps, 20);
assert.equal(config({ AI_GLOBAL_QPS: "3000" }).limits.aiQps, 2500);
assert.equal(config({ OCR_GLOBAL_QPS: "99" }).limits.ocrQps, 10);
assert.equal(config({ DOCUMENT_PARSE_GLOBAL_CONCURRENCY: "99" }).limits.documentConcurrency, 2);
assert.equal(config({ AI_AUDIT_TEXT_LIMIT: "1" }).audit.textLimit, 10000);
assert.equal(config({ AI_AUDIT_RETENTION_DAYS: "4000" }).audit.retentionDays, 3650);
assert.equal(config({ ATTACHMENT_USER_QUOTA_BYTES: "1" }).limits.attachmentBytes, 1024 ** 2);
assert.equal(config({ NODE_ENV: "test", ATTACHMENT_USER_QUOTA_BYTES: "1" }).limits.attachmentBytes, 1);
assert.equal(config({ INVITE_CODE_HASH: "A".repeat(64) }).inviteCodeHash, "a".repeat(64));
assert.equal(config({ INVITE_CODE_HASH: "a".repeat(64) }).authRequired, true);
assert.equal(config({ APP_BASE_PATH: "//now///", UPSTREAM_ORIGIN: "http://localhost///" }).basePath, "/now");
assert.equal(config({ UPSTREAM_ORIGIN: "http://localhost///" }).upstreamOrigin, "http://localhost");
assert.equal(config({ PROMPT_CATALOG_VERSION: " 2026.09.29.1 " }).promptCatalogVersion, "2026.09.29.1");
assert.equal(config({ NODE_ENV: "test", TEST_CURRENT_DATE: "2026-10-02" }).testCurrentDate, "2026-10-02");
assert.equal(config({ NODE_ENV: "production", TEST_CURRENT_DATE: "2026-10-02" }).testCurrentDate, "");
assert.throws(() => config({ NODE_ENV: "test", TEST_CURRENT_DATE: "2026-02-30" }), /valid YYYY-MM-DD/);
assert.equal(defaults.localTestResetOnStart, false);
assert.equal(config({ LOCAL_TEST_MODE: "1", LOCAL_TEST_RESET_ON_START: "1" }).localTestResetOnStart, true);
assert.equal(config({ LOCAL_TEST_RESET_ON_START: "1" }).localTestResetOnStart, false);
assert.equal(defaults.periodicAnalysisEnabled, false);
assert.equal(config({ PERIODIC_ANALYSIS_ENABLED: "0" }).periodicAnalysisEnabled, false);
assert.equal(config({ PERIODIC_ANALYSIS_ENABLED: "1" }).periodicAnalysisEnabled, true);
assert.equal(config({ PERIODIC_ANALYSIS_ENABLED: "yes" }).periodicAnalysisEnabled, false);
assert.equal(defaults.speechCacheSweepEnabled, false);
assert.equal(config({ NODE_ENV: "test", SPEECH_CACHE_SWEEP_ENABLED: "1" }).speechCacheSweepEnabled, false);
assert.equal(config({ NODE_ENV: "production" }).speechCacheSweepEnabled, true);
assert.equal(config({
  NODE_ENV: "production",
  SPEECH_CACHE_SWEEP_ENABLED: "1"
}).speechCacheSweepEnabled, true);
assert.equal(config({
  NODE_ENV: "production",
  SPEECH_CACHE_SWEEP_ENABLED: "0"
}).speechCacheSweepEnabled, false);
assert.equal(config({
  NODE_ENV: "production",
  UPSTREAM_ORIGIN: "http://localhost"
}).speechCacheSweepEnabled, false);
for (const env of [
  { AUTH_REQUIRED: "1" }, { PERSISTENCE_BACKEND: "invalid" },
  { LOCAL_TEST_MODE: "1", NODE_ENV: "production" },
  { LOCAL_TEST_MODE: "1", INVITE_CODE_HASH: "a".repeat(64) },
  { LOCAL_TEST_MODE: "1", ATTACHMENT_STORAGE: "oss" },
  { PERSISTENCE_BACKEND: "postgres", LOCAL_TEST_MODE: "1" },
  { PERSISTENCE_BACKEND: "postgres", UPSTREAM_ORIGIN: "http://localhost" }
]) assert.throws(() => config(env));
const env = { NODE_ENV: "test", KEEPSAKE_SEGMENT_MOCK_RESULT: "  fixture  ", APP_VERSION: "fixture-version" };
const snapshot = config(env);
env.APP_VERSION = "changed";
assert.equal(snapshot.version, "fixture-version");
assert.equal(snapshot.segmentation.mockResult, "fixture");
assert.equal(defaults.speech.defaultVoice, "zh_male_shaonianzixin_uranus_bigtts");
assert.equal(defaults.speech.projectName, "default");
assert.equal(defaults.speech.apiKey, "");
assert.equal(defaults.vision.region, "cn-north-1");
assert.equal(defaults.vision.accessKeyId, "");
assert.equal(config({
  VOLCENGINE_SPEECH_API_KEY: " speech-key ",
  VOLCENGINE_ACCESS_KEY_ID: " ak ",
  VOLCENGINE_SECRET_ACCESS_KEY: " sk "
}).speech.apiKey, "speech-key");
assert.equal(config({ NODE_ENV: "production", KEEPSAKE_SEGMENT_MOCK_RESULT: "fixture" }).segmentation.mockResult, "");
assert.throws(() => { snapshot.limits.aiQps = 300; }, TypeError);
assert.equal(loadAttachmentConfig({ ALIBABA_CLOUD_IMDSV1_DISABLED: "FALSE" }).disableIMDSv1, false);
assert.throws(() => createAttachmentStorage(loadAttachmentConfig({ ATTACHMENT_STORAGE: "mock" })), /test-only/);

const { context: requestContext, logEvent, auditChanges } = createObservability({ rootDir: root, version: snapshot.version });
const { sendJson, bodyJson } = createJsonHttp({ getContext: requestContext.getStore, maxBodyBytes: 4096 });
const pending = new Set(), consoleMessages = [];
const originalConsoleError = console.error;
console.error = message => consoleMessages.push(message);
let firstEntered, releaseFirst;
const entered = new Promise(resolve => { firstEntered = resolve; });
const released = new Promise(resolve => { releaseFirst = resolve; });
const handler = createRequestHandler({
  requestContext, rootDir: root, basePath: "/now", logEvent, sendJson,
  isStorageError: error => error.code === "08006",
  async handle(req, res, url, current) {
    if (url.pathname === "/api/missing") throw Object.assign(new Error("not logged"), { code: "ENOENT" });
    if (url.pathname === "/api/database") throw Object.assign(new Error("PRIVATE_DATABASE_ERROR"), { code: "08006" });
    if (url.pathname === "/api/stream") {
      current.applicationStatus = 500;
      current.errorCode = "STREAM_FAILED";
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end('data: {"type":"error"}\n\n');
    }
    if (url.pathname === "/api/disconnect") return res.destroy();
    if (req.method !== "POST") return sendJson(res, 200, {});
    const user = req.headers["x-user"];
    assert.ok(["a", "b"].includes(user));
    current.user = { id: user };
    current.dataDir = path.join(root, user);
    const input = await bodyJson(req);
    if (user === "a") { firstEntered(); await released; }
    await auditChanges({ records: [] }, { records: [{ id: user, content: input.content }] });
    await logEvent("operation", "fixture.secret", { credentialText: input.password });
    const captured = { ...requestContext.getStore() };
    await new Promise((resolve, reject) => setImmediate(() => requestContext.run(captured, async () => {
      try { await logEvent("operation", "fixture.background"); resolve(); } catch (error) { reject(error); }
    })));
    return sendJson(res, 201, { user: requestContext.getStore().user.id });
  }
});
const server = http.createServer((req, res) => {
  const operation = handler(req, res);
  pending.add(operation);
  operation.finally(() => pending.delete(operation)).catch(() => {});
});
const entries = async (directory, prefix) => (await Promise.all((await fs.readdir(path.join(directory, "logs")))
  .filter(name => name.startsWith(prefix))
  .map(async name => (await fs.readFile(path.join(directory, "logs", name), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = user => fetch(`${base}/now/api/records?query=PRIVATE_QUERY`, {
    method: "POST", headers: { "x-user": user, "x-request-id": `trace-account-${user}` },
    body: JSON.stringify({ content: `PRIVATE_CONTENT_${user}`, password: `PRIVATE_PASSWORD_${user}` })
  });
  const first = create("a");
  await entered;
  const second = await create("b");
  assert.deepEqual(await second.json(), { user: "b" });
  releaseFirst();
  const response = await first;
  assert.deepEqual(await response.json(), { user: "a" });
  assert.equal(response.headers.get("x-request-id"), "trace-account-a");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const invalidTrace = await fetch(`${base}/now/api/read`, { headers: { "x-request-id": "invalid trace" } });
  assert.match(invalidTrace.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  const redirect = await fetch(`${base}/now?test=1`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/now/?test=1");
  assert.equal((await fetch(`${base}/now/api/missing`)).status, 404);
  const database = await fetch(`${base}/now/api/database`);
  assert.equal(database.status, 500);
  assert.deepEqual(await database.json(), { error: "数据服务暂时不可用，请稍后重试", code: "STORAGE_UNAVAILABLE" });
  assert.equal((await fetch(`${base}/now/api/stream`)).status, 200);
  await assert.rejects(fetch(`${base}/now/api/disconnect`));
  await Promise.all([...pending]);
  assert.equal(requestContext.getStore(), undefined);
  for (const user of ["a", "b"]) {
    const events = await entries(path.join(root, user), "operation-");
    assert.ok(events.every(event => event.userId === user && event.traceId === `trace-account-${user}` && event.version === snapshot.version));
    assert.equal(events.find(event => event.event === "fixture.secret").credentialText, "[REDACTED]");
    assert.ok(events.some(event => event.event === "fixture.background"));
    assert.equal(events.find(event => event.event === "request.completed").changeCount, 1);
    assert.deepEqual(events.find(event => event.event === "data.changed").changes.map(change => change.resourceId), [user]);
    assert.equal((await fs.stat(path.join(root, user, "logs"))).mode & 0o777, 0o700);
    for (const file of await fs.readdir(path.join(root, user, "logs"))) {
      assert.equal((await fs.stat(path.join(root, user, "logs", file))).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  }
  const systems = await entries(root, "system-");
  assert.ok(systems.some(event => event.route === "/api/stream" && event.event === "request.completed" && event.statusCode === 500 && event.httpStatus === 200));
  assert.ok(systems.some(event => event.route === "/api/disconnect" && event.result === "disconnected"));
  assert.doesNotMatch(JSON.stringify(systems) + consoleMessages.join(""), /PRIVATE_/);
  const boundary = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const keep = path.join(root, "logs", `system-${boundary}.ndjson`);
  await fs.writeFile(keep, "{}\n", { mode: 0o644 });
  const old = path.join(root, "logs", "operation-2000-01-01.ndjson");
  await fs.writeFile(old, "{}\n");
  await pruneLogs(path.join(root, "logs"), 30);
  await assert.rejects(fs.access(old), { code: "ENOENT" });
  assert.equal((await fs.stat(keep)).mode & 0o777, 0o600);
  console.log("Runtime infrastructure checks passed: config compatibility, immutable snapshots, test gates, concurrent account/background context, request/stream/disconnect audit, privacy, permissions and retention.");
} finally {
  releaseFirst();
  await Promise.allSettled([...pending]);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.error = originalConsoleError;
  await fs.rm(root, { recursive: true, force: true });
}
