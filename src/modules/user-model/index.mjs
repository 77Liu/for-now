import crypto from "node:crypto";
import { recordVersion, safeIso, safeText } from "../../shared/validation/index.mjs";

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
    version: recordVersion(value.version)
  };
}

export const normalizeUserClaims = value => (Array.isArray(value) ? value : [])
  .map(normalizeUserClaim)
  .filter(Boolean);

export const normalizeModelUnknowns = value => (Array.isArray(value) ? value : [])
  .map(normalizeModelUnknown)
  .filter(Boolean);

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
  return claim.lifecycle === "candidate" && !claim.evidence.every(evidence => isEvidenceCurrent(store, evidence))
    ? { ...claim, lifecycle: "stale" }
    : claim;
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
        if (current.lifecycle === "candidate"
          && !current.evidence.every(evidence => isEvidenceCurrent(store, evidence))) {
          const changedAt = timestamp();
          const stale = {
            ...current,
            lifecycle: "stale",
            disposition: "source_changed",
            updatedAt: changedAt,
            version: currentVersion + 1
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
        const expectedLifecycle = action === "reject" ? "candidate" : "active";
        if (current.lifecycle !== expectedLifecycle) {
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
