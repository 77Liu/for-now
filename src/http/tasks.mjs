import { publicAiTask } from "../modules/tasks/index.mjs";

export function createTaskHttp({ backgroundAi, bodyJson, sendJson }) {
  function sendCreation(res, created) {
    if (created.unsupported) return sendJson(res, 400, { error: "不支持这种后台任务" });
    if (created.missing) return sendJson(res, 404, { error: "任务目标不存在或正文已变化" });
    if (created.invalid) return sendJson(res, 400, { error: "任务缺少幂等标识", code: "IDEMPOTENCY_KEY_REQUIRED" });
    if (created.conflict) return sendJson(res, 409, { error: "同一请求标识不能用于不同任务", code: "IDEMPOTENCY_KEY_REUSED" });
    if (created.alreadyAnswered) return sendJson(res, 409, { error: "目标已经有回答", code: "TARGET_ALREADY_ANSWERED" });
    if (created.versionConflict || created.subtargetVersionConflict) return sendJson(res, 409, { error: "目标已经更新，请刷新后重试", code: "VERSION_CONFLICT", currentVersion: created.currentVersion });
    return sendJson(res, created.duplicate ? 200 : 202, publicAiTask(created.task));
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/ai-tasks") {
      sendCreation(res, await backgroundAi.enqueue(await bodyJson(req)));
    } else if (req.method === "GET" && url.pathname === "/api/ai-tasks") {
      sendJson(res, 200, await backgroundAi.list());
    } else if (req.method === "GET" && /^\/api\/ai-tasks\/[^/]+\/result$/.test(url.pathname)) {
      const value = await backgroundAi.getResult(url.pathname.split("/")[3]);
      if (!value) sendJson(res, 404, { error: "任务不存在" });
      else if (value.task.status !== "succeeded") sendJson(res, 409, { error: "任务尚未完成", code: "TASK_NOT_COMPLETED" });
      else if (!value.result) sendJson(res, 410, { error: "任务结果已经不可用", code: "TASK_RESULT_UNAVAILABLE" });
      else sendJson(res, 200, value);
    } else if (req.method === "GET" && /^\/api\/ai-tasks\/[^/]+$/.test(url.pathname)) {
      const task = await backgroundAi.get(url.pathname.split("/")[3]);
      if (task) sendJson(res, 200, task);
      else sendJson(res, 404, { error: "任务不存在" });
    } else if (req.method === "POST" && /^\/api\/ai-tasks\/[^/]+\/retry$/.test(url.pathname)) {
      const retried = await backgroundAi.retry(url.pathname.split("/")[3]);
      if (!retried.task) sendJson(res, 409, { error: "当前任务不可重试，请回到原记录重新发起" });
      else sendJson(res, retried.duplicate ? 200 : 202, publicAiTask(retried.task));
    } else if (req.method === "GET" && url.pathname === "/api/notifications") {
      sendJson(res, 200, await backgroundAi.listNotifications());
    } else if (req.method === "PATCH" && /^\/api\/notifications\/[^/]+\/read$/.test(url.pathname)) {
      const notification = await backgroundAi.readNotification(url.pathname.split("/")[3]);
      if (notification) sendJson(res, 200, notification);
      else sendJson(res, 404, { error: "通知不存在" });
    } else if (req.method === "POST" && url.pathname === "/api/notifications/read-all") {
      sendJson(res, 200, { updated: await backgroundAi.readAllNotifications() });
    } else return false;
    return true;
  }

  return { handle, sendCreation };
}
