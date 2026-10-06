import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createKeepsakeDrafts } from "../public/frontend/features/keepsakes/drafts.mjs";
import { createKeepsakeFeatureController } from "../public/frontend/features/keepsakes/index.mjs";
import { createKeepsakeFeatureState } from "../public/frontend/features/keepsakes/model.mjs";
import { createKeepsakeOperations } from "../public/frontend/features/keepsakes/operations.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

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
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  dispatch(type, target = this, extra = {}) {
    let prevented = false;
    const event = {
      type,
      target,
      preventDefault() {
        prevented = true;
      },
      ...extra
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return prevented;
  }
}

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    contains: name => values.has(name)
  };
}

function fakeNode(extra = {}) {
  return {
    id: "",
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    classList: fakeClassList(),
    style: { setProperty() {}, removeProperty() {} },
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name];
    },
    removeAttribute(name) {
      delete this[name];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    reset() {},
    scrollIntoView() {},
    ...extra
  };
}

class FakeRoot extends FakeEventTarget {
  constructor(nodes = new Map()) {
    super();
    this.nodes = nodes;
    this.classList = fakeClassList();
  }
  querySelector(selector) {
    return this.nodes.get(selector) || null;
  }
  querySelectorAll() {
    return [];
  }
}

function memoryStore(initial = new Map()) {
  return {
    records: initial,
    async get(owner, id) {
      return initial.get(`${owner}:${id}`) || null;
    },
    async put(value) {
      initial.set(`${value.owner}:${value.id}`, value);
    },
    async delete(owner, id) {
      initial.delete(`${owner}:${id}`);
    }
  };
}

function createRuntimeHarness({
  root = new FakeRoot(),
  snapshot = { keepsakes: [] },
  store = memoryStore()
} = {}) {
  const document = new FakeEventTarget();
  const window = new FakeEventTarget();
  const frames = new Map();
  const timers = new Map();
  const urls = { created: [], revoked: [] };
  const observers = [];
  let frameSequence = 0;
  let timerSequence = 0;
  let urlSequence = 0;
  let accountId = "account-a";
  let sessionSerial = 1;
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const controller = createKeepsakeFeatureController({
    data: {
      getSnapshot: () => snapshot,
      getAccountId: () => accountId,
      getSessionSerial: () => sessionSerial,
      getActiveDate: () => "2026-10-06",
      request: async () => ({}),
      refresh: async () => {}
    },
    media: {
      validateImages: files => files,
      imageDataUrls: async () => [],
      readBlob: async () => new Blob(),
      dataUrlFromBlob: async () => "data:image/png;base64,"
    },
    drafts: store,
    navigation: { scrollTo() {} },
    view: {
      appUrl: value => value,
      contentState: ({ title }) => `<empty>${title}</empty>`,
      escapeMarkup: value => String(value ?? ""),
      eventTimestamp: item => item.occurredAt || "",
      eventDate: item => (item.occurredAt || "").slice(0, 10),
      formatDate: value => String(value),
      formatDateKey: value => String(value),
      formatTime: value => String(value),
      resetOccurrenceInput() {},
      occurrenceFields: () => ({ timeMode: "now" }),
      splitTags: value => String(value || "").split(/\s+/).filter(Boolean),
      formatBytes: value => `${value} B`,
      feedCountLabel: (scope, filtered, total, unit) => (
        filtered === total ? `${total} ${unit}` : `${filtered} / ${total} ${unit}`
      ),
      feedSearchEmpty: label => `<empty>没有匹配的${label}</empty>`,
      localDateTimeForDate: date => `${date}T12:00:00`,
      showToast() {},
      uncertainSubmission: error => Boolean(error.uncertain)
    },
    platform: {
      document,
      window,
      objectUrls: {
        createObjectURL(file) {
          const url = `blob:${file.name}-${++urlSequence}`;
          urls.created.push(url);
          return url;
        },
        revokeObjectURL(url) {
          urls.revoked.push(url);
        }
      },
      createFile: (blob, name, options) => ({
        blob,
        name,
        type: options.type,
        lastModified: options.lastModified,
        size: blob?.size || 0
      }),
      createRequestId: (() => {
        let sequence = 0;
        return () => `request-${++sequence}`;
      })(),
      createCanvas: (width, height) => fakeNode({ width, height }),
      createImageData: (width, height, pixels = new Uint8ClampedArray(width * height * 4)) => ({
        width,
        height,
        data: pixels
      }),
      loadImage: async () => ({ naturalWidth: 1, naturalHeight: 1 }),
      requestFrame(callback) {
        const id = ++frameSequence;
        frames.set(id, callback);
        return id;
      },
      cancelFrame(id) {
        frames.delete(id);
      },
      setTimer(callback) {
        const id = ++timerSequence;
        timers.set(id, callback);
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      },
      now: () => "2026-10-06T08:00:00.000Z",
      confirm: () => true,
      IntersectionObserver: FakeObserver
    }
  });
  return {
    controller,
    document,
    window,
    frames,
    timers,
    urls,
    observers,
    setAccount(value) {
      accountId = value;
      sessionSerial += 1;
    },
    runFrames() {
      const pending = [...frames.entries()];
      frames.clear();
      pending.forEach(([, callback]) => callback());
    }
  };
}

