import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  OPENING_DEFAULTS,
  RAIN_DEFAULTS,
  validateOpeningConfig,
  validateRainConfig
} from "../public/frontend/opening/config.mjs";
import {
  createOpeningController,
  OPENING_SELECTORS
} from "../public/frontend/opening/controller.mjs";
import { GlassRain } from "../public/frontend/opening/rain-engine.mjs";

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor() {
    super();
    this.hidden = true;
    this.textContent = "";
    this.attributes = new Map();
    this.children = new Map();
    this.animations = [];
    this.focusCount = 0;
  }

  querySelector(selector) {
    return this.children.get(selector) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.focusCount += 1;
  }

  animate(frames, options) {
    let finish;
    const finished = new Promise(resolve => {
      finish = resolve;
    });
    const animation = {
      frames,
      options,
      finished,
      finish,
      cancelCount: 0,
      cancel() {
        this.cancelCount += 1;
      }
    };
    this.animations.push(animation);
    return animation;
  }
}

function createClock() {
  let nextId = 1;
  const entries = [];
  return {
    entries,
    setTimeout(callback, milliseconds) {
      const entry = { id: nextId++, callback, milliseconds, cleared: false, fired: false };
      entries.push(entry);
      return entry.id;
    },
    clearTimeout(id) {
      const entry = entries.find(candidate => candidate.id === id);
      if (entry) entry.cleared = true;
    },
    fire(entry, { includeCleared = false } = {}) {
      if (entry.fired || (entry.cleared && !includeCleared)) return false;
      entry.fired = true;
      entry.callback();
      return true;
    }
  };
}

function createFixture({ reducedMotion = false } = {}) {
  const root = new FakeElement();
  const canvas = new FakeElement();
  const status = new FakeElement();
  const recovery = new FakeElement();
  const retry = new FakeElement();
  root.children.set(OPENING_SELECTORS.canvas, canvas);
  root.children.set(OPENING_SELECTORS.status, status);
  root.children.set(OPENING_SELECTORS.recovery, recovery);
  root.children.set(OPENING_SELECTORS.retry, retry);
  const lifecycleTarget = new FakeEventTarget();
  const clock = createClock();
  const rains = [];
  const createRain = (receivedCanvas, config, environment) => {
    const rain = {
      receivedCanvas,
      config,
      environment,
      starts: 0,
      pauses: 0,
      disposals: 0,
      start() {
        this.starts += 1;
      },
      pause() {
        this.pauses += 1;
      },
      dispose() {
        this.disposals += 1;
      }
    };
    rains.push(rain);
    return rain;
  };
  return {
    root,
    canvas,
    status,
    recovery,
    retry,
    lifecycleTarget,
    clock,
    rains,
    createRain,
    controllerOptions: {
      root,
      canvas,
      status,
      recovery,
      retry,
      lifecycleTarget,
      createRain,
      matchMedia: query => {
        assert.equal(query, "(prefers-reduced-motion: reduce)");
        return { matches: reducedMotion };
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      seed: 1234
    }
  };
}

assert.deepEqual(OPENING_SELECTORS, {
  root: "#opening-screen",
  canvas: "#opening-rain",
  status: "#opening-status",
  recovery: "#opening-recovery",
  retry: "#opening-retry"
});
assert.deepEqual(RAIN_DEFAULTS, {
  density: 3.5,
  trailPercent: 60,
  dropSize: 7.5,
  trailWidth: 12,
  speed: 85,
  bend: 80,
  splash: 5,
  trailLife: 4,
  beadLife: 9,
  contrast: 119,
  slideDelay: 50,
  slideLength: 145,
  protectBrand: false
});
assert.deepEqual(OPENING_DEFAULTS, {
  designVersion: "R9.4-F1",
  schemaVersion: 1,
  enabled: true,
  showBrand: true,
  config: RAIN_DEFAULTS
});
assert.equal(Object.isFrozen(OPENING_DEFAULTS), true);
assert.equal(Object.isFrozen(OPENING_DEFAULTS.config), true);

const validatedRain = validateRainConfig({
  density: "12",
  trailPercent: -4,
  dropSize: "",
  trailWidth: Number.NaN,
  speed: 0,
  bend: 101,
  splash: 4.4,
  trailLife: Number.POSITIVE_INFINITY,
  beadLife: "12",
  contrast: 200,
  slideDelay: -1,
  slideLength: 999,
  protectBrand: true,
  ignored: "not retained"
});
assert.deepEqual(validatedRain, {
  density: 10,
  trailPercent: 0,
  dropSize: 7.5,
  trailWidth: 12,
  speed: 15,
  bend: 100,
  splash: 4.4,
  trailLife: 4,
  beadLife: 12,
  contrast: 140,
  slideDelay: 0,
  slideLength: 400,
  protectBrand: true
});
assert.equal(Object.isFrozen(validatedRain), true);
assert.deepEqual(validateOpeningConfig({
  enabled: false,
  showBrand: false,
  schemaVersion: 99,
  designVersion: "unknown",
  config: { density: 2 }
}), {
  designVersion: "R9.4-F1",
  schemaVersion: 1,
  enabled: false,
  showBrand: false,
  config: { ...RAIN_DEFAULTS, density: 2 }
});

{
  const fixture = createFixture();
  const states = [];
  const requestAnimationFrame = () => 9;
  const controller = createOpeningController({
    ...fixture.controllerOptions,
    requestAnimationFrame,
    onStateChange: state => states.push(state)
  });
  assert.equal(fixture.retry.listenerCount("click"), 1);
  assert.equal(fixture.lifecycleTarget.listenerCount("pagehide"), 1);
  const generation = controller.start();
  assert.equal(generation, 1);
  assert.equal(fixture.root.hidden, false);
  assert.equal(fixture.root.getAttribute("aria-busy"), "true");
  assert.equal(fixture.root.getAttribute("data-opening-state"), "opening");
  assert.equal(fixture.status.textContent, "正在打开此刻");
  assert.equal(fixture.recovery.hidden, true);
  assert.equal(fixture.rains.length, 1);
  assert.equal(fixture.rains[0].receivedCanvas, fixture.canvas);
  assert.deepEqual(fixture.rains[0].config, RAIN_DEFAULTS);
  assert.equal(fixture.rains[0].environment.seed, 1234);
  assert.equal(fixture.rains[0].environment.requestAnimationFrame, requestAnimationFrame);
  assert.equal(fixture.rains[0].starts, 1);

  assert.equal(controller.ready(generation), true);
  assert.equal(controller.ready(generation), true);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "entering");
  assert.equal(fixture.root.getAttribute("aria-busy"), null);
  assert.equal(fixture.root.animations.length, 1);
  assert.equal(fixture.root.animations[0].options.duration, 140);
  assert.equal(fixture.clock.entries.length, 1);
  assert.equal(fixture.clock.entries[0].milliseconds, 140);
  fixture.clock.fire(fixture.clock.entries[0]);
  assert.equal(fixture.root.hidden, true);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "complete");
  assert.equal(fixture.rains[0].disposals, 1);
  assert.deepEqual(states, ["opening", "entering", "complete"]);

  controller.dispose();
  assert.equal(fixture.root.getAttribute("data-opening-state"), "disposed");
  assert.equal(fixture.retry.listenerCount("click"), 0);
  assert.equal(fixture.lifecycleTarget.listenerCount("pagehide"), 0);
  assert.equal(controller.start(), null);
  assert.equal(controller.ready(), false);
}

