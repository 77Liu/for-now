import crypto from "node:crypto";
import { recordVersion, safeIso, safeText } from "../../shared/validation/index.mjs";
export {
  EVIDENCE_ERROR_CODES,
  EVIDENCE_INFORMATION_TYPES,
  EVIDENCE_ORIGINS,
  EVIDENCE_PURPOSES,
  PERCEPTION_EVENT_KINDS,
  deduplicateEvidenceByEvent,
  evaluateEvidence,
  evaluateStoredEvidenceChecks,
  evidenceEventKey,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  normalizePerceptionEvent,
  parseEvidenceSourceKey,
  revokeEvidencePermissionsForResource
} from "./evidence.mjs";
export {
  PERCEPTION_MAX_EVIDENCE,
  PERCEPTION_MAX_SOURCE_CHARS,
  PERCEPTION_VERSION,
  parsePerceptionExtractionOutput,
  perceptionExtractionSchema
} from "./perception.mjs";

export const USER_MODEL_DOMAINS = Object.freeze([
  "context",
  "goals",
  "state",
  "behavior",
  "mind",
  "values",
  "relationships",
  "collaboration"
]);

export const CLAIM_LIFECYCLES = Object.freeze([
  "candidate",
  "active",
  "disputed",
  "superseded",
  "retracted",
  "stale"
]);
export const CLAIM_EXTRACTION_MAX_CHARS = 8000;
export const CLAIM_EXTRACTION_MAX_CANDIDATES = 20;

const DOMAIN_SET = new Set(USER_MODEL_DOMAINS);
const LIFECYCLE_SET = new Set(CLAIM_LIFECYCLES);
const EPISTEMIC_SET = new Set(["known", "hypothesis"]);
const EVIDENCE_STRENGTH_SET = new Set([
  "self_report",
  "single_observation",
  "multiple_observations",
  "insufficient"
]);
const SOURCE_TYPE_SET = new Set(["onboardingV2Answer"]);
const ACTION_SET = new Set(["confirm", "revise", "reject", "retract"]);
const clone = value => structuredClone(value);
const objectValue = value => value && typeof value === "object" && !Array.isArray(value);
const validHash = value => /^[a-f0-9]{64}$/.test(value);
const keysMatch = (value, allowed, required = allowed) => {
  if (!objectValue(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key)) && required.every(key => keys.includes(key));
};

function normalizeEvidence(value) {
  if (!objectValue(value)) return null;
  const sourceType = safeText(value.sourceType, 40);
  const sourceId = safeText(value.sourceId, 100);
  const sourceVersion = Math.max(0, Math.round(Number(value.sourceVersion) || 0));
  const contentSha256 = safeText(value.contentSha256, 64).toLowerCase();
  const span = Array.isArray(value.span) && value.span.length === 2
    ? value.span.map(item => Math.max(0, Math.round(Number(item) || 0)))
    : [];
  if (!SOURCE_TYPE_SET.has(sourceType) || !sourceId || !sourceVersion || !validHash(contentSha256)) return null;
  if (span.length !== 2 || span[1] <= span[0]) return null;
  return { sourceType, sourceId, sourceVersion, contentSha256, span };
}

export function normalizeUserClaim(value) {
  if (!objectValue(value)) return null;
  const id = safeText(value.id, 100);
  const domain = safeText(value.domain, 40);
  const statement = safeText(value.statement, 1000);
  const evidence = (Array.isArray(value.evidence) ? value.evidence : [])
    .map(normalizeEvidence)
    .filter(Boolean)
    .slice(0, 10);
  if (!id || !DOMAIN_SET.has(domain) || !statement || !evidence.length) return null;
  const lifecycle = LIFECYCLE_SET.has(value.lifecycle) ? value.lifecycle : "candidate";
  const epistemic = EPISTEMIC_SET.has(value.epistemic) ? value.epistemic : "hypothesis";
  const evidenceStrength = EVIDENCE_STRENGTH_SET.has(value.evidenceStrength)
    ? value.evidenceStrength
    : epistemic === "known" ? "self_report" : "insufficient";
  return {
    id,
    domain,
    statement,
    scope: safeText(value.scope, 500),
    epistemic,
    lifecycle,
    confidence: null,
    evidenceStrength,
    evidence,
    validFrom: safeText(value.validFrom, 100),
    validTo: safeText(value.validTo, 100),
    confirmedAt: safeIso(value.confirmedAt),
    lastReviewedAt: safeIso(value.lastReviewedAt),
    supersedes: safeText(value.supersedes, 100),
    contextAllowed: value.contextAllowed !== false,
    createdAt: safeIso(value.createdAt),
    updatedAt: safeIso(value.updatedAt),
    version: recordVersion(value.version),
    sourceTaskId: safeText(value.sourceTaskId, 100),
    disposition: safeText(value.disposition, 80)
  };
}

