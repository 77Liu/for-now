import crypto from "node:crypto";
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
  desiredChanges: { kind: "list", max: 300, horizon: true, title: "希望的变化", informationType: "user_viewpoint" },
  recentObstacles: { kind: "list", max: 300, horizon: false, title: "最近的困扰", informationType: "user_viewpoint" },
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

const QUESTION_SCHEMA = Object.freeze([
  {
    questionId: "currentContext",
    step: "q1",
    title: "现在的生活",
    prompt: "你现在处在怎样的生活阶段？有哪些正在发生、会影响你选择的事？",
    kind: "text",
    canSkip: true,
    limits: { maxLength: 2000 }
  },
  {
    questionId: "desiredChanges",
    step: "q2",
    title: "希望的变化",
    prompt: "接下来一段时间，你最希望发生哪些变化？",
    kind: "list",
    canSkip: true,
    limits: { maxItems: 3, itemMaxLength: 300, horizonMaxLength: 100 },
    horizons: ["3m", "6m", "12m", "custom", "unknown"]
  },
  {
    questionId: "recentObstacles",
    step: "q3",
    title: "最近的困扰",
    prompt: "最近有哪些事情正在消耗你，或让推进变得困难？",
    kind: "list",
    canSkip: true,
    limits: { maxItems: 3, itemMaxLength: 300 }
  },
  {
    questionId: "dailyRhythm",
    step: "q4",
    title: "日常节奏",
    prompt: "你最近的作息、工作学习、运动或社交，大致是什么节奏？",
    kind: "text",
    canSkip: true,
    limits: { maxLength: 2000 }
  },
  {
    questionId: "collaboration",
    step: "q5",
    title: "怎么帮助",
    prompt: "你希望我用什么方式和你一起想、一起做？",
    kind: "collaboration",
    canSkip: true,
    limits: { additionalBoundaryMaxLength: 1000 },
    axes: {
      responseLength: {
        values: ["concise", "balanced", "expanded"],
        fallback: "balanced"
      },
      suggestionMode: {
        values: ["actionFirst", "reasonFirst"],
        fallback: "actionFirst"
      },
      challengeStyle: {
        values: ["gentle", "direct"],
        fallback: "gentle"
      }
    }
  }
]);

