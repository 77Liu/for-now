import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { loadAppConfig } from "./src/config/index.mjs";
import { createAttachmentStorage, createImageAttachments, cleanAttachmentPaths, cleanupTemporaryFiles, collectAttachmentPaths } from "./src/shared/attachments/index.mjs";
import { appendPrivateJsonLine, createObservability, errorMetadata, pruneLogs } from "./src/shared/observability/index.mjs";
import { createThoughtService, createThoughtTaskTarget, stripThoughtAnswerLead } from "./src/modules/thoughts/index.mjs";
import { defaultOnboarding, normalizeOnboarding, createOnboardingService } from "./src/modules/onboarding/index.mjs";
import { createJournalRecords } from "./src/modules/journals/index.mjs";
import { createAuthService, publicUser } from "./src/modules/auth/index.mjs";
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
import { createContentAttachmentService } from "./src/modules/content-attachments/index.mjs";
import { createThoughtDiscoveryService } from "./src/modules/discovery/index.mjs";
import { createAccountExport } from "./src/modules/exports/index.mjs";
import { createActionsService } from "./src/modules/actions/index.mjs";
import { createFeedbackService } from "./src/modules/feedback/index.mjs";
import {
  defaultLlmSettings, normalizeLlmSettings, createLlmSettingsService, normalizeAiUsage,
  createAiUsageService, createAiAudit, createAiCostService, createAiGenerator, usageEntryFromAudit,
  systemPrompt
} from "./src/modules/ai/index.mjs";
import { createDeepSeekTransport, createAliyunSegmentationTransport, createVolcengineSpeechTransport, createVolcengineVisionTransport } from "./src/infrastructure/ai-providers/index.mjs";
import { loadPromptCatalog } from "./src/infrastructure/prompt-catalog/index.mjs";
import {
  createKeepsakeImageUnderstanding,
  createKeepsakeSegmentation,
  createKeepsakeRecords,
  keepsakePayload,
  normalizeKeepsake,
  publicKeepsake,
  originalKeepsakeMedia
} from "./src/modules/keepsakes/index.mjs";
import { createRateGate } from "./src/shared/concurrency/index.mjs";
import { installPromptCatalog, promptText, renderPrompt } from "./src/shared/prompts/index.mjs";
import { localDateKey, shiftDateKey, strictDateKey, localDateTimeOn, eventTimeFields } from "./src/shared/time/index.mjs";
import { buildAdminSnapshot } from "./admin-snapshot.mjs";
import { createAnnotationCommands, createAiTaskTargets, createBackgroundAi, createTrashMutations, createTrashCommands, createAttachmentCleanup, createKeepsakeMediaWorkflows, createThoughtWorkflows, createCaptureJournalWorkflows, createLibraryWorkflows, createReviewChatWorkflows, personalContextProjection } from "./src/app/index.mjs";
import { safeText, recordVersion, safeIso, nullableNumber, numberOrFallback as commercialNumber } from "./src/shared/validation/index.mjs";
import { createAuthHttp, createJsonHttp, createTaskHttp, createAnnotationHttp, createTrashHttp, createAttachmentHttp, createAiSettingsHttp, createAiCostHttp, createKeepsakeHttp, createOnboardingHttp, createThoughtHttp, createCheckinHttp, createHealthRecordHttp, createDiscoveryHttp, createExportHttp, createActionsHttp, createFeedbackHttp, createCaptureJournalHttp, createLibraryHttp, createReviewsChatHttp, createContentAttachmentsHttp, createSpeechHttp, createVisionHttp, createSyncHttp, createPersonalContextHttp, createRequestHandler, createModelResponseHttp, createApiV1Http, openApiV1 } from "./src/http/index.mjs";
import { createHealthImageConfig, createDailyRecordRecords, normalizeHealthImage } from "./src/modules/health/index.mjs";
import { createAccountDocumentRepository, createAuthRepository, createJsonStoreRepository, createPostgresRuntime, checkPersistenceMarker, markPostgresDirectory, hasJsonData, METADATA_FIELD, removeIdempotencyResponse } from "./src/shared/persistence/index.mjs";

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
  periodicAnalysisEnabled: PERIODIC_ANALYSIS_ENABLED,
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
const localTestUpstreamSessions = new Map();
const { context: requestStorage, logEvent, auditChanges } = createObservability({ rootDir: DATA_DIR, version: APP_VERSION });
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
const STORE_VERSION = 15;
const TRASH_RETENTION_DAYS = 30;
const COMMERCIALIZATION_VERSION = 3;
const commercialStageKeys = ["internal", "mvp", "growth", "influence", "market"];
const commercialModelKeys = ["validation", "subscription", "delivery", "usagePack"];
const commercialUsageProfileKeys = ["low", "medium", "high", "full"];
const commercialStagePresets = {
  validation: [
    { participants: 5, rewardPerParticipantCny: 100, testDays: 14, tasksPerParticipant: 3, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 12, aiCallsPerParticipant: 20, imageCallsPerParticipant: 2 },
    { participants: 20, rewardPerParticipantCny: 120, testDays: 21, tasksPerParticipant: 5, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 60, aiCallsPerParticipant: 30, imageCallsPerParticipant: 3 },
    { participants: 100, rewardPerParticipantCny: 150, testDays: 30, tasksPerParticipant: 6, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 40, developmentHoursTotal: 240, aiCallsPerParticipant: 40, imageCallsPerParticipant: 4 },
    { participants: 300, rewardPerParticipantCny: 180, testDays: 30, tasksPerParticipant: 6, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 35, developmentHoursTotal: 600, aiCallsPerParticipant: 50, imageCallsPerParticipant: 5 },
    { participants: 1000, rewardPerParticipantCny: 200, testDays: 45, tasksPerParticipant: 8, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 30, developmentHoursTotal: 2000, aiCallsPerParticipant: 60, imageCallsPerParticipant: 6 }
  ],
  subscription: [
    { dailyActiveUsers: 5, monthlyActiveUsers: 20, payingUsers: 5, newPaidUsersPerMonth: 2, simulationMonths: 6, monthlyPriceCny: 39, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 100, operationsHoursPerMonth: 6, developmentHoursPerMonth: 20, acquisitionCostPerNewUserCny: 30, monthlyChurnPct: 8 },
    { dailyActiveUsers: 100, monthlyActiveUsers: 400, payingUsers: 50, newPaidUsersPerMonth: 30, simulationMonths: 12, monthlyPriceCny: 49, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 5000, operationsHoursPerMonth: 40, developmentHoursPerMonth: 120, acquisitionCostPerNewUserCny: 60, monthlyChurnPct: 7 },
    { dailyActiveUsers: 10000, monthlyActiveUsers: 40000, payingUsers: 4000, newPaidUsersPerMonth: 600, simulationMonths: 18, monthlyPriceCny: 49, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 200000, operationsHoursPerMonth: 600, developmentHoursPerMonth: 1800, acquisitionCostPerNewUserCny: 100, monthlyChurnPct: 6 },
    { dailyActiveUsers: 25000, monthlyActiveUsers: 100000, payingUsers: 10000, newPaidUsersPerMonth: 1800, simulationMonths: 24, monthlyPriceCny: 59, paymentFeePct: 0.8, refundPct: 2.5, fixedMonthlyCostCny: 650000, operationsHoursPerMonth: 1800, developmentHoursPerMonth: 4800, acquisitionCostPerNewUserCny: 140, monthlyChurnPct: 5 },
    { dailyActiveUsers: 46000, monthlyActiveUsers: 184000, payingUsers: 18400, newPaidUsersPerMonth: 3000, simulationMonths: 24, monthlyPriceCny: 59, paymentFeePct: 0.8, refundPct: 2.5, fixedMonthlyCostCny: 1200000, operationsHoursPerMonth: 3200, developmentHoursPerMonth: 8000, acquisitionCostPerNewUserCny: 180, monthlyChurnPct: 5 }
  ],
  delivery: [
    { ordersPerMonth: 4, serviceFeePerOrderCny: 299, byokPct: 60, hostedPrepaidPerOrderCny: 100, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 2, supportHoursPerOrder: 0.5, developmentHoursPerMonth: 8, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 20 },
    { ordersPerMonth: 30, serviceFeePerOrderCny: 399, byokPct: 65, hostedPrepaidPerOrderCny: 120, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 1.5, supportHoursPerOrder: 0.4, developmentHoursPerMonth: 80, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 60 },
    { ordersPerMonth: 800, serviceFeePerOrderCny: 499, byokPct: 70, hostedPrepaidPerOrderCny: 150, maintenanceMarkupPct: 18, prepaidUtilizationPct: 75, deliveryHoursPerOrder: 0.35, supportHoursPerOrder: 0.15, developmentHoursPerMonth: 900, paymentFeePct: 0.8, refundPct: 2.5, acquisitionCostPerOrderCny: 100 },
    { ordersPerMonth: 5000, serviceFeePerOrderCny: 599, byokPct: 75, hostedPrepaidPerOrderCny: 180, maintenanceMarkupPct: 15, prepaidUtilizationPct: 80, deliveryHoursPerOrder: 0.18, supportHoursPerOrder: 0.08, developmentHoursPerMonth: 3000, paymentFeePct: 0.8, refundPct: 2, acquisitionCostPerOrderCny: 140 },
    { ordersPerMonth: 15000, serviceFeePerOrderCny: 699, byokPct: 80, hostedPrepaidPerOrderCny: 200, maintenanceMarkupPct: 12, prepaidUtilizationPct: 85, deliveryHoursPerOrder: 0.12, supportHoursPerOrder: 0.05, developmentHoursPerMonth: 6000, paymentFeePct: 0.6, refundPct: 2, acquisitionCostPerOrderCny: 180 }
  ],
  usagePack: [
    { buyersPerMonth: 10, packsPerBuyer: 1, pricePerPackCny: 29, includedAiCallsPerPack: 80, includedImageCallsPerPack: 10, utilizationPct: 70, supportHoursPerMonth: 2, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 10 },
    { buyersPerMonth: 80, packsPerBuyer: 1, pricePerPackCny: 35, includedAiCallsPerPack: 100, includedImageCallsPerPack: 12, utilizationPct: 72, supportHoursPerMonth: 16, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 35 },
    { buyersPerMonth: 4000, packsPerBuyer: 1.2, pricePerPackCny: 39, includedAiCallsPerPack: 120, includedImageCallsPerPack: 15, utilizationPct: 75, supportHoursPerMonth: 320, paymentFeePct: 0.8, refundPct: 2.5, acquisitionCostPerBuyerCny: 70 },
    { buyersPerMonth: 15000, packsPerBuyer: 1.25, pricePerPackCny: 45, includedAiCallsPerPack: 140, includedImageCallsPerPack: 18, utilizationPct: 78, supportHoursPerMonth: 900, paymentFeePct: 0.8, refundPct: 2, acquisitionCostPerBuyerCny: 100 },
    { buyersPerMonth: 36800, packsPerBuyer: 1.3, pricePerPackCny: 49, includedAiCallsPerPack: 160, includedImageCallsPerPack: 20, utilizationPct: 80, supportHoursPerMonth: 1800, paymentFeePct: 0.6, refundPct: 2, acquisitionCostPerBuyerCny: 130 }
  ]
};
const defaultCommercialization = {
  version: COMMERCIALIZATION_VERSION,
  updatedAt: "",
  assumptions: {
    stageByModel: { validation: 0, subscription: 0, delivery: 0, usagePack: 0 },
    stagePresets: commercialStagePresets,
    validation: commercialStagePresets.validation[0],
    subscription: commercialStagePresets.subscription[0],
    delivery: commercialStagePresets.delivery[0],
    usagePack: commercialStagePresets.usagePack[0],
    usageProfiles: {
      low: { sharePct: 40, activeDaysPerMonth: 4, requestsPerActiveDay: 2, foregroundAiCallsPerActiveDay: 0.5, backgroundAiCallsPerActiveDay: 0.25, imageCallsPerMonth: 1 },
      medium: { sharePct: 35, activeDaysPerMonth: 10, requestsPerActiveDay: 3, foregroundAiCallsPerActiveDay: 1.5, backgroundAiCallsPerActiveDay: 0.6, imageCallsPerMonth: 3 },
      high: { sharePct: 20, activeDaysPerMonth: 20, requestsPerActiveDay: 6, foregroundAiCallsPerActiveDay: 6.5, backgroundAiCallsPerActiveDay: 2, imageCallsPerMonth: 8 },
      full: { sharePct: 5, activeDaysPerMonth: 30, requestsPerActiveDay: 10, foregroundAiCallsPerActiveDay: 10, backgroundAiCallsPerActiveDay: 5, imageCallsPerMonth: 20 }
    },
    common: {
      usdCny: 7.2,
      aiCostFloorPerCallCny: 0.03,
      segmentationCostPerImageCny: 0.01,
      laborHourlyCny: 80
    }
  }
};
const emptyStore = { version: STORE_VERSION, checkins: [], dailyRecords: [], captures: [], journals: [], journalDraft: null, thoughts: [], chats: [], books: [], keepsakes: [], quotes: [], experiments: [], analyses: [], customMetrics: [], trash: [], attachmentCleanup: [], aiTasks: [], notifications: [], actions: [], habits: [], habitCheckins: [], feedback: [], validationLedger: [], onboarding: defaultOnboarding, commercialization: defaultCommercialization };
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
const requestCookie = (req, name) => String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
const localTestUpstreamSession = req => {
  let token = "";
  try { token = decodeURIComponent(requestCookie(req, LOCAL_TEST_SESSION_COOKIE)); } catch { return null; }
  const session = localTestUpstreamSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    localTestUpstreamSessions.delete(token);
    return null;
  }
  return { token, ...session };
};
const upstreamCookieHeader = req => LOCAL_TEST_MODE ? localTestUpstreamSession(req)?.cookie || "" : String(req.headers.cookie || "");
const storeLocalTestUpstreamSession = (token, cookie, user = null) => {
  const currentTime = Date.now();
  for (const [key, session] of localTestUpstreamSessions) {
    if (session.expiresAt <= currentTime) localTestUpstreamSessions.delete(key);
  }
  while (localTestUpstreamSessions.size >= 128) localTestUpstreamSessions.delete(localTestUpstreamSessions.keys().next().value);
  localTestUpstreamSessions.set(token, {
    cookie,
    user: user && typeof user === "object" ? {
      id: safeText(user.id, 100),
      username: safeText(user.username, 100)
    } : null,
    expiresAt: currentTime + LOCAL_TEST_SESSION_MAX_AGE_SECONDS * 1000
  });
};
const now = () => new Date().toISOString();
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
const authorTypeFor = item => {
  if (["question", "idea", "record"].includes(item?.type)) return "user";
  if (item?.type === "answer" && !/^(?:deepseek|codex)/.test(String(item?.origin || "")) && !item?.modelDraft && !item?.reasoningContent) return "user";
  return item?.type === "answer" ? "ai" : "user";
};
const today = () => localDateKey();
const requestBinding = input => {
  const requestId = safeText(input?.requestId, 100), targetId = safeText(input?.targetId, 100);
  return requestId && targetId ? { requestId, targetId, inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0)) } : {};
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clamp5 = value => Math.min(5, Math.max(1, Number(value) || 3));
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = value => value == null ? null : Math.round(value * 100) / 100;
const WEIGHT_CLOTHING_MODEL = {
  none: { label: "不穿衣", mean: 0, lower: 0, upper: 0 },
  light: { label: "轻便衣物", mean: 0.5, lower: 0.1, upper: 0.9 },
  heavy: { label: "厚重衣物", mean: 1.5, lower: 0.5, upper: 2.5 }
};
const aiGate = createRateGate(AI_GLOBAL_QPS, AI_GLOBAL_CONCURRENCY);
const segmentationGate = createRateGate(SEGMENTATION_GLOBAL_QPS, SEGMENTATION_GLOBAL_CONCURRENCY);
const speechGate = createRateGate(SPEECH_GLOBAL_QPS, SPEECH_GLOBAL_CONCURRENCY);
const ocrGate = createRateGate(OCR_GLOBAL_QPS, OCR_GLOBAL_CONCURRENCY);
const documentParseGate = createRateGate(DOCUMENT_PARSE_GLOBAL_QPS, DOCUMENT_PARSE_GLOBAL_CONCURRENCY);
const speechProvider = createVolcengineSpeechTransport(appConfig.speech);
const visionProvider = createVolcengineVisionTransport(appConfig.vision);

