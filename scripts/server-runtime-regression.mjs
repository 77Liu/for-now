import crypto from "node:crypto";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createServerLifecycle,
  createServerRuntime
} from "../src/app/index.mjs";
import {
  createHttpApplication,
  SERVER_ROUTE_IDS
} from "../src/http/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedRouteIds = [
  "health-readiness",
  "local-test-proxy",
  "admin",
  "auth",
  "owner",
  "v1",
  "legacy",
  "attachment",
  "static"
];
const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-runtime-public-"));
await fs.writeFile(path.join(publicDir, "asset.txt"), "static");
await fs.writeFile(path.join(publicDir, "index.html"), '<base href="/">shell');

const asyncStorage = new AsyncLocalStorage();
const requestStorage = {
  getStore: () => asyncStorage.getStore(),
  run: (value, callback) => asyncStorage.run(value, callback)
};
const sendJson = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(value));
  return true;
};
const routeCalls = [];
const routeHandler = (name, prefix) => ({
  async handle(req, res, url) {
    routeCalls.push(name);
    if (!url.pathname.startsWith(prefix)) return false;
    return sendJson(res, 200, { route: name });
  }
});
const localTestHttp = {
  async prepareRequestContext() {
    routeCalls.push("prepare");
  },
  async handle(req, res, url) {
    routeCalls.push("local-test");
    if (url.pathname !== "/api/local-test-mode") return false;
    return sendJson(res, 200, { route: "local-test" });
  },
  authentication() {
    throw new Error("disabled local-test authentication must not run");
  }
};
const adminHttp = routeHandler("admin", "/api/admin/");
const authApi = async (req, res, url) => {
  routeCalls.push("auth");
  if (!url.pathname.startsWith("/api/auth/")) return false;
  return sendJson(res, 200, { route: "auth" });
};
const ownerHttp = {
  capabilityFor(url) {
    routeCalls.push("owner-capability");
    return url.pathname.startsWith("/api/owner/") ? "owner" : "";
  },
  ...routeHandler("owner", "/api/owner/")
};
const apiV1 = {
  ...routeHandler("v1", "/api/v1/"),
  error(res, status, error, code, details) {
    return sendJson(res, status, { error, code, ...(details ? { details } : {}) });
  }
};
const application = createHttpApplication({
  requestStorage,
  dataDir: publicDir,
  publicDir,
  basePath: "/",
  version: "test-version",
  upstreamOrigin: "",
  localTestMode: false,
  postgresRuntime: null,
  logEvent: async () => {},
  sendJson,
  apiV1,
  localTestRuntime: { enabled: false },
  localTestHttp,
  adminHttp,
  proxyToUpstream: async () => {
    throw new Error("upstream proxy must not run");
  },
  requestAuthentication: async () => {
    routeCalls.push("authenticate");
    return { user: { id: "owner" }, reauthRequired: false };
  },
  authApi,
  bindAuthenticatedUser: () => {},
  isOwner: user => user?.id === "owner",
  ownerHttp,
  legacyApi: routeHandler("legacy", "/api/"),
  attachmentHttp: routeHandler("attachment", "/attachments/"),
  isApplicationRoutePath: pathname => pathname === "/today"
});
assert.deepEqual(application.routeIds, expectedRouteIds);
assert.equal(Object.isFrozen(application.routeIds), true);

const appServer = http.createServer(application.handle);
await new Promise(resolve => appServer.listen(0, "127.0.0.1", resolve));
const appBase = `http://127.0.0.1:${appServer.address().port}`;
const request = async pathname => {
  routeCalls.length = 0;
  const response = await fetch(`${appBase}${pathname}`);
  return {
    response,
    body: await response.text(),
    calls: [...routeCalls]
  };
};

try {
  let result = await request("/healthz");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.calls, []);

  result = await request("/api/admin/snapshot");
  assert.deepEqual(result.calls, ["prepare", "local-test", "admin"]);
  assert.equal(JSON.parse(result.body).route, "admin");

  result = await request("/api/auth/me");
  assert.deepEqual(
    result.calls,
    ["prepare", "local-test", "authenticate", "auth"]
  );
  assert.equal(JSON.parse(result.body).route, "auth");

  result = await request("/api/v1/state");
  assert.deepEqual(result.calls, [
    "prepare",
    "local-test",
    "authenticate",
    "owner-capability",
    "owner",
    "v1"
  ]);
  assert.equal(JSON.parse(result.body).route, "v1");

  result = await request("/api/state");
  assert.deepEqual(result.calls, [
    "prepare",
    "local-test",
    "authenticate",
    "owner-capability",
    "owner",
    "legacy"
  ]);
  assert.equal(JSON.parse(result.body).route, "legacy");

  result = await request("/attachments/item");
  assert.deepEqual(result.calls, [
    "prepare",
    "local-test",
    "authenticate",
    "owner-capability",
    "owner",
    "attachment"
  ]);
  assert.equal(JSON.parse(result.body).route, "attachment");

  result = await request("/asset.txt");
  assert.deepEqual(result.calls, [
    "prepare",
    "local-test",
    "authenticate",
    "owner-capability",
    "owner",
    "attachment"
  ]);
  assert.equal(result.body, "static");
} finally {
  await new Promise(resolve => appServer.close(resolve));
  await fs.rm(publicDir, { recursive: true, force: true });
}

