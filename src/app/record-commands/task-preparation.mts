/**
 * 后台任务资格与目标的专用只读装配。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：复用受信账户只读事务；认领不加载历史选材池，修订与来源在同一快照读取。
 */
import type { QueryClient } from "../../shared/persistence/account-unit-of-work.mjs";
import type {
  ObjectRow, RecordEntity, RecordStore, StoreMapping
} from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS, recordKeyBatches } from "../../shared/persistence/record-query-limits.mjs";
import { supportsRecordTask } from "./task-transitions.mjs";

export type QueryContext = { client: QueryClient; accountId: string };
type QueryRecords = <Result>(operation: (context: QueryContext) => Promise<Result>) => Promise<Result>;
type Dependencies = {
  queryRecords: QueryRecords;
  mapping: StoreMapping;
  onboardingPermissionKeys(store: RecordStore): string[];
  modelInputHash(store: RecordStore): string;
  materialContext?(
    context: QueryContext,
    reader: TaskPreparationReader,
    task: RecordEntity
  ): Promise<Record<string, unknown>>;
};
type ContextRequest = {
  taskId?: string;
  input?: RecordEntity;
  retryOf?: string;
  clientRequestId?: string;
  materials?: boolean;
  contextGeneratedAt?: string;
};
const targetCollections: Record<string, string> = {
  thought: "thoughts",
  capture: "captures",
  journal: "journals",
  chat: "chats",
  analysis: "analyses",
  book: "books",
  quote: "quotes"
};
export const TASK_PREPARATION_COLUMNS = `
  object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
  field, position, child_fields AS "childFields", content, status,
  author_type AS "authorType", version, payload, lifecycle, tombstone,
  deleted_at AS "deletedAt"
`;

