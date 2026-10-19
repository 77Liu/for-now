/**
 * 声明同步按域投影的实际读取依赖；不表示一份完整业务仓库。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：未知域由仓储在同一快照全读回退，缺失依赖不得当空集合。
 */
import type { StoredRecordChange } from "../shared/persistence/record-sync-repository.mjs";

const insightDomains = new Set(["checkins", "dailyRecords", "captures", "journals", "thoughts", "books", "quotes", "experiments", "analyses"]);
const insightFields = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "quotes", "books", "keepsakes", "analyses"];
// 感知生产者的权限与事件按各自正式normalizer校验；公共投影显式剥离它们，但不能丢弃游标变化。
const internalDomains = ["evidencePermissions", "perceptionEvents"];
const supported = new Set([...insightDomains, ...internalDomains, "journalDraft", "chats", "keepsakes", "customMetrics", "aiTasks", "notifications", "actions", "habits", "habitCheckins", "feedback", "validationLedger", "userClaims", "modelUnknowns", "onboarding", "onboardingV2", "commercialization", "trash", "speechCache"]);

/** 同步域是否要求既有统计与思绪聚类；输出含其全部真实来源。 @since unreleased */
export function syncNeedsInsights(domains: Iterable<string>): boolean {
  return [...domains].some(domain => insightDomains.has(domain));
}

/** 返回投影与规范化的完整字段闭包；内部域保留真实集合参与校验，不进入公共输出。
 * 未知域返回null，明确要求同一快照原完整读取。 @since unreleased
 */
export function syncProjectionFields(domains: string[]): string[] | null {
  if (domains.some(domain => !supported.has(domain))) return null;
  const fields = new Set(["version", ...domains]);
  if (syncNeedsInsights(domains)) for (const field of insightFields) fields.add(field);
  if (fields.has("journalDraft")) fields.add("journals");
  if (fields.has("onboardingV2")) fields.add("onboarding");
  if (fields.has("notifications") || fields.has("aiTasks")) { fields.add("notifications"); fields.add("aiTasks"); }
  if (fields.has("speechCache")) { fields.add("captures"); fields.add("thoughts"); fields.add("trash"); }
  return [...fields];
}

export type SyncEntityIdentity = {
  entityType: "thoughtChain" | "thoughtBlock";
  entityId: string;
  parentType: "thoughtChain" | null;
  parentId: string | null;
};
export type PublicRecordChange = {
  cursor: number;
  ordinal: number;
  key: SyncEntityIdentity;
  version: number;
  operation: "create" | "update" | "delete";
  changedFields: string[];
  scopeKeys: string[];
  summary: Record<string, unknown> | null;
  tombstone: boolean;
  refetch: "none" | "detail" | "page";
};
export type ThoughtSyncReader = {
  detail(rootId: string): Promise<Record<string, unknown> | null>;
};

const thoughtSourceTypes = new Set([
  "thoughtChain",
  "thoughtBlock",
  "thoughtRemark",
  "thoughtFollowUp",
  "annotation",
  "annotationReply",
  "annotationExchange"
]);
const knownDeferredTypes = new Set([
  "checkin",
  "dailyRecord",
  "capture",
  "journal",
  "journalReflection",
  "chat",
  "book",
  "bookNote",
  "keepsake",
  "quote",
  "experiment",
  "analysis",
  "recordCompression",
  "customMetric",
  "aiTask",
  "notification",
  "trash",
  "attachmentCleanup",
  "action",
  "habit",
  "habitCheckin",
  "feedback",
  "validationLedger",
  "userClaim",
  "modelUnknown",
  "evidenceSource",
  "evidencePermission",
  "perceptionEvent",
  "journalDraft",
  "onboarding",
  "onboardingV2",
  "commercialization",
  "historicalUserSupplement",
  "annotationDrift",
  "thoughtDiscovery"
]);
const publicChangedFields = new Set([
  "version",
  "content",
  "text",
  "question",
  "answer",
  "tags",
  "createdAt",
  "updatedAt",
  "occurredAt",
  "occurredOn",
  "location",
  "disposition",
  "remarks",
  "followUps",
  "annotations",
  "annotationDrift",
  "attachmentPaths",
  "imageUnderstandings"
]);
const syncProblem = (message: string, code: string) => Object.assign(new Error(message), {
  code,
  statusCode: 503
});

export function createRecordSyncEntityRegistry({ thoughtsComplete }: {
  thoughtsComplete: boolean;
}) {
  return Object.freeze({
    complete: Object.freeze(thoughtsComplete ? [...thoughtSourceTypes] : []),
    deferred: Object.freeze([
      ...knownDeferredTypes,
      ...(!thoughtsComplete ? thoughtSourceTypes : [])
    ])
  });
}

function rootIdFor(row: StoredRecordChange): string {
  if (row.entityType === "thoughtChain") return row.entityId;
  const scope = row.scopeKeys.find(value => (
    value !== "thought:list" && value.startsWith("thought:")
  ));
  return scope?.slice("thought:".length) || "";
}

function nestedContains(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some(item => nestedContains(item, id));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.id === id) return true;
  return Object.values(record).some(item => nestedContains(item, id));
}

