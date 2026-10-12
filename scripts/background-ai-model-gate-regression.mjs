import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createBackgroundAi } from "../src/app/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import { mapStoreObjects } from "../src/shared/persistence/index.mjs";

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const clone = value => structuredClone(value);
let id = 0;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)).toISOString();
let store = {
  coreReady: false,
  thoughts: [
    { id: "question", type: "question", content: "original", version: 1 },
    { id: "otherQuestion", type: "question", content: "other-original", version: 1 }
  ],
  targetVersions: { question: 1, otherQuestion: 1, missing: 1 },
  targetContent: { question: "original", otherQuestion: "other-original" },
  aiTasks: [],
  notifications: []
};
const repository = {
  async read() {
    return clone(store);
  },
  async update(mutate) {
    const draft = clone(store);
    const result = await mutate(draft);
    store = draft;
    return clone(result);
  }
};
const scheduled = [];
let prepareCalls = 0;
const preparedCreatedAt = [];
const preparedContextGeneratedAt = [];
let intentChecks = 0;
let modelCalls = 0;
let generatedPrompt = "";
const lifecycle = createTaskLifecycle({
  createId: () => `task-${++id}`,
  now,
  hash: digest
});
const reflectionTasks = [];
const reflectionIntent = {
  inputVersion: 4,
  subtargetVersion: 0,
  inputHash: digest("journal:reflection:version-4")
};
const firstReflection = lifecycle.create(reflectionTasks, {
  kind: "journalReflection",
  targetId: "journal-1",
  clientRequestId: "reflection-request-one"
}, () => null, { deferTargetInspection: true, requestedIntent: reflectionIntent });
const replayedReflection = lifecycle.create(reflectionTasks, {
  kind: "journalReflection",
  targetId: "journal-1",
  clientRequestId: "reflection-request-after-reload"
}, () => null, { deferTargetInspection: true, requestedIntent: reflectionIntent });
assert.equal(firstReflection.task.status, "waiting_for_user_model");
assert.equal(replayedReflection.duplicate, true,
  "a second cold reflection request for the same journal version reuses its active durable task");
assert.equal(replayedReflection.task.id, firstReflection.task.id);
const updatedReflection = lifecycle.create(reflectionTasks, {
  kind: "journalReflection",
  targetId: "journal-1",
  clientRequestId: "reflection-request-after-edit"
}, () => null, {
  deferTargetInspection: true,
  requestedIntent: { ...reflectionIntent, inputVersion: 5, inputHash: digest("journal:reflection:version-5") }
});
assert.equal(updatedReflection.duplicate, false,
  "a journal edit starts a distinct reflection task");
const background = createBackgroundAi({
  repository,
  tasks: lifecycle,
  now,
  notifications: {
    upsertTask(items, task, status, message) {
      items.push({ taskId: task.id, status, message });
    }
  },
  targets: {
    inspectIntent(current, input) {
      intentChecks += 1;
      if (!Object.hasOwn(current.targetVersions, input.targetId)) return false;
      const version = current.targetVersions[input.targetId];
      return {
        inputVersion: version,
        subtargetVersion: 0,
        inputHash: digest(`intent:${input.targetId}:${version}:${current.targetContent[input.targetId]}`),
        alreadyAnswered: input.kind === "followUpAnswer" && input.subtargetId === "answered"
      };
    },
    prepare(current, task) {
      prepareCalls += 1;
      preparedCreatedAt.push(task.createdAt || "");
      preparedContextGeneratedAt.push(task.contextGeneratedAt || "");
      const version = current.targetVersions[task.targetId];
      if (!version) return null;
      return {
        kind: task.kind,
        targetId: task.targetId,
        inputVersion: version,
        subtargetVersion: 0,
        inputHash: digest(`${task.targetId}:${version}:${current.targetContent[task.targetId]}`),
        prompt: `问题版本 ${version}：${current.targetContent[task.targetId]}`,
        scene: task.kind,
        contextFingerprint: digest(`context:${version}`)
      };
    },
    save(_current, _work, task) {
      return task.id;
    },
    result(_current, task) {
      return { id: task.id };
    }
  },
  shouldWaitForModel: (current, input) => (
    !current.coreReady
      && !["onboardingClaimExtraction", "captureTranscription"].includes(input.kind)
  ),
  generate: async work => {
    modelCalls += 1;
    generatedPrompt = work.prompt;
    if (work.kind === "onboardingClaimExtraction") store.coreReady = true;
    return { content: work.prompt };
  },
  dispatch: callback => scheduled.push(callback),
  contextKey: () => "account-a",
  onError: error => { throw error; }
});

