import assert from "node:assert/strict";
import {
  createHealthDraftLifecycle,
  createHealthFeatureController,
  healthDraftKey
} from "../public/frontend/features/health/controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createStore() {
  const records = new Map();
  const calls = [];
  const key = (owner, id) => `${owner}:${id}`;
  return {
    calls,
    records,
    async get(owner, id) {
      calls.push(["get", owner, id]);
      return structuredClone(records.get(key(owner, id)) || null);
    },
    async put(value) {
      calls.push(["put", value.owner, value.id]);
      records.set(key(value.owner, value.id), structuredClone(value));
    },
    async delete(owner, id) {
      calls.push(["delete", owner, id]);
      records.delete(key(owner, id));
    }
  };
}

const blob = name => ({
  name,
  type: "image/png",
  size: 12,
  lastModified: 1
});
const createFile = (parts, name, options) => ({
  blob: parts[0],
  name,
  type: options.type,
  lastModified: options.lastModified,
  size: parts[0]?.size || 0
});
const storedItem = (name, extra = {}) => ({
  blob: blob(name),
  name,
  type: "image/png",
  lastModified: 1,
  ...extra
});

const store = createStore();
const delayedAccounts = new Map();
const discarded = [];
const lifecycle = createHealthDraftLifecycle({
  store,
  listOperations: owner => delayedAccounts.get(owner)?.promise || Promise.resolve([]),
  discardItem: async item => {
    discarded.push([item.uploadedPath, item.uploadRequestId]);
    return true;
  },
  createId: (() => {
    let value = 0;
    return () => `item-${++value}`;
  })(),
  createFile,
  now: () => Date.parse("2026-10-06T08:00:00.000Z")
});

store.records.set("account-a:health:sleep:2026-10-05", {
  owner: "account-a",
  id: "health:sleep:2026-10-05",
  date: "2026-10-05",
  items: [storedItem("account-a.png")]
});
store.records.set("account-b:health:sleep:2026-10-06", {
  owner: "account-b",
  id: "health:sleep:2026-10-06",
  date: "2026-10-06",
  items: [storedItem("account-b.png")]
});
const accountAGate = deferred();
delayedAccounts.set("account-a", accountAGate);
const lateAccountA = lifecycle.restore("account-a", "2026-10-05");
await Promise.resolve();
assert.equal(await lifecycle.restore("account-b", "2026-10-06"), true);
assert.equal(lifecycle.owner(), "account-b");
assert.equal(lifecycle.draft("sleep").items[0].file.name, "account-b.png");
accountAGate.resolve([]);
assert.equal(await lateAccountA, false);
assert.equal(lifecycle.owner(), "account-b");
assert.equal(lifecycle.draft("sleep").items[0].file.name, "account-b.png");

const weight = lifecycle.draft("weight");
Object.assign(weight, {
  date: "2026-10-06",
  items: [{
    file: blob("weight.png"),
    itemId: "weight-1",
    assignedDate: "2026-10-01",
    revision: 2,
    status: "review",
    recognition: { measuredWeight: 70 },
    uploadRequestId: "upload-weight",
    uploadedPath: "/attachments/weight.png"
  }],
  activeIndex: 0
});
await lifecycle.persist("weight");
store.records.set("account-b:health:sleep:2026-10-07", {
  owner: "account-b",
  id: "health:sleep:2026-10-07",
  date: "2026-10-07",
  items: [storedItem("next-day.png")]
});
assert.equal(await lifecycle.changeDate("2026-10-07"), true);
assert.equal(lifecycle.date(), "2026-10-07");
assert.equal(lifecycle.draft("sleep").items[0].file.name, "next-day.png");
assert.equal(lifecycle.draft("weight").items[0].assignedDate, "2026-10-01");

await lifecycle.discard("weight");
assert.deepEqual(discarded, [["/attachments/weight.png", "upload-weight"]]);
assert.equal(store.records.has(`account-b:${healthDraftKey("weight", "2026-10-07")}`), false);
await lifecycle.discard("weight");
assert.equal(discarded.length, 1, "repeated cleanup must not discard the same lease twice");

