export function createOnboardingHttp({ onboarding, bodyJson, sendJson }) {
  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/onboarding/schema") {
      sendJson(res, 200, onboarding.schema());
    } else if (req.method === "POST" && url.pathname === "/api/onboarding/preview") {
      const result = onboarding.preview(await bodyJson(req));
      sendJson(res, result.error ? 400 : 200, result.error ? result : result.value);
    } else if (req.method === "PATCH" && url.pathname === "/api/onboarding") {
      const result = await onboarding.save(await bodyJson(req));
      sendJson(res, result.error ? 400 : 200, result.error ? result : result.value);
    } else return false;
    return true;
  }
  return { handle };
}
