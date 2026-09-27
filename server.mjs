import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAttachmentStorage } from "./attachment-storage.mjs";
import { appendPrivateJsonLine, changedResources, createLogger, errorMetadata, pruneLogs, redact } from "./logging.mjs";
import Imageseg from "@alicloud/imageseg20191230";
import Viapi from "@alicloud/viapi20230117";
import OpenApi from "@alicloud/openapi-client";
import Credential from "@alicloud/credentials";
import Util from "@alicloud/tea-util";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const USERS_DIR = path.join(DATA_DIR, "users");
const INVITE_CODE_HASH = String(process.env.INVITE_CODE_HASH || "").toLowerCase();
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "1" || Boolean(INVITE_CODE_HASH);
if (AUTH_REQUIRED && !/^[a-f0-9]{64}$/.test(INVITE_CODE_HASH)) throw new Error("AUTH_REQUIRED=1 requires a 64-character SHA-256 INVITE_CODE_HASH");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const APP_BASE_PATH = `/${String(process.env.APP_BASE_PATH || "").replace(/^\/+|\/+$/g, "")}`;
const UPSTREAM_ORIGIN = String(process.env.UPSTREAM_ORIGIN || "").replace(/\/+$/, "");
const SESSION_COOKIE = "for_now_session";
const SESSION_TTL_MS = 30 * 86400000;
const requestStorage = new AsyncLocalStorage();
const logEvent = createLogger({ rootDir: DATA_DIR, getContext: () => requestStorage.getStore() });
const attachmentStorage = createAttachmentStorage();
const storagePaths = () => {
  const dataDir = requestStorage.getStore()?.dataDir || DATA_DIR;
  return {
    dataDir,
    attachmentsDir: path.join(dataDir, "attachments"),
    logsDir: path.join(dataDir, "logs"),
    storeFile: path.join(dataDir, "store.json"),
    llmSettingsFile: path.join(dataDir, "llm-settings.json"),
    aiUsageFile: path.join(dataDir, "ai-usage.json")
  };
};
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const ALIYUN_REGION = "cn-shanghai";
const ALIYUN_SEGMENT_TIMEOUT_MS = 60_000;
const ALIYUN_SEGMENT_RESULT_MAX_BYTES = 24 * 1024 * 1024;
const PORT = Number(process.env.PORT || 4173);
const STORE_VERSION = 12;
const emptyStore = { version: STORE_VERSION, checkins: [], dailyRecords: [], captures: [], journals: [], journalDraft: null, thoughts: [], chats: [], books: [], keepsakes: [], quotes: [], experiments: [], analyses: [], customMetrics: [] };
const LLM_SETTINGS_VERSION = 4;
const LLM_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const LLM_EFFORTS = ["none", "high", "max"];
const LLM_TIERS = ["lite", "mid", "high", "ultra"];
const LLM_SCENARIOS = ["thoughtPrompt", "thoughtDraft", "thoughtAnswer", "followUpAnswer", "chat", "diaryLead", "diaryStructure", "diaryTopic", "diaryReflection", "annotationShenji", "analysis", "bookRecognition", "healthRecognition"];
const AI_USAGE_VERSION = 2;
const AI_AUDIT_VERSION = 1;
const AI_AUDIT_RETENTION_DAYS = Math.max(1, Math.min(3650, Number(process.env.AI_AUDIT_RETENTION_DAYS) || 30));
const AI_AUDIT_TEXT_LIMIT = Math.max(10000, Math.min(5_000_000, Number(process.env.AI_AUDIT_TEXT_LIMIT) || 1_000_000));
const AI_GLOBAL_QPS = Math.max(1, Math.min(2500, Number(process.env.AI_GLOBAL_QPS) || 20));
const AI_GLOBAL_CONCURRENCY = Math.max(1, Math.min(100, Number(process.env.AI_GLOBAL_CONCURRENCY) || 20));
const SEGMENTATION_GLOBAL_QPS = Math.max(1, Math.min(100, Number(process.env.SEGMENTATION_GLOBAL_QPS) || 5));
const SEGMENTATION_GLOBAL_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SEGMENTATION_GLOBAL_CONCURRENCY) || 5));
const AI_USER_DAILY_CALL_LIMIT = Math.max(1, Math.round(Number(process.env.AI_USER_DAILY_CALL_LIMIT) || 200));
const AI_USER_DAILY_COST_LIMIT_USD = Math.max(0.01, Number(process.env.AI_USER_DAILY_COST_LIMIT_USD) || 2);
const ATTACHMENT_USER_QUOTA_BYTES = Math.max(process.env.NODE_ENV === "test" ? 1 : 1024 * 1024, Math.round(Number(process.env.ATTACHMENT_USER_QUOTA_BYTES) || 1024 * 1024 * 1024));
const STANDARD_BODY_MAX_BYTES = 12_000_000;
const ATTACHMENT_UPLOAD_BODY_MAX_BYTES = 36_000_000;
const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const DEEPSEEK_PRICING = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-09-27",
  currency: "USD",
  unitTokens: 1_000_000,
  models: {
    "deepseek-flash": {
      label: "DeepSeek Flash",
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
    },
    "deepseek-v4-pro": {
      label: "DeepSeek Pro",
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
    }
  }
};
const defaultLlmSettings = {
  version: LLM_SETTINGS_VERSION,
  provider: "deepseek",
  profiles: {
    lite: { model: "deepseek-flash", effort: "none" },
    mid: { model: "deepseek-flash", effort: "high" },
    high: { model: "deepseek-v4-pro", effort: "high" },
    ultra: { model: "deepseek-v4-pro", effort: "max" }
  },
  scenarios: {
    thoughtPrompt: "lite",
    thoughtDraft: "high",
    thoughtAnswer: "ultra",
    followUpAnswer: "ultra",
    chat: "high",
    diaryLead: "lite",
    diaryStructure: "mid",
    diaryTopic: "high",
    diaryReflection: "ultra",
    annotationShenji: "high",
    analysis: "ultra",
    bookRecognition: "mid",
    healthRecognition: "mid"
  },
  apiKey: ""
};

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const today = () => localDateKey();
const safeText = (value, max = 12000) => String(value ?? "").trim().slice(0, max);
const stripThoughtAnswerLead = value => String(value ?? "").replace(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:核心判断|给我判断|给你(?:一个)?判断|我的判断|结论)(?:\*\*|__)?(?:\s*[：:]|\s*\n+)\s*/u, "").trimStart();
const safeDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : today();
const strictDateKey = value => {
  const text = safeText(value, 20);
  if (!text) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? text : null;
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const localDateTimeOn = (dateKey, clockValue = new Date()) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
  if (!match || Number.isNaN(clock.getTime())) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds());
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const eventTimeFields = (input = {}, existing = null) => {
  let occurredAt = "";
  if (hasOwn(input, "occurredAt")) {
    const parsed = new Date(String(input.occurredAt || ""));
    if (Number.isNaN(parsed.getTime())) return null;
    occurredAt = parsed.toISOString();
  } else if (hasOwn(input, "occurredOn")) {
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || "") ? input.occurredOn : "";
    if (!dateKey) return null;
    occurredAt = localDateTimeOn(dateKey, existing?.occurredAt || new Date());
  } else if (existing?.occurredAt) {
    const parsed = new Date(existing.occurredAt);
    if (!Number.isNaN(parsed.getTime())) occurredAt = parsed.toISOString();
  } else {
    occurredAt = now();
  }
  return occurredAt ? { occurredAt, occurredOn: localDateKey(occurredAt) } : null;
};
const clamp5 = value => Math.min(5, Math.max(1, Number(value) || 3));
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = value => value == null ? null : Math.round(value * 100) / 100;
const nullableNumber = (value, min = -Infinity, max = Infinity, integer = false) => {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const bounded = Math.min(max, Math.max(min, number));
  return integer ? Math.round(bounded) : round(bounded);
};
const safeIso = value => {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};
const WEIGHT_CLOTHING_MODEL = {
  none: { label: "不穿衣", mean: 0, lower: 0, upper: 0 },
  light: { label: "轻便衣物", mean: 0.5, lower: 0.1, upper: 0.9 },
  heavy: { label: "厚重衣物", mean: 1.5, lower: 0.5, upper: 2.5 }
};
const shiftDateKey = (dateKey, days) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return dateKey;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

function createRateGate(qps, concurrency) {
  let active = 0, starts = [], timer = null;
  const pending = [];
  const pump = () => {
    timer = null;
    const timestamp = Date.now();
    starts = starts.filter(value => timestamp - value < 1000);
    while (pending.length && active < concurrency && starts.length < qps) {
      const resolve = pending.shift();
      active += 1;
      starts.push(Date.now());
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        pump();
      });
    }
    if (pending.length && active < concurrency && !timer) {
      const delay = starts.length >= qps ? Math.max(1, 1000 - (timestamp - starts[0])) : 1;
      timer = setTimeout(pump, delay);
      timer.unref?.();
    }
  };
  return {
    acquire: () => new Promise(resolve => {
      pending.push(resolve);
      pump();
    })
  };
}

const aiGate = createRateGate(AI_GLOBAL_QPS, AI_GLOBAL_CONCURRENCY);
const segmentationGate = createRateGate(SEGMENTATION_GLOBAL_QPS, SEGMENTATION_GLOBAL_CONCURRENCY);

function normalizedOccurredOn(item, previousVersion) {
  const createdUtcDate = item.createdAt?.slice(0, 10);
  const createdLocalDate = localDateKey(item.createdAt);
  const current = item.occurredOn || createdLocalDate || today();
  if (previousVersion < 4 && current === createdUtcDate && createdLocalDate && createdLocalDate !== createdUtcDate) return createdLocalDate;
  return current;
}

function normalizedEventTime(item, previousVersion) {
  const legacyDate = normalizedOccurredOn(item, previousVersion);
  const parsed = new Date(item.occurredAt || "");
  const occurredAt = Number.isNaN(parsed.getTime()) ? localDateTimeOn(legacyDate, item.createdAt || new Date()) : parsed.toISOString();
  return { occurredAt: occurredAt || now(), occurredOn: localDateKey(occurredAt) || legacyDate };
}

function normalizeStore(value = {}) {
  const previousVersion = Number(value.version || 1), store = { ...clone(emptyStore), ...value, version: STORE_VERSION };
  for (const key of ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics"]) if (!Array.isArray(store[key])) store[key] = [];
  store.checkins = store.checkins.map(item => ({ factors: [], custom: {}, notes: {}, ...item, ...normalizedEventTime(item, previousVersion), sleep: item.sleep || 3, stress: previousVersion < 3 ? 6 - clamp5(item.stress) : clamp5(item.stress) }));
  store.dailyRecords = store.dailyRecords.map(item => {
    const normalized = { source: "manual", attachmentPaths: [], ...item, ...normalizedEventTime(item, previousVersion) };
    if (normalized.type === "weight") {
      const model = WEIGHT_CLOTHING_MODEL[normalized.clothing] || WEIGHT_CLOTHING_MODEL.none;
      const measuredWeight = nullableNumber(normalized.measuredWeight, 20, 400);
      return { ...normalized, clothing: WEIGHT_CLOTHING_MODEL[normalized.clothing] ? normalized.clothing : "none", measuredWeight, adjustmentMean: model.mean, adjustedWeight: measuredWeight == null ? null : round(measuredWeight - model.mean), lower95: measuredWeight == null ? null : round(measuredWeight - model.upper), upper95: measuredWeight == null ? null : round(measuredWeight - model.lower) };
    }
    return normalized;
  }).filter(item => ["sleep", "heartRate", "weight", "exercise"].includes(item.type));
  store.captures = store.captures.map(item => ({ tags: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion) }));
  store.journals = store.journals.map(item => ({ tags: [], reflections: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion) }));
  if (store.journalDraft && typeof store.journalDraft === "object") {
    const journalId = safeText(store.journalDraft.journalId, 100);
    store.journalDraft = {
      journalId: store.journals.some(item => item.id === journalId) ? journalId : "",
      title: safeText(store.journalDraft.title, 120),
      content: safeText(store.journalDraft.content, 50000),
      updatedAt: safeIso(store.journalDraft.updatedAt) || now()
    };
  } else store.journalDraft = null;
  delete store.bookDraft;
  store.thoughts = store.thoughts.map(item => ({ disposition: "pending", remarks: [], tags: [], followUps: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), type: item.type === "record" ? "answer" : item.type }));
  store.chats = store.chats.map(item => ({ annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion) }));
  store.books = store.books.map(item => {
    const readingStartedOn = strictDateKey(item.readingStartedOn) || "";
    const normalizedFinishedOn = strictDateKey(item.readingFinishedOn) || "";
    const book = {
      notes: [],
      annotations: [],
      annotationDrift: [],
      ...item,
      readingStartedOn,
      readingFinishedOn: readingStartedOn && normalizedFinishedOn >= readingStartedOn ? normalizedFinishedOn : ""
    };
    book.notes = book.notes.map(note => ({
      ...note,
      type: note.type === "thought" ? "thought" : "record",
      favorite: ["none", "star", "sprout"].includes(note.favorite) ? note.favorite : "none",
      ...normalizedEventTime({ createdAt: note.createdAt || book.createdAt, ...note }, previousVersion)
    }));
    return book;
  });
  store.keepsakes = store.keepsakes.map(item => ({
    category: "其他",
    note: "",
    tags: [],
    source: "manual",
    ...item,
    ...normalizedEventTime(item, previousVersion),
    tags: (Array.isArray(item.tags) ? item.tags : []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8),
    originalPath: cleanAttachmentPaths([item.originalPath])[0] || "",
    cutoutPath: cleanAttachmentPaths([item.cutoutPath])[0] || ""
  })).filter(item => item.originalPath && item.cutoutPath);
  store.quotes = store.quotes.map(item => ({ tags: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion) }));
  store.analyses = store.analyses.map(item => ({ annotations: [], annotationDrift: [], ...item }));
  return store;
}

async function writeJsonAtomic(file, value) {
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

async function auditChanges(before, after) {
  const context = requestStorage.getStore();
  if (!context?.traceId) return;
  const changes = changedResources(before, after);
  if (!changes.length) return;
  context.changeCount = (context.changeCount || 0) + changes.length;
  await logEvent("operation", "data.changed", { result: "committed", changes });
}

function normalizeLlmProfile(value, fallback) {
  return {
    model: LLM_MODELS.includes(value?.model) ? value.model : fallback.model,
    effort: LLM_EFFORTS.includes(value?.effort) ? value.effort : fallback.effort
  };
}

function legacyLlmTier(model, effort) {
  if (model === "deepseek-flash" && effort === "none") return "lite";
  if (model === "deepseek-flash") return "mid";
  if (model === "deepseek-v4-pro" && effort === "max") return "ultra";
  return "high";
}

function normalizeLlmSettings(value = {}) {
  const settings = clone(defaultLlmSettings);
  settings.apiKey = safeText(value.apiKey, 300);
  if (!value.profiles || !value.scenarios) {
    const model = LLM_MODELS.includes(value.model) ? value.model : settings.profiles.ultra.model;
    const effort = LLM_EFFORTS.includes(value.effort) ? value.effort : settings.profiles.ultra.effort;
    const tier = legacyLlmTier(model, effort);
    settings.profiles[tier] = { model, effort };
    return settings;
  }
  for (const tier of LLM_TIERS) settings.profiles[tier] = normalizeLlmProfile(value.profiles[tier], settings.profiles[tier]);
  const legacyScenarioValues = Object.entries(value.scenarios).filter(([scenario, tier]) => LLM_SCENARIOS.includes(scenario) && LLM_TIERS.includes(tier)).map(([, tier]) => tier);
  const legacyAllUltra = Number(value.version || 1) < 3
    && legacyScenarioValues.length >= 11
    && legacyScenarioValues.every(tier => tier === "ultra");
  if (!legacyAllUltra) {
    for (const scenario of LLM_SCENARIOS) settings.scenarios[scenario] = LLM_TIERS.includes(value.scenarios[scenario]) ? value.scenarios[scenario] : settings.scenarios[scenario];
  }
  return settings;
}

async function readLlmSettings() {
  return normalizeLlmSettings(await readStoredJson(storagePaths().llmSettingsFile, defaultLlmSettings));
}

async function writeLlmSettings(value) {
  const { llmSettingsFile } = storagePaths();
  const before = await readLlmSettings();
  await writeJsonAtomic(llmSettingsFile, value);
  await auditChanges(before, value);
}

function publicLlmSettings(value) {
  const settings = normalizeLlmSettings(value), primary = settings.profiles[settings.scenarios.thoughtAnswer];
  return { version: LLM_SETTINGS_VERSION, provider: "deepseek", profiles: settings.profiles, scenarios: settings.scenarios, model: primary.model, effort: primary.effort, hasApiKey: Boolean(settings.apiKey), keyHint: settings.apiKey ? `${settings.apiKey.slice(0, 3)}••••${settings.apiKey.slice(-4)}` : "" };
}

function llmSettingsForScene(settings, scene = "thoughtAnswer") {
  const normalized = normalizeLlmSettings(settings), tier = LLM_TIERS.includes(scene) ? scene : normalized.scenarios[scene] || "high";
  return { provider: "deepseek", apiKey: normalized.apiKey, tier, ...normalized.profiles[tier] };
}

async function ensureLlmSettings() {
  const { llmSettingsFile } = storagePaths();
  const original = await readStoredJson(llmSettingsFile, null);
  const settings = normalizeLlmSettings(original || {});
  if (original && Number(original.version) !== LLM_SETTINGS_VERSION) {
    const stamp = now().replace(/\D/g, "").slice(0, 14);
    const backup = `${llmSettingsFile}.v${Number(original.version || 1)}-pre-v${LLM_SETTINGS_VERSION}.${stamp}.bak`;
    await fs.copyFile(llmSettingsFile, backup);
    await fs.chmod(backup, 0o600);
  }
  await writeLlmSettings(settings);
}

async function readStore() {
  return normalizeStore(await readStoredJson(storagePaths().storeFile, emptyStore));
}

const storeWriteQueues = new Map();
function updateStore(mutator) {
  const { storeFile } = storagePaths();
  const queue = storeWriteQueues.get(storeFile) || Promise.resolve();
  const operation = queue.then(async () => {
    const store = await readStore();
    const before = clone(store);
    const result = await mutator(store);
    await writeJsonAtomic(storeFile, store);
    await auditChanges(before, store);
    return result;
  });
  storeWriteQueues.set(storeFile, operation.catch(() => {}));
  return operation;
}

async function ensureStore() {
  const { dataDir, attachmentsDir, storeFile } = storagePaths();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(attachmentsDir, 0o700);
  for (const entry of await fs.readdir(attachmentsDir, { withFileTypes: true })) {
    if (entry.isFile()) await fs.chmod(path.join(attachmentsDir, entry.name), 0o600);
  }
  const original = await readStoredJson(storeFile, null);
  if (original && Number(original.version || 1) < STORE_VERSION) {
    const stamp = now().replace(/\D/g, "").slice(0, 14);
    const backup = `${storeFile}.v${Number(original.version || 1)}-pre-v${STORE_VERSION}.${stamp}.bak`;
    await fs.copyFile(storeFile, backup);
    await fs.chmod(backup, 0o600);
  }
  await writeJsonAtomic(storeFile, normalizeStore(original || {}));
}

function normalizeAiUsage(value = {}) {
  const trackingStartedAt = safeIso(value.trackingStartedAt) || now();
  const entries = Array.isArray(value.entries) ? value.entries.filter(item => item && safeIso(item.createdAt) && LLM_MODELS.includes(item.model)).map(item => ({
    id: safeText(item.id, 100) || crypto.randomUUID(),
    callId: safeText(item.callId || item.id, 100) || crypto.randomUUID(),
    callGroupId: safeText(item.callGroupId, 100),
    traceId: safeText(item.traceId, 128),
    createdAt: safeIso(item.createdAt),
    completedAt: safeIso(item.completedAt),
    durationMs: Math.max(0, Math.round(Number(item.durationMs) || 0)),
    durationKnown: item.durationKnown == null ? hasOwn(item, "durationMs") : Boolean(item.durationKnown),
    status: ["success", "failed", "timeout", "cancelled"].includes(item.status) ? item.status : "unknown",
    httpStatus: Math.max(0, Math.round(Number(item.httpStatus) || 0)),
    errorCategory: safeText(item.errorCategory, 80),
    errorCode: safeText(item.errorCode, 120),
    provider: safeText(item.provider, 40) || "deepseek",
    providerRequestId: safeText(item.providerRequestId, 200),
    model: item.model,
    modelReturned: safeText(item.modelReturned, 100),
    scene: LLM_SCENARIOS.includes(item.scene) || LLM_TIERS.includes(item.scene) ? item.scene : "unknown",
    tier: LLM_TIERS.includes(item.tier) ? item.tier : "",
    effort: LLM_EFFORTS.includes(item.effort) ? item.effort : "",
    attempt: Math.max(1, Math.round(Number(item.attempt) || 1)),
    maxAttempts: Math.max(1, Math.round(Number(item.maxAttempts) || 1)),
    retryReason: safeText(item.retryReason, 120),
    retryScheduled: Boolean(item.retryScheduled),
    stream: Boolean(item.stream),
    responseFormat: item.responseFormat === "json_object" ? "json_object" : "text",
    maxTokens: Math.max(0, Math.round(Number(item.maxTokens) || 0)),
    finishReason: safeText(item.finishReason, 80),
    modality: ["vision", "text"].includes(item.modality) ? item.modality : "unknown",
    imageCount: Math.max(0, Math.round(Number(item.imageCount) || 0)),
    imageBytes: Math.max(0, Math.round(Number(item.imageBytes) || 0)),
    imageTypes: Array.isArray(item.imageTypes) ? item.imageTypes.map(type => safeText(type, 80)).filter(Boolean).slice(0, 8) : [],
    imageDimensions: Array.isArray(item.imageDimensions) ? item.imageDimensions.slice(0, 8).map(image => ({
      width: Math.max(0, Math.round(Number(image?.width) || 0)),
      height: Math.max(0, Math.round(Number(image?.height) || 0))
    })) : [],
    historyMessageCount: Math.max(0, Math.round(Number(item.historyMessageCount) || 0)),
    requestChars: Math.max(0, Math.round(Number(item.requestChars) || 0)),
    responseChars: Math.max(0, Math.round(Number(item.responseChars) || 0)),
    reasoningChars: Math.max(0, Math.round(Number(item.reasoningChars) || 0)),
    usageKnown: item.usageKnown == null ? Boolean(item.tokens?.input || item.tokens?.output) : Boolean(item.usageKnown),
    pricingPeriod: item.pricingPeriod === "peak" ? "peak" : "offPeak",
    tokens: {
      input: Math.max(0, Math.round(Number(item.tokens?.input) || 0)),
      cacheHit: Math.max(0, Math.round(Number(item.tokens?.cacheHit) || 0)),
      cacheMiss: Math.max(0, Math.round(Number(item.tokens?.cacheMiss) || 0)),
      reasoning: Math.max(0, Math.round(Number(item.tokens?.reasoning) || 0)),
      answer: Math.max(0, Math.round(Number(item.tokens?.answer) || 0)),
      output: Math.max(0, Math.round(Number(item.tokens?.output) || 0))
    },
    costsUsd: {
      input: Math.max(0, Number(item.costsUsd?.input) || 0),
      cacheHit: Math.max(0, Number(item.costsUsd?.cacheHit) || 0),
      reasoning: Math.max(0, Number(item.costsUsd?.reasoning) || 0),
      output: Math.max(0, Number(item.costsUsd?.output) || 0),
      total: Math.max(0, Number(item.costsUsd?.total) || 0)
    },
    ratesUsdPerMillion: {
      cacheHit: Math.max(0, Number(item.ratesUsdPerMillion?.cacheHit) || 0),
      cacheMiss: Math.max(0, Number(item.ratesUsdPerMillion?.cacheMiss) || 0),
      output: Math.max(0, Number(item.ratesUsdPerMillion?.output) || 0)
    },
    rawUsage: numericUsage(item.rawUsage)
  })) : [];
  return { version: AI_USAGE_VERSION, trackingStartedAt, entries };
}

async function readAiUsage() {
  return normalizeAiUsage(await readStoredJson(storagePaths().aiUsageFile, {}));
}

const aiUsageWriteQueues = new Map();
function updateAiUsage(mutator) {
  const { aiUsageFile } = storagePaths();
  const queue = aiUsageWriteQueues.get(aiUsageFile) || Promise.resolve();
  const operation = queue.then(async () => {
    const usage = await readAiUsage();
    const result = await mutator(usage);
    await writeJsonAtomic(aiUsageFile, usage);
    return result;
  });
  aiUsageWriteQueues.set(aiUsageFile, operation.catch(() => {}));
  return operation;
}

async function ensureAiUsage() {
  const { aiUsageFile } = storagePaths();
  const original = await readStoredJson(aiUsageFile, null);
  if (original && Number(original.version || 1) < AI_USAGE_VERSION) {
    const backup = `${aiUsageFile}.v${Number(original.version || 1)}-pre-v${AI_USAGE_VERSION}.${now().replace(/\D/g, "").slice(0, 14)}.bak`;
    await fs.copyFile(aiUsageFile, backup);
    await fs.chmod(backup, 0o600);
  }
  await updateAiUsage(() => {});
}

const aiQuotaReservations = new Map();
async function reserveAiAttempt() {
  const key = storagePaths().aiUsageFile;
  const usage = await readAiUsage(), day = new Date().toISOString().slice(0, 10);
  const entries = usage.entries.filter(item => item.createdAt.slice(0, 10) === day);
  const reserved = aiQuotaReservations.get(key) || 0;
  if (entries.length + reserved >= AI_USER_DAILY_CALL_LIMIT) {
    throw Object.assign(new Error("今日 AI 调用次数已达到上限，请明天再试"), { statusCode: 429, code: "AI_DAILY_CALL_LIMIT" });
  }
  const cost = entries.reduce((sum, item) => sum + Number(item.costsUsd?.total || 0), 0);
  if (cost >= AI_USER_DAILY_COST_LIMIT_USD) {
    throw Object.assign(new Error("今日 AI 费用额度已达到上限，请明天再试"), { statusCode: 429, code: "AI_DAILY_COST_LIMIT" });
  }
  aiQuotaReservations.set(key, reserved + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (aiQuotaReservations.get(key) || 1) - 1);
    if (next) aiQuotaReservations.set(key, next);
    else aiQuotaReservations.delete(key);
  };
}

