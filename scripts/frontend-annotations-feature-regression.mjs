import assert from "node:assert/strict";
import {
  annotationRootKey,
  createAnnotationsFeatureController,
  parseAnnotationRootKey
} from "../public/frontend/features/annotations/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    if (force === false) this.values.delete(value);
    else this.values.add(value);
  }
}

class FakeElement {
  constructor(document, name) {
    this.document = document;
    this.name = name;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = {};
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 400;
    this.offsetWidth = 120;
    this.offsetHeight = 36;
    this.offsetParent = null;
    this._innerHTML = "";
    this._textContent = "";
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.document.writes += 1;
  }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value);
    this.document.writes += 1;
  }
  setAttribute(name, value) { this[name] = String(value); }
  querySelector(selector) {
    if (this.name === "panel" && selector === "header h2") {
      return this.document.heading;
    }
    return null;
  }
  querySelectorAll() { return []; }
  getClientRects() { return []; }
  getBoundingClientRect() { return { top: 0, right: 0 }; }
  replaceChildren() {
    this._innerHTML = "";
    this.document.writes += 1;
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  count(type) {
    return this.listeners.get(type)?.size || 0;
  }
  dispatch(type, target) {
    const event = {
      target,
      preventDefault() {}
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.writes = 0;
    this.body = { classList: new FakeClassList() };
    this.heading = new FakeElement(this, "heading");
    this.elements = Object.fromEntries([
      "comment-panel",
      "comment-panel-reopen",
      "comment-panel-reopen-count",
      "comment-panel-list",
      "comment-composer",
      "comment-quote",
      "comment-text",
      "comment-status",
      "selection-tools",
      "annotation-line-counts"
    ].map(name => [name, new FakeElement(this, name)]));
    this.elements["comment-panel"].querySelector = selector => (
      selector === "header h2" ? this.heading : null
    );
  }
  querySelector(selector) {
    return selector.startsWith("#") ? this.elements[selector.slice(1)] || null : null;
  }
  querySelectorAll() { return []; }
}

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    this.scrollX = 0;
    this.scrollY = 0;
    this.innerWidth = 1280;
    this.innerHeight = 800;
    this.NodeFilter = {
      SHOW_TEXT: 4,
      FILTER_REJECT: 2,
      FILTER_ACCEPT: 1
    };
    this.visualViewport = new FakeEventTarget();
  }
  getSelection() {
    return { isCollapsed: true, removeAllRanges() {} };
  }
  scrollBy() {}
}

class FakeAction {
  constructor(dataset) {
    this.dataset = dataset;
  }
  closest(selector) {
    return selector === "[data-annotation-menu]" ? this : null;
  }
}

const document = new FakeDocument();
const window = new FakeWindow();
const storageValues = new Map();
const storage = {
  getItem: key => storageValues.get(key) || null,
  setItem: (key, value) => storageValues.set(key, value),
  removeItem: key => storageValues.delete(key)
};
let accountId = "account-a";
let snapshot = {
  thoughts: [{
    id: "root",
    type: "question",
    annotations: [{
      id: "annotation-1",
      kind: "comment",
      quote: "原文",
      text: "评论",
      createdAt: "2026-10-06T08:00:00.000Z",
      replies: []
    }],
    annotationDrift: []
  }],
  aiTasks: [{
    id: "waiting-annotation-task",
    kind: "annotationShenji",
    targetId: "root",
    subtargetId: "annotation-1",
    status: "waiting_for_user_model"
  }]
};
const requestGate = deferred();
const toasts = [];
let frame = 0;
const cancelledFrames = [];
let persistentDraftClears = 0;
const controller = createAnnotationsFeatureController({
  data: {
    getSnapshot: () => snapshot,
    getAccountId: () => accountId,
    request: () => requestGate.promise,
    refreshNotifications: async () => {},
    scheduleNotificationPoll() {},
    clearThoughtTracePending() {},
    openSelectionQuote() {}
  },
  media: {
    resetDraft() { persistentDraftClears += 1; },
    startDraft() {},
    persistDraft: async () => {},
    submitDraft: async () => ({ uploadedPaths: [], attachmentPaths: [] }),
    buildPayload: value => value,
    clearDraft: async () => { persistentDraftClears += 1; },
    discardUploads: async () => {},
    uncertainSubmission: () => false,
    contentImagesMarkup: () => ""
  },
  view: {
    escapeHtml: value => String(value),
    renderMarkdown: value => String(value),
    renderLatex() {},
    contextReceiptMarkup: () => "",
    emptyStateMarkup: value => `<div>${value}</div>`,
    formatDate: value => value,
    showToast: (...args) => toasts.push(args)
  },
  platform: {
    document,
    window,
    storage,
    createRequestId: () => "request-1",
    confirm: () => true,
    prompt: () => "",
    requestFrame: () => ++frame,
    cancelFrame: value => cancelledFrames.push(value),
    setTimer: callback => {
      callback();
      return 1;
    },
    clearTimer() {},
    matchesMedia: () => false,
    escapeSelector: value => String(value),
    writeClipboard: async () => {}
  }
});

