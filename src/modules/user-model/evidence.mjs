import crypto from "node:crypto";
import { safeIso, safeText } from "../../shared/validation/index.mjs";

export const EVIDENCE_ORIGINS = Object.freeze([
  "user",
  "device",
  "ai",
  "system",
  "third_party"
]);
export const EVIDENCE_INFORMATION_TYPES = Object.freeze([
  "user_fact",
  "user_viewpoint",
  "measured_fact",
  "device_guidance",
  "model_derived"
]);
export const EVIDENCE_PURPOSES = Object.freeze(["context", "learning"]);
export const PERCEPTION_EVENT_KINDS = Object.freeze([
  "created",
  "updated",
  "deleted",
  "restored",
  "permission_changed"
]);
export const EVIDENCE_ERROR_CODES = Object.freeze({
  INVALID: "EVIDENCE_INVALID",
  ACCOUNT_MISMATCH: "EVIDENCE_ACCOUNT_MISMATCH",
  SOURCE_MISSING: "EVIDENCE_SOURCE_MISSING",
  SOURCE_DELETED: "EVIDENCE_SOURCE_DELETED",
  VERSION_STALE: "EVIDENCE_VERSION_STALE",
  CONTENT_CHANGED: "EVIDENCE_CONTENT_CHANGED",
  PERMISSION_DENIED: "EVIDENCE_PERMISSION_DENIED",
  PERMISSION_STALE: "EVIDENCE_PERMISSION_STALE",
  DEPENDENCY_STALE: "EVIDENCE_DEPENDENCY_STALE",
  EVENT_DUPLICATE: "EVIDENCE_EVENT_DUPLICATE"
});

const ORIGIN_SET = new Set(EVIDENCE_ORIGINS);
const INFORMATION_TYPE_SET = new Set(EVIDENCE_INFORMATION_TYPES);
const PURPOSE_SET = new Set(EVIDENCE_PURPOSES);
const EVENT_KIND_SET = new Set(PERCEPTION_EVENT_KINDS);
const list = value => Array.isArray(value) ? value : [];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const objectValue = value => value && typeof value === "object" && !Array.isArray(value);
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const requiredText = (value, max) => (
  typeof value === "string" && value.trim() && value.trim().length <= max
    ? safeText(value, max)
    : ""
);
const optionalText = (value, max) => (
  value == null || value === ""
    ? ""
    : requiredText(value, max) || null
);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const requiredIso = value => {
  if (typeof value !== "string") return "";
  const match = RFC3339.exec(value);
  if (!match) return "";
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970
    || calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)) {
    return "";
  }
  return safeIso(value);
};

function normalizeSourceRef(value) {
  if (!objectValue(value)) return null;
  const resourceType = requiredText(value.resourceType, 40);
  const resourceId = requiredText(value.resourceId, 100);
  const rootId = optionalText(value.rootId, 100);
  const targetKey = optionalText(value.targetKey, 120);
  const version = positiveInteger(value.version);
  if (!resourceType || !resourceId || rootId === null || targetKey === null || !version) return null;
  return { resourceType, resourceId, rootId, targetKey, version };
}

function normalizeSourceKey(value) {
  if (typeof value !== "string" || !value || value.length > 500) return "";
  try {
    const parts = JSON.parse(value);
    if (!Array.isArray(parts) || parts.length !== 4) return "";
    const resourceType = requiredText(parts[0], 40);
    const resourceId = requiredText(parts[1], 100);
    const rootId = optionalText(parts[2], 100);
    const targetKey = optionalText(parts[3], 120);
    if (!resourceType || !resourceId || rootId === null || targetKey === null) return "";
    return JSON.stringify([resourceType, resourceId, rootId, targetKey]);
  } catch {
    return "";
  }
}

export function evidenceSourceKey(value) {
  const sourceRef = normalizeSourceRef(value);
  return sourceRef
    ? JSON.stringify([
      sourceRef.resourceType,
      sourceRef.resourceId,
      sourceRef.rootId,
      sourceRef.targetKey
    ])
    : "";
}

function normalizeDependency(value) {
  if (!objectValue(value)) return null;
  const sourceKey = normalizeSourceKey(value.sourceKey);
  const version = positiveInteger(value.version);
  const permissionRevision = positiveInteger(value.permissionRevision);
  if (!sourceKey || !version || !permissionRevision || !validHash(value.contentSha256)) return null;
  return {
    sourceKey,
    version,
    contentSha256: value.contentSha256,
    permissionRevision
  };
}

function normalizeSpan(value) {
  if (value == null) return null;
  if (!Array.isArray(value)
    || value.length !== 2
    || !value.every(Number.isSafeInteger)
    || value[0] < 0
    || value[1] <= value[0]) {
    return false;
  }
  return [value[0], value[1]];
}

