import {
  chartFrame,
  compactNumber,
  formatCny,
  formatCnyAxis,
  formatDuration,
  stackedTokenChart
} from "./charts.mjs";

const SCENE_LABELS = Object.freeze({
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
  lite: "连接测试",
  mid: "连接测试",
  high: "连接测试",
  ultra: "连接测试"
});

const SERVICE_COLORS = Object.freeze({
  deepseekText: "#4f8d78",
  deepseekVision: "#3f7f91",
  volcengineTts: "#a65f4b",
  volcengineAsr: "#b77f48",
  volcengineOcr: "#5c7891",
  volcengineDocument: "#77658c",
  aliyunSegmentation: "#c18c3f"
});
const FALLBACK_SERVICE_COLORS = ["#547d87", "#9a7052", "#6f7651"];
const OUTPUT_SELECTORS = Object.freeze([
  "#record-total",
  "#record-stat-sections",
  "#ai-tracking-since",
  "#ai-kpis",
  "#ai-calls-chart",
  "#ai-service-summary",
  "#ai-token-chart",
  "#ai-modality-summary",
  "#ai-cost-charts",
  "#ai-scenario-bars",
  "#ai-model-summary",
  "#ai-pricing"
]);

const query = (root, selector) => root?.querySelector?.(selector) || null;
const list = value => Array.isArray(value) ? value : [];
const markup = (root, selector, value) => {
  const target = query(root, selector);
  if (target) target.innerHTML = value;
};

export function shiftLocalDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function setStatisticsRange(root, currentDate, days = 7) {
  const to = query(root, "#statistics-to");
  const from = query(root, "#statistics-from");
  if (to) to.value = currentDate;
  if (from) from.value = shiftLocalDateKey(currentDate, 1 - days);
  for (const button of root?.querySelectorAll?.("[data-statistics-days]") || []) {
    button.classList?.toggle(
      "active",
      Number(button.dataset.statisticsDays) === Number(days)
    );
  }
}

function serviceUnitText(item) {
  return list(item?.unitUsage).map(unit => {
    if (unit.unitType === "token") return `${compactNumber(unit.units)} Token`;
    if (unit.unitType === "character") return `${compactNumber(unit.units)} 字符`;
    if (unit.unitType === "audioMillisecond") return formatDuration(unit.units);
    if (unit.unitType === "page") return `${compactNumber(unit.units)} 页`;
    if (unit.unitType === "image") return `${compactNumber(unit.units)} 张`;
    if (unit.unitType === "document") return `${compactNumber(unit.units)} 份`;
    if (unit.unitType === "call") return `${compactNumber(unit.units)} 次 API 调用`;
    return `${compactNumber(unit.units)} ${unit.unitType}`;
  }).join(" · ") || "—";
}

