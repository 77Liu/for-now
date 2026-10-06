import { weightBatchRecordInput } from "./drafts.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Health submission requires ${name}`);
  }
  return value;
}

export function dailyRecordSubmissionPayload(
  form,
  type,
  {
    occurrenceFields,
    readFormData = target => new FormData(target)
  } = {}
) {
  requireFunction(occurrenceFields, "occurrenceFields");
  requireFunction(readFormData, "readFormData");
  const payload = Object.fromEntries(readFormData(form).entries());
  Object.assign(payload, occurrenceFields(form.elements.occurredAt));
  delete payload.recordId;
  payload.type = type;
  payload.attachmentPaths = payload.attachmentPaths
    ? JSON.parse(payload.attachmentPaths)
    : [];
  payload.source = payload.attachmentPaths.length ? "screenshot" : "manual";
  if (payload.trendSegments) {
    try {
      payload.trendSegments = JSON.parse(payload.trendSegments);
    } catch {
      payload.trendSegments = [];
    }
  }
  form.querySelectorAll('input[type="number"]').forEach(input => {
    payload[input.name] = input.value === "" ? null : Number(input.value);
  });
  form.querySelectorAll("[data-duration]").forEach(input => {
    payload[input.name] = input.value === ""
      ? null
      : input.value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  });
  return payload;
}

