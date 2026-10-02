import crypto from "node:crypto";
import { safeText, safeIso } from "../../shared/validation/index.mjs";
import { LLM_MODELS, LLM_EFFORTS, LLM_TIERS, LLM_SCENARIOS } from "./settings.mjs";
import { OFFICIAL_PROVIDER_PRICING } from "./provider-pricing.mjs";

export const AI_USAGE_VERSION = 4;
const PROVIDER_SCENES = new Set(["speechSynthesis", "speechRecognition", "visionOcr", "documentParsing", "keepsakeSegmentation"]);
const knownModalities = new Set(["vision", "text", "audio", "document"]);
function normalizedModality(item) {
  if (knownModalities.has(item?.modality)) return item.modality;
  if (item?.provider === "volcengine" && item?.service === "speech") return "audio";
  if (item?.provider === "volcengine" && item?.service === "vision") {
    return item?.unitType === "document" ? "document" : "vision";
  }
  if (item?.provider === "aliyun" && item?.service === "segmentation") return "vision";
  return "unknown";
}
export const DEEPSEEK_PRICING = OFFICIAL_PROVIDER_PRICING.deepseek;

export function normalizeAiUsage(value = {}) {
  const trackingStartedAt = safeIso(value.trackingStartedAt) || new Date().toISOString();
  const entries = Array.isArray(value.entries) ? value.entries.filter(item => {
    const provider = safeText(item?.provider, 40) || "deepseek";
    return item && safeIso(item.createdAt)
      && (LLM_MODELS.includes(item.model) || (provider !== "deepseek" && safeText(item.service, 40)));
  }).map(item => ({
    id: safeText(item.id, 100) || crypto.randomUUID(),
    callId: safeText(item.callId || item.id, 100) || crypto.randomUUID(),
    callGroupId: safeText(item.callGroupId, 100),
    traceId: safeText(item.traceId, 128),
    createdAt: safeIso(item.createdAt),
    completedAt: safeIso(item.completedAt),
    durationMs: Math.max(0, Math.round(Number(item.durationMs) || 0)),
    durationKnown: item.durationKnown == null ? Object.prototype.hasOwnProperty.call(item, "durationMs") : Boolean(item.durationKnown),
    status: ["success", "failed", "timeout", "cancelled"].includes(item.status) ? item.status : "unknown",
    httpStatus: Math.max(0, Math.round(Number(item.httpStatus) || 0)),
    errorCategory: safeText(item.errorCategory, 80),
    errorCode: safeText(item.errorCode, 120),
    provider: safeText(item.provider, 40) || "deepseek",
    providerRequestId: safeText(item.providerRequestId, 200),
    service: safeText(item.service, 40),
    action: safeText(item.action, 80),
    model: LLM_MODELS.includes(item.model) ? item.model : safeText(item.model, 100),
    modelReturned: safeText(item.modelReturned, 100),
    scene: LLM_SCENARIOS.includes(item.scene) || LLM_TIERS.includes(item.scene) || PROVIDER_SCENES.has(item.scene) ? item.scene : "unknown",
    tier: LLM_TIERS.includes(item.tier) ? item.tier : "",
    effort: LLM_EFFORTS.includes(item.effort) ? item.effort : "",
    attempt: Math.max(1, Math.round(Number(item.attempt) || 1)),
    maxAttempts: Math.max(1, Math.round(Number(item.maxAttempts) || 1)),
    retryReason: safeText(item.retryReason, 120),
    retryScheduled: Boolean(item.retryScheduled),
    stream: Boolean(item.stream),
    responseFormat: item.responseFormat === "json_object" ? "json_object" : "text",
    maxTokens: Math.max(0, Math.round(Number(item.maxTokens) || 0)),
    finishReason: safeText(item.finishReason, 80),
    modality: normalizedModality(item),
    imageCount: Math.max(0, Math.round(Number(item.imageCount)
      || (normalizedModality(item) === "vision" && item.unitType === "image" ? Number(item.units) : 0)
      || 0)),
    imageBytes: Math.max(0, Math.round(Number(item.imageBytes) || 0)),
    imageTypes: Array.isArray(item.imageTypes) ? item.imageTypes.map(type => safeText(type, 80)).filter(Boolean).slice(0, 8) : [],
    imageDimensions: Array.isArray(item.imageDimensions) ? item.imageDimensions.slice(0, 8).map(image => ({
      width: Math.max(0, Math.round(Number(image?.width) || 0)),
      height: Math.max(0, Math.round(Number(image?.height) || 0))
    })) : [],
    historyMessageCount: Math.max(0, Math.round(Number(item.historyMessageCount) || 0)),
    requestChars: Math.max(0, Math.round(Number(item.requestChars) || 0)),
    responseChars: Math.max(0, Math.round(Number(item.responseChars) || 0)),
    reasoningChars: Math.max(0, Math.round(Number(item.reasoningChars) || 0)),
    usageKnown: item.usageKnown == null ? Boolean(item.tokens?.input || item.tokens?.output) : Boolean(item.usageKnown),
    pricingPeriod: item.pricingPeriod === "peak" ? "peak" : "offPeak",
    tokens: {
      input: Math.max(0, Math.round(Number(item.tokens?.input) || 0)),
      cacheHit: Math.max(0, Math.round(Number(item.tokens?.cacheHit) || 0)),
      cacheMiss: Math.max(0, Math.round(Number(item.tokens?.cacheMiss) || 0)),
      reasoning: Math.max(0, Math.round(Number(item.tokens?.reasoning) || 0)),
      answer: Math.max(0, Math.round(Number(item.tokens?.answer) || 0)),
      output: Math.max(0, Math.round(Number(item.tokens?.output) || 0))
    },
    costsUsd: {
      input: Math.max(0, Number(item.costsUsd?.input) || 0),
      cacheHit: Math.max(0, Number(item.costsUsd?.cacheHit) || 0),
      reasoning: Math.max(0, Number(item.costsUsd?.reasoning) || 0),
      output: Math.max(0, Number(item.costsUsd?.output) || 0),
      total: Math.max(0, Number(item.costsUsd?.total) || 0)
    },
    costsCny: {
      input: Math.max(0, Number(item.costsCny?.input) || 0),
      cacheHit: Math.max(0, Number(item.costsCny?.cacheHit) || 0),
      reasoning: Math.max(0, Number(item.costsCny?.reasoning) || 0),
      output: Math.max(0, Number(item.costsCny?.output) || 0),
      total: Math.max(0, Number(item.costsCny?.total) || 0)
    },
    ratesUsdPerMillion: {
      cacheHit: Math.max(0, Number(item.ratesUsdPerMillion?.cacheHit) || 0),
      cacheMiss: Math.max(0, Number(item.ratesUsdPerMillion?.cacheMiss) || 0),
      output: Math.max(0, Number(item.ratesUsdPerMillion?.output) || 0)
    },
    ratesCnyPerMillion: {
      cacheHit: Math.max(0, Number(item.ratesCnyPerMillion?.cacheHit) || 0),
      cacheMiss: Math.max(0, Number(item.ratesCnyPerMillion?.cacheMiss) || 0),
      output: Math.max(0, Number(item.ratesCnyPerMillion?.output) || 0)
    },
    unitType: safeText(item.unitType, 40),
    units: Math.max(0, Number(item.units) || 0),
    costKnown: item.costKnown == null ? Boolean(Number(item.costCny)) : Boolean(item.costKnown),
    costCny: Math.max(0, Number(item.costCny) || 0),
    costSource: safeText(item.costSource, 160),
    rawUsage: numericUsage(item.rawUsage)
  })) : [];
  return { version: AI_USAGE_VERSION, trackingStartedAt, entries };
}