export function renderStatisticsPresentation({
  root,
  data,
  view
} = {}) {
  const escape = view.escapeMarkup;
  const records = data?.records || { total: 0, groups: [] };
  markup(root, "#record-total", `<strong>${records.total || 0}</strong><span>累计条目</span>`);
  markup(root, "#record-stat-sections", list(records.groups).map(group => (
    `<section class="record-stat-section"><header><h3>${escape(
      group.label
    )}</h3><span>${group.total} 项</span></header><div class="record-module-list">${list(
      group.modules
    ).map(module => (
      `<article><div class="record-module-title"><b>${escape(
        module.label
      )}</b><strong>${module.total}</strong></div><dl>${list(module.items).map(item => (
        `<div><dt>${escape(item.label)}</dt><dd>${item.count}</dd></div>`
      )).join("")}</dl></article>`
    )).join("")}</div></section>`
  )).join(""));
  const title = query(root, "#statistics-page-title");
  if (title) title.textContent = data?.ai
    ? "留下了什么，也看见如何使用 AI"
    : "留下了什么";
  const ai = data?.ai;
  if (!ai) {
    for (const selector of OUTPUT_SELECTORS.slice(2)) markup(root, selector, "");
    return true;
  }

  const summary = ai.summary || {};
  const tokens = summary.tokens || {};
  const pricing = ai.pricing || {};
  const daily = list(ai.daily);
  const cnyPerUsd = Math.max(0.01, Number(pricing.cnyPerUsd) || 7.2);
  const historicalUsdToCny = value => (Number(value) || 0) * cnyPerUsd;
  const totalCost = item => historicalUsdToCny(item?.costsUsd?.total)
    + (Number(item?.costCny) || 0);
  const componentCost = (item, key) => (
    (Number(item?.costsCny?.[key]) || 0)
    + historicalUsdToCny(item?.costsUsd?.[key])
  );
  const totalTokens = (tokens.input || 0) + (tokens.output || 0);
  const cacheRate = tokens.input ? (tokens.cacheHit || 0) / tokens.input * 100 : 0;
  const totalCostCny = totalCost(summary);
  const averageCost = summary.calls ? totalCostCny / summary.calls : 0;
  const knownStatuses = (summary.successfulCalls || 0) + (summary.failedCalls || 0);
  const successRate = knownStatuses
    ? (summary.successfulCalls || 0) / knownStatuses * 100
    : null;
  const averageDuration = summary.durationKnownCalls
    ? (summary.durationMs || 0) / summary.durationKnownCalls
    : 0;
  const vision = list(ai.modalities)
    .find(item => item.modality === "vision") || {};
  markup(root, "#ai-kpis", [
    ["总费用", formatCny(totalCostCny), summary.costUnknownCalls ? `${summary.costUnknownCalls} 次供应商调用费用待账单核对` : "按官方单价折算"],
    ["调用次数", compactNumber(summary.calls), "次"],
    ["成功率", successRate == null ? "未知" : `${successRate.toFixed(successRate >= 10 ? 0 : 1)}%`, `${summary.failedCalls || 0} 次失败 · ${summary.unknownStatusCalls || 0} 次历史未知`],
    ["图片理解", compactNumber(vision.calls), `${compactNumber(vision.imageCount)} 张 · ${formatCny(totalCost(vision))}`],
    ["总 Token", compactNumber(totalTokens), "输入与输出"],
    ["缓存命中率", `${cacheRate.toFixed(cacheRate >= 10 ? 0 : 1)}%`, `${compactNumber(tokens.cacheHit)} Token`],
    ["平均费用", formatCny(averageCost), "每次实际请求"],
    ["平均响应", summary.durationKnownCalls ? formatDuration(averageDuration) : "未知", `${summary.usageUnknownCalls || 0} 次用量未知`]
  ].map(([label, value, note]) => (
    `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  )).join(""));
  const tracking = query(root, "#ai-tracking-since");
  if (tracking) tracking.textContent = `自 ${view.formatTrackingStart(
    ai.trackingStartedAt
  )} 开始统计`;

  const services = list(ai.services);
  const callSeries = services.map((service, index) => ({
    label: service.label,
    color: SERVICE_COLORS[service.key]
      || FALLBACK_SERVICE_COLORS[index % FALLBACK_SERVICE_COLORS.length],
    values: daily.map(day => day.services?.[service.key]?.calls || 0)
  }));
  markup(root, "#ai-calls-chart", chartFrame(daily, callSeries, {
    ariaLabel: "多供应商服务每日调用次数",
    valueLabel: value => String(Math.round(value)),
    escapeMarkup: escape
  }));
  markup(root, "#ai-service-summary", `<table><thead><tr><th>服务</th><th>调用</th><th>成功 / 失败</th><th>单位用量</th><th>已知费用</th><th>待账单</th></tr></thead><tbody>${services.map(service => (
    `<tr><td>${escape(service.label)}</td><td>${service.calls}</td><td>${service.successfulCalls || 0} / ${service.failedCalls || 0}</td><td>${escape(
      serviceUnitText(service)
    )}</td><td>${formatCny(totalCost(service))}</td><td>${service.costUnknownCalls ? `${service.costUnknownCalls} 次` : "0 次"}</td></tr>`
  )).join("")}</tbody></table>`);
  markup(root, "#ai-token-chart", stackedTokenChart(daily, escape));
  markup(root, "#ai-modality-summary", `<table><thead><tr><th>输入方式</th><th>调用</th><th>成功</th><th>图片</th><th>总 Token</th><th>费用</th><th>平均响应</th></tr></thead><tbody>${list(
    ai.modalities
  ).map(item => (
    `<tr><td>${escape(item.label)}</td><td>${item.calls}</td><td>${item.successfulCalls || 0}</td><td>${item.imageCount || 0}</td><td>${compactNumber(
      (item.tokens?.input || 0) + (item.tokens?.output || 0)
    )}</td><td>${formatCny(totalCost(item))}${item.costUnknownCalls ? ` + ${item.costUnknownCalls} 次待账单` : ""}</td><td>${item.durationKnownCalls ? formatDuration((item.durationMs || 0) / item.durationKnownCalls) : "未知"}</td></tr>`
  )).join("")}</tbody></table>`);
  const costSeries = [
    ["input", "输入未命中", "#5c7891"],
    ["cacheHit", "缓存命中", "#4f8d78"],
    ["reasoning", "推理", "#c18c3f"],
    ["output", "回答", "#a65f4b"]
  ];
  markup(root, "#ai-cost-charts", list(ai.models).map(model => (
    `<section><h4>${escape(model.label)} <span>${model.calls} 次 · ${formatCny(
      totalCost(model)
    )}</span></h4>${chartFrame(daily, costSeries.map(([key, label, color]) => ({
      label,
      color,
      values: daily.map(day => componentCost(day.models?.[model.model], key))
    })), {
      ariaLabel: `${model.label} 每日费用构成`,
      valueLabel: formatCnyAxis,
      actualPeak: true,
      escapeMarkup: escape
    })}</section>`
  )).join(""));
  const scenes = list(ai.scenes);
  const maxScene = Math.max(1, ...scenes.map(item => item.calls));
  markup(root, "#ai-scenario-bars", scenes.length
    ? scenes.map(item => (
      `<div><span>${escape(SCENE_LABELS[item.scene] || item.scene)}</span><i><b style="width:${item.calls / maxScene * 100}%"></b></i><strong>${item.calls}</strong></div>`
    )).join("")
    : '<div class="analytics-empty">这段时间还没有 AI 调用。</div>');
  markup(root, "#ai-model-summary", `<table><thead><tr><th>供应商</th><th>调用</th><th>成功</th><th>失败</th><th>总 Token</th><th>已知费用</th><th>核算</th></tr></thead><tbody>${list(
    ai.providers
  ).map(provider => (
    `<tr><td>${escape(provider.label)}</td><td>${provider.calls}</td><td>${provider.successfulCalls || 0}</td><td>${provider.failedCalls || 0}</td><td>${compactNumber(
      (provider.tokens?.input || 0) + (provider.tokens?.output || 0)
    )}</td><td>${formatCny(totalCost(provider))}</td><td>${provider.costUnknownCalls ? `${provider.costUnknownCalls} 次待账单` : "已计入"}</td></tr>`
  )).join("")}</tbody></table>`);
  markup(root, "#ai-pricing", `<p>${escape(pricing.estimateNote || "")} ${escape(
    pricing.historicalUsdNote || ""
  )}</p><h4>DeepSeek · 人民币 / 百万 Token</h4><div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>输出</th></tr></thead><tbody>${Object.values(
    pricing.models || {}
  ).flatMap(model => [["offPeak", "谷时"], ["peak", "峰时"]].map(([key, label]) => (
    `<tr><td>${escape(model.label)}</td><td>${label}</td><td>${formatCny(
      model[key]?.cacheHit
    )}</td><td>${formatCny(model[key]?.cacheMiss)}</td><td>${formatCny(
      model[key]?.output
    )}</td></tr>`
  ))).join("")}</tbody></table></div><p><a href="${escape(
    pricing.source || ""
  )}" target="_blank" rel="noopener noreferrer">DeepSeek 官方价格</a> · 核对于 ${escape(
    pricing.checkedAt || ""
  )}</p><h4>语音与视觉 · 官方目录价</h4><div class="pricing-table-wrap"><table><thead><tr><th>计费项</th><th>单价</th><th>单位</th><th>来源</th></tr></thead><tbody>${list(
    pricing.providerRates
  ).map(rate => (
    `<tr><td>${escape(rate.label)}</td><td>${formatCny(rate.priceCny)}</td><td>${escape(
      rate.unitLabel
    )}</td><td><a href="${escape(rate.source)}" target="_blank" rel="noopener noreferrer">官方价格</a> · ${escape(rate.checkedAt)}</td></tr>`
  )).join("")}</tbody></table></div>`);
  return true;
}

export function clearStatisticsPresentation(root) {
  for (const selector of OUTPUT_SELECTORS) markup(root, selector, "");
  const title = query(root, "#statistics-page-title");
  const status = query(root, "#statistics-status");
  if (title) title.textContent = "留下了什么";
  if (status) status.textContent = "";
  const form = query(root, "#statistics-range-form");
  form?.reset?.();
  const submit = form?.querySelector?.("button[type='submit']");
  if (submit) submit.disabled = false;
}