const rootEvents = [
  "click", "submit", "input", "change", "keydown", "focusout",
  "dragenter", "dragover", "dragleave", "drop",
  "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "load"
];
{
  const harness = createRuntimeHarness();
  const root = new FakeRoot();
  let staleDispose = null;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = await harness.controller.mount({
      root,
      route: { view: "keepsakes" },
      signal: new AbortController().signal
    });
    for (const type of rootEvents) assert.equal(root.listenerCount(type), 1);
    assert.equal(harness.document.listenerCount("paste"), 1);
    assert.equal(harness.window.listeners.size, 0);
    assert.equal(harness.frames.size, 1);
    if (staleDispose) assert.equal(await staleDispose(), false);
    staleDispose = dispose;
  }
  assert.equal(await staleDispose(), true);
  assert.equal(await staleDispose(), false);
  for (const type of rootEvents) assert.equal(root.listenerCount(type), 0);
  assert.equal(harness.document.listenerCount("paste"), 0);
  assert.equal(harness.frames.size, 0);
}

{
  const first = createRuntimeHarness();
  const second = createRuntimeHarness();
  const firstRoot = new FakeRoot();
  const secondRoot = new FakeRoot();
  await first.controller.mount({
    root: firstRoot,
    route: { view: "keepsakes" },
    signal: new AbortController().signal
  });
  await second.controller.mount({
    root: secondRoot,
    route: { view: "keepsakes" },
    signal: new AbortController().signal
  });
  await first.controller.unmount();
  assert.equal(firstRoot.listenerCount("click"), 0);
  assert.equal(secondRoot.listenerCount("click"), 1);
  await second.controller.unmount();
}

