import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  coreUserModelProjection,
  createThoughtWorkflows,
  prepareUserModelExtraction,
  userModelCoreReadiness
} from "../src/app/index.mjs";
import {
  defaultOnboardingV2,
  normalizeOnboardingV2
} from "../src/modules/onboarding/index.mjs";
import { evidenceSourceKey } from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const answers = {
  currentContext: { rawText: "正在适应新的工作节奏", contextAllowed: true, version: 2 },
  desiredChanges: { structuredValue: [{ text: "建立稳定的运动习惯", horizon: "3m" }], contextAllowed: true, version: 1 },
  recentObstacles: { structuredValue: [{ text: "容易被临时任务打断" }], contextAllowed: true, version: 1 },
  dailyRhythm: { rawText: "通常在晚上做复盘", contextAllowed: true, version: 1 }
};

function readyOnboarding() {
  return normalizeOnboardingV2({
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
      updatedAt: "2026-10-10T01:00:00.000Z"
    },
    migration: { selectedFlow: "v2" }
  }, defaultOnboardingV2);
}

function readyStore() {
  const root = {
    id: "thought-1",
    type: "question",
    content: "如何稳定推进当前目标？",
    relatedTo: null,
    version: 1,
    authorType: "user",
    contextAllowed: true,
    disposition: "kept",
    tags: [],
    remarks: [],
    followUps: [],
    occurredAt: "2026-10-09T02:00:00.000Z",
    occurredOn: "2026-10-09",
    createdAt: "2026-10-09T02:00:00.000Z"
  };
  const store = {
    onboardingV2: readyOnboarding(),
    userClaims: [],
    modelUnknowns: [],
    evidencePermissions: [],
    aiTasks: [],
    thoughts: [root],
    captures: [],
    journals: [],
    checkins: [],
    dailyRecords: [],
    chats: [],
    evidenceSources: []
  };
  const extraction = prepareUserModelExtraction(store, {
    sourceRevision: store.onboardingV2.session.revision
  });
  assert.ok(extraction.value);
  store.aiTasks.push({
    id: "core-model-extraction",
    kind: "onboardingClaimExtraction",
    status: "succeeded",
    targetId: "onboarding-v2",
    inputVersion: store.onboardingV2.session.revision,
    inputHash: extraction.value.inputHash
  });
  assert.equal(userModelCoreReadiness(store).ready, true);
  return store;
}

function emptyReadyStore() {
  const store = readyStore();
  const session = store.onboardingV2.session;
  for (const answer of Object.values(session.answers)) {
    answer.answerDisposition = "declined";
    answer.contextAllowed = false;
    delete answer.rawText;
    delete answer.structuredValue;
  }
  session.collaboration = {
    responseLength: { value: "balanced", source: "system_default" },
    suggestionMode: { value: "actionFirst", source: "system_default" },
    challengeStyle: { value: "gentle", source: "system_default" },
    answerDisposition: "declined",
    contextAllowed: false,
    answerVersion: 1
  };
  store.aiTasks = store.aiTasks.filter(task => task.kind !== "onboardingClaimExtraction");
  store.onboarding = {
    status: "completed",
    questionnaireMode: "quick",
    answers: { evidence: "experience" },
    profile: { occupation: "历史职业" },
    interests: ["学习成长"],
    material: "历史资料",
    understanding: "旧版理解"
  };
  assert.equal(userModelCoreReadiness(store).ready, true);
  return store;
}

function revokeCoreAnswer(store) {
  const permission = {
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: evidenceSourceKey({
      resourceType: "onboardingV2",
      resourceId: "currentContext",
      rootId: "",
      targetKey: "answer:currentContext",
      version: answers.currentContext.version
    }),
    contextAllowed: false,
    learningAllowed: false,
    revision: 2,
    updatedAt: "2026-10-10T02:00:00.000Z"
  };
  store.evidencePermissions.push(permission);
}

