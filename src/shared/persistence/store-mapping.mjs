import crypto from "node:crypto";

// Domain entities share an identity/ownership table. Nested content is extracted;
// unrecognized fields and archived trash payloads remain lossless JSON values.
const COLLECTIONS = {
  checkins: "checkin", dailyRecords: "dailyRecord", captures: "capture",
  journals: "journal", thoughts: "thought", chats: "chat", books: "book",
  keepsakes: "keepsake", quotes: "quote", experiments: "experiment",
  analyses: "analysis", recordCompressions: "recordCompression", customMetrics: "customMetric", trash: "trash",
  attachmentCleanup: "attachmentCleanup", aiTasks: "aiTask", notifications: "notification",
  actions: "action", habits: "habit", habitCheckins: "habitCheckin",
  feedback: "feedback", validationLedger: "validationLedger",
  userClaims: "userClaim", modelUnknowns: "modelUnknown",
  evidenceSources: "evidenceSource", evidencePermissions: "evidencePermission",
  perceptionEvents: "perceptionEvent"
};
const SINGLETONS = new Set(["journalDraft", "onboarding", "onboardingV2", "commercialization", "historicalUserSupplement"]);
const ANNOTATED = ["annotations", "annotationDrift"];
const CHILDREN = {
  thought: ["remarks", "followUps", ...ANNOTATED],
  capture: ANNOTATED, journal: ["reflections", ...ANNOTATED], chat: ANNOTATED,
  book: ["notes", ...ANNOTATED], quote: ANNOTATED, analysis: ANNOTATED,
  annotation: ["replies", "shenji"], annotationDrift: ["replies", "shenji"]
};
const CHILD_KINDS = {
  remarks: "thoughtRemark", followUps: "thoughtFollowUp", reflections: "journalReflection",
  notes: "bookNote", annotations: "annotation", annotationDrift: "annotationDrift",
  replies: "annotationReply", shenji: "annotationExchange"
};
const RESOURCE_COLLECTIONS = Object.fromEntries(Object.entries(COLLECTIONS).map(([key, value]) => [value, key]));
const OPTIONAL_AI_TASK_TARGET_KINDS = new Set([
  "thoughtDraft",
  "thoughtPrompt",
  "journalAssist",
  "chat",
  "analysis"
]);
const PERSISTENCE_FIELD = "_persistence";
const own = (object, key) => Object.hasOwn(object, key);
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keyOf = parts => JSON.stringify(parts);
const lifecycleOf = (item, kind) => item?.lifecycle === "draft" || kind === "journalDraft" ? "draft" : "formal";
const EVIDENCE_KINDS = new Set(["evidenceSource", "evidencePermission", "perceptionEvent"]);
const objectId = (item, kind) => kind === "evidencePermission" ? item?.sourceKey : item?.id;
const objectVersion = (item, kind) => (
  kind === "evidencePermission"
    ? item?.revision
    : EVIDENCE_KINDS.has(kind) ? 1 : item?.version
);
const sourceReference = sourceKey => {
  try {
    const value = JSON.parse(sourceKey);
    if (!Array.isArray(value)
      || value.length !== 4
      || typeof value[0] !== "string"
      || !value[0]
      || typeof value[1] !== "string"
      || !value[1]
      || typeof value[2] !== "string"
      || typeof value[3] !== "string"
      || JSON.stringify(value) !== sourceKey) {
      return null;
    }
    const [resourceType, resourceId, rootId, targetKey] = value;
    return { resourceType, resourceId, rootId, targetKey };
  } catch {
    return null;
  }
};
const validSourceRef = sourceRef => (
  objectValue(sourceRef)
  && typeof sourceRef.resourceType === "string"
  && Boolean(sourceRef.resourceType)
  && typeof sourceRef.resourceId === "string"
  && Boolean(sourceRef.resourceId)
  && typeof sourceRef.rootId === "string"
  && typeof sourceRef.targetKey === "string"
  && Number.isSafeInteger(sourceRef.version)
  && sourceRef.version > 0
);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (objectValue(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Non-JSON migration value");
  return text;
}

export const storeContentSha256 = store => crypto.createHash("sha256").update(canonicalJson(store)).digest("hex");

/**
 * 生成型任务的目标可只是结果标识，允许实体暂不存在；实体型主/子目标仍需存在。
 * 通知通过 taskId 还原任务语义，嵌套目标另保留 mapper 的既有 identity fallback。
 * required 仅描述活动状态下的持久化约束，不替代恢复时独立检查 requiresExisting*。
 */
export function aiTaskTargetReference(store, task) {
  const sourceTask = task?.kind === "aiTask"
    ? store?.aiTasks?.find(item => item?.id === task.taskId)
    : null;
  const taskKind = sourceTask?.kind || task?.kind;
  const taskPayload = sourceTask?.payload || task?.payload;
  if (task?.kind === "onboardingClaimExtraction") {
    return {
      collection: "onboardingV2",
      id: "onboardingV2",
      targetKey: keyOf(["onboardingV2"]),
      targetOptional: false,
      requiresExistingTarget: true,
      requiresExistingSubtarget: false,
      required: ["queued", "running"].includes(task.status),
      exists: Boolean(store?.onboardingV2 && typeof store.onboardingV2 === "object"),
      subtargetExists: true
    };
  }

  const collection = own(RESOURCE_COLLECTIONS, task?.resourceType)
    ? RESOURCE_COLLECTIONS[task.resourceType]
    : (["thoughtAnswer", "followUpAnswer"].includes(taskKind) ? "thoughts" : "");
  if (!collection) return null;

  const id = String(task.targetId ?? sourceTask?.targetId ?? "");
  const targetKey = keyOf([collection, id]);
  const optionalHistoricalCompression = taskKind === "recordCompression"
    && taskPayload?.operation === "historicalSupplement";
  const targetOptional = OPTIONAL_AI_TASK_TARGET_KINDS.has(taskKind) || optionalHistoricalCompression;
  const targetItems = Array.isArray(store?.[collection]) ? store[collection] : [];
  const targetItem = targetItems.find(item => (
    collection === "attachmentCleanup" ? item?.path === id : item?.id === id
  ));
  const targetExists = Boolean(targetItem);
  const subtargetField = taskKind === "followUpAnswer" ? "followUps" : "annotations";
  const requiresExistingSubtarget = ["followUpAnswer", "annotationShenji"].includes(taskKind)
    || (taskKind === "contentImageUnderstanding" && taskPayload?.targetType === "comment");
  const subtargetId = String(task.subtargetId ?? sourceTask?.subtargetId ?? "");
  const subtargetExists = !requiresExistingSubtarget || (
    Array.isArray(targetItem?.[subtargetField])
    && targetItem[subtargetField].some(item => item?.id === subtargetId)
  );

  return {
    collection,
    id,
    targetKey,
    targetOptional,
    requiresExistingTarget: !targetOptional,
    requiresExistingSubtarget,
    required: ["queued", "running"].includes(sourceTask?.status || task.status) && !targetOptional,
    exists: targetExists,
    subtargetId,
    subtargetField,
    subtargetTargetKey: keyOf([collection, id, subtargetField, subtargetId]),
    subtargetExists
  };
}

export function mapStoreObjects(accountId, store) {
  // Reject values that JSON/JSONB would silently change.
  if (canonicalJson(store) !== canonicalJson(JSON.parse(JSON.stringify(store)))) throw new Error("Lossy JSON migration value");
  const fields = [], objects = [], relations = [], attachmentRefs = [], lifecycles = [], idempotency = [];
  const identities = new Map();
  const originals = new Map();
  const evidenceIdentities = new Set();

  const attachments = (value, ownerKey, fieldName, segments = []) => {
    if (typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)) {
      attachmentRefs.push({ accountId, ownerKey, fieldName, valuePath: keyOf(segments), path: value });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) attachments(child, ownerKey, fieldName, [...segments, key]);
    }
  };

  const addObject = (item, { collection, kind, parentKey = null, field, position, parts, singleton = false, inheritedLifecycle = "" }) => {
    if (!objectValue(item)) throw new Error(`Invalid object in ${collection}.${field}`);
    if (EVIDENCE_KINDS.has(kind) && item.accountId !== accountId) {
      throw new Error(`Cross-account object in ${collection}.${field}`);
    }
    if (kind === "evidencePermission" && !sourceReference(item.sourceKey)) {
      throw new Error(`Invalid evidence permission source key in ${collection}.${field}`);
    }
    if (["evidenceSource", "perceptionEvent"].includes(kind) && !validSourceRef(item.sourceRef)) {
      throw new Error(`Invalid evidence source reference in ${collection}.${field}`);
    }
    if (kind === "evidenceSource" && (!Array.isArray(item.derivedFrom)
      || !item.derivedFrom.every(dependency => (
        objectValue(dependency) && Boolean(sourceReference(dependency.sourceKey))
      )))) {
      throw new Error(`Invalid evidence dependency in ${collection}.${field}`);
    }
    const evidenceIdentity = kind === "evidenceSource"
      ? canonicalJson(Object.fromEntries(Object.entries(item).filter(([key]) => (
          !["id", "recordedAt", "sourceTaskId"].includes(key)
        ))))
      : kind === "evidencePermission" ? item.sourceKey
        : kind === "perceptionEvent" ? canonicalJson({
          accountId: item.accountId,
          eventId: item.eventId,
          kind: item.kind,
          sourceRef: item.sourceRef,
          contentSha256: item.contentSha256,
          permissionRevision: item.permissionRevision,
          perceptionVersion: item.perceptionVersion
        }) : "";
    if (evidenceIdentity) {
      const scopedIdentity = `${kind}\u0000${evidenceIdentity}`;
      if (evidenceIdentities.has(scopedIdentity)) {
        throw new Error(`Duplicate evidence identity in ${collection}.${field}`);
      }
      evidenceIdentities.add(scopedIdentity);
    }
    const id = singleton
      ? field
      : kind === "attachmentCleanup" ? item.path : objectId(item, kind);
    if (typeof id !== "string" || !id) throw new Error(`Missing id in ${collection}.${field}`);
    const objectKey = keyOf([...parts, id]);
    if (identities.has(objectKey)) throw new Error(`Duplicate id in ${collection}.${field}: ${id}`);
    const childFields = [];
    const payload = structuredClone(item);
    const objectLifecycle = inheritedLifecycle || lifecycleOf(kind === "trash" ? item.payload : item, kind);
    const row = {
      accountId, objectKey, collection, kind, id, parentKey, field, position, childFields,
      content: ["content", "text", "message", "question", "title", "note"].map(key => item[key]).find(value => typeof value === "string") || "",
      status: typeof item.status === "string" ? item.status : "",
      authorType: typeof item.authorType === "string" ? item.authorType : "",
      version: Number.isSafeInteger(objectVersion(item, kind)) && objectVersion(item, kind) > 0
        ? objectVersion(item, kind)
        : 1,
      lifecycle: objectLifecycle,
      tombstone: kind === "trash",
      deletedAt: kind === "trash" ? item.deletedAt || null : null,
      payload
    };
    identities.set(objectKey, row);
    originals.set(objectKey, item);
    objects.push(row);
    for (const childField of CHILDREN[kind] || []) {
      if (!own(item, childField)) continue;
      if (!Array.isArray(item[childField])) throw new Error(`Expected array: ${collection}.${childField}`);
      childFields.push(childField);
      delete payload[childField];
      item[childField].forEach((child, index) => addObject(child, {
        collection, kind: CHILD_KINDS[childField], parentKey: objectKey, field: childField,
        position: index, parts: [...parts, id, childField], inheritedLifecycle: objectLifecycle
      }));
    }
    attachments(payload, objectKey, collection);
  };

  for (const [field, value] of Object.entries(store)) {
    if (field === PERSISTENCE_FIELD) {
      if (!objectValue(value) || !Array.isArray(value.lifecycles) || !Array.isArray(value.idempotency)) {
        throw new Error("Invalid persistence metadata");
      }
      const payload = structuredClone(value);
      delete payload.lifecycles;
      delete payload.idempotency;
      fields.push({ accountId, field, shape: "value", payload });
      for (const [position, item] of value.lifecycles.entries()) {
        lifecycles.push({
          accountId,
          position,
          resourceKey: item.resourceKey,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          lifecycle: item.lifecycle,
          state: item.state,
          tombstone: item.tombstone,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          deletedAt: item.deletedAt,
          restoredAt: item.restoredAt,
          purgedAt: item.purgedAt,
          trashId: item.trashId,
          history: structuredClone(item.history),
          payload: structuredClone(item)
        });
      }
      for (const [position, item] of value.idempotency.entries()) {
        idempotency.push({
          accountId,
          position,
          scope: item.scope,
          key: item.key,
          requestHash: item.requestHash,
          response: structuredClone(item.response),
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          payload: structuredClone(item)
        });
      }
    } else if (own(COLLECTIONS, field)) {
      if (!Array.isArray(value)) throw new Error(`Expected array: ${field}`);
      fields.push({ accountId, field, shape: "array", payload: null });
      value.forEach((item, position) => addObject(item, {
        collection: field, kind: COLLECTIONS[field], field, position, parts: [field]
      }));
    } else if (SINGLETONS.has(field) && value !== null) {
      fields.push({ accountId, field, shape: "object", payload: null });
      addObject(value, { collection: field, kind: field, field, position: 0, parts: [], singleton: true });
    } else {
      fields.push({ accountId, field, shape: "value", payload: structuredClone(value) });
      attachments(value, null, field);
    }
  }

  const link = (row, relation, collection, id, required = false, targetKey = keyOf([collection, id])) => {
    if (!id) {
      if (required) throw new Error(`Missing ${relation} reference in ${row.objectKey}`);
      return;
    }
    const target = identities.get(targetKey);
    if (required && (!target || (relation === "thoughtRoot" && originals.get(target.objectKey).type !== "question"))) {
      throw new Error(`Unresolved ${relation} reference in ${row.objectKey}`);
    }
    relations.push({
      accountId, objectKey: row.objectKey, relation, targetKey: target?.objectKey || null,
      targetCollection: collection, targetId: String(id), resolution: target ? "live" : "historical"
    });
  };
  const linkSource = (row, relation, sourceRef) => {
    if (!objectValue(sourceRef)) return;
    const collection = RESOURCE_COLLECTIONS[sourceRef.resourceType];
    if (!collection || !sourceRef.resourceId) return;
    const directKey = keyOf([collection, sourceRef.resourceId]);
    let targetKey = identities.has(directKey) ? directKey : null;
    if (!targetKey && sourceRef.rootId) {
      const candidates = objects.filter(candidate => {
        if (candidate.collection !== collection || candidate.id !== sourceRef.resourceId) return false;
        try {
          return JSON.parse(candidate.objectKey).includes(sourceRef.rootId);
        } catch {
          return false;
        }
      });
      if (candidates.length === 1) targetKey = candidates[0].objectKey;
    }
    link(row, relation, collection, sourceRef.resourceId, false, targetKey || directKey);
  };
  for (const row of objects) {
    const item = originals.get(row.objectKey);
    if (row.kind === "thought") {
      if (!["question", "idea", "answer", "record"].includes(item.type)) throw new Error(`Invalid thought type: ${row.id}`);
      if (item.type !== "question") {
        if (!item.relatedTo) throw new Error(`Thought without a root: ${row.id}`);
        link(row, "thoughtRoot", "thoughts", item.relatedTo, true);
      } else if (objectValue(item.sourceRef) && item.sourceRef.type === "capture") {
        link(row, "source", "captures", item.sourceRef.id);
      }
    }
    if (row.kind === "action" && objectValue(item.sourceRef)) {
      const collection = RESOURCE_COLLECTIONS[item.sourceRef.type];
      if (collection) link(row, "source", collection, item.sourceRef.id);
    }
    if (row.kind === "habitCheckin") link(row, "habit", "habits", item.habitId, true);
    if (row.kind === "userClaim") {
      link(row, "supersedes", "userClaims", item.supersedes);
      for (const [index, evidence] of (item.evidence || []).entries()) {
        if (evidence.sourceType === "onboardingV2Answer") {
          link(
            row,
            `evidence:${index}`,
            "onboardingV2",
            "onboardingV2",
            true,
            keyOf(["onboardingV2"])
          );
        }
      }
    }
    if (row.kind === "modelUnknown") {
      for (const [index, claimId] of (item.relatedEvidence || []).entries()) {
        link(row, `relatedEvidence:${index}`, "userClaims", claimId);
      }
      link(row, "resolvedBy", "userClaims", item.resolvedBy);
    }
    if (row.kind === "evidenceSource") {
      linkSource(row, "source", item.sourceRef);
      for (const [index, dependency] of (item.derivedFrom || []).entries()) {
        linkSource(row, `derivedFrom:${index}`, sourceReference(dependency.sourceKey));
      }
    }
    if (row.kind === "perceptionEvent") linkSource(row, "source", item.sourceRef);
    if (row.kind === "evidencePermission") {
      linkSource(row, "source", sourceReference(item.sourceKey));
    }
    if (row.kind === "journalDraft" && item.journalId) link(row, "journal", "journals", item.journalId, true);
    if (row.kind === "notification") link(row, "task", "aiTasks", item.taskId);
    if (row.kind === "aiTask" || row.kind === "notification") {
      const targetReference = aiTaskTargetReference(store, item);
      if (targetReference) {
        const required = row.kind === "aiTask" && targetReference.required;
        link(
          row,
          "target",
          targetReference.collection,
          targetReference.id,
          required,
          targetReference.targetKey
        );
        const collection = targetReference.collection;
        const childField = item.kind === "followUpAnswer" || (row.kind === "notification" && identities.has(keyOf([collection, item.targetId, "followUps", item.subtargetId])))
          ? "followUps" : "annotations";
        const subtargetTargetKey = row.kind === "notification"
          ? keyOf([collection, item.targetId, childField, item.subtargetId])
          : targetReference.subtargetTargetKey;
        const requiresSubtarget = required && targetReference.requiresExistingSubtarget;
        link(
          row,
          "subtarget",
          collection,
          targetReference.subtargetId,
          requiresSubtarget,
          subtargetTargetKey
        );
        const resultKey = item.kind === "followUpAnswer" ? keyOf([collection, item.targetId, "followUps", item.resultId])
          : item.kind === "annotationShenji" ? keyOf([collection, item.targetId, "annotations", item.subtargetId, "shenji", item.resultId])
            : keyOf([collection, item.resultId]);
        link(row, "result", collection, item.resultId, false, resultKey);
      }
      link(row, "retryOf", "aiTasks", item.retryOf);
    }
    link(row, "sourceTask", "aiTasks", item.sourceTaskId);
  }
  return { fields, objects, relations, attachmentRefs, lifecycles, idempotency };
}

