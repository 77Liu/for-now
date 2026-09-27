import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const DAY_MS = 86400000;
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

async function serviceActive(name) {
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

async function dailyAiCost(dataDir, timestamp) {
  const day = new Date(timestamp).toISOString().slice(0, 10), files = [path.join(dataDir, "ai-usage.json")];
  try {
    for (const entry of await fs.readdir(path.join(dataDir, "users"), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(dataDir, "users", entry.name, "ai-usage.json"));
    }
  } catch {}
  let total = 0;
  for (const file of files) {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      for (const entry of value.entries || []) {
        if (String(entry.createdAt || "").slice(0, 10) === day) total += Number(entry.costsUsd?.total || 0);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
  readyUrl = process.env.MONITOR_READY_URL || "http://127.0.0.1:4173/readyz"
} = {}) {
  const issues = [], active = await serviceActive(serviceName), isReady = active && await ready(readyUrl);
  if (!active || !isReady) issues.push({ key: "service", severity: "critical", text: active ? "服务进程存活，但健康检查失败" : "服务已停止" });

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

  const costUsd = Math.round(await dailyAiCost(dataDir, now) * 10000) / 10000;
  const costLimit = numberEnv("ALERT_DAILY_AI_COST_USD", 5);
  if (costUsd >= costLimit) issues.push({ key: "ai-cost", severity: "warning", text: `今日 AI 估算费用 $${costUsd.toFixed(4)}（阈值 $${costLimit.toFixed(2)}）` });

  return { checkedAt: new Date(now).toISOString(), host: os.hostname(), active, ready: isReady, diskPercent, backupAgeHours, consecutiveAiFailures, costUsd, issues };
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
  const health = await collectHealth(), fingerprint = health.issues.map(item => `${item.key}:${item.severity}`).sort().join("|");
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(stateFile, "utf8")); } catch {}
  const repeatAfterMs = Math.max(5, numberEnv("ALERT_REPEAT_MINUTES", 60)) * 60000;
  const changed = fingerprint !== previous.fingerprint;
  const repeated = health.issues.length && Date.now() - Number(previous.sentAt || 0) >= repeatAfterMs;
  if ((health.issues.length && (changed || repeated)) || (!health.issues.length && previous.fingerprint)) {
    const heading = health.issues.length ? `[个人成长追踪] ${health.issues.some(item => item.severity === "critical") ? "严重告警" : "告警"}` : "[个人成长追踪] 已恢复";
    const lines = health.issues.length ? health.issues.map(item => `- ${item.text}`) : ["- 服务、磁盘、备份和 AI 指标已恢复到阈值内"];
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
