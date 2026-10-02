import { safeText } from "../../shared/validation/index.mjs";

const TASK_KINDS = new Set([
  "thoughtAnswer",
  "followUpAnswer",
  "annotationShenji",
  "contentImageUnderstanding",
  "captureTranscription",
  "onboardingClaimExtraction"
]);

export function publicAiTask(task) {
  return {
    id: task.id,
    kind: task.kind,
    resourceType: task.resourceType || (
      task.kind === "thoughtAnswer" || task.kind === "followUpAnswer"
        ? "thought"
        : task.kind === "captureTranscription"
          ? "capture"
          : task.kind === "onboardingClaimExtraction" ? "onboardingV2" : ""
    ),
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
    retryOf: task.retryOf || "",
    ...(task.kind === "contentImageUnderstanding" ? {
      contentTargetType: task.payload?.targetType || "",
      contentTargetId: task.payload?.targetId || ""
    } : {})
  };
}

export function activeTaskForInput(tasks, { kind, targetId, inputHash }) {
  return (Array.isArray(tasks) ? tasks : []).find(task => (
    task?.kind === kind
    && task.targetId === targetId
    && task.inputHash === inputHash
    && ["queued", "running"].includes(task.status)
  )) || null;
}

export function taskInputMatches(task, work) {
  return Boolean(work && !work.alreadyAnswered
    && (work.inputVersion || 0) === task.inputVersion
    && (work.subtargetVersion || 0) === (task.subtargetVersion || 0)
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
    return hash(JSON.stringify({ kind: normalized.kind, resourceType: normalized.resourceType, targetId: normalized.targetId, subtargetId: normalized.subtargetId, payload: normalized.payload }));
  };
  const normalizeRequest = input => {
    const kind = safeText(input.kind, 40), targetId = safeText(input.targetId, 100), subtargetId = safeText(input.subtargetId, 100), clientRequestId = safeText(input.clientRequestId, 100);
    const resourceType = kind === "captureTranscription"
      ? "capture"
      : kind === "onboardingClaimExtraction"
        ? "onboardingV2"
      : ["annotationShenji", "contentImageUnderstanding"].includes(kind) ? safeText(input.resourceType, 40) : "thought";
    const payload = kind === "annotationShenji"
      ? { message: safeText(input.payload?.message ?? input.message, 6000) }
      : kind === "contentImageUnderstanding"
        ? {
            targetType: safeText(input.payload?.targetType, 40),
            targetId: safeText(input.payload?.targetId, 100),
            attachmentPaths: [...new Set((Array.isArray(input.payload?.attachmentPaths) ? input.payload.attachmentPaths : [])
              .filter(value => typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)))].slice(0, 2)
          }
        : {};
    const requestedInputVersion = Number(input.inputVersion) > 0 ? Math.round(Number(input.inputVersion)) : 0;
    const requestedSubtargetVersion = Number(input.subtargetVersion) > 0 ? Math.round(Number(input.subtargetVersion)) : 0;
    return { kind, resourceType, targetId, subtargetId, clientRequestId, payload, requestedInputVersion, requestedSubtargetVersion };
  };

  function create(tasks, input, inspectTarget) {
    const normalized = normalizeRequest(input);
    const { kind, resourceType, targetId, subtargetId, clientRequestId, payload, requestedInputVersion, requestedSubtargetVersion } = normalized;
    if (!TASK_KINDS.has(kind)) return { unsupported: true };
    if (!clientRequestId) return { invalid: true };
    const inputRequestHash = requestHash(normalized);
    const duplicate = tasks.find(item => item.clientRequestId === clientRequestId);
    if (duplicate) return duplicate.requestHash === inputRequestHash ? { task: duplicate, duplicate: true } : { conflict: true };
    const work = inspectTarget(normalized);
    if (!work) return { missing: true };
    if (work.alreadyAnswered) return { alreadyAnswered: true };
    if (requestedInputVersion && requestedInputVersion !== work.inputVersion) return { versionConflict: true, currentVersion: work.inputVersion };
    if (requestedSubtargetVersion && requestedSubtargetVersion !== work.subtargetVersion) return { subtargetVersionConflict: true, currentVersion: work.subtargetVersion };
    if (kind === "captureTranscription") {
      const active = activeTaskForInput(tasks, { kind, targetId, inputHash: work.inputHash });
      if (active) return { task: active, duplicate: true };
    }
    const task = {
      id: createId(), kind, resourceType, targetId, subtargetId,
      inputVersion: work.inputVersion || 0, subtargetVersion: work.subtargetVersion || 0, inputHash: work.inputHash,
      payload, clientRequestId, requestHash: inputRequestHash, status: "queued", createdAt: now(), updatedAt: now(), attempt: 0
    };
    tasks.unshift(task);
    work.markQueued?.(task);
    return { task, duplicate: false };
  }

  function complete(task, status, { resultId = task.resultId || "", error = "" } = {}) {
    task.status = status;
    task.completedAt = now();
    task.updatedAt = task.completedAt;
    task.error = safeText(error, 500);
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
    retry(tasks, id, inspectTarget) {
      const previous = tasks.find(item => item.id === id);
      if (!previous || !["failed", "stale"].includes(previous.status)) return { missing: true };
      const existing = tasks.find(item => item.retryOf === previous.id);
      if (existing) return { task: existing, duplicate: true };
      const created = create(tasks, {
        kind: previous.kind, resourceType: previous.resourceType, targetId: previous.targetId, subtargetId: previous.subtargetId,
        payload: previous.payload, clientRequestId: `retry:${previous.id}`
      }, inspectTarget);
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
