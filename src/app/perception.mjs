import crypto from "node:crypto";
import {
  evidenceEventKey,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  normalizePerceptionEvent,
  parseEvidenceSourceKey,
  parsePerceptionExtractionOutput,
  perceptionExtractionSchema,
  PERCEPTION_MAX_SOURCE_CHARS,
  PERCEPTION_VERSION
} from "../modules/user-model/index.mjs";
import { recordVersion, safeIso, safeText } from "../shared/validation/index.mjs";
import { compileWorkingContextPrompt } from "./prompt-context.mjs";
import {
  taskContextSourceMaterial,
  workingContextProjection,
  workingContextReceiptFingerprint
} from "./task-context.mjs";

export const PERCEPTION_TASK_KIND = "perceptionExtraction";
export const PERCEPTION_PROMPT_SOURCE_BYTE_LIMIT = 12_000;

const list = value => Array.isArray(value) ? value : [];
const digest = value => crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
const sourceIdentity = sourceRef => evidenceSourceKey(sourceRef);
const sourcePromptBytes = text => Buffer.byteLength(JSON.stringify(String(text ?? "")), "utf8");
const modelAuthored = item => (
  item?.authorType === "ai"
  || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item?.origin || ""))
  || Boolean(item?.modelDraft)
  || Boolean(item?.sourceTaskId)
  || Boolean(item?.contextReceipt)
);
const mutationSourceCollections = [
  "checkins", "dailyRecords", "captures", "journals", "thoughts", "quotes", "keepsakes", "evidencePermissions"
];

function sourceMutationSnapshot(store) {
  return Object.fromEntries(mutationSourceCollections.map(collection => [
    collection,
    structuredClone(list(store?.[collection]))
  ]));
}

function sourceEventId(hash, accountId, sourceKey) {
  return `source:${hash(JSON.stringify([accountId, sourceKey])).slice(0, 64)}`;
}

