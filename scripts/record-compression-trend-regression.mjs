import assert from "node:assert/strict";
import {
  deriveSevenDayTrend,
  sevenLocalDatesForTimezone
} from "../src/modules/record-compressions/index.mjs";

const dates = [
  "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
  "2026-10-08", "2026-10-09", "2026-10-10"
];
const summary = ({
  id,
  localDate,
  generatedAt,
  timezone = "Asia/Shanghai",
  promptVersion = "daily-record-compression.v1",
  status = "ready",
  schemaVersion = "record-compression-output.v1",
  metrics = [],
  metricKeys = metrics.map(metric => metric.metric),
  completeness = "complete",
  coverage = { total: 1, included: 1, excluded: 0, truncated: false },
  warnings = []
}) => ({
  id,
  status,
  schemaVersion,
  timezone,
  promptVersion,
  generatedAt,
  window: { localDate, asOf: generatedAt, timezone, completeness },
  metrics,
  daily: { metricKeys },
  coverage,
  warnings
});

assert.deepEqual(
  sevenLocalDatesForTimezone("Asia/Shanghai", "2026-10-09T16:30:00.000Z"),
  dates
);
assert.deepEqual(
  sevenLocalDatesForTimezone("America/Los_Angeles", "2026-10-09T16:30:00.000Z"),
  ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
);
assert.deepEqual(
  sevenLocalDatesForTimezone("America/New_York", "2026-03-09T03:30:00.000Z"),
  ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"],
  "calendar dates remain consecutive across a DST boundary"
);
assert.throws(() => sevenLocalDatesForTimezone("Not/AZone", "2026-10-10T00:00:00Z"), RangeError);
assert.throws(() => sevenLocalDatesForTimezone("Asia/Shanghai", "not-a-time"), /valid asOf/);

const olderSameDay = summary({
  id: "oct-04-old",
  localDate: dates[0],
  generatedAt: "2026-10-04T09:00:00.000Z",
  metrics: [{ metric: "sleep_duration", unit: "minute", sum: 1000, count: 100, min: 1, max: 100 }]
});
const latestSameDay = summary({
  id: "oct-04-latest",
  localDate: dates[0],
  generatedAt: "2026-10-04T10:00:00.000Z",
  completeness: "partial",
  metrics: [{ metric: "sleep_duration", unit: "minute", sum: 10, count: 2, min: 4, max: 6 }],
  coverage: { total: 3, included: 2, excluded: 1, truncated: true },
  warnings: ["输入覆盖不完整"]
});
const nextDay = summary({
  id: "oct-05",
  localDate: dates[1],
  generatedAt: "2026-10-05T10:00:00.000Z",
  metrics: [{ metric: "sleep_duration", unit: "minute", sum: 90, count: 1, min: 90, max: 90 }]
});
const sourceSnapshot = structuredClone([olderSameDay, latestSameDay, nextDay]);
const trend = deriveSevenDayTrend({
  summaries: [olderSameDay, latestSameDay, nextDay],
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-09T16:30:00.000Z"
});
assert.equal(trend.days.length, 7);
assert.equal(trend.days[0].summary.id, "oct-04-latest");
assert.equal(trend.days[0].completeness, "partial");
assert.deepEqual(trend.days[0].coverage, { total: 3, included: 2, excluded: 1, truncated: true });
assert.deepEqual(trend.days[0].warnings, ["输入覆盖不完整"]);
assert.deepEqual(trend.coverage.missingDates, dates.slice(2));
assert.deepEqual(trend.warnings, [{ localDate: dates[0], warning: "输入覆盖不完整" }]);
assert.deepEqual(trend.metrics[0], {
  metric: "sleep_duration",
  status: "ready",
  reason: "",
  unit: "minute",
  sourceIds: [],
  units: ["minute"],
  sum: 100,
  count: 3,
  days: 2,
  average: 100 / 3,
  min: 4,
  max: 90,
  range: 86
});
assert.notEqual(trend.metrics[0].average, (10 / 2 + 90) / 2,
  "overall average uses raw sums/counts, not mean of daily means");
assert.deepEqual([olderSameDay, latestSameDay, nextDay], sourceSnapshot,
  "trend derivation does not mutate summaries");

