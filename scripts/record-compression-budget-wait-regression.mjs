import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import { createContentRuntime, createEmptyStore, createRecordCompressionService, createAiBudgetRuntime, DEFAULT_RECORD_TIMEZONE } from "../src/app/index.mjs";
import { recordCompressionAccountQueueAllowance } from "../src/config/index.mjs";
import {
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_PROMPT_VERSION,
  buildRecordCompressionInput,
  RECORD_COMPRESSION_TASK_KIND
} from "../src/modules/record-compressions/index.mjs";
import { WAITING_FOR_BUDGET_STATUS, createTaskLifecycle } from "../src/modules/tasks/index.mjs";

const asOf = "2026-10-10T10:05:00.000Z";
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
  clockAsOf = asOf,
  startDate = "",
  failProvider = false,
  measuredCost,
  denyAdmission = () => false
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
      if (denyAdmission()) {
        const admission = createAiBudgetRuntime({ budget: {
          async read() { return {}; },
          async reserveTask() { throw Object.assign(new Error("合成真实准入额度拒绝"), { code: "AI_DAILY_CALL_LIMIT" }); },
          async startStage() { throw new Error("provider stage must not start"); },
          async releaseTask() {},
          async settleTask() {}
        } });
        await admission.executeTask({}, async () => { throw new Error("provider execute must not run"); });
      }
      providerCalls.push(options);
      if (Number.isFinite(measuredCost)) usageEntries.push({ scene: RECORD_COMPRESSION_TASK_KIND,
        createdAt: getClockAsOf(), costKnown: true, costCny: measuredCost });
      if (failProvider) throw Object.assign(new Error("合成摘要失败"), { code: "SYNTHETIC_MODEL_FAILURE" });
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
    recordCompressionStartDate: startDate,
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
assert.equal(boundedWaitScan.backfillRegisteredCount, 2);
assert.equal(boundedWaitScan.waitingBudgetCount, 4);
assert.equal(persistedWaits().length, 4, "最新闭合主槽、两个有来源回填槽和独立历史补充都保持预算等待");
assert.deepEqual(boundedWaitScan.waitingBudgetTaskIds.map(id => currentStore.aiTasks.find(task => task.id === id))
  .filter(task => task.payload.operation === "daily").map(task => task.payload.localDate),
  ["2026-10-10", "2026-10-09", "2026-10-08"], "new budget waits start at the newest closed source slots");
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
assert.equal(boundaryDailyTask.payload.timezone, DEFAULT_RECORD_TIMEZONE,
  "新普通日压缩窗口固定上海时区，不随账户设置回退全天");
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

// 同源旧失败仅创建一个受控新代际，真实tasks规范下身份不截断，失败后不每轮重试。
currentStore = createEmptyStore();
addSource(currentStore, "repair-source", "2026-10-10");
const terminalEvents = [];
const repairRuntime = createRuntime({ failProvider: true, measuredCost: 0.1 });
repairRuntime.observeRecordCompressionTasks(async event => terminalEvents.push(event));
const firstAttempt = await repairRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 1 });
const originalTask = currentStore.aiTasks.find(task => firstAttempt.taskIds.includes(task.id) && task.payload.operation === "daily");
await repairRuntime.backgroundAi.run(originalTask.id);
assert.equal(originalTask.status, "failed");
const originalTaskJson = JSON.stringify(originalTask);
const originalSummary = currentStore.recordCompressions.find(item => item.id === originalTask.payload.recordId);
const originalSummaryJson = JSON.stringify(originalSummary);
const repairAttempt = await repairRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 1 });
const repairedTask = currentStore.aiTasks.find(task => repairAttempt.taskIds.includes(task.id) && task.payload.operation === "daily");
assert.ok(repairedTask);
assert.notEqual(repairedTask.id, originalTask.id);
assert.notEqual(repairedTask.payload.recordId, originalTask.payload.recordId);
assert.ok(repairedTask.clientRequestId.startsWith("record-compression-repair-v1:"));
assert.ok(repairedTask.clientRequestId.length <= 100);
await repairRuntime.backgroundAi.run(repairedTask.id);
assert.equal(repairedTask.status, "failed");
assert.equal(JSON.stringify(originalTask), originalTaskJson);
assert.equal(JSON.stringify(originalSummary), originalSummaryJson);
assert.deepEqual(terminalEvents.map(event => [event.status, event.knownSpentCny]), [["failed", 0.1], ["failed", 0.2]]);
await repairRuntime.backgroundAi.run(repairedTask.id);
assert.equal(terminalEvents.length, 2, "replaying an already-terminal task does not announce generation again");
const callsAfterRepair = providerCalls.length;
const tasksAfterRepair = currentStore.aiTasks.length;
for (let scan = 0; scan < 3; scan += 1) {
  const stopped = await repairRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 1 });
  assert.equal(stopped.taskIds.filter(id => currentStore.aiTasks.find(task => task.id === id)?.payload.operation === "daily").length, 0);
  assert.equal(stopped.backfillRegisteredCount, 0);
}
assert.equal(currentStore.aiTasks.length, tasksAfterRepair);
assert.equal(providerCalls.length, callsAfterRepair);