export function normalizeModelUnknown(value) {
  if (!objectValue(value)) return null;
  const id = safeText(value.id, 100);
  const question = safeText(value.question, 1000);
  const domain = safeText(value.domain, 40);
  if (!id || !question || !DOMAIN_SET.has(domain)) return null;
  return {
    id,
    question,
    domain,
    reason: safeText(value.reason, 1000),
    relatedEvidence: [...new Set((Array.isArray(value.relatedEvidence) ? value.relatedEvidence : [])
      .map(item => safeText(item, 100))
      .filter(Boolean))].slice(0, 20),
    impactOnNextAnswer: safeText(value.impactOnNextAnswer, 1000),
    askedAt: safeIso(value.askedAt),
    snoozedUntil: safeIso(value.snoozedUntil),
    resolvedBy: safeText(value.resolvedBy, 100),
    createdAt: safeIso(value.createdAt),
    updatedAt: safeIso(value.updatedAt),
    version: recordVersion(value.version),
    sourceTaskId: safeText(value.sourceTaskId, 100)
  };
}

export const normalizeUserClaims = value => (Array.isArray(value) ? value : [])
  .map(normalizeUserClaim)
  .filter(Boolean);

export const normalizeModelUnknowns = value => (Array.isArray(value) ? value : [])
  .map(normalizeModelUnknown)
  .filter(Boolean);

export function parseClaimExtractionOutput(raw, {
  sources,
  sourceTaskId,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString()
} = {}) {
  let document;
  try {
    document = typeof raw === "string" ? JSON.parse(raw) : clone(raw);
  } catch {
    throw Object.assign(new Error("候选提取结果不是有效 JSON"), { code: "CLAIM_EXTRACTION_INVALID" });
  }
  if (!keysMatch(document, ["claims", "unknowns"], ["claims", "unknowns"])
    || !Array.isArray(document.claims)
    || !Array.isArray(document.unknowns)
    || document.unknowns.length > 1
    || document.claims.length + document.unknowns.length > CLAIM_EXTRACTION_MAX_CANDIDATES) {
    throw Object.assign(new Error("候选提取结果不符合数量或结构约束"), { code: "CLAIM_EXTRACTION_INVALID" });
  }
  const sourceById = new Map((Array.isArray(sources) ? sources : []).map(source => [source.id, source]));
  const createdAt = safeIso(now());
  if (!createdAt) throw new TypeError("Claim extraction now() must return an ISO date");
  const claimIds = [];
  const claims = document.claims.map(candidate => {
    const allowed = ["domain", "statement", "scope", "epistemic", "evidenceStrength", "evidence"];
    if (!keysMatch(candidate, allowed, ["domain", "statement", "epistemic", "evidenceStrength", "evidence"])
      || !DOMAIN_SET.has(candidate.domain)
      || !EPISTEMIC_SET.has(candidate.epistemic)
      || !EVIDENCE_STRENGTH_SET.has(candidate.evidenceStrength)
      || typeof candidate.statement !== "string"
      || !candidate.statement.trim()
      || candidate.statement.length > 1000
      || (candidate.scope != null && (typeof candidate.scope !== "string" || candidate.scope.length > 500))
      || !Array.isArray(candidate.evidence)
      || !candidate.evidence.length
      || candidate.evidence.length > 10) {
      throw Object.assign(new Error("候选 claim 字段无效"), { code: "CLAIM_EXTRACTION_INVALID" });
    }
    const evidence = candidate.evidence.map(reference => {
      if (!keysMatch(reference, ["sourceId", "span", "exactQuote"], ["sourceId", "span"])
        || typeof reference.sourceId !== "string"
        || !Array.isArray(reference.span)
        || reference.span.length !== 2
        || !reference.span.every(Number.isInteger)
        || (reference.exactQuote !== undefined
          && (typeof reference.exactQuote !== "string"
            || !reference.exactQuote.trim()
            || reference.exactQuote.length > CLAIM_EXTRACTION_MAX_CHARS))) {
        throw Object.assign(new Error("候选来源范围无效"), { code: "CLAIM_EXTRACTION_INVALID" });
      }
      const source = sourceById.get(reference.sourceId);
      let [start, end] = reference.span;
      const spanValid = Boolean(source)
        && start >= 0
        && end > start
        && end <= source.text.length
        && Boolean(source.text.slice(start, end).trim());
      const exactQuote = reference.exactQuote || "";
      if (source && exactQuote && (!spanValid || source.text.slice(start, end) !== exactQuote)) {
        const matchedStart = source.text.indexOf(exactQuote);
        const uniqueMatch = matchedStart >= 0
          && source.text.indexOf(exactQuote, matchedStart + 1) < 0;
        if (uniqueMatch) {
          start = matchedStart;
          end = matchedStart + exactQuote.length;
        }
      }
      if (!source || start < 0 || end <= start || end > source.text.length
        || !source.text.slice(start, end).trim()
        || (exactQuote && source.text.slice(start, end) !== exactQuote)) {
        throw Object.assign(new Error("候选来源无法定位到当前原文"), { code: "CLAIM_EXTRACTION_INVALID" });
      }
      return {
        sourceType: "onboardingV2Answer",
        sourceId: source.id,
        sourceVersion: source.version,
        contentSha256: source.contentSha256,
        span: [start, end]
      };
    });
    const id = safeText(createId(), 100);
    if (!id || claimIds.includes(id)) {
      throw Object.assign(new Error("候选 claim ID 无效"), { code: "CLAIM_EXTRACTION_INVALID" });
    }
    claimIds.push(id);
    const normalized = normalizeUserClaim({
      id,
      domain: candidate.domain,
      statement: candidate.statement,
      scope: candidate.scope,
      epistemic: candidate.epistemic,
      lifecycle: "candidate",
      confidence: null,
      evidenceStrength: candidate.evidenceStrength,
      evidence,
      contextAllowed: true,
      createdAt,
      updatedAt: createdAt,
      version: 1,
      sourceTaskId
    });
    if (!normalized || normalized.statement !== safeText(candidate.statement, 1000)) {
      throw Object.assign(new Error("候选 claim 内容无效"), { code: "CLAIM_EXTRACTION_INVALID" });
    }
    return normalized;
  });
  const unknowns = document.unknowns.map(candidate => {
    const allowed = ["question", "domain", "reason", "impactOnNextAnswer", "relatedClaimIndexes"];
    if (!keysMatch(candidate, allowed, ["question", "domain", "reason", "impactOnNextAnswer", "relatedClaimIndexes"])
      || !DOMAIN_SET.has(candidate.domain)
      || typeof candidate.question !== "string"
      || !candidate.question.trim()
      || candidate.question.length > 1000
      || typeof candidate.reason !== "string"
      || candidate.reason.length > 1000
      || typeof candidate.impactOnNextAnswer !== "string"
      || candidate.impactOnNextAnswer.length > 1000
      || !Array.isArray(candidate.relatedClaimIndexes)
      || !candidate.relatedClaimIndexes.every(index => Number.isInteger(index) && index >= 0 && index < claims.length)) {
      throw Object.assign(new Error("待了解项字段无效"), { code: "CLAIM_EXTRACTION_INVALID" });
    }
    const normalized = normalizeModelUnknown({
      id: safeText(createId(), 100),
      question: candidate.question,
      domain: candidate.domain,
      reason: candidate.reason,
      relatedEvidence: [...new Set(candidate.relatedClaimIndexes.map(index => claims[index].id))],
      impactOnNextAnswer: candidate.impactOnNextAnswer,
      createdAt,
      updatedAt: createdAt,
      version: 1,
      sourceTaskId
    });
    if (!normalized || normalized.question !== safeText(candidate.question, 1000)) {
      throw Object.assign(new Error("待了解项内容无效"), { code: "CLAIM_EXTRACTION_INVALID" });
    }
    return normalized;
  });
  return { claims, unknowns };
}

