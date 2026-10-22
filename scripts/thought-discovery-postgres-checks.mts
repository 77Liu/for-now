/**
 * 发现状态三个公开入口的 PostgreSQL 原子性与版本隔离验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户；正式状态命令禁止账户文档读写。
 */
import assert from "node:assert/strict";
import type { RecordStore } from "../src/shared/persistence/record-command-types.mjs";
import type { SqlClient } from "../src/modules/thoughts/query-contracts.mjs";

type Action = "markRead" | "snooze" | "clearSnooze";
type Result = {
  missing?: boolean;
  versionConflict?: boolean;
  code?: string;
  value?: { status: Record<string, unknown> };
};
type Options = { expectedVersion: number };
type Discovery = {
  markRead(id: string, options: Options): Promise<Result>;
  snooze(id: string, until: string, options?: Options): Promise<Result>;
  clearSnooze(id: string, options: Options): Promise<Result>;
  search(input: { query: string; freshOnly: boolean }): Promise<{ items: { id: string }[] }>;
};
type Context = {
  database: SqlClient;
  repo: { update(operation: (store: RecordStore) => void): Promise<unknown> };
  queries: { detail(id: string): Promise<{ version?: number } | null> };
};
type IndexRow = {
  source_version: number;
  projection_version: string;
  summary: unknown;
  search_text: string;
  tags: string[];
  discovery_status: Record<string, unknown>;
};
const accountId = "thought-producer-test";
const rootId = "discovery-producer-root";
const timestamp = "2026-10-19T00:00:00.000Z";
const until = "2026-10-20T00:00:00.000Z";

async function snapshot(database: SqlClient) {
  const state: Record<string, unknown> = {};
  for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
    "store_attachment_refs", "resource_lifecycle", "thought_chain_index", "thought_tag_counts",
    "record_changes", "account_sync_heads", "idempotency_ledger"]) {
    state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return state;
}

async function failure(database: SqlClient, commandId: string, invoke: () => Promise<unknown>) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_discovery_failure
    CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(invoke(), /injected_discovery_failure/);
    assert.deepEqual(await snapshot(database), before, commandId);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_discovery_failure");
  }
}

async function current(database: SqlClient): Promise<IndexRow> {
  return (await database.query<IndexRow>(`SELECT source_version, projection_version, summary, search_text,
    tags, discovery_status FROM for_now.thought_chain_index
    WHERE account_id=$1 AND root_id=$2`, [accountId, rootId])).rows[0];
}

async function commandMatrix(database: SqlClient, discovery: Discovery, action: Action,
  previousVersion: number, expected: Record<string, unknown>) {
  const invoke = (id = rootId, version = previousVersion) => action === "snooze"
    ? discovery.snooze(id, until, { expectedVersion: version })
    : discovery[action](id, { expectedVersion: version });
  await failure(database, `thought.discovery.${action}`, () => invoke());
  const before = await snapshot(database);
  assert.equal((await invoke("missing-discovery-root")).missing, true);
  assert.equal((await invoke(rootId, previousVersion - 1)).versionConflict, true);
  assert.deepEqual(await snapshot(database), before, "missing and old version must not write");
  const indexBefore = await current(database);
  const result = await invoke();
  assert.ok(result.value);
  assert.equal(result.value.status.version, previousVersion + 1);
  for (const [field, value] of Object.entries(expected)) assert.equal(result.value.status[field], value);
  const indexAfter = await current(database);
  for (const field of ["source_version", "summary", "search_text", "tags"] as const) {
    assert.deepEqual(indexAfter[field], indexBefore[field], `${action} must preserve ${field}`);
  }
  assert.equal(Number(indexAfter.projection_version), Number(indexBefore.projection_version) + 1);
  assert.equal(indexAfter.discovery_status.version, previousVersion + 1);
  const change = (await database.query(`SELECT command_id, entity_type, entity_id,
    entity_version, operation, changed_fields FROM for_now.record_changes
    WHERE account_id=$1 ORDER BY cursor DESC, ordinal DESC LIMIT 1`, [accountId])).rows[0];
  assert.deepEqual(change, {
    command_id: `thought.discovery.${action}`, entity_type: "thoughtDiscovery",
    entity_id: rootId, entity_version: previousVersion + 1,
    operation: "update", changed_fields: ["discovery"]
  });
  const after = await snapshot(database);
  assert.equal((await invoke()).versionConflict, true);
  assert.deepEqual(await snapshot(database), after, "repeated stale status must not write");
}

