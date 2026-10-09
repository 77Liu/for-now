const ifMatchValue = req => (
  req?.headers?.["if-match"]
  ?? req?.headers?.["If-Match"]
  ?? req?.headers?.get?.("if-match")
  ?? ""
);

function expectedPermissionRevision(req, v1) {
  const value = String(ifMatchValue(req)).trim();
  return /^(?:W\/)?\"0\"$/.test(value) ? 0 : v1.expectedVersion(req);
}

export function createUserModelHttp({
  userModel,
  permissions,
  bodyJson,
  canReadModelDetails = () => false,
  onPermissionsChanged = async () => {}
}) {
  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/user-model") {
      const model = await userModel.get();
      if (canReadModelDetails()) return v1.success(res, 200, model);
      return v1.success(res, 200, {
        readiness: model.readiness,
        claims: [],
        unknowns: []
      });
    }
    if (req.method === "GET"
      && url.pathname === "/api/v1/user-model/evidence-permissions") {
      if (!permissions?.listPermissions) {
        return v1.error(res, 503, "来源许可暂不可用", "EVIDENCE_PERMISSION_UNAVAILABLE");
      }
      const page = await permissions.listPermissions(v1.pagination(url, {
        defaultLimit: 50,
        maxLimit: 100,
        maxCursorLength: 2048
      }));
      if (page.invalidCursor) {
        return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      }
      return v1.success(res, 200, page.items, {
        meta: {
          nextCursor: v1.nextCursor(page.nextId),
          total: page.total
        }
      });
    }
    if (req.method === "PATCH"
      && url.pathname === "/api/v1/user-model/evidence-permissions") {
      if (!permissions?.updatePermissions) {
        return v1.error(res, 503, "来源许可暂不可用", "EVIDENCE_PERMISSION_UNAVAILABLE");
      }
      const result = await permissions.updatePermissions({
        ...await bodyJson(req),
        expectedRevision: expectedPermissionRevision(req, v1)
      });
      if (result.invalid) {
        return v1.error(res, 422, "来源许可输入无效", "EVIDENCE_PERMISSION_INVALID");
      }
      if (result.versionConflict) {
        return v1.error(
          res,
          412,
          "来源许可已变化，请重新读取后再提交",
          "PRECONDITION_FAILED",
          { currentVersion: result.currentRevision }
        );
      }
      if (result.skipped && !result.permission) {
        return v1.error(
          res,
          409,
          "对应来源已经变化或不可用",
          "EVIDENCE_SOURCE_STALE",
          { reason: result.reason }
        );
      }
      await onPermissionsChanged(result);
      return v1.success(res, 200, {
        permission: result.permission,
        unchanged: result.unchanged === true,
        learningRefreshQueued: Boolean(result.taskIds?.length)
      }, {
        etag: v1.versionEtag(result.permission.revision)
      });
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
        "对应原文已经变化，这条理解已停止使用",
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