export const onboardingV2Schema = Object.freeze({
  schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
  questions: QUESTION_SCHEMA,
  steps: [...SESSION_STEPS],
  statuses: [...SESSION_STATUSES],
  defaults: {
    responseLength: "balanced",
    suggestionMode: "actionFirst",
    challengeStyle: "gentle"
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

function normalizeList(value, max, includeHorizon = true) {
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!objectValue(item)) continue;
    const text = safeText(item.text, max);
    if (!text) continue;
    if (!includeHorizon) {
      result.push({ text });
      if (result.length === 3) break;
      continue;
    }
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
    : { structuredValue: normalizeList(value.structuredValue, definition.max, definition.horizon) };
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

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (objectValue(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Onboarding request must be JSON serializable");
  return serialized;
};
const requestDigest = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const fieldError = (fields, path, message) => {
  if (!hasOwn(fields, path)) fields[path] = message;
};

function parseTextAnswer(questionId, input, fields) {
  const definition = ANSWER_DEFINITIONS[questionId];
  if (!objectValue(input)) {
    fieldError(fields, `answers.${questionId}`, "必须是对象或 null");
    return null;
  }
  if (!hasOwn(input, "rawText") || typeof input.rawText !== "string") {
    fieldError(fields, `answers.${questionId}.rawText`, "必须是字符串");
  } else if (input.rawText.trim().length > definition.max) {
    fieldError(fields, `answers.${questionId}.rawText`, `最多 ${definition.max} 个字符`);
  }
  if (hasOwn(input, "occurredAt") && input.occurredAt && !safeIso(input.occurredAt)) {
    fieldError(fields, `answers.${questionId}.occurredAt`, "时间格式不正确");
  }
  if (hasOwn(input, "contextAllowed") && typeof input.contextAllowed !== "boolean") {
    fieldError(fields, `answers.${questionId}.contextAllowed`, "必须是布尔值");
  }
  return {
    rawText: safeText(input.rawText, definition.max),
    ...(hasOwn(input, "occurredAt") ? { occurredAt: safeIso(input.occurredAt) } : {}),
    ...(hasOwn(input, "contextAllowed") ? { contextAllowed: input.contextAllowed } : {})
  };
}

function parseListAnswer(questionId, input, fields) {
  const definition = ANSWER_DEFINITIONS[questionId];
  if (!objectValue(input)) {
    fieldError(fields, `answers.${questionId}`, "必须是对象或 null");
    return null;
  }
  if (!Array.isArray(input.structuredValue)) {
    fieldError(fields, `answers.${questionId}.structuredValue`, "必须是数组");
    return null;
  }
  if (input.structuredValue.length > 3) {
    fieldError(fields, `answers.${questionId}.structuredValue`, "最多 3 项");
  }
  const structuredValue = [];
  for (const [index, item] of input.structuredValue.slice(0, 3).entries()) {
    const base = `answers.${questionId}.structuredValue.${index}`;
    if (!objectValue(item)) {
      fieldError(fields, base, "必须是对象");
      continue;
    }
    if (typeof item.text !== "string") {
      fieldError(fields, `${base}.text`, "必须是字符串");
      continue;
    }
    const text = item.text.trim();
    if (text.length > definition.max) {
      fieldError(fields, `${base}.text`, `最多 ${definition.max} 个字符`);
    }
    if (!text) continue;
    if (!definition.horizon) {
      structuredValue.push({ text: safeText(text, definition.max) });
      continue;
    }
    const horizon = item.horizon == null || item.horizon === "" ? "unknown" : item.horizon;
    if (!HORIZONS.has(horizon)) fieldError(fields, `${base}.horizon`, "期限选项无效");
    const horizonText = safeText(item.horizonText, 100);
    if (horizon === "custom" && !horizonText) {
      fieldError(fields, `${base}.horizonText`, "自定义期限不能为空");
    } else if (typeof item.horizonText === "string" && item.horizonText.trim().length > 100) {
      fieldError(fields, `${base}.horizonText`, "最多 100 个字符");
    }
    structuredValue.push({
      text: safeText(text, definition.max),
      horizon: HORIZONS.has(horizon) ? horizon : "unknown",
      ...(horizon === "custom" && horizonText ? { horizonText } : {})
    });
  }
  if (hasOwn(input, "occurredAt") && input.occurredAt && !safeIso(input.occurredAt)) {
    fieldError(fields, `answers.${questionId}.occurredAt`, "时间格式不正确");
  }
  if (hasOwn(input, "contextAllowed") && typeof input.contextAllowed !== "boolean") {
    fieldError(fields, `answers.${questionId}.contextAllowed`, "必须是布尔值");
  }
  return {
    structuredValue,
    ...(hasOwn(input, "occurredAt") ? { occurredAt: safeIso(input.occurredAt) } : {}),
    ...(hasOwn(input, "contextAllowed") ? { contextAllowed: input.contextAllowed } : {})
  };
}

function parseCollaboration(input, fields) {
  if (!objectValue(input)) {
    fieldError(fields, "collaboration", "必须是对象");
    return {};
  }
  const result = {};
  for (const [key, definition] of Object.entries(COLLABORATION_AXES)) {
    if (!hasOwn(input, key)) continue;
    const axis = input[key];
    if (axis === null || (objectValue(axis) && axis.source === "system_default")) {
      result[key] = { value: definition.fallback, source: "system_default" };
      continue;
    }
    if (!objectValue(axis) || axis.source !== "user" || !definition.values.has(axis.value)) {
      fieldError(fields, `collaboration.${key}`, "选择值或来源无效");
      continue;
    }
    result[key] = { value: axis.value, source: "user" };
  }
  if (hasOwn(input, "additionalBoundary")) {
    if (typeof input.additionalBoundary !== "string") {
      fieldError(fields, "collaboration.additionalBoundary", "必须是字符串");
    } else if (input.additionalBoundary.trim().length > 1000) {
      fieldError(fields, "collaboration.additionalBoundary", "最多 1000 个字符");
    }
    result.additionalBoundary = safeText(input.additionalBoundary, 1000);
  }
  if (hasOwn(input, "contextAllowed")) {
    if (typeof input.contextAllowed !== "boolean") {
      fieldError(fields, "collaboration.contextAllowed", "必须是布尔值");
    } else result.contextAllowed = input.contextAllowed;
  }
  return result;
}

function parseSessionPatch(input) {
  const fields = {};
  if (!objectValue(input)) return { fields: { body: "请求内容必须是对象" } };
  const value = {};
  if (hasOwn(input, "status")) {
    if (!SESSION_STATUSES.has(input.status)) fieldError(fields, "status", "会话状态无效");
    else value.status = input.status;
  }
  if (hasOwn(input, "step")) {
    if (!SESSION_STEPS.has(input.step)) fieldError(fields, "step", "会话步骤无效");
    else value.step = input.step;
  }
  if (hasOwn(input, "selectedFlow")) {
    if (!["legacy", "v2"].includes(input.selectedFlow)) fieldError(fields, "selectedFlow", "入口选择无效");
    else value.selectedFlow = input.selectedFlow;
  }
  if (hasOwn(input, "answers")) {
    if (!objectValue(input.answers)) {
      fieldError(fields, "answers", "必须是对象");
    } else {
      value.answers = {};
      for (const [questionId, answer] of Object.entries(input.answers)) {
        const definition = ANSWER_DEFINITIONS[questionId];
        if (!definition) {
          fieldError(fields, `answers.${questionId}`, "问题标识无效");
          continue;
        }
        value.answers[questionId] = answer === null
          ? null
          : definition.kind === "text"
            ? parseTextAnswer(questionId, answer, fields)
            : parseListAnswer(questionId, answer, fields);
      }
    }
  }
  if (hasOwn(input, "collaboration")) value.collaboration = parseCollaboration(input.collaboration, fields);
  return Object.keys(fields).length ? { fields } : { value };
}

const answerComparable = answer => answer ? {
  ...(hasOwn(answer, "rawText") ? { rawText: answer.rawText } : {}),
  ...(hasOwn(answer, "structuredValue") ? { structuredValue: answer.structuredValue } : {}),
  occurredAt: answer.occurredAt,
  contextAllowed: answer.contextAllowed
} : null;

function mergeAnswer(questionId, patch, existing, at) {
  if (patch === null) return null;
  const definition = ANSWER_DEFINITIONS[questionId];
  const content = definition.kind === "text"
    ? { rawText: patch.rawText }
    : { structuredValue: patch.structuredValue };
  if (!(content.rawText || content.structuredValue?.length)) return null;
  const next = {
    questionId,
    ...content,
    occurredAt: hasOwn(patch, "occurredAt") ? patch.occurredAt : existing?.occurredAt || at,
    contextAllowed: hasOwn(patch, "contextAllowed") ? patch.contextAllowed : existing?.contextAllowed !== false
  };
  const changed = canonicalJson(answerComparable(next)) !== canonicalJson(answerComparable(existing));
  return {
    ...next,
    updatedAt: changed ? at : existing.updatedAt,
    version: existing ? recordVersion(existing.version) + (changed ? 1 : 0) : 1
  };
}

function applySessionPatch(store, patch, expectedVersion, at) {
  const current = normalizeOnboardingV2(store.onboardingV2, store.onboarding);
  const currentVersion = current.session.revision + 1;
  if (expectedVersion !== currentVersion) {
    return {
      versionConflict: true,
      currentVersion,
      current
    };
  }
  const hasV2Mutation = hasOwn(patch, "status")
    || hasOwn(patch, "step")
    || hasOwn(patch, "answers")
    || hasOwn(patch, "collaboration");
  const selectedFlow = patch.selectedFlow
    || (hasV2Mutation ? "v2" : current.migration.selectedFlow);
  const answers = structuredClone(current.session.answers);
  for (const [questionId, answerPatch] of Object.entries(patch.answers || {})) {
    const merged = mergeAnswer(questionId, answerPatch, answers[questionId], at);
    if (merged) answers[questionId] = merged;
    else delete answers[questionId];
  }
  const collaboration = structuredClone(current.session.collaboration);
  for (const key of Object.keys(COLLABORATION_AXES)) {
    if (hasOwn(patch.collaboration, key)) collaboration[key] = patch.collaboration[key];
  }
  if (hasOwn(patch.collaboration, "additionalBoundary")) {
    collaboration.additionalBoundary = patch.collaboration.additionalBoundary;
  }
  if (hasOwn(patch.collaboration, "contextAllowed")) {
    collaboration.contextAllowed = patch.collaboration.contextAllowed;
  }
  const requestedStatus = patch.status || current.session.status;
  const status = selectedFlow === "legacy" ? "skipped" : requestedStatus === "skipped" ? "skipped" : requestedStatus;
  const requestedStep = patch.step || current.session.step;
  const step = ["completed", "skipped"].includes(status) ? "firstAction" : requestedStep;
  const next = normalizeOnboardingV2({
    schemaVersion: ONBOARDING_V2_SCHEMA_VERSION,
    session: {
      ...current.session,
      status,
      step,
      revision: current.session.revision + 1,
      answers,
      collaboration,
      startedAt: selectedFlow === "v2" ? current.session.startedAt || at : current.session.startedAt,
      pausedAt: status === "paused" ? at : "",
      completedAt: status === "completed" ? current.session.completedAt || at : "",
      updatedAt: at
    },
    migration: {
      ...current.migration,
      selectedFlow
    }
  }, store.onboarding);
  store.onboardingV2 = next;
  return { value: next };
}

export function createOnboardingV2Service({
  repository,
  now = () => new Date().toISOString()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.executeIdempotent !== "function") {
    throw new TypeError("Onboarding v2 requires a readable, idempotent repository");
  }
  return {
    schema() {
      return structuredClone(onboardingV2Schema);
    },
    async get() {
      const store = await repository.read();
      return normalizeOnboardingV2(store.onboardingV2, store.onboarding);
    },
    async patch(input, { expectedVersion, clientRequestId }) {
      const parsed = parseSessionPatch(input);
      if (parsed.fields) return { invalid: true, fields: parsed.fields };
      const requestHash = requestDigest({ expectedVersion, patch: parsed.value });
      try {
        return await repository.executeIdempotent({
          scope: "onboarding-v2.session.patch",
          key: clientRequestId,
          requestHash
        }, store => applySessionPatch(store, parsed.value, expectedVersion, now()));
      } catch (error) {
        if (error?.code === "IDEMPOTENCY_KEY_REUSED") {
          return { conflict: true, code: error.code };
        }
        throw error;
      }
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
