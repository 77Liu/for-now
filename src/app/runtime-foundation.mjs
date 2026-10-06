import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/index.mjs";
import { loadPromptCatalog } from "../infrastructure/prompt-catalog/index.mjs";
import { createActionsService } from "../modules/actions/index.mjs";
import { createThoughtDiscoveryService } from "../modules/discovery/index.mjs";
import { createFeedbackService } from "../modules/feedback/index.mjs";
import { isOwner } from "../modules/auth/index.mjs";
import { installPromptCatalog } from "../shared/prompts/index.mjs";
import {
  createJsonStoreRepository,
  createPostgresRuntime,
  checkPersistenceMarker,
  hasJsonData,
  markPostgresDirectory
} from "../shared/persistence/index.mjs";
import {
  createObservability,
  createRuntimeMemorySampler,
  errorMetadata
} from "../shared/observability/index.mjs";
import { localDateKey } from "../shared/time/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import { createAiRuntime } from "./ai-runtime.mjs";
import { createContentRuntime } from "./content-runtime.mjs";
import { createPublicStateProjection } from "./public-state.mjs";
import { createStoreNormalizer } from "./store-normalization.mjs";
import { emptyStore, STORE_VERSION, TRASH_RETENTION_DAYS } from "./store-schema.mjs";

const STANDARD_BODY_MAX_BYTES = 12_000_000;
const ATTACHMENT_UPLOAD_BODY_MAX_BYTES = 36_000_000;
const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const ATTACHMENT_UPLOAD_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_AUDIO_MAX_DURATION_MS = 10 * 60 * 1000;

