/**
 * 任务取消、输入绑定及通知状态的领域命令。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, RecordEntity, RecordTransaction } from "../../shared/persistence/record-command-types.mjs";
import { entityRow } from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { TaskCommandDependencies, TaskWork } from "./record-contracts.mjs";

const unsupported = (kind: string) => Object.assign(
  new Error(`Task record cancellation does not support ${kind}`),
  { statusCode: 409, code: "RECORD_COMMAND_UNSUPPORTED" }
);
const conflict = () => Object.assign(
  new Error("任务已变化，请刷新后重试"),
  { statusCode: 409, code: "VERSION_CONFLICT" }
);

function updateRow(row: ObjectRow, item: RecordEntity) {
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

function appendChange(addChange: RecordTransaction["addChange"], row: ObjectRow, changedFields: string[], scopeKeys: string[]) {
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
export function createTaskRecordCommands({ unitOfWork, tasks, notifications, waitingStatus }: TaskCommandDependencies) {
  if (!unitOfWork?.run || !tasks?.complete || !notifications?.upsertTask) {
    throw new TypeError("Task record command dependencies are required");
  }

  const cancellableStatuses = new Set(["queued", "running", waitingStatus]);
  const cancel = async (taskId: string) => {
    const committed = await unitOfWork.run({
      commandId: "task.cancel"
    }, async ports => {
      const { addChange } = ports;
      const repository = createTaskRecordRepository(ports);
      const taskRow = await repository.find(taskId);
      if (!taskRow || !cancellableStatuses.has(String(taskRow.payload?.status))) return null;
      if (taskRow.payload?.kind === "recordCompression") {
        throw unsupported(taskRow.payload.kind);
      }
      const notificationRow = await repository.notification(taskRow);
      if (taskRow.payload?.internal !== true && !notificationRow) {
        throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
          statusCode: 503,
          code: "ACCOUNT_DATA_INVALID"
        });
      }
      const task = structuredClone(taskRow.payload);
      tasks.complete(task, "cancelled", { error: "用户取消了本次生成" });
      const nextTask = updateRow(taskRow, task);
      if (!await repository.update(nextTask, taskRow.version)) throw conflict();
      appendChange(addChange, nextTask,
        ["status", "completedAt", "updatedAt", "error", "errorCode", "version"],
        ["task:list", `task:${taskId}`]);
      if (notificationRow && task.internal !== true) {
        const notification = structuredClone(notificationRow.payload);
        notifications.upsertTask([notification], task, "cancelled", task.error);
        const nextNotification = updateRow(notificationRow, notification);
        if (!await repository.update(nextNotification, notificationRow.version)) throw conflict();
        appendChange(addChange, nextNotification,
          ["status", "message", "updatedAt", "readAt", "version"],
          ["notification:list", `notification:${notification.id}`]);
      }
      return structuredClone(nextTask.payload);
    });
    return committed.value;
  };
  const bindInput = async (taskId: string, work: TaskWork | null) => {
    const committed = await unitOfWork.run({
      commandId: "task.bindInput"
    }, async ports => {
      const { addChange } = ports;
      const repository = createTaskRecordRepository(ports);
      const row = await repository.find(taskId);
      const task = row ? entityRow(row).payload : null;
      if (!row || task?.status !== "running" || task.deferredInputBinding !== true) {
        return null;
      }
      const inputVersion = Math.max(0, Number(work?.inputVersion) || 0);
      const subtargetVersion = Math.max(0, Number(work?.subtargetVersion) || 0);
      if (!work || work.alreadyAnswered
        || (Number(task.requestedInputVersion) > 0
          && task.requestedInputVersion !== inputVersion)
        || (Number(task.requestedSubtargetVersion) > 0
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
      if (!await repository.update(next, row.version)) throw conflict();
      appendChange(addChange, next,
        ["inputVersion", "subtargetVersion", "inputHash", "version"],
        ["task:list", `task:${taskId}`]);
      return structuredClone(next.payload);
    });
    return committed.value;
  };

  return Object.freeze({ cancel, bindInput });
}
