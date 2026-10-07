import assert from "node:assert/strict";
import {
  createTrashFeatureController,
  createTrashModel,
  createTrashPresentation,
  trashDetailRows,
  TRASH_PURGE_CONFIRMATION,
  TRASH_RESTORE_DOMAINS,
  TRASH_SELECTORS
} from "../public/frontend/features/trash/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

const escapeMarkup = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
})[character]);
const contentState = ({ kind = "empty", title, body, action } = {}) => {
  const command = action?.command
    ? ` data-content-action="${escapeMarkup(action.command)}"`
    : "";
  const view = action?.view ? ` data-view="${escapeMarkup(action.view)}"` : "";
  const button = action
    ? `<button${command}${view}>${escapeMarkup(action.label)}</button>`
    : "";
  return `<section class="content-state ${kind}"><strong>${escapeMarkup(title)}</strong><p>${escapeMarkup(body)}</p>${button}</section>`;
};
const viewPorts = overrides => ({
  formatDate: value => `date:${value}`,
  contentState,
  escapeMarkup,
  plainPreview: value => String(value ?? "").replaceAll("*", ""),
  renderMarkdown: value => `<markdown>${escapeMarkup(value)}</markdown>`,
  renderLatex: () => false,
  showToast() {},
  ...overrides
});

class FakeNode {
  constructor(root, { id = "", dataset = {} } = {}) {
    this.root = root;
    this.id = id;
    this.dataset = { ...dataset };
    this.value = "";
    this.checked = false;
    this.isConnected = true;
    this._innerHTML = "";
    this._textContent = "";
    this._disabled = false;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.root.writes += 1;
  }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value);
    this.root.writes += 1;
  }
  get disabled() { return this._disabled; }
  set disabled(value) {
    this._disabled = Boolean(value);
    this.root.writes += 1;
  }
  closest(selector) {
    if (selector === TRASH_SELECTORS.purge && this.id === "trash-purge-selected") {
      return this;
    }
    if (
      selector === TRASH_SELECTORS.retry
      && this.dataset.contentAction === "retry-trash"
    ) return this;
    if (selector === TRASH_SELECTORS.restore && this.dataset.trashRestore != null) {
      return this;
    }
    if (selector === TRASH_SELECTORS.select && this.dataset.trashSelect != null) {
      return this;
    }
    return null;
  }
}

