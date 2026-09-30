import assert from "node:assert/strict";
import { createApiClient } from "../public/frontend/api/index.mjs";
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
fetchHandler = async () => Response.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401, headers: { "x-request-id": "test-trace" } });
await assert.rejects(client.request("/api/state"), { status: 401, code: "AUTH_REQUIRED", requestId: "test-trace" });
assert.equal(locked, 1);
assert.equal((await client.request("/api/auth/me", {}, { allowUnauthorized: true })).code, "AUTH_REQUIRED");
assert.equal(locked, 1);
fetchHandler = async () => new Response("", { status: 404 });
assert.equal(await client.request("/api/local-test-mode", {}, { optional: true }), null);

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
await assert.rejects(client.request("/api/write", { method: "POST", body: "{}" }), /无法连接服务/);
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
const stop = subscribeState((next, domains, options) => updates.push({ next, domains: [...domains].sort(), options }));
const coordinator = createRefreshCoordinator({ session: sessionScope, requestState: () => { const entry = deferred(); inFlight.push(entry); return entry.promise; } });
const first = coordinator.refresh("captures"), second = coordinator.refresh("thoughts", { chainId: "root" });
inFlight[0].resolve({ captures: ["old"] });
assert.equal(await first, false);
inFlight[1].resolve({ captures: ["new"], thoughts: [] });
assert.equal(await second, true);
assert.deepEqual(updates[0].domains, ["captures", "thoughts"]);
assert.equal(updates[0].options.chainId, "root");
assert.deepEqual(state.captures, ["new"]);
const stale = coordinator.refresh("books");
rotateSession();
coordinator.reset();
resetState();
inFlight[2].resolve({ books: ["previous account"] });
assert.equal(await stale, false);
assert.deepEqual(state.books, []);
assert.equal(updates.length, 1);
stop();
console.log("Frontend contracts passed: base path, errors, optional endpoints, session cancellation, delayed body/blob rejection, SSE chunks/termination, refresh domain coalescing and account reset.");
