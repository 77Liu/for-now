/**
 * 当前账户的重要性查询、按需评分和人工纠正接口。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：来源权限由服务逐次核验，历史评分必须显式指定范围和调用上限。
 */
import type { createImportanceService } from "./importance-runtime.mjs";
type Service = ReturnType<typeof createImportanceService>;
interface Request { method?: string }
interface V1 {
  success(response: unknown, status: number, result: unknown): unknown;
  error(response: unknown, status: number, message: string, code: string): unknown;
  idempotencyKey(request: Request): string;
}

/** 复用 v1 身份认证和既有任务幂等键；只接受显式小批次请求。
 * @since unreleased
 */
export function createImportanceHttp(service: Service, bodyJson: (request: Request) => Promise<Record<string, unknown>>) {
  return {
    async handleV1(request: Request, response: unknown, url: URL, v1: V1) {
      if (request.method !== "POST" || ![
        "/api/v1/importance/read", "/api/v1/importance/score", "/api/v1/importance/correct"
      ].includes(url.pathname)) return false;
      const body = await bodyJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return v1.error(response, 400, "评分请求必须为对象", "IMPORTANCE_INPUT_INVALID");
      }
      const refs = body.sourceRefs as Parameters<Service["read"]>[0];
      const result = body.jobId && !url.pathname.endsWith("/correct") && service.batches ? (url.pathname.endsWith("/read")
        ? await service.batches.read(String(body.jobId))
        : await service.batches.control(String(body.jobId), body.action as "pause" | "resume", body.maxCalls as number, v1.idempotencyKey(request)))
        : body.range && url.pathname.endsWith("/score") && service.batches
          ? await service.batches.start({ ...(body.range as { from: string; to: string; dateBasis?: "recorded" | "occurred" }), maxCalls: body.maxCalls as number }, v1.idempotencyKey(request))
          : url.pathname.endsWith("/read") ? await service.read(refs)
        : url.pathname.endsWith("/score") ? await service.enqueue(refs, v1.idempotencyKey(request))
          : await service.correct(body.sourceRef as Parameters<Service["correct"]>[0], body.score as number);
      if (result && typeof result === "object" && "conflict" in result && result.conflict) {
        return v1.error(response, 409, "同一请求标识不能用于不同评分", "IDEMPOTENCY_KEY_REUSED");
      }
      if (result && typeof result === "object" && "missing" in result && result.missing) {
        return v1.error(response, 409, "评分来源或有效模型配置已变化", "IMPORTANCE_SOURCE_INVALID");
      }
      if (result && typeof result === "object" && "invalid" in result && result.invalid) {
        return v1.error(response, 400, "评分来源、配置或参数无效", "code" in result
          ? String(result.code) : "IMPORTANCE_INPUT_INVALID");
      }
      return v1.success(response, url.pathname.endsWith("/score") ? 202 : 200, result);
    }
  };
}
