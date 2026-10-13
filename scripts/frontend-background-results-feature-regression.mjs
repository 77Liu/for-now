import assert from "node:assert/strict";
import {
  backgroundNavigationTarget,
  backgroundTargetSelector,
  createBackgroundResultController,
  createBackgroundResultsFeatureController,
  mergeBackgroundTaskResult
} from "../public/frontend/features/background-results/index.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeElement {
  constructor() {
    this.scrollTop = 0;
    this.scrolls = 0;
  }
  scrollIntoView() {
    this.scrolls += 1;
  }
}

const thoughtBlockTask = {
  id: "task-image",
  kind: "contentImageUnderstanding",
  resourceType: "thought",
  targetId: "root-1",
  contentTargetType: "thoughtBlock",
  contentTargetId: "answer-1",
  resultId: "understanding-1",
  status: "succeeded"
};
const locatorSnapshot = {
  thoughts: [{
    id: "root-1",
    type: "question"
  }, {
    id: "answer-1",
    type: "answer",
    relatedTo: "root-1"
  }]
};
assert.deepEqual(
  backgroundNavigationTarget(thoughtBlockTask, null, locatorSnapshot),
  {
    kind: "contentImageUnderstanding",
    resourceType: "thought",
    targetId: "root-1",
    subtargetId: "",
    contentTargetType: "thoughtBlock",
    contentTargetId: "answer-1",
    annotationId: "",
    rootId: "root-1",
    focusId: "root-1",
    view: "thoughts",
    domain: "thoughts"
  }
);
assert.equal(
  backgroundTargetSelector(
    backgroundNavigationTarget(thoughtBlockTask, null, locatorSnapshot),
    value => `escaped-${value}`
  ),
  '[data-chain-id="escaped-root-1"]'
);
assert.equal(backgroundNavigationTarget(null, { resourceType: "book" }, {}), null);

let accountId = "account-a";
let snapshot = structuredClone(locatorSnapshot);
snapshot.thoughts[0].followUps = [];
snapshot.thoughts[0].annotations = [];
snapshot.captures = [];
snapshot.books = [{
  id: "book-1",
  annotations: [{ id: "annotation-1", shenji: [] }]
}];
const results = new Map();
const requests = [];
const events = [];
const toasts = [];
const panel = new FakeElement();
const nodes = new Map([
  ["#comment-panel", panel],
  ['[data-chain-id="root-1"]', new FakeElement()],
  ['[data-chain-id="root-b"]', new FakeElement()],
  ['[data-comment-card="annotation-1"]', new FakeElement()]
]);
const document = {
  querySelector(selector) {
    events.push(`query:${selector}`);
    return nodes.get(selector) || null;
  }
};
const window = {
  scrollX: 21,
  scrollY: 34,
  scrollTo(x, y) {
    events.push(`restore:${x}:${y}`);
  }
};
let annotationOpens = 0;
let refreshGate = null;
let refreshSucceeded = true;
const controller = createBackgroundResultsFeatureController({
  data: {
    getSnapshot: () => snapshot,
    getAccountId: () => accountId,
    replaceSnapshot(value) {
      snapshot = value;
      events.push("replace");
    },
    async request(path) {
      requests.push(path);
      events.push(`request:${path}`);
      const taskId = decodeURIComponent(path.split("/").at(-2));
      const value = results.get(taskId);
      return { result: value?.promise ? await value.promise : value };
    },
    async refresh(domains, options) {
      events.push(`refresh:${domains.join(",")}:${options.chainId || ""}`);
      if (refreshGate) await refreshGate.promise;
      return refreshSucceeded;
    },
    publish(domains) {
      events.push(`publish:${domains.join(",")}`);
    }
  },
  navigation: {
    openThoughtDetail(id) {
      events.push(`detail:${id}`);
    },
    switchView(view) {
      events.push(`view:${view}`);
    }
  },
  annotations: {
    async openTarget(target, isCurrent) {
      await Promise.resolve();
      if (!isCurrent()) return false;
      annotationOpens += 1;
      events.push(`annotation:${target.resourceType}:${target.targetId}:${target.annotationId}`);
      return true;
    },
    refreshTarget(target) {
      events.push(`annotation-refresh:${target.subtargetId}`);
      return true;
    }
  },
  view: {
    patchThoughtTarget(target) {
      events.push(`patch-thought:${target.targetId}`);
      return true;
    },
    scheduleAnnotationLayout() {
      events.push("layout");
    },
    showToast(message, kind) {
      toasts.push([message, kind]);
    }
  },
  platform: {
    document,
    window,
    requestFrame(callback) {
      callback();
      return 1;
    },
    escapeSelector: value => String(value)
  }
});

