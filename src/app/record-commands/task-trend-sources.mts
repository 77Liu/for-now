/**
 * 趋势实际日期的保守日历索引读取。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：索引只选完整所属根；实际来源日期、许可和指纹仍由压缩领域判定。
 */
import type { ObjectRow } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS, recordKeyBatches } from "../../shared/persistence/record-query-limits.mjs";
import { materialTreeRows } from "./task-material-sources.mjs";
import { TASK_PREPARATION_COLUMNS, type QueryContext } from "./task-preparation.mjs";

/** 日历候选完整分页；不以分页上限截断合法输入池。 @since unreleased */
export async function* taskTrendSourcePages(
  context: QueryContext,
  localDates: string[]
): AsyncGenerator<ObjectRow[]> {
  const { accountId, client } = context;
  const roots = new Set<string>();
  for (const dates of recordKeyBatches([...new Set(localDates)].sort())) {
    let after = "";
    for (;;) {
      const keys = await client.query<{ objectKey: string }>(`
        WITH candidates AS MATERIALIZED (
        SELECT object_key FROM for_now.store_objects
        WHERE account_id = $1
          AND collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes')
          AND source_calendar_last >= $5 AND source_calendar_first <= $6
          AND source_calendar_hints && $3::text[]
          AND object_key > $2
        )
        SELECT object_key AS "objectKey" FROM candidates
        ORDER BY object_key LIMIT $4
      `, [accountId, after, [...dates, "*"], RECORD_QUERY_LIMITS.keyBatch,
        dates[0], dates.at(-1)]);
      if (!keys.rows.length) break;
      const selectedRoots = new Set(keys.rows.map(row => {
        const parts = JSON.parse(row.objectKey) as string[];
        return JSON.stringify(parts.slice(0, 2));
      }).filter(key => !roots.has(key)));
      for (const key of selectedRoots) roots.add(key);
      if (selectedRoots.size) {
        const result = await client.query<ObjectRow>(`
          SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
          WHERE account_id = $1 AND object_key = ANY($2::text[])
        `, [accountId, [...selectedRoots]]);
        yield await materialTreeRows(context, result.rows);
      }
      after = keys.rows.at(-1)!.objectKey;
    }
  }
}

/** 未知时间只读候选元数据与必要父许可；不载入历史正文或无关子树。 @since unreleased */
export async function* taskTrendUnknownPages(context: QueryContext): AsyncGenerator<{
  rows: ObjectRow[];
  ignoredRoots: { resourceType: string; resourceId: string }[];
}> {
  let after = "";
  for (;;) {
    const page = await context.client.query<ObjectRow>(`
      SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
        field, position, '[]'::jsonb AS "childFields", '' AS content, status,
        author_type AS "authorType", version, source_unknown_projection AS payload
      FROM for_now.store_objects
      WHERE account_id = $1 AND source_occurrence_may_be_unknown AND object_key > $2
      ORDER BY object_key LIMIT $3
    `, [context.accountId, after, RECORD_QUERY_LIMITS.keyBatch]);
    if (!page.rows.length) break;
    const rows = new Map(page.rows.map(row => [row.objectKey, row]));
    const parents = [...new Set(page.rows.flatMap(row => row.parentKey ? [row.parentKey] : []))];
    if (parents.length) {
      const result = await context.client.query<ObjectRow>(`
        SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
          field, position, '[]'::jsonb AS "childFields", '' AS content, status,
          author_type AS "authorType", version, source_unknown_projection AS payload
        FROM for_now.store_objects
        WHERE account_id = $1 AND object_key = ANY($2::text[])
      `, [context.accountId, parents]);
      for (const row of result.rows) {
        if (!rows.has(row.objectKey)) rows.set(row.objectKey, row);
      }
    }
    // Metadata parents only authorize children; count each unknown row once.
    const unknownKeys = new Set(page.rows.map(row => row.objectKey));
    const ignoredRoots = [];
    for (const row of rows.values()) {
      if (!unknownKeys.has(row.objectKey)) {
        ignoredRoots.push({
          resourceType: row.collection === "thoughts" ? "thought" : "journal",
          resourceId: row.id
        });
      }
      row.childFields = [...new Set(page.rows.filter(child => child.parentKey === row.objectKey)
        .map(child => child.field))];
    }
    yield { rows: [...rows.values()], ignoredRoots };
    after = page.rows.at(-1)!.objectKey;
  }
}

export type TrendReadRequirements = {
  dates: { timezone: string; localDates: string[] }[];
  presence: { timezone: string; startDate: string; endDate: string }[];
  historicalTasks?: {
    timezone: string;
    startDate?: string;
    promptVersion?: string;
    windowStart?: string;
    windowEnd?: string;
  }[];
};

/** 只读取领域覆盖率或失败替代真正消费的成功历史任务；完整分页。 @since unreleased */
export async function readTrendHistoricalTasks(
  context: QueryContext, requests: NonNullable<TrendReadRequirements["historicalTasks"]>
): Promise<ObjectRow[]> {
  const rows = new Map<string, ObjectRow>();
  for (const request of requests) {
    let after = "";
    for (;;) {
      const page = await context.client.query<ObjectRow>(`
        WITH candidates AS MATERIALIZED (
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND collection = 'aiTasks'
          AND payload->>'kind' = 'recordCompression' AND status = 'succeeded'
          AND payload->'payload'->>'operation' = 'historicalSupplement'
          AND compression_task_timezone = $2
          ${request.windowStart
            ? "AND compression_task_range_start = $3 AND compression_task_range_end = $4"
            : "AND compression_task_prompt_version = $3 AND compression_task_range_start >= $4"}
          AND object_key > $5
        )
        SELECT * FROM candidates
        ORDER BY "objectKey" LIMIT $6
      `, [
        context.accountId, request.timezone,
        request.windowStart || request.promptVersion,
        request.windowEnd || request.startDate, after, RECORD_QUERY_LIMITS.keyBatch
      ]);
      if (!page.rows.length) break;
      for (const row of page.rows) rows.set(row.objectKey, row);
      after = page.rows.at(-1)!.objectKey;
    }
  }
  return [...rows.values()];
}
