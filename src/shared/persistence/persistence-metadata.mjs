import crypto from "node:crypto";

const METADATA_FIELD = "_persistence";
const METADATA_VERSION = 1;
const IDEMPOTENCY_RETENTION_DAYS = 90;
const IDEMPOTENCY_RETENTION_MS = IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SYNC_CHANGE_RETENTION_DAYS = 30;
const SYNC_CHANGE_RETENTION_MS = SYNC_CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SYNC_CHANGE_LIMIT = 2000;
const SYNC_OPERATION_RETENTION_MS = IDEMPOTENCY_RETENTION_MS;
const SYNC_OPERATION_LIMIT = 5000;
const LIFECYCLE_STATES = new Set(["active", "deleted", "formalized", "purged"]);
const LIFECYCLES = new Set(["draft", "formal"]);
const COLLECTION_TYPES = {
  checkins: "checkin",
  dailyRecords: "dailyRecord",
  captures: "capture",
  journals: "journal",
  chats: "chat",
  books: "book",
  keepsakes: "keepsake",
  quotes: "quote",
  experiments: "experiment",
  analyses: "analysis",
  customMetrics: "customMetric",
  actions: "action",
  habits: "habit",
  habitCheckins: "habitCheckin",
  feedback: "feedback",
  validationLedger: "validationLedger",
  userClaims: "userClaim",
  modelUnknowns: "modelUnknown",
  evidenceSources: "evidenceSource",
  evidencePermissions: "evidencePermission",
  perceptionEvents: "perceptionEvent"
};
const CHILD_TYPES = {
  remarks: "thoughtRemark",
  followUps: "thoughtFollowUp",
  reflections: "journalReflection",
  notes: "bookNote",
  annotations: "annotation",
  annotationDrift: "annotation"
};
const CHILD_FIELDS = Object.keys(CHILD_TYPES);
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = value => {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};
const lifecycle = (item, type) => (
  item?.lifecycle === "draft" || type === "journalDraft" ? "draft" : "formal"
);
const identity = (resourceType, resourceId) => `${resourceType}\u0000${resourceId}`;
const resourceId = (resourceType, item) => (
  resourceType === "evidencePermission" ? item?.sourceKey : item?.id
);
const collectionIdentity = (collection, item) => (
  collection === "evidencePermissions" ? item?.sourceKey : item?.id
);
const collectionVersion = (collection, item) => (
  collection === "evidencePermissions" ? item?.revision : item?.version
);
const clone = value => structuredClone(value);
const serialized = value => JSON.stringify(value);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const EMPTY_BODY_SHA256 = sha256("");
const idempotencyExpiry = createdAt => {
  const created = new Date(createdAt || "");
  return Number.isNaN(created.getTime()) ? "" : new Date(created.getTime() + IDEMPOTENCY_RETENTION_MS).toISOString();
};

export function syncOperationFingerprint({
  method = "",
  resource = "",
  contentType = "",
  ifMatch = "",
  requestBodySha256 = EMPTY_BODY_SHA256
} = {}) {
  return sha256(JSON.stringify({
    method: String(method).toUpperCase(),
    resource: String(resource),
    contentType: String(contentType).toLowerCase(),
    ifMatch: String(ifMatch),
    requestBodySha256: String(requestBodySha256)
  }));
}

function operationFingerprintErrorDetails(reason, context = {}) {
  const suppliedVersion = String(context.clientContractVersion || "");
  return {
    reason,
    clientContractVersion: /^[A-Za-z0-9_.:-]{1,32}$/.test(suppliedVersion)
      ? suppliedVersion
      : "legacy"
  };
}

function pruneIdempotency(metadata, at) {
  metadata.idempotency = metadata.idempotency.filter(entry => {
    entry.expiresAt = timestamp(entry.expiresAt) || idempotencyExpiry(entry.createdAt);
    return !entry.expiresAt || entry.expiresAt > at;
  });
}

