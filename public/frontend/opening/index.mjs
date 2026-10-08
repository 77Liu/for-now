import { createOpeningController } from "./controller.mjs";

export {
  OPENING_DEFAULTS,
  OPENING_DESIGN_VERSION,
  RAIN_DEFAULTS,
  RAIN_LIMITS,
  validateOpeningConfig,
  validateRainConfig
} from "../shared/opening/index.mjs";
export { createOpeningController, OPENING_SELECTORS } from "./controller.mjs";
export async function loadGlassRain() {
  return (await import("./rain-engine.mjs")).GlassRain;
}

function markOnce(performance, name) {
  if (!performance?.mark || performance.getEntriesByName?.(name)?.length) return;
  performance.mark(name);
}

export function startOpening({
  document = globalThis.document,
  location = globalThis.location,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  performance = globalThis.performance
} = {}) {
  const root = document.querySelector("#opening-screen");
  const view = document.defaultView || globalThis;
  const mobile = Boolean(matchMedia?.("(max-width: 720px)")?.matches);
  const backgroundSource = new URL(
    mobile
      ? "../../assets/r8/app-background-mobile.e8ad4d7f0f47.avif"
      : "../../assets/r8/app-background-desktop.f7a62027edd6.avif",
    import.meta.url
  ).href;
  let resolveCompletion;
  let completionSettled = false;
  let completionScheduled = false;
  const completion = new Promise(resolve => {
    resolveCompletion = resolve;
  });
  const settleCompletion = state => {
    if (completionSettled) return;
    if (state === "disposed" || document.visibilityState === "hidden"
      || typeof view.requestAnimationFrame !== "function") {
      completionSettled = true;
      resolveCompletion(state);
      return;
    }
    if (completionScheduled) return;
    completionScheduled = true;
    view.requestAnimationFrame(() => view.setTimeout(() => {
      if (completionSettled) return;
      completionSettled = true;
      markOnce(performance, "openingExitPainted");
      resolveCompletion(state);
    }, 0));
  };
  const controller = createOpeningController({
    document,
    root,
    contentTargets: [...document.body.children].filter(element => element !== root),
    backgroundSource,
    exitDuration: 80,
    onRetry: () => location.reload(),
    onStateChange(state) {
      if (state === "opening") markOnce(performance, "openingAnimationStarted");
      if (state === "entering") markOnce(performance, "openingExitStart");
      if (state === "complete") markOnce(performance, "openingExitComplete");
      if (state === "complete" || state === "disposed") settleCompletion(state);
    }
  });
  const generation = controller.start();

  return Object.freeze({
    applyPreferences: controller.applyPreferences,
    ready() {
      markOnce(performance, "openingReady");
      const accepted = controller.ready(generation);
      return accepted ? completion.then(() => true) : Promise.resolve(false);
    },
    fail() {
      return controller.fail(generation);
    },
    dispose() {
      controller.dispose();
    }
  });
}