function deepSeekPricingPeriod(createdAt) {
  const date = new Date(createdAt), day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? "peak" : "offPeak";
}

function normalizedDeepSeekUsage(usage = {}) {
  usage = numericUsage(usage) || {};
  const input = Math.max(0, Math.round(Number(usage.prompt_tokens) || 0));
  const cacheHit = Math.max(0, Math.min(input, Math.round(Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0)));
  const cacheMiss = Math.max(0, Math.round(Number(usage.prompt_cache_miss_tokens) || (input - cacheHit)));
  const output = Math.max(0, Math.round(Number(usage.completion_tokens) || 0));
  const reasoning = Math.max(0, Math.min(output, Math.round(Number(usage.completion_tokens_details?.reasoning_tokens) || 0)));
  return { input, cacheHit, cacheMiss, reasoning, answer: Math.max(0, output - reasoning), output };
}

function numericUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return Object.fromEntries(Object.entries(usage).flatMap(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) return [[key, value]];
    const nested = value && typeof value === "object" ? numericUsage(value) : null;
    return nested ? [[key, nested]] : [];
  }));
}

export function deepSeekUsageEntry({ usage, model, createdAt, ...metadata }) {
  const usageKnown = Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
  const tokens = normalizedDeepSeekUsage(usageKnown ? usage : null);
  const pricingPeriod = deepSeekPricingPeriod(createdAt), rates = DEEPSEEK_PRICING.models[model]?.[pricingPeriod];
  const costsCny = {
    input: rates ? tokens.cacheMiss * rates.cacheMiss / DEEPSEEK_PRICING.unitTokens : 0,
    cacheHit: rates ? tokens.cacheHit * rates.cacheHit / DEEPSEEK_PRICING.unitTokens : 0,
    reasoning: rates ? tokens.reasoning * rates.output / DEEPSEEK_PRICING.unitTokens : 0,
    output: rates ? tokens.answer * rates.output / DEEPSEEK_PRICING.unitTokens : 0
  };
  costsCny.total = costsCny.input + costsCny.cacheHit + costsCny.reasoning + costsCny.output;
  return {
    ...metadata,
    id: metadata.callId,
    createdAt,
    provider: "deepseek",
    model,
    pricingPeriod,
    usageKnown,
    tokens,
    costKnown: Boolean(rates && usageKnown),
    costCny: costsCny.total,
    costsCny,
    costsUsd: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 },
    ratesCnyPerMillion: rates ? { ...rates } : { cacheHit: 0, cacheMiss: 0, output: 0 },
    ratesUsdPerMillion: { cacheHit: 0, cacheMiss: 0, output: 0 },
    costSource: rates ? `${DEEPSEEK_PRICING.source}#${DEEPSEEK_PRICING.checkedAt}` : "",
    rawUsage: numericUsage(usage)
  };
}

