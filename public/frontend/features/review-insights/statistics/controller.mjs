import {
  clearStatisticsPresentation,
  renderStatisticsPresentation,
  setStatisticsRange
} from "./presentation.mjs";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Statistics feature ${group} requires ${name}`);
    }
  }
}

export function createStatisticsFeatureController({
  data = {},
  navigation = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    request: data.request,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    hasCapability: data.hasCapability
  });
  requireFunctions("navigation port", {
    currentRouteKey: navigation.currentRouteKey,
    isView: navigation.isView
  });
  requireFunctions("view port", {
    escapeMarkup: view.escapeMarkup,
    formatTrackingStart: view.formatTrackingStart
  });
  requireFunctions("platform port", {
    getCurrentDate: platform.getCurrentDate
  });

  let activation = null;
  let session = {};
  let generation = 0;
  let requestSerial = 0;
  let lastData = null;
  let lastOwner = "";
  const roots = new Set();

  const createTicket = () => ({
    activation,
    session,
    generation,
    request: ++requestSerial,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial(),
    routeKey: navigation.currentRouteKey()
  });
  const isCurrent = ticket => Boolean(
    ticket
    && ticket.activation
    && ticket.activation === activation
    && ticket.session === session
    && ticket.generation === generation
    && ticket.request === requestSerial
    && ticket.owner === String(data.getAccountId() || "")
    && ticket.serial === data.getSessionSerial()
    && ticket.routeKey === navigation.currentRouteKey()
    && navigation.isView("statistics")
    && !ticket.activation.signal?.aborted
  );

  async function load() {
    const current = activation;
    if (!current) return false;
    const from = current.root.querySelector?.("#statistics-from");
    const to = current.root.querySelector?.("#statistics-to");
    if (!from?.value || !to?.value) {
      setStatisticsRange(current.root, platform.getCurrentDate(), 7);
    }
    const ticket = createTicket();
    const status = current.root.querySelector?.("#statistics-status");
    const button = current.root.querySelector?.(
      "#statistics-range-form button[type='submit']"
    );
    if (button) button.disabled = true;
    if (status) {
      status.textContent = data.hasCapability("ai-costs")
        ? "正在汇总记录与 AI 用量…"
        : "正在汇总记录…";
    }
    const selectedFrom = from?.value || "";
    const selectedTo = to?.value || "";
    try {
      const result = await data.request(
        `/api/statistics?from=${encodeURIComponent(selectedFrom)}&to=${encodeURIComponent(selectedTo)}`
      );
      if (!isCurrent(ticket)) return false;
      lastData = result;
      lastOwner = ticket.owner;
      renderStatisticsPresentation({
        root: current.root,
        data: result,
        view
      });
      if (status) status.textContent = "";
      return true;
    } catch (error) {
      if (isCurrent(ticket) && status) status.textContent = error.message;
      return false;
    } finally {
      if (isCurrent(ticket) && button) button.disabled = false;
    }
  }

  function handleClick(event) {
    const current = activation;
    const button = event.target?.closest?.("[data-statistics-days]");
    if (!current || !button || (
      typeof current.root.contains === "function" && !current.root.contains(button)
    )) return;
    setStatisticsRange(
      current.root,
      platform.getCurrentDate(),
      Number(button.dataset.statisticsDays)
    );
    void load();
  }

  function handleSubmit(event) {
    if (event.target?.id !== "statistics-range-form") return;
    event.preventDefault();
    for (const button of activation?.root?.querySelectorAll?.(
      "[data-statistics-days]"
    ) || []) {
      button.classList?.remove("active");
    }
    void load();
  }

  async function unmount() {
    const current = activation;
    if (!current) return false;
    activation = null;
    generation += 1;
    requestSerial += 1;
    current.unlink();
    return true;
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Statistics feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const current = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        unlink: noop
      };
      activation = current;
      generation += 1;
      roots.add(current.root);
      current.root.addEventListener?.("click", handleClick);
      current.root.addEventListener?.("submit", handleSubmit);
      const abort = () => {
        if (activation === current) void unmount();
      };
      context.signal?.addEventListener?.("abort", abort, { once: true });
      current.unlink = () => {
        current.root.removeEventListener?.("click", handleClick);
        current.root.removeEventListener?.("submit", handleSubmit);
        context.signal?.removeEventListener?.("abort", abort);
      };
      if (lastOwner !== String(data.getAccountId() || "")) {
        lastData = null;
        lastOwner = "";
        clearStatisticsPresentation(current.root);
      }
      const submit = current.root.querySelector?.(
        "#statistics-range-form button[type='submit']"
      );
      if (submit) submit.disabled = false;
      if (lastData) {
        renderStatisticsPresentation({ root: current.root, data: lastData, view });
      }
      void load();
      return () => activation === current ? unmount() : false;
    },
    render() {
      if (!activation || !lastData) return false;
      return renderStatisticsPresentation({
        root: activation.root,
        data: lastData,
        view
      });
    },
    reload: load,
    unmount,
    async resetSession() {
      session = {};
      generation += 1;
      requestSerial += 1;
      lastData = null;
      lastOwner = "";
      await unmount();
      for (const root of roots) clearStatisticsPresentation(root);
      roots.clear();
    }
  });
}
