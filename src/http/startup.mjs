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
        return v1.success(res, 200, await readRouteState({
          view,
          resourceId: String(url.searchParams.get("resourceId") || ""),
          query: Object.fromEntries(url.searchParams)
        }));
      }
      return false;
    }
  };
}