{
  const nodes = new Map();
  for (const selector of [
    "#keepsake-batch", "#keepsake-batch-list", "#keepsake-batch-count",
    "#keepsake-upload-box", "#keepsake-editor", "#keepsake-id",
    "#keepsake-pagination", "#keepsake-pagination-status", "#keepsake-load-more",
    "#keepsake-grid", "#keepsake-detail", ".keepsake-library",
    "#keepsake-count", "#keepsake-library-count", "#keepsake-search-control",
    "#keepsake-create-toggle", "#keepsake-form", "#keepsake-title"
  ]) nodes.set(selector, fakeNode());
  nodes.get("#keepsake-id").value = "";
  nodes.get("#keepsake-form").dataset = {};
  nodes.get("#keepsake-grid").querySelectorAll = () => [];
  const root = new FakeRoot(nodes);
  const store = memoryStore(new Map([[
    "account-a:keepsake-batch",
    {
      owner: "account-a",
      id: "keepsake-batch",
      activeIndex: 0,
      items: [{
        itemId: "draft-1",
        blob: new Blob(["draft"], { type: "image/png" }),
        name: "draft.png",
        type: "image/png",
        lastModified: 1,
        title: "",
        tags: "",
        note: "",
        edgeExpansion: 8,
        backgroundOpacityPct: 15,
        status: "waiting"
      }]
    }
  ]]));
  const snapshot = {
    keepsakes: Array.from({ length: 13 }, (_, index) => ({
      id: `keepsake-${index}`,
      title: `小物 ${index}`,
      occurredAt: `2026-10-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      derivativeState: index === 0 ? "pending" : "ready"
    }))
  };
  const harness = createRuntimeHarness({ root, snapshot, store });
  await harness.controller.mount({
    root,
    route: { view: "keepsakes" },
    signal: new AbortController().signal
  });
  assert.ok(harness.urls.created.length > 0, "restored batch must create preview URLs");
  assert.ok(harness.timers.size > 0, "pending derivatives must schedule refresh");
  harness.runFrames();
  assert.equal(harness.observers.length, 1);
  root.dispatch("input", fakeNode({
    id: "keepsake-title",
    closest: selector => selector === "#keepsake-form" ? nodes.get("#keepsake-form") : null
  }));
  assert.ok(harness.timers.size >= 2, "batch edits must schedule persistence");
  root.dispatch("input", fakeNode({
    id: "keepsake-background-opacity",
    value: "20"
  }));
  assert.equal(harness.frames.size, 1, "canvas rendering must own one cancellable RAF");
  await harness.controller.unmount();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.observers[0].disconnected, true);
  assert.deepEqual(
    new Set(harness.urls.revoked),
    new Set(harness.urls.created),
    "unmount must revoke every batch preview URL"
  );
}

{
  const nodes = new Map();
  for (const selector of [
    "#keepsake-batch", "#keepsake-batch-list", "#keepsake-batch-count",
    "#keepsake-upload-box", "#keepsake-editor", "#keepsake-id",
    "#keepsake-grid", "#keepsake-detail", ".keepsake-library"
  ]) nodes.set(selector, fakeNode());
  nodes.get("#keepsake-id").value = "";
  nodes.get("#keepsake-grid").querySelectorAll = () => [];
  const storedBatch = (owner, name) => ({
    owner,
    id: "keepsake-batch",
    items: [{
      itemId: `${owner}-item`,
      blob: new Blob([owner], { type: "image/png" }),
      name,
      type: "image/png",
      status: "waiting"
    }]
  });
  const store = memoryStore(new Map([
    ["account-a:keepsake-batch", storedBatch("account-a", "a.png")],
    ["account-b:keepsake-batch", storedBatch("account-b", "b.png")]
  ]));
  const root = new FakeRoot(nodes);
  const harness = createRuntimeHarness({ root, store });
  await harness.controller.mount({
    root,
    route: { view: "keepsakes" },
    signal: new AbortController().signal
  });
  assert.ok(harness.urls.created.some(url => url.includes("a.png")));
  harness.setAccount("account-b");
  const beforeReset = harness.urls.created.length;
  await harness.controller.resetSession();
  assert.equal(harness.document.listenerCount("paste"), 0);
  await harness.controller.mount({
    root,
    route: { view: "keepsakes" },
    signal: new AbortController().signal
  });
  const afterReset = harness.urls.created.slice(beforeReset);
  assert.ok(afterReset.some(url => url.includes("b.png")));
  assert.equal(afterReset.some(url => url.includes("a.png")), false);
  await harness.controller.unmount();
}

{
  const state = createKeepsakeFeatureState();
  let owner = "account-a";
  let serial = 1;
  const accountAGate = deferred();
  const records = {
    "account-b": {
      owner: "account-b",
      id: "keepsake-batch",
      items: [{
        itemId: "b-item",
        blob: new Blob(["b"], { type: "image/png" }),
        name: "b.png",
        type: "image/png"
      }]
    }
  };
  const drafts = createKeepsakeDrafts({
    state,
    store: {
      get: account => account === "account-a"
        ? accountAGate.promise
        : Promise.resolve(records[account] || null),
      put: async () => {},
      delete: async () => {}
    },
    data: {
      getAccountId: () => owner,
      getSessionSerial: () => serial
    },
    platform: {
      createFile: (blob, name, options) => ({ blob, name, ...options }),
      now: () => "2026-10-06T08:00:00.000Z",
      setTimer: () => 1,
      clearTimer() {},
      objectUrls: {
        createObjectURL: () => "blob:test",
        revokeObjectURL() {}
      }
    }
  });
  const lateA = drafts.restore("account-a");
  await tick();
  owner = "account-b";
  serial += 1;
  assert.equal(await drafts.restore("account-b"), true);
  accountAGate.resolve({
    owner: "account-a",
    id: "keepsake-batch",
    items: [{ itemId: "a-item", blob: new Blob(["a"]), name: "a.png" }]
  });
  assert.equal(await lateA, false);
  assert.equal(state.batch.owner, "account-b");
  assert.deepEqual(state.batch.items.map(item => item.itemId), ["b-item"]);
}

{
  const state = createKeepsakeFeatureState();
  const restoreGate = deferred();
  const deletes = [];
  const writes = [];
  const firstWrite = deferred();
  let writeCount = 0;
  const drafts = createKeepsakeDrafts({
    state,
    store: {
      get: () => restoreGate.promise,
      async put(record) {
        writes.push(record.items[0].title);
        writeCount += 1;
        if (writeCount === 1) await firstWrite.promise;
      },
      async delete(owner, id) {
        deletes.push([owner, id]);
      }
    },
    data: {
      getAccountId: () => "account-a",
      getSessionSerial: () => 1
    },
    platform: {
      createFile: (blob, name, options) => ({ blob, name, ...options }),
      now: () => "2026-10-06T08:00:00.000Z",
      setTimer: () => 1,
      clearTimer() {},
      objectUrls: {
        createObjectURL: () => "blob:test",
        revokeObjectURL() {}
      }
    }
  });
  const restoring = drafts.restore("account-a");
  await tick();
  assert.equal(
    await drafts.flush(),
    false,
    "leaving during restore must not treat an unread draft as empty"
  );
  assert.deepEqual(deletes, []);
  drafts.clearMemory();
  restoreGate.resolve({
    owner: "account-a",
    id: "keepsake-batch",
    items: [{ itemId: "late", blob: new Blob(["late"]), name: "late.png" }]
  });
  assert.equal(await restoring, false);

  drafts.append([{
    itemId: "ordered",
    file: { name: "ordered.png", type: "image/png", lastModified: 1 },
    title: "旧快照"
  }]);
  const oldWrite = drafts.persist();
  state.batch.items[0].title = "新快照";
  const newWrite = drafts.persist();
  await tick();
  assert.deepEqual(writes, ["旧快照"]);
  firstWrite.resolve();
  await Promise.all([oldWrite, newWrite]);
  assert.deepEqual(writes, ["旧快照", "新快照"]);
}

function operationsHarness({ requestImpl, imageDataUrls } = {}) {
  const state = createKeepsakeFeatureState();
  let owner = "account-a";
  let serial = 1;
  let generation = 1;
  const requests = [];
  const nodes = new Map();
  for (const selector of [
    "#keepsake-auto-segment", "#keepsake-segment-status", "#keepsake-id",
    "#keepsake-form", "#keepsake-edge-expansion", "#keepsake-understand",
    "#keepsake-understanding-status", "#keepsake-title", "#keepsake-note",
    "#keepsake-save", "#keepsake-save-status", "#keepsake-workspace",
    "#keepsake-editor", "#keepsake-upload-box"
  ]) nodes.set(selector, fakeNode());
  nodes.get("#keepsake-form").dataset = {};
  nodes.get("#keepsake-edge-expansion").value = "8";
  const editor = {
    sourceDataUrl: "data:image/png;base64,c291cmNl",
    sourceCanvas: {},
    maskCanvas: {},
    segmentGeneration: 0,
    understandingGeneration: 0,
    mediaDirty: true,
    source: "manual",
    file: { name: "source.png" }
  };
  const canvasCalls = { prepare: 0, apply: 0 };
  const canvas = {
    editor: () => editor,
    beginSegmentation: () => ++editor.segmentGeneration,
    beginUnderstanding: () => ++editor.understandingGeneration,
    segmentationDataUrl: () => "data:segment",
    understandingDataUrl: () => "data:understand",
    pushHistory() {},
    async applySegmentedMask() {
      canvasCalls.apply += 1;
      return true;
    },
    async prepare() {
      canvasCalls.prepare += 1;
      return true;
    },
    hasSubject: () => true,
    alphaMaskDataUrl: () => "data:mask",
    reset() {
      editor.segmentGeneration += 1;
      editor.understandingGeneration += 1;
    }
  };
  const drafts = {
    activeItem: () => state.batch.items[state.batch.activeIndex] || null,
    async persist() {},
    append: items => state.batch.items.push(...items),
    select(index) {
      state.batch.activeIndex = index;
    },
    remove(index) {
      const [item] = state.batch.items.splice(index, 1);
      state.batch.activeIndex = 0;
      return item ? { item, wasActive: true } : null;
    }
  };
  let candidate = { title: "", tags: "", note: "" };
  const presentation = {
    query: selector => nodes.get(selector) || null,
    captureBatchItem: () => true,
    resetEditor: () => canvas.reset(),
    populateBatchItem() {},
    candidateFields: () => ({ ...candidate }),
    setTags: values => {
      candidate.tags = values.join(" ");
    },
    beginEdit() {},
    submissionPayload: () => ({
      title: "小物",
      tags: [],
      note: "",
      edgeExpansion: 8,
      backgroundOpacityPct: 15
    })
  };
  const effects = {
    render() {},
    renderBatch() {},
    renderCanvases() {},
    scrollTo() {}
  };
  const data = {
    getSnapshot: () => ({ keepsakes: [] }),
    getAccountId: () => owner,
    getSessionSerial: () => serial,
    getActiveDate: () => "2026-10-06",
    async request(url, options) {
      requests.push({ url, options });
      return requestImpl ? requestImpl(url, options, requests.length) : {};
    },
    refresh: async () => {}
  };
  const lifecycle = {
    createTicket: () => ({ owner, serial, generation }),
    isCurrent: ticket => ticket.owner === owner
      && ticket.serial === serial
      && ticket.generation === generation,
    isSameSession: ticket => ticket.owner === owner && ticket.serial === serial
  };
  const operations = createKeepsakeOperations({
    state,
    data,
    media: {
      validateImages: files => files,
      imageDataUrls: imageDataUrls || (async () => ["data:file"]),
      readBlob: async () => new Blob(),
      dataUrlFromBlob: async () => "data:blob"
    },
    canvas,
    drafts,
    presentation,
    view: {
      showToast() {},
      uncertainSubmission: error => Boolean(error.uncertain),
      localDateTimeForDate: date => `${date}T12:00:00`,
      formatBytes: value => `${value} B`,
      splitTags: value => String(value || "").split(/\s+/).filter(Boolean)
    },
    platform: {
      createRequestId: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
      confirm: () => true
    },
    lifecycle,
    effects
  });
  return {
    operations,
    state,
    nodes,
    editor,
    canvasCalls,
    requests,
    candidate: value => {
      candidate = value;
    },
    invalidate({ account = false, session = false } = {}) {
      if (account) owner = owner === "account-a" ? "account-b" : "account-a";
      if (session) serial += 1;
      generation += 1;
    }
  };
}

{
  const gates = [deferred(), deferred(), deferred()];
  let index = 0;
  const harness = operationsHarness({
    requestImpl: () => gates[index++].promise
  });
  const segment = harness.operations.segment();
  harness.invalidate();
  gates[0].resolve({
    requestId: "id-1",
    targetId: "keepsake-draft",
    inputVersion: 1,
    cutout: "data:cutout"
  });
  assert.equal(await segment, false);
  assert.equal(harness.canvasCalls.apply, 0);

  harness.candidate({ title: "", tags: "", note: "" });
  const understand = harness.operations.understand();
  harness.invalidate({ session: true });
  gates[1].resolve({
    requestId: "id-2",
    targetId: "id-3",
    inputVersion: 1,
    title: "迟到标题"
  });
  assert.equal(await understand, false);
  assert.equal(harness.nodes.get("#keepsake-title").value, "");

  harness.state.activeId = "keepsake-detail";
  const detail = harness.operations.setDetailView("original");
  harness.invalidate({ account: true });
  gates[2].resolve({ originalPath: "/attachments/original.png" });
  assert.equal(await detail, false);
  assert.equal(harness.state.activeOriginalPath, "");
}

{
  const imageGate = deferred();
  const harness = operationsHarness({ imageDataUrls: () => imageGate.promise });
  harness.state.batch.items = [{
    itemId: "batch-stale",
    file: { name: "stale.png" },
    status: "waiting",
    alphaMask: ""
  }];
  const pending = harness.operations.loadBatchItem(0, { capture: false });
  harness.invalidate({ account: true });
  imageGate.resolve(["data:stale"]);
  assert.equal(await pending, false);
  assert.equal(harness.canvasCalls.prepare, 0);
}

function batchSubmissionHarness({ createFailure = null, uploadGate = null } = {}) {
  const calls = [];
  let activeCreateFailure = createFailure;
  const harness = operationsHarness({
    requestImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/images/upload") {
        if (uploadGate) await uploadGate.promise;
        return {
          originalPath: "/attachments/original.png",
          alphaMaskPath: "/attachments/mask.png",
          attachmentPaths: [
            "/attachments/original.png",
            "/attachments/mask.png"
          ]
        };
      }
      if (url === "/api/images/discard") return { discarded: true };
      if (url === "/api/keepsakes" && activeCreateFailure) {
        throw activeCreateFailure;
      }
      return {};
    }
  });
  const item = {
    itemId: "batch-1",
    file: { name: "batch.png" },
    status: "ready",
    alphaMask: "data:mask",
    uploadRequestId: "",
    createRequestId: "",
    mediaPaths: null,
    lastError: null
  };
  harness.state.batch.items = [item];
  harness.nodes.get("#keepsake-form").dataset.batchItemId = item.itemId;
  return {
    ...harness,
    item,
    calls,
    setCreateFailure(value) {
      activeCreateFailure = value;
    }
  };
}

{
  const harness = batchSubmissionHarness();
  const first = harness.operations.submit(harness.nodes.get("#keepsake-form"));
  const second = harness.operations.submit(harness.nodes.get("#keepsake-form"));
  assert.equal(first, second, "duplicate batch saves must share one flight");
  assert.equal(await first, true);
  assert.equal(
    harness.calls.filter(call => call.url === "/api/images/upload").length,
    1
  );
  assert.equal(
    harness.calls.filter(call => call.url === "/api/keepsakes").length,
    1
  );
  assert.equal(harness.calls.find(call => call.url === "/api/keepsakes")
    .options.headers["idempotency-key"], "id-2");
}

{
  const failure = new Error("确定失败");
  const harness = batchSubmissionHarness({ createFailure: failure });
  assert.equal(await harness.operations.submit(harness.nodes.get("#keepsake-form")), false);
  assert.equal(
    harness.calls.filter(call => call.url === "/api/images/discard").length,
    1,
    "definite create failure must compensate the upload lease"
  );
  assert.equal(harness.item.mediaPaths, null);
  assert.equal(harness.item.uploadRequestId, "");
  assert.equal(harness.item.createRequestId, "");
}

{
  const failure = Object.assign(new Error("结果未知"), { uncertain: true });
  const harness = batchSubmissionHarness({ createFailure: failure });
  assert.equal(await harness.operations.submit(harness.nodes.get("#keepsake-form")), false);
  assert.equal(
    harness.calls.filter(call => call.url === "/api/images/discard").length,
    0,
    "uncertain create failure must preserve the upload lease"
  );
  const uploadRequestId = harness.item.uploadRequestId;
  const createRequestId = harness.item.createRequestId;
  assert.ok(harness.item.mediaPaths);
  assert.ok(uploadRequestId);
  assert.ok(createRequestId);
  harness.setCreateFailure(null);
  assert.equal(await harness.operations.submit(harness.nodes.get("#keepsake-form")), true);
  assert.equal(
    harness.calls.filter(call => call.url === "/api/images/upload").length,
    1,
    "uncertain retry must reuse its uploaded media"
  );
  const createCalls = harness.calls.filter(call => call.url === "/api/keepsakes");
  assert.equal(createCalls.length, 2);
  assert.deepEqual(
    createCalls.map(call => call.options.headers["idempotency-key"]),
    [createRequestId, createRequestId],
    "uncertain retry must reuse the create idempotency key"
  );
}

{
  const uploadGate = deferred();
  const harness = batchSubmissionHarness({ uploadGate });
  const pending = harness.operations.submit(harness.nodes.get("#keepsake-form"));
  while (!harness.calls.some(call => call.url === "/api/images/upload")) await tick();
  harness.invalidate({ account: true });
  uploadGate.resolve();
  assert.equal(await pending, false);
  assert.equal(
    harness.calls.filter(call => call.url === "/api/images/discard").length,
    1,
    "stale upload completion must be compensated"
  );
  assert.equal(
    harness.calls.filter(call => call.url === "/api/keepsakes").length,
    0
  );
}

for (const file of [
  "model.mjs",
  "canvas.mjs",
  "drafts.mjs",
  "batch-operations.mjs",
  "operations.mjs",
  "presentation-markup.mjs",
  "presentation.mjs",
  "interactions.mjs",
  "controller.mjs",
  "loader.mjs",
  "index.mjs"
]) {
  const source = await readFile(
    new URL(`../public/frontend/features/keepsakes/${file}`, import.meta.url),
    "utf8"
  );
  assert.equal(source.includes("frontend/app/runtime.mjs"), false);
  assert.ok(source.split(/\r?\n/).length <= 500, `${file} exceeds 500 lines`);
}

console.log(
  "Frontend keepsakes feature checks passed: fresh disposable lifecycle, 20-cycle "
  + "listener stability, account-safe draft restoration, timer/RAF/observer/Blob URL "
  + "cleanup, stale segmentation/understanding/detail/batch rejection, and idempotent "
  + "batch upload compensation contracts."
);
