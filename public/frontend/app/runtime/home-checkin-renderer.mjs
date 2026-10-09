import { checkinMetricValue, createCheckinMetricConfig } from "../../features/checkins-model/index.mjs";

export function createHomeCheckinRenderer({ $, $$, getState, runtime, eventTimestamp, escapeHtml } = {}) {
  const metricConfig = () => createCheckinMetricConfig(getState().customMetrics);
  const metricValue = checkinMetricValue;

  function metricReference(key, custom) {
    const state = getState();
    const eligible = state.checkins
      .filter(item => item.occurredOn <= runtime.activeDate)
      .sort((left, right) => (
        right.occurredOn.localeCompare(left.occurredOn)
        || eventTimestamp(right).localeCompare(eventTimestamp(left))
      ));
    const previous = eligible
      .map(item => metricValue(item, key, custom))
      .find(value => Number.isFinite(Number(value)));
    const history = eligible
      .slice(0, 30)
      .map(item => Number(metricValue(item, key, custom)))
      .filter(Number.isFinite);
    const average = history.length
      ? history.reduce((sum, value) => sum + value, 0) / history.length
      : null;

    return { previous: previous == null ? null : Number(previous), average };
  }

  function metricMarker(kind, value, label) {
    if (!Number.isFinite(value)) return "";
    const position = Math.max(0, Math.min(100, (value - 1) * 25));
    const thumbOffset = 11 - position * 0.22;
    const left = `calc(${position}% + ${thumbOffset.toFixed(3)}px)`;
    return `<span class="metric-history-marker ${kind}" style="left:${left}" data-position="${position}" role="img" aria-label="${label} ${value.toFixed(2)}" title="${label} ${value.toFixed(2)}"></span>`;
  }

  function sliderTemplate(key, config) {
    const reference = metricReference(key, config.custom);
    const value = reference.previous ?? (
      reference.average == null ? 3 : Math.round(reference.average)
    );
    return [
      `<div class="metric unconfirmed"><div class="metric-top"><span class="metric-label">${escapeHtml(config.label)}</span>`,
      `<span class="anchor" id="${key}-anchor">待确认 · ${escapeHtml(config.anchors[value - 1])}</span><button class="note-toggle" type="button" data-note="${key}" aria-expanded="false">＋备注</button></div>`,
      `<div class="metric-scale">${metricMarker("previous", reference.previous, "上一次")}${metricMarker("average", reference.average, "近30次平均")}`,
      `<input type="range" id="metric-${key}" data-metric="${key}" data-custom="${config.custom ? "1" : "0"}" data-confirmed="false" min="1" max="5" value="${value}" step="1" aria-label="${escapeHtml(config.label)} 1到5，必须确认"></div>`,
      `<div class="range-labels"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div>`,
      `<input class="note-field" id="${key}-note" placeholder="可选：补充一句话" maxlength="800"></div>`
    ].join("");
  }

  function renderSliders() {
    const config = metricConfig();
    const historyLegend = `<div class="metric-history-legend" aria-label="历史参照图例"><span><i class="previous"></i>上一次</span><span><i class="average"></i>近30次平均</span></div>`;
    const sliderMarkup = Object.entries(config)
      .map(([key, value]) => sliderTemplate(key, value))
      .join("");
    $("#sliders").innerHTML = `${historyLegend}${sliderMarkup}`;

    $$('[data-metric]').forEach(input => {
      const update = (confirmed = false) => {
        if (confirmed) {
          input.dataset.confirmed = "true";
          input.closest(".metric").classList.remove("unconfirmed");
        }
        const prefix = input.dataset.confirmed === "true" ? "" : "待确认 · ";
        const anchor = $(`#${CSS.escape(input.dataset.metric)}-anchor`);
        anchor.textContent = `${prefix}${config[input.dataset.metric].anchors[Number(input.value) - 1]}`;
      };
      input.addEventListener("input", () => update(true));
      input.addEventListener("change", () => navigator.vibrate?.(8));
      input.addEventListener("pointerdown", () => update(true));
      update();
    });

    $$(".note-toggle").forEach(button => {
      button.addEventListener("click", () => {
        const field = $(`#${CSS.escape(button.dataset.note)}-note`);
        field.classList.toggle("visible");
        button.setAttribute("aria-expanded", String(field.classList.contains("visible")));
        if (field.classList.contains("visible")) field.focus();
      });
    });
  }

  return Object.freeze({ metricConfig, metricValue, renderSliders });
}