function auditText(value) {
  const text = String(value ?? "");
  return text.length <= AI_AUDIT_TEXT_LIMIT ? text : `${text.slice(0, AI_AUDIT_TEXT_LIMIT)}\n[TRUNCATED ${text.length - AI_AUDIT_TEXT_LIMIT} CHARS]`;
}

function auditMessage(message = {}) {
  const role = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "unknown";
  if (typeof message.content === "string") return { role, content: auditText(message.content) };
  if (!Array.isArray(message.content)) return { role, content: "" };
  return {
    role,
    content: message.content.map(item => item?.type === "text"
      ? { type: "text", text: auditText(item.text) }
      : { type: safeText(item?.type, 40) || "unknown", omitted: true })
  };
}

function auditDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

async function recordAiAudit(entry) {
  const file = path.join(storagePaths().logsDir, `ai-audit-${auditDateKey(entry.startedAt)}.ndjson`);
  await appendPrivateJsonLine(file, redact({ schemaVersion: AI_AUDIT_VERSION, type: "ai.invocation", ...entry }, requestStorage.getStore()?.secrets || []));
}

async function startAiAudit(entry) {
  try {
    await recordAiAudit({ ...entry, status: "started" });
  } catch (error) {
    await logEvent("system", "ai.log_failed", { level: "error", callId: entry.callId, target: "audit_start", error: errorMetadata(error) });
  }
}

async function ensureAuditLogs() {
  await pruneLogs(storagePaths().logsDir, AI_AUDIT_RETENTION_DAYS);
}

