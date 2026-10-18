import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./prompt-test-setup.mjs";
import { chatHistory, chatMessage, createChatRecords } from "../src/modules/chats/index.mjs";
import {
  createReviewRecords,
  customMetricPayload,
  experimentPayload,
  reflectionEvidence
} from "../src/modules/reviews/index.mjs";
import {
  createStatisticsService,
  operationStatistics,
  recordStatistics,
  statisticsRange
} from "../src/modules/statistics/index.mjs";
import { createReviewChatWorkflows, prepareReferenceRequest } from "../src/app/index.mjs";
import {
  createApiV1Http,
  createReviewsChatHttp,
  openApiV1,
  reviewsChatComponents,
  reviewsChatOpenApiFragment,
  reviewsChatPaths
} from "../src/http/index.mjs";
import { eventTimeFields } from "../src/shared/time/index.mjs";
import { recordVersion } from "../src/shared/validation/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const context = new AsyncLocalStorage();
const accountId = () => context.getStore() || "account-a";
const run = (id, operation) => context.run(id, operation);
const timestamp = "2026-09-29T08:00:00.000Z";
let sequence = 0;

function emptyStore() {
  return {
    checkins: [],
    dailyRecords: [],
    captures: [],
    journals: [],
    thoughts: [],
    chats: [],
    books: [],
    keepsakes: [],
    quotes: [],
    experiments: [],
    analyses: [],
    customMetrics: [],
    actions: [],
    habits: [],
    habitCheckins: [],
    evidenceSources: [],
    evidencePermissions: [],
    perceptionEvents: [],
    trash: [],
    commercialization: { assumptions: { common: { usdCny: 7.2 } } },
    onboarding: {}
  };
}

const stores = new Map([
  ["account-a", emptyStore()],
  ["account-b", emptyStore()],
  ["account-empty", emptyStore()],
  ["account-denied", emptyStore()]
]);
stores.get("account-a").thoughts = [0, 1, 2].map(index => ({
  id: `thought-${index}`,
  type: "question",
  content: `复盘证据 ${index}`,
  tags: ["验证"],
  disposition: "kept",
  followUps: index ? [] : [{ question: "追问", answer: "回答" }],
  authorType: "user",
  occurredOn: "2026-09-29",
  occurredAt: timestamp
}));
stores.get("account-a").evidencePermissions = stores.get("account-a").thoughts.map(item => ({
  schemaVersion: 1,
  accountId: "account-a",
  sourceKey: JSON.stringify(["thought", item.id, item.id, `question:${item.id}`]),
  contextAllowed: true,
  learningAllowed: true,
  revision: 1,
  updatedAt: timestamp
}));
stores.get("account-a").chats = Array.from({ length: 13 }, (_, index) => ({
  id: `history-${index}`,
  createdAt: timestamp,
  occurredAt: timestamp,
  occurredOn: "2026-09-29",
  message: `历史问题 ${index}`,
  answer: `历史回答 ${index}`,
  annotations: [],
  annotationDrift: [],
  version: 1
}));
stores.get("account-a").actions = [
  {
    id: "action-feedback",
    title: "完成最小验证",
    status: "done",
    completedAt: timestamp,
    completionFeedback: {
      outcome: "mixed",
      note: "方案有效，但需要减少切换",
      learningAllowed: true,
      recordedAt: timestamp
    },
    statusHistory: [{
      from: "doing",
      to: "done",
      reason: "complete",
      changedAt: timestamp,
      feedback: {
        outcome: "mixed",
        note: "方案有效，但需要减少切换",
        learningAllowed: true,
        recordedAt: timestamp
      }
    }],
    version: 2
  },
  {
    id: "action-without-feedback",
    title: "只记录完成",
    status: "done",
    completedAt: timestamp,
    statusHistory: [{
      from: "doing",
      to: "done",
      reason: "complete",
      changedAt: timestamp
    }],
    version: 2
  }
];
stores.get("account-a").habits = [{
  id: "habit-feedback",
  title: "每日回望",
  status: "active",
  frequency: { cadence: "daily", target: 1 },
  version: 1
}];
stores.get("account-a").habitCheckins = [{
  id: "habit-checkin-feedback",
  habitId: "habit-feedback",
  occurredOn: "2026-09-29",
  feeling: "更容易收尾",
  adjustment: "下次提前十分钟",
  version: 1
}];
stores.get("account-b").thoughts = [{
  id: "account-b-thought",
  type: "question",
  content: "账户 B 的证据",
  tags: [],
  disposition: "kept",
  followUps: [],
  authorType: "user",
  occurredOn: "2026-09-29",
  occurredAt: timestamp
}];
stores.get("account-b").evidencePermissions = [{
  schemaVersion: 1,
  accountId: "account-b",
  sourceKey: JSON.stringify([
    "thought",
    "account-b-thought",
    "account-b-thought",
    "question:account-b-thought"
  ]),
  contextAllowed: true,
  learningAllowed: true,
  revision: 1,
  updatedAt: timestamp
}];

let failCommit = false;
const fullRepository = {
  async read() {
    return structuredClone(stores.get(accountId()));
  },
  async update(mutate) {
    const id = accountId();
    const store = structuredClone(stores.get(id));
    const result = await mutate(store);
    if (failCommit) throw new Error("injected commit failure");
    stores.set(id, store);
    return structuredClone(result);
  }
};
const chatRepository = {
  async read() {
    const store = stores.get(accountId());
    return structuredClone({ items: store.chats, trash: store.trash });
  },
  async update(mutate) {
    const id = accountId();
    const store = structuredClone(stores.get(id));
    const result = await mutate(store.chats, store.trash);
    if (failCommit) throw new Error("injected commit failure");
    stores.set(id, store);
    return result;
  }
};
const reviewRepository = {
  async read() {
    const store = stores.get(accountId());
    return structuredClone({
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    });
  },
  async update(mutate) {
    const id = accountId();
    const store = structuredClone(stores.get(id));
    const document = {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics
    };
    const result = await mutate(document, store.trash);
    if (failCommit) throw new Error("injected commit failure");
    stores.set(id, store);
    return result;
  }
};

const chats = createChatRecords({
  repository: chatRepository,
  now: () => timestamp,
  createId: () => `chat-${++sequence}`
});
const reviews = createReviewRecords({
  repository: reviewRepository,
  now: () => timestamp,
  createId: () => `review-${++sequence}`
});