function ownerProjection(
  detail: Record<string, unknown>,
  row: StoredRecordChange
): { key: SyncEntityIdentity; projection: Record<string, unknown> } | null {
  const { blocks = [], ...root } = detail;
  const values = Array.isArray(blocks)
    ? blocks.filter(value => value && typeof value === "object") as Record<string, unknown>[]
    : [];
  if (row.entityType === "thoughtChain") {
    return {
      key: {
        entityType: "thoughtChain",
        entityId: String(root.id || row.entityId),
        parentType: null,
        parentId: null
      },
      projection: root
    };
  }
  const rootId = String(root.id || rootIdFor(row));
  if (row.entityType === "thoughtBlock") {
    const block = values.find(value => value.id === row.entityId);
    return block ? {
      key: {
        entityType: "thoughtBlock",
        entityId: row.entityId,
        parentType: "thoughtChain",
        parentId: rootId
      },
      projection: block
    } : null;
  }
  if (row.parentType === "thoughtChain" || nestedContains(root, row.parentId || row.entityId)) {
    return {
      key: {
        entityType: "thoughtChain",
        entityId: rootId,
        parentType: null,
        parentId: null
      },
      projection: root
    };
  }
  const block = values.find(value => (
    value.id === row.parentId
    || nestedContains(value, row.parentId || row.entityId)
  ));
  return block ? {
    key: {
      entityType: "thoughtBlock",
      entityId: String(block.id),
      parentType: "thoughtChain",
      parentId: rootId
    },
    projection: block
  } : null;
}

function refetchFor(
  row: StoredRecordChange,
  target: SyncEntityIdentity
): PublicRecordChange["refetch"] {
  if (target.entityType === "thoughtChain") {
    if (row.operation !== "update") return "page";
    if (row.changedFields.some(field => [
      "createdAt", "occurredAt", "occurredOn", "tags", "location"
    ].includes(field))) return "page";
  }
  if (target.entityType === "thoughtBlock" && row.operation !== "update") return "detail";
  return "none";
}

function targetKey(value: SyncEntityIdentity): string {
  return JSON.stringify([
    value.entityType,
    value.parentType,
    value.parentId,
    value.entityId
  ]);
}

export async function projectRecordChanges({
  rows,
  reader,
  registry
}: {
  rows: StoredRecordChange[];
  reader: ThoughtSyncReader;
  registry: ReturnType<typeof createRecordSyncEntityRegistry>;
}): Promise<PublicRecordChange[]> {
  const complete = new Set(registry.complete);
  const deferred = new Set(registry.deferred);
  const unknown = rows.find(row => !complete.has(row.entityType) && !deferred.has(row.entityType));
  if (unknown) throw syncProblem(
    `记录同步实体类型未登记：${unknown.entityType}`,
    "SYNC_ENTITY_TYPE_UNREGISTERED"
  );
  const enabled = rows.filter(row => complete.has(row.entityType));
  const details = new Map<string, Promise<Record<string, unknown> | null>>();
  const readDetail = (rootId: string) => {
    if (!details.has(rootId)) details.set(rootId, reader.detail(rootId));
    return details.get(rootId)!;
  };
  const projected = new Map<string, PublicRecordChange>();
  for (const row of enabled) {
    const rootId = rootIdFor(row);
    if (!rootId) throw syncProblem("思绪同步变化缺少所属根", "SYNC_ENTITY_PROJECTION_FAILED");
    const detail = await readDetail(rootId);
    let target = detail ? ownerProjection(detail, row) : null;
    let foldedMissingNested = false;
    const directDelete = row.operation === "delete"
      && ["thoughtChain", "thoughtBlock"].includes(row.entityType);
    if (!target && directDelete) {
      target = {
        key: row.entityType === "thoughtChain" ? {
          entityType: "thoughtChain",
          entityId: row.entityId,
          parentType: null,
          parentId: null
        } : {
          entityType: "thoughtBlock",
          entityId: row.entityId,
          parentType: "thoughtChain",
          parentId: rootId
        },
        projection: {}
      };
    }
    if (!target && detail && !["thoughtChain", "thoughtBlock"].includes(row.entityType)) {
      const { blocks: _blocks, ...root } = detail;
      target = {
        key: {
          entityType: "thoughtChain",
          entityId: String(root.id || rootId),
          parentType: null,
          parentId: null
        },
        projection: root
      };
      foldedMissingNested = true;
    }
    if (!target) {
      const covered = enabled.some(candidate => (
        rootIdFor(candidate) === rootId
        && candidate.operation === "delete"
        && (
          candidate.entityType === "thoughtChain"
          || (
            candidate.entityType === row.entityType
            && candidate.entityId === row.entityId
          )
        )
      ));
      if (covered) continue;
      throw syncProblem(
        `思绪同步公开投影缺失：${row.entityType}/${row.entityId}/${row.operation}`,
        "SYNC_ENTITY_PROJECTION_FAILED"
      );
    }
    const tombstone = directDelete;
    const change: PublicRecordChange = {
      cursor: row.cursor,
      ordinal: row.ordinal,
      key: target.key,
      version: tombstone
        ? row.version
        : Math.max(1, Number(target.projection.version) || row.version),
      operation: tombstone ? "delete" : row.operation === "create" ? "create" : "update",
      changedFields: [...new Set(row.changedFields.filter(field => publicChangedFields.has(field)))],
      scopeKeys: [...new Set(row.scopeKeys)],
      summary: tombstone ? null : structuredClone(target.projection),
      tombstone,
      refetch: foldedMissingNested ? "detail" : refetchFor(row, target.key)
    };
    const key = targetKey(change.key);
    const previous = projected.get(key);
    if (previous) {
      change.changedFields = [...new Set([...previous.changedFields, ...change.changedFields])];
      change.scopeKeys = [...new Set([...previous.scopeKeys, ...change.scopeKeys])];
      change.refetch = previous.refetch === "page" || change.refetch === "page"
        ? "page"
        : previous.refetch === "detail" || change.refetch === "detail" ? "detail" : "none";
    }
    projected.set(key, change);
  }
  return [...projected.values()].sort((left, right) => (
    left.cursor - right.cursor || left.ordinal - right.ordinal
  ));
}
