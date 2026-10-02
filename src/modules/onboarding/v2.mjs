import { recordVersion, safeIso, safeText } from "../../shared/validation/index.mjs";

export const ONBOARDING_V2_SCHEMA_VERSION = 2;

const SESSION_STATUSES = new Set(["draft", "paused", "completed", "skipped"]);
const SESSION_STEPS = new Set([
  "welcome",
  "q1",
  "q2",
  "q3",
  "q4",
  "q5",
  "review",
  "candidates",
  "firstAction"
]);
const SELECTED_FLOWS = new Set(["undecided", "legacy", "v2"]);
const HORIZONS = new Set(["3m", "6m", "12m", "custom", "unknown"]);
const ANSWER_DEFINITIONS = Object.freeze({
  currentContext: { kind: "text", max: 2000, title: "当前处境", informationType: "user_fact" },
  desiredChanges: { kind: "list", max: 300, title: "希望的变化", informationType: "user_viewpoint" },
  recentObstacles: { kind: "list", max: 300, title: "最近的困扰", informationType: "user_viewpoint" },
  dailyRhythm: { kind: "text", max: 2000, title: "日常节奏", informationType: "user_fact" }
});
const COLLABORATION_AXES = Object.freeze({
  responseLength: {
    values: new Set(["concise", "balanced", "expanded"]),
    fallback: "balanced",
    labels: { concise: "简洁", balanced: "适中", expanded: "展开" }
  },
  suggestionMode: {
    values: new Set(["actionFirst", "reasonFirst"]),
    fallback: "actionFirst",
    labels: { actionFirst: "先给行动", reasonFirst: "先理清原因" }
  },
  challengeStyle: {
    values: new Set(["gentle", "direct"]),
    fallback: "gentle",
    labels: { gentle: "温和讨论", direct: "直接指出疑点" }
  }
});

export const defaultOnboardingV2 = {
  schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
  session: {
    id: "onboarding-v2",
    schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
    status: "draft",
    step: "welcome",
    revision: 0,
    answers: {},
    collaboration: {
      responseLength: { value: "balanced", source: "system_default" },
      suggestionMode: { value: "actionFirst", source: "system_default" },
      challengeStyle: { value: "gentle", source: "system_default" },
      additionalBoundary: "",
      contextAllowed: true
    },
    startedAt: "",
    pausedAt: "",
    completedAt: "",
    updatedAt: ""
  },
  readiness: "empty",
  migration: {
    selectedFlow: "undecided",
    entryPolicy: "choose",
    legacy: {
      questionnaireVersion: 1,
      status: "pending",
      updatedAt: "",
      answerCount: 0,
      modelSummaryType: "",
      resourceType: "onboarding",
      resourceId: "onboarding"
    }
  }
};

const objectValue = value => value && typeof value === "object" && !Array.isArray(value);
const integer = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

function normalizeList(value, max) {
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!objectValue(item)) continue;
    const text = safeText(item.text, max);
    if (!text) continue;
    const horizon = HORIZONS.has(item.horizon) ? item.horizon : "unknown";
    result.push({
      text,
      horizon,
      ...(horizon === "custom" && safeText(item.horizonText, 100)
        ? { horizonText: safeText(item.horizonText, 100) }
        : {})
    });
    if (result.length === 3) break;
  }
  return result;
}

function normalizeAnswer(questionId, value) {
  if (!objectValue(value)) return null;
  const definition = ANSWER_DEFINITIONS[questionId];
  const content = definition.kind === "text"
    ? { rawText: safeText(value.rawText, definition.max) }
    : { structuredValue: normalizeList(value.structuredValue, definition.max) };
  if (!(content.rawText || content.structuredValue?.length)) return null;
  return {
    questionId,
    ...content,
    occurredAt: safeIso(value.occurredAt),
    updatedAt: safeIso(value.updatedAt),
    version: recordVersion(value.version),
    contextAllowed: value.contextAllowed !== false
  };
}

function normalizeCollaboration(value) {
  const input = objectValue(value) ? value : {};
  const result = {};
  for (const [key, definition] of Object.entries(COLLABORATION_AXES)) {
    const axis = objectValue(input[key]) ? input[key] : {};
    const supplied = definition.values.has(axis.value) && axis.source === "user";
    result[key] = {
      value: supplied ? axis.value : definition.fallback,
      source: supplied ? "user" : "system_default"
    };
  }
  return {
    ...result,
    additionalBoundary: safeText(input.additionalBoundary, 1000),
    contextAllowed: input.contextAllowed !== false
  };
}

function readinessFor(session) {
  const answers = session.answers;
  const collaboration = session.collaboration;
  const userCollaboration = Object.keys(COLLABORATION_AXES).some(
    key => collaboration[key].source === "user"
  ) || Boolean(collaboration.additionalBoundary);
  const hasInput = Boolean(Object.keys(answers).length || userCollaboration);
  if (!hasInput) return "empty";
  if (answers.currentContext && (answers.desiredChanges || answers.recentObstacles)) return "usable";
  return "partial";
}

