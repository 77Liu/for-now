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
import { onboardingV2Schema } from "../src/modules/onboarding/index.mjs";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const CHROME = resolveHeadlessBrowser();
const BUDGET = Object.freeze({
  blockingStyleRequests: 2,
  blockingStyleBytes: 250 * 1024,
  entryModuleCount: 23,
  entryModuleBytes: 724 * 1024,
  currentScreenFeedbackMs: 500,
  stableHomeMs: 1000
});
const NETWORK_PROFILES = Object.freeze([
  { name: "local", latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  { name: "fast-4g", latency: 40, downloadThroughput: 1_250_000, uploadThroughput: 625_000 }
]);
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
    .filter(tag => attribute(tag, "rel").split(/\s+/).includes("stylesheet"))
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

const moduleDependencies = source => [
  ...source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g),
  ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)
].map(match => match[1]);

async function moduleClosure(entry) {
  const pending = [entry];
  const assets = new Set();
  let bytes = 0;

  while (pending.length) {
    const asset = normalizeAsset(pending.pop());
    if (assets.has(asset)) continue;
    assets.add(asset);
    const source = await fs.readFile(publicFile(asset), "utf8");
    bytes += await fileBytes(asset);
    for (const specifier of moduleDependencies(source)) {
      if (!specifier.startsWith(".")) continue;
      pending.push(path.posix.join(path.posix.dirname(asset), specifier));
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
const clientState = {
  ...structuredClone(emptyClientState),
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
  const json = (response, value, { status = 200, cacheControl = "private, no-store" } = {}) => {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "cache-control": cacheControl,
      "content-length": body.length,
      "content-type": "application/json; charset=utf-8"
    });
    response.end(body);
    return { rawBytes: body.length, transferBytes: body.length };
  };
  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const url = new URL(request.url, "http://127.0.0.1");
    let result;
    try {
      if (url.pathname === "/api/auth/me") {
        result = json(response, { authenticated: true, authRequired: true, user, userCount: 1 });
      } else if (url.pathname === "/api/state") {
        result = json(response, clientState);
      } else if (url.pathname === "/api/meta") {
        result = json(response, { version: "web-budget", releaseVersion: "0.4.0", user, capabilities: [], features: {} });
      } else if (url.pathname === "/api/preferences") {
        result = json(response, preferences);
      } else if (url.pathname === "/api/v1/onboarding-v2/schema") {
        result = json(response, v1(onboardingV2Schema));
      } else if (url.pathname === "/api/v1/onboarding-v2/session") {
        result = json(response, v1(onboardingV2));
      } else if (url.pathname.startsWith("/api/")) {
        result = json(response, { error: "Not found", code: "NOT_FOUND" }, { status: 404 });
      } else {
        const relative = isApplicationRoutePath(url.pathname)
          ? "index.html"
          : url.pathname.replace(/^\/+/, "") || "index.html";
        const file = path.resolve(PUBLIC, relative);
        if (!file.startsWith(`${PUBLIC}${path.sep}`)) {
          result = json(response, { error: "Forbidden" }, { status: 403, cacheControl: "no-store" });
        } else {
          const body = await fs.readFile(file);
          const acceptsGzip = /\bgzip\b/.test(String(request.headers["accept-encoding"] || ""));
          const useGzip = acceptsGzip && textAsset(file) && body.length >= 1024;
          const cacheKey = `${file}:gzip`;
          if (useGzip && !encoded.has(cacheKey)) encoded.set(cacheKey, gzipSync(body, { level: 6 }));
          const output = useGzip ? encoded.get(cacheKey) : body;
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-length": output.length,
            "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
            ...(useGzip ? { "content-encoding": "gzip", vary: "Accept-Encoding" } : {})
          });
          response.end(request.method === "HEAD" ? undefined : output);
          result = { rawBytes: body.length, transferBytes: output.length };
        }
      }
    } catch (error) {
      result = json(response, { error: "Not found" }, { status: error.code === "ENOENT" ? 404 : 500, cacheControl: "no-store" });
    } finally {
      requests.push({
        method: request.method,
        path: url.pathname,
        rawBytes: result?.rawBytes || 0,
        transferBytes: result?.transferBytes || 0,
        durationMs: Number((performance.now() - startedAt).toFixed(1))
      });
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
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

async function runBrowserBudget(baseUrl, profile) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `growth-web-budget-${profile.name}-`));
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
  let cdp;
  try {
    cdp = new Cdp(await pageDebuggerUrl(debugPort));
    const responses = new Map();
    cdp.onEvent(message => {
      if (message.method === "Network.responseReceived" && message.params.response.url.startsWith(baseUrl)) {
        responses.set(message.params.requestId, {
          url: message.params.response.url,
          status: message.params.response.status,
          type: message.params.type,
          transferBytes: 0
        });
      }
      if (message.method === "Network.loadingFinished" && responses.has(message.params.requestId)) {
        responses.get(message.params.requestId).transferBytes = Math.round(message.params.encodedDataLength);
      }
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latency,
      downloadThroughput: profile.downloadThroughput,
      uploadThroughput: profile.uploadThroughput,
      connectionType: profile.name === "local" ? "none" : "cellular4g"
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        delete Navigator.prototype.serviceWorker;
        addEventListener("DOMContentLoaded", () => {
          const check = () => {
            const active = document.querySelector(".view.active");
            if (document.body && !document.body.classList.contains("auth-locked") && active && getComputedStyle(active).display !== "none") {
              window.__currentScreenFeedback = Number(performance.now().toFixed(1));
              observer.disconnect();
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });
          check();
        }, { once: true });
      `
    });
    const evaluate = async expression => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await cdp.send("Page.navigate", { url: `${baseUrl}/today?native-performance=1&budget-profile=${profile.name}` });
    let ready = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      ready = await evaluate(`document.querySelector("#startup-performance-metric")?.textContent.startsWith("启动分段 ") || false`);
      if (ready) break;
      await sleep(25);
    }
    assert.equal(ready, true, `${profile.name} 未产生 stableHome 指标`);
    await sleep(100);
    const browser = await evaluate(`(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const metric = document.querySelector("#startup-performance-metric").textContent.replace(/^启动分段 /, "");
      const startup = JSON.parse(metric);
      return {
        dclMs: Number(navigation.domContentLoadedEventEnd.toFixed(1)),
        currentScreenFeedbackMs: window.__currentScreenFeedback,
        stableHomeMs: startup.marks.stableHome,
        visibleShellMs: startup.marks.visibleShell,
        domNodes: document.getElementsByTagName("*").length
      };
    })()`);
    const completed = [...responses.values()].filter(item => item.transferBytes > 0);
    const paths = completed.map(item => new URL(item.url).pathname);
    return {
      profile: profile.name,
      ...browser,
      resources: completed.length,
      transferBytes: completed.reduce((total, item) => total + item.transferBytes, 0),
      requestPaths: paths
    };
  } finally {
    cdp?.socket.close();
    chrome.kill("SIGKILL");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const html = await fs.readFile(publicFile("index.html"), "utf8");
const styles = await blockingStyleClosure(html);
const modules = await moduleClosure("app.js");

assert.ok(
  styles.assets.length <= BUDGET.blockingStyleRequests,
  `首屏阻塞样式请求 ${styles.assets.length} 超过预算 ${BUDGET.blockingStyleRequests}: ${styles.assets.join(", ")}`
);
assert.ok(
  styles.bytes <= BUDGET.blockingStyleBytes,
  `首屏阻塞样式 ${styles.bytes} B 超过预算 ${BUDGET.blockingStyleBytes} B`
);
assert.ok(
  modules.assets.length <= BUDGET.entryModuleCount,
  `入口模块闭包 ${modules.assets.length} 个超过预算 ${BUDGET.entryModuleCount}`
);
assert.ok(
  modules.bytes <= BUDGET.entryModuleBytes,
  `入口模块闭包 ${modules.bytes} B 超过预算 ${BUDGET.entryModuleBytes} B`
);

const testServer = await createTestServer();
try {
  const compressedHtml = await fetch(`${testServer.baseUrl}/`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedHtml.headers.get("content-encoding"), "gzip");
  assert.equal(compressedHtml.headers.get("cache-control"), "no-store");
  assert.match(compressedHtml.headers.get("vary") || "", /Accept-Encoding/i);
  const compressedRuntime = await fetch(`${testServer.baseUrl}/frontend/app/runtime.mjs`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressedRuntime.headers.get("content-encoding"), "gzip");
  assert.equal(compressedRuntime.headers.get("cache-control"), "no-store");
  const privateState = await fetch(`${testServer.baseUrl}/api/state`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(privateState.headers.get("content-encoding"), null);
  assert.equal(privateState.headers.get("cache-control"), "private, no-store");

  const evidence = [];
  for (const profile of NETWORK_PROFILES) evidence.push(await runBrowserBudget(testServer.baseUrl, profile));
  for (const result of evidence) {
    console.log(`Web first-screen ${result.profile}: ${JSON.stringify({
      dclMs: result.dclMs,
      currentScreenFeedbackMs: result.currentScreenFeedbackMs,
      visibleShellMs: result.visibleShellMs,
      stableHomeMs: result.stableHomeMs,
      resources: result.resources,
      transferBytes: result.transferBytes,
      domNodes: result.domNodes
    })}`);
  }
  for (const result of evidence) {
    assert.ok(
      result.currentScreenFeedbackMs < BUDGET.currentScreenFeedbackMs,
      `${result.profile} current-screen feedback ${result.currentScreenFeedbackMs}ms 未低于 ${BUDGET.currentScreenFeedbackMs}ms`
    );
    assert.ok(
      result.stableHomeMs < BUDGET.stableHomeMs,
      `${result.profile} stableHome ${result.stableHomeMs}ms 未低于 ${BUDGET.stableHomeMs}ms`
    );
    for (const endpoint of ["/api/auth/me", "/api/state", "/api/meta"]) {
      assert.equal(result.requestPaths.filter(value => value === endpoint).length, 1, `${result.profile} 重复请求 ${endpoint}`);
    }
  }
  const browserRequests = testServer.requests.filter(item => !["HEAD", "OPTIONS"].includes(item.method));
  const rawBytes = browserRequests.reduce((total, item) => total + item.rawBytes, 0);
  const transferBytes = browserRequests.reduce((total, item) => total + item.transferBytes, 0);
  console.log(
    `Web first-screen budgets passed: ${styles.assets.length} blocking styles / ${styles.bytes} B; ` +
    `${modules.assets.length} entry modules / ${modules.bytes} B; HTTP payload ${rawBytes} B raw / ${transferBytes} B encoded.`
  );
} finally {
  await testServer.close();
}
