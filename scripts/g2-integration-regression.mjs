import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-g2-integration-"));
const port = await freePort();
const invitation = "g2-integration-invitation";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: String(port),
    APP_BASE_PATH: "/g2",
    APP_VERSION: "0.2.0",
    INVITE_CODE_HASH: crypto.createHash("sha256").update(invitation).digest("hex"),
    COOKIE_SECURE: "0",
    UPSTREAM_ORIGIN: ""
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const base = `http://127.0.0.1:${port}/g2`;

async function request(pathname, { method = "GET", cookie = "", headers = {}, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  return { response, body: payload };
}

async function register(username) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: { username, password: "g2-contract-password", invitation }
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.response.headers.get("set-cookie").split(";")[0];
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch {}
    if (ready || child.exitCode != null) break;
    await delay(50);
  }
  assert.equal(ready, true, stderr);

  const owner = await register("g2-owner");
  const other = await register("g2-other");
  const specification = await request("/api/v1/openapi.json", { cookie: owner });
  for (const route of ["/discovery", "/exports/account", "/actions", "/habits", "/feedback", "/validation-ledger"]) {
    assert.ok(specification.body.paths[route], `OpenAPI missing ${route}`);
  }

  const chain = await request("/api/v1/thought-chains", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-chain-1" },
    body: { question: "如何完成 G2 集成", idea: "先建立稳定接口", occurredAt: "2026-09-29T08:00:00.000Z" }
  });
  assert.equal(chain.response.status, 201);
  const thoughtId = chain.body.data.items.find(item => item.type === "question").id;
  const discovery = await request("/api/v1/discovery?q=G2&type=question", { cookie: owner });
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.body.data[0].id, thoughtId);
  assert.equal(discovery.body.data[0].matches[0].source, "user");
  assert.deepEqual((await request("/api/v1/discovery?q=G2", { cookie: other })).body.data, []);
  const discoveryVersion = discovery.body.data[0].status.version;
  const marked = await request(`/api/v1/thought-chains/${thoughtId}/discovery`, {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": `"${discoveryVersion}"` },
    body: { action: "read" }
  });
  assert.equal(marked.response.status, 200);
  assert.equal(marked.response.headers.get("etag"), `"${discoveryVersion + 1}"`);
  assert.equal((await request(`/api/v1/thought-chains/${thoughtId}/discovery`, {
    method: "PATCH",
    cookie: owner,
    headers: { "if-match": `"${discoveryVersion}"` },
    body: { action: "clearSnooze" }
  })).response.status, 412);

  const actionInput = {
    title: "完成 I 串行集成",
    priority: "P0",
    sourceRef: { type: "thought", id: thoughtId, label: "G2 集成" }
  };
  const createdAction = await request("/api/v1/actions", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-action-1" },
    body: actionInput
  });
  assert.equal(createdAction.response.status, 201);
  assert.equal(createdAction.response.headers.get("etag"), "\"1\"");
  const actionId = createdAction.body.data.id;
  const replayedAction = await request("/api/v1/actions", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-action-1" },
    body: actionInput
  });
  assert.equal(replayedAction.response.status, 200);
  assert.equal(replayedAction.body.data.id, actionId);
  assert.equal((await request(`/api/v1/actions/${actionId}`, { cookie: other })).response.status, 404);
  const completedAction = await request(`/api/v1/actions/${actionId}/complete`, {
    method: "POST",
    cookie: owner,
    headers: { "if-match": "\"1\"" }
  });
  assert.equal(completedAction.response.status, 200);
  assert.equal(completedAction.body.data.status, "done");
  assert.equal((await request(`/api/v1/actions/${actionId}/reopen`, {
    method: "POST",
    cookie: owner,
    headers: { "if-match": "\"1\"" }
  })).response.status, 412);

  const habit = await request("/api/v1/habits", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-habit-1" },
    body: { title: "每日复盘", frequency: { cadence: "daily", target: 1 } }
  });
  assert.equal(habit.response.status, 201);
  const habitId = habit.body.data.id;
  const habitCheckin = await request(`/api/v1/habits/${habitId}/checkins`, {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-habit-checkin-1" },
    body: { occurredOn: "2026-09-29", feeling: "完成" }
  });
  assert.equal(habitCheckin.response.status, 201);
  const habitCheckinId = habitCheckin.body.data.id;
  const deletedHabit = await request(`/api/v1/habits/${habitId}`, {
    method: "DELETE",
    cookie: owner,
    headers: { "if-match": "\"1\"" }
  });
  assert.equal(deletedHabit.response.status, 200);
  assert.equal((await request(`/api/v1/habits/${habitId}/checkins`, { cookie: owner })).body.data.length, 0);
  const trash = await request("/api/trash", { cookie: owner });
  const habitTrash = trash.body.items.find(item => item.type === "habit" && item.resourceId === habitId);
  const checkinTrash = trash.body.items.find(item => item.type === "habitCheckin" && item.resourceId === habitCheckinId);
  assert.ok(habitTrash && checkinTrash);
  const deletedCheckinReplay = await request(`/api/v1/habits/${habitId}/checkins`, {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-habit-checkin-1" },
    body: { occurredOn: "2026-09-29", feeling: "完成" }
  });
  assert.equal(deletedCheckinReplay.response.status, 200);
  assert.equal(deletedCheckinReplay.body.data.id, habitCheckinId);
  assert.equal((await request(`/api/trash/${checkinTrash.id}/restore`, {
    method: "POST", cookie: owner, body: {}
  })).response.status, 409);
  assert.equal((await request(`/api/trash/${habitTrash.id}/restore`, {
    method: "POST", cookie: owner, body: {}
  })).response.status, 200);
  const replacementCheckin = await request(`/api/v1/habits/${habitId}/checkins`, {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-habit-checkin-replacement" },
    body: { occurredOn: "2026-09-29", feeling: "重新记录" }
  });
  assert.equal(replacementCheckin.response.status, 201);
  assert.equal((await request(`/api/trash/${checkinTrash.id}/restore`, {
    method: "POST", cookie: owner, body: {}
  })).response.status, 409);

  const feedback = await request("/api/v1/feedback", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-feedback-1" },
    body: {
      type: "experience",
      feature: "行动",
      appVersion: "0.2.0",
      body: "行动闭环可用",
      context: { selected: false, summary: "不应保存" }
    }
  });
  assert.equal(feedback.response.status, 201);
  assert.deepEqual(feedback.body.data.context, { selected: false, summary: "" });
  assert.deepEqual((await request("/api/v1/feedback", { cookie: other })).body.data, []);

  const validation = await request("/api/v1/validation-ledger", {
    method: "POST",
    cookie: owner,
    headers: { "idempotency-key": "g2-validation-1" },
    body: { participantRef: "成员-01", plan: { goal: "验证行动闭环", tasks: ["创建行动"] } }
  });
  assert.equal(validation.response.status, 201);
  const validationId = validation.body.data.id;
  const consent = await request(`/api/v1/validation-ledger/${validationId}/consent`, {
    method: "POST",
    cookie: owner,
    headers: { "if-match": "\"1\"" },
    body: { noticeVersion: "privacy-v1" }
  });
  assert.equal(consent.response.status, 200);
  assert.equal(consent.body.data.consent.status, "agreed");

  const exported = await request("/api/v1/exports/account?format=manifest", { cookie: owner });
  assert.equal(exported.response.status, 200);
  const exportedTypes = new Set(exported.body.data.resources.map(item => item.resourceType));
  for (const type of ["thought", "action", "habit", "habitCheckin", "feedback", "validationLedger"]) {
    assert.ok(exportedTypes.has(type), `export missing ${type}`);
  }
  assert.equal(exported.body.data.accountId.length > 0, true);
  assert.equal(exported.body.data.snapshotVersion, 16);
  assert.doesNotMatch(JSON.stringify(exported.body.data), /g2-contract-password|invitation/);

  console.log("G2 integration checks passed: OpenAPI, discovery, idempotent actions, habit cascade restore, feedback privacy, validation consent, account isolation and full export.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    delay(1000).then(() => child.kill("SIGKILL"))
  ]);
  await fs.rm(dataDir, { recursive: true, force: true });
}
