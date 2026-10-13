import { createAiGenerator } from "../src/modules/ai/index.mjs";
import { createDeepSeekTransport } from "../src/infrastructure/ai-providers/index.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  compileWorkingContextPrompt,
  createContentRuntime,
  createEmptyStore,
  currentRecordCompressionTrend,
  createAiTaskTargets,
  createBackgroundAi,
  contextDerivedOutputAllowed,
  parseVerifiedAnswer,
  workingContextReceiptFingerprint
} from "../src/app/index.mjs";
import {
  estimateHistoricalUserSupplementTokens,
  HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET,
  HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
  HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET,
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_TASK_KIND
} from "../src/modules/record-compressions/index.mjs";
import { recordCompressionAccountQueueAllowance } from "../src/config/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import { createThoughtTaskTarget } from "../src/modules/thoughts/index.mjs";

const asOf = "2026-10-10T08:00:00.000Z";
let calls = [];
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const store = createEmptyStore();
store.thoughts.push(
  {
    id: "y",
    type: "question",
    content: "我会先拆解复杂目标，再逐项推进。",
    authorType: "user",
    origin: "manual",
    occurredAt: "2026-10-09T07:00:00.000Z",
    occurredOn: "2026-10-09",
    version: 1
  },
  {
    id: "t",
    type: "question",
    content: "遇到复杂任务时，我通常先拆成几个小步骤。",
    authorType: "user",
    origin: "manual",
    occurredAt: "2026-10-10T07:00:00.000Z",
    occurredOn: "2026-10-10",
    version: 1,
    remarks: [{
      id: "ai-only-remark",
      text: "AI_ONLY_MARKER: 这不是用户表达。",
      authorType: "ai",
      origin: "ai_generated",
      occurredAt: "2026-10-10T07:30:00.000Z",
      occurredOn: "2026-10-10",
      version: 1
    }]
  }
);
store.thoughts.push({
  id: "cross-timezone-source",
  type: "question",
  content: "CROSS_TZ_MARKER: 这条发生时间在上海日期为10月10日，在洛杉矶日期为10月9日。",
  authorType: "user",
  origin: "manual",
  occurredAt: "2026-10-10T01:00:00.000Z",
  version: 1
});
store.dailyRecords.push({
  id: "metric-only-heart-rate",
  type: "heartRate",
  source: "manual",
  average: 68,
  occurredAt: "2026-10-10T07:15:00.000Z",
  version: 1
});
store.recordCompressions.push({
  id: "synthetic-old-summary",
  status: "ready",
  aiReference: [{ text: "DAILY_AI_SUMMARY_MARKER" }]
});

const scheduled = [];
const ledger = new Map();
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

const parsePromptInput = prompt => {
  const marker = prompt.lastIndexOf("输入：");
  assert.notEqual(marker, -1, "synthetic provider prompt must include an input block");
  return JSON.parse(prompt.slice(marker + 3).trim());
};

// 合成供应商仅负责JSON内容；真实transport/generator负责响应解析和返回形态。
async function syntheticCompletion(prompt, options) {
  if (options.maxTokens === HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET) {
    const input = parsePromptInput(prompt);
    assert.deepEqual(Object.keys(input), ["schemaVersion", "userSources"]);
    assert.ok(input.userSources.length > 0);
    assert.ok(input.userSources.every(source => (
      Object.keys(source).sort().join(",") === "localDate,sourceId,text"
    )));
    assert.equal(JSON.stringify(input).includes("AI_ONLY_MARKER"), false);
    assert.equal(JSON.stringify(input).includes("DAILY_AI_SUMMARY_MARKER"), false);
    assert.equal(JSON.stringify(input).includes("sourceManifest"), false);
    assert.equal(JSON.stringify(input).includes("metrics"), false);
    assert.equal(prompt.includes("部分覆盖"), true);
    const crossTimezoneSource = input.userSources.find(item => (
      item.text.includes("CROSS_TZ_MARKER")
    ));
    assert.equal(crossTimezoneSource?.localDate, "2026-10-09",
      "historical input must use the account timezone when an event crosses the Shanghai date boundary");
    const source = input.userSources.find(item => item.localDate === "2026-10-10")
      || input.userSources[0];
    return {
      content: JSON.stringify({
        schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
        candidates: [{
          statement: "先拆成小步骤。",
          exactQuote: [...source.text].slice(0, 9).join(""),
          sourceId: source.sourceId
        }]
      })
    };
  }
  return {
    content: JSON.stringify({
      schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
      daily: { observations: [], metricKeys: [], missing: [] },
      thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
      other: { themes: [], collectedQuotes: [] },
      aiReference: [],
      stableUserCandidates: [],
      conflicts: [],
      warnings: []
    })
  };
}
const generatorAudits = [];
const generator = createAiGenerator({
  readSettings: async () => ({ apiKey: "synthetic-no-network-key" }),
  getContext: () => ({ user: { id: "account-a" }, secrets: [] }),
  reserveAttempt: async () => ({ release() {}, commit() {} }),
  gate: { acquire: async () => () => {} },
  audit: {
    text: value => value,
    message: value => value,
    start: async () => {},
    recordDeepSeekAttempt: async entry => { generatorAudits.push(entry); }
  },
  provider: createDeepSeekTransport({
    endpoint: "https://synthetic.invalid/chat/completions",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const result = await syntheticCompletion(request.messages.at(-1).content, { maxTokens: request.max_tokens });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { ...result, reasoning_content: "合成思考，不应保存" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      }));
    }
  })
});

