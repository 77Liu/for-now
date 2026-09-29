export function createAiCostHttp({ costs, bodyJson, sendJson }) {
  async function handle(req, res, url) {
    if (url.pathname !== "/api/ai-cost-plan") return false;
    if (req.method === "GET") sendJson(res, 200, await costs.read());
    else if (req.method === "PATCH") sendJson(res, 200, await costs.save(await bodyJson(req)));
    else return false;
    return true;
  }
  return { handle };
}