function addResource(resources, resourceType, item, inheritedLifecycle = "", parentKey = "") {
  const id = resourceId(resourceType, item);
  if (!objectValue(item) || typeof id !== "string" || !id) return;
  const currentLifecycle = inheritedLifecycle || lifecycle(item, resourceType);
  const resourceKey = `${parentKey ? `${parentKey}/` : ""}${resourceType}:${id}`;
  const key = resourceKey;
  if (resources.has(key)) throw new Error(`Duplicate lifecycle resource: ${resourceType}/${item.id}`);
  resources.set(key, {
    resourceKey,
    resourceType,
    resourceId: id,
    lifecycle: currentLifecycle,
    createdAt: timestamp(item.createdAt)
  });
  for (const field of CHILD_FIELDS) {
    if (!Array.isArray(item[field])) continue;
    for (const child of item[field]) addResource(resources, CHILD_TYPES[field], child, currentLifecycle, resourceKey);
  }
}

function activeResources(store) {
  const resources = new Map();
  for (const [collection, resourceType] of Object.entries(COLLECTION_TYPES)) {
    for (const item of Array.isArray(store[collection]) ? store[collection] : []) {
      addResource(resources, resourceType, item);
    }
  }
  for (const item of Array.isArray(store.thoughts) ? store.thoughts : []) {
    addResource(resources, item.type === "question" ? "thoughtChain" : "thoughtBlock", item);
  }
  if (objectValue(store.journalDraft)) {
    addResource(resources, "journalDraft", { id: "journalDraft", ...store.journalDraft }, "draft");
  }
  return resources;
}

function trashResources(store) {
  const resources = new Map();
  for (const entry of Array.isArray(store.trash) ? store.trash : []) {
    const deletedAt = timestamp(entry.deletedAt);
    const parentCollection = String(entry.location?.parentCollection || entry.location?.collection || "");
    const parentType = parentCollection === "thoughts" ? "thoughtChain" : COLLECTION_TYPES[parentCollection] || "";
    const parentKey = parentType && entry.location?.parentId
      ? `${parentType}:${entry.location.parentId}`
      : "";
    const addDeleted = (resourceType, item, inheritedLifecycle = "", parentKey = "") => {
      if (!objectValue(item) || typeof item.id !== "string" || !item.id) return;
      const currentLifecycle = inheritedLifecycle || lifecycle(item, resourceType);
      const resourceKey = `${parentKey ? `${parentKey}/` : ""}${resourceType}:${item.id}`;
      resources.set(resourceKey, {
        resourceKey,
        resourceType,
        resourceId: item.id,
        lifecycle: currentLifecycle,
        createdAt: timestamp(item.createdAt),
        deletedAt,
        trashId: String(entry.id || ""),
        permanentlyPurged: entry.permanentlyPurged === true,
        purgedAt: timestamp(entry.purgedAt)
      });
      for (const field of CHILD_FIELDS) {
        if (!Array.isArray(item[field])) continue;
        for (const child of item[field]) addDeleted(CHILD_TYPES[field], child, currentLifecycle, resourceKey);
      }
    };
    if (entry.type === "thoughtChain" && Array.isArray(entry.payload?.items)) {
      for (const record of entry.payload.items) {
        const item = record?.item;
        addDeleted(item?.type === "question" ? "thoughtChain" : "thoughtBlock", item);
      }
    } else {
      addDeleted(
        String(entry.type || ""),
        entry.payload,
        "",
        entry.location?.kind === "nested" ? parentKey : ""
      );
    }
    for (const field of ["annotations", "annotationDrift"]) {
      for (const item of Array.isArray(entry.dependents?.[field]) ? entry.dependents[field] : []) {
        addDeleted(CHILD_TYPES[field], item, "", parentKey);
      }
    }
  }
  return resources;
}

