import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createReviewFeatureController } from "../public/frontend/features/review-insights/review/controller.mjs";
import {
  experimentViewModel,
  sanitizeAnalysisRecord
} from "../public/frontend/features/review-insights/review/model.mjs";
import { createReviewOperations } from "../public/frontend/features/review-insights/review/operations.mjs";
import {
  clearReviewPresentation,
  renderReviewPresentation
} from "../public/frontend/features/review-insights/review/presentation.mjs";
import { createStatisticsFeatureController } from "../public/frontend/features/review-insights/statistics/controller.mjs";
import {
  renderStatisticsPresentation,
  setStatisticsRange,
  shiftLocalDateKey
} from "../public/frontend/features/review-insights/statistics/presentation.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, enabled) {
    if (enabled) this.values.add(value);
    else this.values.delete(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeTarget {
  constructor({ id = "", value = "" } = {}) {
    this.id = id;
    this.value = value;
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.nodes = new Map();
    this.nodeLists = new Map();
    this.resetCount = 0;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  querySelector(selector) {
    return this.nodes.get(selector) || null;
  }
  querySelectorAll(selector) {
    return this.nodeLists.get(selector) || [];
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  getAttribute(name) {
    return this[name] ?? null;
  }
  focus() {
    this.focused = true;
  }
  reset() {
    this.resetCount += 1;
  }
  contains() {
    return true;
  }
  dispatch(type, target = this) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({
        type,
        target,
        preventDefault() {}
      });
    }
  }
}

function createReviewSurface() {
  const root = new FakeTarget({ id: "view-review" });
  const selectors = [
    "#weekly-summary", "#trend-list", "#association-list", "#cluster-grid",
    "#experiment-list", "#metric-list", "#analysis-count", "#analysis-status",
    "#analysis-list", "#analysis-pagination", "#analysis-pagination-status",
    "#analysis-load-more", "#run-analysis", "#association-flow-toggle"
  ];
  for (const selector of selectors) root.nodes.set(selector, new FakeTarget());
  const analysisList = root.nodes.get("#analysis-list");
  analysisList.nodeLists.set("[data-analysis-id]", []);
  analysisList.nodeLists.set("[data-analysis-id][open]", []);
  const experimentForm = new FakeTarget({ id: "experiment-form" });
  const metricForm = new FakeTarget({ id: "metric-form" });
  const experimentSubmit = new FakeTarget();
  const metricSubmit = new FakeTarget();
  const experimentFields = {
    "#experiment-hypothesis": new FakeTarget({ value: "晨练提升精力" }),
    "#experiment-factor": new FakeTarget({ value: "晨练" }),
    "#experiment-outcome": new FakeTarget({ value: "energy" }),
    "#experiment-duration": new FakeTarget({ value: "14" })
  };
  const metricFields = {
    "#metric-name": new FakeTarget({ value: "专注" }),
    "#metric-low": new FakeTarget({ value: "散乱" }),
    "#metric-high": new FakeTarget({ value: "专注" })
  };
  for (const [selector, node] of Object.entries(experimentFields)) {
    experimentForm.nodes.set(selector, node);
  }
  for (const [selector, node] of Object.entries(metricFields)) {
    metricForm.nodes.set(selector, node);
  }
  experimentForm.nodes.set("button[type='submit']", experimentSubmit);
  metricForm.nodes.set("button[type='submit']", metricSubmit);
  root.nodes.set("#experiment-form", experimentForm);
  root.nodes.set("#metric-form", metricForm);
  root.nodes.set("#experiment-form button[type='submit']", experimentSubmit);
  root.nodes.set("#metric-form button[type='submit']", metricSubmit);
  root.nodeLists.set("[data-experiment-delete],[data-analysis-delete]", []);
  const modal = new FakeTarget({ id: "association-flow-modal" });
  modal.hidden = true;
  modal.nodes.set("#association-flow", new FakeTarget());
  modal.nodes.set("#association-flow-close", new FakeTarget());
  return { root, modal, experimentForm, metricForm };
}

function createStatisticsSurface() {
  const root = new FakeTarget({ id: "view-statistics" });
  const selectors = [
    "#statistics-page-title", "#statistics-status", "#statistics-from",
    "#statistics-to", "#record-total", "#record-stat-sections",
    "#ai-tracking-since", "#ai-kpis", "#ai-calls-chart",
    "#ai-service-summary", "#ai-token-chart", "#ai-modality-summary",
    "#ai-cost-charts", "#ai-scenario-bars", "#ai-model-summary", "#ai-pricing"
  ];
  for (const selector of selectors) root.nodes.set(selector, new FakeTarget());
  const form = new FakeTarget({ id: "statistics-range-form" });
  const submit = new FakeTarget();
  form.nodes.set("button[type='submit']", submit);
  root.nodes.set("#statistics-range-form", form);
  root.nodes.set("#statistics-range-form button[type='submit']", submit);
  const presets = [7, 30, 90].map(days => {
    const button = new FakeTarget();
    button.dataset.statisticsDays = String(days);
    return button;
  });
  root.nodeLists.set("[data-statistics-days]", presets);
  return { root, form, submit, presets };
}

const escapeMarkup = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll('"', "&quot;");
const reviewSnapshot = () => ({
  checkins: [{
    id: "checkin-1",
    occurredOn: "2026-10-06",
    occurredAt: "2026-10-06T08:00:00.000Z",
    mood: 4,
    energy: 4,
    stress: 3,
    sleep: 5,
    factors: ["晨练"]
  }],
  dailyRecords: [],
  captures: [],
  journals: [],
  thoughts: [],
  clusters: [{
    theme: "行动",
    count: 1,
    kept: 1,
    discarded: 0,
    unreviewed: 0,
    items: [{ content: "如何稳定行动" }]
  }],
  experiments: [{
    id: "experiment-1",
    version: 2,
    createdAt: "2026-10-01T08:00:00.000Z",
    hypothesis: "晨练提升精力",
    factor: "晨练",
    outcome: "energy",
    duration: 14
  }],
  customMetrics: [{ id: "focus", name: "专注", low: "散乱", high: "专注" }],
  analyses: [{
    id: "analysis-1",
    version: 1,
    createdAt: "2026-10-06T09:00:00.000Z",
    reason: "manual",
    content: "**当前结论**",
    contentTruncated: false
  }],
  analysisPage: { nextCursor: "cursor-1", total: 2 },
  insights: {
    trends: [{ metric: "mood", current: 4, previous: 3, currentCount: 1 }],
    associations: [{
      factor: "晨练",
      sameDay: 4,
      withCount: 1,
      nextDay: null,
      nextDayCount: 0,
      baseline: null,
      withoutCount: 0,
      confidence: "样本不足"
    }],
    weekly: {
      checkins: 1,
      activeDays7: 1,
      pairedDays30: 0,
      rootCount30: 1,
      tracedRoots30: 1,
      traceRate30: 100,
      correctionActions30: 2,
      reviewAgeDays: 0,
      analysisCount: 1
    }
  },
  reviewSourceCount: 1
});
const reviewView = modal => ({
  associationModal: () => modal,
  contentState: ({ title }) => `<empty>${title}</empty>`,
  contextReceiptMarkup: () => "",
  escapeMarkup,
  escapeSelector: value => String(value),
  plainPreview: value => String(value || "").replaceAll("*", ""),
  renderMarkdown: value => `<markdown>${value}</markdown>`,
  renderLatex() {},
  formatDate: value => String(value).slice(0, 10),
  metricLabel: key => ({ mood: "情绪", energy: "精力", stress: "压力", sleep: "睡眠" })[key] || key,
  showToast() {}
});

const featureIndexSource = await readFile(
  new URL("../public/frontend/features/review-insights/index.mjs", import.meta.url),
  "utf8"
);
assert.match(featureIndexSource, /import\("\.\/review\/controller\.mjs"\)/);
assert.match(featureIndexSource, /import\("\.\/statistics\/controller\.mjs"\)/);
assert.doesNotMatch(featureIndexSource, /^import\s/m);
const reviewPresentationSource = await readFile(
  new URL("../public/frontend/features/review-insights/review/presentation.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(reviewPresentationSource, /#state-chart|#checkin-history/);

assert.equal(shiftLocalDateKey("2026-10-06", -6), "2026-09-30");
const experiment = experimentViewModel(reviewSnapshot().experiments[0], [
  ...Array.from({ length: 3 }, (_, index) => ({
    occurredAt: `2026-10-0${index + 2}T08:00:00.000Z`,
    factors: ["晨练"],
    energy: 5
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    occurredAt: `2026-10-0${index + 2}T10:00:00.000Z`,
    factors: [],
    energy: 3
  }))
], {
  now: Date.parse("2026-10-06T08:00:00.000Z"),
  metricLabel: () => "精力"
});
assert.match(experiment.result, /差值 2\.0/);
assert.deepEqual(sanitizeAnalysisRecord({
  id: "analysis-private",
  content: "公开",
  contentTruncated: true,
  reasoningContent: "私有",
  annotations: [{ shenji: [{ answer: "回答", reasoningContent: "私有推理" }] }]
}), {
  id: "analysis-private",
  content: "公开",
  annotations: [{ shenji: [{ answer: "回答" }] }]
});

const renderedReview = createReviewSurface();
renderReviewPresentation({
  root: renderedReview.root,
  modal: renderedReview.modal,
  snapshot: reviewSnapshot(),
  view: reviewView(renderedReview.modal),
  annotations: { rootKey: () => "", markTarget() {}, applyAnchors() {} },
  platform: { now: () => Date.parse("2026-10-06T08:00:00.000Z") }
});
assert.match(renderedReview.root.nodes.get("#weekly-summary").innerHTML, /近 7 日记录覆盖/);
assert.match(renderedReview.root.nodes.get("#trend-list").innerHTML, /情绪/);
assert.match(renderedReview.root.nodes.get("#cluster-grid").innerHTML, /如何稳定行动/);
assert.match(renderedReview.modal.nodes.get("#association-flow").innerHTML, /按自然日聚合/);
clearReviewPresentation(renderedReview.root, renderedReview.modal);
assert.equal(renderedReview.root.nodes.get("#weekly-summary").innerHTML, "");

let snapshot = reviewSnapshot();
let owner = "account-a";
let sessionSerial = 1;
let routeKey = "review|";
let activation = {};
let generation = 1;
let requestHandler = async () => ({ data: {} });
const requestCalls = [];
const toasts = [];
let requestSequence = 0;
let renderCount = 0;
const operationRoot = createReviewSurface().root;
const operationData = {
  getSnapshot: () => snapshot,
  getAccountId: () => owner,
  getSessionSerial: () => sessionSerial,
  async requestV1(url, options, coordination) {
    requestCalls.push({ url, options, coordination });
    coordination?.onQueued?.({
      operationId: `operation-${requestCalls.length}`,
      createdAt: "2026-10-06T08:00:00.000Z"
    });
    return requestHandler(url, options, coordination);
  },
  async refresh() {},
  applyPendingProjection() {}
};
const createTicket = () => ({
  activation,
  generation,
  owner,
  serial: sessionSerial,
  routeKey
});
const isSameSession = ticket => ticket.owner === owner
  && ticket.serial === sessionSerial;
const isCurrent = ticket => isSameSession(ticket)
  && ticket.activation === activation
  && ticket.generation === generation
  && ticket.routeKey === routeKey;
const operationView = {
  escapeSelector: value => String(value),
  showToast: (message, kind) => toasts.push({ message, kind })
};
const operations = createReviewOperations({
  data: operationData,
  view: operationView,
  platform: {
    createRequestId: () => `request-${++requestSequence}`,
    confirm: () => true
  },
  getRoot: () => operationRoot,
  createTicket,
  isCurrent,
  isSameSession,
  render: () => { renderCount += 1; }
});

const stalePage = deferred();
requestHandler = () => stalePage.promise;
const stalePagination = operations.loadMoreAnalyses();
await waitFor(() => requestCalls.length === 1, "pagination request must start");
routeKey = "mine|";
stalePage.resolve({
  data: {
    analyses: [{ id: "analysis-late", createdAt: "2026-10-01", content: "迟到" }],
    analysisPage: { nextCursor: null, total: 2 }
  }
});
assert.equal(await stalePagination, false);
assert.equal(snapshot.analyses.some(item => item.id === "analysis-late"), false);

routeKey = "review|";
snapshot.analyses[0].contentTruncated = true;
const staleDetailGate = deferred();
requestHandler = () => staleDetailGate.promise;
const staleDetail = operations.loadAnalysisDetail("analysis-1");
await waitFor(() => requestCalls.length === 2, "detail request must start");
owner = "account-b";
sessionSerial += 1;
staleDetailGate.resolve({
  data: {
    id: "analysis-1",
    content: "旧账户完整内容",
    reasoningContent: "不得写入"
  }
});
assert.equal(await staleDetail, false);
assert.notEqual(snapshot.analyses[0].content, "旧账户完整内容");

owner = "account-a";
sessionSerial += 1;
activation = {};
generation += 1;
operations.releaseRoute();
const currentDetailGate = deferred();
requestHandler = () => currentDetailGate.promise;
const currentDetail = operations.loadAnalysisDetail("analysis-1");
await waitFor(() => requestCalls.length === 3, "current detail request must start");
currentDetailGate.resolve({
  data: {
    id: "analysis-1",
    content: "当前完整内容",
    reasoningContent: "私有推理",
    annotations: []
  }
});
assert.equal(await currentDetail, true);
assert.equal(snapshot.analyses[0].content, "当前完整内容");
assert.equal("reasoningContent" in snapshot.analyses[0], false);
assert.equal(renderCount, 1);

const generationGate = deferred();
requestHandler = () => generationGate.promise;
const generationA = operations.generateAnalysis();
const generationB = operations.generateAnalysis();
assert.equal(generationA, generationB);
await waitFor(() => requestCalls.length === 4, "analysis generation must start");
generationGate.reject(Object.assign(new Error("离线"), { syncStatus: "pending" }));
assert.equal(await generationA, false);
const generationKey = requestCalls[3].options.headers["idempotency-key"];
requestHandler = async () => ({ data: { id: "analysis-created" } });
assert.equal(await operations.generateAnalysis(), true);
assert.equal(requestCalls[4].options.headers["idempotency-key"], generationKey);

const deleteGate = deferred();
requestHandler = () => deleteGate.promise;
const deleteA = operations.remove("experiment", "experiment-1");
const deleteB = operations.remove("experiment", "experiment-1");
assert.equal(deleteA, deleteB);
await waitFor(() => requestCalls.length === 6, "experiment deletion must start once");
deleteGate.reject(Object.assign(new Error("离线"), { syncStatus: "pending" }));
assert.equal(await deleteA, false);
const deleteKey = requestCalls[5].options.headers["idempotency-key"];
requestHandler = async () => ({ data: {} });
assert.equal(await operations.remove("experiment", "experiment-1"), true);
assert.equal(requestCalls[6].options.headers["idempotency-key"], deleteKey);

const pending = Object.assign(new Error("待同步"), { syncStatus: "pending" });
requestHandler = async () => { throw pending; };
const pendingForms = createReviewSurface();
const experimentForm = pendingForms.experimentForm;
await operations.submitExperiment(experimentForm, {
  hypothesis: "晨练提升精力",
  factor: "晨练",
  outcome: "energy",
  duration: "14"
});
const pendingExperimentKey = experimentForm.dataset.requestId;
assert.equal(experimentForm.dataset.pendingAccepted, "true");
assert.equal(experimentForm.resetCount, 1);
await operations.submitExperiment(experimentForm, {
  hypothesis: "晨练提升精力",
  factor: "晨练",
  outcome: "energy",
  duration: "14"
});
assert.equal(requestCalls.at(-1).options.headers["idempotency-key"], pendingExperimentKey);
assert.equal(operations.releasePendingForm(experimentForm), true);
await operations.submitExperiment(experimentForm, {
  hypothesis: "新实验",
  factor: "阅读",
  outcome: "sleep",
  duration: "30"
});
assert.notEqual(experimentForm.dataset.requestId, pendingExperimentKey);

const metricForm = pendingForms.metricForm;
await operations.submitMetric(metricForm, {
  name: "专注",
  low: "散乱",
  high: "专注"
});
assert.equal(metricForm.dataset.pendingAccepted, "true");
assert.equal(metricForm.resetCount, 1);
assert.ok(toasts.some(item => item.message === "实验已进入待同步队列"));
assert.ok(toasts.some(item => item.message === "指标已进入待同步队列"));

const lifecycle = createReviewSurface();
const lifecycleDocument = new FakeTarget();
let lifecycleRoute = "review|";
const lifecycleController = createReviewFeatureController({
  data: {
    getSnapshot: reviewSnapshot,
    getAccountId: () => "account-a",
    getSessionSerial: () => 1,
    requestV1: async () => ({ data: {} }),
    refresh: async () => {},
    applyPendingProjection() {}
  },
  navigation: {
    currentRouteKey: () => lifecycleRoute,
    isView: view => view === "review" && lifecycleRoute.startsWith("review")
  },
  annotations: { rootKey: () => "", markTarget() {}, applyAnchors() {} },
  view: reviewView(lifecycle.modal),
  platform: {
    document: lifecycleDocument,
    createRequestId: () => "lifecycle-request",
    confirm: () => true,
    now: () => Date.parse("2026-10-06T08:00:00.000Z")
  }
});
let staleDispose;
for (let cycle = 0; cycle < 20; cycle += 1) {
  const dispose = await lifecycleController.mount({
    root: lifecycle.root,
    route: { view: "review" },
    signal: new AbortController().signal
  });
  assert.equal(lifecycle.root.listenerCount("click"), 1);
  assert.equal(lifecycle.root.listenerCount("submit"), 1);
  assert.equal(lifecycle.root.listenerCount("input"), 1);
  assert.equal(lifecycle.root.listenerCount("toggle"), 1);
  assert.equal(lifecycle.modal.listenerCount("click"), 1);
  assert.equal(lifecycleDocument.listenerCount("keydown"), 1);
  if (staleDispose) assert.equal(await staleDispose(), false);
  staleDispose = dispose;
}
assert.equal(await staleDispose(), true);
assert.equal(lifecycle.root.listenerCount("click"), 0);
assert.equal(lifecycle.modal.listenerCount("click"), 0);
assert.equal(lifecycleDocument.listenerCount("keydown"), 0);
await lifecycleController.resetSession();

const statisticsSurface = createStatisticsSurface();
setStatisticsRange(statisticsSurface.root, "2026-10-06", 7);
assert.equal(statisticsSurface.root.nodes.get("#statistics-from").value, "2026-09-30");
assert.equal(statisticsSurface.presets[0].classList.contains("active"), true);
const statisticsFixture = {
  records: {
    total: 9,
    groups: [{
      label: "所思",
      total: 2,
      modules: [{
        label: "回顾",
        total: 2,
        items: [{ label: "认知复盘", count: 2 }]
      }]
    }]
  },
  ai: {
    trackingStartedAt: "2026-10-01T08:00:00.000Z",
    summary: {
      calls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      unknownStatusCalls: 0,
      usageUnknownCalls: 0,
      costUnknownCalls: 1,
      durationKnownCalls: 2,
      durationMs: 2000,
      tokens: { input: 100, output: 50, cacheHit: 40 },
      costsUsd: { total: 0 },
      costCny: 0.02
    },
    daily: [{
      date: "2026-10-06",
      tokens: { answer: 20, reasoning: 30 },
      services: { deepseekText: { calls: 2 } },
      models: {
        "deepseek-flash": {
          costsCny: { input: 0.001, cacheHit: 0.001, reasoning: 0.002, output: 0.003 }
        }
      }
    }],
    services: [{
      key: "deepseekText",
      label: "DeepSeek 文本",
      calls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      costUnknownCalls: 1,
      costCny: 0.02,
      unitUsage: [{ unitType: "token", units: 150 }]
    }],
    modalities: [{
      modality: "vision",
      label: "图片理解",
      calls: 1,
      successfulCalls: 1,
      imageCount: 2,
      tokens: { input: 20, output: 10 },
      durationKnownCalls: 1,
      durationMs: 500,
      costCny: 0.01
    }],
    models: [{
      model: "deepseek-flash",
      label: "DeepSeek Flash",
      calls: 2,
      costCny: 0.02
    }],
    scenes: [{ scene: "analysis", calls: 2 }],
    providers: [{
      label: "DeepSeek",
      calls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      tokens: { input: 100, output: 50 },
      costUnknownCalls: 1,
      costCny: 0.02
    }],
    pricing: {
      cnyPerUsd: 7.2,
      estimateNote: "按官方价估算。",
      historicalUsdNote: "历史美元账本已换算。",
      source: "https://example.com/deepseek",
      checkedAt: "2026-10-06",
      models: {
        flash: {
          label: "DeepSeek Flash",
          offPeak: { cacheHit: 0.5, cacheMiss: 2, output: 8 },
          peak: { cacheHit: 1, cacheMiss: 4, output: 16 }
        }
      },
      providerRates: [{
        label: "语音合成",
        priceCny: 2,
        unitLabel: "万字符",
        source: "https://example.com/tts",
        checkedAt: "2026-10-06"
      }]
    }
  }
};
renderStatisticsPresentation({
  root: statisticsSurface.root,
  data: statisticsFixture,
  view: {
    escapeMarkup,
    formatTrackingStart: () => "2026年10月1日 08:00"
  }
});
assert.match(statisticsSurface.root.nodes.get("#record-total").innerHTML, />9</);
assert.match(statisticsSurface.root.nodes.get("#ai-calls-chart").innerHTML, /analytics-svg/);
assert.match(statisticsSurface.root.nodes.get("#ai-token-chart").innerHTML, /推理/);
assert.match(statisticsSurface.root.nodes.get("#ai-service-summary").innerHTML, /150 Token/);
assert.match(statisticsSurface.root.nodes.get("#ai-pricing").innerHTML, /历史美元账本/);

let statisticsOwner = "account-a";
let statisticsSession = 1;
let statisticsRoute = "statistics|";
const statisticsRequests = [];
const statisticsController = createStatisticsFeatureController({
  data: {
    request(url) {
      const gate = deferred();
      statisticsRequests.push({ url, gate });
      return gate.promise;
    },
    getAccountId: () => statisticsOwner,
    getSessionSerial: () => statisticsSession,
    hasCapability: capability => capability === "ai-costs"
  },
  navigation: {
    currentRouteKey: () => statisticsRoute,
    isView: view => view === "statistics" && statisticsRoute.startsWith("statistics")
  },
  view: {
    escapeMarkup,
    formatTrackingStart: value => String(value)
  },
  platform: { getCurrentDate: () => "2026-10-06" }
});
const statisticsStaleSurface = createStatisticsSurface();
await statisticsController.mount({
  root: statisticsStaleSurface.root,
  route: { view: "statistics" },
  signal: new AbortController().signal
});
await waitFor(() => statisticsRequests.length === 1, "statistics request must start");
statisticsRoute = "mine|";
statisticsOwner = "account-b";
statisticsSession += 1;
await statisticsController.unmount();
statisticsRequests[0].gate.resolve(statisticsFixture);
await tick();
assert.equal(statisticsStaleSurface.root.nodes.get("#record-total").innerHTML, "");

statisticsRoute = "statistics|";
const statisticsDispose = await statisticsController.mount({
  root: statisticsStaleSurface.root,
  route: { view: "statistics" },
  signal: new AbortController().signal
});
await waitFor(() => statisticsRequests.length === 2, "new statistics request must start");
statisticsRequests[1].gate.resolve(statisticsFixture);
await waitFor(
  () => statisticsStaleSurface.root.nodes.get("#record-total").innerHTML.includes("9"),
  "current statistics result must render"
);
statisticsOwner = "account-c";
statisticsSession += 1;
await statisticsController.mount({
  root: statisticsStaleSurface.root,
  route: { view: "statistics" },
  signal: new AbortController().signal
});
assert.equal(
  statisticsStaleSurface.root.nodes.get("#record-total").innerHTML,
  "",
  "mounting for another account must scrub the previous statistics cache"
);
statisticsRequests.at(-1).gate.resolve(statisticsFixture);
await waitFor(
  () => statisticsStaleSurface.root.nodes.get("#record-total").innerHTML.includes("9"),
  "new account statistics result must render"
);
for (let cycle = 0; cycle < 10; cycle += 1) {
  const dispose = await statisticsController.mount({
    root: statisticsStaleSurface.root,
    route: { view: "statistics" },
    signal: new AbortController().signal
  });
  assert.equal(statisticsStaleSurface.root.listenerCount("click"), 1);
  assert.equal(statisticsStaleSurface.root.listenerCount("submit"), 1);
  statisticsRequests.at(-1).gate.resolve(statisticsFixture);
  await tick();
  if (cycle === 9) await dispose();
}
assert.equal(await statisticsDispose(), false);
assert.equal(statisticsStaleSurface.root.listenerCount("click"), 0);
assert.equal(statisticsStaleSurface.root.listenerCount("submit"), 0);
await statisticsController.resetSession();
assert.equal(statisticsStaleSurface.root.nodes.get("#record-total").innerHTML, "");

console.log(
  "Frontend review insights feature checks passed: page-level lazy loading, "
  + "review/checkins ownership, late detail and pagination rejection, idempotent "
  + "generation and deletion, pending experiment/metric recovery, statistics "
  + "stale guards, chart rendering and repeated mount cleanup."
);