export function normalizeEvidenceSource(value) {
  if (!objectValue(value) || value.schemaVersion !== 1) return null;
  const id = requiredText(value.id, 100);
  const accountId = requiredText(value.accountId, 100);
  const sourceRef = normalizeSourceRef(value.sourceRef);
  const eventId = requiredText(value.eventId, 100);
  const origin = requiredText(value.origin, 40);
  const informationType = requiredText(value.informationType, 40);
  const span = normalizeSpan(value.span);
  const contentLength = Number.isSafeInteger(value.contentLength) && value.contentLength >= 0
    ? value.contentLength
    : -1;
  const occurredAt = requiredIso(value.occurredAt);
  const recordedAt = requiredIso(value.recordedAt);
  const permissionRevision = positiveInteger(value.permissionRevision);
  const derivedInput = value.derivedFrom;
  if (!id
    || !accountId
    || !sourceRef
    || !eventId
    || !ORIGIN_SET.has(origin)
    || !INFORMATION_TYPE_SET.has(informationType)
    || !validHash(value.contentSha256)
    || contentLength < 0
    || span === false
    || (Array.isArray(span) && span[1] > contentLength)
    || !occurredAt
    || !recordedAt
    || !permissionRevision
    || !Array.isArray(derivedInput)
    || derivedInput.length > 50) {
    return null;
  }
  const derivedFrom = derivedInput.map(normalizeDependency);
  if (derivedFrom.some(item => !item)
    || new Set(derivedFrom.map(item => item.sourceKey)).size !== derivedFrom.length
    || derivedFrom.some(item => item.sourceKey === evidenceSourceKey(sourceRef))
    || (informationType === "model_derived" && derivedFrom.length === 0)
    || Date.parse(occurredAt) > Date.parse(recordedAt)) {
    return null;
  }
  derivedFrom.sort((left, right) => (
    compareText(left.sourceKey, right.sourceKey)
    || left.version - right.version
    || left.permissionRevision - right.permissionRevision
    || compareText(left.contentSha256, right.contentSha256)
  ));
  return {
    schemaVersion: 1,
    id,
    accountId,
    sourceRef,
    eventId,
    origin,
    informationType,
    contentSha256: value.contentSha256,
    contentLength,
    span,
    occurredAt,
    recordedAt,
    permissionRevision,
    derivedFrom
  };
}

export function normalizeEvidencePermission(value) {
  if (!objectValue(value) || value.schemaVersion !== 1) return null;
  const accountId = requiredText(value.accountId, 100);
  const sourceKey = normalizeSourceKey(value.sourceKey);
  const revision = positiveInteger(value.revision);
  const updatedAt = requiredIso(value.updatedAt);
  if (!accountId
    || !sourceKey
    || typeof value.contextAllowed !== "boolean"
    || typeof value.learningAllowed !== "boolean"
    || !revision
    || !updatedAt) {
    return null;
  }
  return {
    schemaVersion: 1,
    accountId,
    sourceKey,
    contextAllowed: value.contextAllowed,
    learningAllowed: value.learningAllowed,
    revision,
    updatedAt
  };
}

export function normalizePerceptionEvent(value) {
  if (!objectValue(value) || value.schemaVersion !== 1) return null;
  const id = requiredText(value.id, 100);
  const accountId = requiredText(value.accountId, 100);
  const kind = requiredText(value.kind, 40);
  const sourceRef = normalizeSourceRef(value.sourceRef);
  const eventId = requiredText(value.eventId, 100);
  const occurredAt = requiredIso(value.occurredAt);
  const recordedAt = requiredIso(value.recordedAt);
  const permissionRevision = positiveInteger(value.permissionRevision);
  const perceptionVersion = requiredText(value.perceptionVersion, 100);
  if (!id
    || !accountId
    || !EVENT_KIND_SET.has(kind)
    || !sourceRef
    || !eventId
    || !validHash(value.contentSha256)
    || !occurredAt
    || !recordedAt
    || !permissionRevision
    || !perceptionVersion
    || Date.parse(occurredAt) > Date.parse(recordedAt)) {
    return null;
  }
  return {
    schemaVersion: 1,
    id,
    accountId,
    kind,
    sourceRef,
    eventId,
    contentSha256: value.contentSha256,
    occurredAt,
    recordedAt,
    permissionRevision,
    perceptionVersion
  };
}

