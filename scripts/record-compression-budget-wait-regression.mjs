import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import { createContentRuntime, createEmptyStore, DEFAULT_RECORD_TIMEZONE } from "../src/app/index.mjs";
import { recordCompressionAccountQueueAllowance } from "../src/config/index.mjs";
import {
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_TASK_KIND
} from "../src/modules/record-compressions/index.mjs";
import { WAITING_FOR_BUDGET_STATUS } from "../src/modules/tasks/index.mjs";

const asOf = "2026-10-10T08:00:00.000Z";
let currentStore = createEmptyStore();
let sequence = 0;
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const scheduled = [];
const providerCalls = [];
const idempotencyLedger = new Map();
const repository = {
  async read() { return structuredClone(currentStore); },
  async update(operation) { return operation(currentStore); },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`;
    const existing = idempotencyLedger.get(key);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("idempotency key reused"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return structuredClone(onReplay(structuredClone(existing.response)));
    }
    const response = await operation(currentStore);
    idempotencyLedger.set(key, {
      requestHash: request.requestHash,
      response: structuredClone(response)
    });
    return response;
  },
  async transact(operation) {
    return operation({ document: currentStore, commit: async () => {} });
  }
};

function addSource(store, id = "budget-wait-source", date = asOf.slice(0, 10)) {
  store.thoughts.push({
    id,
    type: "question",
    content: "只用于验证预算等待的合成用户来源。",
    authorType: "user",
    origin: "manual",
    occurredAt: `${date}T07:00:00.000Z`,
    occurredOn: date,
    version: 1,
    disposition: "pending"
  });
}

function createRuntime({
  timezone = DEFAULT_RECORD_TIMEZONE,
  usageEntries = [],
  clockAsOf = asOf
} = {}) {
  const getClockAsOf = () => typeof clockAsOf === "function" ? clockAsOf() : clockAsOf;
  return createContentRuntime({
    repository,
    trashRetentionDays: 30,
    getAccountId: () => "account-a",
    getTimezone: () => timezone,
    getCursorScope: () => "account-a",
    backgroundContextKey: () => "account-a",
    workflowContextKey: () => "account-a",
    dispatchBackground: callback => scheduled.push(callback),
    async runDeepSeek(_prompt, options) {
      providerCalls.push(options);
      return { content: JSON.stringify({
        schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
        daily: { observations: [], metricKeys: [], missing: [] },
        thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
        other: { themes: [], collectedQuotes: [] },
        aiReference: [], stableUserCandidates: [], conflicts: [], warnings: []
      }) };
    },
    async readAiUsage() { return { entries: structuredClone(usageEntries) }; },
    recordCompressionDailyBudgetCny: 1,
    recordCompressionPerCallBudgetCny: 0.25,
    recordCompressionMaxBackfillDatesPerScan: 0,
    now: getClockAsOf,
    today: () => getClockAsOf().slice(0, 10),
    currentTime: () => Date.parse(getClockAsOf()),
    createId: () => `budget-wait-${++sequence}`,
    hash,
    async logEvent() {},
    async debugFetch() { return { ok: true }; },
    mediaFactory: () => ({
      attachmentCleanup: {
        enqueue() {},
        async drain() { return { attempted: 0, pending: 0, removed: [] }; },
        schedule() {}
      },
      speechProvider: { configured: false, supportedAsrMimeTypes: [] },
      visionProvider: { configured: false },
      async listAttachmentInventory() { return []; },
      async materializeAttachmentFiles() { return []; },
      async transcribeCapture() { return null; }
    })
  });
}

const persistedWaits = () => currentStore.aiTasks.filter(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND && task.status === WAITING_FOR_BUDGET_STATUS
));
const assertDiagnosticsMatchStore = result => {
  assert.equal(result.waitingBudgetCount, persistedWaits().length,
    "scheduler diagnostics must report the durable per-account waiting total");
};

addSource(currentStore);
let runtime = createRuntime();
const firstWaitScan = await runtime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(firstWaitScan.queuedCount, 0);
assert.equal(firstWaitScan.promotedBudgetWaitCount, 0);
assert.equal(firstWaitScan.waitingBudgetCount, 2,
  "daily and independent historical work should be durably waiting when no budget is available");
assert.equal(persistedWaits().length, 2);
assert.equal(scheduled.length, 0, "waiting work must not dispatch provider calls");
assert.equal(providerCalls.length, 0);
assertDiagnosticsMatchStore(firstWaitScan);
assert.ok(persistedWaits().every(task => (
  !JSON.stringify(task).includes("只用于验证预算等待") && !Object.hasOwn(task, "prompt")
)), "the durable wait queue must contain metadata only, never source text or prompt content");

const waitIdsBeforeRepeat = persistedWaits().map(task => task.id).sort();
const repeatedWaitScan = await runtime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(persistedWaits().length, 2, "repeated scans must not duplicate durable waits");
assert.deepEqual(persistedWaits().map(task => task.id).sort(), waitIdsBeforeRepeat);
assert.equal(repeatedWaitScan.waitingBudgetCount, 2);
assertDiagnosticsMatchStore(repeatedWaitScan);
assert.equal(providerCalls.length, 0);

// JSON round-trip models a process restart; waitingBudget tasks remain durable
// and are only promoted after the scheduler supplies newly available capacity.
currentStore = JSON.parse(JSON.stringify(currentStore));
runtime = createRuntime();
const waitingIds = persistedWaits().map(task => task.id);
const recoveredScan = await runtime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 2 });
assert.equal(recoveredScan.promotedBudgetWaitCount, 2);
assert.equal(recoveredScan.invalidatedBudgetWaitCount, 0);
assert.equal(recoveredScan.waitingBudgetCount, 0);
assert.equal(recoveredScan.queuedCount, 2);
assert.deepEqual(waitingIds.map(id => currentStore.aiTasks.find(task => task.id === id)?.status), ["queued", "queued"]);
assert.equal(recordCompressionAccountQueueAllowance({ dailyLimit: 2, knownCalls: 0, reservedCalls: 2 }), 0,
  "two promoted tasks exhaust the account's daily allowance");
assertDiagnosticsMatchStore(recoveredScan);
assert.equal(scheduled.length, 2);
assert.equal(providerCalls.length, 0, "queue promotion schedules work without calling the provider in this regression");
const exhaustedAccountScan = await runtime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(exhaustedAccountScan.queuedCount, 0);
assert.equal(currentStore.aiTasks.filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
  && ["queued", "running"].includes(task.status)).length, 2,
"a scan with no remaining account capacity cannot promote or create a third task");

// A separate account state verifies that waits are revalidated after a
// permission change and counted as invalidated rather than sent to the model.
currentStore = createEmptyStore();
addSource(currentStore, "revoked-budget-wait-source");
const staleRuntime = createRuntime();
const staleWaitScan = await staleRuntime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(staleWaitScan.waitingBudgetCount, 2);
const sourceRef = {
  resourceType: "thought",
  resourceId: "revoked-budget-wait-source",
  rootId: "revoked-budget-wait-source",
  targetKey: "question:revoked-budget-wait-source",
  version: 1
};
await staleRuntime.perception.updatePermissions({
  sourceRef,
  contextAllowed: false,
  learningAllowed: false,
  expectedRevision: 0
});
const invalidatedWaitScan = await staleRuntime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(invalidatedWaitScan.invalidatedBudgetWaitCount, 2);
assert.equal(invalidatedWaitScan.promotedBudgetWaitCount, 0);
assert.equal(invalidatedWaitScan.waitingBudgetCount, 0);
assert.equal(persistedWaits().length, 0);
assert.ok(currentStore.aiTasks.filter(task => task.id && staleWaitScan.waitingBudgetTaskIds.includes(task.id))
  .every(task => task.status === "stale"));
assertDiagnosticsMatchStore(invalidatedWaitScan);
assert.equal(providerCalls.length, 0, "revoked sources must invalidate waits before any provider call");

currentStore = createEmptyStore();
for (let day = 29; day <= 30; day += 1) {
  addSource(currentStore, `bounded-source-2026-09-${day}`, `2026-09-${day}`);
}
for (let day = 1; day <= 10; day += 1) {
  addSource(currentStore, `bounded-source-2026-10-${String(day).padStart(2, "0")}`, `2026-10-${String(day).padStart(2, "0")}`);
}
const boundedWaitRuntime = createRuntime();
const boundedWaitScan = await boundedWaitRuntime.runRecordCompressionScan({
  asOf,
  slot: "backfill",
  backfillDates: 2,
  maxQueued: 0
});
assert.equal(boundedWaitScan.waitingBudgetCount, 8);
assert.equal(persistedWaits().length, 8, "durable waiting remains bounded at the declared per-account cap");
assert.ok(boundedWaitScan.skippedBudgetWaitCount > 0,
  "scheduler result must report candidates skipped after the bounded wait queue fills");
assertDiagnosticsMatchStore(boundedWaitScan);
assert.equal(providerCalls.length, 0);

// The local record date follows the account's timezone, while daily cost
// accounting rolls over at midnight Asia/Shanghai. Los Angeles stays on
// October 10 across the Shanghai midnight at 16:00Z, so this also guards
// against accidentally using the account day for budget accounting.
const laTimezone = "America/Los_Angeles";
const priorShanghaiDayUsage = [{
  scene: RECORD_COMPRESSION_TASK_KIND,
  createdAt: "2026-10-10T10:00:00.000Z",
  costKnown: true,
  costCny: 1
}];
currentStore = createEmptyStore();
addSource(currentStore, "shanghai-budget-boundary-source", "2026-10-10");
const boundaryClock = { asOf: "2026-10-10T15:30:00.000Z" };
const boundaryRuntime = createRuntime({
  timezone: laTimezone,
  usageEntries: priorShanghaiDayUsage,
  clockAsOf: () => boundaryClock.asOf
});
const beforeMidnightScan = await boundaryRuntime.runRecordCompressionScan({
  asOf: boundaryClock.asOf,
  slot: "evening",
  maxQueued: 2
});
assert.equal(beforeMidnightScan.queuedCount, 0,
  "same-Shanghai-day spend must exhaust the budget before Shanghai midnight");
assert.equal(beforeMidnightScan.waitingBudgetCount, 2);
assert.equal(currentStore.aiTasks.find(task => task.payload?.operation === "daily")?.status,
  WAITING_FOR_BUDGET_STATUS);

boundaryClock.asOf = "2026-10-10T16:30:00.000Z";
const afterMidnightScan = await boundaryRuntime.runRecordCompressionScan({
  asOf: boundaryClock.asOf,
  slot: "evening",
  maxQueued: 2
});
assert.equal(afterMidnightScan.queuedCount, 2,
  "previous Shanghai-day spend must no longer consume the new global budget day");
const boundaryDailyTask = currentStore.aiTasks.find(task => task.payload?.operation === "daily"
  && task.status === "queued");
assert.ok(boundaryDailyTask, "the daily compression task must queue after Shanghai midnight");
assert.equal(boundaryDailyTask.payload.localDate, "2026-10-10",
  "the task record date must remain in the account's Los Angeles timezone");
assert.equal(boundaryDailyTask.payload.timezone, laTimezone);
assert.equal(providerCalls.length, 0, "the synthetic boundary regression must not call a provider");
assertDiagnosticsMatchStore(afterMidnightScan);

// Fresh work after the rollover must use the same Shanghai-day accounting for
// both daily compression and the independent historical supplement.
currentStore = createEmptyStore();
idempotencyLedger.clear();
addSource(currentStore, "shanghai-budget-new-day-source", "2026-10-10");
const newDayScan = await boundaryRuntime.runRecordCompressionScan({
  asOf: boundaryClock.asOf,
  slot: "evening",
  maxQueued: 2
});
assert.equal(newDayScan.queuedCount, 2,
  "fresh work must not count prior Shanghai-day spend even while the account remains on the same local date");
assert.equal(currentStore.aiTasks.filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
  && task.status === "queued").length, 2,
"daily compression and historical supplement must both use the Shanghai budget day");
assert.equal(providerCalls.length, 0);

console.log("Record-compression durable budget-wait, recovery, bounds and diagnostics regression passed.");
