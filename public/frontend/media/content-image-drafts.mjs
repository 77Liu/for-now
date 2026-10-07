import {
  CONTENT_IMAGE_DRAFT_KEYS,
  contentImageLeaseIdentity as leaseIdentity,
  copyDraftContext as copyContext,
  copyDraftItem as copyItem,
  emptyContentImageDraft as emptyDraft,
  hasContentImageDraft as hasDraft,
  isUncertainContentImageSubmission,
  rotateContentImageFile
} from "./content-image-draft-model.mjs";

export {
  CONTENT_IMAGE_DRAFT_KEYS,
  isUncertainContentImageSubmission,
  rotateContentImageFile
} from "./content-image-draft-model.mjs";

const KEEP_CONTEXT = Symbol("keep-context");
const DRAFT_ITEM_ID = Symbol("content-image-draft-item");

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Content image draft manager requires ${name}`);
  }
  return value;
}

export function createContentImageDraftManager({
  store,
  draftKeys = CONTENT_IMAGE_DRAFT_KEYS,
  maxItems = 2,
  validateFiles,
  uploadPendingItems,
  uploadItem,
  discardItem,
  rotateFile = rotateContentImageFile,
  createFile = (parts, name, options) => new File(parts, name, options),
  objectUrls = globalThis.URL,
  domRoot = globalThis.document,
  scheduleDomUpdate = callback => globalThis.queueMicrotask(callback),
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
  requireFunction(rotateFile, "rotateFile");
  requireFunction(createFile, "createFile");
  requireFunction(objectUrls?.createObjectURL, "objectUrls.createObjectURL");
  requireFunction(objectUrls?.revokeObjectURL, "objectUrls.revokeObjectURL");
  requireFunction(scheduleDomUpdate, "scheduleDomUpdate");
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
  const successfulLeases = new Set();
  const pendingLeases = new Map();
  const storeQueues = new Map();
  const draftQueues = new Map();
  const scheduledDomKeys = new Set();
  const rotatingDomItems = new Set();
  let owner = "";
  let generation = 0;
  let itemSequence = 0;
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
  const itemIdentity = item => {
    if (!item[DRAFT_ITEM_ID]) {
      Object.defineProperty(item, DRAFT_ITEM_ID, {
        value: ++itemSequence,
        enumerable: true
      });
    }
    return item[DRAFT_ITEM_ID];
  };
  const copyTrackedItem = item => {
    const copy = copyItem(item);
    if (item[DRAFT_ITEM_ID]) {
      Object.defineProperty(copy, DRAFT_ITEM_ID, {
        value: item[DRAFT_ITEM_ID]
      });
    }
    return copy;
  };
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
    if (!preview || !ownedPreviews.delete(preview)) return false;
    try {
      objectUrls.revokeObjectURL(preview);
    } catch (error) {
      ownedPreviews.add(preview);
      throw error;
    }
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

  function renderDomControls(key) {
    if (!domRoot?.querySelector || !domRoot?.createElement) return false;
    const editor = domRoot.querySelector(
      `[data-content-image-editor="${key}"]`
    );
    const previews = editor?.querySelector?.("[data-content-image-previews]");
    if (!previews?.querySelectorAll) return false;
    const items = currentDraft(key).items;
    const figures = [...previews.querySelectorAll(".content-image-preview")];
    for (const [index, figure] of figures.entries()) {
      const item = items[index];
      let button = figure.querySelector?.("[data-content-image-rotate]");
      if (!item?.file || item.path) {
        button?.remove?.();
        continue;
      }
      const image = figure.querySelector?.("img");
      if (image && item.preview) image.src = item.preview;
      if (!button) {
        button = domRoot.createElement("button");
        button.type = "button";
        button.textContent = "↻";
        button.title = "顺时针旋转图片";
        button.style.right = "36px";
        button.style.color = "var(--blue)";
        figure.append(button);
      }
      button.dataset.contentImageRotate = String(index);
      button.setAttribute("aria-label", `顺时针旋转图片 ${index + 1}`);
      const rotating = rotatingDomItems.has(item[DRAFT_ITEM_ID]);
      button.disabled = rotating;
      if (rotating) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    }
    return true;
  }

  function scheduleDomControls(key) {
    if (!domRoot?.querySelector || scheduledDomKeys.has(key)) return;
    scheduledDomKeys.add(key);
    scheduleDomUpdate(() => {
      scheduledDomKeys.delete(key);
      renderDomControls(key);
    });
  }

  async function handleDomRotation(event) {
    const button = event.target?.closest?.("[data-content-image-rotate]");
    const editor = button?.closest?.("[data-content-image-editor]");
    const key = String(editor?.dataset?.contentImageEditor || "");
    const index = Number(button?.dataset?.contentImageRotate);
    if (!button || !allowedKeys.has(key) || !Number.isSafeInteger(index)) return;
    const item = currentDraft(key).items[index];
    if (!item?.file || item.path) return;
    const identity = itemIdentity(item);
    const status = editor.closest?.("form")?.querySelector?.(".status");
    rotatingDomItems.add(identity);
    renderDomControls(key);
    try {
      const result = await rotate(key, index);
      if (result && status?.textContent?.startsWith("图片旋转失败：")) {
        status.textContent = "";
      }
    } catch (error) {
      if (status) {
        status.textContent = `图片旋转失败：${error?.message || "请稍后重试"}`;
      }
    } finally {
      rotatingDomItems.delete(identity);
      renderDomControls(key);
    }
  }

  function publicDraft(key) {
    const value = currentDraft(key);
    scheduleDomControls(key);
    return Object.freeze({
      owner,
      key,
      items: Object.freeze(value.items.map(item => {
        const copy = copyItem(item);
        delete copy[DRAFT_ITEM_ID];
        return Object.freeze(copy);
      })),
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

  function queueDraft(operation, key, action) {
    const queueKey = JSON.stringify([operation.owner, operation.generation, key]);
    const previous = draftQueues.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    draftQueues.set(queueKey, task);
    void task.then(
      () => {
        if (draftQueues.get(queueKey) === task) draftQueues.delete(queueKey);
      },
      () => {
        if (draftQueues.get(queueKey) === task) draftQueues.delete(queueKey);
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
        originalBlob: item.originalFile || item.file,
        originalName: item.originalFile?.name || item.file?.name || "image",
        originalType: item.originalFile?.type || item.file?.type
          || "application/octet-stream",
        originalLastModified: Number(
          item.originalFile?.lastModified || item.file?.lastModified
        ) || now(),
        quarterTurns: Number(item.quarterTurns) || 0,
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
          const storedTurns = Number(item.quarterTurns) || 0;
          const quarterTurns = item.originalBlob
            ? ((storedTurns % 4) + 4) % 4
            : 0;
          const originalFile = quarterTurns
            ? createFile([item.originalBlob], item.originalName || item.name || "image", {
              type: item.originalType || item.originalBlob?.type || item.type || "",
              lastModified: Number(
                item.originalLastModified || item.lastModified
              ) || now()
            })
            : file;
          restoredItems.push({
            file,
            originalFile,
            quarterTurns,
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

  function replaceTransient(key, value = {}) {
    key = requireKey(key);
    const previous = currentDraft(key);
    const items = (Array.isArray(value.items) ? value.items : [])
      .slice(0, maxItems)
      .map(item => {
        if (item.path) return { path: item.path };
        if (!item.file) throw new TypeError("Transient content image item requires file or path");
        const quarterTurns = ((Number(item.quarterTurns) || 0) % 4 + 4) % 4;
        return {
          ...copyItem(item),
          originalFile: item.originalFile || item.file,
          quarterTurns,
          preview: createPreview(item.file)
        };
      });
    revokeItems(previous.items);
    nextDraft(key, {
      items,
      uploadRequestId: String(value.uploadRequestId || ""),
      context: copyContext(value.context ?? null)
    });
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
        selectedItems.push({
          file,
          originalFile: file,
          quarterTurns: 0,
          preview: createPreview(file)
        });
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

  async function remove(key, index) {
    key = requireKey(key);
    if (!Number.isSafeInteger(index)) return false;
    const operation = ticket(), previous = currentDraft(key);
    if (!operation.owner || !previous.items[index]) return false;
    const items = previous.items.map(copyTrackedItem);
    const [removed] = items.splice(index, 1);
    revokeItem(removed);
    const current = nextDraft(key, { items });
    await Promise.all([persistDraft(operation, key, current),
      discardLease(operation, removed, previous.uploadRequestId)]);
    return snapshot(key);
  }

  async function rotate(key, index) {
    key = requireKey(key);
    if (!Number.isSafeInteger(index)) return false;
    const operation = ticket();
    const initial = currentDraft(key).items[index];
    if (!operation.owner || !initial?.file || initial.path) return false;
    const identity = itemIdentity(initial);
    return queueDraft(operation, key, async () => {
      if (!isCurrent(operation)) return false;
      const before = currentDraft(key);
      const itemIndex = before.items.findIndex(
        item => item[DRAFT_ITEM_ID] === identity
      );
      const item = before.items[itemIndex];
      if (itemIndex < 0 || !item?.file || item.path) return false;
      const sourceFile = item.file;
      const originalFile = item.originalFile || sourceFile;
      const quarterTurns = ((Number(item.quarterTurns) || 0) + 1) % 4;
      const rotatedFile = quarterTurns
        ? await rotateFile(originalFile, {
          direction: "clockwise",
          quarterTurns
        })
        : originalFile;
      if (!isCurrent(operation)) return false;
      if (!rotatedFile) throw new Error("图片旋转没有生成可用文件");
      const latest = currentDraft(key);
      const latestIndex = latest.items.findIndex(
        value => value[DRAFT_ITEM_ID] === identity
      );
      const latestItem = latest.items[latestIndex];
      if (latestIndex < 0 || latestItem?.file !== sourceFile || latestItem.path) {
        return false;
      }
      const replacement = {
        ...latestItem,
        file: rotatedFile,
        originalFile,
        quarterTurns,
        preview: "",
        uploadRequestId: "",
        uploadedPath: ""
      };
      Object.defineProperty(replacement, DRAFT_ITEM_ID, { value: identity });
      delete replacement.lastError;
      let adopted = false;
      try {
        replacement.preview = createPreview(rotatedFile);
        const items = latest.items.map((value, itemIndex) => (
          itemIndex === latestIndex ? replacement : value
        ));
        await persistDraft(operation, key, { ...latest, items });
        if (!isCurrent(operation)) return false;
        const current = currentDraft(key);
        const currentIndex = current.items.findIndex(
          value => value[DRAFT_ITEM_ID] === identity
        );
        const currentItem = current.items[currentIndex];
        if (currentIndex < 0 || currentItem?.file !== sourceFile || currentItem.path) {
          return false;
        }
        nextDraft(key, {
          items: current.items.map((value, itemIndex) => (
            itemIndex === currentIndex ? replacement : value
          ))
        });
        adopted = true;
        revokeItem(currentItem);
        await discardLease(operation, currentItem, current.uploadRequestId);
        return isCurrent(operation) ? snapshot(key) : false;
      } finally {
        if (!adopted) revokeItem(replacement);
      }
    });
  }

  async function submit(key) {
    key = requireKey(key);
    const operation = ticket();
    if (!operation.owner) return false;
    return queueDraft(operation, key, async () => {
      if (!isCurrent(operation)) return false;
      let latestItems = currentDraft(key).items.map(copyTrackedItem);
      await persistDraft(operation, key, currentDraft(key));
      try {
        const result = await uploadPendingItems({
          items: latestItems,
          upload: uploadItem,
          createId,
          onProgress: async items => {
            latestItems = items.map(copyTrackedItem);
            if (!isCurrent(operation)) return;
            const current = nextDraft(key, { items: latestItems });
            await persistDraft(operation, key, current);
          }
        });
        if (!isCurrent(operation)) return false;
        const current = nextDraft(key, {
          items: result.items.map(copyTrackedItem)
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
    });
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

  domRoot?.addEventListener?.("click", handleDomRotation);

  return Object.freeze({
    restore,
    snapshot,
    replaceExisting,
    replaceTransient,
    select,
    remove,
    rotate,
    persist,
    submit,
    complete,
    rollback,
    abandon,
    resetSession
  });
}