function legacyReceipt(legacy = {}) {
  return {
    questionnaireVersion: 1,
    status: ["pending", "completed", "dismissed"].includes(legacy.status)
      ? legacy.status
      : "pending",
    updatedAt: safeIso(legacy.updatedAt),
    answerCount: Object.keys(objectValue(legacy.answers) ? legacy.answers : {}).length,
    modelSummaryType: safeText(legacy.understanding, 1) ? "model_summary" : "",
    resourceType: "onboarding",
    resourceId: "onboarding"
  };
}

export function normalizeOnboardingV2(value, legacy = {}) {
  const input = objectValue(value) ? value : {};
  const suppliedSession = objectValue(input.session);
  const legacySource = legacyReceipt(legacy);
  const answers = {};
  for (const questionId of Object.keys(ANSWER_DEFINITIONS)) {
    const answer = normalizeAnswer(questionId, input.session?.answers?.[questionId]);
    if (answer) answers[questionId] = answer;
  }
  const collaboration = normalizeCollaboration(input.session?.collaboration);
  const hasV2Activity = Boolean(
    Object.keys(answers).length
    || integer(input.session?.revision) > 0
    || safeIso(input.session?.startedAt)
    || ["paused", "completed"].includes(input.session?.status)
    || Object.keys(COLLABORATION_AXES).some(key => collaboration[key].source === "user")
    || collaboration.additionalBoundary
  );
  const requestedFlow = safeText(input.migration?.selectedFlow, 20);
  const selectedFlow = requestedFlow === "undecided"
    && legacySource.status === "completed"
    && !hasV2Activity
    ? "legacy"
    : SELECTED_FLOWS.has(requestedFlow)
      ? requestedFlow
      : legacySource.status === "completed" ? "legacy" : "undecided";
  const compatibilitySkip = selectedFlow === "legacy";
  const status = compatibilitySkip
    ? "skipped"
    : SESSION_STATUSES.has(input.session?.status) ? input.session.status : "draft";
  const session = {
    id: safeText(input.session?.id, 100) || "onboarding-v2",
    schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
    status,
    step: compatibilitySkip
      ? "firstAction"
      : SESSION_STEPS.has(input.session?.step) ? input.session.step : "welcome",
    revision: suppliedSession ? integer(input.session.revision) : 0,
    answers,
    collaboration,
    startedAt: safeIso(input.session?.startedAt),
    pausedAt: safeIso(input.session?.pausedAt),
    completedAt: safeIso(input.session?.completedAt),
    updatedAt: safeIso(input.session?.updatedAt)
  };
  return {
    schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
    session,
    readiness: readinessFor(session),
    migration: {
      selectedFlow,
      entryPolicy: selectedFlow === "legacy"
        ? "already_onboarded"
        : selectedFlow === "v2" ? "v2" : "choose",
      legacy: legacySource
    }
  };
}

function listText(items) {
  return items.map(item => (
    item.horizon === "custom" && item.horizonText
      ? `${item.text}（${item.horizonText}）`
      : item.text
  )).join("；");
}

export function onboardingV2ContextEntries(value) {
  const onboarding = normalizeOnboardingV2(value);
  const entries = [];
  for (const [questionId, definition] of Object.entries(ANSWER_DEFINITIONS)) {
    const answer = onboarding.session.answers[questionId];
    if (!answer?.contextAllowed) continue;
    entries.push({
      id: questionId,
      title: definition.title,
      informationType: definition.informationType,
      text: definition.kind === "text" ? answer.rawText : listText(answer.structuredValue),
      occurredAt: answer.occurredAt,
      updatedAt: answer.updatedAt,
      version: answer.version
    });
  }
  const collaboration = onboarding.session.collaboration;
  if (collaboration.contextAllowed) {
    const userAxes = Object.entries(COLLABORATION_AXES)
      .filter(([key]) => collaboration[key].source === "user")
      .map(([key, definition]) => definition.labels[collaboration[key].value]);
    const text = [
      userAxes.length ? `明确选择：${userAxes.join("；")}` : "",
      collaboration.additionalBoundary
        ? `补充边界：${collaboration.additionalBoundary}`
        : ""
    ].filter(Boolean).join("\n");
    if (text) {
      entries.push({
        id: "collaboration",
        title: "协作偏好",
        informationType: "user_viewpoint",
        text,
        occurredAt: onboarding.session.startedAt,
        updatedAt: onboarding.session.updatedAt,
        version: Math.max(1, onboarding.session.revision)
      });
    }
  }
  return entries;
}

export function onboardingV2Context(value) {
  const entries = onboardingV2ContextEntries(value);
  return entries.length
    ? entries.map(entry => `${entry.title}：${entry.text}`).join("\n")
    : "（尚未提供五问原文）";
}
