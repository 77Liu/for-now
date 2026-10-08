import { RAIN_DEFAULTS, validateRainConfig } from "../shared/opening/index.mjs";

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smooth = value => value * value * (3 - 2 * value);

export function freshRainSeed({
  crypto = globalThis.crypto,
  now = Date.now,
  random = Math.random
} = {}) {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  } catch {
    return (now() ^ Math.floor(random() * 4294967296)) >>> 0;
  }
}

function makeRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function createEnvironment(canvas, overrides) {
  const document = overrides.document || canvas.ownerDocument || globalThis.document;
  const view = overrides.view || document?.defaultView || globalThis;
  const setTimer = overrides.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = overrides.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const now = overrides.now || (() => globalThis.performance?.now?.() ?? Date.now());
  const devicePixelRatio = overrides.devicePixelRatio;
  return {
    document,
    view,
    now,
    devicePixelRatio: typeof devicePixelRatio === "function"
      ? devicePixelRatio
      : () => devicePixelRatio ?? view?.devicePixelRatio ?? 1,
    createCanvas: overrides.createCanvas || (() => document?.createElement("canvas")),
    createImage: overrides.createImage || (() => new view.Image()),
    Path2D: overrides.Path2D || view?.Path2D || globalThis.Path2D,
    ResizeObserver: overrides.ResizeObserver === undefined
      ? view?.ResizeObserver
      : overrides.ResizeObserver,
    requestAnimationFrame: overrides.requestAnimationFrame
      || view?.requestAnimationFrame?.bind(view)
      || (callback => setTimer(() => callback(now()), 16)),
    cancelAnimationFrame: overrides.cancelAnimationFrame
      || view?.cancelAnimationFrame?.bind(view)
      || clearTimer
  };
}

export class GlassRain {
  constructor(canvas, config = {}, options = {}) {
    if (typeof options === "number") options = { seed: options };
    const context = canvas?.getContext?.("2d");
    if (!context) throw new TypeError("GlassRain requires a 2D canvas");
    this.canvas = canvas;
    this.ctx = context;
    this.environment = createEnvironment(canvas, options);
    this.config = validateRainConfig(config);
    this.seed = (options.seed ?? freshRainSeed(options)) >>> 0;
    this.rng = makeRandom(this.seed);
    this.drops = [];
    this.time = 0;
    this.next = 0.65;
    this.running = false;
    this.disposed = false;
    this.total = 0;
    this.flows = 0;
    this.last = 0;
    this.accumulator = 0;
    this.frame = null;
    this.frameGeneration = 0;
    this.imageGeneration = 0;
    this.visible = this.environment.document ? !this.environment.document.hidden : true;
    this.resize = () => this.#resize();
    this.visibility = () => {
      this.visible = !this.environment.document.hidden;
      this.last = 0;
    };

    const ResizeObserver = this.environment.ResizeObserver;
    if (ResizeObserver) {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(canvas);
    } else if (this.environment.view?.addEventListener) {
      this.environment.view.addEventListener("resize", this.resize);
      this.resizeTarget = this.environment.view;
    }
    this.environment.document?.addEventListener?.("visibilitychange", this.visibility);
    this.#resize();
  }