const waiting = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 1,
  clientRequestId: "wait-for-model-1"
});
assert.equal(waiting.task.status, "waiting_for_user_model");
assert.equal(waiting.task.requestedIntentInputVersion, 1);
assert.equal(waiting.task.requestedIntentInputHash, digest("intent:question:1:original"));
assert.equal(prepareCalls, 0, "creating a waiting task must not prepare answer context");
assert.equal(scheduled.length, 0, "waiting tasks must not be scheduled");
assert.equal(intentChecks, 1, "waiting task creation uses lightweight intent validation");
assert.equal(lifecycle.claim(store.aiTasks, waiting.task.id), null, "waiting tasks cannot be claimed");
const answeredFollowUp = await background.enqueue({
  kind: "followUpAnswer",
  targetId: "question",
  subtargetId: "answered",
  clientRequestId: "already-answered-follow-up"
});
assert.equal(answeredFollowUp.alreadyAnswered, true,
  "lightweight intent validation preserves already-answered rejection without preparing context");
assert.equal(prepareCalls, 0);

const cancelled = await background.cancelPersisted(waiting.task.id);
assert.equal(cancelled.status, "cancelled", "waiting tasks can be cancelled");
assert.equal(scheduled.length, 0);

const recoverable = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  clientRequestId: "wait-for-model-2"
});
store.targetVersions.question = 2;
await background.resume();
assert.equal(store.aiTasks.find(task => task.id === recoverable.task.id).status, "stale");
assert.equal(scheduled.length, 0, "restart preserves waiting tasks while readiness is false");
assert.equal(prepareCalls, 0, "restart must not prepare context for a still-waiting task");
assert.equal(store.aiTasks.find(task => task.id === recoverable.task.id).requestedIntentInputVersion, 1,
  "waiting tasks keep the target version captured when they were created");
assert.equal(store.aiTasks.find(task => task.id === recoverable.task.id).status, "stale",
  "a source change while waiting is terminal even before readiness returns");

store.coreReady = true;
assert.equal(await background.releaseWaiting(), 0, "stale waiting tasks are not promoted");
assert.equal(prepareCalls, 0, "a stale waiting task is rejected before preparing context");
assert.equal(scheduled.length, 0);

store.targetVersions.question = 2;
store.coreReady = false;
store.targetContent.question = "same-version-new-content";
const freshWaiting = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 2,
  clientRequestId: "fresh-wait-for-model"
});
const changedIntentHash = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "otherQuestion",
  inputVersion: 1,
  clientRequestId: "intent-hash-changed-while-waiting"
});
store.targetContent.otherQuestion = "changed-without-version-bump";
await background.resume();
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).status, "waiting_for_user_model",
  "restart preserves a still-valid waiting task while readiness remains false");
assert.equal(store.aiTasks.find(task => task.id === changedIntentHash.task.id).status, "stale",
  "initial waiting task target content is pinned independently of version numbers");
assert.equal(prepareCalls, 0, "restart does not compile context for a still-waiting task");
tick = 86_400;
store.coreReady = true;
assert.equal(await background.releaseWaiting(), 1);
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).status, "queued");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).createdAt.slice(0, 10), "2026-10-10");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).contextGeneratedAt.slice(0, 10), "2026-10-11",
  "a waiting task captures its trend window when readiness is released, including after midnight");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).inputVersion, 2);
assert.equal(prepareCalls, 1);
assert.equal(preparedContextGeneratedAt.at(-1), store.aiTasks.find(task => task.id === freshWaiting.task.id).contextGeneratedAt);
assert.equal(scheduled.length, 1);
assert.equal(await background.releaseWaiting(), 0);
assert.equal(scheduled.length, 1, "repeated release does not schedule the same task twice");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).contextGeneratedAt.slice(0, 10), "2026-10-11",
  "repeated readiness checks preserve the single generated trend snapshot");

