/**
 * 思绪领域数据库 keyset 列表、当前页恢复与按 ID 详情查询。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：查询失败不读取完整账户；游标绑定账户、筛选、索引和协议版本。
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵待完成；查询、事务及桌面浏览器的局部通过证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
import crypto from "node:crypto";
import { THOUGHT_PAGING } from "../../shared/thought-pagination/index.mjs";
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { RecordEntity } from "../../shared/persistence/record-command-types.mjs";
import { readThoughtDetailRows } from "./projection.mjs";
import type { ProjectionContext, ThoughtCursor, ThoughtPageInput, ThoughtPageRow, ThoughtQueryDependencies } from "./query-contracts.mjs";
import { normalizeThoughtSearch, thoughtSearchGrams, THOUGHT_INDEX_SCHEMA } from "./query-contracts.mjs";

const invalidCursor = () => Object.assign(new Error("游标无效或已过期"), { statusCode: 400, code: "INVALID_CURSOR" });
const unavailable = () => Object.assign(new Error("思绪索引尚未就绪，请运行专用回填"), { statusCode: 503, code: "THOUGHT_INDEX_UNAVAILABLE" });
const scopeOf = (accountId: string, query: string, tag: string, sort: string) => crypto.createHash("sha256")
  .update(JSON.stringify([4, THOUGHT_INDEX_SCHEMA, accountId, query, tag, sort])).digest("hex").slice(0, 20);
function decodeCursor(value: string, scope: string): ThoughtCursor | null {
  if (!value) return null;
  if (value.length > THOUGHT_PAGING.maxCursorDecodedLength) throw invalidCursor();
  try {
    const cursor: ThoughtCursor = JSON.parse(value);
    if (cursor.v !== 4 || cursor.scope !== scope || typeof cursor.primary !== "string"
      || typeof cursor.created !== "string" || typeof cursor.id !== "string" || !cursor.id) throw invalidCursor();
    return cursor;
  } catch { throw invalidCursor(); }
}
const cursorOf = (row: ThoughtPageRow, scope: string) => JSON.stringify({
  v: 4, scope, primary: row.primary, created: row.created, id: row.rootId
});

/** Refuses an unfinished or incompatible projection instead of an empty/fallback list. @since unreleased */
export async function assertThoughtIndexReady({ client, accountId }: ProjectionContext) {
  const readiness = await client.query<{ schema_version: number }>(`
    SELECT schema_version FROM for_now.record_projection_status WHERE account_id=$1
  `, [accountId]);
  if (readiness.rows[0]?.schema_version !== THOUGHT_INDEX_SCHEMA.version) throw unavailable();
}

/** SQL 本身施加过滤、唯一 tuple 与 LIMIT；返回独立的轻量摘要页。 @since unreleased */
export async function listThoughtChainsPage(context: ProjectionContext, input: ThoughtPageInput = {}) {
  const { client, accountId } = context;
  const query = normalizeThoughtSearch(input.query || "").slice(0, 200);
  const tag = (input.tag || "").normalize("NFKC").trim().slice(0, 30);
  const sort = input.sort === "created" ? "created" : "occurred";
  const scope = scopeOf(accountId, query, tag, sort);
  const cursor = decodeCursor(input.afterId || "", scope);
  const direction = input.direction || "next";
  if (!["next", "prev"].includes(direction) || (direction === "prev" && !cursor)) {
    throw Object.assign(new Error("分页方向无效"), { statusCode: 400, code: "INVALID_QUERY" });
  }
  await assertThoughtIndexReady(context);
  const limit = Number.isSafeInteger(input.limit) ? Math.min(THOUGHT_PAGING.pageSize, Math.max(1, input.limit!)) : THOUGHT_PAGING.pageSize;
  const primary = sort === "created" ? "created_at" : "occurred_at";
  const operator = direction === "prev" ? ">" : "<";
  const order = direction === "prev" ? "ASC" : "DESC";
  const values: unknown[] = [accountId];
  const conditions = ["idx.account_id=$1", `idx.index_schema_version=${THOUGHT_INDEX_SCHEMA.version}`];
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (tag) conditions.push(`idx.tags @> ARRAY[${parameter(tag)}]::text[]`);
  if (query) {
    const terms = query.split(" ");
    const grams = [...new Set(terms.flatMap(term => thoughtSearchGrams(term)))];
    conditions.push(`idx.search_grams @> ${parameter(grams)}::text[]`);
    for (const term of terms) conditions.push(`position(${parameter(term)} in idx.search_text)>0`);
  }
  if (cursor) {
    conditions.push(`(idx.${primary},idx.created_at,idx.root_id) ${operator}
      (${parameter(cursor.primary)},${parameter(cursor.created)},${parameter(cursor.id)})`);
  }
  const result = await client.query<ThoughtPageRow>(`
    SELECT idx.root_id AS "rootId", idx.${primary} AS primary, idx.created_at AS created,
      idx.source_version AS "sourceVersion", root.version AS "rootVersion", idx.summary
    FROM for_now.thought_chain_index idx
    LEFT JOIN for_now.store_objects root ON root.account_id=idx.account_id
      AND root.object_key='["thoughts",'||to_json(idx.root_id)::text||']'
    WHERE ${conditions.join(" AND ")}
    ORDER BY idx.${primary} ${order},idx.created_at ${order},idx.root_id ${order}
    LIMIT ${parameter(limit + 1)}
  `, values);
  if (result.rows.some(row => row.sourceVersion !== row.rootVersion)) throw unavailable();
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  if (direction === "prev") rows.reverse();
  const first = rows[0], last = rows.at(-1);
  const tags = await client.query<{ tag: string }>(`
    SELECT tag FROM for_now.thought_tag_counts WHERE account_id=$1 AND uses>0 ORDER BY tag LIMIT 100
  `, [accountId]);
  return {
    items: rows.map(row => row.summary),
    nextId: direction === "next"
      ? hasMore && last ? cursorOf(last, scope) : ""
      : last ? cursorOf(last, scope) : input.afterId || "",
    prevId: direction === "prev"
      ? hasMore && first ? cursorOf(first, scope) : ""
      : cursor ? first ? cursorOf(first, scope) : input.afterId || "" : "",
    tags: tags.rows.map(row => row.tag)
  };
}

/** 按账户与 rootId 读取真实详情，不从列表摘要伪造完整对象。 @since unreleased */
export async function getThoughtChainDetail(context: ProjectionContext, rootId: string, dependencies: ThoughtQueryDependencies) {
  const rows = await readThoughtDetailRows(context, rootId);
  if (!rows.length) return null;
  const graph = createThoughtRecordRepository(dependencies);
  return dependencies.detail(graph.rebuildRecordCollections(rows, ["thoughts"]).thoughts, rootId);
}

/** 编辑入口只读取当前内容块的原字段，附属备注和批注仍由链详情读取。 @since unreleased */
export async function getThoughtBlockInput({ client, accountId }: ProjectionContext, blockId: string) {
  const result = await client.query<{ payload: RecordEntity; version: number }>(`
    SELECT payload,version FROM for_now.store_objects
    WHERE account_id=$1 AND object_key=$2 AND collection='thoughts'
      AND parent_key IS NULL AND payload->>'type'<>'question'
  `, [accountId, JSON.stringify(["thoughts", blockId])]);
  const row = result.rows[0];
  return row ? { ...row.payload, version: row.version } : null;
}
