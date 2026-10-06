import { KEEPSAKE_PAGE_SIZE } from "./model.mjs";

export function createKeepsakeInteractions({
  state,
  data,
  canvas,
  drafts,
  presentation,
  operations,
  view,
  navigation,
  render,
  loadNextPage
} = {}) {
  const query = presentation.query;
  const setStatus = message => {
    const status = query("#keepsake-segment-status");
    if (status) status.textContent = message;
  };
  const scheduleCanvasRender = () => {
    canvas.scheduleRender(() => presentation.renderCanvases());
  };
  const scheduleBatchPersist = () => {
    presentation.captureBatchItem({ captureMask: false });
    drafts.schedulePersist();
    presentation.renderBatch();
  };

  function openDetail(id) {
    if (!(data.getSnapshot().keepsakes || []).some(item => item.id === id)) return false;
    state.activeId = id;
    state.activeView = "presentation";
    state.activeOriginalPath = "";
    presentation.resetEditor({ close: true });
    render();
    navigation.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  function toggleCreator() {
    const workspace = query("#keepsake-workspace");
    if (!workspace) return false;
    if (workspace.hidden) {
      if (state.batch.items.length) {
        void operations.loadBatchItem(state.batch.activeIndex, { capture: false });
      } else {
        presentation.resetEditor();
      }
      workspace.hidden = false;
      workspace.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } else {
      void drafts.persist({ capture: presentation.captureBatchItem });
      presentation.resetEditor({ close: true });
      presentation.renderBatch();
    }
    return true;
  }

  function handleEditorButton(button) {
    if (button.id === "keepsake-create-toggle") return toggleCreator();
    if (button.id === "keepsake-load-more") return loadNextPage();
    if (button.id === "keepsake-editor-close") {
      void drafts.persist({ capture: presentation.captureBatchItem });
      presentation.resetEditor({ close: true });
      return presentation.renderBatch();
    }
    if (button.id === "keepsake-cancel-edit") {
      presentation.resetEditor();
      query("#keepsake-workspace")
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      return true;
    }
    if (button.id === "keepsake-batch-add") {
      query("#keepsake-image")?.click();
      return true;
    }
    if (button.dataset.keepsakeBatchSelect != null && !state.batch.loading) {
      void operations.loadBatchItem(Number(button.dataset.keepsakeBatchSelect));
      return true;
    }
    if (button.dataset.keepsakeBatchRemove != null && !state.batch.loading) {
      void operations.removeBatchItem(Number(button.dataset.keepsakeBatchRemove));
      return true;
    }
    if (button.id === "keepsake-auto-segment") {
      void operations.segment();
      return true;
    }
    if (button.id === "keepsake-understand") {
      void operations.understand();
      return true;
    }
    return false;
  }

  function handleTagButton(button) {
    if (button.id === "keepsake-tag-toggle") {
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      presentation.renderTags();
      if (expanded) query("#keepsake-tags")?.focus();
      return true;
    }
    if (button.dataset.keepsakeTagSuggestion != null) {
      presentation.setTags([
        ...state.selectedTags,
        button.dataset.keepsakeTagSuggestion
      ]);
      scheduleBatchPersist();
      query("#keepsake-tags")?.focus();
      return true;
    }
    if (button.dataset.keepsakeTagRemove != null) {
      presentation.setTags(
        state.selectedTags.filter(tag => tag !== button.dataset.keepsakeTagRemove)
      );
      scheduleBatchPersist();
      return true;
    }
    return false;
  }

  function handleCanvasButton(button) {
    if (button.id === "keepsake-brush-keep" || button.id === "keepsake-brush-erase") {
      canvas.editor().mode = button.id.endsWith("erase") ? "erase" : "keep";
      const keep = query("#keepsake-brush-keep");
      const erase = query("#keepsake-brush-erase");
      keep?.classList.toggle("active", canvas.editor().mode === "keep");
      erase?.classList.toggle("active", canvas.editor().mode === "erase");
      keep?.setAttribute("aria-pressed", String(canvas.editor().mode === "keep"));
      erase?.setAttribute("aria-pressed", String(canvas.editor().mode === "erase"));
      return true;
    }
    if (button.id === "keepsake-reset-mask" && canvas.clearMask()) {
      const item = drafts.activeItem();
      if (item) {
        item.alphaMask = "";
        item.status = "editing";
        void drafts.persist();
        presentation.renderBatch();
      }
      scheduleCanvasRender();
      setStatus("轮廓已清空，可用“保留”笔刷重新涂抹。");
      return true;
    }
    if (button.id === "keepsake-undo" && canvas.undo()) {
      button.disabled = !canvas.editor().history.length;
      scheduleCanvasRender();
      if (drafts.activeItem()) {
        presentation.captureBatchItem();
        void drafts.persist();
        presentation.renderBatch();
      }
      return true;
    }
    return false;
  }

  function handleLibraryButton(button) {
    if (button.dataset.keepsakeBack != null) {
      state.activeId = "";
      state.activeView = "presentation";
      state.activeOriginalPath = "";
      render();
      navigation.scrollTo({ top: 0, behavior: "smooth" });
      return true;
    }
    if (button.dataset.keepsakeView) {
      button.disabled = true;
      void operations.setDetailView(button.dataset.keepsakeView)
        .catch(error => view.showToast(error.message, "error"))
        .finally(() => {
          if (button.isConnected !== false) button.disabled = false;
        });
      return true;
    }
    if (button.dataset.keepsakeDerive) {
      void operations.derive(button.dataset.keepsakeDerive, button);
      return true;
    }
    if (button.dataset.keepsakeEdit) {
      button.disabled = true;
      void operations.edit(button.dataset.keepsakeEdit).finally(() => {
        if (button.isConnected !== false) button.disabled = false;
      });
      return true;
    }
    if (button.dataset.keepsakeDelete) {
      void operations.remove(button.dataset.keepsakeDelete, button);
      return true;
    }
    return button.dataset.keepsakeOpen ? openDetail(button.dataset.keepsakeOpen) : false;
  }

  function handleClick(event) {
    const button = event.target?.closest?.("button");
    if (!button) return;
    handleEditorButton(button)
      || handleTagButton(button)
      || handleCanvasButton(button)
      || handleLibraryButton(button);
  }

  function handleInput(event) {
    const target = event.target;
    if (target?.matches?.("[data-feed-search='keepsakes']")) {
      state.searchQuery = target.value;
      state.visibleCount = KEEPSAKE_PAGE_SIZE;
      render();
      return;
    }
    if (target?.id === "keepsake-tags") {
      presentation.renderTags();
      if (drafts.activeItem()) scheduleBatchPersist();
      return;
    }
    if (target?.id === "keepsake-brush-size") {
      const output = query("#keepsake-brush-output");
      const cursor = query("#keepsake-canvas-cursor");
      if (output) output.value = target.value;
      if (cursor) cursor.style.width = cursor.style.height = `${target.value}px`;
      return;
    }
    if (target?.id === "keepsake-edge-expansion") {
      const output = query("#keepsake-edge-output");
      if (output) output.value = target.value;
      if (canvas.applyExpansion(target.value)) {
        scheduleCanvasRender();
        setStatus("已按当前场景边缘重新生成自动轮廓；之后仍可手动修正。");
      }
    } else if (target?.id === "keepsake-background-opacity") {
      const output = query("#keepsake-background-output");
      if (output) output.value = `${target.value}%`;
      scheduleCanvasRender();
    }
    if (target?.closest?.("#keepsake-form") && drafts.activeItem()) {
      scheduleBatchPersist();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target?.id === "keepsake-image") {
      const files = [...(target.files || [])];
      if (!files.length) return;
      const pending = query("#keepsake-id")?.value
        ? operations.setFile(files[0])
        : operations.addFiles(files);
      void pending.catch(error => setStatus(error.message)).finally(() => {
        target.value = "";
      });
    } else if (target?.id === "keepsake-edge-expansion" && drafts.activeItem()) {
      presentation.captureBatchItem();
      void drafts.persist();
      presentation.renderBatch();
    }
  }

  function handleKeydown(event) {
    if (event.target?.id === "keepsake-upload-box"
        && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      query("#keepsake-image")?.click();
      return;
    }
    if (event.target?.id !== "keepsake-tags") return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (presentation.commitTagInput()) scheduleBatchPersist();
    } else if (event.key === "Backspace" && !event.target.value
        && state.selectedTags.length) {
      state.selectedTags.pop();
      presentation.renderTags();
      scheduleBatchPersist();
    }
  }

  function handleDrag(event) {
    const box = event.target?.closest?.("#keepsake-upload-box");
    if (!box) return;
    if (event.type === "dragenter" || event.type === "dragover") {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      box.classList.add("dragging");
    } else if (event.type === "dragleave") {
      if (!box.contains(event.relatedTarget)) box.classList.remove("dragging");
    } else if (event.type === "drop") {
      event.preventDefault();
      box.classList.remove("dragging");
      const files = [...(event.dataTransfer?.files || [])]
        .filter(item => item.type.startsWith("image/"));
      if (!files.length) return setStatus("拖入的内容里没有可用图片。");
      const pending = query("#keepsake-id")?.value
        ? operations.setFile(files[0], "拖入图片")
        : operations.addFiles(files, "拖入图片");
      void pending.catch(error => setStatus(error.message));
    }
  }

  function handlePaste(event) {
    if (!state.activation
        || event.target?.closest?.("input,textarea,[contenteditable=true]")) return;
    const files = [...(event.clipboardData?.files || [])]
      .filter(item => item.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    const pending = query("#keepsake-id")?.value
      ? operations.setFile(files[0], "剪贴板")
      : operations.addFiles(files, "剪贴板");
    void pending.catch(error => setStatus(error.message));
  }

  function handlePointer(event) {
    const display = event.target?.closest?.("#keepsake-mask-canvas");
    if (!display) return;
    const editor = canvas.editor();
    if (event.type === "pointerdown") {
      if (!editor.maskCanvas) return;
      event.preventDefault();
      canvas.invalidateSegmentation();
      display.setPointerCapture?.(event.pointerId);
      canvas.pushHistory();
      const undo = query("#keepsake-undo");
      if (undo) undo.disabled = false;
      editor.drawing = true;
      editor.lastPoint = canvas.point(event, display);
      canvas.paint(
        editor.lastPoint,
        editor.lastPoint,
        display,
        query("#keepsake-brush-size")?.value
      );
      scheduleCanvasRender();
    } else if (event.type === "pointermove") {
      const rect = display.getBoundingClientRect();
      const cursor = query("#keepsake-canvas-cursor");
      if (cursor) {
        cursor.hidden = false;
        cursor.style.left = `${event.clientX - rect.left}px`;
        cursor.style.top = `${event.clientY - rect.top}px`;
      }
      if (!editor.drawing) return;
      const next = canvas.point(event, display);
      canvas.paint(editor.lastPoint, next, display, query("#keepsake-brush-size")?.value);
      editor.lastPoint = next;
      scheduleCanvasRender();
    } else if (event.type === "pointerleave") {
      const cursor = query("#keepsake-canvas-cursor");
      if (cursor) cursor.hidden = true;
    } else {
      editor.drawing = false;
      editor.lastPoint = null;
      if (event.pointerId != null && display.hasPointerCapture?.(event.pointerId)) {
        display.releasePointerCapture(event.pointerId);
      }
      if (drafts.activeItem()) {
        presentation.captureBatchItem();
        void drafts.persist();
        presentation.renderBatch();
      }
    }
  }

  return Object.freeze({
    openDetail,
    handleClick,
    handleInput,
    handleChange,
    handleKeydown,
    handleDrag,
    handlePaste,
    handlePointer,
    commitBlurredTags(target) {
      if (target?.id !== "keepsake-tags" || !target.value.trim()
          || !presentation.commitTagInput()) return false;
      scheduleBatchPersist();
      return true;
    }
  });
}