assert.equal(annotationRootKey("thought", "root"), "thought:root");
assert.deepEqual(parseAnnotationRootKey("thought:root"), {
  type: "thought",
  id: "root"
});

const firstDispose = controller.mount({ root: document });
assert.equal(document.count("click"), 1);
assert.equal(window.count("scroll"), 1);
const secondDispose = controller.mount({ root: document });
assert.equal(firstDispose(), false, "replaced mount disposer must be idempotent");
assert.equal(document.count("click"), 1, "repeat mount must not duplicate document listeners");
assert.equal(window.count("scroll"), 1, "repeat mount must not duplicate window listeners");

controller.openPanel("thought:root", "annotation-1");
assert.match(document.elements["comment-panel-list"].innerHTML,
  /等待核心用户模型就绪；完成核心问答后会自动继续/);
assert.match(document.elements["comment-panel-list"].innerHTML,
  /data-shenji-form="annotation-1"[\s\S]*?<button type="submit" disabled>/);
const oldAnnotation = snapshot.thoughts[0].annotations[0];
document.dispatch("click", new FakeAction({
  annotationMenu: "to-highlight",
  annotationId: "annotation-1"
}));
await flush();

document.elements["comment-text"].value = "账户A未提交的私密评论";
document.elements["comment-status"].textContent = "账户A的提交提示";
document.elements["comment-quote"].textContent = "账户A的选区";
Object.assign(document.elements["comment-composer"].dataset, {
  requestId: "account-a-request", assistantClientRequestId: "account-a-assistant",
  annotationSubmission: "account-a-submission"
});
const oldSubmit = { disabled: true };
document.elements["comment-composer"].querySelector = selector => selector === 'button[type="submit"]' ? oldSubmit : null;
controller.resetSession();
assert.equal(document.elements["comment-text"].value, "", "session reset clears private aside composer text");
assert.equal(document.elements["comment-status"].textContent, "");
assert.equal(document.elements["comment-quote"].textContent, "");
assert.deepEqual(document.elements["comment-composer"].dataset, {}, "old account request ownership must not survive reset");
assert.equal(document.elements["comment-composer"].hidden, true);
assert.equal(oldSubmit.disabled, false, "old submission must not disable the next account composer");
accountId = "account-b";
snapshot = {
  thoughts: [{
    id: "root",
    type: "question",
    annotations: [],
    annotationDrift: []
  }],
  aiTasks: []
};
const writesAfterReset = document.writes;
requestGate.resolve({
  id: "annotation-1",
  kind: "highlight",
  quote: "原文"
});
await flush();
await flush();

assert.equal(oldAnnotation.kind, "comment", "late account response must not mutate old state");
assert.equal(snapshot.thoughts[0].annotations.length, 0, "late account response must not enter new state");
assert.equal(document.writes, writesAfterReset, "late account response must not write DOM");
assert.deepEqual(toasts, [], "late account response must not show feedback");
assert.equal(document.count("click"), 0);
assert.equal(window.count("scroll"), 0);
assert.ok(cancelledFrames.length > 0, "session reset must cancel pending layout frames");
assert.equal(secondDispose(), false);
controller.mount({ root: document });
controller.openPanel("thought:root");
assert.equal(document.elements["comment-text"].value, "", "account B opening a panel must not inherit account A text");
assert.equal(persistentDraftClears, 0, "session DOM reset must preserve owner-scoped persistent drafts");
controller.unmount();

