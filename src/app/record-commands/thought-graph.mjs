import {
  canonicalJson,
  mapStoreObjects,
  rebuildStoreObjects
} from "../../shared/persistence/index.mjs";

export const recordObjectKey = (collection, id) => JSON.stringify([collection, id]);
const conflict = () => Object.assign(
  new Error("思绪已变化，请刷新后重试"),
  { statusCode: 409, code: "VERSION_CONFLICT" }
);
const orderTuple = row => [
  String(row.payload?.occurredAt || row.payload?.occurredOn || row.payload?.createdAt || ""),
  String(row.id || "")
];

function normalizedClosureRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = JSON.stringify([row.parentKey, row.field]);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const normalized = [];
  for (const group of groups.values()) {
    const positioned = group.every(row => Number.isInteger(row.position));
    group.sort(positioned
      ? (left, right) => left.position - right.position
      : (left, right) => {
          const a = orderTuple(left), b = orderTuple(right);
          return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
        });
    normalized.push(...group.map((row, position) => ({ ...row, position })));
  }
  return normalized;
}

export function rebuildRecordCollections(rows, collections) {
  return rebuildStoreObjects({
    fields: collections.map(field => ({ field, shape: "array", payload: null })),
    objects: normalizedClosureRows(rows)
  });
}

export async function readThoughtClosure(objects, relations, id) {
  const rootKey = recordObjectKey("thoughts", id);
  const root = await objects.find(rootKey, { lock: true });
  if (!root || root.payload?.type !== "question") return null;
  const blockKeys = await relations.findSources([rootKey], {
    relation: "thoughtRoot",
    sourceCollection: "thoughts"
  });
  const rows = await objects.findTree([rootKey, ...blockKeys], { lock: true });
  return {
    rootKey,
    rows,
    thoughts: rebuildRecordCollections(rows, ["thoughts"]).thoughts
  };
}

const comparable = row => canonicalJson({
  childFields: row.childFields,
  content: row.content,
  status: row.status,
  authorType: row.authorType,
  version: row.version,
  payload: row.payload,
  lifecycle: row.lifecycle || "formal",
  tombstone: row.tombstone === true,
  deletedAt: row.deletedAt || null
});

async function removeRows(ports, rows) {
  if (!rows.length) return;
  await ports.relations.detachTargets(rows.map(row => row.objectKey));
  const deepestFirst = [...rows].sort((left, right) => (
    JSON.parse(right.objectKey).length - JSON.parse(left.objectKey).length
  ));
  for (const row of deepestFirst) {
    await ports.relations.removeForObject(row.objectKey);
    await ports.attachments.removeForObject(row.objectKey);
    if (!await ports.objects.remove(row.objectKey, row.version)) throw conflict();
  }
}

async function insertRows(ports, mapping, rows) {
  const inserted = new Set(rows.map(row => row.objectKey));
  for (const row of rows) await ports.objects.insert({ ...row, position: null });
  for (const relation of mapping.relations) {
    if (inserted.has(relation.objectKey)) await ports.relations.insert(relation);
  }
  for (const attachment of mapping.attachmentRefs) {
    if (inserted.has(attachment.ownerKey)) await ports.attachments.insert(attachment);
  }
}

function mappedUpdate(current, row) {
  if (Number(row.version) > Number(current.version)) {
    return { ...row, position: current.position };
  }
  const version = Number(current.version) + 1;
  return {
    ...row,
    position: current.position,
    version,
    payload: { ...row.payload, version }
  };
}

async function refreshIndexes(ports, mapping, objectKeys) {
  for (const objectKey of objectKeys) {
    await ports.relations.removeForObject(objectKey);
    await ports.attachments.removeForObject(objectKey);
    for (const relation of mapping.relations) {
      if (relation.objectKey === objectKey) await ports.relations.insert(relation);
    }
    for (const attachment of mapping.attachmentRefs) {
      if (attachment.ownerKey === objectKey) await ports.attachments.insert(attachment);
    }
  }
}

