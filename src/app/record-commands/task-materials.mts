/**
 * 回答任务的原始选材池与冻结来源只读装配。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：首次逐页遍历完整合法来源池；冻结后只加载计划和当前材料的依赖。
 */
import type { ObjectRow, RecordEntity, RecordStore, StoreMapping } from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS, recordKeyBatches } from "../../shared/persistence/record-query-limits.mjs";
import {
  rebuildTaskCollections, TASK_PREPARATION_COLUMNS,
  type QueryContext, type TaskPreparationReader
} from "./task-preparation.mjs";
import {
  MATERIAL_COLLECTIONS, materialTreeRows, readMaterialPermissions,
  readMaterialSource, type MaterialSourceRef
} from "./task-material-sources.mjs";
import { includeTaskMaterialDependencies } from "./task-material-dependencies.mjs";

type RawMaterial = { sourceKey: string; [key: string]: unknown };
type Dependencies = {
  mapping: StoreMapping;
  legalSources(store: RecordStore, accountId: string): RawMaterial[];
  permissionKeys(store: RecordStore): string[];
  parseSourceKey(key: string): MaterialSourceRef | null;
  trendContext?(context: QueryContext, task: RecordEntity): Promise<unknown>;
  legacyContext?(
    context: QueryContext, reader: TaskPreparationReader, purposes: string[]
  ): Promise<void>;
};

/** 原始账户对象仅在分页内存活；装配 schema 沿用原领域选材规则。 @since unreleased */
export function createTaskMaterialAssembly(dependencies: Dependencies) {
  const { mapping, legalSources, permissionKeys, parseSourceKey } = dependencies;
  const rebuild = (rows: ObjectRow[]) => rebuildTaskCollections(mapping, rows);
  async function candidates(context: QueryContext) {
    const materials = new Map<string, RawMaterial>();
    for (const collection of Object.values(MATERIAL_COLLECTIONS).filter(value => (
      !["userClaims", "modelUnknowns", "analyses"].includes(value)
    ))) {
      let after = "";
      for (;;) {
        const page = await context.client.query<ObjectRow>(`
          SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
          WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
            AND object_key > $3
            AND payload->'contextAllowed' IS DISTINCT FROM 'false'::jsonb
            AND payload->'allowInContext' IS DISTINCT FROM 'false'::jsonb
            AND payload->>'disposition' IS DISTINCT FROM 'discarded'
            AND COALESCE(payload->'deletedAt'
              IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), true)
          ORDER BY object_key LIMIT $4
        `, [context.accountId, collection, after, RECORD_QUERY_LIMITS.keyBatch]);
        if (!page.rows.length) break;
        const store = rebuild(await materialTreeRows(context, page.rows));
        await readMaterialPermissions(context, store, permissionKeys(store));
        for (const material of legalSources(store, context.accountId)) {
          materials.set(material.sourceKey, material);
        }
        after = page.rows.at(-1)!.objectKey;
      }
    }
    return [...materials.values()];
  }
  return async (context: QueryContext, reader: TaskPreparationReader, task: RecordEntity) => {
    const targetRows = reader.rows().filter(row => row.parentKey === null
      && Object.values(MATERIAL_COLLECTIONS).includes(row.collection));
    const thoughtRoots = targetRows.filter(row => row.collection === "thoughts");
    for (const batch of recordKeyBatches(thoughtRoots.map(row => row.objectKey))) {
      const related = await context.client.query<ObjectRow>(`
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND object_key IN (
          SELECT object_key FROM for_now.store_relations
          WHERE account_id = $1 AND target_key = ANY($2::text[]) AND relation = 'thoughtRoot'
        ) ORDER BY object_key LIMIT $3
      `, [context.accountId, batch, RECORD_QUERY_LIMITS.closureRows + 1]);
      targetRows.push(...related.rows);
    }
    for (const row of await materialTreeRows(context, targetRows)) reader.include(row);
    const plan = task.importanceSelectionPlan as { sources?: RawMaterial[] } | undefined;
    const planPermissionKeys = [];
    for (const item of plan?.sources || []) {
      const ref = parseSourceKey(item.sourceKey);
      if (ref) await readMaterialSource(context, reader, ref);
      planPermissionKeys.push(recordObjectKey("evidencePermissions", item.sourceKey));
    }
    await reader.read(planPermissionKeys);
    await includeTaskMaterialDependencies(context, reader, {
      parseSourceKey,
      permissionKeys: rows => permissionKeys(rebuild(rows)),
      legacyContext: dependencies.legacyContext
    });
    const claims = await context.client.query<ObjectRow>(`
      SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
      WHERE account_id = $1 AND collection = 'userClaims'
        AND payload->>'lifecycle' = 'active' AND payload->>'contextAllowed' IS DISTINCT FROM 'false'
      ORDER BY object_key LIMIT $2
    `, [context.accountId, RECORD_QUERY_LIMITS.closureRows + 1]);
    for (const row of claims.rows) reader.include(row);
    const rawMaterials = plan ? legalSources(rebuild(reader.rows()), context.accountId)
      : await candidates(context);
    const scores = plan ? [] : await readScores(context, rawMaterials);
    return {
      taskRawMaterials: rawMaterials,
      importanceScores: scores,
      ...(dependencies.trendContext ? {
        taskRecentTrend: await dependencies.trendContext(context, task)
      } : {})
    };
  };
}

/** 按合法来源精确查询评分索引；保留原顺序以供领域选最新评分。 @since unreleased */
async function readScores(context: QueryContext, materials: RawMaterial[]) {
  if (!materials.length) return [];
  const identities = Object.fromEntries(materials.map(material => [
    material.sourceKey,
    { version: material.version, contentSha256: material.contentSha256 }
  ]));
  const result = await context.client.query<{ payload: unknown[] }>(`
    SELECT COALESCE(jsonb_agg(score.payload ORDER BY score.ordinal), '[]'::jsonb) AS payload
    FROM jsonb_each($2::jsonb) source
    JOIN LATERAL (
      SELECT ordinal, payload FROM for_now.importance_score_index
      WHERE account_id = $1 AND source_key = source.key
        AND source_version = source.value->'version'
        AND content_sha256 = source.value->'contentSha256'
        AND payload->>'accountId' = $1
      OFFSET 0
    ) score ON true
  `, [context.accountId, JSON.stringify(identities)]);
  return result.rows[0]?.payload || [];
}
