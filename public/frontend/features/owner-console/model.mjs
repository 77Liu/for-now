export const OWNER_CONSOLE_VIEWS = Object.freeze([
  "ai-cost",
  "architecture",
  "commercialization"
]);

export const OWNER_CONSOLE_CAPABILITIES = Object.freeze({
  "ai-cost": "ai-costs",
  architecture: "architecture",
  commercialization: "commercialization"
});

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
  capturePolish: "mid",
  recordCompression: "lite",
  importanceScoring: "lite"
});

export const DEFAULT_SCENE_EFFORTS = Object.freeze({
  ...Object.fromEntries(Object.entries(DEFAULT_LLM_SCENARIOS)
    .map(([scene, tier]) => [scene, DEFAULT_LLM_PROFILES[tier].effort])),
  onboardingClaimExtraction: "high"
});

export const DEFAULT_SCENE_LABELS = Object.freeze({
  thoughtPrompt: "思考引子",
  thoughtDraft: "思考草稿",
  thoughtAnswer: "思考回答",
  followUpAnswer: "追问回答",
  chat: "长期对话",
  diaryLead: "日记引子",
  diaryStructure: "日记结构",
  diaryTopic: "日记话题",
  diaryReflection: "日记回望",
  annotationShenji: "批注神鸡",
  analysis: "认知复盘",
  bookRecognition: "书目识别",
  healthRecognition: "健康识别",
  contentImageUnderstanding: "内容图片理解",
  capturePolish: "语音整理",
  recordCompression: "日记录压缩",
  importanceScoring: "材料重要性评分",
  lite: "连接测试",
  mid: "连接测试",
  high: "连接测试",
  ultra: "连接测试"
});

const CRITICAL_SCENES = new Set([
  "thoughtAnswer",
  "followUpAnswer",
  "diaryReflection",
  "analysis"
]);

export function copyOwnerValue(value) {
  if (Array.isArray(value)) return value.map(copyOwnerValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyOwnerValue(item)])
  );
}

const number = value => Number(value) || 0;
const nonNegative = value => Math.max(0, number(value));

export function currentAiCostModel(settings = {}, scene) {
  const profiles = { ...DEFAULT_LLM_PROFILES, ...(settings.profiles || {}) };
  const scenarios = { ...DEFAULT_LLM_SCENARIOS, ...(settings.scenarios || {}) };
  const efforts = { ...DEFAULT_SCENE_EFFORTS, ...(settings.sceneEfforts || {}) };
  const tier = scenarios[scene] || DEFAULT_LLM_SCENARIOS[scene] || "high";
  const profile = profiles[tier] || DEFAULT_LLM_PROFILES[tier] || DEFAULT_LLM_PROFILES.high;
  return Object.freeze({
    tier,
    model: profile.model,
    effort: efforts[scene] || profile.effort,
    label: `${profile.model === "deepseek-v4-pro" ? "Pro" : "Flash"} · ${tier[0].toUpperCase()}${tier.slice(1)}`
  });
}

export function estimateAiCostScenario(row = {}, pricing = {}, model = row.model) {
  const rates = pricing.models?.[model]?.[row.pricingPeriod];
  if (!rates) return Object.freeze({ total: 0, input: 0, output: 0, perCall: 0 });
  const calls = row.enabled ? nonNegative(row.callsPerMonth) : 0;
  const input = nonNegative(row.avgInputTokens);
  const hit = input * Math.max(0, Math.min(100, number(row.cacheHitPct))) / 100;
  const miss = input - hit;
  const output = nonNegative(row.avgReasoningTokens) + nonNegative(row.avgAnswerTokens);
  const unit = number(pricing.unitTokens) || 1e6;
  const inputCost = (hit * number(rates.cacheHit) + miss * number(rates.cacheMiss)) / unit;
  const outputCost = output * number(rates.output) / unit;
  const perCall = inputCost + outputCost;
  return Object.freeze({
    total: perCall * calls,
    input: inputCost * calls,
    output: outputCost * calls,
    perCall
  });
}

