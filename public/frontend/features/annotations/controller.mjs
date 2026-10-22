import { createAnnotationModel } from "./model.mjs";
import { createAnnotationOperations } from "./operations.mjs";
import { createAnnotationView } from "./view.mjs";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Annotations feature ${group} requires ${name}`);
    }
  }
}

function abortFailure() {
  const error = new Error("Annotation session changed");
  error.name = "AbortError";
  return error;
}

export function createAnnotationsFeatureController({
  data = {},
  media = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    request: data.request,
    refreshNotifications: data.refreshNotifications,
    scheduleNotificationPoll: data.scheduleNotificationPoll,
    clearThoughtTracePending: data.clearThoughtTracePending,
    openSelectionQuote: data.openSelectionQuote
  });
  requireFunctions("media port", {
    resetDraft: media.resetDraft,
    startDraft: media.startDraft,
    persistDraft: media.persistDraft,
    submitDraft: media.submitDraft,
    buildPayload: media.buildPayload,
    clearDraft: media.clearDraft,
    discardUploads: media.discardUploads,
    uncertainSubmission: media.uncertainSubmission,
    contentImagesMarkup: media.contentImagesMarkup
  });
  requireFunctions("view port", {
    escapeHtml: view.escapeHtml,
    renderMarkdown: view.renderMarkdown,
    renderLatex: view.renderLatex,
    contextReceiptMarkup: view.contextReceiptMarkup,
    emptyStateMarkup: view.emptyStateMarkup,
    formatDate: view.formatDate,
    showToast: view.showToast
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    confirm: platform.confirm,
    prompt: platform.prompt,
    requestFrame: platform.requestFrame,
    cancelFrame: platform.cancelFrame,
    setTimer: platform.setTimer,
    clearTimer: platform.clearTimer,
    matchesMedia: platform.matchesMedia,
    escapeSelector: platform.escapeSelector,
    writeClipboard: platform.writeClipboard
  });
  if (!platform.document || !platform.window || !platform.storage) {
    throw new TypeError("Annotations feature requires document, window and storage");
  }

  const { document, window } = platform;
  const model = createAnnotationModel({
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    storage: platform.storage,
    isRootComplete: data.isRootComplete
  });
  let activation = null;
  let session = {};
  const timers = new Set();
  let selectionTimer = null, selectionGeneration = 0;
  const selectionScope = () => JSON.stringify([activation?.generation ?? null, String(data.getAccountId() || ""), data.getSelectionScope?.() || ""]);
  const isMounted = () => Boolean(activation);
  const ticket = candidate => ({
    candidate,
    session,
    accountId: String(data.getAccountId() || "")
  });
  const isCurrent = value => Boolean(
    value?.candidate
    && activation === value.candidate
    && !value.candidate.signal?.aborted
    && value.session === session
    && value.accountId === String(data.getAccountId() || "")
  );
  const assertCurrent = value => {
    if (!isCurrent(value)) throw abortFailure();
  };
  const closest = (event, selector) => event?.target?.closest?.(selector) || null;
  const annotationView = createAnnotationView({
    model,
    document,
    window,
    escapeHtml: view.escapeHtml,
    escapeSelector: platform.escapeSelector,
    renderMarkdown: view.renderMarkdown,
    renderLatex: view.renderLatex,
    contextReceiptMarkup: view.contextReceiptMarkup,
    emptyStateMarkup: view.emptyStateMarkup,
    formatDate: view.formatDate,
    contentImagesMarkup: media.contentImagesMarkup,
    persistCommentDraft: media.persistDraft,
    requestFrame: platform.requestFrame,
    cancelFrame: platform.cancelFrame,
    matchesMedia: platform.matchesMedia,
    isMounted,
    selectionScope,
    selectionPageKey: () => data.getSelectionPageKey?.() || "",
    containsSelectionHost: host => activation?.root === document || Boolean(activation?.root?.contains?.(host)),
    onSelectionReleased: () => {
      const candidate = activation, scope = selectionScope();
      queueMicrotask(() => {
        if (candidate && activation === candidate && scope === selectionScope()) data.onSelectionReleased?.();
      });
    }
  });
  const operations = createAnnotationOperations({
    model,
    annotationView,
    data,
    media,
    platform,
    showToast: view.showToast,
    ticket,
    isCurrent,
    assertCurrent
  });

  function scheduleSelection(delay = 0) {
    if (selectionTimer !== null) {
      platform.clearTimer(selectionTimer);
      timers.delete(selectionTimer);
    }
    const scope = selectionScope(), candidate = activation;
    selectionTimer = platform.setTimer(() => {
      timers.delete(selectionTimer);
      selectionTimer = null;
      if (activation === candidate && scope === selectionScope()) annotationView.showSelectionTools();
    }, delay);
    timers.add(selectionTimer);
  }

  function handleClick(event) {
    const candidate = activation;
    if (!candidate) return;
    const selectionAction = closest(event, "[data-selection-action]");
    const refresh = closest(event, "[data-annotation-refresh]");
    const panelClose = closest(event, "#comment-panel-close");
    const panelReopen = closest(event, "#comment-panel-reopen");
    const anchor = closest(event, ".comment-anchor");
    const badge = closest(event, "[data-comment-line]");
    const assistantToggle = closest(event, "[data-shenji-toggle]");
    const menu = closest(event, "[data-annotation-menu]");
    const remove = closest(event, "[data-comment-delete]");
    const driftRemove = closest(event, "[data-drift-delete]");
    const openComments = closest(event, "[data-open-comments]");
    if (refresh) {
      void operations.retryRefresh(candidate);
    } else if (selectionAction) {
      void operations.selectionAction(candidate, selectionAction);
    } else if (panelClose) {
      annotationView.closePanel();
    } else if (panelReopen) {
      annotationView.openPanel(
        model.ui.activeRootKey,
        model.ui.activeAnnotationId
      );
    } else if (anchor) {
      annotationView.invalidateSelection();
      annotationView.openPanel(
        anchor.dataset.commentRoot,
        anchor.dataset.annotationId
      );
    } else if (badge) {
      annotationView.openPanel(
        badge.dataset.commentRoot,
        badge.dataset.annotationId
      );
    } else if (assistantToggle) {
      document.querySelectorAll("[data-shenji-form]")
        .forEach(model.stashAssistantDraft);
      const id = assistantToggle.dataset.shenjiToggle;
      model.ui.activeAssistantComposer = model.ui.activeAssistantComposer === id
        ? ""
        : id;
      document.querySelectorAll("[data-shenji-form]").forEach(form => {
        form.hidden = form.dataset.shenjiForm !== model.ui.activeAssistantComposer;
      });
      const form = assistantToggle.closest(".comment-card")
        ?.querySelector("[data-shenji-form]");
      if (form && !form.hidden) {
        model.hydrateAssistantForm(form);
        form.elements.message.focus();
      }
    } else if (menu) {
      void operations.menu(candidate, menu);
    } else if (remove) {
      void operations.remove(candidate, remove);
    } else if (driftRemove) {
      void operations.removeDrift(candidate, driftRemove);
    } else if (openComments) {
      return;
    } else if (
      model.ui.panelOpen
      && !closest(
        event,
        "#comment-panel,#comment-panel-reopen,#selection-tools,.comment-anchor,[data-comment-line]"
      )
      && window.getSelection()?.isCollapsed
    ) {
      annotationView.closePanel();
    }
  }
  function handleSubmit(event) {
    const candidate = activation;
    const comment = closest(event, "#comment-composer");
    const reply = closest(event, "[data-comment-reply]");
    const assistant = closest(event, "[data-shenji-form]");
    if (!candidate || (!comment && !reply && !assistant)) return;
    event.preventDefault();
    if (comment) void operations.commentSubmit(candidate, comment);
    else if (reply) void operations.reply(candidate, reply);
    else void operations.assistantSubmit(candidate, assistant);
  }
  function handleInput(event) {
    const assistantForm = event.target?.closest?.("[data-shenji-form]");
    if (assistantForm) model.stashAssistantDraft(assistantForm);
    if (!event.target?.matches?.("#comment-text")) return;
    const form = event.target.closest("form");
    delete form?.dataset.requestId;
    delete form?.dataset.assistantClientRequestId;
    void media.persistDraft();
  }
  function detach(candidate) {
    if (!candidate || activation !== candidate) return false;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [target, type, handler, options] of candidate.listeners) {
      target.removeEventListener(type, handler, options);
    }
    activation = null;
    for (const timer of timers) platform.clearTimer(timer);
    timers.clear();
    selectionTimer = null;
    annotationView.invalidateSelection();
    annotationView.cancelLayout();
    annotationView.hideSelectionTools();
    return true;
  }
  function mount({ root = document, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Annotations feature mount requires a root event target");
    }
    let disposed = false;
    let candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, signal, dispose, generation: ++selectionGeneration, listeners: [] };
    activation = candidate;
    const listen = (target, type, handler, options) => {
      target?.addEventListener?.(type, handler, options);
      if (target?.removeEventListener) {
        candidate.listeners.push([target, type, handler, options]);
      }
    };
    listen(root, "mouseup", () => scheduleSelection());
    listen(root, "touchend", () => scheduleSelection(180), { passive: true });
    listen(document, "selectionchange", () => scheduleSelection(80));
    listen(root, "keyup", event => {
      if (event.key.startsWith("Arrow") || event.key === "Shift") {
        scheduleSelection();
      }
    });
    listen(root, "scroll", annotationView.scheduleLayout, {
      passive: true,
      capture: true
    });
    const retainMenu = event => {
      if (closest(event, "#selection-tools")) annotationView.retainSelectionForMenu();
      else if (model.ui.pendingSelection?.phase === "menu") annotationView.invalidateSelection();
    };
    listen(root, "pointerdown", retainMenu, { passive: true });
    listen(root, "touchstart", retainMenu, { passive: true });
    listen(root, "pointercancel", () => {
      if (model.ui.pendingSelection?.phase === "menu") annotationView.invalidateSelection();
    });
    listen(root, "mousedown", event => {
      if (closest(event, "#selection-tools")) { retainMenu(event); event.preventDefault(); }
    });
    listen(root, "click", handleClick, { capture: true });
    listen(root, "submit", handleSubmit);
    listen(root, "input", handleInput);
    listen(root, "change", handleInput);
    listen(window, "scroll", () => {
      annotationView.hideSelectionTools();
      annotationView.scheduleLayout();
    }, { passive: true });
    listen(
      window,
      "resize",
      () => platform.requestFrame(annotationView.scheduleLayout),
      { passive: true }
    );
    listen(
      window.visualViewport,
      "resize",
      annotationView.hideSelectionTools,
      { passive: true }
    );
    listen(
      window.visualViewport,
      "scroll",
      annotationView.hideSelectionTools,
      { passive: true }
    );
    signal?.addEventListener?.("abort", dispose, { once: true });
    annotationView.scheduleLayout();
    return dispose;
  }
  function unmount() {
    return activation ? detach(activation) : false;
  }
  function resetSession() {
    session = {};
    unmount();
    model.reset();
    annotationView.resetDom();
  }

  return Object.freeze({
    mount,
    unmount,
    resetSession,
    restoreDrafts: model.restoreDrafts,
    restoreCommentDraft: context => {
      const result = annotationView.restoreCommentDraft(context);
      if (result === "reselect") view.showToast("评论草稿已保留，原选区已失效；请重新选择正文继续。");
      return result;
    },
    commentDraftContext: annotationView.commentDraftContext,
    getRoot: model.rootFor,
    rootLabel: model.rootLabel,
    textContent: annotationView.textContent,
    /** 当前真实非坍塌原生Range是否占用给定宿主；表单快照不阻止普通重绘，源变会明确失效。 @since unreleased */
    hasActiveSelection: container => activation ? annotationView.hasActiveSelection(container) : false,
    activeRootKey: () => model.ui.activeRootKey,
    isActiveRoot: value => model.ui.activeRootKey === value,
    openPanel: annotationView.openPanel,
    renderPanel: annotationView.renderPanel,
    refreshAnnotation: annotationView.refreshAnnotation,
    markTarget: annotationView.markTarget,
    tagThoughtTargets: annotationView.tagThoughtTargets,
    applyAnchors: annotationView.applyAnchors,
    scheduleLayout: annotationView.scheduleLayout,
    findTaskAnnotation: model.findTaskAnnotation
  });
}