export function evidenceEventKey(value) {
  const event = normalizePerceptionEvent(value);
  return event ? JSON.stringify([
    event.accountId,
    event.eventId,
    event.kind,
    evidenceSourceKey(event.sourceRef),
    event.sourceRef.version,
    event.contentSha256,
    event.permissionRevision,
    event.perceptionVersion
  ]) : "";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!objectValue(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function evidenceFingerprint(value) {
  const evidence = normalizeEvidenceSource(value);
  if (!evidence) return "";
  const { id: _id, recordedAt: _recordedAt, ...stableInput } = evidence;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(stableInput))).digest("hex");
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function dependencyMatches(dependency, current, accountId, purpose) {
  if (!objectValue(current)
    || current.accountId !== accountId
    || normalizeSourceKey(current.sourceKey) !== dependency.sourceKey
    || current.exists !== true
    || current.deleted !== false
    || current.version !== dependency.version
    || current.contentSha256 !== dependency.contentSha256
    || current.permissionRevision !== dependency.permissionRevision) {
    return false;
  }
  return purpose === "context"
    ? current.contextAllowed === true
    : current.learningAllowed === true;
}

export function evaluateEvidence(value, currentState, {
  accountId,
  purpose
} = {}) {
  const evidence = normalizeEvidenceSource(value);
  const expectedAccountId = requiredText(accountId, 100);
  if (!evidence || !expectedAccountId || !PURPOSE_SET.has(purpose) || !objectValue(currentState)) {
    return {
      usable: false,
      reasons: [EVIDENCE_ERROR_CODES.INVALID],
      currentVersion: 0,
      currentPermissionRevision: 0
    };
  }
  const source = objectValue(currentState.source) ? currentState.source : null;
  const permission = normalizeEvidencePermission(currentState.permission);
  const currentVersion = positiveInteger(source?.version);
  const currentPermissionRevision = positiveInteger(permission?.revision);
  const reasons = [];
  if (evidence.accountId !== expectedAccountId
    || (source && source.accountId !== expectedAccountId)
    || (permission?.accountId && permission.accountId !== expectedAccountId)) {
    addReason(reasons, EVIDENCE_ERROR_CODES.ACCOUNT_MISMATCH);
    return { usable: false, reasons, currentVersion, currentPermissionRevision };
  }
  if (!source
    || source.exists !== true
    || typeof source.deleted !== "boolean"
    || normalizeSourceKey(source.sourceKey) !== evidenceSourceKey(evidence.sourceRef)) {
    addReason(reasons, EVIDENCE_ERROR_CODES.SOURCE_MISSING);
    return { usable: false, reasons, currentVersion, currentPermissionRevision };
  }
  if (source.deleted === true) {
    addReason(reasons, EVIDENCE_ERROR_CODES.SOURCE_DELETED);
    return { usable: false, reasons, currentVersion, currentPermissionRevision };
  }
  if (currentVersion !== evidence.sourceRef.version) {
    addReason(reasons, EVIDENCE_ERROR_CODES.VERSION_STALE);
  }
  if (!validHash(source.contentSha256) || source.contentSha256 !== evidence.contentSha256) {
    addReason(reasons, EVIDENCE_ERROR_CODES.CONTENT_CHANGED);
  }
  if (!permission || permission.sourceKey !== evidenceSourceKey(evidence.sourceRef)) {
    addReason(reasons, EVIDENCE_ERROR_CODES.PERMISSION_DENIED);
  } else {
    if (permission.revision !== evidence.permissionRevision) {
      addReason(reasons, EVIDENCE_ERROR_CODES.PERMISSION_STALE);
    }
    const allowed = purpose === "context"
      ? permission.contextAllowed
      : permission.learningAllowed;
    if (!allowed) addReason(reasons, EVIDENCE_ERROR_CODES.PERMISSION_DENIED);
  }
  const dependencies = new Map();
  let dependencyStateInvalid = !Array.isArray(currentState.dependencies);
  for (const item of list(currentState.dependencies)) {
    const key = normalizeSourceKey(item?.sourceKey);
    if (!key || dependencies.has(key)) dependencyStateInvalid = true;
    else dependencies.set(key, item);
  }
  if (dependencyStateInvalid || evidence.derivedFrom.some(item => (
    !dependencyMatches(item, dependencies.get(item.sourceKey), expectedAccountId, purpose)
  ))) {
    addReason(reasons, EVIDENCE_ERROR_CODES.DEPENDENCY_STALE);
  }
  return {
    usable: reasons.length === 0,
    reasons,
    currentVersion,
    currentPermissionRevision
  };
}

export function deduplicateEvidenceByEvent(values) {
  if (!Array.isArray(values)) {
    return {
      invalid: true,
      code: EVIDENCE_ERROR_CODES.INVALID,
      eventCount: 0,
      duplicateEvidenceCount: 0,
      groups: []
    };
  }
  const source = values;
  const normalized = source.map(normalizeEvidenceSource);
  if (normalized.length !== source.length || normalized.some(item => !item)) {
    return {
      invalid: true,
      code: EVIDENCE_ERROR_CODES.INVALID,
      eventCount: 0,
      duplicateEvidenceCount: 0,
      groups: []
    };
  }
  const groups = new Map();
  for (const evidence of normalized) {
    const key = JSON.stringify([evidence.accountId, evidence.eventId]);
    const group = groups.get(key) || {
      key,
      accountId: evidence.accountId,
      eventId: evidence.eventId,
      evidenceIds: [],
      sourceKeys: []
    };
    group.evidenceIds.push(evidence.id);
    group.sourceKeys.push(evidenceSourceKey(evidence.sourceRef));
    groups.set(key, group);
  }
  const result = [...groups.values()]
    .map(group => ({
      ...group,
      evidenceIds: sortUnique(group.evidenceIds),
      sourceKeys: sortUnique(group.sourceKeys)
    }))
    .sort((left, right) => compareText(left.key, right.key));
  return {
    invalid: false,
    code: "",
    eventCount: result.length,
    duplicateEvidenceCount: normalized.length - result.length,
    groups: result
  };
}

function sortUnique(values) {
  return [...new Set(values)].sort(compareText);
}
