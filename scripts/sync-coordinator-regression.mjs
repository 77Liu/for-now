import assert from "node:assert/strict";
import {
  createIncrementalSync,
  createIndexedDbSyncStore,
  createMemorySyncStore,
  createRequestCoordinator,
  SYNC_RETRY_MAX_ATTEMPTS,
  syncOperationFingerprint
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

const volatileStore = createIndexedDbSyncStore({ indexedDBImpl: null });
assert.equal(volatileStore.durable, false);
await volatileStore.put({ id: "volatile", owner: "account-a", status: "pending" });
assert.equal((await volatileStore.list("account-a")).length, 1);

const store = createMemorySyncStore();
const sent = [];
const gates = [];
const transitions = [];
const coordinatorEvents = [];
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
coordinator.subscribe(record => coordinatorEvents.push(record));

const first = coordinator.request({
  owner: "account-a",
  url: "/api/v1/captures",
  options: { method: "POST", body: JSON.stringify({ content: "first" }) },
  domains: ["captures"],
  projection: { kind: "capture.create", temporaryId: "pending:operation-1" },
  onQueued: async record => {
    transitions.push({
      status: record.status,
      durable: Boolean(await store.get(record.owner, record.id))
    });
  }
});
await new Promise(resolve => setTimeout(resolve, 20));
const pending = await store.list("account-a", ["pending", "sending"]);
assert.equal(pending.length, 1);
assert.equal(sent.length, 1);
assert.equal(pending[0].body, JSON.stringify({ content: "first" }));
assert.equal(sent[0].options.headers["x-client-operation-id"], "operation-1");
assert.equal(sent[0].options.headers["idempotency-key"], "operation-1");
assert.match(sent[0].options.headers["x-client-operation-fingerprint"], /^[a-f0-9]{64}$/);
assert.deepEqual(transitions, [{ status: "pending", durable: true }]);

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
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, 2, "same resource must wait while another resource can start");
assert.equal(sent[1].url, "/api/v1/feedback");
assert.equal(sent[1].options.headers["idempotency-key"], "feedback-stable");
assert.equal(sent[1].options.headers["x-client-operation-id"], "feedback-stable");
const resumedWhileSending = coordinator.resume("account-a");
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, 2, "resume must not schedule an operation that is already in flight");

gates[0].resolve({ data: { id: "capture-1" }, meta: { operation: { id: "operation-1", status: "committed" } } });
assert.deepEqual(await first, {
  data: { id: "capture-1" },
  meta: { operation: { id: "operation-1", status: "committed" } }
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(sent.length, 3);
assert.equal(sent[2].options.headers["x-client-operation-id"], "operation-2");
gates[1].resolve({ data: { id: "feedback-1" }, meta: {} });
gates[2].resolve({ data: { id: "capture-2" }, meta: {} });
await Promise.all([second, otherResource]);
assert.equal((await resumedWhileSending).every(result => result.status === "fulfilled"), true);

const committed = await store.list("account-a", ["committed"]);
assert.equal(committed.length, 3);
assert.equal(committed.every(item => !Object.hasOwn(item, "body")), true);
assert.equal(committed.every(item => !Object.hasOwn(item, "projection")), true);
assert.deepEqual(committed.find(item => item.operationId === "operation-1").domains, ["captures"]);
assert.deepEqual(committed.find(item => item.operationId === "operation-1").ack, {
  id: "operation-1",
  status: "committed"
});

const metricStore = createMemorySyncStore([
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `committed-${index + 1}`,
    owner: "account-a",
    status: "committed",
    enqueueToAckMs: (index + 1) * 10,
    committedAt: `2026-10-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`
  })),
  { id: "pending-old", owner: "account-a", status: "pending", createdAt: "2026-10-01T00:00:01.000Z" },
  { id: "pending-new", owner: "account-a", status: "sending", createdAt: "2026-10-01T00:00:02.000Z" },
  { id: "conflict", owner: "account-a", status: "conflict" },
  { id: "failed", owner: "account-a", status: "failed" }
]);
const metricCoordinator = createRequestCoordinator({
  store: metricStore,
  send: async () => ({ data: null })
});
assert.deepEqual(await metricCoordinator.metrics("account-a"), {
  durable: false,
  pending: 2,
  conflicts: 1,
  failed: 1,
  oldestPendingAt: "2026-10-01T00:00:01.000Z",
  enqueueToAckP95Ms: 190
});