await background.run(freshWaiting.task.id);
assert.equal(modelCalls, 1);
assert.equal(generatedPrompt, "问题版本 2：same-version-new-content", "the provider receives the request's pinned target after release");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).status, "succeeded");

const bypass = await background.enqueue({
  kind: "onboardingClaimExtraction",
  targetId: "question",
  inputVersion: 2,
  clientRequestId: "core-extraction-bypass"
});
assert.equal(bypass.task.status, "queued", "the injected policy can exempt core extraction");
assert.equal(preparedCreatedAt.at(-1), bypass.task.createdAt,
  "target inspection and persisted task share one creation timestamp");
const transcription = await background.enqueue({
  kind: "captureTranscription",
  targetId: "question",
  clientRequestId: "transcription-bypass"
});
assert.equal(transcription.task.status, "queued", "the injected policy can exempt transcription");

store.coreReady = false;
const staleWhileWaiting = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 2,
  clientRequestId: "stale-while-waiting"
});
store.targetVersions.question = 3;
store.coreReady = true;
assert.equal(await background.releaseWaiting(), 0);
assert.equal(store.aiTasks.find(task => task.id === staleWhileWaiting.task.id).status, "stale",
  "a target version pinned by the request cannot be silently replaced while waiting");
assert.equal(scheduled.length, 3, "a stale waiting task is not scheduled");
assert.equal(modelCalls, 1, "a stale waiting task never calls the answer model");

store.coreReady = false;
const invalidIntent = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "not-present",
  clientRequestId: "missing-target"
});
assert.equal(invalidIntent.missing, true, "waiting requests are checked without compiling context");

store.coreReady = true;
const queuedBeforeRevocation = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 3,
  clientRequestId: "ready-then-revoked"
});
assert.equal(queuedBeforeRevocation.task.status, "queued");
const preparesBeforeClaim = prepareCalls;
store.coreReady = false;
await background.run(queuedBeforeRevocation.task.id);
assert.equal(store.aiTasks.find(task => task.id === queuedBeforeRevocation.task.id).status, "waiting_for_user_model",
  "readiness revocation before claim moves the task back to waiting");
assert.equal(prepareCalls, preparesBeforeClaim,
  "a task that loses readiness before claim never prepares context");
assert.equal(modelCalls, 1, "a task that loses readiness before claim never calls the provider");
assert.ok(store.notifications.some(item => item.taskId === queuedBeforeRevocation.task.id
  && item.status === "waiting_for_user_model"), "the atomic transition notifies the waiting state");
store.coreReady = true;
assert.equal(await background.releaseWaiting(), 1, "fresh readiness promotes the revoked task once");
await background.run(queuedBeforeRevocation.task.id);
assert.equal(store.aiTasks.find(task => task.id === queuedBeforeRevocation.task.id).status, "succeeded");
assert.equal(modelCalls, 2);

store.coreReady = true;
const staleQueuedRevocation = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 3,
  clientRequestId: "queued-target-changed-before-revocation"
});
store.targetVersions.question = 4;
store.coreReady = true;
const queuedBeforeContentChange = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 4,
  clientRequestId: "queued-content-change-before-waiting"
});
const requestedInputHash = store.aiTasks.find(task => task.id === queuedBeforeContentChange.task.id).requestedInputHash;
store.coreReady = false;
const preparesBeforeWaitingTransition = prepareCalls;
await background.run(queuedBeforeContentChange.task.id);
const waitingAfterRevocation = store.aiTasks.find(task => task.id === queuedBeforeContentChange.task.id);
assert.equal(waitingAfterRevocation.status, "waiting_for_user_model");
assert.equal(waitingAfterRevocation.requestedInputHash, requestedInputHash,
  "queued to waiting preserves the original prepared-input hash");
assert.equal(prepareCalls, preparesBeforeWaitingTransition,
  "readiness revocation still does not prepare the task");
store.targetContent.question = "changed-without-version-bump";
store.coreReady = true;
assert.equal(await background.releaseWaiting(), 0);
assert.equal(store.aiTasks.find(task => task.id === queuedBeforeContentChange.task.id).status, "stale",
  "a same-version input hash change cannot be rebound during waiting release");
assert.equal(modelCalls, 2, "a same-version content change never calls the provider");

