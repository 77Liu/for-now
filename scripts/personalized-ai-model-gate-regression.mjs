import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createBackgroundAi,
  createThoughtWorkflows,
  createCaptureJournalWorkflows,
  createReviewChatWorkflows,
  prepareUserModelExtraction,
  userModelCoreReadiness
} from "../src/app/index.mjs";
import {
  createThoughtHttp,
  createCaptureJournalHttp,
  createReviewsChatHttp,
  sendPersonalizedTaskLegacy,
  sendPersonalizedTaskV1
} from "../src/http/index.mjs";
import { createTaskLifecycle, WAITING_FOR_USER_MODEL_STATUS } from "../src/modules/tasks/index.mjs";
import { defaultOnboardingV2, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import { eventTimeFields } from "../src/shared/time/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
let store;
const readiness = () => userModelCoreReadiness(store);
let nextId = 0;
const createId = () => `generated-${++nextId}`;
const eventTime = eventTimeFields({ occurredAt: "2026-10-09T02:00:00.000Z" });
let providerCalls = 0;
let prepareCalls = 0;
let generationGate = null;
const generate = async work => {
  if (work.preflightError) {
    throw Object.assign(new Error(work.preflightError.message), {
      code: work.preflightError.code,
      statusCode: 400
    });
  }
  providerCalls += 1;
  if (generationGate) {
    generationGate.notifyStarted();
    await generationGate.wait;
  }
  return { content: "不应在冷启时生成", reasoningContent: "" };
};
const backgroundOperations = [];
store = {
  // 该回归验证“用户已提交补充但核心模型仍未整理”的等待边界；
  // 完全没有补充时的空模型 fallback 由 thought-workflows-p00-regression 覆盖。
  onboardingV2: normalizeOnboardingV2({
    migration: { selectedFlow: "v2" },
    session: {
      answers: {
        currentContext: { rawText: "已提交一条用户补充", contextAllowed: true, version: 1 }
      }
    }
  }, defaultOnboardingV2),
  chats: [],
  journals: [{
    id: "journal-1",
    content: "日记正文",
    updatedAt: "2026-10-09T02:00:00.000Z",
    createdAt: "2026-10-09T02:00:00.000Z",
    version: 1,
    reflections: []
  }],
  thoughts: [],
  checkins: [],
  dailyRecords: [],
  captures: [{
    id: "capture-context",
    content: "撤权时应使在途结果失效",
    occurredAt: eventTime.occurredAt,
    occurredOn: eventTime.occurredOn,
    createdAt: eventTime.occurredAt,
    version: 1
  }],
  evidencePermissions: [],
  actions: [],
  analyses: [],
  aiTasks: [],
  notifications: []
};
const initialExtraction = prepareUserModelExtraction(store).value;
store.aiTasks.push({ id: "core-in-flight", kind: "onboardingClaimExtraction",
  targetId: "onboarding-v2", status: "running", inputVersion: initialExtraction.inputVersion,
  inputHash: initialExtraction.inputHash });
const repository = {
  async read() {
    return structuredClone(store);
  },
  async update(operation) {
    return operation(store);
  }
};
const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.body = body;
  return body;
};
const taskLifecycle = createTaskLifecycle({
  createId,
  now: () => "2026-10-10T00:00:00.000Z",
  hash
});
const baseTargets = {
  inspectIntent: () => null,
  prepare: () => null,
  save: () => null,
  result: () => null
};
const backgroundAi = createBackgroundAi({
  repository,
  tasks: taskLifecycle,
  notifications: {
    upsertTask(items, task, status, message) {
      items.unshift({ taskId: task.id, status, message });
      return null;
    }
  },
  targets: baseTargets,
  shouldWaitForModel: (_store, input) => (
    ["thoughtDraft", "thoughtPrompt", "journalAssist", "journalReflection", "chat", "analysis"]
      .includes(input.kind) && !readiness().ready
  ),
  generate,
  contextKey: () => "account-a",
  dispatch: operation => backgroundOperations.push(operation),
  onError: () => {}
});
const registerHandler = (kind, handler) => backgroundAi.registerHandler(kind, {
  ...handler,
  prepare(...args) {
    prepareCalls += 1;
    return handler.prepare(...args);
  }
});

