import crypto from "node:crypto";
import { onboardingV2ContextEntries } from "../modules/onboarding/index.mjs";
import {
  CLAIM_EXTRACTION_MAX_CHARS,
  normalizeUserClaims,
  projectUserModel
} from "../modules/user-model/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";

export const USER_MODEL_DOMAIN_LABELS = Object.freeze({
  context: "处境",
  goals: "目标",
  state: "状态",
  behavior: "行为",
  mind: "认知",
  values: "价值",
  relationships: "关系",
  collaboration: "协作"
});

const contentHash = value => crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
const extractionSchema = JSON.stringify({
  claims: [{
    domain: "context|goals|state|behavior|mind|values|relationships|collaboration",
    statement: "string",
    scope: "string (optional)",
    epistemic: "known|hypothesis",
    evidenceStrength: "self_report|single_observation|multiple_observations|insufficient",
    evidence: [{ sourceId: "question id", span: [0, 1] }]
  }],
  unknowns: [{
    question: "string",
    domain: "one domain",
    reason: "string",
    impactOnNextAnswer: "string",
    relatedClaimIndexes: [0]
  }]
});

export function userModelEvidenceCurrent(store, evidence) {
  if (evidence?.sourceType !== "onboardingV2Answer") return false;
  const entry = onboardingV2ContextEntries(store?.onboardingV2)
    .find(item => item.id === evidence.sourceId);
  if (!entry || entry.version !== evidence.sourceVersion || contentHash(entry.text) !== evidence.contentSha256) {
    return false;
  }
  const [start, end] = evidence.span || [];
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= entry.text.length;
}

export function activeUserModelEntries(store) {
  return normalizeUserClaims(store?.userClaims)
    .filter(claim => claim.lifecycle === "active" && claim.contextAllowed !== false)
    .map(claim => ({
      ...claim,
      title: USER_MODEL_DOMAIN_LABELS[claim.domain] || claim.domain,
      informationType: claim.epistemic === "known" ? "user_fact" : "model_summary",
      text: claim.scope ? `${claim.statement}（范围：${claim.scope}）` : claim.statement
    }));
}

export function userModelProjection(store) {
  return projectUserModel(store, { isEvidenceCurrent: userModelEvidenceCurrent });
}

export function prepareUserModelExtraction(store, { sourceRevision = 0 } = {}) {
  const currentRevision = Math.max(0, Number(store?.onboardingV2?.session?.revision) || 0);
  if (sourceRevision && sourceRevision !== currentRevision) {
    return { versionConflict: true, currentRevision };
  }
  const sources = onboardingV2ContextEntries(store?.onboardingV2).map(entry => ({
    id: entry.id,
    title: entry.title,
    text: entry.text,
    version: entry.version,
    contentSha256: contentHash(entry.text)
  }));
  if (!sources.length) return { empty: true, currentRevision };
  const inputCharacters = sources.reduce((sum, source) => sum + source.text.length, 0);
  if (inputCharacters > CLAIM_EXTRACTION_MAX_CHARS) {
    return { tooLong: true, inputCharacters, maxCharacters: CLAIM_EXTRACTION_MAX_CHARS, currentRevision };
  }
  const sourceDocument = JSON.stringify(sources.map(({ contentSha256: _hash, ...source }) => source));
  return {
    value: {
      kind: "onboardingClaimExtraction",
      inputVersion: currentRevision,
      inputHash: contentHash(JSON.stringify(sources)),
      prompt: renderPrompt("onboarding.claims.extract", {
        sources: sourceDocument,
        schema: extractionSchema
      }),
      scene: "onboardingClaimExtraction",
      json: true,
      auditPrompt: false,
      maxTokens: 4000,
      sources
    }
  };
}

export function createUserModelExtractionService({ repository, backgroundAi }) {
  if (!repository?.read || !backgroundAi?.enqueue || !backgroundAi?.getResult || !backgroundAi?.cancelPersisted) {
    throw new TypeError("User model extraction requires a repository and background task service");
  }
  return {
    async enqueue({ sourceRevision, clientRequestId }) {
      sourceRevision = Number(sourceRevision);
      if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
        return { invalid: true, fields: { sourceRevision: "必须是当前五问 revision" } };
      }
      const prepared = prepareUserModelExtraction(await repository.read(), { sourceRevision });
      if (!prepared.value) return prepared;
      return backgroundAi.enqueue({
        kind: "onboardingClaimExtraction",
        resourceType: "onboardingV2",
        targetId: "onboarding-v2",
        inputVersion: sourceRevision,
        clientRequestId
      });
    },
    async get(id) {
      const value = await backgroundAi.getResult(id);
      return value?.task?.kind === "onboardingClaimExtraction" ? value : null;
    },
    async cancel(id) {
      const value = await backgroundAi.getResult(id);
      if (value?.task?.kind !== "onboardingClaimExtraction") return null;
      return backgroundAi.cancelPersisted(id);
    }
  };
}
