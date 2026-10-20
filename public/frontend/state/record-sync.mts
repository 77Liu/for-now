/**
 * Frontend-owned v2 entity map, scope memberships and legacy thought projection.
 * Created: 2026-10-19
 * Status: active
 */
export type RecordSyncContext = {
  accountId: string;
  workspace: string;
  generation: number;
};
export type RecordEntityIdentity = {
  entityType: string;
  entityId: string;
  parentType: string | null;
  parentId: string | null;
};
export type RecordEntityEntry = {
  key: RecordEntityIdentity;
  version: number;
  deliveryCursor?: number;
  projection: Record<string, unknown> | null;
  tombstone: boolean;
};
export type RecordScope = {
  scopeKey: string;
  descriptorVersion: number;
  kind: "thoughtPage" | "thoughtDetail";
  entities: RecordEntityEntry[];
  orderedEntityKeys: string[];
  metadata?: Record<string, unknown>;
};
export type RecordChange = {
  cursor: number;
  ordinal: number;
  key: RecordEntityIdentity;
  version: number;
  operation: "create" | "update" | "delete";
  changedFields: string[];
  scopeKeys: string[];
  summary: Record<string, unknown> | null;
  tombstone: boolean;
  refetch: "none" | "detail" | "page" | "filter";
};
export type RecordBatch = {
  fromCursor: number;
  nextCursor: number;
  highWaterCursor: number;
  hasMore: boolean;
  changes: RecordChange[];
};
export type RecordRebase = {
  highWaterCursor: number;
  activeScopeKey: string;
  scopes: RecordScope[];
};

type ScopeState = Omit<RecordScope, "entities"> & {
  entities: Map<string, RecordEntityEntry>;
  stale: boolean;
};
type InternalState = {
  context: RecordSyncContext | null;
  cursor: number;
  activeScopeKey: string;
  entities: Map<string, RecordEntityEntry>;
  scopes: Map<string, ScopeState>;
};

const supportedEntityTypes = new Set(["thoughtChain", "thoughtBlock"]);
const clone = <Value,>(value: Value): Value => structuredClone(value);
const problem = (message: string, code: string) => Object.assign(new Error(message), { code });
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const integer = (value: unknown, name: string, minimum = 0) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw problem(`同步${name}无效`, "SYNC_RECORD_PAYLOAD_INVALID");
  }
  return parsed;
};
const text = (value: unknown, name: string) => {
  const result = String(value ?? "").trim();
  if (!result) throw problem(`同步${name}缺失`, "SYNC_RECORD_PAYLOAD_INVALID");
  return result;
};

function identity(value: RecordEntityIdentity): RecordEntityIdentity {
  const parentType = value?.parentType == null ? null : text(value.parentType, "父类型");
  const parentId = value?.parentId == null ? null : text(value.parentId, "父ID");
  if ((parentType === null) !== (parentId === null)) {
    throw problem("同步父身份不完整", "SYNC_RECORD_PAYLOAD_INVALID");
  }
  const entityType = text(value?.entityType, "实体类型");
  if (!supportedEntityTypes.has(entityType)) {
    throw problem("同步实体类型未登记", "SYNC_ENTITY_TYPE_UNKNOWN");
  }
  return {
    entityType,
    entityId: text(value?.entityId, "实体ID"),
    parentType,
    parentId
  };
}

export function recordEntityKey(value: RecordEntityIdentity): string {
  const key = identity(value);
  return JSON.stringify([
    key.entityType,
    key.parentType,
    key.parentId,
    key.entityId
  ]);
}

function contextMatches(left: RecordSyncContext | null, right: RecordSyncContext): boolean {
  return Boolean(left
    && left.accountId === right.accountId
    && left.workspace === right.workspace
    && left.generation === right.generation);
}

