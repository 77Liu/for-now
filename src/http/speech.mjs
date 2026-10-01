import { normalizeTtsGenerationRate } from "../shared/speech/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

export function createSpeechHttp({
  speech,
  gate,
  auditCall = async (_details, invoke) => invoke(),
  bodyJson,
  sendJson,
  readSettings = async () => ({}),
  getContext = () => null
}) {
  if (!speech || typeof speech.synthesize !== "function" || !gate || typeof gate.acquire !== "function") {
    throw new TypeError("Speech HTTP requires a provider and rate gate");
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
    const generationRate = normalizeTtsGenerationRate((await readSettings())?.speech?.generationRate);
    const release = await gate.acquire();
    try {
      const voice = safeText(input.voice, 160) || speech.defaultVoice;
      const result = await auditCall({
        provider: "volcengine",
        service: "speech",
        scene: "speechSynthesis",
        action: "synthesize",
        request: { textChars: String(input.text || "").length, voice, generationRate },
        modality: "audio",
        requestChars: String(input.text || "").length,
        unitType: "character",
        units: [...String(input.text || "")].length,
        costKnown: false,
        costSource: "Volcengine billing not configured"
      }, () => speech.synthesize({ text: input.text, voice, generationRate }), value => ({
        voice: value.voice,
        generationRate,
        audioBytes: value.audio.length
      }));
      const context = getContext();
      if (context) context.applicationStatus = 200;
      res.writeHead(200, {
        "content-type": result.mimeType,
        "content-length": result.audio.length,
        "cache-control": "private, no-store",
        "x-speech-provider": "volcengine",
        "x-speech-voice": result.voice
      });
      res.end(result.audio);
    } finally {
      release();
    }
    return true;
  }

  return { handle };
}