export async function persistMappedClosure(
  ports,
  accountId,
  beforeRows,
  store,
  {
    managedCollections = Object.keys(store),
    refreshIndexesForCollections = []
  } = {}
) {
  const mapping = mapStoreObjects(accountId, store);
  const managed = new Set(managedCollections);
  const previousRows = beforeRows.filter(row => managed.has(row.collection));
  const mappedRows = mapping.objects.filter(row => managed.has(row.collection));
  const before = new Map(previousRows.map(row => [row.objectKey, row]));
  const after = new Map(mappedRows.map(row => [row.objectKey, row]));
  const persistedRows = [];
  const refreshedIndexes = new Set();
  const refreshCollections = new Set(refreshIndexesForCollections);
  await removeRows(ports, previousRows.filter(row => !after.has(row.objectKey)));
  for (const row of mappedRows) {
    const current = before.get(row.objectKey);
    if (!current) continue;
    if (comparable(current) === comparable(row)) {
      persistedRows.push(current);
      continue;
    }
    const next = mappedUpdate(current, row);
    if (!await ports.objects.update(next, current.version)) throw conflict();
    if (refreshCollections.has(row.collection)) refreshedIndexes.add(row.objectKey);
    persistedRows.push(next);
  }
  const insertedRows = mappedRows
    .filter(row => !before.has(row.objectKey))
    .map(row => ({ ...row, position: null }));
  await insertRows(ports, mapping, insertedRows);
  await refreshIndexes(ports, mapping, refreshedIndexes);
  return [...persistedRows, ...insertedRows];
}

export async function readThoughtDeleteClosure(ports, id) {
  const thoughtClosure = await readThoughtClosure(ports.objects, ports.relations, id);
  if (!thoughtClosure) return null;
  const thoughtKeys = thoughtClosure.rows.map(row => row.objectKey);
  const taskKeys = await ports.relations.findSources(thoughtKeys, {
    sourceCollection: "aiTasks"
  });
  const taskRows = await ports.objects.findTree(taskKeys, { lock: true });
  const notificationKeys = await ports.relations.findSources(
    taskRows.map(row => row.objectKey),
    { relation: "task", sourceCollection: "notifications" }
  );
  const evidenceKeys = await ports.relations.findSources(thoughtKeys, {
    relation: "source",
    sourceCollection: "evidencePermissions"
  });
  const relatedRows = await ports.objects.findTree(
    [...notificationKeys, ...evidenceKeys],
    { lock: true }
  );
  const rows = [...new Map([
    ...thoughtClosure.rows,
    ...taskRows,
    ...relatedRows
  ].map(row => [row.objectKey, row])).values()];
  const store = rebuildRecordCollections(rows, [
    "thoughts",
    "aiTasks",
    "notifications",
    "evidencePermissions"
  ]);
  store.trash = [];
  return { ...thoughtClosure, rows, store };
}

const lifecycleType = row => {
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

function thoughtLifecycleRecords(rows) {
  const byKey = new Map(rows.map(row => [row.objectKey, row]));
  const keys = new Map();
  const resourceKey = row => {
    if (keys.has(row.objectKey)) return keys.get(row.objectKey);
    const type = lifecycleType(row);
    const parent = row.parentKey ? byKey.get(row.parentKey) : null;
    const key = `${parent ? `${resourceKey(parent)}/` : ""}${type}:${row.id}`;
    keys.set(row.objectKey, key);
    return key;
  };
  return rows.flatMap(row => {
    const resourceType = lifecycleType(row);
    if (!TRACKED_THOUGHT_LIFECYCLES.has(resourceType)) return [];
    const createdAt = String(row.payload?.createdAt || "");
    const value = {
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

export async function ensureThoughtLifecycles(lifecycles, thoughtRows) {
  const expected = thoughtLifecycleRecords(thoughtRows);
  const current = await lifecycles.findByResourceKeys(
    expected.map(row => row.resourceKey)
  );
  const keys = new Set(current.map(row => row.resourceKey));
  for (const row of expected) {
    if (!keys.has(row.resourceKey)) await lifecycles.insert(row);
  }
}

export async function markThoughtLifecycleDeleted(lifecycles, thoughtRows, entry) {
  const expected = thoughtLifecycleRecords(thoughtRows);
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
      state: "deleted",
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

export async function createThoughtStoreClosure(ports, input) {
  const store = { thoughts: [], captures: [] };
  const beforeRows = [];
  const source = input.sourceRef;
  const validSource = source?.type === "capture"
    && typeof source.id === "string"
    && source.id
    && Number.isSafeInteger(Number(source.version))
    && Number(source.version) > 0;
  if (!validSource) return { store, beforeRows };
  const captureKey = recordObjectKey("captures", source.id);
  const capture = await ports.objects.find(captureKey, { lock: true });
  if (capture) {
    store.captures.push(structuredClone(capture.payload));
    beforeRows.push(capture);
  }
  const rootKeys = await ports.relations.findSources([captureKey], {
    relation: "source",
    sourceCollection: "thoughts"
  });
  const roots = await ports.objects.findMany(rootKeys, { lock: true });
  store.thoughts.push(...roots.map(row => structuredClone(row.payload)));
  beforeRows.push(...roots);
  return { store, beforeRows };
}
