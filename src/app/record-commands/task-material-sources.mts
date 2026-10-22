/**
 * 任务来源身份、子树和许可的精确读取。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：嵌套身份保留所属根；批注漂移和两种回复坐标复用同一解析。
 */
import type { ObjectRow, RecordEntity, RecordStore } from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS, recordKeyBatches } from "../../shared/persistence/record-query-limits.mjs";
import { TASK_PREPARATION_COLUMNS, type QueryContext, type TaskPreparationReader } from "./task-preparation.mjs";

export type MaterialSourceRef = {
  resourceType: string;
  resourceId: string;
  rootId?: string;
  targetKey?: string;
};
export const MATERIAL_COLLECTIONS: Record<string, string> = {
  capture: "captures",
  journal: "journals",
  thought: "thoughts",
  chat: "chats",
  quote: "quotes",
  keepsake: "keepsakes",
  book: "books",
  checkin: "checkins",
  dailyRecord: "dailyRecords",
  action: "actions",
  habit: "habits",
  habitCheckin: "habitCheckins",
  feedback: "feedback",
  experiment: "experiments",
  customMetric: "customMetrics",
  validationLedger: "validationLedger",
  userClaim: "userClaims",
  modelUnknown: "modelUnknowns",
  analysis: "analyses"
};

/** 依靠目标字段解析身份，不把同名顶层对象当作子项。 @since unreleased */
export async function readMaterialSource(
  context: QueryContext, reader: TaskPreparationReader, ref: MaterialSourceRef
) {
  const collection = MATERIAL_COLLECTIONS[ref.resourceType];
  if (!collection) return;
  const match = /^(remark|followup-question|followup-answer|reflection|note|annotation|annotation-reply):(.+)$/
    .exec(ref.targetKey || "");
  const field = match?.[1] === "remark" ? "remarks"
    : match?.[1].startsWith("followup-") ? "followUps"
      : match?.[1] === "reflection" ? "reflections"
        : match?.[1] === "note" ? "notes"
          : match?.[1] === "annotation" ? "annotations"
            : match?.[1] === "annotation-reply" ? "replies" : "";
  const rootKey = recordObjectKey(collection, ref.rootId || ref.resourceId);
  await reader.read([rootKey]);
  if (!field || !ref.rootId) {
    await reader.read([recordObjectKey(collection, ref.resourceId)]);
    return;
  }
  if (field !== "replies") {
    await reader.read([
      JSON.stringify([collection, ref.rootId, field, ref.resourceId]),
      ...(field === "annotations"
        ? [JSON.stringify([collection, ref.rootId, "annotationDrift", ref.resourceId])] : [])
    ]);
    return;
  }
  const parentId = match![2] === ref.resourceId ? "" : match![2];
  const result = await context.client.query<ObjectRow>(`
    SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
    WHERE account_id = $1 AND collection = $2 AND id = $3 AND field = 'replies'
      AND object_key::jsonb->>1 = $4
      AND ($5 = '' OR object_key::jsonb->>3 = $5)
    LIMIT 2
  `, [context.accountId, collection, ref.resourceId, ref.rootId, parentId]);
  if (result.rows.length > 1) throw new TypeError("Task material reply identity is ambiguous");
  for (const row of result.rows) {
    reader.include(row);
    if (row.parentKey) await reader.read([row.parentKey]);
  }
}

/** 子树按共同闭包上限与 SQL 批量读取，同次访问去重。 @since unreleased */
export async function materialTreeRows(context: QueryContext, roots: ObjectRow[]) {
  const rows = new Map(roots.map(row => [row.objectKey, row]));
  let parents = [...rows.keys()];
  while (parents.length) {
    const next = [];
    for (const batch of recordKeyBatches(parents)) {
      const result = await context.client.query<ObjectRow>(`
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND parent_key = ANY($2::text[])
        ORDER BY object_key LIMIT $3
      `, [context.accountId, batch, RECORD_QUERY_LIMITS.closureRows + 1]);
      for (const row of result.rows) {
        if (rows.has(row.objectKey)) continue;
        rows.set(row.objectKey, row);
        next.push(row.objectKey);
      }
      if (rows.size > RECORD_QUERY_LIMITS.closureRows) {
        throw new RangeError("Task material page closure limit exceeded");
      }
    }
    parents = next;
  }
  return [...rows.values()];
}

/** 许可缺省值只能在实际查询后使用。 @since unreleased */
export async function readMaterialPermissions(
  context: QueryContext, store: RecordStore, keys: string[]
) {
  const rows: ObjectRow[] = [];
  const objectKeys = [...new Set(keys)].map(key => recordObjectKey("evidencePermissions", key));
  for (const batch of recordKeyBatches(objectKeys)) {
    const result = await context.client.query<ObjectRow>(`
      SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
      WHERE account_id = $1 AND object_key = ANY($2::text[])
    `, [context.accountId, batch]);
    rows.push(...result.rows);
  }
  store.evidencePermissions = rows.map(row => row.payload as RecordEntity);
  return rows;
}
