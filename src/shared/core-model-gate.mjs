export const CORE_MODEL_NOT_READY_CODE = "CORE_MODEL_NOT_READY";
export const CORE_MODEL_NOT_READY_MESSAGE = "核心用户模型尚未就绪，请完成冷启动后重试";
export const WAITING_FOR_USER_MODEL_STATUS = "waiting_for_user_model";

export function assertCoreModelReady(readiness) {
  if (readiness?.ready) return readiness;
  throw Object.assign(new Error(CORE_MODEL_NOT_READY_MESSAGE), {
    code: CORE_MODEL_NOT_READY_CODE,
    statusCode: 409,
    details: { reason: readiness?.reason || "model_unavailable" }
  });
}
