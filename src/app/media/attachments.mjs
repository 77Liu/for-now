import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { captureAudioPayload } from "../../modules/captures/index.mjs";
import {
  cleanAttachmentPaths,
  cleanupTemporaryFiles,
  createAttachmentStorage,
  createImageAttachments
} from "../../shared/attachments/index.mjs";
import { createAttachmentCleanup } from "../attachment-cleanup.mjs";
import { createAttachmentUploadWorkflows } from "./upload-workflows.mjs";

const DEFAULT_AUDIO_MAX_DURATION_MS = 10 * 60 * 1000;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function createAttachmentRuntime({
  repository,
  attachmentStorageConfig = {},
  attachmentInventory = null,
  getAttachmentContext,
  attachmentQuotaBytes,
  defaultImageMaxBytes,
  uploadImageMaxBytes,
  uploadAudioMaxBytes,
  audioMaxDurationMs = DEFAULT_AUDIO_MAX_DURATION_MS,
  now = () => new Date().toISOString(),
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  createId = () => crypto.randomUUID(),
  cleanupContextKey,
  dispatchCleanup,
  onCleanupRetryFailure = () => {},
  onCleanupResult = async () => {},
  onCleanupDeferred = () => {},
  emitDebug = () => {}
}) {
  if (!repository?.read || !repository?.update || !repository?.transact
    || typeof repository.executeIdempotent !== "function") {
    throw new TypeError("Attachment runtime requires an account-scoped repository");
  }
  if (typeof getAttachmentContext !== "function"
    || typeof cleanupContextKey !== "function"
    || typeof dispatchCleanup !== "function") {
    throw new TypeError("Attachment runtime requires explicit account context and cleanup scheduling");
  }
  if (typeof hash !== "function" || typeof createId !== "function" || typeof now !== "function") {
    throw new TypeError("Attachment runtime requires hash, id and clock functions");
  }

  const attachmentStorage = createAttachmentStorage(attachmentStorageConfig);
  const attachmentCleanup = createAttachmentCleanup({
    repository,
    now,
    contextKey: cleanupContextKey,
    remove: resourcePath => imageAttachments.remove(resourcePath),
    dispatch: dispatchCleanup,
    onRetryFailure: onCleanupRetryFailure,
    onResult: onCleanupResult
  });
  const imageAttachments = createImageAttachments({
    storage: attachmentStorage,
    getContext: getAttachmentContext,
    quotaBytes: attachmentQuotaBytes,
    defaultMaxBytes: defaultImageMaxBytes,
    inventory: attachmentInventory,
    cleanFailedUploads: attachmentCleanup.cleanFailedUploads,
    onCleanupDeferred,
    createId
  });
  const uploadWorkflows = createAttachmentUploadWorkflows({
    repository,
    attachments: imageAttachments,
    cleanup: attachmentCleanup,
    uploadImageMaxBytes,
    uploadAudioMaxBytes,
    audioMaxDurationMs,
    hash,
    emitDebug
  });

  async function materializeAttachmentFiles(resourcePaths) {
    const tempDir = path.join(getAttachmentContext().dataDir, "tmp");
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
    await fs.chmod(tempDir, 0o700);
    const files = [];
    try {
      for (const resourcePath of cleanAttachmentPaths(resourcePaths)) {
        const extension = path.extname(resourcePath).toLowerCase();
        const file = path.join(
          tempDir,
          `${createId()}${[".png", ".jpg", ".jpeg", ".webp"].includes(extension)
            ? extension
            : ".jpg"}`
        );
        files.push(file);
        await fs.writeFile(file, await imageAttachments.read(resourcePath), {
          mode: 0o600
        });
      }
      return files;
    } catch (error) {
      await cleanupTemporaryFiles(files);
      throw error;
    }
  }

  async function listAttachmentInventory() {
    if (attachmentInventory?.list) return attachmentInventory.list();
    const context = getAttachmentContext();
    return (await attachmentStorage.list({
      ownerId: context.ownerId,
      localDir: context.attachmentsDir
    })).map(item => ({
      path: `/attachments/${item.name}`,
      storage: attachmentStorage.mode,
      objectKey: item.objectKey,
      bytes: item.bytes,
      state: "verified"
    }));
  }

  async function prepareCaptureAudio(input) {
    if (!hasOwn(input, "audio")) return { value: {} };
    const parsed = captureAudioPayload(input.audio);
    if (parsed.error || !parsed.value) return parsed;
    const inventory = await listAttachmentInventory();
    const row = inventory.find(item => item.path === parsed.value.attachmentPath);
    if (!row) {
      return {
        forbidden: true,
        error: "语音附件不属于当前账户",
        code: "ATTACHMENT_NOT_OWNED"
      };
    }
    let audio = { ...parsed.value, bytes: row.bytes };
    if (audio.asrAttachmentPath) {
      const asrRow = inventory.find(item => item.path === audio.asrAttachmentPath);
      if (!asrRow) {
        return {
          forbidden: true,
          error: "转写派生附件不属于当前账户",
          code: "ATTACHMENT_NOT_OWNED"
        };
      }
      audio = { ...audio, asrBytes: asrRow.bytes };
    }
    const validated = captureAudioPayload(audio);
    return validated.error ? validated : { value: { audio: validated.value } };
  }

  return {
    attachmentStorage,
    attachmentCleanup,
    resumeAttachmentCleanup: attachmentCleanup.resume,
    imageAttachments,
    saveImageDataUrls: imageAttachments.save,
    ...uploadWorkflows,
    materializeAttachmentFiles,
    listAttachmentInventory,
    prepareCaptureAudio
  };
}
