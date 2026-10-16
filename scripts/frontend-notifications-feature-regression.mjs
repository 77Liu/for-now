import { isPendingAiTaskStatus } from "../public/frontend/shared/ai-task-status.mjs";
import { createNotificationRuntime } from "../public/generated/app/runtime/notification-runtime.mjs";
import assert from "node:assert/strict";
import {
  createNotificationsFeatureController,
  NOTIFICATION_SELECTORS
} from "../public/frontend/features/notifications/index.mjs";
import { createDataRuntime } from "../public/frontend/app/runtime/data-runtime.mjs";
import { state } from "../public/frontend/state/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

{
  const runtime = {};
  const reads = [];
  let targetLoaded = true;
  let notificationFails = false;
  let automaticSyncs = 0;
  const data = createDataRuntime({
    runtime,
    apiClient: { request: async path => {
      reads.push(path);
      if (notificationFails) throw Object.assign(new Error("synthetic read"), { status: 503 });
      return path === "/api/notifications" ? { items: [], unread: 0 } : { items: [] };
    } },
    syncStore: {},
    createRequestCoordinator: () => ({}),
    createRefreshCoordinator: () => ({ refresh: async () => targetLoaded }),
    createIncrementalSync: () => ({}),
    $: () => ({ hidden: false }),
    getActionsCoordinator: () => ({}),
    renderStateChart() {},
    renderHomeMood() {},
    reconcileActiveThoughtRoute() {},
    clearRouteLoadFailure() {},
    renderVisibleRoute() {},
    renderRouteLoadFailure() {},
    syncBackgroundTaskResults: async () => { automaticSyncs += 1; },
    ensureBackgroundResultsController: () => ({}),
    backgroundResultsRetryLimit: 3
  });
  state.aiTasks = [{ id: "waiting-task", status: "waiting_for_user_model" }];
  data.scheduleNotificationPoll();
  assert.ok(runtime.notificationTimer, "model-waiting tasks keep notification polling active");
  clearTimeout(runtime.notificationTimer);
  runtime.notificationTimer = null;
  state.aiTasks = [];
}
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

// 最后一个任务已完成时，仍只为未用尽的结果读取重试登记真实轮询timer。
{
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  const timers=new Set();
  globalThis.setTimeout=(callback,delay,...args)=>{const timer=originalSet(callback,delay,...args);timers.add(timer);return timer};
  globalThis.clearTimeout=timer=>{timers.delete(timer);originalClear(timer)};
  const runtime={currentUser:{id:"poll-owner"},backgroundResultsRetryAttempts:0};
  const notifications=createNotificationRuntime({runtime,getSnapshot:()=>({aiTasks:[{id:"completed",status:"succeeded"}]}),
    getSessionSerial:()=>1,request:async()=>({items:[]}),syncResults:async()=>{},setUnreadDot:()=>{},retryLimit:3,isPendingTask:isPendingAiTaskStatus});
  try {
    for(const attempts of [0,1,2,3]){
      runtime.backgroundResultsRetryAttempts=attempts;notifications.scheduleNotificationPoll();
      assert.equal(timers.size,attempts===1||attempts===2?1:0,`completed任务attempts=${attempts}的实际轮询登记`);
    }
  } finally {
    for(const timer of timers)originalClear(timer);
    globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
  }
}

// 账户切换后的迟到通知不得写入新快照或结果同步。
{
  const pending = deferred();
  const runtime = { currentUser: { id: "account-a" } };
  let serial = 1;
  const state = { aiTasks: [], notifications: [] };
  let syncs = 0;
  const notifications = createNotificationRuntime({
    runtime, getSnapshot: () => state, getSessionSerial: () => serial,
    request: async () => pending.promise,
    syncResults: async () => { syncs += 1; },
    setUnreadDot: () => {}, retryLimit: 3, isPendingTask: status => ["queued", "running", "waiting_for_user_model"].includes(status)
  });
  const read = notifications.loadNotifications();
  runtime.currentUser = { id: "account-b" };
  serial += 1;
  pending.resolve({ items: [{ id: "old-task", status: "succeeded" }], unread: 1 });
  assert.equal(await read, false);
  assert.deepEqual(state, { aiTasks: [], notifications: [] });
  assert.equal(syncs, 0);
}

