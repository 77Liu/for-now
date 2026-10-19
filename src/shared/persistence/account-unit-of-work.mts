/**
 * 账户记录级短事务、精准行原语、幂等回执与显式 ChangeSet。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：只理解持久化身份、条件行和变化格式，不解释通知、任务、思绪等领域语义。
 */
import { allocatedRecordBusinessId, bindBusinessIdResponse, withRecordBusinessIdTransaction } from "./business-identifiers.mjs";
import { RECORD_QUERY_LIMITS, recordKeyBatches } from "./record-query-limits.mjs";

type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  rowCount: number | null;
};
export type QueryClient = {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
};
export type ObjectRow = {
  objectKey: string;
  collection: string;
  kind: string;
  id: string;
  parentKey: string | null;
  field: string;
  position: number | null;
  childFields: string[];
  content: string;
  status: string;
  authorType: string;
  version: number;
  payload: Record<string, unknown>;
  lifecycle?: "draft" | "formal";
  tombstone?: boolean;
  deletedAt?: string | null;
};
export type RecordChangeDraft = {
  entityType: string;
  entityId: string;
  parentType?: string | null;
  parentId?: string | null;
  version: number;
  operation: "create" | "update" | "delete";
  changedFields: string[];
  scopeKeys?: string[];
  summary?: Record<string, unknown> | null;
};
type Idempotency = {
  scope: string;
  key: string;
  requestHash: string;
  expiresAt: string;
};
export type LifecycleRow = {
  resourceKey: string;
  resourceType: string;
  resourceId: string;
  lifecycle: "draft" | "formal";
  state: "active" | "deleted" | "formalized" | "purged";
  tombstone: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string;
  restoredAt: string;
  purgedAt: string;
  trashId: string;
  history: Record<string, unknown>[];
  payload: Record<string, unknown>;
};
type RunOptions = {
  commandId: string;
  idempotency?: Idempotency | null;
  expectedRevision?: string | null;
};
type Transaction = <Result>(
  operation: (client: QueryClient, accountId: string) => Promise<Result>
) => Promise<Result>;

const MAX_OBJECT_KEYS = RECORD_QUERY_LIMITS.closureRows;
const objectColumns = `
  object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
  field, position, child_fields AS "childFields", content, status,
  author_type AS "authorType", version, payload, lifecycle, tombstone,
  deleted_at AS "deletedAt"
`;
const count = (result: QueryResult) => Math.max(0, Number(result.rowCount) || 0);
const problem = (message: string, code: string, statusCode = 409) => (
  Object.assign(new Error(message), { code, statusCode })
);
const required = (value: unknown, name: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`Record command ${name} is required`);
  return text;
};
const stringList = (value: unknown, name: string) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`Record command ${name} must be a string array`);
  }
  return [...new Set(value.map(item => item.trim()))];
};

function normalizeChange(value: RecordChangeDraft): Required<RecordChangeDraft> {
  const parentType = value.parentType == null ? null : required(value.parentType, "parentType");
  const parentId = value.parentId == null ? null : required(value.parentId, "parentId");
  if ((parentType === null) !== (parentId === null)) {
    throw new TypeError("Record command parent identity must be complete");
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new TypeError("Record command version must be a positive safe integer");
  }
  if (!["create", "update", "delete"].includes(value.operation)) {
    throw new TypeError("Record command operation is invalid");
  }
  const summary = value.summary == null ? null : structuredClone(value.summary);
  if (summary !== null && (typeof summary !== "object" || Array.isArray(summary))) {
    throw new TypeError("Record command summary must be an object");
  }
  return {
    entityType: required(value.entityType, "entityType"),
    entityId: required(value.entityId, "entityId"),
    parentType,
    parentId,
    version: value.version,
    operation: value.operation,
    changedFields: stringList(value.changedFields, "changedFields"),
    scopeKeys: stringList(value.scopeKeys || [], "scopeKeys"),
    summary
  };
}