function validateContext(value: RecordSyncContext): RecordSyncContext {
  return {
    accountId: text(value?.accountId, "账户"),
    workspace: String(value?.workspace || ""),
    generation: integer(value?.generation, "代数", 1)
  };
}

function validateEntry(value: RecordEntityEntry): RecordEntityEntry {
  const key = identity(value?.key);
  const tombstone = value?.tombstone === true;
  const projection = value?.projection == null ? null : clone(value.projection);
  if (!tombstone && (!projection || typeof projection !== "object" || Array.isArray(projection))) {
    throw problem("同步实体投影无效", "SYNC_RECORD_PAYLOAD_INVALID");
  }
  return {
    key,
    version: integer(value?.version, "实体版本", 1),
    deliveryCursor: integer(value?.deliveryCursor || 0, "投递游标"),
    projection,
    tombstone
  };
}

function applyEntry(candidate: Map<string, RecordEntityEntry>, incoming: RecordEntityEntry): boolean {
  const key = recordEntityKey(incoming.key);
  const current = candidate.get(key);
  const currentCursor = current?.deliveryCursor || 0;
  const incomingCursor = incoming.deliveryCursor || 0;
  if (current && currentCursor > incomingCursor) return false;
  if (current && currentCursor === incomingCursor) {
    if (canonical(current) !== canonical(incoming)) {
      throw problem("同步实体同版本内容冲突", "SYNC_ENTITY_VERSION_CONFLICT");
    }
    return false;
  }
  if (current && current.version > incoming.version) {
    throw problem("同步实体业务版本倒退", "SYNC_ENTITY_VERSION_CONFLICT");
  }
  candidate.set(key, clone(incoming));
  return true;
}

// 列表摘要由根与全部子块派生；子块仅在影响摘要字段或增删时使列表失效。
const listSummaryFields = new Set(["content", "text", "tags", "disposition", "occurredAt", "createdAt"]);
function rootIdOf(key: RecordEntityIdentity): string {
  if (key.entityType === "thoughtChain") return key.entityId;
  return key.parentType === "thoughtChain" ? key.parentId || "" : "";
}
function listRootKey(rootId: string): string {
  return recordEntityKey({
    entityType: "thoughtChain",
    entityId: rootId,
    parentType: null,
    parentId: null
  });
}
function scopeRootId(scope: ScopeState): string {
  for (const entry of scope.entities.values()) {
    if (entry.key.entityType === "thoughtChain") return entry.key.entityId;
  }
  // 空详情（found:false）仍以范围键中的根身份为准，避免把同根后续新增判成无关。
  const prefix = "thoughtDetail:";
  return scope.scopeKey.startsWith(prefix) ? scope.scopeKey.slice(prefix.length) : "";
}

function validateScope(value: RecordScope): RecordScope {
  const scopeKey = text(value?.scopeKey, "范围键");
  const kind = value?.kind;
  if (!["thoughtPage", "thoughtDetail"].includes(kind)) {
    throw problem("同步范围类型无效", "SYNC_SCOPE_INVALID");
  }
  if (!Array.isArray(value.entities) || !Array.isArray(value.orderedEntityKeys)) {
    throw problem("同步范围载荷无效", "SYNC_SCOPE_INVALID");
  }
  const orderedEntityKeys = value.orderedEntityKeys.map(key => text(key, "范围实体键"));
  if (new Set(orderedEntityKeys).size !== orderedEntityKeys.length) {
    throw problem("同步范围实体重复", "SYNC_SCOPE_INVALID");
  }
  return {
    scopeKey,
    descriptorVersion: integer(value.descriptorVersion, "范围版本", 1),
    kind,
    entities: value.entities.map(validateEntry),
    orderedEntityKeys,
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? clone(value.metadata)
      : {}
  };
}

function emptyState(): InternalState {
  return {
    context: null,
    cursor: 0,
    activeScopeKey: "",
    entities: new Map(),
    scopes: new Map()
  };
}

