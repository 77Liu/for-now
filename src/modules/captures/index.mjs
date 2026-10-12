import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const IDEMPOTENCY_SCOPE = "captures.create";
const AUDIO_PATH = /^\/attachments\/[\w.-]+\.(?:m4a|mp4|webm|ogg|wav)$/i;
const AUDIO_MIME_TYPES = new Set(["audio/mp4", "audio/webm", "audio/ogg", "audio/wav"]);
const AUDIO_MIME_BY_EXTENSION = Object.freeze({
  m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", wav: "audio/wav"
});
const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const ASR_AUDIO_MAX_BYTES = 24 * 1024 * 1024;
const AUDIO_MAX_DURATION_MS = 10 * 60 * 1000;
const tagsOf = value => (Array.isArray(value) ? value : [])
  .map(tag => safeText(tag, 30))
  .filter(Boolean)
  .slice(0, 8);

const markReplay = result => (
  result && typeof result === "object" ? { ...result, duplicate: true } : result
);

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!safeText(input?.title, 120)) delete canonical.title;
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

function priorRequest(items, trashItems, clientRequestId) {
  return items.find(item => item.clientRequestId === clientRequestId)
    || trashItems.find(item => item.type === "capture" && item.payload?.clientRequestId === clientRequestId)?.payload;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

export function publicCapture(item) {
  if (!item) return null;
  const { speechCache: _speechCache, ...value } = item;
  return value;
}

const versioned = item => item
  ? { ...publicCapture(item), version: recordVersion(item.version) }
  : null;

export function captureAudioPayload(value) {
  if (value == null) return { value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "语音附件格式不正确", code: "INVALID_AUDIO_ATTACHMENT" };
  }
  const attachmentPath = safeText(value.attachmentPath, 300);
  const mimeType = safeText(value.mimeType, 100).toLowerCase();
  const bytes = Math.round(Number(value.bytes));
  const durationMs = Math.round(Number(value.durationMs));
  const extension = attachmentPath.split(".").at(-1)?.toLowerCase();
  if (!AUDIO_PATH.test(attachmentPath) || !AUDIO_MIME_TYPES.has(mimeType) || AUDIO_MIME_BY_EXTENSION[extension] !== mimeType) {
    return { error: "语音附件格式不正确", code: "INVALID_AUDIO_ATTACHMENT" };
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AUDIO_MAX_BYTES) {
    return { error: "语音附件大小不正确", code: "INVALID_AUDIO_BYTES" };
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 250 || durationMs > AUDIO_MAX_DURATION_MS) {
    return { error: "录音时长必须在 0.25 秒到 10 分钟之间", code: "INVALID_AUDIO_DURATION" };
  }
  const asrAttachmentPath = safeText(value.asrAttachmentPath, 300);
  const asrMimeType = safeText(value.asrMimeType, 100).toLowerCase();
  const asrBytes = Math.round(Number(value.asrBytes));
  const hasAsrDerivative = Boolean(asrAttachmentPath || asrMimeType || Number.isFinite(asrBytes));
  if (hasAsrDerivative) {
    if (!/^\/attachments\/[\w.-]+\.asr\.wav$/i.test(asrAttachmentPath)
      || asrMimeType !== "audio/wav"
      || !Number.isSafeInteger(asrBytes) || asrBytes < 45 || asrBytes > ASR_AUDIO_MAX_BYTES) {
      return { error: "转写派生音频格式不正确", code: "INVALID_ASR_DERIVATIVE" };
    }
  }
  return {
    value: {
      attachmentPath,
      mimeType,
      bytes,
      durationMs,
      ...(hasAsrDerivative ? { asrAttachmentPath, asrMimeType, asrBytes } : {})
    }
  };
}

const unconfiguredTranscription = () => ({
  status: "unconfigured",
  provider: "",
  rawText: "",
  polishedText: "",
  condensedText: "",
  updatedAt: "",
  errorCode: "ASR_NOT_CONFIGURED",
  condenseErrorCode: ""
});

