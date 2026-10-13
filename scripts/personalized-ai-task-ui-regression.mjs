import { installChatSubmission } from "../public/generated/app/runtime/chat-submission.mjs";
import assert from "node:assert/strict";
import {
  enqueueThoughtAnswer,
  thoughtAnswerTaskMessage,
  thoughtAnswerTaskStatusKind,
  resolvePersonalizedAiResponse,
  resolveSynchronousPersonalizedResponse,
  THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE,
  THOUGHT_ANSWER_REJECTED_MESSAGE,
  THOUGHT_ANSWER_UNKNOWN_MESSAGE
} from "../public/generated/personalized-ai-task.mjs";
import { createPersonalizedTaskRuntime } from "../public/frontend/app/runtime/personalized-task-runtime.mjs";
import { createAnswerModalRuntime } from "../public/frontend/app/runtime/answer-modal-runtime.mjs";
import { installRecordSubmissionEvents } from "../public/frontend/app/runtime/record-events.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function createSessionStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    values
  };
}

const attemptStorage = createSessionStorage();
let requestIdSerial = 0;
const attemptRequestBodies = [];
const thoughtAnswerRequestOptions = {
  ownerId: "owner-thought-answer",
  targetId: "question-uncertain",
  inputVersion: 4,
  createRequestId: () => `thought-answer-${++requestIdSerial}`,
  storage: attemptStorage
};
const uncertainEnqueue = await enqueueThoughtAnswer({
  ...thoughtAnswerRequestOptions,
  request: async (_path, options) => {
    attemptRequestBodies.push(options.body);
    throw Object.assign(new Error("secret network detail"), {
      code: "NETWORK_ERROR",
      status: 0
    });
  }
});
assert.deepEqual(uncertainEnqueue, { kind: "unknown" });
assert.equal(THOUGHT_ANSWER_UNKNOWN_MESSAGE.includes("secret network detail"), false);
const persistedAttempt = [...attemptStorage.values.values()].join("");
assert.match(persistedAttempt, /question-uncertain/);
assert.match(persistedAttempt, /thought-answer-1/);
assert.doesNotMatch(persistedAttempt, /thought text|secret network detail/i,
  "only account, target, version and request ID metadata may be retained");

let refreshedAfterQueue = false;
const recoveredEnqueue = await enqueueThoughtAnswer({
  ...thoughtAnswerRequestOptions,
  request: async (_path, options) => {
    attemptRequestBodies.push(options.body);
    return {
      id: "task-uncertain-recovered",
      kind: "thoughtAnswer",
      targetId: "question-uncertain",
      inputVersion: 4,
      status: "queued"
    };
  },
  refreshNotifications: async () => {
    refreshedAfterQueue = true;
    throw new Error("secret notification detail");
  }
});
assert.equal(attemptRequestBodies[0], attemptRequestBodies[1],
  "an uncertain POST is confirmed with the exact same payload and clientRequestId");
assert.equal(attemptRequestBodies[1], JSON.stringify({
  kind: "thoughtAnswer",
  targetId: "question-uncertain",
  inputVersion: 4,
  clientRequestId: "thought-answer-1"
}), "recovered requests send only the four validated contract fields in their stable order");
assert.equal(recoveredEnqueue.kind, "queued");
assert.equal(recoveredEnqueue.kind === "queued" && recoveredEnqueue.task.id, "task-uncertain-recovered");
assert.equal(recoveredEnqueue.kind === "queued" && recoveredEnqueue.notificationsRefreshed, false,
  "notification refresh failure does not turn an accepted task into an enqueue failure");
const falseRefresh = await enqueueThoughtAnswer({
  ...thoughtAnswerRequestOptions,
  targetId: "question-notification-false",
  createRequestId: () => "notification-false-check",
  request: async () => ({ id: "registered-notification-false", kind: "thoughtAnswer",
    targetId: "question-notification-false", inputVersion: 4, status: "queued" }),
  refreshNotifications: async () => false
});
assert.equal(falseRefresh.kind, "queued");
assert.equal(falseRefresh.notificationsRefreshed, false, "返回false的真实读取不能被谎报为成功");
assert.equal(refreshedAfterQueue, true);
assert.equal(THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE.includes("secret"), false);
assert.equal(attemptStorage.values.size, 0, "a confirmed task clears its pending attempt metadata");

