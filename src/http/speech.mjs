import { normalizeTtsGenerationRate, resolveConfiguredTtsVoice } from "../shared/speech/index.mjs";

export function createSpeechHttp({
  speech,
  gate,
  auditCall = async (_details, invoke) => invoke(),
  bodyJson,
  sendJson,
  readSettings = async () => ({}),
  getContext = () => null,
  cache = null
}) {
  if (!speech || typeof speech.synthesize !== "function" || !gate || typeof gate.acquire !== "function") {
    throw new TypeError("Speech HTTP requires a provider and rate gate");
  }
  if (cache && typeof cache.synthesizeCapture !== "function") {
    throw new TypeError("Speech HTTP cache must synthesize capture sources");
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/speech/voices") {
      sendJson(res, 200, {
        configured: speech.configured,
        defaultVoice: speech.defaultVoice,
        voices: speech.voices
      });
      return true;
    }
    if (req.method !== "POST" || url.pathname !== "/api/speech/synthesize") return false;
    const input = await bodyJson(req);
    const speechSettings = (await readSettings())?.speech || {};
    const generationRate = normalizeTtsGenerationRate(speechSettings.generationRate);
    const voice = resolveConfiguredTtsVoice(speechSettings.defaultVoice, speech);
    const generate = async ({ text, voice: selectedVoice, generationRate: selectedRate }) => {
      const release = await gate.acquire();
      try {
        return await auditCall({
          provider: "volcengine",
          service: "speech",
          scene: "speechSynthesis",
          action: "synthesize",
          request: { textChars: String(text || "").length, voice: selectedVoice, generationRate: selectedRate },
          modality: "audio",
          requestChars: String(text || "").length,
          unitType: "character",
          units: [...String(text || "")].length,
          costKnown: false,
          costSource: "Volcengine billing not configured"
        }, () => speech.synthesize({
          text,
          voice: selectedVoice,
          generationRate: selectedRate
        }), value => ({
          voice: value.voice,
          generationRate: selectedRate,
          audioBytes: value.audio.length
        }));
      } finally {
        release();
      }
    };
    const result = cache
      ? await cache.synthesizeCapture({
          captureId: input.captureId,
          sourceVersion: input.sourceVersion,
          voice,
          generationRate
        }, generate)
      : await generate({ text: input.text, voice, generationRate });
    const context = getContext();
    if (context) context.applicationStatus = 200;
    res.writeHead(200, {
      "content-type": result.mimeType,
      "content-length": result.audio.length,
      "cache-control": "private, no-store",
      "x-speech-provider": "volcengine",
      "x-speech-voice": result.voice,
      ...(result.cacheStatus ? { "x-speech-cache": result.cacheStatus } : {})
    });
    res.end(result.audio);
    return true;
  }

  return { handle };
}