export function updateAiCostPlan(plan = {}, values = {}) {
  const next = copyOwnerValue(plan);
  next.monthlyBudgetCny = number(values.monthlyBudgetCny);
  next.contingencyPct = number(values.contingencyPct);
  next.cnyPerUsd = number(values.cnyPerUsd);
  const scenarios = values.scenarios instanceof Map ? values.scenarios : new Map();
  next.scenarios = (next.scenarios || []).map(row => ({
    ...row,
    ...(scenarios.get(row.scene) || {})
  }));
  return next;
}

export function calibrateAiCostPlan(plan = {}, statistics = {}, settings = {}) {
  const next = copyOwnerValue(plan);
  const observed = new Map((statistics.ai?.scenes || []).map(item => [item.scene, item]));
  next.scenarios = (next.scenarios || []).map(row => {
    const sample = observed.get(row.scene);
    const calls = number(sample?.calls);
    const current = currentAiCostModel(settings, row.scene);
    if (!calls) return { ...row, enabled: false, model: current.model, callsPerMonth: 0 };
    const input = number(sample.tokens?.input);
    return {
      ...row,
      enabled: true,
      model: current.model,
      callsPerMonth: calls,
      avgInputTokens: Math.round(input / calls),
      cacheHitPct: input
        ? Math.round(number(sample.tokens?.cacheHit) / input * 1000) / 10
        : 0,
      avgReasoningTokens: Math.round(number(sample.tokens?.reasoning) / calls),
      avgAnswerTokens: Math.round(number(sample.tokens?.answer) / calls)
    };
  });
  return next;
}

function recommendationModels(rows, projected, budget) {
  const recommendations = [];
  const enabled = rows.filter(item => item.row.enabled)
    .sort((left, right) => right.estimate.total - left.estimate.total);
  const base = enabled.reduce((sum, item) => sum + item.estimate.total, 0);
  const top = enabled[0];
  if (budget > 0 && projected > budget) {
    recommendations.push({
      kind: "budget-over",
      amount: projected - budget,
      percent: projected ? (projected - budget) / projected * 100 : 0
    });
  } else if (budget > 0) {
    recommendations.push({ kind: "budget-room", amount: budget - projected });
  }
  if (top) {
    recommendations.push({
      kind: "top",
      scene: top.row.scene,
      total: top.estimate.total,
      percent: base ? top.estimate.total / base * 100 : 0
    });
  }
  const downgrade = enabled
    .filter(item => item.row.model === "deepseek-v4-pro" && !CRITICAL_SCENES.has(item.row.scene))
    .map(item => ({
      item,
      saving: item.estimate.total
        - estimateAiCostScenario(item.row, item.pricing, "deepseek-flash").total
    }))
    .sort((left, right) => right.saving - left.saving)[0];
  if (downgrade?.saving > 0.01) {
    recommendations.push({
      kind: "downgrade",
      scene: downgrade.item.row.scene,
      saving: downgrade.saving
    });
  }
  const longContext = enabled
    .filter(item => number(item.row.avgInputTokens) >= 20000)
    .sort((left, right) => number(right.row.avgInputTokens) - number(left.row.avgInputTokens))[0];
  if (longContext) {
    recommendations.push({
      kind: "long-context",
      scene: longContext.row.scene,
      tokens: number(longContext.row.avgInputTokens)
    });
  }
  const cacheCandidate = enabled
    .filter(item => number(item.row.avgInputTokens) >= 8000 && number(item.row.cacheHitPct) < 20)
    .sort((left, right) => number(right.row.avgInputTokens) - number(left.row.avgInputTokens))[0];
  if (cacheCandidate) {
    recommendations.push({
      kind: "cache",
      scene: cacheCandidate.row.scene,
      percent: number(cacheCandidate.row.cacheHitPct)
    });
  }
  return recommendations.slice(0, 5);
}

export function aiCostProjection(plan = {}, statistics = {}) {
  const pricing = statistics.ai?.pricing || {};
  const rows = (plan.scenarios || []).map(row => ({
    row,
    pricing,
    estimate: estimateAiCostScenario(row, pricing)
  }));
  const base = rows.reduce((sum, item) => sum + item.estimate.total, 0);
  const reserve = base * number(plan.contingencyPct) / 100;
  const projected = base + reserve;
  const budget = number(plan.monthlyBudgetCny);
  const cnyPerUsd = number(plan.cnyPerUsd) || 7.2;
  const summary = statistics.ai?.summary || {};
  const observed = number(summary.costsUsd?.total) * cnyPerUsd + number(summary.costCny);
  return Object.freeze({
    rows,
    base,
    reserve,
    projected,
    budget,
    observed,
    difference: budget - projected,
    cnyPerUsd,
    recommendations: recommendationModels(rows, projected, budget)
  });
}

