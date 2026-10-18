/**
 * 真实 PostgreSQL 思绪分页、投影一致性及规模边界验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：由现有隔离 PG 套件注入账户和正式生产服务，不访问生产数据。
 */
import assert from "node:assert/strict";
import type { AccountUnitOfWork } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordEntity, RecordStore } from "../src/shared/persistence/record-command-types.mjs";
import type { SqlClient, ThoughtPageInput, SpeechSourceReceipt } from "../src/modules/thoughts/query-contracts.mjs";
import type { ThoughtQueryRepository, createThoughtQueryRuntime } from "../src/modules/thoughts/query-runtime.mjs";

type QueryRuntime = NonNullable<ReturnType<typeof createThoughtQueryRuntime>>;
type TestRepository = ThoughtQueryRepository & {
  initialize(options: { allowCreate: boolean }): Promise<void>;
  read(): Promise<RecordStore>;
  update<T>(operation: (store: RecordStore) => T): Promise<T>;
  accountUnitOfWork: AccountUnitOfWork;
};
type Context = {
  database: SqlClient;
  repo: TestRepository;
  account<T>(id: string, operation: () => Promise<T>): Promise<T>;
  removeRoot(store: RecordStore, id: string): unknown;
  createQueries(options: { repository: TestRepository; enabled: boolean }): QueryRuntime;
  registerSpeechFixture(): Promise<void>;
  speechAssets(sources: SpeechSourceReceipt[]): Promise<RecordEntity[]>;
  discovery(queries: QueryRuntime | null): {
    search(input?: Record<string, unknown>): Promise<{ items: RecordEntity[]; total: number; nextCursor: string; untracedCount: number }>;
    markRead(id: string): Promise<unknown>;
    snooze(id: string, until: string): Promise<unknown>;
    clearSnooze(id: string): Promise<unknown>;
    openRandomDoor(input?: Record<string, unknown>, options?: { random(): number }): Promise<{ value: RecordEntity; total: number }>;
  };
  legacyPage(thoughts: RecordEntity[], input: ThoughtPageInput & { cursorScope?: string }): { items: RecordEntity[] };
};
const fixture = (index: number): RecordEntity => ({
  id: `paging-${String(index).padStart(5, "0")}`,
  type: "question", content: `第${index}条思绪 中文焦虑成长`,
  version: 1, createdAt: "2026-10-18T12:00:00.000Z",
  occurredAt: "2026-10-18T12:00:00.000Z", occurredOn: "2026-10-18",
  tags: [index % 2 ? "成长" : "工作"], remarks: [], followUps: [],
  annotations: [], annotationDrift: [], disposition: "kept"
});

async function verifyTraversal(context: Context, queries: QueryRuntime) {
  const ids: string[] = [];
  let afterId = "";
  let last = await queries.list({ limit: 20 });
  while (true) {
    const page = afterId ? await queries.list({ afterId, limit: 20 }) : last;
    ids.push(...page.items.map(item => String(item.id)));
    last = page;
    if (!page.nextId) break;
    assert.notEqual(page.nextId, afterId);
    afterId = page.nextId;
  }
  assert.equal(ids.length, 1001);
  assert.equal(new Set(ids).size, 1001);
  assert.deepEqual(ids, Array.from({ length: 1001 }, (_, index) => fixture(1000 - index).id));
  let previous = last;
  const backwards = [...last.items].reverse().map(item => String(item.id));
  while (previous.prevId) {
    previous = await queries.list({ afterId: previous.prevId, direction: "prev" });
    backwards.push(...[...previous.items].reverse().map(item => String(item.id)));
  }
  assert.deepEqual(backwards, [...ids].reverse());
  const first = await queries.list({});
  await assert.rejects(queries.list({ afterId: first.nextId, query: "不同查询" }), { code: "INVALID_CURSOR" });
  await assert.rejects(queries.list({ afterId: first.nextId, tag: "工作" }), { code: "INVALID_CURSOR" });
  await assert.rejects(queries.list({ afterId: first.nextId, sort: "created" }), { code: "INVALID_CURSOR" });
  await assert.rejects(context.account("repo-test", () => queries.list({ afterId: first.nextId })), { code: "INVALID_CURSOR" });
  await assert.rejects(queries.list({ afterId: "broken" }), { code: "INVALID_CURSOR" });
}

