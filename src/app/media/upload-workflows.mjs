import path from "node:path";
import {
  cleanAttachmentPaths,
  collectAttachmentPaths
} from "../../shared/attachments/index.mjs";
import {
  METADATA_FIELD,
  removeIdempotencyResponse
} from "../../shared/persistence/index.mjs";
import { safeText } from "../../shared/validation/index.mjs";

const missingAttachment = error => (
  ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404
);
const failure = (message, statusCode, code) => Object.assign(
  new Error(message),
  { statusCode, code }
);
const fireAndForget = operation => {
  try {
    Promise.resolve(operation()).catch(() => {});
  } catch {}
};

export function createAttachmentUploadWorkflows({
  repository,
  attachments,
  cleanup,
  uploadImageMaxBytes,
  uploadAudioMaxBytes,
  audioMaxDurationMs,
  hash,
  emitDebug
}) {
  async function replayState(resourcePaths) {
    const states = await Promise.allSettled(
      resourcePaths.map(resourcePath => attachments.read(resourcePath))
    );
    const missing = states.filter(item => (
      item.status === "rejected" && missingAttachment(item.reason)
    )).length;
    const unexpected = states.find(item => (
      item.status === "rejected" && !missingAttachment(item.reason)
    ));
    if (unexpected) throw unexpected.reason;
    return { missing };
  }

  async function saveOriginalImages(images, { idempotencyKey = "" } = {}) {
    const key = safeText(idempotencyKey, 100);
    if (!key) throw failure("原图上传缺少幂等标识", 400, "IDEMPOTENCY_KEY_REQUIRED");
    const idempotency = {
      scope: "attachments.uploadOriginals",
      key,
      requestHash: hash(JSON.stringify(images))
    };
    const replay = await repository.readIdempotent?.(idempotency);
    if (replay !== undefined) {
      const replayPaths = cleanAttachmentPaths(replay.attachmentPaths);
      const { missing } = await replayState(replayPaths);
      if (!missing) return replay;
      if (missing !== replayPaths.length) {
        throw failure(
          "原图上传的幂等结果仅部分可用，请更换请求标识后重试",
          409,
          "IDEMPOTENCY_RESULT_STALE"
        );
      }
      await repository.update(store => removeIdempotencyResponse(store, idempotency));
    }
    const uploaded = await attachments.save(images, 2, {
      maxBytes: uploadImageMaxBytes
    });
    try {
      const result = await repository.executeIdempotent(
        idempotency,
        () => ({ attachmentPaths: uploaded.attachmentPaths }),
        { onReplay: value => ({ ...value, duplicate: true }) }
      );
      if (result.duplicate) await cleanup.cleanFailedUploads(uploaded.attachmentPaths);
      return result;
    } catch (error) {
      await cleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
      throw error;
    }
  }

  async function saveKeepsakeImages(input, { idempotencyKey = "" } = {}) {
    const key = safeText(idempotencyKey, 100);
    if (!key) throw failure("小物图片上传缺少幂等标识", 400, "IDEMPOTENCY_KEY_REQUIRED");
    const idempotency = {
      scope: "attachments.uploadKeepsake",
      key,
      requestHash: hash(JSON.stringify({
        image: input.image,
        alphaMask: input.alphaMask
      }))
    };
    const replay = await repository.readIdempotent?.(idempotency);
    if (replay !== undefined) {
      const replayPaths = cleanAttachmentPaths(replay.attachmentPaths, 5);
      const { missing } = await replayState(replayPaths);
      if ([2, 5].includes(replayPaths.length) && !missing) {
        if (replayPaths.length === 2) return replay;
        const originalPath = replay.originalPath || replayPaths[0];
        const alphaMaskPath = replay.alphaMaskPath || replayPaths.at(-1);
        return {
          ...replay,
          attachmentPath: originalPath,
          attachmentPaths: [originalPath, alphaMaskPath],
          originalPath,
          alphaMaskPath
        };
      }
      if (missing && missing !== replayPaths.length) {
        throw failure(
          "小物媒体上传的幂等结果仅部分可用，请更换请求标识后重试",
          409,
          "IDEMPOTENCY_RESULT_STALE"
        );
      }
      await repository.update(store => removeIdempotencyResponse(store, idempotency));
    }
    const uploaded = await attachments.saveKeepsakeSources({
      image: input.image,
      alphaMask: input.alphaMask,
      maxBytes: uploadImageMaxBytes
    });
    try {
      const result = await repository.executeIdempotent(
        idempotency,
        () => ({
          attachmentPath: uploaded.paths.originalPath,
          attachmentPaths: uploaded.attachmentPaths,
          ...uploaded.paths
        }),
        { onReplay: value => ({ ...value, duplicate: true }) }
      );
      if (result.duplicate) await cleanup.cleanFailedUploads(uploaded.attachmentPaths);
      return result;
    } catch (error) {
      await cleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
      throw error;
    }
  }

  async function saveOriginalAudio(input, { idempotencyKey = "" } = {}) {
    const key = safeText(idempotencyKey, 100);
    if (!key) throw failure("音频上传缺少幂等标识", 400, "IDEMPOTENCY_KEY_REQUIRED");
    const durationMs = Math.round(Number(input.durationMs));
    if (!Number.isSafeInteger(durationMs)
      || durationMs < 250
      || durationMs > audioMaxDurationMs) {
      throw failure(
        "录音时长必须在 0.25 秒到 10 分钟之间",
        400,
        "INVALID_AUDIO_DURATION"
      );
    }
    const idempotency = {
      scope: "attachments.uploadAudio",
      key,
      requestHash: hash(JSON.stringify({ audio: input.audio, durationMs }))
    };
    const replay = await repository.readIdempotent?.(idempotency);
    if (replay !== undefined) {
      const resourcePath = safeText(replay.audio?.attachmentPath, 300);
      try {
        if (resourcePath) await attachments.read(resourcePath);
        if (resourcePath) return replay;
      } catch (error) {
        if (!missingAttachment(error)) throw error;
      }
      await repository.update(store => removeIdempotencyResponse(store, idempotency));
    }
    const uploaded = await attachments.saveAudio(input.audio, {
      maxBytes: uploadAudioMaxBytes
    });
    const audio = {
      attachmentPath: uploaded.attachmentPath,
      mimeType: uploaded.mimeType,
      bytes: uploaded.bytes,
      durationMs
    };
    fireAndForget(() => emitDebug({
      hypothesisId: "B-D",
      location: "media/upload-workflows.mjs:saveOriginalAudio",
      msg: "[DEBUG] Audio upload normalized metadata",
      data: {
        extension: path.extname(audio.attachmentPath),
        mimeType: audio.mimeType,
        bytes: audio.bytes,
        durationMs: audio.durationMs
      }
    }));
    try {
      const result = await repository.executeIdempotent(
        idempotency,
        () => ({ audio }),
        { onReplay: value => ({ ...value, duplicate: true }) }
      );
      if (result.duplicate) {
        await cleanup.cleanFailedUploads([uploaded.attachmentPath]);
      }
      return result;
    } catch (error) {
      await cleanup.cleanFailedUploads([uploaded.attachmentPath]).catch(() => {});
      throw error;
    }
  }

  async function discardOriginalUploads(
    value,
    uploadRequestId = "",
    scope = "attachments.uploadOriginals"
  ) {
    const maxPaths = scope === "attachments.uploadKeepsake"
      ? 5
      : scope === "attachments.uploadAudio" ? 1 : 2;
    const attachmentPaths = cleanAttachmentPaths(value, maxPaths);
    const key = safeText(uploadRequestId, 100);
    if (!key) throw failure("清理附件上传缺少幂等标识", 400, "IDEMPOTENCY_KEY_REQUIRED");
    const prepared = await repository.update(store => {
      const ledger = store[METADATA_FIELD]?.idempotency?.find(item => (
        item.scope === scope && item.key === key
      ));
      const ledgerPaths = cleanAttachmentPaths(
        scope === "attachments.uploadAudio"
          ? [ledger?.response?.audio?.attachmentPath]
          : ledger?.response?.attachmentPaths,
        maxPaths
      );
      const requested = attachmentPaths.filter(resourcePath => (
        ledgerPaths.includes(resourcePath)
      ));
      const {
        [METADATA_FIELD]: _metadata,
        attachmentCleanup: _cleanup,
        ...visibleStore
      } = store;
      const referenced = collectAttachmentPaths({
        ...visibleStore,
        trash: (visibleStore.trash || []).filter(entry => entry.permanentlyPurged !== true)
      });
      const removable = requested.filter(resourcePath => !referenced.has(resourcePath));
      if (removable.length) {
        cleanup.enqueue(store, new Set(removable));
        if (removable.length === ledgerPaths.length
          && requested.length === ledgerPaths.length) {
          removeIdempotencyResponse(store, { scope, key });
        }
      }
      return { removable };
    });
    const result = await cleanup.resume();
    return {
      discarded: result.removed.filter(resourcePath => (
        prepared.removable.includes(resourcePath)
      )),
      pending: result.pending
    };
  }

  return {
    saveOriginalImages,
    saveKeepsakeImages,
    saveOriginalAudio,
    discardOriginalUploads,
    discardOriginalAudio: (value, uploadRequestId = "") => discardOriginalUploads(
      [value],
      uploadRequestId,
      "attachments.uploadAudio"
    )
  };
}
