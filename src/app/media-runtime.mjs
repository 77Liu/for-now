import crypto from "node:crypto";
import {
  createKeepsakeImageUnderstanding,
  createKeepsakeSegmentation
} from "../modules/keepsakes/index.mjs";
import { cleanupTemporaryFiles } from "../shared/attachments/index.mjs";
import { errorMetadata } from "../shared/observability/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { createKeepsakeMediaWorkflows } from "./keepsake-media-workflows.mjs";
import { createLibraryWorkflows } from "./library-workflows.mjs";
import { createAttachmentRuntime } from "./media/attachments.mjs";
import { createMediaProviders } from "./media/providers.mjs";
import { createSpeechRuntime } from "./media/speech.mjs";
import { createVisionWorkflows } from "./media/vision.mjs";

const requiredFunction = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`Media runtime ${name} is required`);
};
const requiredPositiveNumber = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Media runtime ${name} must be a positive number`);
  }
};

export function createMediaRuntime({
  repository,
  attachmentStorageConfig = {},
  attachmentInventory = null,
  attachmentQuotaBytes,
  defaultImageMaxBytes,
  uploadImageMaxBytes,
  uploadAudioMaxBytes,
  audioMaxDurationMs = 10 * 60 * 1000,
  getAttachmentContext,
  getOwnerId,
  cleanupContextKey,
  keepsakeContextKey,
  dispatchCleanup,
  dispatchKeepsake,
  listAccountIds,
  runWithAccount,
  books,
  quotes,
  parseKeepsake,
  moveCollectionItemToTrash,
  moveNestedItemToTrash,
  speechConfig = {},
  visionConfig = {},
  segmentationConfig = {},
  speechQps,
  speechConcurrency,
  ocrQps,
  ocrConcurrency,
  documentQps,
  documentConcurrency,
  segmentationQps,
  segmentationConcurrency,
  aiBudgetRuntime,
  providerBudgetStage,
  conservativeDeepSeekStage,
  currentBudgetAccountId,
  meteredProviderCall,
  runDeepSeek,
  now = () => new Date().toISOString(),
  today,
  createId = () => crypto.randomUUID(),
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  logEvent,
  debugServerUrl = "",
  debugRunId = "",
  debugFetch = fetch,
  speechProvider: suppliedSpeechProvider = null,
  visionProvider: suppliedVisionProvider = null,
  segmentationProvider: suppliedSegmentationProvider = null
} = {}) {
  if (!repository?.read || !repository?.update) {
    throw new TypeError("Media runtime repository is required");
  }
  for (const [value, name] of [
    [getAttachmentContext, "getAttachmentContext"],
    [getOwnerId, "getOwnerId"],
    [cleanupContextKey, "cleanupContextKey"],
    [keepsakeContextKey, "keepsakeContextKey"],
    [dispatchCleanup, "dispatchCleanup"],
    [dispatchKeepsake, "dispatchKeepsake"],
    [listAccountIds, "listAccountIds"],
    [runWithAccount, "runWithAccount"],
    [parseKeepsake, "parseKeepsake"],
    [moveCollectionItemToTrash, "moveCollectionItemToTrash"],
    [moveNestedItemToTrash, "moveNestedItemToTrash"],
    [providerBudgetStage, "providerBudgetStage"],
    [conservativeDeepSeekStage, "conservativeDeepSeekStage"],
    [currentBudgetAccountId, "currentBudgetAccountId"],
    [meteredProviderCall, "meteredProviderCall"],
    [runDeepSeek, "runDeepSeek"],
    [today, "today"],
    [createId, "createId"],
    [hash, "hash"],
    [logEvent, "logEvent"],
    [debugFetch, "debugFetch"]
  ]) requiredFunction(value, name);
  if (!books?.list || !books?.createNote || !quotes?.list || !quotes?.create) {
    throw new TypeError("Media runtime books and quotes services are required");
  }
  if (typeof aiBudgetRuntime?.executeTask !== "function") {
    throw new TypeError("Media runtime aiBudgetRuntime is required");
  }
  for (const [value, name] of [
    [attachmentQuotaBytes, "attachmentQuotaBytes"],
    [defaultImageMaxBytes, "defaultImageMaxBytes"],
    [uploadImageMaxBytes, "uploadImageMaxBytes"],
    [uploadAudioMaxBytes, "uploadAudioMaxBytes"],
    [audioMaxDurationMs, "audioMaxDurationMs"],
    [speechQps, "speechQps"],
    [speechConcurrency, "speechConcurrency"],
    [ocrQps, "ocrQps"],
    [ocrConcurrency, "ocrConcurrency"],
    [documentQps, "documentQps"],
    [documentConcurrency, "documentConcurrency"],
    [segmentationQps, "segmentationQps"],
    [segmentationConcurrency, "segmentationConcurrency"]
  ]) requiredPositiveNumber(value, name);

  const emitDebug = ({ hypothesisId, location, msg, data }) => debugFetch(
    debugServerUrl,
    {
      method: "POST",
      body: JSON.stringify({
        sessionId: "login-audio-production",
        runId: debugRunId,
        hypothesisId,
        location,
        msg,
        data,
        ts: Date.now()
      })
    }
  );
  const attachments = createAttachmentRuntime({
    repository,
    attachmentStorageConfig,
    attachmentInventory,
    getAttachmentContext,
    attachmentQuotaBytes,
    defaultImageMaxBytes,
    uploadImageMaxBytes,
    uploadAudioMaxBytes,
    audioMaxDurationMs,
    now,
    hash,
    createId,
    cleanupContextKey,
    dispatchCleanup,
    onCleanupRetryFailure: error => logEvent(
      "system",
      "trash.attachment_cleanup_retry_failed",
      { level: "error", error: errorMetadata(error) }
    ),
    onCleanupResult: result => logEvent(
      "system",
      result.pending
        ? "trash.attachment_cleanup_pending"
        : "trash.attachment_cleanup_completed",
      {
        level: result.pending ? "error" : "info",
        removedCount: result.removed.length,
        pendingCount: result.pending
      }
    ),
    onCleanupDeferred: error => logEvent(
      "system",
      "attachment.cleanup_deferred",
      { level: "error", error: errorMetadata(error) }
    ),
    emitDebug
  });
  const providers = createMediaProviders({
    speechConfig: {
      ...speechConfig,
      debugServerUrl,
      debugRunId
    },
    visionConfig,
    segmentationConfig,
    speechQps,
    speechConcurrency,
    ocrQps,
    ocrConcurrency,
    documentQps,
    documentConcurrency,
    segmentationQps,
    segmentationConcurrency,
    meteredProviderCall,
    suppliedSpeechProvider,
    suppliedVisionProvider,
    suppliedSegmentationProvider
  });
  const vision = createVisionWorkflows({
    attachments: attachments.imageAttachments,
    materializeAttachmentFiles: attachments.materializeAttachmentFiles,
    visionProvider: providers.visionProvider,
    ocrGate: providers.ocrGate,
    aiBudgetRuntime,
    providerBudgetStage,
    conservativeDeepSeekStage,
    currentBudgetAccountId,
    meteredProviderCall,
    runDeepSeek,
    today,
    createId
  });
  const speech = createSpeechRuntime({
    repository,
    attachments: attachments.imageAttachments,
    cleanup: attachments.attachmentCleanup,
    getOwnerId,
    hash,
    now,
    listAccountIds,
    runWithAccount,
    speechProvider: providers.speechProvider,
    speechGate: providers.speechGate,
    aiBudgetRuntime,
    providerBudgetStage,
    conservativeDeepSeekStage,
    currentBudgetAccountId,
    meteredProviderCall,
    runDeepSeek,
    audioMaxDurationMs,
    logEvent,
    emitDebug
  });
  const keepsakeMediaWorkflows = createKeepsakeMediaWorkflows({
    repository,
    attachments: attachments.imageAttachments,
    cleanup: attachments.attachmentCleanup,
    parse: parseKeepsake,
    createId,
    now,
    contextKey: keepsakeContextKey,
    dispatch: dispatchKeepsake,
    onError: (id, error) => logEvent("system", "keepsake.derivative_failed", {
      level: "error",
      keepsakeId: id,
      error: errorMetadata(error)
    })
  });
  const segmentKeepsakeImage = createKeepsakeSegmentation({
    saveImages: attachments.saveImageDataUrls,
    cleanupFiles: cleanupTemporaryFiles,
    provider: providers.segmentationProvider,
    gate: providers.segmentationGate,
    createId,
    onFailure: (error, callGroupId) => logEvent(
      "system",
      "segmentation.failed",
      { level: "error", callGroupId, error: errorMetadata(error) }
    )
  });
  const understandKeepsakeImage = createKeepsakeImageUnderstanding({
    saveImages: attachments.saveImageDataUrls,
    cleanupFiles: cleanupTemporaryFiles,
    generate: (file, { existingTags = [] } = {}) => runDeepSeek(
      renderPrompt("keepsake.image.candidates", {
        existingTags: JSON.stringify(existingTags)
      }),
      {
        imagePath: file,
        scene: "contentImageUnderstanding",
        json: true,
        maxTokens: 1200
      }
    )
  });
  const libraryWorkflows = createLibraryWorkflows({
    repository,
    books,
    quotes,
    saveImages: attachments.saveImageDataUrls,
    discardAttachments: paths => attachments.imageAttachments.discard(paths),
    cleanupTemporaryFiles,
    recognizeBook: vision.recognizeBook,
    moveCollectionItemToTrash,
    moveNestedItemToTrash
  });

  return {
    ...attachments,
    ...providers,
    ...vision,
    ...speech,
    keepsakeMediaWorkflows,
    segmentKeepsakeImage,
    understandKeepsakeImage,
    libraryWorkflows
  };
}
