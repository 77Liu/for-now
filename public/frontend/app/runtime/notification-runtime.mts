/**
 * 职责：通知与任务的真实读取、未读摘要和现有轮询。
 * 建立时间：2026-10-13；状态：active。
 * 边界：结果仅接入当前账户会话；只读刷新不隐式重复结果同步。
 */
type Task = { id?: string; status: string; resultId?: string };
type Notification = { status?: string; readAt?: string };
type Snapshot = {
  aiTasks?: Task[];
  notifications?: Notification[];
  notificationUnread?: number;
};
type Runtime = {
  currentUser?: { id?: string } | null;
  notificationTimer?: ReturnType<typeof setTimeout> | null;
  notificationUnreadCount?: number;
  notificationsLoadState?: string;
  backgroundResultsRetryAttempts?: number;
  runtimeFeatureRegistry?: { notifyState: (state: Snapshot, domains: Set<string>) => unknown };
};
// 两个既有接口的共有摘要；字段检查沿用原HTTP消费契约，不借类型改变运行语义。
type ReadItem = { id?: string; status: string; resultId?: string; readAt?: string };
type ReadResponse = { items?: ReadItem[]; unread?: number };
type Dependencies = {
  runtime: Runtime;
  getSnapshot: () => Snapshot;
  getSessionSerial: () => number;
  request: (path: string) => Promise<ReadResponse>;
  syncResults: (tasks: Task[], owner: string | undefined, session: number) => Promise<unknown>;
  setUnreadDot: (unread: number) => void;
  retryLimit: number;
  isPendingTask: (status: string) => boolean;
};

/**
 * 组合现有通知职责。readNotificationSnapshot(false)只读取，loadNotifications保留轮询接入。
 * 失败和迟到会话返回false，不以旧列表冒充本次读取成功。
 * @since v0.5.14
 */
export function createNotificationRuntime({
  runtime, getSnapshot, getSessionSerial, request, syncResults, setUnreadDot, retryLimit, isPendingTask
}: Dependencies) {
  function notificationUnread(snapshot = getSnapshot()): number {
    const items = snapshot.notifications || [];
    const hasAuthoritativeCount = snapshot.notificationUnread != null;
    const unreadCount = Number(snapshot.notificationUnread ?? runtime.notificationUnreadCount);
    if (hasAuthoritativeCount && unreadCount === 0) return 0;
    return unreadCount || items.filter(item => !item.readAt
      && ["succeeded", "failed", "stale", "cancelled"].includes(item.status || "")).length;
  }

  function renderNotificationSummary(): void {
    setUnreadDot(notificationUnread());
  }

  function publishNotificationState(): void {
    renderNotificationSummary();
    runtime.runtimeFeatureRegistry?.notifyState(getSnapshot(),
      new Set(["notifications", "aiTasks", "notificationUnread"]));
  }

  function scheduleNotificationPoll(): void {
    if (runtime.notificationTimer != null) clearTimeout(runtime.notificationTimer);
    const active = (getSnapshot().aiTasks || []).some(task => isPendingTask(task.status));
    const attempts = runtime.backgroundResultsRetryAttempts || 0;
    if (!active && !(attempts > 0 && attempts < retryLimit)) return;
    runtime.notificationTimer = setTimeout(async () => {
      try {
        await loadNotifications();
      } finally {
        scheduleNotificationPoll();
      }
    }, 1800);
  }

  async function readNotificationSnapshot(syncResultsAfterRead: boolean): Promise<boolean> {
    const owner = runtime.currentUser?.id;
    const session = getSessionSerial();
    runtime.notificationsLoadState = "loading";
    publishNotificationState();
    try {
      const [notifications, tasks] = await Promise.all([
        request("/api/notifications"), request("/api/ai-tasks")
      ]);
      if (owner !== runtime.currentUser?.id || session !== getSessionSerial()) return false;
      const snapshot = getSnapshot();
      snapshot.notifications = notifications.items || [];
      snapshot.aiTasks = tasks.items || [];
      runtime.notificationUnreadCount = Number(notifications.unread) || 0;
      snapshot.notificationUnread = runtime.notificationUnreadCount;
      runtime.notificationsLoadState = "ready";
      publishNotificationState();
      if (syncResultsAfterRead) await syncResults(snapshot.aiTasks, owner, session);
      return owner === runtime.currentUser?.id && session === getSessionSerial();
    } catch {
      if (owner === runtime.currentUser?.id && session === getSessionSerial()) {
        runtime.notificationsLoadState = "failure";
        publishNotificationState();
      }
      return false;
    }
  }

  async function loadNotifications(): Promise<boolean> {
    return readNotificationSnapshot(true);
  }

  return Object.freeze({
    notificationUnread, renderNotificationSummary, publishNotificationState,
    scheduleNotificationPoll, readNotificationSnapshot, loadNotifications
  });
}
