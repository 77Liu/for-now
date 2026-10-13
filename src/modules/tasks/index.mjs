import { safeText } from "../../shared/validation/index.mjs";
import { WAITING_FOR_USER_MODEL_STATUS } from "../../shared/core-model-gate.mjs";

const TASK_KINDS = new Set([
  "thoughtAnswer",
  "followUpAnswer",
  "thoughtDraft",
  "thoughtPrompt",
  "journalAssist",
  "journalReflection",
  "chat",
  "analysis",
  "annotationShenji",
  "contentImageUnderstanding",
  "captureTranscription",
  "onboardingClaimExtraction",
  "perceptionExtraction",
  "recordCompression"
]);
export { WAITING_FOR_USER_MODEL_STATUS };
export const PERSONALIZED_TASK_INTENT_BYTE_BUDGET = 32_000;
const PUBLIC_RESOURCE_TYPES = Object.freeze({
  thoughtAnswer: "thought",
  followUpAnswer: "thought",
  thoughtDraft: "thought",
  thoughtPrompt: "thought",
  journalAssist: "journal",
  journalReflection: "journal",
  chat: "chat",
  analysis: "analysis",
  captureTranscription: "capture",
  onboardingClaimExtraction: "onboardingV2",
  recordCompression: "recordCompression"
});
const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const REUSABLE_EXTRACTION_STATUSES = new Set(["queued", "running", "succeeded"]);
export const WAITING_FOR_BUDGET_STATUS = "waitingBudget";

export function publicAiTask(task) {
  return {
    id: task.id,
    kind: task.kind,
    resourceType: task.resourceType || PUBLIC_RESOURCE_TYPES[task.kind] || "",
    targetId: task.targetId,
    subtargetId: task.subtargetId || "",
    inputVersion: task.inputVersion,
    subtargetVersion: task.subtargetVersion || 0,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt || "",
    completedAt: task.completedAt || "",
    resultId: task.resultId || "",
    error: task.error || "",
    ...(task.errorCode ? { errorCode: task.errorCode } : {}),
    retryOf: task.retryOf || "",
    ...(task.kind === "contentImageUnderstanding" ? {
      contentTargetType: task.payload?.targetType || "",
      contentTargetId: task.payload?.targetId || ""
    } : {})
  };
}

function taskForInput(tasks, { kind, targetId, inputHash }, statuses) {
  return (Array.isArray(tasks) ? tasks : []).find(task => (
    task?.kind === kind
    && task.targetId === targetId
    && task.inputHash === inputHash
    && statuses.has(task.status)
  )) || null;
}

export function activeTaskForInput(tasks, input) {
  return taskForInput(tasks, input, ACTIVE_TASK_STATUSES);
}

export function taskInputMatches(task, work) {
  const legacyAnnotationVersion = task?.kind === "annotationShenji"
    && task.legacyUnversionedSubtarget === true
    && (task.inputVersion || 0) > 0
    && (task.subtargetVersion || 0) === 0;
  return Boolean(work && !work.alreadyAnswered
    && (work.inputVersion || 0) === task.inputVersion
    && (legacyAnnotationVersion
      || (work.subtargetVersion || 0) === (task.subtargetVersion || 0))
    && (!task.inputHash || task.inputHash === work.inputHash));
}

