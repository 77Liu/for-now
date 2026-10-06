import {
  aiBudgetProjection,
  aiCostProjection,
  architectureProjection,
  commercialAssumptionsFromValues,
  currentAiCostModel,
  DEFAULT_SCENE_LABELS,
  updateAiCostPlan
} from "./model.mjs";

export const OWNER_CONSOLE_SELECTORS = Object.freeze({
  aiCost: Object.freeze({
    form: "#ai-cost-form",
    status: "#ai-cost-status",
    calibrate: "#ai-cost-calibrate",
    budgetAddForm: "#ai-budget-add-form",
    budgetRecoverForm: "#ai-budget-recover-form",
    budgetStatus: "#ai-budget-status"
  }),
  architecture: Object.freeze({
    surface: '[data-owner-surface-root="architecture"]',
    stage: "[data-architecture-stage]",
    term: "[data-architecture-term]"
  }),
  commercialization: Object.freeze({
    surface: '[data-owner-surface-root="commercialization"]',
    form: "#commercial-assumptions-form",
    mode: "[data-commercial-mode]",
    stage: "#commercial-stage-slider",
    field: "[data-commercial-field]",
    profileField: "[data-commercial-profile-field]",
    source: "[data-commercial-source-view]",
    status: "#commercial-save-status"
  })
});

export const ownerRootConnected = root => Boolean(root && root.isConnected !== false);

const query = (root, selector) => root?.querySelector?.(selector) || null;
const queryAll = (root, selector) => [...(root?.querySelectorAll?.(selector) || [])];
const setText = (root, selector, value) => {
  const element = query(root, selector);
  if (!element) return false;
  element.textContent = String(value ?? "");
  return true;
};
const setMarkup = (root, selector, value) => {
  const element = query(root, selector);
  if (!element) return false;
  element.innerHTML = String(value ?? "");
  return true;
};
const setDisabled = (root, selector, value) => {
  const element = query(root, selector);
  if (!element) return false;
  element.disabled = Boolean(value);
  return true;
};
const surfaceRoot = (root, selector) => (
  root?.matches?.(selector) ? root : query(root, selector)
);

export function closestOwnerTarget(root, event, selector) {
  const element = event?.target?.closest?.(selector) || null;
  if (!element) return null;
  return typeof root?.contains !== "function" || root.contains(element) ? element : null;
}

function recommendationMarkup(item, labels, format) {
  if (item.kind === "budget-over") {
    return ["先守住预算", `当前模拟超出月预算 ${format.cny(item.amount)}，需要降低约 ${item.percent.toFixed(0)}%。`, "预算"];
  }
  if (item.kind === "budget-room") {
    return ["预算仍有余量", `包含不确定性预留后，距月预算还剩 ${format.cny(item.amount)}。`, "可控"];
  }
  if (item.kind === "top") {
    return ["先看最高成本场景", `${labels[item.scene] || item.scene}预计 ${format.cny(item.total)}/月，占基础成本 ${item.percent.toFixed(0)}%。`, "优先"];
  }
  if (item.kind === "downgrade") {
    return ["轻量场景可试 Flash", `${labels[item.scene] || item.scene}切换 Flash 预计每月节省 ${format.cny(item.saving)}；先用质量回归验证。`, "模型"];
  }
  if (item.kind === "long-context") {
    return ["先压缩输入上下文", `${labels[item.scene] || item.scene}平均输入 ${Number(item.tokens).toLocaleString("zh-CN")} Token。设置场景上限通常比直接降模型更稳妥。`, "Token"];
  }
  return ["提高缓存稳定性", `${labels[item.scene] || item.scene}缓存命中仅 ${item.percent}%，可固定系统提示词前缀并减少无效变动。`, "缓存"];
}

