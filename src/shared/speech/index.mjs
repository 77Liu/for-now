import { numberOrFallback, safeText } from "../validation/index.mjs";

export const TTS_GENERATION_RATE_MIN = -50;
export const TTS_GENERATION_RATE_MAX = 100;
export const TTS_GENERATION_RATE_DEFAULT = -10;

export function normalizeTtsGenerationRate(value, fallback = TTS_GENERATION_RATE_DEFAULT) {
  const normalizedFallback = numberOrFallback(
    fallback,
    TTS_GENERATION_RATE_DEFAULT,
    TTS_GENERATION_RATE_MIN,
    TTS_GENERATION_RATE_MAX,
    true
  );
  return numberOrFallback(
    value,
    normalizedFallback,
    TTS_GENERATION_RATE_MIN,
    TTS_GENERATION_RATE_MAX,
    true
  );
}

export function resolveConfiguredTtsVoice(value, speech = {}) {
  const selected = safeText(value, 160);
  const configuredDefault = safeText(speech?.defaultVoice, 160);
  const voiceIds = new Set((Array.isArray(speech?.voices) ? speech.voices : [])
    .map(voice => safeText(voice?.id, 160))
    .filter(Boolean));
  if (!voiceIds.size) return selected || configuredDefault;
  if (voiceIds.has(selected)) return selected;
  if (voiceIds.has(configuredDefault)) return configuredDefault;
  return voiceIds.values().next().value || "";
}

export function readableSpeechText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#~|]/g, "")
    .replace(/\\[\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechTextForCapture(capture = {}) {
  const source = capture?.transcription?.condensedText
    || capture?.transcription?.polishedText
    || capture?.transcription?.rawText
    || capture?.content
    || "";
  return readableSpeechText(source);
}
