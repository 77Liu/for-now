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
    const selected = new Set(requestedIds), parentIds = new Set();
    for (const entry of entries) if (selected.has(entry.id)) parentIds.add(entry.resourceId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        if (!selected.has(entry.id) && entry.location?.parentId && parentIds.has(entry.location.parentId)) {
          selected.add(entry.id);
          parentIds.add(entry.resourceId);
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