assert.equal(chatMessage({ message: "  问题  " }).value, "问题");
assert.equal(chatMessage({ message: " " }).error, "请先写下问题");
assert.equal(chatHistory(stores.get("account-a").chats).length, 24);
assert.equal(chatHistory(stores.get("account-a").chats)[0].content, "历史问题 11");
assert.deepEqual(experimentPayload({ hypothesis: "验证晨练", factor: "晨练" }).value, {
  hypothesis: "验证晨练",
  factor: "晨练",
  outcome: "mood",
  duration: 30,
  status: "active"
});
assert.equal(experimentPayload({ hypothesis: "", factor: "晨练" }).error, "请填写假设和唯一实验因素");
assert.deepEqual(customMetricPayload({ name: "专注" }).value, {
  name: "专注",
  low: "很低",
  high: "很高"
});
const evidence = reflectionEvidence(stores.get("account-a"));
assert.equal(evidence.evidenceCount, 4);
assert.equal(evidence.evidenceLevel, "常规样本");
assert.equal(evidence.reflectionData[0].followUps[0].answer, "回答");
assert.equal(evidence.actionFeedbackCount, 1);
assert.ok(evidence.reflectionData.some(item => (
  item.type === "actionFeedback"
  && item.outcome === "mixed"
  && item.note === "方案有效，但需要减少切换"
)));
assert.equal(evidence.reflectionData.some(item => (
  item.type === "actionFeedback" && item.actionId === "action-without-feedback"
)), false);
assert.equal(evidence.reflectionData.some(item => item.type === "habitFeedback"), false);
assert.equal(reflectionEvidence({
  actions: [{
    ...stores.get("account-a").actions[0],
    completionFeedback: {
      ...stores.get("account-a").actions[0].completionFeedback,
      learningAllowed: false
    },
    statusHistory: stores.get("account-a").actions[0].statusHistory.map(entry => ({
      ...entry,
      feedback: { ...entry.feedback, learningAllowed: false }
    }))
  }],
  permissionPurpose: "learning"
}).actionFeedbackCount, 0);
assert.equal(reflectionEvidence({
  thoughts: Array.from({ length: 90 }, (_, index) => ({ type: "record", content: String(index) }))
}).reflectionData.length, 80);

const generationCalls = [];
const formatGeneratedAnswer = (content, options) => options?.json === true
  ? JSON.stringify({ answer: content, citations: [] })
  : content;
let releaseGeneration;
const pauseGeneration = new Promise(resolve => { releaseGeneration = resolve; });
let pauseNextChat = false;
let pauseNextAnalysis = false;
let releaseAnalysis = () => {};
let analysisStarted = Promise.resolve();
let markAnalysisStarted = () => {};
const generate = async (prompt, options) => {
  generationCalls.push({ prompt, options });
  if (pauseNextChat && options.scene === "chat") {
    pauseNextChat = false;
    await pauseGeneration;
  }
  if (pauseNextAnalysis && options.scene === "analysis") {
    pauseNextAnalysis = false;
    markAnalysisStarted();
    await new Promise(resolve => { releaseAnalysis = resolve; });
  }
  return options.scene === "chat"
    ? { content: formatGeneratedAnswer("共参回答", options), reasoningContent: "共参思考" }
    : { content: formatGeneratedAnswer("复盘结论", options), reasoningContent: "复盘思考" };
};
const workflows = createReviewChatWorkflows({
  repository: fullRepository,
  chats,
  reviews,
  generate,
  hash,
  contextKey: accountId,
  currentTime: () => Date.parse("2026-09-29T08:00:00.000Z")
});
const eventTime = { occurredAt: timestamp, occurredOn: "2026-09-29" };

stores.get("account-denied").thoughts = [{
  id: "denied-thought",
  type: "question",
  content: "REVOKED_SYNTHESIS_SECRET",
  authorType: "user",
  version: 1
}];
stores.get("account-denied").evidencePermissions = [{
  schemaVersion: 1,
  accountId: "account-denied",
  sourceKey: JSON.stringify([
    "thought",
    "denied-thought",
    "denied-thought",
    "question:denied-thought"
  ]),
  contextAllowed: true,
  learningAllowed: false,
  revision: 1,
  updatedAt: timestamp
}];
stores.get("account-denied").actions = [{
  id: "denied-action-feedback",
  title: "不应自动学习的行动",
  status: "done",
  completionFeedback: {
    outcome: "helpful",
    note: "PRIVATE_ACTION_FEEDBACK",
    learningAllowed: false,
    recordedAt: timestamp
  },
  statusHistory: [{
    from: "doing",
    to: "done",
    reason: "complete",
    changedAt: timestamp,
    feedback: {
      outcome: "helpful",
      note: "PRIVATE_ACTION_FEEDBACK",
      learningAllowed: false,
      recordedAt: timestamp
    }
  }],
  version: 2
}];
const deniedCallsBefore = generationCalls.length;
await assert.rejects(
  run("account-denied", () => workflows.runAnalysis({
    clientRequestId: "denied-analysis"
  })),
  /先留下一条状态、健康、捕念、日记或思绪记录/
);
assert.equal(generationCalls.length, deniedCallsBefore);
assert.equal(generationCalls.some(call => call.prompt.includes("REVOKED_SYNTHESIS_SECRET")), false);
stores.get("account-denied").actions[0].completionFeedback.learningAllowed = true;
stores.get("account-denied").actions[0].statusHistory[0].feedback.learningAllowed = true;
const feedbackAnalysis = await run("account-denied", () => workflows.runAnalysis({
  clientRequestId: "allowed-feedback-analysis"
}));
assert.equal(generationCalls.length, deniedCallsBefore + 1);
assert.match(generationCalls.at(-1).prompt, /PRIVATE_ACTION_FEEDBACK/);
assert.doesNotMatch(generationCalls.at(-1).prompt, /REVOKED_SYNTHESIS_SECRET/);
assert.ok(feedbackAnalysis.value.contextReceipt.sources.some(source => (
  source.resourceType === "action"
  && source.resourceId === "denied-action-feedback"
)));
stores.get("account-denied").thoughts[0].followUps = [{
  id: "denied-follow-up",
  question: "DENIED_FOLLOW_UP_QUESTION",
  answer: "DENIED_FOLLOW_UP_ANSWER",
  version: 1
}];
stores.get("account-denied").evidencePermissions[0].learningAllowed = true;
stores.get("account-denied").evidencePermissions.push(
  {
    schemaVersion: 1,
    accountId: "account-denied",
    sourceKey: JSON.stringify([
      "thought",
      "denied-follow-up",
      "denied-thought",
      "followup-question:denied-follow-up"
    ]),
    contextAllowed: true,
    learningAllowed: false,
    revision: 1,
    updatedAt: timestamp
  },
  {
    schemaVersion: 1,
    accountId: "account-denied",
    sourceKey: JSON.stringify([
      "thought",
      "denied-follow-up",
      "denied-thought",
      "followup-answer:denied-follow-up"
    ]),
    contextAllowed: true,
    learningAllowed: false,
    revision: 1,
    updatedAt: timestamp
  }
);
await run("account-denied", () => workflows.runAnalysis({
  clientRequestId: "nested-denied-analysis"
}));
assert.doesNotMatch(generationCalls.at(-1).prompt, /DENIED_FOLLOW_UP/);
stores.get("account-denied").evidencePermissions[0].learningAllowed = false;
stores.get("account-denied").evidencePermissions[2].learningAllowed = true;
stores.get("account-denied").actions[0].completionFeedback.learningAllowed = false;
stores.get("account-denied").actions[0].statusHistory[0].feedback.learningAllowed = false;
await run("account-denied", () => workflows.runAnalysis({
  clientRequestId: "answer-only-analysis"
}));
assert.doesNotMatch(generationCalls.at(-1).prompt, /DENIED_FOLLOW_UP_QUESTION/);
assert.match(generationCalls.at(-1).prompt, /DENIED_FOLLOW_UP_ANSWER/);
stores.get("account-denied").evidencePermissions[1].learningAllowed = true;
const childOnlyAnalysis = await run("account-denied", () => workflows.runAnalysis({
  clientRequestId: "child-only-analysis"
}));
assert.doesNotMatch(generationCalls.at(-1).prompt, /REVOKED_SYNTHESIS_SECRET/);
assert.match(generationCalls.at(-1).prompt, /DENIED_FOLLOW_UP_QUESTION/);
assert.match(generationCalls.at(-1).prompt, /DENIED_FOLLOW_UP_ANSWER/);
assert.ok(childOnlyAnalysis.value.contextReceipt.sources.some(source => (
  source.location?.targetKey === "followup-question:denied-follow-up"
)));
assert.ok(childOnlyAnalysis.value.contextReceipt.sources.some(source => (
  source.location?.targetKey === "followup-answer:denied-follow-up"
)));