let subsequentRequestId = "";
const explicitRetry = await enqueueThoughtAnswer({
  ...thoughtAnswerRequestOptions,
  request: async (_path, options) => {
    subsequentRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("private server detail"), { status: 409, code: "VERSION_CONFLICT" });
  }
});
assert.deepEqual(explicitRetry, { kind: "rejected" });
assert.equal(subsequentRequestId, "thought-answer-2",
  "a confirmed task clears the old attempt so a deliberate later request receives a fresh key");
assert.equal(THOUGHT_ANSWER_REJECTED_MESSAGE.includes("private server detail"), false);
assert.equal(attemptStorage.values.size, 0, "an explicit HTTP rejection clears its attempt metadata");

let readFailureRequestSerial = 0;
const readFailureBodies = [];
const readFailureStorage = {
  getItem() {
    throw new Error("storage read denied");
  },
  setItem() {},
  removeItem() {}
};
const readFailureOptions = {
  ownerId: "owner-storage-read-failure",
  targetId: "question-storage-read-failure",
  inputVersion: 1,
  storage: readFailureStorage,
  createRequestId: () => `read-failure-${++readFailureRequestSerial}`
};
await enqueueThoughtAnswer({
  ...readFailureOptions,
  request: async (_path, options) => {
    readFailureBodies.push(options.body);
    throw Object.assign(new Error("rejected"), { status: 409 });
  }
});
await enqueueThoughtAnswer({
  ...readFailureOptions,
  request: async (_path, options) => {
    readFailureBodies.push(options.body);
    throw Object.assign(new Error("uncertain"), { status: 0 });
  }
});
assert.equal(JSON.parse(readFailureBodies[0]).clientRequestId, "read-failure-1");
assert.equal(JSON.parse(readFailureBodies[1]).clientRequestId, "read-failure-2",
  "a failed storage read still marks an explicitly rejected attempt resolved in memory");

const waitingThoughtAnswer = {
  id: "task-waiting-model",
  kind: "thoughtAnswer",
  targetId: "question-waiting-model",
  inputVersion: 1,
  status: "waiting_for_user_model"
};
const succeededThoughtAnswer = {
  ...waitingThoughtAnswer,
  id: "task-succeeded",
  status: "succeeded"
};
assert.match(thoughtAnswerTaskMessage(waitingThoughtAnswer), /等待核心用户模型就绪/);
assert.match(thoughtAnswerTaskMessage(succeededThoughtAnswer), /回答已完成/);
assert.match(thoughtAnswerTaskMessage({ ...succeededThoughtAnswer, status: "unknown" }), /状态暂不可识别/);
assert.equal(thoughtAnswerTaskStatusKind(waitingThoughtAnswer), "working");
assert.equal(thoughtAnswerTaskStatusKind(succeededThoughtAnswer), "success");
assert.equal(thoughtAnswerTaskStatusKind({ ...succeededThoughtAnswer, status: "failed" }), "error");
assert.equal(thoughtAnswerTaskStatusKind({ ...succeededThoughtAnswer, status: "unknown" }), "error");

let otherAccountRequestId = "";
const otherAccountEnqueue = await enqueueThoughtAnswer({
  ...thoughtAnswerRequestOptions,
  ownerId: "owner-other",
  request: async (_path, options) => {
    otherAccountRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("connection closed"), { status: 0 });
  }
});
assert.deepEqual(otherAccountEnqueue, { kind: "unknown" });
assert.equal(otherAccountRequestId, "thought-answer-3",
  "pending request identifiers are isolated by account");

const tombstoneValues = new Map();
const tombstoneStorage = {
  getItem(key) { return tombstoneValues.get(key) ?? null; },
  setItem(key, value) { tombstoneValues.set(key, value); },
  removeItem() { throw new Error("storage removal unavailable"); }
};
let tombstoneRequestSerial = 0;
const tombstoneOptions = {
  ownerId: "owner-tombstone",
  targetId: "question-tombstone",
  inputVersion: 2,
  storage: tombstoneStorage,
  createRequestId: () => `tombstone-${++tombstoneRequestSerial}`
};
await enqueueThoughtAnswer({
  ...tombstoneOptions,
  request: async () => { throw Object.assign(new Error("offline"), { status: 0 }); }
});
await enqueueThoughtAnswer({
  ...tombstoneOptions,
  request: async () => ({
    id: "task-tombstone",
    kind: "thoughtAnswer",
    targetId: "question-tombstone",
    inputVersion: 2,
    status: "queued"
  })
});
let requestAfterTombstone = "";
await enqueueThoughtAnswer({
  ...tombstoneOptions,
  request: async (_path, options) => {
    requestAfterTombstone = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("offline"), { status: 0 });
  }
});
assert.equal(requestAfterTombstone, "tombstone-2",
  "a failed session-storage removal leaves a tombstone that prevents reuse of a resolved key");

