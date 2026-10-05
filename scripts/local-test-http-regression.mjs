import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLocalTestHttp,
  createLocalTestSessionVault,
  createReadOnlyUpstream
} from "../src/http/index.mjs";

const request = (cookie = "", overrides = {}) => ({
  method: "GET",
  headers: { cookie, "user-agent": "local-test-regression", ...(overrides.headers || {}) },
  ...overrides
});

let currentTime = 1_000;
const tokens = ["token-a", "token-b", "token-c", "token-d"];
const sessions = createLocalTestSessionVault({
  enabled: true,
  maxAgeSeconds: 10,
  maxSessions: 2,
  currentTime: () => currentTime,
  createToken: () => tokens.shift()
});
const owner = { id: "owner", username: "Owner", role: "owner" };
const tokenA = sessions.store("", "upstream=a", owner);
assert.equal(tokenA, "token-a");
assert.deepEqual(sessions.get(request("for_now_local_test_session=token-a"))?.user, owner);
assert.equal(sessions.upstreamCookie(request("for_now_local_test_session=token-a")), "upstream=a");
sessions.store("", "upstream=b", { ...owner, id: "b" });
sessions.store("", "upstream=c", { ...owner, id: "c" });
assert.equal(sessions.get(request("for_now_local_test_session=token-a")), null);
assert.equal(sessions.get(request("for_now_local_test_session=token-b"))?.user.id, "b");
currentTime += 10_001;
assert.equal(sessions.get(request("for_now_local_test_session=token-b")), null);
assert.equal(sessions.get(request("for_now_local_test_session=%E0%A4%A")), null);

const passthroughSessions = createLocalTestSessionVault({ enabled: false });
assert.equal(
  passthroughSessions.upstreamCookie(request("for_now_session=production")),
  "for_now_session=production"
);

const requestStorage = new AsyncLocalStorage();
const upstreamCalls = [];
const upstreamSessions = {
  upstreamCookie: () => "for_now_session=upstream"
};
const upstream = createReadOnlyUpstream({
  origin: "https://upstream.example",
  sessions: upstreamSessions,
  requestStorage,
  fetchImpl: async (url, options) => {
    upstreamCalls.push({ url, options });
    const cursor = new URL(url).searchParams.get("cursor");
    return new Response(JSON.stringify(cursor
      ? { data: [{ id: "second" }], meta: { nextCursor: null } }
      : { data: [{ id: "first" }], meta: { nextCursor: "next" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
const items = await requestStorage.run(
  { traceId: "trace-local-test" },
  () => upstream.list(request(), "/api/v1/captures")
);
assert.deepEqual(items.map(item => item.id), ["first", "second"]);
assert.equal(upstreamCalls.length, 2);
assert.ok(upstreamCalls.every(call => call.options.method === "GET"));
assert.ok(upstreamCalls.every(call => call.options.headers.cookie === "for_now_session=upstream"));
assert.ok(upstreamCalls.every(call => call.options.headers["x-request-id"] === "trace-local-test"));

let stalledCalls = 0;
const stalled = createReadOnlyUpstream({
  origin: "https://upstream.example",
  sessions: upstreamSessions,
  requestStorage,
  fetchImpl: async () => {
    stalledCalls += 1;
    return new Response(JSON.stringify({ data: [], meta: { nextCursor: "same" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
await assert.rejects(
  stalled.list(request(), "/api/v1/captures"),
  error => error.code === "LOCAL_TEST_UPSTREAM_CURSOR_STALLED"
);
assert.equal(stalledCalls, 2);

const unauthorized = createReadOnlyUpstream({
  origin: "https://upstream.example",
  sessions: upstreamSessions,
  requestStorage,
  fetchImpl: async () => new Response(JSON.stringify({ error: "private" }), {
    status: 401,
    headers: { "content-type": "application/json" }
  })
});
await assert.rejects(
  unauthorized.json(request(), "/api/state"),
  error => error.statusCode === 401
    && error.code === "AUTH_REQUIRED"
    && error.message === "请先登录线上主账户"
);

const timedOut = createReadOnlyUpstream({
  origin: "https://upstream.example",
  sessions: upstreamSessions,
  requestStorage,
  fetchImpl: async () => {
    throw new DOMException("timeout", "TimeoutError");
  }
});
await assert.rejects(
  timedOut.json(request(), "/api/state"),
  error => error.statusCode === 504 && error.code === "LOCAL_TEST_UPSTREAM_TIMEOUT"
);

currentTime = 20_000;
const routeSessions = createLocalTestSessionVault({
  enabled: true,
  currentTime: () => currentTime,
  createToken: () => "route-token"
});
const sent = [];
let proxyCalls = 0;
const runtime = {
  enabled: true,
  upstreamConfigured: true,
  prepareRequestContext: async context => context,
  requireOwner: req => routeSessions.get(req),
  publicControl: value => value,
  readControl: async () => ({ mode: "cold" }),
  hydrateScope: async () => ({ control: {}, state: {}, hydrated: false }),
  switchMode: async () => ({ mode: "cold" }),
  canProxyAttachment: context => context?.localTestMode === "simulation"
};
const localHttp = createLocalTestHttp({
  runtime,
  sessions: routeSessions,
  basePath: "/now",
  sendJson: (_response, status, body) => sent.push({ status, body }),
  bodyJson: async () => ({}),
  bindUser: () => {},
  proxyToUpstream: async () => { proxyCalls += 1; }
});
const responseHeaders = {};
await localHttp.rewriteProxyResponse({
  request: request(),
  pathname: "/api/auth/login",
  upstreamResponse: new Response(JSON.stringify({ user: owner }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }),
  cookies: ["for_now_session=secret; Path=/now; HttpOnly; Secure"],
  responseHeaders
});
assert.match(
  responseHeaders["set-cookie"],
  /^for_now_local_test_session=route-token; Path=\/now; HttpOnly; SameSite=Strict; Max-Age=1800$/
);
assert.doesNotMatch(responseHeaders["set-cookie"], /secret|Secure/);
const localRequest = request("for_now_local_test_session=route-token");
assert.equal(localHttp.authentication(localRequest).user.id, "owner");
assert.equal(localHttp.upstreamCookie(localRequest), "for_now_session=secret");

assert.equal(await localHttp.handle(
  request("", { method: "POST" }),
  {},
  new URL("http://local/api/auth/register")
), true);
assert.deepEqual(sent.pop(), {
  status: 403,
  body: { error: "本地测试版禁止修改线上账户", code: "LOCAL_TEST_READ_ONLY" }
});
assert.equal(proxyCalls, 0);
assert.equal(await localHttp.handle(
  request("", { method: "GET" }),
  {},
  new URL("http://local/api/auth/me")
), true);
assert.equal(proxyCalls, 1);

const logoutHeaders = {};
await localHttp.rewriteProxyResponse({
  request: localRequest,
  pathname: "/api/auth/logout",
  upstreamResponse: new Response("{}", { status: 200 }),
  cookies: [],
  responseHeaders: logoutHeaders
});
assert.match(logoutHeaders["set-cookie"], /Max-Age=0$/);
assert.equal(localHttp.authentication(localRequest).user, null);

console.log("Local test HTTP checks passed: bounded sessions, read-only pagination, failure mapping, cookie isolation and auth-route denial.");