export function aiBudgetProjection(status = {}) {
  const day = status.day || {};
  const month = status.month || {};
  const dayUsed = number(day.committedKnownCostCny);
  const dayReserved = number(day.reservedKnownCostCny);
  const monthUsed = number(month.committedKnownCostCny);
  const monthReserved = number(month.reservedKnownCostCny);
  const unknownUsed = number(day.committedUnknownCalls);
  const unknownReserved = number(day.reservedUnknownCalls);
  return Object.freeze({
    period: `${day.key || "今日"} UTC · ${month.key || "本月"}`,
    rows: Object.freeze([
      {
        label: "今日已知费用",
        value: dayUsed + dayReserved,
        limit: number(day.effectiveKnownCostLimitCny),
        note: [dayUsed, dayReserved],
        blocked: Boolean(day.blocked?.knownCost)
      },
      {
        label: "本月已知费用",
        value: monthUsed + monthReserved,
        limit: number(month.effectiveKnownCostLimitCny),
        note: [monthUsed, monthReserved],
        blocked: Boolean(month.blocked?.knownCost)
      },
      {
        label: "未知费用调用",
        value: unknownUsed + unknownReserved,
        limit: number(day.unknownCallLimit),
        note: [unknownUsed, unknownReserved],
        unknown: true,
        blocked: Boolean(day.blocked?.unknownCost)
      },
      {
        label: "在途任务",
        value: number(status.activeReservations),
        note: number(status.controlVersion) || 1,
        reservations: true,
        blocked: false
      }
    ])
  });
}

export function architectureProjection(surface = {}, stageIndex = 0, termKey = "") {
  const stages = Array.isArray(surface.stages) ? surface.stages : [];
  const index = Math.max(0, Math.min(Math.max(0, stages.length - 1), number(stageIndex)));
  const terms = Array.isArray(surface.terms) ? surface.terms : [];
  const term = terms.find(item => item.key === termKey) || terms[0] || null;
  return Object.freeze({
    stageIndex: index,
    stage: stages[index] || stages[0] || null,
    terms,
    term,
    termKey: term?.key || ""
  });
}

export function commercialAssumptionsFromValues(fallback, fields = [], profiles = []) {
  if (!fallback) return null;
  const result = copyOwnerValue(fallback);
  result.stageByModel ||= {};
  result.stagePresets ||= {};
  for (const [path, rawValue] of fields) {
    const [group, key] = String(path || "").split(".");
    const value = Number(rawValue);
    if (!group || !key || !Number.isFinite(value)) continue;
    result[group] ||= {};
    result[group][key] = value;
    if (!Object.hasOwn(result.stageByModel, group)) continue;
    const presets = result.stagePresets[group] || [];
    const index = Math.max(0, Math.min(Math.max(0, presets.length - 1), number(result.stageByModel[group])));
    result.stagePresets[group] ||= [];
    result.stagePresets[group][index] ||= {};
    result.stagePresets[group][index][key] = value;
  }
  for (const [path, rawValue] of profiles) {
    const [profile, key] = String(path || "").split(".");
    const value = Number(rawValue);
    if (!profile || !key || !Number.isFinite(value)) continue;
    result.usageProfiles ||= {};
    result.usageProfiles[profile] ||= {};
    result.usageProfiles[profile][key] = value;
  }
  return result;
}

export function applyCommercialStagePreset(assumptions, mode, rawIndex) {
  if (!assumptions) return null;
  const next = copyOwnerValue(assumptions);
  const presets = next.stagePresets?.[mode] || [];
  const index = Math.max(0, Math.min(Math.max(0, presets.length - 1), number(rawIndex)));
  next.stageByModel ||= {};
  next.stageByModel[mode] = index;
  next[mode] = copyOwnerValue(presets[index] || next[mode] || {});
  return next;
}