const retentionStore = createMemorySyncStore([
  ...Array.from({ length: 205 }, (_, index) => ({
    id: `retained-commit-${index}`,
    owner: "account-a",
    status: "committed",
    committedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
  })),
  ...Array.from({ length: 55 }, (_, index) => ({
    id: `retained-terminal-${index}`,
    owner: "account-a",
    status: index % 2 ? "failed" : "conflict",
    updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString()
  }))
]);
const retentionCoordinator = createRequestCoordinator({
  store: retentionStore,
  send: async () => ({ data: null })
});
assert.equal(await retentionCoordinator.prune("account-a"), 10);
assert.equal((await retentionStore.list("account-a", ["committed"])).length, 200);
assert.equal((await retentionStore.list("account-a", ["conflict", "failed"])).length, 50);

const collisionStore = createMemorySyncStore();
const collisionCoordinator = createRequestCoordinator({
  store: collisionStore,
  send: async () => {
    throw Object.assign(new Error("offline"), { status: 503 });
  }
});
await Promise.allSettled([
  collisionCoordinator.request({
    owner: "account-a",
    url: "/api/v1/captures",
    options: { method: "POST", headers: { "idempotency-key": "shared-key" }, body: "{}" }
  }),
  collisionCoordinator.request({
    owner: "account-a",
    url: "/api/v1/quotes",
    options: { method: "POST", headers: { "idempotency-key": "shared-key" }, body: "{}" }
  })
]);
const collided = await collisionStore.list("account-a", ["pending"]);
assert.equal(collided.length, 2, "same idempotency key in different resources must keep two queue records");
assert.equal(new Set(collided.map(item => item.id)).size, 2);
assert.deepEqual(new Set(collided.map(item => item.operationId)), new Set(["shared-key"]));

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
let retryableError;
try {
  await recovery.request({
    owner: "account-a",
    url: "/api/v1/checkins",
    options: { method: "POST", body: "{}" }
  });
} catch (error) {
  retryableError = error;
}
assert.ok(retryableError);
assert.match(retryableError.message, /Load failed/);
assert.equal(retryableError.syncStatus, "pending");
assert.equal((await recoveryStore.list("account-a", ["pending"])).length, 1);
mode = "success";
const resumed = await recovery.resume("account-a", { force: true });
assert.equal(resumed.length, 1);
assert.equal(resumed[0].status, "fulfilled");
assert.equal(recoveryCalls[1].options.headers["x-client-operation-id"], "recoverable-operation");