console.log("Frontend annotations feature checks passed: repeat mount cleanup, session reset and late-account response isolation.");

// F6确认集合统一投影：回复、AI对话、标记与漂流分开，摘要和缺失数组不冒称0。
{
  const { projectAnnotationCounts, annotationCountLabel } = await import("../public/frontend/features/annotations/index.mjs");
  const root = {
    annotations: [
      { id: "thread", kind: "comment", version: 1, targetKey: "question:r", replies: [{ id: "reply" }, { id: "reply" }, { id: "reply2" }], shenji: [{ id: "ai" }] },
      { id: "thread", kind: "comment", version: 1, targetKey: "question:r", replies: [{ id: "reply" }, { id: "reply2" }], shenji: [{ id: "ai" }] },
      { id: "mark1", kind: "highlight" }, { id: "mark2", kind: "emphasis" }
    ],
    annotationDrift: [{ id: "drift", kind: "comment", replies: [{ id: "old-reply" }] }]
  };
  const counts = projectAnnotationCounts(root);
  assert.equal(counts.threadCount, 1);
  assert.equal(counts.replyCount, 2);
  assert.equal(counts.assistantCount, 1);
  assert.equal(counts.markCount, 2);
  assert.equal(counts.driftCount, 1);
  assert.equal(root.annotations.length, 4, "纯投影不代替ACK接入修改事实数组");
  assert.match(annotationCountLabel(counts), /1条批注 · 2条回复 · 1条AI回复 · 2条标记 · 1条漂流/);
  for (const value of [null, {}, { annotations: [] }, { ...root, blockCount: 0 }]) {
    const unknown = projectAnnotationCounts(value);
    assert.equal(unknown.loaded, false); assert.equal(unknown.threadCount, null);
    assert.equal(annotationCountLabel(unknown), "批注未完整加载");
  }
  assert.equal(projectAnnotationCounts(root, { complete: false }).replyCount, null);
  assert.equal(projectAnnotationCounts({ annotations: [], annotationDrift: [] }).threadCount, 0);
  assert.equal(projectAnnotationCounts(root, { targetKey: "another" }).threadCount, 0);
}

// F8规范锚点优先真实rawStart；重复原文没有唯一可信位置时不猜第一处。
{
  const { annotationAnchorOffset } = await import("../public/frontend/features/annotations/index.mjs");
  const source = "前重复中😀重复尾";
  assert.equal(annotationAnchorOffset(source, { quote: "重复", start: 1, rawStart: 6 }), 6);
  assert.equal(annotationAnchorOffset(source, { quote: "重复", start: 100 }), null);
  assert.equal(annotationAnchorOffset(source, { quote: "重复", contextBefore: "😀", contextAfter: "尾" }), 6);
  assert.equal(annotationAnchorOffset(source, { quote: "😀", start: 0 }), 4);
}

// F8锚点过期不等于废弃整份草稿：实际消费者只会对invalid调用abandon。
{
  const context = { selection: { rootKey: "thought:root", targetKey: "question:root", start: 0, end: 2, quote: "旧文", sourceValue: "旧文", sourceVersion: 1 }, text: "需要恢复的评论" };
  const restored = controller.restoreCommentDraft(context);
  assert.equal(restored, "reselect");
  assert.notEqual(restored, "invalid", "source失效不能触发content-media-runtime的整份abandon");
  assert.equal(document.elements["comment-text"].value, context.text);
  assert.match(document.elements["comment-status"].textContent, /文字和图片草稿已保留/);
  const restoredContext = controller.commentDraftContext();
  assert.equal(restoredContext.selection.phase, "invalid");
  assert.equal(restoredContext.text, context.text);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(restoredContext)).selection, "host"), false);
  const feedback = toasts.length;
  assert.equal(controller.restoreCommentDraft(context), true);
  assert.equal(toasts.length, feedback, "同一失效草稿重复恢复不反复弹提示");
}
