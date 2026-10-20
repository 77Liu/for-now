import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

const execFile = promisify(execFileCallback);
const DAY_MS = 86400000;
const MIB = 1024 * 1024;
const ALERT_LOG_LOOKBACK_MS = 10 * 60 * 1000;
const ALERT_METRIC_LOOKBACK_MS = 10 * 1000;
const ALERT_LOG_LIMIT = 10;
const ALERT_CONTEXT_MAX_BYTES = 64 * 1024;
const PLATFORM_JOURNAL_CONTEXT_FILE = "/var/lib/for-now-monitor-journal/platform-context.json";
const RUNTIME_HANDLE_CATEGORIES = new Set([
  "childProcess", "fileWatcher", "messagePort", "other", "server",
  "signal", "socket", "stream", "timer", "tlsSocket"
]);
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const nonnegative = value => Math.max(0, Number(value) || 0);

async function serviceActive(name) {
  if (process.env.NODE_ENV === "test" && name === "for-now-platform.service" && process.env.MONITOR_TEST_PLATFORM_ACTIVE) {
    return process.env.MONITOR_TEST_PLATFORM_ACTIVE === "1";
  }
  if (process.env.NODE_ENV === "test" && process.env.MONITOR_TEST_SERVICE_ACTIVE) return process.env.MONITOR_TEST_SERVICE_ACTIVE === "1";
  try {
    await execFile("/usr/bin/systemctl", ["is-active", "--quiet", name]);
    return true;
  } catch {
    return false;
  }
}

// 中台 readyz 内部等待主应用聚合（中台侧上限 5s）；外层监控必须更宽，避免把一次慢聚合误报成服务不可用。
const readyTimeoutMs = () => Math.max(5000, numberEnv("MONITOR_READY_TIMEOUT_MS", 15000));
async function ready(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(readyTimeoutMs()) });
    return response.ok;
  } catch {
    return false;
  }
}

async function latestBackupTime(backupDir, stampFile) {
  try { return (await fs.stat(stampFile)).mtimeMs; } catch {}
  try {
    const names = (await fs.readdir(backupDir)).filter(name => /^for-now-.*\.tar\.gz$/.test(name));
    const times = await Promise.all(names.map(async name => (await fs.stat(path.join(backupDir, name))).mtimeMs));
    return times.length ? Math.max(...times) : 0;
  } catch {
    return 0;
  }
}

async function recentAiResults(dataDir) {
  const logsDir = path.join(dataDir, "logs");
  try {
    const names = (await fs.readdir(logsDir)).filter(name => /^system-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort().slice(-2);
    const entries = [];
    for (const name of names) {
      for (const line of (await fs.readFile(path.join(logsDir, name), "utf8")).trim().split("\n").slice(-2000)) {
        try {
          const entry = JSON.parse(line);
          if (entry.event === "ai.completed") entries.push(entry);
        } catch {}
      }
    }
    return entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  } catch {
    return [];
  }
}

function normalizeRuntimeMemorySample(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(Number(value.rss))) return null;
  const delay = value.eventLoopDelay || {}, handles = value.activeHandles || {};
  return {
    sampledAt: String(value.sampledAt || ""),
    rss: nonnegative(value.rss),
    heapTotal: nonnegative(value.heapTotal),
    heapUsed: nonnegative(value.heapUsed),
    external: nonnegative(value.external),
    arrayBuffers: nonnegative(value.arrayBuffers),
    heapSpaces: (Array.isArray(value.heapSpaces) ? value.heapSpaces : []).slice(0, 32).map(space => ({
      name: String(space?.name || "").slice(0, 80),
      size: nonnegative(space?.size),
      used: nonnegative(space?.used),
      available: nonnegative(space?.available),
      physical: nonnegative(space?.physical)
    })),
    eventLoopDelay: {
      meanMs: nonnegative(delay.meanMs),
      p50Ms: nonnegative(delay.p50Ms),
      p95Ms: nonnegative(delay.p95Ms),
      p99Ms: nonnegative(delay.p99Ms),
      maxMs: nonnegative(delay.maxMs)
    },
    activeHandles: {
      total: nonnegative(handles.total),
      categories: Object.fromEntries(Object.entries(handles.categories || {})
        .filter(([key]) => RUNTIME_HANDLE_CATEGORIES.has(key))
        .map(([key, count]) => [key, nonnegative(count)])
        .sort(([left], [right]) => left.localeCompare(right)))
    }
  };
}

