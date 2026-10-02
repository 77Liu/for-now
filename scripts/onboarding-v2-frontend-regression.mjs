import assert from "node:assert/strict";
import {
  createOnboardingV2Controller,
  mergeOnboardingV2Conflict,
  onboardingV2ConflictRows,
  onboardingV2DraftFromState,
  onboardingV2PendingResolution,
  onboardingV2PatchFromDraft
} from "../public/frontend/features/index.mjs";

const serverState = {
  schemaVersion: 2,
  session: {
    id: "onboarding-v2",
    schemaVersion: 2,
    status: "paused",
    step: "q3",
    revision: 4,
    answers: {
      currentContext: {
        questionId: "currentContext",
        rawText: "服务器上的当前处境",
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:01:00.000Z",
        version: 2,
        contextAllowed: true
      },
      desiredChanges: {
        questionId: "desiredChanges",
        structuredValue: [{ text: "稳定写作", horizon: "3m" }],
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:01:00.000Z",
        version: 1,
        contextAllowed: true
      }
    },
    collaboration: {
      responseLength: { value: "balanced", source: "system_default" },
      suggestionMode: { value: "reasonFirst", source: "user" },
      challengeStyle: { value: "gentle", source: "system_default" },
      additionalBoundary: "",
      contextAllowed: true
    },
    startedAt: "2026-10-02T01:00:00.000Z",
    pausedAt: "2026-10-02T01:01:00.000Z",
    completedAt: "",
    updatedAt: "2026-10-02T01:01:00.000Z"
  },
  readiness: "usable",
  migration: {
    selectedFlow: "v2",
    entryPolicy: "v2",
    legacy: { status: "pending", answerCount: 0 }
  }
};

const draft = onboardingV2DraftFromState(serverState, { owner: "account-a" });
assert.equal(draft.owner, "account-a");
assert.equal(draft.baseRevision, 4);
assert.equal(draft.step, "q3");
assert.equal(draft.answers.currentContext.version, 2);
assert.deepEqual(draft.collaboration.suggestionMode, {
  value: "reasonFirst",
  source: "user"
});

const currentPatch = onboardingV2PatchFromDraft(draft, {
  questionId: "currentContext",
  status: "draft",
  step: "q2"
});
assert.deepEqual(currentPatch, {
  selectedFlow: "v2",
  status: "draft",
  step: "q2",
  answers: {
    currentContext: {
      rawText: "服务器上的当前处境",
      occurredAt: "2026-10-02T01:00:00.000Z",
      contextAllowed: true
    }
  }
});
assert.equal(Object.hasOwn(currentPatch.answers.currentContext, "version"), false);
assert.equal(Object.hasOwn(currentPatch.answers.currentContext, "updatedAt"), false);

delete draft.answers.desiredChanges;
draft.answers.recentObstacles = {
  questionId: "recentObstacles",
  structuredValue: [{ text: "任务切换频繁" }],
  occurredAt: "2026-10-02T02:00:00.000Z",
  contextAllowed: false
};
draft.collaboration.responseLength = { value: "concise", source: "user" };
const fullPatch = onboardingV2PatchFromDraft(draft, {
  status: "completed",
  step: "firstAction",
  full: true
});
assert.equal(fullPatch.answers.desiredChanges, null);
assert.deepEqual(fullPatch.answers.recentObstacles, {
  structuredValue: [{ text: "任务切换频繁" }],
  occurredAt: "2026-10-02T02:00:00.000Z",
  contextAllowed: false
});
assert.deepEqual(fullPatch.collaboration.responseLength, {
  value: "concise",
  source: "user"
});
assert.equal(fullPatch.collaboration.challengeStyle, null);

const deviceDraft = onboardingV2DraftFromState(serverState, { owner: "account-a" });
deviceDraft.answers.currentContext.rawText = "此设备上修改后的处境";
delete deviceDraft.answers.desiredChanges;
deviceDraft.answers.dailyRhythm = {
  questionId: "dailyRhythm",
  rawText: "晚上适合完整思考",
  occurredAt: "2026-10-02T03:00:00.000Z",
  contextAllowed: true
};
deviceDraft.collaboration.additionalBoundary = "不要替我做心理诊断";
deviceDraft.baseRevision = 3;
deviceDraft.pendingSync = true;
deviceDraft.localDirty = true;
assert.equal(onboardingV2PendingResolution(serverState, deviceDraft), "conflict");
assert.equal(deviceDraft.baseRevision, 3);
const matchingDraft = onboardingV2DraftFromState(serverState, { owner: "account-a" });
matchingDraft.baseRevision = 3;
matchingDraft.pendingSync = true;
assert.equal(onboardingV2PendingResolution(serverState, matchingDraft), "synced");
matchingDraft.baseRevision = 4;
assert.equal(onboardingV2PendingResolution(serverState, matchingDraft), "unchanged");
let persistedDraft = structuredClone(deviceDraft);
let requestCount = 0;
const controller = createOnboardingV2Controller({
  query: () => null,
  requestV1: async () => {
    requestCount += 1;
    throw new Error("Conflict hydration must not write automatically");
  },
  draftStore: {
    durable: true,
    get: async () => structuredClone(persistedDraft),
    put: async value => { persistedDraft = structuredClone(value); },
    delete: async () => {}
  },
  owner: () => "account-a"
});
await controller.hydrate({ schema: {}, state: serverState });
const conflictState = controller.getState();
assert.equal(conflictState.uiStep, "conflict");
assert.equal(conflictState.draft.baseRevision, 3);
assert.equal(conflictState.draft.pendingSync, true);
assert.equal(conflictState.draft.answers.currentContext.rawText, "此设备上修改后的处境");
assert.equal(conflictState.conflict.session.revision, 4);
assert.equal(requestCount, 0);
const rows = onboardingV2ConflictRows(serverState, deviceDraft);
assert.deepEqual(rows.map(row => [row.questionId, row.equal]), [
  ["currentContext", false],
  ["desiredChanges", false],
  ["recentObstacles", true],
  ["dailyRhythm", false],
  ["collaboration", false]
]);

const merged = mergeOnboardingV2Conflict(serverState, deviceDraft, {
  currentContext: "device",
  desiredChanges: "server",
  recentObstacles: "device",
  dailyRhythm: "device",
  collaboration: "server"
});
assert.equal(merged.baseRevision, 4);
assert.equal(merged.answers.currentContext.rawText, "此设备上修改后的处境");
assert.equal(merged.answers.desiredChanges.structuredValue[0].text, "稳定写作");
assert.equal(merged.answers.dailyRhythm.rawText, "晚上适合完整思考");
assert.equal(merged.collaboration.additionalBoundary, "");
assert.equal(merged.localDirty, true);
assert.equal(merged.pendingSync, false);

console.log("Onboarding v2 frontend contracts passed: draft hydration, minimal/full patches, offline conflict detection and explicit per-question merge.");