store.targetVersions.question = 4;
store.coreReady = false;
const prepareCountBeforeStaleClaim = prepareCalls;
await background.run(staleQueuedRevocation.task.id);
assert.equal(store.aiTasks.find(task => task.id === staleQueuedRevocation.task.id).status, "stale",
  "a queued task whose target changed before readiness revocation is stale");
assert.equal(prepareCalls, prepareCountBeforeStaleClaim,
  "stale queued intent is rejected without preparing context");
assert.equal(modelCalls, 2, "stale queued intent never calls the provider");

store.targetVersions.question = 4;
store.coreReady = false;
const waitingForExtraction = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "question",
  inputVersion: 4,
  clientRequestId: "release-after-extraction"
});
const extraction = await background.enqueue({
  kind: "onboardingClaimExtraction",
  targetId: "question",
  inputVersion: 4,
  clientRequestId: "extraction-readiness-release"
});
assert.equal(extraction.task.status, "queued", "core extraction is allowed while the model is not ready");
await background.run(extraction.task.id);
assert.equal(store.aiTasks.find(task => task.id === extraction.task.id).status, "succeeded");
assert.equal(store.aiTasks.find(task => task.id === waitingForExtraction.task.id).status, "queued",
  "successful core extraction releases waiting answers after saving its result");
assert.equal(scheduled.length, 9, "extraction release schedules its waiting answer exactly once");

assert.ok(prepareCalls >= 7,
  "preparation happens only for promotable waiting tasks and execution paths that pass the readiness gate");

const recoveryStore = {
  coreReady: false,
  thoughts: [{
    id: "live-target",
    type: "question",
    content: "Existing thought",
    version: 1,
    followUps: [{ id: "live-follow-up", question: "Existing follow-up", version: 1 }]
  }],
  journals: [],
  chats: [],
  analyses: [],
  onboardingV2: { id: "onboardingV2" },
  recordCompressions: [{ id: "daily-target", status: "queued", version: 1 }],
  aiTasks: [],
  notifications: []
};
const recoveryIntent = {
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: digest("recovery-target-v1")
};
const recoveryLifecycle = createTaskLifecycle({
  createId: () => `recovery-task-${recoveryStore.aiTasks.length + 1}`,
  now,
  hash: digest
});
const waitingForMissingTarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "thoughtAnswer",
  targetId: "removed-target",
  inputVersion: 1,
  clientRequestId: "recovery-missing-target"
}, () => null, { deferTargetInspection: true, requestedIntent: recoveryIntent });
const waitingForLiveTarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "thoughtAnswer",
  targetId: "live-target",
  inputVersion: 1,
  clientRequestId: "recovery-live-target"
}, () => null, { deferTargetInspection: true, requestedIntent: recoveryIntent });
const queuedForLiveTarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "thoughtAnswer",
  targetId: "live-target",
  clientRequestId: "recovery-existing-queued"
}, () => ({
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: recoveryIntent.inputHash
}));
assert.equal(waitingForMissingTarget.task.status, "waiting_for_user_model");
assert.equal(waitingForLiveTarget.task.status, "waiting_for_user_model");
assert.equal(queuedForLiveTarget.task.status, "queued");
const queuedForMissingTarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "thoughtAnswer",
  targetId: "removed-target",
  clientRequestId: "recovery-existing-orphaned-queue"
}, () => ({
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: recoveryIntent.inputHash
}));
const queuedForMissingSubtarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "followUpAnswer",
  targetId: "live-target",
  subtargetId: "removed-follow-up",
  clientRequestId: "recovery-existing-orphaned-follow-up"
}, () => ({
  inputVersion: 1,
  subtargetVersion: 1,
  inputHash: recoveryIntent.inputHash
}));
const queuedForLiveSubtarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "followUpAnswer",
  targetId: "live-target",
  subtargetId: "live-follow-up",
  clientRequestId: "recovery-live-follow-up"
}, () => ({
  inputVersion: 1,
  subtargetVersion: 1,
  inputHash: recoveryIntent.inputHash
}));
const runningForMissingTarget = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "thoughtAnswer",
  targetId: "removed-target",
  clientRequestId: "recovery-interrupted-orphaned-task"
}, () => ({
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: recoveryIntent.inputHash
}));
recoveryLifecycle.claim(recoveryStore.aiTasks, runningForMissingTarget.task.id);
assert.equal(queuedForMissingTarget.task.status, "queued");
assert.equal(queuedForMissingSubtarget.task.status, "queued");
assert.equal(queuedForLiveSubtarget.task.status, "queued");
assert.equal(runningForMissingTarget.task.status, "running");

