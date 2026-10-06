export const LEGACY_PAGE_VIEWS = Object.freeze([
  "today",
  "together",
  "daily",
  "captures",
  "keepsakes",
  "journals",
  "thoughts",
  "review",
  "mine",
  "personal-context",
  "statistics",
  "ai-cost",
  "architecture",
  "commercialization",
  "trash",
  "permission",
  "account",
  "settings",
  "about"
]);

const LEGACY_VIEW_SET = new Set(LEGACY_PAGE_VIEWS);
const noop = () => {};

export function createLegacyPageController({
  view,
  onMount = noop,
  onRender = noop,
  onUnmount = noop,
  onResetSession = noop
} = {}) {
  if (!LEGACY_VIEW_SET.has(view)) {
    throw new TypeError(`Unknown legacy page view: ${view}`);
  }
  for (const [name, operation] of Object.entries({
    onMount,
    onRender,
    onUnmount,
    onResetSession
  })) {
    if (typeof operation !== "function") {
      throw new TypeError(`Legacy page controller ${name} must be a function`);
    }
  }

  let activation = null;
  let generation = 0;

  const unmount = async () => {
    const current = activation;
    if (!current) return;
    activation = null;
    current.unlink();
    await onUnmount(Object.freeze({
      view,
      route: current.route,
      root: current.root,
      generation: current.generation
    }));
  };

  return Object.freeze({
    async mount({ root, route, signal } = {}) {
      if (!root || typeof root !== "object") {
        throw new TypeError(`Legacy page "${view}" requires a root`);
      }
      await unmount();
      if (signal?.aborted) throw new DOMException("Feature activation changed", "AbortError");
      const current = {
        root,
        route,
        signal,
        generation: ++generation,
        unlink: noop
      };
      const abort = () => {
        if (activation === current) void unmount();
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        current.unlink = () => signal.removeEventListener("abort", abort);
      }
      activation = current;
      try {
        await onMount(Object.freeze({
          view,
          route,
          root,
          signal,
          generation: current.generation
        }));
      } catch (error) {
        if (activation === current) activation = null;
        current.unlink();
        throw error;
      }
      if (activation !== current || signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      return unmount;
    },
    render(context = {}) {
      const current = activation;
      if (!current || current.signal?.aborted) return false;
      return onRender(Object.freeze({
        ...context,
        view,
        route: current.route,
        root: current.root,
        generation: current.generation
      }));
    },
    unmount,
    async resetSession() {
      generation += 1;
      await unmount();
      await onResetSession(Object.freeze({ view }));
    }
  });
}
