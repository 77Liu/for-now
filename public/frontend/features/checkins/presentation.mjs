import { eventDate, eventTimestamp, formatTime } from "../../time/index.mjs";
import {
  buildCheckinTrend,
  buildHomeMoodSeries,
  checkinMetricValue,
  createCheckinMetricConfig
} from "../checkins-model/index.mjs";

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
})[character]);

function renderCheckinHistory(root, items, customMetrics) {
  const list = root.querySelector?.("#checkin-history");
  if (!list) return false;
  if (!items.length) {
    list.innerHTML = "";
    return true;
  }
  const config = createCheckinMetricConfig(customMetrics);
  list.innerHTML = `<div class="checkin-history-heading"><b>单次记录</b><span>${items.length} 次</span></div><div class="checkin-history-list">${items.map(item => {
    const values = Object.entries(config).map(([key, meta]) => {
      const value = checkinMetricValue(item, key, meta.custom);
      return Number.isFinite(Number(value))
        ? `<span>${escapeHtml(meta.label)} ${Number(value)}</span>`
        : "";
    }).filter(Boolean).join("");
    const factors = item.factors?.length
      ? `因素：${item.factors.map(escapeHtml).join("、")}`
      : "未记录因素";
    const syncing = item._sync?.status;
    const actions = syncing
      ? `<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
      : `<span><button type="button" data-edit-checkin="${escapeHtml(item.id)}" aria-label="编辑 ${escapeHtml(eventDate(item))} ${formatTime(eventTimestamp(item))} 的状态">编辑</button><button type="button" class="danger" data-delete-checkin="${escapeHtml(item.id)}" aria-label="删除这次状态">删除</button></span>`;
    return `<article class="checkin-history-entry${syncing ? " is-syncing" : ""}" data-checkin-id="${escapeHtml(item.id)}"><header><time>${escapeHtml(eventDate(item))} · ${formatTime(eventTimestamp(item))}</time>${actions}</header><div>${values}</div><p>${factors}</p></article>`;
  }).join("")}</div>`;
  return true;
}

export function renderStateTrend({
  root,
  snapshot = {},
  activeDate,
  emptyStateMarkup
} = {}) {
  const chart = root?.querySelector?.("#state-chart");
  if (!chart) return false;
  const range = Number(root.querySelector?.("#chart-range")?.value || 30);
  const trend = buildCheckinTrend(snapshot.checkins, snapshot.customMetrics, {
    endDate: activeDate,
    days: range
  });
  renderCheckinHistory(root, trend.available, snapshot.customMetrics);
  if (!trend.daily.length) {
    chart.innerHTML = emptyStateMarkup({
      title: "还没有状态趋势",
      body: "第一次记录只会形成起点，后续记录会按日期连成趋势。",
      action: { command: "new-state", label: "记录此刻状态" }
    });
    return true;
  }

  const width = 900;
  const height = 250;
  const left = 42;
  const right = 18;
  const top = 20;
  const bottom = 42;
  const x = index => trend.daily.length === 1
    ? width / 2
    : left + index * (width - left - right) / (trend.daily.length - 1);
  const y = value => top + (5 - value) * (height - top - bottom) / 4;
  const valueOf = (day, key) => key.startsWith("custom.")
    ? day.custom[key.slice(7)]
    : day[key];
  const pathFor = key => trend.daily
    .map((day, index) => ({ index, value: valueOf(day, key) }))
    .filter(point => Number.isFinite(point.value))
    .map((point, index) => `${index ? "L" : "M"}${x(point.index)},${y(point.value)}`)
    .join(" ");
  const labels = trend.daily.map((day, index) => (
    index === 0 || index === trend.daily.length - 1 || trend.daily.length <= 7
      ? `<text x="${x(index)}" y="232" text-anchor="middle">${day.date.slice(5)}</text>`
      : ""
  )).join("");
  const grid = [1, 2, 3, 4, 5].map(value => (
    `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="25" y="${y(value) + 4}">${value}</text>`
  )).join("");
  const paleLines = trend.series.map(item => {
    const path = pathFor(item.key);
    const dots = trend.daily.map((day, index) => {
      const value = valueOf(day, item.key);
      return Number.isFinite(value)
        ? `<circle class="metric-dot" style="--series:${item.color}" cx="${x(index)}" cy="${y(value)}" r="3.5"><title>${day.date} · ${escapeHtml(item.label)} ${trend.round(value)} · ${day.entries} 次提交均值</title></circle>`
        : "";
    }).join("");
    return path
      ? `<path class="metric-line" style="--series:${item.color}" d="${path}"/>${dots}`
      : "";
  }).join("");
  const scorePath = pathFor("composite");
  const scoreDots = trend.daily.map((day, index) => (
    Number.isFinite(day.composite)
      ? `<circle class="score-dot" cx="${x(index)}" cy="${y(day.composite)}" r="5"><title>${day.date} · 综合 ${day.score}/100 · ${day.entries} 次提交均值</title></circle>`
      : ""
  )).join("");
  const current = trend.current;
  const summary = [
    ["情绪", current.mood],
    ["精力", current.energy],
    ["压力", current.stress],
    ["睡眠", current.sleep]
  ].map(([label, value]) => `${label} ${trend.round(value)}`).join(" · ");
  chart.innerHTML = `<div class="chart-stats"><span><b>${trend.daily.length}</b> 个记录日</span><span><b>${trend.eligible.length}</b> 次提交</span><span><b>${current.score ?? "—"}</b> 最新综合分</span></div><div class="chart-day-summary"><b>${current.date}</b><span>${current.entries} 次提交取均值：${summary}</span></div><div class="chart-legend">${trend.series.map(item => `<span><i style="--series:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}<span class="score-legend"><i></i>综合状态</span></div><svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="所有状态指标的每日均值与综合状态趋势"><g class="chart-grid">${grid}${labels}</g>${paleLines}<path class="score-line" d="${scorePath}"/>${scoreDots}</svg><p class="score-method">所有指标均为 1 最差、5 最好。综合分 = 情绪 30% + 精力 30% + 睡眠 25% + 压力状态 15%，再换算为 0–100。自定义指标只展示趋势，不擅自计入总分。</p>`;
  return true;
}

export function renderHomeMood({
  root,
  snapshot = {},
  activeDate,
  document
} = {}) {
  const svg = root?.querySelector?.("#home-mood-sparkline");
  if (!svg) return false;
  const series = buildHomeMoodSeries(snapshot.checkins, activeDate, 7);
  const available = series.filter(item => Number.isFinite(item.value));
  const namespace = "http://www.w3.org/2000/svg";
  const x = index => 10 + index * 260 / Math.max(1, series.length - 1);
  const y = value => 49 - (value - 1) * 10;
  svg.replaceChildren();
  if (!available.length) {
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", "3");
    label.setAttribute("y", "34");
    label.textContent = "还没有记录";
    svg.append(label);
    svg.setAttribute("aria-label", "近 7 日还没有情绪记录");
    return true;
  }
  let segment = [];
  const drawSegment = () => {
    if (segment.length > 1) {
      const line = document.createElementNS(namespace, "polyline");
      line.setAttribute("points", segment.map(item => `${x(item.index)},${y(item.value)}`).join(" "));
      svg.append(line);
    }
    segment = [];
  };
  series.forEach((item, index) => {
    if (Number.isFinite(item.value)) segment.push({ ...item, index });
    else drawSegment();
  });
  drawSegment();
  series.forEach((item, index) => {
    if (!Number.isFinite(item.value)) return;
    const point = document.createElementNS(namespace, "circle");
    const title = document.createElementNS(namespace, "title");
    point.setAttribute("cx", x(index));
    point.setAttribute("cy", y(item.value));
    point.setAttribute("r", "2.6");
    title.textContent = `${item.date} · 情绪 ${item.value.toFixed(2)} · ${item.count} 次记录均值`;
    point.append(title);
    svg.append(point);
  });
  svg.setAttribute("aria-label", `近 7 日有 ${available.length} 个情绪记录日；查看趋势可读详细数值。`);
  return true;
}

export function renderCheckinsPresentation(options = {}) {
  const stateRendered = renderStateTrend(options);
  const moodRendered = renderHomeMood(options);
  return stateRendered || moodRendered;
}
