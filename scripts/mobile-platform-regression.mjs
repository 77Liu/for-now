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
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForUrl(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`应用服务提前退出：${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`等待服务超时：${url}`);
}

async function pageDebuggerUrl(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(item => item.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(50);
  }
  throw new Error("等待移动平台浏览器调试端口超时");
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

const devices = [
  {
    name: "iphone-se",
    width: 375,
    height: 667,
    dpr: 2,
    orientation: { type: "portraitPrimary", angle: 0 },
    marker: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  },
  {
    name: "iphone-15",
    width: 393,
    height: 852,
    dpr: 3,
    orientation: { type: "portraitPrimary", angle: 0 },
    marker: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  },
  {
    name: "pixel-7",
    width: 412,
    height: 915,
    dpr: 2.625,
    orientation: { type: "portraitPrimary", angle: 0 },
    marker: "Android",
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
  },
  {
    name: "android-landscape",
    width: 915,
    height: 412,
    dpr: 2.625,
    orientation: { type: "landscapePrimary", angle: 90 },
    marker: "Android",
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
  }
];

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-mobile-platform-"));
const appPort = await freePort();
const debugPort = await freePort();
const app = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "test", PORT: String(appPort), DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"]
});
let appErrors = "";
app.stderr.on("data", chunk => { appErrors += chunk; });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "growth-mobile-chrome-"));
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
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: "ignore" });

let cdp;
try {
  const base = `http://127.0.0.1:${appPort}`;
  await waitForUrl(`${base}/api/state`, app);
  const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type") || "", /^application\/manifest\+json/);
  assert.equal((await manifestResponse.json()).display, "standalone");

  cdp = new Cdp(await pageDebuggerUrl(debugPort));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const waitUntil = async (expression, attempts = 80) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(50);
    }
    return false;
  };

  for (const device of devices) {
    await cdp.send("Network.setUserAgentOverride", { userAgent: device.userAgent, acceptLanguage: "zh-CN", platform: device.marker === "iPhone" ? "iPhone" : "Linux armv8l" });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height,
      screenOrientation: device.orientation
    });
    await cdp.send("Page.navigate", { url: `${base}/?mobile-profile=${device.name}` });
    assert.equal(await waitUntil(`document.querySelector("#today-date-label")?.textContent.length > 0`), true);

    const shell = await evaluate(`(() => {
      const nav=document.querySelector(".sidebar").getBoundingClientRect(),main=document.querySelector("main").getBoundingClientRect(),viewport=document.querySelector('meta[name="viewport"]')?.content||"";
      const fields=[...document.querySelectorAll('textarea,select,input:not([type]),input[type="text"],input[type="password"],input[type="email"],input[type="search"],input[type="tel"],input[type="url"],input[type="number"],input[type="date"],input[type="datetime-local"],input[type="time"]')].filter(item=>getComputedStyle(item).display!=="none");
      return {
        width:innerWidth,
        height:innerHeight,
        dpr:devicePixelRatio,
        touch:navigator.maxTouchPoints,
        ua:navigator.userAgent,
        portrait:matchMedia("(orientation: portrait)").matches,
        viewportFit:viewport.includes("viewport-fit=cover"),
        manifest:Boolean(document.querySelector('link[rel="manifest"]')),
        noOverflow:document.documentElement.scrollWidth<=innerWidth,
        navInside:nav.left>=0&&nav.right<=innerWidth+.5&&Math.abs(nav.bottom-innerHeight)<1,
        mainInside:main.left>=0&&main.right<=innerWidth+.5,
        inputFontSafe:fields.every(item=>parseFloat(getComputedStyle(item).fontSize)>=16)
      };
    })()`);
    assert.equal(shell.width, device.width);
    assert.equal(shell.height, device.height);
    assert.ok(Math.abs(shell.dpr - device.dpr) < 0.01);
    assert.equal(shell.touch, 5);
    assert.match(shell.ua, new RegExp(device.marker));
    assert.equal(shell.portrait, device.orientation.angle === 0);
    assert.equal(shell.viewportFit, true);
    assert.equal(shell.manifest, true);
    assert.equal(shell.noOverflow, true);
    assert.equal(shell.navInside, true);
    assert.equal(shell.mainInside, true);
    assert.equal(shell.inputFontSafe, true);

    const thoughtNav = await evaluate(`(() => { const rect=document.querySelector('[data-section="thought"]').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2} })()`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: thoughtNav.x, y: thoughtNav.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")`), true);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);

    await evaluate(`document.querySelector("#edit-chain-modal").hidden=false;document.querySelector("#edit-chain-question").focus();true`);
    const keyboardHeight = Math.min(device.height, device.orientation.angle === 0 ? 430 : 300);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: keyboardHeight,
      deviceScaleFactor: device.dpr,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height,
      screenOrientation: device.orientation
    });
    await sleep(100);
    const keyboard = await evaluate(`(() => {
      const backdrop=document.querySelector("#edit-chain-modal").getBoundingClientRect(),modal=document.querySelector("#edit-chain-form").getBoundingClientRect(),field=document.querySelector("#edit-chain-question");
      return {
        visualHeight:Math.round(visualViewport?.height||innerHeight),
        innerHeight,
        backdropInside:backdrop.top>=0&&backdrop.bottom<=innerHeight+.5,
        modalScrollable:getComputedStyle(document.querySelector("#edit-chain-form")).overflowY==="auto",
        modalFits:modal.height<=innerHeight,
        focused:document.activeElement===field,
        inputFont:parseFloat(getComputedStyle(field).fontSize),
        noOverflow:document.documentElement.scrollWidth<=innerWidth
      };
    })()`);
    assert.equal(keyboard.visualHeight, keyboardHeight);
    assert.equal(keyboard.innerHeight, keyboardHeight);
    assert.equal(keyboard.backdropInside, true);
    assert.equal(keyboard.modalScrollable, true);
    assert.equal(keyboard.modalFits, true);
    assert.equal(keyboard.focused, true);
    assert.ok(keyboard.inputFont >= 16);
    assert.equal(keyboard.noOverflow, true);
    await evaluate(`document.querySelector("#edit-chain-modal").hidden=true;true`);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height,
      screenOrientation: device.orientation
    });
    await sleep(100);
    assert.equal(await evaluate(`innerHeight===${device.height}&&document.documentElement.scrollWidth<=innerWidth`), true);

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.writeFile(`/tmp/growth-mobile-${device.name}.png`, Buffer.from(screenshot.data, "base64"));
  }

  const css = await fs.readFile(path.join(ROOT, "public/styles.css"), "utf8");
  for (const token of ["100dvh", "env(safe-area-inset-top)", "env(safe-area-inset-right)", "env(safe-area-inset-bottom)", "env(safe-area-inset-left)"]) assert.match(css, new RegExp(token.replace(/[()]/g, "\\$&")));
  console.log("Mobile platform checks passed: iPhone SE/15 and Pixel 7 UA, DPR, touch, portrait/landscape, standalone manifest, dynamic viewport, keyboard contraction, safe-area CSS, input zoom prevention, and horizontal overflow.");
} finally {
  cdp?.socket.close();
  chrome.kill("SIGKILL");
  app.kill("SIGTERM");
  if (app.exitCode == null) await new Promise(resolve => app.once("exit", resolve));
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}

if (appErrors) process.stderr.write(appErrors);
