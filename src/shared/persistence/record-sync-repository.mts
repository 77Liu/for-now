/**
 * Record-level sync head, retained change page and bounded cleanup primitives.
 * Created: 2026-10-19
 * Status: active
 */
import type { QueryClient } from "./account-unit-of-work.mjs";

export type RecordSyncContext = {
  client: QueryClient;
  accountId: string;
};
export type StoredRecordChange = {
  cursor: number;
  ordinal: number;
  commandId: string;
  entityType: string;
  entityId: string;
  parentType: string | null;
  parentId: string | null;
  version: number;
  operation: "create" | "update" | "delete";
  changedFields: string[];
  scopeKeys: string[];
  summary: Record<string, unknown> | null;
  createdAt: string;
};
export type RecordChangePage = {
  fromCursor: number;
  nextCursor: number;
  highWaterCursor: number;
  oldestCursor: number;
  hasMore: boolean;
  oversized: boolean;
  rows: StoredRecordChange[];
};

const syncProblem = (
  message: string,
  code: string,
  statusCode: number,
  details: Record<string, unknown>
) => Object.assign(new Error(message), { code, statusCode, details });

function integer(value: unknown, name: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`Record sync ${name} is invalid`);
  }
  return parsed;
}

function validateCursor(after: number, highWaterCursor: number, oldestCursor: number): void {
  if (after > highWaterCursor) {
    throw syncProblem("同步游标领先于服务器", "SYNC_CURSOR_AHEAD", 409, {
      currentCursor: highWaterCursor
    });
  }
  if (after < oldestCursor - 1) {
    throw syncProblem("同步游标已过期，需要恢复当前范围", "SYNC_CURSOR_EXPIRED", 410, {
      currentCursor: highWaterCursor,
      oldestCursor,
      rebaseRequired: true
    });
  }
}

export function assembleRecordChangePage({
  after,
  highWaterCursor,
  oldestCursor,
  limit,
  rows
}: {
  after: number;
  highWaterCursor: number;
  oldestCursor: number;
  limit: number;
  rows: StoredRecordChange[];
}): RecordChangePage {
  const normalizedAfter = integer(after, "cursor");
  const highWater = integer(highWaterCursor, "high-water cursor");
  const oldest = integer(oldestCursor, "oldest cursor", 1);
  const maximum = integer(limit, "batch limit", 1);
  validateCursor(normalizedAfter, highWater, oldest);
  const ordered = [...rows].sort((left, right) => (
    left.cursor - right.cursor || left.ordinal - right.ordinal
  ));
  const groups = new Map<number, StoredRecordChange[]>();
  for (const row of ordered) {
    const group = groups.get(row.cursor) || [];
    group.push(row);
    groups.set(row.cursor, group);
  }
  if ((groups.values().next().value?.length || 0) > maximum) {
    return {
      fromCursor: normalizedAfter,
      nextCursor: normalizedAfter,
      highWaterCursor: highWater,
      oldestCursor: oldest,
      hasMore: highWater > normalizedAfter,
      oversized: true,
      rows: []
    };
  }
  const selected: StoredRecordChange[] = [];
  let selectedCursor = normalizedAfter;
  for (const [cursor, group] of groups) {
    if (selected.length + group.length > maximum) break;
    selected.push(...group);
    selectedCursor = cursor;
  }
  return {
    fromCursor: normalizedAfter,
    nextCursor: selectedCursor,
    highWaterCursor: highWater,
    oldestCursor: oldest,
    hasMore: selectedCursor < highWater,
    oversized: false,
    rows: selected
  };
}

function rowValue(value: Record<string, unknown>): StoredRecordChange {
  const operation = String(value.operation);
  if (!["create", "update", "delete"].includes(operation)) {
    throw new Error("Stored record change operation is invalid");
  }
  return {
    cursor: integer(value.cursor, "stored cursor", 1),
    ordinal: integer(value.ordinal, "stored ordinal"),
    commandId: String(value.commandId || ""),
    entityType: String(value.entityType || ""),
    entityId: String(value.entityId || ""),
    parentType: value.parentType == null ? null : String(value.parentType),
    parentId: value.parentId == null ? null : String(value.parentId),
    version: integer(value.version, "stored version", 1),
    operation: operation as StoredRecordChange["operation"],
    changedFields: Array.isArray(value.changedFields)
      ? value.changedFields.map(String)
      : [],
    scopeKeys: Array.isArray(value.scopeKeys) ? value.scopeKeys.map(String) : [],
    summary: value.summary && typeof value.summary === "object" && !Array.isArray(value.summary)
      ? value.summary as Record<string, unknown>
      : null,
    createdAt: String(value.createdAt || "")
  };
}

