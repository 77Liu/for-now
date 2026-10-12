import {
  notificationEntryMarkup,
  transitionNotificationRetry,
  type AiTaskSummary,
  type NotificationSummary
} from "./presentation.mjs";

type NotificationSnapshot = {
  notifications?: NotificationSummary[];
  aiTasks?: AiTaskSummary[];
};
type RequestOptions = { method?: string; body?: string };
type NotificationsControllerDependencies = {
  request: (path: string, options?: RequestOptions) => Promise<unknown>;
  loadNotifications: () => Promise<boolean | void>;
  scheduleNotificationPoll: () => void;
  openTarget: (task?: AiTaskSummary, notification?: NotificationSummary) => Promise<void> | void;
  getSnapshot: () => NotificationSnapshot;
  getLoadState: () => string;
  getUnreadCount: () => number;
  isSessionReady: () => boolean;
  formatDate: (value: string) => string;
  showToast: (message: string) => void;
  copyText?: (value: string) => Promise<void>;
};
type NotificationRoot = HTMLElement;
type CopyFallback = { notificationId: string; diagnostic: string } | null;
type Candidate = {
  root: NotificationRoot;
  route?: unknown;
  signal?: AbortSignal;
  session: object;
  dispose: () => boolean;
  loaded: boolean;
  loading: boolean;
  copyFallback: CopyFallback;
};
type ReadAllTicket = { activation: Candidate; session: object };
type RetryTicket = ReadAllTicket & { taskId: string };
export const NOTIFICATION_SELECTORS = Object.freeze({
  list: "#notification-list",
  status: "#notifications-status",
  readAll: "#notifications-read-all",
  read: "[data-notification-read]",
  open: "[data-notification-open]",
  copy: "[data-notification-copy]",
  retry: "[data-task-retry]",
  fallbackSelect: "[data-notification-copy-fallback-select]",
  fallbackDismiss: "[data-notification-copy-fallback-dismiss]"
});
const DOMAINS = new Set(["notifications", "aiTasks", "notificationUnread"]);
function contentStateMarkup({ kind = "empty", title, body, action = "" }: {
  kind?: string; title: string; body: string; action?: string;
}): string {
  const role = kind === "failure" ? ' role="alert"' : kind === "loading" ? ' role="status"' : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${title}</strong><p>${body}</p>${action}</section>`;
}
function relevant(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return DOMAINS.has(value);
  try {
    return [...(value as Iterable<unknown>)].some(domain => DOMAINS.has(String(domain)));
  } catch {
    return false;
  }
}
/** 创建与会话绑定的通知控制器；异步结果只允许写入仍然激活的页面。 */
export function createNotificationsFeatureController(deps: NotificationsControllerDependencies) {
  const {
    request, loadNotifications, scheduleNotificationPoll, openTarget,
    getSnapshot, getLoadState, getUnreadCount, isSessionReady, formatDate, showToast,
    copyText
  } = deps;
  const ports = {
    request, loadNotifications, scheduleNotificationPoll, openTarget,
    getSnapshot, getLoadState, getUnreadCount, isSessionReady, formatDate, showToast,
    copyText
  };
  for (const [name, value] of Object.entries(ports)) {
    if (name === "copyText" && value === undefined) continue;
    if (typeof value !== "function") throw new TypeError(`Notifications feature controller requires ${name}`);
  }
  let activation: Candidate | null = null, session: object = {}, retrying: string[] = [], readAllTicket: ReadAllTicket | null = null, errorMessage = "";
  const roots = new Set<NotificationRoot>();
  // 每次异步写页面前都复核激活实例、会话对象和 AbortSignal，丢弃旧页面迟到的结果。
  const active = (candidate: Candidate | null): candidate is Candidate => Boolean(candidate && activation === candidate
    && candidate.session === session && !candidate.signal?.aborted);
  const sameSession = (ticket: ReadAllTicket): boolean => ticket.session === session;
  const current = (ticket: ReadAllTicket): boolean => active(ticket.activation) && sameSession(ticket);
  const snapshot = (value?: NotificationSnapshot): NotificationSnapshot => value && typeof value === "object" ? value : getSnapshot() || {};

  function paint(candidate: Candidate, value?: NotificationSnapshot): boolean {
    if (!active(candidate)) return false;
    const state = snapshot(value);
    const notifications = Array.isArray(state.notifications) ? state.notifications : [];
    const tasks = new Map((Array.isArray(state.aiTasks) ? state.aiTasks : [])
      .map(task => [task?.id, task] as const));
    const loadState = String(getLoadState() || "");
    const list = candidate.root.querySelector(NOTIFICATION_SELECTORS.list);
    if (list) {
      list.innerHTML = notifications.length
        ? notifications.map(item => notificationEntryMarkup(
          item, tasks.get(item?.taskId), { retryingTaskIds: retrying, formatTimestamp: formatDate,
            copyFallback: candidate.copyFallback?.notificationId === String(item?.id || "")
              ? candidate.copyFallback.diagnostic : "" }
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
    const readAll = candidate.root.querySelector(NOTIFICATION_SELECTORS.readAll) as HTMLButtonElement | null;
    if (readAll) readAll.disabled = Boolean(readAllTicket);
    return true;
  }
  function fail(candidate: Candidate, error: unknown): boolean {
    if (!active(candidate)) return false;
    errorMessage = "通知操作未完成，请重新读取后确认状态。";
    return paint(candidate);
  }
  async function markPresentedRead(candidate: Candidate): Promise<void> {
    if (!active(candidate) || !candidate.root.querySelector(NOTIFICATION_SELECTORS.list)) return;
    const state = snapshot();
    const ids = [...new Set((Array.isArray(state.notifications) ? state.notifications : [])
      .filter(item => item?.id && !item.readAt)
      .map(item => String(item.id)))];
    if (!ids.length) return;
    const results = await Promise.allSettled(ids.map(id => request(
      `/api/notifications/${encodeURIComponent(id)}/read`,
      { method: "PATCH", body: "{}" }
    )));
    if (!active(candidate)) return;
    const succeeded = results.some(result => result.status === "fulfilled");
    const failed = results.some(result => result.status === "rejected");
    if (failed) errorMessage = "部分通知未能标为已读；未成功的通知仍保持未读。请重新读取后重试。";
    if (succeeded) {
      const refreshed = await loadNotifications();
      if (!active(candidate)) return;
      if (refreshed) errorMessage = failed
        ? "部分通知未能标为已读；未成功的通知仍保持未读。请重新读取后重试。"
        : "";
    }
    paint(candidate);
  }
  async function loadOnMount(candidate: Candidate, { force = false }: { force?: boolean } = {}): Promise<boolean> {
    if (!active(candidate) || !isSessionReady() || candidate.loading
      || (candidate.loaded && !force)) return false;
    candidate.loading = true;
    let failure = null, loaded = false;
    try {
      loaded = (await loadNotifications()) === true;
    } catch (error) {
      failure = error;
    }
    candidate.loading = false;
    candidate.loaded = true;
    if (!active(candidate)) return false;
    if (failure) errorMessage = "通知读取失败，任务结果仍保留。请检查网络后重新读取。";
    paint(candidate);
    try {
      scheduleNotificationPoll();
    } catch (error) {
      fail(candidate, error);
    }
    if (!failure && loaded === true) await markPresentedRead(candidate);
    return !failure;
  }
  async function readAll(candidate: Candidate): Promise<void> {
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
  async function readOne(candidate: Candidate, element: HTMLElement, shouldOpen: boolean): Promise<void> {
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
  async function retry(candidate: Candidate, taskId: string): Promise<void> {
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
  function closest(candidate: Candidate, event: MouseEvent, selector: string): HTMLElement | null {
    const target = event.target as (EventTarget & { closest?: (value: string) => Element | null }) | null;
    const element = target?.closest?.(selector) as HTMLElement | null;
    return element && (typeof candidate.root.contains !== "function"
      || candidate.root.contains(element)) ? element : null;
  }
  function handleClick(event: MouseEvent): void {
    const candidate = activation;
    if (!active(candidate)) return;
    const all = closest(candidate, event, NOTIFICATION_SELECTORS.readAll);
    const reload = closest(candidate, event, '[data-content-action="retry-notifications"]');
    const retryButton = closest(candidate, event, NOTIFICATION_SELECTORS.retry);
    const copyButton = closest(candidate, event, NOTIFICATION_SELECTORS.copy);
    const fallbackSelect = closest(candidate, event, NOTIFICATION_SELECTORS.fallbackSelect);
    const fallbackDismiss = closest(candidate, event, NOTIFICATION_SELECTORS.fallbackDismiss);
    const open = closest(candidate, event, NOTIFICATION_SELECTORS.open);
    const read = closest(candidate, event, NOTIFICATION_SELECTORS.read);
    if (!all && !reload && !retryButton && !copyButton && !fallbackSelect && !fallbackDismiss && !open && !read) return;
    event.preventDefault?.();
    if (all) void readAll(candidate);
    else if (reload) void loadOnMount(candidate, { force: true });
    else if (retryButton) void retry(candidate, String(retryButton.dataset?.taskRetry || ""));
    else if (copyButton) void copyDiagnostic(candidate, String(copyButton.dataset?.notificationCopy || ""));
    else if (fallbackSelect) selectFallback(candidate, String(fallbackSelect.dataset?.notificationCopyFallbackSelect || ""));
    else if (fallbackDismiss) dismissFallback(candidate, String(fallbackDismiss.dataset?.notificationCopyFallbackDismiss || ""));
    else void readOne(candidate, (open || read)!, Boolean(open));
  }
  // 手动复制只从当前通知的只读 textarea 选择，不重新构造或扩展诊断字段。
  function selectFallback(candidate: Candidate, notificationId: string): void {
    if (!active(candidate) || candidate.copyFallback?.notificationId !== notificationId) return;
    const fields = candidate.root.querySelectorAll?.("[data-notification-copy-fallback]") || [];
    const field = [...fields].find(item => (item as HTMLElement).dataset?.notificationCopyFallback === notificationId) as HTMLTextAreaElement | undefined;
    if (field && active(candidate)) {
      field.focus?.({ preventScroll: true });
      field.select?.();
      showToast("已选中脱敏错误日志，请手动复制");
    }
  }
  function dismissFallback(candidate: Candidate, notificationId: string): void {
    if (!active(candidate) || candidate.copyFallback?.notificationId !== notificationId) return;
    candidate.copyFallback = null;
    paint(candidate);
  }
  async function copyDiagnostic(candidate: Candidate, notificationId: string): Promise<void> {
    if (!active(candidate) || !notificationId) return;
    const state = snapshot();
    const notification = (state.notifications || []).find(item => String(item?.id) === notificationId);
    const task = (state.aiTasks || []).find(item => item?.id === notification?.taskId);
    if (!notification) return;
    // 剪贴板与替代文本只包含此白名单字段；任务错误正文和异常信息不得进入诊断内容。
    const cleanId = (value: unknown): string => String(value || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 100);
    const errorCode = /^[A-Z0-9_]{1,80}$/.test(String(task?.errorCode || ""))
      ? String(task?.errorCode)
      : "UNCLASSIFIED_FAILURE";
    const occurredAt = new Date(notification.updatedAt || notification.createdAt || "");
    const diagnostic = JSON.stringify({
      notificationId: cleanId(notification.id),
      taskId: cleanId(task?.id),
      kind: cleanId(task?.kind),
      status: cleanId(task?.status || notification.status),
      errorCode,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? "" : occurredAt.toISOString()
    }, null, 2);
    try {
      if (typeof copyText === "function") await copyText(diagnostic);
      else if (typeof globalThis.navigator?.clipboard?.writeText === "function") {
        await globalThis.navigator.clipboard.writeText(diagnostic);
      } else throw new Error("Clipboard unavailable");
      if (active(candidate)) showToast("已复制脱敏错误日志");
    } catch {
      if (active(candidate)) {
        // 复制权限被拒时仅保存已脱敏 JSON，并在仍属当前会话时呈现为只读可选择文本。
        candidate.copyFallback = { notificationId, diagnostic };
        paint(candidate);
        showToast("自动复制失败，请手动选择下方脱敏日志后复制");
      }
    }
  }
  function detach(candidate: Candidate): boolean {
    if (activation !== candidate) return false;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    candidate.root.removeEventListener("click", handleClick);
    if (readAllTicket?.activation === candidate) readAllTicket = null;
    activation = null;
    return true;
  }
  function mount({ root, route, signal }: {
    root?: NotificationRoot; route?: unknown; signal?: AbortSignal;
  } = {}): () => boolean {
    unmount();
    const rootMethods: Array<keyof HTMLElement> = ["querySelector", "addEventListener", "removeEventListener"];
    if (!root || !rootMethods.every(name => typeof root[name] === "function")) {
      throw new TypeError("Notifications feature mount requires a root event target");
    }
    let disposed = false;
    let candidate!: Candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, route, signal, session, dispose, loaded: false, loading: false, copyFallback: null };
    activation = candidate;
    roots.add(root);
    errorMessage = "";
    root.addEventListener("click", handleClick);
    signal?.addEventListener?.("abort", dispose, { once: true });
    paint(candidate);
    if (isSessionReady()) void loadOnMount(candidate);
    return dispose;
  }
  function render({ snapshot: value, changedDomains }: {
    snapshot?: NotificationSnapshot; changedDomains?: unknown;
  } = {}): boolean {
    if (!active(activation) || !relevant(changedDomains)) return false;
    const rendered = paint(activation, value);
    if (isSessionReady()) void loadOnMount(activation);
    return rendered;
  }
  function unmount() {
    return activation ? detach(activation) : false;
  }
  function resetSession(): void {
    unmount();
    session = {};
    retrying = [];
    readAllTicket = null;
    errorMessage = "";
    for (const root of roots) {
      const list = root.querySelector?.(NOTIFICATION_SELECTORS.list);
      const status = root.querySelector?.(NOTIFICATION_SELECTORS.status);
      const readAll = root.querySelector?.(NOTIFICATION_SELECTORS.readAll) as HTMLButtonElement | null;
      if (list) list.innerHTML = "";
      if (status) status.textContent = "";
      if (readAll) readAll.disabled = false;
    }
    roots.clear();
  }
  return Object.freeze({ mount, render, unmount, resetSession });
}
