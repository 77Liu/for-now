import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createBackgroundAi } from "../src/app/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const clone = value => structuredClone(value);
let id = 0;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)).toISOString();
let store = {
  coreReady: false,
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
store.coreReady = true;
assert.equal(await background.releaseWaiting(), 1);
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).status, "queued");
assert.equal(store.aiTasks.find(task => task.id === freshWaiting.task.id).inputVersion, 2);
assert.equal(prepareCalls, 1);
assert.equal(scheduled.length, 1);
assert.equal(await background.releaseWaiting(), 0);
assert.equal(scheduled.length, 1, "repeated release does not schedule the same task twice");

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

console.log("Background AI model-gate checks passed: deferred context preparation, cancellable and restart-safe waiting, fresh promotion, one-time scheduling, and injected bypass policy.");