function workflowFor(store, generate) {
  const repository = {
    async read() {
      return structuredClone(store);
    },
    async update(operation) {
      return operation(store);
    }
  };
  const thoughts = {
    saveGeneratedAnswerInStore(target, input) {
      const question = target.thoughts.find(item => item.id === input.id && item.type === "question");
      if (!question || question.version !== input.sourceVersion) return { stale: true };
      const answer = {
        id: `answer-${target.thoughts.length}`,
        type: "answer",
        relatedTo: question.id,
        clientRequestId: input.clientRequestId,
        content: input.content,
        version: 1,
        authorType: "ai",
        sourceTaskId: input.sourceTaskId,
        contextReceipt: input.contextReceipt
      };
      target.thoughts.unshift(answer);
      return { value: answer, duplicate: false };
    }
  };
  return createThoughtWorkflows({
    repository,
    thoughts,
    backgroundAi: {},
    removeChain() {},
    removeBlock() {},
    generate,
    hash,
    publicTask: value => value,
    getAccountId: () => "account-a",
    coreModelReadiness: userModelCoreReadiness,
    contextKey: () => "account-a",
    getRecentTrend: () => null,
    now: () => "2026-10-10T02:00:00.000Z"
  });
}

function gate() {
  let start;
  let release;
  return {
    started: new Promise(resolve => { start = resolve; }),
    wait: new Promise(resolve => { release = resolve; }),
    notifyStarted: () => start(),
    release: () => release()
  };
}

const store = readyStore();
const model = coreUserModelProjection(store);
const prompts = [];
const coldStore = readyStore();
coldStore.aiTasks = [];
assert.equal(userModelCoreReadiness(coldStore).ready, false);
let coldProviderCalls = 0;
const coldWorkflow = workflowFor(coldStore, async () => {
  coldProviderCalls += 1;
  return { content: "不得调用 provider" };
});
await assert.rejects(coldWorkflow.answerRoot({ id: "thought-1", clientRequestId: "cold-answer" }),
  error => error?.code === "CORE_MODEL_NOT_READY");
await assert.rejects(coldWorkflow.createDraft({
  question: "冷启问题",
  idea: "",
  requestId: "cold-draft",
  targetId: "cold-draft",
  inputVersion: 1
}), error => error?.code === "CORE_MODEL_NOT_READY");
await assert.rejects(coldWorkflow.createStarter({
  eventTime: { occurredOn: "2026-10-09" },
  binding: { requestId: "cold-starter" }
}), error => error?.code === "CORE_MODEL_NOT_READY");
assert.equal(coldProviderCalls, 0, "thought workflows must not call the provider before core readiness");
const workflows = workflowFor(store, async (prompt, options) => {
  prompts.push({ prompt, options });
  return { content: "合成输出", reasoningContent: "" };
});
const draftTask = {
  id: "draft-task",
  kind: "thoughtDraft",
  targetId: "draft-target",
  clientRequestId: "draft-request",
  payload: { question: "问题", idea: "想法", binding: {} }
};
const starterTask = {
  id: "starter-task",
  kind: "thoughtPrompt",
  targetId: "starter-target",
  clientRequestId: "starter-request",
  payload: { occurredOn: "2026-10-09", binding: {} }
};
for (const task of [draftTask, starterTask]) {
  const prepared = workflows.personalizedTaskHandler.prepare(store, task);
  const corePrefix = `<core_user_model fingerprint="${model.fingerprint}">\n${JSON.stringify(model)}\n</core_user_model>`;
  const coreIndex = prepared.prompt.indexOf(corePrefix);
  assert.ok(coreIndex >= 0, `${task.kind} must serialize the exact core model as its stable context prefix`);
  assert.equal(prepared.prompt.includes("historical_user_supplement"), false,
    `${task.kind} P00 fixture must not inject the later historical supplement`);
  assert.equal(prepared.prompt.includes("seven_day_trend"), false,
    `${task.kind} P00 fixture must not inject the later seven-day trend`);
  if (task.kind === "thoughtDraft") {
    assert.ok(prepared.prompt.indexOf("问题") > coreIndex,
      "thoughtDraft must place the current question after the stable core model");
  }
  assert.match(prepared.contextFingerprint, /[a-f0-9]{64}/);
}

