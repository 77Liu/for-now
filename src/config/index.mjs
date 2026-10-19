import { THOUGHT_PAGING } from "../../.build/typescript/backend/shared/thought-pagination/index.mjs";
import path from "node:path";
import { readInternalBudgets } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import { RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN, RECORD_SLOT_START_DATE } from "../modules/record-compressions/index.mjs";

export const RECORD_COMPRESSION_ACCOUNT_DAILY_INVOCATION_LIMIT = 2;
export const RECORD_COMPRESSION_MAX_DAILY_BUDGET_CNY = 4;
export const RECORD_COMPRESSION_MAX_PER_CALL_BUDGET_CNY = 1;
export const RECORD_COMPRESSION_MAX_DAILY_INVOCATION_LIMIT = 16;

export function recordCompressionAccountQueueAllowance({
  dailyLimit = RECORD_COMPRESSION_ACCOUNT_DAILY_INVOCATION_LIMIT,
  knownCalls = 0,
  reservedCalls = 0
} = {}) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) return 0;
  const normalizedCalls = value => Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : dailyLimit;
  return Math.max(0, dailyLimit - normalizedCalls(knownCalls) - normalizedCalls(reservedCalls));
}

export function recordCompressionSlotQueueAllowance(slot, availableCalls) {
  if (!Number.isSafeInteger(availableCalls) || availableCalls < 0) return 0;
  return slot === "morning" ? Math.max(0, availableCalls - 1) : availableCalls;
}

/** 解析文本AI队列技术上限；默认值仅维护于本配置入口，重启生效。
 * @since unreleased
 */
export function loadAiQueueConfig(env = process.env) {
  const defaults = { maxOutstanding: 64, maxOutstandingPerAccount: 8, maxPendingPerGate: 64, maxQueueWaitMs: 30000, overloadRetryAfterMs: 5000 };
  if (env.AI_QUEUE_ENABLED !== undefined && !["0", "1"].includes(env.AI_QUEUE_ENABLED)) throw new Error("AI_QUEUE_ENABLED must be 0 or 1");
  const values = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const name = `AI_QUEUE_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return [key, value];
  }));
  if (values.maxOutstandingPerAccount > values.maxOutstanding) throw new Error("AI_QUEUE_MAX_OUTSTANDING_PER_ACCOUNT must not exceed global outstanding");
  return Object.freeze({ enabled: env.AI_QUEUE_ENABLED === "1", ...values });
}

/** 解析PostgreSQL同步窄读灰度；空白名单保持全读，JSON不采用SQL窄读。
 * @since unreleased
 */
export function loadPgIoConfig(env = process.env) {
  const syncReadMode = env.PG_SYNC_READ_MODE || "legacy";
  if (!["legacy", "metadata"].includes(syncReadMode)) throw new Error("PG_SYNC_READ_MODE must be legacy or metadata");
  const accountAllowlist = String(env.PG_SYNC_ACCOUNT_ALLOWLIST || "").split(",").map(value => value.trim()).filter(Boolean);
  if (accountAllowlist.includes("*") && accountAllowlist.length !== 1) throw new Error("PG_SYNC_ACCOUNT_ALLOWLIST wildcard must stand alone");
  return Object.freeze({ syncReadMode, accountAllowlist: Object.freeze(accountAllowlist) });
}

const RECORD_COMMANDS = new Set([
  "notification.read",
  "notification.readAll",
  "task.status",
  "thought.update",
  "thought.delete",
  "thought.create",
  "thought.aiWriteback"
]);

/** 解析记录级命令白名单；空值保持旧路径，未知命令拒绝启动且运行中不回退。
 * @since unreleased
 */
export function loadRecordCommandConfig(env = process.env) {
  const allowlist = String(env.RECORD_COMMAND_ALLOWLIST || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (new Set(allowlist).size !== allowlist.length) {
    throw new Error("RECORD_COMMAND_ALLOWLIST must not contain duplicates");
  }
  const unknown = allowlist.find(command => !RECORD_COMMANDS.has(command));
  if (unknown) throw new Error(`Unknown RECORD_COMMAND_ALLOWLIST command: ${unknown}`);
  const commands = Object.freeze([...allowlist]);
  return Object.freeze({
    allowlist: commands,
    enabled: command => commands.includes(command)
  });
}

export function loadAttachmentConfig(env = process.env) {
  return Object.freeze({
    mode: env.ATTACHMENT_STORAGE || "local",
    bucket: env.OSS_ATTACHMENT_BUCKET || "",
    prefix: env.OSS_ATTACHMENT_PREFIX || "for-now-attachments",
    endpoint: env.OSS_ENDPOINT || "",
    region: env.OSS_REGION || "cn-beijing",
    roleName: env.ALIBABA_CLOUD_ECS_RAM_ROLE || "",
    disableIMDSv1: String(env.ALIBABA_CLOUD_IMDSV1_DISABLED || "true").toLowerCase() !== "false",
    mockDir: env.OSS_MOCK_DIR || "",
    testMode: env.NODE_ENV === "test",
    delivery: Object.freeze({
      mode: env.MEDIA_DELIVERY_MODE || "proxy",
      bucket: env.MEDIA_DELIVERY_BUCKET || "",
      endpoint: env.MEDIA_DELIVERY_OSS_ENDPOINT || "",
      region: env.OSS_REGION || "cn-beijing",
      cdnOrigin: env.MEDIA_CDN_ORIGIN || "",
      cdnKey: env.MEDIA_CDN_AUTH_KEY || ""
    })
  });
}

/**
 * 解析认证准入参数并返回不可变启动配置；默认值与环境覆盖仅由此处维护。
 * 非正整数配置直接拒绝启动，避免以无效参数绕过限流。
 * @since unreleased
 */
export function loadAuthAdmissionConfig(env = process.env) {
  const defaults = {
    globalRatePerSecond: 8, globalBurst: 16, ipRatePerMinute: 30, ipBurst: 10,
    accountFailures: 8, failureWindowMs: 900000, kdfConcurrency: 2, kdfMaxPending: 32,
    kdfQueueTimeoutMs: 1000, requestTimeoutMs: 5000, failureDelayMs: 250,
    maxCounterKeys: 10000, counterTtlMs: 900000
  };
  return Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const name = `AUTH_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    const raw = env[name];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return [key, value];
  })));
}