const answerTask = {
  id: "task-answer",
  kind: "thoughtAnswer",
  resourceType: "thought",
  targetId: "root-1",
  resultId: "answer-result",
  status: "succeeded"
};
results.set(answerTask.id, {
  id: "answer-result",
  type: "answer",
  relatedTo: "root-1",
  content: "后台结果",
  sourceTaskId: answerTask.id
});
assert.equal(await controller.sync([answerTask]), true);
assert.equal(snapshot.thoughts.filter(item => item.id === "answer-result").length, 1);
assert.ok(events.includes("patch-thought:root-1"));
assert.ok(events.includes("restore:21:34"));
assert.equal(await controller.sync([answerTask]), false, "result fingerprints must be idempotent");
assert.equal(requests.length, 1);

const lateTask = {
  ...answerTask,
  id: "task-late",
  targetId: "root-1",
  resultId: "late-result"
};
const lateResult = deferred();
results.set(lateTask.id, lateResult);
const lateSync = controller.sync([lateTask]);
controller.resetSession();
accountId = "account-b";
snapshot = {
  thoughts: [{
    id: "root-b",
    type: "question",
    followUps: [],
    annotations: []
  }],
  captures: [],
  books: []
};
const eventCountAfterReset = events.length;
lateResult.resolve({
  id: "late-result",
  type: "answer",
  relatedTo: "root-1",
  sourceTaskId: lateTask.id
});
assert.equal(await lateSync, false);
assert.equal(snapshot.thoughts.length, 1);
assert.equal(snapshot.thoughts[0].id, "root-b");
assert.equal(events.length, eventCountAfterReset, "late result must not write view state");
assert.deepEqual(toasts, []);

const accountBTask = {
  ...answerTask,
  id: "task-account-b",
  targetId: "root-b",
  resultId: "answer-b"
};
const failedResult = deferred();
results.set(accountBTask.id, failedResult);
const failedSync = controller.sync([accountBTask]);
failedResult.reject(new Error("temporary result read failure"));
assert.equal(await failedSync, false);
assert.equal(controller.needsRetry(), true);
assert.deepEqual(toasts.at(-1), [
  "后台回答暂未同步，可在通知中打开后重试。",
  "error"
]);
results.set(accountBTask.id, {
  id: "answer-b",
  type: "answer",
  relatedTo: "root-b",
  sourceTaskId: accountBTask.id
});
const requestsBeforeViewRetry = requests.length;
events.length = 0;
assert.equal(await controller.openTarget(accountBTask, {
  resourceType: "thought",
  targetId: "root-b"
}), true, "viewing a completed thought answer retries its result read");
assert.deepEqual(requests.slice(requestsBeforeViewRetry), [
  "/api/ai-tasks/task-account-b/result"
]);
assert.ok(
  events.indexOf("refresh:thoughts,notifications:root-b")
    < events.indexOf("request:/api/ai-tasks/task-account-b/result"),
  "the task result is retried after refreshing the thought chain"
);
assert.equal(controller.needsRetry(), false);
assert.equal(snapshot.thoughts.filter(item => item.id === "root-b").length, 1);
assert.equal(snapshot.thoughts.filter(item => item.id === "answer-b").length, 1);
assert.equal(snapshot.thoughts.length, 2);
assert.equal(nodes.get('[data-chain-id="root-b"]').scrolls, 1);
nodes.get('[data-chain-id="root-b"]').scrolls = 0;

events.length = 0;
snapshot.thoughts.push({
  id: "block-b",
  type: "answer",
  relatedTo: "root-b"
});
assert.equal(await controller.openTarget({
  ...thoughtBlockTask,
  targetId: "root-b",
  contentTargetId: "block-b"
}), true);
assert.deepEqual(events.slice(0, 2), [
  "detail:root-b",
  "refresh:thoughts,notifications:root-b"
]);
assert.equal(nodes.get('[data-chain-id="root-b"]').scrolls, 1);

events.length = 0;
const bookAnnotationTask = {
  id: "task-book",
  kind: "contentImageUnderstanding",
  resourceType: "book",
  targetId: "book-1",
  subtargetId: "legacy-annotation-id",
  contentTargetType: "comment",
  contentTargetId: "annotation-1",
  resultId: "book-result",
  status: "succeeded"
};
snapshot.books = [{
  id: "book-1",
  annotations: [{ id: "annotation-1", imageUnderstandings: [] }]
}];
assert.equal(await controller.openTarget(bookAnnotationTask), true);
assert.deepEqual(events.slice(0, 3), [
  "view:books",
  "refresh:books,notifications:",
  "request:/api/ai-tasks/task-book/result"
]);
assert.ok(events.includes("annotation:book:book-1:annotation-1"));
assert.equal(annotationOpens, 1);
assert.equal(nodes.get('[data-comment-card="annotation-1"]').scrolls, 1);

events.length = 0;
const targetSwitchGate = deferred();
refreshGate = targetSwitchGate;
const staleOpen = controller.openTarget({
  ...bookAnnotationTask,
  id: "task-stale-open"
});
refreshGate = null;
const latestOpen = controller.openTarget({
  ...thoughtBlockTask,
  targetId: "root-b",
  contentTargetId: "block-b"
});
assert.equal(await latestOpen, true);
targetSwitchGate.resolve();
assert.equal(await staleOpen, false);
assert.equal(annotationOpens, 1, "a late previous target must not replace the latest location");


