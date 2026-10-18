import { safeIso, numberOrFallback } from "../../shared/validation/index.mjs";
import {
  dateKeyInTimezone,
  localDateKey,
  shiftDateKey
} from "../../shared/time/index.mjs";
import { LLM_MODELS, LLM_SCENARIOS, normalizeLlmSettings, llmSettingsForScene } from "./settings.mjs";
import { DEEPSEEK_PRICING } from "./usage.mjs";
import { OFFICIAL_PROVIDER_PRICING } from "./provider-pricing.mjs";

const AI_COST_PLAN_VERSION = 1;
const AI_PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  volcengine: "火山引擎",
  aliyun: "阿里云"
};
const AI_SERVICE_DEFINITIONS = [
  { key: "deepseekText", provider: "deepseek", service: "text", label: "DeepSeek 文本" },
  { key: "deepseekVision", provider: "deepseek", service: "vision", label: "DeepSeek 图片理解" },
  { key: "volcengineTts", provider: "volcengine", service: "speech", label: "豆包语音合成" },
  { key: "volcengineAsr", provider: "volcengine", service: "speech", label: "豆包语音识别" },
  { key: "volcengineOcr", provider: "volcengine", service: "vision", label: "火山文字识别" },
  { key: "volcengineDocument", provider: "volcengine", service: "vision", label: "火山文档解析" },
  { key: "aliyunSegmentation", provider: "aliyun", service: "segmentation", label: "阿里云图片分割" }
];
const AI_COST_SCENARIO_DEFAULTS = {
  thoughtPrompt: { callsPerMonth: 20, avgInputTokens: 4000, cacheHitPct: 20, avgReasoningTokens: 0, avgAnswerTokens: 120 },
  thoughtDraft: { callsPerMonth: 15, avgInputTokens: 12000, cacheHitPct: 20, avgReasoningTokens: 2500, avgAnswerTokens: 1200 },
  thoughtAnswer: { callsPerMonth: 20, avgInputTokens: 24000, cacheHitPct: 25, avgReasoningTokens: 6000, avgAnswerTokens: 2500 },
  followUpAnswer: { callsPerMonth: 8, avgInputTokens: 18000, cacheHitPct: 25, avgReasoningTokens: 4000, avgAnswerTokens: 1800 },
  chat: { callsPerMonth: 15, avgInputTokens: 16000, cacheHitPct: 25, avgReasoningTokens: 3000, avgAnswerTokens: 1600 },
  diaryLead: { callsPerMonth: 12, avgInputTokens: 8000, cacheHitPct: 30, avgReasoningTokens: 0, avgAnswerTokens: 180 },
  diaryStructure: { callsPerMonth: 8, avgInputTokens: 10000, cacheHitPct: 30, avgReasoningTokens: 1200, avgAnswerTokens: 700 },
  diaryTopic: { callsPerMonth: 8, avgInputTokens: 10000, cacheHitPct: 30, avgReasoningTokens: 1800, avgAnswerTokens: 500 },
  diaryReflection: { callsPerMonth: 6, avgInputTokens: 22000, cacheHitPct: 25, avgReasoningTokens: 5000, avgAnswerTokens: 2200 },
  annotationShenji: { callsPerMonth: 15, avgInputTokens: 10000, cacheHitPct: 25, avgReasoningTokens: 2200, avgAnswerTokens: 1000 },
  analysis: { callsPerMonth: 4, avgInputTokens: 30000, cacheHitPct: 20, avgReasoningTokens: 8000, avgAnswerTokens: 3500 },
  bookRecognition: { callsPerMonth: 3, avgInputTokens: 5000, cacheHitPct: 0, avgReasoningTokens: 600, avgAnswerTokens: 400 },
  healthRecognition: { callsPerMonth: 8, avgInputTokens: 6000, cacheHitPct: 0, avgReasoningTokens: 800, avgAnswerTokens: 500 },
  contentImageUnderstanding: { callsPerMonth: 10, avgInputTokens: 6000, cacheHitPct: 0, avgReasoningTokens: 800, avgAnswerTokens: 700 },
  capturePolish: { callsPerMonth: 20, avgInputTokens: 1200, cacheHitPct: 0, avgReasoningTokens: 100, avgAnswerTokens: 600 },
  onboardingClaimExtraction: { callsPerMonth: 1, avgInputTokens: 5000, cacheHitPct: 0, avgReasoningTokens: 800, avgAnswerTokens: 1800 },
  perceptionExtraction: { callsPerMonth: 100, avgInputTokens: 3000, cacheHitPct: 0, avgReasoningTokens: 0, avgAnswerTokens: 500 },
  importanceScoring: { callsPerMonth: 0, avgInputTokens: 16000, cacheHitPct: 0, avgReasoningTokens: 0, avgAnswerTokens: 1500 },
  recordCompression: { callsPerMonth: 14, avgInputTokens: 12000, cacheHitPct: 0, avgReasoningTokens: 0, avgAnswerTokens: 900 }
};

