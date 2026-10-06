import { weightBatchRecordInput } from "./drafts.mjs";

export function createHealthSubmission({
  lifecycle,
  view,
  getActiveDate,
  getActiveType,
  sameSession,
  active,
  isMounted,
  current,
  bump,
  ticket,
  createId
}) {
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
    if (!sameSession(context?.ticket) || !context.itemId) return false;
    const item = lifecycle.draft("weight").items.find(
      value => value.itemId === context.itemId
    );
    if (!item) return false;
    if (error?.syncStatus === "pending") {
      item.status = "queued";
    } else {
      item.status = error?.syncStatus === "conflict" ? "conflict" : "failed";
      item.submissionOperationId = "";
      item.createRequestId = "";
    }
    await lifecycle.persist("weight");
    if(active(context.ticket)){view.renderUploader();view.applyActiveWeightItem()}
    return true;
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
    prepare,
    markQueued,
    complete,
    fail,
    finalizeOperation,
    releaseOperation
  });
}
