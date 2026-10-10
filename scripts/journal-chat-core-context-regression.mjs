import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  answerCitationSources,
  coreUserModelProjection,
  createCaptureJournalWorkflows,
  createReviewChatWorkflows,
  prepareUserModelExtraction,
  userModelCoreReadiness
} from "../src/app/index.mjs";
import { defaultOnboardingV2, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import { evidenceSourceKey } from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const accountId = "journal-chat-core-context-account";
const asOf = "2026-10-10T02:00:00.000Z";
const sourcePermissionKey = evidenceSourceKey({
  resourceType: "onboardingV2",
  resourceId: "currentContext",
  rootId: "",
  targetKey: "answer:currentContext",
  version: 2
});
const thoughtPermissionKey = evidenceSourceKey({
  resourceType: "thought",
  resourceId: "thought-evidence",
  rootId: "thought-evidence",
  targetKey: "question:thought-evidence",
  version: 1
});
function createReadyStore() {
  const onboardingV2 = normalizeOnboardingV2({
    session: {
      id: "onboarding-v2",
      status: "completed",
      step: "firstAction",
      revision: 8,
      answers: {
        currentContext: { rawText: "core-source-current-context", contextAllowed: true, version: 2 },
        desiredChanges: { structuredValue: [{ text: "core-source-goal", horizon: "3m" }], contextAllowed: true, version: 1 },
        recentObstacles: { structuredValue: [{ text: "core-source-obstacle" }], contextAllowed: true, version: 1 },
        dailyRhythm: { rawText: "core-source-rhythm", contextAllowed: true, version: 1 }
      },
      collaboration: {
        responseLength: { value: "concise", source: "user" },
        suggestionMode: { value: "reasonFirst", source: "user" },
        challengeStyle: { value: "direct", source: "user" },
        additionalBoundary: "core-source-boundary",
        contextAllowed: true,
        answerVersion: 1
      },
      completedAt: asOf,
      updatedAt: asOf
    },
    migration: { selectedFlow: "v2" }
  }, defaultOnboardingV2);
  const extractionStore = {
    onboardingV2,
    userClaims: [],
    modelUnknowns: [],
    aiTasks: []
  };
  const prepared = prepareUserModelExtraction(extractionStore, { sourceRevision: 8 });
  assert.ok(prepared.value);
  const succeededTask = {
    kind: "onboardingClaimExtraction",
    status: "succeeded",
    targetId: "onboarding-v2",
    inputVersion: 8,
    inputHash: prepared.value.inputHash
  };
  const store = {
    ...structuredClone(extractionStore),
    aiTasks: [succeededTask],
    journals: [{
      id: "journal-target",
      title: "核心模型回望测试",
      content: "dynamic-journal-marker",
      tags: [],
      occurredAt: "2026-10-09T08:00:00.000Z",
      occurredOn: "2026-10-09",
      createdAt: "2026-10-09T08:00:00.000Z",
      updatedAt: "2026-10-09T08:00:00.000Z",
      version: 1,
      reflections: []
    }],
    captures: [{
      id: "capture-dynamic",
      content: "dynamic-activity-marker",
      occurredAt: "2026-10-09T08:30:00.000Z",
      occurredOn: "2026-10-09",
      createdAt: "2026-10-09T08:30:00.000Z",
      version: 1
    }],
    thoughts: [{
      id: "thought-evidence",
      type: "question",
      authorType: "user",
      content: "dynamic-analysis-marker",
      tags: [],
      occurredAt: "2026-10-09T09:00:00.000Z",
      occurredOn: "2026-10-09",
      createdAt: "2026-10-09T09:00:00.000Z",
      version: 1,
      followUps: []
    }],
    chats: [],
    analyses: [],
    checkins: [],
    dailyRecords: [],
    actions: [],
    evidencePermissions: [
      {
        schemaVersion: 1,
        accountId,
        sourceKey: sourcePermissionKey,
        contextAllowed: true,
        learningAllowed: false,
        revision: 1,
        updatedAt: asOf
      },
      {
        schemaVersion: 1,
        accountId,
        sourceKey: thoughtPermissionKey,
        contextAllowed: true,
        learningAllowed: true,
        revision: 1,
        updatedAt: asOf
      }
    ],
    notifications: []
  };
  assert.equal(userModelCoreReadiness(store).ready, true);
  assert.ok(coreUserModelProjection(store)?.fingerprint);
  return store;
}

function createHarness({
  store = createReadyStore(),
  generate = async () => ({ content: "synthetic result" }),
  beforeUpdate
} = {}) {
  const citationSources = answerCitationSources(coreUserModelProjection(store));
  const coreCitation = citationSources.find(source => source.text.includes("core-source-current-context"))
    || citationSources[0];
  const generateWithCitationContract = async (prompt, options = {}) => {
    const result = await generate(prompt, options);
    if (options.json !== true || typeof result?.content !== "string") return result;
    try {
      JSON.parse(result.content);
      return result;
    } catch {
      return {
        ...result,
        content: JSON.stringify({
          answer: result.content,
          citations: coreCitation ? [{
            citationId: coreCitation.citationId,
            exactQuote: coreCitation.text.includes("core-source-current-context")
              ? "core-source-current-context"
              : coreCitation.text.slice(0, 80)
          }] : []
        })
      };
    }
  };
  const repository = {
    async read() {
      return structuredClone(store);
    },
    async update(operation) {
      beforeUpdate?.(store);
      return operation(store);
    }
  };
  let id = 0;
  const createId = () => `synthetic-${++id}`;
  const journals = {
    async get(targetId) {
      return store.journals.find(item => item.id === targetId) || null;
    },
    async findReflectionRequest() {
      return null;
    },
    async addReflection(targetId, input) {
      const journal = store.journals.find(item => item.id === targetId);
      const value = { id: createId(), createdAt: asOf, ...input };
      journal.reflections.unshift(value);
      return { value };
    },
    addReflectionInStore(document, targetId, input) {
      const journal = document.journals.find(item => item.id === targetId);
      if (!journal) return { missing: true };
      const value = { id: createId(), createdAt: asOf, ...input };
      journal.reflections.unshift(value);
      return { value };
    }
  };
  const chats = {
    async findRequest() {
      return null;
    },
    async save(input) {
      return { value: { id: createId(), ...input } };
    },
    saveInStore(document, input) {
      const value = { id: createId(), ...input };
      document.chats.unshift(value);
      return { value };
    }
  };
  const reviews = {
    async findAnalysisRequest() {
      return null;
    },
    saveAnalysisInStore(document, input) {
      const value = { id: createId(), ...input };
      document.analyses.unshift(value);
      return { value };
    }
  };
  const backgroundAi = {
    async enqueue(input) {
      return { task: { id: createId(), ...input } };
    }
  };
  const capture = createCaptureJournalWorkflows({
    repository,
    journals,
    backgroundAi,
    generate: generateWithCitationContract,
    hash,
    createId,
    coreModelReadiness: userModelCoreReadiness,
    getRecentTrend: () => null,
    currentTime: () => Date.parse(asOf),
    today: () => "2026-10-10"
  });
  const review = createReviewChatWorkflows({
    repository,
    chats,
    reviews,
    backgroundAi,
    generate: generateWithCitationContract,
    hash,
    coreModelReadiness: userModelCoreReadiness,
    getRecentTrend: () => null,
    contextKey: () => accountId,
    getAccountId: () => accountId,
    currentTime: () => Date.parse(asOf),
    createId
  });
  return { store, repository, capture, review, journals, chats, reviews };
}

function expectedCorePrefix(store) {
  const model = coreUserModelProjection(store);
  return JSON.stringify({
    coreUserModel: {
      fingerprint: model.fingerprint,
      claims: model.claims,
      answers: model.answers,
      unknowns: model.unknowns
    }
  });
}

function assertPromptOrder(prompt, store, dynamicMarker, label) {
  const prefix = expectedCorePrefix(store);
  const coreIndex = prompt.indexOf(prefix);
  assert.notEqual(coreIndex, -1, `${label}: exact serialized core model must be the stable prompt prefix`);
  assert.ok(prompt.indexOf(`"fingerprint":"${coreUserModelProjection(store).fingerprint}"`) >= coreIndex,
    `${label}: current core model fingerprint must be present`);
  const dynamicIndex = prompt.indexOf(dynamicMarker);
  assert.notEqual(dynamicIndex, -1, `${label}: user-authored dynamic evidence must remain in the prompt`);
  assert.ok(coreIndex < dynamicIndex, `${label}: stable model context must precede dynamic context`);
  assert.equal(prompt.includes('"historicalUserSupplement"'), false,
    `${label}: P00 core-only coverage must not inject historical supplements`);
  assert.equal(prompt.includes('"sevenDayTrend"'), false,
    `${label}: P00 core-only coverage must not inject seven-day trends`);
}

function reviseCorePermission(store) {
  const permission = store.evidencePermissions.find(item => item.sourceKey === sourcePermissionKey);
  permission.revision += 1;
}

function changeCoreModel(store) {
  const answer = store.onboardingV2.session.answers.currentContext;
  answer.rawText = `${answer.rawText} · 已修订`;
  answer.version += 1;
  store.onboardingV2.session.revision += 1;
  const prepared = prepareUserModelExtraction(store, {
    sourceRevision: store.onboardingV2.session.revision
  });
  assert.ok(prepared.value);
  const extraction = store.aiTasks.find(item => item.kind === "onboardingClaimExtraction");
  extraction.inputVersion = store.onboardingV2.session.revision;
  extraction.inputHash = prepared.value.inputHash;
  const permission = store.evidencePermissions.find(item => item.sourceKey === sourcePermissionKey);
  permission.sourceKey = evidenceSourceKey({
    resourceType: "onboardingV2",
    resourceId: "currentContext",
    rootId: "",
    targetKey: "answer:currentContext",
    version: answer.version
  });
  permission.revision += 1;
  assert.equal(userModelCoreReadiness(store).ready, true);
}

const foregroundCases = [
  {
    name: "journalAssist",
    dynamic: "dynamic-activity-marker",
    invoke: harness => harness.capture.assist({
      mode: "lead",
      occurredOn: "2026-10-09",
      title: "当前日记草稿",
      content: "dynamic-journal-assist-input"
    })
  },
  {
    name: "journalReflection",
    dynamic: "dynamic-journal-marker",
    invoke: harness => harness.capture.reflect({ id: "journal-target" })
  },
  {
    name: "chat",
    dynamic: "dynamic-activity-marker",
    invoke: harness => harness.review.answerChat({
      message: "dynamic-chat-question",
      eventTime: { occurredAt: asOf, occurredOn: "2026-10-10" }
    })
  },
  {
    name: "analysis",
    dynamic: "dynamic-analysis-marker",
    invoke: harness => harness.review.runAnalysis()
  }
];

const coldStore = createReadyStore();
coldStore.aiTasks = [];
let coldProviderCalls = 0;
const coldHarness = createHarness({
  store: coldStore,
  generate: async () => {
    coldProviderCalls += 1;
    return { content: "must not run" };
  }
});
for (const item of foregroundCases) {
  await assert.rejects(item.invoke(coldHarness),
    error => error?.code === "CORE_MODEL_NOT_READY",
    `foreground ${item.name}: unavailable core model must block generation`);
}
assert.equal(coldProviderCalls, 0, "no foreground provider call may run before the core model is ready");

for (const item of foregroundCases) {
  const harness = createHarness({
    generate: async prompt => {
      assertPromptOrder(prompt, harness.store, item.dynamic, `foreground ${item.name}`);
      return { content: `foreground result ${item.name}`, reasoningContent: "synthetic" };
    }
  });
  const result = await item.invoke(harness);
  if (item.name === "journalAssist") continue;
  const persisted = item.name === "journalReflection"
    ? harness.store.journals[0].reflections[0]
    : item.name === "chat"
      ? harness.store.chats[0]
      : harness.store.analyses[0];
  assert.ok(persisted?.citations?.some(citation => citation.citationId.startsWith("core:onboarding:")),
    `foreground ${item.name}: no-trend answer must accept a citation to the core model`);
  assert.ok(result, `foreground ${item.name}: workflow returns a result`);
}

const backgroundCases = [
  {
    name: "journalAssist",
    dynamic: "dynamic-activity-marker",
    handler: "capture",
    task: { kind: "journalAssist", targetId: "journal-target", payload: {
      mode: "lead", occurredOn: "2026-10-09", title: "背景日记", content: "dynamic-draft", binding: {}
    } }
  },
  {
    name: "journalReflection",
    dynamic: "dynamic-journal-marker",
    handler: "capture",
    task: { kind: "journalReflection", targetId: "journal-target", payload: {} }
  },
  {
    name: "chat",
    dynamic: "dynamic-activity-marker",
    handler: "review",
    task: { kind: "chat", targetId: "", payload: {
      message: "dynamic-background-chat",
      occurredAt: asOf,
      occurredOn: "2026-10-10"
    } }
  },
  {
    name: "analysis",
    dynamic: "dynamic-analysis-marker",
    handler: "review",
    task: { kind: "analysis", targetId: "", payload: { reason: "manual" } }
  }
];

for (const item of backgroundCases) {
  const harness = createHarness();
  const handler = item.handler === "capture"
    ? harness.capture.personalizedTaskHandler
    : harness.review.personalizedTaskHandler;
  const work = handler.prepare(harness.store, {
    ...item.task,
    inputVersion: 0,
    clientRequestId: `background-${item.name}`,
    createdAt: asOf
  });
  assert.ok(work?.prompt, `background ${item.name}: task must prepare`);
  assertPromptOrder(work.prompt, harness.store, item.dynamic, `background ${item.name}`);
  reviseCorePermission(harness.store);
  assert.throws(() => handler.save(
    harness.store,
    work,
    { ...item.task, clientRequestId: `background-${item.name}` },
    { content: "must be rejected" }
  ), error => error?.code === "AI_TASK_STALE", `background ${item.name}: stale core model must be rejected before save`);
}

for (const item of foregroundCases) {
  const store = createReadyStore();
  const harness = createHarness({
    store,
    generate: async () => {
      reviseCorePermission(store);
      return { content: `stale result ${item.name}` };
    }
  });
  await assert.rejects(item.invoke(harness),
    error => error?.code === "AI_TASK_STALE",
    `foreground ${item.name}: provider completion after core permission change must be rejected`);
}

for (const item of [
  { name: "foreground chat model edit", run: harness => harness.review.answerChat({
    message: "model edit must stale",
    eventTime: { occurredAt: asOf, occurredOn: "2026-10-10" }
  }) },
  { name: "background journal reflection model edit", background: true }
]) {
  const store = createReadyStore();
  const harness = createHarness({
    store,
    generate: async () => {
      changeCoreModel(store);
      return { content: `stale model-edited result ${item.name}` };
    }
  });
  if (item.background) {
    const handler = harness.capture.personalizedTaskHandler;
    const task = {
      kind: "journalReflection",
      targetId: "journal-target",
      payload: {},
      inputVersion: 1,
      clientRequestId: item.name,
      createdAt: asOf
    };
    const work = handler.prepare(store, task);
    await assert.rejects(harness.capture.reflect({ id: "journal-target" }),
      error => error?.code === "AI_TASK_STALE",
      `${item.name}: foreground provider completion after model edit must be rejected`);
    assert.throws(() => handler.save(store, work, task, { content: "stale" }),
      error => error?.code === "AI_TASK_STALE",
      `${item.name}: background save after model edit must be rejected`);
  } else {
    await assert.rejects(item.run(harness),
      error => error?.code === "AI_TASK_STALE",
      `${item.name}: provider completion after model edit must be rejected`);
  }
}

const captureSourceKey = evidenceSourceKey({
  resourceType: "capture",
  resourceId: "capture-dynamic",
  rootId: "",
  targetKey: "",
  version: 1
});
const ensureRevocableCapture = store => {
  store.evidencePermissions.push({
    schemaVersion: 1,
    accountId,
    sourceKey: captureSourceKey,
    contextAllowed: true,
    learningAllowed: false,
    revision: 1,
    updatedAt: asOf
  });
};
const onDeltaFlows = [
  {
    name: "assist",
    invoke: (harness, onDelta) => harness.capture.assist({
      mode: "lead",
      occurredOn: "2026-10-09",
      title: "当前日记草稿",
      content: "streamed assist evidence"
    }, { binding: { targetId: "journal-target" }, onDelta })
  },
  {
    name: "reflect",
    invoke: (harness, onDelta) => harness.capture.reflect({
      id: "journal-target",
      onDelta
    })
  }
];
const onDeltaStaleMutations = [
  {
    name: "source permission revoked",
    prepare: ensureRevocableCapture,
    mutate: harness => {
      const permission = harness.store.evidencePermissions.find(item => item.sourceKey === captureSourceKey);
      permission.contextAllowed = false;
      permission.revision += 1;
    }
  },
  {
    name: "source edited",
    mutate: harness => {
      harness.store.captures[0].content = "source edited while the model was generating";
    }
  }
];

for (const flow of onDeltaFlows) {
  for (const mutation of onDeltaStaleMutations) {
    const delivered = [];
    let harness;
    harness = createHarness({
      generate: async (_prompt, options) => {
        options.onDelta?.({ type: "delta", content: "must-not-escape" });
        assert.deepEqual(delivered, [], `${flow.name}/${mutation.name}: deltas stay buffered during generation`);
        mutation.mutate(harness);
        return { content: `stale ${flow.name} output` };
      }
    });
    mutation.prepare?.(harness.store);
    await assert.rejects(flow.invoke(harness, event => delivered.push(event)),
      error => error?.code === "AI_TASK_STALE" || error?.code === "STALE_PERSONAL_CONTEXT",
      `${flow.name}/${mutation.name}: stale streamed result must be refused`);
    assert.deepEqual(delivered, [], `${flow.name}/${mutation.name}: stale delta must not reach the client`);
    assert.equal(harness.store.journals[0].reflections.length, 0,
      `${flow.name}/${mutation.name}: stale output must not save a reflection`);
    assert.equal(harness.store.chats.length, 0, `${flow.name}/${mutation.name}: stale output must not save a chat`);
    assert.equal(harness.store.analyses.length, 0, `${flow.name}/${mutation.name}: stale output must not save an analysis`);
  }
}

for (const flow of onDeltaFlows) {
  const delivered = [];
  let harness;
  harness = createHarness({
    generate: async (_prompt, options) => {
      options.onDelta?.({ type: "delta", content: "first" });
      options.onDelta?.({ type: "delta", content: "second" });
      assert.deepEqual(delivered, [], `${flow.name}: valid deltas stay buffered until freshness checks finish`);
      return { content: `valid ${flow.name} output` };
    }
  });
  await flow.invoke(harness, event => {
    if (flow.name === "reflect") {
      assert.equal(harness.store.journals[0].reflections.length, 1,
        "reflect: persistence completes before buffered deltas are replayed");
    }
    delivered.push(event);
  });
  if (flow.name === "reflect") {
    assert.deepEqual(delivered.map(event => event.delta), ["valid reflect output"],
      "reflect: only the verified final answer is sent after persistence");
  } else {
    assert.deepEqual(delivered.map(event => event.content), ["first", "second"],
      `${flow.name}: valid SSE deltas replay in their original order`);
  }
  if (flow.name === "reflect") {
    assert.equal(harness.store.journals[0].reflections.length, 1,
      "reflect: valid response persists before the buffered stream is replayed");
  }
}

for (const flow of onDeltaFlows) {
  const delivered = [];
  let harness;
  harness = createHarness({
    generate: async (_prompt, options) => {
      options.onDelta?.({ type: "delta", content: "target-stale" });
      harness.store.journals[0].content = "business target edited during generation";
      harness.store.journals[0].updatedAt = "2026-10-10T03:00:00.000Z";
      harness.store.journals[0].version += 1;
      return { content: "stale target result" };
    }
  });
  await assert.rejects(flow.invoke(harness, event => delivered.push(event)),
    error => error?.code === "AI_TASK_STALE" || error?.code === "STALE_PERSONAL_CONTEXT",
    `${flow.name}: edits to the current journal target must be refused`);
  assert.deepEqual(delivered, [], `${flow.name}: target-stale deltas must not reach the client`);
  assert.equal(harness.store.journals[0].reflections.length, 0,
    `${flow.name}: target-stale result must not save a reflection`);
}

console.log("journal-chat-core-context-regression: P00 core-only prefix, stale core/source refusal, atomic saves, and buffered SSE checks passed");
