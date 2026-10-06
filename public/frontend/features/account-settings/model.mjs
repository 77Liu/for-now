export const LLM_TIERS = Object.freeze(["lite", "mid", "high", "ultra"]);
export const LLM_EFFORTS = Object.freeze(["none", "high", "max"]);
export const RESPONSE_STYLE_OPTIONS = Object.freeze([
  ["concise", "简短"],
  ["standard", "标准"],
  ["deep", "深入"],
  ["structured", "结构化"],
  ["exploratory", "开放探索"]
]);
export const RESPONSE_STYLE_SCENES = Object.freeze([
  "thoughtDraft",
  "thoughtAnswer",
  "followUpAnswer",
  "chat",
  "diaryReflection",
  "annotationShenji",
  "analysis"
]);

export const DEFAULT_LLM_PROFILES = Object.freeze({
  lite: Object.freeze({ model: "deepseek-flash", effort: "none" }),
  mid: Object.freeze({ model: "deepseek-flash", effort: "high" }),
  high: Object.freeze({ model: "deepseek-v4-pro", effort: "high" }),
  ultra: Object.freeze({ model: "deepseek-v4-pro", effort: "max" })
});
export const DEFAULT_LLM_SCENARIOS = Object.freeze({
  thoughtPrompt: "lite",
  thoughtDraft: "high",
  thoughtAnswer: "ultra",
  followUpAnswer: "ultra",
  chat: "high",
  diaryLead: "lite",
  diaryStructure: "mid",
  diaryTopic: "high",
  diaryReflection: "ultra",
  annotationShenji: "high",
  analysis: "ultra",
  bookRecognition: "mid",
  healthRecognition: "mid",
  contentImageUnderstanding: "mid",
  capturePolish: "mid"
});
export const DEFAULT_SCENE_EFFORTS = Object.freeze({
  ...Object.fromEntries(Object.entries(DEFAULT_LLM_SCENARIOS)
    .map(([scene, tier]) => [scene, DEFAULT_LLM_PROFILES[tier].effort])),
  onboardingClaimExtraction: "high"
});

export function normalizeTtsGenerationRate(value, fallback = -10) {
  const rate = Number(value);
  const fallbackRate = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackRate)
    ? Math.min(100, Math.max(-50, Math.round(fallbackRate)))
    : -10;
  return Number.isFinite(rate)
    ? Math.min(100, Math.max(-50, Math.round(rate)))
    : normalizedFallback;
}

export function normalizeAccountSettings(value = {}) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    ...settings,
    profiles: Object.fromEntries(LLM_TIERS.map(tier => [
      tier,
      { ...DEFAULT_LLM_PROFILES[tier], ...(settings.profiles?.[tier] || {}) }
    ])),
    scenarios: { ...DEFAULT_LLM_SCENARIOS, ...(settings.scenarios || {}) },
    sceneEfforts: { ...DEFAULT_SCENE_EFFORTS, ...(settings.sceneEfforts || {}) },
    automaticAnswers: {
      thoughtAnswer: settings.automaticAnswers?.thoughtAnswer === true
    },
    speech: {
      defaultVoice: String(settings.speech?.defaultVoice || ""),
      generationRate: normalizeTtsGenerationRate(settings.speech?.generationRate)
    },
    responseStyles: Object.fromEntries(RESPONSE_STYLE_SCENES.map(scene => [
      scene,
      settings.responseStyles?.[scene] || "standard"
    ]))
  };
}

export function accountTtsVoice(settings = {}, speech = {}) {
  const voices = Array.isArray(speech.voices) ? speech.voices : [];
  const preferred = String(settings.speech?.defaultVoice || "");
  if (preferred && (!voices.length || voices.some(voice => voice?.id === preferred))) {
    return preferred;
  }
  return String(speech.defaultVoice || voices[0]?.id || "");
}

export function speechPreviewPayload(voice) {
  const value = String(voice || "").trim();
  if (!value) throw new Error("请选择试音音色");
  return { voice: value };
}

export function ttsGenerationRateText(value) {
  return `${(1 + normalizeTtsGenerationRate(value) / 100).toFixed(2)}×`;
}

function queryAll(root, selector) {
  return [...(root?.querySelectorAll?.(selector) || [])];
}

export function settingsPayload(root, {
  owner = false,
  settings: value = {},
  speech = {}
} = {}) {
  const settings = normalizeAccountSettings(value);
  const voice = root.querySelector("#tts-default-voice")?.value
    || accountTtsVoice(settings, speech);
  const payload = {
    sceneEfforts: Object.fromEntries(queryAll(root, "[data-ai-effort]")
      .map(select => [select.dataset.aiEffort, select.value])),
    assistantName: root.querySelector("#assistant-name")?.value || "",
    responseStyles: Object.fromEntries(queryAll(root, "[data-response-style]")
      .map(select => [select.dataset.responseStyle, select.value])),
    automaticAnswers: {
      thoughtAnswer: root.querySelector("#automatic-thought-answer")?.checked === true
    },
    speech: {
      defaultVoice: voice,
      generationRate: normalizeTtsGenerationRate(
        root.querySelector("#tts-generation-rate")?.value
      )
    }
  };
  if (!owner) return payload;

  const profiles = Object.fromEntries(LLM_TIERS.map(tier => [
    tier,
    {
      ...settings.profiles[tier],
      model: root.querySelector(`[data-profile-model="${tier}"]`)?.value
        || settings.profiles[tier].model
    }
  ]));
  const visibleScenarios = Object.fromEntries(queryAll(root, "[data-ai-scenario]")
    .map(select => [select.dataset.aiScenario, select.value]));
  return {
    ...payload,
    profiles,
    scenarios: { ...settings.scenarios, ...visibleScenarios },
    apiKey: root.querySelector("#llm-api-key")?.value || ""
  };
}
