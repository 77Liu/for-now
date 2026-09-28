import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`本地测试服务提前退出：${child.exitCode}\n${stderr()}`);
    try {
      if ((await fetch(`${base}/readyz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`本地测试服务启动超时\n${stderr()}`);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json() };
}

const upstreamCalls = [];
let upstreamUserId = "main-user";
const remoteCapture = {
  id: "remote-capture",
  createdAt: "2026-09-28T01:00:00.000Z",
  occurredAt: "2026-09-28T01:00:00.000Z",
  occurredOn: "2026-09-28",
  content: "线上主账户原文",
  tags: ["线上"],
  annotations: [],
  annotationDrift: [],
  attachmentPath: "/attachments/remote.png",
  version: 1
};
const upstream = http.createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  const url = new URL(request.url, "http://127.0.0.1");
  upstreamCalls.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie || "" });
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    response.setHeader("set-cookie", "for_now_session=main-session; Path=/now; HttpOnly; SameSite=Lax; Secure");
    return response.end(JSON.stringify({ authenticated: true, authRequired: true, user: { id: upstreamUserId, username: "main", createdAt: "" }, userCount: 3 }));
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return response.end(JSON.stringify({ authenticated: false }));
  if (request.headers.cookie !== "for_now_session=main-session") {
    response.writeHead(401);
    return response.end(JSON.stringify({ authenticated: false, error: "请先登录", code: "AUTH_REQUIRED", userCount: 3 }));
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") return response.end(JSON.stringify({ authenticated: true, authRequired: true, user: { id: upstreamUserId, username: "main", createdAt: "" }, userCount: 3 }));
  if (url.pathname === "/api/state" && request.method === "GET") {
    return response.end(JSON.stringify({
      version: 14,
      checkins: [],
      dailyRecords: [],
      captures: [remoteCapture],
      journals: [],
      journalDraft: null,
      thoughts: [],
      chats: [],
      books: [],
      keepsakes: [],
      quotes: [],
      experiments: [],
      analyses: [],
      customMetrics: [],
      onboarding: { status: "completed", questionnaireMode: "quick", answers: {}, profile: {}, interests: ["阅读"], material: "", understanding: "线上初始理解", updatedAt: "2026-09-28T01:00:00.000Z" }
    }));
  }
  if (url.pathname === "/api/trash" && request.method === "GET") return response.end(JSON.stringify({ retentionDays: 30, items: [] }));
  if (url.pathname === "/api/settings" && request.method === "GET") return response.end(JSON.stringify({ version: 5, provider: "deepseek", assistantName: "线上助手", profiles: {}, scenarios: {}, responseStyles: {}, hasApiKey: true, keyHint: "pro••••tion" }));
  if (url.pathname === "/attachments/remote.png" && request.method === "GET") {
    response.setHeader("content-type", "image/png");
    return response.end(Buffer.from("remote-image"));
  }
  response.writeHead(405);
  response.end(JSON.stringify({ error: "upstream write rejected" }));
});
await new Promise((resolve, reject) => upstream.once("error", reject).listen(0, "127.0.0.1", resolve));

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-local-test-mode-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const cookie = "for_now_session=main-session";
const productionGuard = spawnSync(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "production", PORT: String(await freePort()), DATA_DIR: path.join(dataDir, "forbidden-production"), AUTH_REQUIRED: "0", INVITE_CODE_HASH: "", LOCAL_TEST_MODE: "1" },
  encoding: "utf8",
  timeout: 5000
});
assert.notEqual(productionGuard.status, 0);
assert.match(productionGuard.stderr, /LOCAL_TEST_MODE cannot run with NODE_ENV=production/);
let stderr = "";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DATA_DIR: dataDir,
    AUTH_REQUIRED: "0",
    INVITE_CODE_HASH: "",
    COOKIE_SECURE: "0",
    LOCAL_TEST_MODE: "1",
    LOCAL_TEST_MAIN_USER_ID: "main-user",
    UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
    ATTACHMENT_STORAGE: "local"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
child.stderr.on("data", chunk => { stderr += chunk; });

try {
  await waitForServer(base, child, () => stderr);
  const initial = await jsonRequest(`${base}/api/local-test-mode`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.mode, "cold");
  assert.equal(initial.body.enabled, true);
  assert.equal(initial.body.upstreamConfigured, true);
  assert.equal((await jsonRequest(`${base}/api/state`)).body.onboarding.status, "pending");
  const login = await jsonRequest(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "main", password: "test-password-1" }) });
  assert.equal(login.response.status, 200);
  assert.match(login.response.headers.get("set-cookie") || "", /Path=\//);
  assert.doesNotMatch(login.response.headers.get("set-cookie") || "", /;\s*Secure/i);

  assert.equal((await jsonRequest(`${base}/api/captures`, {
    method: "POST",
    body: JSON.stringify({ occurredAt: "2026-09-28T12:00:00", content: "冷启空间临时记录", tags: [] })
  })).response.status, 201);
  assert.equal((await jsonRequest(`${base}/api/state`)).body.captures.length, 1);

  const resetCold = await jsonRequest(`${base}/api/local-test-mode`, { method: "POST", body: JSON.stringify({ mode: "cold" }) });
  assert.equal(resetCold.response.status, 200);
  assert.equal((await jsonRequest(`${base}/api/state`)).body.captures.length, 0);
  assert.equal((await jsonRequest(`${base}/api/settings`)).body.assistantName, "神鸡");

  const simulation = await jsonRequest(`${base}/api/local-test-mode`, { method: "POST", headers: { cookie }, body: JSON.stringify({ mode: "simulation" }) });
  assert.equal(simulation.response.status, 200);
  assert.equal(simulation.body.mode, "simulation");
  assert.equal(simulation.body.sourceUser.id, "main-user");
  assert.equal(simulation.body.recordCount, 1);
  let state = (await jsonRequest(`${base}/api/state`)).body;
  assert.equal(state.captures[0].content, "线上主账户原文");
  const simulationSettings = (await jsonRequest(`${base}/api/settings`)).body;
  assert.equal(simulationSettings.assistantName, "线上助手");
  assert.equal(simulationSettings.hasApiKey, false);

  const localEdit = await jsonRequest(`${base}/api/captures/remote-capture`, {
    method: "PATCH",
    body: JSON.stringify({ occurredAt: "2026-09-28T12:00:00", content: "只在本地修改", tags: ["本地"] })
  });
  assert.equal(localEdit.response.status, 200);
  assert.equal((await jsonRequest(`${base}/api/state`)).body.captures[0].content, "只在本地修改");
  assert.equal(upstreamCalls.some(call => call.method === "PATCH"), false);

  const attachment = await fetch(`${base}/attachments/remote.png`, { headers: { cookie } });
  assert.equal(attachment.status, 200);
  assert.equal(Buffer.from(await attachment.arrayBuffer()).toString(), "remote-image");

  const blockedRegistration = await jsonRequest(`${base}/api/auth/register`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ username: "forbidden", password: "password1", invitation: "forbidden" })
  });
  assert.equal(blockedRegistration.response.status, 403);
  assert.equal(blockedRegistration.body.code, "LOCAL_TEST_READ_ONLY");
  assert.equal(upstreamCalls.some(call => call.path === "/api/auth/register"), false);

  const refreshed = await jsonRequest(`${base}/api/local-test-mode`, { method: "POST", headers: { cookie }, body: JSON.stringify({ mode: "simulation" }) });
  assert.equal(refreshed.response.status, 200);
  state = (await jsonRequest(`${base}/api/state`)).body;
  assert.equal(state.captures[0].content, "线上主账户原文");

  upstreamUserId = "not-main";
  const wrongAccount = await jsonRequest(`${base}/api/local-test-mode`, { method: "POST", headers: { cookie }, body: JSON.stringify({ mode: "simulation" }) });
  assert.equal(wrongAccount.response.status, 403);
  assert.equal(wrongAccount.body.code, "LOCAL_TEST_MAIN_ACCOUNT_REQUIRED");

  assert.equal(upstreamCalls.filter(call => call.path === "/api/state").every(call => call.method === "GET"), true);
  assert.equal(upstreamCalls.filter(call => !call.path.startsWith("/api/auth/")).every(call => call.method === "GET"), true);
  assert.equal((await fs.stat(path.join(dataDir, "local-test-mode.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dataDir, "local-test-workspaces", "simulation", "store.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dataDir, "local-test-workspaces", "cold"))).mode & 0o777, 0o700);

  console.log("Local test mode checks passed: cold reset, authenticated main-account snapshot, local-only mutation, refresh replacement, read-only attachment fallback and upstream write denial.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}
