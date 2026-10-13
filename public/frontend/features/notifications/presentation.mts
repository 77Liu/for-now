import { WAITING_FOR_USER_MODEL_STATUS } from "../../shared/ai-task-status.mjs";

export type AiTaskSummary = {
  id?: string;
  kind?: string;
  status?: string;
  errorCode?: unknown;
  targetId?: string;
  updatedAt?: string;
  createdAt?: string;
};
export type NotificationSummary = {
  id?: string;
  taskId?: string;
  targetId?: string;
  status?: string;
  title?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  readAt?: string;
};
export type EntryOptions = {
  retryingTaskIds?: Iterable<string>;
  formatTimestamp?: (value: string) => string;
  copyFallback?: string;
};

const STATUS_LABELS = Object.freeze({
  queued: "排队中",
  running: "处理中",
  [WAITING_FOR_USER_MODEL_STATUS]: "等待核心用户模型",
  succeeded: "已完成",
  failed: "失败",
  stale: "目标已变化",
  cancelled: "已取消"
});

const TASK_TITLES: Readonly<Record<string, string>> = Object.freeze({
  thoughtAnswer: "思绪回答",
  followUpAnswer: "追问回答",
  annotationShenji: "批注回复",
  contentImageUnderstanding: "图片理解",
  captureTranscription: "语音转写",
  onboardingClaimExtraction: "资料整理",
  thoughtDraft: "思绪回答草稿",
  thoughtPrompt: "思绪引子",
  journalAssist: "日记辅助",
  journalReflection: "日记回望",
  chat: "共参对话",
  analysis: "认知复盘",
  recordCompression: "日记录压缩"
});

const RETRYABLE_STATUSES = new Set(["failed", "stale"]);
const FAILED_TRANSCRIPTION_FALLBACK = "转写暂时失败。";
const RETAINED_AUDIO_MESSAGE = "原音已保留，可以再次尝试。";
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
} as Record<string, string>)[character] || character);
const formatTimestampDefault = (value: string | Date): string => new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
}).format(new Date(value));

function retryIds(value: unknown): string[] {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return [...new Set(values.map(text).filter(Boolean))];
}

