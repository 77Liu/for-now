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

const provider = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "isolated response" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
let errors = "";
const startApp = () => {
  const app = spawn(globalThis.process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...globalThis.process.env, NODE_ENV: "test", DATA_DIR: dataDir, PORT: String(port), APP_BASE_PATH: "/now", INVITE_CODE_HASH: invitationHash, COOKIE_SECURE: "1", UPSTREAM_ORIGIN: "", DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}` },
    stdio: ["ignore", "pipe", "pipe"]
  });
  app.stderr.on("data", chunk => { errors += chunk; });
  return app;
};
let child = startApp();

try {
  await waitForServer(base, child);
  assert.equal((await fetch(`${base}/now`, { redirect: "manual" })).status, 308);
  assert.equal((await fetch(`${base}/now/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/now/api/state`)).status, 401);

  const crossSite = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ username: "attacker", password: "cross-site-password-1", invitation })
  });
  assert.equal(crossSite.response.status, 403);

  const rejected = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery-1", invitation: "wrong" })
  });
  assert.equal(rejected.response.status, 403);

  const weakPassword = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "letters-only", invitation })
  });
  assert.equal(weakPassword.response.status, 400);

  const registered = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "correct-horse-battery-1", invitation })
  });
  assert.equal(registered.response.status, 201);
  const ownerSetCookie = registered.response.headers.get("set-cookie");
  assert.match(ownerSetCookie, /;\s*Secure(?:;|$)/i);
  const ownerCookie = ownerSetCookie.split(";")[0];
  const ownerState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerState.body.captures[0].content, "legacy-owner-data");

  const second = await jsonRequest(`${base}/now/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username: "second", password: "another-long-password-2", invitation })
  });
  assert.equal(second.response.status, 201);
  const secondCookie = second.response.headers.get("set-cookie").split(";")[0];
  const secondState = await jsonRequest(`${base}/now/api/state`, { headers: { cookie: secondCookie } });
  assert.deepEqual(secondState.body.captures, []);
  const secondDir = path.join(dataDir, "users", second.body.user.id);
  assert.equal((await fs.stat(secondDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(secondDir, "attachments"))).mode & 0o777, 0o700);
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const uploaded = await jsonRequest(`${base}/now/api/images/upload`, {
    method: "POST", headers: { cookie: secondCookie }, body: JSON.stringify({ image: pixel })
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal((await fs.stat(path.join(secondDir, uploaded.body.attachmentPath.replace("/attachments/", "attachments/")))).mode & 0o777, 0o600);
  assert.equal((await jsonRequest(`${base}/now/api/captures/legacy`, {
    method: "PATCH", headers: { cookie: secondCookie }, body: JSON.stringify({ content: "cross-account-change" })
  })).response.status, 404);
  await Promise.all([[ownerCookie, "OWNER_PRIVATE"], [secondCookie, "SECOND_PRIVATE"]].map(async ([cookie, question]) => {
    assert.equal((await jsonRequest(`${base}/now/api/settings`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ apiKey: "audit-test-key" })
    })).response.status, 200);
    assert.equal((await jsonRequest(`${base}/now/api/answer-drafts`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ question })
    })).response.status, 200);
  }));
  const readLogs = async userId => {
    const dir = path.join(dataDir, "users", userId, "logs");
    return (await Promise.all((await fs.readdir(dir)).map(name => fs.readFile(path.join(dir, name), "utf8")))).join("\n");
  };
  const ownerLogs = await readLogs(registered.body.user.id), secondLogs = await readLogs(second.body.user.id);
  assert.match(ownerLogs, /OWNER_PRIVATE/);
  assert.doesNotMatch(ownerLogs, /SECOND_PRIVATE|audit-test-key/);
  assert.match(secondLogs, /SECOND_PRIVATE/);
  assert.doesNotMatch(secondLogs, /OWNER_PRIVATE|legacy-owner-data|audit-test-key/);
  for (const userId of [registered.body.user.id, second.body.user.id]) {
    const entries = JSON.parse(await fs.readFile(path.join(dataDir, "users", userId, "ai-usage.json"))).entries;
    assert.equal(entries.length, 1);
  }

  const duplicateRename = await jsonRequest(`${base}/now/api/auth/username`, {
    method: "PATCH",
    headers: { cookie: secondCookie },
    body: JSON.stringify({ username: "OWNER" })
  });
  assert.equal(duplicateRename.response.status, 409);

  const renamed = await jsonRequest(`${base}/now/api/auth/username`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ username: "keeper" })
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.user.username, "keeper");

  const wrongCurrentPassword = await jsonRequest(`${base}/now/api/auth/password`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ currentPassword: "wrong-password-1", newPassword: "new-secure-password-2" })
  });
  assert.equal(wrongCurrentPassword.response.status, 403);

  const changedPassword = await jsonRequest(`${base}/now/api/auth/password`, {
    method: "PATCH",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ currentPassword: "correct-horse-battery-1", newPassword: "new-secure-password-2" })
  });
  assert.equal(changedPassword.response.status, 200);
  assert.equal((await fetch(`${base}/now/api/state`, { headers: { cookie: ownerCookie } })).status, 200);

  const oldPasswordLogin = await jsonRequest(`${base}/now/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "keeper", password: "correct-horse-battery-1" })
  });
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await jsonRequest(`${base}/now/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "keeper", password: "new-secure-password-2" })
  });
  assert.equal(newPasswordLogin.response.status, 200);

  const validAuthFile = await fs.readFile(path.join(dataDir, "auth.json"), "utf8");
  assert.doesNotMatch(validAuthFile, /correct-horse-battery|another-long-password|new-secure-password|regression-invitation/);
  assert.equal((await fs.stat(path.join(dataDir, "auth.json"))).mode & 0o777, 0o600);

  const loggedOut = await jsonRequest(`${base}/now/api/auth/logout`, { method: "POST", headers: { cookie: ownerCookie }, body: "{}" });
  const clearedCookie = loggedOut.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/now/api/state`, { headers: { cookie: clearedCookie } })).status, 401);
  await sleep(100);
  const logs = [await readLogs(registered.body.user.id), await readLogs(second.body.user.id),
    ...(await Promise.all((await fs.readdir(path.join(dataDir, "logs"))).map(name => fs.readFile(path.join(dataDir, "logs", name), "utf8"))))].join("\n");
  assert.doesNotMatch(logs, /correct-horse-battery|another-long-password|new-secure-password|regression-invitation|scrypt\$/);
  assert.ok(logs.includes('"passwordHash"')); // Field name is useful; credential value is not.

  const oldStore = JSON.parse(await fs.readFile(path.join(secondDir, "store.json"), "utf8"));
  const oldSettings = JSON.parse(await fs.readFile(path.join(secondDir, "llm-settings.json"), "utf8"));
  const oldUsage = JSON.parse(await fs.readFile(path.join(secondDir, "ai-usage.json"), "utf8"));
  await fs.writeFile(path.join(secondDir, "store.json"), JSON.stringify({ ...oldStore, version: 11 }));
  await fs.writeFile(path.join(secondDir, "llm-settings.json"), JSON.stringify({ ...oldSettings, version: 3 }));
  await fs.writeFile(path.join(secondDir, "ai-usage.json"), JSON.stringify({ ...oldUsage, version: 1 }));
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  child = startApp();
  await waitForServer(base, child);
  const migratedNames = await fs.readdir(secondDir);
  assert.ok(migratedNames.some(name => /store\.json\.v11-pre-v12.*\.bak$/.test(name)));
  assert.ok(migratedNames.some(name => /llm-settings\.json\.v3-pre-v4.*\.bak$/.test(name)));
  assert.ok(migratedNames.some(name => /ai-usage\.json\.v1-pre-v2.*\.bak$/.test(name)));
  for (const name of migratedNames.filter(name => name.endsWith(".bak"))) {
    assert.equal((await fs.stat(path.join(secondDir, name))).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(secondDir, "ai-usage.json"), "utf8")).version, 2);

  await fs.writeFile(path.join(dataDir, "auth.json"), "{PRIVATE_CORRUPT_AUTH");
  const damaged = await jsonRequest(`${base}/now/api/auth/me`, { headers: { cookie: secondCookie } });
  assert.equal(damaged.response.status, 500);
  assert.doesNotMatch(JSON.stringify(damaged.body) + errors, /PRIVATE_CORRUPT_AUTH/);
  assert.equal(await fs.readFile(path.join(dataDir, "auth.json"), "utf8"), "{PRIVATE_CORRUPT_AUTH");
  console.log("Auth checks passed: access boundaries, account updates, secure sessions, legacy ownership, concurrent per-user AI/operation isolation, credential redaction and corrupt-auth preservation.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}

if (errors) process.stderr.write(errors);
