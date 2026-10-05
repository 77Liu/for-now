import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_URL = String(process.env.E2E_APP_URL || "").trim();
const USERNAME = String(process.env.E2E_USERNAME || "").trim();
const PASSWORD = String(process.env.E2E_PASSWORD || "");
const INVITATION = String(process.env.E2E_INVITATION || "");
const DEEPSEEK_API_KEY = String(process.env.E2E_DEEPSEEK_API_KEY || "").trim();
const IMAGE_FILE = process.env.E2E_IMAGE_FILE ? path.resolve(process.env.E2E_IMAGE_FILE) : "";
const AUDIO_FILE = process.env.E2E_AUDIO_FILE ? path.resolve(process.env.E2E_AUDIO_FILE) : "";
const OWN_MARKER = String(process.env.E2E_OWN_MARKER || "").trim();
const FOREIGN_MARKER = String(process.env.E2E_FOREIGN_MARKER || "").trim();
const ALLOW_REMOTE_PREVIEW = process.env.E2E_ALLOW_REMOTE_PREVIEW === "1";
const MODE = process.argv[2] || "verify";
const ARTIFACT_DIR = path.resolve(
  process.env.E2E_ARTIFACT_DIR || path.join(ROOT, "artifacts", "live-user-journeys")
);
const CHROME = resolveHeadlessBrowser();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const appUrl = new URL(APP_URL);
const localTarget = ["127.0.0.1", "localhost"].includes(appUrl.hostname);
const remotePreviewTarget = ALLOW_REMOTE_PREVIEW
  && appUrl.origin === "https://77liu.top"
  && appUrl.pathname === "/preview/"
  && !appUrl.search
  && !appUrl.hash;
assert.ok(localTarget || remotePreviewTarget, "E2E_APP_URL 必须是本机隔离服务或显式允许的线上 Preview");
assert.match(USERNAME, /^[\p{L}\p{N}_.-]{3,32}$/u, "E2E_USERNAME 无效");
assert.ok(PASSWORD.length >= 8, "E2E_PASSWORD 未配置");
assert.ok(["register", "onboarding", "account-isolation", "verify", "cleanup-duplicates", "core-records", "configure-ai", "media-inputs", "media-records", "main-original", "health-ocr-preview", "health-ocr", "ai-answer", "keepsake-inputs", "keepsake", "statistics", "preview-audit"].includes(MODE), `不支持的 live E2E 模式：${MODE}`);
if (MODE === "register") assert.ok(INVITATION.length >= 8, "E2E_INVITATION 未配置");
if (MODE === "account-isolation") {
  assert.ok(OWN_MARKER.length >= 8, "E2E_OWN_MARKER 未配置");
  assert.ok(FOREIGN_MARKER.length >= 8, "E2E_FOREIGN_MARKER 未配置");
}
if (MODE === "configure-ai") assert.ok(DEEPSEEK_API_KEY.length >= 8, "E2E_DEEPSEEK_API_KEY 未配置");
if (["media-inputs", "media-records", "main-original", "health-ocr-preview", "health-ocr", "keepsake-inputs", "keepsake"].includes(MODE)) {
  await fs.access(IMAGE_FILE);
}
if (["media-inputs", "media-records"].includes(MODE)) {
  await fs.access(AUDIO_FILE);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
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
  throw new Error("等待 Chrome 调试端口超时");
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        if (message.method === "Page.javascriptDialogOpening") {
          void this.send("Page.handleJavaScriptDialog", { accept: true });
        }
        return;
      }
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

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-live-e2e-"));
const port = await freePort();
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
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: "ignore" });

