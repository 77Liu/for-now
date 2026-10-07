import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncOperationFingerprint } from "../public/frontend/sync/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let providerCalls = 0;

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function modelProvider() {
  return http.createServer(async (req, res) => {
    providerCalls += 1;
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
  const thoughtListOperation = specification.body.paths["/thought-chains"].get;
  assert.equal(thoughtListOperation.parameters.find(parameter => parameter.name === "limit").schema.maximum, 20);
  assert.equal(thoughtListOperation.parameters.find(parameter => parameter.name === "q").schema.maxLength, 200);
  assert.equal(
    thoughtListOperation.responses["200"].content["application/json"]
      .schema.allOf[1].properties.data.items.$ref,
    "#/components/schemas/ThoughtChainSummary"
  );
  assert.ok(specification.body.paths["/startup"]);
  assert.ok(specification.body.paths["/route-state"]);
  assert.ok(specification.body.paths["/checkins/{id}"]);
  assert.ok(specification.body.paths["/daily-records/{id}"]);
  assert.ok(specification.body.paths["/sync"]);
  assert.ok(specification.body.paths["/sync/operations/{operationId}"]);
  assert.ok(specification.body.paths["/personal-context"]);
  assert.ok(specification.body.paths["/onboarding-v2/schema"]);
  assert.ok(specification.body.paths["/onboarding-v2/session"]);
  assert.ok(specification.body.paths["/onboarding-v2/extractions"]);
  assert.ok(specification.body.paths["/user-model"]);
  assert.ok(specification.body.paths["/user-model/claims/{id}"]);
  assert.equal(specification.body.components.schemas.ErrorEnvelope.required.includes("meta"), true);
  assert.deepEqual(specification.body.components.schemas.StatisticsDashboard.required, ["records"]);
  assert.equal((await request("/api/v1/personal-context")).response.status, 401);
  assert.equal((await request("/api/v1/onboarding-v2/session")).response.status, 401);
  assert.equal((await request("/api/v1/user-model")).response.status, 401);
  const startup = await request("/api/v1/startup", { cookie: owner });
  assert.equal(startup.response.status, 200);
  assert.equal(startup.body.data.protocolVersion, 1);
  assert.equal(startup.body.data.user.username, "contract-owner");
  assert.equal(Number.isSafeInteger(startup.body.data.accountCursor), true);
  for (const field of ["thoughts", "clusters", "keepsakes"]) {
    assert.equal(Object.hasOwn(startup.body.data, field), false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(startup.body.data)) <= 25 * 1024);
  const todayRoute = await request("/api/v1/route-state?view=today", { cookie: owner });
  assert.equal(todayRoute.response.status, 200);
  assert.equal(Object.hasOwn(todayRoute.body.data, "clusters"), false);
  assert.equal(Object.hasOwn(todayRoute.body.data, "books"), false);
  assert.equal((await request("/api/v1/route-state?view=unknown", { cookie: owner })).response.status, 400);
  const syncBaseline = await request("/api/v1/sync", { cookie: owner });
  assert.equal(syncBaseline.response.status, 200);
  assert.equal(syncBaseline.body.data.changes.length, 0);
  assert.equal(Number.isSafeInteger(syncBaseline.body.data.cursor), true);
  const onboardingSchema = await request("/api/v1/onboarding-v2/schema", { cookie: owner });
  assert.equal(onboardingSchema.response.status, 200);
  assert.deepEqual(onboardingSchema.body.data.questions.map(item => item.questionId), [
    "currentContext",
    "desiredChanges",
    "recentObstacles",
    "dailyRhythm",
    "collaboration"
  ]);
  assert.ok(onboardingSchema.body.data.questions.every(item => item.canSkip));
  const onboardingBaseline = await request("/api/v1/onboarding-v2/session", { cookie: owner });
  assert.equal(onboardingBaseline.response.status, 200);
  const userModelBaseline = await request("/api/v1/user-model", { cookie: owner });
  assert.equal(userModelBaseline.response.status, 200);
  assert.deepEqual(userModelBaseline.body.data.claims, []);
  assert.deepEqual(userModelBaseline.body.data.unknowns, []);
  assert.deepEqual((await request("/api/v1/user-model", { cookie: other })).body.data.claims, []);
  const memberStatistics = await request("/api/v1/statistics", { cookie: other });
  assert.equal(memberStatistics.response.status, 200);
  assert.ok(memberStatistics.body.data.records);
  assert.equal(memberStatistics.body.data.ai, undefined);
  assert.equal(memberStatistics.body.data.service, undefined);
  const ownerStatistics = await request("/api/v1/statistics", { cookie: owner });
  assert.equal(ownerStatistics.response.status, 200);
  assert.ok(ownerStatistics.body.data.ai);
  assert.ok(ownerStatistics.body.data.service);
  assert.equal(onboardingBaseline.response.headers.get("etag"), "\"1\"");
  assert.equal(onboardingBaseline.body.data.session.revision, 0);
  const onboardingSaved = await request("/api/v1/onboarding-v2/session", {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-contract-1" },
    body: {
      status: "paused",
      step: "q2",
      answers: {
        currentContext: {
          rawText: "API_CONTRACT_ONBOARDING_CONTEXT",
          contextAllowed: true
        }
      }
    }
  });
  assert.equal(onboardingSaved.response.status, 200);
  assert.equal(onboardingSaved.response.headers.get("etag"), "\"2\"");
  assert.equal(onboardingSaved.body.data.session.answers.currentContext.version, 1);
  const onboardingReplay = await request("/api/v1/onboarding-v2/session", {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-contract-1" },
    body: {
      status: "paused",
      step: "q2",
      answers: {
        currentContext: {
          rawText: "API_CONTRACT_ONBOARDING_CONTEXT",
          contextAllowed: true
        }
      }
    }
  });
  assert.equal(onboardingReplay.response.status, 200);
  assert.equal(onboardingReplay.body.data.session.revision, 1);
  const onboardingStale = await request("/api/v1/onboarding-v2/session", {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-contract-stale" },
    body: { step: "q3" }
  });
  assert.equal(onboardingStale.response.status, 409);
  assert.equal(onboardingStale.body.error.code, "ONBOARDING_SESSION_CONFLICT");
  assert.equal(onboardingStale.body.error.details.currentRevision, 1);
  const onboardingOther = await request("/api/v1/onboarding-v2/session", { cookie: other });
  assert.equal(onboardingOther.response.status, 200);
  assert.equal(onboardingOther.body.data.session.revision, 0);
  assert.deepEqual(onboardingOther.body.data.session.answers, {});

  const privateBodyMarker = "PRIVATE_FINGERPRINT_BODY_MUST_NOT_LEAK";
  const invalidFingerprint = "INVALID_FULL_FINGERPRINT_MUST_NOT_LEAK";
  const invalidFormat = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: {
      "x-request-id": "trace-fingerprint-format",
      "idempotency-key": "fingerprint-format-key",
      "x-client-operation-id": "fingerprint-format-operation",
      "x-client-operation-fingerprint": invalidFingerprint,
      "x-client-contract-version": "0.4.0"
    },
    body: { question: privateBodyMarker }
  });
  assert.equal(invalidFormat.response.status, 400);
  assert.equal(invalidFormat.body.error.code, "INVALID_OPERATION_FINGERPRINT");
  assert.deepEqual(invalidFormat.body.error.details, {
    reason: "format",
    clientContractVersion: "0.4.0"
  });
  assert.equal(invalidFormat.body.meta.traceId, "trace-fingerprint-format");
  assert.doesNotMatch(JSON.stringify(invalidFormat.body), new RegExp(`${privateBodyMarker}|${invalidFingerprint}`));

  const missingOperationId = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: {
      "x-request-id": "trace-fingerprint-missing-id",
      "idempotency-key": "fingerprint-missing-id-key",
      "x-client-operation-fingerprint": "a".repeat(64),
      "x-client-contract-version": "0.4.0"
    },
    body: { question: privateBodyMarker }
  });
  assert.equal(missingOperationId.response.status, 400);
  assert.equal(missingOperationId.body.error.code, "INVALID_OPERATION_FINGERPRINT");
  assert.deepEqual(missingOperationId.body.error.details, {
    reason: "missing-id",
    clientContractVersion: "0.4.0"
  });
  assert.equal(missingOperationId.body.meta.traceId, "trace-fingerprint-missing-id");
  assert.doesNotMatch(JSON.stringify(missingOperationId.body), new RegExp(privateBodyMarker));

  const checkinInput = {
    occurredAt: "2026-09-29T08:30:00",
    mood: 4,
    energy: 3,
    stress: 2,
    sleep: 5,
    factors: ["运动"]
  };
  const checkinFingerprint = await syncOperationFingerprint({
    method: "POST",
    url: "/api/v1/checkins",
    headers: { "content-type": "application/json", "idempotency-key": "checkin-contract-1", "x-client-operation-id": "operation-checkin-1" },
    body: JSON.stringify(checkinInput)
  });
  const checkin = await request("/api/v1/checkins", {
    method: "POST",
    cookie: owner,
    headers: {
      "idempotency-key": "checkin-contract-1",
      "x-client-operation-id": "operation-checkin-1",
      "x-client-operation-fingerprint": checkinFingerprint
    },
    body: checkinInput
  });
  assert.equal(checkin.response.status, 201);
  assert.equal(checkin.response.headers.get("etag"), "\"1\"");
  assert.equal(checkin.response.headers.get("x-client-operation-id"), "operation-checkin-1");
  assert.deepEqual(checkin.body.meta.operation, { id: "operation-checkin-1", status: "committed" });
  const checkinId = checkin.body.data.id;

  const legacyFingerprintless = await request("/api/v1/checkins", {
    method: "POST",
    cookie: owner,
    headers: {
      "idempotency-key": "legacy-fingerprintless-key",
      "x-client-operation-id": "legacy-fingerprintless-operation",
      "x-client-contract-version": "0.4.0"
    },
    body: { ...checkinInput, occurredAt: "2026-09-29T08:45:00", mood: 3 }
  });
  assert.equal(legacyFingerprintless.response.status, 201);
  assert.deepEqual(legacyFingerprintless.body.meta.operation, {
    id: "legacy-fingerprintless-operation",
    status: "committed"
  });

  const learningPermission = await request("/api/v1/user-model/evidence-permissions", {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": "\"1\"" },
    body: {
      sourceRef: {
        resourceType: "checkin",
        resourceId: checkinId,
        rootId: "",
        targetKey: "",
        version: 1
      },
      contextAllowed: true,
      learningAllowed: true
    }
  });
  assert.equal(learningPermission.response.status, 200);
  assert.equal(learningPermission.body.data.permission.learningAllowed, true);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const permissions = await request(
      "/api/v1/user-model/evidence-permissions?limit=100",
      { cookie: owner }
    );
    const checkinPermission = permissions.body.data.find(item => (
      item.sourceRef.resourceType === "checkin"
      && item.sourceRef.resourceId === checkinId
    ));
    if (["failed", "succeeded", "ready"].includes(checkinPermission?.learningStatus)) break;
    await delay(25);
  }

  const analysisBody = "{}";
  const analysisHeaders = {
    "content-type": "application/json",
    "idempotency-key": "analysis-fingerprint-replay",
    "x-client-operation-id": "analysis-fingerprint-replay",
    "x-client-contract-version": "1.0.0"
  };
  const providerCallsBeforeAnalysis = providerCalls;
  const canonicalMismatch = await request("/api/v1/analyses", {
    method: "POST",
    cookie: owner,
    headers: {
      ...analysisHeaders,
      "x-request-id": "trace-fingerprint-canonical",
      "x-client-operation-fingerprint": "0".repeat(64)
    },
    body: analysisBody
  });
  assert.equal(canonicalMismatch.response.status, 400);
  assert.equal(canonicalMismatch.body.error.code, "INVALID_OPERATION_FINGERPRINT");
  assert.deepEqual(canonicalMismatch.body.error.details, {
    reason: "canonical-mismatch",
    clientContractVersion: "1.0.0"
  });
  assert.equal(canonicalMismatch.body.meta.traceId, "trace-fingerprint-canonical");
  assert.doesNotMatch(JSON.stringify(canonicalMismatch.body), /0{64}/);
  assert.equal(providerCalls, providerCallsBeforeAnalysis, "invalid fingerprint must be rejected before provider I/O");

  const canonicalAnalysisFingerprint = await syncOperationFingerprint({
    method: "POST",
    url: "/api/v1/analyses",
    headers: analysisHeaders,
    body: analysisBody
  });
  const analysisCreated = await request("/api/v1/analyses", {
    method: "POST",
    cookie: owner,
    headers: {
      ...analysisHeaders,
      "x-client-operation-fingerprint": canonicalAnalysisFingerprint
    },
    body: analysisBody
  });
  assert.equal(analysisCreated.response.status, 201);
  const analysisReplayed = await request("/api/v1/analyses", {
    method: "POST",
    cookie: owner,
    headers: {
      ...analysisHeaders,
      "x-client-operation-fingerprint": canonicalAnalysisFingerprint
    },
    body: analysisBody
  });
  assert.equal(analysisReplayed.response.status, 200);
  assert.equal(analysisReplayed.body.data.id, analysisCreated.body.data.id);
  assert.equal(providerCalls, providerCallsBeforeAnalysis + 1);
  const analyses = await request("/api/v1/analyses?limit=100", { cookie: owner });
  assert.equal(analyses.body.data.filter(item => item.id === analysisCreated.body.data.id).length, 1);

  const syncAfterCheckin = await request(`/api/v1/sync?cursor=${syncBaseline.body.data.cursor}`, { cookie: owner });
  assert.equal(syncAfterCheckin.response.status, 200);
  assert.ok(syncAfterCheckin.body.data.cursor > syncBaseline.body.data.cursor);
  assert.ok(syncAfterCheckin.body.data.changes.some(change => (
    change.domain === "checkins"
      && change.resourceId === checkinId
      && change.operationId === "operation-checkin-1"
      && change.changeType === "create"
  )));
  assert.equal(syncAfterCheckin.body.data.snapshot.checkins.some(item => item.id === checkinId), true);
  const operationState = await request(`/api/v1/sync/operations/operation-checkin-1?fingerprint=${checkinFingerprint}`, { cookie: owner });
  assert.equal(operationState.response.status, 200);
  assert.equal(operationState.body.data.status, "committed");
  assert.equal(operationState.body.data.responseAvailable, false);
  const invalidReceiptFingerprint = await request(
    "/api/v1/sync/operations/operation-checkin-1?fingerprint=invalid-full-fingerprint",
    {
      cookie: owner,
      headers: { "x-client-contract-version": "0.4.0" }
    }
  );
  assert.equal(invalidReceiptFingerprint.response.status, 400);
  assert.deepEqual(invalidReceiptFingerprint.body.error.details, {
    reason: "format",
    clientContractVersion: "0.4.0"
  });
  assert.doesNotMatch(JSON.stringify(invalidReceiptFingerprint.body), /invalid-full-fingerprint/);
  const reusedOperation = await request(`/api/v1/sync/operations/operation-checkin-1?fingerprint=${"0".repeat(64)}`, { cookie: owner });
  assert.equal(reusedOperation.response.status, 409);
  assert.equal(reusedOperation.body.error.code, "OPERATION_ID_REUSED");
  const reusedInput = { ...checkinInput, mood: 2 };
  const reusedFingerprint = await syncOperationFingerprint({
    method: "POST",
    url: "/api/v1/checkins",
    headers: { "content-type": "application/json", "idempotency-key": "checkin-contract-2", "x-client-operation-id": "operation-checkin-1" },
    body: JSON.stringify(reusedInput)
  });
  const reusedMutation = await request("/api/v1/checkins", {
    method: "POST",
    cookie: owner,
    headers: {
      "idempotency-key": "checkin-contract-2",
      "x-client-operation-id": "operation-checkin-1",
      "x-client-operation-fingerprint": reusedFingerprint
    },
    body: reusedInput
  });
  assert.equal(reusedMutation.response.status, 409);
  assert.equal(reusedMutation.body.error.code, "OPERATION_ID_REUSED");
  const isolatedSync = await request(`/api/v1/sync?cursor=${syncBaseline.body.data.cursor}`, { cookie: other });
  assert.equal(isolatedSync.response.status, 200);
  assert.equal(isolatedSync.body.data.changes.length, 0);
  const crossAccountRead = await request(`/api/v1/checkins/${checkinId}`, {
    cookie: other,
    headers: { "x-client-operation-id": "read-does-not-commit" }
  });
  assert.equal(crossAccountRead.response.status, 404);
  assert.equal(crossAccountRead.body.meta.operation, undefined);
  assert.equal(crossAccountRead.response.headers.get("x-client-operation-id"), null);
  const checkinUpdateInput = { ...checkinInput, mood: 5 };
  const checkinUpdateFingerprint = await syncOperationFingerprint({
    method: "PATCH",
    url: `/api/v1/checkins/${checkinId}`,
    headers: { "content-type": "application/json", "if-match": "\"1\"" },
    body: JSON.stringify(checkinUpdateInput)
  });
  const checkinUpdated = await request(`/api/v1/checkins/${checkinId}`, {
    method: "PATCH",
    cookie: owner,
    headers: {
      "if-match": "\"1\"",
      "x-client-operation-id": "operation-checkin-update-1",
      "x-client-operation-fingerprint": checkinUpdateFingerprint
    },
    body: checkinUpdateInput
  });
  assert.equal(checkinUpdated.response.status, 200);
  assert.equal(checkinUpdated.body.data.version, 2);
  assert.equal(checkinUpdated.response.headers.get("etag"), "\"2\"");
  assert.equal((await request(`/api/v1/sync/operations/operation-checkin-update-1?fingerprint=${checkinUpdateFingerprint}`, {
    cookie: owner
  })).body.data.status, "committed");
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
  const beforeCheckinDelete = await request("/api/v1/sync", { cookie: owner });
  const checkinDeleteFingerprint = await syncOperationFingerprint({
    method: "DELETE",
    url: `/api/v1/checkins/${checkinId}`,
    headers: { "content-type": "application/json", "if-match": "\"2\"" },
    body: ""
  });
  const checkinDeleted = await request(`/api/v1/checkins/${checkinId}`, {
    method: "DELETE",
    cookie: owner,
    headers: {
      "content-type": "application/json",
      "if-match": "\"2\"",
      "x-client-operation-id": "operation-checkin-delete-1",
      "x-client-operation-fingerprint": checkinDeleteFingerprint
    }
  });
  assert.equal(checkinDeleted.response.status, 200);
  assert.equal((await request(`/api/v1/sync/operations/operation-checkin-delete-1?fingerprint=${checkinDeleteFingerprint}`, {
    cookie: owner
  })).body.data.status, "committed");
  const afterCheckinDelete = await request(`/api/v1/sync?cursor=${beforeCheckinDelete.body.data.cursor}`, { cookie: owner });
  assert.ok(afterCheckinDelete.body.data.changes.some(change => (
    change.domain === "checkins"
      && change.resourceId === checkinId
      && change.operationId === "operation-checkin-delete-1"
      && change.changeType === "delete"
  )));

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

  const sourceCapture = await request("/api/v1/captures", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "capture-source-contract-1" },
    body: { content: "准备展开的念起", occurredAt: "2026-09-29T08:55:00", tags: ["契约"] }
  });
  assert.equal(sourceCapture.response.status, 201);
  const sourceCaptureId = sourceCapture.body.data.id;
  const firstInput = {
    question: "v1 第一条思绪",
    idea: "初步想法",
    occurredAt: "2026-09-29T09:00:00",
    tags: ["契约"],
    sourceRef: { type: "capture", id: sourceCaptureId, version: 1 }
  };
  const first = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-1" }, body: firstInput
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.error, null);
  assert.equal(first.body.meta.traceId, first.response.headers.get("x-request-id"));
  assert.equal(first.response.headers.get("etag"), "\"1\"");
  const firstRoot = first.body.data.items.find(item => item.type === "question"), firstId = firstRoot.id;
  assert.deepEqual(firstRoot.sourceRef, { type: "capture", id: sourceCaptureId, version: 1 });
  const ownerContext = await request("/api/v1/personal-context", { cookie: owner });
  assert.equal(ownerContext.response.status, 200);
  assert.equal(ownerContext.body.data.readOnly, true);
  assert.ok(ownerContext.body.data.tokenBudget.estimatedUsed <= ownerContext.body.data.tokenBudget.limit);
  assert.ok(ownerContext.body.data.sources.some(source => source.resourceId === firstId && source.excerpt === firstInput.question));
  assert.equal((await request("/api/v1/personal-context", { cookie: other })).body.data.sources.some(source => source.resourceId === firstId), false);

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
  const duplicateSource = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-source-duplicate" },
    body: { ...firstInput, question: "不允许重复展开" }
  });
  assert.equal(duplicateSource.response.status, 409);
  assert.equal(duplicateSource.body.error.code, "CAPTURE_ALREADY_PROMOTED");
  assert.equal(duplicateSource.body.error.details.rootId, firstId);
  const staleSource = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-source-stale" },
    body: { ...firstInput, sourceRef: { ...firstInput.sourceRef, version: 9 } }
  });
  assert.equal(staleSource.response.status, 412);
  assert.equal(staleSource.body.error.details.currentVersion, 1);
  const isolatedSource = await request("/api/v1/thought-chains", {
    method: "POST", cookie: other, headers: { "idempotency-key": "chain-source-isolated" },
    body: firstInput
  });
  assert.equal(isolatedSource.response.status, 404);
  assert.equal(isolatedSource.body.error.code, "CAPTURE_SOURCE_NOT_FOUND");

  const second = await request("/api/v1/thought-chains", {
    method: "POST", cookie: owner, headers: { "idempotency-key": "chain-contract-2" },
    body: { question: "v1 第二条思绪", occurredAt: "2026-09-29T10:00:00" }
  });
  const secondId = second.body.data.items.find(item => item.type === "question").id;
  const pageOne = await request("/api/v1/thought-chains?limit=1", { cookie: owner });
  assert.equal(pageOne.body.data.length, 1);
  assert.equal(pageOne.body.data[0].id, secondId);
  assert.equal(Object.hasOwn(pageOne.body.data[0], "blocks"), false);
  assert.equal(Object.hasOwn(pageOne.body.data[0], "modelDraft"), false);
  assert.equal(Object.hasOwn(pageOne.body.data[0], "reasoningContent"), false);
  assert.ok(pageOne.body.meta.nextCursor);
  const pageTwo = await request(`/api/v1/thought-chains?limit=1&cursor=${encodeURIComponent(pageOne.body.meta.nextCursor)}`, { cookie: owner });
  assert.equal(pageTwo.body.data[0].id, firstId);
  assert.deepEqual(pageTwo.body.data[0].preview, {
    kind: "idea",
    content: "初步想法",
    truncated: false
  });
  assert.equal(pageTwo.body.meta.nextCursor, null);
  const taggedPage = await request(`/api/v1/thought-chains?tag=${encodeURIComponent("契约")}`, { cookie: owner });
  assert.deepEqual(taggedPage.body.data.map(item => item.id), [firstId]);
  const oversizedPage = await request("/api/v1/thought-chains?limit=21", { cookie: owner });
  assert.equal(oversizedPage.response.status, 400);
  assert.equal(oversizedPage.body.error.code, "INVALID_PAGINATION");
  const badCursor = await request("/api/v1/thought-chains?cursor=broken", { cookie: owner });
  assert.equal(badCursor.response.status, 400);
  assert.equal(badCursor.body.error.code, "INVALID_CURSOR");
  const isolatedList = await request("/api/v1/thought-chains?q=v1", { cookie: other });
  assert.deepEqual(isolatedList.body.data, []);
  assert.equal((await request(`/api/v1/thought-chains/${firstId}`, { cookie: other })).response.status, 404);

  const searchPageOne = await request("/api/v1/thought-chains?limit=1&q=v1", { cookie: owner });
  assert.deepEqual(searchPageOne.body.data.map(item => item.id), [secondId]);
  assert.ok(searchPageOne.body.meta.nextCursor);
  const inserted = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "chain-contract-search-insert" },
    body: { question: "v1 翻页后插入", occurredAt: "2026-09-29T11:00:00" }
  });
  assert.equal(inserted.response.status, 201);
  const searchPageTwo = await request(
    `/api/v1/thought-chains?limit=1&q=v1&cursor=${encodeURIComponent(searchPageOne.body.meta.nextCursor)}`,
    { cookie: owner }
  );
  assert.deepEqual(searchPageTwo.body.data.map(item => item.id), [firstId]);
  const changedSearchCursor = await request(
    `/api/v1/thought-chains?limit=1&q=${encodeURIComponent("第二条")}&cursor=${encodeURIComponent(searchPageOne.body.meta.nextCursor)}`,
    { cookie: owner }
  );
  assert.equal(changedSearchCursor.response.status, 400);
  assert.equal(changedSearchCursor.body.error.code, "INVALID_CURSOR");
  const otherAccountThought = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: other,
    headers: { "idempotency-key": "chain-other-account-cursor" },
    body: { question: "v1 其他账户思绪", occurredAt: "2026-09-29T12:00:00" }
  });
  assert.equal(otherAccountThought.response.status, 201);
  const isolatedCursor = await request(
    `/api/v1/thought-chains?limit=1&q=v1&cursor=${encodeURIComponent(searchPageOne.body.meta.nextCursor)}`,
    { cookie: other }
  );
  assert.equal(isolatedCursor.response.status, 400);
  assert.equal(isolatedCursor.body.error.code, "INVALID_CURSOR");
  const blockSearch = await request(`/api/v1/thought-chains?q=${encodeURIComponent("初步想法")}`, { cookie: owner });
  assert.deepEqual(blockSearch.body.data.map(item => item.id), [firstId]);

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
  const changedSource = await request(`/api/v1/thought-chains/${firstId}`, {
    method: "PATCH", cookie: owner, headers: { "if-match": "\"1\"" }, body: { ...firstInput, sourceRef: null }
  });
  assert.equal(changedSource.response.status, 409);
  assert.equal(changedSource.body.error.code, "THOUGHT_SOURCE_IMMUTABLE");
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
  assert.ok(events.at(-1).result.data.contextReceipt.sources.some(source => source.resourceId === firstId));
  assert.equal(events.at(-1).result.error, null);
  const answerSearch = await request(`/api/v1/thought-chains?q=${encodeURIComponent("v1 回答")}`, { cookie: owner });
  assert.deepEqual(answerSearch.body.data.map(item => item.id), [firstId]);
  assert.doesNotMatch(JSON.stringify(answerSearch.body.data), /v1 思考|modelDraft|reasoningContent|contextReceipt|blocks/);

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
  assert.equal((await request("/api/v1/personal-context", { cookie: owner })).body.data.sources.some(source => source.resourceId === firstId), false);
  assert.equal((await request(`/api/trash/${removed.body.data.trashId}/restore`, {
    method: "POST", cookie: owner, body: {}
  })).response.status, 200);
  const restored = await request(`/api/v1/thought-chains/${firstId}`, { cookie: owner });
  assert.equal(restored.response.headers.get("etag"), "\"3\"");
  assert.equal(
    (await request("/api/v1/personal-context", { cookie: owner }))
      .body.data.sources.some(source => source.resourceId === firstId),
    false
  );
  const permissionPageAfterRestore = await request(
    "/api/v1/user-model/evidence-permissions?limit=100",
    { cookie: owner }
  );
  const restoredRootPermission = permissionPageAfterRestore.body.data.find(item => (
    item.sourceRef.resourceType === "thought"
    && item.sourceRef.resourceId === firstId
    && item.sourceRef.targetKey === `question:${firstId}`
  ));
  assert.ok(restoredRootPermission);
  const restoredPermission = await request("/api/v1/user-model/evidence-permissions", {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": `"${restoredRootPermission.revision}"` },
    body: {
      sourceRef: restoredRootPermission.sourceRef,
      contextAllowed: true,
      learningAllowed: false
    }
  });
  assert.equal(restoredPermission.response.status, 200, JSON.stringify({
    request: restoredRootPermission,
    response: restoredPermission.body
  }));
  assert.equal(
    (await request("/api/v1/personal-context", { cookie: owner }))
      .body.data.sources.some(source => source.resourceId === firstId),
    true
  );

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
