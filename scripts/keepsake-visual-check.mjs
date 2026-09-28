import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const imagePath = process.argv[2];
if (!imagePath) throw new Error("Usage: node scripts/keepsake-visual-check.mjs <image>");
const outputPrefix = process.argv[3] || "/tmp/keepsake-real-check";
const appUrl = process.env.APP_URL || "http://127.0.0.1:4173/";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      const page = pages.find(item => item.type === "page" && !item.url.startsWith("chrome-extension:"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(50);
  }
  throw new Error("Chrome debugging endpoint did not start");
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id, response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
}

const port = await freePort(), profile = `/tmp/keepsake-chrome-${Date.now()}`;
const chrome = spawn(resolveHeadlessBrowser(), [
  "--headless=new", "--disable-breakpad", "--disable-crash-reporter", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--password-store=basic", "--use-mock-keychain",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1360,1000", appUrl
], { stdio: "ignore" });

try {
  const cdp = new Cdp(await debuggerUrl(port));
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("DOM.enable");
  await cdp.send("Page.navigate", { url: appUrl });
  await sleep(1000);
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-view="keepsakes"]').click(); document.querySelector("#keepsake-create-toggle").click()` });
  const input = await cdp.send("Runtime.evaluate", { expression: `document.querySelector("#keepsake-image")` });
  if (!input.result.objectId) {
    const context = await cdp.send("Runtime.evaluate", { expression: `({url:location.href,title:document.title,body:document.body?.innerText.slice(0,200)})`, returnByValue: true });
    throw new Error(`Keepsake input unavailable: ${JSON.stringify(context.result.value)}`);
  }
  const startedAt = Date.now();
  await cdp.send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [imagePath] });
  let status = "";
  for (let attempt = 0; attempt < 700; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", { expression: `document.querySelector("#keepsake-segment-status").textContent`, returnByValue: true });
    status = result.result.value || "";
    if (/自动轮廓已生成|自动提取未完成/.test(status)) break;
    await sleep(100);
  }
  const metrics = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const canvas=document.querySelector("#keepsake-preview-canvas"),data=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
      let count=0,minX=canvas.width,minY=canvas.height,maxX=0,maxY=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){if(data[(y*canvas.width+x)*4+3]>127){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}}
      const boxArea=Math.max(1,(maxX-minX+1)*(maxY-minY+1));
      return {width:canvas.width,height:canvas.height,count,bounds:[minX,minY,maxX,maxY],fillRatio:count/boxArea,status:document.querySelector("#keepsake-segment-status").textContent};
    })()`,
    returnByValue: true
  })).result.value;
  const presentation = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector("#keepsake-preview-canvas").toDataURL("image/png")`,
    returnByValue: true
  });
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await fs.mkdir(path.dirname(outputPrefix), { recursive: true });
  await Promise.all([
    fs.writeFile(`${outputPrefix}-presentation.png`, Buffer.from(presentation.result.value.split(",")[1], "base64")),
    fs.writeFile(`${outputPrefix}-ui.png`, Buffer.from(screenshot.data, "base64"))
  ]);
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, ...metrics }, null, 2));
  assert.ok(metrics.count > 0, "mask should not be empty");
  assert.ok(metrics.fillRatio < .93, "mask still resembles a filled rectangle");
  cdp.socket.close();
} finally {
  chrome.kill("SIGTERM");
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
