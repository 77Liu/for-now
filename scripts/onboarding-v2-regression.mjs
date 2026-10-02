import assert from "node:assert/strict";
import "./prompt-test-setup.mjs";
import {
  defaultOnboarding,
  defaultOnboardingV2,
  normalizeOnboarding,
  normalizeOnboardingV2,
  onboardingV2Context,
  ONBOARDING_V2_SCHEMA_VERSION
} from "../src/modules/onboarding/index.mjs";
import { personalContextProjection, personalContextReceiptMatches } from "../src/app/index.mjs";
import { mapStoreObjects, rebuildStoreObjects } from "../src/shared/persistence/index.mjs";

const defaultV2Snapshot = structuredClone(defaultOnboardingV2);
const legacyAnswers = {
  evidence: "evidence",
  revision: "revise",
  truth_harmony: "gentle_truth",
  autonomy: "balance",
  stability: "small_bet",
  achievement: "sustainable",
  control: "act",
  meaning: "plural"
};
const legacyCompleted = normalizeOnboarding({
  status: "completed",
  questionnaireVersion: 1,
  questionnaireMode: "quick",
  answers: legacyAnswers,
  understanding: "旧模型摘要，只是可修正的初始理解。",
  updatedAt: "2026-09-29T01:00:00.000Z"
});

const migratedCompleted = normalizeOnboardingV2(undefined, legacyCompleted);
assert.equal(ONBOARDING_V2_SCHEMA_VERSION, 2);
assert.equal(migratedCompleted.schemaVersion, 2);
assert.equal(migratedCompleted.session.status, "skipped");
assert.equal(migratedCompleted.session.step, "firstAction");
assert.equal(migratedCompleted.session.revision, 0);
assert.deepEqual(migratedCompleted.session.answers, {});
assert.equal(migratedCompleted.readiness, "empty");
assert.equal(migratedCompleted.migration.selectedFlow, "legacy");
assert.equal(migratedCompleted.migration.entryPolicy, "already_onboarded");
assert.equal(migratedCompleted.migration.legacy.answerCount, 8);
assert.equal(migratedCompleted.migration.legacy.modelSummaryType, "model_summary");
assert.equal(legacyCompleted.understanding, "旧模型摘要，只是可修正的初始理解。");

const migratedPending = normalizeOnboardingV2(undefined, {
  ...defaultOnboarding,
  status: "pending",
  answers: { evidence: "experience" },
  updatedAt: "2026-10-01T01:00:00.000Z"
});
assert.equal(migratedPending.session.status, "draft");
assert.equal(migratedPending.session.step, "welcome");
assert.equal(migratedPending.migration.selectedFlow, "undecided");
assert.equal(migratedPending.migration.entryPolicy, "choose");
assert.equal(migratedPending.migration.legacy.answerCount, 1);
const completedAfterMigration = normalizeOnboardingV2(migratedPending, legacyCompleted);
assert.equal(completedAfterMigration.session.status, "skipped");
assert.equal(completedAfterMigration.migration.selectedFlow, "legacy");
assert.equal(completedAfterMigration.migration.entryPolicy, "already_onboarded");

const normalized = normalizeOnboardingV2({
  schemaVersion: 99,
  session: {
    id: "session-a",
    status: "completed",
    step: "review",
    revision: 4,
    answers: {
      currentContext: {
        questionId: "currentContext",
        rawText: "我正在适应新的工作节奏。".repeat(200),
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:01:00.000Z",
        version: 3,
        contextAllowed: true
      },
      desiredChanges: {
        questionId: "desiredChanges",
        structuredValue: [
          { text: "建立稳定的写作节奏", horizon: "3m" },
          { text: "把重要项目推进到可交付", horizon: "custom", horizonText: "春节前" },
          { text: "每周留出完整休息时间", horizon: "invalid" },
          { text: "不应保留第四项", horizon: "6m" }
        ],
        version: 2
      },
      recentObstacles: {
        questionId: "recentObstacles",
        structuredValue: [{ text: "任务切换频繁" }],
        version: 1
      },
      dailyRhythm: {
        questionId: "dailyRhythm",
        rawText: "晚上更适合完整思考。",
        version: 1,
        contextAllowed: false
      },
      unknown: { questionId: "unknown", rawText: "must be removed" }
    },
    collaboration: {
      responseLength: { value: "expanded", source: "user" },
      suggestionMode: { value: "invalid", source: "user" },
      challengeStyle: { value: "direct", source: "user" },
      additionalBoundary: "先指出关键矛盾，再给可执行建议。".repeat(80)
    },
    startedAt: "2026-10-02T00:59:00.000Z",
    completedAt: "invalid",
    updatedAt: "2026-10-02T01:02:00.000Z"
  },
  migration: {
    selectedFlow: "v2"
  }
}, legacyCompleted);

