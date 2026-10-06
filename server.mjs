import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { loadAppConfig } from "./src/config/index.mjs";
import { createObservability, createRuntimeMemorySampler, errorMetadata, pruneLogs } from "./src/shared/observability/index.mjs";
import {
  createOnboardingService,
  createOnboardingV2Service
} from "./src/modules/onboarding/index.mjs";
import { capabilitiesFor, createAuthService, isOwner, publicUser } from "./src/modules/auth/index.mjs";
import { notificationUnread } from "./src/modules/notifications/index.mjs";
import { createStatisticsService } from "./src/modules/statistics/index.mjs";
import { architectureOwnerSurface, commercializationOwnerSurface } from "./src/modules/owner-surfaces/index.mjs";
import { createThoughtDiscoveryService } from "./src/modules/discovery/index.mjs";
import { createAccountExport } from "./src/modules/exports/index.mjs";
import { createActionsService } from "./src/modules/actions/index.mjs";
import { createFeedbackService } from "./src/modules/feedback/index.mjs";
import { createUserModelService } from "./src/modules/user-model/index.mjs";
import { normalizeLlmSettings, normalizeAiUsage } from "./src/modules/ai/index.mjs";
import { loadPromptCatalog } from "./src/infrastructure/prompt-catalog/index.mjs";
import {
  publicKeepsake,
  originalKeepsakeMedia
} from "./src/modules/keepsakes/index.mjs";
import { installPromptCatalog } from "./src/shared/prompts/index.mjs";
import { localDateKey, eventTimeFields } from "./src/shared/time/index.mjs";
import { buildAdminSnapshot } from "./admin-snapshot.mjs";
import { createAccountLifecycle, createAiRuntime, createContentRuntime, createLocalTestRuntime, createStoreNormalizer, createPublicStateProjection, emptyStore, normalizeCommercialization, routeStateProjection, startupProjection, storeForUser, STORE_VERSION, TRASH_RETENTION_DAYS, userModelEvidenceCurrent } from "./src/app/index.mjs";
import {
  SPEECH_CACHE_SWEEP_INTERVAL_MS,
  SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
} from "./src/app/index.mjs";
import { safeText, recordVersion, safeIso } from "./src/shared/validation/index.mjs";
import { createAuthHttp, createLocalTestHttp, createLocalTestSessionVault, createReadOnlyUpstream, createJsonHttp, createTaskHttp, createAnnotationHttp, createTrashHttp, createAttachmentHttp, createAiSettingsHttp, createAiCostHttp, createAiBudgetHttp, createKeepsakeHttp, createOnboardingHttp, createOnboardingV2Http, createUserModelHttp, createThoughtHttp, createCheckinHttp, createHealthRecordHttp, createImageRecognitionHttp, createDiscoveryHttp, createExportHttp, createActionsHttp, createFeedbackHttp, createCaptureJournalHttp, createLibraryHttp, createReviewsChatHttp, createContentAttachmentsHttp, createSpeechHttp, createVisionHttp, createSyncHttp, createStartupHttp, createPersonalContextHttp, createRequestHandler, createModelResponseHttp, createApiV1Http, openApiV1 } from "./src/http/index.mjs";
import { createAuthRepository, createJsonStoreRepository, createPostgresRuntime, checkPersistenceMarker, markPostgresDirectory, hasJsonData } from "./src/shared/persistence/index.mjs";
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
const aiRuntime = await createAiRuntime({
  dataRoot: DATA_DIR,
  postgresRuntime,
  storagePaths,
  requestStorage,
  readStoredJson,
  writeJsonAtomic,
  auditChanges,
  logEvent,
  deepSeekApiUrl: DEEPSEEK_API_URL,
  aiQps: AI_GLOBAL_QPS,
  aiConcurrency: AI_GLOBAL_CONCURRENCY,
  userDailyCallLimit: AI_USER_DAILY_CALL_LIMIT,
  userDailyCostLimitCny: AI_USER_DAILY_COST_LIMIT_CNY,
  cnyPerUsd: AI_COST_CNY_PER_USD,
  auditTextLimit: AI_AUDIT_TEXT_LIMIT,
  auditRetentionDays: AI_AUDIT_RETENTION_DAYS,
  now
});
const {
  aiBudgetService,
  aiBudgetRuntime,
  settingsRepository,
  llmSettingsService,
  readLlmSettings,
  writeLlmSettings,
  ensureLlmSettings,
  readAiUsage,
  ensureAiUsage,
  costRepository,
  aiCosts,
  runDeepSeek,
  providerBudgetStage,
  conservativeDeepSeekStage,
  currentBudgetAccountId,
  meteredProviderCall,
  ensureAuditLogs,
  installModelRuntimeSettingsReader
} = aiRuntime;
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

