import assert from "node:assert/strict";
import {
  parseRecordCompressionOutput,
  RECORD_COMPRESSION_PROMPT_VERSION,
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  estimateRecordCompressionTokens,
  isRecordCompressionRecordEnvelope
} from "../src/modules/record-compressions/index.mjs";

const input = {
  schemaVersion: "record-compression-input.v1",
  promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
  sourceManifestHash: "a".repeat(64),
  window: {
    start: "2026-10-09T16:00:00.000Z",
    endExclusive: "2026-10-10T16:00:00.000Z",
    localDate: "2026-10-10",
    asOf: "2026-10-10T08:00:00.000Z",
    timezone: "Asia/Shanghai",
    completeness: "partial"
  },
  coverage: { total: 4, included: 4, excluded: 0, truncated: false },
  metrics: [{ metric: "sleep_duration", unit: "minute", sum: 480, count: 1, days: 1, min: 480, max: 480, sourceIds: ["U1"] }],
  userSources: [
    { sourceId: "U1", recordId: "sleep-1", version: 1, module: "daily", origin: "user_original", occurredAt: "2026-10-10T01:00:00.000Z", sourceHash: "1".repeat(64), permissionRevision: 0, text: "昨晚睡了八小时。" },
    { sourceId: "U2", recordId: "thought-1", version: 2, module: "thought", origin: "user_original", occurredAt: "2026-10-10T02:00:00.000Z", sourceHash: "2".repeat(64), permissionRevision: 3, text: "我长期希望做决定前先听完不同意见。" },
    { sourceId: "U3", recordId: "quote-1", version: 1, module: "other", origin: "quoted_external", occurredAt: "2026-10-10T03:00:00.000Z", sourceHash: "3".repeat(64), permissionRevision: 0, text: "外部引文正文。" }
  ],
  aiReferences: [
    { sourceId: "A1", recordId: "thought-1-answer-1", version: 1, module: "thought", origin: "ai_generated", occurredAt: "2026-10-10T04:00:00.000Z", sourceHash: "4".repeat(64), permissionRevision: 0, derivedFrom: ["U2"], text: "AI 认为用户可能偏好先听不同意见。" }
  ],
  warnings: ["一个未知来源已排除"]
};
const rawOutput = {
  schemaVersion: "record-compression-output.v1",
  daily: {
    observations: [
      { text: "睡眠记录为八小时。", nature: "user_fact", sourceIds: ["U1", "A1", "not-in-input"] },
      { text: "没有合法来源的内容。", sourceIds: ["not-in-input"] }
    ],
    metricKeys: ["sleep_duration", "made-up"],
    missing: []
  },
  thoughtsIdeas: {
    focus: [{ text: "持续关注决策质量。", sourceIds: ["U2"] }],
    changes: [],
    openQuestions: []
  },
  other: {
    themes: [{ text: "收藏了一条外部引文。", sourceIds: ["U2", "U3"] }],
    collectedQuotes: [{ text: "外部引文正文。", sourceIds: ["U3", "A1"] }]
  },
  aiReference: [
    { text: "未经证实的 AI 参考。", origin: "user_original", sourceIds: ["U2", "A1"], derivedFrom: ["U2", "not-in-input"] }
  ],
  stableUserCandidates: [
    { statement: "重视听取不同意见。", exactQuote: "做决定前先听完不同意见", sourceIds: ["U2"], scope: "historical_supplement" },
    { statement: "模型推断出的性格。", exactQuote: "模型推断出的性格", sourceIds: ["A1"], scope: "historical_supplement" },
    { statement: "没有原文的表达。", exactQuote: "不存在的引用", sourceIds: ["U2"], scope: "historical_supplement" }
  ],
  conflicts: [{ text: "存在可核验分歧。", sourceIds: ["U1"] }],
  warnings: ["模型补充告警"]
};

