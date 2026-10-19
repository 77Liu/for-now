/**
 * 正式回答运行时从入队到写回的 PostgreSQL 成本验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户与本地供应商；真实资格核验、短事务和来源副作用均计量。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createAccountUnitOfWork, type QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordStore, StoreMapping } from "../src/shared/persistence/record-command-types.mjs";
import { createThoughtRuntimeFixture } from "./thought-runtime-fixture.mjs";

type Cost = {
  queries: number;
  rows: number;
  bytes: number;
  clones: number;
  cloneBytes: number;
  seconds: number;
  candidateScanned: number;
};
type Stage = "enqueue" | "failedRun" | "retry" | "successfulRun"
  | "enqueueWaiting" | "release" | "releasedRun";
type Background = {
  enqueue(input: Record<string, unknown>): Promise<{ task?: { id: string; status: string } }>;
  retry(id: string): Promise<{ task?: { id: string; status: string } }>;
  run(id: string): Promise<void>;
  releaseWaiting(): Promise<number>;
};
const timestamp = "2026-10-19T00:00:00.000Z";
const emptyCost = (): Cost => ({
  queries: 0, rows: 0, bytes: 0, clones: 0, cloneBytes: 0, seconds: 0,
  candidateScanned: 0
});

function scannedObjects(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + scannedObjects(child), 0);
  const plan = value as Record<string, unknown>;
  const scanned = plan["Relation Name"] === "store_objects"
    ? Number(plan["Actual Loops"]) * (
      Number(plan["Actual Rows"]) + Number(plan["Rows Removed by Filter"] || 0)
    ) : 0;
  return scanned + Object.values(plan).reduce<number>((sum, child) => sum + scannedObjects(child), 0);
}

async function seed(database: QueryClient, mapping: StoreMapping, accountId: string, history: number) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const store: RecordStore = {
    thoughts: ["direct", "waiting"].map(id => ({
      id, type: "question", content: "怎样保持阅读习惯？", authorType: "user",
      version: 1, occurredAt: timestamp, occurredOn: "2026-10-19",
      createdAt: timestamp, tags: []
    })),
    captures: Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index}`, content: `每天阅读十分钟，记录第${index}次尝试`,
      authorType: "user", version: 1, occurredAt: timestamp
    })),
    aiTasks: [], notifications: [], evidencePermissions: [], perceptionEvents: [],
    evidenceSources: [], userClaims: []
  };
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, child_fields,
      content, status, author_type, version, payload
    ) SELECT $1, '["captures","noise-' || n || '"]', 'captures', 'capture',
      'noise-' || n, 'captures', '[]', repeat('无关历史', 50), '', 'user', 1,
      jsonb_build_object('id', 'noise-' || n, 'content', repeat('无关历史', 50),
        'authorType', 'user', 'contextAllowed', false, 'version', 1,
        'occurredAt', '2024-01-01T00:00:00Z')
    FROM generate_series(1, $2::integer) n
  `, [accountId, history]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, child_fields,
      content, status, author_type, version, payload
    ) SELECT $1, '["aiTasks","noise-' || n || '"]', 'aiTasks', 'aiTask',
      'noise-' || n, 'aiTasks', '[]', '', 'succeeded', '', 1,
      jsonb_build_object('id', 'noise-' || n, 'kind', 'thoughtAnswer',
        'status', 'succeeded', 'version', 1)
    FROM generate_series(1, $2::integer) n
  `, [accountId, history]);
  await database.query("ANALYZE for_now.store_objects");
}

function measuredRepository(database: QueryClient, accountId: string, cost: () => Cost | null) {
  let transactionActive = false;
  const client: QueryClient = {
    async query<Row>(sql: string, values?: unknown[]) {
      const result = await database.query<Row>(sql, values);
      const metrics = cost();
      if (metrics) {
        metrics.queries++;
        if (/^\s*(SELECT|WITH)/u.test(sql)) {
          metrics.rows += result.rows.length;
          metrics.bytes += Buffer.byteLength(JSON.stringify(result.rows));
        }
        if (sql.includes("object_key > $3") && sql.includes("payload->'contextAllowed'")) {
          const explained = await database.query(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values
          );
          metrics.candidateScanned += scannedObjects(explained.rows);
        }
      }
      return result;
    }
  };
  async function transaction<Result>(
    operation: (context: { client: QueryClient; accountId: string }) => Promise<Result>,
    readOnly: boolean
  ) {
    assert.equal(transactionActive, false, "provider preparation cannot hold another transaction");
    transactionActive = true;
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    try {
      await client.query("SET LOCAL ROLE runtime_data");
      await client.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
      if (!readOnly) {
        await client.query("SELECT account_id FROM for_now.accounts WHERE account_id=$1 FOR UPDATE", [accountId]);
      }
      const result = await operation({ client, accountId });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      transactionActive = false;
    }
  }
  const accountUnitOfWork = createAccountUnitOfWork({
    now: () => timestamp,
    transaction: operation => transaction(context => operation(context.client, context.accountId), false)
  });
  const forbidden = () => { throw new Error("Formal execution cannot read or rewrite a whole account"); };
  return {
    active: () => transactionActive,
    repository: {
      accountUnitOfWork,
      queryRecords: <Result,>(operation: (context: { client: QueryClient; accountId: string }) => Promise<Result>) => (
        transaction(operation, true)
      ),
      read: forbidden,
      update: forbidden,
      executeIdempotent: forbidden
    }
  };
}

async function beginModelWait(database: QueryClient, mapping: StoreMapping, accountId: string) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const { normalizeOnboardingV2 } = await import(path.resolve("src/modules/onboarding/index.mjs"));
  const { prepareUserModelExtraction } = await import(path.resolve("src/app/user-model.mjs"));
  const store: RecordStore = {
    onboardingV2: normalizeOnboardingV2({
      migration: { selectedFlow: "v2" },
      session: {
        revision: 1,
        answers: { currentContext: { rawText: "阅读原文待整理", contextAllowed: true, version: 1 } }
      }
    }),
    aiTasks: []
  };
  store.aiTasks.push({
    id: "model-inflight", kind: "onboardingClaimExtraction", targetId: "onboarding-v2",
    status: "running", inputHash: prepareUserModelExtraction(store).value.inputHash,
    createdAt: timestamp, version: 1
  });
  const added = mapping.mapStoreObjects(accountId, store) as ReturnType<StoreMapping["mapStoreObjects"]> & {
    fields: { field: string }[];
  };
  added.fields = added.fields.filter(field => field.field !== "aiTasks");
  await writeStoreObjects(database, added);
}

async function measure(database: QueryClient, mapping: StoreMapping, history: number) {
  const accountId = history === 100 ? "execution-cost-small" : "execution-cost-large";
  await seed(database, mapping, accountId, history);
  let currentCost: Cost | null = null;
  const measured = measuredRepository(database, accountId, () => currentCost);
  const { createContentRuntime } = await import(path.resolve("src/app/content-runtime.mjs"));
  let shouldFail = true;
  let providerCalls = 0;
  let providerChecks = 0;
  const fixture = createThoughtRuntimeFixture(createContentRuntime, measured.repository, accountId, {
    thoughtPagingConfig: { enabled: false },
    runDeepSeek: async (_prompt: string, options: { isCurrent(): Promise<boolean> }) => {
      assert.equal(measured.active(), false, "provider must run outside a database transaction");
      providerCalls++;
      for (let index = 0; index < 2; index++) {
        assert.equal(await options.isCurrent(), true, "formal asynchronous qualification must remain current");
        providerChecks++;
      }
      if (shouldFail) {
        throw Object.assign(new Error("合成供应商失败"), { code: "EXECUTION_COST_PROVIDER_FAILED" });
      }
      return { content: JSON.stringify({ answer: "从每天十分钟开始，逐次记录。", citations: [] }) };
    }
  });
  const background = fixture.backgroundAi as unknown as Background;
  const costs = {} as Record<Stage, Cost>;
  async function stage<Result>(name: Stage, operation: () => Promise<Result>) {
    const metrics = emptyCost();
    costs[name] = metrics;
    currentCost = metrics;
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = ((value: unknown) => {
      metrics.clones++;
      metrics.cloneBytes += Buffer.byteLength(JSON.stringify(value) ?? "null");
      return clone(value);
    }) as typeof structuredClone;
    const started = performance.now();
    try {
      return await operation();
    } finally {
      metrics.seconds = (performance.now() - started) / 1000;
      globalThis.structuredClone = clone;
      currentCost = null;
    }
  }
  const input = (targetId: string) => ({
    kind: "thoughtAnswer", resourceType: "thought", targetId,
    clientRequestId: `execution:${targetId}`
  });
  const created = await stage("enqueue", () => background.enqueue(input("direct")));
  assert.equal(created.task?.status, "queued");
  await stage("failedRun", () => background.run(created.task!.id));
  const failed = (await database.query<{ status: string; payload: Record<string, unknown> }>(`
    SELECT status,payload FROM for_now.store_objects WHERE account_id=$1 AND id=$2
  `, [accountId, created.task!.id])).rows[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.payload.errorCode, "EXECUTION_COST_PROVIDER_FAILED");
  assert.ok(failed.payload.importanceSelectionPlan, "creation must freeze its original material selection");
  const retried = await stage("retry", () => background.retry(created.task!.id));
  assert.equal(retried.task?.status, "queued");
  shouldFail = false;
  await stage("successfulRun", () => background.run(retried.task!.id));
  await assertWritten(database, accountId, retried.task!.id);

  await beginModelWait(database, mapping, accountId);
  const waiting = await stage("enqueueWaiting", () => background.enqueue(input("waiting")));
  assert.equal(waiting.task?.status, "waiting_for_user_model");
  await database.query(`
    UPDATE for_now.store_objects SET status='failed',
      payload=jsonb_set(payload,'{status}','"failed"')
    WHERE account_id=$1 AND id='model-inflight' AND collection='aiTasks'
  `, [accountId]);
  assert.equal(await stage("release", () => background.releaseWaiting()), 1);
  await stage("releasedRun", () => background.run(waiting.task!.id));
  await assertWritten(database, accountId, waiting.task!.id);
  assert.equal(providerCalls, 3);
  assert.equal(providerChecks, 6);
  return { history, costs, providerCalls, providerChecks };
}

async function assertWritten(database: QueryClient, accountId: string, taskId: string) {
  const task = (await database.query<{ status: string; payload: Record<string, unknown> }>(`
    SELECT status,payload FROM for_now.store_objects
    WHERE account_id=$1 AND collection='aiTasks' AND id=$2
  `, [accountId, taskId])).rows[0];
  assert.equal(task.status, "succeeded", JSON.stringify(task.payload));
  const answer = (await database.query<{ payload: Record<string, unknown> }>(`
    SELECT payload FROM for_now.store_objects
    WHERE account_id=$1 AND collection='thoughts' AND id=$2
  `, [accountId, task.payload.resultId])).rows[0];
  assert.ok(answer);
  assert.equal(answer.payload.sourceTaskId, taskId);
  assert.ok(answer.payload.contextReceipt);
  assert.ok(task.payload.contextFingerprint);
  const notification = (await database.query<{ status: string }>(`
    SELECT status FROM for_now.store_objects
    WHERE account_id=$1 AND collection='notifications' AND payload->>'taskId'=$2
  `, [accountId, taskId])).rows[0];
  assert.equal(notification.status, "succeeded");
}

/** 首次合法池允许线性枚举，冻结后的执行、重试和写回不随无关历史增长。 @since unreleased */
export async function runThoughtExecutionCostPostgresChecks(database: QueryClient, mapping: StoreMapping) {
  const results = [];
  for (const history of [100, 10000]) results.push(await measure(database, mapping, history));
  for (const name of ["enqueue", "failedRun", "retry", "successfulRun",
    "enqueueWaiting", "release", "releasedRun"] as Stage[]) {
    const small: Cost = results[0].costs[name];
    const large: Cost = results[1].costs[name];
    for (const field of ["queries", "rows", "clones"] as const) {
      assert.equal(large[field], small[field], `${name} ${field} grows with unrelated history`);
    }
    for (const field of ["bytes", "cloneBytes"] as const) {
      assert.ok(Math.abs(large[field] - small[field]) < 3000, `${name} ${field} grows with unrelated history`);
    }
    assert.ok(large.candidateScanned < 100, `${name} candidate lookup scans unrelated disabled history`);
  }
  console.log("THOUGHT_EXECUTION_FULL_COST " + JSON.stringify({
    interpretation: "UTF-8 JSON of driver-returned rows and clone inputs; not PostgreSQL wire bytes",
    firstPoolStages: ["enqueue", "release"],
    results
  }));
}