const legacyRecords = [
  {
    id: "legacy-analysis-missing",
    owner: "account-a",
    operationId: "legacy-analysis-missing",
    resourceKey: "/api/v1/analyses",
    method: "POST",
    url: "/api/v1/analyses",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "legacy-analysis-idempotency",
      "x-client-operation-id": "legacy-analysis-missing"
    },
    body: "{}",
    status: "pending",
    attempts: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  },
  {
    id: "legacy-analysis-bad",
    owner: "account-a",
    operationId: "legacy-analysis-bad",
    fingerprint: "0".repeat(64),
    resourceKey: "/api/v1/analyses",
    method: "POST",
    url: "/api/v1/analyses",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "legacy-analysis-bad-idempotency",
      "x-client-operation-id": "legacy-analysis-bad",
      "x-client-operation-fingerprint": "0".repeat(64)
    },
    body: "{}",
    status: "pending",
    attempts: 0,
    createdAt: "2026-10-01T00:00:01.000Z",
    updatedAt: "2026-10-01T00:00:01.000Z"
  }
];
const legacyStore = createMemorySyncStore(legacyRecords);
const legacySends = [];
const legacyCoordinator = createRequestCoordinator({
  store: legacyStore,
  send: async (url, options) => {
    const operationId = options.headers["x-client-operation-id"];
    const persisted = await legacyStore.get("account-a", operationId);
    legacySends.push({ url, options });
    assert.equal(persisted.fingerprint, options.headers["x-client-operation-fingerprint"]);
    assert.equal(persisted.headers["x-client-operation-fingerprint"], persisted.fingerprint);
    return { data: { id: operationId }, meta: { operation: { id: operationId, status: "committed" } } };
  }
});
const resumedLegacy = await legacyCoordinator.resume("account-a", { force: true });
assert.equal(resumedLegacy.length, 2);
assert.equal(resumedLegacy.every(result => result.status === "fulfilled"), true);
assert.deepEqual(
  legacySends.map(call => call.options.headers["idempotency-key"]),
  ["legacy-analysis-idempotency", "legacy-analysis-bad-idempotency"]
);
for (const call of legacySends) {
  const expected = await syncOperationFingerprint({
    method: call.options.method,
    url: call.url,
    headers: call.options.headers,
    body: call.options.body
  });
  assert.equal(call.options.headers["x-client-operation-fingerprint"], expected);
}

const normalizedRetryStore = createMemorySyncStore();
const normalizedRetryCalls = [];
const normalizedRetry = createRequestCoordinator({
  store: normalizedRetryStore,
  createId: () => "normalize-once",
  send: async (url, options) => {
    normalizedRetryCalls.push({ url, options: structuredClone(options) });
    if (normalizedRetryCalls.length === 1) {
      throw Object.assign(new Error("fingerprint mismatch"), {
        status: 400,
        code: "INVALID_OPERATION_FINGERPRINT",
        details: { reason: "canonical-mismatch" }
      });
    }
    return { data: { id: "analysis-1" }, meta: { operation: { id: "normalize-once", status: "committed" } } };
  }
});
await normalizedRetry.request({
  owner: "account-a",
  url: "/api/v1/analyses",
  options: {
    method: "POST",
    headers: { "idempotency-key": "analysis-stable-key" },
    body: "{}"
  }
});
assert.equal(normalizedRetryCalls.length, 2);
assert.equal(normalizedRetryCalls[0].options.headers["idempotency-key"], "analysis-stable-key");
assert.equal(normalizedRetryCalls[1].options.headers["idempotency-key"], "analysis-stable-key");
assert.equal((await normalizedRetryStore.list("account-a", ["committed"])).length, 1);

let boundedFingerprintCalls = 0;
const boundedFingerprintStore = createMemorySyncStore();
const boundedFingerprint = createRequestCoordinator({
  store: boundedFingerprintStore,
  createId: () => "normalize-bounded",
  send: async () => {
    boundedFingerprintCalls += 1;
    throw Object.assign(new Error("fingerprint mismatch"), {
      status: 400,
      code: "INVALID_OPERATION_FINGERPRINT",
      details: { reason: "canonical-mismatch" }
    });
  }
});
await assert.rejects(boundedFingerprint.request({
  owner: "account-a",
  url: "/api/v1/analyses",
  options: { method: "POST", headers: { "idempotency-key": "bounded-stable-key" }, body: "{}" }
}), error => error.syncStatus === "failed");
assert.equal(boundedFingerprintCalls, 2, "fingerprint normalization must retry at most once");
assert.equal((await boundedFingerprintStore.list("account-a", ["failed"]))[0].fingerprintRetryCount, 1);

