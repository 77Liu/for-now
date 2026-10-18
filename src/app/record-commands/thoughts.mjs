import { taskInputMatches } from "../../modules/tasks/index.mjs";
import {
  createThoughtStoreClosure,
  ensureThoughtLifecycles,
  markThoughtLifecycleDeleted,
  persistMappedClosure,
  readThoughtClosure,
  readThoughtDeleteClosure,
  rebuildRecordCollections,
  recordObjectKey
} from "./thought-graph.mjs";
import { readTaskNotification } from "./task-notification.mjs";

const keyOf = recordObjectKey;
const unsupported = message => Object.assign(
  new Error(message),
  { statusCode: 409, code: "RECORD_COMMAND_UNSUPPORTED" }
);

function idempotencyForCreate(input, timestamp) {
  if (!input.clientRequestId) {
    throw unsupported("记录级思绪创建需要幂等标识");
  }
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) throw new TypeError("Thought record command now() is invalid");
  return {
    scope: "thoughtChains.create",
    key: input.clientRequestId,
    requestHash: input.requestHash,
    expiresAt: new Date(createdAt.getTime() + 90 * 86400000).toISOString()
  };
}

async function readTaskClosure(ports, taskId) {
  const taskRow = await ports.objects.find(keyOf("aiTasks", taskId), { lock: true });
  if (!taskRow) return null;
  const thoughtClosure = await readThoughtClosure(
    ports.objects,
    ports.relations,
    taskRow.payload?.targetId
  );
  const notificationRow = await readTaskNotification(ports, taskRow);
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
  const store = rebuildRecordCollections(rows, ["thoughts", "aiTasks", "notifications"]);
  return { rows, store, taskRow, notificationRow, thoughtClosure };
}

function completeTaskInStore(store, task, status, services, error = null) {
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

function addTaskAndNotificationChanges(ports, rows, task, notification) {
  const taskRow = rows.find(row => row.collection === "aiTasks" && row.id === task.id);
  ports.addChange({
    entityType: "aiTask",
    entityId: task.id,
    version: taskRow.version,
    operation: "update",
    changedFields: ["status", "resultId", "completedAt", "updatedAt", "error", "errorCode", "version"],
    scopeKeys: ["task:list", `task:${task.id}`]
  });
  if (!notification) return;
  const row = rows.find(item => (
    item.collection === "notifications" && item.id === notification.id
  ));
  ports.addChange({
    entityType: "notification",
    entityId: notification.id,
    version: row.version,
    operation: "update",
    changedFields: ["status", "message", "updatedAt", "readAt", "version"],
    scopeKeys: ["notification:list", `notification:${notification.id}`]
  });
}

const DELETE_RELATED_CHANGES = Object.freeze({
  aiTasks: {
    entityType: "aiTask",
    fields: [
      "status", "completedAt", "updatedAt", "error", "errorCode",
      "cancellationRequestedAt", "version"
    ],
    scopes: row => ["task:list", `task:${row.id}`]
  },
  notifications: {
    entityType: "notification",
    fields: ["status", "message", "updatedAt", "readAt", "version"],
    scopes: row => ["notification:list", `notification:${row.id}`]
  }
});

function addThoughtDeleteRelatedChanges(ports, beforeRows, afterRows) {
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
      version: row.version,
      operation: "update",
      changedFields,
      scopeKeys: definition.scopes(row)
    });
  }
}

async function persistTaskSettlement(ports, closure, services, result, requestedStatus, error) {
  const task = closure.store.aiTasks.find(item => item.id === closure.taskRow.id);
  if (!task || !["running", "cancelling"].includes(task.status)) return null;
  let status = task.status === "cancelling" ? "cancelled" : requestedStatus;
  let thoughtChange = null;
  if (status === "succeeded") {
    const work = closure.thoughtClosure
      ? services.thoughtTarget.inspect(closure.store.thoughts, task)
      : null;
    if (!taskInputMatches(task, work)) {
      status = "stale";
    } else if (task.kind === "thoughtAnswer") {
      const resultId = services.thoughtTarget.saveAnswer(
        closure.store.thoughts,
        work,
        task,
        result
      );
      task.resultId = resultId;
      thoughtChange = { operation: "create", entityId: resultId, parentId: task.targetId };
    } else {
      const resultId = services.thoughtTarget.saveFollowUp(work, task, result);
      task.resultId = resultId;
      thoughtChange = { operation: "update", entityId: task.targetId, parentId: null };
    }
  }
  completeTaskInStore(closure.store, task, status, services, error);
  const notification = closure.store.notifications.find(item => item.taskId === task.id) || null;
  const rows = await persistMappedClosure(
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
      version: row.version,
      operation: thoughtChange.operation,
      changedFields: ["content", "answer", "reasoningContent", "version"],
      scopeKeys: ["thought:list", `thought:${task.targetId}`]
    });
  }
  addTaskAndNotificationChanges(ports, rows, task, notification);
  return { task, status };
}

const AFTER_COMMIT = Symbol.for("for-now.after-commit");

function resourceIds(value, ids = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) resourceIds(item, ids);
  } else if (value && typeof value === "object") {
    if (typeof value.id === "string" && value.id) ids.add(value.id);
    for (const child of Object.values(value)) resourceIds(child, ids);
  }
  return ids;
}

