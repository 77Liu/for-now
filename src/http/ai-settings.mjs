import {
  LLM_TIERS,
  automaticAnswerDecision,
  mergeLlmSettings,
  mergeUserAiPreferences,
  publicLlmSettings,
  publicUserAiPreferences
} from "../modules/ai/index.mjs";
import { resolveConfiguredTtsVoice } from "../shared/speech/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

export function createAiSettingsHttp({ settings, speech = {}, generate, bodyJson, sendJson }) {
  const withValidSpeechVoice = value => ({
    ...value,
    speech: {
      ...value?.speech,
      defaultVoice: resolveConfiguredTtsVoice(value?.speech?.defaultVoice, speech)
    }
  });
  const withValidSpeechInput = input => {
    if (!input?.speech || !Object.hasOwn(input.speech, "defaultVoice")) return input;
    return {
      ...input,
      speech: {
        ...input.speech,
        defaultVoice: resolveConfiguredTtsVoice(input.speech.defaultVoice, speech)
      }
    };
  };
  const publicSettings = value => publicLlmSettings(withValidSpeechVoice(value));
  const publicPreferences = value => publicUserAiPreferences(withValidSpeechVoice(value));
  const automaticAnswer = async input => automaticAnswerDecision(await settings.read(), input);
  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/preferences") {
      sendJson(res, 200, publicPreferences(await settings.read()));
    } else if (req.method === "PATCH" && url.pathname === "/api/preferences") {
      const input = withValidSpeechInput(await bodyJson(req));
      const value = await settings.update(current => mergeUserAiPreferences(current, input));
      sendJson(res, 200, publicPreferences(value));
    } else if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, publicSettings(await settings.read()));
    } else if (req.method === "POST" && url.pathname === "/api/settings") {
      const input = withValidSpeechInput(await bodyJson(req));
      const value = await settings.update(current => mergeLlmSettings(current, input));
      sendJson(res, 200, publicSettings(value));
    } else if (req.method === "POST" && url.pathname === "/api/settings/test") {
      const input = await bodyJson(req), tier = LLM_TIERS.includes(input.tier) ? input.tier : "lite";
      const reply = await generate("只回复：连接成功。不要添加其他内容。", { scene: tier, maxTokens: 40 });
      sendJson(res, 200, { ok: true, reply: safeText(reply, 80), tier, settings: publicSettings(await settings.read()) });
    } else return false;
    return true;
  }
  return { handle, automaticAnswer };
}
