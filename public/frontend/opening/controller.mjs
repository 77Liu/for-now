import { validateOpeningConfig } from "./config.mjs";

export const OPENING_SELECTORS = Object.freeze({
  root: "#opening-screen",
  canvas: "#opening-rain",
  status: "#opening-status",
  recovery: "#opening-recovery",
  retry: "#opening-retry"
});

function resolveRoot(root, document, selector) {
  if (typeof root === "string") return document?.querySelector?.(root) || null;
  return root || document?.querySelector?.(selector) || null;
}

function resolveChild(root, element, selector) {
  if (typeof element === "string") return root.querySelector?.(element) || null;
  return element || root.querySelector?.(selector) || null;
}

function setBusy(element, busy) {
  if (busy) element.setAttribute("aria-busy", "true");
  else element.removeAttribute("aria-busy");
}

function normalizeContentTargets(value) {
  if (value === undefined || value === null) return [];
  const iterable = typeof value !== "string" && typeof value[Symbol.iterator] === "function";
  const targets = iterable ? [...value] : [value];
  return targets.filter(target => (
    target !== null
    && (typeof target === "object" || typeof target === "function")
  ));
}

export function createOpeningController(options = {}) {
  const {
    selectors: selectorOverrides = {},
    document: injectedDocument,
    root: rootOption,
    canvas: canvasOption,
    status: statusOption,
    recovery: recoveryOption,
    retry: retryOption,
    contentTargets: contentTargetsOption,
    config: configOption,
    backgroundSource,
    backgroundOptions = {},
    createRain = (canvas, config, environment) => import("./rain-engine.mjs")
      .then(({ GlassRain }) => new GlassRain(canvas, config, environment)),
    onRetry = () => {},
    onStateChange = () => {},
    onVisualError = () => {},
    matchMedia: injectedMatchMedia,
    setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis),
    lifecycleTarget: lifecycleTargetOption,
    exitDuration = 140,
    slowDelay = 3500,
    slowMessage = "连接比平时慢，正在继续尝试",
    rainEnvironment = {},
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver,
    createImage,
    createCanvas,
    Path2D,
    devicePixelRatio,
    now,
    seed
  } = options;
  const selectors = { ...OPENING_SELECTORS, ...selectorOverrides };
  const document = injectedDocument
    || (typeof rootOption === "object" ? rootOption?.ownerDocument : null)
    || globalThis.document;
  const root = resolveRoot(rootOption, document, selectors.root);
  if (!root) throw new TypeError(`Opening root not found: ${selectors.root}`);
  const canvas = resolveChild(root, canvasOption, selectors.canvas);
  const status = resolveChild(root, statusOption, selectors.status);
  const recovery = resolveChild(root, recoveryOption, selectors.recovery);
  const retry = resolveChild(root, retryOption, selectors.retry);
  const contentTargets = normalizeContentTargets(contentTargetsOption);
  const lifecycleTarget = lifecycleTargetOption || document?.defaultView;
  const matchMedia = injectedMatchMedia || document?.defaultView?.matchMedia?.bind(document.defaultView);
  const config = validateOpeningConfig(configOption);
  const duration = Math.max(0, Math.min(140, Number(exitDuration) || 0));
  const parsedSlowDelay = Number(slowDelay);
  const openingSlowDelay = Number.isFinite(parsedSlowDelay) && parsedSlowDelay >= 0
    ? parsedSlowDelay
    : 3500;
  const openingSlowMessage = typeof slowMessage === "string"
    ? slowMessage
    : "连接比平时慢，正在继续尝试";
  const directRainEnvironment = {
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver,
    createImage,
    createCanvas,
    Path2D,
    devicePixelRatio,
    now
  };
  for (const [key, value] of Object.entries(directRainEnvironment)) {
    if (value === undefined) delete directRainEnvironment[key];
  }
  const timers = new Set();
  const animations = new Set();

  let generation = 0;
  let activeGeneration = 0;
  let state = "idle";
  let rain = null;
  let readyLatched = false;
  let disposed = false;
  let reducedMotion = false;

  function current(candidate) {
    return !disposed && candidate === activeGeneration;
  }

  function transition(nextState) {
    state = nextState;
    root.setAttribute("data-opening-state", nextState);
    onStateChange(nextState, { generation: activeGeneration });
  }

  function setContentInert(inert) {
    for (const target of contentTargets) target.inert = inert;
  }

  function cancelTimers() {
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  }

  function cancelAnimations() {
    for (const animation of animations) animation.cancel?.();
    animations.clear();
  }

  function releaseRain() {
    rain?.dispose?.();
    rain = null;
  }

  function clearVisualWork() {
    cancelTimers();
    cancelAnimations();
    releaseRain();
  }

  function schedule(callback, milliseconds, expectedGeneration) {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (current(expectedGeneration)) callback();
    }, milliseconds);
    timers.add(timer);
    return timer;
  }

  function complete(expectedGeneration) {
    if (!current(expectedGeneration) || state !== "entering") return false;
    clearVisualWork();
    root.hidden = true;
    setBusy(root, false);
    if (recovery) recovery.hidden = true;
    if (status) status.textContent = "";
    setContentInert(false);
    transition("complete");
    return true;
  }

  function beginExit(expectedGeneration) {
    if (!current(expectedGeneration) || state !== "opening") return false;
    cancelTimers();
    setBusy(root, false);
    if (status) status.textContent = "";
    transition("entering");
    if (reducedMotion) return complete(expectedGeneration);

    if (typeof root.animate !== "function") return complete(expectedGeneration);
    let animation;
    try {
      animation = root.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration, easing: "ease-out", fill: "forwards" }
      );
    } catch (error) {
      onVisualError(error);
      return complete(expectedGeneration);
    }
    animations.add(animation);
    const finish = () => complete(expectedGeneration);
    Promise.resolve(animation.finished).then(finish).catch(() => {});
    schedule(finish, duration, expectedGeneration);
    return true;
  }

  function prefersReducedMotion() {
    try {
      return Boolean(matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return true;
    }
  }

  function activateRain(candidate, expectedGeneration) {
    if (!candidate) return false;
    if (!current(expectedGeneration) || state !== "opening") {
      candidate.dispose?.();
      return false;
    }
    rain = candidate;
    if (backgroundSource !== undefined) {
      const backgroundRain = rain;
      try {
        const backgroundResult = rain.setBackground?.(backgroundSource, backgroundOptions);
        Promise.resolve(backgroundResult).catch(error => {
          if (current(expectedGeneration) && rain === backgroundRain) onVisualError(error);
        });
      } catch (error) {
        onVisualError(error);
      }
    }
    rain.start?.();
    return true;
  }

  function start() {
    if (disposed) return null;
    generation += 1;
    activeGeneration = generation;
    clearVisualWork();
    const startsReady = readyLatched;
    readyLatched = false;
    reducedMotion = prefersReducedMotion();

    setContentInert(true);
    root.hidden = false;
    setBusy(root, true);
    transition("opening");
    if (recovery) recovery.hidden = true;
    if (status) status.textContent = "正在打开此刻";

    if (startsReady) {
      beginExit(activeGeneration);
      return activeGeneration;
    }
    if (status) {
      const expectedGeneration = activeGeneration;
      schedule(() => {
        if (state === "opening") status.textContent = openingSlowMessage;
      }, openingSlowDelay, expectedGeneration);
    }
    if (!reducedMotion && config.enabled && canvas) {
      const expectedGeneration = activeGeneration;
      try {
        const candidate = createRain(canvas, config.config, {
          ...rainEnvironment,
          ...directRainEnvironment,
          seed
        });
        if (candidate && typeof candidate.then === "function") {
          Promise.resolve(candidate)
            .then(nextRain => activateRain(nextRain, expectedGeneration))
            .catch(error => {
              if (current(expectedGeneration) && state === "opening") {
                releaseRain();
                onVisualError(error);
              }
            });
        } else {
          activateRain(candidate, expectedGeneration);
        }
      } catch (error) {
        releaseRain();
        onVisualError(error);
      }
    }
    return activeGeneration;
  }

  function ready(candidateGeneration) {
    if (disposed) return false;
    if (state === "idle") {
      if (candidateGeneration !== undefined) return false;
      readyLatched = true;
      return true;
    }
    if (candidateGeneration !== undefined && candidateGeneration !== activeGeneration) return false;
    if (state === "entering" || state === "complete") return true;
    if (state !== "opening") return false;
    return beginExit(activeGeneration);
  }

  function fail(candidateGeneration) {
    if (disposed || state === "idle" || state === "complete") return false;
    if (candidateGeneration !== undefined && candidateGeneration !== activeGeneration) return false;
    if (state === "failure") return true;
    if (state !== "opening") return false;
    cancelTimers();
    cancelAnimations();
    releaseRain();
    setContentInert(true);
    setBusy(root, false);
    transition("failure");
    if (status) status.textContent = "";
    if (recovery) recovery.hidden = false;
    retry?.focus?.();
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    activeGeneration = generation;
    clearVisualWork();
    retry?.removeEventListener?.("click", handleRetry);
    lifecycleTarget?.removeEventListener?.("pagehide", handlePageHide);
    readyLatched = false;
    root.hidden = true;
    setBusy(root, false);
    setContentInert(false);
    transition("disposed");
  }

  function handleRetry(event) {
    if (disposed || state !== "failure") return;
    onRetry({
      event,
      generation: activeGeneration,
      restart: start
    });
  }

  function handlePageHide(event) {
    if (!event?.persisted) dispose();
  }

  retry?.addEventListener?.("click", handleRetry);
  lifecycleTarget?.addEventListener?.("pagehide", handlePageHide);

  return Object.freeze({ start, ready, fail, dispose });
}
