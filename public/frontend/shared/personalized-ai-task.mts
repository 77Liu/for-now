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

export type ThoughtAnswerTask = {
  id: string;
  kind: "thoughtAnswer";
  targetId: string;
  inputVersion: number;
  status: string;
  resultId?: string;
};

export type ThoughtAnswerEnqueueResult =
  | { kind: "queued"; task: ThoughtAnswerTask; notificationsRefreshed: boolean }
  | { kind: "rejected" }
  | { kind: "unknown" };

type SessionMetadataStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type PendingThoughtAnswerRequest = {
  kind: "thoughtAnswer";
  targetId: string;
  inputVersion: number;
  clientRequestId: string;
  resolved?: boolean;
};

type ThoughtAnswerEnqueueOptions = {
  ownerId: string;
  targetId: string;
  inputVersion: number;
  createRequestId: () => string;
  request: (path: string, options: { method: "POST"; body: string }) => Promise<unknown>;
  refreshNotifications?: () => Promise<unknown>;
  isCurrent?: () => boolean;
  storage?: SessionMetadataStorage | null;
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
const pendingThoughtAnswerRequests = new Map<string, PendingThoughtAnswerRequest>();
export const THOUGHT_ANSWER_REJECTED_MESSAGE = "思绪已保存，但回答未能排队。请刷新思绪后重试。";
export const THOUGHT_ANSWER_UNKNOWN_MESSAGE = "思绪已保存，回答排队状态尚未确认。再次发起会安全确认同一请求。";
export const THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE = "通知状态暂未刷新；稍后可在通知中查看。";

export function thoughtAnswerTaskMessage(task: ThoughtAnswerTask): string {
  switch (task.status) {
    case WAITING_FOR_USER_MODEL_STATUS:
      return WAITING_FOR_USER_MODEL_MESSAGE;
    case "queued":
      return "回答已进入后台队列。";
    case "running":
      return "回答正在后台生成。";
    case "cancelling":
      return "回答任务正在取消。";
    case "succeeded":
      return "回答已完成，可查看结果。";
    case "failed":
      return "回答任务失败，可稍后重试。";
    case "stale":
      return "回答任务已过期，请刷新思绪后重试。";
    case "cancelled":
      return "回答任务已取消，可重新发起。";
    default:
      return "回答任务已确认，当前状态暂不可识别；请稍后查看通知。";
  }
}

export function thoughtAnswerOutcomeMessage(
  task: ThoughtAnswerTask,
  notificationsRefreshed: boolean
): string {
  const message = thoughtAnswerTaskMessage(task);
  return notificationsRefreshed
    ? message
    : `${message} ${THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE}`;
}

export function thoughtAnswerTaskStatusKind(task: ThoughtAnswerTask): "working" | "success" | "error" {
  switch (task.status) {
    case "succeeded":
      return "success";
    case "failed":
    case "stale":
    case "cancelled":
      return "error";
    case WAITING_FOR_USER_MODEL_STATUS:
    case "queued":
    case "running":
    case "cancelling":
      return "working";
    default:
      return "error";
  }
}

function thoughtAnswerAttemptKey(ownerId: string, targetId: string, inputVersion: number): string {
  return `${ownerId}\u0000${targetId}\u0000${inputVersion}`;
}

function thoughtAnswerStorageKey(ownerId: string, targetId: string, inputVersion: number): string {
  return `cike:thought-answer-enqueue:${encodeURIComponent(ownerId)}:${encodeURIComponent(targetId)}:${inputVersion}`;
}

function sessionMetadataStorage(): SessionMetadataStorage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function loadPendingThoughtAnswerRequest(
  ownerId: string,
  targetId: string,
  inputVersion: number,
  storage: SessionMetadataStorage | null
): PendingThoughtAnswerRequest | null {
  const key = thoughtAnswerAttemptKey(ownerId, targetId, inputVersion);
  const inMemory = pendingThoughtAnswerRequests.get(key);
  if (inMemory?.resolved) return null;
  if (inMemory) return inMemory;
  if (!storage) return null;
  try {
    const candidate = JSON.parse(storage.getItem(
      thoughtAnswerStorageKey(ownerId, targetId, inputVersion)
    ) || "null");
    if (candidate?.kind !== "thoughtAnswer"
      || candidate.resolved === true
      || candidate.targetId !== targetId
      || candidate.inputVersion !== inputVersion
      || typeof candidate.clientRequestId !== "string"
      || !candidate.clientRequestId) return null;
    const request: PendingThoughtAnswerRequest = {
      kind: "thoughtAnswer",
      targetId,
      inputVersion,
      clientRequestId: candidate.clientRequestId
    };
    pendingThoughtAnswerRequests.set(key, request);
    return request;
  } catch {
    return null;
  }
}

function savePendingThoughtAnswerRequest(
  ownerId: string,
  request: PendingThoughtAnswerRequest,
  storage: SessionMetadataStorage | null
): void {
  pendingThoughtAnswerRequests.set(
    thoughtAnswerAttemptKey(ownerId, request.targetId, request.inputVersion),
    request
  );
  if (!storage) return;
  const storageKey = thoughtAnswerStorageKey(ownerId, request.targetId, request.inputVersion);
  try {
    storage.setItem(storageKey, JSON.stringify(request));
  } catch {
    // 即使浏览器拒绝会话存储，当前页面仍可用内存中的同一请求标识安全确认。
  }
}

function clearPendingThoughtAnswerRequest(
  ownerId: string,
  request: PendingThoughtAnswerRequest,
  storage: SessionMetadataStorage | null
): void {
  const attemptKey = thoughtAnswerAttemptKey(ownerId, request.targetId, request.inputVersion);
  const current = pendingThoughtAnswerRequests.get(attemptKey);
  if (current && current.clientRequestId !== request.clientRequestId) return;
  const storageKey = thoughtAnswerStorageKey(ownerId, request.targetId, request.inputVersion);
  let persisted: PendingThoughtAnswerRequest | null = null;
  let storageRecordRead = false;
  if (storage) {
    try {
      persisted = JSON.parse(storage.getItem(storageKey) || "null");
      storageRecordRead = true;
      if (!current && persisted?.clientRequestId
        && persisted.clientRequestId !== request.clientRequestId) return;
    } catch {
      // 仍在内存标记本次已解决；读取失败时不覆盖可能存在的其他存储记录。
    }
  }
  pendingThoughtAnswerRequests.set(attemptKey, { ...request, resolved: true });
  if (!storage || (!current && !storageRecordRead)) return;
  try {
    // 若浏览器拒绝 removeItem，已确认的墓碑会防止旧幂等键被误当作新回答复用。
    storage.setItem(storageKey, JSON.stringify({ ...request, resolved: true }));
  } catch {
    // 存储写入失败时仍尝试删除旧记录，当前页面的内存标记始终保留。
  }
  try {
    storage.removeItem(storageKey);
  } catch {
    // 存储完全不可写时只能依赖当前页面内存状态；记录中不包含用户正文。
  }
}

function explicitThoughtAnswerRejection(error: unknown): boolean {
  const status = Number(asRecord(error)?.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function thoughtAnswerTask(value: unknown, targetId: string, inputVersion: number): ThoughtAnswerTask | null {
  const candidate = asRecord(value)?.data ?? asRecord(value)?.task ?? value;
  const task = asRecord(candidate);
  if (task?.kind !== "thoughtAnswer"
    || task.targetId !== targetId
    || task.inputVersion !== inputVersion
    || typeof task.id !== "string"
    || !task.id
    || typeof task.status !== "string") return null;
  return task as ThoughtAnswerTask;
}

/**
 * 同一账户、目标与版本的响应不确定时复用完全相同的请求体和幂等键；
 * 仅服务端确认拒绝或返回任务后才清理，刷新通知失败仍保留已确认任务。
 */
export async function enqueueThoughtAnswer({
  ownerId,
  targetId,
  inputVersion: rawInputVersion,
  createRequestId,
  request,
  refreshNotifications,
  isCurrent = () => true,
  storage
}: ThoughtAnswerEnqueueOptions): Promise<ThoughtAnswerEnqueueResult> {
  const inputVersion = Math.max(1, Math.round(Number(rawInputVersion) || 1));
  const attemptStorage = storage === undefined ? sessionMetadataStorage() : storage;
  const pending = loadPendingThoughtAnswerRequest(ownerId, targetId, inputVersion, attemptStorage);
  const body: PendingThoughtAnswerRequest = {
    kind: "thoughtAnswer",
    targetId,
    inputVersion,
    clientRequestId: pending?.clientRequestId || createRequestId()
  };
  if (!pending) savePendingThoughtAnswerRequest(ownerId, body, attemptStorage);

  let response: unknown;
  try {
    response = await request("/api/ai-tasks", {
      method: "POST",
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (explicitThoughtAnswerRejection(error)) {
      clearPendingThoughtAnswerRequest(ownerId, body, attemptStorage);
      return { kind: "rejected" };
    }
    return { kind: "unknown" };
  }

  const task = thoughtAnswerTask(response, targetId, inputVersion);
  if (!task) return { kind: "unknown" };
  clearPendingThoughtAnswerRequest(ownerId, body, attemptStorage);

  let notificationsRefreshed = !refreshNotifications;
  if (refreshNotifications && isCurrent()) {
    try {
      await refreshNotifications();
      notificationsRefreshed = true;
    } catch {
      notificationsRefreshed = false;
    }
  }
  return { kind: "queued", task, notificationsRefreshed };
}

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
  if (task.status === "failed") return "任务失败，请查看通知中的脱敏错误日志后重试";
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
