import { notificationEntryMarkup, transitionNotificationRetry } from "./presentation.mjs";
export const NOTIFICATION_SELECTORS = Object.freeze({
  list: "#notification-list",
  status: "#notifications-status",
  readAll: "#notifications-read-all",
  read: "[data-notification-read]",
  open: "[data-notification-open]",
  retry: "[data-task-retry]"
});
const DOMAINS = new Set(["notifications", "aiTasks", "notificationUnread"]);
function contentStateMarkup({ kind = "empty", title, body, action = "" }) {
  const role = kind === "failure" ? ' role="alert"' : kind === "loading" ? ' role="status"' : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${title}</strong><p>${body}</p>${action}</section>`;
}
function relevant(value) {
  if (value == null) return true;
  if (typeof value === "string") return DOMAINS.has(value);
  try {
    return [...value].some(domain => DOMAINS.has(domain));
  } catch {
    return false;
  }
}
export function createNotificationsFeatureController(deps = {}) {
  const {
    request, loadNotifications, scheduleNotificationPoll, openTarget,
    getSnapshot, getLoadState, getUnreadCount, isSessionReady, formatDate, showToast
  } = deps;
  const ports = {
    request, loadNotifications, scheduleNotificationPoll, openTarget,
    getSnapshot, getLoadState, getUnreadCount, isSessionReady, formatDate, showToast
  };
  for (const [name, value] of Object.entries(ports)) {
    if (typeof value !== "function") throw new TypeError(`Notifications feature controller requires ${name}`);
  }
  let activation = null, session = {}, retrying = [], readAllTicket = null, errorMessage = "";
  const roots = new Set();
  const active = candidate => Boolean(candidate && activation === candidate
    && candidate.session === session && !candidate.signal?.aborted);
  const sameSession = ticket => ticket.session === session;
  const current = ticket => active(ticket.activation) && sameSession(ticket);
  const snapshot = value => value && typeof value === "object" ? value : getSnapshot() || {};

  function paint(candidate, value) {
    if (!active(candidate)) return false;
    const state = snapshot(value);
    const notifications = Array.isArray(state.notifications) ? state.notifications : [];
    const tasks = new Map((Array.isArray(state.aiTasks) ? state.aiTasks : [])
      .map(task => [task?.id, task]));
    const loadState = String(getLoadState() || "");
    const list = candidate.root.querySelector(NOTIFICATION_SELECTORS.list);
    if (list) {
      list.innerHTML = notifications.length
        ? notifications.map(item => notificationEntryMarkup(
          item, tasks.get(item?.taskId), { retryingTaskIds: retrying, formatTimestamp: formatDate }
        )).join("")
        : loadState === "failure"
          ? contentStateMarkup({
            kind: "failure",
            title: "暂时无法读取通知",
            body: "后台任务和已有结果没有被删除。请检查网络后重试。",
            action: '<button class="quiet-button content-state-action" type="button" data-content-action="retry-notifications">重新读取</button>'
          })
          : loadState === "loading"
            ? contentStateMarkup({
              kind: "loading",
              title: "正在读取通知",
              body: "后台任务会继续运行，不需要停留在当前页面。"
            })
            : contentStateMarkup({
              title: "没有需要处理的通知",
              body: "后台任务开始后，进度和结果会出现在这里。",
              action: '<button class="quiet-button content-state-action" type="button" data-view="mine">返回我的</button>'
            });
    }
    const status = candidate.root.querySelector(NOTIFICATION_SELECTORS.status);
    if (status) status.textContent = errorMessage || (
      loadState === "failure" && notifications.length
        ? "任务进度暂未更新，可以重新进入本页读取。"
        : ""
    );
    const readAll = candidate.root.querySelector(NOTIFICATION_SELECTORS.readAll);
    if (readAll) readAll.disabled = Boolean(readAllTicket);
    return true;
  }
  function fail(candidate, error) {
    if (!active(candidate)) return false;
    errorMessage = error?.message || "通知操作失败，请稍后重试";
    return paint(candidate);
  }
  async function loadOnMount(candidate, { force = false } = {}) {
    if (!active(candidate) || !isSessionReady() || candidate.loading
      || (candidate.loaded && !force)) return false;
    candidate.loading = true;
    let failure = null;
    try {
      await loadNotifications();
    } catch (error) {
      failure = error;
    }
    candidate.loading = false;
    candidate.loaded = true;
    if (!active(candidate)) return false;
    if (failure) errorMessage = failure?.message || "通知读取失败";
    paint(candidate);
    try {
      scheduleNotificationPoll();
    } catch (error) {
      fail(candidate, error);
    }
    return !failure;
  }
  async function readAll(candidate) {
    if (!active(candidate) || readAllTicket) return;
    const ticket = { activation: candidate, session };
    readAllTicket = ticket;
    errorMessage = "";
    paint(candidate);
    try {
      await request("/api/notifications/read-all", { method: "POST", body: "{}" });
      if (!sameSession(ticket)) return;
      await loadNotifications();
      if (current(ticket)) paint(candidate);
    } catch (error) {
      if (current(ticket)) fail(candidate, error);
    } finally {
      if (ticket.session === session && readAllTicket === ticket) {
        readAllTicket = null;
        if (active(candidate)) paint(candidate);
      }
    }
  }
  async function readOne(candidate, element, shouldOpen) {
    const id = String(element.dataset?.notificationId || element.dataset?.notificationRead || "");
    const ticket = { activation: candidate, session };
    errorMessage = "";
    paint(candidate);
    try {
      if (!id) throw new TypeError("通知缺少可读取的标识");
      await request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH", body: "{}" });
      if (!sameSession(ticket)) return;
      if (shouldOpen) {
        if (!current(ticket)) return;
        const state = snapshot();
        const task = (state.aiTasks || []).find(item => item?.id === element.dataset?.notificationTask);
        const notification = (state.notifications || []).find(item => item?.id === id);
        await openTarget(task, notification);
      } else {
        await loadNotifications();
      }
      if (current(ticket) && !shouldOpen) paint(candidate);
    } catch (error) {
      if (current(ticket)) fail(candidate, error);
    }
  }
  async function retry(candidate, taskId) {
    let next;
    try {
      next = transitionNotificationRetry(retrying, { type: "start", taskId });
    } catch (error) {
      fail(candidate, error);
      return;
    }
    if (!active(candidate) || !next.accepted) return;
    retrying = [...next.retryingTaskIds];
    const ticket = { activation: candidate, session, taskId };
    errorMessage = "";
    paint(candidate);
    try {
      await request(`/api/ai-tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" });
      if (!sameSession(ticket)) return;
      await loadNotifications();
      if (!sameSession(ticket)) return;
      scheduleNotificationPoll();
      if (current(ticket)) showToast("任务已重新排队");
    } catch (error) {
      if (current(ticket)) fail(candidate, error);
    } finally {
      if (ticket.session === session) {
        retrying = [...transitionNotificationRetry(retrying, { type: "finish", taskId }).retryingTaskIds];
        if (active(candidate)) paint(candidate);
      }
    }
  }
  function closest(candidate, event, selector) {
    const element = event?.target?.closest?.(selector) || null;
    return element && (typeof candidate.root.contains !== "function"
      || candidate.root.contains(element)) ? element : null;
  }
  function handleClick(event) {
    const candidate = activation;
    if (!active(candidate)) return;
    const all = closest(candidate, event, NOTIFICATION_SELECTORS.readAll);
    const reload = closest(candidate, event, '[data-content-action="retry-notifications"]');
    const retryButton = closest(candidate, event, NOTIFICATION_SELECTORS.retry);
    const open = closest(candidate, event, NOTIFICATION_SELECTORS.open);
    const read = closest(candidate, event, NOTIFICATION_SELECTORS.read);
    if (!all && !reload && !retryButton && !open && !read) return;
    event.preventDefault?.();
    if (all) void readAll(candidate);
    else if (reload) void loadOnMount(candidate, { force: true });
    else if (retryButton) void retry(candidate, String(retryButton.dataset?.taskRetry || ""));
    else void readOne(candidate, open || read, Boolean(open));
  }
  function detach(candidate) {
    if (activation !== candidate) return false;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    candidate.root.removeEventListener("click", handleClick);
    if (readAllTicket?.activation === candidate) readAllTicket = null;
    activation = null;
    return true;
  }
  function mount({ root, route, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Notifications feature mount requires a root event target");
    }
    let disposed = false, candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, route, signal, session, dispose, loaded: false, loading: false };
    activation = candidate;
    roots.add(root);
    errorMessage = "";
    root.addEventListener("click", handleClick);
    signal?.addEventListener?.("abort", dispose, { once: true });
    paint(candidate);
    if (isSessionReady()) void loadOnMount(candidate);
    return dispose;
  }
  function render({ snapshot: value, changedDomains } = {}) {
    if (!active(activation) || !relevant(changedDomains)) return false;
    const rendered = paint(activation, value);
    if (isSessionReady()) void loadOnMount(activation);
    return rendered;
  }
  function unmount() {
    return activation ? detach(activation) : false;
  }
  function resetSession() {
    unmount();
    session = {};
    retrying = [];
    readAllTicket = null;
    errorMessage = "";
    for (const root of roots) {
      const list = root.querySelector?.(NOTIFICATION_SELECTORS.list);
      const status = root.querySelector?.(NOTIFICATION_SELECTORS.status);
      const readAll = root.querySelector?.(NOTIFICATION_SELECTORS.readAll);
      if (list) list.innerHTML = "";
      if (status) status.textContent = "";
      if (readAll) readAll.disabled = false;
    }
    roots.clear();
  }
  return Object.freeze({ mount, render, unmount, resetSession });
}