const thoughtWorkflows = createThoughtWorkflows({
  repository,
  thoughts: {},
  backgroundAi,
  removeChain: () => null,
  removeBlock: () => null,
  generate,
  hash,
  publicTask: task => task,
  coreModelReadiness: readiness
});
const journalRecords = {
  async get(id) {
    const journal = store.journals.find(item => item.id === id);
    return journal ? structuredClone(journal) : null;
  },
  async findReflectionRequest() {
    return null;
  },
  addReflectionInStore() {
    throw new Error("冷启期间不得写入日记回望");
  }
};
const captureJournalWorkflows = createCaptureJournalWorkflows({
  repository,
  journals: journalRecords,
  backgroundAi,
  generate,
  hash,
  createId,
  coreModelReadiness: readiness,
  today: () => "2026-10-09"
});
const chatRecords = {
  async findRequest() {
    return null;
  },
  saveInStore() {
    throw new Error("冷启期间不得写入对话");
  }
};
const reviewRecords = {
  async findAnalysisRequest() {
    return null;
  },
  saveAnalysisInStore() {
    throw new Error("冷启期间不得写入认知复盘");
  }
};
const reviewWorkflows = createReviewChatWorkflows({
  repository,
  chats: chatRecords,
  reviews: reviewRecords,
  backgroundAi,
  generate,
  hash,
  coreModelReadiness: readiness,
  createId
});

registerHandler("thoughtDraft", thoughtWorkflows.personalizedTaskHandler);
registerHandler("thoughtPrompt", thoughtWorkflows.personalizedTaskHandler);
registerHandler("journalAssist", captureJournalWorkflows.personalizedTaskHandler);
registerHandler("journalReflection", captureJournalWorkflows.personalizedTaskHandler);
registerHandler("chat", reviewWorkflows.personalizedTaskHandler);
registerHandler("analysis", reviewWorkflows.personalizedTaskHandler);

const responseBody = (res, isV1) => isV1 ? res.body?.data : res.body;
const assertWaiting = (res, isV1, expectedKind, label) => {
  assert.equal(res.statusCode, 202, `${label} must acknowledge a durable task`);
  const task = responseBody(res, isV1);
  assert.equal(task.kind, expectedKind, `${label} must expose its task kind`);
  assert.equal(task.status, WAITING_FOR_USER_MODEL_STATUS, `${label} must persist the cold-start wait`);
  assert.ok(task.id, `${label} must return a durable task ID`);
  return task;
};
const expectLegacyTask = (res, created) => sendPersonalizedTaskLegacy(res, sendJson, created);
const bodyJson = async req => req.body || {};
const runModel = async (_req, _res, { run, formatResult = value => value }) => formatResult(await run());
const v1 = {
  idempotencyKey: req => String(req.headers?.["idempotency-key"] || "request-missing"),
  envelope: value => ({ data: value, error: null }),
  errorEnvelope: error => ({ error: { code: error.code, message: error.message } }),
  error: (res, status, message, code, details) => sendJson(res, status, { error: message, code, details }),
  success: (res, status, data) => sendJson(res, status, { data })
};

