import crypto from "node:crypto";
import {
  normalizeOnboardingV2,
  onboardingV2ContextEntries,
  onboardingV2Schema
} from "../modules/onboarding/index.mjs";
import {
  CLAIM_EXTRACTION_MAX_CHARS,
  evidenceSourceKey,
  normalizeEvidencePermission,
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
const list = value => Array.isArray(value) ? value : [];
const extractionSchema = JSON.stringify({
  claims: [{
    domain: "context|goals|state|behavior|mind|values|relationships|collaboration",
    statement: "string",
    scope: "string (optional)",
    epistemic: "known|hypothesis",
    evidenceStrength: "self_report|single_observation|multiple_observations|insufficient",
    evidence: [{ sourceId: "question id", exactQuote: "verbatim source text", span: [0, 1] }]
  }],
  unknowns: [{
    question: "string",
    domain: "one domain",
    reason: "string",
    impactOnNextAnswer: "string",
    relatedClaimIndexes: [0]
  }]
});

function onboardingEntryContextAllowed(store, entry) {
  if (!entry || entry.contextAllowed === false) return false;
  const sourceKey = evidenceSourceKey({
    resourceType: "onboardingV2",
    resourceId: entry.id,
    rootId: "",
    targetKey: `answer:${entry.id}`,
    version: entry.version
  });
  if (!sourceKey) return false;
  const permissions = list(store?.evidencePermissions)
    .filter(item => item?.sourceKey === sourceKey);
  if (!permissions.length) return true;
  if (permissions.length !== 1) return false;
  return normalizeEvidencePermission(permissions[0])?.contextAllowed === true;
}

function permittedOnboardingEntries(store) {
  return onboardingV2ContextEntries(store?.onboardingV2)
    .filter(entry => onboardingEntryContextAllowed(store, entry));
}

export function userModelEvidenceCurrent(store, evidence) {
  if (evidence?.sourceType !== "onboardingV2Answer") return false;
  const entry = permittedOnboardingEntries(store)
    .find(item => item.id === evidence.sourceId);
  if (!entry
    || entry.version !== evidence.sourceVersion
    || contentHash(entry.text) !== evidence.contentSha256) {
    return false;
  }
  const [start, end] = evidence.span || [];
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= entry.text.length;
}

export function activeUserModelEntries(store) {
  return projectUserModel(store, { isEvidenceCurrent: userModelEvidenceCurrent }).claims
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

const EXPLICIT_ANSWER_DISPOSITIONS = new Set(["unknown", "declined"]);

function onboardingQuestionAnswered(onboarding, questionId) {
  if (questionId === "collaboration") {
    const collaboration = onboarding.session.collaboration;
    return EXPLICIT_ANSWER_DISPOSITIONS.has(collaboration.answerDisposition)
      || Boolean(collaboration.additionalBoundary)
      || ["responseLength", "suggestionMode", "challengeStyle"].some(key => (
        collaboration[key]?.source === "user"
      ));
  }
  const answer = onboarding.session.answers[questionId];
  return Boolean(answer && (
    EXPLICIT_ANSWER_DISPOSITIONS.has(answer.answerDisposition)
      || answer.rawText
      || answer.structuredValue?.length
  ));
}

/** 按当前获准来源选择最新任务；会话导航版本不参与内容身份。 */
function currentModelExtraction(store, inputHash) {
  return (Array.isArray(store?.aiTasks) ? store.aiTasks : [])
    .filter(task => task?.kind === "onboardingClaimExtraction"
      && task.targetId === "onboarding-v2" && task.inputHash === inputHash)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
}

export function userModelCoreReadiness(store) {
  const onboarding = normalizeOnboardingV2(store?.onboardingV2, store?.onboarding);
  if (onboarding.migration.selectedFlow !== "v2"
    || onboarding.session.status !== "completed") {
    return { ready: false, reason: "onboarding_incomplete" };
  }
  const missingQuestions = onboardingV2Schema.questions
    .map(question => question.questionId)
    .filter(questionId => !onboardingQuestionAnswered(onboarding, questionId));
  if (missingQuestions.length) {
    return { ready: false, reason: "answers_incomplete", missingQuestions };
  }
  const prepared = prepareUserModelExtraction(store, {
    sourceRevision: onboarding.session.revision
  });
  if (!prepared.value) {
    return prepared.empty
      ? { ready: true, reason: "no_permitted_model_sources" }
      : { ready: false, reason: prepared.versionConflict ? "source_changed" : "model_unavailable" };
  }
  const task = currentModelExtraction(store, prepared.value.inputHash);
  if (task?.status === "succeeded") {
    return { ready: true, reason: "current_extraction_succeeded", taskId: task.id };
  }
  return {
    ready: false,
    reason: task && ["failed", "cancelled", "stale"].includes(task.status)
      ? "model_generation_failed" : task ? "model_generation_pending" : "model_generation_not_started",
    ...(task ? { taskId: task.id, taskStatus: task.status } : {})
  };
}

/**
 * 只有用户实际提交过补充问答内容，核心模型整理才会成为回答任务的前置条件。
 * 仅打开补交流程、没有提交任何回答时，回答可以使用缺省用户模型上下文继续执行。
 */
export function userModelSupplementSubmitted(store) {
  const onboarding = normalizeOnboardingV2(store?.onboardingV2, store?.onboarding);
  return onboarding.readiness !== "empty";
}

const CORE_MODEL_OPTIONAL_TASKS_WITHOUT_SUBMISSION = new Set([
  "thoughtAnswer",
  "followUpAnswer",
  "thoughtDraft",
  "thoughtPrompt"
]);

export function userModelRequiresCoreReady(store, taskKind = "thoughtAnswer") {
  const readiness = userModelCoreReadiness(store);
  if (readiness.ready) return false;
  const prepared = prepareUserModelExtraction(store);
  const task = prepared.value && currentModelExtraction(store, prepared.value.inputHash);
  // 失败不等于就绪：保留失败状态，回答改用缺省上下文；当前新任务在途仍等待。
  if (task && ["failed", "cancelled", "stale"].includes(task.status)) return false;
  if (CORE_MODEL_OPTIONAL_TASKS_WITHOUT_SUBMISSION.has(taskKind)) {
    return Boolean(task && ["queued", "running"].includes(task.status));
  }
  return true;
}

export function coreUserModelProjection(store) {
  if (!userModelCoreReadiness(store).ready) return null;
  const onboarding = normalizeOnboardingV2(store?.onboardingV2, store?.onboarding);
  const permittedEntries = permittedOnboardingEntries(store);
  const permittedIds = new Set(permittedEntries.map(entry => entry.id));
  const sourceById = new Map(permittedEntries.map(entry => [entry.id, entry]));
  const answers = permittedEntries.map(entry => ({
    sourceId: entry.id,
    citationId: `core:onboarding:${entry.id}`,
    title: entry.title,
    informationType: entry.informationType,
    text: entry.text,
    sourceVersion: entry.version
  }));
  const claims = activeUserModelEntries(store)
    .map(claim => ({
      domain: claim.domain,
      epistemic: claim.epistemic,
      statement: claim.statement,
      scope: claim.scope || "",
      evidence: claim.evidence.flatMap(evidence => {
        const source = sourceById.get(evidence.sourceId);
        const [start, end] = evidence.span || [];
        if (!source || source.version !== evidence.sourceVersion
          || !Number.isInteger(start) || !Number.isInteger(end)
          || start < 0 || end <= start || end > source.text.length) return [];
        return [{
          sourceId: source.id,
          citationId: `core:onboarding:${source.id}`,
          sourceVersion: source.version,
          exactQuote: source.text.slice(start, end)
        }];
      }).sort((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.exactQuote.localeCompare(right.exactQuote)
      ))
    }))
    .sort((left, right) => (
      left.domain.localeCompare(right.domain)
      || left.statement.localeCompare(right.statement)
      || left.scope.localeCompare(right.scope)
    ));
  const unknowns = onboardingV2Schema.questions.flatMap(question => {
    const response = question.questionId === "collaboration"
      ? onboarding.session.collaboration
      : onboarding.session.answers[question.questionId];
    if (!EXPLICIT_ANSWER_DISPOSITIONS.has(response?.answerDisposition)
      || !permittedIds.has(question.questionId)) return [];
    return [{
      questionId: question.questionId,
      answerDisposition: response.answerDisposition
    }];
  });
  const model = { schemaVersion: 1, claims, answers, unknowns };
  return { ...model, fingerprint: contentHash(JSON.stringify(model)) };
}

export function prepareUserModelExtraction(store, { sourceRevision = 0 } = {}) {
  const currentRevision = Math.max(0, Number(store?.onboardingV2?.session?.revision) || 0);
  if (sourceRevision && sourceRevision !== currentRevision) {
    return { versionConflict: true, currentRevision };
  }
  const sources = permittedOnboardingEntries(store).map(entry => ({
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
      retryWithoutThinking: true,
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
      const store = await repository.read();
      const prepared = prepareUserModelExtraction(store, { sourceRevision });
      if (!prepared.value) {
        if (prepared.empty && userModelCoreReadiness(store).ready) {
          await backgroundAi.releaseWaiting?.();
          return { ready: true };
        }
        return prepared;
      }
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
