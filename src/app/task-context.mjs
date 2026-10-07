import crypto from "node:crypto";
import {
  EVIDENCE_ERROR_CODES,
  evaluateStoredEvidenceChecks,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidenceSource,
  parseEvidenceSourceKey
} from "../modules/user-model/index.mjs";
import { recordVersion, safeIso, safeText } from "../shared/validation/index.mjs";
import { personalContextReceiptMatches } from "./personal-context.mjs";

export const WORKING_CONTEXT_VERSION = "2026.10.07.1";
export const WORKING_CONTEXT_TOKEN_BUDGET = 20_000;
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
  "w:about",
  "w:current",
  "w:from",
  "w:plan",
  "w:project",
  "w:that",
  "w:this",
  "w:with",
  "w:your"
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
  if (!kind || !text) fail("Working context requires a task kind and text", "TASK_CONTEXT_INVALID");
  return { kind, text, targetId, subtargetId };
}

function normalizedCurrentMaterial(values, accountId) {
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
  if (sourceRef.resourceType === "checkin") {
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
  if (sourceRef.resourceType === "dailyRecord") {
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
    }
  }
  for (const term of SEARCH_STOP_TERMS) terms.delete(term);
  return terms;
}

function relevanceScore(queryTerms, candidate, taskText) {
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
  return score;
}

function publicSource(material) {
  return {
    id: material.id,
    channel: material.channel,
    resourceType: material.sourceRef.resourceType,
    resourceId: material.sourceRef.resourceId,
    recordType: material.recordType || material.informationType || "历史证据",
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
    ...(material.channel === "history" ? {
      evidenceId: material.evidenceId,
      evidenceFingerprint: material.evidenceCheck.evidenceFingerprint
    } : {})
  };
}

function contextSections(task, currentMaterial, historicalMaterial, notice) {
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

function compiledPrompt(compilePrompt, task, currentMaterial, historicalMaterial, notice) {
  const sections = contextSections(task, currentMaterial, historicalMaterial, notice);
  const compiled = compilePrompt ? compilePrompt(sections) : sections.workingContext;
  const prompt = typeof compiled === "string" ? compiled : compiled?.prompt;
  const promptContract = typeof compiled === "string" ? null : compiled?.contract || null;
  if (typeof prompt !== "string" || !prompt.trim()) {
    fail("Working context compiler returned an invalid prompt", "TASK_CONTEXT_INVALID");
  }
  return { prompt, promptContract };
}

function selectionReceipt({
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
  promptContract
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
      reason: "task-relevant"
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
  ]) {
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
      scope: "compiled-user-prompt"
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

export function workingContextProjection(store, {
  accountId: inputAccountId,
  scene: inputScene,
  task: inputTask,
  currentMaterial: inputCurrentMaterial,
  generatedAt = new Date().toISOString(),
  tokenLimit = WORKING_CONTEXT_TOKEN_BUDGET,
  maxHistorical = 8,
  retrieveHistorical = source => source?.evidenceSources,
  compilePrompt = null
} = {}) {
  const accountId = safeText(inputAccountId, 100);
  const scene = safeText(inputScene, 40);
  generatedAt = safeIso(generatedAt);
  if (!accountId
    || !scene
    || !generatedAt
    || typeof retrieveHistorical !== "function"
    || (compilePrompt !== null && typeof compilePrompt !== "function")) {
    fail("Working context requires account, scene and retrieval dependencies", "TASK_CONTEXT_INVALID");
  }
  const task = normalizedTask(inputTask);
  const currentMaterial = normalizedCurrentMaterial(inputCurrentMaterial, accountId);
  tokenLimit = Math.max(1, Math.round(Number(tokenLimit) || WORKING_CONTEXT_TOKEN_BUDGET));
  maxHistorical = Math.max(0, Math.min(50, Math.round(Number(maxHistorical) || 0)));
  const degradedNotice = "历史证据暂不可用，本次仅依据当前材料。";
  const currentCompiled = compiledPrompt(
    compilePrompt,
    task,
    currentMaterial,
    [],
    degradedNotice
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
  if (status === "complete") {
    const queryTerms = searchTerms([task.text, ...currentMaterial.map(item => item.text)].join("\n"));
    const currentSourceKeys = new Set(currentMaterial.map(item => item.sourceKey));
    rankedCandidates = candidates.map(candidate => ({
      ...candidate,
      relevanceScore: relevanceScore(queryTerms, candidate, task.text)
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
          notice
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
  const compiled = compiledPrompt(compilePrompt, task, currentMaterial, selectedHistory, notice);
  const receipt = selectionReceipt({
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
    promptContract: compiled.promptContract
  });
  return {
    prompt: compiled.prompt,
    receipt,
    attachmentPaths: [...new Set(currentMaterial.flatMap(item => item.attachmentPaths))]
  };
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
    || !validDigest(receipt.task.textSha256)
    || !validDigest(receipt.promptSha256)
    || !validDigest(receipt.accountBindingSha256)
    || !Array.isArray(receipt.currentMaterial)
    || !receipt.currentMaterial.length
    || !Array.isArray(receipt.selected)
    || !Array.isArray(receipt.evidenceChecks)
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
    ))
    || receipt.selected.some(item => (
      item?.channel === "history" && !evidenceIds.has(item.evidenceId)
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
      tokenLimit: receipt.tokenBudget?.limit
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
  if (!located) return false;
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
  if (receipt.schemaVersion !== 2) return personalContextReceiptMatches(store, receipt);
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
    evidenceChecks = []
  } = {}) => {
    const normalizedText = safeText(text, 120_000);
    const attachmentPaths = list(item?.attachmentPaths);
    if (!item?.id || (!normalizedText && !attachmentPaths.length)) return;
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
      settledVersion: recordVersion(item.version) + settledVersionDelta,
      occurredAt: safeText(item.occurredAt || item.createdAt || root.occurredAt || root.createdAt, 100),
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
    settledVersionDelta: currentFollowUpId ? 1 : 0
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
      evidenceChecks: modelOutput ? list(item.contextReceipt?.evidenceChecks) : []
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
        settledVersionDelta: item.id === currentFollowUpId ? 1 : 0
      }
    );
    if (item.answer) {
      const allowed = item.contextAllowed !== false
        && (!modelOutput || contextDerivedOutputAllowed(store, item, accountId, {
          kind: "followUpAnswer",
          targetId: root.id,
          subtargetId: item.id
        }));
      if (!modelOutput || allowed) {
        add(
          item,
          `followup-answer:${item.id}`,
          item.answer,
          modelOutput ? "AI 追问回答" : "用户追问回答",
          {
            validation: "version",
            settledVersionDelta: item.id === currentFollowUpId ? 1 : 0,
            contextAllowed: allowed,
            evidenceChecks: modelOutput ? list(item.contextReceipt?.evidenceChecks) : []
          }
        );
      }
    }
  }
  for (const item of list(root.annotations)) {
    if (item?.contextAllowed === false || item?.disposition === "discarded") continue;
    const conversation = list(item.shenji)
      .filter(turn => contextDerivedOutputAllowed(store, turn, accountId, {
        kind: "annotationShenji",
        targetId: root.id,
        subtargetId: item.id
      }))
      .map(turn => `${turn.message || ""}\n${turn.answer || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    add(
      item,
      `annotation:${item.id}`,
      [item.quote, item.text, conversation].filter(Boolean).join("\n"),
      "批注与追问",
      { validation: "version" }
    );
  }
  return materials;
}
