import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function modelProvider() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const usage = { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 1 } };
    if (!input.stream) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ choices: [{ message: { content: "核心判断：v1 回答", reasoning_content: "v1 思考" } }], usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "v1 思考" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "核心判断：v1 回答" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}

async function readEvents(response) {
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
    .filter(Boolean).map(JSON.parse);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-api-v1-"));
const provider = modelProvider();
const providerPort = await freePort(), appPort = await freePort();
await new Promise((resolve, reject) => provider.once("error", reject).listen(providerPort, "127.0.0.1", resolve));
const invitation = "contract-invitation";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: String(appPort),
    APP_BASE_PATH: "/now",
    INVITE_CODE_HASH: crypto.createHash("sha256").update(invitation).digest("hex"),
    COOKIE_SECURE: "0",
    DEEPSEEK_API_URL: `http://127.0.0.1:${providerPort}/chat/completions`
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const base = `http://127.0.0.1:${appPort}/now`;
const request = async (pathname, { method = "GET", cookie = "", headers = {}, body } = {}) => {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
  const contentType = response.headers.get("content-type") || "";
  return {
    response,
    body: contentType.includes("application/json") ? await response.json() : null
  };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch {}
    if (ready || child.exitCode != null) break;
    await delay(50);
  }
  assert.equal(ready, true, stderr);

  const unauthorized = await request("/api/v1/thought-chains", { headers: { "x-request-id": "trace-contract-001" } });
  assert.equal(unauthorized.response.status, 401);
  assert.deepEqual(unauthorized.body, {
    data: null,
    error: { code: "AUTH_REQUIRED", message: "请先登录" },
    meta: { traceId: "trace-contract-001" }
  });
  assert.equal(unauthorized.response.headers.get("x-request-id"), "trace-contract-001");

  const register = async username => {
    const result = await request("/api/auth/register", {
      method: "POST",
      body: { username, password: "contract-password-1", invitation }
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  const owner = await register("contract-owner");
  const other = await register("contract-other");
  assert.equal((await request("/api/settings", { method: "POST", cookie: owner, body: { apiKey: "contract-key" } })).response.status, 200);

  const specification = await request("/api/v1/openapi.json", { cookie: owner });
  assert.equal(specification.response.status, 200);
  assert.equal(specification.body.openapi, "3.1.0");
  assert.ok(specification.body.paths["/thought-chains/{id}"]);
  assert.ok(specification.body.paths["/checkins/{id}"]);
  assert.ok(specification.body.paths["/daily-records/{id}"]);
  assert.equal(specification.body.components.schemas.ErrorEnvelope.required.includes("meta"), true);

  const checkinInput = {
    occurredAt: "2026-09-29T08:30:00",
    mood: 4,
    energy: 3,
    stress: 2,
    sleep: 5,
    factors: ["运动"]
  };
  const checkin = await request("/api/v1/checkins", {
    method: "POST",
    cookie: owner,
    headers: {
      "idempotency-key": "checkin-contract-1",
      "x-client-operation-id": "operation-checkin-1"
    },
    body: checkinInput
  });
  assert.equal(checkin.response.status, 201);
  assert.equal(checkin.response.headers.get("etag"), "\"1\"");
  assert.equal(checkin.response.headers.get("x-client-operation-id"), "operation-checkin-1");
  assert.deepEqual(checkin.body.meta.operation, { id: "operation-checkin-1", status: "committed" });
  const checkinId = checkin.body.data.id;
  const crossAccountRead = await request(`/api/v1/checkins/${checkinId}`, {
    cookie: other,
    headers: { "x-client-operation-id": "read-does-not-commit" }
  });
  assert.equal(crossAccountRead.response.status, 404);
  assert.equal(crossAccountRead.body.meta.operation, undefined);
  assert.equal(crossAccountRead.response.headers.get("x-client-operation-id"), null);
  const checkinUpdated = await request(`/api/v1/checkins/${checkinId}`, {
    method: "PATCH", cookie: owner, headers: { "if-match": "\"1\"" }, body: { ...checkinInput, mood: 5 }
  });
  assert.equal(checkinUpdated.response.status, 200);
  assert.equal(checkinUpdated.body.data.version, 2);
  assert.equal(checkinUpdated.response.headers.get("etag"), "\"2\"");
  assert.equal((await request(`/api/v1/checkins/${checkinId}`, {
    method: "DELETE", cookie: owner, headers: { "if-match": "\"1\"" }
  })).response.status, 412);

  const health = await request("/api/v1/daily-records", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "health-contract-1" },
    body: { type: "heartRate", occurredAt: "2026-09-29T09:00:00", average: 66 }
  });
  assert.equal(health.response.status, 201);
  assert.equal(health.response.headers.get("etag"), "\"1\"");
  const healthId = health.body.data.id;
  assert.equal((await request(`/api/v1/daily-records/${healthId}`, { cookie: other })).response.status, 404);
  const legacyAfterV1Records = await request("/api/state", { cookie: owner });
  assert.equal(legacyAfterV1Records.body.checkins.find(item => item.id === checkinId).mood, 5);
  assert.equal(legacyAfterV1Records.body.dailyRecords.find(item => item.id === healthId).average, 66);

  const missingKey = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: { "x-client-operation-id": "operation-without-key" },
    body: { question: "缺少幂等键", occurredAt: "2026-09-29T09:00:00" }
  });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(missingKey.body.meta.operation, undefined);
  assert.equal(missingKey.response.headers.get("x-client-operation-id"), null);
  const invalidOperation = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: {
      "idempotency-key": "invalid-operation-1",
      "x-client-operation-id": "invalid operation"
    },
    body: { question: "非法操作标识", occurredAt: "2026-09-29T09:00:00" }
  });
  assert.equal(invalidOperation.response.status, 400);
  assert.equal(invalidOperation.body.error.code, "INVALID_CLIENT_OPERATION_ID");
  assert.equal(invalidOperation.body.meta.operation, undefined);
  const invalidKey = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "x".repeat(101) },
    body: { question: "过长幂等键", occurredAt: "2026-09-29T09:00:00" }
  });
  assert.equal(invalidKey.response.status, 400);
  assert.equal(invalidKey.body.error.code, "INVALID_IDEMPOTENCY_KEY");

  const firstInput = { question: "v1 第一条思绪", idea: "初步想法", occurredAt: "2026-09-29T09:00:00", tags: ["契约"] };
  const first = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-1" }, body: firstInput
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.error, null);
  assert.equal(first.body.meta.traceId, first.response.headers.get("x-request-id"));
  assert.equal(first.response.headers.get("etag"), "\"1\"");
  const firstId = first.body.data.items.find(item => item.type === "question").id;

  const replay = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-1" }, body: firstInput
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.items.find(item => item.type === "question").id, firstId);
  const reused = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-1" },
    body: { ...firstInput, question: "不允许覆盖" }
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");

  const second = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-2" },
    body: { question: "v1 第二条思绪", occurredAt: "2026-09-29T10:00:00" }
  });
  const secondId = second.body.data.items.find(item => item.type === "question").id;
  const pageOne = await request("/api/v1/thought-chains?limit=1", { cookie: owner });
  assert.equal(pageOne.body.data.length, 1);
  assert.equal(pageOne.body.data[0].id, secondId);
  assert.ok(pageOne.body.meta.nextCursor);
  const pageTwo = await request(`/api/v1/thought-chains?limit=1&cursor=${encodeURIComponent(pageOne.body.meta.nextCursor)}`, { cookie: owner });
  assert.equal(pageTwo.body.data[0].id, firstId);
  assert.equal(pageTwo.body.meta.nextCursor, null);
  const badCursor = await request("/api/v1/thought-chains?cursor=broken", { cookie: owner });
  assert.equal(badCursor.response.status, 400);
  assert.equal(badCursor.body.error.code, "INVALID_CURSOR");
  assert.deepEqual((await request("/api/v1/thought-chains", { cookie: other })).body.data, []);

  const current = await request(`/api/v1/thought-chains/${firstId}`, { cookie: owner });
  assert.equal(current.body.data.blocks.length, 1);
  assert.equal(current.response.headers.get("etag"), "\"1\"");
  assert.equal((await request(`/api/v1/thought-chains/${firstId}`, {
    method: "PATCH", cookie: owner, body: { ...firstInput, question: "缺少前置条件" }
  })).response.status, 428);
  const stale = await request(`/api/v1/thought-chains/${firstId}`, {
    method: "PATCH", cookie: owner, headers: { "if-match": "\"9\"" }, body: { ...firstInput, question: "过期更新" }
  });
  assert.equal(stale.response.status, 412);
  assert.equal(stale.body.error.details.currentVersion, 1);
  const updated = await request(`/api/v1/thought-chains/${firstId}`, {
    method: "PATCH", cookie: owner, headers: { "if-match": "\"1\"" }, body: { ...firstInput, question: "v1 已更新" }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.content, "v1 已更新");
  assert.equal(updated.response.headers.get("etag"), "\"2\"");
  const legacyState = await request("/api/state", { cookie: owner });
  assert.equal(legacyState.body.thoughts.find(item => item.id === firstId).content, "v1 已更新");

  const answerResponse = await fetch(`${base}/api/v1/thought-chains/${firstId}/answers`, {
    method: "POST",
    headers: {
      cookie: owner,
      accept: "text/event-stream",
      "content-type": "application/json",
      "idempotency-key": "answer-contract-1"
    },
    body: "{}"
  });
  const events = await readEvents(answerResponse);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.data.content, "v1 回答");
  assert.equal(events.at(-1).result.data.reasoningContent, "v1 思考");
  assert.equal(events.at(-1).result.error, null);

  const crossTarget = await request(`/api/v1/thought-chains/${secondId}/answers`, {
    method: "POST", cookie: owner, headers: { "idempotency-key": "answer-contract-1" }, body: {}
  });
  assert.equal(crossTarget.response.status, 409);
  assert.equal(crossTarget.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const missingAnswer = await fetch(`${base}/api/v1/thought-chains/missing/answers`, {
    method: "POST",
    headers: {
      cookie: owner,
      accept: "text/event-stream",
      "content-type": "application/json",
      "idempotency-key": "answer-contract-missing"
    },
    body: "{}"
  });
  const missingEvents = await readEvents(missingAnswer);
  assert.equal(missingEvents.at(-1).type, "error");
  assert.equal(missingEvents.at(-1).data, null);
  assert.equal(missingEvents.at(-1).error.code, "THOUGHT_NOT_FOUND");
  assert.ok(missingEvents.at(-1).meta.traceId);

  const removed = await request(`/api/v1/thought-chains/${firstId}`, {
    method: "DELETE", cookie: owner, headers: { "if-match": "\"2\"" }
  });
  assert.equal(removed.response.status, 200);
  assert.ok(removed.body.data.trashId);
  assert.equal((await request(`/api/v1/thought-chains/${firstId}`, { cookie: owner })).response.status, 404);
  assert.equal((await request(`/api/trash/${removed.body.data.trashId}/restore`, {
    method: "POST", cookie: owner, body: {}
  })).response.status, 200);
  const restored = await request(`/api/v1/thought-chains/${firstId}`, { cookie: owner });
  assert.equal(restored.response.headers.get("etag"), "\"3\"");

  const undated = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-with-server-time" }, body: { question: "由服务端填写时间" }
  });
  assert.equal(undated.response.status, 201);
  const undatedReplay = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-with-server-time" }, body: { question: "由服务端填写时间" }
  });
  assert.equal(undatedReplay.response.status, 200);
  assert.equal(undatedReplay.body.data.items[0].id, undated.body.data.items[0].id);

  const invalidJson = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "invalid-json-1" }, body: "{"
  });
  assert.equal(invalidJson.response.status, 400);
  assert.equal(invalidJson.body.error.code, "INVALID_JSON");

  console.log("API v1 contracts passed: thoughts, check-ins and health records across base path, auth, envelopes, trace IDs, OpenAPI, cursor pagination, ETag/If-Match, idempotency, SSE, restore and account isolation.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}