const summary = parseRecordCompressionOutput(JSON.stringify(rawOutput), {
  input,
  id: "compression-1",
  revision: 3,
  generatedAt: "2026-10-10T08:01:00.000Z"
});
assert.equal(summary.id, "compression-1");
assert.equal(summary.status, "ready");
assert.equal(summary.promptVersion, input.promptVersion);
assert.equal(summary.revision, 3);
assert.equal(summary.window.completeness, "partial");
assert.deepEqual(summary.coverage, input.coverage);
assert.deepEqual(summary.metrics, input.metrics, "model output cannot change server-calculated measurements");
assert.deepEqual(summary.daily.metricKeys, ["sleep_duration"]);
assert.deepEqual(summary.daily.observations[0].sourceIds, ["U1"]);
assert.equal(summary.daily.observations.length, 1);
assert.deepEqual(summary.other.themes[0].sourceIds, ["U2"], "external quotations cannot support user themes");
assert.deepEqual(summary.other.collectedQuotes[0].sourceIds, ["U3"]);
assert.deepEqual(summary.aiReference, [{
  text: "未经证实的 AI 参考。",
  origin: "ai_generated",
  sourceIds: ["A1"],
  derivedFrom: ["U2"]
}]);
assert.deepEqual(summary.stableUserCandidates, [{
  statement: "重视听取不同意见。",
  nature: "user_subjective",
  sourceIds: ["U2"],
  exactQuote: "做决定前先听完不同意见",
  scope: "historical_supplement"
}]);
assert.equal(summary.warnings.includes("一个未知来源已排除"), true);
assert.equal(summary.warnings.includes("部分稳定表达候选缺少可核验的用户原文，已剔除"), true);
assert.equal(JSON.stringify(summary.sourceManifest).includes("长期希望做决定"), false,
  "persisted provenance does not duplicate original text");
assert.equal(summary.tokenUsage.estimated, true);
assert.match(summary.tokenUsage.method, /^conservative-/);
assert.ok(summary.tokenUsage.outputTokens <= RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens);
assert.ok(summary.tokenUsage.moduleTokens.daily <= RECORD_COMPRESSION_OUTPUT_BUDGETS.dailyTokens);
assert.ok(summary.tokenUsage.moduleTokens.thoughtsIdeas <= RECORD_COMPRESSION_OUTPUT_BUDGETS.thoughtsIdeasTokens);
assert.ok(summary.tokenUsage.moduleTokens.other <= RECORD_COMPRESSION_OUTPUT_BUDGETS.otherTokens);
assert.ok(summary.tokenUsage.moduleTokens.aiReference <= RECORD_COMPRESSION_OUTPUT_BUDGETS.aiReferenceTokens);
assert.ok(summary.tokenUsage.stableCandidatesTokens <= RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens);
assert.ok(summary.stableUserCandidates.length <= RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateItems);

const oversizedInput = {
  ...input,
  userSources: [
    ...input.userSources,
    { sourceId: "U4", recordId: "large-thought", origin: "user_original", text: "长期关注原文。".repeat(1000) }
  ],
  aiReferences: [
    ...input.aiReferences,
    { sourceId: "A2", recordId: "large-ai", origin: "ai_generated", derivedFrom: ["U4"], text: "AI推断。".repeat(300) }
  ]
};
const oversizedOutput = {
  ...rawOutput,
  daily: {
    ...rawOutput.daily,
    observations: Array.from({ length: 20 }, (_, index) => ({
      text: `长日常摘要${index}。`.repeat(100),
      sourceIds: ["U1"]
    }))
  },
  thoughtsIdeas: {
    focus: [{ text: "长思绪摘要。".repeat(100), sourceIds: ["U2"] }],
    changes: [{ text: "长变化摘要。".repeat(100), sourceIds: ["U4"] }],
    openQuestions: [{ text: "长问题摘要。".repeat(100), sourceIds: ["U4"] }]
  },
  other: {
    themes: [{ text: "长主题。".repeat(100), sourceIds: ["U2"] }],
    collectedQuotes: [{ text: "长引文。".repeat(100), sourceIds: ["U3"] }]
  },
  aiReference: [{ text: "超长AI参考。".repeat(100), sourceIds: ["A2"], derivedFrom: ["U4"] }],
  stableUserCandidates: Array.from({ length: 5 }, (_, index) => ({
    statement: `稳定候选${index}。`.repeat(30),
    exactQuote: "长期关注原文。",
    sourceIds: ["U4"]
  }))
};
const boundedSummary = parseRecordCompressionOutput(oversizedOutput, {
  input: oversizedInput,
  id: "compression-budgeted",
  generatedAt: "2026-10-10T08:02:00.000Z"
});
assert.ok(boundedSummary.tokenUsage.outputTokens <= RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens);
assert.ok(boundedSummary.tokenUsage.moduleTokens.daily <= RECORD_COMPRESSION_OUTPUT_BUDGETS.dailyTokens);
assert.ok(boundedSummary.tokenUsage.moduleTokens.thoughtsIdeas <= RECORD_COMPRESSION_OUTPUT_BUDGETS.thoughtsIdeasTokens);
assert.ok(boundedSummary.tokenUsage.moduleTokens.other <= RECORD_COMPRESSION_OUTPUT_BUDGETS.otherTokens);
assert.ok(boundedSummary.tokenUsage.moduleTokens.aiReference <= RECORD_COMPRESSION_OUTPUT_BUDGETS.aiReferenceTokens);
assert.ok(boundedSummary.tokenUsage.stableCandidatesTokens <= RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens);
assert.ok(boundedSummary.stableUserCandidates.length <= RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateItems);
assert.equal(boundedSummary.tokenUsage.truncated, true);
assert.ok(boundedSummary.warnings.some(value => value.includes("预算裁剪")));
assert.ok(JSON.stringify(boundedSummary).length < JSON.stringify(oversizedOutput).length);
assert.ok(estimateRecordCompressionTokens(boundedSummary.stableUserCandidates) <= RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens);