async function readIdempotency(
  client: QueryClient,
  accountId: string,
  request: Idempotency,
  timestamp: string
) {
  const row = (await client.query<{
    requestHash: string;
    response: unknown;
    expiresAt: string;
  }>(`
    SELECT request_hash AS "requestHash", response, expires_at AS "expiresAt"
    FROM for_now.idempotency_ledger
    WHERE account_id = $1 AND scope = $2 AND idempotency_key = $3
    FOR UPDATE
  `, [accountId, request.scope, request.key])).rows[0];
  if (!row) return undefined;
  if (row.expiresAt && row.expiresAt <= timestamp) {
    await client.query(`
      DELETE FROM for_now.idempotency_ledger
      WHERE account_id = $1 AND scope = $2 AND idempotency_key = $3
    `, [accountId, request.scope, request.key]);
    return undefined;
  }
  if (row.requestHash !== request.requestHash) {
    throw problem("同一请求标识不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
  }
  return structuredClone(row.response);
}

async function insertIdempotency(
  client: QueryClient,
  accountId: string,
  request: Idempotency,
  response: unknown,
  now: string
) {
  await client.query(`
    INSERT INTO for_now.idempotency_ledger(
      account_id, position, scope, idempotency_key, request_hash,
      response, created_at, expires_at, payload
    ) VALUES ($1, NULL, $2, $3, $4, $5::jsonb, $6, $7, '{}'::jsonb)
  `, [
    accountId,
    request.scope,
    request.key,
    request.requestHash,
    JSON.stringify(response ?? null),
    now,
    request.expiresAt
  ]);
}

async function appendChanges(
  client: QueryClient,
  accountId: string,
  commandId: string,
  drafts: Required<RecordChangeDraft>[]
) {
  if (!drafts.length) return null;
  await client.query(`
    INSERT INTO for_now.account_sync_heads(account_id)
    VALUES ($1)
    ON CONFLICT (account_id) DO NOTHING
  `, [accountId]);
  const head = (await client.query<{ cursor: string }>(`
    UPDATE for_now.account_sync_heads
    SET current_cursor = current_cursor + 1
    WHERE account_id = $1
    RETURNING current_cursor::text AS cursor
  `, [accountId])).rows[0];
  if (!head) throw new Error("Record command sync head is missing");
  for (const [ordinal, draft] of drafts.entries()) {
    await client.query(`
      INSERT INTO for_now.record_changes(
        account_id, cursor, ordinal, command_id, entity_type, entity_id,
        parent_type, parent_id, entity_version, operation, changed_fields,
        scope_keys, summary
      ) VALUES (
        $1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10,
        $11::jsonb, $12::jsonb, $13::jsonb
      )
    `, [
      accountId,
      head.cursor,
      ordinal,
      commandId,
      draft.entityType,
      draft.entityId,
      draft.parentType,
      draft.parentId,
      draft.version,
      draft.operation,
      JSON.stringify(draft.changedFields),
      JSON.stringify(draft.scopeKeys),
      draft.summary === null ? null : JSON.stringify(draft.summary)
    ]);
  }
  return head.cursor;
}

function createObjectPort(
  client: QueryClient,
  accountId: string,
  noteWrite: (rows: number) => void,
  noteRead: (rows: number) => void,
  noteObjectChanged: (row: ObjectRow) => void
) {
  const ensureCollection = async (collection: string, shape: "array" | "object" = "array") => {
    const result = await client.query(`
      INSERT INTO for_now.store_fields(account_id, field, shape, payload)
      VALUES ($1, $2, $3, NULL)
      ON CONFLICT (account_id, field) DO NOTHING
    `, [accountId, required(collection, "collection"), shape]);
    noteWrite(count(result));
  };
  const find = async (objectKey: string, { lock = false } = {}) => {
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns}
      FROM for_now.store_objects
      WHERE account_id = $1 AND object_key = $2
      ${lock ? "FOR UPDATE" : ""}
    `, [accountId, required(objectKey, "objectKey")]);
    noteRead(count(result));
    return result.rows[0] ? structuredClone(result.rows[0]) : null;
  };
  const findMany = async (objectKeys: string[], { lock = false } = {}) => {
    const keys = [...new Set(objectKeys.map(key => required(key, "objectKey")))];
    if (!keys.length) return [];
    if (keys.length > MAX_OBJECT_KEYS) throw new RangeError("Record command object key limit exceeded");
    const rows: ObjectRow[] = [];
    for (const batch of recordKeyBatches(keys)) {
      const result = await client.query<ObjectRow>(`
        SELECT ${objectColumns}
        FROM for_now.store_objects
        WHERE account_id = $1 AND object_key = ANY($2::text[])
        ${lock ? "FOR UPDATE" : ""}
      `, [accountId, batch]);
      noteRead(count(result));
      rows.push(...result.rows);
    }
    return structuredClone(rows);
  };
  const findByCollection = async (collection: string, { lock = false } = {}) => {
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns}
      FROM for_now.store_objects
      WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
      ORDER BY COALESCE(payload->>'createdAt', ''), id
      ${lock ? "FOR UPDATE" : ""}
    `, [accountId, required(collection, "collection")]);
    noteRead(count(result));
    return structuredClone(result.rows);
  };
  const findSourceAlternatives = async (objectKeys: string[]) => {
    const rows: ObjectRow[] = [];
    for (const objectKey of new Set(objectKeys)) {
      const parts = JSON.parse(objectKey) as string[];
      const [collection, rootId, field] = parts;
      const id = parts.at(-1);
      const reply = field === "replies" || parts[4] === "replies";
      if (!["annotations", "replies"].includes(field) || !rootId || !id) continue;
      const result = await client.query<ObjectRow>(`
        SELECT ${objectColumns} FROM for_now.store_objects
        WHERE account_id = $1 AND collection = $2 AND id = $3
          AND kind = ANY($4::text[])
          AND object_key::jsonb->>1 = $5
          AND ($6::text IS NULL OR object_key::jsonb->>3 = $6)
        LIMIT 2
      `, [accountId, collection, id,
        reply ? ["annotationReply"] : ["annotation", "annotationDrift"], rootId,
        parts[4] === "replies" ? parts[3] : null]);
      noteRead(count(result));
      if (result.rows.length > 1) {
        throw problem("来源子项身份重复，原数据已保留", "ACCOUNT_DATA_INVALID", 503);
      }
      rows.push(...result.rows);
    }
    return structuredClone(rows);
  };
  const findTrash = async (type: string, resourceId: string, parentId: string | null = null) => {
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns}
      FROM for_now.store_objects
      WHERE account_id = $1 AND collection = 'trash'
        AND trash_type = $2 AND trash_resource_id = $3
        AND ($4::text IS NULL OR trash_parent_id = $4)
      ORDER BY deleted_at DESC, id DESC
      LIMIT 1 FOR UPDATE
    `, [accountId, required(type, "trashType"), required(resourceId, "resourceId"), parentId]);
    noteRead(count(result));
    return result.rows[0] ? structuredClone(result.rows[0]) : null;
  };
  const findAnnotation = async (id: string, owner: { collection: string; id: string } | null = null) => {
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns} FROM for_now.store_objects
      WHERE account_id = $1 AND id = $2 AND kind IN ('annotation', 'annotationDrift')
        AND ($3::text IS NULL OR parent_key = $3)
      LIMIT 2 FOR UPDATE
    `, [accountId, required(id, "annotationId"),
      owner ? JSON.stringify([required(owner.collection, "ownerCollection"), required(owner.id, "ownerId")]) : null]);
    noteRead(count(result));
    if (result.rows.length > 1) {
      throw problem("请指定批注所属的内容记录", "CONTENT_ATTACHMENT_OWNER_REQUIRED");
    }
    return result.rows[0] || null;
  };
  const findTaskRequest = async (field: "clientRequestId" | "retryOf", value: string) => {
    if (!["clientRequestId", "retryOf"].includes(field)) {
      throw new TypeError("Task request selection is invalid");
    }
    const column = field === "clientRequestId" ? "task_client_request_id" : "task_retry_of";
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns} FROM for_now.store_objects
      WHERE account_id = $1 AND collection = 'aiTasks'
        AND ${column} = $2
      LIMIT 2 FOR UPDATE
    `, [accountId, required(value, field)]);
    noteRead(count(result));
    if (result.rows.length > 1) {
      throw problem("任务请求身份重复，原数据已保留", "ACCOUNT_DATA_INVALID", 503);
    }
    return result.rows[0] ? structuredClone(result.rows[0]) : null;
  };
  const findTaskPage = async (statuses: string[], afterId = "") => {
    const selected = stringList(statuses, "taskStatuses");
    const result = await client.query<ObjectRow>(`
      SELECT ${objectColumns} FROM for_now.store_objects
      WHERE account_id=$1 AND collection='aiTasks' AND parent_key IS NULL
        AND status IN ('queued','running','cancelling','waiting_for_user_model')
        AND status=ANY($2::text[]) AND id>$3
      ORDER BY id LIMIT $4
    `, [accountId, selected, afterId, RECORD_QUERY_LIMITS.keyBatch]);
    noteRead(count(result));
    return structuredClone(result.rows);
  };
  const findForLocalDates = async (
    collection: string,
    localDates: string[],
    { runningOnly = false, excludeObjectKeys = [] }: {
      runningOnly?: boolean;
      excludeObjectKeys?: string[];
    } = {}
  ) => {
    const dates = stringList(localDates, "localDates");
    if (!dates.length) return [];
    if (dates.length > RECORD_QUERY_LIMITS.keyBatch || dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      throw new RangeError("Record command local date selection is invalid");
    }
    const result = await client.query<ObjectRow>(`
      WITH selected_keys AS MATERIALIZED (
        SELECT object_key FROM for_now.store_objects
        WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
          AND (NOT $4::boolean OR status = 'running')
          AND NOT object_key = ANY($6::text[])
          AND record_local_date = ANY($3::text[])
        UNION
        SELECT selected_object.object_key
        FROM unnest($3::text[]) selected_date
        JOIN for_now.store_objects selected_object
          ON selected_object.account_id = $1 AND selected_object.collection = $2
          AND selected_object.parent_key IS NULL
          AND (NOT $4::boolean OR selected_object.status = 'running')
          AND NOT selected_object.object_key = ANY($6::text[])
          AND selected_object.record_window_start <= selected_date
          AND selected_object.record_window_end >= selected_date
        LIMIT $5
      )
      SELECT selected_row.* FROM selected_keys
      CROSS JOIN LATERAL (
        SELECT ${objectColumns} FROM for_now.store_objects
        WHERE account_id = $1 AND object_key = selected_keys.object_key
        LIMIT 1 FOR UPDATE
      ) selected_row
    `, [accountId, required(collection, "collection"), dates, runningOnly,
      MAX_OBJECT_KEYS + 1, excludeObjectKeys]);
    noteRead(count(result));
    if (result.rows.length > MAX_OBJECT_KEYS) throw new RangeError("Record command date closure limit exceeded");
    return structuredClone(result.rows);
  };
  const findTree = async (
    objectKeys: string[],
    { lock = false, rootRows = [] }: { lock?: boolean; rootRows?: ObjectRow[] } = {}
  ) => {
    const provided = new Map(rootRows.map(row => [row.objectKey, row]));
    const keys = [...new Set(objectKeys)];
    if (keys.length > MAX_OBJECT_KEYS) throw new RangeError("Record command object tree limit exceeded");
    const roots = [
      ...keys.flatMap(key => provided.has(key) ? [provided.get(key)!] : []),
      ...await findMany(keys.filter(key => !provided.has(key)), { lock })
    ];
    const rows = [...roots];
    const seen = new Set(rows.map(row => row.objectKey));
    let parents = roots.map(row => row.objectKey);
    while (parents.length) {
      const nextParents: string[] = [];
      for (const batch of recordKeyBatches(parents)) {
        const result = await client.query<ObjectRow>(`
          SELECT ${objectColumns}
          FROM for_now.store_objects
          WHERE account_id = $1 AND parent_key = ANY($2::text[])
          LIMIT $3
          ${lock ? "FOR UPDATE" : ""}
        `, [accountId, batch, MAX_OBJECT_KEYS - rows.length + 1]);
        noteRead(count(result));
        const children = result.rows.filter(row => !seen.has(row.objectKey));
        if (rows.length + children.length > MAX_OBJECT_KEYS) {
          throw new RangeError("Record command object tree limit exceeded");
        }
        for (const row of children) seen.add(row.objectKey);
        rows.push(...children);
        nextParents.push(...children.map(row => row.objectKey));
      }
      parents = nextParents;
    }
    return structuredClone(rows);
  };
  const insert = async (row: ObjectRow) => {
    if (allocatedRecordBusinessId(row.id)) {
      const occupied = await client.query(`
        SELECT id FROM for_now.store_objects WHERE account_id=$1 AND id=$2
        UNION ALL
        SELECT resource_id FROM for_now.resource_lifecycle WHERE account_id=$1 AND resource_id=$2
        LIMIT 1
      `, [accountId, row.id]);
      noteRead(count(occupied));
      if (occupied.rows.length) {
        throw problem("业务身份分配暂时失败，请重试", "BUSINESS_ID_COLLISION_EXHAUSTED", 503);
      }
    }
    const result = await client.query(`
      INSERT INTO for_now.store_objects(
        account_id, object_key, collection, kind, id, parent_key, field,
        position, child_fields, content, status, author_type, version,
        payload, lifecycle, tombstone, deleted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15,$16,$17
      )
    `, [
      accountId, row.objectKey, row.collection, row.kind, row.id,
      row.parentKey, row.field, row.position, JSON.stringify(row.childFields),
      row.content, row.status, row.authorType, row.version,
      JSON.stringify(row.payload), row.lifecycle || "formal",
      row.tombstone === true, row.deletedAt || null
    ]);
    noteWrite(count(result));
    if (count(result)) noteObjectChanged(row);
  };
  const update = async (row: ObjectRow, expectedVersion: number) => {
    const result = await client.query(`
      UPDATE for_now.store_objects
      SET child_fields = $4::jsonb, content = $5, status = $6,
        author_type = $7, version = $8, payload = $9::jsonb,
        lifecycle = $10, tombstone = $11, deleted_at = $12
      WHERE account_id = $1 AND object_key = $2 AND version = $3
    `, [
      accountId, row.objectKey, expectedVersion, JSON.stringify(row.childFields),
      row.content, row.status, row.authorType, row.version,
      JSON.stringify(row.payload), row.lifecycle || "formal",
      row.tombstone === true, row.deletedAt || null
    ]);
    noteWrite(count(result));
    if (count(result)) noteObjectChanged(row);
    return count(result) === 1;
  };
  const remove = async (objectKey: string, expectedVersion: number) => {
    const result = await client.query<ObjectRow>(`
      DELETE FROM for_now.store_objects
      WHERE account_id = $1 AND object_key = $2 AND version = $3
      RETURNING ${objectColumns}
    `, [accountId, required(objectKey, "objectKey"), expectedVersion]);
    noteWrite(count(result));
    for (const row of result.rows) noteObjectChanged(row);
    return count(result) === 1;
  };
  return Object.freeze({
    ensureCollection,
    find,
    findMany,
    findSourceAlternatives,
    findByCollection,
    findTrash,
    findAnnotation,
    findTaskRequest,
    findTaskPage,
    findForLocalDates,
    findTree,
    insert,
    update,
    remove
  });
}

function createRelationPort(
  client: QueryClient,
  accountId: string,
  noteWrite: (rows: number) => void,
  noteRead: (rows: number) => void
) {
  const removeForObject = async (objectKey: string) => {
    const result = await client.query(`
      DELETE FROM for_now.store_relations
      WHERE account_id = $1 AND object_key = $2
    `, [accountId, required(objectKey, "objectKey")]);
    noteWrite(count(result));
  };
  const insert = async (row: {
    objectKey: string;
    relation: string;
    targetKey: string | null;
    targetCollection: string;
    targetId: string;
    resolution: "live" | "historical";
  }) => {
    const result = await client.query(`
      INSERT INTO for_now.store_relations(
        account_id, object_key, relation, target_key,
        target_collection, target_id, resolution
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      accountId, row.objectKey, row.relation, row.targetKey,
      row.targetCollection, row.targetId, row.resolution
    ]);
    noteWrite(count(result));
  };
  const findSources = async (
    targetKeys: string[],
    { relation = null, sourceCollection = null, historicalRootId = null, excludeSourceKeys = [] }: {
      relation?: string | null;
      sourceCollection?: string | null;
      historicalRootId?: string | null;
      excludeSourceKeys?: string[];
    } = {}
  ) => {
    const keys = [...new Set(targetKeys.map(key => required(key, "targetKey")))];
    if (!keys.length) return [];
    if (keys.length > MAX_OBJECT_KEYS) throw new RangeError("Record command target key limit exceeded");
    const sources = new Set<string>();
    for (const batch of recordKeyBatches(keys)) {
      const result = await client.query<{ objectKey: string }>(`
        WITH candidates AS (
          SELECT object_key, false AS historical
          FROM for_now.store_relations
          WHERE account_id = $1 AND target_key = ANY($2::text[])
            AND ($3::text IS NULL OR relation = $3)
          UNION ALL
          SELECT relation_row.object_key, true AS historical
          FROM unnest($7::text[], $8::text[]) selected(target_collection, target_id)
          JOIN for_now.store_relations relation_row
            ON relation_row.account_id = $1
            AND relation_row.target_collection = selected.target_collection
            AND relation_row.target_id = selected.target_id
            AND relation_row.resolution = 'historical'
            AND ($3::text IS NULL OR relation_row.relation = $3)
          WHERE $5::text IS NOT NULL
        )
        SELECT DISTINCT candidate.object_key AS "objectKey"
        FROM candidates candidate
        JOIN for_now.store_objects source
          ON source.account_id = $1 AND source.object_key = candidate.object_key
        WHERE ($4::text IS NULL OR source.collection = $4)
          AND NOT candidate.object_key = ANY($9::text[])
          AND (NOT candidate.historical OR (
            source.payload->'sourceRef'->>'rootId' = $5
            OR source.payload->'payload'->'sourceRef'->>'rootId' = $5
            OR (source.collection = 'evidencePermissions'
              AND (source.payload->>'sourceKey')::jsonb->>2 = $5)
            )
          )
        LIMIT $6
      `, [
        accountId,
        batch,
        relation == null ? null : required(relation, "relation"),
        sourceCollection == null ? null : required(sourceCollection, "sourceCollection"),
        historicalRootId == null ? null : required(historicalRootId, "historicalRootId"),
        MAX_OBJECT_KEYS + 1,
        batch.map(key => (JSON.parse(key) as string[])[0]),
        batch.map(key => (JSON.parse(key) as string[]).at(-1)),
        excludeSourceKeys
      ]);
      noteRead(count(result));
      for (const row of result.rows) sources.add(row.objectKey);
      if (sources.size > MAX_OBJECT_KEYS) throw new RangeError("Record command source closure limit exceeded");
    }
    return [...sources];
  };
  const detachTargets = async (targetKeys: string[]) => {
    const keys = [...new Set(targetKeys.map(key => required(key, "targetKey")))];
    if (!keys.length) return;
    if (keys.length > MAX_OBJECT_KEYS) throw new RangeError("Record command target key limit exceeded");
    for (const batch of recordKeyBatches(keys)) {
      const result = await client.query(`
        UPDATE for_now.store_relations
        SET target_key = NULL, resolution = 'historical'
        WHERE account_id = $1 AND target_key = ANY($2::text[])
      `, [accountId, batch]);
      noteWrite(count(result));
    }
  };
  return Object.freeze({ removeForObject, insert, findSources, detachTargets });
}