const runtime = createContentRuntime({
  repository,
  trashRetentionDays: 30,
  getAccountId: () => "account-a",
  getTimezone: () => "America/Los_Angeles",
  getCursorScope: () => "account-a",
  backgroundContextKey: () => "account-a",
  workflowContextKey: () => "account-a",
  dispatchBackground: callback => scheduled.push(callback),
  async runDeepSeek(prompt, options) {
    calls.push({ prompt, options });
    const result = await generator(prompt, options);
    assert.equal(typeof result, "string", "历史补充也必须消费真实generator的纯字符串返回");
    return result;
  },
  async readAiUsage() {
    return {
      entries: calls.map(() => ({
        scene: RECORD_COMPRESSION_TASK_KIND,
        createdAt: asOf,
        costKnown: true,
        costCny: 0.1
      }))
    };
  },
  recordCompressionDailyBudgetCny: 1,
  recordCompressionPerCallBudgetCny: 0.25,
  recordCompressionMaxBackfillDatesPerScan: 2,
  now: () => asOf,
  today: () => "2026-10-10",
  currentTime: () => Date.parse(asOf),
  createId: (() => { let id = 0; return () => `historical-task-${++id}`; })(),
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

const firstScan = await runtime.runRecordCompressionScan({
  asOf,
  slot: "evening",
  backfillDates: 0,
  maxQueued: recordCompressionAccountQueueAllowance({ knownCalls: 0, reservedCalls: 0 })
});
assert.equal(firstScan.queuedCount, 2,
  "daily summary and its separate historical supplement fill, but do not exceed, the account's two-call cap");
assert.equal(scheduled.length, 2);
const tasks = firstScan.taskIds.map(id => store.aiTasks.find(task => task.id === id));
assert.deepEqual(tasks.map(task => task.payload.operation), ["daily", "historicalSupplement"]);
assert.equal(tasks[1].payload.timezone, "America/Los_Angeles");
assert.equal(tasks[1].payload.promptVersion, HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION);
assert.equal(recordCompressionAccountQueueAllowance({ knownCalls: 0, reservedCalls: 2 }), 0);
const whileReserved = await runtime.runRecordCompressionScan({
  asOf, slot: "evening", backfillDates: 0,
  maxQueued: recordCompressionAccountQueueAllowance({ knownCalls: 0, reservedCalls: 2 })
});
assert.equal(whileReserved.queuedCount, 0,
  "the scheduler's reserved-call allowance includes both daily and historical tasks");

for (const task of tasks) await runtime.backgroundAi.run(task.id);
assert.equal(calls.length, 2);
assert.equal(generatorAudits.length, 2);
assert.equal(generatorAudits.every(entry => entry.audit.status === "success"), true);
assert.equal(JSON.stringify(store.historicalUserSupplement).includes("合成思考"), false);
assert.equal(calls[0].options.maxTokens, 900);
assert.equal(calls[1].options.maxTokens, HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET);
assert.equal(calls[1].options.scene, RECORD_COMPRESSION_TASK_KIND);
assert.equal(tasks[1].status, "succeeded", JSON.stringify({ errorCode: tasks[1].errorCode, error: tasks[1].error, result: tasks[1].result }));
assert.equal(store.historicalUserSupplement.records.length, 1);
assert.equal(store.historicalUserSupplement.coverage.availableSources, 3,
  "historical-expression coverage counts only permitted sources with user text, not metric-only sources");
assert.equal(store.historicalUserSupplement.coverage.includedSources, 3);
assert.ok(store.recordCompressions.find(item => item.localDate === "2026-10-10")
  ?.metrics.some(metric => metric.metric === "heartRate_average"),
"metric-only sources remain available to daily structured metrics");

const noChangeScan = await runtime.runRecordCompressionScan({
  asOf, slot: "evening", backfillDates: 0, maxQueued: 2
});
assert.equal(noChangeScan.queuedCount, 0,
  "an unchanged successful supplement must not enqueue another provider call");

const trend = currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: "America/Los_Angeles",
  asOf,
  hash
});
const record = trend.historicalUserSupplement.records[0];
assert.ok(record.citationId);
const citation = trend.historicalUserSupplementCitationSources.find(source => (
  source.citationId === record.citationId
));
assert.ok(citation);
assert.equal(citation.text, record.exactQuote,
  "citation validation must be limited to the exact source text supplied in the prompt");
