import { reviewDomainsChanged } from "./model.mjs";
import { createReviewOperations } from "./operations.mjs";
import {
  clearReviewPresentation,
  renderReviewPresentation
} from "./presentation.mjs";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Review feature ${group} requires ${name}`);
    }
  }
}

export function createReviewFeatureController({
  data = {},
  navigation = {},
  annotations = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    requestV1: data.requestV1,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection
  });
  requireFunctions("navigation port", {
    currentRouteKey: navigation.currentRouteKey,
    isView: navigation.isView
  });
  requireFunctions("annotations port", {
    rootKey: annotations.rootKey,
    markTarget: annotations.markTarget,
    applyAnchors: annotations.applyAnchors
  });
  requireFunctions("view port", {
    associationModal: view.associationModal,
    contentState: view.contentState,
    contextReceiptMarkup: view.contextReceiptMarkup,
    escapeMarkup: view.escapeMarkup,
    escapeSelector: view.escapeSelector,
    plainPreview: view.plainPreview,
    renderMarkdown: view.renderMarkdown,
    renderLatex: view.renderLatex,
    formatDate: view.formatDate,
    metricLabel: view.metricLabel,
    showToast: view.showToast
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    confirm: platform.confirm,
    now: platform.now
  });
  if (!platform.document) {
    throw new TypeError("Review feature platform port requires document");
  }

  let activation = null;
  let surface = null;
  let session = {};
  let generation = 0;
  const roots = new Set();
  const root = () => activation?.root || null;
  const createTicket = () => ({
    activation,
    session,
    generation,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial(),
    routeKey: navigation.currentRouteKey()
  });
  const isSameSession = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.owner === String(data.getAccountId() || "")
    && ticket.serial === data.getSessionSerial()
  );
  const isCurrent = ticket => Boolean(
    isSameSession(ticket)
    && ticket.activation
    && ticket.activation === activation
    && ticket.generation === generation
    && ticket.routeKey === navigation.currentRouteKey()
    && navigation.isView("review")
    && !ticket.activation.signal?.aborted
  );

  let operations;
  const present = (snapshot = data.getSnapshot()) => {
    const current = activation;
    if (!current || current.signal?.aborted) return false;
    const result = renderReviewPresentation({
      root: current.root,
      modal: current.modal,
      snapshot,
      view,
      annotations,
      platform
    });
    operations.syncControls();
    for (const id of result.openAnalysisIds) {
      void operations.loadAnalysisDetail(id);
    }
    return true;
  };
  operations = createReviewOperations({
    data,
    view,
    platform,
    getRoot: root,
    createTicket,
    isCurrent,
    isSameSession,
    render: () => present()
  });

  function setAssociationOpen(open, { restoreFocus = true } = {}) {
    const current = activation;
    const modal = current?.modal;
    const toggle = current?.root?.querySelector?.("#association-flow-toggle");
    if (!modal || !toggle) return false;
    modal.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭计算流程" : "查看计算流程");
    toggle.title = open ? "关闭计算流程" : "查看计算流程";
    if (open) modal.querySelector?.("#association-flow-close")?.focus?.();
    else if (restoreFocus) toggle.focus?.();
    return true;
  }

  function closest(current, event, selector) {
    const element = event?.target?.closest?.(selector) || null;
    return element && (
      typeof current.root.contains !== "function" || current.root.contains(element)
    ) ? element : null;
  }

  function handleClick(event) {
    const current = activation;
    if (!current || current.signal?.aborted) return;
    const run = closest(
      current,
      event,
      "#run-analysis,[data-content-action='run-analysis']"
    );
    const more = closest(current, event, "#analysis-load-more");
    const experimentDelete = closest(current, event, "[data-experiment-delete]");
    const analysisDelete = closest(current, event, "[data-analysis-delete]");
    const flow = closest(current, event, "#association-flow-toggle");
    if (!run && !more && !experimentDelete && !analysisDelete && !flow) return;
    event.preventDefault?.();
    if (run) void operations.generateAnalysis();
    else if (more) void operations.loadMoreAnalyses();
    else if (experimentDelete) {
      void operations.remove("experiment", experimentDelete.dataset.experimentDelete);
    } else if (analysisDelete) {
      void operations.remove("analysis", analysisDelete.dataset.analysisDelete);
    } else {
      setAssociationOpen(true);
    }
  }

  function handleModalClick(event) {
    if (!activation) return;
    const close = event.target?.closest?.("#association-flow-close");
    if (close || event.target === activation.modal) {
      event.preventDefault?.();
      setAssociationOpen(false);
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (form?.id === "experiment-form") {
      event.preventDefault();
      void operations.submitExperiment(form, {
        hypothesis: form.querySelector("#experiment-hypothesis")?.value || "",
        factor: form.querySelector("#experiment-factor")?.value || "",
        outcome: form.querySelector("#experiment-outcome")?.value || "mood",
        duration: form.querySelector("#experiment-duration")?.value || "30"
      });
    } else if (form?.id === "metric-form") {
      event.preventDefault();
      void operations.submitMetric(form, {
        name: form.querySelector("#metric-name")?.value || "",
        low: form.querySelector("#metric-low")?.value || "",
        high: form.querySelector("#metric-high")?.value || ""
      });
    }
  }

  function handleInput(event) {
    const form = event.target?.closest?.("#experiment-form,#metric-form");
    if (form) operations.releasePendingForm(form);
  }

  function handleToggle(event) {
    const entry = event.target?.closest?.("[data-analysis-id]");
    if (entry?.open && root()?.contains?.(entry)) {
      void operations.loadAnalysisDetail(entry.dataset.analysisId);
    }
  }

  function handleKeydown(event) {
    if (event.key === "Escape" && activation?.modal?.hidden === false) {
      event.preventDefault?.();
      setAssociationOpen(false);
    }
  }

  async function unmount() {
    const current = activation;
    if (!current) return false;
    activation = null;
    generation += 1;
    operations.releaseRoute();
    current.unlink();
    if (current.modal) current.modal.hidden = true;
    const toggle = current.root.querySelector?.("#association-flow-toggle");
    if (toggle) {
      toggle.setAttribute?.("aria-expanded", "false");
      toggle.setAttribute?.("aria-label", "查看计算流程");
      toggle.title = "查看计算流程";
    }
    return true;
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Review feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const current = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        modal: view.associationModal(),
        listeners: [],
        unlink: noop
      };
      surface = current.root;
      roots.add(current.root);
      activation = current;
      generation += 1;
      const listen = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        current.listeners.push([target, type, listener, options]);
      };
      listen(current.root, "click", handleClick);
      listen(current.root, "submit", handleSubmit);
      listen(current.root, "input", handleInput);
      listen(current.root, "toggle", handleToggle, true);
      listen(current.modal, "click", handleModalClick);
      listen(platform.document, "keydown", handleKeydown);
      const abort = () => {
        if (activation === current) void unmount();
      };
      context.signal?.addEventListener?.("abort", abort, { once: true });
      current.unlink = () => {
        for (const [target, type, listener, options] of current.listeners) {
          target?.removeEventListener?.(type, listener, options);
        }
        context.signal?.removeEventListener?.("abort", abort);
      };
      try {
        present();
      } catch (error) {
        await unmount();
        throw error;
      }
      return () => activation === current ? unmount() : false;
    },
    render(context = {}) {
      if (!activation || !reviewDomainsChanged(context.changedDomains)) return false;
      return present(context.snapshot || data.getSnapshot());
    },
    unmount,
    async resetSession() {
      session = {};
      generation += 1;
      await unmount();
      operations.resetSession();
      for (const knownRoot of roots) {
        clearReviewPresentation(knownRoot, view.associationModal());
      }
      roots.clear();
      if (surface) clearReviewPresentation(surface, view.associationModal());
      surface = null;
    }
  });
}