const processRef = new EventEmitter();
processRef.exit = code => {
  throw new Error(`Unexpected process exit ${code}`);
};
let recovered = 0;
let samplerStarted = 0;
let samplerStopped = 0;
const lifecycle = createServerLifecycle({
  appConfig: {
    port: 0,
    version: "lifecycle-version",
    localTestMode: false,
    periodicAnalysisEnabled: false,
    speechCacheSweepEnabled: false
  },
  application: {
    handle(req, res) {
      res.end("running");
    }
  },
  accountLifecycle: {
    async recoverAtStartup() {
      recovered += 1;
    }
  },
  localTestRuntime: {},
  readAuth: async () => ({ users: [] }),
  runPeriodicAnalyses: async () => {},
  runSpeechCacheSweep: async () => {},
  observability: {
    logEvent: async () => {},
    runtimeMemorySampler: {
      async start() {
        samplerStarted += 1;
      },
      async stop() {
        samplerStopped += 1;
      }
    }
  },
  postgresRuntime: null,
  processRef
});
const started = await lifecycle.start();
assert.equal(started.version, "lifecycle-version");
assert.ok(started.port > 0);
assert.equal(await (await fetch(`http://127.0.0.1:${started.port}`)).text(), "running");
await lifecycle.ready();
await new Promise(resolve => setImmediate(resolve));
await lifecycle.stop({ signal: "test" });
assert.deepEqual(
  { recovered, samplerStarted, samplerStopped },
  { recovered: 1, samplerStarted: 1, samplerStopped: 1 }
);

// 恢复期间诊断端口可响应；未知启动失败必须回收已监听socket和数据库资源。
{
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let entered, rejectRecovery, closed = 0;
  const enteredRecovery = new Promise(resolve => { entered = resolve; });
  const blockedRecovery = new Promise((resolve, reject) => { rejectRecovery = reject; });
  const failedStart = createServerLifecycle({
    appConfig: { port, version: "f2-startup", localTestMode: false },
    application: { handle(req, res) { res.end("diagnostic"); } },
    accountLifecycle: { recoverAtStartup() { entered(); return blockedRecovery; } },
    accountRuntime: { enabled: true, health: () => ({ dependenciesHealthy: true }), failGlobal() {}, stop: async () => {}, onGlobalFailure: () => () => {} },
    localTestRuntime: {}, readAuth: async () => ({ users: [] }),
    observability: { logEvent: async () => {}, runtimeMemorySampler: { start: async () => {}, stop: async () => {} } },
    postgresRuntime: { close: async () => { closed++; } }, processRef
  });
  const starting = failedStart.start(); await enteredRecovery;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text(), "diagnostic");
  rejectRecovery(new Error("unknown shared startup failure"));
  await assert.rejects(starting, /unknown shared startup failure/);
  assert.equal(closed, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), /fetch failed/);
}

const lazyRuntime = createServerRuntime({
  rootUrl: pathToFileURL(path.join(ROOT, "server.mjs")).href,
  processRef
});
assert.deepEqual(
  Object.keys(lazyRuntime).sort(),
  ["ready", "start", "stop"]
);


