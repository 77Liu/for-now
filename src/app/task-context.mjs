import { describeDailyRecord } from "../modules/health/index.mjs";
import { readInternalBudgets, estimateInternalTokens, createImportanceSelectionPlan, applyImportanceSelectionPlan, RELATED_REFERENCE_SHARE_MAX } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import crypto from "node:crypto";
import {
  EVIDENCE_ERROR_CODES,
  evaluateStoredEvidenceChecks,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  parseEvidenceSourceKey
} from "../modules/user-model/index.mjs";
import { recordVersion, safeIso, safeText } from "../shared/validation/index.mjs";
import {
  compactPersonalContextReceipt,
  personalContextReceiptFingerprint,
  personalContextReceiptMatches
} from "./personal-context.mjs";

export const WORKING_CONTEXT_VERSION = "2026.10.09.1";
export const WORKING_CONTEXT_PROMPT_BYTE_BUDGET = readInternalBudgets().promptByteHard;
export const WORKING_CONTEXT_TOKEN_BUDGET = WORKING_CONTEXT_PROMPT_BYTE_BUDGET;
export const WORKING_CONTEXT_RECEIPT_ITEM_LIMIT = 100;
export const WORKING_CONTEXT_RECEIPT_BYTE_LIMIT = 192 * 1024;
const HISTORY_RELEVANCE_MIN_SCORE = 6;
const SEARCH_STOP_TERMS = new Set([
  "h2:记录",
  "h2:当前",
  "h2:今天",
  "h2:问题",
  "h2:回答",
  "h2:内容",
  "h2:历史",
  "h2:材料",
  "p:unrel",
  "w:an",
  "w:about",
  "w:current",
  "w:from",
  "w:plan",
  "w:project",
  "w:that",
  "w:this",
  "w:unrelated",
  "w:with",
  "w:your"
]);
const SEARCH_CONCEPTS = Object.freeze([
  Object.freeze({
    id: "outcome",
    terms: new Set(["effective", "failed", "outcome", "result", "succeeded", "worked"])
  }),
  Object.freeze({
    id: "history",
    terms: new Set(["earlier", "historical", "last", "previous", "prior"])
  })
]);

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
const SOURCE_VIEWS = Object.freeze({
  checkin: "today",
  dailyRecord: "daily",
  capture: "captures",
  journal: "journals",
  thought: "thoughts",
  chat: "review",
  book: "books",
  keepsake: "keepsakes",
  quote: "quotes",
  analysis: "review",
  userClaim: "personal-context",
  modelUnknown: "personal-context"
});

const list = value => Array.isArray(value) ? value : [];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = value => crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validDateOnly = value => (
  typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && safeIso(`${value}T00:00:00.000Z`).slice(0, 10) === value
);
const fail = (message, code) => {
  throw Object.assign(new Error(message), { code });
};
const sourceIdentity = sourceRef => evidenceSourceKey({
  resourceType: sourceRef?.resourceType,
  resourceId: sourceRef?.resourceId,
  rootId: sourceRef?.rootId || "",
  targetKey: sourceRef?.targetKey || "",
  version: recordVersion(sourceRef?.version)
});

function normalizedTask(value) {
  const kind = safeText(value?.kind, 40);
  const text = safeText(value?.text, 50_000);
  const targetId = safeText(value?.targetId, 100);
  const subtargetId = safeText(value?.subtargetId, 100);
  const eventId = safeText(value?.eventId, 100);
  const eventScoped = value?.eventScoped === true;
  if (!kind || !text) fail("Working context requires a task kind and text", "TASK_CONTEXT_INVALID");
  return { kind, text, targetId, subtargetId, eventId, eventScoped };
}

// Read the existing account/source-key permission contract; absence is revision zero.
export function taskContextSourcePermission(store, sourceRef, accountId) {
  const sourceKey = sourceIdentity(sourceRef);
  if (!sourceKey || !safeText(accountId, 100)) {
    fail("Current source permission identity is invalid", "CURRENT_MATERIAL_INVALID");
  }
  const matches = list(store?.evidencePermissions).filter(item => item?.sourceKey === sourceKey);
  if (!matches.length) return { contextAllowed: true, permissionRevision: 0 };
  const permission = matches.length === 1 ? normalizeEvidencePermission(matches[0]) : null;
  if (!permission || permission.accountId !== accountId) {
    fail("Current source permission state is invalid", "CURRENT_MATERIAL_PERMISSION_INVALID");
  }
  return { contextAllowed: permission.contextAllowed, permissionRevision: permission.revision };
}

const permissionChecksValid = checks => Array.isArray(checks) && checks.every(check => (
  parseEvidenceSourceKey(check?.sourceKey)
  && Number.isSafeInteger(check.permissionRevision)
  && check.permissionRevision >= 0
));

function permissionChecksMatch(store, checks, accountId) {
  if (!permissionChecksValid(checks)) return false;
  try {
    return checks.every(check => {
      const current = taskContextSourcePermission(store, parseEvidenceSourceKey(check.sourceKey), accountId);
      return current.contextAllowed && current.permissionRevision === check.permissionRevision;
    });
  } catch {
    return false;
  }
}

function legacyDependenciesValid(values) {
  if (!Array.isArray(values) || values.length > WORKING_CONTEXT_RECEIPT_ITEM_LIMIT) return false;
  try {
    return Buffer.byteLength(JSON.stringify(values), "utf8") <= WORKING_CONTEXT_RECEIPT_BYTE_LIMIT
      && values.every(receipt => receipt && typeof receipt === "object" && !Array.isArray(receipt)
        && receipt.schemaVersion !== 2 && validDigest(receipt.promptSha256)
        && Array.isArray(receipt.sources)
        && receipt.sources.every(source => source && !Object.hasOwn(source, "excerpt")));
  } catch {
    return false;
  }
}

function normalizedLegacyDependencies(store, values) {
  if (!Array.isArray(values)) {
    fail("Legacy context dependencies are invalid", "CURRENT_MATERIAL_LEGACY_INVALID");
  }
  const unique = new Map();
  for (const value of values) {
    const compact = compactPersonalContextReceipt(value);
    if (!supplementalImportanceReceiptMatches(store, compact?.importanceReferences)
      || !legacyDependenciesValid([compact])) {
      fail("Legacy context dependency cannot be converted", "CURRENT_MATERIAL_LEGACY_INVALID");
    }
    const fingerprint = personalContextReceiptFingerprint(compact);
    if (!unique.has(fingerprint)) {
      if (!personalContextReceiptMatches(store, compact)) {
        fail("Legacy context dependency changed", "CURRENT_MATERIAL_LEGACY_STALE");
      }
      unique.set(fingerprint, compact);
    }
    if (unique.size > WORKING_CONTEXT_RECEIPT_ITEM_LIMIT) {
      fail("Legacy context dependencies exceed their budget", "WORKING_CONTEXT_RECEIPT_TOO_LARGE");
    }
  }
  const dependencies = [...unique.values()];
  if (!legacyDependenciesValid(dependencies)) {
    fail("Legacy context dependencies exceed their budget", "WORKING_CONTEXT_RECEIPT_TOO_LARGE");
  }
  return dependencies;
}

function legacyDependenciesMatch(store, values) {
  if (!legacyDependenciesValid(values)) return false;
  try { return values.every(receipt => supplementalImportanceReceiptMatches(store, receipt.importanceReferences)
    && personalContextReceiptMatches(store, receipt)); }
  catch { return false; }
}

// Preserve the existing legacy matcher, including content/version and learning-purpose checks.
export function contextDerivedLegacyDependencies(store, item) {
  const receipt = item?.contextReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || (receipt.schemaVersion === 2 && !workingContextReceiptFingerprint(receipt))) {
    fail("Derived context receipt is invalid", "CURRENT_MATERIAL_LEGACY_INVALID");
  }
  return normalizedLegacyDependencies(store, receipt.schemaVersion === 2
    ? receipt.legacyDependencies : [receipt]);
}

function explicitCurrentRequest(item, task) {
  const ref = item.sourceRef;
  if (item.authorization !== "current-request") return false;
  return (ref.resourceType === "thought" && (
    (task.kind === "thoughtAnswer" && ref.resourceId === task.targetId && ref.rootId === task.targetId
      && ref.targetKey === `question:${task.targetId}`)
    || (task.kind === "followUpAnswer" && ref.rootId === task.targetId
      && ref.resourceId === task.subtargetId && ref.targetKey === `followup-question:${task.subtargetId}`)
  )) || (task.kind === "annotationShenji" && ref.resourceType === "annotationRequest"
    && ref.rootId === task.targetId && item.validation === "immutable");
}

