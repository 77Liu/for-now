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

async function ready(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

async function postgresUsageDocuments(connectionString) {
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
    const users = (await client.query("SELECT id FROM for_now_auth.users ORDER BY position")).rows;
    const accountIds = users.length ? users.map(user => user.id) : ["local"];
    const entries = [];
    for (const accountId of accountIds) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const rows = (await client.query(`
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
  backupDatabaseUrl = process.env.PG_BACKUP_DATABASE_URL
} = {}) {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const documents = persistenceBackend === "postgres"
    ? await postgresUsageDocuments(backupDatabaseUrl)
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
    await sendFeishu(`${heading}\n主机：${health.host}\n时间：${health.checkedAt}\n${lines.join("\n")}`);
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
