export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_SELECTION_MAX_BYTES = 48 * 1024 * 1024;

export function validatedImageFiles(files, maxFiles = 1) {
  const list = [...files].slice(0, maxFiles);
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!list.length) throw new Error("没有找到可用图片");
  if ([...files].length > maxFiles) throw new Error(`最多选择 ${maxFiles} 张图片`);
  if (list.some(file => !allowed.has(file.type))) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  if (list.some(file => file.size > IMAGE_MAX_BYTES)) throw new Error("单张图片不得超过 8 MB");
  if (list.reduce((sum, file) => sum + file.size, 0) > IMAGE_SELECTION_MAX_BYTES) {
    throw new Error("本次图片合计不得超过 48 MB");
  }
  return list;
}

const clone = value => value == null ? value : structuredClone(value);
const draftKey = (owner, id) => `${owner}:${id}`;
const requestResult = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.addEventListener("complete", resolve, { once: true });
  transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  transaction.addEventListener("error", () => reject(transaction.error), { once: true });
});

export function createMemoryMediaDraftStore(initial = []) {
  const records = new Map(initial.map(record => [draftKey(record.owner, record.id), clone(record)]));
  return {
    async put(record) {
      records.set(draftKey(record.owner, record.id), clone(record));
      return clone(record);
    },
    async get(owner, id) {
      return clone(records.get(draftKey(owner, id)) || null);
    },
    async delete(owner, id) {
      records.delete(draftKey(owner, id));
    },
    async clear(owner) {
      for (const [key, record] of records) if (record.owner === owner) records.delete(key);
    }
  };
}

export function createIndexedDbMediaDraftStore({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = "cike-media-drafts",
  storeName = "drafts"
} = {}) {
  if (!indexedDBImpl) throw new Error("当前环境不支持 IndexedDB");
  const opening = indexedDBImpl.open(databaseName, 1);
  opening.addEventListener("upgradeneeded", () => {
    const db = opening.result;
    if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
  }, { once: true });
  const ready = requestResult(opening);
  void ready.catch(() => {});
  const withStore = async (mode, action) => {
    const db = await ready;
    const transaction = db.transaction(storeName, mode);
    const done = transactionDone(transaction);
    try {
      const result = await action(transaction.objectStore(storeName));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  };
  return {
    async put(record) {
      const value = { ...clone(record), key: draftKey(record.owner, record.id) };
      await withStore("readwrite", store => requestResult(store.put(value)));
      delete value.key;
      return value;
    },
    async get(owner, id) {
      const value = await withStore("readonly", store => requestResult(store.get(draftKey(owner, id))));
      if (!value) return null;
      delete value.key;
      return value;
    },
    async delete(owner, id) {
      await withStore("readwrite", store => requestResult(store.delete(draftKey(owner, id))));
    },
    async clear(owner) {
      await withStore("readwrite", async store => {
        const values = await requestResult(store.getAll());
        await Promise.all(values.filter(record => record.owner === owner).map(record => requestResult(store.delete(record.key))));
      });
    }
  };
}

export function imageRecordPayload({ content = "", attachmentPaths = [] } = {}, maxAttachments = 2) {
  const paths = [...new Set((Array.isArray(attachmentPaths) ? attachmentPaths : [])
    .filter(value => typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)))];
  if (paths.length > maxAttachments) throw new Error(`最多插入 ${maxAttachments} 张图片`);
  if (!String(content).trim() && !paths.length) throw new Error("请填写文字或插入图片");
  return { content: String(content), attachmentPaths: paths };
}

export async function uploadOriginalImages({ request, images, idempotencyKey = "" }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new TypeError("An idempotency key is required");
  }
  if (!Array.isArray(images) || !images.length || images.some(image => typeof image !== "string" || !image)) {
    throw new TypeError("At least one image data URL is required");
  }
  const result = await request("/api/images/upload", {
    method: "POST",
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    body: JSON.stringify({ purpose: "original", images })
  });
  const attachmentPaths = Array.isArray(result?.attachmentPaths)
    ? result.attachmentPaths
    : result?.attachmentPath ? [result.attachmentPath] : [];
  if (attachmentPaths.length !== images.length || attachmentPaths.some(path => !/^\/attachments\/[\w.-]+$/.test(path))) {
    throw new Error("服务端未返回完整的原图附件路径");
  }
  return attachmentPaths;
}

export async function uploadOriginalImage({ request, image, idempotencyKey }) {
  return (await uploadOriginalImages({ request, images: [image], idempotencyKey }))[0];
}

export async function uploadPendingMediaItems({
  items,
  upload,
  createId = () => crypto.randomUUID(),
  onProgress = async () => {}
}) {
  if (!Array.isArray(items)) throw new TypeError("Media draft items must be an array");
  if (typeof upload !== "function") throw new TypeError("An upload function is required");
  const next = items.map(item => ({ ...item }));
  const attachmentPaths = [];
  const uploadedPaths = [];
  const failures = [];
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index];
    if (item.path) {
      attachmentPaths.push(item.path);
      continue;
    }
    if (!item.file) throw new Error(`第 ${index + 1} 张图片缺少可恢复内容`);
    if (!item.uploadRequestId) {
      item.uploadRequestId = createId();
      await onProgress(next);
    }
    if (!item.uploadedPath) {
      try {
        item.uploadedPath = await upload(item.file, item.uploadRequestId, index);
        delete item.lastError;
      } catch (error) {
        item.lastError = { message: error?.message || "上传失败" };
        failures.push({ index, error });
        await onProgress(next);
        continue;
      }
      await onProgress(next);
    }
    attachmentPaths.push(item.uploadedPath);
    uploadedPaths.push(item.uploadedPath);
  }
  if (failures.length) {
    const failed = failures.map(item => item.index + 1).join("、");
    const error = new AggregateError(failures.map(item => item.error), `第 ${failed} 张图片上传失败，可直接重试`);
    error.failedIndexes = failures.map(item => item.index);
    throw error;
  }
  return { items: next, attachmentPaths, uploadedPaths };
}

export function imageUnderstandingPayload({ attachmentPaths, targetType, targetId = "", inputVersion = 0 }) {
  const record = imageRecordPayload({ attachmentPaths });
  if (typeof targetType !== "string" || !targetType.trim()) throw new TypeError("An explicit image-understanding target type is required");
  return {
    attachmentPaths: record.attachmentPaths,
    targetType: targetType.trim(),
    targetId: String(targetId || ""),
    inputVersion: Number.isSafeInteger(Number(inputVersion)) && Number(inputVersion) >= 0 ? Number(inputVersion) : 0
  };
}
