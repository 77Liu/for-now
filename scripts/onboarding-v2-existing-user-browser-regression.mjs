import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";
import { defaultOnboarding, normalizeOnboarding } from "../src/modules/onboarding/index.mjs";
import { defaultOnboardingV2, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = resolveHeadlessBrowser();
const PASSWORD = "synthetic-account-password-1";
const INVITATION = "synthetic-invitation-for-existing-user";
const MARKERS = { a: "synthetic-history-account-a", b: "synthetic-history-account-b" };
const ANSWER = "我正在用隔离浏览器验证补答；这段原文只属于账户 A。";
const CLAIM_STATEMENT = "我正在用隔离浏览器验证补答；这段原文只属于账户 A。";
const OLD_PROFILE_MARKER = "synthetic_a 的既有资料";
const OLD_UNDERSTANDING_MARKER = "既有初始理解：synthetic_a";
const EXPECTED_PERMITTED_SOURCES = {
  currentContext: ANSWER,
  desiredChanges: "希望建立稳定的写作节奏。",
  recentObstacles: "最近需要处理隔离测试中的合成问题。",
  dailyRhythm: "工作日安排相对紧凑。",
  collaboration: "补充边界：请先说明关键判断，再给一个可执行步骤。"
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`隔离应用提前退出，exit=${child.exitCode}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("等待隔离应用启动超时");
}

async function jsonRequest(url, { cookie, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { text }; }
  return { response, value };
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
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-existing-onboarding-e2e-"));
const artifactDir = process.env.E2E_ARTIFACT_DIR
  ? path.resolve(process.env.E2E_ARTIFACT_DIR)
  : path.join(ROOT, "artifacts", "user-journeys", "existing-user-core-model");
await fs.mkdir(artifactDir, { recursive: true });
const port = await freePort();
const providerPort = await freePort();
let providerCalls = 0;
let providerError = "";
const providerMessageSequence = [];
const provider = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/chat/completions");
    assert.ok(Array.isArray(input.messages), "provider request must include a messages array");
    providerMessageSequence.push(structuredClone(input.messages));
    const serializedMessages = JSON.stringify(input.messages);
    for (const marker of [MARKERS.a, MARKERS.b, OLD_PROFILE_MARKER, OLD_UNDERSTANDING_MARKER]) {
      assert.ok(!serializedMessages.includes(marker), `provider messages must exclude seeded history/profile marker ${marker}`);
    }
    const prompt = input.messages.map(message => message.content).find(value => typeof value === "string" && value.includes("<permitted_sources>"));
    assert.ok(prompt, "local provider only accepts onboarding claim extraction prompts");
    const sourcesMatch = /<permitted_sources>\s*(\[[\s\S]*?\])\s*<\/permitted_sources>/.exec(prompt);
    assert.ok(sourcesMatch, "extraction prompt must contain its permitted synthetic source list");
    const sources = JSON.parse(sourcesMatch[1]);
    assert.equal(sources.length, Object.keys(EXPECTED_PERMITTED_SOURCES).length);
    assert.deepEqual(
      Object.fromEntries(sources.map(source => [source.id, source.text])),
      EXPECTED_PERMITTED_SOURCES,
      "provider source IDs and full texts must exactly match the five permitted synthetic answers"
    );
    const permittedAnswer = sources.find(source => source.id === "currentContext");
    providerCalls += 1;
    const content = JSON.stringify({
      claims: [{
        domain: "context",
        statement: CLAIM_STATEMENT,
        epistemic: "known",
        evidenceStrength: "self_report",
        evidence: [{ sourceId: permittedAnswer.id, span: [0, permittedAnswer.text.length] }]
      }],
      unknowns: []
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "synthetic-local-provider-response",
      model: "synthetic-local-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  } catch (error) {
    providerError = error.stack || error.message;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve, reject) => provider.once("error", reject).listen(providerPort, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
const appUrl = `${base}/app/`;
const invitationHash = crypto.createHash("sha256").update(INVITATION).digest("hex");
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    AUTH_REQUIRED: "1",
    INVITE_CODE_HASH: invitationHash,
    DATA_DIR: dataDir,
    PORT: String(port),
    APP_BASE_PATH: "/app",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    UPSTREAM_ORIGIN: "",
    DEEPSEEK_API_URL: `http://127.0.0.1:${providerPort}/chat/completions`,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    COOKIE_SECURE: "0"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let appErrors = "";
child.stderr.on("data", chunk => { appErrors += chunk.toString("utf8"); });
let chrome;
let cdp;
let chromeProfileDir = "";

try {
  await waitForServer(base, child);

  const createAccount = async username => {
    const registered = await jsonRequest(`${base}/app/api/auth/register`, {
      method: "POST",
      body: { username, password: PASSWORD, invitation: INVITATION }
    });
    assert.equal(registered.response.status, 201, JSON.stringify(registered.value));
    const cookie = registered.response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "注册账户必须获得测试会话");
    return { id: registered.value.user.id, username, cookie };
  };
  const accountA = await createAccount("synthetic_a");
  const accountB = await createAccount("synthetic_b");

  const seedAccount = async (account, marker) => {
    const storePath = path.join(dataDir, "users", account.id, "store.json");
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));
    store.captures.push({
      id: `fixture-${account.username}`,
      content: marker,
      tags: ["隔离测试"],
      occurredAt: "2026-10-10T08:00:00.000Z",
      occurredOn: "2026-10-10"
    });
    store.onboarding = normalizeOnboarding({
      ...defaultOnboarding,
      status: "completed",
      questionnaireMode: "quick",
      answers: { evidence: "evidence" },
      profile: { ...defaultOnboarding.profile, introduction: `${account.username} 的既有资料` },
      understanding: `既有初始理解：${account.username}`,
      updatedAt: "2026-10-09T08:00:00.000Z"
    });
    store.onboardingV2 = normalizeOnboardingV2({
      ...structuredClone(defaultOnboardingV2),
      migration: { selectedFlow: "undecided" }
    }, store.onboarding);
    await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, { mode: 0o600 });
    return storePath;
  };
  const storeAPath = await seedAccount(accountA, MARKERS.a);
  const storeBPath = await seedAccount(accountB, MARKERS.b);

  const initialA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.equal(initialA.response.status, 200);
  assert.equal(initialA.value.data.migration.entryPolicy, "already_onboarded");
  assert.equal(initialA.value.data.session.status, "skipped");
  const initialModelA = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountA.cookie });
  const initialHistoryA = await jsonRequest(`${base}/app/api/state`, { cookie: accountA.cookie });
  assert.ok(initialHistoryA.value.captures.some(item => item.content === MARKERS.a));

  const browserPort = await freePort();
  chromeProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-existing-onboarding-chrome-"));
  chrome = spawn(CHROME, [
    "--headless=new", "--disable-background-networking", "--disable-breakpad",
    "--disable-component-update", "--disable-crash-reporter", "--disable-default-apps",
    "--disable-gpu", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--password-store=basic", "--use-mock-keychain", `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${chromeProfileDir}`, "about:blank"
  ], { stdio: "ignore" });
  let debuggerUrl = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
      debuggerUrl = pages.find(item => item.type === "page")?.webSocketDebuggerUrl || "";
      if (debuggerUrl) break;
    } catch {}
    await sleep(50);
  }
  assert.ok(debuggerUrl, "Chrome DevTools 页面应启动");
  cdp = new Cdp(debuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  const evaluate = async expression => {
    const result = await cdp.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  const waitUntil = async (expression, label, attempts = 180) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`等待浏览器状态超时：${label}; ${await evaluate(`JSON.stringify({url:location.href,authHidden:document.querySelector('#auth-gate')?.hidden,authStatus:document.querySelector('#auth-status')?.textContent,activeView:document.querySelector('.view.active')?.id,panelHidden:document.querySelector('#onboarding-workspace')?.hidden,step:document.querySelector('#onboarding-v2-content')?.textContent.slice(0,180)})`)}`);
  };
  const click = async selector => {
    const point = await evaluate(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element||element.hidden||element.disabled)throw new Error('不可点击：'+${JSON.stringify(selector)});
      element.scrollIntoView({block:'center',behavior:'instant'});
      const rect=element.getBoundingClientRect();
      const x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);
      return{x,y,hit:Boolean(hit&&(hit===element||element.contains(hit))),hitLabel:hit?.id||hit?.className||hit?.tagName||''};
    })()`);
    if (!point.hit) {
      const state = await evaluate(`JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e?.getBoundingClientRect();return{active:[...document.querySelectorAll('.view.active')].map(x=>x.id),hidden:e?.hidden,display:e&&getComputedStyle(e).display,visibility:e&&getComputedStyle(e).visibility,rect:r&&{x:r.x,y:r.y,w:r.width,h:r.height},parent:e?.parentElement?.outerHTML.slice(0,500)}})())`);
      throw new Error(`点击目标被遮挡：${selector} ${JSON.stringify(point)} state=${state}`);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const waitForResponse = async (fragment, startIndex, method) => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const requests = new Map(cdp.events.slice(startIndex)
        .filter(event => event.method === "Network.requestWillBeSent")
        .map(event => [event.params.requestId, event.params.request.method]));
      const response = cdp.events.slice(startIndex)
        .filter(event => event.method === "Network.responseReceived")
        .find(event => event.params.response.url.includes(fragment)
          && event.params.response.status >= 200
          && requests.get(event.params.requestId) === method);
      if (response) return response;
      await sleep(50);
    }
    const recent = cdp.events.slice(startIndex)
      .filter(event => ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed"].includes(event.method))
      .map(event => ({
        method: event.method,
        url: event.params.request?.url || event.params.response?.url || "",
        requestMethod: event.params.request?.method || "",
        status: event.params.response?.status,
        error: event.params.errorText
      }));
    throw new Error(`等待 ${method} ${fragment} 响应超时：${JSON.stringify(recent)}`);
  };
  const fill = (selector, value) => evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw new Error('找不到输入：'+${JSON.stringify(selector)});
    const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  const login = async account => {
    await cdp.send("Page.navigate", { url: appUrl });
    await waitUntil(`document.readyState==='complete'&&document.documentElement.dataset.runtimeReady==='1'`, "应用启动");
    await waitUntil(`!document.querySelector('#auth-gate').hidden`, "登录页");
    await fill("#login-form input[name=username]", account.username);
    await fill("#login-form input[name=password]", PASSWORD);
    await click("#login-form button[type=submit]");
    await waitUntil(`document.querySelector('#auth-gate').hidden&&document.querySelector('#account-name').textContent===${JSON.stringify(account.username)}`, `${account.username} 登录`);
  };

  await login(accountA);
  const settingsResponse = await jsonRequest(`${base}/app/api/settings`, {
    cookie: accountA.cookie,
    method: "POST",
    body: { apiKey: "synthetic-loopback-only-key" }
  });
  assert.equal(settingsResponse.response.status, 200, JSON.stringify(settingsResponse.value));
  await cdp.send("Page.navigate", { url: `${base}/app/mine/personal-context` });
  await waitUntil(`document.readyState==='complete'&&document.documentElement.dataset.runtimeReady==='1'`, "个人概要路由启动");
  await waitUntil(`document.querySelector('#view-personal-context').classList.contains('active')`, "打开个人概要");
  assert.equal(await evaluate(`document.querySelector('#onboarding-v2-reopen').textContent.trim()`), "补充核心模型回答");

  const beforeOpenEvents = cdp.events.length;
  await click("#onboarding-v2-reopen");
  await waitUntil(`!document.querySelector('#onboarding-workspace').hidden&&document.querySelector('#onboarding-v2-content').textContent.includes('现在的生活')`, "补答入口进入第一问");
  await sleep(250);
  const afterOpenMutations = cdp.events.slice(beforeOpenEvents)
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => event.params.request)
    .filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method));
  assert.deepEqual(afterOpenMutations, [], "明确打开补答入口不能提前写服务端模型或答案");
  const afterOpenA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  const afterOpenModelA = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountA.cookie });
  assert.deepEqual(afterOpenA.value.data, initialA.value.data, "仅打开入口时，服务端问答状态必须保持不变");
  assert.deepEqual(afterOpenModelA.value.data, initialModelA.value.data, "显式回答前不能写入模型");

  await fill('[data-onboarding-answer="currentContext"]', ANSWER);
  await sleep(200);
  const beforeAnswerSave = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.deepEqual(beforeAnswerSave.value.data, initialA.value.data, "输入草稿但未保存时，服务端不应接收回答");
  const answerSaveEventIndex = cdp.events.length;
  await click('[data-onboarding-action="next"]');
  await waitUntil(`document.querySelector('#onboarding-v2-content').textContent.includes('希望的变化')`, "保存首问并进入第二问");
  const answerSaveResponse = await waitForResponse("/api/v1/onboarding-v2/session", answerSaveEventIndex, "PATCH");
  assert.equal(answerSaveResponse.params.response.status, 200, `首问 PATCH 应保存成功，status=${answerSaveResponse.params.response.status}`);
  const answerSaveBody = await cdp.send("Network.getResponseBody", { requestId: answerSaveResponse.params.requestId });
  const answerSaveData = JSON.parse(answerSaveBody.body).data;
  assert.equal(answerSaveData.session.answers.currentContext.rawText, ANSWER, "PATCH 响应必须确认服务端保存了当前答案");
  await waitUntil(`document.querySelector('#onboarding-v2-save-status').textContent.includes('已同步')`, "界面显示服务端已同步");
  const savedA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.equal(savedA.response.status, 200, JSON.stringify(savedA.value));
  assert.equal(savedA.value.data.session.answers.currentContext?.rawText, ANSWER, JSON.stringify(savedA.value.data));
  assert.equal(savedA.value.data.session.answers.currentContext.version, 1);
  assert.ok(savedA.value.data.session.revision > initialA.value.data.session.revision);

  const contextAfterSave = await jsonRequest(`${base}/app/api/v1/personal-context`, { cookie: accountA.cookie });
  const answerSource = contextAfterSave.value.data.sources.find(source => source.id === "onboardingV2:currentContext:answer:currentContext");
  assert.ok(answerSource, "回答应以 onboardingV2 来源进入个人概要来源列表");
  assert.equal(answerSource.resourceType, "onboardingV2");
  assert.equal(answerSource.location.targetKey, "answer:currentContext");
  assert.equal(answerSource.version, 1);
  assert.ok(answerSource.excerpt.includes(ANSWER), "来源摘要应能追溯到回答原文");
  assert.deepEqual(
    (await jsonRequest(`${base}/app/api/state`, { cookie: accountA.cookie })).value.captures,
    initialHistoryA.value.captures,
    "保存补答不能改变已有历史记录"
  );

  await cdp.send("Page.navigate", { url: appUrl });
  await waitUntil(`document.readyState==='complete'&&document.documentElement.dataset.runtimeReady==='1'`, "刷新后应用启动");
  await waitUntil(`document.querySelector('#auth-gate').hidden&&document.querySelector('#account-name').textContent==='synthetic_a'`, "刷新后 A 账户恢复");
  await waitUntil(`!document.querySelector('#onboarding-workspace').hidden&&document.querySelector('#onboarding-v2-content').textContent.includes('希望的变化')`, "刷新恢复到第二问", 220);
  assert.equal(await evaluate(`document.querySelector('[data-onboarding-answer="currentContext"]')?.value||''`), "", "刷新后应位于下一问，而首问原文仍由持久化状态保存");
  const afterRefreshSessionA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.equal(afterRefreshSessionA.value.data.session.answers.currentContext.rawText, ANSWER);

  for (const [step, title, selector, answer] of [
    ["desiredChanges", "接下来一段时间，你最希望发生哪些变化", '[data-onboarding-list="desiredChanges"][data-index="0"]', "希望建立稳定的写作节奏。"],
    ["recentObstacles", "最近有哪些事情正在消耗你", '[data-onboarding-list="recentObstacles"][data-index="0"]', "最近需要处理隔离测试中的合成问题。"],
    ["dailyRhythm", "你最近的作息", '[data-onboarding-answer="dailyRhythm"]', "工作日安排相对紧凑。"],
    ["collaboration", "你希望我用什么方式", "[data-onboarding-boundary]", "请先说明关键判断，再给一个可执行步骤。"]
  ]) {
    await waitUntil(`document.querySelector('#onboarding-v2-content').textContent.includes(${JSON.stringify(title)})`, `${step} 问题显示`);
    await fill(selector, answer);
    await click('[data-onboarding-action="next"]');
  }
  await waitUntil(`document.querySelector('#onboarding-v2-content').textContent.includes('这就是目前的起点')`, "完成五问并回看原文");
  const completedSessionA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.equal(completedSessionA.value.data.session.answers.currentContext.rawText, ANSWER);
  const reviewUi = JSON.parse(await evaluate(`JSON.stringify({step:document.querySelector('#onboarding-v2-content').textContent.slice(0,160),extractDisabled:document.querySelector('[data-onboarding-action="extract"]')?.disabled,answers:[...document.querySelectorAll('.onboarding-v2-review article')].map(item=>item.textContent.trim().slice(0,80))})`));
  assert.equal(reviewUi.extractDisabled, false, JSON.stringify({ reviewUi, serverAnswers: completedSessionA.value.data.session.answers }));
  const extractionStart = cdp.events.length;
  await click('[data-onboarding-action="extract"]');
  const extractionResponse = await waitForResponse("/api/v1/onboarding-v2/extractions", extractionStart, "POST");
  assert.equal(extractionResponse.params.response.status, 202);
  const extractionResponseBody = await cdp.send("Network.getResponseBody", { requestId: extractionResponse.params.requestId });
  const extractionTaskId = JSON.parse(extractionResponseBody.body).data.id;
  assert.ok(extractionTaskId);
  await waitUntil(`document.querySelector('[data-claim-id]')!==null`, "本地 mock 生成候选 claim", 300);
  assert.equal(providerCalls, 1, "提取必须经过单次 loopback provider mock");
  const pendingModelA = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountA.cookie });
  const pendingClaim = pendingModelA.value.data.claims.find(claim => claim.statement === CLAIM_STATEMENT);
  assert.ok(pendingClaim, "提取候选必须持久化后显示在确认 UI");
  assert.equal(pendingClaim.lifecycle, "candidate", "模型提炼内容在用户确认前必须保持候选态");
  assert.equal(pendingClaim.sourceTaskId, extractionTaskId, "候选必须绑定到本次 extraction task");
  assert.deepEqual(pendingClaim.evidence.map(({ sourceId, sourceVersion, span }) => ({ sourceId, sourceVersion, span })), [
    { sourceId: "currentContext", sourceVersion: 1, span: [0, ANSWER.length] }
  ], "claim evidence must bind exactly to the currentContext source text sent in the provider request");
  await click('[data-claim-action="confirm"]');
  await waitUntil(`document.querySelector('[data-claim-id]')?.textContent.includes('已确认')||document.querySelector('#onboarding-v2-content').textContent.includes('按原文开始')`, "候选确认完成");
  const confirmedModelA = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountA.cookie });
  const confirmedClaim = confirmedModelA.value.data.claims.find(claim => claim.id === pendingClaim.id);
  assert.equal(confirmedClaim.lifecycle, "active", "用户确认后 claim 才能进入 active 模型");
  assert.ok(confirmedClaim.confirmedAt);
  assert.equal(confirmedClaim.sourceTaskId, extractionTaskId);
  assert.equal(confirmedModelA.value.data.activeClaimCount, 1);
  assert.equal(confirmedModelA.value.data.candidateCount, 0);
  await click('[data-onboarding-action="complete"]');
  await waitUntil(`document.querySelector('#onboarding-v2-save-status').textContent.includes('已同步')`, "确认核心问答完成并同步");
  const completedFinalSessionA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  assert.equal(completedFinalSessionA.value.data.session.status, "completed");
  assert.equal(completedFinalSessionA.value.data.session.answers.desiredChanges.structuredValue[0].text, "希望建立稳定的写作节奏。");
  assert.equal(completedFinalSessionA.value.data.session.answers.recentObstacles.structuredValue[0].text, "最近需要处理隔离测试中的合成问题。");
  assert.equal(completedFinalSessionA.value.data.session.answers.dailyRhythm.rawText, "工作日安排相对紧凑。");
  assert.equal(completedFinalSessionA.value.data.session.collaboration.additionalBoundary, "请先说明关键判断，再给一个可执行步骤。");
  const extractionTask = await jsonRequest(`${base}/app/api/v1/onboarding-v2/extractions/${extractionTaskId}`, { cookie: accountA.cookie });
  assert.equal(extractionTask.value.data.task.status, "succeeded", JSON.stringify(extractionTask.value.data));
  assert.equal(providerCalls, 1);
  assert.equal(providerMessageSequence.length, 1);
  const fullProviderMessages = JSON.stringify(providerMessageSequence);
  for (const marker of [MARKERS.a, MARKERS.b, OLD_PROFILE_MARKER, OLD_UNDERSTANDING_MARKER]) {
    assert.ok(!fullProviderMessages.includes(marker), `captured provider sequence must exclude ${marker}`);
  }
  const durableClaim = JSON.parse(await fs.readFile(storeAPath, "utf8")).userClaims.find(claim => claim.id === pendingClaim.id);
  assert.equal(durableClaim.lifecycle, "active", "用户确认状态必须持久化到 A 账户存储");

  await click("#logout-button");
  await waitUntil(`!document.querySelector('#auth-gate').hidden`, "退出 A 并显示登录");
  await waitUntil(`document.querySelector('#login-form button[type=submit]').disabled===false`, "等待 A 退出完成");
  await fill("#login-form input[name=username]", accountB.username);
  await fill("#login-form input[name=password]", PASSWORD);
  await click("#login-form button[type=submit]");
  await waitUntil(`document.querySelector('#auth-gate').hidden&&document.querySelector('#account-name').textContent==='synthetic_b'`, "切换至 B 账户");
  await cdp.send("Page.navigate", { url: `${base}/app/mine/personal-context` });
  await waitUntil(`document.readyState==='complete'&&document.documentElement.dataset.runtimeReady==='1'`, "B 个人概要路由启动");
  await waitUntil(`document.querySelector('#view-personal-context').classList.contains('active')`, "查看 B 个人概要");
  assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(ANSWER)})`), false, "B 浏览器界面不能显示 A 的回答");
  await click("#onboarding-v2-reopen");
  await waitUntil(`!document.querySelector('#onboarding-workspace').hidden&&document.querySelector('#onboarding-v2-content').textContent.includes('现在的生活')`, "B 独立打开补答入口");
  assert.equal(await evaluate(`document.querySelector('[data-onboarding-answer="currentContext"]')?.value||''`), "", "B 的补答草稿不能继承 A 的原文");
  const stateB = await jsonRequest(`${base}/app/api/state`, { cookie: accountB.cookie });
  assert.ok(stateB.value.captures.some(item => item.content === MARKERS.b));
  assert.ok(!stateB.value.captures.some(item => item.content === MARKERS.a || item.content === ANSWER));
  const sessionB = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountB.cookie });
  assert.equal(sessionB.value.data.session.answers.currentContext, undefined, "B 不应读取 A 的补答");
  const contextB = await jsonRequest(`${base}/app/api/v1/personal-context`, { cookie: accountB.cookie });
  assert.ok(!contextB.value.data.sources.some(source => source.excerpt.includes(ANSWER)), "B 的来源中不能出现 A 的回答");
  const modelB = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountB.cookie });
  assert.ok(!modelB.value.data.claims.some(claim => claim.statement === CLAIM_STATEMENT), "B 的模型中不能读取 A 的候选或已确认 claim");

  await click("#logout-button");
  await waitUntil(`!document.querySelector('#auth-gate').hidden`, "退出 B 并显示登录");
  await waitUntil(`document.querySelector('#login-form button[type=submit]').disabled===false`, "等待 B 退出完成");
  await fill("#login-form input[name=username]", accountA.username);
  await fill("#login-form input[name=password]", PASSWORD);
  await click("#login-form button[type=submit]");
  await waitUntil(`document.querySelector('#auth-gate').hidden&&document.querySelector('#account-name').textContent==='synthetic_a'`, "重新登录 A");
  const finalSessionA = await jsonRequest(`${base}/app/api/v1/onboarding-v2/session`, { cookie: accountA.cookie });
  const finalStateA = await jsonRequest(`${base}/app/api/state`, { cookie: accountA.cookie });
  assert.equal(finalSessionA.value.data.session.answers.currentContext.rawText, ANSWER);
  const finalModelA = await jsonRequest(`${base}/app/api/v1/user-model`, { cookie: accountA.cookie });
  assert.equal(finalModelA.value.data.claims.find(claim => claim.id === pendingClaim.id)?.lifecycle, "active");
  assert.ok(finalStateA.value.captures.some(item => item.content === MARKERS.a));
  assert.ok(!finalStateA.value.captures.some(item => item.content === MARKERS.b));
  const durableA = JSON.parse(await fs.readFile(storeAPath, "utf8"));
  const durableB = JSON.parse(await fs.readFile(storeBPath, "utf8"));
  assert.ok(!durableA.captures.some(item => item.content === MARKERS.b));
  assert.ok(!durableB.captures.some(item => item.content === MARKERS.a));
  assert.ok(!durableB.onboardingV2.session.answers.currentContext);
  assert.ok(!durableB.userClaims.some(claim => claim.statement === CLAIM_STATEMENT));
  assert.ok(durableA.userClaims.some(claim => claim.id === pendingClaim.id && claim.lifecycle === "active"));

  const summary = {
    status: "passed",
    scope: "synthetic local HTTP + real Chrome UI + loopback-only provider mock; no production data/provider",
    checks: [
      "existing account login with pre-seeded history",
      "explicit supplement entry has no server mutation before answers",
      "unsaved answer stays client-side; PATCH 200 confirms save before refresh recovery",
      "saved answer source is linked to onboardingV2/currentContext",
      "explicit extraction submit reaches the loopback mock with only the five synthetic onboarding answers",
      "provider messages match the five permitted sourceId/text pairs and exclude preseeded history/profile markers",
      "extracted claim remains candidate until explicit UI confirmation, then persists active with source task and answer span",
      "existing history remains unchanged",
      "logout/login account switching isolates history, answers and sources"
    ],
    knownLimit: "provider behavior is deterministic loopback mock; real provider response quality is not covered",
    completedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(artifactDir, "onboarding-v2-existing-user-browser.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  if (providerError) process.stderr.write(`loopback provider error: ${providerError}\n`);
  if (appErrors) process.stderr.write(`isolated-app stderr tail: ${appErrors.slice(-4000)}\n`);
  throw error;
} finally {
  cdp?.socket.close();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
  if (chrome) {
    chrome.kill("SIGTERM");
    await new Promise(resolve => chrome.once("exit", resolve));
  }
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  if (chromeProfileDir) await fs.rm(chromeProfileDir, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}
