import { safeText } from "../../shared/validation/index.mjs";
import { normalizeTtsGenerationRate, TTS_GENERATION_RATE_DEFAULT } from "../../shared/speech/index.mjs";

import { openingPreferences } from "../../../public/frontend/shared/opening/index.mjs";

export const LLM_SETTINGS_VERSION = 13;
export const LLM_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
export const LLM_EFFORTS = ["none", "high", "max"];
export const LLM_TIERS = ["lite", "mid", "high", "ultra"];
export const LLM_SCENARIOS = ["thoughtPrompt", "thoughtDraft", "thoughtAnswer", "followUpAnswer", "chat", "diaryLead", "diaryStructure", "diaryTopic", "diaryReflection", "annotationShenji", "analysis", "bookRecognition", "healthRecognition", "contentImageUnderstanding", "capturePolish", "onboardingClaimExtraction", "perceptionExtraction", "recordCompression", "importanceScoring"];
const RESPONSE_STYLES = ["concise", "standard", "deep", "structured", "exploratory"];
const RESPONSE_STYLE_SCENARIOS = ["thoughtDraft", "thoughtAnswer", "followUpAnswer", "chat", "diaryReflection", "annotationShenji", "analysis"];

export const defaultLlmSettings = {
  version: LLM_SETTINGS_VERSION,
  provider: "deepseek",
  profiles: {
    lite: { model: "deepseek-flash", effort: "none" },
    mid: { model: "deepseek-flash", effort: "high" },
    high: { model: "deepseek-v4-pro", effort: "high" },
    ultra: { model: "deepseek-v4-pro", effort: "max" }
  },
  scenarios: {
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
    capturePolish: "mid",
    onboardingClaimExtraction: "mid",
    perceptionExtraction: "lite",
    recordCompression: "lite",
    importanceScoring: "lite"
  },
  sceneEfforts: {
    thoughtPrompt: "none",
    thoughtDraft: "high",
    thoughtAnswer: "max",
    followUpAnswer: "max",
    chat: "high",
    diaryLead: "none",
    diaryStructure: "high",
    diaryTopic: "high",
    diaryReflection: "max",
    annotationShenji: "high",
    analysis: "max",
    bookRecognition: "high",
    healthRecognition: "high",
    contentImageUnderstanding: "high",
    capturePolish: "high",
    onboardingClaimExtraction: "high",
    perceptionExtraction: "none",
    recordCompression: "none",
    importanceScoring: "none"
  },
  assistantName: "神鸡",
  responseStyles: Object.fromEntries(RESPONSE_STYLE_SCENARIOS.map(scene => [scene, "standard"])),
  automaticAnswers: { thoughtAnswer: false },
  speech: { defaultVoice: "", generationRate: TTS_GENERATION_RATE_DEFAULT },
  opening: openingPreferences(),
  apiKey: ""
};

function normalizeLlmProfile(value, fallback) {
  return {
    model: LLM_MODELS.includes(value?.model) ? value.model : fallback.model,
    effort: LLM_EFFORTS.includes(value?.effort) ? value.effort : fallback.effort
  };
}

function legacyLlmTier(model, effort) {
  if (model === "deepseek-flash" && effort === "none") return "lite";
  if (model === "deepseek-flash") return "mid";
  if (model === "deepseek-v4-pro" && effort === "max") return "ultra";
  return "high";
}

export function normalizeLlmSettings(value = {}) {
  const settings = structuredClone(defaultLlmSettings);
  settings.opening = openingPreferences(value.opening);
  settings.apiKey = safeText(value.apiKey, 300);
  settings.assistantName = safeText(value.assistantName, 24) || defaultLlmSettings.assistantName;
  settings.automaticAnswers.thoughtAnswer = value.automaticAnswers?.thoughtAnswer === true;
  settings.speech.defaultVoice = safeText(value.speech?.defaultVoice, 160);
  settings.speech.generationRate = normalizeTtsGenerationRate(value.speech?.generationRate);
  for (const scene of RESPONSE_STYLE_SCENARIOS) settings.responseStyles[scene] = RESPONSE_STYLES.includes(value.responseStyles?.[scene]) ? value.responseStyles[scene] : "standard";
  if (!value.profiles || !value.scenarios) {
    const model = LLM_MODELS.includes(value.model) ? value.model : settings.profiles.ultra.model;
    const effort = LLM_EFFORTS.includes(value.effort) ? value.effort : settings.profiles.ultra.effort;
    const tier = legacyLlmTier(model, effort);
    settings.profiles[tier] = { model, effort };
  } else {
    for (const tier of LLM_TIERS) settings.profiles[tier] = normalizeLlmProfile(value.profiles[tier], settings.profiles[tier]);
    const legacyScenarioValues = Object.entries(value.scenarios).filter(([scenario, tier]) => LLM_SCENARIOS.includes(scenario) && LLM_TIERS.includes(tier)).map(([, tier]) => tier);
    const legacyAllUltra = Number(value.version || 1) < 3
      && legacyScenarioValues.length >= 11
      && legacyScenarioValues.every(tier => tier === "ultra");
    if (!legacyAllUltra) {
      for (const scenario of LLM_SCENARIOS) settings.scenarios[scenario] = LLM_TIERS.includes(value.scenarios[scenario]) ? value.scenarios[scenario] : settings.scenarios[scenario];
    }
  }
  for (const scenario of LLM_SCENARIOS) {
    const fallback = settings.profiles[settings.scenarios[scenario]].effort;
    settings.sceneEfforts[scenario] = LLM_EFFORTS.includes(value.sceneEfforts?.[scenario]) ? value.sceneEfforts[scenario] : fallback;
  }
  return settings;
}