/** 保留实际持久化顺序：旧 position 与无 position 的近期排序均由原映射器决定。 @since unreleased */
export function rebuildTaskCollections(mapping: StoreMapping, rows: ObjectRow[]) {
  return mapping.rebuildStoreObjects({
    fields: [...new Set(rows.map(row => row.collection))].map(field => ({
      field,
      shape: rows.some(row => row.collection === field && JSON.parse(row.objectKey).length === 1)
        ? "object" : "array",
      payload: null
    })),
    objects: rows
  });
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

function createReader(context: QueryContext) {
  const selected = new Map<string, ObjectRow>();
  const attempted = new Set<string>();
  async function read(keys: string[], projection?: "producer") {
    const missing = [...new Set(keys)].filter(key => !attempted.has(key));
    if (attempted.size + missing.length > RECORD_QUERY_LIMITS.closureRows) {
      throw new RangeError("Task preparation closure limit exceeded");
    }
    for (const batch of recordKeyBatches(missing)) {
      const columns = projection === "producer" ? TASK_PREPARATION_COLUMNS.replace(
        "version, payload,",
        `version, jsonb_build_object(
          'id', payload->'id', 'kind', payload->'kind', 'status', payload->'status',
          'targetId', payload->'targetId', 'subtargetId', payload->'subtargetId',
          'resultId', payload->'resultId', 'contextFingerprint', payload->'contextFingerprint',
          'clientRequestId', payload->'clientRequestId',
          'payload', jsonb_build_object('message', payload->'payload'->'message')
        ) AS payload,`
      ) : TASK_PREPARATION_COLUMNS;
      const result = await context.client.query<ObjectRow>(`
        SELECT ${columns} FROM for_now.store_objects
        WHERE account_id = $1 AND object_key = ANY($2::text[])
      `, [context.accountId, batch]);
      for (const key of batch) attempted.add(key);
      for (const row of result.rows) selected.set(row.objectKey, row);
    }
    return keys.flatMap(key => selected.has(key) ? [selected.get(key)!] : []);
  }
  return {
    read,
    include(row: ObjectRow) {
      if (!attempted.has(row.objectKey) && attempted.size >= RECORD_QUERY_LIMITS.closureRows) {
        throw new RangeError("Task preparation closure limit exceeded");
      }
      attempted.add(row.objectKey);
      selected.set(row.objectKey, row);
    },
    rows: () => [...selected.values()]
  };
}
export type TaskPreparationReader = ReturnType<typeof createReader>;

async function readTarget(
  reader: ReturnType<typeof createReader>,
  task: RecordEntity
) {
  const collection = targetCollections[String(task.resourceType)]
    || (["thoughtAnswer", "followUpAnswer"].includes(String(task.kind)) ? "thoughts" : "");
  if (!collection) return;
  const parent = recordObjectKey(collection, String(task.targetId || ""));
  const keys = [parent];
  if (task.kind === "followUpAnswer") {
    keys.push(JSON.stringify([collection, task.targetId, "followUps", task.subtargetId]));
  }
  if (task.kind === "annotationShenji"
    || (task.kind === "contentImageUnderstanding"
      && (task.payload as { targetType?: string } | undefined)?.targetType === "comment")) {
    keys.push(JSON.stringify([collection, task.targetId, "annotations", task.subtargetId]));
    if (task.kind === "contentImageUnderstanding") {
      keys.push(JSON.stringify([collection, task.targetId, "annotationDrift", task.subtargetId]));
    }
  }
  const rows = await reader.read(keys);
  const annotation = rows.find(row => row.kind === "annotation");
  if (task.kind === "annotationShenji") {
    const root = rows.find(row => row.objectKey === parent);
    const permissions = [
      ...(root ? [[
        task.resourceType, root.id,
        ["capture", "journal"].includes(String(task.resourceType)) ? "" : root.id,
        collection === "thoughts" ? `question:${root.id}` : ""
      ]] : []),
      ...(annotation ? [[
        task.resourceType, annotation.id, task.targetId, `annotation:${annotation.id}`
      ]] : [])
    ];
    await reader.read(permissions.map(parts => (
      recordObjectKey("evidencePermissions", JSON.stringify(parts))
    )));
  }
  const match = /^(idea|record|answer|followup-question|followup-answer|reflection|note):(.+)$/
    .exec(String(annotation?.payload.targetKey || ""));
  if (!match) return;
  const [, kind, id] = match;
  const field = kind.startsWith("followup-") ? "followUps"
    : kind === "reflection" ? "reflections" : kind === "note" ? "notes" : "";
  await reader.read([field
    ? JSON.stringify([collection, task.targetId, field, id])
    : recordObjectKey(collection, id)]);
}

/** 装配资格核验 schema；权限和模型输入哈希由现有领域规则提供。 @since unreleased */
export function createTaskPreparationQueries(dependencies: Dependencies) {
  const { queryRecords, mapping, onboardingPermissionKeys, modelInputHash } = dependencies;
  const rebuild = (rows: ObjectRow[]) => rebuildTaskCollections(mapping, rows);
  const readTask = async (taskId: string) => queryRecords(async context => {
    const reader = createReader(context);
    const rows = await reader.read([recordObjectKey("aiTasks", taskId)]);
    return rows[0] ? structuredClone(rows[0].payload) as RecordEntity : null;
  });
  const assemble = async (request: ContextRequest) => queryRecords(async context => {
    const reader = createReader(context);
    const revision = (await context.client.query<{ revision: string }>(`
      SELECT revision::text AS revision FROM for_now.accounts WHERE account_id = $1
    `, [context.accountId])).rows[0]?.revision;
    if (revision === undefined) throw new Error("Task preparation account is not provisioned");
    const identity = request.taskId || request.retryOf;
    const source = identity
      ? (await reader.read([recordObjectKey("aiTasks", identity)]))[0]
      : null;
    const task = (source?.payload as RecordEntity | undefined) || request.input;
    if (!task) return null;
    if (request.clientRequestId) {
      const duplicate = await context.client.query<ObjectRow>(`
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND collection = 'aiTasks'
          AND task_client_request_id = $2 LIMIT 2
      `, [context.accountId, request.clientRequestId]);
      if (duplicate.rows.length > 1) {
        throw Object.assign(new Error("任务请求身份重复，原数据已保留"), {
          code: "ACCOUNT_DATA_INVALID", statusCode: 503
        });
      }
      for (const row of duplicate.rows) reader.include(row);
    }
    if (!supportsRecordTask(task)) {
      const snapshot = rebuild(reader.rows());
      freeze(snapshot);
      return { snapshot, revision };
    }
    await readTarget(reader, task);
    if (task.kind !== "contentImageUnderstanding") {
      await reader.read([JSON.stringify(["onboarding"]), JSON.stringify(["onboardingV2"])]);
      const source = rebuild(reader.rows());
      await reader.read(onboardingPermissionKeys(source)
        .map(key => recordObjectKey("evidencePermissions", key)));
      const inputHash = modelInputHash(rebuild(reader.rows()));
      if (inputHash) {
        const latest = await context.client.query<ObjectRow>(`
          SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
          WHERE account_id = $1 AND collection = 'aiTasks'
            AND kind = 'aiTask' AND payload->>'kind' = 'onboardingClaimExtraction'
            AND payload->>'targetId' = 'onboarding-v2' AND payload->>'inputHash' = $2
          ORDER BY COALESCE(payload->>'createdAt', '') DESC, position ASC NULLS LAST, id LIMIT 1
        `, [context.accountId, inputHash]);
        if (latest.rows[0]) reader.include(latest.rows[0]);
      }
    }
    const materials = request.materials && dependencies.materialContext
      ? await dependencies.materialContext(context, reader, {
          ...task,
          ...(request.contextGeneratedAt ? { contextGeneratedAt: request.contextGeneratedAt } : {})
        })
      : {};
    const snapshot: RecordStore = {
      ...Object.fromEntries(Object.values(targetCollections).map(collection => [collection, []])),
      aiTasks: [],
      evidenceSources: [],
      perceptionEvents: [],
      evidencePermissions: [],
      userClaims: [],
      ...rebuild(reader.rows()),
      ...materials
    };
    freeze(snapshot);
    return { snapshot, revision };
  });
  return Object.freeze({
    readTask,
    claimContext: (taskId: string) => assemble({ taskId }),
    materialContext: (taskId: string, contextGeneratedAt = "") => assemble({
      taskId, materials: true, contextGeneratedAt
    }),
    creationMaterialContext: (input: RecordEntity | null, retryOf = "", contextGeneratedAt = "") => assemble({
      input: input || undefined,
      retryOf,
      materials: true,
      contextGeneratedAt,
      clientRequestId: retryOf ? `retry:${retryOf}` : String(input?.clientRequestId || "")
    }),
    creationContext: (input: RecordEntity | null, retryOf = "") => assemble({
      input: input || undefined,
      retryOf,
      clientRequestId: retryOf ? `retry:${retryOf}` : String(input?.clientRequestId || "")
    })
  });
}
