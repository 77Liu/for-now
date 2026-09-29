import { safeText } from "../../shared/validation/index.mjs";

export function createTrashService({ createId, now, hash, retentionDays }) {
  const find = (entries, type, resourceId) => entries.find(item => item.type === type && item.resourceId === resourceId) || null;
  const get = (entries, id) => entries.find(item => item.id === id);

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

  return { find, get, add, expanded, plan, remove, retentionDays };
}