const legacyChat = await run("account-a", () => workflows.answerChat({
  message: "  请结合长期记录回答  ",
  eventTime
}));
assert.equal(legacyChat.value.message, "请结合长期记录回答");
assert.equal(legacyChat.value.answer, "共参回答");
assert.equal(legacyChat.value.reasoningContent, "共参思考");
assert.equal(legacyChat.value.contextReceipt.version, "2026.10.02.2");
assert.equal("version" in legacyChat.value, false);
assert.equal(generationCalls.at(-1).options.scene, "chat");
assert.equal(generationCalls.at(-1).options.captureReasoning, true);
assert.equal(legacyChat.value.contextReceipt.promptSha256, generationCalls.at(-1).options.contextReceipt.promptSha256);
assert.equal(legacyChat.value.contextReceipt.sources.some(source => Object.hasOwn(source, "excerpt")), false);
assert.equal(generationCalls.at(-1).options.history.length, 24);
assert.match(generationCalls.at(-1).prompt, /请结合长期记录回答/);

const chatCallsBeforeIdempotency = generationCalls.length;
const idempotentChatInput = {
  message: "幂等共参",
  eventTime,
  eventTimeHash: timestamp,
  clientRequestId: "chat-request-1"
};
const createdChat = await run("account-a", () => workflows.answerChat(idempotentChatInput));
const repeatedChat = await run("account-a", () => workflows.answerChat(idempotentChatInput));
assert.equal(createdChat.value.version, 1);
assert.equal(repeatedChat.duplicate, true);
assert.equal(repeatedChat.value.id, createdChat.value.id);
assert.equal(generationCalls.length, chatCallsBeforeIdempotency + 1);
assert.equal((await run("account-a", () => workflows.answerChat({
  ...idempotentChatInput,
  message: "复用键但内容不同"
}))).conflict, true);
assert.equal(generationCalls.length, chatCallsBeforeIdempotency + 1);

pauseNextChat = true;
const concurrentStart = generationCalls.length;
const concurrent = run("account-a", () => Promise.all([
  workflows.answerChat({ ...idempotentChatInput, clientRequestId: "chat-request-concurrent" }),
  workflows.answerChat({ ...idempotentChatInput, clientRequestId: "chat-request-concurrent" })
]));
await new Promise(resolve => setImmediate(resolve));
assert.equal(generationCalls.length, concurrentStart + 1);
releaseGeneration();
const concurrentResults = await concurrent;
assert.equal(concurrentResults[0].value.id, concurrentResults[1].value.id);
assert.equal(stores.get("account-a").chats.filter(item => item.clientRequestId === "chat-request-concurrent").length, 1);

const accountBChat = await run("account-b", () => workflows.answerChat(idempotentChatInput));
assert.notEqual(accountBChat.value.id, createdChat.value.id);
assert.equal(stores.get("account-b").chats.length, 1);
assert.equal(stores.get("account-a").chats.some(item => item.id === accountBChat.value.id), false);

