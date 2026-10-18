/**
 * 记录闭包的真实 SQL 执行计划与历史规模验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户，使用正式记录原语及非超级用户 RLS。
 */
import assert from "node:assert/strict";
import { createAccountUnitOfWork, type QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import { readThoughtDetailRows } from "../src/modules/thoughts/projection.mjs";
import type { RecordStore } from "../src/shared/persistence/record-command-types.mjs";

const accountId = "thought-closure-scale";
const rootKey = '["thoughts","closure-root"]';
type Plan = Record<string, unknown> & { Plans?: Plan[] };
type Measurement = { query: string; scanned: number; buffers: number; indexes: string[] };

function summarize(plan: Plan, output: Measurement) {
  const loops = Number(plan["Actual Loops"] || 0);
  if (["store_objects", "store_relations"].includes(String(plan["Relation Name"]))) {
    output.scanned += (Number(plan["Actual Rows"] || 0)
      + Number(plan["Rows Removed by Filter"] || 0)
      + Number(plan["Rows Removed by Index Recheck"] || 0)) * loops;
    if (plan["Index Name"]) output.indexes.push(String(plan["Index Name"]));
    assert.notEqual(plan["Node Type"], "Seq Scan", JSON.stringify(plan));
  }
  for (const child of plan.Plans || []) summarize(child, output);
}

async function seed(database: QueryClient) {
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [accountId]);
  for (const field of ["thoughts", "aiTasks", "recordCompressions", "trash"]) {
    await database.query(`INSERT INTO for_now.store_fields(account_id,field,shape,payload)
      VALUES ($1,$2,'array',NULL)`, [accountId, field]);
  }
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,parent_key,field,position,
      child_fields,content,status,author_type,version,payload
    ) VALUES ($1,$2,'thoughts','question','closure-root',NULL,'thoughts',NULL,
      '[]','根','ready','user',1,'{"id":"closure-root","type":"question"}')
  `, [accountId, rootKey]);
  for (const [collection, id, payload] of [
    ["aiTasks", "live-task", { sourceRef: { rootId: "closure-root" } }],
    ["aiTasks", "history-task", { sourceRef: { rootId: "closure-root" } }],
    ["aiTasks", "wrong-root-history", { sourceRef: { rootId: "other-root" } }],
    ["aiTasks", "date-task", { payload: { localDate: "2026-10-19" } }],
    ["aiTasks", "window-task", { payload: { windowStart: "2026-10-17", windowEnd: "2026-10-20" } }],
    ["aiTasks", "invalid-window-task", { payload: { windowStart: "bad", windowEnd: "bad" } }],
    ["recordCompressions", "date-summary", { localDate: "2026-10-19" }],
    ["trash", "deleted-root", { type: "thoughtChain", resourceId: "closure-root" }]
  ] as const) {
    await database.query(`
      INSERT INTO for_now.store_objects(
        account_id,object_key,collection,kind,id,parent_key,field,position,
        child_fields,content,status,author_type,version,payload,deleted_at
      ) VALUES ($1,$2,$3,'record',$4,NULL,$3,NULL,'[]','','running','user',1,$5::jsonb,'2026-10-19')
    `, [accountId, JSON.stringify([collection, id]), collection, id, JSON.stringify({ id, ...payload })]);
  }
  for (const id of ["live-task", "history-task", "wrong-root-history"]) {
    await database.query(`INSERT INTO for_now.store_relations(
      account_id,object_key,relation,target_key,target_collection,target_id,resolution
    ) VALUES ($1,$2,'source',$3,'thoughts','closure-root',$4)`,
    [accountId, JSON.stringify(["aiTasks", id]), id === "live-task" ? rootKey : null,
      id === "live-task" ? "live" : "historical"]);
  }
}

async function grow(database: QueryClient, from: number, to: number) {
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,parent_key,field,position,
      child_fields,content,status,author_type,version,payload,deleted_at
    )
    SELECT $1,jsonb_build_array(collection,'noise-'||n)::text,collection,'record',
      'noise-'||n,NULL,collection,NULL,'[]','','running','user',1,
      jsonb_build_object('id','noise-'||n,
        'localDate',CASE WHEN n%2=0 THEN '2020-01-01' ELSE '2030-01-01' END,
        'type','thoughtChain','resourceId','noise-'||n,
        'payload',jsonb_build_object(
          'localDate',CASE WHEN n%2=0 THEN '2020-01-01' ELSE '2030-01-01' END,
          'windowStart',CASE WHEN n%2=0 THEN '2020-01-01' ELSE '2030-01-01' END,
          'windowEnd',CASE WHEN n%2=0 THEN '2020-01-02' ELSE '2030-01-02' END)), '2020-01-01'
    FROM unnest(ARRAY['thoughts','aiTasks','recordCompressions','trash']) collection
    CROSS JOIN generate_series($2::integer,$3::integer) n
  `, [accountId, from, to]);
  await database.query(`
    INSERT INTO for_now.store_relations(
      account_id,object_key,relation,target_key,target_collection,target_id,resolution
    ) SELECT $1,jsonb_build_array('aiTasks','noise-'||n)::text,'source',
      CASE WHEN n%2=0 THEN jsonb_build_array('thoughts','noise-'||n)::text ELSE NULL END,
      'thoughts','noise-'||n,CASE WHEN n%2=0 THEN 'live' ELSE 'historical' END
    FROM generate_series($2::integer,$3::integer) n
  `, [accountId, from, to]);
  await database.query("ANALYZE for_now.store_objects");
  await database.query("ANALYZE for_now.store_relations");
}