  #resize() {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect?.() || {};
    this.w = Number(rect.width) || this.canvas.clientWidth || 0;
    this.h = Number(rect.height) || this.canvas.clientHeight || 0;
    this.dpr = Math.min(2, Math.max(1, Number(this.environment.devicePixelRatio()) || 1));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.buildTexture();
    this.render();
  }

  #clearImageCallbacks() {
    this.imageCleanup?.();
    this.imageCleanup = null;
  }

  setBackground(source, options = {}) {
    if (this.disposed) return false;
    this.backgroundOptions = {
      opacity: 0.78,
      maskStart: 0.18,
      maskEnd: 0.86,
      ...options
    };
    if (this.backgroundSource === source && this.image) {
      this.buildTexture();
      this.render();
      return true;
    }

    this.imageGeneration += 1;
    this.#clearImageCallbacks();
    this.backgroundSource = source;
    this.texture = null;
    if (!source) {
      this.image = null;
      this.render();
      return true;
    }

    const image = typeof source === "string" ? this.environment.createImage() : source;
    if (!image) return false;
    const generation = this.imageGeneration;
    this.image = image;
    let cleanup = () => {};
    const settle = loaded => {
      cleanup();
      if (this.imageCleanup === cleanup) this.imageCleanup = null;
      if (this.disposed || generation !== this.imageGeneration || this.image !== image) return;
      if (loaded) this.buildTexture();
      this.render();
    };
    const onload = () => settle(true);
    const onerror = () => settle(false);
    if (image.addEventListener) {
      image.addEventListener("load", onload);
      image.addEventListener("error", onerror);
      cleanup = () => {
        image.removeEventListener("load", onload);
        image.removeEventListener("error", onerror);
      };
    } else {
      image.onload = onload;
      image.onerror = onerror;
      cleanup = () => {
        if (image.onload === onload) image.onload = null;
        if (image.onerror === onerror) image.onerror = null;
      };
    }
    this.imageCleanup = cleanup;
    if (image.naturalWidth) settle(true);
    else if (typeof source === "string") image.src = source;
    return true;
  }

  buildTexture() {
    if (!this.image?.naturalWidth || !this.w || !this.h) return;
    const canvas = this.environment.createCanvas();
    const context = canvas?.getContext?.("2d");
    if (!context) return;
    canvas.width = Math.ceil(this.w);
    canvas.height = Math.ceil(this.h);
    const options = this.backgroundOptions;
    const scale = Math.max(
      this.w / this.image.naturalWidth,
      this.h / this.image.naturalHeight
    );
    const width = this.image.naturalWidth * scale;
    const height = this.image.naturalHeight * scale;
    context.globalAlpha = options.opacity;
    context.drawImage(this.image, (this.w - width) / 2, this.h - height, width, height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-in";
    const mask = context.createLinearGradient(0, 0, 0, this.h);
    mask.addColorStop(options.maskStart, "rgba(0,0,0,0)");
    mask.addColorStop(options.maskEnd, "rgba(0,0,0,1)");
    context.fillStyle = mask;
    context.fillRect(0, 0, this.w, this.h);
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fbfcf7";
    context.fillRect(0, 0, this.w, this.h);
    this.texture = canvas;
  }

  update(config) {
    if (this.disposed) return;
    const previousDensity = this.config.density;
    this.config = validateRainConfig({ ...this.config, ...config });
    if (this.config.density > 0) {
      this.next = previousDensity === 0
        ? this.time + 1 / this.config.density
        : Math.min(this.next, this.time + 1 / this.config.density);
    }
  }

  reset(seed = freshRainSeed()) {
    if (this.disposed) return;
    this.seed = seed >>> 0;
    this.rng = makeRandom(this.seed);
    this.drops = [];
    this.time = 0;
    this.next = 0.65;
    this.total = 0;
    this.flows = 0;
    this.accumulator = 0;
    this.render();
  }

  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.last = 0;
    const generation = ++this.frameGeneration;
    const frame = now => {
      if (this.disposed || !this.running || generation !== this.frameGeneration) return;
      const delta = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
      this.last = now;
      if (this.visible) {
        this.accumulator += delta;
        while (this.accumulator >= 1 / 60) {
          this.advance(1 / 60);
          this.accumulator -= 1 / 60;
        }
        this.render();
      }
      this.frame = this.environment.requestAnimationFrame(frame);
    };
    this.frame = this.environment.requestAnimationFrame(frame);
  }

  pause() {
    this.running = false;
    this.frameGeneration += 1;
    if (this.frame !== null) this.environment.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.last = 0;
  }

  seek(milliseconds) {
    if (this.disposed) return;
    this.pause();
    this.reset(this.seed);
    const target = Math.max(0, Number(milliseconds) || 0) / 1000;
    for (let time = 0; time < target; time += 1 / 60) {
      this.advance(Math.min(1 / 60, target - time));
    }
    this.render();
  }

  dispose() {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.imageGeneration += 1;
    this.#clearImageCallbacks();
    this.image = null;
    this.texture = null;
    this.observer?.disconnect();
    this.resizeTarget?.removeEventListener?.("resize", this.resize);
    this.environment.document?.removeEventListener?.("visibilitychange", this.visibility);
    this.drops = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  advance(delta) {
    if (this.disposed) return;
    this.time += delta;
    const config = this.config;
    if (config.density > 0 && this.time >= this.next) {
      if (this.drops.length < 160) this.spawn();
      this.next += (0.38 + this.rng() * 1.24) / config.density;
    }
    for (const drop of this.drops) this.step(drop);
    this.drops = this.drops.filter(drop => this.time - drop.born < drop.life);
  }

  spawn() {
    const random = this.rng;
    const config = { ...this.config };
    const flow = random() * 100 < config.trailPercent;
    let x = 0.06 + random() * 0.88;
    let y = 0.06 + random() * 0.34;
    const length = Math.min(this.h * 0.65, config.slideLength * (0.7 + random() * 0.6));
    if (config.protectBrand && flow) x = random() < 0.5 ? 0.08 + random() * 0.22 : 0.72 + random() * 0.2;
    if (config.protectBrand && !flow && x > 0.34 && x < 0.66 && y > 0.29) y = 0.08 + random() * 0.16;
    const size = config.dropSize * (0.72 + random() * 0.5);
    const radius = flow ? Math.max(size, config.trailWidth * 0.68) : size;
    const hold = flow ? config.slideDelay / 1000 * (0.7 + random() * 0.6) : 0;
    const travel = length / config.speed;
    const drop = {
      c: config,
      born: this.time,
      flow,
      x: x * this.w,
      y: y * this.h,
      r: radius,
      hold,
      travel,
      length,
      life: flow ? hold + travel + config.trailLife : config.beadLife * (0.75 + random() * 0.5),
      merges: [],
      phase: random() * 6.28,
      amp: config.bend * 0.16 * (0.55 + random() * 0.55),
      offset: random() * 6.28,
      points: [],
      progress: 0
    };
    drop.knots = [0];
    for (let index = 1; index < 5; index += 1) {
      drop.knots.push(clamp(drop.knots[index - 1] + random() * 0.95 - 0.475, -1, 1));
    }
    drop.widths = Array.from({ length: 9 }, () => 0.78 + random() * 0.35);
    drop.satellites = Array.from({ length: Math.round(config.splash) }, () => ({
      a: random() * 6.28,
      dist: 7 + random() * radius * 2.7,
      r: 0.65 + random() * 1.1,
      stay: random() < 0.32,
      life: 1.3 + random() * 2.5
    }));
    drop.points.push({ x: drop.x, y: drop.y, p: 0 });
    this.drops.push(drop);
    this.total += 1;
    if (flow) this.flows += 1;
  }

  point(drop, progress) {
    const knot = progress * (drop.knots.length - 1);
    const index = Math.min(drop.knots.length - 2, Math.floor(knot));
    const ratio = smooth(knot - index);
    return {
      x: drop.x + drop.amp * (
        drop.knots[index] * (1 - ratio) + drop.knots[index + 1] * ratio - drop.knots[0]
      ),
      y: drop.y + drop.length * progress,
      p: progress
    };
  }

  step(drop) {
    if (!drop.flow) return;
    const age = this.time - drop.born;
    const movement = clamp((age - drop.hold) / drop.travel, 0, 1);
    const progress = clamp(
      movement + Math.sin(movement * Math.PI * 6 + drop.phase) * 0.021 * Math.sin(movement * Math.PI),
      0,
      1
    );
    drop.progress = Math.max(drop.progress, progress);
    const head = this.point(drop, drop.progress);
    const previous = drop.points.at(-1);
    if (age > drop.hold && drop.progress < 1) {
      for (const other of this.drops) {
        if (other === drop || other.flow || other.life <= this.time - other.born) continue;
        if (Math.hypot(head.x - other.x, head.y - other.y) < (drop.r + other.r) * 0.65) {
          drop.r = Math.min(24, Math.cbrt(drop.r ** 3 + other.r ** 3 * 0.65));
          drop.merges.push(drop.progress);
          other.life = this.time - other.born;
        }
      }
    }
    if (Math.hypot(head.x - previous.x, head.y - previous.y) > 1.6
      || (drop.progress === 1 && previous.p !== 1)) {
      drop.points.push(head);
    }
  }

  width(drop, progress) {
    const position = progress * 8;
    const index = Math.min(7, Math.floor(position));
    const ratio = smooth(position - index);
    const bulge = drop.widths[index] * (1 - ratio) + drop.widths[index + 1] * ratio;
    const pocket = 1 + Math.min(0.3, drop.merges.reduce(
      (sum, merge) => sum + 0.28 * Math.exp(-(((progress - merge) / 0.026) ** 2)),
      0
    ));
    const wetAge = Math.max(0, this.time - drop.born - drop.hold - progress * drop.travel);
    const neck = 0.34 + 0.66 * Math.exp(-wetAge / 1.05);
    return drop.c.trailWidth * 0.5 * bulge * pocket * neck
      * (0.7 + 0.3 * clamp(progress * 18, 0, 1));
  }

  ribbon(drop) {
    const points = drop.points;
    const Path2D = this.environment.Path2D;
    if (points.length < 2 || !Path2D) return;
    const left = [];
    const right = [];
    for (let index = 0; index < points.length; index += 1) {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const length = Math.hypot(after.x - before.x, after.y - before.y) || 1;
      const normalX = -(after.y - before.y) / length;
      const normalY = (after.x - before.x) / length;
      const half = this.width(drop, points[index].p);
      left.push({ x: points[index].x + normalX * half, y: points[index].y + normalY * half });
      right.push({ x: points[index].x - normalX * half, y: points[index].y - normalY * half });
    }
    const context = this.ctx;
    const path = new Path2D();
    path.moveTo(left[0].x, left[0].y);
    for (let index = 1; index < left.length; index += 1) path.lineTo(left[index].x, left[index].y);
    const end = points.at(-1);
    const last = right.at(-1);
    path.quadraticCurveTo(end.x, end.y + this.width(drop, end.p), last.x, last.y);
    for (let index = right.length - 2; index >= 0; index -= 1) path.lineTo(right[index].x, right[index].y);
    path.quadraticCurveTo(
      points[0].x,
      points[0].y - this.width(drop, 0),
      left[0].x,
      left[0].y
    );
    path.closePath();

    const age = this.time - drop.born;
    const after = Math.max(0, age - drop.hold - drop.travel);
    const fade = 1 - smooth(clamp(after / drop.c.trailLife, 0, 1));
    context.save();
    context.globalAlpha = fade * drop.c.contrast / 100;
    context.save();
    context.clip(path);
    if (this.texture) {
      context.globalAlpha *= 0.82;
      context.drawImage(this.texture, -2.5, -1, this.w + 5, this.h + 2);
    }
    context.restore();
    context.save();
    context.shadowColor = "rgba(58,94,45,.12)";
    context.shadowBlur = 2;
    context.fillStyle = "rgba(156,186,129,.065)";
    context.fill(path);
    context.restore();
    const edge = (edgePoints, color, width) => {
      if (!edgePoints.length) return;
      context.beginPath();
      context.moveTo(edgePoints[0].x, edgePoints[0].y);
      for (let index = 1; index < edgePoints.length; index += 1) {
        context.lineTo(edgePoints[index].x, edgePoints[index].y);
      }
      context.strokeStyle = color;
      context.lineWidth = width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    };
    edge(left, "rgba(63,99,56,.23)", 0.72);
    edge(right, "rgba(97,129,73,.055)", 0.6);
    for (let index = 2; index < points.length; index += 9) {
      const point = points[index];
      const fresh = Math.exp(-Math.max(0, age - drop.hold - point.p * drop.travel) / 2.1);
      const glint = 0.35 + 0.65 * Math.max(0, Math.sin(point.p * 19 + drop.phase));
      context.save();
      context.globalAlpha *= glint * (0.24 + 0.76 * fresh);
      edge(
        left.slice(Math.max(0, index - 2), Math.min(points.length, index + 7)),
        "rgba(246,255,231,.92)",
        1.35
      );
      if (Math.sin(point.p * 27 + drop.offset) > 0.3) {
        edge(
          right.slice(index, Math.min(points.length, index + 5)),
          "rgba(83,116,60,.20)",
          0.72
        );
      }
      context.restore();
    }
    const root = points[0];
    this.bead(
      root.x,
      root.y,
      Math.min(2.8, drop.c.trailWidth * 0.3),
      0.32 * fade * drop.c.contrast / 100
    );
    context.restore();
  }

  bead(x, y, radius, alpha, stretch = 1) {
    const context = this.ctx;
    context.save();
    context.globalAlpha = alpha;
    context.translate(x, y);
    context.scale(1, stretch);
    context.beginPath();
    context.ellipse(0, 0, radius, radius * 1.04, 0, 0, Math.PI * 2);
    const gradient = context.createRadialGradient(
      -radius * 0.3,
      -radius * 0.42,
      radius * 0.12,
      0,
      radius * 0.12,
      radius * 1.18
    );
    gradient.addColorStop(0, "rgba(248,254,230,.04)");
    gradient.addColorStop(0.57, "rgba(166,197,137,.13)");
    gradient.addColorStop(0.8, "rgba(76,115,66,.20)");
    gradient.addColorStop(0.94, "rgba(62,100,53,.47)");
    gradient.addColorStop(1, "rgba(226,242,203,.48)");
    if (this.texture && radius > 2) {
      context.save();
      context.clip();
      const scale = 1.55;
      context.globalAlpha *= 0.88;
      context.drawImage(
        this.texture,
        x - radius / scale,
        y - radius / scale,
        2 * radius / scale,
        2 * radius / scale,
        -radius,
        -radius,
        2 * radius,
        2 * radius
      );
      context.restore();
    }
    context.fillStyle = gradient;
    context.fill();
    context.strokeStyle = "rgba(81,115,63,.4)";
    context.lineWidth = 0.6;
    context.stroke();
    context.beginPath();
    context.ellipse(
      -radius * 0.18,
      -radius * 0.1,
      radius * 0.69,
      radius * 0.77,
      -0.3,
      Math.PI * 0.78,
      Math.PI * 1.37
    );
    context.strokeStyle = "rgba(253,255,239,.94)";
    context.lineWidth = Math.max(0.7, radius * 0.1);
    context.lineCap = "round";
    context.stroke();
    context.beginPath();
    context.ellipse(radius * 0.23, radius * 0.59, radius * 0.4, radius * 0.1, -0.15, 0, Math.PI * 2);
    context.fillStyle = "rgba(75,111,55,.38)";
    context.fill();
    context.restore();
  }

  render() {
    if (this.disposed || !this.w || !this.h) return;
    const context = this.ctx;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.w, this.h);
    for (const drop of this.drops) {
      const age = this.time - drop.born;
      this.ribbon(drop);
      if (age < 3.8) {
        for (const satellite of drop.satellites) {
          const progress = clamp(age / 0.22, 0, 1);
          const distance = satellite.dist * (1 - (1 - progress) ** 3);
          const alpha = satellite.stay
            ? clamp(1 - age / satellite.life, 0, 1) * 0.66
            : (1 - progress) * 0.7;
          this.bead(
            drop.x + Math.cos(satellite.a) * distance,
            drop.y + Math.sin(satellite.a) * distance,
            satellite.r,
            alpha * drop.c.contrast / 100
          );
        }
      }
      const head = drop.flow ? this.point(drop, drop.progress) : { x: drop.x, y: drop.y };
      const fade = drop.flow
        ? 1 - smooth(clamp((age - drop.hold - drop.travel) / 0.8, 0, 1))
        : 1 - smooth(clamp((age - drop.life + 2) / 2, 0, 1));
      const impact = 1 + 0.32 * Math.sin(clamp(age / 0.16, 0, 1) * Math.PI);
      this.bead(
        head.x,
        head.y,
        drop.r * impact,
        Math.min(1, age / 0.024) * fade * drop.c.contrast / 100,
        drop.flow && age > drop.hold && drop.progress < 1 ? 1.12 : 1
      );
    }
  }

  get stats() {
    return {
      active: this.drops.length,
      sliding: this.drops.filter(
        drop => drop.flow && drop.progress < 1 && this.time - drop.born > drop.hold
      ).length,
      total: this.total,
      flows: this.flows,
      time: this.time,
      seed: this.seed
    };
  }
}

GlassRain.defaults = RAIN_DEFAULTS;
GlassRain.validate = validateRainConfig;
GlassRain.freshSeed = freshRainSeed;
