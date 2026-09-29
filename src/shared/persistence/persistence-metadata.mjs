const METADATA_FIELD = "_persistence";
const METADATA_VERSION = 1;
const IDEMPOTENCY_RETENTION_DAYS = 90;
const IDEMPOTENCY_RETENTION_MS = IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
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
  validationLedger: "validationLedger"
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
const clone = value => structuredClone(value);
const idempotencyExpiry = createdAt => {
  const created = new Date(createdAt || "");
  return Number.isNaN(created.getTime()) ? "" : new Date(created.getTime() + IDEMPOTENCY_RETENTION_MS).toISOString();
};

function pruneIdempotency(metadata, at) {
  metadata.idempotency = metadata.idempotency.filter(entry => {
    entry.expiresAt = timestamp(entry.expiresAt) || idempotencyExpiry(entry.createdAt);
    return !entry.expiresAt || entry.expiresAt > at;
  });
}

function addResource(resources, resourceType, item, inheritedLifecycle = "", parentKey = "") {
  if (!objectValue(item) || typeof item.id !== "string" || !item.id) return;
  const currentLifecycle = inheritedLifecycle || lifecycle(item, resourceType);
  const resourceKey = `${parentKey ? `${parentKey}/` : ""}${resourceType}:${item.id}`;
  const key = resourceKey;
  if (resources.has(key)) throw new Error(`Duplicate lifecycle resource: ${resourceType}/${item.id}`);
  resources.set(key, {
    resourceKey,
    resourceType,
    resourceId: item.id,
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
        trashId: String(entry.id || "")
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

function ensureMetadata(document) {
  if (!objectValue(document)) throw new Error("Persistence document must be an object");
  if (!Object.hasOwn(document, METADATA_FIELD)) {
    document[METADATA_FIELD] = { version: METADATA_VERSION, lifecycles: [], idempotency: [] };
  }
  const metadata = document[METADATA_FIELD];
  if (!objectValue(metadata) || !Array.isArray(metadata.lifecycles) || !Array.isArray(metadata.idempotency)) {
    throw Object.assign(new Error("Persistence metadata is invalid"), { code: "STORAGE_READ_FAILED" });
  }
  if (!metadata.lifecycles.every(validLifecycleEntry) || !metadata.idempotency.every(validIdempotencyEntry)) {
    throw Object.assign(new Error("Persistence metadata records are invalid"), { code: "STORAGE_READ_FAILED" });
  }
  metadata.version = METADATA_VERSION;
  const lifecycleKeys = metadata.lifecycles.map(item => item.resourceKey);
  const idempotencyKeys = metadata.idempotency.map(item => identity(item.scope, item.key));
  if (new Set(lifecycleKeys).size !== lifecycleKeys.length || new Set(idempotencyKeys).size !== idempotencyKeys.length) {
    throw Object.assign(new Error("Persistence metadata contains duplicate keys"), { code: "STORAGE_READ_FAILED" });
  }
  return metadata;
}

function appendEvent(entry, event, at, details = {}) {
  entry.history.push({ event, at, ...details });
  entry.updatedAt = at;
}

export function synchronizePersistenceMetadata(before, after, now = () => new Date().toISOString(), { force = false } = {}) {
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

export { IDEMPOTENCY_RETENTION_DAYS, METADATA_FIELD, METADATA_VERSION };
