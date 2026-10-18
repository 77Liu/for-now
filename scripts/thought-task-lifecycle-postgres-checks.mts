/**
 * 必要任务等待释放与账户隔离收尾的真实 PostgreSQL 调用链验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成账户及拒调用供应商；检查事务外准备、精确写与恢复权限。
 */
import assert from "node:assert/strict";
import { createAccountRuntimeState } from "../src/app/account-runtime-state.mjs";
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, StoreMapping
} from "../src/shared/persistence/record-command-types.mjs";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import { createTaskTransitionCommands } from "../src/app/record-commands/task-transitions.mjs";
import { createTaskCreationCommands } from "../src/app/record-commands/task-creation.mjs";
type Repository = {
  read(): Promise<RecordStore>;
  update(operation: (store: RecordStore) => void): Promise<unknown>;
  accountUnitOfWork: AccountUnitOfWork;
};
type Background = {
  enqueue(input: Record<string, unknown>): Promise<{ task?: RecordEntity }>;
  releaseWaiting(): Promise<number>;
  run(id: string): Promise<void>;
  registerHandler(kind: string, handler: Record<string, unknown>): void;
  cleanupForAccountRecovery(identity: Record<string, unknown>, guard: unknown): Promise<unknown>;
};
type Factory = (options: Record<string, unknown>) => Background;
type Context = {
  database: QueryClient;
  repo: Repository;
  mapping: StoreMapping;
  createBackground: Factory;
  createRuntime: Factory;
  tasks: unknown;
  notifications: unknown;
};
const accountId = "thought-producer-test";
const rootId = "lifecycle-root";
const kinds = ["thoughtAnswer", "followUpAnswer", "annotationShenji", "contentImageUnderstanding"];
const timestamp = "2026-10-19T00:00:00.000Z";