// 生日起点为注入配置：25日包含、24日排除，等待登记与prepare/恢复遵循同一边界。
currentStore = createEmptyStore();
// 用真实旧输入与任务规范构造已存在的 v1 等待；新扫描不得再创建25日前的日任务。
currentStore = createEmptyStore();
addSource(currentStore, "outside-floor", "2026-09-24");
const legacyInput = buildRecordCompressionInput(currentStore, { accountId: "account-a", localDate: "2026-09-24",
  timezone: DEFAULT_RECORD_TIMEZONE, asOf, promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, sourcePermission: () => true, hash });
const legacyPayload = { operation: "daily", localDate: "2026-09-24", timezone: DEFAULT_RECORD_TIMEZONE,
  promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, sourceManifestHash: legacyInput.sourceManifestHash, recordId: "legacy-floor-summary" };
const oldFloorTask = createTaskLifecycle({ createId: () => "legacy-floor-task", now: () => asOf, hash }).create(currentStore.aiTasks, {
  kind: RECORD_COMPRESSION_TASK_KIND, targetId: legacyPayload.recordId, resourceType: RECORD_COMPRESSION_TASK_KIND,
  clientRequestId: "legacy-floor-request", payload: legacyPayload
}, () => ({ inputVersion: 1, inputHash: hash(JSON.stringify({ accountId: legacyInput.accountKey, localDate: legacyPayload.localDate,
  timezone: legacyPayload.timezone, promptVersion: legacyPayload.promptVersion, sourceManifestHash: legacyPayload.sourceManifestHash })) }),
{ waitingBudget: true }).task;
for (const date of ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]) addSource(currentStore, `floor-${date}`, date);
const scopedRuntime = createRuntime({ startDate: "2026-09-25" });
const scopedScan = await scopedRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 4, maxQueued: 0 });
assert.equal(oldFloorTask.status, "stale");
assert.equal(scopedScan.backfillRegisteredCount, 4);
assert.deepEqual(scopedScan.waitingBudgetTaskIds.map(id => currentStore.aiTasks.find(task => task.id === id))
  .filter(task => task.payload.operation === "daily").map(task => task.payload.localDate), ["2026-09-29", "2026-09-28", "2026-09-27", "2026-09-26"]);
assert.ok(currentStore.aiTasks.filter(task => task.status === WAITING_FOR_BUDGET_STATUS && task.payload.operation === "historicalSupplement")
  .every(task => task.payload.windowStart >= "2026-09-25"));
for (const task of currentStore.aiTasks.filter(task => task.status === WAITING_FOR_BUDGET_STATUS)) await scopedRuntime.backgroundAi.run(task.id);
assert.equal(providerCalls.length, callsAfterRepair, "waiting tasks never dispatch themselves");
const promotedFloor = await scopedRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 4, maxQueued: 5 });
assert.deepEqual(promotedFloor.taskIds.map(id => currentStore.aiTasks.find(task => task.id === id))
  .filter(task => task.payload.operation === "daily").map(task => task.payload.localDate),
  ["2026-09-29", "2026-09-28", "2026-09-27", "2026-09-26"],
  "the historical supplement shares the bounded budget slots with the newest daily work");
for (const id of promotedFloor.taskIds) await scopedRuntime.backgroundAi.run(id);
const includeBirthday = await scopedRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 1 });
assert.ok(includeBirthday.taskIds.some(id => currentStore.aiTasks.find(task => task.id === id)?.payload.localDate === "2026-09-25"));
assert.ok(!includeBirthday.taskIds.some(id => currentStore.aiTasks.find(task => task.id === id)?.payload.localDate < "2026-09-25"));

const boundedService = createRecordCompressionService({ repository, getAccountId: () => "account-a",
  now: () => asOf, hash, startDate: "2026-09-25" });
assert.equal(boundedService.buildInput(currentStore, "2026-09-24"), null);
assert.equal(boundedService.target.prepare(currentStore, oldFloorTask), null);
assert.deepEqual(boundedService.getCurrentTrend(currentStore, "2026-09-25T08:00:00.000Z").localDates, ["2026-09-25"]);
assert.deepEqual(boundedService.getCurrentTrend(currentStore, "2026-09-24T08:00:00.000Z").localDates, []);

// 扫描后发生的实际预算准入拒绝进入同身份等待，恢复只重新校验该任务。
currentStore = createEmptyStore();
addSource(currentStore, "admission-source");
let denyQuota = true;
const admissionRuntime = createRuntime({ denyAdmission: () => denyQuota });
const admissionScan = await admissionRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 1 });
const admissionTask = currentStore.aiTasks.find(task => admissionScan.taskIds.includes(task.id) && task.payload.operation === "daily");
const beforeAdmissionCalls = providerCalls.length;
await admissionRuntime.backgroundAi.run(admissionTask.id);
assert.equal(admissionTask.status, WAITING_FOR_BUDGET_STATUS);
assert.equal(admissionTask.errorCode, "AI_DAILY_CALL_LIMIT");
assert.equal(providerCalls.length, beforeAdmissionCalls);
assert.equal(currentStore.recordCompressions.find(summary => summary.id === admissionTask.payload.recordId).status, "queued");
denyQuota = false;
const resumedAdmission = await admissionRuntime.runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 1, maxQueued: 2 });
assert.ok(resumedAdmission.taskIds.includes(admissionTask.id),
  "recovery must revalidate and promote the task that hit admission instead of only creating new work");
