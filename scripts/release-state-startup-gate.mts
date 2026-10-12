#!/usr/bin/env node
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
type PersistenceApi = {
  readAuthDocument(client: PgClient): Promise<{ users?: JsonRecord[] } | null>;
  mapStoreObjects(accountId: string, store: JsonRecord): StoreMapping;
  readPostgresStoreObjects(client: PgClient, accountId: string): Promise<StoreMapping>;
  rebuildStoreObjects(mapping: StoreMapping): JsonRecord;
  writeStoreObjects(client: PgClient, mapping: StoreMapping): Promise<void>;
  initializePostgresSchema(client: PgClient): Promise<void>;
  writeAuthDocument(client: PgClient, document: JsonRecord): Promise<void>;
  canonicalJson(value: unknown): string;
  storeContentSha256(value: unknown): string;
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
  observeEffect(kind: string, operation: string): never;
  counts: Record<string, number>;
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
const TIMEZONE_KEYS = new Set(["timezone", "timeZone", "recordTimezone", "recordTimeZone"]);
const SOURCE_TARGET_PREFIXES = new Set([
  "annotation", "annotation-reply", "question", "followup-question", "followup-answer",
  "idea", "answer", "record"
]);
const SOURCE_TARGET_LITERALS = new Set(["", "transcription"]);

type RedactionContext = {
  key: Buffer;
  ids: Map<string, string>;
  paths: Map<string, string>;
  sourceKeys: Map<string, string>;
  sourceTargetKeys: Map<string, string>;
  objectKeys: Map<string, string>;
  resourceKeys: Map<string, string>;
  singletonIds: Set<string>;
};

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

function createRedactionContext(mapping: StoreMapping, key: Buffer, inventory: JsonRecord[] = []): RedactionContext {
  const context: RedactionContext = {
    key,
    ids: new Map(),
    paths: new Map(),
    sourceKeys: new Map(),
    sourceTargetKeys: new Map(),
    objectKeys: new Map(),
    resourceKeys: new Map(),
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
  const redactSourceTargetKey = (value: string) => {
    if (context.sourceTargetKeys.has(value)) return context.sourceTargetKeys.get(value)!;
    if (SOURCE_TARGET_LITERALS.has(value)) {
      context.sourceTargetKeys.set(value, value);
      return value;
    }
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) {
      fail("Snapshot source target key has an unsupported structure");
    }
    const prefix = value.slice(0, separator);
    if (!SOURCE_TARGET_PREFIXES.has(prefix)) fail("Snapshot source target key has an unknown private value");
    const result = `${prefix}:${redactId(value.slice(separator + 1))}`;
    context.sourceTargetKeys.set(value, result);
    return result;
  };
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
      const resourceId = segment.slice(separator + 1);
      const mappedId = resourceId.startsWith("[") ? redactSourceKey(resourceId) : redactId(resourceId);
      return `${segment.slice(0, separator + 1)}${mappedId}`;
    }).join("/");
    context.resourceKeys.set(value, result);
    return result;
  };
  const register = (value: unknown, field = "") => {
    if (Array.isArray(value)) {
      for (const item of value) register(item, field);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (/^\/attachments\//u.test(value) || ATTACHMENT_PATH_FIELDS.has(field)) redactPath(value);
      else if (field === "sourceKey" || (field === "resourceId" && value.startsWith("["))) redactSourceKey(value);
      else if (field === "resourceKey") redactResourceKey(value);
      else if (field === "targetKey") redactSourceTargetKey(value);
      else if (IDENTIFIER_KEYS.has(field) || /(?:^|[A-Z])(?:Id|ID)$/u.test(field)) redactId(value);
      return;
    }
    for (const [name, child] of Object.entries(value)) register(child, name);
  };

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

function sanitizeMapping<T>(value: T, key: Buffer, context: RedactionContext, stringMap = new Map<string, string>()): T {
  const referenceField = (field: string) => IDENTIFIER_KEYS.has(field) || /(?:^|[A-Z])(?:Id|ID)$/u.test(field);
  const transform = (text: string, field: string): string => {
    if (!text) return text;
    if (field === "sourceKey") return context.sourceKeys.get(text) || fail("Snapshot source key has no redaction mapping");
    if (context.sourceKeys.has(text)) return context.sourceKeys.get(text)!;
    if (field === "id" && context.singletonIds.has(text)) return text;
    if (field === "objectKey") {
      if (context.objectKeys.has(text)) return context.objectKeys.get(text)!;
      if (!stringMap.has(text)) stringMap.set(text, identityToken(key, "value", text));
      return stringMap.get(text)!;
    }
    if (field === "parentKey" || field === "ownerKey") {
      if (!text) return text;
      return context.objectKeys.get(text) || fail("Snapshot ownership key has no redaction mapping");
    }
    if (field === "targetKey") {
      if (!text) return text;
      if (context.objectKeys.has(text)) return context.objectKeys.get(text)!;
      return context.sourceTargetKeys.get(text) || fail("Snapshot target key has no redaction mapping");
    }
    if (field === "resourceKey") return context.resourceKeys.get(text) || fail("Snapshot resource key has no redaction mapping");
    if (field === "valuePath" || field === "childFields") return text;
    if (field === "resourceId" && text.startsWith("[")) return context.sourceKeys.get(text) || fail("Snapshot composite resource ID has no redaction mapping");
    if (context.paths.has(text) || ATTACHMENT_PATH_FIELDS.has(field) || /^\/attachments\//u.test(text)) {
      return context.paths.get(text) || fail("Snapshot attachment path has no redaction mapping");
    }
    if (ENUM_STRING_KEYS.has(field)) return text;
    if (TIMEZONE_KEYS.has(field)) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: text });
        return text;
      } catch {}
    }
    if (isValidTemporalValue(field, text)) return text;
    if (context.ids.has(text)) return context.ids.get(text)!;
    if (referenceField(field)) return registerIdentifier(context, key, text);
    if (STRUCTURAL_TIME_KEYS.has(field)) {
      if (isValidTemporalValue(field, text)) return text;
    }
    if (/^(?:version|.*Version|attempt|position|bytes|count|statusCode|schemaVersion)$/u.test(field)) return text;
    if (!stringMap.has(text)) stringMap.set(text, identityToken(key, "value", text));
    return stringMap.get(text)!;
  };
  const visit = (item: unknown, field: string): unknown => {
    if (typeof item === "string") return transform(item, field);
    if (Array.isArray(item)) return item.map(value => visit(value, field));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
    }
    return item;
  };
  return visit(value, "") as T;
}