function sendJson(res, status, value) {
  const context = requestStorage.getStore();
  if (context) {
    context.applicationStatus = status;
    if (status >= 400) context.errorCode ||= safeText(value?.code, 100) || `HTTP_${status}`;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

const wantsEventStream = req => String(req.headers.accept || "").includes("text/event-stream");

function sendStreamEvent(res, value) {
  if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function respondWithModel(req, res, { prompt, options = {}, complete = (content, reasoningContent) => ({ content, reasoningContent }), status = 200 }) {
  if (!wantsEventStream(req)) {
    const result = await runDeepSeek(prompt, { ...options, captureReasoning: true });
    return sendJson(res, status, await complete(result.content, result.reasoningContent));
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  sendStreamEvent(res, { type: "phase", phase: "context" });
  try {
    const result = await runDeepSeek(prompt, {
      ...options,
      captureReasoning: true,
      onDelta: ({ type, delta }) => sendStreamEvent(res, { type, delta })
    });
    const completed = await complete(result.content, result.reasoningContent);
    sendStreamEvent(res, { type: "done", result: completed });
  } catch (error) {
    const context = requestStorage.getStore();
    if (context) { context.applicationStatus = 500; context.errorCode = error.code || "MODEL_RESPONSE_FAILED"; }
    await logEvent("system", "response.stream_failed", { level: "error", error: errorMetadata(error) });
    sendStreamEvent(res, { type: "error", error: redact(error.message || "模型回答失败", context?.secrets || []) });
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

async function bodyJson(req, maxBytes = STANDARD_BODY_MAX_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("内容过长"), { statusCode: 413, code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let value;
  try { value = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("请求内容不是有效 JSON"), { statusCode: 400, code: "INVALID_JSON" }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("请求内容必须是对象"), { statusCode: 400, code: "INVALID_BODY" });
  const context = requestStorage.getStore();
  if (context) {
    context.requestBytes = bytes;
    for (const key of ["apiKey", "password", "currentPassword", "newPassword", "invitation"]) if (typeof value[key] === "string" && value[key]) context.secrets.push(value[key]);
  }
  return value;
}

async function proxyToUpstream(req, res, url) {
  const chunks = [], maxBytes = url.pathname === "/api/images/upload" ? ATTACHMENT_UPLOAD_BODY_MAX_BYTES : STANDARD_BODY_MAX_BYTES;
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) return sendJson(res, 413, { error: "内容过长", code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {};
  for (const name of ["accept", "content-type", "cookie", "user-agent"]) if (req.headers[name]) headers[name] = req.headers[name];
  headers["x-request-id"] = requestStorage.getStore().traceId;
  headers["x-forwarded-for"] = req.socket.remoteAddress || "unknown";
  const response = await fetch(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
  const responseHeaders = {};
  for (const name of ["content-type", "cache-control", "location", "x-accel-buffering", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() || (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  if (cookies.length) {
    const localPath = APP_BASE_PATH === "/" ? "/" : APP_BASE_PATH;
    responseHeaders["set-cookie"] = cookies.map(cookie => cookie.replace(/Path=\/now(?=;|$)/i, `Path=${localPath}`));
  }
  res.writeHead(response.status, responseHeaders);
  if (!response.body) return res.end();
  for await (const chunk of response.body) {
    if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once("drain", resolve));
  }
  res.end();
}

const authWriteState = { queue: Promise.resolve() };
const loginAttempts = new Map();
const passwordHash = password => new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16);
  crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(`scrypt$${salt.toString("base64")}$${derived.toString("base64")}`));
});
const passwordMatches = (password, encoded) => new Promise(resolve => {
  const [, saltText, hashText] = String(encoded || "").split("$");
  if (!saltText || !hashText) return resolve(false);
  const expected = Buffer.from(hashText, "base64");
  crypto.scrypt(password, Buffer.from(saltText, "base64"), expected.length, (error, derived) => {
    resolve(!error && expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
  });
});
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const usernameError = username => /^[\p{L}\p{N}_.-]{3,32}$/u.test(username) ? "" : "用户名需为 3–32 位文字、数字、点、横线或下划线";
const passwordError = password => password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password) ? "" : "密码需为 8–128 位，且同时包含字母和数字";
const publicUser = user => ({ id: user.id, username: user.username, createdAt: user.createdAt });
const userDataDir = user => path.join(USERS_DIR, user.id);

async function readAuth() {
  const value = await readStoredJson(AUTH_FILE, { version: 1, users: [], sessions: [] });
  if (!Array.isArray(value.users) || !Array.isArray(value.sessions)) {
    await logEvent("system", "storage.read_failed", { level: "error", file: "auth.json", error: { code: "INVALID_AUTH_DOCUMENT" } });
    throw Object.assign(new Error("认证数据无法读取，已保留原文件，请联系管理员"), { code: "STORAGE_READ_FAILED" });
  }
  return { version: 1, users: value.users, sessions: value.sessions };
}

function updateAuth(mutator) {
  const operation = authWriteState.queue.then(async () => {
    const auth = await readAuth();
    const before = clone(auth);
    auth.sessions = auth.sessions.filter(session => new Date(session.expiresAt).getTime() > Date.now());
    const result = await mutator(auth);
    await writeJsonAtomic(AUTH_FILE, auth);
    await fs.chmod(AUTH_FILE, 0o600);
    await auditChanges(before, auth);
    return result;
  });
  authWriteState.queue = operation.catch(() => {});
  return operation;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const pathValue = APP_BASE_PATH === "/" ? "/" : APP_BASE_PATH;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${pathValue}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`;
}

async function requestUser(req) {
  if (!AUTH_REQUIRED) {
    const user = { id: "local", username: "本机用户", createdAt: "" };
    if (requestStorage.getStore()) requestStorage.getStore().user = user;
    return user;
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256(token), auth = await readAuth();
  const session = auth.sessions.find(item => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
  const user = session ? auth.users.find(user => user.id === session.userId) || null : null;
  if (user && requestStorage.getStore()) Object.assign(requestStorage.getStore(), { user, dataDir: userDataDir(user) });
  return user;
}

async function issueSession(res, user, auth = null) {
  if (requestStorage.getStore()) Object.assign(requestStorage.getStore(), { user, dataDir: userDataDir(user) });
  const token = crypto.randomBytes(32).toString("base64url");
  const session = { tokenHash: sha256(token), userId: user.id, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
  if (auth) auth.sessions.push(session);
  else await updateAuth(value => value.sessions.push(session));
  res.setHeader("set-cookie", sessionCookie(token));
}

async function initializeUserStorage(user, importLegacy = false) {
  const target = userDataDir(user);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.chmod(target, 0o700);
  if (importLegacy) {
    for (const name of ["store.json", "llm-settings.json", "ai-usage.json"]) {
      try { await fs.copyFile(path.join(DATA_DIR, name), path.join(target, name), fs.constants.COPYFILE_EXCL); } catch (error) { if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error; }
    }
    for (const name of ["attachments", "logs"]) {
      try { await fs.cp(path.join(DATA_DIR, name), path.join(target, name), { recursive: true, errorOnExist: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  await requestStorage.run({ ...requestStorage.getStore(), user, dataDir: target }, async () => {
    await ensureStore();
    await ensureLlmSettings();
    await ensureAiUsage();
    await ensureAuditLogs();
  });
}

function loginAttemptKey(req, username) {
  const remote = req.socket.remoteAddress || "unknown";
  const forwarded = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return `${forwarded || remote}:${username}`;
}

function loginAllowed(key) {
  const recent = (loginAttempts.get(key) || []).filter(value => Date.now() - value < 15 * 60000);
  loginAttempts.set(key, recent);
  return recent.length < 8;
}

async function authApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await requestUser(req), auth = AUTH_REQUIRED ? await readAuth() : null;
    return sendJson(res, user ? 200 : 401, { authenticated: Boolean(user), authRequired: AUTH_REQUIRED, registrationAvailable: !AUTH_REQUIRED || Boolean(INVITE_CODE_HASH), user: user ? publicUser(user) : null, userCount: auth?.users.length || 0 });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "本机模式无需注册" });
    const input = await bodyJson(req), username = safeText(input.username, 32), password = String(input.password || ""), invitation = String(input.invitation || "");
    const invalidUsername = usernameError(username), invalidPassword = passwordError(password);
    if (invalidUsername) return sendJson(res, 400, { error: invalidUsername });
    if (invalidPassword) return sendJson(res, 400, { error: invalidPassword });
    const suppliedInviteHash = sha256(invitation);
    const expected = Buffer.from(INVITE_CODE_HASH, "hex"), supplied = Buffer.from(suppliedInviteHash, "hex");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return sendJson(res, 403, { error: "内测码无效" });
    const hashed = await passwordHash(password);
    let created;
    try {
      created = await updateAuth(async auth => {
        if (auth.users.some(user => user.username.toLocaleLowerCase() === username.toLocaleLowerCase())) throw Object.assign(new Error("用户名已存在"), { statusCode: 409 });
        const user = { id: crypto.randomUUID(), username, passwordHash: hashed, createdAt: now() };
        await initializeUserStorage(user, auth.users.length === 0);
        auth.users.push(user);
        await issueSession(res, user, auth);
        return user;
      });
    } catch (error) {
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message });
      throw error;
    }
    return sendJson(res, 201, { authenticated: true, user: publicUser(created) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "本机模式无需登录" });
    const input = await bodyJson(req), username = safeText(input.username, 32), password = String(input.password || ""), key = loginAttemptKey(req, username.toLocaleLowerCase());
    if (!loginAllowed(key)) return sendJson(res, 429, { error: "登录尝试过多，请 15 分钟后再试" });
    const auth = await readAuth(), user = auth.users.find(item => item.username.toLocaleLowerCase() === username.toLocaleLowerCase());
    if (!user || !await passwordMatches(password, user.passwordHash)) {
      loginAttempts.get(key).push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 250));
      return sendJson(res, 401, { error: "用户名或密码错误" });
    }
    loginAttempts.delete(key);
    await issueSession(res, user);
    return sendJson(res, 200, { authenticated: true, user: publicUser(user) });
  }
  if (req.method === "PATCH" && url.pathname === "/api/auth/username") {
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "本机模式无需账户管理" });
    const requester = await requestUser(req);
    if (!requester) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
    const input = await bodyJson(req), username = safeText(input.username, 32), invalidUsername = usernameError(username);
    if (invalidUsername) return sendJson(res, 400, { error: invalidUsername });
    try {
      const updated = await updateAuth(auth => {
        const user = auth.users.find(item => item.id === requester.id);
        if (!user) throw Object.assign(new Error("账户不存在"), { statusCode: 404 });
        if (auth.users.some(item => item.id !== user.id && item.username.toLocaleLowerCase() === username.toLocaleLowerCase())) throw Object.assign(new Error("用户名已存在"), { statusCode: 409 });
        user.username = username;
        user.updatedAt = now();
        return user;
      });
      return sendJson(res, 200, { authenticated: true, user: publicUser(updated) });
    } catch (error) {
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message });
      throw error;
    }
  }
  if (req.method === "PATCH" && url.pathname === "/api/auth/password") {
    if (!AUTH_REQUIRED) return sendJson(res, 400, { error: "本机模式无需账户管理" });
    const requester = await requestUser(req);
    if (!requester) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
    const input = await bodyJson(req), currentPassword = String(input.currentPassword || ""), newPassword = String(input.newPassword || ""), invalidPassword = passwordError(newPassword);
    if (invalidPassword) return sendJson(res, 400, { error: invalidPassword });
    const tokenHash = sha256(parseCookies(req)[SESSION_COOKIE] || "");
    try {
      const updated = await updateAuth(async auth => {
        const user = auth.users.find(item => item.id === requester.id);
        if (!user) throw Object.assign(new Error("账户不存在"), { statusCode: 404 });
        if (!await passwordMatches(currentPassword, user.passwordHash)) throw Object.assign(new Error("当前密码不正确"), { statusCode: 403 });
        user.passwordHash = await passwordHash(newPassword);
        user.updatedAt = now();
        auth.sessions = auth.sessions.filter(session => session.userId !== user.id || session.tokenHash === tokenHash);
        return user;
      });
      return sendJson(res, 200, { authenticated: true, user: publicUser(updated) });
    } catch (error) {
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token && AUTH_REQUIRED) await updateAuth(auth => { auth.sessions = auth.sessions.filter(item => item.tokenHash !== sha256(token)); });
    res.setHeader("set-cookie", sessionCookie("", 0));
    return sendJson(res, 200, { authenticated: false });
  }
  return false;
}

function cleanAttachmentPaths(value) {
  return (Array.isArray(value) ? value : []).map(item => safeText(item, 300)).filter(item => /^\/attachments\/[\w.-]+$/.test(item)).slice(0, 2);
}

const attachmentWriteQueues = new Map();
const attachmentOwnerId = () => safeText(requestStorage.getStore()?.user?.id, 100) || "local";
const cleanupTemporaryFiles = files => Promise.all(files.map(file => fs.unlink(file).catch(() => {})));

async function saveImageDataUrls(images, maxImages = 1, { persist = true, needsLocalFiles = false, maxBytes = DEFAULT_IMAGE_MAX_BYTES } = {}) {
  const { dataDir, attachmentsDir } = storagePaths(), ownerId = attachmentOwnerId();
  if (!images.length || images.length > maxImages) throw new Error(maxImages > 1 ? `请选择 1～${maxImages} 张图片` : "请选择 1 张图片");
  let totalBytes = 0;
  const decoded = images.map(image => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(image || "");
    if (!match) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
    const data = Buffer.from(match[2], "base64");
    totalBytes += data.length;
    if (!data.length || data.length > maxBytes || totalBytes > maxBytes) {
      throw new Error(`单张及本次图片总大小均不得超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    const dimensions = imageDimensions(data, match[1]);
    if (!dimensions.width || !dimensions.height) throw new Error("图片内容与格式不匹配");
    const ext = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg", name = `${crypto.randomUUID()}.${ext}`, file = path.join(attachmentsDir, name);
    return { data, mimeType: match[1], name, file };
  });
  const operation = async () => {
    if (persist) {
      const used = await attachmentStorage.usageBytes({ ownerId, localDir: attachmentsDir });
      if (used + totalBytes > ATTACHMENT_USER_QUOTA_BYTES) {
        throw Object.assign(new Error("附件空间已达到当前账户上限，请删除不再需要的图片后重试"), { statusCode: 413, code: "ATTACHMENT_QUOTA_EXCEEDED" });
      }
    }
    const files = [], attachmentPaths = [], stored = [];
    try {
      for (const item of decoded) {
        let file = item.file;
        if (!persist || (attachmentStorage.mode !== "local" && needsLocalFiles)) {
          const tempDir = path.join(dataDir, "tmp");
          await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
          await fs.chmod(tempDir, 0o700);
          file = path.join(tempDir, item.name);
          await fs.writeFile(file, item.data, { mode: 0o600 });
          files.push(file);
        }
        if (persist) {
          await attachmentStorage.put({ ownerId, name: item.name, data: item.data, mimeType: item.mimeType, localFile: item.file });
          stored.push(item);
          attachmentPaths.push(`/attachments/${item.name}`);
          if (attachmentStorage.mode === "local" && needsLocalFiles) files.push(item.file);
        }
      }
      return { files, attachmentPaths, cleanupFiles: attachmentStorage.mode === "local" && persist ? [] : files };
    } catch (error) {
      await Promise.all(stored.map(item => attachmentStorage.remove({ ownerId, name: item.name, localFile: item.file }).catch(() => {})));
      await cleanupTemporaryFiles(files);
      throw error;
    }
  };
  if (!persist) return operation();
  const key = `${storagePaths().dataDir}:${ownerId}`, queue = attachmentWriteQueues.get(key) || Promise.resolve();
  const result = queue.then(operation);
  const settled = result.catch(() => {});
  attachmentWriteQueues.set(key, settled);
  try {
    return await result;
  } finally {
    if (attachmentWriteQueues.get(key) === settled) attachmentWriteQueues.delete(key);
  }
}

function normalizedLocalDateTimeText(value) {
  const text = safeText(value, 40).replace(" ", "T");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/.exec(text);
  return match ? `${match[1]}:${match[2] || "00"}` : "";
}

function normalizeParsedImage(kind, value = {}) {
  if (kind === "sleep") {
    const deepMinutes = nullableNumber(value.deepMinutes, 0, 1440, true), lightMinutes = nullableNumber(value.lightMinutes, 0, 1440, true), remMinutes = nullableNumber(value.remMinutes, 0, 1440, true);
    const stageTotal = [deepMinutes, lightMinutes, remMinutes].every(Number.isFinite) ? deepMinutes + lightMinutes + remMinutes : null;
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(value.date || "") ? value.date : "",
      bedtime: normalizedLocalDateTimeText(value.bedtime),
      wakeTime: normalizedLocalDateTimeText(value.wakeTime),
      totalMinutes: nullableNumber(value.totalMinutes, 0, 1440, true) ?? stageTotal,
      deepMinutes, deepPercent: nullableNumber(value.deepPercent, 0, 100),
      lightMinutes, lightPercent: nullableNumber(value.lightPercent, 0, 100),
      remMinutes, remPercent: nullableNumber(value.remPercent, 0, 100),
      awakeCount: nullableNumber(value.awakeCount, 0, 100, true),
      awakeMinutes: nullableNumber(value.awakeMinutes, 0, 1440, true),
      averageHeartRate: nullableNumber(value.averageHeartRate, 20, 250),
      averageOxygen: nullableNumber(value.averageOxygen, 50, 100),
      respiratoryRate: nullableNumber(value.respiratoryRate, 1, 80),
      verification: safeText(value.verification, 500)
    };
  }
  if (kind === "heartRate") {
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(value.date || "") ? value.date : "",
      minimum: nullableNumber(value.minimum, 20, 250),
      maximum: nullableNumber(value.maximum, 20, 250),
      average: nullableNumber(value.average, 20, 250),
      resting: nullableNumber(value.resting, 20, 250),
      sleepAverage: nullableNumber(value.sleepAverage, 20, 250),
      trendAnalysis: safeText(value.trendAnalysis, 1200),
      trendSegments: (Array.isArray(value.trendSegments) ? value.trendSegments : []).slice(0, 8).map(item => ({
        period: safeText(item?.period, 80),
        direction: ["下降", "上升", "平稳", "波动"].includes(item?.direction) ? item.direction : "波动",
        approximateRange: safeText(item?.approximateRange, 80)
      })).filter(item => item.period),
      verification: safeText(value.verification, 500)
    };
  }
  return {
    title: safeText(value.title, 300),
    author: safeText(value.author, 200),
    publisher: safeText(value.publisher, 200),
    isbn: safeText(value.isbn, 80),
    description: safeText(value.description, 2000),
    verification: safeText(value.verification, 500)
  };
}

async function parseImageRequest(input, kind) {
  const config = IMAGE_PARSE_CONFIG[kind];
  if (!config) throw new Error("不支持这种截图类型");
  const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
  if (kind === "sleep" && !images.length) throw new Error("睡眠识别需要 1～2 张图片");
  const { files, attachmentPaths, cleanupFiles } = await saveImageDataUrls(images, config.maxImages, { needsLocalFiles: true });
  try {
    const referenceDate = /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate || "") ? input.referenceDate : today();
    const dateContext = kind === "book" ? "" : `\n当前记录界面选择的参考日期是 ${referenceDate}。截图只有月日而没有年份时，使用与参考日期最近的同月日补全年份，并在 verification 中明确说明年份来自参考日期推断。`;
    const raw = await runDeepSeek(`${config.prompt}${dateContext}`, { scene: config.scene, imagePaths: files, json: true, maxTokens: 4000 });
    let parsed = {};
    try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}"); }
    catch { throw new Error("截图已读取，但模型返回格式无法解析，请重试或手动填写"); }
    return { ...normalizeParsedImage(kind, parsed), attachmentPaths };
  } catch (error) {
    await Promise.all(attachmentPaths.map(attachmentPath => {
      const name = attachmentPath.slice("/attachments/".length);
      return attachmentStorage.remove({
        ownerId: attachmentOwnerId(),
        name,
        localFile: path.join(storagePaths().attachmentsDir, name)
      }).catch(() => {});
    }));
    throw error;
  } finally {
    await cleanupTemporaryFiles(cleanupFiles);
  }
}

const KEEPSAKE_CATEGORIES = ["小票", "纸品", "立牌", "小物", "其他"];
let aliyunSegmentationClients = null;

function getAliyunSegmentationClients() {
  if (aliyunSegmentationClients) return aliyunSegmentationClients;
  const roleName = safeText(process.env.ALIBABA_CLOUD_ECS_RAM_ROLE, 128);
  const credential = roleName
    ? new Credential.default({
        type: "ecs_ram_role",
        roleName,
        disableIMDSv1: String(process.env.ALIBABA_CLOUD_IMDSV1_DISABLED || "true").toLowerCase() !== "false"
      })
    : new Credential.default();
  const config = endpoint => new OpenApi.Config({ credential, endpoint, regionId: ALIYUN_REGION });
  aliyunSegmentationClients = {
    imageseg: new Imageseg.default(config(`imageseg.${ALIYUN_REGION}.aliyuncs.com`)),
    viapi: new Viapi.default(config(`viapi.${ALIYUN_REGION}.aliyuncs.com`))
  };
  return aliyunSegmentationClients;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function auditedSegmentationCall(action, callGroupId, request, invoke, summarize = result => result?.body || {}) {
  const context = requestStorage.getStore() || {}, startedAt = now(), startedMs = Date.now(), callId = crypto.randomUUID();
  const entry = {
    id: callId, callId, callGroupId, traceId: context.traceId || "", actor: { userId: context.user?.id || "local" },
    provider: "aliyun", scene: "keepsakeSegmentation", action, startedAt, attempt: 1, maxAttempts: 1,
    request, usage: { known: false, applicable: false, reason: "Non-token API; billing available from Alibaba Cloud only" }
  };
  await startAiAudit(entry);
  let response = {}, failure = null;
  try {
    const result = await invoke();
    response = summarize(result);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const durationMs = Date.now() - startedMs, status = failure ? "failed" : "success";
    try {
      await recordAiAudit({ ...entry, completedAt: now(), durationMs, status, response, error: failure ? errorMetadata(failure) : null });
    } catch (error) {
      await logEvent("system", "ai.log_failed", { level: "error", callId, target: "audit", error: errorMetadata(error) });
    }
    await logEvent("system", "dependency.completed", {
      level: failure ? "error" : "info", provider: "aliyun", action, callId, callGroupId, durationMs, status,
      error: failure ? errorMetadata(failure) : null
    });
  }
}

function parseAliyunSegmentResult(value) {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return safeText(parsed.imageUrl || parsed.ImageUrl || parsed.imageURL || parsed.ImageURL, 4000);
  } catch {
    throw new Error("主体识别服务返回了无法解析的结果");
  }
}

async function waitForAliyunSegmentResult(client, jobId, callGroupId) {
  const startedAt = Date.now();
  const runtime = new Util.RuntimeOptions({ connectTimeout: 10_000, readTimeout: 20_000, autoretry: false, maxAttempts: 1 });
  while (Date.now() - startedAt < ALIYUN_SEGMENT_TIMEOUT_MS) {
    const response = await auditedSegmentationCall("GetAsyncJobResult", callGroupId, {
      jobId,
      parameters: { connectTimeout: 10_000, readTimeout: 20_000, autoretry: false, maxAttempts: 1 }
    },
      () => client.getAsyncJobResultWithOptions(new Viapi.GetAsyncJobResultRequest({ jobId }), runtime));
    const data = response?.body?.data || {};
    if (data.status === "PROCESS_SUCCESS") {
      const imageUrl = parseAliyunSegmentResult(data.result);
      if (!imageUrl) throw new Error("主体识别服务没有返回透明轮廓");
      return imageUrl;
    }
    if (["PROCESS_FAILED", "TIMEOUT_FAILED", "LIMIT_RETRY_FAILED"].includes(data.status)) {
      throw new Error(`主体识别失败${data.errorMessage ? `：${safeText(data.errorMessage, 160)}` : ""}`);
    }
    await wait(1000);
  }
  throw new Error("主体识别等待超时，请稍后重试");
}

async function downloadAliyunSegmentResult(imageUrl) {
  let url;
  try { url = new URL(imageUrl); } catch { throw new Error("主体识别服务返回了无效的图片地址"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("主体识别服务返回了无效的图片地址");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`透明轮廓下载失败（HTTP ${response.status}）`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > ALIYUN_SEGMENT_RESULT_MAX_BYTES) throw new Error("透明轮廓图片过大");
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > ALIYUN_SEGMENT_RESULT_MAX_BYTES) throw new Error("透明轮廓图片大小无效");
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("主体识别服务没有返回 PNG 图片");
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("透明轮廓下载超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function segmentKeepsakeImage(input) {
  const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
  const { files } = await saveImageDataUrls(images, 1, { persist: false, needsLocalFiles: true });
  const callGroupId = crypto.randomUUID();
  try {
    const image = (await deepSeekImageInput(files[0], 0)).audit;
    const mockCutout = process.env.NODE_ENV === "test" ? safeText(process.env.KEEPSAKE_SEGMENT_MOCK_RESULT, ALIYUN_SEGMENT_RESULT_MAX_BYTES * 2) : "";
    if (mockCutout) {
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(mockCutout)) throw new Error("测试轮廓不是有效的 PNG Data URL");
      const mockDelay = Math.max(0, Math.min(5000, Number(process.env.KEEPSAKE_SEGMENT_MOCK_DELAY_MS) || 0));
      if (mockDelay) await wait(mockDelay);
      return await auditedSegmentationCall("SegmentHDCommonImage", callGroupId, { images: [image], mocked: true },
        async () => ({ cutout: mockCutout, provider: "aliyun-segment-hd" }), () => ({ mocked: true }));
    }
    const { imageseg, viapi } = getAliyunSegmentationClients();
    const runtime = new Util.RuntimeOptions({ connectTimeout: 10_000, readTimeout: 30_000, autoretry: false, maxAttempts: 1 });
    const response = await auditedSegmentationCall("SegmentHDCommonImage", callGroupId, {
      images: [image],
      region: ALIYUN_REGION,
      parameters: { connectTimeout: 10_000, readTimeout: 30_000, autoretry: false, maxAttempts: 1 }
    },
      () => imageseg.segmentHDCommonImageAdvance(new Imageseg.SegmentHDCommonImageAdvanceRequest({ imageUrlObject: createReadStream(files[0]) }), runtime));
    let imageUrl = safeText(response?.body?.data?.imageUrl, 4000);
    if (!imageUrl) {
      const jobId = safeText(response?.body?.requestId, 200);
      if (!jobId) throw new Error("主体识别服务没有返回任务编号");
      imageUrl = await waitForAliyunSegmentResult(viapi, jobId, callGroupId);
    }
    const cutout = await auditedSegmentationCall("DownloadSegmentResult", callGroupId, { imageUrl },
      () => downloadAliyunSegmentResult(imageUrl), result => {
        const data = Buffer.from(result.split(",")[1], "base64");
        return { mimeType: "image/png", bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
      });
    return { cutout, provider: "aliyun-segment-hd" };
  } catch (error) {
    await logEvent("system", "segmentation.failed", { level: "error", callGroupId, error: errorMetadata(error) });
    if (/图片|轮廓|主体识别|测试轮廓/.test(error.message || "")) throw error;
    if (/InvalidCredentials|AccessKey|credential|Forbidden|Unauthorized|403/i.test(error.message || error.code || "")) {
      throw new Error("主体识别服务尚未配置完成，请联系管理员");
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(error.message || error.code || "")) throw new Error("主体识别服务响应超时，请稍后重试");
    throw new Error("主体识别服务暂时不可用，请稍后重试");
  } finally {
    await Promise.all(files.map(file => fs.unlink(file).catch(() => {})));
  }
}

function keepsakePayload(input, existing = null) {
  const title = safeText(input.title, 120);
  if (!title) return { error: "请填写小物名称" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "留存时间格式不正确" };
  const originalPath = hasOwn(input, "originalPath") ? cleanAttachmentPaths([input.originalPath])[0] || "" : existing?.originalPath || "";
  const cutoutPath = hasOwn(input, "cutoutPath") ? cleanAttachmentPaths([input.cutoutPath])[0] || "" : existing?.cutoutPath || "";
  const tags = (hasOwn(input, "tags") ? (Array.isArray(input.tags) ? input.tags : []) : existing?.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8);
  if (!originalPath || !cutoutPath) return { error: "请先保存原图和透明轮廓图" };
  return {
    value: {
      ...eventTime,
      title,
      category: KEEPSAKE_CATEGORIES.includes(input.category) ? input.category : existing?.category || "其他",
      note: safeText(input.note, 2000),
      tags,
      originalPath,
      cutoutPath,
      source: input.source === "auto" ? "auto" : existing?.source || "manual",
      edgeExpansion: Math.max(0, Math.min(20, Number(input.edgeExpansion) || 0))
    }
  };
}

function dailyRecordPayload(input, existing = null) {
  const type = ["sleep", "heartRate", "weight", "exercise"].includes(input.type) ? input.type : existing?.type;
  if (!type) return { error: "记录类型无效" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  const common = {
    type,
    ...eventTime,
    source: input.source === "screenshot" ? "screenshot" : existing?.source || "manual",
    attachmentPaths: cleanAttachmentPaths(hasOwn(input, "attachmentPaths") ? input.attachmentPaths : existing?.attachmentPaths)
  };
  if (type === "sleep") {
    const bedtime = safeIso(input.bedtime), wakeTime = safeIso(input.wakeTime);
    const deepMinutes = nullableNumber(input.deepMinutes, 0, 1440, true), lightMinutes = nullableNumber(input.lightMinutes, 0, 1440, true), remMinutes = nullableNumber(input.remMinutes, 0, 1440, true);
    const totalMinutes = nullableNumber(input.totalMinutes, 0, 1440, true) ?? ([deepMinutes, lightMinutes, remMinutes].every(Number.isFinite) ? deepMinutes + lightMinutes + remMinutes : null);
    if (totalMinutes == null && !bedtime && !wakeTime) return { error: "请填写睡眠总时长或入睡、醒来时间" };
    return { value: { ...common, bedtime, wakeTime, totalMinutes, deepMinutes, deepPercent: nullableNumber(input.deepPercent, 0, 100), lightMinutes, lightPercent: nullableNumber(input.lightPercent, 0, 100), remMinutes, remPercent: nullableNumber(input.remPercent, 0, 100), awakeCount: nullableNumber(input.awakeCount, 0, 100, true), awakeMinutes: nullableNumber(input.awakeMinutes, 0, 1440, true), averageHeartRate: nullableNumber(input.averageHeartRate, 20, 250), averageOxygen: nullableNumber(input.averageOxygen, 50, 100), respiratoryRate: nullableNumber(input.respiratoryRate, 1, 80) } };
  }
  if (type === "heartRate") {
    const minimum = nullableNumber(input.minimum, 20, 250), maximum = nullableNumber(input.maximum, 20, 250), average = nullableNumber(input.average, 20, 250);
    if (![minimum, maximum, average].some(Number.isFinite)) return { error: "请至少填写心率范围或平均心率" };
    if (minimum != null && maximum != null && minimum > maximum) return { error: "最低心率不能高于最高心率" };
    return { value: { ...common, minimum, maximum, average, resting: nullableNumber(input.resting, 20, 250), sleepAverage: nullableNumber(input.sleepAverage, 20, 250), trendAnalysis: safeText(input.trendAnalysis, 1200), trendSegments: (Array.isArray(input.trendSegments) ? input.trendSegments : []).slice(0, 8).map(item => ({ period: safeText(item.period, 80), direction: safeText(item.direction, 20), approximateRange: safeText(item.approximateRange, 80) })).filter(item => item.period) } };
  }
  if (type === "weight") {
    const measuredWeight = nullableNumber(input.measuredWeight, 20, 400), clothing = WEIGHT_CLOTHING_MODEL[input.clothing] ? input.clothing : "none", model = WEIGHT_CLOTHING_MODEL[clothing];
    if (measuredWeight == null) return { error: "请填写体重" };
    return { value: { ...common, measuredWeight, clothing, adjustmentMean: model.mean, adjustedWeight: round(measuredWeight - model.mean), lower95: round(measuredWeight - model.upper), upper95: round(measuredWeight - model.lower) } };
  }
  const description = safeText(input.description, 5000);
  if (!description) return { error: "请描述这次运动" };
  return { value: { ...common, description } };
}

function classify(text, tags = []) {
  const value = `${text} ${tags.join(" ")}`.toLowerCase();
  const groups = [
    ["工作与创造", ["工作", "项目", "职业", "同事", "产品", "创作", "任务"]],
    ["关系与连接", ["关系", "朋友", "家人", "伴侣", "社交", "沟通"]],
    ["身心状态", ["睡眠", "情绪", "压力", "疲惫", "焦虑", "健康", "运动", "身体"]],
    ["学习与成长", ["学习", "阅读", "能力", "课程", "复盘", "成长", "知识"]],
    ["选择与方向", ["选择", "决定", "目标", "方向", "未来", "要不要", "价值", "意义"]],
    ["金钱与消费", ["理财", "消费", "收入", "储备金", "价格", "支付能力"]]
  ];
  return groups.find(([, words]) => words.some(word => value.includes(word)))?.[0] || tags[0] || "待慢慢看清";
}

function clusters(store) {
  const map = new Map();
  const roots = store.thoughts.filter(item => item.type === "question");
  for (const item of roots) {
    const theme = classify(item.content, item.tags);
    if (!map.has(theme)) map.set(theme, []);
    map.get(theme).push(item);
  }
  return [...map.entries()].map(([theme, items]) => ({
    theme, count: items.length,
    questions: items.length,
    kept: items.filter(item => item.disposition === "kept").length,
    discarded: items.filter(item => item.disposition === "discarded").length,
    unreviewed: items.filter(item => item.disposition === "pending").length,
    items: items.sort((a, b) => (b.occurredAt || b.createdAt).localeCompare(a.occurredAt || a.createdAt))
  })).sort((a, b) => b.count - a.count);
}

function isUntouchedAiAnswer(item) {
  const content = safeText(item?.content);
  const modelDraft = safeText(item?.modelDraft);
  return item?.type === "answer"
    && Boolean(modelDraft)
    && content === modelDraft
    && !item.editedFromModel
    && !item.updatedAt
    && !["manual", "deepseek-edited"].includes(item.origin);
}

function thoughtHasUserTrace(store, root) {
  const children = store.thoughts.filter(item => item.relatedTo === root.id);
  return Boolean(
    root.updatedAt
    || root.dispositionAt
    || (root.annotations || []).length
    || (root.annotationDrift || []).length
    || (root.remarks || []).length
    || (root.followUps || []).length
    || children.some(item => item.type === "idea" && safeText(item.content))
    || children.some(item => item.type === "answer" && !isUntouchedAiAnswer(item) && (safeText(item.content) || safeText(item.modelDraft)))
  );
}

function thoughtIsUntouchedAiOnly(store, root) {
  const answers = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "answer");
  return answers.some(isUntouchedAiAnswer) && !thoughtHasUserTrace(store, root);
}

function insights(store) {
  const ordered = [...store.checkins].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || (a.occurredAt || a.createdAt).localeCompare(b.occurredAt || b.createdAt));
  const dates = [...new Set(ordered.map(item => item.occurredOn))].sort();
  const byDate = new Map(dates.map(date => [date, ordered.filter(item => item.occurredOn === date)]));
  const daily = dates.map(date => Object.fromEntries(["mood", "energy", "stress", "sleep"].map(metric => [
    metric, avg(byDate.get(date).map(item => Number(item[metric])).filter(Number.isFinite))
  ])));
  const recent = daily.slice(-7), previous = daily.slice(-14, -7);
  const trends = ["mood", "energy", "stress", "sleep"].map(metric => {
    const currentValues = recent.map(item => Number(item[metric])).filter(Number.isFinite);
    const previousValues = previous.map(item => Number(item[metric])).filter(Number.isFinite);
    return { metric, current: round(avg(currentValues)), previous: round(avg(previousValues)), currentCount: currentValues.length, previousCount: previousValues.length };
  });
  const factorNames = [...new Set(ordered.flatMap(item => item.factors || []))];
  const confidenceRank = { "单日观察": 1, "初步线索": 2, "可观察": 3 };
  const associationEvidence = item => Math.min(item.withCount, item.withoutCount) + item.nextDayCount;
  const associationEffect = item => item.baseline == null ? 0 : Math.max(
    ...[item.sameDay, item.nextDay].filter(Number.isFinite).map(value => Math.abs(value - item.baseline)),
    0
  );
  const associations = factorNames.map(factor => {
    const withFactor = [], withoutFactor = [], nextDay = [];
    dates.forEach(date => {
      const entries = byDate.get(date); const mood = avg(entries.map(item => item.mood));
      const present = entries.some(item => (item.factors || []).includes(factor));
      (present ? withFactor : withoutFactor).push(mood);
      const nextEntries = byDate.get(shiftDateKey(date, 1));
      if (present && nextEntries) nextDay.push(avg(nextEntries.map(item => item.mood)));
    });
    const confidence = withFactor.length >= 10 && withoutFactor.length >= 10 && nextDay.length >= 5 && dates.length >= 30
      ? "可观察"
      : withFactor.length >= 2 ? "初步线索" : "单日观察";
    return { factor, withCount: withFactor.length, withoutCount: withoutFactor.length, nextDayCount: nextDay.length, sameDay: round(avg(withFactor)), baseline: round(avg(withoutFactor)), nextDay: round(avg(nextDay)), confidence };
  }).sort((a, b) =>
    confidenceRank[b.confidence] - confidenceRank[a.confidence]
    || associationEvidence(b) - associationEvidence(a)
    || associationEffect(b) - associationEffect(a)
    || a.factor.localeCompare(b.factor, "zh-CN")
  ).slice(0, 3);
  const weekAgo = shiftDateKey(today(), -6);
  const weekRoots = store.thoughts.filter(item => item.type === "question" && (item.occurredOn || item.createdAt.slice(0, 10)) >= weekAgo);
  const answeredRoots = weekRoots.filter(root => store.thoughts.some(item => item.relatedTo === root.id && item.type === "answer"));
  const currentDate = today(), monthAgo = shiftDateKey(currentDate, -29);
  const itemDate = item => {
    const timestamp = item?.occurredAt || item?.createdAt;
    return item?.occurredOn || (timestamp ? localDateKey(timestamp) : "");
  };
  const inWindow = (item, cutoff) => {
    const date = itemDate(item);
    return date >= cutoff && date <= currentDate;
  };
  const activeDates = new Set([
    ...store.checkins, ...store.dailyRecords, ...store.captures, ...store.journals,
    ...store.thoughts.filter(item => item.type === "question"), ...store.chats, ...store.quotes,
    ...store.books.flatMap(book => book.notes || []), ...store.keepsakes
  ].filter(item => inWindow(item, weekAgo)).map(itemDate));
  const checkinDates30 = new Set(store.checkins.filter(item => inWindow(item, monthAgo)).map(itemDate));
  const healthDates30 = new Set(store.dailyRecords.filter(item => inWindow(item, monthAgo)).map(itemDate));
  const pairedDays30 = [...checkinDates30].filter(date => healthDates30.has(date)).length;
  const roots30 = store.thoughts.filter(item => item.type === "question" && inWindow(item, monthAgo));
  const tracedRoots30 = roots30.filter(root => thoughtHasUserTrace(store, root));
  const aiOnlyThoughtIds = store.thoughts
    .filter(item => item.type === "question" && thoughtIsUntouchedAiOnly(store, item))
    .map(item => item.id);
  const annotationRoots = [
    ...store.captures, ...store.journals, ...store.thoughts, ...store.chats,
    ...store.books, ...store.quotes, ...store.analyses
  ];
  const annotations = annotationRoots.flatMap(root => [...(root.annotations || []), ...(root.annotationDrift || [])]);
  const correctionActions30 = [
    ...store.thoughts.filter(item => item.type === "answer" && item.editedFromModel).map(item => ({ ...item, occurredOn: localDateKey(item.updatedAt || item.createdAt || item.occurredAt) })),
    ...store.thoughts.flatMap(root => root.followUps || []),
    ...store.thoughts.flatMap(root => root.remarks || []),
    ...annotations,
    ...annotations.flatMap(annotation => annotation.replies || []),
    ...store.journals.flatMap(journal => journal.reflections || []),
    ...store.analyses.filter(item => item.reason === "manual")
  ].filter(item => inWindow(item, monthAgo)).length;
  const latestAnalysisDate = store.analyses.map(item => localDateKey(item.createdAt)).filter(Boolean).sort().at(-1) || "";
  const reviewAgeDays = latestAnalysisDate
    ? Math.max(0, Math.round((Date.parse(`${currentDate}T00:00:00Z`) - Date.parse(`${latestAnalysisDate}T00:00:00Z`)) / 86400000))
    : null;
  return {
    trends,
    associations,
    aiOnlyThoughtIds,
    weekly: {
      checkins: recent.length,
      thoughts: weekRoots.length,
      questions: weekRoots.length,
      answers: answeredRoots.length,
      kept: weekRoots.filter(item => item.disposition === "kept").length,
      activeDays7: activeDates.size,
      pairedDays30,
      rootCount30: roots30.length,
      tracedRoots30: tracedRoots30.length,
      traceRate30: roots30.length ? Math.round(tracedRoots30.length / roots30.length * 100) : null,
      correctionActions30,
      reviewAgeDays,
      analysisCount: store.analyses.length
    }
  };
}

const SYSTEM_PROMPT = `你是这个本地个人成长项目的长期陪伴者。目标是提供有深度、可读、与用户当前认知水平相适应的判断，而不是堆字数或炫耀术语。
稳定规则：
1. 结论先行，直接回答真正的问题；不要先汇报读取了哪些记录，不输出文件路径、数据清单或隐藏思考过程。
2. 深度来自准确的概念区分、明确的判断、关键理由、反例与边界，不来自篇幅。只保留 2～4 个最能改变结论的论点，避免同义反复、机械复述和模板化总结。
3. 区分可核验事实、用户观点、合理推断与价值判断；相关性不能写成因果，记录中的缺席不能直接解释为回避。
4. 不只顺着用户已有观点。检查隐含前提、强反例、遗漏的利益相关者、信息茧房和认知偏差，但不要为了显得独立而刻意反对。
5. 遇到哲学、价值、意义或其他抽象问题，先用 2～4 句补足理解答案所必需的背景或概念区分，再给明确主张及理由。不能只抛问题、罗列流派或用“因人而异”回避判断。
6. 用用户能自然读懂的语言。必要术语第一次出现时用一句白话解释；除非精确性确有需要，不使用晦涩概念和过密层级。
7. 个人记录只作为静默语境；仅当它会实质改变判断时才自然引用。行动建议只在问题需要时给出，并且具体、最小、可执行。
8. 需要公式时使用 LaTeX 定界符；不确定或可能变化的事实明确适用边界与核验需要。`;

const SHENJI_SYSTEM_PROMPT = `你是“神鸡”，一个有 SOUL 的人工智能回答助手。
SOUL 不是表演个性，而是保持独立判断、求真务实、对用户真正有帮助。
1. 不做“顺毛驴”：禁止先例行赞美、先默认赞成，再沿着用户原话展开。先判断问题、前提和用词是否成立。
2. 如果用户用词不当、不准确或概念混淆，直接给出更准确的词并解释差别；语气坦率，但不刻薄。
3. 大胆指出潜在矛盾、遗漏前提、反例、利益冲突和认知盲区。不能为了制造冲突而反对，也不能把猜测说成事实。
4. 先给对标记内容的明确判断，再给最关键的依据、边界或修正。抽象观点要补足必要背景，不能只用追问代替回答。
5. 情绪价值只能服务于事实与行动，不能替代分析。优先给真实判断、适用边界、证据需求和可执行建议。
6. 深度不等于长；删除不改变判断的复述、铺垫和泛泛建议，术语要随手解释成白话。
7. 回答必须特别聚焦被划线/评论的内容和本轮用户输入；原始问题与前后文用于消歧，不能喧宾夺主。
8. 直接回答，不汇报读取过程，不输出隐藏思考过程。`;

const DIARY_SYSTEM_PROMPT = `你是一个克制、敏锐的日记回望助手。你的职责不是替用户写日记，而是帮助用户看清自己刚写下的经历。
1. 只依据用户写下的内容和明确提供的个人语境，不补写未发生的事实，不把猜测写成结论。
2. 区分事件、感受、解释、需要和行动；用户没有写到的层面明确标为“可能”或不讨论。
3. 不做心理诊断，不用空泛鼓励，不强迫积极。发现矛盾、回避或认知偏差时，以可核验的语言指出。
4. 必须给出自己的综合判断，不要把回望写成日记摘要或一串问题；判断要说明来自哪些原文线索，并标清不确定性。
5. 输出固定为四个简短部分：“我听见的主线”“值得辨认的层次”“一个诚实的问题”“明天最小一步”。前两部分负责给观点，后两部分才负责追问和行动。
6. “一个诚实的问题”只能有一个；“明天最小一步”必须足够小，也允许明确建议先休息或暂不行动。
7. 用贴近日记原文的白话表达，删掉不影响判断的复述和铺垫。直接回应，不汇报读取过程，不输出隐藏思考过程。`;

const DIARY_ASSIST_SYSTEM_PROMPT = `你是日记写作过程中的轻量助手，只提供短小的思维锚点，不替用户写完日记。
1. 必须把用户已经写下的文字作为最高优先级材料，承接而不重复、不覆盖、不改写原文。
2. 只能依据提供的记录；没有记录时用开放问句，不得编造事件、情绪或行动。
3. 输出应当能直接追加到日记末尾，不要解释你的工作方式，不要输出隐藏思考过程。
4. 克制、具体、简短，避免空泛鼓励、心理诊断和大段分析。`;
const JOURNAL_ASSIST_MARKERS = { lead: "🗃", structure: "🏷", topic: "💬" };
function markJournalAssistContent(mode, content) {
  const marker = JOURNAL_ASSIST_MARKERS[mode] || "";
  return String(content || "").trim().split(/\r?\n/).map(line => {
    if (!line.trim() || !marker || line.trimStart().startsWith(marker)) return line;
    return `${marker} ${line.trimStart()}`;
  }).join("\n");
}

const THOUGHT_PROMPT_SYSTEM_PROMPT = `你是帮助用户开始写下一条思考的轻量助手。
1. 只给一个自然、具体、容易接着写的问题，不替用户回答，不输出标题、解释或隐藏思考过程。
2. 有历史记录时，挑一个尚可推进、反复出现或与所选日期相关的线索，向前追问一步；不得硬凑关联或编造事实。
3. 没有历史记录时，给一个轻巧、有一点俏皮、贴近日常体验的问题，让用户感到不必写得正确或完整；避免空泛的“你今天感觉如何”。
4. 语气友善但不奉承，不做心理诊断，不打鸡血。问题控制在 18～55 个汉字。`;

const SCENE_RESPONSE_CONTRACTS = {
  thoughtPrompt: "本场景只输出一个 18～55 个汉字的问句，不使用 Markdown，不追加解释。",
  thoughtDraft: `本场景输出契约：
- 这是可编辑草稿，优先形成明确观点，不追求面面俱到。
- 正文直接从回答内容开始，禁止用“核心判断”“结论”“我的判断”“给我判断”“给你一个判断”等元标签或 Markdown 标题开场。
- 简单问题约 250～450 个汉字，复杂或抽象问题约 450～750 个汉字；字数是上限意识，不是凑字要求。
- 抽象或哲学问题先补 2～4 句必要背景，再明确表态；不得只留下一串开放问题。`,
  thoughtAnswer: `本场景输出契约：
- 开头 1～2 句直接回答问题，再展开最关键的 2～4 个理由、反例或边界。
- 直接写出判断句，禁止用“核心判断”“结论”“我的判断”“给我判断”“给你一个判断”等元标签或 Markdown 标题开场。
- 简单问题约 250～500 个汉字，复杂或抽象问题约 500～900 个汉字；足以说清即可，不为结构完整而重复总结。
- 抽象或哲学问题必须给必要背景和明确主张，不能只介绍观点或反问用户。`,
  followUpAnswer: `本场景输出契约：
- 只解决当前追问，默认约 250～600 个汉字；仅引用会改变本轮结论的旧上下文。
- 必须给明确回答及理由，不机械重述原始回答，不用新问题替代答案。`,
  chat: `本场景输出契约：
- 默认约 200～600 个汉字，一轮只推进一个核心判断；简单问题可以明显更短。
- 先回答，再按需补背景、边界或行动。严肃抽象问题允许更深入，但不得用长铺垫掩盖立场。`,
  diaryLead: "本场景严格遵守当前任务规定的句数与字数，不追加解释。",
  diaryStructure: "本场景严格遵守当前任务规定的列表数量与单条字数，不追加前言、示例或结语。",
  diaryTopic: "本场景严格遵守当前任务规定的句数与字数，不展开分析。",
  diaryReflection: `本场景输出契约：
- 四个指定部分合计约 350～700 个汉字，重点是给出有依据的综合判断，不复述整篇日记。
- “一个诚实的问题”只能有一个，其余部分使用陈述句表达观点。`,
  annotationShenji: `本场景输出契约：
- 默认约 250～600 个汉字，第一段直接判断标记内容成立、部分成立还是需要修正。
- 聚焦最关键的概念差异、证据、反例或改写建议；不能只提问或泛谈整个主题。`,
  analysis: `本场景输出契约：
- 先给 100 字以内的总判断；证据有限时也要基于已有记录给出 1～2 条暂定观察，证据充足时选择 3～5 条最值得行动的发现。
- 低样本复盘可以明显短于 800 字；证据充足时全文通常约 800～1400 个汉字。宁可少而扎实，不为覆盖所有领域制造推断。
- 每条必须包含明确判断与不确定性；提问只能用于校正判断，不能替代观点。`,
  bookRecognition: "本场景只输出任务指定的 JSON，不要 Markdown 代码块、前言或补充解释。",
  healthRecognition: "本场景是健康截图的结构化转录。只输出任务指定的 JSON，不要 Markdown 代码块、前言、医疗诊断或补充解释；看不清的字段必须返回 null，禁止猜测。"
};

const IMAGE_PARSE_CONFIG = {
  book: {
    scene: "bookRecognition",
    maxImages: 1,
    prompt: `识别这张书籍截图的书名和作者，并用模型已有知识补充出版社、ISBN和一句话简介。
只输出 JSON：{"title":"","author":"","publisher":"","isbn":"","description":"","verification":"图片识别/模型知识补全，未联网核验"}。不确定留空。`
  },
  sleep: {
    scene: "healthRecognition",
    maxImages: 2,
    prompt: `以下图片来自同一次睡眠记录，可能分别是睡眠总览和记录详情。合并图片信息并转录，不做医疗判断。
时间统一为 24 小时制；minutes 字段只填整数分钟；百分比填 0～100 的数字；图片没有显示的字段返回 null。
日期必须输出 YYYY-MM-DD。若总览只显示月日，优先使用详情页的完整年份；occurredAt 使用醒来时间。
只输出 JSON：
{"date":"YYYY-MM-DD","bedtime":"YYYY-MM-DDTHH:mm:ss","wakeTime":"YYYY-MM-DDTHH:mm:ss","totalMinutes":null,"deepMinutes":null,"deepPercent":null,"lightMinutes":null,"lightPercent":null,"remMinutes":null,"remPercent":null,"awakeCount":null,"awakeMinutes":null,"averageHeartRate":null,"averageOxygen":null,"respiratoryRate":null,"verification":"简短说明已读取哪些图片及哪些字段缺失"}。`
  },
  heartRate: {
    scene: "healthRecognition",
    maxImages: 1,
    prompt: `转录这张心率日视图，不做医疗诊断。日期输出 YYYY-MM-DD，心率均为 bpm 数字；看不清返回 null。
同时根据柱状图概括当天趋势：只描述图中可见的时段、相对升降和峰谷，不编造逐小时精确值，不评价健康与否。
只输出 JSON：
{"date":"YYYY-MM-DD","minimum":null,"maximum":null,"average":null,"resting":null,"sleepAverage":null,"trendAnalysis":"","trendSegments":[{"period":"","direction":"下降/上升/平稳/波动","approximateRange":""}],"verification":"简短说明图中可直接核对的字段"}。`
  }
};

function systemPromptForScene(systemPrompt, scene) {
  const contract = SCENE_RESPONSE_CONTRACTS[scene];
  return contract ? `${systemPrompt}\n\n${contract}` : systemPrompt;
}

function diaryActivityContext(store, occurredOn) {
  const previousDate = shiftDateKey(occurredOn, -1);
  const describeDate = date => {
    const checkins = store.checkins.filter(item => item.occurredOn === date).slice(0, 5).map(item => `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`);
    const dailyRecords = store.dailyRecords.filter(item => item.occurredOn === date).slice(0, 8).map(describeDailyRecord);
    const captures = store.captures.filter(item => item.occurredOn === date).slice(0, 8).map(item => `捕念：${item.content}`);
    const journals = store.journals.filter(item => item.occurredOn === date).slice(0, 3).map(item => `日记${item.title ? `《${item.title}》` : ""}：${item.content}`);
    const thoughts = store.thoughts.filter(item => item.type === "question" && item.occurredOn === date).slice(0, 8).map(item => `思绪：${item.content}`);
    return [...checkins, ...dailyRecords, ...captures, ...journals, ...thoughts].join("\n") || "（暂无记录）";
  };
  const recent = [
    ...store.captures.map(item => ({ date: item.occurredOn, text: `捕念：${item.content}` })),
    ...store.journals.map(item => ({ date: item.occurredOn, text: `日记${item.title ? `《${item.title}》` : ""}：${item.content}` })),
    ...store.thoughts.filter(item => item.type === "question").map(item => ({ date: item.occurredOn, text: `思绪：${item.content}` }))
  ].filter(item => item.date <= occurredOn).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 16).map(item => `${item.date} ${item.text}`).join("\n");
  return `<diary_activity_context>
<selected_date>${occurredOn}</selected_date>
<today_records>${describeDate(occurredOn)}</today_records>
<previous_date>${previousDate}</previous_date>
<previous_day_records>${describeDate(previousDate)}</previous_day_records>
<recent_records>${recent || "（暂无记录）"}</recent_records>
</diary_activity_context>`;
}