const receiptStore = createMemorySyncStore();
let mutationAttempts = 0, receiptLookups = 0;
const receiptCoordinator = createRequestCoordinator({
  store: receiptStore,
  createId: () => "receipt-operation",
  send: async url => {
    if (url.startsWith("/api/v1/sync/operations/")) {
      receiptLookups += 1;
      return { data: { operationId: "receipt-operation", status: "committed", responseAvailable: false } };
    }
    mutationAttempts += 1;
    throw new TypeError("response lost after commit");
  }
});
const recoveredCommit = await receiptCoordinator.request({
  owner: "account-a",
  url: "/api/v1/checkins/checkin-1",
  options: { method: "PATCH", headers: { "if-match": "\"1\"" }, body: JSON.stringify({ mood: 4 }) },
  domains: ["checkins"],
  recoverCommitted: true
});
assert.equal(recoveredCommit.data, null);
assert.equal(recoveredCommit.meta.operation.recovered, true);
assert.equal(mutationAttempts, 1);
assert.equal(receiptLookups, 1);
assert.equal((await receiptStore.list("account-a", ["committed"])).length, 1);

const trueConflictStore = createMemorySyncStore();
const trueConflict = createRequestCoordinator({
  store: trueConflictStore,
  createId: () => "true-conflict",
  send: async url => {
    if (url.startsWith("/api/v1/sync/operations/")) return { data: { operationId: "true-conflict", status: "unknown" } };
    throw Object.assign(new Error("stale version"), { status: 412 });
  }
});
await assert.rejects(trueConflict.request({
  owner: "account-a",
  url: "/api/v1/checkins/checkin-1",
  options: { method: "PATCH", headers: { "if-match": "\"1\"" }, body: JSON.stringify({ mood: 4 }) },
  domains: ["checkins"],
  recoverCommitted: true
}), error => error.syncStatus === "conflict");

for (const [status, expected] of [
  [408, "pending"],
  [425, "pending"],
  [429, "pending"],
  [500, "pending"],
  [502, "pending"],
  [503, "pending"],
  [599, "pending"],
  [409, "conflict"],
  [412, "conflict"],
  [400, "failed"],
  [401, "failed"],
  [403, "failed"],
  [422, "failed"]
]) {
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
  const [classifiedRecord] = await classifiedStore.list("account-a", [expected]);
  assert.ok(classifiedRecord);
  if (expected === "pending") {
    assert.ok(Date.parse(classifiedRecord.nextAttemptAt) > Date.parse(classifiedRecord.createdAt));
  } else {
    assert.equal(classifiedRecord.nextAttemptAt, null);
  }
}

const retryAfterStore = createMemorySyncStore();
const retryAfterNow = "2026-10-01T00:00:00.000Z";
const retryAfterCoordinator = createRequestCoordinator({
  store: retryAfterStore,
  now: () => retryAfterNow,
  createId: () => "retry-after",
  send: async () => {
    throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 4500 });
  }
});
await assert.rejects(retryAfterCoordinator.request({
  owner: "account-a",
  url: "/api/v1/captures",
  options: { method: "POST", body: "{}" }
}));
const retryAfterRecord = (await retryAfterStore.list("account-a", ["pending"]))[0];
assert.equal(retryAfterRecord.nextAttemptAt, "2026-10-01T00:00:04.500Z");
assert.equal((await retryAfterCoordinator.resume("account-a")).length, 0, "backoff must skip operations before nextAttemptAt");

