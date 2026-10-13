import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAiTaskTargets, createBackgroundAi } from "../src/app/index.mjs";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { activeTaskForInput, createTaskLifecycle } from "../src/modules/tasks/index.mjs";

assert.equal(activeTaskForInput([{
  kind: "captureTranscription",
  targetId: "capture-waiting",
  inputHash: "audio-hash",
  status: "waiting_for_user_model"
}], {
  kind: "captureTranscription",
  targetId: "capture-waiting",
  inputHash: "audio-hash"
}), null, "waiting tasks are not runnable active tasks for input de-duplication");

let tick = 0;
const now = () => `2026-10-01T00:00:${String(++tick).padStart(2, "0")}.000Z`;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const audio = {
  attachmentPath: "/attachments/voice.m4a",
  mimeType: "audio/mp4",
  bytes: 4096,
  durationMs: 1250
};
let store = {
  captures: [{
    id: "capture-a",
    content: "",
    audio,
    transcription: {
      status: "unconfigured",
      provider: "",
      rawText: "",
      polishedText: "",
      updatedAt: "",
      errorCode: "ASR_NOT_CONFIGURED"
    },
    version: 1
  }],
  thoughts: [],
  aiTasks: [],
  notifications: []
};
const repository = {
  async read() {
    return structuredClone(store);
  },
  async update(operation) {
    const draft = structuredClone(store);
    const result = await operation(draft);
    store = draft;
    return result;
  }
};
const targets = createAiTaskTargets({
  thoughts: { inspect: () => null },
  annotations: createAnnotationService({ createId: () => crypto.randomUUID(), now }),
  hash,
  now
});
let failNext = false;
const generatedTaskIds = [];
const background = createBackgroundAi({
  repository,
  tasks: createTaskLifecycle({ createId: () => crypto.randomUUID(), now, hash }),
  notifications: createNotificationService({ createId: () => crypto.randomUUID(), now }),
  targets,
  generate: async work => {
    assert.equal(work.kind, "captureTranscription");
    assert.match(work.taskId, /^[0-9a-f-]{36}$/);
    generatedTaskIds.push(work.taskId);
    if (failNext) throw Object.assign(new Error("公开失败"), { code: "ASR_PROVIDER_FAILED" });
    assert.deepEqual(work.audio, audio);
    if (work.capture.id === "capture-condense-failed") {
      return {
        provider: "volcengine-seedasr-2.0",
        rawText: "凝练失败时的原始转写。",
        polishedText: "凝练失败时的整理稿。",
        condensedText: "",
        condenseErrorCode: "CONDENSE_UPSTREAM_FAILED",
        updatedAt: now()
      };
    }
    return {
      provider: "volcengine-seedasr-2.0",
      rawText: "这是原始转写。",
      polishedText: "这是整理后的转写。",
      condensedText: "这是凝练稿。",
      condenseErrorCode: "",
      updatedAt: now()
    };
  },
  dispatch: () => {},
  contextKey: () => "account-a",
  onError: () => {}
});

const first = await background.enqueue({
  kind: "captureTranscription",
  targetId: "capture-a",
  clientRequestId: "transcription-a"
});
assert.equal(first.task.status, "queued");
assert.equal(store.captures[0].transcription.status, "queued");
const concurrentDuplicate = await background.enqueue({
  kind: "captureTranscription",
  targetId: "capture-a",
  clientRequestId: "transcription-a-concurrent"
});
assert.equal(concurrentDuplicate.duplicate, true);
assert.equal(concurrentDuplicate.task.id, first.task.id);
assert.equal(store.aiTasks.filter(task => task.targetId === "capture-a").length, 1);
store.captures[0].title = "转写期间的用户标题";
store.captures[0].content = "转写期间修改了文字，但语音原件未变化";
store.captures[0].version = 2;
await background.run(first.task.id);
assert.deepEqual(generatedTaskIds, [first.task.id]);
assert.equal(store.aiTasks[0].status, "succeeded");
assert.equal(store.captures[0].transcription.status, "ready");
assert.equal(store.captures[0].title, "转写期间的用户标题");
assert.equal(store.captures[0].transcription.rawText, "这是原始转写。");
assert.equal(store.captures[0].transcription.polishedText, "这是整理后的转写。");
assert.equal(store.captures[0].transcription.condensedText, "这是凝练稿。");
assert.equal(store.captures[0].transcription.condenseErrorCode, "");
assert.equal(store.captures[0].version, 3);
assert.equal((await background.getResult(first.task.id)).result.id, "capture-a");

