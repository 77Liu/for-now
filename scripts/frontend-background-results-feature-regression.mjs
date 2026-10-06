import assert from "node:assert/strict";
import {
  backgroundNavigationTarget,
  backgroundTargetSelector,
  createBackgroundResultsFeatureController
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
      const taskId = decodeURIComponent(path.split("/").at(-2));
      const value = results.get(taskId);
      return { result: value?.promise ? await value.promise : value };
    },
    async refresh(domains, options) {
      events.push(`refresh:${domains.join(",")}:${options.chainId || ""}`);
      if (refreshGate) await refreshGate.promise;
      return true;
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
results.set(accountBTask.id, {
  id: "answer-b",
  type: "answer",
  relatedTo: "root-b",
  sourceTaskId: accountBTask.id
});
assert.equal(await controller.sync([accountBTask]), true, "new account must sync after reset");
assert.equal(controller.needsRetry(), false);

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
  "annotation:book:book-1:annotation-1"
]);
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

console.log("Frontend background results checks passed: idempotent merge, account reset, late-result isolation and cross-content location.");
