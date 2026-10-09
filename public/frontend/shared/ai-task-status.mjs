export const WAITING_FOR_USER_MODEL_STATUS = "waiting_for_user_model";
export const WAITING_FOR_USER_MODEL_MESSAGE = "等待核心用户模型就绪；完成核心问答后会自动继续。";

export function isPendingAiTaskStatus(status) {
  return status === "queued"
    || status === "running"
    || status === "cancelling"
    || status === WAITING_FOR_USER_MODEL_STATUS;
}

export function isWaitingForUserModelTask(task) {
  return task?.status === WAITING_FOR_USER_MODEL_STATUS;
}

export function pendingAiTaskMessage(task, runningMessage) {
  return isWaitingForUserModelTask(task)
    ? WAITING_FOR_USER_MODEL_MESSAGE
    : runningMessage;
}