class FakeElement {
  constructor(root, kind = "", dataset = {}) {
    this.root = root;
    this.kind = kind;
    this.dataset = dataset;
    this._innerHTML = "";
    this._textContent = "";
    this._disabled = false;
    this.focused = false;
    this.selected = false;
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
    if (this.dataset.resultReread !== undefined && selector === "[data-result-reread]") return this;
    if (this.dataset.notificationCopy !== undefined && selector === NOTIFICATION_SELECTORS.copy) return this;
    if (this.dataset.notificationCopyFallbackSelect !== undefined
      && selector === NOTIFICATION_SELECTORS.fallbackSelect) return this;
    if (this.dataset.notificationCopyFallbackDismiss !== undefined
      && selector === NOTIFICATION_SELECTORS.fallbackDismiss) return this;
    if (this.dataset.notificationOpen !== undefined && selector === NOTIFICATION_SELECTORS.open) return this;
    if (this.dataset.notificationRead !== undefined && selector === NOTIFICATION_SELECTORS.read) return this;
    if (
      this.dataset.contentAction === "retry-notifications"
      && selector === '[data-content-action="retry-notifications"]'
    ) return this;
    return null;
  }
  focus() { this.focused = true; }
  select() { this.selected = true; }
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
  querySelectorAll(selector) {
    if (selector !== "[data-notification-copy-fallback]") return [];
    const fallback = this.list.innerHTML.match(/data-notification-copy-fallback="([^"]+)"/);
    if (!fallback) return [];
    this.fallbackTextarea ||= new FakeElement(this, "fallback-textarea", {
      notificationCopyFallback: fallback[1]
    });
    return [this.fallbackTextarea];
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
  status: "failed",
  errorCode: "AI_TASK_FAILED",
  error: "secret provider response"
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
    loadNotifications: async () => false,
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
  const state = initialState();
  state.notifications.push({ ...notice("late-notice"), readAt: "" });
  const requests = [];
  let loads = 0;
  const root = new FakeRoot("mark-presented");
  const controller = createNotificationsFeatureController(ports({
    getSnapshot: () => state,
    async loadNotifications() { loads += 1; return true; },
    request(path) {
      requests.push(path);
      if (path.endsWith("/notice-1/read")) state.notifications.push(notice("arrived-after-display"));
      return Promise.resolve({});
    }
  }));
  controller.mount({ root });
  await waitFor(() => loads === 2, "presented notices were not refreshed after read acknowledgements");
  assert.deepEqual(requests, ["/api/notifications/notice-1/read", "/api/notifications/late-notice/read"]);
  assert.doesNotMatch(requests.join("\n"), /arrived-after-display/);
  controller.unmount();
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
  assert.match(root.list.innerHTML, /data-content-action="retry-notifications"/, "已有旧通知时仍有真实读取恢复入口");
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
  const requests = [], events = [], toasts = [], copied = [];
  const retryGate = deferred();
  let copyHandler = async value => { copied.push(value); };
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
    copyText(value) { return copyHandler(value); },
    showToast(message) { toasts.push(message); }
  }));
  controller.mount({ root });
  await waitFor(() => events.includes("schedule"), "click fixture did not mount");
  assert.match(root.list.innerHTML, /复制错误日志/);
  assert.doesNotMatch(root.list.innerHTML, /生成失败|secret provider response/);
  loads = 0;
  requests.length = 0;
  events.length = 0;

  root.click();
  await waitFor(() => loads === 1, "read-all did not refresh");
  assert.equal(requests.shift()[0], "/api/notifications/read-all");
  root.click({ notificationRead: "notice-1" });
  await waitFor(() => loads === 2, "single read did not refresh");
  assert.equal(requests.shift()[0], "/api/notifications/notice-1/read");
  root.click({ notificationCopy: "notice-1" });
  await waitFor(() => copied.length === 1, "sanitized diagnostic was not copied");
  assert.match(copied[0], /AI_TASK_FAILED/);
  assert.doesNotMatch(copied[0], /secret provider response|生成失败/);

  copyHandler = async value => {
    copied.push(value);
    throw new Error("secret provider response and private body");
  };
  root.click({ notificationCopy: "notice-1" });
  await waitFor(
    () => root.list.innerHTML.includes('data-notification-copy-fallback="notice-1"'),
    "clipboard rejection did not render the selectable sanitized fallback"
  );
  const fallbackMarkup = root.list.innerHTML;
  assert.match(fallbackMarkup, /<textarea readonly data-notification-copy-fallback="notice-1" aria-label="脱敏错误日志，可手动选择复制">/);
  assert.match(fallbackMarkup, /<button[^>]*data-notification-copy-fallback-select="notice-1"[^>]*>选择日志<\/button>/);
  assert.match(fallbackMarkup, /<button[^>]*data-notification-copy-fallback-dismiss="notice-1"[^>]*>收起<\/button>/);
  assert.match(fallbackMarkup, /&quot;errorCode&quot;: &quot;AI_TASK_FAILED&quot;/);
  assert.doesNotMatch(fallbackMarkup, /secret provider response|生成失败|private body/);
  root.click({ notificationCopyFallbackSelect: "notice-1" });
  assert.equal(root.fallbackTextarea?.focused, true, "fallback selection should focus the readable textarea");
  assert.equal(root.fallbackTextarea?.selected, true, "fallback selection should select the sanitized text");
  root.click({ notificationCopyFallbackDismiss: "notice-1" });
  assert.doesNotMatch(root.list.innerHTML, /data-notification-copy-fallback=/);

  events.length = 0;
  root.click({
    notificationOpen: "thought-1",
    notificationTask: "task-1",
    notificationId: "notice-1"
  });
  await waitFor(() => events.includes("open"), "open target was not called");
  assert.deepEqual(events.slice(0, 2), ["/api/notifications/notice-1/read", "open"]);

  const requestsBeforeReread = requests.length;
  state.aiTasks[0].status = "succeeded";
  events.length = 0;
  root.click({ resultReread: "task-1", notificationId: "notice-1" });
  await waitFor(() => events.includes("open"), "成功任务只读恢复必须可执行");
  assert.equal(requests.length, requestsBeforeReread, "重新读取不标已读也不POST生成");
  assert.deepEqual(events, ["open"]);
  state.aiTasks[0].status = "failed";
  root.click({ taskRetry: "task-1" });
  root.click({ taskRetry: "task-1" });
  assert.equal(requests.filter(([path]) => path.includes("/retry")).length, 1);
  assert.match(root.list.innerHTML, /aria-busy="true" disabled/);
  retryGate.resolve({});
  await waitFor(() => loads === 3 && toasts.includes("任务已重新排队"), "retry did not settle");
  assert.doesNotMatch(root.list.innerHTML, /aria-busy="true"/);
  controller.unmount();
}

