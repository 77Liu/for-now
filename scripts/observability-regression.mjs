import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { installAuthenticatedJsonRuntime } from "../.build/typescript/backend/shared/testing/authenticated-runtime.mjs";
import { fileURLToPath } from "node:url";
import {
  collectRuntimeMemorySample,
  errorMetadata,
  pruneLogs,
  redact
} from "../src/shared/observability/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-audit-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const memorySample = collectRuntimeMemorySample({
  now: () => "2026-10-03T01:02:03.000Z",
  memoryUsage: () => ({ rss: 100, heapTotal: 80, heapUsed: 60, external: 20, arrayBuffers: 10 }),
  heapSpaceStatistics: () => [{
    space_name: "old_space",
    space_size: 50,
    space_used_size: 40,
    space_available_size: 8,
    physical_space_size: 48
  }],
  eventLoopDelay: {
    mean: 1_250_000,
    max: 5_500_000,
    percentile: percentile => ({ 50: 2_000_000, 95: 4_000_000, 99: 5_000_000 })[percentile]
  },
  activeHandles: () => [
    { constructor: { name: "Socket" }, path: "/PRIVATE/socket" },
    { constructor: { name: "FSWatcher" }, path: "/PRIVATE/watched-file" },
    { constructor: { name: "PrivateUserObject" }, body: "PRIVATE_USER_CONTENT" }
  ]
});
assert.deepEqual(memorySample, {
  sampledAt: "2026-10-03T01:02:03.000Z",
  rss: 100,
  heapTotal: 80,
  heapUsed: 60,
  external: 20,
  arrayBuffers: 10,
  heapSpaces: [{
    name: "old_space",
    size: 50,
    used: 40,
    available: 8,
    physical: 48
  }],
  eventLoopDelay: {
    meanMs: 1.25,
    p50Ms: 2,
    p95Ms: 4,
    p99Ms: 5,
    maxMs: 5.5
  },
  activeHandles: {
    total: 3,
    categories: { fileWatcher: 1, other: 1, socket: 1 }
  }
});
assert.doesNotMatch(JSON.stringify(memorySample), /PRIVATE|path|body|PrivateUserObject/);
let mode = "success", stderr = "", providerCalls = 0;
const mock = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  providerCalls += 1;
  if (mode === "usage_write_failure") {
    const ledger = path.join(authFixture.userDir, "ai-usage.json");
    await fs.rename(ledger, `${ledger}.saved`);
    await fs.mkdir(ledger);
  }
  res.setHeader("x-request-id", "provider-test-request");
  if (mode === "http_error") {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Bearer private-test-key\n    at PRIVATE_STACK_BODY", code: "RATE_LIMIT" } }));
  }
  if (mode === "null") return res.end("null");
  if (mode === "timeout") return;
  if (mode === "stream" || mode === "stream_length") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "PRIVATE_PARTIAL", reasoning_content: "PRIVATE_REASONING" } }] })}\n\n`);
    if (mode === "stream_length") res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
    return res.end(); // A clean EOF is still a truncated model response.
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "completion-test", model: "deepseek-flash", choices: [{
    message: { content: ["empty", "filter"].includes(mode) ? "" : "回答", reasoning_content: "PRIVATE_REASONING" },
    finish_reason: mode === "length" ? "length" : mode === "filter" ? "content_filter" : "stop"
  }], usage: mode === "partial_usage" ? { prompt_tokens: 1000 } : null }));
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const free = http.createServer();
await new Promise(resolve => free.listen(0, "127.0.0.1", resolve));
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
const systemFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const target = String(input instanceof Request ? input.url : input);
  if (!target.startsWith(base)) return systemFetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", authFixture.cookie);
  return systemFetch(input, { ...init, headers });
};
await fs.writeFile(path.join(dataDir, "llm-settings.json"), JSON.stringify({ version: 4, apiKey: "private-test-key" }));
await fs.writeFile(path.join(dataDir, "ai-usage.json"), JSON.stringify({
  version: 1, trackingStartedAt: new Date().toISOString(),
  entries: [
    { id: "legacy", createdAt: new Date().toISOString(), model: "deepseek-flash", scene: "healthRecognition", tokens: { input: 10, output: 2 }, costsUsd: { total: 0.125 } },
    { id: "speech", createdAt: new Date().toISOString(), provider: "volcengine", service: "speech", model: "volcengine-speech", scene: "speechSynthesis", modality: "audio", status: "success", unitType: "character", units: 12, costKnown: false },
    { id: "vision", createdAt: new Date().toISOString(), provider: "volcengine", service: "vision", model: "volcengine-vision", scene: "visionOcr", modality: "vision", status: "success", imageCount: 1, imageBytes: 256, unitType: "image", units: 1, costKnown: false },
    { id: "segmentation", createdAt: new Date().toISOString(), provider: "aliyun", service: "segmentation", model: "aliyun-segmentation", scene: "keepsakeSegmentation", modality: "vision", status: "failed", imageCount: 1, imageBytes: 256, unitType: "image", units: 1, costKnown: false }
  ]
}));
const authFixture = await installAuthenticatedJsonRuntime(dataDir);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, ...authFixture.env, NODE_ENV: "test", TZ: "UTC", DATA_DIR: dataDir, PORT: String(port), UPSTREAM_ORIGIN: "", APP_BASE_PATH: "", DEEPSEEK_API_URL: `http://127.0.0.1:${mock.address().port}`, RUNTIME_MEMORY_SAMPLE_INTERVAL_MS: "60000" },
  stdio: ["ignore", "ignore", "pipe"]
});
let childStopped = false;
child.stderr.on("data", data => { stderr += data; });
const request = (route, payload, method = "POST", headers = {}) => fetch(`${base}${route}`, {
  method, headers: { "content-type": "application/json", ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
});
const logEntries = async prefix => {
  const directories = [
    path.join(dataDir, "logs"),
    path.join(authFixture.userDir, "logs")
  ];
  return (await Promise.all(directories.map(async directory => {
    const names = (await fs.readdir(directory)).filter(name => name.startsWith(prefix));
    return (await Promise.all(names.map(async name => (
      await fs.readFile(path.join(directory, name), "utf8")
    ).trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
  }))).flat();
};
try {
  let ready = false;
  for (let index = 0; index < 80; index += 1) {
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch {}
    if (ready || child.exitCode != null) break;
    await delay(50);
  }
  assert.equal(ready, true, stderr);
  const initial = await (await fetch(`${base}/api/statistics`)).json();
  assert.equal(initial.ai.modalities.find(item => item.modality === "unknown").calls, 1);
  assert.equal(initial.ai.summary.unknownStatusCalls, 1);
  assert.equal(initial.ai.summary.durationKnownCalls, 0);
  assert.equal(initial.ai.summary.costsUsd.total, 0.125);
  assert.equal(initial.ai.summary.failedCalls, 1);
  assert.equal(initial.ai.summary.costUnknownCalls, 3);
  assert.equal(initial.ai.modalities.find(item => item.modality === "audio").calls, 1);
  assert.equal(initial.ai.modalities.find(item => item.modality === "vision").calls, 2);
  assert.equal(initial.ai.services.find(item => item.key === "volcengineTts").calls, 1);
  assert.equal(initial.ai.services.find(item => item.key === "volcengineOcr").calls, 1);
  assert.equal(initial.ai.services.find(item => item.key === "aliyunSegmentation").failedCalls, 1);
  assert.equal(initial.ai.daily.at(-1).services.aliyunSegmentation.costUnknownCalls, 1);

  const onboardingSchemaResponse = await request("/api/v1/onboarding-v2/schema", undefined, "GET");
  assert.equal(onboardingSchemaResponse.status, 200);
  const onboardingSchema = await onboardingSchemaResponse.json();
  const onboardingBaseline = await fetch(`${base}/api/v1/onboarding-v2/session`);
  const onboardingSession = await onboardingBaseline.json();
  const onboardingAnswers = Object.fromEntries(onboardingSchema.data.questions
    .filter(question => question.questionId !== "collaboration")
    .map(question => [question.questionId, {
      answerDisposition: "declined",
      contextAllowed: false
    }]));
  const onboardingCompleted = await request("/api/v1/onboarding-v2/session", {
    selectedFlow: "v2",
    status: "completed",
    answers: onboardingAnswers,
    collaboration: {
      answerDisposition: "declined",
      contextAllowed: false
    }
  }, "PATCH", {
    "if-match": onboardingBaseline.headers.get("etag"),
    "idempotency-key": "observability-onboarding-v2"
  });
  assert.equal(onboardingCompleted.status, 200);
  const completedBody = await onboardingCompleted.json();
  const extraction = await request("/api/v1/onboarding-v2/extractions", {
    sourceRevision: completedBody.data.session.revision
  }, "POST", { "idempotency-key": "observability-empty-model-ready" });
  assert.equal(extraction.status, 200);
  assert.equal((await extraction.json()).data.status, "ready");

  const good = await request("/api/settings/test", {});
  assert.equal(good.status, 200);
  let entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
  assert.equal(entries.at(-1).usageKnown, false);
  assert.equal(entries.at(-1).status, "success");
  assert.equal(entries.at(-1).costsUsd.total, 0);
  assert.ok((await fs.readdir(authFixture.userDir)).some(name => /ai-usage.json.v1-pre-v5.*\.bak$/.test(name)));
  mode = "partial_usage";
  assert.equal((await request("/api/settings/test", {})).status, 200);
  entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
  assert.equal(entries.at(-1).usageKnown, false);
  assert.equal(entries.at(-1).tokens.input, 0);
  assert.equal(entries.at(-1).costsUsd.total, 0);
  mode = "http_error";
  const failed = await request("/api/settings/test", {});
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private-test-key|PRIVATE_STACK_BODY/);
  entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
  assert.equal(entries.at(-1).httpStatus, 429);
  assert.equal(entries.at(-1).status, "failed");
  mode = "null";
  assert.equal((await request("/api/settings/test", {})).status, 500);
  mode = "stream";
  const partial = await request("/api/answer-drafts", { question: "流中断测试" }, "POST", { accept: "text/event-stream" });
  const stream = await partial.text();
  assert.match(stream, /"type":"error"/);
  assert.doesNotMatch(stream, /"type":"done"/);
  entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
  assert.equal(entries.at(-1).errorCode, "INCOMPLETE_STREAM");
  for (const [testMode, code] of [["empty", "EMPTY_DEEPSEEK_CONTENT"], ["length", "LENGTH_LIMIT"], ["filter", "CONTENT_FILTER"]]) {
    mode = testMode;
    assert.equal((await request("/api/settings/test", {})).status, 500);
    entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
    assert.equal(entries.at(-1).errorCode, code);
    assert.equal(entries.at(-1).status, "failed");
  }
  mode = "stream_length";
  const lengthStream = await (await request("/api/answer-drafts", { question: "截断测试" }, "POST", { accept: "text/event-stream" })).text();
  assert.match(lengthStream, /"type":"error"/);
  assert.doesNotMatch(lengthStream, /"type":"done"/);
  mode = "timeout";
  assert.equal((await request("/api/thought-prompts", {})).status, 504);
  entries = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries;
  assert.equal(entries.at(-1).status, "timeout");
  assert.equal(entries.at(-1).errorCode, "AI_REQUEST_TIMEOUT");

  mode = "usage_write_failure";
  const callsBeforeLedgerFailure = providerCalls;
  assert.equal((await request("/api/settings/test", {})).status, 200);
  assert.equal(providerCalls - callsBeforeLedgerFailure, 1);
  await fs.rmdir(path.join(authFixture.userDir, "ai-usage.json"));
  await fs.rename(
    path.join(authFixture.userDir, "ai-usage.json.saved"),
    path.join(authFixture.userDir, "ai-usage.json")
  );
  assert.ok((await logEntries("system-")).some(entry => entry.event === "ai.log_failed" && entry.target === "usage"));
  mode = "success";
  assert.equal((await request("/api/settings/test", {})).status, 200);
  const ledgerBeforeLogFailure = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries.length;
  const logDir = path.join(authFixture.userDir, "logs");
  await fs.rename(logDir, `${logDir}.ai-saved`);
  await fs.writeFile(logDir, "blocked log directory");
  const callsBeforeAuditFailure = providerCalls;
  assert.equal((await request("/api/settings/test", {})).status, 503);
  assert.equal(providerCalls - callsBeforeAuditFailure, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"))).entries.length, ledgerBeforeLogFailure);
  await delay(50);
  await fs.unlink(logDir);
  await fs.rename(`${logDir}.ai-saved`, logDir);

  // Unequal submissions per day must not give a day extra weight.
  for (const [occurredAt, mood] of [["2026-09-25T01:00:00Z", 1], ["2026-09-25T02:00:00Z", 5], ["2026-09-26T01:00:00Z", 5]]) {
    assert.equal((await request("/api/checkins", { occurredAt, mood, energy: mood, sleep: mood, stress: mood })).status, 201);
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.insights.trends.find(item => item.metric === "mood").current, 4);
  assert.equal(state.insights.trends[0].currentCount, 2);

  const createdResponse = await request("/api/captures", { content: "PRIVATE_USER_CONTENT" });
  const traceId = createdResponse.headers.get("x-request-id"), created = await createdResponse.json();
  await request(`/api/captures/${created.id}`, { content: "PRIVATE_EDITED_CONTENT" }, "PATCH");
  await request(`/api/captures/${created.id}`, undefined, "DELETE");
  await request("/api/captures/missing", undefined, "DELETE");
  const invalid = await fetch(`${base}/api/checkins`, { method: "POST", body: "{PRIVATE_BAD_JSON" });
  assert.equal(invalid.status, 400);
  await delay(100);
  const operations = await logEntries("operation-"), systems = await logEntries("system-"), audits = await logEntries("ai-audit-");
  assert.ok(operations.some(entry => entry.traceId === traceId && entry.changes?.[0]?.resourceId === created.id));
  assert.ok(systems.some(entry => entry.traceId === traceId && entry.event === "request.completed"));
  const runtimeSample = systems.find(entry => entry.event === "runtime.memory_sample")?.sample;
  assert.ok(runtimeSample?.rss > 0 && runtimeSample.heapTotal > 0);
  assert.ok(runtimeSample.heapSpaces.some(space => space.name === "old_space"));
  assert.ok(runtimeSample.eventLoopDelay.p95Ms >= 0);
  assert.ok(Number.isSafeInteger(runtimeSample.activeHandles.total));
  assert.deepEqual(Object.keys(runtimeSample.activeHandles.categories).sort(), Object.keys(runtimeSample.activeHandles.categories).sort().filter(key => [
    "childProcess", "fileWatcher", "messagePort", "other", "server", "signal", "socket", "stream", "timer", "tlsSocket"
  ].includes(key)));
  assert.ok(operations.some(entry => entry.statusCode === 404 && entry.result === "failed"));
  assert.deepEqual(operations.flatMap(entry => entry.changes || []).filter(change => change.resourceId === created.id).map(change => change.action), ["create", "update", "delete"]);
  assert.doesNotMatch(JSON.stringify([...systems, ...operations]) + stderr, /PRIVATE_|private-test-key/);
  assert.doesNotMatch(JSON.stringify(audits), /private-test-key/);
  assert.ok(audits.some(entry => entry.response?.content === "PRIVATE_PARTIAL" && entry.status === "failed"));
  for (const terminal of audits.filter(entry => entry.status !== "started")) {
    assert.ok(audits.some(entry => entry.callId === terminal.callId && entry.status === "started"));
  }
  for (const directory of [
    path.join(dataDir, "logs"),
    path.join(authFixture.userDir, "logs")
  ]) {
    for (const name of await fs.readdir(directory)) {
      assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
    }
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  assert.equal(redact({ apiKey: "secret", text: "Bearer secret" }).apiKey, "[REDACTED]");
  const injected = new Error("Provider failed\n    at PRIVATE_STACK_BODY");
  assert.doesNotMatch(JSON.stringify(errorMetadata(injected)), /PRIVATE_STACK_BODY|Provider failed/);
  const oldLog = path.join(dataDir, "logs", "ai-audit-2000-01-01.ndjson");
  await fs.writeFile(oldLog, "{}\n");
  await pruneLogs(path.join(dataDir, "logs"), 30);
  await assert.rejects(fs.access(oldLog));
  const ledger = path.join(authFixture.userDir, "ai-usage.json");
  const corrupt = "{CORRUPT_KEEP_ME";
  await fs.writeFile(ledger, corrupt);
  assert.equal((await fetch(`${base}/api/statistics`)).status, 500);
  assert.equal(await fs.readFile(ledger, "utf8"), corrupt);
  assert.doesNotMatch(stderr, /CORRUPT_KEEP_ME/);
  const storeFile = path.join(authFixture.userDir, "store.json");
  const savedStore = await fs.readFile(storeFile);
  await fs.rename(storeFile, `${storeFile}.saved`);
  await fs.mkdir(storeFile);
  assert.equal((await request("/api/captures", { content: "MUST_NOT_OVERWRITE" })).status, 500);
  assert.equal((await fs.stat(storeFile)).isDirectory(), true);
  await fs.rmdir(storeFile);
  await fs.writeFile(storeFile, savedStore);
  // A post-commit audit failure cannot turn a successful save into a retryable error.
  const logs = path.join(dataDir, "logs");
  await fs.rename(logs, `${logs}.saved`);
  await fs.writeFile(logs, "blocked log directory");
  const committed = await request("/api/captures", { content: "PRIVATE_COMMITTED_DURING_LOG_FAILURE" });
  assert.equal(committed.status, 201);
  const committedId = (await committed.json()).id;
  assert.ok(JSON.parse(await fs.readFile(storeFile)).captures.some(item => item.id === committedId));
  await delay(50);
  assert.match(stderr, /logging.failed/);
  assert.doesNotMatch(stderr, /PRIVATE_COMMITTED_DURING_LOG_FAILURE/);
  await fs.unlink(logs);
  await fs.rename(`${logs}.saved`, logs);
  const recovered = await request("/api/captures", { content: "PRIVATE_RECOVERED_LOG" });
  assert.equal(recovered.status, 201);
  const recoveredTrace = recovered.headers.get("x-request-id");
  await delay(50);
  assert.ok((await logEntries("operation-")).some(entry => entry.traceId === recoveredTrace && entry.event === "data.changed"));
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  childStopped = true;
  assert.ok((await logEntries("system-")).some(entry => entry.event === "server.stopped" && entry.signal === "SIGTERM"));
  console.log("Observability checks passed: low-sensitivity runtime memory, lifecycle logging, legacy migration, null/partial usage, empty/filtered/length/EOF failures, daily averages, linked logs, redaction, retention, permissions, corruption/I/O preservation and committed writes during logging failure/recovery.");
} finally {
  globalThis.fetch = systemFetch;
  if (!childStopped) {
    child.kill("SIGTERM");
    if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  }
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}
