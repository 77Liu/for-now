export const CONTENT_IMAGE_DRAFT_KEYS = Object.freeze([
  "capture",
  "thoughtRoot",
  "thoughtBlock",
  "comment"
]);

const KEEP_CONTEXT = Symbol("keep-context");

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Content image draft manager requires ${name}`);
  }
  return value;
}

function copyContext(value) {
  return value == null ? value : structuredClone(value);
}

function copyItem(item) {
  return {
    ...item,
    ...(item.lastError ? { lastError: { ...item.lastError } } : {})
  };
}

function emptyDraft() {
  return {
    items: [],
    uploadRequestId: "",
    context: null,
    revision: 0
  };
}

function hasDraft(draft) {
  return Boolean(
    draft
    && (draft.items.length || draft.uploadRequestId || draft.context != null)
  );
}

function leaseIdentity(owner, item, fallbackRequestId = "") {
  const path = String(item?.uploadedPath || "");
  const requestId = String(item?.uploadRequestId || fallbackRequestId || "");
  return path && requestId ? JSON.stringify([owner, path, requestId]) : "";
}

export function isUncertainContentImageSubmission(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return !status || [408, 425, 429].includes(status) || status >= 500;
}

export function createContentImageDraftManager({
  store,
  draftKeys = CONTENT_IMAGE_DRAFT_KEYS,
  maxItems = 2,
  validateFiles,
  uploadPendingItems,
  uploadItem,
  discardItem,
  createFile = (parts, name, options) => new File(parts, name, options),
  objectUrls = globalThis.URL,
  createId = () => crypto.randomUUID(),
  now = () => Date.now()
} = {}) {
  requireFunction(store?.get, "store.get");
  requireFunction(store?.put, "store.put");
  requireFunction(store?.delete, "store.delete");
  requireFunction(validateFiles, "validateFiles");
  requireFunction(uploadPendingItems, "uploadPendingItems");
  requireFunction(uploadItem, "uploadItem");
  requireFunction(discardItem, "discardItem");
  requireFunction(createFile, "createFile");
  requireFunction(objectUrls?.createObjectURL, "objectUrls.createObjectURL");
  requireFunction(objectUrls?.revokeObjectURL, "objectUrls.revokeObjectURL");
  requireFunction(createId, "createId");
  requireFunction(now, "now");
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError("Content image draft maxItems must be a positive integer");
  }

  const keys = [...new Set(draftKeys.map(value => String(value || "")))];
  if (!keys.length || keys.some(key => !key)) {
    throw new TypeError("Content image draft keys must be non-empty strings");
  }
  const allowedKeys = new Set(keys);
  const ownedPreviews = new Set();
  const revokedPreviews = new Set();
  const successfulLeases = new Set();
  const pendingLeases = new Map();
  const storeQueues = new Map();
  let owner = "";
  let generation = 0;
  let drafts = new Map(keys.map(key => [key, emptyDraft()]));

  const requireKey = value => {
    const key = String(value || "");
    if (!allowedKeys.has(key)) {
      throw new RangeError(`Unknown content image draft key: ${key}`);
    }
    return key;
  };
  const ticket = () => ({ owner, generation });
  const isCurrent = operation => Boolean(
    operation
    && operation.owner === owner
    && operation.generation === generation
  );
  const currentDraft = key => drafts.get(requireKey(key));
  const nextDraft = (key, value) => {
    const current = currentDraft(key);
    const next = {
      ...current,
      ...value,
      revision: current.revision + 1
    };
    drafts.set(key, next);
    return next;
  };
  const createPreview = file => {
    const preview = objectUrls.createObjectURL(file);
    ownedPreviews.add(preview);
    return preview;
  };
  const revokeItem = item => {
    const preview = String(item?.preview || "");
    if (!preview || !ownedPreviews.has(preview) || revokedPreviews.has(preview)) {
      return false;
    }
    revokedPreviews.add(preview);
    objectUrls.revokeObjectURL(preview);
    return true;
  };
  const revokeItems = items => {
    for (const item of items) revokeItem(item);
  };
  const clearMemory = () => {
    for (const draft of drafts.values()) revokeItems(draft.items);
    generation += 1;
    drafts = new Map(keys.map(key => [key, emptyDraft()]));
  };

  function publicDraft(key) {
    const value = currentDraft(key);
    return Object.freeze({
      owner,
      key,
      items: Object.freeze(value.items.map(item => Object.freeze(copyItem(item)))),
      uploadRequestId: value.uploadRequestId,
      context: copyContext(value.context)
    });
  }

  function snapshot(key) {
    if (key != null) return publicDraft(requireKey(key));
    return Object.freeze({
      owner,
      drafts: Object.freeze(Object.fromEntries(
        keys.map(value => [value, publicDraft(value)])
      ))
    });
  }

  function queueStore(operation, key, action, { currentOnly = true } = {}) {
    const queueKey = JSON.stringify([operation.owner, key]);
    const previous = storeQueues.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (currentOnly && !isCurrent(operation)) return false;
      await action();
      return true;
    });
    storeQueues.set(queueKey, task);
    void task.then(
      () => {
        if (storeQueues.get(queueKey) === task) storeQueues.delete(queueKey);
      },
      () => {
        if (storeQueues.get(queueKey) === task) storeQueues.delete(queueKey);
      }
    );
    return task;
  }

  function storedRecord(operation, key, draft) {
    if (!hasDraft(draft)) return null;
    return {
      owner: operation.owner,
      id: key,
      uploadRequestId: draft.uploadRequestId,
      updatedAt: new Date(now()).toISOString(),
      context: copyContext(draft.context),
      items: draft.items.map(item => item.path ? { path: item.path } : {
        blob: item.file,
        name: item.file?.name || "image",
        type: item.file?.type || "application/octet-stream",
        lastModified: Number(item.file?.lastModified) || now(),
        uploadRequestId: item.uploadRequestId || "",
        uploadedPath: item.uploadedPath || "",
        lastError: item.lastError ? { ...item.lastError } : null
      })
    };
  }

  function persistDraft(operation, key, draft, options) {
    if (!operation.owner) return Promise.resolve(false);
    const record = storedRecord(operation, key, draft);
    return queueStore(
      operation,
      key,
      () => record
        ? store.put(record)
        : store.delete(operation.owner, key),
      options
    );
  }

  function deleteStored(operation, key) {
    if (!operation.owner) return Promise.resolve(false);
    return queueStore(
      operation,
      key,
      () => store.delete(operation.owner, key),
      { currentOnly: false }
    );
  }

  async function discardLease(operation, item, fallbackRequestId = "") {
    const identity = leaseIdentity(operation.owner, item, fallbackRequestId);
    if (!identity) return false;
    if (successfulLeases.has(identity)) return true;
    if (pendingLeases.has(identity)) return pendingLeases.get(identity);
    const pending = Promise.resolve()
      .then(() => discardItem(item, fallbackRequestId, {
        owner: operation.owner,
        key: item.key || ""
      }))
      .then(result => {
        if (result === true) successfulLeases.add(identity);
        return result === true;
      })
      .catch(() => false);
    pendingLeases.set(identity, pending);
    void pending.finally(() => pendingLeases.delete(identity));
    return pending;
  }

  async function restore(nextOwner) {
    clearMemory();
    owner = String(nextOwner || "");
    const operation = ticket();
    if (!owner) return false;
    for (const key of keys) {
      const stored = await store.get(operation.owner, key);
      if (!isCurrent(operation)) return false;
      if (!stored || (stored.owner && stored.owner !== operation.owner)) continue;
      const storedItems = Array.isArray(stored.items) ? stored.items : [];
      if (!storedItems.length && stored.context == null) continue;
      const restoredItems = [];
      try {
        for (const item of storedItems.slice(0, maxItems)) {
          if (item.path) {
            restoredItems.push({ path: item.path });
            continue;
          }
          if (!item.blob) throw new Error("图片草稿缺少可恢复内容");
          const file = createFile([item.blob], item.name || "image", {
            type: item.type || item.blob?.type || "",
            lastModified: Number(item.lastModified) || now()
          });
          restoredItems.push({
            file,
            preview: createPreview(file),
            uploadRequestId: item.uploadRequestId || "",
            uploadedPath: item.uploadedPath || "",
            lastError: item.lastError ? { ...item.lastError } : null
          });
        }
      } catch (error) {
        revokeItems(restoredItems);
        throw error;
      }
      if (!isCurrent(operation)) {
        revokeItems(restoredItems);
        return false;
      }
      nextDraft(key, {
        items: restoredItems,
        uploadRequestId: stored.uploadRequestId || "",
        context: copyContext(stored.context ?? null)
      });
    }
    return true;
  }

  async function persist(key, context = KEEP_CONTEXT) {
    key = requireKey(key);
    const operation = ticket();
    if (!operation.owner) return false;
    const current = context === KEEP_CONTEXT
      ? currentDraft(key)
      : nextDraft(key, { context: copyContext(context) });
    return persistDraft(operation, key, current);
  }

  async function replaceExisting(key, paths = [], {
    context = null,
    compensate = true,
    preserveStored = false
  } = {}) {
    key = requireKey(key);
    const operation = ticket();
    const previous = currentDraft(key);
    const normalized = [...new Set(paths)]
      .filter(path => typeof path === "string" && path)
      .slice(0, maxItems);
    revokeItems(previous.items);
    nextDraft(key, {
      items: normalized.map(path => ({ path })),
      uploadRequestId: "",
      context: copyContext(context)
    });
    const deletion = preserveStored
      ? Promise.resolve(false)
      : deleteStored(operation, key);
    if (compensate) {
      await Promise.all(previous.items.map(
        item => discardLease(operation, item, previous.uploadRequestId)
      ));
    }
    await deletion;
    return snapshot(key);
  }

  async function select(key, files) {
    key = requireKey(key);
    const operation = ticket();
    if (!operation.owner) return false;
    const previous = currentDraft(key);
    const existing = previous.items.filter(item => item.path);
    const selected = validateFiles(files, Math.max(0, maxItems - existing.length));
    const selectedItems = [];
    try {
      for (const file of selected) {
        selectedItems.push({ file, preview: createPreview(file) });
      }
    } catch (error) {
      revokeItems(selectedItems);
      throw error;
    }
    const replaced = previous.items.filter(item => !item.path);
    revokeItems(replaced);
    const current = nextDraft(key, {
      items: [...existing, ...selectedItems],
      uploadRequestId: ""
    });
    await persistDraft(operation, key, current);
    await Promise.all(replaced.map(
      item => discardLease(operation, item, previous.uploadRequestId)
    ));
    return snapshot(key);
  }

  async function submit(key) {
    key = requireKey(key);
    const operation = ticket();
    if (!operation.owner) return false;
    let latestItems = currentDraft(key).items.map(copyItem);
    await persistDraft(operation, key, currentDraft(key));
    try {
      const result = await uploadPendingItems({
        items: latestItems,
        upload: uploadItem,
        createId,
        onProgress: async items => {
          latestItems = items.map(copyItem);
          if (!isCurrent(operation)) return;
          const current = nextDraft(key, { items: latestItems });
          await persistDraft(operation, key, current);
        }
      });
      if (!isCurrent(operation)) return false;
      const current = nextDraft(key, {
        items: result.items.map(copyItem)
      });
      await persistDraft(operation, key, current);
      return {
        attachmentPaths: [...result.attachmentPaths],
        uploadedPaths: [...result.uploadedPaths]
      };
    } catch (error) {
      if (isCurrent(operation)) {
        const current = nextDraft(key, { items: latestItems });
        await persistDraft(operation, key, current);
      }
      throw error;
    }
  }

  async function complete(key) {
    key = requireKey(key);
    const operation = ticket();
    const previous = currentDraft(key);
    if (!hasDraft(previous)) return false;
    revokeItems(previous.items);
    nextDraft(key, emptyDraft());
    await deleteStored(operation, key);
    return true;
  }

  async function rollback(key, error, { uploadedPaths } = {}) {
    key = requireKey(key);
    const operation = ticket();
    if (!operation.owner) return { retained: false, compensated: [], failed: [] };
    if (isUncertainContentImageSubmission(error)) {
      await persistDraft(operation, key, currentDraft(key));
      return { retained: true, compensated: [], failed: [] };
    }
    const filter = Array.isArray(uploadedPaths) ? new Set(uploadedPaths) : null;
    const current = currentDraft(key);
    const targets = current.items.filter(item => (
      item.uploadedPath && (!filter || filter.has(item.uploadedPath))
    ));
    const results = await Promise.all(targets.map(async item => ({
      path: item.uploadedPath,
      identity: leaseIdentity(operation.owner, item, current.uploadRequestId),
      discarded: await discardLease(operation, item, current.uploadRequestId)
    })));
    if (isCurrent(operation)) {
      const compensated = new Set(
        results.filter(result => result.discarded).map(result => result.identity)
      );
      const latest = currentDraft(key);
      const items = latest.items.map(item => {
        const identity = leaseIdentity(
          operation.owner,
          item,
          latest.uploadRequestId
        );
        return compensated.has(identity)
          ? { ...item, uploadedPath: "", uploadRequestId: "" }
          : item;
      });
      await persistDraft(operation, key, nextDraft(key, { items }));
    }
    return {
      retained: false,
      compensated: results.filter(result => result.discarded).map(result => result.path),
      failed: results.filter(result => !result.discarded).map(result => result.path)
    };
  }

  async function abandon(key) {
    key = requireKey(key);
    const operation = ticket();
    const previous = currentDraft(key);
    if (!hasDraft(previous)) return false;
    revokeItems(previous.items);
    nextDraft(key, emptyDraft());
    const deletion = deleteStored(operation, key);
    await Promise.all(previous.items.map(
      item => discardLease(operation, item, previous.uploadRequestId)
    ));
    await deletion;
    return true;
  }

  function resetSession() {
    const changed = Boolean(owner || [...drafts.values()].some(hasDraft));
    clearMemory();
    owner = "";
    return changed;
  }

  return Object.freeze({
    restore,
    snapshot,
    replaceExisting,
    select,
    persist,
    submit,
    complete,
    rollback,
    abandon,
    resetSession
  });
}