function createAttachmentPort(
  client: QueryClient,
  accountId: string,
  noteWrite: (rows: number) => void,
  noteRead: (rows: number) => void
) {
  const findMany = async (paths: string[]) => {
    const selected = stringList(paths, "attachmentPaths");
    if (!selected.length) return [];
    if (selected.length > RECORD_QUERY_LIMITS.keyBatch) throw new RangeError("Attachment path limit exceeded");
    const result = await client.query<{
      path: string; state: string; bytes: number | null; sha256: string | null;
    }>(`
      SELECT path, state, bytes, sha256 FROM for_now.attachment_inventory
      WHERE account_id = $1 AND path = ANY($2::text[]) FOR SHARE
    `, [accountId, selected]);
    noteRead(count(result));
    return result.rows;
  };
  const removeForObject = async (objectKey: string) => {
    const result = await client.query(`
      DELETE FROM for_now.store_attachment_refs
      WHERE account_id = $1 AND owner_key = $2
    `, [accountId, required(objectKey, "objectKey")]);
    noteWrite(count(result));
  };
  const insert = async (row: {
    ownerKey: string | null;
    fieldName: string;
    valuePath: string;
    path: string;
  }) => {
    const result = await client.query(`
      INSERT INTO for_now.store_attachment_refs(
        account_id, owner_key, field_name, value_path, path
      ) VALUES ($1,$2,$3,$4,$5)
    `, [accountId, row.ownerKey, row.fieldName, row.valuePath, row.path]);
    noteWrite(count(result));
  };
  return Object.freeze({ removeForObject, insert, findMany });
}

