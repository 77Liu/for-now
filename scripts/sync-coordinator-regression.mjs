import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { createAccountCommitNotifier } from "../src/shared/concurrency/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import assert from "node:assert/strict";
import { createSyncHttp, createJsonHttp, createApiV1Http } from "../src/http/index.mjs";
import { createEmptyStore, createPublicStateProjection, withoutReferenceOwnerMetadata } from "../src/app/index.mjs";
import {
  createIncrementalSync,
  createRecordSyncLoop,
  createIndexedDbSyncStore,
  createMemorySyncStore,
  createRequestCoordinator,
  SYNC_RETRY_MAX_ATTEMPTS,
  syncOperationFingerprint
} from "../public/frontend/sync/index.mjs";
import { createDataSyncRuntime } from "../public/generated/app/runtime/data-sync-runtime.mjs";

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
const incrementalTimers = [];
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
  setTimer: callback => {
    incrementalTimers.push(callback);
    return incrementalTimers.length;
  },
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
const startupRequestCount = requests.length;
assert.equal(requests.every(url => new URL(url, "https://local.invalid").searchParams.get("waitMs") === "0"), true);
await incrementalTimers.shift()();
const scheduledPoll = new URL(requests[startupRequestCount], "https://local.invalid");
assert.ok(Number(scheduledPoll.searchParams.get("waitMs")) > 0, "scheduled incremental polling must use long polling");
assert.equal(scheduledPoll.searchParams.get("cursor"), "2");
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

const queuedLongPoll = deferred();
const queuedPullRequests = [];
const queuedSnapshots = [];
const queuedSignals = [];
const queuedChannelListeners = new Set();
const queuedDocumentTarget = { ...eventTarget, listeners: new Map(), visibilityState: "visible" };
let queuedPollTimer = null;
let queuedCurrentCursor = 1;
const queuedImmediatePull = createIncrementalSync({
  coordinator: {
    async resume() { return []; },
    subscribe() { return () => {}; },
    async prune() {}
  },
  storage: null,
  channel: {
    publish() {},
    subscribe(listener) {
      queuedChannelListeners.add(listener);
      return () => queuedChannelListeners.delete(listener);
    },
    emit(message) {
      for (const listener of queuedChannelListeners) listener(structuredClone(message));
    }
  },
  locks: null,
  windowTarget: null,
  documentTarget: queuedDocumentTarget,
  setTimer: callback => {
    queuedPollTimer = callback;
    return 1;
  },
  clearTimer: () => {},
  request: async (url, options) => {
    queuedSignals.push(options.signal);
    queuedPullRequests.push(url);
    const parsed = new URL(url, "https://local.invalid");
    if (Number(parsed.searchParams.get("waitMs")) > 0) return queuedLongPoll.promise;
    const after = parsed.searchParams.has("cursor") ? Number(parsed.searchParams.get("cursor")) : null;
    return {
      data: {
        cursor: queuedCurrentCursor,
        changes: after != null && after < queuedCurrentCursor
          ? [{ cursor: queuedCurrentCursor, domain: "captures", resourceId: "capture-queued", changeType: "create" }]
          : [],
        snapshot: { captures: [{ id: "capture-queued" }] }
      }
    };
  },
  applySnapshot: async (snapshot, changes) => queuedSnapshots.push({ snapshot, changes })
});
await queuedImmediatePull.start("account-a");
assert.equal(typeof queuedPollTimer, "function");
const inFlightPoll = queuedPollTimer();
await flush();
assert.equal(queuedPullRequests.length, 3);
assert.ok(Number(new URL(queuedPullRequests[2], "https://local.invalid").searchParams.get("waitMs")) > 0);
queuedCurrentCursor = 2;
for (const listener of queuedChannelListeners) {
  listener({ type: "committed", owner: "account-a", operationId: "remote-operation" });
}
queuedDocumentTarget.listeners.get("visibilitychange")();
await flush();
assert.equal(queuedPullRequests.length, 4, "active signals must cancel the obsolete wait and start an immediate GET before it returns");
queuedLongPoll.resolve({ data: { cursor: 1, changes: [], snapshot: {} } });
await inFlightPoll;
await flush();
await flush();
assert.equal(queuedPullRequests.length, 4, "same-turn signals coalesce and the obsolete late response cannot add another pull");
assert.equal(new URL(queuedPullRequests[3], "https://local.invalid").searchParams.get("waitMs"), "0");
assert.equal(queuedSignals[2].aborted, true, "obsolete waiting GET receives real transport cancellation");
assert.equal(queuedImmediatePull.cursor(), 2);
assert.equal(queuedSnapshots.length, 1);
queuedImmediatePull.stop();

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

