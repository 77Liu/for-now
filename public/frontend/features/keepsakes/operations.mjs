import { applyKeepsakeImageCandidates, keepsakeMediaSources } from "../keepsakes-media/index.mjs";
import { createKeepsakeBatchOperations } from "./batch-operations.mjs";
import { uniqueKeepsakeTags } from "./model.mjs";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Keepsake operations ${group} requires ${name}`);
    }
  }
}

export function createKeepsakeOperations({
  state,
  data,
  media,
  canvas,
  drafts,
  presentation,
  view,
  platform,
  lifecycle,
  effects
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data?.getSnapshot,
    getAccountId: data?.getAccountId,
    getSessionSerial: data?.getSessionSerial,
    getActiveDate: data?.getActiveDate,
    request: data?.request,
    refresh: data?.refresh
  });
  requireFunctions("media port", {
    validateImages: media?.validateImages,
    imageDataUrls: media?.imageDataUrls,
    readBlob: media?.readBlob,
    dataUrlFromBlob: media?.dataUrlFromBlob
  });
  requireFunctions("view port", {
    showToast: view?.showToast,
    uncertainSubmission: view?.uncertainSubmission,
    localDateTimeForDate: view?.localDateTimeForDate,
    formatBytes: view?.formatBytes,
    splitTags: view?.splitTags
  });
  requireFunctions("platform port", {
    createRequestId: platform?.createRequestId, confirm: platform?.confirm
  });
  requireFunctions("lifecycle", {
    createTicket: lifecycle?.createTicket,
    isCurrent: lifecycle?.isCurrent,
    isSameSession: lifecycle?.isSameSession
  });
  requireFunctions("effects", {
    render: effects?.render,
    renderBatch: effects?.renderBatch,
    renderCanvases: effects?.renderCanvases,
    scrollTo: effects?.scrollTo
  });

  let detailGeneration = 0, singleFlight = null;
  const query = presentation.query;
  const editorCurrent = (ticket, generation) => (
    lifecycle.isCurrent(ticket)
    && generation === canvas.editor().segmentGeneration
  );
  const understandingCurrent = (ticket, generation) => (
    lifecycle.isCurrent(ticket)
    && generation === canvas.editor().understandingGeneration
  );
  const setText = (selector, value) => {
    const node = query(selector);
    if (node) node.textContent = value;
  };
  const batchOperations = createKeepsakeBatchOperations({
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
  });
  const batchCurrent = (...args) => batchOperations.isCurrent(...args);

  async function setFile(supplied, source = "本地文件") {
    let file;
    try {
      [file] = media.validateImages([supplied]);
    } catch (error) {
      setText("#keepsake-segment-status", error.message);
      return false;
    }
    const generation = canvas.beginSegmentation();
    const ticket = lifecycle.createTicket();
    const workspace = query("#keepsake-workspace");
    const segmentButton = query("#keepsake-auto-segment");
    if (workspace) workspace.hidden = false;
    if (segmentButton) segmentButton.disabled = false;
    setText("#keepsake-segment-status", "正在读取照片…");
    try {
      const [dataUrl] = await media.imageDataUrls([file]);
      if (!editorCurrent(ticket, generation)) return false;
      const prepared = await canvas.prepare({
        dataUrl,
        file,
        generation,
        isValid: () => editorCurrent(ticket, generation)
      });
      if (!prepared) return false;
      canvas.editor().originalPath = "";
      canvas.editor().cutoutPath = "";
      presentation.revealPreparedImage();
      setText(
        "#keepsake-segment-status",
        `${source} · ${view.formatBytes(file.size)} · 正在识别主体…`
      );
      void segment();
      return true;
    } catch (error) {
      if (editorCurrent(ticket, generation)) {
        setText("#keepsake-segment-status", error.message);
      }
      return false;
    }
  }

  async function segment() {
    const button = query("#keepsake-auto-segment");
    if (!canvas.editor().sourceDataUrl) {
      setText("#keepsake-segment-status", "请先放入一张照片。");
      return false;
    }
    const generation = canvas.beginSegmentation();
    const requestId = platform.createRequestId();
    const targetId = query("#keepsake-id")?.value
      || query("#keepsake-form")?.dataset.batchItemId
      || "keepsake-draft";
    const ticket = lifecycle.createTicket();
    if (button) button.disabled = true;
    setText("#keepsake-segment-status", "正在识别主体，通常需要数秒…");
    canvas.pushHistory();
    try {
      const result = await data.request("/api/keepsakes/segment", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          targetId,
          inputVersion: generation,
          image: canvas.segmentationDataUrl()
        })
      });
      if (!editorCurrent(ticket, generation)
          || (result.requestId && result.requestId !== requestId)
          || (result.targetId && result.targetId !== targetId)
          || (Object.hasOwn(result, "inputVersion")
            && Number(result.inputVersion) !== generation)) return false;
      if (!result.cutout) throw new Error("服务未返回透明轮廓");
      const applied = await canvas.applySegmentedMask(
        result.cutout,
        generation,
        () => editorCurrent(ticket, generation),
        query("#keepsake-edge-expansion")?.value
      );
      if (!applied || !editorCurrent(ticket, generation)) return false;
      effects.renderCanvases();
      setText("#keepsake-segment-status", "自动轮廓已生成，可继续涂抹修正。");
      if (drafts.activeItem()) {
        presentation.captureBatchItem();
        await drafts.persist();
        if (editorCurrent(ticket, generation)) effects.renderBatch();
      }
      return true;
    } catch (error) {
      if (editorCurrent(ticket, generation)) {
        setText(
          "#keepsake-segment-status",
          `自动提取未完成：${error.message}。仍可手动涂抹。`
        );
      }
      return false;
    } finally {
      if (editorCurrent(ticket, generation) && button?.isConnected !== false) {
        button.disabled = false;
      }
    }
  }

  async function understand() {
    const button = query("#keepsake-understand");
    const form = query("#keepsake-form");
    if (!canvas.editor().sourceCanvas) {
      setText("#keepsake-understanding-status", "请先放入一张照片。");
      return false;
    }
    const generation = canvas.beginUnderstanding();
    const requestId = platform.createRequestId();
    const item = drafts.activeItem();
    const targetId = query("#keepsake-id")?.value
      || item?.itemId
      || (form.dataset.candidateTargetId ||= platform.createRequestId());
    const baseline = presentation.candidateFields();
    const ticket = {
      ...lifecycle.createTicket(),
      batchGeneration: state.batch.generation
    };
    if (item) {
      item.understandingState = "pending";
      item.candidateRequestId = requestId;
      effects.renderBatch();
      void drafts.persist();
    }
    if (button) button.disabled = true;
    setText("#keepsake-understanding-status", "正在识别名称、备注与已有标签…");
    try {
      const existingTags = uniqueKeepsakeTags(
        (data.getSnapshot().keepsakes || []).flatMap(value => value.tags || [])
      );
      const result = await data.request("/api/keepsakes/understand", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          targetId,
          inputVersion: generation,
          image: canvas.understandingDataUrl(),
          existingTags
        })
      });
      if (!understandingCurrent(ticket, generation)
          || result.requestId !== requestId
          || result.targetId !== targetId
          || Number(result.inputVersion) !== generation) return false;
      const merged = applyKeepsakeImageCandidates(
        presentation.candidateFields(),
        baseline,
        result,
        { existingTags }
      );
      const title = query("#keepsake-title");
      const note = query("#keepsake-note");
      if (title) title.value = merged.value.title;
      if (note) note.value = merged.value.note;
      presentation.setTags(view.splitTags(merged.value.tags));
      if (item && batchCurrent(ticket, item)) {
        item.understandingState = "ready";
        presentation.captureBatchItem({ captureMask: false });
        await drafts.persist();
        if (batchCurrent(ticket, item)) effects.renderBatch();
      }
      const labels = { title: "名称", tags: "标签", note: "备注" };
      setText(
        "#keepsake-understanding-status",
        merged.applied.length
          ? `已填入${merged.applied.map(key => labels[key]).join("、")}候选，可继续修改。`
          : "候选已生成；现有手动内容保持不变。"
      );
      return true;
    } catch (error) {
      if (!understandingCurrent(ticket, generation)) return false;
      setText("#keepsake-understanding-status", `字段候选未完成：${error.message}`);
      if (item && batchCurrent(ticket, item)) {
        item.understandingState = "failed";
        await drafts.persist();
        if (batchCurrent(ticket, item)) effects.renderBatch();
      }
      return false;
    } finally {
      if (understandingCurrent(ticket, generation) && button?.isConnected !== false) {
        button.disabled = false;
      }
    }
  }

  async function edit(id) {
    const item = (data.getSnapshot().keepsakes || []).find(value => value.id === id);
    if (!item) return false;
    presentation.resetEditor();
    const generation = canvas.editor().segmentGeneration;
    const ticket = lifecycle.createTicket();
    presentation.beginEdit(item);
    effects.render();
    try {
      const original = await data.request(
        `/api/keepsakes/${encodeURIComponent(id)}/original`
      );
      if (!editorCurrent(ticket, generation)) return false;
      const sources = keepsakeMediaSources(item, "edit");
      const [editBlob, maskBlob] = await Promise.all([
        media.readBlob(sources.imagePath),
        media.readBlob(sources.alphaMaskPath)
      ]);
      if (!editorCurrent(ticket, generation)) return false;
      const [dataUrl, cutoutUrl] = await Promise.all([
        media.dataUrlFromBlob(editBlob),
        media.dataUrlFromBlob(maskBlob)
      ]);
      if (!editorCurrent(ticket, generation)) return false;
      const prepared = await canvas.prepare({
        dataUrl,
        cutoutUrl,
        mediaDirty: false,
        generation,
        isValid: () => editorCurrent(ticket, generation)
      });
      if (!prepared) return false;
      canvas.editor().originalPath = original.originalPath;
      canvas.editor().cutoutPath = sources.alphaMaskPath;
      canvas.editor().source = item.source || "manual";
      presentation.revealPreparedImage();
      setText(
        "#keepsake-segment-status",
        "编辑图与蒙版已载入，可涂抹修正或重新识别。"
      );
      return true;
    } catch (error) {
      if (editorCurrent(ticket, generation)) {
        setText(
          "#keepsake-segment-status",
          `编辑资源未能载入：${error.message}。可取消后重试。`
        );
      }
      return false;
    } finally {
      if (editorCurrent(ticket, generation)) {
        const editor = query("#keepsake-editor");
        const save = query("#keepsake-save");
        editor?.removeAttribute("aria-busy");
        if (save) save.disabled = !canvas.editor().sourceCanvas;
      }
    }
  }

  async function setDetailView(nextView) {
    const targetId = state.activeId;
    if (!targetId) return false;
    const generation = ++detailGeneration;
    const ticket = lifecycle.createTicket();
    if (nextView === "original" && !state.activeOriginalPath) {
      const result = await data.request(
        `/api/keepsakes/${encodeURIComponent(targetId)}/original`
      );
      if (!lifecycle.isCurrent(ticket) || generation !== detailGeneration
          || targetId !== state.activeId) return false;
      state.activeOriginalPath = result.originalPath || "";
      if (!state.activeOriginalPath) throw new Error("原图不可用");
    }
    if (!lifecycle.isCurrent(ticket) || generation !== detailGeneration
        || targetId !== state.activeId) return false;
    state.activeView = nextView === "original" ? "original" : "presentation";
    effects.render();
    return true;
  }

  function submit(form) {
    const button = query("#keepsake-save");
    const status = query("#keepsake-save-status");
    const id = query("#keepsake-id")?.value || "";
    const item = !id && form.dataset.batchItemId
      ? state.batch.items.find(value => value.itemId === form.dataset.batchItemId)
      : null;
    if (!canvas.editor().sourceCanvas || !canvas.editor().maskCanvas) {
      status.textContent = "请先放入一张照片。";
      return Promise.resolve(false);
    }
    if (!canvas.hasSubject()) {
      status.textContent = "轮廓还是空的，请自动识别或用“保留”笔刷涂出主体。";
      return Promise.resolve(false);
    }
    if (item) {
      return batchOperations.submit(item, button, status);
    }
    if (singleFlight) return singleFlight;
    const pending = (async () => {
      const ticket = lifecycle.createTicket();
      const requestId = form.dataset.requestId || platform.createRequestId();
      if (!id) form.dataset.requestId = requestId;
      button.disabled = true;
      status.textContent = "正在生成压缩图…";
      try {
        const editor = canvas.editor();
        const mediaChanged = !id || editor.mediaDirty || Boolean(editor.file);
        const payload = {
          ...presentation.submissionPayload(),
          ...(mediaChanged
            ? {
                alphaMask: canvas.alphaMaskDataUrl(),
                ...(!id || editor.file ? { image: editor.sourceDataUrl } : {})
              }
            : {})
        };
        await data.request(id
          ? `/api/keepsakes/${encodeURIComponent(id)}`
          : "/api/keepsakes", {
          method: id ? "PATCH" : "POST",
          headers: id ? {} : { "idempotency-key": requestId },
          body: JSON.stringify(payload)
        });
        if (!lifecycle.isCurrent(ticket)) return false;
        delete form.dataset.requestId;
        presentation.resetEditor({ close: true });
        await data.refresh(["keepsakes", "review"]);
        if (!lifecycle.isCurrent(ticket)) return false;
        effects.scrollTo({ top: 0, behavior: "auto" });
        view.showToast(id ? "小物留存已更新" : "小物已数字留存");
        return true;
      } catch (error) {
        if (lifecycle.isCurrent(ticket)) status.textContent = error.message;
        return false;
      } finally {
        if (lifecycle.isSameSession(ticket) && button?.isConnected !== false) {
          button.disabled = false;
        }
      }
    })();
    singleFlight = pending;
    const clear = () => {
      if (singleFlight === pending) singleFlight = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  async function derive(id, button) {
    const ticket = lifecycle.createTicket();
    button.disabled = true;
    try {
      await data.request(`/api/keepsakes/${encodeURIComponent(id)}/derive`, {
        method: "POST",
        body: "{}"
      });
      if (!lifecycle.isCurrent(ticket)) return false;
      await data.refresh("keepsakes");
      if (!lifecycle.isCurrent(ticket)) return false;
      view.showToast("正在重新生成清晰图");
      return true;
    } catch (error) {
      if (lifecycle.isCurrent(ticket)) {
        view.showToast(error.message, "error");
        button.disabled = false;
      }
      return false;
    }
  }

  async function remove(id, button) {
    if (!platform.confirm("将这件小物移入回收站？原图与轮廓会保留 30 天。")) {
      return false;
    }
    const ticket = lifecycle.createTicket();
    button.disabled = true;
    try {
      await data.request(`/api/keepsakes/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      if (!lifecycle.isCurrent(ticket)) return false;
      await data.refresh(["keepsakes", "review"]);
      if (!lifecycle.isCurrent(ticket)) return false;
      view.showToast("小物已移入回收站");
      return true;
    } catch (error) {
      if (lifecycle.isCurrent(ticket)) {
        view.showToast(error.message, "error");
        button.disabled = false;
      }
      return false;
    }
  }

  function resetSession() {
    detailGeneration += 1;
    singleFlight = null;
    batchOperations.resetSession();
  }

  return Object.freeze({
    addFiles: batchOperations.addFiles,
    setFile,
    loadBatchItem: batchOperations.loadItem,
    removeBatchItem: batchOperations.removeItem,
    segment,
    understand,
    edit,
    setDetailView,
    submit,
    derive,
    remove,
    resetSession
  });
}
