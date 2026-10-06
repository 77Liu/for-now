import {
  average,
  experimentViewModel,
  hasReviewSource
} from "./model.mjs";

export const REVIEW_OWNED_SELECTORS = Object.freeze([
  "#weekly-summary",
  "#trend-list",
  "#association-list",
  "#cluster-grid",
  "#experiment-list",
  "#metric-list",
  "#analysis-count",
  "#analysis-status",
  "#analysis-list",
  "#analysis-pagination-status"
]);

const query = (root, selector) => root?.querySelector?.(selector) || null;
const values = value => Array.isArray(value) ? value : [];

function setMarkup(root, selector, markup) {
  const target = query(root, selector);
  if (target) target.innerHTML = markup;
  return target;
}

function trendMarkup(snapshot, view) {
  const trends = values(snapshot.insights?.trends);
  const available = trends.filter(item => item.current != null);
  if (!available.length) {
    return `<div class="empty">${view.escapeMarkup(
      "记录一次状态后即可形成当前均值；有第二组数据后再比较变化。"
    )}</div>`;
  }
  const waiting = available.every(item => item.previous == null);
  const sampleCount = Math.max(
    ...available.map(item => item.currentCount || 0),
    snapshot.insights?.weekly?.checkins || 0
  );
  const observation = waiting
    ? `<p class="review-observation"><b>当前观察</b><span>先展示已有 ${sampleCount || "少量"} 个记录日的均值；样本增加后自动补充前后变化。</span></p>`
    : "";
  return observation + trends.map(item => {
    const delta = item.previous == null
      ? "当前均值"
      : `${item.current >= item.previous ? "+" : ""}${(item.current - item.previous).toFixed(1)}`;
    const count = item.currentCount ? ` · ${item.currentCount}天` : "";
    const metric = view.escapeMarkup(item.metric);
    return `<div class="trend-row trend-${metric}"><b>${view.escapeMarkup(
      view.metricLabel(item.metric)
    )}</b><div class="trend-bar"><span style="width:${(item.current || 0) * 20}%;--trend-value:${item.current || 0}"></span></div><span class="delta">${item.current ?? "—"} / ${delta}${count}</span></div>`;
  }).join("");
}

function associationMarkup(snapshot, view) {
  const associations = values(snapshot.insights?.associations).slice(0, 3);
  if (associations.length) {
    return associations.map(item => {
      const next = item.nextDay == null
        ? "次日暂无"
        : `次日 ${item.nextDay}（${item.nextDayCount}天）`;
      const baseline = item.baseline == null
        ? "暂无无因素日"
        : `无因素 ${item.baseline}（${item.withoutCount}天）`;
      return `<div class="association-row"><b>${view.escapeMarkup(
        item.factor
      )}</b><span>当天 ${item.sameDay ?? "—"}（${item.withCount}天） · ${next} · ${baseline}</span><span class="delta">${view.escapeMarkup(item.confidence)}</span></div>`;
    }).join("");
  }
  const groups = new Map();
  for (const item of values(snapshot.checkins)) {
    const mood = Number(item.mood);
    if (!Number.isFinite(mood)) continue;
    if (!groups.has(item.occurredOn)) groups.set(item.occurredOn, []);
    groups.get(item.occurredOn).push(mood);
  }
  const moods = [...groups.values()].map(average);
  if (!moods.length) {
    return `<div class="empty">${view.escapeMarkup(
      "记录一次状态后即可形成当前观察；补充当天因素后再寻找关联线索。"
    )}</div>`;
  }
  return `<p class="review-observation"><b>当前观察</b><span>${groups.size} 个记录日的情绪均值为 ${average(moods).toFixed(1)}。尚未记录可对照因素，暂时只描述现状。</span></p>`;
}

function associationFlowMarkup(snapshot) {
  const checkins = values(snapshot.checkins);
  const dates = new Set(checkins.map(item => item.occurredOn)).size;
  const factors = new Set(checkins.flatMap(item => item.factors || [])).size;
  return `<div class="association-flow" role="img" aria-label="延迟相关线索计算流程：记录状态和因素，按日期聚合，按因素分组，对照当天与自然次日情绪，通过样本门槛，最后输出非因果线索"><div class="flow-node"><b>状态记录</b><span>${checkins.length} 次状态 · ${factors} 个因素</span></div><i>↓</i><div class="flow-node"><b>按自然日聚合</b><span>${dates} 天；同日多次取平均</span></div><i>↓</i><div class="flow-node"><b>逐个因素分组</b><span>出现该因素的天 vs 未出现的天</span></div><i>↓</i><div class="flow-node"><b>三个对照</b><span>当天情绪 · 自然次日情绪 · 无因素基线</span></div><i>↓</i><div class="flow-node"><b>样本分层</b><span>首次出现即展示；样本增加后再升级为初步线索或可观察</span></div><i>↓</i><div class="flow-node final"><b>延迟关联线索</b><span>只显示均值差异，不推断因果</span></div></div>`;
}

