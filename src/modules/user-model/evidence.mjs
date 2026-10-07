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

export function parseEvidenceSourceKey(value) {
  const sourceKey = normalizeSourceKey(value);
  if (!sourceKey) return null;
  const [resourceType, resourceId, rootId, targetKey] = JSON.parse(sourceKey);
  return { resourceType, resourceId, rootId, targetKey };
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

const compareEventsNewestFirst = (left, right) => (
  right.sourceRef.version - left.sourceRef.version
  || right.permissionRevision - left.permissionRevision
  || compareText(right.recordedAt, left.recordedAt)
  || compareText(right.id, left.id)
);

const SOURCE_COLLECTIONS = Object.freeze({
  checkin: "checkins",
  dailyRecord: "dailyRecords",
  capture: "captures",
  journal: "journals",
  thought: "thoughts",
  chat: "chats",
  book: "books",
  keepsake: "keepsakes",
  quote: "quotes",
  experiment: "experiments",
  analysis: "analyses",
  customMetric: "customMetrics",
  action: "actions",
  habit: "habits",
  habitCheckin: "habitCheckins",
  feedback: "feedback",
  validationLedger: "validationLedger",
  userClaim: "userClaims",
  modelUnknown: "modelUnknowns"
});

function storedSourceState(store, sourceRef, activeIndexes = null) {
  const collection = SOURCE_COLLECTIONS[sourceRef.resourceType];
  if (!collection) return null;
  const active = activeIndexes?.get(collection)?.get(sourceRef.resourceId)
    || list(store?.[collection]).find(item => item?.id === sourceRef.resourceId);
  if (active) {
    return {
      exists: true,
      deleted: false,
      version: positiveInteger(active.version),
      modelDerived: active.informationType === "model_derived"
        || active.authorType === "ai"
        || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(active.origin || ""))
        || Boolean(active.modelDraft)
        || Boolean(active.sourceTaskId)
        || Boolean(active.contextReceipt)
    };
  }
  for (const entry of list(store?.trash)) {
    if (entry?.type === "thoughtChain" && Array.isArray(entry.payload?.items)) {
      const record = entry.payload.items
        .map(item => item?.item)
        .find(item => item?.id === sourceRef.resourceId);
      if (sourceRef.resourceType === "thought" && record) {
        return { exists: true, deleted: true, version: positiveInteger(record.version) };
      }
    }
    const location = objectValue(entry?.location) ? entry.location : {};
    const matchesLocation = location.kind === "collection"
      ? location.collection === collection
        && (sourceRef.rootId ? location.parentId === sourceRef.rootId : !location.parentId)
      : location.kind === "nested"
        ? Boolean(sourceRef.rootId)
          && location.parentCollection === collection
          && location.parentId === sourceRef.rootId
        : !sourceRef.rootId && SOURCE_COLLECTIONS[entry?.type] === collection;
    if (matchesLocation && entry?.payload?.id === sourceRef.resourceId) {
      return {
        exists: true,
        deleted: true,
        version: positiveInteger(entry.payload.version)
      };
    }
  }
  return null;
}

function currentStateForEvidence(store, evidence, accountId, indexes = {}) {
  const sourceKey = evidenceSourceKey(evidence.sourceRef);
  const event = indexes.latestEvents?.get(sourceKey) || null;
  const storedSource = storedSourceState(store, evidence.sourceRef, indexes.activeSources);
  const permission = indexes.permissions?.get(sourceKey) || null;
  const dependencies = evidence.derivedFrom.map(dependency => {
    const dependencyEvent = indexes.latestEvents?.get(dependency.sourceKey) || null;
    const dependencyRef = parseEvidenceSourceKey(dependency.sourceKey);
    const storedDependency = dependencyRef
      ? storedSourceState(
          store,
          { ...dependencyRef, version: dependency.version },
          indexes.activeSources
        )
      : null;
    const dependencyPermission = indexes.permissions?.get(dependency.sourceKey) || null;
    return {
      accountId,
      sourceKey: dependency.sourceKey,
      exists: Boolean(storedDependency || dependencyEvent),
      deleted: storedDependency
        ? storedDependency.deleted
        : dependencyEvent?.kind === "deleted",
      version: storedDependency?.version || dependencyEvent?.sourceRef.version || 0,
      contentSha256: dependencyEvent?.contentSha256 || "",
      permissionRevision: dependencyPermission?.revision || 0,
      contextAllowed: dependencyPermission?.contextAllowed === true,
      learningAllowed: dependencyPermission?.learningAllowed === true
    };
  });
  return {
    source: (storedSource || event) ? {
      accountId,
      sourceKey,
      exists: true,
      deleted: storedSource ? storedSource.deleted : event.kind === "deleted",
      version: storedSource?.version || event.sourceRef.version,
      contentSha256: event?.contentSha256 || ""
    } : null,
    permission,
    dependencies
  };
}

