import { architectureProjection, OWNER_CONSOLE_CAPABILITIES } from "./model.mjs";
import { createOwnerLifecycle } from "./lifecycle.mjs";
import {
  closestOwnerTarget,
  OWNER_CONSOLE_SELECTORS
} from "./presentation.mjs";
import { ownerRequestOptions } from "./ports.mjs";

const ENDPOINT = "/api/owner/surfaces/architecture";

export function createArchitectureOwnerController({ ports, presentation }) {
  const lifecycle = createOwnerLifecycle({
    name: "Architecture owner controller",
    requiredCapability: OWNER_CONSOLE_CAPABILITIES.architecture,
    capability: ports.capability
  });
  let surface = null;
  let stageIndex = 0;
  let termKey = "";
  let requestSerial = 0;

  const current = ticket => lifecycle.active(ticket)
    && ticket.requestSerial === requestSerial;

  function paint(candidate, { mount = false } = {}) {
    if (!candidate || !surface
      || !lifecycle.active(lifecycle.context(candidate))) return false;
    const projection = presentation.renderArchitecture(
      candidate.root,
      surface,
      stageIndex,
      termKey,
      { mount }
    );
    if (!projection) return false;
    stageIndex = projection.stageIndex;
    termKey = projection.termKey;
    return true;
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
      OWNER_CONSOLE_SELECTORS.architecture.surface,
      "正在读取管理内容…"
    );
    try {
      const next = await ports.request(
        ENDPOINT,
        ownerRequestOptions(candidate.signal)
      );
      if (!current(ticket)) return false;
      surface = next;
      stageIndex = 0;
      termKey = next.terms?.[0]?.key || "";
      return paint(candidate, { mount: true });
    } catch (error) {
      if (current(ticket)) {
        presentation.setSurfaceMessage(
          candidate.root,
          OWNER_CONSOLE_SELECTORS.architecture.surface,
          error?.message || "架构内容读取失败",
          true
        );
      }
      return false;
    }
  }

  function handleClick(candidate, event) {
    if (!lifecycle.active(lifecycle.context(candidate))) return;
    const view = closestOwnerTarget(candidate.root, event, "[data-view]");
    if (view) {
      event.preventDefault?.();
      ports.navigation.openView(String(view.dataset.view || ""));
      return;
    }
    if (!surface) return;
    const stage = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.architecture.stage
    );
    const term = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.architecture.term
    );
    if (stage) {
      event.preventDefault?.();
      stageIndex = architectureProjection(
        surface,
        Number(stage.dataset.architectureStage) || 0,
        termKey
      ).stageIndex;
      paint(candidate);
    } else if (term) {
      event.preventDefault?.();
      termKey = String(term.dataset.architectureTerm || "");
      paint(candidate);
    }
  }

  function mount(context = {}) {
    const mounted = lifecycle.mount(context);
    const { candidate, dispose } = mounted;
    if (!mounted.ready) return dispose;
    lifecycle.cleanup(candidate, () => { requestSerial += 1; });
    lifecycle.listen(candidate, "click", event => handleClick(candidate, event));
    void load(candidate);
    return dispose;
  }

  function unmount() {
    return lifecycle.detach();
  }

  function resetSession() {
    surface = null;
    stageIndex = 0;
    termKey = "";
    requestSerial += 1;
    lifecycle.reset(root => presentation.clearSurface(
      root,
      OWNER_CONSOLE_SELECTORS.architecture.surface
    ));
  }

  return Object.freeze({
    mount,
    render: () => paint(lifecycle.currentActivation()),
    unmount,
    resetSession,
    reload: () => {
      surface = null;
      requestSerial += 1;
      return load();
    }
  });
}
