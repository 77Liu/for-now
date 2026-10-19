import { WEIGHT_BATCH_MAX_ITEMS } from "./drafts.mjs";
import { reasoningDisclosureMarkup } from "../ui/index.mjs";

const formatBytes=value=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;

function fillField(field,value,toLocalDateTimeInput){
  if(field.matches?.("[data-duration]"))field.value=Number.isFinite(value)?[Math.floor(value/3600),Math.floor(value%3600/60),value%60].map(part=>String(part).padStart(2,"0")).join(":"):"";
  else if(field.type==="datetime-local")field.value=value?toLocalDateTimeInput(value):"";
  else field.value=Array.isArray(value)?JSON.stringify(value):value??""
}

function weightStatus(item,index){
  if(item.submissionOperationId||item.status==="queued")return"待同步";
  if(item.status==="recognizing")return"正在识别";
  if(item.status==="uploading")return"正在上传";
  if(item.status==="conflict")return"同步冲突，核对后重试";
  if(item.recognitionError||item.lastError)return item.recognitionError?.message||item.lastError?.message||"处理失败，可重试";
  if(item.recognition)return item.dateMismatch?`识别日期 ${item.recognizedDate}，请核对`:"已识别，待核对";
  return `第 ${index + 1} 张 · 待识别`;
}

export function healthDraftStatus(type,draft){
  if(type==="weight")return draft.items.some(item=>item.submissionOperationId)?"部分体重记录已在待同步队列，其余截图仍可继续核对。":draft.items.some(item=>item.recognition)?"已恢复识别结果，请核对后保存。":draft.items.length?`已恢复 ${draft.items.length} 张待识别截图。`:"";
  if(draft.submissionOperationId)return"日录已在待同步队列，截图保留到服务端确认。";
  if(draft.result)return"已恢复识别结果，请核对后保存。";
  return draft.items.length?`已恢复 ${draft.items.length} 张待识别截图。`:"";
}

