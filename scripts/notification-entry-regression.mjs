import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
const notificationModule = new URL(
  "../public/frontend/features/notifications/index.mjs",
  import.meta.url
);
const {
  notificationEntryMarkup,
  notificationEntryState,
  transitionNotificationRetry
} = await import(notificationModule);

const failedNotification = {
  id: "notification-asr-1",
  taskId: "task-asr-1",
  targetId: "capture-1",
  status: "failed",
  title: "语音转写",
  message: "ASR_PROVIDER_INTERNAL: upstream request failed",
  createdAt: "2026-10-03T07:40:00.000Z",
  updatedAt: "2026-10-03T07:42:18.000Z",
  readAt: ""
};
const failedTask = {
  id: "task-asr-1",
  kind: "captureTranscription",
  targetId: "capture-1",
  status: "failed"
};
const notificationBefore = structuredClone(failedNotification);
const taskBefore = structuredClone(failedTask);
const formatTimestamp = value => {
  assert.equal(value, "2026-10-03T07:42:18.000Z");
  return "10月3日 15:42";
};

const failedState = notificationEntryState(failedNotification, failedTask, { formatTimestamp });
assert.deepEqual(failedState, {
  id: "notification-asr-1",
  taskId: "task-asr-1",
  targetId: "capture-1",
  status: "failed",
  statusLabel: "失败",
  title: "语音转写",
  message: "转写暂时失败。原音已保留，可以再次尝试。",
  datetime: "2026-10-03T07:42:18.000Z",
  timeLabel: "10月3日 15:42",
  unread: true,
  canOpen: true,
  canRetry: true,
  retryBusy: false
});

const failedMarkup = notificationEntryMarkup(failedNotification, failedTask, { formatTimestamp });
assert.match(failedMarkup, /^<article class="notification-entry unread" data-status="failed">/);
assert.match(failedMarkup, /<b>语音转写<\/b><span aria-label="状态：失败">失败<\/span>/);
assert.match(failedMarkup, /<time datetime="2026-10-03T07:42:18\.000Z">10月3日 15:42<\/time>/);
assert.match(failedMarkup, /<p>转写暂时失败。原音已保留，可以再次尝试。<\/p>/);
assert.match(failedMarkup, /data-notification-open="capture-1"[^>]+aria-label="查看语音转写详情">查看<\/button>/);
assert.match(failedMarkup, /data-task-retry="task-asr-1"[^>]+aria-label="重试语音转写">重试<\/button>/);
assert.match(failedMarkup, /data-notification-read="notification-asr-1"[^>]+aria-label="将语音转写通知标为已读">标为已读<\/button>/);
assert.doesNotMatch(failedMarkup, /ASR_PROVIDER_INTERNAL/);
const requiredCopy = ["语音转写", "失败", "10月3日 15:42", "原音已保留", "查看", "重试", "标为已读"];
let previousPosition = -1;
for (const copy of requiredCopy) {
  const position = failedMarkup.indexOf(copy, previousPosition + 1);
  assert.ok(position > previousPosition, `${copy} should appear in the expected reading order`);
  previousPosition = position;
}
assert.deepEqual(failedNotification, notificationBefore);
assert.deepEqual(failedTask, taskBefore);

const started = transitionNotificationRetry([], { type: "start", taskId: failedTask.id });
assert.equal(started.accepted, true);
assert.deepEqual(started.retryingTaskIds, ["task-asr-1"]);
const duplicateStart = transitionNotificationRetry(started.retryingTaskIds, {
  type: "start",
  taskId: failedTask.id
});
assert.equal(duplicateStart.accepted, false);
assert.deepEqual(duplicateStart.retryingTaskIds, ["task-asr-1"]);

const busyMarkup = notificationEntryMarkup(failedNotification, failedTask, {
  retryingTaskIds: duplicateStart.retryingTaskIds,
  formatTimestamp
});
assert.match(
  busyMarkup,
  /data-task-retry="task-asr-1" aria-label="正在重试语音转写" aria-busy="true" disabled>正在重试<\/button>/
);
assert.equal((busyMarkup.match(/data-task-retry=/g) || []).length, 1);
const finished = transitionNotificationRetry(duplicateStart.retryingTaskIds, {
  type: "finish",
  taskId: failedTask.id
});
assert.equal(finished.accepted, true);
assert.deepEqual(finished.retryingTaskIds, []);

const unsafeTitle = '提醒"><img src=x onerror="alert(1)';
const unsafeTarget = 'capture"><script>alert(2)</script>';
const longMessage = `${"<script>alert(3)</script>&\"".repeat(700)}末尾保留`;
const unsafeNotification = {
  id: 'notice" onclick="alert(4)',
  taskId: "task-long",
  targetId: unsafeTarget,
  status: "failed",
  title: unsafeTitle,
  message: longMessage,
  updatedAt: "2026-10-03T08:00:00+08:00",
  readAt: "2026-10-03T08:01:00+08:00"
};
const unsafeTask = {
  id: "task-long",
  kind: "thoughtAnswer",
  status: "failed"
};
const safeMarkup = notificationEntryMarkup(unsafeNotification, unsafeTask, {
  formatTimestamp: () => "10月3日 08:00"
});
assert.doesNotMatch(safeMarkup, /<(?:script|img)\b/i);
assert.doesNotMatch(safeMarkup, /\s(?:onclick|onerror)=["']/i);
assert.match(safeMarkup, /提醒&quot;&gt;&lt;img src=x onerror=&quot;alert\(1\)/);
assert.match(safeMarkup, /capture&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
assert.match(safeMarkup, /&lt;script&gt;alert\(3\)&lt;\/script&gt;&amp;&quot;/);
assert.match(safeMarkup, /末尾保留<\/p>/);
assert.match(safeMarkup, /datetime="2026-10-03T00:00:00\.000Z"/);
assert.doesNotMatch(safeMarkup, /data-notification-read=/);

const source = await fs.readFile(
  notificationModule,
  "utf8"
);
assert.doesNotMatch(
  source,
  /\b(?:document|window|fetch|XMLHttpRequest|FileReader)\b/,
  "Notification entry helper must stay independent of DOM globals and network I/O"
);

console.log("Notification entry checks passed: failed transcription copy, semantic markup, accessible actions, retry deduplication/busy state and long-text escaping.");
