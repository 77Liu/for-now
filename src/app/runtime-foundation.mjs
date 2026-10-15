import { createAccountRuntimeState } from "../../.build/typescript/backend/app/account-runtime-state.mjs";
import { normalizePersistedDocument } from "../shared/persistence/index.mjs";
import { normalizeLlmSettings, normalizeAiUsage, llmSettingsForScene } from "../modules/ai/index.mjs";
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
import { DEFAULT_RECORD_TIMEZONE } from "../modules/record-compressions/index.mjs";
import { installPromptCatalog } from "../shared/prompts/index.mjs";
import {
  createJsonStoreRepository,
  createBusinessId,
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
  accountAccess,
  startupGate = null
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
    requestedVersion: appConfig.promptCatalogVersion,
    requiredCapabilities: ["structuredWorkingContext", "verifiedAnswerCitations", "sevenDayTrendContext"]
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
  let contentRuntime = null;
  const accountRuntime = createAccountRuntimeState({
    config: appConfig.accountRecovery,
    getContext: () => requestStorage.getStore(),
    defaultAccount: "local",
    getAccountKey: () => appConfig.localTestMode ? "local" : requestStorage.getStore()?.user?.id || "local",
    onUnavailable: () => contentRuntime?.backgroundAi?.abortAll?.(),
    onDispatchError: error => { void logEvent("system", "account.dispatch_failed", { level: "warn", error: errorMetadata(error) }).catch(() => {}); },
    onTransition: state => {
      if (state.status === "quarantined") contentRuntime?.backgroundAi?.abortCurrentAccount?.();
      void logEvent("system", "account.recovery_state", {
      level: state.status === "quarantined" ? "warn" : "info",
      accountId: state.accountId, status: state.status, phase: state.phase, epoch: state.epoch, reasonCode: state.reasonCode
    }).catch(() => {}); }
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

  const isAccountFile = file => ["store.json", "llm-settings.json", "ai-usage.json", "ai-cost-plan.json"].includes(path.basename(file));
  const accountDataError = (reasonCode, cause) => Object.assign(new Error("账户持久化数据校验失败，原数据已保留"), {
    statusCode: 503, code: "ACCOUNT_DATA_INVALID", recoveryScope: "account", reasonCode,
    accountId: accountRuntime.currentAccountId(), cause
  });
  const assertStorageAccess = file => { if (isAccountFile(file)) accountRuntime.authorize(); };
  const validateShape = (name, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw accountDataError("ACCOUNT_DOCUMENT_INVALID");
    if (value.version != null && (!Number.isSafeInteger(Number(value.version)) || Number(value.version) < 1)) throw accountDataError("ACCOUNT_DOCUMENT_VERSION_INVALID");
    if (name === "store.json") {
      for (const [key, fallback] of Object.entries(emptyStore)) {
        if (Array.isArray(fallback) && Object.hasOwn(value, key) && !Array.isArray(value[key])) throw accountDataError("ACCOUNT_COLLECTION_INVALID");
      }
    }
    if (name === "ai-usage.json" && Object.hasOwn(value, "entries") && !Array.isArray(value.entries)) throw accountDataError("ACCOUNT_USAGE_INVALID");
    if (name === "llm-settings.json") {
      for (const key of ["profiles", "scenarios", "sceneEfforts"]) {
        if (Object.hasOwn(value, key) && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) throw accountDataError("ACCOUNT_SETTINGS_INVALID");
      }
    }
    return value;
  };

  // OS文件系统故障不能仅包装为单次请求失败；无账户局部证据时停止准入并排空。
  // 仅识别真实syscall错误，普通业务校验和4xx不会被升级。
  const reportStorageIoFailure = error => {
    const ioFailure = accountRuntime.enabled && /^E[A-Z0-9]+$/.test(error.code || "")
      && typeof error.syscall === "string" && !(error.statusCode >= 400 && error.statusCode < 500);
    if (ioFailure) accountRuntime.failGlobal(error);
    return ioFailure;
  };

  async function writeJsonAtomic(file, value) {
    if (persistenceBackend === "postgres") {
      throw new Error("JSON writes are disabled in PostgreSQL runtime");
    }
    assertStorageAccess(file);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      assertStorageAccess(file);
      await fs.rename(temp, file);
    } catch (error) {
      if (String(error.code || "").startsWith("ACCOUNT_")) throw error;
      const sharedIoFailure = reportStorageIoFailure(error);
      await logEvent("system", "storage.write_failed", {
        level: "error",
        file: path.basename(file),
        error: errorMetadata(error)
      });
      throw Object.assign(new Error("数据保存失败，请稍后重试"), {
        code: "STORAGE_WRITE_FAILED", ...(sharedIoFailure ? { statusCode: 503 } : {})
      });
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async function readStoredJson(file, fallback) {
    if (persistenceBackend === "postgres") {
      throw new Error("JSON reads are disabled in PostgreSQL runtime");
    }
    assertStorageAccess(file);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (accountRuntime.enabled && isAccountFile(file)) validateShape(path.basename(file), value);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid document");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") {
        if (accountRuntime.enabled && isAccountFile(file) && path.basename(file) !== "ai-cost-plan.json" && !accountRuntime.canInitialize()) {
          const failure = accountDataError("ACCOUNT_DOCUMENT_MISSING", error); accountRuntime.noteFailure(failure); throw failure;
        }
        return clone(fallback);
      }
      if (accountRuntime.enabled && isAccountFile(file) && (error instanceof SyntaxError || error.recoveryScope === "account")) {
        const failure = error.recoveryScope === "account" ? error : accountDataError("ACCOUNT_JSON_INVALID", error);
        accountRuntime.noteFailure(failure); throw failure;
      }
      const sharedIoFailure = reportStorageIoFailure(error);
      await logEvent("system", "storage.read_failed", {
        level: "error",
        file: path.basename(file),
        error: errorMetadata(error)
      });
      throw Object.assign(new Error("数据无法读取，已保留原文件，请联系管理员"), {
        code: "STORAGE_READ_FAILED", ...(sharedIoFailure ? { statusCode: 503 } : {})
      });
    }
  }

  const postgresRuntime = persistenceBackend === "postgres"
    ? await createPostgresRuntime({
        connectionString: appConfig.databaseUrl,
        authConnectionString: appConfig.authDatabaseUrl,
        budgetConnectionString: appConfig.aiBudgetDatabaseUrl,
        authRequired,
        authorizeAccount: () => accountRuntime.authorize(),
        assertAccountCommit: (before, after, document) => accountRuntime.assertCommit(before, after, document),
        onAccountFailure: error => {
          accountRuntime.noteFailure(error);
          // 只升级共享连接/Schema/权限故障；唯一约束、业务检查与事务竞争保留原重试/冲突语义。
          const sharedCodes = ["42P01", "42703", "42883", "42501", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND"];
          if (/^(08|28|3D|3F|53|58|XX)/.test(error.code || "") || sharedCodes.includes(error.code)) {
            error.statusCode = 503;
            accountRuntime.failGlobal(error);
          }
        },
        getAccountId: () => requestStorage.getStore()?.user?.id || (authRequired ? null : "local"),
        requireMigration: await hasJsonData(dataDir),
        onPoolError: error => {
          accountRuntime.failGlobal(error);
          void logEvent("system", "storage.connection_failed", { level: "error", error: errorMetadata(error) });
        }
      })
    : null;
  try {
  if (postgresRuntime) {
    await postgresRuntime.claimApplication(() => {
      if (accountRuntime.enabled) accountRuntime.failGlobal(Object.assign(new Error("数据库运行租约失效"), { code: "DATABASE_LEASE_LOST" }));
      else processRef.exit(1);
    });
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
    accountRuntime,
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
    recordCompressionDailyBudgetCny: appConfig.recordCompressionDailyBudgetCny,
    recordCompressionDailyInvocationLimit: appConfig.recordCompressionDailyInvocationLimit,
    recordCompressionPerCallBudgetCny: appConfig.recordCompressionPerCallBudgetCny,
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
        getContext: () => requestStorage.getStore(),
        authorize: () => accountRuntime.authorize(),
        assertCommit: (before, after) => accountRuntime.assertCommit(before, after)
      });
  const readStore = () => storeRepository.read();
  const updateStore = mutator => storeRepository.update(mutator);
  const discoveryService = createThoughtDiscoveryService({ repository: storeRepository, now });
  const actionsService = createActionsService({
    repository: storeRepository,
    now,
    today,
    createId: createBusinessId
  });
  const feedbackService = createFeedbackService({
    repository: storeRepository,
    now,
    createId: createBusinessId,
    hash
  });
  const importanceSnapshots = new WeakMap();
  const localImportanceScope = {};
  const importanceScope = () => requestStorage.getStore() || localImportanceScope;
  const refreshImportanceModelChoice = async () => {
    const scope = importanceScope();
    importanceSnapshots.delete(scope);
    const settings = llmSettingsForScene(await aiRuntime.readModelRuntimeSettings(), "importanceScoring");
    const snapshot = { model: settings.model, effort: settings.effort,
      source: "effective-model-runtime-reader", accountId: requestStorage.getStore()?.user?.id || "local" };
    importanceSnapshots.set(scope, snapshot);
    return snapshot;
  };
  contentRuntime = createContentRuntime({
    createBusinessId,
    repository: storeRepository,
    trashRetentionDays: TRASH_RETENTION_DAYS,
    getAccountId: () => requestStorage.getStore()?.user?.id || "local",
    getTimezone: () => requestStorage.getStore()?.user?.recordTimezone || DEFAULT_RECORD_TIMEZONE,
    getCursorScope: () => safeText(requestStorage.getStore()?.user?.id, 100) || "local",
    backgroundContextKey: () => requestStorage.getStore()?.dataDir || dataDir,
    workflowContextKey: () => storagePaths().storeFile,
    accountRuntime,
    dispatchBackground: callback => accountRuntime.dispatch(callback, callback => {
      if (startupGate) return startupGate.holdDispatch("background", callback);
      const context = { ...(requestStorage.getStore() || {}) };
      setImmediate(() => requestStorage.run(context, callback));
    }),
    runDeepSeek: aiRuntime.runDeepSeek,
    getImportanceModelChoice: refreshImportanceModelChoice,
    getImportanceModelSnapshot: () => {
      const snapshot = importanceSnapshots.get(importanceScope());
      return snapshot?.accountId === (requestStorage.getStore()?.user?.id || "local") ? snapshot : null;
    },
    readAiUsage: aiRuntime.readAiUsage,
    recordCompressionDailyBudgetCny: appConfig.recordCompressionDailyBudgetCny,
    recordCompressionPerCallBudgetCny: appConfig.recordCompressionPerCallBudgetCny,
    recordCompressionMaxBackfillDatesPerScan: appConfig.recordCompressionMaxBackfillDatesPerScan,
    recordCompressionStartDate: appConfig.recordCompressionStartDate,
    now,
    today,
    currentTime: () => Date.now(),
    createId,
    hash,
    logEvent,
    debugServerUrl: appConfig.debug.serverUrl,
    debugRunId: appConfig.debug.runId,
    effectObserver: startupGate?.observeEffect || null,
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
      dispatchCleanup: (callback, delay) => accountRuntime.dispatch(callback, callback => {
        if (startupGate) return startupGate.holdDispatch("cleanup", callback);
        const context = { ...(requestStorage.getStore() || {}) };
        const timer = setTimeout(() => requestStorage.run(context, callback), delay);
        timer.unref();
        return timer;
      }),
      dispatchKeepsake: callback => accountRuntime.dispatch(callback, callback => {
        if (startupGate) return startupGate.holdDispatch("keepsake", callback);
        const context = { ...(requestStorage.getStore() || {}) };
        setImmediate(() => requestStorage.run(context, callback));
      }),
      listAccountIds: async () => authRequired
        ? (await accountAccess.readAuth()).users.filter(user => !accountRuntime.enabled || accountRuntime.state(user.id)?.status === "ready").map(user => user.id)
        : ["local"],
      runWithAccount: (accountId, operation) => {
        accountRuntime.assertReady(accountId);
        const user = { id: accountId };
        return requestStorage.run({
          user,
          traceId: createId(),
          dataDir: authRequired ? accountAccess.userDataDir(user) : dataDir,
          secrets: [],
          route: "background/speech-cache-sweep"
        }, () => accountRuntime.enabled ? accountRuntime.withOperation(operation) : operation());
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

  async function validateCurrentStorage({ allowCreate = false } = {}) {
    if (!accountRuntime.enabled) return;
    const { storeFile, llmSettingsFile, aiUsageFile, logsDir } = storagePaths();
    if (allowCreate && !postgresRuntime && !appConfig.localTestMode) {
      const present = await Promise.all([storeFile, llmSettingsFile, aiUsageFile].map(file => fs.stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })));
      allowCreate = !present.some(Boolean);
    }
    const read = async (file, fallback, name) => {
      let value;
      if (postgresRuntime) {
        try { value = name === "store" ? await storeRepository.validate({ allowCreate }) : await postgresRuntime.documents.read(name, null); }
        catch (error) { if (allowCreate && error.reasonCode === "ACCOUNT_MIGRATION_MISSING") return null; throw error; }
      } else {
        try { value = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) {
          if (error.code === "ENOENT" && allowCreate) return null;
          if (error.code === "ENOENT" || error instanceof SyntaxError) throw accountDataError(error.code === "ENOENT" ? "ACCOUNT_DOCUMENT_MISSING" : "ACCOUNT_JSON_INVALID", error);
          throw error;
        }
      }
      if (value == null && allowCreate) return null;
      validateShape(path.basename(file), value);
      try { normalizePersistedDocument(value, fallback); }
      catch (error) { throw accountDataError("ACCOUNT_NORMALIZATION_LOSS", error); }
      return value;
    };
    await read(storeFile, normalizeStore, "store");
    await read(llmSettingsFile, normalizeLlmSettings, "settings");
    await read(aiUsageFile, normalizeAiUsage, "usage");
    const names = await fs.readdir(logsDir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names.filter(name => /^ai-audit-.*\.ndjson$/.test(name))) {
      const content = await fs.readFile(path.join(logsDir, name), "utf8");
      for (const line of content.split("\n").filter(line => line.trim())) {
        try { const value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); }
        catch (error) { throw accountDataError("ACCOUNT_AUDIT_INVALID", error); }
      }
    }
    return { allowCreate };
  }

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
    accountRuntime,
    releaseVersion,
    paths,
    httpLimits: Object.freeze({
      standardBodyBytes: STANDARD_BODY_MAX_BYTES,
      uploadBodyBytes: ATTACHMENT_UPLOAD_BODY_MAX_BYTES,
      uploadImageBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES
    }),
    clock: { now, today },
    identifiers: { createId, createBusinessId, hash, requestBinding },
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
      ensureStore,
      validateCurrentStorage
    },
    aiRuntime,
    contentRuntime,
    domainServices: { discoveryService, actionsService, feedbackService },
    publicStateFromStore
  };
  } catch (error) {
    accountRuntime.failGlobal();
    await postgresRuntime?.close().catch(() => {});
    throw error;
  }
}