const analysisCallsBefore = generationCalls.length;
const analysis = await run("account-a", () => workflows.runAnalysis({
  clientRequestId: "analysis-request-1"
}));
assert.equal(analysis.value.reason, "manual");
assert.equal(analysis.value.content, "复盘结论");
assert.equal(analysis.value.reasoningContent, "复盘思考");
assert.equal(analysis.value.contextReceipt.version, "2026.10.02.2");
assert.equal(analysis.value.version, 1);
assert.equal(generationCalls.length, analysisCallsBefore + 1);
assert.equal(generationCalls.at(-1).options.scene, "analysis");
assert.match(generationCalls.at(-1).options.systemPrompt, /周期综合/);
assert.equal(generationCalls.at(-1).options.captureReasoning, true);
assert.equal(analysis.value.contextReceipt.promptSha256, generationCalls.at(-1).options.contextReceipt.promptSha256);
assert.equal(analysis.value.contextReceipt.sources.some(source => Object.hasOwn(source, "excerpt")), false);
assert.match(generationCalls.at(-1).prompt, /当前证据等级：常规样本/);
assert.match(generationCalls.at(-1).prompt, /复盘证据 0/);
assert.match(generationCalls.at(-1).prompt, /方案有效，但需要减少切换/);
assert.doesNotMatch(generationCalls.at(-1).prompt, /更容易收尾/);
assert.doesNotMatch(generationCalls.at(-1).prompt, /共参思考/);
assert.equal(analysis.value.reviewStatus, "candidate");
const confirmedAnalysis = await run("account-a", () => reviews.reviewAnalysis(
  analysis.value.id,
  { decision: "confirm", reason: "核对过来源" },
  { expectedVersion: 1 }
));
assert.equal(confirmedAnalysis.value.reviewStatus, "confirmed");
assert.equal(confirmedAnalysis.value.reviewDisposition, "核对过来源");
assert.equal(confirmedAnalysis.value.version, 2);
assert.deepEqual(await run("account-a", () => reviews.reviewAnalysis(
  analysis.value.id,
  { decision: "reject" },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });
const repeatedAnalysis = await run("account-a", () => workflows.runAnalysis({
  clientRequestId: "analysis-request-1"
}));
assert.equal(repeatedAnalysis.duplicate, true);
assert.equal(generationCalls.length, analysisCallsBefore + 1);
pauseNextAnalysis = true;
analysisStarted = new Promise(resolve => { markAnalysisStarted = resolve; });
const staleAnalysis = run("account-a", () => workflows.runAnalysis({
  clientRequestId: "analysis-permission-aba"
}));
await analysisStarted;
stores.get("account-a").evidencePermissions[0].revision += 2;
releaseAnalysis();
await assert.rejects(
  staleAnalysis,
  error => error.code === "STALE_PERSONAL_CONTEXT"
);
pauseNextAnalysis = true;
analysisStarted = new Promise(resolve => { markAnalysisStarted = resolve; });
const abaAnalysis = run("account-a", () => workflows.runAnalysis({
  clientRequestId: "analysis-source-aba"
}));
await analysisStarted;
stores.get("account-a").thoughts[0].version = 3;
releaseAnalysis();
await assert.rejects(
  abaAnalysis,
  error => error.code === "STALE_PERSONAL_CONTEXT"
);
await assert.rejects(
  run("account-empty", () => workflows.runAnalysis()),
  /先留下一条状态、健康、捕念、日记或思绪记录/
);

stores.get("account-b").thoughts = Array.from({ length: 5 }, (_, index) => ({
  id: `periodic-${index}`,
  type: "question",
  content: `周期证据 ${index}`,
  tags: [],
  followUps: [],
  authorType: "user"
}));
stores.get("account-b").evidencePermissions = stores.get("account-b").thoughts.map(item => ({
  schemaVersion: 1,
  accountId: "account-b",
  sourceKey: JSON.stringify(["thought", item.id, item.id, `question:${item.id}`]),
  contextAllowed: true,
  learningAllowed: true,
  revision: 1,
  updatedAt: timestamp
}));
const periodic = await run("account-b", () => workflows.maybeRunPeriodicAnalysis());
assert.equal(periodic.reason, "weekly-background");
assert.equal(await run("account-b", () => workflows.maybeRunPeriodicAnalysis()), null);

const legacyExperiment = await run("account-a", () => reviews.createExperiment({
  hypothesis: "减少晚间屏幕时间会改善睡眠",
  factor: "晚间屏幕时间",
  outcome: "invalid",
  duration: 99
}));
assert.equal(legacyExperiment.value.outcome, "mood");
assert.equal(legacyExperiment.value.duration, 30);
assert.equal("version" in legacyExperiment.value, false);
const v1Experiment = await run("account-a", () => reviews.createExperiment({
  hypothesis: "晨练提高精力",
  factor: "晨练",
  outcome: "energy",
  duration: 14
}, { clientRequestId: "experiment-request-1" }));
assert.equal(v1Experiment.value.version, 1);
assert.equal((await run("account-a", () => reviews.createExperiment({
  hypothesis: "晨练提高精力",
  factor: "晨练",
  outcome: "energy",
  duration: 14
}, { clientRequestId: "experiment-request-1" }))).duplicate, true);
assert.equal((await run("account-a", () => reviews.createExperiment({
  hypothesis: "不同实验",
  factor: "晨练"
}, { clientRequestId: "experiment-request-1" }))).conflict, true);
const firstMetric = await run("account-a", () => reviews.createCustomMetric({ name: "专注" }));
const secondMetric = await run("account-a", () => reviews.createCustomMetric({
  name: "恢复",
  low: "慢",
  high: "快"
}));
assert.deepEqual(stores.get("account-a").customMetrics.slice(-2).map(item => item.id), [
  firstMetric.value.id,
  secondMetric.value.id
]);
const beforeFailure = structuredClone(stores.get("account-a"));
failCommit = true;
await assert.rejects(
  run("account-a", () => reviews.createCustomMetric({ name: "不应写入" })),
  /injected commit failure/
);
assert.deepEqual(stores.get("account-a"), beforeFailure);
failCommit = false;

const durableAccount = "account-ledger";
const durableStore = emptyStore();
durableStore.thoughts.push({
  id: "durable-evidence",
  type: "question",
  content: "持久账本复盘证据",
  tags: [],
  disposition: "kept",
  followUps: [],
  authorType: "user",
  occurredOn: "2026-09-29",
  occurredAt: timestamp,
  version: 1
});
durableStore.evidencePermissions.push({
  schemaVersion: 1,
  accountId: durableAccount,
  sourceKey: JSON.stringify([
    "thought",
    "durable-evidence",
    "durable-evidence",
    "question:durable-evidence"
  ]),
  contextAllowed: true,
  learningAllowed: true,
  revision: 1,
  updatedAt: timestamp
});
const durableStores = new Map([[durableAccount, durableStore]]);
const durableLedgers = new Map();
const durableQueues = new Map();
const durableEvents = [];
let durableTransactionDepth = 0;
let durableSequence = 0;
const durableLedgerKey = (id, request) => `${id}:${request.scope}:${request.key}`;
const durableConflict = () => Object.assign(new Error("同一幂等键不能用于不同内容"), {
  statusCode: 409,
  code: "IDEMPOTENCY_KEY_REUSED"
});
const durableReplay = (id, request) => {
  const entry = durableLedgers.get(durableLedgerKey(id, request));
  if (!entry) return undefined;
  if (entry.requestHash !== request.requestHash) throw durableConflict();
  return structuredClone(entry.response);
};
const durableExclusive = (id, operation) => {
  const previous = durableQueues.get(id) || Promise.resolve();
  const current = previous.then(operation);
  durableQueues.set(id, current.catch(() => {}));
  return current;
};
const durableRepository = {
  async read() {
    return structuredClone(durableStores.get(accountId()));
  },
  async update(mutate) {
    const id = accountId();
    return durableExclusive(id, async () => {
      const document = structuredClone(durableStores.get(id));
      durableTransactionDepth += 1;
      try {
        const result = await mutate(document);
        durableStores.set(id, document);
        return structuredClone(result);
      } finally {
        durableTransactionDepth -= 1;
      }
    });
  },
  async readIdempotent(request) {
    const id = accountId();
    durableEvents.push(`read:${request.scope}:${request.key}`);
    return durableReplay(id, request);
  },
  executeIdempotent(request, operation) {
    const id = accountId();
    return durableExclusive(id, async () => {
      durableEvents.push(`execute:${request.scope}:${request.key}`);
      const replay = durableReplay(id, request);
      if (replay !== undefined) return replay;
      const document = structuredClone(durableStores.get(id));
      durableTransactionDepth += 1;
      try {
        const response = await operation(document);
        durableStores.set(id, document);
        durableLedgers.set(durableLedgerKey(id, request), {
          requestHash: request.requestHash,
          response: structuredClone(response)
        });
        return structuredClone(response);
      } finally {
        durableTransactionDepth -= 1;
      }
    });
  }
};
const durableChatRepository = {
  async read() {
    const store = await durableRepository.read();
    return { items: store.chats, trash: store.trash };
  },
  update(mutate) {
    return durableRepository.update(store => mutate(store.chats, store.trash));
  },
  readIdempotent: request => durableRepository.readIdempotent(request),
  executeIdempotent(request, operation) {
    return durableRepository.executeIdempotent(
      request,
      store => operation(store.chats, store.trash)
    );
  }
};
const durableReviewRepository = {
  async read() {
    const store = await durableRepository.read();
    return {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    };
  },
  update(mutate) {
    return durableRepository.update(store => mutate({
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    }, store.trash));
  },
  readIdempotent: request => durableRepository.readIdempotent(request),
  executeIdempotent(request, operation) {
    return durableRepository.executeIdempotent(request, store => operation({
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    }, store.trash));
  }
};
const durableWorkflowRepository = {
  read: () => durableRepository.read(),
  update: operation => durableRepository.update(operation),
  readIdempotent: request => durableRepository.readIdempotent(request)
};
const durableChats = createChatRecords({
  repository: durableChatRepository,
  now: () => timestamp,
  createId: () => `durable-chat-${++durableSequence}`
});
const durableReviews = createReviewRecords({
  repository: durableReviewRepository,
  now: () => timestamp,
  createId: () => `durable-review-${++durableSequence}`
});
let pauseDurableChat = false;
let durableConcurrentCount = 0;
let releaseDurableGeneration = () => {};
let durableConcurrentStarted = Promise.resolve();
let markDurableConcurrentStarted = () => {};
const durableGenerationCalls = [];
const durableGenerate = async (prompt, options) => {
  assert.equal(durableTransactionDepth, 0, "AI generation must not run inside a repository transaction");
  durableGenerationCalls.push({ prompt, options });
  durableEvents.push(`generate:${options.scene}`);
  if (pauseDurableChat && options.scene === "chat" && prompt.includes("跨实例并发")) {
    durableConcurrentCount += 1;
    if (durableConcurrentCount === 2) markDurableConcurrentStarted();
    await new Promise(resolve => {
      const previous = releaseDurableGeneration;
      releaseDurableGeneration = () => {
        previous();
        resolve();
      };
    });
  }
  return options.scene === "chat"
    ? { content: formatGeneratedAnswer("持久共参回答", options), reasoningContent: "持久共参思考" }
    : { content: formatGeneratedAnswer("持久复盘结论", options), reasoningContent: "持久复盘思考" };
};
const durableWorkflowOptions = {
  repository: durableRepository,
  chats: durableChats,
  reviews: durableReviews,
  generate: durableGenerate,
  hash,
  contextKey: accountId,
  currentTime: () => Date.parse(timestamp)
};
const durableWorkflows = createReviewChatWorkflows(durableWorkflowOptions);
const purgeDurable = (collection, id) => run(durableAccount, () => durableRepository.update(store => {
  store[collection] = store[collection].filter(item => item.id !== id);
}));

const durableChatInput = {
  message: "持久账本共参",
  eventTime,
  eventTimeHash: timestamp,
  clientRequestId: "durable-chat-request"
};
let durableCallsBefore = durableGenerationCalls.length;
const durableChat = await run(durableAccount, () => durableWorkflows.answerChat(durableChatInput));
assert.equal(durableChat.duplicate, false);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);
const durableChatReadIndex = durableEvents.indexOf("read:chats.create:durable-chat-request");
const durableChatGenerateIndex = durableEvents.indexOf("generate:chat");
const durableChatExecuteIndex = durableEvents.indexOf("execute:chats.create:durable-chat-request");
assert.ok(durableChatReadIndex < durableChatGenerateIndex && durableChatGenerateIndex < durableChatExecuteIndex);
let durableResult = await run(durableAccount, () => durableWorkflows.answerChat(durableChatInput));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableChat.value.id);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);
durableResult = await run(durableAccount, () => durableWorkflows.answerChat({
  ...durableChatInput,
  message: "持久账本共参异内容"
}));
assert.equal(durableResult.conflict, true);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);
await purgeDurable("chats", durableChat.value.id);
durableResult = await run(durableAccount, () => durableWorkflows.answerChat(durableChatInput));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableChat.value.id);
assert.equal(durableStores.get(durableAccount).chats.length, 0);
durableResult = await run(durableAccount, () => durableWorkflows.answerChat({
  ...durableChatInput,
  message: "永久删除后的异内容共参"
}));
assert.equal(durableResult.conflict, true);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);