function patchInput(input, current) {
  if (!objectValue(input)) return { error: "请求内容必须是对象", code: "CLAIM_PATCH_INVALID" };
  const action = safeText(input.action, 20);
  if (!ACTION_SET.has(action)) return { error: "claim 操作无效", code: "CLAIM_ACTION_INVALID" };
  const editable = ["confirm", "revise"].includes(action);
  const statement = editable ? safeText(input.statement ?? current.statement, 1000) : current.statement;
  const scope = editable ? safeText(input.scope ?? current.scope, 500) : current.scope;
  const epistemic = editable ? safeText(input.epistemic ?? current.epistemic, 20) : current.epistemic;
  if (editable && !statement) return { error: "claim 内容不能为空", code: "CLAIM_STATEMENT_REQUIRED" };
  if (editable && !EPISTEMIC_SET.has(epistemic)) return { error: "claim 认识状态无效", code: "CLAIM_EPISTEMIC_INVALID" };
  return {
    value: {
      action,
      statement,
      scope,
      epistemic,
      contextAllowed: editable
        ? input.contextAllowed == null ? current.contextAllowed : input.contextAllowed !== false
        : current.contextAllowed,
      disposition: safeText(input.reason, 80)
    }
  };
}

function currentClaim(store, claim, isEvidenceCurrent) {
  if (claim.evidence.every(evidence => isEvidenceCurrent(store, evidence))) return claim;
  if (claim.lifecycle === "candidate") return { ...claim, lifecycle: "stale" };
  if (claim.lifecycle === "active") return { ...claim, lifecycle: "disputed" };
  return claim;
}