function createLifecyclePort(
  client: QueryClient,
  accountId: string,
  noteWrite: (rows: number) => void,
  noteRead: (rows: number) => void
) {
  const findByResourceKeys = async (resourceKeys: string[]) => {
    const keys = [...new Set(resourceKeys.map(key => required(key, "resourceKey")))];
    if (!keys.length) return [];
    if (keys.length > MAX_OBJECT_KEYS) throw new RangeError("Record command lifecycle limit exceeded");
    const result = await client.query<LifecycleRow>(`
      SELECT resource_key AS "resourceKey", resource_type AS "resourceType",
        resource_id AS "resourceId", lifecycle, state, tombstone,
        created_at AS "createdAt", updated_at AS "updatedAt",
        deleted_at AS "deletedAt", restored_at AS "restoredAt",
        purged_at AS "purgedAt", trash_id AS "trashId", history, payload
      FROM for_now.resource_lifecycle
      WHERE account_id = $1 AND resource_key = ANY($2::text[])
      FOR UPDATE
    `, [accountId, keys]);
    noteRead(count(result));
    return structuredClone(result.rows);
  };
  const findByResourceIds = async (resourceIds: string[]) => {
    const ids = [...new Set(resourceIds.map(id => required(id, "resourceId")))];
    if (!ids.length) return [];
    if (ids.length > MAX_OBJECT_KEYS) throw new RangeError("Record command lifecycle limit exceeded");
    const result = await client.query<LifecycleRow>(`
      SELECT resource_key AS "resourceKey", resource_type AS "resourceType",
        resource_id AS "resourceId", lifecycle, state, tombstone,
        created_at AS "createdAt", updated_at AS "updatedAt",
        deleted_at AS "deletedAt", restored_at AS "restoredAt",
        purged_at AS "purgedAt", trash_id AS "trashId", history, payload
      FROM for_now.resource_lifecycle
      WHERE account_id = $1 AND resource_id = ANY($2::text[])
      FOR UPDATE
    `, [accountId, ids]);
    noteRead(count(result));
    return structuredClone(result.rows);
  };
  const update = async (row: LifecycleRow) => {
    const result = await client.query(`
      UPDATE for_now.resource_lifecycle
      SET lifecycle = $3, state = $4, tombstone = $5, created_at = $6,
        updated_at = $7, deleted_at = $8, restored_at = $9,
        purged_at = $10, trash_id = $11, history = $12::jsonb,
        payload = $13::jsonb
      WHERE account_id = $1 AND resource_key = $2
    `, [
      accountId, row.resourceKey, row.lifecycle, row.state, row.tombstone,
      row.createdAt, row.updatedAt, row.deletedAt, row.restoredAt,
      row.purgedAt, row.trashId, JSON.stringify(row.history),
      JSON.stringify(row.payload)
    ]);
    noteWrite(count(result));
    return count(result) === 1;
  };
  const insert = async (row: LifecycleRow) => {
    const result = await client.query(`
      INSERT INTO for_now.resource_lifecycle(
        account_id, position, resource_key, resource_type, resource_id,
        lifecycle, state, tombstone, created_at, updated_at, deleted_at,
        restored_at, purged_at, trash_id, history, payload
      ) VALUES (
        $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15::jsonb
      )
    `, [
      accountId, row.resourceKey, row.resourceType, row.resourceId,
      row.lifecycle, row.state, row.tombstone, row.createdAt,
      row.updatedAt, row.deletedAt, row.restoredAt, row.purgedAt,
      row.trashId, JSON.stringify(row.history), JSON.stringify(row.payload)
    ]);
    noteWrite(count(result));
  };
  return Object.freeze({ findByResourceKeys, findByResourceIds, update, insert });
}