const generatedTargetTasks = [
  ["thoughtDraft", "legacy-draft:request-draft", {
    question: "Draft question",
    idea: "",
    binding: { requestId: "request-draft", targetId: "", inputVersion: 0 }
  }],
  ["thoughtPrompt", "request-prompt", {
    occurredOn: "2026-10-10",
    binding: { requestId: "request-prompt", targetId: "", inputVersion: 0 }
  }],
  ["journalAssist", "request-journal", {
    mode: "lead",
    occurredOn: "2026-10-10",
    title: "",
    content: "",
    binding: { requestId: "request-journal", targetId: "", inputVersion: 0 }
  }],
  ["chat", "", {
    message: "A chat request",
    occurredAt: "2026-10-10T00:00:00.000Z",
    occurredOn: "2026-10-10",
    eventTimeHash: "event-time-hash"
  }],
  ["analysis", "", { reason: "manual" }]
].map(([kind, targetId, payload], index) => recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind,
  targetId,
  payload,
  clientRequestId: `recovery-generated-target-${index + 1}`
}, () => null, { deferTargetInspection: true, requestedIntent: recoveryIntent }));

const historicalCompressionTask = {
  id: "recovery-historical-compression",
  kind: "recordCompression",
  resourceType: "recordCompression",
  targetId: "hus-generated-output",
  subtargetId: "",
  status: "queued",
  payload: { operation: "historicalSupplement" },
  internal: true,
  createdAt: now(),
  updatedAt: now(),
  attempt: 0
};
const dailyCompressionTask = {
  id: "recovery-daily-compression",
  kind: "recordCompression",
  resourceType: "recordCompression",
  targetId: "daily-target",
  subtargetId: "",
  status: "queued",
  payload: { operation: "daily" },
  internal: true,
  createdAt: now(),
  updatedAt: now(),
  attempt: 0
};
const onboardingTask = recoveryLifecycle.create(recoveryStore.aiTasks, {
  kind: "onboardingClaimExtraction",
  targetId: "onboardingV2",
  clientRequestId: "recovery-onboarding"
}, () => recoveryIntent).task;
const runningInternalForMissingTarget = {
  id: "recovery-interrupted-internal-task",
  kind: "perceptionExtraction",
  resourceType: "userClaim",
  targetId: "missing-internal-target",
  subtargetId: "",
  status: "running",
  payload: {},
  internal: true,
  createdAt: now(),
  updatedAt: now(),
  attempt: 1
};
recoveryStore.aiTasks.push(
  historicalCompressionTask,
  dailyCompressionTask,
  runningInternalForMissingTarget
);
assert.ok(generatedTargetTasks.every(result => result.task.status === "waiting_for_user_model"),
  "request-based generation tasks stay behind the core-model gate");

const recoveryScheduled = [];
const recoveryRepository = {
  async read() {
    return clone(recoveryStore);
  },
  async update(mutate) {
    const draft = clone(recoveryStore);
    const result = await mutate(draft);
    mapStoreObjects("account-a", draft);
    Object.assign(recoveryStore, draft);
    return clone(result);
  }
};
const recoveryBackground = createBackgroundAi({
  repository: recoveryRepository,
  tasks: recoveryLifecycle,
  notifications: {
    upsertTask(items, task, status, message) {
      items.push({ id: `notification-${task.id}-${status}`, taskId: task.id, status, message });
    }
  },
  targets: {
    inspectIntent(_current, task) {
      return {
        inputVersion: task.requestedIntentInputVersion,
        subtargetVersion: task.requestedIntentSubtargetVersion,
        inputHash: task.requestedIntentInputHash
      };
    },
    prepare(_current, task) {
      return {
        kind: task.kind,
        targetId: task.targetId,
        inputVersion: 1,
        subtargetVersion: 0,
        inputHash: recoveryIntent.inputHash
      };
    },
    stale() {}
  },
  shouldWaitForModel: current => !current.coreReady,
  generate: async () => {
    throw new Error("Startup recovery must not call an AI provider");
  },
  dispatch: callback => recoveryScheduled.push(callback),
  contextKey: () => "account-a",
  onError: error => { throw error; }
});

