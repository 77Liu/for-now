import { promises as fs } from "node:fs";
import path from "node:path";

const RECORD_COLLECTIONS = [
  "checkins", "dailyRecords", "captures", "journals", "thoughts", "chats",
  "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics",
  "actions", "habits", "habitCheckins", "feedback", "validationLedger"
];
const MODEL_LABELS = {
  "deepseek-flash": "DeepSeek Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro"
};
const SCENE_LABELS = {
  thoughtPrompt: "思绪提示",
  thoughtDraft: "思绪草稿",
  thoughtAnswer: "思绪回答",
  followUpAnswer: "追问回答",
  chat: "长期对话",
  diaryLead: "日记引导",
  diaryStructure: "日记整理",
  diaryTopic: "日记主题",
  diaryReflection: "日记回望",
  annotationShenji: "神鸡批注",
  analysis: "认知复盘",
  bookRecognition: "书籍识别",
  healthRecognition: "健康识别",
  unknown: "历史未知"
};
const GB = 1024 ** 3;
const MB = 1024 ** 2;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function directoryStats(directory) {
  let bytes = 0;
  let files = 0;
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { bytes, files };
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryStats(target);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await fs.stat(target)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function dayKeys(count, end = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (count - 1 - index));
    return localDateKey(date);
  });
}

function recordItems(store) {
  return RECORD_COLLECTIONS.flatMap(key => Array.isArray(store[key]) ? store[key] : []);
}

function percentile(values, proportion) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
}

function sumUsage(entries) {
  return entries.reduce((total, entry) => {
    total.calls += 1;
    total.successful += entry.status === "success" ? 1 : 0;
    total.failed += ["failed", "timeout", "cancelled"].includes(entry.status) ? 1 : 0;
    total.unknown += entry.usageKnown ? 0 : 1;
    total.vision += entry.modality === "vision" ? 1 : 0;
    total.inputTokens += Number(entry.tokens?.input) || 0;
    total.outputTokens += Number(entry.tokens?.output) || 0;
    total.costUsd += Number(entry.costsUsd?.total) || 0;
    if (entry.durationKnown !== false && Number.isFinite(Number(entry.durationMs))) total.durations.push(Number(entry.durationMs));
    return total;
  }, {
    calls: 0, successful: 0, failed: 0, unknown: 0, vision: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, durations: []
  });
}