function thoughtPromptContext(store, occurredOn) {
  const entries = [
    ...store.captures.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `捕念：${safeText(item.content, 500)}` })),
    ...store.journals.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `日记${item.title ? `《${safeText(item.title, 80)}》` : ""}：${safeText(item.content, 700)}` })),
    ...store.thoughts.filter(item => item.type === "question").map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `曾经的问题：${safeText(item.content, 500)}` })),
    ...store.chats.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `长期对话中的提问：${safeText(item.message, 500)}` })),
    ...store.checkins.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.map(value => safeText(value, 40)).join("、")}` : ""}` })),
    ...store.dailyRecords.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: describeDailyRecord(item) }))
  ].filter(item => item.date && item.date <= occurredOn).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 12);
  return {
    hasHistory: entries.length > 0,
    text: entries.length ? entries.map((item, index) => `${index + 1}. ${item.date} ${item.text}`).join("\n") : "（没有历史记录）"
  };
}

function describeDailyRecord(item) {
  if (item.type === "sleep") return `睡眠：${item.totalMinutes == null ? "时长未填" : `${item.totalMinutes}分钟`}；深睡${item.deepMinutes ?? "?"} / 浅睡${item.lightMinutes ?? "?"} / REM${item.remMinutes ?? "?"}分钟；睡眠心率${item.averageHeartRate ?? "?"}；血氧${item.averageOxygen ?? "?"}%`;
  if (item.type === "heartRate") return `心率：范围${item.minimum ?? "?"}～${item.maximum ?? "?"}，平均${item.average ?? "?"}，静息${item.resting ?? "?"}，睡眠平均${item.sleepAverage ?? "?"} bpm${item.trendAnalysis ? `；趋势：${item.trendAnalysis}` : ""}`;
  if (item.type === "weight") return `体重：实测${item.measuredWeight}kg，衣物校正后${item.adjustedWeight}kg${item.clothing === "none" ? "" : `（95%估计区间${item.lower95}～${item.upper95}kg）`}`;
  return `运动：${item.description}`;
}

function userAnswerContext(store) {
  const roots = store.thoughts.filter(item => item.type === "question").slice(0, 40);
  const tagCounts = new Map();
  for (const item of store.thoughts) for (const tag of item.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const focus = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag]) => tag);
  const recent = roots.map((root, index) => {
    const ideas = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "idea").map(item => item.content).join("\n");
    const answers = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "answer").map(item => item.content).join("\n");
    return `${index + 1}. 问题：${root.content}\n初步想法：${ideas || "（无）"}\n已保留回答：${answers || "（无）"}\n标签：${(root.tags || []).join("、") || "（无）"}`;
  }).join("\n\n");
  const recentCheckins = store.checkins.slice(0, 30).map(item => `${item.occurredOn} 情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`).join("\n");
  const recentDailyRecords = store.dailyRecords.slice(0, 40).map(item => `${item.occurredOn} ${describeDailyRecord(item)}`).join("\n");
  const recentCaptures = store.captures.slice(0, 30).map(item => `${item.occurredOn}：${item.content}${item.tags?.length ? `（${item.tags.join("、")}）` : ""}`).join("\n");
  const recentJournals = store.journals.slice(0, 12).map(item => `${item.occurredOn}${item.title ? `《${item.title}》` : ""}：${item.content}`).join("\n\n");
  return `<personal_context>
- 风格：结论先行，以判断密度而非篇幅体现深度；只保留最关键的论点，避免重复总结。抽象问题补足必要背景并明确表态，不能只抛问题。
- 关注：重视原理、证据、权威信息、不同思想框架之间的比较，以及结论背后的适用边界。
- 校正：不要只顺着用户已有观点；主动检查前提、反例、遗漏利益相关者、信息茧房与可能的认知偏差。必须把“有记录支持的观察”和“待验证猜测”分开，缺席本身不能证明回避。
- 当前高频标签：${focus.length ? focus.join("、") : "尚未形成"}。
- 最近状态（最多30次）：
${recentCheckins || "（暂无）"}
- 最近生理与运动记录（最多40条；体重分析使用校正值和区间）：
${recentDailyRecords || "（暂无）"}
- 最近捕念（最多30条）：
${recentCaptures || "（暂无）"}
- 最近日记（最多12篇）：
${recentJournals || "（暂无）"}
- 最近思绪（最多40套，保留完整文本）：
${recent || "（暂无）"}
</personal_context>`;
}

function thoughtChainContext(store, root, currentFollowUpId = "") {
  const ideas = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "idea").map(item => item.content);
  const answers = store.thoughts.filter(item => item.relatedTo === root.id && item.type === "answer").map(item => item.content || item.modelDraft || "");
  const followUps = (root.followUps || []).map((item, index) => `<follow_up index="${index + 1}" id="${item.id}"${item.id === currentFollowUpId ? ' current="true"' : ""}>
<question>${item.question}</question>
<answer>${item.answer || "（尚未回答）"}</answer>
</follow_up>`).join("\n");
  return `<complete_thought_chain>
<original_question>${root.content}</original_question>
<initial_ideas>${ideas.length ? ideas.join("\n\n") : "（暂无）"}</initial_ideas>
<original_answers>${answers.filter(Boolean).length ? answers.filter(Boolean).join("\n\n") : "（暂无）"}</original_answers>
<all_follow_ups>${followUps || "（无）"}</all_follow_ups>
</complete_thought_chain>`;
}

