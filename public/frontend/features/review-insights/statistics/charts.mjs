export const compactNumber = value => new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1
}).format(Number(value) || 0);

export function formatCny(value) {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  const digits = absolute === 0
    ? 2
    : absolute >= 100
      ? 0
      : absolute >= 10
        ? 1
        : absolute >= 1
          ? 2
          : absolute >= 0.1
            ? 3
            : absolute >= 0.01 ? 4 : 6;
  return `${number < 0 ? "-" : ""}¥${absolute.toFixed(digits)}`;
}

export const formatCnyAxis = value => {
  const number = Number(value) || 0;
  return number !== 0 && Math.abs(number) < 0.000001
    ? `${number < 0 ? "-" : ""}<¥0.000001`
    : formatCny(number);
};

export const formatDuration = value => {
  const milliseconds = Number(value) || 0;
  if (milliseconds >= 60000) return `${(milliseconds / 60000).toFixed(1)} 分钟`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  return `${Math.round(milliseconds)} ms`;
};

const shortDate = value => {
  const [, month, day] = String(value).split("-");
  return `${Number(month)}/${Number(day)}`;
};

export function chartFrame(daily, series, {
  ariaLabel,
  valueLabel = compactNumber,
  actualPeak = false,
  escapeMarkup = value => String(value ?? "")
} = {}) {
  const width = 760;
  const height = 260;
  const pad = { left: 54, right: 18, top: 16, bottom: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const peak = Math.max(
    0,
    ...series.flatMap(item => item.values).map(value => Number(value) || 0)
  );
  const scaleMax = actualPeak ? (peak || 1) : Math.max(1, peak);
  const axisMax = actualPeak ? peak : scaleMax;
  const x = index => pad.left + (
    daily.length <= 1 ? plotWidth / 2 : index * plotWidth / (daily.length - 1)
  );
  const y = value => pad.top + plotHeight
    - (Number(value) || 0) / scaleMax * plotHeight;
  const grid = (actualPeak && peak === 0 ? [0] : [0, 0.5, 1])
    .map(ratio => {
      const py = pad.top + plotHeight * (1 - ratio);
      return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}"></line><text x="${pad.left - 9}" y="${py + 4}" text-anchor="end">${escapeMarkup(
        valueLabel(axisMax * ratio)
      )}</text>`;
    }).join("");
  const labelIndexes = [0, Math.floor((daily.length - 1) / 2), daily.length - 1]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index);
  const dates = labelIndexes.map(index => (
    `<text x="${x(index)}" y="${height - 12}" text-anchor="${
      index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"
    }">${escapeMarkup(shortDate(daily[index]?.date || ""))}</text>`
  )).join("");
  const paths = series.map(item => {
    const points = item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
    const dots = item.values.length <= 31
      ? item.values.map((value, index) => (
        `<circle cx="${x(index)}" cy="${y(value)}" r="3"><title>${escapeMarkup(
          `${item.label} · ${daily[index]?.date} · ${valueLabel(value)}`
        )}</title></circle>`
      )).join("")
      : "";
    return `<g class="analytics-series" style="--series:${item.color}"><polyline points="${points}"></polyline>${dots}</g>`;
  }).join("");
  const legend = series.map(item => (
    `<span><i style="--series:${item.color}"></i>${escapeMarkup(item.label)}</span>`
  )).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeMarkup(
    ariaLabel || "统计图"
  )}"><g class="analytics-grid">${grid}${dates}</g>${paths}</svg><div class="analytics-legend">${legend}</div>`;
}

export function stackedTokenChart(daily, escapeMarkup = value => String(value ?? "")) {
  const width = 760;
  const height = 260;
  const pad = { left: 54, right: 18, top: 16, bottom: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const answer = daily.map(item => item.tokens?.answer || 0);
  const reasoning = daily.map(item => item.tokens?.reasoning || 0);
  const total = answer.map((value, index) => value + reasoning[index]);
  const max = Math.max(1, ...total);
  const x = index => pad.left + (
    daily.length <= 1 ? plotWidth / 2 : index * plotWidth / (daily.length - 1)
  );
  const y = value => pad.top + plotHeight - value / max * plotHeight;
  const path = values => values
    .map((value, index) => `${index ? "L" : "M"} ${x(index)} ${y(value)}`)
    .join(" ");
  const area = (top, bottom) => (
    `${path(top)} ${bottom.map((_, index) => (
      `L ${x(bottom.length - 1 - index)} ${y(bottom[bottom.length - 1 - index])}`
    )).join(" ")} Z`
  );
  const grid = [0, 0.5, 1].map(ratio => {
    const py = pad.top + plotHeight * (1 - ratio);
    return `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}"></line><text x="${pad.left - 9}" y="${py + 4}" text-anchor="end">${escapeMarkup(
      compactNumber(max * ratio)
    )}</text>`;
  }).join("");
  const labelIndexes = [0, Math.floor((daily.length - 1) / 2), daily.length - 1]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index);
  const dates = labelIndexes.map(index => (
    `<text x="${x(index)}" y="${height - 12}" text-anchor="${
      index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"
    }">${escapeMarkup(shortDate(daily[index]?.date || ""))}</text>`
  )).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="回答与推理 Token 每日面积图"><g class="analytics-grid">${grid}${dates}</g><path class="analytics-area answer" d="${area(
    answer,
    answer.map(() => 0)
  )}"></path><path class="analytics-area reasoning" d="${area(
    total,
    answer
  )}"></path><path class="analytics-area-line answer" d="${path(
    answer
  )}"></path><path class="analytics-area-line reasoning" d="${path(
    total
  )}"></path></svg><div class="analytics-legend"><span><i style="--series:#4f8d78"></i>回答</span><span><i style="--series:#c18c3f"></i>推理</span></div>`;
}