function validLifecycleEntry(entry) {
  return objectValue(entry)
    && typeof entry.resourceKey === "string"
    && entry.resourceKey
    && typeof entry.resourceType === "string"
    && entry.resourceType
    && typeof entry.resourceId === "string"
    && entry.resourceId
    && LIFECYCLES.has(entry.lifecycle)
    && LIFECYCLE_STATES.has(entry.state)
    && typeof entry.tombstone === "boolean"
    && Array.isArray(entry.history);
}

function validIdempotencyEntry(entry) {
  return objectValue(entry)
    && typeof entry.scope === "string"
    && entry.scope
    && typeof entry.key === "string"
    && entry.key
    && typeof entry.requestHash === "string"
    && entry.requestHash
    && Object.hasOwn(entry, "response")
    && typeof entry.createdAt === "string";
}

function validSyncChange(entry) {
  return objectValue(entry)
    && Number.isSafeInteger(entry.cursor)
    && entry.cursor > 0
    && typeof entry.domain === "string"
    && entry.domain
    && typeof entry.resourceId === "string"
    && typeof entry.operationId === "string"
    && Number.isSafeInteger(entry.version)
    && entry.version >= 0
    && ["create", "update", "delete", "reorder"].includes(entry.changeType)
    && typeof entry.committedAt === "string";
}

function validSyncOperation(entry) {
  return objectValue(entry)
    && typeof entry.operationId === "string"
    && entry.operationId
    && /^[a-f0-9]{64}$/.test(entry.fingerprint)
    && typeof entry.method === "string"
    && entry.method
    && typeof entry.resource === "string"
    && entry.resource
    && typeof entry.committedAt === "string"
    && (!entry.businessIdMapping || (objectValue(entry.businessIdMapping)
      && typeof entry.businessIdMapping.accountId === "string"
      && entry.businessIdMapping.operationId === entry.operationId
      && /^[A-Za-z0-9_-]{16}$/.test(entry.businessIdMapping.provisionalId)
      && /^[A-Za-z0-9_-]{16}$/.test(entry.businessIdMapping.canonicalId)))
    && Number.isSafeInteger(entry.firstCursor)
    && entry.firstCursor >= 0
    && Number.isSafeInteger(entry.lastCursor)
    && entry.lastCursor >= entry.firstCursor;
}

function ensureMetadata(document) {
  if (!objectValue(document)) throw new Error("Persistence document must be an object");
  if (!Object.hasOwn(document, METADATA_FIELD)) {
    document[METADATA_FIELD] = {
      version: METADATA_VERSION,
      lifecycles: [],
      idempotency: [],
      sync: { cursor: 0, changes: [], operations: [] }
    };
  }
  const metadata = document[METADATA_FIELD];
  if (!objectValue(metadata) || !Array.isArray(metadata.lifecycles) || !Array.isArray(metadata.idempotency)) {
    throw Object.assign(new Error("Persistence metadata is invalid"), { code: "STORAGE_READ_FAILED" });
  }
  if (!Object.hasOwn(metadata, "sync")) metadata.sync = { cursor: 0, changes: [] };
  if (!Object.hasOwn(metadata.sync, "operations")) metadata.sync.operations = [];
  if (!objectValue(metadata.sync)
    || !Number.isSafeInteger(metadata.sync.cursor)
    || metadata.sync.cursor < 0
    || !Array.isArray(metadata.sync.changes)
    || !metadata.sync.changes.every(validSyncChange)
    || !Array.isArray(metadata.sync.operations)
    || !metadata.sync.operations.every(validSyncOperation)) {
    throw Object.assign(new Error("Persistence sync metadata is invalid"), { code: "STORAGE_READ_FAILED" });
  }
  if (!metadata.lifecycles.every(validLifecycleEntry) || !metadata.idempotency.every(validIdempotencyEntry)) {
    throw Object.assign(new Error("Persistence metadata records are invalid"), { code: "STORAGE_READ_FAILED" });
  }
  metadata.version = METADATA_VERSION;
  const lifecycleKeys = metadata.lifecycles.map(item => item.resourceKey);
  const idempotencyKeys = metadata.idempotency.map(item => identity(item.scope, item.key));
  const operationIds = metadata.sync.operations.map(item => item.operationId);
  if (new Set(lifecycleKeys).size !== lifecycleKeys.length
    || new Set(idempotencyKeys).size !== idempotencyKeys.length
    || new Set(operationIds).size !== operationIds.length) {
    throw Object.assign(new Error("Persistence metadata contains duplicate keys"), { code: "STORAGE_READ_FAILED" });
  }
  return metadata;
}