recoveryStore.coreReady = true;
await recoveryBackground.resume();
assert.equal(recoveryStore.aiTasks.find(task => task.id === waitingForMissingTarget.task.id).status, "stale",
  "startup recovery terminalizes a waiting task whose required persistence target is missing");
assert.equal(recoveryStore.aiTasks.find(task => task.id === waitingForLiveTarget.task.id).status, "queued",
  "startup recovery promotes a waiting task whose required target is present");
assert.equal(recoveryStore.aiTasks.find(task => task.id === queuedForLiveTarget.task.id).status, "queued",
  "startup recovery preserves an existing queued task with a valid target");
assert.equal(recoveryStore.aiTasks.find(task => task.id === queuedForMissingTarget.task.id).status, "stale",
  "startup recovery terminalizes an existing queued task whose required persistence target is missing");
assert.equal(recoveryStore.aiTasks.find(task => task.id === queuedForMissingSubtarget.task.id).status, "stale",
  "startup recovery terminalizes an existing queued task whose required subtarget is missing");
assert.equal(recoveryStore.aiTasks.find(task => task.id === runningForMissingTarget.task.id).status, "failed",
  "startup recovery marks an interrupted task failed without retrying its missing target");
assert.equal(recoveryStore.aiTasks.find(task => task.id === runningInternalForMissingTarget.id).status, "failed",
  "startup recovery leaves a missing-target internal task failed");
assert.equal(recoveryStore.aiTasks.some(task => task.retryOf === runningInternalForMissingTarget.id), false,
  "startup recovery does not retry an interrupted internal task whose required target is missing");
assert.ok(generatedTargetTasks.every(result => (
  recoveryStore.aiTasks.find(task => task.id === result.task.id).status === "queued"
)), "target-generating tasks promote without requiring their future result entity");
assert.equal(recoveryStore.aiTasks.length, 16, "recovery preserves every original task record");
assert.ok(recoveryStore.notifications.some(item => item.taskId === waitingForMissingTarget.task.id
  && item.status === "stale"), "terminalizing an orphan records its notification");
assert.ok(recoveryStore.notifications.some(item => item.taskId === queuedForMissingTarget.task.id
  && item.status === "stale"), "terminalizing a queued orphan records its notification");
assert.ok(recoveryStore.notifications.some(item => item.taskId === queuedForMissingSubtarget.task.id
  && item.status === "stale"), "terminalizing a missing subtarget records its notification");
assert.equal(recoveryScheduled.length, 11,
  "startup recovery schedules valid queued, promoted, and output-generating tasks");
const recoveryFollowUpNotification = {
  id: "recovery-live-follow-up-notification",
  taskId: queuedForLiveSubtarget.task.id,
  kind: "aiTask",
  resourceType: "thought",
  targetId: "live-target",
  subtargetId: "live-follow-up",
  createdAt: now(),
  readAt: ""
};
recoveryStore.notifications.push(recoveryFollowUpNotification);
const recoveryMapping = mapStoreObjects("account-a", recoveryStore);
const activeTaskKeys = new Set(recoveryMapping.objects
  .filter(item => item.collection === "aiTasks" && ["queued", "running"].includes(item.status))
  .map(item => item.objectKey));
const activeTaskKindsByKey = new Map(recoveryMapping.objects
  .filter(item => item.collection === "aiTasks" && ["queued", "running"].includes(item.status))
  .map(item => [item.objectKey, item.payload?.kind]));