class FakeRoot {
  constructor(name = "trash") {
    this.name = name;
    this.writes = 0;
    this.listeners = new Map();
    this.list = new FakeNode(this);
    this.status = new FakeNode(this);
    this.retention = new FakeNode(this);
    this.purge = new FakeNode(this, { id: "trash-purge-selected" });
  }
  querySelector(selector) {
    return {
      [TRASH_SELECTORS.list]: this.list,
      [TRASH_SELECTORS.status]: this.status,
      [TRASH_SELECTORS.retention]: this.retention,
      [TRASH_SELECTORS.purge]: this.purge
    }[selector] || null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  contains(node) {
    return node?.root === this;
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
  target(options) {
    return new FakeNode(this, options);
  }
}

const trashEntry = (id = "trash-1", content = "已删除正文") => ({
  id,
  type: "thoughtChain",
  deletedAt: "2026-10-06T08:00:00.000Z",
  purgeAfter: "2026-11-05T08:00:00.000Z",
  payload: {
    items: [{
      item: {
        id: "private-item-id",
        type: "question",
        content,
        origin: "manual",
        authorType: "user",
        disposition: "kept",
        occurredOn: "2026-10-06",
        clientRequestId: "private-request-id",
        attachmentPaths: ["/attachments/private.png"]
      }
    }]
  }
});

function createHarness({
  request = async () => ({ items: [] }),
  refresh = async () => {},
  prompt = () => null,
  confirm = () => true,
  view = {}
} = {}) {
  let account = "account-a";
  let serial = 1;
  const requests = [];
  const refreshes = [];
  const prompts = [];
  const confirms = [];
  const toasts = [];
  const latex = [];
  const controller = createTrashFeatureController({
    data: {
      getAccountId: () => account,
      getSessionSerial: () => serial,
      async request(path, options) {
        requests.push([path, options]);
        return request(path, options);
      },
      async refresh(domains) {
        refreshes.push(domains);
        return refresh(domains);
      }
    },
    view: viewPorts({
      renderLatex(container) {
        latex.push(container);
        return false;
      },
      showToast(...args) {
        toasts.push(args);
      },
      ...view
    }),
    platform: {
      prompt(...args) {
        prompts.push(args);
        return prompt(...args);
      },
      confirm(...args) {
        confirms.push(args);
        return confirm(...args);
      }
    }
  });
  return {
    controller,
    requests,
    refreshes,
    prompts,
    confirms,
    toasts,
    latex,
    setAccount(value) { account = value; },
    setSession(value) { serial = value; }
  };
}

{
  const model = createTrashModel();
  const first = trashEntry("trash-format", "**回收站标题**");
  model.replaceItems([first]);
  assert.equal(model.select(first.id, true), true);
  assert.deepEqual(model.snapshot().selectedIds, ["trash-format"]);
  model.replaceItems([trashEntry("trash-other")]);
  assert.deepEqual(model.snapshot().selectedIds, []);
  model.clear();
  assert.deepEqual(model.snapshot(), { items: [], selectedIds: [] });

  const presentation = createTrashPresentation(viewPorts());
  const markup = presentation.list({
    items: [first],
    selectedIds: [first.id]
  });
  assert.match(markup, /回收站标题/);
  assert.match(markup, /思绪/);
  assert.match(markup, /手动记录/);
  assert.match(markup, /本人/);
  assert.match(markup, /已保留/);
  assert.match(markup, /发生日期/);
  assert.match(markup, /checked/);
  assert.doesNotMatch(markup, /clientRequestId|private-request-id|attachmentPaths|private\.png/);
  assert.equal(
    presentation.title({ ...trashEntry(), payload: { items: [] } }),
    "无标题记录"
  );
  const manyRows = trashDetailRows({
    type: "capture",
    payload: Array.from({ length: 90 }, (_, index) => ({ content: `row-${index}` }))
  });
  assert.equal(manyRows.length, 80);
}

{
  const baseline = {
    data: {
      getAccountId: () => "account-a",
      getSessionSerial: () => 1,
      request: async () => ({ items: [] }),
      refresh: async () => {}
    },
    view: viewPorts(),
    platform: { confirm: () => true, prompt: () => null }
  };
  for (const [group, name] of [
    ["data", "getAccountId"],
    ["data", "getSessionSerial"],
    ["data", "request"],
    ["data", "refresh"],
    ["view", "formatDate"],
    ["view", "contentState"],
    ["view", "escapeMarkup"],
    ["view", "plainPreview"],
    ["view", "renderMarkdown"],
    ["view", "renderLatex"],
    ["view", "showToast"],
    ["platform", "confirm"],
    ["platform", "prompt"]
  ]) {
    assert.throws(
      () => createTrashFeatureController({
        ...baseline,
        [group]: { ...baseline[group], [name]: null }
      }),
      new RegExp(`requires ${name}`)
    );
  }
}

{
  const harness = createHarness();
  const root = new FakeRoot("lifecycle");
  let staleDispose = null;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = harness.controller.mount({
      root,
      route: { view: "trash", cycle },
      signal: new AbortController().signal
    });
    assert.equal(root.listenerCount("click"), 1);
    assert.equal(root.listenerCount("change"), 1);
    if (staleDispose) assert.equal(staleDispose(), false);
    staleDispose = dispose;
  }
  await waitFor(() => harness.requests.length === 20, "20 lifecycle loads did not start");
  assert.equal(staleDispose(), true);
  assert.equal(staleDispose(), false);
  assert.equal(root.listenerCount("click"), 0);
  assert.equal(root.listenerCount("change"), 0);
  assert.equal(root.list.innerHTML, "");
  assert.equal(root.status.textContent, "");
  assert.equal(root.purge.disabled, true);
}

{
  const first = createHarness();
  const second = createHarness();
  assert.notEqual(first.controller, second.controller, "factory must return fresh controllers");
  const firstRoot = new FakeRoot("first");
  const secondRoot = new FakeRoot("second");
  first.controller.mount({ root: firstRoot });
  second.controller.mount({ root: secondRoot });
  first.controller.unmount();
  assert.equal(firstRoot.listenerCount("click"), 0);
  assert.equal(secondRoot.listenerCount("click"), 1);
  second.controller.unmount();
}

async function assertStaleResponseRejected(kind, mutate) {
  const gate = deferred();
  const harness = createHarness({ request: () => gate.promise });
  const root = new FakeRoot(`stale-${kind}`);
  harness.controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => harness.requests.length === 1, `${kind} request did not start`);
  mutate(harness, root);
  const writes = root.writes;
  gate.resolve({ items: [trashEntry(`trash-${kind}`, `secret-${kind}`)] });
  await flush();
  await flush();
  assert.equal(root.writes, writes, `${kind} stale response wrote to the root`);
  assert.doesNotMatch(root.list.innerHTML, new RegExp(`secret-${kind}`));
  harness.controller.unmount();
}

