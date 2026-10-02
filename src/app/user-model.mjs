import crypto from "node:crypto";
import { onboardingV2ContextEntries } from "../modules/onboarding/index.mjs";
import { normalizeUserClaims, projectUserModel } from "../modules/user-model/index.mjs";

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
