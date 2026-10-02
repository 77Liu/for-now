const resourceVersion = value => Math.max(0, Number(value?.session?.revision) || 0) + 1;

export function createOnboardingV2Http({ onboardingV2, bodyJson }) {
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
    return false;
  }

  return { handleV1 };
}
