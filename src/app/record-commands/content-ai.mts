/**
 * 图片理解与批注 AI 回复的目标闭包和终态提交。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只读取任务、通知与目标所属记录；个人上下文由调用方修订号绑定。
 */
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, RecordTransaction, SourceMutationEffects
} from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { createTaskRecordRepository } from "../../shared/persistence/task-record-repository.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { TaskCommandServices, TaskWork } from "../../modules/tasks/record-contracts.mjs";
import { commitThoughtCommand, afterThoughtCommandCommit } from "../../modules/thoughts/command-commit.mjs";

type Failure = { code?: string; message?: string } | null;
type Input = {
  taskId: string; result: unknown; expectedRevision?: string; contextFingerprint?: string;
};
type Services = TaskCommandServices & {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  effects?: SourceMutationEffects | null;
  owner(task: RecordEntity): { collection: string; id: string } | null;
  inspect(store: RecordStore, task: RecordEntity): TaskWork | null;
  save(store: RecordStore, work: TaskWork, task: RecordEntity, result: unknown): string;
  taskInputMatches(task: RecordEntity, work: TaskWork | null): boolean;
};

async function readClosure(ports: RecordTransaction, taskId: string, services: Services) {
  const tasks = createTaskRecordRepository(ports);
  const taskRow = await tasks.find(taskId);
  if (!taskRow) return null;
  const task = taskRow.payload;
  const owner = services.owner(task);
  if (!owner) throw new TypeError("Unsupported content AI task target");
  const notification = await tasks.notification(taskRow);
  if (!task.internal && !notification) throw Object.assign(
    new Error("任务通知缺失，原数据已保留"), { code: "ACCOUNT_DATA_INVALID", statusCode: 503 }
  );
  const thought = owner.collection === "thoughts"
    ? await services.repository.readThoughtTargetClosure(ports, owner.id) : null;
  const targetRows = owner.collection === "thoughts" ? thought?.rows || []
    : await ports.objects.findTree([recordObjectKey(owner.collection, owner.id)], { lock: true });
  const rows = [taskRow, ...(notification ? [notification] : []), ...targetRows];
  return {
    rows,
    store: services.repository.rebuildRecordCollections(rows, [owner.collection, "aiTasks", "notifications"]),
    rootId: thought ? String(JSON.parse(thought.rootKey)[1]) : ""
  };
}

function settle(
  store: RecordStore, services: Services, input: Input, requestedStatus: string, error: Failure
) {
  const task = store.aiTasks.find(item => item.id === input.taskId);
  if (!task || !["running", "cancelling"].includes(String(task.status))) return null;
  let status = task.status === "cancelling" ? "cancelled" : requestedStatus;
  if (status === "succeeded") {
    const work = services.inspect(store, task);
    if (!work || !services.taskInputMatches(task, work)) status = "stale";
    else {
      task.resultId = services.save(store, work, task, input.result);
      if (input.contextFingerprint) task.contextFingerprint = input.contextFingerprint;
    }
  }
  services.tasks.complete(task, status, status === "succeeded" ? { resultId: task.resultId } : {
    error: status === "cancelled" ? "目标已删除或任务已取消，结果未写入"
      : status === "stale" ? "目标已修改或删除，结果未写入" : error?.message || "生成失败",
    errorCode: status === "cancelled" ? "AI_TASK_CANCELLED"
      : status === "stale" ? "AI_TASK_STALE" : error?.code || "AI_TASK_FAILED"
  });
  if (!task.internal) services.notifications.upsertTask(
    store.notifications, task, status, status === "succeeded" ? undefined : task.error
  );
  return { task, status };
}

/** 上下文校验和写回由同一账户修订号连接；失败也走相同提交管道。 @since unreleased */
export function createContentAiRecordCommands(services: Services) {
  const execute = async (input: Input, error: Failure, failed: boolean) => {
    if (!failed && input.expectedRevision == null) {
      throw new TypeError("Content AI writeback requires a verified account revision");
    }
    let observation: Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
    const committed = await services.unitOfWork.run({
      commandId: `content.aiWriteback${failed ? ".failure" : ""}`,
      expectedRevision: input.expectedRevision
    }, async ports => {
      const closure = await readClosure(ports, input.taskId, services);
      if (!closure) return null;
      const prepared = await services.effects?.prepare(ports, closure);
      const status = !failed ? "succeeded" : error?.code === "AI_TASK_STALE" ? "stale"
        : error?.code === "AI_TASK_CANCELLED" ? "cancelled" : "failed";
      const result = settle(closure.store, services, input, status, error);
      if (!result) return null;
      await commitThoughtCommand(ports, services.repository, closure, closure.rootId, {
        observation: prepared, includeCaptures: true
      });
      observation = prepared;
      return result;
    });
    afterThoughtCommandCommit(observation);
    return committed.value;
  };
  return Object.freeze({
    writeback: (input: Input) => execute(input, null, false),
    failWriteback: (taskId: string, error: Failure) => execute({ taskId, result: null }, error, true)
  });
}