await assertStaleResponseRejected("account", harness => {
  harness.setAccount("account-b");
});
await assertStaleResponseRejected("session", harness => {
  harness.setSession(2);
});
await assertStaleResponseRejected("generation", harness => {
  harness.controller.unmount();
});

{
  const gate = deferred();
  const harness = createHarness({
    request(path) {
      if (path === "/api/trash") return { items: [trashEntry("trash-stale-restore")] };
      return gate.promise;
    }
  });
  const root = new FakeRoot("stale-restore");
  harness.controller.mount({ root });
  await waitFor(() => /已删除正文/.test(root.list.innerHTML), "stale restore fixture did not load");
  root.dispatch("click", root.target({
    dataset: { trashRestore: "trash-stale-restore" }
  }));
  await waitFor(
    () => harness.requests.some(([path]) => path.endsWith("/restore")),
    "stale restore request did not start"
  );
  harness.setSession(2);
  gate.resolve({ restored: true });
  await flush();
  await flush();
  assert.deepEqual(harness.refreshes, [], "stale restore must not refresh business domains");
  assert.deepEqual(harness.toasts, [], "stale restore must not announce success");
  harness.controller.unmount();
}

{
  const gate = deferred();
  const harness = createHarness({
    request(path) {
      if (path === "/api/trash") return { items: [trashEntry("trash-stale-purge")] };
      if (path === "/api/trash/purge-preview") return gate.promise;
      throw new Error(`Unexpected request: ${path}`);
    },
    prompt: () => TRASH_PURGE_CONFIRMATION
  });
  const root = new FakeRoot("stale-purge");
  harness.controller.mount({ root });
  await waitFor(() => /已删除正文/.test(root.list.innerHTML), "stale purge fixture did not load");
  const input = root.target({ dataset: { trashSelect: "" } });
  input.value = "trash-stale-purge";
  input.checked = true;
  root.dispatch("change", input);
  root.dispatch("click", root.purge);
  await waitFor(
    () => harness.requests.some(([path]) => path.endsWith("purge-preview")),
    "stale purge preview did not start"
  );
  harness.controller.unmount();
  gate.resolve({
    items: [{ id: "trash-stale-purge" }],
    planHash: "stale-plan"
  });
  await flush();
  await flush();
  assert.deepEqual(harness.prompts, [], "stale purge preview must not prompt");
  assert.equal(
    harness.requests.some(([path]) => path === "/api/trash/purge"),
    false,
    "stale purge preview must not execute"
  );
}