function topLevelChanges(before, after) {
  const changes = [];
  for (const domain of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if ([METADATA_FIELD, "version", "attachmentCleanup"].includes(domain)) continue;
    const previous = before?.[domain], current = after?.[domain];
    if (Array.isArray(previous) || Array.isArray(current)) {
      const left = new Map((previous || []).map(item => [String(collectionIdentity(domain, item) || ""), item]));
      const right = new Map((current || []).map(item => [String(collectionIdentity(domain, item) || ""), item]));
      for (const resourceId of new Set([...left.keys(), ...right.keys()])) {
        const oldValue = left.get(resourceId), nextValue = right.get(resourceId);
        if (serialized(oldValue) === serialized(nextValue)) continue;
        changes.push({
          domain,
          resourceId,
          version: Math.max(0, Math.round(Number(
            collectionVersion(domain, nextValue) || collectionVersion(domain, oldValue)
          ) || 0)),
          changeType: oldValue == null ? "create" : nextValue == null ? "delete" : "update"
        });
      }
      const previousOrder = (previous || []).map(item => String(collectionIdentity(domain, item) || ""));
      const currentOrder = (current || []).map(item => String(collectionIdentity(domain, item) || ""));
      if (serialized(previousOrder) !== serialized(currentOrder)
        && !changes.some(item => item.domain === domain && item.changeType !== "update")) {
        changes.push({ domain, resourceId: "", version: 0, changeType: "reorder" });
      }
      continue;
    }
    if (serialized(previous) === serialized(current)) continue;
    changes.push({
      domain,
      resourceId: domain,
      version: Math.max(0, Math.round(Number(current?.version || previous?.version) || 0)),
      changeType: previous == null ? "create" : current == null ? "delete" : "update"
    });
  }
  return changes;
}

function appendSyncChanges(metadata, before, after, at, context = {}) {
  if (!before) return;
  const operationId = String(context.operationId || context.clientOperationId || "").slice(0, 100);
  const suppliedFingerprint = String(context.clientOperationFingerprint || "");
  const fingerprint = suppliedFingerprint ? syncOperationFingerprint(context) : "";
  if (suppliedFingerprint && suppliedFingerprint !== fingerprint) {
    throw Object.assign(new Error("客户端操作指纹与请求不一致"), {
      statusCode: 400,
      code: "INVALID_OPERATION_FINGERPRINT",
      details: operationFingerprintErrorDetails("canonical-mismatch", context)
    });
  }
  const traceId = String(context.traceId || "").slice(0, 128);
  const changes = topLevelChanges(before, after);
  const firstCursor = metadata.sync.cursor + (changes.length ? 1 : 0);
  for (const change of changes) {
    metadata.sync.cursor += 1;
    metadata.sync.changes.push({
      cursor: metadata.sync.cursor,
      ...change,
      operationId,
      traceId,
      committedAt: at
    });
  }
  const cutoff = new Date(new Date(at).getTime() - SYNC_CHANGE_RETENTION_MS).toISOString();
  metadata.sync.changes = metadata.sync.changes
    .filter(item => item.committedAt >= cutoff)
    .slice(-SYNC_CHANGE_LIMIT);
  const operationCutoff = new Date(new Date(at).getTime() - SYNC_OPERATION_RETENTION_MS).toISOString();
  metadata.sync.operations = metadata.sync.operations
    .filter(item => item.committedAt >= operationCutoff)
    .slice(-SYNC_OPERATION_LIMIT);
  if (!operationId || !fingerprint) return;
  const existing = metadata.sync.operations.find(item => item.operationId === operationId);
  if (existing && existing.fingerprint !== fingerprint) {
    throw Object.assign(new Error("同一操作标识不能用于不同请求"), {
      statusCode: 409,
      code: "OPERATION_ID_REUSED"
    });
  }
  if (!existing) metadata.sync.operations.push({
    operationId,
    fingerprint,
    method: String(context.method || "").slice(0, 16),
    resource: String(context.resource || context.route || "").slice(0, 500),
    committedAt: at,
    firstCursor,
    lastCursor: metadata.sync.cursor,
    ...(context.businessIdMapping ? { businessIdMapping: structuredClone(context.businessIdMapping) } : {})
  });
  metadata.sync.operations = metadata.sync.operations.slice(-SYNC_OPERATION_LIMIT);
}

