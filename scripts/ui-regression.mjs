import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";
import { healthImageFixtures } from "./fixtures/health-images.mjs";

const CHROME = resolveHeadlessBrowser();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIGURED_APP_URL = process.env.APP_URL || "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TEST_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR2nWQAAAABJRU5ErkJggg==", "base64");

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startStaticServer() {
  const mime = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8" };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1"), relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      if (url.pathname.startsWith("/attachments/")) {
        response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        response.end(TEST_IMAGE);
        return;
      }
      const file = path.resolve(PUBLIC_DIR, relative);
      if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return response.writeHead(403).end("Forbidden");
      const data = await fs.readFile(file);
      response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      response.end(data);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
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
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
}

const mockFetch = `
(() => {
  const NativeDate = Date; let fixedNow = new NativeDate("2026-09-27T12:00:17+08:00").getTime();
  window.__advanceNow = ms => { fixedNow += ms; };
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
  });
  window.MediaRecorder = class extends EventTarget {
    static isTypeSupported() { return true; }
    constructor(stream, options = {}) { super(); this.stream = stream; this.mimeType = options.mimeType || "audio/webm"; this.state = "inactive"; }
    start() { this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("dataavailable", { data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) }));
        this.dispatchEvent(new Event("stop"));
      });
    }
  };
  window.__speechRequests = [];
  window.__speechPlays = [];
  window.__delaySpeech = false;
  window.__releaseSpeech = null;
  window.Audio = class extends EventTarget {
    constructor(src = "") { super(); this.src = src; this.paused = true; }
    play() { this.paused = false; window.__speechPlays.push(this.src); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() {}
  };
  const nativeFetch = window.fetch.bind(window);
  const json = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
  const v1 = (data, meta = {}) => json({ data, error: null, meta: { traceId: "ui-g2", ...meta } });
  const eventTime = payload => {
    const date=payload.timeMode==="now"||!payload.occurredAt?new Date():new Date(payload.occurredAt);
    return {occurredAt:date.toISOString(),occurredOn:[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-")};
  };
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
  window.__conflictThoughtCreate = false;
  window.__failThoughtCreateNetwork = false;
  window.__captureSaves = 0;
  window.__capturePayloads = [];
  window.__capturePatchPayloads = [];
  window.__delayCapturePatch = false;
  window.__releaseCapturePatch = null;
  window.__failCapturePatchNetwork = false;
  window.__loseCapturePatchResponse = false;
  window.__conflictCapturePatch = false;
  window.__journalSaves = 0;
  window.__journalPatches = 0;
  window.__journalDraft = { journalId: "journal-1", title: "跨端恢复的标题", content: "跨端恢复的正文。", updatedAt: "2026-09-27T08:18:19.000Z" };
  window.__journalDraftSaves = 0;
  window.__journalDraftPayloads = [];
  window.__journalAssistPayloads = [];
  window.__bookParses = 0;
  window.__bookUploads = 0;
  window.__keepsakeUploads = 0;
  window.__contentImageUploads = 0;
  window.__healthUploads = { sleep: 0, heartRate: 0, weight: 0, exercise: 0 };
  window.__imageDiscards = [];
  window.__bookSaves = 0;
  window.__bookPatches = 0;
  window.__bookPayloads = [];
  window.__bookNoteSaves = 0;
  window.__bookNotePatches = 0;
  window.__failBookCreateStatus = 0;
  window.__failBookNoteStatus = 0;
  window.__quoteSaves = 0;
  window.__quotePatches = 0;
  window.__keepsakeOriginalReads = 0;
  window.__settingsSaves = 0;
  window.__aiCostPlanSaves = 0;
  window.__commercializationSaves = 0;
  window.__usernameChanges = 0;
  window.__passwordChanges = 0;
  window.__accountUser = { id: "user-1", username: "owner", createdAt: "2026-09-27T00:00:00.000Z" };
  window.__dailySaves = 0;
  window.__dailyPatches = 0;
  window.__checkinSaves = 0;
  window.__checkinPayloads = [];
  window.__checkinPatches = 0;
  window.__delayCheckinCreate = false;
  window.__releaseCheckinCreate = null;
  window.__failCheckinCreate = false;
  window.__conflictCheckinCreate = false;
  window.__thoughtPrompts = 0;
  window.__healthParses = 0;
  window.__healthParsePayloads = [];
  window.__failWeightReferenceDate = "";
  window.__delayParseKind = "";
  window.__releaseParse = null;
  window.__tamperParseField = "";
  window.__holdAiTasks = false;
  window.__delayImageTaskCreate = false;
  window.__releaseImageTaskCreate = null;
  window.__delaySecondState = false;
  window.__failNextStateRefresh = false;
  window.__operationReceipts = {};
  window.__receiptLookups = 0;
  window.__failThoughtDeleteNetwork = false;
  window.__conflictThoughtDelete = false;
  window.__releaseSecondState = null;
  window.__delayLogout = false;
  window.__releaseLogout = null;
  window.__delayLogin = false;
  window.__releaseLogin = null;
  window.__delayActionCreate = false;
  window.__releaseActionCreate = null;
  window.__failActionConflict = false;
  window.__delayActionUpdate = false;
  window.__releaseActionUpdate = null;
  window.__delayActionDelete = false;
  window.__releaseActionDelete = null;
  window.__failActionNetwork = false;
  window.__actionListVersion = 1;
  window.__actionListStatus = "todo";
  window.__delayHabitCreate = false;
  window.__releaseHabitCreate = null;
  window.__delayFeedbackCreate = false;
  window.__releaseFeedbackCreate = null;
  window.__failNextActionRefresh = false;
  window.__delayActionList = false;
  window.__releaseActionList = null;
  window.__actionListTitle = "完成 G2 界面回归";
  window.__stateRequests = 0;
  window.__syncCursor = 0;
  window.__notificationReads = 0;
  window.__taskReads = 0;
  window.__annotationSaves = 0;
  window.__thoughtAnnotationSaves = 0;
  window.__shenjiSaves = 0;
  window.__onboardingSaves = 0;
  window.__onboardingSchemaRequests = 0;
  window.__onboardingSchemaAvailable = false;
  window.__savedPayloads = [];
  window.__aiTasks = [{
    id: "task-capture-failed",
    kind: "captureTranscription",
    resourceType: "capture",
    targetId: "capture-failed",
    inputVersion: 0,
    status: "failed",
    createdAt: "2026-09-27T06:55:00.000Z",
    completedAt: "2026-09-27T06:56:00.000Z",
    resultId: "",
    error: "语音服务暂时不可用"
  }];
  window.__taskResults = {};
  window.__notifications = [];
  window.__testWorkspaceMode = "simulation";
  window.__lazySimulationEmpty = false;
  window.__failLocalModeTimeout = false;
  window.__localHydrateRequests = [];
  window.__keepsakeObservers = [];
  window.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; window.__keepsakeObservers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
    trigger() { if (this.target) this.callback([{ isIntersecting: true, target: this.target }]); }
  };
  window.__localTestConfig = { enabled: true, upstreamConfigured: true, mode: "cold", snapshotAt: "", sourceUser: null, recordCount: 0, loadedScopes: [], loadedCollections: [] };
  window.__onboarding = { status: "dismissed", questionnaireVersion: 1, questionnaireMode: "quick", answers: {}, profile: {}, interests: [], material: "", understanding: "" };
  window.__onboardingSchema = {
    version: 1,
    modes: [{ id: "quick", label: "快速版", questionCount: 8 }, { id: "detailed", label: "详细版", questionCount: 18 }],
    interests: ["身心状态", "学习成长", "工作创造", "哲学"],
    questions: Array.from({ length: 18 }, (_, index) => ({
      id: "question-" + (index + 1),
      tier: index < 8 ? "quick" : "detailed",
      dimension: index < 4 ? "世界观" : "价值判断",
      prompt: "冷启动判断题 " + (index + 1),
      options: [{ value: "a", label: "选项 A" }, { value: "b", label: "选项 B" }]
    }))
  };
  window.__deleteRequests = 0;
  window.__imageUploads = [];
  window.__keepsakePayloads = [];
  window.__keepsakeUploadPayloads = [];
  window.__keepsakeUploadKeys = [];
  window.__keepsakeCreateKeys = [];
  window.__failKeepsakeCreateOnce = false;
  window.__keepsakes = [
    {
      id: "keepsake-1", createdAt: "2026-09-27T01:30:00.000Z", occurredAt: "2026-09-27T09:30:00.000Z", occurredOn: "2026-09-27",
      title: "旧展览票", category: "纸品", note: "在秋天看过的一场展，背面还留着同行人的一句话。", tags: ["展览", "同行"], source: "auto", edgeExpansion: 8,
      originalPath: "/attachments/keepsake-1.original.png", cutoutPath: "",
      thumbPath: "/attachments/keepsake-1.thumb.webp", displayPath: "/attachments/keepsake-1.display.webp",
      editPath: "/attachments/keepsake-1.edit.webp", alphaMaskPath: "/attachments/keepsake-1.alphaMask.webp", mediaVersion: 1
    },
    {
      id: "keepsake-2", createdAt: "2026-09-26T01:30:00.000Z", occurredAt: "2026-09-26T18:20:00.000Z", occurredOn: "2026-09-26",
      title: "咖啡纸袋", category: "纸品", note: "第一次独自去那条街。", tags: ["散步"], source: "auto", edgeExpansion: 8,
      originalPath: "/attachments/keepsake-2.original.png", cutoutPath: "",
      thumbPath: "/attachments/keepsake-2.thumb.webp", displayPath: "/attachments/keepsake-2.display.webp",
      editPath: "/attachments/keepsake-2.edit.webp", alphaMaskPath: "/attachments/keepsake-2.alphaMask.webp", mediaVersion: 1
    },
    {
      id: "keepsake-3", createdAt: "2026-09-25T01:30:00.000Z", occurredAt: "2026-09-25T14:05:00.000Z", occurredOn: "2026-09-25",
      title: "车站小票", category: "小票", note: "", tags: ["远行"], source: "auto", edgeExpansion: 8,
      originalPath: "/attachments/keepsake-3.original.png", cutoutPath: "",
      thumbPath: "/attachments/keepsake-3.thumb.webp", displayPath: "/attachments/keepsake-3.display.webp",
      editPath: "/attachments/keepsake-3.edit.webp", alphaMaskPath: "/attachments/keepsake-3.alphaMask.webp", mediaVersion: 1
    }
  ];
  window.__keepsakes.push(...Array.from({ length: 22 }, (_, index) => {
    const day = String(22 - index).padStart(2, "0");
    return {
      id: "keepsake-page-" + (index + 1), createdAt: "2026-08-" + day + "T01:30:00.000Z", occurredAt: "2026-08-" + day + "T09:30:00.000Z", occurredOn: "2026-08-" + day,
      title: "分页小物 " + (index + 1), category: "其他", note: "", tags: ["分页"], source: "manual", edgeExpansion: 8,
      originalPath: "/attachments/keepsake-page-" + (index + 1) + ".original.png", cutoutPath: "",
      thumbPath: "/attachments/keepsake-page-" + (index + 1) + ".thumb.webp", displayPath: "/attachments/keepsake-page-" + (index + 1) + ".display.webp",
      editPath: "/attachments/keepsake-page-" + (index + 1) + ".edit.webp", alphaMaskPath: "/attachments/keepsake-page-" + (index + 1) + ".alphaMask.webp", mediaVersion: 1
    };
  }));
  window.__captures = [
    {
      id: "capture-1", createdAt: "2026-09-27T01:12:00.000Z", occurredAt: "2026-09-27T07:08:09.000Z", occurredOn: "2026-09-27",
      content: "**这个念头**先不要想完整", tags: ["灵感", "可展开"], version: 1
    },
    {
      id: "capture-long", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T07:05:09.000Z", occurredOn: "2026-09-27",
      content: "这是一条需要验证四行折叠的长捕念。\\n- 第一项内容\\n- 第二项内容\\n- 第三项内容\\n- 第四项内容\\n- 第五项内容\\n- 第六项内容", tags: ["职业规划"],
      audio: { attachmentPath: "/attachments/capture-voice.m4a", mimeType: "audio/mp4", bytes: 4096, durationMs: 1250 },
      transcription: { status: "unconfigured", provider: "", rawText: "", polishedText: "", updatedAt: "", errorCode: "ASR_NOT_CONFIGURED" }, version: 1
    },
    {
      id: "capture-failed", createdAt: "2026-09-27T01:09:00.000Z", occurredAt: "2026-09-27T07:04:09.000Z", occurredOn: "2026-09-27",
      content: "这条原音可以播放，但转写暂时失败。", tags: ["语音"],
      audio: { attachmentPath: "/attachments/capture-failed.m4a", mimeType: "audio/mp4", bytes: 3072, durationMs: 980 },
      transcription: { status: "failed", provider: "volcengine-seedasr-2.0", rawText: "", polishedText: "", updatedAt: "2026-09-27T06:56:00.000Z", errorCode: "ASR_PROVIDER_FAILED" }, version: 1
    }
  ];
  window.__journals = [{ id: "journal-1", createdAt: "2026-09-27T01:13:00.000Z", occurredAt: "2026-09-27T08:13:14.000Z", occurredOn: "2026-09-27", title: "今天的一件小事", content: "事实是事情发生了。\\\\n\\\\n**我的感受**还需要慢慢辨认。", tags: ["日常"], reflections: [], version: 1 }];
  window.__quotes = [
    { id: "quote-1", createdAt: "2026-09-27T02:10:11.000Z", occurredAt: "2026-09-27T06:10:11.000Z", occurredOn: "2026-09-27", source: "AI总结", content: "第一行：布施对治悭贪。\\n第二行：持戒对治毁犯。\\n第三行：忍辱对治嗔恚。\\n第四行：精进对治懈怠。\\n第五行：禅定对治散乱。\\n第六行：般若照见实相。", tags: ["修行"], version: 1 },
    { id: "quote-2", createdAt: "2026-09-27T01:10:11.000Z", occurredAt: "2026-09-27T05:10:11.000Z", occurredOn: "2026-09-27", source: "来源二", content: "第一行\\n第二行", tags: ["行动"], version: 1 },
    { id: "quote-3", createdAt: "2026-09-26T01:10:11.000Z", occurredAt: "2026-09-26T05:10:11.000Z", occurredOn: "2026-09-26", source: "来源三", content: "前一日", tags: ["文化"], version: 1 },
    { id: "quote-4", createdAt: "2026-09-25T01:10:11.000Z", occurredAt: "2026-09-25T05:10:11.000Z", occurredOn: "2026-09-25", source: "来源四", content: "第四条", tags: ["身体"], version: 1 }
  ];
  window.__analyses = [
    { id: "analysis-1", createdAt: "2026-09-27T01:20:00.000Z", reason: "weekly-background", content: "**总判断**\\n\\n---\\n\\n## 证据", reasoningContent: "### 分析过程", annotations: [], annotationDrift: [] },
    { id: "analysis-2", createdAt: "2026-09-20T01:20:00.000Z", reason: "manual", content: "## 旧复盘\\n\\n历史内容仍然存在。", reasoningContent: "旧分析过程", annotations: [], annotationDrift: [] }
  ];
  window.__books = [];
  window.__dailyRecords = [
    { id: "weight-existing", type: "weight", createdAt: "2026-09-26T01:00:00.000Z", occurredAt: "2026-09-26T07:30:00.000Z", occurredOn: "2026-09-26", source: "manual", attachmentPaths: [], measuredWeight: 70, clothing: "light", adjustmentMean: .5, adjustedWeight: 69.5, lower95: 69.1, upper95: 69.9, bodyFatPercent: 18.4, muscleMass: 54.2, version: 1 },
    { id: "heart-summary", type: "heartRate", createdAt: "2026-09-27T02:00:00.000Z", occurredAt: "2026-09-27T08:00:00.000Z", occurredOn: "2026-09-27", source: "screenshot", attachmentPaths: ["/attachments/heart-existing.png"], minimum: 46, maximum: 82, average: 60, resting: 52, sleepAverage: 50, trendAnalysis: "凌晨下降，午后与晚间抬升。", version: 1 },
    { id: "heart-range-only", type: "heartRate", createdAt: "2026-09-26T02:00:00.000Z", occurredAt: "2026-09-26T08:00:00.000Z", occurredOn: "2026-09-26", source: "manual", minimum: 50, maximum: 90, average: null, resting: null, sleepAverage: null, trendAnalysis: "", version: 1 },
    { id: "exercise-legacy", type: "exercise", createdAt: "2026-09-25T01:00:00.000Z", occurredAt: "2026-09-25T07:30:00.000Z", occurredOn: "2026-09-25", source: "manual", attachmentPaths: [], exerciseType: "散步", description: "旧记录里的轻松感受", version: 1 }
  ];
  window.__checkins = [
    { id: "checkin-latest", createdAt: "2026-09-27T08:00:00.000Z", occurredAt: "2026-09-27T08:00:00.000Z", occurredOn: "2026-09-27", mood: 4, energy: 2, stress: 4, sleep: 5, factors: [], custom: {}, notes: {}, version: 1 },
    { id: "checkin-previous", createdAt: "2026-09-26T08:00:00.000Z", occurredAt: "2026-09-26T08:00:00.000Z", occurredOn: "2026-09-26", mood: 3, energy: 3, stress: 3, sleep: 2, factors: [], custom: {}, notes: {}, version: 1 }
  ];
  window.__contextReceipt = {
    version: "2026.10.01.1",
    generatedAt: "2026-09-27T12:00:00.000Z",
    timeWindow: { from: "2026-09-26", to: "2026-09-27" },
    tokenBudget: { limit: 20000, estimatedUsed: 860, remaining: 19140, estimation: "conservative-cjk-v1" },
    sourceCount: 3,
    sources: [
      { id: "thought:kept-root:question:kept-root", resourceType: "thought", resourceId: "kept-root", recordType: "思绪问题", informationType: "user_viewpoint", informationTypeLabel: "用户观点", occurredAt: "2026-09-27T04:09:00.000Z", occurredOn: "2026-09-27", version: 1, location: { view: "thoughts", targetId: "kept-root", rootId: "kept-root", targetKey: "question:kept-root", occurredOn: "2026-09-27" } },
      { id: "checkin:checkin-latest", resourceType: "checkin", resourceId: "checkin-latest", recordType: "此刻状态", informationType: "user_fact", informationTypeLabel: "用户事实", occurredAt: "2026-09-27T08:00:00.000Z", occurredOn: "2026-09-27", version: 1, location: { view: "today", targetId: "checkin-latest", rootId: "", targetKey: "", occurredOn: "2026-09-27" } },
      { id: "capture:deleted-source", resourceType: "capture", resourceId: "deleted-source", recordType: "念起", informationType: "user_viewpoint", informationTypeLabel: "用户观点", occurredAt: "2026-09-26T08:00:00.000Z", occurredOn: "2026-09-26", version: 1, location: { view: "captures", targetId: "deleted-source", rootId: "", targetKey: "", occurredOn: "2026-09-26" } }
    ]
  };
  window.__personalContext = {
    ...window.__contextReceipt,
    sourceCount: 2,
    sources: window.__contextReceipt.sources.slice(0,2).map(source => ({ ...source, excerpt: source.resourceType==="thought"?"没有初步想法的问题":"情绪4 / 精力2 / 压力4 / 睡眠5" })),
    readOnly: true,
    disclosure: "概要由当前账户内仍有效的记录实时投影。",
    conclusions: [
      { id: "facts", informationType: "user_fact", informationTypeLabel: "用户事实", title: "近期状态", text: "最近一次状态记录已保留。", sourceIds: ["checkin:checkin-latest"], sampleNote: "缺失记录不代表没有发生。" },
      { id: "views", informationType: "user_viewpoint", informationTypeLabel: "用户观点", title: "近期思考", text: "没有初步想法的问题", sourceIds: ["thought:kept-root:question:kept-root"], sampleNote: "逐条呈现用户原文。" },
      { id: "summary", informationType: "model_summary", informationTypeLabel: "模型摘要", title: "初始理解", text: "这只是可修正的初始理解。", sourceIds: [], sampleNote: "不是用户事实。" }
    ]
  };
  window.__thoughts = [
    { id: "answer-kept", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T04:10:00.000Z", occurredOn: "2026-09-27", type: "answer", content: "**核心判断**\\n第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行", attachmentPaths: ["/attachments/thought-block.png"], modelDraft: "**核心判断**\\n第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行", editedFromModel: false, origin: "deepseek", reasoningContent: "**持久化**的模型思考", contextReceipt: window.__contextReceipt, tags: [], relatedTo: "kept-root", disposition: "kept" },
    { id: "kept-root", createdAt: "2026-09-27T01:09:00.000Z", occurredAt: "2026-09-27T04:09:00.000Z", occurredOn: "2026-09-27", type: "question", content: "没有**初步想法**的问题", attachmentPaths: ["/attachments/thought-root.png"], tags: ["待回看", "商业"], relatedTo: null, disposition: "kept", remarks: [], followUps: [], annotations: [], annotationDrift: [], version: 1 },
    { id: "discarded-root", createdAt: "2026-09-27T02:08:00.000Z", occurredAt: "2026-09-27T04:08:00.000Z", occurredOn: "2026-09-27", type: "question", content: "已舍弃的问题", tags: [], relatedTo: null, disposition: "discarded", remarks: [], followUps: [], annotations: [], annotationDrift: [], version: 1 }
  ];
  window.__completeAiTask = (task, payload = {}) => {
    task.status = "succeeded";
    task.completedAt = new Date().toISOString();
    let result = null;
    if (task.kind === "thoughtAnswer") {
      result = { id: "answer-" + task.id, createdAt: task.completedAt, occurredAt: task.completedAt, occurredOn: task.completedAt.slice(0, 10), type: "answer", content: "**即时回答**：后台结果已局部合并。", modelDraft: "**即时回答**：后台结果已局部合并。", editedFromModel: false, origin: "deepseek", reasoningContent: "后台持久化思考", contextReceipt: window.__contextReceipt, tags: [], relatedTo: task.targetId, sourceTaskId: task.id, version: 1 };
      window.__thoughts.unshift(result);
    } else if (task.kind === "followUpAnswer") {
      const root = window.__thoughts.find(item => item.id === task.targetId), followUp = root?.followUps?.find(item => item.id === task.subtargetId);
      if (followUp) result = Object.assign(followUp, { answer: "后台追问回答", reasoningContent: "后台持久化思考", answeredAt: task.completedAt, sourceTaskId: task.id });
    } else if (task.kind === "annotationShenji") {
      const collections = { analysis: window.__analyses, thought: window.__thoughts }, root = collections[task.resourceType]?.find(item => item.id === task.targetId), annotation = root?.annotations?.find(item => item.id === task.subtargetId);
      result = { id: "reply-" + task.id, createdAt: task.completedAt, message: payload.payload?.message || "", answer: "**神鸡判断**：这条复盘需要保留反证。", reasoningContent: "核对复盘上下文。", sourceTaskId: task.id };
      if (annotation) annotation.shenji = [result];
      window.__shenjiSaves += 1;
    } else if (task.kind === "contentImageUnderstanding") {
      const targetType=task.contentTargetType,targetId=task.contentTargetId;
      let resource=targetType==="capture"?window.__captures.find(item=>item.id===targetId):targetType==="thoughtRoot"?window.__thoughts.find(item=>item.id===targetId&&item.type==="question"):targetType==="thoughtBlock"?window.__thoughts.find(item=>item.id===targetId&&item.type!=="question"):null;
      if(targetType==="comment"){const collections={analysis:window.__analyses,thought:window.__thoughts,capture:window.__captures},root=collections[task.resourceType]?.find(item=>item.id===task.targetId);resource=root?.annotations?.find(item=>item.id===targetId)}
      result={id:"understanding-"+task.id,kind:"imageUnderstanding",content:"**可见内容**：图片中有一页手写笔记。",sourceAttachmentPaths:[...(resource?.attachmentPaths||[])],sourceVersion:resource?.version||1,sourceTaskId:task.id,origin:"ai-derived",createdAt:task.completedAt};
      if(resource){resource.imageUnderstandings||=[];resource.imageUnderstandings.push(result);resource.version=(resource.version||1)+1}
    }
    if (result) {
      task.resultId = result.id;
      window.__taskResults[task.id] = result;
    }
    const notification = window.__notifications.find(item => item.taskId === task.id);
    if (notification) Object.assign(notification, { status: "succeeded", message: { thoughtAnswer: "回答已生成", followUpAnswer: "追问回答已生成", annotationShenji: "批注回复已生成", contentImageUnderstanding: "图片理解已生成" }[task.kind], updatedAt: task.completedAt, readAt: "" });
  };
  const aiCostScenes = ["thoughtPrompt","thoughtDraft","thoughtAnswer","followUpAnswer","chat","diaryLead","diaryStructure","diaryTopic","diaryReflection","annotationShenji","analysis","bookRecognition","healthRecognition","contentImageUnderstanding","capturePolish"];
  const aiCostProScenes = new Set(["thoughtDraft","thoughtAnswer","followUpAnswer","chat","diaryTopic","diaryReflection","annotationShenji","analysis"]);
  window.__aiCostPlan = {
    version: 1, updatedAt: "", monthlyBudgetCny: 30, contingencyPct: 15, cnyPerUsd: 7.2,
    scenarios: aiCostScenes.map((scene,index)=>({scene,enabled:true,model:aiCostProScenes.has(scene)?"deepseek-v4-pro":"deepseek-flash",pricingPeriod:"peak",callsPerMonth:index===2?20:8,avgInputTokens:index===2?24000:8000,cacheHitPct:20,avgReasoningTokens:aiCostProScenes.has(scene)?3000:500,avgAnswerTokens:aiCostProScenes.has(scene)?1500:400}))
  };
  const commercialValidationBase = { participants: 5, rewardPerParticipantCny: 100, testDays: 14, tasksPerParticipant: 3, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 12, aiCallsPerParticipant: 20, imageCallsPerParticipant: 2 };
  const commercialSubscriptionBase = { dailyActiveUsers: 5, monthlyActiveUsers: 20, payingUsers: 5, newPaidUsersPerMonth: 2, simulationMonths: 6, monthlyPriceCny: 39, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 100, operationsHoursPerMonth: 6, developmentHoursPerMonth: 20, acquisitionCostPerNewUserCny: 30, monthlyChurnPct: 8 };
  const commercialDeliveryBase = { ordersPerMonth: 4, serviceFeePerOrderCny: 299, byokPct: 60, hostedPrepaidPerOrderCny: 100, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 2, supportHoursPerOrder: .5, developmentHoursPerMonth: 8, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 20 };
  const commercialUsagePackBase = { buyersPerMonth: 10, packsPerBuyer: 1, pricePerPackCny: 29, includedAiCallsPerPack: 80, includedImageCallsPerPack: 10, utilizationPct: 70, supportHoursPerMonth: 2, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 10 };
  window.__commercialization = {
    version: 3,
    updatedAt: "",
    assumptions: {
      stageByModel: { validation: 0, subscription: 0, delivery: 0, usagePack: 0 },
      stagePresets: {
        validation: [commercialValidationBase,{...commercialValidationBase,participants:20},{...commercialValidationBase,participants:100},{...commercialValidationBase,participants:300},{...commercialValidationBase,participants:1000}],
        subscription: [commercialSubscriptionBase,{...commercialSubscriptionBase,dailyActiveUsers:100,monthlyActiveUsers:400,payingUsers:50,simulationMonths:12},{...commercialSubscriptionBase,dailyActiveUsers:10000,monthlyActiveUsers:40000,payingUsers:4000,simulationMonths:18},{...commercialSubscriptionBase,dailyActiveUsers:25000,monthlyActiveUsers:100000,payingUsers:10000,simulationMonths:24},{...commercialSubscriptionBase,dailyActiveUsers:46000,monthlyActiveUsers:184000,payingUsers:18400,simulationMonths:24}],
        delivery: [commercialDeliveryBase,{...commercialDeliveryBase,ordersPerMonth:30},{...commercialDeliveryBase,ordersPerMonth:800},{...commercialDeliveryBase,ordersPerMonth:5000},{...commercialDeliveryBase,ordersPerMonth:15000}],
        usagePack: [commercialUsagePackBase,{...commercialUsagePackBase,buyersPerMonth:80},{...commercialUsagePackBase,buyersPerMonth:4000},{...commercialUsagePackBase,buyersPerMonth:15000},{...commercialUsagePackBase,buyersPerMonth:36800}]
      },
      validation: commercialValidationBase,
      subscription: commercialSubscriptionBase,
      delivery: commercialDeliveryBase,
      usagePack: commercialUsagePackBase,
      usageProfiles: {
        low: { sharePct: 40, activeDaysPerMonth: 4, requestsPerActiveDay: 2, foregroundAiCallsPerActiveDay: .5, backgroundAiCallsPerActiveDay: .25, imageCallsPerMonth: 1 },
        medium: { sharePct: 35, activeDaysPerMonth: 10, requestsPerActiveDay: 3, foregroundAiCallsPerActiveDay: 1.5, backgroundAiCallsPerActiveDay: .6, imageCallsPerMonth: 3 },
        high: { sharePct: 20, activeDaysPerMonth: 20, requestsPerActiveDay: 6, foregroundAiCallsPerActiveDay: 6.5, backgroundAiCallsPerActiveDay: 2, imageCallsPerMonth: 8 },
        full: { sharePct: 5, activeDaysPerMonth: 30, requestsPerActiveDay: 10, foregroundAiCallsPerActiveDay: 10, backgroundAiCallsPerActiveDay: 5, imageCallsPerMonth: 20 }
      },
      common: { usdCny: 7.2, aiCostFloorPerCallCny: .03, segmentationCostPerImageCny: .01, laborHourlyCny: 80 }
    }
  };
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("/api/v1/sync?")) return v1({ cursor: window.__syncCursor, changes: [], snapshot: {} });
    if (url.startsWith("/api/v1/sync/operations/")) {
      window.__receiptLookups += 1;
      const parsed=new URL(url,location.origin),operationId=decodeURIComponent(parsed.pathname.split("/").at(-1)),fingerprint=parsed.searchParams.get("fingerprint")||"",receipt=window.__operationReceipts[operationId];
      if(receipt&&receipt!==fingerprint)return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"同一操作标识不能用于不同请求",code:"OPERATION_ID_REUSED"},meta:{}}),{status:409,headers:{"content-type":"application/json"}}));
      return v1({operationId,status:receipt?"committed":"unknown",responseAvailable:false});
    }
    if (init.method === "DELETE") window.__deleteRequests += 1;
    if (url.startsWith("/attachments/")) {
      window.__attachmentReads ||= [];
      window.__attachmentReads.push(url);
      const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR2nWQAAAABJRU5ErkJggg=="),value=>value.charCodeAt(0));
      if (window.__delayAttachmentRead) {
        window.__delayAttachmentRead = false;
        return new Promise(resolve => { window.__releaseAttachmentRead = () => resolve(new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })); });
      }
      if (window.__failAttachmentRead) {
        window.__failAttachmentRead = false;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "无权读取这张图片", code: "ATTACHMENT_FORBIDDEN" } }), { status: 403, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(bytes,{status:200,headers:{"content-type":"image/png"}}));
    }
    if (url === "/api/v1/actions" && init.method === "POST") {
      if(window.__delayActionCreate)return new Promise(resolve=>{window.__releaseActionCreate=()=>{window.__delayActionCreate=false;resolve(v1({id:"created-action"}))}});
      return v1({id:"created-action"});
    }
    if (url === "/api/v1/actions/ui-action" && init.method === "PATCH" && window.__failActionConflict) {
      window.__failActionConflict = false;
      window.__actionListTitle = "服务器新标题";
      window.__actionListVersion = 2;
      return Promise.resolve(new Response(JSON.stringify({error:{message:"资源版本已变化，请重新读取后再提交",code:"PRECONDITION_FAILED",details:{currentVersion:2}}}),{status:412,headers:{"content-type":"application/json"}}));
    }
    if (url === "/api/v1/actions/ui-action" && init.method === "PATCH" && window.__delayActionUpdate) {
      const payload=JSON.parse(init.body||"{}");
      return new Promise(resolve=>{window.__releaseActionUpdate=()=>{window.__delayActionUpdate=false;window.__actionListStatus=payload.status||window.__actionListStatus;window.__actionListTitle=payload.title||window.__actionListTitle;window.__actionListVersion+=1;resolve(v1({id:"ui-action",...payload,version:window.__actionListVersion}))}});
    }
    if (url === "/api/v1/actions/ui-action" && init.method === "DELETE" && window.__delayActionDelete) {
      return new Promise(resolve=>{window.__releaseActionDelete=()=>{window.__delayActionDelete=false;resolve(new Response(JSON.stringify({error:{message:"删除校验失败",code:"VALIDATION_ERROR"}}),{status:400,headers:{"content-type":"application/json"}}))}});
    }
    if (url === "/api/v1/actions/ui-action/complete" && init.method === "POST" && window.__failActionNetwork) {
      window.__failActionNetwork = false;
      return Promise.reject(new TypeError("Load failed"));
    }
    if (url.startsWith("/api/v1/actions")) {
      if(window.__failNextActionRefresh){window.__failNextActionRefresh=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"刷新失败"}}),{status:503,headers:{"content-type":"application/json"}}))}
      const rows=()=>[{id:"ui-action",title:window.__actionListTitle,priority:"P0",status:window.__actionListStatus,sourceRef:null,version:window.__actionListVersion,createdAt:"2026-09-27T04:00:00.000Z",updatedAt:"2026-09-27T04:00:00.000Z",statusHistory:[]}];
      if(window.__delayActionList){window.__delayActionList=false;const captured=rows();return new Promise(resolve=>{window.__releaseActionList=()=>resolve(v1(captured))})}
      return v1(rows());
    }
    if (url === "/api/v1/habits" && init.method === "POST") {
      if(window.__delayHabitCreate)return new Promise(resolve=>{window.__releaseHabitCreate=()=>{window.__delayHabitCreate=false;resolve(v1({id:"created-habit"}))}});
      return v1({id:"created-habit"});
    }
    if (url.startsWith("/api/v1/habits/ui-habit/checkins")) return v1([{id:"ui-habit-checkin",habitId:"ui-habit",occurredOn:"2026-09-27",feeling:"稳定",version:1}]);
    if (url.startsWith("/api/v1/habits")) return v1([{id:"ui-habit",title:"每日回望",frequency:{cadence:"daily",target:1},status:"active",version:1,adjustmentHistory:[],statusHistory:[]}]);
    if (url.startsWith("/api/v1/discovery/random")) return v1(null,{total:0});
    if (url.startsWith("/api/v1/discovery")) return v1([{id:"kept-root",rootId:"kept-root",question:{id:"kept-root",content:"没有初步想法的问题",source:"user",sourceLabel:"用户原文"},matches:[{id:"kept-root",content:"没有初步想法的问题",source:"user",sourceLabel:"用户原文",type:"question"}],matchCount:1,occurredAt:"2026-09-27T04:09:00.000Z",status:{version:1,fresh:true,untraced:true,read:false,snoozed:false},fresh:true,untraced:true}],{total:1,untracedCount:1,totalUntracedCount:1,nextCursor:null});
    if (url === "/api/v1/feedback" && init.method === "POST") {
      if(window.__delayFeedbackCreate)return new Promise(resolve=>{window.__releaseFeedbackCreate=()=>{window.__delayFeedbackCreate=false;resolve(v1({id:"created-feedback"}))}});
      return v1({id:"created-feedback"});
    }
    if (url.startsWith("/api/v1/feedback")) return v1([{id:"ui-feedback",type:"experience",feature:"思绪",appVersion:"0.2.0",body:"界面清晰",context:{selected:false,summary:""},status:"submitted",version:1,createdAt:"2026-09-27T04:00:00.000Z",updatedAt:"2026-09-27T04:00:00.000Z"}]);
    if (url === "/api/v1/personal-context") return v1(window.__personalContext);
    if (url.includes("/api/v1/exports/account?format=manifest")) return v1({snapshotVersion:15,summary:{resources:12,attachments:2,attachmentReferences:3,orphanReferences:0}});
    if (url.includes("/api/v1/exports/account?format=json")) return v1({format:"json",filename:"for-now-ui.json",mimeType:"application/json;charset=utf-8",content:"{}\\n"});
    if (url.includes("/api/v1/exports/account?format=markdown")) return v1({format:"markdown",filename:"for-now-ui.md",mimeType:"text/markdown;charset=utf-8",content:"# For Now\\n"});
    if (url === "/api/meta") return json({ version: "build-fixture", releaseVersion: "0.2.0", user: window.__accountUser, governanceUrl: "/platform/" });
    if (url === "/api/auth/me") return json({ authenticated: true, authRequired: true, registrationAvailable: true, user: window.__accountUser, userCount: 1 });
    if (url === "/api/auth/username" && init.method === "PATCH") {
      window.__usernameChanges += 1;
      window.__accountUser = { ...window.__accountUser, username: JSON.parse(init.body).username };
      return json({ authenticated: true, user: window.__accountUser });
    }
    if (url === "/api/auth/password" && init.method === "PATCH") {
      window.__passwordChanges += 1;
      return json({ authenticated: true, user: window.__accountUser });
    }
    if (url === "/api/auth/logout") {
      if(window.__delayLogout)return new Promise(resolve=>{window.__releaseLogout=()=>{window.__delayLogout=false;resolve(json({authenticated:false}))}});
      return json({ authenticated: false });
    }
    if (url === "/api/auth/login") {
      const complete=()=>{window.__accountUser={id:"user-2",username:"second",createdAt:"2026-09-27T00:00:00.000Z"};return json({authenticated:true,authRequired:true,user:window.__accountUser})};
      if(window.__delayLogin)return new Promise(resolve=>{window.__releaseLogin=()=>{window.__delayLogin=false;resolve(complete())}});
      return complete();
    }
    if (url === "/api/ai-cost-plan" && (!init.method || init.method === "GET")) return json(window.__aiCostPlan);
    if (url === "/api/ai-cost-plan" && init.method === "PATCH") {
      window.__aiCostPlanSaves += 1;
      window.__aiCostPlan = { ...JSON.parse(init.body), version: 1, updatedAt: "2026-09-28T09:00:00.000Z" };
      return json(window.__aiCostPlan);
    }
    if (url === "/api/commercialization" && init.method === "PATCH") {
      window.__commercializationSaves += 1;
      window.__commercialization = { version: 3, updatedAt: "2026-09-28T08:00:00.000Z", assumptions: JSON.parse(init.body).assumptions };
      return json(window.__commercialization);
    }
    if (url === "/api/local-test-mode" && (!init.method || init.method === "GET")) return json(window.__localTestConfig);
    if (url === "/api/local-test-mode/hydrate" && init.method === "POST") {
      const scope=JSON.parse(init.body).scope,hydrated=!window.__localTestConfig.loadedScopes.includes(scope);
      window.__localHydrateRequests.push(scope);
      window.__localTestConfig={...window.__localTestConfig,recordCount:12,snapshotAt:new Date().toISOString(),loadedScopes:[...new Set([...window.__localTestConfig.loadedScopes,scope])]};
      window.__lazySimulationEmpty=false;
      return window.fetch("/api/state").then(async stateResponse=>json({control:window.__localTestConfig,state:await stateResponse.json(),hydrated}));
    }
    if (url === "/api/local-test-mode" && init.method === "POST") {
      if(window.__failLocalModeTimeout){window.__failLocalModeTimeout=false;return json({error:"The operation was aborted due to timeout"},504)}
      const mode=JSON.parse(init.body).mode;window.__testWorkspaceMode=mode;window.__lazySimulationEmpty=mode==="simulation";window.__localTestConfig={...window.__localTestConfig,mode,switchedAt:new Date().toISOString(),snapshotAt:"",sourceUser:mode==="simulation"?{id:"user-1",username:"owner"}:null,recordCount:0,loadedScopes:[]};
      if(mode==="cold")window.__onboarding={status:"pending",questionnaireVersion:1,questionnaireMode:"quick",answers:{},profile:{},interests:[],material:"",understanding:""};
      return json(window.__localTestConfig);
    }
    if (url === "/api/onboarding/schema") {
      window.__onboardingSchemaRequests += 1;
      return window.__onboardingSchemaAvailable
        ? json(window.__onboardingSchema)
        : Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    }
    if (url === "/api/onboarding/preview" && init.method === "POST") return json({understanding:"快速版初始认知：重视证据，也保留修正空间。"});
    if (url === "/api/onboarding" && init.method === "PATCH") { window.__onboardingSaves+=1;window.__onboarding={...JSON.parse(init.body),updatedAt:new Date().toISOString()};return json(window.__onboarding); }
    if (url.startsWith("/api/statistics")) {
      const dates = ["2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-26","2026-09-27"];
      const blank = () => ({ calls: 0, successfulCalls: 0, failedCalls: 0, unknownStatusCalls: 0, usageUnknownCalls: 0, durationMs: 0, durationKnownCalls: 0, maxDurationMs: 0, visionCalls: 0, imageCount: 0, imageBytes: 0, costUnknownCalls: 0, costCny: 0, tokens: { input: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0, answer: 0, output: 0 }, costsUsd: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 } });
      const daily = dates.map((date,index) => {
        const flash = blank(), pro = blank();
        flash.calls = index % 3;flash.successfulCalls=flash.calls;flash.durationMs=840*flash.calls;flash.durationKnownCalls=flash.calls;flash.maxDurationMs=flash.calls?840:0;flash.visionCalls=index===5?1:0;flash.imageCount=flash.visionCalls*2;flash.imageBytes=flash.imageCount*2048;flash.tokens = { input: 1200*flash.calls, cacheHit: 400*flash.calls, cacheMiss: 800*flash.calls, reasoning: 180*flash.calls, answer: 320*flash.calls, output: 500*flash.calls };flash.costsUsd = { input: .00024*flash.calls, cacheHit: .0000024*flash.calls, reasoning: .000216*flash.calls, output: .000384*flash.calls, total: .0008424*flash.calls };
        pro.calls = index % 2;pro.successfulCalls=pro.calls;pro.durationMs=1350*pro.calls;pro.durationKnownCalls=pro.calls;pro.maxDurationMs=pro.calls?1350:0;pro.tokens = { input: 1800*pro.calls, cacheHit: 600*pro.calls, cacheMiss: 1200*pro.calls, reasoning: 500*pro.calls, answer: 600*pro.calls, output: 1100*pro.calls };pro.costsUsd = { input: .001584*pro.calls, cacheHit: .0000264*pro.calls, reasoning: .00198*pro.calls, output: .002376*pro.calls, total: .0059664*pro.calls };
        const total = blank();for(const item of[flash,pro]){for(const key of["calls","successfulCalls","failedCalls","unknownStatusCalls","usageUnknownCalls","durationMs","durationKnownCalls","visionCalls","imageCount","imageBytes","costUnknownCalls","costCny"])total[key]+=item[key];total.maxDurationMs=Math.max(total.maxDurationMs,item.maxDurationMs);for(const key in total.tokens)total.tokens[key]+=item.tokens[key];for(const key in total.costsUsd)total.costsUsd[key]+=item.costsUsd[key]}
        return { date, ...total, models: { "deepseek-flash": flash, "deepseek-v4-pro": pro }, services: {} };
      });
      const sum = items => { const total=blank();for(const item of items){for(const key of["calls","successfulCalls","failedCalls","unknownStatusCalls","usageUnknownCalls","durationMs","durationKnownCalls","visionCalls","imageCount","imageBytes","costUnknownCalls","costCny"])total[key]+=item[key];total.maxDurationMs=Math.max(total.maxDurationMs,item.maxDurationMs);for(const key in total.tokens)total.tokens[key]+=item.tokens[key];for(const key in total.costsUsd)total.costsUsd[key]+=item.costsUsd[key]}return total };
      const flash=sum(daily.map(item=>item.models["deepseek-flash"])),pro=sum(daily.map(item=>item.models["deepseek-v4-pro"])),deepseek=sum(daily);
      const speech={...blank(),calls:2,successfulCalls:2,usageUnknownCalls:2,durationMs:1500,durationKnownCalls:2,maxDurationMs:900,costUnknownCalls:1,costCny:1.25,unitUsage:[{unitType:"character",units:120},{unitType:"audioMillisecond",units:1500}]};
      const volcVision={...blank(),calls:1,successfulCalls:1,usageUnknownCalls:1,durationMs:640,durationKnownCalls:1,maxDurationMs:640,visionCalls:1,imageCount:1,imageBytes:2048,costUnknownCalls:1,unitUsage:[{unitType:"image",units:1}]};
      const aliyunSegmentation={...blank(),calls:2,successfulCalls:1,failedCalls:1,usageUnknownCalls:2,durationMs:940,durationKnownCalls:2,maxDurationMs:700,visionCalls:2,imageCount:1,imageBytes:2048,costUnknownCalls:2,unitUsage:[{unitType:"image",units:1},{unitType:"call",units:1}]};
      const volcengine=sum([speech,volcVision]),aliyun={...aliyunSegmentation},summary=sum([deepseek,volcengine,aliyun]);
      const deepseekVision={...blank(),calls:deepseek.visionCalls,successfulCalls:deepseek.visionCalls,visionCalls:deepseek.visionCalls,imageCount:deepseek.imageCount,imageBytes:deepseek.imageBytes,durationMs:840*deepseek.visionCalls,durationKnownCalls:deepseek.visionCalls,tokens:{...blank().tokens,input:2400,output:1000},costsUsd:{...blank().costsUsd,total:.0016848}};
      const vision=sum([deepseekVision,volcVision,aliyunSegmentation]),text={...deepseek,calls:deepseek.calls-deepseekVision.calls,successfulCalls:deepseek.successfulCalls-deepseekVision.successfulCalls,durationMs:deepseek.durationMs-deepseekVision.durationMs,durationKnownCalls:deepseek.durationKnownCalls-deepseekVision.durationKnownCalls,visionCalls:0,imageCount:0,imageBytes:0},audio={...speech};
      const services=[
        {key:"deepseek",provider:"deepseek",service:"",label:"DeepSeek 模型",...deepseek,unitUsage:[{unitType:"token",units:deepseek.tokens.input+deepseek.tokens.output}]},
        {key:"volcengineSpeech",provider:"volcengine",service:"speech",label:"豆包语音",...speech},
        {key:"volcengineVision",provider:"volcengine",service:"vision",label:"火山视觉",...volcVision},
        {key:"aliyunSegmentation",provider:"aliyun",service:"segmentation",label:"阿里云图片分割",...aliyunSegmentation}
      ];
      for(const day of daily)day.services={deepseek:{...day,unitUsage:[{unitType:"token",units:day.tokens.input+day.tokens.output}]},volcengineSpeech:blank(),volcengineVision:blank(),aliyunSegmentation:blank()};
      daily[4].services.volcengineSpeech=speech;daily[5].services.volcengineVision=volcVision;daily[6].services.aliyunSegmentation=aliyunSegmentation;
      const content=[{ key:"checkins",label:"状态",count:4 },{ key:"sleep",label:"睡眠",count:2 },{ key:"heartRate",label:"心率",count:1 },{ key:"weight",label:"体重",count:1 },{ key:"exercise",label:"运动",count:0 },{ key:"captures",label:"捕念",count:2 },{ key:"journals",label:"日记",count:1 },{ key:"thoughts",label:"思考主题",count:2 },{ key:"chats",label:"长期对话",count:1 },{ key:"books",label:"书目",count:1 },{ key:"bookNotes",label:"读书记录",count:5 },{ key:"quotes",label:"善言",count:4 },{ key:"keepsakes",label:"小物",count:1 },{ key:"experiments",label:"个人实验",count:2 },{ key:"analyses",label:"认知复盘",count:4 }];
      const interactions=[{ key:"highlights",label:"划线",count:3 },{ key:"comments",label:"评论",count:2 },{ key:"commentReplies",label:"评论回复",count:1 },{ key:"shenji",label:"@神鸡",count:2 },{ key:"followUps",label:"思考追问",count:1 },{ key:"remarks",label:"思考备注",count:1 },{ key:"reflections",label:"日记回望",count:0 }];
      const byKey=Object.fromEntries([...content,...interactions].map(item=>[item.key,item])),module=(key,label,keys)=>({key,label,items:keys.map(item=>byKey[item]),total:keys.reduce((sum,item)=>sum+byKey[item].count,0)});
      const groups=[
        {key:"today",label:"今日",modules:[module("moment","此刻",["checkins"]),module("together","共参",["chats"]),module("daily","每日",["sleep","heartRate","weight","exercise"])]},
        {key:"seen",label:"所见",modules:[module("captures","念起",["captures"]),module("books","书间",["books","bookNotes"]),module("quotes","拾句",["quotes"]),module("keepsakes","小物",["keepsakes"])]},
        {key:"thought",label:"所思",modules:[module("thoughts","思绪",["thoughts"]),module("journals","日记",["journals"]),module("review","回顾",["experiments","analyses"])]},
        {key:"interaction",label:"互动",modules:[module("annotations","正文批注",["highlights","comments","commentReplies","shenji"]),module("thoughtInteractions","思绪",["followUps","remarks"]),module("journalInteractions","日记",["reflections"])]}
      ].map(group=>({...group,total:group.modules.reduce((sum,item)=>sum+item.total,0)}));
      return json({
        records: { total: 41, contentTotal: 31, interactionTotal: 10, content, interactions, groups },
        ai: { from:dates[0],to:dates.at(-1),trackingStartedAt:"2026-09-21T01:00:00.000Z",summary,daily,models:[{model:"deepseek-flash",label:"DeepSeek Flash",...flash},{model:"deepseek-v4-pro",label:"DeepSeek Pro",...pro}],providers:[{provider:"deepseek",label:"DeepSeek",...deepseek},{provider:"volcengine",label:"火山引擎",...volcengine},{provider:"aliyun",label:"阿里云",...aliyun}],services,modalities:[{modality:"text",label:"纯文本",...text},{modality:"vision",label:"图片理解",...vision},{modality:"audio",label:"语音",...audio}],scenes:[{scene:"thoughtAnswer",calls:4,tokens:{input:12000,cacheHit:3000,reasoning:3000,answer:2000},costsUsd:{total:.02}},{scene:"chat",calls:2,tokens:{input:5000,cacheHit:1000,reasoning:800,answer:600},costsUsd:{total:.006}},{scene:"annotationShenji",calls:1,tokens:{input:1800,cacheHit:200,reasoning:200,answer:180},costsUsd:{total:.001}},{scene:"speechSynthesis",calls:2,costCny:1.25,costUnknownCalls:1,tokens:{},costsUsd:{total:0}},{scene:"keepsakeSegmentation",calls:2,costUnknownCalls:2,tokens:{},costsUsd:{total:0}}],calibration:{activeDays:6,averageCallsPerActiveDay:1.5,averageInputTokens:1467,maxInputTokens:31860,averageRequestChars:5100,maxRequestChars:52661,medianCostCny:.025,p90CostCny:.041,maxCostCny:.042},pricing:{source:"https://api-docs.deepseek.com/quick_start/pricing/",checkedAt:"2026-09-27",currency:"USD",displayCurrency:"CNY",cnyPerUsd:7.2,unitTokens:1000000,models:{"deepseek-flash":{label:"DeepSeek Flash",offPeak:{cacheHit:.003,cacheMiss:.15,output:.6},peak:{cacheHit:.006,cacheMiss:.3,output:1.2}},"deepseek-v4-pro":{label:"DeepSeek Pro",offPeak:{cacheHit:.022,cacheMiss:.66,output:1.98},peak:{cacheHit:.044,cacheMiss:1.32,output:3.96}}},estimateNote:"费用按官方单价估算。"} },
        service: { completedWrites: 56, activeDays: 2, segmentationRequests: 2, topActions: [{ action:"POST /api/thoughts/answer", count:16 }] }
      });
    }
    if (url === "/api/state") {
      if(window.__failNextStateRefresh){window.__failNextStateRefresh=false;return Promise.resolve(new Response(JSON.stringify({error:"刷新失败"}),{status:503,headers:{"content-type":"application/json"}}))}
      window.__stateRequests += 1;
      if(window.__accountUser.id==="user-2"&&window.__delaySecondState)return new Promise(resolve=>{window.__releaseSecondState=()=>{window.__delaySecondState=false;resolve(window.fetch(input,init))}});
      const empty=window.__testWorkspaceMode==="cold"||window.__lazySimulationEmpty;
      return json({
      version: 15, checkins: empty?[]:window.__checkins, dailyRecords: empty?[]:window.__dailyRecords, captures: empty?[]:window.__captures, journals: empty?[]:window.__journals, thoughts: empty?[]:window.__thoughts,
      chats: empty?[]:[{ id: "chat-1", createdAt: "2026-09-27T01:15:00.000Z", occurredAt: "2026-09-27T04:15:00.000Z", occurredOn: "2026-09-27", message: "**用户问题**", answer: "## 模型回答" }], books: empty?[]:window.__books, journalDraft: empty?null:window.__journalDraft, keepsakes: empty?[]:window.__keepsakes.map(({originalPath,...item})=>item), quotes: empty?[]:window.__quotes, aiTasks: window.__aiTasks, notifications: window.__notifications, onboarding: window.__onboarding, commercialization: window.__commercialization,
      speech:{configured:true,defaultVoice:"zh_male_shaonianzixin_uranus_bigtts",supportedAsrMimeTypes:["audio/mp4","audio/ogg","audio/wav"],voices:[{id:"zh_male_shaonianzixin_uranus_bigtts",label:"少年梓辛 2.0"},{id:"zh_male_m191_uranus_bigtts",label:"云舟 2.0"},{id:"zh_female_vv_uranus_bigtts",label:"Vivi 2.0"},{id:"zh_female_cancan_uranus_bigtts",label:"知性灿灿 2.0"}]},vision:{configured:true},
      experiments: [], analyses: empty?[]:window.__analyses, customMetrics: [], clusters: [],
      insights: { trends: [
        { metric: "mood", current: 3.5, previous: null, currentCount: 2, previousCount: 0 },
        { metric: "energy", current: 2.5, previous: null, currentCount: 2, previousCount: 0 },
        { metric: "stress", current: 3.5, previous: null, currentCount: 2, previousCount: 0 },
        { metric: "sleep", current: 3.5, previous: null, currentCount: 2, previousCount: 0 }
      ], associations: [
        {factor:"重点一",withCount:12,withoutCount:18,nextDayCount:8,sameDay:4.2,baseline:3.1,nextDay:4.1,confidence:"可观察"},
        {factor:"重点二",withCount:6,withoutCount:12,nextDayCount:5,sameDay:3.9,baseline:3.2,nextDay:3.8,confidence:"初步线索"},
        {factor:"重点三",withCount:3,withoutCount:9,nextDayCount:2,sameDay:2.4,baseline:3.4,nextDay:2.6,confidence:"初步线索"},
        {factor:"不应显示",withCount:1,withoutCount:11,nextDayCount:1,sameDay:5,baseline:3.3,nextDay:5,confidence:"单日观察"}
      ], aiOnlyThoughtIds: ["kept-root"], weekly: { checkins: 2, activeDays7: 4, pairedDays30: 2, rootCount30: 5, tracedRoots30: 3, traceRate30: 60, correctionActions30: 7, reviewAgeDays: 0, analysisCount: 2 } }
      });
    }
    if (url === "/api/settings" && (!init.method || init.method === "GET")) return json({
      version: 7, provider: "deepseek",
      profiles: { lite: { model: "deepseek-flash", effort: "none" }, mid: { model: "deepseek-flash", effort: "high" }, high: { model: "deepseek-v4-pro", effort: "high" }, ultra: { model: "deepseek-v4-pro", effort: "max" } },
      scenarios: { thoughtPrompt: "lite", thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high", diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra", annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid", contentImageUnderstanding: "mid", capturePolish: "mid" },
      assistantName: "神鸡", responseStyles: { thoughtDraft:"standard",thoughtAnswer:"standard",followUpAnswer:"standard",chat:"standard",diaryReflection:"standard",annotationShenji:"standard",analysis:"standard" },
      automaticAnswers: { thoughtAnswer: true },
      hasApiKey: true, keyHint: "tes••••test"
    });
    if (url === "/api/settings" && init.method === "POST") {
      window.__settingsSaves += 1;
      const payload = JSON.parse(init.body);
      return json({ version: 7, provider: "deepseek", ...payload, hasApiKey: true, keyHint: "tes••••test" });
    }
    if (url === "/api/settings/test") return json({ ok: true, reply: "连接成功" });
    if (url === "/api/speech/synthesize" && init.method === "POST") {
      window.__speechRequests.push(JSON.parse(init.body));
      const response=()=>new Response(new Uint8Array([0x49,0x44,0x33]),{headers:{"content-type":"audio/mpeg"}});
      if(window.__delaySpeech){
        window.__delaySpeech=false;
        return new Promise(resolve=>{window.__releaseSpeech=()=>resolve(response())})
      }
      return response()
    }
    if (url === "/api/thought-prompts") {
      window.__thoughtPrompts += 1;
      if (window.__holdPrompt) return new Promise(resolve => { window.__resolvePrompt=()=>resolve(json({prompt:"迟到的引子",hasHistory:true})); });
      return json({ prompt: "之前那件还没想完的事，现在最想往前推哪一步？", hasHistory: true });
    }
    if (url === "/api/v1/checkins" && init.method === "POST") {
      if (window.__conflictCheckinCreate) {
        window.__conflictCheckinCreate = false;
        return Promise.resolve(new Response(JSON.stringify({error:{message:"同一幂等键不能用于不同内容",code:"IDEMPOTENCY_KEY_REUSED"}}),{status:409,headers:{"content-type":"application/json"}}));
      }
      const respond = () => {
        window.__checkinSaves += 1;
        const payload = JSON.parse(init.body), createdAt = new Date().toISOString(), occurredAt = payload.occurredAt || createdAt;
        const item = { id: "checkin-new-" + window.__checkinSaves, createdAt, occurredAt, occurredOn: occurredAt.slice(0, 10), version: 1, ...payload };
        window.__checkinPayloads.push(payload);
        window.__checkins.unshift(item);
        return v1(item);
      };
      if (window.__delayCheckinCreate) {
        window.__delayCheckinCreate = false;
        return new Promise(resolve => { window.__releaseCheckinCreate = () => resolve(respond()); });
      }
      if (window.__failCheckinCreate) {
        window.__failCheckinCreate = false;
        throw new TypeError("Load failed");
      }
      return respond();
    }
    if (/^\\/api\\/(?:v1\\/)?checkins\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__checkinPatches += 1;
      const item = window.__checkins.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, eventTime(payload), { updatedAt: new Date().toISOString(), version: (item.version || 1) + 1 });
      return url.startsWith("/api/v1/") ? v1(item) : json(item);
    }
    if (/^\\/api\\/v1\\/checkins\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id=url.split("/").at(-1);window.__checkins=window.__checkins.filter(item=>item.id!==id);return v1({trashId:"trash-"+id});
    }
    if (url === "/api/v1/captures" && init.method === "POST") {
      const respond = () => {
        window.__captureSaves += 1;
        const payload = JSON.parse(init.body), item = { id: "capture-new-" + window.__captureSaves, createdAt: new Date().toISOString(), imageUnderstandings: [], version: 1, ...payload, ...eventTime(payload) };
        window.__capturePayloads.push(payload);
        window.__captures.unshift(item);
        return v1(item);
      };
      if (window.__delayCaptureCreate) {
        window.__delayCaptureCreate = false;
        return new Promise(resolve => { window.__releaseCaptureCreate = () => resolve(respond()); });
      }
      if (window.__failCaptureCreate) {
        window.__failCaptureCreate = false;
        throw new TypeError("Load failed");
      }
      return respond();
    }
    if (url === "/api/captures" && init.method === "POST") {
      window.__captureSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "capture-new-" + window.__captureSaves, createdAt: new Date().toISOString(), imageUnderstandings: [], version: 1, ...payload, ...eventTime(payload) };
      window.__capturePayloads.push(payload);
      window.__captures.unshift(item);
      return json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?captures\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const item = window.__captures.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      if(window.__conflictCapturePatch){window.__conflictCapturePatch=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"资源版本已变化，请重新读取后再提交",code:"PRECONDITION_FAILED",details:{currentVersion:(item?.version||1)+1}},meta:{}}),{status:412,headers:{"content-type":"application/json"}}))}
      if(window.__failCapturePatchNetwork){window.__failCapturePatchNetwork=false;throw new TypeError("Load failed")}
      const respond=()=>{
        window.__capturePatchPayloads.push(payload);
        Object.assign(item,payload,eventTime(payload),{updatedAt:new Date().toISOString(),version:(item.version||1)+1});
        if(window.__loseCapturePatchResponse){window.__loseCapturePatchResponse=false;window.__operationReceipts[init.headers["x-client-operation-id"]]=init.headers["x-client-operation-fingerprint"];throw new TypeError("response lost after commit")}
        return url.startsWith("/api/v1/")?v1(item):json(item)
      };
      if(window.__delayCapturePatch){window.__delayCapturePatch=false;return new Promise(resolve=>{window.__releaseCapturePatch=()=>resolve(respond())})}
      return respond();
    }
    if (/^\\/api\\/v1\\/captures\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id=url.split("/").at(-1);window.__captures=window.__captures.filter(item=>item.id!==id);return v1({trashId:"trash-"+id});
    }
    if (url === "/api/journal-draft" && init.method === "PUT") {
      window.__journalDraftSaves += 1;
      const payload = JSON.parse(init.body);
      window.__journalDraftPayloads.push(payload);
      window.__journalDraft = { ...payload, updatedAt: "2026-09-27T09:18:19.000Z" };
      return json(window.__journalDraft);
    }
    if ((url === "/api/journals" || url === "/api/v1/journals") && init.method === "POST") {
      window.__journalSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "journal-new-" + window.__journalSaves, createdAt: new Date().toISOString(), reflections: [], version: 1, ...payload, ...eventTime(payload) };
      window.__journals.unshift(item);
      if (!window.__journalDraft?.journalId) window.__journalDraft = null;
      return url.startsWith("/api/v1/") ? v1(item, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?journals\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const item = window.__journals.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      window.__journalPatches += 1;
      Object.assign(item, payload, eventTime(payload), { updatedAt: new Date().toISOString(), version: (item.version || 1) + 1 });
      if (window.__journalDraft?.journalId === item.id) window.__journalDraft = null;
      return url.startsWith("/api/v1/") ? v1(item) : json(item);
    }
    if (/^\\/api\\/v1\\/journals\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id=url.split("/").at(-1);window.__journals=window.__journals.filter(item=>item.id!==id);return v1({trashId:"trash-"+id});
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
      const marker = { lead: "🗃", structure: "🏷", topic: "💬" }[payload.mode];
      return streamResponse({ mode: payload.mode, content: marker + " 第一行写作锚点。\\n" + marker + " 第二行写作锚点。" });
    }
    if (url === "/api/images/parse") {
      const payload = JSON.parse(init.body);
      if (payload.kind === "book") window.__bookParses += 1;
      else { window.__healthParses += 1; window.__healthParsePayloads.push(payload); }
      if(payload.kind==="weight"&&window.__failWeightReferenceDate===payload.referenceDate){window.__failWeightReferenceDate="";return json({error:"该张截图识别暂时失败"},502)}
      const healthFixtures=${JSON.stringify(healthImageFixtures)};
      const result={requestId:payload.requestId,targetId:payload.targetId,inputVersion:payload.inputVersion,...(healthFixtures[payload.kind]?{...healthFixtures[payload.kind],attachmentPaths:payload.attachmentPaths||["/attachments/"+payload.kind+".png"]}:payload.kind==="sleep"?{ date: "2026-09-27", bedtime: "2026-09-27T02:58:00", wakeTime: "2026-09-27T10:40:00", totalMinutes: 462, deepMinutes: 134, deepPercent: 29, lightMinutes: 221, lightPercent: 48, remMinutes: 107, remPercent: 23, awakeCount: null, awakeMinutes: null, averageHeartRate: 49, averageOxygen: 98, respiratoryRate: 15, attachmentPaths: payload.attachmentPaths||["/attachments/sleep-1.jpg", "/attachments/sleep-2.jpg"], verification: "两张图已合并" }:payload.kind==="heartRate"?{ date: "2026-09-26", minimum: 46, maximum: 82, average: 60, resting: 52, sleepAverage: 50, trendAnalysis: "凌晨下降，午后与晚间抬升。", trendSegments: [], attachmentPaths: payload.attachmentPaths||["/attachments/heart.jpg"], verification: "心率图已识别" }:{ title: "粘贴识别成功", author: "测试作者", publisher: "测试出版社", isbn: "9780000000000", description: "**识别结果**", attachmentPaths: payload.attachmentPaths||["/attachments/mock.png"], verification: "图片已识别，请确认" })};
      if(window.__tamperParseField)result[window.__tamperParseField]=window.__tamperParseField==="inputVersion"?payload.inputVersion+1:"wrong-target";
      if(window.__delayParseKind===payload.kind)return new Promise(resolve=>{window.__releaseParse=()=>{window.__delayParseKind="";resolve(json(result))}});
      return json(result);
    }
    if (url === "/api/images/upload") {
      const payload=JSON.parse(init.body),image=payload.image,images=payload.images||[];
      window.__imageUploads.push(...(images.length?images:[image]));
      if(payload.purpose==="keepsake"){
        window.__keepsakeUploads+=1;window.__keepsakeUploadPayloads.push(payload);window.__keepsakeUploadKeys.push(init.headers?.["idempotency-key"]||"");
        const base="/attachments/keepsake-"+window.__keepsakeUploads;
        return json({attachmentPath:base+".original.png",attachmentPaths:[base+".original.png",base+".thumb.webp",base+".display.webp",base+".edit.webp",base+".alphaMask.webp"],originalPath:base+".original.png",thumbPath:base+".thumb.webp",displayPath:base+".display.webp",editPath:base+".edit.webp",alphaMaskPath:base+".alphaMask.webp"},201)
      }
      if(payload.purpose==="original"&&images.length){
        if(document.querySelector("#view-books")?.classList.contains("active")){window.__bookUploads += 1;const attachmentPath="/attachments/cover-"+window.__bookUploads+".png";return json({attachmentPath,attachmentPaths:[attachmentPath]},201)}
        if(document.querySelector("#view-daily")?.classList.contains("active")){const type=document.querySelector("[data-daily-tab].active")?.dataset.dailyTab||"weight",index=++window.__healthUploads[type],extension=type==="sleep"?"jpg":"png",attachmentPath="/attachments/"+type+(type==="sleep"?"-"+index:"")+"."+extension;return json({attachmentPath,attachmentPaths:[attachmentPath]},201)}
        const attachmentPaths=images.map(()=>"/attachments/content-"+(++window.__contentImageUploads)+".png");return json({attachmentPath:attachmentPaths[0],attachmentPaths},201)
      }
      if (document.querySelector("#view-keepsakes")?.classList.contains("active")) {
        window.__keepsakeUploads += 1;
        return json({ attachmentPath: "/attachments/keepsake-" + window.__keepsakeUploads + ".png" }, 201);
      }
      window.__bookUploads += 1;
      return json({ attachmentPath: "/attachments/cover-" + window.__bookUploads + ".png" }, 201);
    }
    if (url === "/api/images/discard") {
      const payload=JSON.parse(init.body);window.__imageDiscards.push(...(payload.attachmentPaths||[]));return json({discarded:payload.attachmentPaths||[],pending:0});
    }
    if (url === "/api/keepsakes/segment") return json({ cutout: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='36'%3E%3Crect width='24' height='36' fill='%23d76455'/%3E%3C/svg%3E", provider: "aliyun-segment-hd" });
    if (/^\\/api\\/keepsakes\\/[^/]+\\/original$/.test(url) && (!init.method || init.method === "GET")) {
      window.__keepsakeOriginalReads += 1;
      const item=window.__keepsakes.find(value=>value.id===url.split("/")[3]);
      return item?json({originalPath:item.originalPath}):json({error:"原图不可用"},404);
    }
    if (url === "/api/keepsakes" && init.method === "POST") {
      const payload = JSON.parse(init.body), item = { id: "keepsake-new-"+(window.__keepsakePayloads.length+1), createdAt: new Date().toISOString(), ...payload, cutoutPath: "", mediaVersion: 1, ...eventTime(payload) };
      window.__lastKeepsakeCreateKey=init.headers?.["idempotency-key"]||"";window.__keepsakeCreateKeys.push(window.__lastKeepsakeCreateKey);
      if(window.__failKeepsakeCreateOnce){window.__failKeepsakeCreateOnce=false;return json({error:"小物保存暂时失败"},503)}
      window.__keepsakePayloads.push(payload);
      window.__keepsakes.unshift(item);
      const {originalPath,...visible}=item;
      return json(visible);
    }
    if ((url === "/api/daily-records" || url === "/api/v1/daily-records") && init.method === "POST") {
      window.__dailySaves += 1;
      const payload = JSON.parse(init.body), item = { id: "daily-" + window.__dailySaves, createdAt: new Date().toISOString(), version: 1, ...payload, ...eventTime(payload) };
      window.__dailyRecords.unshift(item);
      return url.startsWith("/api/v1/") ? v1(item, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?daily-records\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__dailyPatches += 1;
      const item = window.__dailyRecords.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, eventTime(payload), { version: (item.version || 1) + 1 });
      return url.startsWith("/api/v1/") ? v1(item) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?daily-records\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id = url.split("/").at(-1);window.__dailyRecords = window.__dailyRecords.filter(item => item.id !== id);return url.startsWith("/api/v1/")?v1({trashId:"trash-"+id}):json({ removed: 1 });
    }
    if (url === "/api/books/parse") {
      window.__bookParses += 1;
      return json({ title: "粘贴识别成功", author: "测试作者", publisher: "测试出版社", isbn: "9780000000000", description: "**识别结果**", imagePath: "/attachments/mock.png", verification: "图片已识别，请确认" });
    }
    if ((url === "/api/books" || url === "/api/v1/books") && init.method === "POST") {
      if(window.__failBookCreateStatus){const status=window.__failBookCreateStatus;window.__failBookCreateStatus=0;return json({data:null,error:{code:"BOOK_INVALID",message:"书目校验失败"},meta:{}},status)}
      window.__bookSaves += 1;
      const payload = JSON.parse(init.body), book = { id: "book-" + window.__bookSaves, createdAt: "2026-09-27T01:00:00.000Z", notes: [], annotations: [], annotationDrift: [], version: 1, ...payload };
      window.__bookPayloads.push(payload);
      window.__books.unshift(book);
      return url.startsWith("/api/v1/") ? v1(book, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(book);
    }
    if (/^\\/api\\/(?:v1\\/)?books\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__bookPatches += 1;
      const id = url.split("/").at(-1), book = window.__books.find(item => item.id === id), payload = JSON.parse(init.body);
      window.__bookPayloads.push(payload);
      Object.assign(book, payload, { updatedAt: new Date().toISOString(), version: (book.version || 1) + 1 });
      return url.startsWith("/api/v1/") ? v1(book) : json(book);
    }
    if (/^\\/api\\/v1\\/books\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id=url.split("/").at(-1);window.__books=window.__books.filter(item=>item.id!==id);return v1({trashId:"trash-"+id});
    }
    if (/^\\/api\\/(?:v1\\/)?books\\/[^/]+\\/notes$/.test(url) && init.method === "POST") {
      if(window.__failBookNoteStatus){const status=window.__failBookNoteStatus;window.__failBookNoteStatus=0;return json({data:null,error:{code:"BOOK_NOTE_INVALID",message:"读书记录校验失败"},meta:{}},status)}
      window.__bookNoteSaves += 1;
      const book = window.__books.find(item => url.includes(item.id)), payload = JSON.parse(init.body), note = { id: "note-" + window.__bookNoteSaves, createdAt: "2026-09-27T01:01:00.000Z", version: 1, ...payload, ...eventTime(payload) };
      book.notes.unshift(note);
      return url.startsWith("/api/v1/") ? v1(note, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(note);
    }
    if (/^\\/api\\/(?:v1\\/)?books\\/[^/]+\\/notes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__bookNotePatches += 1;
      const parts=url.split("/"),bookId=parts.at(-3),noteId=parts.at(-1),book = window.__books.find(item => item.id === bookId), note = book.notes.find(item => item.id === noteId), payload = JSON.parse(init.body);
      Object.assign(note, payload, eventTime(payload), { updatedAt: new Date().toISOString(), version: (note.version || 1) + 1 });
      return url.startsWith("/api/v1/") ? v1(note) : json(note);
    }
    if (/^\\/api\\/v1\\/books\\/[^/]+\\/notes\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const parts=url.split("/"),bookId=parts.at(-3),noteId=parts.at(-1),book=window.__books.find(item=>item.id===bookId);book.notes=book.notes.filter(item=>item.id!==noteId);return v1({trashId:"trash-"+noteId});
    }
    if ((url === "/api/quotes" || url === "/api/v1/quotes") && init.method === "POST") {
      window.__quoteSaves += 1;
      const payload = JSON.parse(init.body), item = { id: "quote-new-" + window.__quoteSaves, createdAt: "2026-09-27T03:20:21.000Z", version: 1, ...payload, ...eventTime(payload) };
      window.__quotes.unshift(item);
      return url.startsWith("/api/v1/") ? v1(item, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?quotes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__quotePatches += 1;
      const item = window.__quotes.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      Object.assign(item, payload, eventTime(payload), { updatedAt: new Date().toISOString(), version: (item.version || 1) + 1 });
      return url.startsWith("/api/v1/") ? v1(item) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?quotes\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id = url.split("/").at(-1);window.__quotes = window.__quotes.filter(item => item.id !== id);return url.startsWith("/api/v1/")?v1({trashId:"trash-"+id}):json({ removed: 1 });
    }
    if (url === "/api/answer-drafts") { const payload=JSON.parse(init.body);return streamResponse({ requestId:payload.requestId,targetId:payload.targetId,inputVersion:payload.inputVersion,draft:"**结论**：后台完成。",reasoningContent:"持久化的模型思考" }); }
    if (url === "/api/annotations/thought/kept-root" && init.method === "POST") {
      window.__thoughtAnnotationSaves += 1;
      const payload = JSON.parse(init.body);
      return json({ id: "thought-highlight-1", createdAt: "2026-09-27T03:29:00.000Z", resolved: false, replies: [], ...payload }, 201);
    }
    if (url === "/api/annotations/analysis/analysis-1" && init.method === "POST") {
      window.__annotationSaves += 1;
      const payload = JSON.parse(init.body), annotation = { id: "analysis-annotation-1", createdAt: "2026-09-27T03:30:00.000Z", resolved: false, replies: [], imageUnderstandings: [], version: 1, ...payload };
      window.__analyses[0].annotations.push(annotation);
      return json(annotation);
    }
    if (url === "/api/annotations/analysis/analysis-1/analysis-annotation-1/convert" && init.method === "PATCH") {
      const annotation=window.__analyses[0].annotations[0],payload=JSON.parse(init.body);
      Object.assign(annotation,payload,{updatedAt:new Date().toISOString()});
      return json(annotation);
    }
    if (url === "/api/annotations/analysis/analysis-1/analysis-annotation-1/shenji" && init.method === "POST") {
      window.__shenjiSaves += 1;
      const payload = JSON.parse(init.body), exchange = { id: "analysis-shenji-1", createdAt: "2026-09-27T03:31:00.000Z", message: payload.message, answer: "**神鸡判断**：这条复盘需要保留反证。", reasoningContent: "核对复盘上下文。" };
      window.__analyses[0].annotations[0].shenji = [exchange];
      return json(exchange);
    }
    if (/^\\/api\\/v1\\/thought-chains\\/[^/]+\\/discovery$/.test(url) && init.method === "PATCH") {
      const id=url.split("/")[4],payload=JSON.parse(init.body),item=window.__thoughts.find(value=>value.id===id&&value.type==="question"),version=(item?.discovery?.version||1)+1;
      item.discovery={...(item.discovery||{}),version,...(payload.action==="read"?{readAt:new Date().toISOString(),snoozedUntil:null}:{snoozedUntil:payload.until})};
      return v1({id,status:{version,read:payload.action==="read",readAt:item.discovery.readAt||null,snoozed:payload.action==="snooze",snoozedUntil:item.discovery.snoozedUntil||null,untraced:true,fresh:false},untraced:true,fresh:false});
    }
    if (/^\\/api\\/v1\\/thought-chains\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const id=url.split("/").at(-1),item=window.__thoughts.find(value=>value.id===id&&value.type==="question"),payload=JSON.parse(init.body);
      Object.assign(item,{content:payload.question,tags:payload.tags||[],...eventTime(payload),updatedAt:new Date().toISOString(),version:(item.version||1)+1});
      return v1(item);
    }
    if (/^\\/api\\/v1\\/thought-chains\\/[^/]+$/.test(url) && init.method === "DELETE") {
      const id=url.split("/").at(-1);
      if(window.__conflictThoughtDelete){window.__conflictThoughtDelete=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"资源版本已变化，请重新读取后再提交",code:"PRECONDITION_FAILED",details:{currentVersion:2}},meta:{}}),{status:412,headers:{"content-type":"application/json"}}))}
      if(window.__failThoughtDeleteNetwork){window.__failThoughtDeleteNetwork=false;throw new TypeError("Load failed")}
      window.__thoughts=window.__thoughts.filter(item=>item.id!==id&&item.relatedTo!==id);
      return v1({trashId:"trash-"+id});
    }
    if (url === "/api/thought-chains" || url === "/api/v1/thought-chains") {
      if(window.__conflictThoughtCreate){window.__conflictThoughtCreate=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"来源念起已变化",code:"PRECONDITION_FAILED",details:{currentVersion:3}},meta:{}}),{status:412,headers:{"content-type":"application/json"}}))}
      if(window.__failThoughtCreateNetwork)throw new TypeError("Load failed");
      window.__thoughtSaves += 1;
      const payload=JSON.parse(init.body);window.__savedPayloads.push(payload);
      const id = "auto-root-" + window.__thoughtSaves,question={ id, createdAt: new Date().toISOString(), ...eventTime(payload), type: "question", content: payload.question, attachmentPaths:payload.attachmentPaths||[], imageUnderstandings:[], tags: payload.tags||[], relatedTo: null, disposition: "kept", remarks: [], followUps: [], annotations: [], annotationDrift: [], version: 1, ...(payload.sourceRef?{sourceRef:payload.sourceRef}:{}) };
      window.__thoughts.unshift(question);
      const result={ items: [question], duplicate: false };
      return url.startsWith("/api/v1/") ? v1(result, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(result);
    }
    if(url==="/api/v1/content-attachments/understandings"&&init.method==="POST"){
      const payload=JSON.parse(init.body),targetType=payload.targetType;
      const respond=()=>{
        let resourceType=targetType==="capture"?"capture":"thought",targetId=payload.targetId,subtargetId="";
        if(targetType==="comment"){for(const [type,items]of Object.entries({analysis:window.__analyses,thought:window.__thoughts,capture:window.__captures})){const parent=items.find(item=>(item.annotations||[]).some(annotation=>annotation.id===payload.targetId));if(parent){resourceType=type;targetId=parent.id;subtargetId=payload.targetId;break}}}
        const task={id:"task-"+(window.__aiTasks.length+1),kind:"contentImageUnderstanding",resourceType,targetId,subtargetId,inputVersion:payload.inputVersion,status:"queued",createdAt:new Date().toISOString(),contentTargetType:targetType,contentTargetId:payload.targetId};
        window.__aiTasks.unshift(task);window.__notifications.unshift({id:"notification-"+task.id,taskId:task.id,resourceType:task.resourceType,targetId:task.targetId,subtargetId:task.subtargetId,kind:"aiTask",status:"queued",title:"图片理解",message:"已进入后台队列",createdAt:task.createdAt,updatedAt:task.createdAt,readAt:""});
        if(window.__holdAiTasks)task.status="running";else setTimeout(()=>window.__completeAiTask(task,{payload}),260);
        return v1(task)
      };
      if(window.__delayImageTaskCreate){window.__delayImageTaskCreate=false;return new Promise(resolve=>{window.__releaseImageTaskCreate=()=>resolve(respond())})}
      return respond()
    }
    if (url === "/api/ai-tasks" && init.method === "POST") {
      const payload=JSON.parse(init.body),task={id:"task-"+(window.__aiTasks.length+1),kind:payload.kind,resourceType:payload.resourceType||(payload.kind==="annotationShenji"?"":"thought"),targetId:payload.targetId,subtargetId:payload.subtargetId||"",inputVersion:payload.inputVersion||0,subtargetVersion:payload.subtargetVersion||0,status:"queued",createdAt:new Date().toISOString()};
      const titles={thoughtAnswer:"思绪回答",followUpAnswer:"追问回答",annotationShenji:"批注神鸡",contentImageUnderstanding:"图片理解"};
      window.__aiTasks.unshift(task);window.__notifications.unshift({id:"notification-"+task.id,taskId:task.id,resourceType:task.resourceType,targetId:task.targetId,subtargetId:task.subtargetId,kind:"aiTask",status:"queued",title:titles[task.kind],message:"已进入后台队列",createdAt:task.createdAt,updatedAt:task.createdAt,readAt:""});
      if(window.__holdAiTasks)task.status="running";
      else setTimeout(()=>window.__completeAiTask(task,payload),260);
      return json(task);
    }
    if (/^\\/api\\/ai-tasks\\/[^/]+\\/result$/.test(url) && (!init.method || init.method === "GET")) {
      const task=window.__aiTasks.find(item=>item.id===url.split("/")[3]),result=task&&window.__taskResults[task.id];
      return task&&result?json({task,result}):json({error:"任务结果不可用"},404);
    }
    if (url === "/api/ai-tasks" && (!init.method || init.method === "GET")) { window.__taskReads+=1;return json({items:window.__aiTasks}); }
    if (url === "/api/notifications" && (!init.method || init.method === "GET")) { window.__notificationReads+=1;return json({items:window.__notifications,unread:window.__notifications.filter(item=>!item.readAt&&item.status==="succeeded").length}); }
    if (/^\\/api\\/notifications\\/[^/]+\\/read$/.test(url) && init.method === "PATCH") { const id=url.split("/")[3],notification=window.__notifications.find(item=>item.id===id);if(notification)notification.readAt=new Date().toISOString();return json(notification||{error:"通知不存在"}); }
    if (url === "/api/notifications/read-all") { window.__notifications.forEach(item=>item.readAt=new Date().toISOString());return json({updated:window.__notifications.length}); }
    if (/^\\/api\\/thoughts\\/auto-root-\\d+\\/answer$/.test(url)) return streamResponse({ id: "auto-answer", content: "**结论**：后台完成。", answer: "**结论**：后台完成。", reasoningContent: "持久化的模型思考" });
    return nativeFetch(input, init);
  };
})();
`;