{
  const first = deferred();
  const retry = deferred();
  const queue = [first, retry];
  const harness = createHarness({ request: () => queue.shift().promise });
  const root = new FakeRoot("load-retry");
  harness.controller.mount({ root });
  await waitFor(() => harness.requests.length === 1, "initial trash load did not start");
  first.reject(new Error("Not found: INTERNAL_TRASH_FAILURE"));
  await waitFor(
    () => /暂时无法读取回收站/.test(root.list.innerHTML),
    "load failure state did not render"
  );
  assert.doesNotMatch(root.list.innerHTML, /Not found|INTERNAL_TRASH_FAILURE/);
  assert.equal(root.dispatch("click", root.target({
    dataset: { contentAction: "retry-trash" }
  })), true);
  await waitFor(() => harness.requests.length === 2, "retry did not issue another load");
  retry.resolve({ items: [trashEntry("trash-retry", "重试后恢复")] });
  await waitFor(() => /重试后恢复/.test(root.list.innerHTML), "retry result did not render");
  assert.equal(root.status.textContent, "");
  assert.equal(harness.latex.length, 1);
  harness.controller.unmount();
  assert.equal(root.list.innerHTML, "", "unmount must scrub loaded trash payload markup");
}

{
  const restoreGate = deferred();
  let listReads = 0;
  const harness = createHarness({
    request(path) {
      if (path === "/api/trash") {
        listReads += 1;
        return { items: listReads === 1 ? [trashEntry("trash-restore")] : [] };
      }
      if (path === "/api/trash/trash-restore/restore") return restoreGate.promise;
      throw new Error(`Unexpected request: ${path}`);
    }
  });
  const root = new FakeRoot("restore");
  harness.controller.mount({ root });
  await waitFor(() => /已删除正文/.test(root.list.innerHTML), "restore fixture did not load");
  const button = root.target({ dataset: { trashRestore: "trash-restore" } });
  assert.equal(root.dispatch("click", button), true);
  await waitFor(
    () => harness.requests.some(([path]) => path.endsWith("/restore")),
    "restore request did not start"
  );
  assert.equal(button.disabled, true);
  assert.equal(root.status.textContent, "正在恢复…");
  const restoreCall = harness.requests.find(([path]) => path.endsWith("/restore"));
  assert.deepEqual(restoreCall, [
    "/api/trash/trash-restore/restore",
    { method: "POST", body: "{}" }
  ]);
  restoreGate.resolve({ restored: true });
  await waitFor(() => harness.toasts.length === 1, "restore did not finish");
  assert.deepEqual(harness.refreshes, [TRASH_RESTORE_DOMAINS]);
  assert.deepEqual(harness.toasts[0], ["记录已恢复；用于回答和学习的许可仍保持关闭"]);
  assert.equal(listReads, 2);
  assert.match(root.list.innerHTML, /回收站是空的/);
  harness.controller.unmount();
}

{
  let listReads = 0;
  const harness = createHarness({
    request(path) {
      if (path === "/api/trash") {
        listReads += 1;
        return { items: [trashEntry("trash-refresh-failure")] };
      }
      return { restored: true };
    },
    refresh: async () => {
      throw new Error("业务域刷新失败");
    }
  });
  const root = new FakeRoot("refresh-failure");
  harness.controller.mount({ root });
  await waitFor(() => /已删除正文/.test(root.list.innerHTML), "refresh failure fixture did not load");
  const button = root.target({
    dataset: { trashRestore: "trash-refresh-failure" }
  });
  root.dispatch("click", button);
  await waitFor(
    () => root.status.textContent === "业务域刷新失败",
    "refresh failure was not reported"
  );
  assert.deepEqual(harness.refreshes, [TRASH_RESTORE_DOMAINS]);
  assert.equal(button.disabled, false);
  assert.equal(listReads, 1, "failed business refresh must not claim a refreshed trash list");
  assert.deepEqual(harness.toasts, []);
  harness.controller.unmount();
}