const usageDateKey = (value, timezone) => timezone
  ? dateKeyInTimezone(value, timezone)
  : localDateKey(value);

export function defaultAiCostPlan(
  settings,
  usage,
  { date = localDateKey(), cnyPerUsd, timezone } = {}
) {
  const normalizedSettings = normalizeLlmSettings(settings);
  const from = shiftDateKey(date, -29);
  const recentEntries = (usage?.entries || []).filter(item => (
    usageDateKey(item.createdAt, timezone) >= from
  ));
  return {
    version: AI_COST_PLAN_VERSION,
    updatedAt: "",
    monthlyBudgetCny: 30,
    contingencyPct: 15,
    cnyPerUsd,
    scenarios: LLM_SCENARIOS.map(scene => {
      const fallback = AI_COST_SCENARIO_DEFAULTS[scene];
      const entries = recentEntries.filter(item => item.scene === scene);
      const known = entries.filter(item => item.usageKnown);
      const total = known.reduce((sum, item) => {
        sum.input += Number(item.tokens?.input) || 0;
        sum.cacheHit += Number(item.tokens?.cacheHit) || 0;
        sum.reasoning += Number(item.tokens?.reasoning) || 0;
        sum.answer += Number(item.tokens?.answer) || 0;
        return sum;
      }, { input: 0, cacheHit: 0, reasoning: 0, answer: 0 });
      const modelCounts = new Map();
      for (const item of entries) modelCounts.set(item.model, (modelCounts.get(item.model) || 0) + 1);
      const observedModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        scene,
        enabled: true,
        model: observedModel || llmSettingsForScene(normalizedSettings, scene).model,
        pricingPeriod: "peak",
        callsPerMonth: entries.length || fallback.callsPerMonth,
        avgInputTokens: known.length ? Math.round(total.input / known.length) : fallback.avgInputTokens,
        cacheHitPct: total.input ? Math.round(total.cacheHit / total.input * 1000) / 10 : fallback.cacheHitPct,
        avgReasoningTokens: known.length ? Math.round(total.reasoning / known.length) : fallback.avgReasoningTokens,
        avgAnswerTokens: known.length ? Math.round(total.answer / known.length) : fallback.avgAnswerTokens
      };
    })
  };
}

export function normalizeAiCostPlan(value, settings, usage, options) {
  const fallback = defaultAiCostPlan(settings, usage, options);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const supplied = new Map((Array.isArray(source.scenarios) ? source.scenarios : []).map(item => [item?.scene, item]));
  return {
    version: AI_COST_PLAN_VERSION,
    updatedAt: safeIso(source.updatedAt),
    monthlyBudgetCny: numberOrFallback(source.monthlyBudgetCny, fallback.monthlyBudgetCny, 0, 10_000_000),
    contingencyPct: numberOrFallback(source.contingencyPct, fallback.contingencyPct, 0, 500),
    cnyPerUsd: numberOrFallback(source.cnyPerUsd, fallback.cnyPerUsd, 0.01, 1000),
    scenarios: fallback.scenarios.map(defaultRow => {
      const row = supplied.get(defaultRow.scene) || {};
      return {
        scene: defaultRow.scene,
        enabled: row.enabled == null ? defaultRow.enabled : Boolean(row.enabled),
        model: LLM_MODELS.includes(row.model) ? row.model : defaultRow.model,
        pricingPeriod: row.pricingPeriod === "offPeak" ? "offPeak" : "peak",
        callsPerMonth: numberOrFallback(row.callsPerMonth, defaultRow.callsPerMonth, 0, 10_000_000),
        avgInputTokens: numberOrFallback(row.avgInputTokens, defaultRow.avgInputTokens, 0, 5_000_000, true),
        cacheHitPct: numberOrFallback(row.cacheHitPct, defaultRow.cacheHitPct, 0, 100),
        avgReasoningTokens: numberOrFallback(row.avgReasoningTokens, defaultRow.avgReasoningTokens, 0, 1_000_000, true),
        avgAnswerTokens: numberOrFallback(row.avgAnswerTokens, defaultRow.avgAnswerTokens, 0, 1_000_000, true)
      };
    })
  };
}