assert.equal(normalized.schemaVersion, 2);
assert.equal(normalized.session.id, "session-a");
assert.equal(normalized.session.status, "completed", "completion must not require every field");
assert.equal(normalized.session.revision, 4);
assert.equal(normalized.session.answers.currentContext.rawText.length, 2000);
assert.equal(normalized.session.answers.currentContext.version, 3);
assert.equal(normalized.session.answers.desiredChanges.structuredValue.length, 3);
assert.equal(normalized.session.answers.desiredChanges.structuredValue[2].horizon, "unknown");
assert.equal(normalized.session.answers.dailyRhythm.contextAllowed, false);
assert.equal(Object.hasOwn(normalized.session.answers, "unknown"), false);
assert.deepEqual(normalized.session.collaboration.suggestionMode, {
  value: "actionFirst",
  source: "system_default"
});
assert.equal(normalized.session.collaboration.additionalBoundary.length, 1000);
assert.equal(normalized.readiness, "usable");
assert.equal(normalized.migration.selectedFlow, "v2");
assert.equal(normalized.migration.entryPolicy, "v2");

const emptyCompleted = normalizeOnboardingV2({
  session: { status: "completed", step: "firstAction", answers: {} },
  migration: { selectedFlow: "v2" }
}, defaultOnboarding);
assert.equal(emptyCompleted.session.status, "completed");
assert.equal(emptyCompleted.readiness, "empty");

const partial = normalizeOnboardingV2({
  session: {
    status: "paused",
    step: "q3",
    revision: 2,
    answers: {
      currentContext: {
        questionId: "currentContext",
        rawText: "PARTIAL_CONTEXT_RAW",
        version: 2,
        occurredAt: "2026-10-02T02:00:00.000Z",
        updatedAt: "2026-10-02T02:01:00.000Z",
        contextAllowed: true
      },
      recentObstacles: {
        questionId: "recentObstacles",
        structuredValue: [{ text: "PARTIAL_OBSTACLE_RAW" }],
        version: 1,
        occurredAt: "2026-10-02T02:02:00.000Z",
        updatedAt: "2026-10-02T02:02:00.000Z",
        contextAllowed: true
      },
      dailyRhythm: {
        questionId: "dailyRhythm",
        rawText: "DISABLED_V2_CONTEXT",
        version: 1,
        contextAllowed: false
      }
    }
  },
  migration: { selectedFlow: "v2" }
}, defaultOnboarding);
assert.equal(partial.readiness, "usable");
const partialText = onboardingV2Context(partial);
assert.match(partialText, /PARTIAL_CONTEXT_RAW/);
assert.match(partialText, /PARTIAL_OBSTACLE_RAW/);
assert.doesNotMatch(partialText, /DISABLED_V2_CONTEXT/);

const store = {
  version: 15,
  onboarding: {
    ...legacyCompleted,
    understanding: "LEGACY_MODEL_SUMMARY"
  },
  onboardingV2: partial,
  thoughts: [],
  checkins: [],
  dailyRecords: [],
  captures: [],
  journals: [],
  chats: []
};
const projection = personalContextProjection(store, {
  generatedAt: "2026-10-02T03:00:00.000Z"
});
assert.match(projection.prompt, /PARTIAL_CONTEXT_RAW/);
assert.match(projection.prompt, /PARTIAL_OBSTACLE_RAW/);
assert.doesNotMatch(projection.prompt, /DISABLED_V2_CONTEXT/);
const v2Sources = projection.overview.sources.filter(source => source.resourceType === "onboardingV2");
assert.equal(v2Sources.length, 2);
assert.deepEqual(v2Sources.map(source => source.version), [2, 1]);
assert.ok(v2Sources.every(source => /^[a-f0-9]{64}$/.test(source.contentSha256)));
assert.ok(projection.overview.conclusions.some(item => (
  item.informationType === "model_summary" && item.text === "LEGACY_MODEL_SUMMARY"
)));
assert.ok(projection.overview.conclusions.some(item => (
  item.informationType === "user_viewpoint" && item.text.includes("PARTIAL_OBSTACLE_RAW")
)));
assert.equal(personalContextReceiptMatches(store, projection.receipt), true);
const changedPartial = structuredClone(store);
changedPartial.onboardingV2.session.answers.currentContext.rawText = "CHANGED_V2_CONTEXT";
changedPartial.onboardingV2.session.answers.currentContext.version = 3;
changedPartial.onboardingV2.session.revision = 3;
assert.equal(personalContextReceiptMatches(changedPartial, projection.receipt), false);

const v2OnlyProjection = personalContextProjection({
  ...store,
  onboarding: structuredClone(defaultOnboarding)
}, { generatedAt: "2026-10-02T03:00:00.000Z" });
assert.match(v2OnlyProjection.prompt, /PARTIAL_CONTEXT_RAW/);
assert.doesNotMatch(v2OnlyProjection.prompt, /尚未完成冷启动问卷/);

const mapped = mapStoreObjects("account-a", store);
const v2Row = mapped.objects.find(row => row.kind === "onboardingV2");
assert.equal(v2Row.id, "onboardingV2");
assert.equal(v2Row.collection, "onboardingV2");
assert.deepEqual(rebuildStoreObjects(mapped), store);
assert.deepEqual(defaultOnboardingV2, defaultV2Snapshot);

console.log("Onboarding v2 compatibility checks passed: legacy preservation, optional completion, partial context and relational round-trip.");
