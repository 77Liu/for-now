import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`认证测试服务提前退出：${child.exitCode}`);
    try {
      if ((await fetch(`${url}/now/healthz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("认证测试服务启动超时");
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-auth-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const invitation = "regression-invitation";
const invitationHash = crypto.createHash("sha256").update(invitation).digest("hex");
const legacyStore = {
  version: 12,
  checkins: [],
  dailyRecords: [],
  captures: [{ id: "legacy", content: "legacy-owner-data", createdAt: "2026-09-27T00:00:00.000Z", occurredAt: "2026-09-27T00:00:00.000Z", occurredOn: "2026-09-27" }],
  journals: [],
  thoughts: [],
  chats: [],
  books: [],
  keepsakes: [],
  quotes: [],
  experiments: [],
  analyses: [],
  customMetrics: []
};
await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify(legacyStore)}\n`);

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), APP_BASE_PATH: "/now", INVITE_CODE_HASH: invitationHash },
  stdio: ["ignore", "pipe", "pipe"]
});
let errors = "";
child.stderr.on("data", chunk => { errors += chunk; });

try {
  await waitForServer(base, child);
  assert.equal((await fetch(`${base}/now`, { redirect: "manual" })).status, 308);
  assert.equal((await fetch(`${base}/now/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/now/api/state`)).status, 401);

  const rejected = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery", invitation: "wrong" })
  });
  assert.equal(rejected.response.status, 403);

  const registered = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery", invitation })
  });
  assert.equal(registered.response.status, 201);
  const ownerCookie = registered.response.headers.get("set-cookie").split(";")[0];
  const ownerState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerState.body.captures[0].content, "legacy-owner-data");

  const second = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "second", password: "another-long-password", invitation })
  });
  assert.equal(second.response.status, 201);
  const secondCookie = second.response.headers.get("set-cookie").split(";")[0];
  const secondState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } });
  assert.deepEqual(secondState.body.captures, []);

  const authFile = await fs.readFile(path.join(dataDir, "auth.json"), "utf8");
  assert.doesNotMatch(authFile, /correct-horse-battery|another-long-password|regression-invitation/);
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);

  const loggedOut = await jsonRequest(`${base}/now/api/auth/logout`, { method: "POST", headers: { cookie: ownerCookie }, body: "{}" });
  const clearedCookie = loggedOut.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/now/api/state`, { headers: { cookie: clearedCookie } })).status, 401);
  console.log("Auth checks passed: invite gate, scrypt sessions, legacy ownership, subpath assets, logout, and per-user isolation.");
} finally {
  child.kill("SIGTERM");
  await fs.rm(dataDir, { recursive: true, force: true });
}

if (errors) process.stderr.write(errors);