const durableAnalysisInput = { reason: "manual", clientRequestId: "durable-analysis-request" };
durableCallsBefore = durableGenerationCalls.length;
const durableAnalysis = await run(durableAccount, () => durableWorkflows.runAnalysis(durableAnalysisInput));
assert.equal(durableAnalysis.duplicate, false);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);
assert.ok(
  durableEvents.indexOf("read:analyses.create:durable-analysis-request")
  < durableEvents.indexOf("generate:analysis")
);
assert.ok(
  durableEvents.indexOf("generate:analysis")
  < durableEvents.indexOf("execute:analyses.create:durable-analysis-request")
);
durableResult = await run(durableAccount, () => durableWorkflows.runAnalysis(durableAnalysisInput));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableAnalysis.value.id);
durableResult = await run(durableAccount, () => durableWorkflows.runAnalysis({
  reason: "weekly-background",
  clientRequestId: durableAnalysisInput.clientRequestId
}));
assert.equal(durableResult.conflict, true);
await purgeDurable("analyses", durableAnalysis.value.id);
durableResult = await run(durableAccount, () => durableWorkflows.runAnalysis(durableAnalysisInput));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableAnalysis.value.id);
assert.equal(durableGenerationCalls.length, durableCallsBefore + 1);
durableResult = await run(durableAccount, () => durableWorkflows.runAnalysis({
  reason: "weekly-background",
  clientRequestId: durableAnalysisInput.clientRequestId
}));
assert.equal(durableResult.conflict, true);

const durableExperimentInput = {
  hypothesis: "持久实验",
  factor: "单一因素",
  outcome: "energy",
  duration: 14
};
const durableExperiment = await run(durableAccount, () => durableReviews.createExperiment(
  durableExperimentInput,
  { clientRequestId: "durable-experiment-request" }
));
assert.equal(durableExperiment.duplicate, false);
durableResult = await run(durableAccount, () => durableReviews.createExperiment(
  durableExperimentInput,
  { clientRequestId: "durable-experiment-request" }
));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableExperiment.value.id);
durableResult = await run(durableAccount, () => durableReviews.createExperiment(
  { ...durableExperimentInput, factor: "异内容因素" },
  { clientRequestId: "durable-experiment-request" }
));
assert.equal(durableResult.conflict, true);
await purgeDurable("experiments", durableExperiment.value.id);
durableResult = await run(durableAccount, () => durableReviews.createExperiment(
  durableExperimentInput,
  { clientRequestId: "durable-experiment-request" }
));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableExperiment.value.id);
assert.equal(durableStores.get(durableAccount).experiments.length, 0);
durableResult = await run(durableAccount, () => durableReviews.createExperiment(
  { ...durableExperimentInput, hypothesis: "永久删除后的异内容实验" },
  { clientRequestId: "durable-experiment-request" }
));
assert.equal(durableResult.conflict, true);

