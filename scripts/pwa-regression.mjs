import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicPath = (...parts) => path.join(ROOT, "public", ...parts);

const manifest = JSON.parse(await fs.readFile(publicPath("manifest.webmanifest"), "utf8"));
assert.equal(manifest.display, "standalone");
assert.deepEqual(
  manifest.icons.map(icon => [icon.src, icon.sizes, icon.type]),
  [
    ["assets/icons/icon-192.png", "192x192", "image/png"],
    ["assets/icons/icon-512.png", "512x512", "image/png"]
  ]
);

for (const [file, expectedSize] of [
  ["assets/icons/apple-touch-icon.png", 180],
  ["assets/icons/icon-192.png", 192],
  ["assets/icons/icon-512.png", 512]
]) {
  const image = await fs.readFile(publicPath(file));
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(image.readUInt32BE(16), expectedSize);
  assert.equal(image.readUInt32BE(20), expectedSize);
}

const html = await fs.readFile(publicPath("index.html"), "utf8");
assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
assert.match(html, /document\.documentElement\.dataset\.runtimeReady\s*===\s*["']1["']/);
assert.match(html, /setTimeout\(registerWorker,\s*1500\)/);
assert.match(html, /navigator\.serviceWorker\.register\(["']service-worker\.js["']/);
assert.match(html, /const releaseLegacyOpening = \(\) =>/);
assert.match(html, /opening\?\.dataset\.openingState !== "opening"/);
assert.match(html, /opening\.hidden = true/);
const openingBootstrapScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .find(source => source.includes("releaseLegacyOpening"));
assert.ok(openingBootstrapScript, "缺少旧缓存入口的开屏恢复脚本");

function createControlledClock() {
  let now = 0;
  let nextId = 1;
  const entries = [];
  const setTimeout = (callback, milliseconds = 0) => {
    const delay = Math.max(0, Number(milliseconds) || 0);
    const entry = {
      id: nextId,
      callback,
      milliseconds: delay,
      dueAt: now + delay,
      cleared: false,
      fired: false
    };
    nextId += 1;
    entries.push(entry);
    return entry.id;
  };
  const clearTimeout = id => {
    const entry = entries.find(candidate => candidate.id === id);
    if (entry) entry.cleared = true;
  };
  const advance = milliseconds => {
    const target = now + Math.max(0, Number(milliseconds) || 0);
    while (true) {
      const entry = entries
        .filter(candidate => !candidate.cleared && !candidate.fired && candidate.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!entry) break;
      now = entry.dueAt;
      entry.fired = true;
      entry.callback();
    }
    now = target;
  };
  return { advance, clearTimeout, entries, now: () => now, setTimeout };
}

const settleVmTasks = () => new Promise(resolve => setImmediate(resolve));

async function runLegacyOpeningFallback(
  openingState,
  { failEntry = false, failStyles = false, pendingStyles = false, runtimeReady = true } = {}
) {
  const opening = {
    nodeType: 1,
    hidden: false,
    dataset: { openingState },
    attributes: new Set(["aria-busy"]),
    removeAttribute(name) {
      this.attributes.delete(name);
    }
  };
  const application = { nodeType: 1, inert: false };
  const status = { textContent: "loading" };
  const recovery = { hidden: true };
  const retry = {
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    }
  };
  const applicationEntries = [];
  const document = {
    documentElement: { dataset: {} },
    body: { children: [opening, application] },
    head: {
      append(entry) {
        applicationEntries.push(entry);
        if (entry.tagName === "link") {
          if (failStyles) entry.listeners.error?.();
          else if (!pendingStyles) entry.listeners.load?.();
        }
        if (entry.tagName === "script" && failEntry) {
          queueMicrotask(() => entry.listeners.error?.());
        }
      }
    },
    readyState: "complete",
    createElement: tagName => ({
      tagName,
      dataset: {},
      listeners: {},
      listenerHistory: {},
      removed: false,
      addEventListener(type, listener) {
        this.listeners[type] = listener;
        (this.listenerHistory[type] ||= []).push(listener);
      },
      removeEventListener(type, listener) {
        if (this.listeners[type] === listener) delete this.listeners[type];
      },
      dispatch(type, { includeRemoved = false } = {}) {
        const listeners = includeRemoved
          ? this.listenerHistory[type] || []
          : this.listeners[type] ? [this.listeners[type]] : [];
        for (const listener of listeners) listener();
      },
      remove() {
        this.removed = true;
      }
    }),
    querySelector(selector) {
      if (selector === "#opening-screen") return opening;
      if (selector === "#opening-status") return status;
      if (selector === "#opening-recovery") return recovery;
      if (selector === "#opening-retry") return retry;
      return null;
    }
  };
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const marks = new Set();
  const clock = createControlledClock();
  const context = {
    document,
    MutationObserver: FakeMutationObserver,
    performance: {
      now: clock.now,
      getEntriesByName: name => marks.has(name) ? [{}] : [],
      mark: name => marks.add(name)
    },
    requestAnimationFrame: callback => {
      callback();
      return 1;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  };
  context.window = context;
  vm.runInNewContext(openingBootstrapScript, context);
  clock.advance(0);
  await settleVmTasks();
  if (!pendingStyles) await context.window.__forNowStylesReady;
  await settleVmTasks();
  assert.equal(application.inert, true);
  const notify = (target, records = []) => {
    for (const observer of observers) {
      if (!observer.disconnected && observer.target === target) observer.callback(records);
    }
  };
  const signalRuntimeReady = async () => {
    document.documentElement.dataset.runtimeReady = "1";
    notify(document.documentElement);
    await settleVmTasks();
  };
  const advance = async milliseconds => {
    clock.advance(milliseconds);
    await settleVmTasks();
  };
  if (runtimeReady) await signalRuntimeReady();
  return {
    advance,
    application,
    applicationEntries,
    clock,
    context,
    opening,
    observers,
    recovery,
    retry,
    signalRuntimeReady
  };
}

const legacyOpening = await runLegacyOpeningFallback("opening");
assert.equal(legacyOpening.opening.hidden, true);
assert.equal(legacyOpening.opening.dataset.openingState, "complete");
assert.equal(legacyOpening.opening.attributes.has("aria-busy"), false);
assert.equal(legacyOpening.application.inert, false);
assert.deepEqual(
  legacyOpening.applicationEntries
    .filter(entry => entry.tagName === "script")
    .map(entry => [entry.tagName, entry.type, entry.src]),
  [["script", "module", "app.js"]]
);
assert.equal(legacyOpening.observers.every(observer => observer.disconnected), true);
const failedOpening = await runLegacyOpeningFallback("failure");
assert.equal(failedOpening.opening.hidden, false);
assert.equal(failedOpening.opening.dataset.openingState, "failure");
assert.equal(failedOpening.application.inert, true);
assert.equal(failedOpening.observers.every(observer => observer.disconnected), true);
const styleFailure = await runLegacyOpeningFallback("opening", { failStyles: true });
assert.equal(styleFailure.opening.hidden, false);
assert.equal(styleFailure.opening.dataset.openingState, "failure");
assert.equal(styleFailure.application.inert, true);
assert.equal(styleFailure.recovery.hidden, false);
assert.equal(styleFailure.retry.focusCount, 1);
assert.equal(styleFailure.context.__forNowEntryFailed, true);
const entryFailure = await runLegacyOpeningFallback("opening", { failEntry: true });
assert.equal(entryFailure.opening.hidden, false);
assert.equal(entryFailure.opening.dataset.openingState, "failure");
assert.equal(entryFailure.application.inert, true);
assert.equal(entryFailure.recovery.hidden, false);
assert.equal(entryFailure.retry.focusCount, 1);

const assertFailureLocked = (fixture, message) => {
  assert.equal(fixture.opening.hidden, false, `${message}: failure screen must remain visible`);
  assert.equal(fixture.opening.dataset.openingState, "failure", `${message}: failure state must remain latched`);
  assert.equal(fixture.application.inert, true, `${message}: application must remain inert`);
  assert.equal(fixture.recovery.hidden, false, `${message}: recovery action must remain visible`);
  assert.equal(fixture.context.__forNowEntryFailed, true, `${message}: entry failure must remain latched`);
};

const styleTimeout = await runLegacyOpeningFallback("opening", {
  pendingStyles: true,
  runtimeReady: false
});
assert.deepEqual(
  styleTimeout.clock.entries.map(entry => entry.milliseconds).sort((left, right) => left - right),
  [0, 1500, 1500, 5000]
);
await styleTimeout.advance(1499);
assert.equal(styleTimeout.opening.dataset.openingState, "opening");
assert.equal(styleTimeout.application.inert, true);
assert.equal(styleTimeout.context.__forNowEntryFailed, undefined);
await styleTimeout.advance(1);
assertFailureLocked(styleTimeout, "application stylesheet timeout");
const timedOutStyles = styleTimeout.applicationEntries.filter(entry => entry.tagName === "link");
assert.equal(timedOutStyles.length, 2);
assert.equal(timedOutStyles.every(entry => entry.removed), true);
for (const entry of timedOutStyles) entry.dispatch("load", { includeRemoved: true });
await settleVmTasks();
assertFailureLocked(styleTimeout, "late stylesheet load");
await styleTimeout.signalRuntimeReady();
assertFailureLocked(styleTimeout, "runtimeReady after stylesheet timeout");
assert.equal(styleTimeout.observers.every(observer => observer.disconnected), true);

const startupTimeout = await runLegacyOpeningFallback("opening", { runtimeReady: false });
await startupTimeout.advance(4999);
assert.equal(startupTimeout.opening.dataset.openingState, "opening");
assert.equal(startupTimeout.application.inert, true);
await startupTimeout.advance(1);
assertFailureLocked(startupTimeout, "full startup watchdog");
assert.equal(
  startupTimeout.applicationEntries.find(entry => entry.tagName === "script")?.removed,
  true
);
await startupTimeout.signalRuntimeReady();
assertFailureLocked(startupTimeout, "runtimeReady after startup watchdog");
assert.equal(startupTimeout.observers.every(observer => observer.disconnected), true);

const worker = await fs.readFile(publicPath("service-worker.js"), "utf8");
assert.match(worker, /const CACHE_VERSION\s*=\s*["'][^"']+["']/);
assert.match(worker, /const CACHE_VERSION\s*=\s*["']cike-shell-v0\.5\.8-7["']/);
const assetSet = name => {
  const source = worker.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`))?.[1] || "";
  return new Set([...source.matchAll(/["']([^"']+)["']/g)].map(match => match[1]));
};
const shellAssets = assetSet("SHELL_ASSETS");
const katexAssets = assetSet("KATEX_ASSETS");
const backgroundAssets = assetSet("HOME_BACKGROUND_ASSETS");
const lazyModulePaths = assetSet("LAZY_MODULE_PATHS");
for (const asset of [
  "./",
  "index.html",
  "drift.css",
  "app.js",
  "frontend/app/application.mjs",
  "frontend/app/bootstrap.mjs",
  "frontend/app/ports.mjs",
  "frontend/app/runtime.mjs",
  "frontend/feature-registry/index.mjs",
  "frontend/opening/config.mjs",
  "frontend/opening/controller.mjs",
  "frontend/opening/index.mjs",
  "frontend/opening/rain-engine.mjs",
  "frontend/features/actions/controller.mjs",
  "frontend/features/actions/index.mjs",
  "frontend/features/annotations/controller.mjs",
  "frontend/features/annotations/index.mjs",
  "frontend/features/annotations/model.mjs",
  "frontend/features/annotations/operations.mjs",
  "frontend/features/annotations/presentation.mjs",
  "frontend/features/annotations/view.mjs",
  "frontend/sync/index.mjs",
  "frontend/styles/application.css",
  "frontend/styles/r8.css"
]) assert.ok(shellAssets.has(asset), `预缓存缺少 ${asset}`);
for (const asset of [
  "frontend/features/export/index.mjs",
  "frontend/features/feedback/index.mjs",
  "frontend/features/notifications/index.mjs",
  "frontend/features/thought-discovery/index.mjs"
]) {
  assert.equal(shellAssets.has(asset), false, `lazy feature 不得进入 install 预缓存: ${asset}`);
  assert.ok(
    [...lazyModulePaths].some(prefix => `/${asset}`.includes(prefix)),
    `lazy feature 缺少按需缓存边界: ${asset}`
  );
}
for (const asset of [
  "vendor/katex/katex.min.css",
  "vendor/katex/katex.min.js",
  "assets/r8/app-background-desktop.png",
  "assets/r8/app-background-mobile.png",
  "assets/r8/bamboo-edge.png",
  "assets/r8/app-background-desktop.b96820a3fb80.webp",
  "assets/r8/app-background-mobile.22cba13ff0d1.webp",
  "assets/r8/bamboo-edge.5b2206eba5b8.webp",
  "assets/r8/app-background-desktop.f7a62027edd6.avif",
  "assets/r8/app-background-mobile.e8ad4d7f0f47.avif",
  "assets/r8/bamboo-edge.65e8fade3a25.avif"
]) {
  const assets = asset.startsWith("vendor/katex/") ? katexAssets : backgroundAssets;
  assert.ok(assets.has(asset), `静态资源闭包缺少 ${asset}`);
  assert.equal(shellAssets.has(asset), false, `资源必须由独立缓存策略管理: ${asset}`);
}
for (const asset of [...katexAssets, ...backgroundAssets]) {
  await fs.access(publicPath(asset));
}
for (const asset of [...backgroundAssets].filter(value => /\.(?:webp|avif)$/.test(value))) {
  const image = await fs.readFile(publicPath(asset));
  const expectedHash = path.basename(asset).split(".").at(-2);
  assert.equal(crypto.createHash("sha256").update(image).digest("hex").startsWith(expectedHash), true, `背景指纹不匹配: ${asset}`);
  assert.ok(image.length <= 32 * 1024, `背景派生超过 32 KiB: ${asset}`);
  if (asset.endsWith(".webp")) {
    assert.equal(image.subarray(0, 4).toString(), "RIFF");
    assert.equal(image.subarray(8, 12).toString(), "WEBP");
  } else {
    assert.equal(image.subarray(4, 12).toString(), "ftypavif");
  }
}
const katexStyles = await fs.readFile(publicPath("vendor/katex/katex.min.css"), "utf8");
const katexFonts = new Set([...katexStyles.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map(match => `vendor/katex/fonts/${match[1]}`));
for (const font of katexFonts) assert.ok(katexAssets.has(font), `KaTeX 延迟闭包缺少 ${font}`);

const dependencies = source => [
  ...source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g)
].map(match => match[1]);
const pendingModules = [...shellAssets].filter(asset => /\.(?:m?js)$/.test(asset));
const visitedModules = new Set();
while (pendingModules.length) {
  const asset = pendingModules.pop();
  if (visitedModules.has(asset)) continue;
  visitedModules.add(asset);
  const source = await fs.readFile(publicPath(asset), "utf8");
  for (const specifier of dependencies(source)) {
    if (!specifier.startsWith(".")) continue;
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(asset), specifier));
    assert.ok(shellAssets.has(dependency), `预缓存模块闭包缺少 ${dependency}（由 ${asset} 引用）`);
    if (/\.(?:m?js)$/.test(dependency)) pendingModules.push(dependency);
  }
}
assert.match(worker, /cache\.addAll\(\[\.\.\.SHELL_ASSETS,\s*\.\.\.KATEX_ASSETS\]\)/);
assert.match(worker, /event\.respondWith\(cacheOnUse\(request\)\)/);
assert.match(worker, /deferred\s*\|\|\s*lazyModule\(url\)/);
assert.match(worker, /request\.mode\s*===\s*["']navigate["']/);
assert.match(worker, /cache\.match\(["']\.\/["']\)/);
for (const boundary of ["/api/", "/attachments/", "/auth/", "/ai/"]) {
  assert.ok(worker.includes(JSON.stringify(boundary)), `联网排除边界缺少 ${boundary}`);
}
assert.match(worker, /if\s*\(\s*isNetworkOnly\(url\)\s*\)\s*return/);

{
  const handlers = new Map();
  const stored = new Map();
  const networkRequests = [];
  let online = true;
  const requestKey = request => typeof request === "string" ? request : request.url;
  const cache = {
    async addAll() {},
    async match(request) {
      return stored.get(requestKey(request))?.clone();
    },
    async put(request, response) {
      stored.set(requestKey(request), response.clone());
    }
  };
  const context = {
    caches: {
      async keys() {
        return ["cike-shell-v0.5.8-6"];
      },
      async delete() {
        return true;
      },
      async match(request) {
        return cache.match(request);
      },
      async open() {
        return cache;
      }
    },
    fetch: async request => {
      networkRequests.push(requestKey(request));
      if (!online) throw new Error("offline");
      return new Response("export feature", {
        status: 200,
        headers: { "content-type": "text/javascript" }
      });
    },
    Request,
    Response,
    Set,
    URL,
    self: {
      clients: { claim: async () => {} },
      location: { origin: "https://pwa.test" },
      skipWaiting: async () => {},
      addEventListener(type, handler) {
        handlers.set(type, handler);
      }
    }
  };
  vm.runInNewContext(worker, context);
  const request = new Request("https://pwa.test/frontend/features/export/index.mjs");
  const dispatch = async () => {
    let response;
    handlers.get("fetch")({
      request,
      respondWith(value) {
        response = Promise.resolve(value);
      }
    });
    assert.ok(response, "lazy module fetch must be intercepted");
    return response;
  };
  assert.equal(await (await dispatch()).text(), "export feature");
  assert.equal(stored.has(request.url), true);
  online = false;
  assert.equal(await (await dispatch()).text(), "export feature");
  assert.deepEqual(networkRequests, [request.url]);
}

console.log(`PWA contracts passed: install icons, ${visitedModules.size} cached modules, offline KaTeX closure, lazy module cache-on-use, deferred backgrounds, navigation fallback, and private/network-only exclusions.`);