const modelProjection = value => ({
  schemaVersion: value.schemaVersion,
  daily: value.daily,
  thoughtsIdeas: value.thoughtsIdeas,
  other: value.other,
  aiReference: value.aiReference,
  conflicts: value.conflicts,
  warnings: value.warnings
});
const longSourceId = "thought:thought:" + "a".repeat(64) + ":question:" + "b".repeat(64);
const replaceSourceId = value => {
  if (value === "U1") return longSourceId;
  if (Array.isArray(value)) return value.map(replaceSourceId);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceSourceId(item)]));
  }
  return value;
};
const statisticalInput = replaceSourceId({
  ...input,
  metrics: Array.from({ length: 11 }, (_, index) => ({
    ...input.metrics[0], metric: `measurement_${index}`, sourceIds: ["U1"]
  }))
});
const statisticalOutput = replaceSourceId({
  ...rawOutput,
  daily: { ...rawOutput.daily, metricKeys: statisticalInput.metrics.map(item => item.metric) }
});
const statisticalSummary = parseRecordCompressionOutput(statisticalOutput, {
  input: statisticalInput, id: "statistics-with-long-ids", generatedAt: "2026-10-10T08:02:00.000Z"
});
assert.ok(estimateRecordCompressionTokens({
  window: statisticalInput.window, coverage: statisticalInput.coverage, metrics: statisticalInput.metrics
}) > RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens, "fixed statistics reproduce the impossible old budget");
assert.deepEqual(statisticalSummary.metrics, statisticalInput.metrics, "all server measurements remain exact");
assert.deepEqual(statisticalSummary.coverage, statisticalInput.coverage);
assert.equal(statisticalSummary.tokenUsage.scope, "model_summary");
assert.equal(statisticalSummary.tokenUsage.outputTokens, estimateRecordCompressionTokens(modelProjection(statisticalSummary)));
assert.equal(statisticalSummary.tokenUsage.serverStatisticsTokens, estimateRecordCompressionTokens({
  window: statisticalSummary.window, coverage: statisticalSummary.coverage, metrics: statisticalSummary.metrics
}));
assert.ok(statisticalSummary.tokenUsage.outputTokens <= RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens);
assert.ok(statisticalSummary.daily.observations.length + statisticalSummary.thoughtsIdeas.focus.length > 0,
  "fitting must preserve usable source-bound content rather than only pass an empty summary");
const persistedSummary = JSON.parse(JSON.stringify({
  ...statisticalSummary, localDate: statisticalInput.window.localDate, sourceRefs: []
}));
assert.deepEqual(persistedSummary.metrics, statisticalInput.metrics);
assert.equal(isRecordCompressionRecordEnvelope(persistedSummary, { ready: true }), true);
assert.equal(isRecordCompressionRecordEnvelope({
  ...persistedSummary, tokenUsage: { ...persistedSummary.tokenUsage, scope: "unknown" }
}, { ready: true }), false);
assert.equal(isRecordCompressionRecordEnvelope({
  ...persistedSummary, tokenUsage: { ...persistedSummary.tokenUsage, serverStatisticsTokens: undefined }
}, { ready: true }), false);
const legacyUsage = { ...persistedSummary.tokenUsage };
delete legacyUsage.scope;
delete legacyUsage.serverStatisticsTokens;
assert.equal(isRecordCompressionRecordEnvelope({ ...persistedSummary, tokenUsage: legacyUsage }, { ready: true }), true);
assert.equal(isRecordCompressionRecordEnvelope({
  ...persistedSummary, tokenUsage: { ...legacyUsage, outputTokens: RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens + 1 }
}, { ready: true }), false);

assert.throws(() => parseRecordCompressionOutput("not json", { input }), /不是有效 JSON/);
assert.throws(() => parseRecordCompressionOutput("{}", { input }), /版本无效/);
assert.throws(() => parseRecordCompressionOutput("{}", { input: { ...input, sourceManifestHash: "bad" } }), /输入无效/);
assert.throws(
  () => parseRecordCompressionOutput("{}", { input: { ...input, promptVersion: "daily-record-compression.v2" } }),
  error => error.code === "RECORD_COMPRESSION_INPUT_INVALID" && /promptVersion/.test(error.message)
);

console.log("Record-compression output validation regression passed.");
