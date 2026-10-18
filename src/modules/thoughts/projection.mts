/**
 * 思绪当前摘要、标签与索引的领域维护命令；提供专用分批重建。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：在线只刷新实际变更根；事务适配器不解释思绪业务字段。
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵和真实浏览器消费者验收待完成；基础 PG 查询与事务证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
import crypto from "node:crypto";
import type { ObjectRow } from "../../shared/persistence/account-unit-of-work.mjs";
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { ProjectionContext, ThoughtProjection, ThoughtQueryDependencies } from "./query-contracts.mjs";
import { thoughtSearchGrams, THOUGHT_INDEX_SCHEMA } from "./query-contracts.mjs";

const objectColumns = `object_key AS "objectKey", collection, kind, id,
  parent_key AS "parentKey", field, position, child_fields AS "childFields",
  content, status, author_type AS "authorType", version, payload,
  lifecycle, tombstone, deleted_at AS "deletedAt"`;
const unavailable = () => Object.assign(new Error("思绪索引尚未就绪，请稍后重试"), {
  statusCode: 503, code: "THOUGHT_INDEX_UNAVAILABLE"
});

/** 按单根身份读取完整必要对象树；超大链显式拒绝，不退回账户读取。 @since unreleased */
export async function readThoughtDetailRows(context: ProjectionContext, rootId: string): Promise<ObjectRow[]> {
  const { client, accountId } = context;
  const roots = await client.query<ObjectRow>(`
    SELECT ${objectColumns} FROM for_now.store_objects
    WHERE account_id=$1 AND object_key=$2 AND payload->>'type'='question'
  `, [accountId, JSON.stringify(["thoughts", rootId])]);
  if (!roots.rows.length) return [];
  const result = await client.query<ObjectRow>(`
    WITH RECURSIVE owned AS (
      SELECT source.* FROM for_now.store_objects source
      WHERE source.account_id=$1 AND source.object_key IN (
        SELECT object_key FROM for_now.store_relations WHERE account_id=$1
          AND relation='thoughtRoot' AND target_key=$2
        UNION ALL SELECT $2
      )
      UNION ALL
      SELECT child.* FROM for_now.store_objects child
      JOIN owned parent ON child.parent_key=parent.object_key
      WHERE child.account_id=$1 AND child.collection='thoughts'
    )
    SELECT ${objectColumns} FROM owned LIMIT 5001
  `, [accountId, JSON.stringify(["thoughts", rootId])]);
  if (result.rows.length > 5000) throw Object.assign(unavailable(), { code: "THOUGHT_DETAIL_TOO_LARGE" });
  return result.rows;
}

async function affectedRoots(context: ProjectionContext, rows: ObjectRow[]): Promise<string[]> {
  const roots = new Set<string>();
  const topIds = new Set<string>();
  const current = new Map<string, ObjectRow>();
  for (const row of rows) {
    if (row.collection !== "thoughts") continue;
    if (!row.parentKey) {
      current.set(row.id, row);
      roots.add(typeof row.payload.relatedTo === "string" && row.payload.relatedTo ? row.payload.relatedTo : row.id);
    }
    const key: unknown = row.parentKey ? JSON.parse(row.parentKey) : null;
    topIds.add(Array.isArray(key) && typeof key[1] === "string" ? key[1] : row.id);
  }
  const missing = [...topIds].filter(id => !current.has(id));
  if (missing.length) {
    const result = await context.client.query<ObjectRow>(`
      SELECT ${objectColumns} FROM for_now.store_objects
      WHERE account_id=$1 AND object_key=ANY($2::text[])
    `, [context.accountId, missing.map(id => JSON.stringify(["thoughts", id]))]);
    for (const row of result.rows) current.set(row.id, row);
  }
  for (const id of topIds) {
    const relatedTo = current.get(id)?.payload.relatedTo;
    roots.add(typeof relatedTo === "string" && relatedTo ? relatedTo : id);
  }
  return [...roots].sort();
}

