#!/usr/bin/env node
/**
 * 采集脱敏生产状态，并验证隔离 PostgreSQL 下的启动、恢复与核心链路。
 * 建立时间：2026-10-12
 * 状态：active
 * 边界：生产仅只读；脱敏保持账户与来源契约；本机验证禁止真实外部调用并清理临时资源。
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

type JsonRecord = Record<string, unknown>;
type InspectorTarget = {
  targetOptional: boolean;
  requiresExistingTarget: boolean;
  requiresExistingSubtarget: boolean;
  exists: boolean;
  subtargetExists: boolean;
} | null;
type RecoveryInspection = {
  target: InspectorTarget;
  intent: { inputVersion?: number; subtargetVersion?: number; alreadyAnswered: boolean; inputHash?: string } | null;
  intentMatch: string;
};
type InspectionClock = { capturedAt: string; timezone: string };
type RuntimeInspector = {
  inspectRecoveryIntent(store: JsonRecord, task: JsonRecord): RecoveryInspection;
  schedule(taskId: string): unknown;
};
type ContentRuntime = { backgroundAi: RuntimeInspector; materializeAttachmentFiles?: (...args: unknown[]) => unknown };
type ContentRuntimeFactory = (options: JsonRecord) => ContentRuntime;
type StoreMapping = {
  fields: JsonRecord[];
  objects: JsonRecord[];
  relations: JsonRecord[];
  attachmentRefs: JsonRecord[];
  lifecycles: JsonRecord[];
  idempotency: JsonRecord[];
};
type AccountDocuments = { settings: JsonRecord; usage: JsonRecord; costPlan: JsonRecord | null };
type PersistenceApi = {
  readAccountDocument(client: PgClient, accountId: string, name: string, fallback?: null): Promise<JsonRecord | null>;
  writeAccountDocument(client: PgClient, accountId: string, name: string, value: JsonRecord): Promise<void>;
  mapAccountDocument(accountId: string, name: string, value: JsonRecord): JsonRecord;
  rebuildAccountDocument(mapping: JsonRecord): JsonRecord;
  mapStoreObjects(accountId: string, store: JsonRecord): StoreMapping;
  readPostgresStoreObjects(client: PgClient, accountId: string): Promise<StoreMapping>;
  rebuildStoreObjects(mapping: StoreMapping): JsonRecord;
  writeStoreObjects(client: PgClient, mapping: StoreMapping): Promise<void>;
  initializePostgresSchema(client: PgClient): Promise<void>;
  writeAuthDocument(client: PgClient, document: JsonRecord): Promise<void>;
  canonicalJson(value: unknown): string;
  storeContentSha256(value: unknown): string;
};
type PersistenceMetadataApi = {
  preparePersistenceDocument(document: JsonRecord, now: () => string, options?: { force?: boolean }): JsonRecord;
  synchronizePersistenceMetadata(before: JsonRecord | null, after: JsonRecord, now: () => string, options: JsonRecord): JsonRecord;
  syncOperationFingerprint(context: JsonRecord): string;
};
type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: JsonRecord[]; rowCount?: number | null }>;
};
type PgModule = { Client: new (options: { connectionString: string }) => PgClient };
type StartupGatePort = {
  tempRoot: string;
  holdDispatch(kind: string, callback: (...args: unknown[]) => unknown): null;
  observeEffect(kind: string, operation: string): void;
  counts: Record<string, number>;
};
type LocalPostgresState = {
  binDirectory: string;
  cluster: string;
  port: number;
  password: string;
  adminUrl: string;
  url(user: string): string;
  env: Record<string, string | undefined>;
};

const execFile = promisify(execFileCallback);
const scrypt = promisify(scryptCallback);
const REQUIRED_PG_BINARIES = ["postgres", "initdb", "pg_ctl"] as const;
const ENUM_STRING_KEYS = new Set([
  "kind", "type", "status", "resourceType", "operation", "mode", "targetType", "role",
  "authorType", "origin", "informationType", "lifecycle", "state", "shape", "field",
  "fieldName", "collection", "relation", "targetCollection", "resolution", "storage", "disposition", "format",
  "provider", "scene", "view", "answerDisposition", "visibility", "category"
]);
const STRUCTURAL_TIME_KEYS = new Set([
  "createdAt", "updatedAt", "deletedAt", "restoredAt", "purgedAt", "startedAt",
  "completedAt", "occurredAt", "occurredOn", "capturedAt", "recordedAt", "observedAt",
  "expiresAt", "windowStart", "windowEnd", "lastSeenAt", "generatedAt", "contextGeneratedAt",
  "inputAsOf", "asOf", "date", "localDate"
]);
const IDENTIFIER_KEYS = new Set([
  "id", "accountId", "userId", "targetId", "subtargetId", "taskId", "sourceTaskId",
  "retryOf", "resultId", "resourceId", "recordId", "rootId", "parentId", "quoteId",
  "questionId", "answerId", "citationId", "trashId", "requestId", "clientRequestId",
  "relatedTo", "sourceId", "sourceCaptureId", "supersedes", "resolvedBy", "habitId", "journalId"
]);
const ATTACHMENT_PATH_FIELDS = new Set(["path", "attachmentPath", "asrAttachmentPath", "attachmentPaths"]);
const SPEECH_CACHE_SOURCE_TYPES = new Set(["capture", "thoughtAnswer", "thoughtChain"]);
const SYNC_PUBLIC_DOMAINS = new Set([
  "checkins", "dailyRecords", "captures", "journals", "journalDraft", "thoughts", "chats", "books",
  "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "aiTasks", "notifications",
  "actions", "habits", "habitCheckins", "feedback", "validationLedger", "userClaims", "modelUnknowns",
  "onboarding", "onboardingV2", "commercialization", "trash", "speechCache"
]);
const PERSISTENCE_RESOURCE_TYPES = new Set([
  "checkin", "dailyRecord", "capture", "journal", "chat", "book", "keepsake", "quote", "experiment",
  "analysis", "customMetric", "action", "habit", "habitCheckin", "feedback", "validationLedger",
  "userClaim", "modelUnknown", "evidenceSource", "evidencePermission", "perceptionEvent", "thoughtRemark",
  "thoughtFollowUp", "journalReflection", "bookNote", "annotation", "thoughtChain", "thoughtBlock", "journalDraft"
]);
const SAFE_DIAGNOSTIC_PATH_FIELDS = new Set([
  "speechCache", "sourceVersions", "question", "conclusion", "answer", "sourceType", "sourceId", "id", "cacheKey"
]);
const TIMEZONE_KEYS = new Set(["timezone", "timeZone", "recordTimezone", "recordTimeZone"]);
const SOURCE_TARGET_PREFIXES = new Set([
  "annotation", "annotation-reply", "question", "followup-question", "followup-answer",
  "idea", "answer", "record", "note", "reflection"
]);
const SOURCE_TARGET_LITERALS = new Set(["content", "message", "transcription", "answer", "description"]);

type RedactionContext = {
  key: Buffer;
  ids: Map<string, string>;
  paths: Map<string, string>;
  sourceKeys: Map<string, string>;
  targetKeys: Map<string, string>;
  objectKeys: Map<string, string>;
  resourceKeys: Map<string, string>;
  annotationQuoteTokens: Map<string, string>;
  supplementStatementTokens: Map<string, string>;
  markdownText: (value: string) => string;
  singletonIds: Set<string>;
};

type OnboardingV2Api = {
  onboardingV2Schema: { steps: string[]; statuses: string[]; questions: Array<{
    questionId: string; horizons?: string[]; answerDispositions?: Array<{ value: string }>;
    axes?: Record<string, { values: string[] }>;
  }> };
  normalizeOnboardingV2(value: unknown, legacy?: unknown): JsonRecord;
  onboardingV2ContextEntries(value: unknown): JsonRecord[];
};

type CaptureAudioApi = {
  captureAudioPayload(value: unknown): { value?: JsonRecord | null; code?: string; error?: string };
};

type SupplementEstimator = (records: unknown[]) => number;

function fail(message: string): never {
  throw new Error(message);
}

function createInspectionClock(capturedAt = new Date().toISOString(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): InspectionClock {
  return { capturedAt, timezone };
}

function localDateAt(clock: InspectionClock): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: clock.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(clock.capturedAt)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 编译后从脚本位置向上定位项目，避免导入时触发应用运行时。
async function findRootDirectory(): Promise<string> {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8")) as JsonRecord;
      if (pkg.name === "personal-growth-tracker") return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) fail("Could not locate repository package.json");
    current = parent;
  }
}

async function importFromRoot<T>(root: string, relativePath: string): Promise<T> {
  return await import(pathToFileURL(path.join(root, relativePath)).href) as T;
}

function createClosedInspector(root: string, accountId: string, counts: Record<string, number> = {}, clock = createInspectionClock()) {
  const forbidden = (kind: string, operation: string): never => {
    counts[kind] = (counts[kind] || 0) + 1;
    throw new Error(`Startup gate blocked ${kind}:${operation}`);
  };
  const repository = {
    read: async () => forbidden("repository", "read"),
    update: async () => forbidden("repository", "update"),
    executeIdempotent: async () => forbidden("repository", "executeIdempotent")
  };
  const mediaFactory = () => ({
    attachmentCleanup: { drain: async () => forbidden("media", "cleanup") },
    materializeAttachmentFiles: async () => forbidden("media", "materializeAttachmentFiles"),
    transcribeCapture: async () => forbidden("media", "transcribeCapture"),
    listAttachmentInventory: async () => forbidden("media", "listAttachmentInventory"),
    speechProvider: { configured: false, supportedAsrMimeTypes: [] }
  });
  const effectObserver = (kind: string, operation: string): never => forbidden(kind, operation);
  const createContentRuntime = importFromRoot<{ createContentRuntime: ContentRuntimeFactory }>(root, "src/app/content-runtime.mjs");
  return createContentRuntime.then(({ createContentRuntime: createRuntime }) => createRuntime({
    repository,
    trashRetentionDays: 30,
    getAccountId: () => accountId,
    getCursorScope: () => accountId,
    backgroundContextKey: () => "startup-gate-inspector",
    workflowContextKey: () => "startup-gate-inspector",
    dispatchBackground: (callback: (...args: unknown[]) => unknown) => forbidden("dispatch", "background"),
    runDeepSeek: async () => forbidden("provider", "deepseek"),
    readAiUsage: async () => ({ entries: [] }),
    today: () => localDateAt(clock),
    createId: () => "synthetic-id",
    hash: (value: unknown) => createHash("sha256").update(String(value)).digest("hex"),
    now: () => clock.capturedAt,
    currentTime: () => Date.parse(clock.capturedAt),
    logEvent: async () => forbidden("outbound", "log"),
    debugFetch: async () => forbidden("outbound", "debug"),
    mediaFactory,
    effectObserver
  }));
}

function identityToken(key: Buffer, namespace: string, value: string): string {
  return `${namespace}_${createHmac("sha256", key).update(`${namespace}\0${value}`).digest("hex")}`;
}

function compactToken(
  key: Buffer,
  namespace: string,
  value: string,
  prefix: string,
  suffix: string,
  aliases: Map<string, string>,
  initialHexLength: number
): string {
  const digest = createHmac("sha256", key).update(`${namespace}\0${value}`).digest("hex");
  for (let hexLength = initialHexLength; hexLength <= digest.length; hexLength += 2) {
    const bitCount = hexLength * 4;
    const body = BigInt(`0x${digest.slice(0, hexLength)}`)
      .toString(36)
      .padStart(Math.ceil(bitCount / Math.log2(36)), "0");
    const token = `${prefix}${body}${suffix}`;
    const collision = [...aliases].some(([otherValue, otherToken]) => otherValue !== value && otherToken === token);
    if (!collision) {
      aliases.set(value, token);
      return token;
    }
  }
  fail("Snapshot compact redaction token collision could not be resolved");
}

function redactionAtom(key: Buffer, namespace: string, value: string, prefix: "Q" | "V"): string {
  return `${prefix}${createHmac("sha256", key).update(`${namespace}\0${value}`).digest("hex")}Z`;
}

/** 仅实际captures集合的顶层对象，不包含trash或用户扩展中的同名audio。 */
function isCaptureMappingRow(row: JsonRecord): boolean {
  return row.kind === "capture" && row.collection === "captures" && row.field === "captures"
    && row.parentKey === null && typeof row.id === "string" && row.objectKey === JSON.stringify(["captures", row.id]);
}

function createRedactionContext(
  mapping: StoreMapping,
  key: Buffer,
  markdownText: (value: string) => string,
  inventory: JsonRecord[] = []
): RedactionContext {
  const context: RedactionContext = {
    key,
    ids: new Map(),
    paths: new Map(),
    sourceKeys: new Map(),
    targetKeys: new Map(),
    objectKeys: new Map(),
    resourceKeys: new Map(),
    annotationQuoteTokens: new Map(),
    supplementStatementTokens: new Map(),
    markdownText,
    singletonIds: new Set()
  };
  const redactId = (value: string) => {
    if (!value) return value;
    if (!context.ids.has(value)) context.ids.set(value, identityToken(key, "id", value));
    return context.ids.get(value)!;
  };
  const redactPath = (value: string) => {
    if (!value) return value;
    if (!context.paths.has(value)) {
      const attachment = value.match(/^(\/attachments\/)([^/]+)$/u);
      if (attachment) {
        const extension = path.extname(attachment[2]);
        const stem = extension ? attachment[2].slice(0, -extension.length) : attachment[2];
        const opaqueName = identityToken(key, "path", stem);
        context.paths.set(value, `${attachment[1]}${opaqueName}${extension}`);
      } else {
        context.paths.set(value, identityToken(key, "path", value));
      }
    }
    return context.paths.get(value)!;
  };
  const parseArrayKey = (value: string): string[] | null => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : null;
    } catch {
      return null;
    }
  };
  const redactSemanticTargetKey = (value: string) => {
    if (context.targetKeys.has(value)) return context.targetKeys.get(value)!;
    if (!value) return value;
    if (SOURCE_TARGET_LITERALS.has(value)) {
      context.targetKeys.set(value, value);
      return value;
    }
    const separator = value.indexOf(":");
    let result = "";
    if (separator > 0 && separator < value.length - 1) {
      const prefix = value.slice(0, separator);
      const safePrefix = SOURCE_TARGET_PREFIXES.has(prefix)
        ? prefix
        : identityToken(key, "target-prefix", prefix);
      result = `${safePrefix}:${redactId(value.slice(separator + 1))}`;
    } else {
      result = identityToken(key, "target-key", value);
    }
    context.targetKeys.set(value, result);
    return result;
  };
  const redactSourceTargetKey = (value: string) => redactSemanticTargetKey(value);
  const redactPayloadTargetKey = (value: string) => redactSemanticTargetKey(value);
  const redactSourceKey = (value: string) => {
    if (context.sourceKeys.has(value)) return context.sourceKeys.get(value)!;
    try {
      const parts = JSON.parse(value);
      if (!Array.isArray(parts) || parts.length !== 4 || parts.some(item => typeof item !== "string")
        || !parts[0] || !parts[1] || JSON.stringify(parts) !== value) {
        fail("Snapshot source key has an unsupported structure");
      }
      const result = JSON.stringify([
        parts[0],
        redactId(parts[1]),
        parts[2] ? redactId(parts[2]) : "",
        parts[3] ? redactSourceTargetKey(parts[3]) : ""
      ]);
      context.sourceKeys.set(value, result);
      context.ids.set(value, result);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Snapshot ")) throw error;
      fail("Snapshot source key cannot be parsed safely");
    }
  };
  const redactResourceKey = (value: string) => {
    if (!value) return value;
    if (context.resourceKeys.has(value)) return context.resourceKeys.get(value)!;
    const result = value.split("/").map(segment => {
      const separator = segment.indexOf(":");
      if (separator < 1 || separator === segment.length - 1) fail("Snapshot resource key is not structurally valid");
      const resourceType = segment.slice(0, separator);
      const resourceId = segment.slice(separator + 1);
      const mappedId = resourceId.startsWith("[") ? redactSourceKey(resourceId) : redactId(resourceId);
      const mappedType = PERSISTENCE_RESOURCE_TYPES.has(resourceType)
        ? resourceType
        : identityToken(key, "resource-type", resourceType);
      return `${mappedType}:${mappedId}`;
    }).join("/");
    context.resourceKeys.set(value, result);
    return result;
  };
  const register = (value: unknown, field = "", objectPath: string[] = []) => {
    if (Array.isArray(value)) {
      for (const item of value) register(item, field, [...objectPath, "[*]"]);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (field === "quote" && value && !context.annotationQuoteTokens.has(value)) {
        const token = redactionAtom(key, "annotation-quote", value, "Q");
        const existing = [...context.annotationQuoteTokens.entries()].find(([, mapped]) => mapped === token);
        if (existing && existing[0] !== value) fail("Snapshot quote redaction token collision");
        context.annotationQuoteTokens.set(value, token);
      }
      if (/^\/attachments\//u.test(value) || ATTACHMENT_PATH_FIELDS.has(field)) redactPath(value);
      else if (field === "sourceKey" || (field === "resourceId" && value.startsWith("["))) redactSourceKey(value);
      else if (field === "resourceKey") redactResourceKey(value);
      else if (field === "targetKey") {
        if (objectPath.at(-2) === "sourceRef") redactSourceTargetKey(value);
        else redactPayloadTargetKey(value);
      }
      else if (IDENTIFIER_KEYS.has(field) || /(?:^|[A-Z])(?:Id|ID)$/u.test(field)) redactId(value);
      return;
    }
    for (const [name, child] of Object.entries(value)) register(child, name, [...objectPath, name]);
  };

  // 在统一路径/对象键注册前登记真实capture路径，保留派生物后缀及有效性。
  for (const row of mapping.objects) {
    if (!isCaptureMappingRow(row)) continue;
    const audio = (row.payload as JsonRecord)?.audio;
    if (!audio || typeof audio !== "object" || Array.isArray(audio)) continue;
    for (const field of ["attachmentPath", "asrAttachmentPath"]) {
      const value = (audio as JsonRecord)[field];
      if (typeof value !== "string" || !value) continue;
      const trimmed = value.trim();
      const valid = field === "attachmentPath"
        ? /^\/attachments\/[\w.-]+\.(?:m4a|mp4|webm|ogg|wav)$/iu.test(trimmed)
        : /^\/attachments\/[\w.-]+\.asr\.wav$/iu.test(trimmed);
      if (valid && trimmed.length <= 300) {
        if (field === "attachmentPath" && context.paths.has(value)) continue;
        const prefix = trimmed.slice(0, "/attachments/".length);
        const extension = path.extname(trimmed);
        const derivative = field === "asrAttachmentPath" ? trimmed.slice(-8, -4) : "";
        const stem = path.basename(trimmed).slice(0, -extension.length - derivative.length);
        const leading = value.slice(0, value.length - value.trimStart().length);
        const trailing = value.slice(value.trimEnd().length);
        context.paths.set(value, `${leading}${prefix}${identityToken(key, "path", stem)}${derivative}${extension}${trailing}`);
      } else if (!/^\/attachments\/[\w.-]+$/u.test(value)) {
        // 原来不是mapper附件引用的坏路径仍保持非法，不因脱敏变成有效文件名。
        context.paths.set(value, identityToken(key, "invalid-capture-audio-path", value));
      }
    }
  }

  // 历史引文与其来源正文共享短代号，来源ID短化时也复用同一个实体映射。
  for (const row of mapping.objects) {
    if (row.kind !== "historicalUserSupplement" || !row.payload || typeof row.payload !== "object") continue;
    const supplement = row.payload as JsonRecord;
    for (const record of Array.isArray(supplement.records) ? supplement.records as JsonRecord[] : []) {
      const sourceId = record.source && (record.source as JsonRecord).sourceId;
      if (typeof sourceId === "string" && !context.ids.has(sourceId)) {
        const alias = compactToken(key, "supplement-source-id", sourceId, "i", "", context.ids, 8);
        context.ids.set(sourceId, alias);
      }
      const exactQuote = record.exactQuote;
      if (typeof exactQuote === "string" && exactQuote && !context.annotationQuoteTokens.has(exactQuote)) {
        compactToken(key, "supplement-quote", exactQuote, "Q", "Z", context.annotationQuoteTokens, 16);
      }
      const statement = record.statement;
      if (typeof statement === "string" && statement && !context.supplementStatementTokens.has(statement)) {
        compactToken(key, "supplement-statement", statement, "V", "Z", context.supplementStatementTokens, 8);
      }
    }
  }

  for (const row of mapping.objects) {
    const parts = typeof row.objectKey === "string" ? parseArrayKey(row.objectKey) : null;
    if (parts?.length === 1 && parts[0] === row.field && row.id === row.field) context.singletonIds.add(String(row.id));
    else if (row.kind === "evidencePermission" && typeof row.id === "string") redactSourceKey(row.id);
    else if (row.kind === "attachmentCleanup" && typeof row.id === "string") redactPath(row.id);
    else if (typeof row.id === "string") redactId(row.id);
    register(row.payload);
  }
  for (const row of mapping.relations) {
    if (typeof row.targetId === "string") {
      if (row.targetCollection === "attachmentCleanup") redactPath(row.targetId);
      else redactId(row.targetId);
    }
  }
  for (const row of mapping.lifecycles) {
    if (typeof row.resourceId === "string") redactId(row.resourceId);
    register(row.payload);
  }
  for (const row of mapping.fields) register(row.payload);
  for (const row of mapping.idempotency) register(row.payload);
  for (const item of inventory) register(item);

  for (const row of mapping.objects) {
    if (typeof row.objectKey !== "string") fail("Snapshot contains an invalid object key");
    const parts = parseArrayKey(row.objectKey);
    if (!parts) fail("Snapshot contains a non-structural object key");
    const transformed = JSON.stringify(parts.map((part, index) => index % 2 === 1
      ? context.paths.has(part) ? redactPath(part) : redactId(part)
      : part));
    context.objectKeys.set(row.objectKey, transformed);
  }
  for (const row of mapping.lifecycles) {
    if (typeof row.resourceKey === "string") redactResourceKey(row.resourceKey);
  }
  return context;
}

function sanitizeMapping<T>(
  value: T,
  key: Buffer,
  context: RedactionContext,
  stringMap = new Map<string, string>(),
  preserveTechnicalDigests = false
): T {
  const referenceField = (field: string) => IDENTIFIER_KEYS.has(field) || /(?:^|[A-Z])(?:Id|ID)$/u.test(field);
  const withQuoteRelations = (text: string, token: string): string => {
    const normalizedText = context.markdownText(text);
    const includedQuoteTokens = [...context.annotationQuoteTokens.entries()]
      .filter(([quote]) => normalizedText.includes(quote))
      .map(([, quoteToken]) => quoteToken);
    return `${token}${includedQuoteTokens.join("")}`;
  };
  const transform = (text: string, field: string, objectPath: string[], onboardingPayload: boolean): string => {
    if (preserveTechnicalDigests && field === "sha256") {
      return redactTechnicalDigest(key, text);
    }
    if (!text) return text;
    // 引文使用独立占位符，避免普通文本缓存或身份映射改变引用字段语义。
    if ((field === "quote" || field === "exactQuote") && context.annotationQuoteTokens.has(text)) {
      return context.annotationQuoteTokens.get(text)!;
    }
    if (field === "sourceKey") return context.sourceKeys.get(text) || fail("Snapshot source key has no redaction mapping");
    if (context.sourceKeys.has(text)) {
      const token = context.sourceKeys.get(text)!;
      return referenceField(field) ? token : withQuoteRelations(text, token);
    }
    if (field === "objectKey") {
      if (context.objectKeys.has(text)) return context.objectKeys.get(text)!;
      const mapKey = `objectKey\0${text}`;
      if (!stringMap.has(mapKey)) stringMap.set(mapKey, identityToken(key, "value", text));
      return stringMap.get(mapKey)!;
    }
    if (field === "parentKey" || field === "ownerKey") {
      if (!text) return text;
      return context.objectKeys.get(text) || fail("Snapshot ownership key has no redaction mapping");
    }
    if (field === "targetKey") {
      if (!text) return text;
      if (objectPath[0] === "relations" && objectPath[1] === "[*]") {
        return context.objectKeys.get(text) || fail("Snapshot relation target key has no redaction mapping");
      }
      return context.targetKeys.get(text) || fail("Snapshot semantic target key has no redaction mapping");
    }
    if (field === "resourceKey") return context.resourceKeys.get(text) || fail("Snapshot resource key has no redaction mapping");
    if (field === "valuePath" || field === "childFields") return text;
    if (field === "resourceId" && text.startsWith("[")) return context.sourceKeys.get(text) || fail("Snapshot composite resource ID has no redaction mapping");
    if (context.paths.has(text) || ATTACHMENT_PATH_FIELDS.has(field) || /^\/attachments\//u.test(text)) {
      const token = context.paths.get(text) || fail("Snapshot attachment path has no redaction mapping");
      return ATTACHMENT_PATH_FIELDS.has(field) || referenceField(field) ? token : withQuoteRelations(text, token);
    }
    if (!onboardingPayload && ENUM_STRING_KEYS.has(field)) return text;
    if (TIMEZONE_KEYS.has(field)) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: text });
        return text;
      } catch {}
    }
    if (isValidTemporalValue(field, text)) return text;
    if (context.ids.has(text)) {
      const token = context.ids.get(text)!;
      return referenceField(field) ? token : withQuoteRelations(text, token);
    }
    if (referenceField(field)) return registerIdentifier(context, key, text);
    if (STRUCTURAL_TIME_KEYS.has(field)) {
      if (isValidTemporalValue(field, text)) return text;
    }
    if (/^(?:version|.*Version|attempt|position|bytes|count|statusCode|schemaVersion)$/u.test(field)) return text;
    const mapKey = `value\0${text}`;
    if (!stringMap.has(mapKey)) {
      // 用不透明占位符保留真实 markdownText(source).includes(quote) 关系；不存原文，也不注入 inspector 资格结果。
      stringMap.set(mapKey, withQuoteRelations(text, redactionAtom(key, "value", text, "V")));
    }
    return stringMap.get(mapKey)!;
  };
  const visit = (item: unknown, field: string, objectPath: string[], onboardingPayload = false): unknown => {
    if (typeof item === "string") return transform(item, field, objectPath, onboardingPayload);
    if (Array.isArray(item)) return item.map(value => visit(value, field, [...objectPath, "[*]"], onboardingPayload));
    if (item && typeof item === "object") {
      const row = item as JsonRecord;
      const singletonObject = objectPath.length === 2 && objectPath[0] === "objects" && objectPath[1] === "[*]"
        && row.id === row.field && row.collection === row.field
        && typeof row.id === "string" && context.singletonIds.has(row.id)
        && row.objectKey === JSON.stringify([row.id]);
      const singletonRelation = objectPath.length === 2 && objectPath[0] === "relations" && objectPath[1] === "[*]"
        && row.resolution === "live" && typeof row.targetId === "string"
        && context.singletonIds.has(row.targetId) && row.targetCollection === row.targetId
        && row.targetKey === JSON.stringify([row.targetId])
        && context.objectKeys.has(String(row.targetKey));
      // 仅保留已登记单例对象及其真实解析关系的结构身份，同名普通实体仍脱敏。
      return Object.fromEntries(Object.entries(row).map(([name, child]) => [name,
        (name === "id" && singletonObject) || (name === "targetId" && singletonRelation)
          ? child : visit(child, name, [...objectPath, name], onboardingPayload
            || (singletonObject && row.kind === "onboardingV2" && row.id === "onboardingV2" && name === "payload"))
      ]));
    }
    return item;
  };
  return visit(value, "", []) as T;
}

