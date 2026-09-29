import path from "node:path";

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
    testMode: env.NODE_ENV === "test"
  });
}

export function loadAppConfig({ rootDir, env = process.env }) {
  const persistenceBackend = env.PERSISTENCE_BACKEND || "json";
  if (!["json", "postgres"].includes(persistenceBackend)) throw new Error("PERSISTENCE_BACKEND must be json or postgres");
  if (persistenceBackend === "postgres" && (env.LOCAL_TEST_MODE === "1" || env.UPSTREAM_ORIGIN)) {
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
  const platformServiceTokenHash = String(env.PLATFORM_SERVICE_TOKEN_HASH || "").toLowerCase();
  if (platformServiceTokenHash && !/^[a-f0-9]{64}$/.test(platformServiceTokenHash)) {
    throw new Error("PLATFORM_SERVICE_TOKEN_HASH must be a 64-character SHA-256 digest");
  }
  const usdCny = Math.max(0.01, Number(env.AI_COST_CNY_PER_USD) || 7.2);
  const legacyCostLimitUsd = Number(env.AI_USER_DAILY_COST_LIMIT_USD);
  return Object.freeze({
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(rootDir, "data"),
    port: Number(env.PORT || 4173),
    version: env.APP_VERSION || "development",
    promptCatalogVersion: String(env.PROMPT_CATALOG_VERSION || "").trim(),
    basePath: `/${String(env.APP_BASE_PATH || "").replace(/^\/+|\/+$/g, "")}`,
    upstreamOrigin: String(env.UPSTREAM_ORIGIN || "").replace(/\/+$/, ""),
    persistenceBackend,
    databaseUrl: env.DATABASE_URL,
    authDatabaseUrl: env.AUTH_DATABASE_URL,
    inviteCodeHash, authRequired,
    cookieSecure: env.COOKIE_SECURE === "1",
    localTestMode,
    localTestMainUserId: String(env.LOCAL_TEST_MAIN_USER_ID || "").trim(),
    deepSeekApiUrl: env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    attachments,
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
      aiDailyCalls: Math.max(1, Math.round(Number(env.AI_USER_DAILY_CALL_LIMIT) || 200)),
      usdCny,
      aiDailyCostCny: Math.max(0.01, Number(env.AI_USER_DAILY_COST_LIMIT_CNY) || (Number.isFinite(legacyCostLimitUsd) ? legacyCostLimitUsd * usdCny : 14.4)),
      attachmentBytes: Math.max(env.NODE_ENV === "test" ? 1 : 1024 * 1024, Math.round(Number(env.ATTACHMENT_USER_QUOTA_BYTES) || 1024 * 1024 * 1024))
    }),
    segmentation: Object.freeze({
      roleName: String(env.ALIBABA_CLOUD_ECS_RAM_ROLE ?? "").trim().slice(0, 128),
      disableIMDSv1: attachments.disableIMDSv1,
      mockResult: env.NODE_ENV === "test" ? String(env.KEEPSAKE_SEGMENT_MOCK_RESULT ?? "").trim().slice(0, 48 * 1024 * 1024) : "",
      mockDelayMs: Math.max(0, Math.min(5000, Number(env.KEEPSAKE_SEGMENT_MOCK_DELAY_MS) || 0))
    })
  });
}
