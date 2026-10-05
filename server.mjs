import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { loadAppConfig } from "./src/config/index.mjs";
import { createAttachmentStorage, createImageAttachments, cleanAttachmentPaths, cleanupTemporaryFiles, collectAttachmentPaths } from "./src/shared/attachments/index.mjs";
import { appendPrivateJsonLine, createObservability, createRuntimeMemorySampler, errorMetadata, pruneLogs } from "./src/shared/observability/index.mjs";
import { createThoughtService, createThoughtTaskTarget, stripThoughtAnswerLead } from "./src/modules/thoughts/index.mjs";
import {
  createOnboardingService,
  createOnboardingV2Service
} from "./src/modules/onboarding/index.mjs";
import { createJournalRecords } from "./src/modules/journals/index.mjs";
import { capabilitiesFor, createAuthService, isOwner, publicUser } from "./src/modules/auth/index.mjs";
import { createAnnotationService } from "./src/modules/annotations/index.mjs";
import { activeTaskForInput, createTaskLifecycle, publicAiTask } from "./src/modules/tasks/index.mjs";
import { createNotificationService, notificationUnread } from "./src/modules/notifications/index.mjs";
import { createTrashService } from "./src/modules/trash/index.mjs";
import { createCheckinRecords } from "./src/modules/checkins/index.mjs";
import { captureAudioPayload, createCaptureRecords } from "./src/modules/captures/index.mjs";
import { createBookRecords } from "./src/modules/books/index.mjs";
import { createQuoteRecords } from "./src/modules/quotes/index.mjs";
import { createChatRecords } from "./src/modules/chats/index.mjs";
import { createReviewRecords } from "./src/modules/reviews/index.mjs";
import { createStatisticsService } from "./src/modules/statistics/index.mjs";
import { architectureOwnerSurface, commercializationOwnerSurface } from "./src/modules/owner-surfaces/index.mjs";
import { createContentAttachmentService } from "./src/modules/content-attachments/index.mjs";
import { createThoughtDiscoveryService } from "./src/modules/discovery/index.mjs";
import { createAccountExport } from "./src/modules/exports/index.mjs";
import { createActionsService } from "./src/modules/actions/index.mjs";
import { createFeedbackService } from "./src/modules/feedback/index.mjs";
import { createUserModelService } from "./src/modules/user-model/index.mjs";
import {
  defaultLlmSettings, normalizeLlmSettings, createLlmSettingsService, normalizeAiUsage,
  createAiUsageService, createAiAudit, createAiCostService, createAiGenerator, usageEntryFromAudit,
  AI_BUDGET_POLICY, createAiBudgetService, resolveOfficialProviderPricing, systemPrompt
} from "./src/modules/ai/index.mjs";
import { createDeepSeekTransport, createAliyunSegmentationTransport, createVolcengineSpeechTransport, createVolcengineVisionTransport } from "./src/infrastructure/ai-providers/index.mjs";
import { loadPromptCatalog } from "./src/infrastructure/prompt-catalog/index.mjs";
import {
  createKeepsakeImageUnderstanding,
  createKeepsakeSegmentation,
  createKeepsakeRecords,
  keepsakePayload,
  publicKeepsake,
  originalKeepsakeMedia
} from "./src/modules/keepsakes/index.mjs";
import { createRateGate } from "./src/shared/concurrency/index.mjs";
import { installPromptCatalog, promptText, renderPrompt } from "./src/shared/prompts/index.mjs";
import { localDateKey, eventTimeFields } from "./src/shared/time/index.mjs";
import { buildAdminSnapshot } from "./admin-snapshot.mjs";
import { createAccountLifecycle, createAnnotationCommands, createAiBudgetRuntime, createAiTaskTargets, createBackgroundAi, createLocalTestRuntime, createTrashMutations, createTrashCommands, createAttachmentCleanup, createSpeechCache, createKeepsakeMediaWorkflows, createThoughtWorkflows, createCaptureJournalWorkflows, createLibraryWorkflows, createReviewChatWorkflows, createUserModelExtractionService, createStoreNormalizer, createPublicStateProjection, deepSeekBudgetStages, emptyStore, normalizeCommercialization, personalContextProjection, routeStateProjection, startupProjection, storeForUser, withoutOwnerMetadata, STORE_VERSION, TRASH_RETENTION_DAYS, userModelEvidenceCurrent } from "./src/app/index.mjs";
import {
  createSpeechCacheSweep,
  SPEECH_CACHE_SWEEP_INTERVAL_MS,
  SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
} from "./src/app/index.mjs";
import { safeText, recordVersion, safeIso, nullableNumber } from "./src/shared/validation/index.mjs";
import { createAuthHttp, createLocalTestHttp, createLocalTestSessionVault, createReadOnlyUpstream, createJsonHttp, createTaskHttp, createAnnotationHttp, createTrashHttp, createAttachmentHttp, createAiSettingsHttp, createAiCostHttp, createAiBudgetHttp, createKeepsakeHttp, createOnboardingHttp, createOnboardingV2Http, createUserModelHttp, createThoughtHttp, createCheckinHttp, createHealthRecordHttp, createDiscoveryHttp, createExportHttp, createActionsHttp, createFeedbackHttp, createCaptureJournalHttp, createLibraryHttp, createReviewsChatHttp, createContentAttachmentsHttp, createSpeechHttp, createVisionHttp, createSyncHttp, createStartupHttp, createPersonalContextHttp, createRequestHandler, createModelResponseHttp, createApiV1Http, openApiV1 } from "./src/http/index.mjs";
import { createHealthImageConfig, createDailyRecordRecords, normalizeHealthImage } from "./src/modules/health/index.mjs";
import { createAccountDocumentRepository, createAiBudgetRepository, createAuthRepository, createJsonStoreRepository, createPostgresRuntime, checkPersistenceMarker, markPostgresDirectory, hasJsonData, METADATA_FIELD, removeIdempotencyResponse } from "./src/shared/persistence/index.mjs";
import { isApplicationRoutePath } from "./public/frontend/pages/index.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const RELEASE_VERSION = String(JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version || "development");
const appConfig = loadAppConfig({ rootDir: ROOT });
installPromptCatalog(await loadPromptCatalog({ rootDir: ROOT, requestedVersion: appConfig.promptCatalogVersion }));
const {
  dataDir: DATA_DIR, persistenceBackend: PERSISTENCE_BACKEND, inviteCodeHash: INVITE_CODE_HASH,
  authRequired: AUTH_REQUIRED, cookieSecure: COOKIE_SECURE, basePath: APP_BASE_PATH,
  upstreamOrigin: UPSTREAM_ORIGIN, localTestMode: LOCAL_TEST_MODE,
  localTestMainUserId: LOCAL_TEST_MAIN_USER_ID, localTestResetOnStart: LOCAL_TEST_RESET_ON_START,
  testCurrentDate: TEST_CURRENT_DATE,
  periodicAnalysisEnabled: PERIODIC_ANALYSIS_ENABLED,
  speechCacheSweepEnabled: SPEECH_CACHE_SWEEP_ENABLED,
  runtimeMemorySampleIntervalMs: RUNTIME_MEMORY_SAMPLE_INTERVAL_MS,
  deepSeekApiUrl: DEEPSEEK_API_URL,
  port: PORT, version: APP_VERSION
} = appConfig;
await checkPersistenceMarker(DATA_DIR, PERSISTENCE_BACKEND);
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const USERS_DIR = path.join(DATA_DIR, "users");
const LOCAL_TEST_CONTROL_FILE = path.join(DATA_DIR, "local-test-mode.json");
const LOCAL_TEST_WORKSPACES_DIR = path.join(DATA_DIR, "local-test-workspaces");
const LOCAL_TEST_SESSION_COOKIE = "for_now_local_test_session";
const LOCAL_TEST_SESSION_MAX_AGE_SECONDS = 30 * 60;
const { context: requestStorage, logEvent, auditChanges } = createObservability({ rootDir: DATA_DIR, version: APP_VERSION });
const runtimeMemorySampler = createRuntimeMemorySampler({
  logEvent,
  intervalMs: RUNTIME_MEMORY_SAMPLE_INTERVAL_MS
});
const attachmentStorage = createAttachmentStorage(appConfig.attachments);
const PLATFORM_SERVICE_TOKEN_HASH = appConfig.platform.serviceTokenHash;
const BACKUP_STATUS_FILE = appConfig.platform.backupStatusFile;
const storagePaths = () => {
  const dataDir = requestStorage.getStore()?.dataDir || DATA_DIR;
  return {
    dataDir,
    attachmentsDir: path.join(dataDir, "attachments"),
    logsDir: path.join(dataDir, "logs"),
    storeFile: path.join(dataDir, "store.json"),
    llmSettingsFile: path.join(dataDir, "llm-settings.json"),
    aiUsageFile: path.join(dataDir, "ai-usage.json"),
    aiCostPlanFile: path.join(dataDir, "ai-cost-plan.json")
  };
};
const { retentionDays: AI_AUDIT_RETENTION_DAYS, textLimit: AI_AUDIT_TEXT_LIMIT } = appConfig.audit;
const {
  aiQps: AI_GLOBAL_QPS, aiConcurrency: AI_GLOBAL_CONCURRENCY,
  segmentationQps: SEGMENTATION_GLOBAL_QPS, segmentationConcurrency: SEGMENTATION_GLOBAL_CONCURRENCY,
  speechQps: SPEECH_GLOBAL_QPS, speechConcurrency: SPEECH_GLOBAL_CONCURRENCY,
  ocrQps: OCR_GLOBAL_QPS, ocrConcurrency: OCR_GLOBAL_CONCURRENCY,
  documentQps: DOCUMENT_PARSE_GLOBAL_QPS, documentConcurrency: DOCUMENT_PARSE_GLOBAL_CONCURRENCY,
  aiDailyCalls: AI_USER_DAILY_CALL_LIMIT, usdCny: AI_COST_CNY_PER_USD,
  aiDailyCostCny: AI_USER_DAILY_COST_LIMIT_CNY, attachmentBytes: ATTACHMENT_USER_QUOTA_BYTES
} = appConfig.limits;
const STANDARD_BODY_MAX_BYTES = 12_000_000;
const ATTACHMENT_UPLOAD_BODY_MAX_BYTES = 36_000_000;
const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const ATTACHMENT_UPLOAD_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_AUDIO_MAX_DURATION_MS = 10 * 60 * 1000;
const clone = value => structuredClone(value);
const TEST_CURRENT_INSTANT = TEST_CURRENT_DATE ? new Date(`${TEST_CURRENT_DATE}T12:00:00+08:00`).toISOString() : "";
let testClockTick = 0;
const now = () => TEST_CURRENT_INSTANT
  ? new Date(Date.parse(TEST_CURRENT_INSTANT) + testClockTick++).toISOString()
  : new Date().toISOString();
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const isDirectLoopbackRequest = req => {
  const remote = String(req.socket.remoteAddress || "");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
    && !req.headers["x-forwarded-for"];
};
const serviceTokenMatches = req => {
  if (!PLATFORM_SERVICE_TOKEN_HASH) return false;
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(String(req.headers.authorization || ""));
  if (!match) return false;
  const actual = Buffer.from(sha256(match[1]), "hex");
  const expected = Buffer.from(PLATFORM_SERVICE_TOKEN_HASH, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const today = () => TEST_CURRENT_DATE || localDateKey();
const normalizeStore = createStoreNormalizer({ now, today, currentTime: Date.now });
const requestBinding = input => {
  const requestId = safeText(input?.requestId, 100), targetId = safeText(input?.targetId, 100);
  return requestId && targetId ? { requestId, targetId, inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0)) } : {};
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const aiGate = createRateGate(AI_GLOBAL_QPS, AI_GLOBAL_CONCURRENCY);
const segmentationGate = createRateGate(SEGMENTATION_GLOBAL_QPS, SEGMENTATION_GLOBAL_CONCURRENCY);
const speechGate = createRateGate(SPEECH_GLOBAL_QPS, SPEECH_GLOBAL_CONCURRENCY);
const ocrGate = createRateGate(OCR_GLOBAL_QPS, OCR_GLOBAL_CONCURRENCY);
const documentParseGate = createRateGate(DOCUMENT_PARSE_GLOBAL_QPS, DOCUMENT_PARSE_GLOBAL_CONCURRENCY);
const speechProvider = createVolcengineSpeechTransport({
  ...appConfig.speech,
  debugServerUrl: appConfig.debug.serverUrl,
  debugRunId: appConfig.debug.runId
});
const visionProvider = createVolcengineVisionTransport(appConfig.vision);

async function writeJsonAtomic(file, value) {
  if (PERSISTENCE_BACKEND === "postgres") throw new Error("JSON writes are disabled in PostgreSQL runtime");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await logEvent("system", "storage.write_failed", { level: "error", file: path.basename(file), error: errorMetadata(error) });
    throw Object.assign(new Error("数据保存失败，请稍后重试"), { code: "STORAGE_WRITE_FAILED" });
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function readStoredJson(file, fallback) {
  if (PERSISTENCE_BACKEND === "postgres") throw new Error("JSON reads are disabled in PostgreSQL runtime");
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid document");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return clone(fallback);
    await logEvent("system", "storage.read_failed", { level: "error", file: path.basename(file), error: errorMetadata(error) });
    throw Object.assign(new Error("数据无法读取，已保留原文件，请联系管理员"), { code: "STORAGE_READ_FAILED" });
  }
}

async function readStore() {
  return storeRepository.read();
}

const publicStateFromStore = createPublicStateProjection({
  getUser: () => requestStorage.getStore()?.user,
  isOwner,
  speechProvider,
  visionProvider,
  hash: sha256,
  now,
  today
});

function updateStore(mutator) {
  return storeRepository.update(mutator);
}

const postgresRuntime = PERSISTENCE_BACKEND === "postgres" ? await createPostgresRuntime({
  connectionString: appConfig.databaseUrl,
  authConnectionString: appConfig.authDatabaseUrl,
  budgetConnectionString: appConfig.aiBudgetDatabaseUrl,
  authRequired: AUTH_REQUIRED,
  getAccountId: () => requestStorage.getStore()?.user?.id || (AUTH_REQUIRED ? null : "local"),
  requireMigration: await hasJsonData(DATA_DIR),
  onPoolError: error => void logEvent("system", "storage.connection_failed", { level: "error", error: errorMetadata(error) })
}) : null;
if (postgresRuntime) {
  await postgresRuntime.claimApplication(() => process.exit(1));
  await markPostgresDirectory(DATA_DIR);
}
const aiBudgetRepository = createAiBudgetRepository({
  runtime: postgresRuntime,
  dataRoot: DATA_DIR
});
const aiBudgetService = createAiBudgetService({
  repository: aiBudgetRepository,
  policy: AI_BUDGET_POLICY,
  now
});
const aiBudgetRuntime = createAiBudgetRuntime({
  budget: aiBudgetService,
  onRecoveryError: (error, details) => logEvent("system", "ai.budget_recovery_failed", {
    level: "error",
    ...details,
    error: errorMetadata(error)
  })
});
const aiBudgetRecovery = await aiBudgetRuntime.recover();
if (aiBudgetRecovery.scanned || aiBudgetRecovery.failures.length) {
  await logEvent("system", "ai.budget_recovery_completed", {
    level: aiBudgetRecovery.failures.length ? "error" : "info",
    scanned: aiBudgetRecovery.scanned,
    released: aiBudgetRecovery.released.length,
    settled: aiBudgetRecovery.settled.length,
    failed: aiBudgetRecovery.failures.length
  });
}
const settingsRepository = createAccountDocumentRepository({
  runtime: postgresRuntime, name: "settings", getFile: () => storagePaths().llmSettingsFile,
  readDocument: readStoredJson, writeDocument: writeJsonAtomic,
  normalize: normalizeLlmSettings, emptyDocument: defaultLlmSettings, onCommit: auditChanges
});
const llmSettingsService = createLlmSettingsService({ repository: settingsRepository });
const { read: readLlmSettings, write: writeLlmSettings, ensure: ensureLlmSettings } = llmSettingsService;
const usageRepository = createAccountDocumentRepository({
  runtime: postgresRuntime, name: "usage", getFile: () => storagePaths().aiUsageFile,
  readDocument: readStoredJson, writeDocument: writeJsonAtomic, normalize: normalizeAiUsage, emptyDocument: {}
});
const {
  read: readAiUsage, update: updateAiUsage, ensure: ensureAiUsage, reserveAttempt: reserveAiAttempt
} = createAiUsageService({
  repository: usageRepository, getAccountKey: () => storagePaths().aiUsageFile,
  dailyCallLimit: AI_USER_DAILY_CALL_LIMIT, dailyCostLimitCny: AI_USER_DAILY_COST_LIMIT_CNY, cnyPerUsd: AI_COST_CNY_PER_USD,
  now
});
const aiAudit = createAiAudit({
  textLimit: AI_AUDIT_TEXT_LIMIT, getContext: () => requestStorage.getStore(),
  append: (day, entry) => appendPrivateJsonLine(path.join(storagePaths().logsDir, `ai-audit-${day}.ndjson`), entry),
  updateUsage: updateAiUsage, logEvent, now
});
const providerBudgetStage = (details, id = "provider-call") => {
  const official = details.costKnown === true ? null : resolveOfficialProviderPricing(details);
  const costKnown = details.costKnown === true || official?.costKnown === true;
  return {
    id,
    provider: safeText(details.provider, 80),
    service: safeText(details.service, 100),
    action: safeText(details.action, 120),
    scene: safeText(details.scene, 120),
    costKnown,
    ...(costKnown
      ? {
          estimatedCostCny: Math.max(
            0,
            Number(details.estimatedCostCny ?? (details.costKnown === true ? details.costCny : official.costCny)) || 0
          )
        }
      : {
          billingGap: safeText(details.costSource || official?.costSource, 500)
            || "运行时计量单位或合同单价尚未完成映射"
        })
  };
};
const conservativeDeepSeekStage = ({ id, scene, maxOutputTokens = 4000, model = "deepseek-v4-pro" }) => ({
  ...deepSeekBudgetStages({
    model,
    scene,
    maxInputTokens: 128_000,
    maxOutputTokens,
    maxAttempts: 1,
    stageIdPrefix: id
  })[0],
  id
});
const currentBudgetAccountId = () => safeText(requestStorage.getStore()?.user?.id, 100) || "local";
const logBudgetRejection = (details, error) => logEvent("system", "ai.budget_rejected", {
  level: "warn",
  provider: details.provider,
  service: details.service,
  action: details.action,
  scene: details.scene,
  error: errorMetadata(error)
});
async function meteredProviderCall(details, invoke, summarize, budgetContext = null) {
  const {
    budgeted = true,
    estimatedCostCny,
    ...auditDetails
  } = details;
  const budgetStage = providerBudgetStage(details);
  const reservedCostCny = Math.max(0, Number(estimatedCostCny ?? budgetStage.estimatedCostCny) || 0);
  if (!budgeted) return aiAudit.providerCall(auditDetails, invoke, summarize);
  const execute = async execution => {
    const accountReservation = await reserveAiAttempt({ estimatedCostCny: reservedCostCny });
    const releaseQuota = typeof accountReservation?.release === "function"
      ? accountReservation.release
      : accountReservation;
    const commitQuota = typeof accountReservation?.commit === "function"
      ? accountReservation.commit
      : accountReservation;
    let recordSiteUsage = () => false;
    const reservation = {
      retain: entry => {
        accountReservation?.retain?.(entry);
        recordSiteUsage(entry);
      },
      commit: typeof commitQuota === "function" ? () => commitQuota() : () => {}
    };
    const auditedCall = () => aiAudit.providerCall({ ...auditDetails, reservation }, invoke, summarize);
    let stageStarted = false;
    try {
      return await execution.runStage(budgetContext?.stageId || "provider-call", async ({ recordUsage }) => {
        recordSiteUsage = typeof recordUsage === "function" ? recordUsage : () => false;
        stageStarted = true;
        return auditedCall();
      });
    } catch (error) {
      if (!stageStarted && typeof releaseQuota === "function") releaseQuota();
      throw error;
    }
  };
  try {
    if (budgetContext?.execution) return await execute(budgetContext.execution);
    const context = requestStorage.getStore() || {};
    return await aiBudgetRuntime.executeTask({
      accountId: safeText(context.user?.id, 100) || "local",
      taskId: crypto.randomUUID(),
      stages: [budgetStage]
    }, execute);
  } catch (error) {
    if (error.statusCode === 429 || /(?:BUDGET|LIMIT)/.test(error.code || "")) {
      await logBudgetRejection(details, error);
    }
    throw error;
  }
}
async function executeDeepSeekBudgetTask(details, execute) {
  try {
    return await aiBudgetRuntime.executeTask({
      accountId: details.accountId,
      taskId: details.taskId,
      stages: deepSeekBudgetStages({
        model: details.model,
        scene: details.scene,
        maxInputTokens: details.maxInputTokens,
        maxOutputTokens: details.maxOutputTokens,
        maxAttempts: details.maxAttempts
      })
    }, execute);
  } catch (error) {
    if (error.statusCode === 429 || /(?:BUDGET|LIMIT)/.test(error.code || "")) {
      await logBudgetRejection(details, error);
    }
    throw error;
  }
}
const costRepository = createAccountDocumentRepository({
  runtime: postgresRuntime, name: "costPlan", getFile: () => storagePaths().aiCostPlanFile,
  readDocument: readStoredJson, writeDocument: writeJsonAtomic, normalize: value => value, emptyDocument: null,
  onCommit: auditChanges
});
const aiCosts = createAiCostService({ repository: costRepository, readSettings: readLlmSettings, readUsage: readAiUsage, cnyPerUsd: AI_COST_CNY_PER_USD, now });
let readModelRuntimeSettings = readLlmSettings;
const runDeepSeek = createAiGenerator({
  readSettings: () => readModelRuntimeSettings(), provider: createDeepSeekTransport({ endpoint: DEEPSEEK_API_URL }),
  getContext: () => requestStorage.getStore(), reserveAttempt: reserveAiAttempt, gate: aiGate, audit: aiAudit,
  executeBudgetTask: executeDeepSeekBudgetTask, now
});
const storeRepository = postgresRuntime ? postgresRuntime.createStoreRepository({
  normalize: normalizeStore,
  emptyDocument: emptyStore,
  onCommit: auditChanges,
  now,
  getContext: () => requestStorage.getStore()
}) : createJsonStoreRepository({
  getFile: () => storagePaths().storeFile,
  readDocument: readStoredJson,
  writeDocument: writeJsonAtomic,
  normalize: normalizeStore,
  emptyDocument: emptyStore,
  clone,
  onCommit: auditChanges,
  now,
  getContext: () => requestStorage.getStore()
});

const annotationService = createAnnotationService({ createId: () => crypto.randomUUID(), now });
const { reanchorAnnotations } = annotationService;
const trashService = createTrashService({ createId: () => crypto.randomUUID(), now, hash: sha256, retentionDays: TRASH_RETENTION_DAYS });
let cancelBackgroundTask = () => false;
const trashMutations = createTrashMutations({
  trash: trashService,
  annotations: annotationService,
  now,
  cancelTask: taskId => cancelBackgroundTask(taskId)
});
const { moveCollectionItemToTrash, moveNestedItemToTrash, moveThoughtChainToTrash, moveThoughtBlockToTrash } = trashMutations;
const attachmentCleanup = createAttachmentCleanup({
  repository: storeRepository, now, contextKey: () => storagePaths().storeFile,
  remove: resourcePath => imageAttachments.remove(resourcePath),
  dispatch: (callback, delay) => {
    const context = { ...(requestStorage.getStore() || {}) };
    const timer = setTimeout(() => requestStorage.run(context, callback), delay);
    timer.unref();
    return timer;
  },
  onRetryFailure: error => logEvent("system", "trash.attachment_cleanup_retry_failed", { level: "error", error: errorMetadata(error) }),
  onResult: result => logEvent("system", result.pending ? "trash.attachment_cleanup_pending" : "trash.attachment_cleanup_completed", {
    level: result.pending ? "error" : "info", removedCount: result.removed.length, pendingCount: result.pending
  })
});
const { resume: resumeAttachmentCleanup } = attachmentCleanup;
const imageAttachments = createImageAttachments({
  storage: attachmentStorage,
  getContext: () => ({ ...storagePaths(), ownerId: safeText(requestStorage.getStore()?.user?.id, 100) || "local" }),
  quotaBytes: ATTACHMENT_USER_QUOTA_BYTES, defaultMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
  inventory: postgresRuntime?.attachments,
  cleanFailedUploads: attachmentCleanup.cleanFailedUploads,
  onCleanupDeferred: error => logEvent("system", "attachment.cleanup_deferred", { level: "error", error: errorMetadata(error) })
});
const { save: saveImageDataUrls } = imageAttachments;
async function saveOriginalImages(req, images) {
  const key = safeText(req.headers["idempotency-key"], 100);
  if (!key) throw Object.assign(new Error("原图上传缺少幂等标识"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const idempotency = {
    scope: "attachments.uploadOriginals",
    key,
    requestHash: sha256(JSON.stringify(images))
  };
  const replay = await storeRepository.readIdempotent?.(idempotency);
  if (replay !== undefined) {
    const replayPaths = cleanAttachmentPaths(replay.attachmentPaths);
    const states = await Promise.allSettled(replayPaths.map(resourcePath => imageAttachments.read(resourcePath)));
    const missing = states.filter(item => item.status === "rejected" && (
      ["ENOENT", "NoSuchKey"].includes(item.reason?.code) || Number(item.reason?.status) === 404
    )).length;
    const unexpected = states.find(item => item.status === "rejected" && !(
      ["ENOENT", "NoSuchKey"].includes(item.reason?.code) || Number(item.reason?.status) === 404
    ));
    if (unexpected) throw unexpected.reason;
    if (!missing) return replay;
    if (missing !== replayPaths.length) {
      throw Object.assign(new Error("原图上传的幂等结果仅部分可用，请更换请求标识后重试"), {
        statusCode: 409,
        code: "IDEMPOTENCY_RESULT_STALE"
      });
    }
    await storeRepository.update(store => removeIdempotencyResponse(store, idempotency));
  }
  const uploaded = await imageAttachments.save(images, 2, { maxBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES });
  try {
    const result = await storeRepository.executeIdempotent(
      idempotency,
      () => ({ attachmentPaths: uploaded.attachmentPaths }),
      { onReplay: value => ({ ...value, duplicate: true }) }
    );
    if (result.duplicate) await attachmentCleanup.cleanFailedUploads(uploaded.attachmentPaths);
    return result;
  } catch (error) {
    await attachmentCleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
    throw error;
  }
}
async function saveKeepsakeImages(req, input) {
  const key = safeText(req.headers["idempotency-key"], 100);
  if (!key) throw Object.assign(new Error("小物图片上传缺少幂等标识"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const idempotency = {
    scope: "attachments.uploadKeepsake",
    key,
    requestHash: sha256(JSON.stringify({ image: input.image, alphaMask: input.alphaMask }))
  };
  const replay = await storeRepository.readIdempotent?.(idempotency);
  if (replay !== undefined) {
    const replayPaths = cleanAttachmentPaths(replay.attachmentPaths, 5);
    const states = await Promise.allSettled(replayPaths.map(resourcePath => imageAttachments.read(resourcePath)));
    const missing = states.filter(item => item.status === "rejected" && (
      ["ENOENT", "NoSuchKey"].includes(item.reason?.code) || Number(item.reason?.status) === 404
    )).length;
    const unexpected = states.find(item => item.status === "rejected" && !(
      ["ENOENT", "NoSuchKey"].includes(item.reason?.code) || Number(item.reason?.status) === 404
    ));
    if (unexpected) throw unexpected.reason;
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
      throw Object.assign(new Error("小物媒体上传的幂等结果仅部分可用，请更换请求标识后重试"), {
        statusCode: 409,
        code: "IDEMPOTENCY_RESULT_STALE"
      });
    }
    await storeRepository.update(store => removeIdempotencyResponse(store, idempotency));
  }
  const uploaded = await imageAttachments.saveKeepsakeSources({
    image: input.image,
    alphaMask: input.alphaMask,
    maxBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES
  });
  try {
    const result = await storeRepository.executeIdempotent(
      idempotency,
      () => ({ attachmentPath: uploaded.paths.originalPath, attachmentPaths: uploaded.attachmentPaths, ...uploaded.paths }),
      { onReplay: value => ({ ...value, duplicate: true }) }
    );
    if (result.duplicate) await attachmentCleanup.cleanFailedUploads(uploaded.attachmentPaths);
    return result;
  } catch (error) {
    await attachmentCleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
    throw error;
  }
}
async function saveOriginalAudio(req, input) {
  const key = safeText(req.headers["idempotency-key"], 100);
  if (!key) throw Object.assign(new Error("音频上传缺少幂等标识"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const durationMs = Math.round(Number(input.durationMs));
  if (!Number.isSafeInteger(durationMs) || durationMs < 250 || durationMs > ATTACHMENT_AUDIO_MAX_DURATION_MS) {
    throw Object.assign(new Error("录音时长必须在 0.25 秒到 10 分钟之间"), { statusCode: 400, code: "INVALID_AUDIO_DURATION" });
  }
  const idempotency = {
    scope: "attachments.uploadAudio",
    key,
    requestHash: sha256(JSON.stringify({ audio: input.audio, durationMs }))
  };
  const replay = await storeRepository.readIdempotent?.(idempotency);
  if (replay !== undefined) {
    const resourcePath = safeText(replay.audio?.attachmentPath, 300);
    try {
      if (resourcePath) await imageAttachments.read(resourcePath);
      if (resourcePath) return replay;
    } catch (error) {
      const missing = ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404;
      if (!missing) throw error;
    }
    await storeRepository.update(store => removeIdempotencyResponse(store, idempotency));
  }
  const uploaded = await imageAttachments.saveAudio(input.audio, { maxBytes: ATTACHMENT_UPLOAD_AUDIO_MAX_BYTES });
  const audio = {
    attachmentPath: uploaded.attachmentPath,
    mimeType: uploaded.mimeType,
    bytes: uploaded.bytes,
    durationMs
  };
  // #region debug-point B-D:audio-upload
  fetch(appConfig.debug.serverUrl,{method:"POST",body:JSON.stringify({sessionId:"login-audio-production",runId:appConfig.debug.runId,hypothesisId:"B-D",location:"server.mjs:saveOriginalAudio",msg:"[DEBUG] Audio upload normalized metadata",data:{extension:path.extname(audio.attachmentPath),mimeType:audio.mimeType,bytes:audio.bytes,durationMs:audio.durationMs},ts:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    const result = await storeRepository.executeIdempotent(
      idempotency,
      () => ({ audio }),
      { onReplay: value => ({ ...value, duplicate: true }) }
    );
    if (result.duplicate) await attachmentCleanup.cleanFailedUploads([uploaded.attachmentPath]);
    return result;
  } catch (error) {
    await attachmentCleanup.cleanFailedUploads([uploaded.attachmentPath]).catch(() => {});
    throw error;
  }
}
async function discardOriginalUploads(value, uploadRequestId = "", scope = "attachments.uploadOriginals") {
  const maxPaths = scope === "attachments.uploadKeepsake" ? 5 : scope === "attachments.uploadAudio" ? 1 : 2;
  const attachmentPaths = cleanAttachmentPaths(value, maxPaths);
  const key = safeText(uploadRequestId, 100);
  if (!key) throw Object.assign(new Error("清理附件上传缺少幂等标识"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  const prepared = await storeRepository.update(store => {
    const ledger = store[METADATA_FIELD]?.idempotency?.find(item => (
      item.scope === scope && item.key === key
    ));
    const ledgerPaths = cleanAttachmentPaths(
      scope === "attachments.uploadAudio"
        ? [ledger?.response?.audio?.attachmentPath]
        : ledger?.response?.attachmentPaths,
      maxPaths
    );
    const requested = attachmentPaths.filter(resourcePath => ledgerPaths.includes(resourcePath));
    const { [METADATA_FIELD]: _metadata, attachmentCleanup: _cleanup, ...visibleStore } = store;
    const referenced = collectAttachmentPaths(visibleStore);
    const removable = requested.filter(resourcePath => !referenced.has(resourcePath));
    if (removable.length) {
      attachmentCleanup.enqueue(store, new Set(removable));
      if (removable.length === ledgerPaths.length && requested.length === ledgerPaths.length) {
        removeIdempotencyResponse(store, { scope, key });
      }
    }
    return { removable };
  });
  const result = await attachmentCleanup.resume();
  return {
    discarded: result.removed.filter(resourcePath => prepared.removable.includes(resourcePath)),
    pending: result.pending
  };
}
const discardOriginalAudio = (value, uploadRequestId = "") => discardOriginalUploads(
  [value],
  uploadRequestId,
  "attachments.uploadAudio"
);
async function materializeAttachmentFiles(resourcePaths) {
  const tempDir = path.join(storagePaths().dataDir, "tmp");
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  await fs.chmod(tempDir, 0o700);
  const files = [];
  try {
    for (const resourcePath of cleanAttachmentPaths(resourcePaths)) {
      const extension = path.extname(resourcePath).toLowerCase();
      const file = path.join(tempDir, `${crypto.randomUUID()}${[".png", ".jpg", ".jpeg", ".webp"].includes(extension) ? extension : ".jpg"}`);
      files.push(file);
      await fs.writeFile(file, await imageAttachments.read(resourcePath), { mode: 0o600 });
    }
    return files;
  } catch (error) {
    await cleanupTemporaryFiles(files);
    throw error;
  }
}
const keepsakeMediaWorkflows = createKeepsakeMediaWorkflows({
  repository: storeRepository,
  attachments: imageAttachments,
  cleanup: attachmentCleanup,
  parse: keepsakePayload,
  createId: () => crypto.randomUUID(),
  now,
  contextKey: () => requestStorage.getStore()?.dataDir || DATA_DIR,
  dispatch: callback => {
    const context = { ...(requestStorage.getStore() || {}) };
    setImmediate(() => requestStorage.run(context, callback));
  },
  onError: (id, error) => logEvent("system", "keepsake.derivative_failed", {
    level: "error", keepsakeId: id, error: errorMetadata(error)
  })
});
const segmentKeepsakeImage = createKeepsakeSegmentation({
  saveImages: saveImageDataUrls, cleanupFiles: cleanupTemporaryFiles,
  provider: createAliyunSegmentationTransport({ ...appConfig.segmentation, auditCall: meteredProviderCall }),
  gate: segmentationGate,
  onFailure: (error, callGroupId) => logEvent("system", "segmentation.failed", { level: "error", callGroupId, error: errorMetadata(error) })
});
const understandKeepsakeImage = createKeepsakeImageUnderstanding({
  saveImages: saveImageDataUrls,
  cleanupFiles: cleanupTemporaryFiles,
  generate: (file, { existingTags = [] } = {}) => runDeepSeek(renderPrompt("keepsake.image.candidates", {
    existingTags: JSON.stringify(existingTags)
  }), {
    imagePath: file,
    scene: "contentImageUnderstanding",
    json: true,
    maxTokens: 1200
  })
});
const trashCommands = createTrashCommands({ repository: storeRepository, trash: trashService, mutations: trashMutations, cleanup: attachmentCleanup });
const annotationCommands = createAnnotationCommands({ repository: storeRepository, annotations: annotationService, moveNestedItemToTrash });
const thoughtService = createThoughtService({
  repository: storeRepository,
  createId: () => crypto.randomUUID(),
  now,
  recordVersion,
  eventTimeFields,
  reanchorAnnotations,
  getCursorScope: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
  reconcileOriginalImages: (...args) => contentAttachmentService.reconcileOriginalImagesInStore(...args)
});
const collectionStoreRepository = collection => ({
  read: async () => (await readStore())[collection],
  update: mutate => updateStore(store => mutate(store[collection], store.trash, store)),
  executeIdempotent: (request, operation, options) => storeRepository.executeIdempotent(
    request,
    store => operation(store[collection], store.trash, store),
    options
  )
});
const journalStoreRepository = {
  read: async () => {
    const store = await readStore();
    return { journals: store.journals, journalDraft: store.journalDraft, trash: store.trash };
  },
  update: mutate => updateStore(async store => {
    const value = { journals: store.journals, journalDraft: store.journalDraft, trash: store.trash };
    const result = await mutate(value);
    store.journals = value.journals;
    store.journalDraft = value.journalDraft;
    store.trash = value.trash;
    return result;
  }),
  executeIdempotent: (request, operation, options) => storeRepository.executeIdempotent(
    request,
    async store => {
      const value = { journals: store.journals, journalDraft: store.journalDraft, trash: store.trash };
      const result = await operation(value);
      store.journals = value.journals;
      store.journalDraft = value.journalDraft;
      store.trash = value.trash;
      return result;
    },
    options
  )
};
const reviewStoreRepository = {
  read: async () => {
    const store = await readStore();
    return {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    };
  },
  update: mutate => updateStore(async store => {
    const value = {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics
    };
    const result = await mutate(value, store.trash);
    store.analyses = value.analyses;
    store.experiments = value.experiments;
    store.customMetrics = value.customMetrics;
    return result;
  }),
  executeIdempotent: (request, operation, options) => storeRepository.executeIdempotent(
    request,
    async store => {
      const value = {
        analyses: store.analyses,
        experiments: store.experiments,
        customMetrics: store.customMetrics
      };
      const result = await operation(value, store.trash);
      store.analyses = value.analyses;
      store.experiments = value.experiments;
      store.customMetrics = value.customMetrics;
      return result;
    },
    options
  )
};
const captureRecords = createCaptureRecords({
  repository: collectionStoreRepository("captures"),
  reanchorAnnotations,
  reconcileOriginalImages: (...args) => contentAttachmentService.reconcileOriginalImagesInStore(...args),
  reconcileAudioAttachment: (store, { captureId, previousAudio, previousTranscription, nextAudio }) => {
    if (!previousAudio?.attachmentPath || previousAudio.attachmentPath === nextAudio?.attachmentPath) return null;
    const entry = trashService.add(store.trash, "captureAudio", {
      id: captureId,
      audio: previousAudio,
      transcription: previousTranscription
    }, {
      kind: "captureAudio",
      parentCollection: "captures",
      parentId: captureId
    });
    return { trashId: entry.id };
  },
  now,
  createId: () => crypto.randomUUID()
});
const journalRecords = createJournalRecords({
  repository: journalStoreRepository,
  reanchorAnnotations,
  now,
  createId: () => crypto.randomUUID()
});
const checkinRecords = createCheckinRecords({
  repository: collectionStoreRepository("checkins"),
  now,
  createId: () => crypto.randomUUID()
});
const dailyRecordRecords = createDailyRecordRecords({
  repository: collectionStoreRepository("dailyRecords"),
  now,
  createId: () => crypto.randomUUID()
});
const keepsakeRecords = createKeepsakeRecords({
  repository: collectionStoreRepository("keepsakes"),
  now,
  createId: () => crypto.randomUUID()
});
const bookRecords = createBookRecords({
  repository: collectionStoreRepository("books"),
  reanchorAnnotations,
  now,
  createId: () => crypto.randomUUID()
});
const quoteRecords = createQuoteRecords({
  repository: collectionStoreRepository("quotes"),
  reanchorAnnotations,
  now,
  createId: () => crypto.randomUUID()
});
const chatRecords = createChatRecords({
  repository: collectionStoreRepository("chats"),
  now,
  createId: () => crypto.randomUUID()
});
const reviewRecords = createReviewRecords({
  repository: reviewStoreRepository,
  now,
  createId: () => crypto.randomUUID()
});
const discoveryService = createThoughtDiscoveryService({ repository: storeRepository, now });
const actionsService = createActionsService({ repository: storeRepository, now, today, createId: () => crypto.randomUUID() });
const feedbackService = createFeedbackService({ repository: storeRepository, now, createId: () => crypto.randomUUID(), hash: sha256 });

async function ensureStore() {
  const { dataDir, storeFile } = storagePaths();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  await imageAttachments.prepareDirectory();
  if (postgresRuntime) {
    await storeRepository.initialize({ allowCreate: !AUTH_REQUIRED });
    await imageAttachments.recover();
    return;
  }
  const original = await readStoredJson(storeFile, null);
  if (original && Number(original.version || 1) < STORE_VERSION) {
    const stamp = now().replace(/\D/g, "").slice(0, 14);
    const backup = `${storeFile}.v${Number(original.version || 1)}-pre-v${STORE_VERSION}.${stamp}.bak`;
    await fs.copyFile(storeFile, backup);
    await fs.chmod(backup, 0o600);
  }
  await writeJsonAtomic(storeFile, normalizeStore(original || {}));
  await storeRepository.update(store => store);
}

async function recoverAiUsageFromAuditLogs() {
  let names = [];
  try {
    names = await fs.readdir(storagePaths().logsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const recovered = new Map();
  for (const name of names.filter(value => /^ai-audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(value)).sort()) {
    const content = await fs.readFile(path.join(storagePaths().logsDir, name), "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = usageEntryFromAudit(JSON.parse(line));
        if (entry?.callId) recovered.set(entry.callId, entry);
      } catch {}
    }
  }
  if (recovered.size) {
    await updateAiUsage(usage => {
      if (!Array.isArray(usage.entries)) usage.entries = [];
      const existing = new Set(usage.entries.map(item => item.callId || item.id).filter(Boolean));
      for (const [callId, entry] of recovered) if (!existing.has(callId)) usage.entries.push(entry);
    });
  }
  await aiAudit.recoverPending();
}

async function ensureAuditLogs() {
  await pruneLogs(storagePaths().logsDir, AI_AUDIT_RETENTION_DAYS);
  await recoverAiUsageFromAuditLogs();
}

const { sendJson, bodyJson } = createJsonHttp({
  getContext: () => requestStorage.getStore(), maxBodyBytes: STANDARD_BODY_MAX_BYTES
});
const respondModel = createModelResponseHttp({
  getContext: () => requestStorage.getStore(), logEvent, sendJson
});
const accountLifecycle = createAccountLifecycle({
  dataDir: DATA_DIR,
  usersDir: USERS_DIR,
  authRequired: AUTH_REQUIRED,
  postgresRuntime,
  requestStorage,
  emptyStore,
  normalizeStore,
  normalizeLlmSettings,
  normalizeAiUsage,
  ensureStore,
  ensureLlmSettings,
  ensureAiUsage,
  ensureAuditLogs,
  resumeAttachmentCleanup,
  backgroundAi: { resume: () => backgroundAi.resume() },
  keepsakeMediaWorkflows: { resume: () => keepsakeMediaWorkflows.resume() }
});
const {
  userDataDir,
  initializeUserStorage
} = accountLifecycle;
const bindAuthenticatedUser = user => {
  const context = requestStorage.getStore();
  if (context) {
    Object.assign(context, {
      user,
      ...(AUTH_REQUIRED ? { dataDir: userDataDir(user) } : {})
    });
  }
};
const localTestSessions = createLocalTestSessionVault({
  enabled: LOCAL_TEST_MODE,
  cookieName: LOCAL_TEST_SESSION_COOKIE,
  maxAgeSeconds: LOCAL_TEST_SESSION_MAX_AGE_SECONDS
});
const localTestUpstream = createReadOnlyUpstream({
  origin: UPSTREAM_ORIGIN,
  sessions: localTestSessions,
  requestStorage
});
const localTestRuntime = createLocalTestRuntime({
  enabled: LOCAL_TEST_MODE,
  upstreamConfigured: Boolean(UPSTREAM_ORIGIN),
  dataDir: DATA_DIR,
  controlFile: LOCAL_TEST_CONTROL_FILE,
  workspacesDir: LOCAL_TEST_WORKSPACES_DIR,
  resetOnStart: LOCAL_TEST_RESET_ON_START,
  mainUserId: LOCAL_TEST_MAIN_USER_ID,
  requestStorage,
  storeRepository,
  storagePaths,
  emptyStore,
  normalizeStore,
  readDocument: readStoredJson,
  writeDocument: writeJsonAtomic,
  ensureStore,
  ensureSettings: ensureLlmSettings,
  ensureUsage: ensureAiUsage,
  ensureAuditLogs,
  writeSettings: value => writeLlmSettings(normalizeLlmSettings(value)),
  projectState: publicStateFromStore,
  readStore,
  updateStore,
  sessionForRequest: localTestSessions.get,
  isOwner,
  upstream: localTestUpstream,
  now
});
const localTestHttp = createLocalTestHttp({
  runtime: localTestRuntime,
  sessions: localTestSessions,
  basePath: APP_BASE_PATH,
  sendJson,
  bodyJson,
  bindUser: bindAuthenticatedUser,
  proxyToUpstream
});

async function adminSnapshotApi(req, res, url) {
  if (url.pathname !== "/api/admin/v1/snapshot") return false;
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  if (!PLATFORM_SERVICE_TOKEN_HASH) return sendJson(res, 404, { error: "Not found" });
  if (!isDirectLoopbackRequest(req)) return sendJson(res, 403, { error: "管理员数据接口只允许本机服务访问" });
  if (!serviceTokenMatches(req)) return sendJson(res, 401, { error: "服务凭据无效" });
  const snapshot = await buildAdminSnapshot({
    dataDir: DATA_DIR,
    version: APP_VERSION,
    cnyPerUsd: AI_COST_CNY_PER_USD,
    dailyCostLimitCny: AI_USER_DAILY_COST_LIMIT_CNY,
    attachmentQuotaBytes: ATTACHMENT_USER_QUOTA_BYTES,
    attachmentMode: attachmentStorage.mode,
    attachmentUsageBytes: (ownerId, localDir) => attachmentStorage.usageBytes({ ownerId, localDir }),
    backupStatusFile: BACKUP_STATUS_FILE,
    dailyCallLimit: AI_USER_DAILY_CALL_LIMIT,
    readAuthData: postgresRuntime ? readAuth : null,
    readAccountData: postgresRuntime ? account => requestStorage.run({
      ...(requestStorage.getStore() || {}),
      user: account,
      dataDir: userDataDir(account)
    }, async () => {
      const [store, usage, settings, costPlan] = await Promise.all([
        readStore(),
        readAiUsage(),
        settingsRepository.read(),
        costRepository.read()
      ]);
      return {
        store,
        usage,
        structuredBytes: Buffer.byteLength(JSON.stringify({ store, usage, settings, costPlan })),
        structuredObjects: [store, usage, settings, costPlan].filter(value => value != null).length
      };
    }) : null
  });
  return sendJson(res, 200, snapshot);
}

async function proxyToUpstream(req, res, url) {
  const chunks = [], maxBytes = ["/api/images/upload", "/api/audio/upload"].includes(url.pathname)
    ? ATTACHMENT_UPLOAD_BODY_MAX_BYTES
    : STANDARD_BODY_MAX_BYTES;
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) return sendJson(res, 413, { error: "内容过长", code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {};
  for (const name of ["accept", "content-type", "user-agent", "range", "if-range"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const upstreamCookie = localTestHttp.upstreamCookie(req);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  headers["x-request-id"] = requestStorage.getStore().traceId;
  const response = await fetch(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
  const responseHeaders = {};
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "location",
    "x-accel-buffering",
    "x-request-id"
  ]) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() || (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  const localResponse = await localTestHttp.rewriteProxyResponse({
    request: req,
    pathname: url.pathname,
    upstreamResponse: response,
    cookies,
    responseHeaders
  });
  if (!localResponse && cookies.length) {
    responseHeaders["set-cookie"] = cookies;
  }
  res.writeHead(response.status, responseHeaders);
  if (!response.body) return res.end();
  for await (const chunk of response.body) {
    if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once("drain", resolve));
  }
  res.end();
}

const auditAuthChanges = async (before, after) => {
  const current = requestStorage.getStore() || {};
  let actor = current.user || null;
  if (!actor) {
    const priorUsers = new Set((before?.users || []).map(user => user.id));
    actor = (after?.users || []).find(user => !priorUsers.has(user.id)) || null;
  }
  if (!actor) {
    const priorSessions = new Set((before?.sessions || []).map(session => session.tokenHash));
    const session = (after?.sessions || []).find(item => !priorSessions.has(item.tokenHash));
    actor = (after?.users || []).find(user => user.id === session?.userId) || null;
  }
  if (!actor) return auditChanges(before, after);
  return requestStorage.run(
    { ...current, user: actor, dataDir: userDataDir(actor) },
    () => auditChanges(before, after)
  );
};
const authRepository = createAuthRepository({
  runtime: postgresRuntime, file: AUTH_FILE, readDocument: readStoredJson,
  writeDocument: writeJsonAtomic, onCommit: auditAuthChanges,
  onInvalid: () => logEvent("system", "storage.read_failed", { level: "error", file: "auth.json", error: { code: "INVALID_AUTH_DOCUMENT" } })
});
const readAuth = () => authRepository.read();
const authService = createAuthService({
  repository: authRepository, authRequired: AUTH_REQUIRED, inviteCodeHash: INVITE_CODE_HASH,
  initializeUserStorage
});
if (AUTH_REQUIRED) await authService.migrate();
const { requestAuthentication, authApi } = createAuthHttp({
  service: authService, sendJson, bodyJson, authRequired: AUTH_REQUIRED,
  basePath: APP_BASE_PATH, cookieSecure: COOKIE_SECURE,
  bindUser: bindAuthenticatedUser
});
readModelRuntimeSettings = async () => {
  const context = requestStorage.getStore() || {};
  const userSettings = await readLlmSettings();
  if (!AUTH_REQUIRED || isOwner(context.user)) return userSettings;
  const owner = (await readAuth()).users.find(isOwner);
  if (!owner) return userSettings;
  const ownerSettings = await requestStorage.run(
    { ...context, user: owner, dataDir: userDataDir(owner) },
    readLlmSettings
  );
  return normalizeLlmSettings({
    ...userSettings,
    provider: ownerSettings.provider,
    profiles: ownerSettings.profiles,
    scenarios: ownerSettings.scenarios,
    apiKey: ownerSettings.apiKey
  });
};

function normalizedLocalDateTimeText(value) {
  const text = safeText(value, 40).replace(" ", "T");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/.exec(text);
  return match ? `${match[1]}:${match[2] || "00"}` : "";
}

function normalizeParsedImage(kind, value = {}) {
  if (kind === "weight" || kind === "exercise") return normalizeHealthImage(kind, value);
  if (kind === "sleep") {
    const deepMinutes = nullableNumber(value.deepMinutes, 0, 1440, true), lightMinutes = nullableNumber(value.lightMinutes, 0, 1440, true), remMinutes = nullableNumber(value.remMinutes, 0, 1440, true);
    const stageTotal = [deepMinutes, lightMinutes, remMinutes].every(Number.isFinite) ? deepMinutes + lightMinutes + remMinutes : null;
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(value.date || "") ? value.date : "",
      bedtime: normalizedLocalDateTimeText(value.bedtime),
      wakeTime: normalizedLocalDateTimeText(value.wakeTime),
      totalMinutes: nullableNumber(value.totalMinutes, 0, 1440, true) ?? stageTotal,
      deepMinutes, deepPercent: nullableNumber(value.deepPercent, 0, 100),
      lightMinutes, lightPercent: nullableNumber(value.lightPercent, 0, 100),
      remMinutes, remPercent: nullableNumber(value.remPercent, 0, 100),
      awakeCount: nullableNumber(value.awakeCount, 0, 100, true),
      awakeMinutes: nullableNumber(value.awakeMinutes, 0, 1440, true),
      averageHeartRate: nullableNumber(value.averageHeartRate, 20, 250),
      averageOxygen: nullableNumber(value.averageOxygen, 50, 100),
      respiratoryRate: nullableNumber(value.respiratoryRate, 1, 80),
      verification: safeText(value.verification, 500)
    };
  }
  if (kind === "heartRate") {
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(value.date || "") ? value.date : "",
      minimum: nullableNumber(value.minimum, 20, 250),
      maximum: nullableNumber(value.maximum, 20, 250),
      average: nullableNumber(value.average, 20, 250),
      resting: nullableNumber(value.resting, 20, 250),
      sleepAverage: nullableNumber(value.sleepAverage, 20, 250),
      trendAnalysis: safeText(value.trendAnalysis, 1200),
      trendSegments: (Array.isArray(value.trendSegments) ? value.trendSegments : []).slice(0, 8).map(item => ({
        period: safeText(item?.period, 80),
        direction: ["下降", "上升", "平稳", "波动"].includes(item?.direction) ? item.direction : "波动",
        approximateRange: safeText(item?.approximateRange, 80)
      })).filter(item => item.period),
      verification: safeText(value.verification, 500)
    };
  }
  throw new Error("不支持这种截图类型");
}

async function recognizeVisualFiles(files, { budgetExecution = null, stageIds = [] } = {}) {
  if (!visionProvider.configured) return null;
  const results = [];
  for (const [index, file] of files.entries()) {
    const data = await fs.readFile(file);
    const release = await ocrGate.acquire();
    try {
      results.push(await meteredProviderCall({
        provider: "volcengine",
        service: "vision",
        scene: "visionOcr",
        action: "OCRNormal",
        request: { imageBytes: data.length },
        modality: "vision",
        imageCount: 1,
        imageBytes: data.length,
        unitType: "call",
        units: 1
      }, async () => {
        return await visionProvider.recognizeText({ data });
      }, undefined, budgetExecution ? {
        execution: budgetExecution,
        stageId: stageIds[index]
      } : null));
    } finally {
      release();
    }
  }
  return results.map((result, index) => `<image index="${index + 1}">\n${result.text || "（未识别到文字）"}\n</image>`).join("\n");
}

async function parseImageRequest(input, kind) {
  const config = IMAGE_PARSE_CONFIG[kind];
  if (!config) throw new Error("不支持这种截图类型");
  const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
  const requestedPaths = Array.isArray(input.attachmentPaths) ? input.attachmentPaths : [];
  const attachmentPaths = cleanAttachmentPaths(requestedPaths);
  if (images.length && requestedPaths.length) throw new Error("截图只能使用一种上传方式");
  if (requestedPaths.length && (attachmentPaths.length !== requestedPaths.length || attachmentPaths.length > config.maxImages)) {
    throw new Error(`最多提交 ${config.maxImages} 张有效截图`);
  }
  if (!images.length && !attachmentPaths.length) throw new Error(kind === "sleep" ? "睡眠识别需要 1～2 张图片" : "请先上传截图");
  const uploaded = attachmentPaths.length
    ? { files: await materializeAttachmentFiles(attachmentPaths), attachmentPaths, cleanupFiles: [] }
    : await saveImageDataUrls(images, config.maxImages, { needsLocalFiles: true });
  if (attachmentPaths.length) uploaded.cleanupFiles = uploaded.files;
  try {
    const ocrStageIds = visionProvider.configured
      ? uploaded.files.map((_, index) => `ocr-${index + 1}`)
      : [];
    const modelStageId = "deepseek-extraction";
    const stages = [
      ...ocrStageIds.map(id => providerBudgetStage({
        provider: "volcengine",
        service: "vision",
        scene: "visionOcr",
        action: "OCRNormal",
        unitType: "call",
        units: 1
      }, id)),
      conservativeDeepSeekStage({
        id: modelStageId,
        scene: config.scene,
        model: visionProvider.configured ? "deepseek-v4-pro" : "deepseek-flash"
      })
    ];
    return await aiBudgetRuntime.executeTask({
      accountId: currentBudgetAccountId(),
      taskId: `image-parse:${crypto.randomUUID()}`,
      stages
    }, async budgetExecution => {
      const referenceDate = /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate || "") ? input.referenceDate : today();
      const dateContext = renderPrompt("health.image.referenceDate", { referenceDate });
      const recognizedText = await recognizeVisualFiles(uploaded.files, {
        budgetExecution,
        stageIds: ocrStageIds
      });
      const raw = await runDeepSeek(
        recognizedText
          ? `${config.prompt}${dateContext}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
          : `${config.prompt}${dateContext}`,
        {
          scene: config.scene,
          ...(recognizedText ? {} : { imagePaths: uploaded.files }),
          json: true,
          maxTokens: 4000,
          budgetExecution,
          budgetStageIds: [modelStageId]
        }
      );
      let parsed = {};
      try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ""); }
      catch { throw new Error("截图已读取，但模型返回格式无法解析，请重试或手动填写"); }
      return { ...normalizeParsedImage(kind, parsed), attachmentPaths: uploaded.attachmentPaths };
    });
  } catch (error) {
    if (!attachmentPaths.length) await imageAttachments.discard(uploaded.attachmentPaths);
    throw error;
  } finally {
    await cleanupTemporaryFiles(uploaded.cleanupFiles);
  }
}

const IMAGE_PARSE_CONFIG = {
  ...createHealthImageConfig(),
  book: {
    scene: "bookRecognition",
    maxImages: 1,
    prompt: promptText("health.image.book")
  },
  sleep: {
    scene: "healthRecognition",
    maxImages: 2,
    prompt: promptText("health.image.sleep")
  },
  heartRate: {
    scene: "healthRecognition",
    maxImages: 1,
    prompt: promptText("health.image.heartRate")
  }
};

const contentAttachmentService = createContentAttachmentService({
  repository: storeRepository,
  trash: trashService,
  attachmentInventory: listAttachmentInventory,
  getAccountId: () => requestStorage.getStore()?.user?.id || "local",
  cancelTask: taskId => cancelBackgroundTask(taskId),
  requestImageUnderstanding: async work => {
    const created = await backgroundAi.enqueue({
      kind: "contentImageUnderstanding",
      resourceType: work.taskResourceType,
      targetId: work.taskTargetId,
      subtargetId: work.taskSubtargetId,
      inputVersion: work.inputVersion,
      payload: {
        targetType: work.targetType,
        targetId: work.targetId,
        attachmentPaths: work.attachmentPaths
      },
      clientRequestId: work.clientRequestId
    });
    if (created.unsupported) throw Object.assign(new Error("不支持这种后台任务"), { statusCode: 400, code: "UNSUPPORTED_AI_TASK" });
    if (created.missing) throw Object.assign(new Error("图片原文目标不存在或已经变化"), { statusCode: 404, code: "CONTENT_ATTACHMENT_TARGET_NOT_FOUND" });
    if (created.invalid) throw Object.assign(new Error("图片理解请求缺少幂等标识"), { statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
    if (created.conflict) throw Object.assign(new Error("同一幂等键不能用于不同图片理解请求"), { statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    if (created.versionConflict) throw Object.assign(new Error("图片原文已变化，请刷新后重试"), { statusCode: 409, code: "VERSION_CONFLICT" });
    return publicAiTask(created.task);
  },
  now,
  createId: () => crypto.randomUUID()
});
async function prepareCaptureAsrAudio(work, signal) {
  if (work.audio.asrAttachmentPath) {
    try {
      return {
        audio: await imageAttachments.read(work.audio.asrAttachmentPath),
        mimeType: work.audio.asrMimeType || "audio/wav"
      };
    } catch (error) {
      const missing = ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404;
      if (!missing) throw error;
    }
  }
  const source = await imageAttachments.read(work.audio.attachmentPath);
  const prepared = await speechProvider.prepareAsrAudio({
    audio: source,
    mimeType: work.audio.mimeType,
    signal
  });
  if (prepared.audio === source && prepared.mimeType === work.audio.mimeType) return prepared;
  const derived = await imageAttachments.saveAsrAudio({
    sourcePath: work.audio.attachmentPath,
    data: prepared.audio,
    mimeType: prepared.mimeType
  });
  const attached = await storeRepository.update(store => {
    const capture = store.captures?.find(item => item.id === work.capture.id);
    if (!capture || capture.audio?.attachmentPath !== work.audio.attachmentPath) return false;
    capture.audio = {
      ...capture.audio,
      asrAttachmentPath: derived.attachmentPath,
      asrMimeType: derived.mimeType,
      asrBytes: derived.bytes
    };
    capture.updatedAt = now();
    capture.version = recordVersion(capture.version) + 1;
    return true;
  });
  if (!attached) {
    await attachmentCleanup.cleanFailedUploads([derived.attachmentPath]).catch(() => {});
    throw Object.assign(new Error("语音原件已经变化，转写派生物未保留"), { code: "TRANSCRIPTION_STALE" });
  }
  // #region debug-point E:asr-derivative
  fetch(appConfig.debug.serverUrl,{method:"POST",body:JSON.stringify({sessionId:"login-audio-production",runId:appConfig.debug.runId,hypothesisId:"E",location:"server.mjs:prepareCaptureAsrAudio",msg:"[DEBUG] ASR derivative persisted",data:{targetId:safeText(work.capture.id,100),sourcePath:work.audio.attachmentPath,derivedPath:derived.attachmentPath,mimeType:derived.mimeType,bytes:derived.bytes},ts:Date.now()})}).catch(()=>{});
  // #endregion
  return { audio: prepared.audio, mimeType: prepared.mimeType };
}
async function transcribeCapture(work, { signal } = {}) {
  const preparedAudio = await prepareCaptureAsrAudio(work, signal);
  const audio = preparedAudio.audio;
  const audioMimeType = preparedAudio.mimeType;
  const asrStageId = "speech-recognition";
  const polishStageId = "deepseek-polish";
  const condenseStageId = "deepseek-condense";
  return aiBudgetRuntime.executeTask({
    accountId: currentBudgetAccountId(),
    taskId: `capture-transcription:${work.taskId}`,
    stages: [
      providerBudgetStage({
        provider: "volcengine",
        service: "speech",
        scene: "speechRecognition",
        action: "streamingAsr",
        unitType: "audioMillisecond",
        units: ATTACHMENT_AUDIO_MAX_DURATION_MS
      }, asrStageId),
      conservativeDeepSeekStage({
        id: polishStageId,
        scene: "capturePolish"
      }),
      conservativeDeepSeekStage({
        id: condenseStageId,
        scene: "capturePolish"
      })
    ]
  }, async budgetExecution => {
    const release = await speechGate.acquire();
    let transcription;
    try {
      transcription = await meteredProviderCall({
        provider: "volcengine",
        service: "speech",
        scene: "speechRecognition",
        action: "streamingAsr",
        request: { audioBytes: audio.length, mimeType: audioMimeType },
        modality: "audio",
        unitType: "audioMillisecond",
        units: ATTACHMENT_AUDIO_MAX_DURATION_MS
      }, () => speechProvider.transcribe({
          audio,
          mimeType: audioMimeType,
          signal
        }), result => {
          const durationMs = Math.min(
            ATTACHMENT_AUDIO_MAX_DURATION_MS,
            Math.max(0, Math.round(Number(result?.durationMs) || 0))
          );
          return durationMs
            ? {
                providerRequestId: result?.providerRequestId || "",
                unitType: "audioMillisecond",
                units: durationMs
              }
            : {
                providerRequestId: result?.providerRequestId || "",
                unitType: "audioMillisecond",
                units: 0,
                costKnown: false,
                costSource: "Provider response did not include a measured audio duration"
              };
        }, {
          execution: budgetExecution,
          stageId: asrStageId
        });
    } finally {
      release();
    }
    let polishedText = "", polishErrorCode = "";
    try {
      polishedText = await runDeepSeek(
        renderPrompt("capture.transcription.polish", { rawText: transcription.rawText }),
        {
          scene: "capturePolish",
          maxTokens: 4000,
          signal,
          budgetExecution,
          budgetStageIds: [polishStageId]
        }
      );
    } catch (error) {
      polishErrorCode = safeText(error.code, 120) || "POLISH_FAILED";
      await logEvent("system", "capture.transcription_polish_failed", {
        level: "warn",
        captureId: work.capture.id,
        error: errorMetadata(error)
      });
    }
    let condensedText = "", condenseErrorCode = "";
    try {
      condensedText = await runDeepSeek(
        renderPrompt("capture.transcription.condense", {
          rawText: transcription.rawText,
          polishedText
        }),
        {
          scene: "capturePolish",
          maxTokens: 4000,
          signal,
          budgetExecution,
          budgetStageIds: [condenseStageId]
        }
      );
    } catch (error) {
      condenseErrorCode = safeText(error.code, 120) || "CONDENSE_FAILED";
      await logEvent("system", "capture.transcription_condense_failed", {
        level: "warn",
        captureId: work.capture.id,
        error: errorMetadata(error)
      });
    }
    return {
      ...transcription,
      polishedText,
      polishErrorCode,
      condensedText,
      condenseErrorCode,
      updatedAt: now()
    };
  });
}
const taskTargets = createAiTaskTargets({
  thoughts: createThoughtTaskTarget({ createId: () => crypto.randomUUID(), now, stripThoughtAnswerLead }),
  annotations: annotationService,
  contentAttachments: contentAttachmentService,
  hash: sha256,
  now
});
const backgroundAi = createBackgroundAi({
  repository: storeRepository,
  tasks: createTaskLifecycle({ createId: () => crypto.randomUUID(), now, hash: sha256 }),
  notifications: createNotificationService({ createId: () => crypto.randomUUID(), now }),
  targets: taskTargets,
  generate: async (work, { signal } = {}) => {
    if (work.kind === "captureTranscription") return transcribeCapture(work, { signal });
    const imagePaths = work.attachmentPaths?.length
      ? await materializeAttachmentFiles(work.attachmentPaths)
      : [];
    try {
      const result = await runDeepSeek(work.prompt, {
        scene: work.scene,
        systemPrompt: work.systemPrompt || systemPrompt(),
        captureReasoning: true,
        json: work.json === true,
        maxTokens: work.maxTokens || 16000,
        auditPrompt: work.auditPrompt !== false,
        contextReceipt: work.contextReceipt || null,
        imagePaths,
        signal
      });
      return work.scene === "contentImageUnderstanding"
        ? { ...result, model: "deepseek-flash" }
        : result;
    } finally {
      await cleanupTemporaryFiles(imagePaths);
    }
  },
  contextKey: () => requestStorage.getStore()?.dataDir || DATA_DIR,
  dispatch: callback => {
    const context = { ...(requestStorage.getStore() || {}) };
    setImmediate(() => requestStorage.run(context, callback));
  },
  onError: (taskId, error) => logEvent("system", "ai_task.failed", { level: "error", taskId, error: errorMetadata(error) })
});
cancelBackgroundTask = taskId => backgroundAi.cancel(taskId);
async function requestCaptureTranscription(capture, { force = false } = {}) {
  if (!speechProvider.configured || !capture?.audio?.attachmentPath) return null;
  if (!speechProvider.supportedAsrMimeTypes.includes(capture.audio.mimeType)) {
    if (!force) return null;
    throw Object.assign(new Error("当前 WebM 原件不能直接转写，请改用 M4A、Ogg 或 WAV"), {
      statusCode: 422,
      code: "ASR_UNSUPPORTED_AUDIO_FORMAT"
    });
  }
  const audio = {
    attachmentPath: safeText(capture.audio.attachmentPath, 300),
    mimeType: safeText(capture.audio.mimeType, 100),
    bytes: Math.max(0, Math.round(Number(capture.audio.bytes) || 0)),
    durationMs: Math.max(0, Math.round(Number(capture.audio.durationMs) || 0))
  };
  // #region debug-point C-E:transcription-input
  fetch(appConfig.debug.serverUrl,{method:"POST",body:JSON.stringify({sessionId:"login-audio-production",runId:appConfig.debug.runId,hypothesisId:"C-E",location:"server.mjs:requestCaptureTranscription",msg:"[DEBUG] Transcription input selected",data:{targetId:safeText(capture.id,100),extension:path.extname(audio.attachmentPath),mimeType:audio.mimeType,bytes:audio.bytes,durationMs:audio.durationMs,force},ts:Date.now()})}).catch(()=>{});
  // #endregion
  const inputHash = sha256(JSON.stringify({ targetId: capture.id, audio }));
  const active = activeTaskForInput((await readStore()).aiTasks, {
    kind: "captureTranscription",
    targetId: capture.id,
    inputHash
  });
  if (active) return publicAiTask(active);
  const audioKey = sha256(JSON.stringify(capture.audio)).slice(0, 24);
  const created = await backgroundAi.enqueue({
    kind: "captureTranscription",
    resourceType: "capture",
    targetId: capture.id,
    clientRequestId: force
      ? `capture-transcription:${capture.id}:${audioKey}:${crypto.randomUUID()}`
      : `capture-transcription:${capture.id}:${audioKey}`
  });
  if (!created.task) {
    if (created.alreadyAnswered) return null;
    throw Object.assign(new Error("语音转写任务无法创建"), {
      statusCode: created.missing ? 404 : created.versionConflict ? 409 : 400,
      code: created.versionConflict ? "VERSION_CONFLICT" : "TRANSCRIPTION_TASK_REJECTED"
    });
  }
  return publicAiTask(created.task);
}
const thoughtWorkflows = createThoughtWorkflows({
  repository: storeRepository,
  thoughts: thoughtService,
  backgroundAi,
  removeChain: (store, id) => moveThoughtChainToTrash(store, id),
  removeBlock: (store, id) => moveThoughtBlockToTrash(store, id),
  generate: runDeepSeek,
  hash: sha256,
  publicTask: publicAiTask,
  contextKey: () => storagePaths().storeFile
});
const taskHttp = createTaskHttp({ backgroundAi, bodyJson, sendJson });
const speechCache = createSpeechCache({
  repository: storeRepository,
  attachments: imageAttachments,
  cleanup: attachmentCleanup,
  getOwnerId: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
  hash: sha256,
  now
});
const speechCacheSweep = createSpeechCacheSweep({
  listAccountIds: async () => AUTH_REQUIRED
    ? (await readAuth()).users.map(user => user.id)
    : ["local"],
  runWithAccount: (accountId, operation) => {
    const user = { id: accountId };
    return requestStorage.run({
      user,
      traceId: crypto.randomUUID(),
      dataDir: AUTH_REQUIRED ? userDataDir(user) : DATA_DIR,
      secrets: [],
      route: "background/speech-cache-sweep"
    }, operation);
  },
  repository: storeRepository,
  cleanup: attachmentCleanup,
  now,
  onAccountError: (error, { accountId }) => logEvent("system", "speech_cache.sweep_account_failed", {
    level: "error",
    accountHash: sha256(accountId),
    error: errorMetadata(error)
  })
});
async function runSpeechCacheSweep() {
  const result = await speechCacheSweep.run();
  await logEvent("system", "speech_cache.sweep_completed", {
    level: result.failed ? "error" : "info",
    ...result
  });
  return result;
}
const speechHttp = createSpeechHttp({
  speech: speechProvider,
  gate: speechGate,
  auditCall: (details, invoke, summarize) => meteredProviderCall(details, invoke, summarize),
  bodyJson,
  sendJson,
  readSettings: readLlmSettings,
  getContext: () => requestStorage.getStore(),
  cache: speechCache
});
const visionHttp = createVisionHttp({
  vision: visionProvider,
  ocrGate,
  documentGate: documentParseGate,
  auditCall: (details, invoke, summarize) => meteredProviderCall(details, invoke, summarize),
  bodyJson,
  sendJson,
  uploadBodyMaxBytes: ATTACHMENT_UPLOAD_BODY_MAX_BYTES
});
const aiSettingsHttp = createAiSettingsHttp({ settings: llmSettingsService, speech: speechProvider, generate: runDeepSeek, bodyJson, sendJson });
const aiCostHttp = createAiCostHttp({ costs: aiCosts, bodyJson, sendJson });
const aiBudgetHttp = createAiBudgetHttp({
  budget: aiBudgetService,
  bodyJson,
  getActorId: () => currentBudgetAccountId()
});
const onboardingHttp = createOnboardingHttp({
  onboarding: createOnboardingService({
    repository: { update: mutate => updateStore(store => { store.onboarding = mutate(store.onboarding); return store.onboarding; }) },
    now
  }),
  bodyJson, sendJson
});
const onboardingV2Http = createOnboardingV2Http({
  onboardingV2: createOnboardingV2Service({
    repository: storeRepository,
    now
  }),
  extractions: createUserModelExtractionService({
    repository: storeRepository,
    backgroundAi
  }),
  bodyJson
});
const userModelHttp = createUserModelHttp({
  userModel: createUserModelService({
    repository: storeRepository,
    isEvidenceCurrent: userModelEvidenceCurrent,
    createId: () => crypto.randomUUID(),
    now
  }),
  bodyJson
});
const trashHttp = createTrashHttp({ commands: trashCommands, bodyJson, sendJson, logEvent });
const { sendMoved: sendTrashResult } = trashHttp;
const keepsakeHttp = createKeepsakeHttp({
  segment: segmentKeepsakeImage,
  understand: understandKeepsakeImage,
  records: keepsakeRecords,
  remove: id => updateStore(store => moveCollectionItemToTrash(store, "keepsakes", "keepsake", id)),
  bodyJson, sendJson, requestBinding, sendTrashResult,
  present: publicKeepsake,
  getOriginal: async id => originalKeepsakeMedia(await keepsakeRecords.get(id)),
  media: keepsakeMediaWorkflows,
  mediaBodyMaxBytes: ATTACHMENT_UPLOAD_BODY_MAX_BYTES
});
const attachmentHttp = createAttachmentHttp({
  attachments: imageAttachments,
  uploadOriginals: saveOriginalImages,
  uploadKeepsake: saveKeepsakeImages,
  discardUploads: discardOriginalUploads,
  uploadAudio: saveOriginalAudio,
  discardAudio: discardOriginalAudio,
  bodyJson,
  sendJson,
  uploadBodyMaxBytes: ATTACHMENT_UPLOAD_BODY_MAX_BYTES, uploadImageMaxBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES,
  contentType: name => mime[path.extname(name).toLowerCase()] || "application/octet-stream",
  onMissing: async (req, res, url) => {
    if (!localTestHttp.canProxyAttachment(requestStorage.getStore())) return false;
    await proxyToUpstream(req, res, url);
    return true;
  },
  debugServerUrl: appConfig.debug.serverUrl,
  debugRunId: appConfig.debug.runId
});
const annotationHttp = createAnnotationHttp({
  commands: annotationCommands,
  backgroundAi,
  prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
  sendTaskCreation: taskHttp.sendCreation,
  bodyJson,
  sendJson,
  sendTrashResult
});
const thoughtHttp = createThoughtHttp({
  service: thoughtService, workflows: thoughtWorkflows,
  removeBlock: id => updateStore(store => moveThoughtBlockToTrash(store, id)),
  removeNested: input => updateStore(store => moveNestedItemToTrash(store, input)),
  backgroundAi, sendTaskCreation: taskHttp.sendCreation, eventTimeFields,
  bodyJson, sendJson, sendTrashResult, respondModel, createId: () => crypto.randomUUID(),
  prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
  automaticAnswer: aiSettingsHttp.automaticAnswer
});
const checkinHttp = createCheckinHttp({
  records: checkinRecords,
  remove: (id, expectedVersion = null) => updateStore(store => {
    const record = store.checkins.find(item => item.id === id);
    if (record && expectedVersion != null && recordVersion(record.version) !== expectedVersion) {
      return { versionConflict: true, currentVersion: recordVersion(record.version) };
    }
    return moveCollectionItemToTrash(store, "checkins", "checkin", id);
  }),
  bodyJson, sendJson, sendTrashResult
});
const healthRecordHttp = createHealthRecordHttp({
  records: dailyRecordRecords,
  remove: (id, expectedVersion = null) => updateStore(store => {
    const record = store.dailyRecords.find(item => item.id === id);
    if (record && expectedVersion != null && recordVersion(record.version) !== expectedVersion) {
      return { versionConflict: true, currentVersion: recordVersion(record.version) };
    }
    return moveCollectionItemToTrash(store, "dailyRecords", "dailyRecord", id);
  }),
  bodyJson, sendJson, sendTrashResult
});
const discoveryHttp = createDiscoveryHttp({ discovery: discoveryService, bodyJson });
async function listAttachmentInventory() {
  if (postgresRuntime?.attachments?.list) return postgresRuntime.attachments.list();
  const context = { ...storagePaths(), ownerId: safeText(requestStorage.getStore()?.user?.id, 100) || "local" };
  return (await attachmentStorage.list({ ownerId: context.ownerId, localDir: context.attachmentsDir }))
    .map(item => ({
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
const exportHttp = createExportHttp({
  createExport: createAccountExport,
  snapshot: async () => ({
    accountId: requestStorage.getStore()?.user?.id || "local",
    snapshotAt: now(),
    store: storeForUser(await readStore(), requestStorage.getStore()?.user, isOwner)
  }),
  attachmentInventory: listAttachmentInventory
});
const removeActionResource = (type, id, expectedVersion) => updateStore(store => {
  const config = {
    action: { collection: "actions", trashType: "action" },
    habit: { collection: "habits", trashType: "habit" },
    habitCheckin: { collection: "habitCheckins", trashType: "habitCheckin" }
  }[type];
  if (!config) return { error: "删除资源类型无效", code: "INVALID_RESOURCE_TYPE" };
  const record = store[config.collection].find(item => item.id === id);
  if (!record) {
    const existing = trashService.find(store.trash, config.trashType, id);
    return existing ? { value: { trashId: existing.id }, duplicate: true } : { missing: true };
  }
  const currentVersion = recordVersion(record.version);
  if (currentVersion !== expectedVersion) return { versionConflict: true, currentVersion };
  if (type === "habit") {
    for (const checkin of store.habitCheckins.filter(item => item.habitId === id)) {
      const dependent = moveCollectionItemToTrash(store, "habitCheckins", "habitCheckin", checkin.id);
      dependent.location.parentId = id;
      dependent.location.parentCollection = "habits";
    }
  }
  const entry = moveCollectionItemToTrash(store, config.collection, config.trashType, id);
  return { value: { trashId: entry.id } };
});
const actionsHttp = createActionsHttp({ actions: actionsService, remove: removeActionResource, bodyJson });
const feedbackHttp = createFeedbackHttp({ feedback: feedbackService, bodyJson });
const removeVersionedCollection = (collection, type, id, expectedVersion = null) => updateStore(store => {
  const record = store[collection]?.find(item => item.id === id);
  if (record && expectedVersion != null) {
    const currentVersion = recordVersion(record.version);
    if (Number(expectedVersion) !== currentVersion) return { versionConflict: true, currentVersion };
  }
  return moveCollectionItemToTrash(store, collection, type, id);
});
const removeJournalReflection = (journalId, reflectionId, expectedVersion = null) => updateStore(store => {
  const journal = store.journals.find(item => item.id === journalId);
  const reflection = journal?.reflections?.find(item => item.id === reflectionId);
  if (reflection && expectedVersion != null) {
    const currentVersion = recordVersion(reflection.version);
    if (Number(expectedVersion) !== currentVersion) return { versionConflict: true, currentVersion };
  }
  return moveNestedItemToTrash(store, {
    parentCollection: "journals",
    parentId: journalId,
    field: "reflections",
    type: "journalReflection",
    id: reflectionId,
    annotationTargetKeys: [`reflection:${reflectionId}`]
  });
});
const captureJournalWorkflows = createCaptureJournalWorkflows({
  repository: storeRepository,
  journals: journalRecords,
  generate: runDeepSeek,
  hash: sha256,
  contextKey: () => storagePaths().storeFile,
  today
});
const captureJournalHttp = createCaptureJournalHttp({
  captures: captureRecords,
  journals: journalRecords,
  workflows: captureJournalWorkflows,
  prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
  prepareCaptureAudio,
  requestCaptureTranscription,
  removeCapture: (id, expectedVersion = null) => removeVersionedCollection("captures", "capture", id, expectedVersion),
  removeJournal: (id, expectedVersion = null) => removeVersionedCollection("journals", "journal", id, expectedVersion),
  removeReflection: removeJournalReflection,
  sendTrashResult,
  bodyJson,
  sendJson,
  respondModel
});
const libraryWorkflows = createLibraryWorkflows({
  repository: storeRepository,
  books: bookRecords,
  quotes: quoteRecords,
  saveImages: saveImageDataUrls,
  discardAttachments: paths => imageAttachments.discard(paths),
  cleanupTemporaryFiles,
  recognizeBook: async files => {
    const ocrStageIds = visionProvider.configured
      ? files.map((_, index) => `ocr-${index + 1}`)
      : [];
    const modelStageId = "deepseek-book";
    return aiBudgetRuntime.executeTask({
      accountId: currentBudgetAccountId(),
      taskId: `book-recognition:${crypto.randomUUID()}`,
      stages: [
        ...ocrStageIds.map(id => providerBudgetStage({
          provider: "volcengine",
          service: "vision",
          scene: "visionOcr",
          action: "OCRNormal",
          unitType: "call",
          units: 1
        }, id)),
        conservativeDeepSeekStage({
          id: modelStageId,
          scene: IMAGE_PARSE_CONFIG.book.scene,
          model: visionProvider.configured ? "deepseek-v4-pro" : "deepseek-flash"
        })
      ]
    }, async budgetExecution => {
      const recognizedText = await recognizeVisualFiles(files, {
        budgetExecution,
        stageIds: ocrStageIds
      });
      return runDeepSeek(
        recognizedText
          ? `${IMAGE_PARSE_CONFIG.book.prompt}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
          : IMAGE_PARSE_CONFIG.book.prompt,
        {
          scene: IMAGE_PARSE_CONFIG.book.scene,
          ...(recognizedText ? {} : { imagePaths: files }),
          json: true,
          maxTokens: 4000,
          budgetExecution,
          budgetStageIds: [modelStageId]
        }
      );
    });
  },
  moveCollectionItemToTrash,
  moveNestedItemToTrash
});
const libraryHttp = createLibraryHttp({
  library: libraryWorkflows,
  bodyJson,
  sendJson,
  sendTrashResult
});
const reviewChatWorkflows = createReviewChatWorkflows({
  repository: storeRepository,
  chats: chatRecords,
  reviews: reviewRecords,
  generate: runDeepSeek,
  hash: sha256,
  contextKey: () => storagePaths().storeFile,
  currentTime: () => Date.now()
});
const statisticsService = createStatisticsService({
  repository: storeRepository,
  ensureAiUsage,
  readAiUsage,
  readOperationEntries: (from, to) => readOperationEntries(storagePaths().logsDir, from, to),
  aiDashboard: (usage, from, to, cnyPerUsd) => aiCosts.dashboard(usage, from, to, cnyPerUsd),
  today
});
const reviewsChatHttp = createReviewsChatHttp({
  chatRecords,
  reviewRecords,
  workflows: reviewChatWorkflows,
  statistics: statisticsService,
  remove: removeVersionedCollection,
  eventTimeFields,
  bodyJson,
  sendJson,
  sendTrashResult,
  canAccessOwner: () => isOwner(requestStorage.getStore()?.user)
});
const contentAttachmentsHttp = createContentAttachmentsHttp({
  contentAttachments: contentAttachmentService,
  bodyJson
});
const apiV1 = createApiV1Http({
  sendJson,
  getContext: () => requestStorage.getStore(),
  openApi: openApiV1
});
const startupHttp = createStartupHttp({
  readStartup: async () => {
    const store = await readStore();
    const user = requestStorage.getStore()?.user;
    return startupProjection({
      store,
      user: publicUser(user),
      version: APP_VERSION,
      releaseVersion: RELEASE_VERSION,
      capabilities: capabilitiesFor(user),
      features: appConfig.features,
      governanceUrl: isOwner(user) && PLATFORM_SERVICE_TOKEN_HASH ? "/platform/" : "",
      unread: notificationUnread(store.notifications)
    });
  },
  readRouteState: async route => ({
    ...routeStateProjection(
      publicStateFromStore(await readStore()),
      {
        ...route,
        currentDate: today(),
        cursorScope: safeText(requestStorage.getStore()?.user?.id, 100) || "local"
      }
    ),
    _routeProjection: { view: route.view, complete: false }
  })
});
const syncHttp = createSyncHttp({
  repository: storeRepository,
  publicState: publicStateFromStore
});
const personalContextHttp = createPersonalContextHttp({
  readStore,
  project: store => {
    const projection = personalContextProjection(store, { generatedAt: now() });
    return isOwner(requestStorage.getStore()?.user) ? projection : withoutOwnerMetadata(projection);
  }
});
apiV1.register("startup", startupHttp.handleV1);
apiV1.register("sync", syncHttp.handleV1);
apiV1.register("personal-context", personalContextHttp.handleV1);
apiV1.register("owner-ai-budget", aiBudgetHttp.handleV1);
apiV1.register("onboarding-v2", onboardingV2Http.handleV1);
apiV1.register("user-model", userModelHttp.handleV1);
apiV1.register("thoughts", thoughtHttp.handleV1);
apiV1.register("checkins", checkinHttp.handleV1);
apiV1.register("health", healthRecordHttp.handleV1);
apiV1.register("discovery", discoveryHttp.handleV1);
apiV1.register("exports", exportHttp.handleV1);
apiV1.register("actions", actionsHttp.handleV1);
apiV1.register("feedback", feedbackHttp.handleV1);
apiV1.register("captures-journals", captureJournalHttp.handleV1);
apiV1.register("library", libraryHttp.handleV1);
apiV1.register("reviews-chat", reviewsChatHttp.handleV1);
apiV1.register("content-attachments", contentAttachmentsHttp.handleV1);

async function maybeRunPeriodicAnalysis() {
  try {
    const result = await reviewChatWorkflows.maybeRunPeriodicAnalysis();
    if (result) await logEvent("system", "analysis.completed", { level: "info" });
  } catch (error) {
    await logEvent("system", "analysis.failed", { level: "error", error: errorMetadata(error) });
  }
}

async function runPeriodicAnalyses() {
  const users = AUTH_REQUIRED ? (await readAuth()).users : [{ id: "local" }];
  for (const user of users) {
    await requestStorage.run({ user, traceId: crypto.randomUUID(), dataDir: AUTH_REQUIRED ? userDataDir(user) : DATA_DIR, secrets: [], route: "background/analysis" }, async () => {
      await ensureAuditLogs();
      await maybeRunPeriodicAnalysis();
    });
  }
  await pruneLogs(path.join(DATA_DIR, "logs"), AI_AUDIT_RETENTION_DAYS);
}

async function readOperationEntries(logsDir, from, to) {
  let names = [];
  try {
    names = await fs.readdir(logsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const files = names.filter(name => {
    const match = /^operation-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    return match && match[1] >= from && match[1] <= to;
  });
  const entries = [];
  for (const name of files) {
    const text = await fs.readFile(path.join(logsDir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.event === "request.completed" && item.result === "success") entries.push(item);
      } catch {}
    }
  }
  return entries;
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/owner/surfaces/architecture") {
    res.setHeader("cache-control", "private, no-store");
    return sendJson(res, 200, architectureOwnerSurface());
  }
  if (
    ["GET", "POST"].includes(req.method)
    && ["/api/owner/surfaces/commercialization", "/api/owner/surfaces/commercialization/preview"].includes(url.pathname)
  ) {
    const store = await readStore();
    const input = req.method === "POST" ? await bodyJson(req) : {};
    const report = req.method === "POST"
      ? normalizeCommercialization({ ...store.commercialization, assumptions: input.assumptions })
      : store.commercialization;
    const range = {
      ...(url.searchParams.has("from") ? { from: url.searchParams.get("from") } : {}),
      ...(url.searchParams.has("to") ? { to: url.searchParams.get("to") } : {})
    };
    const statistics = await statisticsService.dashboard(range, { includeOwner: true });
    if (statistics.error) return sendJson(res, 400, { error: statistics.error, code: statistics.code });
    res.setHeader("cache-control", "private, no-store");
    return sendJson(res, 200, commercializationOwnerSurface({
      report,
      store,
      statistics: statistics.value,
      mode: input.mode || url.searchParams.get("mode") || "validation",
      currentDate: today()
    }));
  }
  if (await reviewsChatHttp.handle(req, res, url)) return;
  if (await captureJournalHttp.handle(req, res, url)) return;
  if (await libraryHttp.handle(req, res, url)) return;
  if (await speechHttp.handle(req, res, url)) return;
  if (await visionHttp.handle(req, res, url)) return;
  if (await aiCostHttp.handle(req, res, url)) return;
  if (await aiSettingsHttp.handle(req, res, url)) return;
  if (await onboardingHttp.handle(req, res, url)) return;
  if (req.method === "PATCH" && url.pathname === "/api/commercialization") {
    const input = await bodyJson(req), updatedAt = now();
    const report = await updateStore(store => {
      store.commercialization = normalizeCommercialization({ ...store.commercialization, assumptions: input.assumptions, updatedAt });
      return store.commercialization;
    });
    return sendJson(res, 200, report);
  }
  if (await taskHttp.handle(req, res, url)) return;
  if (await trashHttp.handle(req, res, url)) return;
  if (await attachmentHttp.handle(req, res, url)) return;
  if (await keepsakeHttp.handle(req, res, url)) return;
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, publicStateFromStore(await readStore()));
  }
  if (req.method === "POST" && url.pathname === "/api/images/parse") {
    const input = await bodyJson(req), kind = ["sleep", "heartRate", "weight", "exercise", "book"].includes(input.kind) ? input.kind : "";
    if (!kind) return sendJson(res, 400, { error: "截图类型无效" });
    try {
      const parsed = kind === "book"
        ? await libraryWorkflows.parseBook(input)
        : await parseImageRequest(input, kind);
      return sendJson(res, 200, { ...parsed, ...requestBinding(input) });
    }
    catch (error) {
      if (/图片|截图|支持|大小/.test(error.message)) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }
  if (await healthRecordHttp.handle(req, res, url)) return;
  if (await checkinHttp.handle(req, res, url)) return;
  if (await thoughtHttp.handle(req, res, url)) return;
  if (await annotationHttp(req, res, url)) return;
  return sendJson(res, 404, { error: "Not found" });
}

const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg",
  ".wav": "audio/wav", ".mp3": "audio/mpeg"
};
const ownerCapabilityFor = url => {
  if (url.pathname === "/api/owner/surfaces/architecture") return "architecture";
  if (["/api/owner/surfaces/commercialization", "/api/owner/surfaces/commercialization/preview"].includes(url.pathname)) return "commercialization";
  if (url.pathname === "/api/ai-cost-plan") return "ai-costs";
  if (url.pathname === "/api/v1/owner/ai-budget") return "ai-costs";
  if (url.pathname === "/api/commercialization") return "commercialization";
  if (url.pathname === "/api/settings" || url.pathname === "/api/settings/test") return "ai-configuration";
  if (url.pathname === "/api/vision/status") return "ai-configuration";
  return "";
};
await accountLifecycle.recoverAtStartup({
  localTestRuntime,
  readUsers: async () => (await readAuth()).users
});
const periodicFailure = error => logEvent("system", "scheduler.failed", { level: "error", error: errorMetadata(error) });
if (!LOCAL_TEST_MODE && PERIODIC_ANALYSIS_ENABLED) {
  setTimeout(() => void runPeriodicAnalyses().catch(periodicFailure), 5000).unref();
  setInterval(() => void runPeriodicAnalyses().catch(periodicFailure), 3600000).unref();
}
if (SPEECH_CACHE_SWEEP_ENABLED) {
  setTimeout(
    () => void runSpeechCacheSweep().catch(periodicFailure),
    SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
  ).unref();
  setInterval(
    () => void runSpeechCacheSweep().catch(periodicFailure),
    SPEECH_CACHE_SWEEP_INTERVAL_MS
  ).unref();
}
const server = http.createServer(createRequestHandler({
  requestContext: requestStorage, rootDir: DATA_DIR, basePath: APP_BASE_PATH, logEvent, sendJson,
  sendError: (res, status, value, context) => context.apiVersion === "v1"
    ? apiV1.error(res, status, value.error, value.code, value.details)
    : sendJson(res, status, value),
  isStorageError: error => Boolean(postgresRuntime && (/^[0-9A-Z]{5}$/.test(error.code || "") || error.code === "STORAGE_CONFIGURATION_INVALID")),
  async handle(req, res, url, context) {
    const sendRequestError = (status, message, code) => context.apiVersion === "v1"
      ? apiV1.error(res, status, message, code)
      : sendJson(res, status, { error: message, ...(code ? { code } : {}) });
    if (url.pathname === "/readyz" && postgresRuntime) {
      try { await postgresRuntime.ready(); }
      catch { return sendJson(res, 503, { ok: false, code: "STORAGE_UNAVAILABLE" }); }
    }
    if (url.pathname === "/healthz" || url.pathname === "/readyz") return sendJson(res, 200, { ok: true, version: APP_VERSION });
    if (APP_BASE_PATH === "/" && ["/now", "/now/"].includes(url.pathname) && ["GET", "HEAD"].includes(req.method || "GET")) {
      res.writeHead(308, { location: `/today${url.search}` });
      return res.end();
    }
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
    if (unsafe && String(req.headers["sec-fetch-site"] || "") === "cross-site") return sendRequestError(403, "跨站请求已拒绝", "CROSS_SITE_REQUEST_REJECTED");
    await localTestHttp.prepareRequestContext(context);
    if (await localTestHttp.handle(req, res, url)) return;
    if (url.pathname.startsWith("/api/admin/")) {
      const handled = await adminSnapshotApi(req, res, url);
      return handled === false ? sendJson(res, 404, { error: "Not found" }) : handled;
    }
    if (UPSTREAM_ORIGIN && !LOCAL_TEST_MODE && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/"))) return await proxyToUpstream(req, res, url);
    const authentication = localTestRuntime.enabled
      ? localTestHttp.authentication(req)
      : await requestAuthentication(req);
    const user = authentication.user;
    if (localTestRuntime.enabled && user) bindAuthenticatedUser(user);
    if (url.pathname.startsWith("/api/auth/")) {
      const handled = await authApi(req, res, url);
      return handled === false ? sendJson(res, 404, { error: "Not found" }) : handled;
    }
    if ((url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/")) && authentication.reauthRequired) {
      return sendRequestError(401, "账户权限已变更，请重新登录", "AUTH_REAUTH_REQUIRED");
    }
    if (url.pathname.startsWith("/api/") && !user) return sendRequestError(401, "请先登录", "AUTH_REQUIRED");
    if (url.pathname.startsWith("/attachments/") && !user) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
      const requiredCapability = ownerCapabilityFor(url);
      if (requiredCapability && !isOwner(user)) return sendRequestError(403, "当前账户没有 Owner 权限", "OWNER_REQUIRED");
      if (url.pathname.startsWith("/api/v1/")) {
        const handled = await apiV1.handle(req, res, url);
        return handled === false ? apiV1.error(res, 404, "Not found", "NOT_FOUND") : handled;
      }
      if (req.method === "GET" && url.pathname === "/api/meta") {
        return sendJson(res, 200, {
          version: APP_VERSION,
          releaseVersion: RELEASE_VERSION,
          user: publicUser(user),
          capabilities: capabilitiesFor(user),
          features: appConfig.features,
          governanceUrl: isOwner(user) && PLATFORM_SERVICE_TOKEN_HASH ? "/platform/" : ""
        });
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (await attachmentHttp.handle(req, res, url)) return;
      const applicationRoute = ["GET", "HEAD"].includes(req.method || "GET") && isApplicationRoutePath(url.pathname);
      if (applicationRoute && !context.basePathMatched) return sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
      const base = PUBLIC_DIR, relative = applicationRoute ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.resolve(base, relative); if (!file.startsWith(`${base}${path.sep}`) && file !== path.join(base, "index.html")) return sendJson(res, 403, { error: "Forbidden" });
      let data = await fs.readFile(file);
      if (file === path.join(PUBLIC_DIR, "index.html") && APP_BASE_PATH !== "/") {
        const baseHref = `${APP_BASE_PATH}/`
          .replaceAll("&", "&amp;")
          .replaceAll("\"", "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        data = Buffer.from(data.toString("utf8").replace('<base href="/">', `<base href="${baseHref}">`));
      }
      res.writeHead(200, { "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" }); res.end(req.method === "HEAD" ? undefined : data);
  }
}));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();
  const closed = new Promise(resolve => server.close(resolve));
  try {
    await runtimeMemorySampler.stop();
    await closed;
    await logEvent("system", "server.stopped", { level: "info", signal });
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ type: "system", event: "server.stop_failed", signal, error: errorMetadata(error) }));
    clearTimeout(forcedExit);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown(signal));
server.listen(PORT, "127.0.0.1", () => {
  void (async () => {
    await logEvent("system", "server.started", { level: "info", port: PORT });
    await runtimeMemorySampler.start();
  })().catch(error => logEvent("system", "runtime.memory_sample_failed", {
    level: "error",
    error: errorMetadata(error)
  }));
});