assert.equal(citation.source.informationType, "user_original");

const coreUserModel = { fingerprint: "stable-core-fingerprint", claims: [], answers: [], unknowns: [] };
const task = { kind: "thoughtAnswer", text: "我通常怎样推进复杂目标？", targetId: "root", subtargetId: "" };
const readPayload = prompt => JSON.parse(
  /<working_context_data format="application\/json">(.+)<\/working_context_data>/s.exec(prompt)[1]
);
const context = compileWorkingContextPrompt({
  scene: "thoughtAnswer",
  task,
  coreUserModel,
  historicalUserSupplement: trend.historicalUserSupplement,
  recentTrend: trend.payload,
  generatedAt: asOf
});
const contextPayload = readPayload(context.prompt);
const contextKeys = Object.keys(contextPayload);
assert.ok(contextKeys.indexOf("coreUserModel") < contextKeys.indexOf("historicalUserSupplement"));
assert.ok(contextKeys.indexOf("historicalUserSupplement") < contextKeys.indexOf("sevenDayTrend"));
const baseline = readPayload(compileWorkingContextPrompt({
  scene: "thoughtAnswer", task, coreUserModel, generatedAt: asOf
}).prompt);
const serializedContext = JSON.stringify(contextPayload);
const serializedBaseline = JSON.stringify(baseline);
assert.equal(
  serializedContext.slice(0, serializedContext.indexOf(",\"historicalUserSupplement\"")),
  serializedBaseline.slice(0, serializedBaseline.indexOf(",\"relevantEpisodes\"")),
  "adding historical context must preserve the serialized core-model prefix byte for byte"
);
const verified = parseVerifiedAnswer(JSON.stringify({
  answer: "你曾写过先拆解复杂目标，再逐项推进。",
  citations: [{ citationId: record.citationId, exactQuote: record.exactQuote }]
}), trend.historicalUserSupplementCitationSources);
assert.equal(verified.citationStatus, "matched");
assert.equal(verified.citations[0].citationId, record.citationId);

const beforeRevokeSourceCount = store.historicalUserSupplement.records.length;
assert.equal(beforeRevokeSourceCount, 1);
await runtime.updateSourceStore(current => {
  current.thoughts.push({
    id: "third-source-after-budget",
    type: "question",
    content: "今天又新增一条合成来源。",
    authorType: "user",
    origin: "manual",
    occurredAt: "2026-10-10T07:45:00.000Z",
    occurredOn: "2026-10-10",
    version: 1
  });
});
const consumedAllowance = recordCompressionAccountQueueAllowance({ knownCalls: calls.length, reservedCalls: 0 });
assert.equal(consumedAllowance, 0);
const consumedCapScan = await runtime.runRecordCompressionScan({
  asOf, slot: "evening", backfillDates: 0, maxQueued: consumedAllowance
});
assert.equal(consumedCapScan.queuedCount, 0,
  "the two already consumed account invocations also count against the daily cap");

const metadata = citation.source;
await runtime.perception.updatePermissions({
  sourceRef: {
    resourceType: metadata.resourceType,
    resourceId: metadata.resourceId,
    rootId: metadata.location.rootId,
    targetKey: metadata.location.targetKey,
    version: metadata.version
  },
  contextAllowed: false,
  learningAllowed: false,
  expectedRevision: 0
});
assert.equal(store.historicalUserSupplement.records.length, 0,
  "revocation clears source-bound supplement records in the same mutation transaction");
const afterRevoke = currentRecordCompressionTrend(store, {
  accountId: "account-a", timezone: "America/Los_Angeles", asOf, hash
});
assert.equal(afterRevoke.historicalUserSupplement.records.length, 0);
assert.equal(afterRevoke.historicalUserSupplementCitationSources.length, 0);
assert.equal(calls.length, 2, "synthetic regressions never invoke an external provider");