function derivedDependenciesUsable(
  store,
  evidence,
  accountId,
  purpose,
  indexes,
  evidenceBySourceKey,
  trail,
  memo
) {
  const memoKey = `${purpose}\u0000${evidence.id}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  if (trail.has(memoKey)) return false;
  trail.add(memoKey);
  let usable = true;
  for (const dependency of evidence.derivedFrom) {
    const derivedEvidence = list(evidenceBySourceKey.get(dependency.sourceKey)).filter(item => (
      item.sourceRef.version === dependency.version
      && item.contentSha256 === dependency.contentSha256
      && item.permissionRevision === dependency.permissionRevision
      && item.derivedFrom.length > 0
    ));
    const dependencyRef = parseEvidenceSourceKey(dependency.sourceKey);
    const dependencyState = dependencyRef
      ? storedSourceState(
          store,
          { ...dependencyRef, version: dependency.version },
          indexes.activeSources
        )
      : null;
    if (!derivedEvidence.length && dependencyState?.modelDerived) {
      usable = false;
      break;
    }
    for (const candidate of derivedEvidence) {
      const direct = evaluateEvidence(
        candidate,
        currentStateForEvidence(store, candidate, accountId, indexes),
        { accountId, purpose }
      );
      if (!direct.usable || !derivedDependenciesUsable(
        store,
        candidate,
        accountId,
        purpose,
        indexes,
        evidenceBySourceKey,
        trail,
        memo
      )) {
        usable = false;
        break;
      }
    }
    if (!usable) break;
  }
  trail.delete(memoKey);
  memo.set(memoKey, usable);
  return usable;
}

function validatedStoredCollections(store, accountId) {
  if (!objectValue(store)
    || !Array.isArray(store.evidenceSources)
    || !Array.isArray(store.evidencePermissions)
    || !Array.isArray(store.perceptionEvents)) {
    return null;
  }
  const evidenceSources = store.evidenceSources.map(normalizeEvidenceSource);
  const evidencePermissions = store.evidencePermissions.map(normalizeEvidencePermission);
  const perceptionEvents = store.perceptionEvents.map(normalizePerceptionEvent);
  if ([...evidenceSources, ...evidencePermissions, ...perceptionEvents].some(item => !item)) return null;
  if ([...evidenceSources, ...evidencePermissions, ...perceptionEvents]
    .some(item => item.accountId !== accountId)) {
    return { accountMismatch: true };
  }
  const identities = [
    evidenceSources.map(item => item.id),
    evidenceSources.map(evidenceFingerprint),
    evidencePermissions.map(item => item.sourceKey),
    perceptionEvents.map(item => item.id),
    perceptionEvents.map(evidenceEventKey)
  ];
  if (identities.some(values => new Set(values).size !== values.length)) return null;
  return { evidenceSources, evidencePermissions, perceptionEvents };
}

export function evaluateStoredEvidenceChecks(store, checks, {
  accountId,
  defaultPurpose = "context"
} = {}) {
  const expectedAccountId = requiredText(accountId, 100);
  if (!expectedAccountId || !Array.isArray(checks) || !PURPOSE_SET.has(defaultPurpose)) {
    return { usable: false, reasons: [EVIDENCE_ERROR_CODES.INVALID], results: [] };
  }
  if (!checks.length) return { usable: true, reasons: [], results: [] };
  const normalizedStore = validatedStoredCollections(store, expectedAccountId);
  if (normalizedStore?.accountMismatch) {
    return { usable: false, reasons: [EVIDENCE_ERROR_CODES.ACCOUNT_MISMATCH], results: [] };
  }
  if (!normalizedStore) {
    return { usable: false, reasons: [EVIDENCE_ERROR_CODES.INVALID], results: [] };
  }
  const evidenceById = new Map();
  const evidenceBySourceKey = new Map();
  for (const evidence of normalizedStore.evidenceSources) {
    evidenceById.set(evidence.id, evidence);
    const sourceKey = evidenceSourceKey(evidence.sourceRef);
    evidenceBySourceKey.set(sourceKey, [
      ...list(evidenceBySourceKey.get(sourceKey)),
      evidence
    ]);
  }
  const permissions = new Map(normalizedStore.evidencePermissions.map(item => [
    item.sourceKey,
    item
  ]));
  const latestEvents = new Map();
  for (const event of normalizedStore.perceptionEvents) {
    const sourceKey = evidenceSourceKey(event.sourceRef);
    const current = latestEvents.get(sourceKey);
    if (!current || compareEventsNewestFirst(event, current) < 0) {
      latestEvents.set(sourceKey, event);
    }
  }
  const activeSources = new Map();
  for (const collection of new Set(Object.values(SOURCE_COLLECTIONS))) {
    activeSources.set(collection, new Map(
      list(store[collection]).filter(item => item?.id).map(item => [item.id, item])
    ));
  }
  const indexes = { permissions, latestEvents, activeSources };
  const dependencyMemo = new Map();
  const seen = new Set();
  const results = [];
  for (const check of checks) {
    const evidenceId = requiredText(check?.evidenceId, 100);
    const expectedFingerprint = requiredText(check?.evidenceFingerprint, 64);
    const purpose = check?.purpose == null ? defaultPurpose : check.purpose;
    if (!evidenceId
      || seen.has(evidenceId)
      || !validHash(expectedFingerprint)
      || !PURPOSE_SET.has(purpose)) {
      return { usable: false, reasons: [EVIDENCE_ERROR_CODES.INVALID], results: [] };
    }
    seen.add(evidenceId);
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      results.push({
        evidenceId,
        purpose,
        usable: false,
        reasons: [EVIDENCE_ERROR_CODES.SOURCE_MISSING],
        currentVersion: 0,
        currentPermissionRevision: 0
      });
      continue;
    }
    if (evidenceFingerprint(evidence) !== expectedFingerprint) {
      results.push({
        evidenceId,
        purpose,
        usable: false,
        reasons: [EVIDENCE_ERROR_CODES.VERSION_STALE],
        currentVersion: evidence.sourceRef.version,
        currentPermissionRevision: evidence.permissionRevision
      });
      continue;
    }
    const evaluated = evaluateEvidence(
      evidence,
      currentStateForEvidence(
        { ...store, ...normalizedStore },
        evidence,
        expectedAccountId,
        indexes
      ),
      { accountId: expectedAccountId, purpose }
    );
    if (evaluated.usable && !derivedDependenciesUsable(
      { ...store, ...normalizedStore },
      evidence,
      expectedAccountId,
      purpose,
      indexes,
      evidenceBySourceKey,
      new Set(),
      dependencyMemo
    )) {
      evaluated.usable = false;
      addReason(evaluated.reasons, EVIDENCE_ERROR_CODES.DEPENDENCY_STALE);
    }
    results.push({
      evidenceId,
      purpose,
      ...evaluated
    });
  }
  return {
    usable: results.every(result => result.usable),
    reasons: sortUnique(results.flatMap(result => result.reasons)),
    results
  };
}

export function revokeEvidencePermissionsForResource(store, {
  accountId,
  resourceType,
  resourceId,
  targetId = ""
} = {}, updatedAt) {
  if (!Array.isArray(store?.evidencePermissions)) {
    throw new TypeError("Evidence permission revocation requires a valid store, source and timestamp");
  }
  accountId = requiredText(accountId, 100);
  resourceType = requiredText(resourceType, 40);
  resourceId = requiredText(resourceId, 100);
  targetId = optionalText(targetId, 100);
  updatedAt = requiredIso(updatedAt);
  if (!accountId
    || !resourceType
    || !resourceId
    || targetId === null
    || !updatedAt) {
    throw new TypeError("Evidence permission revocation requires a valid store, source and timestamp");
  }
  let changed = 0;
  store.evidencePermissions = store.evidencePermissions.map(value => {
    const permission = normalizeEvidencePermission(value);
    if (!permission) throw new TypeError("Evidence permission store contains an invalid record");
    if (permission.accountId !== accountId) {
      throw new TypeError("Evidence permission store contains a cross-account record");
    }
    const sourceRef = parseEvidenceSourceKey(permission.sourceKey);
    const targetMatches = !targetId
      || sourceRef.resourceId === targetId
      || sourceRef.targetKey.endsWith(`:${targetId}`);
    if (sourceRef.resourceType !== resourceType
      || !targetMatches
      || (sourceRef.resourceId !== resourceId && sourceRef.rootId !== resourceId)) {
      return permission;
    }
    changed += 1;
    return {
      ...permission,
      contextAllowed: false,
      learningAllowed: false,
      revision: permission.revision + 1,
      updatedAt
    };
  });
  return changed;
}

function sortUnique(values) {
  return [...new Set(values)].sort(compareText);
}
