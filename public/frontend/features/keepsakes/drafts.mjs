import {
  KEEPSAKE_BATCH_MAX_ITEMS,
  nextKeepsakeBatchIndex
} from "../keepsakes-media/index.mjs";
import { KEEPSAKE_BATCH_DRAFT_KEY } from "./model.mjs";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Keepsake drafts ${group} requires ${name}`);
    }
  }
}

export function createKeepsakeDrafts({
  state,
  store,
  data,
  platform,
  onChange = () => {},
  onError = () => {}
} = {}) {
  if (!state?.batch) throw new TypeError("Keepsake drafts require batch state");
  requireFunctions("store", {
    get: store?.get,
    put: store?.put,
    delete: store?.delete
  });
  requireFunctions("data port", {
    getAccountId: data?.getAccountId,
    getSessionSerial: data?.getSessionSerial
  });
  requireFunctions("platform port", {
    createFile: platform?.createFile,
    now: platform?.now,
    setTimer: platform?.setTimer,
    clearTimer: platform?.clearTimer,
    createObjectURL: platform?.objectUrls?.createObjectURL,
    revokeObjectURL: platform?.objectUrls?.revokeObjectURL
  });

  const batch = state.batch;
  let persistTimer = 0;
  let hydrated = false;
  const writeBarriers = new Map();
  const previewUrlsByItem = new Map();
  const nowMilliseconds = () => {
    const value = platform.now();
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.parse(value);
  };

  const currentOwner = () => String(data.getAccountId() || "");
  const ticket = () => ({
    owner: currentOwner(),
    serial: data.getSessionSerial(),
    generation: batch.generation
  });
  const isCurrent = candidate => Boolean(
    candidate
    && candidate.owner === currentOwner()
    && candidate.serial === data.getSessionSerial()
    && candidate.generation === batch.generation
  );
  const enqueueWrite = (owner, operation) => {
    const prior = writeBarriers.get(owner) || Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    writeBarriers.set(owner, pending);
    const clear = () => {
      if (writeBarriers.get(owner) === pending) writeBarriers.delete(owner);
    };
    void pending.then(clear, clear);
    return pending;
  };

  function activeItem() {
    return batch.items[batch.activeIndex] || null;
  }

  function cancelScheduledPersist() {
    if (persistTimer) platform.clearTimer(persistTimer);
    persistTimer = 0;
  }

  function revokePreviews() {
    for (const { url } of previewUrlsByItem.values()) {
      platform.objectUrls.revokeObjectURL(url);
    }
    previewUrlsByItem.clear();
    batch.previewUrls = [];
  }

  function prunePreviewUrls() {
    const activeItems = new Set(batch.items);
    const activeUrls = new Set();
    for (const [item, cached] of previewUrlsByItem) {
      if (activeItems.has(item) && cached.file === item.file) {
        activeUrls.add(cached.url);
        continue;
      }
      platform.objectUrls.revokeObjectURL(cached.url);
      previewUrlsByItem.delete(item);
    }
    batch.previewUrls = batch.previewUrls.filter(url => activeUrls.has(url));
  }

  function previewUrls() {
    prunePreviewUrls();
    batch.previewUrls = batch.items.map(item => {
      let cached = previewUrlsByItem.get(item);
      if (!cached || cached.file !== item.file) {
        cached = {
          file: item.file,
          url: platform.objectUrls.createObjectURL(item.file)
        };
        previewUrlsByItem.set(item, cached);
      }
      return cached.url;
    });
    return [...batch.previewUrls];
  }

  function storedRecord(owner = batch.owner || currentOwner()) {
    if (!owner || !batch.items.length) return null;
    return {
      owner,
      id: KEEPSAKE_BATCH_DRAFT_KEY,
      activeIndex: batch.activeIndex,
      updatedAt: platform.now(),
      items: batch.items.map(item => ({
        ...item,
        blob: item.file,
        name: item.file?.name || "keepsake",
        type: item.file?.type || "application/octet-stream",
        lastModified: Number(item.file?.lastModified) || nowMilliseconds(),
        file: undefined
      }))
    };
  }

  async function persist({ capture } = {}) {
    capture?.();
    const candidate = ticket();
    const owner = batch.owner || candidate.owner;
    const record = storedRecord(owner);
    if (!owner) return false;
    if (!record) {
      if (!hydrated) return false;
      await enqueueWrite(
        owner,
        () => store.delete(owner, KEEPSAKE_BATCH_DRAFT_KEY)
      );
      return isCurrent(candidate);
    }
    await enqueueWrite(owner, () => store.put(record));
    return isCurrent(candidate);
  }

  function schedulePersist({ capture } = {}) {
    capture?.();
    cancelScheduledPersist();
    const candidate = ticket();
    persistTimer = platform.setTimer(() => {
      persistTimer = 0;
      if (!isCurrent(candidate)) return;
      void persist().catch(error => {
        if (isCurrent(candidate)) onError(error);
      });
    }, 250);
    return persistTimer;
  }

  async function flush({ capture } = {}) {
    capture?.();
    cancelScheduledPersist();
    const owner = batch.owner || currentOwner();
    const record = storedRecord(owner);
    if (!owner) return false;
    if (!record) {
      if (!hydrated) return false;
      await enqueueWrite(
        owner,
        () => store.delete(owner, KEEPSAKE_BATCH_DRAFT_KEY)
      );
      return true;
    }
    await enqueueWrite(owner, () => store.put(record));
    return true;
  }

  function clearMemory({ notify = true } = {}) {
    batch.generation += 1;
    cancelScheduledPersist();
    revokePreviews();
    batch.owner = "";
    batch.items = [];
    batch.activeIndex = 0;
    batch.loading = false;
    hydrated = false;
    if (notify) onChange();
  }

  async function restore(owner = currentOwner()) {
    const normalizedOwner = String(owner || "");
    clearMemory({ notify: false });
    if (!normalizedOwner || normalizedOwner !== currentOwner()) {
      onChange();
      return false;
    }
    batch.owner = normalizedOwner;
    const candidate = ticket();
    let stored;
    try {
      stored = await store.get(normalizedOwner, KEEPSAKE_BATCH_DRAFT_KEY);
    } catch (error) {
      if (isCurrent(candidate) && batch.owner === normalizedOwner) onChange();
      throw error;
    }
    if (!isCurrent(candidate) || batch.owner !== normalizedOwner) return false;
    hydrated = true;
    if (!stored?.items?.length) {
      onChange();
      return false;
    }
    batch.items = stored.items.slice(0, KEEPSAKE_BATCH_MAX_ITEMS).map(item => {
      const { category: legacyCategory, ...draft } = item;
      void legacyCategory;
      return {
        ...draft,
        understandingState: item.understandingState === "ready" ? "ready" : "waiting",
        candidateRequestId: "",
        file: platform.createFile(
          item.blob,
          item.name || "keepsake",
          {
            type: item.type || item.blob?.type || "",
            lastModified: Number(item.lastModified) || nowMilliseconds()
          }
        ),
        blob: undefined
      };
    });
    batch.activeIndex = Math.max(
      0,
      Math.min(Number(stored.activeIndex) || 0, batch.items.length - 1)
    );
    onChange();
    return true;
  }

  function append(items) {
    if (!Array.isArray(items) || !items.length) return false;
    const wasEmpty = !batch.items.length;
    hydrated = true;
    batch.owner ||= currentOwner();
    batch.items = [...batch.items, ...items];
    if (wasEmpty) batch.activeIndex = 0;
    onChange();
    return true;
  }

  function remove(index) {
    const numericIndex = Number(index);
    const previousIndex = batch.activeIndex;
    const wasActive = numericIndex === previousIndex;
    const [item] = batch.items.splice(numericIndex, 1);
    if (!item) return null;
    hydrated = true;
    batch.activeIndex = wasActive
      ? nextKeepsakeBatchIndex(batch.items, numericIndex)
      : Math.max(0, previousIndex - (numericIndex < previousIndex ? 1 : 0));
    prunePreviewUrls();
    onChange();
    return { item, wasActive };
  }

  function select(index) {
    const numericIndex = Number(index);
    if (!batch.items[numericIndex]) return false;
    hydrated = true;
    batch.activeIndex = numericIndex;
    onChange();
    return true;
  }

  return Object.freeze({
    activeItem,
    append,
    remove,
    select,
    restore,
    persist,
    schedulePersist,
    cancelScheduledPersist,
    flush,
    clearMemory,
    resetSession: clearMemory,
    previewUrls,
    revokePreviews,
    generation: () => batch.generation,
    timerActive: () => Boolean(persistTimer)
  });
}
