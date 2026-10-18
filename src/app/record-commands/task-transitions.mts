/**
 * 思绪、追问、批注和图片任务的认领、等待及恢复状态事务。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：个人上下文在事务外读取并以修订号绑定；事务只写本任务及其通知。
 */
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, ObjectRow, RecordTransaction
} from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { StoreMapping } from "../../shared/persistence/record-command-types.mjs";
import { addThoughtClosureChanges } from "../../modules/thoughts/local-changes.mjs";

const supportedKinds = new Set([
  "thoughtAnswer", "followUpAnswer", "annotationShenji", "contentImageUnderstanding"
]);
export const supportsRecordTask = (task: { kind?: string } | null | undefined) => (
  supportedKinds.has(String(task?.kind).trim())
);
type Action = "claim" | "releaseWaiting" | "recover";
type Input<Result> = {
  taskId: string;
  action: Action;
  snapshot: RecordStore;
  expectedRevision: string;
  mutate(store: RecordStore): Result;
};
const conflict = () => Object.assign(new Error("任务上下文已变化，请重新校验"), {
  statusCode: 409,
  code: "VERSION_CONFLICT"
});

function freezeContext(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeContext(child);
}

async function updateStatusRows(
  ports: RecordTransaction,
  rows: ObjectRow[],
  values: RecordEntity[],
  mapping: StoreMapping
) {
  const updated: ObjectRow[] = [];
  for (const [index, row] of rows.entries()) {
    const value = values[index];
    if (mapping.canonicalJson(row.payload) === mapping.canonicalJson(value)) {
      updated.push(row);
      continue;
    }
    const stableFields = row.collection === "aiTasks"
      ? ["kind", "resourceType", "targetId", "subtargetId", "resultId", "payload"]
      : ["taskId", "resourceType", "targetId", "subtargetId"];
    if (stableFields.some(field => mapping.canonicalJson(row.payload[field] ?? null)
      !== mapping.canonicalJson(value[field] ?? null))) {
      throw new TypeError("Task transition cannot change target relationships");
    }
    const version = row.version + 1;
    const next = {
      ...row,
      status: String(value.status || ""),
      content: row.collection === "notifications" ? String(value.message || "") : row.content,
      version,
      payload: { ...value, version }
    };
    if (!await ports.objects.update(next, row.version)) throw conflict();
    updated.push(next);
  }
  addThoughtClosureChanges(ports, rows, updated, "");
}

/** 复用现有任务纯状态机；来源对象只读，不能从状态钩子绕过记录命令。 @since unreleased */
export function createTaskTransitionCommands({
  unitOfWork,
  mapping
}: {
  unitOfWork: AccountUnitOfWork;
  mapping: StoreMapping;
}) {
  const supports = supportsRecordTask;
  const transition = async <Result,>(input: Input<Result>) => {
    if (!["claim", "releaseWaiting", "recover"].includes(input.action)) {
      throw new TypeError("Task transition action is invalid");
    }
    const sourceContext = Object.fromEntries(Object.entries(input.snapshot)
      .filter(([field]) => !["aiTasks", "notifications"].includes(field)));
    const preparedContext = structuredClone(sourceContext);
    freezeContext(preparedContext);
    const expected = input.snapshot.aiTasks.find(task => task.id === input.taskId);
    const otherTasks = structuredClone(input.snapshot.aiTasks.filter(task => task.id !== input.taskId));
    freezeContext(otherTasks);
    const committed = await unitOfWork.run({
      commandId: `task.${input.action}`,
      expectedRevision: input.expectedRevision
    }, async ports => {
      const repository = createTaskRecordRepository(ports);
      const taskRow = await repository.find(input.taskId);
      if (!taskRow) return null;
      if (!supports(taskRow.payload)) throw new TypeError("Task transition kind is unsupported");
      if (!expected || mapping.canonicalJson(expected) !== mapping.canonicalJson(taskRow.payload)) {
        throw conflict();
      }
      const notification = await repository.notification(taskRow);
      if (taskRow.payload.internal !== true && !notification) {
        throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
          statusCode: 503,
          code: "ACCOUNT_DATA_INVALID"
        });
      }
      const rows = [taskRow, ...(notification ? [notification] : [])];
      const task = structuredClone(taskRow.payload);
      const context: RecordStore = Object.freeze({
        ...preparedContext,
        aiTasks: Object.freeze([task, ...otherTasks]) as unknown as RecordEntity[],
        notifications: notification ? [structuredClone(notification.payload)] : []
      });
      const result = input.mutate(context);
      if (task.id !== input.taskId
        || context.notifications.length !== (notification ? 1 : 0)
        || (notification && context.notifications[0].id !== notification.id)) {
        throw new TypeError("Task transition must preserve task and notification identities");
      }
      await updateStatusRows(ports, rows, [task, ...context.notifications], mapping);
      return result;
    });
    return committed.value;
  };
  return Object.freeze({ supports, transition });
}
