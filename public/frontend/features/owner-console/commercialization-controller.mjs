import {
  applyCommercialStagePreset,
  OWNER_CONSOLE_CAPABILITIES
} from "./model.mjs";
import { createOwnerLifecycle } from "./lifecycle.mjs";
import {
  closestOwnerTarget,
  OWNER_CONSOLE_SELECTORS
} from "./presentation.mjs";
import { ownerRequestOptions } from "./ports.mjs";

const SURFACE_ENDPOINT = "/api/owner/surfaces/commercialization";
const PREVIEW_ENDPOINT = "/api/owner/surfaces/commercialization/preview";
const SAVE_ENDPOINT = "/api/commercialization";
const PREVIEW_DELAY_MS = 150;

export function createCommercializationOwnerController({ ports, presentation }) {
  const lifecycle = createOwnerLifecycle({
    name: "Commercialization owner controller",
    requiredCapability: OWNER_CONSOLE_CAPABILITIES.commercialization,
    capability: ports.capability
  });
  let surface = null;
  let mode = "";
  let requestSerial = 0;
  let saveSerial = 0;
  let previewTimer = null;
  let saving = null;

  const dateRange = () => {
    const to = String(ports.settings.currentDate() || "");
    return { from: ports.format.shiftDateKey(to, -29), to };
  };
  const endpoint = path => {
    const range = dateRange();
    return `${path}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  };
  const currentRequest = ticket => lifecycle.active(ticket)
    && ticket.requestSerial === requestSerial;
  const currentSave = ticket => lifecycle.active(ticket)
    && ticket.saveSerial === saveSerial;
  const assumptions = candidate => presentation.readCommercialAssumptions(
    candidate.root,
    surface?.report?.assumptions
  );

  function cancelPreview() {
    if (previewTimer == null) return false;
    ports.timer.cancel(previewTimer);
    previewTimer = null;
    return true;
  }

  function paint(candidate, options) {
    if (!candidate || !surface
      || !lifecycle.active(lifecycle.context(candidate))) return false;
    return presentation.renderCommercialization(candidate.root, surface, options);
  }

  async function preview(candidate, nextAssumptions, { statusMessage = "" } = {}) {
    if (!candidate || !nextAssumptions) return false;
    const ticket = {
      ...lifecycle.context(candidate),
      requestSerial: ++requestSerial
    };
    try {
      const next = await ports.request(
        endpoint(PREVIEW_ENDPOINT),
        ownerRequestOptions(candidate.signal, {
          method: "POST",
          body: JSON.stringify({ assumptions: nextAssumptions, mode })
        })
      );
      if (!currentRequest(ticket)) return false;
      surface = next;
      mode = next.mode;
      paint(candidate);
      if (statusMessage) {
        const status = candidate.root.querySelector(
          OWNER_CONSOLE_SELECTORS.commercialization.status
        );
        if (status) status.textContent = statusMessage;
      }
      return true;
    } catch (error) {
      if (currentRequest(ticket)) {
        const status = candidate.root.querySelector(
          OWNER_CONSOLE_SELECTORS.commercialization.status
        );
        if (status) status.textContent = error?.message || "商业化估算失败";
      }
      return false;
    }
  }

  function schedulePreview(candidate) {
    cancelPreview();
    requestSerial += 1;
    const ticket = lifecycle.context(candidate);
    previewTimer = ports.timer.schedule(() => {
      previewTimer = null;
      if (!lifecycle.active(ticket)) return;
      void preview(candidate, assumptions(candidate));
    }, PREVIEW_DELAY_MS);
  }

  async function load(candidate = lifecycle.currentActivation()) {
    if (!candidate || !lifecycle.active(lifecycle.context(candidate))) return false;
    if (surface) return paint(candidate);
    const ticket = {
      ...lifecycle.context(candidate),
      requestSerial: ++requestSerial
    };
    presentation.setSurfaceMessage(
      candidate.root,
      OWNER_CONSOLE_SELECTORS.commercialization.surface,
      "正在读取管理内容…"
    );
    try {
      const next = await ports.request(
        endpoint(SURFACE_ENDPOINT),
        ownerRequestOptions(candidate.signal)
      );
      if (!currentRequest(ticket)) return false;
      surface = next;
      mode = next.mode;
      return paint(candidate, { mount: true });
    } catch (error) {
      if (currentRequest(ticket)) {
        presentation.setSurfaceMessage(
          candidate.root,
          OWNER_CONSOLE_SELECTORS.commercialization.surface,
          error?.message || "商业化内容读取失败",
          true
        );
      }
      return false;
    }
  }

  async function save(candidate, form) {
    if (saving || !surface) return false;
    cancelPreview();
    requestSerial += 1;
    const nextAssumptions = assumptions(candidate);
    const ticket = {
      ...lifecycle.context(candidate),
      saveSerial: ++saveSerial
    };
    saving = ticket;
    const status = candidate.root.querySelector(
      OWNER_CONSOLE_SELECTORS.commercialization.status
    );
    const button = form?.querySelector?.('[type="submit"]');
    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存估算…";
    try {
      const report = await ports.request(
        SAVE_ENDPOINT,
        ownerRequestOptions(candidate.signal, {
          method: "PATCH",
          body: JSON.stringify({ assumptions: nextAssumptions })
        })
      );
      if (!currentSave(ticket)) return false;
      surface = {
        ...surface,
        report: { ...report, legacyV2: Boolean(report.legacyV2) }
      };
      await preview(candidate, report.assumptions, {
        statusMessage: "估算参数已保存。"
      });
      if (currentSave(ticket)) ports.toast("商业化估算已更新");
      return true;
    } catch (error) {
      if (currentSave(ticket) && status) {
        status.textContent = error?.message || "商业化估算保存失败";
      }
      return false;
    } finally {
      if (saving === ticket) saving = null;
      if (currentSave(ticket) && button) button.disabled = false;
    }
  }

  function handleClick(candidate, event) {
    if (!lifecycle.active(lifecycle.context(candidate))) return;
    const source = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.commercialization.source
    );
    if (source) {
      event.preventDefault?.();
      cancelPreview();
      ports.navigation.openSource(Object.freeze({
        view: String(source.dataset.commercialSourceView || ""),
        id: String(source.dataset.commercialSourceId || ""),
        date: String(source.dataset.commercialSourceDate || "")
      }));
      return;
    }
    const view = closestOwnerTarget(candidate.root, event, "[data-view]");
    if (view) {
      event.preventDefault?.();
      ports.navigation.openView(String(view.dataset.view || ""));
      return;
    }
    const button = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.commercialization.mode
    );
    if (!button || !surface) return;
    event.preventDefault?.();
    cancelPreview();
    const nextAssumptions = assumptions(candidate);
    mode = String(button.dataset.commercialMode || "");
    void preview(candidate, nextAssumptions);
  }

  function handleInput(candidate, event) {
    if (!surface || !lifecycle.active(lifecycle.context(candidate))) return;
    const stage = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.commercialization.stage
    );
    if (stage) {
      cancelPreview();
      const next = applyCommercialStagePreset(
        assumptions(candidate),
        mode,
        stage.value
      );
      void preview(candidate, next, {
        statusMessage: "阶段参数已切换，保存后跟随账户。"
      });
      return;
    }
    const field = closestOwnerTarget(
      candidate.root,
      event,
      `${OWNER_CONSOLE_SELECTORS.commercialization.field},${OWNER_CONSOLE_SELECTORS.commercialization.profileField}`
    );
    if (field) schedulePreview(candidate);
  }

  function handleSubmit(candidate, event) {
    const form = event?.target;
    if (!form?.matches?.(OWNER_CONSOLE_SELECTORS.commercialization.form)
      || !lifecycle.active(lifecycle.context(candidate))) return;
    event.preventDefault?.();
    void save(candidate, form);
  }

  function mount(context = {}) {
    const mounted = lifecycle.mount(context);
    const { candidate, dispose } = mounted;
    if (!mounted.ready) return dispose;
    lifecycle.cleanup(candidate, () => {
      cancelPreview();
      requestSerial += 1;
      saveSerial += 1;
      saving = null;
      presentation.cleanupCommercialization(candidate.root);
    });
    lifecycle.listen(candidate, "click", event => handleClick(candidate, event));
    lifecycle.listen(candidate, "input", event => handleInput(candidate, event));
    lifecycle.listen(candidate, "submit", event => handleSubmit(candidate, event));
    void load(candidate);
    return dispose;
  }

  function resetSession() {
    cancelPreview();
    surface = null;
    mode = "";
    requestSerial += 1;
    saveSerial += 1;
    saving = null;
    lifecycle.reset(root => presentation.clearSurface(
      root,
      OWNER_CONSOLE_SELECTORS.commercialization.surface
    ));
  }

  return Object.freeze({
    mount,
    render: () => paint(lifecycle.currentActivation()),
    unmount: () => lifecycle.detach(),
    resetSession,
    reload: () => {
      surface = null;
      requestSerial += 1;
      return load();
    }
  });
}