const durableMetricInput = { name: "持久清晰度", low: "模糊", high: "清楚" };
const durableMetric = await run(durableAccount, () => durableReviews.createCustomMetric(
  durableMetricInput,
  { clientRequestId: "durable-metric-request" }
));
assert.equal(durableMetric.duplicate, false);
durableResult = await run(durableAccount, () => durableReviews.createCustomMetric(
  durableMetricInput,
  { clientRequestId: "durable-metric-request" }
));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableMetric.value.id);
durableResult = await run(durableAccount, () => durableReviews.createCustomMetric(
  { ...durableMetricInput, name: "异内容指标" },
  { clientRequestId: "durable-metric-request" }
));
assert.equal(durableResult.conflict, true);
await purgeDurable("customMetrics", durableMetric.value.id);
durableResult = await run(durableAccount, () => durableReviews.createCustomMetric(
  durableMetricInput,
  { clientRequestId: "durable-metric-request" }
));
assert.equal(durableResult.duplicate, true);
assert.equal(durableResult.value.id, durableMetric.value.id);
assert.equal(durableStores.get(durableAccount).customMetrics.length, 0);
durableResult = await run(durableAccount, () => durableReviews.createCustomMetric(
  { ...durableMetricInput, high: "永久删除后的异内容" },
  { clientRequestId: "durable-metric-request" }
));
assert.equal(durableResult.conflict, true);

pauseDurableChat = true;
durableConcurrentStarted = new Promise(resolve => {
  markDurableConcurrentStarted = resolve;
});
const secondDurableWorkflows = createReviewChatWorkflows({
  ...durableWorkflowOptions,
  repository: durableWorkflowRepository
});
durableCallsBefore = durableGenerationCalls.length;
const durableConcurrent = run(durableAccount, () => Promise.all([
  durableWorkflows.answerChat({
    ...durableChatInput,
    message: "跨实例并发",
    clientRequestId: "durable-chat-concurrent"
  }),
  secondDurableWorkflows.answerChat({
    ...durableChatInput,
    message: "跨实例并发",
    clientRequestId: "durable-chat-concurrent"
  })
]));
await durableConcurrentStarted;
releaseDurableGeneration();
const durableConcurrentResults = await durableConcurrent;
pauseDurableChat = false;
assert.equal(durableGenerationCalls.length, durableCallsBefore + 2);
assert.equal(durableConcurrentResults[0].value.id, durableConcurrentResults[1].value.id);
assert.equal(durableConcurrentResults.filter(item => item.duplicate).length, 1);
assert.equal(
  durableStores.get(durableAccount).chats.filter(item => (
    item.clientRequestId === "durable-chat-concurrent"
  )).length,
  1
);

const statsFixture = emptyStore();
statsFixture.checkins.push({ id: "checkin" });
statsFixture.dailyRecords.push(
  { id: "sleep", type: "sleep" },
  { id: "exercise", type: "exercise" }
);
statsFixture.captures.push({
  id: "capture",
  annotations: [
    { kind: "highlight", replies: [{ id: "reply" }], shenji: [] },
    { kind: "comment", replies: [], shenji: [{ id: "shenji" }] }
  ]
});
statsFixture.journals.push({ id: "journal", reflections: [{ id: "reflection" }] });
statsFixture.thoughts.push({
  id: "question",
  type: "question",
  followUps: [{ id: "follow-up" }],
  remarks: [{ id: "remark" }]
});
statsFixture.chats.push({ id: "chat" });
statsFixture.books.push({ id: "book", notes: [{ id: "note" }] });
statsFixture.quotes.push({ id: "quote" });
statsFixture.keepsakes.push({ id: "keepsake" });
statsFixture.experiments.push({ id: "experiment" });
statsFixture.analyses.push({ id: "analysis" });
const recordSummary = recordStatistics(statsFixture);
assert.equal(recordSummary.content.find(item => item.key === "thoughts").count, 1);
assert.equal(recordSummary.content.find(item => item.key === "bookNotes").count, 1);
assert.equal(recordSummary.interactions.find(item => item.key === "highlights").count, 1);
assert.equal(recordSummary.interactions.find(item => item.key === "comments").count, 1);
assert.equal(recordSummary.interactions.find(item => item.key === "commentReplies").count, 1);
assert.equal(recordSummary.interactions.find(item => item.key === "shenji").count, 1);
assert.deepEqual(recordSummary.groups.map(item => item.label), ["今日", "所见", "所思", "互动"]);
assert.equal(
  recordSummary.groups.find(item => item.key === "today").modules.find(item => item.key === "daily").total,
  2
);
assert.equal(recordSummary.total, recordSummary.contentTotal + recordSummary.interactionTotal);

const operations = [
  { event: "request.completed", result: "success", action: "POST /api/chat", timestamp: "2026-09-28T03:00:00.000Z" },
  { event: "request.completed", result: "success", action: "POST /api/chat", timestamp: "2026-09-28T04:00:00.000Z" },
  { event: "request.completed", result: "success", action: "POST /api/keepsakes/segment", timestamp: "2026-09-29T04:00:00.000Z" },
  { event: "request.completed", result: "failed", action: "POST /api/chat", timestamp: "2026-09-29T05:00:00.000Z" },
  { event: "other", result: "success", action: "ignored", timestamp: "2026-09-29T05:00:00.000Z" }
];
assert.deepEqual(operationStatistics(operations), {
  completedWrites: 3,
  activeDays: 2,
  segmentationRequests: 1,
  topActions: [
    { action: "POST /api/chat", count: 2 },
    { action: "POST /api/keepsakes/segment", count: 1 }
  ]
});
assert.deepEqual(statisticsRange({}, "2026-09-29"), {
  value: { from: "2026-09-23", to: "2026-09-29" }
});
assert.equal(statisticsRange({ from: "2026-09-30", to: "2026-09-29" }, "2026-09-29").code, "STATISTICS_RANGE_INVALID");
assert.equal(statisticsRange({ from: "2010-01-01", to: "2026-09-29" }, "2026-09-29").code, "STATISTICS_RANGE_TOO_LARGE");

let ensuredUsage = 0;
let usageQuery = null;
const statistics = createStatisticsService({
  repository: fullRepository,
  ensureAiUsage: async () => { ensuredUsage += 1; },
  readAiUsage: async options => {
    usageQuery = options;
    return { entries: [{ id: "usage" }] };
  },
  readOperationEntries: async (from, to) => {
    assert.equal(from <= to, true);
    return operations;
  },
  aiDashboard: (usage, from, to, usdCny) => ({
    calls: usage.entries.length,
    from,
    to,
    usdCny
  }),
  today: () => "2026-09-29",
  getTimezone: () => "Asia/Shanghai"
});
const dashboard = await run("account-a", () => statistics.dashboard({}));
assert.equal(ensuredUsage, 1);
assert.deepEqual(usageQuery, {
  from: "2026-09-23",
  to: "2026-09-29",
  timezone: "Asia/Shanghai"
});
assert.deepEqual(dashboard.value.ai, {
  calls: 1,
  from: "2026-09-23",
  to: "2026-09-29",
  usdCny: 7.2
});
assert.equal(dashboard.value.service.completedWrites, 3);

