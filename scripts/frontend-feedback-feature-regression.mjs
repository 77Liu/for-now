import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  createFeedbackFeatureController,
  FEEDBACK_ENDPOINT
} from "../public/frontend/features/feedback/index.mjs";

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

class FakeNode {
  constructor(root) {
    this.root = root;
    this.writes = [];
    this._innerHTML = "";
    this._textContent = "";
    this._hidden = false;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.writes.push(["innerHTML", this._innerHTML]);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.writes.push(["textContent", this._textContent]);
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    this._hidden = Boolean(value);
    this.writes.push(["hidden", this._hidden]);
  }
}

class FakeControl {
  constructor(root, form, name, { value = "", checked = false } = {}) {
    this.root = root;
    this.form = form;
    this.name = name;
    this.writes = [];
    this.focusCount = 0;
    this._value = value;
    this._checked = checked;
    this._disabled = false;
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
    this.writes.push(["value", this._value]);
  }

  get checked() {
    return this._checked;
  }

  set checked(value) {
    this._checked = Boolean(value);
    this.writes.push(["checked", this._checked]);
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(value) {
    this._disabled = Boolean(value);
    this.writes.push(["disabled", this._disabled]);
  }

  focus() {
    this.focusCount += 1;
  }

  closest() {
    return null;
  }
}

class FakeForm {
  constructor(root) {
    this.root = root;
    this.dataset = {};
    this.elements = {
      type: new FakeControl(root, this, "type", { value: "bug" }),
      feature: new FakeControl(root, this, "feature"),
      body: new FakeControl(root, this, "body"),
      includeContext: new FakeControl(root, this, "includeContext"),
      contextSummary: new FakeControl(root, this, "contextSummary")
    };
    this.elements.namedItem = name => this.elements[name] || null;
    this.submitButton = new FakeControl(root, this, "submit");
  }

  querySelector(selector) {
    return selector === '[type="submit"]' ? this.submitButton : null;
  }

  reset() {
    this.elements.type.value = "bug";
    this.elements.feature.value = "";
    this.elements.body.value = "";
    this.elements.includeContext.checked = false;
    this.elements.contextSummary.value = "";
  }

  closest() {
    return null;
  }
}

class FakeAction {
  constructor(root, dataset) {
    this.root = root;
    this.dataset = { ...dataset };
  }

  closest(selector) {
    if (
      selector === '[data-content-action="retry-feedback"]'
      && this.dataset.contentAction === "retry-feedback"
    ) {
      return this;
    }
    if (
      selector === '[data-content-focus="feedback-feature"]'
      && this.dataset.contentFocus === "feedback-feature"
    ) {
      return this;
    }
    return null;
  }
}

class FakeRoot {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.addedTypes = new Set();
    this.form = new FakeForm(this);
    this.contextField = new FakeNode(this);
    this.status = new FakeNode(this);
    this.count = new FakeNode(this);
    this.list = new FakeNode(this);
  }

  querySelector(selector) {
    if (selector === "#feedback-form") return this.form;
    if (selector === "#feedback-feature") return this.form.elements.feature;
    if (selector === "#feedback-context-field") return this.contextField;
    if (selector === "#feedback-status") return this.status;
    if (selector === "#feedback-count") return this.count;
    if (selector === "#feedback-list") return this.list;
    return null;
  }

