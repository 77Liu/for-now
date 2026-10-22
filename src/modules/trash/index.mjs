import { safeText } from "../../shared/validation/index.mjs";

export function createTrashService({ createId, now, hash, retentionDays }) {
  const purged = entry => entry?.permanentlyPurged === true;
  const visible = entries => entries.filter(entry => !purged(entry));
  const accessible = entry => {
    if (purged(entry)) {
      throw Object.assign(new Error("该记录已永久清理，禁止删除或恢复"), {
        statusCode: 409, code: "RESOURCE_PERMANENTLY_PURGED"
      });
    }
    return entry;
  };
  const find = (entries, type, resourceId) => accessible(entries.find(item => (
    item.type === type && item.resourceId === resourceId
  ))) || null;
  const get = (entries, id) => accessible(entries.find(item => item.id === id));
  const resourceIdentity = entry => {
    const location = entry?.location || {};
    if (location.kind === "collection" && location.collection) {
      return JSON.stringify([location.collection, entry.resourceId]);
    }
    if (location.kind === "thoughtChain") {
      return JSON.stringify(["thoughts", entry.resourceId]);
    }
    if (location.kind === "nested" && location.parentCollection && location.field) {
      return JSON.stringify([`${location.parentCollection}.${location.field}`, entry.resourceId]);
    }
    return "";
  };
  // 旧记录可能只带 parentId；按条目类型限定可归属的顶层集合，避免同 ID 的书籍/日记等被串选。
  const nestedParentCollections = new Map([
    ["thoughtBlock", ["thoughts"]],
    ["thoughtRemark", ["thoughts"]],
    ["thoughtFollowUp", ["thoughts"]],
    ["annotation", ["thoughts", "captures", "journals", "chats", "analyses", "books", "quotes"]],
    ["annotationDrift", ["thoughts", "captures", "journals", "chats", "analyses", "books", "quotes"]],
    ["bookNote", ["books"]],
    ["journalReflection", ["journals"]],
    ["captureAudio", ["captures"]],
    ["habitCheckin", ["habits"]]
  ]);
  const parentIdentity = (entry, candidateParents) => {
    const location = entry?.location || {};
    const collection = location.parentCollection
      || (location.kind === "collection" ? location.collection : "");
    if (collection && location.parentId) {
      return JSON.stringify([collection, location.parentId]);
    }
    if (!location.parentId) return "";
    // 旧记录缺少所属集合时，只有类型唯一对应一个顶层集合才可推断。
    // 批注类可属于思绪、书籍等多个集合，仅凭回收站里同 ID 的父项会把批注并入其它类型；
    // 这类记录保留数据但必须等完整身份或可靠业务证据，不自动扩展。
    const allowedCollections = nestedParentCollections.get(entry?.type);
    if (!allowedCollections || allowedCollections.length !== 1) return "";
    const identity = JSON.stringify([allowedCollections[0], location.parentId]);
    return candidateParents.has(identity) ? identity : "";
  };

  function add(entries, type, payload, location) {
    const deletedAt = now();
    const entry = {
      id: createId(), type, resourceId: safeText(payload?.id, 100), deletedAt,
      purgeAfter: new Date(new Date(deletedAt).getTime() + retentionDays * 86400000).toISOString(),
      lifecycle: payload?.lifecycle === "draft" ? "draft" : "formal",
      lifecycleState: "deleted",
      tombstone: true,
      location,
      payload: structuredClone(payload)
    };
    entries.unshift(entry);
    return entry;
  }

  function expanded(entries, requestedIds) {
    for (const id of requestedIds) get(entries, id);
    entries = visible(entries);
    const selected = new Set(requestedIds), parentIds = new Set(), candidateParents = new Set();
    for (const entry of entries) {
      const identity = resourceIdentity(entry);
      if (identity) candidateParents.add(identity);
      if (selected.has(entry.id) && identity) parentIds.add(identity);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        const parent = parentIdentity(entry, candidateParents);
        if (!selected.has(entry.id) && parent && parentIds.has(parent)) {
          selected.add(entry.id);
          const identity = resourceIdentity(entry);
          if (identity) {
            parentIds.add(identity);
            candidateParents.add(identity);
          }
          changed = true;
        }
      }
    }
    return entries.filter(item => selected.has(item.id));
  }

  function plan(entries) {
    const items = entries.map(item => ({ id: item.id, type: item.type, resourceId: item.resourceId, deletedAt: item.deletedAt })).sort((a, b) => a.id.localeCompare(b.id));
    return { items, planHash: hash(JSON.stringify(items)) };
  }

  function remove(entries, ids) {
    const selected = new Set(ids);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (selected.has(entries[index].id)) entries.splice(index, 1);
    }
  }

  /** Marks retained records as permanently purged; payloads remain durable. @since unreleased */
  function purge(entries) {
    const purgedAt = now();
    for (const entry of entries) {
      accessible(entry);
      Object.assign(entry, {
        permanentlyPurged: true,
        lifecycleState: "purged",
        tombstone: true,
        purgedAt
      });
    }
  }

  return { find, get, add, expanded, plan, remove, purge, visible, retentionDays };
}