async function verifySearchAndDetail(context: Context, queries: QueryRuntime) {
  const stored = await context.repo.read();
  for (const input of [
    { query: "中文焦虑" }, { query: "成" }, { query: "焦虑 成长", tag: "工作" },
    { query: "SQL %_\\ 注入" }, { tag: "成长", sort: "created" as const }
  ]) {
    const page = await queries.list(input);
    const expected = context.legacyPage(stored.thoughts, { ...input, limit: 20 });
    assert.deepEqual(page.items.map(item => item.id), expected.items.map(item => item.id));
  }
  const detail = await queries.detail(fixture(0).id);
  assert.equal(detail?.content, fixture(0).content);
  assert.deepEqual(detail?.blocks, []);
  assert.equal(await queries.detail("missing-root"), null);
  const page = await queries.list({});
  for (const item of page.items) {
    for (const field of ["followUps", "annotations", "reasoningContent", "modelDraft", "contextReceipt", "blocks"]) {
      assert.equal(Object.hasOwn(item, field), false, field);
    }
  }
}

async function verifyAtomicity(context: Context, queries: QueryRuntime) {
  const rootId = fixture(0).id;
  const before = await queries.list({ query: "第0条" });
  const oldDetail = await queries.detail(rootId);
  await assert.rejects(context.repo.accountUnitOfWork.run({ commandId: "thought.projection-rollback" }, async ports => {
    const row = await ports.objects.find(JSON.stringify(["thoughts", rootId]), { lock: true });
    assert.ok(row);
    const payload = { ...row.payload, content: "事务失败不可见", version: row.version + 1 };
    await ports.objects.update({ ...row, content: "事务失败不可见", payload, version: row.version + 1 }, row.version);
    // No ChangeSet is an existing hard transaction error.
  }), /ChangeSet/);
  assert.deepEqual(await queries.detail(rootId), oldDetail);
  assert.deepEqual(await queries.list({ query: "第0条" }), before);
  await context.repo.accountUnitOfWork.run({ commandId: "thought.projection-commit" }, async ports => {
    const row = await ports.objects.find(JSON.stringify(["thoughts", rootId]), { lock: true });
    assert.ok(row);
    const payload = { ...row.payload, content: "原子索引新文本", version: row.version + 1 };
    await ports.objects.update({ ...row, content: "原子索引新文本", payload, version: row.version + 1 }, row.version);
    ports.addChange({ entityType: "thoughtChain", entityId: rootId, version: row.version + 1,
      operation: "update", changedFields: ["content", "version"] });
  });
  assert.equal((await queries.list({ query: "原子索引新文本" })).items[0]?.id, rootId);
  assert.equal((await queries.list({ query: "第0条" })).items.length, 0);
  await context.repo.update(store => {
    const root = store.thoughts.find(item => item.id === rootId)!;
    root.content = "兼容生产者同事务维护";
    root.version = Number(root.version) + 1;
  });
  assert.equal((await queries.list({ query: "兼容生产者" })).items[0]?.id, rootId);
  const committed = await queries.detail(rootId);
  await context.database.query(`ALTER TABLE for_now.thought_tag_counts
    ADD CONSTRAINT injected_projection_failure CHECK(tag <> '投影失败')`);
  try {
    await assert.rejects(context.repo.update(store => {
      const root = store.thoughts.find(item => item.id === rootId)!;
      root.tags = ["投影失败"];
      root.content = "业务行与索引都必须回滚";
      root.version = Number(root.version) + 1;
    }), /injected_projection_failure/);
  } finally {
    await context.database.query(`ALTER TABLE for_now.thought_tag_counts DROP CONSTRAINT injected_projection_failure`);
  }
  assert.deepEqual(await queries.detail(rootId), committed);
  assert.equal((await queries.list({ query: "兼容生产者" })).items[0]?.id, rootId);
  assert.equal((await queries.list({ tag: "投影失败" })).items.length, 0);
}

