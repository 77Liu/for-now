/**
 * 正式运行时任务入队、重试、幂等与失败原子性的 PostgreSQL 验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成账户；拒绝兼容 updater 和供应商调用，检查真实数据库行。
 */
import assert from "node:assert/strict";
import type {
  AccountUnitOfWork, RecordStore
} from "../src/shared/persistence/record-command-types.mjs";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
type Result = { task?: Record<string, unknown>; duplicate?: boolean; [key: string]: unknown };
type Repository = {
  read(): Promise<RecordStore>;
  update(operation: (store: RecordStore) => void): Promise<unknown>;
  accountUnitOfWork: AccountUnitOfWork;
};
type Background = {
  enqueue(input: Record<string, unknown>): Promise<Result>;
  retry(id: string): Promise<Result>;
  registerHandler(kind: string, handler: Record<string, unknown>): boolean;
};
const accountId = "thought-producer-test";
const timestamp = "2026-10-19T00:00:00.000Z";
const rootId = "creation-root";
async function snapshot(database: QueryClient) {
  const state: Record<string, unknown> = {};
  for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
    "store_attachment_refs", "resource_lifecycle", "thought_chain_index", "thought_tag_counts",
    "record_changes", "account_sync_heads", "idempotency_ledger"]) {
    state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return state;
}
async function rejectCommit(database: QueryClient, commandId: string, operation: () => Promise<unknown>) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_task_creation_failure
    CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(operation(), /injected_task_creation_failure/);
    assert.deepEqual(await snapshot(database), before);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_task_creation_failure");
  }
}
function request(kind: string) {
  return {
    kind, targetId: rootId, resourceType: "thought", clientRequestId: `creation:${kind}`,
    subtargetId: kind === "followUpAnswer" ? "creation-followup"
      : kind === "annotationShenji" ? "creation-annotation" : "",
    payload: kind === "contentImageUnderstanding" ? {
      targetType: "thoughtRoot", targetId: rootId, attachmentPaths: ["/attachments/creation.png"]
    } : kind === "annotationShenji" ? { message: "解释这段内容" } : {}
  };
}
async function kindMatrix(database: QueryClient, repo: Repository, background: Background, kind: string) {
  const input = request(kind);
  await rejectCommit(database, "task.enqueue", () => background.enqueue(input));
  const created = await background.enqueue(input);
  assert.ok(created.task, JSON.stringify(created));
  assert.equal(created.duplicate, false);
  const beforeReplay = await snapshot(database);
  assert.equal((await background.enqueue(input)).task?.id, created.task.id);
  assert.equal((await background.enqueue(input)).duplicate, true);
  assert.deepEqual(await snapshot(database), beforeReplay);
  assert.deepEqual(await background.enqueue({ ...input, targetId: "another-target" }), { conflict: true });
  assert.deepEqual(await snapshot(database), beforeReplay);
  const taskId = String(created.task.id);
  await repo.update(store => {
    store.aiTasks.find(task => task.id === taskId)!.status = "failed";
    store.notifications.find(notification => notification.taskId === taskId)!.status = "failed";
  });
  await rejectCommit(database, "task.retry", () => background.retry(taskId));
  const retry = await background.retry(taskId);
  assert.ok(retry.task, JSON.stringify(retry));
  assert.equal(retry.task.retryOf, taskId);
  const retried = await snapshot(database);
  assert.equal((await background.retry(taskId)).task?.id, retry.task.id);
  assert.equal((await background.retry(taskId)).duplicate, true);
  assert.deepEqual(await snapshot(database), retried);
  const relations = (await database.query<{ relation: string; resolution: string }>(`
    SELECT relation,resolution FROM for_now.store_relations
    WHERE account_id=$1 AND object_key=$2 ORDER BY relation`,
  [accountId, JSON.stringify(["aiTasks", retry.task.id])])).rows;
  assert.ok(relations.some(row => row.relation === "retryOf" && row.resolution === "live"));
  assert.ok(relations.some(row => row.relation === "target" && row.resolution === "live"));
  return Number(created.task.status === "queued") + Number(retry.task.status === "queued");
}

