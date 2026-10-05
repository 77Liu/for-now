import assert from "node:assert/strict";
import {
  classifyThought,
  createEmptyStore,
  deriveStateInsights,
  deriveThoughtClusters,
  isUntouchedAiAnswer,
  thoughtHasUserTrace,
  thoughtIsUntouchedAiOnly
} from "../src/app/index.mjs";

process.env.TZ = "Asia/Shanghai";

const CURRENT_DATE = "2026-10-05";
const occurredAt = (date, hour = 8) => `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const dateAtOffset = offset => {
  const value = new Date(`${CURRENT_DATE}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

assert.equal(classifyThought("项目进入收尾", ["方向"]), "工作与创造");
assert.equal(classifyThought("只是随手记下", ["自定义主题"]), "自定义主题");
assert.equal(classifyThought("没有关键词"), "待慢慢看清");

const roots = [{
  id: "work-new",
  type: "question",
  content: "工作项目如何取舍",
  tags: [],
  disposition: "kept",
  occurredAt: occurredAt(CURRENT_DATE, 10)
}, {
  id: "work-old",
  type: "question",
  content: "职业方向",
  tags: [],
  disposition: "pending",
  occurredAt: occurredAt(dateAtOffset(-2))
}, {
  id: "relation",
  type: "question",
  content: "和家人沟通",
  tags: [],
  disposition: "discarded",
  occurredAt: occurredAt(dateAtOffset(-1))
}];
const clusterStore = { ...createEmptyStore(), thoughts: roots };
const clusterSnapshot = structuredClone(clusterStore);
assert.deepEqual(deriveThoughtClusters(clusterStore), [{
  theme: "工作与创造",
  count: 2,
  questions: 2,
  kept: 1,
  discarded: 0,
  unreviewed: 1,
  items: [roots[0], roots[1]]
}, {
  theme: "关系与连接",
  count: 1,
  questions: 1,
  kept: 0,
  discarded: 1,
  unreviewed: 0,
  items: [roots[2]]
}]);
assert.deepEqual(clusterStore, clusterSnapshot, "cluster derivation must not modify Store");

const untouchedAnswer = {
  id: "answer-ai",
  type: "answer",
  relatedTo: "root-ai",
  content: "模型原稿",
  modelDraft: "模型原稿",
  origin: "deepseek"
};
assert.equal(isUntouchedAiAnswer(untouchedAnswer), true);
assert.equal(isUntouchedAiAnswer({ ...untouchedAnswer, updatedAt: occurredAt(CURRENT_DATE) }), false);
assert.equal(isUntouchedAiAnswer({ ...untouchedAnswer, origin: "manual" }), false);

const traceStore = {
  ...createEmptyStore(),
  thoughts: [
    { id: "root-ai", type: "question", content: "AI only", occurredOn: CURRENT_DATE, occurredAt: occurredAt(CURRENT_DATE) },
    untouchedAnswer,
    { id: "root-edited", type: "question", content: "Edited", occurredOn: CURRENT_DATE, occurredAt: occurredAt(CURRENT_DATE) },
    {
      ...untouchedAnswer,
      id: "answer-edited",
      relatedTo: "root-edited",
      editedFromModel: true,
      updatedAt: occurredAt(CURRENT_DATE, 9)
    },
    {
      id: "root-annotated",
      type: "question",
      content: "Annotated",
      occurredOn: CURRENT_DATE,
      occurredAt: occurredAt(CURRENT_DATE),
      annotations: [{ id: "annotation", createdAt: occurredAt(CURRENT_DATE) }]
    },
    { ...untouchedAnswer, id: "answer-annotated", relatedTo: "root-annotated" }
  ]
};
const aiRoot = traceStore.thoughts.find(item => item.id === "root-ai");
const editedRoot = traceStore.thoughts.find(item => item.id === "root-edited");
const annotatedRoot = traceStore.thoughts.find(item => item.id === "root-annotated");
assert.equal(thoughtHasUserTrace(traceStore, aiRoot), false);
assert.equal(thoughtIsUntouchedAiOnly(traceStore, aiRoot), true);
assert.equal(thoughtHasUserTrace(traceStore, editedRoot), true);
assert.equal(thoughtIsUntouchedAiOnly(traceStore, editedRoot), false);
assert.equal(thoughtHasUserTrace(traceStore, annotatedRoot), true);
assert.equal(thoughtIsUntouchedAiOnly(traceStore, annotatedRoot), false);

const checkins = Array.from({ length: 14 }, (_, index) => {
  const date = dateAtOffset(index - 13);
  const currentWeek = index >= 7;
  return {
    id: `checkin-${index}`,
    occurredOn: date,
    occurredAt: occurredAt(date),
    mood: currentWeek ? 4 : 1,
    energy: currentWeek ? 3 : 2,
    stress: currentWeek ? 2 : 4,
    sleep: currentWeek ? 5 : 3,
    factors: index >= 10 ? ["专注"] : []
  };
});
checkins.push({
  id: "same-day",
  occurredOn: CURRENT_DATE,
  occurredAt: occurredAt(CURRENT_DATE, 12),
  mood: 4,
  energy: 3,
  stress: 2,
  sleep: 5,
  factors: ["专注"]
});

const insightStore = {
  ...traceStore,
  checkins,
  dailyRecords: [{ id: "health", occurredOn: CURRENT_DATE, occurredAt: occurredAt(CURRENT_DATE) }],
  captures: [{ id: "capture", occurredOn: dateAtOffset(-1), occurredAt: occurredAt(dateAtOffset(-1)) }],
  journals: [{
    id: "journal",
    occurredOn: dateAtOffset(-2),
    occurredAt: occurredAt(dateAtOffset(-2)),
    reflections: [{ id: "reflection", createdAt: occurredAt(CURRENT_DATE) }]
  }],
  analyses: [{ id: "analysis", reason: "manual", createdAt: occurredAt(dateAtOffset(-1)) }]
};
const insightSnapshot = structuredClone(insightStore);
const derived = deriveStateInsights(insightStore, { currentDate: CURRENT_DATE });
assert.deepEqual(
  derived.trends.map(item => [item.metric, item.current, item.previous, item.currentCount, item.previousCount]),
  [
    ["mood", 4, 1, 7, 7],
    ["energy", 3, 2, 7, 7],
    ["stress", 2, 4, 7, 7],
    ["sleep", 5, 3, 7, 7]
  ]
);
assert.deepEqual(derived.associations.map(item => [
  item.factor,
  item.withCount,
  item.withoutCount,
  item.nextDayCount,
  item.confidence
]), [["专注", 4, 10, 3, "初步线索"]]);
assert.deepEqual(derived.aiOnlyThoughtIds, ["root-ai"]);
assert.deepEqual({
  rootCount30: derived.weekly.rootCount30,
  tracedRoots30: derived.weekly.tracedRoots30,
  traceRate30: derived.weekly.traceRate30,
  pairedDays30: derived.weekly.pairedDays30,
  correctionActions30: derived.weekly.correctionActions30,
  reviewAgeDays: derived.weekly.reviewAgeDays,
  analysisCount: derived.weekly.analysisCount
}, {
  rootCount30: 3,
  tracedRoots30: 2,
  traceRate30: 67,
  pairedDays30: 1,
  correctionActions30: 4,
  reviewAgeDays: 1,
  analysisCount: 1
});
assert.deepEqual(insightStore, insightSnapshot, "insight derivation must not modify Store");

console.log("Derived statistics regression passed.");