async function measure(database: QueryClient) {
  const measurements: Measurement[] = [];
  const transaction = async <T,>(operation: (client: QueryClient, id: string) => Promise<T>) => {
    await database.query("BEGIN");
    try {
      await database.query("SET LOCAL ROLE runtime_data");
      await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
      const traced: QueryClient = {
        async query<Row>(sql: string, values?: unknown[]) {
          if (/^\s*(SELECT|WITH)\s/u.test(sql) && /store_objects|store_relations/u.test(sql)) {
            const explained = await database.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values
            );
            const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
            const measurement = {
              query: sql.includes("WITH candidates") ? "relations" : sql.includes("record_window_start") ? "dates"
                : sql.includes("collection = 'trash'") ? "trash" : "tree",
              scanned: 0,
              buffers: Number(plan["Shared Hit Blocks"] || 0) + Number(plan["Shared Read Blocks"] || 0),
              indexes: [] as string[]
            };
            summarize(plan, measurement);
            measurements.push(measurement);
          }
          return database.query<Row>(sql, values);
        }
      };
      return await operation(traced, accountId);
    } finally {
      await database.query("ROLLBACK");
    }
  };
  const uow = createAccountUnitOfWork({ transaction });
  await uow.run({ commandId: "thought.closure.measure" }, async ports => {
    assert.deepEqual((await ports.relations.findSources([rootKey], {
      sourceCollection: "aiTasks", historicalRootId: "closure-root"
    })).sort(), ['["aiTasks","history-task"]', '["aiTasks","live-task"]']);
    assert.deepEqual(await ports.relations.findSources([rootKey], {
      sourceCollection: "aiTasks"
    }), ['["aiTasks","live-task"]']);
    assert.equal((await ports.objects.findTree([rootKey])).length, 1);
    assert.equal((await ports.objects.findTrash("thoughtChain", "closure-root"))?.id, "deleted-root");
    assert.deepEqual((await ports.objects.findForLocalDates("aiTasks", ["2026-10-19"], {
      runningOnly: true
    })).map(row => row.id).sort(), ["date-task", "window-task"]);
    assert.deepEqual((await ports.objects.findForLocalDates("recordCompressions", ["2026-10-19"]))
      .map(row => row.id), ["date-summary"]);
  });
  return measurements;
}

