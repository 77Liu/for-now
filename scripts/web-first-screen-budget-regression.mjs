import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { emptyClientState } from "../public/frontend/state/index.mjs";
import { isApplicationRoutePath } from "../public/frontend/pages/index.mjs";
import { routeStateProjection } from "../src/app/index.mjs";
import { onboardingV2Schema } from "../src/modules/onboarding/index.mjs";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const CHROME = resolveHeadlessBrowser();
const integerSetting = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};
const SAMPLE_COUNT = integerSetting("WEB_PERF_SAMPLE_COUNT", 10, 10, 50);
const REPORT_PATH = String(process.env.WEB_PERF_REPORT_PATH || "").trim();
const ASSET_BUDGET = Object.freeze({
  blockingStyleRequests: 2,
  blockingStyleBytes: 250 * 1024,
  entryModuleCount: 10,
  entryModuleBytes: 72 * 1024,
  deferredRuntimeModuleCount: 24,
  deferredRuntimeModuleBytes: 800 * 1024,
  defaultRouteModuleCount: 2,
  defaultRouteModuleBytes: 16 * 1024,
  lazyFeatureModuleCount: 3,
  lazyFeatureModuleBytes: 40 * 1024
});
const HIDDEN_FEATURE_MODULE_PATHS = Object.freeze([
  "/frontend/features/actions/controller.mjs",
  "/frontend/features/export/index.mjs",
  "/frontend/features/export/controller.mjs",
  "/frontend/features/export/downloads.mjs",
  "/frontend/features/feedback/index.mjs",
  "/frontend/features/feedback/controller.mjs",
  "/frontend/features/feedback/model.mjs",
  "/frontend/features/notifications/index.mjs",
  "/frontend/features/notifications/controller.mjs",
  "/frontend/features/notifications/presentation.mjs",
  "/frontend/features/thought-discovery/index.mjs",
  "/frontend/features/thought-discovery/controller.mjs",
  "/frontend/features/thought-discovery/headless.mjs"
]);
const HTTP_BUDGET = Object.freeze({
  startupJsonDecodedBytes: 25 * 1024,
  initialJsonTransferBytes: 200 * 1024,
  firstReadableRequests: 80,
  firstReadableApiRequests: 10,
  mediaBeforeClickTransferBytes: 0
});
const TIMING_BUDGET = Object.freeze({
  "web.startup.coldCache.currentScreenFeedback_ms": { p75: 250, p95: 250 },
  "web.startup.coldCache.firstReadable_ms": { p75: 1000, p95: 1500 },
  "web.startup.warmCache.currentScreenFeedback_ms": { p75: 250, p95: 250 },
  "web.startup.warmCache.firstReadable_ms": { p75: 750, p95: 1000 },
  "web.navigation.routeSwitch.firstReadable_ms": { p75: 350, p95: 600 },
  "web.navigation.thoughtDetail.firstReadable_ms": { p75: 350, p95: 600 },
  "web.navigation.thoughtDetailReturn.firstReadable_ms": { p75: 250, p95: 500 },
  "web.sync.secondDeviceCommitToReadable_ms": { p75: 500, p95: 1000 }
});
const OPENING_BUDGET = Object.freeze({
  firstContentfulPaintMs: 250,
  readyToPaintedMs: 140,
  uiPreferenceRequests: 1
});
const OPENING_TIMING_BOUNDARY_TOLERANCE_MS = 1;
const NETWORK_PROFILE = Object.freeze({
  name: "fixed-fast-4g",
  latency: 40,
  downloadThroughput: 1_250_000,
  uploadThroughput: 625_000,
  connectionType: "cellular4g"
});
const VIEWPORT = Object.freeze({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const normalizeAsset = asset => path.posix.normalize(asset.replace(/^\.?\//, ""));
const publicFile = asset => path.join(PUBLIC, ...normalizeAsset(asset).split("/"));
const fileBytes = async asset => (await fs.stat(publicFile(asset))).size;

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] || "";
}

async function blockingStyleClosure(html) {
  const pending = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => (
      attribute(tag, "rel").split(/\s+/).includes("stylesheet")
      && attribute(tag, "media").toLowerCase() !== "print"
    ))
    .map(tag => attribute(tag, "href"))
    .filter(Boolean);
  const assets = new Set();
  let bytes = 0;

  while (pending.length) {
    const asset = normalizeAsset(pending.pop());
    if (assets.has(asset)) continue;
    assets.add(asset);
    const source = await fs.readFile(publicFile(asset), "utf8");
    bytes += await fileBytes(asset);
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/gi)) {
      pending.push(path.posix.join(path.posix.dirname(asset), match[1]));
    }
  }
  return { assets: [...assets].sort(), bytes };
}

const moduleDependencies = (source, { includeDynamic = false } = {}) => [
  ...source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g),
  ...(includeDynamic ? source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g) : [])
].map(match => match[1]);

async function moduleClosure(entry, { includeEntryDynamic = false } = {}) {
  const entries = Array.isArray(entry) ? entry : [entry];
  const pending = entries.map((asset, index) => ({
    asset,
    includeDynamic: includeEntryDynamic && index === 0
  }));
  const assets = new Set();
  let bytes = 0;

  while (pending.length) {
    const candidate = pending.pop();
    const asset = normalizeAsset(candidate.asset);
    if (assets.has(asset)) continue;
    assets.add(asset);
    const source = await fs.readFile(publicFile(asset), "utf8");
    bytes += await fileBytes(asset);
    for (const specifier of moduleDependencies(source, { includeDynamic: candidate.includeDynamic })) {
      if (!specifier.startsWith(".")) continue;
      pending.push({
        asset: path.posix.join(path.posix.dirname(asset), specifier),
        includeDynamic: false
      });
    }
  }
  return { assets: [...assets].sort(), bytes };
}

const onboardingV2 = {
  schemaVersion: 2,
  session: {
    id: "web-budget-onboarding",
    schemaVersion: 2,
    status: "skipped",
    step: "firstAction",
    revision: 0,
    answers: {},
    collaboration: {
      responseLength: { value: "balanced", source: "system_default" },
      suggestionMode: { value: "actionFirst", source: "system_default" },
      challengeStyle: { value: "gentle", source: "system_default" },
      additionalBoundary: "",
      contextAllowed: true
    },
    startedAt: "",
    pausedAt: "",
    completedAt: "",
    updatedAt: ""
  },
  readiness: "empty",
  migration: {
    selectedFlow: "legacy",
    entryPolicy: "already_onboarded",
    legacy: {
      questionnaireVersion: 1,
      status: "completed",
      updatedAt: "",
      answerCount: 0,
      modelSummaryType: "",
      resourceType: "onboarding",
      resourceId: "onboarding"
    }
  }
};
const performanceThoughts = Array.from({ length: 12 }, (_, index) => {
  const rootId = `performance-thought-${index + 1}`;
  const minute = String(index).padStart(2, "0");
  const occurredAt = `2026-10-03T08:${minute}:00.000Z`;
  return [
    {
      id: rootId,
      version: 1,
      syncVersion: index + 1,
      type: "question",
      content: `固定性能样本 ${index + 1}：${"用于验证当前路由首批可读内容。".repeat(8)}`,
      tags: ["性能门"],
      annotations: [],
      followUps: [],
      occurredAt,
      occurredOn: "2026-10-03",
      createdAt: occurredAt,
      updatedAt: occurredAt
    },
    {
      id: `${rootId}-idea`,
      version: 1,
      syncVersion: index + 1,
      type: "idea",
      relatedTo: rootId,
      content: `固定样本想法 ${index + 1}`,
      authorType: "user",
      occurredAt,
      occurredOn: "2026-10-03",
      createdAt: occurredAt,
      updatedAt: occurredAt
    }
  ];
}).flat();
const clientState = {
  ...structuredClone(emptyClientState),
  captures: [{
    id: "hidden-media-capture",
    version: 1,
    content: "非当前路由媒体描述",
    occurredAt: "2026-10-03T07:00:00.000Z",
    createdAt: "2026-10-03T07:00:00.000Z",
    audio: {
      attachmentPath: "/attachments/performance-audio.m4a",
      mimeType: "audio/mp4",
      bytes: 16,
      durationMs: 1000
    }
  }],
  thoughts: performanceThoughts,
  onboarding: { ...structuredClone(emptyClientState.onboarding), status: "completed" },
  onboardingV2
};
const user = {
  id: "web-budget-user",
  username: "web-budget",
  role: "user",
  createdAt: "2026-10-03T00:00:00.000Z"
};
const preferences = {
  version: 1,
  assistantName: "神鸡",
  sceneEfforts: {},
  responseStyles: {},
  automaticAnswers: { thoughtAnswer: false },
  speech: { defaultVoice: "", generationRate: -10 }
};
const mime = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp"
};
const textAsset = file => /\.(?:css|html|js|mjs|svg|webmanifest)$/.test(file);
const v1 = data => ({ data, error: null, meta: { traceId: "web-budget-local" } });