function userPrompt({ context = "", chain = "", task = "" }) {
  return `${context}\n\n${chain}\n\n<current_task>\n${task}\n</current_task>`;
}

function inlineMarkdownText(value) {
  return String(value || "")
    .replace(/\\\((.+?)\\\)/g, "$1")
    .replace(/(^|[^\\])\$([^$\n]+)\$/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
}

function markdownText(value) {
  const displayMath = [];
  const source = String(value || "").replace(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g, (_, bracket, dollars) => {
    const token = `\n\u0000DISPLAY${displayMath.length}\u0000\n`;
    displayMath.push((bracket ?? dollars ?? "").trim());
    return token;
  });
  const lines = source.replace(/\r\n?/g, "\n").split("\n"), output = [];
  let paragraph = [], listItems = [], quote = [], code = [], inCode = false;
  const flushParagraph = () => { if (paragraph.length) { output.push(inlineMarkdownText(paragraph.join(""))); paragraph = []; } };
  const flushList = () => { if (listItems.length) { output.push(listItems.map(inlineMarkdownText).join("")); listItems = []; } };
  const flushQuote = () => { if (quote.length) { output.push(markdownText(quote.join("\n"))); quote = []; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const display = line.match(/^\u0000DISPLAY(\d+)\u0000$/);
    if (display) { flushAll(); output.push(displayMath[Number(display[1])] || ""); continue; }
    if (/^```\s*[\w-]*\s*$/.test(line)) { if (inCode) { output.push(code.join("\n")); code = []; inCode = false; } else { flushAll(); inCode = true; } continue; }
    if (inCode) { code.push(line); continue; }
    const next = lines[index + 1] || "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      flushAll(); const headers = line.replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim()), rows = []; index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(lines[index].replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim())); index += 1; }
      index -= 1; output.push(headers.map(inlineMarkdownText).join("") + rows.map(row => headers.map((_, cellIndex) => inlineMarkdownText(row[cellIndex] || "")).join("")).join("")); continue;
    }
    if (!line.trim()) { flushAll(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { flushAll(); output.push(inlineMarkdownText(heading[2])); continue; }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { flushAll(); continue; }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/), ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) { flushParagraph(); flushQuote(); listItems.push((unordered || ordered)[1]); continue; }
    const quoted = line.match(/^\s*>\s?(.*)$/); if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    flushList(); flushQuote(); paragraph.push(line);
  }
  if (inCode) output.push(code.join("\n")); else flushAll();
  return output.join("");
}

function annotationDisplayText(source) {
  return markdownText(source);
}

function annotationSourceText(store, root, targetKey) {
  if (targetKey === `question:${root.id}`) return markdownText(root.content);
  const [type, id] = String(targetKey || "").split(":");
  if (type === "idea" || type === "answer") return markdownText(store.thoughts.find(item => item.id === id && item.relatedTo === root.id)?.content || "");
  const followUp = (root.followUps || []).find(item => item.id === id);
  if (type === "followup-question") return markdownText(followUp?.question || "");
  if (type === "followup-answer") return markdownText(followUp?.answer || "");
  return "";
}

function annotationResource(store, resourceType, resourceId) {
  const collections = { capture: "captures", journal: "journals", chat: "chats", analysis: "analyses", book: "books", quote: "quotes" };
  if (resourceType === "thought") return store.thoughts.find(item => item.id === resourceId && item.type === "question");
  const collection = collections[resourceType];
  return collection ? store[collection].find(item => item.id === resourceId) : null;
}

function annotationResourceSource(store, resourceType, root, targetKey) {
  if (!root) return "";
  if (resourceType === "thought") return annotationSourceText(store, root, targetKey);
  if (resourceType === "capture" || resourceType === "analysis" || resourceType === "quote") return targetKey === "content" ? markdownText(root.content) : "";
  if (resourceType === "chat") return targetKey === "message" ? markdownText(root.message) : targetKey === "answer" ? markdownText(root.answer) : "";
  if (resourceType === "journal") {
    if (targetKey === "content") return markdownText(root.content);
    const [type, id] = String(targetKey || "").split(":");
    return type === "reflection" ? markdownText((root.reflections || []).find(item => item.id === id)?.content || "") : "";
  }
  if (resourceType === "book") {
    if (targetKey === "description") return markdownText(root.description);
    const [type, id] = String(targetKey || "").split(":");
    return type === "note" ? markdownText((root.notes || []).find(item => item.id === id)?.content || "") : "";
  }
  return "";
}

function annotationResourceContext(resourceType, root) {
  if (resourceType === "thought") return { label: "主题思考", title: root.content };
  if (resourceType === "capture") return { label: "捕念", title: root.content };
  if (resourceType === "journal") return { label: "日记", title: root.title || root.content };
  if (resourceType === "chat") return { label: "长期对话", title: root.message };
  if (resourceType === "analysis") return { label: "认知复盘", title: root.content };
  if (resourceType === "book") return { label: "读书笔记", title: root.title };
  if (resourceType === "quote") return { label: "善言", title: root.source };
  return { label: "正文", title: "" };
}

function annotationExcerpt(source, annotation) {
  let start = Math.max(0, Number(annotation.start) || 0), end = Math.max(start, Number(annotation.end) || start);
  if (source.slice(start, end) !== annotation.quote) { const found = source.indexOf(annotation.quote); if (found >= 0) { start = found; end = found + annotation.quote.length; } }
  return { before: source.slice(Math.max(0, start - 1000), start), focus: annotation.quote, after: source.slice(end, end + 1000) };
}

function annotationAnchorContext(source, start, end, quote) {
  const raw = String(source || ""), focus = String(quote || "");
  let rawStart = Math.max(0, Number(start) || 0);
  if (raw.slice(rawStart, rawStart + focus.length) !== focus) {
    const candidates = []; let cursor = raw.indexOf(focus);
    while (cursor >= 0) { candidates.push(cursor); cursor = raw.indexOf(focus, cursor + 1); }
    if (candidates.length) rawStart = candidates.reduce((best, value) => Math.abs(value - rawStart) < Math.abs(best - rawStart) ? value : best, candidates[0]);
  }
  const rawEnd = rawStart + focus.length;
  return { rawStart, contextBefore: raw.slice(Math.max(0, rawStart - 240), rawStart), contextAfter: raw.slice(rawEnd, rawEnd + 240), originalContext: { before: raw.slice(Math.max(0, rawStart - 1000), rawStart), focus, after: raw.slice(rawEnd, rawEnd + 1000) } };
}

function commonPrefixLength(a = "", b = "") { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; }
function commonSuffixLength(a = "", b = "") { return commonPrefixLength([...a].reverse().join(""), [...b].reverse().join("")); }

function bestAnnotationAnchor(source, annotation) {
  const raw = String(source || ""), quote = String(annotation.quote || "");
  if (!quote) return null;
  const candidates = []; let cursor = raw.indexOf(quote);
  while (cursor >= 0) { candidates.push(cursor); cursor = raw.indexOf(quote, cursor + 1); }
  if (!candidates.length) return null;
  const priorRawStart = Number.isFinite(Number(annotation.rawStart)) ? Number(annotation.rawStart) : Number(annotation.start) || 0;
  return candidates.map(start => {
    const before = raw.slice(Math.max(0, start - 240), start), after = raw.slice(start + quote.length, start + quote.length + 240);
    const contextScore = commonSuffixLength(annotation.contextBefore || annotation.originalContext?.before || "", before) * 4 + commonPrefixLength(annotation.contextAfter || annotation.originalContext?.after || "", after) * 4;
    return { start, score: contextScore - Math.min(500, Math.abs(start - priorRawStart)) / 500 };
  }).sort((a, b) => b.score - a.score)[0].start;
}

function reanchorAnnotations(root, targetKey, oldSource, newSource, reason = "正文已修改") {
  root.annotations ||= []; root.annotationDrift ||= [];
  const oldDisplay = annotationDisplayText(oldSource), newDisplay = annotationDisplayText(newSource);
  const keep = [];
  for (const annotation of root.annotations) {
    if (annotation.targetKey !== targetKey) { keep.push(annotation); continue; }
    const oldAnchor = annotationAnchorContext(oldDisplay, annotation.start, annotation.end, annotation.quote);
    annotation.originalContext ||= oldAnchor.originalContext;
    const nextRawStart = bestAnnotationAnchor(newDisplay, { ...annotation, rawStart: oldAnchor.rawStart, contextBefore: oldAnchor.contextBefore, contextAfter: oldAnchor.contextAfter });
    if (nextRawStart == null) { root.annotationDrift.push({ ...annotation, driftedAt: now(), driftReason: reason, originalTargetKey: targetKey }); continue; }
    const next = annotationAnchorContext(newDisplay, nextRawStart, nextRawStart + annotation.quote.length, annotation.quote);
    annotation.start = nextRawStart; annotation.end = nextRawStart + annotation.quote.length;
    annotation.rawStart = nextRawStart; annotation.contextBefore = next.contextBefore; annotation.contextAfter = next.contextAfter; annotation.updatedAt = now();
    keep.push(annotation);
  }
  root.annotations = keep;
}

function deepSeekPricingPeriod(createdAt) {
  const date = new Date(createdAt), day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? "peak" : "offPeak";
}

function normalizedDeepSeekUsage(usage = {}) {
  usage = numericUsage(usage) || {};
  const input = Math.max(0, Math.round(Number(usage.prompt_tokens) || 0));
  const cacheHit = Math.max(0, Math.min(input, Math.round(Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0)));
  const cacheMiss = Math.max(0, Math.round(Number(usage.prompt_cache_miss_tokens) || (input - cacheHit)));
  const output = Math.max(0, Math.round(Number(usage.completion_tokens) || 0));
  const reasoning = Math.max(0, Math.min(output, Math.round(Number(usage.completion_tokens_details?.reasoning_tokens) || 0)));
  return { input, cacheHit, cacheMiss, reasoning, answer: Math.max(0, output - reasoning), output };
}

function numericUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return Object.fromEntries(Object.entries(usage).flatMap(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) return [[key, value]];
    const nested = value && typeof value === "object" ? numericUsage(value) : null;
    return nested ? [[key, nested]] : [];
  }));
}

function deepSeekUsageEntry({ usage, model, createdAt, ...metadata }) {
  const usageKnown = Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
  const tokens = normalizedDeepSeekUsage(usageKnown ? usage : null);
  const pricingPeriod = deepSeekPricingPeriod(createdAt), rates = DEEPSEEK_PRICING.models[model]?.[pricingPeriod];
  const costsUsd = {
    input: rates ? tokens.cacheMiss * rates.cacheMiss / DEEPSEEK_PRICING.unitTokens : 0,
    cacheHit: rates ? tokens.cacheHit * rates.cacheHit / DEEPSEEK_PRICING.unitTokens : 0,
    reasoning: rates ? tokens.reasoning * rates.output / DEEPSEEK_PRICING.unitTokens : 0,
    output: rates ? tokens.answer * rates.output / DEEPSEEK_PRICING.unitTokens : 0
  };
  costsUsd.total = costsUsd.input + costsUsd.cacheHit + costsUsd.reasoning + costsUsd.output;
  return {
    ...metadata,
    id: metadata.callId,
    createdAt,
    provider: "deepseek",
    model,
    pricingPeriod,
    usageKnown,
    tokens,
    costsUsd,
    ratesUsdPerMillion: rates ? { ...rates } : { cacheHit: 0, cacheMiss: 0, output: 0 },
    rawUsage: numericUsage(usage)
  };
}

function aiErrorDetails(error, httpStatus = 0) {
  const message = safeText(error?.message || "AI 调用失败", 1000);
  if (error?.name === "AbortError") return { category: "timeout", code: "TIMEOUT", message };
  if (error?.code === "EMPTY_DEEPSEEK_CONTENT") return { category: "empty_response", code: error.code, message };
  if (["LENGTH_LIMIT", "CONTENT_FILTER", "INCOMPLETE_STREAM", "INVALID_STREAM"].includes(error?.code)) return { category: error.code.toLowerCase(), code: error.code, message };
  if (httpStatus >= 400) return { category: "provider_http", code: safeText(error?.code, 120) || `HTTP_${httpStatus}`, message };
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message)) return { category: "network", code: safeText(error?.code, 120), message };
  return { category: "unknown", code: safeText(error?.code, 120), message };
}

function imageDimensions(data, mimeType) {
  if (mimeType === "image/png" && data.length >= 24 && data.subarray(12, 16).toString("ascii") === "IHDR") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg" && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (mimeType === "image/webp" && data.length >= 30 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    const format = data.subarray(12, 16).toString("ascii");
    if (format === "VP8X") {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3)
      };
    }
    if (format === "VP8 " && data.length >= 30) {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (format === "VP8L" && data.length >= 25 && data[20] === 0x2f) {
      return {
        width: 1 + (((data[22] & 0x3f) << 8) | data[21]),
        height: 1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6))
      };
    }
  }
  return { width: 0, height: 0 };
}

async function deepSeekImageInput(file, index) {
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const data = await fs.readFile(file), dimensions = imageDimensions(data, mimeType);
  return {
    content: { type: "image_url", image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` } },
    audit: {
      index,
      mimeType,
      bytes: data.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: crypto.createHash("sha256").update(data).digest("hex")
    }
  };
}

async function recordDeepSeekAttempt({ usage, audit, usageMetadata }) {
  const usageEntry = deepSeekUsageEntry({ usage, ...usageMetadata });
  const results = await Promise.allSettled([
    updateAiUsage(value => value.entries.push(usageEntry)),
    recordAiAudit({
      ...audit,
      usage: {
        known: usageEntry.usageKnown,
        normalized: usageEntry.tokens,
        raw: usageEntry.rawUsage,
        pricingPeriod: usageEntry.pricingPeriod,
        ratesUsdPerMillion: usageEntry.ratesUsdPerMillion,
        costsUsd: usageEntry.costsUsd
      }
    })
  ]);
  for (const [index, result] of results.entries()) if (result.status === "rejected") {
    await logEvent("system", "ai.log_failed", { level: "error", callId: audit.callId, target: index === 0 ? "usage" : "audit", error: errorMetadata(result.reason) });
  }
  await logEvent("system", "ai.completed", {
    level: audit.status === "success" ? "info" : "error", callId: audit.callId,
    callGroupId: audit.callGroupId, scene: audit.scene, status: audit.status, attempt: audit.attempt,
    durationMs: audit.durationMs, statusCode: audit.response.httpStatus, retryScheduled: audit.retryScheduled,
    errorCode: audit.error?.code || ""
  });
}

async function readDeepSeekStream(response, onDelta) {
  if (!response.body) throw new Error("DeepSeek 未返回可读取的流");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", reasoningContent = "", finishReason = "", usage = null, finished = false;
  let providerRequestId = safeText(response.headers.get("x-request-id") || response.headers.get("request-id"), 200);
  let modelReturned = "", providerCreatedAt = "", systemFingerprint = "";
  const consumeLine = line => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.startsWith("data:")) return;
    const payload = normalized.slice(5).trim();
    if (!payload || payload === "[DONE]") { if (payload === "[DONE]") finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { throw Object.assign(new Error("DeepSeek 流式数据格式错误"), { code: "INVALID_STREAM" }); }
    if (!chunk || typeof chunk !== "object") throw Object.assign(new Error("DeepSeek 流式数据格式错误"), { code: "INVALID_STREAM" });
    if (chunk.error) {
      const error = Object.assign(new Error("DeepSeek 流式请求失败"), {
        code: safeText(chunk.error.code, 120),
        privateMessage: safeText(chunk.error.message, 10000)
      });
      throw error;
    }
    if (chunk.usage) usage = chunk.usage;
    providerRequestId ||= safeText(chunk.id, 200);
    modelReturned ||= safeText(chunk.model, 100);
    systemFingerprint ||= safeText(chunk.system_fingerprint, 200);
    if (!providerCreatedAt && Number.isFinite(chunk.created)) providerCreatedAt = safeIso(chunk.created * 1000);
    const choice = chunk.choices?.[0] || {}, delta = choice.delta || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoning) { reasoningContent += reasoning; onDelta({ type: "reasoning", delta: reasoning }); }
    if (typeof delta.content === "string" && delta.content) { content += delta.content; onDelta({ type: "content", delta: delta.content }); }
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (finished) break;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !finished) consumeLine(buffer);
    if (!finished && !finishReason) throw Object.assign(new Error("DeepSeek 回答中途断开，请重试"), { code: "INCOMPLETE_STREAM" });
    if (finishReason === "content_filter") throw Object.assign(new Error("DeepSeek 回答被内容过滤，未保存"), { code: "CONTENT_FILTER" });
    if (!content) {
      const error = new Error("DeepSeek 没有返回可显示的回答");
      error.code = "EMPTY_DEEPSEEK_CONTENT";
      throw error;
    }
    if (finishReason === "length") throw Object.assign(new Error("DeepSeek 回答达到长度上限，未保存，请重试"), { code: "LENGTH_LIMIT" });
    return { content, reasoningContent, usage, finishReason, providerRequestId, modelReturned, providerCreatedAt, systemFingerprint };
  } catch (error) {
    error.finishReason ||= finishReason;
    error.usage ||= usage;
    error.partialContent ||= content;
    error.partialReasoningContent ||= reasoningContent;
    error.providerRequestId ||= providerRequestId;
    error.modelReturned ||= modelReturned;
    error.providerCreatedAt ||= providerCreatedAt;
    error.systemFingerprint ||= systemFingerprint;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function runDeepSeek(prompt, { imagePath = null, imagePaths = null, history = [], settingsOverride = null, scene = "thoughtAnswer", json = false, systemPrompt = SYSTEM_PROMPT, onDelta = null, captureReasoning = false, maxTokens = 16000, retryWithoutThinking = false, timeoutMs = 300000 } = {}) {
  const settings = llmSettingsForScene(settingsOverride || await readLlmSettings(), scene);
  if (!settings.apiKey) throw new Error("尚未配置 DeepSeek API 密钥，请先到“设置”中填写并保存");
  const effectiveSystemPrompt = systemPromptForScene(systemPrompt, scene);
  const visualPaths = [...(Array.isArray(imagePaths) ? imagePaths : []), ...(imagePath ? [imagePath] : [])];
  const imageInputs = await Promise.all(visualPaths.map(deepSeekImageInput));
  const imageAudit = imageInputs.map(item => item.audit);
  const userContent = imageInputs.length ? [{ type: "text", text: prompt }, ...imageInputs.map(item => item.content)] : prompt;
  const context = requestStorage.getStore() || {};
  if (context.secrets) context.secrets.push(settings.apiKey);
  const traceId = safeText(context.traceId, 128) || crypto.randomUUID();
  const callGroupId = crypto.randomUUID();
  const userId = safeText(context.user?.id, 100) || "local";
  let endpointHost = "";
  try { endpointHost = new URL(DEEPSEEK_API_URL).host; } catch { endpointHost = "invalid"; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const efforts = [settings.effort, ...(retryWithoutThinking && settings.effort !== "none" ? ["none"] : [])];
    for (let attempt = 0; attempt < efforts.length; attempt += 1) {
      const releaseQuota = await reserveAiAttempt();
      const releaseCapacity = await aiGate.acquire();
      try {
        const effort = efforts[attempt], createdAt = now(), startedMs = Date.now();
        const callId = crypto.randomUUID(), model = visualPaths.length ? "deepseek-flash" : settings.model;
        const parameters = {
        model,
        thinking: { type: effort === "none" ? "disabled" : "enabled" },
        reasoning_effort: effort,
        max_tokens: maxTokens,
        stream: Boolean(onDelta),
        ...(onDelta ? { stream_options: { include_usage: true } } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {})
      };
        const messages = [{ role: "system", content: effectiveSystemPrompt }, ...history, { role: "user", content: userContent }];
        const requestChars = effectiveSystemPrompt.length + String(prompt).length + history.reduce((sum, message) => sum + (typeof message?.content === "string" ? message.content.length : 0), 0);
        await startAiAudit({
        id: callId, callId, callGroupId, traceId, actor: { userId }, provider: "deepseek",
        scene, startedAt: createdAt, attempt: attempt + 1, maxAttempts: efforts.length,
        request: { endpointHost, images: imageAudit, systemPrompt: auditText(effectiveSystemPrompt), userPrompt: auditText(prompt), history: history.map(auditMessage), parameters }
      });
        let response = null, raw = "", result = null, recorded = false;
        const finishAttempt = async ({ status, usage = null, content = "", reasoningContent = "", finishReason = "", error = null, providerRequestId = "", modelReturned = "", providerCreatedAt = "", systemFingerprint = "", retryScheduled = false } = {}) => {
        if (recorded) return;
        recorded = true;
        const completedAt = now(), durationMs = Date.now() - startedMs, httpStatus = response?.status || 0;
        const failure = error ? aiErrorDetails(error, httpStatus) : { category: "", code: "", message: "" };
        const responseRequestId = safeText(providerRequestId || response?.headers.get("x-request-id") || response?.headers.get("request-id"), 200);
        const common = {
          callId,
          callGroupId,
          traceId,
          completedAt,
          durationMs,
          durationKnown: true,
          status,
          httpStatus,
          errorCategory: failure.category,
          errorCode: failure.code,
          providerRequestId: responseRequestId,
          modelReturned: safeText(modelReturned, 100),
          scene,
          tier: settings.tier,
          effort,
          attempt: attempt + 1,
          maxAttempts: efforts.length,
          retryReason: attempt ? "empty_response_without_thinking" : "",
          retryScheduled,
          stream: Boolean(onDelta),
          responseFormat: json ? "json_object" : "text",
          maxTokens,
          finishReason: safeText(finishReason, 80),
          modality: imageAudit.length ? "vision" : "text",
          imageCount: imageAudit.length,
          imageBytes: imageAudit.reduce((sum, image) => sum + image.bytes, 0),
          imageTypes: [...new Set(imageAudit.map(image => image.mimeType))],
          imageDimensions: imageAudit.map(({ width, height }) => ({ width, height })),
          historyMessageCount: history.length,
          requestChars,
          responseChars: String(content || "").length,
          reasoningChars: String(reasoningContent || "").length
        };
        await recordDeepSeekAttempt({
          usage,
          usageMetadata: { ...common, model, createdAt },
          audit: {
            id: callId,
            callId,
            callGroupId,
            traceId,
            actor: { userId },
            provider: "deepseek",
            scene,
            tier: settings.tier,
            attempt: attempt + 1,
            maxAttempts: efforts.length,
            retryReason: common.retryReason,
            retryScheduled,
            startedAt: createdAt,
            completedAt,
            durationMs,
            status,
            error: error ? { ...failure, message: auditText(error.privateMessage || failure.message) } : null,
            request: {
              endpointHost,
              modality: common.modality,
              images: imageAudit,
              systemPrompt: auditText(effectiveSystemPrompt),
              userPrompt: auditText(prompt),
              history: history.map(auditMessage),
              messageCount: messages.length,
              characterCounts: {
                systemPrompt: effectiveSystemPrompt.length,
                userPrompt: String(prompt).length,
                history: requestChars - effectiveSystemPrompt.length - String(prompt).length,
                total: requestChars
              },
              parameters
            },
            response: {
              httpStatus,
              providerRequestId: responseRequestId,
              model: safeText(modelReturned, 100),
              createdAt: safeIso(providerCreatedAt),
              systemFingerprint: safeText(systemFingerprint, 200),
              finishReason: safeText(finishReason, 80),
              content: auditText(content),
              reasoningContent: auditText(reasoningContent),
              rawErrorBody: error && raw ? auditText(redact(raw, [settings.apiKey]).slice(0, 10000)) : ""
            }
          }
        });
        };
        try {
          response = await fetch(DEEPSEEK_API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ ...parameters, messages })
        });
        if (onDelta && response.ok) {
          const streamResult = await readDeepSeekStream(response, onDelta);
          await finishAttempt({ status: "success", ...streamResult });
          return captureReasoning ? streamResult : streamResult.content;
        }
        raw = await response.text();
        try { result = JSON.parse(raw); } catch { result = {}; }
        if (!result || typeof result !== "object") result = {};
        if (!response.ok) {
          const error = new Error(`DeepSeek 请求失败（HTTP ${response.status}）`);
          error.code = safeText(result.error?.code, 120);
          error.privateMessage = safeText(result.error?.message, 10000);
          throw error;
        }
        const content = typeof result.choices?.[0]?.message?.content === "string" ? result.choices[0].message.content : "";
        const reasoningContent = String(result.choices?.[0]?.message?.reasoning_content || result.choices?.[0]?.message?.reasoning || "");
        const finishReason = safeText(result.choices?.[0]?.finish_reason, 80);
        if (!content || ["length", "content_filter"].includes(finishReason)) {
          const error = new Error(finishReason === "content_filter" ? "DeepSeek 回答被内容过滤，未保存" : !content ? "DeepSeek 没有返回可显示的回答" : "DeepSeek 回答达到长度上限，未保存，请重试");
          error.code = finishReason === "content_filter" ? "CONTENT_FILTER" : !content ? "EMPTY_DEEPSEEK_CONTENT" : "LENGTH_LIMIT";
          error.usage = result.usage;
          error.finishReason = finishReason;
          error.partialContent = content;
          error.partialReasoningContent = reasoningContent;
          error.providerRequestId = safeText(result.id, 200);
          error.modelReturned = safeText(result.model, 100);
          if (Number.isFinite(result.created)) error.providerCreatedAt = safeIso(result.created * 1000);
          error.systemFingerprint = safeText(result.system_fingerprint, 200);
          throw error;
        }
        const providerCreatedAt = Number.isFinite(result.created) ? safeIso(result.created * 1000) : "";
        await finishAttempt({
          status: "success",
          usage: result.usage,
          content,
          reasoningContent,
          finishReason,
          providerRequestId: result.id,
          modelReturned: result.model,
          providerCreatedAt,
          systemFingerprint: result.system_fingerprint
        });
        return captureReasoning ? { content, reasoningContent } : content;
        } catch (error) {
          const retryScheduled = error.code === "EMPTY_DEEPSEEK_CONTENT" && attempt + 1 < efforts.length;
          await finishAttempt({
          status: error.name === "AbortError" ? "timeout" : "failed",
          usage: error.usage || result?.usage,
          content: error.partialContent,
          reasoningContent: error.partialReasoningContent,
          finishReason: error.finishReason || result?.choices?.[0]?.finish_reason,
          error,
          providerRequestId: error.providerRequestId || result?.id,
          modelReturned: error.modelReturned || result?.model,
          providerCreatedAt: error.providerCreatedAt,
          systemFingerprint: error.systemFingerprint || result?.system_fingerprint,
          retryScheduled
          });
          if (retryScheduled) continue;
          throw error;
        }
      } finally {
        releaseCapacity();
        releaseQuota();
      }
    }
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`DeepSeek 请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`);
    if (/fetch failed|ENOTFOUND|ECONN/i.test(error.message)) throw new Error("无法连接 DeepSeek API，请检查网络后重试");
    error.message = redact(error.message, [settings.apiKey]);
    throw error;
  } finally { clearTimeout(timer); }
}

