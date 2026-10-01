const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ATTACHMENT_PATH = /^\/attachments\/[\w.-]+$/;

export const WEIGHT_BATCH_MAX_ITEMS = 8;

export function validWeightBatchDate(value) {
  if (!DATE_KEY.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createWeightBatchItems(files, {
  assignedDate,
  createId = () => crypto.randomUUID()
} = {}) {
  const list = [...(files || [])];
  if (!list.length) throw new Error("没有找到可用图片");
  if (list.length > WEIGHT_BATCH_MAX_ITEMS) throw new Error(`体重批次最多选择 ${WEIGHT_BATCH_MAX_ITEMS} 张图片`);
  if (!validWeightBatchDate(assignedDate)) throw new Error("请为体重截图指定有效日期");
  return list.map((file, position) => ({
    itemId: createId(),
    position,
    file,
    assignedDate,
    revision: 1,
    status: "selected",
    recognition: null,
    recognitionRequestId: "",
    createRequestId: "",
    submissionOperationId: "",
    uploadedPath: "",
    uploadRequestId: "",
    recognitionError: null,
    lastError: null
  }));
}

export function recognizedWeightDate(result) {
  const candidate = result?.date || String(result?.measuredAt || "").slice(0, 10);
  return validWeightBatchDate(candidate) ? candidate : "";
}

export function applyWeightBatchRecognition(item, result, {
  requestId = "",
  expectedRevision = item?.revision
} = {}) {
  if (!item || Number(item.revision) !== Number(expectedRevision)) return { item, stale: true };
  const recognizedDate = recognizedWeightDate(result);
  return {
    item: {
      ...item,
      recognition: structuredClone(result),
      recognitionRequestId: requestId,
      status: "review",
      recognitionError: null,
      dateMismatch: Boolean(recognizedDate && recognizedDate !== item.assignedDate),
      recognizedDate
    },
    stale: false
  };
}

export function changeWeightBatchDate(item, assignedDate) {
  if (!item || !validWeightBatchDate(assignedDate)) throw new Error("请为体重截图指定有效日期");
  const recognizedDate = recognizedWeightDate(item.recognition);
  return {
    ...item,
    assignedDate,
    revision: Number(item.revision || 0) + 1,
    createRequestId: "",
    submissionOperationId: "",
    status: item.recognition ? "review" : "selected",
    dateMismatch: Boolean(recognizedDate && recognizedDate !== assignedDate)
  };
}

export function weightBatchRecordInput(item, formPayload = {}) {
  if (!item?.recognition) throw new Error("请先识别这张体重截图");
  if (!validWeightBatchDate(item.assignedDate)) throw new Error("请为体重截图指定有效日期");
  if (!ATTACHMENT_PATH.test(item.uploadedPath || "")) throw new Error("体重截图尚未完成上传");
  const sourceTime = String(formPayload.occurredAt || item.recognition.measuredAt || "");
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}(?::\d{2})?)/.exec(sourceTime)?.[1] || "12:00:00";
  return {
    ...formPayload,
    type: "weight",
    source: "screenshot",
    timeMode: "manual",
    occurredAt: `${item.assignedDate}T${time}`,
    attachmentPaths: [item.uploadedPath]
  };
}

export function nextWeightBatchIndex(items, removedIndex) {
  if (!Array.isArray(items) || !items.length) return 0;
  return Math.max(0, Math.min(Number(removedIndex) || 0, items.length - 1));
}
