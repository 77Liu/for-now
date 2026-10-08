const ARCHITECTURE_PATH = "/api/owner/surfaces/architecture";
const COMMERCIALIZATION_PATHS = new Set([
  "/api/owner/surfaces/commercialization",
  "/api/owner/surfaces/commercialization/preview"
]);

export function ownerCapabilityFor(url) {
  if (url.pathname === ARCHITECTURE_PATH) return "architecture";
  if (COMMERCIALIZATION_PATHS.has(url.pathname)) return "commercialization";
  if (url.pathname === "/api/ai-cost-plan") return "ai-costs";
  if (url.pathname === "/api/v1/owner/ai-budget") return "ai-costs";
  if (url.pathname === "/api/commercialization") return "commercialization";
  if (url.pathname === "/api/opening-preferences" || url.pathname === "/api/settings" || url.pathname === "/api/settings/test") {
    return "ai-configuration";
  }
  if (url.pathname === "/api/vision/status") return "ai-configuration";
  return "";
}

export function createOwnerHttp({
  architectureSurface,
  commercializationSurface,
  normalizeCommercialization,
  statistics,
  readStore,
  updateStore,
  bodyJson,
  sendJson,
  now,
  today
}) {
  for (const [name, dependency] of Object.entries({
    architectureSurface,
    commercializationSurface,
    normalizeCommercialization,
    readStore,
    updateStore,
    bodyJson,
    sendJson,
    now,
    today
  })) {
    if (typeof dependency !== "function") throw new TypeError(`Owner HTTP requires ${name}()`);
  }
  if (typeof statistics?.dashboard !== "function") {
    throw new TypeError("Owner HTTP requires statistics.dashboard()");
  }

  return {
    capabilityFor: ownerCapabilityFor,

    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === ARCHITECTURE_PATH) {
        res.setHeader("cache-control", "private, no-store");
        sendJson(res, 200, architectureSurface());
        return true;
      }
      if (
        ["GET", "POST"].includes(req.method)
        && COMMERCIALIZATION_PATHS.has(url.pathname)
      ) {
        const store = await readStore();
        const input = req.method === "POST" ? await bodyJson(req) : {};
        const report = req.method === "POST"
          ? normalizeCommercialization({
            ...store.commercialization,
            assumptions: input.assumptions
          })
          : store.commercialization;
        const range = {
          ...(url.searchParams.has("from") ? { from: url.searchParams.get("from") } : {}),
          ...(url.searchParams.has("to") ? { to: url.searchParams.get("to") } : {})
        };
        const result = await statistics.dashboard(range, { includeOwner: true });
        if (result.error) {
          sendJson(res, 400, { error: result.error, code: result.code });
          return true;
        }
        res.setHeader("cache-control", "private, no-store");
        sendJson(res, 200, commercializationSurface({
          report,
          store,
          statistics: result.value,
          mode: input.mode || url.searchParams.get("mode") || "validation",
          currentDate: today()
        }));
        return true;
      }
      if (req.method === "PATCH" && url.pathname === "/api/commercialization") {
        const input = await bodyJson(req);
        const updatedAt = now();
        const report = await updateStore(store => {
          store.commercialization = normalizeCommercialization({
            ...store.commercialization,
            assumptions: input.assumptions,
            updatedAt
          });
          return store.commercialization;
        });
        sendJson(res, 200, report);
        return true;
      }
      return false;
    }
  };
}
