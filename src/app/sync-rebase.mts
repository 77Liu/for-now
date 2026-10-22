/**
 * Bounded current-page and thought-detail rebase assembly.
 * Created: 2026-10-19
 * Status: active
 */
import type { ThoughtPageInput } from "../modules/thoughts/query-contracts.mjs";

type RecordEntityIdentity = {
  entityType: "thoughtChain" | "thoughtBlock";
  entityId: string;
  parentType: "thoughtChain" | null;
  parentId: string | null;
};
type RecordEntityEntry = {
  key: RecordEntityIdentity;
  version: number;
  deliveryCursor: number;
  projection: Record<string, unknown>;
  tombstone: false;
};
type RecordScope = {
  scopeKey: string;
  descriptorVersion: number;
  kind: "thoughtPage" | "thoughtDetail";
  entities: RecordEntityEntry[];
  orderedEntityKeys: string[];
  metadata: Record<string, unknown>;
};

export type ThoughtRecordSyncReader = {
  list(input: ThoughtPageInput): Promise<{
    items: Record<string, unknown>[];
    nextId: string;
    prevId: string;
    tags: string[];
  }>;
  detail(rootId: string): Promise<Record<string, unknown> | null>;
};
export type RecordSyncScopeRequest = {
  scopeKey: string;
  kind: "thoughtPage" | "thoughtDetail";
  id?: string;
  query?: string;
  tag?: string;
  sort?: "occurred" | "created";
  cursor?: string;
  direction?: "next" | "prev";
};

const problem = (message: string, code = "SYNC_REBASE_SCOPE_INVALID") => Object.assign(
  new Error(message),
  { code, statusCode: 400 }
);
const text = (value: unknown, name: string, maximum: number) => {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximum) throw problem(`同步恢复${name}无效`);
  return result;
};
const optionalText = (value: unknown, maximum: number) => {
  const result = String(value ?? "").trim();
  if (result.length > maximum) throw problem("同步恢复筛选条件过长");
  return result;
};
const entityKey = (value: RecordEntityIdentity) => JSON.stringify([
  value.entityType,
  value.parentType,
  value.parentId,
  value.entityId
]);
const encodeCursor = (value: string) => value
  ? Buffer.from(JSON.stringify({ v: 1, after: value }), "utf8").toString("base64url")
  : null;
const decodeCursor = (value: string) => {
  if (!value) return "";
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.v !== 1 || typeof decoded.after !== "string" || !decoded.after
      || decoded.after.length > 2_000) throw new Error();
    return decoded.after;
  } catch {
    throw problem("同步恢复分页游标无效");
  }
};

function entry(
  entityType: "thoughtChain" | "thoughtBlock",
  projection: Record<string, unknown>,
  deliveryCursor: number,
  rootId = ""
): RecordEntityEntry {
  const entityId = text(projection.id, "实体ID", 200);
  return {
    key: {
      entityType,
      entityId,
      parentType: entityType === "thoughtBlock" ? "thoughtChain" : null,
      parentId: entityType === "thoughtBlock" ? text(rootId, "所属思绪", 200) : null
    },
    version: Math.max(1, Number(projection.version) || 1),
    deliveryCursor,
    projection: structuredClone(projection),
    tombstone: false
  };
}

function normalizeScope(value: RecordSyncScopeRequest): RecordSyncScopeRequest {
  const scopeKey = text(value?.scopeKey, "范围键", 200);
  if (!/^[A-Za-z0-9:._-]+$/.test(scopeKey)) throw problem("同步恢复范围键格式无效");
  if (value?.kind === "thoughtDetail") {
    return { scopeKey, kind: value.kind, id: text(value.id, "详情ID", 200) };
  }
  if (value?.kind !== "thoughtPage") throw problem("同步恢复范围类型无效");
  const direction = value.direction || "next";
  if (!["next", "prev"].includes(direction)) throw problem("同步恢复分页方向无效");
  const sort = value.sort === "created" ? "created" : "occurred";
  return {
    scopeKey,
    kind: value.kind,
    query: optionalText(value.query, 200),
    tag: optionalText(value.tag, 30),
    sort,
    cursor: optionalText(value.cursor, 2_000),
    direction
  };
}

async function readPage(
  reader: ThoughtRecordSyncReader,
  scope: RecordSyncScopeRequest,
  highWaterCursor: number
): Promise<RecordScope> {
  const page = await reader.list({
    afterId: decodeCursor(scope.cursor || ""),
    direction: scope.direction || "next",
    query: scope.query || "",
    tag: scope.tag || "",
    sort: scope.sort || "occurred"
  });
  const entities = page.items.map(item => entry("thoughtChain", item, highWaterCursor));
  return {
    scopeKey: scope.scopeKey,
    descriptorVersion: 1,
    kind: "thoughtPage",
    entities,
    orderedEntityKeys: entities.map(item => entityKey(item.key)),
    metadata: {
      nextCursor: encodeCursor(page.nextId),
      prevCursor: encodeCursor(page.prevId),
      tags: page.tags,
      requestCursor: scope.cursor || "",
      direction: scope.direction || "next",
      query: scope.query || "",
      tag: scope.tag || "",
      sort: scope.sort || "occurred"
    }
  };
}

async function readDetail(
  reader: ThoughtRecordSyncReader,
  scope: RecordSyncScopeRequest,
  highWaterCursor: number
): Promise<RecordScope> {
  const detail = await reader.detail(scope.id!);
  if (!detail) {
    return {
      scopeKey: scope.scopeKey,
      descriptorVersion: 1,
      kind: "thoughtDetail",
      entities: [],
      orderedEntityKeys: [],
      metadata: { found: false }
    };
  }
  const { blocks = [], ...root } = detail;
  const entities = [
    entry("thoughtChain", root, highWaterCursor),
    ...(Array.isArray(blocks)
      ? blocks.filter(value => value && typeof value === "object")
        .map(value => entry(
          "thoughtBlock",
          value as Record<string, unknown>,
          highWaterCursor,
          String(root.id)
        ))
      : [])
  ];
  return {
    scopeKey: scope.scopeKey,
    descriptorVersion: 1,
    kind: "thoughtDetail",
    entities,
    orderedEntityKeys: entities.map(item => entityKey(item.key)),
    metadata: { found: true }
  };
}

export async function rebaseRecordSyncScopes({
  reader,
  scopes,
  activeScopeKey,
  highWaterCursor,
  maximumScopes
}: {
  reader: ThoughtRecordSyncReader;
  scopes: RecordSyncScopeRequest[];
  activeScopeKey: string;
  highWaterCursor: number;
  maximumScopes: number;
}) {
  if (!Array.isArray(scopes) || scopes.length > maximumScopes) {
    throw problem("同步恢复范围数量超限", "SYNC_REBASE_SCOPE_LIMIT");
  }
  const normalized = scopes.map(normalizeScope);
  if (new Set(normalized.map(scope => scope.scopeKey)).size !== normalized.length) {
    throw problem("同步恢复范围重复");
  }
  const active = activeScopeKey ? text(activeScopeKey, "活动范围键", 200) : "";
  if (active && !normalized.some(scope => scope.scopeKey === active)) {
    throw problem("同步恢复活动范围不在请求中");
  }
  const snapshots = [];
  for (const scope of normalized) {
    snapshots.push(scope.kind === "thoughtPage"
      ? await readPage(reader, scope, highWaterCursor)
      : await readDetail(reader, scope, highWaterCursor));
  }
  return {
    highWaterCursor,
    activeScopeKey: active,
    scopes: snapshots
  };
}