function clusterMarkup(snapshot, view) {
  const clusters = values(snapshot.clusters);
  if (!clusters.length) {
    return `<div class="empty">${view.escapeMarkup(
      "累积几条思绪后，这里会出现反复主题。"
    )}</div>`;
  }
  return clusters.map(group => (
    `<article class="cluster-card"><div class="section-title"><h2>${view.escapeMarkup(
      group.theme
    )}</h2><b>${group.count}</b></div><div class="cluster-stats"><span>保留 ${group.kept}</span><span>舍弃 ${group.discarded}</span><span>未处理 ${group.unreviewed}</span></div><ul>${values(
      group.items
    ).slice(0, 3).map(item => {
      const content = String(item.content || "");
      return `<li>${view.escapeMarkup(content.slice(0, 54))}${content.length > 54 ? "…" : ""}</li>`;
    }).join("")}</ul></article>`
  )).join("");
}

function experimentMarkup(item, snapshot, view, platform) {
  const model = experimentViewModel(item, snapshot.checkins, {
    now: platform.now(),
    metricLabel: view.metricLabel
  });
  const id = view.escapeMarkup(item.id);
  return `<article class="experiment-card"><div class="section-title"><b>${view.escapeMarkup(
    item.hypothesis
  )}</b><span>${model.elapsed} / ${model.duration} 天</span></div><div class="experiment-progress"><i style="width:${Math.min(
    100,
    model.elapsed / model.duration * 100
  )}%"></i></div><p>每天若做了“<b>${view.escapeMarkup(
    item.factor
  )}</b>”，请在今日因素中填入完全相同的词；观察 ${view.escapeMarkup(
    model.metricLabel
  )}。</p><footer><small>${view.escapeMarkup(
    model.result
  )}。相关不等于因果。</small><button class="subtle-action danger" type="button" data-experiment-delete="${id}">删除</button></footer></article>`;
}

function analysisHistoryMarkup(root, snapshot, {
  view,
  annotations
}) {
  const list = query(root, "#analysis-list");
  if (!list) return [];
  const known = new Set([...list.querySelectorAll("[data-analysis-id]")]
    .map(item => item.dataset.analysisId));
  const opened = new Set([...list.querySelectorAll("[data-analysis-id][open]")]
    .map(item => item.dataset.analysisId));
  const items = [...values(snapshot.analyses)]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const total = Math.max(items.length, Number(snapshot.analysisPage?.total) || 0);
  const count = query(root, "#analysis-count");
  if (count) count.textContent = `${total} 份`;
  list.innerHTML = items.length
    ? items.map((item, index) => {
      const id = view.escapeMarkup(item.id);
      const label = item.reason === "weekly-background" ? "后台周复盘" : "主动复盘";
      const isNew = !known.has(item.id);
      const open = opened.has(item.id) || (index === 0 && (!known.size || isNew));
      return `<details class="analysis-entry" data-analysis-id="${id}" ${open ? "open" : ""}><summary><div><div class="analysis-summary-meta"><time>${view.formatDate(
        item.createdAt
      )}</time><span>${label}</span>${index === 0 ? "<b>最新</b>" : ""}</div><p>${view.escapeMarkup(
        view.plainPreview(item.content)
      )}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="analysis-entry-body">${view.contextReceiptMarkup(
        item.contextReceipt
      )}<div class="analysis-content markdown-content">${view.renderMarkdown(
        item.content
      )}</div>${item.contentTruncated
        ? '<p class="status" data-analysis-load-status>展开后载入完整复盘。</p>'
        : ""}<button class="subtle-action danger" type="button" data-analysis-delete="${id}">删除复盘</button></div></details>`;
    }).join("")
    : view.contentState({
      title: "还没有认知复盘",
      body: hasReviewSource(snapshot)
        ? "现有记录已经可以作为起点，复盘结果只是一条可修正的线索。"
        : "先留下任意一条记录，再回到这里形成第一份复盘。",
      action: hasReviewSource(snapshot)
        ? { command: "run-analysis", label: "开始一次复盘" }
        : { view: "captures", label: "先留一条记录" }
    });
  const pagination = query(root, "#analysis-pagination");
  const paginationStatus = query(root, "#analysis-pagination-status");
  if (pagination) pagination.hidden = !snapshot.analysisPage?.nextCursor;
  if (paginationStatus) {
    paginationStatus.textContent = snapshot.analysisPage?.nextCursor
      ? `已加载 ${items.length} / ${total} 份`
      : "";
  }
  for (const item of items) {
    const content = list.querySelector(
      `[data-analysis-id="${view.escapeSelector(item.id)}"] .analysis-content`
    );
    annotations.markTarget(
      content,
      annotations.rootKey("analysis", item.id),
      "content"
    );
  }
  view.renderLatex(list);
  annotations.applyAnchors(list);
  return [...list.querySelectorAll("[data-analysis-id][open]")]
    .filter(entry => entry.querySelector("[data-analysis-load-status]"))
    .map(entry => entry.dataset.analysisId);
}