async function markRemovedThoughtLifecycles(ports, beforeRows, afterRows, entries) {
  const afterKeys = new Set(afterRows.map(row => row.objectKey));
  const removed = beforeRows.filter(row => (
    row.collection === "thoughts" && !afterKeys.has(row.objectKey)
  ));
  for (const entry of entries) {
    const ids = resourceIds([entry.payload, entry.dependents]);
    const rows = removed.filter(row => ids.has(row.id));
    if (rows.length) await markThoughtLifecycleDeleted(ports.lifecycles, rows, entry);
  }
}

function attachAfterCommitCallbacks(result, entries) {
  const callbacks = entries.map(entry => entry?.[AFTER_COMMIT]).filter(Boolean);
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

/**
 * 创建思绪记录级命令；编辑复用领域服务，只持久化目标思绪链对象图。
 * @since unreleased
 */
export function createThoughtRecordCommands({
  unitOfWork,
  thoughts,
  removeChain,
  removeBlock,
  createTaskInStore,
  tasks,
  notifications,
  thoughtTarget,
  now = () => new Date().toISOString()
}) {
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
  const update = async input => {
    const committed = await unitOfWork.run({
      commandId: "thought.update"
    }, async ports => {
      const closure = await readThoughtDeleteClosure(ports, input.id);
      if (!closure) return { missing: true };
      const result = thoughts.updateChainInStore(closure.store, {
        ...input,
        removeBlock
      });
      if (!result?.value) return result;
      const rows = await persistMappedClosure(
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
      attachAfterCommitCallbacks(result, closure.store.trash);
      ports.addChange({
        entityType: "thoughtChain",
        entityId: input.id,
        version: result.value.version,
        operation: "update",
        changedFields: ["content", "tags", "occurredAt", "occurredOn", "blocks", "version"],
        scopeKeys: ["thought:list", `thought:${input.id}`]
      });
      return result;
    });
    committed.value?.[AFTER_COMMIT]?.();
    return committed.value;
  };
  const create = async input => {
    const committed = await unitOfWork.run({
      commandId: "thought.create",
      idempotency: idempotencyForCreate(input, now())
    }, async ports => {
      const closure = await createThoughtStoreClosure(ports, input);
      closure.store.aiTasks = [];
      closure.store.notifications = [];
      const result = thoughts.createChainInStore(closure.store, input);
      if (!result?.items || result.duplicate) return result;
      const root = result.items.find(item => item.type === "question");
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
      const rows = await persistMappedClosure(
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
        version: root.version,
        operation: "create",
        changedFields: ["content", "tags", "occurredAt", "occurredOn", "blocks", "version"],
        scopeKeys: ["thought:list", `thought:${root.id}`]
      });
      if (taskResult?.task) {
        const taskRow = rows.find(row => (
          row.collection === "aiTasks" && row.id === taskResult.task.id
        ));
        const notification = closure.store.notifications.find(item => (
          item.taskId === taskResult.task.id
        ));
        const notificationRow = rows.find(row => (
          row.collection === "notifications" && row.id === notification.id
        ));
        ports.addChange({
          entityType: "aiTask",
          entityId: taskResult.task.id,
          version: taskRow.version,
          operation: "create",
          changedFields: ["status", "targetId", "inputVersion", "version"],
          scopeKeys: ["task:list", `task:${taskResult.task.id}`]
        });
        ports.addChange({
          entityType: "notification",
          entityId: notification.id,
          version: notificationRow.version,
          operation: "create",
          changedFields: ["status", "message", "readAt", "version"],
          scopeKeys: ["notification:list", `notification:${notification.id}`]
        });
      }
      return { ...result, task: taskResult?.task || null };
    });
    return committed.replayed
      ? { ...committed.value, duplicate: true }
      : committed.value;
  };
  const remove = async (id, expectedVersion = null) => {
    const committed = await unitOfWork.run({
      commandId: "thought.delete"
    }, async ports => {
      const closure = await readThoughtDeleteClosure(ports, id);
      if (!closure) return null;
      const root = closure.store.thoughts.find(item => item.id === id && item.type === "question");
      const currentVersion = Number(root?.version) || 1;
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
      const entry = removeChain(closure.store, id);
      if (!entry) return null;
      const rows = await persistMappedClosure(
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
    committed.value?.[Symbol.for("for-now.after-commit")]?.();
    return committed.value;
  };
  const writeback = async ({ taskId, result, expectedRevision }) => {
    const committed = await unitOfWork.run({
      commandId: "thought.aiWriteback",
      expectedRevision
    }, async ports => {
      const closure = await readTaskClosure(ports, taskId);
      if (!closure) return null;
      return persistTaskSettlement(
        ports,
        closure,
        { tasks, notifications, thoughtTarget },
        result,
        "succeeded",
        null
      );
    });
    return committed.value;
  };
  const failWriteback = async (taskId, error) => {
    const committed = await unitOfWork.run({
      commandId: "thought.aiWriteback.failure"
    }, async ports => {
      const closure = await readTaskClosure(ports, taskId);
      if (!closure) return null;
      const status = error?.code === "AI_TASK_STALE"
        ? "stale"
        : error?.code === "AI_TASK_CANCELLED" ? "cancelled" : "failed";
      return persistTaskSettlement(
        ports,
        closure,
        { tasks, notifications, thoughtTarget },
        null,
        status,
        error
      );
    });
    return committed.value;
  };
  return Object.freeze({ create, update, remove, writeback, failWriteback });
}
