import { publicAiTask } from "../modules/tasks/index.mjs";

export function sendPersonalizedTaskV1(res, v1, created) {
  if (created.error) return v1.error(res, 400, created.error, "VALIDATION_ERROR");
  if (created.unsupported) return v1.error(res, 400, "不支持这种后台任务", "UNSUPPORTED_AI_TASK");
  if (created.missing) return v1.error(res, 404, "任务目标不存在或正文已变化", "AI_TASK_TARGET_NOT_FOUND");
  if (created.invalid) return v1.error(res, 400, "任务缺少幂等标识", "IDEMPOTENCY_KEY_REQUIRED");
  if (created.invalidIntent) return v1.error(res, 400, "生成请求内容无效", "INVALID_AI_TASK_INTENT");
  if (created.inputTooLarge) {
    return v1.error(res, 413, "待处理内容过长，请缩短后重试", "AI_TASK_INTENT_TOO_LARGE", {
      maxBytes: created.maxBytes
    });
  }
  if (created.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
  if (created.alreadyAnswered) return v1.error(res, 409, "目标已经有回答", "TARGET_ALREADY_ANSWERED");
  if (created.versionConflict || created.subtargetVersionConflict) {
    return v1.error(res, 409, "目标已经更新，请刷新后重试", "VERSION_CONFLICT", {
      currentVersion: created.currentVersion
    });
  }
  return v1.success(res, created.duplicate ? 200 : 202, publicAiTask(created.task));
}

export function sendPersonalizedTaskLegacy(res, sendJson, created) {
  if (created.error) return sendJson(res, 400, { error: created.error, code: "VALIDATION_ERROR" });
  if (created.unsupported) return sendJson(res, 400, { error: "不支持这种后台任务", code: "UNSUPPORTED_AI_TASK" });
  if (created.missing) return sendJson(res, 404, { error: "任务目标不存在或正文已变化", code: "AI_TASK_TARGET_NOT_FOUND" });
  if (created.invalid) return sendJson(res, 400, { error: "任务缺少幂等标识", code: "IDEMPOTENCY_KEY_REQUIRED" });
  if (created.invalidIntent) return sendJson(res, 400, { error: "生成请求内容无效", code: "INVALID_AI_TASK_INTENT" });
  if (created.inputTooLarge) {
    return sendJson(res, 413, {
      error: "待处理内容过长，请缩短后重试",
      code: "AI_TASK_INTENT_TOO_LARGE",
      maxBytes: created.maxBytes
    });
  }
  if (created.conflict) return sendJson(res, 409, { error: "同一幂等键不能用于不同内容", code: "IDEMPOTENCY_KEY_REUSED" });
  if (created.alreadyAnswered) return sendJson(res, 409, { error: "目标已经有回答", code: "TARGET_ALREADY_ANSWERED" });
  if (created.versionConflict || created.subtargetVersionConflict) {
    return sendJson(res, 409, {
      error: "目标已经更新，请刷新后重试",
      code: "VERSION_CONFLICT",
      currentVersion: created.currentVersion
    });
  }
  return sendJson(res, created.duplicate ? 200 : 202, publicAiTask(created.task));
}
