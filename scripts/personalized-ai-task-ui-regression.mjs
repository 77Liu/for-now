import assert from "node:assert/strict";
import {
  resolvePersonalizedAiResponse,
  resolveSynchronousPersonalizedResponse
} from "../public/generated/personalized-ai-task.mjs";
import { createPersonalizedTaskRuntime } from "../public/frontend/app/runtime/personalized-task-runtime.mjs";
import { createAnswerModalRuntime } from "../public/frontend/app/runtime/answer-modal-runtime.mjs";
import { installRecordSubmissionEvents } from "../public/frontend/app/runtime/record-events.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const syncResponse = { data: { id: "chat-saved", answer: "同步回答" }, meta: {} };
const synchronous = await resolvePersonalizedAiResponse(syncResponse, {
  request: async () => assert.fail("synchronous responses must not poll")
});
assert.deepEqual(synchronous, {
  asynchronous: false,
  task: null,
  result: syncResponse.data
});
const task = {
  id: "task-1",
  kind: "thoughtDraft",
  targetId: "draft-1",
  status: "waiting_for_user_model"
};
assert.throws(
  () => resolveSynchronousPersonalizedResponse({ data: task }),
  error => error.taskId === task.id && /无法跟踪进度/.test(error.message),
  "an older UI descriptor must never treat a 202 task envelope as a completed result"
);
const states = [
  { ...task, status: "running" },
  { ...task, status: "succeeded", resultId: "task-1" }
];
const completedTask = states[1];
const requests = [];
const statuses = [];
const tracked = [];
const result = {
  requestId: "request-1",
  targetId: "draft-1",
  inputVersion: 7,
  draft: "生成草稿"
};
const settled = await resolvePersonalizedAiResponse({ data: task }, {
  request: async url => {
    requests.push(url);
    if (url.endsWith("/result")) return { task: completedTask, result };
    return states.shift();
  },
  onTask: value => tracked.push(value.status),
  onStatus: message => statuses.push(message),
  sleep: async () => {}
});
assert.deepEqual(requests, [
  "/api/ai-tasks/task-1",
  "/api/ai-tasks/task-1",
  "/api/ai-tasks/task-1/result"
]);
assert.deepEqual(tracked, ["waiting_for_user_model", "running", "succeeded"]);
assert.match(statuses[0], /等待核心用户模型/);
assert.deepEqual(settled, { asynchronous: true, task: completedTask, result });

const runtimeTasks = [];
const published = [];
let notificationPolls = 0;
const resolveRuntimeTask = createPersonalizedTaskRuntime({
  runtime: { currentUser: { id: "owner-a" } },
  request: async url => url.endsWith("/result")
    ? { result: { prompt: "完成的引子" } }
    : { ...task, id: "task-runtime", kind: "thoughtPrompt", status: "succeeded" },
  getSessionSerial: () => 1,
  getTasks: () => runtimeTasks,
  setTasks: tasks => runtimeTasks.splice(0, runtimeTasks.length, ...tasks),
  publish: domains => published.push([...domains]),
  scheduleNotificationPoll: () => { notificationPolls += 1 }
});
const runtimeResolved = await resolveRuntimeTask({
  ...task,
  id: "task-runtime",
  kind: "thoughtPrompt",
  status: "queued"
}, { sleep: async () => {}, expectedKind: "thoughtPrompt" });
assert.deepEqual(runtimeResolved.result, { prompt: "完成的引子" });
assert.equal(runtimeTasks[0].id, "task-runtime");
assert.equal(runtimeTasks[0].status, "succeeded");
assert.equal(notificationPolls, 2);
assert.deepEqual(published, [["aiTasks"], ["aiTasks"]]);

await assert.rejects(
  resolvePersonalizedAiResponse({
    id: "task-failed",
    kind: "journalAssist",
    status: "failed",
    error: "模型暂时不可用"
  }, { request: async () => assert.fail("terminal failure must not poll") }),
  error => error.taskId === "task-failed"
    && error.taskStatus === "failed"
    && error.message.includes("任务失败，请查看通知中的脱敏错误日志后重试")
    && !error.message.includes("模型暂时不可用")
);

let polledAfterSessionChange = false;
const abandoned = await resolvePersonalizedAiResponse({
  id: "task-session-change",
  kind: "chat",
  status: "queued"
}, {
  request: async () => {
    polledAfterSessionChange = true;
    return assert.fail("a previous account session must not be polled");
  },
  isSessionCurrent: () => false,
  sleep: async () => {}
});
assert.equal(abandoned.abandoned, true);
assert.equal(polledAfterSessionChange, false);