/** 四类入队与重试拒绝全账户写；十倍历史计划另由原语规模验收检查。 @since unreleased */
export async function runThoughtTaskCreationPostgresChecks({
  database, repo, createBackground
}: {
  database: QueryClient;
  repo: Repository;
  createBackground(repository: Repository, dispatch: () => void): Background;
}) {
  await repo.update(store => {
    store.thoughts.push({
      id: rootId, type: "question", content: "任务入队原文", version: 1,
      createdAt: timestamp, occurredOn: "2026-10-19", authorType: "user", status: "ready",
      attachmentPaths: ["/attachments/creation.png"],
      followUps: [{ id: "creation-followup", question: "追问", version: 1, createdAt: timestamp }],
      annotations: [{
        id: "creation-annotation", kind: "comment", quote: "原文", text: "批注",
        targetKey: `question:${rootId}`, start: 4, end: 6, version: 1,
        replies: [], shenji: [], createdAt: timestamp
      }]
    });
  });
  const measures: { commandId: string; reads: number; writes: number }[] = [];
  let transactionActive = false;
  let injectRevision = false;
  const unitOfWork: AccountUnitOfWork = {
    ...repo.accountUnitOfWork,
    run: async (options, operation) => {
      if (injectRevision && options.commandId === "task.enqueue") {
        injectRevision = false;
        await repo.update(store => {
          const root = store.thoughts.find(item => item.id === rootId)!;
          root.content = "准备后来源竞态已更新";
          root.version = Number(root.version) + 1;
        });
      }
      transactionActive = true;
      try {
        const result = await repo.accountUnitOfWork.run(options, operation);
        measures.push({ commandId: options.commandId, reads: result.reads, writes: result.writes });
        return result;
      } finally {
        transactionActive = false;
      }
    }
  };
  const bounded = {
    ...repo,
    update: async () => { throw new Error("Task creation must not use compatibility updater"); },
    executeIdempotent: async () => { throw new Error("Task creation must not use compatibility ledger"); },
    accountUnitOfWork: unitOfWork
  };
  let dispatches = 0;
  const background = createBackground(bounded, () => { dispatches += 1; });
  const sourceRows = async () => (await database.query(`SELECT object_key,version,payload
    FROM for_now.store_objects WHERE account_id=$1
      AND collection NOT IN ('aiTasks','notifications') ORDER BY object_key`, [accountId])).rows;
  const source = await sourceRows();
  let expectedDispatches = 0;
  for (const kind of ["thoughtAnswer", "followUpAnswer", "annotationShenji", "contentImageUnderstanding"]) {
    expectedDispatches += await kindMatrix(database, repo, background, kind);
  }
  assert.equal(dispatches, expectedDispatches, "only committed queued tasks dispatch; waiting/replay/failure never dispatch");
  assert.deepEqual(await sourceRows(), source);
  const beforeInvalid = await snapshot(database);
  assert.deepEqual(await background.enqueue({ ...request("thoughtAnswer"), clientRequestId: "" }), { invalid: true });
  assert.deepEqual(await background.enqueue({ ...request("thoughtAnswer"),
    clientRequestId: "missing-target", targetId: "missing-target" }), { missing: true });
  assert.deepEqual(await snapshot(database), beforeInvalid);
  assert.ok(measures.every(item => item.reads <= 12 && item.writes <= 10), JSON.stringify(measures));
  let prepares = 0;
  background.registerHandler("thoughtAnswer", {
    prepare(store: RecordStore) {
      assert.equal(transactionActive, false, "context preparation must happen outside write transaction");
      prepares += 1;
      const root = store.thoughts.find(item => item.id === rootId)!;
      return { inputVersion: root.version, inputHash: root.content };
    },
    save() { throw new Error("No provider or result write in preparation probe"); },
    result() { return null; }
  });
  injectRevision = true;
  const raced = await background.enqueue({ ...request("thoughtAnswer"), clientRequestId: "creation-raced" });
  assert.ok(raced.task);
  assert.equal(prepares, 2, "revision conflict prepares fresh context before the second transaction");
  assert.equal(raced.task.inputHash, "准备后来源竞态已更新");
  assert.equal(raced.task.inputVersion, 2);
  console.log("Thought task creation PostgreSQL passed: four formal-runtime kinds, enqueue/retry, replay/conflict, precise rows+relations, commit-tail atomic rollback, invalid no-op and source preservation.");
}
