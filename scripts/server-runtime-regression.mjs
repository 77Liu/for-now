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

const lazyRuntime = createServerRuntime({
  rootUrl: pathToFileURL(path.join(ROOT, "server.mjs")).href,
  processRef
});
assert.deepEqual(
  Object.keys(lazyRuntime).sort(),
  ["ready", "start", "stop"]
);

console.log(
  "Server runtime regression passed: fixed route order, static fallback, lifecycle and lazy composition contract."
);