assert.equal(recoveryMapping.relations.some(relation => (
  activeTaskKeys.has(relation.objectKey)
  && relation.relation === "target"
  && relation.targetKey === null
  && !["thoughtDraft", "thoughtPrompt", "journalAssist", "chat", "analysis"]
    .includes(activeTaskKindsByKey.get(relation.objectKey))
  && !(activeTaskKindsByKey.get(relation.objectKey) === "recordCompression"
    && recoveryStore.aiTasks.find(task => (
      JSON.stringify(["aiTasks", task.id]) === relation.objectKey
    ))?.payload?.operation === "historicalSupplement")
)), false, "entity-dependent active tasks keep their required target links");
for (const result of generatedTargetTasks) {
  const task = recoveryStore.aiTasks.find(item => item.id === result.task.id);
  const mapped = recoveryMapping.objects.find(item => item.collection === "aiTasks" && item.id === task.id);
  const relation = recoveryMapping.relations.find(item => item.objectKey === mapped.objectKey && item.relation === "target");
  assert.equal(relation?.targetKey || null, null,
    `${task.kind} records an unresolved historical target without failing persistence`);
}
const dailyTask = recoveryStore.aiTasks.find(task => task.id === dailyCompressionTask.id);
const dailyMapped = recoveryMapping.objects.find(item => item.collection === "aiTasks" && item.id === dailyTask.id);
assert.ok(recoveryMapping.relations.some(relation => relation.objectKey === dailyMapped.objectKey
  && relation.relation === "target" && relation.targetKey),
"daily compression continues to resolve its pre-created record target");
const mappedOnboardingTask = recoveryMapping.objects.find(item => (
  item.collection === "aiTasks" && item.id === onboardingTask.id
));
assert.ok(recoveryMapping.relations.some(relation => relation.objectKey === mappedOnboardingTask.objectKey
  && relation.relation === "target" && relation.targetKey),
"onboarding extraction continues to resolve its singleton target");
const mappedFollowUpNotification = recoveryMapping.objects.find(item => (
  item.collection === "notifications" && item.id === "recovery-live-follow-up-notification"
));
assert.ok(recoveryMapping.relations.some(relation => (
  relation.objectKey === mappedFollowUpNotification.objectKey
  && relation.relation === "subtarget"
  && relation.targetKey === JSON.stringify(["thoughts", "live-target", "followUps", "live-follow-up"])
)), "follow-up notifications retain their resolved nested follow-up relation");
const mappingWithoutFollowUpTask = mapStoreObjects("account-a", {
  ...recoveryStore,
  aiTasks: recoveryStore.aiTasks.filter(task => task.id !== queuedForLiveSubtarget.task.id),
  notifications: [recoveryFollowUpNotification]
});
const notificationWithoutSourceTask = mappingWithoutFollowUpTask.objects.find(item => (
  item.collection === "notifications" && item.id === recoveryFollowUpNotification.id
));
assert.ok(mappingWithoutFollowUpTask.relations.some(relation => (
  relation.objectKey === notificationWithoutSourceTask.objectKey
  && relation.relation === "subtarget"
  && relation.targetKey === JSON.stringify(["thoughts", "live-target", "followUps", "live-follow-up"])
)), "follow-up notifications retain their nested target when the source task is absent");
assert.throws(() => mapStoreObjects("account-a", {
  ...recoveryStore,
  recordCompressions: [],
  aiTasks: [{ ...dailyCompressionTask, id: "missing-daily-target-task", targetId: "missing-daily-target" }]
}), /Unresolved target reference/, "daily compression still requires its prepared record target");
assert.throws(() => mapStoreObjects("account-a", {
  ...recoveryStore,
  onboardingV2: null,
  aiTasks: [{ ...onboardingTask, id: "missing-onboarding-target-task", status: "queued" }]
}), /Unresolved target reference/, "onboarding extraction still requires its singleton target");
const boundGeneratedTask = {
  ...generatedTargetTasks[0].task,
  id: "recovery-bound-generated-task",
  targetId: "live-target",
  status: "queued"
};
const boundGeneratedMapping = mapStoreObjects("account-a", {
  ...recoveryStore,
  aiTasks: [...recoveryStore.aiTasks, boundGeneratedTask]
});
const boundGeneratedObject = boundGeneratedMapping.objects.find(item => (
  item.collection === "aiTasks" && item.id === boundGeneratedTask.id
));
assert.ok(boundGeneratedMapping.relations.some(relation => (
  relation.objectKey === boundGeneratedObject.objectKey
  && relation.relation === "target"
  && relation.targetKey
)), "a generated-task target relation resolves when its referenced entity exists");

console.log("Background AI model-gate checks passed: deferred context preparation, cancellable and restart-safe waiting, fresh promotion, one-time scheduling, target-safe recovery, and injected bypass policy.");