{
  const harness = createHarness({
    request(path) {
      if (path === "/api/trash") return { items: [trashEntry("trash-cancel")] };
      if (path === "/api/trash/purge-preview") {
        return { items: [{ id: "trash-cancel" }], planHash: "plan-cancel" };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    prompt: () => "删除"
  });
  const root = new FakeRoot("purge-cancel");
  harness.controller.mount({ root });
  await waitFor(() => /已删除正文/.test(root.list.innerHTML), "purge cancel fixture did not load");
  const input = root.target({ dataset: { trashSelect: "" } });
  input.value = "trash-cancel";
  input.checked = true;
  root.dispatch("change", input);
  assert.equal(root.purge.disabled, false);
  assert.equal(root.dispatch("click", root.purge), true);
  await waitFor(
    () => root.status.textContent === "已取消永久清理。",
    "purge cancellation did not settle"
  );
  assert.equal(root.purge.disabled, false);
  assert.equal(harness.requests.some(([path]) => path === "/api/trash/purge"), false);
  assert.equal(harness.prompts.length, 1);
  assert.deepEqual(harness.confirms, []);
  const preview = harness.requests.find(([path]) => path.endsWith("purge-preview"));
  assert.deepEqual(JSON.parse(preview[1].body), { ids: ["trash-cancel"] });
  harness.controller.unmount();
}

{
  let listReads = 0;
  const harness = createHarness({
    request(path, options) {
      if (path === "/api/trash") {
        listReads += 1;
        return {
          items: listReads === 1
            ? [trashEntry("trash-a"), trashEntry("trash-b", "第二条")]
            : []
        };
      }
      if (path === "/api/trash/purge-preview") {
        return {
          items: [{ id: "trash-a" }, { id: "trash-b" }, { id: "dependent" }],
          planHash: "plan-hash-123"
        };
      }
      if (path === "/api/trash/purge") {
        const body = JSON.parse(options.body);
        assert.deepEqual(body, {
          ids: ["trash-a", "trash-b"],
          planHash: "plan-hash-123",
          confirmation: TRASH_PURGE_CONFIRMATION
        });
        return { purged: 3 };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    prompt: () => TRASH_PURGE_CONFIRMATION
  });
  const root = new FakeRoot("purge-confirm");
  harness.controller.mount({ root });
  await waitFor(() => /第二条/.test(root.list.innerHTML), "purge confirm fixture did not load");
  for (const id of ["trash-a", "trash-b"]) {
    const input = root.target({ dataset: { trashSelect: "" } });
    input.value = id;
    input.checked = true;
    root.dispatch("change", input);
  }
  root.dispatch("click", root.purge);
  await waitFor(() => harness.toasts.length === 1, "confirmed purge did not finish");
  assert.match(harness.prompts[0][0], /永久清理 3 条记录/);
  assert.match(harness.prompts[0][0], /请输入“永久删除”/);
  assert.deepEqual(harness.toasts[0], ["已永久清理 3 条记录"]);
  assert.equal(listReads, 2);
  assert.match(root.list.innerHTML, /回收站是空的/);
  assert.equal(root.purge.disabled, true);
  harness.controller.unmount();
}

{
  const gate = deferred();
  const harness = createHarness({ request: () => gate.promise });
  const root = new FakeRoot("reset-late");
  harness.controller.mount({ root });
  await waitFor(() => harness.requests.length === 1, "reset fixture did not start loading");
  harness.controller.resetSession();
  assert.equal(root.listenerCount("click"), 0);
  assert.equal(root.listenerCount("change"), 0);
  assert.equal(root.list.innerHTML, "");
  assert.equal(root.status.textContent, "");
  assert.equal(root.purge.disabled, true);
  const writes = root.writes;
  gate.resolve({ items: [trashEntry("trash-private", "reset 后不得回写的敏感正文")] });
  await flush();
  await flush();
  assert.equal(root.writes, writes, "late payload wrote after reset");
  assert.doesNotMatch(root.list.innerHTML, /敏感正文/);
}

console.log(
  "Frontend trash feature checks passed: model/presentation parity, fresh controllers, "
  + "20 lifecycle cycles, account/session/generation stale rejection, load retry, "
  + "restore domains, refresh failure, purge cancellation/planHash confirmation and payload reset."
);
