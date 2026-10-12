import { resolvePersonalizedAiResponse } from "../../../generated/personalized-ai-task.mjs";

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
