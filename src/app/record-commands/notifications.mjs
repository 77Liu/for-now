import { isInternalAiTask } from "../../modules/tasks/index.mjs";

const keyOf = (collection, id) => JSON.stringify([collection, id]);
const conflict = () => Object.assign(
  new Error("通知已变化，请刷新后重试"),
  { statusCode: 409, code: "VERSION_CONFLICT" }
);
const chunks = (values, size) => Array.from(
  { length: Math.ceil(values.length / size) },
  (_, index) => values.slice(index * size, (index + 1) * size)
);

function updatedRow(row, item) {
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

function addReadChange(addChange, row) {
  addChange({
    entityType: "notification",
    entityId: row.id,
    version: row.version,
    operation: "update",
    changedFields: ["readAt", "version"],
    scopeKeys: ["notification:list", `notification:${row.id}`]
  });
}

async function readReferencedTasks(objects, notificationRows) {
  const keys = [...new Set(notificationRows
    .map(row => row.payload?.taskId)
    .filter(Boolean)
    .map(id => keyOf("aiTasks", id)))];
  const rows = [];
  for (const group of chunks(keys, 500)) {
    rows.push(...await objects.findMany(group));
  }
  return new Map(rows.map(row => [row.id, row.payload]));
}

/**
 * 创建通知记录级命令；调用方在请求开始前按 allowlist 固定新旧路径。
 * @since unreleased
 */
export function createNotificationRecordCommands({ unitOfWork, notifications }) {
  if (!unitOfWork?.run || !notifications?.read || !notifications?.readAll) {
    throw new TypeError("Notification record command dependencies are required");
  }

  const read = async id => {
    const committed = await unitOfWork.run({
      commandId: "notification.read"
    }, async ({ objects, addChange }) => {
      const row = await objects.find(keyOf("notifications", id), { lock: true });
      if (!row) return null;
      const tasks = await readReferencedTasks(objects, [row]);
      if (isInternalAiTask(tasks.get(row.payload?.taskId))) return null;
      const item = notifications.read([{ ...row.payload }], id);
      const next = updatedRow(row, item);
      if (!await objects.update(next, row.version)) throw conflict();
      addReadChange(addChange, next);
      return structuredClone(next.payload);
    });
    return committed.value;
  };

  const readAll = async () => {
    const committed = await unitOfWork.run({
      commandId: "notification.readAll"
    }, async ({ objects, addChange }) => {
      const rows = await objects.findByCollection("notifications", { lock: true });
      const tasks = await readReferencedTasks(objects, rows);
      const visible = rows.filter(row => !isInternalAiTask(tasks.get(row.payload?.taskId)));
      const unread = visible.filter(row => !row.payload?.readAt);
      const items = unread.map(row => ({ ...row.payload }));
      notifications.readAll(items);
      for (const [index, row] of unread.entries()) {
        const next = updatedRow(row, items[index]);
        if (!await objects.update(next, row.version)) throw conflict();
        addReadChange(addChange, next);
      }
      return unread.length;
    });
    return committed.value;
  };

  return Object.freeze({ read, readAll });
}