export function createAiCostService({
  repository,
  readSettings,
  readUsage,
  cnyPerUsd,
  now = () => new Date().toISOString(),
  getTimezone = () => undefined
}) {
  const normalize = async value => {
    const timezone = getTimezone();
    const date = usageDateKey(now(), timezone);
    const [settings, usage] = await Promise.all([
      readSettings(),
      readUsage({
        from: shiftDateKey(date, -29),
        to: date,
        ...(timezone ? { timezone } : {})
      })
    ]);
    return normalizeAiCostPlan(value, settings, usage, {
      date,
      cnyPerUsd,
      timezone
    });
  };
  return {
    normalize,
    read: async () => normalize(await repository.read()),
    async save(input) {
      const plan = await normalize({ ...input, updatedAt: now() });
      await repository.write(plan, normalize);
      return plan;
    },
    dashboard: (
      usage,
      from,
      to,
      rate = cnyPerUsd,
      timezone = getTimezone()
    ) => usageDashboard(usage, from, to, rate, cnyPerUsd, timezone)
  };
}

function blankUsageAggregate() {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    unknownStatusCalls: 0,
    usageUnknownCalls: 0,
    durationMs: 0,
    durationKnownCalls: 0,
    maxDurationMs: 0,
    visionCalls: 0,
    imageCount: 0,
    imageBytes: 0,
    costUnknownCalls: 0,
    costCny: 0,
    tokens: { input: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0, answer: 0, output: 0 },
    costsCny: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 },
    costsUsd: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 }
  };
}

function addUsageAggregate(target, entry) {
  target.calls += 1;
  if (entry.status === "success") target.successfulCalls += 1;
  else if (entry.status === "unknown") target.unknownStatusCalls += 1;
  else target.failedCalls += 1;
  if (!entry.usageKnown) target.usageUnknownCalls += 1;
  if (entry.provider !== "deepseek" && !entry.costKnown) target.costUnknownCalls += 1;
  if (entry.durationKnown) {
    target.durationMs += Number(entry.durationMs) || 0;
    target.durationKnownCalls += 1;
    target.maxDurationMs = Math.max(target.maxDurationMs, Number(entry.durationMs) || 0);
  }
  if (entry.modality === "vision") target.visionCalls += 1;
  target.imageCount += Number(entry.imageCount) || 0;
  target.imageBytes += Number(entry.imageBytes) || 0;
  target.costCny += Number(entry.costCny) || 0;
  for (const key of Object.keys(target.tokens)) target.tokens[key] += Number(entry.tokens?.[key]) || 0;
  for (const key of Object.keys(target.costsCny)) target.costsCny[key] += Number(entry.costsCny?.[key]) || 0;
  for (const key of Object.keys(target.costsUsd)) target.costsUsd[key] += Number(entry.costsUsd?.[key]) || 0;
  return target;
}

function usageServiceKey(entry) {
  const provider = entry.provider || "deepseek";
  if (provider === "deepseek") return entry.modality === "vision" ? "deepseekVision" : "deepseekText";
  if (provider === "volcengine" && entry.service === "speech") {
    return entry.action === "streamingAsr" || entry.action === "fileAsr" || entry.scene === "speechRecognition"
      ? "volcengineAsr"
      : "volcengineTts";
  }
  if (provider === "volcengine" && entry.service === "vision") {
    return entry.action === "OCRPdf" || entry.scene === "documentParsing"
      ? "volcengineDocument"
      : "volcengineOcr";
  }
  if (provider === "aliyun" && entry.service === "segmentation") return "aliyunSegmentation";
  return `${provider}:${entry.service || "other"}`;
}