function normalizedCurrentMaterial(values, accountId, store, task) {
  if (!Array.isArray(values) || !values.length) {
    fail("Working context requires current material", "CURRENT_MATERIAL_REQUIRED");
  }
  const seen = new Set();
  return values.map((value, index) => {
    const id = safeText(value?.id, 200);
    const attachmentPaths = [...new Set(list(value?.attachmentPaths)
      .filter(path => typeof path === "string" && /^\/attachments\/[\w.-]+$/.test(path)))];
    const text = safeText(value?.text, 120_000) || (attachmentPaths.length ? "（图片原文）" : "");
    const materialAccountId = safeText(value?.accountId, 100);
    const sourceKey = sourceIdentity(value?.sourceRef);
    const evidenceChecks = list(value?.evidenceChecks).map(check => ({
      evidenceId: safeText(check?.evidenceId, 100),
      evidenceFingerprint: safeText(check?.evidenceFingerprint, 64),
      purpose: check?.purpose === "learning" ? "learning" : "context"
    }));
    if (!id || seen.has(id) || !text || !sourceKey || value?.contextAllowed === false) {
      fail("Working context current material is invalid", "CURRENT_MATERIAL_INVALID");
    }
    if (materialAccountId && materialAccountId !== accountId) {
      fail("Working context current material belongs to another account", "CURRENT_MATERIAL_ACCOUNT_MISMATCH");
    }
    if (evidenceChecks.some(check => !check.evidenceId || !validDigest(check.evidenceFingerprint))) {
      fail("Working context current material evidence is invalid", "CURRENT_MATERIAL_INVALID");
    }
    if (!evaluateStoredEvidenceChecks(store, evidenceChecks, { accountId }).usable) {
      fail("Working context current evidence changed", "CURRENT_MATERIAL_EVIDENCE_STALE");
    }
    if (!rawSourceChecksMatch(store, value.rawSourceChecks ?? [], accountId)) {
      fail("Working context original source dependency changed", "CURRENT_MATERIAL_EVIDENCE_STALE");
    }
    const legacyDependencies = normalizedLegacyDependencies(store, value.legacyDependencies ?? []);
    const authorization = explicitCurrentRequest(value, task) ? "current-request" : "source-permission";
    const permission = taskContextSourcePermission(store, value.sourceRef, accountId);
    const permissionChecks = value.permissionChecks == null ? [] : value.permissionChecks;
    if ((!permission.contextAllowed && authorization !== "current-request")
      || !permissionChecksMatch(store, permissionChecks, accountId)) {
      fail("Working context current source permission changed", "CURRENT_MATERIAL_PERMISSION_DENIED");
    }
    seen.add(id);
    const sourceRef = {
      resourceType: safeText(value.sourceRef.resourceType, 40),
      resourceId: safeText(value.sourceRef.resourceId, 100),
      rootId: safeText(value.sourceRef.rootId, 100),
      targetKey: safeText(value.sourceRef.targetKey, 120),
      version: recordVersion(value.sourceRef.version)
    };
    return {
      id,
      accountId,
      channel: "current",
      text,
      attachmentPaths,
      sourceRef,
      sourceKey,
      settledVersion: Number.isSafeInteger(value.settledVersion)
        && value.settledVersion >= sourceRef.version
        ? value.settledVersion
        : sourceRef.version,
      contentSha256: digest(JSON.stringify({ text, attachmentPaths })),
      occurredAt: safeText(value.occurredAt, 100),
      recordType: safeText(value.recordType, 80) || "当前材料",
      origin: safeText(value.origin, 40) || "user",
      informationType: safeText(value.informationType, 40) || "user_viewpoint",
      contextAllowed: value.contextAllowed !== false,
      validation: ["version", "immutable"].includes(value.validation)
        ? value.validation
        : "content",
      evidenceChecks,
      rawSourceChecks: list(value.rawSourceChecks).map(check => ({ ...check })),
      authorization,
      permissionRevision: permission.permissionRevision,
      permissionChecks: permissionChecks.map(check => ({ ...check })),
      legacyDependencies,
      chainId: safeText(value.chainId, 100),
      chainOrder: Number.isSafeInteger(value.chainOrder) ? value.chainOrder : index
    };
  });
}

function activeSourceIndexes(store) {
  return new Map([...new Set(Object.values(SOURCE_COLLECTIONS))].map(collection => [
    collection,
    new Map(list(store?.[collection]).filter(item => item?.id).map(item => [item.id, item]))
  ]));
}

function currentMaterialEventId(store, accountId, currentMaterial) {
  const currentVersionsByKey = new Map();
  for (const item of currentMaterial) {
    if (!item?.sourceKey) continue;
    const versions = currentVersionsByKey.get(item.sourceKey) || new Set();
    versions.add(item.sourceRef.version);
    currentVersionsByKey.set(item.sourceKey, versions);
  }
  if (!currentVersionsByKey.size) return "";
  const eventIds = new Set(list(store?.perceptionEvents)
    .filter(event => (
      event?.accountId === accountId
      && event?.eventId
      && currentVersionsByKey.get(sourceIdentity(event.sourceRef))
        ?.has(recordVersion(event.sourceRef?.version))
    ))
    .map(event => event.eventId));
  return eventIds.size === 1 ? [...eventIds][0] : "";
}

function hasDeicticEventReference(value) {
  const text = String(value ?? "");
  const englishReference = (
    /\b(?:this|that|these|those)(?:\s+[\p{L}\p{N}-]+){0,3}\s+(?:event|incident)\b/iu.test(text)
    || /\b(?:this|that|these|those|it)\b(?:\s+[\p{L}\p{N}-]+){0,4}\s+(?:happen(?:ed|s|ing)?|occur(?:red|s|ring)?)\b/iu.test(text)
    || /\b(?:was|is|has been|had been)\s+(?:this|that|it)\s+repeat(?:ed|ing)\b/iu.test(text)
    || /\bwhat\s+happened\b/iu.test(text)
    || /^\s*did\s+it\s*[?!.]?\s*$/iu.test(text)
  );
  const chineseReference = (
    /(?:这事|那事|那回事|这个事件|那个事件|这件事|那件事|这次事件|那次事件|本次事件|此次事件|该事件|该活动)/u.test(text)
    || /(?:这|那|它|本次|此次).{0,12}(?:发生|出现|重复|次数|几次|多少次)/u.test(text)
  );
  return englishReference || chineseReference;
}

function sourceRecord(store, sourceRef, indexes = null) {
  const collection = SOURCE_COLLECTIONS[sourceRef.resourceType];
  if (!collection) return null;
  const records = list(store?.[collection]);
  const byId = indexes?.get(collection);
  let item = byId?.get(sourceRef.resourceId)
    || records.find(value => value?.id === sourceRef.resourceId)
    || null;
  const root = sourceRef.rootId
    ? byId?.get(sourceRef.rootId)
      || records.find(value => value?.id === sourceRef.rootId)
      || null
    : item;
  if (!item && root) {
    const nested = [
      ...list(root.remarks),
      ...list(root.followUps),
      ...list(root.reflections),
      ...list(root.notes),
      ...list(root.annotations),
      ...list(root.annotationDrift),
      ...list(root.annotations).flatMap(value => list(value?.replies)),
      ...list(root.annotationDrift).flatMap(value => list(value?.replies))
    ];
    item = nested.find(value => value?.id === sourceRef.resourceId) || null;
  }
  return item ? { item, root: root || item } : null;
}

function targetText({ item, root }, sourceRef) {
  if (sourceRef.resourceType === "userClaim") return String(item.statement || "");
  if (sourceRef.resourceType === "modelUnknown") return String(item.question || "");
  if (sourceRef.resourceType === "checkin" && ["", "content"].includes(sourceRef.targetKey || "")) {
    return JSON.stringify({
      mood: item.mood,
      energy: item.energy,
      stress: item.stress,
      sleep: item.sleep,
      factors: list(item.factors),
      custom: item.custom || {},
      notes: item.notes || {}
    });
  }
  if (sourceRef.resourceType === "dailyRecord" && ["", "content"].includes(sourceRef.targetKey || "")) {
    return JSON.stringify(Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => ![
          "id",
          "version",
          "createdAt",
          "updatedAt",
          "attachmentPaths",
          "annotations",
          "annotationDrift"
        ].includes(key))
        .sort(([left], [right]) => compareText(left, right))
    ));
  }
  const targetKey = sourceRef.targetKey;
  if (sourceRef.resourceType === "capture" && targetKey === "transcription") {
    return String(
      item.transcription?.condensedText
        || item.transcription?.polishedText
        || item.transcription?.rawText
        || ""
    );
  }
  if (!targetKey || targetKey === "content") {
    return [
      item.title,
      item.content,
      item.text,
      item.message,
      item.answer,
      item.note,
      item.description
    ].filter(value => typeof value === "string" && value.trim()).join("\n");
  }
  const separator = targetKey.indexOf(":");
  const type = separator < 0 ? targetKey : targetKey.slice(0, separator);
  const id = separator < 0 ? "" : targetKey.slice(separator + 1);
  if (["question", "idea", "record", "answer"].includes(type)) {
    return String(item?.id === id ? item.content || item.modelDraft || "" : "");
  }
  if (type === "remark") return String(item?.id === id ? item.text || "" : "");
  if (type === "followup-question" || type === "followup-answer") {
    const followUp = list(root?.followUps).find(value => value?.id === id);
    return String(type === "followup-question" ? followUp?.question || "" : followUp?.answer || "");
  }
  if (type === "reflection") return String(list(root?.reflections).find(value => value?.id === id)?.content || "");
  if (type === "note") return String(list(root?.notes).find(value => value?.id === id)?.content || "");
  if (type === "claim") return String(item?.id === id ? item.text || "" : "");
  if (type === "annotation") {
    const annotation = [...list(root?.annotations), ...list(root?.annotationDrift)]
      .find(value => value?.id === id);
    return String(annotation?.text || annotation?.quote || "");
  }
  if (type === "annotation-reply") return String(item?.text || "");
  if (targetKey === "message") return String(item.message || "");
  if (targetKey === "answer") return String(item.answer || "");
  if (targetKey === "description") return String(item.description || "");
  return "";
}

