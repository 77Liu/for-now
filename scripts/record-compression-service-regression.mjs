import { createAiGenerator } from "../src/modules/ai/generation.mjs";
import { createDeepSeekTransport } from "../src/infrastructure/ai-providers/index.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createContentRuntime,
  createEmptyStore,
  currentRecordCompressionTrend,
  DEFAULT_RECORD_TIMEZONE,
  projectRecordCompressionTrendForUser,
  recordCompressionAccountOrder
} from "../src/app/index.mjs";
import {
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_TASK_KIND
} from "../src/modules/record-compressions/index.mjs";

const rotationAccounts = [{ id: "account-a" }, { id: "account-b" }, { id: "account-c" }];
const rotationIds = plan => plan.orderedUsers.map(user => user.id);
const dayOneOrder = recordCompressionAccountOrder(rotationAccounts, {
  globalDay: "2026-10-10"
});
const nextDayOrder = recordCompressionAccountOrder(rotationAccounts, {
  globalDay: "2026-10-11"
});
assert.deepEqual(rotationIds(dayOneOrder), ["account-a", "account-b", "account-c"]);
assert.deepEqual(rotationIds(nextDayOrder), ["account-b", "account-c", "account-a"],
  "the first account must rotate on the next day even when daily capacity is a multiple of account count");
assert.deepEqual(rotationIds(recordCompressionAccountOrder(rotationAccounts, {
  globalDay: "2026-10-10",
  knownCalls: 2
})), ["account-c", "account-a", "account-b"],
"known calls must advance the account offset");
assert.deepEqual(rotationIds(recordCompressionAccountOrder(rotationAccounts, {
  globalDay: "2026-10-10",
  knownCalls: 2,
  reservedCalls: 1
})), ["account-a", "account-b", "account-c"],
"known and reserved calls must both advance the account offset");
assert.deepEqual(recordCompressionAccountOrder([], {
  globalDay: "2026-10-10",
  knownCalls: 2,
  reservedCalls: 1
}), { startingOffset: 0, orderedUsers: [] }, "an empty account set must produce an empty schedule");

let currentNow = "2026-10-10T08:00:00.000Z";
let currentTimezone = DEFAULT_RECORD_TIMEZONE;
const now = () => currentNow;
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const store = createEmptyStore();
store.thoughts.push({
  id: "thought-source",
  type: "question",
  content: "今天希望把散落的事情整理成一个可执行步骤。",
  authorType: "user",
  origin: "manual",
  occurredAt: "2026-10-10T07:00:00.000Z",
  occurredOn: "2026-10-10",
  version: 1,
  disposition: "pending"
});
const scheduled = [];
const calls = [];
const ledger = new Map();
let holdCompressionProvider = false;
const pendingCompressionCalls = [];
const emptyCompressionOutput = () => JSON.stringify({
  schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  daily: { observations: [], metricKeys: [], missing: [] },
  thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
  other: { themes: [], collectedQuotes: [] },
  aiReference: [],
  stableUserCandidates: [],
  conflicts: [],
  warnings: []
});