/** 使用正式发现服务验证公开状态 command 及同事务索引维护。 @since unreleased */
export async function runThoughtDiscoveryPostgresChecks(context: Context, service: { discovery: Discovery }) {
  const { database, repo, queries } = context;
  await repo.update(store => {
    store.thoughts.push({
      id: rootId, type: "question", content: "发现生产者问题", tags: ["发现专用标签"],
      version: 7, createdAt: timestamp, occurredAt: timestamp, occurredOn: "2026-10-19",
      annotations: [], annotationDrift: [], remarks: [], followUps: []
    }, {
      id: "discovery-producer-answer", type: "answer", relatedTo: rootId,
      content: "未读模型原答", modelDraft: "未读模型原答", origin: "deepseek",
      authorType: "ai", version: 1, createdAt: timestamp
    });
  });
  const discovery = service.discovery;
  const tagsBefore = (await database.query(`SELECT tag, uses FROM for_now.thought_tag_counts
    WHERE account_id=$1 ORDER BY tag`, [accountId])).rows;
  const original = await current(database);
  assert.equal(original.discovery_status.fresh, true);
  assert.equal((await discovery.search({ query: "发现生产者", freshOnly: true })).items[0]?.id, rootId);
  await commandMatrix(database, discovery, "snooze", 1, { snoozed: true, fresh: false, read: false });
  assert.equal((await discovery.search({ query: "发现生产者", freshOnly: true })).items.length, 0);
  await commandMatrix(database, discovery, "clearSnooze", 2, { snoozed: false, fresh: true, read: false });
  assert.equal((await discovery.search({ query: "发现生产者", freshOnly: true })).items[0]?.id, rootId);
  await commandMatrix(database, discovery, "markRead", 3, { read: true, fresh: false });
  assert.equal((await discovery.search({ query: "发现生产者", freshOnly: true })).items.length, 0);
  const beforeInvalid = await snapshot(database);
  for (const value of ["invalid-time", timestamp]) {
    assert.equal((await discovery.snooze(rootId, value)).code, "INVALID_SNOOZE_UNTIL");
  }
  assert.deepEqual(await snapshot(database), beforeInvalid);
  assert.equal((await queries.detail(rootId))?.version, 7, "viewing must not invalidate answer inputs");
  assert.deepEqual((await database.query(`SELECT tag, uses FROM for_now.thought_tag_counts
    WHERE account_id=$1 ORDER BY tag`, [accountId])).rows, tagsBefore);
  console.log("Discovery producer PostgreSQL matrix passed: markRead/snooze/clearSnooze, commit failures atomic, conflicts and invalid input no-write, root version and tag counts preserved.");
}

type Request = (base: string, route: string, options: {
  method?: string; cookie: string; body?: unknown; headers?: Record<string, string>;
}) => Promise<{ status: number; body: {
  items?: { id: string; type: string }[];
  data?: { status: { version: number; read: boolean; snoozed: boolean } };
} }>;

/** 验证正式 HTTP 装配、发现状态 If-Match 及跨账户拒绝。 @since unreleased */
export async function runThoughtDiscoveryHttpChecks({
  base, request, cookie, otherCookie
}: { base: string; request: Request; cookie: string; otherCookie: string }) {
  const created = await request(base, "/api/thought-chains", {
    method: "POST", cookie,
    body: { question: "HTTP 发现状态问题", clientRequestId: "http-discovery-root" }
  });
  assert.equal(created.status, 201);
  const root = created.body.items?.find(item => item.type === "question");
  assert.ok(root);
  const route = `/api/v1/thought-chains/${root.id}/discovery`;
  for (const [index, action] of ["snooze", "clearSnooze", "read"].entries()) {
    const options = {
      method: "PATCH", cookie, headers: { "if-match": `"${index + 1}"` },
      body: { action, ...(action === "snooze" ? { until: "2099-01-01T00:00:00.000Z" } : {}) }
    };
    assert.equal((await request(base, route, { ...options, cookie: otherCookie })).status, 404);
    const result = await request(base, route, options);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data?.status.version, index + 2);
    assert.equal(result.body.data?.status.snoozed, action === "snooze");
    assert.equal(result.body.data?.status.read, action === "read");
    assert.equal((await request(base, route, options)).status, 412);
  }
  console.log("Discovery HTTP passed: three actions, stale If-Match rejected, foreign account hidden.");
}