export function taskContextSourceMaterial(store, sourceRef, indexes = null) {
  const normalizedKey = sourceIdentity(sourceRef);
  if (!normalizedKey) return null;
  const located = sourceRecord(store, sourceRef, indexes);
  if (!located) return null;
  const text = targetText(located, sourceRef).trim();
  if (!text) return null;
  return {
    text,
    version: sourceRef.resourceType === "capture"
      && sourceRef.targetKey === "transcription"
      ? recordVersion(located.item.transcription?.version)
      : recordVersion(located.item.version),
    contentSha256: digest(text)
  };
}

/**
 * 解析重要性评分/补齐选材的合法原始材料，先执行账户许可与当前版本门。
 * 混合追问只允许用户问题字段；AI答案、转写及派生模型不能成为原话随机池。
 * @since unreleased
 */
export function legalImportanceMaterial(store, sourceRef, accountId, purpose = "context") {
  if (!sourceRef || typeof sourceRef !== "object"
    || ["userClaim", "modelUnknown", "analysis"].includes(sourceRef.resourceType)) return null;
  if (!sourceIdentity(sourceRef) || !Number.isSafeInteger(sourceRef.version) || sourceRef.version < 1) return null;
  const located = sourceRecord(store, sourceRef);
  if (!located) return null;
  let canonicalTarget = "";
  if (located.item === located.root) {
    if (["book", "quote"].includes(sourceRef.resourceType)) return null;
    canonicalTarget = sourceRef.resourceType === "thought" ? `${located.item.type}:${located.item.id}`
      : sourceRef.resourceType === "chat" ? "message" : "";
    if (![canonicalTarget, "", "content"].includes(String(sourceRef.targetKey || ""))) return null;
    if (sourceRef.resourceType === "chat" && sourceRef.targetKey !== "message") return null;
  } else {
    for (const [field, prefix] of [["remarks", "remark"], ["followUps", "followup-question"],
      ["reflections", "reflection"], ["notes", "note"], ["annotations", "annotation"], ["annotationDrift", "annotation"]]) {
      if (list(located.root[field]).some(item => item.id === located.item.id)) canonicalTarget = `${prefix}:${located.item.id}`;
    }
    if (!canonicalTarget && [...list(located.root.annotations), ...list(located.root.annotationDrift)]
      .some(annotation => list(annotation.replies).some(item => item.id === located.item.id))) {
      canonicalTarget = `annotation-reply:${located.item.id}`;
    }
    if (!canonicalTarget || sourceRef.targetKey !== canonicalTarget) return null;
  }
  sourceRef = { ...sourceRef, rootId: located.item === located.root && !["thought", "chat"].includes(sourceRef.resourceType)
    ? "" : located.root.id, targetKey: canonicalTarget };
  let permission;
  try { permission = taskContextSourcePermission(store, sourceRef, accountId); }
  catch { return null; }
  if (purpose !== "learning" && permission?.contextAllowed !== true) return null;
  if (purpose === "learning") {
    const permissions = list(store?.evidencePermissions).filter(item => item?.sourceKey === sourceIdentity(sourceRef));
    const permission = permissions.length === 1 ? normalizeEvidencePermission(permissions[0]) : null;
    if (!permission || permission.accountId !== accountId || !permission.learningAllowed) return null;
    if (located?.item?.learningAllowed === false) return null;
  }
  if (!located || located.item?.deletedAt || located.root?.deletedAt
    || located.item?.disposition === "discarded" || located.root?.disposition === "discarded"
    || located.item?.contextAllowed === false || located.root?.contextAllowed === false
    || located.item?.allowInContext === false || located.root?.allowInContext === false
    || [located.item, located.root].some(item => item?.accountId && item.accountId !== accountId)) return null;
  const targetKey = String(sourceRef.targetKey || "");
  if (sourceRef.resourceType === "thought" && (located.item?.type === "answer"
    || /^(?:answer|followup-answer)(?::|$)/.test(targetKey))) return null;
  if (sourceRef.resourceType === "chat" && targetKey !== "message") return null;
  const userQuestion = sourceRef.resourceType === "thought"
    && String(sourceRef.targetKey).startsWith("followup-question:");
  if (!userQuestion && (["ai", "system"].includes(located.item?.authorType)
    || /^(?:deepseek|codex|openai|model|ai|system)(?:$|[-_:])/i.test(String(located.item?.origin || ""))
    || Boolean(located.item?.modelDraft || located.item?.sourceTaskId || located.item?.contextReceipt))) return null;
  if (sourceRef.resourceType === "capture" && sourceRef.targetKey === "transcription") return null;
  if (["third_party", "quoted_external", "external"].includes(located.item?.origin)) return null;
  let text = "";
  let informationType = "user_viewpoint";
  let origin = "user";
  if (located.item !== located.root) {
    if (targetKey.startsWith("note:") && located.item.type !== "thought") return null;
    text = targetKey.startsWith("followup-question:") ? located.item.question || ""
      : /^(?:remark|annotation|annotation-reply):/.test(targetKey) ? located.item.text || ""
        : located.item.content || "";
  } else if (sourceRef.resourceType === "chat") text = located.item.message || "";
  else if (["capture", "journal", "thought"].includes(sourceRef.resourceType)) text = located.item.content || "";
  else if (sourceRef.resourceType === "keepsake") text = located.item.note || "";
  else if (sourceRef.resourceType === "dailyRecord") {
    origin = "measured";
    informationType = "measured_fact";
    const numeric = Object.fromEntries(Object.entries(located.item).filter(([key, value]) =>
      ["type", "bedtime", "wakeTime", "measuredAt", "startedAt"].includes(key)
      || (key !== "version" && typeof value === "number" && Number.isFinite(value))));
    if (!Object.keys(numeric).some(key => key !== "type")) return null;
    text = describeDailyRecord({ ...numeric, adjustedWeight: null, trendAnalysis: "", description: "", recognitionDescription: "" });
  } else if (sourceRef.resourceType === "checkin") {
    informationType = "user_fact";
    text = JSON.stringify({ mood: located.item.mood, energy: located.item.energy,
      stress: located.item.stress, sleep: located.item.sleep, factors: located.item.factors,
      custom: located.item.custom, notes: located.item.notes });
  } else {
    // 这些领域的用户输入字段单独读取，不拼接 answer、modelDraft 或其他派生字段。
    const fields = {
      action: ["description", "title"], habit: ["description", "title"],
      habitCheckin: ["note"], feedback: ["content", "message", "description"],
      experiment: ["hypothesis"], customMetric: ["description", "name"],
      validationLedger: ["description", "title"]
    }[sourceRef.resourceType] || [];
    text = fields.map(field => located.item[field]).find(value => typeof value === "string" && value.trim()) || "";
    informationType = sourceRef.resourceType === "habitCheckin" ? "user_fact" : "user_viewpoint";
  }
  text = String(text).trim();
  if (!text || recordVersion(located.item.version) !== sourceRef.version) return null;
  const material = { version: sourceRef.version, text, contentSha256: digest(text) };
  return {
    accountId, sourceKey: sourceIdentity(sourceRef), version: material.version,
    permissionRevision: permission.permissionRevision,
    origin, informationType,
    recordType: located.item !== located.root ? "用户批注或思考"
      : { dailyRecord: "生理测量记录", checkin: "用户状态自述", capture: "用户原始文字",
        journal: "用户日记", thought: "用户思绪", chat: "用户对话", keepsake: "用户小物说明",
        action: "用户行动计划", habit: "用户习惯计划", experiment: "用户假设", feedback: "用户反馈" }[sourceRef.resourceType] || "用户自述",
    contentSha256: material.contentSha256, text: material.text,
    favorite: Boolean(located.item?.favorite && located.item.favorite !== "none") || located.item?.starred === true,
    feedback: Boolean(located.item?.completionFeedback),
    explicitImportance: Number.isFinite(located.item?.importance) ? located.item.importance : undefined
  };
}

