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

export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
export const AUDIO_MAX_DURATION_MS = 10 * 60 * 1000;
export const AUDIO_MIME_TYPES = Object.freeze(["audio/mp4", "audio/webm", "audio/ogg", "audio/wav"]);
export const TTS_GENERATION_RATE_MIN = -50;
export const TTS_GENERATION_RATE_MAX = 100;
export const TTS_GENERATION_RATE_DEFAULT = -10;
export const TTS_PLAYBACK_RATES = Object.freeze([0.5, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 2]);
const AUDIO_MIME_ALIASES = Object.freeze({ "audio/x-m4a": "audio/mp4", "audio/x-wav": "audio/wav" });
const AUDIO_PATH = /^\/attachments\/[\w.-]+\.(?:m4a|mp4|webm|ogg|wav)$/i;
const AUDIO_MIME_BY_EXTENSION = Object.freeze({
  m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", wav: "audio/wav"
});

export function preferredRecorderMime(MediaRecorderConstructor = globalThis.MediaRecorder) {
  if (typeof MediaRecorderConstructor?.isTypeSupported !== "function") return "";
  return [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ].find(type => MediaRecorderConstructor.isTypeSupported(type)) || "";
}

export function normalizeTtsPlaybackRate(value, fallback = 1) {
  const rate = Number(value), fallbackRate = Number(fallback);
  if (TTS_PLAYBACK_RATES.includes(rate)) return rate;
  return TTS_PLAYBACK_RATES.includes(fallbackRate) ? fallbackRate : 1;
}

export function normalizeTtsGenerationRate(value, fallback = TTS_GENERATION_RATE_DEFAULT) {
  const rate = Number(value), fallbackRate = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackRate)
    ? Math.min(TTS_GENERATION_RATE_MAX, Math.max(TTS_GENERATION_RATE_MIN, Math.round(fallbackRate)))
    : TTS_GENERATION_RATE_DEFAULT;
  return Number.isFinite(rate)
    ? Math.min(TTS_GENERATION_RATE_MAX, Math.max(TTS_GENERATION_RATE_MIN, Math.round(rate)))
    : normalizedFallback;
}

