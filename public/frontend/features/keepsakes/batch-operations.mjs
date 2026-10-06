import {
  createKeepsakeBatchItems,
  discardKeepsakeMedia,
  KEEPSAKE_BATCH_MAX_ITEMS,
  uploadKeepsakeMedia
} from "../keepsakes-media/index.mjs";

export function createKeepsakeBatchOperations({
  state,
  data,
  media,
  canvas,
  drafts,
  presentation,
  view,
  platform,
  lifecycle,
  effects,
  segment
} = {}) {
  const flights = new Map();
  const query = presentation.query;
  const setText = (selector, value) => {
    const node = query(selector);
    if (node) node.textContent = value;
  };
  const isCurrent = (ticket, item, { active = true } = {}) => Boolean(
    lifecycle.isCurrent(ticket)
    && ticket.batchGeneration === state.batch.generation
    && state.batch.items.includes(item)
    && (!active || drafts.activeItem() === item)
  );
  const ticketFor = item => ({
    ...lifecycle.createTicket(),
    batchGeneration: state.batch.generation,
    itemId: item.itemId
  });

  async function loadItem(index, { capture = true } = {}) {
    const item = state.batch.items[index];
    if (state.batch.loading || !item) return false;
    if (capture) {
      const previous = drafts.activeItem();
      if (previous?.understandingState === "pending") {
        previous.understandingState = "waiting";
      }
      await drafts.persist({ capture: presentation.captureBatchItem });
    }
    state.batch.loading = true;
    presentation.resetEditor();
    drafts.select(index);
    const generation = canvas.editor().segmentGeneration;
    const ticket = ticketFor(item);
    const workspace = query("#keepsake-workspace");
    if (workspace) workspace.hidden = false;
    presentation.populateBatchItem(item, index, data.getActiveDate());
    effects.renderBatch();
    try {
      const [dataUrl] = await media.imageDataUrls([item.file]);
      if (!isCurrent(ticket, item)
          || generation !== canvas.editor().segmentGeneration) return false;
      const prepared = await canvas.prepare({
        dataUrl,
        file: item.file,
        cutoutUrl: item.alphaMask || "",
        generation,
        isValid: () => isCurrent(ticket, item)
      });
      if (!prepared || !isCurrent(ticket, item)) return false;
      presentation.populateBatchItem(item, index, data.getActiveDate());
      presentation.revealPreparedImage();
      item.status = item.alphaMask ? "ready" : "editing";
      effects.renderBatch();
      if (!item.alphaMask) void segment();
      return true;
    } catch (error) {
      if (!isCurrent(ticket, item)) return false;
      item.status = "failed";
      item.lastError = { message: error.message };
      setText("#keepsake-segment-status", error.message);
      effects.renderBatch();
      return false;
    } finally {
      if (ticket.batchGeneration === state.batch.generation
          && state.batch.items.includes(item)) {
        state.batch.loading = false;
        void drafts.persist().catch(() => {});
      }
    }
  }

  async function addFiles(files, source = "本地文件") {
    const current = state.batch.items;
    const validated = media.validateImages(
      [...current.map(item => item.file), ...(files || [])],
      KEEPSAKE_BATCH_MAX_ITEMS
    );
    const created = createKeepsakeBatchItems(validated.slice(current.length), {
      occurredAt: view.localDateTimeForDate(data.getActiveDate()),
      createId: platform.createRequestId
    });
    drafts.append(created);
    const workspace = query("#keepsake-workspace");
    if (workspace) workspace.hidden = false;
    effects.renderBatch();
    await drafts.persist({ capture: presentation.captureBatchItem });
    if (!current.length) await loadItem(0, { capture: false });
    setText(
      "#keepsake-segment-status",
      `${source} · 已加入 ${created.length} 张，批次共 ${state.batch.items.length} 件。`
    );
    return true;
  }

  async function removeItem(index, { discard = true } = {}) {
    presentation.captureBatchItem();
    const removed = drafts.remove(index);
    if (!removed) return false;
    const { item, wasActive } = removed;
    if (discard && item.mediaPaths && item.uploadRequestId) {
      await discardKeepsakeMedia({
        request: data.request,
        attachmentPaths: item.mediaPaths.attachmentPaths
          || Object.values(item.mediaPaths),
        uploadRequestId: item.uploadRequestId
      }).catch(() => {});
    }
    if (state.batch.items.length) {
      await drafts.persist({ capture: presentation.captureBatchItem });
      effects.renderBatch();
      if (wasActive) await loadItem(state.batch.activeIndex, { capture: false });
    } else {
      await drafts.persist();
      presentation.resetEditor();
      effects.renderBatch();
    }
    return true;
  }

  async function runSubmission(item, button, status) {
    const ticket = ticketFor(item);
    let newlyUploaded = null;
    try {
      presentation.captureBatchItem();
      item.status = "uploading";
      item.lastError = null;
      item.uploadRequestId ||= platform.createRequestId();
      effects.renderBatch();
      await drafts.persist();
      if (!item.mediaPaths) {
        newlyUploaded = await uploadKeepsakeMedia({
          request: data.request,
          image: canvas.editor().sourceDataUrl,
          alphaMask: canvas.alphaMaskDataUrl(),
          idempotencyKey: item.uploadRequestId
        });
        if (!isCurrent(ticket, item)) {
          await discardKeepsakeMedia({
            request: data.request,
            attachmentPaths: newlyUploaded.attachmentPaths,
            uploadRequestId: item.uploadRequestId
          }).catch(() => {});
          return false;
        }
        item.mediaPaths = newlyUploaded;
      }
      item.status = "saving";
      item.createRequestId ||= platform.createRequestId();
      await drafts.persist();
      if (!isCurrent(ticket, item)) return false;
      effects.renderBatch();
      const { attachmentPaths, ...mediaPaths } = item.mediaPaths;
      void attachmentPaths;
      await data.request("/api/keepsakes", {
        method: "POST",
        headers: { "idempotency-key": item.createRequestId },
        body: JSON.stringify({
          ...presentation.submissionPayload(),
          ...mediaPaths,
          cutoutPath: ""
        })
      });
      if (!isCurrent(ticket, item)) return false;
      const index = state.batch.items.findIndex(value => value.itemId === item.itemId);
      if (index >= 0) await removeItem(index, { discard: false });
      if (!state.batch.items.length) {
        const workspace = query("#keepsake-workspace");
        if (workspace) workspace.hidden = true;
        effects.scrollTo({ top: 0, behavior: "auto" });
      }
      await data.refresh(["keepsakes", "review"]);
      if (!lifecycle.isCurrent(ticket)) return false;
      view.showToast(
        state.batch.items.length
          ? "本件小物已保存，请继续处理下一件"
          : "小物批次已保存完成"
      );
      return true;
    } catch (error) {
      if (!isCurrent(ticket, item, { active: false })) {
        if (newlyUploaded) {
          await discardKeepsakeMedia({
            request: data.request,
            attachmentPaths: newlyUploaded.attachmentPaths,
            uploadRequestId: item.uploadRequestId
          }).catch(() => {});
        }
        return false;
      }
      item.status = "failed";
      item.lastError = { message: error.message };
      if (!view.uncertainSubmission(error) && item.mediaPaths) {
        await discardKeepsakeMedia({
          request: data.request,
          attachmentPaths: item.mediaPaths.attachmentPaths,
          uploadRequestId: item.uploadRequestId
        }).catch(() => {});
        item.mediaPaths = null;
        item.uploadRequestId = "";
        item.createRequestId = "";
      }
      await drafts.persist();
      effects.renderBatch();
      status.textContent = error.message;
      return false;
    } finally {
      if (lifecycle.isSameSession(ticket) && button?.isConnected !== false) {
        button.disabled = false;
      }
    }
  }

  function submit(item, button, status) {
    if (flights.has(item.itemId)) return flights.get(item.itemId);
    button.disabled = true;
    status.textContent = "正在生成压缩图…";
    const pending = runSubmission(item, button, status);
    flights.set(item.itemId, pending);
    const clear = () => {
      if (flights.get(item.itemId) === pending) flights.delete(item.itemId);
    };
    void pending.then(clear, clear);
    return pending;
  }

  return Object.freeze({
    addFiles,
    loadItem,
    removeItem,
    submit,
    isCurrent,
    resetSession: () => flights.clear()
  });
}
