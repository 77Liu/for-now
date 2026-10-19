/**
 * 回答资料的回执与证据依赖闭包。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只展开资格 matcher 使用的字段；正文、审计候选池和生产者选材计划不产生依赖。
 */
import type { ObjectRow } from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS } from "../../shared/persistence/record-query-limits.mjs";
import {
  TASK_PREPARATION_COLUMNS, type QueryContext, type TaskPreparationReader
} from "./task-preparation.mjs";
import { MATERIAL_COLLECTIONS, readMaterialSource, type MaterialSourceRef } from "./task-material-sources.mjs";

type JsonObject = Record<string, unknown>;
type Dependencies = {
  parseSourceKey(key: string): MaterialSourceRef | null;
  permissionKeys(rows: ObjectRow[]): string[];
  legacyContext?(context: QueryContext, reader: TaskPreparationReader, purposes: string[]): Promise<void>;
};
const object = (value: unknown): JsonObject | null => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null
);
const list = (value: unknown): JsonObject[] => (
  Array.isArray(value) ? value.flatMap(item => object(item) ? [object(item)!] : []) : []
);

function receiptConsumed(row: ObjectRow) {
  if (row.kind === "annotationExchange" || row.collection === "analyses") return true;
  const item = row.payload;
  return Object.values(MATERIAL_COLLECTIONS).includes(row.collection)
    && (item.authorType === "ai"
      || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item.origin || ""))
      || Boolean(item.modelDraft || item.reasoningContent));
}

function collect(
  rows: ObjectRow[], parseSourceKey: Dependencies["parseSourceKey"]
) {
  const keys = new Set<string>();
  const producerKeys = new Set<string>();
  const refs = new Map<string, MaterialSourceRef>();
  const legacyPurposes = new Set<string>();
  const addRef = (ref: MaterialSourceRef | null) => {
    if (!ref) return;
    const key = JSON.stringify([ref.resourceType, ref.resourceId, ref.rootId || "", ref.targetKey || ""]);
    refs.set(key, ref);
    keys.add(recordObjectKey("evidencePermissions", key));
  };
  const sourceChecks = (value: unknown) => {
    for (const check of list(value)) {
      if (typeof check.sourceKey === "string") addRef(parseSourceKey(check.sourceKey));
    }
  };
  const receiptChecks = (receipt: JsonObject) => {
    sourceChecks(receipt.permissionChecks);
    sourceChecks(receipt.rawSourceChecks);
  };
  const receipt = (value: unknown) => {
    const current = object(value);
    if (!current) return;
    if (current.schemaVersion !== 2) {
      legacyPurposes.add(current.permissionPurpose === "learning" ? "learning" : "context");
      const references = object(current.importanceReferences);
      if (references) receiptChecks(references);
      return;
    }
    receiptChecks(current);
    sourceChecks(current.currentMaterial);
    for (const check of list(current.evidenceChecks)) {
      if (typeof check.evidenceId === "string") keys.add(recordObjectKey("evidenceSources", check.evidenceId));
    }
    for (const dependency of list(current.legacyDependencies)) {
      // v2 matcher 只接受直接的旧回执，不递归展开任意嵌套对象。
      if (dependency.schemaVersion !== 2) receipt(dependency);
    }
  };
  for (const row of rows) {
    if (row.collection === "evidenceSources" || row.collection === "perceptionEvents") {
      const ref = object(row.payload.sourceRef);
      if (typeof ref?.resourceType === "string" && typeof ref.resourceId === "string") {
        addRef(ref as MaterialSourceRef);
      }
      if (row.collection === "evidenceSources") sourceChecks(row.payload.derivedFrom);
    }
    if (!receiptConsumed(row)) continue;
    receipt(row.payload.contextReceipt);
    if (typeof row.payload.sourceTaskId === "string") {
      producerKeys.add(recordObjectKey("aiTasks", row.payload.sourceTaskId));
    }
  }
  return { keys, producerKeys, refs, legacyPurposes };
}

/** 同一只读快照中展开真实依赖；超限由 reader 保留失败并拒绝截断。 @since unreleased */
export async function includeTaskMaterialDependencies(
  context: QueryContext, reader: TaskPreparationReader, dependencies: Dependencies
) {
  const inspected = new Set<string>();
  const visitedSources = new Set<string>();
  const legacyLoaded = new Set<string>();
  for (;;) {
    const fresh = reader.rows().filter(row => !inspected.has(row.objectKey));
    if (!fresh.length) break;
    for (const row of fresh) inspected.add(row.objectKey);
    const { keys, producerKeys, refs, legacyPurposes } = collect(fresh, dependencies.parseSourceKey);
    const missing = [...legacyPurposes].filter(purpose => !legacyLoaded.has(purpose));
    if (missing.length) {
      if (!dependencies.legacyContext) throw new TypeError("Legacy task receipt needs its original projection assembly");
      await dependencies.legacyContext(context, reader, missing);
      for (const purpose of missing) legacyLoaded.add(purpose);
    }
    for (const [key, ref] of refs) {
      if (visitedSources.has(key)) continue;
      visitedSources.add(key);
      await readMaterialSource(context, reader, ref);
      const events = await context.client.query<ObjectRow>(`
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND object_key IN (
          SELECT object_key FROM for_now.store_relations
          WHERE account_id = $1 AND target_key = ANY($2::text[]) AND relation = 'source'
        ) AND collection IN ('perceptionEvents', 'evidenceSources')
          AND payload->'sourceRef'->>'resourceType' = $3
          AND payload->'sourceRef'->>'resourceId' = $4
          AND COALESCE(payload->'sourceRef'->>'rootId', '') = $5
          AND COALESCE(payload->'sourceRef'->>'targetKey', '') = $6
        ORDER BY object_key LIMIT $7
      `, [context.accountId, reader.rows().filter(row => row.id === ref.resourceId
        && row.collection === MATERIAL_COLLECTIONS[ref.resourceType]).map(row => row.objectKey),
        ref.resourceType, ref.resourceId, ref.rootId || "", ref.targetKey || "",
        RECORD_QUERY_LIMITS.closureRows + 1]);
      for (const row of events.rows) reader.include(row);
    }
    await reader.read([...keys]);
    await reader.read([...producerKeys], "producer");
    await reader.read(dependencies.permissionKeys(reader.rows())
      .map(key => recordObjectKey("evidencePermissions", key)));
  }
}