async function remove(collection, type, id, expectedVersion = null) {
  const account = accountId();
  const store = structuredClone(stores.get(account));
  const index = store[collection].findIndex(item => item.id === id);
  if (index < 0) {
    return store.trash.find(item => item.type === type && item.resourceId === id) || null;
  }
  const item = store[collection][index];
  const currentVersion = recordVersion(item.version);
  if (expectedVersion != null && currentVersion !== expectedVersion) {
    return { versionConflict: true, currentVersion };
  }
  store[collection].splice(index, 1);
  const entry = {
    id: `trash-${id}`,
    type,
    resourceId: id,
    payload: item,
    deletedAt: timestamp,
    purgeAfter: "2026-10-29T08:00:00.000Z",
    lifecycle: "formal"
  };
  store.trash.unshift(entry);
  stores.set(account, store);
  return entry;
}

const sendJson = (res, status, body) => {
  res.status = status;
  res.body = body;
  res.headersSent = true;
  return body;
};
const sendTrashResult = async (res, entry, missingMessage) => (
  entry
    ? sendJson(res, 200, {
        removed: 1,
        trashId: entry.id,
        deletedAt: entry.deletedAt,
        purgeAfter: entry.purgeAfter,
        lifecycle: entry.lifecycle,
        tombstone: true
      })
    : sendJson(res, 404, { error: missingMessage })
);
const reviewsChatHttp = createReviewsChatHttp({
  chatRecords: chats,
  reviewRecords: reviews,
  workflows,
  statistics,
  remove,
  eventTimeFields,
  bodyJson: async req => req.body || {},
  sendJson,
  sendTrashResult
});

async function legacyRequest(account, method, pathname, body = {}) {
  const res = {};
  const handled = await run(account, () => reviewsChatHttp.handle(
    { method, body, headers: {} },
    res,
    new URL(`http://local${pathname}`)
  ));
  return { handled, ...res };
}

let response = await legacyRequest("account-a", "POST", "/api/chat", { message: " " });
assert.equal(response.handled, true);
assert.deepEqual([response.status, response.body], [400, { error: "请先写下问题" }]);
response = await legacyRequest("account-a", "POST", "/api/chat", {
  occurredAt: "2026-09-29T16:00:00.000Z",
  message: "旧接口共参"
});
assert.equal(response.status, 200);
assert.equal(response.body.answer, "共参回答");
assert.equal("version" in response.body, false);
response = await legacyRequest("account-a", "POST", "/api/analysis/run");
assert.equal(response.status, 201);
assert.equal(response.body.reason, "manual");
assert.equal("version" in response.body, false);
response = await legacyRequest("account-a", "POST", "/api/experiments", {
  hypothesis: "旧接口实验",
  factor: "单一因素"
});
assert.equal(response.status, 201);
assert.equal(response.body.duration, 30);
assert.equal("version" in response.body, false);
response = await legacyRequest("account-a", "POST", "/api/custom-metrics", { name: "旧指标" });
assert.equal(response.status, 201);
assert.deepEqual(
  { low: response.body.low, high: response.body.high },
  { low: "很低", high: "很高" }
);
assert.equal("version" in response.body, false);
response = await legacyRequest("account-a", "GET", "/api/statistics?from=bad&to=2026-09-29");
assert.equal(response.status, 400);
assert.deepEqual(response.body, { error: "统计时间范围不正确" });
response = await legacyRequest("account-a", "DELETE", `/api/experiments/${legacyExperiment.value.id}`);
assert.equal(response.status, 200);
assert.equal(response.body.tombstone, true);

const api = createApiV1Http({
  sendJson,
  getContext: () => ({ traceId: `trace-${accountId()}` }),
  openApi: openApiV1
});
api.register("reviews-chat", reviewsChatHttp.handleV1);

async function v1Request(account, method, pathname, { body = {}, headers = {} } = {}) {
  const responseHeaders = new Map();
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), String(value));
    }
  };
  const handled = await run(account, () => api.handle(
    { method, body, headers },
    res,
    new URL(`http://local${pathname}`)
  ));
  return { handled, status: res.status, body: res.body, headers: responseHeaders };
}