export async function createRuntimeFoundation({
  rootUrl,
  processRef = process,
  accountAccess
} = {}) {
  if (!rootUrl) throw new TypeError("Server runtime rootUrl is required");
  if (!accountAccess || typeof accountAccess !== "object") {
    throw new TypeError("Server runtime accountAccess port is required");
  }

  const rootDir = path.dirname(fileURLToPath(rootUrl));
  const publicDir = path.join(rootDir, "public");
  const releaseVersion = String(
    JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")).version
      || "development"
  );
  const appConfig = loadAppConfig({ rootDir });
  installPromptCatalog(await loadPromptCatalog({
    rootDir,
    requestedVersion: appConfig.promptCatalogVersion
  }));

  const {
    dataDir,
    persistenceBackend,
    authRequired,
    testCurrentDate,
    runtimeMemorySampleIntervalMs,
    deepSeekApiUrl
  } = appConfig;
  await checkPersistenceMarker(dataDir, persistenceBackend);

  const paths = Object.freeze({
    rootDir,
    publicDir,
    dataDir,
    authFile: path.join(dataDir, "auth.json"),
    usersDir: path.join(dataDir, "users"),
    localTestControlFile: path.join(dataDir, "local-test-mode.json"),
    localTestWorkspacesDir: path.join(dataDir, "local-test-workspaces")
  });
  const {
    context: requestStorage,
    logEvent,
    auditChanges
  } = createObservability({
    rootDir: dataDir,
    version: appConfig.version
  });
  const runtimeMemorySampler = createRuntimeMemorySampler({
    logEvent,
    intervalMs: runtimeMemorySampleIntervalMs
  });
  const storagePaths = () => {
    const currentDataDir = requestStorage.getStore()?.dataDir || dataDir;
    return {
      dataDir: currentDataDir,
      attachmentsDir: path.join(currentDataDir, "attachments"),
      logsDir: path.join(currentDataDir, "logs"),
      storeFile: path.join(currentDataDir, "store.json"),
      llmSettingsFile: path.join(currentDataDir, "llm-settings.json"),
      aiUsageFile: path.join(currentDataDir, "ai-usage.json"),
      aiCostPlanFile: path.join(currentDataDir, "ai-cost-plan.json")
    };
  };
  const clone = value => structuredClone(value);
  const testCurrentInstant = testCurrentDate
    ? new Date(`${testCurrentDate}T12:00:00+08:00`).toISOString()
    : "";
  let testClockTick = 0;
  const now = () => testCurrentInstant
    ? new Date(Date.parse(testCurrentInstant) + testClockTick++).toISOString()
    : new Date().toISOString();
  const today = () => testCurrentDate || localDateKey();
  const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
  const createId = () => crypto.randomUUID();
  const normalizeStore = createStoreNormalizer({ now, today, currentTime: Date.now });
  const requestBinding = input => {
    const requestId = safeText(input?.requestId, 100);
    const targetId = safeText(input?.targetId, 100);
    return requestId && targetId
      ? {
          requestId,
          targetId,
          inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0))
        }
      : {};
  };

  async function writeJsonAtomic(file, value) {
    if (persistenceBackend === "postgres") {
      throw new Error("JSON writes are disabled in PostgreSQL runtime");
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.rename(temp, file);
    } catch (error) {
      await logEvent("system", "storage.write_failed", {
        level: "error",
        file: path.basename(file),
        error: errorMetadata(error)
      });
      throw Object.assign(new Error("数据保存失败，请稍后重试"), {
        code: "STORAGE_WRITE_FAILED"
      });
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async function readStoredJson(file, fallback) {
    if (persistenceBackend === "postgres") {
      throw new Error("JSON reads are disabled in PostgreSQL runtime");
    }
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid document");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return clone(fallback);
      await logEvent("system", "storage.read_failed", {
        level: "error",
        file: path.basename(file),
        error: errorMetadata(error)
      });
      throw Object.assign(new Error("数据无法读取，已保留原文件，请联系管理员"), {
        code: "STORAGE_READ_FAILED"
      });
    }
  }

  const postgresRuntime = persistenceBackend === "postgres"
    ? await createPostgresRuntime({
        connectionString: appConfig.databaseUrl,
        authConnectionString: appConfig.authDatabaseUrl,
        budgetConnectionString: appConfig.aiBudgetDatabaseUrl,
        authRequired,
        getAccountId: () => requestStorage.getStore()?.user?.id || (authRequired ? null : "local"),
        requireMigration: await hasJsonData(dataDir),
        onPoolError: error => void logEvent("system", "storage.connection_failed", {
          level: "error",
          error: errorMetadata(error)
        })
      })
    : null;
  if (postgresRuntime) {
    await postgresRuntime.claimApplication(() => processRef.exit(1));
    await markPostgresDirectory(dataDir);
  }

  const {
    retentionDays: aiAuditRetentionDays,
    textLimit: aiAuditTextLimit
  } = appConfig.audit;
  const {
    aiQps,
    aiConcurrency,
    segmentationQps,
    segmentationConcurrency,
    speechQps,
    speechConcurrency,
    ocrQps,
    ocrConcurrency,
    documentQps,
    documentConcurrency,
    aiDailyCalls,
    usdCny,
    aiDailyCostCny,
    attachmentBytes
  } = appConfig.limits;
  const aiRuntime = await createAiRuntime({
    dataRoot: dataDir,
    postgresRuntime,
    storagePaths,
    requestStorage,
    readStoredJson,
    writeJsonAtomic,
    auditChanges,
    logEvent,
    deepSeekApiUrl,
    aiQps,
    aiConcurrency,
    userDailyCallLimit: aiDailyCalls,
    userDailyCostLimitCny: aiDailyCostCny,
    cnyPerUsd: usdCny,
    auditTextLimit: aiAuditTextLimit,
    auditRetentionDays: aiAuditRetentionDays,
    now
  });

  const storeRepository = postgresRuntime
    ? postgresRuntime.createStoreRepository({
        normalize: normalizeStore,
        emptyDocument: emptyStore,
        onCommit: auditChanges,
        now,
        getContext: () => requestStorage.getStore()
      })
    : createJsonStoreRepository({
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
  const readStore = () => storeRepository.read();
  const updateStore = mutator => storeRepository.update(mutator);
  const discoveryService = createThoughtDiscoveryService({ repository: storeRepository, now });
  const actionsService = createActionsService({
    repository: storeRepository,
    now,
    today,
    createId
  });
  const feedbackService = createFeedbackService({
    repository: storeRepository,
    now,
    createId,
    hash
  });
  const contentRuntime = createContentRuntime({
    repository: storeRepository,
    trashRetentionDays: TRASH_RETENTION_DAYS,
    getAccountId: () => requestStorage.getStore()?.user?.id || "local",
    getCursorScope: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
    backgroundContextKey: () => requestStorage.getStore()?.dataDir || dataDir,
    workflowContextKey: () => storagePaths().storeFile,
    dispatchBackground: callback => {
      const context = { ...(requestStorage.getStore() || {}) };
      setImmediate(() => requestStorage.run(context, callback));
    },
    runDeepSeek: aiRuntime.runDeepSeek,
    now,
    today,
    currentTime: () => Date.now(),
    createId,
    hash,
    logEvent,
    debugServerUrl: appConfig.debug.serverUrl,
    debugRunId: appConfig.debug.runId,
    mediaOptions: {
      attachmentStorageConfig: appConfig.attachments,
      attachmentInventory: postgresRuntime?.attachments,
      attachmentQuotaBytes: attachmentBytes,
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
      keepsakeContextKey: () => requestStorage.getStore()?.dataDir || dataDir,
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
      listAccountIds: async () => authRequired
        ? (await accountAccess.readAuth()).users.map(user => user.id)
        : ["local"],
      runWithAccount: (accountId, operation) => {
        const user = { id: accountId };
        return requestStorage.run({
          user,
          traceId: createId(),
          dataDir: authRequired ? accountAccess.userDataDir(user) : dataDir,
          secrets: [],
          route: "background/speech-cache-sweep"
        }, operation);
      },
      speechConfig: appConfig.speech,
      visionConfig: appConfig.vision,
      segmentationConfig: appConfig.segmentation,
      speechQps,
      speechConcurrency,
      ocrQps,
      ocrConcurrency,
      documentQps,
      documentConcurrency,
      segmentationQps,
      segmentationConcurrency,
      aiBudgetRuntime: aiRuntime.aiBudgetRuntime,
      providerBudgetStage: aiRuntime.providerBudgetStage,
      conservativeDeepSeekStage: aiRuntime.conservativeDeepSeekStage,
      currentBudgetAccountId: aiRuntime.currentBudgetAccountId,
      meteredProviderCall: aiRuntime.meteredProviderCall
    }
  });
  const publicStateFromStore = createPublicStateProjection({
    getUser: () => requestStorage.getStore()?.user,
    isOwner,
    speechProvider: contentRuntime.speechProvider,
    visionProvider: contentRuntime.visionProvider,
    hash,
    now,
    today
  });

  async function ensureStore() {
    const { dataDir: currentDataDir, storeFile } = storagePaths();
    await fs.mkdir(currentDataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(currentDataDir, 0o700);
    await contentRuntime.imageAttachments.prepareDirectory();
    if (postgresRuntime) {
      await storeRepository.initialize({ allowCreate: !authRequired });
      await contentRuntime.imageAttachments.recover();
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

  return {
    appConfig,
    releaseVersion,
    paths,
    httpLimits: Object.freeze({
      standardBodyBytes: STANDARD_BODY_MAX_BYTES,
      uploadBodyBytes: ATTACHMENT_UPLOAD_BODY_MAX_BYTES,
      uploadImageBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES
    }),
    clock: { now, today },
    identifiers: { createId, hash, requestBinding },
    observability: { requestStorage, logEvent, auditChanges, runtimeMemorySampler },
    persistence: {
      postgresRuntime,
      storeRepository,
      storagePaths,
      normalizeStore,
      readStoredJson,
      writeJsonAtomic,
      readStore,
      updateStore,
      ensureStore
    },
    aiRuntime,
    contentRuntime,
    domainServices: { discoveryService, actionsService, feedbackService },
    publicStateFromStore
  };
}