let transientReads = 0;
const recovered = await resolvePersonalizedAiResponse({
  id: "task-recovered",
  kind: "analysis",
  status: "queued"
}, {
  request: async url => {
    if (url.endsWith("/result")) return { result: { id: "analysis-1" } };
    transientReads += 1;
    if (transientReads === 1) {
      throw Object.assign(new Error("网络暂时不可用"), { code: "NETWORK_ERROR", status: 0 });
    }
    return { id: "task-recovered", kind: "analysis", status: "succeeded" };
  },
  sleep: async () => {}
});
assert.equal(transientReads, 2, "a temporary status read failure must retry the durable task");
assert.deepEqual(recovered.result, { id: "analysis-1" });

let resultReads = 0;
const recoveredResult = await resolvePersonalizedAiResponse({
  id: "task-result-recovered",
  kind: "analysis",
  status: "succeeded"
}, {
  request: async () => {
    resultReads += 1;
    if (resultReads === 1) {
      throw Object.assign(new Error("结果暂时不可读"), { code: "NETWORK_ERROR", status: 0 });
    }
    return { result: { id: "analysis-result" } };
  },
  sleep: async () => {}
});
assert.equal(resultReads, 2, "a temporary result read failure must retry without resubmitting work");
assert.deepEqual(recoveredResult.result, { id: "analysis-result" });

let sessionCurrent = true;
let resultRequestedAfterSessionChange = false;
const sessionChangedDuringPoll = await resolvePersonalizedAiResponse({
  id: "task-session-switched",
  kind: "chat",
  status: "queued"
}, {
  request: async url => {
    if (url.endsWith("/result")) {
      resultRequestedAfterSessionChange = true;
      return { result: { message: "旧账号输入" } };
    }
    sessionCurrent = false;
    return { id: "task-session-switched", kind: "chat", status: "succeeded" };
  },
  isSessionCurrent: () => sessionCurrent,
  sleep: async () => {}
});
assert.equal(sessionChangedDuringPoll.abandoned, true);
assert.equal(resultRequestedAfterSessionChange, false);

await assert.rejects(
  resolvePersonalizedAiResponse({
    id: "task-wrong-kind",
    kind: "chat",
    status: "queued"
  }, {
    request: async () => assert.fail("mismatched task kinds must not be polled"),
    expectedKind: "analysis",
    operationLabel: "认知复盘"
  }),
  /不匹配的任务类型/
);

const modal = { hidden: true, dataset: { busy: "false" } };
const modalOutput = { hidden: true };
const modalStatus = { className: "", textContent: "" };
const modalResult = { innerHTML: "", scrollIntoView() {} };
const modalNodes = {
  "#ai-answer-modal": modal,
  "#ai-answer-output": modalOutput,
  "#ai-answer-status": modalStatus,
  "#ai-answer-result": modalResult,
  "#ai-answer-title": { textContent: "" }
};
const oldRequest = deferred();
const newRequest = deferred();
const modalRuntime = createAnswerModalRuntime({
  $: selector => modalNodes[selector],
  $$: () => [],
  renderMarkdown: value => value,
  renderLatex() {},
  showToast() {},
  requestFrame(callback) {
    callback();
    return 1;
  },
  cancelFrame() {},
  resolvePersonalizedTask: async response => response === "old"
    ? { abandoned: true }
    : { result: { answer: "新任务回答" } }
});
const oldModalRun = modalRuntime.run({
  title: "旧账号回答",
  requestCall: () => oldRequest.promise,
  isSessionCurrent: () => false
});
await Promise.resolve();
const newModalRun = modalRuntime.run({
  title: "新账号回答",
  requestCall: () => newRequest.promise,
  isSessionCurrent: () => true
});
await Promise.resolve();
oldRequest.resolve("old");
await oldModalRun;
assert.equal(modal.hidden, false, "an abandoned old task must not hide the newer answer modal");
assert.equal(modal.dataset.busy, "true", "an abandoned old task must not clear the newer task busy state");
newRequest.resolve("new");
await newModalRun;
assert.equal(modal.hidden, false);
assert.equal(modal.dataset.busy, "false");