const sourceBoundarySummary = {
  ...summary({
    id: "oct-04-source-boundary",
    localDate: dates[0],
    generatedAt: "2026-10-04T11:00:00.000Z",
    metrics: [
      { metric: "sleep_duration", unit: "minute", sum: 480, count: 1, min: 480, max: 480, sourceIds: ["U1", "A1"] },
      { metric: "ai_only_score", unit: "score", sum: 9, count: 1, min: 9, max: 9, sourceIds: ["A2"] },
      { metric: "steps", unit: "count", sum: 5000, count: 1, min: 5000, max: 5000, sourceIds: ["U2"] }
    ],
    metricKeys: ["sleep_duration", "ai_only_score", "steps", "undeclared"]
  }),
  sourceManifest: [
    { sourceId: "U1", origin: "user_original" },
    { sourceId: "U2", origin: "user_original" },
    { sourceId: "A1", origin: "ai_generated" },
    { sourceId: "A2", origin: "ai_prediction" },
    { sourceId: "Q1", origin: "quoted_external" }
  ],
  daily: {
    observations: [
      { text: "睡眠记录为八小时。", nature: "user_fact", sourceIds: ["U1"] },
      { text: "用户主观感到精力较好。", nature: "user_subjective", sourceIds: ["U2"] },
      { text: "混入AI来源的摘要。", nature: "user_fact", sourceIds: ["U1", "A1"] }
    ],
    metricKeys: ["sleep_duration", "ai_only_score", "steps", "undeclared"],
    missing: []
  },
  thoughtsIdeas: {
    focus: [{ text: "持续关注休息。", nature: "user_subjective", sourceIds: ["U2"] }],
    changes: [],
    openQuestions: []
  },
  other: {
    themes: [{ text: "近期关注恢复。", nature: "user_subjective", sourceIds: ["U2"] }],
    collectedQuotes: [{ text: "外部引文。", sourceIds: ["Q1"] }]
  },
  aiReference: [
    { text: "AI生成参考。", origin: "user_original", sourceIds: ["A1"], derivedFrom: ["U1"] },
    { text: "AI预测参考。", origin: "ai_generated", sourceIds: ["A2"], derivedFrom: ["U2"] },
    { text: "伪装AI来源。", origin: "ai_generated", sourceIds: ["U1"], derivedFrom: ["U1"] },
    { text: "来源不明的AI材料。", origin: "ai_prediction", sourceIds: ["MISSING"], derivedFrom: ["U2"] }
  ],
  stableUserCandidates: [
    { statement: "AI推断出的稳定表达。", sourceIds: ["A1"] },
    { statement: "真实用户候选仍走独立模型管道。", sourceIds: ["U2"] }
  ]
};
const sourceBoundaryTrend = deriveSevenDayTrend({
  summaries: [sourceBoundarySummary],
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-09T16:30:00.000Z"
});
const sourceBoundaryDay = sourceBoundaryTrend.days[0];
assert.deepEqual(sourceBoundaryDay.summary.daily.observations.map(row => row.nature), [
  "user_fact", "user_subjective"
], "trend projection preserves fact/subjective nature labels while dropping AI-mixed text");
assert.deepEqual(sourceBoundaryDay.summary.thoughtsIdeas.focus[0].nature, "user_subjective");
assert.deepEqual(sourceBoundaryDay.summary.other.collectedQuotes[0].sourceIds, ["Q1"]);
assert.deepEqual(sourceBoundaryDay.summary.metrics.map(metric => metric.metric), ["steps"]);
assert.deepEqual(sourceBoundaryDay.summary.daily.metricKeys, ["steps"]);
assert.equal("aiReference" in sourceBoundaryDay.summary, false,
  "AI content is removed from each user summary block");
