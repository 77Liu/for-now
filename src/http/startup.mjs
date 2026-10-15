import { THOUGHT_PAGING } from "../../.build/typescript/backend/shared/thought-pagination/index.mjs";
const routeViews = new Set([
  "today",
  "together",
  "daily",
  "captures",
  "books",
  "quotes",
  "keepsakes",
  "journals",
  "thoughts",
  "discovery",
  "review",
  "mine",
  "personal-context",
  "statistics",
  "ai-cost",
  "architecture",
  "commercialization",
  "feedback",
  "export",
  "notifications",
  "trash",
  "permission",
  "account",
  "settings",
  "about"
]);

export function createStartupHttp({ readStartup, readRouteState }) {
  if (typeof readStartup !== "function" || typeof readRouteState !== "function") {
    throw new TypeError("Startup HTTP requires startup and route readers");
  }

  return {
    async handleV1(req, res, url, v1) {
      if (req.method === "GET" && url.pathname === "/api/v1/startup") {
        return v1.success(res, 200, await readStartup());
      }
      if (req.method === "GET" && url.pathname === "/api/v1/route-state") {
        const view = String(url.searchParams.get("view") || "today");
        if (!routeViews.has(view)) {
          return v1.error(res, 400, "页面标识无效", "INVALID_ROUTE_VIEW");
        }
        const query = Object.fromEntries(url.searchParams);
        if (String(query.q || "").length > 200) {
          return v1.error(res, 400, "搜索内容过长", "INVALID_QUERY");
        }
        if (String(query.tag || "").length > 30) {
          return v1.error(res, 400, "标签内容过长", "INVALID_QUERY");
        }
        if (view === "thoughts") {
          const direction = query.direction || "next";
          if (!["next", "prev"].includes(direction) || (direction === "prev" && !query.cursor) || (url.searchParams.has("page") && (url.searchParams.has("cursor") || url.searchParams.has("direction")))) return v1.error(res, 400, "分页参数冲突或方向无效", "INVALID_QUERY");
          const page = url.searchParams.has("page") ? Number(query.page) : 1;
          if (!Number.isInteger(page) || page < 1 || page > THOUGHT_PAGING.maxPages) return v1.error(res, 400, "旧页码不支持，请从游标入口继续", "LEGACY_PAGE_UNSUPPORTED");
          query.thoughtAfterId = v1.pagination(url, { defaultLimit: THOUGHT_PAGING.pageSize, maxLimit: THOUGHT_PAGING.pageSize, maxCursorLength: THOUGHT_PAGING.maxCursorDecodedLength }).afterId;
        }
        if (view === "review") {
          query.analysisAfterId = v1.pagination(url, {
            defaultLimit: 8,
            maxLimit: 8,
            maxCursorLength: 200
          }).afterId;
        }
        const projection = await readRouteState({
          view,
          resourceId: String(url.searchParams.get("resourceId") || "").slice(0, 200),
          query
        });
        if (projection?.thoughtPage) {
          if (projection.thoughtPage.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
          if (projection.thoughtPage.invalidQuery) return v1.error(res, 400, "分页方向无效", "INVALID_QUERY");
          const { nextId = "", prevId = "", invalidCursor: _invalidCursor, invalidQuery: _invalidQuery, ...thoughtPage } = projection.thoughtPage;
          projection.thoughtPage = {
            ...thoughtPage,
            ...(thoughtPage.pages ? { pages: thoughtPage.pages.map(({ requestId, nextId, prevId, count }) => ({ requestCursor: v1.nextCursor(requestId), nextCursor: v1.nextCursor(nextId), prevCursor: v1.nextCursor(prevId), count })) } : {}),
            prevCursor: v1.nextCursor(prevId),
            nextCursor: v1.nextCursor(nextId)
          };
        }
        if (projection?.analysisPage) {
          if (projection.analysisPage.invalidCursor) {
            return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
          }
          const { nextId = "", invalidCursor: _invalidCursor, ...analysisPage } = projection.analysisPage;
          projection.analysisPage = {
            ...analysisPage,
            nextCursor: v1.nextCursor(nextId)
          };
        }
        return v1.success(res, 200, projection);
      }
      return false;
    }
  };
}