/**
 * 创建记录级账户 Unit of Work；transaction 必须已绑定受信账户、RLS 与账户锁。
 * @since unreleased
 */
export function createAccountUnitOfWork({
  transaction,
  onCommitted = () => {},
  beforeCommit = async () => {},
  getContext = () => undefined,
  now = () => new Date().toISOString()
}: {
  transaction: Transaction;
  beforeCommit?: (context: { client: QueryClient; accountId: string }, changedRows: ObjectRow[]) => Promise<void>;
  onCommitted?: (event: {
    accountId: string;
    commandId: string;
    cursor: string | null;
  }) => unknown;
  getContext?: () => Record<string, unknown> | undefined;
  now?: () => string;
}) {
  if (typeof transaction !== "function") throw new TypeError("AccountUnitOfWork transaction is required");
  return Object.freeze({
    async readRevision() {
      return transaction(async (client, accountId) => {
        const row = (await client.query<{ revision: string }>(`
          SELECT revision::text AS revision
          FROM for_now.accounts
          WHERE account_id = $1
        `, [accountId])).rows[0];
        if (!row) throw new Error("Record command account is not provisioned");
        return row.revision;
      });
    },
    async run<Result>(
      options: RunOptions,
      operation: (ports: {
        accountId: string;
        objects: ReturnType<typeof createObjectPort>;
        relations: ReturnType<typeof createRelationPort>;
        attachments: ReturnType<typeof createAttachmentPort>;
        lifecycles: ReturnType<typeof createLifecyclePort>;
        addChange: (draft: RecordChangeDraft) => void;
      }) => Promise<Result>
    ) {
      const commandId = required(options?.commandId, "commandId");
      const expectedRevision = options?.expectedRevision == null
        ? null
        : required(options.expectedRevision, "expectedRevision");
      if (expectedRevision !== null && !/^(?:0|[1-9][0-9]*)$/.test(expectedRevision)) {
        throw new TypeError("Record command expectedRevision is invalid");
      }
      if (typeof operation !== "function") throw new TypeError("AccountUnitOfWork operation is required");
      const committed = await transaction(async (client, accountId) => {
        if (expectedRevision !== null) {
          const row = (await client.query<{ revision: string }>(`
            SELECT revision::text AS revision
            FROM for_now.accounts
            WHERE account_id = $1
            FOR UPDATE
          `, [accountId])).rows[0];
          if (!row || row.revision !== expectedRevision) {
            throw problem("账户内容已变化，请重新校验", "VERSION_CONFLICT");
          }
        }
        const idempotency = options.idempotency || null;
        const timestamp = now();
        if (idempotency) {
          const replay = await readIdempotency(client, accountId, idempotency, timestamp);
          if (replay !== undefined) {
            const value = bindBusinessIdResponse(replay as Result, getContext() || {});
            return { accountId, value, replayed: true, cursor: null, changes: [], reads: 1, writes: 0 };
          }
        }
        let reads = 0;
        let writes = 0;
        const changes: Required<RecordChangeDraft>[] = [];
        const changedRows: ObjectRow[] = [];
        const addChange = (draft: RecordChangeDraft) => {
          changes.push(normalizeChange(draft));
        };
        const result = await withRecordBusinessIdTransaction(() => operation({
          accountId,
          objects: createObjectPort(client, accountId,
            rows => { writes += rows; }, rows => { reads += rows; },
            row => changedRows.push(row)),
          relations: createRelationPort(
            client,
            accountId,
            rows => { writes += rows; },
            rows => { reads += rows; }
          ),
          attachments: createAttachmentPort(client, accountId,
            rows => { writes += rows; }, rows => { reads += rows; }),
          lifecycles: createLifecyclePort(
            client,
            accountId,
            rows => { writes += rows; },
            rows => { reads += rows; }
          ),
          addChange
        }));
        const value = bindBusinessIdResponse(result, getContext() || {});
        if ((writes > 0) !== (changes.length > 0)) {
          throw new Error("Record command writes and ChangeSet must be committed together");
        }
        await beforeCommit({ client, accountId }, changedRows);
        if (idempotency) {
          await insertIdempotency(client, accountId, idempotency, value, timestamp);
        }
        const cursor = await appendChanges(client, accountId, commandId, changes);
        if (writes || idempotency) {
          const marked = await client.query(`
            UPDATE for_now.accounts
            SET revision = revision + 1,
              runtime_started_at = COALESCE(runtime_started_at, now())
            WHERE account_id = $1
          `, [accountId]);
          if (count(marked) !== 1) throw new Error("Record command account is not provisioned");
        }
        return { accountId, value, replayed: false, cursor, changes, reads, writes };
      });
      const context = getContext();
      if (context && (committed.writes || options.idempotency)) {
        context.operationCommitted = true;
      }
      if (!committed.replayed && committed.changes.length) {
        try {
          void Promise.resolve(onCommitted({
            accountId: committed.accountId,
            commandId,
            cursor: committed.cursor
          })).catch(() => {});
        } catch {}
      }
      return committed;
    }
  });
}

/** Record transaction contract shared by typed domain repositories. @since unreleased */
export type AccountUnitOfWork = ReturnType<typeof createAccountUnitOfWork>;
export type RecordTransaction = Parameters<Parameters<AccountUnitOfWork["run"]>[1]>[0];
