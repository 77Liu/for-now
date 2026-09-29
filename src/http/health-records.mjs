export function createHealthRecordHttp({ records, remove, sendTrashResult, bodyJson, sendJson }) {
  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/daily-records") {
      const page = await records.list(v1.pagination(url));
      if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/daily-records") {
      const result = await records.create(await bodyJson(req), { clientRequestId: v1.idempotencyKey(req) });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, result.duplicate ? 200 : 201, result.value, { etag: v1.versionEtag(result.value.version) });
    }
    if (req.method === "GET" && /^\/api\/v1\/daily-records\/[^/]+$/.test(url.pathname)) {
      const record = await records.get(url.pathname.split("/")[4]);
      return record
        ? v1.success(res, 200, record, { etag: v1.versionEtag(record.version) })
        : v1.error(res, 404, "这条每日记录不存在", "DAILY_RECORD_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/daily-records\/[^/]+$/.test(url.pathname)) {
      const result = await records.update(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      );
      if (result.missing) return v1.error(res, 404, "这条每日记录不存在", "DAILY_RECORD_NOT_FOUND");
      if (result.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      return v1.success(res, 200, result.value, { etag: v1.versionEtag(result.value.version) });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/daily-records\/[^/]+$/.test(url.pathname)) {
      const entry = await remove(url.pathname.split("/")[4], v1.expectedVersion(req));
      if (entry?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: entry.currentVersion });
      return entry
        ? v1.success(res, 200, { trashId: entry.id })
        : v1.error(res, 404, "这条每日记录不存在", "DAILY_RECORD_NOT_FOUND");
    }
    return false;
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/daily-records") {
      const result = await records.create(await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, result.value);
    } else if (req.method === "PATCH" && /^\/api\/daily-records\/[^/]+$/.test(url.pathname)) {
      const result = await records.update(url.pathname.split("/")[3], await bodyJson(req));
      if (result.missing) sendJson(res, 404, { error: "这条每日记录不存在" });
      else if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 200, result.value);
    } else if (req.method === "DELETE" && /^\/api\/daily-records\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await remove(url.pathname.split("/")[3]), "这条每日记录不存在");
    } else return false;
    return true;
  }

  return { handle, handleV1 };
}