/** 按真实v2单例及精确消费者路径保留固定技术值，不豁免任意同名扩展。 */
function onboardingTechnicalRules(api: OnboardingV2Api): Map<string, Set<string>> {
  const rules = new Map<string, Set<string>>();
  const add = (path: string, values: string[]) => rules.set(path, new Set(values));
  add("session.id", ["onboarding-v2"]);
  add("session.status", api.onboardingV2Schema.statuses);
  add("session.step", api.onboardingV2Schema.steps);
  add("readiness", ["empty", "partial", "usable"]);
  add("migration.selectedFlow", ["undecided", "legacy", "v2"]);
  add("migration.entryPolicy", ["choose", "already_onboarded", "v2"]);
  add("migration.legacy.status", ["pending", "completed", "dismissed"]);
  add("migration.legacy.modelSummaryType", ["", "model_summary"]);
  add("migration.legacy.resourceType", ["onboarding"]);
  add("migration.legacy.resourceId", ["onboarding"]);
  for (const question of api.onboardingV2Schema.questions) {
    const prefix = question.questionId === "collaboration" ? "session.collaboration" : `session.answers.${question.questionId}`;
    if (question.questionId !== "collaboration") add(`${prefix}.questionId`, [question.questionId]);
    if (question.answerDispositions) add(`${prefix}.answerDisposition`, question.answerDispositions.map(item => item.value));
    if (question.horizons) add(`${prefix}.structuredValue.[*].horizon`, question.horizons);
    for (const [axis, definition] of Object.entries(question.axes || {})) {
      add(`${prefix}.${axis}.value`, definition.values);
      add(`${prefix}.${axis}.source`, ["user", "system_default"]);
    }
  }
  return rules;
}

function isOnboardingSingleton(row: JsonRecord): boolean {
  return row.kind === "onboardingV2" && row.id === "onboardingV2" && row.collection === "onboardingV2"
    && row.field === "onboardingV2" && row.parentKey === null && row.objectKey === JSON.stringify(["onboardingV2"]);
}

function visitOnboardingValues(value: unknown, callback: (path: string, concrete: string[], value: unknown) => void,
  concrete: string[] = [], pattern: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitOnboardingValues(item, callback, [...concrete, String(index)], [...pattern, "[*]"]));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) visitOnboardingValues(item, callback, [...concrete, key], [...pattern, key]);
  } else callback(pattern.join("."), concrete, value);
}

function preserveOnboardingTechnicalMetadata(source: StoreMapping, target: StoreMapping, api: OnboardingV2Api, key: Buffer): void {
  const rules = onboardingTechnicalRules(api);
  source.objects.forEach((row, index) => {
    if (!isOnboardingSingleton(row)) return;
    const next = target.objects[index];
    if (!next || !isOnboardingSingleton(next)) fail("Onboarding singleton mapping identity changed");
    visitOnboardingValues(row.payload, (pattern, concrete, value) => {
      if (typeof value !== "string") return;
      const technical = rules.get(pattern)?.has(value);
      const sourceText = /^(?:session\.answers\.(?:currentContext|dailyRhythm)\.rawText|session\.answers\.(?:desiredChanges|recentObstacles)\.structuredValue\.\[\*\]\.(?:text|horizonText)|session\.collaboration\.additionalBoundary)$/u.test(pattern);
      if (!technical && !sourceText) return;
      let parent = next.payload as JsonRecord;
      for (const part of concrete.slice(0, -1)) {
        if (!parent || typeof parent[part] !== "object" || parent[part] === null) fail("Onboarding technical path changed during redaction");
        parent = parent[part] as JsonRecord;
      }
      if (technical) parent[concrete.at(-1)!] = value;
      else {
        // 只替换真实五问正文，保持UTF-16长度以保留有效span；同名扩展不进入该路径。
        const digest = createHmac("sha256", key).update(`onboarding-text\0${value}`).digest("hex");
        let alias = digest.repeat(Math.ceil(value.length / digest.length)).slice(0, value.length);
        if (alias && alias === value) alias = (alias[0] === "a" ? "b" : "a") + alias.slice(1);
        parent[concrete.at(-1)!] = alias;
      }
    });
  });
}

/** 恢复五问固定身份；复合权限身份只更新真实行及其结构引用。 */
function preserveOnboardingReferences(source: StoreMapping, target: StoreMapping, api: OnboardingV2Api): void {
  const questions = new Set(api.onboardingV2Schema.questions.map(item => item.questionId));
  const ownership = new Map<string, string>();
  source.objects.forEach((row, index) => {
    const original = row.payload as JsonRecord, nextRow = target.objects[index], next = nextRow.payload as JsonRecord;
    if (row.kind === "aiTask" && original.kind === "onboardingClaimExtraction"
      && original.resourceType === "onboardingV2" && original.targetId === "onboarding-v2") {
      // 真实抽取消费者只使用顶层targetId；payload.targetId属于其他任务协议，不予豁免。
      next.targetId = "onboarding-v2";
    }
    if (row.kind === "userClaim" && Array.isArray(original.evidence) && Array.isArray(next.evidence)) {
      original.evidence.forEach((item, evidenceIndex) => {
        const evidence = item as JsonRecord;
        if (evidence?.sourceType === "onboardingV2Answer" && questions.has(String(evidence.sourceId))) {
          (next.evidence as JsonRecord[])[evidenceIndex].sourceId = evidence.sourceId;
        }
      });
    }
    if (row.kind !== "evidencePermission" || typeof original.sourceKey !== "string") return;
    let parts: string[] | null = null;
    try {
      const parsed: unknown = JSON.parse(original.sourceKey);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) parts = parsed;
    } catch {}
    if (!parts || parts.length !== 4 || parts[0] !== "onboardingV2" || !questions.has(parts[1])
      || parts[2] !== "" || parts[3] !== `answer:${parts[1]}`) return;
    const oldKey = String(nextRow.objectKey);
    next.sourceKey = original.sourceKey;
    nextRow.id = original.sourceKey;
    nextRow.objectKey = JSON.stringify(["evidencePermissions", original.sourceKey]);
    ownership.set(oldKey, String(nextRow.objectKey));
    source.lifecycles.forEach((lifecycle, lifecycleIndex) => {
      if (lifecycle.resourceType !== "evidencePermission" || lifecycle.resourceId !== original.sourceKey) return;
      const nextLifecycle = target.lifecycles[lifecycleIndex];
      nextLifecycle.resourceId = original.sourceKey;
      if (lifecycle.resourceKey === `evidencePermission:${original.sourceKey}`) nextLifecycle.resourceKey = lifecycle.resourceKey;
    });
  });
  for (const row of [...target.objects, ...target.relations, ...target.attachmentRefs]) {
    for (const field of ["parentKey", "ownerKey", "targetKey"]) {
      const replacement = ownership.get(String(row[field]));
      if (replacement) row[field] = replacement;
    }
  }
}

/** 比较源、重建及真实normalizer的技术投影；不得将回退默认值写回后制造通过。 */
function assertOnboardingTechnicalSemantics(source: JsonRecord, target: JsonRecord, api: OnboardingV2Api,
  canonicalJson: (value: unknown) => string): void {
  const rules = onboardingTechnicalRules(api);
  const projection = (value: unknown): JsonRecord => {
    const result: JsonRecord = {};
    visitOnboardingValues(value, (pattern, concrete, item) => {
      const values = rules.get(pattern);
      if (!values) return;
      const label = concrete.join(".");
      if (typeof item !== "string" || !values.has(item)) fail(`Unsupported onboarding technical value at ${label}`);
      result[label] = item;
    });
    return result;
  };
  const before = projection(source.onboardingV2), after = projection(target.onboardingV2);
  if (canonicalJson(before) !== canonicalJson(after)) fail("Snapshot onboardingV2 technical values changed during redaction/rebuild");
  const normalizedBefore = projection(api.normalizeOnboardingV2(source.onboardingV2, source.onboarding));
  const normalizedAfter = projection(api.normalizeOnboardingV2(target.onboardingV2, target.onboarding));
  for (const [field, value] of Object.entries(before)) {
    if (normalizedBefore[field] !== value || normalizedAfter[field] !== value) {
      fail(`Snapshot onboardingV2 consumer changed technical value at ${field}`);
    }
  }
  if (canonicalJson(normalizedBefore) !== canonicalJson(normalizedAfter)) fail("Snapshot onboardingV2 normalized technical semantics changed");
}

type OnboardingModelApi = {
  prepareUserModelExtraction(store: JsonRecord): { value?: JsonRecord };
  userModelCoreReadiness(store: JsonRecord): JsonRecord;
  userModelEvidenceCurrent(store: JsonRecord, evidence: JsonRecord): boolean;
};

async function loadOnboardingModelApi(root: string): Promise<OnboardingModelApi> {
  const catalog = await importFromRoot<{ loadPromptCatalog(options: { rootDir: string }): Promise<JsonRecord> }>(
    root, "src/infrastructure/prompt-catalog/index.mjs");
  const prompts = await importFromRoot<{ installPromptCatalog(value: JsonRecord): unknown }>(root, "src/shared/prompts/index.mjs");
  prompts.installPromptCatalog(await catalog.loadPromptCatalog({ rootDir: root }));
  return importFromRoot<OnboardingModelApi>(root, "src/app/index.mjs");
}

/** 只重算源消费者已确认匹配/有效的正文派生引用，不激活陈旧关系。 */
function preserveOnboardingDerivedReferences(source: JsonRecord, target: JsonRecord, mapping: StoreMapping,
  api: OnboardingV2Api, model: OnboardingModelApi): void {
  const originalWork = model.prepareUserModelExtraction(source).value;
  const redactedWork = model.prepareUserModelExtraction(target).value;
  const tasks = Array.isArray(source.aiTasks) ? source.aiTasks as JsonRecord[] : [];
  const nextTasks = Array.isArray(target.aiTasks) ? target.aiTasks as JsonRecord[] : [];
  tasks.forEach((task, index) => {
    if (task.kind !== "onboardingClaimExtraction" || task.resourceType !== "onboardingV2"
      || task.targetId !== "onboarding-v2" || !originalWork?.inputHash) return;
    const next = nextTasks[index];
    if (!next) fail("Snapshot onboarding task disappeared");
    for (const field of ["inputHash", "requestedInputHash", "requestedIntentInputHash"]) {
      if (task[field] !== originalWork.inputHash) continue;
      if (!redactedWork?.inputHash) fail("Snapshot onboarding matched source lost prepared input");
      next[field] = redactedWork.inputHash;
    }
    const row = mapping.objects.find(item => item.kind === "aiTask" && item.id === next.id);
    if (!row) fail("Snapshot onboarding task mapping disappeared");
    row.payload = structuredClone(next);
  });
  const entries = api.onboardingV2ContextEntries(target.onboardingV2);
  const sourceEntries = api.onboardingV2ContextEntries(source.onboardingV2);
  const claims = Array.isArray(source.userClaims) ? source.userClaims as JsonRecord[] : [];
  const nextClaims = Array.isArray(target.userClaims) ? target.userClaims as JsonRecord[] : [];
  claims.forEach((claim, claimIndex) => {
    const originalEvidence = Array.isArray(claim.evidence) ? claim.evidence as JsonRecord[] : [];
    originalEvidence.forEach((evidence, evidenceIndex) => {
      if (evidence?.sourceType !== "onboardingV2Answer" || !model.userModelEvidenceCurrent(source, evidence)) return;
      const nextClaim = nextClaims[claimIndex];
      const next = (nextClaim?.evidence as JsonRecord[] | undefined)?.[evidenceIndex];
      const entry = entries.find(item => item.id === evidence.sourceId);
      const originalEntry = sourceEntries.find(item => item.id === evidence.sourceId);
      if (!next || !entry || !originalEntry || String(entry.text).length !== String(originalEntry.text).length) {
        fail("Snapshot current onboarding evidence lost source UTF-16 length");
      }
      next.contentSha256 = createHash("sha256").update(String(entry.text)).digest("hex");
      const row = mapping.objects.find(item => item.kind === "userClaim" && item.id === nextClaim.id);
      if (!row) fail("Snapshot onboarding claim mapping disappeared");
      row.payload = structuredClone(nextClaim);
    });
  });
}

/** 正文派生哈希/区间不会靠默认值掩盖：真实消费者结论发生变化就阻止快照。 */
function assertOnboardingModelConsumers(source: JsonRecord, target: JsonRecord, api: OnboardingV2Api,
  model: OnboardingModelApi, canonicalJson: (value: unknown) => string): void {
  const sourceEntries = api.onboardingV2ContextEntries(source.onboardingV2);
  const targetEntries = api.onboardingV2ContextEntries(target.onboardingV2);
  const identities = (entries: JsonRecord[]) => entries.map(({ id, version, text }) => ({ id, version, utf16Length: String(text).length }));
  if (canonicalJson(identities(sourceEntries)) !== canonicalJson(identities(targetEntries))) {
    fail("Snapshot onboarding context-entry identities changed");
  }
  const originalWork = model.prepareUserModelExtraction(source).value;
  const redactedWork = model.prepareUserModelExtraction(target).value;
  const sourceIds = (work: JsonRecord | undefined) => Array.isArray(work?.sources)
    ? (work.sources as JsonRecord[]).map(item => ({ id: item.id, version: item.version })) : null;
  if (canonicalJson(sourceIds(originalWork)) !== canonicalJson(sourceIds(redactedWork))) {
    fail("Snapshot onboarding permitted source identities changed");
  }
  const tasks = Array.isArray(source.aiTasks) ? source.aiTasks as JsonRecord[] : [];
  const nextTasks = Array.isArray(target.aiTasks) ? target.aiTasks as JsonRecord[] : [];
  tasks.forEach((task, index) => {
    if (task.kind !== "onboardingClaimExtraction" || task.resourceType !== "onboardingV2" || task.targetId !== "onboarding-v2") return;
    const next = nextTasks[index];
    if (!next || next.targetId !== task.targetId) fail("Snapshot onboarding fixed task target changed");
    for (const field of ["inputHash", "requestedInputHash", "requestedIntentInputHash"]) {
      if (!Object.hasOwn(task, field)) continue;
      const before = Boolean(originalWork?.inputHash && task[field] === originalWork.inputHash);
      const after = Boolean(redactedWork?.inputHash && next[field] === redactedWork.inputHash);
      if (before !== after) fail(`Snapshot onboarding task source match changed at ${field}`);
    }
  });
  const readiness = (store: JsonRecord) => {
    const { taskId: _taskId, ...result } = model.userModelCoreReadiness(store);
    return result;
  };
  if (canonicalJson(readiness(source)) !== canonicalJson(readiness(target))) {
    fail("Snapshot onboarding core readiness changed; inspect source-derived task hashes and permissions");
  }
  const claims = Array.isArray(source.userClaims) ? source.userClaims as JsonRecord[] : [];
  const targetClaims = Array.isArray(target.userClaims) ? target.userClaims as JsonRecord[] : [];
  claims.forEach((claim, claimIndex) => {
    const evidence = Array.isArray(claim.evidence) ? claim.evidence as JsonRecord[] : [];
    evidence.forEach((item, evidenceIndex) => {
      if (item?.sourceType !== "onboardingV2Answer") return;
      const next = (targetClaims[claimIndex]?.evidence as JsonRecord[] | undefined)?.[evidenceIndex];
      if (!next || item.sourceId !== next.sourceId
        || model.userModelEvidenceCurrent(source, item) !== model.userModelEvidenceCurrent(target, next)) {
        fail(`Snapshot onboarding evidence consumer changed at userClaims.${claimIndex}.evidence.${evidenceIndex}; inspect source content hashes and spans`);
      }
    });
  });
}

function redactTechnicalDigest(key: Buffer, value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("Source technical digest violates its lower-case SHA-256 contract");
  }
  return createHmac("sha256", key).update(`technical-digest\0${value}`).digest("hex");
}

/**
 * 通用文本脱敏之后，仅恢复已知持久化对象的技术形态，不放开同名用户扩展字段。
 * 摘要使用统一的带密钥映射保留相等关系；历史资料的估算 token 随脱敏文本重算，非计费回填。
 */
function preserveTechnicalMetadata(
  sourceMapping: StoreMapping,
  sanitizedMapping: StoreMapping,
  redactionContext: RedactionContext,
  key: Buffer,
  estimateSupplementTokens: SupplementEstimator
): void {
  const preserveDigest = (source: JsonRecord, target: JsonRecord, field: string) => {
    target[field] = redactTechnicalDigest(key, source[field]);
  };
  const preserveWindow = (source: JsonRecord, target: JsonRecord) => {
    if (typeof source.start !== "string" || !Number.isFinite(Date.parse(source.start))
      || typeof source.endExclusive !== "string" || !Number.isFinite(Date.parse(source.endExclusive))
      || Date.parse(source.start) >= Date.parse(source.endExclusive)) {
      fail("Source record-compression window violates its persisted envelope contract");
    }
    target.start = source.start;
    target.endExclusive = source.endExclusive;
    if (["complete", "partial"].includes(String(source.completeness))) target.completeness = source.completeness;
  };

  for (let index = 0; index < sourceMapping.objects.length; index += 1) {
    const sourceRow = sourceMapping.objects[index];
    const targetRow = sanitizedMapping.objects[index];
    if (sourceRow.kind !== targetRow.kind || !sourceRow.payload || !targetRow.payload) {
      fail("Snapshot object structure changed before technical metadata redaction");
    }
    const source = sourceRow.payload as JsonRecord;
    const target = targetRow.payload as JsonRecord;
    if (isCaptureMappingRow(sourceRow) && source.audio && typeof source.audio === "object" && !Array.isArray(source.audio)) {
      const sourceAudio = source.audio as JsonRecord;
      if (!target.audio || typeof target.audio !== "object" || Array.isArray(target.audio)) fail("Snapshot capture audio structure changed");
      const targetAudio = target.audio as JsonRecord;
      for (const [field, values] of [
        ["mimeType", ["audio/mp4", "audio/webm", "audio/ogg", "audio/wav"]],
        ["asrMimeType", ["audio/wav"]]
      ] as const) {
        const value = sourceAudio[field];
        if (typeof value === "string" && (values as readonly string[]).includes(value.trim().toLowerCase())) targetAudio[field] = value;
      }
      // 真实公开消费者接受数字字符串；保留原值，不纠正坏范围或改变计量单位。
      for (const field of ["bytes", "durationMs", "asrBytes"]) {
        const value = sourceAudio[field];
        if (typeof value === "string" && Number.isFinite(Number(value))) targetAudio[field] = value;
      }
    } else if (sourceRow.kind === "userClaim" && Array.isArray(source.evidence) && Array.isArray(target.evidence)) {
      // 此判别决定真实 mapper 的单例证据关系，不是任意同名扩展字段。
      source.evidence.forEach((item, evidenceIndex) => {
        if (item && typeof item === "object"
          && (item as JsonRecord).sourceType === "onboardingV2Answer") {
          const targetEvidence = (target.evidence as JsonRecord[])[evidenceIndex];
          if (!targetEvidence) fail("Snapshot user-claim evidence shape changed during redaction");
          targetEvidence.sourceType = "onboardingV2Answer";
        }
      });
    } else if (sourceRow.kind === "perceptionEvent") {
      preserveDigest(source, target, "contentSha256");
    } else if (sourceRow.kind === "evidenceSource") {
      preserveDigest(source, target, "contentSha256");
      if (Array.isArray(source.derivedFrom) && Array.isArray(target.derivedFrom)) {
        const sourceDependencies = source.derivedFrom as unknown[];
        const targetDependencies = target.derivedFrom as unknown[];
        sourceDependencies.forEach((dependency, dependencyIndex) => {
          const sourceDependency = dependency as JsonRecord;
          const targetDependency = targetDependencies[dependencyIndex] as JsonRecord;
          preserveDigest(sourceDependency, targetDependency, "contentSha256");
        });
      }
    } else if (sourceRow.kind === "recordCompression") {
      preserveDigest(source, target, "sourceManifestHash");
      if (source.window && target.window) preserveWindow(source.window as JsonRecord, target.window as JsonRecord);
      for (const field of ["sourceManifest", "sourceRefs"] as const) {
        if (!Array.isArray(source[field]) || !Array.isArray(target[field])) continue;
        const sourceEntries = source[field] as unknown[];
        const targetEntries = target[field] as unknown[];
        sourceEntries.forEach((item, itemIndex) => {
          preserveDigest(item as JsonRecord, targetEntries[itemIndex] as JsonRecord, "sourceHash");
        });
      }
    } else if (sourceRow.kind === "historicalUserSupplement") {
      const sourceTokenUsage = source.tokenUsage as JsonRecord | undefined;
      const targetTokenUsage = target.tokenUsage as JsonRecord | undefined;
      if (sourceTokenUsage?.scope === "model_output" && targetTokenUsage) targetTokenUsage.scope = "model_output";
      if (Array.isArray(target.records) && targetTokenUsage) {
        for (let recordIndex = 0; recordIndex < target.records.length; recordIndex += 1) {
          const sourceRecord = (source.records as JsonRecord[] | undefined)?.[recordIndex];
          const targetRecord = target.records[recordIndex] as JsonRecord;
          if (sourceRecord?.source && targetRecord.source) {
            preserveDigest(sourceRecord.source as JsonRecord, targetRecord.source as JsonRecord, "sourceHash");
          }
          for (const field of ["statement", "exactQuote"] as const) {
            const text = sourceRecord?.[field];
            if (typeof text === "string") {
              const aliases = field === "exactQuote"
                ? redactionContext.annotationQuoteTokens
                : redactionContext.supplementStatementTokens;
              targetRecord[field] = aliases.get(text) || fail("Historical supplement text has no redaction alias");
            }
          }
        }
        targetTokenUsage.tokens = estimateSupplementTokens(target.records);
      }
    }
  }

  // 只在 speechCache 的字段载荷内保留真实消费者识别的来源类型和身份引用。
  const sourceSpeechCache = sourceMapping.fields.find(row => row.field === "speechCache");
  const targetSpeechCache = sanitizedMapping.fields.find(row => row.field === "speechCache");
  if (!sourceSpeechCache && !targetSpeechCache) return;
  const sourceEntries = sourceSpeechCache?.payload;
  const targetEntries = targetSpeechCache?.payload;
  if (!sourceSpeechCache || !targetSpeechCache || !Array.isArray(sourceEntries) || !Array.isArray(targetEntries)) {
    fail("Snapshot speechCache field shape changed during redaction; diagnostics=[{\"path\":\"speechCache\",\"sourceType\":\"array\",\"normalizedType\":\"missing-or-invalid\"}]");
  }
  if (sourceEntries.length !== targetEntries.length) {
    fail(`Snapshot speechCache redaction changed array length; diagnostics=${JSON.stringify([
      { path: "speechCache", sourceLength: sourceEntries.length, normalizedLength: targetEntries.length }
    ])}`);
  }
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const sourceEntry = sourceEntries[index];
    const targetEntry = targetEntries[index];
    if (!sourceEntry || typeof sourceEntry !== "object" || Array.isArray(sourceEntry)
      || !targetEntry || typeof targetEntry !== "object" || Array.isArray(targetEntry)) {
      fail(`Snapshot speechCache entry shape changed during redaction; diagnostics=${JSON.stringify([
        { path: "speechCache[*]", sourceType: "object", normalizedType: "missing-or-invalid" }
      ])}`);
    }
    const source = sourceEntry as JsonRecord;
    const target = targetEntry as JsonRecord;
    if (typeof source.sourceType === "string" && SPEECH_CACHE_SOURCE_TYPES.has(source.sourceType)) {
      target.sourceType = source.sourceType;
    }
    for (const field of ["id", "cacheKey"] as const) {
      const value = source[field];
      if (typeof value === "string" && value) target[field] = registerIdentifier(redactionContext, key, value);
    }
  }
}