/**
 * 不依赖感知任务完成的用户原始来源池；子项以真实坐标单独计数。
 * @since unreleased
 */
export function legalImportanceSources(store, accountId, purpose = "context") {
  const result = [];
  const add = (resourceType, root, item, targetKey) => {
    if (!item?.id || !root?.id) return;
    const sourceRef = { resourceType, resourceId: item.id, rootId: item === root && !["thought", "chat"].includes(resourceType) ? "" : root.id,
      targetKey: item === root && !["thought", "chat"].includes(resourceType) ? "" : targetKey, version: recordVersion(item.version) };
    const material = legalImportanceMaterial(store, sourceRef, accountId, purpose);
    if (!material?.text.trim()) return;
    result.push({ ...material, sourceRef, occurredAt: ["date", "unknown"].includes(item.eventTimePrecision || root.eventTimePrecision)
      ? "" : item.occurredAt || root.occurredAt || item.createdAt || "",
      recordedAt: item.createdAt || root.createdAt || "",
      permissionRevision: taskContextSourcePermission(store, sourceRef, accountId).permissionRevision });
  };
  for (const resourceType of ["capture", "journal", "thought", "chat", "quote", "keepsake", "book", "checkin", "dailyRecord",
    "action", "habit", "habitCheckin", "feedback", "experiment", "customMetric", "validationLedger"]) {
    for (const root of list(store?.[SOURCE_COLLECTIONS[resourceType]])) {
      if (resourceType === "thought") {
        if (["question", "idea", "record"].includes(root.type)) add(resourceType, root, root, `${root.type}:${root.id}`);
        for (const remark of list(root.remarks)) add(resourceType, root, remark, `remark:${remark.id}`);
        for (const followUp of list(root.followUps)) add(resourceType, root, followUp, `followup-question:${followUp.id}`);
      } else if (resourceType === "chat") add(resourceType, root, root, "message");
      else if (!["book", "quote"].includes(resourceType)) add(resourceType, root, root, "content");
      if (resourceType === "book") {
        for (const note of list(root.notes)) add(resourceType, root, note, `note:${note.id}`);
      }
      if (resourceType === "journal") {
        for (const reflection of list(root.reflections)) add(resourceType, root, reflection, `reflection:${reflection.id}`);
      }
      for (const annotation of [...list(root.annotations), ...list(root.annotationDrift)]) {
        add(resourceType, root, annotation, `annotation:${annotation.id}`);
        for (const reply of list(annotation.replies)) add(resourceType, root, reply, `annotation-reply:${reply.id}`);
      }
    }
  }
  return [...new Map(result.map(item => [item.sourceKey, item])).values()];
}

/**
 * 个性化对话、复盘、日记回望共用的补齐证据层；核心与当前任务由各入口保留。
 * @since unreleased
 */
export function supplementalImportanceContext(store, { accountId, text, seed, choice = null,
  frozenPlan = null, excludeSourceRefs = [], purpose = "context" } = {}) {
  const excluded = new Set(excludeSourceRefs.map(ref => legalImportanceMaterial(store, ref, accountId, purpose)?.sourceKey || sourceIdentity(ref)));
  const terms = searchTerms(text);
  const materials = legalImportanceSources(store, accountId, purpose).filter(item => !excluded.has(item.sourceKey))
    .map(item => ({ ...item, relevanceScore: relevanceScore(terms, item, text) }));
  const plan = frozenPlan || createImportanceSelectionPlan(materials, store.importanceScores || [], {
    seed, model: choice?.model || "unconfigured-rule-fallback", effort: choice?.effort || "unknown"
  });
  const selected = applyImportanceSelectionPlan(materials, plan);
  if (!selected) {
    if (frozenPlan) return null;
    fail("Reference excerpts exceed their budget", "WORKING_CONTEXT_REFERENCE_BUDGET_EXCEEDED");
  }
  const sources = selected.map(item => ({
    citationId: `importance:${digest(item.sourceKey)}`, text: item.text,
    source: publicSource({ ...item, id: `raw:${digest(item.sourceKey)}`, channel: "history" })
  }));
  const payload = { referenceEvidence: sources.map(item => ({ citationId: item.citationId, text: item.text,
    origin: item.source.origin, informationType: item.source.informationType,
    selectionReason: plan.sources.find(row => `importance:${digest(row.sourceKey)}` === item.citationId)?.related
      ? "task-relevant" : "importance-supplement" })) };
  return {
    prompt: '<reference_context_data format="application/json">' + JSON.stringify(payload)
      .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + '</reference_context_data>',
    sources,
    receipt: { accountId, plan, purpose,
      rawSourceChecks: selected.map(item => ({ sourceKey: item.sourceKey, version: item.version, contentSha256: item.contentSha256 })),
      permissionChecks: selected.map(item => ({ sourceKey: item.sourceKey, permissionRevision: item.permissionRevision })) }
  };
}

/** 校验补齐来源的当前版本/hash与权限；评分缓存变化不使固定计划失效。
 * @since unreleased
 */
export function supplementalImportanceReceiptMatches(store, receipt, accountId = receipt?.accountId) {
  if (!receipt) return true;
  if (!permissionChecksValid(receipt.permissionChecks)) return false;
  return receipt.accountId === accountId && rawSourceChecksMatch(store, receipt.rawSourceChecks, accountId, receipt.purpose)
    && receipt.rawSourceChecks.every(check => receipt.permissionChecks.some(permission => permission.sourceKey === check.sourceKey))
    && (receipt.purpose === "learning" ? receipt.permissionChecks.every(check => {
      const values = list(store?.evidencePermissions).filter(item => item?.sourceKey === check.sourceKey);
      const permission = values.length === 1 ? normalizeEvidencePermission(values[0]) : null;
      return permission?.accountId === accountId && permission.learningAllowed
        && permission.revision === check.permissionRevision;
    }) : permissionChecksMatch(store, receipt.permissionChecks, accountId));
}

function historicalCandidates(store, accountId, evidenceValues) {
  if (!Array.isArray(store?.evidenceSources)
    || !Array.isArray(store?.evidencePermissions)
    || !Array.isArray(store?.perceptionEvents)) {
    throw new TypeError("Evidence collections are unavailable");
  }
  const evidence = evidenceValues.map(value => {
    const normalized = normalizeEvidenceSource(value);
    if (!normalized) throw new TypeError("Evidence collection contains an invalid record");
    return normalized;
  });
  const checks = evidence.map(item => ({
    evidenceId: item.id,
    evidenceFingerprint: evidenceFingerprint(item),
    purpose: "context"
  }));
  const evaluation = evaluateStoredEvidenceChecks(store, checks, { accountId });
  const resultById = new Map(evaluation.results.map(result => [result.evidenceId, result]));
  const sourceIndexes = activeSourceIndexes(store);
  return evidence.map((item, index) => {
    const evidenceCheck = checks[index];
    const result = resultById.get(item.id);
    const material = taskContextSourceMaterial(store, item.sourceRef, sourceIndexes);
    const selectedText = material && Array.isArray(item.span)
      ? material.text.slice(item.span[0], item.span[1])
      : material?.text || "";
    const reasons = [...(result?.reasons || evaluation.reasons)];
    if (!material) reasons.push(EVIDENCE_ERROR_CODES.SOURCE_MISSING);
    else {
      if (material.version !== item.sourceRef.version) {
        reasons.push(EVIDENCE_ERROR_CODES.VERSION_STALE);
      }
      if (material.contentSha256 !== item.contentSha256) {
        reasons.push(EVIDENCE_ERROR_CODES.CONTENT_CHANGED);
      }
      if (material.text.length !== item.contentLength
        || (Array.isArray(item.span) && !selectedText)) {
        reasons.push(EVIDENCE_ERROR_CODES.CONTENT_CHANGED);
      }
    }
    return {
      id: `evidence:${item.id}`,
      evidenceId: item.id,
      eventId: item.eventId,
      origin: item.origin,
      informationType: item.informationType,
      sourceRef: item.sourceRef,
      sourceKey: evidenceSourceKey(item.sourceRef),
      text: selectedText,
      contentSha256: item.contentSha256,
      occurredAt: item.occurredAt,
      recordedAt: item.recordedAt,
      evidenceCheck,
      reasons: [...new Set(reasons)].sort(compareText)
    };
  });
}

function searchTerms(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
  const terms = new Set();
  for (const token of normalized.match(/[\p{L}\p{N}]+/gu) || []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) terms.add(`h2:${token.slice(index, index + 2)}`);
      for (let index = 0; index < token.length - 2; index += 1) terms.add(`h3:${token.slice(index, index + 3)}`);
    } else if (token.length > 1) {
      const singular = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
      terms.add(`w:${singular}`);
      if (singular.length >= 5) terms.add(`p:${singular.slice(0, 5)}`);
      for (const concept of SEARCH_CONCEPTS) {
        if (concept.terms.has(singular)) terms.add(`c:${concept.id}`);
      }
    }
  }
  for (const term of SEARCH_STOP_TERMS) terms.delete(term);
  return terms;
}