const legacyBackedEmptyStore = emptyReadyStore();
const emptyModel = coreUserModelProjection(legacyBackedEmptyStore);
const emptyModelWorkflow = workflowFor(legacyBackedEmptyStore, async prompt => {
  assert.match(prompt, new RegExp(emptyModel.fingerprint));
  return { content: "使用未知而非旧模型补齐", reasoningContent: "" };
});
const emptyModelDraft = await emptyModelWorkflow.createDraft({
  question: "保留未知",
  idea: "",
  requestId: "empty-model-draft",
  targetId: "empty-model-draft",
  inputVersion: 1
});
assert.equal(emptyModelDraft.draft, "使用未知而非旧模型补齐");

const answerDeltas = [];
const answerWorkflow = workflowFor(store, async (prompt, options) => {
  prompts.push({ prompt, options });
  const content = JSON.stringify({
    answer: "先把当前目标拆成一个可完成的小闭环。",
    citations: [
      { citationId: "core:onboarding:currentContext", exactQuote: "正在适应新的工作节奏" },
      { citationId: "core:onboarding:forged", exactQuote: "伪造的用户原话" }
    ]
  });
  options.onDelta({ type: "content", delta: content.slice(0, 14) });
  options.onDelta({ type: "content", delta: content.slice(14, 43) });
  options.onDelta({ type: "content", delta: content.slice(43) });
  return {
    content,
    reasoningContent: "不得以推理文本替代回答"
  };
});
const answer = await answerWorkflow.answerRoot({
  id: "thought-1",
  clientRequestId: "answer-forged-citation",
  onDelta: event => answerDeltas.push(event)
});
assert.match(prompts.at(-1).prompt, new RegExp(model.fingerprint));
const serializedAnswerCore = `"coreUserModel":${JSON.stringify({
  fingerprint: model.fingerprint,
  claims: model.claims,
  answers: model.answers.map(answer => ({
    sourceId: answer.sourceId,
    citationId: answer.citationId,
    title: answer.title,
    informationType: answer.informationType,
    text: answer.text,
    sourceVersion: answer.sourceVersion
  })),
  unknowns: model.unknowns
})}`;
const answerCoreIndex = prompts.at(-1).prompt.indexOf(serializedAnswerCore);
assert.ok(answerCoreIndex >= 0,
  "answer prompt must preserve the exact serialized core model as the first working-context field");
assert.ok(prompts.at(-1).prompt.indexOf("\"currentTask\"") > answerCoreIndex,
  "answer prompt must place the current task after the stable core model");
assert.equal(prompts.at(-1).prompt.includes("historical_user_supplement"), false);
assert.equal(prompts.at(-1).prompt.includes("seven_day_trend"), false);
assert.equal(prompts.at(-1).options.json, true);
assert.deepEqual(answer.citations.map(item => [item.citationId, item.exactQuote]), [[
  "core:onboarding:currentContext",
  "正在适应新的工作节奏"
]], "fabricated citation IDs must be discarded while exact source quotes remain");
assert.equal(answer.citationStatus, "matched");
assert.equal(answer.content, "先把当前目标拆成一个可完成的小闭环。");
assert.equal(answerDeltas.filter(event => event.type === "content").map(event => event.delta).join(""), answer.content,
  "the streamed answer must reconstruct only verified text");
assert.equal(answerDeltas.length, 3, "the verified answer should retain multiple content deltas");
assert.doesNotMatch(JSON.stringify(answerDeltas), /伪造|core:onboarding|\\\"answer/,
  "provider JSON and forged citation identifiers must never be streamed");