// 显式开启F2，用完整JSON应用验证注册→重启坏账户→诊断→修复重试，不调用外部服务。
{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-f2-http-"));
  let releaseProvider = null, providerStarted = null;
  const providerRequests = [];
  const provider = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    providerRequests.push({ authorization: request.headers.authorization, body: JSON.parse(text) });
    if (providerStarted) { providerStarted(); await new Promise(resolve => { releaseProvider = resolve; }); }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "本机隔离验证回答", citations: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const keys = ["DATA_DIR", "PORT", "AUTH_REQUIRED", "INVITE_CODE_HASH", "APP_BASE_PATH", "ACCOUNT_RECOVERY_ENABLED", "ACCOUNT_RECOVERY_RETRY_COOLDOWN_MS", "ACCOUNT_RECOVERY_DEPENDENCY_PROBE_MS", "DEEPSEEK_API_URL"];
  const priorEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA_DIR: directory, DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}`, PORT: "0", AUTH_REQUIRED: "1", INVITE_CODE_HASH: crypto.createHash("sha256").update("f2-invite").digest("hex"), APP_BASE_PATH: "/", ACCOUNT_RECOVERY_ENABLED: "1", ACCOUNT_RECOVERY_RETRY_COOLDOWN_MS: "1", ACCOUNT_RECOVERY_DEPENDENCY_PROBE_MS: "20" });
  const exits = [];
  const runtimeProcess = new EventEmitter(); runtimeProcess.exit = code => exits.push(code);
  const create = () => createServerRuntime({ rootUrl: pathToFileURL(path.join(ROOT, "server.mjs")).href, processRef: runtimeProcess });
  let runtime = create();
  const call = async (base, pathname, cookie = "", method = "GET", body = undefined) => {
    const response = await fetch(base + pathname, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(pathname.endsWith("/extractions") ? { "idempotency-key": "f2-extraction" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, body: await response.json() };
  };
  try {
    let started = await runtime.start();
    let base = `http://127.0.0.1:${started.port}`;
    const users = [];
    for (const username of ["owner-a", "member-b", "member-c"]) {
      const value = await call(base, "/api/auth/register", "", "POST", { username, password: "valid-password-1", invitation: "f2-invite" });
      assert.equal(value.response.status, 201, JSON.stringify(value.body));
      const cookie = value.response.headers.get("set-cookie").split(";")[0];
      users.push({ ...value.body.user, cookie });
      assert.equal((await call(base, "/api/state", cookie)).response.status, 200, "committed registration must publish ready");
    }
    const bFile = path.join(directory, "users", users[1].id, "store.json");
    const savedB = await fs.readFile(bFile, "utf8");
    await runtime.stop();
    await fs.writeFile(bFile, "{BROKEN_B_PRIVATE_BODY");
    runtime = create(); started = await runtime.start(); base = `http://127.0.0.1:${started.port}`;
    const ready = await call(base, "/readyz");
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.degraded, true);
    assert.equal(ready.body.counts.ready, 2);
    assert.equal((await call(base, "/api/state", users[0].cookie)).response.status, 200);
    assert.equal((await call(base, "/api/state", users[2].cookie)).response.status, 200);
    assert.equal((await call(base, "/api/state", users[1].cookie)).response.status, 503);
    assert.equal((await call(base, "/attachments/private.png", users[1].cookie)).response.status, 503);
    assert.equal((await call(base, "/api/auth/me", users[1].cookie)).response.status, 200);
    const self = await call(base, "/api/v1/account-runtime", users[1].cookie);
    assert.equal(self.body.data.status, "quarantined");
    assert.equal(JSON.stringify(self.body).includes("BROKEN_B_PRIVATE_BODY"), false);
    const diagnostic = `/api/v1/owner/accounts/${users[1].id}/recovery`;
    assert.equal((await call(base, diagnostic, users[2].cookie)).response.status, 403);
    const state = (await call(base, diagnostic, users[0].cookie)).body.data;
    assert.equal(state.status, "quarantined");
    assert.equal(await fs.readFile(bFile, "utf8"), "{BROKEN_B_PRIVATE_BODY");
    await fs.writeFile(bFile, savedB);
    await new Promise(resolve => setTimeout(resolve, 3));
    const retried = await call(base, diagnostic + "/retry", users[0].cookie, "POST", { bootId: state.bootId, expectedEpoch: state.epoch });
    assert.equal(retried.response.status, 202);
    for (let n = 0; n < 100; n++) {
      if ((await call(base, diagnostic, users[0].cookie)).body.data.status === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await call(base, "/api/state", users[1].cookie)).response.status, 200);
    assert.equal((await call(base, diagnostic + "/retry", users[0].cookie, "POST", { bootId: state.bootId, expectedEpoch: state.epoch })).response.status, 409);
    // 使用真实OS权限制造未归因账户局部的read/write I/O故障；不能仍报告ready或覆盖原文。
    for (const operation of ["read", "write"]) {
      const directoryB = path.dirname(bFile);
      const original = await fs.readFile(bFile, "utf8");
      const deniedPath = operation === "read" ? bFile : directoryB;
      await fs.chmod(deniedPath, operation === "read" ? 0o000 : 0o500);
      try {
        const denied = operation === "read"
          ? await call(base, "/api/state", users[1].cookie)
          : await call(base, "/api/captures", users[1].cookie, "POST", { content: "F2禁止落盘的验证正文" });
        assert.equal(denied.response.status, 503, JSON.stringify(denied.body));
        for (let n = 0; n < 900 && !exits.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(exits, [1], `${operation} EACCES must drain and request nonzero exit`);
        await assert.rejects(fetch(base + "/healthz"), /fetch failed/);
      } finally { await fs.chmod(deniedPath, operation === "read" ? 0o600 : 0o700); }
      assert.equal(await fs.readFile(bFile, "utf8"), original, `${operation} I/O failure must preserve exact original bytes`);
      await runtime.stop(); exits.length = 0;
      runtime = create(); started = await runtime.start(); base = `http://127.0.0.1:${started.port}`;
      assert.equal((await call(base, "/api/state", users[1].cookie)).response.status, 200);
    }
    // 普通账户复用Owner配置不继承Owner业务资格；Owner store损坏仍能准备并真实完成本机模型调用。
    assert.equal((await call(base, "/api/settings", users[0].cookie, "POST", { apiKey: "f2-local-provider-key" })).response.status, 200);
    const member = users[2];
    const schema = (await call(base, "/api/v1/onboarding-v2/schema", member.cookie)).body.data;
    const session = await call(base, "/api/v1/onboarding-v2/session", member.cookie);
    const answers = Object.fromEntries(schema.questions.filter(question => question.questionId !== "collaboration").map(question => [question.questionId, { answerDisposition: "declined", contextAllowed: false }]));
    const patch = await fetch(base + "/api/v1/onboarding-v2/session", { method: "PATCH", headers: { cookie: member.cookie, "content-type": "application/json", "if-match": session.response.headers.get("etag"), "idempotency-key": "f2-onboarding" }, body: JSON.stringify({ selectedFlow: "v2", status: "completed", answers, collaboration: { answerDisposition: "declined", contextAllowed: false } }) });
    const patched = await patch.json(); assert.equal(patch.status, 200, JSON.stringify(patched));
    assert.equal((await call(base, "/api/v1/onboarding-v2/extractions", member.cookie, "POST", { sourceRevision: patched.data.session.revision })).response.status, 200);
    await fs.writeFile(path.join(directory, "users", users[0].id, "store.json"), "{OWNER_BUSINESS_BROKEN");
    assert.equal((await call(base, "/api/state", users[0].cookie)).response.status, 503);
    const draft = { question: "本机共享配置验证", requestId: "f2-shared-settings", targetId: "f2-test", inputVersion: 1 };
    const answered = await call(base, "/api/answer-drafts", member.cookie, "POST", draft);
    assert.equal(answered.response.status, 200, JSON.stringify(answered.body));
    assert.equal(providerRequests.at(-1).authorization, "Bearer f2-local-provider-key");
    // 已开始调用隔离后必须完成既有费用与usage收尾；隔离不能授权新调用或内容提交。
    let observedProvider; const providerEntered = new Promise(resolve => { observedProvider = resolve; }); providerStarted = observedProvider;
    const pendingAnswer = call(base, "/api/answer-drafts", member.cookie, "POST", { ...draft, requestId: "f2-inflight" });
    await providerEntered;
    await fs.writeFile(path.join(directory, "users", member.id, "store.json"), "{MEMBER_BUSINESS_BROKEN");
    assert.equal((await call(base, "/api/state", member.cookie)).response.status, 503);
    releaseProvider(); providerStarted = null;
    const finished = await pendingAnswer;
    assert.equal(finished.response.status, 503, JSON.stringify(finished.body));
    const usage = JSON.parse(await fs.readFile(path.join(directory, "users", member.id, "ai-usage.json"), "utf8"));
    assert.equal(usage.entries.length, 2, "both completed provider calls must retain usage after quarantine");
    const callsBefore = providerRequests.length;
    assert.equal((await call(base, "/api/answer-drafts", member.cookie, "POST", { ...draft, requestId: "f2-denied" })).response.status, 503);
    assert.equal(providerRequests.length, callsBefore, "quarantine must not start a new provider call");
    const authFile = path.join(directory, "auth.json");
    await fs.writeFile(authFile, "{BROKEN_GLOBAL_AUTH");
    for (let n = 0; n < 100 && !exits.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(exits, [1], "shared auth corruption must drain, close and request nonzero process exit");
    await assert.rejects(fetch(base + "/healthz"), /fetch failed/);
    await runtime.stop();
    runtime = create();
    await assert.rejects(runtime.start(), /数据无法读取|认证/);
    assert.equal(await fs.readFile(authFile, "utf8"), "{BROKEN_GLOBAL_AUTH");
  } finally {
    releaseProvider?.();
    await runtime.stop().catch(() => {});
    await new Promise(resolve => provider.close(resolve));
    for (const key of keys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

console.log(
  "Server runtime regression passed: fixed route order, static fallback, lifecycle and lazy composition contract."
);