async function createTestServer() {
  const encoded = new Map();
  const requests = [];
  const requestWaiters = new Set();
  let incrementalSync = false;
  let syncCursor = 0;
  let startupBarrier = null;
  let startupFailures = 0;
  const requestFailures = new Map();
  const notifyRequest = entry => {
    requests.push(entry);
    for (const waiter of requestWaiters) {
      if (entry.index <= waiter.afterIndex || !waiter.predicate(entry)) continue;
      clearTimeout(waiter.timer);
      requestWaiters.delete(waiter);
      waiter.resolve(entry);
    }
  };
  const responseBody = (request, body, contentType) => {
    const acceptsGzip = /\bgzip\b/.test(String(request.headers["accept-encoding"] || ""));
    const useGzip = acceptsGzip && /^application\/(?:json|problem\+json)|^text\//.test(contentType) && body.length >= 1024;
    if (!useGzip) return { output: body, contentEncoding: "" };
    const cacheKey = `${contentType}:${body.toString("base64")}`;
    if (!encoded.has(cacheKey)) encoded.set(cacheKey, gzipSync(body, { level: 6 }));
    return { output: encoded.get(cacheKey), contentEncoding: "gzip" };
  };
  const json = (request, response, value, { status = 200, cacheControl = "private, no-store" } = {}) => {
    const body = Buffer.from(JSON.stringify(value));
    const { output, contentEncoding } = responseBody(request, body, "application/json");
    response.writeHead(status, {
      "cache-control": cacheControl,
      "content-length": output.length,
      "content-type": "application/json; charset=utf-8",
      ...(contentEncoding ? { "content-encoding": contentEncoding, vary: "Accept-Encoding" } : {})
    });
    response.end(request.method === "HEAD" ? undefined : output);
    return {
      kind: "json",
      rawBytes: body.length,
      transferBytes: request.method === "HEAD" ? 0 : output.length,
      contentEncoding
    };
  };
  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const url = new URL(request.url, "http://127.0.0.1");
    const sample = String(request.headers["x-performance-sample"] || "");
    let result;
    try {
      const remainingFailures = requestFailures.get(url.pathname) || 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) requestFailures.delete(url.pathname);
        else requestFailures.set(url.pathname, remainingFailures - 1);
        result = json(request, response, {
          error: { code: "OPENING_TEST_FAILURE", message: `Opening integration failure: ${url.pathname}` }
        }, { status: 503 });
      } else if (url.pathname === "/api/auth/me") {
        result = json(request, response, { authenticated: true, authRequired: true, user, userCount: 1 });
      } else if (url.pathname === "/api/v1/startup") {
        if (startupBarrier) await startupBarrier.promise;
        if (startupFailures > 0) {
          startupFailures -= 1;
          result = json(request, response, {
            error: { code: "OPENING_TEST_FAILURE", message: "Opening integration startup failure" }
          }, { status: 503 });
        } else {
          result = json(request, response, v1({
            protocolVersion: 1,
            version: "web-budget",
            releaseVersion: "0.5.7",
            user,
            capabilities: ["local-testing"],
            features: { incrementalSync },
            governanceUrl: "",
            accountCursor: syncCursor,
            notificationUnread: 0,
            onboardingV2
          }));
        }
      } else if (url.pathname === "/api/v1/route-state") {
        result = json(request, response, v1(routeStateProjection(clientState, {
          view: url.searchParams.get("view") || "today",
          currentDate: "2026-10-03",
          resourceId: url.searchParams.get("resourceId") || "",
          query: Object.fromEntries(url.searchParams),
          cursorScope: user.id
        })));
      } else if (url.pathname === "/api/v1/sync") {
        const cursorValue = url.searchParams.get("cursor");
        const cursor = cursorValue == null ? null : Math.max(0, Number(cursorValue) || 0);
        const changed = cursor != null && cursor < syncCursor;
        result = json(request, response, v1({
          cursor: syncCursor,
          changes: changed ? [{ cursor: syncCursor, domains: ["thoughts"] }] : [],
          snapshot: changed ? { thoughts: structuredClone(clientState.thoughts) } : {}
        }));
      } else if (url.pathname === "/api/state") {
        result = json(request, response, clientState);
      } else if (url.pathname === "/api/meta") {
        result = json(request, response, { version: "web-budget", releaseVersion: "0.4.0", user, capabilities: ["local-testing"], features: {} });
      } else if (url.pathname === "/api/preferences") {
        result = json(request, response, preferences);
      } else if (url.pathname === "/api/v1/onboarding-v2/schema") {
        result = json(request, response, v1(onboardingV2Schema));
      } else if (url.pathname === "/api/v1/onboarding-v2/session") {
        result = json(request, response, v1(onboardingV2));
      } else if (["/api/v1/actions", "/api/v1/habits"].includes(url.pathname)) {
        result = json(request, response, v1([]));
      } else if (url.pathname === "/attachments/performance-audio.m4a" || url.pathname === "/api/speech/audio") {
        const body = Buffer.from("0123456789abcdef");
        response.writeHead(200, {
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "content-length": body.length,
          "content-type": "audio/mp4"
        });
        response.end(request.method === "HEAD" ? undefined : body);
        result = {
          kind: "media",
          rawBytes: body.length,
          transferBytes: request.method === "HEAD" ? 0 : body.length,
          contentEncoding: ""
        };
      } else if (url.pathname.startsWith("/api/")) {
        result = json(request, response, { error: "Not found", code: "NOT_FOUND" }, { status: 404 });
      } else {
        const relative = isApplicationRoutePath(url.pathname)
          ? "index.html"
          : url.pathname.replace(/^\/+/, "") || "index.html";
        const file = path.resolve(PUBLIC, relative);
        if (!file.startsWith(`${PUBLIC}${path.sep}`)) {
          result = json(request, response, { error: "Forbidden" }, { status: 403, cacheControl: "no-store" });
        } else {
          const body = await fs.readFile(file);
          const contentType = mime[path.extname(file).toLowerCase()] || "application/octet-stream";
          const { output, contentEncoding } = textAsset(file)
            ? responseBody(request, body, contentType)
            : { output: body, contentEncoding: "" };
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-length": output.length,
            "content-type": contentType,
            ...(contentEncoding ? { "content-encoding": contentEncoding, vary: "Accept-Encoding" } : {})
          });
          response.end(request.method === "HEAD" ? undefined : output);
          result = {
            kind: textAsset(file) ? "text" : "asset",
            rawBytes: body.length,
            transferBytes: request.method === "HEAD" ? 0 : output.length,
            contentEncoding
          };
        }
      }
    } catch (error) {
      result = json(request, response, { error: "Not found" }, { status: error.code === "ENOENT" ? 404 : 500, cacheControl: "no-store" });
    } finally {
      notifyRequest({
        index: requests.length,
        sample,
        method: request.method,
        path: url.pathname,
        search: url.search,
        kind: result?.kind || "unknown",
        contentEncoding: result?.contentEncoding || "",
        rawBytes: result?.rawBytes || 0,
        transferBytes: result?.transferBytes || 0,
        status: response.statusCode,
        durationMs: Number((performance.now() - startedAt).toFixed(1))
      });
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    holdStartup() {
      if (startupBarrier) throw new Error("Startup is already held");
      let release;
      const promise = new Promise(resolve => {
        release = resolve;
      });
      startupBarrier = { promise, release };
    },
    releaseStartup() {
      const barrier = startupBarrier;
      startupBarrier = null;
      barrier?.release();
    },
    failNextStartup(count = 1) {
      startupFailures += Math.max(1, Number.parseInt(count, 10) || 1);
    },
    failNextRequest(pathname, count = 1) {
      const failures = Math.max(1, Number.parseInt(count, 10) || 1);
      requestFailures.set(pathname, (requestFailures.get(pathname) || 0) + failures);
    },
    setIncrementalSync(value) {
      incrementalSync = Boolean(value);
    },
    publishSecondDeviceThought(index) {
      const id = `second-device-thought-${index}`;
      const timestamp = `2026-10-03T09:${String(index).padStart(2, "0")}:00.000Z`;
      clientState.thoughts = [
        {
          id,
          version: 1,
          syncVersion: syncCursor + 1,
          type: "question",
          content: `第二设备同步样本 ${index}`,
          tags: ["跨设备"],
          annotations: [],
          followUps: [],
          occurredAt: timestamp,
          occurredOn: "2026-10-03",
          createdAt: timestamp,
          updatedAt: timestamp
        },
        ...clientState.thoughts
      ];
      syncCursor += 1;
      return { id, cursor: syncCursor };
    },
    waitForRequest(predicate, { afterIndex = -1, timeoutMs = 5000 } = {}) {
      const existing = requests.find(entry => entry.index > afterIndex && predicate(entry));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          afterIndex,
          predicate,
          resolve,
          timer: setTimeout(() => {
            requestWaiters.delete(waiter);
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for HTTP request`));
          }, timeoutMs)
        };
        requestWaiters.add(waiter);
      });
    },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function pageDebuggerUrl(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(item => item.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(50);
  }
  throw new Error("等待首屏预算浏览器超时");
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.onEvent(message => {
        if (message.method !== method || !predicate(message.params || {})) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message.params || {});
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP event ${method}`));
      }, timeoutMs);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function createBrowserGate(baseUrl) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-performance-gate-"));
  const debugPort = await freePort();
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${dataDir}`,
    "about:blank"
  ], { stdio: "ignore" });
  try {
    const cdp = new Cdp(await pageDebuggerUrl(debugPort));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: NETWORK_PROFILE.latency,
      downloadThroughput: NETWORK_PROFILE.downloadThroughput,
      uploadThroughput: NETWORK_PROFILE.uploadThroughput,
      connectionType: NETWORK_PROFILE.connectionType
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          const trace = { states: [], animations: [], paints: [] };
          window.__openingTrace = trace;
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                trace.paints.push({
                  name: entry.name,
                  startTime: Number(entry.startTime.toFixed(1))
                });
              }
            }).observe({ type: "paint", buffered: true });
          } catch {}
          const nativeSetAttribute = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function(name, value) {
            const result = nativeSetAttribute.call(this, name, value);
            if (this.id === "opening-screen" && name === "data-opening-state") {
              trace.states.push({ state: String(value), at: Number(performance.now().toFixed(1)) });
            }
            return result;
          };
          const nativeAnimate = Element.prototype.animate;
          Element.prototype.animate = function(frames, options) {
            if (this.id === "opening-screen") {
              trace.animations.push({
                at: Number(performance.now().toFixed(1)),
                duration: Number(typeof options === "number" ? options : options?.duration) || 0
              });
            }
            return nativeAnimate.call(this, frames, options);
          };
        })();
        delete Navigator.prototype.serviceWorker;
      `
    });
    const evaluate = async expression => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    return {
      cdp,
      evaluate,
      async setSample(sample) {
        await cdp.send("Network.setExtraHTTPHeaders", {
          headers: sample ? { "x-performance-sample": sample } : {}
        });
      },
      async navigate(url) {
        const domReady = cdp.waitForEvent("Page.domContentEventFired", () => true, 10000);
        await cdp.send("Page.navigate", { url });
        await domReady;
      },
      async waitForCondition({ condition, action = "", label, timeoutMs = 8000 }) {
        return evaluate(`new Promise((resolve, reject) => {
          const startedAt = performance.now();
          const condition = () => (${condition});
          let settled = false;
          const observer = new MutationObserver(check);
          const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            observer.disconnect();
            removeEventListener("popstate", check);
            requestAnimationFrame(() => resolve({
              durationMs: Number((performance.now() - startedAt).toFixed(1)),
              value
            }));
          };
          function check() {
            try {
              const value = condition();
              if (value) finish(value);
            } catch (error) {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              observer.disconnect();
              reject(error);
            }
          }
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            removeEventListener("popstate", check);
            reject(new Error(${JSON.stringify(label)} + " timed out; state=" + JSON.stringify({
              path: location.pathname,
              activeView: document.querySelector(".view.active")?.id || "",
              busy: document.querySelector(".view.active")?.getAttribute("aria-busy") || "",
              thoughtCards: document.querySelectorAll("#all-thoughts [data-chain-id]").length,
              startupMetric: document.querySelector("#startup-performance-metric")?.textContent || ""
            })));
          }, ${timeoutMs});
          observer.observe(document.documentElement, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true
          });
          addEventListener("popstate", check);
          ${action}
          check();
        })`);
      },
      async close() {
        cdp.socket.close();
        if (chrome.exitCode == null) chrome.kill("SIGKILL");
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (chrome.exitCode == null) chrome.kill("SIGKILL");
    await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

const sum = values => values.reduce((total, value) => total + value, 0);
const nearestRank = (values, fraction) => {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const distribution = (values, unit, budget = null) => ({
  unit,
  samples: values.length,
  min: Math.min(...values),
  max: Math.max(...values),
  p75: nearestRank(values, 0.75),
  p95: nearestRank(values, 0.95),
  ...(budget ? { budget } : {})
});
const mediaPath = value => (
  value.startsWith("/attachments/")
  || value === "/api/speech/audio"
  || /\.(?:m4a|mp3|mp4|ogg|wav|webm)(?:$|\?)/i.test(value)
);
const uiPreferencePath = value => value === "/api/preferences" || /(?:^|\/)ui-preferences(?:\/|$)/.test(value);
const timingIsNotBefore = (candidateMs, boundaryMs) => (
  Number.isFinite(candidateMs)
  && Number.isFinite(boundaryMs)
  && candidateMs + OPENING_TIMING_BOUNDARY_TOLERANCE_MS >= boundaryMs
);

function sampleEvidence(server, sample) {
  const requests = server.requests.filter(item => item.sample === sample && !["HEAD", "OPTIONS"].includes(item.method));
  const startup = requests.find(item => item.path === "/api/v1/startup");
  const route = requests.find(item => item.path === "/api/v1/route-state");
  const json = [startup, route].filter(Boolean);
  return {
    sample,
    requestCount: requests.length,
    apiRequestCount: requests.filter(item => item.path.startsWith("/api/")).length,
    transferBytes: sum(requests.map(item => item.transferBytes)),
    initialJsonDecodedBytes: sum(json.map(item => item.rawBytes)),
    initialJsonTransferBytes: sum(json.map(item => item.transferBytes)),
    startupJsonDecodedBytes: startup?.rawBytes || 0,
    routeJsonDecodedBytes: route?.rawBytes || 0,
    mediaBeforeClickTransferBytes: sum(requests.filter(item => mediaPath(item.path)).map(item => item.transferBytes)),
    routeJsonContentEncoding: route?.contentEncoding || "",
    uiPreferenceRequestCount: requests.filter(item => uiPreferencePath(item.path)).length,
    requestPaths: requests.map(item => item.path)
  };
}

async function startupSample(browser, server, sample, { cacheDisabled, clearCache = false } = {}) {
  await browser.setSample(sample);
  await browser.cdp.send("Network.setCacheDisabled", { cacheDisabled });
  if (clearCache) await browser.cdp.send("Network.clearBrowserCache");
  await browser.navigate(`${server.baseUrl}/today?native-performance=1`);
  await browser.waitForCondition({
    label: `${sample} stableHome`,
    condition: `document.querySelector("#startup-performance-metric")?.textContent.startsWith("启动分段 ")`
  });
  const browserEvidence = await browser.evaluate(`(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const firstContentfulPaint = window.__openingTrace.paints
      .find(entry => entry.name === "first-contentful-paint");
    const openingComplete = performance.getEntriesByName("openingExitComplete").at(-1);
    const openingPainted = performance.getEntriesByName("openingExitPainted").at(-1);
    const text = document.querySelector("#startup-performance-metric").textContent.replace(/^启动分段 /, "");
    const startup = JSON.parse(text);
    return {
      dclMs: Number(navigation.domContentLoadedEventEnd.toFixed(1)),
      currentScreenFeedbackMs: Number(firstContentfulPaint?.startTime),
      openingCompleteMs: Number(openingComplete?.startTime.toFixed(1)),
      openingPaintedMs: Number(openingPainted?.startTime.toFixed(1)),
      firstReadableMs: Number(openingPainted?.startTime.toFixed(1)),
      stableHomeMs: Number(startup.marks.stableHome),
      visibleShellMs: Number(startup.marks.visibleShell),
      domNodes: document.getElementsByTagName("*").length,
      openingHidden: document.querySelector("#opening-screen")?.hidden === true,
      contentReleased: !document.querySelector("main")?.inert,
      routeReadable: Boolean(document.querySelector(".view.active h1")?.textContent.trim())
    };
  })()`);
  return { ...browserEvidence, ...sampleEvidence(server, sample) };
}

function startupContractFailures(result) {
  const failures = [];
  const fail = (condition, detail) => {
    if (!condition) failures.push(`${result.sample}: ${detail}`);
  };
  fail(Number.isFinite(result.currentScreenFeedbackMs), "first-contentful-paint is missing");
  fail(Number.isFinite(result.openingCompleteMs), "opening completion mark is missing");
  fail(Number.isFinite(result.openingPaintedMs), "opening post-paint mark is missing");
  fail(Number.isFinite(result.firstReadableMs), "first-readable mark is missing");
  fail(Number.isFinite(result.stableHomeMs), "stableHome mark is missing");
  fail(result.stableHomeMs >= result.openingPaintedMs, "stableHome was recorded before opening exit was painted");
  fail(result.openingHidden && result.contentReleased && result.routeReadable, "first-readable state is still covered or inert");
  fail(
    result.startupJsonDecodedBytes <= HTTP_BUDGET.startupJsonDecodedBytes,
    `startup JSON ${result.startupJsonDecodedBytes} B > ${HTTP_BUDGET.startupJsonDecodedBytes} B`
  );
  fail(
    result.initialJsonTransferBytes <= HTTP_BUDGET.initialJsonTransferBytes,
    `startup + current-route compressed JSON ${result.initialJsonTransferBytes} B > ${HTTP_BUDGET.initialJsonTransferBytes} B`
  );
  fail(
    result.requestCount <= HTTP_BUDGET.firstReadableRequests,
    `first-readable requests ${result.requestCount} > ${HTTP_BUDGET.firstReadableRequests}`
  );
  fail(
    result.apiRequestCount <= HTTP_BUDGET.firstReadableApiRequests,
    `first-readable API requests ${result.apiRequestCount} > ${HTTP_BUDGET.firstReadableApiRequests}`
  );
  fail(
    result.mediaBeforeClickTransferBytes === HTTP_BUDGET.mediaBeforeClickTransferBytes,
    `media before click ${result.mediaBeforeClickTransferBytes} B, expected 0 B`
  );
  fail(result.routeJsonContentEncoding === "gzip", "current-route JSON is not gzip encoded");
  fail(!result.requestPaths.includes("/api/state"), "startup requested forbidden /api/state");
  for (const path of HIDDEN_FEATURE_MODULE_PATHS) {
    fail(
      !result.requestPaths.includes(path),
      `startup requested hidden feature module ${path}`
    );
  }
  for (const endpoint of ["/api/auth/me", "/api/v1/startup", "/api/v1/route-state", "/api/local-test-mode"]) {
    const count = result.requestPaths.filter(value => value === endpoint).length;
    fail(count === 1, `${endpoint} request count ${count}, expected 1`);
  }
  const onboardingSessionCount = result.requestPaths
    .filter(value => value === "/api/v1/onboarding-v2/session").length;
  fail(onboardingSessionCount === 0, `/api/v1/onboarding-v2/session request count ${onboardingSessionCount}, expected 0`);
  fail(
    result.uiPreferenceRequestCount <= OPENING_BUDGET.uiPreferenceRequests,
    `UI preference request count ${result.uiPreferenceRequestCount} > ${OPENING_BUDGET.uiPreferenceRequests}`
  );
  return failures;
}

async function browserDiagnostics(browser, server, error) {
  let page = {};
  try {
    page = await browser.evaluate(`({
      path: location.pathname,
      activeView: document.querySelector(".view.active")?.id || "",
      busy: document.querySelector(".view.active")?.getAttribute("aria-busy") || "",
      thoughtCards: document.querySelectorAll("#all-thoughts [data-chain-id]").length,
      metric: document.querySelector("#startup-performance-metric")?.textContent || ""
    })`);
  } catch {}
  return new Error(`${error.message}; diagnostics=${JSON.stringify({
    page,
    recentRequests: server.requests.slice(-12).map(item => ({
      sample: item.sample,
      method: item.method,
      path: item.path,
      statusKind: item.kind,
      transferBytes: item.transferBytes,
      durationMs: item.durationMs
    }))
  })}`);
}

const gateStartedAt = performance.now();
const html = await fs.readFile(publicFile("index.html"), "utf8");
const styles = await blockingStyleClosure(html);
const modulePreloads = [...html.matchAll(/<link\b[^>]*>/gi)]
  .map(match => match[0])
  .filter(tag => attribute(tag, "rel").split(/\s+/).includes("modulepreload"))
  .map(tag => attribute(tag, "href"))
  .filter(Boolean);
const modules = await moduleClosure(["app.js", ...modulePreloads], { includeEntryDynamic: true });
const deferredRuntime = await moduleClosure("frontend/app/runtime.mjs");
const defaultRouteModules = await moduleClosure([
  "frontend/app/ports.mjs",
  "frontend/features/legacy-pages/index.mjs"
]);
const lazyFeatureModules = Object.fromEntries(await Promise.all([
  ["actions-workspace", "frontend/features/actions/controller.mjs"],
  ["export", "frontend/features/export/index.mjs"],
  ["feedback", "frontend/features/feedback/index.mjs"],
  ["notifications", "frontend/features/notifications/index.mjs"],
  ["discovery", "frontend/features/thought-discovery/index.mjs"]
].map(async ([view, entry]) => [view, await moduleClosure(entry)])));
const openingCriticalStyleIndex = html.indexOf('<style id="opening-critical-style">');
const applicationStyleLoadIndex = html.indexOf("const loadApplicationStyles");
const openingShellIndex = html.indexOf('id="opening-screen"');
const authGateIndex = html.indexOf('id="auth-gate"');
const openingShellTag = html.match(/<div\b[^>]*\bid="opening-screen"[^>]*>/i)?.[0] || "";

assert.ok(openingCriticalStyleIndex >= 0, "opening critical CSS must be inline");
assert.ok(
  openingCriticalStyleIndex < applicationStyleLoadIndex,
  "opening critical CSS must precede application style loading"
);
assert.ok(openingShellIndex >= 0, "opening shell must be parser-visible HTML");
assert.ok(openingShellIndex < authGateIndex, "opening shell must precede application DOM");
assert.match(openingShellTag, /\baria-busy="true"/);
assert.doesNotMatch(openingShellTag, /\bhidden\b/);
for (const asset of [
  "frontend/app/bootstrap.mjs",
  "frontend/opening/index.mjs",
  "frontend/opening/controller.mjs",
  "frontend/opening/rain-engine.mjs"
]) {
  assert.ok(modules.assets.includes(asset), `entry module budget must include ${asset}`);
}

assert.ok(
  styles.assets.length <= ASSET_BUDGET.blockingStyleRequests,
  `首屏阻塞样式请求 ${styles.assets.length} 超过预算 ${ASSET_BUDGET.blockingStyleRequests}: ${styles.assets.join(", ")}`
);
assert.ok(
  styles.bytes <= ASSET_BUDGET.blockingStyleBytes,
  `首屏阻塞样式 ${styles.bytes} B 超过预算 ${ASSET_BUDGET.blockingStyleBytes} B`
);
assert.ok(
  modules.assets.length <= ASSET_BUDGET.entryModuleCount,
  `入口模块闭包 ${modules.assets.length} 个超过预算 ${ASSET_BUDGET.entryModuleCount}`
);
assert.ok(
  modules.bytes <= ASSET_BUDGET.entryModuleBytes,
  `入口模块闭包 ${modules.bytes} B 超过预算 ${ASSET_BUDGET.entryModuleBytes} B`
);
assert.ok(
  deferredRuntime.assets.length <= ASSET_BUDGET.deferredRuntimeModuleCount,
  `延迟 runtime 闭包 ${deferredRuntime.assets.length} 个超过预算 ${ASSET_BUDGET.deferredRuntimeModuleCount}`
);
assert.ok(
  deferredRuntime.bytes <= ASSET_BUDGET.deferredRuntimeModuleBytes,
  `延迟 runtime 闭包 ${deferredRuntime.bytes} B 超过预算 ${ASSET_BUDGET.deferredRuntimeModuleBytes} B`
);
assert.ok(
  defaultRouteModules.assets.length <= ASSET_BUDGET.defaultRouteModuleCount,
  `默认路由增量闭包 ${defaultRouteModules.assets.length} 个超过预算 ${ASSET_BUDGET.defaultRouteModuleCount}`
);
assert.ok(
  defaultRouteModules.bytes <= ASSET_BUDGET.defaultRouteModuleBytes,
  `默认路由增量闭包 ${defaultRouteModules.bytes} B 超过预算 ${ASSET_BUDGET.defaultRouteModuleBytes} B`
);
for (const [view, closure] of Object.entries(lazyFeatureModules)) {
  assert.ok(
    closure.assets.length <= ASSET_BUDGET.lazyFeatureModuleCount,
    `${view} lazy 闭包 ${closure.assets.length} 个超过预算 ${ASSET_BUDGET.lazyFeatureModuleCount}`
  );
  assert.ok(
    closure.bytes <= ASSET_BUDGET.lazyFeatureModuleBytes,
    `${view} lazy 闭包 ${closure.bytes} B 超过预算 ${ASSET_BUDGET.lazyFeatureModuleBytes} B`
  );
  assert.equal(
    closure.assets.some(asset => deferredRuntime.assets.includes(asset)),
    false,
    `${view} lazy 闭包进入了 shell 静态闭包`
  );
}

const testServer = await createTestServer();
let browser;
try {
  const compressedHtml = await fetch(`${testServer.baseUrl}/`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedHtml.headers.get("content-encoding"), "gzip");
  assert.equal(compressedHtml.headers.get("cache-control"), "no-store");
  assert.match(compressedHtml.headers.get("vary") || "", /Accept-Encoding/i);
  const compressedRuntime = await fetch(`${testServer.baseUrl}/frontend/app/runtime.mjs`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedRuntime.headers.get("content-encoding"), "gzip");
  assert.equal(compressedRuntime.headers.get("cache-control"), "no-store");
  const compressedRoute = await fetch(`${testServer.baseUrl}/api/v1/route-state?view=today`, {
    headers: { "accept-encoding": "gzip" }
  });
  assert.equal(compressedRoute.headers.get("content-encoding"), "gzip");
  assert.equal(compressedRoute.headers.get("cache-control"), "private, no-store");
  assert.match(compressedRoute.headers.get("vary") || "", /Accept-Encoding/i);
  const identityRoute = await fetch(`${testServer.baseUrl}/api/v1/route-state?view=today`, {
    headers: { "accept-encoding": "identity" }
  });
  assert.equal(identityRoute.headers.get("content-encoding"), null);
  assert.equal(Number(identityRoute.headers.get("content-length")), (await identityRoute.arrayBuffer()).byteLength);
  const mediaHead = await fetch(`${testServer.baseUrl}/attachments/performance-audio.m4a`, {
    method: "HEAD",
    headers: { "accept-encoding": "gzip" }
  });
  assert.equal(mediaHead.headers.get("content-encoding"), null);
  assert.equal((await mediaHead.arrayBuffer()).byteLength, 0);

  browser = await createBrowserGate(testServer.baseUrl);
  const deepLinkSample = "opening-held-deep-link";
  await browser.setSample(deepLinkSample);
  await browser.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await browser.cdp.send("Network.clearBrowserCache");
  testServer.holdStartup();
  let heldOpening;
  try {
    await browser.navigate(`${testServer.baseUrl}/thoughts/performance-thought-1`);
    await browser.waitForCondition({
      label: "opening first contentful paint",
      timeoutMs: 2000,
      condition: `window.__openingTrace.paints.some(entry => entry.name === "first-contentful-paint")
        && Boolean(document.documentElement.dataset.openingVisible)`
        + ` && performance.getEntriesByName(new URL("app.js", document.baseURI).href, "resource").length > 0`
    });
    heldOpening = await browser.evaluate(`(() => {
      const root = document.querySelector("#opening-screen");
      const firstContentfulPaint = window.__openingTrace.paints
        .find(entry => entry.name === "first-contentful-paint");
      const appEntry = performance.getEntriesByName(
        new URL("app.js", document.baseURI).href,
        "resource"
      ).at(-1);
      return {
        parsedMs: Number(document.documentElement.dataset.openingParsed),
        markerVisibleMs: Number(document.documentElement.dataset.openingVisible),
        firstContentfulPaintMs: Number(firstContentfulPaint?.startTime),
        appEntryStartMs: Number(appEntry?.startTime),
        appEntryResponseEndMs: Number(appEntry?.responseEnd),
        appEntryInitiatorType: appEntry?.initiatorType || "",
        paintEntries: window.__openingTrace.paints,
        firstBodyElement: document.body.firstElementChild?.id || "",
        state: root?.dataset.openingState || "",
        hidden: Boolean(root?.hidden),
        busy: root?.getAttribute("aria-busy") || "",
        mainInert: Boolean(document.querySelector("main")?.inert),
        sidebarInert: Boolean(document.querySelector(".sidebar")?.inert),
        authGateInert: Boolean(document.querySelector("#auth-gate")?.inert),
        path: location.pathname
      };
    })()`);
  } finally {
    testServer.releaseStartup();
  }
  assert.ok(
    Number.isFinite(heldOpening.firstContentfulPaintMs),
    `opening first-contentful-paint missing: ${JSON.stringify(heldOpening.paintEntries)}`
  );
  assert.ok(heldOpening.parsedMs <= heldOpening.firstContentfulPaintMs);
  assert.equal(heldOpening.appEntryInitiatorType, "script");
  assert.ok(
    timingIsNotBefore(heldOpening.appEntryStartMs, heldOpening.firstContentfulPaintMs),
    `app.js started at ${heldOpening.appEntryStartMs}ms before FCP ${heldOpening.firstContentfulPaintMs}ms`
  );
  assert.ok(
    timingIsNotBefore(heldOpening.appEntryResponseEndMs, heldOpening.firstContentfulPaintMs),
    `app.js loaded at ${heldOpening.appEntryResponseEndMs}ms before FCP ${heldOpening.firstContentfulPaintMs}ms`
  );
  assert.ok(heldOpening.appEntryResponseEndMs >= heldOpening.appEntryStartMs);
  assert.deepEqual(
    {
      firstBodyElement: heldOpening.firstBodyElement,
      state: heldOpening.state,
      hidden: heldOpening.hidden,
      busy: heldOpening.busy,
      mainInert: heldOpening.mainInert,
      sidebarInert: heldOpening.sidebarInert,
      authGateInert: heldOpening.authGateInert,
      path: heldOpening.path
    },
    {
      firstBodyElement: "opening-screen",
      state: "opening",
      hidden: false,
      busy: "true",
      mainInert: true,
      sidebarInert: true,
      authGateInert: true,
      path: "/thoughts/performance-thought-1"
    }
  );
  await browser.waitForCondition({
    label: "opening deep-link completion",
    condition: `document.querySelector("#opening-screen")?.dataset.openingState === "complete"
      && document.querySelector("#opening-screen").hidden
      && performance.getEntriesByName("openingExitPainted").length > 0
      && location.pathname === "/thoughts/performance-thought-1"
      && document.querySelector('#all-thoughts [data-chain-id="performance-thought-1"]')?.open`
  });
  const deepLinkOpening = await browser.evaluate(`(() => {
    const trace = window.__openingTrace;
    const entering = trace.states.find(entry => entry.state === "entering");
    const complete = trace.states.find(entry => entry.state === "complete");
    const ready = performance.getEntriesByName("openingReady").at(-1);
    const painted = performance.getEntriesByName("openingExitPainted").at(-1);
    return {
      states: trace.states.map(entry => entry.state),
      animationDurationMs: trace.animations[0]?.duration ?? 0,
      readyToCompleteMs: entering && complete ? Number((complete.at - entering.at).toFixed(1)) : null,
      readyToPaintedMs: ready && painted ? Number((painted.startTime - ready.startTime).toFixed(1)) : null,
      rootHidden: document.querySelector("#opening-screen").hidden,
      contentReleased: [
        document.querySelector("main"),
        document.querySelector(".sidebar"),
        document.querySelector("#auth-gate")
      ].every(node => !node.inert),
      activeView: document.querySelector(".view.active")?.id || "",
      path: location.pathname
    };
  })()`);
  assert.deepEqual(deepLinkOpening.states.slice(-3), ["opening", "entering", "complete"]);
  assert.ok(deepLinkOpening.animationDurationMs <= OPENING_BUDGET.readyToPaintedMs);
  assert.ok(Number.isFinite(deepLinkOpening.readyToPaintedMs), "opening ready-to-painted timing is missing");
  assert.ok(
    deepLinkOpening.readyToPaintedMs <= OPENING_BUDGET.readyToPaintedMs,
    `opening ready-to-painted ${deepLinkOpening.readyToPaintedMs}ms > ${OPENING_BUDGET.readyToPaintedMs}ms`
  );
  assert.deepEqual(
    {
      rootHidden: deepLinkOpening.rootHidden,
      contentReleased: deepLinkOpening.contentReleased,
      activeView: deepLinkOpening.activeView,
      path: deepLinkOpening.path
    },
    {
      rootHidden: true,
      contentReleased: true,
      activeView: "view-thoughts",
      path: "/thoughts/performance-thought-1"
    }
  );
  assert.ok(
    sampleEvidence(testServer, deepLinkSample).uiPreferenceRequestCount <= OPENING_BUDGET.uiPreferenceRequests
  );

  const secondaryFailureSample = "opening-secondary-failure-preferences";
  testServer.failNextRequest("/api/preferences");
  await browser.setSample(secondaryFailureSample);
  await browser.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await browser.cdp.send("Network.clearBrowserCache");
  await browser.navigate(`${testServer.baseUrl}/today`);
  await browser.waitForCondition({
    label: "opening secondary request failure",
    condition: `document.querySelector("#opening-screen")?.dataset.openingState === "failure"
      && !document.querySelector("#opening-recovery").hidden`
  });
  await sleep(150);
  const secondaryFailureOpening = await browser.evaluate(`(() => {
    const root = document.querySelector("#opening-screen");
    return {
      states: window.__openingTrace.states.map(entry => entry.state),
      readyMarkCount: performance.getEntriesByName("openingReady").length,
      state: root?.dataset.openingState || "",
      hidden: Boolean(root?.hidden),
      busy: root?.getAttribute("aria-busy") || "",
      recoveryHidden: Boolean(document.querySelector("#opening-recovery")?.hidden),
      retryFocused: document.activeElement === document.querySelector("#opening-retry"),
      contentInert: [...document.body.children]
        .filter(element => element !== root)
        .every(element => element.inert)
    };
  })()`);
  assert.deepEqual(secondaryFailureOpening.states, ["opening", "failure"]);
  assert.equal(secondaryFailureOpening.readyMarkCount, 0);
  assert.deepEqual(
    {
      state: secondaryFailureOpening.state,
      hidden: secondaryFailureOpening.hidden,
      busy: secondaryFailureOpening.busy,
      recoveryHidden: secondaryFailureOpening.recoveryHidden,
      retryFocused: secondaryFailureOpening.retryFocused,
      contentInert: secondaryFailureOpening.contentInert
    },
    {
      state: "failure",
      hidden: false,
      busy: "",
      recoveryHidden: false,
      retryFocused: true,
      contentInert: true
    }
  );
  const secondaryFailureRequests = testServer.requests.filter(item => (
    item.sample === secondaryFailureSample
    && item.path === "/api/preferences"
  ));
  assert.equal(secondaryFailureRequests.length, 1);
  assert.equal(secondaryFailureRequests[0].status, 503);

  const watchdogFailureSample = "opening-startup-watchdog";
  await browser.setSample(watchdogFailureSample);
  await browser.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await browser.cdp.send("Network.clearBrowserCache");
  testServer.holdStartup();
  try {
    await browser.navigate(`${testServer.baseUrl}/today`);
    await browser.waitForCondition({
      label: "opening startup watchdog failure",
      timeoutMs: 7000,
      condition: `document.querySelector("#opening-screen")?.dataset.openingState === "failure"
        && !document.querySelector("#opening-recovery").hidden`
    });
  } finally {
    testServer.releaseStartup();
  }
  await browser.waitForCondition({
    label: "late runtime completion after opening watchdog",
    timeoutMs: 3000,
    condition: `document.documentElement.dataset.runtimeReady === "1"`
  });
  await sleep(150);
  const watchdogFailureOpening = await browser.evaluate(`(() => {
    const root = document.querySelector("#opening-screen");
    return {
      states: window.__openingTrace.states.map(entry => entry.state),
      readyMarkCount: performance.getEntriesByName("openingReady").length,
      state: root?.dataset.openingState || "",
      hidden: Boolean(root?.hidden),
      recoveryHidden: Boolean(document.querySelector("#opening-recovery")?.hidden),
      contentInert: [...document.body.children]
        .filter(element => element !== root)
        .every(element => element.inert),
      runtimeReady: document.documentElement.dataset.runtimeReady || ""
    };
  })()`);
  assert.equal(watchdogFailureOpening.states.includes("entering"), false);
  assert.equal(watchdogFailureOpening.states.includes("complete"), false);
  assert.equal(watchdogFailureOpening.readyMarkCount, 0);
  assert.deepEqual(
    {
      state: watchdogFailureOpening.state,
      hidden: watchdogFailureOpening.hidden,
      recoveryHidden: watchdogFailureOpening.recoveryHidden,
      contentInert: watchdogFailureOpening.contentInert,
      runtimeReady: watchdogFailureOpening.runtimeReady
    },
    {
      state: "failure",
      hidden: false,
      recoveryHidden: false,
      contentInert: true,
      runtimeReady: "1"
    }
  );

  const retrySample = "opening-retry";
  testServer.failNextStartup();
  await browser.setSample(retrySample);
  await browser.navigate(`${testServer.baseUrl}/seen/captures`);
  await browser.waitForCondition({
    label: "opening failure recovery",
    condition: `document.querySelector("#opening-screen")?.dataset.openingState === "failure"
      && !document.querySelector("#opening-recovery").hidden`
  });
  assert.deepEqual(
    await browser.evaluate(`(() => ({
      path: location.pathname,
      mainInert: document.querySelector("main").inert,
      retryFocused: document.activeElement === document.querySelector("#opening-retry"),
      retryDisabled: document.querySelector("#opening-retry").disabled
    }))()`),
    { path: "/seen/captures", mainInert: true, retryFocused: true, retryDisabled: false }
  );
  const retryNavigation = browser.cdp.waitForEvent("Page.domContentEventFired", () => true, 10000);
  await browser.evaluate(`document.querySelector("#opening-retry").click(); true`);
  await retryNavigation;
  await browser.waitForCondition({
    label: "opening retry completion",
    condition: `document.querySelector("#opening-screen")?.dataset.openingState === "complete"
      && document.querySelector("#opening-screen").hidden
      && location.pathname === "/seen/captures"
      && document.querySelector("#view-captures").classList.contains("active")`
  });
  assert.ok(
    sampleEvidence(testServer, retrySample).uiPreferenceRequestCount <= OPENING_BUDGET.uiPreferenceRequests
  );

  const reducedMotionSample = "opening-reduced-motion";
  await browser.cdp.send("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await browser.setSample(reducedMotionSample);
  await browser.navigate(`${testServer.baseUrl}/today?native-performance=1`);
  await browser.waitForCondition({
    label: "opening reduced-motion completion",
    condition: `document.querySelector("#opening-screen")?.dataset.openingState === "complete"
      && document.querySelector("#opening-screen").hidden
      && document.querySelector("#startup-performance-metric")?.textContent.startsWith("启动分段 ")`
  });
  const reducedMotionOpening = await browser.evaluate(`(() => {
    const trace = window.__openingTrace;
    const entering = trace.states.find(entry => entry.state === "entering");
    const complete = trace.states.find(entry => entry.state === "complete");
    const transitionElapsedMs = entering && complete
      ? Number((complete.at - entering.at).toFixed(1))
      : null;
    return {
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationCount: trace.animations.length,
      readyToCompleteMs: trace.animations.length ? transitionElapsedMs : 0,
      brandAnimation: getComputedStyle(document.querySelector(".opening-brand")).animationName,
      contentReleased: [
        document.querySelector("main"),
        document.querySelector(".sidebar"),
        document.querySelector("#auth-gate")
      ].every(node => !node.inert)
    };
  })()`);
  assert.deepEqual(reducedMotionOpening, {
    reduced: true,
    animationCount: 0,
    readyToCompleteMs: 0,
    brandAnimation: "none",
    contentReleased: true
  });
  assert.ok(
    sampleEvidence(testServer, reducedMotionSample).uiPreferenceRequestCount <= OPENING_BUDGET.uiPreferenceRequests
  );
  await browser.cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] });

  const cold = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    cold.push(await startupSample(browser, testServer, `startup-cold-${index}`, {
      cacheDisabled: true,
      clearCache: true
    }));
  }

  await startupSample(browser, testServer, "startup-warm-prime", { cacheDisabled: false });
  const warm = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    warm.push(await startupSample(browser, testServer, `startup-warm-${index}`, { cacheDisabled: false }));
  }

  testServer.setIncrementalSync(true);
  const syncRequestIndex = testServer.requests.length - 1;
  await startupSample(browser, testServer, "interaction-startup", { cacheDisabled: false });
  await testServer.waitForRequest(item => item.path === "/api/v1/sync", { afterIndex: syncRequestIndex });

  const routeSwitchMs = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    await browser.setSample(`route-setup-${index}`);
    await browser.waitForCondition({
      label: `route setup ${index}`,
      action: `document.querySelector('.nav-button[data-view="today"]').click();`,
      condition: `location.pathname === "/today"
        && document.querySelector("#view-today").classList.contains("active")
        && !document.querySelector("#view-today").hasAttribute("aria-busy")
        && document.querySelector("#home-memory-grid").children.length > 0`
    });
    await browser.setSample(`route-switch-${index}`);
    const measured = await browser.waitForCondition({
      label: `route switch ${index}`,
      action: `document.querySelector('.nav-button[data-view="thoughts"]').click();`,
      condition: `location.pathname === "/thoughts"
        && document.querySelector("#view-thoughts").classList.contains("active")
        && !document.querySelector("#view-thoughts").hasAttribute("aria-busy")
        && document.querySelectorAll("#all-thoughts [data-chain-id]").length >= 12`
    });
    routeSwitchMs.push(measured.durationMs);
  }

  const detailOpenMs = [];
  const detailReturnMs = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    await browser.setSample(`detail-open-${index}`);
    const opened = await browser.waitForCondition({
      label: `thought detail open ${index}`,
      action: `document.querySelector("#all-thoughts .chain-summary").click();`,
      condition: `location.pathname.startsWith("/thoughts/performance-thought-")
        && document.querySelectorAll("#all-thoughts [data-chain-id]").length === 1
        && document.querySelector("#all-thoughts .thought-detail-record[data-chain-id]")?.open
        && document.querySelectorAll("#all-thoughts [data-thought-block-id]").length >= 1
        && !document.querySelector("#view-thoughts").hasAttribute("aria-busy")`
    });
    detailOpenMs.push(opened.durationMs);
    await browser.setSample(`detail-return-${index}`);
    const measured = await browser.waitForCondition({
      label: `thought detail return ${index}`,
      action: `document.querySelector("[data-thought-list]").click();`,
      condition: `location.pathname === "/thoughts"
        && document.querySelectorAll("#all-thoughts [data-chain-id]").length >= 12
        && !document.querySelector("#all-thoughts [data-chain-id]")?.open`
    });
    detailReturnMs.push(measured.durationMs);
  }

  await browser.setSample("second-device-sync-prime");
  const syncPrimeRequestIndex = testServer.requests.length - 1;
  const syncPrime = testServer.publishSecondDeviceThought(0);
  await browser.waitForCondition({
    label: "second-device sync prime",
    action: `document.dispatchEvent(new Event("visibilitychange"));`,
    condition: `Boolean(document.querySelector('[data-chain-id="${syncPrime.id}"]'))`
  });
  await testServer.waitForRequest(
    item => item.sample === "second-device-sync-prime" && item.path === "/api/v1/sync",
    { afterIndex: syncPrimeRequestIndex }
  );

  const secondDeviceSyncMs = [];
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    const sample = `second-device-sync-${index}`;
    await browser.setSample(sample);
    const requestIndex = testServer.requests.length - 1;
    const startedAt = performance.now();
    const mutation = testServer.publishSecondDeviceThought(index);
    await browser.waitForCondition({
      label: `second-device sync ${index}`,
      action: `document.dispatchEvent(new Event("visibilitychange"));`,
      condition: `Boolean(document.querySelector('[data-chain-id="${mutation.id}"]'))`
    });
    secondDeviceSyncMs.push(Number((performance.now() - startedAt).toFixed(1)));
    await testServer.waitForRequest(item => item.sample === sample && item.path === "/api/v1/sync", {
      afterIndex: requestIndex
    });
  }

  const metrics = {
    "web.startup.coldCache.currentScreenFeedback_ms": distribution(
      cold.map(item => item.currentScreenFeedbackMs),
      "ms",
      TIMING_BUDGET["web.startup.coldCache.currentScreenFeedback_ms"]
    ),
    "web.startup.coldCache.firstReadable_ms": distribution(
      cold.map(item => item.firstReadableMs),
      "ms",
      TIMING_BUDGET["web.startup.coldCache.firstReadable_ms"]
    ),
    "web.startup.warmCache.currentScreenFeedback_ms": distribution(
      warm.map(item => item.currentScreenFeedbackMs),
      "ms",
      TIMING_BUDGET["web.startup.warmCache.currentScreenFeedback_ms"]
    ),
    "web.startup.warmCache.firstReadable_ms": distribution(
      warm.map(item => item.firstReadableMs),
      "ms",
      TIMING_BUDGET["web.startup.warmCache.firstReadable_ms"]
    ),
    "web.startup.coldCache.stableHome_ms": distribution(cold.map(item => item.stableHomeMs), "ms"),
    "web.startup.warmCache.stableHome_ms": distribution(warm.map(item => item.stableHomeMs), "ms"),
    "web.navigation.routeSwitch.firstReadable_ms": distribution(
      routeSwitchMs,
      "ms",
      TIMING_BUDGET["web.navigation.routeSwitch.firstReadable_ms"]
    ),
    "web.navigation.thoughtDetail.firstReadable_ms": distribution(
      detailOpenMs,
      "ms",
      TIMING_BUDGET["web.navigation.thoughtDetail.firstReadable_ms"]
    ),
    "web.navigation.thoughtDetailReturn.firstReadable_ms": distribution(
      detailReturnMs,
      "ms",
      TIMING_BUDGET["web.navigation.thoughtDetailReturn.firstReadable_ms"]
    ),
    "web.sync.secondDeviceCommitToReadable_ms": distribution(
      secondDeviceSyncMs,
      "ms",
      TIMING_BUDGET["web.sync.secondDeviceCommitToReadable_ms"]
    ),
    "web.startup.coldCache.requests_count": distribution(cold.map(item => item.requestCount), "count"),
    "web.startup.warmCache.requests_count": distribution(warm.map(item => item.requestCount), "count"),
    "web.startup.coldCache.transfer_body_bytes": distribution(cold.map(item => item.transferBytes), "bytes"),
    "web.startup.warmCache.transfer_body_bytes": distribution(warm.map(item => item.transferBytes), "bytes"),
    "web.startup.coldCache.initial_json_decoded_bytes": distribution(
      cold.map(item => item.initialJsonDecodedBytes),
      "bytes"
    ),
    "web.startup.coldCache.initial_json_transfer_bytes": distribution(
      cold.map(item => item.initialJsonTransferBytes),
      "bytes"
    )
  };
  const violations = [
    ...cold.flatMap(startupContractFailures),
    ...warm.flatMap(startupContractFailures)
  ];
  for (const [name, budget] of Object.entries(TIMING_BUDGET)) {
    const metric = metrics[name];
    if (metric.p75 > budget.p75) violations.push(`${name} P75 ${metric.p75}ms > ${budget.p75}ms`);
    if (metric.p95 > budget.p95) violations.push(`${name} P95 ${metric.p95}ms > ${budget.p95}ms`);
  }
  const measuredBrowserRequests = testServer.requests.filter(item => item.sample && item.sample !== "startup-warm-prime");
  const mediaBeforeClickTransferBytes = sum(
    measuredBrowserRequests.filter(item => mediaPath(item.path)).map(item => item.transferBytes)
  );
  if (mediaBeforeClickTransferBytes !== 0) {
    violations.push(`web.media.beforeClick.transfer_body_bytes ${mediaBeforeClickTransferBytes} B, expected 0 B`);
  }

  const report = {
    schemaVersion: 1,
    status: violations.length ? "failed" : "passed",
    durationMs: Math.round(performance.now() - gateStartedAt),
    conditions: {
      sampleCount: SAMPLE_COUNT,
      percentileMethod: "nearest-rank",
      browser: CHROME,
      browserProcess: "one fixed headless browser process and profile",
      coldCache: "HTTP cache disabled and cleared before every measured navigation",
      warmCache: "same profile, HTTP cache enabled after one unreported priming navigation; no-store remains honored",
      network: NETWORK_PROFILE,
      viewport: VIEWPORT,
      serviceWorker: "bypassed",
      measurementCutoff: "opening visibility for current-screen feedback; opening exit with visible, non-inert route for firstReadable; stableHome reported separately"
    },
    metrics,
    contracts: {
      assets: {
        blockingStyles: { requests: styles.assets.length, decodedBytes: styles.bytes, assets: styles.assets },
        entryModules: { requests: modules.assets.length, decodedBytes: modules.bytes },
        deferredRuntimeModules: { requests: deferredRuntime.assets.length, decodedBytes: deferredRuntime.bytes },
        defaultRouteModules: { requests: defaultRouteModules.assets.length, decodedBytes: defaultRouteModules.bytes },
        lazyFeatureModules: Object.fromEntries(Object.entries(lazyFeatureModules).map(([view, closure]) => [
          view,
          { requests: closure.assets.length, decodedBytes: closure.bytes }
        ]))
      },
      startupJsonDecodedBytesMax: Math.max(...cold.map(item => item.startupJsonDecodedBytes)),
      routeJsonDecodedBytesMax: Math.max(...cold.map(item => item.routeJsonDecodedBytes)),
      initialJsonTransferBytesMax: Math.max(...cold.map(item => item.initialJsonTransferBytes)),
      firstReadableRequestsMax: Math.max(...cold.map(item => item.requestCount)),
      firstReadableApiRequestsMax: Math.max(...cold.map(item => item.apiRequestCount)),
      uiPreferenceRequestsMax: Math.max(...cold.concat(warm).map(item => item.uiPreferenceRequestCount)),
      forbiddenFullStateRequests: cold.concat(warm).filter(item => item.requestPaths.includes("/api/state")).length,
      hiddenFeatureModuleRequests: cold.concat(warm).flatMap(item => item.requestPaths)
        .filter(value => HIDDEN_FEATURE_MODULE_PATHS.includes(value)).length,
      mediaBeforeClickTransferBytes,
      opening: {
        heldDeepLinkFirstContentfulPaintMs: heldOpening.firstContentfulPaintMs,
        feedbackDistributionBudgetMs: OPENING_BUDGET.firstContentfulPaintMs,
        entrySchedulingMarkerMs: heldOpening.markerVisibleMs,
        appEntryStartMs: heldOpening.appEntryStartMs,
        appEntryResponseEndMs: heldOpening.appEntryResponseEndMs,
        timingBoundaryToleranceMs: OPENING_TIMING_BOUNDARY_TOLERANCE_MS,
        readyToCompleteMs: deepLinkOpening.readyToCompleteMs,
        readyToPaintedMs: deepLinkOpening.readyToPaintedMs,
        readyToPaintedBudgetMs: OPENING_BUDGET.readyToPaintedMs,
        reducedMotionReadyToCompleteMs: reducedMotionOpening.readyToCompleteMs,
        deepLink: deepLinkOpening.path,
        secondaryFailure: "/api/preferences -> failure",
        watchdogFailure: "5000ms timeout -> late runtimeReady remains failure",
        retry: "failure -> reload -> complete",
        uiPreferenceRequestsMax: OPENING_BUDGET.uiPreferenceRequests
      },
      gzip: {
        staticText: "gzip + Vary: Accept-Encoding",
        jsonOver1024Bytes: "gzip + private, no-store + Vary: Accept-Encoding",
        identityRequest: "uncompressed",
        media: "not gzip encoded"
      },
      range: "scripts/attachment-range-regression.mjs is part of npm run test:performance-gate"
    },
    automatedSecondDeviceScope: "external account commit simulation -> foreground /api/v1/sync pull -> first-device DOM readability",
    notCovered: [
      "Preview Linux long-window RSS segmentation, restart/OOM/5xx observation and alert hysteresis"
    ],
    violations
  };
  if (REPORT_PATH) {
    const output = path.resolve(REPORT_PATH);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Web performance gate report: ${JSON.stringify(report)}`);
  assert.deepEqual(violations, [], `Web performance gate failed:\n- ${violations.join("\n- ")}`);
} catch (error) {
  throw browser ? await browserDiagnostics(browser, testServer, error) : error;
} finally {
  await browser?.close();
  await testServer.close();
}
