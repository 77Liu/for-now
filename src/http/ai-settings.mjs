import {
  LLM_TIERS,
  automaticAnswerDecision,
  mergeLlmSettings,
  mergeUserAiPreferences,
  publicLlmSettings,
  publicUserAiPreferences
} from "../modules/ai/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

export function createAiSettingsHttp({ settings, generate, bodyJson, sendJson }) {
  const automaticAnswer = async input => automaticAnswerDecision(await settings.read(), input);
  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/preferences") {
      sendJson(res, 200, publicUserAiPreferences(await settings.read()));
    } else if (req.method === "PATCH" && url.pathname === "/api/preferences") {
      const input = await bodyJson(req);
      const value = await settings.update(current => mergeUserAiPreferences(current, input));
      sendJson(res, 200, publicUserAiPreferences(value));
    } else if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, publicLlmSettings(await settings.read()));
    } else if (req.method === "POST" && url.pathname === "/api/settings") {
      const input = await bodyJson(req);
      const value = await settings.update(current => mergeLlmSettings(current, input));
      sendJson(res, 200, publicLlmSettings(value));
    } else if (req.method === "POST" && url.pathname === "/api/settings/test") {
      const input = await bodyJson(req), tier = LLM_TIERS.includes(input.tier) ? input.tier : "lite";
      const reply = await generate("只回复：连接成功。不要添加其他内容。", { scene: tier, maxTokens: 40 });
      sendJson(res, 200, { ok: true, reply: safeText(reply, 80), tier, settings: publicLlmSettings(await settings.read()) });
    } else return false;
    return true;
  }
  return { handle, automaticAnswer };
}