async function readSystemLogs(dataDir, days = 7) {
  const logsDir = path.join(dataDir, "logs");
  const accepted = new Set(dayKeys(days));
  let names = [];
  try {
    names = await fs.readdir(logsDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const name of names.filter(name => /^system-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && accepted.has(name.slice(7, 17)))) {
    const text = await fs.readFile(path.join(logsDir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        entries.push(item);
      } catch {}
    }
  }
  return entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function publicLog(item) {
  const status = Number(item.statusCode || item.httpStatus) || (item.level === "error" ? 500 : 200);
  const route = String(item.route || "").replace(/[?#].*$/, "").slice(0, 120);
  const action = [item.method, route].filter(Boolean).join(" ");
  return {
    id: String(item.id || `log-${Math.random()}`),
    time: item.timestamp,
    level: item.level === "error" || status >= 500 ? "error" : item.level === "warn" || status >= 400 ? "warn" : "info",
    type: item.event?.startsWith("ai.") || item.event?.startsWith("dependency.") ? "ai" : "system",
    module: String(item.module || "system").slice(0, 40),
    event: String(item.event || "system.event").slice(0, 80),
    traceId: String(item.traceId || "").slice(0, 128),
    summary: action ? `${action} -> ${status}` : `事件 ${String(item.event || "unknown").slice(0, 80)}`,
    status,
    durationMs: Math.max(0, Number(item.durationMs) || 0)
  };
}

async function backupObservation(file) {
  try {
    const stat = await fs.stat(file);
    return [{
      id: "latest-backup",
      createdAt: stat.mtime.toISOString(),
      sizeGb: 0,
      status: "observed",
      checksum: "成功标记",
      restoreDrill: "待独立核对"
    }];
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return [];
    throw error;
  }
}

export async function buildAdminSnapshot({
  dataDir,
  version = "development",
  cnyPerUsd = 7.2,
  dailyCostLimitCny = 14.4,
  attachmentQuotaBytes = GB,
  attachmentMode = "local",
  attachmentUsageBytes = async () => 0,
  backupStatusFile = "",
  dailyCallLimit = 200,
  readAuthData = null,
  readAccountData = null
}) {
  const generatedAt = new Date().toISOString();
  const auth = readAuthData
    ? await readAuthData()
    : await readJson(path.join(dataDir, "auth.json"), { users: [], sessions: [] });
  const systemLogs = await readSystemLogs(dataDir, 2);
  const recentRequestLogs = systemLogs.filter(item => item.event === "request.completed");
  const users = [];
  const allUsage = [];
  let attachmentBytes = 0;
  let attachmentObjects = 0;
  let structuredBytes = await fileSize(path.join(dataDir, "auth.json"));
  let structuredObjects = structuredBytes ? 1 : 0;
  let userLogBytes = 0;
  let userLogObjects = 0;
  let queuedTasks = 0;

  for (const account of Array.isArray(auth.users) ? auth.users : []) {
    const userDir = path.join(dataDir, "users", account.id);
    const accountData = readAccountData ? await readAccountData(account) : null;
    const [store, usage, localAttachments, logs] = await Promise.all([
      accountData?.store ?? readJson(path.join(userDir, "store.json"), {}),
      accountData?.usage ?? readJson(path.join(userDir, "ai-usage.json"), { entries: [] }),
      directoryStats(path.join(userDir, "attachments")),
      directoryStats(path.join(userDir, "logs"))
    ]);
    const entries = Array.isArray(usage.entries) ? usage.entries : [];
    const items = recordItems(store);
    const last30 = new Date(Date.now() - 30 * 86400000);
    const recentEntries = entries.filter(item => new Date(item.createdAt) >= last30);
    const usage30 = sumUsage(recentEntries);
    const dates = new Set([
      ...items.map(item => localDateKey(item.occurredAt || item.createdAt)),
      ...recentEntries.map(item => localDateKey(item.createdAt))
    ].filter(value => value && value >= localDateKey(last30)));
    const sessionDates = (auth.sessions || []).filter(item => item.userId === account.id).map(item => item.createdAt);
    const activityDates = [
      account.createdAt,
      ...sessionDates,
      ...items.flatMap(item => [item.updatedAt, item.occurredAt, item.createdAt]),
      ...entries.flatMap(item => [item.completedAt, item.createdAt])
    ].filter(value => Number.isFinite(new Date(value).getTime())).sort();
    const remoteAttachmentBytes = await attachmentUsageBytes(account.id, path.join(userDir, "attachments"));
    const userAttachmentBytes = Math.max(localAttachments.bytes, Number(remoteAttachmentBytes) || 0);
    const structuredSizes = Number.isFinite(accountData?.structuredBytes)
      ? [accountData.structuredBytes]
      : await Promise.all(["store.json", "llm-settings.json", "ai-usage.json", "ai-cost-plan.json"]
        .map(name => fileSize(path.join(userDir, name))));
    attachmentBytes += userAttachmentBytes;
    attachmentObjects += localAttachments.files;
    userLogBytes += logs.bytes;
    userLogObjects += logs.files;
    structuredBytes += structuredSizes.reduce((sum, value) => sum + value, 0);
    structuredObjects += Number.isInteger(accountData?.structuredObjects)
      ? accountData.structuredObjects
      : structuredSizes.filter(Boolean).length;
    queuedTasks += (store.aiTasks || []).filter(item => ["queued", "running"].includes(item.status)).length;
    allUsage.push(...entries);
    users.push({
      id: account.id,
      name: account.username,
      status: "active",
      plan: "内测版",
      createdAt: String(account.createdAt || "").slice(0, 10),
      lastActiveAt: activityDates.at(-1) || null,
      activeDays30: dates.size,
      records: items.length,
      aiCalls30: usage30.calls,
      aiCost30: usage30.costUsd * cnyPerUsd,
      storageMb: userAttachmentBytes / MB,
      consent: "未采集",
      risk: usage30.costUsd * cnyPerUsd >= dailyCostLimitCny * 20 ? "quota" : "normal"
    });
  }

  const today = localDateKey(new Date());
  const days = dayKeys(7);
  const todayUsage = allUsage.filter(item => localDateKey(item.createdAt) === today);
  const todayAggregate = sumUsage(todayUsage);
  const allAggregate = sumUsage(allUsage);
  const modelNames = [...new Set([...Object.keys(MODEL_LABELS), ...allUsage.map(item => item.model).filter(Boolean)])];
  const models = modelNames.map(model => {
    const aggregate = sumUsage(todayUsage.filter(item => item.model === model));
    return {
      name: MODEL_LABELS[model] || model,
      status: aggregate.failed ? "degraded" : "healthy",
      calls: aggregate.calls,
      successRate: aggregate.calls ? aggregate.successful / aggregate.calls * 100 : 100,
      p95Ms: percentile(aggregate.durations, 0.95),
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cost: aggregate.costUsd * cnyPerUsd
    };
  });
  const sceneNames = [...new Set(allUsage.map(item => item.scene || "unknown"))];
  const scenes = sceneNames.map(scene => {
    const matching = todayUsage.filter(item => (item.scene || "unknown") === scene);
    const aggregate = sumUsage(matching);
    return {
      name: SCENE_LABELS[scene] || scene,
      calls: aggregate.calls,
      cost: aggregate.costUsd * cnyPerUsd,
      failureRate: aggregate.calls ? aggregate.failed / aggregate.calls * 100 : 0,
      trend: days.map(day => allUsage.filter(item => localDateKey(item.createdAt) === day && (item.scene || "unknown") === scene).length)
    };
  }).sort((a, b) => b.calls - a.calls);

  const rootLogs = await directoryStats(path.join(dataDir, "logs"));
  const backupFile = backupStatusFile || path.join(dataDir, ".last-backup-success");
  const backups = await backupObservation(backupFile);
  const disk = await fs.statfs(dataDir);
  const diskUsedPercent = Number(disk.blocks) ? (1 - Number(disk.bavail) / Number(disk.blocks)) * 100 : 0;
  const categories = [
    { key: "attachments", label: attachmentMode === "oss" ? "私有 OSS 附件" : "本机附件", bytes: attachmentBytes, objects: attachmentObjects },
    { key: "records", label: "结构化数据", bytes: structuredBytes, objects: structuredObjects },
    { key: "logs", label: "日志审计", bytes: rootLogs.bytes + userLogBytes, objects: rootLogs.files + userLogObjects }
  ].map(item => ({ ...item, gb: item.bytes / GB, trend: [item.bytes / GB] }));
  const usedGb = categories.reduce((sum, item) => sum + item.gb, 0);
  const totalStorageGb = Math.max(usedGb, users.length * attachmentQuotaBytes / GB, 1);
  const requests1h = recentRequestLogs.filter(item => Date.now() - new Date(item.timestamp).getTime() <= 3600000);
  const requestDurations = requests1h.map(item => Number(item.durationMs)).filter(Number.isFinite);
  const requestErrors = requests1h.filter(item => Number(item.statusCode || item.httpStatus) >= 400);
  const latestBackupAgeHours = backups.length ? (Date.now() - new Date(backups[0].createdAt).getTime()) / 3600000 : Infinity;
  const services = [
    {
      id: "svc-api", name: "业务 API", kind: "api", status: "healthy", desired: 1, healthy: 1,
      version, requests1h: requests1h.length,
      errorRate: requests1h.length ? requestErrors.length / requests1h.length * 100 : 0,
      p95Ms: percentile(requestDurations, 0.95), saturation: 0, owner: "应用服务"
    },
    {
      id: "svc-worker", name: "AI 持久任务", kind: "worker", status: queuedTasks > 20 ? "degraded" : "healthy",
      desired: 1, healthy: 1, version, requests1h: todayAggregate.calls,
      errorRate: todayAggregate.calls ? todayAggregate.failed / todayAggregate.calls * 100 : 0,
      p95Ms: percentile(todayAggregate.durations, 0.95), saturation: Math.min(100, queuedTasks * 5), owner: "模型能力"
    },
    {
      id: "svc-storage", name: attachmentMode === "oss" ? "私有 OSS" : "本机附件存储", kind: "storage",
      status: "healthy", desired: 1, healthy: 1, version: attachmentMode,
      requests1h: 0, errorRate: 0, p95Ms: 0, saturation: Math.min(100, diskUsedPercent), owner: "存储治理"
    },
    {
      id: "svc-backup", name: "备份任务", kind: "scheduler",
      status: latestBackupAgeHours <= 26 ? "healthy" : "degraded", desired: 1,
      healthy: latestBackupAgeHours <= 26 ? 1 : 0, version: "systemd timer",
      requests1h: 0, errorRate: 0, p95Ms: 0, saturation: 0, owner: "存储治理"
    }
  ];

  const trafficNow = new Date();
  trafficNow.setMinutes(0, 0, 0);
  const traffic = Array.from({ length: 7 }, (_, index) => {
    const end = new Date(trafficNow.getTime() - (6 - index) * 4 * 3600000);
    const start = new Date(end.getTime() - 4 * 3600000);
    const matching = recentRequestLogs.filter(item => {
      const time = new Date(item.timestamp);
      return time > start && time <= end;
    });
    return {
      time: `${String(end.getHours()).padStart(2, "0")}:00`,
      requests: matching.length,
      errors: matching.filter(item => Number(item.statusCode || item.httpStatus) >= 400).length
    };
  });
  const publicLogs = systemLogs.filter(item => item.event === "request.completed" || item.level === "error").slice(0, 100).map(publicLog);
  const alerts = [];
  if (queuedTasks > 20) alerts.push({ id: "queue", level: "warning", title: "AI 任务队列积压", detail: `${queuedTasks} 个任务等待或执行中`, startedAt: generatedAt, owner: "模型能力" });
  if (latestBackupAgeHours > 26) alerts.push({ id: "backup", level: "warning", title: "备份成功标记过期", detail: backups.length ? `距最近成功标记 ${Math.round(latestBackupAgeHours)} 小时` : "未读取到备份成功标记", startedAt: generatedAt, owner: "存储治理" });
  if (requestErrors.length) alerts.push({ id: "errors", level: "warning", title: "近一小时存在失败请求", detail: `${requestErrors.length} / ${requests1h.length} 个请求失败`, startedAt: generatedAt, owner: "应用服务" });

  const active7 = users.filter(user => user.lastActiveAt && Date.now() - new Date(user.lastActiveAt).getTime() <= 7 * 86400000).length;
  const healthyServices = services.filter(item => item.status === "healthy").length;
  const commercial = {
    summary: { payingUsers: 0, mrr: 0, arppu: 0, refundRate: 0, grossMargin: 0, deferredRevenue: 0 },
    funnel: [{ stage: "完成注册", count: users.length }, { stage: "近 7 日活跃", count: active7 }, { stage: "完成付费", count: 0 }],
    plans: [{ name: "内测版", price: 0, users: users.length, aiQuota: dailyCallLimit, storageGb: attachmentQuotaBytes / GB, status: "active" }],
    ledger: []
  };

  return {
    meta: { environment: "production", mode: "readonly", version, updatedAt: generatedAt, source: "live-aggregate" },
    overview: {
      kpis: [
        { key: "users", label: "总用户", value: users.length, unit: "人", delta: "已注册账户", tone: "neutral" },
        { key: "active", label: "近 7 日活跃", value: active7, unit: "人", delta: users.length ? `${(active7 / users.length * 100).toFixed(1)}%` : "0%", tone: "neutral" },
        { key: "services", label: "健康服务", value: healthyServices, unit: `/ ${services.length}`, delta: `${services.length - healthyServices} 项关注`, tone: healthyServices === services.length ? "neutral" : "warning" },
        { key: "aiCost", label: "今日 AI 成本", value: todayAggregate.costUsd * cnyPerUsd, unit: "元", delta: `${todayAggregate.calls} 次调用`, tone: "neutral" },
        { key: "storage", label: "业务存储", value: usedGb, unit: "GiB", delta: `${attachmentMode.toUpperCase()} + 本机`, tone: "neutral" },
        { key: "incidents", label: "未关闭事件", value: alerts.length, unit: "项", delta: `${alerts.filter(item => item.level === "warning").length} 项关注`, tone: alerts.length ? "warning" : "neutral" }
      ],
      traffic,
      alerts
    },
    users,
    services,
    storage: {
      totalGb: totalStorageGb,
      usedGb,
      growth30Gb: 0,
      historyAvailable: false,
      objects: categories.reduce((sum, item) => sum + item.objects, 0),
      objectsKnown: attachmentMode !== "oss",
      orphanObjects: 0,
      orphanKnown: false,
      categories,
      backups
    },
    ai: {
      summary: {
        callsToday: todayAggregate.calls,
        successRate: todayAggregate.calls ? todayAggregate.successful / todayAggregate.calls * 100 : 100,
        p95Ms: percentile(todayAggregate.durations, 0.95),
        costToday: todayAggregate.costUsd * cnyPerUsd,
        budgetToday: Math.max(dailyCostLimitCny, dailyCostLimitCny * Math.max(1, users.length)),
        visionCalls: todayAggregate.vision,
        unknownUsage: todayAggregate.unknown
      },
      trend: days.map(day => {
        const aggregate = sumUsage(allUsage.filter(item => localDateKey(item.createdAt) === day));
        return { day: day.slice(5).replace("-", "/"), calls: aggregate.calls, cost: aggregate.costUsd * cnyPerUsd };
      }),
      models,
      scenes
    },
    commercial,
    logs: publicLogs,
    policies: [
      { name: "管理员访问策略", version: "v1", status: "observed", updatedAt: today },
      { name: "中台只读策略", version: "v1", status: "observed", updatedAt: today },
      { name: "AI 成本保护", version: "v1", status: "observed", updatedAt: today },
      { name: "日志脱敏策略", version: "v1", status: "observed", updatedAt: today }
    ],
    privacy: {
      containsRecordContent: false,
      containsPromptOrResponse: false,
      containsCredentials: false
    },
    totals: {
      allAiCalls: allAggregate.calls,
      queuedTasks
    }
  };
}
