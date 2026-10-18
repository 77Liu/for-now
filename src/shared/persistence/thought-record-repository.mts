/**
 * 思绪持久化闭包、图映射及事务内 typed repository；业务生命周期由思绪领域处理。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, EntityRow, Mapping, StoreMapping, RecordEntity, RecordStore, RecordTransaction } from "./record-command-types.mjs";
import { entityRow, recordObjectKey, recordBusinessIdentity } from "./record-command-types.mjs";
/** Binds the graph mapper to typed query/write operations. @since unreleased */
export function createThoughtRecordRepository(mapping: StoreMapping) {
  const { canonicalJson, mapStoreObjects, rebuildStoreObjects } = mapping;
  const conflict = () => Object.assign(
    new Error("思绪已变化，请刷新后重试"),
    { statusCode: 409, code: "VERSION_CONFLICT" }
  );
  const orderTuple = (row: ObjectRow) => [
    String(row.payload?.occurredAt || row.payload?.occurredOn || row.payload?.createdAt || ""),
    String(row.id || "")
  ];

  function normalizedClosureRows(rows: ObjectRow[]) {
    const groups = new Map<string, ObjectRow[]>();
    for (const row of rows) {
      const group = JSON.stringify([row.parentKey, row.field]);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(row);
    }
    const normalized = [];
    for (const group of groups.values()) {
      const positioned = group.every(row => Number.isInteger(row.position));
      group.sort(positioned
        ? (left, right) => Number(left.position) - Number(right.position)
        : (left, right) => {
            const a = orderTuple(left), b = orderTuple(right);
            return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
          });
      normalized.push(...group.map((row, position) => ({ ...row, position })));
    }
    return normalized;
  }

  function rebuildRecordCollections(rows: ObjectRow[], collections: string[]) {
    return rebuildStoreObjects({
      fields: collections.map(field => ({ field, shape: "array", payload: null })),
      objects: normalizedClosureRows(rows)
    });
  }

  async function readThoughtClosure(objects: RecordTransaction["objects"], relations: RecordTransaction["relations"], id: string) {
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

  /** 按顶层内容身份解析所属思绪，只加载该根及必要子项。 @since unreleased */
  async function readThoughtTargetClosure(ports: RecordTransaction, id: string, { forDeletion = false } = {}) {
    const target = await ports.objects.find(recordObjectKey("thoughts", id));
    if (!target) return null;
    const rootId = target.payload.type === "question"
      ? target.id
      : typeof target.payload.relatedTo === "string" ? target.payload.relatedTo : "";
    if (!rootId) {
      const rows = await ports.objects.findTree([target.objectKey], { lock: true });
      return {
        rootKey: target.objectKey,
        rows,
        store: rebuildRecordCollections(rows, ["thoughts"]),
        thoughts: rebuildRecordCollections(rows, ["thoughts"]).thoughts
      };
    }
    if (forDeletion) return readThoughtDeleteClosure(ports, rootId);
    const closure = await readThoughtClosure(ports.objects, ports.relations, rootId);
    return closure ? {
      ...closure,
      store: rebuildRecordCollections(closure.rows, ["thoughts"])
    } : null;
  }

  const comparable = (row: ObjectRow) => canonicalJson({
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

  async function removeRows(ports: RecordTransaction, rows: ObjectRow[]) {
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

  async function insertRows(ports: RecordTransaction, mapping: Mapping, rows: EntityRow[]) {
    const inserted = new Set(rows.map(row => row.objectKey));
    for (const collection of new Set(rows.map(row => row.collection))) {
      const singleton = rows.some(row => row.collection === collection
        && JSON.parse(row.objectKey).length === 1);
      await ports.objects.ensureCollection(collection, singleton ? "object" : "array");
    }
    for (const row of rows) await ports.objects.insert({ ...row, position: null });
    for (const relation of mapping.relations) {
      if (inserted.has(relation.objectKey)) await ports.relations.insert(relation);
    }
    for (const attachment of mapping.attachmentRefs) {
      if (attachment.ownerKey && inserted.has(attachment.ownerKey)) await ports.attachments.insert(attachment);
    }
  }

  function mappedUpdate(current: ObjectRow, row: EntityRow) {
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

  async function refreshIndexes(ports: RecordTransaction, mapping: Mapping, objectKeys: Set<string>) {
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

  async function persistMappedClosure(
    ports: RecordTransaction,
    accountId: string,
    beforeRows: ObjectRow[],
    store: RecordStore,
    {
      managedCollections = Object.keys(store),
      refreshIndexesForCollections = []
    }: { managedCollections?: string[]; refreshIndexesForCollections?: string[] } = {}
  ) {
    const mapping = mapStoreObjects(accountId, store);
    const managed = new Set(managedCollections);
    const previousRows = beforeRows.filter(row => managed.has(row.collection));
    const mappedRows = mapping.objects.filter(row => managed.has(row.collection));
    const before = new Map(previousRows.map(row => [row.objectKey, row]));
    const beforeIdentity = new Map(previousRows.map(row => [recordBusinessIdentity(row), row]));
    const after = new Map(mappedRows.map(row => [row.objectKey, row]));
    const persistedRows: ObjectRow[] = [];
    const refreshedIndexes = new Set<string>();
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
      if (refreshCollections.has(row.collection)
        || current.content !== next.content
        || canonicalJson(current.payload?.attachmentPaths || []) !== canonicalJson(next.payload?.attachmentPaths || [])) {
        refreshedIndexes.add(row.objectKey);
      }
      persistedRows.push(next);
    }
    const insertedRows = mappedRows
      .filter(row => !before.has(row.objectKey))
      .map(row => {
        const previous = beforeIdentity.get(recordBusinessIdentity(row));
        return {
          ...(previous ? mappedUpdate(previous, row) : row),
          position: null
        };
      });
    await insertRows(ports, mapping, insertedRows);
    await refreshIndexes(ports, mapping, refreshedIndexes);
    return [...persistedRows, ...insertedRows];
  }

  async function readThoughtDeleteClosure(ports: RecordTransaction, id: string) {
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

  async function createThoughtStoreClosure(ports: RecordTransaction, input: { sourceRef?: RecordEntity["sourceRef"] }) {
    const store: RecordStore = { thoughts: [], captures: [] };
    const beforeRows: ObjectRow[] = [];
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
      store.captures.push(structuredClone(entityRow(capture).payload));
      beforeRows.push(capture);
    }
    const rootKeys = await ports.relations.findSources([captureKey], {
      relation: "source",
      sourceCollection: "thoughts"
    });
    const roots = await ports.objects.findMany(rootKeys, { lock: true });
    store.thoughts.push(...roots.map(row => structuredClone(entityRow(row).payload)));
    beforeRows.push(...roots);
    return { store, beforeRows };
  }

  return {
    rebuildRecordCollections,
    readThoughtClosure,
    readThoughtTargetClosure,
    readThoughtDeleteClosure,
    persistMappedClosure,
    createThoughtStoreClosure
  };
}
export type ThoughtRecordRepository = ReturnType<typeof createThoughtRecordRepository>;