export function capturePayload(input, existing = null, { now = () => new Date() } = {}) {
  const merged = existing ? { ...existing, ...input } : input;
  const content = safeText(merged.content, 12000);
  const attachmentPaths = cleanAttachmentPaths(merged.attachmentPaths);
  const parsedAudio = captureAudioPayload(merged.audio);
  if (parsedAudio.error) return parsedAudio;
  let audio = parsedAudio.value;
  if (audio && audio.attachmentPath === existing?.audio?.attachmentPath
    && !audio.asrAttachmentPath && existing.audio.asrAttachmentPath) {
    audio = {
      ...audio,
      asrAttachmentPath: existing.audio.asrAttachmentPath,
      asrMimeType: existing.audio.asrMimeType,
      asrBytes: existing.audio.asrBytes
    };
  }
  if (!content && !attachmentPaths.length && !audio) {
    return { error: existing ? "请保留文字、图片或语音" : "先写一点什么，或插入图片、录下语音" };
  }
  const eventTime = eventTimeFields(input, existing, { now });
  if (!eventTime) return { error: "发生时间格式不正确" };
  const suppliedTitle = hasOwn(input, "title")
    ? safeText(input.title, 120)
    : safeText(existing?.title, 120);
  const title = suppliedTitle || (!existing && audio && !content && !attachmentPaths.length
    ? `${eventTime.occurredOn} 录音`
    : "");
  const audioChanged = audio?.attachmentPath !== existing?.audio?.attachmentPath;
  return {
    value: {
      ...eventTime,
      ...(title ? { title } : {}),
      content,
      tags: tagsOf(merged.tags),
      attachmentPaths,
      audio,
      transcription: audio
        ? audioChanged ? unconfiguredTranscription() : existing?.transcription || unconfiguredTranscription()
        : null
    }
  };
}

export function createCaptureRecords({
  repository,
  reanchorAnnotations,
  reconcileOriginalImages = null,
  reconcileAudioAttachment = null,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  return {
    async list(options) {
      const page = pageOf(await repository.read(), options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(versioned) };
    },

    async get(id) {
      return versioned((await repository.read()).find(item => item.id === id));
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = capturePayload(input, null, { now });
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      const create = (items, trashItems = [], useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorRequest(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: publicCapture(duplicate), duplicate: true }
              : { conflict: true };
          }
        }
        const capture = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          annotations: [],
          annotationDrift: [],
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(capture);
        return { value: publicCapture(capture), duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return repository.executeIdempotent(
          {
            scope: IDEMPOTENCY_SCOPE,
            key: clientRequestId,
            requestHash
          },
          (items, trashItems = []) => create(items, trashItems, false),
          { onReplay: markReplay }
        );
      }
      return repository.update((items, trashItems = []) => create(items, trashItems));
    },

    update(id, input, { expectedVersion = null } = {}) {
      return repository.update((items, _trashItems, store) => {
        const capture = items.find(item => item.id === id);
        if (!capture) return { missing: true };
        const currentVersion = recordVersion(capture.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const previousAudio = capture.audio ? structuredClone(capture.audio) : null;
        const previousTranscription = capture.transcription ? structuredClone(capture.transcription) : null;
        const parsed = capturePayload(input, capture, { now });
        if (parsed.error) return parsed;
        if (capture.content !== parsed.value.content) {
          reanchorAnnotations(capture, "content", capture.content, parsed.value.content);
        }
        const updatedAt = now();
        let reconciled = null;
        if (store && typeof reconcileOriginalImages === "function") {
          reconciled = reconcileOriginalImages(store, "capture", id, parsed.value.attachmentPaths, {
            changedAt: updatedAt,
            touchResource: false,
            allowEmptyImages: true
          });
          if (!reconciled.value) return reconciled;
        }
        Object.assign(capture, parsed.value, {
          updatedAt,
          version: currentVersion + 1
        });
        const audioReconciled = store && typeof reconcileAudioAttachment === "function"
          ? reconcileAudioAttachment(store, {
            captureId: id,
            previousAudio,
            previousTranscription,
            nextAudio: capture.audio,
            changedAt: updatedAt
          })
          : null;
        const trashIds = [reconciled?.trashId, audioReconciled?.trashId].filter(Boolean);
        const result = {
          value: publicCapture(capture),
          ...(trashIds[0] ? { trashId: trashIds[0] } : {}),
          ...(trashIds.length > 1 ? { trashIds } : {})
        };
        const afterCommit = [reconciled?.[AFTER_COMMIT], audioReconciled?.[AFTER_COMMIT]].filter(callback => typeof callback === "function");
        if (afterCommit.length) Object.defineProperty(result, AFTER_COMMIT, {
          value: async () => {
            for (const callback of afterCommit) await callback();
          }
        });
        return result;
      });
    }
  };
}
