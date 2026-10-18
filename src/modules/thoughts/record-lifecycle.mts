/**
 * 思绪内容与回收清单对应的派生生命周期规则。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, RecordTransaction } from "../../shared/persistence/record-command-types.mjs";
import type { LifecycleRow } from "../../shared/persistence/account-unit-of-work.mjs";
import type { TrashEntry } from "./record-contracts.mjs";
const conflict = () => Object.assign(new Error("思绪已变化"), { code: "VERSION_CONFLICT", statusCode: 409 });
const lifecycleType = (row: ObjectRow) => {
  if (row.kind === "thought") {
    return row.payload?.type === "question" ? "thoughtChain" : "thoughtBlock";
  }
  return row.kind === "annotationDrift" ? "annotation" : row.kind;
};
const TRACKED_THOUGHT_LIFECYCLES = new Set([
  "thoughtChain",
  "thoughtBlock",
  "thoughtRemark",
  "thoughtFollowUp",
  "annotation"
]);

function thoughtLifecycleRecords(rows: ObjectRow[], ownerRows: ObjectRow[] = rows) {
  const byKey = new Map(ownerRows.map(row => [row.objectKey, row]));
  const keys = new Map<string, string>();
  const resourceKey = (row: ObjectRow): string => {
    if (keys.has(row.objectKey)) return keys.get(row.objectKey)!;
    const type = lifecycleType(row);
    const parent = row.parentKey ? byKey.get(row.parentKey) : null;
    // Nested identities already carry their owning thought, even in a removed-only slice.
    const owner = parent ? resourceKey(parent) : row.parentKey
      ? `thoughtChain:${JSON.parse(row.parentKey)[1]}`
      : "";
    const key = `${owner ? `${owner}/` : ""}${type}:${row.id}`;
    keys.set(row.objectKey, key);
    return key;
  };
  return rows.flatMap(row => {
    const resourceType = lifecycleType(row);
    if (!TRACKED_THOUGHT_LIFECYCLES.has(resourceType)) return [];
    const createdAt = String(row.payload?.createdAt || "");
    const value: Omit<LifecycleRow, "payload"> = {
      resourceKey: resourceKey(row),
      resourceType,
      resourceId: row.id,
      lifecycle: row.lifecycle === "draft" ? "draft" : "formal",
      state: "active",
      tombstone: false,
      createdAt,
      updatedAt: createdAt,
      deletedAt: "",
      restoredAt: "",
      purgedAt: "",
      trashId: "",
      history: [{ event: "observed", at: createdAt }]
    };
    return [{ ...value, payload: structuredClone(value) }];
  });
}

/** Initializes derived lifecycle entries for this thought closure only. @since unreleased */
export async function ensureThoughtLifecycles(lifecycles: RecordTransaction["lifecycles"], thoughtRows: ObjectRow[]) {
  const expected = thoughtLifecycleRecords(thoughtRows);
  const current = await lifecycles.findByResourceKeys(
    expected.map(row => row.resourceKey)
  );
  const keys = new Set(current.map(row => row.resourceKey));
  for (const row of expected) {
    if (!keys.has(row.resourceKey)) await lifecycles.insert(row);
  }
}

/** Updates only identities removed in this trash operation. @since unreleased */
export async function markThoughtLifecycleDeleted(
  lifecycles: RecordTransaction["lifecycles"],
  thoughtRows: ObjectRow[],
  entry: TrashEntry,
  ownerRows: ObjectRow[] = thoughtRows
) {
  const expected = thoughtLifecycleRecords(thoughtRows, ownerRows);
  const rows = await lifecycles.findByResourceKeys(
    expected.map(row => row.resourceKey)
  );
  for (const row of rows) {
    const history = [...row.history, {
      event: "deleted",
      at: entry.deletedAt,
      trashId: entry.id
    }];
    const next = {
      ...row,
      state: "deleted" as const,
      tombstone: true,
      updatedAt: entry.deletedAt,
      deletedAt: entry.deletedAt,
      restoredAt: "",
      purgedAt: "",
      trashId: entry.id,
      history
    };
    next.payload = {
      ...row.payload,
      state: next.state,
      tombstone: next.tombstone,
      updatedAt: next.updatedAt,
      deletedAt: next.deletedAt,
      restoredAt: next.restoredAt,
      purgedAt: next.purgedAt,
      trashId: next.trashId,
      history
    };
    if (!await lifecycles.update(next)) throw conflict();
  }
}

/** 业务清单恢复成功后，同事务恢复实际重新出现的身份。 @since unreleased */
export async function markThoughtLifecycleRestored(
  lifecycles: RecordTransaction["lifecycles"],
  thoughtRows: ObjectRow[],
  restoredAt: string,
  ownerRows: ObjectRow[] = thoughtRows
) {
  const expected = thoughtLifecycleRecords(thoughtRows, ownerRows);
  const current = await lifecycles.findByResourceKeys(expected.map(row => row.resourceKey));
  for (const row of current) {
    if (row.state === "active") continue;
    const history = [...row.history, { event: "restored", at: restoredAt }];
    const changes = {
      state: "active" as const,
      tombstone: false,
      updatedAt: restoredAt,
      restoredAt,
      purgedAt: "",
      trashId: "",
      history
    };
    if (!await lifecycles.update({
      ...row,
      ...changes,
      payload: { ...row.payload, ...changes }
    })) throw conflict();
  }
}