const progressiveStore = createEmptyStore();
const progressiveAnchor = "!ANCHOR";
const olderSeptemberAnchor = "?ANCHOR";
const oldestSeptemberAnchor = "OLDER_SOURCE";
const middleYearAnchor = "MIDDLE_YEAR_2025";
const oldestYearAnchor = "OLDEST_YEAR_2020";
let progressiveSourceSequence = 0;
const addProgressiveSource = (id, localDate, marker = `SOURCE_${id}`) => {
  const sourceId = progressiveSourceSequence.toString(36);
  progressiveSourceSequence += 1;
  progressiveStore.journals.push({
    id: sourceId,
    title: marker,
    content: "x".repeat(1_800),
    authorType: "user",
    origin: "manual",
    occurredAt: `${localDate}T08:00:00.000Z`,
    occurredOn: localDate,
    version: 1
  });
};
for (let day = 4; day <= 10; day += 1) {
  const localDate = `2026-10-${String(day).padStart(2, "0")}`;
  for (let index = 0; index < 5; index += 1) {
    addProgressiveSource(
      `progressive-${day}-${index}`,
      localDate,
      day === 10 && index === 0 ? progressiveAnchor : `PROGRESSIVE_${day}_${index}`
    );
  }
}
addProgressiveSource("progressive-sep-30", "2026-09-30", olderSeptemberAnchor);
addProgressiveSource("progressive-sep-01", "2026-09-01", oldestSeptemberAnchor);
addProgressiveSource("progressive-2025-01-15", "2025-01-15", middleYearAnchor);
addProgressiveSource("progressive-2020-01-15", "2020-01-15", oldestYearAnchor);

