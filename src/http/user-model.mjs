export function createUserModelHttp({ userModel, bodyJson }) {
  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/user-model") {
      return v1.success(res, 200, await userModel.get());
    }
    const match = /^\/api\/v1\/user-model\/claims\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "PATCH" || !match) return false;
    const result = await userModel.patchClaim(
      decodeURIComponent(match[1]),
      await bodyJson(req),
      { expectedVersion: v1.expectedVersion(req) }
    );
    if (result.missing) return v1.error(res, 404, "候选理解不存在", "CLAIM_NOT_FOUND");
    if (result.versionConflict) {
      return v1.error(
        res,
        412,
        "候选理解已变化，请重新读取后再提交",
        "PRECONDITION_FAILED",
        { currentVersion: result.currentVersion }
      );
    }
    if (result.stale) {
      return v1.error(
        res,
        409,
        "对应原文已经变化，此候选不能再确认",
        "CLAIM_SOURCE_STALE",
        { claim: result.value, currentVersion: result.value.version }
      );
    }
    if (result.invalidState) {
      return v1.error(
        res,
        409,
        "当前状态不允许该操作",
        "CLAIM_STATE_CONFLICT",
        { currentLifecycle: result.currentLifecycle }
      );
    }
    if (result.conflict) {
      return v1.error(res, 409, "无法创建修正版本", result.code || "CLAIM_CONFLICT");
    }
    if (result.error) {
      return v1.error(res, 422, result.error, result.code || "CLAIM_PATCH_INVALID");
    }
    return v1.success(res, 200, {
      claim: result.value,
      ...(result.previous ? { previous: result.previous } : {})
    }, {
      etag: v1.versionEtag(result.value.version)
    });
  }

  return { handleV1 };
}