function appendEvent(entry, event, at, details = {}) {
  entry.history.push({ event, at, ...details });
  entry.updatedAt = at;
}

export function synchronizePersistenceMetadata(before, after, now = () => new Date().toISOString(), {
  force = false,
  context = {}
} = {}) {
  if (!force && !Array.isArray(after?.trash)) return after;
  const at = timestamp(now()) || new Date().toISOString();
  const metadata = ensureMetadata(after);
  const previousMetadata = objectValue(before?.[METADATA_FIELD]) ? before[METADATA_FIELD] : null;
  const previousEntries = new Map((previousMetadata?.lifecycles || []).map(item => [
    item.resourceKey,
    item
  ]));
  const entries = new Map(metadata.lifecycles.map(item => [
    item.resourceKey,
    item
  ]));
  const active = activeResources(after);
  const deleted = trashResources(after);

  for (const [key, resource] of active) {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        ...resource,
        state: "active",
        tombstone: false,
        deletedAt: "",
        restoredAt: "",
        purgedAt: "",
        trashId: "",
        updatedAt: resource.createdAt || at,
        history: [{ event: "observed", at: resource.createdAt || at }]
      };
      entries.set(key, entry);
    } else if (entry.state !== "active") {
      const event = entry.state === "deleted" ? "restored" : "recreated";
      Object.assign(entry, {
        lifecycle: resource.lifecycle,
        state: "active",
        tombstone: false,
        restoredAt: at,
        purgedAt: "",
        trashId: ""
      });
      appendEvent(entry, event, at);
    }
  }

  for (const [key, resource] of deleted) {
    let entry = entries.get(key);
    if (resource.permanentlyPurged) {
      if (!entry) {
        entry = {
          ...resource, state: "deleted", tombstone: true,
          restoredAt: "", history: []
        };
        entries.set(key, entry);
      }
      if (entry.state !== "purged") {
        Object.assign(entry, {
          state: "purged", tombstone: true,
          purgedAt: resource.purgedAt || at, trashId: resource.trashId
        });
        appendEvent(entry, "purged", resource.purgedAt || at, { trashId: resource.trashId });
      }
      continue;
    }
    if (!entry) {
      entry = {
        ...resource,
        state: "deleted",
        tombstone: true,
        restoredAt: "",
        purgedAt: "",
        updatedAt: resource.deletedAt || at,
        history: [{ event: "deleted", at: resource.deletedAt || at, trashId: resource.trashId }]
      };
      entries.set(key, entry);
    } else if (entry.state !== "deleted" || entry.trashId !== resource.trashId) {
      Object.assign(entry, {
        lifecycle: resource.lifecycle,
        state: "deleted",
        tombstone: true,
        deletedAt: resource.deletedAt || at,
        restoredAt: "",
        purgedAt: "",
        trashId: resource.trashId
      });
      appendEvent(entry, "deleted", resource.deletedAt || at, { trashId: resource.trashId });
    }
  }

  for (const [key, previous] of previousEntries) {
    const entry = entries.get(key);
    if (!entry || active.has(key) || deleted.has(key)) continue;
    if (previous.state === "deleted") {
      Object.assign(entry, { state: "purged", tombstone: true, purgedAt: at });
      appendEvent(entry, "purged", at, { trashId: previous.trashId || "" });
    } else if (previous.state === "active" && previous.lifecycle === "draft") {
      Object.assign(entry, { state: "formalized", tombstone: false });
      appendEvent(entry, "formalized", at);
    } else if (previous.state === "active") {
      throw Object.assign(new Error(`Resource removed without tombstone: ${previous.resourceType}/${previous.resourceId}`), {
        code: "LIFECYCLE_TOMBSTONE_REQUIRED"
      });
    }
  }

  const previousDraft = before?.journalDraft;
  const currentDraft = after.journalDraft;
  if (objectValue(previousDraft) && objectValue(currentDraft)
    && previousDraft.journalId && !currentDraft.journalId) {
    const draft = entries.get("journalDraft:journalDraft");
    appendEvent(draft, "association_detached", at, { relation: "journal", targetId: previousDraft.journalId });
  }

  metadata.lifecycles = [...entries.values()].sort((a, b) => (
    a.resourceType.localeCompare(b.resourceType) || a.resourceId.localeCompare(b.resourceId)
  ));
  appendSyncChanges(metadata, before, after, at, context);
  return after;
}

