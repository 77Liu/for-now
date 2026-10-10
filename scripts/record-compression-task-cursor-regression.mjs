import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTaskLifecycle, WAITING_FOR_BUDGET_STATUS } from "../src/modules/tasks/index.mjs";

let id = 0;
let createdAt = "2026-10-10T08:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const createLifecycle = () => createTaskLifecycle({
  createId: () => `cursor-task-${++id}`,
  now: () => createdAt,
  hash
});
const inspectTarget = () => ({ inputVersion: 1, subtargetVersion: 0, inputHash: "cursor-input" });
const basePayload = {
  localDate: "2026-10-10",
  timezone: "America/Los_Angeles",
  promptVersion: "historical-user-supplement.v1",
  sourceManifestHash: "a".repeat(64),
  recordId: "supplement-target"
};
const historicalInput = {
  kind: "recordCompression",
  resourceType: "recordCompression",
  targetId: "supplement-target",
  inputVersion: 1,
  clientRequestId: "historical-batch-two",
  payload: {
    ...basePayload,
    operation: "historicalSupplement",
    windowStart: "2026-10-04",
    windowEnd: "2026-10-10",
    batchIndex: 2,
    inputAsOf: "2026-10-10T08:00:00.000Z",
    privateUnlistedField: "must be dropped"
  }
};

const firstLifecycle = createLifecycle();
const created = firstLifecycle.create([], historicalInput, inspectTarget);
assert.ok(created.task);
assert.deepEqual(created.task.payload, {
  ...basePayload,
  operation: "historicalSupplement",
  windowStart: "2026-10-04",
  windowEnd: "2026-10-10",
  batchIndex: 2,
  inputAsOf: "2026-10-10T08:00:00.000Z"
}, "only the versioned historicalSupplement cursor allowlist persists");

const persistedTasks = JSON.parse(JSON.stringify([created.task]));
createdAt = "2026-10-11T08:00:00.000Z";
const restartedLifecycle = createLifecycle();
const restartedTask = persistedTasks[0];
assert.equal(restartedTask.payload.batchIndex, 2,
  "the persisted task retains the next input batch across a process restart");
assert.equal(restartedTask.payload.windowStart, "2026-10-04");
assert.equal(restartedTask.payload.windowEnd, "2026-10-10");
assert.equal(restartedTask.payload.inputAsOf, "2026-10-10T08:00:00.000Z");
assert.equal(restartedLifecycle.recover(persistedTasks).queued[0], restartedTask.id);

const daily = firstLifecycle.create([], {
  ...historicalInput,
  clientRequestId: "daily-must-not-keep-cursor",
  payload: {
    ...basePayload,
    operation: "daily",
    windowStart: "2026-10-04",
    windowEnd: "2026-10-10",
    batchIndex: 2,
    inputAsOf: "2026-10-10T08:00:00.000Z"
  }
}, inspectTarget);
assert.deepEqual(daily.task.payload, { ...basePayload, operation: "daily" },
  "daily tasks discard historical cursor fields");

const otherKind = firstLifecycle.create([], {
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 1,
  clientRequestId: "other-kind-must-not-keep-cursor",
  payload: {
    windowStart: "2026-10-04",
    windowEnd: "2026-10-10",
    batchIndex: 2,
    inputAsOf: "2026-10-10T08:00:00.000Z"
  }
}, inspectTarget);
assert.deepEqual(otherKind.task.payload, {},
  "the cursor allowlist does not widen unrelated task payloads");

let waitingMarkQueuedCalls = 0;
const budgetWaitInput = {
  ...historicalInput,
  clientRequestId: "historical-budget-wait",
  payload: {
    ...basePayload,
    operation: "historicalSupplement",
    windowStart: "2026-10-04",
    windowEnd: "2026-10-10",
    batchIndex: 1,
    inputAsOf: "2026-10-10T08:00:00.000Z"
  }
};
const waiting = firstLifecycle.create([], budgetWaitInput, () => ({
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: "cursor-input",
  prompt: "must not persist",
  markQueued() { waitingMarkQueuedCalls += 1; }
}), { waitingBudget: true });
assert.equal(waiting.task.status, WAITING_FOR_BUDGET_STATUS);
assert.equal(waitingMarkQueuedCalls, 0,
  "a durable budget wait does not mark its summary as queued");
assert.equal(JSON.stringify(waiting.task).includes("must not persist"), false,
  "budget waits persist only task metadata, never prompt/input text");
const restartedBudgetWait = JSON.parse(JSON.stringify([waiting.task]));
assert.deepEqual(restartedLifecycle.recover(restartedBudgetWait), { queued: [], interrupted: [] },
  "restart leaves budget waits durable and undispatched");
const promoted = restartedLifecycle.promoteBudgetWaiting(restartedBudgetWait, waiting.task.id, {
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: "cursor-input",
  markQueued() { waitingMarkQueuedCalls += 1; }
});
assert.equal(promoted.queued, true);
assert.equal(restartedBudgetWait[0].status, "queued");
assert.equal(waitingMarkQueuedCalls, 1,
  "the summary is marked queued only when a revalidated task is promoted");

console.log("Record-compression task cursor allowlist and persistence regression passed.");