function relevanceScore(queryTerms, candidate, taskText, taskEventId = "") {
  const terms = searchTerms(candidate.text);
  let score = 0;
  for (const term of terms) {
    if (!queryTerms.has(term)) continue;
    score += term.startsWith("w:") ? 6 : term.startsWith("h3:") ? 4 : 3;
  }
  const focusedHan = String(taskText || "")
    .normalize("NFKC")
    .replace(/[^\p{Script=Han}]+/gu, "")
    .replace(/(?:怎么办|怎么样|如何|请问|帮我|一下|为什么|是否|怎么)/gu, "");
  if (focusedHan.length >= 2 && focusedHan.length <= 6 && candidate.text.includes(focusedHan)) {
    score += HISTORY_RELEVANCE_MIN_SCORE;
  }
  if (taskEventId && candidate.eventId === taskEventId) {
    score += HISTORY_RELEVANCE_MIN_SCORE;
  }
  return score;
}

function publicSource(material) {
  const isModelUnknown = material.sourceRef.resourceType === "modelUnknown";
  return {
    id: material.id,
    channel: material.channel,
    resourceType: material.sourceRef.resourceType,
    resourceId: material.sourceRef.resourceId,
    recordType: isModelUnknown
      ? "待澄清的问题"
      : material.recordType || material.informationType || "历史证据",
    origin: material.origin || "user",
    informationType: material.informationType || "user_viewpoint",
    occurredAt: material.occurredAt,
    occurredOn: material.occurredAt?.slice(0, 10) || "",
    version: material.sourceRef.version,
    contentSha256: material.contentSha256,
    location: {
      view: SOURCE_VIEWS[material.sourceRef.resourceType] || "personal-context",
      targetId: material.sourceRef.resourceId,
      rootId: material.sourceRef.rootId,
      targetKey: material.sourceRef.targetKey,
      occurredOn: material.occurredAt?.slice(0, 10) || ""
    },
    ...(isModelUnknown ? { excerpt: material.text } : {}),
    ...(material.channel === "history" && material.evidenceCheck ? {
      evidenceId: material.evidenceId,
      evidenceFingerprint: material.evidenceCheck.evidenceFingerprint
    } : {})
  };
}

function contextSections(task, currentMaterial, historicalMaterial, notice, generatedAt) {
  const render = (title, values) => [
    `<${title}>`,
    ...values.map((item, index) => (
      `[${index + 1}] ${item.recordType || item.informationType || item.id}\n${item.text}`
    )),
    `</${title}>`
  ].join("\n");
  const currentContext = render("current_material", currentMaterial);
  const historicalContext = render("historical_evidence", historicalMaterial);
  const noticeContext = notice ? `<retrieval_notice>${notice}</retrieval_notice>` : "";
  return {
    task,
    currentMaterial,
    historicalMaterial,
    notice,
    generatedAt,
    currentContext,
    historicalContext,
    noticeContext,
    workingContext: [
      `<working_context scene="${task.kind}">`,
      `<current_task>${task.text}</current_task>`,
      currentContext,
      historicalContext,
      ...(noticeContext ? [noticeContext] : []),
      "</working_context>"
    ].join("\n")
  };
}

function compiledPrompt(compilePrompt, task, currentMaterial, historicalMaterial, notice, generatedAt) {
  const sections = contextSections(task, currentMaterial, historicalMaterial, notice, generatedAt);
  const compiled = compilePrompt ? compilePrompt(sections) : sections.workingContext;
  const prompt = typeof compiled === "string" ? compiled : compiled?.prompt;
  const promptContract = typeof compiled === "string" ? null : compiled?.contract || null;
  if (typeof prompt !== "string" || !prompt.trim()) {
    fail("Working context compiler returned an invalid prompt", "TASK_CONTEXT_INVALID");
  }
  return { prompt, promptContract };
}

function selectionReceipt({
  store,
  accountId,
  scene,
  task,
  currentMaterial,
  candidates,
  selectedHistory,
  excluded,
  generatedAt,
  tokenLimit,
  status,
  historyRetrieval,
  notice,
  prompt,
  promptContract,
  importanceSelectionPlan = null
}) {
  const selected = [
    ...currentMaterial.map(item => ({
      id: item.id,
      channel: "current",
      reason: "current-material"
    })),
    ...selectedHistory.map(item => ({
      id: item.id,
      evidenceId: item.evidenceId,
      channel: "history",
      reason: item.selectionReason || "task-relevant"
    }))
  ];
  const sources = [
    ...currentMaterial.map(publicSource),
    ...selectedHistory.map(item => publicSource({ ...item, channel: "history" }))
  ];
  const occurredAt = sources.map(item => safeIso(item.occurredAt)).filter(Boolean).sort(compareText);
  const used = Buffer.byteLength(prompt, "utf8");
  const evidenceChecks = new Map();
  for (const check of [
    ...currentMaterial.flatMap(item => item.evidenceChecks),
    ...selectedHistory.map(item => item.evidenceCheck)
  ].filter(Boolean)) {
    evidenceChecks.set(`${check.purpose}\u0000${check.evidenceId}`, check);
  }
  const receipt = {
    schemaVersion: 2,
    version: WORKING_CONTEXT_VERSION,
    generatedAt,
    scene,
    task: {
      kind: task.kind,
      targetId: task.targetId,
      subtargetId: task.subtargetId,
      ...(task.eventId ? { eventId: task.eventId } : {}),
      ...(task.eventScoped ? { eventScoped: true } : {}),
      textSha256: digest(task.text)
    },
    status,
    historyRetrieval,
    notice,
    currentMaterial: currentMaterial.map(item => ({
      id: item.id,
      sourceKey: item.sourceKey,
      version: item.sourceRef.version,
      settledVersion: item.settledVersion,
      contentSha256: item.contentSha256,
      attachmentCount: item.attachmentPaths.length,
      attachmentPathsSha256: digest(JSON.stringify(item.attachmentPaths)),
      validation: item.validation,
      authorization: item.authorization,
      permissionRevision: item.permissionRevision,
      chainId: item.chainId,
      chainOrder: item.chainOrder
    })),
    candidateCount: candidates.length,
    candidateSetSha256: digest(JSON.stringify(candidates.map(item => [
      item.id,
      item.evidenceId,
      item.sourceKey,
      item.relevanceScore || 0
    ]))),
    candidates: candidates.slice(0, WORKING_CONTEXT_RECEIPT_ITEM_LIMIT).map(item => ({
      id: item.id,
      evidenceId: item.evidenceId,
      sourceKey: item.sourceKey,
      relevanceScore: item.relevanceScore || 0
    })),
    selected,
    excludedCount: excluded.length,
    excludedSetSha256: digest(JSON.stringify(excluded)),
    excluded: excluded.slice(0, WORKING_CONTEXT_RECEIPT_ITEM_LIMIT),
    evidenceChecks: [...evidenceChecks.values()],
    permissionChecks: [...new Map([...currentMaterial.flatMap(item => [
      { sourceKey: item.sourceKey, permissionRevision: item.permissionRevision },
      ...item.permissionChecks
    ]), ...selectedHistory.filter(item => item.rawSource).map(item => ({
      sourceKey: item.sourceKey, permissionRevision: item.permissionRevision
    }))].map(check => [check.sourceKey, check])).values()],
    legacyDependencies: normalizedLegacyDependencies(store,
      currentMaterial.flatMap(item => item.legacyDependencies)),
    ...(importanceSelectionPlan ? { importanceSelectionPlan } : {}),
    ...(importanceSelectionPlan || currentMaterial.some(item => item.rawSourceChecks.length) ? {
      rawSourceChecks: [...new Map([
        ...currentMaterial.flatMap(item => item.rawSourceChecks),
        ...selectedHistory.filter(item => item.rawSource).map(item => ({
          sourceKey: item.sourceKey, version: item.sourceRef.version, contentSha256: item.contentSha256
        }))
      ].map(check => [check.sourceKey, check])).values()]
    } : {}),
    promptSha256: digest(prompt),
    promptContract: promptContract ? structuredClone(promptContract) : null,
    timeWindow: {
      from: occurredAt[0]?.slice(0, 10) || "",
      to: occurredAt.at(-1)?.slice(0, 10) || ""
    },
    tokenBudget: {
      limit: tokenLimit,
      estimatedUsed: used,
      remaining: Math.max(0, tokenLimit - used),
      estimation: "utf8-byte-upper-bound-v1",
      scope: "compiled-user-prompt",
      unit: "UTF-8 bytes"
    },
    sourceCount: sources.length,
    sources,
    accountBindingSha256: digest(accountId)
  };
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > WORKING_CONTEXT_RECEIPT_BYTE_LIMIT) {
    fail("Working context receipt exceeds its storage budget", "WORKING_CONTEXT_RECEIPT_TOO_LARGE");
  }
  return receipt;
}

