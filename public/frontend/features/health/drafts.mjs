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
  if (list.length > WEIGHT_BATCH_MAX_ITEMS) {
    throw new Error(`体重批次最多选择 ${WEIGHT_BATCH_MAX_ITEMS} 张图片`);
  }
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
  if (!item || Number(item.revision) !== Number(expectedRevision)) {
    return { item, stale: true };
  }
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
  if (!item || !validWeightBatchDate(assignedDate)) {
    throw new Error("请为体重截图指定有效日期");
  }
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
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}(?::\d{2})?)/.exec(sourceTime)?.[1]
    || "12:00:00";
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

export const HEALTH_DAILY_TYPES = Object.freeze([
  "sleep",
  "heartRate",
  "weight",
  "exercise"
]);

export const healthDraftKey = (type, date) => (
  type === "weight" ? "health:weight:batch" : `health:${type}:${date}`
);

const emptyDraft = () => ({
  date: "",
  items: [],
  result: null,
  submissionOperationId: "",
  activeIndex: 0
});

const createDrafts = () => Object.fromEntries(
  HEALTH_DAILY_TYPES.map(type => [type, emptyDraft()])
);

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Health draft lifecycle requires ${name}`);
  }
  return value;
}

function withoutLiveReasoning(value) {
  if (!value || typeof value !== "object") return value;
  const { reasoningContent, reasoningVisibility, ...fields } = value;
  return fields;
}

function serializeItem(item, now) {
  return {
    blob: item.file,
    name: item.file?.name || "image",
    type: item.file?.type || "application/octet-stream",
    lastModified: Number(item.file?.lastModified) || now(),
    itemId: item.itemId || "",
    assignedDate: item.assignedDate || "",
    revision: Number(item.revision) || 1,
    status: item.status || "selected",
    recognition: withoutLiveReasoning(item.recognition) || null,
    recognitionRequestId: item.recognitionRequestId || "",
    createRequestId: item.createRequestId || "",
    submissionOperationId: item.submissionOperationId || "",
    recognizedDate: item.recognizedDate || "",
    dateMismatch: Boolean(item.dateMismatch),
    recognitionError: item.recognitionError || null,
    reviewValues: item.reviewValues || null,
    uploadRequestId: item.uploadRequestId || "",
    uploadedPath: item.uploadedPath || "",
    lastError: item.lastError || null
  };
}

export function createHealthDraftLifecycle({
  store,
  listOperations,
  discardItem = async () => false,
  createId = () => crypto.randomUUID(),
  createFile = (parts, name, options) => new File(parts, name, options),
  now = () => Date.now()
} = {}) {
  requireFunction(store?.get, "store.get");
  requireFunction(store?.put, "store.put");
  requireFunction(store?.delete, "store.delete");
  requireFunction(listOperations, "listOperations");
  requireFunction(discardItem, "discardItem");
  requireFunction(createId, "createId");
  requireFunction(createFile, "createFile");
  requireFunction(now, "now");

  let owner = "";
  let date = "";
  let generation = 0;
  let drafts = createDrafts();

  const draft = type => drafts[type] || null;
  const ticket = () => ({ generation, owner, date });
  const isCurrent = value => Boolean(
    value
    && value.generation === generation
    && value.owner === owner
    && value.date === date
  );
  const clearMemory = () => {
    generation += 1;
    drafts = createDrafts();
  };

  async function persist(type) {
    const current = draft(type);
    if (!owner || !current) return false;
    const key = healthDraftKey(type, current.date || date);
    if (!current.items.length) {
      await store.delete(owner, key);
      return true;
    }
    await store.put({
      owner,
      id: healthDraftKey(type, current.date),
      type,
      date: current.date,
      result: withoutLiveReasoning(current.result),
      submissionOperationId: current.submissionOperationId || "",
      activeIndex: current.activeIndex || 0,
      updatedAt: new Date(now()).toISOString(),
      items: current.items.map(item => serializeItem(item, now))
    });
    return true;
  }

  async function discard(type, { deleteStored = true } = {}) {
    const current = draft(type);
    if (!current) return false;
    const currentDate = current.date || date;
    await Promise.all(current.items.map(item => discardItem(item))).catch(() => {});
    if (deleteStored && owner) {
      await store.delete(owner, healthDraftKey(type, currentDate));
    }
    drafts[type] = emptyDraft();
    return true;
  }

  async function restore(nextOwner, nextDate) {
    clearMemory();
    owner = String(nextOwner || "");
    date = String(nextDate || "");
    const operation = ticket();
    if (!owner) return false;
    const operations = new Map(
      (await listOperations(owner)).map(record => [record.operationId, record])
    );
    if (!isCurrent(operation)) return false;

    for (const type of HEALTH_DAILY_TYPES) {
      let stored = await store.get(owner, healthDraftKey(type, date));
      if (!isCurrent(operation)) return false;
      let legacyWeightDraft = false;
      if (type === "weight" && !stored?.items?.length) {
        stored = await store.get(owner, `health:weight:${date}`);
        if (!isCurrent(operation)) return false;
        legacyWeightDraft = Boolean(stored?.items?.length);
      }
      if (!stored?.items?.length) continue;

      const current = draft(type);
      current.date = type === "weight" ? (stored.date || date) : date;
      current.result = withoutLiveReasoning(stored.result) || null;
      current.submissionOperationId = stored.submissionOperationId || "";
      current.activeIndex = Number(stored.activeIndex) || 0;
      const limit = type === "sleep" ? 2 : type === "weight" ? WEIGHT_BATCH_MAX_ITEMS : 1;
      current.items = stored.items.slice(0, limit).map((item, index) => ({
        file: createFile(
          [item.blob],
          item.name || "image",
          {
            type: item.type || item.blob?.type || "",
            lastModified: Number(item.lastModified) || now()
          }
        ),
        itemId: item.itemId || createId(),
        assignedDate: item.assignedDate || stored.date || date,
        revision: Number(item.revision) || 1,
        status: item.status || ((item.recognition || (index === 0 && stored.result)) ? "review" : "selected"),
        recognition: withoutLiveReasoning(item.recognition || (index === 0 && stored.result)) || null,
        recognitionRequestId: item.recognitionRequestId || "",
        createRequestId: item.createRequestId || "",
        submissionOperationId: item.submissionOperationId || "",
        recognizedDate: item.recognizedDate || "",
        dateMismatch: Boolean(item.dateMismatch),
        recognitionError: item.recognitionError || null,
        reviewValues: item.reviewValues || null,
        uploadRequestId: item.uploadRequestId || "",
        uploadedPath: item.uploadedPath || "",
        lastError: item.lastError || null
      }));

      if (type === "weight") {
        current.items = current.items.filter(item => {
          const pending = item.submissionOperationId
            ? operations.get(item.submissionOperationId)
            : null;
          return pending?.status !== "committed";
        });
        for (const item of current.items) {
          const pending = item.submissionOperationId
            ? operations.get(item.submissionOperationId)
            : null;
          if (["failed", "conflict"].includes(pending?.status)) {
            item.submissionOperationId = "";
            item.createRequestId = "";
            item.status = pending.status;
          }
        }
        current.activeIndex = Math.max(
          0,
          Math.min(current.activeIndex, current.items.length - 1)
        );
      } else {
        const pending = current.submissionOperationId
          ? operations.get(current.submissionOperationId)
          : null;
        if (pending?.status === "committed") {
          await discard(type);
          if (!isCurrent(operation)) return false;
          continue;
        }
        if (["failed", "conflict"].includes(pending?.status)) {
          current.submissionOperationId = "";
          await persist(type);
          if (!isCurrent(operation)) return false;
        }
      }

      if (legacyWeightDraft) {
        await persist("weight");
        if (!isCurrent(operation)) return false;
        await store.delete(owner, `health:weight:${date}`);
        if (!isCurrent(operation)) return false;
      }
    }
    return true;
  }

  async function changeDate(nextDate) {
    await persist("weight");
    return restore(owner, nextDate);
  }

  async function removeWeightItem(index, { discardUpload = true } = {}) {
    const current = draft("weight");
    const [item] = current.items.splice(index, 1);
    if (!item) return null;
    if (discardUpload) await discardItem(item).catch(() => {});
    current.activeIndex = nextWeightBatchIndex(current.items, index);
    if (current.items.length) await persist("weight");
    else if (owner) await store.delete(owner, healthDraftKey("weight", current.date || date));
    return item;
  }

  async function finalizeOperation(operationId) {
    if (!operationId) return [];
    const changed = [];
    for (const type of HEALTH_DAILY_TYPES) {
      const current = draft(type);
      if (type === "weight") {
        const index = current.items.findIndex(
          item => item.submissionOperationId === operationId
        );
        if (index < 0) continue;
        current.items.splice(index, 1);
        current.activeIndex = nextWeightBatchIndex(current.items, index);
        if (current.items.length) await persist(type);
        else if (owner) {
          await store.delete(owner, healthDraftKey(type, current.date || date));
        }
        changed.push(type);
        continue;
      }
      if (current.submissionOperationId !== operationId) continue;
      await discard(type);
      changed.push(type);
    }
    return changed;
  }

  async function releaseOperation(operationId) {
    if (!operationId) return [];
    const changed = [];
    for (const type of HEALTH_DAILY_TYPES) {
      const current = draft(type);
      if (type === "weight") {
        const item = current.items.find(
          value => value.submissionOperationId === operationId
        );
        if (!item) continue;
        item.submissionOperationId = "";
        item.createRequestId = "";
        item.status = "failed";
        await persist(type);
        changed.push(type);
        continue;
      }
      if (current.submissionOperationId !== operationId) continue;
      current.submissionOperationId = "";
      await persist(type);
      changed.push(type);
    }
    return changed;
  }

  return Object.freeze({
    draft,
    files: type => draft(type)?.items.map(item => item.file) || [],
    owner: () => owner,
    date: () => date,
    persist,
    restore,
    changeDate,
    discard,
    removeWeightItem,
    finalizeOperation,
    releaseOperation,
    resetSession() {
      clearMemory();
      owner = "";
      date = "";
    }
  });
}