export function publicLlmSettings(value) {
  const settings = normalizeLlmSettings(value), primary = settings.profiles[settings.scenarios.thoughtAnswer];
  return { version: LLM_SETTINGS_VERSION, provider: "deepseek", profiles: settings.profiles, scenarios: settings.scenarios, sceneEfforts: settings.sceneEfforts, assistantName: settings.assistantName, responseStyles: settings.responseStyles, automaticAnswers: settings.automaticAnswers, speech: settings.speech, model: primary.model, effort: settings.sceneEfforts.thoughtAnswer, hasApiKey: Boolean(settings.apiKey), keyHint: settings.apiKey ? `${settings.apiKey.slice(0, 3)}••••${settings.apiKey.slice(-4)}` : "" };
}

export function publicUserAiPreferences(value) {
  const settings = normalizeLlmSettings(value);
  return {
    version: LLM_SETTINGS_VERSION,
    sceneEfforts: settings.sceneEfforts,
    assistantName: settings.assistantName,
    responseStyles: settings.responseStyles,
    automaticAnswers: settings.automaticAnswers,
    speech: settings.speech
  };
}

export function llmSettingsForScene(settings, scene = "thoughtAnswer") {
  const normalized = normalizeLlmSettings(settings), tier = LLM_TIERS.includes(scene) ? scene : normalized.scenarios[scene] || "high";
  const profile = normalized.profiles[tier];
  return {
    provider: "deepseek",
    apiKey: normalized.apiKey,
    tier,
    assistantName: normalized.assistantName,
    responseStyle: normalized.responseStyles[scene] || "standard",
    ...profile,
    effort: LLM_EFFORTS.includes(scene) ? profile.effort : normalized.sceneEfforts[scene] || profile.effort
  };
}

export function mergeLlmSettings(current, input) {
  const suppliedKey = safeText(input.apiKey, 300), apiKey = input.clearApiKey ? "" : suppliedKey || current.apiKey;
  const profiles = structuredClone(input.profiles || current.profiles);
  const scenarios = structuredClone(input.scenarios || current.scenarios);
  const sceneEfforts = structuredClone(input.sceneEfforts || current.sceneEfforts || {});
  if (!input.profiles && (input.model || input.effort)) {
    const tier = current.scenarios.thoughtAnswer;
    profiles[tier] = { model: input.model || profiles[tier].model, effort: input.effort || profiles[tier].effort };
    if (input.effort) sceneEfforts.thoughtAnswer = input.effort;
  }
  return normalizeLlmSettings({ opening: current.opening, version: LLM_SETTINGS_VERSION, provider: "deepseek", profiles, scenarios, sceneEfforts, assistantName: input.assistantName ?? current.assistantName, responseStyles: input.responseStyles || current.responseStyles, automaticAnswers: input.automaticAnswers || current.automaticAnswers, speech: { ...current.speech, ...(input.speech || {}) }, apiKey });
}

export function mergeUserAiPreferences(current, input) {
  return normalizeLlmSettings({
    ...current,
    version: LLM_SETTINGS_VERSION,
    sceneEfforts: { ...current.sceneEfforts, ...(input.sceneEfforts || {}) },
    assistantName: input.assistantName ?? current.assistantName,
    responseStyles: { ...current.responseStyles, ...(input.responseStyles || {}) },
    automaticAnswers: { ...current.automaticAnswers, ...(input.automaticAnswers || {}) },
    speech: { ...current.speech, ...(input.speech || {}) }
  });
}

export function automaticAnswerDecision(settings, { hasAnswer = false } = {}) {
  const enabled = normalizeLlmSettings(settings).automaticAnswers.thoughtAnswer;
  if (hasAnswer) return { enabled, generateAnswer: false, reason: "answer_present" };
  if (!enabled) return { enabled, generateAnswer: false, reason: "account_disabled" };
  return { enabled, generateAnswer: true, reason: "enabled" };
}

export function createLlmSettingsService({ repository }) {
  return {
    read: repository.read,
    write: repository.write,
    ensure: () => repository.ensure(LLM_SETTINGS_VERSION, original => Number(original.version) !== LLM_SETTINGS_VERSION),
    update: mutator => repository.update(async document => {
      const next = await mutator(document);
      for (const key of Object.keys(document)) delete document[key];
      Object.assign(document, next);
      return next;
    })
  };
}