export function renderReviewPresentation({
  root,
  modal,
  snapshot = {},
  view,
  annotations,
  platform
} = {}) {
  const weekly = snapshot.insights?.weekly || {};
  const reviewValue = weekly.reviewAgeDays == null
    ? "未开始"
    : weekly.reviewAgeDays === 0 ? "今天" : String(weekly.reviewAgeDays);
  const signals = [
    ["coverage", "近 7 日记录覆盖", weekly.activeDays7 ?? 0, "/ 7 天", "有任一主动记录的自然日"],
    ["paired", "近 30 日身心同日", weekly.pairedDays30 ?? 0, "天", "状态与健康记录出现在同一天"],
    ["trace", "近 30 日思考留痕率", weekly.traceRate30 ?? "—", weekly.traceRate30 == null ? "" : "%", weekly.rootCount30 ? `${weekly.tracedRoots30 ?? 0} / ${weekly.rootCount30} 个问题留有你的痕迹` : "近 30 日还没有问题"],
    ["correction", "近 30 日主动校正", weekly.correctionActions30 ?? 0, "次", "编辑、追问、批注与回望"],
    ["review", "距上次认知复盘", reviewValue, weekly.reviewAgeDays > 0 ? "天" : "", weekly.analysisCount ? `累计 ${weekly.analysisCount} 份认知复盘` : "还没有认知复盘"]
  ];
  setMarkup(root, "#weekly-summary", signals.map(([key, label, value, unit, detail]) => (
    `<article class="summary-signal" data-signal="${key}"><span class="summary-signal-label">${label}</span><div class="summary-signal-value"><strong>${value}</strong>${unit ? `<span>${unit}</span>` : ""}</div><p>${detail}</p></article>`
  )).join(""));
  setMarkup(root, "#trend-list", trendMarkup(snapshot, view));
  setMarkup(root, "#association-list", associationMarkup(snapshot, view));
  setMarkup(modal, "#association-flow", associationFlowMarkup(snapshot));
  setMarkup(root, "#cluster-grid", clusterMarkup(snapshot, view));
  setMarkup(
    root,
    "#experiment-list",
    values(snapshot.experiments).length
      ? values(snapshot.experiments)
        .map(item => experimentMarkup(item, snapshot, view, platform))
        .join("")
      : '<p class="time-hint">建议从 14 天、一个因素、一个结果开始。</p>'
  );
  setMarkup(
    root,
    "#metric-list",
    values(snapshot.customMetrics).length
      ? `<div class="pill-list">${values(snapshot.customMetrics).map(item => (
        `<span class="pill">${view.escapeMarkup(item.name)}：${view.escapeMarkup(
          item.low
        )} ↔ ${view.escapeMarkup(item.high)}</span>`
      )).join("")}</div>`
      : '<p class="time-hint">新指标会出现在“此刻状态”中。</p>'
  );
  return Object.freeze({
    openAnalysisIds: analysisHistoryMarkup(root, snapshot, { view, annotations })
  });
}

export function clearReviewPresentation(root, modal) {
  for (const selector of REVIEW_OWNED_SELECTORS) {
    const target = query(root, selector);
    if (target) {
      if ("innerHTML" in target) target.innerHTML = "";
      if ("textContent" in target) target.textContent = "";
    }
  }
  const pagination = query(root, "#analysis-pagination");
  if (pagination) pagination.hidden = true;
  for (const form of [
    query(root, "#experiment-form"),
    query(root, "#metric-form")
  ]) {
    form?.reset?.();
    if (form?.dataset) delete form.dataset.requestId;
  }
  for (const selector of [
    "#run-analysis",
    "#analysis-load-more",
    "#experiment-form button[type='submit']",
    "#metric-form button[type='submit']"
  ]) {
    const control = query(root, selector);
    if (control) control.disabled = false;
  }
  const flow = query(modal, "#association-flow");
  if (flow) flow.innerHTML = "";
  if (modal) modal.hidden = true;
  const toggle = query(root, "#association-flow-toggle");
  if (toggle) {
    toggle.setAttribute?.("aria-expanded", "false");
    toggle.setAttribute?.("aria-label", "查看计算流程");
    toggle.title = "查看计算流程";
  }
}