export function workingContextTimestamp(value) {
  if (typeof value !== "string") return "";
  const parts = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return "";
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return "";
  const zone = parts[8];
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

export function workingContextProjection(store, {
  accountId: inputAccountId,
  scene: inputScene,
  task: inputTask,
  currentMaterial: inputCurrentMaterial,
  generatedAt = new Date().toISOString(),
  tokenLimit = WORKING_CONTEXT_PROMPT_BYTE_BUDGET,
  maxHistorical = 8,
  retrieveHistorical = source => source?.evidenceSources,
  compilePrompt = null,
  importanceChoice = null,
  frozenSelectionPlan = null,
  selectionSeed = ""
} = {}) {
  const accountId = safeText(inputAccountId, 100);
  const scene = safeText(inputScene, 40);
  generatedAt = workingContextTimestamp(generatedAt);
  if (!accountId
    || !scene
    || !generatedAt
    || typeof retrieveHistorical !== "function"
    || (compilePrompt !== null && typeof compilePrompt !== "function")) {
    fail("Working context requires account, scene and retrieval dependencies", "TASK_CONTEXT_INVALID");
  }
  const task = normalizedTask(inputTask);
  const currentMaterial = normalizedCurrentMaterial(inputCurrentMaterial, accountId, store, task);
  const queryParts = [task.text, ...currentMaterial.map(item => item.text)];
  const queryText = queryParts.join("\n");
  const hasDeicticEvent = task.eventScoped || hasDeicticEventReference(task.text);
  if (!task.eventId && hasDeicticEvent) {
    task.eventId = currentMaterialEventId(store, accountId, currentMaterial);
  }
  tokenLimit = Math.max(1, Math.round(Number(tokenLimit) || WORKING_CONTEXT_PROMPT_BYTE_BUDGET));
  maxHistorical = Math.max(0, Math.min(50, Math.round(Number(maxHistorical) || 0)));
  const degradedNotice = "历史证据暂不可用，本次仅依据当前材料。";
  const currentCompiled = compiledPrompt(
    compilePrompt,
    task,
    currentMaterial,
    [],
    "",
    generatedAt
  );
  if (Buffer.byteLength(currentCompiled.prompt, "utf8") > tokenLimit) {
    fail("Current material exceeds the working-context budget", "CURRENT_MATERIAL_BUDGET_EXCEEDED");
  }

  let candidates = [];
  let status = "complete";
  let historyRetrieval = { status: "ok", reason: "" };
  let notice = "";
  try {
    const values = retrieveHistorical(store, accountId);
    if (!Array.isArray(values)) throw new TypeError("Historical retrieval must return an array");
    candidates = historicalCandidates(store, accountId, values);
  } catch (error) {
    status = "degraded";
    historyRetrieval = {
      status: "unavailable",
      reason: safeText(error?.code, 120) || "HISTORY_RETRIEVAL_UNAVAILABLE"
    };
    notice = degradedNotice;
  }

  const excluded = [];
  const selectedHistory = [];
  let rankedCandidates = [];
  let importanceSelectionPlan = null;
  const useImportance = Boolean(compilePrompt) && ["thoughtAnswer", "followUpAnswer", "annotationShenji"].includes(scene);
  if (useImportance) {
    const currentKeys = new Set(currentMaterial.map(item => item.sourceKey));
    const queryTerms = searchTerms(queryText);
    const raw = legalImportanceSources(store, accountId).filter(item => !currentKeys.has(item.sourceKey)).map(item => ({
      ...item, originalText: item.text, id: `raw:${digest(item.sourceKey)}`, rawSource: true, reasons: [],
      relevanceScore: relevanceScore(queryTerms, item, task.text, task.eventId)
    }));
    rankedCandidates = raw;
    if (status === "degraded" && raw.length) notice = "感知证据暂不可用，本次背景选材使用获准的用户原始记录。";
    const model = importanceChoice?.model || "unconfigured-rule-fallback";
    importanceSelectionPlan = frozenSelectionPlan || createImportanceSelectionPlan(raw, store.importanceScores || [], {
      seed: selectionSeed || digest(JSON.stringify([accountId, task, generatedAt, model])), model, effort: importanceChoice?.effort || "unknown",
      count: Math.max(0, readInternalBudgets().minimumReferences - currentKeys.size)
    });
    const applied = applyImportanceSelectionPlan(raw, importanceSelectionPlan);
    if (!applied) fail("Frozen reference selection sources changed", "STALE_PERSONAL_CONTEXT");
    const reasonFor = candidate => importanceSelectionPlan.sources.find(item => item.sourceKey === candidate.sourceKey)?.related
      ? "task-relevant" : "importance-supplement";
    const renderCandidates = values => compiledPrompt(compilePrompt, task, currentMaterial,
      values.map(candidate => ({ ...candidate, selectionReason: reasonFor(candidate) })), notice, generatedAt);
    const fits = values => Buffer.byteLength(renderCandidates(values).prompt, "utf8") <= tokenLimit;
    if (!fits([]) && notice) notice = "";
    if (!fits([])) fail("Required material exceeds the working-context budget", "CURRENT_MATERIAL_BUDGET_EXCEEDED");
    let bounded = applied;
    if (!fits(bounded)) {
      const minimumLength = value => [...value.text][0]?.length || 0;
      const atFraction = fraction => bounded.map(value => ({ ...value,
        text: value.text.slice(0, Math.max(minimumLength(value), Math.floor(value.text.length * fraction))) }));
      // 先尝试给所有来源留下一个完整字符；连目录结构都放不下时才减少可选来源。
      while (bounded.length && !fits(atFraction(0))) bounded = bounded.slice(0, -1);
      let low = 0;
      let high = 1;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const middle = (low + high) / 2;
        if (fits(atFraction(middle))) low = middle;
        else high = middle;
      }
      bounded = atFraction(low);
      const isRelated = value => importanceSelectionPlan.sources.find(row => row.sourceKey === value.sourceKey)?.related === true;
      const sampledTokens = bounded.filter(value => !isRelated(value)).reduce((sum, value) => sum + estimateInternalTokens(value.text), 0);
      let relatedTokensLeft = Math.floor(sampledTokens * RELATED_REFERENCE_SHARE_MAX / (1 - RELATED_REFERENCE_SHARE_MAX));
      bounded = bounded.flatMap(value => {
        if (!isRelated(value)) return [value];
        let length = value.text.length;
        while (length > 0 && estimateInternalTokens(value.text.slice(0, length)) > relatedTokensLeft) length -= 1;
        if (!length) return [];
        const text = value.text.slice(0, length);
        relatedTokensLeft -= estimateInternalTokens(text);
        return [{ ...value, text }];
      });
      const lengths = new Map(bounded.map(value => [value.sourceKey, value.text.length]));
      importanceSelectionPlan = { ...importanceSelectionPlan,
        requestedCount: importanceSelectionPlan.sources.length,
        limitReason: "overall_byte_budget",
        sources: importanceSelectionPlan.sources.filter(value => lengths.has(value.sourceKey))
          .map(value => ({ ...value, characters: lengths.get(value.sourceKey) })) };
    }
    selectedHistory.push(...bounded.map(candidate => ({ ...candidate, selectionReason: reasonFor(candidate) })));
  } else if (status === "complete") {
    const queryTerms = searchTerms(queryText);
    const currentSourceKeys = new Set(currentMaterial.map(item => item.sourceKey));
    const unresolvedDeicticEvent = hasDeicticEvent && !task.eventId;
    rankedCandidates = candidates.map(candidate => ({
      ...candidate,
      relevanceScore: relevanceScore(queryTerms, candidate, task.text, task.eventId)
    })).sort((left, right) => (
      right.relevanceScore - left.relevanceScore
      || compareText(right.recordedAt, left.recordedAt)
      || compareText(left.id, right.id)
    ));
    const selectedEvents = new Set();
    for (const candidate of rankedCandidates) {
      const reasons = [...candidate.reasons];
      if (!reasons.length && currentSourceKeys.has(candidate.sourceKey)) {
        reasons.push("current-material-duplicate");
      }
      if (!reasons.length && task.eventId && candidate.eventId !== task.eventId) {
        reasons.push("event-mismatch");
      }
      if (!reasons.length && unresolvedDeicticEvent) {
        reasons.push("event-reference-unresolved");
      }
      if (!reasons.length && candidate.relevanceScore < HISTORY_RELEVANCE_MIN_SCORE) {
        reasons.push("task-irrelevant");
      }
      if (!reasons.length && selectedEvents.has(candidate.eventId)) reasons.push("duplicate-event");
      if (!reasons.length && selectedHistory.length >= maxHistorical) reasons.push("history-limit");
      if (!reasons.length) {
        const tentative = compiledPrompt(
          compilePrompt,
          task,
          currentMaterial,
          [...selectedHistory, candidate],
          notice,
          generatedAt
        );
        if (Buffer.byteLength(tentative.prompt, "utf8") > tokenLimit) reasons.push("token-budget");
      }
      if (reasons.length) {
        excluded.push({
          id: candidate.id,
          evidenceId: candidate.evidenceId,
          reasons: [...new Set(reasons)].sort(compareText)
        });
      } else {
        selectedHistory.push(candidate);
        selectedEvents.add(candidate.eventId);
      }
    }
  }
  const compiled = compiledPrompt(compilePrompt, task, currentMaterial, selectedHistory, notice, generatedAt);
  const receipt = selectionReceipt({
    store,
    accountId,
    scene,
    task,
    currentMaterial,
    candidates: rankedCandidates,
    selectedHistory,
    excluded,
    generatedAt,
    tokenLimit,
    status,
    historyRetrieval,
    notice,
    prompt: compiled.prompt,
    promptContract: compiled.promptContract,
    importanceSelectionPlan
  });
  return {
    prompt: compiled.prompt,
    receipt,
    attachmentPaths: [...new Set(currentMaterial.flatMap(item => item.attachmentPaths))],
    citationSources: [
      ...currentMaterial.map(item => ({
        citationId: `context:${item.id}`,
        text: item.text,
        source: publicSource(item)
      })),
      ...selectedHistory.map(item => ({
        citationId: `context:${item.id}`,
        text: item.originalText || item.text,
        source: publicSource({ ...item, channel: "history" })
      }))
    ]
  };
}

