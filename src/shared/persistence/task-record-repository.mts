/**
 * 任务与通知的事务内身份和关系仓库。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, RecordTransaction } from "./record-command-types.mjs";
import { entityRow, recordObjectKey } from "./record-command-types.mjs";
const invalidData = () => Object.assign(
  new Error("任务通知关系异常，原数据已保留"),
  { statusCode: 503, code: "ACCOUNT_DATA_INVALID" }
);

/** Resolves the unique notification owned by a task in this transaction. @since unreleased */
export async function readTaskNotification(ports: RecordTransaction, taskRow: ObjectRow) {
  const keys = await ports.relations.findSources([taskRow.objectKey], {
    relation: "task",
    sourceCollection: "notifications"
  });
  if (keys.length > 1) throw invalidData();
  const rows = await ports.objects.findMany(keys, { lock: true });
  if (rows.some(row => row.payload?.taskId !== taskRow.id)) throw invalidData();
  return rows[0] ? entityRow(rows[0]) : null;
}

/** Reads one task and its owned notification without scanning a collection. @since unreleased */
export function createTaskRecordRepository(ports: RecordTransaction) {
  return {
    async find(taskId: string) {
      const row = await ports.objects.find(recordObjectKey("aiTasks", taskId), { lock: true });
      return row ? entityRow(row) : null;
    },
    notification: (task: ObjectRow) => readTaskNotification(ports, task),
    update: (row: ObjectRow, version: number) => ports.objects.update(row, version)
  };
}

const chunks = <T,>(values: T[], size: number) => Array.from(
  { length: Math.ceil(values.length / size) },
  (_, index) => values.slice(index * size, (index + 1) * size)
);

async function readReferencedTasks(objects: RecordTransaction["objects"], notificationRows: ObjectRow[]) {
  const keys = [...new Set(notificationRows
    .map(row => row.payload?.taskId)
    .filter((id): id is string => typeof id === "string" && Boolean(id))
    .map(id => recordObjectKey("aiTasks", id)))];
  const rows = [];
  for (const group of chunks(keys, 500)) {
    rows.push(...await objects.findMany(group));
  }
  return new Map(rows.map(row => [row.id, row.payload]));
}

/** Typed notification access within the caller's transaction. @since unreleased */
export function createNotificationRecordRepository(ports: RecordTransaction) {
  return {
    async find(id: string) {
      const row = await ports.objects.find(recordObjectKey("notifications", id), { lock: true });
      return row ? entityRow(row) : null;
    },
    async list() {
      return (await ports.objects.findByCollection("notifications", { lock: true })).map(entityRow);
    },
    referencedTasks: (rows: ObjectRow[]) => readReferencedTasks(ports.objects, rows),
    update: (row: ObjectRow, version: number) => ports.objects.update(row, version)
  };
}
