import assert from "node:assert/strict";
import {
  createMemorySyncStore,
  createRequestCoordinator
} from "../public/frontend/sync/index.mjs";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

const store = createMemorySyncStore();
const sent = [];
const gates = [];
const coordinator = createRequestCoordinator({
  store,
  createId: (() => {
    let serial = 0;
    return () => `operation-${++serial}`;
  })(),
  send: async (url, options) => {
    sent.push({ url, options });
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  }
});

const first = coordinator.request({
  owner: "account-a",
  url: "/api/v1/captures",
  options: { method: "POST", body: JSON.stringify({ content: "first" }) }
});
await flush();
const pending = await store.list("account-a", ["pending", "sending"]);
assert.equal(pending.length, 1);
assert.equal(sent.length, 1);
assert.equal(pending[0].body, JSON.stringify({ content: "first" }));
assert.equal(sent[0].options.headers["x-client-operation-id"], "operation-1");
assert.equal(sent[0].options.headers["idempotency-key"], "operation-1");

const second = coordinator.request({
  owner: "account-a",
  url: "/api/v1/captures",
  options: { method: "POST", body: JSON.stringify({ content: "second" }) }
});
const otherResource = coordinator.request({
  owner: "account-a",
  url: "/api/v1/feedback",
  options: { method: "POST", headers: { "Idempotency-Key": "feedback-stable" }, body: "{}" }
});
await flush();
assert.equal(sent.length, 2, "same resource must wait while another resource can start");
assert.equal(sent[1].url, "/api/v1/feedback");
assert.equal(sent[1].options.headers["idempotency-key"], "feedback-stable");
assert.equal(sent[1].options.headers["x-client-operation-id"], "feedback-stable");

gates[0].resolve({ data: { id: "capture-1" }, meta: { operation: { id: "operation-1", status: "committed" } } });
assert.deepEqual(await first, {
  data: { id: "capture-1" },
  meta: { operation: { id: "operation-1", status: "committed" } }
});
await flush();
assert.equal(sent.length, 3);
assert.equal(sent[2].options.headers["x-client-operation-id"], "operation-2");
gates[1].resolve({ data: { id: "feedback-1" }, meta: {} });
gates[2].resolve({ data: { id: "capture-2" }, meta: {} });
await Promise.all([second, otherResource]);

const committed = await store.list("account-a", ["committed"]);
assert.equal(committed.length, 3);
assert.equal(committed.every(item => !Object.hasOwn(item, "body")), true);
assert.deepEqual(committed.find(item => item.id === "operation-1").ack, {
  id: "operation-1",
  status: "committed"
});

let mode = "network";
const recoveryStore = createMemorySyncStore();
const recoveryCalls = [];
const recovery = createRequestCoordinator({
  store: recoveryStore,
  createId: () => "recoverable-operation",
  send: async (url, options) => {
    recoveryCalls.push({ url, options });
    if (mode === "network") throw new TypeError("Load failed");
    return { data: { saved: true }, meta: { operation: { id: "recoverable-operation", status: "committed" } } };
  }
});
await assert.rejects(recovery.request({
  owner: "account-a",
  url: "/api/v1/checkins",
  options: { method: "POST", body: "{}" }
}), /Load failed/);
assert.equal((await recoveryStore.list("account-a", ["pending"])).length, 1);
mode = "success";
const resumed = await recovery.resume("account-a");
assert.equal(resumed.length, 1);
assert.equal(resumed[0].status, "fulfilled");
assert.equal(recoveryCalls[1].options.headers["x-client-operation-id"], "recoverable-operation");

for (const status of [409, 412, 400]) {
  const classifiedStore = createMemorySyncStore();
  const classified = createRequestCoordinator({
    store: classifiedStore,
    createId: () => `classified-${status}`,
    send: async () => {
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    }
  });
  await assert.rejects(classified.request({
    owner: "account-a",
    url: `/api/v1/resources/${status}`,
    options: { method: "PATCH", body: "{}" }
  }));
  const expected = status === 409 || status === 412 ? "conflict" : "failed";
  assert.equal((await classifiedStore.list("account-a", [expected])).length, 1);
}

const isolatedStore = createMemorySyncStore();
await isolatedStore.put({ id: "a", owner: "account-a", status: "pending", body: "private-a" });
await isolatedStore.put({ id: "b", owner: "account-b", status: "pending", body: "private-b" });
assert.deepEqual((await isolatedStore.list("account-a")).map(item => item.id), ["a"]);
await isolatedStore.clear("account-a");
assert.equal((await isolatedStore.list("account-a")).length, 0);
assert.deepEqual((await isolatedStore.list("account-b")).map(item => item.id), ["b"]);

console.log("Sync coordinator contracts passed: durable-first writes, stable keys, resource serialization, parallel resources, recovery, failure classification, audit minimization and account isolation.");
