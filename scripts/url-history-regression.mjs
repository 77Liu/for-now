import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = resolveHeadlessBrowser();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function debuggerUrl(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(item => item.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await delay(50);
  }
  throw new Error("Timed out waiting for the browser debugger");
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
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

function isolatedEnvironment(dataDir, port) {
  const blocked = /^(?:DATABASE_URL|AUTH_DATABASE_URL|PG_BACKUP_DATABASE_URL|PG_SCHEMA_DATABASE_URL|APP_URL|UPSTREAM_ORIGIN)$/;
  const provider = /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key) && !provider.test(key)));
  return {
    ...env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: String(port),
    APP_BASE_PATH: "/now",
    AUTH_REQUIRED: "0",
    INVITE_CODE_HASH: "",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    PERIODIC_ANALYSIS_ENABLED: "0",
    UPSTREAM_ORIGIN: ""
  };
}

async function waitForServer(url, child, stderr) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {}
    if (child.exitCode != null) break;
    await delay(50);
  }
  throw new Error(`Server did not start: ${stderr()}`);
}

async function createThought(base, index, tag = "focus") {
  const response = await fetch(`${base}/api/v1/thought-chains`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `url-history-${index}`
    },
    body: JSON.stringify({
      question: `URL history thought ${String(index).padStart(2, "0")} ${"content ".repeat(12)}`,
      occurredAt: `2026-10-02T${String(8 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
      tags: [tag]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.items.find(item => item.type === "question");
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-url-history-data-"));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "growth-url-history-browser-"));
const appPort = await freePort();
const debugPort = await freePort();
const origin = `http://127.0.0.1:${appPort}`;
const base = `${origin}/now`;
let stderr = "";
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: isolatedEnvironment(dataDir, appPort),
  stdio: ["ignore", "ignore", "pipe"]
});
server.stderr.on("data", chunk => { stderr += chunk; });
let chrome;
let cdp;

try {
  await waitForServer(base, server, () => stderr);
  const thoughts = [];
  for (let index = 0; index < 24; index += 1) {
    thoughts.push(await createThought(base, index, index === 23 ? "other" : "focus"));
  }
  const primary = thoughts[0];

  const directResponse = await fetch(`${base}/thoughts/${encodeURIComponent(primary.id)}?tag=focus&sort=created&page=2`);
  assert.equal(directResponse.status, 200);
  assert.match(directResponse.headers.get("content-type") || "", /^text\/html/);
  const outsideBaseResponse = await fetch(`${origin}/today`);
  assert.equal(outsideBaseResponse.status, 404);
  assert.match(outsideBaseResponse.headers.get("content-type") || "", /^application\/json/);
  const canonicalPageResponse = await fetch(`${base}/today`);
  assert.equal(canonicalPageResponse.status, 200);
  assert.match(canonicalPageResponse.headers.get("content-type") || "", /^text\/html/);
  assert.equal((await fetch(`${base}/view/books`)).status, 200);
  assert.equal((await fetch(`${base}/not-an-app-route`)).status, 404);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/meta`)).status, 200);
  const missingAttachmentResponse = await fetch(`${base}/attachments/missing.png`);
  assert.equal(missingAttachmentResponse.status, 404);
  assert.match(missingAttachmentResponse.headers.get("content-type") || "", /^application\/json/);

  chrome = spawn(CHROME, [
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
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });
  cdp = new Cdp(await debuggerUrl(debugPort));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });

  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const waitUntil = async (expression, attempts = 160, waitMs = 50) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await delay(waitMs);
    }
    return false;
  };
  const navigate = async url => {
    await cdp.send("Page.navigate", { url });
    assert.equal(await waitUntil(`document.querySelector("#today-date-label")?.textContent&&document.querySelector("#auth-gate")?.hidden&&!document.body.classList.contains("auth-locked")`), true);
  };

  await navigate(`${base}/thoughts/${encodeURIComponent(primary.id)}?tag=focus&sort=created&page=2`);
  assert.deepEqual(await evaluate(`({
    path:location.pathname,
    search:location.search,
    active:document.querySelector("#view-thoughts").classList.contains("active"),
    cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length,
    id:document.querySelector("#all-thoughts [data-chain-id]")?.dataset.chainId,
    open:document.querySelector("#all-thoughts [data-chain-id]")?.open,
    styles:getComputedStyle(document.body).fontFamily.length>0
  })`), {
    path:`/now/thoughts/${primary.id}`,
    search:"?tag=focus&sort=created&page=2",
    active:true,
    cards:1,
    id:primary.id,
    open:true,
    styles:true
  });
  assert.deepEqual(await evaluate(`performance.getEntriesByType("resource")
    .map(entry=>new URL(entry.name).pathname)
    .filter(path=>/^\\/now\\/thoughts\\/(?:frontend\\/|app\\.js$|drift\\.css$)/.test(path))`), []);

  await navigate(`${base}/view/thoughts?tag=focus&sort=created&page=2`);
  const firstThoughtPageReady=await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===23&&document.querySelector("#thought-pagination").hidden`);
  assert.equal(firstThoughtPageReady,true,JSON.stringify(await evaluate(`({path:location.pathname,search:location.search,cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length,paginationHidden:document.querySelector("#thought-pagination").hidden,paginationText:document.querySelector("#thought-pagination-status").textContent,busy:document.querySelector("#view-thoughts").getAttribute("aria-busy"),body:document.querySelector("#all-thoughts").textContent.slice(0,160)})`)));
  await evaluate(`(()=>{const input=document.querySelector("#thought-search");input.value="thought 22";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`location.search.includes("q=thought+22")&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===1`),true);
  await evaluate(`(()=>{const input=document.querySelector("#thought-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`!location.search.includes("q=")&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===20`),true);
  const queryHistoryLength = await evaluate("history.length");
  await evaluate(`document.querySelector('[data-thought-sort="occurred"]').click();true`);
  assert.deepEqual(await evaluate(`({path:location.pathname,search:location.search,length:history.length,sort:document.querySelector('[data-thought-sort="occurred"]').getAttribute("aria-pressed")})`), {
    path:"/now/thoughts",
    search:"?tag=focus",
    length:queryHistoryLength,
    sort:"true"
  });
  await evaluate(`document.querySelector('[data-tag-filter="other"]').click();true`);
  assert.equal(await waitUntil(`location.search==="?tag=other"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===1`),true);
  assert.deepEqual(await evaluate(`({search:location.search,length:history.length,cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length})`), {
    search:"?tag=other",
    length:queryHistoryLength,
    cards:1
  });
  await evaluate(`document.querySelector('[data-tag-filter="focus"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#all-thoughts [data-chain-id]").length===20&&!document.querySelector("#thought-pagination").hidden`), true);
  await evaluate(`document.querySelector("#thought-load-more").click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#all-thoughts [data-chain-id]").length===23`),true);

  await evaluate("scrollTo(0, 700); true");
  await delay(100);
  const savedScroll = await evaluate("scrollY");
  assert.ok(savedScroll > 200);
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="${primary.id}"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts/${primary.id}"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===1`), true);
  const detailHistoryLength = await evaluate("history.length");
  await evaluate("history.back(); true");
  const browserBackRestored=await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===23&&Math.abs(scrollY-${savedScroll})<120`);
  assert.equal(browserBackRestored,true,JSON.stringify(await evaluate(`({path:location.pathname,search:location.search,cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length,scrollY,paginationHidden:document.querySelector("#thought-pagination").hidden,busy:document.querySelector("#view-thoughts").getAttribute("aria-busy")})`)));
  assert.ok(Math.abs((await evaluate("scrollY")) - savedScroll) < 120);
  await evaluate("history.forward(); true");
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts/${primary.id}"&&document.querySelector("#all-thoughts [data-chain-id]")?.open`), true);
  assert.equal(await evaluate("history.length"), detailHistoryLength);
  await evaluate(`document.querySelector("[data-thought-list]").click();true`);
  const detailBackRestored=await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===23&&Math.abs(scrollY-${savedScroll})<120`);
  assert.equal(detailBackRestored,true,JSON.stringify(await evaluate(`({path:location.pathname,search:location.search,cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length,scrollY,paginationHidden:document.querySelector("#thought-pagination").hidden,busy:document.querySelector("#view-thoughts").getAttribute("aria-busy")})`)));
  await delay(300);
  assert.deepEqual(await evaluate(`({
    deepScroll:scrollY>200,
    expanded:document.querySelectorAll("#all-thoughts [data-chain-id][open]").length,
    length:history.length
  })`), { deepScroll:true, expanded:0, length:detailHistoryLength });

  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="${primary.id}"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts/${primary.id}"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===1`), true);
  await evaluate(`document.querySelector("[data-thought-list]").click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelectorAll("#all-thoughts [data-chain-id]").length===23&&scrollY>200`), true);
  assert.equal(await evaluate(`document.querySelectorAll("#all-thoughts [data-chain-id][open]").length`), 0);
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="${primary.id}"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts/${primary.id}"`), true);

  await evaluate(`window.confirm=()=>true;document.querySelector("#all-thoughts [data-delete-chain]").click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelector('[data-route-result="unavailable"]')?.dataset.routeErrorCode==="RESOURCE_UNAVAILABLE"`), true);
  assert.deepEqual(await evaluate(`({
    resourceType:document.querySelector('[data-route-result="unavailable"]').dataset.routeResourceType,
    oldContent:document.querySelector("#view-thoughts").textContent.includes("URL history thought 00"),
    listCount:document.querySelectorAll("#all-thoughts [data-chain-id]").length
  })`), { resourceType:"thought-chain", oldContent:false, listCount:22 });

  await navigate(`${base}/thoughts/${encodeURIComponent(primary.id)}?tag=focus`);
  assert.equal(await waitUntil(`location.pathname==="/now/thoughts"&&document.querySelector('[data-route-result="unavailable"]')`), true);
  await navigate(`${base}/`);
  assert.deepEqual(await evaluate(`({path:location.pathname,today:document.querySelector("#view-today").classList.contains("active")})`), {
    path:"/now/today",
    today:true
  });
  await evaluate(`document.querySelector('.home-v02-memory[data-home-memory-type="thought"] [data-home-memory-open]').click();true`);
  assert.equal(await waitUntil(`location.pathname.startsWith("/now/thoughts/")&&document.querySelector("#all-thoughts").dataset.routeMode==="detail"`), true);
  await evaluate(`document.querySelector("[data-thought-list]").click();true`);
  assert.equal(await waitUntil(`location.pathname==="/now/today"&&document.querySelector("#view-today").classList.contains("active")`), true);

  console.log("URL/history regression passed: direct and legacy routes, query replacement, detail history, source-aware return, scroll restoration, and deleted-object fallback.");
} finally {
  cdp?.socket.close();
  chrome?.kill("SIGKILL");
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => server.once("exit", resolve)),
    delay(1000)
  ]);
  await Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(profile, { recursive: true, force: true })
  ]);
}
