/**
 * 思绪闭包实际变更的完整同步身份与字段差分。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只解释命令前后已加载行；不读取业务仓库。
 */
import type { ObjectRow, RecordTransaction } from "../../shared/persistence/record-command-types.mjs";

const entityType = (row: ObjectRow) => {
  if (row.collection === "thoughts" && row.kind === "thought") {
    return row.payload.type === "question" ? "thoughtChain" : "thoughtBlock";
  }
  return row.kind === "annotationDrift" ? "annotation" : row.kind;
};
function parentIdentity(row: ObjectRow, byKey: Map<string, ObjectRow>) {
  if (row.parentKey) {
    const parent = byKey.get(row.parentKey);
    if (!parent) throw new Error("Changed record parent is outside the command closure");
    return { parentType: entityType(parent), parentId: parent.id };
  }
  if (row.collection === "thoughts" && typeof row.payload.relatedTo === "string") {
    return { parentType: "thoughtChain", parentId: row.payload.relatedTo };
  }
  return { parentType: null, parentId: null };
}
function scopeKeys(row: ObjectRow, rootId: string) {
  if (row.collection === "thoughts") return ["thought:list", `thought:${rootId}`];
  if (row.collection === "aiTasks") return ["task:list", `task:${row.id}`];
  if (row.collection === "notifications") return ["notification:list", `notification:${row.id}`];
  if (row.collection === "trash") return ["trash:list", `trash:${row.id}`];
  return [`${row.collection}:list`];
}
function changedFields(before: ObjectRow | undefined, row: ObjectRow) {
  const previous = before?.payload || {};
  return [...new Set([
    ...Object.keys(previous), ...Object.keys(row.payload),
    ...(before?.version !== row.version ? ["version"] : []),
    ...(JSON.stringify(before?.childFields || []) !== JSON.stringify(row.childFields) ? row.childFields : [])
  ])].filter(field => field === "version"
    || row.childFields.includes(field)
    || JSON.stringify(previous[field]) !== JSON.stringify(row.payload[field]));
}

/** 根据真实行差分生成 ChangeDraft，父身份沿对象图完整解析。 @since unreleased */
export function addThoughtClosureChanges(
  ports: RecordTransaction,
  beforeRows: ObjectRow[],
  afterRows: ObjectRow[],
  rootId: string
) {
  const before = new Map(beforeRows.map(row => [row.objectKey, row]));
  const after = new Map(afterRows.map(row => [row.objectKey, row]));
  for (const row of afterRows) {
    const previous = before.get(row.objectKey);
    if (previous && previous.version === row.version) continue;
    ports.addChange({
      entityType: entityType(row),
      entityId: row.id,
      ...parentIdentity(row, after),
      version: row.version,
      operation: previous ? "update" : "create",
      changedFields: changedFields(previous, row),
      scopeKeys: scopeKeys(row, rootId)
    });
  }
  for (const row of beforeRows) {
    if (after.has(row.objectKey)) continue;
    ports.addChange({
      entityType: entityType(row),
      entityId: row.id,
      ...parentIdentity(row, before),
      version: row.version + 1,
      operation: "delete",
      changedFields: [],
      scopeKeys: scopeKeys(row, rootId)
    });
  }
}