export function validatedAudioBlob(blob, durationMs, {
  maxBytes = AUDIO_MAX_BYTES,
  maxDurationMs = AUDIO_MAX_DURATION_MS
} = {}) {
  const suppliedMimeType = String(blob?.type || "").split(";")[0].toLowerCase();
  const mimeType = AUDIO_MIME_ALIASES[suppliedMimeType] || suppliedMimeType;
  const bytes = Number(blob?.size);
  const normalizedDuration = Math.round(Number(durationMs));
  if (!AUDIO_MIME_TYPES.includes(mimeType)) throw new Error("只支持 M4A、WebM、Ogg 或 WAV 音频");
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
    throw new Error(`音频大小不得超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  if (!Number.isSafeInteger(normalizedDuration) || normalizedDuration < 250 || normalizedDuration > maxDurationMs) {
    throw new Error("录音时长必须在 0.25 秒到 10 分钟之间");
  }
  return { blob, mimeType, bytes, durationMs: normalizedDuration };
}

export function captureAudioIdentity(capture = {}) {
  const id = String(capture?.id || "");
  const attachmentPath = String(capture?.audio?.attachmentPath || "");
  if (!id || !attachmentPath) return "";
  return JSON.stringify([id, Math.max(0, Math.round(Number(capture.version) || 0)), attachmentPath]);
}

export function captureSpeechIdentity(capture = {}, voice = "") {
  const id = String(capture?.id || "");
  if (!id) return "";
  return JSON.stringify([
    id,
    Math.max(0, Math.round(Number(capture.version) || 0)),
    String(capture?.audio?.attachmentPath || ""),
    String(capture?.transcription?.updatedAt || ""),
    String(voice || "")
  ]);
}

export function captureAudioPresentation(capture = {}, speech = {}, tasks = []) {
  const audioKey = captureAudioIdentity(capture);
  const audioReady = Boolean(audioKey);
  const transcriptionStatus = audioReady ? String(capture?.transcription?.status || "unconfigured") : "";
  const supported = audioReady && (speech.supportedAsrMimeTypes || []).includes(capture.audio.mimeType);
  const canTranscribe = Boolean(audioReady && speech.configured && supported);
  const taskStatuses = {
    queued: new Set(["queued"]),
    transcribing: new Set(["queued", "running"]),
    ready: new Set(["succeeded"]),
    failed: new Set(["failed"])
  }[transcriptionStatus] || new Set();
  const currentTask = [...(Array.isArray(tasks) ? tasks : [])]
    .filter(task => task?.kind === "captureTranscription"
      && task.targetId === capture.id
      && taskStatuses.has(task.status))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
  let transcriptionMessage = "";
  if (["queued", "transcribing"].includes(transcriptionStatus)) {
    transcriptionMessage = "正在后台转写，完成后会通知。";
  } else if (transcriptionStatus === "failed") {
    transcriptionMessage = "转写暂时失败。原音已保留，可以再次尝试。";
  } else if (transcriptionStatus === "unconfigured") {
    if (!speech.configured) transcriptionMessage = "暂时不能转成文字。原音已保留。";
    else if (!supported) transcriptionMessage = "当前格式暂不能转成文字。原音仍可播放。";
    else transcriptionMessage = "语音原件尚未转写。";
  }
  return {
    audioKey,
    audioReady,
    audioStatus: audioReady ? "原音可播放" : "",
    transcriptionStatus,
    transcriptionMessage,
    transcriptionTaskId: String(currentTask?.id || ""),
    canTranscribe
  };
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
    durable: false,
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
  if (!indexedDBImpl) return createMemoryMediaDraftStore();
  const fallback = createMemoryMediaDraftStore();
  let unavailable = false;
  const opening = indexedDBImpl.open(databaseName, 1);
  opening.addEventListener("upgradeneeded", () => {
    const db = opening.result;
    if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
  }, { once: true });
  const ready = new Promise(resolve => {
    opening.addEventListener("success", () => {
      const db = opening.result;
      db.addEventListener("versionchange", () => {
        unavailable = true;
        db.close();
      });
      resolve(db);
    }, { once: true });
    opening.addEventListener("error", () => {
      unavailable = true;
      resolve(null);
    }, { once: true });
    opening.addEventListener("blocked", () => {
      unavailable = true;
      resolve(null);
    }, { once: true });
  });
  const withStore = async (mode, action) => {
    const db = await ready;
    if (!db || unavailable) throw new Error("IndexedDB unavailable");
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
    get durable() {
      return !unavailable;
    },
    async put(record) {
      const value = { ...clone(record), key: draftKey(record.owner, record.id) };
      try {
        await withStore("readwrite", store => requestResult(store.put(value)));
      } catch {
        unavailable = true;
        return fallback.put(record);
      }
      delete value.key;
      return value;
    },
    async get(owner, id) {
      if (unavailable) return fallback.get(owner, id);
      let value;
      try {
        value = await withStore("readonly", store => requestResult(store.get(draftKey(owner, id))));
      } catch {
        unavailable = true;
        return fallback.get(owner, id);
      }
      if (!value) return null;
      delete value.key;
      return value;
    },
    async delete(owner, id) {
      if (unavailable) return fallback.delete(owner, id);
      try {
        await withStore("readwrite", store => requestResult(store.delete(draftKey(owner, id))));
      } catch {
        unavailable = true;
        await fallback.delete(owner, id);
      }
    },
    async clear(owner) {
      if (!unavailable) {
        try {
          await withStore("readwrite", async store => {
            const values = await requestResult(store.getAll());
            await Promise.all(values.filter(record => record.owner === owner).map(record => requestResult(store.delete(record.key))));
          });
        } catch {
          unavailable = true;
        }
      }
      await fallback.clear(owner);
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

export function captureRecordPayload({ content = "", attachmentPaths = [], audio = null } = {}) {
  const text = String(content);
  const paths = [...new Set((Array.isArray(attachmentPaths) ? attachmentPaths : [])
    .filter(value => typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)))];
  if (paths.length > 2) throw new Error("最多插入 2 张图片");
  let normalizedAudio = null;
  if (audio != null) {
    const mimeType = AUDIO_MIME_ALIASES[String(audio.mimeType || "").toLowerCase()] || String(audio.mimeType || "").toLowerCase();
    const attachmentPath = String(audio.attachmentPath || "");
    const extension = attachmentPath.split(".").at(-1)?.toLowerCase();
    const bytes = Math.round(Number(audio.bytes));
    const durationMs = Math.round(Number(audio.durationMs));
    if (!AUDIO_PATH.test(attachmentPath) || !AUDIO_MIME_TYPES.includes(mimeType) || AUDIO_MIME_BY_EXTENSION[extension] !== mimeType) {
      throw new Error("语音附件格式不正确");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AUDIO_MAX_BYTES) throw new Error("语音附件大小不正确");
    if (!Number.isSafeInteger(durationMs) || durationMs < 250 || durationMs > AUDIO_MAX_DURATION_MS) {
      throw new Error("录音时长必须在 0.25 秒到 10 分钟之间");
    }
    normalizedAudio = { attachmentPath, mimeType, bytes, durationMs };
  }
  if (!text.trim() && !paths.length && !normalizedAudio) throw new Error("请填写文字、插入图片或录下语音");
  return { content: text, attachmentPaths: paths, audio: normalizedAudio };
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

export async function uploadOriginalAudio({ request, audio, durationMs, idempotencyKey = "" }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new TypeError("An idempotency key is required");
  }
  if (typeof audio !== "string" || !audio.startsWith("data:audio/")) {
    throw new TypeError("An audio data URL is required");
  }
  const result = await request("/api/audio/upload", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ audio, durationMs })
  });
  return captureRecordPayload({ audio: result?.audio }).audio;
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
