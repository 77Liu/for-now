import { createKeepsakeCanvas } from "./canvas.mjs";
import { createKeepsakeDrafts } from "./drafts.mjs";
import { createKeepsakeInteractions } from "./interactions.mjs";
import {
  KEEPSAKE_PAGE_SIZE,
  KEEPSAKE_PREFETCH_MARGIN_PX,
  clearKeepsakeAccountState,
  createKeepsakeFeatureState,
  keepsakeMatchesSearch
} from "./model.mjs";
import { createKeepsakeOperations } from "./operations.mjs";
import { createKeepsakePresentation } from "./presentation.mjs";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Keepsake feature ${group} requires ${name}`);
    }
  }
}

export function createKeepsakeFeatureController({
  data = {},
  media = {},
  drafts: draftPort = {},
  navigation = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    getActiveDate: data.getActiveDate,
    request: data.request,
    refresh: data.refresh
  });
  requireFunctions("navigation port", { scrollTo: navigation.scrollTo });
  requireFunctions("platform port", {
    createFile: platform.createFile,
    createRequestId: platform.createRequestId,
    createCanvas: platform.createCanvas,
    createImageData: platform.createImageData,
    loadImage: platform.loadImage,
    requestFrame: platform.requestFrame,
    cancelFrame: platform.cancelFrame,
    setTimer: platform.setTimer,
    clearTimer: platform.clearTimer,
    now: platform.now,
    confirm: platform.confirm
  });
  if (!platform.document || !platform.window || !platform.objectUrls) {
    throw new TypeError("Keepsake feature requires document, window and objectUrls");
  }

  const state = createKeepsakeFeatureState();
  const scheduledFrames = new Set();
  let layoutFrame = 0;
  let derivativeTimer = 0;
  let paginationObserver = null;
  let presentation;
  let operations;

  const createTicket = () => ({
    activation: state.activation,
    session: state.session,
    generation: state.generation,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial()
  });
  const isSameSession = ticket => Boolean(
    ticket
    && ticket.session === state.session
    && ticket.owner === String(data.getAccountId() || "")
    && ticket.serial === data.getSessionSerial()
  );
  const isCurrent = ticket => Boolean(
    isSameSession(ticket)
    && ticket.activation
    && ticket.activation === state.activation
    && ticket.generation === state.generation
    && !ticket.activation.signal?.aborted
  );

  function requestFeatureFrame(callback) {
    const activation = state.activation;
    let frame;
    let fired = false;
    frame = platform.requestFrame(() => {
      fired = true;
      if (frame != null) scheduledFrames.delete(frame);
      if (state.activation === activation && !activation?.signal?.aborted) callback();
    });
    if (!fired && frame != null) scheduledFrames.add(frame);
    return frame;
  }

  function cancelFeatureFrames() {
    for (const frame of scheduledFrames) platform.cancelFrame(frame);
    scheduledFrames.clear();
    layoutFrame = 0;
  }

  const featurePlatform = {
    ...platform,
    requestFrame: requestFeatureFrame
  };
  const canvas = createKeepsakeCanvas({ state, platform: featurePlatform });
  const drafts = createKeepsakeDrafts({
    state,
    store: draftPort,
    data,
    platform: featurePlatform,
    onChange: () => presentation?.renderBatch(),
    onError: error => view.showToast?.(`小物批次保存失败：${error.message}`, "error")
  });
  presentation = createKeepsakePresentation({
    state,
    data,
    canvas,
    drafts,
    view,
    platform: featurePlatform
  });

  function disconnectPagination() {
    paginationObserver?.disconnect();
    paginationObserver = null;
  }

  function clearDerivativeTimer() {
    if (derivativeTimer) platform.clearTimer(derivativeTimer);
    derivativeTimer = 0;
  }

  function loadNextPage() {
    const filtered = (data.getSnapshot().keepsakes || [])
      .filter(item => keepsakeMatchesSearch(item, state.searchQuery));
    const next = Math.min(filtered.length, state.visibleCount + KEEPSAKE_PAGE_SIZE);
    if (next === state.visibleCount) return false;
    state.visibleCount = next;
    render();
    return true;
  }

  function observeNextPage() {
    disconnectPagination();
    const sentinel = presentation.query("#keepsake-pagination");
    const Observer = platform.IntersectionObserver;
    if (!sentinel || sentinel.hidden || typeof Observer !== "function") return;
    const activation = state.activation;
    paginationObserver = new Observer(entries => {
      if (state.activation === activation
          && entries.some(entry => entry.isIntersecting)) loadNextPage();
    }, {
      root: null,
      rootMargin: `${KEEPSAKE_PREFETCH_MARGIN_PX}px 0px`
    });
    paginationObserver.observe(sentinel);
  }

  function scheduleLayout() {
    if (layoutFrame) return layoutFrame;
    let fired = false;
    const frame = requestFeatureFrame(() => {
      fired = true;
      layoutFrame = 0;
      presentation.setupPlacements();
      observeNextPage();
    });
    if (!fired) layoutFrame = frame;
    return frame;
  }

  function scheduleDerivativeRefresh() {
    if (derivativeTimer || (data.getSnapshot().keepsakes || [])
      .every(item => item.derivativeState !== "pending")) return;
    const ticket = createTicket();
    derivativeTimer = platform.setTimer(async () => {
      derivativeTimer = 0;
      if (!isCurrent(ticket)) return;
      try {
        await data.refresh("keepsakes");
      } catch {}
      if (isCurrent(ticket)) scheduleDerivativeRefresh();
    }, 750);
  }

  const effects = {
    render: () => render(),
    renderBatch: () => presentation.renderBatch(),
    renderCanvases: () => presentation.renderCanvases(),
    scrollTo: options => navigation.scrollTo(options)
  };
  operations = createKeepsakeOperations({
    state,
    data,
    media,
    canvas,
    drafts,
    presentation,
    view,
    platform: featurePlatform,
    lifecycle: { createTicket, isCurrent, isSameSession },
    effects
  });
  const interactions = createKeepsakeInteractions({
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
  });

  function render(context = {}) {
    if (!state.activation || state.activation.signal?.aborted) return false;
    const changed = context.changedDomains == null
      ? null
      : new Set(typeof context.changedDomains === "string"
        ? [context.changedDomains]
        : context.changedDomains);
    if (changed && !changed.has("keepsakes")) return false;
    presentation.render({
      scheduleLayout,
      scheduleDerivativeRefresh,
      disconnectPagination
    });
    presentation.renderBatch();
    return true;
  }

  async function unmount() {
    const current = state.activation;
    if (!current) return false;
    const persisted = drafts.flush({ capture: presentation.captureBatchItem })
      .catch(noop);
    state.activation = null;
    state.generation += 1;
    current.unlink();
    disconnectPagination();
    clearDerivativeTimer();
    cancelFeatureFrames();
    canvas.reset();
    drafts.clearMemory({ notify: false });
    operations.resetSession();
    presentation.clearSurface();
    state.surface = null;
    await persisted;
    return true;
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Keepsake feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const current = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        listeners: [],
        unlink: noop
      };
      state.surface = context.root;
      state.activation = current;
      state.generation += 1;
      state.accountId = String(data.getAccountId() || "");
      const listen = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        current.listeners.push([target, type, listener, options]);
      };
      listen(current.root, "click", interactions.handleClick);
      listen(current.root, "submit", event => {
        if (event.target?.id !== "keepsake-form") return;
        event.preventDefault();
        void operations.submit(event.target);
      });
      listen(current.root, "input", interactions.handleInput);
      listen(current.root, "change", interactions.handleChange);
      listen(current.root, "keydown", interactions.handleKeydown);
      listen(current.root, "focusout", event => {
        interactions.commitBlurredTags(event.target);
      });
      for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
        listen(current.root, type, interactions.handleDrag);
      }
      for (const type of [
        "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"
      ]) listen(current.root, type, interactions.handlePointer, type === "pointerleave");
      listen(current.root, "load", event => {
        const stack = event.target?.closest?.(
          ".keepsake-card-image,.home-v02-keepsake-stack,.keepsake-detail-image"
        );
        if (stack) presentation.placeImage(stack);
      }, true);
      listen(platform.document, "paste", interactions.handlePaste);
      const abort = () => {
        if (state.activation === current) void unmount();
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      current.unlink = () => {
        for (const [target, type, listener, options] of current.listeners) {
          target?.removeEventListener?.(type, listener, options);
        }
        context.signal?.removeEventListener("abort", abort);
      };
      render();
      await drafts.restore(state.accountId);
      if (state.activation !== current || current.signal?.aborted) return () => false;
      render();
      return () => state.activation === current ? unmount() : false;
    },
    render,
    unmount,
    async resetSession() {
      state.session = {};
      state.generation += 1;
      await unmount();
      operations.resetSession();
      canvas.reset();
      drafts.resetSession({ notify: false });
      clearKeepsakeAccountState(state);
      state.searchQuery = "";
      presentation.clearSurface();
    },
    openItem: interactions.openDetail
  });
}