function normalizedOccurredOn(item, previousVersion) {
  const createdUtcDate = item.createdAt?.slice(0, 10);
  const createdLocalDate = localDateKey(item.createdAt);
  const current = item.occurredOn || createdLocalDate || today();
  if (previousVersion < 4 && current === createdUtcDate && createdLocalDate && createdLocalDate !== createdUtcDate) return createdLocalDate;
  return current;
}

function normalizedEventTime(item, previousVersion) {
  const legacyDate = normalizedOccurredOn(item, previousVersion);
  const parsed = new Date(item.occurredAt || "");
  const occurredAt = Number.isNaN(parsed.getTime()) ? localDateTimeOn(legacyDate, item.createdAt || new Date()) : parsed.toISOString();
  return { occurredAt: occurredAt || now(), occurredOn: localDateKey(occurredAt) || legacyDate };
}

function normalizeCommercialValidation(input = {}, fallback = commercialStagePresets.validation[0], previousVersion = COMMERCIALIZATION_VERSION) {
  return {
    participants: commercialNumber(input.participants, fallback.participants, 1, 1_000_000, true),
    rewardPerParticipantCny: commercialNumber(input.rewardPerParticipantCny ?? (previousVersion < 2 ? input.feePerParticipantCny : null), fallback.rewardPerParticipantCny, 0, 1_000_000),
    testDays: commercialNumber(input.testDays, fallback.testDays, 1, 3650, true),
    tasksPerParticipant: commercialNumber(input.tasksPerParticipant, fallback.tasksPerParticipant, 1, 10_000, true),
    validSuggestionsPerParticipant: commercialNumber(input.validSuggestionsPerParticipant, fallback.validSuggestionsPerParticipant, 1, 10_000, true),
    interviewMinutesPerParticipant: commercialNumber(input.interviewMinutesPerParticipant, fallback.interviewMinutesPerParticipant, 0, 10_000, true),
    developmentHoursTotal: commercialNumber(input.developmentHoursTotal, fallback.developmentHoursTotal, 0, 1_000_000),
    aiCallsPerParticipant: commercialNumber(input.aiCallsPerParticipant, fallback.aiCallsPerParticipant, 0, 100_000, true),
    imageCallsPerParticipant: commercialNumber(input.imageCallsPerParticipant, fallback.imageCallsPerParticipant, 0, 100_000, true)
  };
}