export function createRecordState() {
  let current = emptyState();
  const requireContext = (value: RecordSyncContext) => {
    const normalized = validateContext(value);
    if (!contextMatches(current.context, normalized)) {
      throw problem("同步状态上下文已变化", "SYNC_STATE_CONTEXT_MISMATCH");
    }
    return normalized;
  };
  const replaceLegacy = (domain: string) => {
    if (domain !== "thoughts") return [];
    const scope = current.scopes.get(current.activeScopeKey);
    if (!scope) return [];
    return scope.orderedEntityKeys.flatMap(key => {
      const entry = scope.entities.get(key);
      return entry && !entry.tombstone && entry.projection ? [clone(entry.projection)] : [];
    });
  };
  return {
    reset() {
      current = emptyState();
    },
    rebaseScopes(payload: RecordRebase, suppliedContext: RecordSyncContext) {
      const normalizedContext = validateContext(suppliedContext);
      if (current.context && !contextMatches(current.context, normalizedContext)) {
        current = emptyState();
      }
      const scopes = payload.scopes.map(validateScope);
      const memberships = new Map<string, ScopeState>();
      for (const scope of scopes) {
        const previous = current.scopes.get(scope.scopeKey);
        // 已失效范围的缓存与最新投影不同源，不能复用；否则同游标比较会撞出伪冲突。
        const scopeEntities = previous && previous.kind === scope.kind && !previous.stale
          ? new Map(previous.entities)
          : new Map<string, RecordEntityEntry>();
        for (const entry of scope.entities) applyEntry(scopeEntities, entry);
        const retainedKeys = new Set(scope.orderedEntityKeys);
        for (const key of scopeEntities.keys()) {
          if (!retainedKeys.has(key)) scopeEntities.delete(key);
        }
        if (scope.orderedEntityKeys.some(key => !scopeEntities.has(key))) {
          throw problem("同步范围引用了缺失实体", "SYNC_SCOPE_INVALID");
        }
        memberships.set(scope.scopeKey, {
          scopeKey: scope.scopeKey,
          descriptorVersion: scope.descriptorVersion,
          kind: scope.kind,
          entities: scopeEntities,
          orderedEntityKeys: [...scope.orderedEntityKeys],
          metadata: clone(scope.metadata || {}),
          stale: false
        });
      }
      const activeScopeKey = String(payload.activeScopeKey || "");
      if (activeScopeKey && !memberships.has(activeScopeKey)) {
        throw problem("同步活动范围不存在", "SYNC_SCOPE_INVALID");
      }
      const entities = new Map<string, RecordEntityEntry>();
      for (const scope of memberships.values()) {
        if (scope.kind !== "thoughtDetail") continue;
        for (const entry of scope.entities.values()) applyEntry(entities, entry);
      }
      current = {
        context: normalizedContext,
        cursor: integer(payload.highWaterCursor, "高水位"),
        activeScopeKey,
        entities,
        scopes: memberships
      };
      return { committed: true, cursor: current.cursor, staleScopeKeys: [] };
    },
    applyRecordBatch(batch: RecordBatch, suppliedContext: RecordSyncContext) {
      requireContext(suppliedContext);
      if (!Array.isArray(batch?.changes)) {
        throw problem("同步批次无效", "SYNC_RECORD_PAYLOAD_INVALID");
      }
      const fromCursor = integer(batch.fromCursor, "起始游标");
      const nextCursor = integer(batch.nextCursor, "下一游标");
      const highWaterCursor = integer(batch.highWaterCursor, "高水位");
      if (nextCursor < fromCursor || highWaterCursor < nextCursor) {
        throw problem("同步批次游标顺序无效", "SYNC_RECORD_PAYLOAD_INVALID");
      }
      const entries = batch.changes.map(change => {
        const key = identity(change.key);
        if (!["create", "update", "delete"].includes(change.operation)) {
          throw problem("同步变化操作无效", "SYNC_RECORD_PAYLOAD_INVALID");
        }
        return {
          change,
          entry: validateEntry({
            key,
            version: change.version,
            deliveryCursor: change.cursor,
            projection: change.summary,
            tombstone: change.tombstone || change.operation === "delete"
          })
        };
      });
      if (nextCursor <= current.cursor) {
        // 重复批次不推进游标，但已失效范围仍未恢复；继续上报它们，调用方才能再次恢复而不是直接保存游标。
        return {
          committed: false,
          cursor: current.cursor,
          staleScopeKeys: [...current.scopes.values()]
            .filter(scope => scope.stale)
            .map(scope => scope.scopeKey)
        };
      }
      if (fromCursor !== current.cursor) {
        throw problem("同步批次游标不连续", "SYNC_CURSOR_DISCONTINUITY");
      }
      const entities = new Map(current.entities);
      const scopes = new Map([...current.scopes].map(([key, scope]) => [
        key,
        {
          ...scope,
          entities: new Map(scope.entities),
          orderedEntityKeys: [...scope.orderedEntityKeys]
        }
      ]));
      for (const { change, entry } of entries) {
        const key = recordEntityKey(entry.key);
        const rootId = rootIdOf(change.key);
        let changed = entities.has(key) ? applyEntry(entities, entry) : false;
        for (const scope of scopes.values()) {
          const member = scope.orderedEntityKeys.includes(key);
          let belongs = false;
          if (scope.kind === "thoughtPage") {
            // 列表范围只接受摘要契约；增量载荷恒为详情形态，合并会污染列表缓存并触发伪冲突，改为失效后按有界 rebase 恢复。
            if (change.key.entityType === "thoughtChain") {
              if (member || change.operation === "create") scope.stale = true;
            } else if (rootId && scope.orderedEntityKeys.includes(listRootKey(rootId))
              && (change.operation !== "update"
                || change.changedFields.some(field => listSummaryFields.has(field)))) {
              // 子块增删改变数量与预览；改正文/标签/判定等摘要字段时列表同样需要重新取摘要。
              scope.stale = true;
            }
          } else {
            const detailRootId = scopeRootId(scope);
            belongs = Boolean(rootId && detailRootId === rootId);
            if (member) {
              changed = applyEntry(scope.entities, entry) || changed;
              if (entry.tombstone) {
                scope.orderedEntityKeys = scope.orderedEntityKeys.filter(value => value !== key);
                scope.entities.delete(key);
              }
            } else if (belongs && change.operation !== "update") {
              // 当前详情自己的子块新增/删除必须重读；其它根的同类变化保持无关。
              scope.stale = true;
            }
          }
          if (change.refetch === "page" && scope.kind === "thoughtPage") {
            scope.stale = true;
          } else if (change.refetch === "detail" && scope.kind === "thoughtDetail" && belongs) {
            scope.stale = true;
          } else if (change.refetch === "filter" && scope.kind === "thoughtPage"
            && Boolean(String(scope.metadata?.query || "").trim())) {
            scope.stale = true;
          }
        }
        if (entry.tombstone) entities.delete(key);
        if (!changed) continue;
      }
      current = {
        ...current,
        cursor: nextCursor,
        entities,
        scopes
      };
      return {
        committed: true,
        cursor: current.cursor,
        staleScopeKeys: [...scopes.values()].filter(scope => scope.stale).map(scope => scope.scopeKey)
      };
    },
    selectLegacyDomain: replaceLegacy,
    selectActiveScope() {
      const scope = current.scopes.get(current.activeScopeKey);
      if (!scope) return null;
      const { entities: _entities, ...publicScope } = scope;
      return clone(publicScope);
    },
    inspect() {
      return clone({
        context: current.context,
        cursor: current.cursor,
        activeScopeKey: current.activeScopeKey,
        entities: [...current.entities],
        scopes: [...current.scopes]
      });
    }
  };
}