{
  const sessionGate = deferred();
  const unmountGate = deferred();
  let copyAttempts = 0;
  let schedules = 0;
  const toasts = [];
  const oldRoot = new FakeRoot("copy-session-a");
  const newRoot = new FakeRoot("copy-session-b");
  const controller = createNotificationsFeatureController(ports({
    copyText(value) {
      copyAttempts += 1;
      assert.match(value, /"notificationId": "notice-1"/);
      return copyAttempts === 1 ? sessionGate.promise : unmountGate.promise;
    },
    scheduleNotificationPoll() { schedules += 1; },
    showToast(message) { toasts.push(message); }
  }));
  controller.mount({ root: oldRoot });
  oldRoot.click({ notificationCopy: "notice-1" });
  const writesBeforeSessionReset = oldRoot.writes;
  controller.resetSession();
  const writesAfterSessionReset = oldRoot.writes;
  assert.ok(writesAfterSessionReset > writesBeforeSessionReset, "session reset should clear the previous page");
  controller.mount({ root: newRoot });
  await waitFor(() => schedules === 1, "new session page did not finish mounting");
  const newRootWrites = newRoot.writes;
  sessionGate.reject(new Error("private body"));
  await flush();
  await flush();
  assert.equal(oldRoot.writes, writesAfterSessionReset, "late clipboard rejection must not write to the previous session page");
  assert.equal(newRoot.writes, newRootWrites, "late clipboard rejection must not write to the new session page");
  assert.deepEqual(toasts, [], "late clipboard rejection must not show a stale-session toast");

  newRoot.click({ notificationCopy: "notice-1" });
  controller.unmount();
  const writesAfterUnmount = newRoot.writes;
  unmountGate.reject(new Error("secret provider response"));
  await flush();
  await flush();
  assert.equal(newRoot.writes, writesAfterUnmount, "late clipboard rejection must not write after unmount");
  assert.deepEqual(toasts, [], "late clipboard rejection must not show a toast after unmount");
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

// F9 data-runtime真实适配：signal透传、metrics await后的同账户新会话不可回写。
{
  const { rotateSession } = await import('../public/frontend/session/index.mjs');
  const gate = deferred();
  const health = { status: 'idle', lastPullMs: 0 };
  const runtime = { currentUser: { id: 'owner-a' }, syncHealth: health };
  let ports, receivedSignal, published = 0;
  const data = createDataRuntime({
    runtime,
    apiClient: { request: async (_url, options) => { receivedSignal = options.signal; return { data: { cursor: 0, changes: [] } }; } },
    syncStore: {}, createRequestCoordinator: () => ({ metrics: async () => gate.promise }),
    createRefreshCoordinator: () => ({}), createIncrementalSync: value => { ports = value; return {}; },
    $: () => ({}), getActionsCoordinator: () => ({}), renderStateChart() {}, renderHomeMood() {},
    reconcileActiveThoughtRoute() {}, clearRouteLoadFailure() {}, renderVisibleRoute() {}, renderRouteLoadFailure() {},
    syncBackgroundTaskResults: async () => {}, ensureBackgroundResultsController: () => ({}), backgroundResultsRetryLimit: 3
  });
  runtime.runtimeFeatureRegistry = { notifyState() { published += 1; } };
  const controller = new AbortController();
  await ports.request('/api/v1/sync?waitMs=1500', { signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
  const updating = data.updateSyncHealth({ type: 'pull', owner: 'owner-a', durationMs: 20 });
  rotateSession();
  gate.resolve({ durable: true, pending: 0, conflicts: 0, failed: 0, enqueueToAckP95Ms: 0 });
  await updating;
  assert.equal(runtime.syncHealth, health);
  assert.equal(published, 0, 'same owner new session rejects old metrics consumer');
}

// 同账户未rotate但本次恢复已结束：通知真实异步消费者不接入旧列表。
{
  const response = deferred();
  const runtime = { currentUser: { id: 'same-owner' } }, snapshot = { aiTasks: [], notifications: [] };
  let current = true;
  const notifications = createNotificationRuntime({ runtime, getSnapshot: () => snapshot, getSessionSerial: () => 1,
    request: async () => response.promise, syncResults: async () => {}, setUnreadDot() {}, retryLimit: 3, isPendingTask: () => false });
  const reading = notifications.readNotificationSnapshot(false, { isCurrent: () => current });
  current = false; response.resolve({ items: [{ id: 'old-lifecycle', status: 'succeeded' }], unread: 1 });
  assert.equal(await reading, false);
  assert.deepEqual(snapshot, { aiTasks: [], notifications: [] });
  assert.notEqual(runtime.notificationsLoadState, 'ready');
}