export function createTaskLifecycle({ createId, now, hash }) {
  const requestHash = normalized => {
    if (normalized.kind === "thoughtAnswer") return hash(JSON.stringify({ kind: normalized.kind, targetId: normalized.targetId, inputVersion: normalized.requestedInputVersion }));
    if (normalized.kind === "followUpAnswer") return hash(JSON.stringify({ kind: normalized.kind, targetId: normalized.targetId, subtargetId: normalized.subtargetId, inputVersion: normalized.requestedInputVersion, subtargetVersion: normalized.requestedSubtargetVersion }));
    if (normalized.kind === "contentImageUnderstanding") {
      return hash(JSON.stringify({
        kind: normalized.kind,
        resourceType: normalized.resourceType,
        targetId: normalized.targetId,
        subtargetId: normalized.subtargetId,
        inputVersion: normalized.requestedInputVersion,
        payload: normalized.payload
      }));
    }
    if (normalized.kind === "captureTranscription") {
      return hash(JSON.stringify({
        kind: normalized.kind,
        targetId: normalized.targetId
      }));
    }
    if (normalized.kind === "onboardingClaimExtraction") {
      return hash(JSON.stringify({
        kind: normalized.kind,
        targetId: normalized.targetId,
        inputVersion: normalized.requestedInputVersion
      }));
    }
    if (normalized.kind === "perceptionExtraction") {
      return hash(JSON.stringify({
        kind: normalized.kind,
        resourceType: normalized.resourceType,
        targetId: normalized.targetId,
        subtargetId: normalized.subtargetId,
        inputVersion: normalized.requestedInputVersion,
        payload: normalized.payload
      }));
    }
    return hash(JSON.stringify({ kind: normalized.kind, resourceType: normalized.resourceType, targetId: normalized.targetId, subtargetId: normalized.subtargetId, payload: normalized.payload }));
  };
  const normalizeRequest = input => {
    const kind = safeText(input.kind, 40), targetId = safeText(input.targetId, 100), subtargetId = safeText(input.subtargetId, 100), clientRequestId = safeText(input.clientRequestId, 100);
    const resourceType = kind === "captureTranscription"
      ? "capture"
      : kind === "onboardingClaimExtraction"
        ? "onboardingV2"
      : ["thoughtDraft", "thoughtPrompt"].includes(kind)
        ? "thought"
      : ["journalAssist", "journalReflection"].includes(kind)
        ? "journal"
      : kind === "chat" ? "chat"
      : kind === "analysis" ? "analysis"
      : ["annotationShenji", "contentImageUnderstanding", "perceptionExtraction", "recordCompression"].includes(kind)
        ? safeText(input.resourceType, 40)
        : "thought";
    const binding = {
      requestId: safeText(input.payload?.binding?.requestId, 100),
      targetId: safeText(input.payload?.binding?.targetId, 100),
      inputVersion: Math.max(0, Math.round(Number(input.payload?.binding?.inputVersion) || 0))
    };
    const personalizedPayload = kind === "thoughtDraft"
      ? {
          question: safeText(input.payload?.question, 6_000),
          idea: safeText(input.payload?.idea, 6_000),
          binding
        }
      : kind === "thoughtPrompt"
        ? {
            occurredOn: safeText(input.payload?.occurredOn, 10),
            binding
          }
      : kind === "journalAssist"
        ? {
            mode: ["lead", "structure", "topic"].includes(input.payload?.mode) ? input.payload.mode : "",
            occurredOn: safeText(input.payload?.occurredOn, 10),
            title: safeText(input.payload?.title, 120),
            content: safeText(input.payload?.content, 50_000),
            binding
          }
      : kind === "journalReflection"
        ? {}
      : kind === "chat"
        ? {
            message: safeText(input.payload?.message),
            occurredAt: safeText(input.payload?.occurredAt, 100),
            occurredOn: safeText(input.payload?.occurredOn, 10),
            eventTimeHash: safeText(input.payload?.eventTimeHash, 100)
          }
      : kind === "analysis"
        ? { reason: safeText(input.payload?.reason, 40) || "manual" }
        : null;
    const payload = kind === "annotationShenji"
      ? { message: safeText(input.payload?.message ?? input.message, 6000) }
      : kind === "contentImageUnderstanding"
        ? {
            targetType: safeText(input.payload?.targetType, 40),
            targetId: safeText(input.payload?.targetId, 100),
            attachmentPaths: [...new Set((Array.isArray(input.payload?.attachmentPaths) ? input.payload.attachmentPaths : [])
              .filter(value => typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)))].slice(0, 2)
          }
        : personalizedPayload
          ? personalizedPayload
        : kind === "perceptionExtraction"
          ? {
              accountId: safeText(input.payload?.accountId, 100),
              sourceRef: {
                resourceType: safeText(input.payload?.sourceRef?.resourceType, 40),
                resourceId: safeText(input.payload?.sourceRef?.resourceId, 100),
                rootId: safeText(input.payload?.sourceRef?.rootId, 100),
                targetKey: safeText(input.payload?.sourceRef?.targetKey, 120),
                version: Math.max(0, Math.round(Number(input.payload?.sourceRef?.version) || 0))
              },
              perceptionEventId: safeText(input.payload?.perceptionEventId, 100),
              eventId: safeText(input.payload?.eventId, 100),
              contentSha256: safeText(input.payload?.contentSha256, 64),
              permissionRevision: Math.max(0, Math.round(Number(input.payload?.permissionRevision) || 0)),
              perceptionVersion: safeText(input.payload?.perceptionVersion, 100)
            }
        : kind === "recordCompression"
          ? (() => {
              const historicalSupplement = input.payload?.operation === "historicalSupplement";
              const payload = {
                operation: historicalSupplement ? "historicalSupplement" : "daily",
                localDate: safeText(input.payload?.localDate, 10),
                timezone: safeText(input.payload?.timezone, 100),
                promptVersion: safeText(input.payload?.promptVersion, 100),
                sourceManifestHash: safeText(input.payload?.sourceManifestHash, 64),
                recordId: safeText(input.payload?.recordId, 100)
              };
              if (historicalSupplement) {
                const batchIndex = Number(input.payload?.batchIndex);
                return {
                  ...payload,
                  windowStart: safeText(input.payload?.windowStart, 10),
                  windowEnd: safeText(input.payload?.windowEnd, 10),
                  batchIndex: Number.isSafeInteger(batchIndex) && batchIndex >= 0
                    ? Math.min(1023, batchIndex)
                    : 0,
                  inputAsOf: safeText(input.payload?.inputAsOf, 40)
                };
              }
              return payload;
            })()
        : {};
    const requestedInputVersion = Number(input.inputVersion) > 0 ? Math.round(Number(input.inputVersion)) : 0;
    const requestedSubtargetVersion = Number(input.subtargetVersion) > 0 ? Math.round(Number(input.subtargetVersion)) : 0;
    return { kind, resourceType, targetId, subtargetId, clientRequestId, payload, requestedInputVersion, requestedSubtargetVersion };
  };

  function create(tasks, input, inspectTarget, {
    deferTargetInspection = false,
    requestedIntent = null,
    waitingBudget = false
  } = {}) {
    const normalized = normalizeRequest(input);
    const { kind, resourceType, targetId, subtargetId, clientRequestId, payload, requestedInputVersion, requestedSubtargetVersion } = normalized;
    if (!TASK_KINDS.has(kind)) return { unsupported: true };
    if (waitingBudget && kind !== "recordCompression") return { unsupported: true };
    if (!clientRequestId) return { invalid: true };
    if (["thoughtDraft", "thoughtPrompt", "journalAssist", "journalReflection", "chat", "analysis"].includes(kind)
      && new TextEncoder().encode(JSON.stringify(payload)).length > PERSONALIZED_TASK_INTENT_BYTE_BUDGET) {
      return { inputTooLarge: true, maxBytes: PERSONALIZED_TASK_INTENT_BYTE_BUDGET };
    }
    if (kind === "journalAssist" && !payload.mode) return { invalidIntent: true };
    if (kind === "thoughtDraft" && !payload.question) return { invalidIntent: true };
    if (kind === "chat" && (!payload.message || !payload.occurredAt || !payload.occurredOn)) return { invalidIntent: true };
    const inputRequestHash = requestHash(normalized);
    const duplicate = tasks.find(item => item.clientRequestId === clientRequestId);
    if (duplicate) return duplicate.requestHash === inputRequestHash ? { task: duplicate, duplicate: true } : { conflict: true };
    if (deferTargetInspection && (
      (["thoughtAnswer", "followUpAnswer", "annotationShenji", "journalReflection"].includes(kind) && !targetId)
      || (kind === "followUpAnswer" && !subtargetId)
      || (kind === "annotationShenji" && !subtargetId)
    )) return { missing: true };
    const createdAt = now();
    const inspectionInput = { ...normalized, createdAt };
    const work = deferTargetInspection ? null : inspectTarget(inspectionInput);
    if (!deferTargetInspection && !work) return { missing: true };
    if (work?.alreadyAnswered) return { alreadyAnswered: true };
    if (!deferTargetInspection && requestedInputVersion && requestedInputVersion !== work.inputVersion) return { versionConflict: true, currentVersion: work.inputVersion };
    if (!deferTargetInspection && requestedSubtargetVersion && requestedSubtargetVersion !== work.subtargetVersion) return { subtargetVersionConflict: true, currentVersion: work.subtargetVersion };
    const intentInputVersion = Math.max(0, Number(requestedIntent?.inputVersion) || 0);
    const intentSubtargetVersion = Math.max(0, Number(requestedIntent?.subtargetVersion) || 0);
    if (deferTargetInspection && requestedIntent) {
      if (requestedIntent.alreadyAnswered) return { alreadyAnswered: true };
      if (requestedInputVersion && requestedInputVersion !== intentInputVersion) {
        return { versionConflict: true, currentVersion: intentInputVersion };
      }
      if (requestedSubtargetVersion && requestedSubtargetVersion !== intentSubtargetVersion) {
        return { subtargetVersionConflict: true, currentVersion: intentSubtargetVersion };
      }
    }
    if (kind === "journalReflection") {
      const inputHash = deferTargetInspection
        ? String(requestedIntent?.inputHash ?? "")
        : String(work?.inputHash ?? "");
      const active = inputHash && tasks.find(item => (
        item.kind === kind
        && item.targetId === targetId
        && ["queued", "running", WAITING_FOR_USER_MODEL_STATUS].includes(item.status)
        && (item.inputHash === inputHash || item.requestedIntentInputHash === inputHash)
      ));
      if (active) return { task: active, duplicate: true };
    }
    if (!deferTargetInspection && kind === "captureTranscription") {
      const active = activeTaskForInput(tasks, { kind, targetId, inputHash: work.inputHash });
      if (active) return { task: active, duplicate: true };
    }
    if (!deferTargetInspection && kind === "onboardingClaimExtraction") {
      const reusable = taskForInput(
        tasks,
        { kind, targetId, inputHash: work.inputHash },
        REUSABLE_EXTRACTION_STATUSES
      );
      if (reusable) return { task: reusable, duplicate: true };
    }
    if (!deferTargetInspection && kind === "perceptionExtraction") {
      const existing = taskForInput(
        tasks,
        { kind, targetId, inputHash: work.inputHash },
        REUSABLE_EXTRACTION_STATUSES
      );
      if (existing) return { task: existing, duplicate: true };
    }
    const task = {
      id: createId(), kind, resourceType, targetId, subtargetId,
      inputVersion: deferTargetInspection
        ? (intentInputVersion || requestedInputVersion)
        : work.inputVersion || 0,
      subtargetVersion: deferTargetInspection
        ? (intentSubtargetVersion || requestedSubtargetVersion)
        : work.subtargetVersion || 0,
      inputHash: deferTargetInspection ? "" : work.inputHash,
      requestedInputVersion: deferTargetInspection
        ? (intentInputVersion || requestedInputVersion)
        : work.inputVersion || 0,
      requestedSubtargetVersion: deferTargetInspection
        ? (intentSubtargetVersion || requestedSubtargetVersion)
        : work.subtargetVersion || 0,
      ...(!deferTargetInspection ? { requestedInputHash: work.inputHash || "" } : {}),
      ...(deferTargetInspection && requestedIntent ? {
        requestedIntentInputVersion: intentInputVersion,
        requestedIntentSubtargetVersion: intentSubtargetVersion,
        requestedIntentInputHash: String(requestedIntent.inputHash ?? "")
      } : {}),
      payload, clientRequestId, requestHash: inputRequestHash,
      status: deferTargetInspection
        ? WAITING_FOR_USER_MODEL_STATUS
        : waitingBudget ? WAITING_FOR_BUDGET_STATUS : "queued",
      createdAt, updatedAt: createdAt, attempt: 0,
      ...(["perceptionExtraction", "recordCompression"].includes(kind) ? { internal: true } : {})
    };
    tasks.unshift(task);
    if (!waitingBudget) work?.markQueued?.(task);
    return { task, duplicate: false };
  }

  function promoteWaiting(tasks, id, work, intent = null) {
    const task = tasks.find(item => item.id === id);
    if (!task || task.status !== WAITING_FOR_USER_MODEL_STATUS) return { missing: true };
    const requestedInputVersion = Math.max(0, Number(task.requestedInputVersion) || 0);
    const requestedSubtargetVersion = Math.max(0, Number(task.requestedSubtargetVersion) || 0);
    const hasRequestedIntent = Object.hasOwn(task, "requestedIntentInputVersion")
      || Object.hasOwn(task, "requestedIntentSubtargetVersion")
      || Object.hasOwn(task, "requestedIntentInputHash");
    const intentMatches = !hasRequestedIntent || Boolean(intent && typeof intent === "object"
      && (!Object.hasOwn(task, "requestedIntentInputVersion")
        || Math.max(0, Number(intent.inputVersion) || 0) === task.requestedIntentInputVersion)
      && (!Object.hasOwn(task, "requestedIntentSubtargetVersion")
        || Math.max(0, Number(intent.subtargetVersion) || 0) === task.requestedIntentSubtargetVersion)
      && (!Object.hasOwn(task, "requestedIntentInputHash")
        || String(intent.inputHash ?? "") === task.requestedIntentInputHash));
    const inputVersionMatches = !Object.hasOwn(task, "requestedInputVersion")
      || requestedInputVersion === (work?.inputVersion || 0);
    const subtargetVersionMatches = !Object.hasOwn(task, "requestedSubtargetVersion")
      || requestedSubtargetVersion === (work?.subtargetVersion || 0);
    if (!work || work.alreadyAnswered
      || !intentMatches
      || !inputVersionMatches
      || !subtargetVersionMatches
      || (Object.hasOwn(task, "requestedInputHash")
        && task.requestedInputHash !== (work.inputHash || ""))) {
      complete(task, "stale", { error: "等待期间目标已变化，请刷新后重新发起" });
      return { task, stale: true };
    }
    task.inputVersion = work.inputVersion || 0;
    task.subtargetVersion = work.subtargetVersion || 0;
    task.inputHash = work.inputHash || "";
    task.status = "queued";
    task.updatedAt = now();
    task.error = "";
    task.errorCode = "";
    if (!Object.hasOwn(task, "requestedInputHash")) {
      task.requestedInputHash = work.inputHash || "";
    }
    work.markQueued?.(task);
    return { task, queued: true };
  }

  function promoteBudgetWaiting(tasks, id, work) {
    const task = tasks.find(item => item.id === id);
    if (!task || task.kind !== "recordCompression"
      || task.status !== WAITING_FOR_BUDGET_STATUS) return { missing: true };
    if (!taskInputMatches(task, work)) return { task, stale: true };
    task.status = "queued";
    task.updatedAt = now();
    task.error = "";
    task.errorCode = "";
    work.markQueued?.(task);
    return { task, queued: true };
  }

  /**
   * 仅将当前来源仍匹配的运行中日压缩任务移回预算等待，保留原身份与失败历史。
   * 调用方必须先确认provider尚未执行且预算已安全释放。
   * @since unreleased
   */
  function waitForBudget(tasks, id, work, errorCode = "") {
    const task = tasks.find(item => item.id === id);
    if (!task || task.kind !== "recordCompression" || task.status !== "running") return { missing: true };
    if (!taskInputMatches(task, work)) return { task, stale: true };
    task.status = WAITING_FOR_BUDGET_STATUS;
    task.updatedAt = now();
    task.error = "额度不足，等待预算恢复后重新校验";
    task.errorCode = safeText(errorCode, 100);
    return { task, waiting: true };
  }

  function complete(task, status, {
    resultId = task.resultId || "",
    error = "",
    errorCode = ""
  } = {}) {
    task.status = status;
    task.completedAt = now();
    task.updatedAt = task.completedAt;
    task.error = safeText(error, 500);
    task.errorCode = safeText(errorCode, 100);
    if (status === "succeeded") task.resultId = resultId;
  }

  return {
    create,
    idempotency(input) {
      const normalized = normalizeRequest(input);
      if (!TASK_KINDS.has(normalized.kind) || !normalized.clientRequestId) return null;
      return { scope: "aiTasks.create", key: normalized.clientRequestId, requestHash: requestHash(normalized) };
    },
    complete,
    promoteWaiting,
    promoteBudgetWaiting,
    waitForBudget,
    waitForUserModel(tasks, id) {
      const task = tasks.find(item => item.id === id);
      if (!task || task.status !== "queued") return null;
      if (!Object.hasOwn(task, "requestedInputVersion")) {
        task.requestedInputVersion = task.inputVersion || 0;
      }
      if (!Object.hasOwn(task, "requestedSubtargetVersion")) {
        task.requestedSubtargetVersion = task.subtargetVersion || 0;
      }
      if (!Object.hasOwn(task, "requestedInputHash")) {
        task.requestedInputHash = task.inputHash || "";
      }
      task.status = WAITING_FOR_USER_MODEL_STATUS;
      task.updatedAt = now();
      return task;
    },
    retry(tasks, id, inspectTarget, options = {}) {
      const previous = tasks.find(item => item.id === id);
      if (!previous || !["failed", "stale"].includes(previous.status)) return { missing: true };
      const existing = tasks.find(item => item.retryOf === previous.id);
      if (existing) return { task: existing, duplicate: true };
      const created = create(tasks, {
        kind: previous.kind, resourceType: previous.resourceType, targetId: previous.targetId, subtargetId: previous.subtargetId,
        payload: previous.payload, clientRequestId: `retry:${previous.id}`
      }, inspectTarget, options);
      if (created.task) created.task.retryOf = previous.id;
      return created;
    },
    claim(tasks, id) {
      const task = tasks.find(item => item.id === id);
      if (!task || task.status !== "queued") return null;
      task.status = "running";
      task.startedAt ||= now();
      task.updatedAt = now();
      task.attempt = Math.max(0, Number(task.attempt) || 0) + 1;
      return task;
    },
    recover(tasks) {
      const queued = [], interrupted = [];
      for (const task of tasks) {
        if (task.status === "queued") queued.push(task.id);
        else if (task.status === "running") {
          complete(task, "failed", { error: "服务在任务运行期间重启；为避免重复计费，请确认后重试" });
          interrupted.push(task);
        }
      }
      return { queued, interrupted };
    }
  };
}
