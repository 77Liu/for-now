import assert from "node:assert/strict";
import {
  createExportFeatureController,
  EXPORT_ACCOUNT_ENDPOINT
} from "../public/frontend/features/export/index.mjs";

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

class FakeContentNode {
  constructor(root) {
    this.root = root;
    this.innerHtmlWrites = [];
    this.textWrites = [];
    this._innerHTML = "";
    this._textContent = "";
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
}

class FakeButton {
  constructor(root, dataset) {
    this.root = root;
    this.dataset = { ...dataset };
  }

  closest(selector) {
    if (
      selector === '[data-content-action="retry-export"]'
      && this.dataset.contentAction === "retry-export"
    ) {
      return this;
    }
    if (selector === "[data-export-format]" && this.dataset.exportFormat !== undefined) {
      return this;
    }
    return null;
  }
}

class FakeLink {
  constructor() {
    this.href = "";
    this.download = "";
    this.clicks = 0;
    this.removed = false;
    this.root = null;
  }

  click() {
    this.clicks += 1;
  }

  remove() {
    this.removed = true;
  }
}

class FakeRoot {
  constructor(name) {
    this.name = name;
    this.summary = new FakeContentNode(this);
    this.status = new FakeContentNode(this);
    this.listeners = new Map();
    this.links = [];
    this.queries = [];
    this.ownerDocument = {
      createElement: tagName => {
        assert.equal(tagName, "a");
        return new FakeLink();
      }
    };
  }