const concurrentStorage = createSessionStorage();
let concurrentRequestSerial = 0;
let concurrentRequestIndex = 0;
const concurrentBodies = [];
const concurrentResponses = [deferred(), deferred()];
const concurrentOptions = {
  ownerId: "owner-concurrent",
  targetId: "question-concurrent",
  inputVersion: 6,
  storage: concurrentStorage,
  createRequestId: () => `concurrent-${++concurrentRequestSerial}`
};
const concurrentRequest = (_path, options) => {
  concurrentBodies.push(options.body);
  return concurrentResponses[concurrentRequestIndex++].promise;
};
const concurrentA = enqueueThoughtAnswer({ ...concurrentOptions, request: concurrentRequest });
const concurrentB = enqueueThoughtAnswer({ ...concurrentOptions, request: concurrentRequest });
assert.equal(concurrentBodies[0], concurrentBodies[1],
  "simultaneous entry points share one pending request key");
concurrentResponses[0].resolve({
  id: "task-concurrent-a",
  kind: "thoughtAnswer",
  targetId: "question-concurrent",
  inputVersion: 6,
  status: "queued"
});
await concurrentA;
const secondGeneration = await enqueueThoughtAnswer({
  ...concurrentOptions,
  request: async (_path, options) => {
    concurrentBodies.push(options.body);
    throw Object.assign(new Error("uncertain key two"), { status: 0 });
  }
});
assert.deepEqual(secondGeneration, { kind: "unknown" });
concurrentResponses[1].resolve({
  id: "task-concurrent-b",
  kind: "thoughtAnswer",
  targetId: "question-concurrent",
  inputVersion: 6,
  status: "queued"
});
await concurrentB;
let retainedRequestId = "";
await enqueueThoughtAnswer({
  ...concurrentOptions,
  request: async (_path, options) => {
    retainedRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("still uncertain"), { status: 0 });
  }
});
assert.equal(retainedRequestId, "concurrent-2",
  "a late duplicate success cannot clear the newer unknown request's idempotency key");

const readOnlyRecord = JSON.stringify({
  kind: "thoughtAnswer",
  targetId: "question-read-only",
  inputVersion: 3,
  clientRequestId: "read-only-old"
});
const readOnlyStorageKey = "cike:thought-answer-enqueue:owner-read-only:question-read-only:3";
let readOnlyStorageReads = 0;
const readOnlyStorageReadKeys = [];
const readOnlyStorage = {
  getItem(key) {
    assert.equal(key, readOnlyStorageKey);
    readOnlyStorageReads += 1;
    readOnlyStorageReadKeys.push(key);
    return readOnlyRecord;
  },
  setItem() { throw new Error("storage is read-only"); },
  removeItem() { throw new Error("storage is read-only"); }
};
let readOnlyRequestSerial = 0;
let nextReadOnlyRequestId = "";
const readOnlyOptions = {
  ownerId: "owner-read-only",
  targetId: "question-read-only",
  inputVersion: 3,
  storage: readOnlyStorage,
  createRequestId: () => `read-only-${++readOnlyRequestSerial}`
};
const readOnlyRejection = await enqueueThoughtAnswer({
  ...readOnlyOptions,
  request: async () => { throw Object.assign(new Error("rejected"), { status: 409 }); }
});
assert.deepEqual(readOnlyRejection, { kind: "rejected" });
assert.equal(readOnlyStorageReads, 2,
  "cold recovery loads and then identity-checks the owner/target/version storage record");
assert.deepEqual(readOnlyStorageReadKeys, [readOnlyStorageKey, readOnlyStorageKey]);
await enqueueThoughtAnswer({
  ...readOnlyOptions,
  request: async (_path, options) => {
    nextReadOnlyRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("unknown"), { status: 0 });
  }
});
assert.equal(nextReadOnlyRequestId, "read-only-1",
  "an in-memory resolved marker prevents reloading an old key when storage cannot be changed");
