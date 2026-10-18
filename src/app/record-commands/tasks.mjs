import { WAITING_FOR_USER_MODEL_STATUS } from "../../shared/core-model-gate.mjs";
import { readTaskNotification } from "./task-notification.mjs";

const keyOf = (collection, id) => JSON.stringify([collection, id]);
const cancellableStatuses = new Set(["queued", "running", WAITING_FOR_USER_MODEL_STATUS]);
const unsupported = kind => Object.assign(
  new Error(`Task record cancellation does not support ${kind}`),
  { statusCode: 409, code: "RECORD_COMMAND_UNSUPPORTED" }
);
const conflict = () => Object.assign(
  new Error("任务已变化，请刷新后重试"),
  { statusCode: 409, code: "VERSION_CONFLICT" }
);

function updateRow(row, item) {
  const currentVersion = Number(row.version);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new TypeError("Task record version is invalid");
  }
  const version = currentVersion + 1;
  return {
    ...row,
    content: typeof item.message === "string" ? item.message : "",
    status: typeof item.status === "string" ? item.status : "",
    authorType: typeof item.authorType === "string" ? item.authorType : "",
    version,
    payload: { ...item, version }
  };
}

function appendChange(addChange, row, changedFields, scopeKeys) {
  addChange({
    entityType: row.kind,
    entityId: row.id,
    version: row.version,
    operation: "update",
    changedFields,
    scopeKeys
  });
}

/**
 * 创建任务状态记录级命令；当前只承接闭包为任务与已有通知的用户取消。
 * @since unreleased
 */
export function createTaskRecordCommands({ unitOfWork, tasks, notifications }) {
  if (!unitOfWork?.run || !tasks?.complete || !notifications?.upsertTask) {
    throw new TypeError("Task record command dependencies are required");
  }

  const cancel = async taskId => {
    const committed = await unitOfWork.run({
      commandId: "task.cancel"
    }, async ports => {
      const { objects, addChange } = ports;
      const taskRow = await objects.find(keyOf("aiTasks", taskId), { lock: true });
      if (!taskRow || !cancellableStatuses.has(taskRow.payload?.status)) return null;
      if (taskRow.payload?.kind === "recordCompression") {
        throw unsupported(taskRow.payload.kind);
      }
      const notificationRow = await readTaskNotification(ports, taskRow);
      if (taskRow.payload?.internal !== true && !notificationRow) {
        throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
          statusCode: 503,
          code: "ACCOUNT_DATA_INVALID"
        });
      }
      const task = structuredClone(taskRow.payload);
      tasks.complete(task, "cancelled", { error: "用户取消了本次生成" });
      const nextTask = updateRow(taskRow, task);
      if (!await objects.update(nextTask, taskRow.version)) throw conflict();
      appendChange(addChange, nextTask,
        ["status", "completedAt", "updatedAt", "error", "errorCode", "version"],
        ["task:list", `task:${taskId}`]);
      if (notificationRow && task.internal !== true) {
        const notification = structuredClone(notificationRow.payload);
        notifications.upsertTask([notification], task, "cancelled", task.error);
        const nextNotification = updateRow(notificationRow, notification);
        if (!await objects.update(nextNotification, notificationRow.version)) throw conflict();
        appendChange(addChange, nextNotification,
          ["status", "message", "updatedAt", "readAt", "version"],
          ["notification:list", `notification:${notification.id}`]);
      }
      return structuredClone(nextTask.payload);
    });
    return committed.value;
  };
  const bindInput = async (taskId, work) => {
    const committed = await unitOfWork.run({
      commandId: "task.bindInput"
    }, async ({ objects, addChange }) => {
      const row = await objects.find(keyOf("aiTasks", taskId), { lock: true });
      const task = row?.payload;
      if (!row || task?.status !== "running" || task.deferredInputBinding !== true) {
        return null;
      }
      const inputVersion = Math.max(0, Number(work?.inputVersion) || 0);
      const subtargetVersion = Math.max(0, Number(work?.subtargetVersion) || 0);
      if (!work || work.alreadyAnswered
        || (task.requestedInputVersion > 0
          && task.requestedInputVersion !== inputVersion)
        || (task.requestedSubtargetVersion > 0
          && task.requestedSubtargetVersion !== subtargetVersion)) {
        throw conflict();
      }
      const nextTask = structuredClone(task);
      nextTask.inputVersion = inputVersion;
      nextTask.subtargetVersion = subtargetVersion;
      nextTask.inputHash = work.inputHash || "";
      nextTask.requestedInputVersion = inputVersion;
      nextTask.requestedSubtargetVersion = subtargetVersion;
      nextTask.requestedInputHash = nextTask.inputHash;
      delete nextTask.deferredInputBinding;
      const next = updateRow(row, nextTask);
      if (!await objects.update(next, row.version)) throw conflict();
      appendChange(addChange, next,
        ["inputVersion", "subtargetVersion", "inputHash", "version"],
        ["task:list", `task:${taskId}`]);
      return structuredClone(next.payload);
    });
    return committed.value;
  };

  return Object.freeze({ cancel, bindInput });
}
