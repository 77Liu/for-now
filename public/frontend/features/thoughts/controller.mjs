import { createThoughtReadingState } from "../../../generated/thought-page-window.mjs";
import { createCaptureAudioLifecycle } from "../../../generated/capture-audio-lifecycle.mjs";
import { normalizeTtsPlaybackRate } from "../../media/index.mjs";
import { isPendingAiTaskStatus } from "../../shared/ai-task-status.mjs";
import { createThoughtOperations } from "./operations.mjs";
import { createThoughtPresentation } from "./presentation.mjs";
import { createThoughtSpeech } from "./speech.mjs";
import { createThoughtView } from "./view.mjs";

const noop = () => {};
const emptyDelegate = Object.freeze({
  mount: () => noop,
  render: () => false,
  unmount: noop,
  resetSession: noop
});

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Thoughts feature ${group} requires ${name}`);
    }
  }
}

function abortFailure() {
  return new DOMException("Thought feature activation changed", "AbortError");
}

export function createThoughtsFeatureController({
  delegate = emptyDelegate,
  data = {},
  navigation = {},
  media = {},
  annotations = {},
  crossDomain = {},
  view: viewPort = {},
  platform = {}
} = {}) {
  requireFunctions("delegate", {
    mount: delegate?.mount,
    render: delegate?.render,
    unmount: delegate?.unmount,
    resetSession: delegate?.resetSession
  });
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    isRouteDataReady: data.isRouteDataReady,
    isFullRouteStateLoaded: data.isFullRouteStateLoaded,
    request: data.request,
    requestV1: data.requestV1,
    requestBlob: data.requestBlob,
    requestHeadStatus: data.requestHeadStatus,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection
  });
  requireFunctions("navigation port", {
    currentRoute: navigation.currentRoute,
    openDetail: navigation.openDetail,
    backToList: navigation.backToList,
    replaceQuery: navigation.replaceQuery,
    showUnavailable: navigation.showUnavailable,
    clearResult: navigation.clearResult
  });
  requireFunctions("media port", {
    resetEditor: media.resetEditor,
    persistDraft: media.persistDraft,
    submitDraft: media.submitDraft,
    completeDraft: media.completeDraft,
    rollbackDraft: media.rollbackDraft,
    uncertainSubmission: media.uncertainSubmission,
    contentImagesMarkup: media.contentImagesMarkup,
    hasDraftItems: media.hasDraftItems
  });
  requireFunctions("annotations port", {
    tagTargets: annotations.tagTargets,
    applyAnchors: annotations.applyAnchors,
    scheduleLayout: annotations.scheduleLayout,
    openPanel: annotations.openPanel,
    rootKey: annotations.rootKey
  });
  requireFunctions("cross-domain port", {
    getActiveDate: crossDomain.getActiveDate,
    openComposer: crossDomain.openComposer,
    scheduleNotificationPoll: crossDomain.scheduleNotificationPoll
  });
  requireFunctions("view port", {
    appUrl: viewPort.appUrl,
    contextReceiptMarkup: viewPort.contextReceiptMarkup,
    contentState: viewPort.contentState,
    renderLatex: viewPort.renderLatex,
    showToast: viewPort.showToast,
    resetOccurrenceInput: viewPort.resetOccurrenceInput,
    occurrenceFields: viewPort.occurrenceFields,
    presentError: viewPort.presentError
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    confirm: platform.confirm,
    prompt: platform.prompt,
    requestFrame: platform.requestFrame,
    setTimer: platform.setTimer,
    clearTimer: platform.clearTimer,
    getComputedStyle: platform.getComputedStyle,
    matchesMedia: platform.matchesMedia,
    escapeSelector: platform.escapeSelector,
    claimAudio: platform.audio?.claim,
    stopAudio: platform.audio?.stopAll
  });
  if (!platform.document || !platform.window) {
    throw new TypeError("Thoughts feature requires document and window");
  }

  const { document, window } = platform;
  const audioLifecycle = createCaptureAudioLifecycle({
    headStatus: data.requestHeadStatus
  });
  const audioScope = () => activation ? {
    accountId: String(data.getAccountId() || ""),
    sessionId: data.getSessionSerial(),
    pageToken: activation
  } : null;
  const readingState = createThoughtReadingState(() => JSON.stringify([
    String(data.getAccountId() || ""), data.getSessionSerial(),
    activation?.generation ?? null,
    (() => {
      const route = navigation.currentRoute();
      return [route?.view, route?.kind, route?.resourceType, route?.resourceId,
        route?.query?.q, route?.query?.tag, route?.query?.sort];
    })()
  ]));
  /** 当前账户实际详情已读取时才可声称根批注完整；摘要不是空集合。 @since unreleased */
  function isAnnotationRootLoaded(id) {
    const route = navigation.currentRoute();
    return Boolean(activation && data.isRouteDataReady()
      && (data.isFullRouteStateLoaded() || (route.kind === "detail"
        && route.resourceType === "thought-chain" && route.resourceId === id)));
  }
  const presentation = createThoughtPresentation({
    getSnapshot: data.getSnapshot,
    isAnnotationRootLoaded,
    getGenerationRate: () => data.getSpeechGenerationRate?.(),
    appUrl: viewPort.appUrl,
    contextReceiptMarkup: viewPort.contextReceiptMarkup,
    contentImagesMarkup: media.contentImagesMarkup
  });
  const thoughtView = createThoughtView({
    getSnapshot: data.getSnapshot,
    getActiveDate: crossDomain.getActiveDate,
    isFullRouteStateLoaded: data.isFullRouteStateLoaded,
    contentState: viewPort.contentState,
    renderLatex: viewPort.renderLatex,
    tagCommentableTargets: annotations.tagTargets,
    applyCommentAnchors: annotations.applyAnchors,
    scheduleAnnotationLayout: annotations.scheduleLayout,
    requestFrame: platform.requestFrame,
    getComputedStyle: platform.getComputedStyle,
    escapeSelector: platform.escapeSelector,
    document,
    presentation,
    audioLifecycle,
    audioScope,
    readingState,
    captureReadingPosition: root => operations.captureReadingPosition(root),
    restoreReadingPosition: (root, position, token) => operations.restoreReadingPosition(root, position, token)
  });

  let activation = null;
  let generation = 0;
  let session = {};
  let searchTimer = 0;
  const createTicket = () => ({
    activation,
    generation,
    session,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial()
  });
  const isCurrent = value => Boolean(
    value
    && value.activation
    && activation === value.activation
    && generation === value.generation
    && session === value.session
    && value.owner === String(data.getAccountId() || "")
    && value.serial === data.getSessionSerial()
    && !value.activation.signal?.aborted
  );
  const closest = (event, selector) => event?.target?.closest?.(selector) || null;
  const speech = createThoughtSpeech({
    getSnapshot: data.getSnapshot,
    requestBlob: data.requestBlob,
    refresh: data.refresh,
    createTicket,
    isCurrent,
    audio: platform.audio,
    showToast: viewPort.showToast,
    presentError: viewPort.presentError
  });
  const operations = createThoughtOperations({
    data,
    navigation,
    media,
    annotations,
    crossDomain,
    viewPort,
    platform,
    thoughtView,
    readingState,
    createTicket,
    isCurrent,
    isActive: () => Boolean(activation)
  });

  function toggleFollowUpForm(button) {
    const form = button.closest(".chain-record")
      ?.querySelector(`[data-follow-up-root="${platform.escapeSelector(button.dataset.followupCompose)}"]`);
    if (!form) return false;
    form.hidden = !form.hidden;
    button.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) {
      form.elements.question.focus();
      form.scrollIntoView({
        block: "nearest",
        behavior: platform.matchesMedia("(max-width:760px)") ? "auto" : "smooth"
      });
    }
    return true;
  }

  function toggleFollowUpEditor(button) {
    const id = button.dataset.followupEditToggle || button.dataset.followupEditCancel;
    const form = button.closest("[data-chain-id]")
      ?.querySelector(`[data-followup-edit="${platform.escapeSelector(id)}"]`);
    if (!form) return false;
    form.hidden = Boolean(button.dataset.followupEditCancel);
    if (!form.hidden) {
      form.elements.question.focus();
      form.scrollIntoView({
        block: "nearest",
        behavior: platform.matchesMedia("(max-width:760px)") ? "auto" : "smooth"
      });
    }
    return true;
  }

  async function handleClick(event) {
    const summary = closest(event, ".chain-summary");
    if (summary) {
      event.preventDefault();
      operations.capturePosition();
      navigation.openDetail(summary.closest("[data-chain-id]")?.dataset.chainId);
      return;
    }
    const button = closest(event, "button");
    if (!button) return;
    if (button.matches("[data-capture-speech-retry]")) return audioLifecycle.retry(button);
    if (button.matches("[data-thought-block-expand]")) {
      thoughtView.toggleExpanded(button);
    } else if (button.dataset.thoughtList != null) {
      navigation.backToList("thoughts", { query: navigation.currentRoute().query });
    } else if (button.dataset.thoughtBlockAdd) {
      operations.openBlockEditor(button.dataset.rootId, button.dataset.thoughtBlockAdd);
    } else if (button.dataset.thoughtBlockEdit) {
      const item = (data.getSnapshot().thoughts || [])
        .find(value => value.id === button.dataset.thoughtBlockEdit);
      if (item) operations.openBlockEditor(button.dataset.rootId, item.type, item.id);
    } else if (button.dataset.thoughtBlockDelete) {
      await operations.removeBlock(button);
    } else if (button.dataset.followupCompose) {
      toggleFollowUpForm(button);
    } else if (button.dataset.followupEditToggle || button.dataset.followupEditCancel) {
      toggleFollowUpEditor(button);
    } else if (button.dataset.followupDelete) {
      await operations.removeFollowUp(button);
    } else if (button.dataset.followupAnswer) {
      await operations.answerFollowUp(button);
    } else if (button.id === "thought-load-previous") {
      await operations.loadPrevious();
    } else if (button.id === "thought-refresh-window") {
      operations.resetPaging();
      await data.refresh("thoughts");
    } else if (button.id === "thought-load-more") {
      await operations.loadMore();
    } else if (button.id === "thought-create-toggle"
      || button.dataset.contentAction === "new-thought") {
      crossDomain.openComposer(button);
    } else if (button.dataset.thoughtSort) {
      navigation.replaceQuery({
        cursor: null, direction: null, page: null,
        sort: button.dataset.thoughtSort === "created" ? "created" : null
      });
    } else if (button.dataset.tagFilter != null) {
      navigation.replaceQuery({
        tag: button.dataset.tagFilter === "all" ? null : button.dataset.tagFilter,
        page: null, cursor: null, direction: null
      });
    } else if (button.dataset.contentAction === "clear-thought-filter") {
      navigation.replaceQuery({ tag: null, page: null, cursor: null, direction: null });
    } else if (button.dataset.contentAction === "dismiss-route-result") {
      navigation.clearResult();
    } else if (button.dataset.openComments) {
      operations.openComments(button.dataset.openComments);
    } else if (button.dataset.editChain) {
      operations.openChainEditor(button.dataset.editChain);
    } else if (button.dataset.answerChain) {
      const question = (data.getSnapshot().thoughts || [])
        .find(item => item.id === button.dataset.answerChain && item.type === "question");
      if (!question) return;
      button.disabled = true;
      let task = null;
      try { task = await operations.startBackgroundAnswer(question); }
      finally { button.disabled = isPendingAiTaskStatus(task?.status); }
    } else if (button.dataset.remark) {
      await operations.changeRemark(button, "create");
    } else if (button.dataset.editRemark) {
      await operations.changeRemark(button, "edit");
    } else if (button.dataset.deleteRemark) {
      await operations.changeRemark(button, "delete");
    } else if (button.dataset.disposition) {
      await operations.setDisposition(button);
    } else if (button.dataset.deleteChain) {
      await operations.deleteChain(button);
    } else if (button.dataset.speechSynthesize != null) {
      await speech.synthesize(button);
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!activation || !form?.matches?.(
      "[data-follow-up-root],[data-followup-manual-answer],[data-followup-edit],"
      + "#edit-chain-form,#thought-block-form"
    )) return;
    event.preventDefault();
    if (form.id === "edit-chain-form") void operations.submitEditChain(form);
    else if (form.id === "thought-block-form") void operations.submitBlock(form);
    else void operations.submitFollowUp(form);
  }

  function handleInput(event) {
    if (event.target?.matches?.("[data-speech-generation-rate]")) {
      const output = event.target.closest("label")?.querySelector("output");
      if (output) output.textContent = (1 + Number(event.target.value) / 100).toFixed(2) + "×";
      return;
    }
    if (!event.target?.matches?.("[data-feed-search='thoughts']")) return;
    thoughtView.setQuery(event.target.value);
    if (data.isFullRouteStateLoaded()) {
      thoughtView.render();
      return;
    }
    platform.clearTimer(searchTimer);
    searchTimer = platform.setTimer(() => {
      searchTimer = 0;
      const route = navigation.currentRoute();
      if (route.view === "thoughts" && thoughtView.query() !== (route.query?.q || "")) {
        navigation.replaceQuery({ q: thoughtView.query() || null, page: null, cursor: null, direction: null });
      }
    }, 250);
  }

  function handleChange(event) {
    const control = closest(event, "[data-speech-playback-rate]");
    if (control) {
      const player = control.closest(".speech-asset-controls")
        ?.querySelector("[data-speech-player]");
      if (player) player.playbackRate = normalizeTtsPlaybackRate(control.value);
    } else if (event.target?.matches?.("#thought-block-type")) {
      const select = event.target;
      document.querySelector("#thought-block-title").textContent =
        `新增${select.options[select.selectedIndex].text}`;
    }
  }

  function persistBlockDraft(event) {
    if (!event.target?.matches?.(
      "#thought-block-content,#thought-block-type,#thought-block-datetime"
    )) return;
    delete event.target.closest("form")?.dataset.requestId;
    if (media.hasDraftItems("thoughtBlock")) void media.persistDraft("thoughtBlock");
  }

  const unmount = async () => {
    const current = activation;
    if (!current) return false;
    operations.resetPaging();
    readingState.invalidate();
    activation = null;
    current.unlink();
    platform.clearTimer(searchTimer);
    searchTimer = 0;
    audioLifecycle.dispose(current.root);
    platform.audio.stopAll();
    await current.disposeDelegate();
    return true;
  };

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Thoughts feature requires a root");
      }
      if (context.signal?.aborted) throw abortFailure();
      const current = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        generation: ++generation,
        listeners: [],
        disposeDelegate: noop,
        unlink: noop
      };
      const disposeDelegate = await delegate.mount(context);
      current.disposeDelegate = typeof disposeDelegate === "function"
        ? disposeDelegate
        : () => delegate.unmount();
      if (context.signal?.aborted) {
        await current.disposeDelegate();
        throw abortFailure();
      }
      activation = current;
      operations.beginPagingRoute();
      thoughtView.mount(context.root, context.route, context.route?.result);
      const listen = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        current.listeners.push([target, type, listener, options]);
      };
      const report = (operation, ticket) => void operation.catch(error => {
        if (isCurrent(ticket)) viewPort.showToast(error.message, "error");
      });
      listen(context.root, "click", event => report(handleClick(event), createTicket()));
      listen(context.root, "submit", handleSubmit);
      listen(context.root, "input", handleInput);
      listen(context.root, "change", handleChange);
      listen(context.root, "toggle", event => {
        if (event.target?.matches?.(".chain-record[open]")) {
          const ticket = createTicket();
          const readingToken = readingState.capture();
          platform.requestFrame(() => {
            if (isCurrent(ticket) && readingState.isCurrent(readingToken) && event.target.isConnected) thoughtView.syncOverflow(event.target);
          });
        }
      }, true);
      const editModal = document.querySelector("#edit-chain-modal");
      const blockModal = document.querySelector("#thought-block-modal");
      listen(editModal, "submit", handleSubmit);
      listen(blockModal, "submit", handleSubmit);
      listen(editModal, "click", event => {
        if (event.target === editModal || closest(event, ".modal-close")) editModal.hidden = true;
      });
      listen(blockModal, "click", event => {
        if (event.target === blockModal || closest(event, ".modal-close")) blockModal.hidden = true;
      });
      listen(blockModal, "change", handleChange);
      listen(blockModal, "input", persistBlockDraft);
      listen(blockModal, "change", persistBlockDraft);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "input"]) {
        listen(window, event, () => {
          readingState.interact();
          operations.cancelPositionRestore({ user: true });
        }, { passive: true });
      }
      listen(window, "scroll", () => operations.capturePosition(), { passive: true });
      listen(window, "resize", () => {
        const ticket = createTicket();
        const readingToken = readingState.capture();
        platform.requestFrame(() => {
          if (isCurrent(ticket) && readingState.isCurrent(readingToken)) thoughtView.syncOverflow();
        });
      });
      const abort = () => {
        if (activation === current) void unmount();
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      current.unlink = () => {
        for (const [target, type, listener, options] of current.listeners) {
          target?.removeEventListener?.(type, listener, options);
        }
        context.signal?.removeEventListener("abort", abort);
      };
      delegate.render({ snapshot: data.getSnapshot(), route: context.route });
      operations.synchronizePaging({ restore: false });
      thoughtView.render();
      operations.synchronizePaging();
      return () => activation === current ? unmount() : false;
    },
    render(context = {}) {
      const delegated = delegate.render(context);
      if (!activation) return delegated || false;
      const changed = context.changedDomains == null
        ? null
        : new Set(typeof context.changedDomains === "string"
          ? [context.changedDomains]
          : context.changedDomains);
      operations.synchronizePaging({ restore: false });
      const rendered = changed === null || changed.has("thoughts") || changed.has("speech") || changed.has("aiTasks")
        ? thoughtView.render(context)
        : false;
      operations.synchronizePaging();
      return rendered || delegated || false;
    },
    unmount,
    async resetSession() {
      operations.resetPaging({ logout: true });
      session = {};
      generation += 1;
      const failures = [];
      try { await unmount(); } catch (error) { failures.push(error); }
      thoughtView.clear();
      try { await delegate.resetSession(); } catch (error) { failures.push(error); }
      if (failures.length) {
        throw new AggregateError(failures, "Thoughts feature session reset failed");
      }
    },
    isAnnotationRootLoaded,
    patchTarget: target => activation ? thoughtView.patchTarget(target) : false,
    reconcileRoute: operations.reconcileRoute
  });
}