let progressiveNow = "2026-10-10T08:00:00.000Z";
const progressiveAsOf = progressiveNow;
const progressiveScheduled = [];
const progressiveCalls = [];
const progressiveLedger = new Map();
const progressiveHash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
let progressiveGeneratedId = 0;
const progressiveRepository = {
  async read() { return structuredClone(progressiveStore); },
  async update(operation) { return operation(progressiveStore); },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`;
    const existing = progressiveLedger.get(key);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("幂等请求内容不一致"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return structuredClone(onReplay(structuredClone(existing.response)));
    }
    const response = await operation(progressiveStore);
    progressiveLedger.set(key, {
      requestHash: request.requestHash,
      response: structuredClone(response)
    });
    return response;
  },
  async transact(operation) {
    return operation({ document: progressiveStore, commit: async () => {} });
  }
};
const progressiveMarkerIds = new Map();
const createProgressiveRuntime = () => createContentRuntime({
  repository: progressiveRepository,
  trashRetentionDays: 30,
  getAccountId: () => "account-progressive",
  getTimezone: () => "America/Los_Angeles",
  getCursorScope: () => "account-progressive",
  backgroundContextKey: () => "account-progressive",
  workflowContextKey: () => "account-progressive",
  dispatchBackground: callback => progressiveScheduled.push(callback),
  async runDeepSeek(prompt, options) {
    assert.equal(options.maxTokens, HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET);
    const input = parsePromptInput(prompt);
    assert.ok(estimateHistoricalUserSupplementTokens(input)
      <= HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET,
    "each progressive batch must stay inside the model input-token cap");
    progressiveCalls.push({
      createdAt: progressiveNow,
      inputSourceIds: input.userSources.map(source => source.sourceId)
    });
    const marker = [progressiveAnchor, olderSeptemberAnchor]
      .find(value => input.userSources.some(source => source.text.includes(value)));
    const source = marker
      ? input.userSources.find(item => item.text.includes(marker))
      : null;
    const candidates = source ? [
      {
        statement: "A",
        exactQuote: marker.slice(0, 1),
        sourceId: source.sourceId
      }
    ] : [];
    const outputTokens = estimateHistoricalUserSupplementTokens({
      schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
      candidates
    });
    assert.ok(outputTokens <= HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET, JSON.stringify({
      outputTokens,
      sourceId: source?.sourceId
    }));
    if (marker) progressiveMarkerIds.set(marker, source.sourceId);
    return {
      content: JSON.stringify({
        schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
        candidates
      })
    };
  },
  async readAiUsage() {
    return {
      entries: progressiveCalls.map(call => ({
        scene: RECORD_COMPRESSION_TASK_KIND,
        createdAt: call.createdAt,
        costKnown: true,
        costCny: 0.1
      }))
    };
  },
  recordCompressionDailyBudgetCny: 1,
  recordCompressionPerCallBudgetCny: 0.25,
  recordCompressionMaxBackfillDatesPerScan: 2,
  now: () => progressiveNow,
  today: () => progressiveNow.slice(0, 10),
  currentTime: () => Date.parse(progressiveNow),
  createId: () => `progressive-task-${++progressiveGeneratedId}`,
  hash: progressiveHash,
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
const progressiveRuntime = createProgressiveRuntime();

const localDateForProgressiveCall = call => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date(call.createdAt));
const advanceProgressiveDay = () => {
  const next = new Date(progressiveNow);
  next.setUTCDate(next.getUTCDate() + 1);
  progressiveNow = next.toISOString();
};
let firstProgressiveBatch = true;
const restartedPreparedBatches = [];
for (let attempt = 0; attempt < 16; attempt += 1) {
  const localToday = localDateForProgressiveCall({ createdAt: progressiveNow });
  let knownCalls = progressiveCalls.filter(call => (
    localDateForProgressiveCall(call) === localToday
  )).length;
  if (knownCalls >= 2) {
    advanceProgressiveDay();
    knownCalls = 0;
  }
  const reservedCalls = progressiveStore.aiTasks.filter(task => (
    task.kind === RECORD_COMPRESSION_TASK_KIND
    && ["queued", "running"].includes(task.status)
  )).length;
  const allowance = recordCompressionAccountQueueAllowance({ knownCalls, reservedCalls });
  const scan = await progressiveRuntime.runRecordCompressionScan({
    asOf: progressiveAsOf,
    slot: "backfill",
    backfillDates: 0,
    maxQueued: allowance
  });
  if (!scan.queuedCount) {
    if (progressiveStore.historicalUserSupplement.coverage.complete) break;
    assert.ok(allowance > 0, "an exhausted account allowance advances to the next local day");
    assert.fail(`incomplete historical coverage must keep a resumable batch queued: ${JSON.stringify({
      attempt,
      scan,
      coverage: progressiveStore.historicalUserSupplement.coverage,
      succeededRanges: progressiveStore.aiTasks
        .filter(item => item.payload?.operation === "historicalSupplement" && item.status === "succeeded")
        .map(item => [item.payload.windowStart, item.payload.windowEnd])
    })}`);
  }
  assert.equal(scan.queuedCount, 1,
    "each progressive scan queues at most one bounded historical task");
  const task = progressiveStore.aiTasks.find(item => item.id === scan.taskId);
  assert.equal(task.payload.operation, "historicalSupplement");
  assert.ok(Number.isSafeInteger(task.payload.batchIndex), JSON.stringify({ task, scan }));
  const executionRuntime = task.payload.batchIndex > 0
    ? createProgressiveRuntime()
    : progressiveRuntime;
  await executionRuntime.backgroundAi.run(task.id);
  if (task.payload.batchIndex > 0
    && task.payload.windowStart === "2026-10-04"
    && task.payload.windowEnd === "2026-10-10") {
    const earlierBatchSources = new Set(progressiveCalls[0].inputSourceIds);
    assert.ok(progressiveCalls.at(-1).inputSourceIds.every(sourceId => (
      !earlierBatchSources.has(sourceId)
    )), "a restarted worker must prepare the persisted batchIndex rather than replay batch zero");
    restartedPreparedBatches.push(task.payload.batchIndex);
  }
  assert.equal(task.status, "succeeded", JSON.stringify({
    attempt,
    batchIndex: task.payload.batchIndex,
    error: task.error,
    errorCode: task.errorCode,
    result: task.result
  }));
  if (firstProgressiveBatch) {
    firstProgressiveBatch = false;
    const coverage = progressiveStore.historicalUserSupplement.coverage;
    assert.equal(coverage.availableSources, 35,
      "coverage counts every permitted recent source, even when one model batch cannot fit them all");
    assert.ok(coverage.includedSources < coverage.availableSources);
    assert.equal(coverage.complete, false,
      "an oversized history must remain explicitly partial until all batches finish");
    assert.deepEqual(task.payload.windowStart, "2026-10-04");
    assert.deepEqual(task.payload.windowEnd, "2026-10-10");
  }
}
assert.equal(progressiveStore.historicalUserSupplement.coverage.complete, true,
  "repeated bounded scans must eventually cover the recent and discovered older source ranges");
assert.ok(progressiveStore.historicalUserSupplement.coverage.availableSources >= 39);
assert.equal(progressiveStore.historicalUserSupplement.coverage.includedSources,
  progressiveStore.historicalUserSupplement.coverage.availableSources,
  "aggregate coverage must include completed sources across batches instead of only the latest task");
for (const marker of [progressiveAnchor, olderSeptemberAnchor]) {
  assert.ok(progressiveStore.historicalUserSupplement.records.some(record => (
    record.source.sourceId === progressiveMarkerIds.get(marker)
  )), JSON.stringify({
    marker,
    expectedSourceId: progressiveMarkerIds.get(marker),
    records: progressiveStore.historicalUserSupplement.records,
    taskRanges: progressiveStore.aiTasks.map(task => ({
      payload: task.payload,
      status: task.status,
      error: task.error
    }))
  }));
}
const completedHistoryRanges = progressiveStore.aiTasks
  .filter(task => task.payload?.operation === "historicalSupplement" && task.status === "succeeded")
  .map(task => task.payload);
assert.ok(completedHistoryRanges.some(range => (
  range.windowStart <= "2025-01-15" && range.windowEnd >= "2025-01-15"
)), "bounded history windows must continue beyond the first year");
assert.ok(completedHistoryRanges.some(range => (
  range.windowStart <= "2020-01-15" && range.windowEnd >= "2020-01-15"
)), "bounded history windows must eventually cover older years");
for (const range of completedHistoryRanges) {
  const days = (Date.parse(`${range.windowEnd}T00:00:00.000Z`)
    - Date.parse(`${range.windowStart}T00:00:00.000Z`)) / 86_400_000 + 1;
  assert.ok(days <= 365, `historical window exceeds 365 days: ${JSON.stringify(range)}`);
}
const callsPerLocalDay = new Map();
for (const call of progressiveCalls) {
  const localDate = localDateForProgressiveCall(call);
  callsPerLocalDay.set(localDate, (callsPerLocalDay.get(localDate) || 0) + 1);
}
assert.ok([...callsPerLocalDay.values()].every(count => count <= 2),
  "progressive batches must respect the per-account two-call daily allowance");
assert.ok(progressiveCalls.length >= 4,
  "the fixture must exercise multiple recent batches followed by two older-history ranges");
assert.deepEqual(restartedPreparedBatches, [1],
  "the second recent batch resumes after rebuilding the runtime from the persisted task");

progressiveNow = "2026-10-18T08:00:00.000Z";
const expiredWindowTrend = currentRecordCompressionTrend(progressiveStore, {
  accountId: "account-progressive",
  timezone: "America/Los_Angeles",
  asOf: progressiveNow,
  hash: progressiveHash
});
assert.equal(expiredWindowTrend.historicalUserSupplement.records.length, 2,
  "candidates from separate batches accumulate within the approved output-token budget");
const changedOldSourceId = progressiveMarkerIds.get(olderSeptemberAnchor);
await progressiveRuntime.updateSourceStore(current => {
  const source = current.journals.find(item => item.title === olderSeptemberAnchor);
  source.content = "已编辑的旧来源必须使原候选失效。";
  source.version += 1;
});
assert.equal(progressiveStore.historicalUserSupplement.records.some(record => (
  record.source.sourceId === changedOldSourceId
)), false, "editing an older source invalidates only its stale candidate");
assert.equal(progressiveStore.historicalUserSupplement.coverage.complete, false,
  "an edited source reopens aggregate coverage until its historical range is regenerated");
assert.ok(progressiveStore.historicalUserSupplement.records.some(record => (
  record.source.sourceId === progressiveMarkerIds.get(progressiveAnchor)
)), "a still-valid older candidate remains persisted after a different source is edited");
const retainedOldCitation = currentRecordCompressionTrend(progressiveStore, {
  accountId: "account-progressive",
  timezone: "America/Los_Angeles",
  asOf: progressiveNow,
  hash: progressiveHash
}).historicalUserSupplementCitationSources.find(source => (
  source.source.id.includes(progressiveMarkerIds.get(progressiveAnchor))
));
assert.ok(retainedOldCitation,
  "a still-unchanged source remains citable after its candidate leaves the rolling trend window");
const revokeOldRecord = progressiveStore.historicalUserSupplement.records.find(record => (
  record.source.sourceId === progressiveMarkerIds.get(progressiveAnchor)
));
const revokeOldCitation = currentRecordCompressionTrend(progressiveStore, {
  accountId: "account-progressive",
  timezone: "America/Los_Angeles",
  asOf: progressiveNow,
  hash: progressiveHash
}).historicalUserSupplementCitationSources.find(source => (
  source.citationId === `historical-supplement:${progressiveMarkerIds.get(progressiveAnchor)}:${progressiveHash(revokeOldRecord.exactQuote).slice(0, 12)}`
));
assert.ok(revokeOldCitation);
const revokedOld = await progressiveRuntime.perception.updatePermissions({
  sourceRef: {
    resourceType: revokeOldCitation.source.resourceType,
    resourceId: revokeOldCitation.source.resourceId,
    rootId: revokeOldCitation.source.location.rootId,
    targetKey: revokeOldCitation.source.location.targetKey,
    version: revokeOldCitation.source.version
  },
  contextAllowed: false,
  learningAllowed: false,
  expectedRevision: 0
});
assert.equal(progressiveStore.historicalUserSupplement.records.some(record => (
  record.source.sourceId === progressiveMarkerIds.get(progressiveAnchor)
)), false, JSON.stringify({
  revokedOld,
  citation: revokeOldCitation,
  records: progressiveStore.historicalUserSupplement.records
}));
assert.equal(progressiveStore.historicalUserSupplement.coverage.complete, false,
  "permission revocation invalidates the complete-coverage claim");
assert.equal(progressiveCalls.length, progressiveStore.aiTasks.filter(task => (
  task.kind === RECORD_COMPRESSION_TASK_KIND && task.status === "succeeded"
)).length, "only synthetic providers run during progressive-history coverage");

let generationNow = "2026-10-10T23:59:00.000Z";
let ready = true;
let generatedId = 0;
const latestGenerationTime = "2026-10-11T00:30:00.000Z";
const trendReads = [];
const providerWorks = [];
const dispatched = [];
const answerStore = createEmptyStore();
const answerRoot = (id, content) => ({
  id,
  type: "question",
  content,
  authorType: "user",
  origin: "manual",
  occurredAt: "2026-10-10T10:00:00.000Z",
  occurredOn: "2026-10-10",
  version: 1,
  tags: [],
  followUps: []
});
answerStore.thoughts.push(
  answerRoot("ordinary-answer-root", "普通排队任务使用创建时趋势。"),
  answerRoot("waiting-answer-root", "等待核心模型期间跨日。")
);
answerStore.thoughts.find(item => item.id === "waiting-answer-root").followUps.push({
  id: "waiting-follow-up",
  question: "等待期间趋势是否更新？",
  version: 1
});
const thoughtTarget = createThoughtTaskTarget({
  createId: () => `answer-${++generatedId}`,
  now: () => generationNow,
  stripThoughtAnswerLead: value => value
});
const answerTargets = createAiTaskTargets({
  thoughts: thoughtTarget,
  annotations: {},
  getRecentTrend(_store, generatedAt) {
    const windowDate = generatedAt >= "2026-10-11T00:00:00.000Z"
      ? "2026-10-10"
      : "2026-10-09";
    trendReads.push({ generatedAt, windowDate });
    return {
      fingerprint: `trend:${windowDate}`,
      payload: { localDates: [windowDate], coverage: { status: "complete" } },
      historicalUserSupplement: null,
      historicalUserSupplementCitationSources: [],
      citationSources: []
    };
  },
  getAccountId: () => "account-a",
  hash,
  now: () => generationNow
});
const answerRepository = {
  async read() { return structuredClone(answerStore); },
  async update(operation) { return operation(answerStore); }
};
const answerBackground = createBackgroundAi({
  repository: answerRepository,
  tasks: createTaskLifecycle({
    createId: () => `task-${++generatedId}`,
    now: () => generationNow,
    hash
  }),
  notifications: createNotificationService({
    createId: () => `notice-${++generatedId}`,
    now: () => generationNow
  }),
  targets: answerTargets,
  shouldWaitForModel: () => !ready,
  inspectIntent: answerTargets.inspectIntent,
  generate: async (work, { isCurrent }) => {
    assert.equal(await isCurrent(), true, "stable answer snapshots remain current during generation");
    providerWorks.push(work);
    return { content: "合成回答", citations: [], citationStatus: "matched" };
  },
  dispatch: callback => dispatched.push(callback),
  contextKey: () => "account-a",
  now: () => generationNow
});

const ordinaryCreationTime = generationNow;
const ordinaryCreated = await answerBackground.enqueue({
  kind: "thoughtAnswer",
  targetId: "ordinary-answer-root",
  inputVersion: 1,
  clientRequestId: "ordinary-cross-day-answer"
});
assert.equal(ordinaryCreated.task.status, "queued");
assert.equal(dispatched.length, 1);
generationNow = latestGenerationTime;
await answerBackground.run(ordinaryCreated.task.id);
assert.equal(ordinaryCreated.task.status, "succeeded",
  "an ordinary queued answer must survive provider-side revalidation");
assert.ok(trendReads.some(read => (
  read.generatedAt === ordinaryCreationTime && read.windowDate === "2026-10-09"
)), "ordinary tasks must use task.createdAt for their stable trend snapshot");
const ordinaryAnswer = answerStore.thoughts.find(item => item.sourceTaskId === ordinaryCreated.task.id);
assert.ok(ordinaryAnswer);
assert.equal(ordinaryCreated.task.contextFingerprint,
  workingContextReceiptFingerprint(ordinaryAnswer.contextReceipt),
"persisted contextFingerprint must remain the exact receipt fingerprint");
assert.equal(contextDerivedOutputAllowed(answerStore, ordinaryAnswer, "account-a", {
  kind: "thoughtAnswer",
  targetId: "ordinary-answer-root",
  subtargetId: ""
}), true, "a saved answer receipt must remain valid for later context use");

ready = false;
generationNow = "2026-10-10T23:59:30.000Z";
const waitingCreated = await answerBackground.enqueue({
  kind: "thoughtAnswer",
  targetId: "waiting-answer-root",
  inputVersion: 1,
  clientRequestId: "waiting-cross-day-answer"
});
assert.equal(waitingCreated.task.status, "waiting_for_user_model");
ready = true;
generationNow = latestGenerationTime;
assert.equal(await answerBackground.releaseWaiting(), 1);
assert.equal(dispatched.length, 2);
assert.equal(waitingCreated.task.contextGeneratedAt, latestGenerationTime,
  "promotion must capture the new ready-time context timestamp");
const waitingWorkFirst = answerTargets.prepare(answerStore, waitingCreated.task);
const waitingWorkAgain = answerTargets.prepare(answerStore, waitingCreated.task);
assert.deepEqual(readPayload(waitingWorkFirst.prompt).sevenDayTrend.localDates, ["2026-10-10"]);
assert.equal(waitingWorkFirst.contextReceipt.generatedAt, latestGenerationTime);
assert.equal(waitingWorkAgain.inputHash, waitingWorkFirst.inputHash);
assert.equal(waitingWorkAgain.contextFingerprint, waitingWorkFirst.contextFingerprint);
assert.equal(waitingWorkAgain.prompt, waitingWorkFirst.prompt,
  "repeated prepare after promotion must reuse the same context snapshot");
assert.ok(trendReads.some(read => (
  read.generatedAt === latestGenerationTime && read.windowDate === "2026-10-10"
)), "waiting tasks must read the trend at promotion time after crossing midnight");
await answerBackground.run(waitingCreated.task.id);
assert.equal(waitingCreated.task.status, "succeeded");
const waitingAnswer = answerStore.thoughts.find(item => item.sourceTaskId === waitingCreated.task.id);
assert.equal(waitingCreated.task.contextFingerprint,
  workingContextReceiptFingerprint(waitingAnswer.contextReceipt));
assert.equal(contextDerivedOutputAllowed(answerStore, waitingAnswer, "account-a", {
  kind: "thoughtAnswer",
  targetId: "waiting-answer-root",
  subtargetId: ""
}), true, "a promoted answer receipt must remain valid after saving");

const followUpTask = {
  kind: "followUpAnswer",
  targetId: "waiting-answer-root",
  subtargetId: "waiting-follow-up",
  inputVersion: 1,
  subtargetVersion: 1,
  createdAt: "2026-10-10T23:59:00.000Z",
  contextGeneratedAt: latestGenerationTime
};
const followUpFirst = answerTargets.prepare(answerStore, followUpTask);
const followUpAgain = answerTargets.prepare(answerStore, followUpTask);
assert.deepEqual(readPayload(followUpFirst.prompt).sevenDayTrend.localDates, ["2026-10-10"]);
assert.equal(followUpFirst.contextFingerprint,
  workingContextReceiptFingerprint(followUpFirst.contextReceipt));
assert.equal(followUpAgain.inputHash, followUpFirst.inputHash,
  "follow-up answers must use the same persisted generation snapshot too");
assert.equal(providerWorks.length, 2);

console.log("Historical supplement service passed: independent prompt, two-call account cap, current-source citation, unchanged dedupe and atomic revocation cleanup.");
