import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createOnboardingV2Service,
  defaultOnboardingV2,
  onboardingV2ContextEntries
} from "../src/modules/onboarding/index.mjs";
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

async function controllerFor(state) {
  const instance = createOnboardingV2Controller({
    query: () => null,
    requestV1: async () => {
      throw new Error("Opening the explicit top-up entry must not write automatically");
    },
    draftStore: {
      durable: true,
      get: async () => null,
      put: async () => {},
      delete: async () => {}
    },
    owner: () => "account-a"
  });
  await instance.hydrate({ schema: {}, state });
  return instance;
}

const skippedState = structuredClone(serverState);
skippedState.session.status = "skipped";
skippedState.session.step = "firstAction";
skippedState.session.answers.currentContext.rawText = "保留的已有回答";
skippedState.migration.selectedFlow = "v2";
skippedState.migration.entryPolicy = "v2";
const skippedController = await controllerFor(skippedState);
skippedController.reopen();
assert.equal(skippedController.getState().uiStep, "q1");
assert.equal(skippedController.getState().draft.step, "q1");
assert.equal(skippedController.getState().draft.answers.currentContext.rawText, "保留的已有回答");
assert.equal(skippedController.getState().draft.status, "skipped");

const legacyState = structuredClone(serverState);
legacyState.session.status = "completed";
legacyState.session.step = "firstAction";
legacyState.migration.selectedFlow = "legacy";
legacyState.migration.entryPolicy = "already_onboarded";
const legacyController = await controllerFor(legacyState);
legacyController.reopen();
assert.equal(legacyController.getState().uiStep, "q1");

const completedState = structuredClone(serverState);
completedState.session.status = "completed";
completedState.session.step = "firstAction";
const completedController = await controllerFor(completedState);
completedController.reopen();
assert.equal(completedController.getState().uiStep, "review");

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
assert.match(html, /id="onboarding-v2-reopen"[^>]*>补充核心模型回答<\/button>/);
assert.match(html, /核心用户模型只根据你在五问中的回答建立或更新，不会根据历史记录替你填写。/);

const dispositionDraft = onboardingV2DraftFromState(serverState, { owner: "account-a" });
dispositionDraft.answers.currentContext.answerDisposition = "unknown";
dispositionDraft.collaboration.answerDisposition = "declined";
const dispositionPatch = onboardingV2PatchFromDraft(dispositionDraft, { full: true });
assert.equal(dispositionPatch.answers.currentContext.answerDisposition, "unknown");
assert.equal(dispositionPatch.answers.currentContext.contextAllowed, true);
assert.equal(dispositionPatch.collaboration.answerDisposition, "declined");
assert.equal(dispositionPatch.collaboration.contextAllowed, true);
assert.equal(onboardingV2ConflictRows(serverState, dispositionDraft)[0].deviceText, "目前不知道");

let domainStore = { onboardingV2: structuredClone(defaultOnboardingV2) };
let domainRequest = 0;
const domainService = createOnboardingV2Service({
  repository: {
    async read() {
      return structuredClone(domainStore);
    },
    async executeIdempotent(_request, operation) {
      const nextStore = structuredClone(domainStore);
      const result = await operation(nextStore);
      domainStore = nextStore;
      return structuredClone(result);
    }
  },
  now: () => `2026-10-10T00:00:0${domainRequest}.000Z`
});
async function patchDomain(patch) {
  domainRequest += 1;
  const result = await domainService.patch(patch, {
    expectedVersion: domainStore.onboardingV2.session.revision + 1,
    clientRequestId: `answer-disposition-${domainRequest}`
  });
  assert.ok(result.value, JSON.stringify(result));
  return result.value;
}

let dispositionState = await patchDomain({
  status: "completed",
  step: "firstAction",
  selectedFlow: "v2",
  answers: {
    currentContext: { answerDisposition: "unknown", contextAllowed: true },
    desiredChanges: { answerDisposition: "declined", contextAllowed: true },
    recentObstacles: { answerDisposition: "unknown", contextAllowed: false },
    dailyRhythm: { answerDisposition: "declined", contextAllowed: true }
  },
  collaboration: { answerDisposition: "unknown", contextAllowed: true }
});
assert.equal(dispositionState.readiness, "partial");
assert.equal(dispositionState.session.answers.currentContext.rawText, "");
assert.equal(dispositionState.session.answers.currentContext.version, 1);
assert.equal(dispositionState.session.answers.currentContext.contextAllowed, true);
assert.equal(dispositionState.session.answers.desiredChanges.version, 1);
assert.equal(dispositionState.session.collaboration.answerVersion, 1);
assert.deepEqual(onboardingV2ContextEntries(dispositionState).map(entry => [entry.id, entry.text, entry.version]), [
  ["currentContext", "用户对“当前处境”的选择：目前不知道", 1],
  ["desiredChanges", "用户对“希望的变化”的选择：不愿回答", 1],
  ["dailyRhythm", "用户对“日常节奏”的选择：不愿回答", 1],
  ["collaboration", "用户对“怎么帮助”的选择：目前不知道", 1]
]);

dispositionState = await patchDomain({
  status: "draft",
  step: "q1",
  selectedFlow: "v2",
  answers: {
    currentContext: { rawText: "我正在适应新的工作节奏。", contextAllowed: false }
  }
});
assert.equal(dispositionState.session.answers.currentContext.answerDisposition, undefined);
assert.equal(dispositionState.session.answers.currentContext.rawText, "我正在适应新的工作节奏。");
assert.equal(dispositionState.session.answers.currentContext.version, 2);
assert.equal(dispositionState.session.answers.currentContext.contextAllowed, false);
assert.equal(onboardingV2ContextEntries(dispositionState).some(entry => entry.id === "currentContext"), false);

