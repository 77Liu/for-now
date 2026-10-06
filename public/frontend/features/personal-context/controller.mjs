import { openContextSource } from "./navigation.mjs";
import {
  PERSONAL_CONTEXT_SELECTORS,
  renderPersonalContextSurface,
  scrubPersonalContextSurface
} from "./presentation.mjs";

export const PERSONAL_CONTEXT_ENDPOINT = "/api/v1/personal-context";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Personal context feature ${group} requires ${name}`);
    }
  }
}

export function createPersonalContextFeatureController({
  data = {},
  navigation = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    requestV1: data.requestV1
  });
  requireFunctions("navigation port", {
    activateDate: navigation.activateDate,
    switchView: navigation.switchView,
    openThoughtDetail: navigation.openThoughtDetail
  });
  requireFunctions("view port", {
    contentState: view.contentState,
    escapeMarkup: view.escapeMarkup,
    plainPreview: view.plainPreview,
    formatDate: view.formatDate
  });
  requireFunctions("platform port", {
    requestFrame: platform.requestFrame,
    queryDestination: platform.queryDestination,
    escapeSelector: platform.escapeSelector,
    isDetailsElement: platform.isDetailsElement
  });

  let activation = null;
  let generation = 0;
  let session = {};
  let requestSerial = 0;
  let contextData = null;
  let loadState = "idle";
  let latestSnapshot = null;
  const sessionRoots = new Set();

  const isCurrent = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.generation === generation
    && candidate.session === session
  );
  const isActive = candidate => Boolean(
    isCurrent(candidate)
    && !candidate.signal?.aborted
  );
  const currentSnapshot = () => latestSnapshot || data.getSnapshot() || {};
  const query = (candidate, selector) => (
    isActive(candidate) ? candidate.root.querySelector(selector) : null
  );

  const paint = candidate => {
    if (!isActive(candidate)) return false;
    return renderPersonalContextSurface({
      root: candidate.root,
      data: contextData,
      loadState,
      snapshot: currentSnapshot(),
      contentState: view.contentState,
      escapeMarkup: view.escapeMarkup,
      plainPreview: view.plainPreview,
      formatDate: view.formatDate
    });
  };

  const currentRequest = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.accountId === String(data.getAccountId() || "")
    && ticket.sessionSerial === data.getSessionSerial()
    && ticket.generation === generation
    && ticket.requestSerial === requestSerial
    && isActive(ticket.activation)
  );

  const load = async candidate => {
    if (!isActive(candidate)) return false;
    const ticket = {
      activation: candidate,
      session,
      accountId: String(data.getAccountId() || ""),
      sessionSerial: data.getSessionSerial(),
      generation,
      requestSerial: ++requestSerial
    };
    loadState = "loading";
    const status = query(candidate, PERSONAL_CONTEXT_SELECTORS.status);
    if (status) status.textContent = "正在核对当前记录与来源…";
    paint(candidate);
    try {
      const response = await data.requestV1(PERSONAL_CONTEXT_ENDPOINT, {
        signal: candidate.signal
      });
      if (!currentRequest(ticket)) return false;
      contextData = response?.data;
      loadState = "ready";
      paint(candidate);
      return true;
    } catch {
      if (!currentRequest(ticket)) return false;
      contextData = null;
      loadState = "failure";
      const currentStatus = query(candidate, PERSONAL_CONTEXT_SELECTORS.status);
      if (currentStatus) currentStatus.textContent = "";
      paint(candidate);
      return false;
    }
  };

  const closestWithin = (candidate, event, selector) => {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    if (
      typeof candidate.root.contains === "function"
      && !candidate.root.contains(element)
    ) {
      return null;
    }
    return element;
  };

  const handleClick = event => {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const retry = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.retry
    );
    if (retry) {
      event.preventDefault?.();
      void load(candidate);
      return;
    }
    const source = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.source
    );
    if (!source) return;
    event.preventDefault?.();
    openContextSource(source, {
      activateDate: navigation.activateDate,
      switchView: navigation.switchView,
      openThoughtDetail: navigation.openThoughtDetail,
      requestFrame: platform.requestFrame,
      queryDestination: platform.queryDestination,
      escapeSelector: platform.escapeSelector,
      isDetailsElement: platform.isDetailsElement
    });
  };

  const detach = candidate => {
    if (!isCurrent(candidate)) return false;
    activation = null;
    generation += 1;
    candidate.root.removeEventListener("click", handleClick);
    candidate.unlink();
    return true;
  };

  const unmount = () => activation ? detach(activation) : false;

  const mount = ({ root, route, signal } = {}) => {
    unmount();
    if (
      !root
      || !["querySelector", "addEventListener", "removeEventListener"]
        .every(name => typeof root[name] === "function")
    ) {
      throw new TypeError("Personal context feature mount requires a root event target");
    }
    if (signal?.aborted) return () => false;

    const candidate = {
      root,
      route,
      signal,
      session,
      generation: ++generation,
      unlink: noop
    };
    const abort = () => {
      if (activation === candidate) detach(candidate);
    };
    if (signal?.addEventListener) {
      signal.addEventListener("abort", abort, { once: true });
      candidate.unlink = () => signal.removeEventListener?.("abort", abort);
    }
    activation = candidate;
    sessionRoots.add(root);
    latestSnapshot = data.getSnapshot() || {};
    root.addEventListener("click", handleClick);
    void load(candidate);

    let disposed = false;
    return () => {
      if (disposed) return false;
      disposed = true;
      return detach(candidate);
    };
  };

  const resetSession = () => {
    unmount();
    generation += 1;
    requestSerial += 1;
    session = {};
    contextData = null;
    loadState = "idle";
    latestSnapshot = null;
    for (const root of sessionRoots) scrubPersonalContextSurface(root);
    sessionRoots.clear();
  };

  return Object.freeze({
    mount,
    render(context = {}) {
      if (!isActive(activation)) return false;
      latestSnapshot = context.snapshot || data.getSnapshot() || {};
      return paint(activation);
    },
    unmount,
    resetSession
  });
}
