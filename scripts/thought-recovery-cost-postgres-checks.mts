/**
 * 启动恢复完整调用链的 SQL、返回行、载荷、复制与耗时验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户；全账户读取和模型调用直接拒绝，事务外 SQL 也计量。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createAccountUnitOfWork, type QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { StoreMapping, RecordStore, AccountUnitOfWork } from "../src/shared/persistence/record-command-types.mjs";
import { createTaskTransitionCommands } from "../src/app/record-commands/task-transitions.mjs";
import { createTaskPreparationQueries } from "../src/app/record-commands/task-preparation.mjs";
import { createTaskCreationCommands } from "../src/app/record-commands/task-creation.mjs";
import { runThoughtExecutionCostPostgresChecks } from "./thought-execution-cost-postgres-checks.mjs";
type Phase = "recovery" | "claimWaiting" | "enqueueWaiting" | "retryWaiting" | "releasePending";
type Metrics = {
  phase: Phase;
  pending: number; history: number; queries: number; readRows: number; bytes: number;
  clones: number; cloneBytes: number; seconds: number; dispatched: number; wholeReads: number;
};
type Plan = Record<string, unknown> & { Plans?: Plan[] };
type ModelPlan = { scanned: number; indexes: string[]; buffers: number };

function summarizeModelPlan(plan: Plan, result: ModelPlan): void {
  if (plan["Relation Name"] === "store_objects") {
    const loops = Number(plan["Actual Loops"] || 0);
    result.scanned += loops * (Number(plan["Actual Rows"] || 0)
      + Number(plan["Rows Removed by Filter"] || 0));
    assert.notEqual(plan["Node Type"], "Seq Scan", "model readiness must use its input identity index");
    if (plan["Index Name"]) result.indexes.push(String(plan["Index Name"]));
  }
  for (const child of plan.Plans || []) summarizeModelPlan(child, result);
}

async function seed(
  database: QueryClient, id: string, pending: number, history: number,
  mapping: StoreMapping, phase: Phase
) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const store: RecordStore = {
    thoughts: [{ id: "root", type: "question", content: "合成根", version: 1 }],
    aiTasks: Array.from({ length: pending }, (_, n) => ({
      id: `task-${String(n).padStart(5, "0")}`, kind: "thoughtAnswer", resourceType: "thought",
      targetId: "root", status: phase === "retryWaiting" ? "failed" : "queued",
      version: 1, inputHash: "verified", inputVersion: 1
    })),
    notifications: Array.from({ length: pending }, (_, n) => ({
      id: `notification-${String(n).padStart(5, "0")}`, taskId: `task-${String(n).padStart(5, "0")}`,
      status: "queued", version: 1, readAt: ""
    })),
    captures: []
  };
  if (phase !== "recovery") {
    const { normalizeOnboardingV2 } = await import(path.resolve("src/modules/onboarding/index.mjs"));
    const { prepareUserModelExtraction } = await import(path.resolve("src/app/user-model.mjs"));
    store.onboardingV2 = normalizeOnboardingV2({
      migration: { selectedFlow: "v2" },
      session: {
        revision: 1,
        answers: {
          currentContext: { rawText: "合成问答待整理", contextAllowed: true, version: 1 }
        }
      }
    });
    store.aiTasks.push({
      id: "model-inflight", kind: "onboardingClaimExtraction", targetId: "onboarding-v2",
      status: "running", inputHash: prepareUserModelExtraction(store).value.inputHash,
      createdAt: "2026-10-19T00:00:00.000Z"
    });
    if (phase === "releasePending") {
      for (const task of store.aiTasks.filter(task => task.kind === "thoughtAnswer")) {
        task.status = "waiting_for_user_model";
        task.requestedIntentInputVersion = 1;
        task.requestedIntentSubtargetVersion = 0;
        task.requestedIntentInputHash = "intent";
      }
    }
  }
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [id]);
  await writeStoreObjects(database, mapping.mapStoreObjects(id, store));
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,field,position,child_fields,content,status,author_type,version,payload
    ) SELECT $1,'["captures","noise-'||n||'"]','captures','capture','noise-'||n,'captures',
      NULL,'[]',repeat('无关历史',100),'','user',1,
      jsonb_build_object('id','noise-'||n,'content',repeat('无关历史',100),'version',1)
    FROM generate_series(1,$2::integer) n
  `, [id, history]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,field,position,child_fields,content,status,author_type,version,payload
    ) SELECT $1,'["aiTasks","completed-'||n||'"]','aiTasks','aiTask','completed-'||n,'aiTasks',
      NULL,'[]','','succeeded','user',1,
      jsonb_build_object('id','completed-'||n,'status','succeeded','kind','thoughtAnswer','version',1)
    FROM generate_series(1,$2::integer) n
  `, [id, history]);
  await database.query("ANALYZE for_now.store_objects");
}

function createMeasuredPorts(database: QueryClient, accountId: string, metrics: Metrics) {
  let modelQuery: { sql: string; values?: unknown[] } | null = null;
  const traced: QueryClient = {
    async query<Row>(sql: string, values?: unknown[]) {
      if (sql.includes("payload->>'kind' = 'onboardingClaimExtraction'")) {
        modelQuery ||= { sql, values };
      }
      const result = await database.query<Row>(sql, values);
      metrics.queries++;
      if (/^\s*(SELECT|WITH)/u.test(sql)) {
        metrics.readRows += result.rows.length;
        metrics.bytes += Buffer.byteLength(JSON.stringify(result.rows));
      }
      return result;
    }
  };
  const uow = createAccountUnitOfWork({
    transaction: async operation => {
      await traced.query("BEGIN");
      try {
        await traced.query("SET LOCAL ROLE runtime_data");
        await traced.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
        const value = await operation(traced, accountId);
        await traced.query("COMMIT");
        return value;
      } catch (error) {
        await traced.query("ROLLBACK");
        throw error;
      }
    }
  });
  return { traced, uow, modelQuery: () => modelQuery };
}

async function explainModelQuery(
  database: QueryClient, accountId: string,
  query: { sql: string; values?: unknown[] }
) {
  await database.query("BEGIN");
  try {
    await database.query("SET LOCAL ROLE runtime_data");
    await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
    const explained = await database.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.values
    );
    const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
    const result: ModelPlan = {
      scanned: 0,
      indexes: [],
      buffers: Number(plan["Shared Hit Blocks"] || 0) + Number(plan["Shared Read Blocks"] || 0)
    };
    summarizeModelPlan(plan, result);
    assert.ok(result.indexes.includes("store_objects_task_model_input_idx"));
    assert.ok(result.scanned <= 2);
    return result;
  } finally {
    await database.query("ROLLBACK");
  }
}

async function createMeasuredBackground(
  ports: { traced: QueryClient; uow: AccountUnitOfWork },
  accountId: string, mapping: StoreMapping, metrics: Metrics
) {
  const { traced, uow } = ports;
  const { createBackgroundAi } = await import(path.resolve("src/app/background-ai.mjs"));
  const { createTaskLifecycle } = await import(path.resolve("src/modules/tasks/index.mjs"));
  const { createNotificationService } = await import(path.resolve("src/modules/notifications/index.mjs"));
  const { onboardingV2ContextEntries } = await import(path.resolve("src/modules/onboarding/index.mjs"));
  const { prepareUserModelExtraction, userModelRequiresCoreReady } = await import(path.resolve("src/app/user-model.mjs"));
  const preparation = createTaskPreparationQueries({
    mapping,
    queryRecords: operation => uow.run({ commandId: "task.preparationProbe" }, () => (
      operation({ client: traced, accountId })
    )).then(result => result.value),
    onboardingPermissionKeys: store => onboardingV2ContextEntries(store.onboardingV2)
      .map((entry: { id: string }) => JSON.stringify([
        "onboardingV2", entry.id, "", `answer:${entry.id}`
      ])),
    modelInputHash: store => prepareUserModelExtraction(store).value?.inputHash || ""
  });
  let allocated = 0;
  return createBackgroundAi({
    repository: {
      accountUnitOfWork: uow,
      read: () => {
        metrics.wholeReads++;
        throw new Error("Recovery cannot read a whole account");
      },
      update: () => {
        throw new Error("Recovery cannot use legacy writes");
      }
    },
    tasks: createTaskLifecycle({
      createId: () => `cost-task-${++allocated}`,
      now: () => "2026-10-19T00:00:00.000Z",
      hash: (value: string) => value
    }),
    targets: {
      inspectIntent: (store: RecordStore) => ({
        inputVersion: store.thoughts[0].version,
        subtargetVersion: 0,
        inputHash: "intent"
      }),
      prepare() { throw new Error("Waiting task must not compile model context"); }
    },
    notifications: createNotificationService({
      createId: () => `cost-notification-${allocated}`,
      now: () => "2026-10-19T00:00:00.000Z"
    }),
    shouldWaitForModel: (store: RecordStore, input: { kind: string }) => (
      userModelRequiresCoreReady(store, input.kind)
    ),
    generate: () => { throw new Error("Recovery cannot invoke models"); },
    dispatch: () => { metrics.dispatched++; }, contextKey: () => accountId,
    onError: (error: unknown) => { throw error; },
    recordCommands: {
      enabled: (name: string) => name === "task.status",
      tasks: { cancel: () => {}, bindInput: () => {} },
      preparation,
      transitions: createTaskTransitionCommands({ unitOfWork: uow, mapping }),
      creation: createTaskCreationCommands({ unitOfWork: uow, mapping })
    }
  });
}

async function measure(
  database: QueryClient, pending: number, history: number,
  mapping: StoreMapping, phase: Phase = "recovery"
) {
  const accountId = `${phase}-cost-${pending}-${history}`;
  await seed(database, accountId, pending, history, mapping, phase);
  const metrics: Metrics = {
    phase, pending, history, queries: 0, readRows: 0, bytes: 0, clones: 0, cloneBytes: 0,
    seconds: 0, dispatched: 0, wholeReads: 0
  };
  const ports = createMeasuredPorts(database, accountId, metrics);
  const background = await createMeasuredBackground(ports, accountId, mapping, metrics);
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown) => {
    metrics.clones++;
    metrics.cloneBytes += Buffer.byteLength(JSON.stringify(value) ?? "null");
    return clone(value);
  }) as typeof structuredClone;
  const start = performance.now();
  try {
    if (phase === "claimWaiting") {
      for (let index = 0; index < pending; index++) {
        await background.run(`task-${String(index).padStart(5, "0")}`);
      }
    } else if (phase === "enqueueWaiting" || phase === "retryWaiting") {
      for (let index = 0; index < pending; index++) {
        const created: { task?: { status?: string } } = phase === "enqueueWaiting"
          ? await background.enqueue({
              kind: "thoughtAnswer", resourceType: "thought", targetId: "root",
              clientRequestId: `new-request-${index}`
            })
          : await background.retry(`task-${String(index).padStart(5, "0")}`);
        assert.equal(created.task?.status, "waiting_for_user_model");
      }
    } else if (phase === "releasePending") {
      assert.equal(await background.releaseWaiting(), 0);
    } else {
      await background.resume();
    }
  } finally {
    metrics.seconds = (performance.now() - start) / 1000;
    globalThis.structuredClone = clone;
  }
  assert.equal(metrics.dispatched, phase === "recovery" ? pending : 0);
  assert.equal(metrics.wholeReads, 0);
  if (phase === "claimWaiting") {
    const tasks = (await database.query<{ status: string }>(`
      SELECT status FROM for_now.store_objects WHERE account_id=$1
        AND collection='aiTasks' AND id LIKE 'task-%'
    `, [accountId])).rows;
    assert.equal(tasks.length, pending);
    assert.ok(tasks.every(task => task.status === "waiting_for_user_model"));
  }
  const query = ports.modelQuery();
  return {
    ...metrics,
    modelPlan: query ? await explainModelQuery(database, accountId, query) : null
  };
}

async function preparationPermissionChecks(database: QueryClient, mapping: StoreMapping) {
  const accountId = "preparation-permission";
  await seed(database, accountId, 1, 10, mapping, "claimWaiting");
  const { onboardingV2ContextEntries } = await import(path.resolve("src/modules/onboarding/index.mjs"));
  const { prepareUserModelExtraction, userModelRequiresCoreReady } = await import(path.resolve("src/app/user-model.mjs"));
  const metrics: Metrics = {
    phase: "claimWaiting", pending: 1, history: 10, queries: 0, readRows: 0,
    bytes: 0, clones: 0, cloneBytes: 0, seconds: 0, dispatched: 0, wholeReads: 0
  };
  const { traced, uow } = createMeasuredPorts(database, accountId, metrics);
  const queries = createTaskPreparationQueries({
    mapping,
    queryRecords: operation => uow.run({ commandId: "task.permissionProbe" }, () => (
      operation({ client: traced, accountId })
    )).then(result => result.value),
    onboardingPermissionKeys: store => onboardingV2ContextEntries(store.onboardingV2)
      .map((entry: { id: string }) => JSON.stringify([
        "onboardingV2", entry.id, "", `answer:${entry.id}`
      ])),
    modelInputHash: store => prepareUserModelExtraction(store).value?.inputHash || ""
  });
  const before = (await queries.claimContext("task-00000"))!;
  assert.equal(userModelRequiresCoreReady(before.snapshot), true);
  assert.ok(Object.isFrozen(before.snapshot.thoughts[0]));
  const sourceKey = JSON.stringify(["onboardingV2", "currentContext", "", "answer:currentContext"]);
  const permission = {
    id: sourceKey, accountId, sourceKey, revision: 1,
    contextAllowed: false, learningAllowed: false, updatedAt: "2026-10-19T00:00:00.000Z"
  };
  await database.query(`
    INSERT INTO for_now.store_fields(account_id,field,shape,payload)
    VALUES($1,'evidencePermissions','array',NULL)
  `, [accountId]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,field,child_fields,content,status,author_type,version,payload
    ) VALUES($1,$2,'evidencePermissions','evidencePermission',$3,'evidencePermissions',
      '[]','','','',1,$4::jsonb)
  `, [accountId, JSON.stringify(["evidencePermissions", sourceKey]), sourceKey, JSON.stringify(permission)]);
  const denied = (await queries.claimContext("task-00000"))!;
  assert.equal(denied.snapshot.evidencePermissions[0].contextAllowed, false);
  assert.equal(denied.snapshot.aiTasks.length, 1, "unpermitted extraction is not a readiness dependency");
  assert.equal(userModelRequiresCoreReady(denied.snapshot), false);
  assert.equal(before.snapshot.aiTasks.length, 2, "previous read snapshot remains unchanged");
  assert.equal(await queries.readTask("completed-unknown"), null);
  assert.equal(await queries.readTask("peer-only-task"), null);
  console.log("Thought preparation permission checks passed: denied onboarding input, exact task reads and immutable snapshots.");
}

/** N 与无关历史分别增长；同 N 的完整读取和复制成本不受 H 影响。 @since unreleased */
export async function runThoughtRecoveryCostPostgresChecks(database: QueryClient) {
  const mapping = await import(path.resolve("src/shared/persistence/store-mapping.mjs")) as StoreMapping;
  await preparationPermissionChecks(database, mapping);
  const results = [];
  for (const [pending, history] of [[10, 100], [100, 100], [100, 10000], [501, 10000]]) {
    results.push(await measure(database, pending, history, mapping));
  }
  const baseline = results[1], scaled = results[2];
  for (const field of ["queries", "readRows", "clones", "cloneBytes"] as const) {
    assert.equal(scaled[field], baseline[field], `${field} must not grow with unrelated history`);
  }
  assert.ok(Math.abs(scaled.bytes - baseline.bytes) < 2000, "only account identity byte lengths may differ");
  assert.ok(results[3].queries < results[1].queries * 6, "candidate pagination must remain linear");
  console.log("THOUGHT_RECOVERY_FULL_COST " + JSON.stringify({
    interpretation: "UTF-8 JSON of driver-returned rows and clone inputs; not PostgreSQL wire bytes",
    results
  }));
  for (const phase of ["claimWaiting", "enqueueWaiting", "retryWaiting", "releasePending"] as const) {
    const phases = [];
    for (const history of [100, 10000]) {
      phases.push(await measure(database, 100, history, mapping, phase));
    }
    for (const field of ["queries", "readRows", "clones", "cloneBytes"] as const) {
      assert.equal(phases[0][field], phases[1][field], `${phase} ${field} grows with unrelated history`);
    }
    assert.ok(Math.abs(phases[0].bytes - phases[1].bytes) < 2500);
    console.log("THOUGHT_PREPARATION_FULL_COST " + JSON.stringify({ phase, results: phases }));
  }
  await runThoughtExecutionCostPostgresChecks(database, mapping);
}
