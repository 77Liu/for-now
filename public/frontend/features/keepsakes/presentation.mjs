import {
  keepsakePlacementCss,
  scanKeepsakeAlpha
} from "../keepsakes-media/index.mjs";
import {
  KEEPSAKE_PAGE_SIZE,
  keepsakeBatchStatus,
  keepsakeMatchesSearch,
  normalizeKeepsakeSearch,
  sortedKeepsakes,
  uniqueKeepsakeTags
} from "./model.mjs";
import { createKeepsakeMarkup } from "./presentation-markup.mjs";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Keepsake presentation ${group} requires ${name}`);
    }
  }
}

export function createKeepsakePresentation({
  state,
  data,
  canvas,
  drafts,
  view,
  platform
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data?.getSnapshot,
    getAccountId: data?.getAccountId
  });
  requireFunctions("view port", {
    appUrl: view?.appUrl,
    contentState: view?.contentState,
    escapeMarkup: view?.escapeMarkup,
    eventTimestamp: view?.eventTimestamp,
    eventDate: view?.eventDate,
    formatDate: view?.formatDate,
    formatDateKey: view?.formatDateKey,
    formatTime: view?.formatTime,
    resetOccurrenceInput: view?.resetOccurrenceInput,
    occurrenceFields: view?.occurrenceFields,
    splitTags: view?.splitTags,
    formatBytes: view?.formatBytes,
    feedCountLabel: view?.feedCountLabel,
    feedSearchEmpty: view?.feedSearchEmpty,
    localDateTimeForDate: view?.localDateTimeForDate
  });
  requireFunctions("platform port", { createCanvas: platform?.createCanvas });
  if (!state || !canvas || !drafts) {
    throw new TypeError("Keepsake presentation requires state, canvas and drafts");
  }

  const root = () => state.activation?.root || state.surface;
  const query = selector => root()?.querySelector?.(selector) || null;
  const snapshot = () => data.getSnapshot() || {};
  const items = () => snapshot().keepsakes || [];
  const escape = value => view.escapeMarkup(value ?? "");
  const { imageMarkup, cardMarkup, detailMarkup } = createKeepsakeMarkup({
    state,
    view
  });

  function setTags(values) {
    state.selectedTags = uniqueKeepsakeTags(values);
    const input = query("#keepsake-tags");
    if (input) input.value = "";
    renderTags();
  }

  function tagsForSubmission() {
    return uniqueKeepsakeTags([
      ...state.selectedTags,
      ...view.splitTags(query("#keepsake-tags")?.value || "")
    ]);
  }

  function commitTagInput() {
    const input = query("#keepsake-tags");
    const values = view.splitTags(input?.value || "");
    if (!values.length) return false;
    state.selectedTags = uniqueKeepsakeTags([...state.selectedTags, ...values]);
    input.value = "";
    renderTags();
    return true;
  }

  function renderTags() {
    const suggestions = query("#keepsake-tag-suggestions");
    const selected = query("#keepsake-selected-tags");
    const toggle = query("#keepsake-tag-toggle");
    if (!suggestions || !selected || !toggle) return false;
    selected.innerHTML = state.selectedTags.map(tag => (
      `<span>${escape(tag)}<button type="button" data-keepsake-tag-remove="${escape(tag)}" `
      + `aria-label="移除标签 ${escape(tag)}">×</button></span>`
    )).join("");
    const selectedKeys = new Set(state.selectedTags.map(tag => tag.toLocaleLowerCase("zh-CN")));
    const search = normalizeKeepsakeSearch(query("#keepsake-tags")?.value);
    const tags = uniqueKeepsakeTags(items().flatMap(item => item.tags || []))
      .filter(tag => !selectedKeys.has(tag.toLocaleLowerCase("zh-CN"))
        && (!search || normalizeKeepsakeSearch(tag).includes(search)));
    suggestions.innerHTML = tags.length
      ? tags.map(tag => (
          `<button type="button" role="option" aria-selected="false" `
          + `data-keepsake-tag-suggestion="${escape(tag)}">${escape(tag)}</button>`
        )).join("")
      : `<span class="keepsake-tag-empty">${search
        ? "没有匹配项，按回车创建"
        : "还没有可选标签"}</span>`;
    suggestions.hidden = toggle.getAttribute("aria-expanded") !== "true";
    return true;
  }

  function renderBatch() {
    const section = query("#keepsake-batch");
    const list = query("#keepsake-batch-list");
    if (!section || !list) return false;
    const urls = state.batch.items.length ? drafts.previewUrls() : [];
    section.hidden = !state.batch.items.length;
    const count = query("#keepsake-batch-count");
    if (count) count.textContent = state.batch.items.length
      ? `${state.batch.items.length} 件`
      : "";
    list.innerHTML = state.batch.items.map((item, index) => (
      `<article class="keepsake-batch-item${index === state.batch.activeIndex ? " active" : ""}`
      + `${item.status === "failed" ? " failed" : ""}"><button class="keepsake-batch-select" `
      + `type="button" data-keepsake-batch-select="${index}" `
      + `aria-pressed="${index === state.batch.activeIndex}"><img src="${escape(urls[index])}" alt="">`
      + `<span><b>${escape(item.title || item.file?.name || `小物 ${index + 1}`)}</b>`
      + `<small>${escape(keepsakeBatchStatus(item, index, state.batch.activeIndex))}</small></span>`
      + `</button><button class="keepsake-batch-remove" type="button" `
      + `data-keepsake-batch-remove="${index}" aria-label="取消第 ${index + 1} 件小物" `
      + `${item.status === "saving" ? "disabled" : ""}>×</button></article>`
    )).join("");
    const upload = query("#keepsake-upload-box");
    const editor = query("#keepsake-editor");
    if (upload) upload.hidden = Boolean(state.batch.items.length);
    if (editor) editor.hidden = !state.batch.items.length && !query("#keepsake-id")?.value;
    return true;
  }

  function candidateFields() {
    return {
      title: query("#keepsake-title")?.value || "",
      tags: tagsForSubmission().join(" "),
      note: query("#keepsake-note")?.value || ""
    };
  }

  function captureBatchItem({ captureMask = true } = {}) {
    const item = drafts.activeItem();
    const form = query("#keepsake-form");
    if (!item || form?.dataset.batchItemId !== item.itemId
        || !canvas.editor().sourceCanvas) return false;
    const hasMask = captureMask && canvas.hasSubject();
    Object.assign(item, {
      title: query("#keepsake-title")?.value || "",
      occurredAt: query("#keepsake-datetime")?.value || "",
      tags: tagsForSubmission().join(" "),
      note: query("#keepsake-note")?.value || "",
      edgeExpansion: Number(query("#keepsake-edge-expansion")?.value) || 0,
      backgroundOpacityPct: Number(query("#keepsake-background-opacity")?.value) || 0,
      source: canvas.editor().source,
      alphaMask: hasMask ? canvas.alphaMaskDataUrl() : item.alphaMask,
      status: ["uploading", "saving", "failed"].includes(item.status)
        ? item.status
        : hasMask || item.alphaMask ? "ready" : "editing"
    });
    return true;
  }

  function resetEditor({ close = false } = {}) {
    const active = drafts.activeItem();
    if (active?.understandingState === "pending") active.understandingState = "waiting";
    canvas.reset();
    const form = query("#keepsake-form");
    form?.reset?.();
    if (form) {
      for (const key of [
        "batchItemId", "requestId", "uploadRequestId", "candidateTargetId"
      ]) delete form.dataset[key];
    }
    const setValue = (selector, value) => {
      const node = query(selector);
      if (node) node.value = value;
    };
    setValue("#keepsake-id", "");
    const occurredAt = query("#keepsake-datetime");
    if (occurredAt) view.resetOccurrenceInput(occurredAt);
    setValue("#keepsake-edge-expansion", "8");
    setValue("#keepsake-edge-output", "8");
    setValue("#keepsake-background-opacity", "15");
    setValue("#keepsake-background-output", "15%");
    setValue("#keepsake-image", "");
    setTags([]);
    const values = {
      "#keepsake-upload-title": "选择、粘贴或拖入 1–8 张小物照片",
      "#keepsake-upload-hint": "每张逐项编辑与保存 · PNG / JPEG / WebP · 单张 8 MB · 批次合计 48 MB",
      "#keepsake-segment-status": "",
      "#keepsake-understanding-status": "",
      "#keepsake-save-status": "",
      "#keepsake-save": "保存小物",
      "#keepsake-editor-eyebrow": "新建留存",
      "#keepsake-editor-title": "拍下或放入一张照片"
    };
    for (const [selector, value] of Object.entries(values)) {
      const node = query(selector);
      if (node) node.textContent = value;
    }
    query("#keepsake-brush-keep")?.classList.add("active");
    query("#keepsake-brush-erase")?.classList.remove("active");
    query("#keepsake-brush-keep")?.setAttribute("aria-pressed", "true");
    query("#keepsake-brush-erase")?.setAttribute("aria-pressed", "false");
    query("#keepsake-tag-toggle")?.setAttribute("aria-expanded", "false");
    const upload = query("#keepsake-upload-box");
    upload?.classList.remove("dragging", "has-image");
    if (upload) upload.hidden = false;
    const editorNode = query("#keepsake-editor");
    editorNode?.removeAttribute("aria-busy");
    if (editorNode) editorNode.hidden = true;
    const configure = [
      ["#keepsake-auto-segment", "disabled", false],
      ["#keepsake-understand", "disabled", true],
      ["#keepsake-save", "disabled", false],
      ["#keepsake-cancel-edit", "hidden", true],
      ["#keepsake-undo", "disabled", true]
    ];
    for (const [selector, key, value] of configure) {
      const node = query(selector);
      if (node) node[key] = value;
    }
    if (close) {
      const workspace = query("#keepsake-workspace");
      if (workspace) workspace.hidden = true;
    }
    return true;
  }

  function populateBatchItem(item, index, activeDate) {
    const form = query("#keepsake-form");
    if (form) form.dataset.batchItemId = item.itemId;
    const values = {
      "#keepsake-title": item.title,
      "#keepsake-datetime": item.occurredAt || view.localDateTimeForDate(activeDate),
      "#keepsake-note": item.note,
      "#keepsake-edge-expansion": String(item.edgeExpansion),
      "#keepsake-edge-output": String(item.edgeExpansion),
      "#keepsake-background-opacity": String(item.backgroundOpacityPct ?? 15),
      "#keepsake-background-output": `${item.backgroundOpacityPct ?? 15}%`
    };
    for (const [selector, value] of Object.entries(values)) {
      const node = query(selector);
      if (node) node.value = value;
    }
    view.setOccurrenceMode?.(query("#keepsake-datetime"), "manual");
    setTags(view.splitTags(item.tags));
    const eyebrow = query("#keepsake-editor-eyebrow");
    const title = query("#keepsake-editor-title");
    const save = query("#keepsake-save");
    if (eyebrow) eyebrow.textContent = `批次 ${index + 1} / ${state.batch.items.length}`;
    if (title) title.textContent = item.title || `第 ${index + 1} 件小物`;
    if (save) save.textContent = state.batch.items.length > 1
      ? `保存第 ${index + 1} 件`
      : "保存小物";
    const status = query("#keepsake-save-status");
    if (status) status.textContent = item.lastError?.message || "";
  }

  function beginEdit(item) {
    state.activeId = "";
    state.activeView = "presentation";
    const values = {
      "#keepsake-id": item.id,
      "#keepsake-title": item.title,
      "#keepsake-note": item.note || "",
      "#keepsake-edge-expansion": String(item.edgeExpansion ?? 8),
      "#keepsake-edge-output": String(item.edgeExpansion ?? 8),
      "#keepsake-background-opacity": String(item.backgroundOpacityPct ?? 15),
      "#keepsake-background-output": `${item.backgroundOpacityPct ?? 15}%`
    };
    for (const [selector, value] of Object.entries(values)) {
      const node = query(selector);
      if (node) node.value = value;
    }
    view.resetOccurrenceInput(query("#keepsake-datetime"), item);
    setTags(item.tags || []);
    const workspace = query("#keepsake-workspace");
    const upload = query("#keepsake-upload-box");
    const editor = query("#keepsake-editor");
    if (workspace) workspace.hidden = false;
    if (upload) upload.hidden = true;
    if (editor) {
      editor.hidden = false;
      editor.setAttribute("aria-busy", "true");
    }
    const text = {
      "#keepsake-editor-eyebrow": "编辑留存",
      "#keepsake-editor-title": item.title,
      "#keepsake-save": "保存修改",
      "#keepsake-segment-status": "正在载入编辑图与蒙版…"
    };
    for (const [selector, value] of Object.entries(text)) {
      const node = query(selector);
      if (node) node.textContent = value;
    }
    const save = query("#keepsake-save");
    const cancel = query("#keepsake-cancel-edit");
    if (save) save.disabled = true;
    if (cancel) cancel.hidden = false;
    workspace?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function submissionPayload() {
    return {
      ...view.occurrenceFields(query("#keepsake-datetime")),
      title: query("#keepsake-title")?.value || "",
      note: query("#keepsake-note")?.value || "",
      tags: tagsForSubmission(),
      source: canvas.editor().source,
      edgeExpansion: Number(query("#keepsake-edge-expansion")?.value),
      backgroundOpacityPct: Number(query("#keepsake-background-opacity")?.value)
    };
  }

  function renderCanvases() {
    return canvas.render(
      query("#keepsake-mask-canvas"),
      query("#keepsake-preview-canvas"),
      query("#keepsake-background-opacity")?.value
    );
  }

  function placeImage(stack) {
    if (!stack || stack.dataset.placementState === "ready"
        || stack.dataset.placementState === "loading") return false;
    const image = stack.querySelector?.(".keepsake-image-cutout");
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
    stack.dataset.placementState = "loading";
    try {
      const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const surface = platform.createCanvas(width, height);
      const context = surface.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      const placement = keepsakePlacementCss(
        scanKeepsakeAlpha(context.getImageData(0, 0, width, height))
      );
      if (!placement) {
        stack.dataset.placementState = "fallback";
        return false;
      }
      const properties = {
        "--keepsake-frame-ratio": placement.aspectRatio,
        "--keepsake-image-width": `${placement.widthPct}%`,
        "--keepsake-image-height": `${placement.heightPct}%`,
        "--keepsake-image-left": `${placement.leftPct}%`,
        "--keepsake-image-top": `${placement.topPct}%`
      };
      for (const [key, value] of Object.entries(properties)) {
        stack.style.setProperty(key, value);
      }
      stack.dataset.placementState = "ready";
      return true;
    } catch {
      stack.dataset.placementState = "fallback";
      return false;
    }
  }

  function setupPlacements(container = query("#keepsake-grid")) {
    for (const stack of container?.querySelectorAll?.(
      ".keepsake-card-image,.home-v02-keepsake-stack"
    ) || []) placeImage(stack);
  }

  function render({
    scheduleLayout = () => {},
    scheduleDerivativeRefresh = () => {},
    disconnectPagination = () => {}
  } = {}) {
    const allItems = sortedKeepsakes(items(), view.eventTimestamp);
    const filtered = allItems.filter(item => keepsakeMatchesSearch(item, state.searchQuery));
    const owner = String(data.getAccountId() || "");
    if (owner !== state.paginationOwner) {
      state.paginationOwner = owner;
      state.visibleCount = KEEPSAKE_PAGE_SIZE;
    }
    state.visibleCount = Math.max(
      KEEPSAKE_PAGE_SIZE,
      Math.min(state.visibleCount, Math.max(filtered.length, KEEPSAKE_PAGE_SIZE))
    );
    let detailItem = allItems.find(item => item.id === state.activeId);
    if (state.activeId && !detailItem) {
      state.activeId = "";
      state.activeView = "presentation";
      state.activeOriginalPath = "";
      detailItem = null;
    }
    const detail = query("#keepsake-detail");
    const library = query(".keepsake-library");
    const pagination = query("#keepsake-pagination");
    const inDetail = Boolean(detailItem);
    root()?.classList?.toggle("keepsake-detail-mode", inDetail);
    const search = query("#keepsake-search-control");
    const create = query("#keepsake-create-toggle");
    if (search) search.hidden = inDetail;
    if (create) create.hidden = inDetail;
    if (library) library.hidden = inDetail;
    if (detail) detail.hidden = !inDetail;
    const countText = allItems.length
      ? view.feedCountLabel("keepsakes", filtered.length, allItems.length, "件")
      : "";
    if (query("#keepsake-count")) query("#keepsake-count").textContent = countText;
    if (query("#keepsake-library-count")) {
      query("#keepsake-library-count").textContent = countText;
    }
    renderTags();
    scheduleDerivativeRefresh();
    if (inDetail) {
      disconnectPagination();
      if (pagination) pagination.hidden = true;
      if (detail) {
        detail.dataset.keepsakeId = detailItem.id;
        detail.innerHTML = detailMarkup(detailItem);
      }
      scheduleLayout();
      return true;
    }
    if (detail) detail.innerHTML = "";
    const visible = filtered.slice(0, state.visibleCount);
    const grid = query("#keepsake-grid");
    if (grid) {
      grid.innerHTML = filtered.length
        ? visible.map((item, index) => cardMarkup(item, index < 4 ? "eager" : "lazy")).join("")
        : allItems.length
          ? view.feedSearchEmpty("小物")
          : view.contentState({
              title: "还没有小物",
              body: "从一张照片开始，名称和轮廓之后都可以修改。",
              action: { command: "new-keepsake", label: "收第一件小物" }
            });
    }
    if (pagination) {
      pagination.hidden = !filtered.length || visible.length >= filtered.length;
      const status = query("#keepsake-pagination-status");
      const more = query("#keepsake-load-more");
      if (status) status.textContent = `已显示 ${visible.length} / ${filtered.length} 件`;
      if (more) more.hidden = pagination.hidden;
    }
    scheduleLayout();
    return true;
  }

  function clearSurface() {
    drafts.revokePreviews();
    for (const selector of ["#keepsake-grid", "#keepsake-detail", "#keepsake-batch-list"]) {
      const node = query(selector);
      if (node) node.innerHTML = "";
    }
    const section = query("#keepsake-batch");
    if (section) section.hidden = true;
  }

  return Object.freeze({
    query,
    imageMarkup,
    cardMarkup,
    detailMarkup,
    render,
    renderBatch,
    renderTags,
    setTags,
    tagsForSubmission,
    commitTagInput,
    candidateFields,
    captureBatchItem,
    resetEditor,
    populateBatchItem,
    beginEdit,
    submissionPayload,
    renderCanvases,
    placeImage,
    setupPlacements,
    clearSurface
  });
}