async function generateReflection(reason = "manual") {
  const store = await readStore();
  const thoughtRoots = store.thoughts.filter(item => item.type === "question");
  const evidenceCount = thoughtRoots.length + store.checkins.length + store.dailyRecords.length + store.captures.length + store.journals.length;
  if (!evidenceCount) throw new Error("先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘");
  const reflectionData = store.thoughts.slice(0, 80).map(item => ({ type: item.type, content: item.content, tags: item.tags, disposition: item.disposition, modelDraft: item.modelDraft, relatedTo: item.relatedTo, followUps: (item.followUps || []).map(followUp => ({ question: followUp.question, answer: followUp.answer })) })).filter(item => item.content);
  const evidenceLevel = thoughtRoots.length >= 3 ? "常规样本" : "冷启动低样本";
  const result = await runDeepSeek(`${userAnswerContext(store)}\n\n以下是供复盘使用的思绪记录：\n${JSON.stringify(reflectionData)}\n\n当前证据等级：${evidenceLevel}。请做一份认知复盘：
1. 先给一个明确的总判断：目前最稳定的认知倾向、最值得警惕的盲区和最值得保留的能力分别是什么。
2. 从状态、健康、捕念、日记、提问、回答、保留、舍弃和长期未处理里选择证据最充分、最能改变行动的发现；常规样本选 3～5 条，冷启动低样本选 1～2 条，不能因为记录少而拒绝分析。
3. 对有 modelDraft 的回答，比较模型草稿与用户最终文本，寻找反复出现的修改偏好；单次改动只能作为线索。
4. 低样本结论必须标记为“初步观察”，说明它依据哪条记录、还缺什么证据；可检查认知漏洞、系统性回避、重要领域缺席与信息茧房，但没有正向证据时必须明确“尚不能判断”，不能把缺席本身写成结论。
5. 每条使用“证据 / 判断 / 反证或不确定性 / 校正动作或一个可行提问”的结构。必须先给观点，问题只用于验证观点。`, { scene: "analysis", captureReasoning: true });
  const analysis = { id: crypto.randomUUID(), createdAt: now(), reason, content: result.content, annotations: [], annotationDrift: [], ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) };
  await updateStore(store => store.analyses.unshift(analysis)); return analysis;
}

async function maybeRunPeriodicAnalysis() {
  const store = await readStore();
  if (store.thoughts.filter(item => item.type === "question").length < 5) return;
  const last = store.analyses[0]?.createdAt ? new Date(store.analyses[0].createdAt).getTime() : 0;
  if (Date.now() - last < 7 * 86400000) return;
  try {
    await generateReflection("weekly-background");
    await logEvent("system", "analysis.completed", { level: "info" });
  } catch (error) {
    await logEvent("system", "analysis.failed", { level: "error", error: errorMetadata(error) });
  }
}

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

function recordStatistics(store) {
  const annotationRoots = [
    ...store.captures, ...store.journals, ...store.thoughts, ...store.chats,
    ...store.books, ...store.quotes, ...store.analyses
  ];
  const annotations = annotationRoots.flatMap(root => [...(root.annotations || []), ...(root.annotationDrift || [])]);
  const content = [
    { key: "checkins", label: "状态", count: store.checkins.length },
    { key: "sleep", label: "睡眠", count: store.dailyRecords.filter(item => item.type === "sleep").length },
    { key: "heartRate", label: "心率", count: store.dailyRecords.filter(item => item.type === "heartRate").length },
    { key: "weight", label: "体重", count: store.dailyRecords.filter(item => item.type === "weight").length },
    { key: "exercise", label: "运动", count: store.dailyRecords.filter(item => item.type === "exercise").length },
    { key: "captures", label: "捕念", count: store.captures.length },
    { key: "journals", label: "日记", count: store.journals.length },
    { key: "thoughts", label: "思考主题", count: store.thoughts.filter(item => item.type === "question").length },
    { key: "chats", label: "长期对话", count: store.chats.length },
    { key: "books", label: "书目", count: store.books.length },
    { key: "bookNotes", label: "读书记录", count: store.books.reduce((sum, book) => sum + (book.notes || []).length, 0) },
    { key: "quotes", label: "善言", count: store.quotes.length },
    { key: "keepsakes", label: "小物", count: store.keepsakes.length },
    { key: "experiments", label: "个人实验", count: store.experiments.length },
    { key: "analyses", label: "认知复盘", count: store.analyses.length }
  ];
  const interactions = [
    { key: "highlights", label: "划线", count: annotations.filter(item => item.kind === "highlight").length },
    { key: "comments", label: "评论", count: annotations.filter(item => item.kind !== "highlight").length },
    { key: "commentReplies", label: "评论回复", count: annotations.reduce((sum, item) => sum + (item.replies || []).length, 0) },
    { key: "shenji", label: "@神鸡", count: annotations.reduce((sum, item) => sum + (item.shenji || []).length, 0) },
    { key: "followUps", label: "思考追问", count: store.thoughts.reduce((sum, item) => sum + (item.followUps || []).length, 0) },
    { key: "remarks", label: "思考备注", count: store.thoughts.reduce((sum, item) => sum + (item.remarks || []).length, 0) },
    { key: "reflections", label: "日记回望", count: store.journals.reduce((sum, item) => sum + (item.reflections || []).length, 0) }
  ];
  return {
    total: [...content, ...interactions].reduce((sum, item) => sum + item.count, 0),
    contentTotal: content.reduce((sum, item) => sum + item.count, 0),
    interactionTotal: interactions.reduce((sum, item) => sum + item.count, 0),
    content,
    interactions
  };
}

function blankUsageAggregate() {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    unknownStatusCalls: 0,
    usageUnknownCalls: 0,
    durationMs: 0,
    durationKnownCalls: 0,
    maxDurationMs: 0,
    visionCalls: 0,
    imageCount: 0,
    imageBytes: 0,
    tokens: { input: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0, answer: 0, output: 0 },
    costsUsd: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 }
  };
}

function addUsageAggregate(target, entry) {
  target.calls += 1;
  if (entry.status === "success") target.successfulCalls += 1;
  else if (entry.status === "unknown") target.unknownStatusCalls += 1;
  else target.failedCalls += 1;
  if (!entry.usageKnown) target.usageUnknownCalls += 1;
  if (entry.durationKnown) {
    target.durationMs += Number(entry.durationMs) || 0;
    target.durationKnownCalls += 1;
    target.maxDurationMs = Math.max(target.maxDurationMs, Number(entry.durationMs) || 0);
  }
  if (entry.modality === "vision") target.visionCalls += 1;
  target.imageCount += Number(entry.imageCount) || 0;
  target.imageBytes += Number(entry.imageBytes) || 0;
  for (const key of Object.keys(target.tokens)) target.tokens[key] += Number(entry.tokens?.[key]) || 0;
  for (const key of Object.keys(target.costsUsd)) target.costsUsd[key] += Number(entry.costsUsd?.[key]) || 0;
  return target;
}