function registerIdentifier(context: RedactionContext, key: Buffer, value: string): string {
  if (!context.ids.has(value)) context.ids.set(value, identityToken(key, "id", value));
  return context.ids.get(value)!;
}

function redactStructuralKey(value: string, context: RedactionContext): string {
  if (context.objectKeys.has(value)) return context.objectKeys.get(value)!;
  try {
    const parts = JSON.parse(value);
    if (!Array.isArray(parts)) fail("Snapshot relation key is not a structural key");
    if (parts.some(part => typeof part !== "string" && part !== null)) fail("Snapshot relation key has unsupported components");
    return JSON.stringify(parts.map((part, index) => index % 2 === 1 && typeof part === "string"
      ? context.paths.has(part) ? context.paths.get(part)! : registerIdentifier(context, context.key, part)
      : part));
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a structural key")) throw error;
    fail("Snapshot relation key cannot be parsed safely");
  }
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

function assertSameTaskSemantics(before: JsonRecord[], after: JsonRecord[]) {
  const serialize = (items: JsonRecord[]) => JSON.stringify(items);
  if (serialize(before) !== serialize(after)) fail("Redaction changed task state, target classification, or effective intent match");
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
  for (const key of ["fields", "objects", "relations", "attachmentRefs", "lifecycles", "idempotency"] as const) {
    if (canonicalJson(expected[key]) !== canonicalJson(rebuilt[key])) {
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

async function readSourceAccountIds(root: string, connectionString: string): Promise<string[]> {
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const client = await pgClient(connectionString);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const auth = await persistence.readAuthDocument(client);
    await client.query("COMMIT");
    const ids = (auth?.users || []).map(user => String(user.id || "")).filter(Boolean).sort();
    if (new Set(ids).size !== ids.length) fail("Production auth snapshot contains duplicate account IDs");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
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
  const sourceStore = persistence.rebuildStoreObjects(sourceMapping);
  const sourceInspector = (await createClosedInspector(root, accountId, {}, clock)).backgroundAi;
  const beforeStates = taskStates(sourceStore, sourceInspector, redactionKey);
  const redactionContext = createRedactionContext(sourceMapping, redactionKey, sourceInventory);
  const redactedMapping = sanitizeMapping(sourceMapping, redactionKey, redactionContext, stringMap);
  const redactedInventory = sanitizeMapping(sourceInventory, redactionKey, redactionContext, stringMap);
  const redactedAccountId = identityToken(redactionKey, "id", accountId);
  const sanitizedStore = persistence.rebuildStoreObjects(redactedMapping);
  const sanitizedInspector = (await createClosedInspector(root, redactedAccountId, {}, clock)).backgroundAi;

  // 仅在真实映射关系已等价重建后，按原始匹配结论更新脱敏正文派生的候选 hash。
  const initialRedactedMapping = persistence.mapStoreObjects(redactedAccountId, sanitizedStore);
  assertMappingRoundTrip(redactedMapping, initialRedactedMapping, persistence.canonicalJson);
  preserveMatchingRequestedIntentHashes(sourceStore, beforeStates, sanitizedStore, redactedMapping, sanitizedInspector, redactionKey);

  const finalStore = persistence.rebuildStoreObjects(redactedMapping);
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
  const firstAccountIds = await readSourceAccountIds(root, sourceAuthUrl);
  if (!firstAccountIds.length) fail("Source auth snapshot has no users to validate");
  const client = await pgClient(sourceDataUrl);
  const redactionKey = randomBytes(32);
  const stringMap = new Map<string, string>();
  const accounts: JsonRecord[] = [];
  let serverVersion = "";
  let transactionSnapshot = "";
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const database = (await client.query("SELECT current_database() AS name, current_setting('server_version') AS version, txid_current_snapshot()::text AS snapshot")).rows[0];
    serverVersion = String(database.version || "");
    transactionSnapshot = String(database.snapshot || "");
    for (const sourceAccountId of firstAccountIds) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [sourceAccountId]);
      const account = (await client.query("SELECT revision FROM for_now.accounts WHERE account_id = $1", [sourceAccountId])).rows[0];
      if (!account) fail("Auth account has no business account row; snapshot is inconsistent");
      const sourceMapping = await (await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs"))
        .readPostgresStoreObjects(client, sourceAccountId);
      const inventory = (await client.query(`
        SELECT path, storage, object_key AS "objectKey", bytes::float8 AS bytes, sha256, state
        FROM for_now.attachment_inventory WHERE account_id = $1 ORDER BY path
      `, [sourceAccountId])).rows;
      accounts.push(await createSanitizedAccount(
        root,
        sourceAccountId,
        sourceMapping,
        inventory,
        Number(account.revision),
        redactionKey,
        stringMap,
        timeBaseline
      ));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  const finalAccountIds = await readSourceAccountIds(root, sourceAuthUrl);
  if (JSON.stringify(firstAccountIds) !== JSON.stringify(finalAccountIds)) {
    fail("Production account set changed during snapshot; retry from a new read-only transaction");
  }
  const outputPersistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const manifest = {
    format: "release-state-startup-gate-snapshot",
    schemaVersion: 1,
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
  if (snapshotValue.format !== "release-state-startup-gate-snapshot" || snapshotValue.schemaVersion !== 1) {
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

async function startLocalPostgres(root: string, tempRoot: string) {
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
  await execFile(path.join(binDirectory, "pg_ctl"), ["-D", cluster, "-l", logFile, "-w", "-t", "20", "start"], {
    env, timeout: 30_000, maxBuffer: 1024 * 1024
  });
  const pidText = (await fs.readFile(path.join(cluster, "postmaster.pid"), "utf8")).split("\n")[0];
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1) fail("Local PostgreSQL PID file is invalid");
  const command = await execFile("ps", ["-p", String(pid), "-o", "command="]);
  if (!command.stdout.includes(cluster)) fail("Local PostgreSQL PID is outside the isolated temporary cluster");
  const url = (user: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/startup_gate`;
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  return { binDirectory, cluster, port, password, adminUrl, url };
}

async function stopLocalPostgres(pgState: { binDirectory: string; cluster: string }) {
  await execFile(path.join(pgState.binDirectory, "pg_ctl"), ["-D", pgState.cluster, "-m", "fast", "-w", "-t", "20", "stop"], {
    timeout: 30_000, maxBuffer: 1024 * 1024
  }).catch(() => {});
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

function installGateEnvironment(tempRoot: string, urls: { data: string; auth: string; budget: string }, port: number, counts: Record<string, number>) {
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
    ATTACHMENT_STORAGE_MODE: "local"
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

async function startRuntime(root: string, tempRoot: string, urls: { data: string; auth: string; budget: string }, port: number, gate: StartupGatePort) {
  const restoreEnvironment = installGateEnvironment(tempRoot, urls, port, gate.counts);
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
    const started = await runtime.start();
    await runtime.ready();
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const ready = await fetch(`${baseUrl}/readyz`);
    if (!ready.ok) fail(`Isolated runtime readyz failed (${ready.status})`);
    return { runtime, baseUrl, restoreEnvironment };
  } catch (error) {
    await runtime?.stop().catch(() => {});
    restoreEnvironment();
    throw error;
  }
}

async function verify(root: string, snapshotFile: string) {
  const snapshotValue = await loadSnapshot(root, snapshotFile);
  const timeBaseline = snapshotValue.timeBaseline as InspectionClock;
  if (!timeBaseline?.capturedAt || !timeBaseline.timezone || snapshotValue.capturedAt !== timeBaseline.capturedAt) {
    fail("Startup gate snapshot has no consistent semantic inspection time baseline");
  }
  const changedTrackedFiles = (await execFile("git", ["diff", "--name-only", "HEAD"], { cwd: root })).stdout.trim();
  if (changedTrackedFiles) fail("Startup verification requires a clean tracked candidate matching the recorded tree");
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
  try {
    pgState = await startLocalPostgres(root, tempRoot);
    const imported = await initializeGateDatabase(root, pgState, snapshotValue);
    const accountIds = (snapshotValue.accounts as JsonRecord[]).map(account => String(account.accountId));
    const importedStates = await readLocalTaskStates(root, pgState.url("runtime_data"), accountIds, timeBaseline);
    const expectedStates: JsonRecord[] = (snapshotValue.accounts as JsonRecord[]).flatMap(account =>
      (account.taskStates as JsonRecord[] || []).map(state => ({ ...state, accountId: String(account.accountId) }))
    ).sort((left: JsonRecord, right: JsonRecord) => `${left.accountId}:${String(left.id || "")}`.localeCompare(`${right.accountId}:${String(right.id || "")}`));
    if (JSON.stringify(importedStates) !== JSON.stringify(expectedStates)) {
      fail("Imported recovery task statuses, targets, or intent matches differ from the sanitized snapshot");
    }
    const testPort = await freeTcpPort();
    const gateCounts: Record<string, number> = { dispatchHeld: 0, provider: 0, outbound: 0, media: 0 };
    const gate: StartupGatePort = {
      tempRoot,
      counts: gateCounts,
      holdDispatch(kind: string, _callback: (...args: unknown[]) => unknown) {
        gateCounts.dispatchHeld += 1;
        gateCounts[`dispatch_${kind}`] = (gateCounts[`dispatch_${kind}`] || 0) + 1;
        return null;
      },
      observeEffect(kind: string, operation: string): never {
        gateCounts[kind] = (gateCounts[kind] || 0) + 1;
        throw new Error(`Startup gate blocked ${kind}:${operation}`);
      }
    };
    const urls = {
      data: pgState.url("runtime_data"),
      auth: pgState.url("runtime_auth"),
      budget: pgState.url("runtime_budget")
    };
    const first = await startRuntime(root, tempRoot, urls, testPort, gate);
    runtimeInstance = first.runtime;
    restoreRuntimeEnvironment = first.restoreEnvironment;
    const firstStates = await readLocalTaskStates(root, urls.data, accountIds, timeBaseline);
    await first.runtime.stop();
    runtimeInstance = null;
    first.restoreEnvironment();
    restoreRuntimeEnvironment = null;

    const secondPort = await freeTcpPort();
    const second = await startRuntime(root, tempRoot, urls, secondPort, gate);
    runtimeInstance = second.runtime;
    restoreRuntimeEnvironment = second.restoreEnvironment;
    const secondStates = await readLocalTaskStates(root, urls.data, accountIds, timeBaseline);
    if (JSON.stringify(firstStates) !== JSON.stringify(secondStates)) fail("Task recovery state changed on the second same-database restart");

    const firstAccount = (snapshotValue.accounts as JsonRecord[])[0];
    const credentials = imported.passwords.get(String(firstAccount.accountId));
    if (!credentials) fail("Synthetic local login credentials are missing");
    const session = await login(second.baseUrl, credentials);
    const headers = { cookie: session.cookie, "content-type": "application/json" };
    const stateBefore = await fetchJson(`${second.baseUrl}/api/state`, { headers });
    if (!stateBefore.response.ok) fail(`Authenticated core read failed (${stateBefore.response.status})`);
    const marker = `startup-gate-${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    const save = await fetchJson(`${second.baseUrl}/api/thoughts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "question", content: marker, occurredAt: now, occurredOn: now.slice(0, 10) })
    });
    if (save.response.status !== 201) fail(`Authenticated save round-trip write failed (${save.response.status})`);
    const stateAfter = await fetchJson(`${second.baseUrl}/api/state`, { headers });
    if (!stateAfter.response.ok || !stateAfter.body.includes(marker)) fail("Authenticated save/read round trip did not persist");
    const taskRead = await fetchJson(`${second.baseUrl}/api/ai-tasks`, { headers });
    const notificationRead = await fetchJson(`${second.baseUrl}/api/notifications`, { headers });
    if (!taskRead.response.ok || !notificationRead.response.ok) fail("Core task/notification read smoke failed");
    await second.runtime.stop();
    runtimeInstance = null;
    second.restoreEnvironment();
    restoreRuntimeEnvironment = null;

    if (gateCounts.provider || gateCounts.outbound || gateCounts.media) {
      fail("A provider, outbound notification/debug request, or media method was attempted during the gate");
    }
    process.stdout.write(JSON.stringify({
      status: "PASS",
      candidateSha: snapshotValue.candidateSha,
      candidateTree: snapshotValue.candidateTree,
      snapshotSha256: snapshotValue.snapshotSha256,
      pgVersion: (await execFile(path.join(pgState.binDirectory, "postgres"), ["--version"])).stdout.trim(),
      accounts: (snapshotValue.accounts as JsonRecord[]).length,
      taskCount: firstStates.length,
      heldDispatches: gateCounts.dispatchHeld,
      forbiddenEffects: { provider: gateCounts.provider, outbound: gateCounts.outbound, media: gateCounts.media },
      evidence: ["runtime.start", "readyz", "same-postgres-stop-restart", "authenticated-state-read", "save-read-round-trip", "task-read", "notification-read"]
    }) + "\n");
  } finally {
    await runtimeInstance?.stop().catch(() => {});
    restoreRuntimeEnvironment?.();
    if (pgState) await stopLocalPostgres(pgState);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function selfTest(root: string) {
  const counts: Record<string, number> = {};
  const fixtureClock = createInspectionClock("2026-10-12T00:00:00.000Z", "Asia/Shanghai");
  const runtime = await createClosedInspector(root, "synthetic-account", counts, fixtureClock);
  const inspector = runtime.backgroundAi;
  const persistence = await importFromRoot<PersistenceApi>(root, "src/shared/persistence/index.mjs");
  const persistenceMetadata = await importFromRoot<{
    synchronizePersistenceMetadata(before: JsonRecord | null, after: JsonRecord, now: () => string, options: JsonRecord): JsonRecord;
  }>(root, "src/shared/persistence/persistence-metadata.mjs");
  const permissionSourceTargetKey = "question:thought-private-root";
  const permissionSourceKey = JSON.stringify([
    "thought", "thought-private-root", "thought-private-root", permissionSourceTargetKey
  ]);
  const store: JsonRecord = {
    captures: [{ id: "capture-private-id", capturedAt: "2026-10-11T18:30:00.000Z", timezone: "Asia/Shanghai", attachmentPath: "/attachments/private-capture.m4a" }],
    thoughts: [
      {
        id: "thought-private-root",
        type: "question",
        content: "private question phrase",
        version: 1,
        sourceRef: { type: "capture", id: "capture-private-id", targetKey: "" },
        sourceCaptureId: "capture-private-id",
        sourceId: "capture-private-id",
        recordTimezone: "Asia/Shanghai",
        contextGeneratedAt: "2026-10-11T18:30:00.000Z",
        inputAsOf: "2026-10-11T18:30:00.000Z",
        imagePath: "/attachments/private-image.png",
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
    }],
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
      contentSha256: createHash("sha256").update("synthetic-event").digest("hex"),
      permissionRevision: 1,
      occurredAt: "2026-10-11T18:30:00.000Z",
      recordedAt: "2026-10-11T18:30:00.000Z",
      perceptionVersion: "synthetic-perception-v1"
    }],
    onboardingV2: { version: 1, answer: "private singleton answer" }
  };
  persistenceMetadata.synchronizePersistenceMetadata(null, store, () => fixtureClock.capturedAt, { force: true });
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
  const hmacKey = randomBytes(32);
  const sourceMapping = persistence.mapStoreObjects("synthetic-account", store);
  const sourceStates = taskStates(store, inspector, hmacKey);
  const inventory: JsonRecord[] = [{
    path: "/attachments/private-image.png",
    storage: "local",
    objectKey: "private-storage-key",
    bytes: 4096,
    sha256: "private-file-hash",
    state: "verified"
  }];
  const redactionContext = createRedactionContext(sourceMapping, hmacKey, inventory);
  const redactedMapping = sanitizeMapping(sourceMapping, hmacKey, redactionContext);
  const redactedInventory = sanitizeMapping(inventory, hmacKey, redactionContext);
  const redactedAccountId = identityToken(hmacKey, "id", "synthetic-account");
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
  const redactedPermission = (redactedStore.evidencePermissions as JsonRecord[])[0];
  const redactedPermissionSource = JSON.parse(String(redactedPermission.sourceKey)) as string[];
  const redactedEvent = (redactedStore.perceptionEvents as JsonRecord[])[0];
  const redactedEventSource = redactedEvent.sourceRef as JsonRecord;
  const permissionLifecycle = (redactedMapping.lifecycles as JsonRecord[]).find(item => item.resourceType === "evidencePermission");
  if (!permissionLifecycle
    || permissionLifecycle.resourceId !== redactedPermission.sourceKey
    || permissionLifecycle.resourceKey !== `evidencePermission:${redactedPermission.sourceKey}`
    || redactedPermissionSource[3] !== `question:${redactedRoot.id}`
    || redactedEventSource.targetKey !== `question:${redactedRoot.id}`
    || redactedEventSource.resourceId !== redactedRoot.id
    || redactedEventSource.rootId !== redactedRoot.id) {
    fail("Evidence permission source tuple and lifecycle identities were not redacted consistently");
  }
  const redactedInspection = redactedInspector.inspectRecoveryIntent(redactedStore, (redactedStore.aiTasks as JsonRecord[])[0]);
  if (redactedRoot.id !== redactedAnswer.relatedTo
    || redactedCapture.id !== redactedRoot.sourceCaptureId
    || redactedCapture.id !== (redactedRoot.sourceRef as JsonRecord).id
    || (redactedRoot.sourceRef as JsonRecord).targetKey !== ""
    || redactedInspection.intentMatch !== "matched"
    || redactedInspection.target?.exists !== true
    || redactedInspection.target.subtargetExists !== true) {
    fail("Redaction broke a shared source/reference identity or waiting-task target");
  }
  if (redactedRoot.recordTimezone !== "Asia/Shanghai"
    || redactedRoot.contextGeneratedAt !== "2026-10-11T18:30:00.000Z"
    || redactedRoot.inputAsOf !== "2026-10-11T18:30:00.000Z"
    || !Object.hasOwn(redactedStore, "onboardingV2")) {
    fail("Redaction changed timezone, technical timestamps, or singleton structure");
  }
  if (!rebuiltRedactedMapping.relations.some(item => item.relation === "thoughtRoot" && item.resolution === "live")
    || !rebuiltRedactedMapping.relations.some(item => item.relation === "source" && item.resolution === "live")
    || !rebuiltRedactedMapping.attachmentRefs.length) {
    fail("Rebuilt relationship graph lost a root/source edge or attachment reference");
  }
  const matchedAfter = redactedInspector.inspectRecoveryIntent(redactedStore, (redactedStore.aiTasks as JsonRecord[])[0]);
  const afterStates = taskStates(redactedStore, redactedInspector, hmacKey, true);
  assertSameTaskSemantics(sourceStates, afterStates);
  if (matchedAfter.intentMatch !== "matched") fail("Redacted task intent did not retain its original matching result");
  const secretText = JSON.stringify({ redactedStore, redactedMapping, redactedInventory });
  if (["private question phrase", "private answer phrase", "private follow-up", "private singleton answer", "private-image", "private-capture", "private-storage-key", "private-file-hash", "thought-private-root"]
    .some(secret => secretText.includes(secret))) fail("Synthetic redaction retained a private fixture value");
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
  await verify(root, snapshotFile);
} else {
  process.stderr.write("Usage: release-state-startup-gate.mjs --self-test | snapshot <output-file> | verify <snapshot-file>\n");
  process.exitCode = 2;
}
