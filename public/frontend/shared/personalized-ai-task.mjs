import {
  isPendingAiTaskStatus,
  WAITING_FOR_USER_MODEL_MESSAGE,
  WAITING_FOR_USER_MODEL_STATUS
} from "../shared/ai-task-status.mjs";

const TASK_KINDS = new Set([
  "thoughtDraft",
  "thoughtPrompt",
  "journalAssist",
  "journalReflection",
  "chat",
  "analysis"
]);

const TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "stale",
  "cancelled"
]);

const DEFAULT_POLL_INTERVAL_MS = 1800;
const noop = () => {};

function taskFromResponse(response) {
  const candidate = response?.data || response?.task || response;
  if (!candidate || !TASK_KINDS.has(candidate.kind)) return null;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  if (typeof candidate.status !== "string") return null;
  return candidate;
}

function taskStatusMessage(task, operationLabel = "请求") {
  if (task.status === WAITING_FOR_USER_MODEL_STATUS) {
    return `${operationLabel}已保存，${WAITING_FOR_USER_MODEL_MESSAGE}`;
  }
  if (task.status === "queued") return `${operationLabel}已排队，等待处理…`;
  if (task.status === "running") return `${operationLabel}正在处理中…`;
  if (task.status === "cancelling") return `${operationLabel}正在停止…`;
  if (task.status === "succeeded") return `${operationLabel}已完成，正在读取结果…`;
  if (task.status === "failed") return `${operationLabel}失败：${task.error || "请稍后重试。"}`;
  if (task.status === "stale") return `${operationLabel}所用内容已变化，请重新发起。`;
  if (task.status === "cancelled") return `${operationLabel}已取消。`;
  return `${operationLabel}状态：${task.status}`;
}

function taskError(task, operationLabel) {
  const error = new Error(taskStatusMessage(task, operationLabel));
  error.task = task;
  error.taskStatus = task.status;
  error.taskId = task.id;
  return error;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function resolveSynchronousPersonalizedResponse(response) {
  const task = taskFromResponse(response);
  if (task) {
    const error = taskError(task, "后台任务");
    error.message = `${taskStatusMessage(task, "后台任务")}当前界面无法跟踪进度，请刷新后查看任务通知。`;
    throw error;
  }
  return {
    asynchronous: false,
    task: null,
    result: response?.data ?? response
  };
}

function transientFailure(error) {
  return error?.code === "NETWORK_ERROR"
    || Number(error?.status) === 0
    || Number(error?.status) >= 500;
}

export async function resolvePersonalizedAiResponse(response, {
  request,
  operationLabel = "请求",
  expectedKind = "",
  onTask = noop,
  onStatus = noop,
  isSessionCurrent = () => true,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = wait
} = {}) {
  if (typeof request !== "function") {
    throw new TypeError("Resolving a personalized AI task requires request()");
  }

  let task = taskFromResponse(response);
  if (!task) {
    return resolveSynchronousPersonalizedResponse(response);
  }
  if (expectedKind && task.kind !== expectedKind) {
    throw new Error(`${operationLabel}返回了不匹配的任务类型。`);
  }

  if (!isSessionCurrent()) {
    return { asynchronous: true, abandoned: true, task, result: null };
  }
  onTask(task);
  onStatus(taskStatusMessage(task, operationLabel), task);

  while (isPendingAiTaskStatus(task.status)) {
    await sleep(pollIntervalMs);
    if (!isSessionCurrent()) {
      return { asynchronous: true, abandoned: true, task, result: null };
    }

    let latest;
    try {
      latest = await request(`/api/ai-tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      if (!transientFailure(error)) {
        error.task ||= task;
        error.taskId ||= task.id;
        error.taskStatus ||= task.status;
        throw error;
      }
      if (!isSessionCurrent()) {
        return { asynchronous: true, abandoned: true, task, result: null };
      }
      onStatus(`${operationLabel}状态暂时无法读取，稍后自动重试…`, task);
      continue;
    }
    if (!isSessionCurrent()) {
      return { asynchronous: true, abandoned: true, task, result: null };
    }
    task = taskFromResponse(latest) || latest;
    onTask(task);
    onStatus(taskStatusMessage(task, operationLabel), task);
  }

  if (TERMINAL_FAILURE_STATUSES.has(task.status)) {
    throw taskError(task, operationLabel);
  }
  if (task.status !== "succeeded") {
    throw taskError(task, operationLabel);
  }

  let resultResponse;
  while (true) {
    try {
      resultResponse = await request(
        `/api/ai-tasks/${encodeURIComponent(task.id)}/result`
      );
      break;
    } catch (error) {
      if (!transientFailure(error)) {
        error.task ||= task;
        error.taskId ||= task.id;
        error.taskStatus ||= task.status;
        throw error;
      }
      if (!isSessionCurrent()) {
        return { asynchronous: true, abandoned: true, task, result: null };
      }
      onStatus(`${operationLabel}已完成，正在重试读取结果…`, task);
      await sleep(pollIntervalMs);
    }
  }
  if (!isSessionCurrent()) {
    return { asynchronous: true, abandoned: true, task, result: null };
  }
  const result = resultResponse?.result;
  if (!result || typeof result !== "object") {
    throw new Error(`${operationLabel}已完成，但结果暂时不可用。`);
  }

  return { asynchronous: true, task, result };
}

export { taskStatusMessage };
