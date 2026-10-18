/**
 * 思绪记录命令、任务结果接纳与删除传播的领域规则。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, RecordEntity, RecordStore, RecordTransaction } from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT, recordObjectKey as keyOf } from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import { ensureThoughtLifecycles, markThoughtLifecycleDeleted } from "./record-lifecycle.mjs";
import type { ThoughtCreateInput, ThoughtInput, ThoughtResult, ThoughtServices, ThoughtWriteback, ThoughtFailure, TrashEntry, SettlementServices } from "./record-contracts.mjs";
type TaskClosure = NonNullable<Awaited<ReturnType<typeof readTaskClosure>>>;

const unsupported = (message: string) => Object.assign(
  new Error(message),
  { statusCode: 409, code: "RECORD_COMMAND_UNSUPPORTED" }
);

function idempotencyForCreate(input: ThoughtCreateInput, timestamp: string) {
  if (!input.clientRequestId) {
    throw unsupported("记录级思绪创建需要幂等标识");
  }
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) throw new TypeError("Thought record command now() is invalid");
  return {
    scope: "thoughtChains.create",
    key: input.clientRequestId,
    requestHash: input.requestHash || "",
    expiresAt: new Date(createdAt.getTime() + 90 * 86400000).toISOString()
  };
}

async function readTaskClosure(ports: RecordTransaction, taskId: string, repository: ThoughtRecordRepository) {
  const taskRow = await createTaskRecordRepository(ports).find(taskId);
  if (!taskRow) return null;
  const thoughtClosure = await repository.readThoughtClosure(
    ports.objects,
    ports.relations,
    String(taskRow.payload?.targetId || "")
  );
  const notificationRow = await createTaskRecordRepository(ports).notification(taskRow);
  if (taskRow.payload?.internal !== true && !notificationRow) {
    throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
      statusCode: 503,
      code: "ACCOUNT_DATA_INVALID"
    });
  }
  const rows = [...new Map([
    taskRow,
    ...(notificationRow ? [notificationRow] : []),
    ...(thoughtClosure?.rows || [])
  ].map(row => [row.objectKey, row])).values()];
  const store = repository.rebuildRecordCollections(rows, ["thoughts", "aiTasks", "notifications"]);
  return { rows, store, taskRow, notificationRow, thoughtClosure };
}

function completeTaskInStore(store: RecordStore, task: RecordEntity, status: string, services: SettlementServices, error: ThoughtFailure = null) {
  const terminal = status === "succeeded"
    ? { resultId: task.resultId || "" }
    : {
        error: status === "cancelled"
          ? "用户取消了本次生成"
          : status === "stale"
            ? "目标已修改或删除"
            : error?.message || "生成失败",
        errorCode: status === "cancelled"
          ? "AI_TASK_CANCELLED"
          : status === "stale"
            ? "AI_TASK_STALE"
            : error?.code || "AI_TASK_FAILED"
      };
  services.tasks.complete(task, status, terminal);
  if (task.internal !== true) {
    services.notifications.upsertTask(
      store.notifications,
      task,
      status,
      status === "succeeded" ? undefined : task.error
    );
  }
}

function addTaskAndNotificationChanges(ports: RecordTransaction, rows: ObjectRow[], task: RecordEntity, notification: RecordEntity | null) {
  const taskRow = rows.find(row => row.collection === "aiTasks" && row.id === task.id);
  ports.addChange({
    entityType: "aiTask",
    entityId: task.id,
    version: taskRow!.version,
    operation: "update",
    changedFields: ["status", "resultId", "completedAt", "updatedAt", "error", "errorCode", "version"],
    scopeKeys: ["task:list", `task:${task.id}`]
  });
  if (!notification) return;
  const row = rows.find(item => (
    item.collection === "notifications" && item.id === notification!.id
  ));
  ports.addChange({
    entityType: "notification",
    entityId: notification!.id,
    version: row!.version,
    operation: "update",
    changedFields: ["status", "message", "updatedAt", "readAt", "version"],
    scopeKeys: ["notification:list", `notification:${notification!.id}`]
  });
}

const DELETE_RELATED_CHANGES: Record<string, { entityType: string; fields: string[]; scopes(row: ObjectRow): string[] }> = Object.freeze({
  aiTasks: {
    entityType: "aiTask",
    fields: [
      "status", "completedAt", "updatedAt", "error", "errorCode",
      "cancellationRequestedAt", "version"
    ],
    scopes: (row: ObjectRow) => ["task:list", `task:${row.id}`]
  },
  notifications: {
    entityType: "notification",
    fields: ["status", "message", "updatedAt", "readAt", "version"],
    scopes: (row: ObjectRow) => ["notification:list", `notification:${row.id}`]
  }
});

function addThoughtDeleteRelatedChanges(ports: RecordTransaction, beforeRows: ObjectRow[], afterRows: ObjectRow[]) {
  const before = new Map(beforeRows.map(row => [row.objectKey, row]));
  for (const row of afterRows) {
    const definition = DELETE_RELATED_CHANGES[row.collection];
    const previous = before.get(row.objectKey);
    if (!definition || !previous || row.version === previous.version) continue;
    const changedFields = definition.fields.filter(field => (
      field === "version"
      || !Object.is(previous.payload?.[field], row.payload?.[field])
    ));
    ports.addChange({
      entityType: definition.entityType,
      entityId: row.id,
      version: row!.version,
      operation: "update",
      changedFields,
      scopeKeys: definition.scopes(row)
    });
  }
}

async function persistTaskSettlement(ports: RecordTransaction, closure: TaskClosure, services: SettlementServices, result: unknown, requestedStatus: string, error: ThoughtFailure) {
  const task = closure.store.aiTasks.find(item => item.id === closure.taskRow.id);
  if (!task || !["running", "cancelling"].includes(String(task.status))) return null;
  let status = task.status === "cancelling" ? "cancelled" : requestedStatus;
  let thoughtChange: { operation: "create" | "update"; entityId: string; parentId: string | null } | null = null;
  if (status === "succeeded") {
    const work = closure.thoughtClosure
      ? services.thoughtTarget.inspect(closure.store.thoughts, task)
      : null;
    if (!work || !services.taskInputMatches(task, work)) {
      status = "stale";
    } else if (task.kind === "thoughtAnswer") {
      const resultId = services.thoughtTarget.saveAnswer(
        closure.store.thoughts,
        work,
        task,
        result
      );
      task.resultId = resultId;
      thoughtChange = { operation: "create", entityId: resultId, parentId: String(task.targetId) };
    } else {
      const resultId = services.thoughtTarget.saveFollowUp(work, task, result);
      task.resultId = resultId;
      thoughtChange = { operation: "update", entityId: String(task.targetId), parentId: null };
    }
  }
  completeTaskInStore(closure.store, task, status, services, error);
  const notification = closure.store.notifications.find(item => item.taskId === task.id) || null;
  const rows = await services.repository.persistMappedClosure(
    ports,
    ports.accountId,
    closure.rows,
    closure.store,
    { refreshIndexesForCollections: ["aiTasks", "notifications"] }
  );
  await ensureThoughtLifecycles(
    ports.lifecycles,
    rows.filter(row => row.collection === "thoughts")
  );
  if (thoughtChange) {
    const row = rows.find(item => (
      thoughtChange.operation === "create"
        ? item.collection === "thoughts" && item.id === thoughtChange.entityId
        : item.collection === "thoughts" && item.id === task.targetId
    ));
    ports.addChange({
      entityType: thoughtChange.operation === "create" ? "thoughtBlock" : "thoughtChain",
      entityId: thoughtChange.entityId,
      parentType: thoughtChange.parentId ? "thoughtChain" : null,
      parentId: thoughtChange.parentId,
      version: row!.version,
      operation: thoughtChange.operation,
      changedFields: ["content", "answer", "reasoningContent", "version"],
      scopeKeys: ["thought:list", `thought:${task.targetId}`]
    });
  }
  addTaskAndNotificationChanges(ports, rows, task, notification);
  return { task, status };
}



function resourceIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) resourceIds(item, ids);
  } else if (value && typeof value === "object") {
    if ("id" in value && typeof value.id === "string" && value.id) ids.add(value.id);
    for (const child of Object.values(value)) resourceIds(child, ids);
  }
  return ids;
}

async function markRemovedThoughtLifecycles(ports: RecordTransaction, beforeRows: ObjectRow[], afterRows: ObjectRow[], entries: RecordEntity[]) {
  const afterKeys = new Set(afterRows.map(row => row.objectKey));
  const removed = beforeRows.filter(row => (
    row.collection === "thoughts" && !afterKeys.has(row.objectKey)
  ));
  for (const entry of entries) {
    const ids = resourceIds([entry.payload, entry.dependents]);
    const rows = removed.filter(row => ids.has(row.id));
    if (rows.length) await markThoughtLifecycleDeleted(ports.lifecycles, rows, entry as TrashEntry);
  }
}

function attachAfterCommitCallbacks(result: ThoughtResult, entries: RecordEntity[]) {
  const callbacks = entries.map(entry => entry?.[AFTER_COMMIT]).filter((callback): callback is () => void => typeof callback === "function");
  if (!callbacks.length || !result) return;
  const previous = result[AFTER_COMMIT];
  Object.defineProperty(result, AFTER_COMMIT, {
    value: () => {
      previous?.();
      callbacks.forEach(callback => callback());
    },
    configurable: true
  });
}

function updateCommand({ unitOfWork, repository, thoughts, removeBlock }: ThoughtServices) {
  const update = async (input: ThoughtInput) => {
    const committed = await unitOfWork.run({
      commandId: "thought.update"
    }, async ports => {
      const closure = await repository.readThoughtDeleteClosure(ports, input.id);
      if (!closure) return { missing: true };
      const result = thoughts.updateChainInStore(closure.store, {
        ...input,
        removeBlock
      });
      if (!result?.value) return result;
      const rows = await repository.persistMappedClosure(
        ports,
        ports.accountId,
        closure.rows,
        closure.store,
        { refreshIndexesForCollections: ["aiTasks", "notifications"] }
      );
      await ensureThoughtLifecycles(
        ports.lifecycles,
        rows.filter(row => row.collection === "thoughts")
      );
      await markRemovedThoughtLifecycles(
        ports,
        closure.rows,
        rows,
        closure.store.trash
      );
      addThoughtDeleteRelatedChanges(ports, closure.rows, rows);
      attachAfterCommitCallbacks(result, closure.store.trash);
      ports.addChange({
        entityType: "thoughtChain",
        entityId: input.id,
        version: Number(result.value.version) || 1,
        operation: "update",
        changedFields: ["content", "tags", "occurredAt", "occurredOn", "blocks", "version"],
        scopeKeys: ["thought:list", `thought:${input.id}`]
      });
      return result;
    });
    committed.value?.[AFTER_COMMIT]?.();
    return committed.value;
  };
  return update;
}

function createCommand({ unitOfWork, repository, thoughts, createTaskInStore, now = () => new Date().toISOString() }: ThoughtServices) {
  const create = async (input: ThoughtCreateInput) => {
    const committed = await unitOfWork.run({
      commandId: "thought.create",
      idempotency: idempotencyForCreate(input, now())
    }, async ports => {
      const closure = await repository.createThoughtStoreClosure(ports, input);
      closure.store.aiTasks = [];
      closure.store.notifications = [];
      const result = thoughts.createChainInStore(closure.store, input);
      if (!result?.items || result.duplicate) return result;
      const root = result.items.find(item => item.type === "question");
      if (!root) throw new Error("Created thought has no root");
      const taskResult = input.generateAnswer
        ? createTaskInStore(closure.store, {
            kind: "thoughtAnswer",
            targetId: root.id,
            inputVersion: root.version,
            payload: { triggerType: "user_action_auto" },
            clientRequestId: `${input.clientRequestId || root.id}:answer`
          }, { deferInputBinding: true })
        : null;
      if (input.generateAnswer && !taskResult?.task) {
        throw Object.assign(new Error("自动回答任务无法创建"), {
          statusCode: 409,
          code: "AI_TASK_CREATE_FAILED"
        });
      }
      const rows = await repository.persistMappedClosure(
        ports,
        ports.accountId,
        closure.beforeRows,
        closure.store,
        { managedCollections: ["thoughts", "aiTasks", "notifications"] }
      );
      await ensureThoughtLifecycles(
        ports.lifecycles,
        rows.filter(row => row.collection === "thoughts")
      );
      ports.addChange({
        entityType: "thoughtChain",
        entityId: root.id,
        version: Number(root.version) || 1,
        operation: "create",
        changedFields: ["content", "tags", "occurredAt", "occurredOn", "blocks", "version"],
        scopeKeys: ["thought:list", `thought:${root.id}`]
      });
      const createdTask = taskResult?.task;
      if (createdTask) {
        const taskRow = rows.find(row => (
          row.collection === "aiTasks" && row.id === createdTask.id
        ));
        const notification = closure.store.notifications.find(item => (
          item.taskId === createdTask.id
        ));
        const notificationRow = rows.find(row => (
          row.collection === "notifications" && row.id === notification!.id
        ));
        ports.addChange({
          entityType: "aiTask",
          entityId: createdTask.id,
          version: taskRow!.version,
          operation: "create",
          changedFields: ["status", "targetId", "inputVersion", "version"],
          scopeKeys: ["task:list", `task:${createdTask.id}`]
        });
        ports.addChange({
          entityType: "notification",
          entityId: notification!.id,
          version: notificationRow!.version,
          operation: "create",
          changedFields: ["status", "message", "readAt", "version"],
          scopeKeys: ["notification:list", `notification:${notification!.id}`]
        });
      }
      return { ...result, task: taskResult?.task || null };
    });
    return committed.replayed
      ? { ...committed.value, duplicate: true }
      : committed.value;
  };
  return create;
}

function removeCommand({ unitOfWork, repository, removeChain }: ThoughtServices) {
  const remove = async (id: string, expectedVersion: number | null = null) => {
    const committed = await unitOfWork.run({
      commandId: "thought.delete"
    }, async ports => {
      const closure = await repository.readThoughtDeleteClosure(ports, id);
      if (!closure) return null;
      const root = closure.store.thoughts.find(item => item.id === id && item.type === "question");
      const currentVersion = Number(root?.version) || 1;
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
      const entry = removeChain(closure.store, id);
      if (!entry) return null;
      const rows = await repository.persistMappedClosure(
        ports,
        ports.accountId,
        closure.rows,
        closure.store
      );
      await markThoughtLifecycleDeleted(
        ports.lifecycles,
        closure.rows.filter(row => row.collection === "thoughts"),
        entry
      );
      ports.addChange({
        entityType: "thoughtChain",
        entityId: id,
        version: currentVersion + 1,
        operation: "delete",
        changedFields: [],
        scopeKeys: ["thought:list", `thought:${id}`],
        summary: { trashId: entry.id }
      });
      addThoughtDeleteRelatedChanges(ports, closure.rows, rows);
      return entry;
    });
    if (committed.value && "id" in committed.value) committed.value[AFTER_COMMIT]?.();
    return committed.value;
  };
  return remove;
}

function writebackCommand({ unitOfWork, repository, tasks, notifications, thoughtTarget, taskInputMatches }: ThoughtServices) {
  const writeback = async ({ taskId, result, expectedRevision }: ThoughtWriteback) => {
    const committed = await unitOfWork.run({
      commandId: "thought.aiWriteback",
      expectedRevision
    }, async ports => {
      const closure = await readTaskClosure(ports, taskId, repository);
      if (!closure) return null;
      return persistTaskSettlement(
        ports,
        closure,
        { tasks, notifications, thoughtTarget, taskInputMatches, repository },
        result,
        "succeeded",
        null
      );
    });
    return committed.value;
  };
  return writeback;
}

function failWritebackCommand({ unitOfWork, repository, tasks, notifications, thoughtTarget, taskInputMatches }: ThoughtServices) {
  const failWriteback = async (taskId: string, error: ThoughtFailure) => {
    const committed = await unitOfWork.run({
      commandId: "thought.aiWriteback.failure"
    }, async ports => {
      const closure = await readTaskClosure(ports, taskId, repository);
      if (!closure) return null;
      const status = error?.code === "AI_TASK_STALE"
        ? "stale"
        : error?.code === "AI_TASK_CANCELLED" ? "cancelled" : "failed";
      return persistTaskSettlement(
        ports,
        closure,
        { tasks, notifications, thoughtTarget, taskInputMatches, repository },
        null,
        status,
        error
      );
    });
    return committed.value;
  };
  return failWriteback;
}

/**
 * 创建思绪记录级命令；编辑复用领域服务，只持久化目标思绪链对象图。
 * @since unreleased
 */
export function createThoughtRecordCommands(services: ThoughtServices) {
  const {
    unitOfWork, thoughts, removeChain, removeBlock,
    createTaskInStore, tasks, notifications, thoughtTarget
  } = services;
  if (!unitOfWork?.run
    || !thoughts?.createChainInStore
    || !thoughts?.updateChainInStore
    || typeof removeChain !== "function"
    || typeof removeBlock !== "function"
    || typeof createTaskInStore !== "function"
    || !tasks?.complete
    || !notifications?.upsertTask
    || !thoughtTarget?.inspect
    || !thoughtTarget?.saveAnswer
    || !thoughtTarget?.saveFollowUp) {
    throw new TypeError("Thought record command dependencies are required");
  }
  return Object.freeze({
    update: updateCommand(services),
    create: createCommand(services),
    remove: removeCommand(services),
    writeback: writebackCommand(services),
    failWriteback: failWritebackCommand(services)
  });
}