function preservePersistenceMetadata(
  sourceMapping: StoreMapping,
  sanitizedMapping: StoreMapping,
  redactionContext: RedactionContext,
  key: Buffer
): void {
  const sourceField = sourceMapping.fields.find(row => row.field === "_persistence");
  const targetField = sanitizedMapping.fields.find(row => row.field === "_persistence");
  if (!sourceField && !targetField) {
    if (sourceMapping.lifecycles.length || sourceMapping.idempotency.length
      || sanitizedMapping.lifecycles.length || sanitizedMapping.idempotency.length) {
      fail("Snapshot persistence records exist without their metadata field");
    }
    return;
  }
  if (!sourceField || !targetField || !sourceField.payload || !targetField.payload
    || typeof sourceField.payload !== "object" || typeof targetField.payload !== "object") {
    fail("Snapshot persistence metadata field shape changed during redaction");
  }
  const sourceMetadata = sourceField.payload as JsonRecord;
  const targetMetadata = targetField.payload as JsonRecord;
  const syncPresent = Object.hasOwn(sourceMetadata, "sync");
  const sourceSync = syncPresent ? sourceMetadata.sync as JsonRecord : { cursor: 0, changes: [] };
  if (!sourceSync || typeof sourceSync !== "object" || Array.isArray(sourceSync)
    || !Array.isArray(sourceSync.changes)
    || (Object.hasOwn(sourceSync, "operations") && !Array.isArray(sourceSync.operations))) {
    fail("Snapshot persistence sync structure changed during redaction");
  }
  if (Object.hasOwn(sourceMetadata, "version")) targetMetadata.version = sourceMetadata.version;
  const targetSync = targetMetadata.sync && typeof targetMetadata.sync === "object" && !Array.isArray(targetMetadata.sync)
    ? targetMetadata.sync as JsonRecord
    : {};
  targetMetadata.sync = targetSync;
  targetSync.cursor = sourceSync.cursor;
  const mapId = (value: unknown, allowEmpty = false): string => {
    if (typeof value !== "string" || (!allowEmpty && !value)) {
      fail("Snapshot persistence identity violates its string contract");
    }
    if (!value) return "";
    return redactionContext.ids.get(value) || registerIdentifier(redactionContext, key, value);
  };
  const sourceChanges = sourceSync.changes as JsonRecord[];
  const sourceOperations = (sourceSync.operations || []) as JsonRecord[];
  const targetChanges = Array.isArray(targetSync.changes) ? targetSync.changes as JsonRecord[] : [];
  const targetOperations = Array.isArray(targetSync.operations) ? targetSync.operations as JsonRecord[] : [];
  if (sourceChanges.length !== targetChanges.length || sourceOperations.length !== targetOperations.length) {
    fail("Snapshot persistence sync records changed count during redaction");
  }
  targetSync.changes = targetChanges;
  targetSync.operations = targetOperations;
  const changeTypes = new Set(["create", "update", "delete", "reorder"]);
  for (let index = 0; index < sourceChanges.length; index += 1) {
    const source = sourceChanges[index] as JsonRecord;
    const target = targetChanges[index] as JsonRecord;
    if (!source || typeof source !== "object" || !target || typeof target !== "object"
      || typeof source.changeType !== "string" || !changeTypes.has(source.changeType)
      || typeof source.resourceId !== "string" || typeof source.operationId !== "string"
      || typeof source.domain !== "string" || !source.domain) {
      fail("Snapshot persistence sync change violates its persisted contract");
    }
    target.cursor = source.cursor;
    target.domain = SYNC_PUBLIC_DOMAINS.has(source.domain)
      ? source.domain
      : identityToken(key, "sync-domain", source.domain);
    target.resourceId = mapId(source.resourceId, true);
    target.version = source.version;
    target.changeType = source.changeType;
    target.operationId = mapId(source.operationId, true);
    if (typeof source.traceId === "string") target.traceId = mapId(source.traceId, true);
    target.committedAt = source.committedAt;
  }
  const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  for (let index = 0; index < sourceOperations.length; index += 1) {
    const source = sourceOperations[index] as JsonRecord;
    const target = targetOperations[index] as JsonRecord;
    if (!source || typeof source !== "object" || !target || typeof target !== "object"
      || typeof source.operationId !== "string" || !source.operationId
      || typeof source.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(source.fingerprint)
      || typeof source.method !== "string" || !source.method
      || typeof source.resource !== "string" || !source.resource) {
      fail("Snapshot persistence sync operation violates its persisted fingerprint contract");
    }
    target.operationId = mapId(source.operationId);
    // HMAC 保留 64 位摘要形态与快照内一致性，不泄露由原请求正文导出的摘要。
    target.fingerprint = redactTechnicalDigest(key, source.fingerprint);
    target.method = HTTP_METHODS.has(source.method.toUpperCase())
      ? source.method.toUpperCase()
      : identityToken(key, "sync-method", source.method);
    target.resource = identityToken(key, "sync-resource", source.resource);
    target.committedAt = source.committedAt;
    target.firstCursor = source.firstCursor;
    target.lastCursor = source.lastCursor;
  }

  if (sourceMapping.lifecycles.length !== sanitizedMapping.lifecycles.length
    || sourceMapping.idempotency.length !== sanitizedMapping.idempotency.length) {
    fail("Snapshot persistence metadata record counts changed during redaction");
  }
  for (let index = 0; index < sourceMapping.lifecycles.length; index += 1) {
    const source = sourceMapping.lifecycles[index];
    const target = sanitizedMapping.lifecycles[index];
    if (!source.payload || !target.payload) fail("Snapshot lifecycle payload is missing during redaction");
    const sourcePayload = source.payload as JsonRecord;
    const targetPayload = target.payload as JsonRecord;
    const mappedResourceKey = redactionContext.resourceKeys.get(String(sourcePayload.resourceKey || ""));
    const mappedResourceId = mapId(sourcePayload.resourceId);
    if (!mappedResourceKey || !mappedResourceId) fail("Snapshot lifecycle identity has no consistent redaction mapping");
    for (const record of [target, targetPayload]) {
      record.resourceKey = mappedResourceKey;
      record.resourceType = PERSISTENCE_RESOURCE_TYPES.has(String(sourcePayload.resourceType || ""))
        ? sourcePayload.resourceType
        : identityToken(key, "resource-type", String(sourcePayload.resourceType || ""));
      record.resourceId = mappedResourceId;
      record.lifecycle = sourcePayload.lifecycle;
      record.state = sourcePayload.state;
      record.tombstone = sourcePayload.tombstone;
      for (const field of ["createdAt", "updatedAt", "deletedAt", "restoredAt", "purgedAt"] as const) {
        if (Object.hasOwn(sourcePayload, field)) record[field] = sourcePayload[field];
      }
      if (typeof sourcePayload.trashId === "string") record.trashId = mapId(sourcePayload.trashId, true);
    }
  }
  for (let index = 0; index < sourceMapping.idempotency.length; index += 1) {
    const source = sourceMapping.idempotency[index];
    const target = sanitizedMapping.idempotency[index];
    if (!source.payload || !target.payload) fail("Snapshot idempotency payload is missing during redaction");
    const payload = target.payload as JsonRecord;
    // 元数据载荷与关系列分别脱敏；这里恢复 map/rebuild 明确要求一致的字段。
    target.scope = payload.scope;
    target.key = payload.key;
    target.requestHash = payload.requestHash;
    target.response = structuredClone(payload.response);
    target.createdAt = payload.createdAt;
    target.expiresAt = payload.expiresAt;
  }
}

function diagnosticContainerType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function safeDiagnosticPath(segments: string[]): string {
  return segments.map(segment => segment === "[*]" ? segment
    : SAFE_DIAGNOSTIC_PATH_FIELDS.has(segment) ? segment : "<field>").join(".") || "$";
}

function normalizationFailureDiagnostics(source: unknown, normalized: unknown): JsonRecord[] {
  const diagnostics: JsonRecord[] = [];
  const visit = (before: unknown, after: unknown, segments: string[]) => {
    if (diagnostics.length >= 24) return;
    const beforeType = diagnosticContainerType(before);
    const afterType = diagnosticContainerType(after);
    const beforeContainer = beforeType === "array" || beforeType === "object";
    const afterContainer = afterType === "array" || afterType === "object";
    if (beforeType !== afterType && (beforeContainer || afterContainer)) {
      diagnostics.push({
        path: safeDiagnosticPath(segments), sourceType: beforeType, normalizedType: afterType,
        ...(Array.isArray(before) ? { sourceLength: before.length } : {}),
        ...(Array.isArray(after) ? { normalizedLength: after.length } : {})
      });
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length > after.length) {
        diagnostics.push({ path: safeDiagnosticPath(segments), sourceLength: before.length, normalizedLength: after.length });
      }
      for (let index = 0; index < Math.min(before.length, after.length); index += 1) visit(before[index], after[index], [...segments, "[*]"]);
      return;
    }
    if (before && after && typeof before === "object" && typeof after === "object") {
      const beforeRecord = before as Record<string, unknown>;
      const afterRecord = after as Record<string, unknown>;
      for (const key of Object.keys(beforeRecord)) {
        if (!Object.hasOwn(afterRecord, key)) {
          const value = beforeRecord[key];
          const type = diagnosticContainerType(value);
          if (type === "array" || type === "object") {
            diagnostics.push({
              path: safeDiagnosticPath([...segments, key]),
              sourceType: type,
              normalizedType: "missing",
              ...(Array.isArray(value) ? { sourceLength: value.length, normalizedLength: 0 } : {})
            });
          }
        } else {
          visit(beforeRecord[key], afterRecord[key], [...segments, key]);
        }
        if (diagnostics.length >= 24) return;
      }
    }
  };
  visit(source, normalized, []);
  return diagnostics;
}

function assertSpeechCacheState(source: JsonRecord, normalized: JsonRecord, canonicalJson: (value: unknown) => string): void {
  const sourceEntries = Array.isArray(source.speechCache) ? source.speechCache : [];
  const normalizedEntries = normalized.speechCache;
  if (!Array.isArray(normalizedEntries)) {
    fail(`Snapshot normalization changed speechCache state; diagnostics=${JSON.stringify([
      { path: "speechCache", sourceLength: sourceEntries.length, normalizedType: diagnosticContainerType(normalizedEntries) }
    ])}`);
  }
  const normalizedByIdentity = new Map(normalizedEntries.map(entry => {
    const value = entry as JsonRecord;
    const id = String(value.id || value.cacheKey || "");
    const attachmentPath = value.attachmentPath || "";
    return [canonicalJson([id, attachmentPath]), value] as const;
  }));
  for (const item of sourceEntries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`Snapshot normalized a malformed speechCache entry; diagnostics=${JSON.stringify([
        { path: "speechCache[*]", sourceType: diagnosticContainerType(item), normalizedType: "invalid-source-entry" }
      ])}`);
    }
    const before = item as JsonRecord;
    const expectedId = String(before.id || before.cacheKey || "");
    const expectedCacheKey = String(before.cacheKey || expectedId);
    const identity = canonicalJson([expectedId, before.attachmentPath || ""]);
    const after = normalizedByIdentity.get(identity);
    if (!after) {
      fail(`Snapshot normalization changed speechCache identity; diagnostics=${JSON.stringify([
        { path: "speechCache[*].identity", sourceLength: sourceEntries.length, normalizedLength: normalizedEntries.length }
      ])}`);
    }
    const sourceVersions = before.sourceVersions || {};
    const references: Array<[string, unknown, unknown]> = [
      ["sourceType", before.sourceType, after?.sourceType],
      ["sourceId", before.sourceId, after?.sourceId],
      ["id", expectedId, after?.id],
      ["cacheKey", expectedCacheKey, after?.cacheKey],
      ["sourceVersions", sourceVersions, after?.sourceVersions || {}],
      ["attachmentPath", before.attachmentPath || "", after?.attachmentPath || ""]
    ];
    if (Object.hasOwn(before, "sourceVersion") && before.sourceVersion !== undefined && before.sourceVersion !== null) {
      references.push(["sourceVersion", before.sourceVersion, after?.sourceVersion]);
    }
    for (const [field, expected, actual] of references) {
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        fail(`Snapshot normalization changed speechCache reference or state; diagnostics=${JSON.stringify([
          { path: `speechCache[*].${field}`, sourceType: diagnosticContainerType(expected), normalizedType: diagnosticContainerType(actual) }
        ])}`);
      }
    }
  }
}

/** 对比原/重建/normalize后的实际音频消费者，不写回合法化后的默认值。 */
function assertCaptureAudioSemantics(source: JsonRecord, target: JsonRecord, context: RedactionContext,
  captures: CaptureAudioApi, normalizeStore: (value: JsonRecord) => JsonRecord,
  normalizePersistedDocument: (source: JsonRecord, normalize: (value: JsonRecord) => JsonRecord) => JsonRecord,
  canonicalJson: (value: unknown) => string): void {
  const projection = (store: JsonRecord, remap: boolean) => {
    const items = Array.isArray(store.captures) ? store.captures as JsonRecord[] : [];
    return items.map(item => {
      const result = captures.captureAudioPayload(item.audio);
      const id = remap ? context.ids.get(String(item.id)) : item.id;
      if (result.code) return { id, code: result.code };
      if (result.value == null) return { id, value: null };
      const value = structuredClone(result.value);
      if (remap) {
        for (const field of ["attachmentPath", "asrAttachmentPath"]) {
          if (!Object.hasOwn(value, field)) continue;
          const originalPath = String((item.audio as JsonRecord)[field]);
          const alias = context.paths.get(originalPath);
          if (!alias) fail("Snapshot capture audio reference lacks a redaction alias");
          value[field] = alias.trim();
        }
      }
      return { id, value };
    });
  };
  const before = canonicalJson(projection(source, true));
  const after = canonicalJson(projection(target, false));
  if (before !== after) fail("Snapshot capture audio consumer changed format, units, derivative, reference or invalidity");
  const normalizedSource = normalizePersistedDocument(structuredClone(source), normalizeStore);
  const normalizedTarget = normalizePersistedDocument(structuredClone(target), normalizeStore);
  if (before !== canonicalJson(projection(normalizedSource, true))
    || after !== canonicalJson(projection(normalizedTarget, false))) {
    fail("Snapshot capture audio normalization changed its real consumer contract");
  }
}

function assertPersistedStoreConsumerContract(
  store: JsonRecord,
  normalizeStore: (value: JsonRecord) => JsonRecord,
  normalizePersistedDocument: (source: JsonRecord, normalize: (value: JsonRecord) => JsonRecord) => JsonRecord,
  preparePersistenceDocument: PersistenceMetadataApi["preparePersistenceDocument"],
  mapStoreObjects: PersistenceApi["mapStoreObjects"],
  rebuildStoreObjects: PersistenceApi["rebuildStoreObjects"],
  accountId: string,
  canonicalJson: (value: unknown) => string,
  now: string
): void {
  let normalized: JsonRecord;
  try {
    normalized = normalizePersistedDocument(store, normalizeStore);
  } catch {
    let diagnosticStore: JsonRecord | null = null;
    try {
      diagnosticStore = normalizeStore(structuredClone(store));
    } catch {}
    const diagnostics = diagnosticStore
      ? normalizationFailureDiagnostics(store, diagnosticStore)
      : [{ path: "$", sourceType: "object", normalizedType: "consumer-rejected" }];
    fail(`Snapshot real persisted-store consumer rejected the sanitized store; diagnostics=${JSON.stringify(diagnostics)}`);
  }
  // 允许真实 normalizer 补默认值或归一化标量；这里只核对本次依赖的缓存契约。
  assertSpeechCacheState(store, normalized, canonicalJson);
  const normalizedBefore = canonicalJson(normalized);
  let prepared: JsonRecord;
  try {
    prepared = preparePersistenceDocument(structuredClone(normalized), () => now);
  } catch {
    fail("Snapshot real PostgreSQL persistence consumer rejected metadata after normalization; diagnostics=[{\"path\":\"_persistence\",\"sourceType\":\"object\",\"normalizedType\":\"consumer-rejected\"}]");
  }
  if (canonicalJson(normalized) !== normalizedBefore) {
    fail("Snapshot persistence consumer mutated the normalized source instead of its validation clone");
  }
  const sourceMetadata = normalized._persistence as JsonRecord | undefined
    || { lifecycles: [], idempotency: [], sync: { cursor: 0, changes: [], operations: [] } };
  const preparedMetadata = prepared._persistence as JsonRecord | undefined;
  if (!preparedMetadata) {
    if (Array.isArray(normalized.trash)) fail("Prepared persistence document lost its metadata envelope");
    return;
  }
  const sourceSync = (sourceMetadata.sync as JsonRecord | undefined)
    || { changes: [], operations: [] };
  const preparedSync = preparedMetadata.sync as JsonRecord;
  const sourceChanges = sourceSync.changes || [];
  const sourceOperations = sourceSync.operations || [];
  const sourceIdempotency = sourceMetadata.idempotency || [];
  if (canonicalJson(sourceChanges) !== canonicalJson(preparedSync.changes)
    || canonicalJson(sourceOperations) !== canonicalJson(preparedSync.operations)
    || canonicalJson(sourceIdempotency) !== canonicalJson(preparedMetadata.idempotency)) {
    fail("Persistence preparation discarded existing sync or idempotency records");
  }
  const preparedLifecycleKeys = new Set((preparedMetadata.lifecycles as JsonRecord[]).map(item => item.resourceKey));
  if ((sourceMetadata.lifecycles as JsonRecord[]).some(item => !preparedLifecycleKeys.has(item.resourceKey))) {
    fail("Persistence preparation discarded an existing lifecycle identity");
  }
  const remapped = rebuildStoreObjects(mapStoreObjects(accountId, prepared));
  if (canonicalJson(prepared) !== canonicalJson(remapped)) {
    fail("Prepared persistence document changed across the actual store mapping round trip");
  }
}

function registerIdentifier(context: RedactionContext, key: Buffer, value: string): string {
  if (!context.ids.has(value)) context.ids.set(value, identityToken(key, "id", value));
  return context.ids.get(value)!;
}