{
  const fixture = createFixture();
  const controller = createOpeningController(fixture.controllerOptions);
  assert.equal(controller.ready(), true);
  assert.equal(controller.ready(), true);
  const generation = controller.start();
  assert.equal(generation, 1);
  assert.equal(fixture.rains.length, 0, "latched readiness must not start decorative rain");
  assert.equal(fixture.root.getAttribute("data-opening-state"), "entering");
  fixture.clock.fire(fixture.clock.entries[0]);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "complete");
  controller.dispose();
}

{
  const fixture = createFixture({ reducedMotion: true });
  const controller = createOpeningController(fixture.controllerOptions);
  const generation = controller.start();
  assert.equal(fixture.rains.length, 0);
  assert.equal(controller.ready(generation), true);
  assert.equal(fixture.root.hidden, true);
  assert.equal(fixture.root.animations.length, 0);
  assert.equal(fixture.clock.entries.length, 0);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "complete");
  controller.dispose();
}

{
  const fixture = createFixture();
  const retries = [];
  const controller = createOpeningController({
    ...fixture.controllerOptions,
    onRetry: context => retries.push(context)
  });
  const firstGeneration = controller.start();
  assert.equal(controller.fail(firstGeneration + 1), false);
  assert.equal(controller.fail(firstGeneration), true);
  assert.equal(controller.fail(firstGeneration), true);
  assert.equal(fixture.rains[0].pauses, 1);
  assert.equal(fixture.recovery.hidden, false);
  assert.equal(fixture.retry.focusCount, 1);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "failure");
  fixture.retry.dispatch("click", { type: "click" });
  assert.equal(retries.length, 1);
  assert.equal(retries[0].generation, firstGeneration);
  const secondGeneration = retries[0].restart();
  assert.equal(secondGeneration, 2);
  assert.equal(fixture.rains[0].disposals, 1);
  assert.equal(fixture.rains[1].starts, 1);
  assert.equal(fixture.recovery.hidden, true);
  assert.equal(controller.ready(firstGeneration), false);
  assert.equal(controller.fail(firstGeneration), false);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "opening");
  controller.dispose();
}