store.records.set("account-b:health:weight:batch", {
  owner: "account-b",
  id: "health:weight:batch",
  date: "2026-10-07",
  activeIndex: 1,
  items: [
    storedItem("committed.png", {
      itemId: "committed",
      assignedDate: "2026-10-01",
      submissionOperationId: "operation-committed"
    }),
    storedItem("conflict.png", {
      itemId: "conflict",
      assignedDate: "2026-10-02",
      createRequestId: "create-conflict",
      submissionOperationId: "operation-conflict"
    })
  ]
});
delayedAccounts.set("account-b", {
  promise: Promise.resolve([
    { operationId: "operation-committed", status: "committed" },
    { operationId: "operation-conflict", status: "conflict" }
  ])
});
await lifecycle.restore("account-b", "2026-10-07");
assert.deepEqual(
  lifecycle.draft("weight").items.map(item => ({
    id: item.itemId,
    status: item.status,
    operationId: item.submissionOperationId,
    createRequestId: item.createRequestId
  })),
  [{
    id: "conflict",
    status: "conflict",
    operationId: "",
    createRequestId: ""
  }]
);
assert.equal(lifecycle.draft("weight").activeIndex, 0);

class FakeRoot {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) || new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function createDelegate() {
  let mounted = false;
  return {
    mounts: 0,
    unmounts: 0,
    resets: 0,
    async mount() {
      mounted = true;
      this.mounts += 1;
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        mounted = false;
        this.unmounts += 1;
        return true;
      };
    },
    render() {
      return mounted;
    },
    async unmount() {
      if (!mounted) return false;
      mounted = false;
      this.unmounts += 1;
      return true;
    },
    async resetSession() {
      this.resets += 1;
    }
  };
}

const emptyStore = createStore();
const delegate = createDelegate();
let accountId = "account-controller";
let activeDate = "2026-10-06";
let activeType = "sleep";
const controller = createHealthFeatureController({
  delegate,
  request: async () => ({}),
  draftStore: emptyStore,
  listOperations: async () => [],
  getAccountId: () => accountId,
  getActiveDate: () => activeDate,
  getActiveType: () => activeType,
  setActiveType: value => {
    activeType = value;
  },
  renderRecords() {},
  resetOccurrenceInput() {},
  imageDataUrls: async () => [],
  validateImageFiles: files => [...files],
  escapeMarkup: value => String(value),
  localDateTimeForDate: date => `${date}T12:00:00`,
  toLocalDateTimeInput: value => String(value),
  typeMeta: {
    sleep: { label: "睡眠", save: "保存睡眠" },
    heartRate: { label: "心率", save: "保存心率" },
    weight: { label: "体重", save: "保存体重" },
    exercise: { label: "运动", save: "保存运动" }
  },
  createId: () => "request-id",
  createFile,
  objectUrls: {
    createObjectURL: () => "blob:test",
    revokeObjectURL() {}
  }
});
const root = new FakeRoot();
const eventTypes = [
  "click",
  "change",
  "input",
  "keydown",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
  "paste"
];
let previousDispose = null;
for (let cycle = 0; cycle < 20; cycle += 1) {
  const dispose = await controller.mount({
    root,
    route: { view: "daily" },
    signal: new AbortController().signal
  });
  for (const type of eventTypes) assert.equal(root.listenerCount(type), 1);
  if (previousDispose) assert.equal(await previousDispose(), false);
  previousDispose = dispose;
}
assert.equal(await previousDispose(), true);
assert.equal(await previousDispose(), false);
for (const type of eventTypes) assert.equal(root.listenerCount(type), 0);
await controller.resetSession();
assert.equal(delegate.resets, 1);
activeDate = "2026-10-07";
accountId = "";
const coldDispose = await controller.mount({
  root,
  route: { view: "daily" },
  signal: new AbortController().signal
});
const getsBeforeAccount = emptyStore.calls.filter(call => call[0] === "get").length;
accountId = "account-after-reset";
await controller.render();
assert.ok(
  emptyStore.calls.slice(getsBeforeAccount).some(call => (
    call[0] === "get" && call[1] === "account-after-reset"
  )),
  "direct daily startup must hydrate again after the authenticated account becomes available"
);
await coldDispose();

console.log(
  "Frontend health feature checks passed: account-stale and cold-start hydration, "
  + "date-scoped recovery, lease cleanup, queued batch recovery and disposable listeners."
);
