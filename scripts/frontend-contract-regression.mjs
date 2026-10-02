import assert from "node:assert/strict";
import { createApiClient } from "../public/frontend/api/index.mjs";
import { mergeBackgroundTaskResult } from "../public/frontend/features/index.mjs";
import { sessionScope, rotateSession } from "../public/frontend/session/index.mjs";
import { createRefreshCoordinator, subscribeState, resetState, state } from "../public/frontend/state/index.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let fetchHandler, locked = 0;
const client = createApiClient({
  baseUrl: "http://localhost/now/app.js", session: sessionScope,
  onAuthRequired: () => { locked += 1; },
  fetchImpl: (...args) => fetchHandler(...args)
});
fetchHandler = async (url, options) => {
  assert.equal(url, "/now/api/state");
  assert.equal(options.headers["content-type"], "application/json");
  assert.equal(options.signal.aborted, false);
  return Response.json({ captures: [] });
};
assert.deepEqual(await client.request("/api/state"), { captures: [] });
assert.equal(client.appUrl("/attachments/cover.png"), "/now/attachments/cover.png");
assert.equal(client.appUrl("https://example.com/x"), "https://example.com/x");
let nativeUrl = "";
const nativeClient = createApiClient({
  baseUrl: "capacitor://localhost/app.js",
  apiOrigin: "https://77liu.top/now/",
  session: sessionScope,
  fetchImpl: async url => {
    nativeUrl = url;
    return Response.json({ authenticated: false });
  }
});
assert.deepEqual(await nativeClient.request("/api/auth/me"), { authenticated: false });
assert.equal(nativeUrl, "https://77liu.top/now/api/auth/me");
assert.equal(nativeClient.appUrl("/attachments/cover.png"), "https://77liu.top/now/attachments/cover.png");
fetchHandler = async () => Response.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401, headers: { "x-request-id": "test-trace" } });
await assert.rejects(client.request("/api/state"), { status: 401, code: "AUTH_REQUIRED", requestId: "test-trace" });
assert.equal(locked, 1);
assert.equal((await client.request("/api/auth/me", {}, { allowUnauthorized: true })).code, "AUTH_REQUIRED");
assert.equal(locked, 1);
fetchHandler = async () => Response.json({ error: "账户权限已变更，请重新登录", code: "AUTH_REAUTH_REQUIRED" }, { status: 401 });
await assert.rejects(client.request("/api/state"), { status: 401, code: "AUTH_REAUTH_REQUIRED" });
assert.equal(locked, 2);
fetchHandler = async () => Response.json({ error: { message: "登录状态已失效", code: "AUTH_REQUIRED" } }, { status: 401 });
await assert.rejects(client.readBlob("/attachments/private.png"), { status: 401, code: "AUTH_REQUIRED", message: "登录状态已失效" });
assert.equal(locked, 3);
fetchHandler = async () => Response.json({
  error: { message: "资源版本已变化", code: "PRECONDITION_FAILED", details: { currentVersion: 3 } }
}, { status: 412 });
await assert.rejects(client.request("/api/v1/actions/action-1", { method: "PATCH", body: "{}" }), {
  status: 412,
  code: "PRECONDITION_FAILED",
  details: { currentVersion: 3 }
});
fetchHandler = async () => Response.json({
  error: { message: "请求过于频繁", code: "RATE_LIMITED" }
}, { status: 429, headers: { "retry-after": "4.5" } });
await assert.rejects(
  client.request("/api/v1/actions/action-1", { method: "PATCH", body: "{}" }),
  error => error.status === 429 && error.retryAfterMs === 4500
);
fetchHandler = async () => new Response("", { status: 404 });
assert.equal(await client.request("/api/local-test-mode", {}, { optional: true }), null);
fetchHandler = async (url, options) => {
  assert.equal(url, "/now/api/speech/synthesize");
  assert.equal(options.method, "POST");
  return new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { "content-type": "audio/mpeg" } });
};
assert.equal((await client.requestBlob("/api/speech/synthesize", { method: "POST", body: "{}" })).size, 3);

let foregroundAttempts = 0;
client.markForeground();
fetchHandler = async () => {
  foregroundAttempts += 1;
  if (foregroundAttempts === 1) throw new TypeError("Load failed");
  return Response.json({ resumed: true });
};
assert.deepEqual(await client.request("/api/state"), { resumed: true });
assert.equal(foregroundAttempts, 2);
foregroundAttempts = 0;
await assert.rejects(
  client.request("/api/write", { method: "POST", body: "{}" }),
  error => error.code === "NETWORK_ERROR" && error.status === 0 && /无法连接服务/.test(error.message)
);
assert.equal(foregroundAttempts, 1);