const chatForm = {
  dataset: {},
  querySelector: () => chatButton,
  addEventListener(type, listener) {
    if (type === "submit") chatSubmit = listener;
  }
};
const chatButton = { disabled: false };
let chatSubmit = null;
let networkFailureNext = false;
const chatRequests = [];
const elements = new Map();
const element = selector => {
  if (selector === "#chat-form") return chatForm;
  if (selector === "#chat-datetime") return {};
  if (selector === "#chat-input") return { value: "新的聊天输入" };
  if (selector === "#chat-status") return { textContent: "" };
  if (!elements.has(selector)) {
    elements.set(selector, {
      addEventListener() {},
      dataset: {},
      querySelector() { return chatButton; }
    });
  }
  return elements.get(selector);
};
installRecordSubmissionEvents({
  runtime: { currentUser: { id: "owner-a" }, sessionSerial: 1 },
  $: element,
  requestV1: async (_url, options) => {
    chatRequests.push(options.headers["idempotency-key"]);
    if (networkFailureNext) {
      networkFailureNext = false;
      throw Object.assign(new Error("网络暂时不可用"), { code: "NETWORK_ERROR", status: 0 });
    }
    return { id: "chat-task", kind: "chat", status: "failed", error: "任务失败" };
  },
  resolvePersonalizedTask: async () => {
    throw Object.assign(new Error("任务失败"), { taskId: "chat-task", taskStatus: "failed" });
  },
  occurrenceFields: () => ({ occurredAt: "2026-10-10T12:00:00.000Z", occurredOn: "2026-10-10" }),
  resetOccurrenceInput() {},
  refreshState: async () => {},
  showToast() {}
});
const submitChat = () => chatSubmit({ preventDefault() {}, currentTarget: chatForm });
await submitChat();
const failedRequestId = chatRequests.at(-1);
assert.equal(chatForm.dataset.requestId, undefined,
  "a terminal failed task clears its idempotency key before a new attempt");
await submitChat();
assert.notEqual(chatRequests.at(-1), failedRequestId,
  "a retry after task failure gets a fresh idempotency key");
networkFailureNext = true;
await submitChat();
const uncertainRequestId = chatRequests.at(-1);
assert.equal(chatForm.dataset.requestId, uncertainRequestId,
  "an uncertain network failure preserves the key for a safe retry");
await submitChat();
assert.equal(chatRequests.at(-1), uncertainRequestId,
  "retry after an uncertain response reuses the same idempotency key");

const chainButton = { disabled: false, textContent: "保存" };
const chainStatus = { textContent: "" };
const chainQuestion = { value: "保留原始草稿" };
const chainForm = {
  dataset: {},
  elements: { sourceCaptureId: { value: "" }, sourceCaptureVersion: { value: "" } },
  querySelector: () => chainButton,
  addEventListener(type, listener) { if (type === "submit") chainSubmit = listener; }
};
let chainSubmit = null;
const chainRequests = [];
let discardedChainUploads = 0;
const chainElements = new Map();
const chainElement = selector => {
  if (selector === "#thought-prompt-button") return { addEventListener() {} };
  if (selector === "#chain-form") return chainForm;
  if (selector === "#chat-form") return { addEventListener() {} };
  if (selector === "#chain-tags") return { value: "" };
  if (selector === "#chain-answer") return { value: "" };
  if (selector === "#chain-question") return chainQuestion;
  if (selector === "#chain-idea") return { value: "" };
  if (selector === "#chain-datetime") return {};
  if (selector === "#chain-status") return chainStatus;
  if (!chainElements.has(selector)) chainElements.set(selector, { value: "", addEventListener() {} });
  return chainElements.get(selector);
};
const chainRuntime = {
  currentUser: { id: "owner-a" }, sessionSerial: 1, chainDraftVersion: 0,
  draftTags: [], answerDraft: "", answerReasoningDraft: "",
  llmSettings: { automaticAnswers: { thoughtAnswer: false } }
};
installRecordSubmissionEvents({
  runtime: chainRuntime,
  $: chainElement,
  requestV1: async (_url, options) => {
    chainRequests.push(options.headers["idempotency-key"]);
    throw Object.assign(new Error("provider secret and internal stack"), { code: "UNKNOWN_COMMIT" });
  },
  occurrenceFields: () => ({ timeMode: "now" }),
  contentImagePaths: async () => ({ attachmentPaths: ["uploaded:attachment-1"], uploadedPaths: ["uploaded:attachment-1"] }),
  imageRecordPayload: input => ({ content: input.content, attachmentPaths: input.attachmentPaths }),
  captureRecordPayload: payload => payload,
  discardContentImageUploads: async () => { discardedChainUploads += 1; },
  chainRecordKind: () => "thought",
  resetOccurrenceInput() {},
  showToast() {},
  syncChainRecordKind() {}
});
const submitChain = () => chainSubmit({ preventDefault() {}, currentTarget: chainForm });
await submitChain();
const unconfirmedRequestId = chainRequests.at(-1);
assert.equal(chainQuestion.value, "保留原始草稿");
assert.equal(chainForm.dataset.requestId, unconfirmedRequestId,
  "an unconfirmed thought save retains its idempotency key");
assert.match(chainStatus.textContent, /状态尚未确认.*内容仍保留/);
assert.doesNotMatch(chainStatus.textContent, /provider secret|internal stack/);
assert.equal(discardedChainUploads, 0,
  "an unconfirmed thought save must retain uploaded attachments that the server may already reference");
await submitChain();
assert.equal(chainRequests.at(-1), unconfirmedRequestId,
  "retry after an unconfirmed thought save reuses the same idempotency key");

console.log("Personalized AI task UI checks passed: task retries, result recovery, session isolation, modal races and chat idempotency.");