function taskRequestId(hash, accountId, sourceRef, eventId, contentSha256, permissionRevision) {
  return `perception:${hash(JSON.stringify([
    accountId,
    sourceIdentity(sourceRef),
    eventId,
    sourceRef.version,
    contentSha256,
    permissionRevision,
    PERCEPTION_VERSION
  ])).slice(0, 64)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskInputHash(hash, payload, persistedInputHash = "") {
  const legacyPayload = {
    accountId: payload?.accountId || "",
    sourceRef: {
      resourceType: payload?.sourceRef?.resourceType || "",
      resourceId: payload?.sourceRef?.resourceId || "",
      rootId: payload?.sourceRef?.rootId || "",
      targetKey: payload?.sourceRef?.targetKey || "",
      version: payload?.sourceRef?.version || 0
    },
    perceptionEventId: payload?.perceptionEventId || "",
    eventId: payload?.eventId || "",
    contentSha256: payload?.contentSha256 || "",
    permissionRevision: payload?.permissionRevision || 0,
    perceptionVersion: payload?.perceptionVersion || ""
  };
  const legacyHash = hash(JSON.stringify(legacyPayload));
  if (persistedInputHash === legacyHash) return legacyHash;
  return hash(canonicalJson(payload || {}));
}

function sourceSnapshots(store) {
  const snapshots = new Map();
  const sourceIndexes = new Map([
    ["checkins", new Map(list(store?.checkins).filter(item => item?.id).map(item => [item.id, item]))],
    ["dailyRecords", new Map(list(store?.dailyRecords).filter(item => item?.id).map(item => [item.id, item]))],
    ["captures", new Map(list(store?.captures).filter(item => item?.id).map(item => [item.id, item]))],
    ["journals", new Map(list(store?.journals).filter(item => item?.id).map(item => [item.id, item]))],
    ["thoughts", new Map(list(store?.thoughts).filter(item => item?.id).map(item => [item.id, item]))]
  ]);
  const latestEventIds = new Map();
  for (const event of list(store?.perceptionEvents)) {
    const sourceKey = sourceIdentity(event?.sourceRef);
    if (sourceKey && event?.eventId) latestEventIds.set(sourceKey, event.eventId);
  }
  const latestEventId = sourceRef => {
    const sourceKey = sourceIdentity(sourceRef);
    return latestEventIds.get(sourceKey) || "";
  };
  const add = (sourceRef, occurredAt, eventId = "") => {
    const sourceKey = sourceIdentity(sourceRef);
    const source = sourceKey
      ? taskContextSourceMaterial(store, sourceRef, sourceIndexes)
      : null;
    if (!source) return;
    snapshots.set(sourceKey, {
      sourceRef,
      occurredAt: safeIso(occurredAt),
      eventId: safeText(eventId, 100) || latestEventIds.get(sourceKey) || "",
      version: source.version,
      contentSha256: source.contentSha256,
      text: safeText(source.text, 240)
    });
  };
  const addAnnotations = (resourceType, root) => {
    for (const annotation of list(root?.annotations)) {
      if (!safeText(annotation?.text || annotation?.quote, PERCEPTION_MAX_SOURCE_CHARS)) continue;
      add({
        resourceType,
        resourceId: annotation.id,
        rootId: root.id,
        targetKey: `annotation:${annotation.id}`,
        version: recordVersion(annotation.version)
      }, annotation.createdAt || root.occurredAt || root.createdAt);
      for (const reply of list(annotation.replies)) {
        add({
          resourceType,
          resourceId: reply.id,
          rootId: root.id,
          targetKey: `annotation-reply:${annotation.id}`,
          version: recordVersion(reply.version)
        }, reply.createdAt || annotation.createdAt || root.occurredAt || root.createdAt);
      }
    }
  };
  for (const checkin of list(store?.checkins)) {
    add({
      resourceType: "checkin",
      resourceId: checkin.id,
      rootId: "",
      targetKey: "",
      version: recordVersion(checkin.version)
    }, checkin.occurredAt || checkin.createdAt);
  }
  for (const record of list(store?.dailyRecords)) {
    add({
      resourceType: "dailyRecord",
      resourceId: record.id,
      rootId: "",
      targetKey: "",
      version: recordVersion(record.version)
    }, record.occurredAt || record.createdAt);
  }

  for (const capture of list(store?.captures)) {
    add({
      resourceType: "capture",
      resourceId: capture.id,
      rootId: "",
      targetKey: "",
      version: recordVersion(capture.version)
    }, capture.occurredAt || capture.createdAt, capture.perceptionEventId);
    const transcription = capture.transcription;
    if (transcription?.status === "ready"
      && safeText(
        transcription.condensedText
          || transcription.polishedText
          || transcription.rawText,
        PERCEPTION_MAX_SOURCE_CHARS
      )) {
      add({
        resourceType: "capture",
        resourceId: capture.id,
        rootId: "",
        targetKey: "transcription",
        version: recordVersion(transcription.version)
      }, capture.occurredAt || capture.createdAt, capture.perceptionEventId);
    }
    addAnnotations("capture", capture);
  }
  for (const journal of list(store?.journals)) {
    add({
      resourceType: "journal",
      resourceId: journal.id,
      rootId: "",
      targetKey: "",
      version: recordVersion(journal.version)
    }, journal.occurredAt || journal.createdAt, journal.perceptionEventId);
    addAnnotations("journal", journal);
  }
  const thoughts = list(store?.thoughts);
  for (const root of thoughts.filter(item => item?.type === "question")) {
    const linkedEventId = root.sourceRef?.type === "capture"
      ? latestEventId({
          resourceType: "capture",
          resourceId: root.sourceRef.id,
          rootId: "",
          targetKey: "",
          version: recordVersion(root.sourceRef.version)
        })
      : "";
    add({
      resourceType: "thought",
      resourceId: root.id,
      rootId: root.id,
      targetKey: `question:${root.id}`,
      version: recordVersion(root.version)
    }, root.occurredAt || root.createdAt, linkedEventId);
    addAnnotations("thought", root);
    for (const followUp of list(root.followUps)) {
      add({
        resourceType: "thought",
        resourceId: followUp.id,
        rootId: root.id,
        targetKey: `followup-question:${followUp.id}`,
        version: recordVersion(followUp.version)
      }, followUp.createdAt || root.occurredAt || root.createdAt);
      if (followUp.answer && !modelAuthored(followUp)) {
        add({
          resourceType: "thought",
          resourceId: followUp.id,
          rootId: root.id,
          targetKey: `followup-answer:${followUp.id}`,
          version: recordVersion(followUp.version)
        }, followUp.answeredAt || followUp.updatedAt || followUp.createdAt);
      }
    }
  }
  for (const item of thoughts.filter(value => (
    value?.type !== "question"
    && value?.relatedTo
    && !modelAuthored(value)
  ))) {
    add({
      resourceType: "thought",
      resourceId: item.id,
      rootId: item.relatedTo,
      targetKey: `${item.type}:${item.id}`,
      version: recordVersion(item.version)
    }, item.occurredAt || item.createdAt);
  }
  return snapshots;
}

const permissionRecordType = sourceRef => {
  const key = sourceRef?.targetKey || "";
  if (key === "transcription") return "语音转写";
  if (key.startsWith("annotation-reply:")) return "批注回复";
  if (key.startsWith("annotation:")) return "批注";
  if (key.startsWith("followup-question:")) return "思绪追问";
  if (key.startsWith("followup-answer:")) return "追问回答";
  if (key.startsWith("question:")) return "思绪问题";
  if (key.startsWith("idea:")) return "初步想法";
  if (key.startsWith("record:")) return "思绪记录";
  if (key.startsWith("answer:")) return "用户回答";
  return {
    checkin: "此刻状态",
    dailyRecord: "健康记录",
    capture: "念起",
    journal: "日记",
    thought: "思绪"
  }[sourceRef?.resourceType] || "原始记录";
};

export function evidencePermissionProjection(store, {
  accountId,
  limit = null
} = {}) {
  accountId = safeText(accountId, 100);
  if (!accountId) return [];
  const snapshots = sourceSnapshots(store);
  const permissions = new Map();
  for (const value of list(store?.evidencePermissions)) {
    const permission = normalizeEvidencePermission(value);
    if (!permission || permission.accountId !== accountId || permissions.has(permission.sourceKey)) {
      throw new Error("Perception permission state is invalid");
    }
    permissions.set(permission.sourceKey, permission);
  }
  const latestEvents = new Map();
  for (const event of list(store?.perceptionEvents)) {
    if (event?.accountId !== accountId) continue;
    const sourceKey = sourceIdentity(event.sourceRef);
    if (sourceKey) latestEvents.set(sourceKey, event);
  }
  const latestTasks = new Map();
  for (const task of list(store?.aiTasks)) {
    if (task?.kind !== PERCEPTION_TASK_KIND || task.payload?.accountId !== accountId) continue;
    const key = JSON.stringify([
      sourceIdentity(task.payload?.sourceRef),
      task.payload?.sourceRef?.version,
      task.payload?.contentSha256,
      task.payload?.permissionRevision
    ]);
    if (!latestTasks.has(key)) latestTasks.set(key, task);
  }
  const readyEvidence = new Set(list(store?.evidenceSources)
    .filter(evidence => evidence?.accountId === accountId)
    .map(evidence => JSON.stringify([
      sourceIdentity(evidence.sourceRef),
      evidence.sourceRef?.version,
      evidence.contentSha256,
      evidence.permissionRevision
    ])));
  const keys = new Set([...snapshots.keys(), ...permissions.keys()]);
  const projected = [...keys].map(sourceKey => {
    const snapshot = snapshots.get(sourceKey) || null;
    const event = latestEvents.get(sourceKey) || null;
    const permission = permissions.get(sourceKey) || {
      schemaVersion: 1,
      sourceKey,
      contextAllowed: true,
      learningAllowed: false,
      revision: 0,
      updatedAt: ""
    };
    const sourceRef = snapshot?.sourceRef
      || event?.sourceRef
      || { ...parseEvidenceSourceKey(sourceKey), version: 1 };
    const latestTask = latestTasks.get(JSON.stringify([
      sourceKey,
      sourceRef.version,
      snapshot?.contentSha256,
      permission.revision
    ]));
    const ready = readyEvidence.has(JSON.stringify([
      sourceKey,
      sourceRef.version,
      snapshot?.contentSha256,
      permission.revision
    ]));
    return {
      sourceKey,
      sourceRef,
      recordType: permissionRecordType(sourceRef),
      excerpt: safeText(snapshot?.text, 240),
      status: snapshot ? "active" : event?.kind === "deleted" ? "deleted" : "unavailable",
      contextAllowed: permission.contextAllowed,
      learningAllowed: permission.learningAllowed,
      revision: permission.revision,
      updatedAt: permission.updatedAt,
      learningStatus: permission.learningAllowed
        ? ready ? "ready" : latestTask?.status || "idle"
        : "off",
      occurredAt: snapshot?.occurredAt || event?.occurredAt || ""
    };
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return Number.isSafeInteger(limit) && limit > 0
    ? projected.slice(0, limit)
    : projected;
}

export function createPerceptionRuntime({
  getAccountId,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  hash = digest
} = {}) {
  if (typeof getAccountId !== "function"
    || typeof createId !== "function"
    || typeof now !== "function"
    || typeof hash !== "function") {
    throw new TypeError("Perception runtime dependencies are required");
  }

  function observeInStore(store, {
    sourceRef,
    occurredAt = "",
    contextAllowed,
    learningAllowed,
    expectedPermissionRevision = null,
    eventKind = "",
    eventId = ""
  } = {}, createTask) {
    const accountId = safeText(getAccountId(), 100);
    const sourceKey = sourceIdentity(sourceRef);
    const source = sourceKey ? taskContextSourceMaterial(store, sourceRef) : null;
    const recordedAt = safeIso(now());
    const priorEvents = list(store?.perceptionEvents).filter(item => (
      item?.accountId === accountId && sourceIdentity(item.sourceRef) === sourceKey
    ));
    const normalizedOccurredAt = safeIso(occurredAt)
      || priorEvents.findLast(item => safeIso(item?.occurredAt))?.occurredAt
      || recordedAt;
    if (!accountId || !sourceKey || !source || !recordedAt
      || Date.parse(normalizedOccurredAt) > Date.parse(recordedAt)) {
      return { skipped: true, reason: "SOURCE_NOT_ELIGIBLE", taskIds: [] };
    }
    if (source.version !== sourceRef.version) {
      return { skipped: true, reason: "SOURCE_NOT_ELIGIBLE", taskIds: [] };
    }
    store.evidencePermissions ||= [];
    const matches = store.evidencePermissions.filter(item => item?.sourceKey === sourceKey);
    if (matches.length > 1 || matches.some(item => item.accountId !== accountId)) {
      throw new Error("Perception permission state is invalid");
    }
    const previousPermission = matches[0] || null;
    if (expectedPermissionRevision != null
      && expectedPermissionRevision !== (previousPermission?.revision || 0)) {
      return {
        versionConflict: true,
        currentRevision: previousPermission?.revision || 0
      };
    }
    const nextContextAllowed = typeof contextAllowed === "boolean"
      ? contextAllowed
      : previousPermission?.contextAllowed ?? true;
    const nextLearningAllowed = typeof learningAllowed === "boolean"
      ? learningAllowed
      : previousPermission?.learningAllowed ?? false;
    const permissionChanged = Boolean(previousPermission) && (
      previousPermission.contextAllowed !== nextContextAllowed
      || previousPermission.learningAllowed !== nextLearningAllowed
    );
    if (previousPermission && !permissionChanged && eventKind === "permission_changed") {
      return {
        permission: previousPermission,
        unchanged: true,
        taskIds: []
      };
    }
    const permission = normalizeEvidencePermission({
      schemaVersion: 1,
      accountId,
      sourceKey,
      contextAllowed: nextContextAllowed,
      learningAllowed: nextLearningAllowed,
      revision: previousPermission
        ? previousPermission.revision + (permissionChanged ? 1 : 0)
        : 1,
      updatedAt: permissionChanged || !previousPermission
        ? recordedAt
        : previousPermission.updatedAt
    });
    if (!permission) throw new Error("Perception permission could not be normalized");
    if (previousPermission) {
      store.evidencePermissions[store.evidencePermissions.indexOf(previousPermission)] = permission;
    } else {
      store.evidencePermissions.push(permission);
    }

    const normalizedEventId = safeText(eventId, 100)
      || sourceEventId(hash, accountId, sourceKey);
    const normalizedEventKind = eventKind || (
      permissionChanged && priorEvents.some(item => item.sourceRef?.version === sourceRef.version)
        ? "permission_changed"
        : priorEvents.length ? "updated" : "created"
    );
    const event = normalizePerceptionEvent({
      schemaVersion: 1,
      id: `perception:${hash(JSON.stringify([
        accountId,
        normalizedEventId,
        normalizedEventKind,
        sourceKey,
        sourceRef.version,
        source.contentSha256,
        permission.revision,
        PERCEPTION_VERSION
      ])).slice(0, 64)}`,
      accountId,
      kind: normalizedEventKind,
      sourceRef,
      eventId: normalizedEventId,
      contentSha256: source.contentSha256,
      occurredAt: normalizedOccurredAt,
      recordedAt,
      permissionRevision: permission.revision,
      perceptionVersion: PERCEPTION_VERSION
    });
    if (!event) throw new Error("Perception event could not be normalized");
    store.perceptionEvents ||= [];
    if (!store.perceptionEvents.some(item => evidenceEventKey(item) === evidenceEventKey(event))) {
      store.perceptionEvents.push(event);
    }
    store.evidenceSources ||= [];
    const priorEvidence = store.evidenceSources.filter(item => (
      item?.accountId === accountId
      && sourceIdentity(item.sourceRef) === sourceKey
      && item.contentSha256 === source.contentSha256
      && (
        item.permissionRevision !== permission.revision
        || item.sourceRef?.version !== sourceRef.version
      )
      && list(item.derivedFrom).length === 0
    ));
    if (priorEvidence.length) {
      const existing = new Set(store.evidenceSources.map(evidenceFingerprint));
      const carried = [];
      for (const item of priorEvidence) {
        const next = normalizeEvidenceSource({
          ...item,
          id: safeText(createId(), 100),
          sourceRef,
          eventId: normalizedEventId,
          occurredAt: normalizedOccurredAt,
          recordedAt,
          permissionRevision: permission.revision
        });
        const fingerprint = evidenceFingerprint(next);
        if (!next || !fingerprint || existing.has(fingerprint)) continue;
        existing.add(fingerprint);
        store.evidenceSources.push(next);
        carried.push(next.id);
      }
      if (carried.length) {
        return {
          permission,
          event,
          evidenceIds: carried,
          taskIds: [],
          skipped: true,
          reason: "SOURCE_CONTENT_REUSED"
        };
      }
    }
    const alreadyProcessed = list(store.aiTasks).some(task => (
      task?.kind === PERCEPTION_TASK_KIND
      && task.status === "succeeded"
      && task.payload?.accountId === accountId
      && sourceIdentity(task.payload?.sourceRef) === sourceKey
      && task.payload?.contentSha256 === source.contentSha256
      && task.payload?.permissionRevision === permission.revision
      && task.payload?.perceptionVersion === PERCEPTION_VERSION
    ));
    if (alreadyProcessed) {
      return {
        permission,
        event,
        taskIds: [],
        skipped: true,
        reason: "SOURCE_CONTENT_ALREADY_PROCESSED"
      };
    }
    if (source.text.length > PERCEPTION_MAX_SOURCE_CHARS
      || sourcePromptBytes(source.text) > PERCEPTION_PROMPT_SOURCE_BYTE_LIMIT
      || !permission.learningAllowed
      || typeof createTask !== "function") {
      return {
        permission,
        event,
        taskIds: [],
        skipped: true,
        reason: source.text.length > PERCEPTION_MAX_SOURCE_CHARS
          || sourcePromptBytes(source.text) > PERCEPTION_PROMPT_SOURCE_BYTE_LIMIT
          ? "SOURCE_TOO_LARGE"
          : permission.learningAllowed
            ? "TASK_RUNTIME_UNAVAILABLE"
            : "LEARNING_NOT_ALLOWED"
      };
    }
    const requestId = taskRequestId(
      hash,
      accountId,
      sourceRef,
      normalizedEventId,
      source.contentSha256,
      permission.revision
    );
    const created = createTask({
      kind: PERCEPTION_TASK_KIND,
      resourceType: sourceRef.resourceType,
      targetId: sourceRef.rootId || sourceRef.resourceId,
      subtargetId: sourceRef.rootId ? sourceRef.resourceId : "",
      inputVersion: sourceRef.version,
      payload: {
        accountId,
        sourceRef,
        perceptionEventId: event.id,
        eventId: normalizedEventId,
        contentSha256: source.contentSha256,
        permissionRevision: permission.revision,
        perceptionVersion: PERCEPTION_VERSION
      },
      clientRequestId: requestId
    });
    return {
      permission,
      event,
      taskIds: created?.task?.status === "queued" ? [created.task.id] : [],
      task: created?.task || null,
      duplicate: created?.duplicate === true
    };
  }

  function prepare(store, task) {
    if (task?.kind !== PERCEPTION_TASK_KIND) return null;
    const accountId = safeText(getAccountId(), 100);
    if (!accountId || task.payload?.accountId !== accountId) return null;
    const sourceRef = task.payload?.sourceRef;
    const sourceKey = sourceIdentity(sourceRef);
    const source = sourceKey ? taskContextSourceMaterial(store, sourceRef) : null;
    const permissions = list(store?.evidencePermissions).filter(item => (
      item?.accountId === accountId && item.sourceKey === sourceKey
    ));
    const events = list(store?.perceptionEvents).filter(item => (
      item?.accountId === accountId
      && item.id === task.payload?.perceptionEventId
      && item.eventId === task.payload?.eventId
    ));
    const permission = permissions.length === 1 ? permissions[0] : null;
    const event = events.length === 1 ? events[0] : null;
    const expectedInputVersion = task.inputVersion
      || task.requestedInputVersion
      || sourceRef?.version;
    if (!source
      || source.text.length > PERCEPTION_MAX_SOURCE_CHARS
      || sourcePromptBytes(source.text) > PERCEPTION_PROMPT_SOURCE_BYTE_LIMIT
      || source.version !== expectedInputVersion
      || source.contentSha256 !== task.payload?.contentSha256
      || !permission
      || permission.learningAllowed !== true
      || permission.revision !== task.payload?.permissionRevision
      || !event
      || task.payload?.perceptionVersion !== PERCEPTION_VERSION
      || event.perceptionVersion !== task.payload?.perceptionVersion
      || event.contentSha256 !== source.contentSha256
      || sourceIdentity(event.sourceRef) !== sourceKey
      || event.sourceRef.version !== sourceRef.version) {
      return null;
    }
    const workingContext = workingContextProjection(store, {
      accountId,
      scene: PERCEPTION_TASK_KIND,
      task: {
        kind: PERCEPTION_TASK_KIND,
        text: "提取当前来源中的原子证据。",
        targetId: task.targetId,
        subtargetId: task.subtargetId || ""
      },
      currentMaterial: [{
        id: `current:${sourceKey}`,
        accountId,
        text: source.text,
        recordType: "待感知原文",
        origin: "user",
        informationType: "user_viewpoint",
        contextAllowed: permission.learningAllowed,
        validation: "content",
        occurredAt: event.occurredAt,
        sourceRef
      }],
      generatedAt: task.createdAt,
      maxHistorical: 0,
      retrieveHistorical: () => [],
      compilePrompt: sections => compileWorkingContextPrompt({
        ...sections,
        scene: PERCEPTION_TASK_KIND,
        taskDetails: {
          sourceRef,
          eventId: event.eventId,
          permissionRevision: permission.revision,
          perceptionVersion: event.perceptionVersion,
          outputSchema: JSON.parse(perceptionExtractionSchema())
        }
      })
    });
    return {
      source: {
        sourceRef,
        text: source.text,
        contentSha256: source.contentSha256,
        occurredAt: event.occurredAt,
        eventId: event.eventId,
        permissionRevision: permission.revision
      },
      inputVersion: source.version,
      inputHash: taskInputHash(hash, task.payload, task.inputHash),
      prompt: workingContext.prompt,
      scene: PERCEPTION_TASK_KIND,
      json: true,
      auditPrompt: false,
      maxTokens: 3000,
      contextReceipt: workingContext.receipt,
      contextFingerprint: workingContextReceiptFingerprint(workingContext.receipt)
    };
  }

  function save(store, work, task, result) {
    const current = prepare(store, task);
    if (!current || current.contextFingerprint !== work.contextFingerprint) {
      throw Object.assign(new Error("感知来源已经变化，结果未写入"), {
        code: "PERCEPTION_STALE"
      });
    }
    const evidence = parsePerceptionExtractionOutput(result.content, {
      accountId: getAccountId(),
      source: work.source,
      sourceTaskId: task.id,
      createId,
      now
    });
    store.evidenceSources ||= [];
    const existing = new Set(store.evidenceSources.map(evidenceFingerprint));
    const inserted = [];
    for (const item of evidence) {
      const fingerprint = evidenceFingerprint(item);
      if (!fingerprint || existing.has(fingerprint)) continue;
      existing.add(fingerprint);
      store.evidenceSources.push(item);
      inserted.push(item.id);
    }
    return inserted[0] || task.id;
  }

  function result(store, task) {
    if (task?.kind !== PERCEPTION_TASK_KIND || task.status !== "succeeded") return null;
    const accountId = safeText(getAccountId(), 100);
    const sourceKey = sourceIdentity(task.payload?.sourceRef);
    return {
      evidence: list(store?.evidenceSources).filter(item => (
        item.accountId === accountId
        && sourceIdentity(item.sourceRef) === sourceKey
        && item.sourceRef.version === task.inputVersion
        && item.eventId === task.payload?.eventId
        && item.permissionRevision === task.payload?.permissionRevision
      ))
    };
  }

  function recordLifecycleInStore(store, source, kind) {
    if (!["deleted", "restored"].includes(kind)) {
      throw new TypeError("Perception lifecycle event kind is invalid");
    }
    const accountId = safeText(getAccountId(), 100);
    const sourceKey = sourceIdentity(source?.sourceRef);
    const recordedAt = safeIso(now());
    if (!accountId
      || !sourceKey
      || !source?.contentSha256
      || !recordedAt) {
      throw new TypeError("Perception lifecycle source is invalid");
    }
    store.evidencePermissions ||= [];
    const matches = store.evidencePermissions.filter(item => item?.sourceKey === sourceKey);
    if (matches.length > 1 || matches.some(item => item.accountId !== accountId)) {
      throw new Error("Perception permission state is invalid");
    }
    let permission = matches[0] || null;
    if (!permission) {
      permission = normalizeEvidencePermission({
        schemaVersion: 1,
        accountId,
        sourceKey,
        contextAllowed: false,
        learningAllowed: false,
        revision: 1,
        updatedAt: recordedAt
      });
      store.evidencePermissions.push(permission);
    } else if (kind === "deleted"
      && (permission.contextAllowed || permission.learningAllowed)) {
      permission = normalizeEvidencePermission({
        ...permission,
        contextAllowed: false,
        learningAllowed: false,
        revision: permission.revision + 1,
        updatedAt: recordedAt
      });
      store.evidencePermissions[store.evidencePermissions.indexOf(matches[0])] = permission;
    }
    const eventId = safeText(source.eventId, 100)
      || sourceEventId(hash, accountId, sourceKey);
    const event = normalizePerceptionEvent({
      schemaVersion: 1,
      id: `perception:${hash(JSON.stringify([
        accountId,
        eventId,
        kind,
        sourceKey,
        source.sourceRef.version,
        source.contentSha256,
        permission.revision,
        PERCEPTION_VERSION
      ])).slice(0, 64)}`,
      accountId,
      kind,
      sourceRef: source.sourceRef,
      eventId,
      contentSha256: source.contentSha256,
      occurredAt: safeIso(source.occurredAt) || recordedAt,
      recordedAt,
      permissionRevision: permission.revision,
      perceptionVersion: PERCEPTION_VERSION
    });
    if (!event) throw new Error("Perception lifecycle event could not be normalized");
    store.perceptionEvents ||= [];
    if (!store.perceptionEvents.some(item => evidenceEventKey(item) === evidenceEventKey(event))) {
      store.perceptionEvents.push(event);
    }
    return { permission, event };
  }

  return Object.freeze({
    observeInStore,
    prepare,
    projectPermissions(store, options = {}) {
      return evidencePermissionProjection(store, {
        accountId: getAccountId(),
        ...options
      });
    },
    recordLifecycleInStore,
    result,
    save
  });
}

function changedSources(before, store) {
  const after = sourceSnapshots(store);
  const upserts = [...after.entries()]
    .filter(([sourceKey, current]) => {
      const previous = before.get(sourceKey);
      return !previous
        || previous.version !== current.version
        || previous.contentSha256 !== current.contentSha256
        || previous.eventId !== current.eventId;
    })
    .map(([sourceKey, current]) => {
      const previousEvent = list(store?.perceptionEvents).findLast(item => (
        sourceIdentity(item?.sourceRef) === sourceKey
      ));
      return {
        ...current,
        ...(!before.has(sourceKey) && previousEvent?.kind === "deleted"
          ? { eventKind: "restored" }
          : {})
      };
    });
  const deleted = [...before.entries()]
    .filter(([sourceKey]) => !after.has(sourceKey))
    .map(([, previous]) => previous);
  return { upserts, deleted };
}

export function createPerceptionAwareRepository({
  repository,
  perception,
  createTask,
  scheduleTask,
  onStoreMutation = () => {}
} = {}) {
  if (!repository?.read
    || !repository?.update
    || typeof perception?.observeInStore !== "function"
    || typeof perception?.recordLifecycleInStore !== "function"
    || typeof createTask !== "function"
    || typeof scheduleTask !== "function"
    || typeof onStoreMutation !== "function") {
    throw new TypeError("Perception-aware repository dependencies are required");
  }
  const observeChanges = (before, store, taskIds) => {
    const changes = changedSources(before, store);
    for (const source of changes.deleted) {
      perception.recordLifecycleInStore(store, source, "deleted");
    }
    for (const source of changes.upserts) {
      const observed = perception.observeInStore(
        store,
        source,
        input => createTask(store, input)
      );
      taskIds.push(...list(observed.taskIds));
    }
  };
  const schedule = taskIds => {
    for (const taskId of new Set(taskIds)) {
      try {
        scheduleTask(taskId);
      } catch {
        // The durable queued task is recovered on the next startup.
      }
    }
  };
  const awareRepository = {
    ...repository,
    async update(operation) {
      const taskIds = [];
      const result = await repository.update(async store => {
        const beforeStore = sourceMutationSnapshot(store);
        const before = sourceSnapshots(store);
        const value = await operation(store);
        observeChanges(before, store, taskIds);
        onStoreMutation(store, beforeStore);
        return value;
      });
      schedule(taskIds);
      return result;
    },
    async executeIdempotent(request, operation, options) {
      if (typeof repository.executeIdempotent !== "function") {
        throw new TypeError("Perception-aware repository requires executeIdempotent()");
      }
      const taskIds = [];
      const result = await repository.executeIdempotent(
        request,
        async store => {
          const beforeStore = sourceMutationSnapshot(store);
          const before = sourceSnapshots(store);
          const value = await operation(store);
          observeChanges(before, store, taskIds);
          onStoreMutation(store, beforeStore);
          return value;
        },
        options
      );
      schedule(taskIds);
      return result;
    }
  };
  if (typeof repository.transact === "function") {
    awareRepository.transact = async operation => {
      const taskIds = [];
      const result = await repository.transact(async context => {
        let beforeStore = sourceMutationSnapshot(context.document);
        let beforeSources = sourceSnapshots(context.document);
        const commit = context.commit;
        return operation({
          ...context,
          async commit(...args) {
            observeChanges(beforeSources, context.document, taskIds);
            onStoreMutation(context.document, beforeStore);
            const value = await commit(...args);
            beforeStore = sourceMutationSnapshot(context.document);
            beforeSources = sourceSnapshots(context.document);
            return value;
          }
        });
      });
      schedule(taskIds);
      return result;
    };
  }
  return awareRepository;
}

export function createPerceptionService({
  repository,
  runtime,
  backgroundAi
} = {}) {
  if (!repository?.read
    || !repository?.update
    || typeof runtime?.observeInStore !== "function"
    || typeof backgroundAi?.createInStore !== "function"
    || typeof backgroundAi?.schedule !== "function") {
    throw new TypeError("Perception service dependencies are required");
  }
  return Object.freeze({
    async listPermissions({ afterId = "", limit = 50 } = {}) {
      const items = runtime.projectPermissions(await repository.read());
      const start = afterId
        ? items.findIndex(item => item.sourceKey === afterId) + 1
        : 0;
      if (afterId && start === 0) return { invalidCursor: true, items: [], nextId: "" };
      const page = items.slice(start, start + limit);
      return {
        items: page,
        nextId: start + page.length < items.length ? page.at(-1)?.sourceKey || "" : "",
        total: items.length
      };
    },
    async observe(input) {
      const observed = await repository.update(store => runtime.observeInStore(
        store,
        input,
        taskInput => backgroundAi.createInStore(store, taskInput)
      ));
      for (const taskId of new Set(list(observed.taskIds))) {
        try {
          backgroundAi.schedule(taskId);
        } catch {
          // The durable queued task is recovered on the next startup.
        }
      }
      return observed;
    },
    async updatePermissions({
      sourceRef,
      contextAllowed,
      learningAllowed,
      expectedRevision
    } = {}) {
      if (typeof contextAllowed !== "boolean"
        || typeof learningAllowed !== "boolean"
        || !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 0) {
        return { invalid: true };
      }
      const observed = await repository.update(store => {
        const source = sourceSnapshots(store).get(sourceIdentity(sourceRef));
        if (!source || source.version !== sourceRef?.version) {
          return { skipped: true, reason: "SOURCE_NOT_ELIGIBLE", taskIds: [] };
        }
        return runtime.observeInStore(
          store,
          {
            sourceRef,
            contextAllowed,
            learningAllowed,
            expectedPermissionRevision: expectedRevision,
            eventKind: "permission_changed"
          },
          taskInput => backgroundAi.createInStore(store, taskInput)
        );
      });
      for (const taskId of new Set(list(observed.taskIds))) {
        try {
          backgroundAi.schedule(taskId);
        } catch {
          // The durable queued task is recovered on the next startup.
        }
      }
      return observed;
    }
  });
}