function timestamp(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function displayTime(value: string | undefined, formatter: (value: string) => string): string {
  if (!value) return "";
  try {
    return formatter(value);
  } catch {
    return value;
  }
}

function notificationMessage(notification: NotificationSummary, task: AiTaskSummary | null, status: string): string {
  if (status === "failed" && task?.kind === "captureTranscription")
    return `${FAILED_TRANSCRIPTION_FALLBACK}${RETAINED_AUDIO_MESSAGE}`;
  if (status === "failed") return "任务暂时失败。原记录仍保留，可复制脱敏错误日志后重试。";
  if (status === "stale") return "目标内容已变化，旧结果未写入。请重新打开目标后再操作。";
  if (status === "cancelled") return "任务已取消，原记录仍保留。";
  return text(notification?.message);
}

export function transitionNotificationRetry(currentTaskIds: unknown, { type, taskId }: { type?: string; taskId?: string } = {}) {
  const id = text(taskId);
  if (!id) throw new TypeError("Notification retry requires a task id");
  if (!type || !["start", "finish"].includes(type)) throw new TypeError("Notification retry transition must be start or finish");

  const current = retryIds(currentTaskIds);
  const alreadyBusy = current.includes(id);
  const accepted = type === "start" ? !alreadyBusy : alreadyBusy;
  const next = type === "start"
    ? alreadyBusy ? current : [...current, id]
    : current.filter(value => value !== id);

  return Object.freeze({
    accepted,
    retryingTaskIds: Object.freeze(next)
  });
}

export function notificationEntryState(notification: NotificationSummary = {}, task: AiTaskSummary | null = null, {
  retryingTaskIds = [],
  formatTimestamp = formatTimestampDefault
}: EntryOptions = {}) {
  const status = text(notification.status || task?.status) || "queued";
  const taskId = text(notification.taskId || task?.id);
  const notificationId = text(notification.id);
  const targetId = text(notification.targetId || task?.targetId);
  const title = text(notification.title) || (TASK_TITLES as Record<string, string>)[String(task?.kind || "")] || "后台任务";
  const datetime = timestamp(notification.updatedAt || notification.createdAt || task?.updatedAt || task?.createdAt);
  const canRetry = Boolean(taskId && task?.id === taskId
    && typeof task.status === "string" && RETRYABLE_STATUSES.has(task.status));
  const retryBusy = canRetry && retryIds(retryingTaskIds).includes(taskId);

  return Object.freeze({
    id: notificationId,
    taskId,
    targetId,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    title,
    message: notificationMessage(notification, task, status),
    datetime,
    timeLabel: displayTime(datetime, formatTimestamp),
    unread: !text(notification.readAt),
    canOpen: Boolean(targetId),
    canRetry,
    retryBusy
  });
}

function actionLabel(action: string, title: string): string {
  if (action === "open") return `查看${title}详情`;
  if (action === "retry") return `重试${title}`;
  if (action === "retrying") return `正在重试${title}`;
  return `将${title}通知标为已读`;
}

export function notificationEntryMarkup(notification: NotificationSummary = {}, task: AiTaskSummary | null = null, options: EntryOptions = {}) {
  const state = notificationEntryState(notification, task, options);
  const html = escapeHtml;
  const open = state.canOpen
    ? `<button class="subtle-action" type="button" data-notification-open="${html(state.targetId)}" data-notification-task="${html(state.taskId)}" data-notification-id="${html(state.id)}" aria-label="${html(actionLabel("open", state.title))}">查看</button>`
    : "";
  const reread = state.canOpen && task?.status === "succeeded"
    ? `<button class="subtle-action" type="button" data-result-reread="${html(state.taskId)}" data-notification-id="${html(state.id)}">重新读取</button>`
    : "";
  const retry = state.canRetry
    ? `<button class="subtle-action" type="button" data-task-retry="${html(state.taskId)}" aria-label="${html(actionLabel(state.retryBusy ? "retrying" : "retry", state.title))}"${state.retryBusy ? ' aria-busy="true" disabled' : ""}>${state.retryBusy ? "正在重试" : "重试"}</button>`
    : "";
  const markRead = state.unread
    ? `<button class="subtle-action" type="button" data-notification-read="${html(state.id)}" aria-label="${html(actionLabel("read", state.title))}">标为已读</button>`
    : "";
  const copyLog = ["failed", "stale"].includes(state.status)
    ? `<button class="subtle-action" type="button" data-notification-copy="${html(state.id)}">复制错误日志</button>`
    : "";
  const fallback = options.copyFallback
    ? `<div class="notification-copy-fallback"><label>脱敏错误日志<textarea readonly data-notification-copy-fallback="${html(state.id)}" aria-label="脱敏错误日志，可手动选择复制">${html(options.copyFallback)}</textarea></label><button class="subtle-action" type="button" data-notification-copy-fallback-select="${html(state.id)}">选择日志</button><button class="subtle-action" type="button" data-notification-copy-fallback-dismiss="${html(state.id)}">收起</button></div>`
    : "";
  const time = state.datetime
    ? `<time datetime="${html(state.datetime)}">${html(state.timeLabel)}</time>`
    : "";

  return `<article class="notification-entry${state.unread ? " unread" : ""}" data-status="${html(state.status)}"><div class="notification-entry-copy"><header><b>${html(state.title)}</b><span aria-label="状态：${html(state.statusLabel)}">${html(state.statusLabel)}</span>${time}</header><p>${html(state.message)}</p></div><div class="notification-entry-actions">${open}${reread}${retry}${copyLog}${markRead}</div>${fallback}</article>`;
}