async function longTree(database: QueryClient) {
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,parent_key,field,position,
      child_fields,content,status,author_type,version,payload
    )
    SELECT $1,jsonb_build_array('thoughts','closure-root','remarks','remark-'||n)::text,
      'thoughts','remark','remark-'||n,$2,'remarks',NULL,'[]','','ready','user',1,
      jsonb_build_object('id','remark-'||n,'text','长链备注','version',1)
    FROM generate_series(1,600) n
  `, [accountId, rootKey]);
  const uow = createAccountUnitOfWork({
    transaction: async operation => operation(database, accountId)
  });
  const read = await uow.run({ commandId: "thought.long-tree.read" }, ports => ports.objects.findTree([rootKey]));
  assert.equal(read.value.length, 601);
  const detail = await readThoughtDetailRows({ client: database, accountId }, "closure-root");
  assert.equal(detail.length, 601);
  const keys = read.value.map(row => row.objectKey);
  const batched = await uow.run({ commandId: "thought.long-tree.batch" }, ports => ports.objects.findMany(keys));
  assert.equal(batched.value.length, 601);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id,object_key,collection,kind,id,parent_key,field,position,
      child_fields,content,status,author_type,version,payload
    )
    SELECT $1,jsonb_build_array('thoughts','closure-root','remarks','remark-'||n)::text,
      'thoughts','remark','remark-'||n,$2,'remarks',NULL,'[]','','ready','user',1,
      jsonb_build_object('id','remark-'||n,'text','超限备注','version',1)
    FROM generate_series(601,5000) n
  `, [accountId, rootKey]);
  await assert.rejects(uow.run({ commandId: "thought.too-large.read" },
    ports => ports.objects.findTree([rootKey])), /object tree limit/);
  await assert.rejects(readThoughtDetailRows({ client: database, accountId }, "closure-root"),
    { code: "THOUGHT_DETAIL_TOO_LARGE" });
  await database.query(`DELETE FROM for_now.store_objects
    WHERE account_id=$1 AND parent_key=$2 AND (substring(id FROM 8))::integer>600`,
  [accountId, rootKey]);
}

/** 十倍无关对象与关系增长下，用真实原语检查 RLS、计划扫描和必要闭包。 @since unreleased */
export async function runThoughtClosurePostgresChecks(database: QueryClient) {
  await seed(database);
  await grow(database, 1, 1000);
  const baseline = await measure(database);
  await grow(database, 1001, 10000);
  const scaled = await measure(database);
  assert.equal(scaled.length, baseline.length);
  for (let index = 0; index < baseline.length; index++) {
    assert.ok(scaled[index].scanned <= baseline[index].scanned + 10,
      JSON.stringify({ baseline: baseline[index], scaled: scaled[index] }));
    assert.ok(scaled[index].buffers <= baseline[index].buffers * 2 + 10,
      JSON.stringify({ baseline: baseline[index], scaled: scaled[index] }));
  }
  await longTree(database);
  console.log("THOUGHT_CLOSURE_SCALE " + JSON.stringify({ objects: [4009, 40009], baseline, scaled }));
}

/** 同一目标真实关联历史超过 SQL 参数批量时，领域编辑仍可提交且失败原子回滚。 @since unreleased */
export async function runThoughtRelatedHistoryChecks({
  database, repo, service
}: {
  database: QueryClient;
  repo: { update<T>(operation: (store: RecordStore) => T): Promise<T> };
  service: { addRemark(input: { id: string; text: string }): Promise<unknown> };
}) {
  const owner = "thought-producer-test";
  const taskIds = Array.from({ length: 600 }, (_, index) => `related-history-${index}`);
  await repo.update(store => {
    store.aiTasks.push(...taskIds.map(id => ({
      id,
      kind: "thoughtAnswer",
      resourceType: "thought",
      targetId: "producer-root",
      status: "succeeded",
      version: 1,
      internal: true,
      createdAt: "2026-10-17T00:00:00.000Z"
    })));
  });
  const history = async () => (await database.query(`SELECT object_key,version,payload
    FROM for_now.store_objects WHERE account_id=$1 AND id=ANY($2::text[]) ORDER BY object_key`,
  [owner, taskIds])).rows;
  const before = await history();
  await service.addRemark({ id: "producer-root", text: "六百条关联历史仍可编辑" });
  assert.deepEqual(await history(), before, "completed related tasks must not be rewritten");
  const snapshot = async () => {
    const state: Record<string, unknown> = {};
    for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
      "store_attachment_refs", "resource_lifecycle", "thought_chain_index", "thought_tag_counts",
      "record_changes", "account_sync_heads", "idempotency_ledger"]) {
      state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
        WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [owner])).rows;
    }
    return state;
  };
  const committed = await snapshot();
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_related_history_failure
    CHECK(command_id <> 'thought.remark.create') NOT VALID`);
  try {
    await assert.rejects(service.addRemark({ id: "producer-root", text: "关联历史失败不保存" }),
      /injected_related_history_failure/);
    assert.deepEqual(await snapshot(), committed);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_related_history_failure");
  }
  console.log("Thought related-history PostgreSQL passed: 600 completed target tasks, edit committed, tasks preserved, commit failure fully atomic.");
}