export function preparePersistenceDocument(document, now, { force = false } = {}) {
  if (!force && !Array.isArray(document?.trash)) return document;
  ensureMetadata(document);
  return synchronizePersistenceMetadata(null, document, now, { force });
}

export function publicPersistenceDocument(document) {
  const result = clone(document);
  delete result[METADATA_FIELD];
  return result;
}

export function persistenceMetadata(document) {
  return clone(ensureMetadata(document));
}

export function findIdempotencyResponse(document, { scope, key, requestHash }, now = () => new Date().toISOString()) {
  const metadata = ensureMetadata(document);
  pruneIdempotency(metadata, timestamp(now()) || new Date().toISOString());
  const entry = metadata.idempotency.find(item => item.scope === scope && item.key === key);
  if (!entry) return undefined;
  if (entry.requestHash !== requestHash) {
    throw Object.assign(new Error("同一幂等键不能用于不同内容"), {
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED"
    });
  }
  return clone(entry.response);
}

export function recordIdempotencyResponse(document, { scope, key, requestHash, response, expiresAt = "" }, now = () => new Date().toISOString()) {
  if (!scope || !key || !requestHash) throw new TypeError("Idempotency scope, key and requestHash are required");
  const metadata = ensureMetadata(document);
  const createdAt = timestamp(now()) || new Date().toISOString();
  pruneIdempotency(metadata, createdAt);
  if (metadata.idempotency.some(item => item.scope === scope && item.key === key)) {
    throw new Error("Idempotency response must be checked before recording");
  }
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new TypeError("Idempotency response must be JSON serializable");
  metadata.idempotency.push({
    scope,
    key,
    requestHash,
    response: JSON.parse(serialized),
    createdAt,
    expiresAt: timestamp(expiresAt) || idempotencyExpiry(createdAt)
  });
}

export function removeIdempotencyResponse(document, { scope, key }) {
  const metadata = ensureMetadata(document);
  const index = metadata.idempotency.findIndex(item => item.scope === scope && item.key === key);
  if (index < 0) return false;
  metadata.idempotency.splice(index, 1);
  return true;
}

export {
  IDEMPOTENCY_RETENTION_DAYS,
  METADATA_FIELD,
  METADATA_VERSION,
  SYNC_CHANGE_LIMIT,
  SYNC_CHANGE_RETENTION_DAYS
};