let cdp;
try {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  cdp = new Cdp(await pageDebuggerUrl(port));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false
  });

  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  };
  const waitUntil = async (expression, { attempts = 200, delay = 50, label = expression } = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(delay);
    }
    const pageState = await evaluate(`JSON.stringify({
      url:location.href,
      bodyClass:document.body.className,
      authHidden:document.querySelector("#auth-gate")?.hidden,
      authStatus:document.querySelector("#auth-status")?.textContent||"",
      activeView:document.querySelector(".view.active")?.id||"",
      chainStatus:document.querySelector("#chain-status")?.textContent||"",
      chainKind:document.querySelector("#chain-form")?.elements.recordKind?.value||"",
      chainSubmit:{text:document.querySelector("#chain-submit")?.textContent||"",disabled:document.querySelector("#chain-submit")?.disabled},
      activeElement:document.activeElement?.id||document.activeElement?.name||document.activeElement?.tagName||"",
      invalidFields:[...document.querySelectorAll("#chain-form input,#chain-form textarea,#chain-form select")]
        .filter(field=>field.willValidate&&!field.validity.valid)
        .map(field=>({id:field.id,name:field.name,type:field.type,message:field.validationMessage}))
    })`).catch(() => "");
    const runtimeErrors = cdp.events
      .filter(event => event.method === "Runtime.exceptionThrown")
      .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
      .slice(-3);
    throw new Error(`等待界面状态超时：${label}; page=${pageState}; runtime=${JSON.stringify(runtimeErrors)}`);
  };
  const click = async selector => {
    const point = await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element||element.hidden||element.disabled)throw new Error("不可点击："+${JSON.stringify(selector)});
    element.scrollIntoView({block:"center",behavior:"instant"});
    const rect=element.getBoundingClientRect();
    const x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);
    return{x,y,visible:x>=0&&x<=innerWidth&&y>=0&&y<=innerHeight,hit:Boolean(hit&&(hit===element||element.contains(hit))),hitLabel:hit?.id||hit?.className||hit?.tagName||""};
  })()`);
    if (!point.visible || !point.hit) {
      throw new Error(`点击目标被遮挡或不在视口：${selector}; ${JSON.stringify(point)}`);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return true;
  };
  const fill = (selector, value) => evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw new Error("找不到字段："+${JSON.stringify(selector)});
    const descriptor=Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value");
    descriptor.set.call(element,${JSON.stringify(value)});
    element.dispatchEvent(new Event("input",{bubbles:true}));
    element.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);
  const select = (selector, value) => evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!(element instanceof HTMLSelectElement))throw new Error("找不到选项："+${JSON.stringify(selector)});
    const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value");
    descriptor.set.call(element,${JSON.stringify(value)});
    element.dispatchEvent(new Event("input",{bubbles:true}));
    element.dispatchEvent(new Event("change",{bubbles:true}));
    return element.value;
  })()`);
  const setRequestId = (selector, value) => evaluate(`(() => {
    const form=document.querySelector(${JSON.stringify(selector)});
    if(!(form instanceof HTMLFormElement))throw new Error("找不到表单："+${JSON.stringify(selector)});
    form.dataset.requestId=${JSON.stringify(value)};
    return true;
  })()`);
  const includesText = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(value)})===true`);
  const clickWithinText = async (containerSelector, text, targetSelector) => {
    const point = await evaluate(`(() => {
    const container=[...document.querySelectorAll(${JSON.stringify(containerSelector)})].find(item=>item.textContent.includes(${JSON.stringify(text)}));
    const target=container?.querySelector(${JSON.stringify(targetSelector)});
    if(!target||target.disabled)throw new Error("找不到可点击的记录操作");
    target.scrollIntoView({block:"center",behavior:"instant"});
    const rect=target.getBoundingClientRect();
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return true;
  };
  const setFiles = async (selector, files) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `找不到文件输入：${selector}`);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files });
  };
  const waitForResponse = async (fragment, startIndex = 0, status = 200) => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const response = cdp.events.slice(startIndex)
        .filter(event => event.method === "Network.responseReceived")
        .map(event => event.params.response)
        .find(item => item.url.includes(fragment) && item.status === status);
      if (response) return response;
      await sleep(100);
    }
    throw new Error(`等待网络响应超时：${fragment}`);
  };
  const dragAcross = async selector => {
    const rect = await evaluate(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element)throw new Error("找不到画布："+${JSON.stringify(selector)});
      element.scrollIntoView({block:"center",behavior:"instant"});
      const value=element.getBoundingClientRect();
      return{x:value.left,y:value.top,width:value.width,height:value.height};
    })()`);
    const points = [
      [0.2, 0.5],
      [0.35, 0.35],
      [0.5, 0.5],
      [0.65, 0.65],
      [0.8, 0.5]
    ].map(([x, y]) => ({ x: rect.x + rect.width * x, y: rect.y + rect.height * y }));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...points[0] });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...points[0], button: "left", clickCount: 1 });
    for (const point of points.slice(1)) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1 });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...points.at(-1), button: "left", clickCount: 1 });
  };
  const screenshot = async name => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.writeFile(path.join(ARTIFACT_DIR, name), Buffer.from(shot.data, "base64"));
  };
  const navigate = async () => {
    await cdp.send("Page.navigate", { url: APP_URL });
    await waitUntil(`document.readyState==="complete"&&document.documentElement.dataset.runtimeReady==="1"`, {
      label: "应用运行时加载"
    });
  };
  const login = async () => {
    await navigate();
    await waitUntil(`!document.querySelector("#auth-gate").hidden`, { label: "登录页显示" });
    await fill("#login-form input[name=username]", USERNAME);
    await fill("#login-form input[name=password]", PASSWORD);
    await click("#login-form button[type=submit]");
    await waitUntil(`document.querySelector("#auth-gate").hidden
      &&!document.body.classList.contains("auth-locked")
      &&document.querySelector("#login-form button[type=submit]").disabled===false`, {
      label: "登录完成"
    });
    assert.equal(await evaluate(`document.querySelector("#account-name").textContent`), USERNAME);
  };
  const register = async () => {
    await navigate();
    await waitUntil(`!document.querySelector("#auth-gate").hidden`, { label: "注册页显示" });
    await click('[data-auth-tab="register"]');
    await fill("#register-form input[name=username]", USERNAME);
    await fill("#register-form input[name=password]", PASSWORD);
    await fill("#register-form input[name=invitation]", INVITATION);
    await click("#register-form button[type=submit]");
    await waitUntil(`document.querySelector("#auth-gate").hidden
      &&!document.body.classList.contains("auth-locked")
      &&document.querySelector("#register-form button[type=submit]").disabled===false`, {
      label: "注册完成"
    });
    assert.equal(await evaluate(`document.querySelector("#account-name").textContent`), USERNAME);
  };
  const switchView = async view => {
    const section = {
      today: "today",
      daily: "today",
      captures: "seen",
      books: "seen",
      keepsakes: "seen",
      quotes: "seen",
      thoughts: "thought",
      journals: "thought",
      review: "thought",
      mine: "mine",
      statistics: "mine",
      settings: "mine",
      account: "mine"
    }[view];
    if (section) await click(`[data-section="${section}"]`);
    await click(`[data-view="${view}"]`);
    await waitUntil(`document.querySelector("#view-${view}").classList.contains("active")`, {
      label: `打开 ${view}`
    });
  };
  const waitForCaptureSaved = async (marker, label) => {
    await waitUntil(`document.querySelector("#capture-list").textContent.includes(${JSON.stringify(marker)})
      &&document.querySelector("#capture-submit").disabled===false
      &&document.querySelector("#capture-content").value===""
      &&document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===0
      &&document.querySelector("#capture-audio-preview").hidden`, {
      attempts: 600,
      delay: 100,
      label
    });
  };
  const deleteExtras = async ({ selector, countExpression, label }) => {
    let count = Number(await evaluate(countExpression));
    while (count > 1) {
      await click(`${selector}:last-of-type`);
      await waitUntil(`Number(${countExpression})<${count}`, { label: `${label}重复项删除` });
      count = Number(await evaluate(countExpression));
    }
    return count;
  };

  if (MODE === "register") await register();
  else await login();
  const result = {
    mode: MODE,
    appUrl: APP_URL,
    username: USERNAME,
    completedAt: "",
    counts: {}
  };

  if (MODE === "register") {
    result.counts.registered = 1;
    result.onboardingVisible = await evaluate(`!document.querySelector("#onboarding-workspace").hidden`);
    await screenshot("register.png");
  } else if (MODE === "onboarding") {
    if (!await evaluate(`document.querySelector("#onboarding-workspace").hidden`)) {
      if (await evaluate(`Boolean(document.querySelector('[data-onboarding-action="use"]'))`)) {
        await click('[data-onboarding-action="use"]');
      } else {
        for (const selector of [
          'input[name="onboarding-evidence"]',
          'input[name="onboarding-revision"]',
          'input[name="onboarding-truth_harmony"]',
          'input[name="onboarding-autonomy"]',
          'input[name="onboarding-stability"]',
          'input[name="onboarding-achievement"]',
          'input[name="onboarding-control"]',
          'input[name="onboarding-meaning"]'
        ]) await click(selector);
        await click("#onboarding-skip");
        await click("#onboarding-form button[type=submit]");
      }
      await waitUntil(`document.querySelector("#onboarding-workspace").hidden`, { label: "新用户引导完成" });
    }
    result.counts.onboarding = 1;
    await screenshot("onboarding.png");
  } else if (MODE === "account-isolation") {
    await switchView("captures");
    assert.equal(await includesText("#capture-list", FOREIGN_MARKER), false, "看到了其他账户的私密标记");
    if (!await includesText("#capture-list", OWN_MARKER)) {
      await click("#capture-create-toggle");
      await setRequestId("#capture-form", `00000000-0000-4000-8000-${USERNAME.endsWith("02")?"000000000502":"000000000501"}`);
      await fill("#capture-content", OWN_MARKER);
      await click("#capture-submit");
      await waitForCaptureSaved(OWN_MARKER, "账户隔离捕念保存");
    }
    await navigate();
    await waitUntil(`document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`, {
      label: "账户隔离刷新"
    });
    await switchView("captures");
    assert.equal(await includesText("#capture-list", OWN_MARKER), true);
    assert.equal(await includesText("#capture-list", FOREIGN_MARKER), false, "刷新后看到了其他账户的私密标记");
    result.counts.privateMarkers = 1;
    await screenshot("account-isolation.png");
  } else if (MODE === "cleanup-duplicates") {
    await switchView("daily");
    for (const type of ["sleep", "heartRate", "weight", "exercise"]) {
      await click(`[data-daily-tab="${type}"]`);
      await waitUntil(`document.querySelector('[data-daily-tab="${type}"]').getAttribute("aria-selected")==="true"`, {
        label: `切换日录 ${type}`
      });
      result.counts[type] = await deleteExtras({
        selector: "#daily-record-list [data-daily-delete]",
        countExpression: `document.querySelectorAll("#daily-record-list [data-daily-delete]").length`,
        label: type
      });
    }
    await switchView("review");
    result.counts.checkins = await deleteExtras({
      selector: "#checkin-history [data-delete-checkin]",
      countExpression: `document.querySelectorAll("#checkin-history [data-delete-checkin]").length`,
      label: "状态"
    });
  } else if (MODE === "configure-ai") {
    await switchView("settings");
    await fill("#llm-api-key", DEEPSEEK_API_KEY);
    await select("#llm-test-tier", "lite");
    await click("#test-llm");
    await waitUntil(`document.querySelector("#llm-settings-status").textContent.includes("连接成功")`, {
      attempts: 600,
      delay: 100,
      label: "DeepSeek 连接测试"
    });
    assert.equal(await evaluate(`document.querySelector("#llm-key-state").textContent`), "密钥已配置");
    result.counts.connectionTests = 1;
    result.connectionStatus = await evaluate(`document.querySelector("#llm-settings-status").textContent`);
    await screenshot("configure-ai.png");
  } else if (MODE === "preview-audit") {
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
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
    const auditStart = cdp.events.length;
    const auditUrl = new URL("today?native-performance=1&budget-profile=public-preview", APP_URL).href;
    await cdp.send("Page.navigate", { url: auditUrl });
    await waitUntil(`document.querySelector("#startup-performance-metric")?.textContent.startsWith("启动分段 ")
      &&document.documentElement.dataset.runtimeReady==="1"
      &&document.querySelector("#auth-gate").hidden`, {
      attempts: 400,
      delay: 25,
      label: "线上 Preview 稳定首屏"
    });
    await sleep(100);
    result.performance = await evaluate(`(() => {
      const navigation=performance.getEntriesByType("navigation")[0];
      const metric=document.querySelector("#startup-performance-metric").textContent.replace(/^启动分段 /,"");
      const startup=JSON.parse(metric);
      return {
        profile:"public-network",
        dclMs:Number(navigation.domContentLoadedEventEnd.toFixed(1)),
        currentScreenFeedbackMs:window.__currentScreenFeedback,
        visibleShellMs:startup.marks.visibleShell,
        stableHomeMs:startup.marks.stableHome,
        marks:startup.marks,
        segments:startup.segments,
        domNodes:document.getElementsByTagName("*").length
      };
    })()`);
    const auditEvents = cdp.events.slice(auditStart);
    const requests = new Map(auditEvents
      .filter(event => event.method === "Network.requestWillBeSent")
      .map(event => [event.params.requestId, event.params.request.url]));
    const responses = new Map(auditEvents
      .filter(event => event.method === "Network.responseReceived" && event.params.response.url.startsWith(APP_URL))
      .map(event => [event.params.requestId, {
        url: event.params.response.url,
        status: event.params.response.status,
        transferBytes: 0
      }]));
    for (const event of auditEvents.filter(event => event.method === "Network.loadingFinished")) {
      if (responses.has(event.params.requestId)) responses.get(event.params.requestId).transferBytes = Math.round(event.params.encodedDataLength);
    }
    const expectedFailures = new Set(["/preview/api/local-test-mode:404"]);
    result.network = {
      resources: [...responses.values()].filter(item => item.transferBytes > 0).length,
      transferBytes: [...responses.values()].reduce((total, item) => total + item.transferBytes, 0),
      unexpectedResponses: [...responses.values()]
        .filter(item => item.status >= 400)
        .map(item => `${new URL(item.url).pathname}:${item.status}`)
        .filter(item => !expectedFailures.has(item)),
      failedRequests: auditEvents
        .filter(event => event.method === "Network.loadingFailed")
        .filter(event => requests.has(event.params.requestId))
        .map(event => ({ url: requests.get(event.params.requestId), error: event.params.errorText }))
        .filter(item => !(new URL(item.url).pathname === "/preview/api/local-test-mode" && item.error === "net::ERR_ABORTED"))
        .map(item => `${item.url} ${item.error}`)
    };
    result.consoleErrors = auditEvents
      .filter(event => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      .map(event => event.params.args.map(argument => argument.value || argument.description || "").join(" "));
    await screenshot("preview-audit-desktop.png");
    result.responsive = {};
    for (const [width, height] of [[390, 844], [320, 700]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: true
      });
      await sleep(150);
      result.responsive[width] = await evaluate(`({
        viewport:window.innerWidth,
        scrollWidth:document.documentElement.scrollWidth,
        overflow:document.documentElement.scrollWidth>window.innerWidth
      })`);
      assert.equal(result.responsive[width].overflow, false, `${width}px 出现横向溢出`);
      await screenshot(`preview-audit-${width}.png`);
    }
    result.auditCompletedAt = new Date().toISOString();
    await fs.writeFile(path.join(ARTIFACT_DIR, "preview-audit.json"), `${JSON.stringify(result, null, 2)}\n`);
    assert.ok(result.performance.currentScreenFeedbackMs < 500, `线上 Preview 当前屏反馈 ${result.performance.currentScreenFeedbackMs}ms 未低于 500ms`);
    assert.ok(result.performance.stableHomeMs < 1000, `线上 Preview stableHome ${result.performance.stableHomeMs}ms 未低于 1000ms`);
    assert.deepEqual(result.network.unexpectedResponses, []);
    assert.deepEqual(result.network.failedRequests, []);
    assert.deepEqual(result.consoleErrors, []);
  } else if (MODE === "main-original") {
    const marker = "E2E-20261001 主账号授权原图";
    await switchView("captures");
    if (!await includesText("#capture-list", marker)) {
      await click("#capture-create-toggle");
      await setFiles("#capture-images", [IMAGE_FILE]);
      await waitUntil(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===1`, {
        label: "主账号原图预览"
      });
      await setRequestId("#capture-form", "00000000-0000-4000-8000-000000000601");
      await fill("#capture-content", `${marker}：通过只读生产附件抽样，所有后续写入仅发生在隔离测试账号。`);
      await click("#capture-submit");
      await waitForCaptureSaved(marker, "主账号原图捕念保存");
    }
    const understood = await evaluate(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(marker)})&&card.querySelector(".content-understanding")
    )`);
    if (!understood) {
      await clickWithinText("[data-capture-id]", marker, "[data-content-image-understand]");
      await waitUntil(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
        card.textContent.includes(${JSON.stringify(marker)})&&card.querySelector(".content-understanding")
      )`, { attempts: 1800, delay: 100, label: "主账号原图理解完成" });
    }
    result.counts.mainOriginals = 1;
    result.understandingPreview = await evaluate(`(() => {
      const card=[...document.querySelectorAll("[data-capture-id]")].find(item=>item.textContent.includes(${JSON.stringify(marker)}));
      return card?.querySelector(".content-understanding")?.textContent.trim().slice(0,180)||"";
    })()`);
    assert.ok(result.understandingPreview.length > 20);
    await screenshot("main-original.png");
  } else if (MODE === "statistics") {
    await switchView("statistics");
    await waitUntil(`document.querySelectorAll("#ai-service-summary tbody tr").length>=4`, {
      label: "多供应商统计加载"
    });
    result.services = await evaluate(`[...document.querySelectorAll("#ai-service-summary tbody tr")].map(row=>({
      name:row.cells[0].textContent.trim(),
      calls:Number(row.cells[1].textContent)||0,
      result:row.cells[2].textContent.trim(),
      units:row.cells[3].textContent.trim(),
      billing:row.cells[5].textContent.trim()
    }))`);
    result.modalities = await evaluate(`[...document.querySelectorAll("#ai-modality-summary tbody tr")].map(row=>({
      name:row.cells[0].textContent.trim(),
      calls:Number(row.cells[1].textContent)||0
    }))`);
    assert.deepEqual(result.services.map(item=>item.name), [
      "DeepSeek 模型",
      "豆包语音",
      "火山视觉",
      "阿里云图片分割"
    ]);
    assert.ok(result.modalities.some(item=>item.name==="语音"&&item.calls>0));
    assert.ok(result.modalities.some(item=>item.name==="图片理解"&&item.calls>0));
    await screenshot("statistics-desktop.png");
    await evaluate(`document.querySelector("#ai-service-summary").scrollIntoView({block:"center",behavior:"instant"});true`);
    await screenshot("statistics-services-desktop.png");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(150);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`), true);
    await evaluate(`document.querySelector("#ai-service-summary").scrollIntoView({block:"start",behavior:"instant"});true`);
    await screenshot("statistics-services-mobile.png");
  } else if (MODE === "keepsake-inputs") {
    await switchView("keepsakes");
    if (await evaluate(`document.querySelector("#keepsake-workspace").hidden`)) await click("#keepsake-create-toggle");
    await setFiles("#keepsake-image", [IMAGE_FILE]);
    await waitUntil(`!document.querySelector("#keepsake-editor").hidden&&document.querySelector("#keepsake-mask-canvas").width>0`, {
      attempts: 600,
      delay: 100,
      label: "小物输入预览"
    });
    await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("自动轮廓已生成")
      ||document.querySelector("#keepsake-segment-status").textContent.includes("自动提取未完成")`, {
      attempts: 900,
      delay: 100,
      label: "小物自动分割结果"
    });
    result.segmentationStatus = await evaluate(`document.querySelector("#keepsake-segment-status").textContent`);
    assert.match(result.segmentationStatus, /自动轮廓已生成/, "小物自动分割未成功");
    result.counts.keepsakeDrafts = await evaluate(`document.querySelectorAll(".keepsake-batch-item").length`);
    await screenshot("keepsake-inputs.png");
  } else if (MODE === "keepsake") {
    const marker = "E2E-20261001 手工轮廓小物";
    await switchView("keepsakes");
    if (!await includesText("#keepsake-grid", marker)) {
      if (await evaluate(`document.querySelector("#keepsake-workspace").hidden`)) await click("#keepsake-create-toggle");
      await setFiles("#keepsake-image", [IMAGE_FILE]);
      await waitUntil(`!document.querySelector("#keepsake-editor").hidden&&document.querySelector("#keepsake-mask-canvas").width>0`, {
        attempts: 600,
        delay: 100,
        label: "小物图片进入编辑器"
      });
      await dragAcross("#keepsake-mask-canvas");
      await fill("#keepsake-title", marker);
      await select("#keepsake-category", "纸品");
      await fill("#keepsake-tags", "端到端 手工轮廓");
      await fill("#keepsake-note", "自动分割不可用时，仍能使用保留笔刷完成数字留存。");
      await click("#keepsake-save");
      await waitUntil(`document.querySelector("#keepsake-grid").textContent.includes(${JSON.stringify(marker)})`, {
        attempts: 1200,
        delay: 100,
        label: "小物保存"
      });
    }
    result.counts.keepsakes = await evaluate(`document.querySelectorAll("#keepsake-grid [data-keepsake-id]").length`);
    await navigate();
    await waitUntil(`document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`, {
      label: "小物刷新后会话"
    });
    await switchView("keepsakes");
    assert.equal(await includesText("#keepsake-grid", marker), true);
    await screenshot("keepsake.png");
  } else if (MODE === "ai-answer") {
    const marker = "E2E-20261001 AI回答";
    await switchView("thoughts");
    if (!await includesText("#all-thoughts", marker)) {
      await switchView("today");
      await click("#home-open-thought");
      await waitUntil(`!document.querySelector("#home-thought-editor").hidden`, { label: "打开 AI 思考编辑器" });
      await setRequestId("#chain-form", "00000000-0000-4000-8000-000000000401");
      await fill("#chain-question", `${marker}：当记录系统发现我连续两天睡眠不足时，怎样给出一个不说教、可执行、可复盘的建议？`);
      await fill("#chain-idea", "建议应区分事实、推断和下一步行动，并保留由我确认的空间。");
      await click("#chain-submit");
      await waitUntil(`document.querySelector("#home-thought-editor").hidden`, { label: "AI 问题保存" });
      await switchView("thoughts");
    }
    await waitUntil(`document.querySelector("#all-thoughts").textContent.includes(${JSON.stringify(marker)})`, {
      label: "AI 问题显示"
    });
    const answered = await evaluate(`[...document.querySelectorAll("#all-thoughts [data-chain-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(marker)})&&card.querySelector(".thought-content-block.ai")
    )`);
    if (!answered) {
      await evaluate(`(() => {
        const card=[...document.querySelectorAll("#all-thoughts [data-chain-id]")].find(item=>item.textContent.includes(${JSON.stringify(marker)}));
        if(!card)throw new Error("找不到 AI 问题");
        card.open=true;
        return true;
      })()`);
      await waitUntil(`[...document.querySelectorAll("#all-thoughts [data-chain-id]")].some(card=>
        card.textContent.includes(${JSON.stringify(marker)})&&card.open
      )`, { label: "展开 AI 问题" });
      await clickWithinText("#all-thoughts [data-chain-id]", marker, "[data-answer-chain]");
      await waitUntil(`[...document.querySelectorAll("#all-thoughts [data-chain-id]")].some(card=>
        card.textContent.includes(${JSON.stringify(marker)})&&card.querySelector(".thought-content-block.ai")
      )`, { attempts: 1800, delay: 100, label: "AI 回答写入思绪" });
    }
    if (!await evaluate(`document.querySelector("#ai-answer-modal").hidden`)) await click("#ai-answer-close");
    await navigate();
    await waitUntil(`document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`, {
      label: "AI 回答刷新后会话"
    });
    await switchView("thoughts");
    assert.equal(await evaluate(`[...document.querySelectorAll("#all-thoughts [data-chain-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(marker)})&&card.querySelector(".thought-content-block.ai")
    )`), true);
    result.counts.aiAnswers = 1;
    result.aiAnswerPreview = await evaluate(`(() => {
      const card=[...document.querySelectorAll("#all-thoughts [data-chain-id]")].find(item=>item.textContent.includes(${JSON.stringify(marker)}));
      return card?.querySelector(".thought-content-block.ai .thought-block-content")?.textContent.trim().slice(0,160)||"";
    })()`);
    assert.ok(result.aiAnswerPreview.length > 20);
    await screenshot("ai-answer.png");
  } else if (MODE === "health-ocr-preview") {
    await switchView("daily");
    await click('[data-daily-tab="sleep"]');
    await setFiles("#health-images", [IMAGE_FILE]);
    await waitUntil(`document.querySelectorAll("#health-image-previews figure").length===1`, { label: "主账号健康原图预览" });
    const responseStart = cdp.events.length;
    await click("#parse-health-images");
    await waitForResponse("/api/images/parse", responseStart);
    await waitUntil(`document.querySelector("#health-parse-status").textContent&&!document.querySelector("#health-parse-status").textContent.includes("正在")`, {
      attempts: 1200,
      delay: 100,
      label: "主账号健康原图识别"
    });
    result.recognized = await evaluate(`(() => {
      const form=document.querySelector('[data-daily-form="sleep"]');
      return {
        bedtime:form.elements.bedtime.value,
        wakeTime:form.elements.wakeTime.value,
        totalMinutes:form.elements.totalMinutes.value,
        deepMinutes:form.elements.deepMinutes.value,
        lightMinutes:form.elements.lightMinutes.value,
        remMinutes:form.elements.remMinutes.value,
        status:document.querySelector("#health-parse-status").textContent
      };
    })()`);
    assert.ok(Object.values(result.recognized).some(value => String(value).length > 0));
    result.counts.previewOnly = 1;
    await screenshot("health-ocr-main-original.png");
  } else if (MODE === "health-ocr") {
    await switchView("daily");
    await fill("#active-date", "2026-09-30");
    await waitUntil(`document.querySelector("#active-date").value==="2026-09-30"`, { label: "切换健康记录日期" });
    await click('[data-daily-tab="sleep"]');
    await setFiles("#health-images", [IMAGE_FILE]);
    await waitUntil(`document.querySelectorAll("#health-image-previews figure").length===1`, { label: "健康截图预览" });
    const responseStart = cdp.events.length;
    await click("#parse-health-images");
    await waitForResponse("/api/images/parse", responseStart);
    await waitUntil(`document.querySelector("#health-parse-status").textContent&&!document.querySelector("#health-parse-status").textContent.includes("正在")`, {
      attempts: 1200,
      delay: 100,
      label: "健康截图识别回填"
    });
    const recognized = await evaluate(`(() => {
      const form=document.querySelector('[data-daily-form="sleep"]');
      return {
        totalMinutes:form.elements.totalMinutes.value,
        deepMinutes:form.elements.deepMinutes.value,
        lightMinutes:form.elements.lightMinutes.value,
        remMinutes:form.elements.remMinutes.value,
        averageHeartRate:form.elements.averageHeartRate.value,
        averageOxygen:form.elements.averageOxygen.value,
        status:document.querySelector("#health-parse-status").textContent
      };
    })()`);
    assert.ok(Number(recognized.totalMinutes) > 0, "OCR 未回填总睡眠");
    await setRequestId('[data-daily-form="sleep"]', "00000000-0000-4000-8000-000000000301");
    await click('[data-daily-form="sleep"] button[type=submit]');
    await waitUntil(`document.querySelector("#daily-history-count").textContent==="2 条"`, { label: "截图健康记录保存" });
    result.counts.sleepRecords = 2;
    result.recognized = recognized;
    await screenshot("health-ocr.png");
  } else if (MODE === "media-inputs") {
    await switchView("captures");
    await click("#capture-create-toggle");
    await setFiles("#capture-images", [IMAGE_FILE]);
    await waitUntil(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===1`, {
      label: "图片输入预览"
    });
    await click('[data-content-image-editor="capture"] [data-content-image-remove="0"]');
    await waitUntil(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===0`, {
      label: "图片输入移除"
    });
    await setFiles("#capture-audio-file", [AUDIO_FILE]);
    await waitUntil(`!document.querySelector("#capture-audio-preview").hidden`, { label: "音频输入预览" });
    await click("#capture-audio-remove");
    await waitUntil(`document.querySelector("#capture-audio-preview").hidden`, { label: "音频输入移除" });
    result.counts = { imageDrafts: 0, audioDrafts: 0 };
    await screenshot("media-inputs.png");
  } else if (MODE === "media-records") {
    const imageMarker = "E2E-20261001 图片原件";
    const audioMarker = "E2E-20261001 语音原件";
    await switchView("captures");

    if (!await includesText("#capture-list", imageMarker)) {
      await click("#capture-create-toggle");
      await setFiles("#capture-images", [IMAGE_FILE]);
      await waitUntil(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===1`, {
        label: "图片预览"
      });
      await setRequestId("#capture-form", "00000000-0000-4000-8000-000000000201");
      await fill("#capture-content", `${imageMarker}：检查上传、原图查看、派生理解和刷新持久化。`);
      await click("#capture-submit");
      await waitForCaptureSaved(imageMarker, "图文捕念保存");
    }

    if (!await includesText("#capture-list", audioMarker)) {
      if (await evaluate(`document.querySelector("#capture-editor").hidden`)) await click("#capture-create-toggle");
      await setFiles("#capture-audio-file", [AUDIO_FILE]);
      await waitUntil(`!document.querySelector("#capture-audio-preview").hidden`, { label: "音频预览" });
      await setRequestId("#capture-form", "00000000-0000-4000-8000-000000000202");
      await fill("#capture-content", `${audioMarker}：上传优先，原件、转写和整理稿分层保存。`);
      await click("#capture-submit");
      await waitForCaptureSaved(audioMarker, "语音捕念保存");
    }

    const understandingExists = await evaluate(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(imageMarker)})&&card.querySelector(".content-understanding")
    )`);
    if (!understandingExists) {
      await clickWithinText("[data-capture-id]", imageMarker, "[data-content-image-understand]");
      await waitUntil(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
        card.textContent.includes(${JSON.stringify(imageMarker)})&&card.querySelector(".content-understanding")
      )`, { attempts: 1800, delay: 100, label: "图片理解完成" });
    }

    await waitUntil(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(audioMarker)})&&card.querySelector(".capture-transcription")
    )`, { attempts: 1800, delay: 100, label: "语音转写完成" });

    const responseStart = cdp.events.length;
    await clickWithinText("[data-capture-id]", imageMarker, "[data-speech-synthesize]");
    const ttsResponse = await waitForResponse("/api/speech/synthesize", responseStart);
    await waitUntil(`[...document.querySelectorAll("[data-capture-id]")].some(card=>
      card.textContent.includes(${JSON.stringify(imageMarker)})&&card.querySelector('[data-speech-player][src*="/api/speech/audio?"]')
    )`, { attempts: 120, delay: 100, label: "持久语音资产刷新" });
    result.thirdParty = {
      imageUnderstanding: "completed",
      asr: "completed",
      ttsStatus: ttsResponse.status
    };
    result.counts.imageCaptures = await evaluate(`[...document.querySelectorAll("[data-capture-id]")].filter(card=>
      card.textContent.includes(${JSON.stringify(imageMarker)})
    ).length`);
    result.counts.audioCaptures = await evaluate(`[...document.querySelectorAll("[data-capture-id]")].filter(card=>
      card.textContent.includes(${JSON.stringify(audioMarker)})
    ).length`);
    await screenshot("media-records.png");
  } else if (MODE === "core-records") {
    const marker = "E2E-20261001";

    await switchView("captures");
    if (!await includesText("#capture-list", marker)) {
      await click("#capture-create-toggle");
      await setRequestId("#capture-form", "00000000-0000-4000-8000-000000000101");
      await fill("#capture-content", `${marker} 捕念：午后切换任务时注意力下降，先留下事实，再决定是否调整。`);
      await fill("#capture-tags", "端到端 可追溯");
      await click("#capture-submit");
      await waitForCaptureSaved(marker, "捕念保存");
    }
    result.counts.captures = await evaluate(`document.querySelectorAll("#capture-list [data-capture-id]").length`);
    await screenshot("core-capture.png");

    await switchView("journals");
    if (!await includesText("#journal-list", marker)) {
      await setRequestId("#journal-form", "00000000-0000-4000-8000-000000000102");
      await fill("#journal-title", `${marker} 一次完整使用`);
      await fill("#journal-content", "今天从注册、状态、健康记录到思考都走了一遍。事实是流程可以完成；需要继续观察的是异常恢复、移动端输入和第三方服务的反馈是否足够清楚。");
      await fill("#journal-tags", "端到端 复盘");
      await click("#journal-submit");
      await waitUntil(`document.querySelector("#journal-list").textContent.includes(${JSON.stringify(marker)})`, {
        label: "日记保存"
      });
    }
    result.counts.journals = await evaluate(`document.querySelectorAll("#journal-list [data-journal-id]").length`);

    await switchView("thoughts");
    const thoughtExists = await includesText("#all-thoughts", `${marker} 问题`);
    await switchView("today");
    if (!thoughtExists) {
      await click("#home-open-thought");
      await waitUntil(`!document.querySelector("#home-thought-editor").hidden`, { label: "打开思考编辑器" });
      await setRequestId("#chain-form", crypto.randomUUID());
      await fill("#chain-question", `${marker} 问题：怎样让记录系统在失败后仍然容易继续？`);
      await fill("#chain-idea", "先保证草稿、附件和提交状态彼此独立，再给出明确重试入口。");
      await fill("#chain-answer", "保留原始输入，显示当前状态，失败时不清空；重试必须幂等，并让用户知道结果是否已经保存。");
      await fill("#chain-tags", "端到端 恢复");
      await fill("#chain-datetime", "2026-10-01T20:20:00");
      await click("#chain-submit");
      await waitUntil(`document.querySelector("#home-thought-editor").hidden`, { label: "思考保存" });
    }
    await switchView("thoughts");
    await waitUntil(`document.querySelector("#all-thoughts").textContent.includes(${JSON.stringify(marker)})`, {
      label: "思考刷新验证"
    });
    result.counts.thoughts = await evaluate(`document.querySelectorAll("#all-thoughts [data-chain-id]").length`);
    await screenshot("core-thought.png");

    await switchView("books");
    if (!await includesText("#book-grid", marker)) {
      await setRequestId("#book-form", "00000000-0000-4000-8000-000000000104");
      await fill("#book-title", `${marker} 可用性记录`);
      await fill("#book-author", "测试用户");
      await fill("#book-publisher", "此刻测试");
      await fill("#book-reading-start", "2026-10-01");
      await fill("#book-description", "用书目与笔记链路验证内容创建、刷新持久化和详情回访。");
      await click("#book-submit");
      await waitUntil(`document.querySelector("#book-grid").textContent.includes(${JSON.stringify(marker)})`, {
        label: "书目保存"
      });
    }
    result.counts.books = await evaluate(`document.querySelectorAll("#book-grid [data-open-book]").length`);

    await switchView("quotes");
    if (!await includesText("#quote-timeline", marker)) {
      await setRequestId("#quote-form", "00000000-0000-4000-8000-000000000105");
      await fill("#quote-source", "端到端测试记录");
      await fill("#quote-content", `${marker} 失败可解释，输入不丢失，用户才能继续。`);
      await fill("#quote-tags", "可用性 恢复");
      await click("#quote-submit");
      await waitUntil(`document.querySelector("#quote-timeline").textContent.includes(${JSON.stringify(marker)})`, {
        label: "善言保存"
      });
    }
    result.counts.quotes = await evaluate(`document.querySelectorAll("#quote-timeline [data-quote-id]").length`);

    await switchView("today");
    if (!await includesText("#action-columns", marker) || !await includesText("#habit-list", marker)) {
      const open = await evaluate(`document.querySelector(".home-v02-secondary").open`);
      if (!open) await click(".home-v02-secondary summary");
    }
    if (!await includesText("#action-columns", marker)) {
      await setRequestId("#action-form", "00000000-0000-4000-8000-000000000106");
      await fill("#action-form input[name=title]", `${marker} 完成移动端复验`);
      await select("#action-form select[name=priority]", "P1");
      await click("#action-form button[type=submit]");
      await waitUntil(`document.querySelector("#action-columns").textContent.includes(${JSON.stringify(marker)})`, {
        label: "行动保存"
      });
    }
    if (!await includesText("#habit-list", marker)) {
      await setRequestId("#habit-form", "00000000-0000-4000-8000-000000000107");
      await fill("#habit-form input[name=title]", `${marker} 睡前回顾`);
      await select("#habit-form select[name=cadence]", "daily");
      await click("#habit-form button[type=submit]");
      await waitUntil(`document.querySelector("#habit-list").textContent.includes(${JSON.stringify(marker)})`, {
        label: "习惯保存"
      });
    }
    result.counts.actions = await evaluate(`document.querySelectorAll("#action-columns .action-entry").length`);
    result.counts.habits = await evaluate(`document.querySelectorAll("#habit-list .habit-entry").length`);
    await screenshot("core-actions.png");

    await navigate();
    await waitUntil(`document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`, {
      label: "刷新后恢复会话"
    });
    for (const [view, selector] of [
      ["captures", "#capture-list"],
      ["journals", "#journal-list"],
      ["thoughts", "#all-thoughts"],
      ["books", "#book-grid"],
      ["quotes", "#quote-timeline"]
    ]) {
      await switchView(view);
      assert.equal(await includesText(selector, marker), true, `${view} 刷新后缺少本轮记录`);
    }
    await switchView("today");
    const secondaryOpen = await evaluate(`document.querySelector(".home-v02-secondary").open`);
    if (!secondaryOpen) await click(".home-v02-secondary summary");
    await waitUntil(`document.querySelector("#action-columns")?.textContent.includes(${JSON.stringify(marker)})===true`, {
      label: "行动刷新后恢复"
    });
    await waitUntil(`document.querySelector("#habit-list")?.textContent.includes(${JSON.stringify(marker)})===true`, {
      label: "习惯刷新后恢复"
    });
  } else {
    result.counts = await evaluate(`({
      captures:document.querySelector("#capture-count")?.textContent||"",
      currentView:document.querySelector(".view.active")?.id||"",
      onboardingHidden:document.querySelector("#onboarding-workspace").hidden
    })`);
  }

  await screenshot(`${MODE}.png`);
  result.completedAt = new Date().toISOString();
  result.runtimeExceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  assert.deepEqual(result.runtimeExceptions, []);
  await fs.writeFile(path.join(ARTIFACT_DIR, `${MODE}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  cdp?.socket.close();
  chrome.kill("SIGKILL");
  await fs.rm(profile, { recursive: true, force: true });
}