const discoveryService = createThoughtDiscoveryService({ repository: storeRepository, now });
const actionsService = createActionsService({ repository: storeRepository, now, today, createId: () => crypto.randomUUID() });
const feedbackService = createFeedbackService({ repository: storeRepository, now, createId: () => crypto.randomUUID(), hash: sha256 });
const contentRuntime = createContentRuntime({
  repository: storeRepository,
  trashRetentionDays: TRASH_RETENTION_DAYS,
  getAccountId: () => requestStorage.getStore()?.user?.id || "local",
  getCursorScope: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
  backgroundContextKey: () => requestStorage.getStore()?.dataDir || DATA_DIR,
  workflowContextKey: () => storagePaths().storeFile,
  dispatchBackground: callback => {
    const context = { ...(requestStorage.getStore() || {}) };
    setImmediate(() => requestStorage.run(context, callback));
  },
  runDeepSeek,
  now,
  today,
  currentTime: () => Date.now(),
  createId: () => crypto.randomUUID(),
  hash: sha256,
  logEvent,
  debugServerUrl: appConfig.debug.serverUrl,
  debugRunId: appConfig.debug.runId,
  mediaOptions: {
    attachmentStorageConfig: appConfig.attachments,
    attachmentInventory: postgresRuntime?.attachments,
    attachmentQuotaBytes: ATTACHMENT_USER_QUOTA_BYTES,
    defaultImageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
    uploadImageMaxBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES,
    uploadAudioMaxBytes: ATTACHMENT_UPLOAD_AUDIO_MAX_BYTES,
    audioMaxDurationMs: ATTACHMENT_AUDIO_MAX_DURATION_MS,
    getAttachmentContext: () => ({
      ...storagePaths(),
      ownerId: safeText(requestStorage.getStore()?.user?.id, 100) || "local"
    }),
    getOwnerId: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
    cleanupContextKey: () => storagePaths().storeFile,
    keepsakeContextKey: () => requestStorage.getStore()?.dataDir || DATA_DIR,
    dispatchCleanup: (callback, delay) => {
      const context = { ...(requestStorage.getStore() || {}) };
      const timer = setTimeout(() => requestStorage.run(context, callback), delay);
      timer.unref();
      return timer;
    },
    dispatchKeepsake: callback => {
      const context = { ...(requestStorage.getStore() || {}) };
      setImmediate(() => requestStorage.run(context, callback));
    },
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
    speechConfig: appConfig.speech,
    visionConfig: appConfig.vision,
    segmentationConfig: appConfig.segmentation,
    speechQps: SPEECH_GLOBAL_QPS,
    speechConcurrency: SPEECH_GLOBAL_CONCURRENCY,
    ocrQps: OCR_GLOBAL_QPS,
    ocrConcurrency: OCR_GLOBAL_CONCURRENCY,
    documentQps: DOCUMENT_PARSE_GLOBAL_QPS,
    documentConcurrency: DOCUMENT_PARSE_GLOBAL_CONCURRENCY,
    segmentationQps: SEGMENTATION_GLOBAL_QPS,
    segmentationConcurrency: SEGMENTATION_GLOBAL_CONCURRENCY,
    aiBudgetRuntime,
    providerBudgetStage,
    conservativeDeepSeekStage,
    currentBudgetAccountId,
    meteredProviderCall
  }
});
const {
  annotationCommands,
  trashService,
  trashMutations,
  thoughtService,
  captureRecords,
  journalRecords,
  checkinRecords,
  dailyRecordRecords,
  keepsakeRecords,
  chatRecords,
  reviewRecords,
  contentAttachmentService,
  backgroundAi,
  requestCaptureTranscription,
  thoughtWorkflows,
  captureJournalWorkflows,
  reviewChatWorkflows,
  userModelExtractions,
  projectPersonalContext,
  maybeRunPeriodicAnalysis,
  trashCommands,
  attachmentStorage,
  resumeAttachmentCleanup,
  imageAttachments,
  saveOriginalImages,
  saveKeepsakeImages,
  saveOriginalAudio,
  discardOriginalUploads,
  discardOriginalAudio,
  listAttachmentInventory,
  prepareCaptureAudio,
  speechProvider,
  visionProvider,
  speechGate,
  ocrGate,
  documentParseGate,
  parseImageRequest,
  speechCache,
  runSpeechCacheSweep,
  keepsakeMediaWorkflows,
  segmentKeepsakeImage,
  understandKeepsakeImage,
  libraryWorkflows
} = contentRuntime;
const {
  moveCollectionItemToTrash,
  moveNestedItemToTrash,
  moveThoughtBlockToTrash
} = trashMutations;
const publicStateFromStore = createPublicStateProjection({
  getUser: () => requestStorage.getStore()?.user,
  isOwner,
  speechProvider,
  visionProvider,
  hash: sha256,
  now,
  today
});

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
installModelRuntimeSettingsReader(async () => {
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
});

const taskHttp = createTaskHttp({ backgroundAi, bodyJson, sendJson });
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
  extractions: userModelExtractions,
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
  uploadOriginals: (req, images) => saveOriginalImages(images, {
    idempotencyKey: req.headers["idempotency-key"]
  }),
  uploadKeepsake: (req, input) => saveKeepsakeImages(input, {
    idempotencyKey: req.headers["idempotency-key"]
  }),
  discardUploads: discardOriginalUploads,
  uploadAudio: (req, input) => saveOriginalAudio(input, {
    idempotencyKey: req.headers["idempotency-key"]
  }),
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
const libraryHttp = createLibraryHttp({
  library: libraryWorkflows,
  bodyJson,
  sendJson,
  sendTrashResult
});
const imageRecognitionHttp = createImageRecognitionHttp({
  parseImage: parseImageRequest,
  parseBook: input => libraryWorkflows.parseBook(input),
  bodyJson,
  sendJson,
  requestBinding
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
  project: store => projectPersonalContext(store, {
    includeOwnerMetadata: isOwner(requestStorage.getStore()?.user)
  })
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
  if (await imageRecognitionHttp.handle(req, res, url)) return;
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