// 手动读取目标失败不能冒称定位成功，也不继续接入/请求结果。
refreshSucceeded = false;
const beforeFailedOpen = requests.length;
assert.equal(await controller.openTarget(answerTask), false);
assert.equal(requests.length, beforeFailedOpen);
assert.match(toasts.at(-1)[0], /目标或通知暂未读取成功/);
refreshSucceeded = true;

// 旧结果终态在其它任务持续通知刷新时也只自动请求/提示一次。
for (const status of [404, 410, 503]) {
  let calls = 0;
  let notices = 0;
  const sync = createBackgroundResultController({
    loadResult: async () => {
      calls += 1;
      throw Object.assign(new Error("synthetic"), { status });
    },
    applyResult: () => true,
    onError: () => { notices += 1; }
  });
  for (let round = 0; round < 12; round += 1) await sync.sync([answerTask]);
  assert.equal(calls, status === 503 ? 3 : 1);
  assert.equal(notices, 1);
  assert.equal(sync.needsRetry(), false);
  sync.forget(answerTask.id);
  await sync.sync([answerTask]);
  assert.equal(calls, status === 503 ? 4 : 2, "手动允许一次新恢复周期");
  sync.reset();
  await sync.sync([answerTask]);
  assert.equal(notices, 3, "账户切换清除旧任务恢复状态");
}
let partialCalls = 0;
let targetLoaded = false;
const partial = createBackgroundResultController({
  loadResult: async () => { partialCalls += 1; return { id: answerTask.resultId }; },
  applyResult: () => targetLoaded
});
await partial.sync([answerTask]);
targetLoaded = true;
assert.equal(await partial.sync([answerTask]), true);
assert.equal(partialCalls, 2, "局部快照暂缺目标时重新获取当前结果，不推断删除或缓存旧结果");

// 局部目标未加载不等于同步故障：只读一次，后续域加载接入同一结果。
const validResult = {
  id: answerTask.resultId, type: "answer", relatedTo: answerTask.targetId,
  sourceTaskId: answerTask.id, content: "已持久化的合成回答"
};
let pagedSnapshot = { thoughts: [] };
let deferredReads = 0;
let deferredErrors = 0;
const deferredSync = createBackgroundResultController({
  loadResult: async () => { deferredReads += 1; return validResult; },
  applyResult: ({ task, result }) => {
    const merged = mergeBackgroundTaskResult(pagedSnapshot, task, result);
    if (merged.deferred) return { deferred: true };
    if (!merged.changed) return false;
    pagedSnapshot = merged.value;
    return true;
  },
  onError: () => { deferredErrors += 1; }
});
for (let i = 0; i < 8; i += 1) assert.equal(await deferredSync.sync([answerTask]), false);
assert.equal(deferredReads, 1);
assert.equal(deferredErrors, 0);
assert.deepEqual(pagedSnapshot.thoughts, []);
pagedSnapshot.thoughts = [{ id: answerTask.targetId, type: "question" }];
assert.equal(await deferredSync.sync([answerTask]), true);
assert.equal(deferredReads, 1, "域加载后接入已读取的同身份结果，不重复GET");
assert.equal(pagedSnapshot.thoughts.filter(item => item.id === answerTask.resultId).length, 1);
assert.equal(mergeBackgroundTaskResult({}, answerTask, { ...validResult, id: "wrong-id" }).deferred, undefined);
assert.equal(mergeBackgroundTaskResult({}, answerTask, { ...validResult, relatedTo: "other-root" }).deferred, undefined);
const audioTask = { id: "audio-task", kind: "captureTranscription", status: "succeeded", targetId: "capture", resultId: "capture" };
const audioResult = { id: "capture", transcription: { status: "ready" }, audio: { attachmentPath: "new-path" } };
assert.equal(mergeBackgroundTaskResult({ captures: [] }, audioTask, audioResult).deferred, true);
assert.equal(mergeBackgroundTaskResult({ captures: [{ id: "capture", audio: { attachmentPath: "old-path" } }] }, audioTask, audioResult).deferred, undefined);
deferredSync.reset();
pagedSnapshot = { thoughts: [] };
await deferredSync.sync([answerTask]);
assert.equal(deferredReads, 2, "账户重置不复用前账户缓存");

let transientFirst = true;
const transportThenDeferred = createBackgroundResultController({
  loadResult: async () => {
    if (transientFirst) {
      transientFirst = false;
      throw Object.assign(new Error("synthetic transient"), { status: 503 });
    }
    return validResult;
  },
  applyResult: () => ({ deferred: true })
});
await transportThenDeferred.sync([answerTask]);
assert.equal(transportThenDeferred.needsRetry(), true);
await transportThenDeferred.sync([answerTask]);
assert.equal(transportThenDeferred.needsRetry(), false, "合法结果已读不能残留传输重试账");

console.log("Frontend background results checks passed: idempotent merge, account reset, late-result isolation and cross-content location.");