// F9真实队列存储命名空间：保留账户ID，旧空间未发请求不能在新空间派发。
{
  const store = createMemorySyncStore();
  let workspace = "cold:round1", scope = "session1";
  const sent = [];
  const queue = createRequestCoordinator({ store, getWorkspace: () => workspace, getScope: () => scope,
    send: async (url, options) => {
      sent.push({ workspace, url, body: options.body });
      throw Object.assign(new Error("offline"), { status: 503 });
    }
  });
  await assert.rejects(queue.request({ owner: "same-account", url: "/api/v1/captures", options: { method: "POST", body: "cold-only" } }), /offline/);
  const coldRows = await queue.list("same-account");
  assert.equal(coldRows[0].owner, "same-account");
  assert.equal(coldRows[0].body, "cold-only");
  const oldPending = (await queue.metrics("same-account")).pending;
  workspace = "simulation:round2"; scope = "session2";
  assert.deepEqual(await queue.resume("same-account", { force: true }), []);
  assert.equal((await queue.metrics("same-account")).pending, 0);
  assert.equal(sent.length, 1, "switching workspace must not replay the other workspace pending write");
  await queue.clear("same-account");
  workspace = "cold:round1"; scope = "session3";
  assert.equal((await queue.metrics("same-account")).pending, oldPending, "clearing another workspace must not delete the old durable row");
  assert.equal((await queue.list("same-account"))[0].owner, "same-account");
  assert.deepEqual(await store.list("same-account"), [], "workspace rows do not overwrite legacy unscoped queue keys");
}
// 消费者await后自行使用同一ticket；stop撤GET且旧apply不能前移游标/状态。
{
  let scope = "session-a", workspace = "cold:1", signalController = new AbortController();
  let gate = deferred(), applied = 0, receivedContext;
  const timers = [], signals = [];
  const loop = createIncrementalSync({
    coordinator: { resume: async () => [], subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: null,
    channel: { publish() {}, subscribe: () => () => {} },
    getScope: () => scope, getWorkspace: () => workspace, getSignal: () => signalController.signal,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimer() {},
    request: async (_url, options) => { signals.push(options.signal); return { data: { cursor: 2, changes: [{}], snapshot: { captures: [] } } }; },
    applySnapshot: async (_snapshot, _changes, context) => { receivedContext = context; await gate.promise; if (context.isCurrent()) applied += 1; }
  });
  const starting = loop.start("same-account");
  await flush();
  assert.equal(receivedContext.isCurrent(), true);
  scope = "session-b"; workspace = "simulation:2"; signalController.abort();
  gate.resolve();
  assert.equal(await starting, false);
  assert.equal(signals[0].aborted, true);
  assert.equal(applied, 0);
  assert.equal(loop.cursor(), 0);
}
// 成功续接不再多等1500ms；失败有界指数退避，无响应的旧GET不阻塞stop。
{
  const scheduled = [], signals = [];
  let fail = false, requests = 0;
  const loop = createIncrementalSync({
    coordinator: { resume: async () => [], subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: null,
    channel: { publish() {}, subscribe: () => () => {} },
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimer() {},
    request: async (_url, options) => { signals.push(options.signal); requests += 1; if (fail) throw Object.assign(new Error("unavailable"), { status: 503 }); return { data: { cursor: 1, changes: [], snapshot: {} } }; },
    applySnapshot: async () => {}
  });
  await loop.start("account-a");
  assert.equal(scheduled.at(-1).delay, 0);
  fail = true;
  await scheduled.at(-1).callback();
  assert.equal(scheduled.at(-1).delay, 1500);
  await scheduled.at(-1).callback();
  assert.equal(scheduled.at(-1).delay, 3000);
  for (let i = 0; i < 8; i += 1) await scheduled.at(-1).callback();
  assert.equal(scheduled.at(-1).delay, 60000);
  loop.stop();
  assert.ok(requests > 2);
}

// 明确未应用与坏恢复游标均不前移，并经同一受限退避恢复。
for (const kind of ["apply-false", "bad-recovery-cursor"]) {
  const scheduled = [];
  const loop = createIncrementalSync({
    coordinator: { resume: async () => [], subscribe: () => () => {} }, storage: null, locks: null,
    windowTarget: null, documentTarget: null, channel: { publish() {}, subscribe: () => () => {} },
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimer() {},
    request: async () => {
      if (kind === "bad-recovery-cursor") throw Object.assign(new Error("expired"), { code: "SYNC_CURSOR_EXPIRED", details: { currentCursor: "invalid" } });
      return { data: { cursor: 3, changes: [{}], snapshot: { captures: [] } } };
    },
    applySnapshot: async () => false, resnapshot: async () => undefined
  });
  await assert.rejects(loop.start("account-a"), kind === "apply-false" ? /尚未应用/ : /游标无效/);
  assert.equal(loop.cursor(), 0);
  assert.equal(scheduled.at(-1).delay, 1500);
  loop.stop();
}
// 持久ACK写成功但存储await尚未返回时换会话：保留事实，不向新UI发旧通知。
{
  const base = createMemorySyncStore(), held = deferred(), entered = deferred();
  let scope = "session-a";
  const queue = createRequestCoordinator({
    store: { ...base, put: async row => {
      const saved = await base.put(row);
      if (row.status === "committed") { entered.resolve(); await held.promise; }
      return saved;
    } }, getScope: () => scope,
    send: async () => ({ data: { id: "saved" } })
  });
  const events = [];
  queue.subscribe(record => events.push(record.status));
  const delivery = queue.request({ owner: "account-a", url: "/api/v1/captures", options: { method: "POST", body: "{}" } });
  await entered.promise;
  scope = "session-b"; held.resolve();
  await delivery;
  assert.equal(events.includes("committed"), false);
  assert.equal((await queue.list("account-a"))[0].status, "committed");
}

// 旧pending写尚无终态时，远端读取必须独立继续，不等待resume完成。
{
  const writing = deferred(), scheduled = [];
  let resumes = 0, reads = 0;
  const loop = createIncrementalSync({
    coordinator: { resume: async () => { resumes += 1; return writing.promise; }, subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: null,
    channel: { publish() {}, subscribe: () => () => {} },
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimer() {},
    request: async () => { reads += 1; return { data: { cursor: reads, changes: [], snapshot: {} } }; },
    applySnapshot: async () => {}
  });
  const starting = loop.start("account-a");
  await flush();
  assert.ok(resumes > 0);
  const before = reads;
  const ticking = scheduled.at(-1).callback();
  await flush();
  assert.ok(reads > before, "只读请求不被旧未知写阻塞");
  writing.resolve([]);
  await starting; await ticking;
  loop.stop();
}
// 缺重读端口/终态恢复明确false均拒绝伪造游标或成功状态。
for (const kind of ["missing-resnapshot", "terminal-false"]) {
  const scheduled = [];
  const loop = createIncrementalSync({
    coordinator: { resume: async () => kind === "terminal-false" ? [{ status: "rejected", reason: Object.assign(new Error("conflict"), { syncStatus: "conflict" }) }] : [], subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: null,
    channel: { publish() {}, subscribe: () => () => {} },
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimer() {},
    request: async () => { throw Object.assign(new Error("expired"), { code: "SYNC_CURSOR_EXPIRED", details: { currentCursor: 9 } }); },
    applySnapshot: async () => {}, ...(kind === "terminal-false" ? { resnapshot: async () => false } : {})
  });
  await assert.rejects(loop.start("account-a", { incremental: kind !== "terminal-false" }), kind === "missing-resnapshot" ? /缺少重读端口/ : /尚未应用/);
  assert.equal(loop.cursor(), 0);
  loop.stop();
}

// 主控rev383真实复现：完整恢复不能被held旧增量在恢复后覆盖；恢复期间广播不得另发GET。
{
  const oldRead = deferred(), fullRead = deferred(), startedRecovery = deferred();
  const listeners = new Set();
  let armed = false, stage = "initial", reads = 0;
  const loop = createIncrementalSync({
    coordinator: { resume: async () => armed ? [{ status: "rejected", reason: Object.assign(new Error("failed"), { syncStatus: "failed" }) }] : [], subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: null,
    channel: { publish() {}, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    setTimer: () => 1, clearTimer() {},
    request: async () => { reads += 1; if (armed && stage === "initial") return oldRead.promise; return { data: { cursor: 3, changes: [], snapshot: {} } }; },
    applySnapshot: async (_snapshot, _changes, context) => { if (context.isCurrent()) stage = "late-incremental"; },
    resnapshot: async context => { stage = "full-recovery"; startedRecovery.resolve(); await fullRead.promise; assert.equal(context.isCurrent(), true); }
  });
  await loop.start("account-a");
  armed = true;
  const draining = loop.drain();
  await startedRecovery.promise;
  const before = reads;
  for (const listener of listeners) listener({ type: "committed", owner: "account-a" });
  await flush();
  assert.equal(reads, before, "恢复屏障期间新广播不能并入另一个GET");
  oldRead.resolve({ data: { cursor: 9, changes: [{}], snapshot: { captures: [] } } });
  await flush();
  assert.equal(stage, "full-recovery");
  fullRead.resolve(); await draining;
  assert.equal(stage, "full-recovery");
  assert.ok(reads > before, "完整恢复结束后再续接真实游标读取");
  loop.stop();
}

// 完整恢复promise存活到真实I/O结束，hidden取消read ticket不能提前拆屏障。
{
  const full = deferred(), entered = deferred();
  const document = { ...eventTarget, listeners: new Map(), visibilityState: "visible" };
  const scheduled = [];
  let reads = 0, state = "initial";
  const loop = createIncrementalSync({
    coordinator: { resume: async () => [], subscribe: () => () => {} },
    storage: null, locks: null, windowTarget: null, documentTarget: document,
    channel: { publish() {}, subscribe: () => () => {} },
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimer() {},
    request: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error("expired"), { code: "SYNC_CURSOR_EXPIRED", details: { currentCursor: 1 } }); return { data: { cursor: 2, changes: [{}], snapshot: { captures: [] } } }; },
    applySnapshot: async (_snapshot, _changes, context) => { if (context.isCurrent()) state = "new-incremental"; },
    // 真实refresh消费者只依会话，模拟旧read取消后仍会完成的完整读取。
    resnapshot: async () => { entered.resolve(); await full.promise; state = "old-full-refresh"; }
  });
  const starting = loop.start("account-a");
  await entered.promise;
  document.visibilityState = "hidden"; document.listeners.get("visibilitychange")();
  document.visibilityState = "visible"; document.listeners.get("visibilitychange")();
  await flush();
  assert.equal(reads, 1, "隐藏/恢复前台不能越过仍存活的完整读取屏障");
  full.resolve(); await starting;
  await scheduled.at(-1).callback();
  assert.equal(state, "new-incremental");
  loop.stop();
}

// 公共投影→v1封装→JSON序列化是同一同步消费链，不将响应引用交给业务写者。
for (const role of ["owner", "user"]) {
  const user = { id: "account-a", role };
  const document = {
    ...createEmptyStore(),
    captures: [{ id: "serialized-capture", content: "原文保留", tokenBudget: { private: true } }],
    thoughts: [{ id: "serialized-question", type: "question", content: "工作记录", tags: [],
      occurredAt: "2026-10-16T08:00:00.000Z", occurredOn: "2026-10-16",
      providedReferences: [{ resourceType: "onboardingV2", citationId: "private-reference" },
        { resourceType: "thought", citationId: "visible-reference" }],
      contextReceipt: { referenceRequest: { providedCount: 2 } } }],
    notifications: [{ id: "serialized-notification", status: "succeeded", readAt: "" }],
    trash: [{ id: "serialized-trash" }]
  };
  const original = structuredClone(document);
  const projector = createPublicStateProjection({
    getUser: () => user, isOwner: value => value.role === "owner",
    speechProvider: { configured: false, defaultVoice: "", voices: [], supportedAsrMimeTypes: [] },
    visionProvider: { configured: false }, hash: value => String(value),
    now: () => "2026-10-16T12:00:00.000Z", today: () => "2026-10-16"
  });
  const domains = ["captures", "thoughts", "aiTasks", "notifications", "speechCache", "trash"];
  const changes = domains.map((domain, index) => ({ cursor: index + 1, domain }));
  const handler = createSyncHttp({
    repository: { readSyncSnapshot: async () => ({ document, metadata: { sync: { cursor: changes.length, changes } } }) },
    publicState: projector
  });
  const json = createJsonHttp({ getContext: () => ({ user }), maxBodyBytes: 1000,
    projectResponse: value => role === "owner" ? value : withoutReferenceOwnerMetadata(value) });
  const v1 = createApiV1Http({ getContext: () => ({ user, method: "GET" }), sendJson: json.sendJson });
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await handler.handleV1({ method: "GET" }, response,
    new URL("http://local.test/api/v1/sync?cursor=0"), v1);
  assert.equal(response.status, 200);
  const received = JSON.parse(response.body).data.snapshot;
  const expected = projector(document);
  for (const key of ["captures", "thoughts", "aiTasks", "notifications", "notificationUnread", "speech", "trashCount", "clusters", "insights"]) {
    assert.deepEqual(received[key], expected[key], `${role}: synchronous serialized ${key}`);
  }
  assert.equal(received.thoughts[0].providedReferences.length, role === "owner" ? 2 : 1);
  assert.equal(JSON.stringify(received).includes("private-reference"), role === "owner");
  assert.deepEqual(document, original, "sync serialization cannot mutate persisted document");
}

const recordRows = [{
  cursor: "1",
  ordinal: 0,
  commandId: "thought.update",
  entityType: "thoughtChain",
  entityId: "root-a",
  parentType: null,
  parentId: null,
  version: 2,
  operation: "update",
  changedFields: ["content"],
  scopeKeys: ["thought:list", "thought:root-a"],
  summary: null,
  createdAt: "2026-10-19T00:00:00.000Z"
}, {
  cursor: "1",
  ordinal: 1,
  commandId: "thought.update",
  entityType: "notification",
  entityId: "notification-a",
  parentType: null,
  parentId: null,
  version: 2,
  operation: "update",
  changedFields: ["status"],
  scopeKeys: ["notification:list"],
  summary: null,
  createdAt: "2026-10-19T00:00:00.000Z"
}];
const recordClient = {
  async query(sql) {
    if (sql.includes("FROM for_now.account_sync_heads")) {
      return { rows: [{ currentCursor: "1" }], rowCount: 1 };
    }
    if (sql.includes("COALESCE(min(cursor)")) {
      return { rows: [{ oldestCursor: "1" }], rowCount: 1 };
    }
    if (sql.includes("WITH cursor_counts")) {
      return { rows: structuredClone(recordRows), rowCount: recordRows.length };
    }
    throw new Error(`Unexpected record sync SQL: ${sql}`);
  }
};
const recordDetail = {
  id: "root-a",
  type: "question",
  content: "record sync current",
  version: 2,
  blocks: []
};
const recordSync = operation => operation({
  context: { client: recordClient, accountId: "account-a" },
  list: async () => ({
    items: [{ id: "root-a", type: "question", content: "summary", version: 2 }],
    nextId: "",
    prevId: "",
    tags: []
  }),
  detail: async () => recordDetail
});
const syncV2 = {
  enabled: true,
  batchLimit: 200,
  batchHardLimit: 500,
  waitMsMax: 1500,
  rebaseMaxScopes: 5,
  accountEnabled: id => id === "account-a"
};
const recordHandler = createSyncHttp({
  repository: {
    readSyncSnapshot: async () => ({
      document: createEmptyStore(),
      metadata: { sync: { cursor: 0, changes: [] } }
    }),
    syncScope: () => "record-test"
  },
  publicState: value => value,
  getAccountId: () => "account-a",
  assertAccess: async () => {},
  bodyJson: async req => req.body,
  recordSync,
  recordRebaseExtras: async rebased => ({
    speech: {
      configured: true,
      assets: rebased.scopes.flatMap(scope => scope.entities)
        .filter(entity => entity.key.entityType === "thoughtChain")
        .map(entity => ({ sourceId: entity.key.entityId }))
    }
  }),
  syncV2
});
const recordJson = createJsonHttp({
  getContext: () => ({ user: { id: "account-a", role: "owner" } }),
  maxBodyBytes: 1000
});
const recordApi = createApiV1Http({
  getContext: () => ({ user: { id: "account-a", role: "owner" } }),
  sendJson: recordJson.sendJson
});
const recordResponse = () => ({
  headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  writeHead(status) { this.status = status; },
  end(body) { this.body = body; this.writableEnded = true; }
});
const getRecordResponse = recordResponse();
await recordHandler.handleV1(
  { method: "GET" },
  getRecordResponse,
  new URL("http://local.test/api/v2/sync?cursor=0"),
  recordApi
);
assert.equal(getRecordResponse.status, 200);
const recordBatch = JSON.parse(getRecordResponse.body).data;
assert.equal(recordBatch.nextCursor, 1);
assert.equal(recordBatch.changes.length, 1);
assert.equal(recordBatch.changes[0].key.entityType, "thoughtChain");
assert.equal(recordBatch.changes[0].summary.content, "record sync current");

const rebaseResponse = recordResponse();
await recordHandler.handleV1(
  {
    method: "POST",
    body: {
      activeScopeKey: "thoughtDetail:root-a",
      scopes: [{
        scopeKey: "thoughtDetail:root-a",
        kind: "thoughtDetail",
        id: "root-a"
      }]
    }
  },
  rebaseResponse,
  new URL("http://local.test/api/v2/sync/rebase"),
  recordApi
);
assert.equal(rebaseResponse.status, 200);
const recordRebase = JSON.parse(rebaseResponse.body).data;
assert.equal(recordRebase.highWaterCursor, 1);
assert.equal(recordRebase.scopes[0].entities[0].projection.content, "record sync current");
assert.deepEqual(recordRebase.speech.assets, [{ sourceId: "root-a" }]);

recordRows[0].entityType = "unregistered";
const unknownResponse = recordResponse();
await recordHandler.handleV1(
  { method: "GET" },
  unknownResponse,
  new URL("http://local.test/api/v2/sync?cursor=0"),
  recordApi
);
assert.equal(unknownResponse.status, 503);
assert.equal(JSON.parse(unknownResponse.body).error.code, "SYNC_ENTITY_TYPE_UNREGISTERED");
recordRows[0].entityType = "thoughtChain";

const recordWakeNotifier = createAccountCommitNotifier();
const wakeRows = [];
let wakeCursor = 0;
const wakeClient = {
  async query(sql, values = []) {
    if (sql.includes("FROM for_now.account_sync_heads")) {
      return { rows: [{ currentCursor: String(wakeCursor) }], rowCount: 1 };
    }
    if (sql.includes("COALESCE(min(cursor)")) {
      return {
        rows: [{
          oldestCursor: String(wakeRows[0]?.cursor || wakeCursor + 1)
        }],
        rowCount: 1
      };
    }
    if (sql.includes("WITH cursor_counts")) {
      const after = Number(values[1] || 0);
      const rows = wakeRows.filter(row => Number(row.cursor) > after);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    throw new Error(`Unexpected record wake SQL: ${sql}`);
  }
};
const wakeHandler = createSyncHttp({
  repository: {
    readSyncSnapshot: async () => ({
      document: createEmptyStore(),
      metadata: { sync: { cursor: 0, changes: [] } }
    }),
    syncScope: () => "record-wake"
  },
  publicState: value => value,
  notifier: recordWakeNotifier,
  getAccountId: () => "account-a",
  assertAccess: async () => {},
  recordSync: operation => operation({
    context: { client: wakeClient, accountId: "account-a" },
    list: async () => ({ items: [], nextId: "", prevId: "", tags: [] }),
    detail: async id => ({
      id,
      type: "question",
      content: `wake-${wakeCursor}`,
      version: wakeCursor,
      blocks: []
    })
  }),
  syncV2
});
const wakeSamples = [];
for (let index = 0; index < 8; index += 1) {
  const after = wakeCursor;
  const response = recordResponse();
  const startedAt = performance.now();
  const waiting = wakeHandler.handleV1(
    { method: "GET" },
    response,
    new URL(`http://local.test/api/v2/sync?cursor=${after}&waitMs=1500`),
    recordApi
  );
  await flush();
  wakeCursor += 1;
  wakeRows.push({
    ...recordRows[0],
    cursor: String(wakeCursor),
    entityId: `wake-root-${wakeCursor}`,
    version: wakeCursor
  });
  recordWakeNotifier.notifyAccountCommitted({
    accountId: "account-a",
    storageScope: "record-wake"
  });
  await waiting;
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).data.nextCursor, wakeCursor);
  wakeSamples.push(performance.now() - startedAt);
}
recordWakeNotifier.stop();
const wakeSorted = [...wakeSamples].sort((left, right) => left - right);
console.log("F9_RECORD_V2_WAKE_METRICS " + JSON.stringify({
  samples: wakeSamples,
  p75CommitToResponseMs: wakeSorted[Math.ceil(wakeSorted.length * 0.75) - 1]
}));

const recordLoopRequests = [];
const recordLoopTimers = [];
let recordLoopMode = "valid";
let hydratedRecordCursor = null;
let recordLoopRebases = 0;
const recordLoopStorage = new Map();
const recordLoop = createRecordSyncLoop({
  request: async (url, options) => {
    recordLoopRequests.push({ url, options });
    if (url === "/api/v2/sync/rebase") {
      recordLoopRebases += 1;
      return {
        data: {
          highWaterCursor: recordLoopRebases === 1 ? 4 : 5,
          activeScopeKey: "thoughtPage:active",
          scopes: []
        }
      };
    }
    if (recordLoopMode === "unknown") {
      throw Object.assign(new Error("unknown"), { code: "SYNC_ENTITY_TYPE_UNKNOWN" });
    }
    return {
      data: {
        fromCursor: 4,
        nextCursor: 5,
        highWaterCursor: 5,
        hasMore: false,
        changes: [{
          key: { entityType: "thoughtChain" },
          operation: "create",
          refetch: "page"
        }]
      }
    };
  },
  applyBatch: async batch => ({
    committed: true,
    staleScopeKeys: batch.changes.length ? ["thoughtPage:active"] : []
  }),
  rebaseScopes: async () => ({ committed: true }),
  hydrateScopes: async cursor => {
    hydratedRecordCursor = cursor;
    return true;
  },
  getScopes: () => ({
    activeScopeKey: "thoughtPage:active",
    scopes: [{
      scopeKey: "thoughtPage:active",
      kind: "thoughtPage"
    }]
  }),
  getScope: () => "1",
  getWorkspace: () => "",
  getSignal: () => new AbortController().signal,
  storage: {
    getItem: key => recordLoopStorage.get(key) ?? null,
    setItem: (key, value) => recordLoopStorage.set(key, value)
  },
  windowTarget: null,
  documentTarget: null,
  setTimer: callback => {
    recordLoopTimers.push(callback);
    return recordLoopTimers.length;
  },
  clearTimer() {}
});
assert.equal(await recordLoop.start("account-a", { recordSync: true }), true);
assert.equal(recordLoop.cursor(), 5);
assert.equal(recordLoopRequests[0].url, "/api/v2/sync/rebase");
assert.match(recordLoopRequests[1].url, /^\/api\/v2\/sync\?/);
assert.equal(recordLoopRequests[2].url, "/api/v2/sync/rebase");
recordLoop.stop();
const beforeRecordRestart = recordLoopRequests.length;
assert.equal(await recordLoop.start("account-a", { recordSync: true }), true);
assert.equal(hydratedRecordCursor, 5);
assert.match(recordLoopRequests[beforeRecordRestart].url, /^\/api\/v2\/sync\?/);
recordLoopMode = "unknown";
await assert.rejects(recordLoop.pull(), { code: "SYNC_ENTITY_TYPE_UNKNOWN" });
assert.equal(recordLoop.cursor(), 5, "failed record batch cannot advance cursor");
recordLoop.stop();

// F5：状态层确认无关范围未失效时，任一 filter 标记都不得扩大成额外整体读。
const filterLoopRequests = [];
const unrelatedLoop = createRecordSyncLoop({
  request: async url => {
    filterLoopRequests.push(url);
    if (url === "/api/v2/sync/rebase") {
      return {
        data: {
          highWaterCursor: 1,
          activeScopeKey: "thoughtDetail:A",
          scopes: [{
            scopeKey: "thoughtDetail:A",
            descriptorVersion: 1,
            kind: "thoughtDetail",
            entities: [],
            orderedEntityKeys: []
          }]
        }
      };
    }
    return {
      data: {
        fromCursor: 1,
        nextCursor: 2,
        highWaterCursor: 2,
        hasMore: false,
        changes: [{
          key: { entityType: "thoughtChain", entityId: "B" },
          operation: "update",
          refetch: "filter"
        }]
      }
    };
  },
  applyBatch: async () => ({ committed: true, staleScopeKeys: [] }),
  rebaseScopes: async () => ({ committed: true }),
  hydrateScopes: async () => false,
  getScopes: () => ({
    activeScopeKey: "thoughtDetail:A",
    scopes: [{ scopeKey: "thoughtDetail:A", kind: "thoughtDetail" }]
  }),
  getScope: () => "1",
  getWorkspace: () => "",
  getSignal: () => new AbortController().signal,
  storage: { getItem: () => null, setItem: () => {} },
  windowTarget: null,
  documentTarget: null,
  setTimer: () => 0,
  clearTimer() {}
});
assert.equal(await unrelatedLoop.start("account-a", { recordSync: true }), true);
assert.equal(filterLoopRequests.filter(url => url === "/api/v2/sync/rebase").length, 1);
assert.equal(unrelatedLoop.cursor(), 2);
unrelatedLoop.stop();

let activeRecordScope = "thoughtDetail:A";
let holdRecordRebase = false;
let releaseRecordRebases;
const recordRebaseGate = new Promise(resolve => { releaseRecordRebases = resolve; });
let routeRebaseCount = 0;
const appliedRecordScopes = [];
const routeRecordLoop = createRecordSyncLoop({
  request: async (url, options) => {
    if (url === "/api/v2/sync/rebase") {
      routeRebaseCount += 1;
      const requested = JSON.parse(options.body);
      if (holdRecordRebase) {
        await recordRebaseGate;
      }
      return {
        highWaterCursor: 7,
        activeScopeKey: requested.activeScopeKey,
        scopes: [{
          scopeKey: requested.activeScopeKey,
          descriptorVersion: 1,
          kind: "thoughtDetail",
          entities: [],
          orderedEntityKeys: []
        }]
      };
    }
    return {
      fromCursor: 7,
      nextCursor: 7,
      highWaterCursor: 7,
      hasMore: false,
      changes: []
    };
  },
  applyBatch: () => ({ committed: false, staleScopeKeys: [] }),
  rebaseScopes: payload => {
    appliedRecordScopes.push(payload.activeScopeKey);
  },
  getScopes: () => ({
    activeScopeKey: activeRecordScope,
    scopes: [{
      scopeKey: activeRecordScope,
      kind: "thoughtDetail",
      id: activeRecordScope.slice("thoughtDetail:".length)
    }]
  }),
  getScope: () => "session-1",
  getWorkspace: () => "",
  storage: { getItem: () => null, setItem() {} },
  windowTarget: null,
  documentTarget: null,
  setTimer: () => 1,
  clearTimer() {}
});
assert.equal(await routeRecordLoop.start("account-a", { recordSync: true }), true);
holdRecordRebase = true;
const staleRouteRebase = routeRecordLoop.rebase();
await Promise.resolve();
activeRecordScope = "thoughtDetail:B";
const currentRouteRebase = routeRecordLoop.rebase();
releaseRecordRebases();
await Promise.all([staleRouteRebase, currentRouteRebase]);
assert.equal(routeRebaseCount, 3);
assert.equal(appliedRecordScopes.at(-1), "thoughtDetail:B");
assert.equal(appliedRecordScopes.filter(scope => scope === "thoughtDetail:A").length, 1);
routeRecordLoop.stop();

const recoveryTimers = [];
const recoveryDelays = [];
let recoveryGets = 0;
let recoveryPosts = 0;
const failingRecoveryLoop = createRecordSyncLoop({
  request: async url => {
    if (url === "/api/v2/sync/rebase") {
      recoveryPosts += 1;
      throw Object.assign(new Error("rebase unavailable"), {
        code: "SYNC_V2_UNAVAILABLE",
        status: 503
      });
    }
    recoveryGets += 1;
    throw Object.assign(new Error("cursor expired"), { code: "SYNC_CURSOR_EXPIRED" });
  },
  applyBatch: () => ({ committed: false, staleScopeKeys: [] }),
  rebaseScopes() {},
  getScopes: () => ({
    activeScopeKey: "thoughtPage:active",
    scopes: [{
      scopeKey: "thoughtPage:active",
      kind: "thoughtPage"
    }]
  }),
  getScope: () => "session-1",
  getWorkspace: () => "",
  storage: { getItem: () => null, setItem() {} },
  windowTarget: null,
  documentTarget: null,
  pollMs: 1000,
  setTimer: (callback, delay) => {
    recoveryTimers.push(callback);
    recoveryDelays.push(delay);
    return recoveryTimers.length;
  },
  clearTimer() {}
});
await assert.rejects(
  failingRecoveryLoop.start("account-a", { recordSync: true }),
  { code: "SYNC_V2_UNAVAILABLE" }
);
for (let index = 0; index < 3; index += 1) {
  const timer = recoveryTimers.shift();
  assert.ok(timer);
  timer();
  await flush();
  await flush();
}
assert.equal(recoveryGets, 3);
assert.equal(recoveryPosts, 4);
assert.deepEqual(recoveryDelays.slice(0, 4), [1000, 2000, 4000, 8000]);
failingRecoveryLoop.stop();

const healthRuntime = {
  featureFlags: {},
  syncHealth: { lastPullMs: 0 },
  runtimeFeatureRegistry: { notifyState() {} },
  routeDataRequestSerial: 1
};
const idleSyncController = () => ({
  start: async () => true,
  stop() {},
  pull: async () => false,
  drain: async () => [],
  rebase: async () => true,
  cursor: () => 0
});
const health = createDataSyncRuntime({
  runtime: healthRuntime,
  requestCoordinator: {
    metrics: async () => ({
      pending: 0,
      conflicts: 0,
      failed: 0,
      durable: true,
      oldestPendingAt: "",
      enqueueToAckP95Ms: 0
    })
  },
  getActionsCoordinator: () => ({
    applyOperationStatus() {},
    applyIncrementalSnapshot() {},
    load: async () => true
  }),
  requestV1: async () => ({}),
  syncScope: () => "session-1",
  syncWorkspace: () => "",
  captureDataScope: () => ({
    owner: "account-a",
    workspace: "",
    isCurrent: () => true
  }),
  restorePendingProjections: async () => {},
  refreshState: async () => true,
  createIncrementalSync: idleSyncController,
  createRecordSyncLoop: idleSyncController,
  applyRecordBatch: () => ({ committed: false, staleScopeKeys: [] }),
  rebaseRecordScopes: () => ({ committed: true })
});
await health.updateSyncHealth({
  type: "record-error",
  owner: "account-a",
  workspace: "",
  scope: "session-1",
  code: "SYNC_ENTITY_VERSION_CONFLICT"
});
assert.equal(healthRuntime.syncHealth.status, "error");
assert.equal(healthRuntime.syncHealth.lastError, "SYNC_ENTITY_VERSION_CONFLICT");
await health.updateSyncHealth({
  type: "pull",
  owner: "account-a",
  workspace: "",
  scope: "session-1",
  durationMs: 3
});
assert.equal(healthRuntime.syncHealth.status, "error");
assert.equal(healthRuntime.syncHealth.lastError, "SYNC_ENTITY_VERSION_CONFLICT");
await health.updateSyncHealth({
  type: "record-pull",
  owner: "account-a",
  workspace: "",
  scope: "session-1",
  durationMs: 4
});
assert.equal(healthRuntime.syncHealth.status, "synced");
assert.equal(healthRuntime.syncHealth.lastError, "");

let speechSyncFixture = null;
let speechProjectionCalls = 0;
let speechSnapshotReads = 0;
const speechSyncHttp = createSyncHttp({
  repository: {
    async readSyncSnapshot() {
      speechSnapshotReads += 1;
      return structuredClone(speechSyncFixture);
    }
  },
  publicState(document) {
    speechProjectionCalls += 1;
    return { speech: structuredClone(document.publicSpeech) };
  }
});
async function readSpeechSync(cursor, waitMs = 0) {
  let response = null;
  await speechSyncHttp.handleV1(
    { method: "GET" },
    {},
    new URL(`http://local.test/api/v1/sync?cursor=${cursor}&waitMs=${waitMs}`),
    {
      success(_res, status, data) {
        response = { status, data };
        return true;
      },
      error(_res, status, message, code, details) {
        response = { status, error: { message, code, details } };
        return true;
      }
    }
  );
  return response;
}
const speechAsset = id => ({
  id,
  sourceType: "capture",
  sourceId: "capture-1",
  sourceVersion: 1
});
for (const scenario of [{
  after: 0,
  cursor: 1,
  changeType: "create",
  assets: [speechAsset("speech-added")]
}, {
  after: 1,
  cursor: 2,
  changeType: "update",
  assets: [speechAsset("speech-replaced")]
}, {
  after: 2,
  cursor: 3,
  changeType: "delete",
  assets: []
}]) {
  speechSyncFixture = {
    document: {
      speechCache: [{ attachmentPath: "/attachments/private.tts.mp3" }],
      publicSpeech: {
        configured: true,
        defaultVoice: "voice-a",
        voices: [],
        supportedAsrMimeTypes: [],
        assets: scenario.assets
      }
    },
    metadata: {
      sync: {
        cursor: scenario.cursor,
        changes: [{
          cursor: scenario.cursor,
          domain: "speechCache",
          resourceId: scenario.assets[0]?.id || "speech-replaced",
          version: 0,
          changeType: scenario.changeType,
          operationId: "",
          traceId: "",
          committedAt: "2026-10-04T00:00:00.000Z"
        }],
        operations: []
      }
    }
  };
  const response = await readSpeechSync(scenario.after);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.snapshot.speech.assets, scenario.assets);
  assert.equal(Object.hasOwn(response.data.snapshot, "speechCache"), false);
}
assert.equal(speechProjectionCalls, 3, "speech sync snapshots must reuse the public state projection");

const readsBeforeLongPoll = speechSnapshotReads;
const longPollResponse = await readSpeechSync(3, 1500);
assert.equal(longPollResponse.status, 200);
assert.equal(speechSnapshotReads - readsBeforeLongPoll, 2, "long polling must read one initial and one final snapshot");

// F9服务端：真实JSON持久游标与提交端口，提示只能加速，不能代替权威回读。
{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-sync-wake-"));
  const notifier = createAccountCommitNotifier();
  let hintMode = "normal";
  const makeRepository = (file, accountId = "account-a", onCommit = async () => {}) => createJsonStoreRepository({
    getFile: () => file, emptyDocument: { version: 18, captures: [], trash: [] }, normalize: value => value,
    readDocument: async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; } },
    writeDocument: async (file, document) => { await fs.writeFile(file + ".tmp", JSON.stringify(document)); await fs.rename(file + ".tmp", file); },
    onCommitted: ({ storageScope }) => { if (hintMode === "fail") throw new Error("hint unavailable"); if (hintMode !== "drop") notifier.notifyAccountCommitted({ accountId, storageScope }); }, onCommit
  });
  const file = path.join(directory, "a.json");
  const repository = makeRepository(file);
  const scope = { accountId: "account-a", storageScope: file };
  const publicState = document => ({ captures: document.captures });
  const create = (repo = repository, assertAccess) => createSyncHttp({ repository: repo, publicState, notifier, getAccountId: () => "account-a", assertAccess });
  const invoke = async (http, cursor, waitMs = 1500, req = new EventEmitter(), res = new EventEmitter()) => {
    req.method = "GET"; let response;
    await http.handleV1(req, res, new URL(`http://local/api/v1/sync?cursor=${cursor}&waitMs=${waitMs}`), {
      success: (_res, status, data) => { response = { status, data }; return true; },
      error: (_res, status, message, code) => { response = { status, code }; return true; }
    });
    assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("close"), 0);
    return response;
  };
  const cursor = async () => (await repository.readSyncSnapshot()).metadata.sync.cursor;
  let sequence = 0;
  const write = repo => repo.update(document => document.captures.push({ id: `wake-${sequence++}`, content: "实际保存" }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await repository.update(() => {});
    const samples = [];
    for (let n = 0; n < 8; n++) {
      const after = await cursor(), pending = invoke(create(), after);
      await sleep(50); const committed = performance.now(); await write(repository);
      const result = await pending;
      assert.ok(result.data.cursor > after); samples.push(performance.now() - committed);
      assert.equal(notifier.activeSubscriptions(), 0);
    }
    assert.ok(samples.every(value => value < 500), "local JSON commit-to-response must avoid original1500ms sleep");
    // 读取已拿到旧快照但尚未返回时提交，generation必须保留该通知。
    const readEntered = deferred(), releaseRead = deferred(); let first = true;
    const racing = { ...repository, async readSyncChanges() { const result = await repository.readSyncChanges(); if (first) { first = false; readEntered.resolve(); await releaseRead.promise; } return result; } };
    const beforeRace = await cursor(); const raced = invoke(create(racing), beforeRace);
    await readEntered.promise; await write(repository); releaseRead.resolve();
    assert.ok((await raced).data.cursor > beforeRace);
    const workspace = makeRepository(path.join(directory, "other-workspace.json")); await workspace.update(() => {});
    const beforeHints = await cursor(); let completed = false;
    const hinted = invoke(create(), beforeHints).then(value => { completed = true; return value; });
    notifier.notifyAccountCommitted(scope); notifier.notifyAccountCommitted(scope);
    notifier.notifyAccountCommitted({ ...scope, accountId: "account-b" });
    await write(workspace); await sleep(25); assert.equal(completed, false, "duplicates/other account/workspace are not committed cursor changes");
    await assert.rejects(repository.update(() => { throw new Error("rollback before write"); }));
    await sleep(20); assert.equal(completed, false);
    await write(repository); assert.ok((await hinted).data.cursor > beforeHints);
    // 丢失/失败提示走同一截止后的最终读取；通知异常不改变已提交结果。
    for (hintMode of ["drop", "fail"]) {
      const after = await cursor(), started = performance.now(), pending = invoke(create(), after, 150);
      await sleep(20); await write(repository); const result = await pending;
      assert.ok(result.data.cursor > after); assert.ok(performance.now() - started >= 100);
    }
    hintMode = "normal";
    const auditFailure = makeRepository(file, "account-a", async () => { throw new Error("existing audit failure"); });
    const beforeAudit = await cursor(), auditWait = invoke(create(), beforeAudit);
    await sleep(20); const auditStarted = performance.now(); await assert.rejects(write(auditFailure), /existing audit failure/);
    assert.ok((await auditWait).data.cursor > beforeAudit); assert.ok(performance.now() - auditStarted < 500, "committed hint must precede audit failure");
    // 断连与真实资格撤销都清理订阅；不撤销此前写入事实。
    const request = new EventEmitter(), response = new EventEmitter();
    const disconnected = invoke(create(), await cursor(), 1500, request, response);
    await sleep(20); response.destroyed = true; response.emit("close"); await disconnected;
    assert.equal(notifier.activeSubscriptions(), 0);
    let allowed = true;
    const revoked = invoke(create(repository, async () => { if (!allowed) throw Object.assign(new Error("quarantined"), { code: "ACCOUNT_QUARANTINED", statusCode: 503 }); }), await cursor());
    await sleep(20); allowed = false; notifier.invalidateAccount("account-a");
    await assert.rejects(revoked, error => error.code === "ACCOUNT_QUARANTINED"); assert.equal(notifier.activeSubscriptions(), 0);
    const stopped = invoke(create(), await cursor());
    const stopReadEntered = deferred(), stopReadRelease = deferred();
    const readingAtStop = invoke(create({ ...repository, async readSyncChanges() { const snapshot = await repository.readSyncChanges(); stopReadEntered.resolve(); await stopReadRelease.promise; return snapshot; } }), await cursor());
    await stopReadEntered.promise; notifier.stop(); stopReadRelease.resolve();
    await assert.rejects(stopped, error => error.code === "ACCOUNT_DEPENDENCIES_UNAVAILABLE");
    await assert.rejects(readingAtStop, error => error.code === "ACCOUNT_DEPENDENCIES_UNAVAILABLE"); assert.equal(notifier.activeSubscriptions(), 0);
    console.log("F9_JSON_WAKE_METRICS " + JSON.stringify({ samples, p75CommitToResponseMs: [...samples].sort((a, b) => a - b)[5] }));
  } finally { notifier.stop(); await fs.rm(directory, { recursive: true, force: true }); }
}

console.log("Sync coordinator contracts passed: durable-first writes, stable keys, resource serialization, parallel resources, deterministic health metrics, recovery resnapshots, disabled-to-enabled gray recovery, stale-session rejection, cross-tab invalidation, incremental cursors, retry/failure classification, audit minimization and account isolation.");