function isValidTemporalValue(field: string, value: string): boolean {
  if (!STRUCTURAL_TIME_KEYS.has(field) && !/(?:At|AsOf|On|Date|Start|End)$/u.test(field)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function taskStates(store: JsonRecord, inspector: RuntimeInspector, idKey: Buffer, alreadyRedacted = false) {
  const tasks = Array.isArray(store.aiTasks) ? store.aiTasks as JsonRecord[] : [];
  return tasks.map(task => {
    const inspection = inspector.inspectRecoveryIntent(store, task);
    return {
      id: alreadyRedacted ? String(task.id || "") : identityToken(idKey, "id", String(task.id || "")),
      kind: String(task.kind || ""),
      status: String(task.status || ""),
      targetOptional: inspection.target?.targetOptional ?? null,
      requiresExistingTarget: inspection.target?.requiresExistingTarget ?? null,
      requiresExistingSubtarget: inspection.target?.requiresExistingSubtarget ?? null,
      targetExists: inspection.target?.exists ?? null,
      subtargetExists: inspection.target?.subtargetExists ?? null,
      intentMatch: inspection.intentMatch,
      intentInputVersion: inspection.intent?.inputVersion ?? null,
      intentSubtargetVersion: inspection.intent?.subtargetVersion ?? null,
      alreadyAnswered: inspection.intent?.alreadyAnswered ?? false
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

const SAFE_TASK_KINDS = new Set([
  "annotationShenji", "thoughtAnswer", "followUpAnswer", "thoughtDraft", "thoughtPrompt",
  "journalAssist", "journalReflection", "chat", "analysis", "recordCompression",
  "perceptionExtraction", "captureTranscription", "contentImageUnderstanding", "onboardingClaimExtraction"
]);
const SAFE_TASK_STATUSES = new Set([
  "queued", "running", "succeeded", "failed", "stale", "cancelled", "cancelling",
  "waiting_for_user_model", "waiting_for_budget"
]);
const SAFE_INTENT_MATCHES = new Set([
  "matched", "uninspectable", "input-version-mismatch", "subtarget-version-mismatch", "input-hash-mismatch"
]);
const TASK_SEMANTIC_FIELDS = [
  "kind", "status", "targetOptional", "requiresExistingTarget", "requiresExistingSubtarget",
  "targetExists", "subtargetExists", "intentMatch", "intentInputVersion", "intentSubtargetVersion", "alreadyAnswered"
] as const;

function safeTaskEnum(field: "kind" | "status" | "intentMatch", value: unknown): string {
  const allowed = field === "kind" ? SAFE_TASK_KINDS : field === "status" ? SAFE_TASK_STATUSES : SAFE_INTENT_MATCHES;
  return typeof value === "string" && allowed.has(value) ? value : "other";
}

function safeTaskValue(field: typeof TASK_SEMANTIC_FIELDS[number], value: unknown): unknown {
  if (field === "kind" || field === "status" || field === "intentMatch") return safeTaskEnum(field, value);
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  return typeof value === "number" && Number.isFinite(value) ? value : "other";
}

function assertSameTaskSemantics(before: JsonRecord[], after: JsonRecord[]) {
  const afterById = new Map(after.map(item => [String(item.id || ""), item]));
  const beforeIds = new Set(before.map(item => String(item.id || "")));
  const differences: JsonRecord[] = [];
  for (const source of before) {
    const taskId = String(source.id || "");
    const redacted = afterById.get(taskId);
    if (!redacted) {
      differences.push({ taskKind: safeTaskEnum("kind", source.kind), sourceStatus: safeTaskEnum("status", source.status), missing: "redacted" });
      continue;
    }
    const changedFields = TASK_SEMANTIC_FIELDS.flatMap(field => Object.is(source[field], redacted[field]) ? [] : [{
      field,
      before: safeTaskValue(field, source[field]),
      after: safeTaskValue(field, redacted[field])
    }]);
    if (changedFields.length) differences.push({
      taskKind: safeTaskEnum("kind", source.kind),
      sourceStatus: safeTaskEnum("status", source.status),
      redactedStatus: safeTaskEnum("status", redacted.status),
      changedFields
    });
  }
  for (const redacted of after) {
    if (!beforeIds.has(String(redacted.id || ""))) {
      differences.push({ taskKind: safeTaskEnum("kind", redacted.kind), redactedStatus: safeTaskEnum("status", redacted.status), missing: "source" });
    }
  }
  if (differences.length || before.length !== after.length) {
    fail(`Redaction changed task state, target classification, or effective intent match; safeDiff=${JSON.stringify({ sourceCount: before.length, redactedCount: after.length, differences })}`);
  }
}

function preserveMatchingRequestedIntentHashes(
  sourceStore: JsonRecord,
  sourceStates: JsonRecord[],
  redactedStore: JsonRecord,
  redactedMapping: StoreMapping,
  inspector: RuntimeInspector,
  identityKey: Buffer
) {
  for (const sourceTask of (sourceStore.aiTasks as JsonRecord[] || [])) {
    const taskId = identityToken(identityKey, "id", String(sourceTask.id || ""));
    const originalState = sourceStates.find(item => item.id === taskId);
    if (!originalState) fail("Snapshot task classifier lost a source task");
    const redactedTask = (redactedStore.aiTasks as JsonRecord[] || []).find(item => item.id === taskId);
    if (!redactedTask) fail("Redacted snapshot removed an AI task");
    const currentInspection = inspector.inspectRecoveryIntent(redactedStore, redactedTask);
    if (originalState.intentMatch !== "matched"
      || !Object.hasOwn(redactedTask, "requestedIntentInputHash")) continue;
    if (!currentInspection.intent?.inputHash) fail("A matching source task lost its redacted candidate intent inspector");
    redactedTask.requestedIntentInputHash = currentInspection.intent.inputHash;
    const row = redactedMapping.objects.find(item => item.collection === "aiTasks" && item.id === taskId);
    if (!row || !row.payload || typeof row.payload !== "object") fail("Redacted task mapping row is missing");
    row.payload = structuredClone(redactedTask);
  }
}

function graphShape(mapping: StoreMapping): JsonRecord {
  const countBy = (items: JsonRecord[], keys: string[]) => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = keys.map(name => String(item[name] ?? "")).join("\0");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  };
  return {
    objects: countBy(mapping.objects, ["collection", "kind", "field", "status"]),
    relations: countBy(mapping.relations, ["relation", "targetCollection", "resolution"]),
    attachmentRefs: countBy(mapping.attachmentRefs, ["fieldName"]),
    lifecycles: countBy(mapping.lifecycles, ["resourceType", "lifecycle", "state", "tombstone"]),
    idempotency: countBy(mapping.idempotency, ["scope"])
  };
}

function assertMappingRoundTrip(expected: StoreMapping, rebuilt: StoreMapping, canonicalJson: (value: unknown) => string) {
  // PostgreSQL SELECT 没有 ORDER BY，比较完整行的排序多重集；重复计数及 position 等字段仍参与等价判断。
  for (const key of ["fields", "objects", "relations", "attachmentRefs", "lifecycles", "idempotency"] as const) {
    const expectedRows = expected[key].map(canonicalJson).sort();
    const rebuiltRows = rebuilt[key].map(canonicalJson).sort();
    if (canonicalJson(expectedRows) !== canonicalJson(rebuiltRows)) {
      if (key === "relations") {
        const relationShape = (rows: JsonRecord[]) => rows.map(row => ({
          relation: row.relation,
          targetCollection: row.targetCollection,
          resolution: row.resolution,
          hasTarget: Boolean(row.targetKey),
          hasObject: Boolean(row.objectKey)
        }));
        fail(`Redacted relations do not rebuild equivalently; snapshot is blocked (${canonicalJson(relationShape(expected.relations))} != ${canonicalJson(relationShape(rebuilt.relations))})`);
      }
      fail(`Redacted ${key} do not rebuild equivalently; snapshot is blocked`);
    }
  }
}

function assertInventoryTechnicalState(before: JsonRecord[], after: JsonRecord[], canonicalJson: (value: unknown) => string) {
  const shape = (items: JsonRecord[]) => items.map(item => ({
    storage: item.storage,
    bytes: item.bytes,
    state: item.state
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(shape(before)) !== canonicalJson(shape(after))) {
    fail("Snapshot redaction changed attachment inventory state, storage mode, or byte counts");
  }
}

async function pgClient(connectionString: string): Promise<PgClient> {
  const moduleName = "pg";
  const pgModule = await import(moduleName) as unknown as PgModule;
  const client = new pgModule.Client({ connectionString });
  await client.connect();
  return client;
}

async function readSourceAccountIdsFromClient(client: PgClient): Promise<string[]> {
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const rows = (await client.query("SELECT id FROM for_now_auth.users ORDER BY id")).rows;
    await client.query("COMMIT");
    const ids = rows.map(row => typeof row.id === "string" ? row.id : "");
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
      fail("Production auth snapshot contains invalid or duplicate account IDs");
    }
    return ids;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function readSourceAccountIds(connectionString: string): Promise<string[]> {
  return await readSourceAccountIdsFromClient(await pgClient(connectionString));
}

async function createSanitizedAccount(
  root: string,
  accountId: string,
  sourceMapping: StoreMapping,
  sourceInventory: JsonRecord[],
  sourceRevision: number,
  redactionKey: Buffer,
  stringMap: Map<string, string>,
  clock: InspectionClock
) {
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const app = await importFromRoot<{ normalizeStore(value: JsonRecord): JsonRecord }>(root, "src/app/index.mjs");
  const persistedNormalization = await importFromRoot<{
    normalizePersistedDocument(source: JsonRecord, normalize: (value: JsonRecord) => JsonRecord): JsonRecord;
  }>(root, "src/shared/persistence/normalization.mjs");
  const persistenceMetadata = await importFromRoot<PersistenceMetadataApi>(root, "src/shared/persistence/persistence-metadata.mjs");
  const sourceStore = persistence.rebuildStoreObjects(sourceMapping);
  const captures = await importFromRoot<CaptureAudioApi>(root, "src/modules/captures/index.mjs");
  assertPersistedStoreConsumerContract(
    sourceStore,
    app.normalizeStore,
    persistedNormalization.normalizePersistedDocument,
    persistenceMetadata.preparePersistenceDocument,
    persistence.mapStoreObjects,
    persistence.rebuildStoreObjects,
    accountId,
    persistence.canonicalJson,
    clock.capturedAt
  );
  const onboardingModel = await loadOnboardingModelApi(root);
  const sourceInspector = (await createClosedInspector(root, accountId, {}, clock)).backgroundAi;
  const beforeStates = taskStates(sourceStore, sourceInspector, redactionKey);
  const content = await importFromRoot<{ markdownText(value: string): string }>(root, "src/shared/content/index.mjs");
  const supplement = await importFromRoot<{ estimateHistoricalUserSupplementOutputTokens: SupplementEstimator }>(
    root,
    "src/modules/record-compressions/index.mjs"
  );
  const redactionContext = createRedactionContext(sourceMapping, redactionKey, content.markdownText, sourceInventory);
  const redactedMapping = sanitizeMapping(sourceMapping, redactionKey, redactionContext, stringMap);
  const onboardingApi = await importFromRoot<OnboardingV2Api>(root, "src/modules/onboarding/index.mjs");
  preserveOnboardingTechnicalMetadata(sourceMapping, redactedMapping, onboardingApi, redactionKey);
  const redactedAccountId = identityToken(redactionKey, "id", accountId);
  preserveTechnicalMetadata(
    sourceMapping,
    redactedMapping,
    redactionContext,
    redactionKey,
    supplement.estimateHistoricalUserSupplementOutputTokens
  );
  preservePersistenceMetadata(sourceMapping, redactedMapping, redactionContext, redactionKey);
  preserveOnboardingReferences(sourceMapping, redactedMapping, onboardingApi);
  const redactedInventory = sanitizeMapping(sourceInventory, redactionKey, redactionContext, stringMap, true);
  const sanitizedStore = persistence.rebuildStoreObjects(redactedMapping);
  assertCaptureAudioSemantics(sourceStore, sanitizedStore, redactionContext, captures,
    app.normalizeStore, persistedNormalization.normalizePersistedDocument, persistence.canonicalJson);
  assertOnboardingTechnicalSemantics(sourceStore, sanitizedStore, onboardingApi, persistence.canonicalJson);
  preserveOnboardingDerivedReferences(sourceStore, sanitizedStore, redactedMapping, onboardingApi, onboardingModel);
  const sanitizedInspector = (await createClosedInspector(root, redactedAccountId, {}, clock)).backgroundAi;

  // 仅在真实映射关系已等价重建后，按原始匹配结论更新脱敏正文派生的候选 hash。
  const initialRedactedMapping = persistence.mapStoreObjects(redactedAccountId, sanitizedStore);
  assertMappingRoundTrip(redactedMapping, initialRedactedMapping, persistence.canonicalJson);
  preserveMatchingRequestedIntentHashes(sourceStore, beforeStates, sanitizedStore, redactedMapping, sanitizedInspector, redactionKey);

  const finalStore = persistence.rebuildStoreObjects(redactedMapping);
  assertCaptureAudioSemantics(sourceStore, finalStore, redactionContext, captures,
    app.normalizeStore, persistedNormalization.normalizePersistedDocument, persistence.canonicalJson);
  assertOnboardingTechnicalSemantics(sourceStore, finalStore, onboardingApi, persistence.canonicalJson);
  assertOnboardingModelConsumers(sourceStore, finalStore, onboardingApi, onboardingModel, persistence.canonicalJson);
  // 用真实持久化消费者验证脱敏后的完整重建值；验证结果只读，不写回待导出的数据。
  assertPersistedStoreConsumerContract(
    finalStore,
    app.normalizeStore,
    persistedNormalization.normalizePersistedDocument,
    persistenceMetadata.preparePersistenceDocument,
    persistence.mapStoreObjects,
    persistence.rebuildStoreObjects,
    redactedAccountId,
    persistence.canonicalJson,
    clock.capturedAt
  );
  const afterStates = taskStates(finalStore, sanitizedInspector, redactionKey, true);
  assertSameTaskSemantics(beforeStates, afterStates);
  const rebuiltMapping = persistence.mapStoreObjects(redactedAccountId, finalStore);
  assertMappingRoundTrip(redactedMapping, rebuiltMapping, persistence.canonicalJson);
  assertInventoryTechnicalState(sourceInventory, redactedInventory, persistence.canonicalJson);
  return {
    accountId: redactedAccountId,
    sourceRevision,
    mapping: redactedMapping,
    attachmentInventory: redactedInventory,
    stateFingerprint: createHash("sha256").update(persistence.canonicalJson(afterStates)).digest("hex"),
    taskStates: afterStates,
    graph: graphShape(rebuiltMapping)
  };
}

// 账户文档不能套用正文字符串脱敏：模型、场景、状态与账本数值均为真实消费者契约。
const DOCUMENT_TECHNICAL_STRINGS = new Set([
  "provider", "service", "action", "model", "modelReturned", "effort", "tier", "scene", "status",
  "pricingPeriod", "responseFormat", "finishReason", "modality", "unitType", "designVersion"
]);
const DOCUMENT_PRIVATE_STRINGS = new Set(["assistantName", "defaultVoice", "errorCode", "costSource"]);
const DOCUMENT_IDS = new Set(["id", "callId", "callGroupId", "traceId", "providerRequestId", "accountId", "userId", "taskId", "operationId"]);
const USAGE_NUMERIC_FIELDS = new Set(["version", "durationMs", "httpStatus", "attempt", "maxAttempts", "maxTokens", "imageCount", "imageBytes", "width", "height", "historyMessageCount", "requestChars", "responseChars", "reasoningChars", "units", "costCny"]);
const USAGE_NUMERIC_GROUPS = new Set(["tokens", "costsUsd", "costsCny", "ratesUsdPerMillion", "ratesCnyPerMillion", "rawUsage"]);

function validateDocumentPresence(documents: AccountDocuments) {
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) fail("Snapshot account documents are missing");
  for (const name of ["settings", "usage"] as const) {
    const value = documents[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Snapshot required ${name} document is missing or invalid`);
  }
  if (!Object.hasOwn(documents, "costPlan") || documents.costPlan !== null && (typeof documents.costPlan !== "object" || Array.isArray(documents.costPlan))) fail("Snapshot optional costPlan presence is not explicit");
}

function redactAccountDocument(value: unknown, name: string, key: Buffer, parts: string[] = []): unknown {
  const field = parts.at(-1) || "";
  const location = [name, ...parts].join(".");
  if (name === "usage" && (USAGE_NUMERIC_FIELDS.has(field) || parts.slice(0, -1).some(part => USAGE_NUMERIC_GROUPS.has(part)) && (value === null || typeof value !== "object")) && typeof value !== "number") fail(`Invalid account ledger numeric type at ${location}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || name !== "settings" && value < 0) fail(`Invalid account document numeric value at ${location}`);
    return value;
  }
  if (typeof value === "string") {
    if (!value) return value;
    if (field === "apiKey" && name === "settings" && parts.length === 1) return "startup-gate-inert-key";
    if (DOCUMENT_IDS.has(field)) return identityToken(key, "id", value);
    if (field === "errorCategory") return ["cancelled", "timeout", "empty_response", "length_limit", "content_filter", "incomplete_stream", "invalid_stream", "provider_http", "network", "unknown"].includes(value) ? value : "private_value";
    if (field === "retryReason") return value === "empty_response_without_thinking" ? value : "private_value";
    if (DOCUMENT_PRIVATE_STRINGS.has(field)) return `private_${field === "assistantName" ? "name" : "value"}`;
    if (STRUCTURAL_TIME_KEYS.has(field) || field === "trackingStartedAt") {
      if (!Number.isFinite(Date.parse(value))) fail(`Invalid account document time at ${location}`);
      return value;
    }
    const technicalLocation = name === "settings" || parts.length === 3 &&
      (name === "usage" && parts[0] === "entries" || name === "costPlan" && parts[0] === "scenarios");
    const imageType = name === "usage" && parts.length === 4 && parts[0] === "entries" && parts[2] === "imageTypes";
    if (technicalLocation && DOCUMENT_TECHNICAL_STRINGS.has(field) || imageType
      || name === "settings" && ["scenarios", "sceneEfforts", "responseStyles"].includes(parts[0])) {
      if (!/^[A-Za-z0-9_.:/+ -]{1,160}$/u.test(value) || /(?:https?:|bearer|password|secret|api[_-]?key)/iu.test(value)) fail(`Unsafe technical account document string at ${location}`);
      return value;
    }
    fail(`Unclassified account document string at ${location}`);
  }
  if (Array.isArray(value)) return value.map((item, index) => redactAccountDocument(item, name, key, [...parts, String(index)]));
  if (!value || typeof value !== "object") fail(`Invalid account document value at ${location}`);
  const result: JsonRecord = {};
  for (const [child, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(child)) fail(`Unsafe account document property at ${location}`);
    if (!/^[A-Za-z0-9_-]+$/u.test(child)) fail(`Unclassified account document property at ${location}`);
    if (/(?:password|secret|credential|authorization|access.?token|refresh.?token|endpoint|headers?|base.?url|api.?key)/iu.test(child)
      && !(name === "settings" && !parts.length && child === "apiKey")) fail(`Unclassified credential/config field at ${location}.${child}`);
    result[child] = redactAccountDocument(item, name, key, [...parts, child]);
  }
  return result;
}

function assertDocumentNumbers(before: unknown, after: unknown, location: string) {
  if (typeof before === "number") {
    if (!Number.isFinite(before) || before < 0 || before !== after) fail(`Account document normalization changes numeric value at ${location}`);
  } else if (before && typeof before === "object") {
    for (const [field, value] of Object.entries(before)) {
      // 版本迁移是既有消费者职责，不将合法旧版本号误判为账本损坏。
      if (field !== "version") assertDocumentNumbers(value, (after as JsonRecord | undefined)?.[field], `${location}.${field}`);
    }
  }
}

// 模板只来自真实normalizeLlmSettings默认结构；缺省字段保留旧迁移，未知扩展不得作为技术键原样泄露。
function assertSettingsStructure(source: JsonRecord, template: JsonRecord, location = "settings") {
  for (const [field, value] of Object.entries(source)) {
    if (!Object.hasOwn(template, field)) fail(`Unknown settings field at ${location}.${field}`);
    const expected = template[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid settings structure at ${location}.${field}`);
      assertSettingsStructure(value as JsonRecord, expected as JsonRecord, `${location}.${field}`);
    } else if (typeof value !== typeof expected || Array.isArray(value)) fail(`Invalid settings value type at ${location}.${field}`);
  }
}

async function sanitizeAccountDocuments(root: string, accountId: string, source: AccountDocuments, key: Buffer, clock: InspectionClock): Promise<AccountDocuments> {
  validateDocumentPresence(source);
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const normalization = await importFromRoot<{ normalizePersistedDocument(value: JsonRecord, normalizer: (value: JsonRecord) => JsonRecord): JsonRecord }>(root, "src/shared/persistence/normalization.mjs");
  const ai = await importFromRoot<{
    normalizeLlmSettings(value: JsonRecord): JsonRecord;
    normalizeAiUsage(value: JsonRecord): JsonRecord;
    normalizeAiCostPlan(value: JsonRecord, settings: JsonRecord, usage: JsonRecord, options: JsonRecord): JsonRecord;
  }>(root, "src/modules/ai/index.mjs");
  const settingsTemplate = { ...ai.normalizeLlmSettings({}), model: "", effort: "" };
  assertSettingsStructure(source.settings, settingsTemplate);
  const output: AccountDocuments = { settings: {}, usage: {}, costPlan: null };
  const normalize = (name: string, value: JsonRecord) => normalization.normalizePersistedDocument(value,
    item => name === "settings" ? ai.normalizeLlmSettings(item) : name === "usage" ? ai.normalizeAiUsage(item)
      : ai.normalizeAiCostPlan(item, source.settings, source.usage, { date: localDateAt(clock), cnyPerUsd: item.cnyPerUsd }));
  for (const name of ["settings", "usage", "costPlan"] as const) {
    const original = source[name];
    if (original === null) continue;
    if (Object.hasOwn(original, "version") && (!Number.isSafeInteger(original.version) || Number(original.version) < 1)) fail(`Invalid ${name} document version`);
    const mapping = persistence.mapAccountDocument(accountId, name, original);
    if (persistence.canonicalJson(persistence.rebuildAccountDocument(mapping)) !== persistence.canonicalJson(original)) fail(`Source ${name} document is not lossless`);
    const normalized = normalize(name, original);
    // 账本/预算数量不得被归零或截断；设置参数则沿正式normalizer保留合法旧版迁移与速率范围。
    if (name !== "settings") assertDocumentNumbers(original, normalized, name);
    const redacted = redactAccountDocument(original, name, key) as JsonRecord;
    const redactedNormalized = normalize(name, redacted);
    const expected = redactAccountDocument(normalized, name, key);
    if (persistence.canonicalJson(expected) !== persistence.canonicalJson(redactedNormalized)) fail(`Account ${name} normalized semantics changed during redaction`);
    const safeMapping = persistence.mapAccountDocument(identityToken(key, "id", accountId), name, redacted);
    if (persistence.canonicalJson(persistence.rebuildAccountDocument(safeMapping)) !== persistence.canonicalJson(redacted)) fail(`Sanitized ${name} document is not lossless`);
    output[name] = redacted;
  }
  return output;
}

type SourceAccountSlice = {
  accountId: string;
  mapping: StoreMapping;
  inventory: JsonRecord[];
  documents: AccountDocuments;
  revision: number;
};

/** 源事务只做一致性读取；关闭连接后才允许在进程内脱敏、重建及运行消费者。 */
async function readSourceAccountSlices(client: PgClient, accountIds: string[],
  readMapping: PersistenceApi["readPostgresStoreObjects"],
  readDocument: PersistenceApi["readAccountDocument"]): Promise<{
    serverVersion: string; transactionSnapshot: string; slices: SourceAccountSlice[];
  }> {
  const slices: SourceAccountSlice[] = [];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const database = (await client.query("SELECT current_database() AS name, current_setting('server_version') AS version, txid_current_snapshot()::text AS snapshot")).rows[0];
    for (const accountId of accountIds) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const account = (await client.query("SELECT revision FROM for_now.accounts WHERE account_id = $1", [accountId])).rows[0];
      if (!account) fail("Auth account has no business account row; snapshot is inconsistent");
      const mapping = await readMapping(client, accountId);
      const settings = await readDocument(client, accountId, "settings", null);
      const usage = await readDocument(client, accountId, "usage", null);
      const costPlan = await readDocument(client, accountId, "costPlan", null);
      if (!settings || !usage) fail("Source required account document is missing (settings/usage)");
      const inventory = (await client.query(`
        SELECT path, storage, object_key AS "objectKey", bytes::float8 AS bytes, sha256, state
        FROM for_now.attachment_inventory WHERE account_id = $1 ORDER BY path
      `, [accountId])).rows;
      slices.push({ accountId, mapping, inventory, documents: { settings, usage, costPlan }, revision: Number(account.revision) });
    }
    await client.query("COMMIT");
    return { serverVersion: String(database.version || ""), transactionSnapshot: String(database.snapshot || ""), slices };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function snapshot(root: string, outputFile: string) {
  const timeBaseline = createInspectionClock();
  const sourceDataUrl = process.env.STARTUP_GATE_SOURCE_DATABASE_URL || "";
  const sourceAuthUrl = process.env.STARTUP_GATE_SOURCE_AUTH_DATABASE_URL || "";
  const candidateSha = process.env.STARTUP_GATE_CANDIDATE_SHA || "";
  const candidateTree = process.env.STARTUP_GATE_CANDIDATE_TREE || "";
  if (!sourceDataUrl || !sourceAuthUrl) fail("Snapshot requires explicit read-only source data and auth URLs");
  if (!/^[a-f0-9]{40,64}$/iu.test(candidateSha) || !/^[a-f0-9]{40,64}$/iu.test(candidateTree)) {
    fail("Snapshot requires the fixed candidate full SHA and tree");
  }
  const firstAccountIds = await readSourceAccountIds(sourceAuthUrl);
  if (!firstAccountIds.length) fail("Source auth snapshot has no users to validate");
  const sourcePersistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const client = await pgClient(sourceDataUrl);
  const { serverVersion, transactionSnapshot, slices } = await readSourceAccountSlices(
    client, firstAccountIds, sourcePersistence.readPostgresStoreObjects, sourcePersistence.readAccountDocument
  );
  // 原切片只留进程内存。昂贵的本机检查不占生产只读事务或源连接。
  const redactionKey = randomBytes(32);
  const accounts: JsonRecord[] = [];
  for (const source of slices) {
    const account = await createSanitizedAccount(
      root, source.accountId, source.mapping, source.inventory, source.revision,
      redactionKey, new Map<string, string>(), timeBaseline
    );
    accounts.push({ ...account, documents: await sanitizeAccountDocuments(root, source.accountId, source.documents, redactionKey, timeBaseline) });
  }
  const finalAccountIds = await readSourceAccountIds(sourceAuthUrl);
  if (JSON.stringify(firstAccountIds) !== JSON.stringify(finalAccountIds)) {
    fail("Production account set changed during snapshot; retry from a new read-only transaction");
  }
  const outputPersistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const manifest = {
    format: "release-state-startup-gate-snapshot",
    schemaVersion: 2,
    capturedAt: timeBaseline.capturedAt,
    timeBaseline,
    candidateSha: candidateSha.toLowerCase(),
    candidateTree: candidateTree.toLowerCase(),
    source: { postgresMajor: Number(serverVersion.split(".")[0]), transactionSnapshot, accounts: accounts.length },
    accounts,
    snapshotSha256: ""
  };
  manifest.snapshotSha256 = createHash("sha256").update(outputPersistence.canonicalJson({ ...manifest, snapshotSha256: "" })).digest("hex");
  const absoluteOutput = path.resolve(outputFile);
  await fs.mkdir(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
  await fs.writeFile(absoluteOutput, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.chmod(absoluteOutput, 0o600);
  process.stdout.write(`Sanitized read-only snapshot saved: ${absoluteOutput} (${manifest.snapshotSha256})\n`);
}

async function loadSnapshot(root: string, file: string): Promise<JsonRecord> {
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const snapshotValue = JSON.parse(await fs.readFile(file, "utf8")) as JsonRecord;
  if (snapshotValue.format !== "release-state-startup-gate-snapshot" || ![1, 2].includes(Number(snapshotValue.schemaVersion))) {
    fail("Unsupported startup gate snapshot format");
  }
  const expectedHash = String(snapshotValue.snapshotSha256 || "");
  const actualHash = createHash("sha256").update(persistence.canonicalJson({ ...snapshotValue, snapshotSha256: "" })).digest("hex");
  if (!/^[a-f0-9]{64}$/iu.test(expectedHash) || expectedHash !== actualHash) fail("Sanitized snapshot checksum mismatch");
  if (!Array.isArray(snapshotValue.accounts) || !snapshotValue.accounts.length) fail("Startup gate snapshot has no accounts");
  return snapshotValue;
}

async function postgresBinDirectory(root: string): Promise<string> {
  const configured = process.env.PG_TEST_BIN;
  const fallback = path.join(root, "data/pg-integration-tools/node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
  const binDirectory = path.resolve(configured || fallback);
  for (const binary of REQUIRED_PG_BINARIES) await fs.access(path.join(binDirectory, binary));
  const version = await execFile(path.join(binDirectory, "postgres"), ["--version"]);
  if (!/PostgreSQL\)\s+16(?:\.|\s)/u.test(version.stdout)) fail("Isolated startup gate requires local PostgreSQL 16");
  return binDirectory;
}

async function freeTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("Could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startLocalPostgres(
  root: string,
  tempRoot: string,
  onPrepared: (state: LocalPostgresState) => void
): Promise<LocalPostgresState> {
  const binDirectory = await postgresBinDirectory(root);
  const cluster = path.join(tempRoot, "pg-cluster");
  const logFile = path.join(tempRoot, "postgres.log");
  const passwordFile = path.join(tempRoot, "pg-password");
  const password = randomBytes(24).toString("base64url");
  const port = await freeTcpPort();
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
  const libraryDirectory = path.resolve(binDirectory, "../lib");
  if (process.platform === "darwin" && await fs.access(libraryDirectory).then(() => true, () => false)) {
    env.DYLD_LIBRARY_PATH = [libraryDirectory, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  await fs.writeFile(passwordFile, password, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await execFile(path.join(binDirectory, "initdb"), [
    "-D", cluster, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordFile,
    "--locale=C", "--encoding=UTF8"
  ], { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  await fs.appendFile(path.join(cluster, "postgresql.conf"),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  await fs.unlink(passwordFile);
  const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/startup_gate`;
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const state = { binDirectory, cluster, port, password, adminUrl, url, env };
  // 在 pg_ctl 创建独立 postmaster 前登记集群状态，保证启动后校验失败也能关闭。
  onPrepared(state);
  await execFile(path.join(binDirectory, "pg_ctl"), ["-D", cluster, "-l", logFile, "-w", "-t", "20", "start"], {
    env, timeout: 30_000, maxBuffer: 1024 * 1024
  });
  const pidText = (await fs.readFile(path.join(cluster, "postmaster.pid"), "utf8")).split("\n")[0];
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1) fail("Local PostgreSQL PID file is invalid");
  const command = await execFile("ps", ["-p", String(pid), "-o", "command="]);
  if (!command.stdout.includes(cluster)) fail("Local PostgreSQL PID is outside the isolated temporary cluster");
  return state;
}

function processExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "number" ? error.code : null;
}

async function localPostgresStopped(pgState: LocalPostgresState): Promise<boolean> {
  try {
    await execFile(path.join(pgState.binDirectory, "pg_ctl"), ["-D", pgState.cluster, "status"], {
      env: pgState.env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return false;
  } catch (error) {
    if (processExitCode(error) === 3) return true;
    throw error;
  }
}

async function stopLocalPostgres(pgState: LocalPostgresState): Promise<void> {
  if (await localPostgresStopped(pgState)) return;
  await execFile(path.join(pgState.binDirectory, "pg_ctl"), ["-D", pgState.cluster, "-m", "fast", "-w", "-t", "20", "stop"], {
    env: pgState.env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  if (!(await localPostgresStopped(pgState))) fail("Local PostgreSQL remained running after pg_ctl stop");
}

async function initializeGateDatabase(root: string, pgState: Awaited<ReturnType<typeof startLocalPostgres>>, snapshotValue: JsonRecord) {
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const admin = await pgClient(pgState.adminUrl);
  try {
    await admin.query("CREATE DATABASE startup_gate");
    const schemaClient = await pgClient(pgState.url("postgres"));
    try {
      await persistence.initializePostgresSchema(schemaClient);
      for (const role of ["runtime_data", "runtime_auth", "runtime_budget", "migration_app"]) {
        // 密码是本次运行新生成的 base64url 随机值，不含 SQL 引号或转义字符。
        await schemaClient.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pgState.password}' NOSUPERUSER NOBYPASSRLS`);
      }
      await schemaClient.query(`
        GRANT USAGE ON SCHEMA for_now TO runtime_data;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now TO runtime_data;
        REVOKE ALL ON TABLE for_now.site_ai_budget FROM runtime_data;
        GRANT USAGE ON SCHEMA for_now_auth TO runtime_auth;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now_auth TO runtime_auth;
        GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO runtime_auth;
        GRANT USAGE ON SCHEMA for_now TO runtime_budget;
        GRANT SELECT, UPDATE ON TABLE for_now.site_ai_budget TO runtime_budget;
        GRANT USAGE ON SCHEMA for_now, for_now_auth TO migration_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now, for_now_auth TO migration_app
      `);
    } finally {
      await schemaClient.end();
    }
  } finally {
    await admin.end();
  }

  const importClient = await pgClient(pgState.url("migration_app"));
  try {
    const accounts = snapshotValue.accounts as JsonRecord[];
    for (const account of accounts) {
      if (typeof account.accountId !== "string" || !account.mapping || typeof account.mapping !== "object") {
        fail("Sanitized account entry is malformed");
      }
      await importClient.query("BEGIN");
      try {
        await importClient.query("SELECT set_config('app.account_id', $1, true)", [account.accountId]);
        await importClient.query("INSERT INTO for_now.accounts (account_id) VALUES ($1)", [account.accountId]);
        await persistence.writeStoreObjects(importClient, account.mapping as StoreMapping);
        if (snapshotValue.schemaVersion === 2) {
          const documents = account.documents as AccountDocuments;
          validateDocumentPresence(documents);
          for (const [name, value] of Object.entries(documents)) {
            if (value === null && name === "costPlan") continue;
            await persistence.writeAccountDocument(importClient, String(account.accountId), name, value as JsonRecord);
            const restored = await persistence.readAccountDocument(importClient, String(account.accountId), name, null);
            if (persistence.canonicalJson(restored) !== persistence.canonicalJson(value)) fail(`Imported ${name} document readback mismatch`);
          }
        }
        for (const item of (account.attachmentInventory as JsonRecord[] || [])) {
          await importClient.query(`
            INSERT INTO for_now.attachment_inventory(account_id,path,storage,object_key,bytes,sha256,state)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [account.accountId, item.path, item.storage, item.objectKey, item.bytes, item.sha256, item.state]);
        }
        await importClient.query("COMMIT");
      } catch (error) {
        await importClient.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    const authUsers: JsonRecord[] = [];
    const passwords = new Map<string, { username: string; password: string }>();
    for (const [index, account] of accounts.entries()) {
      const username = `gate_${index + 1}`;
      const password = randomBytes(24).toString("base64url");
      const salt = randomBytes(16);
      const derived = await scrypt(password, salt, 64) as Buffer;
      authUsers.push({
        id: account.accountId,
        username,
        passwordHash: `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`,
        role: index === 0 ? "owner" : "user",
        sessionVersion: 1,
        recordTimezone: "Asia/Shanghai",
        createdAt: new Date().toISOString()
      });
      passwords.set(String(account.accountId), { username, password });
    }
    await importClient.query("BEGIN");
    try {
      await persistence.writeAuthDocument(importClient, { version: 1, users: authUsers, sessions: [] });
      await importClient.query("COMMIT");
    } catch (error) {
      await importClient.query("ROLLBACK").catch(() => {});
      throw error;
    }
    return { passwords };
  } finally {
    await importClient.end();
  }
}

type LocalGateProfile = "default" | "v0516-combined";
const combinedProfileEnvironment = Object.freeze({
  ACCOUNT_RECOVERY_ENABLED: "1",
  PG_SYNC_READ_MODE: "metadata",
  PG_SYNC_ACCOUNT_ALLOWLIST: "*",
  AI_QUEUE_ENABLED: "1",
  SYNC_ACCOUNT_WAKE_ENABLED: "1",
  THOUGHT_PAGING_ENABLED: "1",
  INCREMENTAL_SYNC_ENABLED: "1"
});
function localProfileEnvironment(profile: LocalGateProfile) {
  return profile === "v0516-combined" ? combinedProfileEnvironment : {};
}

function installGateEnvironment(tempRoot: string, urls: { data: string; auth: string; budget: string }, port: number, counts: Record<string, number>, profile: LocalGateProfile = "default") {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const safeSystemKeys = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "DYLD_LIBRARY_PATH"];
  const safeSystem = Object.fromEntries(safeSystemKeys.filter(key => previous[key]).map(key => [key, previous[key]]));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safeSystem, {
    NODE_ENV: "test",
    PERSISTENCE_BACKEND: "postgres",
    AUTH_REQUIRED: "1",
    INVITE_CODE_HASH: createHash("sha256").update(randomBytes(32)).digest("hex"),
    DATABASE_URL: urls.data,
    AUTH_DATABASE_URL: urls.auth,
    AI_BUDGET_DATABASE_URL: urls.budget,
    DATA_DIR: path.join(tempRoot, "app-data"),
    PORT: String(port),
    PERIODIC_ANALYSIS_ENABLED: "0",
    RECORD_COMPRESSION_ENABLED: "0",
    SPEECH_CACHE_SWEEP_ENABLED: "0",
    FEISHU_ALERT_WEBHOOK: "",
    FEISHU_ALERT_SECRET: "",
    DEEPSEEK_API_KEY: "",
    ATTACHMENT_STORAGE: "local",
    ...localProfileEnvironment(profile)
  });
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].includes(target.hostname.replace(/^\[|\]$/gu, "").toLowerCase())) {
      return previousFetch(input, init);
    }
    counts.outbound = (counts.outbound || 0) + 1;
    throw new Error(`Startup gate blocked outbound network request: ${target.protocol}//${target.hostname}`);
  };
  return () => {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  };
}

async function fetchJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let value: unknown = null;
  try { value = body ? JSON.parse(body) : null; } catch {}
  return { response, body, value };
}

async function login(baseUrl: string, credentials: { username: string; password: string }) {
  const { response, body, value } = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials)
  });
  if (!response.ok) fail(`Isolated runtime login failed (${response.status})`);
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  if (!cookie) fail("Isolated runtime login did not issue a session cookie");
  return { cookie, user: value };
}

async function readLocalTaskStates(root: string, url: string, accountIds: string[], clock: InspectionClock) {
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const inspectorStates: JsonRecord[] = [];
  const client = await pgClient(url);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const accountId of accountIds) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const mapping = await persistence.readPostgresStoreObjects(client, accountId);
      const store = persistence.rebuildStoreObjects(mapping);
      const inspector = (await createClosedInspector(root, accountId, {}, clock)).backgroundAi;
      inspectorStates.push(...taskStates(store, inspector, Buffer.alloc(32), true).map(state => ({ ...state, accountId })));
    }
    await client.query("COMMIT");
    return inspectorStates.sort((left, right) => `${left.accountId}:${left.id}`.localeCompare(`${right.accountId}:${right.id}`));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}


async function readGateConfiguration(root: string) {
    const configModule = await importFromRoot<{ loadAppConfig(input: { rootDir: string }): {
      accountRecovery: { enabled: boolean }; pgIo: { syncReadMode: string; accountAllowlist: string[] };
      aiQueue: { enabled: boolean }; syncAccountWakeEnabled: boolean;
      features: { thoughtPaging: { enabled: boolean }; incrementalSync: boolean }
    } }>(root, "src/config/index.mjs");
    const parsed = configModule.loadAppConfig({ rootDir: root });
    return {
      accountRecoveryEnabled: parsed.accountRecovery.enabled,
      pgSyncReadMode: parsed.pgIo.syncReadMode,
      pgSyncAccountAllowlist: parsed.pgIo.accountAllowlist,
      aiQueueEnabled: parsed.aiQueue.enabled,
      syncAccountWakeEnabled: parsed.syncAccountWakeEnabled,
      thoughtPagingEnabled: parsed.features.thoughtPaging.enabled,
      incrementalSyncEnabled: parsed.features.incrementalSync
    };
}

async function startRuntime(
  root: string,
  tempRoot: string,
  urls: { data: string; auth: string; budget: string },
  port: number,
  gate: StartupGatePort,
  cleanupFailures: string[],
  profile: LocalGateProfile = "default"
) {
  const restoreEnvironment = installGateEnvironment(tempRoot, urls, port, gate.counts, profile);
  let runtime: { start(): Promise<{ port: number }>; ready(): Promise<void>; stop(): Promise<void> } | null = null;
  try {
    const moduleName = pathToFileURL(path.join(root, "src/app/server-runtime.mjs")).href;
    const runtimeModule = await import(moduleName) as unknown as {
      createServerRuntime(options: JsonRecord): { start(): Promise<{ port: number }>; ready(): Promise<void>; stop(): Promise<void> };
    };
    runtime = runtimeModule.createServerRuntime({
      rootUrl: pathToFileURL(path.join(root, "server.mjs")).href,
      processRef: process,
      startupGate: gate
    });
    const effectiveConfiguration = await readGateConfiguration(root);
    if (profile === "v0516-combined" && (!effectiveConfiguration.accountRecoveryEnabled
      || effectiveConfiguration.pgSyncReadMode !== "metadata" || !effectiveConfiguration.pgSyncAccountAllowlist.includes("*")
      || !effectiveConfiguration.aiQueueEnabled || !effectiveConfiguration.syncAccountWakeEnabled || !effectiveConfiguration.thoughtPagingEnabled)) {
      fail("Combined profile did not reach the application's unique configuration parser");
    }
    const started = await runtime.start();
    await runtime.ready();
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const ready = await fetch(`${baseUrl}/readyz`);
    if (!ready.ok) fail(`Isolated runtime readyz failed (${ready.status})`);
    return { runtime, baseUrl, restoreEnvironment, profile, effectiveConfiguration };
  } catch (error) {
    if (runtime) {
      try {
        await runtime.stop();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupFailureLabel("runtime.stop after startup failure", cleanupError));
      }
    }
    try {
      restoreEnvironment();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupFailureLabel("runtime environment restore after startup failure", cleanupError));
    }
    if (cleanupFailures.length) {
      fail(`Isolated runtime startup failed (${errorKindLabel(error)}) and cleanup was incomplete: ${cleanupFailures.join(", ")}`);
    }
    throw error;
  }
}

function cleanupFailureLabel(phase: string, error: unknown): string {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const exitCode = processExitCode(error);
  return `${phase} (${errorName}${exitCode === null ? "" : `, exit ${exitCode}`})`;
}

function errorKindLabel(error: unknown): string {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const exitCode = processExitCode(error);
  return `${errorName}${exitCode === null ? "" : `, exit ${exitCode}`}`;
}

async function snapshotHasNoPendingAttachmentCleanup(root: string, snapshotValue: JsonRecord): Promise<boolean> {
  const accounts = snapshotValue.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) return false;
    const accountValue = account as JsonRecord;
    if (typeof accountValue.accountId !== "string" || !accountValue.accountId) return false;
    const mappingValue = accountValue.mapping;
    if (!mappingValue || typeof mappingValue !== "object" || Array.isArray(mappingValue)) return false;
    const mapping = mappingValue as StoreMapping;
    if (![mapping.fields, mapping.objects, mapping.relations, mapping.attachmentRefs, mapping.lifecycles, mapping.idempotency]
      .every(Array.isArray)) return false;
    if (!mapping.objects.every(row => row !== null
      && typeof row === "object"
      && typeof row.collection === "string"
      && typeof row.kind === "string")) return false;

    const rebuiltStore = persistence.rebuildStoreObjects(mapping);
    if (!Array.isArray(rebuiltStore.attachmentCleanup)) return false;
    const rebuiltMapping = persistence.mapStoreObjects(accountValue.accountId, rebuiltStore);
    assertMappingRoundTrip(mapping, rebuiltMapping, persistence.canonicalJson);
    if (rebuiltStore.attachmentCleanup.length > 0) return false;
  }
  return true;
}

function usesOnlyIsolatedPostgres(urls: { data: string; auth: string; budget: string }, port: number): boolean {
  const expected = [
    { value: urls.data, user: "runtime_data" },
    { value: urls.auth, user: "runtime_auth" },
    { value: urls.budget, user: "runtime_budget" }
  ];
  return expected.every(({ value, user }) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "postgresql:"
        && parsed.hostname === "127.0.0.1"
        && Number(parsed.port) === port
        && parsed.pathname === "/startup_gate"
        && decodeURIComponent(parsed.username) === user
        && !parsed.search
        && !parsed.hash;
    } catch {
      return false;
    }
  });
}

function createStartupEffectObserver(
  snapshotProvesEmptyCleanupQueue: boolean,
  isolatedPostgresOnly: boolean,
  counts: Record<string, number>
) {
  return (kind: string, operation: string) => {
    // 只放行真实的空队列恢复调用。快照结构不完整或队列非空时仍在函数执行前拒绝。
    if (kind === "media" && operation === "resumeAttachmentCleanup" && snapshotProvesEmptyCleanupQueue) {
      counts.emptyCleanupResumeCalls = (counts.emptyCleanupResumeCalls || 0) + 1;
      return;
    }
    // 仅在本门强制绑定 loopback 临时 PostgreSQL、且local attachment配置生效时放行账户级清单读取。
    if (kind === "media" && operation === "listAttachmentInventory" && isolatedPostgresOnly) {
      counts.postgresAttachmentInventoryReads = (counts.postgresAttachmentInventoryReads || 0) + 1;
      return;
    }
    counts[kind] = (counts[kind] || 0) + 1;
    throw new Error(`Startup gate blocked ${kind}:${operation}`);
  };
}

function assertAttachmentFreeSaveInventoryReads(count: number) {
  if (count !== 0) {
    fail(`Attachment-free authenticated save performed ${count} PostgreSQL attachment-inventory reads`);
  }
}

async function verify(root: string, snapshotFile: string, profile: LocalGateProfile = "default") {
  const snapshotValue = await loadSnapshot(root, snapshotFile);
  if (profile === "v0516-combined" && snapshotValue.schemaVersion !== 2) fail("Combined startup gate requires schema2 real account documents; schema1 is historical and incomplete");
  const snapshotProvesEmptyCleanupQueue = await snapshotHasNoPendingAttachmentCleanup(root, snapshotValue);
  const timeBaseline = snapshotValue.timeBaseline as InspectionClock;
  if (!timeBaseline?.capturedAt || !timeBaseline.timezone || snapshotValue.capturedAt !== timeBaseline.capturedAt) {
    fail("Startup gate snapshot has no consistent semantic inspection time baseline");
  }
  // 控制面及正式版本记录按协议及时落盘、随相关提交保存；它们不是运行代码候选。
  const changedTrackedFiles = (await execFile("git", ["diff", "--name-only", "HEAD"], { cwd: root })).stdout
    .split("\n").filter(Boolean).filter(file => file !== "coordination/current.json"
      && !/^coordination\/versions\/[A-Za-z0-9._-]+\/(events\.jsonl|terminal\.json)$/u.test(file));
  if (changedTrackedFiles.length) fail("Startup verification requires a clean tracked code candidate matching the recorded tree");
  await execFile("git", ["ls-files", "--error-unmatch", "scripts/release-state-startup-gate.mts", "tsconfig.release-state-startup-gate.json"], { cwd: root });
  const gitSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const gitTree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  if (snapshotValue.candidateSha !== gitSha || snapshotValue.candidateTree !== gitTree) {
    fail("Snapshot and local runtime candidate SHA/tree do not match");
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-startup-gate-"));
  await fs.chmod(tempRoot, 0o700);
  let pgState: Awaited<ReturnType<typeof startLocalPostgres>> | null = null;
  let runtimeInstance: { stop(): Promise<void> } | null = null;
  let restoreRuntimeEnvironment: (() => void) | null = null;
  const cleanupFailures: string[] = [];
  let operationFailure: unknown = null;
  let operationFailurePhase = "local PostgreSQL startup";
  let phase = operationFailurePhase;
  let passReceipt: JsonRecord | null = null;
  let inventoryReadsDuringSave = 0;
  const stopActiveRuntime = async () => {
    const runtimeToStop = runtimeInstance;
    runtimeInstance = null;
    if (runtimeToStop) {
      try {
        await runtimeToStop.stop();
      } catch (error) {
        cleanupFailures.push(cleanupFailureLabel("runtime.stop", error));
      }
    }
    const restoreEnvironment = restoreRuntimeEnvironment;
    restoreRuntimeEnvironment = null;
    if (restoreEnvironment) {
      try {
        restoreEnvironment();
      } catch (error) {
        cleanupFailures.push(cleanupFailureLabel("runtime environment restore", error));
      }
    }
  };
  try {
    phase = "local PostgreSQL startup";
    pgState = await startLocalPostgres(root, tempRoot, prepared => { pgState = prepared; });
    phase = "snapshot import";
    const imported = await initializeGateDatabase(root, pgState, snapshotValue);
    const accountIds = (snapshotValue.accounts as JsonRecord[]).map(account => String(account.accountId));
    phase = "imported task-state equivalence";
    const importedStates = await readLocalTaskStates(root, pgState.url("runtime_data"), accountIds, timeBaseline);
    const expectedStates: JsonRecord[] = (snapshotValue.accounts as JsonRecord[]).flatMap(account =>
      (account.taskStates as JsonRecord[] || []).map(state => ({ ...state, accountId: String(account.accountId) }))
    ).sort((left: JsonRecord, right: JsonRecord) => `${left.accountId}:${String(left.id || "")}`.localeCompare(`${right.accountId}:${String(right.id || "")}`));
    if (JSON.stringify(importedStates) !== JSON.stringify(expectedStates)) {
      fail("Imported recovery task statuses, targets, or intent matches differ from the sanitized snapshot");
    }
    const testPort = await freeTcpPort();
    const urls = {
      data: pgState.url("runtime_data"),
      auth: pgState.url("runtime_auth"),
      budget: pgState.url("runtime_budget")
    };
    if (!usesOnlyIsolatedPostgres(urls, pgState.port)) {
      fail("Core attachment-inventory reads require the three isolated loopback PostgreSQL databases");
    }
    const gateCounts: Record<string, number> = {
      dispatchHeld: 0,
      provider: 0,
      outbound: 0,
      media: 0,
      emptyCleanupResumeCalls: 0,
      postgresAttachmentInventoryReads: 0
    };
    const gate: StartupGatePort = {
      tempRoot,
      counts: gateCounts,
      holdDispatch(kind: string, _callback: (...args: unknown[]) => unknown) {
        gateCounts.dispatchHeld += 1;
        gateCounts[`dispatch_${kind}`] = (gateCounts[`dispatch_${kind}`] || 0) + 1;
        return null;
      },
      observeEffect: createStartupEffectObserver(snapshotProvesEmptyCleanupQueue, true, gateCounts)
    };
    phase = "first runtime startup";
    const firstResumeCallsBeforeStart = gateCounts.emptyCleanupResumeCalls;
    const first = await startRuntime(root, tempRoot, urls, testPort, gate, cleanupFailures, profile);
    runtimeInstance = first.runtime;
    restoreRuntimeEnvironment = first.restoreEnvironment;
    const firstResumeCalls = gateCounts.emptyCleanupResumeCalls - firstResumeCallsBeforeStart;
    if (firstResumeCalls !== accountIds.length) {
      fail(`Expected one empty attachment-cleanup resume call per imported account during first startup; expected ${accountIds.length}, observed ${firstResumeCalls}`);
    }
    phase = "first runtime recovery state";
    const firstStates = await readLocalTaskStates(root, urls.data, accountIds, timeBaseline);
    phase = "first runtime stop";
    await stopActiveRuntime();
    if (cleanupFailures.length) fail("First isolated runtime stop or environment restore failed");

    const secondPort = await freeTcpPort();
    phase = "same-database runtime restart";
    const secondResumeCallsBeforeStart = gateCounts.emptyCleanupResumeCalls;
    const second = await startRuntime(root, tempRoot, urls, secondPort, gate, cleanupFailures, profile);
    runtimeInstance = second.runtime;
    restoreRuntimeEnvironment = second.restoreEnvironment;
    const secondResumeCalls = gateCounts.emptyCleanupResumeCalls - secondResumeCallsBeforeStart;
    if (secondResumeCalls !== accountIds.length) {
      fail(`Expected one empty attachment-cleanup resume call per imported account during restart; expected ${accountIds.length}, observed ${secondResumeCalls}`);
    }
    phase = "restart recovery state comparison";
    const secondStates = await readLocalTaskStates(root, urls.data, accountIds, timeBaseline);
    if (JSON.stringify(firstStates) !== JSON.stringify(secondStates)) fail("Task recovery state changed on the second same-database restart");

    const firstAccount = (snapshotValue.accounts as JsonRecord[])[0];
    const credentials = imported.passwords.get(String(firstAccount.accountId));
    if (!credentials) fail("Synthetic local login credentials are missing");
    phase = "authenticated login";
    const session = await login(second.baseUrl, credentials);
    const headers = { cookie: session.cookie, "content-type": "application/json" };
    phase = "authenticated state read";
    const stateBefore = await fetchJson(`${second.baseUrl}/api/state`, { headers });
    if (!stateBefore.response.ok) fail(`Authenticated core read failed (${stateBefore.response.status})`);
    const marker = `startup-gate-${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    phase = "authenticated save round-trip";
    const inventoryReadsBeforeSave = gateCounts.postgresAttachmentInventoryReads;
    const save = await fetchJson(`${second.baseUrl}/api/thoughts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "question", content: marker, occurredAt: now, occurredOn: now.slice(0, 10) })
    });
    if (save.response.status !== 201) fail(`Authenticated save round-trip write failed (${save.response.status})`);
    inventoryReadsDuringSave = gateCounts.postgresAttachmentInventoryReads - inventoryReadsBeforeSave;
    assertAttachmentFreeSaveInventoryReads(inventoryReadsDuringSave);
    phase = "authenticated save persistence read";
    const stateAfter = await fetchJson(`${second.baseUrl}/api/state`, { headers });
    if (!stateAfter.response.ok || !stateAfter.body.includes(marker)) fail("Authenticated save/read round trip did not persist");
    phase = "task and notification reads";
    const taskRead = await fetchJson(`${second.baseUrl}/api/ai-tasks`, { headers });
    const notificationRead = await fetchJson(`${second.baseUrl}/api/notifications`, { headers });
    if (!taskRead.response.ok || !notificationRead.response.ok) fail("Core task/notification read smoke failed");
    phase = "final runtime stop";
    await stopActiveRuntime();
    if (cleanupFailures.length) fail("Final isolated runtime stop or environment restore failed");

    phase = "external side-effect audit";
    if (gateCounts.provider || gateCounts.outbound || gateCounts.media) {
      fail("A provider, outbound notification/debug request, or media method was attempted during the gate");
    }
    const expectedCleanupResumeCalls = accountIds.length * 2;
    if (gateCounts.emptyCleanupResumeCalls !== expectedCleanupResumeCalls) {
      fail(`Expected one verified empty attachment-cleanup resume call per imported account per startup; expected ${expectedCleanupResumeCalls}, observed ${gateCounts.emptyCleanupResumeCalls}`);
    }
    passReceipt = {
      status: "PASS",
      profile,
      effectiveConfiguration: { first: first.effectiveConfiguration, restart: second.effectiveConfiguration },
      candidateSha: snapshotValue.candidateSha,
      candidateTree: snapshotValue.candidateTree,
      snapshotSha256: snapshotValue.snapshotSha256,
      pgVersion: (await execFile(path.join(pgState.binDirectory, "postgres"), ["--version"])).stdout.trim(),
      accounts: (snapshotValue.accounts as JsonRecord[]).length,
      accountDocumentCoverage: snapshotValue.schemaVersion === 2 ? {
        source: "same-repeatable-read-production-documents",
        required: ["settings", "usage"],
        optionalCostPlanPresent: (snapshotValue.accounts as JsonRecord[]).filter(account => (account.documents as AccountDocuments).costPlan !== null).length,
        replacements: ["nonempty API credentials replaced by inert local token", "private display/voice/free diagnostic text replaced; fixed state and ledger numbers preserved"],
        boundary: "No live provider authentication or outbound call is validated"
      } : { source: "historical-schema1-business-store-only", limitation: "settings/usage were not captured" },
      taskCount: firstStates.length,
      heldDispatches: gateCounts.dispatchHeld,
      forbiddenEffects: { provider: gateCounts.provider, outbound: gateCounts.outbound, media: gateCounts.media },
      emptyCleanupResumeCallsPerStartup: [firstResumeCalls, secondResumeCalls],
      postgresAttachmentInventoryReads: gateCounts.postgresAttachmentInventoryReads,
      postgresAttachmentInventoryReadsDuringAttachmentFreeSave: inventoryReadsDuringSave,
      evidence: ["runtime.start", "readyz", "same-postgres-stop-restart", "authenticated-state-read", "save-read-round-trip", "task-read", "notification-read"]
    };
  } catch (error) {
    operationFailure = error;
    operationFailurePhase = phase;
  } finally {
    await stopActiveRuntime();
    if (pgState) {
      try {
        await stopLocalPostgres(pgState);
      } catch (error) {
        cleanupFailures.push(cleanupFailureLabel("local PostgreSQL stop/status", error));
      }
    }
    if (!cleanupFailures.length) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(cleanupFailureLabel("temporary directory removal", error));
      }
    }
  }
  if (operationFailure) {
    if (cleanupFailures.length) {
      fail(`Startup gate failed during ${operationFailurePhase} (${errorKindLabel(operationFailure)}) and cleanup was incomplete: ${cleanupFailures.join(", ")}; temporary directory retained at ${tempRoot}`);
    }
    throw operationFailure;
  }
  if (cleanupFailures.length) {
    fail(`Startup gate cleanup failed: ${cleanupFailures.join(", ")}; temporary directory retained at ${tempRoot}`);
  }
  if (!passReceipt) fail("Startup gate completed without a pass receipt");
  process.stdout.write(JSON.stringify(passReceipt) + "\n");
}

