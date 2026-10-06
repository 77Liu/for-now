import { renderCheckinsPresentation } from "./presentation.mjs";

const noop = () => {};
const RELEVANT_DOMAINS = new Set(["checkins", "customMetrics", "review"]);
const emptyDelegate = Object.freeze({
  mount: () => noop,
  render: () => false,
  unmount: noop,
  resetSession: noop
});

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Checkins feature requires ${name}`);
  }
  return value;
}

export function createCheckinsFeatureController({
  delegate = emptyDelegate,
  getSnapshot,
  getActiveDate,
  document,
  emptyStateMarkup,
  present = renderCheckinsPresentation
} = {}) {
  for (const method of ["mount", "render", "unmount", "resetSession"]) {
    requireFunction(delegate?.[method], `delegate.${method}`);
  }
  requireFunction(getSnapshot, "getSnapshot");
  requireFunction(getActiveDate, "getActiveDate");
  requireFunction(emptyStateMarkup, "emptyStateMarkup");
  requireFunction(present, "present");
  if (!document || typeof document.createElementNS !== "function") {
    throw new TypeError("Checkins feature requires document");
  }

  let activation = null;
  let generation = 0;
  const sessionRoots = new Set();

  const isActive = candidate => Boolean(
    candidate
    && activation === candidate
    && !candidate.signal?.aborted
  );
  const renderPresentation = (context = {}) => {
    const current = activation;
    if (!isActive(current)) return false;
    const domains = context.changedDomains == null
      ? null
      : new Set(context.changedDomains);
    if (domains && ![...domains].some(domain => RELEVANT_DOMAINS.has(domain))) {
      return false;
    }
    return present({
      root: document,
      snapshot: context.snapshot || getSnapshot(),
      activeDate: getActiveDate(),
      document,
      emptyStateMarkup
    });
  };
  const render = (context = {}) => {
    const current = activation;
    if (!isActive(current)) return false;
    const delegated = delegate.render(context);
    return renderPresentation(context) || delegated || false;
  };
  const unmount = async () => {
    const current = activation;
    if (!current) return false;
    activation = null;
    current.root.removeEventListener?.("change", current.onChange);
    current.unlink();
    await current.disposeDelegate();
    return true;
  };

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Checkins feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const candidate = {
        root: context.root,
        signal: context.signal,
        generation: ++generation,
        unlink: noop,
        disposeDelegate: noop,
        onChange: null
      };
      const disposeDelegate = await delegate.mount(context);
      candidate.disposeDelegate = typeof disposeDelegate === "function"
        ? disposeDelegate
        : () => delegate.unmount();
      if (context.signal?.aborted) {
        await candidate.disposeDelegate();
        throw new DOMException("Feature activation changed", "AbortError");
      }
      candidate.onChange = event => {
        if (!isActive(candidate) || !event?.target?.closest?.("#chart-range")) return;
        render({ snapshot: getSnapshot(), changedDomains: ["checkins"] });
      };
      candidate.root.addEventListener?.("change", candidate.onChange);
      const abort = () => {
        if (activation === candidate) void unmount();
      };
      if (candidate.signal) {
        candidate.signal.addEventListener("abort", abort, { once: true });
        candidate.unlink = () => candidate.signal.removeEventListener("abort", abort);
      }
      activation = candidate;
      sessionRoots.add(document);
      try {
        renderPresentation({ snapshot: getSnapshot() });
      } catch (error) {
        await unmount();
        throw error;
      }
      return unmount;
    },
    render,
    renderPresentation,
    unmount,
    async resetSession() {
      generation += 1;
      const failures = [];
      for (const root of sessionRoots) {
        try {
          present({
            root,
            snapshot: { checkins: [], customMetrics: [] },
            activeDate: getActiveDate(),
            document,
            emptyStateMarkup
          });
        } catch (error) {
          failures.push(error);
        }
      }
      sessionRoots.clear();
      try {
        await unmount();
      } catch (error) {
        failures.push(error);
      }
      try {
        await delegate.resetSession();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Checkins feature session reset failed");
      }
    }
  });
}