const staticServer = CONFIGURED_APP_URL ? null : await startStaticServer();
const APP_URL = CONFIGURED_APP_URL || staticServer.url;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "growth-ui-regression-"));
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
  const loaded = await waitUntil(`document.querySelector("#today-date-label")?.textContent.length > 0 && document.querySelector("#auth-gate")?.hidden && !document.body.classList.contains("auth-locked")`);
  assert.equal(loaded, true, JSON.stringify({
    page: await evaluate(`({url:location.href,title:document.title,body:document.body?.innerText.slice(0,300)})`),
    exceptions: cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
  }));
  assert.deepEqual(await evaluate(`({schemaRequests:window.__onboardingSchemaRequests,locked:document.body.classList.contains("auth-locked"),gateHidden:document.querySelector("#auth-gate").hidden,onboardingHidden:document.querySelector("#onboarding-workspace").hidden})`), {
    schemaRequests: 1,
    locked: false,
    gateHidden: true,
    onboardingHidden: true
  });
  assert.equal(await waitUntil(`document.querySelector("#action-columns")?.textContent.includes("完成 G2 界面回归")&&document.querySelector("#habit-list")?.textContent.includes("每日回望")`), true);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await waitUntil(`getComputedStyle(document.querySelector("#view-today")).opacity==="1"`),true);
  await sleep(120);
  const homeDesktop = await evaluate(`(() => {
    const home=document.querySelector("#view-today"),grid=document.querySelector("#home-memory-grid"),backgroundElement=document.querySelector(".home-v02-background"),background=getComputedStyle(backgroundElement),keepsakeImage=document.querySelector(".home-v02-keepsake-preview img");
    return {
      active:home.classList.contains("active")&&home.classList.contains("home-v02"),
      memories:grid.querySelectorAll(".home-v02-memory").length,
      twoColumns:getComputedStyle(grid).gridTemplateColumns.split(" ").length===2,
      userOnly:!grid.textContent.includes("模型回答")&&!grid.textContent.includes("AI总结"),
      traceable:[...grid.querySelectorAll(".home-v02-memory")].every(item=>item.dataset.homeMemoryId&&item.querySelector("[data-home-memory-open]")),
      keepsake:document.querySelector("#home-keepsake").textContent.includes("旧展览票"),
      keepsakeOpaque:keepsakeImage&&getComputedStyle(keepsakeImage).opacity==="1",
      moodPoints:document.querySelectorAll("#home-mood-sparkline circle").length,
      background:background.backgroundImage.includes("desktop-background.png"),
      backgroundFixed:background.position==="fixed"&&Math.round(backgroundElement.getBoundingClientRect().height)===innerHeight,
      actionsCollapsed:!document.querySelector(".home-v02-secondary").open,
      liveStatusHidden:getComputedStyle(document.querySelector("#home-memory-status")).position==="absolute",
      noOverflow:document.documentElement.scrollWidth<=innerWidth
    };
  })()`);
  assert.deepEqual(homeDesktop,{active:true,memories:3,twoColumns:true,userOnly:true,traceable:true,keepsake:true,keepsakeOpaque:true,moodPoints:2,background:true,backgroundFixed:true,actionsCollapsed:true,liveStatusHidden:true,noOverflow:true});
  const homeDesktopScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-desktop.png",Buffer.from(homeDesktopScreenshot.data,"base64"));
  const firstHomeKeys=await evaluate(`[...document.querySelectorAll(".home-v02-memory")].map(item=>item.dataset.homeMemoryKey)`);
  await evaluate(`document.querySelector("#home-shuffle").click();true`);
  const nextHomeKeys=await evaluate(`[...document.querySelectorAll(".home-v02-memory")].map(item=>item.dataset.homeMemoryKey)`);
  assert.equal(nextHomeKeys.some(key=>!firstHomeKeys.includes(key)),true);
  await evaluate(`document.querySelector("#home-open-thought").click();document.querySelector("#chain-question").value="关闭后仍保留的首页草稿";document.querySelector("#chain-question").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector('[data-home-editor-close="thought"]').click();document.querySelector("#home-open-thought").click();true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#chain-question")`),true);
  assert.deepEqual(await evaluate(`({visible:!document.querySelector("#home-thought-editor").hidden,draft:document.querySelector("#chain-question").value,focused:document.activeElement===document.querySelector("#chain-question")})`),{visible:true,draft:"关闭后仍保留的首页草稿",focused:true});
  assert.equal(await evaluate(`(() => { const editor=document.querySelector("#home-thought-editor"),focusable=[...editor.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])')].filter(item=>!item.hidden&&getComputedStyle(item).display!=="none");focusable.at(-1).focus();document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));return document.activeElement===focusable[0]; })()`),true);
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#home-open-thought")`),true);
  assert.deepEqual(await evaluate(`({hidden:document.querySelector("#home-thought-editor").hidden,focusReturned:document.activeElement===document.querySelector("#home-open-thought"),draft:document.querySelector("#chain-question").value})`),{hidden:true,focusReturned:true,draft:"关闭后仍保留的首页草稿"});
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem("cike:session-drafts:user-1")).forms.find(item=>item.key==="form:0").fields.find(item=>item.key==="id:chain-question").value`),"关闭后仍保留的首页草稿");
  await evaluate(`document.querySelector("#chain-question").value="";document.querySelector("#chain-question").dispatchEvent(new Event("input",{bubbles:true}));true`);
  await evaluate(`document.querySelector('.home-v02-memory[data-home-memory-type="thought"] [data-home-memory-open]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="kept-root"]').open`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();document.querySelector("[data-home-keepsake]").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-keepsakes").classList.contains("active")&&!document.querySelector("#keepsake-detail").hidden&&document.querySelector("#keepsake-detail h2").textContent==="旧展览票"`),true);
  await evaluate(`document.querySelector("[data-keepsake-back]").click();document.querySelector('[data-view="today"]').click();true`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(document.querySelector("#home-memory-grid")).gridTemplateColumns.split(" ").length===2&&Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)===176`),true);
  const homeTabletScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-tablet.png",Buffer.from(homeTabletScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(120);
  assert.deepEqual(await evaluate(`(() => {
    const items=[...document.querySelectorAll(".home-v02-memory")],visible=items.filter(item=>getComputedStyle(item).display!=="none");
    return {visible:visible.length,singleColumn:getComputedStyle(document.querySelector("#home-memory-grid")).display==="flex",touch:[document.querySelector("#home-open-thought"),document.querySelector("#home-record-state")].every(item=>item.getBoundingClientRect().height>=44),noOverflow:document.documentElement.scrollWidth<=innerWidth,background:getComputedStyle(document.querySelector(".home-v02-background")).backgroundImage.includes("mobile-background.png")};
  })()`),{visible:2,singleColumn:true,touch:true,noOverflow:true,background:true});
  const homeMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-mobile.png",Buffer.from(homeMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("#view-today button")].filter(item=>getComputedStyle(item).display!=="none").every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  const homeNarrowScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-narrow.png",Buffer.from(homeNarrowScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(()=>{const form=document.querySelector("#action-form");form.elements.title.value="提交时的行动";window.__delayActionCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseActionCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#action-form").elements.title;input.value="等待期间的新行动";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseActionCreate();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#action-status").textContent.includes("新输入已保留")`),true);
  assert.equal(await evaluate(`document.querySelector("#action-form").elements.title.value`),"等待期间的新行动");
  await evaluate(`(()=>{const form=document.querySelector("#action-form"),input=form.elements.title;input.value="刷新失败仍已保存";input.dispatchEvent(new Event("input",{bubbles:true}));window.__failNextActionRefresh=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#action-status").textContent.includes("已保存，但行动列表刷新失败")`),true);
  await evaluate(`(()=>{const form=document.querySelector("#habit-form");form.elements.title.value="提交时的习惯";window.__delayHabitCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseHabitCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#habit-form").elements.title;input.value="等待期间的新习惯";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseHabitCreate();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#habit-status").textContent.includes("新输入已保留")`),true);
  assert.equal(await evaluate(`document.querySelector("#habit-form").elements.title.value`),"等待期间的新习惯");
  await evaluate(`document.querySelector('[data-view="feedback"]').click();(()=>{const form=document.querySelector("#feedback-form");form.elements.feature.value="提交时功能";form.elements.body.value="提交时内容";window.__delayFeedbackCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseFeedbackCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#feedback-form").elements.body;input.value="等待期间的新反馈";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseFeedbackCreate();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#feedback-status").textContent.includes("新输入已保留")`),true);
  assert.equal(await evaluate(`document.querySelector("#feedback-form").elements.body.value`),"等待期间的新反馈");
  await evaluate(`window.__actionListTitle="较早响应";window.__delayActionList=true;document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseActionList==="function"`),true);
  await evaluate(`window.__actionListTitle="最新响应";document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#action-columns").textContent.includes("最新响应")`),true);
  await evaluate(`window.__releaseActionList();true`);
  await sleep(100);
  assert.equal(await evaluate(`document.querySelector("#action-columns").textContent.includes("最新响应")&&!document.querySelector("#action-columns").textContent.includes("较早响应")`),true);
  await evaluate(`window.__failActionConflict=true;document.querySelector('[data-action-start="ui-action"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#toast").textContent.includes("你基于版本 1")&&document.querySelector("#toast").textContent.includes("服务器当前为版本 2")`),true);
  assert.equal(await evaluate(`document.querySelector("#toast").textContent.includes("服务器新标题")&&document.querySelector("#action-columns").textContent.includes("服务器新标题")`),true);
  await evaluate(`window.__delayActionUpdate=true;document.querySelector('[data-action-start="ui-action"]').click();true`);
  await sleep(150);
  assert.deepEqual(await evaluate(`(() => ({columns:[...document.querySelectorAll(".action-column")].map(item=>item.textContent),sync:document.querySelector(".action-entry .checkin-sync-state")?.textContent||""}))()`),{
    columns:["待办0暂无","进行中1P0服务器新标题独立行动正在同步","已完成0暂无"],
    sync:"正在同步"
  });
  await evaluate(`window.__releaseActionUpdate();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-action-complete="ui-action"]')&&!document.querySelector(".action-entry .checkin-sync-state")`),true);
  await evaluate(`window.confirm=()=>true;window.__delayActionDelete=true;document.querySelector('[data-action-delete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#action-columns").textContent.includes("服务器新标题")`),true);
  assert.equal(await waitUntil(`typeof window.__releaseActionDelete==="function"`),true);
  await evaluate(`window.__releaseActionDelete();true`);
  assert.equal(await waitUntil(`document.querySelector("#action-columns").textContent.includes("服务器新标题")&&document.querySelector("#toast").textContent.includes("删除校验失败")`),true);
  await evaluate(`window.__failActionNetwork=true;document.querySelector('[data-action-complete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state")?.textContent==="待同步"`),true);
  assert.equal(await evaluate(`document.querySelector("#toast").textContent.includes("网络恢复后自动同步")&&!document.querySelector('[data-action-complete="ui-action"]')`),true);
  const associationLimit = await evaluate(`(() => {
    const rows=[...document.querySelectorAll("#association-list .association-row")];
    return {count:rows.length,factors:rows.map(row=>row.querySelector("b").textContent),omitted:!document.querySelector("#association-list").textContent.includes("不应显示")};
  })()`);
  assert.deepEqual(associationLimit, { count: 3, factors: ["重点一","重点二","重点三"], omitted: true });
  const desktopNavigation = await evaluate(`(() => {
    const sidebar=document.querySelector(".sidebar"),main=document.querySelector("main"),active=document.querySelector(".nav-button.active"),style=getComputedStyle(sidebar);
    return {
      compact:Math.round(sidebar.getBoundingClientRect().width)===176&&Math.round(parseFloat(getComputedStyle(main).marginLeft))===176,
      lightGlass:style.backgroundColor.startsWith("rgba")&&style.backdropFilter.includes("blur"),
      labels:[...document.querySelectorAll(".nav-button")].map(button=>button.textContent.trim()),
      current:active.dataset.section==="today"&&active.getAttribute("aria-current")==="page",
      inactive:[...document.querySelectorAll(".nav-button:not(.active)")].every(button=>button.getAttribute("aria-current")!=="page"),
      sectionHidden:document.querySelector("#section-nav").hidden,
      secondary:[...document.querySelector("[data-section-links='today']").querySelectorAll("button")].map(button=>button.textContent)
    };
  })()`);
  assert.deepEqual(desktopNavigation, { compact: true, lightGlass: true, labels: ["◌今日","◇所见","∿所思","○我的"], current: true, inactive: true, sectionHidden: false, secondary: ["此刻","共参","每日"] });
  await evaluate(`document.querySelector('[data-section="thought"]').click(); document.querySelector('[data-view="discovery"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-discovery").classList.contains("active")&&document.querySelector("#discovery-list")?.textContent.includes("没有初步想法的问题")`), true);
  await evaluate(`document.querySelector('[data-section="seen"]').click(); true`);
  assert.deepEqual(await evaluate(`({
    activeView:document.querySelector(".view.active").id,
    primary:document.querySelector(".nav-button.active").textContent.trim(),
    secondary:[...document.querySelector("[data-section-links='seen']").querySelectorAll("button")].map(button=>button.textContent),
    selected:document.querySelector(".section-nav button.active").textContent
  })`), { activeView: "view-captures", primary: "◇所见", secondary: ["念起","书间","拾句","小物"], selected: "念起" });
  await evaluate(`document.querySelector('[data-view="keepsakes"]').click(); true`);
  assert.deepEqual(await evaluate(`(() => {
    const grid=document.querySelector(".keepsake-grid"),card=document.querySelector(".keepsake-card"),image=card.querySelector(".keepsake-image-cutout");
    return {count:document.querySelectorAll(".keepsake-card").length,label:document.querySelector("#keepsake-count").textContent,columns:getComputedStyle(grid).columnCount,avoids:getComputedStyle(card).breakInside==="avoid",layers:card.querySelectorAll("img").length,thumb:image.getAttribute("src")===window.__keepsakes[0].thumbPath,originalReads:window.__keepsakeOriginalReads,tags:card.querySelector(".keepsake-tags").textContent,pagination:document.querySelector("#keepsake-pagination-status").textContent};
  })()`), { count: 12, label: "25 件", columns: "3", avoids: true, layers: 1, thumb: true, originalReads: 0, tags: "#展览#同行", pagination: "已显示 12 / 25 件" });
  assert.equal(await waitUntil(`[...document.querySelectorAll(".keepsake-card img")].every(image=>image.complete&&image.naturalWidth>0)`),true);
  await evaluate(`window.__keepsakeObservers.at(-1).trigger();true`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-card").length===24&&document.querySelector("#keepsake-pagination-status").textContent==="已显示 24 / 25 件"`),true);
  await evaluate(`window.__keepsakeObservers.at(-1).trigger();true`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-card").length===25&&document.querySelector("#keepsake-pagination").hidden`),true);
  await evaluate(`document.querySelector("[data-keepsake-open]").click(); true`);
  assert.deepEqual(await evaluate(`(() => {
    const detail=document.querySelector("#keepsake-detail"),image=detail.querySelector(".keepsake-detail-image");
    return {visible:!detail.hidden,libraryHidden:document.querySelector(".keepsake-library").hidden,presentation:detail.querySelector('[data-keepsake-view="presentation"]').classList.contains("active"),layers:image.querySelectorAll("img").length,title:detail.querySelector("h2").textContent,tags:detail.querySelector(".keepsake-tags").textContent};
  })()`), { visible: true, libraryHidden: true, presentation: true, layers: 1, title: "旧展览票", tags: "#展览#同行" });
  assert.equal(await evaluate(`window.__keepsakeOriginalReads`),0);
  await sleep(220);
  const keepsakeDetailScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsake-detail-desktop.png", Buffer.from(keepsakeDetailScreenshot.data, "base64"));
  await evaluate(`document.querySelector('[data-keepsake-view="original"]').click(); true`);
  assert.deepEqual(await evaluate(`(() => { const image=document.querySelector(".keepsake-detail-image img");return {originalSelected:document.querySelector('[data-keepsake-view="original"]').classList.contains("active"),layers:document.querySelectorAll(".keepsake-detail-image img").length,original:image.getAttribute("src")===window.__keepsakes[0].originalPath,originalReads:window.__keepsakeOriginalReads}; })()`), { originalSelected: true, layers: 1, original: true, originalReads: 1 });
  await evaluate(`document.querySelector("[data-keepsake-back]").click(); document.querySelector("#keepsake-create-toggle").click(); true`);
  await evaluate(`(async()=>{const canvas=document.createElement("canvas");canvas.width=48;canvas.height=36;const ctx=canvas.getContext("2d");ctx.fillStyle="#d76455";ctx.fillRect(0,0,48,36);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const file=new File([blob],"ticket.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#keepsake-image");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("自动轮廓已生成")&&document.querySelector("#keepsake-preview-canvas").getContext("2d").getImageData(8,18,1,1).data[3]===255`), true);
  const keepsakeEditorState = await evaluate(`(() => { const preview=document.querySelector("#keepsake-preview-canvas"),ctx=preview.getContext("2d");return {editorVisible:!document.querySelector("#keepsake-editor").hidden,title:document.querySelector("#keepsake-title").value,subjectAlpha:ctx.getImageData(8,18,1,1).data[3],backgroundAlpha:ctx.getImageData(40,18,1,1).data[3],overflow:document.documentElement.scrollWidth>window.innerWidth}; })()`);
  assert.equal(keepsakeEditorState.editorVisible, true);
  assert.equal(keepsakeEditorState.title, "");
  assert.equal(keepsakeEditorState.subjectAlpha, 255);
  assert.ok(keepsakeEditorState.backgroundAlpha >= 37 && keepsakeEditorState.backgroundAlpha <= 39);
  assert.equal(keepsakeEditorState.overflow, false);
  const keepsakeScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsakes-desktop.png", Buffer.from(keepsakeScreenshot.data, "base64"));
  const imageUploadsBeforeKeepsakeSave=await evaluate(`window.__imageUploads.length`);
  await evaluate(`document.querySelector("#keepsake-title").value="新票根";document.querySelector("#keepsake-tags").value="纪念 周末";document.querySelector("#keepsake-form").requestSubmit();true`);
  if(!await waitUntil(`window.__keepsakePayloads.length===1`))throw new Error(await evaluate(`"小物保存未发出："+document.querySelector("#keepsake-save-status").textContent`));
  assert.deepEqual(await evaluate(`({tags:window.__keepsakePayloads[0].tags,uploadRequests:window.__imageUploads.length-${imageUploadsBeforeKeepsakeSave},hasRawImage:Object.hasOwn(window.__keepsakePayloads[0],"image"),mediaPaths:["originalPath","thumbPath","displayPath","editPath","alphaMaskPath"].every(key=>window.__keepsakePayloads[0][key]?.startsWith("/attachments/")),uploadKey:window.__keepsakeUploadKeys[0].length>0,createKey:Boolean(window.__lastKeepsakeCreateKey)})`), {tags:["纪念","周末"],uploadRequests:1,hasRawImage:false,mediaPaths:true,uploadKey:true,createKey:true});
  const savedCutoutAlpha = await evaluate(`(async()=>{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=window.__keepsakeUploadPayloads[0].alphaMask});const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);return {subject:ctx.getImageData(8,18,1,1).data[3],background:ctx.getImageData(40,18,1,1).data[3]}})()`);
  assert.equal(savedCutoutAlpha.subject, 255);
  assert.equal(savedCutoutAlpha.background, 0);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth && getComputedStyle(document.querySelector(".keepsake-grid")).columnCount==="2"`), true);
  const keepsakeMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsakes-mobile.png", Buffer.from(keepsakeMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const keepsakeBatchUploadStart=await evaluate(`window.__keepsakeUploadPayloads.length`);
  await evaluate(`(async()=>{document.querySelector("#keepsake-create-toggle").click();const transfer=new DataTransfer();for(const [index,color]of["#b45f4a","#497d6c","#526a91"].entries()){const canvas=document.createElement("canvas");canvas.width=48;canvas.height=36;const context=canvas.getContext("2d");context.fillStyle=color;context.fillRect(0,0,48,36);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));transfer.items.add(new File([blob],"batch-"+(index+1)+".png",{type:"image/png"}))}const input=document.querySelector("#keepsake-image");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-batch-item").length===3&&document.querySelector("#keepsake-segment-status").textContent.includes("自动轮廓已生成")`),true);
  await evaluate(`document.querySelector("#toast").hidden=true;document.querySelector("#keepsake-batch").scrollIntoView({block:"start"});true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".keepsake-batch-item")].every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  await fs.writeFile("/tmp/growth-keepsake-batch-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-keepsake-batch-remove="2"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-batch-item").length===2`),true);
  await evaluate(`window.__failKeepsakeCreateOnce=true;document.querySelector("#keepsake-title").value="失败后保留";document.querySelector("#keepsake-title").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#keepsake-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector(".keepsake-batch-item.failed")&&document.querySelector("#keepsake-save-status").textContent.includes("暂时失败")`),true);
  const failedKeepsakeKey=await evaluate(`window.__keepsakeCreateKeys.at(-1)`);
  await evaluate(`document.querySelector('[data-keepsake-batch-select="1"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-keepsake-batch-select="1"]')?.getAttribute("aria-pressed")==="true"&&document.querySelector("#keepsake-segment-status").textContent.includes("自动轮廓已生成")`),true);
  await evaluate(`document.querySelector("#keepsake-title").value="第二件成功";document.querySelector("#keepsake-title").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#keepsake-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__keepsakePayloads.length===2&&document.querySelectorAll(".keepsake-batch-item").length===1&&document.querySelector("#keepsake-title").value==="失败后保留"`),true);
  assert.equal(await evaluate(`document.querySelector("#keepsake-title").value`),"失败后保留");
  await evaluate(`document.querySelector("#keepsake-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__keepsakePayloads.length===3&&document.querySelector("#keepsake-batch").hidden&&document.querySelector("#keepsake-workspace").hidden`),true);
  assert.deepEqual(await evaluate(`({uploads:window.__keepsakeUploadPayloads.length-${keepsakeBatchUploadStart},sameCreateKey:window.__keepsakeCreateKeys.at(-1)===${JSON.stringify(failedKeepsakeKey)},remaining:document.querySelectorAll(".keepsake-batch-item").length})`),{uploads:2,sameCreateKey:true,remaining:0});
  await evaluate(`(() => {
    const NativeImage=window.Image;window.__releaseImage=null;window.__releasedImageLoaded=false;
    window.Image=class extends NativeImage {
      set src(value){window.Image=NativeImage;this.addEventListener("load",()=>{window.__releasedImageLoaded=true},{once:true});window.__releaseImage=()=>{super.src=value}}
    };
    document.querySelector("[data-keepsake-edit]").click();
  })()`);
  assert.equal(await waitUntil(`typeof window.__releaseImage==="function"`), true);
  await evaluate(`document.querySelector("#keepsake-editor-close").click();document.querySelector("#keepsake-create-toggle").click();document.querySelector("#keepsake-title").value="新的留存";window.__releaseImage();true`);
  assert.equal(await waitUntil(`window.__releasedImageLoaded`), true);
  await sleep(100);
  assert.deepEqual(await evaluate(`({hidden:document.querySelector("#keepsake-editor").hidden,title:document.querySelector("#keepsake-title").value,id:document.querySelector("#keepsake-id").value})`), { hidden: true, title: "新的留存", id: "" });
  await evaluate(`document.querySelector("#keepsake-editor-close").click();true`);
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
  assert.deepEqual(reviewSignals.labels, ["近 7 日记录覆盖","近 30 日身心同日","近 30 日思考留痕率","近 30 日主动校正","距上次认知复盘"]);
  assert.deepEqual(reviewSignals.values, ["4/ 7 天","2天","60%","7次","今天"]);
  assert.equal(reviewSignals.fiveColumns, true);
  assert.equal(reviewSignals.light, true);
  assert.equal(reviewSignals.compactRadius, true);
  const coldStartReview = await evaluate(`(() => {
    const panels=[...document.querySelectorAll(".review-primary-grid>.panel")],flowModal=document.querySelector("#association-flow-modal"),button=document.querySelector("#association-flow-toggle"),fills=[...document.querySelectorAll("#trend-list .trend-bar span")],backgrounds=fills.map(item=>getComputedStyle(item).backgroundImage);
    return {
      trendObservation:document.querySelector("#trend-list").textContent.includes("当前均值"),
      gradientBars:backgrounds.every(value=>value.includes("linear-gradient"))&&new Set(backgrounds).size===4,
      valueBrightness:getComputedStyle(fills[0]).filter!==getComputedStyle(fills[1]).filter,
      flowHidden:flowModal.hidden,
      toggleCollapsed:button.getAttribute("aria-expanded")==="false",
      equalHeight:Math.abs(panels[0].getBoundingClientRect().height-panels[1].getBoundingClientRect().height)<2
    };
  })()`);
  assert.deepEqual(coldStartReview, { trendObservation: true, gradientBars: true, valueBrightness: true, flowHidden: true, toggleCollapsed: true, equalHeight: true });
  await evaluate(`document.querySelector("#association-flow-toggle").click(); true`);
  assert.equal(await evaluate(`(() => { const panels=[...document.querySelectorAll(".review-primary-grid>.panel")]; return !document.querySelector("#association-flow-modal").hidden && document.querySelector("#association-flow").textContent.includes("按自然日聚合") && document.querySelector("#association-flow-toggle").getAttribute("aria-expanded")==="true" && Math.abs(panels[0].getBoundingClientRect().height-panels[1].getBoundingClientRect().height)<2; })()`), true);
  const associationFlowScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-association-flow-modal.png", Buffer.from(associationFlowScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`(() => { const modal=document.querySelector(".association-flow-modal").getBoundingClientRect();return modal.left>=0&&modal.right<=window.innerWidth&&modal.top>=0&&modal.bottom<=window.innerHeight&&document.documentElement.scrollWidth<=window.innerWidth; })()`), true);
  const associationFlowMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-association-flow-modal-mobile.png", Buffer.from(associationFlowMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("#association-flow-close").click(); true`);
  assert.equal(await evaluate(`document.querySelector("#association-flow-modal").hidden && document.querySelector("#association-flow-toggle").getAttribute("aria-expanded")==="false"`), true);
  const checkinReview = await evaluate(`({
    nestedInTrend:Boolean(document.querySelector(".trend-panel #state-chart")),
    removedFromToday:!document.querySelector("#view-today #state-chart"),
    entries:document.querySelectorAll("#checkin-history .checkin-history-entry").length,
    editButtons:document.querySelectorAll("#checkin-history [data-edit-checkin]").length
  })`);
  assert.deepEqual(checkinReview, { nestedInTrend: true, removedFromToday: true, entries: 2, editButtons: 2 });
  await evaluate(`document.querySelector('[data-edit-checkin="checkin-latest"]').click(); true`);
  const checkinEditState = await evaluate(`(() => { const date=new Date(window.__checkins[0].occurredAt),pad=value=>String(value).padStart(2,"0"),expected=(date.getFullYear()+"-"+pad(date.getMonth()+1)+"-"+pad(date.getDate())+"T"+pad(date.getHours())+":"+pad(date.getMinutes())+":"+pad(date.getSeconds())).replace(/:00$/,"");return { hidden:document.querySelector("#edit-checkin-modal").hidden,datetime:document.querySelector("#edit-checkin-datetime").value,expected,metrics:document.querySelectorAll("[data-edit-checkin-metric]").length }; })()`);
  assert.deepEqual(checkinEditState, { hidden: false, datetime: checkinEditState.expected, expected: checkinEditState.expected, metrics: 4 });
  const checkinEditScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-checkin-edit.png", Buffer.from(checkinEditScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`(() => { const modal=document.querySelector(".edit-checkin-form").getBoundingClientRect();return modal.left>=0&&modal.right<=window.innerWidth&&modal.top>=0&&modal.bottom<=window.innerHeight&&document.documentElement.scrollWidth<=window.innerWidth; })()`), true);
  const checkinEditMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-checkin-edit-mobile.png", Buffer.from(checkinEditMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("#edit-checkin-factors").value="散步 咖啡"; document.querySelector('[data-edit-checkin-metric="mood"]').value="5"; document.querySelector("#edit-checkin-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__checkinPatches===1&&document.querySelector('[data-edit-checkin="checkin-latest"]')`), true);
  assert.equal(await evaluate(`window.__checkins[0].createdAt==="2026-09-27T08:00:00.000Z"&&window.__checkins[0].mood===5&&window.__checkins[0].factors.join("、")==="散步、咖啡"`), true);
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
  await evaluate(`document.querySelector('[data-view="together"]').click(); true`);
  assert.equal(await evaluate(`Boolean(document.querySelector(".chat-message.user strong")) && document.querySelector(".chat-message.agent h2")?.textContent === "模型回答"`), true);
  assert.equal(await evaluate(`[...document.querySelectorAll(".chat-message>.markdown-content")].every(item => item.classList.contains("commentable"))`), true);
  assert.equal(await evaluate(`document.querySelector("#view-together").classList.contains("active")&&document.querySelector("[data-section-links='today'] [data-view='together']").classList.contains("active")&&document.querySelector("#view-together h2").textContent==="共参"&&document.querySelector("#view-together .recent-section h2").textContent==="一日心迹"`), true);
  await sleep(100);
  const togetherScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-together.png", Buffer.from(togetherScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&document.querySelector("#view-together .today-chat").getBoundingClientRect().right<=window.innerWidth`), true);
  const togetherMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-together-mobile.png", Buffer.from(togetherMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="today"]').click(); document.querySelector("#home-open-thought").click(); true`);
  await evaluate(`document.querySelector("#thought-prompt-button").click(); true`);
  assert.equal(await waitUntil(`window.__thoughtPrompts===1&&document.querySelector("#chain-question").value.length>0`), true);
  assert.equal(await evaluate(`document.querySelector("#chain-question").value`), "之前那件还没想完的事，现在最想往前推哪一步？");
  assert.match(await evaluate(`document.querySelector("#thought-prompt-status").textContent`), /只是引子/);
  for (const reset of [false, true]) {
    await evaluate(`(() => {
      window.__holdPrompt=true;window.__resolvePrompt=null;
      const question=document.querySelector("#chain-question");question.value="";
      document.querySelector("#thought-prompt-button").click();
    })()`);
    assert.equal(await waitUntil(`typeof window.__resolvePrompt==="function"`), true);
    await evaluate(reset
      ? `document.querySelector("#chain-form").reset();window.__resolvePrompt();true`
      : `document.querySelector("#chain-question").value="我刚写的新问题";document.querySelector("#chain-question").dispatchEvent(new Event("input"));window.__resolvePrompt();true`);
    assert.equal(await waitUntil(`!document.querySelector("#thought-prompt-button").disabled`), true);
    assert.equal(await evaluate(`document.querySelector("#chain-question").value`), reset ? "" : "我刚写的新问题");
  }
  await evaluate(`window.__holdPrompt=false;true`);
  await evaluate(`document.querySelector('[data-home-editor-close="thought"]').click();document.querySelector("#home-record-state").click();true`);
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
  await evaluate(`window.__delayCheckinCreate=true;document.querySelector("#checkin-confirm-all").click();document.querySelector("#checkin-factors").value="即时反馈";document.querySelector("#checkin-form").requestSubmit();true`);
  assert.equal(await waitUntil(`typeof window.__releaseCheckinCreate==="function"&&document.querySelector(".checkin-history-entry.is-syncing")?.textContent.includes("即时反馈")`), true);
  assert.deepEqual(await evaluate(`({saves:window.__checkinSaves,status:["待同步","正在同步"].includes(document.querySelector(".checkin-sync-state")?.textContent),form:document.querySelector("#checkin-factors").value,editable:Boolean(document.querySelector(".checkin-history-entry.is-syncing [data-edit-checkin]"))})`), { saves:0, status:true, form:"即时反馈", editable:false });
  await evaluate(`window.__releaseCheckinCreate();true`);
  assert.equal(await waitUntil(`window.__checkinSaves===1&&document.querySelector('[data-checkin-id="checkin-new-1"]')&&document.querySelector("#home-state-editor").hidden`), true);
  assert.deepEqual(await evaluate(`({factor:window.__checkinPayloads[0].factors[0],timeMode:window.__checkinPayloads[0].timeMode,modalHidden:document.querySelector("#home-state-editor").hidden})`), { factor:"即时反馈", timeMode:"now", modalHidden:true });
  await evaluate(`document.querySelector("#home-record-state").click();window.__failCheckinCreate=true;document.querySelector("#checkin-confirm-all").click();document.querySelector("#checkin-factors").value="断网状态";document.querySelector("#checkin-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector(".checkin-sync-state.pending")?.textContent==="待同步"&&document.querySelector("#checkin-status").textContent==="已记下，网络恢复后自动同步。"`), true);
  assert.deepEqual(await evaluate(`({saves:window.__checkinSaves,visible:document.querySelector(".checkin-history-entry.is-syncing")?.textContent.includes("断网状态"),form:document.querySelector("#checkin-factors").value,status:document.querySelector("#checkin-status").textContent,modalHidden:document.querySelector("#home-state-editor").hidden})`), { saves:1, visible:true, form:"", status:"已记下，网络恢复后自动同步。", modalHidden:true });
  await evaluate(`document.querySelector("#home-record-state").click();window.__conflictCheckinCreate=true;document.querySelector("#checkin-confirm-all").click();document.querySelector("#checkin-factors").value="冲突状态";document.querySelector("#checkin-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#checkin-status").textContent.includes("同步冲突")`),true);
  assert.deepEqual(await evaluate(`({form:document.querySelector("#checkin-factors").value,visible:document.querySelector("#checkin-history").textContent.includes("冲突状态"),modalHidden:document.querySelector("#home-state-editor").hidden})`),{form:"冲突状态",visible:false,modalHidden:false});
  await evaluate(`document.querySelector('[data-view="daily"]').click(); true`);
  assert.equal(await evaluate(`document.querySelector("#view-daily").classList.contains("active")&&document.querySelector("#view-daily .daily-record-card h2").textContent==="日录"&&!document.querySelector("#view-daily .today-chat")&&!document.querySelector("#view-daily #today-thoughts")`), true);
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
  await evaluate(`window.__delayParseKind="sleep";document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`window.__healthParses===2&&typeof window.__releaseParse==="function"`),true);
  await evaluate(`(() => { const input=document.querySelector('[data-daily-form="sleep"] [name="totalMinutes"]');input.value="461";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseParse();return true })()`);
  assert.equal(await waitUntil(`document.querySelector("#health-parse-status").textContent.includes("当前表单已经变化")`),true);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="sleep"] [name="totalMinutes"]').value`),"461");
  await evaluate(`window.__tamperParseField="inputVersion";document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`window.__healthParses===3&&document.querySelector("#health-parse-status").textContent.includes("当前表单已经变化")`),true);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="sleep"] [name="totalMinutes"]').value`),"461");
  await evaluate(`window.__tamperParseField="";true`);
  await evaluate(`document.querySelector('[data-daily-form="sleep"]').requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__dailySaves===1&&document.querySelector('[data-daily-record-id="daily-1"]')`),true);
  assert.equal(await evaluate(`document.querySelector("#daily-record-chart svg")?.getAttribute("aria-label")==="最近总睡眠趋势"&&!document.querySelector("#daily-record-chart").textContent.includes("暂无")`),true);
  assert.equal(await evaluate(`document.querySelectorAll('[data-daily-record-id="daily-1"] .daily-attachments [data-image-viewer-path]').length`),2);
  await evaluate(`(() => {const nativeRevoke=URL.revokeObjectURL.bind(URL);window.__viewerRevoked=[];window.__restoreViewerRevoke=()=>{URL.revokeObjectURL=nativeRevoke};URL.revokeObjectURL=url=>{window.__viewerRevoked.push(url);nativeRevoke(url)};document.querySelector('[data-daily-record-id="daily-1"] [data-image-viewer-path]').click();return true})()`);
  assert.equal(await waitUntil(`!document.querySelector("#image-viewer").hidden&&!document.querySelector("#image-viewer-image").hidden&&document.querySelector("#image-viewer-image").src.startsWith("blob:")`),true);
  assert.deepEqual(await evaluate(`({counter:document.querySelector("#image-viewer-counter").textContent,prev:document.querySelector("#image-viewer-prev").disabled,next:document.querySelector("#image-viewer-next").disabled,locked:document.body.classList.contains("image-viewer-open")})`),{counter:"1 / 2",prev:true,next:false,locked:true});
  assert.equal(await evaluate(`(()=>{document.querySelector("#image-viewer-close").focus();document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}));const wrappedBackward=document.activeElement===document.querySelector("#image-viewer-next");document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));return wrappedBackward&&document.activeElement===document.querySelector("#image-viewer-close")})()`),true);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`(()=>{const dialog=document.querySelector(".image-viewer-dialog").getBoundingClientRect(),stage=document.querySelector(".image-viewer-stage").getBoundingClientRect();return dialog.left>=0&&dialog.right<=innerWidth&&dialog.bottom<=innerHeight&&stage.width>0&&stage.height>0&&document.documentElement.scrollWidth<=innerWidth})()`),true);
  await fs.writeFile("/tmp/growth-image-viewer-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));true`);
  assert.equal(await waitUntil(`document.querySelector("#image-viewer-counter").textContent==="2 / 2"&&!document.querySelector("#image-viewer-image").hidden`),true);
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true`);
  assert.equal(await evaluate(`document.querySelector("#image-viewer").hidden&&!document.body.classList.contains("image-viewer-open")&&window.__viewerRevoked.length>=2`),true);
  await evaluate(`window.__restoreViewerRevoke();window.__failAttachmentRead=true;document.querySelector('[data-daily-record-id="daily-1"] [data-image-viewer-path]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#image-viewer-status").textContent==="无权读取这张图片"`),true);
  await evaluate(`document.querySelector("#image-viewer-close").click();true`);
  await evaluate(`window.__releaseAttachmentRead=null;window.__delayAttachmentRead=true;document.querySelector('[data-daily-record-id="daily-1"] [data-image-viewer-path]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseAttachmentRead==="function"`),true);
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));true`);
  assert.equal(await waitUntil(`document.querySelector("#image-viewer-counter").textContent==="2 / 2"&&!document.querySelector("#image-viewer-image").hidden`),true);
  const switchedViewerSrc=await evaluate(`document.querySelector("#image-viewer-image").src`);
  await evaluate(`window.__releaseAttachmentRead();true`);await sleep(50);
  assert.equal(await evaluate(`document.querySelector("#image-viewer-image").src`),switchedViewerSrc);
  await evaluate(`document.querySelector("#image-viewer-close").click();window.__releaseAttachmentRead=null;window.__delayAttachmentRead=true;document.querySelector('[data-daily-record-id="daily-1"] [data-image-viewer-path]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseAttachmentRead==="function"`),true);
  await evaluate(`document.querySelector("#image-viewer-close").click();window.__releaseAttachmentRead();true`);await sleep(50);
  assert.equal(await evaluate(`document.querySelector("#image-viewer").hidden&&!document.querySelector("#image-viewer-image").hasAttribute("src")`),true);
  await evaluate(`document.querySelector('[data-daily-tab="weight"]').click(); true`);
  assert.deepEqual(await evaluate(`(()=>{const buttons=[...document.querySelectorAll("[data-weight-trend]")];return{labels:buttons.map(button=>button.textContent),active:buttons.find(button=>button.getAttribute("aria-pressed")==="true")?.textContent,interval:Boolean(document.querySelector(".weight-chart .weight-interval")),note:document.querySelector(".weight-chart-note").textContent}})()`),{labels:["体重","体脂率","肌肉量"],active:"体重",interval:true,note:"图中使用衣物校正值；区间来自固定衣物重量假设，不代表体脂秤测量误差或医学置信区间。"});
  assert.deepEqual(await evaluate(`(()=>{const card=document.querySelector('[data-daily-record-id="weight-existing"]'),details=card.querySelector(".weight-record-details"),summary=[...card.querySelectorAll(".weight-record-summary>span")].map(item=>item.textContent.trim());return{open:details.open,summary,detailHidden:card.querySelector(".weight-record-detail-body").getBoundingClientRect().height===0,target:details.querySelector("summary").getBoundingClientRect().height>=44,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{open:false,summary:["69.50 kg体重（衣物校正）","18.4%体脂率","54.2 kg肌肉量"],detailHidden:true,target:true,noOverflow:true});
  await evaluate(`document.querySelector('[data-daily-record-id="weight-existing"] .weight-record-details').open=true;true`);
  assert.equal(await evaluate(`document.querySelector('[data-daily-record-id="weight-existing"] .weight-record-detail-body').textContent.includes("秤上 70.00 kg · 轻便衣物")`),true);
  await evaluate(`document.querySelector('[data-weight-trend="bodyFatPercent"]').click();true`);
  assert.deepEqual(await evaluate(`(()=>{const button=document.querySelector('[data-weight-trend="bodyFatPercent"]'),svg=document.querySelector(".weight-chart");return{active:button.getAttribute("aria-pressed"),aria:svg.getAttribute("aria-label"),points:svg.querySelectorAll(".weight-point").length,interval:Boolean(svg.querySelector(".weight-interval")),note:document.querySelector(".weight-chart-note").textContent,expanded:document.querySelector('[data-daily-record-id="weight-existing"] .weight-record-details').open}})()`),{active:"true",aria:"最近体脂率趋势",points:1,interval:false,note:"缺失记录不补零、不推算；横向位置按测量时间，日期不连续时保留真实间隔。",expanded:true});
  await evaluate(`(() => {
    window.__pasteHealth=()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),event=new Event("paste",{bubbles:true,cancelable:true});Object.defineProperty(event,"clipboardData",{value:{files:[new File([bytes],"synthetic-health.png",{type:"image/png"})]}});document.body.dispatchEvent(event)};
    window.__weightDateBefore=document.querySelector('[data-daily-form="weight"] [name="occurredAt"]').value;
    window.__pasteHealth();document.querySelector("#parse-health-images").click();return true;
  })()`);
  assert.equal(await waitUntil(`document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value==="42.2"`),true);
  assert.equal(await evaluate(`(() => {const f=document.querySelector('[data-daily-form="weight"]');return !document.querySelector("#health-image-workflow").hidden&&f.elements.measuredWeight.value===""&&f.elements.bmi.value===""&&f.elements.bodyFatPercent.value===""&&f.elements.measuredAt.value===""&&f.elements.occurredAt.value===window.__weightDateBefore&&f.querySelector("details").open&&f.elements.description.value.includes("原报告标注")})()`),true);
  await evaluate(`window.__delayParseKind="weight";window.__releaseParse=null;document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseParse==="function"`),true);
  await evaluate(`(() => {const input=document.querySelector('[data-daily-form="weight"] [name="description"]');input.value="核对后修改的体成分描述";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseParse();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#health-parse-status").textContent.includes("当前表单已经变化")`),true);
  await evaluate(`document.querySelector('[data-daily-form="weight"]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__dailySaves===2&&document.querySelector('[data-daily-record-id="daily-2"]')`),true);
  assert.equal(await evaluate(`(() => {const item=window.__dailyRecords.find(item=>item.id==="daily-2"),card=document.querySelector('[data-daily-record-id="daily-2"]'),details=card.querySelector(".weight-record-details"),summary=[...card.querySelectorAll(".weight-record-summary>span")].map(entry=>entry.textContent.trim());return item.measuredWeight===null&&item.bodyWaterMass===42.2&&item.description==="核对后修改的体成分描述"&&item.attachmentPaths[0]==="/attachments/weight.png"&&card.querySelectorAll(".daily-attachments [data-image-viewer-path]").length===1&&summary.join("|")==="—体重|—体脂率|53.6 kg肌肉量"&&!details.open&&document.querySelector('[data-daily-record-id="weight-existing"] .weight-record-details').open&&card.textContent.includes("总重量未填写")&&card.textContent.includes("42.2")&&!card.textContent.includes("NaN")&&document.querySelectorAll("#health-image-previews figure").length===0&&document.querySelector('[data-daily-form="weight"] [name="verification"]').value===""})()`),true);
  await evaluate(`document.querySelector('[data-daily-edit="daily-2"]').click();true`);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value==="42.2"&&document.querySelector('[data-daily-form="weight"] [name="measuredWeight"]').value===""`),true);
  await evaluate(`(() => {const f=document.querySelector('[data-daily-form="weight"]');f.elements.bodyFatMass.value="";f.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__dailyPatches===1&&window.__dailyRecords.find(item=>item.id==="daily-2").bodyFatMass===null`),true);
  // A body-composition-only history must render without invalid SVG coordinates.
  await evaluate(`window.__savedWeightRecords=window.__dailyRecords;window.__dailyRecords=window.__dailyRecords.filter(item=>item.type!=="weight"||item.id==="daily-2");document.querySelector('[data-view="today"]').click();document.querySelector('[data-view="daily"]').click();true`);
  // Refresh through the normal save flow to use the current mocked server state.
  await evaluate(`document.querySelector('[data-daily-edit="daily-2"]').click();document.querySelector('[data-daily-form="weight"]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__dailyPatches===2&&!document.querySelector("#daily-record-chart svg")&&document.querySelector(".weight-chart-empty")?.textContent.includes("体脂率")&&document.querySelector('[data-daily-record-id="daily-2"]')`),true);
  await evaluate(`window.__dailyRecords=window.__savedWeightRecords;document.querySelector('[data-daily-edit="daily-2"]').click();true`);
  await evaluate(`document.querySelector("#daily-records").scrollIntoView({block:"start"}); true`);
  await sleep(150);
  const dailyScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-daily-records.png",Buffer.from(dailyScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&document.querySelector("#daily-records").getBoundingClientRect().right<=window.innerWidth&&[...document.querySelectorAll("[data-weight-trend]")].every(button=>button.getBoundingClientRect().height>=44&&button.getBoundingClientRect().right<=window.innerWidth)`),true);
  const dailyMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-daily-records-mobile.png",Buffer.from(dailyMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-daily-tab="exercise"]').click();document.querySelector('[data-daily-form="exercise"] [name="description"]').value="识别前已写的感受";window.__pasteHealth();document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-daily-form="exercise"] [name="durationSeconds"]').value==="00:33:07"`),true);
  assert.deepEqual(await evaluate(`(() => {const f=document.querySelector('[data-daily-form="exercise"]');return ["exerciseType","activeCalories","totalCalories","averageHeartRate","maximumHeartRate","aerobicSeconds","anaerobicSeconds","extremeSeconds","distanceKm","occurredAt","description","recognitionDescription"].map(key=>f.elements[key].value)})()`),["力量训练","184","231","111","137","00:00:00","","","","2026-09-23T17:12:34","识别前已写的感受","力量训练期间心率多次升降，后段回落；不估计曲线逐点数值。"]);
  await evaluate(`document.querySelector('[data-daily-form="exercise"] [name="description"]').value="今天后半程有些吃力";true`);
  await evaluate(`document.querySelector('[data-daily-form="exercise"]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__dailySaves===3&&document.querySelector('[data-daily-record-id="daily-3"]')`),true);
  assert.equal(await evaluate(`(() => {const item=window.__dailyRecords.find(item=>item.id==="daily-3"),card=document.querySelector('[data-daily-record-id="daily-3"]'),user=card.querySelector(".exercise-description.user"),derived=card.querySelector(".exercise-description.derived"),legacy=document.querySelector('[data-daily-record-id="exercise-legacy"]');return item.durationSeconds===1987&&item.aerobicSeconds===0&&item.anaerobicSeconds===null&&item.attachmentPaths[0]==="/attachments/exercise.png"&&card.querySelectorAll(".daily-attachments [data-image-viewer-path]").length===1&&item.description==="今天后半程有些吃力"&&item.recognitionDescription.includes("心率多次升降")&&user.querySelector("small").textContent==="记下感受"&&user.querySelector("p").textContent==="今天后半程有些吃力"&&derived.querySelector("small").textContent==="AI 解析描述"&&derived.querySelector("p").textContent.includes("心率多次升降")&&legacy.querySelector(".exercise-description.user").textContent.includes("旧记录里的轻松感受")&&!legacy.querySelector(".exercise-description.derived")&&card.textContent.includes("力量训练")&&card.textContent.includes("00:33:07")&&card.textContent.includes("活动热量")&&card.textContent.includes("总热量")})()`),true);
  assert.equal(await evaluate(`document.querySelector("#daily-record-chart svg")?.getAttribute("aria-label")==="最近运动时长趋势"`),true);
  await evaluate(`document.querySelector('[data-daily-edit="daily-3"]').click();true`);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="exercise"] [name="durationSeconds"]').value==="00:33:07"&&document.querySelector('[data-daily-form="exercise"] [name="anaerobicSeconds"]').value===""&&document.querySelector('[data-daily-form="exercise"] [name="description"]').value==="今天后半程有些吃力"&&document.querySelector('[data-daily-form="exercise"] [name="recognitionDescription"]').value.includes("心率多次升降")`),true);
  await evaluate(`document.querySelector('[data-daily-tab="heartRate"]').click();true`);
  assert.deepEqual(await evaluate(`(()=>{const card=document.querySelector('[data-daily-record-id="heart-summary"]'),details=card.querySelector(".heart-trend-disclosure"),summary=details.querySelector("summary"),body=details.querySelector(".heart-trend"),chart=document.querySelector("#daily-record-chart svg");return{open:details.open,label:summary.textContent.trim(),target:summary.getBoundingClientRect().height>=44,hidden:body.getBoundingClientRect().height===0,screenshots:card.querySelectorAll(".daily-attachments [data-image-viewer-path]").length,chart:chart?.getAttribute("aria-label"),ranges:chart?.querySelectorAll(".health-range").length,points:chart?.querySelectorAll(".weight-point").length,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{open:false,label:"查看当天趋势",target:true,hidden:true,screenshots:1,chart:"最近心率趋势",ranges:2,points:1,noOverflow:true});
  await evaluate(`document.querySelector('[data-daily-record-id="heart-summary"] .heart-trend-disclosure').open=true;true`);
  assert.equal(await evaluate(`document.querySelector('[data-daily-record-id="heart-summary"] .heart-trend').textContent`),"凌晨下降，午后与晚间抬升。");
  await evaluate(`document.querySelector('[data-daily-tab="exercise"]').click();document.querySelector('[data-daily-edit="daily-3"]').click();true`);
  // Cancel an edit with a pending recognition; a late result must not refill it.
  await evaluate(`window.__pasteHealth();window.__delayParseKind="exercise";window.__releaseParse=null;document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseParse==="function"`),true);
  await evaluate(`document.querySelector('[data-daily-form="exercise"] [data-daily-cancel]').click();window.__releaseParse();true`);
  await sleep(100);
  assert.equal(await evaluate(`(() => {const f=document.querySelector('[data-daily-form="exercise"]');return f.elements.recordId.value===""&&f.elements.durationSeconds.value===""&&f.elements.exerciseType.value===""&&f.elements.attachmentPaths.value===""&&!document.querySelector("#parse-health-images").disabled})()`),true);
  await evaluate(`window.__delayParseKind="exercise";window.__releaseParse=null;document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseParse==="function"`),true);
  await evaluate(`document.querySelector('[data-daily-tab="weight"]').click();window.__releaseParse();true`);
  await sleep(100);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="exercise"] [name="exerciseType"]').value===""&&document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value==="42.2"`),true);
  await evaluate(`document.querySelector('[data-daily-tab="exercise"]').click();document.querySelector('[data-daily-edit="daily-3"]').click();document.querySelector('[data-daily-form="exercise"]').scrollIntoView({block:"start"});true`);
  await sleep(100);
  await fs.writeFile("/tmp/growth-exercise-record.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&[...document.querySelectorAll('[data-daily-form="exercise"] input')].filter(input=>input.type!=="hidden").every(input=>input.getBoundingClientRect().right<=window.innerWidth)`),true);
  await fs.writeFile("/tmp/growth-exercise-record-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  const weightBatchParseStart=await evaluate(`window.__healthParses`);
  await evaluate(`(()=>{document.querySelector('[data-daily-tab="weight"]').click();const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),transfer=new DataTransfer();for(let index=0;index<3;index+=1)transfer.items.add(new File([bytes],"weight-day-"+(index+1)+".png",{type:"image/png"}));const input=document.querySelector("#health-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));["2026-09-20","2026-09-21","2026-09-22"].forEach((date,index)=>{const field=document.querySelector('[data-weight-batch-date="'+index+'"]');field.value=date;field.dispatchEvent(new Event("change",{bubbles:true}))});return true})()`);
  assert.deepEqual(await evaluate(`({cards:document.querySelectorAll(".weight-batch-item").length,multiple:document.querySelector("#health-images").multiple,dates:[...document.querySelectorAll("[data-weight-batch-date]")].map(input=>input.value)})`),{cards:3,multiple:true,dates:["2026-09-20","2026-09-21","2026-09-22"]});
  await evaluate(`document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`window.__healthParses===${weightBatchParseStart+3}&&document.querySelectorAll(".weight-batch-item").length===3&&[...document.querySelectorAll(".weight-batch-select small")].every(item=>item.textContent.includes("已识别"))&&!document.querySelector("#parse-health-images").disabled`,200,25),true);
  assert.deepEqual(await evaluate(`window.__healthParsePayloads.slice(-3).map(item=>({kind:item.kind,referenceDate:item.referenceDate,paths:item.attachmentPaths.length}))`),[
    {kind:"weight",referenceDate:"2026-09-20",paths:1},
    {kind:"weight",referenceDate:"2026-09-21",paths:1},
    {kind:"weight",referenceDate:"2026-09-22",paths:1}
  ]);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="weight"] [name="occurredAt"]').value.startsWith("2026-09-20")`),true);
  await evaluate(`document.querySelector('[data-weight-batch-select="1"]').click();true`);
  assert.equal(await evaluate(`document.querySelector('[data-daily-form="weight"] [name="occurredAt"]').value.startsWith("2026-09-21")&&document.querySelector('[data-weight-batch-select="1"]').getAttribute("aria-pressed")==="true"`),true);
  await evaluate(`document.querySelector("#toast").hidden=true;document.querySelector("#health-image-workflow").scrollIntoView({block:"start"});true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".weight-batch-item")].every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  await fs.writeFile("/tmp/growth-weight-batch-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-daily-form="weight"]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__dailySaves===4&&document.querySelectorAll(".weight-batch-item").length===2`),true);
  assert.deepEqual(await evaluate(`(()=>{const item=window.__dailyRecords.find(value=>value.id==="daily-4");return{date:item.occurredOn,paths:item.attachmentPaths.length,nextDate:document.querySelector('[data-daily-form="weight"] [name="occurredAt"]').value.slice(0,10)}})()`),{date:"2026-09-21",paths:1,nextDate:"2026-09-22"});
  for(const remaining of[1,0]){
    await evaluate(`document.querySelector(".weight-batch-remove").click();true`);
    assert.equal(await waitUntil(`document.querySelectorAll(".weight-batch-item").length===${remaining}`),true)
  }
  const retryParseStart=await evaluate(`window.__healthParses`);
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),transfer=new DataTransfer();for(let index=0;index<2;index+=1)transfer.items.add(new File([bytes],"retry-"+(index+1)+".png",{type:"image/png"}));const input=document.querySelector("#health-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));["2026-09-18","2026-09-19"].forEach((date,index)=>{const field=document.querySelector('[data-weight-batch-date="'+index+'"]');field.value=date;field.dispatchEvent(new Event("change",{bubbles:true}))});window.__failWeightReferenceDate="2026-09-18";document.querySelector("#parse-health-images").click();return true})()`);
  assert.equal(await waitUntil(`window.__healthParses===${retryParseStart+2}&&document.querySelectorAll(".weight-batch-item.failed").length===1&&[...document.querySelectorAll(".weight-batch-select small")].some(item=>item.textContent.includes("已识别"))&&!document.querySelector("#parse-health-images").disabled`,200,25),true);
  await evaluate(`document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`window.__healthParses===${retryParseStart+3}&&document.querySelectorAll(".weight-batch-item.failed").length===0&&[...document.querySelectorAll(".weight-batch-select small")].every(item=>item.textContent.includes("已识别"))&&!document.querySelector("#parse-health-images").disabled`,200,25),true);
  for(const remaining of[1,0]){
    await evaluate(`document.querySelector(".weight-batch-remove").click();true`);
    assert.equal(await waitUntil(`document.querySelectorAll(".weight-batch-item").length===${remaining}`),true)
  }
  await evaluate(`document.querySelector('[data-view="together"]').click(); true`);
  const todayThoughtTimeline = await evaluate(`(() => {
    const list=document.querySelector("#today-thoughts"),entries=[...list.querySelectorAll(".thought-timeline-entry")],cards=entries.map(entry=>entry.querySelector(".chain-record")),cardRects=cards.map(card=>card.getBoundingClientRect()),contentRects=cards.map(card=>card.querySelector(".summary-content").getBoundingClientRect()),date=entries[0].querySelector(".timeline-date").getBoundingClientRect(),meta=entries[0].querySelector(".thought-entry-meta").getBoundingClientRect(),pending=entries[0].querySelector(".thought-trace-pending"),tags=entries[0].querySelector(".thought-entry-tags").getBoundingClientRect();
    return {
      cards:cards.length,
      nonemptyDates:[...list.querySelectorAll(".timeline-date")].filter(item=>item.textContent.trim()).length,
      cardsAligned:cardRects.every(rect=>Math.abs(rect.left-cardRects[0].left)<1),
      contentAligned:contentRects.every(rect=>Math.abs(rect.left-contentRects[0].left)<1),
      dateOutside:date.right<cardRects[0].left,
      metaOutside:meta.bottom<=cardRects[0].top,
      pendingText:pending?.textContent,
      pendingBesideTags:tags.right<=pending?.getBoundingClientRect().left,
      unansweredUnmarked:!entries[1].querySelector(".thought-trace-pending"),
      hasAxis:getComputedStyle(list,"::before").content!=="none",
      hasNodes:entries.every(entry=>getComputedStyle(entry,"::after").content!=="none"),
      summaryColumns:getComputedStyle(cards[0].querySelector(".chain-summary")).gridTemplateColumns.split(" ").length
    };
  })()`);
  assert.deepEqual(todayThoughtTimeline, { cards: 2, nonemptyDates: 1, cardsAligned: true, contentAligned: true, dateOutside: true, metaOutside: true, pendingText: "📫没有你的痕迹⏳", pendingBesideTags: true, unansweredUnmarked: true, hasAxis: true, hasNodes: true, summaryColumns: 2 });
  await evaluate(`document.querySelector("#today-thoughts").scrollIntoView({ block: "start" }); true`);
  const todayThoughtScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-today-thoughts.png", Buffer.from(todayThoughtScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`(() => { const entries=[...document.querySelectorAll("#today-thoughts .thought-timeline-entry")],cards=entries.map(entry=>entry.querySelector(".chain-record")),lefts=cards.map(card=>card.getBoundingClientRect().left),date=entries[0].querySelector(".timeline-date").getBoundingClientRect(),card=cards[0].getBoundingClientRect(),meta=entries[0].querySelector(".thought-entry-meta").getBoundingClientRect(),contents=cards.map(item=>item.querySelector(".summary-content").getBoundingClientRect()); return document.documentElement.scrollWidth<=window.innerWidth&&lefts.every(left=>Math.abs(left-lefts[0])<1)&&date.left>=card.left&&date.bottom<=meta.top&&meta.bottom<=card.top&&contents.every(rect=>rect.width>card.width*.7); })()`), true);
  assert.equal(await evaluate(`(() => { const toast=document.querySelector("#toast"),nav=document.querySelector(".sidebar");toast.textContent="移动端通知";toast.hidden=false;const safe=toast.getBoundingClientRect().bottom<=nav.getBoundingClientRect().top-8;toast.hidden=true;return safe; })()`),true);
  const todayThoughtMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-today-thoughts-mobile.png", Buffer.from(todayThoughtMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const viewThemeColors = await evaluate(`Object.fromEntries([...document.querySelectorAll(".view")].map(view => [view.id, getComputedStyle(view.querySelector(".eyebrow")).color]))`);
  assert.ok(new Set(Object.values(viewThemeColors)).size >= 16);
  await evaluate(`document.querySelector('[data-view="captures"]').click(); true`);
  assert.equal(await evaluate(`document.querySelector("#view-captures").classList.contains("active") && Boolean(document.querySelector('[data-capture-id="capture-1"] strong'))`), true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-1"] .markdown-content').classList.contains("commentable")`), true);
  const captureInitial = await evaluate(`({
    inputType: document.querySelector("#capture-date").type,
    hasSeconds: document.querySelector("#capture-date").step === "1" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?$/.test(document.querySelector("#capture-date").value),
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
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-long"]'),source=card.querySelector(".capture-audio-source");return{audio:card.querySelector("audio")?.getAttribute("src"),audioReady:source?.querySelector(".capture-audio-playback-state")?.textContent,audioKey:source?.dataset.captureAudioKey||"",status:card.querySelector(".capture-transcription-state")?.textContent,speak:card.querySelector("[data-capture-speak]")?.getAttribute("data-capture-speak"),speechKey:card.querySelector("[data-capture-speak]")?.dataset.captureSpeechKey||"",voice:card.querySelector("[data-capture-voice]")?.value,speechControls:card.querySelectorAll(".capture-speech-actions button").length}})()`), {
    audio: "/attachments/capture-voice.m4a",
    audioReady: "原音可播放",
    audioKey: '["capture-long",1,"/attachments/capture-voice.m4a"]',
    status: "语音原件尚未转写。开始转写",
    speak: "capture-long",
    speechKey: '["capture-long",1,"/attachments/capture-voice.m4a","","zh_male_shaonianzixin_uranus_bigtts"]',
    voice: "zh_male_shaonianzixin_uranus_bigtts",
    speechControls: 3
  });
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-failed"]'),source=card.querySelector(".capture-audio-source"),status=card.querySelector(".capture-transcription-state");return{audio:card.querySelector("audio")?.getAttribute("src"),audioReady:source?.querySelector(".capture-audio-playback-state")?.textContent,audioKey:source?.dataset.captureAudioKey||"",status:status?.textContent,taskId:status?.dataset.transcriptionTaskId||"",misreported:status?.textContent.includes("转写未完成")}})()`),{
    audio:"/attachments/capture-failed.m4a",
    audioReady:"原音可播放",
    audioKey:'["capture-failed",1,"/attachments/capture-failed.m4a"]',
    status:"转写暂时失败。原音已保留，可以再次尝试。重试",
    taskId:"task-capture-failed",
    misreported:false
  });
  await evaluate(`window.__delaySpeech=true;document.querySelector('[data-capture-id="capture-long"] [data-capture-speak]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseSpeech==="function"&&window.__speechRequests.length===1`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-edit]').click();document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__captures.find(item=>item.id==="capture-long").version===2&&document.querySelector("#capture-id").value===""`),true);
  await evaluate(`window.__capturePatchPayloads=[];window.__releaseSpeech();true`);
  await sleep(100);
  assert.equal(await evaluate(`window.__speechPlays.length`),0,"audio-tts-playback");
  assert.deepEqual(await evaluate(`(() => {const editor=document.querySelector(".capture-audio-editor"),upload=editor.querySelector(".audio-file-primary"),recorder=editor.querySelector("#capture-audio-recorder"),record=editor.querySelector("#capture-audio-record"),preview=editor.querySelector("#capture-audio-preview");return{fits:editor.getBoundingClientRect().right<=window.innerWidth,uploadText:upload.textContent.trim(),uploadHeight:Math.round(upload.getBoundingClientRect().height),recorderOpen:recorder.open,summary:recorder.querySelector("summary").textContent.replace(/\\s+/g," ").trim(),recordCollapsed:record.getClientRects().length===0,previewCollapsed:preview.getClientRects().length===0}})()`), {
    fits: true,
    uploadText: "↑上传音频",
    uploadHeight: 44,
    recorderOpen: false,
    summary: "现场录音需要时展开麦克风控制",
    recordCollapsed: true,
    previewCollapsed: true
  });
  await evaluate(`document.querySelector("#capture-audio-recorder summary").click();true`);
  assert.equal(await evaluate(`document.querySelector("#capture-audio-recorder").open&&document.querySelector("#capture-audio-record").getBoundingClientRect().height>=44`),true);
  await evaluate(`document.querySelector("#capture-audio-record").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("正在录音")`),true);
  await evaluate(`document.querySelector("#capture-audio-pause").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("录音已暂停")`),true);
  await evaluate(`document.querySelector("#capture-audio-pause").click();window.__advanceNow(320);document.querySelector("#capture-audio-stop").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("录音已保存在本机")&&!document.querySelector("#capture-audio-preview").hidden`),true);
  await evaluate(`document.querySelector("#capture-audio-remove").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-preview").hidden&&document.querySelector("#capture-audio-preview").getClientRects().length===0`),true);
  assert.equal(await waitUntil(`!document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-expand]').hidden`), true);
  const captureCardLayout = await evaluate(`(() => {
    const card=document.querySelector('[data-capture-id="capture-long"]'),item=card.querySelector(".capture-item"),viewport=card.querySelector(".capture-content-viewport"),meta=card.querySelector(".capture-meta"),time=card.querySelector(".capture-entry-time"),tags=card.querySelector(".capture-top-tags"),actions=card.querySelector(".capture-actions"),buttons=[...actions.querySelectorAll("button")],lineHeight=parseFloat(getComputedStyle(viewport).lineHeight);
    const buttonRects=buttons.map(button=>button.getBoundingClientRect()),metaRect=meta.getBoundingClientRect(),timeRect=time.getBoundingClientRect(),itemRect=item.getBoundingClientRect();
    return {
      capped: viewport.scrollHeight>viewport.clientHeight && viewport.clientHeight<=lineHeight*4+1,
      timeInMeta: metaRect.top<=timeRect.top && timeRect.bottom<=metaRect.bottom+1,
      metaAboveCard: metaRect.bottom<=itemRect.top+1,
      actionRows: buttonRects[0].bottom<=buttonRects[1].top+1 && Math.abs(buttonRects[1].top-buttonRects[2].top)<2,
      actionsCompact: buttonRects[2].bottom-buttonRects[0].top<42,
      actionsRightAligned: Math.abs(buttonRects[0].right-buttonRects[2].right)<2,
      actionsFloatRight: getComputedStyle(actions).float==="right",
      tagsInMeta: meta.contains(tags)
    };
  })()`);
  assert.deepEqual(captureCardLayout, { capped: true, timeInMeta: true, metaAboveCard: true, actionRows: true, actionsCompact: true, actionsRightAligned: true, actionsFloatRight: true, tagsInMeta: true });
  const collapsedCaptureHeight = await evaluate(`document.querySelector('[data-capture-id="capture-long"] .capture-content-viewport').clientHeight`);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] .capture-item').click(); true`);
  assert.equal(await evaluate(`(() => { const card=document.querySelector('[data-capture-id="capture-long"]'),item=card.querySelector(".capture-item"),viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"); return viewport.clientHeight>${collapsedCaptureHeight}&&item.classList.contains("is-expanded")&&button.getAttribute("aria-expanded")==="true"&&button.textContent.trim()==="⌄"; })()`), true);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector('[data-capture-id="capture-long"] .capture-item').classList.contains("is-expanded")`), true);
  await evaluate(`document.querySelector("#capture-content").value = "快捷收下的新捕念"; const input = document.querySelector("#capture-tags"); input.value = "测试"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); true`);
  assert.equal(await evaluate(`document.querySelector("#capture-tag-list .tag-chip")?.textContent.includes("测试")`), true);
  assert.deepEqual(await evaluate(`(() => {const input=document.querySelector("#capture-content"),event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});input.dispatchEvent(event);return{prevented:event.defaultPrevented,saves:window.__captureSaves}})()`),{prevented:false,saves:0});
  await evaluate(`window.__delayCaptureCreate=true;document.querySelector("#capture-content").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));true`);
  assert.equal(await waitUntil(`typeof window.__releaseCaptureCreate==="function"&&document.querySelector(".capture-timeline-entry.is-syncing")?.textContent.includes("快捷收下的新捕念")`), true);
  assert.deepEqual(await evaluate(`({saves:window.__captureSaves,status:["待同步","正在同步"].includes(document.querySelector(".capture-sync-state")?.textContent),form:document.querySelector("#capture-content").value})`), {saves:0,status:true,form:"快捷收下的新捕念"});
  await evaluate(`window.__releaseCaptureCreate();true`);
  assert.equal(await waitUntil(`window.__captureSaves === 1 && document.querySelector('[data-capture-id="capture-new-1"]')`), true);
  const capturePayload = await evaluate(`window.__capturePayloads[0]`);
  assert.deepEqual(capturePayload.tags, ["测试"]);
  assert.equal(capturePayload.timeMode, "now");
  assert.equal(Object.hasOwn(capturePayload, "occurredAt"), false);
  assert.equal(Object.hasOwn(capturePayload, "occurredOn"), false);
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"capture-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#capture-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#capture-content").value="";return true})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length`),1);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.items?.[0]?.blob?.size>0)}})`),true);
  await evaluate(`document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__captureSaves===2&&document.querySelector('[data-capture-id="capture-new-2"] [data-content-image-understand="capture"]')`),true);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(!request.result)}})`),true);
  assert.deepEqual(await evaluate(`({content:window.__capturePayloads[1].content,paths:window.__capturePayloads[1].attachmentPaths,images:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals img').length,viewerButtons:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals button[data-image-viewer-path]').length,externalLinks:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals a[target="_blank"]').length})`),{content:"",paths:["/attachments/content-1.png"],images:1,viewerButtons:1,externalLinks:0});
  await evaluate(`window.__delayImageTaskCreate=true;window.__holdAiTasks=true;document.querySelector('[data-capture-id="capture-new-2"] [data-content-image-understand="capture"]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseImageTaskCreate==="function"&&document.querySelector('[data-capture-id="capture-new-2"] .content-image-task-status').textContent.includes("加入后台队列")`),true);
  await evaluate(`window.__releaseImageTaskCreate();true`);
  assert.equal(await waitUntil(`window.__aiTasks.some(task=>task.contentTargetId==="capture-new-2"&&task.status==="running")&&document.querySelector('[data-capture-id="capture-new-2"] .content-image-task-status').textContent.includes("后台理解")`),true);
  await evaluate(`(()=>{window.__holdAiTasks=false;const task=window.__aiTasks.find(item=>item.contentTargetId==="capture-new-2"&&item.status==="running");window.__completeAiTask(task,{payload:{targetType:"capture"}});return true})()`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-new-2"] .content-understanding')?.textContent.includes("手写笔记")`,160,25),true);
  assert.equal(await evaluate(`window.__captures.find(item=>item.id==="capture-new-2").content`),"");
  await evaluate(`window.__failCaptureCreate=true;document.querySelector("#capture-content").value="断网时仍可见";document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector(".capture-sync-state.pending")?.textContent==="待同步"`),true);
  assert.deepEqual(await evaluate(`({saves:window.__captureSaves,visible:document.querySelector(".capture-timeline-entry.is-syncing")?.textContent.includes("断网时仍可见"),form:document.querySelector("#capture-content").value,status:document.querySelector("#capture-status").textContent})`),{saves:2,visible:true,form:"",status:"已记下，网络恢复后自动同步。"});
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]').click(); true`);
  const captureEditState = await evaluate(`({ datetime: document.querySelector("#capture-date").value, tags: [...document.querySelectorAll("#capture-tag-list .tag-chip")].map(item => item.textContent.trim()) })`);
  assert.equal(captureEditState.datetime, "2026-09-27T15:08:09");
  assert.equal(captureEditState.tags.length, 2);
  await evaluate(`document.querySelector("#capture-date").value = "2026-09-27T23:45:12"; document.querySelector("#capture-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__capturePatchPayloads.length === 1`), true);
  assert.equal((await evaluate(`window.__capturePatchPayloads[0].occurredAt`)), "2026-09-27T23:45:12");
  assert.equal((await evaluate(`window.__capturePatchPayloads[0].timeMode`)), "manual");
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="在途修改仍可见";window.__delayCapturePatch=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`typeof window.__releaseCapturePatch==="function"&&document.querySelector('[data-capture-id="capture-new-1"].is-syncing')?.textContent.includes("在途修改仍可见")`),true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] .capture-sync-state').textContent`),"待同步");
  await evaluate(`window.__releaseCapturePatch();true`);
  assert.equal(await waitUntil(`window.__capturePatchPayloads.length===2&&!document.querySelector('[data-capture-id="capture-new-1"]').classList.contains("is-syncing")`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="响应丢失但已提交";window.__loseCapturePatchResponse=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__receiptLookups>=1&&window.__capturePatchPayloads.length===3&&document.querySelector('[data-capture-id="capture-new-1"]')?.textContent.includes("响应丢失但已提交")&&!document.querySelector('[data-capture-id="capture-new-1"]').classList.contains("is-syncing")`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="冲突内容不应留下";window.__conflictCapturePatch=true;window.__failNextStateRefresh=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-status").textContent.includes("同步冲突")`),true);
  assert.deepEqual(await evaluate(`({server:window.__captures.find(item=>item.id==="capture-new-1").content,restored:document.querySelector('[data-capture-id="capture-new-1"]').textContent.includes("响应丢失但已提交")&&!document.querySelector('[data-capture-id="capture-new-1"]').textContent.includes("冲突内容不应留下"),editing:document.querySelector("#capture-content").value})`),{server:"响应丢失但已提交",restored:true,editing:"冲突内容不应留下"});
  await evaluate(`document.querySelector("#capture-content").value="离线修改待同步";window.__failCapturePatchNetwork=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-new-1"].is-syncing')?.textContent.includes("离线修改待同步")&&document.querySelector('[data-capture-id="capture-new-1"] .capture-sync-state.pending')`),true);
  const captureScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures.png", Buffer.from(captureScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#capture-date").getBoundingClientRect().right <= window.innerWidth`), true);
  assert.equal(await evaluate(`(() => { const card=document.querySelector('[data-capture-id="capture-1"]'),date=card.querySelector(".capture-date").getBoundingClientRect(),meta=card.querySelector(".capture-meta").getBoundingClientRect(),time=card.querySelector(".capture-entry-time").getBoundingClientRect(); return date.bottom<=meta.top+1&&meta.left<=time.left&&time.right<=meta.right+1; })()`), true);
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll('[data-capture-id="capture-long"] .capture-actions button')].map(item=>item.getBoundingClientRect()); return buttons[0].bottom<=buttons[1].top+1&&Math.abs(buttons[1].top-buttons[2].top)<2&&buttons[2].bottom-buttons[0].top<42; })()`), true);
  const captureMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures-mobile.png", Buffer.from(captureMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]').click(); true`);
  const promoted = await evaluate(`({ today: document.querySelector("#view-today").classList.contains("active"), idea: document.querySelector("#chain-idea").value, status: document.querySelector("#chain-status").textContent, sourceId:document.querySelector("#chain-form").elements.sourceCaptureId.value, sourceVersion:document.querySelector("#chain-form").elements.sourceCaptureVersion.value, kind:document.querySelector("#chain-form").elements.recordKind.value, chooserHidden:document.querySelector(".thought-record-kind").hidden })`);
  assert.equal(promoted.today, true);
  assert.equal(promoted.idea, "**这个念头**先不要想完整");
  assert.match(promoted.status, /补上一个明确问题/);
  assert.deepEqual({sourceId:promoted.sourceId,sourceVersion:promoted.sourceVersion,kind:promoted.kind,chooserHidden:promoted.chooserHidden},{sourceId:"capture-1",sourceVersion:"2",kind:"thought",chooserHidden:true});
  await evaluate(`document.querySelector("#thought-source-cancel").click();true`);
  assert.deepEqual(await evaluate(`(()=>{const form=document.querySelector("#chain-form");return{source:form.elements.sourceCaptureId.value,idea:document.querySelector("#chain-idea").value,chooserHidden:document.querySelector(".thought-record-kind").hidden,status:document.querySelector("#chain-status").textContent}})()`),{source:"",idea:"",chooserHidden:false,status:"已取消从念起展开，可以重新记录。"});
  await evaluate(`document.querySelector('[data-view="captures"]').click();document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]').click();true`);

  await evaluate(`document.querySelector('[data-view="journals"]').click(); true`);
  const restoredJournalDraft = await evaluate(`({id:document.querySelector("#journal-id").value,title:document.querySelector("#journal-title").value,content:document.querySelector("#journal-content").value,tags:document.querySelector("#journal-tags").value,date:document.querySelector("#journal-date").value,status:document.querySelector("#journal-status").textContent})`);
  assert.equal(restoredJournalDraft.id, "journal-1");
  assert.equal(restoredJournalDraft.title, "跨端恢复的标题");
  assert.equal(restoredJournalDraft.content, "跨端恢复的正文。");
  assert.equal(restoredJournalDraft.tags, "#日常");
  assert.ok(restoredJournalDraft.date);
  assert.match(restoredJournalDraft.status, /已恢复/);
  await evaluate(`document.querySelector("#journal-title").value += "（续写）"; document.querySelector("#journal-content").value += "继续写。"; document.querySelector("#journal-draft-save").click(); true`);
  assert.equal(await waitUntil(`window.__journalDraftSaves === 1 && document.querySelector("#journal-status").textContent.includes("草稿已保存")`), true);
  assert.deepEqual(await evaluate(`Object.keys(window.__journalDraftPayloads[0]).sort()`), ["content","journalId","title"]);
  assert.equal(await evaluate(`window.__journalDraftPayloads[0].journalId === "journal-1" && !("occurredAt" in window.__journalDraftPayloads[0]) && !("tags" in window.__journalDraftPayloads[0])`), true);
  await evaluate(`document.querySelector('[data-journal-prompt]').click(); true`);
  assert.match(await evaluate(`document.querySelector("#journal-content").value`), /今天最值得留下/);
  const journalBeforeAssist = await evaluate(`document.querySelector("#journal-content").value += "我已经写下这一段。"; document.querySelector("#journal-content").value`);
  await evaluate(`document.querySelector('[data-journal-assist="lead"]').click(); true`);
  assert.equal(await waitUntil(`window.__journalAssistPayloads.length === 1 && document.querySelector("#journal-content").value.includes("🗃 第一行写作锚点")`, 80, 25), true);
  const journalAfterAssist = await evaluate(`({ value: document.querySelector("#journal-content").value, payload: window.__journalAssistPayloads[0], status: document.querySelector("#journal-assist-status").textContent })`);
  assert.equal(journalAfterAssist.value.startsWith(journalBeforeAssist), true);
  assert.equal(journalAfterAssist.value.endsWith("🗃 第二行写作锚点。"), true);
  assert.equal(journalAfterAssist.value.slice(journalBeforeAssist.length).trim().split("\n").every(line => line.startsWith("🗃 ")), true);
  assert.equal(journalAfterAssist.payload.content, journalBeforeAssist);
  assert.match(journalAfterAssist.status, /已追加/);
  await evaluate(`document.querySelector("#journal-content").value += "\\n我写下了真实感受。"; document.querySelector("#journal-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__journalPatches === 1 && window.__journalDraft === null && document.querySelector("#journal-id").value === ""`), true);
  await evaluate(`document.querySelector("#journal-title").value = "新日记"; document.querySelector("#journal-content").value = "新建日记正文。"; document.querySelector("#journal-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__journalSaves === 1 && document.querySelector('[data-journal-id="journal-new-1"]')`), true);
  await evaluate(`document.querySelector('[data-journal-id="journal-1"]').open = true; document.querySelector('[data-journal-id="journal-1"] [data-journal-reflect]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector('[data-journal-id="journal-1"] .journal-reflection')`, 80, 25), true);
  assert.equal(await evaluate(`document.querySelector('[data-journal-id="journal-1"] .saved-reasoning-content').textContent`), "持久化的模型思考");
  assert.equal(await evaluate(`document.querySelector('[data-journal-id="journal-1"] .journal-original').classList.contains("commentable") && document.querySelector('[data-journal-id="journal-1"] .journal-reflection .model-answer-content>.markdown-content').classList.contains("commentable")`), true);
  await evaluate(`document.querySelector("#ai-answer-close").click(); true`);
  const journalScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-journal.png", Buffer.from(journalScreenshot.data, "base64"));
  await evaluate(`document.querySelector('[data-journal-id="journal-1"] [data-journal-edit]').click(); document.querySelector("#journal-title").value="布局检查草稿"; document.querySelector("#journal-content").value="检查保存草稿按钮在不同宽度下不会挤压其他操作。"; document.querySelector("#journal-form .record-form-footer").scrollIntoView({block:"center"}); true`);
  await sleep(120);
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll("#journal-form .form-actions button:not([hidden])")],rects=buttons.map(button=>button.getBoundingClientRect());return buttons.length===3&&rects.every((rect,index)=>index===0||rect.left>=rects[index-1].right-1)&&document.documentElement.scrollWidth<=window.innerWidth; })()`), true);
  const journalActionsScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-journal-draft-actions.png", Buffer.from(journalActionsScreenshot.data, "base64"));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  assert.equal(await evaluate(`document.querySelectorAll(".sidebar .nav-button").length`), 4);
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll("#journal-form .form-actions button:not([hidden])")],rects=buttons.map(button=>button.getBoundingClientRect());return buttons.length===3&&rects.every((rect,index)=>index===0||rect.left>=rects[index-1].right-1)&&rects.at(-1).right<=window.innerWidth; })()`), true);
  const journalMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-journal-mobile.png", Buffer.from(journalMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  const cardState = await evaluate(`(() => {
    const kept = document.querySelector('[data-chain-id="kept-root"]');
    const discarded = document.querySelector('[data-chain-id="discarded-root"]');
    kept.open = true;
    const actions = [...kept.querySelectorAll(".thought-actions > button")];
    return {
      hasIdeaSection: [...kept.querySelectorAll(".chain-part > b")].some(label => label.textContent === "初步想法"),
      hasIdeaPreview: Boolean(kept.querySelector(".idea-preview")),
      questionMarkdownBold: Boolean([...kept.querySelectorAll(".chain-part")].find(part => part.querySelector(":scope > b")?.textContent === "问题")?.querySelector(".markdown-content strong")),
      markdownBold: Boolean(kept.querySelector(".thought-block-content strong")),
      savedReasoning: kept.querySelector(".saved-reasoning pre")?.textContent,
      savedReasoningBold: Boolean(kept.querySelector(".saved-reasoning-content strong")),
      previewStartsClean: !kept.querySelector(".answer-preview").textContent.startsWith("核心判断"),
      blockCount: kept.querySelectorAll("[data-thought-block-id]").length,
      aiMarked: kept.querySelector(".thought-content-block.ai header span")?.textContent,
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
  assert.equal(cardState.blockCount, 1);
  assert.equal(cardState.aiMarked, undefined);
  assert.equal(await evaluate(`document.querySelector('[data-chain-id="kept-root"] .thought-content-block.ai header b').textContent`), "应答");
  assert.equal(await evaluate(`document.querySelector("#all-thoughts [data-chain-id]").dataset.chainId`),"kept-root");
  await evaluate(`document.querySelector('[data-thought-sort="created"]').click();true`);
  assert.deepEqual(await evaluate(`({first:document.querySelector("#all-thoughts [data-chain-id]").dataset.chainId,created:document.querySelector('[data-thought-sort="created"]').getAttribute("aria-pressed"),occurred:document.querySelector('[data-thought-sort="occurred"]').getAttribute("aria-pressed")})`),{first:"discarded-root",created:"true",occurred:"false"});
  await evaluate(`document.querySelector('[data-thought-sort="occurred"]').click();true`);
  assert.equal(cardState.formHidden, true);
  assert.equal(cardState.keptHasKeep, false);
  assert.equal(cardState.keptHasDiscard, true);
  assert.equal(cardState.discardedHasKeep, true);
  assert.equal(cardState.discardedHasDiscard, false);
  assert.equal(cardState.followupBeforeRemark, true);
  assert.equal(await evaluate(`document.querySelector('[data-chain-id="kept-root"] .chain-part .markdown-content').classList.contains("commentable") && document.querySelector('[data-chain-id="kept-root"] .thought-block-content').classList.contains("commentable")`), true);
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();document.querySelector('#all-thoughts [data-chain-id="kept-root"]').open=true;true`);
  assert.deepEqual(await evaluate(`({root:document.querySelectorAll('#all-thoughts [data-content-attachments="thoughtRoot:kept-root"] [data-image-viewer-path]').length,block:document.querySelectorAll('#all-thoughts [data-content-attachments="thoughtBlock:answer-kept"] [data-image-viewer-path]').length})`),{root:1,block:1});
  await evaluate(`(() => {
    const content=document.querySelector('#all-thoughts [data-chain-id="kept-root"] .thought-content-block.ai .thought-block-content');
    content.innerHTML=Array.from({length:30},(_,index)=>"<p>超长回答段落 "+(index+1)+"：用于验证默认折叠与展开。</p>").join("");
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  await sleep(100);
  const longThoughtBlock = await evaluate(`(() => {
    const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"] .thought-content-block.ai'),frame=card.querySelector(".thought-block-content-frame"),button=card.querySelector("[data-thought-block-expand]");
    return { collapsible:card.classList.contains("is-collapsible"),expanded:card.classList.contains("is-expanded"),buttonHidden:button.hidden,label:button.textContent.trim(),clipped:frame.scrollHeight>frame.clientHeight };
  })()`);
  assert.deepEqual(longThoughtBlock,{collapsible:true,expanded:false,buttonHidden:false,label:"展开全文⌄",clipped:true});
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-thought-block-expand]').click();true`);
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"] .thought-content-block.ai'),frame=card.querySelector(".thought-block-content-frame"),button=card.querySelector("[data-thought-block-expand]");return{expanded:card.classList.contains("is-expanded"),aria:button.getAttribute("aria-expanded"),label:button.textContent.trim(),fullyVisible:frame.scrollHeight===frame.clientHeight}})()`),{expanded:true,aria:"true",label:"收起⌄",fullyVisible:true});
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-thought-block-expand]').click();true`);
  assert.equal(await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] .thought-content-block.ai').classList.contains("is-expanded")`),false);
  assert.equal(await evaluate(`[...document.querySelectorAll("#all-thoughts .timeline-date")].filter(item => item.textContent.trim()).length`), 1);
  await evaluate(`(() => { const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]');card.open=true;const text=card.querySelector('.chain-part .markdown-content p').firstChild,range=document.createRange(),selection=getSelection();range.setStart(text,0);range.setEnd(text,2);selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));return true; })()`);
  assert.equal(await waitUntil(`!document.querySelector("#selection-tools").hidden`), true);
  await evaluate(`document.querySelector('[data-selection-action="highlight"]').click(); true`);
  assert.equal(await waitUntil(`window.__thoughtAnnotationSaves===1&&!document.querySelector('[data-chain-id="kept-root"] .thought-trace-pending')`), true);
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
  assert.equal(await waitUntil(`document.querySelector("#selection-tools").hidden?(document.dispatchEvent(new Event("selectionchange")),false):true`), true);
  await evaluate(`document.querySelector('[data-selection-action="comment"]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").hidden && document.querySelector("#comment-panel h2").textContent === "认知复盘批注"`), true);
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"comment-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#comment-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#comment-text").value="这条判断需要继续核对反证。";document.querySelector("#comment-composer").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__annotationSaves === 1 && document.querySelector('.analysis-content .comment-anchor')?.textContent === "总判断"`), true);
  assert.equal(await evaluate(`window.__analyses[0].annotations[0].attachmentPaths.length===1&&document.querySelectorAll('[data-comment-card="analysis-annotation-1"] .content-originals img').length===1&&document.querySelectorAll('[data-comment-card="analysis-annotation-1"] .content-originals [data-image-viewer-path]').length===1`),true);
  await evaluate(`document.querySelector('[data-annotation-menu="to-emphasis"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-comment-card="analysis-annotation-1"]').classList.contains("emphasis-card")&&document.querySelector(".analysis-content .comment-anchor")?.classList.contains("emphasis-anchor")`),true);
  await evaluate(`document.querySelector('[data-annotation-menu="to-comment"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-comment-card="analysis-annotation-1"]').classList.contains("emphasis-card")&&document.querySelector(".analysis-content .comment-anchor")?.classList.contains("comment-anchor")`),true);
  await evaluate(`document.querySelector('[data-shenji-toggle="analysis-annotation-1"]').click(); const form = document.querySelector('[data-shenji-form="analysis-annotation-1"]'); form.elements.message.value = "这条判断可能遗漏了什么？"; form.requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__shenjiSaves === 1`), true);
  assert.match(await evaluate(`document.querySelector('[data-shenji-form="analysis-annotation-1"] .shenji-status').textContent`), /后台队列/);
  await evaluate(`document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea').value="后台同步期间的新草稿";true`);
  assert.equal(await waitUntil(`document.querySelector('[data-comment-card="analysis-annotation-1"] .shenji-answer')?.textContent.includes("神鸡判断")`,160,25),true);
  assert.equal(await evaluate(`document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea').value`),"后台同步期间的新草稿");
  await evaluate(`document.querySelector('[data-view="notifications"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector('[data-notification-task]')?.closest(".notification-entry")?.textContent.includes("批注回复已生成")`), true);
  await evaluate(`document.querySelector('[data-notification-task]').click(); true`);
  assert.equal(await waitUntil(`!document.querySelector("#comment-panel").hidden && document.querySelector('[data-comment-card="analysis-annotation-1"] .shenji-answer')?.textContent.includes("神鸡判断")`), true);
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
  await evaluate(`window.__delayParseKind="book";document.querySelector("#parse-book").click();true`);
  assert.equal(await waitUntil(`window.__bookParses===2&&typeof window.__releaseParse==="function"`),true);
  await evaluate(`document.querySelector("#book-title").value="用户刚修改的书名";document.querySelector("#book-title").dispatchEvent(new Event("input",{bubbles:true}));window.__releaseParse();true`);
  assert.equal(await waitUntil(`document.querySelector("#book-parse-status").textContent.includes("当前书目已经变化")`),true);
  assert.equal(await evaluate(`document.querySelector("#book-title").value`),"用户刚修改的书名");
  await evaluate(`window.__tamperParseField="targetId";document.querySelector("#parse-book").click();true`);
  assert.equal(await waitUntil(`window.__bookParses===3&&document.querySelector("#book-parse-status").textContent.includes("当前书目已经变化")`),true);
  assert.equal(await evaluate(`document.querySelector("#book-title").value`),"用户刚修改的书名");
  await evaluate(`window.__tamperParseField="";true`);
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
  const bookUploadsBeforeSave = await evaluate(`window.__bookUploads`), createdBookCoverPath = `/attachments/cover-${bookUploadsBeforeSave + 1}.png`, editedBookCoverPath = `/attachments/cover-${bookUploadsBeforeSave + 2}.png`;
  await evaluate(`document.querySelector("#book-form").requestSubmit(); true`);
  const bookSaveCompleted = await waitUntil(`window.__bookUploads === ${bookUploadsBeforeSave + 1} && window.__bookSaves === 1 && document.querySelector(".book-card") && document.querySelector("#book-create-panel").hidden`);
  assert.equal(bookSaveCompleted, true, JSON.stringify(await evaluate(`({uploads:window.__bookUploads,saves:window.__bookSaves,title:document.querySelector("#book-title").value,start:document.querySelector("#book-reading-start").value,end:document.querySelector("#book-reading-end").value,status:document.querySelector("#book-parse-status").textContent,valid:document.querySelector("#book-form").checkValidity(),panelHidden:document.querySelector("#book-create-panel").hidden})`)));
  assert.equal(await evaluate(`window.__bookPayloads[0].imagePath`), createdBookCoverPath);
  assert.equal(await evaluate(`window.__bookPayloads[0].readingStartedOn === "2026-09-01" && window.__bookPayloads[0].readingFinishedOn === ""`), true);
  const galleryState = await evaluate(`({ libraryVisible: !document.querySelector("#book-library").hidden, cardCount: document.querySelectorAll(".book-card").length, memoryEmpty: document.querySelector(".book-memory-placeholder")?.textContent.includes("旧笔记") })`);
  assert.equal(galleryState.libraryVisible, true);
  assert.equal(galleryState.cardCount, 1);
  assert.equal(galleryState.memoryEmpty, true);
  await evaluate(`document.querySelector("#book-create-toggle").click();document.querySelector("#book-title").value="不能留下的临时书目";window.__failBookCreateStatus=400;document.querySelector("#book-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#book-parse-status").textContent.includes("书目校验失败")`),true);
  assert.deepEqual(await evaluate(`({pending:document.querySelectorAll(".book-card.is-syncing").length,title:document.querySelector("#book-title").value,cards:document.querySelectorAll(".book-card").length})`),{pending:0,title:"不能留下的临时书目",cards:1});
  await evaluate(`document.querySelector("#book-create-toggle").click();true`);
  const bookGalleryScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-gallery.png", Buffer.from(bookGalleryScreenshot.data, "base64"));
  await sleep(150);
  const longBookTitle = await evaluate(`(() => {
    const frame=document.querySelector(".book-title-frame"),title=frame.querySelector(".book-title"),viewport=frame.querySelector(".book-title-scroll"),track=frame.querySelector(".book-title-scroll-track"),lines=[...frame.querySelectorAll(".book-title-scroll-line")],style=getComputedStyle(title),rects=lines.map(line=>line.getBoundingClientRect());
    const travel=parseFloat(frame.style.getPropertyValue("--book-title-travel")),duration=parseFloat(frame.style.getPropertyValue("--book-title-duration"));
    return {
      overflowing:frame.classList.contains("is-overflowing"),
      oneTrack:title.children.length===1&&viewport?.firstElementChild===track,
      rows:lines.length,
      rowsAligned:Math.abs(rects[0].left-rects[1].left)<1&&Math.abs(rects[0].width-rects[1].width)<1,
      trackAnimated:getComputedStyle(track).animationName==="book-title-pan",
      maxTwoLines:frame.clientHeight<=parseFloat(style.lineHeight)*2+1&&title.scrollHeight<=frame.clientHeight+1,
      travel,
      duration,
      doubleSpeed:Math.abs(duration-Math.min(9,Math.max(4,3.5+Math.abs(travel)/40)))<.11,
      noPageOverflow:document.documentElement.scrollWidth<=window.innerWidth
    };
  })()`);
  assert.equal(longBookTitle.overflowing, true);
  assert.equal(longBookTitle.oneTrack, true);
  assert.equal(longBookTitle.rows, 2);
  assert.equal(longBookTitle.rowsAligned, true);
  assert.equal(longBookTitle.trackAnimated, true);
  assert.equal(longBookTitle.maxTwoLines, true);
  assert.equal(longBookTitle.travel < 0, true);
  assert.equal(longBookTitle.duration >= 4 && longBookTitle.duration <= 9, true);
  assert.equal(longBookTitle.doubleSpeed, true);
  assert.equal(longBookTitle.noPageOverflow, true);
  await evaluate(`document.querySelector(".book-title-frame").scrollIntoView({block:"center"}); true`);
  await sleep(900);
  const longBookTitleScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-title.png", Buffer.from(longBookTitleScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector(".book-title-frame").scrollIntoView({block:"center"}); true`);
  await sleep(900);
  assert.equal(await evaluate(`document.querySelector(".book-title-frame").classList.contains("is-overflowing")&&document.documentElement.scrollWidth<=window.innerWidth`), true);
  const longBookTitleMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-book-title-mobile.png", Buffer.from(longBookTitleMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("[data-open-book]").click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#book-detail").hidden && Boolean(document.querySelector(".book-description strong")) && document.querySelector(".book-description").classList.contains("commentable") && !document.querySelector("#view-books").classList.contains("book-detail-condensed") && !document.querySelector("#book-detail").textContent.includes("书籍内页") && document.querySelector(".book-reading-range").textContent.includes("2026年9月1日")`), true);
  await evaluate(`document.querySelector("[data-book-edit]").click(); true`);
  assert.equal(await evaluate(`!document.querySelector("#book-create-panel").hidden && document.querySelector("#book-form-title").textContent === "编辑书目" && document.querySelector("#book-title").value.includes("Labubu") && document.querySelector("#book-reading-start").value === "2026-09-01" && document.querySelector("#book-cover-preview").src.endsWith(${JSON.stringify(createdBookCoverPath)})`), true);
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
  assert.equal(await waitUntil(`window.__bookUploads === ${bookUploadsBeforeSave + 2} && window.__bookPatches === 1 && !document.querySelector("#book-detail").hidden && document.querySelector(".book-detail-copy h2").textContent === "编辑后的书名"`), true);
  assert.equal(await evaluate(`window.__bookPayloads[1].imagePath === ${JSON.stringify(editedBookCoverPath)} && window.__bookPayloads[1].readingFinishedOn === "2026-09-27" && document.querySelector(".book-detail-cover").src.endsWith(${JSON.stringify(editedBookCoverPath)})`), true);
  await evaluate(`(() => { const form = document.querySelector("[data-book-entry-form]"); form.elements.type.value = "thought"; form.elements.favorite.value = "star"; form.querySelector('[data-occurrence-mode="manual"]').click(); form.elements.occurredAt.value = "2026-09-27T09:10:11"; form.elements.content.value = "## 我的理解\\n\\n这条内容值得继续生长。"; form.requestSubmit(); return true; })()`);
  assert.equal(await waitUntil(`window.__bookNoteSaves === 1 && document.querySelector('[data-note-id="note-1"]')`), true);
  const bookEntryState = await evaluate(`(() => { const entry = document.querySelector('[data-note-id="note-1"]'), card = entry.querySelector(".book-entry-card").getBoundingClientRect(), date = entry.querySelector(".book-entry-date").getBoundingClientRect(); return { heading: entry.querySelector(".book-note h2")?.textContent, type: entry.querySelector(".book-entry-type").textContent, favorite: entry.querySelector(".book-favorite").textContent, time: entry.querySelector("header time").textContent, dateOutside: date.right < card.left, commentable: entry.querySelector(".book-note").classList.contains("commentable") }; })()`);
  assert.equal(bookEntryState.heading, "我的理解");
  assert.equal(bookEntryState.type, "附加思考");
  assert.equal(bookEntryState.favorite, "🌟");
  assert.equal(bookEntryState.time, "09:10:11");
  assert.equal(bookEntryState.dateOutside, true);
  assert.equal(bookEntryState.commentable, true);
  await evaluate(`(()=>{const form=document.querySelector("[data-book-entry-form]");form.elements.type.value="thought";form.elements.favorite.value="sprout";form.elements.content.value="失败后仍保留的读书草稿";window.__failBookNoteStatus=400;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("[data-book-entry-form] .status").textContent.includes("读书记录校验失败")`),true);
  assert.deepEqual(await evaluate(`({pending:document.querySelectorAll(".book-timeline-entry.is-syncing").length,content:document.querySelector("[data-book-entry-form] textarea").value,type:document.querySelector("[data-book-entry-form] [name=type]:checked").value,favorite:document.querySelector("[data-book-entry-form] [name=favorite]:checked").value})`),{pending:0,content:"失败后仍保留的读书草稿",type:"thought",favorite:"sprout"});
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
  await evaluate(`(() => { for(let index=0;index<4&&!document.querySelector('[data-quote-id="quote-1"]');index++)document.querySelector("#quote-refresh").click(); return true; })()`);await sleep(80);
  const quoteSky = await evaluate(`(() => { const items=[...document.querySelectorAll(".quote-bubble")],rects=items.map(item=>item.getBoundingClientRect()),overlap=rects.some((a,i)=>rects.some((b,j)=>i<j&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),limits=items.map(item=>Number(item.dataset.visibleLines)),bodies=items.map(item=>item.querySelector("p")),longBody=document.querySelector('[data-quote-id="quote-1"] p'),shortBody=[...bodies].sort((a,b)=>a.scrollHeight-b.scrollHeight)[0];return {count:items.length,overlap,distinctTags:new Set(items.flatMap(item=>[...item.querySelectorAll(".quote-tags span")].map(tag=>tag.textContent))).size,whiteSpace:getComputedStyle(bodies[0]).whiteSpace,font:getComputedStyle(bodies[0]).fontFamily,ids:items.map(item=>item.dataset.quoteId).join(","),limitsInRange:limits.every(value=>Number.isInteger(value)&&value>=3&&value<=5),heightsCapped:bodies.every((body,index)=>body.clientHeight<=parseFloat(getComputedStyle(body).lineHeight)*limits[index]+1),longScrollable:longBody.scrollHeight>longBody.clientHeight,shortNatural:shortBody.scrollHeight<=shortBody.clientHeight+1,autoScrolling:longBody.classList.contains("is-auto-scrolling")&&getComputedStyle(longBody).overflowY==="auto",scrollbarHidden:getComputedStyle(longBody).scrollbarWidth==="none",initialScrollTop:longBody.scrollTop}; })()`);
  assert.deepEqual({count:quoteSky.count,overlap:quoteSky.overlap,whiteSpace:quoteSky.whiteSpace,limitsInRange:quoteSky.limitsInRange,heightsCapped:quoteSky.heightsCapped,longScrollable:quoteSky.longScrollable,shortNatural:quoteSky.shortNatural,autoScrolling:quoteSky.autoScrolling,scrollbarHidden:quoteSky.scrollbarHidden},{count:3,overlap:false,whiteSpace:"pre-wrap",limitsInRange:true,heightsCapped:true,longScrollable:true,shortNatural:true,autoScrolling:true,scrollbarHidden:true});
  await sleep(1800);
  assert.equal(await evaluate(`document.querySelector('[data-quote-id="quote-1"] p').scrollTop>${quoteSky.initialScrollTop}+.5`),true);
  await evaluate(`(() => { const body=document.querySelector('[data-quote-id="quote-1"] p');body.scrollTop=0;body.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:30}));return true; })()`);
  await sleep(700);
  assert.equal(await evaluate(`(() => { const body=document.querySelector('[data-quote-id="quote-1"] p');return body.scrollTop===0&&body.classList.contains("is-user-scrolling")&&getComputedStyle(body).scrollbarWidth!=="none"; })()`),true);
  await sleep(5000);
  assert.equal(await evaluate(`(() => { const body=document.querySelector('[data-quote-id="quote-1"] p');return body.scrollTop>.5&&!body.classList.contains("is-user-scrolling")&&getComputedStyle(body).scrollbarWidth==="none"; })()`),true);
  const quoteBottom=await evaluate(`(() => { const body=document.querySelector('[data-quote-id="quote-1"] p');body.scrollTop=body.scrollHeight;body.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:30}));return body.scrollTop; })()`);
  await sleep(6500);
  assert.equal(await evaluate(`document.querySelector('[data-quote-id="quote-1"] p').scrollTop<${quoteBottom}-.5`),true);
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
  await evaluate(`(() => { const card = document.querySelector('[data-chain-id="kept-root"]'); card.open = true; card.querySelector(".saved-reasoning").open = true; card.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(100);
  const reasoningScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-saved-reasoning.png", Buffer.from(reasoningScreenshot.data, "base64"));
  await evaluate(`(() => { const card = document.querySelector('[data-chain-id="kept-root"]'); card.querySelector(".saved-reasoning").open = false; return true; })()`);
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
  assert.deepEqual(await evaluate(`window.__savedPayloads[0].sourceRef`),{type:"capture",id:"capture-1",version:2});
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-thought]').textContent`),"已展为思考");
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-thought]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="auto-root-1"]').open`),true);
  const taskCountBeforeAutoAnswer = await evaluate(`window.__aiTasks.length`);
  await evaluate(`document.querySelector("#chain-question").value = "第一条自动回答"; document.querySelector("#chain-answer").value = ""; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__aiTasks.length === ${taskCountBeforeAutoAnswer + 1} && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  assert.equal(await evaluate(`document.querySelector("#ai-answer-modal").hidden`), true);
  assert.match(await evaluate(`document.querySelector("#chain-status").textContent`), /后台生成/);
  assert.equal(await waitUntil(`window.__aiTasks[0].status === "succeeded" && !document.querySelector("#notification-dot").hidden`,80,25),true);
  await evaluate(`(() => { window.__holdAiTasks=true;const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]');card.open=true;card.querySelector('[data-answer-chain]').click();return true })()`);
  assert.equal(await waitUntil(`window.__aiTasks.some(task=>task.targetId==="kept-root"&&task.status==="running")`),true);
  const notificationReadsBeforePoll=await evaluate(`({notifications:window.__notificationReads,tasks:window.__taskReads})`);
  await evaluate(`(() => { const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]'),toggle=card.querySelector('[data-followup-compose]');toggle.click();const input=card.querySelector('[data-follow-up-root] textarea[name="question"]');input.value="轮询期间不能丢失";input.focus();return true })()`);
  await sleep(2200);
  const notificationReadsAfterPoll=await evaluate(`({notifications:window.__notificationReads,tasks:window.__taskReads})`);
  assert.ok(notificationReadsAfterPoll.notifications>notificationReadsBeforePoll.notifications);
  assert.ok(notificationReadsAfterPoll.tasks>notificationReadsBeforePoll.tasks);
  assert.deepEqual(await evaluate(`(() => { const input=document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root] textarea[name="question"]');return {value:input.value,formHidden:input.closest("form").hidden} })()`),{value:"轮询期间不能丢失",formHidden:false});
  const stateRequestsBeforeBackgroundMerge=await evaluate(`window.__stateRequests`);
  await evaluate(`(() => { window.__holdAiTasks=false;const task=window.__aiTasks.find(item=>item.targetId==="kept-root"&&item.status==="running");window.__completeAiTask(task);return true })()`);
  if(!await waitUntil(`[...document.querySelectorAll('[data-chain-id="kept-root"] .thought-block-content')].some(item=>item.textContent.includes("后台结果已局部合并"))`,160,25))throw new Error(await evaluate(`JSON.stringify({tasks:window.__aiTasks,results:window.__taskResults,reads:{notifications:window.__notificationReads,tasks:window.__taskReads},toast:document.querySelector("#toast").textContent,answers:[...document.querySelectorAll('[data-chain-id="kept-root"] .thought-block-content')].map(item=>item.textContent)})`));
  assert.deepEqual(await evaluate(`(()=>{const answer=[...document.querySelectorAll('[data-chain-id="kept-root"] .thought-content-block.ai')].find(item=>item.textContent.includes("后台结果已局部合并")),receipt=answer.querySelector(".context-audit"),open=receipt.open;receipt.open=true;return{receipt:Boolean(receipt),open,label:receipt.querySelector("summary").textContent.includes("本次参考"),sources:receipt.querySelectorAll(".context-source-item").length,unavailable:[...receipt.querySelectorAll(".context-source-item")].some(item=>item.textContent.includes("来源已删除或当前不可用")),reasoning:Boolean(answer.querySelector(".saved-reasoning"))}})()`),{receipt:true,open:false,label:true,sources:3,unavailable:true,reasoning:true});
  assert.deepEqual(await evaluate(`(() => {const input=document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root] textarea[name="question"]');return{value:input.value,formHidden:input.closest("form").hidden,cardOpen:input.closest("[data-chain-id]").open,focused:document.activeElement===input,stateRequests:window.__stateRequests}})()`),{value:"轮询期间不能丢失",formHidden:false,cardOpen:true,focused:true,stateRequests:stateRequestsBeforeBackgroundMerge});
  await evaluate(`document.querySelector("#chain-question").value = "第二条不应被阻塞"; document.querySelector("#chain-answer").value = "手写回答"; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__thoughtSaves === 3 && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  const taskCountBeforeImageAnswer=await evaluate(`window.__aiTasks.length`);
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"thought-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="结合这张图片回答";document.querySelector("#chain-answer").value="";document.querySelector("#chain-form").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__thoughtSaves===4&&window.__aiTasks.length===${taskCountBeforeImageAnswer+1}`),true);
  assert.deepEqual(await evaluate(`({question:window.__savedPayloads[3].question,pathCount:window.__savedPayloads[3].attachmentPaths.length,generate:window.__savedPayloads[3].generateAnswer,answerTasks:window.__aiTasks.filter(item=>item.targetId==="auto-root-4"&&item.kind==="thoughtAnswer").length,imageTasks:window.__aiTasks.filter(item=>item.targetId==="auto-root-4"&&item.kind==="contentImageUnderstanding").length})`),{question:"结合这张图片回答",pathCount:1,generate:true,answerTasks:1,imageTasks:0});
  const captureSavesBeforeKindChoice=await evaluate(`window.__captureSaves`);
  await evaluate(`(()=>{document.querySelector('[data-view="today"]').click();document.querySelector("#home-open-thought").click();const form=document.querySelector("#chain-form");form.elements.recordKind.value="capture";form.elements.recordKind[0].dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="从思考入口保存的一条念起";return true})()`);
  assert.deepEqual(await evaluate(`(()=>({title:document.querySelector("#home-thought-title").textContent,label:document.querySelector("#chain-primary-label").textContent.trim(),submit:document.querySelector("#chain-submit").textContent,thoughtFieldsHidden:[...document.querySelectorAll("[data-chain-thought-only]")].every(item=>item.hidden),target:[...document.querySelectorAll(".thought-record-kind span")].every(item=>item.getBoundingClientRect().height>=44)}))()`),{title:"记录念起",label:"内容 文字或图片至少一项 · 支持 Markdown",submit:"收进念起",thoughtFieldsHidden:true,target:true});
  await evaluate(`document.querySelector("#chain-form").requestSubmit();true`);
  if(!await waitUntil(`window.__captureSaves===${captureSavesBeforeKindChoice+1}&&document.querySelector("#chain-question").value===""`)){
    throw new Error(await evaluate(`JSON.stringify({captureSaves:window.__captureSaves,expected:${captureSavesBeforeKindChoice+1},kind:document.querySelector("#chain-form").elements.recordKind.value,question:document.querySelector("#chain-question").value,status:document.querySelector("#chain-status").textContent,toast:document.querySelector("#toast").textContent,buttonDisabled:document.querySelector("#chain-submit").disabled})`))
  }
  assert.deepEqual(await evaluate(`(()=>{const payload=window.__capturePayloads.at(-1),form=document.querySelector("#chain-form");return{content:payload.content,hasIdea:Object.hasOwn(payload,"idea"),kind:form.elements.recordKind.value,title:document.querySelector("#home-thought-title").textContent,chooserHidden:document.querySelector(".thought-record-kind").hidden}})()`),{content:"从思考入口保存的一条念起",hasIdea:false,kind:"thought",title:"记录思考",chooserHidden:false});
  const thoughtsBeforeRejectedCreate=await evaluate(`window.__thoughts.length`);
  await evaluate(`document.querySelector("#home-open-thought").click();document.querySelector("#chain-question").value="不应残留的冲突思考";window.__conflictThoughtCreate=true;document.querySelector("#chain-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#chain-status").textContent.includes("来源念起已变化")&&!document.querySelector('#chain-form [type="submit"]').disabled`),true);
  assert.deepEqual(await evaluate(`({count:window.__thoughts.length,pending:[...document.querySelectorAll("[data-chain-id]")].some(item=>item.dataset.chainId.startsWith("pending:")),visible:[...document.querySelectorAll(".question-preview")].some(item=>item.textContent.includes("不应残留的冲突思考"))})`),{count:thoughtsBeforeRejectedCreate,pending:false,visible:false});
  const imageDiscardsBeforePendingThought=await evaluate(`window.__imageDiscards.length`),thoughtSavesBeforePending=await evaluate(`window.__thoughtSaves`);
  await evaluate(`(()=>{const form=document.querySelector("#chain-form");form.reset();const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"pending-thought.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="带图的待同步思考";document.querySelector("#chain-answer").value="手写回答";window.__failThoughtCreateNetwork=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#chain-status").textContent.includes("网络恢复后自动同步")&&[...document.querySelectorAll("[data-chain-id]")].some(item=>item.dataset.chainId.startsWith("pending:"))`),true);
  assert.deepEqual(await evaluate(`({discards:window.__imageDiscards.length,previews:document.querySelectorAll('[data-content-image-editor="thoughtRoot"] figure').length})`),{discards:imageDiscardsBeforePendingThought,previews:0});
  await evaluate(`window.__failThoughtCreateNetwork=false;window.dispatchEvent(new Event("online"));true`);
  assert.equal(await waitUntil(`window.__thoughtSaves===${thoughtSavesBeforePending+1}&&![...document.querySelectorAll("[data-chain-id]")].some(item=>item.dataset.chainId.startsWith("pending:"))`,160,25),true);
  await evaluate(`document.querySelector('[data-home-editor-close="thought"]').click();true`);
  await evaluate(`document.querySelector('[data-section="mine"]').click(); true`);
  const mineDesktop = await evaluate(`(() => ({
    active:document.querySelector("#view-mine").classList.contains("active"),
    sectionHidden:document.querySelector("#section-nav").hidden,
    account:document.querySelector("#mine-account-name").textContent,
    rows:[...document.querySelectorAll("#view-mine [data-view]")].map(button=>button.querySelector("b").textContent),
    summaries:[...document.querySelectorAll("#view-mine .mine-row-copy small")].every(item=>item.textContent.trim().length>0),
    governance:{hidden:document.querySelector("#mine-governance-link").hidden,path:new URL(document.querySelector("#mine-governance-link").href).pathname},
    sidebarVersion:document.querySelector("#sidebar-app-version").textContent,
    mineVersion:document.querySelector("#mine-app-version").textContent,
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  }))()`);
  assert.deepEqual(mineDesktop, { active:true, sectionHidden:true, account:"owner", rows:["owner","统计","通知","回收站","数据导出","个人概要","AI 成本","架构设计","设置","商业化","产品反馈","关于"], summaries:true, governance:{hidden:false,path:"/platform/"}, sidebarVersion:"v0.2.0", mineVersion:"v0.2.0", noOverflow:true });
  const mineDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-mine-desktop.png", Buffer.from(mineDesktopScreenshot.data, "base64"));
  await evaluate(`document.querySelector('#view-mine [data-view="personal-context"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#personal-context-summary .personal-context-conclusion").length===3`),true);
  await evaluate(`document.querySelector("#toast").hidden=true;document.querySelectorAll(".modal-backdrop,.home-v02-editor-backdrop").forEach(item=>item.hidden=true);true`);
  assert.deepEqual(await evaluate(`(()=>({active:document.querySelector("#view-personal-context").classList.contains("active"),meta:document.querySelectorAll("#personal-context-meta>div").length,types:[...document.querySelectorAll("#personal-context-summary .personal-context-conclusion")].map(item=>item.dataset.contextType),collapsed:[...document.querySelectorAll("#personal-context-summary .personal-context-conclusion")].every(item=>!item.open),sources:document.querySelectorAll("#personal-context-source-list .context-source-item").length,noOverflow:document.documentElement.scrollWidth<=innerWidth}))()`),{active:true,meta:4,types:["user_fact","user_viewpoint","model_summary"],collapsed:true,sources:2,noOverflow:true});
  await sleep(250);
  await fs.writeFile("/tmp/growth-personal-context-desktop.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#personal-context-meta").getBoundingClientRect().right<=innerWidth`),true);
  await fs.writeFile("/tmp/growth-personal-context-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('#personal-context-summary [data-context-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="kept-root"]').open`),true);
  await evaluate(`document.querySelector('#view-mine [data-view="statistics"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#ai-kpis article").length === 8`), true);
  const statisticsDesktop = await evaluate(`(() => ({
    active:document.querySelector("#view-statistics").classList.contains("active"),
    sectionHidden:document.querySelector("#section-nav").hidden,
    recordTotal:document.querySelector("#record-total strong").textContent,
    groups:[...document.querySelectorAll(".record-stat-section>header h3")].map(item=>item.textContent),
    daily:[...document.querySelectorAll(".record-module-title")].find(item=>item.querySelector("b").textContent==="每日").nextElementSibling.querySelectorAll("dt").length,
    charts:document.querySelectorAll("#view-statistics .analytics-svg").length,
    title:document.querySelector("#ai-dashboard-title").textContent,
    providers:document.querySelectorAll("#ai-model-summary tbody tr").length,
    services:document.querySelectorAll("#ai-service-summary tbody tr").length,
    modalities:document.querySelectorAll("#ai-modality-summary tbody tr").length,
    providerPending:document.querySelector("#ai-model-summary").textContent.includes("阿里云")&&document.querySelector("#ai-model-summary").textContent.includes("2 次待账单"),
    serviceNames:[...document.querySelectorAll("#ai-service-summary tbody tr td:first-child")].map(item=>item.textContent),
    serviceUsage:document.querySelector("#ai-service-summary").textContent.includes("120 字符 · 1.5 秒")&&document.querySelector("#ai-service-summary").textContent.includes("1 张 · 1 次 API 调用"),
    serviceFailure:document.querySelector("#ai-service-summary").textContent.includes("1 / 1"),
    audioKnownCost:document.querySelector("#ai-modality-summary").textContent.includes("¥1.25 + 1 次待账单"),
    imageKpi:[...document.querySelectorAll("#ai-kpis article")].find(item=>item.querySelector("span").textContent==="图片理解")?.querySelector("strong").textContent,
    cnyOnly:document.querySelector("#view-statistics").textContent.includes("¥")&&!document.querySelector("#view-statistics").textContent.includes("$")&&!document.querySelector("#view-statistics").textContent.includes("美元"),
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  }))()`);
  assert.deepEqual(statisticsDesktop, { active:true, sectionHidden:true, recordTotal:"41", groups:["今日","所见","所思","互动"], daily:4, charts:4, title:"多供应商服务用量看板", providers:3, services:4, modalities:3, providerPending:true, serviceNames:["DeepSeek 模型","豆包语音","火山视觉","阿里云图片分割"], serviceUsage:true, serviceFailure:true, audioKnownCost:true, imageKpi:"4", cnyOnly:true, noOverflow:true });
  await evaluate(`document.querySelector("#toast").hidden=true; window.scrollTo(0,0); true`);
  await sleep(250);
  const statisticsDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-statistics-desktop.png", Buffer.from(statisticsDesktopScreenshot.data, "base64"));
  await evaluate(`document.querySelector("#ai-calls-chart").scrollIntoView({block:"start"}); true`);
  await sleep(150);
  assert.equal(await evaluate(`[...document.querySelectorAll("#view-statistics .analytics-svg")].every(svg=>svg.getBoundingClientRect().width>250&&svg.getBoundingClientRect().height>100)`), true);
  const statisticsChartsDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-statistics-charts-desktop.png", Buffer.from(statisticsChartsDesktopScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`window.scrollTo(0,0); true`);
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".ai-kpis")).gridTemplateColumns.split(" ").length===2`), true);
  const statisticsMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-statistics-mobile.png", Buffer.from(statisticsMobileScreenshot.data, "base64"));
  await evaluate(`document.querySelector("#ai-calls-chart").scrollIntoView({block:"start"}); true`);
  await sleep(150);
  assert.equal(await evaluate(`[...document.querySelectorAll("#view-statistics .analytics-svg")].every(svg=>svg.getBoundingClientRect().width>250&&svg.getBoundingClientRect().height>100)&&document.documentElement.scrollWidth<=window.innerWidth`), true);
  const statisticsChartsMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-statistics-charts-mobile.png", Buffer.from(statisticsChartsMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const stateRequestsBeforeAiCost=await evaluate(`window.__stateRequests`);
  await evaluate(`document.querySelector('[data-view="ai-cost"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#ai-cost-scenario-rows tr").length===15&&document.querySelectorAll("#ai-cost-kpis article").length===4`),true);
  assert.equal(await evaluate(`window.__stateRequests`),stateRequestsBeforeAiCost);
  const aiCostInitial=await evaluate(`({
    active:document.querySelector("#view-ai-cost").classList.contains("active"),
    rows:document.querySelectorAll("#ai-cost-scenario-rows tr").length,
    recommendations:document.querySelectorAll("#ai-cost-recommendations li").length,
    currentModel:document.querySelector('[data-ai-cost-row="thoughtAnswer"] td:nth-child(2) strong').textContent,
    projectedIsCny:document.querySelector("#ai-cost-kpis strong").textContent.startsWith("¥"),
    p90:[...document.querySelectorAll("#ai-cost-observed dt")].find(item=>item.textContent==="P90 单次")?.nextElementSibling.textContent,
    pendingCost:document.querySelector("#ai-cost-observed").textContent.includes("4 次费用待账单"),
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  })`);
  assert.deepEqual(aiCostInitial,{active:true,rows:15,recommendations:5,currentModel:"Pro · Ultra",projectedIsCny:true,p90:"¥0.0410",pendingCost:true,noOverflow:true});
  const thoughtAnswerCostBefore=await evaluate(`document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-row-total]').textContent`);
  await evaluate(`(()=>{const field=document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-field="callsPerMonth"]');field.value="40";field.dispatchEvent(new Event("input",{bubbles:true}))})();true`);
  assert.notEqual(await evaluate(`document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-row-total]').textContent`),thoughtAnswerCostBefore);
  await evaluate(`document.querySelector("#ai-cost-calibrate").click();true`);
  assert.deepEqual(await evaluate(`({enabled:document.querySelectorAll("#ai-cost-scenario-rows tr:not(.disabled)").length,projected:document.querySelector("#ai-cost-kpis strong").textContent})`),{enabled:3,projected:"¥0.383"});
  await evaluate(`document.querySelector("#ai-cost-form").requestSubmit();true`);
  await waitUntil(`window.__aiCostPlanSaves===1&&document.querySelector("#ai-cost-status").textContent.includes("已保存")`);
  const aiCostSaveState=await evaluate(`({saves:window.__aiCostPlanSaves,status:document.querySelector("#ai-cost-status").textContent})`);
  assert.deepEqual(aiCostSaveState,{saves:1,status:"AI 成本方案已保存。"});
  await evaluate(`window.scrollTo(0,0);document.querySelector("#toast").hidden=true;true`);
  await sleep(150);
  const aiCostDesktopScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-ai-cost-desktop.png",Buffer.from(aiCostDesktopScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".ai-cost-kpis")).gridTemplateColumns.split(" ").length===2`),true);
  const aiCostMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-ai-cost-mobile.png",Buffer.from(aiCostMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-view="architecture"]').click();true`);
  assert.deepEqual(await evaluate(`({
    active:document.querySelector("#view-architecture").classList.contains("active"),
    stages:document.querySelectorAll("[data-architecture-stage]").length,
    kpis:document.querySelectorAll("#architecture-kpis article").length,
    currentSpec:/2 vCPU \\/ 1\\.57 GiB/.test(document.querySelector("#architecture-main-path").textContent)&&/40 GB/.test(document.querySelector("#architecture-support-paths").textContent),
    layers:document.querySelectorAll("#architecture-layer-list article").length,
    terms:document.querySelectorAll("[data-architecture-term]").length,
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  })`),{active:true,stages:5,kpis:4,currentSpec:true,layers:8,terms:12,noOverflow:true});
  await sleep(250);
  const architectureDesktopScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-architecture-desktop.png",Buffer.from(architectureDesktopScreenshot.data,"base64"));
  await evaluate(`document.querySelector('[data-architecture-stage="2"]').click();document.querySelector('[data-architecture-term="queue"]').click();true`);
  assert.deepEqual(await evaluate(`({state:document.querySelector("#architecture-stage-state").textContent,scale:document.querySelector("#architecture-kpis article:nth-child(2) strong").textContent,term:document.querySelector("#architecture-term-code").textContent})`),{state:"规划",scale:"DAU 1 万 · MAU 4 万",term:"MQ"});
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".architecture-kpis")).gridTemplateColumns.split(" ").length===2`),true);
  const architectureMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-architecture-mobile.png",Buffer.from(architectureMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  const stateRequestsBeforeCommercialization=await evaluate(`window.__stateRequests`);
  await evaluate(`document.querySelector('[data-view="commercialization"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#commercial-kpis article").length===4&&document.querySelectorAll("#commercial-evidence-list article").length===1`), true);
  assert.equal(await evaluate(`window.__stateRequests`),stateRequestsBeforeCommercialization);
  const commercialValidation = await evaluate(`(() => ({
    active:document.querySelector("#view-commercialization").classList.contains("active"),
    mode:document.querySelector("[data-commercial-mode].active").textContent,
    kpis:[...document.querySelectorAll("#commercial-kpis strong")].map(item=>item.textContent),
    evidence:document.querySelector("#commercial-evidence-count").textContent,
    paid:document.querySelector("#commercial-paid-evidence").textContent,
    aiSample:document.querySelector("#commercial-ai-sample").textContent,
    models:document.querySelectorAll("[data-commercial-mode]").length,
    profiles:document.querySelectorAll("[data-commercial-profile]").length,
    profileSummaries:document.querySelectorAll("#commercial-profile-summary article").length,
    observedMetrics:document.querySelectorAll("#commercial-observed-usage>div").length,
    stage:document.querySelector("#commercial-stage-name").textContent,
    paths:document.querySelectorAll(".commercial-path-row:not(.heading)").length,
    gates:document.querySelectorAll(".commercial-gates li").length,
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  }))()`);
  assert.deepEqual(commercialValidation, { active:true, mode:"有偿调研", kpis:["¥514","¥300","¥960","¥1774"], evidence:"1 条", paid:"待记录", aiSample:"10 / 14 次", models:4, profiles:4, profileSummaries:4, observedMetrics:6, stage:"内部验证期", paths:6, gates:3, noOverflow:true });
  await evaluate(`document.querySelector('[data-commercial-mode="subscription"]').click(); true`);
  const commercialSubscription=await evaluate(`({
    title:document.querySelector("#commercial-breakdown-title").textContent,
    kpiCount:document.querySelectorAll("#commercial-kpis strong").length,
    hiddenValidation:document.querySelector('[data-commercial-assumption-group="validation"]').hidden,
    visibleSubscription:!document.querySelector('[data-commercial-assumption-group="subscription"]').hidden,
    cashflowRows:document.querySelectorAll("#commercial-cashflow-rows tr").length,
    cashflowRange:document.querySelector("#commercial-cashflow-range").textContent,
    weightedCost:document.querySelector("#commercial-profile-summary article:last-child strong").textContent
  })`);
  assert.deepEqual(commercialSubscription, { title:"首月订阅经营账", kpiCount:4, hiddenValidation:true, visibleSubscription:true, cashflowRows:6, cashflowRange:"统计 2026-09 至 2027-02，共 6 个月；工时单价 ¥80.0/小时", weightedCost:"¥9.25/人/月" });
  await evaluate(`document.querySelector(".commercial-profile-summary").scrollIntoView({block:"start"});true`);
  await sleep(120);
  const commercializationUsageScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-usage-desktop.png",Buffer.from(commercializationUsageScreenshot.data,"base64"));
  await evaluate(`const slider=document.querySelector("#commercial-stage-slider");slider.value="2";slider.dispatchEvent(new Event("input",{bubbles:true}));true`);
  assert.deepEqual(await evaluate(`({stage:document.querySelector("#commercial-stage-name").textContent,dau:document.querySelector('[data-commercial-field="subscription.dailyActiveUsers"]').value,mau:document.querySelector('[data-commercial-field="subscription.monthlyActiveUsers"]').value,months:document.querySelectorAll("#commercial-cashflow-rows tr").length})`),{stage:"快速上升期",dau:"10000",mau:"40000",months:18});
  await evaluate(`document.querySelector(".commercial-stage-control").scrollIntoView({block:"start"});true`);
  await sleep(120);
  const commercializationStageScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-stage-desktop.png",Buffer.from(commercializationStageScreenshot.data,"base64"));
  await evaluate(`document.querySelector('[data-commercial-mode="delivery"]').click(); true`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll("#commercial-kpis strong")].map(item=>item.textContent)`),["¥1388","¥1140","¥57.6","-¥357"]);
  assert.match(await evaluate(`document.querySelector("#commercial-method-note").textContent`),/BYOK.+合同负债/);
  await evaluate(`document.querySelector('[data-commercial-mode="usagePack"]').click(); true`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll("#commercial-kpis strong")].map(item=>item.textContent)`),["¥290","¥80.0","¥98.4","-¥61.6"]);
  await evaluate(`document.querySelector('[data-commercial-mode="subscription"]').click(); true`);
  await evaluate(`document.querySelector('[data-commercial-field="subscription.monthlyPriceCny"]').value="59";document.querySelector("#commercial-assumptions-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__commercializationSaves===1&&document.querySelector("#commercial-save-status").textContent.includes("已保存")`),true);
  await evaluate(`document.querySelector(".commercial-stage-control").scrollIntoView({block:"start"});document.querySelector("#toast").hidden=true;true`);
  await sleep(180);
  const commercializationDesktopScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-desktop.png",Buffer.from(commercializationDesktopScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".commercial-kpis")).gridTemplateColumns.split(" ").length===2&&getComputedStyle(document.querySelector(".commercial-evidence-list")).gridTemplateColumns.split(" ").length===1`),true);
  const commercializationMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-mobile.png",Buffer.from(commercializationMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-view="account"]').click(); true`);
  assert.deepEqual(await evaluate(`({
    active:document.querySelector("#view-account").classList.contains("active"),
    authenticated:!document.querySelector("#account-authenticated").hidden,
    localHidden:document.querySelector("#account-local-mode").hidden,
    username:document.querySelector("#account-username").value
  })`), { active: true, authenticated: true, localHidden: true, username: "owner" });
  await evaluate(`document.querySelector("#toast").hidden=true; true`);
  await sleep(250);
  const accountDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-account-desktop.png", Buffer.from(accountDesktopScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".account-settings")).gridTemplateColumns.split(" ").length===1`), true);
  const accountMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-account-mobile.png", Buffer.from(accountMobileScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector("#account-username").value="keeper"; document.querySelector("#username-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__usernameChanges===1&&document.querySelector("#account-page-name").textContent==="keeper"`), true);
  await evaluate(`document.querySelector("#password-form [name='currentPassword']").value="old-password-1"; document.querySelector("#password-form [name='newPassword']").value="new-password-2"; document.querySelector("#password-form [name='confirmPassword']").value="new-password-2"; document.querySelector("#password-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__passwordChanges===1&&document.querySelector("#password-status").textContent.includes("密码已更新")`), true);
  await evaluate(`document.querySelector('[data-view="settings"]').click(); true`);
  assert.equal(await evaluate(`document.querySelectorAll("[data-profile-model]").length === 4 && document.querySelectorAll("[data-profile-effort]").length === 4 && document.querySelectorAll("[data-ai-scenario]").length === 15 && document.querySelectorAll("[data-response-style]").length === 7`), true);
  await evaluate(`document.querySelector('[data-profile-model="lite"]').value = "deepseek-v4-pro"; document.querySelector('[data-profile-effort="lite"]').value = "max"; document.querySelector('[data-ai-scenario="diaryLead"]').value = "ultra";document.querySelector("#assistant-name").value="照见";document.querySelector('[data-response-style="thoughtAnswer"]').value="deep";document.querySelector("#llm-settings-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__settingsSaves === 1`), true);
  const savedSettings = await evaluate(`window.__lastSettings = undefined; ({ model: document.querySelector('[data-profile-model="lite"]').value, effort: document.querySelector('[data-profile-effort="lite"]').value, scene: document.querySelector('[data-ai-scenario="diaryLead"]').value, name:document.querySelector("#assistant-name").value, style:document.querySelector('[data-response-style="thoughtAnswer"]').value })`);
  assert.deepEqual(savedSettings, { model: "deepseek-v4-pro", effort: "max", scene: "ultra", name:"照见", style:"deep" });
  assert.equal(await evaluate(`document.querySelector("#reset-response-styles").click();document.querySelector("#assistant-name").value==="神鸡"&&[...document.querySelectorAll("[data-response-style]")].every(select=>select.value==="standard")`),true);
  await evaluate(`document.querySelector("#ai-answer-modal").hidden = true; document.querySelector("#edit-chain-modal").hidden = true; document.querySelector(".settings-card").scrollIntoView({ block: "start" }); true`);
  await sleep(300);
  const settingsScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-tier-settings.png", Buffer.from(settingsScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  const settingsMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-tier-settings-mobile.png", Buffer.from(settingsMobileScreenshot.data, "base64"));
  assert.equal(await evaluate(`document.querySelector("#section-nav").hidden`), true);
  await evaluate(`document.querySelector("#view-settings .mine-back").click(); true`);
  assert.deepEqual(await evaluate(`({active:document.querySelector("#view-mine").classList.contains("active"),version:document.querySelector("#mine-app-version").textContent,centered:getComputedStyle(document.querySelector("#mine-app-version")).textAlign==="center",noOverflow:document.documentElement.scrollWidth<=window.innerWidth})`),{active:true,version:"v0.2.0",centered:true,noOverflow:true});
  const mineMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-mine-mobile.png", Buffer.from(mineMobileScreenshot.data, "base64"));
  await evaluate(`document.querySelector('#view-mine [data-view="about"]').click(); true`);
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
  await evaluate(`document.querySelector('[data-view="today"]').click(); document.querySelector('[data-section="mine"]').click(); document.querySelector('#view-mine [data-view="about"]').click(); true`);
  const aboutDesktop = await evaluate(`(() => {
    return {
      active: document.querySelector("#view-about").classList.contains("active") && document.querySelector('[data-section="mine"]').classList.contains("active") && document.querySelector("#section-nav").hidden,
      heading: document.querySelector("#view-about h1").textContent,
      proposition: document.querySelector(".about-proposition").textContent,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth
    };
  })()`);
  assert.equal(aboutDesktop.active, true);
  assert.equal(aboutDesktop.heading, "此刻");
  assert.match(aboutDesktop.proposition, /零散记录/);
  assert.equal(aboutDesktop.noOverflow, true);
  await evaluate(`window.scrollTo(0, 0); true`);
  await sleep(300);
  await evaluate(`document.querySelector("#toast").hidden = true; true`);
  const aboutDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-about-desktop.png", Buffer.from(aboutDesktopScreenshot.data, "base64"));
  assert.equal(await evaluate(`(() => { document.querySelector('[data-view="thoughts"]').click();const before=window.__deleteRequests;window.confirm=()=>false;document.querySelector('[data-chain-id="kept-root"] [data-delete-chain]').click();return window.__deleteRequests===before; })()`),true);
  await evaluate(`window.confirm=()=>true;window.__conflictThoughtDelete=true;window.__failNextStateRefresh=true;document.querySelector('[data-chain-id="kept-root"] [data-delete-chain]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#toast").textContent.includes("资源版本已变化")&&document.querySelector('[data-chain-id="kept-root"]')`),true);
  await evaluate(`window.__failThoughtDeleteNetwork=true;document.querySelector('[data-chain-id="kept-root"] [data-delete-chain]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-chain-id="kept-root"]')&&document.querySelector("#toast").textContent.includes("网络恢复后移入回收站")`),true);
  await evaluate(`document.querySelector('[data-view="daily"]').click();document.querySelector('[data-daily-tab="exercise"]').click();window.__pasteHealth();window.__delayParseKind="exercise";window.__releaseParse=null;document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseParse==="function"`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();document.querySelector("#chain-question").value="账户 A 的在途草稿";document.querySelector("#chain-answer").value="";document.querySelector("#draft-answer-button").click();true`);
  assert.equal(await waitUntil(`window.__reasoningChunks===1`,40,10),true);
  await evaluate(`(()=>{const file=new File([new Uint8Array([1,2,3])],"thought-draft.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:thoughtRoot");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.items?.[0]?.name==="thought-draft.png")}})`),true);
  await evaluate(`window.__delayLogout=true;document.querySelector("#logout-button").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#auth-gate").hidden`),true);
  assert.equal(await evaluate(`sessionStorage.getItem("cike:session-drafts:user-1")`),null);
  assert.deepEqual(await evaluate(`({locked:document.body.classList.contains("auth-locked"),privateSurfaceHidden:getComputedStyle(document.querySelector("main")).visibility==="hidden",logoutPending:typeof window.__releaseLogout==="function"})`),{locked:true,privateSurfaceHidden:true,logoutPending:true});
  await evaluate(`window.__releaseLogout();true`);
  assert.equal(await waitUntil(`[...document.querySelectorAll(".auth-form input,.auth-form button,[data-auth-tab]")].every(item=>!item.disabled)`),true);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:thoughtRoot");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(!request.result)}})`),true);
  await evaluate(`window.__delaySecondState=true;window.__delayLogin=true;(() => { const loginForm=document.querySelector("#login-form");loginForm.elements.username.value="second";loginForm.elements.password.value="shenji";loginForm.requestSubmit();return true; })()`);
  assert.equal(await waitUntil(`typeof window.__releaseLogin==="function"`),true);
  assert.equal(await evaluate(`[...document.querySelectorAll(".auth-form input,.auth-form button,[data-auth-tab]")].every(item=>item.disabled)`),true);
  await evaluate(`window.__releaseLogin();true`);
  assert.equal(await waitUntil(`document.querySelector("#account-name").textContent==="second"&&typeof window.__releaseSecondState==="function"`),true);
  assert.deepEqual(await evaluate(`({locked:document.body.classList.contains("auth-locked"),gateVisible:!document.querySelector("#auth-gate").hidden,privateSurfaceHidden:getComputedStyle(document.querySelector("main")).visibility==="hidden"})`),{locked:true,gateVisible:true,privateSurfaceHidden:true});
  await evaluate(`window.__releaseSecondState();true`);
  assert.equal(await waitUntil(`document.querySelector("#account-name").textContent==="second"&&document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`),true);
  await evaluate(`window.__releaseParse();true`);
  await sleep(1000);
  assert.equal(await evaluate(`document.querySelector("#chain-answer").value===""&&document.querySelector("#ai-answer-modal").hidden`),true);
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-daily-form="weight"] input,[data-daily-form="exercise"] input')].filter(input=>!["occurredAt","clothing"].includes(input.name)).every(input=>input.value==="")&&document.querySelectorAll("#health-image-previews figure").length===0`),true);
  await evaluate(`window.confirm=()=>true;document.querySelectorAll(".modal-backdrop").forEach(item=>item.hidden=true);document.querySelector("#toast").hidden=true;document.querySelector('[data-view="settings"]').click();true`);
  assert.deepEqual(await evaluate(`({visible:!document.querySelector("#local-test-settings").hidden,cold:document.querySelector('[data-local-test-mode="cold"]').classList.contains("active"),coldDisabled:document.querySelector('[data-local-test-mode="cold"]').disabled,summaryOk:/空账户工作区/.test(document.querySelector("#local-test-summary").textContent),entryOk:/使用模拟 \\/ 冷启测试 · 当前冷启测试/.test(document.querySelector("#mine-settings-summary").textContent)})`),{visible:true,cold:true,coldDisabled:true,summaryOk:true,entryOk:true});
  const localTestSettingsScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-local-test-settings.png",Buffer.from(localTestSettingsScreenshot.data,"base64"));
  await evaluate(`window.__localHydrateRequests=[];window.__attachmentReadsBeforeModeSwitch=(window.__attachmentReads||[]).length;document.querySelector('[data-local-test-mode="simulation"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#local-test-status").textContent.includes("打开页面时读取对应记录")`),true);
  assert.deepEqual(await evaluate(`({hydrates:window.__localHydrateRequests,summary:document.querySelector("#local-test-summary").textContent,captures:document.querySelectorAll("#capture-list [data-capture-id]").length,attachmentReads:(window.__attachmentReads||[]).length-window.__attachmentReadsBeforeModeSwitch})`),{hydrates:[],summary:"owner · 0 条已载入 · 打开页面后读取记录",captures:0,attachmentReads:0});
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("captures")&&document.querySelector("#capture-list").textContent.includes("这个念头")`),true);
  assert.equal(await evaluate(`(window.__attachmentReads||[]).length-window.__attachmentReadsBeforeModeSwitch`),0);
  await evaluate(`document.querySelector('[data-view="settings"]').click();document.querySelector('[data-view="captures"]').click();true`);
  await sleep(100);
  assert.equal(await evaluate(`window.__localHydrateRequests.filter(scope=>scope==="captures").length`),1);
  await evaluate(`window.__failCaptureCreate=true;document.querySelector("#capture-content").value="范围切换时保留的待同步记录";document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector(".capture-sync-state.pending")?.textContent==="待同步"&&document.querySelector("#capture-list").textContent.includes("范围切换时保留的待同步记录")`),true);
  await evaluate(`window.__failActionNetwork=true;document.querySelector('[data-action-complete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state.pending")`),true);
  await evaluate(`window.__delayActionList=true;document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseActionList==="function"`),true);
  await evaluate(`window.__releaseActionList();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("today")&&document.querySelectorAll(".home-v02-memory").length===3&&document.querySelector("#home-keepsake").textContent.includes("旧展览票")`),true);
  assert.equal(await evaluate(`Boolean(document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state.pending"))`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await evaluate(`document.querySelector(".capture-sync-state.pending")?.textContent==="待同步"&&document.querySelector("#capture-list").textContent.includes("范围切换时保留的待同步记录")`),true);
  await evaluate(`document.querySelector('[data-view="discovery"]').click();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("discovery")`),true);
  await evaluate(`document.querySelector('[data-view="ai-cost"]').click();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("statistics")`),true);
  const statisticsHydrations=await evaluate(`window.__localHydrateRequests.filter(scope=>scope==="statistics").length`);
  await evaluate(`document.querySelector('[data-view="commercialization"]').click();true`);
  await sleep(100);
  assert.equal(await evaluate(`window.__localHydrateRequests.filter(scope=>scope==="statistics").length`),statisticsHydrations);
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  await evaluate(`window.__failLocalModeTimeout=true;document.querySelector('[data-local-test-mode="cold"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#local-test-status").textContent==="线上数据读取超时，请检查网络后重试。"&&window.__testWorkspaceMode==="simulation"`),true);
  await evaluate(`window.__onboardingSchemaAvailable=true;document.querySelector('[data-local-test-mode="cold"]').click();true`);
  assert.equal(await waitUntil(`window.__testWorkspaceMode==="cold"&&document.querySelector("#view-today").classList.contains("active")&&!document.querySelector("#onboarding-workspace").hidden`),true);
  await evaluate(`document.querySelector('[data-section="seen"]').click();document.querySelector('[data-view="keepsakes"]').click();true`);
  assert.deepEqual(await evaluate(`(()=>{const grid=document.querySelector("#keepsake-grid"),empty=grid.querySelector(".empty"),gridBox=grid.getBoundingClientRect(),emptyBox=empty.getBoundingClientRect();return{text:empty.textContent.trim(),columnSpan:getComputedStyle(empty).columnSpan,fullWidth:Math.abs(gridBox.width-emptyBox.width)<2,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{text:"还没有数字留存的小物。",columnSpan:"all",fullWidth:true,noOverflow:true});
  await evaluate(`document.querySelector('[data-section="today"]').click();true`);
  assert.deepEqual(await evaluate(`({memories:document.querySelectorAll(".home-v02-memory").length,empty:document.querySelector(".home-v02-empty")?.textContent,moodPoints:document.querySelectorAll("#home-mood-sparkline circle").length,keepsake:document.querySelector("#home-keepsake").textContent.includes("留存一件小物"),noOverflow:document.documentElement.scrollWidth<=innerWidth})`),{memories:0,empty:"留下第一条思考，往后在这里重逢。",moodPoints:0,keepsake:true,noOverflow:true});
  assert.equal(await evaluate(`document.querySelectorAll(".onboarding-question").length`),8);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".onboarding-question")].every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  const onboardingMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-onboarding-quick-mobile.png",Buffer.from(onboardingMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-onboarding-mode="detailed"]').click();true`);
  assert.equal(await evaluate(`document.querySelectorAll(".onboarding-question").length`),18);
  await evaluate(`document.querySelector("#onboarding-form").requestSubmit();true`);
  assert.equal(await evaluate(`window.__onboardingSaves`),0);
  await evaluate(`document.querySelectorAll(".onboarding-question").forEach(item=>item.querySelector('input[type="radio"]').checked=true);document.querySelector("#onboarding-region").value="北京";document.querySelector("#onboarding-introduction").value="可选介绍";document.querySelector("#onboarding-skip").click();true`);
  assert.equal(await evaluate(`document.querySelector("#onboarding-region").value===""&&document.querySelector("#onboarding-introduction").value===""&&!document.querySelector("#onboarding-optional").open`),true);
  await evaluate(`document.querySelector("#onboarding-preview").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#onboarding-understanding").value.includes("快速版初始认知")&&!document.querySelector("#onboarding-understanding").closest("label").hidden`),true);
  await evaluate(`document.querySelector("#onboarding-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__onboardingSaves===1&&document.querySelector("#onboarding-workspace").hidden`),true);
  assert.deepEqual(await evaluate(`({mode:window.__onboarding.questionnaireMode,answers:Object.keys(window.__onboarding.answers).length,profile:window.__onboarding.profile})`),{mode:"detailed",answers:18,profile:{gender:"",region:"",occupation:"",major:"",school:"",introduction:"",works:""}});
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),request=transaction.objectStore("drafts").put({key:"user-1:capture",owner:"user-1",id:"capture",uploadRequestId:"restored-upload",items:[{blob:new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),name:"restored.png",type:"image/png",lastModified:1}]});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),blob=new Blob([new Uint8Array([1,2,3,4])],{type:"audio/mp4"}),request=transaction.objectStore("drafts").put({key:"user-1:capture-audio",owner:"user-1",id:"capture-audio",audio:{blob,mimeType:"audio/mp4",bytes:blob.size,durationMs:1250,uploadRequestId:"restored-audio",uploadedPath:"",lastError:null}});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),store=transaction.objectStore("drafts"),blob=new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),item={blob,name:"targeted.png",type:"image/png",lastModified:1,uploadRequestId:"",uploadedPath:"",lastError:null};store.put({key:"user-1:comment",owner:"user-1",id:"comment",context:{selection:{rootKey:"analysis:analysis-1",targetKey:"content",start:0,end:3,quote:"总判断"},text:"刷新后继续的评论",requestId:"comment-restored"},items:[item]});store.put({key:"user-1:thoughtBlock",owner:"user-1",id:"thoughtBlock",context:{rootId:"kept-root",blockId:"",type:"record",occurredAt:"2026-09-27T12:34",content:"刷新后继续的内容块",version:1,requestId:"block-restored"},items:[item]});store.put({key:"user-1:health:weight:2026-09-27",owner:"user-1",id:"health:weight:2026-09-27",date:"2026-09-27",type:"weight",result:{bodyWaterMass:42.2,description:"刷新后恢复的体成分",attachmentPaths:["/attachments/weight.png"]},items:[{...item,uploadRequestId:"health-restored",uploadedPath:"/attachments/weight.png"}]});transaction.oncomplete=()=>resolve(true);transaction.onerror=()=>resolve(false)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),blob=new Blob([bytes],{type:"image/png"}),items=[1,2].map(index=>({itemId:"restored-keepsake-"+index,blob,name:"restored-"+index+".png",type:"image/png",lastModified:1,occurredAt:"2026-09-27T12:00:00",title:"恢复小物 "+index,category:"其他",note:"",tags:"",edgeExpansion:8,source:"manual",alphaMask:"",status:"waiting",uploadRequestId:"",createRequestId:"",mediaPaths:null,lastError:null})),request=opening.result.transaction("drafts","readwrite").objectStore("drafts").put({key:"user-1:keepsake-batch",owner:"user-1",id:"keepsake-batch",activeIndex:1,items});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  await cdp.send("Page.reload",{ignoreCache:true});await sleep(300);
  const mediaRestored=await waitUntil(`document.querySelector("#today-date-label")?.textContent.length>0&&document.querySelector('[data-content-image-editor="capture"] .content-image-preview')&&document.querySelector("#capture-status").textContent.includes("已恢复 1 张待上传图片")&&document.querySelector("#capture-audio-player").src.startsWith("blob:")&&document.querySelector("#capture-audio-meta").textContent.includes("0:01")&&document.querySelector("#capture-audio-status").textContent.includes("待提交语音")&&!document.querySelector("#comment-panel").hidden&&document.querySelector("#comment-text").value==="刷新后继续的评论"&&document.querySelectorAll('[data-content-image-editor="comment"] .content-image-preview').length===1&&!document.querySelector("#thought-block-modal").hidden&&document.querySelector("#thought-block-content").value==="刷新后继续的内容块"&&document.querySelectorAll('[data-content-image-editor="thoughtBlock"] .content-image-preview').length===1`);
  assert.equal(mediaRestored,true,JSON.stringify(await evaluate(`({date:document.querySelector("#today-date-label")?.textContent,preview:Boolean(document.querySelector('[data-content-image-editor="capture"] .content-image-preview')),captureStatus:document.querySelector("#capture-status")?.textContent,audioSrc:document.querySelector("#capture-audio-player")?.src,audioMeta:document.querySelector("#capture-audio-meta")?.textContent,audioStatus:document.querySelector("#capture-audio-status")?.textContent,toast:document.querySelector("#toast")?.textContent})`)));
  assert.deepEqual(await evaluate(`({commentOpen:!document.querySelector("#comment-panel").hidden,commentText:document.querySelector("#comment-text").value,commentImages:document.querySelectorAll('[data-content-image-editor="comment"] .content-image-preview').length,blockOpen:!document.querySelector("#thought-block-modal").hidden,blockText:document.querySelector("#thought-block-content").value,blockRoot:document.querySelector("#thought-block-root-id").value,blockImages:document.querySelectorAll('[data-content-image-editor="thoughtBlock"] .content-image-preview').length})`),{commentOpen:true,commentText:"刷新后继续的评论",commentImages:1,blockOpen:true,blockText:"刷新后继续的内容块",blockRoot:"kept-root",blockImages:1});
  assert.deepEqual(await evaluate(`({items:document.querySelectorAll(".keepsake-batch-item").length,count:document.querySelector("#keepsake-batch-count").textContent,active:document.querySelector('[data-keepsake-batch-select="1"]')?.getAttribute("aria-pressed")})`),{items:2,count:"2 件",active:"true"});
  await evaluate(`document.querySelector('[data-view="daily"]').click();document.querySelector('[data-daily-tab="weight"]').click();true`);
  assert.deepEqual(await evaluate(`({value:document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value,description:document.querySelector('[data-daily-form="weight"] [name="description"]').value,images:document.querySelectorAll("#health-image-previews figure").length,status:document.querySelector("#health-parse-status").textContent})`),{value:"42.2",description:"刷新后恢复的体成分",images:1,status:"已恢复识别结果，请核对后保存。"});
  assert.deepEqual(cdp.events
    .filter(event=>event.method==="Runtime.exceptionThrown")
    .map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
    .filter(message=>/Cannot set properties of null \(setting 'value'\)/.test(message)),[]);
  console.log("UI regression passed: home v0.2 data, routing, drafts and responsive layouts plus account, health, thought, local-mode and onboarding flows.");
} finally {
  cdp?.socket.close();
  chrome.kill("SIGKILL");
  await staticServer?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