async function selfTest(root: string) {
  assertAttachmentFreeSaveInventoryReads(0);
  let attachmentFreeSaveRejected = false;
  try { assertAttachmentFreeSaveInventoryReads(1); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Attachment-free authenticated save performed 1")) throw error;
    attachmentFreeSaveRejected = true;
  }
  if (!attachmentFreeSaveRejected) fail("Attachment-free save inventory regression was not rejected");
  for (const profile of ["default", "v0516-combined"] as const) {
    const restore = installGateEnvironment(os.tmpdir(), {
      data: "postgresql://localhost:1/gate_data", auth: "postgresql://localhost:1/gate_auth", budget: "postgresql://localhost:1/gate_budget"
    }, 1, {}, profile);
    try {
      const effective = await readGateConfiguration(root);
      const combined = profile === "v0516-combined";
      if (effective.accountRecoveryEnabled !== combined || effective.aiQueueEnabled !== combined
        || effective.syncAccountWakeEnabled !== combined || effective.thoughtPagingEnabled !== combined
        || !effective.incrementalSyncEnabled || effective.pgSyncReadMode !== (combined ? "metadata" : "legacy")
        || effective.pgSyncAccountAllowlist.join(",") !== (combined ? "*" : "")) {
        fail("Local gate profile lost a flag at the unique configuration parser");
      }
      process.stdout.write(JSON.stringify({ localGateProfile: profile, effectiveConfiguration: effective }) + "\n");
    } finally { restore(); }
  }
  const counts: Record<string, number> = {};
  const fixtureClock = createInspectionClock("2026-10-12T00:00:00.000Z", "Asia/Shanghai");
  const runtime = await createClosedInspector(root, "synthetic-account", counts, fixtureClock);
  const inspector = runtime.backgroundAi;
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const app = await importFromRoot<{
    normalizeStore(value: JsonRecord): JsonRecord;
  }>(root, "src/app/index.mjs");
  const persistedNormalization = await importFromRoot<{
    normalizePersistedDocument(source: JsonRecord, normalize: (value: JsonRecord) => JsonRecord): JsonRecord;
  }>(root, "src/shared/persistence/normalization.mjs");
  const compressionApi = await importFromRoot<{
    RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION: string;
    RECORD_COMPRESSION_PROMPT_VERSION: string;
    HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION: string;
    HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION: number;
    HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET: number;
    estimateHistoricalUserSupplementOutputTokens: SupplementEstimator;
  }>(root, "src/modules/record-compressions/index.mjs");
  const persistenceMetadata = await importFromRoot<PersistenceMetadataApi & {
    recordIdempotencyResponse(document: JsonRecord, request: JsonRecord, now: () => string): void;
  }>(root, "src/shared/persistence/persistence-metadata.mjs");
  const content = await importFromRoot<{ markdownText(value: string): string }>(root, "src/shared/content/index.mjs");
  const annotationResources = await importFromRoot<{
    annotationResourceSource(store: JsonRecord, resourceType: string, root: JsonRecord, targetKey: string): string;
  }>(root, "src/app/annotation-resources.mjs");
  const permissionSourceTargetKey = "question:thought-private-root";
  const permissionSourceKey = JSON.stringify([
    "thought", "thought-private-root", "thought-private-root", permissionSourceTargetKey
  ]);
  const dependencySourceKey = JSON.stringify([
    "thought", "thought-private-answer", "thought-private-answer", "content"
  ]);
  const messageSourceTargetKey = "message";
  const messageSourceKey = JSON.stringify(["chat", "chat-private-id", "", messageSourceTargetKey]);
  const noteTargetKey = "note:note-private-id";
  const reflectionTargetKey = "reflection:reflection-private-id";
  const transcriptionTargetKey = "transcription";
  const sharedTechnicalDigest = createHash("sha256").update("shared technical source content").digest("hex");
  const compressionManifestDigest = createHash("sha256").update("compression manifest").digest("hex");
  const supplementRecords = [{
    recordVersion: compressionApi.HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
    statement: "stable1",
    exactQuote: "question",
    source: {
      localDate: "2026-10-11",
      sourceId: "id-a",
      sourceHash: sharedTechnicalDigest,
      permissionRevision: 1
    }
  }, {
    recordVersion: compressionApi.HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
    statement: "stable2",
    exactQuote: "message",
    source: {
      localDate: "2026-10-11",
      sourceId: "id-b",
      sourceHash: sharedTechnicalDigest,
      permissionRevision: 1
    }
  }];
  const store: JsonRecord = {
    captures: [{ id: "capture-private-id", capturedAt: "2026-10-11T18:30:00.000Z", timezone: "Asia/Shanghai", attachmentPath: "/attachments/private-capture.m4a" }],
    speechCache: [{
      id: "speech-cache-capture",
      cacheKey: "speech-cache-capture",
      sourceType: "capture",
      sourceId: "capture-private-id",
      attachmentPath: "/attachments/speech-capture.mp3",
      mimeType: "audio/mpeg",
      bytes: 128,
      createdAt: "2026-10-11T18:30:00.000Z",
      expiresAt: "2026-11-10T18:30:00.000Z"
    }, {
      id: "speech-cache-answer-id",
      cacheKey: "speech-cache-answer-key",
      sourceType: "thoughtAnswer",
      sourceId: "thought-private-answer",
      sourceVersion: 1,
      sourceVersions: {
        question: { id: "thought-private-root", version: 1 },
        answer: { id: "thought-private-answer", version: 1 }
      },
      attachmentPath: "/attachments/speech-answer.mp3",
      mimeType: "audio/mpeg",
      bytes: 256,
      createdAt: "2026-10-11T18:30:00.000Z",
      expiresAt: "2026-11-10T18:30:00.000Z"
    }, {
      id: "speech-cache-thought-chain",
      cacheKey: "speech-cache-thought-chain",
      sourceType: "thoughtChain",
      sourceId: "thought-private-root",
      sourceVersion: 1,
      sourceVersions: { question: { id: "thought-private-root", version: 1 } },
      attachmentPath: "/attachments/speech-thought-chain.mp3",
      mimeType: "audio/mpeg",
      bytes: 512,
      createdAt: "2026-10-11T18:30:00.000Z",
      expiresAt: "2026-11-10T18:30:00.000Z"
    }],
    thoughts: [
      {
        id: "thought-private-root",
        type: "question",
        sourceType: "capture",
        content: "**private question phrase** and overlapping question phrase",
        version: 1,
        sourceRef: { type: "capture", id: "capture-private-id", targetKey: "" },
        sourceCaptureId: "capture-private-id",
        sourceId: "id-a",
        recordTimezone: "Asia/Shanghai",
        contextGeneratedAt: "2026-10-11T18:30:00.000Z",
        inputAsOf: "2026-10-11T18:30:00.000Z",
        imagePath: "/attachments/private-image.png",
        annotations: [
          { id: "annotation-content-id", targetKey: "content", quote: "private content quote", text: "private content comment" },
          { id: "annotation-message-id", targetKey: "message", quote: "private message quote", text: "private message comment" },
          { id: "annotation-note-id", targetKey: "note:note-private-id", quote: "private note quote", text: "private note comment" },
          { id: "annotation-reflection-id", targetKey: "reflection:reflection-private-id", quote: "private reflection quote", text: "private reflection comment" },
          { id: "annotation-transcription-id", targetKey: "transcription", quote: "private transcription quote", text: "private transcription comment" },
          { id: "annotation-custom-id", targetKey: "private-custom-target", quote: "private custom quote", text: "private custom comment" },
          { id: "annotation-overlap-id", targetKey: "question:thought-private-root", quote: "private question", text: "private comment", version: 1 },
          { id: "annotation-contained-id", targetKey: "question:thought-private-root", quote: "question", text: "private comment", version: 1 },
          { id: "annotation-overlap-long-id", targetKey: "question:thought-private-root", quote: "question phrase", text: "private comment", version: 1 },
          { id: "annotation-drift-id", targetKey: "question:thought-private-root", quote: "drifted private quote", text: "private comment", version: 1 },
          { id: "annotation-empty-quote-id", targetKey: "question:thought-private-root", quote: "", text: "private comment", version: 1 }
        ],
        followUps: [{ id: "followup-private-id", question: "private follow-up", version: 1 }]
      },
      {
        id: "thought-private-answer",
        type: "answer",
        content: "private answer phrase",
        version: 1,
        relatedTo: "thought-private-root",
        sourceId: "capture-private-id"
      }
    ],
    chats: [{
      id: "annotation-chat-private-id",
      message: "private chat message",
      answer: "**chat answer body**",
      sourceId: "id-b",
      version: 1,
      annotations: [{ id: "chat-answer-annotation-id", targetKey: "answer", quote: "answer body", text: "private comment", version: 1 }]
    }],
    books: [{
      id: "book-private-id",
      description: "Book **description details**",
      version: 1,
      annotations: [{ id: "book-description-annotation-id", targetKey: "description", quote: "description details", text: "private comment", version: 1 }]
    }],
    aiTasks: [{
      id: "task-private-id",
      kind: "followUpAnswer",
      resourceType: "thought",
      targetId: "thought-private-root",
      subtargetId: "followup-private-id",
      status: "waiting_for_user_model",
      inputVersion: 1,
      subtargetVersion: 1,
      requestedIntentInputVersion: 1,
      requestedIntentSubtargetVersion: 1
    }, {
      id: "annotation-task-private-id",
      kind: "annotationShenji",
      resourceType: "thought",
      targetId: "thought-private-root",
      subtargetId: "annotation-overlap-id",
      status: "waiting_for_user_model",
      inputVersion: 1,
      subtargetVersion: 1
    }],
    notifications: [{ id: "notification-private-id", taskId: "task-private-id", status: "waiting_for_user_model" }],
    evidencePermissions: [{
      schemaVersion: 1,
      accountId: "synthetic-account",
      sourceKey: permissionSourceKey,
      contextAllowed: true,
      learningAllowed: false,
      revision: 1,
      updatedAt: "2026-10-11T18:30:00.000Z"
    }, {
      schemaVersion: 1,
      accountId: "synthetic-account",
      sourceKey: messageSourceKey,
      contextAllowed: true,
      learningAllowed: false,
      revision: 1,
      updatedAt: "2026-10-11T18:30:00.000Z"
    }],
    evidenceSources: ["chat", "note", "reflection", "transcription"].map((resourceType, index) => ({
      schemaVersion: 1,
      id: `evidence-source-${index}`,
      accountId: "synthetic-account",
      eventId: `evidence-event-${index}`,
      origin: "user",
      informationType: "user_fact",
      contentSha256: sharedTechnicalDigest,
      contentLength: 0,
      span: null,
      occurredAt: "2026-10-11T18:30:00.000Z",
      recordedAt: "2026-10-11T18:30:00.000Z",
      permissionRevision: 1,
      sourceRef: {
        resourceType,
        resourceId: resourceType === "chat" ? "chat-private-id" : `${resourceType}-private-id`,
        rootId: "",
        targetKey: [messageSourceTargetKey, noteTargetKey, reflectionTargetKey, transcriptionTargetKey][index],
        version: 1
      },
      derivedFrom: index === 0 ? [{
        sourceKey: dependencySourceKey,
        version: 1,
        contentSha256: sharedTechnicalDigest,
        permissionRevision: 1
      }] : []
    })),
    perceptionEvents: [{
      schemaVersion: 1,
      id: "event-private-id",
      accountId: "synthetic-account",
      kind: "created",
      sourceRef: {
        resourceType: "thought",
        resourceId: "thought-private-root",
        rootId: "thought-private-root",
        targetKey: permissionSourceTargetKey,
        version: 1
      },
      eventId: "event-private-id",
      contentSha256: sharedTechnicalDigest,
      permissionRevision: 1,
      occurredAt: "2026-10-11T18:30:00.000Z",
      recordedAt: "2026-10-11T18:30:00.000Z",
      perceptionVersion: "synthetic-perception-v1"
    }, {
      schemaVersion: 1,
      id: "event-message-id",
      accountId: "synthetic-account",
      kind: "created",
      sourceRef: {
        resourceType: "chat",
        resourceId: "chat-private-id",
        rootId: "",
        targetKey: messageSourceTargetKey,
        version: 1
      },
      eventId: "event-message-id",
      contentSha256: createHash("sha256").update("synthetic-message-event").digest("hex"),
      permissionRevision: 1,
      occurredAt: "2026-10-11T18:30:00.000Z",
      recordedAt: "2026-10-11T18:30:00.000Z",
      perceptionVersion: "synthetic-perception-v1"
    }],
    recordCompressions: [{
      id: "compression-private-id",
      status: "ready",
      schemaVersion: compressionApi.RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
      promptVersion: compressionApi.RECORD_COMPRESSION_PROMPT_VERSION,
      revision: 1,
      localDate: "2026-10-11",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-10-11T18:30:00.000Z",
      sourceManifestHash: compressionManifestDigest,
      sourceManifest: [{ sourceId: "manifest-source-private", recordId: "manifest-record-private", sourceHash: sharedTechnicalDigest }],
      sourceRefs: [{ sourceId: "reference-source-private", recordId: "reference-record-private", sourceHash: sharedTechnicalDigest }],
      window: {
        localDate: "2026-10-11",
        timezone: "Asia/Shanghai",
        start: "2026-10-10T16:00:00.000Z",
        endExclusive: "2026-10-11T16:00:00.000Z",
        completeness: "complete"
      },
      daily: {},
      thoughtsIdeas: {},
      other: {},
      metrics: [],
      tokenUsage: { estimated: true, outputTokens: 1 }
    }],
    historicalUserSupplement: {
      schemaVersion: compressionApi.HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
      records: supplementRecords,
      coverage: { windowDays: 7, availableSources: 2, includedSources: 2, complete: true },
      tokenUsage: {
        estimated: true,
        scope: "model_output",
        tokens: compressionApi.estimateHistoricalUserSupplementOutputTokens(supplementRecords)
      }
    },
    onboardingV2: { version: 1, answer: "private singleton answer" }
  };
  persistenceMetadata.synchronizePersistenceMetadata(null, store, () => fixtureClock.capturedAt, { force: true });
  persistenceMetadata.recordIdempotencyResponse(store, {
    scope: "synthetic-startup-gate",
    key: "synthetic-idempotency-key",
    requestHash: createHash("sha256").update("synthetic idempotency request").digest("hex"),
    response: { accepted: true, resultId: "synthetic-idempotency-result" }
  }, () => fixtureClock.capturedAt);
  const metadataChangeBefore = structuredClone(store);
  (store.onboardingV2 as JsonRecord).answer = "private singleton answer updated";
  const syncContext: JsonRecord = {
    operationId: "synthetic-sync-operation",
    method: "PATCH",
    resource: "/api/sync/synthetic",
    contentType: "application/json",
    ifMatch: "synthetic-version",
    requestBodySha256: createHash("sha256").update("synthetic sync body").digest("hex")
  };
  syncContext.clientOperationFingerprint = persistenceMetadata.syncOperationFingerprint(syncContext);
  persistenceMetadata.synchronizePersistenceMetadata(
    metadataChangeBefore,
    store,
    () => fixtureClock.capturedAt,
    {
      force: true,
      context: syncContext
    }
  );
  const task = (store.aiTasks as JsonRecord[])[0];
  const initial = inspector.inspectRecoveryIntent(store, task);
  if (!initial.intent?.inputHash || !initial.target?.exists || !initial.target.subtargetExists) {
    fail("Synthetic waiting task does not resolve its real target and follow-up");
  }
  task.requestedIntentInputVersion = initial.intent.inputVersion ?? 0;
  task.requestedIntentSubtargetVersion = initial.intent.subtargetVersion ?? 0;
  task.requestedIntentInputHash = initial.intent.inputHash;
  const sourceInspection = inspector.inspectRecoveryIntent(store, task);
  if (sourceInspection.intentMatch !== "matched") fail("Synthetic waiting intent should match before redaction");
  const annotationTask = (store.aiTasks as JsonRecord[])[1];
  const annotationInitial = inspector.inspectRecoveryIntent(store, annotationTask);
  if (annotationInitial.intentMatch !== "matched" || !annotationInitial.intent?.inputHash) {
    fail("Synthetic annotation intent should match through the real source inspector before redaction");
  }
  annotationTask.requestedIntentInputVersion = annotationInitial.intent.inputVersion ?? 0;
  annotationTask.requestedIntentSubtargetVersion = annotationInitial.intent.subtargetVersion ?? 0;
  annotationTask.requestedIntentInputHash = annotationInitial.intent.inputHash;
  const hmacKey = randomBytes(32);
  const sourceMapping = persistence.mapStoreObjects("synthetic-account", store);
  const sourceStates = taskStates(store, inspector, hmacKey);
  const sourceAttachmentDigest = sharedTechnicalDigest;
  const inventory: JsonRecord[] = [{
    path: "/attachments/private-image.png",
    storage: "local",
    objectKey: "private-storage-key",
    bytes: 4096,
    sha256: sourceAttachmentDigest,
    state: "verified"
  }, {
    path: "/attachments/removed-image.png",
    storage: "local",
    objectKey: "removed-storage-key",
    bytes: null,
    sha256: null,
    state: "missing_cleanup"
  }];
  const redactionContext = createRedactionContext(sourceMapping, hmacKey, content.markdownText, inventory);
  const repeatedValue = sanitizeMapping({ left: "shared synthetic source", right: "shared synthetic source" }, hmacKey, redactionContext);
  if (repeatedValue.left !== repeatedValue.right) fail("Repeated free-text values did not receive the same account-local redaction");
  const redactedMapping = sanitizeMapping(sourceMapping, hmacKey, redactionContext);
  preserveTechnicalMetadata(
    sourceMapping,
    redactedMapping,
    redactionContext,
    hmacKey,
    compressionApi.estimateHistoricalUserSupplementOutputTokens
  );
  const redactedAccountId = identityToken(hmacKey, "id", "synthetic-account");
  preservePersistenceMetadata(sourceMapping, redactedMapping, redactionContext, hmacKey);
  const redactedInventory = sanitizeMapping(inventory, hmacKey, redactionContext, new Map(), true);
  const redactedAttachmentDigest = String(redactedInventory[0].sha256 || "");
  if (!/^[a-f0-9]{64}$/u.test(redactedAttachmentDigest) || redactedAttachmentDigest === sourceAttachmentDigest) {
    fail("Synthetic attachment digest was not redacted to a distinct lower-case SHA-256 value");
  }
  if (redactedInventory[1].sha256 !== null || redactedInventory[1].state !== "missing_cleanup") {
    fail("Synthetic missing-cleanup inventory null values changed during redaction");
  }
  const databaseOrderVariant = structuredClone(redactedMapping);
  for (const key of ["fields", "objects", "relations", "attachmentRefs", "lifecycles", "idempotency"] as const) {
    databaseOrderVariant[key].reverse();
  }
  assertMappingRoundTrip(redactedMapping, databaseOrderVariant, persistence.canonicalJson);
  const changedPositionVariant = structuredClone(redactedMapping);
  if (!changedPositionVariant.objects.length) fail("Synthetic mapping has no object row for the position comparison");
  changedPositionVariant.objects[0].position = Number(changedPositionVariant.objects[0].position) + 1;
  let positionDifferenceRejected = false;
  try {
    assertMappingRoundTrip(redactedMapping, changedPositionVariant, persistence.canonicalJson);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Redacted objects do not rebuild equivalently")) throw error;
    positionDifferenceRejected = true;
  }
  if (!positionDifferenceRejected) fail("Mapping equivalence accepted a changed object position");
  let redactedStore: JsonRecord;
  try {
    redactedStore = persistence.rebuildStoreObjects(redactedMapping);
  } catch (error) {
    fail(`Synthetic redacted mapping rebuild failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(redactedMapping.objects.map(row => ({ objectKey: row.objectKey, parentKey: row.parentKey, field: row.field, position: row.position })))}`);
  }
  const redactedInspector = (await createClosedInspector(root, redactedAccountId, {}, fixtureClock)).backgroundAi;
  assertMappingRoundTrip(redactedMapping, persistence.mapStoreObjects(redactedAccountId, redactedStore), persistence.canonicalJson);
  preserveMatchingRequestedIntentHashes(store, sourceStates, redactedStore, redactedMapping, redactedInspector, hmacKey);
  const rebuiltRedactedMapping = persistence.mapStoreObjects(redactedAccountId, redactedStore);
  assertMappingRoundTrip(redactedMapping, rebuiltRedactedMapping, persistence.canonicalJson);
  assertInventoryTechnicalState(inventory, redactedInventory, persistence.canonicalJson);
  const redactedRoot = (redactedStore.thoughts as JsonRecord[]).find(item => item.type === "question")!;
  const redactedCapture = (redactedStore.captures as JsonRecord[])[0];
  const redactedAnswer = (redactedStore.thoughts as JsonRecord[]).find(item => item.type === "answer")!;
  const redactedAnnotations = redactedRoot.annotations as JsonRecord[];
  const redactedPermission = (redactedStore.evidencePermissions as JsonRecord[])[0];
  const redactedPermissionSource = JSON.parse(String(redactedPermission.sourceKey)) as string[];
  const redactedEvent = (redactedStore.perceptionEvents as JsonRecord[])[0];
  const redactedEventSource = redactedEvent.sourceRef as JsonRecord;
  const redactedSourceRefs = (redactedStore.evidenceSources as JsonRecord[]).map(item => item.sourceRef as JsonRecord);
  const redactedMessageEventSource = (redactedStore.perceptionEvents as JsonRecord[])[1].sourceRef as JsonRecord;
  const redactedCompression = (redactedStore.recordCompressions as JsonRecord[])[0];
  const consumerNow = fixtureClock.capturedAt;
  assertPersistedStoreConsumerContract(
    redactedStore,
    app.normalizeStore,
    persistedNormalization.normalizePersistedDocument,
    persistenceMetadata.preparePersistenceDocument,
    persistence.mapStoreObjects,
    persistence.rebuildStoreObjects,
    redactedAccountId,
    persistence.canonicalJson,
    consumerNow
  );
  const normalizedSnapshotStore = persistedNormalization.normalizePersistedDocument(redactedStore, app.normalizeStore);
  const normalizedMetadata = normalizedSnapshotStore._persistence as JsonRecord;
  const normalizedSync = normalizedMetadata.sync as JsonRecord;
  const fixtureOperations = normalizedSync.operations as JsonRecord[];
  const fixtureChanges = normalizedSync.changes as JsonRecord[];
  const linkedChange = fixtureChanges.find(change => change.operationId === fixtureOperations[0]?.operationId);
  const sourceOperation = ((((sourceMapping.fields.find(row => row.field === "_persistence")?.payload as JsonRecord)
    .sync as JsonRecord).operations as JsonRecord[])[0]);
  const firstCursor = Number(fixtureOperations[0]?.firstCursor);
  const lastCursor = Number(fixtureOperations[0]?.lastCursor);
  const linkedCursor = Number(linkedChange?.cursor);
  if (fixtureOperations.length !== 1 || !/^[a-f0-9]{64}$/u.test(String(fixtureOperations[0]?.fingerprint || ""))
    || !linkedChange || !["create", "update", "delete", "reorder"].includes(String(linkedChange.changeType))
    || linkedChange.domain !== "onboardingV2"
    || fixtureOperations[0].method !== "PATCH"
    || fixtureOperations[0].resource === "/api/sync/synthetic"
    || fixtureOperations[0].fingerprint === sourceOperation.fingerprint
    || !Number.isSafeInteger(firstCursor)
    || !Number.isSafeInteger(lastCursor)
    || firstCursor > linkedCursor
    || lastCursor < linkedCursor) {
    fail(`Synthetic sync metadata did not preserve a valid operation fingerprint and change identity link; diagnostics=${JSON.stringify({ operationCount: fixtureOperations.length, fingerprintType: typeof fixtureOperations[0]?.fingerprint, fingerprintLength: String(fixtureOperations[0]?.fingerprint || "").length, changeCount: fixtureChanges.length, linkedChange: Boolean(linkedChange), operationIdType: typeof fixtureOperations[0]?.operationId })}`);
  }
  const idempotencyRows = normalizedMetadata.idempotency as JsonRecord[];
  if (idempotencyRows.length !== 1 || !Object.hasOwn(idempotencyRows[0], "response")
    || String(idempotencyRows[0].key).includes("synthetic-idempotency-key")) {
    fail("Synthetic idempotency metadata lost its response or retained its source identity");
  }
  const persistedRedactedMapping = persistence.mapStoreObjects(redactedAccountId, redactedStore);
  for (let index = 0; index < sourceMapping.lifecycles.length; index += 1) {
    const source = sourceMapping.lifecycles[index].payload as JsonRecord;
    const target = persistedRedactedMapping.lifecycles[index];
    const payload = target.payload as JsonRecord;
    const expectedKey = redactionContext.resourceKeys.get(String(source.resourceKey));
    const expectedId = redactionContext.ids.get(String(source.resourceId));
    if (!expectedKey || !expectedId || target.resourceKey !== expectedKey || payload.resourceKey !== expectedKey
      || target.resourceId !== expectedId || payload.resourceId !== expectedId
      || target.resourceType !== payload.resourceType || target.state !== payload.state
      || target.tombstone !== payload.tombstone || persistence.canonicalJson(target.history) !== persistence.canonicalJson(payload.history)) {
      fail("Synthetic lifecycle redaction broke the persisted identity or payload relation");
    }
  }
  for (const item of persistedRedactedMapping.idempotency) {
    const payload = item.payload as JsonRecord;
    if (item.scope !== payload.scope || item.key !== payload.key || item.requestHash !== payload.requestHash
      || persistence.canonicalJson(item.response) !== persistence.canonicalJson(payload.response)
      || item.createdAt !== payload.createdAt || item.expiresAt !== payload.expiresAt) {
      fail("Synthetic idempotency redaction broke the persisted payload relation");
    }
  }
  const sanitizePersistenceFixture = (sourceStore: JsonRecord): JsonRecord => {
    const mapping = persistence.mapStoreObjects("synthetic-account", sourceStore);
    const context = createRedactionContext(mapping, hmacKey, content.markdownText);
    const target = sanitizeMapping(mapping, hmacKey, context);
    preservePersistenceMetadata(mapping, target, context, hmacKey);
    return persistence.rebuildStoreObjects(target);
  };
  const noMetadataRedacted = sanitizePersistenceFixture({ trash: [] });
  if (Object.hasOwn(noMetadataRedacted, "_persistence")) {
    fail("Redaction wrote consumer defaults back into a snapshot without persistence metadata");
  }
  assertPersistedStoreConsumerContract(
    noMetadataRedacted,
    app.normalizeStore,
    persistedNormalization.normalizePersistedDocument,
    persistenceMetadata.preparePersistenceDocument,
    persistence.mapStoreObjects,
    persistence.rebuildStoreObjects,
    redactedAccountId,
    persistence.canonicalJson,
    fixtureClock.capturedAt
  );
  const legacyMetadataRedacted = sanitizePersistenceFixture({
    trash: [],
    _persistence: { lifecycles: [], idempotency: [], sync: { cursor: 0, changes: [] } }
  });
  assertPersistedStoreConsumerContract(
    legacyMetadataRedacted,
    app.normalizeStore,
    persistedNormalization.normalizePersistedDocument,
    persistenceMetadata.preparePersistenceDocument,
    persistence.mapStoreObjects,
    persistence.rebuildStoreObjects,
    redactedAccountId,
    persistence.canonicalJson,
    fixtureClock.capturedAt
  );
  for (const [label, corrupt] of [
    ["changeType", (metadata: JsonRecord) => { ((metadata.sync as JsonRecord).changes as JsonRecord[])[0].changeType = "private invalid value"; }],
    ["fingerprint", (metadata: JsonRecord) => { ((metadata.sync as JsonRecord).operations as JsonRecord[])[0].fingerprint = "private invalid value"; }]
  ] as Array<[string, (metadata: JsonRecord) => void]>) {
    const invalidMapping = structuredClone(sourceMapping);
    const metadataField = invalidMapping.fields.find(row => row.field === "_persistence");
    corrupt(metadataField?.payload as JsonRecord);
    const invalidContext = createRedactionContext(invalidMapping, hmacKey, content.markdownText);
    const invalidTarget = sanitizeMapping(invalidMapping, hmacKey, invalidContext);
    let rejected = false;
    try {
      preservePersistenceMetadata(invalidMapping, invalidTarget, invalidContext, hmacKey);
    } catch {
      rejected = true;
    }
    if (!rejected) fail(`Persistence redaction accepted invalid ${label} metadata`);
  }
  const normalizedSpeechCache = normalizedSnapshotStore.speechCache as JsonRecord[];
  const redactedSpeechCache = redactedStore.speechCache as JsonRecord[];
  const normalizedAnswerCache = normalizedSpeechCache[1];
  const normalizedChainCache = normalizedSpeechCache[2];
  const normalizedAnswerSourceVersions = normalizedAnswerCache.sourceVersions as JsonRecord;
  const normalizedAnswerQuestionVersion = normalizedAnswerSourceVersions.question as JsonRecord;
  const normalizedAnswerAnswerVersion = normalizedAnswerSourceVersions.answer as JsonRecord;
  const normalizedChainSourceVersions = normalizedChainCache.sourceVersions as JsonRecord;
  const normalizedChainQuestionVersion = normalizedChainSourceVersions.question as JsonRecord;
  if (normalizedSpeechCache.length !== redactedSpeechCache.length
    || normalizedSpeechCache.map(entry => entry.sourceType).join(",") !== "capture,thoughtAnswer,thoughtChain"
    || normalizedSpeechCache[0].sourceId !== (redactedStore.captures as JsonRecord[])[0].id
    || normalizedSpeechCache[0].id !== normalizedSpeechCache[0].cacheKey
    || normalizedAnswerCache.id === normalizedAnswerCache.cacheKey
    || normalizedAnswerCache.sourceId !== (redactedStore.thoughts as JsonRecord[]).find(item => item.type === "answer")?.id
    || normalizedAnswerQuestionVersion.id !== (redactedStore.thoughts as JsonRecord[]).find(item => item.type === "question")?.id
    || normalizedAnswerAnswerVersion.id !== normalizedAnswerCache.sourceId
    || normalizedChainCache.sourceId !== (redactedStore.thoughts as JsonRecord[]).find(item => item.type === "question")?.id
    || normalizedChainQuestionVersion.id !== normalizedChainCache.sourceId) {
    fail("Speech-cache redaction changed a supported source type, identity mapping, or source-version reference");
  }
  const unsupportedSpeechCache = structuredClone(redactedStore);
  (unsupportedSpeechCache.speechCache as JsonRecord[])[0].sourceType = "unsupported-source-type";
  let unsupportedSpeechCacheRejected = false;
  try {
    assertPersistedStoreConsumerContract(
      unsupportedSpeechCache,
      app.normalizeStore,
      persistedNormalization.normalizePersistedDocument,
      persistenceMetadata.preparePersistenceDocument,
      persistence.mapStoreObjects,
      persistence.rebuildStoreObjects,
      redactedAccountId,
      persistence.canonicalJson,
      fixtureClock.capturedAt
    );
  } catch (error) {
    if (!(error instanceof Error)
      || !error.message.includes("\"path\":\"speechCache\"")
      || !error.message.includes("\"sourceLength\":3")
      || !error.message.includes("\"normalizedLength\":2")
      || error.message.includes("unsupported-source-type")) throw error;
    unsupportedSpeechCacheRejected = true;
  }
  if (!unsupportedSpeechCacheRejected) fail("Speech-cache normalization must reject unsupported source types without exposing values");
  const normalizedCompression = (normalizedSnapshotStore.recordCompressions as JsonRecord[])[0];
  const normalizedSupplement = normalizedSnapshotStore.historicalUserSupplement as JsonRecord;
  const normalizedSupplementTokens = (normalizedSupplement.tokenUsage as JsonRecord).tokens;
  const normalizedEventCount = (normalizedSnapshotStore.perceptionEvents as JsonRecord[]).length;
  const normalizedEvidenceSourceCount = (normalizedSnapshotStore.evidenceSources as JsonRecord[]).length;
  const sourceEvents = store.perceptionEvents as JsonRecord[];
  const normalizedEvents = normalizedSnapshotStore.perceptionEvents as JsonRecord[];
  const normalizedManifestSource = (normalizedCompression.sourceManifest as JsonRecord[])[0];
  const normalizedReferenceSource = (normalizedCompression.sourceRefs as JsonRecord[])[0];
  const normalizedDerivedDigest = (((normalizedSnapshotStore.evidenceSources as JsonRecord[])[0].derivedFrom as JsonRecord[])[0]).contentSha256;
  if ((normalizedSnapshotStore.perceptionEvents as JsonRecord[]).length !== (redactedStore.perceptionEvents as JsonRecord[]).length
    || normalizedEventCount !== 2
    || normalizedEvidenceSourceCount !== 4
    || !/^[a-f0-9]{64}$/u.test(String(normalizedDerivedDigest))
    || !/^[a-f0-9]{64}$/u.test(String(redactedEvent.contentSha256))
    || normalizedCompression.status !== "ready"
    || normalizedCompression.sourceManifestHash !== redactedCompression.sourceManifestHash
    || !/^[a-f0-9]{64}$/u.test(String(normalizedCompression.sourceManifestHash))
    || normalizedCompression.sourceManifestHash === compressionManifestDigest
    || (normalizedCompression.window as JsonRecord).start !== "2026-10-10T16:00:00.000Z"
    || (normalizedCompression.window as JsonRecord).endExclusive !== "2026-10-11T16:00:00.000Z"
    || (normalizedCompression.window as JsonRecord).completeness !== "complete"
    || normalizedManifestSource.sourceHash !== redactedAttachmentDigest
    || normalizedReferenceSource.sourceHash !== redactedAttachmentDigest
    || (normalizedSupplement.records as JsonRecord[]).length !== 2
    || (normalizedSupplement.tokenUsage as JsonRecord).scope !== "model_output"
    || Number(normalizedSupplementTokens) > compressionApi.HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET
    || normalizedSupplementTokens !== compressionApi.estimateHistoricalUserSupplementOutputTokens(normalizedSupplement.records as JsonRecord[])) {
    fail("Real persisted-store normalization discarded strict technical metadata or downgraded sanitized records");
  }
  const normalizedSupplementRecords = normalizedSupplement.records as JsonRecord[];
  const normalizedThoughtSource = (normalizedSnapshotStore.thoughts as JsonRecord[]).find(item => item.type === "question")!;
  const normalizedChatSource = (normalizedSnapshotStore.chats as JsonRecord[])[0];
  if (!String(normalizedThoughtSource.content).includes(String(normalizedSupplementRecords[0].exactQuote))
    || !String(normalizedChatSource.message).includes(String(normalizedSupplementRecords[1].exactQuote))
    || normalizedThoughtSource.sourceId !== (normalizedSupplementRecords[0].source as JsonRecord).sourceId
    || normalizedChatSource.sourceId !== (normalizedSupplementRecords[1].source as JsonRecord).sourceId) {
    fail("Historical source IDs or exact-quote membership no longer match their sanitized source records");
  }
  const normalizedTechnicalDigest = String(normalizedReferenceSource.sourceHash);
  if (normalizedTechnicalDigest !== redactedEvent.contentSha256
    || normalizedTechnicalDigest !== redactedAttachmentDigest
    || normalizedTechnicalDigest !== normalizedDerivedDigest
    || !/^[a-f0-9]{64}$/u.test(normalizedTechnicalDigest)) {
    fail("Equal source digests did not retain one equivalent lower-case SHA-256 redaction");
  }
  sourceEvents.forEach((sourceEvent, index) => {
    const normalizedEvent = normalizedEvents[index];
    if (!normalizedEvent
      || !/^[a-f0-9]{64}$/u.test(String(normalizedEvent.contentSha256))
      || normalizedEvent.contentSha256 === sourceEvent.contentSha256) {
      fail("A perception-event digest was not independently redacted to its strict SHA-256 shape");
    }
  });
  const annotationSourceCases = [
    { resourceType: "thought", collection: "thoughts", targetKey: `question:${(store.thoughts as JsonRecord[])[0].id}` },
    { resourceType: "chat", collection: "chats", targetKey: "answer" },
    { resourceType: "book", collection: "books", targetKey: "description" }
  ];
  const sourceTexts: Array<{ source: string; redactedSource: string }> = [];
  const redactedQuotes = new Map<string, string>();
  const allQuotes: string[] = [];
  for (const sourceCase of annotationSourceCases) {
    const sourceRoot = (store[sourceCase.collection] as JsonRecord[])[0];
    const redactedRoot = (redactedStore[sourceCase.collection] as JsonRecord[])[0];
    const source = annotationResources.annotationResourceSource(store, sourceCase.resourceType, sourceRoot, sourceCase.targetKey);
    const sourceRouteAnnotations = sourceRoot.annotations as JsonRecord[];
    const redactedRouteAnnotations = redactedRoot.annotations as JsonRecord[];
    const sourceAnnotationIndex = sourceRouteAnnotations.findIndex(item => item.targetKey === sourceCase.targetKey);
    if (sourceAnnotationIndex < 0) fail("Synthetic annotation source fixture is missing its requested target key");
    const redactedTargetKey = String((redactedRouteAnnotations[sourceAnnotationIndex] || {}).targetKey || "");
    if ((sourceCase.resourceType === "chat" || sourceCase.resourceType === "book")
      && redactedTargetKey !== sourceCase.targetKey) {
      fail("Supported chat/book annotation source literal changed during redaction");
    }
    const redactedSource = annotationResources.annotationResourceSource(redactedStore, sourceCase.resourceType, redactedRoot, redactedTargetKey);
    sourceTexts.push({ source, redactedSource });
    const sourceAnnotations = sourceRoot.annotations as JsonRecord[];
    const redactedAnnotations = redactedRoot.annotations as JsonRecord[];
    if (sourceAnnotations.length !== redactedAnnotations.length) fail("Synthetic annotation source lost an annotation during redaction");
    for (let index = 0; index < sourceAnnotations.length; index += 1) {
      const quote = String(sourceAnnotations[index].quote ?? "");
      const redactedQuote = String(redactedAnnotations[index].quote ?? "");
      if (redactedQuote && !/^[A-Za-z0-9]+$/u.test(redactedQuote)) fail("Synthetic quote placeholder contains Markdown syntax");
      redactedQuotes.set(quote, redactedQuote);
      allQuotes.push(quote);
    }
  }
  for (const { source, redactedSource } of sourceTexts) {
    if (content.markdownText(redactedSource) !== redactedSource) fail("Markdown processing changed a synthetic redacted source placeholder");
    for (const quote of allQuotes) {
      const redactedQuote = redactedQuotes.get(quote);
      if (typeof redactedQuote !== "string" || source.includes(quote) !== redactedSource.includes(redactedQuote)) {
        fail("Synthetic source/quote inclusion semantics changed after redaction");
      }
    }
  }
  const permissionLifecycle = (redactedMapping.lifecycles as JsonRecord[]).find(item => (
    item.resourceType === "evidencePermission" && item.resourceId === redactedPermission.sourceKey
  ));
  if (!permissionLifecycle
    || permissionLifecycle.resourceId !== redactedPermission.sourceKey
    || permissionLifecycle.resourceKey !== `evidencePermission:${redactedPermission.sourceKey}`
    || redactedPermissionSource[3] !== `question:${redactedRoot.id}`
    || redactedEventSource.targetKey !== `question:${redactedRoot.id}`
    || redactedEventSource.resourceId !== redactedRoot.id
    || redactedEventSource.rootId !== redactedRoot.id) {
    fail("Evidence permission source tuple and lifecycle identities were not redacted consistently");
  }
  if (redactedSourceRefs[0].targetKey !== redactedAnnotations[1].targetKey
    || redactedMessageEventSource.targetKey !== redactedAnnotations[1].targetKey
    || redactedSourceRefs[1].targetKey !== redactedAnnotations[2].targetKey
    || redactedSourceRefs[2].targetKey !== redactedAnnotations[3].targetKey
    || redactedSourceRefs[3].targetKey !== redactedAnnotations[4].targetKey
    || redactedAnnotations[0].targetKey !== "content"
    || redactedAnnotations[1].targetKey !== "message"
    || redactedAnnotations[2].targetKey === noteTargetKey
    || !String(redactedAnnotations[2].targetKey).startsWith("note:")
    || redactedAnnotations[3].targetKey === reflectionTargetKey
    || !String(redactedAnnotations[3].targetKey).startsWith("reflection:")
    || redactedAnnotations[4].targetKey !== transcriptionTargetKey
    || redactedAnnotations[5].targetKey === "private-custom-target") {
    fail("Semantic source and ordinary payload target keys were not pseudonymized consistently");
  }
  const redactedInspection = redactedInspector.inspectRecoveryIntent(redactedStore, (redactedStore.aiTasks as JsonRecord[])[0]);
  const redactedAnnotationInspection = redactedInspector.inspectRecoveryIntent(
    redactedStore,
    (redactedStore.aiTasks as JsonRecord[]).find(item => item.kind === "annotationShenji")!
  );
  if (redactedRoot.id !== redactedAnswer.relatedTo
    || redactedCapture.id !== redactedRoot.sourceCaptureId
    || redactedCapture.id !== (redactedRoot.sourceRef as JsonRecord).id
    || (redactedRoot.sourceRef as JsonRecord).targetKey !== ""
    || redactedInspection.intentMatch !== "matched"
    || redactedAnnotationInspection.intentMatch !== "matched"
    || redactedInspection.target?.exists !== true
    || redactedInspection.target.subtargetExists !== true) {
    fail("Redaction broke a shared source/reference identity or waiting-task target");
  }
  if (redactedRoot.recordTimezone !== "Asia/Shanghai"
    || redactedRoot.contextGeneratedAt !== "2026-10-11T18:30:00.000Z"
    || redactedRoot.inputAsOf !== "2026-10-11T18:30:00.000Z"
    || typeof redactedRoot.sourceType !== "string"
    || SPEECH_CACHE_SOURCE_TYPES.has(redactedRoot.sourceType)
    || !Object.hasOwn(redactedStore, "onboardingV2")) {
    fail("Redaction changed timezone, technical timestamps, singleton structure, or globally preserved a user sourceType field");
  }
  const graphChecks = {
    thoughtRoot: rebuiltRedactedMapping.relations.some(item => item.relation === "thoughtRoot" && item.resolution === "live"),
    source: rebuiltRedactedMapping.relations.some(item => item.relation === "source" && item.resolution === "live"),
    historical: rebuiltRedactedMapping.relations.some(item => item.targetKey === null && item.resolution === "historical"),
    compositeTarget: rebuiltRedactedMapping.relations.some(item => typeof item.targetKey === "string" && Array.isArray(JSON.parse(item.targetKey))),
    attachmentRefs: rebuiltRedactedMapping.attachmentRefs.length > 0
  };
  if (Object.values(graphChecks).some(value => !value)) {
    fail(`Rebuilt relationship graph lost a root/source edge or attachment reference; checks=${JSON.stringify(graphChecks)}`);
  }
  const matchedAfter = redactedInspector.inspectRecoveryIntent(redactedStore, (redactedStore.aiTasks as JsonRecord[])[0]);
  const afterStates = taskStates(redactedStore, redactedInspector, hmacKey, true);
  assertSameTaskSemantics(sourceStates, afterStates);
  const diagnosticProbe = structuredClone(afterStates);
  diagnosticProbe[0].targetExists = !diagnosticProbe[0].targetExists;
  try {
    assertSameTaskSemantics(afterStates, diagnosticProbe);
    fail("Task semantic diagnostic probe did not detect a changed safe field");
  } catch (error) {
    if (!(error instanceof Error)
      || !error.message.includes("targetExists")
      || ["task-private-id", "annotation-task-private-id", "inputHash", "private question phrase"].some(secret => error.message.includes(secret))) {
      throw error;
    }
  }
  if (matchedAfter.intentMatch !== "matched") fail("Redacted task intent did not retain its original matching result");
  const secretText = JSON.stringify({ redactedStore, redactedMapping, redactedInventory });
  if (secretText.includes(sourceAttachmentDigest)) fail("Synthetic redaction retained the source attachment digest");
  if ([
    "private question phrase", "private question", "private answer phrase", "private follow-up", "private singleton answer",
    "chat answer body", "description details", "drifted private quote", "private comment",
    "private-image", "private-capture", "private-storage-key", "thought-private-root",
    "chat-private-id", "note-private-id", "reflection-private-id", "private-custom-target",
    "private content quote", "private content comment", "private message quote", "private message comment",
    "private note quote", "private note comment", "private reflection quote", "private reflection comment",
    "private transcription quote", "private transcription comment",
    "private custom quote", "private custom comment", "private chat message", "stable1", "stable2", "id-a", "id-b"
  ]
    .some(secret => secretText.includes(secret))) fail("Synthetic redaction retained a private fixture value");
  const emptyCleanupStore = persistence.rebuildStoreObjects(persistence.mapStoreObjects("empty-cleanup-account", app.normalizeStore({})));
  const emptyCleanupSnapshot = {
    accounts: [{ accountId: "empty-cleanup-account", mapping: persistence.mapStoreObjects("empty-cleanup-account", emptyCleanupStore) }]
  };
  const emptyCleanupIsVerified = await snapshotHasNoPendingAttachmentCleanup(root, emptyCleanupSnapshot);
  if (!emptyCleanupIsVerified) fail("A valid empty attachment-cleanup snapshot was not recognized");
  const emptyCleanupCounts: Record<string, number> = {};
  const emptyCleanupObserver = createStartupEffectObserver(emptyCleanupIsVerified, true, emptyCleanupCounts);
  emptyCleanupObserver("media", "resumeAttachmentCleanup");
  if (emptyCleanupCounts.emptyCleanupResumeCalls !== 1 || emptyCleanupCounts.media) {
    fail("Verified empty attachment-cleanup recovery call was not classified separately");
  }

  const cleanupFunction = await importFromRoot<{
    createAttachmentCleanup(options: JsonRecord): { resume(): Promise<unknown> };
  }>(root, "src/app/attachment-cleanup.mjs");
  const cleanupBranchCounts = { transactions: 0, commits: 0, removes: 0, results: 0, dispatches: 0 };
  const emptyCleanupRuntime = cleanupFunction.createAttachmentCleanup({
    repository: {
      async transact(operation: (context: { document: JsonRecord; commit(): Promise<void> }) => Promise<unknown>) {
        cleanupBranchCounts.transactions += 1;
        return operation({ document: { attachmentCleanup: [] }, async commit() { cleanupBranchCounts.commits += 1; } });
      }
    },
    async remove() { cleanupBranchCounts.removes += 1; },
    now: () => "2026-10-13T00:00:00.000Z",
    contextKey: () => "empty-cleanup-account",
    dispatch() { cleanupBranchCounts.dispatches += 1; return null; },
    onRetryFailure() {},
    async onResult() { cleanupBranchCounts.results += 1; }
  });
  await emptyCleanupRuntime.resume();
  if (cleanupBranchCounts.transactions !== 1
    || cleanupBranchCounts.commits !== 0
    || cleanupBranchCounts.removes !== 0
    || cleanupBranchCounts.results !== 0
    || cleanupBranchCounts.dispatches !== 0) {
    fail("The real empty attachment-cleanup resume branch performed a write, removal, result callback, or dispatch");
  }

  const queuedCleanupStore = structuredClone(emptyCleanupStore);
  queuedCleanupStore.attachmentCleanup = [{ path: "/attachments/pending" }];
  const queuedCleanupSnapshot = {
    accounts: [
      { accountId: "empty-cleanup-account", mapping: persistence.mapStoreObjects("empty-cleanup-account", emptyCleanupStore) },
      { accountId: "queued-cleanup-account", mapping: persistence.mapStoreObjects("queued-cleanup-account", queuedCleanupStore) }
    ]
  };
  const queuedCleanupIsVerified = await snapshotHasNoPendingAttachmentCleanup(root, queuedCleanupSnapshot);
  if (queuedCleanupIsVerified) fail("A non-empty attachment-cleanup queue was marked safe");
  const inventoryReadCounts: Record<string, number> = {};
  createStartupEffectObserver(queuedCleanupIsVerified, true, inventoryReadCounts)("media", "listAttachmentInventory");
  if (inventoryReadCounts.postgresAttachmentInventoryReads !== 1 || inventoryReadCounts.media) {
    fail("The isolated PostgreSQL attachment-inventory read was not classified separately");
  }
  const isolatedGateUrls = {
    data: "postgresql://runtime_data:secret@127.0.0.1:54321/startup_gate",
    auth: "postgresql://runtime_auth:secret@127.0.0.1:54321/startup_gate",
    budget: "postgresql://runtime_budget:secret@127.0.0.1:54321/startup_gate"
  };
  if (!usesOnlyIsolatedPostgres(isolatedGateUrls, 54321)
    || usesOnlyIsolatedPostgres({ ...isolatedGateUrls, data: "postgresql://runtime_data:secret@db.example:54321/startup_gate" }, 54321)
    || usesOnlyIsolatedPostgres({ ...isolatedGateUrls, budget: "postgresql://runtime_budget:secret@127.0.0.1:54322/startup_gate" }, 54321)) {
    fail("Attachment-inventory read boundary did not require all three expected loopback PostgreSQL databases");
  }
  const nonPostgresInventoryCounts: Record<string, number> = {};
  for (const [observer, kind, operation] of [
    [emptyCleanupObserver, "media", "materializeAttachmentFiles"],
    [emptyCleanupObserver, "provider", "deepseek"],
    [emptyCleanupObserver, "outbound", "debug"],
    [createStartupEffectObserver(emptyCleanupIsVerified, false, nonPostgresInventoryCounts), "media", "listAttachmentInventory"],
    [createStartupEffectObserver(false, true, {}), "media", "resumeAttachmentCleanup"],
    [createStartupEffectObserver(queuedCleanupIsVerified, true, {}), "media", "resumeAttachmentCleanup"],
    [createStartupEffectObserver(await snapshotHasNoPendingAttachmentCleanup(root, { accounts: [{ accountId: "malformed-account", mapping: {} }] }), true, {}), "media", "resumeAttachmentCleanup"]
  ] as const) {
    try {
      observer(kind, operation);
      fail(`Startup gate observer allowed ${kind}:${operation} without its required operation-specific boundary`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(`Startup gate blocked ${kind}:${operation}`)) throw error;
    }
  }
  try {
    await runtime.materializeAttachmentFiles?.([]);
    fail("Synthetic media guard did not reject an attempted media operation");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Startup gate blocked media:")) throw error;
  }
  try {
    inspector.schedule("synthetic-task");
    fail("Synthetic dispatch guard did not reject an attempted background dispatch");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Startup gate blocked dispatch:")) throw error;
  }
  if (counts.media !== 1 || counts.dispatch !== 1) fail("Synthetic effect guards did not record blocked media/dispatch attempts");
  counts.media = 0;
  counts.dispatch = 0;
  if (Object.values(counts).some(value => value !== 0)) fail("Inspector construction performed an external or repository effect");
  // 真实 mapper 会把问答任务和证据关系指向结构单例；普通同名实体不是单例。
  const singletonStore: JsonRecord = {
    onboardingV2: { session: { id: "onboarding-v2", revision: 1 } },
    thoughts: [{ id: "onboardingV2", type: "question", content: "onboardingV2", version: 1 }],
    aiTasks: [{ id: "singleton-task", kind: "onboardingClaimExtraction",
      resourceType: "onboardingV2", targetId: "onboarding-v2", status: "failed" },
    { id: "ordinary-task", kind: "thoughtAnswer", resourceType: "thought",
      targetId: "onboardingV2", status: "failed" }],
    userClaims: [{ id: "singleton-claim", evidence: [{ sourceType: "onboardingV2Answer" }],
      extension: { sourceType: "onboardingV2Answer", targetId: "onboardingV2" } }]
  };
  const singletonMapping = persistence.mapStoreObjects("synthetic-singleton-account", singletonStore);
  const singletonContext = createRedactionContext(singletonMapping, hmacKey, content.markdownText);
  const sanitizedSingleton = sanitizeMapping(singletonMapping, hmacKey, singletonContext);
  preserveTechnicalMetadata(singletonMapping, sanitizedSingleton, singletonContext, hmacKey,
    compressionApi.estimateHistoricalUserSupplementOutputTokens);
  const singletonRebuilt = persistence.rebuildStoreObjects(sanitizedSingleton);
  const singletonAccount = String(sanitizedSingleton.fields[0].accountId);
  assertMappingRoundTrip(sanitizedSingleton,
    persistence.mapStoreObjects(singletonAccount, singletonRebuilt), persistence.canonicalJson);
  const singletonRelations = sanitizedSingleton.relations.filter(row => row.targetCollection === "onboardingV2");
  if (singletonRelations.length !== 2
    || !singletonRelations.some(row => row.relation === "target")
    || !singletonRelations.some(row => row.relation === "evidence:0")
    || singletonRelations.some(row => row.targetId !== "onboardingV2"
      || row.targetKey !== JSON.stringify(["onboardingV2"]))) {
    fail("Resolved singleton task and evidence relations lost structural target identity");
  }
  const ordinaryRelation = sanitizedSingleton.relations.find(row => row.targetCollection === "thoughts");
  const ordinaryThought = (singletonRebuilt.thoughts as JsonRecord[])[0];
  if (!ordinaryRelation || ordinaryRelation.targetId === "onboardingV2"
    || ordinaryThought.id === "onboardingV2" || ordinaryThought.content === "onboardingV2") {
    fail("Same-name ordinary entity, relation or free text escaped redaction");
  }
  const claimExtension = ((singletonRebuilt.userClaims as JsonRecord[])[0].extension as JsonRecord);
  if (claimExtension.sourceType === "onboardingV2Answer" || claimExtension.targetId === "onboardingV2") {
    fail("Same-name user extension escaped scoped technical metadata redaction");
  }
  const falseSingletonRelation = { relations: [{ relation: "target", resolution: "historical",
    targetCollection: "onboardingV2", targetId: "onboardingV2", targetKey: null }] };
  const sanitizedHistorical = sanitizeMapping(falseSingletonRelation, hmacKey, singletonContext);
  if (sanitizedHistorical.relations[0].targetId === "onboardingV2") {
    fail("Unresolved same-name relation incorrectly retained singleton identity");
  }
  // 完整五问链使用真实schema/normalizer与mapper，不以默认回退替代源状态。
  const onboardingApi = await importFromRoot<OnboardingV2Api>(root, "src/modules/onboarding/index.mjs");
  const onboardingModel = await loadOnboardingModelApi(root);
  const technicalStore: JsonRecord = {
    onboardingV2: onboardingApi.normalizeOnboardingV2({
      session: { id: "onboarding-v2", status: "completed", step: "candidates", revision: 3,
        answers: {
          currentContext: { rawText: "v2", version: 1 },
          desiredChanges: { structuredValue: [{ text: "usable", horizon: "6m" }], version: 1 },
          recentObstacles: { answerDisposition: "unknown", version: 1 },
          dailyRhythm: { answerDisposition: "declined", version: 1 }
        },
        collaboration: {
          responseLength: { value: "expanded", source: "user" },
          suggestionMode: { value: "reasonFirst", source: "user" },
          challengeStyle: { value: "direct", source: "user" }
        }
      }, migration: { selectedFlow: "v2" }
    }),
    aiTasks: [{ id: "v2-task", kind: "onboardingClaimExtraction", resourceType: "onboardingV2",
      targetId: "onboarding-v2", status: "failed", payload: { targetId: "onboarding-v2" } }],
    userClaims: [{ id: "v2-claim", evidence: [{ sourceType: "onboardingV2Answer", sourceId: "dailyRhythm" }],
      extension: { sourceId: "dailyRhythm", targetId: "onboarding-v2" } }],
    evidencePermissions: [{ schemaVersion: 1, accountId: "v2-account",
      sourceKey: JSON.stringify(["onboardingV2", "currentContext", "", "answer:currentContext"]),
      revision: 1, contextAllowed: false, learningAllowed: false, updatedAt: fixtureClock.capturedAt,
      extension: { sourceId: "currentContext" } }]
  };
  (technicalStore.onboardingV2 as JsonRecord).extension = { step: "candidates", status: "completed", source: "user", readiness: "usable" };
  Object.assign(technicalStore, persistenceMetadata.preparePersistenceDocument(technicalStore, () => fixtureClock.capturedAt));
  const redactV2 = (store: JsonRecord, repair = true) => {
    const mapping = persistence.mapStoreObjects("v2-account", store);
    const context = createRedactionContext(mapping, hmacKey, content.markdownText);
    const sanitized = sanitizeMapping(mapping, hmacKey, context);
    preserveTechnicalMetadata(mapping, sanitized, context, hmacKey, compressionApi.estimateHistoricalUserSupplementOutputTokens);
    preservePersistenceMetadata(mapping, sanitized, context, hmacKey);
    if (repair) {
      preserveOnboardingTechnicalMetadata(mapping, sanitized, onboardingApi, hmacKey);
      preserveOnboardingReferences(mapping, sanitized, onboardingApi);
    }
    const rebuilt = persistence.rebuildStoreObjects(sanitized);
    if (repair) preserveOnboardingDerivedReferences(store, rebuilt, sanitized, onboardingApi, onboardingModel);
    assertMappingRoundTrip(sanitized,
      persistence.mapStoreObjects(String(sanitized.fields[0].accountId), rebuilt), persistence.canonicalJson);
    return rebuilt;
  };
  const expectOnboardingFailure = (operation: () => void, fragment: string) => {
    try { operation(); } catch (error) {
      if (error instanceof Error && error.message.includes(fragment)) return;
      throw error;
    }
    fail("Onboarding self-test accepted a changed consumer contract");
  };
  expectOnboardingFailure(() => assertOnboardingTechnicalSemantics(technicalStore, redactV2(technicalStore, false),
    onboardingApi, persistence.canonicalJson), "Unsupported onboarding technical value");
  const repairedV2 = redactV2(technicalStore);
  assertOnboardingTechnicalSemantics(technicalStore, repairedV2, onboardingApi, persistence.canonicalJson);
  assertOnboardingModelConsumers(technicalStore, repairedV2, onboardingApi, onboardingModel, persistence.canonicalJson);
  const repairedSession = (repairedV2.onboardingV2 as JsonRecord).session as JsonRecord;
  const repairedAnswers = repairedSession.answers as Record<string, JsonRecord>;
  const repairedExtension = (repairedV2.onboardingV2 as JsonRecord).extension as JsonRecord;
  if (repairedAnswers.currentContext.rawText === "v2"
    || (repairedAnswers.desiredChanges.structuredValue as JsonRecord[])[0].text === "usable"
    || Object.values(repairedExtension).some(value => ["candidates", "completed", "user", "usable"].includes(String(value)))
    || ((repairedV2.aiTasks as JsonRecord[])[0].payload as JsonRecord).targetId === "onboarding-v2"
    || ((repairedV2.userClaims as JsonRecord[])[0].extension as JsonRecord).sourceId === "dailyRhythm"
    || ((repairedV2.evidencePermissions as JsonRecord[])[0].extension as JsonRecord).sourceId === "currentContext") {
    fail("Fixed onboarding identities escaped into user text, extensions or unrelated task payload");
  }
  for (const step of onboardingApi.onboardingV2Schema.steps) {
    const variant = structuredClone(technicalStore);
    ((variant.onboardingV2 as JsonRecord).session as JsonRecord).step = step;
    assertOnboardingTechnicalSemantics(variant, redactV2(variant), onboardingApi, persistence.canonicalJson);
  }
  for (const question of onboardingApi.onboardingV2Schema.questions) {
    for (const [axis, definition] of Object.entries(question.axes || {})) {
      for (const value of definition.values) {
        const variant = structuredClone(technicalStore);
        const session = (variant.onboardingV2 as JsonRecord).session as JsonRecord;
        (session.collaboration as JsonRecord)[axis] = { value, source: "user" };
        assertOnboardingTechnicalSemantics(variant, redactV2(variant), onboardingApi, persistence.canonicalJson);
      }
    }
    for (const horizon of question.horizons || []) {
      const variant = structuredClone(technicalStore);
      const session = (variant.onboardingV2 as JsonRecord).session as JsonRecord;
      const answer = (session.answers as Record<string, JsonRecord>)[question.questionId];
      answer.structuredValue = [{ text: "private horizon goal", horizon, ...(horizon === "custom" ? { horizonText: "自己选择😀" } : {}) }];
      assertOnboardingTechnicalSemantics(variant, redactV2(variant), onboardingApi, persistence.canonicalJson);
      assertOnboardingModelConsumers(variant, redactV2(variant), onboardingApi, onboardingModel, persistence.canonicalJson);
    }
  }
  for (const selectedFlow of ["undecided", "legacy", "v2"]) {
    const variant = structuredClone(technicalStore);
    variant.onboarding = { status: "completed", answers: {}, understanding: "private legacy model" };
    variant.onboardingV2 = onboardingApi.normalizeOnboardingV2({ migration: { selectedFlow } }, variant.onboarding);
    const rebuilt = redactV2(variant);
    assertOnboardingTechnicalSemantics(variant, rebuilt, onboardingApi, persistence.canonicalJson);
    assertOnboardingModelConsumers(variant, rebuilt, onboardingApi, onboardingModel, persistence.canonicalJson);
  }
  const invalidV2 = structuredClone(technicalStore);
  ((invalidV2.onboardingV2 as JsonRecord).session as JsonRecord).step = "private-unsupported-step";
  expectOnboardingFailure(() => assertOnboardingTechnicalSemantics(invalidV2, redactV2(invalidV2),
    onboardingApi, persistence.canonicalJson), "Unsupported onboarding technical value at session.step");
  const inconsistentV2 = structuredClone(technicalStore);
  (inconsistentV2.onboardingV2 as JsonRecord).readiness = "empty";
  expectOnboardingFailure(() => assertOnboardingTechnicalSemantics(inconsistentV2, redactV2(inconsistentV2),
    onboardingApi, persistence.canonicalJson), "consumer changed technical value at readiness");
  // 真实正文派生任务哈希与引文有效性必须显式暴露失真，不通过normalize制造PASS。
  const matchedV2 = structuredClone(technicalStore);
  (matchedV2.aiTasks as JsonRecord[])[0].inputHash = onboardingModel.prepareUserModelExtraction(matchedV2).value?.inputHash;
  const matchedRebuilt = redactV2(matchedV2);
  assertOnboardingModelConsumers(matchedV2, matchedRebuilt, onboardingApi, onboardingModel, persistence.canonicalJson);
  (matchedRebuilt.aiTasks as JsonRecord[])[0].inputHash = "deliberately-broken";
  expectOnboardingFailure(() => assertOnboardingModelConsumers(matchedV2, matchedRebuilt,
    onboardingApi, onboardingModel, persistence.canonicalJson), "task source match changed at inputHash");
  const evidencedV2 = structuredClone(technicalStore);
  const entry = onboardingApi.onboardingV2ContextEntries(evidencedV2.onboardingV2).find(item => item.id === "dailyRhythm")!;
  const evidence = ((evidencedV2.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0];
  evidence.sourceVersion = entry.version;
  evidence.contentSha256 = createHash("sha256").update(String(entry.text)).digest("hex");
  evidence.span = [0, 1];
  if (!onboardingModel.userModelEvidenceCurrent(evidencedV2, evidence)) fail("Synthetic onboarding evidence is not current at source");
  const evidencedRebuilt = redactV2(evidencedV2);
  assertOnboardingModelConsumers(evidencedV2, evidencedRebuilt, onboardingApi, onboardingModel, persistence.canonicalJson);
  ((evidencedRebuilt.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0].span = [0, 99999];
  expectOnboardingFailure(() => assertOnboardingModelConsumers(evidencedV2, evidencedRebuilt,
    onboardingApi, onboardingModel, persistence.canonicalJson), "evidence consumer changed");
  const unicodeV2 = structuredClone(technicalStore);
  const unicodeState = unicodeV2.onboardingV2 as JsonRecord;
  const unicodeSession = unicodeState.session as JsonRecord;
  (unicodeSession.answers as Record<string, JsonRecord>).dailyRhythm = {
    questionId: "dailyRhythm", rawText: "长文本😀".repeat(35), version: 2, contextAllowed: true
  };
  unicodeV2.onboardingV2 = onboardingApi.normalizeOnboardingV2(unicodeState);
  const unicodeEntry = onboardingApi.onboardingV2ContextEntries(unicodeV2.onboardingV2).find(item => item.id === "dailyRhythm")!;
  const unicodeEvidence = ((unicodeV2.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0];
  unicodeEvidence.sourceVersion = unicodeEntry.version;
  unicodeEvidence.contentSha256 = createHash("sha256").update(String(unicodeEntry.text)).digest("hex");
  unicodeEvidence.span = [2, String(unicodeEntry.text).length];
  const sourceHash = onboardingModel.prepareUserModelExtraction(unicodeV2).value!.inputHash;
  const unicodeTask = (unicodeV2.aiTasks as JsonRecord[])[0];
  unicodeTask.inputHash = sourceHash;
  unicodeTask.requestedInputHash = sourceHash;
  unicodeTask.requestedIntentInputHash = sourceHash;
  const unicodeRebuilt = redactV2(unicodeV2);
  assertOnboardingTechnicalSemantics(unicodeV2, unicodeRebuilt, onboardingApi, persistence.canonicalJson);
  assertOnboardingModelConsumers(unicodeV2, unicodeRebuilt, onboardingApi, onboardingModel, persistence.canonicalJson);
  const v2Inspector = (await createClosedInspector(root, "v2-account", {}, fixtureClock)).backgroundAi;
  assertSameTaskSemantics(taskStates(unicodeV2, v2Inspector, hmacKey),
    taskStates(unicodeRebuilt, v2Inspector, hmacKey, true));
  const rebuiltEvidence = ((unicodeRebuilt.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0];
  if (persistence.canonicalJson(unicodeEvidence.span) !== persistence.canonicalJson(rebuiltEvidence.span)
    || rebuiltEvidence.contentSha256 === unicodeEvidence.contentSha256) fail("Unicode evidence span or source digest was not faithfully redacted");
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled", "stale"]) {
    const variant = structuredClone(unicodeV2);
    (variant.aiTasks as JsonRecord[])[0].status = status;
    assertOnboardingModelConsumers(variant, redactV2(variant), onboardingApi, onboardingModel, persistence.canonicalJson);
  }
  const staleV2 = structuredClone(unicodeV2);
  const staleTask = (staleV2.aiTasks as JsonRecord[])[0];
  for (const field of ["inputHash", "requestedInputHash", "requestedIntentInputHash"]) staleTask[field] = "0".repeat(64);
  const staleEvidence = ((staleV2.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0];
  staleEvidence.contentSha256 = "0".repeat(64);
  const staleRebuilt = redactV2(staleV2);
  assertOnboardingModelConsumers(staleV2, staleRebuilt, onboardingApi, onboardingModel, persistence.canonicalJson);
  if (onboardingModel.userModelEvidenceCurrent(staleRebuilt,
    ((staleRebuilt.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0])) {
    fail("Stale onboarding evidence was incorrectly reactivated");
  }
  const invalidSpanV2 = structuredClone(unicodeV2);
  ((invalidSpanV2.userClaims as JsonRecord[])[0].evidence as JsonRecord[])[0].span = [0, 99999];
  assertOnboardingModelConsumers(invalidSpanV2, redactV2(invalidSpanV2), onboardingApi, onboardingModel, persistence.canonicalJson);
  // 真实capture audio经mapper→脱敏→重建→normalizer→公开消费者，不触碰任意扩展。
  const captureApi = await importFromRoot<CaptureAudioApi>(root, "src/modules/captures/index.mjs");
  const captureAudioStore: JsonRecord = {
    captures: [{ id: "capture-audio-private", version: 1, content: "audio/mp4", audio: {
      attachmentPath: "/attachments/private-voice.m4a", mimeType: "audio/mp4", bytes: 4096, durationMs: 1250,
      asrAttachmentPath: "/attachments/private-voice.asr.wav", asrMimeType: "audio/wav", asrBytes: 40044,
      extension: { mimeType: "audio/mp4", asrMimeType: "audio/wav", durationMs: "1250" }
    }, extension: { audio: { mimeType: "audio/mp4", asrMimeType: "audio/wav" } } }],
    thoughts: [{ id: "same-name-extension", type: "question", version: 1, content: "audio/mp4", audio: { mimeType: "audio/mp4" } }]
  };
  const redactCaptureAudio = (original: JsonRecord, repair = true) => {
    const mapping = persistence.mapStoreObjects("audio-fixture-account", original);
    const context = createRedactionContext(mapping, hmacKey, content.markdownText);
    const sanitized = sanitizeMapping(mapping, hmacKey, context);
    if (repair) preserveTechnicalMetadata(mapping, sanitized, context, hmacKey,
      compressionApi.estimateHistoricalUserSupplementOutputTokens);
    const rebuilt = persistence.rebuildStoreObjects(sanitized);
    assertMappingRoundTrip(sanitized,
      persistence.mapStoreObjects(String(sanitized.fields[0].accountId), rebuilt), persistence.canonicalJson);
    if (repair) assertCaptureAudioSemantics(original, rebuilt, context, captureApi,
      app.normalizeStore, persistedNormalization.normalizePersistedDocument, persistence.canonicalJson);
    return { rebuilt, context };
  };
  const unfixedAudio = redactCaptureAudio(captureAudioStore, false);
  if (captureApi.captureAudioPayload(((unfixedAudio.rebuilt.captures as JsonRecord[])[0]).audio).code !== "INVALID_AUDIO_ATTACHMENT") {
    fail("Synthetic capture did not reproduce MIME redaction invalidity");
  }
  expectOnboardingFailure(() => assertCaptureAudioSemantics(captureAudioStore, unfixedAudio.rebuilt,
    unfixedAudio.context, captureApi, app.normalizeStore, persistedNormalization.normalizePersistedDocument,
    persistence.canonicalJson), "capture audio consumer changed");
  const fixedAudio = redactCaptureAudio(captureAudioStore).rebuilt;
  const fixedCapture = (fixedAudio.captures as JsonRecord[])[0];
  const fixedPayload = fixedCapture.audio as JsonRecord;
  if (fixedPayload.mimeType !== "audio/mp4" || fixedPayload.asrMimeType !== "audio/wav"
    || fixedPayload.bytes !== 4096 || fixedPayload.durationMs !== 1250 || fixedPayload.asrBytes !== 40044
    || fixedPayload.asrAttachmentPath !== String(fixedPayload.attachmentPath).replace(/\.m4a$/u, ".asr.wav")) {
    fail("Capture audio units or source/derivative path relationship changed");
  }
  if (fixedCapture.content === "audio/mp4"
    || (fixedPayload.extension as JsonRecord).mimeType === "audio/mp4"
    || (((fixedCapture.extension as JsonRecord).audio as JsonRecord).mimeType === "audio/mp4")
    || (((fixedAudio.thoughts as JsonRecord[])[0].audio as JsonRecord).mimeType === "audio/mp4")) {
    fail("Same-name user text or extensions escaped capture audio redaction scope");
  }
  for (const [extension, mimeType] of [["m4a", "audio/mp4"], ["mp4", "audio/mp4"],
    ["webm", "audio/webm"], ["ogg", "audio/ogg"], ["wav", "audio/wav"]]) {
    const variant = structuredClone(captureAudioStore);
    (variant.captures as JsonRecord[])[0].audio = { attachmentPath: `/attachments/synthetic.${extension}`, mimeType, bytes: "1024", durationMs: "1250" };
    redactCaptureAudio(variant);
  }
  const paddedAudio = structuredClone(captureAudioStore);
  (paddedAudio.captures as JsonRecord[])[0].audio = {
    attachmentPath: " /ATTACHMENTS/synthetic.M4A ", mimeType: " AUDIO/MP4 ", bytes: "4096", durationMs: "1250",
    asrAttachmentPath: " /ATTACHMENTS/synthetic.ASR.WAV ", asrMimeType: " AUDIO/WAV ", asrBytes: "40044"
  };
  redactCaptureAudio(paddedAudio);
  const sharedDerivative = structuredClone(captureAudioStore);
  (sharedDerivative.captures as JsonRecord[]).push({ id: "derivative-as-source", version: 1,
    audio: { attachmentPath: "/attachments/private-voice.asr.wav", mimeType: "audio/wav", bytes: 40044, durationMs: 1250 } });
  redactCaptureAudio(sharedDerivative);
  (sharedDerivative.captures as JsonRecord[]).reverse();
  redactCaptureAudio(sharedDerivative);
  for (const patch of [
    { mimeType: "private unsupported format" }, { bytes: 0 }, { durationMs: 600001 },
    { attachmentPath: "/attachments/private voice.m4a" }, { attachmentPath: "/attachments/private-voice.png" },
    { asrMimeType: "audio/mp4" }, { asrBytes: 0 }, { asrAttachmentPath: "/attachments/private-voice.wav" }
  ]) {
    const variant = structuredClone(captureAudioStore);
    Object.assign((variant.captures as JsonRecord[])[0].audio as JsonRecord, patch);
    const originalResult = captureApi.captureAudioPayload((variant.captures as JsonRecord[])[0].audio);
    if (!originalResult.code) fail("Synthetic invalid capture audio unexpectedly accepted at source");
    const redacted = redactCaptureAudio(variant).rebuilt;
    if (captureApi.captureAudioPayload((redacted.captures as JsonRecord[])[0].audio).code !== originalResult.code) {
      fail("Invalid capture audio was repaired or changed its failure classification during redaction");
    }
  }
  const invalidNumericDerivative = structuredClone(captureAudioStore);
  (invalidNumericDerivative.captures as JsonRecord[])[0].audio = {
    attachmentPath: "/attachments/private-voice.m4a", mimeType: "audio/mp4", bytes: 4096, durationMs: 1250, asrBytes: "0"
  };
  redactCaptureAudio(invalidNumericDerivative);
  const missingAudio = structuredClone(captureAudioStore);
  delete (missingAudio.captures as JsonRecord[])[0].audio;
  redactCaptureAudio(missingAudio);
  const corruptedAudio = structuredClone(fixedAudio);
  ((corruptedAudio.captures as JsonRecord[])[0].audio as JsonRecord).durationMs = 1234;
  expectOnboardingFailure(() => assertCaptureAudioSemantics(captureAudioStore, corruptedAudio,
    redactCaptureAudio(captureAudioStore).context, captureApi, app.normalizeStore,
    persistedNormalization.normalizePersistedDocument, persistence.canonicalJson), "capture audio consumer changed");
  // 真实账户文档契约：使用正式normalizer生成字段齐全的基线，再检查脱敏不改变数值/引用/固定取值。
  const aiDocuments = await importFromRoot<{
    normalizeLlmSettings(value: JsonRecord): JsonRecord;
    normalizeAiUsage(value: JsonRecord): JsonRecord;
    normalizeAiCostPlan(value: JsonRecord, settings: JsonRecord, usage: JsonRecord, options: JsonRecord): JsonRecord;
  }>(root, "src/modules/ai/index.mjs");
  const realSettings = aiDocuments.normalizeLlmSettings({ apiKey: "private-source-key-never-save", assistantName: "私人名称", speech: { defaultVoice: "private-voice-id" } });
  const realUsage = aiDocuments.normalizeAiUsage({ trackingStartedAt: fixtureClock.capturedAt, entries: [
    { id: "private-call-1", callId: "private-call-1", callGroupId: "private-group", traceId: "private-trace", createdAt: fixtureClock.capturedAt,
      provider: "deepseek", model: "deepseek-flash", scene: "recordCompression", status: "success", costCny: 0.0123, costKnown: true,
      tokens: { input: 120, cacheHit: 20, output: 30 }, costsCny: { input: 0.001, total: 0.0123 }, imageTypes: ["image/jpeg"],
      rawUsage: { prompt_tokens: 120, completion_tokens_details: { reasoning_tokens: 10 } }, costSource: "private invoice source" },
    { id: "private-call-2", callId: "private-call-2", callGroupId: "private-group", traceId: "private-trace", createdAt: fixtureClock.capturedAt,
      provider: "volcengine", model: "asr-model", service: "speech", scene: "captureAsr", status: "failed", errorCategory: "network", retryReason: "empty_response_without_thinking", errorCode: "private-provider-detail", costCny: 0.003, units: 57 }
  ] });
  const realCost = aiDocuments.normalizeAiCostPlan({}, realSettings, realUsage, { date: localDateAt(fixtureClock), cnyPerUsd: 7.2 });
  const rawDocuments: AccountDocuments = { settings: realSettings, usage: realUsage, costPlan: realCost };
  const safeDocuments = await sanitizeAccountDocuments(root, "synthetic-account", rawDocuments, hmacKey, fixtureClock);
  const safeEntries = safeDocuments.usage.entries as JsonRecord[];
  if (safeDocuments.settings.apiKey !== "startup-gate-inert-key"
    || (safeDocuments.settings.speech as JsonRecord).generationRate !== (realSettings.speech as JsonRecord).generationRate || safeEntries.length !== 2
    || safeEntries[0].callGroupId !== safeEntries[1].callGroupId || safeEntries[0].traceId !== safeEntries[1].traceId
    || safeEntries[1].errorCategory !== "network" || safeEntries[1].retryReason !== "empty_response_without_thinking"
    || safeEntries[0].id !== safeEntries[0].callId || safeEntries[0].costCny !== 0.0123
    || persistence.canonicalJson(safeEntries[0].tokens) !== persistence.canonicalJson((realUsage.entries as JsonRecord[])[0].tokens)
    || JSON.stringify(safeDocuments).includes("private-")) fail("Account document redaction leaked private fields or changed ledger/identity semantics");
  const absentOptional = await sanitizeAccountDocuments(root, "synthetic-account", { settings: realSettings, usage: realUsage, costPlan: null }, hmacKey, fixtureClock);
  if (absentOptional.costPlan !== null) fail("Absent optional costPlan was replaced with defaults");
  for (const bad of [
    { ...rawDocuments, settings: null },
    { ...rawDocuments, usage: { ...realUsage, entries: [{ ...(realUsage.entries as JsonRecord[])[0], costCny: "invalid" }] } },
    { ...rawDocuments, usage: { ...realUsage, entries: [{ ...(realUsage.entries as JsonRecord[])[0], createdAt: "invalid" }] } },
    { ...rawDocuments, settings: { ...realSettings, headers: { authorization: "secret" } } },
    { ...rawDocuments, settings: { ...realSettings, scenarios: { ...(realSettings.scenarios as JsonRecord), privateCustomField: "private-secret" } } },
    { ...rawDocuments, settings: { ...realSettings, sceneEfforts: [] } },
    { ...rawDocuments, settings: { ...realSettings, responseStyles: { ...(realSettings.responseStyles as JsonRecord), privateCustomField: "private-secret" } } }
  ]) {
    let rejected = false;
    try { await sanitizeAccountDocuments(root, "synthetic-account", bad as unknown as AccountDocuments, hmacKey, fixtureClock); }
    catch { rejected = true; }
    if (!rejected) fail("Invalid/missing/secret-extension account document was accepted");
  }

  // 认证来源只精准读取旧生产schema也具备的账户ID，禁止拉取密码、会话或迁移后列。
  const makeSourceAuthClient = (failQuery = "", rows: JsonRecord[] = [
    { id: "slice-a" }, { id: "slice-b" }, { id: "slice-c" }, { id: "slice-d" }
  ]) => {
    const trace: string[] = [];
    let closed = false;
    const client: PgClient = {
      async connect() {
        fail("Account ID collector must receive an already-connected source client");
      },
      async query(sql) {
        if (closed) fail("Synthetic auth source query ran after close");
        trace.push(sql);
        if (sql === failQuery) throw new Error("Synthetic auth source read failed");
        if (sql === "SELECT id FROM for_now_auth.users ORDER BY id") return { rows };
        return { rows: [] };
      },
      async end() {
        closed = true;
        trace.push("end-complete");
      }
    };
    return { client, trace, isClosed: () => closed };
  };
  const sourceAuthFixture = makeSourceAuthClient();
  const sourceAccountIds = await readSourceAccountIdsFromClient(sourceAuthFixture.client);
  if (sourceAccountIds.join(",") !== "slice-a,slice-b,slice-c,slice-d"
    || !sourceAuthFixture.isClosed()
    || sourceAuthFixture.trace.join("|") !== [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT id FROM for_now_auth.users ORDER BY id",
      "COMMIT",
      "end-complete"
    ].join("|")) fail("Source account ID collector widened its query or changed transaction lifetime");
  for (const failure of ["SELECT id FROM for_now_auth.users ORDER BY id", "COMMIT"]) {
    const rejected = makeSourceAuthClient(failure);
    let failed = false;
    try { await readSourceAccountIdsFromClient(rejected.client); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Synthetic auth source")) throw error;
      failed = true;
    }
    if (!failed || !rejected.isClosed() || !rejected.trace.includes("ROLLBACK")
      || rejected.trace.at(-1) !== "end-complete") fail("Failed account ID read did not rollback and close");
  }
  for (const rows of [[{ id: "" }], [{ id: "duplicate" }, { id: "duplicate" }], [{ id: 1 }]]) {
    const rejected = makeSourceAuthClient("", rows);
    let failed = false;
    try { await readSourceAccountIdsFromClient(rejected.client); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("invalid or duplicate account IDs")) throw error;
      failed = true;
    }
    if (!failed || !rejected.isClosed()) fail("Invalid account ID source was accepted or left open");
  }

  // 四账号只读数据事务须先完整读取、COMMIT并等待end，再进行本机处理。
  const fixtureAccountIds = ["slice-a", "slice-b", "slice-c", "slice-d"];
  const makeSourceClient = (failQuery = "") => {
    const trace: string[] = [];
    let selected = "";
    let closed = false;
    const client: PgClient = {
      async connect() {
        fail("Slice collector must receive an already-connected source client");
      },
      async query(sql, values) {
        if (closed) fail("Synthetic source query ran after close");
        if (sql.startsWith("BEGIN")) { trace.push("begin-readonly"); return { rows: [] }; }
        if (sql.includes("txid_current_snapshot")) return { rows: [{ version: "16.15", snapshot: "1:2:", name: "synthetic" }] };
        if (sql.includes("set_config")) { selected = String(values?.[0]); trace.push(`select:${selected}`); return { rows: [] }; }
        if (sql.includes("SELECT revision")) {
          trace.push(`revision:${selected}`);
          return { rows: [{ revision: "7" }] };
        }
        if (sql.includes("attachment_inventory")) {
          trace.push(`inventory:${selected}`);
          if (failQuery === "inventory") throw new Error("Synthetic source inventory read failed");
          return { rows: [] };
        }
        trace.push(sql);
        if (sql === failQuery) throw new Error("Synthetic source commit failed");
        return { rows: [] };
      },
      async end() {
        await Promise.resolve();
        closed = true;
        trace.push("end-complete");
      }
    };
    const readMapping: PersistenceApi["readPostgresStoreObjects"] = async (activeClient, accountId) => {
      if (activeClient !== client || selected !== accountId || closed) fail("Source account mapping read crossed RLS identity or closed connection");
      trace.push(`mapping:${accountId}`);
      return persistence.mapStoreObjects(accountId, { captures: [] });
    };
    const readDocument: PersistenceApi["readAccountDocument"] = async (activeClient, accountId, name) => {
      if (activeClient !== client || selected !== accountId || closed) fail("Source document read crossed RLS identity or closed connection");
      trace.push(`document:${accountId}:${name}`);
      if (failQuery === name) throw new Error("Synthetic source document read failed");
      return name === "settings" ? { version: 13 } : name === "usage" ? { version: 1, entries: [] } : null;
    };
    return { client, readMapping, readDocument, trace, isClosed: () => closed };
  };
  const sourceFixture = makeSourceClient();
  const collected = await readSourceAccountSlices(sourceFixture.client, fixtureAccountIds, sourceFixture.readMapping, sourceFixture.readDocument);
  if (!sourceFixture.isClosed() || collected.slices.length !== 4 || collected.serverVersion !== "16.15"
    || collected.transactionSnapshot !== "1:2:" || collected.slices.some((slice, index) => (
      slice.accountId !== fixtureAccountIds[index] || slice.revision !== 7
    ))) fail("Source slice collector changed account/revision/snapshot identity or returned before connection close");
  for (const slice of collected.slices) {
    if (!sourceFixture.isClosed()) fail("Local sanitization began inside the source transaction");
    sourceFixture.trace.push(`local-sanitize:${slice.accountId}`);
    await Promise.resolve();
  }
  const commitIndex = sourceFixture.trace.indexOf("COMMIT");
  const closeIndex = sourceFixture.trace.indexOf("end-complete");
  if (commitIndex < 0 || closeIndex <= commitIndex
    || sourceFixture.trace.slice(commitIndex + 1, closeIndex).length
    || sourceFixture.trace.slice(0, commitIndex).filter(step => step.startsWith("inventory:")).length !== 4
    || sourceFixture.trace.slice(0, commitIndex).filter(step => step.startsWith("document:")).length !== 12
    || sourceFixture.trace.slice(0, closeIndex).some(step => step.startsWith("local-sanitize:"))) {
    fail("Source read/COMMIT/close/local processing order changed");
  }
  for (const failQuery of ["inventory", "settings", "usage", "COMMIT"]) {
    const rejected = makeSourceClient(failQuery);
    let failed = false;
    try { await readSourceAccountSlices(rejected.client, fixtureAccountIds, rejected.readMapping, rejected.readDocument); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Synthetic source")) throw error;
      failed = true;
    }
    if (!failed || !rejected.isClosed() || rejected.trace.at(-1) !== "end-complete"
      || !rejected.trace.includes("ROLLBACK")) fail("Failed source read or commit did not rollback and close before returning failure");
  }
  const missingDocumentSource = makeSourceClient();
  let missingDocumentRejected = false;
  try {
    await readSourceAccountSlices(missingDocumentSource.client, fixtureAccountIds, missingDocumentSource.readMapping,
      async (...args) => args[2] === "settings" ? null : missingDocumentSource.readDocument(...args));
  } catch (error) {
    missingDocumentRejected = error instanceof Error && error.message.includes("required account document is missing");
  }
  if (!missingDocumentRejected || !missingDocumentSource.isClosed() || !missingDocumentSource.trace.includes("ROLLBACK")) fail("Missing source document did not fail closed and release the source connection");
  process.stdout.write("Account document checks passed: precise legacy-schema account ID read, actual map/rebuild/normalize, private credential replacement, preserved ledger/controlled states/negative TTS rate, explicit missing documents and shared READ ONLY source lifetime.\n");
  process.stdout.write("Startup gate synthetic checks passed: construction is inert, task classifications survive redaction, and media/dispatch effects are blocked.\n");
}

const root = await findRootDirectory();
const command = process.argv[2] || "";
if (command === "--self-test") {
  await selfTest(root);
} else if (command === "snapshot") {
  const outputFile = process.argv[3];
  if (!outputFile) fail("snapshot requires an output file path");
  await snapshot(root, outputFile);
} else if (command === "verify") {
  const snapshotFile = process.argv[3];
  if (!snapshotFile) fail("verify requires a sanitized snapshot file path");
  const profileArgument = process.argv[4] || "--profile=default";
  if (!["--profile=default", "--profile=v0516-combined"].includes(profileArgument) || process.argv.length > 5) {
    fail("verify accepts only --profile=default or --profile=v0516-combined");
  }
  await verify(root, snapshotFile, profileArgument.slice("--profile=".length) as LocalGateProfile);
} else {
  process.stderr.write("Usage: release-state-startup-gate.mjs --self-test | snapshot <output-file> | verify <snapshot-file> [--profile=default|v0516-combined]\n");
  process.exitCode = 2;
}
