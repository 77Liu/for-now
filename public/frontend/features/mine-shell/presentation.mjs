export const MINE_SELECTORS = Object.freeze({
  accountName: "#mine-account-name",
  notificationCount: "#mine-notification-count",
  governanceLink: "#mine-governance-link",
  syncRow: ".sync-health-row",
  syncStatus: "#mine-sync-status",
  syncCount: "#mine-sync-count",
  appVersion: "#mine-app-version"
});

export const PERMISSION_SELECTORS = Object.freeze({
  title: "#permission-title",
  copy: "#permission-copy"
});

const OWNER_VIEW_NAMES = Object.freeze({
  "ai-cost": "AI 成本",
  architecture: "架构设计",
  commercialization: "商业化"
});

const terminalNotification = item => (
  !item?.readAt
  && ["succeeded", "failed", "stale", "cancelled"].includes(item?.status)
);

export function notificationUnread(snapshot = {}, fallback = 0) {
  return Number(snapshot?.notificationUnread ?? fallback)
    || (Array.isArray(snapshot?.notifications)
      ? snapshot.notifications.filter(terminalNotification).length
      : 0);
}

export function syncHealthPresentation(value = {}) {
  const health = {
    status: "idle",
    pending: 0,
    conflicts: 0,
    failed: 0,
    oldestAgeMs: 0,
    enqueueToAckP95Ms: 0,
    lastPullMs: 0,
    ...value
  };
  let status;
  if (health.status === "disabled") {
    status = "增量同步已关闭，继续使用写后刷新";
  } else if (health.status === "conflict") {
    status = `${health.conflicts} 项同步冲突，请核对最新内容后重试`;
  } else if (health.status === "degraded") {
    status = "浏览器不支持持久队列，本次会话使用内存同步";
  } else if (health.status === "error") {
    status = health.failed
      ? `${health.failed} 项操作重试失败，请保留当前页面并重新提交`
      : "同步暂时中断，将在回到前台或网络恢复后重试";
  } else if (health.pending) {
    status = `${health.pending} 项操作等待服务端确认${
      health.oldestAgeMs > 30000 ? "，已有操作超过 30 秒" : ""
    }`;
  } else if (health.status === "synced") {
    status = `已与服务端对齐${
      health.lastPullMs ? ` · 拉取 ${health.lastPullMs} ms` : ""
    }${
      health.enqueueToAckP95Ms
        ? ` · 写确认 P95 ${health.enqueueToAckP95Ms} ms`
        : ""
    }`;
  } else {
    status = "正在核对本地操作与服务端状态";
  }
  const count = health.conflicts
    ? `${health.conflicts} 冲突`
    : health.failed
      ? `${health.failed} 失败`
      : health.pending
        ? `${health.pending} 项`
        : "";
  return Object.freeze({ status: String(health.status || "idle"), copy: status, count });
}

export function versionLabel(value) {
  const version = String(value ?? "");
  return version.startsWith("v") ? version : `v${version}`;
}

export function renderMineSurface({
  root,
  user,
  snapshot,
  notificationFallback,
  syncHealth,
  governanceUrl,
  releaseVersion
}) {
  const accountName = root.querySelector(MINE_SELECTORS.accountName);
  const notificationCount = root.querySelector(MINE_SELECTORS.notificationCount);
  const governance = root.querySelector(MINE_SELECTORS.governanceLink);
  const syncRow = root.querySelector(MINE_SELECTORS.syncRow);
  const syncStatus = root.querySelector(MINE_SELECTORS.syncStatus);
  const syncCount = root.querySelector(MINE_SELECTORS.syncCount);
  const appVersion = root.querySelector(MINE_SELECTORS.appVersion);
  const unread = notificationUnread(snapshot, notificationFallback);
  const sync = syncHealthPresentation(syncHealth);
  const release = versionLabel(releaseVersion);

  if (accountName) accountName.textContent = user?.username || "本机使用";
  if (notificationCount) notificationCount.textContent = unread ? `${unread} 条未读` : "";
  if (governance) {
    governance.hidden = !governanceUrl;
    if (governanceUrl) governance.href = governanceUrl;
  }
  if (syncRow) syncRow.dataset.syncStatus = sync.status;
  if (syncStatus) syncStatus.textContent = sync.copy;
  if (syncCount) syncCount.textContent = sync.count;
  if (appVersion) appVersion.textContent = release;
  return release;
}

export function scrubMineSurface(root) {
  const accountName = root.querySelector?.(MINE_SELECTORS.accountName);
  const notificationCount = root.querySelector?.(MINE_SELECTORS.notificationCount);
  const governance = root.querySelector?.(MINE_SELECTORS.governanceLink);
  const syncRow = root.querySelector?.(MINE_SELECTORS.syncRow);
  const syncStatus = root.querySelector?.(MINE_SELECTORS.syncStatus);
  const syncCount = root.querySelector?.(MINE_SELECTORS.syncCount);
  const appVersion = root.querySelector?.(MINE_SELECTORS.appVersion);
  if (accountName) accountName.textContent = "本机使用";
  if (notificationCount) notificationCount.textContent = "";
  if (governance) {
    governance.hidden = true;
    if (typeof governance.removeAttribute === "function") governance.removeAttribute("href");
    else governance.href = "";
  }
  if (syncRow) syncRow.dataset.syncStatus = "idle";
  if (syncStatus) syncStatus.textContent = "正在核对本地操作与服务端状态";
  if (syncCount) syncCount.textContent = "";
  if (appVersion) appVersion.textContent = "";
}

export function renderPermissionSurface(root, { view, capability } = {}) {
  const title = root.querySelector(PERMISSION_SELECTORS.title);
  const copy = root.querySelector(PERMISSION_SELECTORS.copy);
  if (title) title.textContent = `${OWNER_VIEW_NAMES[view] || "此页面"}仅 Owner 可访问`;
  if (copy) {
    copy.textContent = `当前账户没有访问此管理页面的权限（${capability || ""}）。敏感内容未加载，你仍可继续使用个人记录与偏好设置。`;
  }
  return true;
}

export function scrubPermissionSurface(root) {
  const title = root.querySelector?.(PERMISSION_SELECTORS.title);
  const copy = root.querySelector?.(PERMISSION_SELECTORS.copy);
  if (title) title.textContent = "此页面仅 Owner 可访问";
  if (copy) {
    copy.textContent = "当前账户可以继续使用个人记录与偏好设置。管理内容不会在此会话中加载。";
  }
}