// A response whose transport ignores abort must still never reach the next account.
let pending = deferred();
fetchHandler = () => pending.promise;
let request = client.request("/api/state");
rotateSession();
pending.resolve(Response.json({ private: "previous account" }));
await assert.rejects(request, { name: "AbortError" });

// Validate the boundary after body decoding, not only after the headers arrive.
const body = deferred(), enteredBody = deferred();
fetchHandler = async () => ({ ok: true, json() { enteredBody.resolve(); return body.promise; } });
request = client.request("/api/state");
await enteredBody.promise;
rotateSession();
body.resolve({ private: "previous account" });
await assert.rejects(request, { name: "AbortError" });
pending = deferred();
fetchHandler = () => pending.promise;
request = client.readBlob("/attachments/private.png");
rotateSession();
pending.resolve(new Response("private"));
await assert.rejects(request, { name: "AbortError" });

const streamResponse = chunks => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); }
}), { headers: { "content-type": "text/event-stream" } });
fetchHandler = async () => streamResponse(['data: {"type":"reasoning","delta":"思考"}\r', '\n\r\ndata: {"type":"done","result":{"content":"回答"}}\n\n']);
const events = [];
assert.deepEqual(await client.requestStream("/api/draft", {}, event => events.push(event)), { content: "回答" });
assert.deepEqual(events.map(event => event.type), ["reasoning", "done"]);
fetchHandler = async () => streamResponse(['data: {"type":"reasoning","delta":"思考"}\n\n']);
await assert.rejects(client.requestStream("/api/draft"), /回答流意外中断/);
fetchHandler = async () => streamResponse(['data: {"type":"reasoning","delta":"思考"}\n\ndata: {"type":"done","result":{}}\n\n']);
await assert.rejects(client.requestStream("/api/draft", {}, () => rotateSession()), { name: "AbortError" });

resetState();
const inFlight = [], updates = [];
let overlayRestores = 0;
const stop = subscribeState((next, domains, options) => updates.push({ next, domains: [...domains].sort(), options }));
const coordinator = createRefreshCoordinator({
  session: sessionScope,
  requestState: () => {
    const entry = deferred();
    inFlight.push(entry);
    return entry.promise;
  },
  afterReplace: async () => {
    overlayRestores += 1;
    state.captures.push("pending");
  }
});
const first = coordinator.refresh("captures"), second = coordinator.refresh("thoughts", { chainId: "root" });
inFlight[0].resolve({ captures: ["old"] });
assert.equal(await first, false);
inFlight[1].resolve({ captures: ["new"], thoughts: [] });
assert.equal(await second, true);
assert.deepEqual(updates[0].domains, ["captures", "thoughts"]);
assert.equal(updates[0].options.chainId, "root");
assert.deepEqual(state.captures, ["new", "pending"]);
assert.equal(overlayRestores, 1);
const stale = coordinator.refresh("books");
rotateSession();
coordinator.reset();
resetState();
inFlight[2].resolve({ books: ["previous account"] });
assert.equal(await stale, false);
assert.deepEqual(state.books, []);
assert.equal(updates.length, 1);
assert.equal(overlayRestores, 1);
stop();

const transcriptionTask = {
  id: "task-audio-old",
  kind: "captureTranscription",
  targetId: "capture-audio",
  resultId: "capture-audio",
  status: "succeeded"
};
const currentAudioSnapshot = {
  captures: [{
    id: "capture-audio",
    audio: { attachmentPath: "/attachments/new.m4a" },
    transcription: { status: "queued" },
    version: 2
  }]
};
const staleTranscription = mergeBackgroundTaskResult(currentAudioSnapshot, transcriptionTask, {
  id: "capture-audio",
  audio: { attachmentPath: "/attachments/old.m4a" },
  transcription: { status: "ready", rawText: "旧原音的迟到结果" },
  version: 2
});
assert.equal(staleTranscription.changed, false);
assert.equal(staleTranscription.value.captures[0].transcription.status, "queued");
const currentTranscription = mergeBackgroundTaskResult(currentAudioSnapshot, transcriptionTask, {
  id: "capture-audio",
  audio: { attachmentPath: "/attachments/new.m4a" },
  transcription: { status: "ready", rawText: "当前原音结果" },
  version: 3
});
assert.equal(currentTranscription.changed, true);
assert.equal(currentTranscription.value.captures[0].transcription.rawText, "当前原音结果");

console.log("Frontend contracts passed: base path, errors, optional endpoints, session cancellation, delayed body/blob rejection, SSE chunks/termination, refresh domain coalescing and account reset.");