const repository = {
  async read() { return structuredClone(store); },
  async update(operation) { return operation(store); },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`;
    const existing = ledger.get(key);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("幂等请求内容不一致"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return structuredClone(onReplay(structuredClone(existing.response)));
    }
    const response = await operation(store);
    ledger.set(key, { requestHash: request.requestHash, response: structuredClone(response) });
    return response;
  },
  async transact(operation) {
    return operation({ document: store, commit: async () => {} });
  }
};

// 使用真实transport/generator的返回契约，避免mock总返回对象掩盖纯字符串响应。
const providerAudits = [];
const generator = createAiGenerator({
  readSettings: async () => ({ apiKey: "synthetic-no-network-key" }),
  getContext: () => ({ user: { id: "account-a" }, secrets: [] }),
  reserveAttempt: async () => ({ release() {}, commit() {} }),
  gate: { acquire: async () => () => {} },
  audit: {
    text: value => value,
    message: value => value,
    start: async () => {},
    recordDeepSeekAttempt: async entry => { providerAudits.push(entry); }
  },
  provider: createDeepSeekTransport({
    endpoint: "https://synthetic.invalid/chat/completions",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.response_format.type, "json_object");
      const content = request.messages.some(message => String(message.content)
        .includes("historical-user-supplement-output.v1"))
        ? JSON.stringify({ schemaVersion: "historical-user-supplement-output.v1", candidates: [] })
        : emptyCompressionOutput();
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content, reasoning_content: "合成思考，不应保存" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      }));
    }
  })
});

const runtime = createContentRuntime({
  repository,
  trashRetentionDays: 30,
  getAccountId: () => "account-a",
  getTimezone: () => currentTimezone,
  getCursorScope: () => "account-a",
  backgroundContextKey: () => "account-a",
  workflowContextKey: () => "account-a",
  dispatchBackground: callback => scheduled.push(callback),
  async runDeepSeek(prompt, options) {
    calls.push(options);
    if (holdCompressionProvider && options.scene === RECORD_COMPRESSION_TASK_KIND) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("合成 provider 请求已中止"), {
          name: "AbortError",
          code: "AI_TASK_CANCELLED"
        }));
        const request = {
          prompt,
          signal: options.signal,
          resolve: () => resolve(emptyCompressionOutput())
        };
        pendingCompressionCalls.push(request);
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const result = await generator(prompt, options);
    assert.equal(typeof result, "string", "captureReasoning:false必须沿真实generator返回字符串");
    return result;
  },
  async readAiUsage() { return { entries: [] }; },
  recordCompressionDailyBudgetCny: 1,
  recordCompressionPerCallBudgetCny: 0.25,
  recordCompressionMaxBackfillDatesPerScan: 2,
  now,
  today: () => "2026-10-10",
  currentTime: () => Date.parse(now()),
  createId: (() => { let id = 0; return () => `compression-task-${++id}`; })(),
  hash,
  async logEvent() {},
  async debugFetch() { return { ok: true }; },
  mediaFactory: () => ({
    attachmentCleanup: { enqueue() {}, async drain() { return { attempted: 0, pending: 0, removed: [] }; }, schedule() {} },
    speechProvider: { configured: false, supportedAsrMimeTypes: [] },
    visionProvider: { configured: false },
    async listAttachmentInventory() { return []; },
    async materializeAttachmentFiles() { return []; },
    async transcribeCapture() { return null; }
  })
});

assert.equal(typeof runtime.runRecordCompressionScan, "function");
const queued = await runtime.runRecordCompressionScan({ asOf: now(), maxQueued: 1 });
assert.equal(queued.queued, true);
assert.equal(scheduled.length, 1);
assert.equal(store.recordCompressions[0].status, "queued");
const firstTask = store.aiTasks.find(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND && task.status === "queued"
));
assert.ok(firstTask);

await runtime.backgroundAi.run(firstTask.id);
assert.equal(calls.length, 1);
assert.equal(calls[0].scene, RECORD_COMPRESSION_TASK_KIND);
assert.equal(calls[0].json, true);
assert.equal(calls[0].maxTokens, 900);
assert.equal(calls[0].captureReasoning, false);
assert.equal(typeof calls[0].isCurrent, "function",
  "content background must pass the exact task-current callback through to the provider wrapper");
assert.equal(firstTask.status, "succeeded");
const firstSummary = store.recordCompressions.find(item => item.id === firstTask.payload.recordId);
assert.equal(firstSummary.status, "ready");
assert.equal(Boolean(firstSummary.generatedAt), true);
assert.equal(providerAudits[0].audit.status, "success");
assert.equal(JSON.stringify(firstSummary).includes("合成思考"), false);
assert.equal(firstSummary.sourceManifest.length, 1);
assert.equal(firstSummary.tokenUsage.outputTokens <= 900, true);

const trend = currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf: now(),
  hash
});
assert.equal(trend.payload.availableDays, 1);
assert.deepEqual(trend.payload.missingDates, [
  "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"
]);
assert.ok(trend.payload.localDates.includes("2026-10-10"));
const initialUserTrend = projectRecordCompressionTrendForUser(trend);
assert.equal(initialUserTrend.days.length, 7);
assert.equal(initialUserTrend.days.find(day => day.localDate === "2026-10-10").status, "ready");
assert.deepEqual(initialUserTrend.coverage.missingDates, trend.payload.missingDates);
const otherAccountStore = createEmptyStore();
const otherAccountTrend = projectRecordCompressionTrendForUser(currentRecordCompressionTrend(otherAccountStore, {
  accountId: "account-b",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf: now(),
  hash
}));
assert.equal(otherAccountTrend.days.find(day => day.localDate === "2026-10-10").status, "missing",
  "an account-scoped empty store must not inherit another account's ready summaries");

const sourceRef = {
  resourceType: "thought",
  resourceId: "thought-source",
  rootId: "thought-source",
  targetKey: "question:thought-source",
  version: 1
};
const denied = await runtime.perception.updatePermissions({
  sourceRef,
  contextAllowed: false,
  learningAllowed: false,
  expectedRevision: 0
});
assert.equal(denied.permission.contextAllowed, false);
assert.equal(firstSummary.status, "invalidated");
assert.deepEqual(firstSummary.sourceManifest, []);
assert.deepEqual(firstSummary.sourceRefs, []);
assert.deepEqual(firstSummary.daily.observations, []);
assert.deepEqual(firstSummary.thoughtsIdeas.focus, []);
assert.deepEqual(firstSummary.metrics, []);
assert.equal(JSON.stringify(firstSummary).includes("把散落的事情整理"), false,
  "revoking source context must clear persisted derived text and source references");
const changedTrend = currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf: now(),
  hash
});
assert.equal(changedTrend.payload.availableDays, 0);
assert.ok(changedTrend.payload.missingDates.includes("2026-10-10"));
const permissionFilteredUserView = projectRecordCompressionTrendForUser(changedTrend);
assert.equal(permissionFilteredUserView.days.find(day => day.localDate === "2026-10-10").status, "missing",
  "permission withdrawal must remove the existing summary from the user-visible trend");
assert.equal(JSON.stringify(permissionFilteredUserView).includes("把散落的事情整理"), false);

const allowed = await runtime.perception.updatePermissions({
  sourceRef,
  contextAllowed: true,
  learningAllowed: false,
  expectedRevision: denied.permission.revision
});
assert.equal(allowed.permission.contextAllowed, true);
const changedSourceQueued = await runtime.runRecordCompressionScan({ asOf: now(), maxQueued: 1 });
assert.equal(changedSourceQueued.queued, true);
const staleTask = store.aiTasks.find(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND
  && task.payload?.operation !== "historicalSupplement"
  && task.id !== firstTask.id
  && task.status === "queued"
));
assert.ok(staleTask);
await runtime.updateSourceStore(current => {
  current.thoughts[0].content = "源文本在调用前再次变化。";
  current.thoughts[0].version += 1;
});
const invalidatedQueuedSummary = store.recordCompressions.find(item => (
  item.id === staleTask.payload.recordId
));
assert.equal(invalidatedQueuedSummary.status, "invalidated");
assert.deepEqual(invalidatedQueuedSummary.sourceRefs, []);
assert.equal(JSON.stringify(invalidatedQueuedSummary).includes("不得"), false);
await runtime.backgroundAi.run(staleTask.id);
assert.equal(staleTask.status, "stale");
assert.equal(calls.length, 1, "stale inputs must be rejected before the model call");
assert.equal(store.recordCompressions.find(item => item.id === staleTask.payload.recordId).status, "invalidated");

const latestSourceQueued = await runtime.runRecordCompressionScan({ asOf: now(), maxQueued: 1 });
assert.equal(latestSourceQueued.queued, true);
const latestTask = store.aiTasks.find(task => task.id === latestSourceQueued.taskId);
await runtime.backgroundAi.run(latestTask.id);
assert.equal(latestTask.status, "succeeded");
const latestSummary = store.recordCompressions.find(item => item.id === latestTask.payload.recordId);
assert.equal(latestSummary.status, "ready");
const trashEntry = await runtime.updateSourceStore(current => (
  runtime.trashMutations.moveCollectionItemToTrash(
    current,
    "thoughts",
    "thoughtChain",
    "thought-source"
  )
));
assert.ok(trashEntry.id);
assert.equal(latestSummary.status, "invalidated");
assert.deepEqual(latestSummary.sourceManifest, []);
assert.deepEqual(latestSummary.sourceRefs, []);
assert.deepEqual(latestSummary.metrics, []);
assert.equal(JSON.stringify(latestSummary).includes("源文本在调用前再次变化"), false,
  "moving a source to trash must clear its persisted summary immediately");
const purgePreview = await runtime.trashCommands.preview([trashEntry.id]);
const purged = await runtime.trashCommands.purge([trashEntry.id], purgePreview.planHash);
assert.equal(purged.entries.length, 1);
assert.equal((await runtime.trashCommands.list()).items.length, 0);
assert.equal(latestSummary.status, "invalidated");
assert.deepEqual(latestSummary.sourceRefs, []);
assert.equal(JSON.stringify(latestSummary).includes("源文本在调用前再次变化"), false,
  "permanent trash purge must keep derived text cleared through the transaction wrapper");

store.thoughts.push(
  {
    id: "in-flight-revoked-source",
    type: "question",
    content: "撤权必须中止已经发出的 provider 请求。",
    authorType: "user",
    origin: "manual",
    occurredAt: "2026-10-10T07:00:00.000Z",
    occurredOn: "2026-10-10",
    version: 1
  },
  {
    id: "in-flight-unaffected-source",
    type: "question",
    content: "另一个日期的任务应继续运行。",
    authorType: "user",
    origin: "manual",
    occurredAt: "2026-10-09T07:00:00.000Z",
    occurredOn: "2026-10-09",
    version: 1
  }
);
const inFlightBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "morning", backfillDates: 0, maxQueued: 2
});
assert.equal(inFlightBatch.queuedCount, 2);
const inFlightTasks = inFlightBatch.taskIds.map(taskId => store.aiTasks.find(task => task.id === taskId));
const runInFlightTasks = inFlightTasks.map(task => runtime.backgroundAi.run(task.id));
holdCompressionProvider = true;
const inFlightRequestStart = pendingCompressionCalls.length;
for (let attempt = 0; attempt < 100 && pendingCompressionCalls.length < 2; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 0));
}
const inFlightRequests = pendingCompressionCalls.slice(inFlightRequestStart);
assert.equal(inFlightRequests.length, 2, "both unrelated compression tasks must reach the provider");
const revokedTask = inFlightTasks.find(task => task.payload.localDate === "2026-10-10");
const foreignPayload = structuredClone(revokedTask.payload);
const foreignAccountKey = hash("account:account-b").slice(0, 32);
const foreignTask = {
  id: "other-account-running-task",
  kind: RECORD_COMPRESSION_TASK_KIND,
  status: "running",
  payload: foreignPayload,
  requestedInputHash: hash(JSON.stringify({
    accountId: foreignAccountKey,
    localDate: foreignPayload.localDate,
    timezone: foreignPayload.timezone,
    promptVersion: foreignPayload.promptVersion,
    sourceManifestHash: foreignPayload.sourceManifestHash
  }))
};
store.aiTasks.push(foreignTask);
const revokedRequest = inFlightRequests.find(request => (
  request.prompt.includes("撤权必须中止")
));
const unaffectedRequest = inFlightRequests.find(request => (
  request.prompt.includes("另一个日期的任务")
));
assert.ok(revokedRequest);
assert.ok(unaffectedRequest);
assert.equal(revokedRequest.signal.aborted, false);
assert.equal(unaffectedRequest.signal.aborted, false);
const cancelledTaskIds = [];
const cancelBackgroundTask = runtime.backgroundAi.cancel;
runtime.backgroundAi.cancel = taskId => {
  cancelledTaskIds.push(taskId);
  return cancelBackgroundTask(taskId);
};
await runtime.perception.updatePermissions({
  sourceRef: {
    resourceType: "thought",
    resourceId: "in-flight-revoked-source",
    rootId: "in-flight-revoked-source",
    targetKey: "question:in-flight-revoked-source",
    version: 1
  },
  contextAllowed: false,
  learningAllowed: false,
  expectedRevision: 0
});
runtime.backgroundAi.cancel = cancelBackgroundTask;
assert.deepEqual(cancelledTaskIds, [revokedTask.id],
  "source invalidation must not cancel a task belonging to another account");
assert.equal(foreignTask.status, "running");
store.aiTasks = store.aiTasks.filter(task => task.id !== foreignTask.id);
assert.equal(revokedRequest.signal.aborted, true,
  "source permission revocation must abort the matching in-flight provider request");
assert.equal(unaffectedRequest.signal.aborted, false,
  "source revocation must not abort a different task for another date");
unaffectedRequest.resolve();
await Promise.all(runInFlightTasks);
holdCompressionProvider = false;
assert.equal(inFlightTasks.find(task => task.payload.localDate === "2026-10-10")?.status, "stale",
  "aborted output must leave the task stale after the post-response source check");
assert.equal(inFlightTasks.find(task => task.payload.localDate === "2026-10-09")?.status, "succeeded",
  "an unrelated task must still be able to save");

const addThought = (id, date, content, occurredAt = `${date}T07:00:00.000Z`) => store.thoughts.push({
  id,
  type: "question",
  content,
  authorType: "user",
  origin: "manual",
  occurredAt,
  occurredOn: date,
  version: 1
});
const runTasks = async taskIds => {
  for (const taskId of taskIds) await runtime.backgroundAi.run(taskId);
};
const datesForTasks = taskIds => taskIds.map(taskId => (
  store.aiTasks.find(task => task.id === taskId)?.payload.localDate
));
const datesForPrimaryTasks = taskIds => taskIds.flatMap(taskId => {
  const task = store.aiTasks.find(item => item.id === taskId);
  return task?.payload?.operation === "daily" ? [task.payload.localDate] : [];
});
const summaryForTask = taskId => {
  const task = store.aiTasks.find(item => item.id === taskId);
  return store.recordCompressions.find(item => item.id === task?.payload?.recordId);
};

addThought("yesterday-source", "2026-10-09", "昨天需要优先完成的合成记录。");
addThought("today-source", "2026-10-10", "今天已有摘要后新增的合成记录。", "2026-10-09T21:00:00.000Z");
const morningAsOf = "2026-10-09T22:00:00.000Z";
currentNow = morningAsOf;
store.recordCompressions = store.recordCompressions.filter(summary => (
  summary.localDate !== "2026-10-10"
));
const morning = await runtime.runRecordCompressionScan({
  asOf: morningAsOf,
  slot: "morning",
  backfillDates: 0,
  maxQueued: 1
});
assert.equal(morning.primaryQueuedCount, 1,
  "06:00 first run must queue yesterday without spending a call on a new current-day summary");
assert.deepEqual(datesForPrimaryTasks(morning.taskIds), ["2026-10-09"]);
const morningDailyTask = morning.taskIds.find(taskId => (
  store.aiTasks.find(task => task.id === taskId)?.payload?.operation === "daily"
));
assert.equal(summaryForTask(morningDailyTask)?.window.completeness, "complete");
await runTasks(morning.taskIds);

currentNow = "2026-10-10T10:05:00.000Z";
const evening = await runtime.runRecordCompressionScan({
  asOf: now(),
  slot: "evening",
  backfillDates: 0,
  maxQueued: 1
});
assert.equal(evening.queuedCount, 1);
assert.equal(evening.primaryQueuedCount, 1);
assert.deepEqual(datesForPrimaryTasks(evening.taskIds), ["2026-10-10"]);
const eveningDailyTask = evening.taskIds.find(taskId => (
  store.aiTasks.find(task => task.id === taskId)?.payload?.operation === "daily"
));
assert.equal(summaryForTask(eveningDailyTask)?.window.completeness, "partial",
  "the 18:05 main task must summarize today's partial window");
await runTasks(evening.taskIds);

const storeBeforeCrossTimezone = structuredClone(store);
currentTimezone = "America/Los_Angeles";
const priorEvening = await runtime.runRecordCompressionScan({
  asOf: currentNow,
  slot: "evening",
  backfillDates: 0,
  maxQueued: 1
});
assert.deepEqual(datesForPrimaryTasks(priorEvening.taskIds), ["2026-10-10"],
  "the prior Shanghai evening must create the Los Angeles current-day summary");
await runTasks(priorEvening.taskIds);
const crossTimezoneThoughts = structuredClone(store.thoughts);
store.thoughts = store.thoughts.filter(source => source.occurredOn !== "2026-10-10");
const oldDateWait = await runtime.runRecordCompressionScan({
  asOf: currentNow,
  slot: "backfill",
  backfillDates: 1,
  maxQueued: 0
});
assert.ok(oldDateWait.waitingBudgetCount > 0);
const oldDateWaitingTask = store.aiTasks.find(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND
  && task.status === "waitingBudget"
  && task.payload?.operation === "daily"
  && task.payload?.localDate === "2026-10-09"
  && task.payload?.timezone === currentTimezone
));
assert.ok(oldDateWaitingTask,
  "the synthetic fixture must contain an older date waiting for budget");
store.thoughts = crossTimezoneThoughts;
await runtime.updateSourceStore(current => {
  const source = current.thoughts.find(item => item.id === "today-source");
  source.content = "次日06:00前，已存在的当日摘要来源发生变化。";
  source.version += 1;
});
const eveningPriority = await runtime.runRecordCompressionScan({
  asOf: currentNow,
  slot: "evening",
  backfillDates: 0,
  maxQueued: 1
});
assert.equal(eveningPriority.primaryQueuedCount, 1,
  "the 18:05 current-day primary must use its reserved slot before older daily waits");
assert.deepEqual(datesForPrimaryTasks(eveningPriority.taskIds), ["2026-10-10"]);
assert.equal(oldDateWaitingTask.status, "waitingBudget",
  "an older daily wait must remain waiting when the evening slot is reserved for today");
await runTasks(eveningPriority.taskIds);

await runtime.updateSourceStore(current => {
  const source = current.thoughts.find(item => item.id === "today-source");
  source.content = "次日早晨前再次变化的当日来源。";
  source.version += 1;
});
currentNow = "2026-10-10T22:00:00.000Z";
const morningRefresh = await runtime.runRecordCompressionScan({
  asOf: now(),
  slot: "morning",
  backfillDates: 0,
  maxQueued: 1
});
assert.equal(morningRefresh.primaryQueuedCount, 1,
  "06:00 must complete the previous day while reserving the remaining invocation for 18:05");
assert.deepEqual(datesForPrimaryTasks(morningRefresh.taskIds), ["2026-10-09"]);
const morningTodayWaiter = store.aiTasks.find(task => (
  morningRefresh.waitingBudgetTaskIds.includes(task.id)
  && task.payload?.operation === "daily"
  && task.payload?.localDate === "2026-10-10"
  && task.payload?.timezone === currentTimezone
));
assert.ok(morningTodayWaiter,
  "an existing current-day summary that changed after yesterday used the morning slot must persist for revalidation");
assert.equal(morningTodayWaiter.status, "waitingBudget");
const morningTodayTask = morningRefresh.taskIds.find(taskId => (
  store.aiTasks.find(task => task.id === taskId)?.payload?.operation === "daily"
  && store.aiTasks.find(task => task.id === taskId)?.payload?.localDate === "2026-10-10"
));
assert.equal(morningTodayTask, undefined);
await runTasks(morningRefresh.taskIds);

for (const key of Object.keys(store)) delete store[key];
Object.assign(store, storeBeforeCrossTimezone);
currentTimezone = DEFAULT_RECORD_TIMEZONE;
currentNow = "2026-10-10T10:05:00.000Z";

for (let day = 4; day <= 8; day += 1) {
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  addThought(`backfill-${day}`, date, `${date}需要纳入七天趋势的历史记录。`);
}
const firstHistoryBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(firstHistoryBatch.queuedCount, 1);
assert.deepEqual(datesForTasks(firstHistoryBatch.taskIds), ["2026-10-04"],
  "first-run history must begin with the oldest missing dates in the seven-day window");
const secondHistoryBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(secondHistoryBatch.queuedCount, 1);
assert.deepEqual(datesForTasks(secondHistoryBatch.taskIds), ["2026-10-05"]);
const thirdHistoryBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 2
});
assert.equal(thirdHistoryBatch.queuedCount, 2);
assert.deepEqual(datesForTasks(thirdHistoryBatch.taskIds), ["2026-10-06", "2026-10-07"]);
const accountBudgetCap = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(accountBudgetCap.queuedCount, 0,
  "queued tasks must reserve per-call cost before another batch can exceed the account daily budget");
assert.equal(store.aiTasks.filter(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND && ["queued", "running"].includes(task.status)
)).length, 4);
await runTasks([
  ...firstHistoryBatch.taskIds,
  ...secondHistoryBatch.taskIds,
  ...thirdHistoryBatch.taskIds
]);
const finalHistoryBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(finalHistoryBatch.queuedCount, 1);
assert.deepEqual(datesForTasks(finalHistoryBatch.taskIds), ["2026-10-08"]);
await runTasks(finalHistoryBatch.taskIds);

const sevenDayDates = Array.from({ length: 7 }, (_, index) => `2026-10-${String(index + 4).padStart(2, "0")}`);
const readyDates = new Set(store.recordCompressions
  .filter(summary => summary.status === "ready")
  .map(summary => summary.localDate));
assert.ok(sevenDayDates.every(date => readyDates.has(date)),
  "bounded batches must eventually fill all seven days of history");
const sevenDayTrend = currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf: now(),
  hash
});
assert.equal(sevenDayTrend.payload.availableDays, 7, JSON.stringify({
  availableDays: sevenDayTrend.payload.availableDays,
  missingDates: sevenDayTrend.payload.missingDates,
  trendDays: sevenDayTrend.payload.days
}));
assert.deepEqual(sevenDayTrend.payload.missingDates, []);

await runtime.updateSourceStore(current => {
  const source = current.thoughts.find(item => item.id === "backfill-4");
  source.content = "最早日期的来源被编辑，必须允许旧日期重新压缩。";
  source.version += 1;
});
const staleSevenDayView = projectRecordCompressionTrendForUser(currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf: now(),
  hash
}));
assert.equal(staleSevenDayView.days.find(day => day.localDate === "2026-10-04").status, "missing",
  "editing a source must immediately hide its now-stale daily summary from the user view");
const dirtyHistoryBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(dirtyHistoryBatch.queuedCount, 1);
assert.deepEqual(datesForTasks(dirtyHistoryBatch.taskIds), ["2026-10-04"],
  "an edited old date must be eligible for a later bounded backfill batch");
await runTasks(dirtyHistoryBatch.taskIds);

const unchangedBatch = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(unchangedBatch.primaryQueuedCount, 0,
  "unchanged primary summaries must not enqueue duplicate work");
assert.equal(unchangedBatch.backfillQueuedCount, 0,
  "unchanged backfill summaries must not enqueue duplicate work");
assert.equal(unchangedBatch.historicalSupplementQueuedCount, 1,
  "the independent historical supplement is queued once when its coverage is still missing");

await runtime.updateSourceStore(current => {
  current.thoughts = [
    {
      id: "deep-history-sep-01",
      type: "question",
      content: "更早历史来源一，供渐进回填验证。",
      authorType: "user",
      origin: "manual",
      occurredAt: "2026-09-01T08:00:00.000Z",
      occurredOn: "2026-09-01",
      version: 1
    },
    {
      id: "deep-history-sep-30",
      type: "question",
      content: "更早历史来源二，供渐进回填验证。",
      authorType: "user",
      origin: "manual",
      occurredAt: "2026-09-30T08:00:00.000Z",
      occurredOn: "2026-09-30",
      version: 1
    }
  ];
});
const olderDailyFirst = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 1, maxQueued: 1
});
assert.equal(olderDailyFirst.queuedCount, 1);
assert.deepEqual(datesForTasks(olderDailyFirst.taskIds), ["2026-09-01"],
  "daily backfill progresses to the oldest eligible source beyond the recent seven-day window");
await runTasks(olderDailyFirst.taskIds);
const olderDailySecond = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 1, maxQueued: 1
});
assert.equal(olderDailySecond.queuedCount, 1);
assert.deepEqual(datesForTasks(olderDailySecond.taskIds), ["2026-09-30"],
  "later bounded scans continue to another older source date without repeating completed dates");
await runTasks(olderDailySecond.taskIds);

await runtime.updateSourceStore(current => {
  const source = current.thoughts.find(item => item.id === "deep-history-sep-30");
  source.content = "更早历史来源二编辑后，必须重新进入有界日报回填。";
  source.version += 1;
});
const olderDailyChanged = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 1, maxQueued: 1
});
assert.equal(olderDailyChanged.queuedCount, 1);
assert.deepEqual(datesForTasks(olderDailyChanged.taskIds), ["2026-09-30"],
  "editing an already-compressed date beyond seven days must make that date eligible again");
await runTasks(olderDailyChanged.taskIds);
const olderDailyUnchanged = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 1, maxQueued: 1
});
assert.equal(olderDailyUnchanged.backfillQueuedCount, 0,
  "a successfully refreshed older date must not be queued again without another source change");

const taskCountBeforeEmptyScan = store.aiTasks.length;
await runtime.updateSourceStore(current => {
  current.thoughts = [];
});
const emptyScan = await runtime.runRecordCompressionScan({
  asOf: now(), slot: "backfill", backfillDates: 2, maxQueued: 1
});
assert.equal(emptyScan.queuedCount, 0, "source-empty dates must not enqueue tasks");
assert.equal(store.aiTasks.length, taskCountBeforeEmptyScan);

console.log("Record-compression service, stale-input fence and seven-day trend integration regression passed.");
