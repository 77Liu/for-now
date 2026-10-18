/**
 * 必要后台任务状态的 PostgreSQL 成功、修订竞态与末尾回滚验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成账户；上下文读取显式在事务外，修改只含目标任务与通知。
 */
import assert from "node:assert/strict";
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, StoreMapping
} from "../src/shared/persistence/record-command-types.mjs";
import type { SqlClient } from "../src/modules/thoughts/query-contracts.mjs";
import { createTaskTransitionCommands } from "../src/app/record-commands/task-transitions.mjs";

type Context = {
  database: SqlClient;
  repo: {
    read(): Promise<RecordStore>;
    update(operation: (store: RecordStore) => void): Promise<unknown>;
    accountUnitOfWork: AccountUnitOfWork;
  };
  mapping: StoreMapping;
  tasks: {
    claim(items: RecordEntity[], id: string): RecordEntity | null;
    recover(items: RecordEntity[]): unknown;
    waitForUserModel(items: RecordEntity[], id: string): RecordEntity | null;
    promoteWaiting(items: RecordEntity[], id: string, work: Record<string, unknown>, intent: Record<string, unknown>): unknown;
  };
  notify(items: RecordEntity[], task: RecordEntity, status: string): unknown;
};
const accountId = "thought-producer-test";
const timestamp = "2026-10-19T00:00:00.000Z";

async function snapshot(database: SqlClient) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "accounts", "store_objects", "store_relations", "store_attachment_refs", "thought_chain_index",
    "thought_tag_counts", "record_changes", "account_sync_heads"
  ]) {
    state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return state;
}

async function commitFailure(database: SqlClient, commandId: string, operation: () => Promise<unknown>) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_task_transition_failure
    CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(operation(), /injected_task_transition_failure/);
    assert.deepEqual(await snapshot(database), before, commandId);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_task_transition_failure");
  }
}

async function kindMatrix(context: Context, kind: string, measurements: { reads: number; writes: number }[]) {
  const taskId = `transition-${kind}`;
  await context.repo.update(store => {
    const subtargetId = kind === "followUpAnswer" ? "transition-followup"
      : kind === "annotationShenji" ? "transition-annotation" : "";
    store.aiTasks.push({
      id: taskId, kind, status: "queued", targetId: "producer-root", resourceType: "thought",
      subtargetId,
      inputHash: "verified-input", inputVersion: 1, subtargetVersion: 0,
      createdAt: timestamp, updatedAt: timestamp
    });
    store.notifications.push({
      id: `notification-${taskId}`, kind: "aiTask", taskId, status: "queued",
      createdAt: timestamp, updatedAt: timestamp, readAt: ""
    });
  });
  const unitOfWork: AccountUnitOfWork = {
    ...context.repo.accountUnitOfWork,
    run: async (options, operation) => {
      const result = await context.repo.accountUnitOfWork.run(options, operation);
      measurements.push(result);
      return result;
    }
  };
  const commands = createTaskTransitionCommands({ unitOfWork, mapping: context.mapping });
  const invoke = async (action: "claim" | "releaseWaiting" | "recover") => commands.transition({
    taskId, action, expectedRevision: await unitOfWork.readRevision(), snapshot: await context.repo.read(),
    mutate(store) {
      const task = store.aiTasks[0];
      if (action === "claim") context.tasks.claim(store.aiTasks, taskId);
      if (action === "releaseWaiting") context.tasks.promoteWaiting(store.aiTasks, taskId,
        { inputVersion: 1, subtargetVersion: 0, inputHash: "verified-input" },
        { inputVersion: 1, subtargetVersion: 0, inputHash: "verified-input" });
      if (action === "recover") context.tasks.recover(store.aiTasks);
      context.notify(store.notifications, task, String(task.status));
      return task.status;
    }
  });
  await commands.transition({
    taskId, action: "claim", expectedRevision: await unitOfWork.readRevision(), snapshot: await context.repo.read(),
    mutate(store) {
      const task = context.tasks.waitForUserModel(store.aiTasks, taskId)!;
      context.notify(store.notifications, task, String(task.status));
      return task.status;
    }
  });
  await commitFailure(context.database, "task.releaseWaiting", () => invoke("releaseWaiting"));
  assert.equal(await invoke("releaseWaiting"), "queued");
  await commitFailure(context.database, "task.claim", () => invoke("claim"));
  assert.equal(await invoke("claim"), "running");
  await commitFailure(context.database, "task.recover", () => invoke("recover"));
  assert.equal(await invoke("recover"), "failed");
  assert.equal((await context.repo.read()).notifications.find(item => item.taskId === taskId)?.status, "failed");
  const before = await snapshot(context.database);
  await commands.transition({
    taskId, action: "recover", expectedRevision: await unitOfWork.readRevision(), snapshot: await context.repo.read(),
    mutate: () => null
  });
  assert.deepEqual(await snapshot(context.database), before, "no-op does not advance revision, versions or cursor");
  await assert.rejects(commands.transition({
    taskId, action: "claim", expectedRevision: await unitOfWork.readRevision(), snapshot: await context.repo.read(),
    mutate(store) { store.thoughts[0].content = "禁止从状态钩子修改正文"; }
  }), TypeError);
  assert.deepEqual(await snapshot(context.database), before);
  const revision = await unitOfWork.readRevision();
  const old = await context.repo.read();
  await context.repo.update(store => { store.aiTasks.find(task => task.id === taskId)!.error = "另一次更新"; });
  const conflicted = await snapshot(context.database);
  await assert.rejects(commands.transition({
    taskId, action: "claim", expectedRevision: revision, snapshot: old, mutate: () => null
  }), { code: "VERSION_CONFLICT" });
  assert.deepEqual(await snapshot(context.database), conflicted);
}

/** 四种必要任务均验证精确两行闭包；源正文、索引和无关历史保持原状。 @since unreleased */
export async function runThoughtTaskTransitionPostgresChecks(context: Context) {
  await context.repo.update(store => {
    const root = store.thoughts.find(item => item.id === "producer-root")!;
    (root.followUps as RecordEntity[]).push({
      id: "transition-followup", question: "任务状态追问", version: 1, createdAt: timestamp
    });
    (root.annotations as RecordEntity[]).push({
      id: "transition-annotation", kind: "comment", text: "任务状态批注", version: 1, createdAt: timestamp
    });
  });
  const sourceRows = async () => (await context.database.query(`SELECT object_key, version, payload
    FROM for_now.store_objects WHERE account_id=$1
      AND collection NOT IN ('aiTasks','notifications') ORDER BY object_key`, [accountId])).rows;
  const original = await sourceRows();
  const measurements: { reads: number; writes: number }[] = [];
  for (const kind of ["thoughtAnswer", "followUpAnswer", "annotationShenji", "contentImageUnderstanding"]) {
    await kindMatrix(context, kind, measurements);
  }
  assert.deepEqual(await sourceRows(), original);
  assert.ok(measurements.every(item => item.reads <= 3 && item.writes <= 2), JSON.stringify(measurements));
  console.log("Thought task transitions PostgreSQL passed: four kinds, claim/wait/recover, exact task+notification writes, commit-tail rollback, revision conflicts, source mutation rejection and terminal no-op.");
}
