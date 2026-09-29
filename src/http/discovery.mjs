const filtersFrom = url => ({
  query: url.searchParams.get("q") || "",
  types: url.searchParams.getAll("type").length
    ? url.searchParams.getAll("type")
    : url.searchParams.get("types"),
  genres: url.searchParams.getAll("genre").length
    ? url.searchParams.getAll("genre")
    : url.searchParams.get("genres"),
  freshOnly: url.searchParams.get("fresh") === "1" || url.searchParams.get("fresh") === "fresh",
  cursor: url.searchParams.get("cursor") || "",
  limit: url.searchParams.get("limit") || undefined
});

export function createDiscoveryHttp({ discovery, bodyJson }) {
  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/discovery") {
      const result = await discovery.search(filtersFrom(url));
      if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
      if (result.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      return v1.success(res, 200, result.items, {
        meta: {
          nextCursor: result.nextCursor || null,
          total: result.total,
          untracedCount: result.untracedCount,
          totalUntracedCount: result.totalUntracedCount
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/discovery/random") {
      const result = await discovery.openRandomDoor(filtersFrom(url));
      if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
      return v1.success(res, 200, result.value, { meta: { total: result.total } });
    }
    if (req.method === "PATCH" && /^\/api\/v1\/thought-chains\/[^/]+\/discovery$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4];
      const input = await bodyJson(req);
      const options = { expectedVersion: v1.expectedVersion(req) };
      const result = input.action === "read"
        ? await discovery.markRead(id, options)
        : input.action === "snooze"
          ? await discovery.snooze(id, input.until, options)
          : input.action === "clearSnooze"
            ? await discovery.clearSnooze(id, options)
            : { error: "回访操作无效", code: "INVALID_DISCOVERY_ACTION" };
      if (result.missing) return v1.error(res, 404, "这条思绪不存在", "THOUGHT_NOT_FOUND");
      if (result.versionConflict) return v1.error(res, 412, "回访状态已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
      if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
      return v1.success(res, 200, result.value, { etag: v1.versionEtag(result.value.status.version) });
    }
    return false;
  }

  return { handleV1 };
}
