/**
 * 通知已读命令及对应变化清单；只操作当前通知闭包。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, RecordEntity, RecordTransaction, AccountUnitOfWork } from "../../shared/persistence/record-command-types.mjs";
import { entityRow } from "../../shared/persistence/record-command-types.mjs";
import { createNotificationRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { NotificationServices } from "../tasks/record-contracts.mjs";
const conflict = () => Object.assign(
  new Error("通知已变化，请刷新后重试"),
  { statusCode: 409, code: "VERSION_CONFLICT" }
);

function updatedRow(row: ObjectRow, item: RecordEntity) {
  const currentVersion = Number(row.version);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new TypeError("Notification record version is invalid");
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

function addReadChange(addChange: RecordTransaction["addChange"], row: ObjectRow) {
  addChange({
    entityType: "notification",
    entityId: row.id,
    version: row.version,
    operation: "update",
    changedFields: ["readAt", "version"],
    scopeKeys: ["notification:list", `notification:${row.id}`]
  });
}


/**
 * 创建通知记录级命令；调用方在请求开始前按 allowlist 固定新旧路径。
 * @since unreleased
 */
export function createNotificationRecordCommands({ unitOfWork, notifications, isInternalAiTask }: {
  unitOfWork: AccountUnitOfWork; notifications: NotificationServices;
  isInternalAiTask(task: Record<string, unknown> | undefined): boolean;
}) {
  if (!unitOfWork?.run || !notifications?.read || !notifications?.readAll) {
    throw new TypeError("Notification record command dependencies are required");
  }

  const read = async (id: string) => {
    const committed = await unitOfWork.run({
      commandId: "notification.read"
    }, async ports => {
      const { addChange } = ports;
      const repository = createNotificationRecordRepository(ports);
      const row = await repository.find(id);
      if (!row) return null;
      const tasks = await repository.referencedTasks([row]);
      if (isInternalAiTask(tasks.get(String(row.payload?.taskId || "")))) return null;
      const item = notifications.read([{ ...entityRow(row).payload }], id);
      if (!item) return null;
      const next = updatedRow(row, item);
      if (!await repository.update(next, row.version)) throw conflict();
      addReadChange(addChange, next);
      return structuredClone(next.payload);
    });
    return committed.value;
  };

  const readAll = async () => {
    const committed = await unitOfWork.run({
      commandId: "notification.readAll"
    }, async ports => {
      const { addChange } = ports;
      const repository = createNotificationRecordRepository(ports);
      const rows = await repository.list();
      const tasks = await repository.referencedTasks(rows);
      const visible = rows.filter(row => !isInternalAiTask(tasks.get(String(row.payload?.taskId || ""))));
      const unread = visible.filter(row => !row.payload?.readAt);
      const items = unread.map(row => ({ ...entityRow(row).payload }));
      notifications.readAll(items);
      for (const [index, row] of unread.entries()) {
        const next = updatedRow(row, items[index]);
        if (!await repository.update(next, row.version)) throw conflict();
        addReadChange(addChange, next);
      }
      return unread.length;
    });
    return committed.value;
  };

  return Object.freeze({ read, readAll });
}
