import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";
import { healthImageFixtures } from "./fixtures/health-images.mjs";
import { architectureOwnerSurface, commercializationOwnerSurface } from "../src/modules/owner-surfaces/index.mjs";
import { isApplicationRoutePath } from "../public/frontend/pages/index.mjs";

const CHROME = resolveHeadlessBrowser();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIGURED_APP_URL = process.env.APP_URL || "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TEST_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR2nWQAAAABJRU5ErkJggg==", "base64");
const commercialValidationBase = { participants: 5, rewardPerParticipantCny: 100, testDays: 14, tasksPerParticipant: 3, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 12, aiCallsPerParticipant: 20, imageCallsPerParticipant: 2 };
const commercialSubscriptionBase = { dailyActiveUsers: 5, monthlyActiveUsers: 20, payingUsers: 5, newPaidUsersPerMonth: 2, simulationMonths: 6, monthlyPriceCny: 39, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 100, operationsHoursPerMonth: 6, developmentHoursPerMonth: 20, acquisitionCostPerNewUserCny: 30, monthlyChurnPct: 8 };
const commercialDeliveryBase = { ordersPerMonth: 4, serviceFeePerOrderCny: 299, byokPct: 60, hostedPrepaidPerOrderCny: 100, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 2, supportHoursPerOrder: 0.5, developmentHoursPerMonth: 8, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 20 };
const commercialUsagePackBase = { buyersPerMonth: 10, packsPerBuyer: 1, pricePerPackCny: 29, includedAiCallsPerPack: 80, includedImageCallsPerPack: 10, utilizationPct: 70, supportHoursPerMonth: 2, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 10 };
const UI_COMMERCIAL_REPORT = {
  version: 3,
  updatedAt: "",
  assumptions: {
    stageByModel: { validation: 0, subscription: 0, delivery: 0, usagePack: 0 },
    stagePresets: {
      validation: [commercialValidationBase, { ...commercialValidationBase, participants: 20 }, { ...commercialValidationBase, participants: 100 }, { ...commercialValidationBase, participants: 300 }, { ...commercialValidationBase, participants: 1000 }],
      subscription: [commercialSubscriptionBase, { ...commercialSubscriptionBase, dailyActiveUsers: 100, monthlyActiveUsers: 400, payingUsers: 50, simulationMonths: 12 }, { ...commercialSubscriptionBase, dailyActiveUsers: 10000, monthlyActiveUsers: 40000, payingUsers: 4000, simulationMonths: 18 }, { ...commercialSubscriptionBase, dailyActiveUsers: 25000, monthlyActiveUsers: 100000, payingUsers: 10000, simulationMonths: 24 }, { ...commercialSubscriptionBase, dailyActiveUsers: 46000, monthlyActiveUsers: 184000, payingUsers: 18400, simulationMonths: 24 }],
      delivery: [commercialDeliveryBase, { ...commercialDeliveryBase, ordersPerMonth: 30 }, { ...commercialDeliveryBase, ordersPerMonth: 800 }, { ...commercialDeliveryBase, ordersPerMonth: 5000 }, { ...commercialDeliveryBase, ordersPerMonth: 15000 }],
      usagePack: [commercialUsagePackBase, { ...commercialUsagePackBase, buyersPerMonth: 80 }, { ...commercialUsagePackBase, buyersPerMonth: 4000 }, { ...commercialUsagePackBase, buyersPerMonth: 15000 }, { ...commercialUsagePackBase, buyersPerMonth: 36800 }]
    },
    validation: commercialValidationBase,
    subscription: commercialSubscriptionBase,
    delivery: commercialDeliveryBase,
    usagePack: commercialUsagePackBase,
    usageProfiles: {
      low: { sharePct: 40, activeDaysPerMonth: 4, requestsPerActiveDay: 2, foregroundAiCallsPerActiveDay: 0.5, backgroundAiCallsPerActiveDay: 0.25, imageCallsPerMonth: 1 },
      medium: { sharePct: 35, activeDaysPerMonth: 10, requestsPerActiveDay: 3, foregroundAiCallsPerActiveDay: 1.5, backgroundAiCallsPerActiveDay: 0.6, imageCallsPerMonth: 3 },
      high: { sharePct: 20, activeDaysPerMonth: 20, requestsPerActiveDay: 6, foregroundAiCallsPerActiveDay: 6.5, backgroundAiCallsPerActiveDay: 2, imageCallsPerMonth: 8 },
      full: { sharePct: 5, activeDaysPerMonth: 30, requestsPerActiveDay: 10, foregroundAiCallsPerActiveDay: 10, backgroundAiCallsPerActiveDay: 5, imageCallsPerMonth: 20 }
    },
    common: { usdCny: 7.2, aiCostFloorPerCallCny: 0.03, segmentationCostPerImageCny: 0.01, laborHourlyCny: 80 }
  }
};
const UI_OWNER_STATISTICS = {
  ai: {
    summary: { calls: 0, costUnknownCalls: 0, costCny: 0, costsUsd: { total: 0 } },
    calibration: { activeDays: 0, averageCallsPerActiveDay: 0, averageInputTokens: 0, maxInputTokens: 0, p90CostCny: 0 }
  },
  service: { completedWrites: 0, segmentationRequests: 0 }
};
const UI_OWNER_STORE = {
  thoughts: [{ id: "kept-root", type: "question", content: "没有初步想法的问题", tags: ["商业"], occurredAt: "2026-09-27T04:09:00.000Z" }]
};

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
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/owner/surfaces/architecture") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify(architectureOwnerSurface()));
        return;
      }
      if (["GET", "POST"].includes(request.method) && ["/api/owner/surfaces/commercialization", "/api/owner/surfaces/commercialization/preview"].includes(url.pathname)) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const report = input.assumptions ? { ...structuredClone(UI_COMMERCIAL_REPORT), assumptions: input.assumptions } : structuredClone(UI_COMMERCIAL_REPORT);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify(commercializationOwnerSurface({
          report,
          store: UI_OWNER_STORE,
          statistics: UI_OWNER_STATISTICS,
          mode: input.mode || "validation",
          currentDate: "2026-09-27"
        })));
        return;
      }
      const relative = isApplicationRoutePath(url.pathname) ? "index.html" : url.pathname.replace(/^\/+/, "");
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
    value: { getUserMedia: async () => {
      window.__microphoneRequests=(window.__microphoneRequests||0)+1;
      if(window.__failMicrophonePermission){window.__failMicrophonePermission=false;throw new DOMException("MIC_DEVICE_INTERNAL","NotAllowedError")}
      if(window.__delayMicrophonePermission)await new Promise(resolve=>{window.__releaseMicrophonePermission=()=>{window.__delayMicrophonePermission=false;delete window.__releaseMicrophonePermission;resolve()}});
      return { getTracks: () => [{ stop() { window.__microphoneTrackStops=(window.__microphoneTrackStops||0)+1 } }] }
    } }
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
  window.__speechPreviewRequests = [];
  window.__speechStaticPreviewRequests = [];
  window.__speechPlays = [];
  window.__speechPauses = [];
  window.__speechObjectUrls = [];
  window.__speechRevokedUrls = [];
  window.__rejectNextSpeechPlay = false;
  window.__delaySpeech = false;
  window.__releaseSpeech = null;
  window.__failSpeech = false;
  window.__failSpeechPreview = false;
  window.__speechAssetSerial = 3;
  window.__speechAssets = [
    { id:"asset-capture-long-v1",sourceType:"capture",sourceId:"capture-long",sourceVersion:1,voice:"zh_male_shaonianzixin_uranus_bigtts",generationRate:-10,mimeType:"audio/mpeg",bytes:3,createdAt:"2026-09-27T07:00:00.000Z",expiresAt:"2026-10-27T07:00:00.000Z" },
    { id:"asset-answer-kept-v1",sourceType:"thoughtAnswer",sourceId:"answer-kept",sourceVersion:1,voice:"zh_male_shaonianzixin_uranus_bigtts",generationRate:-10,mimeType:"audio/mpeg",bytes:3,createdAt:"2026-09-27T07:01:00.000Z",expiresAt:"2026-10-27T07:01:00.000Z" },
    { id:"asset-chain-kept-v1",sourceType:"thoughtChain",sourceId:"kept-root",sourceVersion:1,voice:"zh_male_shaonianzixin_uranus_bigtts",generationRate:-10,mimeType:"audio/mpeg",bytes:9,createdAt:"2026-10-05T00:00:00.000Z",expiresAt:"2026-11-05T00:00:00.000Z" }
  ];
  window.__failMicrophonePermission = false;
  window.__audioUploadKeys = [];
  window.__failAudioUpload = false;
  window.__delayAudioUpload = false;
  window.__releaseAudioUpload = null;
  window.__failTranscriptionQueue = false;
  const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = value => {
    const url = nativeCreateObjectUrl(value);
    if (String(value?.type || "").startsWith("audio/")) window.__speechObjectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = url => {
    if (window.__speechObjectUrls.includes(url)) window.__speechRevokedUrls.push(url);
    return nativeRevokeObjectUrl(url);
  };
  const nativeMediaPlay = HTMLMediaElement.prototype.play;
  const nativeMediaPause = HTMLMediaElement.prototype.pause;
  const nativePaused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused");
  const speechPaused = new WeakMap();
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get() {
      return speechPaused.has(this) ? speechPaused.get(this) : nativePaused.get.call(this);
    }
  });
  HTMLMediaElement.prototype.play = function() {
    if (!this.matches?.("[data-speech-player]")) return nativeMediaPlay.call(this);
    const rejected = window.__rejectNextSpeechPlay;
    window.__rejectNextSpeechPlay = false;
    speechPaused.set(this, rejected);
    window.__speechPlays.push({ src: this.currentSrc || this.src, rate: this.playbackRate, rejected });
    if (!rejected) this.dispatchEvent(new Event("play"));
    return rejected
      ? Promise.reject(new DOMException("AUTOPLAY_BLOCKED", "NotAllowedError"))
      : Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function() {
    if (!this.matches?.("[data-speech-player]")) return nativeMediaPause.call(this);
    speechPaused.set(this, true);
    window.__speechPauses.push(this.currentSrc || this.src);
    this.dispatchEvent(new Event("pause"));
  };
  window.Audio = class extends EventTarget {
    constructor(src = "") { super(); this.src = src; this.paused = true; this.playbackRate = 1; this.currentTime = 0; window.__lastSpeechAudio = this; }
    play() { this.paused = false; window.__speechPlays.push({ src: this.src, rate: this.playbackRate }); return Promise.resolve(); }
    pause() { this.paused = true; window.__speechPauses.push(this.src); }
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
  window.__followUpSaves = 0;
  window.__followUpPatches = 0;
  window.__followUpCreateKeys = [];
  window.__failFollowUpCreate = false;
  window.__failFollowUpPatch = "";
  window.__captureSaves = 0;
  window.__capturePayloads = [];
  window.__capturePatchPayloads = [];
  window.__delayCapturePatch = false;
  window.__releaseCapturePatch = null;
  window.__failCapturePatchNetwork = false;
  window.__loseCapturePatchResponse = false;
  window.__conflictCapturePatch = false;
  window.__failContentImageUpload = false;
  window.__journalSaves = 0;
  window.__journalPatches = 0;
  window.__journalDraft = { journalId: "journal-1", title: "跨端恢复的标题", content: "跨端恢复的正文。", updatedAt: "2026-09-27T08:18:19.000Z" };
  window.__journalDraftSaves = 0;
  window.__journalDraftRequests = 0;
  window.__journalDraftPayloads = [];
  window.__journalAssistPayloads = [];
  window.__failJournalDraft = false;
  window.__delayJournalDraft = false;
  window.__releaseJournalDraft = null;
  window.__delayJournalAssist = false;
  window.__releaseJournalAssist = null;
  window.__conflictJournalPatch = false;
  window.__delayJournalCreate = false;
  window.__releaseJournalCreate = null;
  window.__bookParses = 0;
  window.__bookUploads = 0;
  window.__keepsakeUploads = 0;
  window.__contentImageUploads = 0;
  window.__healthUploads = { sleep: 0, heartRate: 0, weight: 0, exercise: 0 };
  window.__delayHealthUpload = false;
  window.__releaseHealthUpload = null;
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
  window.__quotePayloads = [];
  window.__keepsakeOriginalReads = 0;
  window.__keepsakeUnderstandingRequests = [];
  window.__delayKeepsakeUnderstanding = false;
  window.__releaseKeepsakeUnderstanding = null;
  window.__holdKeepsakeDerivatives = false;
  window.__releaseKeepsakeDerivatives = null;
  window.__settingsSaves = 0;
  window.__lastSettingsPayload = null;
  window.__preferenceSaves = 0;
  window.__aiCostPlanSaves = 0;
  window.__commercializationSaves = 0;
  window.__ownerSurfaceRequests = [];
  window.__usernameChanges = 0;
  window.__passwordChanges = 0;
  window.__roleChanges = 0;
  window.__accountUser = { id: "user-1", username: "owner", role: "owner", createdAt: "2026-09-27T00:00:00.000Z" };
  window.__nextLoginRole = "owner";
  window.__reauthNextPreference = false;
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
  window.__failImageTaskCreate = false;
  window.__delaySecondState = false;
  window.__failNextStateRefresh = false;
  window.__startupEvents = [];
  const startupDelayMarker = sessionStorage.getItem("ui-delay-next-startup-secondary");
  window.__delayStartupSecondary = startupDelayMarker === null || startupDelayMarker === "1";
  sessionStorage.setItem("ui-delay-next-startup-secondary", "0");
  window.__releaseStartupSecondary = null;
  const observeStartupVisibility = () => {
    if (!document.body) return;
    new MutationObserver(() => {
      if (!document.body.classList.contains("auth-locked") && !window.__startupEvents.includes("shell:visible")) {
        window.__startupEvents.push("shell:visible");
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  };
  if (document.body) observeStartupVisibility();
  else document.addEventListener("DOMContentLoaded", observeStartupVisibility, { once: true });
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
  window.__failActionCompleteConflict = false;
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
  window.__taskRetries = 0;
  window.__delayTaskRetry = false;
  window.__releaseTaskRetry = null;
  window.__annotationSaves = 0;
  window.__thoughtAnnotationSaves = 0;
  window.__shenjiSaves = 0;
  window.__annotationTaskPayloads = [];
  window.__annotationTaskAttempts = [];
  window.__failNextAnnotationTaskPost = false;
  window.__onboardingSaves = 0;
  window.__onboardingV2Saves = 0;
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
  window.__failDiscoveryRead = false;
  window.__failDiscoveryStatusAction = "";
  window.__emptyDiscoveryRead = false;
  window.__failLocalModeTimeout = false;
  window.__localHydrateRequests = [];
  window.__apiRequests = [];
  window.__keepsakeObservers = [];
  window.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; window.__keepsakeObservers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
    trigger() { if (this.target) this.callback([{ isIntersecting: true, target: this.target }]); }
  };
  window.__localTestConfig = { enabled: true, upstreamConfigured: true, mode: "cold", snapshotAt: "", sourceUser: null, recordCount: 0, loadedScopes: [], loadedCollections: [] };
  window.__onboarding = { status: "dismissed", questionnaireVersion: 1, questionnaireMode: "quick", answers: {}, profile: {}, interests: [], material: "", understanding: "" };
  const defaultOnboardingV2 = (status = "skipped") => ({
    schemaVersion: 2,
    session: {
      id: "onboarding-v2",
      schemaVersion: 2,
      status,
      step: status === "skipped" ? "firstAction" : "welcome",
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
      selectedFlow: status === "skipped" ? "legacy" : "undecided",
      entryPolicy: status === "skipped" ? "already_onboarded" : "choose",
      legacy: { questionnaireVersion: 1, status: "pending", updatedAt: "", answerCount: 0, modelSummaryType: "", resourceType: "onboarding", resourceId: "onboarding" }
    }
  });
  try { window.__onboardingV2 = JSON.parse(sessionStorage.getItem("ui-onboarding-v2")) || defaultOnboardingV2(); }
  catch { window.__onboardingV2 = defaultOnboardingV2(); }
  window.__onboardingV2Schema = {
    schemaVersion: 2,
    steps: ["welcome","q1","q2","q3","q4","q5","review","candidates","firstAction"],
    statuses: ["draft","paused","completed","skipped"],
    defaults: { responseLength: "balanced", suggestionMode: "actionFirst", challengeStyle: "gentle" },
    questions: [
      { questionId: "currentContext", step: "q1", title: "现在的生活", prompt: "简单介绍一下，你现在的生活状态。", kind: "text", canSkip: true, limits: { maxLength: 2000 } },
      { questionId: "desiredChanges", step: "q2", title: "希望的变化", prompt: "未来 3–12 个月，你最希望发生哪些变化？", kind: "list", canSkip: true, limits: { maxItems: 3, itemMaxLength: 300, horizonMaxLength: 100 }, horizons: ["3m","6m","12m","custom","unknown"] },
      { questionId: "recentObstacles", step: "q3", title: "最近的困扰", prompt: "最近最困扰你的事是什么？", kind: "list", canSkip: true, limits: { maxItems: 3, itemMaxLength: 300 } },
      { questionId: "dailyRhythm", step: "q4", title: "日常节奏", prompt: "你平时大概怎样生活和工作？", kind: "text", canSkip: true, limits: { maxLength: 2000 } },
      { questionId: "collaboration", step: "q5", title: "怎么帮助", prompt: "你希望我怎样帮助你？", kind: "collaboration", canSkip: true, limits: { additionalBoundaryMaxLength: 1000 } }
    ]
  };
  window.__userModel = { readiness: "partial", claims: [], unknowns: [], activeClaimCount: 0, candidateCount: 0, staleCandidateCount: 0 };
  window.__onboardingExtraction = null;
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
  window.__keepsakePatchPayloads = [];
  window.__keepsakePatches = 0;
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
  const keepsakeMedia = item => ({
    version: 1,
    status: item.derivativeState === "pending" ? "pending" : "ready",
    originalAvailable: Boolean(item.originalPath),
    retryable: false,
    list: { imagePath: item.thumbPath || "", backgroundPath: item.editPath || "" },
    detail: { imagePath: item.displayPath || "", backgroundPath: item.editPath || "" }
  });
  window.__keepsakes.forEach(item => { item.media = keepsakeMedia(item); });
  window.__captures = [
    {
      id: "capture-1", createdAt: "2026-09-27T01:12:00.000Z", occurredAt: "2026-09-27T07:08:09.000Z", occurredOn: "2026-09-27",
      content: "**这个念头**先不要想完整", tags: ["灵感", "可展开"], version: 1
    },
    {
      id: "capture-long", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T07:05:09.000Z", occurredOn: "2026-09-27",
      content: "这是一条需要验证四行折叠的长捕念。\\n- 第一项内容\\n- 第二项内容\\n- 第三项内容\\n- 第四项内容\\n- 第五项内容\\n- 第六项内容", tags: ["职业规划"],
      audio: { attachmentPath: "/attachments/capture-voice.m4a", mimeType: "audio/mp4", bytes: 4096, durationMs: 1250 },
      transcription: { status: "ready", provider: "volcengine-seedasr-2.0", rawText: "**原始重点**\\n\\n<em>原始 HTML</em>\\n- 第一条原始内容\\n- 第二条原始内容", polishedText: "**整理重点**\\n\\n- 第一条整理内容\\n- 第二条整理内容\\n- 第三条整理内容", condensedText: "**凝练总结**\\n\\n1. 第一条结论\\n2. 第二条结论\\n3. 第三条结论\\n4. 第四条结论\\n5. 第五条结论\\n6. 第六条结论\\n7. 第七条结论", updatedAt: "2026-09-27T06:58:00.000Z", errorCode: "" }, version: 1
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
  let persistedAnalysisAnnotations = [];
  try { persistedAnalysisAnnotations = JSON.parse(sessionStorage.getItem("ui-analysis-annotations") || "[]"); } catch {}
  window.__reviewProjectionMode = sessionStorage.getItem("ui-review-projection-test") === "1";
  window.__analyses = window.__reviewProjectionMode
    ? Array.from({length:10},(_,index)=>({
        id:"analysis-page-"+(index+1),
        createdAt:"2026-09-"+String(30-index).padStart(2,"0")+"T01:20:00.000Z",
        reason:index%2?"manual":"weekly-background",
        content:"## 完整复盘 "+(index+1)+"\\n\\n"+"正文片段 ".repeat(12),
        reasoningContent:"不得进入普通页面",
        annotations:[],
        annotationDrift:[]
      }))
    : [
        { id: "analysis-1", createdAt: "2026-09-27T01:20:00.000Z", reason: "weekly-background", content: "**总判断**\\n\\n---\\n\\n## 证据", reasoningContent: "### 分析过程", annotations: persistedAnalysisAnnotations, annotationDrift: [] },
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
    version: "2026.10.02.2",
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
    ],
    userModel: {
      readiness: "usable",
      activeClaimCount: 1,
      disputedClaimCount: 1,
      candidateCount: 1,
      staleCandidateCount: 0,
      unknowns: [],
      claims: [
        { id:"context-active",domain:"goals",domainLabel:"目标",statement:"保持稳定推进",scope:"本月",epistemic:"known",lifecycle:"active",contextAllowed:true,version:2 },
        { id:"context-candidate",domain:"behavior",domainLabel:"行为",statement:"午后适合专注",scope:"",epistemic:"hypothesis",lifecycle:"candidate",contextAllowed:true,version:1 },
        { id:"context-disputed",domain:"context",domainLabel:"处境",statement:"旧来源已经变化",scope:"",epistemic:"hypothesis",lifecycle:"disputed",contextAllowed:false,version:3 }
      ]
    },
    sourcePermissions: [{
      sourceKey: JSON.stringify(["capture","capture-1","",""]),
      sourceRef: {resourceType:"capture",resourceId:"capture-1",rootId:"",targetKey:"",version:1},
      recordType:"念起",
      excerpt:"这个念头先不要想完整",
      status:"active",
      contextAllowed:true,
      learningAllowed:false,
      learningStatus:"off",
      revision:1,
      updatedAt:"2026-09-27T07:08:09.000Z",
      occurredAt:"2026-09-27T07:08:09.000Z"
    }],
    periodicSyntheses: [{
      id:"context-synthesis",
      content:"本周完成了一项行动，但结果仍需更多反馈。",
      reason:"manual",
      reviewStatus:"candidate",
      reviewedAt:"",
      reviewDisposition:"",
      createdAt:"2026-09-27T09:00:00.000Z",
      version:1
    }]
  };
  window.__thoughts = [
    { id: "answer-kept", createdAt: "2026-09-27T01:10:00.000Z", occurredAt: "2026-09-27T04:10:00.000Z", occurredOn: "2026-09-27", type: "answer", content: "**核心判断**\\n第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行", attachmentPaths: ["/attachments/thought-block.png"], modelDraft: "**核心判断**\\n第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行", editedFromModel: false, origin: "deepseek", reasoningContent: "**持久化**的模型思考", contextReceipt: window.__contextReceipt, tags: [], relatedTo: "kept-root", disposition: "kept", version: 1 },
    { id: "answer-user", createdAt: "2026-09-27T02:10:00.000Z", occurredAt: "2026-09-27T04:11:00.000Z", occurredOn: "2026-09-27", type: "answer", authorType: "user", content: "这是我自己的结论。", tags: [], relatedTo: "discarded-root", disposition: "kept", version: 1 },
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
  window.__aiBudgetCommands = 0;
  window.__aiBudget = {
    controlVersion: 1,
    policy: { userDailyKnownCostCny: 14.4, userDailyCalls: 200, siteDailyKnownCostCny: 100, siteMonthlyKnownCostCny: 2000, siteDailyUnknownCalls: 10, dailyAdditionMaxCny: 100, monthlyAdditionMaxCny: 2000, alertThresholds: [30,50,60,70,80,90,95,99,100] },
    day: { key: "2026-09-28", committedKnownCostCny: 12.5, reservedKnownCostCny: 2.5, effectiveKnownCostLimitCny: 100, committedUnknownCalls: 3, reservedUnknownCalls: 1, unknownCallLimit: 10, blocked: { knownCost: false, unknownCost: true } },
    month: { key: "2026-09", committedKnownCostCny: 320, reservedKnownCostCny: 2.5, effectiveKnownCostLimitCny: 2000, blocked: { knownCost: false } },
    activeReservations: 2,
    eventCount: 9
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
    if (url.startsWith("/api/") && !window.__replayingDelayedState) window.__apiRequests.push(String(init.method || "GET").toUpperCase() + " " + url);
    if (url.startsWith("/api/owner/surfaces/")) {
      window.__ownerSurfaceRequests.push(url);
      return nativeFetch(input, init);
    }
    if (url === "/api/v1/onboarding-v2/schema") return v1(window.__onboardingV2Schema);
    if (url === "/api/v1/onboarding-v2/session" && (!init.method || init.method === "GET")) return v1(window.__onboardingV2);
    if (url === "/api/v1/onboarding-v2/session" && init.method === "PATCH") {
      const headers=init.headers||{},expected=Number(String(headers["if-match"]||"").replaceAll('"',"")),current=Number(window.__onboardingV2.session.revision)+1;
      if(expected!==current)return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"五问会话已更新",code:"ONBOARDING_SESSION_CONFLICT",details:{currentRevision:window.__onboardingV2.session.revision,currentEtag:'"'+current+'"',currentSession:window.__onboardingV2.session}},meta:{traceId:"ui-onboarding"}}),{status:409,headers:{"content-type":"application/json"}}));
      const payload=JSON.parse(init.body||"{}"),now=new Date().toISOString(),session=window.__onboardingV2.session,answers={...session.answers};
      for(const [questionId,answer]of Object.entries(payload.answers||{})){
        if(answer===null){delete answers[questionId];continue}
        const previous=answers[questionId],content=Object.hasOwn(answer,"rawText")?{rawText:answer.rawText}:{structuredValue:answer.structuredValue||[]};
        answers[questionId]={questionId,...content,occurredAt:answer.occurredAt||previous?.occurredAt||now,updatedAt:now,version:(previous?.version||0)+1,contextAllowed:answer.contextAllowed!==false}
      }
      const defaults={responseLength:"balanced",suggestionMode:"actionFirst",challengeStyle:"gentle"},collaboration={...session.collaboration};
      for(const key of Object.keys(defaults))if(Object.hasOwn(payload.collaboration||{},key)){const axis=payload.collaboration[key];collaboration[key]=axis?.source==="user"?axis:{value:defaults[key],source:"system_default"}}
      if(Object.hasOwn(payload.collaboration||{},"additionalBoundary"))collaboration.additionalBoundary=payload.collaboration.additionalBoundary;
      if(Object.hasOwn(payload.collaboration||{},"contextAllowed"))collaboration.contextAllowed=payload.collaboration.contextAllowed;
      const status=payload.status||session.status,step=["completed","skipped"].includes(status)?"firstAction":payload.step||session.step,revision=session.revision+1;
      window.__onboardingV2={...window.__onboardingV2,session:{...session,status,step,revision,answers,collaboration,startedAt:session.startedAt||now,pausedAt:status==="paused"?now:"",completedAt:status==="completed"?(session.completedAt||now):"",updatedAt:now},readiness:Object.keys(answers).length||Object.values(collaboration).some(value=>value?.source==="user")||collaboration.additionalBoundary?"partial":"empty",migration:{...window.__onboardingV2.migration,selectedFlow:"v2",entryPolicy:"v2"}};
      sessionStorage.setItem("ui-onboarding-v2",JSON.stringify(window.__onboardingV2));window.__onboardingV2Saves+=1;window.__syncCursor+=1;
      if(headers["x-client-operation-id"])window.__operationReceipts[headers["x-client-operation-id"]]=headers["x-client-operation-fingerprint"];
      return v1(window.__onboardingV2,{operation:{id:headers["x-client-operation-id"]||"",status:"committed"}});
    }
    if(url==="/api/v1/onboarding-v2/extractions"&&init.method==="POST"){
      const payload=JSON.parse(init.body||"{}"),taskId="extract-"+payload.sourceRevision;
      window.__onboardingExtraction={id:taskId,kind:"onboardingClaimExtraction",resourceType:"onboardingV2",targetId:"onboarding-v2",inputVersion:payload.sourceRevision,status:"queued",createdAt:new Date().toISOString(),startedAt:"",completedAt:"",resultId:"",error:"",retryOf:""};
      return v1(window.__onboardingExtraction);
    }
    if(url.startsWith("/api/v1/onboarding-v2/extractions/")&&init.method==="DELETE"){
      window.__onboardingExtraction.status="cancelled";window.__onboardingExtraction.completedAt=new Date().toISOString();window.__onboardingExtraction.error="用户取消了本次生成";
      return v1(window.__onboardingExtraction);
    }
    if(url.startsWith("/api/v1/onboarding-v2/extractions/")&&(!init.method||init.method==="GET")){
      const task=window.__onboardingExtraction;
      if(task&&task.status!=="succeeded"){
        task.status="succeeded";task.completedAt=new Date().toISOString();task.resultId=task.id;
        window.__userModel.claims=[{id:"claim-ui-1",domain:"goals",statement:"希望恢复规律作息",scope:"未来 3 个月",epistemic:"known",lifecycle:"candidate",confidence:null,evidenceStrength:"self_report",evidence:[{sourceType:"onboardingV2Answer",sourceId:"desiredChanges",sourceVersion:1,contentSha256:"a".repeat(64),span:[0,6]}],validFrom:"",validTo:"",confirmedAt:"",lastReviewedAt:"",supersedes:"",contextAllowed:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,sourceTaskId:task.id,disposition:""}];
        window.__userModel.unknowns=[{id:"unknown-ui-1",question:"怎样的作息调整最容易开始？",domain:"behavior",reason:"影响下一步建议",relatedEvidence:["claim-ui-1"],impactOnNextAnswer:"决定行动粒度",askedAt:"",snoozedUntil:"",resolvedBy:"",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,sourceTaskId:task.id}];
        window.__userModel.candidateCount=1;
      }
      return v1({task,result:task?.status==="succeeded"?{claims:window.__userModel.claims,unknowns:window.__userModel.unknowns}:null});
    }
    if(url==="/api/v1/user-model"&&(!init.method||init.method==="GET"))return v1(window.__userModel);
    if(url==="/api/v1/user-model/evidence-permissions"&&init.method==="PATCH"){
      const payload=JSON.parse(init.body||"{}"),permission=window.__personalContext.sourcePermissions.find(item=>item.sourceKey===JSON.stringify([payload.sourceRef.resourceType,payload.sourceRef.resourceId,payload.sourceRef.rootId||"",payload.sourceRef.targetKey||""]));
      if(!permission)return json({data:null,error:{message:"来源已变化",code:"EVIDENCE_SOURCE_STALE"},meta:{}},409);
      permission.contextAllowed=payload.contextAllowed;permission.learningAllowed=payload.learningAllowed;permission.learningStatus=payload.learningAllowed?"queued":"off";permission.revision+=1;permission.updatedAt=new Date().toISOString();
      return v1({permission,unchanged:false,learningRefreshQueued:payload.learningAllowed});
    }
    if(url.startsWith("/api/v1/user-model/claims/")&&init.method==="PATCH"){
      const id=decodeURIComponent(url.split("/").at(-1)),payload=JSON.parse(init.body||"{}"),models=[window.__userModel,window.__personalContext.userModel],model=models.find(item=>item.claims.some(claim=>claim.id===id)),claim=model?.claims.find(item=>item.id===id);
      if(!claim)return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"候选不存在",code:"CLAIM_NOT_FOUND"},meta:{}}),{status:404,headers:{"content-type":"application/json"}}));
      claim.lifecycle=["reject","retract"].includes(payload.action)?"retracted":"active";claim.statement=payload.statement||claim.statement;claim.scope=payload.scope??claim.scope;claim.epistemic=payload.epistemic||claim.epistemic;claim.contextAllowed=payload.contextAllowed!==false;claim.version+=1;claim.updatedAt=new Date().toISOString();
      model.candidateCount=model.claims.filter(item=>item.lifecycle==="candidate").length;model.activeClaimCount=model.claims.filter(item=>item.lifecycle==="active").length;model.disputedClaimCount=model.claims.filter(item=>item.lifecycle==="disputed").length;
      return v1({claim});
    }
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
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "OSS_NO_SUCH_KEY_INTERNAL", code: "ATTACHMENT_FORBIDDEN" } }), { status: 403, headers: { "content-type": "application/json" } }));
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
    if (url === "/api/v1/actions/ui-action/complete" && init.method === "POST" && window.__failActionCompleteConflict) {
      window.__failActionCompleteConflict = false;
      window.__actionListVersion += 1;
      return Promise.resolve(new Response(JSON.stringify({error:{message:"资源版本已变化，请重新读取后再提交",code:"PRECONDITION_FAILED",details:{currentVersion:window.__actionListVersion}}}),{status:412,headers:{"content-type":"application/json"}}));
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
    if (url.startsWith("/api/v1/discovery")) {
      if(window.__failDiscoveryRead){window.__failDiscoveryRead=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"DISCOVERY_BACKEND_INTERNAL",code:"DISCOVERY_FAILED"}}),{status:503,headers:{"content-type":"application/json"}}))}
      if(window.__emptyDiscoveryRead)return v1([],{total:0,untracedCount:0,totalUntracedCount:0,nextCursor:null});
      return v1([{id:"kept-root",rootId:"kept-root",question:{id:"kept-root",content:"没有初步想法的问题",source:"user",sourceLabel:"用户原文"},matches:[{id:"kept-root",content:"没有初步想法的问题",source:"user",sourceLabel:"用户原文",type:"question"}],matchCount:1,occurredAt:"2026-09-27T04:09:00.000Z",status:{version:1,fresh:true,untraced:true,read:false,snoozed:false},fresh:true,untraced:true}],{total:1,untracedCount:1,totalUntracedCount:1,nextCursor:null})
    }
    if (url === "/api/v1/feedback" && init.method === "POST") {
      if(window.__delayFeedbackCreate)return new Promise(resolve=>{window.__releaseFeedbackCreate=()=>{window.__delayFeedbackCreate=false;resolve(v1({id:"created-feedback"}))}});
      return v1({id:"created-feedback"});
    }
    if (url.startsWith("/api/v1/feedback")) return v1([{id:"ui-feedback",type:"experience",feature:"思绪",appVersion:"0.2.0",body:"界面清晰",context:{selected:false,summary:""},status:"submitted",version:1,createdAt:"2026-09-27T04:00:00.000Z",updatedAt:"2026-09-27T04:00:00.000Z"}]);
    if (url === "/api/v1/personal-context") return v1(window.__personalContext);
    if(/^\\/api\\/v1\\/analyses\\/[^/]+$/.test(url)&&init.method==="PATCH"){
      const id=url.split("/").at(-1),payload=JSON.parse(init.body||"{}"),item=window.__personalContext.periodicSyntheses.find(value=>value.id===id);
      if(!item)return json({data:null,error:{message:"复盘不存在",code:"ANALYSIS_NOT_FOUND"},meta:{}},404);
      item.reviewStatus=payload.decision==="confirm"?"confirmed":"rejected";item.reviewedAt=new Date().toISOString();item.version+=1;return v1(item);
    }
    if(url==="/api/v1/analyses"&&init.method==="POST"){
      const item={id:"context-synthesis-new",content:"新生成的周期回望",reason:"manual",reviewStatus:"candidate",reviewedAt:"",reviewDisposition:"",createdAt:new Date().toISOString(),version:1};
      window.__personalContext.periodicSyntheses.unshift(item);return v1(item);
    }
    if (url.includes("/api/v1/exports/account?format=manifest")) return v1({snapshotVersion:15,summary:{resources:12,attachments:2,attachmentReferences:3,orphanReferences:0}});
    if (url.includes("/api/v1/exports/account?format=json")) return v1({format:"json",filename:"for-now-ui.json",mimeType:"application/json;charset=utf-8",content:"{}\\n"});
    if (url.includes("/api/v1/exports/account?format=markdown")) return v1({format:"markdown",filename:"for-now-ui.md",mimeType:"text/markdown;charset=utf-8",content:"# For Now\\n"});
    if (/^\\/api\\/v1\\/analyses\\/[^/]+$/.test(url) && (!init.method || init.method === "GET")) {
      const item=window.__analyses.find(value=>value.id===url.split("/").at(-1));
      return item?v1(item):json({data:null,error:{message:"这次复盘不存在",code:"ANALYSIS_NOT_FOUND"},meta:{}},404)
    }
    if (url.startsWith("/api/v1/analyses?") && (!init.method || init.method === "GET")) {
      const parsed=new URL("http://local"+url),cursor=parsed.searchParams.get("cursor")||"",start=cursor?window.__analyses.findIndex(item=>item.id===cursor)+1:0,items=window.__analyses.slice(start,start+20),nextCursor=start+items.length<window.__analyses.length?items.at(-1).id:null;
      return v1(items,{nextCursor})
    }
    if (url === "/api/v1/startup") {
      if(location.search.includes("ui-unauthenticated-startup=1"))return json({data:null,error:{code:"AUTH_REQUIRED",message:"请先登录"},meta:{}},401);
      window.__startupEvents.push("startup:response");
      const owner=window.__accountUser.role==="owner";
      return v1({ protocolVersion:1,version:"build-fixture",releaseVersion:"0.2.0",user:window.__accountUser,capabilities:owner?["ai-costs","architecture","commercialization","local-testing","ai-configuration","account-roles"]:[],features:{incrementalSync:true},governanceUrl:owner?"/platform/":"",accountCursor:window.__syncCursor,notificationUnread:window.__notifications.filter(item=>!item.readAt).length,quoteTags:["阅读","摘录","长期"],onboardingV2:window.__onboardingV2 });
    }
    if (url.startsWith("/api/v1/route-state")) {
      const respond=()=>{window.__replayingDelayedState=true;const pending=window.fetch("/api/state",init);window.__replayingDelayedState=false;return pending.then(async response=>{window.__startupEvents.push("route:response");const parsed=new URL("http://local"+url),view=parsed.searchParams.get("view")||"today",snapshot=await response.json();if(window.__reviewProjectionMode&&view==="review"){const cursor=parsed.searchParams.get("cursor")||"",start=cursor?window.__analyses.findIndex(item=>item.id===cursor)+1:0,selected=window.__analyses.slice(start,start+8).map(item=>({...item,content:item.content.slice(0,24),contentTruncated:item.content.length>24}));snapshot.analyses=selected;snapshot.analysisPage={nextCursor:start+selected.length<window.__analyses.length?selected.at(-1).id:null,total:window.__analyses.length}}return v1({...snapshot,_routeProjection:{view,complete:!window.__reviewProjectionMode}})})};
      if(window.__failNextStateRefresh){window.__failNextStateRefresh=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"DISCOVERY_BACKEND_INTERNAL"}}),{status:503,headers:{"content-type":"application/json"}}))}
      if(window.__accountUser.id==="user-2"&&window.__delaySecondState)return new Promise(resolve=>{window.__releaseSecondState=()=>{window.__delaySecondState=false;resolve(respond())}});
      return respond()
    }
    if (url === "/api/meta") {
      const owner=window.__accountUser.role==="owner";
      return json({ version: "build-fixture", releaseVersion: "0.5.7", user: window.__accountUser, capabilities:owner?["ai-costs","architecture","commercialization","local-testing","ai-configuration","account-roles"]:[], governanceUrl:owner?"/platform/":"" });
    }
    if (url === "/api/auth/me") return location.search.includes("ui-unauthenticated-startup=1")
      ?json({authenticated:false,authRequired:true,registrationAvailable:true,user:null,capabilities:[],userCount:2},401)
      :json({ authenticated: true, authRequired: true, registrationAvailable: true, user: window.__accountUser, capabilities:window.__accountUser.role==="owner"?["account-roles"]:[], userCount: 2 });
    if (url === "/api/auth/users" && (!init.method || init.method === "GET")) return json({users:[window.__accountUser,{id:"member-1",username:"member",role:"user",createdAt:"2026-09-27T00:00:00.000Z"}]});
    if (/^\\/api\\/auth\\/users\\/[^/]+\\/role$/.test(url) && init.method === "PATCH") {
      window.__roleChanges+=1;
      return json({authenticated:true,user:{id:url.split("/")[4],username:"member",role:JSON.parse(init.body).role,createdAt:"2026-09-27T00:00:00.000Z"}})
    }
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
      const complete=()=>{window.__accountUser={id:"user-2",username:"second",role:window.__nextLoginRole,createdAt:"2026-09-27T00:00:00.000Z"};return json({authenticated:true,authRequired:true,user:window.__accountUser})};
      if(window.__delayLogin)return new Promise(resolve=>{window.__releaseLogin=()=>{window.__delayLogin=false;resolve(complete())}});
      return complete();
    }
    if (url === "/api/v1/owner/ai-budget") {
      const response=()=>Promise.resolve(new Response(JSON.stringify({data:window.__aiBudget,error:null,meta:{traceId:"ui-budget"}}),{status:200,headers:{"content-type":"application/json",etag:'"'+window.__aiBudget.controlVersion+'"'}}));
      if(!init.method||init.method==="GET")return response();
      if(init.method==="PATCH"){
        const expected=Number(String((init.headers||{})["if-match"]||"").replaceAll('"',""));
        if(expected!==window.__aiBudget.controlVersion)return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"预算状态已更新",code:"PRECONDITION_FAILED",details:{currentVersion:window.__aiBudget.controlVersion}},meta:{traceId:"ui-budget"}}),{status:412,headers:{"content-type":"application/json"}}));
        const payload=JSON.parse(init.body||"{}");
        if(payload.command==="addTemporaryBudget"){
          const target=payload.scope==="monthly"?window.__aiBudget.month:window.__aiBudget.day;
          target.effectiveKnownCostLimitCny+=Number(payload.amountCny)||0
        }else if(payload.command==="recover"){
          if(payload.scope==="dailyKnownCost")window.__aiBudget.day.blocked.knownCost=false;
          else if(payload.scope==="dailyUnknownCost")window.__aiBudget.day.blocked.unknownCost=false;
          else window.__aiBudget.month.blocked.knownCost=false
        }
        window.__aiBudget.controlVersion+=1;window.__aiBudget.eventCount+=1;window.__aiBudgetCommands+=1;return response()
      }
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
      if(mode==="cold"){
        window.__onboarding={status:"pending",questionnaireVersion:1,questionnaireMode:"quick",answers:{},profile:{},interests:[],material:"",understanding:""};
        window.__onboardingV2=defaultOnboardingV2("draft");sessionStorage.setItem("ui-onboarding-v2",JSON.stringify(window.__onboardingV2))
      }
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
      const blank = () => ({ calls: 0, successfulCalls: 0, failedCalls: 0, unknownStatusCalls: 0, usageUnknownCalls: 0, durationMs: 0, durationKnownCalls: 0, maxDurationMs: 0, visionCalls: 0, imageCount: 0, imageBytes: 0, costUnknownCalls: 0, costCny: 0, tokens: { input: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0, answer: 0, output: 0 }, costsCny: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 }, costsUsd: { input: 0, cacheHit: 0, reasoning: 0, output: 0, total: 0 } });
      const daily = dates.map((date,index) => {
        const flash = blank(), pro = blank(), micro = blank();
        flash.calls = index % 3;flash.successfulCalls=flash.calls;flash.durationMs=840*flash.calls;flash.durationKnownCalls=flash.calls;flash.maxDurationMs=flash.calls?840:0;flash.visionCalls=index===5?1:0;flash.imageCount=flash.visionCalls*2;flash.imageBytes=flash.imageCount*2048;flash.tokens = { input: 1200*flash.calls, cacheHit: 400*flash.calls, cacheMiss: 800*flash.calls, reasoning: 180*flash.calls, answer: 320*flash.calls, output: 500*flash.calls };flash.costsCny = { input: .0016*flash.calls, cacheHit: .000016*flash.calls, reasoning: .00144*flash.calls, output: .00256*flash.calls, total: .005616*flash.calls };flash.costCny=flash.costsCny.total;
        pro.calls = index % 2;pro.successfulCalls=pro.calls;pro.durationMs=1350*pro.calls;pro.durationKnownCalls=pro.calls;pro.maxDurationMs=pro.calls?1350:0;pro.tokens = { input: 1800*pro.calls, cacheHit: 600*pro.calls, cacheMiss: 1200*pro.calls, reasoning: 500*pro.calls, answer: 600*pro.calls, output: 1100*pro.calls };pro.costsCny = { input: .0108*pro.calls, cacheHit: .00018*pro.calls, reasoning: .0135*pro.calls, output: .0162*pro.calls, total: .04068*pro.calls };pro.costCny=pro.costsCny.total;
        if(index===0){micro.costsCny.output=.00000004;micro.costsCny.total=.00000004;micro.costCny=.00000004}
        const total = blank();for(const item of[flash,pro]){for(const key of["calls","successfulCalls","failedCalls","unknownStatusCalls","usageUnknownCalls","durationMs","durationKnownCalls","visionCalls","imageCount","imageBytes","costUnknownCalls","costCny"])total[key]+=item[key];total.maxDurationMs=Math.max(total.maxDurationMs,item.maxDurationMs);for(const key in total.tokens)total.tokens[key]+=item.tokens[key];for(const key in total.costsCny)total.costsCny[key]+=item.costsCny[key];for(const key in total.costsUsd)total.costsUsd[key]+=item.costsUsd[key]}
        return { date, ...total, models: { "deepseek-flash": flash, "deepseek-v4-pro": pro, micro }, services: {} };
      });
      const sum = items => { const total=blank();for(const item of items){for(const key of["calls","successfulCalls","failedCalls","unknownStatusCalls","usageUnknownCalls","durationMs","durationKnownCalls","visionCalls","imageCount","imageBytes","costUnknownCalls","costCny"])total[key]+=item[key];total.maxDurationMs=Math.max(total.maxDurationMs,item.maxDurationMs);for(const key in total.tokens)total.tokens[key]+=item.tokens[key];for(const key in total.costsCny)total.costsCny[key]+=item.costsCny[key];for(const key in total.costsUsd)total.costsUsd[key]+=item.costsUsd[key]}return total };
      const flash=sum(daily.map(item=>item.models["deepseek-flash"])),pro=sum(daily.map(item=>item.models["deepseek-v4-pro"])),deepseek=sum(daily);
      const tts={...blank(),calls:1,successfulCalls:1,durationMs:600,durationKnownCalls:1,maxDurationMs:600,costCny:.036,unitUsage:[{unitType:"character",units:120}]};
      const asr={...blank(),calls:1,successfulCalls:1,durationMs:900,durationKnownCalls:1,maxDurationMs:900,costCny:.000417,unitUsage:[{unitType:"audioMillisecond",units:1500}]};
      const speech=sum([tts,asr]);
      const volcVision={...blank(),calls:1,successfulCalls:1,durationMs:640,durationKnownCalls:1,maxDurationMs:640,visionCalls:1,imageCount:1,imageBytes:2048,costCny:.005,unitUsage:[{unitType:"call",units:1}]};
      const volcDocument={...blank(),calls:1,successfulCalls:1,durationMs:780,durationKnownCalls:1,maxDurationMs:780,costCny:.06,unitUsage:[{unitType:"page",units:3}]};
      const aliyunSegmentation={...blank(),calls:2,successfulCalls:1,failedCalls:1,durationMs:940,durationKnownCalls:2,maxDurationMs:700,visionCalls:2,imageCount:1,imageBytes:2048,costCny:.007,unitUsage:[{unitType:"call",units:2}]};
      const volcengine=sum([speech,volcVision,volcDocument]),aliyun={...aliyunSegmentation},summary=sum([deepseek,volcengine,aliyun]);
      const deepseekVision={...blank(),calls:deepseek.visionCalls,successfulCalls:deepseek.visionCalls,visionCalls:deepseek.visionCalls,imageCount:deepseek.imageCount,imageBytes:deepseek.imageBytes,durationMs:840*deepseek.visionCalls,durationKnownCalls:deepseek.visionCalls,tokens:{...blank().tokens,input:2400,output:1000},costCny:.011232,costsCny:{...blank().costsCny,total:.011232}};
      const vision=sum([deepseekVision,volcVision,aliyunSegmentation]),text={...deepseek,calls:deepseek.calls-deepseekVision.calls,successfulCalls:deepseek.successfulCalls-deepseekVision.successfulCalls,durationMs:deepseek.durationMs-deepseekVision.durationMs,durationKnownCalls:deepseek.durationKnownCalls-deepseekVision.durationKnownCalls,visionCalls:0,imageCount:0,imageBytes:0},audio={...speech},document={...volcDocument};
      const services=[
        {key:"deepseekText",provider:"deepseek",service:"text",label:"DeepSeek 文本",...text,unitUsage:[{unitType:"token",units:text.tokens.input+text.tokens.output}]},
        {key:"deepseekVision",provider:"deepseek",service:"vision",label:"DeepSeek 图片理解",...deepseekVision,unitUsage:[{unitType:"token",units:deepseekVision.tokens.input+deepseekVision.tokens.output}]},
        {key:"volcengineTts",provider:"volcengine",service:"speech",label:"豆包语音合成",...tts},
        {key:"volcengineAsr",provider:"volcengine",service:"speech",label:"豆包语音识别",...asr},
        {key:"volcengineOcr",provider:"volcengine",service:"vision",label:"火山文字识别",...volcVision},
        {key:"volcengineDocument",provider:"volcengine",service:"vision",label:"火山文档解析",...volcDocument},
        {key:"aliyunSegmentation",provider:"aliyun",service:"segmentation",label:"阿里云图片分割",...aliyunSegmentation}
      ];
      for(const day of daily)day.services={deepseekText:{...day,unitUsage:[{unitType:"token",units:day.tokens.input+day.tokens.output}]},deepseekVision:blank(),volcengineTts:blank(),volcengineAsr:blank(),volcengineOcr:blank(),volcengineDocument:blank(),aliyunSegmentation:blank()};
      daily[3].services.volcengineAsr=asr;daily[4].services.volcengineTts=tts;daily[5].services.volcengineOcr=volcVision;daily[5].services.volcengineDocument=volcDocument;daily[6].services.aliyunSegmentation=aliyunSegmentation;
      const content=[{ key:"checkins",label:"状态",count:4 },{ key:"sleep",label:"睡眠",count:2 },{ key:"heartRate",label:"心率",count:1 },{ key:"weight",label:"体重",count:1 },{ key:"exercise",label:"运动",count:0 },{ key:"captures",label:"捕念",count:2 },{ key:"journals",label:"日记",count:1 },{ key:"thoughts",label:"思考主题",count:2 },{ key:"chats",label:"长期对话",count:1 },{ key:"books",label:"书目",count:1 },{ key:"bookNotes",label:"读书记录",count:5 },{ key:"quotes",label:"善言",count:4 },{ key:"keepsakes",label:"小物",count:1 },{ key:"experiments",label:"个人实验",count:2 },{ key:"analyses",label:"认知复盘",count:4 }];
      const interactions=[{ key:"highlights",label:"划线",count:3 },{ key:"comments",label:"评论",count:2 },{ key:"commentReplies",label:"评论回复",count:1 },{ key:"shenji",label:"@神鸡",count:2 },{ key:"followUps",label:"思考追问",count:1 },{ key:"remarks",label:"思考备注",count:1 },{ key:"reflections",label:"日记回望",count:0 }];
      const byKey=Object.fromEntries([...content,...interactions].map(item=>[item.key,item])),module=(key,label,keys)=>({key,label,items:keys.map(item=>byKey[item]),total:keys.reduce((sum,item)=>sum+byKey[item].count,0)});
      const groups=[
        {key:"today",label:"今日",modules:[module("moment","此刻",["checkins"]),module("together","共参",["chats"]),module("daily","每日",["sleep","heartRate","weight","exercise"])]},
        {key:"seen",label:"所见",modules:[module("captures","念起",["captures"]),module("books","书间",["books","bookNotes"]),module("quotes","拾句",["quotes"]),module("keepsakes","小物",["keepsakes"])]},
        {key:"thought",label:"所思",modules:[module("thoughts","思绪",["thoughts"]),module("journals","日记",["journals"]),module("review","回顾",["experiments","analyses"])]},
        {key:"interaction",label:"互动",modules:[module("annotations","正文批注",["highlights","comments","commentReplies","shenji"]),module("thoughtInteractions","思绪",["followUps","remarks"]),module("journalInteractions","日记",["reflections"])]}
      ].map(group=>({...group,total:group.modules.reduce((sum,item)=>sum+item.total,0)}));
      if(window.__accountUser.role!=="owner")return json({records:{total:41,contentTotal:31,interactionTotal:10,content,interactions,groups}});
      return json({
        records: { total: 41, contentTotal: 31, interactionTotal: 10, content, interactions, groups },
        ai: { from:dates[0],to:dates.at(-1),trackingStartedAt:"2026-09-21T01:00:00.000Z",summary,daily,models:[{model:"deepseek-flash",label:"DeepSeek Flash",...flash},{model:"deepseek-v4-pro",label:"DeepSeek Pro",...pro},{model:"unused",label:"未使用模型",...blank()},{model:"micro",label:"微额模型",...sum(daily.map(item=>item.models.micro))}],providers:[{provider:"deepseek",label:"DeepSeek",...deepseek},{provider:"volcengine",label:"火山引擎",...volcengine},{provider:"aliyun",label:"阿里云",...aliyun}],services,modalities:[{modality:"text",label:"纯文本",...text},{modality:"vision",label:"图片理解",...vision},{modality:"audio",label:"语音",...audio},{modality:"document",label:"文档",...document}],scenes:[{scene:"thoughtAnswer",calls:4,tokens:{input:12000,cacheHit:3000,reasoning:3000,answer:2000},costCny:.1356,costsCny:{total:.1356},costsUsd:{total:0}},{scene:"chat",calls:2,tokens:{input:5000,cacheHit:1000,reasoning:800,answer:600},costCny:.028,costsCny:{total:.028},costsUsd:{total:0}},{scene:"annotationShenji",calls:1,tokens:{input:1800,cacheHit:200,reasoning:200,answer:180},costCny:.00856,costsCny:{total:.00856},costsUsd:{total:0}},{scene:"speechSynthesis",calls:1,costCny:.036,tokens:{},costsCny:{total:.036},costsUsd:{total:0}},{scene:"keepsakeSegmentation",calls:2,durationMs:940,durationKnownCalls:2,maxDurationMs:700,visionCalls:2,imageCount:1,imageBytes:2048,costCny:.007,costsCny:{total:.007},costsUsd:{total:0},unitUsage:[{unitType:"call",units:2}]}],calibration:{activeDays:6,averageCallsPerActiveDay:1.5,averageInputTokens:1467,maxInputTokens:31860,averageRequestChars:5100,maxRequestChars:52661,medianCostCny:.025,p90CostCny:.041,maxCostCny:.042},pricing:{source:"https://api-docs.deepseek.com/zh-cn/quick_start/pricing",checkedAt:"2026-10-02",currency:"CNY",displayCurrency:"CNY",cnyPerUsd:7.2,unitTokens:1000000,models:{"deepseek-flash":{label:"DeepSeek Flash",offPeak:{cacheHit:.02,cacheMiss:1,output:4},peak:{cacheHit:.04,cacheMiss:2,output:8}},"deepseek-v4-pro":{label:"DeepSeek Pro",offPeak:{cacheHit:.15,cacheMiss:4.5,output:13.5},peak:{cacheHit:.3,cacheMiss:9,output:27}}},providerRates:[{label:"豆包语音合成模型2.0",priceCny:3,unitLabel:"万字符",source:"https://docs.volcengine.com/docs/6561/1359370?lang=zh",checkedAt:"2026-10-02"},{label:"豆包流式语音识别模型2.0",priceCny:1,unitLabel:"音频小时",source:"https://docs.volcengine.com/docs/6561/1359370?lang=zh",checkedAt:"2026-10-02"},{label:"豆包录音文件识别模型2.0",priceCny:.8,unitLabel:"音频小时",source:"https://docs.volcengine.com/docs/6561/1359370?lang=zh",checkedAt:"2026-10-02"},{label:"通用文字识别 OCRNormal",priceCny:.005,unitLabel:"次",source:"https://www.volcengine.com/docs/86081/1660260",checkedAt:"2026-10-02"},{label:"智能文档解析",priceCny:.02,unitLabel:"页",source:"https://www.volcengine.com/docs/86081/1804813",checkedAt:"2026-10-02"},{label:"通用高清分割",priceCny:.007,unitLabel:"次",source:"https://help.aliyun.com/zh/viapi/product-overview/billing-is-introduced-1",checkedAt:"2026-10-02"}],historicalUsdNote:"人民币换算系数仅用于历史美元账本。",estimateNote:"费用按人民币官方单价估算。"} },
        service: { completedWrites: 56, activeDays: 2, segmentationRequests: 2, topActions: [{ action:"POST /api/thoughts/answer", count:16 }] }
      });
    }
    if (url === "/api/state") {
      if(!window.__replayingDelayedState&&window.__failNextStateRefresh){window.__failNextStateRefresh=false;return Promise.resolve(new Response(JSON.stringify({error:"DISCOVERY_BACKEND_INTERNAL"}),{status:503,headers:{"content-type":"application/json"}}))}
      if(!window.__replayingDelayedState)window.__stateRequests += 1;
      if(!window.__replayingDelayedState&&window.__accountUser.id==="user-2"&&window.__delaySecondState)return new Promise(resolve=>{window.__releaseSecondState=()=>{window.__delaySecondState=false;window.__replayingDelayedState=true;const response=window.fetch(input,init);window.__replayingDelayedState=false;resolve(response)}});
      const empty=window.__testWorkspaceMode==="cold"||window.__lazySimulationEmpty;
      if(!window.__replayingDelayedState)window.__startupEvents.push("state:response");
      return json({
      version: 15, checkins: empty?[]:window.__checkins, dailyRecords: empty?[]:window.__dailyRecords, captures: empty?[]:window.__captures, journals: empty?[]:window.__journals, thoughts: empty?[]:window.__thoughts,
      chats: empty?[]:[{ id: "chat-1", createdAt: "2026-09-27T01:15:00.000Z", occurredAt: "2026-09-27T04:15:00.000Z", occurredOn: "2026-09-27", message: "**用户问题**", answer: "## 模型回答", reasoningContent: "PRIVATE_CHAT_REASONING" }], books: empty?[]:window.__books, journalDraft: empty?null:window.__journalDraft, keepsakes: empty?[]:window.__keepsakes.map(({originalPath,...item})=>item), quotes: empty?[]:window.__quotes, aiTasks: window.__aiTasks, notifications: window.__notifications, onboarding: window.__onboarding, onboardingV2: window.__onboardingV2,
      speech:{configured:true,defaultVoice:"zh_male_shaonianzixin_uranus_bigtts",supportedAsrMimeTypes:["audio/mp4","audio/ogg","audio/wav"],voices:[{id:"zh_male_shaonianzixin_uranus_bigtts",label:"少年梓辛 2.0",samplePath:"/assets/audio/voice-previews/zh_male_shaonianzixin_uranus_bigtts.mp3"},{id:"zh_male_m191_uranus_bigtts",label:"云舟 2.0"},{id:"zh_female_vv_uranus_bigtts",label:"Vivi 2.0"},{id:"zh_female_cancan_uranus_bigtts",label:"知性灿灿 2.0"}],assets:empty?[]:window.__speechAssets},vision:{configured:true},
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
    if (url === "/api/opening-preferences") {
      window.__openingPreferences ||= { revision: 0, enabled: true, showBrand: true, config: { density: 3.5 } };
      if (window.__accountUser?.role !== "owner") return json({ error: "仅主账户可设置", code: "OWNER_REQUIRED" }, 403);
      if (!init.method || init.method === "GET") return json(window.__openingPreferences);
      const input = JSON.parse(init.body);
      if (input.revision !== window.__openingPreferences.revision || init.headers["if-match"] !== '"opening-' + window.__openingPreferences.revision + '"') {
        return json({ error: "开场设置冲突", code: "OPENING_CONFLICT" }, 409);
      }
      window.__openingPreferences = { ...input, revision: input.revision + 1 };
      return json(window.__openingPreferences);
    }
    if (url === "/api/settings" && (!init.method || init.method === "GET")) {
      window.__startupEvents.push("settings:request");
      const respond=()=>json({
        version: 10, provider: "deepseek",
        profiles: { lite: { model: "deepseek-flash", effort: "max" }, mid: { model: "deepseek-flash", effort: "high" }, high: { model: "deepseek-v4-pro", effort: "high" }, ultra: { model: "deepseek-v4-pro", effort: "max" } },
        scenarios: { thoughtPrompt: "lite", thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high", diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra", annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid", contentImageUnderstanding: "mid", capturePolish: "mid" },
        sceneEfforts: { thoughtPrompt:"none",thoughtDraft:"high",thoughtAnswer:"max",followUpAnswer:"max",chat:"high",diaryLead:"none",diaryStructure:"high",diaryTopic:"high",diaryReflection:"max",annotationShenji:"high",analysis:"max",bookRecognition:"high",healthRecognition:"high",contentImageUnderstanding:"high",capturePolish:"high",onboardingClaimExtraction:"high" },
        assistantName: "神鸡", responseStyles: { thoughtDraft:"standard",thoughtAnswer:"standard",followUpAnswer:"standard",chat:"standard",diaryReflection:"standard",annotationShenji:"standard",analysis:"standard" },
        automaticAnswers: { thoughtAnswer: true },
        speech: { defaultVoice: "not-a-real-voice", generationRate: -10 },
        hasApiKey: true, keyHint: "tes••••test"
      });
      if(window.__delayStartupSecondary)return new Promise(resolve=>{window.__releaseStartupSecondary=()=>{window.__delayStartupSecondary=false;resolve(respond())}});
      return respond()
    }
    if(url==="/api/trash"&&(!init.method||init.method==="GET")){
      if(!window.__trashReadReady)return json({error:"Not found"},404);
      return json({items:[{id:"trash-thought-1",type:"thoughtChain",deletedAt:"2026-10-05T01:54:00.000Z",purgeAfter:"2026-11-04T01:54:00.000Z",payload:{items:[
        {item:{type:"question",content:"回收站文案不能暴露内部字段",origin:"manual",authorType:"user",disposition:"kept",occurredOn:"2026-10-05"}},
        {item:{type:"idea",content:"只展示用户能理解的内容",origin:"manual",authorType:"user",disposition:"kept",occurredOn:"2026-10-05"}}
      ]}}]})
    }
    if (url === "/api/settings" && init.method === "POST") {
      window.__settingsSaves += 1;
      const payload = JSON.parse(init.body);
      window.__lastSettingsPayload = payload;
      return json({ version: 10, provider: "deepseek", ...payload, hasApiKey: true, keyHint: "tes••••test" });
    }
    if (url === "/api/preferences" && (!init.method || init.method === "GET")) return json({version:10,assistantName:"神鸡",sceneEfforts:{thoughtPrompt:"none",thoughtDraft:"high",thoughtAnswer:"max",followUpAnswer:"max",chat:"high",diaryLead:"none",diaryStructure:"high",diaryTopic:"high",diaryReflection:"max",annotationShenji:"high",analysis:"max",bookRecognition:"high",healthRecognition:"high",contentImageUnderstanding:"high",capturePolish:"high",onboardingClaimExtraction:"high"},responseStyles:{thoughtDraft:"standard",thoughtAnswer:"standard",followUpAnswer:"standard",chat:"standard",diaryReflection:"standard",annotationShenji:"standard",analysis:"standard"},automaticAnswers:{thoughtAnswer:true},speech:{defaultVoice:"zh_male_m191_uranus_bigtts",generationRate:-10}});
    if (url === "/api/preferences" && init.method === "PATCH") {
      if(window.__reauthNextPreference){window.__reauthNextPreference=false;return json({error:"账户权限已变更，请重新登录",code:"AUTH_REAUTH_REQUIRED"},401)}
      window.__preferenceSaves+=1;window.__lastSettingsPayload=JSON.parse(init.body);return json({version:10,...window.__lastSettingsPayload})
    }
    if (url === "/api/settings/test") return json({ ok: true, reply: "连接成功" });
    if (url === "/api/speech/preview" && init.method === "POST") {
      if(window.__failSpeechPreview){window.__failSpeechPreview=false;return json({error:{message:"PREVIEW_PROVIDER_PRIVATE",code:"SPEECH_PREVIEW_FAILED"}},503)}
      window.__speechPreviewRequests.push(JSON.parse(init.body));
      return Promise.resolve(new Response(new Uint8Array([0x49,0x44,0x33]),{headers:{"content-type":"audio/mpeg"}}))
    }
    if (url === "/assets/audio/voice-previews/zh_male_shaonianzixin_uranus_bigtts.mp3") {
      window.__speechStaticPreviewRequests.push(url);
      return Promise.resolve(new Response(new Uint8Array([0x49,0x44,0x33]),{headers:{"content-type":"audio/mpeg"}}))
    }
    if (url.startsWith("/api/speech/audio?") && (!init.method || init.method === "GET")) {
      return Promise.resolve(new Response(new Uint8Array([0x49,0x44,0x33]),{headers:{"content-type":"audio/mpeg"}}))
    }
    if (url === "/api/speech/synthesize" && init.method === "POST") {
      if(window.__failSpeech){window.__failSpeech=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"PROVIDER_TIMEOUT_DEEPSEEK",code:"PROVIDER_TIMEOUT"}}),{status:503,headers:{"content-type":"application/json"}}))}
      const payload=JSON.parse(init.body);window.__speechRequests.push(payload);
      const response=()=>{
        if(payload.regenerate)window.__speechAssets=window.__speechAssets.filter(asset=>!(asset.sourceType===payload.sourceType&&asset.sourceId===payload.sourceId&&asset.sourceVersion===payload.sourceVersion));
        const serial=++window.__speechAssetSerial,asset={id:"asset-generated-"+serial,sourceType:payload.sourceType,sourceId:payload.sourceId,sourceVersion:payload.sourceVersion,voice:window.__lastSettingsPayload?.speech?.defaultVoice||"zh_male_shaonianzixin_uranus_bigtts",generationRate:window.__lastSettingsPayload?.speech?.generationRate??-10,mimeType:"audio/mpeg",bytes:3,createdAt:new Date(Date.now()+serial).toISOString(),expiresAt:"2026-11-27T07:00:00.000Z"};
        window.__speechAssets.push(asset);return new Response(new Uint8Array([0x49,0x44,0x33]),{headers:{"content-type":"audio/mpeg"}})
      };
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
      if(window.__conflictCapturePatch){window.__conflictCapturePatch=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"CAPTURE_CONFLICT_INTERNAL",code:"PRECONDITION_FAILED",details:{currentVersion:(item?.version||1)+1}},meta:{}}),{status:412,headers:{"content-type":"application/json"}}))}
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
    if (url === "/api/audio/upload" && init.method === "POST") {
      const payload=JSON.parse(init.body),key=init.headers?.["idempotency-key"]||"";window.__audioUploadKeys.push(key);
      const respond=()=>{
        if(window.__failAudioUpload){window.__failAudioUpload=false;return new Response(JSON.stringify({error:{message:"AUDIO_STORAGE_INTERNAL",code:"STORAGE_UPLOAD_FAILED"}}),{status:503,headers:{"content-type":"application/json"}})}
        return new Response(JSON.stringify({audio:{attachmentPath:"/attachments/capture-upload.webm",mimeType:"audio/webm",bytes:4,durationMs:payload.durationMs}}),{status:200,headers:{"content-type":"application/json"}})
      };
      if(window.__delayAudioUpload){window.__delayAudioUpload=false;return new Promise(resolve=>{window.__releaseAudioUpload=()=>resolve(respond())})}
      return Promise.resolve(respond())
    }
    if (url === "/api/audio/discard" && init.method === "POST") {
      const payload=JSON.parse(init.body);return json({discarded:[payload.attachmentPath],pending:0})
    }
    if (/^\\/api\\/captures\\/[^/]+\\/transcription$/.test(url) && init.method === "POST") {
      if(window.__failTranscriptionQueue){window.__failTranscriptionQueue=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"ASR_PROVIDER_PRIVATE_DETAIL",code:"ASR_PROVIDER_FAILED"}}),{status:503,headers:{"content-type":"application/json"}}))}
      const targetId=url.split("/")[3];return json({id:"task-transcription-retry",kind:"captureTranscription",targetId,status:"queued",createdAt:new Date().toISOString()})
    }
    if (url === "/api/journal-draft" && init.method === "PUT") {
      window.__journalDraftRequests += 1;
      if(window.__failJournalDraft){window.__failJournalDraft=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"JOURNAL_STORAGE_INTERNAL",code:"STORAGE_WRITE_FAILED"}}),{status:503,headers:{"content-type":"application/json"}}))}
      const payload = JSON.parse(init.body);
      const respond=()=>{
        window.__journalDraftSaves += 1;
        window.__journalDraftPayloads.push(payload);
        window.__journalDraft = { ...payload, updatedAt: "2026-09-27T09:18:19.000Z" };
        return json(window.__journalDraft);
      };
      if(window.__delayJournalDraft){window.__delayJournalDraft=false;return new Promise(resolve=>{window.__releaseJournalDraft=()=>resolve(respond())})}
      return respond();
    }
    if ((url === "/api/journals" || url === "/api/v1/journals") && init.method === "POST") {
      const respond=()=>{
        window.__journalSaves += 1;
        const payload = JSON.parse(init.body), item = { id: "journal-new-" + window.__journalSaves, createdAt: new Date().toISOString(), reflections: [], version: 1, ...payload, ...eventTime(payload) };
        window.__journals.unshift(item);
        if (!window.__journalDraft?.journalId) window.__journalDraft = null;
        return url.startsWith("/api/v1/") ? v1(item, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(item);
      };
      if(window.__delayJournalCreate){window.__delayJournalCreate=false;return new Promise(resolve=>{window.__releaseJournalCreate=()=>resolve(respond())})}
      return respond();
    }
    if (/^\\/api\\/(?:v1\\/)?journals\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const item = window.__journals.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      if(window.__conflictJournalPatch){window.__conflictJournalPatch=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"JOURNAL_CONFLICT_INTERNAL",code:"PRECONDITION_FAILED",details:{currentVersion:(item?.version||1)+1}},meta:{}}),{status:412,headers:{"content-type":"application/json"}}))}
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
      if(window.__delayJournalAssist){window.__delayJournalAssist=false;return new Promise(resolve=>{window.__releaseJournalAssist=()=>resolve(streamResponse({mode:payload.mode,content:marker+" 第一行写作锚点。\\n"+marker+" 第二行写作锚点。"}))})}
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
        return json({attachmentPath:base+".original.png",attachmentPaths:[base+".original.png",base+".source-mask.png"],originalPath:base+".original.png",alphaMaskPath:base+".source-mask.png"},201)
      }
      if(payload.purpose==="original"&&images.length){
        if(window.__failContentImageUpload){window.__failContentImageUpload=false;return Promise.resolve(new Response(JSON.stringify({error:{message:"OSS_NO_SUCH_KEY_INTERNAL",code:"STORAGE_UPLOAD_FAILED"}}),{status:503,headers:{"content-type":"application/json"}}))}
        if(document.querySelector("#view-books")?.classList.contains("active")){window.__bookUploads += 1;const attachmentPath="/attachments/cover-"+window.__bookUploads+".png";return json({attachmentPath,attachmentPaths:[attachmentPath]},201)}
        if(document.querySelector("#view-daily")?.classList.contains("active")){
          const type=document.querySelector("[data-daily-tab].active")?.dataset.dailyTab||"weight",index=++window.__healthUploads[type],extension=type==="sleep"?"jpg":"png",attachmentPath="/attachments/"+type+(type==="sleep"?"-"+index:"")+"."+extension,response=()=>json({attachmentPath,attachmentPaths:[attachmentPath]},201);
          if(window.__delayHealthUpload)return new Promise(resolve=>{window.__releaseHealthUpload=()=>{window.__delayHealthUpload=false;resolve(response())}});
          return response()
        }
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
    if (url === "/api/keepsakes/understand") {
      const payload=JSON.parse(init.body);window.__keepsakeUnderstandingRequests.push(payload);
      const response=()=>json({title:"AI 票根",tags:["候选","展览","候选"],description:"画面中可见一张带文字的票根。",requestId:payload.requestId,targetId:payload.targetId,inputVersion:payload.inputVersion});
      if(window.__delayKeepsakeUnderstanding){window.__delayKeepsakeUnderstanding=false;return new Promise(resolve=>{window.__releaseKeepsakeUnderstanding=()=>resolve(response())})}
      return response()
    }
    if (url === "/api/keepsakes/segment") return json({ cutout: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='36'%3E%3Crect width='24' height='36' fill='%23d76455'/%3E%3C/svg%3E", provider: "aliyun-segment-hd" });
    if (/^\\/api\\/keepsakes\\/[^/]+\\/original$/.test(url) && (!init.method || init.method === "GET")) {
      window.__keepsakeOriginalReads += 1;
      const item=window.__keepsakes.find(value=>value.id===url.split("/")[3]);
      return item?json({originalPath:item.originalPath}):json({error:"原图不可用"},404);
    }
    if (url === "/api/keepsakes" && init.method === "POST") {
      const payload = JSON.parse(init.body),id="keepsake-new-"+(window.__keepsakePayloads.length+1),base="/attachments/"+id,item = { id, createdAt: new Date().toISOString(), ...payload, originalPath:payload.originalPath||base+".original.png",alphaMaskPath:payload.alphaMaskPath||base+".source-mask.png",thumbPath:"",displayPath:"",editPath:"",previewPath:payload.originalPath||base+".original.png",cutoutPath:"",derivativeState:"pending",mediaVersion:1,...eventTime(payload) };
      item.media=keepsakeMedia(item);
      delete item.image;delete item.alphaMask;
      window.__lastKeepsakeCreateKey=init.headers?.["idempotency-key"]||"";window.__keepsakeCreateKeys.push(window.__lastKeepsakeCreateKey);
      if(window.__failKeepsakeCreateOnce){window.__failKeepsakeCreateOnce=false;return json({error:"小物保存暂时失败"},503)}
      window.__keepsakePayloads.push(payload);
      window.__keepsakes.unshift(item);
      const finishDerivatives=()=>{Object.assign(item,{thumbPath:base+".thumb.webp",displayPath:base+".display.webp",editPath:base+".edit.webp",alphaMaskPath:base+".alphaMask.webp",previewPath:"",derivativeState:"ready",mediaVersion:2});item.media=keepsakeMedia(item)};
      if(window.__holdKeepsakeDerivatives){window.__holdKeepsakeDerivatives=false;window.__releaseKeepsakeDerivatives=finishDerivatives}else setTimeout(finishDerivatives,20);
      const {originalPath,...visible}=item;
      return json(visible);
    }
    if (/^\\/api\\/keepsakes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const id=url.split("/").at(-1),item=window.__keepsakes.find(value=>value.id===id),payload=JSON.parse(init.body);
      if(!item)return json({error:"这件小物不存在"},404);
      window.__keepsakePatches+=1;window.__keepsakePatchPayloads.push(payload);
      Object.assign(item,payload,{updatedAt:new Date().toISOString(),version:(item.version||1)+1});
      const {originalPath,...visible}=item;
      return json(visible)
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
      return url.startsWith("/api/v1/") ? v1(book, { operation: { id: new Headers(init.headers).get("x-client-operation-id"), status: "committed" } }) : json(book);
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
      window.__quotePayloads.push(payload);
      window.__quotes.unshift(item);
      return url.startsWith("/api/v1/") ? v1(item, { operation: { id: init.headers["x-client-operation-id"], status: "committed" } }) : json(item);
    }
    if (/^\\/api\\/(?:v1\\/)?quotes\\/[^/]+$/.test(url) && init.method === "PATCH") {
      window.__quotePatches += 1;
      const item = window.__quotes.find(value => url.endsWith(value.id)), payload = JSON.parse(init.body);
      window.__quotePayloads.push(payload);
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
      const payload = JSON.parse(init.body), annotation = { id: "analysis-annotation-" + window.__annotationSaves, createdAt: "2026-09-27T03:30:00.000Z", resolved: false, replies: [], imageUnderstandings: [], version: 1, ...payload };
      window.__analyses[0].annotations.push(annotation);
      sessionStorage.setItem("ui-analysis-annotations", JSON.stringify(window.__analyses[0].annotations));
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
      if(window.__failDiscoveryStatusAction===payload.action){window.__failDiscoveryStatusAction="";return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"DISCOVERY_STATUS_INTERNAL",code:"DISCOVERY_STATUS_FAILED"},meta:{}}),{status:400,headers:{"content-type":"application/json"}}))}
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
    if (/^\\/api\\/thoughts\\/[^/]+\\/follow-ups$/.test(url) && init.method === "POST") {
      const rootId=url.split("/")[3],root=window.__thoughts.find(item=>item.id===rootId&&item.type==="question"),payload=JSON.parse(init.body),requestId=init.headers?.["idempotency-key"]||"";
      window.__followUpCreateKeys.push(requestId);
      if(window.__failFollowUpCreate){window.__failFollowUpCreate=false;return json({error:"追问保存失败"},503)}
      const duplicate=root?.followUps?.find(item=>requestId&&item.clientRequestId===requestId);
      if(duplicate)return json(duplicate);
      window.__followUpSaves+=1;
      const followUp={id:"follow-up-"+window.__followUpSaves,createdAt:new Date().toISOString(),question:payload.question,answer:payload.answer||"",origin:"manual",version:1,clientRequestId:requestId};
      root.followUps.push(followUp);root.version=(root.version||1)+1;
      return json(followUp,201)
    }
    if (/^\\/api\\/thoughts\\/[^/]+\\/follow-ups\\/[^/]+$/.test(url) && init.method === "PATCH") {
      const parts=url.split("/"),root=window.__thoughts.find(item=>item.id===parts[3]&&item.type==="question"),followUp=root?.followUps?.find(item=>item.id===parts[5]),payload=JSON.parse(init.body),kind=Object.hasOwn(payload,"question")?"edit":"manual-answer";
      if(window.__failFollowUpPatch===kind){window.__failFollowUpPatch="";return json({error:kind==="edit"?"追问编辑失败":"手写回答失败"},503)}
      window.__followUpPatches+=1;
      Object.assign(followUp,payload,{updatedAt:new Date().toISOString(),version:(followUp.version||1)+1,origin:"manual"});
      root.version=(root.version||1)+1;
      return json(followUp)
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
      if(window.__failImageTaskCreate){window.__failImageTaskCreate=false;return Promise.resolve(new Response(JSON.stringify({data:null,error:{message:"PROVIDER_TIMEOUT_DEEPSEEK",code:"PROVIDER_TIMEOUT"},meta:{}}),{status:503,headers:{"content-type":"application/json"}}))}
      return respond()
    }
    if (url === "/api/ai-tasks" && init.method === "POST") {
      const payload=JSON.parse(init.body),task={id:"task-"+(window.__aiTasks.length+1),kind:payload.kind,resourceType:payload.resourceType||(payload.kind==="annotationShenji"?"":"thought"),targetId:payload.targetId,subtargetId:payload.subtargetId||"",inputVersion:payload.inputVersion||0,subtargetVersion:payload.subtargetVersion||0,status:"queued",createdAt:new Date().toISOString()};
      const titles={thoughtAnswer:"思绪回答",followUpAnswer:"追问回答",annotationShenji:"批注神鸡",contentImageUnderstanding:"图片理解"};
      if(payload.kind==="annotationShenji"){
        window.__annotationTaskAttempts.push(payload);
        if(window.__failNextAnnotationTaskPost){window.__failNextAnnotationTaskPost=false;return json({error:"神鸡任务提交失败"},503)}
        window.__annotationTaskPayloads.push(payload)
      }
      window.__aiTasks.unshift(task);window.__notifications.unshift({id:"notification-"+task.id,taskId:task.id,resourceType:task.resourceType,targetId:task.targetId,subtargetId:task.subtargetId,kind:"aiTask",status:"queued",title:titles[task.kind],message:"已进入后台队列",createdAt:task.createdAt,updatedAt:task.createdAt,readAt:""});
      if(window.__holdAiTasks)task.status="running";
      else setTimeout(()=>window.__completeAiTask(task,payload),260);
      return json(task);
    }
    if (/^\\/api\\/ai-tasks\\/[^/]+\\/result$/.test(url) && (!init.method || init.method === "GET")) {
      const task=window.__aiTasks.find(item=>item.id===url.split("/")[3]),result=task&&window.__taskResults[task.id];
      return task&&result?json({task,result}):json({error:"任务结果不可用"},404);
    }
    if (/^\\/api\\/ai-tasks\\/[^/]+\\/retry$/.test(url) && init.method === "POST") {
      const sourceId=url.split("/")[3],source=window.__aiTasks.find(item=>item.id===sourceId);
      window.__taskRetries+=1;
      const respond=()=>{const existing=window.__aiTasks.find(item=>item.retryOf===sourceId);if(existing)return json(existing);const task={...source,id:sourceId+"-retry",status:"queued",retryOf:sourceId,createdAt:new Date().toISOString()};window.__aiTasks.unshift(task);return json(task)};
      if(window.__delayTaskRetry)return new Promise(resolve=>{window.__releaseTaskRetry=()=>resolve(respond())});
      return respond();
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
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: mockFetch });
  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const waitUntil = async (expression, attempts = 120, delay = 50) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(delay);
    }
    return false;
  };
  const unauthenticatedEventStart = cdp.events.length;
  await cdp.send("Page.navigate", { url: new URL("today?ui-unauthenticated-startup=1", APP_URL).href });
  assert.equal(
    await waitUntil(`document.documentElement?.dataset.runtimeReady==="1"&&document.querySelector("#auth-gate")?.hidden===false&&document.body?.classList.contains("auth-locked")`),
    true,
    JSON.stringify({
      message: "fresh unauthenticated startup must settle on the auth gate",
      state: await evaluate(`({ready:document.documentElement?.dataset.runtimeReady,readyState:document.readyState,authHidden:document.querySelector("#auth-gate")?.hidden,bodyClass:document.body?.className,status:document.querySelector("#auth-status")?.textContent,startupEvents:window.__startupEvents,requests:window.__apiRequests?.slice(-12),entries:performance.getEntriesByType("resource").slice(-20).map(entry=>entry.name)})`),
      exceptions: cdp.events.slice(unauthenticatedEventStart)
        .filter(event => event.method === "Runtime.exceptionThrown")
        .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text),
      failedRequests: cdp.events.slice(unauthenticatedEventStart)
        .filter(event => event.method === "Network.loadingFailed")
        .map(event => event.params.errorText)
    })
  );
  assert.deepEqual(
    cdp.events.slice(unauthenticatedEventStart)
      .filter(event => event.method === "Runtime.exceptionThrown")
      .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text),
    [],
    "fresh unauthenticated startup must not raise runtime exceptions"
  );
  assert.deepEqual(
    await evaluate(`window.__apiRequests.filter(request=>request.includes("/api/v1/actions")||request.includes("/api/v1/habits"))`),
    [],
    "fresh unauthenticated startup must not request private home data"
  );

  await evaluate(`sessionStorage.setItem("ui-delay-next-startup-secondary","1");true`);
  await cdp.send("Page.navigate", { url: new URL("thoughts/kept-root", APP_URL).href });
  const coreReady = await waitUntil(`window.__startupEvents.includes("route:response")&&window.__startupEvents.includes("startup:response")&&typeof window.__releaseStartupSecondary==="function"`);
  assert.equal(coreReady, true, JSON.stringify(await evaluate(`({
    url:location.href,
    startupEvents:window.__startupEvents,
    requests:window.__apiRequests,
    locked:document.body?.classList.contains("auth-locked"),
    gateHidden:document.querySelector("#auth-gate")?.hidden
  })`)));
  assert.deepEqual(await evaluate(`(() => {
    const events=window.__startupEvents;
    const visibleIndex=events.indexOf("shell:visible"),secondaryIndex=events.indexOf("settings:request");
    return {
      locked:document.body.classList.contains("auth-locked"),
      gateHidden:document.querySelector("#auth-gate").hidden,
      route:document.querySelector(".view.active")?.id,
      detail:Boolean(document.querySelector('#all-thoughts [data-chain-id="kept-root"]')?.open),
      secondaryPending:typeof window.__releaseStartupSecondary==="function",
      coreBeforeVisible:visibleIndex>=0&&events.indexOf("route:response")<visibleIndex&&events.indexOf("startup:response")<visibleIndex,
      visibleBeforeSecondary:visibleIndex>=0&&secondaryIndex>visibleIndex
    };
  })()`), {
    locked:false,
    gateHidden:true,
    route:"view-thoughts",
    detail:true,
    secondaryPending:true,
    coreBeforeVisible:true,
    visibleBeforeSecondary:true
  }, "fast-visible-shell: core-before-secondary");
  await evaluate(`window.__releaseStartupSecondary();true`);
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
  assert.deepEqual(
    await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`),
    [1, 1, 1, 1],
    "cold startup must reuse auth, startup, route-state and local-test results"
  );
  assert.equal(
    await evaluate(`window.__apiRequests.filter(value=>value==="GET /api/v1/onboarding-v2/session").length`),
    0,
    "cold startup must reuse the complete onboarding state"
  );
  assert.equal(await evaluate(`document.querySelector("#automatic-thought-answer").checked`),false,"hidden settings must not render during thought startup");
  await evaluate(`document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-today").classList.contains("active")`),true);
  assert.equal(await waitUntil(`document.querySelector("#actions-summary")?.textContent.includes("1 项待推进")&&document.querySelector("#actions-summary")?.textContent.includes("1/1")`), true);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.equal(await waitUntil(`getComputedStyle(document.querySelector("#view-today")).opacity==="1"`),true);
  await sleep(120);
  // home-r8-single-screen
  const homeDesktop = await evaluate(`(() => {
    const home=document.querySelector("#view-today"),grid=document.querySelector("#home-memory-grid"),backgroundElement=document.querySelector(".app-atmosphere"),background=getComputedStyle(backgroundElement,"::after"),keepsakeImage=document.querySelector(".home-v02-keepsake-preview .keepsake-image-cutout"),state=document.querySelector(".home-v02-state"),keepsake=document.querySelector(".home-v02-keepsake");
    return {
      active:home.classList.contains("active")&&home.classList.contains("home-v02"),
      memories:grid.querySelectorAll(".home-v02-memory").length,
      twoColumns:getComputedStyle(grid).gridTemplateColumns.split(" ").length===2,
      userOnly:!grid.textContent.includes("模型回答")&&!grid.textContent.includes("AI总结"),
      traceable:[...grid.querySelectorAll(".home-v02-memory")].every(item=>item.dataset.homeMemoryId&&item.querySelector("[data-home-memory-open]")),
      keepsake:Boolean(document.querySelector("[data-home-keepsake]")?.dataset.homeKeepsake),
      keepsakeOpaque:keepsakeImage&&getComputedStyle(keepsakeImage).opacity==="1",
      keepsakeCutout:document.querySelectorAll(".home-v02-keepsake-preview img").length===1,
      moodPoints:document.querySelectorAll("#home-mood-sparkline circle").length,
      voiceShortcut:Boolean(document.querySelector('#home-record-voice[aria-label="快捷语音记录"][title="快捷语音记录"][aria-haspopup="dialog"][aria-controls="capture-editor"]')),
      background:background.backgroundImage.includes("app-background-desktop"),
      backgroundFixed:getComputedStyle(backgroundElement).position==="fixed"&&Math.round(backgroundElement.getBoundingClientRect().height)===innerHeight,
      railOrder:state.getBoundingClientRect().top<keepsake.getBoundingClientRect().top,
      actionsCollapsed:!document.querySelector(".home-v02-secondary").open,
      liveStatusHidden:getComputedStyle(document.querySelector("#home-memory-status")).position==="absolute",
      singleScreen:document.documentElement.scrollHeight<=innerHeight,
      noOverflow:document.documentElement.scrollWidth<=innerWidth
    };
  })()`);
  assert.deepEqual(homeDesktop,{active:true,memories:3,twoColumns:true,userOnly:true,traceable:true,keepsake:true,keepsakeOpaque:true,keepsakeCutout:true,moodPoints:2,voiceShortcut:true,background:true,backgroundFixed:true,railOrder:true,actionsCollapsed:true,liveStatusHidden:true,singleScreen:true,noOverflow:true});
  const homeDesktopScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-desktop.png",Buffer.from(homeDesktopScreenshot.data,"base64"));
  for(const viewport of[{width:1280,height:720},{width:1280,height:600}]){
    await cdp.send("Emulation.setDeviceMetricsOverride",{...viewport,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
    await sleep(80);
    assert.deepEqual(await evaluate(`({singleScreen:document.documentElement.scrollHeight<=innerHeight,noOverflow:document.documentElement.scrollWidth<=innerWidth,actionsVisible:document.querySelector(".home-v02-secondary").getBoundingClientRect().bottom<=innerHeight})`),{singleScreen:true,noOverflow:true,actionsVisible:true},`desktop R8 viewport ${viewport.width}x${viewport.height}`)
  }
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
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
  const selectedHomeKeepsake=await evaluate(`document.querySelector("[data-home-keepsake]").dataset.homeKeepsake`);
  await evaluate(`document.querySelector('.home-v02-memory[data-home-memory-type="thought"] [data-home-memory-open]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="kept-root"]').open`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("[data-home-keepsake]")?.dataset.homeKeepsake===${JSON.stringify(selectedHomeKeepsake)}`),true);
  await evaluate(`document.querySelector("[data-home-keepsake]").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-keepsakes").classList.contains("active")&&!document.querySelector("#keepsake-detail").hidden&&document.querySelector("#keepsake-detail").dataset.keepsakeId===${JSON.stringify(selectedHomeKeepsake)}`),true);
  await evaluate(`document.querySelector("[data-keepsake-back]").click();document.querySelector('[data-view="today"]').click();true`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(120);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(document.querySelector("#home-memory-grid")).gridTemplateColumns.split(" ").length===2&&Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)===156`),true);
  const homeTabletScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-tablet.png",Buffer.from(homeTabletScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(120);
  assert.deepEqual(await evaluate(`(() => {
    const items=[...document.querySelectorAll(".home-v02-memory")],visible=items.filter(item=>getComputedStyle(item).display!=="none");
    const shuffle=document.querySelector("#home-shuffle");
    return {visible:visible.length,twoColumns:getComputedStyle(document.querySelector("#home-memory-grid")).gridTemplateColumns.split(" ").length===2,touch:[document.querySelector("#home-open-thought"),document.querySelector("#home-record-voice"),document.querySelector("#home-record-state")].every(item=>item.getBoundingClientRect().width>=44&&item.getBoundingClientRect().height>=44),shuffleSingleLine:getComputedStyle(shuffle).whiteSpace==="nowrap"&&shuffle.scrollHeight<=shuffle.clientHeight+1,singleScreen:document.documentElement.scrollHeight<=innerHeight,noOverflow:document.documentElement.scrollWidth<=innerWidth,background:getComputedStyle(document.querySelector(".app-atmosphere"),"::after").backgroundImage.includes("app-background-mobile")};
  })()`),{visible:3,twoColumns:true,touch:true,shuffleSingleLine:true,singleScreen:true,noOverflow:true,background:true});
  const homeMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-mobile.png",Buffer.from(homeMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(80);
  assert.deepEqual(await evaluate(`({singleScreen:document.documentElement.scrollHeight<=innerHeight,noOverflow:document.documentElement.scrollWidth<=innerWidth,memories:[...document.querySelectorAll(".home-v02-memory")].filter(item=>getComputedStyle(item).display!=="none").length,actionsVisible:document.querySelector(".home-v02-secondary").getBoundingClientRect().bottom<=document.querySelector(".sidebar").getBoundingClientRect().top})`),{singleScreen:true,noOverflow:true,memories:3,actionsVisible:true});
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await evaluate(`window.scrollTo({top:0,behavior:"auto"});true`);
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&[...document.querySelectorAll("#view-today button")].filter(item=>getComputedStyle(item).display!=="none").every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  const homeNarrowScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-home-v02-narrow.png",Buffer.from(homeNarrowScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector(".home-v02-secondary").open=true;true`);
  assert.equal(await waitUntil(`document.querySelector("#action-columns")?.textContent.includes("完成 G2 界面回归")&&document.querySelector("#habit-list")?.textContent.includes("每日回望")`),true);
  await evaluate(`(()=>{const form=document.querySelector("#action-form");form.elements.title.value="提交时的行动";window.__delayActionCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseActionCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#action-form").elements.title;input.value="等待期间的新行动";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseActionCreate();return true})()`);
  const actionDraftPreserved=await waitUntil(`document.querySelector("#action-status").textContent.includes("新输入已保留")`);
  assert.equal(actionDraftPreserved,true,JSON.stringify(await evaluate(`({status:document.querySelector("#action-status").textContent,value:document.querySelector("#action-form").elements.title.value,disabled:document.querySelector("#action-form button").disabled,release:typeof window.__releaseActionCreate,stateRequests:window.__stateRequests})`)));
  assert.equal(await evaluate(`document.querySelector("#action-form").elements.title.value`),"等待期间的新行动");
  await evaluate(`(()=>{const form=document.querySelector("#action-form"),input=form.elements.title;input.value="刷新失败仍已保存";input.dispatchEvent(new Event("input",{bubbles:true}));window.__failNextActionRefresh=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#action-status").textContent.includes("已保存，但行动列表刷新失败")`),true);
  await evaluate(`(()=>{const form=document.querySelector("#habit-form");form.elements.title.value="提交时的习惯";window.__delayHabitCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseHabitCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#habit-form").elements.title;input.value="等待期间的新习惯";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseHabitCreate();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#habit-status").textContent.includes("新输入已保留")`),true);
  assert.equal(await evaluate(`document.querySelector("#habit-form").elements.title.value`),"等待期间的新习惯");
  await evaluate(`document.querySelector('[data-view="feedback"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-feedback").classList.contains("active")&&!document.querySelector("#view-feedback").hasAttribute("aria-busy")`),true);
  await evaluate(`(()=>{const form=document.querySelector("#feedback-form");form.elements.feature.value="提交时功能";form.elements.body.value="提交时内容";window.__delayFeedbackCreate=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`typeof window.__releaseFeedbackCreate==="function"`),true);
  await evaluate(`(()=>{const input=document.querySelector("#feedback-form").elements.body;input.value="等待期间的新反馈";input.dispatchEvent(new Event("input",{bubbles:true}));window.__releaseFeedbackCreate();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#feedback-status").textContent.includes("新输入已保留")`),true);
  assert.equal(await evaluate(`document.querySelector("#feedback-form").elements.body.value`),"等待期间的新反馈");
  await evaluate(`document.querySelector('[data-view="export"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-export").classList.contains("active")&&!document.querySelector("#view-export").hasAttribute("aria-busy")&&document.querySelector("#export-summary").textContent.includes("快照版本 15")`),true);
  await evaluate(`document.querySelector('[data-export-format="json"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#export-status").textContent.includes("for-now-ui.json")`),true);
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
  await evaluate(`(()=>{const details=document.querySelector(".action-completion"),outcome=details.querySelector("[data-action-outcome]"),note=details.querySelector("[data-action-feedback]");details.open=true;outcome.value="mixed";note.value="冲突后仍应保留";window.__failActionCompleteConflict=true;details.querySelector("[data-action-complete]").click();return true})()`);
  if(!await waitUntil(`window.__actionListVersion>=3&&document.querySelector("#toast").textContent.includes("同步冲突")`)){
    throw new Error(await evaluate(`JSON.stringify({version:window.__actionListVersion,flag:window.__failActionCompleteConflict,toast:document.querySelector("#toast").textContent,button:Boolean(document.querySelector('[data-action-complete="ui-action"]')),draft:document.querySelector(".action-completion [data-action-feedback]")?.value||"",requests:window.__apiRequests.slice(-12)})`))
  }
  assert.deepEqual(await evaluate(`({outcome:document.querySelector(".action-completion [data-action-outcome]")?.value,note:document.querySelector(".action-completion [data-action-feedback]")?.value,open:document.querySelector(".action-completion")?.open})`),{outcome:"mixed",note:"冲突后仍应保留",open:true});
  await evaluate(`window.confirm=()=>true;window.__delayActionDelete=true;document.querySelector('[data-action-delete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#action-columns").textContent.includes("服务器新标题")`),true);
  assert.equal(await waitUntil(`typeof window.__releaseActionDelete==="function"`),true);
  await evaluate(`window.__releaseActionDelete();true`);
  assert.equal(await waitUntil(`document.querySelector("#action-columns").textContent.includes("服务器新标题")&&document.querySelector("#toast").textContent.includes("删除校验失败")`),true);
  await evaluate(`window.__failActionNetwork=true;document.querySelector('[data-action-complete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state")?.textContent==="待同步"`),true);
  assert.equal(await evaluate(`document.querySelector("#toast").textContent.includes("网络恢复后自动同步")&&!document.querySelector('[data-action-complete="ui-action"]')`),true);
  await evaluate(`document.querySelector('[data-view="review"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-review").classList.contains("active")&&document.querySelectorAll("#association-list .association-row").length===3`),true);
  const associationLimit = await evaluate(`(() => {
    const rows=[...document.querySelectorAll("#association-list .association-row")];
    return {count:rows.length,factors:rows.map(row=>row.querySelector("b").textContent),omitted:!document.querySelector("#association-list").textContent.includes("不应显示")};
  })()`);
  assert.deepEqual(associationLimit, { count: 3, factors: ["重点一","重点二","重点三"], omitted: true });
  await evaluate(`document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-today").classList.contains("active")`),true);
  const desktopNavigation = await evaluate(`(() => {
    const sidebar=document.querySelector(".sidebar"),main=document.querySelector("main"),active=document.querySelector(".nav-button.active"),style=getComputedStyle(sidebar);
    return {
      compact:Math.round(sidebar.getBoundingClientRect().width)===156&&Math.round(parseFloat(getComputedStyle(main).marginLeft))===156,
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
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`(()=>{const selectors=['.sidebar [data-section="thought"]','[data-section-links="thought"] [data-view="thoughts"]','[data-section-links="thought"] [data-view="discovery"]','[data-section-links="thought"] [data-view="journals"]'];return selectors.every(selector=>{const element=document.querySelector(selector),rect=element?.getBoundingClientRect();return Boolean(element&&element.getClientRects().length&&rect.width>=44&&rect.height>=44)})})()`),true,"mobile route targets must expose at least 44x44 CSS pixel touch areas");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.__failDiscoveryStatusAction="read";document.querySelector("#toast").hidden=true;document.querySelector("[data-discovery-open]").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="kept-root"]')?.open`),true);
  assert.equal(
    await evaluate(`!document.querySelector("#toast").hidden&&document.querySelector("#toast").classList.contains("error")&&document.querySelector("#toast").textContent.includes("原记录已打开，但回访状态更新失败")`),
    true,
    JSON.stringify(await evaluate(`({hidden:document.querySelector("#toast").hidden,className:document.querySelector("#toast").className,text:document.querySelector("#toast").textContent,failFlag:window.__failDiscoveryStatusAction})`))
  );
  await evaluate(`document.querySelector("[data-section-links='thought'] [data-view='discovery']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-discovery").classList.contains("active")&&document.querySelector("#discovery-list [data-discovery-id]")`),true);
  await evaluate(`window.__failDiscoveryStatusAction="snooze";document.querySelector("#toast").hidden=true;document.querySelector("[data-discovery-snooze]").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#toast").hidden&&document.querySelector("#toast").classList.contains("error")&&document.querySelector("#toast").textContent.includes("暂时无法安排明天再看")`),true);
  assert.equal(await evaluate(`document.querySelector("#view-discovery").classList.contains("active")&&Boolean(document.querySelector("[data-discovery-snooze]"))`),true);
  await evaluate(`document.querySelector('[data-section="seen"]').click(); true`);
  const capturesReady = await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&document.querySelectorAll("#capture-list [data-capture-id]").length===3&&document.querySelector("#capture-count").textContent==="3 条"`);
  assert.equal(
    capturesReady,
    true,
    JSON.stringify({
      state: await evaluate(`({active:document.querySelector("#view-captures").classList.contains("active"),cards:document.querySelectorAll("#capture-list [data-capture-id]").length,count:document.querySelector("#capture-count").textContent,busy:document.querySelector("#view-captures").getAttribute("aria-busy"),requests:window.__apiRequests.filter(value=>value.startsWith("GET /api/v1/route-state")).slice(-5),mode:window.__testWorkspaceMode})`),
      exceptions: cdp.events.filter(event => event.method === "Runtime.exceptionThrown").slice(-3).map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
    })
  );
  assert.deepEqual(await evaluate(`({
    activeView:document.querySelector(".view.active").id,
    primary:document.querySelector(".nav-button.active").textContent.trim(),
    secondary:[...document.querySelector("[data-section-links='seen']").querySelectorAll("button")].map(button=>button.textContent),
    selected:document.querySelector(".section-nav button.active").textContent
  })`), { activeView: "view-captures", primary: "◇所见", secondary: ["念起","书间","拾句","小物"], selected: "念起" });
  assert.equal(await evaluate(`["captures","journals","thoughts","books","keepsakes","quotes"].every(scope=>document.querySelector('[data-feed-search="'+scope+'"]'))`),true);
  await evaluate(`(()=>{const input=document.querySelector("#capture-search");input.value="职业规划";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.deepEqual(await evaluate(`({ids:[...document.querySelectorAll("#capture-list [data-capture-id]")].map(item=>item.dataset.captureId),count:document.querySelector("#capture-count").textContent})`),{ids:["capture-long"],count:"1 / 3 条"});
  await evaluate(`(()=>{const input=document.querySelector("#capture-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await evaluate(`document.querySelector('[data-view="keepsakes"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-keepsakes").classList.contains("active")&&document.querySelectorAll("#keepsake-grid [data-keepsake-id]").length===12`),true);
  await evaluate(`(()=>{const input=document.querySelector("#keepsake-search");input.value="咖啡纸袋";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.deepEqual(await evaluate(`({ids:[...document.querySelectorAll("#keepsake-grid [data-keepsake-id]")].map(item=>item.dataset.keepsakeId),count:document.querySelector("#keepsake-count").textContent})`),{ids:["keepsake-2"],count:"1 / 25 件"});
  await evaluate(`(()=>{const input=document.querySelector("#keepsake-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.deepEqual(await evaluate(`(() => {
    const grid=document.querySelector(".keepsake-grid"),card=document.querySelector(".keepsake-card"),image=card.querySelector(".keepsake-image-cutout");
    const background=card.querySelector(".keepsake-image-background");
    return {count:document.querySelectorAll(".keepsake-card").length,label:document.querySelector("#keepsake-count").textContent,display:getComputedStyle(grid).display,columns:getComputedStyle(grid).gridTemplateColumns.split(" ").length,layers:card.querySelectorAll("img").length,thumb:image.getAttribute("src")===window.__keepsakes[0].thumbPath,background:background.getAttribute("src")===window.__keepsakes[0].editPath,backgroundOpacity:getComputedStyle(background).opacity,originalReads:window.__keepsakeOriginalReads,tags:card.querySelector(".keepsake-tags").textContent,pagination:document.querySelector("#keepsake-pagination-status").textContent};
  })()`), { count: 12, label: "25 件", display:"grid", columns:3, layers: 2, thumb: true, background: true, backgroundOpacity: "0.15", originalReads: 0, tags: "#展览#同行", pagination: "已显示 12 / 25 件" });
  assert.equal(await waitUntil(`[...document.querySelectorAll(".keepsake-card img")].every(image=>image.complete&&image.naturalWidth>0)`),true);
  assert.equal(await waitUntil(`[...document.querySelectorAll(".keepsake-card-image")].every(stack=>stack.dataset.placementState)`),true);
  assert.equal(await waitUntil(`Boolean(window.__keepsakeObservers.at(-1)?.target)`),true);
  await evaluate(`window.__keepsakeObservers.at(-1).trigger();true`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-card").length===24&&document.querySelector("#keepsake-pagination-status").textContent==="已显示 24 / 25 件"`),true);
  assert.equal(await waitUntil(`Boolean(window.__keepsakeObservers.at(-1)?.target)`),true);
  await evaluate(`window.__keepsakeObservers.at(-1).trigger();true`);
  assert.equal(await waitUntil(`document.querySelectorAll(".keepsake-card").length===25&&document.querySelector("#keepsake-pagination").hidden`),true);
  await evaluate(`document.querySelector("[data-keepsake-open]").click(); true`);
  assert.deepEqual(await evaluate(`(() => {
    const detail=document.querySelector("#keepsake-detail"),image=detail.querySelector(".keepsake-detail-image");
    return {visible:!detail.hidden,libraryHidden:document.querySelector(".keepsake-library").hidden,presentation:detail.querySelector('[data-keepsake-view="presentation"]').classList.contains("active"),layers:image.querySelectorAll("img").length,backgroundOpacity:getComputedStyle(image.querySelector(".keepsake-image-background")).opacity,title:detail.querySelector("h2").textContent,tags:detail.querySelector(".keepsake-tags").textContent};
  })()`), { visible: true, libraryHidden: true, presentation: true, layers: 2, backgroundOpacity: "0.15", title: "旧展览票", tags: "#展览#同行" });
  assert.equal(await evaluate(`window.__keepsakeOriginalReads`),0);
  await sleep(220);
  const keepsakeDetailScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsake-detail-desktop.png", Buffer.from(keepsakeDetailScreenshot.data, "base64"));
  await evaluate(`document.querySelector('[data-keepsake-view="original"]').click(); true`);
  assert.deepEqual(await evaluate(`(() => { const image=document.querySelector(".keepsake-detail-image img");return {originalSelected:document.querySelector('[data-keepsake-view="original"]').classList.contains("active"),layers:document.querySelectorAll(".keepsake-detail-image img").length,original:image.getAttribute("src")===window.__keepsakes[0].originalPath,originalReads:window.__keepsakeOriginalReads}; })()`), { originalSelected: true, layers: 1, original: true, originalReads: 1 });
  await evaluate(`document.querySelector("[data-keepsake-back]").click();document.querySelector('[data-keepsake-edit="keepsake-1"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("编辑图与蒙版已载入")`),true);
  assert.deepEqual(await evaluate(`({
    visible:!document.querySelector("#keepsake-editor").hidden,
    title:document.querySelector("#keepsake-title").value,
    categoryRemoved:!document.querySelector("#keepsake-category"),
    tags:[...document.querySelectorAll("#keepsake-selected-tags>span")].map(item=>item.firstChild.textContent),
    opacity:document.querySelector("#keepsake-background-opacity").value,
    opacityLabel:document.querySelector("#keepsake-background-output").value,
    suggestions:[...document.querySelectorAll("[data-keepsake-tag-suggestion]")].map(button=>button.textContent.trim())
  })`),{visible:true,title:"旧展览票",categoryRemoved:true,tags:["展览","同行"],opacity:"15",opacityLabel:"15%",suggestions:["散步","远行","分页"]});
  await evaluate(`document.querySelector("#keepsake-title").value="取消后不应保存";document.querySelector("#keepsake-cancel-edit").click();true`);
  assert.deepEqual(await evaluate(`({patches:window.__keepsakePatches,title:window.__keepsakes.find(item=>item.id==="keepsake-1").title})`),{patches:0,title:"旧展览票"});
  await evaluate(`document.querySelector('[data-keepsake-edit="keepsake-1"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("编辑图与蒙版已载入")`),true);
  await evaluate(`(() => {
    document.querySelector("#keepsake-title").value="修订展览票";
    document.querySelector('[data-keepsake-tag-suggestion="散步"]').click();
    document.querySelector("#keepsake-tags").value+=" 展览 散步";
    const opacity=document.querySelector("#keepsake-background-opacity");
    opacity.value="22";
    opacity.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector("#keepsake-form").requestSubmit();
    return true
  })()`);
  assert.equal(await waitUntil(`window.__keepsakePatches===1&&document.querySelector('[data-keepsake-id="keepsake-1"]')?.textContent.includes("修订展览票")`),true);
  assert.deepEqual(await evaluate(`(() => {
    const payload=window.__keepsakePatchPayloads[0],item=window.__keepsakes.find(value=>value.id==="keepsake-1"),card=document.querySelector('[data-keepsake-id="keepsake-1"]'),background=card.querySelector(".keepsake-image-background");
    return{tags:payload.tags,hasCategory:Object.hasOwn(payload,"category"),opacity:payload.backgroundOpacityPct,hasMask:Object.hasOwn(payload,"alphaMask"),hasImage:Object.hasOwn(payload,"image"),sameMedia:item.originalPath==="/attachments/keepsake-1.original.png"&&item.thumbPath==="/attachments/keepsake-1.thumb.webp"&&item.displayPath==="/attachments/keepsake-1.display.webp"&&item.editPath==="/attachments/keepsake-1.edit.webp"&&item.alphaMaskPath==="/attachments/keepsake-1.alphaMask.webp",backgroundOpacity:getComputedStyle(background).opacity}
  })()`),{tags:["展览","同行","散步"],hasCategory:false,opacity:22,hasMask:false,hasImage:false,sameMedia:true,backgroundOpacity:"0.22"},"keepsake-edit-tags-opacity");
  await evaluate(`document.querySelector("#keepsake-create-toggle").click();true`);
  await evaluate(`window.__delayKeepsakeUnderstanding=true;true`);
  await evaluate(`(async()=>{const canvas=document.createElement("canvas");canvas.width=48;canvas.height=36;const ctx=canvas.getContext("2d");ctx.fillStyle="#d76455";ctx.fillRect(0,0,48,36);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const file=new File([blob],"ticket.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#keepsake-image");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-segment-status").textContent.includes("自动轮廓已生成")&&document.querySelector("#keepsake-preview-canvas").getContext("2d").getImageData(8,18,1,1).data[3]===255`), true);
  assert.equal(await evaluate(`window.__keepsakeUnderstandingRequests.length`),0);
  await evaluate(`document.querySelector("#keepsake-title").value="人工票名";document.querySelector("#keepsake-title").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#keepsake-understand").click();true`);
  assert.equal(
    await waitUntil(`typeof window.__releaseKeepsakeUnderstanding==="function"`),
    true,
    JSON.stringify(await evaluate(`({disabled:document.querySelector("#keepsake-understand").disabled,status:document.querySelector("#keepsake-understanding-status").textContent,requests:window.__keepsakeUnderstandingRequests.length,exceptions:window.__runtimeExceptions||[]})`))
  );
  await evaluate(`window.__releaseKeepsakeUnderstanding();true`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-understanding-status").textContent.includes("已填入标签、备注候选")`),true);
  const keepsakeEditorState = await evaluate(`(() => { const preview=document.querySelector("#keepsake-preview-canvas"),ctx=preview.getContext("2d"),request=window.__keepsakeUnderstandingRequests[0];return {editorVisible:!document.querySelector("#keepsake-editor").hidden,title:document.querySelector("#keepsake-title").value,tags:[...document.querySelectorAll("#keepsake-selected-tags>span")].map(item=>item.firstChild.textContent),note:document.querySelector("#keepsake-note").value,knownOnly:request.existingTags.includes("展览")&&!request.existingTags.includes("候选"),requestBound:Boolean(request.requestId&&request.targetId&&Number.isInteger(request.inputVersion)),subjectAlpha:ctx.getImageData(8,18,1,1).data[3],backgroundAlpha:ctx.getImageData(40,18,1,1).data[3],overflow:document.documentElement.scrollWidth>window.innerWidth}; })()`);
  assert.equal(keepsakeEditorState.editorVisible, true);
  assert.equal(keepsakeEditorState.title, "人工票名");
  assert.deepEqual(keepsakeEditorState.tags, ["展览"]);
  assert.equal(keepsakeEditorState.knownOnly, true);
  assert.equal(keepsakeEditorState.note, "画面中可见一张带文字的票根。");
  assert.equal(keepsakeEditorState.requestBound, true);
  assert.equal(keepsakeEditorState.subjectAlpha, 255);
  assert.ok(keepsakeEditorState.backgroundAlpha >= 37 && keepsakeEditorState.backgroundAlpha <= 39);
  assert.equal(keepsakeEditorState.overflow, false);
  const keepsakeScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-keepsakes-desktop.png", Buffer.from(keepsakeScreenshot.data, "base64"));
  const imageUploadsBeforeKeepsakeSave=await evaluate(`window.__imageUploads.length`);
  await evaluate(`window.__holdKeepsakeDerivatives=true;document.querySelector("#keepsake-title").value="新票根";document.querySelector("#keepsake-tags").value="纪念 周末 纪念";document.querySelector("#keepsake-form").requestSubmit();true`);
  if(!await waitUntil(`window.__keepsakePayloads.length===1`))throw new Error(await evaluate(`"小物保存未发出："+document.querySelector("#keepsake-save-status").textContent`));
  assert.equal(await waitUntil(`Boolean(document.querySelector('[data-keepsake-id="keepsake-new-1"]'))`),true);
  assert.deepEqual(await evaluate(`(() => {const payload=window.__keepsakePayloads[0],item=window.__keepsakes.find(value=>value.id==="keepsake-new-1"),card=document.querySelector('[data-keepsake-id="keepsake-new-1"]');return{tags:payload.tags,backgroundOpacityPct:payload.backgroundOpacityPct,uploadRequests:window.__imageUploads.length-${imageUploadsBeforeKeepsakeSave},hasRawImage:Object.hasOwn(payload,"image"),sourcePaths:["originalPath","alphaMaskPath"].every(key=>payload[key]?.startsWith("/attachments/")),pending:item.derivativeState==="pending"&&card.querySelector(".keepsake-derivative-state")?.textContent==="正在生成清晰图",noOriginalFallback:!card.querySelector("img")&&card.querySelector(".keepsake-media-placeholder")?.textContent==="正在生成",uploadKey:window.__keepsakeUploadKeys[0].length>0,createKey:Boolean(window.__lastKeepsakeCreateKey)}})()`), {tags:["展览","纪念","周末"],backgroundOpacityPct:15,uploadRequests:1,hasRawImage:false,sourcePaths:true,pending:true,noOriginalFallback:true,uploadKey:true,createKey:true});
  await evaluate(`document.querySelector("#toast").hidden=true;document.querySelector('[data-keepsake-id="keepsake-new-1"]').scrollIntoView({block:"center"});true`);
  await fs.writeFile("/tmp/growth-keepsake-pending.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await evaluate(`window.__releaseKeepsakeDerivatives();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-keepsake-id="keepsake-new-1"] .keepsake-derivative-state')&&document.querySelector('[data-keepsake-id="keepsake-new-1"] .keepsake-image-cutout')?.getAttribute("src")===window.__keepsakes.find(item=>item.id==="keepsake-new-1").thumbPath`,80,50),true);
  const savedCutoutAlpha = await evaluate(`(async()=>{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=window.__keepsakeUploadPayloads[0].alphaMask});const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);return {subject:ctx.getImageData(8,18,1,1).data[3],background:ctx.getImageData(40,18,1,1).data[3]}})()`);
  assert.equal(savedCutoutAlpha.subject, 255);
  assert.equal(savedCutoutAlpha.background, 0);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth && getComputedStyle(document.querySelector(".keepsake-grid")).gridTemplateColumns.split(" ").length===2`), true);
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
  const chatRendered = await waitUntil(`Boolean(document.querySelector(".chat-message.user strong"))`);
  assert.equal(chatRendered, true, JSON.stringify({
    history: await evaluate(`document.querySelector("#chat-history")?.innerText`),
    requests: await evaluate(`window.__apiRequests.filter(request=>request.includes("/api/v1/chats"))`),
    exceptions: cdp.events
      .filter(event => event.method === "Runtime.exceptionThrown")
      .slice(-5)
      .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
  }));
  assert.equal(await evaluate(`Boolean(document.querySelector(".chat-message.user strong")) && document.querySelector(".chat-message.agent h2")?.textContent === "模型回答" && !document.querySelector("#chat-history").textContent.includes("PRIVATE_CHAT_REASONING")`), true);
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
  assert.equal(await waitUntil(`!document.querySelector("#view-daily").inert&&!document.querySelector("#view-daily").hasAttribute("aria-busy")`),true);
  assert.equal(await evaluate(`document.querySelector("#view-daily").classList.contains("active")&&document.querySelector("#view-daily .daily-record-card h2").textContent==="日录"&&!document.querySelector("#view-daily .today-chat")&&!document.querySelector("#view-daily #today-thoughts")`), true);
  await evaluate(`(() => {
    const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0));
    window.__pasteHealthFile=name=>{const event=new Event("paste",{bubbles:true,cancelable:true});Object.defineProperty(event,"clipboardData",{value:{files:[new File([bytes],name,{type:"image/png"})]}});document.body.dispatchEvent(event)};
    window.__pasteHealthFile("sleep-overview.png");return true;
  })()`);
  assert.equal(await waitUntil(`document.querySelectorAll("#health-image-previews figure").length===1`),true);
  await evaluate(`window.__pasteHealthFile("sleep-detail.png");true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#health-image-previews figure").length===2`),true);
  const healthUpload = await evaluate(`({tabs:document.querySelectorAll("[data-daily-tab]").length,afterFirst:1,previews:document.querySelectorAll("#health-image-previews figure").length,removeButtons:document.querySelectorAll("[data-health-image-remove]").length,parseEnabled:!document.querySelector("#parse-health-images").disabled})`);
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
  assert.equal(await waitUntil(`document.querySelector("#image-viewer-status").textContent==="当前账户无权访问这张原图。原记录和其他图片没有变化。请返回可访问页面。"`),true);
  assert.equal(await evaluate(`!document.querySelector("#image-viewer-status").textContent.includes("OSS_NO_SUCH_KEY_INTERNAL")`),true);
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
  assert.equal(await waitUntil(`window.__dailySaves===2&&document.querySelector('[data-daily-record-id="daily-2"]')`),true,JSON.stringify(await evaluate(`({saves:window.__dailySaves,status:document.querySelector('[data-daily-form="weight"] .status').textContent,toast:document.querySelector("#toast").textContent,requests:window.__apiRequests.slice(-8)})`)));
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
  assert.equal(await waitUntil(`window.__dailySaves===4&&document.querySelectorAll(".weight-batch-item").length===2`),true,JSON.stringify(await evaluate(`({saves:window.__dailySaves,items:document.querySelectorAll(".weight-batch-item").length,status:document.querySelector('[data-daily-form="weight"] .status').textContent,disabled:document.querySelector('[data-daily-form="weight"] [type="submit"]').disabled})`)));
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
  const lateUploadDiscardStart=await evaluate(`window.__imageDiscards.length`);
  await evaluate(`document.querySelector('[data-daily-tab="heartRate"]').click();window.__delayHealthUpload=true;window.__releaseHealthUpload=null;window.__pasteHealth();document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseHealthUpload==="function"`),true);
  await evaluate(`document.querySelector('[data-view="together"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-together").classList.contains("active")`),true);
  await evaluate(`window.__releaseHealthUpload();true`);
  assert.equal(await waitUntil(`window.__imageDiscards.length===${lateUploadDiscardStart+1}`),true);
  await evaluate(`document.querySelector('[data-view="daily"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#view-daily").inert&&!document.querySelector("#view-daily").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-daily-tab="heartRate"]').click();true`);
  assert.deepEqual(await evaluate(`({previews:document.querySelectorAll("#health-image-previews figure").length,parseEnabled:!document.querySelector("#parse-health-images").disabled,inputEnabled:!document.querySelector("#health-images").disabled,dateEnabled:![...document.querySelectorAll("#view-daily [data-active-date]")].some(input=>input.disabled),discards:window.__imageDiscards.length})`),{previews:1,parseEnabled:true,inputEnabled:true,dateEnabled:true,discards:lateUploadDiscardStart+1});
  await evaluate(`document.querySelector("[data-health-image-remove]").click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#health-image-previews figure").length===0`),true);
  assert.equal(await evaluate(`window.__imageDiscards.length`),lateUploadDiscardStart+1);
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
  const viewThemeColors = await evaluate(`Object.fromEntries([...document.querySelectorAll(".view")].flatMap(view => { const heading=view.querySelector(".eyebrow,h1"); return heading?[[view.id,getComputedStyle(heading).color]]:[] }))`);
  assert.ok(new Set(Object.values(viewThemeColors)).size >= 16);
  const captureMediaEventStart = cdp.events.length;
  await evaluate(`document.querySelector('[data-view="captures"]').click();window.dispatchEvent(new Event("resize"));true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active") && Boolean(document.querySelector('[data-capture-id="capture-1"] strong'))`), true);
  await sleep(150);
  assert.deepEqual(
    cdp.events
      .slice(captureMediaEventStart)
      .filter(event => event.method === "Network.requestWillBeSent")
      .map(event => new URL(event.params.request.url).pathname)
      .filter(pathname => pathname.endsWith(".m4a") || pathname === "/api/speech/audio"),
    [],
    "audio-tts-playback: capture audio must transfer only after a playback click"
  );
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
  assert.deepEqual(await evaluate(`(() => {const textCard=document.querySelector('[data-capture-id="capture-1"]'),voiceCard=document.querySelector('[data-capture-id="capture-long"]'),player=voiceCard.querySelector("[data-speech-player]"),original=voiceCard.querySelector(".capture-audio-source audio"),textControls=textCard.querySelector(".speech-asset-controls");return{textPlayer:Boolean(textCard.querySelector("[data-speech-player]")),textGenerate:textControls.querySelector("[data-speech-synthesize]").textContent,controls:player.controls,connected:player.isConnected,source:player.getAttribute("src"),playerPreload:player.preload,original:original.getAttribute("src"),originalPreload:original.preload,ttsPlayers:voiceCard.querySelectorAll("[data-speech-player]").length,perCardVoice:Boolean(voiceCard.querySelector("[data-capture-voice]")),repeatedGenerationSetting:Boolean(voiceCard.querySelector("#tts-generation-rate,.speech-generation-default"))}})()`), {
    textPlayer: false,
    textGenerate: "生成",
    controls: true,
    connected: true,
    source: "/api/speech/audio?id=asset-capture-long-v1",
    playerPreload: "none",
    original: "/attachments/capture-voice.m4a",
    originalPreload: "none",
    ttsPlayers: 1,
    perCardVoice: false,
    repeatedGenerationSetting: false
  }, "audio-tts-playback: persisted speech assets must render directly without synthesizing");
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-long"] .capture-transcription.polished')?.classList.contains("is-collapsible")&&document.querySelector('[data-capture-id="capture-long"] .capture-transcription.condensed')?.classList.contains("is-collapsible")`),true);
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-long"]'),source=card.querySelector(".capture-audio-source"),controls=card.querySelector(".speech-asset-controls"),rate=controls.querySelector("[data-speech-playback-rate]"),raw=card.querySelector(".capture-transcription-raw"),polished=card.querySelector(".capture-transcription.polished"),condensed=card.querySelector(".capture-transcription.condensed");return{audioReady:source.querySelector(".capture-audio-playback-state").textContent,audioKey:source.dataset.captureAudioKey,status:Boolean(card.querySelector(".capture-transcription-state")),sourceType:controls.dataset.speechSourceType,sourceId:controls.dataset.speechSourceId,sourceVersion:controls.dataset.speechSourceVersion,generateLabel:controls.querySelector("[data-speech-synthesize]").textContent,regenerate:controls.querySelector("[data-speech-synthesize]").dataset.speechRegenerate,rate:rate.value,rates:[...rate.options].map(option=>Number(option.value)),rawOpen:raw.open,rawMarkdown:Boolean(raw.querySelector("strong")),rawHtml:Boolean(raw.querySelector("em")),rawLiteral:raw.textContent.includes("**原始重点**")&&raw.textContent.includes("<em>原始 HTML</em>"),rawBreaks:raw.querySelectorAll("br").length,polishedLines:polished.dataset.speechTextLines,polishedCollapsed:polished.classList.contains("is-collapsible")&&!polished.classList.contains("is-expanded"),polishedMarkdown:Boolean(polished.querySelector("strong")),condensedLines:condensed.dataset.speechTextLines,condensedCollapsed:condensed.classList.contains("is-collapsible")&&!condensed.classList.contains("is-expanded"),condensedMarkdown:Boolean(condensed.querySelector("strong"))}})()`), {
    audioReady: "原音可播放",
    audioKey: '["capture-long",1,"/attachments/capture-voice.m4a"]',
    status: false,
    sourceType: "capture",
    sourceId: "capture-long",
    sourceVersion: "1",
    generateLabel: "重新生成",
    regenerate: "true",
    rate: "1",
    rates: [0.5,0.7,0.8,0.9,1,1.1,1.2,1.3,1.5,2],
    rawOpen: false,
    rawMarkdown: false,
    rawHtml: false,
    rawLiteral: true,
    rawBreaks: 4,
    polishedLines: "2",
    polishedCollapsed: true,
    polishedMarkdown: true,
    condensedLines: "6",
    condensedCollapsed: true,
    condensedMarkdown: true
  });
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] .capture-transcription.polished [data-speech-text-expand]').click();true`);
  assert.deepEqual(await evaluate(`(() => {const layer=document.querySelector('[data-capture-id="capture-long"] .capture-transcription.polished'),button=layer.querySelector("[data-speech-text-expand]");return{expanded:layer.classList.contains("is-expanded"),aria:button.getAttribute("aria-expanded"),label:button.getAttribute("aria-label")}})()`),{expanded:true,aria:"true",label:"收起AI 整理稿"});
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-failed"]'),source=card.querySelector(".capture-audio-source"),status=card.querySelector(".capture-transcription-state");return{audio:card.querySelector("audio")?.getAttribute("src"),audioReady:source?.querySelector(".capture-audio-playback-state")?.textContent,audioKey:source?.dataset.captureAudioKey||"",status:status?.textContent,taskId:status?.dataset.transcriptionTaskId||"",misreported:status?.textContent.includes("转写未完成")}})()`),{
    audio:"/attachments/capture-failed.m4a",
    audioReady:"原音可播放",
    audioKey:'["capture-failed",1,"/attachments/capture-failed.m4a"]',
    status:"转写暂时失败。原音已保留，可以再次尝试。重试",
    taskId:"task-capture-failed",
    misreported:false
  });
  await evaluate(`window.__failTranscriptionQueue=true;document.querySelector('[data-capture-id="capture-failed"] [data-capture-transcribe]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#toast").textContent==="语音转写排队暂时失败。原音已经保存。请稍后重试。"`),true);
  assert.deepEqual(await evaluate(`({enabled:!document.querySelector('[data-capture-id="capture-failed"] [data-capture-transcribe]').disabled,original:document.querySelector('[data-capture-id="capture-failed"] .capture-audio-playback-state').textContent,sentinel:document.body.textContent.includes("ASR_PROVIDER_PRIVATE_DETAIL")})`),{enabled:true,original:"原音可播放",sentinel:false});
  await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-long"]'),rate=card.querySelector("[data-speech-playback-rate]"),player=card.querySelector("[data-speech-player]");rate.value="1.5";rate.dispatchEvent(new Event("change",{bubbles:true}));window.__rejectNextSpeechPlay=true;player.play().catch(()=>{});return true})()`);
  assert.equal(await waitUntil(`window.__speechPlays.length===1`),true);
  assert.deepEqual(await evaluate(`({rate:window.__speechPlays[0].rate,rejected:window.__speechPlays[0].rejected,requests:window.__speechRequests.length,network:window.__speechPlays[0].src.includes("/api/speech/audio?")})`),{rate:1.5,rejected:true,requests:0,network:true});
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-speech-player]').play();true`);
  assert.equal(await waitUntil(`window.__speechPlays.length===2`),true);
  await evaluate(`window.__failSpeech=true;document.querySelector('[data-capture-id="capture-long"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-long"] .speech-asset-status').textContent.includes("文字朗读生成暂时失败")`),true);
  assert.equal(await evaluate(`!document.body.textContent.includes("PROVIDER_TIMEOUT_DEEPSEEK")&&window.__speechRequests.length===0`),true);
  await evaluate(`window.__delaySpeech=true;document.querySelector('[data-capture-id="capture-long"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseSpeech==="function"&&window.__speechRequests.length===1`),true);
  assert.deepEqual(await evaluate(`window.__speechRequests[0]`), {
    sourceType: "capture",
    sourceId: "capture-long",
    sourceVersion: 1,
    regenerate: true
  });
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-edit]').click();document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__captures.find(item=>item.id==="capture-long").version===2&&document.querySelector("#capture-id").value===""`),true);
  await evaluate(`window.__capturePatchPayloads=[];window.__releaseSpeech();true`);
  assert.equal(await waitUntil(`window.__apiRequests.filter(value=>value.startsWith("GET /api/v1/route-state")).length>1&&!document.querySelector('[data-capture-id="capture-long"] [data-speech-player]')&&document.querySelector('[data-capture-id="capture-long"] [data-speech-synthesize]').textContent==="生成"`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`window.__speechRequests.length===2&&document.querySelector('[data-capture-id="capture-long"] [data-speech-player]')`),true);
  assert.deepEqual(await evaluate(`window.__speechRequests[1]`),{sourceType:"capture",sourceId:"capture-long",sourceVersion:2,regenerate:false},"playback rate and voice must not enter the synthesis request");
  await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-long"]'),rate=card.querySelector("[data-speech-playback-rate]"),player=card.querySelector("[data-speech-player]");rate.value="2";rate.dispatchEvent(new Event("change",{bubbles:true}));player.play();window.__activeCaptureSpeechUrl=player.getAttribute("src");return true})()`);
  assert.equal(await waitUntil(`window.__speechPlays.length===3`),true);
  assert.deepEqual(await evaluate(`({rate:window.__speechPlays.at(-1).rate,requests:window.__speechRequests.length})`),{rate:2,requests:2});
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`window.__speechRequests.length===3&&document.querySelector('[data-capture-id="capture-1"] [data-speech-player]')`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-speech-player]').play();true`);
  assert.equal(await waitUntil(`window.__speechPlays.length===4`),true);
  assert.deepEqual(await evaluate(`(() => {const old=document.querySelector('[data-capture-id="capture-long"] [data-speech-player]'),next=document.querySelector('[data-capture-id="capture-1"] [data-speech-player]'),assetId=new URL(old.src).searchParams.get("id");return{oldPaused:old.paused,oldSourceRetained:old.getAttribute("src")===window.__activeCaptureSpeechUrl,newPaused:next.paused,oldPauseRecorded:window.__speechPauses.some(url=>url.includes("id="+assetId)),requests:window.__speechRequests.length}})()`),{oldPaused:true,oldSourceRetained:true,newPaused:false,oldPauseRecorded:true,requests:3},"starting another asset must pause the previous player without detaching either persisted source");
  assert.equal(await evaluate(`document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-form").hidden&&document.querySelector("#capture-create-toggle").getAttribute("aria-expanded")==="false"`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();window.__failMicrophonePermission=true;document.querySelector("#home-record-voice").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-audio-status").textContent.includes("麦克风权限未开启")`),true);
  assert.deepEqual(await evaluate(`({path:location.pathname,requests:window.__microphoneRequests,recorderOpen:document.querySelector("#capture-audio-recorder").open,privateError:document.body.textContent.includes("MIC_DEVICE_INTERNAL")})`),{path:"/seen/captures",requests:1,recorderOpen:true,privateError:false});
  await evaluate(`document.querySelector("#capture-editor-close").click();document.querySelector('[data-view="today"]').click();window.__delayMicrophonePermission=true;document.querySelector("#home-record-voice").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseMicrophonePermission==="function"&&document.querySelector("#capture-audio-status").textContent==="正在请求麦克风权限…"`),true);
  await evaluate(`document.querySelector("#capture-editor-close").click();window.__releaseMicrophonePermission();true`);
  assert.equal(await waitUntil(`window.__microphoneTrackStops===1&&!document.querySelector("#capture-audio-record").disabled`),true);
  assert.deepEqual(await evaluate(`({editorHidden:document.querySelector("#capture-editor").hidden,recording:Boolean(document.querySelector("#capture-audio-status").textContent.includes("正在录音"))})`),{editorHidden:true,recording:false});
  await evaluate(`document.querySelector('[data-view="today"]').click();document.querySelector("#home-record-voice").click();document.querySelector("#home-record-voice").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("正在录音")`),true);
  assert.deepEqual(await evaluate(`({path:location.pathname,requests:window.__microphoneRequests,editorVisible:!document.querySelector("#capture-editor").hidden,recorder:document.querySelector("#capture-audio-record").hidden})`),{path:"/seen/captures",requests:3,editorVisible:true,recorder:true});
  await evaluate(`document.querySelector("#capture-audio-remove").click();document.querySelector("#capture-editor-close").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden`),true);
  await evaluate(`document.querySelector("#capture-create-toggle").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-form").getAttribute("hidden")===null&&document.activeElement===document.querySelector("#capture-content")`),true);
  const captureWritesBeforeClose=await evaluate(`window.__captureSaves`);
  await evaluate(`document.querySelector("#capture-content").value="关闭后保留的念起";document.querySelector("#capture-content").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#capture-editor-close").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden&&document.activeElement===document.querySelector("#capture-create-toggle")`),true);
  assert.deepEqual(await evaluate(`({hidden:document.querySelector("#capture-editor").hidden,value:document.querySelector("#capture-content").value,writes:window.__captureSaves,focus:document.activeElement===document.querySelector("#capture-create-toggle")})`),{hidden:true,value:"关闭后保留的念起",writes:captureWritesBeforeClose,focus:true});
  await evaluate(`document.querySelector("#capture-create-toggle").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-content").value==="关闭后保留的念起"&&document.activeElement===document.querySelector("#capture-content")`),true);
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden&&document.activeElement===document.querySelector("#capture-create-toggle")`),true);
  assert.deepEqual(await evaluate(`({hidden:document.querySelector("#capture-editor").hidden,value:document.querySelector("#capture-content").value,writes:window.__captureSaves,focus:document.activeElement===document.querySelector("#capture-create-toggle")})`),{hidden:true,value:"关闭后保留的念起",writes:captureWritesBeforeClose,focus:true});
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-id").value==="capture-1"&&document.querySelector("#capture-content").value.includes("这个念头")`),true);
  await evaluate(`document.querySelector("#capture-content").value="不应覆盖新建草稿";document.querySelector("#capture-content").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#capture-cancel").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden&&document.activeElement===document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]')`),true);
  assert.deepEqual(await evaluate(`({hidden:document.querySelector("#capture-editor").hidden,id:document.querySelector("#capture-id").value,value:document.querySelector("#capture-content").value,focus:document.activeElement===document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]')})`),{hidden:true,id:"",value:"关闭后保留的念起",focus:true});
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-id").value==="capture-1"`),true);
  await evaluate(`(()=>{
    document.querySelector("#capture-content").value="不应残留的编辑内容";
    document.querySelector('[data-view="thoughts"]').click();
    return true
  })()`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&!document.querySelector("#view-thoughts").inert&&!document.querySelector("#view-thoughts").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#view-captures").inert&&!document.querySelector("#view-captures").hasAttribute("aria-busy")&&document.querySelector('[data-capture-id="capture-1"]')`),true);
  await evaluate(`document.querySelector("#capture-create-toggle").click();true`);
  assert.equal(
    await waitUntil(`!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-id").value===""&&document.querySelector("#capture-content").value==="关闭后保留的念起"`),
    true,
    JSON.stringify(await evaluate(`({view:document.querySelector(".view.active")?.id,capturesBusy:document.querySelector("#view-captures").getAttribute("aria-busy"),capturesInert:document.querySelector("#view-captures").inert,editorHidden:document.querySelector("#capture-editor").hidden,id:document.querySelector("#capture-id").value,content:document.querySelector("#capture-content").value})`))
  );
  await sleep(80);
  assert.equal(await evaluate(`!document.querySelector("#capture-editor").hidden&&document.querySelector("#capture-id").value===""`),true);
  await evaluate(`document.querySelector("#capture-editor-close").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden`),true);
  await evaluate(`document.querySelector("#capture-create-toggle").click();true`);
  await evaluate(`document.querySelector("#capture-content").value="";document.querySelector("#capture-content").dispatchEvent(new Event("input",{bubbles:true}));true`);
  for(const width of[320,390]){
    await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:1,mobile:true});await sleep(80);
    const captureEditorLayout=await evaluate(`(()=>{const editor=document.querySelector("#capture-editor .capture-editor").getBoundingClientRect(),submit=document.querySelector("#capture-submit").getBoundingClientRect(),nav=document.querySelector(".sidebar").getBoundingClientRect();return{noOverflow:document.documentElement.scrollWidth<=innerWidth,editorInside:editor.left>=0&&editor.right<=innerWidth,submitHeight:Math.round(submit.height),submitAboveNav:submit.bottom<=nav.top,recorderOpen:document.querySelector("#capture-audio-recorder").open}})()`);
    assert.deepEqual(captureEditorLayout,{noOverflow:true,editorInside:true,submitHeight:44,submitAboveNav:true,recorderOpen:false},`${width}px capture editor`);
  }
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  assert.deepEqual(await evaluate(`(() => {const editor=document.querySelector(".capture-audio-editor"),upload=editor.querySelector(".audio-file-primary"),recorder=editor.querySelector("#capture-audio-recorder"),record=editor.querySelector("#capture-audio-record"),preview=editor.querySelector("#capture-audio-preview");return{fits:editor.getBoundingClientRect().right<=window.innerWidth,uploadText:upload.textContent.trim(),uploadHeight:Math.round(upload.getBoundingClientRect().height),recorderOpen:recorder.open,summary:recorder.querySelector("summary").textContent.replace(/\\s+/g," ").trim(),recordCollapsed:record.getClientRects().length===0,previewCollapsed:preview.getClientRects().length===0}})()`), {
    fits: true,
    uploadText: "↑上传音频",
    uploadHeight: 44,
    recorderOpen: false,
    summary: "现场录音",
    recordCollapsed: true,
    previewCollapsed: true
  });
  await evaluate(`document.querySelector("#capture-audio-recorder summary").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-recorder").open&&document.querySelector("#capture-audio-record").getBoundingClientRect().height>=44`),true);
  await evaluate(`window.__failMicrophonePermission=true;document.querySelector("#capture-audio-record").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent==="麦克风权限未开启。当前捕念正文和原有录音没有变化。请开启权限，或改为上传音频。"`),true);
  assert.equal(await evaluate(`!document.body.textContent.includes("MIC_DEVICE_INTERNAL")`),true);
  await evaluate(`document.querySelector("#capture-audio-record").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("正在录音")`),true);
  await evaluate(`window.__advanceNow(320);document.querySelector("#capture-editor-close").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-editor").hidden&&new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture-audio");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.audio?.blob?.size>0)}})`),true);
  await evaluate(`document.querySelector("#capture-create-toggle").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#capture-audio-preview").hidden`),true);
  await evaluate(`document.querySelector("#capture-audio-remove").click();document.querySelector("#capture-audio-record").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("正在录音")`),true);
  await evaluate(`document.querySelector("#capture-audio-pause").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("录音已暂停")`),true);
  await evaluate(`document.querySelector("#capture-audio-pause").click();window.__advanceNow(320);document.querySelector("#capture-audio-stop").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent.includes("录音已保存在本机")&&!document.querySelector("#capture-audio-preview").hidden`),true);
  await evaluate(`document.querySelector("#capture-content").value="带语音的捕念草稿";window.__delayAudioUpload=true;window.__failAudioUpload=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`typeof window.__releaseAudioUpload==="function"`),true);
  assert.deepEqual(await evaluate(`(()=>{const remove=document.querySelector("#capture-audio-remove"),file=document.querySelector("#capture-audio-file"),record=document.querySelector("#capture-audio-record"),preview=document.querySelector("#capture-audio-preview");remove.click();return{removeDisabled:remove.disabled,fileDisabled:file.disabled,recordDisabled:record.disabled,previewVisible:!preview.hidden}})()`),{removeDisabled:true,fileDisabled:true,recordDisabled:true,previewVisible:true});
  await evaluate(`window.__releaseAudioUpload();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-status").textContent==="捕念语音上传暂时失败。原音草稿仍保存在本机。请稍后重试。"&&document.querySelector("#capture-status").textContent==="捕念语音上传暂时失败。捕念草稿和待提交语音仍保存在当前页面。请稍后重试。"&&!document.querySelector("#capture-audio-remove").disabled`),true);
  assert.deepEqual(await evaluate(`({captureStatus:document.querySelector("#capture-status").textContent,audioVisible:!document.querySelector("#capture-audio-preview").hidden,removeEnabled:!document.querySelector("#capture-audio-remove").disabled,sentinel:document.body.textContent.includes("AUDIO_STORAGE_INTERNAL"),keys:window.__audioUploadKeys.length})`),{captureStatus:"捕念语音上传暂时失败。捕念草稿和待提交语音仍保存在当前页面。请稍后重试。",audioVisible:true,removeEnabled:true,sentinel:false,keys:1});
  assert.deepEqual(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(null);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture-audio");request.onerror=()=>resolve(null);request.onsuccess=()=>resolve({lastError:request.result?.audio?.lastError||"",uploadRequestId:request.result?.audio?.uploadRequestId||""})}})`),{lastError:"捕念语音上传暂时失败。原音草稿仍保存在本机。请稍后重试。",uploadRequestId:await evaluate(`window.__audioUploadKeys[0]`)});
  await evaluate(`window.__failAudioUpload=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__audioUploadKeys.length===2&&document.querySelector("#capture-status").textContent==="捕念语音上传暂时失败。捕念草稿和待提交语音仍保存在当前页面。请稍后重试。"&&!document.querySelector("#capture-audio-remove").disabled`),true);
  assert.equal(await evaluate(`window.__audioUploadKeys[0]===window.__audioUploadKeys[1]&&window.__audioUploadKeys[0].length>0`),true);
  await evaluate(`document.querySelector("#capture-audio-remove").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-audio-preview").hidden&&document.querySelector("#capture-audio-preview").getClientRects().length===0`),true);
  await evaluate(`document.querySelector("#capture-cancel").click();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').hidden`), true);
  assert.equal(await waitUntil(`!document.querySelector('[data-capture-id="capture-1"] [data-capture-expand]').hidden`), true);
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
  assert.equal(await waitUntil(`(() => { const card=document.querySelector('[data-capture-id="capture-long"]'),item=card.querySelector(".capture-item"),viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"); return viewport.clientHeight>${collapsedCaptureHeight}&&item.classList.contains("is-expanded")&&button.getAttribute("aria-expanded")==="true"&&button.textContent.trim()==="⌄"; })()`), true);
  await evaluate(`(()=>{const input=document.querySelector("#capture-search");input.value="职业规划";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-long"] .capture-item')?.classList.contains("is-expanded")`),true,"capture expansion survives a feed refresh");
  await evaluate(`(()=>{const input=document.querySelector("#capture-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-long"] .capture-item')?.classList.contains("is-expanded")`),true,"capture expansion survives restoring the feed");
  await evaluate(`document.querySelector('[data-capture-id="capture-long"] [data-capture-expand]').click(); true`);
  assert.equal(await evaluate(`!document.querySelector('[data-capture-id="capture-long"] .capture-item').classList.contains("is-expanded")`), true);
  await evaluate(`document.querySelector("#capture-content").value = "快捷收下的新捕念"; const input = document.querySelector("#capture-tags"); input.value = "测试"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); true`);
  assert.equal(await evaluate(`document.querySelector("#capture-tag-list .tag-chip")?.textContent.includes("测试")`), true);
  assert.deepEqual(await evaluate(`(() => {const input=document.querySelector("#capture-content"),event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});input.dispatchEvent(event);return{prevented:event.defaultPrevented,saves:window.__captureSaves}})()`),{prevented:false,saves:0});
  await evaluate(`window.__delayCaptureCreate=true;document.querySelector("#capture-content").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));true`);
  assert.equal(await waitUntil(`typeof window.__releaseCaptureCreate==="function"&&document.querySelector(".capture-timeline-entry.is-syncing")?.textContent.includes("快捷收下的新捕念")`), true);
  assert.deepEqual(await evaluate(`({saves:window.__captureSaves,status:["待同步","正在同步"].includes(document.querySelector(".capture-sync-state")?.textContent),form:document.querySelector("#capture-content").value})`), {saves:0,status:true,form:"快捷收下的新捕念"});
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&!document.querySelector("#view-thoughts").inert`),true);
  await evaluate(`window.__failNextStateRefresh=true;window.__releaseCaptureCreate();true`);
  assert.equal(await waitUntil(`window.__captureSaves === 1`), true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-new-1"]')&&document.querySelector("#capture-id").value===""&&document.querySelector("#capture-content").value===""`), true);
  assert.equal(
    await waitUntil(`document.querySelector("#toast").textContent==="捕念列表刷新暂时失败。刚才的捕念已经保存。请稍后重试。"`),
    true,
    JSON.stringify(await evaluate(`({toast:document.querySelector("#toast").textContent,hidden:document.querySelector("#toast").hidden,requests:window.__apiRequests.slice(-12)})`))
  );
  assert.equal(await evaluate(`!document.querySelector("#toast").textContent.includes("DISCOVERY_BACKEND_INTERNAL")`),true);
  const capturePayload = await evaluate(`window.__capturePayloads[0]`);
  assert.deepEqual(capturePayload.tags, ["测试"]);
  assert.equal(capturePayload.timeMode, "now");
  assert.equal(Object.hasOwn(capturePayload, "occurredAt"), false);
  assert.equal(Object.hasOwn(capturePayload, "occurredOn"), false);
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"capture-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#capture-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#capture-content").value="";return true})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length`),1);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.items?.[0]?.blob?.size>0)}})`),true);
  assert.deepEqual(await evaluate(`(async()=>{const preview=document.querySelector('[data-content-image-editor="capture"] .content-image-preview img').src,invalid=new File(["not-image"],"private.txt",{type:"text/plain"}),transfer=new DataTransfer();transfer.items.add(invalid);const input=document.querySelector("#capture-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20));return{status:document.querySelector("#capture-status").textContent,previewAlive:await fetch(preview).then(response=>response.ok).catch(()=>false),previews:document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length}})()`),{status:"只支持 PNG、JPEG 或 WebP 图片。已经选择的图片没有变化。请修改后重试。",previewAlive:true,previews:1});
  await evaluate(`window.__failContentImageUpload=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-status").textContent.includes("捕念草稿和待上传图片仍保存在当前页面")`),true);
  assert.deepEqual(await evaluate(`({sentinel:document.querySelector("#capture-status").textContent.includes("OSS_NO_SUCH_KEY_INTERNAL"),previews:document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length,content:document.querySelector("#capture-content").value})`),{sentinel:false,previews:1,content:""});
  await evaluate(`document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__captureSaves===2&&document.querySelector('[data-capture-id="capture-new-2"] [data-content-image-understand="capture"]')`),true);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(!request.result)}})`),true);
  assert.deepEqual(await evaluate(`({content:window.__capturePayloads[1].content,paths:window.__capturePayloads[1].attachmentPaths,images:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals img').length,viewerButtons:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals button[data-image-viewer-path]').length,externalLinks:document.querySelectorAll('[data-capture-id="capture-new-2"] .content-originals a[target="_blank"]').length})`),{content:"",paths:["/attachments/content-1.png"],images:1,viewerButtons:1,externalLinks:0});
  await evaluate(`window.__failImageTaskCreate=true;document.querySelector('[data-capture-id="capture-new-2"] [data-content-image-understand="capture"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-new-2"] .content-image-task-status').textContent==="图片理解排队暂时失败。原图和已有记录已经保存。请稍后重试。"`),true);
  assert.deepEqual(await evaluate(`({enabled:!document.querySelector('[data-capture-id="capture-new-2"] [data-content-image-understand="capture"]').disabled,statusSentinel:document.querySelector('[data-capture-id="capture-new-2"] .content-image-task-status').textContent.includes("PROVIDER_TIMEOUT_DEEPSEEK"),toastSentinel:document.querySelector("#toast").textContent.includes("PROVIDER_TIMEOUT_DEEPSEEK")})`),{enabled:true,statusSentinel:false,toastSentinel:false});
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
  await evaluate(`(()=>{document.querySelector("#capture-create-toggle").click();document.querySelector("#capture-content").value="编辑已有记录后仍保留";const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),transfer=new DataTransfer();transfer.items.add(new File([bytes],"suspended-capture.png",{type:"image/png"}));const input=document.querySelector("#capture-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===1`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-edit]').click(); true`);
  const captureEditState = await evaluate(`({ datetime: document.querySelector("#capture-date").value, tags: [...document.querySelectorAll("#capture-tag-list .tag-chip")].map(item => item.textContent.trim()) })`);
  assert.equal(captureEditState.datetime, "2026-09-27T15:08:09");
  assert.equal(captureEditState.tags.length, 2);
  await evaluate(`document.querySelector("#capture-date").value = "2026-09-27T23:45:12"; document.querySelector("#capture-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__capturePatchPayloads.length === 1`), true);
  assert.equal(
    await waitUntil(`document.querySelector("#capture-id").value===""&&document.querySelector("#capture-content").value==="编辑已有记录后仍保留"&&document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length===1&&new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.items?.[0]?.name==="suspended-capture.png")}})`),
    true,
    JSON.stringify(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve({openError:true});opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:capture");request.onerror=()=>resolve({readError:true});request.onsuccess=()=>resolve({id:document.querySelector("#capture-id").value,content:document.querySelector("#capture-content").value,previews:document.querySelectorAll('[data-content-image-editor="capture"] .content-image-preview').length,storedName:request.result?.items?.[0]?.name||"",status:document.querySelector("#capture-status").textContent,exceptions:window.__runtimeExceptions||[]})}})`))
  );
  assert.equal((await evaluate(`window.__capturePatchPayloads[0].occurredAt`)), "2026-09-27T23:45:12");
  assert.equal((await evaluate(`window.__capturePatchPayloads[0].timeMode`)), "manual");
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="在途修改仍可见";window.__delayCapturePatch=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`typeof window.__releaseCapturePatch==="function"&&document.querySelector('[data-capture-id="capture-new-1"].is-syncing')?.textContent.includes("在途修改仍可见")`),true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] .capture-sync-state').textContent`),"待同步");
  await evaluate(`window.__releaseCapturePatch();true`);
  assert.equal(await waitUntil(`window.__capturePatchPayloads.length===2&&!document.querySelector('[data-capture-id="capture-new-1"]').classList.contains("is-syncing")&&document.querySelector("#capture-create-toggle")?.disabled===false&&document.querySelector("#capture-id")?.value===""`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="响应丢失但已提交";window.__loseCapturePatchResponse=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__receiptLookups>=1&&window.__capturePatchPayloads.length===3&&document.querySelector('[data-capture-id="capture-new-1"]')?.textContent.includes("响应丢失但已提交")&&!document.querySelector('[data-capture-id="capture-new-1"]').classList.contains("is-syncing")`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-new-1"] [data-capture-edit]').click();document.querySelector("#capture-content").value="冲突内容不应留下";window.__conflictCapturePatch=true;window.__failNextStateRefresh=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-status").textContent==="这条捕念在其他位置已经变化。当前表单内容仍保留，已有记录没有被覆盖。请重新读取后核对两端内容。"`),true);
  assert.deepEqual(await evaluate(`({server:window.__captures.find(item=>item.id==="capture-new-1").content,restored:document.querySelector('[data-capture-id="capture-new-1"]').textContent.includes("响应丢失但已提交")&&!document.querySelector('[data-capture-id="capture-new-1"]').textContent.includes("冲突内容不应留下"),editing:document.querySelector("#capture-content").value,sentinel:document.querySelector("#capture-status").textContent.includes("CAPTURE_CONFLICT_INTERNAL")})`),{server:"响应丢失但已提交",restored:true,editing:"冲突内容不应留下",sentinel:false});
  await evaluate(`document.querySelector("#capture-content").value="离线修改待同步";window.__failCapturePatchNetwork=true;document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-new-1"].is-syncing')?.textContent.includes("离线修改待同步")&&document.querySelector('[data-capture-id="capture-new-1"] .capture-sync-state.pending')`),true);
  const captureScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures.png", Buffer.from(captureScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#capture-date").getBoundingClientRect().right <= window.innerWidth`), true);
  assert.equal(await evaluate(`(() => { const card=document.querySelector('[data-capture-id="capture-1"]'),date=card.querySelector(".capture-date").getBoundingClientRect(),meta=card.querySelector(".capture-meta").getBoundingClientRect(),time=card.querySelector(".capture-entry-time").getBoundingClientRect(); return date.bottom<=meta.top+1&&meta.left<=time.left&&time.right<=meta.right+1; })()`), true);
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll('[data-capture-id="capture-long"] .capture-actions button')].map(item=>item.getBoundingClientRect()); return buttons.every(item=>item.width>=44&&item.height>=44)&&buttons[0].bottom<=buttons[1].top+1&&Math.abs(buttons[1].top-buttons[2].top)<2&&buttons[2].bottom-buttons[0].top<=90; })()`), true);
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`window.__speechRequests.length===4&&document.querySelector('[data-capture-id="capture-1"] [data-speech-player]')`),true);
  await sleep(100);
  await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-1"]'),expand=card.querySelector("[data-capture-expand]");if(!expand.hidden&&!card.querySelector(".capture-item").classList.contains("is-expanded"))expand.click();card.scrollIntoView({block:"center"});return true})()`);
  await sleep(100);
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('[data-capture-id="capture-1"]'),player=card.querySelector("[data-speech-player]"),actions=card.querySelector(".speech-asset-actions"),cardRect=card.getBoundingClientRect(),playerRect=player.getBoundingClientRect(),actionsRect=actions.getBoundingClientRect();return{controls:player.controls,visible:playerRect.height>0,actionsVisible:actionsRect.height>0&&actionsRect.top>=cardRect.top&&actionsRect.bottom<=cardRect.bottom+1,inside:playerRect.left>=cardRect.left&&playerRect.right<=cardRect.right+1&&actionsRect.right<=cardRect.right+1,noVoice:Boolean(card.querySelector("[data-capture-voice]")),buttons:actions.querySelectorAll("button").length,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{controls:true,visible:true,actionsVisible:true,inside:true,noVoice:false,buttons:1,noOverflow:true});
  const captureMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-captures-mobile.png", Buffer.from(captureMobileScreenshot.data, "base64"));
  await evaluate(`window.__stoppedSpeechPlayer=document.querySelector('[data-capture-id="capture-1"] [data-speech-player]');window.__stoppedSpeechUrl=window.__stoppedSpeechPlayer.getAttribute("src");window.__stoppedSpeechPlayer.play();window.dispatchEvent(new Event("pagehide"));true`);
  assert.deepEqual(await evaluate(`({paused:window.__stoppedSpeechPlayer.paused,retained:window.__stoppedSpeechPlayer.getAttribute("src")===window.__stoppedSpeechUrl,revoked:window.__speechRevokedUrls.includes(window.__stoppedSpeechUrl)})`),{paused:true,retained:true,revoked:false},"page exit must stop playback without deleting the persisted asset source");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]').click(); true`);
  const promoted = await evaluate(`({ today: document.querySelector("#view-today").classList.contains("active"), idea: document.querySelector("#chain-idea").value, status: document.querySelector("#chain-status").textContent, sourceId:document.querySelector("#chain-form").elements.sourceCaptureId.value, sourceVersion:document.querySelector("#chain-form").elements.sourceCaptureVersion.value, kind:document.querySelector("#chain-form").elements.recordKind.value, chooserHidden:document.querySelector(".thought-record-kind").hidden })`);
  assert.equal(promoted.today, true);
  assert.equal(promoted.idea, "**这个念头**先不要想完整");
  assert.match(promoted.status, /补上一个明确问题/);
  assert.deepEqual({sourceId:promoted.sourceId,sourceVersion:promoted.sourceVersion,kind:promoted.kind,chooserHidden:promoted.chooserHidden},{sourceId:"capture-1",sourceVersion:"2",kind:"thought",chooserHidden:true});
  await evaluate(`document.querySelector("#thought-source-cancel").click();true`);
  assert.deepEqual(await evaluate(`(()=>{const form=document.querySelector("#chain-form");return{source:form.elements.sourceCaptureId.value,idea:document.querySelector("#chain-idea").value,chooserHidden:document.querySelector(".thought-record-kind").hidden,status:document.querySelector("#chain-status").textContent}})()`),{source:"",idea:"",chooserHidden:false,status:"已取消从念起展开，可以重新记录。"});
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]')`),true);
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-promote]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-today").classList.contains("active")&&!document.querySelector("#view-today").inert`),true);
  await evaluate(`document.querySelector('[data-view="journals"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#journal-id").value==="journal-1"`),true);
  const restoredJournalDraft = await evaluate(`({id:document.querySelector("#journal-id").value,title:document.querySelector("#journal-title").value,content:document.querySelector("#journal-content").value,tags:document.querySelector("#journal-tags").value,date:document.querySelector("#journal-date").value,status:document.querySelector("#journal-status").textContent})`);
  assert.equal(restoredJournalDraft.id, "journal-1");
  assert.equal(restoredJournalDraft.title, "跨端恢复的标题");
  assert.equal(restoredJournalDraft.content, "跨端恢复的正文。");
  assert.equal(restoredJournalDraft.tags, "#日常");
  assert.ok(restoredJournalDraft.date);
  assert.match(restoredJournalDraft.status, /已恢复/);
  await evaluate(`document.querySelector("#journal-title").value += "（续写）"; document.querySelector("#journal-content").value += "继续写。";window.__failJournalDraft=true;document.querySelector("#journal-draft-save").click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#journal-status").textContent==="日记草稿保存暂时失败。标题和正文仍保留在当前页面。请稍后重试。"`),true);
  assert.deepEqual(await evaluate(`({title:document.querySelector("#journal-title").value,content:document.querySelector("#journal-content").value,sentinel:document.body.textContent.includes("JOURNAL_STORAGE_INTERNAL"),saves:window.__journalDraftSaves})`),{title:"跨端恢复的标题（续写）",content:"跨端恢复的正文。继续写。",sentinel:false,saves:0});
  await evaluate(`document.querySelector("#journal-draft-save").click();true`);
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
  const journalDraftRequestsBeforeLease = await evaluate(`window.__journalDraftRequests`);
  await evaluate(`window.__delayJournalDraft=true;document.querySelector("#journal-title").value="先发出的旧草稿";document.querySelector("#journal-draft-save").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseJournalDraft==="function"`), true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&!document.querySelector("#view-captures").inert`), true);
  await evaluate(`document.querySelector('[data-view="journals"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-journals").classList.contains("active")&&!document.querySelector("#view-journals").inert&&document.querySelector("#journal-draft-save").disabled`), true);
  await evaluate(`document.querySelector("#journal-title").value="后写的新草稿";document.querySelector("#journal-draft-save").click();true`);
  assert.equal(await evaluate(`window.__journalDraftRequests`), journalDraftRequestsBeforeLease + 1);
  await evaluate(`window.__releaseJournalDraft();true`);
  assert.equal(await waitUntil(`!document.querySelector("#journal-draft-save").disabled`), true);
  await evaluate(`document.querySelector("#journal-draft-save").click();true`);
  assert.equal(await waitUntil(`window.__journalDraftRequests===${journalDraftRequestsBeforeLease + 2}&&window.__journalDraft?.title==="后写的新草稿"`), true);
  const journalAssistRequestsBeforeLease = await evaluate(`window.__journalAssistPayloads.length`);
  await evaluate(`window.__delayJournalAssist=true;document.querySelector('[data-journal-assist="lead"]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseJournalAssist==="function"`), true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&!document.querySelector("#view-captures").inert`), true);
  await evaluate(`document.querySelector('[data-view="journals"]').click();true`);
  assert.equal(await waitUntil(`[...document.querySelectorAll("[data-journal-assist]")].every(button=>button.disabled)`), true);
  await evaluate(`document.querySelector('[data-journal-assist="structure"]').click();true`);
  assert.equal(await evaluate(`window.__journalAssistPayloads.length`), journalAssistRequestsBeforeLease + 1);
  await evaluate(`window.__releaseJournalAssist();true`);
  assert.equal(await waitUntil(`[...document.querySelectorAll("[data-journal-assist]")].every(button=>!button.disabled)`), true);
  await evaluate(`document.querySelector('[data-journal-assist="structure"]').click();true`);
  assert.equal(await waitUntil(`window.__journalAssistPayloads.length===${journalAssistRequestsBeforeLease + 2}&&document.querySelector("#journal-content").value.includes("🏷 第一行写作锚点")`), true);
  await evaluate(`document.querySelector("#journal-content").value += "\\n我写下了真实感受。";window.__conflictJournalPatch=true;document.querySelector("#journal-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`document.querySelector("#journal-status").textContent==="这篇日记在其他位置已经变化。当前编辑内容仍保留，已有日记没有被覆盖。请重新读取后核对两端内容。"`),true);
  assert.deepEqual(await evaluate(`({editing:document.querySelector("#journal-content").value.includes("我写下了真实感受"),server:window.__journals.find(item=>item.id==="journal-1").content.includes("我写下了真实感受"),sentinel:document.body.textContent.includes("JOURNAL_CONFLICT_INTERNAL"),patches:window.__journalPatches})`),{editing:true,server:false,sentinel:false,patches:0});
  await evaluate(`document.querySelector("#journal-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__journalPatches === 1 && window.__journalDraft === null && document.querySelector("#journal-id").value === ""`), true);
  await evaluate(`document.querySelector("#journal-title").value = "新日记"; document.querySelector("#journal-content").value = "新建日记正文。";window.__delayJournalCreate=true;window.__failNextStateRefresh=true;document.querySelector("#journal-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`typeof window.__releaseJournalCreate==="function"`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&!document.querySelector("#view-captures").inert`),true);
  await evaluate(`window.__releaseJournalCreate();true`);
  assert.equal(await waitUntil(`window.__journalSaves===1`),true);
  await evaluate(`document.querySelector('[data-view="journals"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-journal-id="journal-new-1"]')&&document.querySelector("#journal-id").value===""&&document.querySelector("#journal-content").value===""`), true);
  assert.equal(await waitUntil(`document.querySelector("#toast").textContent==="日记列表刷新暂时失败。刚才的日记已经保存。请稍后重试。"`),true);
  assert.equal(await evaluate(`!document.body.textContent.includes("DISCOVERY_BACKEND_INTERNAL")`),true);
  await evaluate(`document.querySelector('[data-journal-id="journal-1"]').open = true; document.querySelector('[data-journal-id="journal-1"] [data-journal-reflect]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector('[data-journal-id="journal-1"] .journal-reflection')`, 80, 25), true);
  assert.deepEqual(await evaluate(`(()=>{const reflection=document.querySelector('[data-journal-id="journal-1"] .journal-reflection');return{reasoningNodes:reflection.querySelectorAll(".saved-reasoning").length,privateText:reflection.textContent.includes("持久化的模型思考"),answer:reflection.textContent.includes("结论")}})()`),{reasoningNodes:0,privateText:false,answer:true});
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
  assert.equal(await waitUntil(`document.querySelectorAll("#all-thoughts .thought-month").length===1`),true);
  const thoughtListScrollBeforeCreate = await evaluate(`window.scrollY`);
  await evaluate(`document.querySelector("#thought-create-toggle").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#home-thought-editor").hidden&&document.activeElement===document.querySelector("#chain-question")`),true);
  assert.deepEqual(await evaluate(`({
    view:document.querySelector(".view.active")?.id,
    path:location.pathname,
    thoughtPrimary:document.querySelector('[data-section="thought"]').getAttribute("aria-current"),
    todayPrimary:document.querySelector('[data-section="today"]').getAttribute("aria-current")
  })`),{view:"view-thoughts",path:"/thoughts",thoughtPrimary:"page",todayPrimary:"false"},"thought create must keep the thoughts route active");
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true`);
  assert.deepEqual(await evaluate(`({
    hidden:document.querySelector("#home-thought-editor").hidden,
    view:document.querySelector(".view.active")?.id,
    path:location.pathname,
    focusReturned:document.activeElement===document.querySelector("#thought-create-toggle"),
    scrollY:window.scrollY
  })`),{hidden:true,view:"view-thoughts",path:"/thoughts",focusReturned:true,scrollY:thoughtListScrollBeforeCreate},"cancelling thought create must restore the thoughts list context");
  // thought-r8-reading
  const thoughtListState = await evaluate(`(() => {
    const kept = document.querySelector('[data-chain-id="kept-root"]');
    const discarded = document.querySelector('[data-chain-id="discarded-root"]');
    return {
      first:kept.dataset.chainId,
      months:document.querySelectorAll("#all-thoughts .thought-month").length,
      aiNotConclusion:!kept.querySelector(".thought-preview"),
      discardedPresent:Boolean(discarded),
      userConclusion:discarded.querySelector(".thought-preview.conclusion")?.textContent.replace(/\s+/g," ").trim(),
      openLabel:kept.querySelector(".thought-open-label")?.textContent,
      summaries:document.querySelectorAll("#all-thoughts .chain-summary").length,
      detailTitles:document.querySelectorAll("#all-thoughts .thought-detail-title").length
    };
  })()`);
  assert.deepEqual(thoughtListState,{first:"kept-root",months:1,aiNotConclusion:true,discardedPresent:true,userConclusion:"✓ 我的结论这是我自己的结论。",openLabel:"打开 ↗",summaries:2,detailTitles:0});
  assert.deepEqual(await evaluate(`(()=>{const controls=document.querySelector('#all-thoughts [data-chain-id="kept-root"]').closest(".thought-timeline-entry").querySelector(".thought-chain-speech .speech-asset-controls"),player=controls.querySelector("[data-speech-player]");return{sourceType:controls.dataset.speechSourceType,sourceId:controls.dataset.speechSourceId,sourceVersion:controls.dataset.speechSourceVersion,src:player.getAttribute("src"),visible:Boolean(player.getClientRects().length)}})()`),{sourceType:"thoughtChain",sourceId:"kept-root",sourceVersion:"1",src:"/api/speech/audio?id=asset-chain-kept-v1",visible:true});
  await evaluate(`document.querySelector("#toast").hidden=true;true`);
  await sleep(250);
  await fs.writeFile("/tmp/growth-thought-r8-list.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#all-thoughts").dataset.routeMode==="detail"&&document.querySelector('#all-thoughts [data-chain-id="kept-root"]')?.open`),true);
  const thoughtDetailState=await evaluate(`(() => {
    const kept=document.querySelector('#all-thoughts [data-chain-id="kept-root"]'),primary=[...kept.querySelectorAll(".thought-actions button")].map(button=>button.textContent.trim());
    return {
      titleReadable:!kept.querySelector(".thought-detail-title").textContent.includes("**"),
      markdownBold:Boolean(kept.querySelector(".thought-content-block strong")),
      reasoningNodes:kept.querySelectorAll(".saved-reasoning").length,
      privateReasoningVisible:kept.textContent.includes("持久化的模型思考"),
      blockCount:kept.querySelectorAll("[data-thought-block-id]").length,
      aiLabel:kept.querySelector(".thought-content-block.ai header b")?.textContent,
      formHidden:kept.querySelector("[data-follow-up-root]").hidden,
      primary,
      hasDisposition:Boolean(kept.querySelector("[data-disposition]")),
      staticHeaderHidden:getComputedStyle(document.querySelector("#view-thoughts>.page-header")).display==="none",
      listSummaries:kept.querySelectorAll(".chain-summary").length,
      listPreviews:kept.querySelectorAll(".question-preview,.thought-preview,.thought-open-label").length,
      detailTitles:kept.querySelectorAll(".thought-detail-title").length
    };
  })()`);
  assert.deepEqual(thoughtDetailState,{titleReadable:true,markdownBold:true,reasoningNodes:0,privateReasoningVisible:false,blockCount:1,aiLabel:"AI 应答",formHidden:true,primary:["＋ 补充","追问 →","✦ 重新回答"],hasDisposition:true,staticHeaderHidden:true,listSummaries:0,listPreviews:0,detailTitles:1});
  await evaluate(`document.querySelector("#toast").hidden=true;true`);
  await sleep(250);
  await fs.writeFile("/tmp/growth-thought-r8-detail.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:720,height:900,deviceScaleFactor:2,mobile:false});
  await sleep(80);
  assert.deepEqual(await evaluate(`(()=>{const title=document.querySelector(".thought-detail-title").getBoundingClientRect(),meta=document.querySelector(".thought-detail-meta").getBoundingClientRect(),stream=document.querySelector(".thought-content-stream").getBoundingClientRect();return{noOverflow:document.documentElement.scrollWidth<=innerWidth,titleCount:document.querySelectorAll(".thought-detail-title").length,summaryCount:document.querySelectorAll("#all-thoughts .chain-summary").length,titleAfterMeta:title.top>=meta.bottom-1,streamAfterTitle:stream.top>=title.bottom-1}})()`),{noOverflow:true,titleCount:1,summaryCount:0,titleAfterMeta:true,streamAfterTitle:true},"200% desktop zoom equivalent must preserve one non-overlapping detail hierarchy");
  for(const width of[320,375,390]){
    await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:2,mobile:true});
    await sleep(80);
    assert.deepEqual(await evaluate(`(()=>{const actions=document.querySelector("#all-thoughts .thought-actions").getBoundingClientRect(),nav=document.querySelector(".sidebar").getBoundingClientRect(),buttons=[...document.querySelectorAll("#all-thoughts .thought-actions button")],tops=buttons.map(button=>Math.round(button.getBoundingClientRect().top));return{noOverflow:document.documentElement.scrollWidth<=innerWidth,fixed:getComputedStyle(document.querySelector("#all-thoughts .thought-actions")).position==="fixed",aboveNav:actions.bottom<=nav.top+1,touch:buttons.every(button=>button.getBoundingClientRect().height>=44),singleRow:new Set(tops).size===1}})()`),{noOverflow:true,fixed:true,aboveNav:true,touch:true,singleRow:true},`${width}px thought primary actions`);
  }
  await evaluate(`document.querySelector("#toast").hidden=true;true`);
  await fs.writeFile("/tmp/growth-thought-r8-detail-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector("[data-thought-list]").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#all-thoughts").dataset.routeMode==="list"`),true);
  await evaluate(`document.querySelector('[data-thought-sort="created"]').click();true`);
  assert.deepEqual(await evaluate(`({first:document.querySelector("#all-thoughts [data-chain-id]").dataset.chainId,created:document.querySelector('[data-thought-sort="created"]').getAttribute("aria-pressed"),occurred:document.querySelector('[data-thought-sort="occurred"]').getAttribute("aria-pressed")})`),{first:"discarded-root",created:"true",occurred:"false"});
  await evaluate(`document.querySelector('[data-thought-sort="occurred"]').click();true`);
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#all-thoughts").dataset.routeMode==="detail"`),true);
  assert.equal(await evaluate(`document.querySelector('[data-chain-id="kept-root"] .thought-detail-title').classList.contains("commentable") && document.querySelector('[data-chain-id="kept-root"] .thought-block-content').classList.contains("commentable")`), true);
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
  assert.equal(await evaluate(`[...document.querySelectorAll("#all-thoughts .timeline-date")].filter(item => item.textContent.trim()).length`), 0);
  await evaluate(`(() => { const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]'),text=card.querySelector('.thought-detail-title p').firstChild,range=document.createRange(),selection=getSelection();range.setStart(text,0);range.setEnd(text,2);selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));return true; })()`);
  assert.equal(await waitUntil(`!document.querySelector("#selection-tools").hidden`), true);
  await evaluate(`document.querySelector('[data-selection-action="highlight"]').click(); true`);
  assert.equal(await waitUntil(`window.__thoughtAnnotationSaves>=1`), true);
  assert.equal(await evaluate(`!document.querySelector('[data-chain-id="kept-root"] .thought-trace-pending')`), true);
  await evaluate(`document.querySelector('[data-view="review"]').click(); true`);
  const reviewMarkdown = await evaluate(`({ bold: Boolean(document.querySelector(".analysis-content strong")), heading: document.querySelector(".analysis-content h2")?.textContent, rawMarkers: document.querySelector(".analysis-content").textContent.includes("**"), privateReasoning:document.querySelector("#analysis-list").textContent.includes("分析过程")||document.querySelector("#analysis-list").textContent.includes("旧分析过程") })`);
  assert.equal(reviewMarkdown.bold, true);
  assert.equal(reviewMarkdown.heading, "证据");
  assert.equal(reviewMarkdown.rawMarkers, false);
  assert.equal(reviewMarkdown.privateReasoning, false);
  assert.equal(await evaluate(`document.querySelector('[data-analysis-id="analysis-1"] .analysis-content').dataset.commentRoot`), "analysis:analysis-1");
  const analysisHistory = await evaluate(`(() => {
    const entries = [...document.querySelectorAll("[data-analysis-id]")];
    return { count: document.querySelector("#analysis-count").textContent, entries: entries.length, latestOpen: entries[0].open, oldOpen: entries[1].open };
  })()`);
  assert.equal(analysisHistory.count, "2 份");
  assert.equal(analysisHistory.entries, 2);
  assert.equal(analysisHistory.latestOpen, true);
  assert.equal(analysisHistory.oldOpen, false);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('[data-analysis-id="analysis-1"] .analysis-content').scrollIntoView({block:"center",behavior:"auto"});true`);
  await sleep(80);
  const commentAnchorTop = await evaluate(`document.querySelector('[data-analysis-id="analysis-1"] .analysis-content').getBoundingClientRect().top`);
  await evaluate(`(() => { const text = document.querySelector('[data-analysis-id="analysis-1"] .analysis-content strong').firstChild, range = document.createRange(), selection = getSelection(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return true; })()`);
  assert.equal(await waitUntil(`document.querySelector("#selection-tools").hidden?(document.dispatchEvent(new Event("selectionchange")),false):true`), true);
  await evaluate(`document.querySelector('[data-selection-action="comment"]').click(); true`);
  await sleep(80);
  const commentPanelLayout=await evaluate(`(()=>{const panel=document.querySelector("#comment-panel").getBoundingClientRect(),main=document.querySelector("main").getBoundingClientRect(),top=document.querySelector('[data-analysis-id="analysis-1"] .analysis-content').getBoundingClientRect().top;return{open:!document.querySelector("#comment-panel").hidden,title:document.querySelector("#comment-panel h2").textContent,sideBySide:main.right<=panel.left+1,stable:Math.abs(top-${commentAnchorTop})<3,before:${commentAnchorTop},after:top}})()`);
  assert.deepEqual({open:commentPanelLayout.open,title:commentPanelLayout.title,sideBySide:commentPanelLayout.sideBySide},{open:true,title:"认知复盘批注",sideBySide:true});
  assert.equal(commentPanelLayout.stable,true,JSON.stringify(commentPanelLayout));
  await evaluate(`(()=>{const input=document.querySelector("#comment-text");input.value="关闭后仍保留的纯文字评论";input.dispatchEvent(new Event("input",{bubbles:true}));input.click();return true})()`);
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").hidden`),true,"comment panel interaction stays open");
  await evaluate(`document.querySelector("#comment-panel-close").click();true`);
  assert.deepEqual(await evaluate(`({closed:document.querySelector("#comment-panel").hidden,reopen:!document.querySelector("#comment-panel-reopen").hidden})`),{closed:true,reopen:true});
  await evaluate(`document.querySelector("#comment-panel-reopen").click();true`);
  assert.equal(await evaluate(`document.querySelector("#comment-text").value`),"关闭后仍保留的纯文字评论");
  await evaluate(`(()=>{const text=document.querySelector('[data-analysis-id="analysis-1"] .analysis-content strong').firstChild,range=document.createRange(),selection=getSelection();range.selectNodeContents(text);selection.removeAllRanges();selection.addRange(range);text.parentElement.dispatchEvent(new MouseEvent("click",{bubbles:true}));return true})()`);
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").hidden`),true,"text selection does not close comments");
  await evaluate(`getSelection().removeAllRanges();document.querySelector(".analysis-heading-meta").click();true`);
  assert.equal(await evaluate(`document.querySelector("#comment-panel").hidden`),true,"outside click closes comments");
  await evaluate(`document.querySelector("#comment-panel-reopen").click();true`);
  assert.equal(await evaluate(`document.querySelector("#comment-text").value`),"关闭后仍保留的纯文字评论");
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"comment-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#comment-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#comment-text").value="这条判断需要继续核对反证。";document.querySelector("#comment-composer").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__annotationSaves === 1 && window.__analyses[0].annotations[0]?.attachmentPaths.length===1 && document.querySelector('.analysis-content .comment-anchor')?.textContent === "总判断" && document.querySelectorAll('[data-comment-card="analysis-annotation-1"] .content-originals [data-image-viewer-path]').length===1`), true);
  assert.equal(await evaluate(`window.__analyses[0].annotations[0].attachmentPaths.length===1&&document.querySelectorAll('[data-comment-card="analysis-annotation-1"] .content-originals img').length===1&&document.querySelectorAll('[data-comment-card="analysis-annotation-1"] .content-originals [data-image-viewer-path]').length===1`),true);
  await evaluate(`document.querySelector('[data-annotation-menu="to-emphasis"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-comment-card="analysis-annotation-1"]').classList.contains("emphasis-card")&&document.querySelector(".analysis-content .comment-anchor")?.classList.contains("emphasis-anchor")`),true);
  await evaluate(`document.querySelector('[data-annotation-menu="to-comment"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-comment-card="analysis-annotation-1"]').classList.contains("emphasis-card")&&document.querySelector(".analysis-content .comment-anchor")?.classList.contains("comment-anchor")`),true);
  await evaluate(`(()=>{const text=document.querySelector('.analysis-content .comment-anchor[data-annotation-id="analysis-annotation-1"]').firstChild,range=document.createRange(),selection=getSelection();range.selectNodeContents(text);selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`!document.querySelector("#selection-tools").hidden`),true);
  await evaluate(`(()=>{window.__failNextAnnotationTaskPost=true;document.querySelector('[data-selection-action="comment"]').click();const input=document.querySelector("#comment-text");input.value="@神鸡：找出这条判断的反例";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#comment-composer").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__annotationSaves===2&&window.__annotationTaskAttempts.length===1&&document.querySelector('[data-shenji-form="analysis-annotation-2"]')?.dataset.requestId`),true);
  const failedDirectAssistant=await evaluate(`(()=>{const key="analysis:analysis-1|analysis-annotation-2",draft=JSON.parse(sessionStorage.getItem("cike:annotation-drafts:user-1")||"{}")[key],form=document.querySelector('[data-shenji-form="analysis-annotation-2"]');return{attemptId:window.__annotationTaskAttempts[0].clientRequestId,draftId:draft?.requestId||"",formId:form?.dataset.requestId||"",successfulPosts:window.__annotationTaskPayloads.length}})()`);
  assert.ok(failedDirectAssistant.attemptId);
  assert.deepEqual(failedDirectAssistant,{
    attemptId:failedDirectAssistant.attemptId,
    draftId:failedDirectAssistant.attemptId,
    formId:failedDirectAssistant.attemptId,
    successfulPosts:0
  });
  await evaluate(`(()=>{window.__failNextStateRefresh=true;document.querySelector('[data-shenji-form="analysis-annotation-2"]').requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__annotationTaskPayloads.length===1&&!document.querySelector('[data-shenji-form="analysis-annotation-2"]').dataset.requestId`),true);
  assert.deepEqual(await evaluate(`(()=>{const attempts=window.__annotationTaskAttempts;return{attempts:attempts.length,sameRequestId:attempts[0].clientRequestId===attempts[1].clientRequestId,draftRetained:Boolean(JSON.parse(sessionStorage.getItem("cike:annotation-drafts:user-1")||"{}")["analysis:analysis-1|analysis-annotation-2"]),toast:document.querySelector("#toast").textContent}})()`),{
    attempts:2,
    sameRequestId:true,
    draftRetained:false,
    toast:"神鸡任务已提交，但通知刷新失败"
  });
  assert.deepEqual(await evaluate(`(()=>{const payload=window.__annotationTaskPayloads[0];return{kind:payload.kind,subtargetId:payload.subtargetId,message:payload.payload.message,comment:window.__analyses[0].annotations.find(item=>item.id==="analysis-annotation-2").text}})()`),{kind:"annotationShenji",subtargetId:"analysis-annotation-2",message:"找出这条判断的反例",comment:"@神鸡：找出这条判断的反例"});
  const commentLineAggregated=await waitUntil(`[...document.querySelectorAll("[data-comment-line]")].some(item=>item.textContent==="2")`);
  assert.equal(commentLineAggregated,true,JSON.stringify(await evaluate(`({badges:[...document.querySelectorAll("[data-comment-line]")].map(item=>({text:item.textContent,top:item.style.top})),marks:[...document.querySelectorAll('.analysis-content .comment-anchor')].map(item=>({id:item.dataset.annotationId,text:item.textContent,rects:[...item.getClientRects()].map(rect=>({top:rect.top,height:rect.height}))})),annotations:window.__analyses[0].annotations.map(item=>({id:item.id,kind:item.kind,start:item.start,end:item.end}))})`)));
  await evaluate(`document.querySelector("#comment-panel-close").click();document.querySelector('[data-comment-line]').click();true`);
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").hidden&&Boolean(document.querySelector(".comment-card.active"))`),true,"line count opens its comments");
  assert.equal(await waitUntil(`window.__shenjiSaves===1`),true);
  await evaluate(`document.querySelector('[data-shenji-toggle="analysis-annotation-1"]').click(); const form = document.querySelector('[data-shenji-form="analysis-annotation-1"]'); form.elements.message.value = "这条判断可能遗漏了什么？"; form.requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__annotationTaskPayloads.length===2&&document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea').value===""`),true);
  assert.equal(await evaluate(`Boolean(JSON.parse(sessionStorage.getItem("cike:annotation-drafts:user-1")||"{}")["analysis:analysis-1|analysis-annotation-1"])`),false,"successful assistant submission clears its draft");
  assert.match(await evaluate(`document.querySelector('[data-shenji-form="analysis-annotation-1"] .shenji-status').textContent`), /后台队列/);
  await evaluate(`(()=>{const input=document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea');input.value="后台同步期间的新草稿";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`window.__shenjiSaves===2&&document.querySelector('[data-comment-card="analysis-annotation-1"] .shenji-answer')?.textContent.includes("神鸡判断")`,160,25),true);
  assert.equal(await evaluate(`document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea').value`),"后台同步期间的新草稿");
  assert.equal(await evaluate(`!document.querySelector("#comment-panel").textContent.includes("核对复盘上下文")&&!document.querySelector("#comment-panel .saved-reasoning")`),true);
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
  assert.equal(await evaluate(`!document.querySelector("#selection-quote-modal").hidden && document.querySelector("#selection-quote-content").value === "旧复盘" && document.querySelector("#selection-quote-source").value.includes("认知复盘") && document.querySelector("#selection-quote-selected-tags").textContent.includes("认知复盘")`), true);
  await evaluate(`(()=>{document.querySelector("#selection-quote-content").value="旧复盘\\n收藏";const input=document.querySelector("#selection-quote-tags");for(const tag of["复盘","传统"]){input.value=tag;input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))}document.querySelector("#selection-quote-form").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__quoteSaves === 1 && document.querySelector("#selection-quote-modal").hidden`), true);
  assert.deepEqual(await evaluate(`window.__quotePayloads[0].tags`),["认知复盘","复盘","传统"]);
  await evaluate(`document.querySelector(".analysis-panel").scrollIntoView({ block: "start" }); true`);
  await sleep(100);
  const reviewScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-review-markdown.png", Buffer.from(reviewScreenshot.data, "base64"));
  await evaluate(`document.querySelector('[data-view="books"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-books").classList.contains("active")&&!document.querySelector("#view-books").inert&&!document.querySelector("#view-books").hasAttribute("aria-busy")&&!document.querySelector("#book-create-panel").hidden&&document.querySelector("#book-library").hidden`),true);
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
  assert.equal(
    pastedRecognitionImage.recognitionVisible,
    true,
    JSON.stringify({
      state: await evaluate(`({busy:document.querySelector("#view-books").getAttribute("aria-busy"),toast:document.querySelector("#toast").textContent,active:document.querySelector("#view-books").classList.contains("active")})`),
      exceptions: cdp.events.filter(event => event.method === "Runtime.exceptionThrown")
        .slice(-3)
        .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
    })
  );
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
  assert.equal(await waitUntil(`window.__bookNotePatches === 2 && document.querySelector('[data-book-note-favorite="note-1"]')?.classList.contains("sprout")`), true);
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
  assert.equal(await waitUntil(`document.querySelector("#view-quotes").classList.contains("active")&&!document.querySelector("#view-quotes").inert&&!document.querySelector("#view-quotes").hasAttribute("aria-busy")&&document.querySelectorAll(".quote-entry").length===5`),true);
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
  assert.match(quoteSky.font,/Songti|STSong|SimSun|ui-serif/);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector("#quote-sky")).backgroundColor`),"rgb(244, 246, 241)");
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
  await evaluate(`(()=>{document.querySelector("#quote-source").value="新来源";document.querySelector("#quote-content").value="新收藏\\n第二行";document.querySelector("#quote-tag-toggle").click();const option=[...document.querySelectorAll("#quote-tag-options [data-quote-tag-option]")].find(item=>item.dataset.quoteTagOption==="阅读");option.click();const input=document.querySelector("#quote-tags");input.value="新标签";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"，",bubbles:true}));document.querySelector("#quote-form").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__quoteSaves === 2 && document.querySelector("#quote-source").value === "" && document.querySelector("#quote-content").value === "" && document.querySelector("#quote-timeline").textContent.includes("新收藏")`), true);
  assert.deepEqual(await evaluate(`window.__quotePayloads[1].tags`),["阅读","新标签"]);
  assert.equal(await evaluate(`document.querySelector("#toast").textContent`), "善言已收藏");
  await evaluate(`(()=>{document.querySelector('[data-quote-id="quote-new-2"] [data-quote-edit]').click();while(document.querySelector('#quote-selected-tags [data-quote-tag-remove]'))document.querySelector('#quote-selected-tags [data-quote-tag-remove]').click();const input=document.querySelector("#quote-tags");input.value="更新";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#quote-form").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__quotePatches === 1 && document.querySelector('[data-quote-id="quote-new-2"] .quote-tags')?.textContent.includes("更新")`),true);
  assert.deepEqual(await evaluate(`window.__quotePayloads[2].tags`),["更新"]);
  await evaluate(`document.querySelector("#quote-timeline").scrollIntoView({ block: "start" }); true`);
  const quoteScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-quote-timeline.png", Buffer.from(quoteScreenshot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(120);
  assert.equal(await evaluate(`(() => { const entry=[...document.querySelectorAll(".quote-entry")].find(item=>item.textContent.includes("第六行：般若照见实相")),meta=entry.querySelector(".quote-entry-meta").getBoundingClientRect(),card=entry.querySelector(".quote-entry-card").getBoundingClientRect(),source=entry.querySelector("cite").getBoundingClientRect(),tools=entry.querySelector(".quote-entry-tools").getBoundingClientRect();return document.documentElement.scrollWidth<=window.innerWidth&&meta.bottom<=card.top+1&&source.top>=meta.top-1&&tools.top>=meta.top-1&&tools.bottom<=meta.bottom+1; })()`),true);
  const quoteTimelineMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-quote-timeline-mobile.png",Buffer.from(quoteTimelineMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-view="thoughts"]').click(); true`);
  assert.deepEqual(await evaluate(`({reasoningNodes:document.querySelectorAll(".saved-reasoning,#ai-answer-reasoning").length,privateText:document.body.textContent.includes("持久化的模型思考")||document.body.textContent.includes("分析过程")||document.body.textContent.includes("PRIVATE_CHAT_REASONING")})`),{reasoningNodes:0,privateText:false});
  await evaluate(`(() => {
    const all=document.querySelector('#all-thoughts [data-chain-id="kept-root"]');
    all.open=true;all.querySelector("[data-followup-compose]").click();
    const allForm=all.querySelector("[data-follow-up-root]");
    allForm.elements.question.value="失败后保留的追问";allForm.elements.answer.value="";
    window.__failFollowUpCreate=true;allForm.requestSubmit();return true
  })()`);
  assert.equal(await waitUntil(`document.querySelector('#all-thoughts [data-follow-up-root] .followup-status').textContent.includes("追问保存失败")&&!document.querySelector('#all-thoughts [data-follow-up-root] button[type="submit"]').disabled`),true);
  assert.deepEqual(await evaluate(`(() => {const form=document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root]');return{question:form.elements.question.value,answer:form.elements.answer.value,hidden:form.hidden,requestId:form.dataset.requestId||""}})()`),{
    question:"失败后保留的追问",answer:"",hidden:false,requestId:await evaluate(`document.querySelector('#all-thoughts [data-follow-up-root]').dataset.requestId||""`)
  });
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root]').requestSubmit();true`);
  const followUpRetryCompleted=await waitUntil(`window.__followUpSaves===1&&document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root]').hidden`);
  assert.equal(followUpRetryCompleted,true,JSON.stringify({
    ui:await evaluate(`(()=>{const form=document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root]');return{saves:window.__followUpSaves,status:form?.querySelector(".followup-status")?.textContent||"",hidden:form?.hidden,requestId:form?.dataset.requestId||""}})()`),
    exceptions:cdp.events.filter(event=>event.method==="Runtime.exceptionThrown").slice(-3).map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
  }));
  const followUpCreateKeys=await evaluate(`window.__followUpCreateKeys`);
  assert.equal(followUpCreateKeys.length,2);
  assert.ok(followUpCreateKeys[0]);
  assert.equal(followUpCreateKeys[1],followUpCreateKeys[0]);
  assert.deepEqual(await evaluate(`(() => {const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]'),form=card.querySelector("[data-follow-up-root]");return{question:form.elements.question.value,answer:form.elements.answer.value,hidden:form.hidden,expanded:card.querySelector("[data-followup-compose]").getAttribute("aria-expanded"),followUps:card.querySelectorAll("[data-followup-id]").length}})()`),{
    question:"",answer:"",hidden:true,expanded:"false",followUps:1
  });
  await evaluate(`document.querySelector('[data-view="today"]').click();document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(
    await waitUntil(`document.querySelector('[data-chain-id="kept-root"] [data-follow-up-root]')&&[...document.querySelectorAll('[data-chain-id="kept-root"] [data-follow-up-root]')].every(form=>form.hidden&&form.elements.question.value===""&&form.elements.answer.value==="")`),
    true,
    JSON.stringify(await evaluate(`({path:location.pathname,cards:document.querySelectorAll("#all-thoughts [data-chain-id]").length,busy:document.querySelector("#view-thoughts").getAttribute("aria-busy"),toast:document.querySelector("#toast").textContent,exceptions:${JSON.stringify(cdp.events.filter(event=>event.method==="Runtime.exceptionThrown").slice(-3).map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text))}})`))
  );

  await evaluate(`(() => {
    const all=document.querySelector('#all-thoughts [data-followup-id="follow-up-1"]');
    all.open=true;
    const allForm=all.querySelector("[data-followup-manual-answer]");
    allForm.querySelector("textarea").value="失败后保留的手写回答";
    window.__failFollowUpPatch="manual-answer";allForm.requestSubmit();return true
  })()`);
  assert.equal(await waitUntil(`document.querySelector('#all-thoughts [data-followup-id="follow-up-1"] .followup-status').textContent.includes("手写回答失败")&&!document.querySelector('#all-thoughts [data-followup-manual-answer] button[type="submit"]').disabled`),true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#all-thoughts [data-followup-id="follow-up-1"] [data-followup-manual-answer] textarea')].map(item=>item.value)`),["失败后保留的手写回答"]);
  await evaluate(`document.querySelector('#all-thoughts [data-followup-manual-answer]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__followUpPatches===1&&document.querySelectorAll('[data-followup-id="follow-up-1"] [data-followup-manual-answer]').length===0`),true);

  await evaluate(`(() => {
    const all=document.querySelector('#all-thoughts [data-followup-id="follow-up-1"]');
    all.querySelector("[data-followup-edit-toggle]").click();
    return !all.querySelector("[data-followup-edit]").hidden
  })()`);
  assert.equal(await evaluate(`!document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"]').hidden`),true);
  await evaluate(`(() => {
    const all=document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"]');
    all.elements.question.value="保存后的追问";all.elements.answer.value="保存后的回答";
    window.__failFollowUpPatch="edit";all.requestSubmit();return true
  })()`);
  assert.equal(await waitUntil(`document.querySelector("#toast").textContent.includes("追问编辑失败")&&!document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"] button[type="submit"]').disabled`),true);
  assert.deepEqual(await evaluate(`(() => {const form=document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"]');return{question:form.elements.question.value,answer:form.elements.answer.value,hidden:form.hidden}})()`),{
    question:"保存后的追问",answer:"保存后的回答",hidden:false
  });
  await evaluate(`document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"]').requestSubmit();true`);
  assert.equal(await waitUntil(`window.__followUpPatches===2&&[...document.querySelectorAll('[data-followup-edit="follow-up-1"]')].every(form=>form.hidden)`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#view-today").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#view-thoughts").hasAttribute("aria-busy")&&document.querySelector('#all-thoughts [data-followup-id="follow-up-1"]')`),true);
  await evaluate(`document.querySelector('#all-thoughts [data-followup-id="follow-up-1"] [data-followup-edit-toggle]').click();true`);
  assert.deepEqual(await evaluate(`(() => {const form=document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"]');return{question:form.elements.question.value,answer:form.elements.answer.value,hidden:form.hidden}})()`),{question:"保存后的追问",answer:"保存后的回答",hidden:false});
  await evaluate(`document.querySelector('#all-thoughts [data-followup-id="follow-up-1"] [data-followup-edit-cancel]').click();document.querySelector("#toast").hidden=true;true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`(()=>{const card=document.querySelector('#all-thoughts [data-chain-id="kept-root"]');card.open=true;card.querySelector("[data-followup-compose]").click();return true})()`);
  await sleep(500);
  const createFollowUpMobile=await evaluate(`(() => {
    const button=document.querySelector('#all-thoughts [data-follow-up-root="kept-root"] button[type="submit"]'),bar=document.querySelector(".sidebar"),rect=button.getBoundingClientRect(),barRect=bar.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);
    return{button:{top:rect.top,bottom:rect.bottom},bar:{top:barRect.top,bottom:barRect.bottom},fullyAbove:rect.bottom<=barRect.top+.5,centerHit:hit===button,hit:hit?.className||hit?.tagName||""}
  })()`);
  assert.equal(createFollowUpMobile.fullyAbove,true,`390px 新增追问提交按钮被底栏遮挡：${JSON.stringify(createFollowUpMobile)}`);
  assert.equal(createFollowUpMobile.centerHit,true,`390px 新增追问提交按钮中心未命中自身：${JSON.stringify(createFollowUpMobile)}`);
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-followup-compose]').click();const entry=document.querySelector('#all-thoughts [data-followup-id="follow-up-1"]');entry.open=true;entry.querySelector("[data-followup-edit-toggle]").click();true`);
  await sleep(500);
  const editFollowUpMobile=await evaluate(`(() => {
    const button=document.querySelector('#all-thoughts [data-followup-edit="follow-up-1"] button[type="submit"]'),bar=document.querySelector(".sidebar"),rect=button.getBoundingClientRect(),barRect=bar.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);
    return{button:{top:rect.top,bottom:rect.bottom},bar:{top:barRect.top,bottom:barRect.bottom},fullyAbove:rect.bottom<=barRect.top+.5,centerHit:hit===button,hit:hit?.className||hit?.tagName||""}
  })()`);
  assert.equal(editFollowUpMobile.fullyAbove,true,`390px 编辑追问提交按钮被底栏遮挡：${JSON.stringify(editFollowUpMobile)}`);
  assert.equal(editFollowUpMobile.centerHit,true,`390px 编辑追问提交按钮中心未命中自身：${JSON.stringify(editFollowUpMobile)}`);
  await evaluate(`document.querySelector('#all-thoughts [data-followup-id="follow-up-1"] [data-followup-edit-cancel]').click();true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-followup-compose]').click();true`);
  assert.equal(await evaluate(`!document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root]').hidden`), true);
  await evaluate(`document.querySelector('[data-chain-id="kept-root"]').scrollIntoView({ block: "start" }); true`);
  await sleep(100);
  const cardScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-thought-card.png", Buffer.from(cardScreenshot.data, "base64"));
  await evaluate(`document.querySelector("#chain-question").value = "测试流式弹窗"; document.querySelector("#draft-answer-button").click(); true`);
  assert.equal(await waitUntil(`window.__reasoningChunks === 2`, 40, 10), true);
  assert.equal(await waitUntil(`document.querySelector("#ai-answer-result").textContent.includes("结论")`, 80, 25), true);
  const streaming = await evaluate(`(() => ({
    reasoningNodes: document.querySelectorAll("#ai-answer-reasoning,.answer-reasoning,.saved-reasoning").length,
    privateText: document.querySelector("#ai-answer-modal").textContent.includes("思考行 1") || document.querySelector("#ai-answer-modal").textContent.includes("再形成判断"),
    outputHidden: document.querySelector("#ai-answer-output").hidden,
    activeStep: document.querySelector("#ai-answer-progress li.active")?.dataset.step,
    answer: document.querySelector("#ai-answer-result").textContent
  }))()`);
  assert.equal(streaming.reasoningNodes, 0);
  assert.equal(streaming.privateText, false);
  assert.equal(streaming.outputHidden, false);
  assert.equal(streaming.activeStep, "answer");
  assert.match(streaming.answer, /结论/);

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-answer-modal.png", Buffer.from(screenshot.data, "base64"));
  await evaluate(`document.querySelector("#ai-answer-close").click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#chain-answer").value.includes("后台完成") && !document.querySelector("#draft-answer-button").disabled`, 80, 25), true);
  assert.equal(await evaluate(`document.querySelector("#ai-answer-reasoning")`), null);
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
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-1"] [data-capture-thought]')`),true);
  assert.equal(await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-thought]').textContent`),"已展为思考");
  await evaluate(`document.querySelector('[data-capture-id="capture-1"] [data-capture-thought]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-thoughts").classList.contains("active")&&document.querySelector('[data-chain-id="auto-root-1"]').open`),true);
  assert.equal(await evaluate(`location.pathname`),"/thoughts/auto-root-1");
  const taskCountBeforeAutoAnswer = await evaluate(`window.__aiTasks.length`);
  await evaluate(`document.querySelector("#chain-question").value = "第一条自动回答"; document.querySelector("#chain-answer").value = ""; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__aiTasks.length === ${taskCountBeforeAutoAnswer + 1} && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  assert.equal(await evaluate(`document.querySelector("#ai-answer-modal").hidden`), true);
  assert.match(await evaluate(`document.querySelector("#chain-status").textContent`), /后台生成/);
  assert.equal(await waitUntil(`window.__aiTasks[0].status === "succeeded" && !document.querySelector("#notification-dot").hidden`,80,25),true);
  await evaluate(`document.querySelector("[data-thought-list]").click();true`);
  assert.equal(await waitUntil(`location.pathname==="/seen/captures"&&document.querySelector("#view-captures").classList.contains("active")`),true);
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`location.pathname==="/thoughts"&&document.querySelector('#all-thoughts [data-chain-id="kept-root"]')`),true);
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
  assert.deepEqual(await evaluate(`(()=>{const answer=[...document.querySelectorAll('[data-chain-id="kept-root"] .thought-content-block.ai')].find(item=>item.textContent.includes("后台结果已局部合并")),receipt=answer.querySelector(".context-audit"),open=receipt.open;receipt.open=true;return{receipt:Boolean(receipt),open,label:receipt.querySelector("summary").textContent.includes("本次参考"),selectedLabel:receipt.querySelector("summary").textContent.includes("3 条编排选入"),selectionNotice:receipt.querySelector(".context-audit-note")?.textContent||"",sources:receipt.querySelectorAll(".context-source-item").length,unavailable:[...receipt.querySelectorAll(".context-source-item")].some(item=>item.textContent.includes("来源已删除或当前不可用")),answerCitation:receipt.textContent.includes("回答引用"),reasoning:Boolean(answer.querySelector(".saved-reasoning")),privateText:answer.textContent.includes("后台持久化思考")}})()`),{receipt:true,open:false,label:true,selectedLabel:true,selectionNotice:"这些材料在回答前被选入，不代表回答逐条引用。",sources:3,unavailable:true,answerCitation:false,reasoning:false,privateText:false});
  assert.deepEqual(await evaluate(`(() => {const input=document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-follow-up-root] textarea[name="question"]');return{value:input.value,formHidden:input.closest("form").hidden,cardOpen:input.closest("[data-chain-id]").open,focused:document.activeElement===input,stateRequests:window.__stateRequests}})()`),{value:"轮询期间不能丢失",formHidden:false,cardOpen:true,focused:true,stateRequests:stateRequestsBeforeBackgroundMerge});
  await evaluate(`document.querySelector("#chain-question").value = "第二条不应被阻塞"; document.querySelector("#chain-answer").value = "手写回答"; document.querySelector("#chain-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__thoughtSaves === 3 && !document.querySelector('#chain-form [type="submit"]').disabled && document.querySelector("#chain-question").value === ""`, 80, 25), true);
  const taskCountBeforeImageAnswer=await evaluate(`window.__aiTasks.length`);
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"thought-image.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="结合这张图片回答";document.querySelector("#chain-answer").value="";document.querySelector("#chain-form").requestSubmit();return true})()`);
  assert.equal(await waitUntil(`window.__thoughtSaves===4&&window.__aiTasks.length===${taskCountBeforeImageAnswer+1}`),true);
  assert.deepEqual(await evaluate(`({question:window.__savedPayloads[3].question,pathCount:window.__savedPayloads[3].attachmentPaths.length,generate:window.__savedPayloads[3].generateAnswer,answerTasks:window.__aiTasks.filter(item=>item.targetId==="auto-root-4"&&item.kind==="thoughtAnswer").length,imageTasks:window.__aiTasks.filter(item=>item.targetId==="auto-root-4"&&item.kind==="contentImageUnderstanding").length})`),{question:"结合这张图片回答",pathCount:1,generate:true,answerTasks:1,imageTasks:0});
  const thoughtSavesBeforeTagBlur=await evaluate(`window.__thoughtSaves`);
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();document.querySelector("#thought-create-toggle").click();true`);
  assert.deepEqual(await evaluate(`({view:document.querySelector(".view.active")?.id,path:location.pathname,visible:!document.querySelector("#home-thought-editor").hidden})`),{view:"view-thoughts",path:"/thoughts",visible:true});
  await sleep(50);
  const tagSubmitPoint=await evaluate(`(()=>{document.querySelector("#chain-question").value="标签失焦后仍应一次保存";document.querySelector("#chain-answer").value="真实指针点击不应因标签重排丢失";const tags=document.querySelector("#chain-tags"),button=document.querySelector("#chain-submit"),form=document.querySelector("#chain-form");window.__tagSubmitEvents={blur:0,click:0,submit:0};tags.addEventListener("blur",()=>window.__tagSubmitEvents.blur++,{once:true});button.addEventListener("click",()=>window.__tagSubmitEvents.click++,{once:true});form.addEventListener("submit",()=>window.__tagSubmitEvents.submit++,{once:true});tags.value="标签 回归";tags.focus();button.scrollIntoView({block:"center",behavior:"instant"});const rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);return{x,y,visible:x>=0&&x<=innerWidth&&y>=0&&y<=innerHeight,hit:hit?.id||hit?.className||hit?.tagName||""}})()`);
  assert.deepEqual({visible:tagSubmitPoint.visible,hit:tagSubmitPoint.hit},{visible:true,hit:"chain-submit"});
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:tagSubmitPoint.x,y:tagSubmitPoint.y});
  await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:tagSubmitPoint.x,y:tagSubmitPoint.y,button:"left",clickCount:1});
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:tagSubmitPoint.x,y:tagSubmitPoint.y,button:"left",clickCount:1});
  if(!await waitUntil(`window.__thoughtSaves===${thoughtSavesBeforeTagBlur+1}&&document.querySelector("#home-thought-editor").hidden`)){
    throw new Error(await evaluate(`JSON.stringify({events:window.__tagSubmitEvents,saves:window.__thoughtSaves,expected:${thoughtSavesBeforeTagBlur+1},active:document.activeElement?.id||"",status:document.querySelector("#chain-status").textContent,button:document.querySelector("#chain-submit").getBoundingClientRect().toJSON(),point:${JSON.stringify(tagSubmitPoint)},hit:document.elementFromPoint(${tagSubmitPoint.x},${tagSubmitPoint.y})?.id||""})`))
  }
  assert.deepEqual(await evaluate(`({view:document.querySelector(".view.active")?.id,path:location.pathname})`),{view:"view-thoughts",path:"/thoughts"},"submitting from thoughts must return to the thoughts list");
  assert.deepEqual(await evaluate(`window.__savedPayloads.at(-1).tags`),["标签","回归"]);
  const captureSavesBeforeKindChoice=await evaluate(`window.__captureSaves`);
  await evaluate(`(()=>{document.querySelector('[data-view="today"]').click();document.querySelector("#home-open-thought").click();const form=document.querySelector("#chain-form");form.elements.recordKind.value="capture";form.elements.recordKind[0].dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="从思考入口保存的一条念起";return true})()`);
  assert.deepEqual(await evaluate(`(()=>({title:document.querySelector("#home-thought-title").textContent,label:document.querySelector("#chain-primary-label").textContent.trim(),submit:document.querySelector("#chain-submit").textContent,thoughtFieldsHidden:[...document.querySelectorAll("[data-chain-thought-only]")].every(item=>item.hidden),target:[...document.querySelectorAll(".thought-record-kind span")].every(item=>item.getBoundingClientRect().height>=44)}))()`),{title:"记录念起",label:"内容 文字或图片至少一项 · 支持 Markdown",submit:"收进念起",thoughtFieldsHidden:true,target:true});
  await evaluate(`document.querySelector("#chain-form").requestSubmit();true`);
  if(!await waitUntil(`window.__captureSaves===${captureSavesBeforeKindChoice+1}&&document.querySelector("#chain-question").value===""`)){
    throw new Error(await evaluate(`JSON.stringify({captureSaves:window.__captureSaves,expected:${captureSavesBeforeKindChoice+1},kind:document.querySelector("#chain-form").elements.recordKind.value,question:document.querySelector("#chain-question").value,status:document.querySelector("#chain-status").textContent,toast:document.querySelector("#toast").textContent,buttonDisabled:document.querySelector("#chain-submit").disabled})`))
  }
  assert.deepEqual(await evaluate(`(()=>{const payload=window.__capturePayloads.at(-1),form=document.querySelector("#chain-form");return{content:payload.content,hasIdea:Object.hasOwn(payload,"idea"),kind:form.elements.recordKind.value,title:document.querySelector("#home-thought-title").textContent,chooserHidden:document.querySelector(".thought-record-kind").hidden}})()`),{content:"从思考入口保存的一条念起",hasIdea:false,kind:"thought",title:"记录思考",chooserHidden:false});
  await evaluate(`document.querySelector("#home-open-thought").click();document.querySelector("#chain-question").value="不应残留的冲突思考";window.__conflictThoughtCreate=true;document.querySelector("#chain-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#chain-status").textContent.includes("来源念起已变化")&&!document.querySelector('#chain-form [type="submit"]').disabled`),true);
  assert.deepEqual(await evaluate(`({stored:window.__thoughts.some(item=>item.content==="不应残留的冲突思考"),pending:[...document.querySelectorAll("[data-chain-id]")].some(item=>item.dataset.chainId.startsWith("pending:")),visible:[...document.querySelectorAll(".question-preview")].some(item=>item.textContent.includes("不应残留的冲突思考"))})`),{stored:false,pending:false,visible:false});
  const imageDiscardsBeforePendingThought=await evaluate(`window.__imageDiscards.length`),thoughtSavesBeforePending=await evaluate(`window.__thoughtSaves`);
  await evaluate(`(()=>{const form=document.querySelector("#chain-form");form.reset();const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),file=new File([bytes],"pending-thought.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#chain-question").value="带图的待同步思考";document.querySelector("#chain-answer").value="手写回答";window.__failThoughtCreateNetwork=true;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#chain-status").textContent.includes("网络恢复后自动同步")`),true);
  assert.deepEqual(await evaluate(`({discards:window.__imageDiscards.length,previews:document.querySelectorAll('[data-content-image-editor="thoughtRoot"] figure').length})`),{discards:imageDiscardsBeforePendingThought,previews:0});
  await evaluate(`window.__failThoughtCreateNetwork=false;window.dispatchEvent(new Event("online"));true`);
  assert.equal(await waitUntil(`window.__thoughtSaves===${thoughtSavesBeforePending+1}`,160,25),true);
  await evaluate(`document.querySelector('[data-home-editor-close="thought"]').click();true`);
  await evaluate(`document.querySelector('[data-section="mine"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-mine").classList.contains("active")&&!document.querySelector("#view-mine").inert&&!document.querySelector("#view-mine").hasAttribute("aria-busy")`),true);
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
  assert.deepEqual(mineDesktop, { active:true, sectionHidden:true, account:"owner", rows:["owner","统计","通知","回收站","数据导出","个人概要","设置","产品反馈","AI 成本","架构设计","商业化","关于"], summaries:true, governance:{hidden:false,path:"/platform/"}, sidebarVersion:"v0.2.0", mineVersion:"v0.2.0", noOverflow:true });
  const mineDesktopScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-mine-desktop.png", Buffer.from(mineDesktopScreenshot.data, "base64"));
  await evaluate(`document.querySelector('#view-mine [data-view="personal-context"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("#personal-context-summary .personal-context-conclusion").length===3`),true);
  await evaluate(`document.querySelector("#toast").hidden=true;document.querySelectorAll(".modal-backdrop,.home-v02-editor-backdrop").forEach(item=>item.hidden=true);true`);
  assert.deepEqual(await evaluate(`(()=>({active:document.querySelector("#view-personal-context").classList.contains("active"),meta:document.querySelectorAll("#personal-context-meta>div").length,types:[...document.querySelectorAll("#personal-context-summary .personal-context-conclusion")].map(item=>item.dataset.contextType),collapsed:[...document.querySelectorAll("#personal-context-summary .personal-context-conclusion")].every(item=>!item.open),sources:document.querySelectorAll("#personal-context-source-list .context-source-item").length,claims:document.querySelectorAll("#personal-context-claims [data-claim-id]").length,permissions:document.querySelectorAll("#personal-context-permissions [data-permission-index]").length,syntheses:document.querySelectorAll("#personal-context-syntheses article[data-synthesis-id]").length,disputed:document.querySelector("#personal-context-claims").textContent.includes("来源已变化"),manualButton:!document.querySelector("#personal-context-run-synthesis").disabled,noOverflow:document.documentElement.scrollWidth<=innerWidth}))()`),{active:true,meta:4,types:["user_fact","user_viewpoint","model_summary"],collapsed:true,sources:2,claims:3,permissions:1,syntheses:1,disputed:true,manualButton:true,noOverflow:true});
  await evaluate(`(()=>{const form=document.querySelector('[data-claim-id="context-active"] [data-claim-form]');form.elements.statement.value="";form.querySelector('[data-claim-action="revise"]').click();return true})()`);
  await sleep(80);
  assert.equal(await evaluate(`window.__personalContext.userModel.claims.find(item=>item.id==="context-active").version`),2);
  await evaluate(`(()=>{const form=document.querySelector('[data-claim-id="context-active"] [data-claim-form]');form.elements.statement.value="保持稳定推进并减少切换";form.requestSubmit();return true})()`);
  if(!await waitUntil(`document.querySelector('[data-claim-id="context-active"] textarea')?.value==="保持稳定推进并减少切换"&&window.__personalContext.userModel.claims.find(item=>item.id==="context-active").version===3`)){
    throw new Error(await evaluate(`JSON.stringify({claim:window.__personalContext.userModel.claims.find(item=>item.id==="context-active"),value:document.querySelector('[data-claim-id="context-active"] textarea')?.value||"",status:document.querySelector('[data-claim-id="context-active"] [data-claim-status]')?.textContent||"",requests:window.__apiRequests.slice(-10)})`))
  }
  await evaluate(`(()=>{const input=document.querySelector('#personal-context-permissions [data-permission-field="learningAllowed"]');input.checked=true;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`window.__personalContext.sourcePermissions[0].revision===2&&document.querySelector('#personal-context-permissions [data-permission-field="learningAllowed"]')?.checked`),true);
  assert.equal(await evaluate(`window.__personalContext.sourcePermissions[0].learningStatus`),"queued");
  await evaluate(`document.querySelector('[data-synthesis-id="context-synthesis"] [data-synthesis-action="confirm"]').click();true`);
  assert.equal(await waitUntil(`window.__personalContext.periodicSyntheses[0].reviewStatus==="confirmed"&&document.querySelector("#personal-context-syntheses").textContent.includes("已确认")`),true);
  await sleep(250);
  await fs.writeFile("/tmp/growth-personal-context-desktop.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await evaluate(`document.querySelector("#personal-context-permissions").scrollIntoView({block:"start",behavior:"instant"});true`);
  await sleep(100);
  assert.equal(await evaluate(`[...document.querySelectorAll(".personal-context-governance-item")].every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  await fs.writeFile("/tmp/growth-personal-context-governance-desktop.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#personal-context-meta").getBoundingClientRect().right<=innerWidth`),true);
  await evaluate(`document.querySelector("#personal-context-synthesis-title").scrollIntoView({block:"start",behavior:"instant"});true`);
  await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#personal-context-syntheses").getBoundingClientRect().right<=innerWidth&&document.querySelector("#personal-context-run-synthesis").getBoundingClientRect().height>=44`),true);
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
    serviceUsage:document.querySelector("#ai-service-summary").textContent.includes("120 字符")&&document.querySelector("#ai-service-summary").textContent.includes("1.5 秒")&&document.querySelector("#ai-service-summary").textContent.includes("2 次 API 调用"),
    serviceFailure:document.querySelector("#ai-service-summary").textContent.includes("1 / 1"),
    audioKnownCost:document.querySelector("#ai-modality-summary").textContent.includes("¥0.0364")&&!document.querySelector("#ai-modality-summary").textContent.includes("次待账单"),
    pricingSources:document.querySelectorAll("#ai-pricing a").length,
    pageUnit:document.querySelector("#ai-service-summary").textContent.includes("3 页"),
    imageKpi:[...document.querySelectorAll("#ai-kpis article")].find(item=>item.querySelector("span").textContent==="图片理解")?.querySelector("strong").textContent,
    cnyOnly:document.querySelector("#view-statistics").textContent.includes("¥")&&!document.querySelector("#view-statistics").textContent.includes("$")&&document.querySelector("#view-statistics").textContent.includes("历史")&&document.querySelector("#view-statistics").textContent.includes("账本"),
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  }))()`);
  assert.deepEqual(statisticsDesktop, { active:true, sectionHidden:true, recordTotal:"41", groups:["今日","所见","所思","互动"], daily:4, charts:6, title:"多供应商服务用量看板", providers:3, services:7, modalities:4, providerPending:false, serviceNames:["DeepSeek 文本","DeepSeek 图片理解","豆包语音合成","豆包语音识别","火山文字识别","火山文档解析","阿里云图片分割"], serviceUsage:true, serviceFailure:true, audioKnownCost:true, pricingSources:7, pageUnit:true, imageKpi:"4", cnyOnly:true, noOverflow:true });
  assert.deepEqual(await evaluate(`[...document.querySelectorAll("#ai-cost-charts>section")].map(section=>[...section.querySelectorAll(".analytics-grid text")].map(item=>item.textContent).filter(value=>value.includes("¥")))`),[
    ["¥0.00","¥0.002560","¥0.005120"],
    ["¥0.00","¥0.008100","¥0.0162"],
    ["¥0.00"],
    ["¥0.00","<¥0.000001","<¥0.000001"]
  ]);
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
  assert.equal(await waitUntil(`document.querySelectorAll("#ai-cost-scenario-rows tr").length===15&&document.querySelectorAll("#ai-cost-kpis article").length===4&&document.querySelectorAll("#ai-budget-kpis article").length===4`),true);
  assert.equal(await evaluate(`window.__stateRequests`),stateRequestsBeforeAiCost);
  const aiCostInitial=await evaluate(`({
    active:document.querySelector("#view-ai-cost").classList.contains("active"),
    rows:document.querySelectorAll("#ai-cost-scenario-rows tr").length,
    recommendations:document.querySelectorAll("#ai-cost-recommendations li").length,
    currentModel:document.querySelector('[data-ai-cost-row="thoughtAnswer"] td:nth-child(2) strong').textContent,
    projectedIsCny:document.querySelector("#ai-cost-kpis strong").textContent.startsWith("¥"),
    p90:[...document.querySelectorAll("#ai-cost-observed dt")].find(item=>item.textContent==="P90 单次")?.nextElementSibling.textContent,
    pendingCost:document.querySelector("#ai-cost-observed").textContent.includes("4 次费用待账单"),
    dailyBudget:document.querySelector("#ai-budget-kpis article strong").textContent,
    unknownBlocked:document.querySelector("#ai-budget-kpis article:nth-child(3)").classList.contains("blocked"),
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  })`);
  assert.deepEqual(aiCostInitial,{active:true,rows:15,recommendations:5,currentModel:"Pro · Ultra",projectedIsCny:true,p90:"¥0.0410",pendingCost:false,dailyBudget:"¥15.0 / ¥100",unknownBlocked:true,noOverflow:true});
  await evaluate(`(()=>{document.querySelector("#ai-budget-add-amount").value="10";document.querySelector("#ai-budget-add-reason").value="UI 临时窗口";document.querySelector("#ai-budget-add-form").requestSubmit()})();true`);
  assert.equal(await waitUntil(`window.__aiBudgetCommands===1&&document.querySelector("#ai-budget-status").textContent.includes("已追加")`),true);
  assert.equal(await evaluate(`document.querySelector("#ai-budget-kpis article strong").textContent`),"¥15.0 / ¥110");
  await evaluate(`(()=>{document.querySelector("#ai-budget-recover-scope").value="dailyUnknownCost";document.querySelector("#ai-budget-recover-reason").value="UI 恢复验证";document.querySelector("#ai-budget-recover-form").requestSubmit()})();true`);
  assert.equal(await waitUntil(`window.__aiBudgetCommands===2&&!document.querySelector("#ai-budget-kpis article:nth-child(3)").classList.contains("blocked")`),true);
  const thoughtAnswerCostBefore=await evaluate(`document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-row-total]').textContent`);
  await evaluate(`(()=>{const field=document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-field="callsPerMonth"]');field.value="40";field.dispatchEvent(new Event("input",{bubbles:true}))})();true`);
  assert.notEqual(await evaluate(`document.querySelector('[data-ai-cost-row="thoughtAnswer"] [data-ai-cost-row-total]').textContent`),thoughtAnswerCostBefore);
  await evaluate(`document.querySelector("#ai-cost-calibrate").click();true`);
  assert.deepEqual(await evaluate(`({enabled:document.querySelectorAll("#ai-cost-scenario-rows tr:not(.disabled)").length,projected:document.querySelector("#ai-cost-kpis strong").textContent})`),{enabled:3,projected:"¥0.363"});
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
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth&&getComputedStyle(document.querySelector(".ai-cost-kpis")).gridTemplateColumns.split(" ").length===2&&getComputedStyle(document.querySelector(".ai-budget-kpis")).gridTemplateColumns.split(" ").length===1`),true);
  const aiCostMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-ai-cost-mobile.png",Buffer.from(aiCostMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await evaluate(`window.__ownerSurfaceRequests`),[]);
  await evaluate(`document.querySelector('[data-view="architecture"]').click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("[data-architecture-stage]").length===5`),true);
  assert.deepEqual(await evaluate(`({
    active:document.querySelector("#view-architecture").classList.contains("active"),
    stages:document.querySelectorAll("[data-architecture-stage]").length,
    kpis:document.querySelectorAll("#architecture-kpis article").length,
    currentSpec:/2 vCPU \\/ 1\\.57 GiB/.test(document.querySelector("#architecture-main-path").textContent)&&/40 GB/.test(document.querySelector("#architecture-support-paths").textContent),
    layers:document.querySelectorAll("#architecture-layer-list article").length,
    terms:document.querySelectorAll("[data-architecture-term]").length,
    noOverflow:document.documentElement.scrollWidth<=window.innerWidth
  })`),{active:true,stages:5,kpis:4,currentSpec:true,layers:8,terms:12,noOverflow:true});
  assert.deepEqual(await evaluate(`window.__ownerSurfaceRequests`),["/api/owner/surfaces/architecture"]);
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
  assert.deepEqual(commercialValidation, { active:true, mode:"有偿调研", kpis:["¥503","¥300","¥960","¥1763"], evidence:"1 条", paid:"待记录", aiSample:"暂无", models:4, profiles:4, profileSummaries:4, observedMetrics:6, stage:"内部验证期", paths:6, gates:3, noOverflow:true });
  assert.equal(await evaluate(`window.__ownerSurfaceRequests.filter(url=>url.startsWith("/api/owner/surfaces/commercialization")).length`),1);
  await evaluate(`document.querySelector('[data-commercial-mode="subscription"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#commercial-breakdown-title").textContent==="首月订阅经营账"`),true);
  const commercialSubscription=await evaluate(`({
    title:document.querySelector("#commercial-breakdown-title").textContent,
    kpiCount:document.querySelectorAll("#commercial-kpis strong").length,
    hiddenValidation:document.querySelector('[data-commercial-assumption-group="validation"]').hidden,
    visibleSubscription:!document.querySelector('[data-commercial-assumption-group="subscription"]').hidden,
    cashflowRows:document.querySelectorAll("#commercial-cashflow-rows tr").length,
    cashflowRange:document.querySelector("#commercial-cashflow-range").textContent,
    weightedCost:document.querySelector("#commercial-profile-summary article:last-child strong").textContent
  })`);
  assert.deepEqual(commercialSubscription, { title:"首月订阅经营账", kpiCount:4, hiddenValidation:true, visibleSubscription:true, cashflowRows:6, cashflowRange:"统计 2026-09 至 2027-02，共 6 个月；工时单价 ¥80.0/小时", weightedCost:"¥1.99/人/月" });
  await evaluate(`document.querySelector(".commercial-profile-summary").scrollIntoView({block:"start"});true`);
  await sleep(120);
  const commercializationUsageScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-usage-desktop.png",Buffer.from(commercializationUsageScreenshot.data,"base64"));
  await evaluate(`const slider=document.querySelector("#commercial-stage-slider");slider.value="2";slider.dispatchEvent(new Event("input",{bubbles:true}));true`);
  assert.equal(await waitUntil(`document.querySelector("#commercial-stage-name").textContent==="快速上升期"`),true);
  assert.deepEqual(await evaluate(`({stage:document.querySelector("#commercial-stage-name").textContent,dau:document.querySelector('[data-commercial-field="subscription.dailyActiveUsers"]').value,mau:document.querySelector('[data-commercial-field="subscription.monthlyActiveUsers"]').value,months:document.querySelectorAll("#commercial-cashflow-rows tr").length})`),{stage:"快速上升期",dau:"10000",mau:"40000",months:18});
  await evaluate(`document.querySelector(".commercial-stage-control").scrollIntoView({block:"start"});true`);
  await sleep(120);
  const commercializationStageScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-commercialization-stage-desktop.png",Buffer.from(commercializationStageScreenshot.data,"base64"));
  await evaluate(`document.querySelector('[data-commercial-mode="delivery"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#commercial-breakdown-title").textContent==="一次性交付与托管预存账"`),true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll("#commercial-kpis strong")].map(item=>item.textContent)`),["¥1388","¥1140","¥57.6","-¥357"]);
  assert.match(await evaluate(`document.querySelector("#commercial-method-note").textContent`),/BYOK.+合同负债/);
  await evaluate(`document.querySelector('[data-commercial-mode="usagePack"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#commercial-breakdown-title").textContent==="用量增值包月度账"`),true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll("#commercial-kpis strong")].map(item=>item.textContent)`),["¥290","¥17.5","¥161","¥0.900"]);
  await evaluate(`document.querySelector('[data-commercial-mode="subscription"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#commercial-breakdown-title").textContent==="首月订阅经营账"`),true);
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
  assert.equal(
    await waitUntil(`document.querySelectorAll("#account-role-list .account-role-row").length===2`),
    true,
    JSON.stringify({
      page: await evaluate(`({active:document.querySelector(".view.active")?.id,busy:document.querySelector("#view-account").getAttribute("aria-busy"),roles:document.querySelector("#account-role-list").textContent,toast:document.querySelector("#toast").textContent,requests:window.__apiRequests.slice(-12)})`),
      exceptions: cdp.events.filter(event=>event.method==="Runtime.exceptionThrown").slice(-3).map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
    })
  );
  assert.deepEqual(await evaluate(`({
    active:document.querySelector("#view-account").classList.contains("active"),
    authenticated:!document.querySelector("#account-authenticated").hidden,
    localHidden:document.querySelector("#account-local-mode").hidden,
    username:document.querySelector("#account-username").value,
    roleRows:document.querySelectorAll("#account-role-list .account-role-row").length
  })`), { active: true, authenticated: true, localHidden: true, username: "owner", roleRows: 2 });
  await evaluate(`(()=>{const select=document.querySelector('[data-account-role="member-1"]');select.value="owner";document.querySelector('[data-account-role-save="member-1"]').click();return true})()`);
  assert.equal(await waitUntil(`window.__roleChanges===1&&document.querySelector('[data-account-user="member-1"] small').textContent.includes("Owner")`),true);
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
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  assert.deepEqual(await evaluate(`(() => {const rate=document.querySelector("#tts-generation-rate"),voice=document.querySelector("#tts-default-voice"),preview=document.querySelector("#tts-voice-preview"),assistant=document.querySelector("#assistant-name").closest("label"),exclusive=document.querySelector("[data-exclusive-agent-comment]");return{profileModels:document.querySelectorAll("[data-profile-model]").length,profileEfforts:document.querySelectorAll("[data-profile-effort]").length,sceneTiers:document.querySelectorAll("[data-ai-scenario]").length,annotationSceneTiers:document.querySelectorAll('[data-ai-scenario="annotationShenji"]').length,sceneEfforts:document.querySelectorAll("[data-ai-effort]").length,responseStyles:document.querySelectorAll("[data-response-style]").length,annotationStyles:document.querySelectorAll('[data-response-style="annotationShenji"]').length,exclusiveLabel:exclusive?.querySelector("span")?.textContent,exclusiveAfterAssistant:assistant.nextElementSibling===exclusive,voice:voice.value,voices:voice.options.length,previewName:preview.getAttribute("aria-label"),previewTitle:preview.title,min:rate.min,max:rate.max,value:rate.value,accessibleName:rate.getAttribute("aria-label"),valueText:rate.getAttribute("aria-valuetext"),label:document.querySelector("#tts-generation-rate-value").textContent}})()`), {
    profileModels: 4,
    profileEfforts: 0,
    sceneTiers: 15,
    annotationSceneTiers: 0,
    sceneEfforts: 16,
    responseStyles: 7,
    annotationStyles: 1,
    exclusiveLabel: "专属智能体评论",
    exclusiveAfterAssistant: true,
    voice: "zh_male_shaonianzixin_uranus_bigtts",
    voices: 4,
    previewName: "播放所选官方音色试音",
    previewTitle: "播放所选官方音色试音",
    min: "-50",
    max: "100",
    value: "-10",
    accessibleName: "默认生成语速",
    valueText: "0.90倍",
    label: "0.90×"
  });
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("已加载")`), true);
  await evaluate(`(()=>{const form=document.querySelector("#opening-preferences-form");form.elements.density.value="8";form.elements.density.dispatchEvent(new Event("input",{bubbles:true}));window.__openingPreferences.revision++;form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("草稿已保留")`), true);
  assert.equal(await evaluate(`document.querySelector("#opening-preferences-form").elements.density.value`), "8");
  await evaluate(`document.querySelector('[data-opening-action="reload"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("草稿已恢复")`), true);
  await evaluate(`document.querySelector("#opening-preferences-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("已保存")&&window.__openingPreferences.revision===2`), true);
  assert.equal(await evaluate(`sessionStorage.getItem("cike:opening-draft:user-1")`), null);
  await evaluate(`(()=>{const field=document.querySelector("#opening-preferences-form").elements.density;field.value="6";field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector('[data-view="today"]').click();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#view-today").classList.contains("active")`), true);
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("草稿已恢复")&&!document.querySelector("#view-settings").inert`), true);
  assert.equal(await evaluate(`document.querySelector("#opening-preferences-form").elements.density.value`), "6");
  await evaluate(`document.querySelector('[data-opening-action="reset"]').click();document.querySelector("#opening-preferences-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#opening-preferences-status").textContent.includes("已保存")&&window.__openingPreferences.revision===3`), true);
  await evaluate(`document.querySelector("#tts-voice-preview").click();true`);
  assert.equal(await waitUntil(`window.__speechStaticPreviewRequests.length===1&&window.__speechPreviewRequests.length===0&&!window.__lastSpeechAudio.paused&&document.querySelector("#tts-voice-preview").getAttribute("aria-label")==="停止官方音色试音"`),true);
  assert.equal(await evaluate(`window.__speechStaticPreviewRequests[0]`),"/assets/audio/voice-previews/zh_male_shaonianzixin_uranus_bigtts.mp3");
  await evaluate(`(()=>{const select=document.querySelector("#tts-default-voice");window.__previewUrlBeforeSwitch=window.__lastSpeechAudio.src;select.value="zh_male_m191_uranus_bigtts";select.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.deepEqual(await evaluate(`({stopped:window.__lastSpeechAudio.paused,revoked:window.__speechRevokedUrls.includes(window.__previewUrlBeforeSwitch),name:document.querySelector("#tts-voice-preview").getAttribute("aria-label"),status:document.querySelector("#tts-voice-preview-status").textContent})`),{stopped:true,revoked:true,name:"播放所选官方音色试音",status:""});
  await evaluate(`window.__failSpeechPreview=true;document.querySelector("#tts-voice-preview").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#tts-voice-preview-status").textContent==="试音暂时不可用，请稍后再试。"`),true);
  assert.equal(await evaluate(`!document.body.textContent.includes("PREVIEW_PROVIDER_PRIVATE")`),true);
  await evaluate(`document.querySelector("#tts-voice-preview").click();true`);
  assert.equal(await waitUntil(`window.__speechPreviewRequests.length===1&&!window.__lastSpeechAudio.paused`),true);
  await evaluate(`window.__previewUrlBeforeLeave=window.__lastSpeechAudio.src;document.querySelector("#view-settings .mine-back").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-mine").classList.contains("active")&&!document.querySelector("#view-mine").inert&&!document.querySelector("#view-mine").hasAttribute("aria-busy")`),true);
  assert.deepEqual(await evaluate(`({stopped:window.__lastSpeechAudio.paused,revoked:window.__speechRevokedUrls.includes(window.__previewUrlBeforeLeave),active:document.querySelector("#view-mine").classList.contains("active")})`),{stopped:true,revoked:true,active:true});
  await evaluate(`document.querySelector('#view-mine [data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-profile-model="lite"]').value = "deepseek-v4-pro";document.querySelector('[data-ai-scenario="diaryLead"]').value = "ultra";document.querySelector("#assistant-name").value="照见";document.querySelector('[data-response-style="thoughtAnswer"]').value="deep";document.querySelector('[data-response-style="annotationShenji"]').value="structured";document.querySelector("#tts-default-voice").value="zh_male_m191_uranus_bigtts";const rate=document.querySelector("#tts-generation-rate");rate.value="25";rate.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#llm-settings-form").requestSubmit(); true`);
  assert.equal(await waitUntil(`window.__settingsSaves === 1`), true);
  const savedSettings = await evaluate(`({ model: document.querySelector('[data-profile-model="lite"]').value, preservedProfileEffort:window.__lastSettingsPayload.profiles.lite.effort, scene: document.querySelector('[data-ai-scenario="diaryLead"]').value, preservedAnnotationScenario:window.__lastSettingsPayload.scenarios.annotationShenji, name:document.querySelector("#assistant-name").value, style:document.querySelector('[data-response-style="thoughtAnswer"]').value, annotationStyle:window.__lastSettingsPayload.responseStyles.annotationShenji, defaultVoice:window.__lastSettingsPayload.speech.defaultVoice, generationRate:window.__lastSettingsPayload.speech.generationRate, existingAssetVoice:window.__speechAssets.find(asset=>asset.id==="asset-answer-kept-v1")?.voice, rateLabel:document.querySelector("#tts-generation-rate-value").textContent, rateValueText:document.querySelector("#tts-generation-rate").getAttribute("aria-valuetext") })`);
  assert.deepEqual(savedSettings, { model: "deepseek-v4-pro", preservedProfileEffort:"max", scene:"ultra", preservedAnnotationScenario:"high", name:"照见", style:"deep", annotationStyle:"structured", defaultVoice:"zh_male_m191_uranus_bigtts", generationRate:25, existingAssetVoice:"zh_male_shaonianzixin_uranus_bigtts", rateLabel:"1.25×", rateValueText:"1.25倍" });
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
  assert.equal(await waitUntil(`document.querySelector("#view-mine").classList.contains("active")&&!document.querySelector("#view-mine").inert&&!document.querySelector("#view-mine").hasAttribute("aria-busy")`),true);
  assert.deepEqual(await evaluate(`({active:document.querySelector("#view-mine").classList.contains("active"),version:document.querySelector("#mine-app-version").textContent,centered:getComputedStyle(document.querySelector("#mine-app-version")).textAlign==="center",noOverflow:document.documentElement.scrollWidth<=window.innerWidth})`),{active:true,version:"v0.2.0",centered:true,noOverflow:true});
  const mineMobileScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile("/tmp/growth-mine-mobile.png", Buffer.from(mineMobileScreenshot.data, "base64"));
  await evaluate(`document.querySelector('#view-mine [data-view="about"]').click(); true`);
  assert.equal(await waitUntil(`document.querySelector("#view-about").classList.contains("active")&&!document.querySelector("#view-about").inert&&!document.querySelector("#view-about").hasAttribute("aria-busy")`),true);
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
  assert.equal(await waitUntil(`document.querySelector("#view-about").classList.contains("active")&&!document.querySelector("#view-about").inert&&!document.querySelector("#view-about").hasAttribute("aria-busy")`),true);
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
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] .chain-summary')`),true);
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"] .chain-summary').click();true`);
  assert.equal(await waitUntil(`location.pathname==="/thoughts/kept-root"&&document.querySelector('#all-thoughts [data-chain-id="kept-root"]')?.open`),true);
  assert.equal(await evaluate(`(() => { const before=window.__deleteRequests;window.confirm=()=>false;document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-delete-chain]').click();return window.__deleteRequests===before; })()`),true);
  const chainSpeechRequestsBefore=await evaluate(`window.__speechRequests.length`);
  const chainSpeechState=await evaluate(`(()=>{const controls=document.querySelector('#all-thoughts [data-chain-id="kept-root"]').closest(".thought-timeline-entry").querySelector(".thought-chain-speech .speech-asset-controls"),player=controls.querySelector("[data-speech-player]"),source=window.__thoughts.find(item=>item.id==="kept-root");return{sourceType:controls.dataset.speechSourceType,sourceId:controls.dataset.speechSourceId,sourceVersion:Number(controls.dataset.speechSourceVersion),currentVersion:source.version,hasPlayer:Boolean(player),button:controls.querySelector("[data-speech-synthesize]").textContent}})()`);
  assert.deepEqual(chainSpeechState,{sourceType:"thoughtChain",sourceId:"kept-root",sourceVersion:chainSpeechState.currentVersion,currentVersion:chainSpeechState.currentVersion,hasPlayer:false,button:"生成"});
  await evaluate(`document.querySelector('#all-thoughts [data-chain-id="kept-root"]').closest(".thought-timeline-entry").querySelector(".thought-chain-speech [data-speech-synthesize]").click();true`);
  assert.equal(await waitUntil(`window.__speechRequests.length===${chainSpeechRequestsBefore+1}&&document.querySelector(".thought-chain-speech [data-speech-player]")?.getAttribute("src").includes("asset-generated-")`),true);
  assert.deepEqual(await evaluate(`window.__speechRequests.at(-1)`),{sourceType:"thoughtChain",sourceId:"kept-root",sourceVersion:chainSpeechState.currentVersion,regenerate:false});
  assert.deepEqual(await evaluate(`(() => {const block=document.querySelector('#all-thoughts [data-thought-block-id="answer-kept"]'),controls=block.querySelector(".speech-asset-controls"),player=controls.querySelector("[data-speech-player]"),rate=controls.querySelector("[data-speech-playback-rate]");return{sourceType:controls.dataset.speechSourceType,sourceId:controls.dataset.speechSourceId,sourceVersion:controls.dataset.speechSourceVersion,src:player.getAttribute("src"),button:controls.querySelector("[data-speech-synthesize]").textContent,buttonName:controls.querySelector("[data-speech-synthesize]").getAttribute("aria-label"),rateName:rate.getAttribute("aria-label")}})()`),{sourceType:"thoughtAnswer",sourceId:"answer-kept",sourceVersion:"1",src:"/api/speech/audio?id=asset-answer-kept-v1",button:"重新生成",buttonName:"重新生成AI 回答文字朗读",rateName:"AI 回答文字朗读播放倍速"});
  const thoughtAnswerSpeechRequestsBefore=await evaluate(`window.__speechRequests.length`);
  await evaluate(`document.querySelector('#all-thoughts [data-thought-block-id="answer-kept"] [data-speech-synthesize]').click();true`);
  assert.equal(await waitUntil(`window.__speechRequests.length===${thoughtAnswerSpeechRequestsBefore+1}&&document.querySelector('#all-thoughts [data-thought-block-id="answer-kept"] [data-speech-player]')?.getAttribute("src").includes("asset-generated-")`),true);
  assert.deepEqual(await evaluate(`({request:window.__speechRequests.at(-1),voice:window.__speechAssets.find(asset=>asset.sourceType==="thoughtAnswer"&&asset.sourceId==="answer-kept")?.voice,open:document.querySelector('#all-thoughts [data-chain-id="kept-root"]').open})`),{request:{sourceType:"thoughtAnswer",sourceId:"answer-kept",sourceVersion:1,regenerate:true},voice:"zh_male_m191_uranus_bigtts",open:true});
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);
  assert.equal(await evaluate(`(()=>{const controls=document.querySelector('#all-thoughts [data-thought-block-id="answer-kept"] .speech-asset-controls'),button=controls.querySelector("button").getBoundingClientRect(),select=controls.querySelector("select").getBoundingClientRect(),card=controls.closest(".thought-content-block").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&button.width>=44&&button.height>=44&&select.width>=44&&select.height>=44&&controls.getBoundingClientRect().right<=card.right+.5})()`),true);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.confirm=()=>true;window.__conflictThoughtDelete=true;window.__failNextStateRefresh=true;document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-delete-chain]').click();true`);
  const conflictedThoughtDelete=await waitUntil(`location.pathname==="/thoughts/kept-root"&&!document.querySelector('[data-route-result="unavailable"]')&&document.querySelector('#all-thoughts [data-chain-id="kept-root"]')?.open&&document.querySelector("#toast").textContent.includes("资源版本已变化")`);
  assert.equal(conflictedThoughtDelete,true,JSON.stringify(await evaluate(`({toast:document.querySelector("#toast").textContent,root:Boolean(document.querySelector('#all-thoughts [data-chain-id="kept-root"]')),route:location.pathname,requests:window.__apiRequests.slice(-8)})`)));
  await evaluate(`window.__failThoughtDeleteNetwork=true;document.querySelector('#all-thoughts [data-chain-id="kept-root"] [data-delete-chain]').click();true`);
  const pendingThoughtDelete=await waitUntil(`!document.querySelector('#all-thoughts [data-chain-id="kept-root"]')&&document.querySelector("#toast").textContent.includes("网络恢复后移入回收站")`);
  assert.equal(pendingThoughtDelete,true,JSON.stringify(await evaluate(`({toast:document.querySelector("#toast").textContent,root:Boolean(document.querySelector('#all-thoughts [data-chain-id="kept-root"]')),route:location.pathname,requests:window.__apiRequests.slice(-8)})`)));
  await evaluate(`document.querySelector('[data-view="daily"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#view-daily").inert&&!document.querySelector("#view-daily").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-daily-tab="exercise"]').click();window.__pasteHealth();window.__delayParseKind="exercise";window.__releaseParse=null;document.querySelector("#parse-health-images").click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseParse==="function"`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-capture-id="capture-1"] [data-speech-player]')`),true);
  await evaluate(`window.__logoutSpeechPlayer=document.querySelector('[data-capture-id="capture-1"] [data-speech-player]');window.__logoutSpeechUrl=window.__logoutSpeechPlayer.getAttribute("src");window.__logoutSpeechPlayer.play();true`);
  assert.equal(await waitUntil(`!window.__logoutSpeechPlayer.paused`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();document.querySelector("#chain-question").value="账户 A 的在途草稿";document.querySelector("#chain-answer").value="";document.querySelector("#draft-answer-button").click();true`);
  assert.deepEqual(await evaluate(`({paused:window.__logoutSpeechPlayer.paused,retained:window.__logoutSpeechPlayer.getAttribute("src")===window.__logoutSpeechUrl,revoked:window.__speechRevokedUrls.includes(window.__logoutSpeechUrl)})`),{paused:true,retained:true,revoked:false});
  assert.equal(await waitUntil(`window.__reasoningChunks===1`,40,10),true);
  await evaluate(`(()=>{const file=new File([new Uint8Array([1,2,3])],"thought-draft.png",{type:"image/png"}),transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector("#thought-root-images");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:thoughtRoot");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.items?.[0]?.name==="thought-draft.png")}})`),true);
  await evaluate(`document.querySelector('[data-section="mine"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-mine").classList.contains("active")&&!document.querySelector("#view-mine").inert&&!document.querySelector("#view-mine").hasAttribute("aria-busy")&&document.querySelector("#section-nav").hidden`),true);
  const accountSwitchCoreRequests = await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`);
  await evaluate(`window.__delayLogout=true;document.querySelector("#logout-button").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#auth-gate").hidden`),true);
  assert.equal(await evaluate(`sessionStorage.getItem("cike:session-drafts:user-1")`),null);
  assert.deepEqual(await evaluate(`({locked:document.body.classList.contains("auth-locked"),privateSurfaceHidden:getComputedStyle(document.querySelector("main")).visibility==="hidden",logoutPending:typeof window.__releaseLogout==="function",speechPaused:window.__logoutSpeechPlayer.paused,speechRetained:window.__logoutSpeechPlayer.getAttribute("src")===window.__logoutSpeechUrl,speechRevoked:window.__speechRevokedUrls.includes(window.__logoutSpeechUrl)})`),{locked:true,privateSurfaceHidden:true,logoutPending:true,speechPaused:true,speechRetained:true,speechRevoked:false});
  await evaluate(`window.__releaseLogout();true`);
  assert.equal(await waitUntil(`[...document.querySelectorAll(".auth-form input,.auth-form button,[data-auth-tab]")].every(item=>!item.disabled)`),true);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:thoughtRoot");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(!request.result)}})`),true);
  await evaluate(`window.__delaySecondState=true;window.__delayLogin=true;(() => { const loginForm=document.querySelector("#login-form");loginForm.elements.username.value="second";loginForm.elements.password.value="shenji";loginForm.requestSubmit();return true; })()`);
  assert.equal(await waitUntil(`typeof window.__releaseLogin==="function"`),true);
  assert.equal(await evaluate(`[...document.querySelectorAll(".auth-form input,.auth-form button,[data-auth-tab]")].every(item=>item.disabled)`),true);
  await evaluate(`window.__releaseLogin();true`);
  assert.equal(await waitUntil(`document.querySelector("#account-name").textContent==="second"&&typeof window.__releaseSecondState==="function"`),true,JSON.stringify({page:await evaluate(`({status:document.querySelector("#auth-status").textContent,account:document.querySelector("#account-name").textContent,requests:window.__apiRequests.slice(-8)})`),exceptions:cdp.events.filter(event=>event.method==="Runtime.exceptionThrown").slice(-3).map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)}));
  assert.deepEqual(await evaluate(`({locked:document.body.classList.contains("auth-locked"),gateVisible:!document.querySelector("#auth-gate").hidden,privateSurfaceHidden:getComputedStyle(document.querySelector("main")).visibility==="hidden"})`),{locked:true,gateVisible:true,privateSurfaceHidden:true});
  await evaluate(`window.__releaseSecondState();true`);
  assert.equal(await waitUntil(`document.querySelector("#account-name").textContent==="second"&&document.querySelector("#auth-gate").hidden&&!document.body.classList.contains("auth-locked")`),true);
  assert.equal(await waitUntil(`window.__apiRequests.filter(value=>value==="GET /api/local-test-mode").length===${accountSwitchCoreRequests[3] + 1}`),true);
  const accountSwitchCoreDeltas = (
    await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`)
  ).map((value,index)=>value-accountSwitchCoreRequests[index]);
  if (JSON.stringify(accountSwitchCoreDeltas) !== JSON.stringify([0, 1, 1, 1])) {
    throw new Error(`new login must load the new account snapshot once: ${JSON.stringify({
      deltas: accountSwitchCoreDeltas,
      requests: await evaluate(`window.__apiRequests.slice(-30)`)
    })}`);
  }
  assert.deepEqual(await evaluate(`(() => {
    const links=document.querySelector("[data-section-links='today']");
    return {
      view:document.querySelector(".view.active")?.id,
      navHidden:document.querySelector("#section-nav").hidden,
      groupHidden:links.hidden,
      labels:[...links.querySelectorAll("button")].map(button=>button.textContent),
      selected:links.querySelector("[aria-current='page']")?.textContent,
      primary:document.querySelector(".nav-button.active")?.dataset.section
    };
  })()`),{view:"view-today",navHidden:false,groupHidden:false,labels:["此刻","共参","每日"],selected:"此刻",primary:"today"},"home-group-navigation-stability");
  await evaluate(`window.__releaseParse();true`);
  await sleep(1000);
  assert.equal(await evaluate(`document.querySelector("#chain-answer").value===""&&document.querySelector("#ai-answer-modal").hidden`),true);
  assert.deepEqual(await evaluate(`({
    empty:[...document.querySelectorAll('[data-daily-form="weight"] input,[data-daily-form="exercise"] input')].filter(input=>!["occurredAt","clothing"].includes(input.name)).every(input=>input.value===""),
    previews:document.querySelectorAll("#health-image-previews figure").length,
    values:[...document.querySelectorAll('[data-daily-form="weight"] input,[data-daily-form="exercise"] input')].filter(input=>!["occurredAt","clothing"].includes(input.name)&&input.value!=="").map(input=>[input.name,input.value])
  })`),{empty:true,previews:0,values:[]});
  await evaluate(`window.confirm=()=>true;document.querySelectorAll(".modal-backdrop").forEach(item=>item.hidden=true);document.querySelector("#toast").hidden=true;document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  assert.deepEqual(await evaluate(`({visible:!document.querySelector("#local-test-settings").hidden,cold:document.querySelector('[data-local-test-mode="cold"]').classList.contains("active"),coldDisabled:document.querySelector('[data-local-test-mode="cold"]').disabled,summaryOk:/空账户工作区/.test(document.querySelector("#local-test-summary").textContent),entryOk:/使用模拟 \\/ 冷启测试 · 当前冷启测试/.test(document.querySelector("#mine-settings-summary").textContent)})`),{visible:true,cold:true,coldDisabled:true,summaryOk:true,entryOk:true});
  const localTestSettingsScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-local-test-settings.png",Buffer.from(localTestSettingsScreenshot.data,"base64"));
  const activeRefreshCoreRequests = await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`);
  await evaluate(`window.__localHydrateRequests=[];window.__attachmentReadsBeforeModeSwitch=(window.__attachmentReads||[]).length;document.querySelector('[data-local-test-mode="simulation"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#local-test-status").textContent.includes("打开页面时读取对应记录")`),true);
  assert.deepEqual(await evaluate(`({hydrates:window.__localHydrateRequests,summary:document.querySelector("#local-test-summary").textContent,captures:document.querySelectorAll("#capture-list [data-capture-id]").length,attachmentReads:(window.__attachmentReads||[]).length-window.__attachmentReadsBeforeModeSwitch})`),{hydrates:[],summary:"owner · 0 条已载入 · 打开页面后读取记录",captures:0,attachmentReads:0});
  assert.deepEqual(
    (await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`)).map((value,index)=>value-activeRefreshCoreRequests[index]),
    [0, 1, 1, 1],
    "active reload must refresh state, meta and local-test once without rechecking auth"
  );
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("captures")&&document.querySelector("#capture-list").textContent.includes("这个念头")`),true);
  assert.equal(await evaluate(`(window.__attachmentReads||[]).length-window.__attachmentReadsBeforeModeSwitch`),0);
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  await sleep(100);
  assert.equal(await evaluate(`window.__localHydrateRequests.filter(scope=>scope==="captures").length`),1);
  await evaluate(`window.__failCaptureCreate=true;document.querySelector("#capture-content").value="范围切换时保留的待同步记录";document.querySelector("#capture-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector(".capture-sync-state.pending")?.textContent==="待同步"&&document.querySelector("#capture-list").textContent.includes("范围切换时保留的待同步记录")`),true);
  await evaluate(`document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`Boolean(document.querySelector('[data-action-complete="ui-action"]'))`),true);
  await evaluate(`window.__failActionNetwork=true;document.querySelector('[data-action-complete="ui-action"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state.pending")`),true);
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  await evaluate(`window.__delayActionList=true;document.querySelector('[data-view="today"]').click();true`);
  assert.equal(await waitUntil(`typeof window.__releaseActionList==="function"`),true);
  assert.equal(await evaluate(`!document.querySelector("#section-nav").hidden&&!document.querySelector("[data-section-links='today']").hidden&&document.querySelector("[data-section-links='today'] [data-view='today']").getAttribute("aria-current")==="page"`),true);
  await evaluate(`window.__releaseActionList();true`);
  assert.equal(await waitUntil(`window.__localHydrateRequests.includes("today")&&document.querySelectorAll(".home-v02-memory").length===3&&Boolean(document.querySelector("[data-home-keepsake]")?.dataset.homeKeepsake)`),true);
  assert.equal(await evaluate(`!document.querySelector("#section-nav").hidden&&!document.querySelector("[data-section-links='today']").hidden&&document.querySelector("[data-section-links='today'] [data-view='today']").getAttribute("aria-current")==="page"`),true);
  assert.equal(await waitUntil(`Boolean(document.querySelector(".action-column:nth-child(3)")?.textContent.includes("服务器新标题")&&document.querySelector(".action-column:nth-child(3) .checkin-sync-state.pending"))`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".capture-sync-state.pending")?.textContent==="待同步"&&document.querySelector("#capture-list").textContent.includes("范围切换时保留的待同步记录")`),true);
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
  assert.equal(await waitUntil(`window.__testWorkspaceMode==="cold"&&document.querySelector("#view-today").classList.contains("active")&&!document.querySelector("#onboarding-workspace").hidden&&document.querySelector("#onboarding-v2-content h1")?.textContent.includes("先认识此刻的你")`),true);
  await evaluate(`document.querySelector('[data-section="seen"]').click();document.querySelector('[data-view="keepsakes"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#keepsake-grid .content-state")`),true);
  assert.deepEqual(await evaluate(`(()=>{const grid=document.querySelector("#keepsake-grid"),empty=grid.querySelector(".content-state"),gridBox=grid.getBoundingClientRect(),emptyBox=empty.getBoundingClientRect();return{title:empty.querySelector("strong").textContent,body:empty.querySelector("p").textContent,action:empty.querySelector("button").textContent,actions:empty.querySelectorAll("button").length,fullWidth:Math.abs(gridBox.width-emptyBox.width)<2,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{title:"还没有小物",body:"从一张照片开始，名称和轮廓之后都可以修改。",action:"收第一件小物",actions:1,fullWidth:true,noOverflow:true});
  await evaluate(`document.querySelector("#keepsake-grid .content-state-action").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#keepsake-workspace").hidden`),true);
  await evaluate(`document.querySelector("#keepsake-create-toggle").click();document.querySelector('[data-section="thought"]').click();document.querySelector("[data-section-links='thought'] [data-view='journals']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#journal-list .content-state")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#journal-list .content-state");return{title:state.querySelector("strong").textContent,body:state.querySelector("p").textContent,action:state.querySelector("button").textContent,actions:state.querySelectorAll("button").length}})()`),{title:"还没有日记",body:"不需要写完整，一句真实的话也可以成为记录。",action:"写第一篇",actions:1});
  await evaluate(`document.querySelector("#journal-list .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#journal-content")`),true);
  await evaluate(`document.querySelector("[data-section-links='thought'] [data-view='thoughts']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#all-thoughts .content-state")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#all-thoughts .content-state");return{title:state.querySelector("strong").textContent,body:state.querySelector("p").textContent,action:state.querySelector("button").textContent,actions:state.querySelectorAll("button").length}})()`),{title:"还没有思绪",body:"从一个真实问题开始，初步想法可以稍后补充。",action:"记录第一个问题",actions:1});
  await evaluate(`document.querySelector("#all-thoughts .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#chain-question")`),true);
  assert.deepEqual(await evaluate(`({view:document.querySelector(".view.active")?.id,path:location.pathname,visible:!document.querySelector("#home-thought-editor").hidden,focused:document.activeElement===document.querySelector("#chain-question")})`),{view:"view-thoughts",path:"/thoughts",visible:true,focused:true});
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true`);
  await evaluate(`document.querySelector('[data-section="seen"]').click();document.querySelector("[data-section-links='seen'] [data-view='quotes']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-quotes").classList.contains("active")&&!document.querySelector("#view-quotes").inert&&!document.querySelector("#view-quotes").hasAttribute("aria-busy")&&document.querySelector("#quote-sky-content .content-state")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#quote-sky-content .content-state");return{title:state.querySelector("strong").textContent,body:state.querySelector("p").textContent,action:state.querySelector("button").textContent,actions:state.querySelectorAll("button").length}})()`),{title:"还没有收藏的句子",body:"先留下原句和来源，它之后会在这里再次出现。",action:"收藏第一句",actions:1});
  await evaluate(`document.querySelector("#quote-sky-content .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#quote-content")`),true);
  await evaluate(`document.querySelector('[data-section="thought"]').click();document.querySelector("[data-section-links='thought'] [data-view='discovery']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#discovery-list [data-discovery-id]")`),true);
  assert.deepEqual(await evaluate(`(()=>{const more=document.querySelector("#discovery-more"),governance=document.querySelector("#mine-governance-link"),context=document.querySelector("#feedback-context-field");governance.hidden=true;const result={moreHidden:more.hidden,moreDisplay:getComputedStyle(more).display,governanceDisplay:getComputedStyle(governance).display,contextHidden:context.hidden,contextDisplay:getComputedStyle(context).display};governance.hidden=false;return result})()`),{moreHidden:true,moreDisplay:"none",governanceDisplay:"none",contextHidden:true,contextDisplay:"none"});
  await evaluate(`window.__failDiscoveryRead=true;document.querySelector("#toast").hidden=true;(()=>{const form=document.querySelector("#discovery-form");form.elements.query.value="触发恢复状态";form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#discovery-list .content-state.failure")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#discovery-list .content-state"),toast=document.querySelector("#toast");return{title:state.querySelector("strong").textContent,body:state.querySelector("p").textContent,action:state.querySelector("button").textContent,internal:state.textContent.includes("DISCOVERY_BACKEND_INTERNAL")||(!toast.hidden&&toast.textContent.includes("DISCOVERY_BACKEND_INTERNAL"))}})()`),{title:"暂时无法查找旧记录",body:"已有记录没有变化。请检查网络后重试。",action:"重新查找",internal:false});
  await evaluate(`document.querySelector("#discovery-list .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#discovery-list [data-discovery-id]")`),true);
  await evaluate(`window.__emptyDiscoveryRead=true;document.querySelector("#discovery-form").requestSubmit();true`);
  assert.equal(await waitUntil(`document.querySelector("#discovery-list .content-state.empty")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#discovery-list .content-state"),more=document.querySelector("#discovery-more");return{title:state.querySelector("strong").textContent,action:state.querySelector("button").textContent,moreHidden:more.hidden,moreDisplay:getComputedStyle(more).display}})()`),{title:"没有符合条件的记录",action:"调整查找条件",moreHidden:true,moreDisplay:"none"});
  await evaluate(`document.querySelector("#discovery-list .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.activeElement===document.querySelector("#discovery-query")`),true);
  await evaluate(`window.__emptyDiscoveryRead=false;true`);
  await evaluate(`document.querySelector('[data-view="mine"]').click();document.querySelector("#view-mine [data-view='trash']").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#trash-list .content-state.failure")`),true);
  assert.deepEqual(await evaluate(`(()=>{const state=document.querySelector("#trash-list .content-state");return{title:state.querySelector("strong").textContent,body:state.querySelector("p").textContent,action:state.querySelector("button").textContent,actions:state.querySelectorAll("button").length,internal:state.textContent.includes("Not found")}})()`),{title:"暂时无法读取回收站",body:"已删除的记录仍按原保留期保存。请检查网络后重试。",action:"重新读取",actions:1,internal:false});
  await evaluate(`window.__trashReadReady=true;document.querySelector("#trash-list .content-state-action").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#trash-list .trash-entry")`),true);
  assert.deepEqual(await evaluate(`(()=>{const entry=document.querySelector("#trash-list .trash-entry"),detail=entry.querySelector(".trash-detail"),labels=[...detail.querySelectorAll("b")].map(item=>item.textContent);return{title:entry.querySelector("h2").textContent,labels:[...new Set(labels)],translated:detail.textContent.includes("手动记录")&&detail.textContent.includes("本人")&&detail.textContent.includes("已保留"),internal:["disposition","occurredOn","authorType","origin"].some(value=>detail.textContent.includes(value))}})()`),{title:"回收站文案不能暴露内部字段",labels:["内容类型","内容","记录方式","内容来源","处理状态","发生日期"],translated:true,internal:false});
  await evaluate(`document.querySelector('[data-section="thought"]').click();document.querySelector("[data-section-links='thought'] [data-view='journals']").click();true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await evaluate(`document.querySelector("#journal-list .content-state").scrollIntoView({block:"center"});true`);await sleep(100);
  assert.equal(await evaluate(`(()=>{const state=document.querySelector("#journal-list .content-state"),button=state.querySelector("button");return document.documentElement.scrollWidth<=innerWidth&&state.getBoundingClientRect().right<=innerWidth&&button.getBoundingClientRect().height>=44})()`),true);
  await fs.writeFile("/tmp/growth-content-state-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await evaluate(`window.__notifications.unshift({id:"notification-capture-failed",taskId:"task-capture-failed",resourceType:"capture",targetId:"capture-failed",kind:"aiTask",status:"failed",title:"语音转写",message:"火山语音识别暂时不可用，请稍后重试",createdAt:"2026-10-03T06:05:29.000Z",updatedAt:"2026-10-03T06:05:31.000Z",readAt:""});window.__delayTaskRetry=true;document.querySelector('[data-view="mine"]').click();document.querySelector("#view-mine [data-view='notifications']").click();true`);
  assert.equal(await waitUntil(`document.querySelector('.notification-entry[data-status="failed"]')`),true);
  assert.deepEqual(await evaluate(`(()=>{const back=document.querySelector("#view-notifications .mine-back").getBoundingClientRect(),readAll=document.querySelector("#notifications-read-all").getBoundingClientRect();return{backWidth:back.width>=44,backHeight:back.height>=44,readAllWidth:readAll.width>=44,readAllHeight:readAll.height>=44,noOverflow:document.documentElement.scrollWidth<=innerWidth}})()`),{backWidth:true,backHeight:true,readAllWidth:true,readAllHeight:true,noOverflow:true});
  assert.deepEqual(await evaluate(`(()=>{const card=document.querySelector('.notification-entry[data-status="failed"]'),buttons=[...card.querySelectorAll("button")],time=card.querySelector("time");return{text:card.textContent.includes("语音转写")&&card.textContent.includes("失败")&&card.textContent.includes("原音已保留"),labels:buttons.map(item=>item.textContent),touch:buttons.every(item=>item.getBoundingClientRect().height>=44&&item.getBoundingClientRect().width>=44),datetime:Boolean(time?.dateTime),noOverflow:card.getBoundingClientRect().right<=innerWidth}})()`),{text:true,labels:["查看","重试","标为已读"],touch:true,datetime:true,noOverflow:true});
  await fs.writeFile("/tmp/growth-notification-failed-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await evaluate(`document.querySelector('.notification-entry[data-status="failed"] [data-task-retry]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-task-retry][aria-busy="true"]')?.textContent==="正在重试"`),true);
  await evaluate(`document.querySelector('[data-task-retry][aria-busy="true"]').click();true`);
  assert.equal(await evaluate(`window.__taskRetries`),1);
  await evaluate(`window.__releaseTaskRetry();true`);
  assert.equal(await waitUntil(`window.__aiTasks.some(item=>item.retryOf==="task-capture-failed")&&!document.querySelector('[data-task-retry][aria-busy="true"]')`),true);
  await evaluate(`document.querySelector('[data-notification-read="notification-capture-failed"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector('[data-notification-read="notification-capture-failed"]')`),true);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-section="today"]').click();true`);
  assert.deepEqual(await evaluate(`({memories:document.querySelectorAll(".home-v02-memory").length,empty:document.querySelector(".home-v02-empty")?.textContent,moodPoints:document.querySelectorAll("#home-mood-sparkline circle").length,keepsake:document.querySelector("#home-keepsake").textContent.includes("留存一件小物"),noOverflow:document.documentElement.scrollWidth<=innerWidth})`),{memories:0,empty:"留下第一条思考，往后在这里重逢。",moodPoints:0,keepsake:true,noOverflow:true});
  await evaluate(`document.querySelector('[data-onboarding-action="legacy"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#onboarding-form").hidden&&document.querySelectorAll(".onboarding-question").length===8`),true);
  await evaluate(`document.querySelector("#onboarding-legacy-back").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#onboarding-v2-shell").hidden&&document.querySelector("#onboarding-form").hidden`),true);
  await evaluate(`document.querySelector("#toast").hidden=true;true`);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector("#onboarding-v2-content").getBoundingClientRect().right<=innerWidth`),true);
  const onboardingMobileScreenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fs.writeFile("/tmp/growth-onboarding-v2-welcome-mobile.png",Buffer.from(onboardingMobileScreenshot.data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:320,height:760,deviceScaleFactor:2,mobile:true});await sleep(80);
  assert.equal(await evaluate(`(()=>{const root=document.querySelector("#onboarding-workspace").getBoundingClientRect(),exit=document.querySelector("#onboarding-v2-exit").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&root.right<=innerWidth&&exit.right<=innerWidth&&exit.height>=44})()`),true);
  await fs.writeFile("/tmp/growth-onboarding-v2-welcome-narrow.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-onboarding-action="start"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-answer="currentContext"]')&&!document.querySelector('[data-onboarding-answer="currentContext"]').disabled`),true);
  await evaluate(`(()=>{const input=document.querySelector('[data-onboarding-answer="currentContext"]');input.value="一边学习一边实习，最近时间比较紧。";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#onboarding-v2-save-status").textContent.includes("已保存在此设备")`),true);
  await evaluate(`document.querySelector("#onboarding-v2-exit").click();true`);
  const onboardingPaused=await waitUntil(`document.querySelector("#onboarding-workspace").hidden&&window.__onboardingV2.session.status==="paused"`);
  assert.equal(onboardingPaused,true,JSON.stringify(await evaluate(`({hidden:document.querySelector("#onboarding-workspace").hidden,status:window.__onboardingV2.session.status,step:window.__onboardingV2.session.step,revision:window.__onboardingV2.session.revision,save:document.querySelector("#onboarding-v2-save-status").textContent,exitDisabled:document.querySelector("#onboarding-v2-exit").disabled,body:document.querySelector("#onboarding-v2-content").innerText.slice(0,120)})`)));
  await evaluate(`(()=>{const input=document.querySelector('#chain-form input[name="recordKind"][value="thought"]');input.checked=true;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await cdp.send("Page.reload",{ignoreCache:true});
  assert.equal(await waitUntil(`document.querySelector("#today-date-label")?.textContent.length>0&&!document.querySelector("#onboarding-workspace").hidden&&document.querySelector("#onboarding-v2-content h1")?.textContent.includes("先把这一点留下")`),true);
  assert.deepEqual(await evaluate(`([...document.querySelectorAll('#chain-form input[name="recordKind"]')].map(input=>({value:input.value,checked:input.checked})))`),[{value:"capture",checked:false},{value:"thought",checked:true}]);
  await evaluate(`document.querySelector('[data-onboarding-action="resume"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-answer="currentContext"]')?.value.includes("一边学习一边实习")&&!document.querySelector('[data-onboarding-answer="currentContext"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="next"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-list="desiredChanges"]')&&!document.querySelector('[data-onboarding-list="desiredChanges"]').disabled`),true);
  await evaluate(`(()=>{const input=document.querySelector('[data-onboarding-list="desiredChanges"]');input.value="恢复规律作息";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  assert.equal(await waitUntil(`new Promise(resolve=>{const opening=indexedDB.open("cike-onboarding-v2-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const request=opening.result.transaction("drafts","readonly").objectStore("drafts").get("user-1:onboarding-v2");request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(request.result?.answers?.desiredChanges?.structuredValue?.[0]?.text==="恢复规律作息")}})`),true);
  await cdp.send("Page.reload",{ignoreCache:true});
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-list="desiredChanges"]')?.value==="恢复规律作息"&&!document.querySelector('[data-onboarding-list="desiredChanges"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="next"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-list="recentObstacles"]')&&!document.querySelector('[data-onboarding-action="skip"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="skip"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-answer="dailyRhythm"]')&&!document.querySelector('[data-onboarding-action="skip"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="skip"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-axis="responseLength"]')&&!document.querySelector('[data-onboarding-axis="responseLength"]').disabled`),true);
  await evaluate(`(()=>{const concise=document.querySelector('[data-onboarding-axis="responseLength"][value="concise"]'),boundary=document.querySelector("[data-onboarding-boundary]");concise.checked=true;concise.dispatchEvent(new Event("change",{bubbles:true}));boundary.value="不要替我做心理诊断。";boundary.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector('[data-onboarding-action="next"]').click();return true})()`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-review")?.textContent.includes("恢复规律作息")&&document.querySelector(".onboarding-v2-review")?.textContent.includes("不要替我做心理诊断")&&!document.querySelector('[data-onboarding-action="complete"]').disabled`),true);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".onboarding-v2-review article")].every(item=>item.getBoundingClientRect().right<=innerWidth)`),true);
  await fs.writeFile("/tmp/growth-onboarding-v2-review-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-onboarding-action="extract"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-candidates [data-claim-id='claim-ui-1']")?.textContent.includes("希望恢复规律作息")&&document.querySelector(".onboarding-v2-unknown")?.textContent.includes("怎样的作息调整最容易开始")`),true);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});await sleep(100);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".onboarding-v2-candidates").getBoundingClientRect().right<=innerWidth&&document.querySelector('[data-claim-action="confirm"]').getBoundingClientRect().height>=44`),true);
  await fs.writeFile("/tmp/growth-onboarding-v2-candidates-mobile.png",Buffer.from((await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`(()=>{const text=document.querySelector("[data-claim-statement]");text.value="希望逐步恢复规律作息";document.querySelector('[data-claim-action="confirm"]').click();return true})()`);
  assert.equal(await waitUntil(`window.__userModel.activeClaimCount===1&&!document.querySelector("[data-claim-id='claim-ui-1']")&&document.querySelector("#onboarding-v2-save-status").textContent.includes("已确认")`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="review"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-review")&&!document.querySelector('[data-onboarding-action="complete"]').disabled`),true);
  await evaluate(`(()=>{const allow=document.querySelector('[data-onboarding-allow="currentContext"]');allow.checked=false;allow.dispatchEvent(new Event("change",{bubbles:true}));window.__onboardingV2.session.answers.currentContext.rawText="另一设备改写的当前处境";window.__onboardingV2.session.answers.currentContext.version+=1;window.__onboardingV2.session.revision+=1;window.__onboardingV2.session.updatedAt=new Date().toISOString();sessionStorage.setItem("ui-onboarding-v2",JSON.stringify(window.__onboardingV2));document.querySelector('[data-onboarding-action="complete"]').click();return true})()`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-conflicts")?.textContent.includes("另一设备改写的当前处境")&&document.querySelector(".onboarding-v2-conflicts")?.textContent.includes("一边学习一边实习")`),true);
  assert.deepEqual(await evaluate(`({choices:document.querySelectorAll('[data-onboarding-conflict="currentContext"]').length,mergeDisabled:document.querySelector('[data-onboarding-action="merge-conflict"]').disabled,status:document.querySelector("#onboarding-v2-save-status").textContent})`),{choices:2,mergeDisabled:true,status:"两端内容有差异，请逐项选择"});
  await evaluate(`document.querySelector('[data-onboarding-conflict="currentContext"][data-choice="device"]').click();document.querySelector('[data-onboarding-action="merge-conflict"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-review")&&!document.querySelector('[data-onboarding-action="complete"]').disabled&&window.__onboardingV2.session.answers.currentContext.rawText.includes("一边学习一边实习")`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="complete"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#onboarding-v2-content h1")?.textContent.includes("不必一次说完自己")&&window.__onboardingV2.session.status==="completed"`),true);
  assert.deepEqual(await evaluate(`({answers:Object.keys(window.__onboardingV2.session.answers),currentAllowed:window.__onboardingV2.session.answers.currentContext.contextAllowed,hasObstacles:Boolean(window.__onboardingV2.session.answers.recentObstacles),collaboration:window.__onboardingV2.session.collaboration.responseLength,boundary:window.__onboardingV2.session.collaboration.additionalBoundary})`),{answers:["currentContext","desiredChanges"],currentAllowed:false,hasObstacles:false,collaboration:{value:"concise",source:"user"},boundary:"不要替我做心理诊断。"});
  await evaluate(`document.querySelector('[data-onboarding-action="review"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector(".onboarding-v2-review")&&!document.querySelector('[data-onboarding-action="complete"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="complete"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector('[data-onboarding-action="first-record"]')&&!document.querySelector('[data-onboarding-action="first-record"]').disabled`),true);
  await evaluate(`document.querySelector('[data-onboarding-action="first-record"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-captures").classList.contains("active")&&document.querySelector("#onboarding-workspace").hidden&&document.activeElement===document.querySelector("#capture-content")`),true);
  await evaluate(`document.querySelector('[data-view="personal-context"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-personal-context").classList.contains("active")&&!document.querySelector("#view-personal-context").inert&&!document.querySelector("#view-personal-context").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector("#onboarding-v2-reopen").click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-today").classList.contains("active")&&!document.querySelector("#onboarding-workspace").hidden&&document.querySelector(".onboarding-v2-review")`),true);
  assert.equal(await evaluate(`window.__onboardingSaves`),0);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),request=transaction.objectStore("drafts").put({key:"user-1:capture",owner:"user-1",id:"capture",uploadRequestId:"restored-upload",items:[{blob:new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),name:"restored.png",type:"image/png",lastModified:1}]});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),blob=new Blob([new Uint8Array([1,2,3,4])],{type:"audio/mp4"}),request=transaction.objectStore("drafts").put({key:"user-1:capture-audio",owner:"user-1",id:"capture-audio",audio:{blob,mimeType:"audio/mp4",bytes:blob.size,durationMs:1250,uploadRequestId:"restored-audio",uploadedPath:"",lastError:"LEGACY_AUDIO_PRIVATE_DETAIL"}});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const transaction=opening.result.transaction("drafts","readwrite"),store=transaction.objectStore("drafts"),blob=new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),item={blob,name:"targeted.png",type:"image/png",lastModified:1,uploadRequestId:"",uploadedPath:"",lastError:null};store.put({key:"user-1:comment",owner:"user-1",id:"comment",context:{selection:{rootKey:"analysis:analysis-1",targetKey:"content",start:0,end:3,quote:"总判断"},text:"刷新后继续的评论",requestId:"comment-restored"},items:[]});store.put({key:"user-1:thoughtBlock",owner:"user-1",id:"thoughtBlock",context:{rootId:"discarded-root",blockId:"",type:"record",occurredAt:"2026-09-27T12:34",content:"刷新后继续的内容块",version:1,requestId:"block-restored"},items:[item]});store.put({key:"user-1:health:weight:2026-09-27",owner:"user-1",id:"health:weight:2026-09-27",date:"2026-09-27",type:"weight",result:{bodyWaterMass:42.2,description:"刷新后恢复的体成分",attachmentPaths:["/attachments/weight.png"]},items:[{...item,uploadRequestId:"health-restored",uploadedPath:"/attachments/weight.png"}]});transaction.oncomplete=()=>resolve(true);transaction.onerror=()=>resolve(false)}})`),true);
  assert.equal(await evaluate(`new Promise(resolve=>{const opening=indexedDB.open("cike-media-drafts",1);opening.onerror=()=>resolve(false);opening.onsuccess=()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),value=>value.charCodeAt(0)),blob=new Blob([bytes],{type:"image/png"}),items=[1,2].map(index=>({itemId:"restored-keepsake-"+index,blob,name:"restored-"+index+".png",type:"image/png",lastModified:1,occurredAt:"2026-09-27T12:00:00",title:"恢复小物 "+index,category:"其他",note:"",tags:"",edgeExpansion:8,source:"manual",alphaMask:"",status:"waiting",uploadRequestId:"",createRequestId:"",mediaPaths:null,lastError:null})),request=opening.result.transaction("drafts","readwrite").objectStore("drafts").put({key:"user-1:keepsake-batch",owner:"user-1",id:"keepsake-batch",activeIndex:1,items});request.onerror=()=>resolve(false);request.onsuccess=()=>resolve(true)}})`),true);
  await cdp.send("Page.reload",{ignoreCache:true});await sleep(300);
  const mediaRestored=await waitUntil(`document.querySelector("#today-date-label")?.textContent.length>0`);
  assert.equal(mediaRestored,true,JSON.stringify(await evaluate(`({date:document.querySelector("#today-date-label")?.textContent,keepsakeItems:document.querySelectorAll(".keepsake-batch-item").length,toast:document.querySelector("#toast")?.textContent})`)));
  assert.equal(await evaluate(`document.querySelectorAll(".keepsake-batch-item").length`),0);
  assert.deepEqual(await evaluate(`({audioSrc:document.querySelector("#capture-audio-player")?.getAttribute("src")||"",audioMeta:document.querySelector("#capture-audio-meta")?.textContent||"",audioStatus:document.querySelector("#capture-audio-status")?.textContent||""})`),{audioSrc:"",audioMeta:"",audioStatus:""});
  assert.deepEqual(await evaluate(`({capturePreview:Boolean(document.querySelector('[data-content-image-editor="capture"] .content-image-preview')),commentHidden:document.querySelector("#comment-panel").hidden,shenji:Boolean(document.querySelector('[data-shenji-form="analysis-annotation-1"]')),blockHidden:document.querySelector("#thought-block-modal").hidden})`),{capturePreview:false,commentHidden:true,shenji:false,blockHidden:true});
  assert.equal(await evaluate(`!document.body.textContent.includes("LEGACY_AUDIO_PRIVATE_DETAIL")`),true);
  await evaluate(`document.querySelector('[data-view="captures"]').click();true`);
  assert.equal(
    await waitUntil(`document.querySelector('[data-content-image-editor="capture"] .content-image-preview')&&document.querySelector("#capture-status").textContent.includes("已恢复 1 张待上传图片")&&document.querySelector("#capture-audio-player").src.startsWith("blob:")&&document.querySelector("#capture-audio-meta").textContent.includes("0:01")&&document.querySelector("#capture-audio-status").textContent.includes("待提交语音")`),
    true,
    JSON.stringify(await evaluate(`({preview:Boolean(document.querySelector('[data-content-image-editor="capture"] .content-image-preview')),captureStatus:document.querySelector("#capture-status")?.textContent||"",audioSrc:document.querySelector("#capture-audio-player")?.src||"",audioMeta:document.querySelector("#capture-audio-meta")?.textContent||"",audioStatus:document.querySelector("#capture-audio-status")?.textContent||"",exceptions:window.__runtimeExceptions||[]})`))
  );
  await evaluate(`document.querySelector('[data-view="review"]').click();true`);
  const commentDraftRestored=await waitUntil(`!document.querySelector("#comment-panel").hidden&&document.querySelector("#comment-text").value==="刷新后继续的评论"&&document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea')?.value==="后台同步期间的新草稿"`);
  assert.equal(commentDraftRestored,true,JSON.stringify({
    ui:await evaluate(`({hidden:document.querySelector("#comment-panel").hidden,text:document.querySelector("#comment-text").value,assistant:document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea')?.value||"",root:document.querySelector("#comment-panel").dataset.commentRoot||"",annotations:window.__analyses[0].annotations.map(item=>item.id)})`),
    exceptions:cdp.events.filter(event=>event.method==="Runtime.exceptionThrown").slice(-3).map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
  }));
  await evaluate(`document.querySelector('[data-view="thoughts"]').click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#thought-block-modal").hidden&&document.querySelector("#thought-block-content").value==="刷新后继续的内容块"&&document.querySelectorAll('[data-content-image-editor="thoughtBlock"] .content-image-preview').length===1`),true);
  assert.deepEqual(await evaluate(`({commentOpen:!document.querySelector("#comment-panel").hidden,commentText:document.querySelector("#comment-text").value,commentImages:document.querySelectorAll('[data-content-image-editor="comment"] .content-image-preview').length,shenjiText:document.querySelector('[data-shenji-form="analysis-annotation-1"] textarea').value,blockOpen:!document.querySelector("#thought-block-modal").hidden,blockText:document.querySelector("#thought-block-content").value,blockRoot:document.querySelector("#thought-block-root-id").value,blockImages:document.querySelectorAll('[data-content-image-editor="thoughtBlock"] .content-image-preview').length})`),{commentOpen:false,commentText:"刷新后继续的评论",commentImages:0,shenjiText:"后台同步期间的新草稿",blockOpen:true,blockText:"刷新后继续的内容块",blockRoot:"discarded-root",blockImages:1});
  await evaluate(`document.querySelector('[data-view="keepsakes"]').click();true`);
  const keepsakeBatchRestored = await waitUntil(`document.querySelectorAll(".keepsake-batch-item").length===2`);
  assert.equal(keepsakeBatchRestored, true, JSON.stringify(await evaluate(`({
    activeView:document.querySelector(".view.active")?.id,
    batchItems:document.querySelectorAll(".keepsake-batch-item").length,
    batchStatus:document.querySelector("#keepsake-batch-status")?.textContent,
    batchCount:document.querySelector("#keepsake-batch-count")?.textContent,
    exceptions:window.__runtimeExceptions||[]
  })`)));
  assert.deepEqual(await evaluate(`({items:document.querySelectorAll(".keepsake-batch-item").length,count:document.querySelector("#keepsake-batch-count").textContent,active:document.querySelector('[data-keepsake-batch-select="1"]')?.getAttribute("aria-pressed")})`),{items:2,count:"2 件",active:"true"});
  await evaluate(`document.querySelector('[data-view="daily"]').click();true`);
  await sleep(100);
  assert.equal(await waitUntil(`document.querySelector("#view-daily").classList.contains("active")&&!document.querySelector("#view-daily").inert&&!document.querySelector("#view-daily").hasAttribute("aria-busy")&&document.querySelector("#daily-records").childElementCount>0`),true);
  await evaluate(`document.querySelector('[data-daily-tab="weight"]').click();true`);
  assert.equal(
    await waitUntil(`document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value==="42.2"&&document.querySelectorAll("#health-image-previews figure").length===1`),
    true,
    JSON.stringify(await evaluate(`({path:location.pathname,active:document.querySelector(".view.active")?.id,busy:document.querySelector("#view-daily").getAttribute("aria-busy"),weightTab:document.querySelector('[data-daily-tab="weight"]').getAttribute("aria-selected"),status:document.querySelector("#health-parse-status").textContent,toast:document.querySelector("#toast").textContent})`))
  );
  assert.deepEqual(await evaluate(`({value:document.querySelector('[data-daily-form="weight"] [name="bodyWaterMass"]').value,description:document.querySelector('[data-daily-form="weight"] [name="description"]').value,images:document.querySelectorAll("#health-image-previews figure").length,status:document.querySelector("#health-parse-status").textContent})`),{value:"42.2",description:"刷新后恢复的体成分",images:1,status:"已恢复识别结果，请核对后保存。"});
  assert.deepEqual(cdp.events
    .filter(event=>event.method==="Runtime.exceptionThrown")
    .map(event=>event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text)
    .filter(message=>/Cannot set properties of null \(setting 'value'\)/.test(message)),[]);

  await evaluate(`window.confirm=()=>true;window.__nextLoginRole="user";document.querySelector("#logout-button").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#auth-gate").hidden&&[...document.querySelectorAll(".auth-form input,.auth-form button,[data-auth-tab]")].every(item=>!item.disabled)`),true);
  await evaluate(`(()=>{const form=document.querySelector("#login-form");form.elements.username.value="member";form.elements.password.value="member-password-2";form.requestSubmit();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#auth-gate").hidden&&document.querySelector("#account-name").textContent==="second"`),true);
  assert.deepEqual(await evaluate(`({
    ownerNodes:document.querySelectorAll("[data-owner-capability]").length,
    architecture:Boolean(document.querySelector("#view-architecture")),
    commercialization:Boolean(document.querySelector("#view-commercialization")),
    aiCost:Boolean(document.querySelector("#view-ai-cost")),
    aiDashboard:Boolean(document.querySelector("#view-statistics .ai-dashboard")),
    modelControls:document.querySelectorAll("[data-profile-model]").length,
    apiKey:Boolean(document.querySelector("#llm-api-key")),
    localTest:Boolean(document.querySelector("#local-test-settings")),
    accountRoles:Boolean(document.querySelector("#account-role-settings")),
    effortControls:document.querySelectorAll("[data-ai-effort]").length,
    primary:[...document.querySelectorAll(".nav-button")].map(item=>item.textContent.trim())
  })`),{ownerNodes:0,architecture:false,commercialization:false,aiCost:false,aiDashboard:false,modelControls:0,apiKey:false,localTest:false,accountRoles:false,effortControls:16,primary:["◌今日","◇所见","∿所思","○我的"]});
  await evaluate(`(()=>{const button=document.createElement("button");button.dataset.view="architecture";document.body.append(button);button.click();button.remove();return true})()`);
  assert.equal(await waitUntil(`document.querySelector("#view-permission").classList.contains("active")&&!document.querySelector("#view-permission").inert&&!document.querySelector("#view-permission").hasAttribute("aria-busy")`),true);
  assert.deepEqual(await evaluate(`({permission:document.querySelector("#view-permission").classList.contains("active"),title:document.querySelector("#permission-title").textContent,sensitive:document.querySelector("main").innerText.includes("2 vCPU")||document.querySelector("main").innerText.includes("API 密钥")})`),{permission:true,title:"架构设计仅 Owner 可访问",sensitive:false});
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  await evaluate(`document.querySelector('[data-ai-effort="thoughtAnswer"]').value="none";document.querySelector("#llm-settings-form").requestSubmit();true`);
  assert.equal(await waitUntil(`window.__preferenceSaves===1&&document.querySelector("#llm-settings-status").textContent.includes("偏好已保存")`),true);
  assert.deepEqual(await evaluate(`({effort:window.__lastSettingsPayload.sceneEfforts.thoughtAnswer,profiles:Object.hasOwn(window.__lastSettingsPayload,"profiles"),scenarios:Object.hasOwn(window.__lastSettingsPayload,"scenarios"),apiKey:Object.hasOwn(window.__lastSettingsPayload,"apiKey")})`),{effort:"none",profiles:false,scenarios:false,apiKey:false});
  await evaluate(`document.querySelector('[data-view="statistics"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#record-total strong")?.textContent==="41"`),true);
  assert.deepEqual(await evaluate(`({title:document.querySelector("#statistics-page-title").textContent,aiDashboard:Boolean(document.querySelector("#view-statistics .ai-dashboard"))})`),{title:"留下了什么",aiDashboard:false});
  const reauthCoreRequests = await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`);
  await evaluate(`document.querySelector('[data-view="settings"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#view-settings").classList.contains("active")&&!document.querySelector("#view-settings").inert&&!document.querySelector("#view-settings").hasAttribute("aria-busy")`),true);
  await evaluate(`window.__reauthNextPreference=true;document.querySelector("#llm-settings-form").requestSubmit();true`);
  assert.equal(await waitUntil(`!document.querySelector("#auth-gate").hidden&&document.querySelector("#auth-status").textContent.includes("权限已变更")`),true);
  assert.equal(await evaluate(`document.body.classList.contains("auth-locked")`),true);
  assert.deepEqual(
    await evaluate(`["GET /api/auth/me","GET /api/v1/startup","GET /api/v1/route-state","GET /api/local-test-mode"].map(request=>request.endsWith("route-state")?window.__apiRequests.filter(value=>value.startsWith(request)).length:window.__apiRequests.filter(value=>value===request).length)`),
    reauthCoreRequests,
    "authentication failure must lock the shell without duplicate core loads"
  );
  await evaluate(`(() => {
    const onboarding=window.__onboardingV2;
    onboarding.session={...onboarding.session,status:"draft",step:"welcome",revision:0,answers:{},startedAt:"",pausedAt:"",completedAt:"",updatedAt:""};
    onboarding.readiness="empty";
    onboarding.migration={...onboarding.migration,selectedFlow:"undecided",entryPolicy:"choose"};
    sessionStorage.setItem("ui-onboarding-v2",JSON.stringify(onboarding));
    sessionStorage.setItem("ui-delay-next-startup-secondary","1");
    return true;
  })()`);
  await cdp.send("Page.navigate",{url:APP_URL});
  assert.equal(await waitUntil(`window.__startupEvents.includes("route:response")&&window.__startupEvents.includes("startup:response")&&typeof window.__releaseStartupSecondary==="function"`),true);
  assert.deepEqual(await evaluate(`({
    locked:document.body.classList.contains("auth-locked"),
    privateSurfaceHidden:getComputedStyle(document.querySelector("main")).visibility==="hidden",
    shellVisible:window.__startupEvents.includes("shell:visible"),
    onboardingHidden:document.querySelector("#onboarding-workspace").hidden
  })`),{locked:true,privateSurfaceHidden:true,shellVisible:false,onboardingHidden:true},"fast-visible-shell: onboarding-stays-private");
  await evaluate(`window.__releaseStartupSecondary();true`);
  assert.equal(await waitUntil(`!document.body.classList.contains("auth-locked")&&!document.querySelector("#onboarding-workspace").hidden&&document.querySelector("#onboarding-v2-content h1")?.textContent.includes("先认识此刻的你")`),true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".home-v02-content")).display==="none"`),true);
  await evaluate(`(()=>{const onboarding=window.__onboardingV2;onboarding.session.status="completed";onboarding.session.step="firstAction";sessionStorage.setItem("ui-onboarding-v2",JSON.stringify(onboarding));sessionStorage.setItem("ui-review-projection-test","1");return true})()`);
  await cdp.send("Page.navigate",{url:new URL("review",APP_URL).href});
  const pagedReviewReady=await waitUntil(`document.querySelectorAll("[data-analysis-id]").length===8&&document.querySelector("#analysis-count").textContent==="10 份"&&!document.querySelector("#analysis-pagination").hidden&&document.querySelector('[data-analysis-id="analysis-page-1"] .analysis-content').textContent.includes("正文片段 正文片段 正文片段")`);
  assert.equal(pagedReviewReady,true,JSON.stringify(await evaluate(`({view:document.querySelector(".view.active")?.id,entries:document.querySelectorAll("[data-analysis-id]").length,count:document.querySelector("#analysis-count").textContent,paginationHidden:document.querySelector("#analysis-pagination").hidden,first:document.querySelector('[data-analysis-id="analysis-page-1"] .analysis-content')?.textContent||"",status:document.querySelector('[data-analysis-id="analysis-page-1"] [data-analysis-load-status]')?.textContent||"",requests:window.__apiRequests.slice(-8)})`)));
  assert.equal(await evaluate(`!document.querySelector("#analysis-list").textContent.includes("不得进入普通页面")`),true);
  await evaluate(`document.querySelector("#analysis-load-more").click();true`);
  assert.equal(await waitUntil(`document.querySelectorAll("[data-analysis-id]").length===10&&document.querySelector("#analysis-pagination").hidden`),true);
  await evaluate(`window.__failNextStateRefresh=true;document.querySelector('[data-section="seen"]').click();true`);
  assert.equal(await waitUntil(`document.querySelector("#capture-list .route-load-failure")`),true);
  assert.deepEqual(await evaluate(`(()=>{const failure=document.querySelector("#capture-list .route-load-failure"),toast=document.querySelector("#toast");return{view:document.querySelector(".view.active")?.id,busy:document.querySelector("#view-captures").getAttribute("aria-busy"),title:failure.querySelector("strong").textContent,body:failure.querySelector("p").textContent,action:failure.querySelector("button").textContent,records:document.querySelectorAll("#capture-list [data-capture-id]").length,internal:failure.textContent.includes("DISCOVERY_BACKEND_INTERNAL")||toast.textContent.includes("DISCOVERY_BACKEND_INTERNAL")}})()`),{view:"view-captures",busy:null,title:"暂时无法读取这个页面",body:"已有记录没有变化。请检查网络后重试。",action:"重新读取",records:0,internal:false});
  await evaluate(`document.querySelector("#capture-list .content-state-action").click();true`);
  assert.equal(await waitUntil(`!document.querySelector("#capture-list .route-load-failure")&&document.querySelector("#capture-list [data-capture-id]")&&document.querySelector("#toast").hidden`),true);
  await evaluate(`sessionStorage.removeItem("ui-review-projection-test");true`);
  console.log("UI regression passed: owner capability surfaces, ordinary-user DOM isolation, permission routing, reauthentication, core flows and responsive layouts.");
} finally {
  cdp?.socket.close();
  chrome.kill("SIGKILL");
  await staticServer?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