function serviceUnitUsage(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const unitType = (entry.provider || "deepseek") === "deepseek" ? "token" : entry.unitType || "call";
    const units = unitType === "token"
      ? (Number(entry.tokens?.input) || 0) + (Number(entry.tokens?.output) || 0)
      : Number(entry.units) || 0;
    totals.set(unitType, (totals.get(unitType) || 0) + units);
  }
  const order = ["token", "character", "audioMillisecond", "page", "image", "document", "call"];
  return [...totals.entries()]
    .map(([unitType, units]) => ({ unitType, units }))
    .filter(item => item.units > 0)
    .sort((a, b) => {
      const left = order.indexOf(a.unitType), right = order.indexOf(b.unitType);
      return (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
        || a.unitType.localeCompare(b.unitType);
    });
}

function serviceAggregate(entries) {
  return {
    ...entries.reduce(addUsageAggregate, blankUsageAggregate()),
    unitUsage: serviceUnitUsage(entries)
  };
}

export function usageDashboard(
  usage,
  from,
  to,
  cnyPerUsd,
  defaultCnyPerUsd = cnyPerUsd,
  timezone
) {
  const dayCount = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => shiftDateKey(from, index));
  const entries = usage.entries.filter(item => {
    const date = usageDateKey(item.createdAt, timezone);
    return date >= from && date <= to;
  });
  const extraServices = [...new Set(entries.map(usageServiceKey))]
    .filter(key => !AI_SERVICE_DEFINITIONS.some(item => item.key === key))
    .map(key => {
      const entry = entries.find(item => usageServiceKey(item) === key);
      const provider = entry?.provider || "unknown", service = entry?.service || "other";
      return {
        key,
        provider,
        service,
        label: `${AI_PROVIDER_LABELS[provider] || provider} · ${service}`
      };
    });
  const serviceDefinitions = [...AI_SERVICE_DEFINITIONS, ...extraServices];
  const summary = entries.reduce(addUsageAggregate, blankUsageAggregate());
  const daily = days.map(date => {
    const matching = entries.filter(item => usageDateKey(item.createdAt, timezone) === date);
    const models = Object.fromEntries(LLM_MODELS.map(model => [model, matching.filter(item => item.model === model).reduce(addUsageAggregate, blankUsageAggregate())]));
    const services = Object.fromEntries(serviceDefinitions.map(service => [
      service.key,
      serviceAggregate(matching.filter(item => usageServiceKey(item) === service.key))
    ]));
    return { date, ...matching.reduce(addUsageAggregate, blankUsageAggregate()), models, services };
  });
  const models = LLM_MODELS.map(model => ({
    model,
    label: DEEPSEEK_PRICING.models[model].label,
    ...entries.filter(item => item.model === model).reduce(addUsageAggregate, blankUsageAggregate())
  }));
  const providers = [...new Set(entries.map(item => item.provider || "deepseek"))].map(provider => ({
    provider,
    label: AI_PROVIDER_LABELS[provider] || provider,
    ...entries.filter(item => (item.provider || "deepseek") === provider).reduce(addUsageAggregate, blankUsageAggregate())
  })).sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
  const services = serviceDefinitions.map(service => ({
    ...service,
    ...serviceAggregate(entries.filter(item => usageServiceKey(item) === service.key))
  }));
  const scenes = [...new Set(entries.map(item => item.scene))].map(scene => {
    const aggregate = entries.filter(item => item.scene === scene).reduce(addUsageAggregate, blankUsageAggregate());
    return { scene, ...aggregate };
  }).sort((a, b) => b.calls - a.calls || a.scene.localeCompare(b.scene));
  const modalityLabels = { text: "纯文本", vision: "图片理解", audio: "语音", document: "文档", unknown: "历史未知" };
  const modalities = ["text", "vision", "audio", "document", "unknown"]
    .filter(modality => ["text", "vision"].includes(modality) || entries.some(item => item.modality === modality))
    .map(modality => ({
    modality,
    label: modalityLabels[modality],
    ...entries.filter(item => item.modality === modality).reduce(addUsageAggregate, blankUsageAggregate())
  }));
  const rate = Math.max(0.01, Number(cnyPerUsd) || defaultCnyPerUsd);
  const sortedCostsCny = entries.map(item => (
    (Number(item.costsUsd?.total) || 0) * rate + (Number(item.costCny) || 0)
  )).sort((a, b) => a - b);
  const percentile = proportion => sortedCostsCny.length ? sortedCostsCny[Math.min(sortedCostsCny.length - 1, Math.ceil(sortedCostsCny.length * proportion) - 1)] : 0;
  const activeDays = new Set(entries.map(item => localDateKey(item.createdAt)).filter(Boolean)).size;
  return {
    from, to, trackingStartedAt: usage.trackingStartedAt, summary, daily, models, providers, services, scenes, modalities,
    calibration: {
      activeDays,
      averageCallsPerActiveDay: activeDays ? entries.length / activeDays : 0,
      averageInputTokens: entries.length ? summary.tokens.input / entries.length : 0,
      maxInputTokens: entries.reduce((maximum, item) => Math.max(maximum, Number(item.tokens?.input) || 0), 0),
      averageRequestChars: entries.length ? entries.reduce((sum, item) => sum + (Number(item.requestChars) || 0), 0) / entries.length : 0,
      maxRequestChars: entries.reduce((maximum, item) => Math.max(maximum, Number(item.requestChars) || 0), 0),
      medianCostCny: percentile(0.5),
      p90CostCny: percentile(0.9),
      maxCostCny: percentile(1)
    },
    pricing: {
      ...DEEPSEEK_PRICING,
      displayCurrency: "CNY",
      cnyPerUsd: rate,
      providerRates: [
        {
          key: "volcengineTts",
          label: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedTts2.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedTts2.price,
          unitLabel: "万字符",
          source: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.source,
          checkedAt: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.checkedAt
        },
        {
          key: "volcengineAsr",
          label: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedAsr2Streaming.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedAsr2Streaming.price,
          unitLabel: "音频小时",
          source: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.source,
          checkedAt: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.checkedAt
        },
        {
          key: "volcengineFileAsr",
          label: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedAsr2File.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services.seedAsr2File.price,
          unitLabel: "音频小时",
          source: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.source,
          checkedAt: OFFICIAL_PROVIDER_PRICING.volcengineSpeech.checkedAt
        },
        {
          key: "volcengineOcr",
          label: OFFICIAL_PROVIDER_PRICING.volcengineVision.services.ocrNormalFirstTier.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.volcengineVision.services.ocrNormalFirstTier.price,
          unitLabel: "次",
          source: OFFICIAL_PROVIDER_PRICING.volcengineVision.sources.ocr,
          checkedAt: OFFICIAL_PROVIDER_PRICING.volcengineVision.checkedAt
        },
        {
          key: "volcengineDocument",
          label: OFFICIAL_PROVIDER_PRICING.volcengineVision.services.intelligentDocumentParsing.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.volcengineVision.services.intelligentDocumentParsing.price,
          unitLabel: "页",
          source: OFFICIAL_PROVIDER_PRICING.volcengineVision.sources.document,
          checkedAt: OFFICIAL_PROVIDER_PRICING.volcengineVision.checkedAt
        },
        {
          key: "aliyunSegmentation",
          label: OFFICIAL_PROVIDER_PRICING.aliyunSegmentation.services.segmentHdCommonImage.label,
          priceCny: OFFICIAL_PROVIDER_PRICING.aliyunSegmentation.services.segmentHdCommonImage.price,
          unitLabel: "次",
          source: OFFICIAL_PROVIDER_PRICING.aliyunSegmentation.source,
          checkedAt: OFFICIAL_PROVIDER_PRICING.aliyunSegmentation.checkedAt
        }
      ],
      historicalUsdNote: "人民币换算系数仅用于 2026-10-02 前已经固化为美元的历史账本。",
      estimateNote: "新调用按请求发生时固化的官方目录价估算；阿里云分割结果轮询和下载不重复计费。实际账单仍可能受套餐、阶梯价、免费额度与合同折扣影响。中国法定节假日若落在 DeepSeek 工作日峰值时段，实际账单可能更低。"
    }
  };
}