async function snapshot(database: QueryClient) {
  const result: Record<string, unknown> = {};
  for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
    "thought_chain_index", "thought_tag_counts", "record_changes", "account_sync_heads"]) {
    result[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return result;
}
async function failCommit(database: QueryClient, command: string, operation: () => Promise<unknown>) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_lifecycle_failure
    CHECK(command_id <> '${command}') NOT VALID`);
  try {
    await assert.rejects(operation(), /injected_lifecycle_failure/);
    assert.deepEqual(await snapshot(database), before);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_lifecycle_failure");
  }
}
function instrument(context: Context, authorize: () => void = () => {}) {
  let active = false;
  let race: (() => Promise<void>) | null = null;
  const measures: { commandId: string; reads: number; writes: number }[] = [];
  const unitOfWork: AccountUnitOfWork = {
    ...context.repo.accountUnitOfWork,
    readRevision: () => {
      authorize();
      assert.equal(active, false);
      return context.repo.accountUnitOfWork.readRevision();
    },
    run: async (options, operation) => {
      authorize();
      if (race && options.commandId === "task.releaseWaiting") {
        const inject = race;
        race = null;
        await inject();
      }
      active = true;
      try {
        const result = await context.repo.accountUnitOfWork.run(options, operation);
        measures.push({ commandId: options.commandId, reads: result.reads, writes: result.writes });
        return result;
      } finally {
        active = false;
      }
    }
  };
  return {
    measures,
    active: () => active,
    race: (inject: () => Promise<void>) => { race = inject; },
    repository: {
      ...context.repo,
      accountUnitOfWork: unitOfWork,
      read: () => {
        authorize();
        assert.equal(active, false, "full context read cannot hold a write transaction");
        return context.repo.read();
      },
      update: async () => { throw new Error("Lifecycle must not call compatibility updater"); }
    }
  };
}
function input(kind: string, key: string) {
  return {
    kind, targetId: rootId, resourceType: "thought", clientRequestId: key,
    subtargetId: kind === "followUpAnswer" ? "lifecycle-followup"
      : kind === "annotationShenji" ? "lifecycle-annotation" : ""
  };
}

async function waitingMatrix(context: Context) {
  const probe = instrument(context);
  const unitOfWork = probe.repository.accountUnitOfWork;
  let waiting = true;
  let prepares = 0;
  let dispatches = 0;
  const generatedTimes: string[] = [];
  const inspect = (store: RecordStore) => {
    const root = store.thoughts.find(item => item.id === rootId)!;
    return { inputVersion: root.version, subtargetVersion: 1, inputHash: root.content };
  };
  const background = context.createBackground({
    repository: probe.repository, tasks: context.tasks, notifications: context.notifications,
    recordCommands: {
      enabled: (name: string) => name === "task.status",
      tasks: {
        cancel: () => { throw new Error("Waiting release must not call user cancellation"); },
        bindInput: () => { throw new Error("Waiting release must not bind a running task"); }
      },
      transitions: createTaskTransitionCommands({ unitOfWork, mapping: context.mapping }),
      creation: createTaskCreationCommands({ unitOfWork, mapping: context.mapping })
    },
    shouldWaitForModel: () => waiting,
    inspectIntent: inspect,
    targets: {
      prepare(store: RecordStore, task: RecordEntity) {
        assert.equal(probe.active(), false, "waiting release prepares outside the write transaction");
        assert.ok(Object.isFrozen(store.thoughts[0]), "preparation sources are immutable");
        prepares += 1;
        generatedTimes.push(String(task.contextGeneratedAt));
        return inspect(store);
      },
      save() { throw new Error("Waiting matrix cannot save provider output"); },
      result: () => null
    },
    generate: () => { throw new Error("Waiting matrix cannot invoke a provider"); },
    dispatch: () => { dispatches += 1; },
    contextKey: () => accountId,
    now: () => timestamp,
    onError: (error: unknown) => { throw error; }
  });
  const ids: string[] = [];
  for (const kind of kinds) {
    const result = await background.enqueue(input(kind, `lifecycle-wait:${kind}`));
    assert.equal(result.task?.status, "waiting_for_user_model");
    ids.push(String(result.task?.id));
  }
  const unchanged = await snapshot(context.database);
  assert.equal(await background.releaseWaiting(), 0);
  assert.deepEqual(await snapshot(context.database), unchanged);
  assert.equal(prepares, 0);
  waiting = false;
  await failCommit(context.database, "task.releaseWaiting", () => background.releaseWaiting());
  assert.equal(dispatches, 0);
  assert.equal(await background.releaseWaiting(), 4);
  assert.equal(dispatches, 4);
  for (const id of ids) {
    const store = await context.repo.read();
    assert.equal(store.aiTasks.find(task => task.id === id)?.contextGeneratedAt, timestamp);
    assert.equal(store.notifications.find(item => item.taskId === id)?.status, "queued");
  }
  const released = await snapshot(context.database);
  assert.equal(await background.releaseWaiting(), 0);
  assert.deepEqual(await snapshot(context.database), released);
  waiting = true;
  const raced = await background.enqueue(input("thoughtAnswer", "lifecycle-wait:race"));
  waiting = false;
  const preparedBeforeRace = prepares;
  probe.race(async () => {
    await context.repo.update(store => {
      const root = store.thoughts.find(item => item.id === rootId)!;
      root.content = "等待释放前来源发生变化";
      root.version = Number(root.version) + 1;
    });
  });
  assert.equal(await background.releaseWaiting(), 0);
  assert.equal(prepares, preparedBeforeRace + 1);
  assert.equal((await context.repo.read()).aiTasks.find(task => task.id === raced.task?.id)?.status, "stale");
  assert.equal(dispatches, 4, "stale prepared work never dispatches");
  assert.ok(generatedTimes.every(value => value === timestamp));
  assert.ok(probe.measures.filter(item => item.commandId === "task.releaseWaiting")
    .every(item => item.reads <= 3 && item.writes <= 2));
}

async function cleanupMatrix(context: Context) {
  const runtime = createAccountRuntimeState({
    config: { enabled: true, concurrency: 1, accountDeadlineMs: 1000, retryCooldownMs: 0 },
    getContext: () => undefined,
    getAccountKey: () => accountId
  });
  await runtime.recover(accountId, async () => {});
  const probe = instrument(context, runtime.authorize);
  let providers = 0;
  const background = context.createRuntime({
    repository: probe.repository,
    accountRuntime: runtime,
    runDeepSeek: async () => {
      providers += 1;
      runtime.noteFailure(Object.assign(new Error("injected account quarantine"), {
        recoveryScope: "account", accountId, reasonCode: "LIFECYCLE_TEST_QUARANTINE"
      }));
      throw Object.assign(new Error("account quarantined"), { code: "ACCOUNT_QUARANTINED" });
    }
  });
  background.registerHandler("thoughtAnswer", {
    prepare: (store: RecordStore) => {
      assert.equal(probe.active(), false);
      const root = store.thoughts.find(item => item.id === rootId)!;
      return { kind: "thoughtAnswer", scene: "thoughtAnswer", prompt: "synthetic",
        inputVersion: root.version, inputHash: root.content };
    },
    save() { throw new Error("Quarantined output cannot save"); },
    result: () => null
  });
  const created = await background.enqueue(input("thoughtAnswer", "lifecycle-cleanup:run"));
  assert.equal(created.task?.status, "queued");
  await background.run(String(created.task?.id));
  assert.equal(runtime.state(accountId)?.status, "quarantined");
  const current = (await context.repo.read()).aiTasks.find(task => task.id === created.task?.id)!;
  assert.equal(current.status, "cancelled");
  assert.equal(current.errorCode, "ACCOUNT_QUARANTINED");
  assert.equal(providers, 1);
  assert.throws(runtime.authorize, { code: "ACCOUNT_QUARANTINED" });
  const cleanup = (identity: Record<string, unknown>) => runtime.cleanupTask(
    identity as { id: string; attempt: number },
    () => background.cleanupForAccountRecovery(identity, runtime.assertCommit)
  );
  const stable = await snapshot(context.database);
  assert.equal(await cleanup({ id: current.id, attempt: current.attempt, kind: current.kind }), false);
  assert.deepEqual(await snapshot(context.database), stable);
  for (const kind of kinds) {
    await context.repo.update(store => {
      store.aiTasks.push({
        id: `lifecycle-cleanup:${kind}`, ...input(kind, `cleanup:${kind}`),
        status: "running", attempt: 2, createdAt: timestamp
      });
      store.notifications.push({
        id: `notification-cleanup:${kind}`, taskId: `lifecycle-cleanup:${kind}`,
        status: "running", createdAt: timestamp, readAt: ""
      });
    });
    const identity = { id: `lifecycle-cleanup:${kind}`, attempt: 2, kind };
    const before = await snapshot(context.database);
    assert.equal(await cleanup({ ...identity, attempt: 1 }), false);
    assert.deepEqual(await snapshot(context.database), before);
    await failCommit(context.database, "task.accountRecoveryCleanup", () => cleanup(identity));
    assert.equal(await cleanup(identity), true);
    assert.equal((await context.repo.read()).notifications.find(item => item.taskId === identity.id)?.status, "cancelled");
  }
  const commands = createTaskTransitionCommands({
    unitOfWork: probe.repository.accountUnitOfWork, mapping: context.mapping
  });
  await context.repo.update(store => {
    const task = store.aiTasks.find(item => item.id === "lifecycle-cleanup:thoughtAnswer")!;
    task.status = "running";
  });
  const beforeForbidden = await snapshot(context.database);
  await assert.rejects(runtime.cleanupTask({ id: "lifecycle-cleanup:thoughtAnswer", attempt: 2 },
    () => commands.cleanup({
      taskId: "lifecycle-cleanup:thoughtAnswer", attempt: 2,
      assertCommit: runtime.assertCommit,
      mutate(store) {
        store.aiTasks[0].status = "cancelled";
        store.aiTasks[0].inputHash = "forbidden";
      }
    })), { code: "ACCOUNT_CLEANUP_NOT_ALLOWED" });
  assert.deepEqual(await snapshot(context.database), beforeForbidden);
  assert.ok(probe.measures.filter(item => item.commandId !== "task.enqueue")
    .every(item => item.reads <= 3 && item.writes <= 2));
}

/** 等待准备和隔离收尾按正式调度/权限链验证，保留来源记录。 @since unreleased */
export async function runThoughtTaskLifecyclePostgresChecks(context: Context) {
  await context.repo.update(store => {
    // 前一矩阵留有不同来源的等待任务；本矩阵只观察自己的调度候选。
    for (const task of store.aiTasks) {
      if (task.status !== "waiting_for_user_model") continue;
      task.status = "cancelled";
      const notification = store.notifications.find(item => item.taskId === task.id);
      if (notification) notification.status = "cancelled";
    }
    store.thoughts.push({
      id: rootId, type: "question", content: "生命周期原文", version: 1,
      createdAt: timestamp, occurredOn: "2026-10-19", authorType: "user", status: "ready",
      followUps: [{ id: "lifecycle-followup", question: "追问", version: 1, createdAt: timestamp }],
      annotations: [{ id: "lifecycle-annotation", kind: "comment", text: "批注", version: 1, createdAt: timestamp }]
    });
  });
  await waitingMatrix(context);
  const sources = async () => (await context.database.query(`SELECT object_key,version,payload
    FROM for_now.store_objects WHERE account_id=$1
      AND collection NOT IN ('aiTasks','notifications') ORDER BY object_key`, [accountId])).rows;
  const before = await sources();
  await cleanupMatrix(context);
  assert.deepEqual(await sources(), before);
  console.log("Thought task lifecycle PostgreSQL passed: four waiting releases prepare outside transactions, immutable sources, revision race rejection, four restricted cleanup kinds, formal quarantine callback, exact two-row writes, tail rollback and stale-attempt/replay no-op.");
}
