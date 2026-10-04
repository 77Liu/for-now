import { normalizeTtsGenerationRate, resolveConfiguredTtsVoice } from "../shared/speech/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

const failure = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });

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
  if (cache && (typeof cache.synthesize !== "function" || typeof cache.readAudio !== "function")) {
    throw new TypeError("Speech HTTP cache must synthesize and read speech sources");
  }

  const previewCache = new Map();
  const previewInFlight = new Map();
  const voices = () => Array.isArray(speech.voices) ? speech.voices : [];
  const sendAudio = (res, result) => {
    const context = getContext();
    if (context) context.applicationStatus = 200;
    res.writeHead(200, {
      "content-type": result.mimeType,
      "content-length": result.audio.length,
      "cache-control": "private, no-store",
      "x-speech-provider": "volcengine",
      "x-speech-voice": result.voice,
      ...(result.assetId ? { "x-speech-asset-id": result.assetId } : {}),
      ...(result.cacheStatus ? { "x-speech-cache": result.cacheStatus } : {})
    });
    res.end(result.audio);
  };

  const generate = async ({ text, voice, generationRate, scene = "speechSynthesis" }) => {
    const release = await gate.acquire();
    try {
      return await auditCall({
        provider: "volcengine",
        service: "speech",
        scene,
        action: "synthesize",
        request: { textChars: String(text || "").length, voice, generationRate },
        modality: "audio",
        requestChars: String(text || "").length,
        unitType: "character",
        units: [...String(text || "")].length,
        costKnown: false,
        costSource: "Volcengine billing not configured"
      }, () => speech.synthesize({
        text,
        voice,
        generationRate
      }), value => ({
        voice: value.voice,
        generationRate,
        audioBytes: value.audio.length
      }));
    } finally {
      release();
    }
  };

  async function preview(input) {
    if (Object.keys(input).some(key => key !== "voice")) {
      throw failure("音色试听只接受 voice", "INVALID_SPEECH_PREVIEW", 400);
    }
    const voice = safeText(input.voice, 160);
    const configured = voices().find(item => item.id === voice);
    if (!configured) throw failure("试听音色无效", "INVALID_TTS_VOICE", 400);
    const cached = previewCache.get(voice);
    if (cached) return { ...cached, audio: Buffer.from(cached.audio) };
    const pending = previewInFlight.get(voice);
    if (pending) return pending;
    const operation = generate({
      text: configured.sampleText,
      voice,
      generationRate: normalizeTtsGenerationRate(undefined),
      scene: "speechPreview"
    }).then(result => {
      const value = {
        audio: Buffer.from(result.audio),
        mimeType: result.mimeType,
        voice: result.voice || voice
      };
      previewCache.set(voice, value);
      return { ...value, audio: Buffer.from(value.audio) };
    }).finally(() => {
      if (previewInFlight.get(voice) === operation) previewInFlight.delete(voice);
    });
    previewInFlight.set(voice, operation);
    return operation;
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
    if (req.method === "GET" && url.pathname === "/api/speech/audio") {
      if (!cache) throw failure("朗读缓存不可用", "SPEECH_CACHE_UNAVAILABLE", 503);
      sendAudio(res, await cache.readAudio({ id: url.searchParams.get("id") }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/speech/preview") {
      sendAudio(res, await preview(await bodyJson(req)));
      return true;
    }
    if (req.method !== "POST" || url.pathname !== "/api/speech/synthesize") return false;
    const input = await bodyJson(req);
    const legacyCaptureId = safeText(input.captureId, 160);
    const sourceType = safeText(input.sourceType, 40) || (legacyCaptureId ? "capture" : "");
    const sourceId = safeText(input.sourceId, 160) || legacyCaptureId;
    if (legacyCaptureId && (sourceType !== "capture" || sourceId !== legacyCaptureId)) {
      throw failure("新旧朗读来源参数不一致", "INVALID_SPEECH_SOURCE", 400);
    }
    if (Object.hasOwn(input, "regenerate") && typeof input.regenerate !== "boolean") {
      throw failure("regenerate 必须是布尔值", "INVALID_SPEECH_REGENERATE", 400);
    }
    const sourceVersion = Number(input.sourceVersion);
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      throw failure("朗读来源版本无效", "INVALID_SPEECH_SOURCE_VERSION", 400);
    }
    const speechSettings = (await readSettings())?.speech || {};
    const generationRate = normalizeTtsGenerationRate(speechSettings.generationRate);
    const voice = resolveConfiguredTtsVoice(speechSettings.defaultVoice, speech);
    const result = cache
      ? await cache.synthesize({
          sourceType,
          sourceId,
          sourceVersion,
          voice,
          generationRate,
          regenerate: input.regenerate === true
        }, options => generate({ ...options, scene: "speechSynthesis" }))
      : await generate({ text: input.text, voice, generationRate, scene: "speechSynthesis" });
    sendAudio(res, result);
    return true;
  }

  return { handle };
}
