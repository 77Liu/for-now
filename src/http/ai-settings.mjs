import {
  LLM_TIERS,
  automaticAnswerDecision,
  mergeLlmSettings,
  mergeUserAiPreferences,
  publicLlmSettings,
  publicUserAiPreferences
} from "../modules/ai/index.mjs";
import { resolveConfiguredTtsVoice } from "../shared/speech/index.mjs";
import { openingPreferences, openingEtag } from "../../public/frontend/shared/opening/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

export function createAiSettingsHttp({ settings, speech = {}, generate, bodyJson, sendJson, canConfigureOpening = () => false }) {
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
    if (url.pathname === "/api/opening-preferences") {
      res.setHeader("cache-control", "private, no-store");
      if (!canConfigureOpening()) {
        sendJson(res, 403, { code: "OWNER_REQUIRED", error: "仅主账户可以设置开场氛围" });
      } else if (req.method === "GET") {
        const value = openingPreferences((await settings.read()).opening);
        res.setHeader("etag", openingEtag(value));
        sendJson(res, 200, value);
      } else if (req.method === "PUT") {
        const input = await bodyJson(req);
        try {
          const next = await settings.update(current => {
            const previous = openingPreferences(current.opening);
            if (input?.revision !== previous.revision || req.headers["if-match"] !== openingEtag(previous)) {
              throw Object.assign(new Error("开场设置已在别处更新，草稿已保留，请重新加载后再保存"), { code: "OPENING_CONFLICT", current: previous });
            }
            return { ...current, opening: { ...openingPreferences(input), revision: previous.revision + 1 } };
          });
          res.setHeader("etag", openingEtag(next.opening));
          sendJson(res, 200, next.opening);
        } catch (error) {
          if (error.code !== "OPENING_CONFLICT") throw error;
          res.setHeader("etag", openingEtag(error.current));
          sendJson(res, 409, { code: error.code, error: error.message, current: error.current });
        }
      } else sendJson(res, 405, { error: "不支持此操作" });
    } else if (req.method === "GET" && url.pathname === "/api/preferences") {
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