function rawSourceChecksValid(checks) {
  return Array.isArray(checks) && checks.length <= WORKING_CONTEXT_RECEIPT_ITEM_LIMIT
    && new Set(checks.map(check => check?.sourceKey)).size === checks.length
    && checks.every(check => parseEvidenceSourceKey(check?.sourceKey)
      && Number.isSafeInteger(check.version) && check.version > 0 && validDigest(check.contentSha256));
}

function rawSourceChecksMatch(store, checks, accountId, purpose = "context") {
  if (!rawSourceChecksValid(checks)) return false;
  return checks.every(check => {
    const sourceRef = parseEvidenceSourceKey(check?.sourceKey);
    if (!sourceRef || !Number.isSafeInteger(check.version) || !validDigest(check.contentSha256)) return false;
    const material = legalImportanceMaterial(store, { ...sourceRef, version: check.version }, accountId, purpose);
    return material?.contentSha256 === check.contentSha256;
  });
}

export function workingContextReceiptFingerprint(receipt) {
  const generatedAt = safeIso(receipt?.generatedAt);
  const timeWindow = receipt?.timeWindow;
  const promptContract = receipt?.promptContract;
  if (receipt?.schemaVersion !== 2
    || receipt?.version !== WORKING_CONTEXT_VERSION
    || !generatedAt
    || generatedAt !== receipt.generatedAt
    || !receipt.task
    || typeof receipt.task.kind !== "string"
    || !receipt.task.kind
    || (receipt.task.eventId != null
      && (typeof receipt.task.eventId !== "string" || receipt.task.eventId.length > 100))
    || (receipt.task.eventScoped != null && receipt.task.eventScoped !== true)
    || !validDigest(receipt.task.textSha256)
    || !validDigest(receipt.promptSha256)
    || !validDigest(receipt.accountBindingSha256)
    || !Array.isArray(receipt.currentMaterial)
    || !receipt.currentMaterial.length
    || !Array.isArray(receipt.selected)
    || !Array.isArray(receipt.evidenceChecks)
    || !rawSourceChecksValid(receipt.rawSourceChecks || [])
    || !permissionChecksValid(receipt.permissionChecks)
    || !legacyDependenciesValid(receipt.legacyDependencies)
    || !receipt.tokenBudget
    || !Number.isSafeInteger(receipt.tokenBudget.limit)
    || receipt.tokenBudget.limit < 1
    || !timeWindow
    || typeof timeWindow.from !== "string"
    || typeof timeWindow.to !== "string"
    || (timeWindow.from && !validDateOnly(timeWindow.from))
    || (timeWindow.to && !validDateOnly(timeWindow.to))
    || Boolean(timeWindow.from) !== Boolean(timeWindow.to)
    || (timeWindow.from && timeWindow.from > timeWindow.to)
    || (promptContract != null && (
      promptContract?.schemaVersion !== 1
      || !["structured-json", "legacy"].includes(promptContract.mode)
      || typeof promptContract.catalogVersion !== "string"
      || !promptContract.catalogVersion
      || !validDigest(promptContract.catalogSha256)
      || (promptContract.mode === "structured-json" && (
        !promptContract.roleId
        || !promptContract.taskPromptId
        || !promptContract.envelopeId
      ))
    ))) {
    return "";
  }
  const currentIds = receipt.currentMaterial.map(item => item?.id);
  const selectedCurrentIds = receipt.selected
    .filter(item => item?.channel === "current")
    .map(item => item.id);
  const evidenceIds = new Set(receipt.evidenceChecks.map(item => item?.evidenceId));
  if (currentIds.some(id => typeof id !== "string" || !id)
    || new Set(currentIds).size !== currentIds.length
    || JSON.stringify(currentIds) !== JSON.stringify(selectedCurrentIds)
    || receipt.currentMaterial.some(item => (
      !parseEvidenceSourceKey(item?.sourceKey)
      || !Number.isSafeInteger(item.version)
      || item.version < 1
      || !Number.isSafeInteger(item.settledVersion)
      || item.settledVersion < item.version
      || !validDigest(item.contentSha256)
      || !["content", "version", "immutable"].includes(item.validation)
      || !["current-request", "source-permission"].includes(item.authorization)
      || !Number.isSafeInteger(item.permissionRevision)
      || item.permissionRevision < 0
      || !receipt.permissionChecks.some(check => check.sourceKey === item.sourceKey
        && check.permissionRevision === item.permissionRevision)
    ))
    || receipt.selected.some(item => (
      item?.channel === "history" && !evidenceIds.has(item.evidenceId)
        && !(receipt.rawSourceChecks || []).some(check => item.id === `raw:${digest(check.sourceKey)}`)
    ))) {
    return "";
  }
  return digest(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    version: receipt.version,
    generatedAt: receipt.generatedAt,
    scene: receipt.scene,
    task: receipt.task,
    status: receipt.status,
    historyRetrieval: receipt.historyRetrieval,
    currentMaterial: receipt.currentMaterial,
    selected: receipt.selected,
    evidenceChecks: receipt.evidenceChecks,
    permissionChecks: receipt.permissionChecks,
    legacyDependencies: receipt.legacyDependencies,
    ...(receipt.importanceSelectionPlan ? { importanceSelectionPlan: receipt.importanceSelectionPlan } : {}),
    ...(receipt.rawSourceChecks ? { rawSourceChecks: receipt.rawSourceChecks } : {}),
    promptSha256: receipt.promptSha256,
    ...(promptContract != null ? { promptContract } : {}),
    timeWindow: receipt.timeWindow,
    tokenBudget: { limit: receipt.tokenBudget?.limit },
    accountBindingSha256: receipt.accountBindingSha256
  }));
}

export function workingContextReceiptMatches(store, receipt, options = {}) {
  const expected = workingContextReceiptFingerprint(receipt);
  if (!expected) return false;
  try {
    return workingContextReceiptFingerprint(workingContextProjection(store, {
      ...options,
      generatedAt: receipt.generatedAt,
      tokenLimit: receipt.tokenBudget?.limit,
      frozenSelectionPlan: receipt.importanceSelectionPlan || null
    }).receipt) === expected;
  } catch {
    return false;
  }
}

function currentMaterialSnapshotMatches(store, snapshot, task = null) {
  const parsed = parseEvidenceSourceKey(snapshot?.sourceKey);
  if (!parsed) return false;
  if (snapshot.validation === "immutable") {
    const requestId = safeText(task?.clientRequestId || task?.id, 100);
    const text = safeText(task?.payload?.message, 6000) || "回应当前批注";
    return parsed.resourceType === "annotationRequest"
      && parsed.resourceId === requestId
      && snapshot.contentSha256 === digest(JSON.stringify({ text, attachmentPaths: [] }));
  }
  const located = sourceRecord(store, parsed);
  const expectedVersion = Number.isSafeInteger(snapshot.settledVersion)
    ? snapshot.settledVersion
    : snapshot.version;
  if (!located || located.item.contextAllowed === false || located.item.disposition === "discarded") return false;
  if (snapshot.validation === "version") {
    return recordVersion(located.item.version) === expectedVersion;
  }
  const text = targetText(located, parsed).trim();
  const attachmentPaths = [...new Set(list(located.item.attachmentPaths)
    .filter(path => typeof path === "string" && /^\/attachments\/[\w.-]+$/.test(path)))];
  return digest(JSON.stringify({ text: text || (attachmentPaths.length ? "（图片原文）" : ""), attachmentPaths }))
    === snapshot.contentSha256;
}