export function createOwnerConsolePresentation({ format, settings }) {
  const html = format.escapeMarkup;
  const labels = () => ({
    ...DEFAULT_SCENE_LABELS,
    ...settings.snapshot()?.sceneLabels
  });

  function readAiCostPlan(root, plan) {
    const scenarios = new Map();
    for (const row of plan?.scenarios || []) {
      const rowRoot = query(
        root,
        `[data-ai-cost-row="${format.escapeSelector(row.scene)}"]`
      );
      if (!rowRoot) continue;
      scenarios.set(row.scene, {
        enabled: query(rowRoot, "[data-ai-cost-enabled]")?.checked === true,
        model: query(rowRoot, '[data-ai-cost-field="model"]')?.value,
        pricingPeriod: query(rowRoot, '[data-ai-cost-field="pricingPeriod"]')?.value,
        callsPerMonth: Number(query(rowRoot, '[data-ai-cost-field="callsPerMonth"]')?.value) || 0,
        avgInputTokens: Number(query(rowRoot, '[data-ai-cost-field="avgInputTokens"]')?.value) || 0,
        cacheHitPct: Number(query(rowRoot, '[data-ai-cost-field="cacheHitPct"]')?.value) || 0,
        avgReasoningTokens: Number(query(rowRoot, '[data-ai-cost-field="avgReasoningTokens"]')?.value) || 0,
        avgAnswerTokens: Number(query(rowRoot, '[data-ai-cost-field="avgAnswerTokens"]')?.value) || 0
      });
    }
    return updateAiCostPlan(plan, {
      monthlyBudgetCny: query(root, "#ai-cost-budget")?.value,
      contingencyPct: query(root, "#ai-cost-contingency")?.value,
      cnyPerUsd: query(root, "#ai-cost-exchange")?.value,
      scenarios
    });
  }

  function renderAiCostRows(root, plan, statistics, llmSettings) {
    const pricing = statistics.ai?.pricing || {};
    setMarkup(root, "#ai-cost-scenario-rows", (plan.scenarios || []).map(row => {
      const current = currentAiCostModel(llmSettings, row.scene);
      const estimate = aiCostProjection({ scenarios: [row] }, statistics).rows[0]?.estimate;
      return `<tr data-ai-cost-row="${html(row.scene)}" class="${row.enabled ? "" : "disabled"}">
        <th><label><input type="checkbox" data-ai-cost-enabled ${row.enabled ? "checked" : ""}><span>${html(labels()[row.scene] || row.scene)}</span></label></th>
        <td><strong>${html(current.label)}</strong><small>${html(current.effort === "none" ? "不思考" : `思考 ${current.effort.toUpperCase()}`)}</small></td>
        <td><select data-ai-cost-field="model"><option value="deepseek-flash" ${row.model === "deepseek-flash" ? "selected" : ""}>Flash</option><option value="deepseek-v4-pro" ${row.model === "deepseek-v4-pro" ? "selected" : ""}>Pro</option></select></td>
        <td><select data-ai-cost-field="pricingPeriod"><option value="peak" ${row.pricingPeriod === "peak" ? "selected" : ""}>峰值</option><option value="offPeak" ${row.pricingPeriod === "offPeak" ? "selected" : ""}>谷时</option></select></td>
        <td><input type="number" min="0" step="1" data-ai-cost-field="callsPerMonth" value="${html(row.callsPerMonth)}"></td>
        <td><input type="number" min="0" step="1" data-ai-cost-field="avgInputTokens" value="${html(row.avgInputTokens)}"></td>
        <td><input type="number" min="0" max="100" step=".1" data-ai-cost-field="cacheHitPct" value="${html(row.cacheHitPct)}"></td>
        <td><input type="number" min="0" step="1" data-ai-cost-field="avgReasoningTokens" value="${html(row.avgReasoningTokens)}"></td>
        <td><input type="number" min="0" step="1" data-ai-cost-field="avgAnswerTokens" value="${html(row.avgAnswerTokens)}"></td>
        <td data-ai-cost-row-total>${html(format.cny(estimate?.total || 0))}</td>
      </tr>`;
    }).join(""));
    if (!pricing.models) return;
  }

  function renderAiCost(root, plan, statistics, { syncRows = true } = {}) {
    if (!ownerRootConnected(root) || !plan || !statistics?.ai) return false;
    const llmSettings = settings.snapshot() || {};
    if (syncRows) {
      const budget = query(root, "#ai-cost-budget");
      const contingency = query(root, "#ai-cost-contingency");
      const exchange = query(root, "#ai-cost-exchange");
      if (budget) budget.value = plan.monthlyBudgetCny;
      if (contingency) contingency.value = plan.contingencyPct;
      if (exchange) exchange.value = plan.cnyPerUsd;
      renderAiCostRows(root, plan, statistics, llmSettings);
    }
    const projection = aiCostProjection(plan, statistics);
    for (const item of projection.rows) {
      const rowRoot = query(
        root,
        `[data-ai-cost-row="${format.escapeSelector(item.row.scene)}"]`
      );
      rowRoot?.classList?.toggle("disabled", !item.row.enabled);
      const cell = query(rowRoot, "[data-ai-cost-row-total]");
      if (cell) cell.textContent = format.cny(item.estimate.total);
    }
    setMarkup(root, "#ai-cost-kpis", [
      ["预计月成本", format.cny(projection.projected), `基础 ${format.cny(projection.base)} + 预留 ${format.cny(projection.reserve)}`, projection.budget && projection.projected > projection.budget ? "negative" : "positive"],
      ["近 30 天实测", format.cny(projection.observed), `${statistics.ai.summary?.calls || 0} 次实际调用`],
      ["预算差额", projection.budget ? format.cny(projection.difference) : "未设预算", projection.budget ? `${projection.difference >= 0 ? "剩余" : "超出"} ${format.cny(Math.abs(projection.difference))}` : "填写月度预算", projection.difference >= 0 ? "positive" : "negative"],
      ["预计年成本", format.cny(projection.projected * 12), "月度方案 × 12"]
    ].map(([label, value, note, tone]) => `<article class="${tone || ""}"><span>${html(label)}</span><strong>${html(value)}</strong><small>${html(note)}</small></article>`).join(""));
    const recommendations = projection.recommendations.map(item => (
      recommendationMarkup(item, labels(), format)
    ));
    setMarkup(root, "#ai-cost-recommendations", recommendations.map(([title, copy, tag], index) => (
      `<li><b>${String(index + 1).padStart(2, "0")}</b><div><strong>${html(title)}</strong><p>${html(copy)}</p></div><span>${html(tag)}</span></li>`
    )).join("") + '<li class="settings-link"><button type="button" data-view="settings">打开模型设置</button><p>模拟方案不会自动修改真实模型配置。</p></li>');
    const cny = projection.cnyPerUsd;
    const observedCost = item => (Number(item?.costsUsd?.total) || 0) * cny
      + (Number(item?.costCny) || 0);
    const observedScenes = [...(statistics.ai.scenes || [])]
      .sort((left, right) => observedCost(right) - observedCost(left))
      .slice(0, 5);
    const p90 = Number(statistics.ai.calibration?.p90CostCny) || 0;
    const unknownCosts = Number(statistics.ai.summary?.costUnknownCalls) || 0;
    setMarkup(root, "#ai-cost-observed", `<dl><div><dt>调用</dt><dd>${statistics.ai.summary?.calls || 0} 次${unknownCosts ? ` · ${unknownCosts} 次费用待账单` : ""}</dd></div><div><dt>平均输入</dt><dd>${format.compactNumber(statistics.ai.calibration?.averageInputTokens || 0)} Token</dd></div><div><dt>P90 单次</dt><dd>${format.cny(p90)}</dd></div><div><dt>模拟 / 实测</dt><dd>${projection.observed ? `${(projection.projected / projection.observed).toFixed(1)}×` : "—"}</dd></div></dl><div class="ai-cost-observed-scenes">${observedScenes.length ? observedScenes.map(item => `<div><span>${html(labels()[item.scene] || item.scene)}</span><strong>${item.calls} 次</strong><small>${format.cny(observedCost(item))}${item.costUnknownCalls ? ` + ${item.costUnknownCalls} 次待账单` : ""}</small></div>`).join("") : "<p>近 30 天暂无可用样本。</p>"}</div>`);
    const pricing = statistics.ai.pricing;
    setMarkup(root, "#ai-cost-pricing", `<div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>推理/回答</th></tr></thead><tbody>${Object.entries(pricing.models || {}).flatMap(([, model]) => [["offPeak", "谷时"], ["peak", "峰值"]].map(([period, label]) => `<tr><td>${html(model.label)}</td><td>${label}</td><td>${format.cny(model[period].cacheHit)}</td><td>${format.cny(model[period].cacheMiss)}</td><td>${format.cny(model[period].output)}</td></tr>`)).join("")}</tbody></table></div><p>单位均为人民币 / 百万 Token；${html(pricing.historicalUsdNote || `历史美元账本按 ${cny.toFixed(2)} 元/美元换算。`)}</p>`);
    setText(root, "#ai-cost-plan-state", projection.budget && projection.projected > projection.budget ? "超过预算" : "预算内");
    query(root, "#ai-cost-plan-state")?.classList?.toggle(
      "over",
      Boolean(projection.budget && projection.projected > projection.budget)
    );
    setText(root, "#ai-cost-updated-at", plan.updatedAt ? `参数更新于 ${format.date(plan.updatedAt)}` : "尚未保存");
    return true;
  }

  function renderAiBudget(root, status) {
    if (!ownerRootConnected(root) || !status) return false;
    const projection = aiBudgetProjection(status);
    setText(root, "#ai-budget-period", projection.period);
    setMarkup(root, "#ai-budget-kpis", projection.rows.map(item => {
      let value;
      let note;
      if (item.reservations) {
        value = String(item.value);
        note = `控制版本 ${item.note}`;
      } else if (item.unknown) {
        value = `${item.value} / ${item.limit}`;
        note = `${item.note[0]} 已发生 · ${item.note[1]} 已预留`;
      } else {
        value = `${format.cny(item.value)} / ${format.cny(item.limit)}`;
        note = `${format.cny(item.note[0])} 已结算 · ${format.cny(item.note[1])} 已预留`;
      }
      return `<article class="${item.blocked ? "blocked" : ""}"><span>${html(item.label)}</span><strong>${html(value)}</strong><small>${html(item.blocked ? `${note} · 已阻断` : note)}</small></article>`;
    }).join(""));
    return true;
  }

  function setAiStatus(root, message) {
    return setText(root, OWNER_CONSOLE_SELECTORS.aiCost.status, message);
  }

  function setBudgetStatus(root, message) {
    return setText(root, OWNER_CONSOLE_SELECTORS.aiCost.budgetStatus, message);
  }

  function setFormBusy(root, selector, busy) {
    const form = query(root, selector);
    const button = query(form, '[type="submit"]');
    if (button) button.disabled = Boolean(busy);
    return form;
  }

  function cleanupAiCost(root) {
    setDisabled(root, `${OWNER_CONSOLE_SELECTORS.aiCost.form} [type="submit"]`, false);
    setDisabled(root, `${OWNER_CONSOLE_SELECTORS.aiCost.budgetAddForm} [type="submit"]`, false);
    setDisabled(root, `${OWNER_CONSOLE_SELECTORS.aiCost.budgetRecoverForm} [type="submit"]`, false);
  }

  function resetAiCost(root) {
    cleanupAiCost(root);
    query(root, OWNER_CONSOLE_SELECTORS.aiCost.form)?.reset?.();
    query(root, OWNER_CONSOLE_SELECTORS.aiCost.budgetAddForm)?.reset?.();
    query(root, OWNER_CONSOLE_SELECTORS.aiCost.budgetRecoverForm)?.reset?.();
    for (const selector of [
      "#ai-cost-scenario-rows",
      "#ai-cost-kpis",
      "#ai-cost-recommendations",
      "#ai-cost-observed",
      "#ai-cost-pricing",
      "#ai-budget-kpis"
    ]) setMarkup(root, selector, "");
    setAiStatus(root, "");
    setBudgetStatus(root, "");
    setText(root, "#ai-budget-period", "正在读取");
    setText(root, "#ai-cost-plan-state", "模拟方案");
    setText(root, "#ai-cost-updated-at", "尚未保存");
  }

  function renderArchitecture(root, surface, stageIndex, termKey, { mount = false } = {}) {
    const target = surfaceRoot(root, OWNER_CONSOLE_SELECTORS.architecture.surface);
    if (!ownerRootConnected(root) || !target || !surface) return null;
    if (mount || !query(target, "#architecture-stage-tabs")) {
      target.innerHTML = surface.markup || "";
    }
    const projection = architectureProjection(surface, stageIndex, termKey);
    const stage = projection.stage;
    if (!stage) return projection;
    const tabs = query(target, "#architecture-stage-tabs");
    if (tabs && !tabs.children?.length) {
      tabs.innerHTML = (surface.stages || []).map((item, index) => (
        `<button class="${index === projection.stageIndex ? "active" : ""}" type="button" role="tab" aria-selected="${index === projection.stageIndex}" data-architecture-stage="${index}">${html(item.tab || item.name)}</button>`
      )).join("");
    }
    for (const button of queryAll(target, OWNER_CONSOLE_SELECTORS.architecture.stage)) {
      const active = Number(button.dataset.architectureStage) === projection.stageIndex;
      button.classList?.toggle("active", active);
      button.setAttribute?.("aria-selected", String(active));
    }
    setText(target, "#architecture-stage-cost", stage.cost);
    setText(target, "#architecture-stage-state", stage.state);
    setText(target, "#architecture-flow-note", stage.note);
    setMarkup(target, "#architecture-kpis", (surface.kpis || []).map(item => (
      `<article><span>${html(item.label)}</span><strong>${html(stage[item.key])}</strong><small>${html(item.note)}</small></article>`
    )).join(""));
    const nodeMarkup = ([title, detail, state]) => (
      `<article class="${html(state || "")}"><strong>${html(title)}</strong><span>${html(detail)}</span></article>`
    );
    setMarkup(target, "#architecture-main-path", (stage.mainPath || []).map((node, index) => (
      `${index ? '<span aria-hidden="true">→</span>' : ""}${nodeMarkup(node)}`
    )).join(""));
    setMarkup(target, "#architecture-support-paths", (stage.supports || []).map(([title, nodes]) => (
      `<section><h4>${html(title)}</h4><div>${nodes.map(nodeMarkup).join("")}</div></section>`
    )).join(""));
    setMarkup(target, "#architecture-layer-list", (stage.layers || []).map(([layer, component, spec, reason], index) => (
      `<article><b>${String(index + 1).padStart(2, "0")}</b><strong>${html(layer)}</strong><div><h3>${html(component)}</h3><span>${html(spec)}</span></div><p>${html(reason)}</p></article>`
    )).join(""));
    setText(target, "#architecture-enter-title", stage.enter?.[0]);
    setText(target, "#architecture-enter-copy", stage.enter?.[1]);
    setText(target, "#architecture-defer-title", stage.defer?.[0]);
    setText(target, "#architecture-defer-copy", stage.defer?.[1]);
    const glossary = query(target, "#architecture-glossary-grid");
    if (glossary && !glossary.children?.length) {
      glossary.innerHTML = projection.terms.map(item => (
        `<button type="button" data-architecture-term="${html(item.key)}"><b>${html(item.code)}</b><span>${html(item.name)}</span></button>`
      )).join("");
    }
    for (const button of queryAll(target, OWNER_CONSOLE_SELECTORS.architecture.term)) {
      button.classList?.toggle("active", button.dataset.architectureTerm === projection.termKey);
    }
    if (projection.term) {
      setText(target, "#architecture-term-code", projection.term.code);
      setText(target, "#architecture-term-name", projection.term.name);
      setText(target, "#architecture-term-description", projection.term.description);
      setText(target, "#architecture-term-analogy", projection.term.analogy);
      setText(target, "#architecture-term-timing", projection.term.timing);
    }
    return projection;
  }

  function setSurfaceMessage(root, selector, message, error = false) {
    const target = surfaceRoot(root, selector);
    if (!target) return false;
    target.innerHTML = `<p class="status${error ? " error" : ""}" role="${error ? "alert" : "status"}">${html(message)}</p>`;
    return true;
  }

  function clearSurface(root, selector) {
    const target = surfaceRoot(root, selector);
    if (!target) return false;
    if (typeof target.replaceChildren === "function") target.replaceChildren();
    else target.innerHTML = "";
    return true;
  }

  function readCommercialAssumptions(root, fallback) {
    return commercialAssumptionsFromValues(
      fallback,
      queryAll(root, OWNER_CONSOLE_SELECTORS.commercialization.field)
        .map(input => [input.dataset.commercialField, input.value]),
      queryAll(root, OWNER_CONSOLE_SELECTORS.commercialization.profileField)
        .map(input => [input.dataset.commercialProfileField, input.value])
    );
  }

  function populateCommercialAssumptions(root, assumptions) {
    for (const input of queryAll(root, OWNER_CONSOLE_SELECTORS.commercialization.field)) {
      const [group, key] = String(input.dataset.commercialField || "").split(".");
      input.value = assumptions?.[group]?.[key] ?? "";
    }
    for (const input of queryAll(root, OWNER_CONSOLE_SELECTORS.commercialization.profileField)) {
      const [profile, key] = String(input.dataset.commercialProfileField || "").split(".");
      input.value = assumptions?.usageProfiles?.[profile]?.[key] ?? "";
    }
  }

  function renderCommercialization(root, surface, { mount = false } = {}) {
    const target = surfaceRoot(root, OWNER_CONSOLE_SELECTORS.commercialization.surface);
    if (!ownerRootConnected(root) || !target || !surface) return false;
    if (mount || !query(target, OWNER_CONSOLE_SELECTORS.commercialization.form)) {
      target.innerHTML = surface.markup || "";
    }
    populateCommercialAssumptions(target, surface.report?.assumptions);
    for (const button of queryAll(target, OWNER_CONSOLE_SELECTORS.commercialization.mode)) {
      const active = button.dataset.commercialMode === surface.mode;
      button.classList?.toggle("active", active);
      button.setAttribute?.("aria-selected", String(active));
    }
    for (const group of queryAll(target, "[data-commercial-assumption-group]")) {
      group.hidden = group.dataset.commercialAssumptionGroup !== surface.mode;
    }
    const slider = query(target, OWNER_CONSOLE_SELECTORS.commercialization.stage);
    if (slider) slider.value = String(surface.view?.stageIndex ?? 0);
    for (const [id, value] of Object.entries(surface.view?.text || {})) {
      setText(target, `#${format.escapeSelector(id)}`, value);
    }
    for (const [id, value] of Object.entries(surface.view?.html || {})) {
      setMarkup(target, `#${format.escapeSelector(id)}`, value);
    }
    for (const [profile, value] of Object.entries(surface.view?.profileCosts || {})) {
      setText(
        target,
        `[data-commercial-profile-cost="${format.escapeSelector(profile)}"]`,
        value
      );
    }
    query(target, "#commercial-profile-share-status")?.classList?.toggle(
      "warning",
      Boolean(surface.view?.shareWarning)
    );
    const cashflow = query(target, "#commercial-cashflow");
    if (cashflow) cashflow.hidden = Boolean(surface.view?.cashflowHidden);
    return true;
  }

  function cleanupCommercialization(root) {
    setFormBusy(root, OWNER_CONSOLE_SELECTORS.commercialization.form, false);
  }

  return Object.freeze({
    readAiCostPlan,
    renderAiCost,
    renderAiBudget,
    setAiStatus,
    setBudgetStatus,
    setFormBusy,
    cleanupAiCost,
    resetAiCost,
    renderArchitecture,
    setSurfaceMessage,
    clearSurface,
    readCommercialAssumptions,
    renderCommercialization,
    cleanupCommercialization
  });
}