async function verifyDiscovery(context: Context, queries: QueryRuntime) {
  await context.repo.update(store => {
    store.thoughts.push({ id: "paging-answer", relatedTo: fixture(0).id,
      type: "answer", content: "AI未回看专用答案", modelDraft: "AI未回看专用答案",
      origin: "deepseek", authorType: "ai", version: 1,
      createdAt: "2026-10-18T12:00:00.000Z", annotations: [], remarks: [] });
    store.captures = [{ id: "paging-capture", content: "中文焦虑成长", version: 1,
      createdAt: "2026-10-18T12:00:00.000Z" }];
  });
  const bounded = context.discovery(queries);
  const legacy = context.discovery(null);
  for (const input of [
    { query: "中文", limit: 20 }, { query: "AI未回看", types: ["answer"] },
    { query: "成长", genres: ["thought", "capture"] }, { freshOnly: true },
    { query: "中文", cursor: "", limit: 1 }
  ]) {
    assert.deepEqual(await bounded.search(input), await legacy.search(input));
  }
  const first = await bounded.search({ limit: 20 });
  assert.deepEqual(await bounded.search({ limit: 20, cursor: first.nextCursor }),
    await legacy.search({ limit: 20, cursor: first.nextCursor }));
  for (const ratio of [0, 0.5, 1]) {
    assert.deepEqual(await bounded.openRandomDoor({}, { random: () => ratio }),
      await legacy.openRandomDoor({}, { random: () => ratio }));
  }
  const fresh = () => bounded.search({ freshOnly: true });
  assert.equal((await fresh()).total, 1);
  await bounded.snooze(fixture(0).id, "2026-10-21T00:00:00.000Z");
  assert.equal((await fresh()).total, 0);
  await bounded.clearSnooze(fixture(0).id);
  assert.equal((await fresh()).total, 1);
  const version = (await queries.detail(fixture(0).id))?.version;
  await bounded.markRead(fixture(0).id);
  assert.equal((await fresh()).total, 0);
  assert.equal((await queries.detail(fixture(0).id))?.version, version);
  // A nested child of a non-root block must refresh the actual root projection.
  await context.repo.update(store => {
    const block = store.thoughts.find(item => item.id === "paging-answer")!;
    block.annotations = [{ id: "paging-nested", text: "嵌套批注", version: 1 }];
  });
  assert.deepEqual(await bounded.search({ freshOnly: true }), await legacy.search({ freshOnly: true }));
  const sources = await queries.speechSources([fixture(0).id]);
  const chain = sources.find(source => source.sourceType === "thoughtChain")!;
  assert.ok(chain);
  await context.registerSpeechFixture();
  await context.repo.update(store => {
    const current = { ...chain, id: "paging-speech", ownerHash: "paging-owner",
      attachmentPath: "/attachments/paging.mp3", voice: "test", mimeType: "audio/mpeg",
      createdAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-11-18T00:00:00.000Z" };
    store.speechCache = [current, { ...current, id: "stale-speech", textHash: "outdated" },
      { ...current, id: "other-speech", sourceId: "other-root" }];
  });
  assert.deepEqual((await context.speechAssets(sources)).map(item => item.id), ["paging-speech"]);
}

async function verifyScale(context: Context, queries: QueryRuntime) {
  // Synthetic rows deliberately use the exact committed source/index shapes.
  // They bypass producers only to measure query cost independently of write timing.
  const measure = () => context.repo.queryRecords!(async ({ client, accountId }) => {
    const result = await client.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT root_id FROM for_now.thought_chain_index WHERE account_id=$1
        AND (occurred_at,created_at,root_id)<($2,$2,$3)
      ORDER BY occurred_at DESC,created_at DESC,root_id DESC LIMIT 21
    `, [accountId, "2026-10-18T12:00:00.000Z", "paging-00500"]);
    const plan = result.rows[0]["QUERY PLAN"][0].Plan;
    assert.equal(plan["Actual Rows"], 21);
    assert.match(JSON.stringify(plan), /thought_chain_occurred_idx/u);
    return plan;
  });
  const baseline = await measure();
  await context.database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, parent_key, field, position,
      child_fields, content, status, author_type, version, payload, lifecycle, tombstone, deleted_at
    )
    SELECT mapped.account_id, mapped.object_key, mapped.collection, mapped.kind,
      mapped.id, mapped.parent_key, mapped.field, mapped.position,
      mapped.child_fields, mapped.content, mapped.status, mapped.author_type,
      mapped.version, mapped.payload, mapped.lifecycle, mapped.tombstone, mapped.deleted_at
    FROM for_now.store_objects source CROSS JOIN generate_series(1,9009) n
    CROSS JOIN LATERAL jsonb_populate_record(NULL::for_now.store_objects,to_jsonb(source)||jsonb_build_object(
      'id','scale-'||lpad(n::text,5,'0'),
      'object_key','["thoughts","scale-'||lpad(n::text,5,'0')||'"]',
      'payload',source.payload||jsonb_build_object('id','scale-'||lpad(n::text,5,'0')))) mapped
    WHERE source.account_id='thought-paging-db' AND source.object_key=$1
  `, [JSON.stringify(["thoughts", fixture(1000).id])]);
  await context.database.query(`
    INSERT INTO for_now.thought_chain_index
    SELECT (jsonb_populate_record(NULL::for_now.thought_chain_index,to_jsonb(source)||jsonb_build_object(
      'root_id','scale-'||lpad(n::text,5,'0'),
      'summary',source.summary||jsonb_build_object('id','scale-'||lpad(n::text,5,'0'))))).*
    FROM for_now.thought_chain_index source CROSS JOIN generate_series(1,9009) n
    WHERE source.account_id='thought-paging-db' AND source.root_id=$1
  `, [fixture(1000).id]);
  await context.database.query("ANALYZE for_now.thought_chain_index");
  const scaled = await measure();
  const first = await queries.list({});
  assert.equal(first.items.length, 20);
  assert.equal((await queries.list({ afterId: first.nextId })).items.length, 20);
  console.log("THOUGHT_PAGING_SCALE " + JSON.stringify({ roots: [1001, 10010], baseline, scaled }));
}

/** 注入真实仓库与领域公开入口，验证数据库实现而非自建查询替身。 @since unreleased */
export async function runThoughtDbPagingChecks(context: Context): Promise<QueryRuntime> {
  const { repo, account } = context;
  // One repository installs one projection before all producers begin writing.
  const trace: Array<{ sql: string; rows: number }> = [];
  const tracedRepository: TestRepository = { ...repo,
    queryRecords: operation => repo.queryRecords!(context => operation({ ...context, client: {
      async query<Row>(sql: string, values?: unknown[]) {
        const result = await context.client.query<Row>(sql, values);
        trace.push({ sql, rows: result.rows.length });
        return result;
      }
    } }))
  };
  const queries = context.createQueries({ repository: tracedRepository, enabled: true });
  await account("thought-paging-db", async () => {
    await repo.initialize({ allowCreate: true });
    await repo.update(store => {
      store.thoughts = Array.from({ length: 1001 }, (_, index) => fixture(index));
      store.trash = [];
    });
    trace.length = 0;
    await queries.list({});
    assert.equal(trace.length, 3);
    assert.ok(trace.every(item => item.rows <= 21));
    assert.ok(trace.every(item => !/store_fields|store_relations|resource_lifecycle/u.test(item.sql)));
    assert.ok(trace.find(item => /idx.summary/u.test(item.sql))?.sql.includes("LIMIT"));
    await verifyTraversal(context, queries);
    await verifySearchAndDetail(context, queries);
    await verifyAtomicity(context, queries);
    await verifyDiscovery(context, queries);
    const first = await queries.list({});
    await repo.update(store => {
      store.thoughts.push(fixture(1001));
      context.removeRoot(store, String(first.items.at(-1)?.id));
    });
    const afterDeletion = await queries.list({ afterId: first.nextId });
    assert.equal(afterDeletion.items.length, 20);
    assert.equal(afterDeletion.items[0].id, fixture(980).id);
    await context.database.query(`UPDATE for_now.thought_tag_counts SET uses=99999 WHERE account_id='thought-paging-db'`);
    const rebuilt = await queries.rebuild();
    const mismatches = await context.database.query(`
      SELECT counts.tag FROM for_now.thought_tag_counts counts WHERE account_id='thought-paging-db'
        AND uses<>(SELECT count(*) FROM for_now.thought_chain_index idx
          WHERE idx.account_id=counts.account_id AND idx.tags @> ARRAY[counts.tag])
    `);
    assert.equal(mismatches.rows.length, 0);
    assert.equal(rebuilt.processed, 1001);
    await context.database.query("ANALYZE for_now.thought_chain_index");
    const plans = await repo.queryRecords!(async ({ client, accountId }) => client.query<{ "QUERY PLAN": unknown }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT root_id FROM for_now.thought_chain_index WHERE account_id=$1
      ORDER BY occurred_at DESC,created_at DESC,root_id DESC LIMIT 21
    `, [accountId]));
    assert.match(JSON.stringify(plans.rows), /thought_chain_occurred_idx/u);
    await verifyScale(context, queries);
  });
  console.log("Thought DB paging passed: 1001 next/prev, scope, search parity, bounded DTO/detail, atomicity, legacy producer and explicit rebuild.");
  return queries;
}
