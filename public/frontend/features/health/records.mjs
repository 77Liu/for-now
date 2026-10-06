import { eventDate, eventTimestamp, formatTime, toLocalDateTimeInput } from "../../time/index.mjs";

function requireFunction(value, name) {if (typeof value !== "function") throw new TypeError(`Health records require ${name}`);return value}

const durationLabel = value => Number.isFinite(Number(value)) ? `${Math.floor(Number(value) / 60)}小时${String(Math.round(Number(value) % 60)).padStart(2, "0")}分` : "—";
const valueLabel = (value, suffix = "") => value == null ? "—" : `${value}${suffix}`;
const secondsLabel = value => Number.isFinite(value) ? [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(part => String(part).padStart(2, "0")).join(":") : "";

export function createHealthRecordsView({
  view,
  getRecords,
  getActiveType,
  switchType,
  resetOccurrenceInput,
  viewerAttachmentPath,
  escapeMarkup,
  typeMeta
} = {}) {
  for (const [name, value] of Object.entries({
    getRecords,
    getActiveType,
    switchType,
    resetOccurrenceInput,
    viewerAttachmentPath,
    escapeMarkup
  })) requireFunction(value, name);
  for (const method of ["query", "queryAll", "form", "resetForm"]) {
    requireFunction(view?.[method], `view.${method}`);
  }
  if (!typeMeta || typeof typeMeta !== "object") {
    throw new TypeError("Health records require typeMeta");
  }

  let activeWeightTrendMetric = "weight";
  const records = () => Array.isArray(getRecords()) ? getRecords() : [];

  function fillField(field, value) {
    if (field.matches?.("[data-duration]")) field.value = secondsLabel(value);
    else if (field.type === "datetime-local") {
      field.value = value ? toLocalDateTimeInput(value) : "";
    } else {
      field.value = Array.isArray(value) ? JSON.stringify(value) : value ?? "";
    }
  }

  function structuredValues(item) {
    const values = [...view.form(item.type).querySelectorAll("[data-health-metric]")]
      .filter(field => Number.isFinite(item[field.name]));
    return values.length
      ? `<div class="daily-values">${values.map(field => `<span><b>${escapeMarkup(field.hasAttribute("data-duration") ? secondsLabel(item[field.name]) : item[field.name])}</b>${escapeMarkup(field.closest("label").querySelector("span").textContent)}</span>`).join("")}</div>`
      : "";
  }

  function attachmentsMarkup(item) {
    const paths = (Array.isArray(item?.attachmentPaths) ? item.attachmentPaths : [])
      .map(viewerAttachmentPath)
      .filter(Boolean);
    return paths.length
      ? `<div class="daily-attachments" aria-label="${escapeMarkup(typeMeta[item.type]?.label || "健康")}截图">${paths.map((path, index) => `<button type="button" data-image-viewer-path="${escapeMarkup(path)}">查看截图 ${index + 1}</button>`).join("")}</div>`
      : "";
  }

  const weightSummaryValue = (value, digits = 1, suffix = "") => (
    Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : "—"
  );

  function weightRecordBody(item, actions, expanded = false) {
    const adjustedWeight = Number.isFinite(item.adjustedWeight)
      ? item.adjustedWeight
      : item.measuredWeight;
    const weightDetail = Number.isFinite(item.adjustedWeight)
      && Number.isFinite(item.measuredWeight)
      ? `<div class="weight-record-value"><strong>${item.adjustedWeight.toFixed(2)} kg</strong><span>秤上 ${item.measuredWeight.toFixed(2)} kg · ${item.clothing === "none" ? "不穿衣" : item.clothing === "light" ? "轻便衣物" : "厚重衣物"}</span>${item.clothing !== "none" && Number.isFinite(item.lower95) && Number.isFinite(item.upper95) ? `<small>95% 估计区间 ${item.lower95.toFixed(2)}–${item.upper95.toFixed(2)} kg</small>` : ""}</div>`
      : '<p class="weight-model-note">总重量未填写 · 仅记录体成分或描述</p>';
    const description = item.description
      ? `<p class="exercise-description">${escapeMarkup(item.description)}</p>`
      : "";
    const verification = item.verification
      ? `<p class="weight-model-note">识别核对：${escapeMarkup(item.verification)}</p>`
      : "";
    return `<div class="weight-record-summary" role="group" aria-label="体重关键指标"><span class="primary"><b>${weightSummaryValue(adjustedWeight, 2, " kg")}</b><small>${Number.isFinite(item.adjustedWeight) ? "体重（衣物校正）" : "体重"}</small></span><span><b>${weightSummaryValue(item.bodyFatPercent, 1, "%")}</b><small>体脂率</small></span><span><b>${weightSummaryValue(item.muscleMass, 1, " kg")}</b><small>肌肉量</small></span></div><details class="weight-record-details" ${expanded ? "open" : ""}><summary>查看体成分与记录详情</summary><div class="weight-record-detail-body">${weightDetail}${structuredValues(item)}${description}${verification}${attachmentsMarkup(item)}<footer>${actions}</footer></div></details>`;
  }

  function weightChart(items) {
    const metrics = {
      weight: {
        label: "体重",
        unit: "kg",
        value: item => Number.isFinite(item.adjustedWeight)
          ? item.adjustedWeight
          : item.measuredWeight,
        interval: true
      },
      bodyFatPercent: { label: "体脂率", unit: "%", value: item => item.bodyFatPercent },
      muscleMass: { label: "肌肉量", unit: "kg", value: item => item.muscleMass }
    };
    const metric = metrics[activeWeightTrendMetric] || metrics.weight;
    const controls = `<div class="weight-chart-heading"><div class="weight-trend-controls" role="group" aria-label="体重趋势指标">${Object.entries(metrics).map(([key, value]) => `<button type="button" data-weight-trend="${key}" class="${key === activeWeightTrendMetric ? "active" : ""}" aria-pressed="${key === activeWeightTrendMetric}">${value.label}</button>`).join("")}</div><small>最近 30 条体重记录</small></div>`;
    const recent = [...items]
      .sort((left, right) => (left.measuredAt || eventTimestamp(left)).localeCompare(
        right.measuredAt || eventTimestamp(right)
      ))
      .slice(-30);
    const points = recent.map(item => ({
      ...item,
      _trendAt: item.measuredAt || eventTimestamp(item),
      _trendValue: metric.value(item)
    })).filter(item => Number.isFinite(item._trendValue));
    if (!points.length) {
      return `${controls}<p class="weight-chart-empty">当前记录没有可绘制的${metric.label}数据。</p>`;
    }
    const width = 900, height = 220, left = 48, right = 24, top = 18, bottom = 40;
    const values = metric.interval
      ? points.flatMap(item => [item.lower95, item.upper95, item._trendValue]).filter(Number.isFinite)
      : points.map(item => item._trendValue);
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const padding = rawMax === rawMin
      ? Math.max(Math.abs(rawMin) * .02, .5)
      : Math.max((rawMax - rawMin) * .12, .2);
    const min = Math.max(0, rawMin - padding), max = rawMax + padding;
    const times = points.map(item => Date.parse(item._trendAt))
      .map((value, index) => Number.isFinite(value) ? value : index);
    const firstTime = Math.min(...times), lastTime = Math.max(...times);
    const x = index => points.length === 1 || firstTime === lastTime
      ? width / 2
      : left + (times[index] - firstTime) * (width - left - right) / (lastTime - firstTime);
    const y = value => top + (max - value) * (height - top - bottom) / (max - min || 1);
    const grid = [min, (min + max) / 2, max].map(value => `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${value.toFixed(1)}</text>`).join("");
    const marks = points.map((item, index) => {
      const px = x(index), date = eventDate({ occurredAt: item._trendAt });
      const interval = metric.interval && item.clothing !== "none"
        && Number.isFinite(item.lower95) && Number.isFinite(item.upper95)
        ? `<line class="weight-interval" x1="${px}" x2="${px}" y1="${y(item.upper95)}" y2="${y(item.lower95)}"/><line class="weight-cap" x1="${px - 5}" x2="${px + 5}" y1="${y(item.upper95)}" y2="${y(item.upper95)}"/><line class="weight-cap" x1="${px - 5}" x2="${px + 5}" y1="${y(item.lower95)}" y2="${y(item.lower95)}"/>`
        : "";
      return `${interval}<circle class="weight-point" cx="${px}" cy="${y(item._trendValue)}" r="5"><title>${date} · ${metric.label} ${item._trendValue} ${metric.unit}${interval ? ` · 95% ${item.lower95}～${item.upper95} kg` : ""}</title></circle><text class="weight-date" x="${px}" y="${height - 14}" text-anchor="middle">${date.slice(5)}</text>`;
    }).join("");
    const legend = metric.interval
      ? '<div class="weight-chart-legend"><span><i></i>衣物校正值</span><span><i class="interval"></i>穿衣记录 95% 估计区间</span></div>'
      : `<div class="weight-chart-legend"><span><i></i>${metric.label}（${metric.unit}）</span></div>`;
    const note = metric.interval
      ? "图中使用衣物校正值；区间来自固定衣物重量假设，不代表体脂秤测量误差或医学置信区间。"
      : "缺失记录不补零、不推算；横向位置按测量时间，日期不连续时保留真实间隔。";
    return `${controls}${legend}<svg class="weight-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近${metric.label}趋势"><g class="weight-grid">${grid}</g>${marks}</svg><p class="weight-chart-note">${note}</p>`;
  }

  function healthMetricChart(items, type) {
    const metrics = {
      sleep: {
        label: "总睡眠",
        unit: "小时",
        value: item => Number.isFinite(item.totalMinutes) ? item.totalMinutes / 60 : null,
        title: item => durationLabel(item.totalMinutes)
      },
      heartRate: {
        label: "心率",
        unit: "bpm",
        value: item => item.average,
        title: item => Number.isFinite(item.average)
          ? `平均 ${item.average} bpm`
          : `范围 ${item.minimum}–${item.maximum} bpm`,
        range: item => [item.minimum, item.maximum]
      },
      exercise: {
        label: "运动时长",
        unit: "分钟",
        value: item => Number.isFinite(item.durationSeconds) ? item.durationSeconds / 60 : null,
        title: item => secondsLabel(item.durationSeconds)
      }
    };
    const metric = metrics[type];
    if (!metric) return "";
    const heading = `<div class="weight-chart-heading health-chart-heading"><strong>${metric.label}趋势</strong><small>最近 30 条${typeMeta[type].label}记录</small></div>`;
    const points = [...items]
      .sort((left, right) => eventTimestamp(left).localeCompare(eventTimestamp(right)))
      .slice(-30)
      .map(item => ({
        ...item,
        _trendAt: eventTimestamp(item),
        _trendValue: metric.value(item),
        _trendRange: metric.range?.(item) || []
      }))
      .filter(item => Number.isFinite(item._trendValue)
        || (item._trendRange.length === 2 && item._trendRange.every(Number.isFinite)));
    if (!points.length) {
      return `${heading}<p class="weight-chart-empty">当前记录没有可绘制的${metric.label}数据。</p>`;
    }
    const width = 900, height = 220, left = 48, right = 24, top = 18, bottom = 40;
    const values = points.flatMap(item => [item._trendValue, ...item._trendRange].filter(Number.isFinite));
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const padding = rawMax === rawMin
      ? Math.max(Math.abs(rawMin) * .05, 1)
      : Math.max((rawMax - rawMin) * .12, .5);
    const min = Math.max(0, rawMin - padding), max = rawMax + padding;
    const times = points.map(item => Date.parse(item._trendAt))
      .map((value, index) => Number.isFinite(value) ? value : index);
    const firstTime = Math.min(...times), lastTime = Math.max(...times);
    const x = index => points.length === 1 || firstTime === lastTime
      ? width / 2
      : left + (times[index] - firstTime) * (width - left - right) / (lastTime - firstTime);
    const y = value => top + (max - value) * (height - top - bottom) / (max - min || 1);
    const grid = [min, (min + max) / 2, max].map(value => `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${value.toFixed(1)}</text>`).join("");
    const marks = points.map((item, index) => {
      const px = x(index), date = eventDate({ occurredAt: item._trendAt });
      const range = item._trendRange;
      const interval = range.length === 2 && range.every(Number.isFinite)
        ? `<line class="health-range" x1="${px}" x2="${px}" y1="${y(range[1])}" y2="${y(range[0])}"/><line class="health-range-cap" x1="${px - 5}" x2="${px + 5}" y1="${y(range[1])}" y2="${y(range[1])}"/><line class="health-range-cap" x1="${px - 5}" x2="${px + 5}" y1="${y(range[0])}" y2="${y(range[0])}"/>`
        : "";
      const point = Number.isFinite(item._trendValue)
        ? `<circle class="weight-point" cx="${px}" cy="${y(item._trendValue)}" r="5"><title>${date} · ${metric.title(item)}</title></circle>`
        : "";
      return `${interval}${point}<text class="weight-date" x="${px}" y="${height - 14}" text-anchor="middle">${date.slice(5)}</text>`;
    }).join("");
    const legend = type === "heartRate"
      ? '<div class="weight-chart-legend"><span><i></i>平均心率</span><span><i class="range"></i>最低至最高</span></div>'
      : `<div class="weight-chart-legend"><span><i></i>${metric.label}（${metric.unit}）</span></div>`;
    return `${heading}${legend}<svg class="weight-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近${metric.label}趋势"><g class="weight-grid">${grid}</g>${marks}</svg><p class="weight-chart-note">缺失记录不补零、不推算；横向位置按发生时间，日期不连续时保留真实间隔。</p>`;
  }

  function recordCard(item, { expanded = false } = {}) {
    const labels = { sleep: "睡眠", heartRate: "心率", weight: "体重", exercise: "运动" };
    const source = item.source === "screenshot" ? "截图识别" : "手动记录";
    const syncing = item._sync?.status;
    const actions = syncing
      ? `<span class="checkin-sync-state ${escapeMarkup(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
      : `<button type="button" data-daily-edit="${item.id}">编辑</button><button type="button" class="danger" data-daily-delete="${item.id}">删除</button>`;
    let body = "";
    if (item.type === "sleep") {
      body = `<div class="daily-values"><span><b>${durationLabel(item.totalMinutes)}</b>总睡眠</span><span><b>${valueLabel(item.deepMinutes, " 分")}</b>深睡 ${valueLabel(item.deepPercent, "%")}</span><span><b>${valueLabel(item.lightMinutes, " 分")}</b>浅睡 ${valueLabel(item.lightPercent, "%")}</span><span><b>${valueLabel(item.remMinutes, " 分")}</b>快速眼动 ${valueLabel(item.remPercent, "%")}</span><span><b>${valueLabel(item.awakeCount, " 次")}</b>清醒 · ${valueLabel(item.awakeMinutes, " 分")}</span><span><b>${valueLabel(item.averageHeartRate)}</b>心率 · 血氧 ${valueLabel(item.averageOxygen, "%")} · 呼吸 ${valueLabel(item.respiratoryRate)}</span></div>`;
    }
    if (item.type === "heartRate") {
      body = `<div class="daily-values"><span><b>${valueLabel(item.minimum)}–${valueLabel(item.maximum)}</b>心率范围</span><span><b>${valueLabel(item.average)}</b>平均</span><span><b>${valueLabel(item.resting)}</b>静息</span><span><b>${valueLabel(item.sleepAverage)}</b>睡眠平均</span></div>${item.trendAnalysis ? `<details class="heart-trend-disclosure"><summary>查看当天趋势</summary><p class="heart-trend">${escapeMarkup(item.trendAnalysis)}</p></details>` : ""}`;
    }
    if (item.type === "weight") body = weightRecordBody(item, actions, expanded);
    if (item.type === "exercise" && item.exerciseType) {
      body = `<h4 class="exercise-type">${escapeMarkup(item.exerciseType)}</h4>`;
    }
    if (item.type === "exercise") {
      body += structuredValues(item);
      if (item.description) body += `<section class="exercise-description user"><small>记下感受</small><p>${escapeMarkup(item.description)}</p></section>`;
      if (item.recognitionDescription) body += `<section class="exercise-description derived"><small>AI 解析描述</small><p>${escapeMarkup(item.recognitionDescription)}</p></section>`;
      if (item.verification) body += `<p class="weight-model-note">识别核对：${escapeMarkup(item.verification)}</p>`;
    }
    if (item.type !== "weight") body += attachmentsMarkup(item);
    return `<article class="daily-record-entry${syncing ? " is-syncing" : ""}" data-daily-record-id="${item.id}"><header><div><span>${labels[item.type]}</span><time>${escapeMarkup(eventDate(item))} · ${formatTime(eventTimestamp(item))}</time></div><small>${source}</small></header>${body}${item.type === "weight" ? "" : `<footer>${actions}</footer>`}</article>`;
  }

  function render() {
    const type = getActiveType();
    const title = view.query("#daily-history-title");
    const count = view.query("#daily-history-count");
    const chart = view.query("#daily-record-chart");
    const list = view.query("#daily-record-list");
    if (!title || !count || !chart || !list || !typeMeta[type]) return false;
    const expanded = new Set(
      view.queryAll(".weight-record-details[open]")
        .map(details => details.closest("[data-daily-record-id]")?.dataset.dailyRecordId)
        .filter(Boolean)
    );
    const items = records()
      .filter(item => item.type === type)
      .sort((left, right) => eventTimestamp(right).localeCompare(eventTimestamp(left)));
    title.textContent = `${typeMeta[type].label}记录`;
    count.textContent = `${items.length} 条`;
    chart.innerHTML = type === "weight"
      ? weightChart(items)
      : healthMetricChart(items, type);
    list.innerHTML = items.length
      ? items.map(item => recordCard(item, { expanded: expanded.has(item.id) })).join("")
      : `<div class="empty">还没有${escapeMarkup(typeMeta[type].label)}记录。</div>`;
    return true;
  }

  function edit(id) {
    const item = records().find(record => record.id === id);
    if (!item) return false;
    switchType(item.type);
    const form = view.form(item.type);
    view.resetForm(item.type);
    form.elements.recordId.value = item.id;
    resetOccurrenceInput(form.elements.occurredAt, item);
    if (form.elements.attachmentPaths) {
      form.elements.attachmentPaths.value = JSON.stringify(item.attachmentPaths || []);
    }
    for (const [key, value] of Object.entries(item)) {
      if (["id", "type", "createdAt", "occurredAt", "occurredOn", "attachmentPaths", "trendSegments"].includes(key)
        || !form.elements[key]) continue;
      fillField(form.elements[key], value);
    }
    form.querySelectorAll(".daily-details").forEach(details => {
      details.open = [...details.querySelectorAll("input")].some(input => input.value !== "");
    });
    if (form.elements.bedtime) {
      form.elements.bedtime.value = item.bedtime ? toLocalDateTimeInput(item.bedtime) : "";
    }
    if (form.elements.wakeTime) {
      form.elements.wakeTime.value = item.wakeTime ? toLocalDateTimeInput(item.wakeTime) : "";
    }
    if (form.elements.trendSegments) {
      form.elements.trendSegments.value = JSON.stringify(item.trendSegments || []);
    }
    form.querySelector('[type="submit"]').textContent = "保存修改";
    form.querySelector("[data-daily-cancel]").hidden = false;
    form.querySelector(".status").textContent = "正在编辑已有记录";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  function setWeightTrend(metric) {
    if (!["weight", "bodyFatPercent", "muscleMass"].includes(metric)) return false;
    activeWeightTrendMetric = metric;
    return render();
  }

  return Object.freeze({
    edit,
    record: id => records().find(item => item.id === id) || null,
    render,
    setWeightTrend
  });
}

export function createHealthInteractions({
  lifecycle,
  view,
  records,
  getActiveType,
  getLatestRequest,
  bump,
  switchType,
  changeWeightBatchDate,
  mediaOperation,
  submissionOperation
} = {}) {
  for (const [name, value] of Object.entries({
    getActiveType,
    getLatestRequest,
    bump,
    switchType,
    changeWeightBatchDate,
    mediaOperation,
    submissionOperation
  })) requireFunction(value, name);

  function click(event) {
    const tab = event.target.closest?.("[data-daily-tab]");
    if (tab) return switchType(tab.dataset.dailyTab);
    const select = event.target.closest?.("[data-weight-batch-select]");
    if (select) {
      if (getLatestRequest()) return false;
      view.captureActiveWeightItem();
      lifecycle.draft("weight").activeIndex = Number(select.dataset.weightBatchSelect) || 0;
      void lifecycle.persist("weight");
      view.renderUploader();
      return view.applyActiveWeightItem();
    }
    const removeImage = event.target.closest?.("[data-health-image-remove]");
    if (removeImage) {
      void mediaOperation("removeImage", Number(removeImage.dataset.healthImageRemove));
      return true;
    }
    if (event.target.closest?.("#parse-health-images")) {
      void mediaOperation("parseImages");
      return true;
    }
    const trend = event.target.closest?.("[data-weight-trend]");
    if (trend) return records.setWeightTrend(trend.dataset.weightTrend);
    const edit = event.target.closest?.("[data-daily-edit]");
    if (edit) return records.edit(edit.dataset.dailyEdit);
    const removeRecord = event.target.closest?.("[data-daily-delete]");
    if (removeRecord) {
      void submissionOperation("removeRecord", removeRecord);
      return true;
    }
    const cancel = event.target.closest?.("[data-daily-cancel]");
    if (!cancel) return false;
    const type = cancel.closest("[data-daily-form]")?.dataset.dailyForm;
    view.resetForm(type);
    if (type === "weight") view.applyActiveWeightItem();
    return true;
  }

  function formChange(event) {
    const target = event.target.closest?.("[data-daily-form]");
    if (!target) return;
    bump();
    if (target.dataset.dailyForm === "weight") {
      view.captureActiveWeightItem();
      void lifecycle.persist("weight");
      view.renderUploader();
    } else {
      view.query("#parse-health-images").disabled = !lifecycle.files(getActiveType()).length;
    }
  }

  function change(event) {
    const imageInput = event.target.closest?.("#health-images");
    if (imageInput) {
      void mediaOperation("setImages", imageInput.files, "本地文件").then(ok => {
        if (!ok) imageInput.value = "";
      });
      return;
    }
    const dateInput = event.target.closest?.("[data-weight-batch-date]");
    if (dateInput) {
      const draft = lifecycle.draft("weight");
      const index = Number(dateInput.dataset.weightBatchDate);
      const item = draft.items[index];
      if (!item) return;
      view.captureActiveWeightItem();
      try {
        draft.items[index] = changeWeightBatchDate(item, dateInput.value);
        bump();
        if (index === draft.activeIndex) view.applyActiveWeightItem();
        view.renderUploader();
        void lifecycle.persist("weight");
      } catch (error) {
        view.status().textContent = error.message;
      }
      return;
    }
    formChange(event);
  }

  function keydown(event) {
    if (!event.target.closest?.("#health-upload-box")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    view.query("#health-images")?.click();
  }

  function drag(event) {
    const box = event.target.closest?.("#health-upload-box");
    if (!box) return;
    if (event.type === "dragenter" || event.type === "dragover") {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      box.classList.add("dragging");
      return;
    }
    if (event.type === "dragleave") {
      if (!box.contains(event.relatedTarget)) box.classList.remove("dragging");
      return;
    }
    event.preventDefault();
    box.classList.remove("dragging");
    const files = [...(event.dataTransfer?.files || [])].filter(
      item => item.type.startsWith("image/")
    );
    void mediaOperation(
      "setImages",
      files,
      "拖入图片",
      ["sleep", "weight"].includes(getActiveType())
    );
  }

  function paste(event) {
    if (event.target.closest?.("input,textarea,[contenteditable=true]")) return;
    const files = [...(event.clipboardData?.files || [])].filter(
      item => item.type.startsWith("image/")
    );
    if (!files.length) return;
    event.preventDefault();
    void mediaOperation(
      "setImages",
      files,
      "剪贴板",
      ["sleep", "weight"].includes(getActiveType())
    );
  }

  function submit(event) {
    const form = event.target.closest?.("[data-daily-form]");
    if (!form) return;
    event.preventDefault();
    void submissionOperation("submit", form).catch(error => {
      const status = form.querySelector?.(".status");
      if (status) status.textContent = error.message;
    });
  }

  return Object.freeze({
    listeners: Object.freeze({
      click,
      change,
      input: formChange,
      submit,
      keydown,
      dragenter: drag,
      dragover: drag,
      dragleave: drag,
      drop: drag
    }),
    paste
  });
}