  addEventListener(type, listener) {
    this.addedTypes.add(type);
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  contains(element) {
    return element?.root === this;
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

  input(name, value) {
    const control = this.form.elements[name];
    control.value = value;
    this.dispatch("input", control);
  }

  change(name, value) {
    const control = this.form.elements[name];
    if (name === "includeContext") control.checked = value;
    else control.value = value;
    this.dispatch("change", control);
  }

  submit() {
    return this.dispatch("submit", this.form);
  }

  click(dataset) {
    return this.dispatch("click", new FakeAction(this, dataset));
  }

  writeCount() {
    const controls = [
      ...Object.values(this.form.elements).filter(value => value instanceof FakeControl),
      this.form.submitButton
    ];
    return [
      this.contextField,
      this.status,
      this.count,
      this.list,
      ...controls
    ].reduce((total, node) => total + node.writes.length, 0);
  }
}

function feedback(id, overrides = {}) {
  return {
    id,
    type: "experience",
    feature: `功能-${id}`,
    appVersion: "0.5.8",
    body: `内容-${id}`,
    context: { selected: false, summary: "" },
    status: "submitted",
    version: 1,
    createdAt: "2026-10-05T08:00:00.000Z",
    updatedAt: "2026-10-05T08:00:00.000Z",
    ...overrides
  };
}

function createController(overrides = {}) {
  let id = 0;
  return createFeedbackFeatureController({
    async requestV1() {
      return { data: feedback("created") };
    },
    async listAllV1() {
      return [];
    },
    getAppVersion: () => "0.5.8",
    createRequestId: () => `feedback-request-${++id}`,
    formatDate: value => `日期:${value}`,
    showToast() {},
    ...overrides
  });
}

const indexSource = await fs.readFile(
  new URL("../public/frontend/features/feedback/index.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(indexSource, /\b(?:document|window|fetch)\b/);
assert.doesNotMatch(indexSource, /\b(?:const|function|class)\b/);
assert.equal(FEEDBACK_ENDPOINT, "/api/v1/feedback");
assert.notEqual(createController(), createController());
assert.throws(
  () => createFeedbackFeatureController(),
  /requires requestV1/
);

{
  const calls = [];
  const root = new FakeRoot("success");
  const signal = new AbortController();
  const controller = createController({
    async listAllV1(path, options) {
      calls.push([path, options]);
      return [feedback("success", {
        feature: "<检索>",
        body: "列表成功",
        context: { selected: true, summary: "仅摘要" }
      })];
    }
  });
  const dispose = controller.mount({
    root,
    route: { view: "feedback" },
    signal: signal.signal
  });

  assert.equal(typeof dispose, "function", "mount must synchronously return a disposer");
  assert.equal(calls.length, 1, "mount must start its list request without awaiting it");
  assert.equal(calls[0][0], FEEDBACK_ENDPOINT);
  assert.equal(calls[0][1].signal, signal.signal);
  assert.deepEqual([...root.addedTypes].sort(), ["change", "click", "input", "submit"]);
  await waitFor(() => /列表成功/.test(root.list.innerHTML), "successful list did not render");
  assert.match(root.list.innerHTML, /&lt;检索&gt;/);
  assert.match(root.list.innerHTML, /日期:2026-10-05T08:00:00.000Z/);
  assert.match(root.list.innerHTML, /已主动附带上下文摘要/);
  assert.equal(root.count.textContent, "1 条");
  root.click({ contentFocus: "feedback-feature" });
  assert.equal(root.form.elements.feature.focusCount, 1);
  dispose();
  dispose();
  for (const type of ["change", "input", "submit", "click"]) {
    assert.equal(root.listenerCount(type), 0);
  }
}

{
  let attempts = 0;
  const root = new FakeRoot("failure-retry");
  const controller = createController({
    async listAllV1() {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return [feedback("retried")];
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => /暂时无法读取反馈记录/.test(root.list.innerHTML), "failure state did not render");
  assert.match(root.list.innerHTML, /data-content-action="retry-feedback"/);
  assert.equal(root.click({ contentAction: "retry-feedback" }), true);
  await waitFor(() => /功能-retried/.test(root.list.innerHTML), "manual retry did not render records");
  assert.equal(attempts, 2);
  controller.unmount();
}

{
  const post = deferred();
  const postCalls = [];
  let listCalls = 0;
  const toasts = [];
  const root = new FakeRoot("pending-edit");
  const controller = createController({
    requestV1(path, options) {
      postCalls.push([path, options]);
      return post.promise;
    },
    async listAllV1() {
      listCalls += 1;
      return listCalls === 1 ? [] : [feedback("after-submit")];
    },
    showToast(message) {
      toasts.push(message);
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => /还没有提交记录/.test(root.list.innerHTML), "initial empty state did not render");
  root.change("includeContext", true);
  assert.equal(root.contextField.hidden, false);
  assert.equal(
    root.form.elements.contextSummary.value,
    "页面：产品反馈；应用版本：0.5.8"
  );
  root.change("type", "feature");
  root.input("feature", "提交时功能");
  root.input("body", "提交时内容");
  assert.equal(root.submit(), true);
  assert.equal(root.submit(), true);
  assert.equal(postCalls.length, 1, "pending submit must not issue a second POST");
  assert.equal(postCalls[0][0], FEEDBACK_ENDPOINT);
  assert.equal(postCalls[0][1].method, "POST");
  assert.equal(Object.hasOwn(postCalls[0][1], "signal"), false, "POST must not use the route signal");
  assert.equal(postCalls[0][1].headers["idempotency-key"], "feedback-request-1");
  assert.deepEqual(JSON.parse(postCalls[0][1].body), {
    type: "feature",
    feature: "提交时功能",
    appVersion: "0.5.8",
    body: "提交时内容",
    context: {
      selected: true,
      summary: "页面：产品反馈；应用版本：0.5.8"
    }
  });
  assert.equal(root.form.submitButton.disabled, true);
  assert.equal(root.status.textContent, "正在提交…");

  root.input("body", "等待期间的新反馈");
  post.resolve({ data: feedback("after-submit") });
  await waitFor(
    () => root.status.textContent.includes("等待期间的新输入已保留"),
    "input written while POST was pending was not preserved"
  );
  assert.equal(root.form.elements.body.value, "等待期间的新反馈");
  assert.equal(root.form.submitButton.disabled, false);
  assert.equal(postCalls.length, 1);
  assert.equal(listCalls, 2);
  assert.deepEqual(toasts, ["反馈已提交"]);
  controller.unmount();
}

{
  const postCalls = [];
  let postAttempts = 0;
  const root = new FakeRoot("idempotent-retry");
  const controller = createController({
    async requestV1(path, options) {
      postCalls.push([path, options]);
      postAttempts += 1;
      if (postAttempts === 1) throw new Error("提交暂时失败");
      return { data: feedback("retry-success") };
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => /还没有提交记录/.test(root.list.innerHTML), "retry fixture did not mount");
  root.input("feature", "幂等提交");
  root.input("body", "相同内容重试");
  root.submit();
  await waitFor(() => root.status.textContent === "提交暂时失败", "POST failure was not shown");
  root.submit();
  await waitFor(() => root.status.textContent === "反馈已提交。", "POST retry did not succeed");
  assert.equal(postCalls.length, 2);
  assert.equal(
    postCalls[0][1].headers["idempotency-key"],
    postCalls[1][1].headers["idempotency-key"],
    "an unchanged failed submission must reuse its idempotency key"
  );
  assert.equal(root.form.elements.feature.value, "");
  assert.equal(root.form.elements.body.value, "");
  controller.unmount();
}

{
  let listAttempts = 0;
  const root = new FakeRoot("refresh-failure");
  const controller = createController({
    async listAllV1() {
      listAttempts += 1;
      if (listAttempts === 2) throw new Error("refresh failed");
      return listAttempts === 1 ? [] : [feedback("manual-refresh")];
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => /还没有提交记录/.test(root.list.innerHTML), "refresh fixture did not mount");
  root.input("feature", "刷新");
  root.input("body", "提交成功但刷新失败");
  root.submit();
  await waitFor(
    () => root.status.textContent.includes("列表刷新失败"),
    "refresh failure message was not preserved"
  );
  assert.match(root.list.innerHTML, /暂时无法读取反馈记录/);
  root.click({ contentAction: "retry-feedback" });
  await waitFor(() => /功能-manual-refresh/.test(root.list.innerHTML), "refresh retry failed");
  assert.equal(listAttempts, 3);
  controller.unmount();
}

{
  const post = deferred();
  const postCalls = [];
  const toasts = [];
  const root = new FakeRoot("leave-during-post");
  const abort = new AbortController();
  const controller = createController({
    requestV1(path, options) {
      postCalls.push([path, options]);
      return post.promise;
    },
    showToast(message) {
      toasts.push(message);
    }
  });
  const dispose = controller.mount({ root, signal: abort.signal });
  await waitFor(() => /还没有提交记录/.test(root.list.innerHTML), "leave fixture did not mount");
  root.input("feature", "离页");
  root.input("body", "POST 继续完成");
  root.submit();
  assert.equal(postCalls.length, 1);
  abort.abort();
  dispose();
  const writesAfterLeave = root.writeCount();
  root.submit();
  assert.equal(postCalls.length, 1);
  post.resolve({ data: feedback("left") });
  await flush();
  await flush();
  assert.equal(postCalls.length, 1);
  assert.equal(root.writeCount(), writesAfterLeave, "late POST wrote into the retired root");
  assert.deepEqual(toasts, []);

  const nextRoot = new FakeRoot("return-after-post");
  controller.mount({ root: nextRoot, signal: new AbortController().signal });
  assert.equal(nextRoot.form.elements.feature.value, "");
  assert.equal(nextRoot.form.elements.body.value, "");
  controller.unmount();
}

{
  const firstRoot = new FakeRoot("draft-first");
  const nextRoot = new FakeRoot("draft-next");
  const controller = createController();
  const dispose = controller.mount({
    root: firstRoot,
    signal: new AbortController().signal
  });
  firstRoot.change("includeContext", true);
  firstRoot.input("feature", "同会话草稿");
  firstRoot.input("body", "离开后继续填写");
  dispose();
  controller.mount({
    root: nextRoot,
    signal: new AbortController().signal
  });
  assert.equal(nextRoot.form.elements.feature.value, "同会话草稿");
  assert.equal(nextRoot.form.elements.body.value, "离开后继续填写");
  assert.equal(nextRoot.form.elements.includeContext.checked, true);
  assert.equal(nextRoot.contextField.hidden, false);
  controller.unmount();
}

{
  const get = deferred();
  const root = new FakeRoot("late-get-reset");
  const controller = createController({
    listAllV1: () => get.promise
  });
  controller.mount({ root, signal: new AbortController().signal });
  root.input("feature", "敏感功能");
  root.input("body", "敏感草稿");
  controller.resetSession();
  const writesAfterReset = root.writeCount();
  assert.equal(root.form.elements.feature.value, "");
  assert.equal(root.form.elements.body.value, "");
  assert.equal(root.form.elements.contextSummary.value, "");
  assert.equal(root.contextField.hidden, true);
  assert.equal(root.status.textContent, "");
  assert.equal(root.count.textContent, "");
  assert.equal(root.list.innerHTML, "");
  get.resolve([feedback("must-not-render")]);
  await flush();
  await flush();
  assert.equal(root.writeCount(), writesAfterReset, "late GET wrote after reset");
}

{
  const post = deferred();
  const root = new FakeRoot("late-post-reset");
  const toasts = [];
  let postCalls = 0;
  const controller = createController({
    requestV1() {
      postCalls += 1;
      return post.promise;
    },
    showToast(message) {
      toasts.push(message);
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(() => /还没有提交记录/.test(root.list.innerHTML), "POST reset fixture did not mount");
  root.input("feature", "账户 A");
  root.input("body", "不得跨账户写回");
  root.submit();
  controller.resetSession();
  const writesAfterReset = root.writeCount();
  post.resolve({ data: feedback("old-session") });
  await flush();
  await flush();
  assert.equal(postCalls, 1);
  assert.equal(root.writeCount(), writesAfterReset, "late POST wrote after reset");
  assert.deepEqual(toasts, []);
}

{
  const root = new FakeRoot("cycles");
  let reads = 0;
  const controller = createController({
    async listAllV1() {
      reads += 1;
      return [];
    }
  });
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = controller.mount({
      root,
      route: { cycle },
      signal: new AbortController().signal
    });
    for (const type of ["change", "input", "submit", "click"]) {
      assert.equal(root.listenerCount(type), 1);
    }
    dispose();
    dispose();
    for (const type of ["change", "input", "submit", "click"]) {
      assert.equal(root.listenerCount(type), 0);
    }
  }
  await flush();
  assert.equal(reads, 20);
}

{
  const firstRoot = new FakeRoot("first-instance");
  const secondRoot = new FakeRoot("second-instance");
  const first = createController({
    async listAllV1() {
      return [feedback("first-instance")];
    }
  });
  const second = createController({
    async listAllV1() {
      return [feedback("second-instance")];
    }
  });
  first.mount({ root: firstRoot, signal: new AbortController().signal });
  second.mount({ root: secondRoot, signal: new AbortController().signal });
  await waitFor(
    () => /first-instance/.test(firstRoot.list.innerHTML)
      && /second-instance/.test(secondRoot.list.innerHTML),
    "fresh controller instances did not render independently"
  );
  firstRoot.input("body", "仅属于实例一");
  first.resetSession();
  assert.equal(firstRoot.list.innerHTML, "");
  assert.match(secondRoot.list.innerHTML, /second-instance/);
  assert.equal(secondRoot.form.elements.body.value, "");
  second.unmount();
}

{
  const firstRead = deferred();
  const recoveryRead = deferred();
  const requests = [];
  const root = new FakeRoot("state-recovery");
  const controller = createController({
    listAllV1(path, options) {
      requests.push([path, options]);
      return requests.length === 1 ? firstRead.promise : recoveryRead.promise;
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  assert.equal(requests.length, 1);
  assert.equal(controller.render({
    snapshot: { session: "ready" },
    changedDomains: ["feedback"]
  }), true);
  assert.equal(requests.length, 1, "state notification must not duplicate a pending feedback read");
  controller.render({
    snapshot: { session: "still-ready" },
    changedDomains: new Set(["feedback"])
  });
  assert.equal(requests.length, 1);
  firstRead.reject(new Error("rotated session"));
  await waitFor(() => requests.length === 2, "failed startup read did not recover after state became ready");
  recoveryRead.resolve([feedback("recovered")]);
  await waitFor(() => /功能-recovered/.test(root.list.innerHTML), "recovery read did not render");
  controller.render({
    snapshot: { feedback: [feedback("final-snapshot")] },
    changedDomains: ["feedback"]
  });
  await flush();
  assert.equal(requests.length, 2, "later state renders must not auto-retry");
  assert.match(root.list.innerHTML, /功能-final-snapshot/);
  assert.equal(controller.render({
    snapshot: { feedback: [feedback("ignored")] },
    changedDomains: ["thoughts"]
  }), false);
  assert.doesNotMatch(root.list.innerHTML, /功能-ignored/);
  controller.unmount();
}

{
  let reads = 0;
  const root = new FakeRoot("already-aborted");
  const abort = new AbortController();
  abort.abort();
  const controller = createController({
    async listAllV1() {
      reads += 1;
      return [];
    }
  });
  const dispose = controller.mount({ root, signal: abort.signal });
  assert.equal(typeof dispose, "function");
  assert.equal(reads, 0);
  assert.equal(root.listenerCount("submit"), 0);
  dispose();
}

console.log("Frontend feedback feature checks passed: list/retry, drafts, idempotent POST, stale isolation, session reset, lifecycle cleanup, instance isolation and one-shot state recovery.");