const thoughtHttp = createThoughtHttp({
  service: {},
  workflows: thoughtWorkflows,
  removeBlock: () => null,
  removeNested: () => null,
  backgroundAi,
  sendTaskCreation: expectLegacyTask,
  eventTimeFields,
  bodyJson,
  sendJson,
  sendTrashResult: () => null,
  respondModel: runModel,
  createId,
  prepareContentAttachments: async (_type, input) => ({ value: { ...input, attachmentPaths: [] } })
});
const captureJournalHttp = createCaptureJournalHttp({
  captures: {},
  journals: journalRecords,
  workflows: captureJournalWorkflows,
  removeCapture: () => null,
  removeJournal: () => null,
  removeReflection: () => null,
  sendTrashResult: () => null,
  sendTaskCreation: expectLegacyTask,
  bodyJson,
  sendJson,
  respondModel: runModel
});
const reviewHttp = createReviewsChatHttp({
  chatRecords,
  reviewRecords,
  workflows: reviewWorkflows,
  statistics: {},
  remove: () => null,
  eventTimeFields,
  bodyJson,
  sendJson,
  sendTrashResult: () => null
});

const requests = [
  {
    kind: "thoughtDraft",
    label: "POST /api/answer-drafts",
    isV1: false,
    run: res => thoughtHttp.handle({ method: "POST", body: { question: "草稿问题" }, headers: { "idempotency-key": "legacy-draft" } }, res,
      new URL("http://localhost/api/answer-drafts"))
  },
  {
    kind: "thoughtPrompt",
    label: "POST /api/thought-prompts",
    isV1: false,
    run: res => thoughtHttp.handle({ method: "POST", body: { occurredAt: eventTime.occurredAt }, headers: { "idempotency-key": "legacy-prompt" } }, res,
      new URL("http://localhost/api/thought-prompts"))
  },
  {
    kind: "journalAssist",
    label: "POST /api/journals/assist",
    isV1: false,
    run: res => captureJournalHttp.handle({ method: "POST", body: { mode: "lead", content: "今日" }, headers: { "idempotency-key": "legacy-journal-assist" } }, res,
      new URL("http://localhost/api/journals/assist"))
  },
  {
    kind: "journalAssist",
    label: "POST /api/v1/journals/assist",
    isV1: true,
    run: res => captureJournalHttp.handleV1({
      method: "POST", body: { mode: "lead", content: "今日" }, headers: { "idempotency-key": "journal-assist-v1" }
    }, res, new URL("http://localhost/api/v1/journals/assist"), v1)
  },
  {
    kind: "journalReflection",
    label: "POST /api/journals/:id/reflect",
    isV1: false,
    run: res => captureJournalHttp.handle({ method: "POST", body: {}, headers: { "idempotency-key": "legacy-journal-reflection" } }, res,
      new URL("http://localhost/api/journals/journal-1/reflect"))
  },
  {
    kind: "journalReflection",
    label: "POST /api/v1/journals/:id/reflections",
    isV1: true,
    run: res => captureJournalHttp.handleV1({
      method: "POST", body: {}, headers: { "idempotency-key": "journal-reflection-v1" }
    }, res, new URL("http://localhost/api/v1/journals/journal-1/reflections"), v1)
  },
  {
    kind: "chat",
    label: "POST /api/chat",
    isV1: false,
    run: res => reviewHttp.handle({
      method: "POST",
      body: { message: "请结合我最近的记录回答", occurredAt: eventTime.occurredAt },
      headers: { "idempotency-key": "legacy-chat" }
    }, res, new URL("http://localhost/api/chat"))
  },
  {
    kind: "chat",
    label: "POST /api/v1/chats",
    isV1: true,
    run: res => reviewHttp.handleV1({
      method: "POST",
      body: { message: "请结合我最近的记录回答", occurredAt: eventTime.occurredAt },
      headers: { "idempotency-key": "chat-v1" }
    }, res, new URL("http://localhost/api/v1/chats"), v1)
  },
  {
    kind: "analysis",
    label: "POST /api/analysis/run",
    isV1: false,
    run: res => reviewHttp.handle({ method: "POST", body: {}, headers: { "idempotency-key": "legacy-analysis" } }, res,
      new URL("http://localhost/api/analysis/run"))
  },
  {
    kind: "analysis",
    label: "POST /api/v1/analyses",
    isV1: true,
    run: res => reviewHttp.handleV1({
      method: "POST", body: {}, headers: { "idempotency-key": "analysis-v1" }
    }, res, new URL("http://localhost/api/v1/analyses"), v1)
  }
];

