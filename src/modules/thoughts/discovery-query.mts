/**
 * 思绪领域向发现页提供有界候选查询；发现状态由发现领域投影产生。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：复用同一思绪索引和词元机制；不建立跨账户或跨体裁搜索。
 * @partial 本地开发候选；尚未执行生产放量。
 * @partialScope 移动真机与生产查询/延迟观察未验；本地生产者及有界查询证据见阶段 6 正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 隔离 PostgreSQL 与桌面浏览器不能替代生产放量和移动设备证据。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
import type { ObjectRow } from "../../shared/persistence/account-unit-of-work.mjs";
import { RECORD_QUERY_LIMITS } from "../../shared/persistence/record-query-limits.mjs";
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { ProjectionContext, ThoughtDiscoveryInput, ThoughtQueryDependencies } from "./query-contracts.mjs";
import { assertThoughtIndexReady } from "./query.mjs";
import { thoughtSearchGrams, THOUGHT_INDEX_SCHEMA } from "./query-contracts.mjs";

/** 发现列表的文本/类型谓词在数据库执行，只读取选中根的顶层正文块。 @since unreleased */
export async function queryThoughtDiscoveryCandidates(context: ProjectionContext, input: ThoughtDiscoveryInput, dependencies: ThoughtQueryDependencies) {
  const { client, accountId } = context;
  await assertThoughtIndexReady(context);
  if (!dependencies.discoveryProjection) throw new Error("Discovery projection is not installed");
  const values: unknown[] = [accountId, input.types, input.query.normalize("NFKC").toLocaleLowerCase()];
  const fresh = `(idx.discovery_status->>'untraced'='true'
    AND idx.discovery_status->>'read'='false'
    AND (idx.discovery_status->>'snoozedUntil' IS NULL
      OR (idx.discovery_status->>'snoozedUntil')::timestamptz<=to_timestamp($4::double precision/1000)))`;
  values.push(input.now);
  const conditions = ["idx.account_id=$1", "$4::double precision IS NOT NULL", `idx.index_schema_version=${THOUGHT_INDEX_SCHEMA.version}`,
    `EXISTS (SELECT 1 FROM jsonb_array_elements(idx.discovery_search) block
      WHERE block->>'type'=ANY($2::text[]) AND ($3='' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(block->'texts') text WHERE position($3 in text)>0
      )))`];
  if (input.query) {
    values.push(thoughtSearchGrams(input.query));
    conditions.push(`idx.search_grams @> $${values.length}::text[]`);
  }
  if (input.freshOnly) conditions.push(fresh);
  const totals = input.includeTotals === false ? { rows: [{ total: "0", fresh: "0", untraced: "0" }] } : await client.query<{ total: string; fresh: string; untraced: string }>(`
    SELECT count(*) AS total,count(*) FILTER(WHERE ${fresh}) AS fresh,
      count(*) FILTER(WHERE idx.discovery_status->>'untraced'='true') AS untraced
    FROM for_now.thought_chain_index idx WHERE ${conditions.join(" AND ")}
  `, values);
  if (input.before) {
    values.push(input.before.sortTime, input.before.key);
    conditions.push(`(idx.discovery_sort_time,'thought:'||idx.root_id)
      < ($${values.length - 1}::bigint,$${values.length}::text)`);
  }
  values.push(input.limit + 1);
  const selected = await client.query<{ root_id: string; discovery_status: Record<string, unknown>; source_version: number; root_version: number }>(`
    SELECT idx.root_id,idx.discovery_status,idx.source_version,root.version AS root_version
    FROM for_now.thought_chain_index idx
    LEFT JOIN for_now.store_objects root ON root.account_id=idx.account_id
      AND root.object_key='["thoughts",'||to_json(idx.root_id)::text||']'
    WHERE ${conditions.join(" AND ")}
    ORDER BY idx.discovery_sort_time DESC,idx.root_id DESC LIMIT $${values.length}
  `, values);
  if (selected.rows.some(row => row.source_version !== row.root_version)) {
    throw Object.assign(new Error("思绪索引来源版本不一致"), { statusCode: 503, code: "THOUGHT_INDEX_UNAVAILABLE" });
  }
  const rows = selected.rows.slice(0, input.limit);
  const rootKeys = rows.map(row => JSON.stringify(["thoughts", row.root_id]));
  const objects = await client.query<ObjectRow>(`
    SELECT source.object_key AS "objectKey",source.collection,source.kind,source.id,
      source.parent_key AS "parentKey",source.field,source.position,
      '[]'::jsonb AS "childFields",source.content,source.status,
      source.author_type AS "authorType",source.version,source.payload
    FROM for_now.store_objects source WHERE source.account_id=$1 AND source.object_key IN (
      SELECT unnest($2::text[])
      UNION ALL SELECT object_key FROM for_now.store_relations
        WHERE account_id=$1 AND relation='thoughtRoot' AND target_key=ANY($2::text[])
    )
    LIMIT $3
  `, [accountId, rootKeys, RECORD_QUERY_LIMITS.closureRows + 1]);
  if (objects.rows.length > RECORD_QUERY_LIMITS.closureRows) {
    throw Object.assign(new Error("发现候选关联内容过大，请缩小查询范围"), {
      statusCode: 503,
      code: "THOUGHT_DISCOVERY_TOO_LARGE"
    });
  }
  const graph = createThoughtRecordRepository(dependencies);
  return {
    thoughts: graph.rebuildRecordCollections(objects.rows, ["thoughts"]).thoughts,
    status: Object.fromEntries(rows.map(row => [row.root_id, row.discovery_status])),
    hasMore: selected.rows.length > input.limit,
    total: Number(totals.rows[0].total),
    untracedCount: Number(totals.rows[0].fresh),
    totalUntracedCount: Number(totals.rows[0].untraced)
  };
}
