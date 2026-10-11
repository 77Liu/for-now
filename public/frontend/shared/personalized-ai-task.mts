import {
  isPendingAiTaskStatus,
  WAITING_FOR_USER_MODEL_MESSAGE,
  WAITING_FOR_USER_MODEL_STATUS
} from "../shared/ai-task-status.mjs";

type TaskKind = "thoughtDraft" | "thoughtPrompt" | "journalAssist" | "journalReflection" | "chat" | "analysis";
type AiTask = Record<string, unknown> & {
  id: string;
  kind: TaskKind;
  status: string;
  error?: string;
};

type TaskRequestError = {
  code?: unknown;
  status?: unknown;
  task?: AiTask;
  taskId?: string;
  taskStatus?: string;
};

type PersonalizedAiResult =
  | { asynchronous: false; task: null; result: unknown }
  | { asynchronous: true; abandoned: true; task: AiTask; result: null }
  | { asynchronous: true; task: AiTask; result: Record<string, unknown> };

type ResolveOptions = {
  request?: (path: string) => Promise<unknown>;
  operationLabel?: string;
  expectedKind?: string;
  onTask?: (task: AiTask) => void;
  onStatus?: (message: string, task: AiTask) => void;
  isSessionCurrent?: () => boolean;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const TASK_KINDS = new Set<TaskKind>([
  "thoughtDraft",
  "thoughtPrompt",
  "journalAssist",
  "journalReflection",
  "chat",
  "analysis"
]);

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "stale", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 1800;
const noop = () => {};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function taskFromResponse(response: unknown): AiTask | null {
  const responseRecord = asRecord(response);
  const candidate = responseRecord?.data || responseRecord?.task || response;
  const task = asRecord(candidate);
  if (!task || !TASK_KINDS.has(task.kind as TaskKind)) return null;
  if (typeof task.id !== "string" || !task.id) return null;
  if (typeof task.status !== "string") return null;
  return task as AiTask;
}

function taskStatusMessage(task: AiTask, operationLabel = "请求"): string {
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

function taskError(task: AiTask, operationLabel: string): Error & TaskRequestError {
  const error = new Error(taskStatusMessage(task, operationLabel)) as Error & TaskRequestError;
  error.task = task;
  error.taskStatus = task.status;
  error.taskId = task.id;
  return error;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** 此入口只接收同步结果；异步任务必须交给轮询器，不能伪装成已完成的响应。 */
export function resolveSynchronousPersonalizedResponse(response: unknown): PersonalizedAiResult {
  const task = taskFromResponse(response);
  if (task) {
    const error = taskError(task, "后台任务");
    error.message = `${taskStatusMessage(task, "后台任务")}当前界面无法跟踪进度，请刷新后查看任务通知。`;
    throw error;
  }
  return {
    asynchronous: false,
    task: null,
    result: asRecord(response)?.data ?? response
  };
}

function transientFailure(error: unknown): boolean {
  const failure = asRecord(error);
  return failure?.code === "NETWORK_ERROR"
    || Number(failure?.status) === 0
    || Number(failure?.status) >= 500;
}

function attachTaskContext(error: unknown, task: AiTask): void {
  const failure = error as TaskRequestError;
  failure.task ||= task;
  failure.taskId ||= task.id;
  failure.taskStatus ||= task.status;
}

/**
 * 当 isSessionCurrent() 报告调用方上下文已失效时返回 abandoned，调用方必须丢弃旧结果；
 * 仅网络临时失败会重试，终态任务和非瞬时错误会直接抛出。
 */
export async function resolvePersonalizedAiResponse(
  response: unknown,
  {
    request,
    operationLabel = "请求",
    expectedKind = "",
    onTask = noop,
    onStatus = noop,
    isSessionCurrent = () => true,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = wait
  }: ResolveOptions = {}
): Promise<PersonalizedAiResult> {
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

    let latest: unknown;
    try {
      latest = await request(`/api/ai-tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      if (!transientFailure(error)) {
        attachTaskContext(error, task);
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
    task = taskFromResponse(latest) || latest as AiTask;
    onTask(task);
    onStatus(taskStatusMessage(task, operationLabel), task);
  }

  if (TERMINAL_FAILURE_STATUSES.has(task.status)) {
    throw taskError(task, operationLabel);
  }
  if (task.status !== "succeeded") {
    throw taskError(task, operationLabel);
  }

  let resultResponse: unknown;
  while (true) {
    try {
      resultResponse = await request(
        `/api/ai-tasks/${encodeURIComponent(task.id)}/result`
      );
      break;
    } catch (error) {
      if (!transientFailure(error)) {
        attachTaskContext(error, task);
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
  const result = asRecord(resultResponse)?.result;
  const resultRecord = asRecord(result);
  if (!resultRecord) {
    throw new Error(`${operationLabel}已完成，但结果暂时不可用。`);
  }

  return { asynchronous: true, task, result: resultRecord };
}

export { taskStatusMessage };