dispositionState = await patchDomain({
  status: "draft",
  step: "q5",
  selectedFlow: "v2",
  collaboration: {
    responseLength: { value: "concise", source: "user" },
    additionalBoundary: "",
    contextAllowed: true
  }
});
assert.equal(dispositionState.session.collaboration.answerDisposition, undefined);
assert.equal(dispositionState.session.collaboration.answerVersion, 2);
assert.equal(onboardingV2ContextEntries(dispositionState).find(entry => entry.id === "collaboration").text, "明确选择：简洁");

const invalidDisposition = await domainService.patch({
  answers: { currentContext: { answerDisposition: "deferred" } }
}, {
  expectedVersion: domainStore.onboardingV2.session.revision + 1,
  clientRequestId: "answer-disposition-invalid"
});
assert.equal(invalidDisposition.invalid, true);
assert.deepEqual(invalidDisposition.fields, {
  "answers.currentContext.answerDisposition": "回答状态无效"
});

const onboardingModule = await readFile(
  new URL("../public/frontend/features/onboarding-v2/index.mjs", import.meta.url),
  "utf8"
);
assert.match(onboardingModule, /data-onboarding-answer-disposition/);
assert.match(onboardingModule, /\["unknown", ANSWER_DISPOSITIONS\.unknown\]/);
assert.match(onboardingModule, /\["declined", ANSWER_DISPOSITIONS\.declined\]/);
assert.match(onboardingModule, /data-onboarding-action="skip">暂不回答/);
assert.match(onboardingModule, /restoreVisibleQuestionBaseline\(\)/);
assert.match(onboardingModule, /task\?\.status === "ready"/);
assert.match(onboardingModule, /没有获准用于后续回答的内容，因此核心模型按未知状态就绪/);

const readyUiState = structuredClone(dispositionState);
readyUiState.session.status = "draft";
readyUiState.session.step = "review";
readyUiState.session.answers.desiredChanges.contextAllowed = false;
readyUiState.session.answers.dailyRhythm.contextAllowed = false;
readyUiState.session.collaboration.contextAllowed = false;
const uiElements = new Map();
const fakeContent = {
  innerHTML: "",
  listeners: {},
  addEventListener(name, callback) { this.listeners[name] = callback; },
  querySelector(selector) {
    return selector === "h1" ? { focus() {} } : null;
  },
  querySelectorAll() { return []; }
};
const fakeRoot = {
  hidden: true,
  classList: { toggle() {} },
  querySelectorAll() { return []; },
  scrollIntoView() {}
};
for (const [selector, element] of Object.entries({
  "#onboarding-workspace": fakeRoot,
  "#onboarding-v2-content": fakeContent,
  "#onboarding-v2-steps": {
    innerHTML: "",
    addEventListener() {}
  },
  "#onboarding-v2-shell": { hidden: false },
  "#onboarding-form": { hidden: false },
  "#onboarding-v2-back": { hidden: false, addEventListener() {} },
  "#onboarding-v2-exit": { hidden: false, addEventListener() {} },
  "#onboarding-v2-save-status": { textContent: "" }
})) uiElements.set(selector, element);
const uiRequests = [];
const uiController = createOnboardingV2Controller({
  query: selector => uiElements.get(selector) || null,
  requestV1: async (path, options = {}) => {
    uiRequests.push([path, options.method || "GET"]);
    if (path === "/api/v1/onboarding-v2/session") {
      readyUiState.session = {
        ...readyUiState.session,
        revision: readyUiState.session.revision + 1,
        status: "draft",
        step: "review"
      };
      return { data: structuredClone(readyUiState) };
    }
    if (path === "/api/v1/onboarding-v2/extractions") return { data: { status: "ready" } };
    if (path === "/api/v1/user-model") {
      return { data: { schemaVersion: 1, claims: [], answers: [], unknowns: [] } };
    }
    throw new Error(`Unexpected UI request: ${path}`);
  },
  draftStore: {
    durable: true,
    async get() { return null; },
    async put() {},
    async delete() {}
  },
  owner: () => "account-a"
});
const previousDocument = globalThis.document;
globalThis.document = { querySelectorAll: () => [] };
try {
  await uiController.hydrate({
    schema: { questions: Array.from({ length: 5 }, (_, index) => ({ prompt: `问题 ${index + 1}` })) },
    state: readyUiState
  });
  fakeContent.listeners.click({
    target: {
      closest(selector) {
        return selector === "[data-onboarding-action]"
          ? { dataset: { onboardingAction: "extract" } }
          : null;
      }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(uiRequests, [
    ["/api/v1/onboarding-v2/session", "PATCH"],
    ["/api/v1/onboarding-v2/extractions", "POST"],
    ["/api/v1/user-model", "GET"]
  ]);
  assert.equal(uiController.getState().extractionTask.status, "ready");
  assert.deepEqual(uiController.getState().userModel, {
    schemaVersion: 1,
    claims: [],
    answers: [],
    unknowns: []
  });
  assert.match(fakeContent.innerHTML, /没有获准用于后续回答的内容，因此核心模型按未知状态就绪/);
  assert.match(fakeContent.innerHTML, /核心模型摘要状态已刷新/);
  assert.equal(uiElements.get("#onboarding-v2-save-status").textContent, "没有获准内容 · 核心模型按未知就绪");
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log("Onboarding v2 contracts passed: ordinary answers, explicit unknown/refusal, answer versions and consent, re-answering, blank distinction, legacy entry, non-destructive temporary skip and provider-free ready response.");