await enqueueThoughtAnswer({
  ...readOnlyOptions,
  request: async (_path, options) => {
    assert.equal(JSON.parse(options.body).clientRequestId, "read-only-1",
      "same-page retries retain the new key when session storage is unavailable");
    throw Object.assign(new Error("unknown"), { status: 0 });
  }
});
await enqueueThoughtAnswer({
  ...readOnlyOptions,
  request: async (_path, options) => {
    assert.equal(JSON.parse(options.body).clientRequestId, "read-only-1");
    return {
      id: "task-read-only",
      kind: "thoughtAnswer",
      targetId: "question-read-only",
      inputVersion: 3,
      status: "queued"
    };
  }
});
let requestAfterReadOnlySuccess = "";
await enqueueThoughtAnswer({
  ...readOnlyOptions,
  request: async (_path, options) => {
    requestAfterReadOnlySuccess = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("new unknown"), { status: 0 });
  }
});
assert.equal(requestAfterReadOnlySuccess, "read-only-2",
  "the in-memory attempt is authoritative when read-only storage still contains an older key");

const versionStorage = createSessionStorage();
let versionRequestSerial = 0;
const versionOneResponse = deferred();
let versionTwoRequestId = "";
const versionOptions = {
  ownerId: "owner-version-race",
  targetId: "question-version-race",
  storage: versionStorage,
  createRequestId: () => `version-race-${++versionRequestSerial}`
};
const versionOneRequest = enqueueThoughtAnswer({
  ...versionOptions,
  inputVersion: 1,
  request: async () => versionOneResponse.promise
});
const versionTwoUnknown = await enqueueThoughtAnswer({
  ...versionOptions,
  inputVersion: 2,
  request: async (_path, options) => {
    versionTwoRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("version two uncertain"), { status: 0 });
  }
});
assert.deepEqual(versionTwoUnknown, { kind: "unknown" });
versionOneResponse.resolve({
  id: "task-version-one",
  kind: "thoughtAnswer",
  targetId: "question-version-race",
  inputVersion: 1,
  status: "queued"
});
await versionOneRequest;
let versionTwoRetryRequestId = "";
await enqueueThoughtAnswer({
  ...versionOptions,
  inputVersion: 2,
  request: async (_path, options) => {
    versionTwoRetryRequestId = JSON.parse(options.body).clientRequestId;
    throw Object.assign(new Error("version two still uncertain"), { status: 0 });
  }
});
assert.equal(versionTwoRetryRequestId, versionTwoRequestId,
  "a delayed success for an older target version cannot replace a newer version's pending key");

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