assert.deepEqual(sourceBoundaryDay.summary.stableUserCandidates, [
  { statement: "真实用户候选仍走独立模型管道。", sourceIds: ["U2"] }
], "AI-origin candidates are excluded from the stable model input projection");
assert.deepEqual(sourceBoundaryTrend.metrics.map(metric => metric.metric), ["steps"]);
assert.deepEqual(sourceBoundaryTrend.metrics[0].sourceIds, ["U2"]);
assert.deepEqual(sourceBoundaryTrend.aiReferences, [
  {
    localDate: dates[0],
    text: "AI生成参考。",
    origin: "ai_generated",
    originLabel: "AI generated",
    disclaimer: "仅供参考，非用户事实",
    isUserFact: false,
    sourceIds: ["A1"],
    derivedFrom: ["U1"]
  },
  {
    localDate: dates[0],
    text: "AI预测参考。",
    origin: "ai_prediction",
    originLabel: "AI prediction",
    disclaimer: "仅供参考，非用户事实",
    isUserFact: false,
    sourceIds: ["A2"],
    derivedFrom: ["U2"]
  }
], "AI references are independently projected with canonical origins and explicit disclaimers");
assert.ok(sourceBoundaryTrend.aiReferences.every(reference => (
  reference.isUserFact === false
  && !("citationId" in reference)
  && !("citations" in reference)
)));
assert.deepEqual(sourceBoundaryDay.summary.daily.observations.flatMap(row => row.sourceIds), ["U1", "U2"]);

const staleAndIneligible = [
  summary({ id: "queued", localDate: dates[2], status: "queued" }),
  summary({ id: "old-schema", localDate: dates[3], schemaVersion: "record-compression-output.v0" }),
  summary({ id: "other-zone", localDate: dates[4], timezone: "UTC" }),
  summary({ id: "old-prompt", localDate: dates[5], promptVersion: "daily-record-compression.v0" }),
  summary({ id: "outside-window", localDate: "2026-10-03" }),
  { ...summary({ id: "invalidated", localDate: dates[5] }), invalidatedAt: "2026-10-10T00:00:00.000Z" }
];
const filtered = deriveSevenDayTrend({
  summaries: staleAndIneligible,
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-10T00:00:00.000Z"
});
assert.equal(filtered.coverage.summaryDays, 0);
assert.deepEqual(filtered.coverage.missingDates, dates);

const unitMismatch = deriveSevenDayTrend({
  summaries: [
    summary({ id: "minutes", localDate: dates[0], metrics: [{ metric: "sleep_duration", unit: "minute", sum: 480, count: 1, min: 480, max: 480 }] }),
    summary({ id: "hours", localDate: dates[1], metrics: [{ metric: "sleep_duration", unit: "hour", sum: 8, count: 1, min: 8, max: 8 }] })
  ],
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-10T00:00:00.000Z"
});
assert.deepEqual(unitMismatch.metrics[0], {
  metric: "sleep_duration",
  status: "unknown",
  reason: "incompatible_units",
  unit: "unknown",
  sourceIds: [],
  units: ["hour", "minute"],
  sum: null,
  count: null,
  days: 2,
  average: null,
  min: null,
  max: null,
  range: null
});

const extremaUnavailable = deriveSevenDayTrend({
  summaries: [summary({
    id: "sum-count-only",
    localDate: dates[0],
    metrics: [{ metric: "mood", unit: "score", sum: 8, count: 2 }]
  })],
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-10T00:00:00.000Z"
});
assert.equal(extremaUnavailable.metrics[0].average, 4);
assert.equal(extremaUnavailable.metrics[0].count, 2);
assert.equal(extremaUnavailable.metrics[0].days, 1);
assert.equal(extremaUnavailable.metrics[0].min, null);
assert.equal(extremaUnavailable.metrics[0].max, null);
assert.equal(extremaUnavailable.metrics[0].range, null,
  "sum/count alone cannot fabricate raw extrema");

const noPoints = deriveSevenDayTrend({
  summaries: [summary({
    id: "declared-but-empty",
    localDate: dates[0],
    metrics: [],
    metricKeys: ["sleep_duration"],
    warnings: ["该日没有可比较的测量"]
  })],
  localDates: dates,
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  asOf: "2026-10-10T00:00:00.000Z"
});
assert.deepEqual(noPoints.metrics, [{
  metric: "sleep_duration",
  status: "unknown",
  reason: "no_compatible_points",
  unit: "unknown",
  sourceIds: [],
  units: [],
  sum: null,
  count: null,
  days: 0,
  average: null,
  min: null,
  max: null,
  range: null
}]);
assert.deepEqual(noPoints.days[0].warnings, ["该日没有可比较的测量"]);

console.log("Record-compression seven-day trend regression passed.");