const exhaustedStore = createMemorySyncStore();
const exhaustedCoordinator = createRequestCoordinator({
  store: exhaustedStore,
  createId: () => "exhausted",
  send: async () => {
    throw Object.assign(new Error("upstream unavailable"), { status: 503 });
  }
});
await assert.rejects(exhaustedCoordinator.request({
  owner: "account-a",
  url: "/api/v1/captures",
  options: { method: "POST", body: "{}" }
}));
for (let attempt = 1; attempt < SYNC_RETRY_MAX_ATTEMPTS; attempt += 1) {
  const results = await exhaustedCoordinator.resume("account-a", { force: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "rejected");
}
const exhaustedRecord = (await exhaustedStore.list("account-a", ["failed"]))[0];
assert.equal(exhaustedRecord.attempts, SYNC_RETRY_MAX_ATTEMPTS);
assert.equal(exhaustedRecord.lastError.retryExhausted, true);
assert.equal((await exhaustedCoordinator.resume("account-a", { force: true })).length, 0);

const isolatedStore = createMemorySyncStore();
await isolatedStore.put({ id: "a", owner: "account-a", status: "pending", body: "private-a" });
await isolatedStore.put({ id: "b", owner: "account-b", status: "pending", body: "private-b" });
assert.deepEqual((await isolatedStore.list("account-a")).map(item => item.id), ["a"]);
await isolatedStore.clear("account-a");
assert.equal((await isolatedStore.list("account-a")).length, 0);
assert.deepEqual((await isolatedStore.list("account-b")).map(item => item.id), ["b"]);

assert.ok(coordinatorEvents.some(item => item.status === "pending"));
assert.ok(coordinatorEvents.some(item => item.status === "committed"));

const cursorStorage = new Map();
const storage = {
  getItem: key => cursorStorage.has(key) ? cursorStorage.get(key) : null,
  setItem: (key, value) => cursorStorage.set(key, value)
};
const channelListeners = new Set();
const channelMessages = [];
const channel = {
  publish(message) { channelMessages.push(structuredClone(message)); },
  subscribe(listener) { channelListeners.add(listener); return () => channelListeners.delete(listener); },
  emit(message) { for (const listener of channelListeners) listener(structuredClone(message)); }
};
const eventTarget = {
  listeners: new Map(),
  addEventListener(name, listener) { this.listeners.set(name, listener); },
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
};
const documentTarget = { ...eventTarget, listeners: new Map(), visibilityState: "visible" };
const requests = [];
const snapshots = [];
let currentCursor = 2;
const incrementalCoordinator = {
  async resume() { return []; },
  subscribe(listener) {
    this.listener = listener;
    return () => { this.listener = null; };
  }
};
const incremental = createIncrementalSync({
  coordinator: incrementalCoordinator,
  storage,
  channel,
  locks: null,
  windowTarget: eventTarget,
  documentTarget,
  setTimer: () => 1,
  clearTimer: () => {},
  request: async url => {
    requests.push(url);
    const parsed = new URL(url, "https://local.invalid");
    const after = parsed.searchParams.has("cursor") ? Number(parsed.searchParams.get("cursor")) : null;
    if (after == null) return { data: { cursor: currentCursor, changes: [], snapshot: {} } };
    if (after < currentCursor) {
      return {
        data: {
          cursor: currentCursor,
          changes: [{ cursor: currentCursor, domain: "captures", resourceId: "capture-remote", changeType: "create" }],
          snapshot: { captures: [{ id: "capture-remote" }] }
        }
      };
    }
    return { data: { cursor: currentCursor, changes: [], snapshot: {} } };
  },
  applySnapshot: async (snapshot, changes) => snapshots.push({ snapshot, changes })
});
await incremental.start("account-a");
assert.match(requests[0], /waitMs=0/);
assert.doesNotMatch(requests[0], /cursor=/);
assert.equal(incremental.cursor(), 2);
currentCursor = 3;
channel.emit({ type: "committed", owner: "account-a", operationId: "remote-operation" });
await flush();
await flush();
assert.equal(incremental.cursor(), 3);
assert.equal(snapshots.length, 1);
assert.deepEqual(snapshots[0].snapshot.captures, [{ id: "capture-remote" }]);
incrementalCoordinator.listener({
  owner: "account-a",
  operationId: "local-operation",
  status: "committed",
  domains: ["captures"]
});
assert.equal(channelMessages.at(-1).operationId, "local-operation");
incremental.stop();

const staleAccountResponse = deferred();
const switchedSnapshots = [];
const switchedCursorStorage = new Map();
let switchedRequests = 0;
const switching = createIncrementalSync({
  coordinator: {
    async resume() { return []; },
    subscribe() { return () => {}; }
  },
  storage: {
    getItem: key => switchedCursorStorage.get(key) ?? null,
    setItem: (key, value) => switchedCursorStorage.set(key, value)
  },
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: null,
  documentTarget: null,
  setTimer: () => 1,
  clearTimer: () => {},
  request: async () => {
    switchedRequests += 1;
    if (switchedRequests === 1) return staleAccountResponse.promise;
    return { data: { cursor: 7, changes: [], snapshot: {} } };
  },
  applySnapshot: async snapshot => switchedSnapshots.push(snapshot)
});
const accountAStart = switching.start("account-a");
await flush();
const accountBStart = switching.start("account-b");
assert.equal(await accountBStart, true);
staleAccountResponse.resolve({
  data: {
    cursor: 9,
    changes: [{ cursor: 9, domain: "captures", resourceId: "private-a", changeType: "create" }],
    snapshot: { captures: [{ id: "private-a" }] }
  }
});
assert.equal(await accountAStart, false);
assert.deepEqual(switchedSnapshots, []);
assert.equal(switchedCursorStorage.has("cike-sync-cursor:account-a"), false);
assert.equal(switchedCursorStorage.get("cike-sync-cursor:account-b"), "7");
switching.stop();

const fallbackTarget = {
  listeners: new Map(),
  addEventListener(name, listener) { this.listeners.set(name, listener); },
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
};
let fallbackResumes = 0;
let fallbackRequests = 0;
let fallbackResnapshots = 0;
const fallbackStatuses = [];
const fallback = createIncrementalSync({
  coordinator: {
    async resume() {
      fallbackResumes += 1;
      return [{ status: "fulfilled", value: { data: { id: "saved" } } }];
    },
    subscribe() { return () => {}; },
    async prune() {}
  },
  storage: null,
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: fallbackTarget,
  documentTarget: null,
  setTimer: () => {
    throw new Error("disabled incremental sync must not schedule polling");
  },
  clearTimer: () => {},
  request: async () => {
    fallbackRequests += 1;
    return { data: { cursor: 1, changes: [], snapshot: {} } };
  },
  applySnapshot: async () => {},
  resnapshot: async () => {
    fallbackResnapshots += 1;
  },
  onStatus: event => fallbackStatuses.push(event.type)
});
assert.equal(await fallback.start("account-a", { incremental: false }), true);
assert.equal(fallbackRequests, 0);
assert.equal(fallbackResumes, 1);
assert.equal(fallbackResnapshots, 1);
assert.equal(fallbackStatuses.at(-1), "disabled");
fallbackTarget.listeners.get("online")();
await flush();
assert.equal(fallbackResumes, 2);
assert.equal(fallbackResnapshots, 2);
fallback.stop();

const grayCursorStorage = new Map([["cike-sync-cursor:account-a", "4"]]);
const grayRequests = [];
let grayResnapshots = 0;
let grayResumes = 0;
const gray = createIncrementalSync({
  coordinator: {
    async resume() {
      grayResumes += 1;
      return grayResumes === 1 ? [{ status: "fulfilled", value: { data: { id: "saved-while-disabled" } } }] : [];
    },
    subscribe() { return () => {}; },
    async prune() {}
  },
  storage: {
    getItem: key => grayCursorStorage.get(key) ?? null,
    setItem: (key, value) => grayCursorStorage.set(key, value)
  },
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: null,
  documentTarget: null,
  setTimer: () => 1,
  clearTimer: () => {},
  request: async url => {
    grayRequests.push(url);
    return { data: { cursor: 5, changes: [], snapshot: {} } };
  },
  applySnapshot: async () => {},
  resnapshot: async () => { grayResnapshots += 1; }
});
assert.equal(await gray.start("account-a", { incremental: false }), true);
assert.equal(grayRequests.length, 0);
assert.equal(grayResnapshots, 1);
assert.equal(grayCursorStorage.get("cike-sync-cursor:account-a"), "4");
gray.stop();
assert.equal(await gray.start("account-a", { incremental: true }), true);
assert.match(grayRequests[0], /cursor=4/);
assert.equal(grayCursorStorage.get("cike-sync-cursor:account-a"), "5");
gray.stop();

let terminalFailureResnapshots = 0;
const terminalFailureSync = createIncrementalSync({
  coordinator: {
    async resume() {
      return [{ status: "rejected", reason: Object.assign(new Error("invalid"), { syncStatus: "failed" }) }];
    },
    subscribe() { return () => {}; },
    async prune() {}
  },
  storage: null,
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: null,
  documentTarget: null,
  setTimer: () => { throw new Error("disabled incremental sync must not schedule polling"); },
  clearTimer: () => {},
  request: async () => { throw new Error("disabled incremental sync must not pull"); },
  applySnapshot: async () => {},
  resnapshot: async () => { terminalFailureResnapshots += 1; }
});
assert.equal(await terminalFailureSync.start("account-a", { incremental: false }), true);
assert.equal(terminalFailureResnapshots, 1);
terminalFailureSync.stop();

let cursorRecoveryRequests = 0;
let cursorResnapshots = 0;
const recoveredCursorStorage = new Map([["cike-sync-cursor:account-a", "1"]]);
const cursorRecovery = createIncrementalSync({
  coordinator: {
    async resume() { return []; },
    subscribe() { return () => {}; }
  },
  storage: {
    getItem: key => recoveredCursorStorage.get(key) ?? null,
    setItem: (key, value) => recoveredCursorStorage.set(key, value)
  },
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: null,
  documentTarget: null,
  setTimer: () => 1,
  clearTimer: () => {},
  request: async () => {
    cursorRecoveryRequests += 1;
    if (cursorRecoveryRequests === 1) {
      throw Object.assign(new Error("expired"), {
        code: "SYNC_CURSOR_EXPIRED",
        details: { currentCursor: 12 }
      });
    }
    return { data: { cursor: 12, changes: [], snapshot: {} } };
  },
  applySnapshot: async () => {},
  resnapshot: async () => {
    cursorResnapshots += 1;
  }
});
assert.equal(await cursorRecovery.start("account-a"), true);
assert.equal(cursorResnapshots, 1);
assert.equal(recoveredCursorStorage.get("cike-sync-cursor:account-a"), "12");
cursorRecovery.stop();

let retryTimer = null;
let retryResumes = 0;
let retryPulls = 0;
const retrying = createIncrementalSync({
  coordinator: {
    async resume() {
      retryResumes += 1;
      return [];
    },
    subscribe() { return () => {}; }
  },
  storage: null,
  channel: { publish() {}, subscribe() { return () => {}; } },
  locks: null,
  windowTarget: null,
  documentTarget: null,
  setTimer: callback => {
    retryTimer = callback;
    return 1;
  },
  clearTimer: () => {},
  request: async () => {
    retryPulls += 1;
    if (retryPulls === 1) throw Object.assign(new Error("temporary failure"), { status: 503 });
    return { data: { cursor: 1, changes: [], snapshot: {} } };
  },
  applySnapshot: async () => {}
});
await assert.rejects(retrying.start("account-a"), /temporary failure/);
assert.equal(typeof retryTimer, "function", "initial pull failure must still schedule recovery");
await retryTimer();
assert.equal(retryResumes, 1, "scheduled recovery must retry pending writes before pulling");
assert.equal(retryPulls, 2);
retrying.stop();

console.log("Sync coordinator contracts passed: durable-first writes, stable keys, resource serialization, parallel resources, deterministic health metrics, recovery resnapshots, disabled-to-enabled gray recovery, stale-session rejection, cross-tab invalidation, incremental cursors, retry/failure classification, audit minimization and account isolation.");
