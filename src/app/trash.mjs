import { recordVersion } from "../shared/validation/index.mjs";
import { collectAttachmentPaths } from "../shared/attachments/index.mjs";
import { revokeEvidencePermissionsForResource } from "../modules/user-model/index.mjs";

const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const speechSourceKey = (sourceType, sourceId) => `${sourceType}\u0000${sourceId}`;

function speechSourcesInTrash(entries) {
  const sources = new Set();
  const thoughtBlockIds = new Set();
  for (const entry of entries) {
    if (entry?.type === "capture" && entry.payload?.id) {
      sources.add(speechSourceKey("capture", entry.payload.id));
    }
    if (entry?.type === "thoughtBlock" && entry.payload?.id) {
      thoughtBlockIds.add(entry.payload.id);
      if (entry.payload.type === "answer") {
        sources.add(speechSourceKey("thoughtAnswer", entry.payload.id));
      }
    }
    if (entry?.type === "thoughtChain") {
      if (entry.payload?.id) {
        sources.add(speechSourceKey("thoughtChain", entry.payload.id));
      }
      for (const record of Array.isArray(entry.payload?.items) ? entry.payload.items : []) {
        if (record?.item?.type === "answer" && record.item.id) {
          sources.add(speechSourceKey("thoughtAnswer", record.item.id));
        }
      }
    }
  }
  return { sources, thoughtBlockIds };
}

function speechCacheForTrash(store, entries) {
  const { sources, thoughtBlockIds } = speechSourcesInTrash(entries);
  return (Array.isArray(store.speechCache) ? store.speechCache : []).filter(entry => (
    sources.has(speechSourceKey(entry?.sourceType, entry?.sourceId))
    || (
      entry?.sourceType === "thoughtChain"
      && Object.values(entry.sourceVersions || {}).some(source => (
        thoughtBlockIds.has(source?.id)
      ))
    )
  ));
}