// 聊天边界：未确认请求保持完整载荷，编辑后新编号，旧catch/finally不碰新会话。
{
  const listeners={};
  const button={disabled:false}, input={value:"first"}, date={value:"stable-date",dataset:{occurrenceMode:"now"}}, status={textContent:""};
  const form={dataset:{},querySelector:()=>button,addEventListener:(type,listener)=>{listeners[type]=listener}};
  const runtime={currentUser:{id:"chat-owner-a"},sessionSerial:1};
  const requests=[],toasts=[];let clock=0, handler;
  const query=selector=>({"#chat-form":form,"#chat-input":input,"#chat-datetime":date,"#chat-status":status})[selector];
  handler=async()=>{throw Object.assign(new Error("uncertain"),{code:"NETWORK_ERROR"})};
  installChatSubmission({runtime,$:query,occurrenceFields:()=>({occurredAt:`time-${++clock}`,occurredOn:"synthetic-day"}),resetOccurrenceInput:()=>{},
    requestV1:async(path,options)=>{requests.push(options);return handler(JSON.parse(options.body))},
    resolvePersonalizedTask:async response=>({result:response}),refreshState:async()=>true,showToast:(...args)=>toasts.push(args)});
  const submit=()=>listeners.submit({preventDefault(){},currentTarget:form});
  await submit();const uncertainId=requests.at(-1).headers["idempotency-key"],originalBody=requests.at(-1).body;
  handler=async payload=>payload;await submit();
  assert.equal(requests.at(-1).headers["idempotency-key"],uncertainId);
  assert.equal(requests.at(-1).body,originalBody,"now模式安全重试不能重新计算请求载荷");
  input.value="to-edit";handler=async()=>{throw new Error("uncertain")};await submit();
  const priorId=requests.at(-1).headers["idempotency-key"];
  input.value="edited";await submit();assert.notEqual(requests.at(-1).headers["idempotency-key"],priorId);
  const oldGate=deferred(),newGate=deferred();
  let rejectOld;oldGate.promise=new Promise((resolve,reject)=>{rejectOld=reject});
  listeners.reset();input.value="old-account";handler=async()=>oldGate.promise;
  const old=submit();await Promise.resolve();
  runtime.currentUser={id:"chat-owner-b"};runtime.sessionSerial+=1;listeners.reset();
  input.value="new-account";handler=async payload=>{newGate.payload=payload;return newGate.promise};
  const newer=submit();await Promise.resolve();const newKey=form.dataset.requestId;
  status.textContent="new session status";
  rejectOld(Object.assign(new Error("old error"),{taskId:"old-task"}));await old;
  assert.equal(form.dataset.requestId,newKey);assert.equal(status.textContent,"new session status");assert.equal(button.disabled,true);
  input.value="later edit";newGate.resolve(newGate.payload);await newer;
  assert.equal(input.value,"later edit");assert.equal(button.disabled,false);
  assert.match(status.textContent,/后来修改.*保留/);
}

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
const chainIdea = { value: "" };
const chainAnswer = { value: "" };
const chainTags = { value: "" };
const chainDateTime = { value: "2026-10-12T09:30", dataset: { occurrenceMode: "manual" } };
const chainForm = {
  dataset: {},
  elements: { sourceCaptureId: { value: "" }, sourceCaptureVersion: { value: "" } },
  querySelector: () => chainButton,
  reset() {
    chainQuestion.value = "";
    chainIdea.value = "";
    chainAnswer.value = "";
    chainDateTime.value = "";
  },
  addEventListener(type, listener) { if (type === "submit") chainSubmit = listener; }
};
let chainSubmit = null;
const chainRequests = [];
let discardedChainUploads = 0;
const chainPublished = [];
const chainToasts = [];
const chainImageDraftItems = [];
let chainImagePaths = async () => ({ attachmentPaths: ["uploaded:attachment-1"], uploadedPaths: ["uploaded:attachment-1"] });
let chainRequestHandler = async (_url, options) => {
  chainRequests.push(options.headers["idempotency-key"]);
  throw Object.assign(new Error("provider secret and internal stack"), { code: "UNKNOWN_COMMIT" });
};
let chainClearImageHandler = async () => {};
let chainRefreshHandler = async () => {};
const chainElements = new Map();
const chainElement = selector => {
  if (selector === "#thought-prompt-button") return { addEventListener() {} };
  if (selector === "#chain-form") return chainForm;
  if (selector === "#chat-form") return { addEventListener() {} };
  if (selector === "#chain-tags") return chainTags;
  if (selector === "#chain-answer") return chainAnswer;
  if (selector === "#chain-question") return chainQuestion;
  if (selector === "#chain-idea") return chainIdea;
  if (selector === "#chain-datetime") return chainDateTime;
  if (selector === "#chain-status") return chainStatus;
  if (!chainElements.has(selector)) chainElements.set(selector, { value: "", addEventListener() {} });
  return chainElements.get(selector);
};
const chainRuntime = {
  currentUser: { id: "owner-a" }, sessionSerial: 1, chainDraftVersion: 0,
  draftTags: [], answerDraft: "", answerReasoningDraft: "",
  contentImageDraftManager: { snapshot: () => ({ items: [...chainImageDraftItems] }) },
  llmSettings: { automaticAnswers: { thoughtAnswer: false } }
};
installRecordSubmissionEvents({
  runtime: chainRuntime,
  $: chainElement,
  requestV1: (...args) => chainRequestHandler(...args),
  occurrenceFields: input => {
    if (input.value === "invalid") throw new Error("请手动指定发生时间");
    return { timeMode: input.value || "now" };
  },
  contentImagePaths: (...args) => chainImagePaths(...args),
  imageRecordPayload: input => ({ content: input.content, attachmentPaths: input.attachmentPaths }),
  captureRecordPayload: payload => payload,
  discardContentImageUploads: async () => { discardedChainUploads += 1; },
  clearSubmittedContentImageDraft: (...args) => chainClearImageHandler(...args),
  clearDurableDraft() {},
  applyPendingProjection(record) { chainPublished.push(["queued", record]); },
  publishDomains(domains) { chainPublished.push([...domains]); },
  refreshState: (...args) => chainRefreshHandler(...args),
  renderTagComposer() {},
  closeHomeEditors() {},
  startBackgroundChainAnswer() {},
  commitDraftTags() {
    const tag = chainTags.value.trim();
    if (!tag) return;
    chainRuntime.draftTags.push(tag);
    chainTags.value = "";
  },
  chainRecordKind: () => "thought",
  resetOccurrenceInput() {},
  showToast(...args) { chainToasts.push(args); },
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

chainDateTime.value = "invalid";
chainForm.dataset.requestId = "invalid-time";
const requestsBeforeInvalidTime = chainRequests.length;
await submitChain();
assert.equal(chainRequests.length, requestsBeforeInvalidTime,
  "invalid manual time is validated before any save request is sent");
assert.equal(chainButton.disabled, false,
  "invalid manual time is handled by the submit catch and restores the button");
assert.match(chainStatus.textContent, /状态尚未确认/);
chainDateTime.value = "2026-10-12T09:30";

const staleImageGate = deferred();
chainImagePaths = () => staleImageGate.promise;
let staleSessionRequestCount = 0;
chainRequestHandler = async () => { staleSessionRequestCount += 1; };
chainQuestion.value = "会话切换前的内容";
chainForm.dataset.requestId = "stale-before-request";
const staleImageSubmission = submitChain();
const statusAtSessionSwitch = chainStatus.textContent;
chainRuntime.sessionSerial += 1;
staleImageGate.resolve({ attachmentPaths: [], uploadedPaths: [] });
await staleImageSubmission;
assert.equal(staleSessionRequestCount, 0,
  "a session switch during image preparation prevents the follow-up save request");
assert.equal(chainStatus.textContent, statusAtSessionSwitch,
  "a stale submission does not write status after image preparation resolves");
chainRuntime.sessionSerial = 1;
chainButton.disabled = false;

const staleSaveGate = deferred();
const staleRequestStarted = deferred();
chainImagePaths = async () => ({ attachmentPaths: [], uploadedPaths: [] });
chainRequestHandler = async (_url, options, coordination) => {
  chainRequests.push(options.headers["idempotency-key"]);
  staleSaveGate.resolveRequest = () => coordination.onQueued({ id: "stale-pending" });
  staleRequestStarted.resolve();
  return staleSaveGate.promise;
};
chainQuestion.value = "等待保存的内容";
chainForm.dataset.requestId = "stale-during-request";
const publishedBeforeStaleSave = chainPublished.length;
const toastsBeforeStaleSave = chainToasts.length;
const staleSaveSubmission = submitChain();
await staleRequestStarted.promise;
chainRuntime.sessionSerial += 1;
staleSaveGate.resolveRequest();
staleSaveGate.resolve({ data: { items: [{ id: "stale-record", type: "question" }] } });
await staleSaveSubmission;
assert.equal(chainPublished.length, publishedBeforeStaleSave,
  "a stale queued callback and late response do not publish to the new session");
assert.equal(chainToasts.length, toastsBeforeStaleSave,
  "a stale response does not show a toast in the new session");
chainRuntime.sessionSerial = 1;
chainButton.disabled = false;

const invalidTimeEditGate = deferred();
const invalidTimeEditStarted = deferred();
chainRequestHandler = async () => {
  invalidTimeEditStarted.resolve();
  return invalidTimeEditGate.promise;
};
chainDateTime.value = "2026-10-12T10:00";
chainForm.dataset.requestId = "invalid-time-edited-during-save";
const publishesBeforeInvalidTimeEdit = chainPublished.length;
const invalidTimeEditSubmission = submitChain();
await invalidTimeEditStarted.promise;
chainDateTime.value = "invalid";
invalidTimeEditGate.resolve({ data: { items: [{ id: "saved-despite-invalid-edit", type: "question" }] } });
await invalidTimeEditSubmission;
assert.ok(chainPublished.length > publishesBeforeInvalidTimeEdit,
  "an invalid date edit after a successful response does not turn the save into an unknown failure");
assert.doesNotMatch(chainStatus.textContent, /状态尚未确认/);
chainDateTime.value = "2026-10-12T09:30";

const saveGate = deferred();
let submittedPayload;
chainRequestHandler = async (_url, options) => {
  chainRequests.push(options.headers["idempotency-key"]);
  submittedPayload = JSON.parse(options.body);
  return saveGate.promise;
};
chainQuestion.value = "提交时的问题";
chainIdea.value = "提交时的想法";
chainAnswer.value = "提交时的回答";
chainDateTime.value = "2026-10-12T09:30";
chainRuntime.draftTags = ["提交时标签"];
chainForm.dataset.requestId = "same-session-edit";
let clearedNewDraftImage = false;
chainClearImageHandler = async () => { clearedNewDraftImage = true; };
const editedSaveSubmission = submitChain();
await Promise.resolve();
chainQuestion.value = "保存期间新写的问题";
chainIdea.value = "保存期间新写的想法";
chainDateTime.value = "2026-10-12T10:15";
chainRuntime.draftTags = ["保存期间新标签"];
delete chainForm.dataset.requestId;
saveGate.resolve({ data: { items: [{ id: "saved-original", type: "question" }] } });
await editedSaveSubmission;
assert.equal(submittedPayload.question, "提交时的问题");
assert.equal(submittedPayload.idea, "提交时的想法");
assert.deepEqual(submittedPayload.tags, ["提交时标签"]);
assert.equal(submittedPayload.timeMode, "2026-10-12T09:30");
assert.equal(chainQuestion.value, "保存期间新写的问题",
  "a successful old save does not reset a newer same-session question");
assert.equal(chainIdea.value, "保存期间新写的想法");
assert.equal(chainDateTime.value, "2026-10-12T10:15");
assert.deepEqual(chainRuntime.draftTags, ["保存期间新标签"]);
assert.equal(clearedNewDraftImage, false,
  "a successful old save does not clear attachments belonging to a newer draft");

chainImageDraftItems.push({
  file: { name: "submitted-image.png" },
  path: "images/submitted-image.png",
  uploadedPath: "images/submitted-image.png",
  uploadRequestId: "image-request-1",
  preview: "blob:submitted-image"
});
const imageRemovalGate = deferred();
const imageRemovalStarted = deferred();
chainRequestHandler = async () => {
  imageRemovalStarted.resolve();
  return imageRemovalGate.promise;
};
chainQuestion.value = "带图的思考";
chainTags.value = "";
chainDateTime.value = "2026-10-12T10:45";
chainForm.dataset.requestId = "image-removal-race";
let clearedRemovedImageDraft = false;
chainClearImageHandler = async () => { clearedRemovedImageDraft = true; };
const imageRemovalSubmission = submitChain();
await imageRemovalStarted.promise;
chainImageDraftItems.splice(0, 1);
chainTags.value = "未提交的新标签";
imageRemovalGate.resolve({ data: { items: [{ id: "image-race-saved", type: "question" }] } });
await imageRemovalSubmission;
assert.equal(clearedRemovedImageDraft, false,
  "a late save does not clear the current image draft after an image is removed");
assert.equal(chainTags.value, "未提交的新标签",
  "a late save does not reset an uncommitted tag typed during the request");

const refreshGate = deferred();
chainRequestHandler = async () => ({
  data: { items: [{ id: "refresh-late-record", type: "question" }] }
});
chainRefreshHandler = () => refreshGate.promise;
chainQuestion.value = "触发延迟刷新的问题";
chainIdea.value = "";
chainAnswer.value = "";
chainDateTime.value = "2026-10-12T11:00";
chainRuntime.draftTags = [];
chainForm.dataset.requestId = "late-refresh";
await submitChain();
const toastsBeforeRefreshFailure = chainToasts.length;
chainRuntime.sessionSerial += 1;
refreshGate.resolve(Promise.reject(new Error("late refresh rejection")));
await Promise.resolve();
await Promise.resolve();
assert.equal(chainToasts.length, toastsBeforeRefreshFailure,
  "a delayed refresh failure after a session switch does not show a stale toast");
chainRuntime.sessionSerial = 1;

console.log("Personalized AI task UI checks passed: task retries, result recovery, session isolation, modal races and chat idempotency.");
