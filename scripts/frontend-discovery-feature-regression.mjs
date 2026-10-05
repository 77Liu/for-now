import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  DISCOVERY_GENRES,
  THOUGHT_DISCOVERY_TYPES,
  createDiscoveryFeatureController
} from "../public/frontend/features/thought-discovery/index.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

const dataKey = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeNode {
  constructor(root, { id = "", value = "", checked = false, dataset = {} } = {}) {
    this.root = root;
    this.id = id;
    this.value = value;
    this.checked = checked;
    this.dataset = { ...dataset };
    this.disabled = false;
    this.hidden = false;
    this._innerHTML = "";
    this._textContent = "";
    this.innerHtmlWrites = [];
    this.textWrites = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.innerHtmlWrites.push(this._innerHTML);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.textWrites.push(this._textContent);
  }

  focus() {
    this.root.focused = this;
  }

  closest(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1) ? this : null;
    const attribute = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!attribute) return null;
    const key = dataKey(attribute[1]);
    if (!Object.hasOwn(this.dataset, key)) return null;
    return attribute[2] === undefined || String(this.dataset[key]) === attribute[2]
      ? this
      : null;
  }
}

class FakeRoot {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.focused = null;
    this.form = new FakeNode(this, { id: "discovery-form" });
    this.query = new FakeNode(this, { id: "discovery-query" });
    this.count = new FakeNode(this, { id: "discovery-count" });
    this.status = new FakeNode(this, { id: "discovery-status" });
    this.list = new FakeNode(this, { id: "discovery-list" });
    this.more = new FakeNode(this, { id: "discovery-more" });
    this.random = new FakeNode(this, { id: "discovery-random" });
    this.freshOnly = new FakeNode(this);
    this.types = THOUGHT_DISCOVERY_TYPES.map(value => (
      new FakeNode(this, { value, checked: true })
    ));
    this.genres = DISCOVERY_GENRES.map(value => (
      new FakeNode(this, { value, checked: true })
    ));
    this.nodes = new Map([
      ["#discovery-form", this.form],
      ["#discovery-query", this.query],
      ["#discovery-count", this.count],
      ["#discovery-status", this.status],
      ["#discovery-list", this.list],
      ["#discovery-more", this.more],
      ["#discovery-random", this.random],
      ['#discovery-form input[name="freshOnly"]', this.freshOnly]
    ]);
  }

  querySelector(selector) {
    return this.nodes.get(selector) || null;
  }

  querySelectorAll(selector) {
    const type = selector.includes('input[name="type"]');
    const genre = selector.includes('input[name="genre"]');
    const values = type ? this.types : genre ? this.genres : [];
    return selector.endsWith(":checked") ? values.filter(input => input.checked) : values;
  }

  contains(element) {
    return element?.root === this;
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

  dispatch(type, target) {
    let prevented = false;
    const event = {
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return prevented;
  }

  click(target) {
    return this.dispatch("click", target);
  }

  submit() {
    return this.dispatch("submit", this.form);
  }

  button({ id = "", dataset = {} } = {}) {
    return new FakeNode(this, { id, dataset });
  }

  writeCount() {
    return [this.count, this.status, this.list, this.more]
      .reduce((total, node) => total + node.textWrites.length + node.innerHtmlWrites.length, 0);
  }
}

const v1 = (data, meta = {}) => ({ data, meta });

function discoveryItem(id, genre = "thought", extra = {}) {
  const labels = {
    thought: "思绪",
    capture: "捕念",
    journal: "日记",
    bookExcerpt: "书摘",
    quote: "善言"
  };
  return {
    id,
    key: `${genre}:${id}`,
    genre,
    genreLabel: labels[genre],
    resourceType: genre === "bookExcerpt" ? "book" : genre,
    resourceId: id,
    title: `${labels[genre]} ${id}`,
    question: { content: `问题 ${id}` },
    matches: [{ content: `正文 ${id}`, sourceLabel: "用户原文" }],
    matchCount: 1,
    occurredAt: "2026-10-05T08:00:00.000Z",
    status: {
      version: 1,
      read: false,
      snoozed: false,
      snoozedUntil: null
    },
    fresh: genre === "thought",
    untraced: genre === "thought",
    ...extra
  };
}

function feature({
  requestV1,
  createAction = async () => {},
  navigate = () => {},
  showToast = () => {},
  createRequestId = () => "request-1",
  restorePendingStatuses = null
}) {
  return createDiscoveryFeatureController({
    requestV1,
    createAction,
    navigate,
    showToast,
    formatDate: value => `日期:${value}`,
    plainPreview: value => String(value ?? "").replace(/\s+/g, " ").trim(),
    createRequestId,
    now: () => Date.parse("2026-10-05T12:00:00.000Z"),
    restorePendingStatuses
  });
}

const indexSource = await fs.readFile(
  new URL("../public/frontend/features/thought-discovery/index.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(indexSource, /\b(?:document|window|fetch|XMLHttpRequest)\b/);
assert.doesNotMatch(indexSource, /\b(?:function|const|let|class)\b|=>/);
assert.ok(
  indexSource.split("\n").filter(Boolean).every(line => (
    /^(?:export \{|\s{2}[\w,]+|\} from ".+";)$/.test(line)
  )),
  "discovery index must remain a pure re-export"
);

const controllerSource = await fs.readFile(
  new URL("../public/frontend/features/thought-discovery/controller.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(
  controllerSource,
  /from\s+["'][^"']*(?:\/app\/|\/runtime|\/features\/actions|\/features\/[^t])/
);
assert.match(controllerSource, /\/api\/v1\/discovery/);
assert.match(controllerSource, /\/api\/v1\/thought-chains\//);

{
  const calls = [];
  const actions = [];
  const navigated = [];
  let restored = 0;
  const root = new FakeRoot("success");
  const controller = feature({
    async requestV1(path, options, metadata) {
      calls.push({ path, options, metadata });
      if (path.startsWith("/api/v1/discovery/random")) {
        return v1(discoveryItem("random-capture", "capture"), { total: 4 });
      }
      const url = new URL(path, "https://local.invalid");
      if (url.searchParams.get("cursor") === "page-2") {
        return v1([discoveryItem("quote-2", "quote")], {
          total: 3,
          nextCursor: ""
        });
      }
      if (url.searchParams.get("q") === "跨体裁") {
        return v1([discoveryItem("filtered-capture", "capture")], {
          total: 1,
          nextCursor: ""
        });
      }
      return v1([
        discoveryItem("thought-1"),
        discoveryItem("capture-1", "capture")
      ], {
        total: 3,
        untracedCount: 1,
        totalUntracedCount: 1,
        nextCursor: "page-2"
      });
    },
    async createAction(payload, options) {
      actions.push({ payload, options });
    },
    navigate: item => navigated.push(item.id),
    restorePendingStatuses: () => {
      restored += 1;
      return [{
        projection: {
          kind: "discovery.status",
          id: "thought-1",
          value: {
            id: "thought-1",
            status: { version: 2, read: true, snoozed: false },
            fresh: false,
            untraced: true
          }
        }
      }];
    }
  });
  const activation = new AbortController();
  const dispose = controller.mount({
    root,
    route: { view: "discovery", accountId: "account-a" },
    signal: activation.signal
  });
  assert.equal(typeof dispose, "function", "mount must return a synchronous disposer");
  await waitFor(() => root.list.innerHTML.includes("thought-1"), "initial discovery did not render");

  const firstUrl = new URL(calls[0].path, "https://local.invalid");
  assert.equal(firstUrl.pathname, "/api/v1/discovery");
  assert.deepEqual(firstUrl.searchParams.getAll("genre"), DISCOVERY_GENRES);
  assert.deepEqual(firstUrl.searchParams.getAll("type"), THOUGHT_DISCOVERY_TYPES);
  assert.equal(firstUrl.searchParams.get("limit"), "20");
  assert.equal(calls[0].options.signal, activation.signal);
  assert.match(root.count.textContent, /3 条/);
  assert.match(root.list.innerHTML, /捕念 capture-1/);

  assert.equal(controller.render({ snapshot: {}, changedDomains: undefined }), true);
  await waitFor(() => restored === 1, "pending discovery statuses were not restored");
  await waitFor(() => root.list.innerHTML.includes("已读"), "pending discovery status was not applied");
  controller.render({ snapshot: {}, changedDomains: ["thoughts"] });
  await flush();
  assert.equal(restored, 1, "pending discovery statuses must restore once per activation");

  const more = root.button({ id: "discovery-more" });
  assert.equal(root.click(more), true);
  await waitFor(() => root.list.innerHTML.includes("quote-2"), "pagination did not append");
  const pageUrl = new URL(calls.at(-1).path, "https://local.invalid");
  assert.equal(pageUrl.searchParams.get("cursor"), "page-2");

  root.query.value = " 跨体裁 ";
  root.types.forEach(input => {
    input.checked = ["question", "answer"].includes(input.value);
  });
  root.genres.forEach(input => {
    input.checked = ["capture", "quote"].includes(input.value);
  });
  root.freshOnly.checked = true;
  assert.equal(root.submit(), true);
  await waitFor(
    () => root.list.innerHTML.includes("filtered-capture"),
    "filtered discovery did not render"
  );
  const filteredUrl = new URL(calls.at(-1).path, "https://local.invalid");
  assert.equal(filteredUrl.searchParams.get("q"), "跨体裁");
  assert.deepEqual(filteredUrl.searchParams.getAll("type"), ["question", "answer"]);
  assert.deepEqual(filteredUrl.searchParams.getAll("genre"), ["capture", "quote"]);
  assert.equal(filteredUrl.searchParams.get("fresh"), "1");

  const action = root.button({
    dataset: { discoveryAction: "capture:filtered-capture" }
  });
  root.click(action);
  await waitFor(() => actions.length === 1, "discovery action was not created");
  assert.deepEqual(actions[0], {
    payload: {
      title: "捕念 filtered-capture",
      priority: "none",
      sourceRef: { type: "capture", id: "filtered-capture", label: "寻迹" }
    },
    options: { idempotencyKey: "request-1" }
  });

  root.click(root.button({ id: "discovery-random" }));
  await waitFor(() => navigated.includes("random-capture"), "random door did not navigate");
  assert.ok(calls.at(-1).path.startsWith("/api/v1/discovery/random?"));
  assert.equal(calls.at(-1).options.signal, activation.signal);

  dispose();
  assert.equal(root.listenerCount("click"), 0);
  assert.equal(root.listenerCount("submit"), 0);
}

{
  let attempt = 0;
  const root = new FakeRoot("failure-retry-empty");
  const controller = feature({
    async requestV1() {
      attempt += 1;
      if (attempt === 1) throw new Error("internal discovery detail");
      if (attempt === 2) return v1([discoveryItem("retry-success")], { total: 1 });
      return v1([], { total: 0 });
    }
  });
  controller.mount({
    root,
    route: { view: "discovery" },
    signal: new AbortController().signal
  });
  await waitFor(
    () => root.list.innerHTML.includes("暂时无法查找旧记录"),
    "failure state did not render"
  );
  assert.doesNotMatch(root.list.innerHTML, /internal discovery detail/);
  assert.match(root.list.innerHTML, /retry-discovery/);

  root.click(root.button({ dataset: { contentAction: "retry-discovery" } }));
  await waitFor(() => root.list.innerHTML.includes("retry-success"), "retry did not recover");

  root.submit();
  await waitFor(
    () => root.list.innerHTML.includes("没有符合条件的记录"),
    "empty state did not render"
  );
  assert.equal(root.more.hidden, true);
  root.click(root.button({ dataset: { contentFocus: "discovery-query" } }));
  assert.equal(root.focused, root.query);
  controller.unmount();
}

{
  const root = new FakeRoot("lifecycle");
  let reads = 0;
  const controller = feature({
    async requestV1() {
      reads += 1;
      return v1([discoveryItem(`cycle-${reads}`)], { total: 1 });
    }
  });
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const signal = new AbortController();
    const dispose = controller.mount({
      root,
      route: { view: "discovery", cycle },
      signal: signal.signal
    });
    await waitFor(() => root.list.innerHTML.includes(`cycle-${cycle + 1}`), "cycle did not load");
    assert.equal(root.listenerCount("click"), 1);
    assert.equal(root.listenerCount("submit"), 1);
    dispose();
    dispose();
    assert.equal(root.listenerCount("click"), 0);
    assert.equal(root.listenerCount("submit"), 0);
  }
  assert.equal(reads, 20);
}

{
  const paths = [];
  const root = new FakeRoot("retained-filters");
  const controller = feature({
    async requestV1(path) {
      paths.push(path);
      return v1([discoveryItem(`filter-read-${paths.length}`)], { total: 1 });
    }
  });
  const firstDispose = controller.mount({
    root,
    route: { view: "discovery", visit: 1 },
    signal: new AbortController().signal
  });
  await waitFor(() => root.list.innerHTML.includes("filter-read-1"), "filter fixture did not load");
  root.query.value = "保留条件";
  root.types.forEach(input => {
    input.checked = input.value === "answer";
  });
  root.genres.forEach(input => {
    input.checked = input.value === "journal";
  });
  root.freshOnly.checked = true;
  root.submit();
  await waitFor(() => root.list.innerHTML.includes("filter-read-2"), "filtered read did not settle");
  firstDispose();

  const secondDispose = controller.mount({
    root,
    route: { view: "discovery", visit: 2 },
    signal: new AbortController().signal
  });
  assert.equal(root.query.value, "保留条件");
  assert.deepEqual(root.types.filter(input => input.checked).map(input => input.value), ["answer"]);
  assert.deepEqual(root.genres.filter(input => input.checked).map(input => input.value), ["journal"]);
  assert.equal(root.freshOnly.checked, true);
  await waitFor(() => paths.length === 3, "remount did not refresh retained filters");
  const retainedUrl = new URL(paths[2], "https://local.invalid");
  assert.equal(retainedUrl.searchParams.get("q"), "保留条件");
  assert.deepEqual(retainedUrl.searchParams.getAll("type"), ["answer"]);
  assert.deepEqual(retainedUrl.searchParams.getAll("genre"), ["journal"]);
  assert.equal(retainedUrl.searchParams.get("fresh"), "1");
  secondDispose();
}

{
  const gate = deferred();
  const root = new FakeRoot("pending-get");
  let seenSignal;
  const controller = feature({
    requestV1(path, options) {
      assert.ok(path.startsWith("/api/v1/discovery?"));
      seenSignal = options.signal;
      return gate.promise;
    }
  });
  const signal = new AbortController();
  controller.mount({
    root,
    route: { view: "discovery", accountId: "old" },
    signal: signal.signal
  });
  await waitFor(() => seenSignal === signal.signal, "GET did not receive activation signal");
  signal.abort();
  const writesAfterLeave = root.writeCount();
  gate.resolve(v1([discoveryItem("must-not-render")], { total: 1 }));
  await flush();
  await flush();
  assert.equal(root.writeCount(), writesAfterLeave);
  assert.doesNotMatch(root.list.innerHTML, /must-not-render/);
}

{
  const patchGate = deferred();
  const calls = [];
  const navigated = [];
  const toasts = [];
  const root = new FakeRoot("pending-patch");
  const controller = feature({
    requestV1(path, options, metadata) {
      calls.push({ path, options, metadata });
      if (options?.method === "PATCH") return patchGate.promise;
      return Promise.resolve(v1([discoveryItem("pending-read")], { total: 1 }));
    },
    navigate: item => navigated.push(item.id),
    showToast: (...args) => toasts.push(args)
  });
  const signal = new AbortController();
  controller.mount({
    root,
    route: { view: "discovery", accountId: "old" },
    signal: signal.signal
  });
  await waitFor(() => root.list.innerHTML.includes("pending-read"), "pending PATCH fixture did not load");
  root.click(root.button({ dataset: { discoveryOpen: "thought:pending-read" } }));
  await waitFor(
    () => calls.some(call => call.options?.method === "PATCH"),
    "markRead PATCH did not start"
  );
  const patch = calls.find(call => call.options?.method === "PATCH");
  assert.equal(Object.hasOwn(patch.options, "signal"), false, "PATCH must survive route leave");
  assert.deepEqual(patch.metadata.domains, ["thoughts"]);
  assert.equal(patch.metadata.projection.kind, "discovery.status");

  signal.abort();
  const writesAfterLeave = root.writeCount();
  patchGate.resolve(v1({
    id: "pending-read",
    status: { version: 2, read: true },
    fresh: false,
    untraced: true
  }));
  await flush();
  await flush();
  assert.equal(root.writeCount(), writesAfterLeave);
  assert.deepEqual(navigated, []);
  assert.deepEqual(toasts, []);
}

{
  const actionCalls = [];
  const navigated = [];
  const toasts = [];
  let actionAttempts = 0;
  let requestIds = 0;
  const root = new FakeRoot("operations");
  const controller = feature({
    async requestV1(path, options) {
      if (options?.method === "PATCH") {
        const action = JSON.parse(options.body).action;
        throw new Error(`${action} unavailable`);
      }
      return v1([discoveryItem("operation-item")], { total: 1 });
    },
    async createAction(payload, options) {
      actionAttempts += 1;
      actionCalls.push({ payload, options });
      if (actionAttempts === 1) throw new Error("action unavailable");
    },
    navigate: item => navigated.push(item.id),
    showToast: (...args) => toasts.push(args),
    createRequestId: () => `action-request-${++requestIds}`
  });
  controller.mount({
    root,
    route: { view: "discovery" },
    signal: new AbortController().signal
  });
  await waitFor(() => root.list.innerHTML.includes("operation-item"), "operation fixture did not load");

  root.click(root.button({ dataset: { discoveryOpen: "thought:operation-item" } }));
  await waitFor(() => navigated.length === 1, "markRead failure prevented navigation");
  assert.equal(navigated[0], "operation-item");
  assert.ok(toasts.some(([message, kind]) => (
    kind === "error" && message.includes("原记录已打开，但回访状态更新失败")
  )));

  root.click(root.button({ dataset: { discoverySnooze: "thought:operation-item" } }));
  await waitFor(
    () => toasts.some(([message]) => message.includes("暂时无法安排明天再看")),
    "snooze failure was not surfaced"
  );
  assert.match(root.list.innerHTML, /operation-item/);

  const action = root.button({
    dataset: { discoveryAction: "thought:operation-item" }
  });
  root.click(action);
  await waitFor(() => actionCalls.length === 1 && action.disabled === false, "first action attempt did not settle");
  assert.equal(action.dataset.requestId, "action-request-1");
  root.click(action);
  await waitFor(() => actionCalls.length === 2 && action.disabled === false, "action retry did not settle");
  assert.equal(actionCalls[0].options.idempotencyKey, "action-request-1");
  assert.equal(actionCalls[1].options.idempotencyKey, "action-request-1");
  assert.equal(requestIds, 1);
  assert.equal(action.dataset.requestId, undefined);
  assert.ok(toasts.some(([message]) => message === "已转为行动"));
  controller.unmount();
}

{
  let account = "account-a";
  let requestIds = 0;
  const actionKeys = [];
  const root = new FakeRoot("reset-account");
  const controller = feature({
    async requestV1(path) {
      const url = new URL(path, "https://local.invalid");
      return v1([
        discoveryItem(account === "account-a" ? "private-account-a" : "account-b-item")
      ], {
        total: 1,
        query: url.searchParams.get("q")
      });
    },
    async createAction(_payload, options) {
      actionKeys.push(options.idempotencyKey);
      throw new Error("retain request id");
    },
    createRequestId: () => `reset-request-${++requestIds}`
  });
  controller.mount({
    root,
    route: { view: "discovery", accountId: account },
    signal: new AbortController().signal
  });
  await waitFor(() => root.list.innerHTML.includes("private-account-a"), "account A did not load");
  root.query.value = "账户 A 私密查询";
  root.submit();
  await waitFor(
    () => root.list.innerHTML.includes("private-account-a"),
    "account A filtered read did not settle"
  );
  const firstAction = root.button({
    dataset: { discoveryAction: "thought:private-account-a" }
  });
  root.click(firstAction);
  await waitFor(() => actionKeys.length === 1, "account A action did not start");
  assert.equal(firstAction.dataset.requestId, "reset-request-1");

  controller.resetSession();
  assert.equal(root.list.innerHTML, "");
  assert.equal(root.count.textContent, "");
  assert.equal(root.status.textContent, "");
  assert.equal(root.query.value, "");
  assert.equal(root.freshOnly.checked, false);
  assert.ok(root.types.every(input => input.checked));
  assert.ok(root.genres.every(input => input.checked));

  account = "account-b";
  controller.mount({
    root,
    route: { view: "discovery", accountId: account },
    signal: new AbortController().signal
  });
  await waitFor(() => root.list.innerHTML.includes("account-b-item"), "account B did not load");
  assert.doesNotMatch(root.list.innerHTML, /private-account-a|账户 A 私密查询/);
  const secondAction = root.button({
    dataset: { discoveryAction: "thought:account-b-item" }
  });
  root.click(secondAction);
  await waitFor(() => actionKeys.length === 2, "account B action did not start");
  assert.deepEqual(actionKeys, ["reset-request-1", "reset-request-2"]);
  controller.resetSession();
}

{
  const startup = deferred();
  let reads = 0;
  let restores = 0;
  const root = new FakeRoot("startup-recovery");
  const controller = feature({
    requestV1() {
      reads += 1;
      if (reads === 1) return startup.promise;
      return Promise.resolve(v1([discoveryItem("recovered-after-state")], { total: 1 }));
    },
    restorePendingStatuses() {
      restores += 1;
    }
  });
  controller.mount({
    root,
    route: { view: "discovery" },
    signal: new AbortController().signal
  });
  assert.equal(controller.render({
    snapshot: { accountId: "account-a" },
    changedDomains: ["thoughts"]
  }), true);
  startup.reject(new Error("startup state not ready"));
  await waitFor(
    () => root.list.innerHTML.includes("recovered-after-state"),
    "first application state notification did not recover startup read"
  );
  await waitFor(() => restores === 1, "recovered read did not restore pending statuses");
  controller.render({ snapshot: {}, changedDomains: ["thoughts"] });
  controller.render({ snapshot: {}, changedDomains: ["captures"] });
  await flush();
  assert.equal(reads, 2, "state renders must not retry startup read indefinitely");
  assert.equal(restores, 1);
  controller.unmount();
}

{
  const firstRoot = new FakeRoot("first-instance");
  const secondRoot = new FakeRoot("second-instance");
  const first = feature({
    requestV1: async () => v1([discoveryItem("first-private")], { total: 1 })
  });
  const second = feature({
    requestV1: async () => v1([discoveryItem("second-private")], { total: 1 })
  });
  assert.notEqual(first, second);
  first.mount({
    root: firstRoot,
    route: { accountId: "first" },
    signal: new AbortController().signal
  });
  second.mount({
    root: secondRoot,
    route: { accountId: "second" },
    signal: new AbortController().signal
  });
  await waitFor(() => firstRoot.list.innerHTML.includes("first-private"), "first instance did not load");
  await waitFor(() => secondRoot.list.innerHTML.includes("second-private"), "second instance did not load");
  first.resetSession();
  assert.equal(firstRoot.list.innerHTML, "");
  assert.match(secondRoot.list.innerHTML, /second-private/);
  assert.equal(secondRoot.listenerCount("click"), 1);
  second.unmount();
}

console.log("Frontend discovery feature checks passed: rendering, filters, pagination, lifecycle races, status actions, idempotency, startup recovery and account isolation.");