export function createHealthView({
  getRoot,
  getActiveDate,
  getActiveType,
  lifecycle,
  typeMeta,
  resetOccurrenceInput,
  escapeMarkup,
  localDateTimeForDate,
  toLocalDateTimeInput,
  touch,
  getLatestRequest,
  objectUrls = globalThis.URL
}) {
  let previewUrls = [];
  const root = () => getRoot() || null;
  const query = selector => root()?.querySelector?.(selector) || null;
  const queryAll = selector => [...(root()?.querySelectorAll?.(selector) || [])];
  const form = type => query(`[data-daily-form="${String(type)}"]`);
  const activeDraft = (type = getActiveType()) => lifecycle.draft(type);

  function revokePreviews() {
    for (const url of previewUrls) objectUrls?.revokeObjectURL?.(url);
    previewUrls = [];
  }

  function clearSurface() {
    revokePreviews();
    const input = query("#health-images");
    if(input)input.value="";
    const previews = query("#health-image-previews");
    if(previews)previews.innerHTML="";
    query("#health-upload-box")?.classList.remove("has-image", "dragging");
    const parse = query("#parse-health-images");
    if(parse)parse.disabled=true;
    const status = query("#health-parse-status");
    if(status)status.textContent="";
    const reasoning = query("#health-recognition-reasoning");
    if (reasoning) reasoning.innerHTML = "";
  }

  function applyRecognitionResult(type, result) {
    const target = form(type);
    if (!target || !result) return false;
    const reasoning = query("#health-recognition-reasoning");
    if (reasoning) reasoning.innerHTML = reasoningDisclosureMarkup(result);
    let normalized = result;
    if (type === "exercise") {
      const { description, ...rest } = result;
      normalized = {
        ...rest,
        ...(!result.recognitionDescription && description
          ? { recognitionDescription: description }
          : {})
      };
    }
    for (const [key, value] of Object.entries(normalized)) {
      if (["attachmentPaths", "date"].includes(key) || !target.elements[key]) continue;
      fillField(target.elements[key], value, toLocalDateTimeInput);
    }
    target.elements.attachmentPaths.value = JSON.stringify(result.attachmentPaths || []);
    const recognizedTime = result.wakeTime || result.measuredAt || result.startedAt;
    if (recognizedTime) {
      target.elements.occurredAt.dataset.occurrenceMode = "manual";
      fillField(target.elements.occurredAt, recognizedTime, toLocalDateTimeInput);
    } else if (result.date) {
      target.elements.occurredAt.dataset.occurrenceMode = "manual";
      target.elements.occurredAt.value = localDateTimeForDate(result.date);
    }
    target.querySelectorAll(".daily-details").forEach(details => {
      details.open = [...details.querySelectorAll("input")].some(input => input.value !== "");
    });
    return true;
  }

  function resetForm(type = getActiveType()) {
    touch();
    const target = form(type);
    if (!target) return false;
    target.reset();
    delete target.dataset.requestId;
    delete target.dataset.weightBatchItemId;
    target.elements.recordId.value = "";
    if (target.elements.attachmentPaths) target.elements.attachmentPaths.value = "";
    resetOccurrenceInput(target.elements.occurredAt);
    target.querySelector('[type="submit"]').textContent = typeMeta[type].save;
    target.querySelector('[type="submit"]').disabled = false;
    target.querySelector("[data-daily-cancel]").hidden = true;
    target.querySelector(".status").textContent = "";
    for (const key of ["verification", "trendSegments"]) {
      if (target.elements[key]) target.elements[key].value = "";
    }
    target.querySelectorAll(".daily-details").forEach(details => {
      details.open = false;
    });
    if (type === getActiveType()) {
      const status = query("#health-parse-status");
      if (status) status.textContent = "";
      const parse = query("#parse-health-images");
      if (parse) parse.disabled = !lifecycle.files(type).length;
    }
    if (type === "weight" && target.elements.clothing) {
      target.elements.clothing.value = "none";
    }
    return true;
  }

  function captureActiveWeightItem() {
    const draft = lifecycle.draft("weight");
    const item = draft.items[draft.activeIndex];
    const target = form("weight");
    if (!item?.recognition || target?.dataset.weightBatchItemId !== item.itemId) return false;
    item.reviewValues = Object.fromEntries(new FormData(target).entries());
    item.reviewValues.occurredAt = target.elements.occurredAt.value;
    item.reviewValues.occurrenceMode = target.elements.occurredAt.dataset.occurrenceMode || "manual";
    return true;
  }

  function applyActiveWeightItem() {
    if (getActiveType() !== "weight") return false;
    const draft = lifecycle.draft("weight");
    const item = draft.items[draft.activeIndex];
    const target = form("weight");
    if (!target || !item) return false;
    resetForm("weight");
    if (!item.recognition) {
      target.querySelector('[type="submit"]').disabled = true;
      target.querySelector(".status").textContent = item.recognitionError?.message
        || "选择已识别的截图后核对并保存。";
      return true;
    }
    applyRecognitionResult("weight", {
      ...item.recognition,
      attachmentPaths: [item.uploadedPath]
    });
    const values = item.reviewValues || {};
    for (const [key, value] of Object.entries(values)) {
      if (["recordId", "attachmentPaths", "occurrenceMode"].includes(key)
        || !target.elements[key]) continue;
      if (key === "clothing") {
        [...target.elements.clothing].forEach(input => {
          input.checked = input.value === value;
        });
      } else {
        fillField(target.elements[key], value, toLocalDateTimeInput);
      }
    }
    const recognizedTime = String(values.occurredAt || item.recognition.measuredAt || "");
    const clock = /T(\d{2}:\d{2}(?::\d{2})?)/.exec(recognizedTime)?.[1]
      || localDateTimeForDate(item.assignedDate).slice(11);
    target.elements.occurredAt.dataset.occurrenceMode = "manual";
    target.elements.occurredAt.value = `${item.assignedDate}T${clock}`;
    target.elements.attachmentPaths.value = JSON.stringify([item.uploadedPath]);
    target.dataset.weightBatchItemId = item.itemId;
    target.querySelector('[type="submit"]').textContent = draft.items.length > 1
      ? `保存第 ${draft.activeIndex + 1} 张`
      : "保存体重";
    target.querySelector('[type="submit"]').disabled = Boolean(item.submissionOperationId);
    target.querySelector(".status").textContent = item.dateMismatch
      ? `截图识别日期为 ${item.recognizedDate}，当前归入 ${item.assignedDate}；请确认日期后保存。`
      : "请核对当前截图的日期和指标后保存。";
    return true;
  }

  function renderUploader() {
    const type = getActiveType();
    const workflow = query("#health-image-workflow");
    if (!workflow) return false;
    const visible = Boolean(typeMeta[type]);
    workflow.hidden = !visible;
    if (!visible) return false;
    const draft = lifecycle.draft(type);
    const files = lifecycle.files(type);
    const max = type === "sleep" ? 2 : type === "weight" ? WEIGHT_BATCH_MAX_ITEMS : 1;
    const input = query("#health-images");
    input.multiple = max > 1;
    query("#health-upload-title").textContent = type === "weight"
      ? `选择 1–${max} 张体重截图`
      : `优先上传 ${max === 2 ? "1–2" : "1"} 张${typeMeta[type].label}截图`;
    const hints = {
      sleep: "总览与详情可一起识别",
      heartRate: "包含日视图与今日概览",
      weight: "体重或体成分报告，未显示的字段留空",
      exercise: "运动详情，项目、时长与心率可一起识别"
    };
    query("#health-upload-hint").textContent = `点击、粘贴或拖入 · ${hints[type]}`
      + `${type === "weight" ? " · 每张明确对应日期" : ""} · 单张 8 MB · 批次合计 48 MB`;
    revokePreviews();
    previewUrls = files.map(file => objectUrls?.createObjectURL?.(file) || "");
    const previews = query("#health-image-previews");
    previews.classList.toggle("weight-batch", type === "weight");
    previews.innerHTML = files.map((file, index) => {
      if (type !== "weight") {
        return `<figure><img src="${escapeMarkup(previewUrls[index])}" alt="待识别截图 ${index + 1}"><figcaption>${escapeMarkup(file.name || `截图 ${index + 1}`)} · ${formatBytes(file.size)}</figcaption><button type="button" data-health-image-remove="${index}" aria-label="移除截图 ${index + 1}">×</button></figure>`;
      }
      const item = draft.items[index];
      const selected = index === draft.activeIndex;
      return `<figure class="weight-batch-item${selected ? " active" : ""}${item?.recognitionError || item?.lastError ? " failed" : ""}">
        <button class="weight-batch-select" type="button" data-weight-batch-select="${index}" aria-pressed="${selected}" aria-label="核对第 ${index + 1} 张体重截图"><img src="${escapeMarkup(previewUrls[index])}" alt=""><span><b>${escapeMarkup(file.name || `截图 ${index + 1}`)}</b><small>${escapeMarkup(weightStatus(item, index))}</small></span></button>
        <label class="weight-batch-date"><span>对应日期</span><input type="date" data-weight-batch-date="${index}" value="${escapeMarkup(item?.assignedDate || getActiveDate())}" ${getLatestRequest() || item?.submissionOperationId ? "disabled" : ""}></label>
        <button class="weight-batch-remove" type="button" data-health-image-remove="${index}" aria-label="移除第 ${index + 1} 张截图" ${getLatestRequest() || item?.submissionOperationId ? "disabled" : ""}>×</button>
      </figure>`;
    }).join("");
    query("#health-upload-box").classList.toggle("has-image", files.length > 0);
    const parse = query("#parse-health-images");
    parse.textContent = type === "weight"
      ? (draft.items.some(item => item.recognitionError || !item.recognition)
        ? "识别待处理截图"
        : "重新识别当前截图")
      : "识别并回填";
    parse.disabled = !files.length
      || Boolean(getLatestRequest())
      || (type === "weight" && draft.items.every(item => item.submissionOperationId));
    return true;
  }

  return Object.freeze({
    query,
    queryAll,
    form,
    revokePreviews,
    clearSurface,
    applyRecognitionResult,
    resetForm,
    captureActiveWeightItem,
    applyActiveWeightItem,
    renderUploader,
    status: () => query("#health-parse-status"),
    draftStatus: (type = getActiveType()) => healthDraftStatus(type, activeDraft(type))
  });
}