let failedNotifications = 0;
admissionRuntime.observeRecordCompressionTasks(async () => { failedNotifications += 1; throw new Error("notify unavailable"); });
await admissionRuntime.backgroundAi.run(admissionTask.id);
assert.equal(admissionTask.status, "succeeded");
assert.equal(failedNotifications, 1);
assert.equal(providerCalls.length, beforeAdmissionCalls + 1);

// 观察器失败不能将已存ready变成failed或触发新代际重跑。
const terminalTaskCount = currentStore.aiTasks.length;
await admissionRuntime.backgroundAi.run(admissionTask.id);
assert.equal(admissionTask.status, "succeeded");
assert.equal(currentStore.aiTasks.length, terminalTaskCount);

assert.equal(failedNotifications, 1);
const retainedReady = currentStore.recordCompressions.find(summary => summary.id === admissionTask.payload.recordId);
const retainedReadyJson = JSON.stringify(retainedReady);
const obsoleteQueued = { ...structuredClone(admissionTask), id: "obsolete-ready-duplicate", clientRequestId: "obsolete-ready-duplicate", status: "queued" };
currentStore.aiTasks.push(obsoleteQueued);
const callsBeforeObsolete = providerCalls.length;
await admissionRuntime.backgroundAi.run(obsoleteQueued.id);
assert.equal(obsoleteQueued.status, "stale");
assert.equal(providerCalls.length, callsBeforeObsolete);
assert.equal(JSON.stringify(retainedReady), retainedReadyJson, "retiring a duplicate queued task must not downgrade or delete a valid ready summary");
currentStore = createEmptyStore();
addSource(currentStore, "ai-only-source");
Object.assign(currentStore.thoughts[0], { origin: "ai_generated", authorType: "ai" });
const aiOnlyScan = await createRuntime().runRecordCompressionScan({ asOf, slot: "backfill", backfillDates: 4, maxQueued: 4 });
assert.equal(aiOnlyScan.queuedCount, 0);
assert.equal(aiOnlyScan.waitingBudgetCount, 0);

// S2：连续多日新内容下，已等待的历史补充必须先拿到本轮唯一槽位，不能被最新日报长期挤到队尾。
currentStore = createEmptyStore();
idempotencyLedger.clear();
addSource(currentStore, "supplement-priority-source", "2026-10-10");
const priorityRuntime = createRuntime();
const priorityWaitScan = await priorityRuntime.runRecordCompressionScan({ asOf, slot: "evening", maxQueued: 0 });
assert.equal(priorityWaitScan.waitingBudgetCount, 2);

const nextDayAsOf = "2026-10-11T10:05:00.000Z";
addSource(currentStore, "supplement-priority-next", "2026-10-11");
const nextDayRuntime = createRuntime({ clockAsOf: nextDayAsOf });
const nextDayWaitScan = await nextDayRuntime.runRecordCompressionScan({
  asOf: nextDayAsOf, slot: "evening", maxQueued: 0
});
assert.ok(nextDayWaitScan.waitingBudgetCount >= 3,
  "new daily work joins the wait queue alongside the historical supplement");

const callsBeforePromotion = providerCalls.length;
const priorityPromotion = await nextDayRuntime.runRecordCompressionScan({
  asOf: nextDayAsOf, slot: "evening", maxQueued: 1
});
assert.equal(priorityPromotion.queuedCount, 1);
const promotedSupplement = currentStore.aiTasks.find(task => task.id === priorityPromotion.taskIds[0]);
assert.equal(promotedSupplement.payload.operation, "historicalSupplement",
  "an already-waiting historical supplement must be promoted before newer daily work");
assert.equal(promotedSupplement.status, "queued");
assert.equal(currentStore.aiTasks.filter(task => task.status === WAITING_FOR_BUDGET_STATUS
  && task.payload?.operation === "daily").length >= 2, true,
  "daily work stays durably waiting instead of being dropped");
await nextDayRuntime.backgroundAi.run(promotedSupplement.id);
assert.notEqual(promotedSupplement.status, WAITING_FOR_BUDGET_STATUS,
  "the promoted supplement must move forward instead of falling back to the wait queue");
assert.notEqual(promotedSupplement.status, "queued",
  "the promoted supplement must reach a terminal state");
assert.equal(providerCalls.length, callsBeforePromotion + 1, "promotion executes exactly one bounded call");

console.log("Record-compression durable budget-wait, recovery, bounds and diagnostics regression passed.");