async function updateTagCounts(context: ProjectionContext, previous: string[], next: string[]): Promise<void> {
  const { client, accountId } = context;
  const old = new Set(previous), current = new Set(next);
  for (const tag of [...new Set([...old, ...current])].sort()) {
    const delta = Number(current.has(tag)) - Number(old.has(tag));
    if (!delta) continue;
    if (delta > 0) {
      await client.query(`
        INSERT INTO for_now.thought_tag_counts(account_id,tag,uses) VALUES ($1,$2,1)
        ON CONFLICT(account_id,tag) DO UPDATE SET uses=thought_tag_counts.uses+1
      `, [accountId, tag]);
    } else {
      await client.query(`UPDATE for_now.thought_tag_counts SET uses=uses-1 WHERE account_id=$1 AND tag=$2`, [accountId, tag]);
      await client.query(`DELETE FROM for_now.thought_tag_counts WHERE account_id=$1 AND tag=$2 AND uses=0`, [accountId, tag]);
    }
  }
}

/** 创建唯一的思绪投影维护命令，供记录事务和明确登记的兼容生产者共同调用。 @since unreleased
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵和真实浏览器消费者验收待完成；基础 PG 查询与事务证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
export function createThoughtProjection(dependencies: ThoughtQueryDependencies): ThoughtProjection {
  const graph = createThoughtRecordRepository(dependencies);
  const refresh = async (context: ProjectionContext, rootId: string): Promise<void> => {
    const { client, accountId } = context;
    const old = (await client.query<{ tags: string[] }>(`
      SELECT tags FROM for_now.thought_chain_index WHERE account_id=$1 AND root_id=$2 FOR UPDATE
    `, [accountId, rootId])).rows[0];
    const rows = await readThoughtDetailRows(context, rootId);
    const thoughts = graph.rebuildRecordCollections(rows, ["thoughts"]).thoughts;
    const root = thoughts.find(item => item.id === rootId && item.type === "question");
    if (!root) {
      await updateTagCounts(context, old?.tags || [], []);
      await client.query(`DELETE FROM for_now.thought_chain_index WHERE account_id=$1 AND root_id=$2`, [accountId, rootId]);
      return;
    }
    const blocks = thoughts.filter(item => item.relatedTo === rootId);
    const summary = {
      ...dependencies.summary(root, blocks),
      annotationCount: (Array.isArray(root.annotations) ? root.annotations.length : 0)
        + (Array.isArray(root.annotationDrift) ? root.annotationDrift.length : 0),
      followUpCount: Array.isArray(root.followUps) ? root.followUps.length : 0
    };
    const speech = dependencies.speechProjection?.(thoughts) || [];
    const searchText = dependencies.searchText(root, blocks);
    const discovery = dependencies.discoveryProjection?.(thoughts) || null;
    const searchGrams = thoughtSearchGrams([
      searchText, ...(discovery?.search.flatMap(block => block.texts) || [])
    ].join(" "));
    const tags = [...new Set([root, ...blocks].flatMap(item => (
      Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : []
    )).map(tag => tag.trim().slice(0, 30).normalize("NFKC").trim()).filter(Boolean))];
    const occurred = String(root.occurredAt || root.createdAt || "");
    const created = String(root.createdAt || "");
    const digest = crypto.createHash("sha256").update(dependencies.canonicalJson({ summary, searchText, tags, discovery, speech })).digest("hex");
    await client.query(`
      INSERT INTO for_now.thought_chain_index (
        account_id,root_id,source_version,projection_version,index_schema_version,
        occurred_at,created_at,tags,search_text,search_grams,summary,projection_hash,
        discovery_sort_time,discovery_search,discovery_status,speech_sources
      ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)
      ON CONFLICT(account_id,root_id) DO UPDATE SET
        source_version=EXCLUDED.source_version,
        projection_version=thought_chain_index.projection_version+1,
        index_schema_version=EXCLUDED.index_schema_version,
        occurred_at=EXCLUDED.occurred_at,created_at=EXCLUDED.created_at,tags=EXCLUDED.tags,
        search_text=EXCLUDED.search_text,search_grams=EXCLUDED.search_grams,
        summary=EXCLUDED.summary,projection_hash=EXCLUDED.projection_hash,
        discovery_sort_time=EXCLUDED.discovery_sort_time,
        discovery_search=EXCLUDED.discovery_search,discovery_status=EXCLUDED.discovery_status,
        speech_sources=EXCLUDED.speech_sources
      WHERE thought_chain_index.projection_hash IS DISTINCT FROM EXCLUDED.projection_hash
        OR thought_chain_index.index_schema_version<>EXCLUDED.index_schema_version
        OR thought_chain_index.source_version<>EXCLUDED.source_version
    `, [accountId, rootId, Number(root.version) || 1, THOUGHT_INDEX_SCHEMA.version,
      occurred, created, tags, searchText, searchGrams, JSON.stringify(summary), digest,
      discovery?.sortTime || 0, JSON.stringify(discovery?.search || []), JSON.stringify(discovery?.status || {}), JSON.stringify(speech)]);
    await updateTagCounts(context, old?.tags || [], tags);
  };
  return {
    provisionedVersion: rows => rows.some(row => row.collection === "thoughts"
      && row.parentKey === null && row.payload.type === "question") ? 0 : THOUGHT_INDEX_SCHEMA.version,
    async initialize(context) {
      const roots = await context.client.query(`
        SELECT 1 FROM for_now.store_objects WHERE account_id=$1
          AND collection='thoughts' AND parent_key IS NULL AND payload->>'type'='question'
        LIMIT 1
      `, [context.accountId]);
      if (!roots.rows.length) {
        await context.client.query(`
          INSERT INTO for_now.record_projection_status(account_id,schema_version) VALUES ($1,$2)
          ON CONFLICT(account_id) DO NOTHING
        `, [context.accountId, THOUGHT_INDEX_SCHEMA.version]);
      }
    },
    async changed(context, rows) {
      for (const rootId of await affectedRoots(context, rows)) await refresh(context, rootId);
    },
    async rebuild(context, afterRootId = "") {
      // One bounded maintenance batch; the caller starts a new short transaction for the next.
      if (!afterRootId) {
        await context.client.query(`
          INSERT INTO for_now.record_projection_status(account_id,schema_version) VALUES ($1,0)
          ON CONFLICT(account_id) DO UPDATE SET schema_version=0
        `, [context.accountId]);
      }
      const stale = await context.client.query<{ root_id: string }>(`
        SELECT idx.root_id FROM for_now.thought_chain_index idx
        WHERE idx.account_id=$1 AND NOT EXISTS (
          SELECT 1 FROM for_now.store_objects root
          WHERE root.account_id=$1 AND root.object_key='["thoughts",'||to_json(idx.root_id)::text||']'
        ) ORDER BY idx.root_id LIMIT 100
      `, [context.accountId]);
      for (const row of stale.rows) await refresh(context, row.root_id);
      if (stale.rows.length === 100) return { afterRootId, done: false, processed: 0 };
      const roots = await context.client.query<{ id: string }>(`
        SELECT id FROM for_now.store_objects WHERE account_id=$1
          AND collection='thoughts' AND parent_key IS NULL AND payload->>'type'='question'
          AND id>$2 ORDER BY id LIMIT 100
      `, [context.accountId, afterRootId]);
      for (const root of roots.rows) await refresh(context, root.id);
      const done = roots.rows.length < 100;
      if (done) {
        // Explicit maintenance also repairs counters, even if their previous deltas were damaged.
        await context.client.query(`DELETE FROM for_now.thought_tag_counts WHERE account_id=$1`, [context.accountId]);
        await context.client.query(`
          INSERT INTO for_now.thought_tag_counts(account_id,tag,uses)
          SELECT account_id,tag,count(*)::integer FROM for_now.thought_chain_index
          CROSS JOIN LATERAL unnest(tags) tag WHERE account_id=$1 GROUP BY account_id,tag
        `, [context.accountId]);
        await context.client.query(`
          UPDATE for_now.record_projection_status SET schema_version=$2 WHERE account_id=$1
        `, [context.accountId, THOUGHT_INDEX_SCHEMA.version]);
      }
      return { afterRootId: roots.rows.at(-1)?.id || afterRootId, done, processed: roots.rows.length };
    }
  };
}
