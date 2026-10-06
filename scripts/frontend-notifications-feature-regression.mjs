import assert from "node:assert/strict";
import {
  createNotificationsFeatureController,
  NOTIFICATION_SELECTORS
} from "../public/frontend/features/notifications/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

class FakeElement {
  constructor(root, kind = "", dataset = {}) {
    this.root = root;
    this.kind = kind;
    this.dataset = dataset;
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
    if (this.kind === "all" && selector === NOTIFICATION_SELECTORS.readAll) return this;
    if (this.dataset.taskRetry !== undefined && selector === NOTIFICATION_SELECTORS.retry) return this;
    if (this.dataset.notificationOpen !== undefined && selector === NOTIFICATION_SELECTORS.open) return this;
    if (this.dataset.notificationRead !== undefined && selector === NOTIFICATION_SELECTORS.read) return this;
    if (
      this.dataset.contentAction === "retry-notifications"
      && selector === '[data-content-action="retry-notifications"]'
    ) return this;
    return null;
  }
}

class FakeRoot {
  constructor(name) {
    this.name = name;
    this.writes = 0;
    this.listeners = new Map();
    this.list = new FakeElement(this);
    this.status = new FakeElement(this);
    this.readAll = new FakeElement(this, "all");
  }
  querySelector(selector) {
    return {
      [NOTIFICATION_SELECTORS.list]: this.list,
      [NOTIFICATION_SELECTORS.status]: this.status,
      [NOTIFICATION_SELECTORS.readAll]: this.readAll
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
  contains(element) { return element?.root === this; }
  listenerCount() { return this.listeners.get("click")?.size || 0; }
  click(dataset = null) {
    const target = dataset ? new FakeElement(this, "", dataset) : this.readAll;
    let prevented = false;
    const event = { target, preventDefault: () => { prevented = true; } };
    for (const listener of [...(this.listeners.get("click") || [])]) listener(event);
    return prevented;
  }
}

const notice = (id = "notice-1", title = "后台任务") => ({
  id,
  taskId: "task-1",
  targetId: "thought-1",
  status: "failed",
  title,
  message: "生成失败",
  updatedAt: "2026-10-06T08:00:00.000Z",
  readAt: ""
});
const task = () => ({
  id: "task-1",
  kind: "thoughtAnswer",
  targetId: "thought-1",
  status: "failed"
});
const initialState = () => ({
  notifications: [notice()],
  aiTasks: [task()],
  notificationUnread: 1
});
function ports(overrides = {}) {
  const state = initialState();
  return {
    request: async () => ({}),
    loadNotifications: async () => true,
    scheduleNotificationPoll() {},
    openTarget: async () => {},
    getSnapshot: () => state,
    getLoadState: () => "ready",
    getUnreadCount: () => 1,
    isSessionReady: () => true,
    formatDate: () => "10月6日 16:00",
    showToast() {},
    ...overrides
  };
}

for (const name of Object.keys(ports())) {
  assert.throws(
    () => createNotificationsFeatureController({ ...ports(), [name]: null }),
    new RegExp(`requires ${name}`)
  );
}

{
  let ready = false, loads = 0, schedules = 0;
  const root = new FakeRoot("direct-route");
  const controller = createNotificationsFeatureController(ports({
    isSessionReady: () => ready,
    async loadNotifications() { loads += 1; },
    scheduleNotificationPoll() { schedules += 1; }
  }));
  controller.mount({ root });
  await flush();
  assert.equal(loads, 0, "direct route must wait for an authenticated session");
  ready = true;
  controller.render({ snapshot: initialState() });
  await waitFor(() => schedules === 1, "session-ready render did not start notification loading");
  assert.equal(loads, 1);
  controller.unmount();
}

{
  let state = initialState();
  let loadState = "ready";
  let loads = 0, schedules = 0;
  const root = new FakeRoot("render");
  const controller = createNotificationsFeatureController(ports({
    getSnapshot: () => state,
    getLoadState: () => loadState,
    async loadNotifications() { loads += 1; },
    scheduleNotificationPoll() { schedules += 1; }
  }));
  const dispose = controller.mount({ root, signal: new AbortController().signal });
  assert.equal(typeof dispose, "function");
  assert.equal(loads, 1);
  assert.equal(root.listenerCount(), 1);
  await waitFor(() => schedules === 1, "mount did not schedule through the injected port");
  assert.match(root.list.innerHTML, /data-task-retry="task-1"/);

  const writes = root.writes;
  assert.equal(controller.render({ snapshot: state, changedDomains: ["thoughts"] }), false);
  assert.equal(root.writes, writes);
  loadState = "failure";
  assert.equal(controller.render({ snapshot: state, changedDomains: ["aiTasks"] }), true);
  assert.match(root.status.textContent, /任务进度暂未更新/);
  state = { notifications: [], aiTasks: [], notificationUnread: 0 };
  assert.equal(controller.render({ snapshot: state }), true);
  assert.match(root.list.innerHTML, /暂时无法读取通知/);
  assert.equal(root.readAll.disabled, false);
  loadState = "loading";
  controller.render({ snapshot: state });
  assert.match(root.list.innerHTML, /正在读取通知/);
  loadState = "ready";
  controller.render({ snapshot: state });
  assert.match(root.list.innerHTML, /没有需要处理的通知/);
  root.click({ contentAction: "retry-notifications" });
  await waitFor(() => loads === 2, "failure action did not reload notifications");
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(root.listenerCount(), 0);
}

{
  let loads = 0;
  const root = new FakeRoot("cycles");
  const controller = createNotificationsFeatureController(ports({
    async loadNotifications() { loads += 1; }
  }));
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = controller.mount({ root, route: { cycle } });
    assert.equal(root.listenerCount(), 1);
    dispose();
    dispose();
    assert.equal(root.listenerCount(), 0);
  }
  await flush();
  assert.equal(loads, 20);
}

{
  const state = initialState();
  const requests = [], events = [], toasts = [];
  const retryGate = deferred();
  let loads = 0;
  const root = new FakeRoot("clicks");
  const controller = createNotificationsFeatureController(ports({
    request(path, options) {
      requests.push([path, options]);
      events.push(path);
      return path.includes("/retry") ? retryGate.promise : Promise.resolve({});
    },
    async loadNotifications() {
      loads += 1;
      events.push("load");
    },
    scheduleNotificationPoll() { events.push("schedule"); },
    async openTarget(openedTask, openedNotice) {
      events.push("open");
      assert.equal(openedTask, state.aiTasks[0]);
      assert.equal(openedNotice, state.notifications[0]);
    },
    getSnapshot: () => state,
    showToast(message) { toasts.push(message); }
  }));
  controller.mount({ root });
  await waitFor(() => events.includes("schedule"), "click fixture did not mount");
  loads = 0;
  requests.length = 0;
  events.length = 0;

  root.click();
  await waitFor(() => loads === 1, "read-all did not refresh");
  assert.equal(requests.shift()[0], "/api/notifications/read-all");
  root.click({ notificationRead: "notice-1" });
  await waitFor(() => loads === 2, "single read did not refresh");
  assert.equal(requests.shift()[0], "/api/notifications/notice-1/read");
  events.length = 0;
  root.click({
    notificationOpen: "thought-1",
    notificationTask: "task-1",
    notificationId: "notice-1"
  });
  await waitFor(() => events.includes("open"), "open target was not called");
  assert.deepEqual(events.slice(0, 2), ["/api/notifications/notice-1/read", "open"]);

  root.click({ taskRetry: "task-1" });
  root.click({ taskRetry: "task-1" });
  assert.equal(requests.filter(([path]) => path.includes("/retry")).length, 1);
  assert.match(root.list.innerHTML, /aria-busy="true" disabled/);
  retryGate.resolve({});
  await waitFor(() => toasts.length === 1, "retry did not settle");
  assert.doesNotMatch(root.list.innerHTML, /aria-busy="true"/);
  controller.unmount();
}

{
  const gate = deferred();
  let loads = 0, schedules = 0;
  const root = new FakeRoot("leave-after-retry");
  const controller = createNotificationsFeatureController(ports({
    request: path => path.includes("/retry") ? gate.promise : Promise.resolve({}),
    async loadNotifications() { loads += 1; },
    scheduleNotificationPoll() { schedules += 1; }
  }));
  controller.mount({ root });
  await waitFor(() => schedules === 1, "leave fixture did not mount");
  root.click({ taskRetry: "task-1" });
  controller.unmount();
  gate.resolve({});
  await waitFor(() => loads === 2 && schedules === 2, "accepted retry lost global refresh after leave");
  assert.equal(root.listenerCount(), 0);
}

{
  let state = initialState();
  const gate = deferred();
  const toasts = [];
  let loads = 0, schedules = 0;
  const rootA = new FakeRoot("account-a");
  const rootB = new FakeRoot("account-b");
  const controller = createNotificationsFeatureController(ports({
    request: () => gate.promise,
    async loadNotifications() { loads += 1; },
    scheduleNotificationPoll() { schedules += 1; },
    getSnapshot: () => state,
    showToast(message) { toasts.push(message); }
  }));
  const oldDispose = controller.mount({ root: rootA });
  await waitFor(() => schedules === 1, "account A did not mount");
  rootA.click({ taskRetry: "task-1" });
  controller.resetSession();
  const writesA = rootA.writes;
  assert.equal(rootA.list.innerHTML, "");
  assert.equal(rootA.listenerCount(), 0);

  state = {
    notifications: [notice("notice-b", "账户 B")],
    aiTasks: [task()],
    notificationUnread: 1
  };
  const disposeB = controller.mount({ root: rootB });
  await waitFor(() => schedules === 2, "account B did not mount");
  assert.match(rootB.list.innerHTML, /账户 B/);
  assert.doesNotMatch(rootB.list.innerHTML, /aria-busy="true"/);
  assert.equal(oldDispose(), false);
  assert.equal(rootB.listenerCount(), 1);
  const writesB = rootB.writes;
  gate.resolve({});
  await flush();
  await flush();
  assert.equal(loads, 2);
  assert.equal(schedules, 2);
  assert.equal(rootA.writes, writesA);
  assert.equal(rootB.writes, writesB);
  assert.deepEqual(toasts, []);
  disposeB();
}

console.log("Frontend notifications feature checks passed.");