export function providerUsageEntry({
  provider,
  service,
  action,
  scene,
  model = "",
  unitType = "call",
  units = 1,
  costCny = 0,
  costKnown = false,
  createdAt,
  ...metadata
}) {
  return normalizeAiUsage({
    version: AI_USAGE_VERSION,
    trackingStartedAt: createdAt,
    entries: [{
      ...metadata,
      id: metadata.callId,
      callId: metadata.callId,
      provider,
      service,
      action,
      scene,
      model: model || `${provider}-${service}`,
      unitType,
      units,
      costCny,
      costKnown,
      createdAt,
      usageKnown: false,
      tokens: {},
      costsUsd: {},
      costsCny: {},
      ratesUsdPerMillion: {},
      ratesCnyPerMillion: {},
      rawUsage: { unitType, units }
    }]
  }).entries[0];
}

export function createAiUsageService({ repository, getAccountKey, dailyCallLimit, dailyCostLimitCny, cnyPerUsd, now = () => new Date().toISOString() }) {
  const reservations = new Map();
  return {
    read: repository.read,
    update: repository.update,
    ensure: () => repository.ensure(AI_USAGE_VERSION, original => Number(original.version || 1) < AI_USAGE_VERSION),
    async reserveAttempt({ estimatedCostCny = 0 } = {}) {
      const accountKey = getAccountKey();
      const usage = await repository.read(), day = now().slice(0, 10);
      const entries = usage.entries.filter(item => item.createdAt.slice(0, 10) === day);
      const reservationKey = `${accountKey}\u0000${day}`, active = reservations.get(reservationKey) || new Map();
      if (entries.length + active.size >= dailyCallLimit) {
        throw Object.assign(new Error("今日 AI 调用次数已达到上限，请明天再试"), { statusCode: 429, code: "AI_DAILY_CALL_LIMIT" });
      }
      const persistedCostCny = entries.reduce((sum, item) => (
        sum + (item.costKnown ? Number(item.costCny || 0) : Number(item.costsUsd?.total || 0) * cnyPerUsd)
      ), 0);
      const reservedCostCny = [...active.values()].reduce((sum, item) => sum + item.costCny, 0);
      const requestedCostCny = Math.max(0, Number(estimatedCostCny) || 0);
      if (Number.isFinite(dailyCostLimitCny) && persistedCostCny + reservedCostCny + requestedCostCny >= dailyCostLimitCny) {
        throw Object.assign(new Error("今日 AI 费用额度已达到上限，请明天再试"), { statusCode: 429, code: "AI_DAILY_COST_LIMIT" });
      }
      const id = crypto.randomUUID(), state = { costCny: requestedCostCny };
      if (!reservations.has(reservationKey)) reservations.set(reservationKey, active);
      active.set(id, state);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        const current = reservations.get(reservationKey);
        current?.delete(id);
        if (!current?.size) reservations.delete(reservationKey);
      };
      const reservation = () => settle();
      reservation.release = settle;
      reservation.commit = settle;
      reservation.retain = entry => {
        if (settled) return;
        state.costCny = entry?.costKnown
          ? Math.max(0, Number(entry.costCny) || 0)
          : Math.max(0, Number(entry?.costsUsd?.total) || 0) * cnyPerUsd;
      };
      return reservation;
    }
  };
}