/**
 * Parses the authentication storage mode without enabling request-level fallback.
 * @since unreleased
 */
export function loadAuthStorageConfig(env = process.env) {
  const queryMode = String(env.AUTH_QUERY_MODE || "document").trim();
  if (!["document", "row"].includes(queryMode)) {
    throw new Error("AUTH_QUERY_MODE must be document or row");
  }
  return Object.freeze({ queryMode });
}

/** 解析启动时账户恢复参数；隔离开关不允许在运行中旁路资格。
 * @since unreleased
 */
export function loadAccountRecoveryConfig(env = process.env) {
  const defaults = { concurrency: 1, accountDeadlineMs: 30000, retryCooldownMs: 60000, dependencyProbeMs: 5000 };
  if (env.ACCOUNT_RECOVERY_ENABLED !== undefined && !["0", "1"].includes(env.ACCOUNT_RECOVERY_ENABLED)) throw new Error("ACCOUNT_RECOVERY_ENABLED must be 0 or 1");
  return Object.freeze({ enabled: env.ACCOUNT_RECOVERY_ENABLED === "1", ...Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const name = `ACCOUNT_RECOVERY_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return [key, value];
  })) });
}

export function loadAppConfig({ rootDir, env = process.env }) {
  if (env.SYNC_ACCOUNT_WAKE_ENABLED !== undefined && !["0", "1"].includes(env.SYNC_ACCOUNT_WAKE_ENABLED)) throw new Error("SYNC_ACCOUNT_WAKE_ENABLED must be 0 or 1");
  const persistenceBackend = env.PERSISTENCE_BACKEND || "json";
  const upstreamOrigin = String(env.UPSTREAM_ORIGIN || "").replace(/\/+$/, "");
  const testCurrentDate = env.NODE_ENV === "test" ? String(env.TEST_CURRENT_DATE || "").trim() : "";
  if (testCurrentDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(testCurrentDate);
    const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!date || date.toISOString().slice(0, 10) !== testCurrentDate) throw new Error("TEST_CURRENT_DATE must be a valid YYYY-MM-DD date");
  }
  if (!["json", "postgres"].includes(persistenceBackend)) throw new Error("PERSISTENCE_BACKEND must be json or postgres");
  if (env.AI_AUDIT_DB_ENABLED !== undefined && !["0", "1"].includes(env.AI_AUDIT_DB_ENABLED)) {
    throw new Error("AI_AUDIT_DB_ENABLED must be 0 or 1");
  }
  const aiAuditDatabaseEnabled = env.AI_AUDIT_DB_ENABLED === "1";
  if (aiAuditDatabaseEnabled && persistenceBackend !== "postgres") {
    throw new Error("AI_AUDIT_DB_ENABLED=1 requires PERSISTENCE_BACKEND=postgres");
  }
  if (persistenceBackend === "postgres" && (env.LOCAL_TEST_MODE === "1" || upstreamOrigin)) {
    throw new Error("PostgreSQL runtime requires a standalone data source; local-test/upstream proxy is unsupported");
  }
  const recordCommands = loadRecordCommandConfig(env);
  if (recordCommands.allowlist.length && persistenceBackend !== "postgres") {
    throw new Error("RECORD_COMMAND_ALLOWLIST requires PERSISTENCE_BACKEND=postgres");
  }
  const inviteCodeHash = String(env.INVITE_CODE_HASH || "").toLowerCase();
  const authRequired = env.AUTH_REQUIRED === "1" || Boolean(inviteCodeHash);
  if (authRequired && !/^[a-f0-9]{64}$/.test(inviteCodeHash)) throw new Error("AUTH_REQUIRED=1 requires a 64-character SHA-256 INVITE_CODE_HASH");
  const localTestMode = env.LOCAL_TEST_MODE === "1";
  if (localTestMode && env.NODE_ENV === "production") throw new Error("LOCAL_TEST_MODE cannot run with NODE_ENV=production");
  if (localTestMode && authRequired) throw new Error("LOCAL_TEST_MODE uses upstream authentication and cannot enable local AUTH_REQUIRED");
  const auth = Object.freeze({
    ...loadAuthStorageConfig(env),
    required: authRequired
  });
  if (auth.queryMode === "row" && persistenceBackend !== "postgres") {
    throw new Error("AUTH_QUERY_MODE=row requires PERSISTENCE_BACKEND=postgres");
  }
  if (localTestMode && auth.queryMode !== "document") {
    throw new Error("LOCAL_TEST_MODE does not use PostgreSQL row authentication");
  }
  const attachments = loadAttachmentConfig({
    ...env,
    OSS_MOCK_DIR: env.OSS_MOCK_DIR ? path.resolve(rootDir, env.OSS_MOCK_DIR) : ""
  });
  if (localTestMode && attachments.mode === "oss") throw new Error("LOCAL_TEST_MODE cannot use OSS attachment storage");
  if (localTestMode && attachments.delivery.mode !== "proxy") throw new Error("LOCAL_TEST_MODE cannot sign cloud media URLs");
  if (attachments.delivery.mode !== "proxy" && attachments.mode !== "oss" && env.NODE_ENV !== "test") {
    throw new Error("Signed media delivery requires OSS source storage");
  }
  const canonicalProduction = env.NODE_ENV === "production" && !localTestMode && !upstreamOrigin;
  const speechCacheSweepEnabled = canonicalProduction
    && String(env.SPEECH_CACHE_SWEEP_ENABLED ?? "1").trim() !== "0";
  const recordCompressionDailyBudgetCny = Number(env.RECORD_COMPRESSION_DAILY_BUDGET_CNY);
  const recordCompressionPerCallBudgetCny = Number(env.RECORD_COMPRESSION_PER_CALL_BUDGET_CNY);
  const invocationLimitText = String(env.RECORD_COMPRESSION_DAILY_INVOCATION_LIMIT ?? "").trim();
  const configuredInvocationLimit = Number(invocationLimitText);
  const recordCompressionEnabled = env.RECORD_COMPRESSION_ENABLED === "1"
    && canonicalProduction
    && !localTestMode
    && Number.isFinite(recordCompressionDailyBudgetCny)
    && recordCompressionDailyBudgetCny > 0
    && recordCompressionDailyBudgetCny <= RECORD_COMPRESSION_MAX_DAILY_BUDGET_CNY
    && Number.isFinite(recordCompressionPerCallBudgetCny)
    && recordCompressionPerCallBudgetCny > 0
    && recordCompressionPerCallBudgetCny <= RECORD_COMPRESSION_MAX_PER_CALL_BUDGET_CNY
    && recordCompressionPerCallBudgetCny <= recordCompressionDailyBudgetCny
    && /^[1-9]\d*$/.test(invocationLimitText)
    && Number.isSafeInteger(configuredInvocationLimit)
    && configuredInvocationLimit <= RECORD_COMPRESSION_MAX_DAILY_INVOCATION_LIMIT;
  const configuredBackfillDates = Number(env.RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN);
  const recordCompressionNotificationsEnabled = env.RECORD_COMPRESSION_NOTIFICATIONS_ENABLED === "1"
    && canonicalProduction
    && Boolean(String(env.FEISHU_ALERT_WEBHOOK || "").trim())
    && Boolean(String(env.FEISHU_ALERT_SECRET || "").trim());
  const platformServiceTokenHash = String(env.PLATFORM_SERVICE_TOKEN_HASH || "").toLowerCase();
  if (platformServiceTokenHash && !/^[a-f0-9]{64}$/.test(platformServiceTokenHash)) {
    throw new Error("PLATFORM_SERVICE_TOKEN_HASH must be a 64-character SHA-256 digest");
  }
  const usdCny = Math.max(0.01, Number(env.AI_COST_CNY_PER_USD) || 7.2);
  const configuredCostLimitCny = String(env.AI_USER_DAILY_COST_LIMIT_CNY ?? "").trim();
  const legacyCostLimitUsd = String(env.AI_USER_DAILY_COST_LIMIT_USD ?? "").trim();
  const configuredCostLimit = Number(configuredCostLimitCny);
  const legacyCostLimit = Number(legacyCostLimitUsd);
  let aiDailyCostCny = 14.4;
  if (configuredCostLimitCny && Number.isFinite(configuredCostLimit)) {
    aiDailyCostCny = configuredCostLimit === 0 ? null : Math.max(0.01, configuredCostLimit);
  } else if (legacyCostLimitUsd && Number.isFinite(legacyCostLimit)) {
    const converted = legacyCostLimit * usdCny;
    aiDailyCostCny = converted === 0 ? null : Math.max(0.01, converted);
  }
  return Object.freeze({
    internalBudgets: readInternalBudgets(env),
    authAdmission: loadAuthAdmissionConfig(env),
    accountRecovery: loadAccountRecoveryConfig(env),
    aiQueue: loadAiQueueConfig(env),
    pgIo: loadPgIoConfig(env),
    recordCommands,
    syncAccountWakeEnabled: env.SYNC_ACCOUNT_WAKE_ENABLED === "1",
    dataDir: path.resolve(rootDir, env.DATA_DIR || "data"),
    port: Number(env.PORT || 4173),
    version: env.APP_VERSION || "development",
    promptCatalogVersion: String(env.PROMPT_CATALOG_VERSION || "").trim(),
    basePath: `/${String(env.APP_BASE_PATH || "").replace(/^\/+|\/+$/g, "")}`,
    upstreamOrigin,
    persistenceBackend,
    databaseUrl: env.DATABASE_URL,
    authDatabaseUrl: env.AUTH_DATABASE_URL,
    aiBudgetDatabaseUrl: env.AI_BUDGET_DATABASE_URL,
    inviteCodeHash, authRequired, auth,
    cookieSecure: env.COOKIE_SECURE === "1",
    localTestMode,
    localTestMainUserId: String(env.LOCAL_TEST_MAIN_USER_ID || "").trim(),
    localTestResetOnStart: localTestMode && env.LOCAL_TEST_RESET_ON_START === "1",
    testCurrentDate,
    periodicAnalysisEnabled: env.PERIODIC_ANALYSIS_ENABLED === "1",
    recordCompressionEnabled,
    recordCompressionNotificationsEnabled,
    feishuAlertWebhook: String(env.FEISHU_ALERT_WEBHOOK || "").trim(),
    feishuAlertSecret: String(env.FEISHU_ALERT_SECRET || ""),
    recordCompressionDailyBudgetCny: recordCompressionEnabled ? recordCompressionDailyBudgetCny : 0,
    recordCompressionPerCallBudgetCny: recordCompressionEnabled ? recordCompressionPerCallBudgetCny : 0,
    recordCompressionDailyInvocationLimit: recordCompressionEnabled ? configuredInvocationLimit : 0,
    recordCompressionAccountDailyInvocationLimit: RECORD_COMPRESSION_ACCOUNT_DAILY_INVOCATION_LIMIT,
    recordCompressionStartDate: String(env.RECORD_COMPRESSION_START_DATE ?? "").trim() || RECORD_SLOT_START_DATE,
    recordCompressionMaxBackfillDatesPerScan: Math.max(
      0,
      Math.min(
        RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN,
        Math.floor(Number.isFinite(configuredBackfillDates) ? configuredBackfillDates : 1)
      )
    ),
    speechCacheSweepEnabled,
    runtimeMemorySampleIntervalMs: Math.max(50, Math.min(3_600_000, Number(env.RUNTIME_MEMORY_SAMPLE_INTERVAL_MS) || 60_000)),
    deepSeekApiUrl: env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    debug: Object.freeze({
      serverUrl: String(env.DEBUG_SERVER_URL || "http://127.0.0.1:17778/event").trim(),
      runId: String(env.DEBUG_RUN_ID || "pre-fix").trim().slice(0, 100) || "pre-fix"
    }),
    attachments,
    features: Object.freeze({
      aiReasoningUi: env.AI_REASONING_UI_ENABLED === "1",
      thoughtPaging: Object.freeze({ ...THOUGHT_PAGING, enabled: env.THOUGHT_PAGING_ENABLED === "1" }),
      incrementalSync: String(env.INCREMENTAL_SYNC_ENABLED ?? "1") !== "0"
    }),
    platform: Object.freeze({
      serviceTokenHash: platformServiceTokenHash,
      backupStatusFile: path.resolve(rootDir, env.BACKUP_STATUS_FILE || "/var/lib/for-now-monitor/last-backup-success")
    }),
    audit: Object.freeze({
      databaseEnabled: aiAuditDatabaseEnabled,
      retentionDays: Math.max(1, Math.min(3650, Number(env.AI_AUDIT_RETENTION_DAYS) || 30)),
      textLimit: Math.max(10000, Math.min(5_000_000, Number(env.AI_AUDIT_TEXT_LIMIT) || 1_000_000))
    }),
    limits: Object.freeze({
      aiQps: Math.max(1, Math.min(2500, Number(env.AI_GLOBAL_QPS) || 20)),
      aiConcurrency: Math.max(1, Math.min(100, Number(env.AI_GLOBAL_CONCURRENCY) || 20)),
      segmentationQps: Math.max(1, Math.min(100, Number(env.SEGMENTATION_GLOBAL_QPS) || 5)),
      segmentationConcurrency: Math.max(1, Math.min(20, Number(env.SEGMENTATION_GLOBAL_CONCURRENCY) || 5)),
      speechQps: Math.max(1, Math.min(100, Number(env.SPEECH_GLOBAL_QPS) || 5)),
      speechConcurrency: Math.max(1, Math.min(20, Number(env.SPEECH_GLOBAL_CONCURRENCY) || 5)),
      ocrQps: Math.max(1, Math.min(10, Number(env.OCR_GLOBAL_QPS) || 10)),
      ocrConcurrency: Math.max(1, Math.min(10, Number(env.OCR_GLOBAL_CONCURRENCY) || 10)),
      documentQps: Math.max(1, Math.min(2, Number(env.DOCUMENT_PARSE_GLOBAL_QPS) || 2)),
      documentConcurrency: Math.max(1, Math.min(2, Number(env.DOCUMENT_PARSE_GLOBAL_CONCURRENCY) || 2)),
      aiDailyCalls: Math.max(1, Math.round(Number(env.AI_USER_DAILY_CALL_LIMIT) || 200)),
      usdCny,
      aiDailyCostCny,
      attachmentBytes: Math.max(env.NODE_ENV === "test" ? 1 : 1024 * 1024, Math.round(Number(env.ATTACHMENT_USER_QUOTA_BYTES) || 1024 * 1024 * 1024))
    }),
    segmentation: Object.freeze({
      roleName: String(env.ALIBABA_CLOUD_ECS_RAM_ROLE ?? "").trim().slice(0, 128),
      disableIMDSv1: attachments.disableIMDSv1,
      mockResult: env.NODE_ENV === "test" ? String(env.KEEPSAKE_SEGMENT_MOCK_RESULT ?? "").trim().slice(0, 48 * 1024 * 1024) : "",
      mockDelayMs: Math.max(0, Math.min(5000, Number(env.KEEPSAKE_SEGMENT_MOCK_DELAY_MS) || 0))
    }),
    speech: Object.freeze({
      apiKey: String(env.VOLCENGINE_SPEECH_API_KEY || "").trim().slice(0, 1000),
      projectName: String(env.VOLCENGINE_SPEECH_PROJECT_NAME || "default").trim().slice(0, 100) || "default",
      defaultVoice: String(env.VOLCENGINE_TTS_DEFAULT_VOICE || "zh_male_shaonianzixin_uranus_bigtts").trim().slice(0, 160),
      ttsEndpoint: String(env.VOLCENGINE_TTS_ENDPOINT || "https://openspeech.bytedance.com/api/v3/tts/unidirectional").trim(),
      ttsSubmitEndpoint: String(env.VOLCENGINE_TTS_SUBMIT_ENDPOINT || "https://openspeech.bytedance.com/api/v3/tts/submit").trim(),
      ttsQueryEndpoint: String(env.VOLCENGINE_TTS_QUERY_ENDPOINT || "https://openspeech.bytedance.com/api/v3/tts/query").trim(),
      asrMode: String(env.VOLCENGINE_ASR_MODE || "file").trim(),
      asrFileEndpoint: String(env.VOLCENGINE_ASR_FILE_ENDPOINT || "").trim() || undefined,
      asrStreamEndpoint: String(env.VOLCENGINE_ASR_STREAM_ENDPOINT || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async").trim(),
      asrSubmitEndpoint: String(env.VOLCENGINE_ASR_SUBMIT_ENDPOINT || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit").trim(),
      asrQueryEndpoint: String(env.VOLCENGINE_ASR_QUERY_ENDPOINT || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query").trim()
    }),
    vision: Object.freeze({
      accessKeyId: String(env.VOLCENGINE_ACCESS_KEY_ID || "").trim().slice(0, 1000),
      secretAccessKey: String(env.VOLCENGINE_SECRET_ACCESS_KEY || "").trim().slice(0, 1000),
      sessionToken: String(env.VOLCENGINE_SESSION_TOKEN || "").trim().slice(0, 4000),
      endpoint: String(env.VOLCENGINE_VISUAL_ENDPOINT || "https://visual.volcengineapi.com").trim(),
      region: String(env.VOLCENGINE_VISUAL_REGION || "cn-north-1").trim().slice(0, 100) || "cn-north-1"
    })
  });
}