export function projectUserModel(store, { isEvidenceCurrent = () => true } = {}) {
  const claims = normalizeUserClaims(store?.userClaims)
    .map(claim => currentClaim(store, claim, isEvidenceCurrent));
  const unknowns = normalizeModelUnknowns(store?.modelUnknowns);
  return {
    readiness: store?.onboardingV2?.readiness || "empty",
    claims,
    unknowns,
    activeClaimCount: claims.filter(claim => claim.lifecycle === "active").length,
    disputedClaimCount: claims.filter(claim => claim.lifecycle === "disputed").length,
    candidateCount: claims.filter(claim => claim.lifecycle === "candidate").length,
    staleCandidateCount: claims.filter(claim => claim.lifecycle === "stale").length
  };
}

export function createUserModelService({
  repository,
  isEvidenceCurrent = () => true,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("User model service requires a readable and writable repository");
  }
  const timestamp = () => {
    const value = safeIso(now());
    if (!value) throw new TypeError("User model now() must return an ISO date");
    return value;
  };
  const generatedId = () => {
    const value = safeText(createId(), 100);
    if (!value) throw new TypeError("User model createId() must return an ID");
    return value;
  };

  return {
    async get() {
      return projectUserModel(await repository.read(), { isEvidenceCurrent });
    },

    async patchClaim(id, input, { expectedVersion } = {}) {
      id = safeText(id, 100);
      if (!id) return { missing: true };
      return clone(await repository.update(store => {
        store.userClaims = normalizeUserClaims(store.userClaims);
        const index = store.userClaims.findIndex(item => item.id === id);
        if (index < 0) return { missing: true };
        const current = store.userClaims[index];
        const currentVersion = recordVersion(current.version);
        if (expectedVersion !== currentVersion) return { versionConflict: true, currentVersion };
        const evidenceCurrent = current.evidence.every(evidence => isEvidenceCurrent(store, evidence));
        const requestedAction = safeText(input?.action, 20);
        if (!evidenceCurrent
          && ["candidate", "active", "disputed"].includes(current.lifecycle)
          && !["reject", "retract"].includes(requestedAction)) {
          const changedAt = timestamp();
          const lifecycle = current.lifecycle === "candidate" ? "stale" : "disputed";
          const stale = {
            ...current,
            lifecycle,
            disposition: "source_changed",
            ...(current.lifecycle === lifecycle
              ? {}
              : { updatedAt: changedAt, version: currentVersion + 1 })
          };
          store.userClaims[index] = stale;
          return { stale: true, value: stale };
        }
        const parsed = patchInput(input, current);
        if (parsed.error) return parsed;
        const { action, ...fields } = parsed.value;
        const changedAt = timestamp();
        if (action === "confirm") {
          if (current.lifecycle !== "candidate") return { invalidState: true, currentLifecycle: current.lifecycle };
          const value = {
            ...current,
            ...fields,
            lifecycle: "active",
            confirmedAt: changedAt,
            lastReviewedAt: changedAt,
            updatedAt: changedAt,
            version: currentVersion + 1
          };
          store.userClaims[index] = value;
          return { value };
        }
        if (action === "revise") {
          if (!["candidate", "active", "disputed"].includes(current.lifecycle)) {
            return { invalidState: true, currentLifecycle: current.lifecycle };
          }
          const nextId = generatedId();
          if (store.userClaims.some(item => item.id === nextId)) return { conflict: true, code: "CLAIM_ID_CONFLICT" };
          const previous = {
            ...current,
            lifecycle: "superseded",
            validTo: changedAt,
            updatedAt: changedAt,
            version: currentVersion + 1
          };
          const value = {
            ...current,
            ...fields,
            id: nextId,
            lifecycle: "active",
            confidence: null,
            confirmedAt: changedAt,
            lastReviewedAt: changedAt,
            supersedes: current.id,
            validFrom: changedAt,
            validTo: "",
            createdAt: changedAt,
            updatedAt: changedAt,
            version: 1
          };
          store.userClaims[index] = previous;
          store.userClaims.unshift(value);
          return { value, previous };
        }
        const allowedLifecycles = action === "reject"
          ? ["candidate", "stale"]
          : ["active", "disputed"];
        if (!allowedLifecycles.includes(current.lifecycle)) {
          return { invalidState: true, currentLifecycle: current.lifecycle };
        }
        const value = {
          ...current,
          lifecycle: "retracted",
          disposition: fields.disposition || (action === "reject" ? "user_rejected" : "user_retracted"),
          validTo: changedAt,
          lastReviewedAt: changedAt,
          updatedAt: changedAt,
          version: currentVersion + 1
        };
        store.userClaims[index] = value;
        return { value };
      }));
    }
  };
}
