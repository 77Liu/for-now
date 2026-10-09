import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  coreUserModelProjection,
  prepareUserModelExtraction,
  userModelCoreReadiness
} from "../src/app/index.mjs";
import { defaultOnboardingV2, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import { normalizeUserClaim } from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const answers = {
  currentContext: { rawText: "正在适应新的工作节奏", contextAllowed: true, version: 2 },
  desiredChanges: { structuredValue: [{ text: "建立稳定的运动习惯", horizon: "3m" }], contextAllowed: true, version: 1 },
  recentObstacles: { structuredValue: [{ text: "容易被临时任务打断" }], contextAllowed: true, version: 1 },
  dailyRhythm: { rawText: "通常在晚上做复盘", contextAllowed: true, version: 1 }
};
const completeOnboarding = (overrides = {}) => normalizeOnboardingV2({
  session: {
    id: "onboarding-v2",
    status: "completed",
    step: "firstAction",
    revision: 8,
    answers: structuredClone(answers),
    collaboration: {
      responseLength: { value: "concise", source: "user" },
      suggestionMode: { value: "reasonFirst", source: "user" },
      challengeStyle: { value: "direct", source: "user" },
      additionalBoundary: "",
      contextAllowed: true,
      answerVersion: 1
    },
    completedAt: "2026-10-10T01:00:00.000Z",
    updatedAt: "2026-10-10T01:00:00.000Z",
    ...overrides.session
  },
  migration: { selectedFlow: "v2", ...overrides.migration }
}, defaultOnboardingV2);

const base = { onboardingV2: completeOnboarding(), userClaims: [], modelUnknowns: [], aiTasks: [] };
assert.equal(userModelCoreReadiness({}).ready, false);
assert.equal(userModelCoreReadiness({ onboardingV2: completeOnboarding({
  migration: { selectedFlow: "legacy" }
}) }).ready, false);
assert.equal(userModelCoreReadiness({ onboardingV2: completeOnboarding({
  session: { status: "skipped" }
}) }).ready, false);
const incomplete = completeOnboarding();
delete incomplete.session.answers.recentObstacles;
assert.equal(userModelCoreReadiness({ onboardingV2: incomplete }).reason, "answers_incomplete");

assert.equal(userModelCoreReadiness(base).reason, "model_generation_pending");
const prepared = prepareUserModelExtraction(base, { sourceRevision: base.onboardingV2.session.revision });
assert.ok(prepared.value);
const succeededTask = {
  kind: "onboardingClaimExtraction",
  status: "succeeded",
  targetId: "onboarding-v2",
  inputVersion: base.onboardingV2.session.revision,
  inputHash: prepared.value.inputHash
};
const readyStore = { ...structuredClone(base), aiTasks: [succeededTask] };
assert.equal(userModelCoreReadiness(readyStore).ready, true);
assert.equal(coreUserModelProjection(readyStore).answers.length, 5);
assert.equal(coreUserModelProjection(readyStore).fingerprint.length, 64);
assert.equal(userModelCoreReadiness({
  ...readyStore,
  aiTasks: [{ ...succeededTask, inputHash: "stale" }]
}).ready, false);

const optedOut = completeOnboarding({
  session: {
    answers: {
      currentContext: { answerDisposition: "unknown", contextAllowed: false },
      desiredChanges: { answerDisposition: "declined", contextAllowed: false },
      recentObstacles: { answerDisposition: "unknown", contextAllowed: false },
      dailyRhythm: { answerDisposition: "declined", contextAllowed: false }
    },
    collaboration: {
      responseLength: { value: "balanced", source: "system_default" },
      suggestionMode: { value: "actionFirst", source: "system_default" },
      challengeStyle: { value: "gentle", source: "system_default" },
      answerDisposition: "unknown",
      contextAllowed: false,
      answerVersion: 1
    }
  }
});
const emptyStore = { onboardingV2: optedOut, userClaims: [], modelUnknowns: [], aiTasks: [] };
assert.deepEqual(prepareUserModelExtraction(emptyStore), { empty: true, currentRevision: 8 });
assert.equal(userModelCoreReadiness(emptyStore).reason, "no_permitted_model_sources");
assert.deepEqual(coreUserModelProjection(emptyStore).answers, []);
assert.deepEqual(coreUserModelProjection(emptyStore).unknowns, []);

const permissionRevoked = completeOnboarding({
  session: {
    answers: {
      currentContext: answers.currentContext,
      desiredChanges: { answerDisposition: "unknown", contextAllowed: false },
      recentObstacles: { answerDisposition: "unknown", contextAllowed: false },
      dailyRhythm: { answerDisposition: "unknown", contextAllowed: false }
    },
    collaboration: {
      responseLength: { value: "balanced", source: "system_default" },
      suggestionMode: { value: "actionFirst", source: "system_default" },
      challengeStyle: { value: "gentle", source: "system_default" },
      answerDisposition: "unknown",
      contextAllowed: false,
      answerVersion: 1
    }
  }
});
const permissionKey = JSON.stringify(["onboardingV2", "currentContext", "", "answer:currentContext"]);
const deniedStore = {
  onboardingV2: permissionRevoked,
  evidencePermissions: [{
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: permissionKey,
    contextAllowed: false,
    learningAllowed: false,
    revision: 2,
    updatedAt: "2026-10-10T01:00:00.000Z"
  }],
  userClaims: [],
  modelUnknowns: [],
  aiTasks: []
};
assert.equal(prepareUserModelExtraction(deniedStore).empty, true);
assert.equal(userModelCoreReadiness(deniedStore).ready, true);
assert.deepEqual(coreUserModelProjection(deniedStore).answers, []);

const activeClaim = normalizeUserClaim({
  id: "claim-current-context",
  domain: "context",
  statement: "正在适应新的工作节奏",
  scope: "近期",
  epistemic: "known",
  lifecycle: "active",
  evidenceStrength: "self_report",
  evidence: [{
    sourceType: "onboardingV2Answer",
    sourceId: "currentContext",
    sourceVersion: 2,
    contentSha256: hash(answers.currentContext.rawText),
    span: [0, answers.currentContext.rawText.length]
  }],
  contextAllowed: true,
  createdAt: "2026-10-10T01:00:00.000Z",
  updatedAt: "2026-10-10T01:00:00.000Z",
  version: 1
});
assert.ok(activeClaim);
const withClaim = { ...readyStore, userClaims: [activeClaim] };
assert.deepEqual(coreUserModelProjection(withClaim).claims[0], {
  domain: activeClaim.domain,
  epistemic: activeClaim.epistemic,
  statement: activeClaim.statement,
  scope: activeClaim.scope,
  evidence: [{
    sourceId: "currentContext",
    citationId: "core:onboarding:currentContext",
    sourceVersion: 2,
    exactQuote: answers.currentContext.rawText
  }]
});
const filteredStore = { ...withClaim, evidencePermissions: deniedStore.evidencePermissions };
const filteredExtraction = prepareUserModelExtraction(filteredStore);
assert.ok(filteredExtraction.value);
const permissionCurrentStore = {
  ...filteredStore,
  aiTasks: [{ ...succeededTask, inputHash: filteredExtraction.value.inputHash }]
};
assert.equal(userModelCoreReadiness(permissionCurrentStore).ready, true);
assert.deepEqual(coreUserModelProjection(permissionCurrentStore).claims, []);

console.log("User model core readiness regression passed.");