export async function latestRuntimeMemorySample(dataDir) {
  const logsDir = path.join(dataDir, "logs");
  try {
    const names = (await fs.readdir(logsDir))
      .filter(name => /^system-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
      .sort()
      .slice(-2)
      .reverse();
    for (const name of names) {
      const lines = (await fs.readFile(path.join(logsDir, name), "utf8")).trim().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = JSON.parse(lines[index]);
          if (entry.event === "runtime.memory_sample") {
            const sample = normalizeRuntimeMemorySample(entry.sample);
            if (sample) return sample;
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

function utcDaysBetween(startMs, endMs) {
  const days = new Set();
  for (let time = startMs; time <= endMs; time = Date.parse(`${new Date(time).toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY_MS) {
    days.add(new Date(time).toISOString().slice(0, 10));
  }
  return [...days];
}

async function readRecentJsonLines(file, sinceMs, untilMs) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    if (!size) return [];
    const bytes = Math.min(size, ALERT_CONTEXT_MAX_BYTES);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, size - bytes);
    let text = buffer.toString("utf8");
    if (size > bytes) {
      const boundary = text.indexOf("\n");
      text = boundary >= 0 ? text.slice(boundary + 1) : "";
    }
    const entries = [];
    for (const line of text.split("\n")) {
      try {
        const entry = JSON.parse(line);
        const timestamp = Date.parse(entry.timestamp || "");
        if (Number.isFinite(timestamp) && timestamp >= sinceMs && timestamp <= untilMs) entries.push(entry);
      } catch {}
    }
    return entries;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function operationLogFiles(dataDir, days, sinceMs) {
  const names = days.map(day => `operation-${day}.ndjson`);
  const files = names.map(name => path.join(dataDir, "logs", name));
  let users = [];
  try { users = await fs.readdir(path.join(dataDir, "users"), { withFileTypes: true }); } catch {}
  const accounts = users.filter(entry => entry.isDirectory());
  const queue = accounts.flatMap(account => names.map(name => path.join(dataDir, "users", account.name, "logs", name)));
  const candidates = [...files, ...queue];
  const recent = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(16, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const file = candidates[cursor++];
      try {
        const info = await fs.stat(file);
        if (info.isFile() && info.mtimeMs >= sinceMs - 60_000) recent.push(file);
      } catch {}
    }
  });
  await Promise.all(workers);
  return recent;
}

function safeKey(value, maxLength = 80) {
  const text = String(value || "");
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text.slice(0, maxLength) : "";
}

function safeTraceId(value) {
  const text = safeKey(value, 128);
  return text ? text.slice(-12) : "";
}

function logSummary(entry, kind) {
  const result = {
    at: String(entry.timestamp || "").slice(11, 19),
    event: safeKey(entry.event, 80) || "unknown",
    module: safeKey(entry.module, 40),
    source: kind === "operation" ? "operation" : (entry.source === "platform-journal" ? "platform-journal" : "application")
  };
  const traceId = safeTraceId(entry.traceId);
  if (traceId) result.trace = traceId;
  if (kind === "system") {
    const level = safeKey(entry.level, 12);
    if (level) result.level = level;
    const status = Number(entry.statusCode || entry.httpStatus);
    if (Number.isFinite(status) && status > 0) result.status = status;
    const duration = Number(entry.durationMs);
    if (Number.isFinite(duration) && duration >= 0) result.durationMs = Math.round(duration);
    const errorCode = safeKey(entry.error?.code || entry.errorCode, 80);
    if (errorCode) result.errorCode = errorCode;
    const errorName = safeKey(typeof entry.error === "string" ? entry.error : entry.error?.name, 40);
    if (errorName) result.error = errorName;
  } else {
    const method = safeKey(entry.method, 12);
    if (method) result.method = method;
    const resourceType = safeKey(entry.resourceType, 40);
    if (resourceType) result.resource = resourceType;
    const status = Number(entry.statusCode || entry.httpStatus);
    if (Number.isFinite(status) && status > 0) result.status = status;
    const duration = Number(entry.durationMs);
    if (Number.isFinite(duration) && duration >= 0) result.durationMs = Math.round(duration);
    const outcome = safeKey(entry.result, 20);
    if (outcome) result.result = outcome;
    const errorCode = safeKey(entry.errorCode, 80);
    if (errorCode) result.errorCode = errorCode;
    const changeCount = Number(entry.changeCount || (Array.isArray(entry.changes) ? entry.changes.length : 0));
    if (Number.isFinite(changeCount) && changeCount > 0) result.changes = Math.min(999, Math.floor(changeCount));
  }
  return result;
}

/**
 * 严重告警仅携带近期日志的白名单字段；账户、资源 ID、路由参数和正文均不外发。
 */
export async function recentAlertLogContext(dataDir, timestamp, {
  journalContextFile = process.env.MONITOR_PLATFORM_JOURNAL_CONTEXT_FILE || PLATFORM_JOURNAL_CONTEXT_FILE
} = {}) {
  const endMs = Date.parse(timestamp);
  if (!Number.isFinite(endMs)) return { system: [], operation: [], platformJournalAvailable: false };
  const sinceMs = endMs - ALERT_LOG_LOOKBACK_MS;
  const days = utcDaysBetween(sinceMs, endMs);
  const systemFiles = days.map(day => path.join(dataDir, "logs", `system-${day}.ndjson`));
  const operationFiles = await operationLogFiles(dataDir, days, sinceMs);
  const [systemGroups, operationGroups, journalSnapshot] = await Promise.all([
    Promise.all(systemFiles.map(file => readRecentJsonLines(file, sinceMs, endMs))),
    Promise.all(operationFiles.map(file => readRecentJsonLines(file, sinceMs, endMs))),
    fs.readFile(journalContextFile, "utf8").then(JSON.parse).catch(() => null)
  ]);
  const journalGeneratedAt = Date.parse(journalSnapshot?.generatedAt || "");
  const platformJournalAvailable = journalSnapshot?.schemaVersion === 1 && journalSnapshot.available === true
    && Number.isFinite(journalGeneratedAt) && journalGeneratedAt <= endMs + 30_000 && journalGeneratedAt >= endMs - 120_000;
  const platformEntries = platformJournalAvailable && Array.isArray(journalSnapshot.entries)
    ? journalSnapshot.entries.filter(entry => {
      const time = Date.parse(entry.timestamp || "");
      return Number.isFinite(time) && time >= sinceMs && time <= endMs;
    })
    : [];
  const severityRank = entry => ({ emergency: 0, alert: 1, critical: 2, error: 3, warning: 4, notice: 5, info: 6, debug: 7 }[entry.level] ?? 8);
  const system = [...systemGroups.flat(), ...platformEntries]
    .filter(entry => entry.event !== "runtime.memory_sample")
    .sort((left, right) => severityRank(left) - severityRank(right) || Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, ALERT_LOG_LIMIT)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map(entry => logSummary(entry, "system"));
  const operation = operationGroups.flat()
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    .slice(-ALERT_LOG_LIMIT)
    .map(entry => logSummary(entry, "operation"));
  return { system, operation, platformJournalAvailable };
}

/**
 * 汇总告警检查时刻前 10 秒的主机采样；覆盖不足时明确报告，不伪称峰值。
 */
export async function recentHostMetricPeaks(metricsFile, timestamp) {
  const endMs = Date.parse(timestamp);
  if (!Number.isFinite(endMs)) return { available: false, reason: "无效时间" };
  let state;
  try { state = JSON.parse(await fs.readFile(metricsFile, "utf8")); } catch {
    return { available: false, reason: "采样文件缺失或不可读" };
  }
  const samples = (Array.isArray(state.samples) ? state.samples : []).filter(sample => {
    const sampledAt = Date.parse(sample.sampledAt || "");
    return Number.isFinite(sampledAt) && sampledAt >= endMs - ALERT_METRIC_LOOKBACK_MS && sampledAt <= endMs;
  });
  const cpu = samples.map(sample => Number(sample.cpuPercent)).filter(Number.isFinite);
  const memory = samples.filter(sample => Number.isFinite(Number(sample.memoryUsedBytes))
    && Number.isFinite(Number(sample.memoryTotalBytes)) && Number(sample.memoryTotalBytes) > 0);
  const expectedSamples = Math.floor(ALERT_METRIC_LOOKBACK_MS / 1000);
  if (samples.length < 8 || cpu.length < 8 || memory.length < 8) {
    return { available: false, sampleCount: samples.length, expectedSamples, reason: "近 10 秒有效采样不足" };
  }
  const peakMemory = memory.reduce((peak, sample) => Number(sample.memoryUsedBytes) > Number(peak.memoryUsedBytes) ? sample : peak);
  const servicePeak = (name, field) => {
    const values = samples.map(sample => Number(sample.services?.[name]?.[field])).filter(Number.isFinite);
    return values.length >= 8 ? Math.max(...values) : null;
  };
  return {
    available: true,
    sampleCount: samples.length,
    expectedSamples,
    cpuPercent: Math.round(Math.max(...cpu) * 10) / 10,
    memoryUsedBytes: Number(peakMemory.memoryUsedBytes),
    memoryTotalBytes: Number(peakMemory.memoryTotalBytes),
    memoryPercent: Math.round(Number(peakMemory.memoryUsedBytes) / Number(peakMemory.memoryTotalBytes) * 1000) / 10,
    mainServiceMemoryBytes: servicePeak("for-now.service", "memoryBytes"),
    mainServiceCpuPercent: servicePeak("for-now.service", "cpuPercent"),
    platformServiceMemoryBytes: servicePeak("for-now-platform.service", "memoryBytes"),
    platformServiceCpuPercent: servicePeak("for-now-platform.service", "cpuPercent")
  };
}

function formatAlertContext(logs, metrics) {
  const lines = ["诊断上下文（只含脱敏关键字段）", "系统日志（近10分钟，最多10条；含应用日志及中台 journal 摘要）："];
  lines.push(...(logs.system.length ? logs.system.map(entry => `- ${JSON.stringify(entry)}`) : ["- 无可用记录"]));
  if (!logs.platformJournalAvailable) lines.push("中台 journal 摘要：不可用（快照缺失、过期或读取失败）");
  lines.push("操作日志（近10分钟，最多10条）：");
  lines.push(...(logs.operation.length ? logs.operation.map(entry => `- ${JSON.stringify(entry)}`) : ["- 无可用记录"]));
  if (!metrics.available) {
    lines.push(`主机指标（检查前10秒）：不可用（${metrics.reason}，样本 ${metrics.sampleCount || 0}/${metrics.expectedSamples || 10}）`);
  } else {
    const toMiB = bytes => bytes == null ? "不可用" : `${Math.round(bytes / MIB)} MiB`;
    const toPercent = value => value == null ? "不可用" : `${Math.round(value * 10) / 10}%`;
    lines.push(`主机指标（检查前10秒峰值，${metrics.sampleCount}/${metrics.expectedSamples}样本）：CPU ${metrics.cpuPercent}%，内存 ${metrics.memoryPercent}%（${toMiB(metrics.memoryUsedBytes)}/${toMiB(metrics.memoryTotalBytes)}）`);
    lines.push(`服务 CPU/内存峰值：主应用 ${toPercent(metrics.mainServiceCpuPercent)}/${toMiB(metrics.mainServiceMemoryBytes)}，中台 ${toPercent(metrics.platformServiceCpuPercent)}/${toMiB(metrics.platformServiceMemoryBytes)}`);
  }
  return lines.join("\n").slice(0, 6000);
}

async function jsonUsageDocuments(dataDir) {
  const files = [path.join(dataDir, "ai-usage.json")];
  try {
    for (const entry of await fs.readdir(path.join(dataDir, "users"), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(dataDir, "users", entry.name, "ai-usage.json"));
    }
  } catch {}
  const documents = [];
  for (const file of files) {
    try {
      documents.push(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return documents;
}

async function postgresUsageDocuments(connectionString, { databaseEnabled, day }) {
  if (!connectionString) throw new Error("PG_BACKUP_DATABASE_URL is required for PostgreSQL monitoring");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    application_name: "for-now-monitor"
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const users = (await client.query(
      "SELECT id FROM for_now_auth.users ORDER BY created_at, id"
    )).rows;
    const accountIds = users.length ? users.map(user => user.id) : ["local"];
    const entries = [];
    for (const accountId of accountIds) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const rows = databaseEnabled
        ? (await client.query(`
            SELECT payload
            FROM for_now.ai_usage_attempts
            WHERE account_id=$1
              AND occurred_at >= $2::date::timestamp AT TIME ZONE 'UTC'
              AND occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'
            ORDER BY occurred_at, call_id
          `, [accountId, day])).rows
        : (await client.query(`
            SELECT payload
            FROM for_now.document_records
            WHERE account_id = $1 AND document = 'usage' AND field = 'entries'
            ORDER BY position
          `, [accountId])).rows;
      entries.push(...rows.map(row => row.payload));
    }
    await client.query("COMMIT");
    return [{ entries }];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function dailyAiUsage(dataDir, timestamp, {
  persistenceBackend = process.env.PERSISTENCE_BACKEND || "json",
  backupDatabaseUrl = process.env.PG_BACKUP_DATABASE_URL,
  auditDatabaseEnabled = process.env.AI_AUDIT_DB_ENABLED === "1"
} = {}) {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const documents = persistenceBackend === "postgres"
    ? await postgresUsageDocuments(backupDatabaseUrl, {
        databaseEnabled: auditDatabaseEnabled,
        day
      })
    : await jsonUsageDocuments(dataDir);
  const total = { calls: 0, costUsd: 0, costCny: 0, costUnknownCalls: 0 };
  for (const value of documents) {
    for (const entry of value.entries || []) {
      if (String(entry.createdAt || "").slice(0, 10) !== day) continue;
      total.calls += 1;
      total.costUsd += Number(entry.costsUsd?.total || 0);
      total.costCny += Number(entry.costCny || 0);
      if (entry.provider !== "deepseek" && !entry.costKnown) total.costUnknownCalls += 1;
    }
  }
  return total;
}

export async function collectHealth({
  now = Date.now(),
  dataDir = process.env.DATA_DIR || "/srv/for-now/data",
  backupDir = process.env.BACKUP_DIR || "/var/backups/for-now",
  backupStamp = process.env.BACKUP_SUCCESS_STAMP || "/var/lib/for-now-monitor/last-backup-success",
  serviceName = process.env.MONITOR_SERVICE_NAME || "for-now.service",
  readyUrl = process.env.MONITOR_READY_URL || "http://127.0.0.1:4173/readyz",
  platformEnabled = process.env.MONITOR_PLATFORM_ENABLED === "1",
  platformServiceName = process.env.MONITOR_PLATFORM_SERVICE_NAME || "for-now-platform.service",
  platformReadyUrl = process.env.MONITOR_PLATFORM_READY_URL || "http://127.0.0.1:4280/readyz",
  runtimeMemoryAlertActive = false
} = {}) {
  const issues = [], active = await serviceActive(serviceName), isReady = active && await ready(readyUrl);
  if (!active || !isReady) issues.push({ key: "service", severity: "critical", text: active ? "服务进程存活，但健康检查失败" : "服务已停止" });
  const platformActive = platformEnabled ? await serviceActive(platformServiceName) : null;
  const platformReady = platformEnabled ? platformActive && await ready(platformReadyUrl) : null;
  if (platformEnabled && (!platformActive || !platformReady)) {
    issues.push({
      key: "platform-service",
      severity: "critical",
      text: platformActive ? "中台进程存活，但生产数据就绪检查失败" : "中台服务已停止"
    });
  }

  const disk = await fs.statfs(dataDir);
  const diskPercent = disk.blocks ? Math.round((1 - disk.bavail / disk.blocks) * 1000) / 10 : 0;
  const diskWarn = numberEnv("ALERT_DISK_WARNING_PERCENT", 70), diskCritical = numberEnv("ALERT_DISK_CRITICAL_PERCENT", 85);
  if (diskPercent >= diskCritical) issues.push({ key: "disk", severity: "critical", text: `磁盘使用率 ${diskPercent}%（阈值 ${diskCritical}%）` });
  else if (diskPercent >= diskWarn) issues.push({ key: "disk", severity: "warning", text: `磁盘使用率 ${diskPercent}%（阈值 ${diskWarn}%）` });

  const backupTime = await latestBackupTime(backupDir, backupStamp);
  const backupAgeHours = backupTime ? Math.round((now - backupTime) / 360000) / 10 : null;
  const backupLimit = numberEnv("ALERT_BACKUP_MAX_AGE_HOURS", 26);
  if (backupAgeHours == null || backupAgeHours > backupLimit) issues.push({
    key: "backup", severity: "critical",
    text: backupAgeHours == null ? "没有可确认的成功备份" : `最近成功备份距今 ${backupAgeHours} 小时（阈值 ${backupLimit} 小时）`
  });

  const aiResults = await recentAiResults(dataDir);
  let consecutiveAiFailures = 0;
  for (let index = aiResults.length - 1; index >= 0 && aiResults[index].status !== "success"; index -= 1) consecutiveAiFailures += 1;
  const failureLimit = Math.max(1, numberEnv("ALERT_AI_CONSECUTIVE_FAILURES", 5));
  if (consecutiveAiFailures >= failureLimit) issues.push({ key: "ai-failures", severity: "warning", text: `AI 连续失败 ${consecutiveAiFailures} 次（阈值 ${failureLimit} 次）` });

  const cnyPerUsd = Math.max(0.01, numberEnv("AI_COST_CNY_PER_USD", 7.2));
  const aiUsage = await dailyAiUsage(dataDir, now);
  const costCny = Math.round((aiUsage.costUsd * cnyPerUsd + aiUsage.costCny) * 10000) / 10000;
  const legacyCostLimitUsd = Number(process.env.ALERT_DAILY_AI_COST_USD);
  const costLimitCny = Math.max(0.01, numberEnv("ALERT_DAILY_AI_COST_CNY", Number.isFinite(legacyCostLimitUsd) ? legacyCostLimitUsd * cnyPerUsd : 36));
  if (costCny >= costLimitCny) issues.push({ key: "ai-cost", severity: "warning", text: `今日 AI 估算费用 ¥${costCny.toFixed(4)}（阈值 ¥${costLimitCny.toFixed(2)}）` });

  const runtimeMemory = await latestRuntimeMemorySample(dataDir);
  const runtimeRssMiB = runtimeMemory ? Math.round(runtimeMemory.rss / MIB * 10) / 10 : null;
  const runtimeRssAlertMiB = Math.max(1, numberEnv("ALERT_RUNTIME_RSS_MIB", 400));
  const runtimeRssRecoveryMiB = Math.min(
    runtimeRssAlertMiB,
    Math.max(0, numberEnv("ALERT_RUNTIME_RSS_RECOVERY_MIB", 360))
  );
  const memoryOverThreshold = runtimeRssMiB != null && (
    runtimeMemoryAlertActive
      ? runtimeRssMiB > runtimeRssRecoveryMiB
      : runtimeRssMiB >= runtimeRssAlertMiB
  );
  if (memoryOverThreshold) issues.push({
    key: "runtime-memory",
    severity: "warning",
    text: `Node RSS ${runtimeRssMiB} MiB（告警阈值 ${runtimeRssAlertMiB} MiB，恢复阈值 ${runtimeRssRecoveryMiB} MiB）`
  });

  return {
    checkedAt: new Date(now).toISOString(),
    host: os.hostname(),
    active,
    ready: isReady,
    platformEnabled,
    platformActive,
    platformReady,
    diskPercent,
    backupAgeHours,
    consecutiveAiFailures,
    costCny,
    aiCalls: aiUsage.calls,
    costUnknownCalls: aiUsage.costUnknownCalls,
    runtimeMemory,
    runtimeRssMiB,
    runtimeRssAlertMiB,
    runtimeRssRecoveryMiB,
    issues
  };
}

function feishuSignature(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

export function validateFeishuWebhook(webhook) {
  let url;
  try { url = new URL(webhook); } catch {}
  const validHost = ["open.feishu.cn", "open.larkoffice.com", "open.larksuite.com"].includes(url?.hostname);
  const validPath = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+\/?$/.test(url?.pathname || "");
  if (!url || url.protocol !== "https:" || !validHost || !validPath || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("FEISHU_ALERT_WEBHOOK must be an official HTTPS custom-bot webhook"), { code: "FEISHU_INVALID_WEBHOOK" });
  }
  return url.toString();
}

export async function sendFeishu(text, webhook = process.env.FEISHU_ALERT_WEBHOOK, secret = process.env.FEISHU_ALERT_SECRET || "") {
  if (!webhook) throw Object.assign(new Error("FEISHU_ALERT_WEBHOOK is not configured"), { code: "FEISHU_NOT_CONFIGURED" });
  const timestamp = Math.floor(Date.now() / 1000), body = { msg_type: "text", content: { text } };
  if (secret) Object.assign(body, { timestamp: String(timestamp), sign: feishuSignature(timestamp, secret) });
  const response = await fetch(validateFeishuWebhook(webhook), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || (result.code !== 0 && result.StatusCode !== 0)) {
    throw Object.assign(new Error("Feishu alert delivery failed"), { code: "FEISHU_DELIVERY_FAILED" });
  }
}

export async function runMonitor() {
  const stateFile = process.env.MONITOR_STATE_FILE || "/var/lib/for-now-monitor/state.json";
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(stateFile, "utf8")); } catch {}
  const runtimeMemoryAlertActive = String(previous.fingerprint || "").split("|")
    .some(item => item.startsWith("runtime-memory:"));
  const health = await collectHealth({ runtimeMemoryAlertActive });
  const fingerprint = health.issues.map(item => `${item.key}:${item.severity}`).sort().join("|");
  const repeatAfterMs = Math.max(5, numberEnv("ALERT_REPEAT_MINUTES", 60)) * 60000;
  const changed = fingerprint !== previous.fingerprint;
  const repeated = health.issues.length && Date.now() - Number(previous.sentAt || 0) >= repeatAfterMs;
  if ((health.issues.length && (changed || repeated)) || (!health.issues.length && previous.fingerprint)) {
    const heading = health.issues.length ? `[个人成长追踪] ${health.issues.some(item => item.severity === "critical") ? "严重告警" : "告警"}` : "[个人成长追踪] 已恢复";
    const lines = health.issues.length ? health.issues.map(item => `- ${item.text}`) : ["- 服务、资源、备份和 AI 指标已恢复到阈值内"];
    let alert = `${heading}\n主机：${health.host}\n时间：${health.checkedAt}\n${lines.join("\n")}`;
    if (health.issues.some(item => item.severity === "critical")) {
      const metricsFile = process.env.MONITOR_HOST_METRICS_FILE || "/var/lib/for-now-monitor/host-metrics.json";
      const [logs, metrics] = await Promise.all([
        recentAlertLogContext(process.env.DATA_DIR || "/srv/for-now/data", health.checkedAt),
        recentHostMetricPeaks(metricsFile, health.checkedAt)
      ]);
      alert += `\n${formatAlertContext(logs, metrics)}`;
    }
    await sendFeishu(alert);
    previous.sentAt = Date.now();
  }
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(stateFile, `${JSON.stringify({ fingerprint, sentAt: previous.sentAt || 0, health }, null, 2)}\n`, { mode: 0o600 });
  if (health.issues.some(item => item.severity === "critical")) process.exitCode = 2;
  return health;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const operation = process.argv.includes("--test-alert")
    ? sendFeishu(`[个人成长追踪] 告警通道测试\n主机：${os.hostname()}\n时间：${new Date().toISOString()}\n- 飞书告警通道可用`).then(() => ({ testAlert: true, issues: [] }))
    : runMonitor();
  operation.then(health => {
    console.log(JSON.stringify({ ok: Boolean(health.testAlert) || !health.issues.length, testAlert: Boolean(health.testAlert), issues: health.issues.map(item => item.key) }));
  }).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || "MONITOR_FAILED" }));
    process.exitCode = 1;
  });
}