function normalizeCommercialSubscription(input = {}, fallback = commercialStagePresets.subscription[0]) {
  const payingUsers = commercialNumber(input.payingUsers, fallback.payingUsers, 0, 100_000_000, true);
  return {
    dailyActiveUsers: commercialNumber(input.dailyActiveUsers, fallback.dailyActiveUsers, 0, 100_000_000, true),
    monthlyActiveUsers: commercialNumber(input.monthlyActiveUsers, Math.max(fallback.monthlyActiveUsers, payingUsers), 0, 100_000_000, true),
    payingUsers,
    newPaidUsersPerMonth: commercialNumber(input.newPaidUsersPerMonth, fallback.newPaidUsersPerMonth, 0, 100_000_000, true),
    simulationMonths: commercialNumber(input.simulationMonths, fallback.simulationMonths, 1, 120, true),
    monthlyPriceCny: commercialNumber(input.monthlyPriceCny, fallback.monthlyPriceCny, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    fixedMonthlyCostCny: commercialNumber(input.fixedMonthlyCostCny, fallback.fixedMonthlyCostCny, 0, 1_000_000_000),
    operationsHoursPerMonth: commercialNumber(input.operationsHoursPerMonth, fallback.operationsHoursPerMonth, 0, 1_000_000),
    developmentHoursPerMonth: commercialNumber(input.developmentHoursPerMonth, fallback.developmentHoursPerMonth, 0, 1_000_000),
    acquisitionCostPerNewUserCny: commercialNumber(input.acquisitionCostPerNewUserCny, fallback.acquisitionCostPerNewUserCny, 0, 10_000_000),
    monthlyChurnPct: commercialNumber(input.monthlyChurnPct, fallback.monthlyChurnPct, 0, 100)
  };
}

function normalizeCommercialDelivery(input = {}, fallback = commercialStagePresets.delivery[0], previousVersion = COMMERCIALIZATION_VERSION) {
  return {
    ordersPerMonth: commercialNumber(input.ordersPerMonth, fallback.ordersPerMonth, 0, 100_000_000, true),
    serviceFeePerOrderCny: commercialNumber(input.serviceFeePerOrderCny ?? (previousVersion < 3 ? input.pricePerOrderCny : null), fallback.serviceFeePerOrderCny, 0, 10_000_000),
    byokPct: commercialNumber(input.byokPct, fallback.byokPct, 0, 100),
    hostedPrepaidPerOrderCny: commercialNumber(input.hostedPrepaidPerOrderCny, fallback.hostedPrepaidPerOrderCny, 0, 10_000_000),
    maintenanceMarkupPct: commercialNumber(input.maintenanceMarkupPct, fallback.maintenanceMarkupPct, 0, 1000),
    prepaidUtilizationPct: commercialNumber(input.prepaidUtilizationPct, fallback.prepaidUtilizationPct, 0, 100),
    deliveryHoursPerOrder: commercialNumber(input.deliveryHoursPerOrder, fallback.deliveryHoursPerOrder, 0, 100_000),
    supportHoursPerOrder: commercialNumber(input.supportHoursPerOrder, fallback.supportHoursPerOrder, 0, 100_000),
    developmentHoursPerMonth: commercialNumber(input.developmentHoursPerMonth, fallback.developmentHoursPerMonth, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    acquisitionCostPerOrderCny: commercialNumber(input.acquisitionCostPerOrderCny, fallback.acquisitionCostPerOrderCny, 0, 10_000_000)
  };
}

function normalizeCommercialUsagePack(input = {}, fallback = commercialStagePresets.usagePack[0]) {
  return {
    buyersPerMonth: commercialNumber(input.buyersPerMonth, fallback.buyersPerMonth, 0, 100_000_000, true),
    packsPerBuyer: commercialNumber(input.packsPerBuyer, fallback.packsPerBuyer, 0, 100_000),
    pricePerPackCny: commercialNumber(input.pricePerPackCny, fallback.pricePerPackCny, 0, 10_000_000),
    includedAiCallsPerPack: commercialNumber(input.includedAiCallsPerPack, fallback.includedAiCallsPerPack, 0, 100_000, true),
    includedImageCallsPerPack: commercialNumber(input.includedImageCallsPerPack, fallback.includedImageCallsPerPack, 0, 100_000, true),
    utilizationPct: commercialNumber(input.utilizationPct, fallback.utilizationPct, 0, 100),
    supportHoursPerMonth: commercialNumber(input.supportHoursPerMonth, fallback.supportHoursPerMonth, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    acquisitionCostPerBuyerCny: commercialNumber(input.acquisitionCostPerBuyerCny, fallback.acquisitionCostPerBuyerCny, 0, 10_000_000)
  };
}

function normalizeCommercialization(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const assumptions = source.assumptions && typeof source.assumptions === "object" ? source.assumptions : {};
  const previousVersion = Number(source.version || 1);
  const legacySubscription = assumptions.subscription || {};
  const legacyDelivery = assumptions.delivery || {};
  const hasLegacySubscriptionUsage = previousVersion < 3
    && ["activeDaysPerMonth", "aiCallsPerActiveDay", "imageCallsPerUserMonth"].some(key => hasOwn(legacySubscription, key));
  const hasLegacyDeliveryUsage = previousVersion < 3
    && ["aiCallsPerOrder", "imageCallsPerOrder"].some(key => hasOwn(legacyDelivery, key));
  const normalizers = {
    validation: (input, fallback) => normalizeCommercialValidation(input, fallback, previousVersion),
    subscription: normalizeCommercialSubscription,
    delivery: (input, fallback) => normalizeCommercialDelivery(input, fallback, previousVersion),
    usagePack: normalizeCommercialUsagePack
  };
  const stageByModel = Object.fromEntries(commercialModelKeys.map(model => [
    model,
    commercialNumber(assumptions.stageByModel?.[model], 0, 0, commercialStageKeys.length - 1, true)
  ]));
  const stagePresets = Object.fromEntries(commercialModelKeys.map(model => [
    model,
    commercialStagePresets[model].map((fallback, index) => {
      const stored = assumptions.stagePresets?.[model]?.[index];
      const selectedAlias = index === stageByModel[model] ? assumptions[model] : null;
      return normalizers[model](selectedAlias || stored || {}, fallback);
    })
  ]));
  const usageProfiles = Object.fromEntries(commercialUsageProfileKeys.map(key => {
    const fallback = defaultCommercialization.assumptions.usageProfiles[key];
    const input = assumptions.usageProfiles?.[key] || (hasLegacySubscriptionUsage ? {
      ...fallback,
      activeDaysPerMonth: legacySubscription.activeDaysPerMonth,
      foregroundAiCallsPerActiveDay: legacySubscription.aiCallsPerActiveDay,
      backgroundAiCallsPerActiveDay: 0,
      imageCallsPerMonth: legacySubscription.imageCallsPerUserMonth
    } : {});
    return [key, {
      sharePct: commercialNumber(input.sharePct, fallback.sharePct, 0, 100),
      activeDaysPerMonth: commercialNumber(input.activeDaysPerMonth, fallback.activeDaysPerMonth, 0, 31, true),
      requestsPerActiveDay: commercialNumber(input.requestsPerActiveDay, fallback.requestsPerActiveDay, 0, 100_000),
      foregroundAiCallsPerActiveDay: commercialNumber(input.foregroundAiCallsPerActiveDay, fallback.foregroundAiCallsPerActiveDay, 0, 100_000),
      backgroundAiCallsPerActiveDay: commercialNumber(input.backgroundAiCallsPerActiveDay, fallback.backgroundAiCallsPerActiveDay, 0, 100_000),
      imageCallsPerMonth: commercialNumber(input.imageCallsPerMonth, fallback.imageCallsPerMonth, 0, 100_000)
    }];
  }));
  const common = assumptions.common || {};
  const legacyV2 = source.legacyV2 && typeof source.legacyV2 === "object"
    ? clone(source.legacyV2)
    : (hasLegacySubscriptionUsage || hasLegacyDeliveryUsage ? {
      migratedFromVersion: previousVersion,
      subscription: hasLegacySubscriptionUsage ? {
        activeDaysPerMonth: commercialNumber(legacySubscription.activeDaysPerMonth, 0, 0, 31, true),
        aiCallsPerActiveDay: commercialNumber(legacySubscription.aiCallsPerActiveDay, 0, 0, 100_000),
        imageCallsPerUserMonth: commercialNumber(legacySubscription.imageCallsPerUserMonth, 0, 0, 100_000)
      } : null,
      delivery: hasLegacyDeliveryUsage ? {
        aiCallsPerOrder: commercialNumber(legacyDelivery.aiCallsPerOrder, 0, 0, 100_000),
        imageCallsPerOrder: commercialNumber(legacyDelivery.imageCallsPerOrder, 0, 0, 100_000)
      } : null
    } : null);
  return {
    version: COMMERCIALIZATION_VERSION,
    updatedAt: safeIso(source.updatedAt),
    assumptions: {
      stageByModel,
      stagePresets,
      ...Object.fromEntries(commercialModelKeys.map(model => [model, stagePresets[model][stageByModel[model]]])),
      usageProfiles,
      common: {
        usdCny: commercialNumber(common.usdCny, defaultCommercialization.assumptions.common.usdCny, 0.01, 1000),
        aiCostFloorPerCallCny: commercialNumber(common.aiCostFloorPerCallCny, defaultCommercialization.assumptions.common.aiCostFloorPerCallCny, 0, 100_000),
        segmentationCostPerImageCny: commercialNumber(common.segmentationCostPerImageCny, defaultCommercialization.assumptions.common.segmentationCostPerImageCny, 0, 100_000),
        laborHourlyCny: commercialNumber(common.laborHourlyCny, defaultCommercialization.assumptions.common.laborHourlyCny, 0, 1_000_000)
      }
    },
    ...(legacyV2 ? { legacyV2 } : {})
  };
}

function normalizeStore(value = {}) {
  const previousVersion = Number(value.version || 1), store = { ...clone(emptyStore), ...value, version: STORE_VERSION };
  for (const key of ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "trash", "attachmentCleanup", "aiTasks", "notifications", "actions", "habits", "habitCheckins", "feedback", "validationLedger"]) if (!Array.isArray(store[key])) store[key] = [];
  store.checkins = store.checkins.map(item => ({ factors: [], custom: {}, notes: {}, ...item, ...normalizedEventTime(item, previousVersion), sleep: item.sleep || 3, stress: previousVersion < 3 ? 6 - clamp5(item.stress) : clamp5(item.stress), version: recordVersion(item.version) }));
  store.dailyRecords = store.dailyRecords.map(item => {
    const normalized = { source: "manual", attachmentPaths: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) };
    if (normalized.type === "weight") {
      const model = WEIGHT_CLOTHING_MODEL[normalized.clothing] || WEIGHT_CLOTHING_MODEL.none;
      const measuredWeight = nullableNumber(normalized.measuredWeight, 20, 400);
      return { ...normalized, clothing: WEIGHT_CLOTHING_MODEL[normalized.clothing] ? normalized.clothing : "none", measuredWeight, adjustmentMean: model.mean, adjustedWeight: measuredWeight == null ? null : round(measuredWeight - model.mean), lower95: measuredWeight == null ? null : round(measuredWeight - model.upper), upper95: measuredWeight == null ? null : round(measuredWeight - model.lower) };
    }
    return normalized;
  }).map(item => ["sleep", "heartRate", "weight", "exercise"].includes(item.type) ? item : { ...item, validationState: "invalid" });
  store.captures = store.captures.map(item => ({ tags: [], attachmentPaths: [], imageUnderstandings: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
  store.journals = store.journals.map(item => ({ tags: [], reflections: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
  if (store.journalDraft && typeof store.journalDraft === "object") {
    const journalId = safeText(store.journalDraft.journalId, 100);
    store.journalDraft = {
      journalId: store.journals.some(item => item.id === journalId) ? journalId : "",
      title: safeText(store.journalDraft.title, 120),
      content: safeText(store.journalDraft.content, 50000),
      updatedAt: safeIso(store.journalDraft.updatedAt) || now()
    };
  } else store.journalDraft = null;
  delete store.bookDraft;
  store.thoughts = store.thoughts.map(item => {
    const normalized = { disposition: "pending", remarks: [], tags: [], attachmentPaths: [], imageUnderstandings: [], followUps: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), type: ["question", "idea", "answer", "record"].includes(item.type) ? item.type : "question", authorType: ["user", "ai", "system"].includes(item.authorType) ? item.authorType : authorTypeFor(item), version: recordVersion(item.version) };
    if (normalized.discovery && typeof normalized.discovery === "object" && !Array.isArray(normalized.discovery)) {
      normalized.discovery = { ...normalized.discovery, version: recordVersion(normalized.discovery.version) };
    }
    normalized.remarks = normalized.remarks.map(remark => ({ ...remark, version: recordVersion(remark.version) }));
    normalized.followUps = normalized.followUps.map(followUp => ({ ...followUp, version: recordVersion(followUp.version) }));
    return normalized;
  });
  store.chats = store.chats.map(item => ({ annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
  store.books = store.books.map(item => {
    const readingStartedOn = strictDateKey(item.readingStartedOn) || "";
    const normalizedFinishedOn = strictDateKey(item.readingFinishedOn) || "";
    const book = {
      notes: [],
      annotations: [],
      annotationDrift: [],
      ...item,
      readingStartedOn,
      readingFinishedOn: readingStartedOn && normalizedFinishedOn >= readingStartedOn ? normalizedFinishedOn : "",
      version: recordVersion(item.version)
    };
    book.notes = book.notes.map(note => ({
      ...note,
      type: note.type === "thought" ? "thought" : "record",
      favorite: ["none", "star", "sprout"].includes(note.favorite) ? note.favorite : "none",
      ...normalizedEventTime({ createdAt: note.createdAt || book.createdAt, ...note }, previousVersion)
    }));
    return book;
  });
  store.keepsakes = store.keepsakes.map(item => normalizeKeepsake(item, normalizedEventTime(item, previousVersion)));
  store.quotes = store.quotes.map(item => ({ tags: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
  store.analyses = store.analyses.map(item => ({ annotations: [], annotationDrift: [], ...item, version: recordVersion(item.version) }));
  for (const collection of ["captures", "journals", "thoughts", "chats", "books", "quotes", "analyses"]) {
    for (const item of store[collection]) {
      item.annotations = (item.annotations || []).map(annotation => ({
        attachmentPaths: [],
        imageUnderstandings: [],
        ...annotation,
        version: recordVersion(annotation.version)
      }));
      item.annotationDrift = (item.annotationDrift || []).map(annotation => ({
        attachmentPaths: [],
        imageUnderstandings: [],
        ...annotation,
        version: recordVersion(annotation.version)
      }));
    }
  }
  store.experiments = store.experiments.map(item => ({ ...item, version: recordVersion(item.version) }));
  store.actions = store.actions.filter(item => item && item.id).map(item => ({
    statusHistory: [],
    ...item,
    version: recordVersion(item.version),
    statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
  }));
  store.habits = store.habits.filter(item => item && item.id).map(item => ({
    statusHistory: [],
    adjustmentHistory: [],
    ...item,
    version: recordVersion(item.version),
    statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : [],
    adjustmentHistory: Array.isArray(item.adjustmentHistory) ? item.adjustmentHistory : []
  }));
  store.habitCheckins = store.habitCheckins.filter(item => item && item.id).map(item => ({
    ...item,
    version: recordVersion(item.version)
  }));
  store.feedback = store.feedback.filter(item => item && item.id).map(item => ({
    statusHistory: [],
    ...item,
    version: recordVersion(item.version),
    statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
  }));
  store.validationLedger = store.validationLedger.filter(item => item && item.id).map(item => ({
    compensationRecords: [],
    rewardRecords: [],
    participationRecords: [],
    statusHistory: [],
    ...item,
    version: recordVersion(item.version),
    compensationRecords: Array.isArray(item.compensationRecords) ? item.compensationRecords : [],
    rewardRecords: Array.isArray(item.rewardRecords) ? item.rewardRecords : [],
    participationRecords: Array.isArray(item.participationRecords) ? item.participationRecords : [],
    statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
  }));
  store.trash = store.trash.filter(item => item && item.id && item.payload && item.type).map(item => ({
    ...item,
    deletedAt: safeIso(item.deletedAt) || now(),
    purgeAfter: safeIso(item.purgeAfter) || new Date(Date.now() + TRASH_RETENTION_DAYS * 86400000).toISOString()
  }));
  store.attachmentCleanup = store.attachmentCleanup.filter(item => item && /^\/attachments\/[\w.-]+$/.test(item.path)).map(item => ({
    path: item.path,
    createdAt: safeIso(item.createdAt) || now(),
    lastAttemptAt: safeIso(item.lastAttemptAt),
    attempts: Math.max(0, Math.round(Number(item.attempts) || 0)),
    errorCode: safeText(item.errorCode, 100)
  }));
  store.aiTasks = store.aiTasks.filter(item => item && item.id && item.kind);
  store.notifications = store.notifications.filter(item => item && item.id);
  store.onboarding = normalizeOnboarding(store.onboarding);
  if (previousVersion < 14 && !Object.keys(store.onboarding.answers).length) {
    const hasRecords = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes"].some(key => store[key].length);
    if (hasRecords) store.onboarding.status = "completed";
    else if (store.onboarding.status === "dismissed") store.onboarding.status = "pending";
  }
  store.commercialization = normalizeCommercialization(store.commercialization);
  return store;
}

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

const localTestModes = new Set(["simulation", "cold"]);
const LOCAL_TEST_UPSTREAM_TIMEOUT_MS = 15_000;
const localTestAllCollections = ["checkins", "dailyRecords", "captures", "journals", "journalDraft", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger", "commercialization"];
const localTestScopeCollections = Object.freeze({
  today: ["checkins", "dailyRecords", "captures", "thoughts", "books", "quotes", "keepsakes", "actions", "habits", "habitCheckins"],
  daily: ["dailyRecords"],
  captures: ["captures"],
  books: ["books"],
  quotes: ["quotes"],
  keepsakes: ["keepsakes"],
  journals: ["journals", "journalDraft"],
  thoughts: ["thoughts"],
  discovery: ["captures", "journals", "thoughts", "books", "quotes"],
  together: ["chats"],
  review: ["checkins", "dailyRecords", "journals", "thoughts", "chats", "experiments", "analyses", "customMetrics"],
  statistics: localTestAllCollections,
  "personal-context": ["checkins", "dailyRecords", "captures", "journals", "thoughts", "books", "quotes"],
  feedback: ["feedback"],
  export: localTestAllCollections,
  trash: ["trash"]
});
const localTestScopes = new Set(Object.keys(localTestScopeCollections));
const localTestCollections = new Set([...localTestAllCollections, "trash"]);
const localTestCollectionEndpoints = Object.freeze({
  checkins: "/api/v1/checkins",
  dailyRecords: "/api/v1/daily-records",
  captures: "/api/v1/captures",
  journals: "/api/v1/journals",
  thoughts: "/api/v1/thought-chains",
  chats: "/api/v1/chats",
  books: "/api/v1/books",
  quotes: "/api/v1/quotes",
  experiments: "/api/v1/experiments",
  analyses: "/api/v1/analyses",
  customMetrics: "/api/v1/custom-metrics",
  actions: "/api/v1/actions",
  habits: "/api/v1/habits",
  feedback: "/api/v1/feedback",
  validationLedger: "/api/v1/validation-ledger"
});
let localTestControlQueue = Promise.resolve();

function localTestWorkspaceDir(mode) {
  return path.join(LOCAL_TEST_WORKSPACES_DIR, mode === "simulation" ? "simulation" : "cold");
}

function normalizeLocalTestControl(value = {}) {
  return {
    mode: localTestModes.has(value.mode) ? value.mode : "cold",
    switchedAt: safeIso(value.switchedAt),
    snapshotAt: safeIso(value.snapshotAt),
    sourceUser: value.sourceUser && typeof value.sourceUser === "object" ? {
      id: safeText(value.sourceUser.id, 100),
      username: safeText(value.sourceUser.username, 100)
    } : null,
    recordCount: Math.max(0, Math.round(Number(value.recordCount) || 0)),
    loadedScopes: [...new Set(Array.isArray(value.loadedScopes) ? value.loadedScopes : [])].filter(scope => localTestScopes.has(scope)),
    loadedCollections: [...new Set(Array.isArray(value.loadedCollections) ? value.loadedCollections : [])].filter(collection => localTestCollections.has(collection))
  };
}

async function readLocalTestControl() {
  return normalizeLocalTestControl(await readStoredJson(LOCAL_TEST_CONTROL_FILE, { mode: "cold" }));
}

async function writeLocalTestControl(value) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(DATA_DIR, 0o700);
  await writeJsonAtomic(LOCAL_TEST_CONTROL_FILE, normalizeLocalTestControl(value));
}

async function upstreamJson(req, pathname) {
  if (!UPSTREAM_ORIGIN) throw Object.assign(new Error("尚未配置线上只读数据源"), { statusCode: 503, code: "LOCAL_TEST_UPSTREAM_MISSING" });
  const headers = { accept: "application/json", "x-request-id": requestStorage.getStore()?.traceId || crypto.randomUUID() };
  if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
  const cookie = upstreamCookieHeader(req);
  if (cookie) headers.cookie = cookie;
  let response;
  try {
    response = await fetch(`${UPSTREAM_ORIGIN}${pathname}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(LOCAL_TEST_UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (["AbortError", "TimeoutError"].includes(error?.name)) {
      throw Object.assign(new Error("线上数据读取超过 15 秒，请检查网络后重试"), {
        statusCode: 504,
        code: "LOCAL_TEST_UPSTREAM_TIMEOUT"
      });
    }
    throw error;
  }
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? "请先登录线上主账户" : safeText(value.error, 300) || "线上数据读取失败"), { statusCode: response.status, code: response.status === 401 ? "AUTH_REQUIRED" : "LOCAL_TEST_UPSTREAM_FAILED" });
  return value;
}

async function upstreamV1List(req, pathname) {
  const items = [], seen = new Set();
  let cursor = "";
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const result = await upstreamJson(req, `${pathname}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (result?.error) throw Object.assign(new Error(result.error.message || "线上记录读取失败"), { statusCode: 502, code: result.error.code || "LOCAL_TEST_UPSTREAM_FAILED" });
    items.push(...(Array.isArray(result?.data) ? result.data : []));
    cursor = safeText(result?.meta?.nextCursor, 100);
    if (cursor && seen.has(cursor)) throw Object.assign(new Error("线上记录游标没有前进"), { statusCode: 502, code: "LOCAL_TEST_UPSTREAM_CURSOR_STALLED" });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

async function localTestScopePatch(req, collections) {
  const patch = {};
  let upstreamStatePromise = null;
  const upstreamState = () => upstreamStatePromise ||= upstreamJson(req, "/api/state");
  const loadCollection = async collection => {
    if (collection === "trash") {
      const value = await upstreamJson(req, "/api/trash");
      patch.trash = Array.isArray(value?.items) ? value.items : [];
      return;
    }
    if (collection === "journalDraft") {
      try {
        patch.journalDraft = (await upstreamJson(req, "/api/v1/journal-draft"))?.data || null;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        patch.journalDraft = clone((await upstreamState()).journalDraft || null);
      }
      return;
    }
    if (collection === "habitCheckins") return;
    const endpoint = localTestCollectionEndpoints[collection];
    if (endpoint) {
      try {
        const items = await upstreamV1List(req, endpoint);
        patch[collection] = collection === "thoughts"
          ? items.flatMap(({ blocks = [], ...root }) => [root, ...(Array.isArray(blocks) ? blocks : [])])
          : items;
        return;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
    patch[collection] = clone((await upstreamState())[collection] ?? emptyStore[collection]);
  };
  await Promise.all(collections.map(loadCollection));
  if (collections.includes("habitCheckins")) {
    const habits = patch.habits || await upstreamV1List(req, localTestCollectionEndpoints.habits);
    patch.habitCheckins = (await Promise.all(habits.map(habit => upstreamV1List(req, `/api/v1/habits/${encodeURIComponent(habit.id)}/checkins`)))).flat();
  }
  if (patch.keepsakes) {
    patch.keepsakes = (await hydrateLocalTestKeepsakeOriginals(req, { keepsakes: patch.keepsakes })).state.keepsakes;
  }
  return patch;
}

async function upstreamAttachment(req, resourcePath) {
  if (!/^\/attachments\/[\w.-]+$/.test(resourcePath || "")) {
    throw Object.assign(new Error("线上附件路径无效"), { statusCode: 502, code: "LOCAL_TEST_UPSTREAM_ATTACHMENT_INVALID" });
  }
  const headers = { accept: "image/*", "x-request-id": requestStorage.getStore()?.traceId || crypto.randomUUID() };
  if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
  const cookie = upstreamCookieHeader(req);
  if (cookie) headers.cookie = cookie;
  let response;
  try {
    response = await fetch(`${UPSTREAM_ORIGIN}${resourcePath}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(LOCAL_TEST_UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (["AbortError", "TimeoutError"].includes(error?.name)) {
      throw Object.assign(new Error("线上小物图片读取超过 15 秒，请检查网络后重试"), {
        statusCode: 504,
        code: "LOCAL_TEST_UPSTREAM_TIMEOUT"
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw Object.assign(new Error("线上小物图片读取失败"), {
      statusCode: response.status,
      code: response.status === 401 ? "AUTH_REQUIRED" : "LOCAL_TEST_UPSTREAM_ATTACHMENT_FAILED"
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

function localTestSnapshot(state, trash) {
  const snapshot = clone(emptyStore);
  for (const key of ["checkins", "dailyRecords", "captures", "journals", "journalDraft", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger", "onboarding", "commercialization"]) {
    if (hasOwn(state, key)) snapshot[key] = clone(state[key]);
  }
  snapshot.trash = clone(Array.isArray(trash?.items) ? trash.items : []);
  snapshot.aiTasks = [];
  snapshot.notifications = [];
  snapshot.attachmentCleanup = [];
  return normalizeStore(snapshot);
}

async function hydrateLocalTestKeepsakeOriginals(req, state) {
  const snapshot = clone(state);
  snapshot.keepsakes = await Promise.all((snapshot.keepsakes || []).map(async item => {
    return item.originalPath
      ? item
      : { ...item, ...(await upstreamJson(req, `/api/keepsakes/${encodeURIComponent(item.id)}/original`)) };
  }));
  return { state: snapshot, attachments: new Map() };
}

async function resetLocalTestWorkspace(mode, store, settings = null, attachmentCopies = new Map()) {
  const dataDir = localTestWorkspaceDir(mode), storeFile = path.join(dataDir, "store.json");
  await storeRepository.waitForIdle(storeFile);
  const current = await readStoredJson(storeFile, null);
  const currentSettings = await readStoredJson(path.join(dataDir, "llm-settings.json"), null);
  if (current?.aiTasks?.some(task => ["queued", "running"].includes(task.status))) {
    throw Object.assign(new Error("该测试空间仍有后台任务，请等待完成后再切换"), { statusCode: 409, code: "LOCAL_TEST_TASKS_ACTIVE" });
  }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await Promise.all(["attachments", "logs"].map(name => fs.rm(path.join(dataDir, name), { recursive: true, force: true })));
  await Promise.all(["ai-usage.json", "ai-cost-plan.json"].map(name => fs.rm(path.join(dataDir, name), { force: true })));
  if (mode === "cold") await fs.rm(path.join(dataDir, "llm-settings.json"), { force: true });
  await requestStorage.run({ ...(requestStorage.getStore() || {}), user: { id: `local-test-${mode}`, username: mode === "simulation" ? "使用模拟" : "冷启测试", createdAt: "" }, dataDir }, async () => {
    await ensureStore();
    await fs.mkdir(storagePaths().attachmentsDir, { recursive: true, mode: 0o700 });
    for (const [resourcePath, bytes] of attachmentCopies) {
      const name = resourcePath.slice("/attachments/".length);
      await fs.writeFile(path.join(storagePaths().attachmentsDir, name), bytes, { mode: 0o600 });
    }
    await writeJsonAtomic(storagePaths().storeFile, normalizeStore(store));
    await storeRepository.update(value => value);
    await ensureLlmSettings();
    if (settings) await writeLlmSettings(normalizeLlmSettings({ ...settings, apiKey: safeText(currentSettings?.apiKey, 300) }));
    await ensureAiUsage();
    await ensureAuditLogs();
  });
}

function localTestRecordCount(store) {
  return ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "actions", "habits", "habitCheckins", "feedback", "validationLedger"].reduce((sum, key) => sum + (store[key]?.length || 0), 0);
}

function mergeLocalTestCollection(collection, current, upstream) {
  if (Array.isArray(current) && Array.isArray(upstream)) {
    const localIds = new Set(current.map(item => safeText(item?.id, 100)).filter(Boolean));
    return [...clone(current), ...clone(upstream).filter(item => !localIds.has(safeText(item?.id, 100)))];
  }
  return JSON.stringify(current) === JSON.stringify(emptyStore[collection])
    ? clone(upstream)
    : clone(current);
}

function switchLocalTestMode(req, mode) {
  const operation = localTestControlQueue.then(async () => {
    if (!localTestModes.has(mode)) throw Object.assign(new Error("本地测试模式无效"), { statusCode: 400, code: "LOCAL_TEST_MODE_INVALID" });
    if (mode === "simulation") {
      const session = localTestUpstreamSession(req);
      if (!session?.user?.id) throw Object.assign(new Error("本地登录会话缺少主账户信息，请重新登录"), { statusCode: 401, code: "AUTH_REQUIRED" });
      if (LOCAL_TEST_MAIN_USER_ID && session.user.id !== LOCAL_TEST_MAIN_USER_ID) throw Object.assign(new Error("当前登录账户不是配置的线上主账户"), { statusCode: 403, code: "LOCAL_TEST_MAIN_ACCOUNT_REQUIRED" });
      const snapshot = normalizeStore({ ...clone(emptyStore), onboarding: { ...clone(emptyStore.onboarding), status: "completed" } });
      await resetLocalTestWorkspace(mode, snapshot);
      const control = { mode, switchedAt: now(), snapshotAt: "", sourceUser: session.user, recordCount: 0, loadedScopes: [], loadedCollections: [] };
      await writeLocalTestControl(control);
      return normalizeLocalTestControl(control);
    }
    await resetLocalTestWorkspace(mode, emptyStore);
    const control = { mode, switchedAt: now(), snapshotAt: "", sourceUser: null, recordCount: 0, loadedScopes: [], loadedCollections: [] };
    await writeLocalTestControl(control);
    return normalizeLocalTestControl(control);
  });
  localTestControlQueue = operation.catch(() => {});
  return operation;
}

function hydrateLocalTestScope(req, scope) {
  const operation = localTestControlQueue.then(async () => {
    if (!localTestScopes.has(scope)) throw Object.assign(new Error("本地测试数据范围无效"), { statusCode: 400, code: "LOCAL_TEST_SCOPE_INVALID" });
    const control = await readLocalTestControl();
    if (control.mode !== "simulation") throw Object.assign(new Error("当前不是使用模拟模式"), { statusCode: 409, code: "LOCAL_TEST_MODE_MISMATCH" });
    const missingCollections = localTestScopeCollections[scope].filter(collection => !control.loadedCollections.includes(collection));
    if (control.loadedScopes.includes(scope) || !missingCollections.length) {
      const nextControl = control.loadedScopes.includes(scope)
        ? control
        : normalizeLocalTestControl({ ...control, loadedScopes: [...control.loadedScopes, scope] });
      if (nextControl !== control) await writeLocalTestControl(nextControl);
      return { control: nextControl, state: publicStateFromStore(await readStore()), hydrated: false };
    }
    const session = localTestUpstreamSession(req);
    if (!session?.user?.id) throw Object.assign(new Error("本地登录会话已失效，请重新登录"), { statusCode: 401, code: "AUTH_REQUIRED" });
    if (LOCAL_TEST_MAIN_USER_ID && session.user.id !== LOCAL_TEST_MAIN_USER_ID) throw Object.assign(new Error("当前登录账户不是配置的线上主账户"), { statusCode: 403, code: "LOCAL_TEST_MAIN_ACCOUNT_REQUIRED" });
    const patch = await localTestScopePatch(req, missingCollections);
    const merged = await updateStore(store => {
      for (const [collection, value] of Object.entries(patch)) {
        store[collection] = mergeLocalTestCollection(collection, store[collection], value);
      }
      return store;
    });
    const nextControl = normalizeLocalTestControl({
      ...control,
      snapshotAt: now(),
      loadedScopes: [...control.loadedScopes, scope],
      loadedCollections: [...control.loadedCollections, ...missingCollections],
      recordCount: localTestRecordCount(merged)
    });
    await writeLocalTestControl(nextControl);
    return { control: nextControl, state: publicStateFromStore(merged), hydrated: true };
  });
  localTestControlQueue = operation.catch(() => {});
  return operation;
}

function publicLocalTestControl(control) {
  return { enabled: LOCAL_TEST_MODE, upstreamConfigured: Boolean(UPSTREAM_ORIGIN), ...normalizeLocalTestControl(control) };
}

async function readStore() {
  return storeRepository.read();
}

function publicStateFromStore(store) {
  const { trash, attachmentCleanup, ...visible } = store;
  return {
    ...visible,
    keepsakes: visible.keepsakes.map(publicKeepsake),
    aiTasks: store.aiTasks.slice(0, 100).map(publicAiTask),
    notificationUnread: notificationUnread(store.notifications),
    clusters: clusters(store),
    insights: insights(store),
    trashCount: trash.length,
    speech: {
      configured: speechProvider.configured,
      defaultVoice: speechProvider.defaultVoice,
      voices: speechProvider.voices,
      supportedAsrMimeTypes: speechProvider.supportedAsrMimeTypes
    },
    vision: { configured: visionProvider.configured }
  };
}

function updateStore(mutator) {
  return storeRepository.update(mutator);
}

const postgresRuntime = PERSISTENCE_BACKEND === "postgres" ? await createPostgresRuntime({
  connectionString: appConfig.databaseUrl,
  authConnectionString: appConfig.authDatabaseUrl,
  authRequired: AUTH_REQUIRED,
  getAccountId: () => requestStorage.getStore()?.user?.id || (AUTH_REQUIRED ? null : "local"),
  requireMigration: await hasJsonData(DATA_DIR),
  onPoolError: error => void logEvent("system", "storage.connection_failed", { level: "error", error: errorMetadata(error) })
}) : null;
if (postgresRuntime) {
  await postgresRuntime.claimApplication(() => process.exit(1));
  await markPostgresDirectory(DATA_DIR);
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
  dailyCallLimit: AI_USER_DAILY_CALL_LIMIT, dailyCostLimitCny: AI_USER_DAILY_COST_LIMIT_CNY, cnyPerUsd: AI_COST_CNY_PER_USD
});
const aiAudit = createAiAudit({
  textLimit: AI_AUDIT_TEXT_LIMIT, getContext: () => requestStorage.getStore(),
  append: (day, entry) => appendPrivateJsonLine(path.join(storagePaths().logsDir, `ai-audit-${day}.ndjson`), entry),
  updateUsage: updateAiUsage, logEvent
});
async function meteredProviderCall(details, invoke, summarize) {
  let reservation;
  try {
    reservation = await reserveAiAttempt({ estimatedCostCny: details.estimatedCostCny || 0 });
  } catch (error) {
    await logEvent("system", "ai.budget_rejected", {
      level: "warn",
      provider: details.provider,
      service: details.service,
      action: details.action,
      scene: details.scene,
      error: errorMetadata(error)
    });
    throw error;
  }
  try {
    return await aiAudit.providerCall({ ...details, reservation }, invoke, summarize);
  } catch (error) {
    throw error;
  }
}
const costRepository = createAccountDocumentRepository({
  runtime: postgresRuntime, name: "costPlan", getFile: () => storagePaths().aiCostPlanFile,
  readDocument: readStoredJson, writeDocument: writeJsonAtomic, normalize: value => value, emptyDocument: null,
  onCommit: auditChanges
});
const aiCosts = createAiCostService({ repository: costRepository, readSettings: readLlmSettings, readUsage: readAiUsage, cnyPerUsd: AI_COST_CNY_PER_USD });
const runDeepSeek = createAiGenerator({
  readSettings: readLlmSettings, provider: createDeepSeekTransport({ endpoint: DEEPSEEK_API_URL }),
  getContext: () => requestStorage.getStore(), reserveAttempt: reserveAiAttempt, gate: aiGate, audit: aiAudit
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
  provider: createAliyunSegmentationTransport({ ...appConfig.segmentation, auditCall: aiAudit.providerCall }),
  gate: segmentationGate,
  onFailure: (error, callGroupId) => logEvent("system", "segmentation.failed", { level: "error", callGroupId, error: errorMetadata(error) })
});
const understandKeepsakeImage = createKeepsakeImageUnderstanding({
  saveImages: saveImageDataUrls,
  cleanupFiles: cleanupTemporaryFiles,
  generate: file => runDeepSeek(promptText("keepsake.image.candidates"), {
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
  const localSession = LOCAL_TEST_MODE ? localTestUpstreamSession(req) : null;
  const headers = {};
  for (const name of ["accept", "content-type", "user-agent"]) if (req.headers[name]) headers[name] = req.headers[name];
  const upstreamCookie = upstreamCookieHeader(req);
  if (upstreamCookie) headers.cookie = upstreamCookie;
  headers["x-request-id"] = requestStorage.getStore().traceId;
  const response = await fetch(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
  let upstreamUser = localSession?.user || null;
  if (LOCAL_TEST_MODE && response.ok && ["/api/auth/login", "/api/auth/me"].includes(url.pathname)) {
    try {
      const payload = await response.clone().json();
      if (payload?.user?.id) upstreamUser = payload.user;
    } catch {}
  }
  const responseHeaders = {};
  for (const name of ["content-type", "cache-control", "location", "x-accel-buffering", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() || (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  if (LOCAL_TEST_MODE) {
    const localPath = APP_BASE_PATH === "/" ? "/" : APP_BASE_PATH;
    if (url.pathname === "/api/auth/logout") {
      if (localSession) localTestUpstreamSessions.delete(localSession.token);
      responseHeaders["set-cookie"] = `${LOCAL_TEST_SESSION_COOKIE}=; Path=${localPath}; HttpOnly; SameSite=Strict; Max-Age=0`;
    } else {
      const sessionCookies = cookies.map(cookie => cookie.split(";", 1)[0]).filter(Boolean).join("; ");
      if (response.ok && sessionCookies) {
        const token = localSession?.token || crypto.randomBytes(32).toString("base64url");
        storeLocalTestUpstreamSession(token, sessionCookies, upstreamUser);
        responseHeaders["set-cookie"] = `${LOCAL_TEST_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${localPath}; HttpOnly; SameSite=Strict; Max-Age=${LOCAL_TEST_SESSION_MAX_AGE_SECONDS}`;
      } else if (response.ok && localSession && upstreamUser) {
        storeLocalTestUpstreamSession(localSession.token, localSession.cookie, upstreamUser);
      }
    }
  } else if (cookies.length) {
    responseHeaders["set-cookie"] = cookies;
  }
  res.writeHead(response.status, responseHeaders);
  if (!response.body) return res.end();
  for await (const chunk of response.body) {
    if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once("drain", resolve));
  }
  res.end();
}

const userDataDir = user => path.join(USERS_DIR, user.id);
const bindAuthenticatedUser = user => {
  const context = requestStorage.getStore();
  if (context) Object.assign(context, { user, ...(AUTH_REQUIRED ? { dataDir: userDataDir(user) } : {}) });
};
const authRepository = createAuthRepository({
  runtime: postgresRuntime, file: AUTH_FILE, readDocument: readStoredJson,
  writeDocument: writeJsonAtomic, onCommit: auditChanges,
  onInvalid: () => logEvent("system", "storage.read_failed", { level: "error", file: "auth.json", error: { code: "INVALID_AUTH_DOCUMENT" } })
});
const readAuth = () => authRepository.read();
const authService = createAuthService({
  repository: authRepository, authRequired: AUTH_REQUIRED, inviteCodeHash: INVITE_CODE_HASH,
  async initializeUserStorage(user, importLegacy) {
    await initializeUserStorage(user, importLegacy);
    bindAuthenticatedUser(user);
  }
});
const { requestUser, authApi } = createAuthHttp({
  service: authService, sendJson, bodyJson, authRequired: AUTH_REQUIRED,
  basePath: APP_BASE_PATH, cookieSecure: COOKIE_SECURE,
  bindUser: bindAuthenticatedUser
});

async function initializeUserStorage(user, importLegacy = false) {
  const target = userDataDir(user);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.chmod(target, 0o700);
  if (postgresRuntime) {
    postgresRuntime.auth.provision(user.id, normalizeStore(clone(emptyStore)), {
      settings: normalizeLlmSettings({}), usage: normalizeAiUsage({})
    });
    await fs.mkdir(path.join(target, "attachments"), { recursive: true, mode: 0o700 });
    await requestStorage.run({ ...requestStorage.getStore(), user, dataDir: target }, ensureAuditLogs);
    return;
  }
  if (importLegacy) {
    for (const name of ["store.json", "llm-settings.json", "ai-usage.json"]) {
      try { await fs.copyFile(path.join(DATA_DIR, name), path.join(target, name), fs.constants.COPYFILE_EXCL); } catch (error) { if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error; }
    }
    for (const name of ["attachments", "logs"]) {
      try { await fs.cp(path.join(DATA_DIR, name), path.join(target, name), { recursive: true, errorOnExist: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  await requestStorage.run({ ...requestStorage.getStore(), user, dataDir: target }, async () => {
    await ensureStore();
    await ensureLlmSettings();
    await ensureAiUsage();
    await ensureAuditLogs();
  });
}

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

async function recognizeVisualFiles(files) {
  if (!visionProvider.configured) return null;
  const results = [];
  for (const file of files) {
    const data = await fs.readFile(file);
    results.push(await meteredProviderCall({
      provider: "volcengine",
      service: "vision",
      scene: "visionOcr",
      action: "OCRNormal",
      request: { imageBytes: data.length },
      modality: "vision",
      imageCount: 1,
      imageBytes: data.length,
      unitType: "image",
      units: 1,
      costKnown: false,
      costSource: "Volcengine billing not configured"
    }, async () => {
      const release = await ocrGate.acquire();
      try {
        return await visionProvider.recognizeText({ data });
      } finally {
        release();
      }
    }));
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
    const referenceDate = /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate || "") ? input.referenceDate : today();
    const dateContext = renderPrompt("health.image.referenceDate", { referenceDate });
    const recognizedText = await recognizeVisualFiles(uploaded.files);
    const raw = await runDeepSeek(
      recognizedText
        ? `${config.prompt}${dateContext}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
        : `${config.prompt}${dateContext}`,
      {
        scene: config.scene,
        ...(recognizedText ? {} : { imagePaths: uploaded.files }),
        json: true,
        maxTokens: 4000
      }
    );
    let parsed = {};
    try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ""); }
    catch { throw new Error("截图已读取，但模型返回格式无法解析，请重试或手动填写"); }
    return { ...normalizeParsedImage(kind, parsed), attachmentPaths: uploaded.attachmentPaths };
  } catch (error) {
    if (!attachmentPaths.length) await imageAttachments.discard(uploaded.attachmentPaths);
    throw error;
  } finally {
    await cleanupTemporaryFiles(uploaded.cleanupFiles);
  }
}

function classify(text, tags = []) {
  const value = `${text} ${tags.join(" ")}`.toLowerCase();
  const groups = [
    ["工作与创造", ["工作", "项目", "职业", "同事", "产品", "创作", "任务"]],
    ["关系与连接", ["关系", "朋友", "家人", "伴侣", "社交", "沟通"]],
    ["身心状态", ["睡眠", "情绪", "压力", "疲惫", "焦虑", "健康", "运动", "身体"]],
    ["学习与成长", ["学习", "阅读", "能力", "课程", "复盘", "成长", "知识"]],
    ["选择与方向", ["选择", "决定", "目标", "方向", "未来", "要不要", "价值", "意义"]],
    ["金钱与消费", ["理财", "消费", "收入", "储备金", "价格", "支付能力"]]
  ];
  return groups.find(([, words]) => words.some(word => value.includes(word)))?.[0] || tags[0] || "待慢慢看清";
}

function clusters(store) {
  const map = new Map();
  const roots = store.thoughts.filter(item => item.type === "question");
  for (const item of roots) {
    const theme = classify(item.content, item.tags);
    if (!map.has(theme)) map.set(theme, []);
    map.get(theme).push(item);
  }
  return [...map.entries()].map(([theme, items]) => ({
    theme, count: items.length,
    questions: items.length,
    kept: items.filter(item => item.disposition === "kept").length,
    discarded: items.filter(item => item.disposition === "discarded").length,
    unreviewed: items.filter(item => item.disposition === "pending").length,
    items: items.sort((a, b) => (b.occurredAt || b.createdAt).localeCompare(a.occurredAt || a.createdAt))
  })).sort((a, b) => b.count - a.count);
}

function isUntouchedAiAnswer(item) {
  const content = safeText(item?.content);
  const modelDraft = safeText(item?.modelDraft);
  return item?.type === "answer"
    && Boolean(modelDraft)
    && content === modelDraft
    && !item.editedFromModel
    && !item.updatedAt
    && !["manual", "deepseek-edited"].includes(item.origin);
}

function thoughtHasUserTrace(store, root) {
  const children = store.thoughts.filter(item => item.relatedTo === root.id);
  return Boolean(
    root.updatedAt
    || root.dispositionAt
    || (root.annotations || []).length
    || (root.annotationDrift || []).length
    || (root.remarks || []).length
    || (root.followUps || []).length
    || children.some(item => item.type === "idea" && safeText(item.content))
    || children.some(item => item.type === "answer" && !isUntouchedAiAnswer(item) && (safeText(item.content) || safeText(item.modelDraft)))
  );
}

function thoughtIsUntouchedAiOnly(store, root) {
  const answers = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "answer");
  return answers.some(isUntouchedAiAnswer) && !thoughtHasUserTrace(store, root);
}

function insights(store) {
  const ordered = [...store.checkins].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || (a.occurredAt || a.createdAt).localeCompare(b.occurredAt || b.createdAt));
  const dates = [...new Set(ordered.map(item => item.occurredOn))].sort();
  const byDate = new Map(dates.map(date => [date, ordered.filter(item => item.occurredOn === date)]));
  const daily = dates.map(date => Object.fromEntries(["mood", "energy", "stress", "sleep"].map(metric => [
    metric, avg(byDate.get(date).map(item => Number(item[metric])).filter(Number.isFinite))
  ])));
  const recent = daily.slice(-7), previous = daily.slice(-14, -7);
  const trends = ["mood", "energy", "stress", "sleep"].map(metric => {
    const currentValues = recent.map(item => Number(item[metric])).filter(Number.isFinite);
    const previousValues = previous.map(item => Number(item[metric])).filter(Number.isFinite);
    return { metric, current: round(avg(currentValues)), previous: round(avg(previousValues)), currentCount: currentValues.length, previousCount: previousValues.length };
  });
  const factorNames = [...new Set(ordered.flatMap(item => item.factors || []))];
  const confidenceRank = { "单日观察": 1, "初步线索": 2, "可观察": 3 };
  const associationEvidence = item => Math.min(item.withCount, item.withoutCount) + item.nextDayCount;
  const associationEffect = item => item.baseline == null ? 0 : Math.max(
    ...[item.sameDay, item.nextDay].filter(Number.isFinite).map(value => Math.abs(value - item.baseline)),
    0
  );
  const associations = factorNames.map(factor => {
    const withFactor = [], withoutFactor = [], nextDay = [];
    dates.forEach(date => {
      const entries = byDate.get(date); const mood = avg(entries.map(item => item.mood));
      const present = entries.some(item => (item.factors || []).includes(factor));
      (present ? withFactor : withoutFactor).push(mood);
      const nextEntries = byDate.get(shiftDateKey(date, 1));
      if (present && nextEntries) nextDay.push(avg(nextEntries.map(item => item.mood)));
    });
    const confidence = withFactor.length >= 10 && withoutFactor.length >= 10 && nextDay.length >= 5 && dates.length >= 30
      ? "可观察"
      : withFactor.length >= 2 ? "初步线索" : "单日观察";
    return { factor, withCount: withFactor.length, withoutCount: withoutFactor.length, nextDayCount: nextDay.length, sameDay: round(avg(withFactor)), baseline: round(avg(withoutFactor)), nextDay: round(avg(nextDay)), confidence };
  }).sort((a, b) =>
    confidenceRank[b.confidence] - confidenceRank[a.confidence]
    || associationEvidence(b) - associationEvidence(a)
    || associationEffect(b) - associationEffect(a)
    || a.factor.localeCompare(b.factor, "zh-CN")
  ).slice(0, 3);
  const weekAgo = shiftDateKey(today(), -6);
  const weekRoots = store.thoughts.filter(item => item.type === "question" && (item.occurredOn || item.createdAt.slice(0, 10)) >= weekAgo);
  const answeredRoots = weekRoots.filter(root => store.thoughts.some(item => item.relatedTo === root.id && item.type === "answer"));
  const currentDate = today(), monthAgo = shiftDateKey(currentDate, -29);
  const itemDate = item => {
    const timestamp = item?.occurredAt || item?.createdAt;
    return item?.occurredOn || (timestamp ? localDateKey(timestamp) : "");
  };
  const inWindow = (item, cutoff) => {
    const date = itemDate(item);
    return date >= cutoff && date <= currentDate;
  };
  const activeDates = new Set([
    ...store.checkins, ...store.dailyRecords, ...store.captures, ...store.journals,
    ...store.thoughts.filter(item => item.type === "question"), ...store.chats, ...store.quotes,
    ...store.books.flatMap(book => book.notes || []), ...store.keepsakes
  ].filter(item => inWindow(item, weekAgo)).map(itemDate));
  const checkinDates30 = new Set(store.checkins.filter(item => inWindow(item, monthAgo)).map(itemDate));
  const healthDates30 = new Set(store.dailyRecords.filter(item => inWindow(item, monthAgo)).map(itemDate));
  const pairedDays30 = [...checkinDates30].filter(date => healthDates30.has(date)).length;
  const roots30 = store.thoughts.filter(item => item.type === "question" && inWindow(item, monthAgo));
  const tracedRoots30 = roots30.filter(root => thoughtHasUserTrace(store, root));
  const aiOnlyThoughtIds = store.thoughts
    .filter(item => item.type === "question" && thoughtIsUntouchedAiOnly(store, item))
    .map(item => item.id);
  const annotationRoots = [
    ...store.captures, ...store.journals, ...store.thoughts, ...store.chats,
    ...store.books, ...store.quotes, ...store.analyses
  ];
  const annotations = annotationRoots.flatMap(root => [...(root.annotations || []), ...(root.annotationDrift || [])]);
  const correctionActions30 = [
    ...store.thoughts.filter(item => item.type === "answer" && item.editedFromModel).map(item => ({ ...item, occurredOn: localDateKey(item.updatedAt || item.createdAt || item.occurredAt) })),
    ...store.thoughts.flatMap(root => root.followUps || []),
    ...store.thoughts.flatMap(root => root.remarks || []),
    ...annotations,
    ...annotations.flatMap(annotation => annotation.replies || []),
    ...store.journals.flatMap(journal => journal.reflections || []),
    ...store.analyses.filter(item => item.reason === "manual")
  ].filter(item => inWindow(item, monthAgo)).length;
  const latestAnalysisDate = store.analyses.map(item => localDateKey(item.createdAt)).filter(Boolean).sort().at(-1) || "";
  const reviewAgeDays = latestAnalysisDate
    ? Math.max(0, Math.round((Date.parse(`${currentDate}T00:00:00Z`) - Date.parse(`${latestAnalysisDate}T00:00:00Z`)) / 86400000))
    : null;
  return {
    trends,
    associations,
    aiOnlyThoughtIds,
    weekly: {
      checkins: recent.length,
      thoughts: weekRoots.length,
      questions: weekRoots.length,
      answers: answeredRoots.length,
      kept: weekRoots.filter(item => item.disposition === "kept").length,
      activeDays7: activeDates.size,
      pairedDays30,
      rootCount30: roots30.length,
      tracedRoots30: tracedRoots30.length,
      traceRate30: roots30.length ? Math.round(tracedRoots30.length / roots30.length * 100) : null,
      correctionActions30,
      reviewAgeDays,
      analysisCount: store.analyses.length
    }
  };
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
async function transcribeCapture(work, { signal } = {}) {
  const audio = await imageAttachments.read(work.audio.attachmentPath);
  const transcription = await meteredProviderCall({
    provider: "volcengine",
    service: "speech",
    scene: "speechRecognition",
    action: "streamingAsr",
    request: { audioBytes: audio.length, mimeType: work.audio.mimeType },
    modality: "audio",
    unitType: "audioMillisecond",
    units: work.audio.durationMs,
    costKnown: false,
    costSource: "Volcengine billing not configured"
  }, async () => {
    const release = await speechGate.acquire();
    try {
      return await speechProvider.transcribe({
        audio,
        mimeType: work.audio.mimeType,
        signal
      });
    } finally {
      release();
    }
  });
  let polishedText = "", polishErrorCode = "";
  try {
    polishedText = await runDeepSeek(
      renderPrompt("capture.transcription.polish", { rawText: transcription.rawText }),
      {
        scene: "capturePolish",
        maxTokens: 4000,
        signal
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
  return {
    ...transcription,
    polishedText,
    polishErrorCode,
    updatedAt: now()
  };
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
const speechHttp = createSpeechHttp({
  speech: speechProvider,
  gate: speechGate,
  auditCall: (details, invoke, summarize) => meteredProviderCall(details, invoke, summarize),
  bodyJson,
  sendJson,
  readSettings: readLlmSettings,
  getContext: () => requestStorage.getStore()
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
const aiSettingsHttp = createAiSettingsHttp({ settings: llmSettingsService, generate: runDeepSeek, bodyJson, sendJson });
const aiCostHttp = createAiCostHttp({ costs: aiCosts, bodyJson, sendJson });
const onboardingHttp = createOnboardingHttp({
  onboarding: createOnboardingService({
    repository: { update: mutate => updateStore(store => { store.onboarding = mutate(store.onboarding); return store.onboarding; }) },
    now
  }),
  bodyJson, sendJson
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
    if (!LOCAL_TEST_MODE || requestStorage.getStore()?.localTestMode !== "simulation" || !UPSTREAM_ORIGIN) return false;
    await proxyToUpstream(req, res, url);
    return true;
  }
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
  const row = (await listAttachmentInventory()).find(item => item.path === parsed.value.attachmentPath);
  if (!row) {
    return {
      forbidden: true,
      error: "语音附件不属于当前账户",
      code: "ATTACHMENT_NOT_OWNED"
    };
  }
  const validated = captureAudioPayload({ ...parsed.value, bytes: row.bytes });
  return validated.error ? validated : { value: { audio: validated.value } };
}
const exportHttp = createExportHttp({
  createExport: createAccountExport,
  snapshot: async () => ({
    accountId: requestStorage.getStore()?.user?.id || "local",
    snapshotAt: now(),
    store: await readStore()
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
    const recognizedText = await recognizeVisualFiles(files);
    return runDeepSeek(
      recognizedText
        ? `${IMAGE_PARSE_CONFIG.book.prompt}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
        : IMAGE_PARSE_CONFIG.book.prompt,
      {
        scene: IMAGE_PARSE_CONFIG.book.scene,
        ...(recognizedText ? {} : { imagePaths: files }),
        json: true,
        maxTokens: 4000
      }
    );
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
  sendTrashResult
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
const syncHttp = createSyncHttp({
  repository: storeRepository,
  publicState: publicStateFromStore
});
const personalContextHttp = createPersonalContextHttp({
  readStore,
  project: store => personalContextProjection(store, { generatedAt: now() })
});
apiV1.register("sync", syncHttp.handleV1);
apiV1.register("personal-context", personalContextHttp.handleV1);
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
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg",
  ".wav": "audio/wav"
};
if (LOCAL_TEST_MODE) {
  await fs.mkdir(LOCAL_TEST_WORKSPACES_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(LOCAL_TEST_WORKSPACES_DIR, 0o700);
  if (LOCAL_TEST_RESET_ON_START) await resetLocalTestWorkspace("cold", emptyStore);
  const control = LOCAL_TEST_RESET_ON_START
    ? normalizeLocalTestControl({ mode: "cold", switchedAt: now(), snapshotAt: "", sourceUser: null, recordCount: 0, loadedScopes: [], loadedCollections: [] })
    : await readLocalTestControl();
  await writeLocalTestControl(control);
  await requestStorage.run({ user: { id: `local-test-${control.mode}`, username: control.mode === "simulation" ? "使用模拟" : "冷启测试", createdAt: "" }, dataDir: localTestWorkspaceDir(control.mode) }, async () => {
    await ensureStore();
    await ensureLlmSettings();
    await ensureAiUsage();
    await ensureAuditLogs();
    await resumeAttachmentCleanup();
    await backgroundAi.resume();
    await keepsakeMediaWorkflows.resume();
  });
} else if (!postgresRuntime || !AUTH_REQUIRED) {
  await ensureStore();
  await ensureLlmSettings();
  await ensureAiUsage();
  await ensureAuditLogs();
  await resumeAttachmentCleanup();
  await backgroundAi.resume();
  await keepsakeMediaWorkflows.resume();
}
await fs.mkdir(USERS_DIR, { recursive: true, mode: 0o700 });
await fs.chmod(USERS_DIR, 0o700);
if (AUTH_REQUIRED) {
  const auth = await readAuth();
  for (const user of auth.users) {
    await requestStorage.run({ user, dataDir: userDataDir(user) }, async () => {
      await ensureStore();
      await ensureLlmSettings();
      await ensureAiUsage();
      await ensureAuditLogs();
      await resumeAttachmentCleanup();
      await backgroundAi.resume();
      await keepsakeMediaWorkflows.resume();
    });
  }
}
const periodicFailure = error => logEvent("system", "scheduler.failed", { level: "error", error: errorMetadata(error) });
if (!LOCAL_TEST_MODE && PERIODIC_ANALYSIS_ENABLED) {
  setTimeout(() => void runPeriodicAnalyses().catch(periodicFailure), 5000).unref();
  setInterval(() => void runPeriodicAnalyses().catch(periodicFailure), 3600000).unref();
}
http.createServer(createRequestHandler({
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
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
    if (unsafe && String(req.headers["sec-fetch-site"] || "") === "cross-site") return sendRequestError(403, "跨站请求已拒绝", "CROSS_SITE_REQUEST_REJECTED");
    if (LOCAL_TEST_MODE) {
      const control = await readLocalTestControl();
      context.localTestMode = control.mode;
      context.dataDir = localTestWorkspaceDir(control.mode);
    }
    if (LOCAL_TEST_MODE && url.pathname === "/api/local-test-mode/hydrate" && req.method === "POST") {
      const input = await bodyJson(req), result = await hydrateLocalTestScope(req, safeText(input.scope, 40));
      return sendJson(res, 200, {
        control: publicLocalTestControl(result.control),
        state: result.state,
        hydrated: result.hydrated
      });
    }
    if (LOCAL_TEST_MODE && url.pathname === "/api/local-test-mode") {
      if (req.method === "GET") return sendJson(res, 200, publicLocalTestControl(await readLocalTestControl()));
      if (req.method === "POST") {
        const input = await bodyJson(req), control = await switchLocalTestMode(req, safeText(input.mode, 40));
        return sendJson(res, 200, publicLocalTestControl(control));
      }
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    if (LOCAL_TEST_MODE && UPSTREAM_ORIGIN && url.pathname.startsWith("/api/auth/")) {
      const allowed = (req.method === "GET" && url.pathname === "/api/auth/me")
        || (req.method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname));
      return allowed ? await proxyToUpstream(req, res, url) : sendJson(res, 403, { error: "本地测试版禁止修改线上账户", code: "LOCAL_TEST_READ_ONLY" });
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const handled = await adminSnapshotApi(req, res, url);
      return handled === false ? sendJson(res, 404, { error: "Not found" }) : handled;
    }
    if (UPSTREAM_ORIGIN && !LOCAL_TEST_MODE && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/"))) return await proxyToUpstream(req, res, url);
    const user = await requestUser(req);
    if (url.pathname.startsWith("/api/auth/")) {
      const handled = await authApi(req, res, url);
      return handled === false ? sendJson(res, 404, { error: "Not found" }) : handled;
    }
    if (url.pathname.startsWith("/api/") && !user) return sendRequestError(401, "请先登录", "AUTH_REQUIRED");
    if (url.pathname.startsWith("/attachments/") && !user) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
      if (url.pathname.startsWith("/api/v1/")) {
        const handled = await apiV1.handle(req, res, url);
        return handled === false ? apiV1.error(res, 404, "Not found", "NOT_FOUND") : handled;
      }
      if (req.method === "GET" && url.pathname === "/api/meta") {
        return sendJson(res, 200, {
          version: APP_VERSION,
          releaseVersion: RELEASE_VERSION,
          user: publicUser(user),
          features: appConfig.features,
          governanceUrl: PLATFORM_SERVICE_TOKEN_HASH ? "/platform/" : ""
        });
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (await attachmentHttp.handle(req, res, url)) return;
      const base = PUBLIC_DIR, relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.resolve(base, relative); if (!file.startsWith(`${base}${path.sep}`) && file !== path.join(base, "index.html")) return sendJson(res, 403, { error: "Forbidden" });
      const data = await fs.readFile(file); res.writeHead(200, { "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" }); res.end(data);
  }
})).listen(PORT, "127.0.0.1", () => void logEvent("system", "server.started", { level: "info", port: PORT }));
