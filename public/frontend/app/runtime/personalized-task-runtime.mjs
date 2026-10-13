/**
 * 个性化任务轮询与记录提交后的回答登记适配。
 * 建立时间：2026-10-10；状态：active。
 * 边界：复用同一TS登记器；异步界面更新仅归属当前账户会话。
 */
import { resolvePersonalizedAiResponse, enqueueThoughtAnswer, thoughtAnswerOutcomeMessage, thoughtAnswerTaskStatusKind, THOUGHT_ANSWER_REJECTED_MESSAGE, THOUGHT_ANSWER_UNKNOWN_MESSAGE } from "../../../generated/personalized-ai-task.mjs";

export function createPersonalizedTaskRuntime({
  runtime,
  request,
  getSessionSerial,
  getTasks,
  setTasks,
  publish,
  scheduleNotificationPoll
} = {}) {
  if (typeof request !== "function" || typeof getTasks !== "function"
    || typeof setTasks !== "function" || typeof getSessionSerial !== "function") {
    throw new TypeError("Personalized task runtime requires task and session ports");
  }

  return async function resolvePersonalizedTask(response, options = {}) {
    const owner = runtime.currentUser?.id || "";
    const session = getSessionSerial();
    const callerOnTask = options.onTask;

    return resolvePersonalizedAiResponse(response, {
      ...options,
      request,
      isSessionCurrent: () => owner === (runtime.currentUser?.id || "")
        && session === getSessionSerial(),
      onTask: task => {
        const tasks = Array.isArray(getTasks()) ? getTasks() : [];
        setTasks([task, ...tasks.filter(item => item.id !== task.id)]);
        publish?.(new Set(["aiTasks"]));
        scheduleNotificationPoll?.();
        callerOnTask?.(task);
      }
    });
  };
}

/** 记录提交后的回答登记适配；已有任务只接入，不再次POST。 @since unreleased */
export function createBackgroundThoughtAnswerRuntime({
  runtime, getSessionSerial, getTasks, request, refreshState, scheduleNotificationPoll,
  setAnswerStatus, showToast, createRequestId = () => crypto.randomUUID()
}) {
  return async function startBackgroundChainAnswer(question, existingTask = null) {
    const owner = runtime.currentUser?.id || "", session = getSessionSerial();
    const isCurrent = () => owner === (runtime.currentUser?.id || "") && session === getSessionSerial();
    let task = existingTask, notificationsRefreshed = true;
    if (!task) {
      const outcome = await enqueueThoughtAnswer({
        ownerId: owner, targetId: question.id, inputVersion: question.version || 1,
        createRequestId, request, refreshNotifications: () => refreshState("notifications"), isCurrent
      });
      if (!isCurrent()) return false;
      if (outcome.kind === "rejected") {
        setAnswerStatus(question.id, THOUGHT_ANSWER_REJECTED_MESSAGE, "error");
        showToast("回答未能进入后台队列", "error");
        return false;
      }
      if (outcome.kind === "unknown") {
        setAnswerStatus(question.id, THOUGHT_ANSWER_UNKNOWN_MESSAGE, "error");
        showToast(THOUGHT_ANSWER_UNKNOWN_MESSAGE, "error");
        return false;
      }
      task = outcome.task;
      notificationsRefreshed = outcome.notificationsRefreshed;
    }
    if (!isCurrent()) return false;
    if (!getTasks().some(item => item.id === task.id)) getTasks().unshift(task);
    if (existingTask) {
      try { notificationsRefreshed = (await refreshState("notifications")) !== false; }
      catch { notificationsRefreshed = false; }
    }
    if (!isCurrent()) return task;
    scheduleNotificationPoll();
    const status = thoughtAnswerOutcomeMessage(task, notificationsRefreshed);
    const statusKind = thoughtAnswerTaskStatusKind(task);
    setAnswerStatus(question.id, status, statusKind);
    showToast(status, statusKind);
    return task;
  };
}
