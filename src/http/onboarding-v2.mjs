import { publicAiTask } from "../modules/tasks/index.mjs";

const resourceVersion = value => Math.max(0, Number(value?.session?.revision) || 0) + 1;

export function createOnboardingV2Http({ onboardingV2, extractions = null, bodyJson }) {
  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/onboarding-v2/schema") {
      return v1.success(res, 200, onboardingV2.schema());
    }
    if (req.method === "GET" && url.pathname === "/api/v1/onboarding-v2/session") {
      const value = await onboardingV2.get();
      return v1.success(res, 200, value, {
        etag: v1.versionEtag(resourceVersion(value))
      });
    }
    if (req.method === "PATCH" && url.pathname === "/api/v1/onboarding-v2/session") {
      const result = await onboardingV2.patch(await bodyJson(req), {
        expectedVersion: v1.expectedVersion(req),
        clientRequestId: v1.idempotencyKey(req)
      });
      if (result.invalid) {
        return v1.error(
          res,
          422,
          "五问会话内容无效",
          "ONBOARDING_SESSION_INVALID",
          { fields: result.fields }
        );
      }
      if (result.conflict) {
        return v1.error(
          res,
          409,
          "同一幂等键不能用于不同内容",
          result.code || "IDEMPOTENCY_KEY_REUSED"
        );
      }
      if (result.versionConflict) {
        return v1.error(
          res,
          409,
          "五问会话已在其他位置更新，请对照当前内容后再提交",
          "ONBOARDING_SESSION_CONFLICT",
          {
            currentRevision: result.current.session.revision,
            currentEtag: v1.versionEtag(result.currentVersion),
            currentSession: result.current.session
          }
        );
      }
      return v1.success(res, 200, result.value, {
        etag: v1.versionEtag(resourceVersion(result.value))
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/onboarding-v2/extractions" && extractions) {
      const input = await bodyJson(req);
      const result = await extractions.enqueue({
        sourceRevision: input.sourceRevision,
        clientRequestId: v1.idempotencyKey(req)
      });
      if (result.ready) {
        return v1.success(res, 200, { status: "ready" });
      }
      if (result.invalid) {
        return v1.error(res, 422, "提取请求无效", "CLAIM_EXTRACTION_REQUEST_INVALID", {
          fields: result.fields
        });
      }
      if (result.empty) {
        return v1.error(res, 422, "没有已许可的原文可供整理", "CLAIM_EXTRACTION_SOURCE_EMPTY");
      }
      if (result.tooLong) {
        return v1.error(res, 422, "本次原文超过提取上限，请减少后重试", "CLAIM_EXTRACTION_SOURCE_TOO_LONG", {
          inputCharacters: result.inputCharacters,
          maxCharacters: result.maxCharacters
        });
      }
      if (result.versionConflict) {
        return v1.error(res, 409, "五问原文已经变化，请刷新后重试", "CLAIM_EXTRACTION_SOURCE_CONFLICT", {
          currentRevision: result.currentRevision
        });
      }
      if (result.conflict) {
        return v1.error(res, 409, "同一幂等键不能用于不同原文", "IDEMPOTENCY_KEY_REUSED");
      }
      if (!result.task) {
        return v1.error(res, result.missing ? 404 : 409, "候选提取任务无法创建", "CLAIM_EXTRACTION_REJECTED");
      }
      return v1.success(res, result.duplicate ? 200 : 202, publicAiTask(result.task));
    }
    const extraction = /^\/api\/v1\/onboarding-v2\/extractions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && extraction && extractions) {
      const value = await extractions.get(extraction[1]);
      return value
        ? v1.success(res, 200, value)
        : v1.error(res, 404, "候选提取任务不存在", "CLAIM_EXTRACTION_NOT_FOUND");
    }
    if (req.method === "DELETE" && extraction && extractions) {
      const value = await extractions.cancel(extraction[1]);
      return value
        ? v1.success(res, 200, value)
        : v1.error(res, 409, "候选提取任务已结束或不存在", "CLAIM_EXTRACTION_NOT_CANCELLABLE");
    }
    return false;
  }

  return { handleV1 };
}