store.captures.unshift({
  id: "capture-condense-failed",
  content: "",
  audio,
  transcription: {
    status: "unconfigured",
    provider: "",
    rawText: "",
    polishedText: "",
    condensedText: "",
    updatedAt: "",
    errorCode: "ASR_NOT_CONFIGURED",
    condenseErrorCode: ""
  },
  version: 1
});
const partial = await background.enqueue({
  kind: "captureTranscription",
  targetId: "capture-condense-failed",
  clientRequestId: "transcription-condense-failed"
});
await background.run(partial.task.id);
const partiallyReady = store.captures.find(item => item.id === "capture-condense-failed");
assert.equal(partiallyReady.transcription.status, "ready");
assert.equal(partiallyReady.transcription.rawText, "凝练失败时的原始转写。");
assert.equal(partiallyReady.transcription.polishedText, "凝练失败时的整理稿。");
assert.equal(partiallyReady.transcription.condensedText, "");
assert.equal(partiallyReady.transcription.condenseErrorCode, "CONDENSE_UPSTREAM_FAILED");

store.captures.unshift({
  id: "capture-b",
  content: "",
  audio: { ...audio, attachmentPath: "/attachments/second.m4a" },
  transcription: {
    status: "unconfigured",
    provider: "",
    rawText: "",
    polishedText: "",
    updatedAt: "",
    errorCode: "ASR_NOT_CONFIGURED"
  },
  version: 1
});
failNext = true;
const second = await background.enqueue({
  kind: "captureTranscription",
  targetId: "capture-b",
  clientRequestId: "transcription-b"
});
await background.run(second.task.id);
assert.equal(store.aiTasks.find(task => task.id === second.task.id).status, "failed");
assert.equal(store.captures.find(item => item.id === "capture-b").transcription.status, "failed");
assert.equal(store.captures.find(item => item.id === "capture-b").transcription.errorCode, "ASR_PROVIDER_FAILED");
assert.equal(store.captures.find(item => item.id === "capture-b").transcription.condensedText, "");

store.captures.unshift({
  id: "capture-c",
  content: "",
  audio: { ...audio, attachmentPath: "/attachments/third.m4a" },
  transcription: {
    status: "transcribing",
    provider: "volcengine-seedasr-2.0",
    rawText: "",
    polishedText: "",
    updatedAt: "",
    errorCode: ""
  },
  version: 1
});
store.aiTasks.unshift({
  id: "interrupted-task",
  kind: "captureTranscription",
  resourceType: "capture",
  targetId: "capture-c",
  inputVersion: 0,
  inputHash: hash(JSON.stringify({
    targetId: "capture-c",
    audio: store.captures[0].audio
  })),
  payload: {},
  clientRequestId: "transcription-c",
  requestHash: "request-c",
  status: "running",
  createdAt: now(),
  updatedAt: now(),
  attempt: 1
});
await background.resume();
assert.equal(store.aiTasks.find(task => task.id === "interrupted-task").status, "failed");
assert.equal(store.captures.find(item => item.id === "capture-c").transcription.status, "failed");
assert.equal(store.captures.find(item => item.id === "capture-c").transcription.errorCode, "TASK_INTERRUPTED");
assert.equal(store.captures.find(item => item.id === "capture-c").transcription.condenseErrorCode, "");

store.captures.unshift({
  id: "capture-d",
  content: "",
  audio: { ...audio, attachmentPath: "/attachments/fourth-old.m4a" },
  transcription: {
    status: "unconfigured",
    provider: "",
    rawText: "",
    polishedText: "",
    updatedAt: "",
    errorCode: "ASR_NOT_CONFIGURED"
  },
  version: 1
});
const stale = await background.enqueue({
  kind: "captureTranscription",
  targetId: "capture-d",
  clientRequestId: "transcription-d-old"
});
const changedCapture = store.captures.find(item => item.id === "capture-d");
changedCapture.audio = { ...audio, attachmentPath: "/attachments/fourth-new.m4a" };
changedCapture.transcription = {
  status: "unconfigured",
  provider: "",
  rawText: "",
  polishedText: "",
  updatedAt: "",
  errorCode: "ASR_NOT_CONFIGURED"
};
changedCapture.version = 2;
const nextInputHash = hash(JSON.stringify({ targetId: "capture-d", audio: changedCapture.audio }));
assert.equal(activeTaskForInput(store.aiTasks, {
  kind: "captureTranscription",
  targetId: "capture-d",
  inputHash: nextInputHash
}), null);
await background.run(stale.task.id);
assert.equal(store.aiTasks.find(task => task.id === stale.task.id).status, "stale");
assert.equal(store.captures.find(item => item.id === "capture-d").transcription.status, "unconfigured");

const captureWithDerivative = store.captures.find(item => item.id === "capture-a");
captureWithDerivative.audio = {
  ...captureWithDerivative.audio,
  asrAttachmentPath: "/attachments/voice.asr.wav",
  asrMimeType: "audio/wav",
  asrBytes: 40044
};
const derivativeWork = targets.prepare(store, { id: "derived-task", kind: "captureTranscription", targetId: "capture-a" });
assert.equal(derivativeWork.audio.asrAttachmentPath, "/attachments/voice.asr.wav");
assert.equal(derivativeWork.inputHash, hash(JSON.stringify({ targetId: "capture-a", audio })));

console.log("Capture transcription checks passed: active-input deduplication, task-scoped generation, durable result save, failure projection, interrupted-task recovery and stale-audio isolation.");
