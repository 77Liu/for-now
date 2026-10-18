/**
 * 思绪根命令、任务结果接纳与删除传播的领域规则。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的目标记录闭包；不执行供应商调用或全账户读写。
 */
import type {
  RecordEntity, RecordStore, RecordTransaction, SourceMutationEffects
} from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type {
  ThoughtCreateInput, ThoughtInput, ThoughtServices, ThoughtWriteback, ThoughtFailure
} from "./record-contracts.mjs";
import { commitThoughtCommand, afterThoughtCommandCommit } from "./command-commit.mjs";

type Observation = Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
type TaskClosure = NonNullable<Awaited<ReturnType<typeof readTaskClosure>>>;

function idempotencyForCreate(input: ThoughtCreateInput, timestamp: string) {
  if (!input.clientRequestId) {
    throw Object.assign(new Error("记录级思绪创建需要幂等标识"), {
      statusCode: 409,
      code: "RECORD_COMMAND_UNSUPPORTED"
    });
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
  const tasks = createTaskRecordRepository(ports);
  const taskRow = await tasks.find(taskId);
  if (!taskRow) return null;
  const thoughtClosure = await repository.readThoughtClosure(
    ports.objects, ports.relations, String(taskRow.payload?.targetId || "")
  );
  const notificationRow = await tasks.notification(taskRow);
  if (taskRow.payload?.internal !== true && !notificationRow) {
    throw Object.assign(new Error("任务通知缺失，原数据已保留"), {
      statusCode: 503, code: "ACCOUNT_DATA_INVALID"
    });
  }
  const rows = [...new Map([
    taskRow,
    ...(notificationRow ? [notificationRow] : []),
    ...(thoughtClosure?.rows || [])
  ].map(row => [row.objectKey, row])).values()];
  const store = repository.rebuildRecordCollections(rows, ["thoughts", "aiTasks", "notifications"]);
  return { rows, store, taskRow, thoughtClosure };
}

function completeTaskInStore(
  store: RecordStore, task: RecordEntity, status: string,
  services: ThoughtServices, error: ThoughtFailure
) {
  const terminal = status === "succeeded"
    ? { resultId: task.resultId || "" }
    : {
        error: status === "cancelled" ? "用户取消了本次生成"
          : status === "stale" ? "目标已修改或删除" : error?.message || "生成失败",
        errorCode: status === "cancelled" ? "AI_TASK_CANCELLED"
          : status === "stale" ? "AI_TASK_STALE" : error?.code || "AI_TASK_FAILED"
      };
  services.tasks.complete(task, status, terminal);
  if (task.internal !== true) {
    services.notifications.upsertTask(
      store.notifications, task, status,
      status === "succeeded" ? undefined : task.error
    );
  }
}

function settleTask(
  closure: TaskClosure, services: ThoughtServices,
  result: unknown, requestedStatus: string, error: ThoughtFailure
) {
  const task = closure.store.aiTasks.find(item => item.id === closure.taskRow.id);
  if (!task || !["running", "cancelling"].includes(String(task.status))) return null;
  let status = task.status === "cancelling" ? "cancelled" : requestedStatus;
  if (status === "succeeded") {
    const work = closure.thoughtClosure
      ? services.thoughtTarget.inspect(closure.store.thoughts, task) : null;
    if (!work || !services.taskInputMatches(task, work)) {
      status = "stale";
    } else {
      task.resultId = task.kind === "thoughtAnswer"
        ? services.thoughtTarget.saveAnswer(closure.store.thoughts, work, task, result)
        : services.thoughtTarget.saveFollowUp(work, task, result);
    }
  }
  completeTaskInStore(closure.store, task, status, services, error);
  return { task, status };
}

function updateCommand(services: ThoughtServices) {
  const { unitOfWork, repository, thoughts, removeBlock, effects } = services;
  return async (input: ThoughtInput) => {
    let observation: Observation;
    let entries: RecordEntity[] = [];
    let resultAfterCommit: (() => void) | undefined;
    const committed = await unitOfWork.run({ commandId: "thought.update" }, async ports => {
      const closure = await repository.readThoughtDeleteClosure(ports, input.id);
      if (!closure) return { missing: true };
      const state = { rows: closure.rows, store: closure.store };
      const prepared = await effects?.prepare(ports, state);
      const result = thoughts.updateChainInStore(state.store, { ...input, removeBlock });
      if (!result?.value) return result;
      entries = state.store.trash || [];
      const rows = await commitThoughtCommand(ports, repository, state, input.id, {
        observation: prepared, trashEntries: entries
      });
      const root = rows.find(row => row.collection === "thoughts" && row.id === input.id);
      if (root) result.value.version = root.version;
      observation = prepared;
      resultAfterCommit = result[AFTER_COMMIT];
      return result;
    });
    afterThoughtCommandCommit(observation, entries);
    resultAfterCommit?.();
    return committed.value;
  };
}

function createCommand(services: ThoughtServices) {
  const { unitOfWork, repository, thoughts, createTaskInStore, effects, now = () => new Date().toISOString() } = services;
  return async (input: ThoughtCreateInput) => {
    let observation: Observation;
    const committed = await unitOfWork.run({
      commandId: "thought.create",
      idempotency: idempotencyForCreate(input, now())
    }, async ports => {
      const closure = await repository.createThoughtStoreClosure(ports, input);
      const state = { rows: closure.beforeRows, store: closure.store };
      state.store.aiTasks = [];
      state.store.notifications = [];
      const prepared = await effects?.prepare(ports, state);
      const result = thoughts.createChainInStore(state.store, input);
      if (!result?.items || result.duplicate) return result;
      const root = result.items.find(item => item.type === "question");
      if (!root) throw new Error("Created thought has no root");
      const taskResult = input.generateAnswer ? createTaskInStore(state.store, {
        kind: "thoughtAnswer",
        targetId: root.id,
        inputVersion: root.version,
        payload: { triggerType: "user_action_auto" },
        clientRequestId: `${input.clientRequestId}:answer`
      }, { deferInputBinding: true }) : null;
      if (input.generateAnswer && !taskResult?.task) {
        throw Object.assign(new Error("自动回答任务无法创建"), {
          statusCode: 409, code: "AI_TASK_CREATE_FAILED"
        });
      }
      await commitThoughtCommand(ports, repository, state, root.id, { observation: prepared });
      observation = prepared;
      return { ...result, task: taskResult?.task || null };
    });
    afterThoughtCommandCommit(observation);
    return committed.replayed ? { ...committed.value, duplicate: true } : committed.value;
  };
}

function removeCommand(services: ThoughtServices) {
  const { unitOfWork, repository, removeChain, effects } = services;
  return async (id: string, expectedVersion: number | null = null) => {
    let observation: Observation;
    let entries: RecordEntity[] = [];
    const committed = await unitOfWork.run({ commandId: "thought.delete" }, async ports => {
      const closure = await repository.readThoughtDeleteClosure(ports, id);
      if (!closure) return null;
      const root = closure.store.thoughts.find(item => item.id === id && item.type === "question");
      const currentVersion = Number(root?.version) || 1;
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
      const state = { rows: closure.rows, store: closure.store };
      const prepared = await effects?.prepare(ports, state);
      const entry = removeChain(state.store, id);
      if (!entry) return null;
      entries = [entry];
      await commitThoughtCommand(ports, repository, state, id, {
        observation: prepared, trashEntries: entries
      });
      observation = prepared;
      return entry;
    });
    afterThoughtCommandCommit(observation, entries);
    return committed.value;
  };
}

function settlementCommand(services: ThoughtServices, failed: boolean) {
  const { unitOfWork, repository, effects } = services;
  return async (input: ThoughtWriteback, error: ThoughtFailure = null) => {
    let observation: Observation;
    const committed = await unitOfWork.run({
      commandId: failed ? "thought.aiWriteback.failure" : "thought.aiWriteback",
      expectedRevision: input.expectedRevision
    }, async ports => {
      const closure = await readTaskClosure(ports, input.taskId, repository);
      if (!closure) return null;
      const prepared = await effects?.prepare(ports, closure);
      const status = !failed ? "succeeded"
        : error?.code === "AI_TASK_STALE" ? "stale"
          : error?.code === "AI_TASK_CANCELLED" ? "cancelled" : "failed";
      const result = settleTask(closure, services, input.result, status, error);
      if (!result) return null;
      await commitThoughtCommand(ports, repository, closure, String(result.task.targetId || ""), {
        observation: prepared
      });
      observation = prepared;
      return result;
    });
    afterThoughtCommandCommit(observation);
    return committed.value;
  };
}

/** 创建根记录与 AI 写回的公开命令，复用业务规则和提交管道。 @since unreleased */
export function createThoughtRecordCommands(services: ThoughtServices) {
  const {
    unitOfWork, thoughts, removeChain, removeBlock,
    createTaskInStore, tasks, notifications, thoughtTarget
  } = services;
  if (!unitOfWork?.run || !thoughts?.createChainInStore || !thoughts?.updateChainInStore
    || typeof removeChain !== "function" || typeof removeBlock !== "function"
    || typeof createTaskInStore !== "function" || !tasks?.complete
    || !notifications?.upsertTask || !thoughtTarget?.inspect
    || !thoughtTarget?.saveAnswer || !thoughtTarget?.saveFollowUp) {
    throw new TypeError("Thought record command dependencies are required");
  }
  const fail = settlementCommand(services, true);
  return Object.freeze({
    update: updateCommand(services),
    create: createCommand(services),
    remove: removeCommand(services),
    writeback: settlementCommand(services, false),
    failWriteback: (taskId: string, error: ThoughtFailure) => fail({ taskId, result: null }, error)
  });
}