export function createTrashMutations({
  trash,
  annotations,
  now,
  getAccountId,
  cancelTask = () => {}
}) {
  if (typeof getAccountId !== "function") {
    throw new TypeError("Trash mutations require an account resolver");
  }
  const advance = record => { record.version = recordVersion(record.version) + 1; record.updatedAt = now(); };
  const insert = (items, index, item) => items.splice(Math.min(Math.max(0, Number(index) || 0), items.length), 0, structuredClone(item));
  const resourceTypes = {
    thoughts: "thought", captures: "capture", journals: "journal", chats: "chat",
    analyses: "analysis", books: "book", quotes: "quote", checkins: "checkin",
    dailyRecords: "dailyRecord", keepsakes: "keepsake", experiments: "experiment",
    customMetrics: "customMetric", actions: "action", habits: "habit",
    habitCheckins: "habitCheckin", feedback: "feedback",
    validationLedger: "validationLedger", userClaims: "userClaim",
    modelUnknowns: "modelUnknown"
  };
  const revokeEvidence = (store, collection, id, targetId = "") => {
    store.evidencePermissions ||= [];
    return revokeEvidencePermissionsForResource(store, {
      accountId: getAccountId(),
      resourceType: resourceTypes[collection] || collection,
      resourceId: id,
      targetId
    }, now());
  };
  const cancelAiTasks = (store, matches) => {
    const runningTaskIds = [];
    for (const task of store.aiTasks || []) {
      if (!["queued", "running", "cancelling"].includes(task.status) || !matches(task)) continue;
      const timestamp = now(), queued = task.status === "queued";
      Object.assign(task, {
        status: queued ? "cancelled" : "cancelling",
        updatedAt: timestamp,
        error: queued ? "目标已删除，任务未调用" : "目标已删除，正在停止生成"
      });
      if (queued) task.completedAt = timestamp;
      else {
        task.cancellationRequestedAt ||= timestamp;
        runningTaskIds.push(task.id);
      }
      const notification = (store.notifications || []).find(item => item.taskId === task.id);
      if (notification) Object.assign(notification, {
        status: task.status,
        message: task.error,
        updatedAt: timestamp,
        ...(queued ? { readAt: "" } : {})
      });
    }
    return runningTaskIds;
  };
  const cancelTargetTasks = (store, collection, id) => {
    const resourceType = resourceTypes[collection];
    return resourceType ? cancelAiTasks(store, task => (
      (task.resourceType || (["thoughtAnswer", "followUpAnswer"].includes(task.kind) ? "thought" : "")) === resourceType
      && task.targetId === id
    )) : [];
  };
  const cancelSubtargetTasks = (store, collection, parentId, ids) => {
    const resourceType = resourceTypes[collection], subtargetIds = new Set(ids.filter(Boolean));
    if (resourceType && subtargetIds.size) {
      return cancelAiTasks(store, task => (
        (task.resourceType || (["thoughtAnswer", "followUpAnswer"].includes(task.kind) ? "thought" : "")) === resourceType
        && task.targetId === parentId && subtargetIds.has(task.subtargetId)
      ));
    }
    return [];
  };
  const afterCommit = (entry, taskIds) => {
    if (entry && taskIds.length) {
      const previous = entry[AFTER_COMMIT];
      Object.defineProperty(entry, AFTER_COMMIT, {
        value: () => {
          previous?.();
          taskIds.forEach(cancelTask);
        },
        configurable: true
      });
    }
    return entry;
  };

  function moveCollectionItemToTrash(store, collection, type, id) {
    const items = store[collection], index = items.findIndex(item => item.id === id);
    if (index < 0) return trash.find(store.trash, type, id);
    const runningTaskIds = cancelTargetTasks(store, collection, id);
    if (collection === "journals" && store.journalDraft?.journalId === id) store.journalDraft.journalId = "";
    revokeEvidence(store, collection, id);
    const [payload] = items.splice(index, 1);
    return afterCommit(trash.add(store.trash, type, payload, { kind: "collection", collection, index }), runningTaskIds);
  }

  function moveNestedItemToTrash(store, { parentCollection, parentId, field, type, id, annotationTargetKeys = [] }) {
    const parent = store[parentCollection]?.find(item => item.id === parentId);
    if (!parent) return trash.find(store.trash, type, id);
    const items = Array.isArray(parent[field]) ? parent[field] : [], index = items.findIndex(item => item.id === id);
    if (index < 0) return trash.find(store.trash, type, id);
    const [payload] = items.splice(index, 1);
    revokeEvidence(store, parentCollection, parentId, id);
    const entry = trash.add(store.trash, type, payload, { kind: "nested", parentCollection, parentId, field, index });
    entry.dependents = annotations.detachTargets(parent, annotationTargetKeys);
    const runningTaskIds = cancelSubtargetTasks(store, parentCollection, parentId, [
      ...(field === "followUps" || field === "annotations" ? [id] : []),
      ...(entry.dependents.annotations || []).map(item => item.id)
    ]);
    advance(parent);
    return afterCommit(entry, runningTaskIds);
  }

  function moveThoughtChainToTrash(store, id) {
    const indexed = store.thoughts.map((item, index) => ({ item, index })).filter(({ item }) => item.id === id || item.relatedTo === id);
    if (!indexed.length) return trash.find(store.trash, "thoughtChain", id);
    const ids = new Set(indexed.map(({ item }) => item.id));
    const runningTaskIds = cancelAiTasks(store, task => (
      (task.resourceType || (["thoughtAnswer", "followUpAnswer"].includes(task.kind) ? "thought" : "")) === "thought"
      && ids.has(task.targetId)
    ));
    for (const sourceId of ids) revokeEvidence(store, "thoughts", sourceId);
    store.thoughts = store.thoughts.filter(item => !ids.has(item.id));
    return afterCommit(trash.add(store.trash, "thoughtChain", { id, items: indexed }, { kind: "thoughtChain" }), runningTaskIds);
  }

  function moveThoughtBlockToTrash(store, id) {
    const item = store.thoughts.find(value => value.id === id);
    if (!item || item.type === "question") return trash.find(store.trash, "thoughtBlock", id);
    const root = store.thoughts.find(value => value.id === item.relatedTo && value.type === "question");
    const dependents = root ? annotations.detachTargets(root, [`${item.type}:${item.id}`]) : { annotations: [], annotationDrift: [] };
    const runningTaskIds = [
      ...cancelTargetTasks(store, "thoughts", id),
      ...cancelSubtargetTasks(store, "thoughts", item.relatedTo, (dependents.annotations || []).map(value => value.id))
    ];
    const entry = moveCollectionItemToTrash(store, "thoughts", "thoughtBlock", id);
    entry.location.parentId = item.relatedTo;
    entry.dependents = dependents;
    if (root) advance(root);
    return afterCommit(entry, runningTaskIds);
  }

  function restoreTrashEntry(store, id) {
    const entry = trash.get(store.trash, id);
    if (!entry) return { missing: true };
    const location = entry.location || {};
    if (location.kind === "collection") {
      const items = store[location.collection];
      if (!Array.isArray(items)) return { invalid: true };
      if (items.some(item => item.id === entry.payload.id)) return { conflict: true };
      if (entry.payload.clientRequestId && items.some(item => item.clientRequestId === entry.payload.clientRequestId)) {
        return { conflict: true };
      }
      if (entry.type === "habitCheckin" && items.some(item => (
        item.habitId === entry.payload.habitId && item.occurredOn === entry.payload.occurredOn
      ))) return { conflict: true };
      const parent = entry.type === "thoughtBlock" && location.parentId
        ? store.thoughts.find(item => item.id === location.parentId && item.type === "question")
        : location.parentCollection && location.parentId
          ? store[location.parentCollection]?.find(item => item.id === location.parentId)
          : null;
      if (location.parentId && !parent) return { parentMissing: true };
      const restored = structuredClone(entry.payload);
      // Whole-record restoration must invalidate annotation and foreground AI work too.
      advance(restored);
      insert(items, location.index, restored);
      if (entry.type === "thoughtBlock" && parent) {
        annotations.restoreDependents(parent, entry.dependents);
        advance(parent);
      }
    } else if (location.kind === "nested") {
      const parent = store[location.parentCollection]?.find(item => item.id === location.parentId);
      if (!parent) return { parentMissing: true };
      parent[location.field] ||= [];
      if (parent[location.field].some(item => item.id === entry.payload.id)) return { conflict: true };
      insert(parent[location.field], location.index, entry.payload);
      annotations.restoreDependents(parent, entry.dependents);
      advance(parent);
    } else if (location.kind === "thoughtChain") {
      const records = Array.isArray(entry.payload?.items) ? entry.payload.items : [];
      const ids = new Set(records.map(record => record.item?.id).filter(Boolean));
      if (!records.length) return { invalid: true };
      if (store.thoughts.some(item => ids.has(item.id))) return { conflict: true };
      const root = records.find(record => record.item?.id === entry.resourceId && record.item?.type === "question")?.item;
      if (root?.sourceRef?.type === "capture" && store.thoughts.some(item => (
        item.type === "question" && item.sourceRef?.type === "capture" && item.sourceRef.id === root.sourceRef.id
      ))) return { conflict: true };
      for (const record of [...records].sort((a, b) => Number(a.index) - Number(b.index))) {
        const restored = structuredClone(record.item);
        if (restored.id === entry.resourceId && restored.type === "question") advance(restored);
        insert(store.thoughts, record.index, restored);
      }
    } else if (location.kind === "captureAudio") {
      const parent = store[location.parentCollection]?.find(item => item.id === location.parentId);
      if (!parent) return { parentMissing: true };
      if (parent.audio) return { conflict: true };
      parent.audio = structuredClone(entry.payload.audio);
      parent.transcription = structuredClone(entry.payload.transcription);
      advance(parent);
    } else return { invalid: true };
    trash.remove(store.trash, [id]);
    return { value: entry };
  }

  return { moveCollectionItemToTrash, moveNestedItemToTrash, moveThoughtChainToTrash, moveThoughtBlockToTrash, restoreTrashEntry };
}

