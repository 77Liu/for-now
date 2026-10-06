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
  aiTasks: []
};
const requestGate = deferred();
const toasts = [];
let frame = 0;
const cancelledFrames = [];
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
    resetDraft() {},
    startDraft() {},
    persistDraft: async () => {},
    submitDraft: async () => ({ uploadedPaths: [], attachmentPaths: [] }),
    buildPayload: value => value,
    clearDraft: async () => {},
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
const oldAnnotation = snapshot.thoughts[0].annotations[0];
document.dispatch("click", new FakeAction({
  annotationMenu: "to-highlight",
  annotationId: "annotation-1"
}));
await flush();

controller.resetSession();
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

console.log("Frontend annotations feature checks passed: repeat mount cleanup, session reset and late-account response isolation.");