const returnedTasks = [];
const activeReflections = new Map();
for (const request of requests) {
  const res = {};
  await request.run(res);
  if (request.kind === "journalReflection" && activeReflections.has("journal-1")) {
    assert.equal(res.statusCode, 200, `${request.label} must reuse the active same-version reflection task`);
    const task = responseBody(res, request.isV1);
    assert.equal(task.id, activeReflections.get("journal-1").id);
    returnedTasks.push(task);
  } else {
    const task = assertWaiting(res, request.isV1, request.kind, request.label);
    returnedTasks.push(task);
    if (request.kind === "journalReflection") activeReflections.set("journal-1", task);
  }
}
for (const [index, request] of requests.entries()) {
  if (request.isV1) continue;
  const duplicate = {};
  await request.run(duplicate);
  assert.equal(duplicate.statusCode, 200, `${request.label} retries with a stable ID should replay the durable task`);
  assert.equal(responseBody(duplicate, false).id, returnedTasks[index].id);
}

assert.equal(providerCalls, 0, "cold-start requests must not call the provider");
assert.equal(prepareCalls, 0, "cold-start requests must not compile prompts or current context");
assert.equal(store.aiTasks.length, requests.length,
  "same-version cold reflection requests share one durable task");
assert.equal(store.aiTasks.filter(task => task.id !== "core-in-flight").every(task => task.status === WAITING_FOR_USER_MODEL_STATUS), true);
assert.equal(store.aiTasks.filter(task => task.id !== "core-in-flight").every(task => !Object.hasOwn(task.payload, "prompt")), true);
assert.equal(store.journals[0].reflections.length, 0, "cold-start reflection must not write a partial record");
assert.deepEqual(new Set(returnedTasks.map(task => task.kind)), new Set([
  "thoughtDraft",
  "thoughtPrompt",
  "journalAssist",
  "journalReflection",
  "chat",
  "analysis"
]));

const oversized = {};
await captureJournalHttp.handle({
  method: "POST",
  body: { mode: "lead", content: "文".repeat(12_000) }
}, oversized, new URL("http://localhost/api/journals/assist"));
assert.equal(oversized.statusCode, 413, "persisted intent must enforce a UTF-8 byte ceiling");
assert.equal(oversized.body.code, "AI_TASK_INTENT_TOO_LARGE");

const reflectionTask = store.aiTasks.find(task => task.kind === "journalReflection");
store.journals[0].version = 2;
store.journals[0].updatedAt = "2026-10-10T00:00:00.000Z";
store.onboardingV2 = normalizeOnboardingV2({
  session: {
    id: "onboarding-v2",
    status: "completed",
    step: "firstAction",
    revision: 8,
    answers: {
      currentContext: { rawText: "正在适应新的工作节奏", contextAllowed: true, version: 2 },
      desiredChanges: { structuredValue: [{ text: "建立稳定的运动习惯", horizon: "3m" }], contextAllowed: true, version: 1 },
      recentObstacles: { structuredValue: [{ text: "容易被临时任务打断" }], contextAllowed: true, version: 1 },
      dailyRhythm: { rawText: "通常在晚上做复盘", contextAllowed: true, version: 1 }
    },
    collaboration: {
      responseLength: { value: "concise", source: "user" },
      suggestionMode: { value: "reasonFirst", source: "user" },
      challengeStyle: { value: "direct", source: "user" },
      additionalBoundary: "",
      contextAllowed: true,
      answerVersion: 1
    },
    completedAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z"
  },
  migration: { selectedFlow: "v2" }
}, defaultOnboardingV2);
const extraction = prepareUserModelExtraction(store, {
  sourceRevision: store.onboardingV2.session.revision
});
assert.ok(extraction.value, "ready transition must have a complete, permitted core-model extraction input");
store.aiTasks.push({
  id: "core-model-extraction",
  kind: "onboardingClaimExtraction",
  status: "succeeded",
  targetId: "onboarding-v2",
  inputVersion: store.onboardingV2.session.revision,
  inputHash: extraction.value.inputHash
});
assert.equal(readiness().ready, true, "gate release requires a real ready-model fixture");
await backgroundAi.releaseWaiting();
assert.equal(reflectionTask.status, "stale", "a journal edited during the wait must not receive a stale reflection");
assert.equal(store.aiTasks.filter(task => task.kind === "journalReflection" && task.status === "stale").length, 1);
assert.equal(prepareCalls, requests.length - 2, "latest prompts are prepared only after readiness; stale journal targets are rejected first");
assert.equal(providerCalls, 0, "release only schedules work; provider calls still require worker execution");
assert.equal(store.aiTasks.filter(task => task.status === "queued").length, requests.length - 2);