export function createHealthSubmission({
  lifecycle,
  view,
  records,
  requestV1,
  getRecords,
  replaceRecord,
  applyPendingRecord,
  refreshRecords,
  occurrenceFields,
  getActiveDate,
  getActiveType,
  sameSession,
  active,
  isMounted,
  current,
  bump,
  ticket,
  createId,
  showToast,
  typeMeta,
  confirmDelete = message => globalThis.confirm(message),
  readFormData
}) {
  for (const [name, value] of Object.entries({
    requestV1,
    getRecords,
    replaceRecord,
    applyPendingRecord,
    refreshRecords,
    occurrenceFields,
    getActiveDate,
    getActiveType,
    sameSession,
    active,
    isMounted,
    current,
    bump,
    ticket,
    createId,
    showToast,
    confirmDelete
  })) requireFunction(value, name);
  for (const method of ["render", "record"]) {
    requireFunction(records?.[method], `records.${method}`);
  }
  if (!typeMeta || typeof typeMeta !== "object") {
    throw new TypeError("Health submission requires typeMeta");
  }

  function prepare({ form, type, id, payload }) {
    bump();
    const batch = type === "weight" && !id;
    if (batch) view.captureActiveWeightItem();
    const draft = lifecycle.draft("weight");
    const item = batch
      ? draft.items.find(value => value.itemId === form.dataset.weightBatchItemId)
      : null;
    const nextPayload = item ? weightBatchRecordInput(item, payload) : payload;
    const requestId = item
      ? (item.createRequestId || createId())
      : (form.dataset.requestId || createId());
    if (!id) {
      form.dataset.requestId = requestId;
      if (item) item.createRequestId = requestId;
    }
    return {
      ticket: ticket(type),
      type,
      itemId: item?.itemId || "",
      requestId,
      payload: nextPayload
    };
  }

  async function markQueued(context, operationId) {
    if (!sameSession(context?.ticket)) return false;
    context.operationId = operationId;
    const draft = lifecycle.draft(context.type);
    if (context.itemId) {
      const item = draft.items.find(value => value.itemId === context.itemId);
      if (!item) return false;
      item.submissionOperationId = operationId;
      item.status = "queued";
    } else if (context.payload.attachmentPaths.length
      && draft.date === getActiveDate()
      && draft.items.length) {
      draft.submissionOperationId = operationId;
    } else {
      return false;
    }
    await lifecycle.persist(context.type);
    if(active(context.ticket))view.renderUploader();
    return true;
  }

  async function complete(context) {
    if (!sameSession(context?.ticket)) return false;
    if (context.itemId) {
      const draft = lifecycle.draft("weight");
      const index = draft.items.findIndex(item => item.itemId === context.itemId);
      if (index >= 0) await lifecycle.removeWeightItem(index, { discardUpload: false });
      if(active(context.ticket)){
        view.renderUploader();
        if(draft.items.length)view.applyActiveWeightItem();else view.resetForm("weight")
      }
      return true;
    }
    if (!current(context.ticket) || context.type !== getActiveType()) return false;
    await lifecycle.discard(context.type);
    if(active(context.ticket)){view.resetForm(context.type);view.revokePreviews();view.renderUploader()}
    return true;
  }

  async function fail(context, error) {
    if (!sameSession(context?.ticket)) return false;
    const draft = lifecycle.draft(context.type);
    if (context.itemId) {
      const item = draft.items.find(value => value.itemId === context.itemId);
      if (!item) return false;
      if (error?.syncStatus === "pending") {
        item.status = "queued";
      } else {
        item.status = error?.syncStatus === "conflict" ? "conflict" : "failed";
        item.submissionOperationId = "";
        item.createRequestId = "";
      }
    } else if (error?.syncStatus !== "pending"
      && draft.submissionOperationId === context.operationId) {
      draft.submissionOperationId = "";
    }
    await lifecycle.persist(context.type);
    if (active(context.ticket)) {
      view.renderUploader();
      if (context.itemId) view.applyActiveWeightItem();
    }
    return true;
  }

  async function submit(form) {
    const type = String(form?.dataset?.dailyForm || "");
    const id = String(form?.elements?.recordId?.value || "");
    const existing = id ? getRecords().find(item => item.id === id) : null;
    const button = form?.querySelector?.('[type="submit"]');
    const status = form?.querySelector?.(".status");
    let context;
    if (!form || !button || !status || !typeMeta[type]) return false;
    try {
      context = prepare({
        form,
        type,
        id,
        payload: dailyRecordSubmissionPayload(form, type, {
          occurrenceFields,
          ...(readFormData ? { readFormData } : {})
        })
      });
    } catch (error) {
      status.textContent = error.message;
      return false;
    }
    const { payload, requestId } = context;
    const temporaryId = `pending:${requestId}`;
    const onQueued = async record => {
      applyPendingRecord(record);
      await markQueued(context, record.operationId);
    };
    button.disabled = true;
    status.textContent = id ? "正在保存修改…" : "正在保存…";
    try {
      const result = id
        ? await requestV1(
          `/api/v1/daily-records/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${existing?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            domains: ["dailyRecords"],
            recoverCommitted: true,
            projection: {
              kind: "record.update",
              domain: "dailyRecords",
              id,
              payload
            },
            onQueued
          }
        )
        : await requestV1(
          "/api/v1/daily-records",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["dailyRecords"],
            projection: {
              kind: "record.create",
              domain: "dailyRecords",
              temporaryId,
              payload
            },
            onQueued
          }
        );
      if (!sameSession(context.ticket)) return false;
      if (result.data) replaceRecord(id || temporaryId, result.data);
      if (active(context.ticket)) records.render();
      const cleared = await complete(context);
      if (cleared && current(context.ticket)) delete form.dataset.requestId;
      void refreshRecords().catch(error => {
        if (active(context.ticket)) {
          showToast(`日录已保存，但列表刷新失败：${error.message}`, "error");
        }
      });
      if (active(context.ticket)) {
        showToast(
          context.itemId && lifecycle.draft("weight").items.length
            ? "本张体重已保存，请继续核对下一张"
            : id
              ? "日录已更新"
              : `${typeMeta[type].label}已记录`
        );
      }
      return true;
    } catch (error) {
      if (!sameSession(context.ticket)) return false;
      await fail(context, error);
      if (!active(context.ticket)) return false;
      if (context.itemId) {
        if (error.syncStatus === "pending") {
          status.textContent = "本张已进入待同步队列，可继续核对其他截图。";
          showToast("本张体重已进入待同步队列");
        } else {
          status.textContent = error.message;
        }
      } else if (error.syncStatus === "pending") {
        status.textContent = "已记下，网络恢复后自动同步；截图保留到服务端确认。";
        showToast("日录已进入待同步队列");
      } else {
        void refreshRecords().catch(() => {});
        status.textContent = error.message;
      }
      return false;
    } finally {
      if (active(context.ticket)) {
        button.disabled = submissionDisabled(type);
      }
    }
  }

  async function removeRecord(button) {
    const id = String(button?.dataset?.dailyDelete || "");
    const item = records.record(id);
    if (!item || !confirmDelete("将这条日录移入回收站？")) return false;
    const operation = ticket(item.type);
    button.disabled = true;
    try {
      await requestV1(
        `/api/v1/daily-records/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${item.version || 1}"` }
        },
        {
          domains: ["dailyRecords"],
          recoverCommitted: true,
          projection: {
            kind: "record.delete",
            domain: "dailyRecords",
            id
          },
          onQueued: record => applyPendingRecord(record)
        }
      );
      if (!sameSession(operation)) return false;
      if (active(operation)) records.render();
      void refreshRecords().catch(error => {
        if (active(operation)) {
          showToast(`日录已移除，但列表刷新失败：${error.message}`, "error");
        }
      });
      if (active(operation)) showToast("日录已移入回收站");
      return true;
    } catch (error) {
      if (!sameSession(operation)) return false;
      if (active(operation)) {
        if (error.syncStatus === "pending") {
          showToast("日录将在网络恢复后移入回收站");
        } else {
          void refreshRecords().catch(() => {});
          showToast(error.message, "error");
          button.disabled = false;
        }
      }
      return false;
    }
  }

  function submissionDisabled(type) {
    const draft = lifecycle.draft(type);
    const item = type === "weight" ? draft.items[draft.activeIndex] : null;
    return type === "weight"
      ? Boolean(item && (!item.recognition || item.submissionOperationId))
      : Boolean(draft.submissionOperationId);
  }

  async function finalizeOperation(operationId) {
    const changed = await lifecycle.finalizeOperation(operationId);
    if (!changed.length) return false;
    if(!isMounted())return true;
    view.renderUploader();
    if (changed.includes("weight")) {
      if (lifecycle.draft("weight").items.length) view.applyActiveWeightItem();
      else view.resetForm("weight");
    }
    for (const type of changed.filter(value => value !== "weight")) {
      const target = view.form(type);
      if (type === getActiveType() && target?.dataset.requestId === operationId) {
        view.resetForm(type);
      }
    }
    return true;
  }

  async function releaseOperation(operationId) {
    const changed = await lifecycle.releaseOperation(operationId);
    if (!changed.length) return false;
    if(!isMounted())return true;
    view.renderUploader();
    if (changed.includes("weight")) view.applyActiveWeightItem();
    for (const type of changed.filter(value => value !== "weight")) {
      view.form(type)?.querySelector('[type="submit"]')?.removeAttribute("disabled");
    }
    return true;
  }

  return Object.freeze({
    submit,
    removeRecord,
    finalizeOperation,
    releaseOperation,
    submissionDisabled
  });
}