function usageDashboard(usage, from, to) {
  const dayCount = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => shiftDateKey(from, index));
  const entries = usage.entries.filter(item => {
    const date = localDateKey(item.createdAt);
    return date >= from && date <= to;
  });
  const summary = entries.reduce(addUsageAggregate, blankUsageAggregate());
  const daily = days.map(date => {
    const matching = entries.filter(item => localDateKey(item.createdAt) === date);
    const models = Object.fromEntries(LLM_MODELS.map(model => [model, matching.filter(item => item.model === model).reduce(addUsageAggregate, blankUsageAggregate())]));
    return { date, ...matching.reduce(addUsageAggregate, blankUsageAggregate()), models };
  });
  const models = LLM_MODELS.map(model => ({
    model,
    label: DEEPSEEK_PRICING.models[model].label,
    ...entries.filter(item => item.model === model).reduce(addUsageAggregate, blankUsageAggregate())
  }));
  const scenes = [...new Set(entries.map(item => item.scene))].map(scene => {
    const aggregate = entries.filter(item => item.scene === scene).reduce(addUsageAggregate, blankUsageAggregate());
    return { scene, ...aggregate };
  }).sort((a, b) => b.calls - a.calls || a.scene.localeCompare(b.scene));
  const modalities = ["text", "vision", ...(entries.some(item => item.modality === "unknown") ? ["unknown"] : [])].map(modality => ({
    modality,
    label: modality === "vision" ? "图片理解" : modality === "text" ? "纯文本" : "历史未知",
    ...entries.filter(item => item.modality === modality).reduce(addUsageAggregate, blankUsageAggregate())
  }));
  return {
    from,
    to,
    trackingStartedAt: usage.trackingStartedAt,
    summary,
    daily,
    models,
    scenes,
    modalities,
    pricing: {
      ...DEEPSEEK_PRICING,
      estimateNote: "费用按请求发生时固化的官方单价估算；中国法定节假日若落在工作日峰值时段，实际账单可能更低。"
    }
  };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/statistics") {
    const currentDate = today(), defaultFrom = shiftDateKey(currentDate, -6);
    const from = url.searchParams.has("from") ? strictDateKey(url.searchParams.get("from")) : defaultFrom;
    const to = url.searchParams.has("to") ? strictDateKey(url.searchParams.get("to")) : currentDate;
    if (!from || !to || from > to) return sendJson(res, 400, { error: "统计时间范围不正确" });
    const dayCount = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (dayCount > 3660) return sendJson(res, 400, { error: "单次最多统计 10 年" });
    await ensureAiUsage();
    const [store, usage] = await Promise.all([readStore(), readAiUsage()]);
    return sendJson(res, 200, { records: recordStatistics(store), ai: usageDashboard(usage, from, to) });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, publicLlmSettings(await readLlmSettings()));
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const input = await bodyJson(req), current = await readLlmSettings(), suppliedKey = safeText(input.apiKey, 300), apiKey = input.clearApiKey ? "" : suppliedKey || current.apiKey;
    const profiles = clone(input.profiles || current.profiles);
    if (!input.profiles && (input.model || input.effort)) {
      const tier = current.scenarios.thoughtAnswer;
      profiles[tier] = { model: input.model || profiles[tier].model, effort: input.effort || profiles[tier].effort };
    }
    const settings = normalizeLlmSettings({ version: LLM_SETTINGS_VERSION, provider: "deepseek", profiles, scenarios: input.scenarios || current.scenarios, apiKey });
    await writeLlmSettings(settings);
    return sendJson(res, 200, publicLlmSettings(settings));
  }
  if (req.method === "POST" && url.pathname === "/api/settings/test") {
    const input = await bodyJson(req), tier = LLM_TIERS.includes(input.tier) ? input.tier : "lite";
    const reply = await runDeepSeek("只回复：连接成功。不要添加其他内容。", { scene: tier, maxTokens: 40 });
    return sendJson(res, 200, { ok: true, reply: safeText(reply, 80), tier, settings: publicLlmSettings(await readLlmSettings()) });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    const store = await readStore(); return sendJson(res, 200, { ...store, clusters: clusters(store), insights: insights(store) });
  }
  if (req.method === "POST" && url.pathname === "/api/images/upload") {
    const input = await bodyJson(req, ATTACHMENT_UPLOAD_BODY_MAX_BYTES), images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
    try {
      const { attachmentPaths } = await saveImageDataUrls(images, 1, { maxBytes: ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES });
      return sendJson(res, 201, { attachmentPath: attachmentPaths[0] });
    } catch (error) {
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message, code: error.code });
      if (/请选择|图片|大小/.test(error.message || "")) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/images/parse") {
    const input = await bodyJson(req), kind = ["sleep", "heartRate", "book"].includes(input.kind) ? input.kind : "";
    if (!kind) return sendJson(res, 400, { error: "截图类型无效" });
    try { return sendJson(res, 200, await parseImageRequest(input, kind)); }
    catch (error) {
      if (/图片|截图|支持|大小/.test(error.message)) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/keepsakes/segment") {
    const input = await bodyJson(req);
    const release = await segmentationGate.acquire();
    try { return sendJson(res, 200, await segmentKeepsakeImage(input)); }
    catch (error) {
      const status = /请选择|图片格式|图片大小|不支持/.test(error.message) ? 400 : 502;
      return sendJson(res, status, { error: error.message });
    } finally {
      release();
    }
  }
  if (req.method === "POST" && url.pathname === "/api/daily-records") {
    const input = await bodyJson(req), parsed = dailyRecordPayload(input);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const entry = { id: crypto.randomUUID(), createdAt: now(), ...parsed.value };
    await updateStore(store => store.dailyRecords.unshift(entry));
    return sendJson(res, 201, entry);
  }
  if (req.method === "PATCH" && /^\/api\/daily-records\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req);
    const updated = await updateStore(store => {
      const entry = store.dailyRecords.find(item => item.id === id);
      if (!entry) return { missing: true };
      const parsed = dailyRecordPayload(input, entry);
      if (parsed.error) return { error: parsed.error };
      const next = { ...entry, ...parsed.value, id: entry.id, createdAt: entry.createdAt, updatedAt: now() };
      Object.assign(entry, next);
      return { value: entry };
    });
    if (updated.missing) return sendJson(res, 404, { error: "这条每日记录不存在" });
    if (updated.error) return sendJson(res, 400, { error: updated.error });
    return sendJson(res, 200, updated.value);
  }
  if (req.method === "DELETE" && /^\/api\/daily-records\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    const removed = await updateStore(store => {
      const before = store.dailyRecords.length;
      store.dailyRecords = store.dailyRecords.filter(item => item.id !== id);
      return before - store.dailyRecords.length;
    });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "这条每日记录不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/checkins") {
    const input = await bodyJson(req), eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const entry = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, mood: clamp5(input.mood), energy: clamp5(input.energy), stress: clamp5(input.stress), sleep: clamp5(input.sleep), factors: (input.factors || []).map(value => safeText(value, 40)).filter(Boolean).slice(0, 20), custom: Object.fromEntries(Object.entries(input.custom || {}).map(([key, value]) => [safeText(key, 60), clamp5(value)])), notes: Object.fromEntries(Object.entries(input.notes || {}).map(([key, value]) => [key, safeText(value, 800)])) };
    await updateStore(store => store.checkins.unshift(entry)); return sendJson(res, 201, entry);
  }
  if (req.method === "PATCH" && /^\/api\/checkins\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req);
    const updated = await updateStore(store => {
      const entry = store.checkins.find(item => item.id === id);
      if (!entry) return { missing: true };
      const eventTime = eventTimeFields(input, entry);
      if (!eventTime) return { error: "发生时间格式不正确" };
      Object.assign(entry, eventTime, {
        mood: clamp5(input.mood),
        energy: clamp5(input.energy),
        stress: clamp5(input.stress),
        sleep: clamp5(input.sleep),
        factors: (input.factors || []).map(value => safeText(value, 40)).filter(Boolean).slice(0, 20),
        custom: Object.fromEntries(Object.entries(input.custom || {}).map(([key, value]) => [safeText(key, 60), clamp5(value)])),
        notes: Object.fromEntries(Object.entries(input.notes || {}).map(([key, value]) => [safeText(key, 60), safeText(value, 800)])),
        updatedAt: now()
      });
      return { value: entry };
    });
    if (updated.missing) return sendJson(res, 404, { error: "这次状态记录不存在" });
    if (updated.error) return sendJson(res, 400, { error: updated.error });
    return sendJson(res, 200, updated.value);
  }
  if (req.method === "POST" && url.pathname === "/api/captures") {
    const input = await bodyJson(req), content = safeText(input.content, 12000), eventTime = eventTimeFields(input);
    if (!content) return sendJson(res, 400, { error: "先记下一点什么" });
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const capture = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, content, tags: (input.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8), annotations: [], annotationDrift: [] };
    await updateStore(store => store.captures.unshift(capture)); return sendJson(res, 201, capture);
  }
  if (req.method === "PATCH" && /^\/api\/captures\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req), content = safeText(input.content, 12000);
    if (!content) return sendJson(res, 400, { error: "捕念内容不能为空" });
    const updated = await updateStore(store => {
      const capture = store.captures.find(item => item.id === id); if (!capture) return null;
      const eventTime = eventTimeFields(input, capture); if (!eventTime) return false;
      reanchorAnnotations(capture, "content", capture.content, content); capture.content = content; capture.tags = (input.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8); Object.assign(capture, eventTime); capture.updatedAt = now(); return capture;
    });
    if (updated === false) return sendJson(res, 400, { error: "发生时间格式不正确" });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "这条捕念不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/captures\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    const removed = await updateStore(store => { const before = store.captures.length; store.captures = store.captures.filter(item => item.id !== id); return before - store.captures.length; });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "这条捕念不存在" });
  }
  if (req.method === "PUT" && url.pathname === "/api/journal-draft") {
    const input = await bodyJson(req), title = safeText(input.title, 120), content = safeText(input.content, 50000);
    if (!title && !content) return sendJson(res, 400, { error: "先写下一点内容再保存草稿" });
    const requestedJournalId = safeText(input.journalId, 100);
    const draft = await updateStore(store => {
      store.journalDraft = { journalId: store.journals.some(item => item.id === requestedJournalId) ? requestedJournalId : "", title, content, updatedAt: now() };
      return store.journalDraft;
    });
    return sendJson(res, 200, draft);
  }
  if (req.method === "POST" && url.pathname === "/api/journals") {
    const input = await bodyJson(req), content = safeText(input.content, 50000), eventTime = eventTimeFields(input);
    if (!content) return sendJson(res, 400, { error: "日记内容不能为空" });
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const journal = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, title: safeText(input.title, 120), content, tags: (input.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8), reflections: [], annotations: [], annotationDrift: [] };
    await updateStore(store => { store.journals.unshift(journal); if (!store.journalDraft?.journalId) store.journalDraft = null; }); return sendJson(res, 201, journal);
  }
  if (req.method === "PATCH" && /^\/api\/journals\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req), content = safeText(input.content, 50000);
    if (!content) return sendJson(res, 400, { error: "日记内容不能为空" });
    const updated = await updateStore(store => {
      const journal = store.journals.find(item => item.id === id); if (!journal) return null;
      const eventTime = eventTimeFields(input, journal); if (!eventTime) return false;
      journal.title = safeText(input.title, 120); reanchorAnnotations(journal, "content", journal.content, content); journal.content = content; journal.tags = (input.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8); Object.assign(journal, eventTime); journal.updatedAt = now(); if (store.journalDraft?.journalId === id) store.journalDraft = null; return journal;
    });
    if (updated === false) return sendJson(res, 400, { error: "发生时间格式不正确" });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "这篇日记不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/journals\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    const removed = await updateStore(store => { const before = store.journals.length; store.journals = store.journals.filter(item => item.id !== id); return before - store.journals.length; });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "这篇日记不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/journals/assist") {
    const input = await bodyJson(req), mode = ["lead", "structure", "topic"].includes(input.mode) ? input.mode : "";
    if (!mode) return sendJson(res, 400, { error: "日记辅助类型无效" });
    const occurredOn = eventTimeFields(input)?.occurredOn || safeDate(input.occurredOn), title = safeText(input.title, 120), content = safeText(input.content, 50000), store = await readStore();
    const tasks = {
      lead: "给一个可直接续写的引子：先用一句简短描述承接所选日期发生的事，再用一句问句提醒前一天的事今天是否有复盘或落地。共 2 句，每句单独一行，不加标题，不超过 80 个汉字。",
      structure: "给继续往下写的行文结构。只输出 2～3 行；每行必须是“结构名：问句”，每行 20～30 个汉字，不使用 Markdown 列表符号，不展开回答，不加前言或结语。",
      topic: "给一个可继续思考的话题：从近期多个事件中概括背后的思维主线，跨越单一事件，不要复述某一件事。只输出一个主题句和一个问句，各占一行，不超过 90 个汉字。"
    };
    const prompt = `${diaryActivityContext(store, occurredOn)}

<current_draft priority="highest">
<title>${title || "（无标题）"}</title>
<written_text>${content || "（尚未写正文）"}</written_text>
</current_draft>

<current_task>${tasks[mode]}</current_task>`;
    const scene = { lead: "diaryLead", structure: "diaryStructure", topic: "diaryTopic" }[mode];
    return respondWithModel(req, res, {
      prompt,
      options: { scene, systemPrompt: DIARY_ASSIST_SYSTEM_PROMPT, maxTokens: 2000, retryWithoutThinking: true },
      complete: content => ({ mode, content: markJournalAssistContent(mode, content) })
    });
  }
  if (req.method === "POST" && /^\/api\/journals\/[^/]+\/reflect$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], store = await readStore(), journal = store.journals.find(item => item.id === id);
    if (!journal) return sendJson(res, 404, { error: "这篇日记不存在" });
    const sourceUpdatedAt = journal.updatedAt || journal.createdAt;
    const prompt = userPrompt({
      context: userAnswerContext(store),
      chain: `<current_journal date="${journal.occurredOn}">\n<title>${journal.title || "（无标题）"}</title>\n<content>${journal.content}</content>\n<tags>${journal.tags.join("、") || "（无）"}</tags>\n</current_journal>`,
      task: "回望这篇日记。以当前日记为最高优先级，长期语境只用于发现真正相关的重复线索，不要机械引用历史。"
    });
    return respondWithModel(req, res, {
      prompt,
      status: 201,
      options: { scene: "diaryReflection", systemPrompt: DIARY_SYSTEM_PROMPT },
      complete: async (content, reasoningContent) => {
        const reflection = { id: crypto.randomUUID(), createdAt: now(), sourceUpdatedAt, content, ...(reasoningContent ? { reasoningContent } : {}) };
        const saved = await updateStore(value => { const current = value.journals.find(item => item.id === id); if (!current) return null; current.reflections ||= []; current.reflections.unshift(reflection); return reflection; });
        if (!saved) throw new Error("这篇日记已被删除");
        return saved;
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/api/thought-chains") {
    const input = await bodyJson(req); const questionText = safeText(input.question);
    if (!questionText) return sendJson(res, 400, { error: "请填写问题" });
    const eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const tags = (input.tags || []).map(value => safeText(value, 30)).filter(Boolean); const clientRequestId = safeText(input.clientRequestId, 100);
    const created = await updateStore(store => {
      if (clientRequestId) {
        const existing = store.thoughts.filter(item => item.clientRequestId === clientRequestId);
        if (existing.length) return { items: existing, duplicate: true };
      }
      const question = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, type: "question", content: questionText, tags, relatedTo: null, disposition: "kept", remarks: [], origin: "manual", clientRequestId };
      store.thoughts.unshift(question); const items = [question];
      for (const [type, content] of [["idea", safeText(input.idea)], ["answer", safeText(input.answer)]]) {
        const modelDraft = type === "answer" ? safeText(input.modelDraft) : "", reasoningContent = type === "answer" && modelDraft ? safeText(input.modelReasoning, 50000) : "";
        if (!content && !modelDraft) continue;
        const item = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, type, content, tags, relatedTo: question.id, disposition: "kept", remarks: [], origin: modelDraft ? "deepseek-edited" : "manual", clientRequestId, ...(modelDraft ? { modelDraft, editedFromModel: modelDraft !== content } : {}), ...(reasoningContent ? { reasoningContent } : {}) };
        store.thoughts.unshift(item); items.push(item);
      }
      return { items, duplicate: false };
    });
    return sendJson(res, created.duplicate ? 200 : 201, created);
  }
  if (req.method === "DELETE" && /^\/api\/thought-chains\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    const removed = await updateStore(store => {
      const before = store.thoughts.length;
      store.thoughts = store.thoughts.filter(item => item.id !== id && item.relatedTo !== id);
      return before - store.thoughts.length;
    });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "这套思考不存在" });
  }
  if (req.method === "PATCH" && /^\/api\/thought-chains\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const input = await bodyJson(req); const questionText = safeText(input.question);
    if (!questionText) return sendJson(res, 400, { error: "问题不能为空" });
    const changesEventTime = hasOwn(input, "occurredAt") || hasOwn(input, "occurredOn");
    if (changesEventTime && !eventTimeFields(input)) return sendJson(res, 400, { error: "日期时间格式不正确" });
    const updated = await updateStore(store => {
      const question = store.thoughts.find(item => item.id === id && item.type === "question"); if (!question) return null;
      const tags = (input.tags || []).map(value => safeText(value, 30)).filter(Boolean).slice(0, 8); const chainItems = store.thoughts.filter(item => item.id === id || item.relatedTo === id); reanchorAnnotations(question, `question:${id}`, question.content, questionText); question.content = questionText; question.tags = tags; question.updatedAt = now();
      if (changesEventTime) { const eventTime = eventTimeFields(input, question); for (const item of chainItems) Object.assign(item, eventTime); }
      for (const [type, content] of [["idea", safeText(input.idea)], ["answer", safeText(input.answer)]]) {
        const matches = store.thoughts.filter(item => item.relatedTo === id && item.type === type); const first = matches[0];
        if (content && first) { reanchorAnnotations(question, `${type}:${first.id}`, first.content, content); first.content = content; first.tags = tags; first.updatedAt = now(); if (type === "answer" && first.modelDraft) first.editedFromModel = first.modelDraft !== content; const extras = matches.slice(1); for (const item of extras) reanchorAnnotations(question, `${type}:${item.id}`, item.content, "", "重复内容在编辑时被合并"); const extraIds = new Set(extras.map(item => item.id)); if (extraIds.size) store.thoughts = store.thoughts.filter(item => !extraIds.has(item.id)); }
        else if (content) store.thoughts.unshift({ id: crypto.randomUUID(), createdAt: now(), occurredAt: question.occurredAt, occurredOn: question.occurredOn, type, content, tags, relatedTo: id, disposition: question.disposition || "kept", remarks: [], origin: "manual" });
        else if (first) { for (const item of matches) reanchorAnnotations(question, `${type}:${item.id}`, item.content, "", `${type === "idea" ? "初步想法" : "回答"}已删除`); store.thoughts = store.thoughts.filter(item => !(item.relatedTo === id && item.type === type)); }
      }
      return question;
    });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "这套思考不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/answer-drafts") {
    const input = await bodyJson(req); const question = safeText(input.question); const idea = safeText(input.idea);
    if (!question) return sendJson(res, 400, { error: "请先填写问题" });
    const store = await readStore();
    const prompt = userPrompt({ context: userAnswerContext(store), chain: `<draft_thought>\n<question>${question}</question>\n<initial_idea>${idea || "（暂无）"}</initial_idea>\n</draft_thought>`, task: "为尚未提交的思考生成可编辑回答草稿。直接回答问题，再给关键理由、反例或适用边界；不要添加“核心判断”“结论”“我的判断”“给我判断”“给你一个判断”等元标签。区分事实、推断和价值判断。不要替用户决定个人价值选择，但不能因此回避给观点。行动建议仅在适用时给一个最小下一步。" });
    return respondWithModel(req, res, { prompt, options: { scene: "thoughtDraft" }, complete: (draft, reasoningContent) => ({ draft: stripThoughtAnswerLead(draft), reasoningContent }) });
  }
  if (req.method === "POST" && url.pathname === "/api/thought-prompts") {
    const input = await bodyJson(req), eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const occurredOn = eventTime.occurredOn, store = await readStore(), context = thoughtPromptContext(store, occurredOn);
    const task = context.hasHistory
      ? "从这些近期记录中挑一个真实线索，给用户一个能自然延伸一步的问题。优先未完成、反复出现或值得重新看一眼的事情，不要复述整条记录。"
      : "这是第一次记录。给一个轻巧、具体、略带俏皮的问题，让用户不必组织完整答案也愿意写下一两句。";
    const prompt = `<thought_prompt_context selected_date="${occurredOn}" has_history="${context.hasHistory}">
${context.text}
</thought_prompt_context>

<current_task>${task}</current_task>`;
    return respondWithModel(req, res, {
      prompt,
      options: { scene: "thoughtPrompt", systemPrompt: THOUGHT_PROMPT_SYSTEM_PROMPT, maxTokens: 400, retryWithoutThinking: true, timeoutMs: 30000 },
      complete: content => ({ prompt: safeText(content, 160).replace(/\s+/g, " "), hasHistory: context.hasHistory })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/thoughts") {
    const input = await bodyJson(req); const content = safeText(input.content), eventTime = eventTimeFields(input);
    if (!content) return sendJson(res, 400, { error: "请先写下内容" });
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const entry = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, type: ["question", "idea", "answer"].includes(input.type) ? input.type : "question", content, tags: (input.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8), relatedTo: safeText(input.relatedTo, 80) || null, disposition: "kept", remarks: [], origin: input.origin || "manual" };
    await updateStore(store => store.thoughts.unshift(entry)); return sendJson(res, 201, entry);
  }
  if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/disposition$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const input = await bodyJson(req);
    if (!["pending", "kept", "discarded"].includes(input.disposition)) return sendJson(res, 400, { error: "状态无效" });
    const item = await updateStore(store => { const found = store.thoughts.find(value => value.id === id); if (!found) return null; for (const value of store.thoughts.filter(value => value.id === id || value.relatedTo === id)) { value.disposition = input.disposition; value.dispositionAt = now(); } return found; });
    return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: "记录不存在" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/remarks$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const input = await bodyJson(req); const text = safeText(input.text, 1000);
    if (!text) return sendJson(res, 400, { error: "备注不能为空" });
    const remark = { id: crypto.randomUUID(), text, createdAt: now() };
    const ok = await updateStore(store => { const item = store.thoughts.find(value => value.id === id); if (!item) return false; item.remarks.push(remark); return true; });
    return ok ? sendJson(res, 201, remark) : sendJson(res, 404, { error: "记录不存在" });
  }
  if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/remarks\/[^/]+$/.test(url.pathname)) {
    const [, , , id, , remarkId] = url.pathname.split("/"); const input = await bodyJson(req); const text = safeText(input.text, 1000);
    if (!text) return sendJson(res, 400, { error: "备注不能为空" });
    const remark = await updateStore(store => { const item = store.thoughts.find(value => value.id === id); const found = item?.remarks.find(value => value.id === remarkId); if (!found) return null; found.text = text; found.updatedAt = now(); return found; });
    return remark ? sendJson(res, 200, remark) : sendJson(res, 404, { error: "备注不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/remarks\/[^/]+$/.test(url.pathname)) {
    const [, , , id, , remarkId] = url.pathname.split("/");
    const removed = await updateStore(store => { const item = store.thoughts.find(value => value.id === id); if (!item) return false; const before = item.remarks.length; item.remarks = item.remarks.filter(value => value.id !== remarkId); return item.remarks.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "备注不存在" });
  }
  if (req.method === "POST" && /^\/api\/annotations\/[^/]+\/[^/]+$/.test(url.pathname)) {
    const [, , , resourceType, resourceId] = url.pathname.split("/"), input = await bodyJson(req), kind = input.kind === "highlight" ? "highlight" : "comment", targetKey = safeText(input.targetKey, 160), quote = safeText(input.quote, 1000), text = safeText(input.text, 4000), start = Math.max(0, Number(input.start) || 0), end = Math.max(start, Number(input.end) || start);
    if (!targetKey || !quote || (kind === "comment" && !text) || end <= start || end - start > 2000) return sendJson(res, 400, { error: kind === "highlight" ? "请先选中需要划线的正文" : "请选中正文并填写评论" });
    let annotation;
    const saved = await updateStore(store => {
      const root = annotationResource(store, resourceType, resourceId), source = annotationResourceSource(store, resourceType, root, targetKey);
      if (!root || !source.includes(quote)) return false;
      const anchor = annotationAnchorContext(source, start, end, quote);
      annotation = { id: crypto.randomUUID(), kind, targetKey, start, end, quote, text, createdAt: now(), resolved: false, replies: [], ...anchor };
      root.annotations ||= []; root.annotations.push(annotation); return true;
    });
    return saved ? sendJson(res, 201, annotation) : sendJson(res, 404, { error: "选中的正文已变化，请重新选择" });
  }
  if (req.method === "POST" && /^\/api\/annotations\/[^/]+\/[^/]+\/[^/]+\/shenji$/.test(url.pathname)) {
    const [, , , resourceType, resourceId, annotationId] = url.pathname.split("/"), input = await bodyJson(req), message = safeText(input.message, 6000), store = await readStore();
    const root = annotationResource(store, resourceType, resourceId), annotation = root?.annotations?.find(item => item.id === annotationId);
    if (!root || !annotation) return sendJson(res, 404, { error: "评论或划线不存在" });
    const source = annotationResourceSource(store, resourceType, root, annotation.targetKey), excerpt = annotationExcerpt(source, annotation), context = annotationResourceContext(resourceType, root), previous = (annotation.shenji || []).map((item, index) => `<turn index="${index + 1}">\n<user>${item.message || "（未追加问题，直接询问标记内容）"}</user>\n<shenji>${item.answer}</shenji>\n</turn>`).join("\n");
    const prompt = `${userAnswerContext(store)}\n\n<annotation_context>\n<source_type>${context.label}</source_type>\n<source_title>${context.title}</source_title>\n<annotation_kind>${annotation.kind === "highlight" ? "划线" : "评论"}</annotation_kind>\n<source_before>${excerpt.before}</source_before>\n<focus priority="highest">${excerpt.focus}</focus>\n<source_after>${excerpt.after}</source_after>\n<comment_text>${annotation.text || "（无）"}</comment_text>\n</annotation_context>\n\n<previous_shenji_dialogue>${previous || "（无）"}</previous_shenji_dialogue>\n\n<current_user_prompt priority="highest">${message || "请直接分析被标记的内容：判断它是否准确、是否存在概念问题或潜在矛盾，并给出真正有用的建议。"}</current_user_prompt>`;
    const result = await runDeepSeek(prompt, { scene: "annotationShenji", systemPrompt: SHENJI_SYSTEM_PROMPT, captureReasoning: true });
    const exchange = { id: crypto.randomUUID(), createdAt: now(), message, answer: result.content, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) };
    const saved = await updateStore(value => { const currentRoot = annotationResource(value, resourceType, resourceId), current = currentRoot?.annotations?.find(item => item.id === annotationId); if (!current) return false; current.shenji ||= []; current.shenji.push(exchange); return true; });
    return saved ? sendJson(res, 201, exchange) : sendJson(res, 409, { error: "评论或划线状态已变化，请重试" });
  }
  if (req.method === "POST" && /^\/api\/annotations\/[^/]+\/[^/]+\/[^/]+\/replies$/.test(url.pathname)) {
    const [, , , resourceType, resourceId, annotationId] = url.pathname.split("/"), input = await bodyJson(req), text = safeText(input.text, 4000);
    if (!text) return sendJson(res, 400, { error: "回复不能为空" });
    const reply = { id: crypto.randomUUID(), text, createdAt: now() };
    const saved = await updateStore(store => { const root = annotationResource(store, resourceType, resourceId), annotation = root?.annotations?.find(item => item.id === annotationId); if (!annotation || annotation.kind === "highlight") return false; annotation.replies ||= []; annotation.replies.push(reply); return true; });
    return saved ? sendJson(res, 201, reply) : sendJson(res, 404, { error: "评论不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/annotations\/[^/]+\/[^/]+\/drift\/[^/]+$/.test(url.pathname)) {
    const [, , , resourceType, resourceId, , driftId] = url.pathname.split("/");
    const removed = await updateStore(store => { const root = annotationResource(store, resourceType, resourceId); if (!root) return false; root.annotationDrift ||= []; const before = root.annotationDrift.length; root.annotationDrift = root.annotationDrift.filter(item => item.id !== driftId); return root.annotationDrift.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "漂流批注不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/annotations\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)) {
    const [, , , resourceType, resourceId, annotationId] = url.pathname.split("/");
    const removed = await updateStore(store => { const root = annotationResource(store, resourceType, resourceId); if (!root) return false; root.annotations ||= []; const before = root.annotations.length; root.annotations = root.annotations.filter(item => item.id !== annotationId); return root.annotations.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "评论不存在" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/annotations$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req), kind = input.kind === "highlight" ? "highlight" : "comment", targetKey = safeText(input.targetKey, 160), quote = safeText(input.quote, 1000), text = safeText(input.text, 4000), start = Math.max(0, Number(input.start) || 0), end = Math.max(start, Number(input.end) || start);
    if (!targetKey || !quote || (kind === "comment" && !text) || end <= start || end - start > 2000) return sendJson(res, 400, { error: kind === "highlight" ? "请先选中需要划线的正文" : "请选中正文并填写评论" });
    let annotation;
    const saved = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"); if (!root) return false; const source = annotationSourceText(store, root, targetKey); if (!source.includes(quote)) return false; const anchor = annotationAnchorContext(source, start, end, quote); annotation = { id: crypto.randomUUID(), kind, targetKey, start, end, quote, text, createdAt: now(), resolved: false, replies: [], ...anchor }; root.annotations ||= []; root.annotations.push(annotation); return true; });
    return saved ? sendJson(res, 201, annotation) : sendJson(res, 404, { error: "选中的正文已变化，请重新选择" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/annotations\/[^/]+\/shenji$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], annotationId = parts[5], input = await bodyJson(req), message = safeText(input.message, 6000), store = await readStore();
    const root = store.thoughts.find(item => item.id === id && item.type === "question"), annotation = root?.annotations?.find(item => item.id === annotationId);
    if (!root || !annotation) return sendJson(res, 404, { error: "评论或划线不存在" });
    const source = annotationSourceText(store, root, annotation.targetKey), excerpt = annotationExcerpt(source, annotation), previous = (annotation.shenji || []).map((item, index) => `<turn index="${index + 1}">\n<user>${item.message || "（未追加问题，直接询问标记内容）"}</user>\n<shenji>${item.answer}</shenji>\n</turn>`).join("\n");
    const prompt = `${userAnswerContext(store)}\n\n<annotation_context>\n<original_question>${root.content}</original_question>\n<annotation_kind>${annotation.kind === "highlight" ? "划线" : "评论"}</annotation_kind>\n<source_before>${excerpt.before}</source_before>\n<focus priority="highest">${excerpt.focus}</focus>\n<source_after>${excerpt.after}</source_after>\n<comment_text>${annotation.text || "（无）"}</comment_text>\n</annotation_context>\n\n<previous_shenji_dialogue>${previous || "（无）"}</previous_shenji_dialogue>\n\n<current_user_prompt priority="highest">${message || "请直接分析被标记的内容：判断它是否准确、是否存在概念问题或潜在矛盾，并给出真正有用的建议。"}</current_user_prompt>`;
    const result = await runDeepSeek(prompt, { scene: "annotationShenji", systemPrompt: SHENJI_SYSTEM_PROMPT, captureReasoning: true });
    const exchange = { id: crypto.randomUUID(), createdAt: now(), message, answer: result.content, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) };
    const saved = await updateStore(value => { const currentRoot = value.thoughts.find(item => item.id === id && item.type === "question"), current = currentRoot?.annotations?.find(item => item.id === annotationId); if (!current) return false; current.shenji ||= []; current.shenji.push(exchange); return true; });
    return saved ? sendJson(res, 201, exchange) : sendJson(res, 409, { error: "评论或划线状态已变化，请重试" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/annotations\/[^/]+\/replies$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], annotationId = parts[5], input = await bodyJson(req), text = safeText(input.text, 4000);
    if (!text) return sendJson(res, 400, { error: "回复不能为空" });
    const reply = { id: crypto.randomUUID(), text, createdAt: now() };
    const saved = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"), annotation = root?.annotations?.find(item => item.id === annotationId); if (!annotation || annotation.kind === "highlight") return false; annotation.replies ||= []; annotation.replies.push(reply); return true; });
    return saved ? sendJson(res, 201, reply) : sendJson(res, 404, { error: "评论不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/annotations\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], annotationId = parts[5];
    const removed = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"); if (!root) return false; root.annotations ||= []; const before = root.annotations.length; root.annotations = root.annotations.filter(item => item.id !== annotationId); return root.annotations.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "评论不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/annotation-drift\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], driftId = parts[5];
    const removed = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"); if (!root) return false; root.annotationDrift ||= []; const before = root.annotationDrift.length; root.annotationDrift = root.annotationDrift.filter(item => item.id !== driftId); return root.annotationDrift.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "漂流批注不存在" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/answer$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const store = await readStore(); const question = store.thoughts.find(item => item.id === id && item.type === "question");
    if (!question) return sendJson(res, 404, { error: "问题不存在" });
    if (store.thoughts.some(item => item.relatedTo === id && item.type === "answer")) return sendJson(res, 409, { error: "这套思考已经有回答" });
    const prompt = userPrompt({ context: userAnswerContext(store), chain: thoughtChainContext(store, question), task: "回答原始问题。直接写出明确主张，再用最关键的理由、反例和边界支撑；不要添加“核心判断”“结论”“我的判断”“给我判断”“给你一个判断”等元标签。该下判断时不要只抛问题。哲学或抽象主题先补足理解主张所必需的背景，避免只罗列流派。时效性事实若无法实时核实，明确说明。" });
    return respondWithModel(req, res, {
      prompt,
      status: 201,
      options: { scene: "thoughtAnswer" },
      complete: async (content, reasoningContent) => {
        content = stripThoughtAnswerLead(content);
        const answer = { id: crypto.randomUUID(), createdAt: now(), occurredAt: question.occurredAt, occurredOn: question.occurredOn, type: "answer", content, modelDraft: content, editedFromModel: false, tags: question.tags, relatedTo: id, disposition: question.disposition || "kept", remarks: [], origin: "deepseek", ...(reasoningContent ? { reasoningContent } : {}) };
        const saved = await updateStore(value => {
          if (value.thoughts.some(item => item.relatedTo === id && item.type === "answer")) return null;
          value.thoughts.unshift(answer); return answer;
        });
        if (!saved) throw new Error("这套思考已经有回答");
        return saved;
      }
    });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/follow-ups$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const input = await bodyJson(req); const text = safeText(input.question, 6000), answer = safeText(input.answer, 20000);
    if (!text) return sendJson(res, 400, { error: "请先写下追问" });
    const followUp = { id: crypto.randomUUID(), createdAt: now(), question: text, answer, ...(answer ? { answeredAt: now() } : {}), origin: "manual" };
    const saved = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"); if (!root) return false; root.followUps ||= []; root.followUps.push(followUp); return true; });
    return saved ? sendJson(res, 201, followUp) : sendJson(res, 404, { error: "问题不存在" });
  }
  if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], followUpId = parts[5], input = await bodyJson(req), hasQuestion = Object.prototype.hasOwnProperty.call(input, "question"), hasAnswer = Object.prototype.hasOwnProperty.call(input, "answer"), question = hasQuestion ? safeText(input.question, 6000) : null, answer = hasAnswer ? safeText(input.answer, 20000) : null;
    if (!hasQuestion && !hasAnswer) return sendJson(res, 400, { error: "没有需要更新的内容" });
    if (hasQuestion && !question) return sendJson(res, 400, { error: "追问问题不能为空" });
    const updated = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"), followUp = root?.followUps?.find(item => item.id === followUpId); if (!followUp) return null; if (hasQuestion) { reanchorAnnotations(root, `followup-question:${followUpId}`, followUp.question, question); followUp.question = question; } if (hasAnswer) { reanchorAnnotations(root, `followup-answer:${followUpId}`, followUp.answer || "", answer); followUp.answer = answer; followUp.answeredAt = answer ? now() : null; if (followUp.modelDraft) followUp.editedFromModel = followUp.modelDraft !== answer; followUp.origin = "manual"; } followUp.updatedAt = now(); return followUp; });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "追问不存在" });
  }
  if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], followUpId = parts[5];
    const removed = await updateStore(store => { const root = store.thoughts.find(item => item.id === id && item.type === "question"); if (!root) return false; root.followUps ||= []; const current = root.followUps.find(item => item.id === followUpId), before = root.followUps.length; if (current) { reanchorAnnotations(root, `followup-question:${followUpId}`, current.question, "", "追问已删除"); reanchorAnnotations(root, `followup-answer:${followUpId}`, current.answer || "", "", "追问已删除"); } root.followUps = root.followUps.filter(item => item.id !== followUpId); return root.followUps.length < before; });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "追问不存在" });
  }
  if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+\/answer$/.test(url.pathname)) {
    const parts = url.pathname.split("/"), id = parts[3], followUpId = parts[5], store = await readStore();
    const root = store.thoughts.find(item => item.id === id && item.type === "question"), followUp = root?.followUps?.find(item => item.id === followUpId);
    if (!root || !followUp) return sendJson(res, 404, { error: "追问不存在" });
    if (followUp.answer) return sendJson(res, 409, { error: "这条追问已经有回答" });
    const prompt = userPrompt({ context: userAnswerContext(store), chain: thoughtChainContext(store, root, followUpId), task: "回答标记为 current=true 的当前追问。完整理解整条链，但不要机械重述原始回答；只保留支撑当前答案所需的前后文，并把事实、推断和建议分开。" });
    return respondWithModel(req, res, {
      prompt,
      status: 201,
      options: { scene: "followUpAnswer" },
      complete: async (content, reasoningContent) => {
        const updated = await updateStore(value => {
          const currentRoot = value.thoughts.find(item => item.id === id && item.type === "question"), current = currentRoot?.followUps?.find(item => item.id === followUpId);
          if (!current || current.answer) return null;
          current.answer = content; current.modelDraft = content; current.answeredAt = now(); current.origin = "deepseek"; if (reasoningContent) current.reasoningContent = reasoningContent; return current;
        });
        if (!updated) throw new Error("追问状态已变更，请刷新后重试");
        return updated;
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    const input = await bodyJson(req); const message = safeText(input.message); if (!message) return sendJson(res, 400, { error: "请先写下问题" });
    const store = await readStore(), history = [...store.chats].slice(0, 12).reverse().flatMap(item => [{ role: "user", content: item.message }, { role: "assistant", content: item.answer }]);
    const eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const result = await runDeepSeek(userPrompt({ context: userAnswerContext(store), task: message }), { scene: "chat", history, captureReasoning: true }); const chat = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, message, answer: result.content, annotations: [], annotationDrift: [], ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) };
    await updateStore(store => store.chats.unshift(chat)); return sendJson(res, 200, chat);
  }
  if (req.method === "POST" && url.pathname === "/api/analysis/run") return sendJson(res, 201, await generateReflection("manual"));
  if (req.method === "POST" && url.pathname === "/api/custom-metrics") {
    const input = await bodyJson(req); const name = safeText(input.name, 40); if (!name) return sendJson(res, 400, { error: "请填写指标名" });
    const metric = { id: crypto.randomUUID(), name, low: safeText(input.low, 60) || "很低", high: safeText(input.high, 60) || "很高", createdAt: now() };
    await updateStore(store => store.customMetrics.push(metric)); return sendJson(res, 201, metric);
  }
  if (req.method === "POST" && url.pathname === "/api/experiments") {
    const input = await bodyJson(req); const hypothesis = safeText(input.hypothesis, 500); const factor = safeText(input.factor, 80); if (!hypothesis || !factor) return sendJson(res, 400, { error: "请填写假设和唯一实验因素" });
    const outcome = ["mood", "energy", "stress", "sleep"].includes(input.outcome) ? input.outcome : "mood";
    const experiment = { id: crypto.randomUUID(), createdAt: now(), hypothesis, factor, outcome, duration: [14, 30, 60].includes(Number(input.duration)) ? Number(input.duration) : 30, status: "active" };
    await updateStore(store => store.experiments.unshift(experiment)); return sendJson(res, 201, experiment);
  }
  if (req.method === "POST" && url.pathname === "/api/books/parse") {
    const input = await bodyJson(req), parsed = await parseImageRequest(input, "book");
    return sendJson(res, 200, parsed);
  }
  if (req.method === "POST" && url.pathname === "/api/books") {
    const input = await bodyJson(req); const title = safeText(input.title, 300); if (!title) return sendJson(res, 400, { error: "书名不能为空" });
    const readingStartedOn = strictDateKey(input.readingStartedOn), readingFinishedOn = strictDateKey(input.readingFinishedOn);
    if (!readingStartedOn) return sendJson(res, 400, { error: "请填写有效的阅读开始日期" });
    if (readingFinishedOn == null) return sendJson(res, 400, { error: "阅读结束日期格式不正确" });
    if (readingFinishedOn && readingFinishedOn < readingStartedOn) return sendJson(res, 400, { error: "阅读结束日期不能早于开始日期" });
    const book = { id: crypto.randomUUID(), createdAt: now(), title, author: safeText(input.author, 200), publisher: safeText(input.publisher, 200), isbn: safeText(input.isbn, 80), description: safeText(input.description, 2000), readingStartedOn, readingFinishedOn, imagePath: cleanAttachmentPaths([input.imagePath])[0] || "", notes: [], annotations: [], annotationDrift: [] };
    await updateStore(store => store.books.unshift(book)); return sendJson(res, 201, book);
  }
  if (req.method === "PATCH" && /^\/api\/books\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req), title = safeText(input.title, 300);
    if (!title) return sendJson(res, 400, { error: "书名不能为空" });
    const readingStartedOn = hasOwn(input, "readingStartedOn") ? strictDateKey(input.readingStartedOn) : undefined;
    const readingFinishedOn = hasOwn(input, "readingFinishedOn") ? strictDateKey(input.readingFinishedOn) : undefined;
    if (readingStartedOn === null || readingFinishedOn === null) return sendJson(res, 400, { error: "阅读日期格式不正确" });
    if (hasOwn(input, "readingStartedOn") && !readingStartedOn) return sendJson(res, 400, { error: "请填写有效的阅读开始日期" });
    const updated = await updateStore(store => {
      const book = store.books.find(item => item.id === id);
      if (!book) return null;
      const nextStartedOn = readingStartedOn === undefined ? book.readingStartedOn || "" : readingStartedOn;
      const nextFinishedOn = readingFinishedOn === undefined ? book.readingFinishedOn || "" : readingFinishedOn;
      if (nextFinishedOn && (!nextStartedOn || nextFinishedOn < nextStartedOn)) return { validationError: "阅读结束日期不能早于开始日期" };
      const description = safeText(input.description, 2000);
      reanchorAnnotations(book, "description", book.description || "", description);
      book.title = title;
      book.author = safeText(input.author, 200);
      book.publisher = safeText(input.publisher, 200);
      book.isbn = safeText(input.isbn, 80);
      book.description = description;
      book.readingStartedOn = nextStartedOn;
      book.readingFinishedOn = nextFinishedOn;
      if (hasOwn(input, "imagePath")) book.imagePath = cleanAttachmentPaths([input.imagePath])[0] || "";
      book.updatedAt = now();
      return book;
    });
    if (updated?.validationError) return sendJson(res, 400, { error: updated.validationError });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "书目不存在" });
  }
  if (req.method === "POST" && /^\/api\/books\/[^/]+\/notes$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3]; const input = await bodyJson(req); const content = safeText(input.content); if (!content) return sendJson(res, 400, { error: "内容不能为空" });
    const eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const note = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, type: input.type === "thought" ? "thought" : "record", favorite: ["star", "sprout"].includes(input.favorite) ? input.favorite : "none", content };
    const ok = await updateStore(store => { const book = store.books.find(item => item.id === id); if (!book) return false; book.notes.unshift(note); return true; });
    return ok ? sendJson(res, 201, note) : sendJson(res, 404, { error: "书目不存在" });
  }
  if (req.method === "PATCH" && /^\/api\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
    const [, , , bookId, , noteId] = url.pathname.split("/"), input = await bodyJson(req), content = safeText(input.content);
    if (!content) return sendJson(res, 400, { error: "内容不能为空" });
    const updated = await updateStore(store => {
      const book = store.books.find(item => item.id === bookId), note = book?.notes?.find(item => item.id === noteId);
      if (!book || !note) return null;
      const eventTime = eventTimeFields(input, note);
      if (!eventTime) return null;
      reanchorAnnotations(book, `note:${noteId}`, note.content, content);
      note.content = content; note.type = input.type === "thought" ? "thought" : "record";
      note.favorite = ["none", "star", "sprout"].includes(input.favorite) ? input.favorite : note.favorite || "none";
      Object.assign(note, eventTime); note.updatedAt = now();
      return note;
    });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "书目记录不存在或时间格式不正确" });
  }
  if (req.method === "DELETE" && /^\/api\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
    const [, , , bookId, , noteId] = url.pathname.split("/");
    const removed = await updateStore(store => {
      const book = store.books.find(item => item.id === bookId), note = book?.notes?.find(item => item.id === noteId);
      if (!book || !note) return false;
      reanchorAnnotations(book, `note:${noteId}`, note.content, "", "读书记录已删除");
      book.notes = book.notes.filter(item => item.id !== noteId);
      return true;
    });
    return removed ? sendJson(res, 200, { removed: 1 }) : sendJson(res, 404, { error: "书目记录不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/keepsakes") {
    const input = await bodyJson(req), parsed = keepsakePayload(input);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const keepsake = { id: crypto.randomUUID(), createdAt: now(), ...parsed.value };
    await updateStore(store => store.keepsakes.unshift(keepsake));
    return sendJson(res, 201, keepsake);
  }
  if (req.method === "PATCH" && /^\/api\/keepsakes\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req);
    const updated = await updateStore(store => {
      const keepsake = store.keepsakes.find(item => item.id === id);
      if (!keepsake) return { missing: true };
      const parsed = keepsakePayload(input, keepsake);
      if (parsed.error) return { error: parsed.error };
      Object.assign(keepsake, parsed.value, { updatedAt: now() });
      return { value: keepsake };
    });
    if (updated.missing) return sendJson(res, 404, { error: "这件小物不存在" });
    if (updated.error) return sendJson(res, 400, { error: updated.error });
    return sendJson(res, 200, updated.value);
  }
  if (req.method === "DELETE" && /^\/api\/keepsakes\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], removed = await updateStore(store => {
      const before = store.keepsakes.length;
      store.keepsakes = store.keepsakes.filter(item => item.id !== id);
      return before - store.keepsakes.length;
    });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "这件小物不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/quotes") {
    const input = await bodyJson(req); const source = safeText(input.source, 500); const content = safeText(input.content, 5000); if (!source || !content) return sendJson(res, 400, { error: "来源和内容都必须填写" });
    const eventTime = eventTimeFields(input);
    if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
    const tags = (Array.isArray(input.tags) ? input.tags : []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8);
    const quote = { id: crypto.randomUUID(), createdAt: now(), ...eventTime, source, content, tags, annotations: [], annotationDrift: [] };
    await updateStore(store => store.quotes.unshift(quote)); return sendJson(res, 201, quote);
  }
  if (req.method === "PATCH" && /^\/api\/quotes\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], input = await bodyJson(req), source = safeText(input.source, 500), content = safeText(input.content, 5000);
    if (!source || !content) return sendJson(res, 400, { error: "来源和内容都必须填写" });
    const updated = await updateStore(store => {
      const quote = store.quotes.find(item => item.id === id);
      if (!quote) return null;
      const eventTime = eventTimeFields(input, quote);
      if (!eventTime) return null;
      reanchorAnnotations(quote, "content", quote.content, content);
      quote.source = source; quote.content = content;
      quote.tags = (Array.isArray(input.tags) ? input.tags : []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8);
      Object.assign(quote, eventTime); quote.updatedAt = now();
      return quote;
    });
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "善言不存在或时间格式不正确" });
  }
  if (req.method === "DELETE" && /^\/api\/quotes\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3], removed = await updateStore(store => {
      const before = store.quotes.length;
      store.quotes = store.quotes.filter(item => item.id !== id);
      return before - store.quotes.length;
    });
    return removed ? sendJson(res, 200, { removed }) : sendJson(res, 404, { error: "善言不存在" });
  }
  return sendJson(res, 404, { error: "Not found" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
await ensureStore();
await ensureLlmSettings();
await ensureAiUsage();
await ensureAuditLogs();
await fs.mkdir(USERS_DIR, { recursive: true, mode: 0o700 });
await fs.chmod(USERS_DIR, 0o700);
if (AUTH_REQUIRED) {
  const auth = await readAuth();
  for (const user of auth.users) {
    await requestStorage.run({ user, dataDir: userDataDir(user) }, async () => {
      await ensureStore();
      await ensureLlmSettings();
      await ensureAiUsage();
      await ensureAuditLogs();
    });
  }
}
const periodicFailure = error => logEvent("system", "scheduler.failed", { level: "error", error: errorMetadata(error) });
setTimeout(() => void runPeriodicAnalyses().catch(periodicFailure), 5000).unref();
setInterval(() => void runPeriodicAnalyses().catch(periodicFailure), 3600000).unref();
http.createServer((req, res) => {
  const suppliedTraceId = safeText(req.headers["x-request-id"], 128);
  const traceId = /^[A-Za-z0-9_.:-]{8,128}$/.test(suppliedTraceId) ? suppliedTraceId : crypto.randomUUID();
  const context = { traceId, method: req.method, route: "", dataDir: DATA_DIR, secrets: [] };
  const started = Date.now();
  return requestStorage.run(context, async () => {
  try {
    res.setHeader("x-request-id", traceId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "same-origin");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (APP_BASE_PATH !== "/" && url.pathname === APP_BASE_PATH) {
      res.writeHead(308, { location: `${APP_BASE_PATH}/${url.search}` });
      return res.end();
    }
    if (APP_BASE_PATH !== "/" && url.pathname.startsWith(`${APP_BASE_PATH}/`)) {
      url.pathname = url.pathname.slice(APP_BASE_PATH.length) || "/";
    }
    context.route = safeText(url.pathname, 400);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") return sendJson(res, 200, { ok: true, version: process.env.APP_VERSION || "development" });
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
    if (unsafe && String(req.headers["sec-fetch-site"] || "") === "cross-site") return sendJson(res, 403, { error: "跨站请求已拒绝" });
    if (UPSTREAM_ORIGIN && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/"))) return await proxyToUpstream(req, res, url);
    const user = await requestUser(req);
    if (url.pathname.startsWith("/api/auth/")) {
      const handled = await authApi(req, res, url);
      return handled === false ? sendJson(res, 404, { error: "Not found" }) : handled;
    }
    if (url.pathname.startsWith("/api/") && !user) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
    if (url.pathname.startsWith("/attachments/") && !user) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
      if (req.method === "GET" && url.pathname === "/api/meta") return sendJson(res, 200, { version: process.env.APP_VERSION || "development", user: publicUser(user) });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (url.pathname.startsWith("/attachments/")) {
        const name = url.pathname.replace("/attachments/", "");
        if (!/^[\w.-]+$/.test(name)) return sendJson(res, 403, { error: "Forbidden" });
        const localFile = path.join(storagePaths().attachmentsDir, name);
        const data = await attachmentStorage.get({ ownerId: attachmentOwnerId(), name, localFile });
        res.writeHead(200, { "content-type": mime[path.extname(name).toLowerCase()] || "application/octet-stream", "cache-control": "private, no-store" });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      const base = PUBLIC_DIR, relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.resolve(base, relative); if (!file.startsWith(`${base}${path.sep}`) && file !== path.join(base, "index.html")) return sendJson(res, 403, { error: "Forbidden" });
      const data = await fs.readFile(file); res.writeHead(200, { "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" }); res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(res, 404, { error: "Not found" });
    context.errorCode = errorMetadata(error).code;
    context.applicationStatus = error.statusCode || 500;
    await logEvent("system", "request.failed", { level: context.applicationStatus >= 500 ? "error" : "warn", error: errorMetadata(error) });
    if (!res.headersSent && !res.destroyed) sendJson(res, context.applicationStatus, { error: redact(error.message || "服务暂时不可用", context.secrets), code: context.errorCode });
    else if (!res.writableEnded) res.end();
  } finally {
    if (context.route.startsWith("/api/") || context.errorCode) {
      const status = context.applicationStatus || res.statusCode;
      const fields = {
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        statusCode: status, httpStatus: res.statusCode, durationMs: Date.now() - started,
        result: status >= 400 ? "failed" : res.destroyed && !res.writableFinished ? "disconnected" : "success",
        errorCode: context.errorCode || "", changeCount: context.changeCount || 0
      };
      await logEvent("system", "request.completed", fields);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        await logEvent("operation", "request.completed", { ...fields, action: `${req.method} ${context.route}`, resourceType: context.route.split("/")[2] || "", resourceId: context.route.split("/")[3] || "" });
      }
    }
  }
  });
}).listen(PORT, "127.0.0.1", () => void logEvent("system", "server.started", { level: "info", port: PORT }));