export async function readRecordChangePage(
  { client, accountId }: RecordSyncContext,
  { after, limit }: { after: number; limit: number }
): Promise<RecordChangePage> {
  const normalizedAfter = integer(after, "cursor");
  const maximum = integer(limit, "batch limit", 1);
  const highWaterCursor = await readRecordSyncHead({ client, accountId });
  const oldest = (await client.query<{ oldestCursor: string }>(`
    SELECT COALESCE(min(cursor), $2::bigint + 1)::text AS "oldestCursor"
    FROM for_now.record_changes
    WHERE account_id=$1
  `, [accountId, highWaterCursor])).rows[0];
  const oldestCursor = integer(oldest?.oldestCursor || highWaterCursor + 1, "oldest cursor", 1);
  validateCursor(normalizedAfter, highWaterCursor, oldestCursor);
  const result = await client.query<Record<string, unknown>>(`
    WITH cursor_counts AS MATERIALIZED (
      SELECT cursor,count(*)::integer AS row_count
      FROM for_now.record_changes
      WHERE account_id=$1 AND cursor>$2
      GROUP BY cursor
      ORDER BY cursor
      LIMIT $3 + 1
    ), selected AS MATERIALIZED (
      SELECT cursor,row_count,
        sum(row_count) OVER (ORDER BY cursor) AS cumulative_rows,
        row_number() OVER (ORDER BY cursor) AS cursor_rank
      FROM cursor_counts
    )
    SELECT changes.cursor::text AS cursor,changes.ordinal,
      changes.command_id AS "commandId",
      changes.entity_type AS "entityType",changes.entity_id AS "entityId",
      changes.parent_type AS "parentType",changes.parent_id AS "parentId",
      changes.entity_version AS version,changes.operation,
      changes.changed_fields AS "changedFields",changes.scope_keys AS "scopeKeys",
      changes.summary,changes.created_at::text AS "createdAt"
    FROM selected
    JOIN for_now.record_changes changes
      ON changes.account_id=$1 AND changes.cursor=selected.cursor
    WHERE selected.cumulative_rows<=$3 OR selected.cursor_rank=1
    ORDER BY changes.cursor,changes.ordinal
  `, [accountId, normalizedAfter, maximum]);
  return assembleRecordChangePage({
    after: normalizedAfter,
    highWaterCursor,
    oldestCursor,
    limit: maximum,
    rows: result.rows.map(rowValue)
  });
}

export async function readRecordSyncHead(
  { client, accountId }: RecordSyncContext
): Promise<number> {
  const head = (await client.query<{ currentCursor: string }>(`
    SELECT current_cursor::text AS "currentCursor"
    FROM for_now.account_sync_heads
    WHERE account_id=$1
  `, [accountId])).rows[0];
  return integer(head?.currentCursor || 0, "high-water cursor");
}

export async function pruneRecordChanges(
  { client, accountId }: RecordSyncContext,
  { before, retainRows }: { before: string; retainRows: number }
): Promise<number> {
  const maximum = integer(retainRows, "retention rows", 1);
  const result = await client.query(`
    WITH retained AS MATERIALIZED (
      SELECT cursor FROM for_now.record_changes
      WHERE account_id=$1
      ORDER BY cursor DESC,ordinal DESC
      OFFSET $3 LIMIT 1
    )
    DELETE FROM for_now.record_changes changes
    WHERE changes.account_id=$1
      AND (
        changes.created_at<$2::timestamptz
        OR changes.cursor<COALESCE((SELECT cursor FROM retained),0)
      )
  `, [accountId, before, maximum]);
  return Math.max(0, Number(result.rowCount) || 0);
}
