/**
 * 思绪、追问、批注和图片任务的认领、等待及恢复状态事务。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：恢复只读任务、通知及必要目标；模型准备在事务外以修订号绑定。
 */
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, ObjectRow, RecordTransaction
} from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { StoreMapping } from "../../shared/persistence/record-command-types.mjs";
import { addThoughtClosureChanges } from "../../modules/thoughts/local-changes.mjs";
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";

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
type CleanupInput<Result> = {
  taskId: string;
  attempt: number;
  mutate(store: RecordStore): Result;
  assertCommit(before: RecordStore, after: RecordStore): void;
};
const conflict = () => Object.assign(new Error("任务上下文已变化，请重新校验"), {
  statusCode: 409,
  code: "VERSION_CONFLICT"
});

async function recoveryTargets(ports: RecordTransaction, task: RecordEntity, mapping: StoreMapping) {
  const collections: Record<string, string> = {
    thought: "thoughts",
    capture: "captures",
    journal: "journals",
    chat: "chats",
    analysis: "analyses",
    book: "books",
    quote: "quotes"
  };
  const collection = collections[String(task.resourceType)]
    || (["thoughtAnswer", "followUpAnswer"].includes(String(task.kind)) ? "thoughts" : "");
  if (!collection) return {};
  const targetKey = recordObjectKey(collection, String(task.targetId || ""));
  const field = task.kind === "followUpAnswer" ? "followUps" : "annotations";
  const requiresChild = ["followUpAnswer", "annotationShenji"].includes(String(task.kind))
    || (task.kind === "contentImageUnderstanding"
      && (task.payload as { targetType?: string } | undefined)?.targetType === "comment");
  const keys = [targetKey];
  if (requiresChild) {
    keys.push(JSON.stringify([collection, task.targetId, field, task.subtargetId]));
  }
  const rows = await ports.objects.findMany(keys);
  const store = createThoughtRecordRepository(mapping).rebuildRecordCollections(rows, [collection]);
  freezeContext(store);
  return store;
}

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
  /** 游标分页恢复候选；没有模型任务时不读取个人上下文。 @since unreleased */
  const candidates = async (statuses: string[], afterId = "") => {
    const result = await unitOfWork.run({ commandId: "task.recoveryCandidates" },
      ports => ports.objects.findTaskPage(statuses, afterId));
    return result.value.map(row => row.payload as RecordEntity);
  };
  /** 纯恢复不接受账户快照；同事务校验本任务、通知和主/子目标。 @since unreleased */
  const recover = async <Result,>(input: {
    taskId: string;
    mutate(store: RecordStore): Result;
  }) => {
    const committed = await unitOfWork.run({ commandId: "task.recover" }, async ports => {
      const repository = createTaskRecordRepository(ports);
      const taskRow = await repository.find(input.taskId);
      if (!taskRow) return null;
      if (!supports(taskRow.payload)) throw new TypeError("Task recovery kind is unsupported");
      if (!["queued", "running", "cancelling"].includes(taskRow.status)) return false;
      const notification = await repository.notification(taskRow);
      if (taskRow.payload.internal !== true && !notification) {
        throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
          statusCode: 503,
          code: "ACCOUNT_DATA_INVALID"
        });
      }
      const task = structuredClone(taskRow.payload);
      const targets = task.status === "queued" ? await recoveryTargets(ports, task, mapping) : {};
      const context: RecordStore = Object.freeze({
        ...targets,
        aiTasks: [task],
        notifications: notification ? [structuredClone(notification.payload)] : []
      });
      const result = input.mutate(context);
      if (context.aiTasks.length !== 1 || task.id !== input.taskId
        || context.notifications.length !== (notification ? 1 : 0)
        || (notification && context.notifications[0].id !== notification.id)) {
        throw new TypeError("Task recovery must preserve task and notification identities");
      }
      await updateStatusRows(ports, [taskRow, ...(notification ? [notification] : [])],
        [task, ...context.notifications], mapping);
      return result;
    });
    return committed.value;
  };
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
  /** 隔离收尾只读本任务与通知；权限差分在写入版本前核验。 @since unreleased */
  const cleanup = async <Result,>(input: CleanupInput<Result>) => {
    if (!Number.isSafeInteger(input.attempt) || typeof input.assertCommit !== "function") {
      throw new TypeError("Account task cleanup identity and commit guard are required");
    }
    const committed = await unitOfWork.run({
      commandId: "task.accountRecoveryCleanup"
    }, async ports => {
      const repository = createTaskRecordRepository(ports);
      const taskRow = await repository.find(input.taskId);
      if (!taskRow) return null;
      if (!supports(taskRow.payload)) throw new TypeError("Task cleanup kind is unsupported");
      if (taskRow.payload.attempt !== input.attempt
        || !["queued", "running", "cancelling"].includes(taskRow.status)) return false;
      const notification = await repository.notification(taskRow);
      const rows = [taskRow, ...(notification ? [notification] : [])];
      const before = {
        aiTasks: [structuredClone(taskRow.payload)],
        notifications: notification ? [structuredClone(notification.payload)] : []
      } as RecordStore;
      const context = structuredClone(before);
      const result = input.mutate(context);
      input.assertCommit(before, context);
      if (context.aiTasks.length !== 1 || context.aiTasks[0].id !== input.taskId
        || context.notifications.length !== (notification ? 1 : 0)
        || (notification && context.notifications[0].id !== notification.id)) {
        throw new TypeError("Task cleanup must preserve task and notification identities");
      }
      await updateStatusRows(ports, rows, [...context.aiTasks, ...context.notifications], mapping);
      return result;
    });
    return committed.value;
  };
  return Object.freeze({
    supports,
    transition,
    candidates,
    recover,
    cleanup,
    prepareSnapshot(snapshot: RecordStore): RecordStore {
      const context = structuredClone(snapshot);
      freezeContext(context);
      return context;
    }
  });
}
