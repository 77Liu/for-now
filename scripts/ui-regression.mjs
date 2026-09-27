import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:4173/";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
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
  throw new Error("等待 Chrome 调试端口超时");
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

const mockFetch = `
(() => {
  const nativeFetch = window.fetch.bind(window);
  const json = value => Promise.resolve(new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
  const streamResponse = result => {
    const encoder = new TextEncoder();
    const longReasoning = Array.from({ length: 70 }, (_, index) => "思考行 " + (index + 1)).join("\\n") + "\\n";
    window.__reasoningChunks = 0;
    const stream = new ReadableStream({
      start(controller) {
        const send = event => controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\\n\\n"));
        setTimeout(() => { window.__reasoningChunks += 1; send({ type: "reasoning", delta: longReasoning }); }, 80);
        setTimeout(() => { window.__reasoningChunks += 1; send({ type: "reasoning", delta: "**再形成判断。**" }); }, 180);
        setTimeout(() => send({ type: "content", delta: "**结论**：" }), 260);
        setTimeout(() => send({ type: "content", delta: "后台完成。" }), 520);
        setTimeout(() => { send({ type: "done", result }); controller.close(); }, 850);
      }
    });
    return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  };
  window.__thoughtSaves = 0;
  window.__captureSaves = 0;
  window.__capturePayloads = [];
  window.__capturePatchPayloads = [];
  window.__journalSaves = 0;
  window.__journalAssistPayloads = [];
  window.__bookParses = 0;
  window.__bookUploads = 0;
  window.__bookSaves = 0;
  window.__bookPatches = 0;
  window.__bookPayloads = [];
  window.__bookNoteSaves = 0;
  window.__bookNotePatches = 0;
  window.__quoteSaves = 0;
  window.__quotePatches = 0;
  window.__settingsSaves = 0;
  window.__dailySaves = 0;
  window.__dailyPatches = 0;
  window.__healthParses = 0;
  window.__annotationSaves = 0;
  window.__shenjiSaves = 0;
  window.__savedPayloads = [];
  window.__keepsakes = [{
    id: "keepsake-1", createdAt: "2026-09-27T01:30:00.000Z", occurredAt: "2026-09-27T09:30:00.000Z", occurredOn: "2026-09-27",
    title: "旧展览票", category: "纸品", note: "已完成数字留存", source: "auto", edgeExpansion: 8,
    originalPath: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220'%3E%3Crect width='320' height='220' fill='%23d76455'/%3E%3C/svg%3E",
    cutoutPath: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220'%3E%3Crect x='40' y='30' width='240' height='160' rx='8' fill='%23d76455'/%3E%3C/svg%3E"
  }];
  window.__captures = [
    { id: "capture-1", createdAt: "2026-09-27T01:12:00.000Z", occurredAt: "2026-09-27T07:08:09.000Z", occurredOn: "2026-09-27", content: "**这个念头**先不要想完整", tags: ["灵感", "可展开"] },
    { id: "capture-long", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T07:05:09.000Z", occurredOn: "2026-09-27", content: "这是一条需要验证四行折叠的长捕念。\\n- 第一项内容\\n- 第二项内容\\n- 第三项内容\\n- 第四项内容\\n- 第五项内容\\n- 第六项内容", tags: ["职业规划"] }
  ];
  window.__journals = [{ id: "journal-1", createdAt: "2026-09-27T01:13:00.000Z", occurredAt: "2026-09-27T08:13:14.000Z", occurredOn: "2026-09-27", title: "今天的一件小事", content: "事实是事情发生了。\\\\n\\\\n**我的感受**还需要慢慢辨认。", tags: ["日常"], reflections: [] }];
  window.__quotes = [
    { id: "quote-1", createdAt: "2026-09-27T02:10:11.000Z", occurredAt: "2026-09-27T06:10:11.000Z", occurredOn: "2026-09-27", source: "AI总结", content: "第一行：布施对治悭贪。\\n第二行：持戒对治毁犯。\\n第三行：忍辱对治嗔恚。\\n第四行：精进对治懈怠。\\n第五行：禅定对治散乱。\\n第六行：般若照见实相。", tags: ["修行"] },
    { id: "quote-2", createdAt: "2026-09-27T01:10:11.000Z", occurredAt: "2026-09-27T05:10:11.000Z", occurredOn: "2026-09-27", source: "来源二", content: "第一行\\n第二行", tags: ["行动"] },
    { id: "quote-3", createdAt: "2026-09-26T01:10:11.000Z", occurredAt: "2026-09-26T05:10:11.000Z", occurredOn: "2026-09-26", source: "来源三", content: "前一日", tags: ["文化"] },
    { id: "quote-4", createdAt: "2026-09-25T01:10:11.000Z", occurredAt: "2026-09-25T05:10:11.000Z", occurredOn: "2026-09-25", source: "来源四", content: "第四条", tags: ["身体"] }
  ];
  window.__analyses = [
    { id: "analysis-1", createdAt: "2026-09-27T01:20:00.000Z", reason: "weekly-background", content: "**总判断**\\n\\n---\\n\\n## 证据", reasoningContent: "### 分析过程", annotations: [], annotationDrift: [] },
    { id: "analysis-2", createdAt: "2026-09-20T01:20:00.000Z", reason: "manual", content: "## 旧复盘\\n\\n历史内容仍然存在。", reasoningContent: "旧分析过程", annotations: [], annotationDrift: [] }
  ];
  window.__books = [];
  window.__dailyRecords = [
    { id: "weight-existing", type: "weight", createdAt: "2026-09-26T01:00:00.000Z", occurredAt: "2026-09-26T07:30:00.000Z", occurredOn: "2026-09-26", source: "manual", attachmentPaths: [], measuredWeight: 70, clothing: "light", adjustmentMean: .5, adjustedWeight: 69.5, lower95: 69.1, upper95: 69.9 }
  ];
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/state") return json({
      version: 12, checkins: [
        { id: "checkin-latest", createdAt: "2026-09-27T08:00:00.000Z", occurredAt: "2026-09-27T08:00:00.000Z", occurredOn: "2026-09-27", mood: 4, energy: 2, stress: 4, sleep: 5, factors: [] },
        { id: "checkin-previous", createdAt: "2026-09-26T08:00:00.000Z", occurredAt: "2026-09-26T08:00:00.000Z", occurredOn: "2026-09-26", mood: 3, energy: 3, stress: 3, sleep: 2, factors: [] }
      ], dailyRecords: window.__dailyRecords, captures: window.__captures, journals: window.__journals, thoughts: [
        { id: "answer-kept", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T04:10:00.000Z", occurredOn: "2026-09-27", type: "answer", content: "**核心判断**\\n第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行", reasoningContent: "**持久化**的模型思考", tags: [], relatedTo: "kept-root", disposition: "kept" },
        { id: "kept-root", createdAt: "2026-09-27T01:09:00.000Z", occurredAt: "2026-09-27T04:09:00.000Z", occurredOn: "2026-09-27", type: "question", content: "没有**初步想法**的问题", tags: [], relatedTo: null, disposition: "kept", remarks: [], followUps: [], annotations: [], annotationDrift: [] },
        { id: "discarded-root", createdAt: "2026-09-27T01:08:00.000Z", occurredAt: "2026-09-27T04:08:00.000Z", occurredOn: "2026-09-27", type: "question", content: "已舍弃的问题", tags: [], relatedTo: null, disposition: "discarded", remarks: [], followUps: [], annotations: [], annotationDrift: [] }
      ], chats: [{ id: "chat-1", createdAt: "2026-09-27T01:15:00.000Z", occurredAt: "2026-09-27T04:15:00.000Z", occurredOn: "2026-09-27", message: "**用户问题**", answer: "## 模型回答" }], books: window.__books, keepsakes: window.__keepsakes, quotes: window.__quotes,
      experiments: [], analyses: window.__analyses, customMetrics: [], clusters: [],
      insights: { trends: [], associations: [], weekly: { activeDays7: 4, pairedDays30: 2, rootCount30: 5, answeredRoots30: 4, closureRate30: 80, correctionActions30: 7, reviewAgeDays: 0, analysisCount: 2 } }
    });
    if (url === "/api/settings" && (!init.method || init.method === "GET")) return json({
      version: 4, provider: "deepseek",
      profiles: { lite: { model: "deepseek-flash", effort: "none" }, mid: { model: "deepseek-flash", effort: "high" }, high: { model: "deepseek-v4-pro", effort: "high" }, ultra: { model: "deepseek-v4-pro", effort: "max" } },
      scenarios: { thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high", diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra", annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid" },
      hasApiKey: true, keyHint: "tes••••test"
    });
    if (url === "/api/settings" && init.method === "POST") {
      window.__settingsSaves += 1;
      const payload = JSON.parse(init.body);
      return json({ version: 4, provider: "deepseek", ...payload, hasApiKey: true, keyHint: "tes••••test" });
    }
    if (url === "/api/settings/test") return json({ ok: true, reply: "连接成功" });
    if (url === "/api/captures" && init.method === "POST") {
      window.__captureSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "capture-new-" + window.__captureSaves, createdAt: new Date().toISOString(), ...payload, occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) };
      window.__capturePayloads.push(payload);
      window.__captures.unshift(item);
      return json(item);
    }
    if (/^\\/api\\/captures\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const item = window.__captures.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      window.__capturePatchPayloads.push(payload);
      Object.assign(item, payload, { occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10), updatedAt: new Date().toISOString() });
      return json(item);
    }
    if (url === "/api/journals" && init.method === "POST") {
      window.__journalSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "journal-new-" + window.__journalSaves, createdAt: new Date().toISOString(), reflections: [], ...payload, occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) };
      window.__journals.unshift(item);
      return json(item);
    }
    if (/^\\/api\\/journals\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const item = window.__journals.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, { occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10), updatedAt: new Date().toISOString() });
      return json(item);
    }
    if (/^\\/api\\/journals\\/[^/]+\\/reflect$/.test(url)) {
      const id = url.split("/")[3], item = window.__journals.find(value => value.id === id);
      const reflection = { id: "reflection-1", createdAt: new Date().toISOString(), sourceUpdatedAt: item.updatedAt || item.createdAt, content: "**结论**：后台完成。", reasoningContent: "持久化的模型思考" };
      item.reflections.unshift(reflection);
      return streamResponse(reflection);
    }
    if (url === "/api/journals/assist") {
      const payload = JSON.parse(init.body);
      window.__journalAssistPayloads.push(payload);
      return streamResponse({ mode: payload.mode, content: "AI 追加的写作锚点。" });
    }
    if (url === "/api/images/parse") {
      const payload = JSON.parse(init.body);
      if (payload.kind === "book") window.__bookParses += 1;
      else window.__healthParses += 1;
      if (payload.kind === "sleep") return json({ date: "2026-09-27", bedtime: "2026-09-27T02:58:00", wakeTime: "2026-09-27T10:40:00", totalMinutes: 462, deepMinutes: 134, deepPercent: 29, lightMinutes: 221, lightPercent: 48, remMinutes: 107, remPercent: 23, awakeCount: null, awakeMinutes: null, averageHeartRate: 49, averageOxygen: 98, respiratoryRate: 15, attachmentPaths: ["/attachments/sleep-1.jpg", "/attachments/sleep-2.jpg"], verification: "两张图已合并" });
      if (payload.kind === "heartRate") return json({ date: "2026-09-26", minimum: 46, maximum: 82, average: 60, resting: 52, sleepAverage: 50, trendAnalysis: "凌晨下降，午后与晚间抬升。", trendSegments: [], attachmentPaths: ["/attachments/heart.jpg"], verification: "心率图已识别" });
      return json({ title: "粘贴识别成功", author: "测试作者", publisher: "测试出版社", isbn: "9780000000000", description: "**识别结果**", attachmentPaths: ["/attachments/mock.png"], verification: "图片已识别，请确认" });
    }
    if (url === "/api/images/upload") {
      window.__bookUploads += 1;
      return json({ attachmentPath: "/attachments/cover-" + window.__bookUploads + ".png" }, 201);
    }
    if (url === "/api/keepsakes/segment") return json({ suggestedTitle: "自动识别票券", category: "纸品", subjectDescription: "测试主体", includeHand: true, confidence: .9, subjectBox: [120,120,880,880], foregroundPoints: [[500,350],[500,650]], backgroundPoints: [[20,20],[980,20],[20,980],[980,980]] });
    if (url === "/api/daily-records" && init.method === "POST") {
      window.__dailySaves += 1;
      const payload = JSON.parse(init.body), item = { id: "daily-" + window.__dailySaves, createdAt: new Date().toISOString(), ...payload, occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) };
      window.__dailyRecords.unshift(item);
      return json(item);
    }
    if (/^\\/api\\/daily-records\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__dailyPatches += 1;
      const item = window.__dailyRecords.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, { occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) });
      return json(item);
    }
    if (/^\\/api\\/daily-records\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id = url.split("/").at(-1);window.__dailyRecords = window.__dailyRecords.filter(item => item.id !== id);return json({ removed: 1 });
    }
    if (url === "/api/books/parse") {
      window.__bookParses += 1;
      return json({ title: "粘贴识别成功", author: "测试作者", publisher: "测试出版社", isbn: "9780000000000", description: "**识别结果**", imagePath: "/attachments/mock.png", verification: "图片已识别，请确认" });
    }
    if (url === "/api/books" && init.method === "POST") {
      window.__bookSaves += 1;
      const payload = JSON.parse(init.body), book = { id: "book-" + window.__bookSaves, createdAt: "2026-09-27T01:00:00.000Z", notes: [], annotations: [], annotationDrift: [], ...payload };
      window.__bookPayloads.push(payload);
      window.__books.unshift(book);
      return json(book);
    }
    if (/^\\/api\\/books\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__bookPatches += 1;
      const id = url.split("/").at(-1), book = window.__books.find(item => item.id === id), payload = JSON.parse(init.body);
      window.__bookPayloads.push(payload);
      Object.assign(book, payload, { updatedAt: new Date().toISOString() });
      return json(book);
    }
    if (/^\\/api\\/books\\/[^/]+\\/notes$/.test(url) && init.method === "POST") {
      window.__bookNoteSaves += 1;
      const book = window.__books.find(item => url.includes(item.id)), payload = JSON.parse(init.body), note = { id: "note-" + window.__bookNoteSaves, createdAt: "2026-09-27T01:01:00.000Z", ...payload, occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) };
      book.notes.unshift(note);
      return json(note);
    }
    if (/^\\/api\\/books\\/[^/]+\\/notes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__bookNotePatches += 1;
      const [, , , bookId, , noteId] = url.split("/"), book = window.__books.find(item => item.id === bookId), note = book.notes.find(item => item.id === noteId), payload = JSON.parse(init.body);
      Object.assign(note, payload, { occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10), updatedAt: new Date().toISOString() });
      return json(note);
    }
    if (url === "/api/quotes" && init.method === "POST") {
      window.__quoteSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "quote-new-" + window.__quoteSaves, createdAt: "2026-09-27T03:20:21.000Z", ...payload, occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10) };
      window.__quotes.unshift(item);
      return json(item);
    }
    if (/^\\/api\\/quotes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__quotePatches += 1;
      const item = window.__quotes.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, { occurredAt: new Date(payload.occurredAt).toISOString(), occurredOn: payload.occurredAt.slice(0, 10), updatedAt: new Date().toISOString() });
      return json(item);
    }
    if (/^\\/api\\/quotes\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id = url.split("/").at(-1);window.__quotes = window.__quotes.filter(item => item.id !== id);return json({ removed: 1 });
    }
    if (url === "/api/answer-drafts") return streamResponse({ draft: "**结论**：后台完成。", reasoningContent: "持久化的模型思考" });
    if (url === "/api/annotations/analysis/analysis-1" && init.method === "POST") {
      window.__annotationSaves += 1;
      const payload = JSON.parse(init.body), annotation = { id: "analysis-annotation-1", createdAt: "2026-09-27T03:30:00.000Z", resolved: false, replies: [], ...payload };
      window.__analyses[0].annotations.push(annotation);
      return json(annotation);
    }
    if (url === "/api/annotations/analysis/analysis-1/analysis-annotation-1/shenji" && init.method === "POST") {
      window.__shenjiSaves += 1;
      const payload = JSON.parse(init.body), exchange = { id: "analysis-shenji-1", createdAt: "2026-09-27T03:31:00.000Z", message: payload.message, answer: "**神鸡判断**：这条复盘需要保留反证。", reasoningContent: "核对复盘上下文。" };
      window.__analyses[0].annotations[0].shenji = [exchange];
      return json(exchange);
    }
    if (url === "/api/thought-chains") {
      window.__thoughtSaves += 1;
      window.__savedPayloads.push(JSON.parse(init.body));
      const id = "auto-root-" + window.__thoughtSaves;
      return json({ items: [{ id, createdAt: new Date().toISOString(), occurredAt: "2026-09-27T04:00:00.000Z", occurredOn: "2026-09-27", type: "question", content: "并发记录", tags: [], relatedTo: null, disposition: "kept" }], duplicate: false });
    }
    if (/^\\/api\\/thoughts\\/auto-root-\\d+\\/answer$/.test(url)) return streamResponse({ id: "auto-answer", content: "**结论**：后台完成。", answer: "**结论**：后台完成。", reasoningContent: "持久化的模型思考" });
    return nativeFetch(input, init);
  };
})();
`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "growth-ui-regression-"));
const port = await freePort();
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-background-networking",
  "--disable-component-update",
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
  cdp = new Cdp(await pageDebuggerUrl(port));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: mockFetch });
  await cdp.send("Page.navigate", { url: APP_URL });
  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const waitUntil = async (expression, attempts = 80, delay = 50) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(delay);
    }
    return false;
  };
  assert.equal(await waitUntil(`document.querySelector("#today-date-label")?.textContent.length > 0`), true);
  const desktopNavigation = await evaluate(`(() => {
    const sidebar=document.querySelector(".sidebar"),main=document.querySelector("main"),active=document.querySelector(".nav-button.active"),style=getComputedStyle(sidebar);
    return {
      compact:Math.round(sidebar.getBoundingClientRect().width)===176&&Math.round(parseFloat(getComputedStyle(main).marginLeft))===176,
      lightGlass:style.backgroundColor.startsWith("rgba")&&style.backdropFilter.includes("blur"),
      current:active.dataset.view==="today"&&active.getAttribute("aria-current")==="page",
      inactive:[...document.querySelectorAll(".nav-button:not(.active)")].every(button=>button.getAttribute("aria-current")!=="page")
    };
  })()`);
  assert.deepEqual(desktopNavigation, { compact: true, lightGlass: true, current: true, inactive: true });
  await evaluate(`document.querySelector('[data-view="keepsakes"]').click(); true`);
  assert.equal(await evaluate(`document.querySelectorAll(".keepsake-card").length === 1 && document.querySelector("#keepsake-count").textContent === "1 件"`), true);
  await evaluate(`document.querySelector("[data-keepsake-open]").click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#keepsake-lightbox").hidden && document.querySelector('[data-keepsake-view="original"]').classList.contains("active") && document.querySelector("#keepsake-lightbox-image").src.includes("svg")`), true);
  await evaluate(`document.querySelector("#keepsake-lightbox-close").click(); document.querySelector("#keepsake-create-toggle").click(); true`);
  await evaluate(`(async()=>{const canvas=document.createElement("canvas");canvas.width=48;canvas.height=36;const ctx=canvas.getContext("2d");ctx.fillStyle="#d76455";ctx.fillRect(0,0,48,36);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const file=new File([blob],"ticket.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#keepsake-image");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("复杂轮廓已生成")`), true);
  const keepsakeEditorState = await evaluate(`(() => { const preview=document.querySelector("#keepsake-preview-canvas"),ctx=preview.getContext("2d"),pixels=ctx.getImageData(0,0,preview.width,preview.height).data;let opaque=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)opaque++;return {editorVisible:!document.querySelector("#keepsake-editor").hidden,title:document.querySelector("#keepsake-title").value,opaque,overflow:document.documentElement.scrollWidth>window.innerWidth}; })()`);
  assert.equal(keepsakeEditorState.editorVisible, true);
  assert.equal(keepsakeEditorState.title, "自动识别票券");
  assert.ok(keepsakeEditorState.opaque > 0);
  assert.equal(keepsakeEditorState.overflow, false);
  const keepsakeScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsakes-desktop.png", Buffer.from(keepsakeScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth && getComputedStyle(document.querySelector(".keepsake-grid")).gridTemplateColumns.split(" ").length===2`), true);
  const keepsakeMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsakes-mobile.png", Buffer.from(keepsakeMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="review"]').click(); true`);
  const reviewSignals = await evaluate(`(() => {
    const cards=[...document.querySelectorAll(".summary-signal")],firstStyle=getComputedStyle(cards[0]),tops=cards.map(card=>Math.round(card.getBoundingClientRect().top));
    return {
      labels:cards.map(card=>card.querySelector(".summary-signal-label").textContent),
      values:cards.map(card=>card.querySelector(".summary-signal-value").textContent.trim()),
      fiveColumns:new Set(tops).size===1,
      light:Number(firstStyle.backgroundColor.match(/[\\d.]+(?=\\))/g)?.at(-1)??1)<1||!firstStyle.backgroundColor.includes("41, 78, 87"),
      compactRadius:firstStyle.borderRadius==="8px"
    };
  })()`);
  assert.deepEqual(reviewSignals.labels, ["近 7 日记录覆盖","近 30 日身心同日","近 30 日思考闭环率","近 30 日主动校正","距上次认知复盘"]);
  assert.deepEqual(reviewSignals.values, ["4/ 7 天","2天","80%","7次","今天"]);
  assert.equal(reviewSignals.fiveColumns, true);
  assert.equal(reviewSignals.light, true);
  assert.equal(reviewSignals.compactRadius, true);
  await evaluate(`document.querySelector("#weekly-summary").scrollIntoView({ block: "start" }); true`);
  await sleep(120);
  const reviewSignalsScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-review-signals.png", Buffer.from(reviewSignalsScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  const reviewSignalsMobile = await evaluate(`(() => {
    const cards=[...document.querySelectorAll(".summary-signal")],first=cards[0].getBoundingClientRect(),second=cards[1].getBoundingClientRect(),third=cards[2].getBoundingClientRect(),last=cards.at(-1).getBoundingClientRect(),strip=document.querySelector("#weekly-summary").getBoundingClientRect();
    return {
      twoColumns:Math.abs(first.top-second.top)<2&&third.top>first.bottom,
      finalSpans:Math.abs(last.left-strip.left)<2&&Math.abs(last.right-strip.right)<2,
      noOverflow:document.documentElement.scrollWidth<=window.innerWidth
    };
  })()`);
  assert.deepEqual(reviewSignalsMobile, { twoColumns: true, finalSpans: true, noOverflow: true });
  const reviewMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-review-signals-mobile.png", Buffer.from(reviewMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="today"]').click(); true`);
  assert.equal(await evaluate(`Boolean(document.querySelector(".chat-message.user strong")) && document.querySelector(".chat-message.agent h2")?.textContent === "模型回答"`), true);
  assert.equal(await evaluate(`[...document.querySelectorAll(".chat-message>.markdown-content")].every(item => item.classList.contains("commentable"))`), true);
  const metricHistory = await evaluate(`(() => {
    const metric=document.querySelector("#metric-energy").closest(".metric"),input=metric.querySelector('[type="range"]'),previous=metric.querySelector(".metric-history-marker.previous"),average=metric.querySelector(".metric-history-marker.average"),track=input.getBoundingClientRect(),previousRect=previous.getBoundingClientRect(),averageRect=average.getBoundingClientRect(),expectedAverage=track.left+11+(track.width-22)*.375;
    return {
      legend:[...document.querySelectorAll(".metric-history-legend span")].map(item=>item.textContent.trim()),
      noTextReference:document.querySelectorAll(".metric-reference").length===0,
      previousPosition:Number(previous.dataset.position),
      averagePosition:Number(average.dataset.position),
      decimalPositionExact:Math.abs(averageRect.left+averageRect.width/2-expectedAverage)<1,
      markersStraddleAxis:previousRect.bottom<track.top&&averageRect.top>track.bottom,
      differentColors:getComputedStyle(previous).color!==getComputedStyle(average).color,
      markersFaded:Number(getComputedStyle(previous).opacity)<.7&&Number(getComputedStyle(average).opacity)<.7,
      neutralAxis:getComputedStyle(input).backgroundImage==="none"
    };
  })()`);
  assert.deepEqual(metricHistory, { legend: ["上一次", "近30次平均"], noTextReference: true, previousPosition: 25, averagePosition: 37.5, decimalPositionExact: true, markersStraddleAxis: true, differentColors: true, markersFaded: true, neutralAxis: true });
  await evaluate(`document.querySelector(".checkin-card").scrollIntoView({ block: "start" }); true`);
  await sleep(250);
  const metricHistoryScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-metric-history.png", Buffer.from(metricHistoryScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.equal(await evaluate(`(() => { const sidebar=document.querySelector(".sidebar"),style=getComputedStyle(sidebar),rect=sidebar.getBoundingClientRect(),active=document.querySelector(".nav-button.active"),marker=getComputedStyle(active,"::before");return Math.round(rect.width)===390&&rect.bottom===window.innerHeight&&style.backgroundColor.startsWith("rgba")&&style.backdropFilter.includes("blur")&&marker.height==="2px"; })()`), true);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&document.querySelector(".metric-history-legend").getBoundingClientRect().right<=window.innerWidth`), true);
  const metricHistoryMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-metric-history-mobile.png", Buffer.from(metricHistoryMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const healthUpload = await evaluate(`(() => {
    const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0));
    const paste=file=>{const event=new Event("paste",{bubbles:true,cancelable:true});Object.defineProperty(event,"clipboardData",{value:{files:[file]}});document.body.dispatchEvent(event)};
    paste(new File([bytes],"sleep-overview.png",{type:"image/png"}));const afterFirst=document.querySelectorAll("#health-image-previews figure").length;
    paste(new File([bytes],"sleep-detail.png",{type:"image/png"}));
    return { tabs:document.querySelectorAll("[data-daily-tab]").length, afterFirst, previews:document.querySelectorAll("#health-image-previews figure").length, removeButtons:document.querySelectorAll("[data-health-image-remove]").length, parseEnabled:!document.querySelector("#parse-health-images").disabled };
  })()`);
  assert.deepEqual(healthUpload,{tabs:4,afterFirst:1,previews:2,removeButtons:2,parseEnabled:true});
  await evaluate(`document.querySelector("#parse-health-images").click(); true`);
  assert.equal(await waitUntil(`window.__healthParses===1&&document.querySelector('[data-daily-form="sleep"] [name="totalMinutes"]').value==="462"`),true);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="sleep"] [name="awakeMinutes"]').value`),"");
  await evaluate(`document.querySelector('[data-daily-form="sleep"]').requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__dailySaves===1&&document.querySelector('[data-daily-record-id="daily-1"]')`),true);
  await evaluate(`document.querySelector('[data-daily-tab="weight"]').click(); true`);
  assert.equal(await evaluate(`Boolean(document.querySelector(".weight-chart .weight-interval"))&&document.querySelector(".weight-chart-note").textContent.includes("固定衣物重量假设")`),true);
  await evaluate(`document.querySelector("#daily-records").scrollIntoView({block:"start"}); true`);
  await sleep(150);
  const dailyScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-daily-records.png",Buffer.from(dailyScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&document.querySelector("#daily-records").getBoundingClientRect().right<=window.innerWidth`),true);
  const dailyMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-daily-records-mobile.png",Buffer.from(dailyMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  const todayThoughtTimeline = await evaluate(`(() => {
    const list=document.querySelector("#today-thoughts"),entries=[...list.querySelectorAll(".thought-timeline-entry")],cards=entries.map(entry=>entry.querySelector(".chain-record")),cardRects=cards.map(card=>card.getBoundingClientRect()),contentRects=cards.map(card=>card.querySelector(".summary-content").getBoundingClientRect()),date=entries[0].querySelector(".timeline-date").getBoundingClientRect(),meta=entries[0].querySelector(".thought-entry-meta").getBoundingClientRect();
    return {
      cards:cards.length,
      nonemptyDates:[...list.querySelectorAll(".timeline-date")].filter(item=>item.textContent.trim()).length,
      cardsAligned:cardRects.every(rect=>Math.abs(rect.left-cardRects[0].left)<1),
      contentAligned:contentRects.every(rect=>Math.abs(rect.left-contentRects[0].left)<1),
      dateOutside:date.right<cardRects[0].left,
      metaOutside:meta.bottom<=cardRects[0].top,
      hasAxis:getComputedStyle(list,"::before").content!=="none",
      hasNodes:entries.every(entry=>getComputedStyle(entry,"::after").content!=="none"),
      summaryColumns:getComputedStyle(cards[0].querySelector(".chain-summary")).gridTemplateColumns.split(" ").length
    };
  })()`);
  assert.deepEqual(todayThoughtTimeline, { cards: 2, nonemptyDates: 1, cardsAligned: true, contentAligned: true, dateOutside: true, metaOutside: true, hasAxis: true, hasNodes: true, summaryColumns: 2 });
  await evaluate(`document.querySelector("#today-thoughts").scrollIntoView({ block: "start" }); true`);
  const todayThoughtScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-today-thoughts.png", Buffer.from(todayThoughtScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`(() => { const entries=[...document.querySelectorAll("#today-thoughts .thought-timeline-entry")],cards=entries.map(entry=>entry.querySelector(".chain-record")),lefts=cards.map(card=>card.getBoundingClientRect().left),date=entries[0].querySelector(".timeline-date").getBoundingClientRect(),card=cards[0].getBoundingClientRect(),meta=entries[0].querySelector(".thought-entry-meta").getBoundingClientRect(),contents=cards.map(item=>item.querySelector(".summary-content").getBoundingClientRect()); return document.documentElement.scrollWidth<=window.innerWidth&&lefts.every(left=>Math.abs(left-lefts[0])<1)&&date.left>=card.left&&date.bottom<=meta.top&&meta.bottom<=card.top&&contents.every(rect=>rect.width>card.width*.7); })()`), true);
  const todayThoughtMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-today-thoughts-mobile.png", Buffer.from(todayThoughtMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const viewThemeColors = await evaluate(`Object.fromEntries([...document.querySelectorAll(".view")].map(view => [view.id, getComputedStyle(view.querySelector(".eyebrow")).color]))`);
  assert.equal(new Set(Object.values(viewThemeColors)).size, 10);
  await evaluate(`document.querySelector('[data-view="captures"]').click(); true`);
  assert.equal(await evaluate(`document.querySelector("#view-captures").classList.contains("active") && Boolean(document.querySelector('[data-capture-id="capture-1"] strong'))`), true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-1"] .markdown-content').classList.contains("commentable")`), true);
  const captureInitial = await evaluate(`({
    inputType: document.querySelector("#capture-date").type,
    hasSeconds: /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$/.test(document.querySelector("#capture-date").value),
    shownTime: document.querySelector('[data-capture-id="capture-1"] .capture-entry-time').textContent,
    dateLabels: [...document.querySelectorAll(".capture-date")].filter(item => item.textContent.trim()).length,
    dateOutsideCard: (() => { const card = document.querySelector('[data-capture-id="capture-1"]').getBoundingClientRect(), date = document.querySelector('[data-capture-id="capture-1"] .capture-date').getBoundingClientRect(); return date.right < card.left; })(),
    timeOnRight: (() => { const card = document.querySelector('[data-capture-id="capture-1"]').getBoundingClientRect(), time = document.querySelector('[data-capture-id="capture-1"] .capture-entry-time').getBoundingClientRect(); return card.right - time.right < 24; })()
  })`);
  assert.equal(captureInitial.inputType, "datetime-local");
  assert.equal(captureInitial.hasSeconds, true);
  assert.equal(captureInitial.shownTime, "15:08:09");
  assert.equal(captureInitial.dateLabels, 1);
  assert.equal(captureInitial.dateOutsideCard, true);
  assert.equal(captureInitial.timeOnRight, true);
  assert.equal(await waitUntil(`!document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').hidden`), true);
  const captureCardLayout = await evaluate(`(() => {
    const card=document.querySelector('[data-capture-id="capture-long"]'),copy=card.querySelector(".capture-copy"),viewport=card.querySelector(".capture-content-viewport"),time=card.querySelector(".capture-entry-time"),tags=card.querySelector(".capture-inline-tags"),buttons=[...card.querySelectorAll(":scope > .record-actions button")],lineHeight=parseFloat(getComputedStyle(viewport).lineHeight);
    const buttonRects=buttons.map(button=>button.getBoundingClientRect());
    return {
      capped: viewport.scrollHeight>viewport.clientHeight && viewport.clientHeight<=lineHeight*4+1,
      contentTimeAligned: Math.abs(copy.getBoundingClientRect().top-time.getBoundingClientRect().top)<2,
      actionRows: buttonRects[0].bottom<=buttonRects[1].top+1 && Math.abs(buttonRects[1].top-buttonRects[2].top)<2,
      actionsCompact: buttonRects[2].bottom-buttonRects[0].top<42,
      actionsRightAligned: Math.abs(buttonRects[0].right-buttonRects[2].right)<2,
      tagsFirst: viewport.firstElementChild===tags,
      tagsFloat: getComputedStyle(tags).float==="left"
    };
  })()`);
  assert.deepEqual(captureCardLayout, { capped: true, contentTimeAligned: true, actionRows: true, actionsCompact: true, actionsRightAligned: true, tagsFirst: true, tagsFloat: true });
  const collapsedCaptureHeight = await evaluate(`document.querySelector('[data-capture-id="capture-long"] .capture-content-viewport').clientHeight`);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').click(); true`);
  assert.equal(await evaluate(`(() => { const card=document.querySelector('[data-capture-id="capture-long"]'),viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"); return viewport.clientHeight>${collapsedCaptureHeight}&&button.getAttribute("aria-expanded")==="true"&&button.textContent==="收起"; })()`), true);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').click(); true`);
  await evaluate(`document.querySelector("#capture-content").value = "快捷收下的新捕念"; const input = document.querySelector("#capture-tags"); input.value = "测试"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); true`);
  assert.equal(await evaluate(`document.querySelector("#capture-tag-list .tag-chip")?.textContent.includes("测试")`), true);
  await evaluate(`document.querySelector("#capture-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__captureSaves === 1 && document.querySelector('[data-capture-id="capture-new-1"]')`), true);
  const capturePayload = await evaluate(`window.__capturePayloads[0]`);
  assert.deepEqual(capturePayload.tags, ["测试"]);
  assert.match(capturePayload.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(Object.hasOwn(capturePayload, "occurredOn"), false);
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]').click(); true`);
  const captureEditState = await evaluate(`({ datetime: document.querySelector("#capture-date").value, tags: [...document.querySelectorAll("#capture-tag-list .tag-chip")].map(item => item.textContent.trim()) })`);
  assert.equal(captureEditState.datetime, "2026-09-27T15:08:09");
  assert.equal(captureEditState.tags.length, 2);
  await evaluate(`document.querySelector("#capture-date").value = "2026-09-27T23:45:12"; document.querySelector("#capture-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__capturePatchPayloads.length === 1`), true);
  assert.equal((await evaluate(`window.__capturePatchPayloads[0].occurredAt`)), "2026-09-27T23:45:12");
  const captureScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures.png", Buffer.from(captureScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#capture-date").getBoundingClientRect().right <= window.innerWidth`), true);
  assert.equal(await evaluate(`(() => { const card = document.querySelector('[data-capture-id="capture-1"]'), date = card.querySelector(".capture-date").getBoundingClientRect(), time = card.querySelector(".capture-entry-time").getBoundingClientRect(); return date.left < time.left && Math.abs(date.top - time.top) < 8; })()`), true);
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll('[data-capture-id="capture-long"] > .record-actions button')].map(item=>item.getBoundingClientRect()); return buttons[0].bottom<=buttons[1].top+1&&Math.abs(buttons[1].top-buttons[2].top)<2&&buttons[2].bottom-buttons[0].top<42; })()`), true);
  const captureMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures-mobile.png", Buffer.from(captureMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]').click(); true`);
  const promoted = await evaluate(`({ today: document.querySelector("#view-today").classList.contains("active"), idea: document.querySelector("#chain-idea").value, status: document.querySelector("#chain-status").textContent })`);
  assert.equal(promoted.today, true);
  assert.equal(promoted.idea, "**这个念头**先不要想完整");
  assert.match(promoted.status, /补上一个明确问题/);

  await evaluate(`document.querySelector('[data-view="journals"]').click(); document.querySelector('[data-journal-prompt]').click(); true`);
  assert.match(await evaluate(`document.querySelector("#journal-content").value`), /今天最值得留下/);
  const journalBeforeAssist = await evaluate(`document.querySelector("#journal-content").value += "我已经写下这一段。"; document.querySelector("#journal-content").value`);
  await evaluate(`document.querySelector('[data-journal-assist="lead"]').click(); true`);
  assert.equal(await waitUntil(`window.__journalAssistPayloads.length === 1 && document.querySelector("#journal-content").value.includes("AI 追加的写作锚点")`, 80, 25), true);
  const journalAfterAssist = await evaluate(`({ value: document.querySelector("#journal-content").value, payload: window.__journalAssistPayloads[0], status: document.querySelector("#journal-assist-status").textContent })`);
  assert.equal(journalAfterAssist.value.startsWith(journalBeforeAssist), true);
  assert.equal(journalAfterAssist.value.endsWith("AI 追加的写作锚点。"), true);
  assert.equal(journalAfterAssist.payload.content, journalBeforeAssist);
  assert.match(journalAfterAssist.status, /已追加/);
  await evaluate(`document.querySelector("#journal-title").value = "新日记"; document.querySelector("#journal-content").value += "\\n我写下了真实感受。"; document.querySelector("#journal-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__journalSaves === 1 && document.querySelector('[data-journal-id="journal-new-1"]')`), true);
  await evaluate(`document.querySelector('[data-journal-id="journal-1"]').open = true; document.querySelector('[data-journal-id="journal-1"] [data-journal-reflect]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector('[data-journal-id="journal-1"] .journal-reflection')`, 80, 25), true);
  assert.equal(await evaluate(`document.querySelector('[data-journal-id="journal-1"] .saved-reasoning-content').textContent`), "持久化的模型思考");
  assert.equal(await evaluate(`document.querySelector('[data-journal-id="journal-1"] .journal-original').classList.contains("commentable") && document.querySelector('[data-journal-id="journal-1"] .journal-reflection .model-answer-content>.markdown-content').classList.contains("commentable")`), true);
  await evaluate(`document.querySelector("#ai-answer-close").click(); true`);
  const journalScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-journal.png", Buffer.from(journalScreenshot.data, "base64"));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  assert.equal(await evaluate(`document.querySelectorAll(".sidebar .nav-button").length`), 9);
  const journalMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-journal-mobile.png", Buffer.from(journalMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const cardState = await evaluate(`(() => {
    const kept = document.querySelector('[data-chain-id="kept-root"]');
    const discarded = document.querySelector('[data-chain-id="discarded-root"]');
    kept.open = true;
    const actions = [...kept.querySelectorAll(".thought-actions > button")];
    return {
      hasIdeaSection: [...kept.querySelectorAll(".chain-part > b")].some(label => label.textContent === "初步想法"),
      hasIdeaPreview: Boolean(kept.querySelector(".idea-preview")),
      questionMarkdownBold: Boolean([...kept.querySelectorAll(".chain-part")].find(part => part.querySelector(":scope > b")?.textContent === "问题")?.querySelector(".markdown-content strong")),
      markdownBold: Boolean(kept.querySelector(".response-summary-markdown strong")),
      savedReasoning: kept.querySelector(".saved-reasoning pre")?.textContent,
      savedReasoningBold: Boolean(kept.querySelector(".saved-reasoning-content strong")),
      previewStartsClean: !kept.querySelector(".answer-preview").textContent.startsWith("核心判断"),
      previewMaxHeight: getComputedStyle(kept.querySelector(".response-summary-markdown")).maxHeight,
      formHidden: kept.querySelector("[data-follow-up-root]").hidden,
      keptHasKeep: Boolean(kept.querySelector('[data-disposition][data-value="kept"]')),
      keptHasDiscard: Boolean(kept.querySelector('[data-disposition][data-value="discarded"]')),
      discardedHasKeep: Boolean(discarded.querySelector('[data-disposition][data-value="kept"]')),
      discardedHasDiscard: Boolean(discarded.querySelector('[data-disposition][data-value="discarded"]')),
      followupBeforeRemark: actions.findIndex(button => button.dataset.followupCompose) < actions.findIndex(button => button.dataset.remark)
    };
  })()`);
  assert.equal(cardState.hasIdeaSection, false);
  assert.equal(cardState.hasIdeaPreview, false);
  assert.equal(cardState.questionMarkdownBold, true);
  assert.equal(cardState.markdownBold, true);
  assert.equal(cardState.savedReasoning, undefined);
  assert.equal(cardState.savedReasoningBold, true);
  assert.equal(cardState.previewStartsClean, true);
  assert.notEqual(cardState.previewMaxHeight, "none");
  assert.equal(cardState.formHidden, true);
  assert.equal(cardState.keptHasKeep, false);
  assert.equal(cardState.keptHasDiscard, true);
  assert.equal(cardState.discardedHasKeep, true);
  assert.equal(cardState.discardedHasDiscard, false);
  assert.equal(cardState.followupBeforeRemark, true);
  assert.equal(await evaluate(`document.querySelector('[data-chain-id="kept-root"] .chain-part .markdown-content').classList.contains("commentable") && document.querySelector('[data-chain-id="kept-root"] .model-answer-content>.markdown-content').classList.contains("commentable")`), true);
  assert.equal(await evaluate(`[...document.querySelectorAll("#all-thoughts .timeline-date")].filter(item => item.textContent.trim()).length`), 1);
  await evaluate(`document.querySelector('[data-view="review"]').click(); true`);
  const reviewMarkdown = await evaluate(`({ bold: Boolean(document.querySelector(".analysis-content strong")), heading: document.querySelector(".analysis-content h2")?.textContent, rawMarkers: document.querySelector(".analysis-content").textContent.includes("**") })`);
  assert.equal(reviewMarkdown.bold, true);
  assert.equal(reviewMarkdown.heading, "证据");
  assert.equal(reviewMarkdown.rawMarkers, false);
  assert.equal(await evaluate(`document.querySelector('[data-analysis-id="analysis-1"] .analysis-content').dataset.commentRoot`), "analysis:analysis-1");
  const analysisHistory = await evaluate(`(() => {
    const entries = [...document.querySelectorAll("[data-analysis-id]")];
    return { count: document.querySelector("#analysis-count").textContent, entries: entries.length, latestOpen: entries[0].open, oldOpen: entries[1].open };
  })()`);
  assert.equal(analysisHistory.count, "2 份");
  assert.equal(analysisHistory.entries, 2);
  assert.equal(analysisHistory.latestOpen, true);
  assert.equal(analysisHistory.oldOpen, false);
  await evaluate(`(() => { const text = document.querySelector('[data-analysis-id="analysis-1"] .analysis-content strong').firstChild, range = document.createRange(), selection = getSelection(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return true; })()`);
  assert.equal(await waitUntil(`!document.querySelector("#selection-tools").hidden`), true);
  await evaluate(`document.querySelector('[data-selection-action="comment"]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").hidden && document.querySelector("#comment-panel h2").textContent === "认知复盘批注"`), true);
  await evaluate(`document.querySelector("#comment-text").value = "这条判断需要继续核对反证。"; document.querySelector("#comment-composer").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__annotationSaves === 1 && document.querySelector('.analysis-content .comment-anchor')?.textContent === "总判断"`), true);
  await evaluate(`document.querySelector('[data-shenji-toggle="analysis-annotation-1"]').click(); const form = document.querySelector('[data-shenji-form="analysis-annotation-1"]'); form.elements.message.value = "这条判断可能遗漏了什么？"; form.requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__shenjiSaves === 1 && document.querySelector('[data-comment-card="analysis-annotation-1"] .shenji-answer')?.textContent.includes("神鸡判断")`), true);
  const analysisCommentScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-analysis-comment.png", Buffer.from(analysisCommentScreenshot.data, "base64"));
  await evaluate(`document.querySelector("#comment-panel-close").click(); true`);
  await evaluate(`document.querySelector('[data-analysis-id="analysis-2"] summary').click(); true`);
  assert.equal(await evaluate(`document.querySelector('[data-analysis-id="analysis-2"] .analysis-content h2').textContent`), "旧复盘");
  await evaluate(`(() => { const text = document.querySelector('[data-analysis-id="analysis-2"] .analysis-content h2').firstChild, range = document.createRange(), selection = getSelection(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return true; })()`);
  assert.equal(await waitUntil(`!document.querySelector("#selection-tools").hidden`), true);
  await evaluate(`document.querySelector('[data-selection-action="quote"]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#selection-quote-modal").hidden && document.querySelector("#selection-quote-content").value === "旧复盘" && document.querySelector("#selection-quote-source").value.includes("认知复盘")`), true);
  await evaluate(`document.querySelector("#selection-quote-content").value = "旧复盘\\n收藏"; document.querySelector("#selection-quote-tags").value = "复盘 传统"; document.querySelector("#selection-quote-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__quoteSaves === 1 && document.querySelector("#selection-quote-modal").hidden`), true);
  await evaluate(`document.querySelector(".analysis-panel").scrollIntoView({ block: "start" }); true`);
  await sleep(100);
  const reviewScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-review-markdown.png", Buffer.from(reviewScreenshot.data, "base64"));
  await evaluate(`document.querySelector('[data-view="books"]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#book-create-panel").hidden && document.querySelector("#book-create-panel").classList.contains("cold-start") && document.querySelector("#book-library").hidden`), true);
  const pastedRecognitionImage = await evaluate(`(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), value => value.charCodeAt(0));
    const file = new File([bytes], "recognition.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
    document.body.dispatchEvent(event);
    return {
      recognitionVisible: !document.querySelector("#book-recognition-preview").hidden,
      coverHidden: document.querySelector("#book-cover-preview").hidden,
      parseEnabled: !document.querySelector("#parse-book").disabled,
      title: document.querySelector("#book-recognition-upload-title").textContent,
      inputDisplay: getComputedStyle(document.querySelector("#book-recognition-image")).display
    };
  })()`);
  assert.equal(pastedRecognitionImage.recognitionVisible, true);
  assert.equal(pastedRecognitionImage.coverHidden, true);
  assert.equal(pastedRecognitionImage.parseEnabled, true);
  assert.equal(pastedRecognitionImage.title, "recognition.png");
  assert.notEqual(pastedRecognitionImage.inputDisplay, "none");
  await evaluate(`document.querySelector("#parse-book").click(); true`);
  assert.equal(await waitUntil(`window.__bookParses === 1 && document.querySelector("#book-title").value === "粘贴识别成功" && document.querySelector("#book-image-path").value === ""`), true);
  const pastedCoverImage = await evaluate(`(() => {
    document.querySelector("#book-cover-upload-box").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), value => value.charCodeAt(0));
    const file = new File([bytes], "cover.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
    document.body.dispatchEvent(event);
    return { coverVisible: !document.querySelector("#book-cover-preview").hidden, recognitionVisible: !document.querySelector("#book-recognition-preview").hidden, title: document.querySelector("#book-cover-upload-title").textContent, swapEnabled: !document.querySelector("#book-image-swap").disabled };
  })()`);
  assert.deepEqual(pastedCoverImage, { coverVisible: true, recognitionVisible: true, title: "cover.png", swapEnabled: true });
  await evaluate(`document.querySelector("#book-image-swap").click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#book-cover-upload-title").textContent === "recognition.png" && document.querySelector("#book-recognition-upload-title").textContent === "cover.png"`), true);
  assert.match(await evaluate(`document.querySelector("#book-parse-status").textContent`), /已交换/);
  const uploadScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-upload.png", Buffer.from(uploadScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.equal(await evaluate(`(() => { const button=document.querySelector("#book-image-swap"),cover=document.querySelector("#book-cover-upload-box").getBoundingClientRect(),recognition=document.querySelector("#book-recognition-upload-box").getBoundingClientRect(),swap=button.getBoundingClientRect();return cover.bottom<swap.top&&swap.bottom<recognition.top&&document.documentElement.scrollWidth<=window.innerWidth; })()`), true);
  const bookSwapMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-swap-mobile.png", Buffer.from(bookSwapMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("#book-title").value = "流行的真相：从Labubu到AI，人类为什么上瘾？（轻访谈与长期观察）"; true`);
  await evaluate(`document.querySelector("#book-reading-start").value = "2026-09-01"; true`);
  await evaluate(`document.querySelector("#book-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__bookUploads === 1 && window.__bookSaves === 1 && document.querySelector(".book-card") && document.querySelector("#book-create-panel").hidden`), true);
  assert.equal(await evaluate(`window.__bookPayloads[0].imagePath`), "/attachments/cover-1.png");
  assert.equal(await evaluate(`window.__bookPayloads[0].readingStartedOn === "2026-09-01" && window.__bookPayloads[0].readingFinishedOn === ""`), true);
  const galleryState = await evaluate(`({ libraryVisible: !document.querySelector("#book-library").hidden, cardCount: document.querySelectorAll(".book-card").length, memoryEmpty: document.querySelector(".book-memory-placeholder")?.textContent.includes("旧笔记") })`);
  assert.equal(galleryState.libraryVisible, true);
  assert.equal(galleryState.cardCount, 1);
  assert.equal(galleryState.memoryEmpty, true);
  const bookGalleryScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-gallery.png", Buffer.from(bookGalleryScreenshot.data, "base64"));
  await sleep(150);
  const longBookTitle = await evaluate(`(() => {
    const frame=document.querySelector(".book-title-frame"),title=frame.querySelector(".book-title"),track=frame.querySelector(".book-title-scroll-track"),style=getComputedStyle(title);
    return {
      overflowing:frame.classList.contains("is-overflowing"),
      rows:title.children.length,
      maxTwoLines:frame.clientHeight<=parseFloat(style.lineHeight)*2+1&&title.scrollHeight<=frame.clientHeight+1,
      travel:parseFloat(frame.style.getPropertyValue("--book-title-travel")),
      duration:parseFloat(frame.style.getPropertyValue("--book-title-duration")),
      noPageOverflow:document.documentElement.scrollWidth<=window.innerWidth
    };
  })()`);
  assert.equal(longBookTitle.overflowing, true);
  assert.equal(longBookTitle.rows, 2);
  assert.equal(longBookTitle.maxTwoLines, true);
  assert.equal(longBookTitle.travel < 0, true);
  assert.equal(longBookTitle.duration >= 8, true);
  assert.equal(longBookTitle.noPageOverflow, true);
  const longBookTitleScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-title.png", Buffer.from(longBookTitleScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  assert.equal(await evaluate(`document.querySelector(".book-title-frame").classList.contains("is-overflowing")&&document.documentElement.scrollWidth<=window.innerWidth`), true);
  const longBookTitleMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-title-mobile.png", Buffer.from(longBookTitleMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("[data-open-book]").click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#book-detail").hidden && Boolean(document.querySelector(".book-description strong")) && document.querySelector(".book-description").classList.contains("commentable") && !document.querySelector("#view-books").classList.contains("book-detail-condensed") && !document.querySelector("#book-detail").textContent.includes("书籍内页") && document.querySelector(".book-reading-range").textContent.includes("2026年9月1日")`), true);
  await evaluate(`document.querySelector("[data-book-edit]").click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#book-create-panel").hidden && document.querySelector("#book-form-title").textContent === "编辑书目" && document.querySelector("#book-title").value.includes("Labubu") && document.querySelector("#book-reading-start").value === "2026-09-01" && document.querySelector("#book-cover-preview").src.endsWith("/attachments/cover-1.png")`), true);
  await evaluate(`(() => {
    document.querySelector("#book-title").value = "编辑后的书名";
    document.querySelector("#book-reading-end").value = "2026-09-27";
    document.querySelector("#book-cover-upload-box").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), value => value.charCodeAt(0));
    const file = new File([bytes], "replacement.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file] } });
    document.body.dispatchEvent(event);
    document.querySelector("#book-form").requestSubmit();
    return true;
  })()`);
  assert.equal(await waitUntil(`window.__bookUploads === 2 && window.__bookPatches === 1 && !document.querySelector("#book-detail").hidden && document.querySelector(".book-detail-copy h2").textContent === "编辑后的书名"`), true);
  assert.equal(await evaluate(`window.__bookPayloads[1].imagePath === "/attachments/cover-2.png" && window.__bookPayloads[1].readingFinishedOn === "2026-09-27" && document.querySelector(".book-detail-cover").src.endsWith("/attachments/cover-2.png")`), true);
  await evaluate(`(() => { const form = document.querySelector("[data-book-entry-form]"); form.elements.type.value = "thought"; form.elements.favorite.value = "star"; form.elements.occurredAt.value = "2026-09-27T09:10:11"; form.elements.content.value = "## 我的理解\\n\\n这条内容值得继续生长。"; form.requestSubmit(); return true; })()`);
  assert.equal(await waitUntil(`window.__bookNoteSaves === 1 && document.querySelector('[data-note-id="note-1"]')`), true);
  const bookEntryState = await evaluate(`(() => { const entry = document.querySelector('[data-note-id="note-1"]'), card = entry.querySelector(".book-entry-card").getBoundingClientRect(), date = entry.querySelector(".book-entry-date").getBoundingClientRect(); return { heading: entry.querySelector(".book-note h2")?.textContent, type: entry.querySelector(".book-entry-type").textContent, favorite: entry.querySelector(".book-favorite").textContent, time: entry.querySelector("header time").textContent, dateOutside: date.right < card.left, commentable: entry.querySelector(".book-note").classList.contains("commentable") }; })()`);
  assert.equal(bookEntryState.heading, "我的理解");
  assert.equal(bookEntryState.type, "附加思考");
  assert.equal(bookEntryState.favorite, "🌟");
  assert.equal(bookEntryState.time, "09:10:11");
  assert.equal(bookEntryState.dateOutside, true);
  assert.equal(bookEntryState.commentable, true);
  await evaluate(`window.scrollTo({ top: 90, behavior: "auto" }); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-books").classList.contains("book-detail-condensed")`), true);
  await sleep(420);
  const condensedBookLayout = await evaluate(`(() => {
    const feature=document.querySelector(".book-feature-note").getBoundingClientRect(),hero=document.querySelector(".book-detail-hero").getBoundingClientRect(),cover=document.querySelector(".book-detail-cover").getBoundingClientRect(),heading=document.querySelector("#view-books>.page-header h1");
    return { featureLeft:feature.left,featureRight:feature.right,heroLeft:hero.left,coverWidth:cover.width,headingSize:parseFloat(getComputedStyle(heading).fontSize),featureText:document.querySelector(".book-feature-note blockquote")?.textContent||"",timelineBeforeForm:Boolean(document.querySelector(".book-timeline-section + .book-entry-form")) };
  })()`);
  assert.equal(condensedBookLayout.featureRight < condensedBookLayout.heroLeft, true);
  assert.equal(condensedBookLayout.coverWidth <= 80, true);
  assert.equal(condensedBookLayout.headingSize < 20, true);
  assert.match(condensedBookLayout.featureText, /值得继续生长/);
  assert.equal(condensedBookLayout.timelineBeforeForm, true);
  const condensedBookScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-detail-condensed.png", Buffer.from(condensedBookScreenshot.data, "base64"));
  await evaluate(`(() => { document.querySelector('[data-book-note-edit="note-1"]').click(); const form = document.querySelector("[data-book-entry-form]"); form.elements.content.value = "## 更新后的理解\\n\\n仍然值得继续生长。"; form.requestSubmit(); return true; })()`);
  assert.equal(await waitUntil(`window.__bookNotePatches === 1 && document.querySelector('[data-note-id="note-1"] .book-note h2')?.textContent === "更新后的理解"`), true);
  await evaluate(`document.querySelector('[data-book-note-favorite="note-1"]').click(); true`);
  assert.equal(await waitUntil(`window.__bookNotePatches === 2 && document.querySelector('[data-book-note-favorite="note-1"]').classList.contains("sprout")`), true);
  const bookDetailScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-detail.png", Buffer.from(bookDetailScreenshot.data, "base64"));
  await evaluate(`document.querySelector("[data-book-back]").click(); true`);
  await sleep(380);
  assert.equal(await evaluate(`document.querySelectorAll(".book-memory-bubble").length === 1 && document.querySelector("#book-create-panel").hidden && !document.querySelector("#view-books").classList.contains("book-detail-mode") && parseFloat(getComputedStyle(document.querySelector("#view-books>.page-header h1")).fontSize) > 28`), true);
  await evaluate(`document.querySelector(".book-memory-bubble").click(); true`);
  assert.equal(await waitUntil(`!document.querySelector("#book-detail").hidden && Boolean(document.querySelector("#book-note-note-1"))`), true);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector(".book-entry-form").getBoundingClientRect().right <= window.innerWidth`), true);
  const bookMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-detail-mobile.png", Buffer.from(bookMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="quotes"]').click(); true`);
  await sleep(50);
  const quoteTimeline = await evaluate(`(() => ({
    dateLabels: [...document.querySelectorAll(".quote-date")].map(item => item.textContent),
    times: [...document.querySelectorAll(".quote-entry time")].map(item => item.textContent)
  }))()`);
  assert.deepEqual(quoteTimeline.dateLabels, ["2026-09-27", "2026-09-26", "2026-09-25"]);
  assert.equal(quoteTimeline.times.length, 5);
  assert.equal(quoteTimeline.times.every(value => value.split(":").length === 3), true);
  const quoteEntryLayout = await evaluate(`(() => {
    const entry=[...document.querySelectorAll(".quote-entry")].find(item=>item.textContent.includes("第六行：般若照见实相")),meta=entry.querySelector(".quote-entry-meta"),card=entry.querySelector(".quote-entry-card"),source=meta.querySelector("cite"),time=meta.querySelector("time"),viewport=entry.querySelector(".quote-content-viewport"),button=entry.querySelector("[data-quote-expand]"),lineHeight=parseFloat(getComputedStyle(viewport).lineHeight);entry.dataset.testLongQuote="true";
    return {
      metaOutside:meta.getBoundingClientRect().bottom<=card.getBoundingClientRect().top,
      sameRow:Math.abs(source.getBoundingClientRect().top-time.getBoundingClientRect().top)<3,
      actionsOutside:meta.querySelectorAll("button").length===2&&card.querySelectorAll("[data-quote-edit],[data-quote-delete]").length===0,
      sourceEmphasis:Number(getComputedStyle(source).fontWeight)>=700&&getComputedStyle(source).color!==getComputedStyle(time).color,
      fiveLines:viewport.scrollHeight>viewport.clientHeight&&viewport.clientHeight<=lineHeight*5+1,
      justified:getComputedStyle(viewport).textAlign==="justify",
      expandVisible:!button.hidden
    };
  })()`);
  assert.deepEqual(quoteEntryLayout, { metaOutside: true, sameRow: true, actionsOutside: true, sourceEmphasis: true, fiveLines: true, justified: true, expandVisible: true });
  const collapsedQuoteHeight = await evaluate(`document.querySelector("[data-test-long-quote] .quote-content-viewport").clientHeight`);
  await evaluate(`document.querySelector("[data-test-long-quote] [data-quote-expand]").click(); true`);
  assert.equal(await evaluate(`document.querySelector("[data-test-long-quote] .quote-content-viewport").clientHeight>${collapsedQuoteHeight}&&document.querySelector("[data-test-long-quote] [data-quote-expand]").getAttribute("aria-expanded")==="true"`), true);
  await evaluate(`document.querySelector("[data-test-long-quote] [data-quote-expand]").click(); true`);
  assert.equal(await evaluate(`[...document.querySelectorAll("#quote-timeline blockquote")].every(item => item.classList.contains("commentable"))`), true);
  const quoteSky = await evaluate(`(() => { const items=[...document.querySelectorAll(".quote-bubble")],rects=items.map(item=>item.getBoundingClientRect()),overlap=rects.some((a,i)=>rects.some((b,j)=>i<j&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));return {count:items.length,overlap,distinctTags:new Set(items.flatMap(item=>[...item.querySelectorAll(".quote-tags span")].map(tag=>tag.textContent))).size,whiteSpace:getComputedStyle(items[0].querySelector("p")).whiteSpace,font:getComputedStyle(items[0].querySelector("p")).fontFamily,ids:items.map(item=>item.dataset.quoteId).join(",")}; })()`);
  assert.deepEqual({count:quoteSky.count,overlap:quoteSky.overlap,whiteSpace:quoteSky.whiteSpace},{count:3,overlap:false,whiteSpace:"pre-wrap"});
  assert.equal(quoteSky.distinctTags>=3,true);
  assert.match(quoteSky.font,/Kaiti|KaiTi|STKaiti/);
  await evaluate(`document.querySelector("#quote-refresh").click(); true`);
  assert.notEqual(await evaluate(`[...document.querySelectorAll(".quote-bubble")].map(item=>item.dataset.quoteId).join(",")`),quoteSky.ids);
  await evaluate(`document.querySelector("#quote-sky").scrollIntoView({block:"start"}); true`);await sleep(100);
  const quoteSkyScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-quote-sky.png",Buffer.from(quoteSkyScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(120);
  assert.equal(await evaluate(`(() => { const items=[...document.querySelectorAll(".quote-bubble")],rects=items.map(item=>item.getBoundingClientRect());return document.documentElement.scrollWidth<=window.innerWidth&&!rects.some((a,i)=>rects.some((b,j)=>i<j&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)); })()`),true);
  const quoteSkyMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-quote-sky-mobile.png",Buffer.from(quoteSkyMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector("#quote-source").value = "新来源"; document.querySelector("#quote-content").value = "新收藏\\n第二行"; document.querySelector("#quote-tags").value = "行动 摘录"; document.querySelector("#quote-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__quoteSaves === 2 && document.querySelector("#quote-source").value === "" && document.querySelector("#quote-content").value === "" && document.querySelector("#quote-timeline").textContent.includes("新收藏")`), true);
  assert.equal(await evaluate(`document.querySelector("#toast").textContent`), "善言已收藏");
  await evaluate(`document.querySelector('[data-quote-id="quote-new-2"] [data-quote-edit]').click(); document.querySelector("#quote-tags").value = "更新"; document.querySelector("#quote-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__quotePatches === 1 && document.querySelector('[data-quote-id="quote-new-2"] .quote-tags')?.textContent.includes("更新")`),true);
  await evaluate(`document.querySelector("#quote-timeline").scrollIntoView({ block: "start" }); true`);
  const quoteScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-quote-timeline.png", Buffer.from(quoteScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(120);
  assert.equal(await evaluate(`(() => { const entry=[...document.querySelectorAll(".quote-entry")].find(item=>item.textContent.includes("第六行：般若照见实相")),meta=entry.querySelector(".quote-entry-meta").getBoundingClientRect(),card=entry.querySelector(".quote-entry-card").getBoundingClientRect(),source=entry.querySelector("cite").getBoundingClientRect(),tools=entry.querySelector(".quote-entry-tools").getBoundingClientRect();return document.documentElement.scrollWidth<=window.innerWidth&&meta.bottom<=card.top&&Math.abs(source.top-tools.top)<3; })()`),true);
  const quoteTimelineMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-quote-timeline-mobile.png",Buffer.from(quoteTimelineMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-view="thoughts"]').click(); true`);
  await evaluate(`(() => { const card = document.querySelector('[data-chain-id="kept-root"]'); card.querySelector(".response-entry.original").open = true; card.querySelector(".saved-reasoning").open = true; card.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(100);
  const reasoningScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-saved-reasoning.png", Buffer.from(reasoningScreenshot.data, "base64"));
  await evaluate(`(() => { const card = document.querySelector('[data-chain-id="kept-root"]'); card.querySelector(".saved-reasoning").open = false; card.querySelector(".response-entry.original").open = false; return true; })()`);
  await evaluate(`document.querySelector('[data-chain-id="kept-root"] [data-followup-compose]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector('[data-chain-id="kept-root"] [data-follow-up-root]').hidden`), true);
  await evaluate(`document.querySelector('[data-chain-id="kept-root"]').scrollIntoView({ block: "start" }); true`);
  await sleep(100);
  const cardScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-thought-card.png", Buffer.from(cardScreenshot.data, "base64"));
  await evaluate(`document.querySelector("#chain-question").value = "测试流式弹窗"; document.querySelector("#draft-answer-button").click(); true`);
  assert.equal(await waitUntil(`window.__reasoningChunks === 1 && document.querySelector("#ai-answer-reasoning-content").scrollHeight > document.querySelector("#ai-answer-reasoning-content").clientHeight`, 40, 10), true);
  await evaluate(`document.querySelector("#ai-answer-reasoning-content").scrollTop = 0; true`);
  assert.equal(await waitUntil(`window.__reasoningChunks === 2`, 40, 10), true);
  assert.equal(await evaluate(`document.querySelector("#ai-answer-reasoning-content").scrollTop`), 0);
  assert.equal(await waitUntil(`document.querySelector("#ai-answer-result").textContent.includes("结论")`, 80, 25), true);
  const streaming = await evaluate(`(() => ({
    reasoning: document.querySelector("#ai-answer-reasoning-content").textContent,
    reasoningOpen: document.querySelector("#ai-answer-reasoning").open,
    outputHidden: document.querySelector("#ai-answer-output").hidden,
    activeStep: document.querySelector("#ai-answer-progress li.active")?.dataset.step,
    answer: document.querySelector("#ai-answer-result").textContent
  }))()`);
  assert.match(streaming.reasoning, /思考行 1[\s\S]*再形成判断。/);
  assert.equal(streaming.reasoningOpen, false);
  assert.equal(streaming.outputHidden, false);
  assert.equal(streaming.activeStep, "answer");
  assert.match(streaming.answer, /结论/);

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-answer-modal.png", Buffer.from(screenshot.data, "base64"));
  await evaluate(`document.querySelector("#ai-answer-close").click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#chain-answer").value.includes("后台完成") && !document.querySelector("#draft-answer-button").disabled`, 80, 25), true);
  assert.equal(await evaluate(`Boolean(document.querySelector("#ai-answer-reasoning-content strong"))`), true);
  const completed = await evaluate(`(() => ({
    modalHidden: document.querySelector("#ai-answer-modal").hidden,
    draft: document.querySelector("#chain-answer").value,
    buttonDisabled: document.querySelector("#draft-answer-button").disabled
  }))()`);
  assert.equal(completed.modalHidden, true);
  assert.equal(completed.draft, "**结论**：后台完成。");
  assert.equal(completed.buttonDisabled, false);
  await evaluate(`document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__thoughtSaves === 1 && !document.querySelector('#chain-form [type="submit"]').disabled`, 40, 25), true);
  assert.equal(await evaluate(`window.__savedPayloads[0].modelReasoning`), "持久化的模型思考");
  await evaluate(`document.querySelector("#chain-question").value = "第一条自动回答"; document.querySelector("#chain-answer").value = ""; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`document.querySelector("#ai-answer-modal").dataset.busy === "true" && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  assert.match(await evaluate(`document.querySelector("#chain-status").textContent`), /后台生成/);
  await evaluate(`document.querySelector("#ai-answer-close").click(); document.querySelector("#chain-question").value = "第二条不应被阻塞"; document.querySelector("#chain-answer").value = "手写回答"; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__thoughtSaves === 3 && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  await evaluate(`document.querySelector('[data-view="settings"]').click(); true`);
  assert.equal(await evaluate(`document.querySelectorAll("[data-profile-model]").length === 4 && document.querySelectorAll("[data-profile-effort]").length === 4 && document.querySelectorAll("[data-ai-scenario]").length === 12`), true);
  await evaluate(`document.querySelector('[data-profile-model="lite"]').value = "deepseek-v4-pro"; document.querySelector('[data-profile-effort="lite"]').value = "max"; document.querySelector('[data-ai-scenario="diaryLead"]').value = "ultra"; document.querySelector("#llm-settings-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__settingsSaves === 1`), true);
  const savedSettings = await evaluate(`window.__lastSettings = undefined; ({ model: document.querySelector('[data-profile-model="lite"]').value, effort: document.querySelector('[data-profile-effort="lite"]').value, scene: document.querySelector('[data-ai-scenario="diaryLead"]').value })`);
  assert.deepEqual(savedSettings, { model: "deepseek-v4-pro", effort: "max", scene: "ultra" });
  await evaluate(`document.querySelector("#ai-answer-modal").hidden = true; document.querySelector("#edit-chain-modal").hidden = true; document.querySelector(".settings-card").scrollIntoView({ block: "start" }); true`);
  await sleep(300);
  const settingsScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-tier-settings.png", Buffer.from(settingsScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  const settingsMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-tier-settings-mobile.png", Buffer.from(settingsMobileScreenshot.data, "base64"));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".settings-about-link")).display !== "none"`), true);
  await evaluate(`document.querySelector(".settings-about-link").click(); true`);
  const aboutMobile = await evaluate(`({
    active: document.querySelector("#view-about").classList.contains("active"),
    loopSteps: document.querySelectorAll(".about-loop li").length,
    recordTypes: document.querySelectorAll(".about-records article").length,
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    footerHidden: getComputedStyle(document.querySelector(".sidebar-footer")).display === "none"
  })`);
  assert.deepEqual(aboutMobile, { active: true, loopSteps: 5, recordTypes: 4, noOverflow: true, footerHidden: true });
  await evaluate(`window.scrollTo(0, 0); true`);
  await sleep(300);
  await evaluate(`document.querySelector("#toast").hidden = true; true`);
  const aboutMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-about-mobile.png", Buffer.from(aboutMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="today"]').click(); document.querySelector(".about-button").click(); true`);
  const aboutDesktop = await evaluate(`(() => {
    const button = document.querySelector(".about-button").getBoundingClientRect();
    const local = document.querySelector(".local-note").getBoundingClientRect();
    return {
      active: document.querySelector("#view-about").classList.contains("active") && document.querySelector(".about-button").classList.contains("active"),
      heading: document.querySelector("#view-about h1").textContent,
      proposition: document.querySelector(".about-proposition").textContent,
      lowPresencePosition: button.top < local.top && local.bottom < window.innerHeight,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth
    };
  })()`);
  assert.equal(aboutDesktop.active, true);
  assert.equal(aboutDesktop.heading, "此刻");
  assert.match(aboutDesktop.proposition, /零散记录/);
  assert.equal(aboutDesktop.lowPresencePosition, true);
  assert.equal(aboutDesktop.noOverflow, true);
  await evaluate(`window.scrollTo(0, 0); true`);
  await sleep(300);
  await evaluate(`document.querySelector("#toast").hidden = true; true`);
  const aboutDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-about-desktop.png", Buffer.from(aboutDesktopScreenshot.data, "base64"));
  console.log("UI regression passed: diary assistance, tiered settings, responsive navigation, About page, persisted reasoning, and concurrent answer streaming.");
} finally {
  cdp?.socket.close();
  chrome.kill("SIGKILL");
  await fs.rm(profile, { recursive: true, force: true });
}