const answerRaceStore = readyStore();
const answerGate = gate();
let answerStartedPrompt = "";
const answerRaceWorkflow = workflowFor(answerRaceStore, async (prompt, options) => {
  answerStartedPrompt = prompt;
  options.onDelta({ type: "content", delta: "撤权后不得展示" });
  answerGate.notifyStarted();
  await answerGate.wait;
  return {
    content: JSON.stringify({ answer: "撤权后不得返回", citations: [] }),
    reasoningContent: ""
  };
});
const staleAnswerDeltas = [];
const pendingAnswer = answerRaceWorkflow.answerRoot({
  id: "thought-1",
  clientRequestId: "answer-source-revoked",
  onDelta: event => staleAnswerDeltas.push(event)
});
await answerGate.started;
assert.match(answerStartedPrompt, new RegExp(coreUserModelProjection(answerRaceStore).fingerprint));
revokeCoreAnswer(answerRaceStore);
answerGate.release();
await assert.rejects(pendingAnswer, error => ["STALE_PERSONAL_CONTEXT", "CORE_MODEL_NOT_READY"].includes(error.code));
assert.equal(answerRaceStore.thoughts.some(item => item.type === "answer"), false,
  "a revoked model source must prevent answer persistence");
assert.deepEqual(staleAnswerDeltas, [], "a revoked source must suppress streamed answer text");

const editedSourceStore = readyStore();
const editedSourceGate = gate();
const editedSourceWorkflow = workflowFor(editedSourceStore, async (_prompt, options) => {
  options.onDelta({ type: "content", delta: "来源修改后不得展示" });
  editedSourceGate.notifyStarted();
  await editedSourceGate.wait;
  return {
    content: JSON.stringify({ answer: "来源修改后不得保存", citations: [] }),
    reasoningContent: ""
  };
});
const editedSourceDeltas = [];
const editedSourceAnswer = editedSourceWorkflow.answerRoot({
  id: "thought-1",
  clientRequestId: "answer-source-edited",
  onDelta: event => editedSourceDeltas.push(event)
});
await editedSourceGate.started;
const editedQuestion = editedSourceStore.thoughts.find(item => item.id === "thought-1");
editedQuestion.content = "生成期间用户修改了原问题";
editedQuestion.version += 1;
editedSourceGate.release();
await assert.rejects(editedSourceAnswer, error => ["STALE_PERSONAL_CONTEXT", "STALE_AI_RESULT"].includes(error.code));
assert.equal(editedSourceStore.thoughts.some(item => item.type === "answer"), false,
  "an edited source question must prevent answer persistence");
assert.deepEqual(editedSourceDeltas, [], "an edited source question must suppress buffered answer text");

for (const operation of ["createDraft", "createStarter"]) {
  const raceStore = readyStore();
  const generationGate = gate();
  let generatedPrompt = "";
  const raceWorkflow = workflowFor(raceStore, async (prompt, options) => {
    generatedPrompt = prompt;
    options.onDelta?.({ type: "content", delta: "撤权后不得展示" });
    generationGate.notifyStarted();
    await generationGate.wait;
    return { content: "撤权后不得返回", reasoningContent: "" };
  });
  const outputDeltas = [];
  const running = operation === "createDraft"
    ? raceWorkflow.createDraft({
        question: "草稿问题",
        idea: "草稿想法",
        requestId: "draft-race",
        targetId: "draft-race",
        inputVersion: 1,
        onDelta: event => outputDeltas.push(event)
      })
    : raceWorkflow.createStarter({
        eventTime: { occurredOn: "2026-10-09" },
        binding: { requestId: "starter-race" },
        onDelta: event => outputDeltas.push(event)
      });
  await generationGate.started;
  assert.match(generatedPrompt, new RegExp(coreUserModelProjection(raceStore).fingerprint));
  revokeCoreAnswer(raceStore);
  generationGate.release();
  await assert.rejects(running, error => ["STALE_PERSONAL_CONTEXT", "CORE_MODEL_NOT_READY"].includes(error.code));
  assert.deepEqual(outputDeltas, [], `${operation} must suppress buffered text after source revocation`);
}

console.log("Thought workflow P00 regression passed: core-only prompt prefix, verified citations, and revoked or stale-context output suppression.");
