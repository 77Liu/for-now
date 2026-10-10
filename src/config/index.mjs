import path from "node:path";

export const RECORD_COMPRESSION_ACCOUNT_DAILY_INVOCATION_LIMIT = 2;
export const RECORD_COMPRESSION_MAX_DAILY_BUDGET_CNY = 1;
export const RECORD_COMPRESSION_MAX_PER_CALL_BUDGET_CNY = 0.25;
export const RECORD_COMPRESSION_MAX_DAILY_INVOCATION_LIMIT = 4;

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

export function loadAppConfig({ rootDir, env = process.env }) {
  const persistenceBackend = env.PERSISTENCE_BACKEND || "json";
  const upstreamOrigin = String(env.UPSTREAM_ORIGIN || "").replace(/\/+$/, "");
  const testCurrentDate = env.NODE_ENV === "test" ? String(env.TEST_CURRENT_DATE || "").trim() : "";
  if (testCurrentDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(testCurrentDate);
    const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!date || date.toISOString().slice(0, 10) !== testCurrentDate) throw new Error("TEST_CURRENT_DATE must be a valid YYYY-MM-DD date");
  }
  if (!["json", "postgres"].includes(persistenceBackend)) throw new Error("PERSISTENCE_BACKEND must be json or postgres");
  if (persistenceBackend === "postgres" && (env.LOCAL_TEST_MODE === "1" || upstreamOrigin)) {
    throw new Error("PostgreSQL runtime requires a standalone data source; local-test/upstream proxy is unsupported");
  }
  const inviteCodeHash = String(env.INVITE_CODE_HASH || "").toLowerCase();
  const authRequired = env.AUTH_REQUIRED === "1" || Boolean(inviteCodeHash);
  if (authRequired && !/^[a-f0-9]{64}$/.test(inviteCodeHash)) throw new Error("AUTH_REQUIRED=1 requires a 64-character SHA-256 INVITE_CODE_HASH");
  const localTestMode = env.LOCAL_TEST_MODE === "1";
  if (localTestMode && env.NODE_ENV === "production") throw new Error("LOCAL_TEST_MODE cannot run with NODE_ENV=production");
  if (localTestMode && authRequired) throw new Error("LOCAL_TEST_MODE uses upstream authentication and cannot enable local AUTH_REQUIRED");
  const attachments = loadAttachmentConfig(env);
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
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(rootDir, "data"),
    port: Number(env.PORT || 4173),
    version: env.APP_VERSION || "development",
    promptCatalogVersion: String(env.PROMPT_CATALOG_VERSION || "").trim(),
    basePath: `/${String(env.APP_BASE_PATH || "").replace(/^\/+|\/+$/g, "")}`,
    upstreamOrigin,
    persistenceBackend,
    databaseUrl: env.DATABASE_URL,
    authDatabaseUrl: env.AUTH_DATABASE_URL,
    aiBudgetDatabaseUrl: env.AI_BUDGET_DATABASE_URL,
    inviteCodeHash, authRequired,
    cookieSecure: env.COOKIE_SECURE === "1",
    localTestMode,
    localTestMainUserId: String(env.LOCAL_TEST_MAIN_USER_ID || "").trim(),
    localTestResetOnStart: localTestMode && env.LOCAL_TEST_RESET_ON_START === "1",
    testCurrentDate,
    periodicAnalysisEnabled: env.PERIODIC_ANALYSIS_ENABLED === "1",
    recordCompressionEnabled,
    recordCompressionDailyBudgetCny: recordCompressionEnabled ? recordCompressionDailyBudgetCny : 0,
    recordCompressionPerCallBudgetCny: recordCompressionEnabled ? recordCompressionPerCallBudgetCny : 0,
    recordCompressionDailyInvocationLimit: recordCompressionEnabled ? configuredInvocationLimit : 0,
    recordCompressionAccountDailyInvocationLimit: RECORD_COMPRESSION_ACCOUNT_DAILY_INVOCATION_LIMIT,
    recordCompressionMaxBackfillDatesPerScan: Math.max(
      0,
      Math.min(2, Math.floor(Number.isFinite(configuredBackfillDates) ? configuredBackfillDates : 1))
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
      incrementalSync: String(env.INCREMENTAL_SYNC_ENABLED ?? "1") !== "0"
    }),
    platform: Object.freeze({
      serviceTokenHash: platformServiceTokenHash,
      backupStatusFile: String(env.BACKUP_STATUS_FILE || "/var/lib/for-now-monitor/last-backup-success")
    }),
    audit: Object.freeze({
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