  querySelector(selector) {
    this.queries.push(selector);
    if (selector === "#export-summary") return this.summary;
    if (selector === "#export-status") return this.status;
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  append(link) {
    link.root = this;
    this.links.push(link);
  }

  contains(element) {
    return element?.root === this;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  click(dataset) {
    const target = new FakeButton(this, dataset);
    let prevented = false;
    const event = {
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get("click") || [])]) listener(event);
    return prevented;
  }
}

function manifest(label, resources = 1) {
  return {
    snapshotVersion: label,
    summary: {
      resources,
      attachments: 2,
      attachmentReferences: 3,
      orphanReferences: 0
    }
  };
}

function scheduledPort() {
  let serial = 0;
  const tasks = new Map();
  return {
    schedule(callback) {
      const id = ++serial;
      tasks.set(id, callback);
      return id;
    },
    cancelScheduled(id) {
      tasks.delete(id);
    },
    run() {
      const pending = [...tasks.values()];
      tasks.clear();
      for (const callback of pending) callback();
    },
    size() {
      return tasks.size;
    }
  };
}

assert.equal(EXPORT_ACCOUNT_ENDPOINT, "/api/v1/exports/account");

{
  const request = deferred();
  const root = new FakeRoot("pending-mount");
  const controller = createExportFeatureController({
    requestV1: () => request.promise
  });
  const dispose = controller.mount({
    root,
    route: { accountId: "account-a" },
    signal: new AbortController().signal
  });
  assert.equal(typeof dispose, "function");
  assert.equal(dispose.then, undefined);
  assert.equal(root.listenerCount("click"), 1);
  assert.match(root.summary.innerHTML, /正在读取导出范围/);
  const writeCount = root.summary.innerHtmlWrites.length;
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(root.listenerCount("click"), 0);
  request.resolve({ data: manifest("must-not-render-after-dispose") });
  await flush();
  assert.equal(root.summary.innerHtmlWrites.length, writeCount);
  assert.doesNotMatch(root.summary.innerHTML, /must-not-render-after-dispose/);
}

{
  const calls = [];
  const root = new FakeRoot("success");
  const abort = new AbortController();
  const controller = createExportFeatureController({
    async requestV1(path, options) {
      calls.push([path, options]);
      return { data: manifest("success", 7) };
    }
  });

  assert.deepEqual(
    Object.keys(controller).sort(),
    ["mount", "render", "resetSession", "unmount"]
  );
  const dispose = controller.mount({
    root,
    route: { accountId: "account-a" },
    signal: abort.signal
  });
  assert.equal(typeof dispose, "function");
  assert.equal(root.listenerCount("click"), 1);
  assert.equal(calls[0][0], "/api/v1/exports/account?format=manifest");
  assert.equal(calls[0][1].signal, abort.signal);
  assert.match(root.summary.innerHtmlWrites[0], /正在读取导出范围/);
  await waitFor(() => /快照版本 success/.test(root.summary.innerHTML), "manifest did not render");
  assert.match(root.summary.innerHTML, /<dd>7<\/dd>/);
  assert.match(root.summary.innerHTML, /快照版本 success/);
  assert.equal(controller.render({ snapshot: { version: 1 } }), true);
  assert.equal(calls.length, 1);
  assert.ok(root.queries.every(selector => ["#export-summary", "#export-status"].includes(selector)));
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(root.listenerCount("click"), 0);
  assert.equal(controller.render(), false);
}

{
  let attempts = 0;
  const root = new FakeRoot("state-recovery");
  const controller = createExportFeatureController({
    async requestV1() {
      attempts += 1;
      if (attempts <= 2) throw new Error("offline");
      return { data: manifest("retried", 4) };
    }
  });
  const dispose = controller.mount({
    root,
    route: { accountId: "account-a" },
    signal: new AbortController().signal
  });
  assert.equal(typeof dispose, "function");
  await waitFor(
    () => attempts === 1 && /暂时无法读取导出范围/.test(root.summary.innerHTML),
    "initial manifest failure did not render"
  );
  assert.equal(controller.render({ snapshot: { session: "ready" } }), true);
  await waitFor(
    () => attempts === 2 && /暂时无法读取导出范围/.test(root.summary.innerHTML),
    "first state render did not recover the startup request"
  );
  controller.render({ snapshot: { version: 2 } });
  controller.render({ snapshot: { version: 3 } });
  await flush();
  assert.equal(attempts, 2, "later state renders must not retry a real network failure");
  assert.match(root.summary.innerHTML, /暂时无法读取导出范围/);
  assert.match(root.summary.innerHTML, /data-content-action="retry-export"/);
  assert.equal(root.click({ contentAction: "retry-export" }), true);
  await waitFor(() => attempts === 3 && /快照版本 retried/.test(root.summary.innerHTML), "retry did not render");
  dispose();
}

{
  const first = deferred();
  let attempts = 0;
  const root = new FakeRoot("pending-state-recovery");
  const controller = createExportFeatureController({
    requestV1() {
      attempts += 1;
      if (attempts === 1) return first.promise;
      return Promise.resolve({ data: manifest("recovered-after-pending", 5) });
    }
  });
  const dispose = controller.mount({
    root,
    route: { accountId: "account-a" },
    signal: new AbortController().signal
  });
  controller.render({ snapshot: { session: "ready" } });
  controller.render({ snapshot: { version: 2 } });
  assert.equal(attempts, 1, "state notification must not duplicate a pending manifest request");
  first.reject(new DOMException("Session changed", "AbortError"));
  await waitFor(
    () => attempts === 2 && /recovered-after-pending/.test(root.summary.innerHTML),
    "pending startup failure did not recover after state became ready"
  );
  controller.render({ snapshot: { version: 3 } });
  await flush();
  assert.equal(attempts, 2, "state recovery must run at most once");
  dispose();
}

{
  const paths = [];
  const createdUrls = [];
  const revokedUrls = [];
  const scheduler = scheduledPort();
  const root = new FakeRoot("download");
  const controller = createExportFeatureController({
    async requestV1(path) {
      paths.push(path);
      if (path.endsWith("format=manifest")) return { data: manifest("download") };
      return {
        data: {
          format: "markdown",
          filename: "account-export.md",
          content: "# account"
        }
      };
    },
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      const url = `blob:test-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancelScheduled
  });
  const dispose = controller.mount({
    root,
    route: { accountId: "account-a" },
    signal: new AbortController().signal
  });
  assert.equal(root.click({ exportFormat: "markdown" }), true);
  await waitFor(() => root.links.length === 1, "download link was not created");
  const link = root.links[0];
  assert.equal(paths.at(-1), "/api/v1/exports/account?format=markdown");
  assert.equal(link.href, "blob:test-1");
  assert.equal(link.download, "account-export.md");
  assert.equal(link.clicks, 1);
  assert.equal(link.removed, true);
  assert.equal(root.status.textContent, "已生成 account-export.md");
  assert.equal(scheduler.size(), 1);
  scheduler.run();
  assert.deepEqual(revokedUrls, ["blob:test-1"]);
  dispose();
}

{
  const oldRequest = deferred();
  const nextRequest = deferred();
  let requests = 0;
  const oldRoot = new FakeRoot("old-account");
  const nextRoot = new FakeRoot("next-account");
  const controller = createExportFeatureController({
    requestV1() {
      requests += 1;
      return requests === 1 ? oldRequest.promise : nextRequest.promise;
    }
  });
  const oldAbort = new AbortController();
  controller.mount({
    root: oldRoot,
    route: { accountId: "old-account" },
    signal: oldAbort.signal
  });
  const oldWriteCount = oldRoot.summary.innerHtmlWrites.length;
  oldAbort.abort();
  assert.equal(oldRoot.listenerCount("click"), 0);

  const nextDispose = controller.mount({
    root: nextRoot,
    route: { accountId: "next-account" },
    signal: new AbortController().signal
  });
  nextRequest.resolve({ data: manifest("next-account", 9) });
  await waitFor(() => /next-account/.test(nextRoot.summary.innerHTML), "next manifest did not render");
  oldRequest.resolve({ data: manifest("must-not-render", 99) });
  await flush();
  assert.equal(oldRoot.summary.innerHtmlWrites.length, oldWriteCount);
  assert.doesNotMatch(oldRoot.summary.innerHTML, /must-not-render/);
  assert.match(nextRoot.summary.innerHTML, /next-account/);
  controller.resetSession();
  assert.equal(nextRoot.summary.innerHTML, "");
  assert.equal(nextRoot.status.textContent, "");

  const resetRequest = deferred();
  nextDispose();
  const resetRoot = new FakeRoot("reset");
  const resetController = createExportFeatureController({
    requestV1: () => resetRequest.promise
  });
  resetController.mount({
    root: resetRoot,
    route: { accountId: "before-reset" },
    signal: new AbortController().signal
  });
  const resetWriteCount = resetRoot.summary.innerHtmlWrites.length;
  resetController.resetSession();
  resetRequest.resolve({ data: manifest("must-not-cross-session") });
  await flush();
  assert.equal(resetRoot.summary.innerHtmlWrites.length, resetWriteCount + 1);
  assert.equal(resetRoot.summary.innerHTML, "");
}

{
  let requests = 0;
  const root = new FakeRoot("cycles");
  const controller = createExportFeatureController({
    async requestV1() {
      requests += 1;
      return { data: manifest(`cycle-${requests}`) };
    }
  });
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const dispose = controller.mount({
      root,
      route: { cycle },
      signal: new AbortController().signal
    });
    assert.equal(root.listenerCount("click"), 1);
    dispose();
    assert.equal(root.listenerCount("click"), 0);
  }
  const requestsAfterUnmount = requests;
  root.click({ contentAction: "retry-export" });
  await flush();
  assert.equal(requests, requestsAfterUnmount);
}

{
  const firstGate = deferred();
  const secondGate = deferred();
  const firstRoot = new FakeRoot("first-instance");
  const secondRoot = new FakeRoot("second-instance");
  const first = createExportFeatureController({ requestV1: () => firstGate.promise });
  const second = createExportFeatureController({ requestV1: () => secondGate.promise });
  assert.notEqual(first, second);
  first.mount({
    root: firstRoot,
    route: { accountId: "first" },
    signal: new AbortController().signal
  });
  const secondDispose = second.mount({
    root: secondRoot,
    route: { accountId: "second" },
    signal: new AbortController().signal
  });
  secondGate.resolve({ data: manifest("second-instance", 2) });
  await waitFor(() => /second-instance/.test(secondRoot.summary.innerHTML), "second instance did not render");
  first.resetSession();
  firstGate.resolve({ data: manifest("first-must-not-render", 1) });
  await flush();
  assert.match(secondRoot.summary.innerHTML, /second-instance/);
  assert.equal(secondRoot.listenerCount("click"), 1);
  secondDispose();
}

console.log("Frontend export feature checks passed: non-blocking mount, one-shot state recovery, explicit retry, download, stale response isolation and lifecycle cleanup.");
