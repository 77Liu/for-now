import { safeText } from "../../shared/validation/index.mjs";

const taskTitles = { thoughtAnswer: "思绪回答", followUpAnswer: "追问回答", annotationShenji: "批注神鸡", contentImageUnderstanding: "图片理解" };
const successMessages = { thoughtAnswer: "回答已生成", followUpAnswer: "追问回答已生成", annotationShenji: "批注回复已生成", contentImageUnderstanding: "图片理解已生成" };
const terminalStatuses = ["succeeded", "failed", "stale", "cancelled"];

export const notificationUnread = items => items.filter(item => !item.readAt && terminalStatuses.includes(item.status)).length;

export function createNotificationService({ createId, now }) {
  return {
    upsertTask(items, task, status, message = successMessages[task.kind] || "任务已完成") {
      let notification = items.find(item => item.taskId === task.id);
      if (!notification) {
        notification = {
          id: createId(), taskId: task.id, kind: "aiTask",
          resourceType: task.resourceType || (task.kind === "thoughtAnswer" || task.kind === "followUpAnswer" ? "thought" : ""),
          targetId: task.targetId, subtargetId: task.subtargetId || "", createdAt: now(), readAt: ""
        };
        items.unshift(notification);
      }
      Object.assign(notification, {
        status, title: taskTitles[task.kind] || "AI 任务", message: safeText(message, 500),
        updatedAt: now(), readAt: terminalStatuses.includes(status) ? "" : notification.readAt
      });
      return notification;
    },
    read(items, id) {
      const item = items.find(value => value.id === id);
      if (!item) return null;
      item.readAt = now();
      return item;
    },
    readAll(items) {
      let updated = 0;
      for (const item of items) if (!item.readAt) { item.readAt = now(); updated += 1; }
      return updated;
    }
  };
}
