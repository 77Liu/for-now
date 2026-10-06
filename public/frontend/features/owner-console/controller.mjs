import { createAiCostOwnerController } from "./ai-cost-controller.mjs";
import { createArchitectureOwnerController } from "./architecture-controller.mjs";
import { createCommercializationOwnerController } from "./commercialization-controller.mjs";
import { OWNER_CONSOLE_VIEWS } from "./model.mjs";
import { normalizeOwnerConsolePorts } from "./ports.mjs";
import { createOwnerConsolePresentation } from "./presentation.mjs";

const OWNER_VIEW_SET = new Set(OWNER_CONSOLE_VIEWS);

export function createOwnerConsoleFeatureController(options = {}) {
  const view = String(options.view || options.page || "");
  if (!OWNER_VIEW_SET.has(view)) {
    throw new TypeError(`Unknown owner console view: ${view}`);
  }
  const ports = normalizeOwnerConsolePorts(options);
  const presentation = createOwnerConsolePresentation(ports);
  if (view === "ai-cost") {
    return createAiCostOwnerController({ ports, presentation });
  }
  if (view === "architecture") {
    return createArchitectureOwnerController({ ports, presentation });
  }
  return createCommercializationOwnerController({ ports, presentation });
}