export function createTrashCommands({ repository, trash, mutations, cleanup }) {
  return {
    async list() { return { retentionDays: trash.retentionDays, items: (await repository.read()).trash }; },
    restore(id) { return repository.update(store => mutations.restoreTrashEntry(store, id)); },
    async preview(ids) {
      const store = await repository.read();
      const entries = trash.expanded(store.trash, ids.length ? ids : store.trash.map(item => item.id));
      return {
        ...trash.plan(entries),
        attachmentPaths: [...collectAttachmentPaths([
          ...entries,
          ...speechCacheForTrash(store, entries)
        ])],
        requiresConfirmation: "永久删除"
      };
    },
    purge(ids, expectedPlanHash) {
      return repository.transact(async ({ document: store, commit }) => {
        const entries = trash.expanded(store.trash, ids), plan = trash.plan(entries);
        if (!entries.length) return { missing: true };
        if (expectedPlanHash !== plan.planHash) return { changed: true, plan };
        trash.remove(store.trash, entries.map(item => item.id));
        const speechEntries = speechCacheForTrash(store, entries);
        if (speechEntries.length) {
          const removed = new Set(speechEntries);
          store.speechCache = store.speechCache.filter(entry => !removed.has(entry));
        }
        cleanup.enqueue(store, collectAttachmentPaths([...entries, ...speechEntries]));
        await commit();
        const result = await cleanup.drain(store);
        if (result.attempted) await commit();
        if (result.pending) cleanup.schedule();
        return { entries, plan, attachments: result.removed, attachmentCleanupPending: result.pending };
      });
    }
  };
}