{
  const fixture = createFixture();
  const controller = createOpeningController(fixture.controllerOptions);
  const firstGeneration = controller.start();
  controller.ready(firstGeneration);
  const staleTimer = fixture.clock.entries[0];
  const staleAnimation = fixture.root.animations[0];
  const secondGeneration = controller.start();
  assert.equal(staleTimer.cleared, true);
  assert.equal(staleAnimation.cancelCount, 1);
  assert.equal(fixture.rains[0].disposals, 1);
  fixture.clock.fire(staleTimer, { includeCleared: true });
  staleAnimation.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.root.hidden, false);
  assert.equal(fixture.root.getAttribute("data-opening-state"), "opening");
  assert.equal(controller.ready(firstGeneration), false);
  assert.equal(controller.fail(firstGeneration), false);

  controller.ready(secondGeneration);
  const currentTimer = fixture.clock.entries.at(-1);
  const currentAnimation = fixture.root.animations.at(-1);
  controller.dispose();
  assert.equal(currentTimer.cleared, true);
  assert.equal(currentAnimation.cancelCount, 1);
  assert.equal(fixture.rains[1].disposals, 1);
  fixture.clock.fire(currentTimer, { includeCleared: true });
  currentAnimation.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.root.getAttribute("data-opening-state"), "disposed");
  assert.equal(fixture.root.hidden, true);
}

{
  const root = new FakeElement();
  const canvas = new FakeElement();
  const status = new FakeElement();
  const recovery = new FakeElement();
  const retry = new FakeElement();
  root.children.set(OPENING_SELECTORS.canvas, canvas);
  root.children.set(OPENING_SELECTORS.status, status);
  root.children.set(OPENING_SELECTORS.recovery, recovery);
  root.children.set(OPENING_SELECTORS.retry, retry);
  const lifecycleTarget = new FakeEventTarget();
  const document = {
    defaultView: lifecycleTarget,
    querySelector: selector => selector === OPENING_SELECTORS.root ? root : null
  };
  lifecycleTarget.matchMedia = () => ({ matches: true });
  const controller = createOpeningController({ document });
  controller.start();
  controller.ready();
  assert.equal(root.getAttribute("data-opening-state"), "complete");
  lifecycleTarget.dispatch("pagehide");
  assert.equal(root.getAttribute("data-opening-state"), "disposed");
}

{
  const document = new FakeEventTarget();
  document.hidden = false;
  const view = new FakeEventTarget();
  document.defaultView = view;
  const context = {
    clearCount: 0,
    setTransform() {},
    clearRect() {
      this.clearCount += 1;
    }
  };
  const canvas = {
    ownerDocument: document,
    width: 0,
    height: 0,
    getContext: type => type === "2d" ? context : null,
    getBoundingClientRect: () => ({ width: 320, height: 180 })
  };
  class FakeResizeObserver {
    static instances = [];
    constructor(callback) {
      this.callback = callback;
      this.disconnectCount = 0;
      FakeResizeObserver.instances.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.disconnectCount += 1;
    }
  }
  let nextFrame = 1;
  const frames = new Map();
  const canceledFrames = [];
  const images = [];
  const engine = new GlassRain(canvas, RAIN_DEFAULTS, {
    seed: 7,
    document,
    view,
    ResizeObserver: FakeResizeObserver,
    devicePixelRatio: () => 2,
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      canceledFrames.push(id);
    },
    createImage() {
      const image = { naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null, src: "" };
      images.push(image);
      return image;
    }
  });
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 360);
  assert.equal(FakeResizeObserver.instances[0].target, canvas);
  assert.equal(document.listenerCount("visibilitychange"), 1);
  engine.start();
  const staleFrame = frames.get(1);
  assert.equal(typeof staleFrame, "function");

  let textureBuilds = 0;
  engine.buildTexture = () => {
    textureBuilds += 1;
  };
  engine.setBackground("first");
  const staleImageLoad = images[0].onload;
  engine.setBackground("second");
  assert.equal(images[0].onload, null);
  staleImageLoad();
  assert.equal(textureBuilds, 0);
  const currentImageLoad = images[1].onload;
  currentImageLoad();
  assert.equal(textureBuilds, 1);
  engine.setBackground("third");
  const disposedImageLoad = images[2].onload;
  engine.dispose();
  assert.equal(images[2].onload, null);
  assert.equal(FakeResizeObserver.instances[0].disconnectCount, 1);
  assert.equal(document.listenerCount("visibilitychange"), 0);
  assert.deepEqual(canceledFrames, [1]);
  assert.equal(engine.stats.active, 0);

  staleFrame(16);
  disposedImageLoad();
  assert.equal(frames.size, 1, "late rAF must not schedule another frame");
  assert.equal(textureBuilds, 1, "late image callbacks must not rebuild texture");
}

const controllerSource = await fs.readFile(
  new URL("../public/frontend/opening/controller.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(
  controllerSource,
  /\b(?:fetch|XMLHttpRequest|WebSocket|location|history)\b|\/api\//,
  "Opening controller must remain route-neutral and perform no network or auth work"
);

console.log("Opening controller checks passed: frozen R9.4-F1 validation, lifecycle, ready latch, failure recovery, reduced motion, generation guards, and complete browser-resource cleanup.");