export function rebuildStoreObjects({ fields, objects, lifecycles = [], idempotency = [] }) {
  const result = {};
  const byKey = new Map(), children = new Map();
  for (const row of objects) {
    if (byKey.has(row.objectKey)) throw new Error("Duplicate object key");
    byKey.set(row.objectKey, row);
    const group = keyOf([row.parentKey, row.field]);
    if (!children.has(group)) children.set(group, []);
    children.get(group).push(row);
  }
  const visited = new Set();
  const stableTuple = row => [
    String(row.payload?.occurredAt || row.payload?.occurredOn || row.payload?.createdAt || row.payload?.updatedAt || ""),
    String(row.id || row.resourceKey || row.key || "")
  ];
  const stableCompare = (left, right, descending = false) => {
    const a = stableTuple(left), b = stableTuple(right);
    const comparison = a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
    return descending ? -comparison : comparison;
  };
  const positionCompare = (left, right) => (
    left.position - right.position || stableCompare(left, right)
  );
  const assertUniquePositions = (rows, field) => {
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].position === rows[index].position) {
        throw new Error(`Duplicate positions: ${field}`);
      }
    }
  };
  const ordered = (parentKey, field) => {
    const rows = children.get(keyOf([parentKey, field])) || [];
    const positioned = rows.every(row => Number.isInteger(row.position));
    rows.sort(positioned
      ? positionCompare
      : (a, b) => stableCompare(a, b, parentKey === null));
    if (positioned) assertUniquePositions(rows, field);
    return rows;
  };
  const orderedMetadata = (rows, field) => {
    const result = [...rows];
    const positioned = result.every(row => Number.isInteger(row.position));
    result.sort(positioned ? positionCompare : stableCompare);
    if (positioned) assertUniquePositions(result, field);
    return result;
  };
  const rebuild = row => {
    if (visited.has(row.objectKey)) throw new Error("Cyclic or repeated ownership");
    visited.add(row.objectKey);
    if (!objectValue(row.payload)) throw new Error("Invalid object payload");
    const item = structuredClone(row.payload);
    for (const field of row.childFields) {
      if (own(item, field)) throw new Error(`Duplicate child field: ${field}`);
      Object.defineProperty(item, field, { value: ordered(row.objectKey, field).map(rebuild), enumerable: true, writable: true, configurable: true });
    }
    return item;
  };
  for (const field of fields) {
    if (own(result, field.field)) throw new Error("Duplicate store field");
    const rows = ordered(null, field.field);
    let value;
    if (field.field === PERSISTENCE_FIELD) {
      if (field.shape !== "value" || rows.length) throw new Error("Invalid persistence metadata field");
      value = {
        ...structuredClone(field.payload),
        version: Number(field.payload?.version) || 1,
        lifecycles: orderedMetadata(lifecycles, "lifecycles").map(item => ({
          ...structuredClone(item.payload),
          resourceKey: item.resourceKey,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          lifecycle: item.lifecycle,
          state: item.state,
          tombstone: item.tombstone,
          createdAt: item.createdAt || "",
          updatedAt: item.updatedAt || "",
          deletedAt: item.deletedAt || "",
          restoredAt: item.restoredAt || "",
          purgedAt: item.purgedAt || "",
          trashId: item.trashId || "",
          history: structuredClone(item.history)
        })),
        idempotency: orderedMetadata(idempotency, "idempotency").map(item => ({
          ...structuredClone(item.payload),
          scope: item.scope,
          key: item.key,
          requestHash: item.requestHash,
          response: structuredClone(item.response),
          createdAt: item.createdAt || "",
          expiresAt: item.expiresAt || ""
        }))
      };
    } else if (field.shape === "value") {
      if (rows.length) throw new Error("Unexpected value children");
      value = structuredClone(field.payload);
    } else if (field.shape === "array") value = rows.map(rebuild);
    else if (field.shape === "object" && rows.length === 1) value = rebuild(rows[0]);
    else throw new Error(`Invalid field shape: ${field.field}`);
    Object.defineProperty(result, field.field, { value, enumerable: true, writable: true, configurable: true });
  }
  if (visited.size !== objects.length) throw new Error("Orphan store objects");
  return result;
}