export function contextDerivedOutputAllowed(store, item, accountId, expectedTask = null) {
  const receipt = item?.contextReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  if (receipt.schemaVersion !== 2) {
    if (!supplementalImportanceReceiptMatches(store, receipt.importanceReferences, accountId)) return false;
    try { contextDerivedLegacyDependencies(store, item); return true; }
    catch { return false; }
  }
  const expected = expectedTask || (
    item?.type === "answer" && item.relatedTo
      ? { kind: "thoughtAnswer", targetId: item.relatedTo, subtargetId: "" }
      : null
  );
  if (!expected
    || receipt.task?.kind !== expected.kind
    || receipt.task?.targetId !== expected.targetId
    || (receipt.task?.subtargetId || "") !== (expected.subtargetId || "")) {
    return false;
  }
  const contextFingerprint = workingContextReceiptFingerprint(receipt);
  const sourceTask = list(store?.aiTasks).find(value => value?.id === item.sourceTaskId);
  if (!sourceTask
    || sourceTask.status !== "succeeded"
    || sourceTask.kind !== expected.kind
    || sourceTask.targetId !== expected.targetId
    || (sourceTask.subtargetId || "") !== (expected.subtargetId || "")
    || (sourceTask.resultId || "") !== (item.id || "")
    || sourceTask.contextFingerprint !== contextFingerprint) {
    return false;
  }
  if (!contextFingerprint
    || receipt.accountBindingSha256 !== digest(accountId)
    || !permissionChecksMatch(store, receipt.permissionChecks, accountId)
    || !rawSourceChecksMatch(store, receipt.rawSourceChecks || [], accountId)
    || !legacyDependenciesMatch(store, receipt.legacyDependencies)
    || !Array.isArray(receipt.currentMaterial)
    || !receipt.currentMaterial.every(snapshot => (
      currentMaterialSnapshotMatches(store, snapshot, sourceTask)
    ))) {
    return false;
  }
  return evaluateStoredEvidenceChecks(store, receipt.evidenceChecks || [], { accountId }).usable;
}

export function thoughtTaskCurrentMaterial(store, root, {
  accountId,
  currentFollowUpId = ""
} = {}) {
  if (!root?.id || root.type !== "question") {
    fail("Thought task current material requires a question root", "CURRENT_MATERIAL_INVALID");
  }
  const materials = [];
  const add = (item, targetKey, text, recordType, {
    validation = "content",
    settledVersionDelta = 0,
    contextAllowed = item?.contextAllowed !== false && item?.disposition !== "discarded",
    evidenceChecks = [],
    rawSourceChecks = [],
    permissionChecks = [],
    legacyDependencies = [],
    authorization = "source-permission"
  } = {}) => {
    const normalizedText = safeText(text, 120_000);
    const attachmentPaths = list(item?.attachmentPaths);
    if (!item?.id || (!normalizedText && !attachmentPaths.length)) return;
    const sourceRef = {
      resourceType: "thought", resourceId: item.id, rootId: root.id, targetKey,
      version: recordVersion(item.version)
    };
    if (!taskContextSourcePermission(store, sourceRef, accountId).contextAllowed
      && authorization !== "current-request") return;
    materials.push({
      id: `current:thought:${root.id}:${targetKey}`,
      accountId,
      text: normalizedText,
      attachmentPaths,
      recordType,
      origin: item.authorType === "ai" ? "ai" : "user",
      informationType: item.authorType === "ai" ? "model_derived" : "user_viewpoint",
      contextAllowed,
      validation,
      evidenceChecks,
      rawSourceChecks,
      permissionChecks,
      legacyDependencies,
      authorization,
      settledVersion: recordVersion(item.version) + settledVersionDelta,
      occurredAt: ["date", "unknown"].includes(item.eventTimePrecision || root.eventTimePrecision) ? ""
        : safeText(item.occurredAt || item.createdAt || root.occurredAt || root.createdAt, 100),
      chainId: root.id,
      chainOrder: materials.length,
      sourceRef: {
        resourceType: "thought",
        resourceId: item.id,
        rootId: root.id,
        targetKey,
        version: recordVersion(item.version)
      }
    });
  };
  add(root, `question:${root.id}`, root.content, "思绪问题", {
    contextAllowed: root.contextAllowed !== false && root.disposition !== "discarded",
    settledVersionDelta: currentFollowUpId ? 1 : 0,
    authorization: currentFollowUpId ? "source-permission" : "current-request"
  });
  for (const item of list(store?.thoughts).filter(value => value?.relatedTo === root.id)) {
    const modelOutput = item.authorType === "ai"
      || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item.origin || ""))
      || Boolean(item.modelDraft)
      || Boolean(item.reasoningContent);
    const recordType = item.type === "idea"
      ? "用户初步想法"
      : item.type === "record" ? "用户内容块"
        : modelOutput ? "AI 回答" : "用户自答";
    const allowed = item.contextAllowed !== false
      && item.disposition !== "discarded"
      && (!modelOutput || contextDerivedOutputAllowed(store, item, accountId, {
        kind: "thoughtAnswer",
        targetId: root.id,
        subtargetId: ""
      }));
    if (!allowed) continue;
    add(item, `${item.type}:${item.id}`, item.content || item.modelDraft, recordType, {
      contextAllowed: allowed,
      evidenceChecks: modelOutput ? list(item.contextReceipt?.evidenceChecks) : [],
      rawSourceChecks: modelOutput ? list(item.contextReceipt?.rawSourceChecks) : [],
      permissionChecks: modelOutput ? list(item.contextReceipt?.permissionChecks) : [],
      legacyDependencies: modelOutput ? contextDerivedLegacyDependencies(store, item) : []
    });
  }
  for (const item of list(root.remarks)) {
    if (item?.contextAllowed === false || item?.disposition === "discarded") continue;
    add(item, `remark:${item.id}`, item.text, "思绪批注");
  }
  for (const item of list(root.followUps)) {
    const modelOutput = item.authorType === "ai"
      || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item.origin || ""))
      || Boolean(item.modelDraft)
      || Boolean(item.reasoningContent);
    const questionAllowed = item.contextAllowed !== false && item.disposition !== "discarded";
    if (!questionAllowed && item.id !== currentFollowUpId) continue;
    add(
      item,
      `followup-question:${item.id}`,
      item.question,
      item.id === currentFollowUpId ? "当前追问" : "历史追问",
      {
        validation: "version",
        settledVersionDelta: item.id === currentFollowUpId ? 1 : 0,
        authorization: item.id === currentFollowUpId ? "current-request" : "source-permission"
      }
    );
    if (item.answer) {
      const allowed = item.contextAllowed !== false
        && (!modelOutput || contextDerivedOutputAllowed(store, item, accountId, {
          kind: "followUpAnswer",
          targetId: root.id,
          subtargetId: item.id
        }));
      if (allowed) {
        add(
          item,
          `followup-answer:${item.id}`,
          item.answer,
          modelOutput ? "AI 追问回答" : "用户追问回答",
          {
            validation: "version",
            settledVersionDelta: item.id === currentFollowUpId ? 1 : 0,
            contextAllowed: allowed,
            evidenceChecks: modelOutput ? list(item.contextReceipt?.evidenceChecks) : [],
            rawSourceChecks: modelOutput ? list(item.contextReceipt?.rawSourceChecks) : [],
      permissionChecks: modelOutput ? list(item.contextReceipt?.permissionChecks) : [],
            legacyDependencies: modelOutput ? contextDerivedLegacyDependencies(store, item) : []
          }
        );
      }
    }
  }
  for (const item of list(root.annotations)) {
    if (item?.contextAllowed === false || item?.disposition === "discarded") continue;
    const validTurns = list(item.shenji)
      .filter(turn => contextDerivedOutputAllowed(store, turn, accountId, {
        kind: "annotationShenji",
        targetId: root.id,
        subtargetId: item.id
      }));
    const conversation = validTurns.map(turn => `${turn.message || ""}\n${turn.answer || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    add(
      item,
      `annotation:${item.id}`,
      [item.quote, item.text, conversation].filter(Boolean).join("\n"),
      "批注与追问",
      {
        validation: "version",
        evidenceChecks: validTurns.flatMap(turn => list(turn.contextReceipt?.evidenceChecks)),
        rawSourceChecks: validTurns.flatMap(turn => list(turn.contextReceipt?.rawSourceChecks)),
        permissionChecks: validTurns.flatMap(turn => list(turn.contextReceipt?.permissionChecks)),
        legacyDependencies: validTurns.flatMap(turn => contextDerivedLegacyDependencies(store, turn))
      }
    );
  }
  return materials;
}