const pendingAnalysis = stores.get("account-a").analyses.find(item => (
  item.reviewStatus === "candidate"
));
await assert.rejects(
  v1Request("account-a", "PATCH", `/api/v1/analyses/${pendingAnalysis.id}`, {
    body: { decision: "confirm" }
  }),
  error => error.code === "PRECONDITION_REQUIRED" && error.statusCode === 428
);
response = await v1Request("account-a", "PATCH", `/api/v1/analyses/${pendingAnalysis.id}`, {
  headers: { "if-match": "\"1\"" },
  body: { decision: "reject", reason: "来源不足" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.reviewStatus, "rejected");
assert.equal(response.body.data.reviewDisposition, "来源不足");
assert.equal(response.headers.get("etag"), "\"2\"");

response = await v1Request("account-a", "POST", "/api/v1/custom-metrics", {
  headers: { "idempotency-key": "metric-v1-1" },
  body: { name: "清晰度", low: "模糊", high: "清楚" }
});
assert.equal(response.status, 201);
assert.equal(response.body.error, null);
assert.equal(response.body.meta.traceId, "trace-account-a");
assert.equal(response.body.data.version, 1);
assert.equal(response.headers.get("etag"), "\"1\"");
const metricId = response.body.data.id;
response = await v1Request("account-a", "POST", "/api/v1/custom-metrics", {
  headers: { "idempotency-key": "metric-v1-1" },
  body: { name: "清晰度", low: "模糊", high: "清楚" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, metricId);
response = await v1Request("account-a", "POST", "/api/v1/custom-metrics", {
  headers: { "idempotency-key": "metric-v1-1" },
  body: { name: "不同指标" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");
response = await v1Request("account-b", "GET", `/api/v1/custom-metrics/${metricId}`);
assert.equal(response.status, 404);
response = await v1Request("account-a", "GET", `/api/v1/custom-metrics/${metricId}`);
assert.equal(response.status, 200);
assert.equal(response.headers.get("etag"), "\"1\"");
response = await v1Request("account-a", "DELETE", `/api/v1/custom-metrics/${metricId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 412);
response = await v1Request("account-a", "DELETE", `/api/v1/custom-metrics/${metricId}`, {
  headers: { "if-match": "\"1\"" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.trashId, `trash-${metricId}`);

response = await v1Request("account-a", "POST", "/api/v1/chats", {
  headers: { "idempotency-key": "chat-http-v1" },
  body: { occurredAt: "2026-09-29T16:00:00.000Z", message: "v1 共参" }
});
assert.equal(response.status, 201);
assert.equal(response.body.data.answer, "共参回答");
const httpChatId = response.body.data.id;
response = await v1Request("account-a", "GET", `/api/v1/chats/${httpChatId}`);
assert.equal(response.status, 200);
response = await v1Request("account-a", "GET", "/api/v1/chats?limit=1");
assert.equal(response.status, 200);
assert.equal(response.body.data.length, 1);
assert.ok(response.body.meta.nextCursor);

response = await v1Request("account-empty", "POST", "/api/v1/analyses", {
  headers: { "idempotency-key": "empty-analysis" }
});
assert.equal(response.status, 400);
assert.equal(response.body.error.code, "REVIEW_EVIDENCE_REQUIRED");
response = await v1Request("account-a", "GET", "/api/v1/statistics?from=2026-09-29&to=2026-09-29");
assert.equal(response.status, 200);
assert.equal(response.body.data.service.completedWrites, 3);
assert.equal(await reviewsChatHttp.handle(
  { method: "GET", headers: {} },
  {},
  new URL("http://local/api/unrelated")
), false);

assert.strictEqual(reviewsChatOpenApiFragment.paths, reviewsChatPaths);
assert.strictEqual(reviewsChatOpenApiFragment.components, reviewsChatComponents);
assert.deepEqual(Object.keys(reviewsChatPaths).sort(), [
  "/analyses",
  "/analyses/{id}",
  "/chats",
  "/chats/{id}",
  "/custom-metrics",
  "/custom-metrics/{id}",
  "/experiments",
  "/experiments/{id}",
  "/statistics"
]);

function mergeComponents(base, addition) {
  const merged = { ...base };
  for (const [section, entries] of Object.entries(addition)) {
    merged[section] = { ...(merged[section] || {}), ...entries };
  }
  return merged;
}
const assembledOpenApi = {
  ...openApiV1,
  paths: { ...openApiV1.paths, ...reviewsChatPaths },
  components: mergeComponents(openApiV1.components, reviewsChatComponents)
};
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const operationsFrom = paths => Object.entries(paths).flatMap(([route, pathItem]) => (
  Object.entries(pathItem)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, operation]) => ({ route, method, operation }))
));
const fragmentOperations = operationsFrom(reviewsChatPaths);
assert.equal(fragmentOperations.length, 18);
const operationIds = operationsFrom(assembledOpenApi.paths).map(({ route, method, operation }) => {
  assert.ok(operation.operationId, `Missing operationId for ${method.toUpperCase()} ${route}`);
  return operation.operationId;
});
assert.equal(new Set(operationIds).size, operationIds.length);

function collectRefs(value, refs = []) {
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const nested of Object.values(value)) collectRefs(nested, refs);
  return refs;
}
function resolveRef(document, ref) {
  assert.match(ref, /^#\//);
  return ref.slice(2).split("/").reduce((value, encoded) => {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value && Object.hasOwn(value, key), `Unresolved OpenAPI reference: ${ref}`);
    return value[key];
  }, document);
}
for (const ref of collectRefs(assembledOpenApi)) resolveRef(assembledOpenApi, ref);
for (const [route, method, header] of [
  ["/chats", "post", "Idempotency-Key"],
  ["/analyses", "post", "Idempotency-Key"],
  ["/experiments", "post", "Idempotency-Key"],
  ["/custom-metrics", "post", "Idempotency-Key"],
  ["/chats/{id}", "delete", "If-Match"],
  ["/analyses/{id}", "delete", "If-Match"],
  ["/experiments/{id}", "delete", "If-Match"],
  ["/custom-metrics/{id}", "delete", "If-Match"]
]) {
  const pathItem = assembledOpenApi.paths[route];
  const parameters = [...(pathItem.parameters || []), ...(pathItem[method].parameters || [])]
    .map(parameter => parameter.$ref ? resolveRef(assembledOpenApi, parameter.$ref) : parameter);
  assert.ok(parameters.some(parameter => (
    parameter.in === "header"
    && parameter.required
    && parameter.name.toLowerCase() === header.toLowerCase()
  )), `${method.toUpperCase()} ${route} must require ${header}`);
}

const sourceFiles = [
  "src/modules/chats/index.mjs",
  "src/modules/chats/records.mjs",
  "src/modules/reviews/index.mjs",
  "src/modules/reviews/records.mjs",
  "src/modules/statistics/index.mjs",
  "src/app/review-chat-workflows.mjs",
  "src/http/reviews-chat.mjs",
  "src/http/openapi/reviews-chat.mjs"
];
for (const file of sourceFiles) {
  const source = await fs.readFile(path.join(ROOT, file), "utf8");
  assert.doesNotMatch(source, /\bnode:fs\b|\bstore\.json\b|\bai-usage\.json\b/, `${file} must not depend on concrete data files`);
}

// 实际同步与后台消费者使用同一补齐计划；学习许可保持原复盘口径。
const referenceFixture = structuredClone(stores.get("account-a"));
referenceFixture.captures = Array.from({ length: 12 }, (_, index) => ({ id: `reference-capture-${index}`,
  content: `合成可学习原文 ${index}。` + "甲".repeat(1000), authorType: "user", version: 1, createdAt: timestamp }));
referenceFixture.evidencePermissions = referenceFixture.captures.map(item => ({ schemaVersion: 1,
  accountId: "reference-account", sourceKey: JSON.stringify(["capture", item.id, "", ""]),
  contextAllowed: true, learningAllowed: true, revision: 1, updatedAt: timestamp }));
referenceFixture.chats = [];
referenceFixture.analyses = [];
stores.set("reference-account", referenceFixture);
await run("reference-account", () => workflows.answerChat({ message: "合成参考问题", clientRequestId: "reference-chat", eventTime }));
assert.ok(generationCalls.at(-1).options.contextReceipt.referenceRequest.providedCount >= 10);
await run("reference-account", () => workflows.runAnalysis({ clientRequestId: "reference-analysis" }));
assert.ok(generationCalls.at(-1).options.contextReceipt.referenceRequest.providedCount >= 10);
await run("reference-account", async () => {
  const source = stores.get("reference-account");
  for (const kind of ["chat", "analysis"]) {
    const task = { kind, id: `reference-task-${kind}`, clientRequestId: `reference-bg-${kind}`,
      payload: kind === "chat" ? { message: "后台合成问题", ...eventTime } : {}, createdAt: timestamp };
    const work = workflows.personalizedTaskHandler.prepare(source, task);
    assert.ok(work.contextReceipt.importanceReferences.plan.sources.length >= 10);
    assert.ok(prepareReferenceRequest(work.prompt, work.citationSources, `fixture-${kind}`).receipt.providedCount >= 10);
    task.importanceSelectionPlan = structuredClone(work.contextReceipt.importanceReferences.plan);
    const retry = workflows.personalizedTaskHandler.prepare(source, task);
    assert.equal(retry.prompt, work.prompt);
  }
});
console.log("Reviews/chat checks passed: legacy parity, persistent replay/conflict/purge, transaction-free AI generation, account isolation, statistics, v1 contracts and OpenAPI.");