const captureSourceKey = JSON.stringify(["capture", "capture-context", "", ""]);
const setCapturePermission = (contextAllowed, revision) => {
  const permission = {
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: captureSourceKey,
    contextAllowed,
    learningAllowed: false,
    revision,
    updatedAt: `2026-10-10T00:00:0${revision}.000Z`
  };
  const existing = store.evidencePermissions.findIndex(item => item.sourceKey === captureSourceKey);
  if (existing < 0) store.evidencePermissions.push(permission);
  else store.evidencePermissions[existing] = permission;
};

for (const kind of ["thoughtDraft", "thoughtPrompt", "journalAssist"]) {
  const task = store.aiTasks.find(item => item.kind === kind && item.status === "queued");
  assert.ok(task, `${kind} should be queued after readiness`);
  setCapturePermission(true, store.evidencePermissions.length + 1);
  const handler = kind === "journalAssist"
    ? captureJournalWorkflows.personalizedTaskHandler
    : thoughtWorkflows.personalizedTaskHandler;
  const prepared = handler.prepare(structuredClone(store), task);
  assert.match(prepared.contextFingerprint, /^[a-f0-9]{64}$/,
    `${kind} must carry a persisted-context fingerprint`);

  let notifyStarted, releaseGeneration;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const wait = new Promise(resolve => { releaseGeneration = resolve; });
  generationGate = { notifyStarted, wait };
  const running = backgroundAi.run(task.id);
  await started;
  const revision = store.evidencePermissions.find(item => item.sourceKey === captureSourceKey).revision;
  setCapturePermission(false, revision + 1);
  releaseGeneration();
  await running;
  generationGate = null;
  assert.equal(task.status, "stale", `${kind} must discard results after context permission is withdrawn`);
  assert.equal(task.errorCode, "AI_TASK_STALE");
  assert.equal(Boolean(task.resultId), false, `${kind} must not persist a result after permission withdrawal`);
}

const missingEvidenceTask = store.aiTasks.find(item => item.kind === "analysis");
assert.ok(missingEvidenceTask);
await backgroundAi.run(missingEvidenceTask.id);
assert.equal(missingEvidenceTask.status, "failed");
assert.equal(missingEvidenceTask.errorCode, "REVIEW_EVIDENCE_REQUIRED",
  "a cold-start analysis with no permitted evidence must expose its async failure code");
assert.match(missingEvidenceTask.error, /先留下一条状态/);
const visibleAnalysisTask = await backgroundAi.get(missingEvidenceTask.id);
assert.equal(visibleAnalysisTask.errorCode, "REVIEW_EVIDENCE_REQUIRED");
assert.match(visibleAnalysisTask.error, /先留下一条状态/);

console.log("个性化 AI 冷启回归通过：10 个 legacy/v1 入口持久化等待；冷启无 provider 调用或上下文编译；超限、撤权失效和异步错误码均生效。");
