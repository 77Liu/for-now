import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createThoughtChains,
  currentUserConclusion,
  normalizeThoughtSearch,
  pendingThoughtTask,
  thoughtListPreview,
  thoughtMatchesSearch,
  visibleThoughtChains
} from "../public/frontend/features/thoughts/model.mjs";
import { createThoughtPresentation } from "../public/frontend/features/thoughts/presentation.mjs";
import { createThoughtsFeatureController } from "../public/frontend/features/thoughts/index.mjs";
import { isPendingAiTaskStatus } from "../public/frontend/shared/ai-task-status.mjs";
import {
  THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE,
  THOUGHT_ANSWER_UNKNOWN_MESSAGE
} from "../public/generated/personalized-ai-task.mjs";

const occurred = (day, hour) => `2026-10-${day}T${hour}:00:00.000Z`;
const records = [
  {
    id: "root-old",
    type: "question",
    content: "如何稳定推进长期项目",
    tags: ["复盘"],
    remarks: [{ id: "remark-1", text: "先缩小范围", createdAt: occurred("04", "10") }],
    followUps: [],
    occurredAt: occurred("04", "09"),
    createdAt: occurred("06", "09"),
    version: 2,
    authorType: "user"
  },
  {
    id: "idea-old",
    type: "idea",
    relatedTo: "root-old",
    content: "每天完成一个闭环",
    authorType: "user",
    occurredAt: occurred("04", "09"),
    createdAt: occurred("04", "09"),
    version: 1
  },
  {
    id: "answer-ai",
    type: "answer",
    relatedTo: "root-old",
    content: "AI 建议",
    citations: [{
      sourceId: "thought:root-old",
      recordType: "用户记录",
      version: 2,
      exactQuote: "如何稳定推进长期项目"
    }],
    citationStatus: "matched",
    authorType: "ai",
    occurredAt: occurred("04", "11"),
    createdAt: occurred("04", "11"),
    version: 1
  },
  {
    id: "answer-user",
    type: "answer",
    relatedTo: "root-old",
    content: "结论：只保留一个当前目标",
    authorType: "user",
    occurredAt: occurred("05", "11"),
    createdAt: occurred("05", "11"),
    version: 1
  },
  {
    id: "root-new",
    type: "question",
    content: "今天先做什么",
    tags: ["行动"],
    remarks: [],
    followUps: [{
      id: "follow-1",
      question: "先完成哪一步",
      answer: "",
      version: 1,
      createdAt: occurred("06", "10")
    }],
    occurredAt: occurred("06", "08"),
    createdAt: occurred("04", "08"),
    version: 1,
    authorType: "user"
  },
  {
    id: "orphan",
    type: "record",
    relatedTo: "missing-root",
    content: "旧记录",
    occurredAt: occurred("03", "08"),
    createdAt: occurred("03", "08"),
    version: 1
  }
];

assert.equal(normalizeThoughtSearch("  长期   项目 "), "长期 项目");
assert.equal(isPendingAiTaskStatus("waiting_for_user_model"), true);
assert.equal(isPendingAiTaskStatus("succeeded"), false);
assert.deepEqual(
  createThoughtChains(records, "occurred").map(chain => chain.question.id),
  ["root-new", "root-old", "orphan"]
);
assert.deepEqual(
  createThoughtChains(records, "created").map(chain => chain.question.id),
  ["root-old", "root-new", "orphan"]
);
const oldChain = createThoughtChains(records).find(chain => chain.question.id === "root-old");
assert.equal(currentUserConclusion(oldChain.children).id, "answer-user");
assert.deepEqual(thoughtListPreview(oldChain.children), {
  kind: "conclusion",
  label: "我的结论",
  text: "只保留一个当前目标"
});
assert.equal(thoughtMatchesSearch(oldChain, "长期 一个"), true);
assert.equal(thoughtMatchesSearch(oldChain, "不存在"), false);
assert.deepEqual(
  visibleThoughtChains({
    records,
    tag: "复盘",
    query: "每天",
    complete: true
  }).items.map(chain => chain.question.id),
  ["root-old"]
);
assert.deepEqual(
  visibleThoughtChains({
    records,
    tag: "复盘",
    query: "不存在",
    complete: false
  }).items.map(chain => chain.question.id),
  ["root-old"],
  "server-projected pages must not be filtered a second time"
);

const snapshot = {
  thoughts: records,
  aiTasks: [{
    id: "task-1",
    kind: "followUpAnswer",
    targetId: "root-new",
    subtargetId: "follow-1",
    status: "queued"
  }, {
    id: "task-root",
    kind: "thoughtAnswer",
    targetId: "root-new",
    status: "waiting_for_user_model"
  }],
  insights: { aiOnlyThoughtIds: ["root-new"] },
  speech: {
    configured: true,
    voices: [{ id: "voice-1", label: "官方音色" }],
    assets: [{
      id: "asset-1",
      sourceType: "thoughtAnswer",
      sourceId: "answer-ai",
      sourceVersion: 1,
      voice: "voice-1",
      createdAt: occurred("06", "12")
    }]
  }
};
const presentation = createThoughtPresentation({
  getSnapshot: () => snapshot,
  appUrl: value => `/now${value}`,
  contextReceiptMarkup: (_receipt, citations, citationStatus) => (
    citationStatus === "matched"
      ? `<aside data-citation-status="matched">${citations.map(item => `<q>${item.exactQuote}</q>`).join("")}</aside>`
      : ""
  ),
  contentImagesMarkup: () => ""
});
const listMarkup = presentation.cardsMarkup(createThoughtChains(records), "occurred", {
  groupMonths: true
});
assert.match(listMarkup, /data-chain-id="root-new"/);
assert.match(listMarkup, /回答正在后台生成，可继续使用其他功能/);
assert.match(listMarkup, /等待核心用户模型就绪；完成核心问答后会自动继续/);
assert.match(listMarkup, /data-answer-chain="root-new" disabled/);
assert.equal(pendingThoughtTask(snapshot.aiTasks, "thoughtAnswer", "root-new").status, "waiting_for_user_model");
assert.match(listMarkup, /thought-trace-pending/);
snapshot.aiTasks[0].status = "waiting_for_user_model";
const waitingFollowUpMarkup = presentation.cardsMarkup(createThoughtChains(records), "occurred", {
  groupMonths: true
});
assert.match(waitingFollowUpMarkup, /data-followup-answer="follow-1"[^>]*disabled/);
assert.match(waitingFollowUpMarkup, /等待核心用户模型就绪；完成核心问答后会自动继续/);
const detailMarkup = presentation.cardsMarkup([oldChain], "occurred", { detail: true });
assert.equal((detailMarkup.match(/thought-detail-title/g) || []).length, 1);
assert.equal((detailMarkup.match(/class="chain-summary"/g) || []).length, 0);
assert.match(detailMarkup, /data-speech-source-version="1"/);
assert.match(detailMarkup, /\/now\/api\/speech\/audio\?id=asset-1/);
assert.match(detailMarkup, /data-citation-status="matched"/);
assert.match(detailMarkup, /<q>如何稳定推进长期项目<\/q>/,
  "verified citations must flow from persisted answer metadata into visible answer markup");

const operationRequestBodies = [];
const operationToasts = [];
const operationSnapshot = { thoughts: records, aiTasks: [] };
let operationRequestSerial = 0;
let operationRequestCount = 0;
let scheduledOperationPolls = 0;
const rootListeners = new Map();
const thoughtRoot = {
  dataset: {},
  classList: { toggle() {} },
  addEventListener(type, listener) { rootListeners.set(type, listener); },
  removeEventListener(type) { rootListeners.delete(type); },
  querySelector: () => null,
  querySelectorAll: () => [],
  innerHTML: ""
};
const thoughtDocument = {
  activeElement: null,
  querySelector: selector => selector === "#all-thoughts" ? thoughtRoot : null,
  querySelectorAll: () => []
};
const thoughtWindow = { addEventListener() {}, removeEventListener() {} };
const thoughtButton = {
  dataset: { answerChain: "root-new" },
  disabled: false,
  matches: () => false
};
// 未配置合成不应隐藏既有缓存；没有缓存则不显示空播放器或播放倍速。
const configuredBefore = snapshot.speech.configured;
snapshot.speech.configured = false;
const cachedOnlyMarkup = presentation.cardsMarkup([oldChain], "occurred", { detail: true });
assert.match(cachedOnlyMarkup, /data-speech-player="asset-1"/);
assert.doesNotMatch(cachedOnlyMarkup, /data-speech-synthesize/);
snapshot.speech.assets = [];
assert.doesNotMatch(presentation.cardsMarkup([oldChain], "occurred", { detail: true }), /data-speech-player|data-speech-playback-rate/);
snapshot.speech.configured = configuredBefore;
snapshot.speech.assets = [{ id: "asset-1", sourceType: "thoughtAnswer", sourceId: "answer-ai", sourceVersion: 1, voice: "voice-1" }];
const thoughtController = createThoughtsFeatureController({
  delegate: {
    mount: async () => () => {},
    render: () => false,
    unmount() {},
    resetSession() {}
  },
  data: {
    getSnapshot: () => operationSnapshot,
    getAccountId: () => "thoughts-feature-owner",
    getSessionSerial: () => 1,
    isRouteDataReady: () => true,
    isFullRouteStateLoaded: () => true,
    request: async (_path, options) => {
      operationRequestBodies.push(options.body);
      operationRequestCount += 1;
      if (operationRequestCount === 1) {
        throw Object.assign(new Error("private connection detail"), { status: 0 });
      }
      return {
        id: "thought-operation-task",
        kind: "thoughtAnswer",
        targetId: "root-new",
        inputVersion: 1,
        status: "queued"
      };
    },
    requestV1: async () => ({}),
    requestBlob: async () => new Blob(),
    requestHeadStatus: async () => ({ ok: true, status: 200 }),
    refresh: async () => { throw new Error("private refresh detail"); },
    applyPendingProjection() {}
  },
  navigation: {
    currentRoute: () => ({ view: "thoughts", query: {} }),
    openDetail() {},
    backToList() {},
    replaceQuery() {},
    showUnavailable() {},
    clearResult() {}
  },
  media: {
    resetEditor() {}, persistDraft() {}, submitDraft() {}, completeDraft() {},
    rollbackDraft() {}, uncertainSubmission() { return false; },
    contentImagesMarkup: () => "", hasDraftItems: () => false
  },
  annotations: {
    tagTargets() {}, applyAnchors() {}, scheduleLayout() {}, openPanel() {}, rootKey: () => ""
  },
  crossDomain: {
    getActiveDate: () => "2026-10-12",
    openComposer() {},
    scheduleNotificationPoll: () => { scheduledOperationPolls += 1; }
  },
  view: {
    appUrl: value => value,
    contextReceiptMarkup: () => "",
    contentState: () => "",
    renderLatex() {},
    showToast: (message, kind) => operationToasts.push({ message, kind }),
    resetOccurrenceInput() {},
    occurrenceFields: () => ({}),
    presentError() {}
  },
  platform: {
    createRequestId: () => `thought-operation-${++operationRequestSerial}`,
    escapeSelector: value => value,
    confirm: () => true,
    prompt: () => "",
    requestFrame() {},
    setTimer: () => 1,
    clearTimer() {},
    getComputedStyle: () => ({ getPropertyValue: () => "420" }),
    matchesMedia: () => false,
    audio: { claim() {}, stopAll() {} },
    document: thoughtDocument,
    window: thoughtWindow
  },
});
assert.equal(thoughtController.hasActiveAnnotationSelection(), false, "未加载门面不保护不存在的选区");
assert.equal(thoughtController.resumeSelectionRender(), false, "未加载不触发异步模块/重绘");
assert.equal(thoughtController.isAnnotationRootLoaded("root-new"), false, "公开loader未加载时不声称批注完整");
await thoughtController.mount({
  root: thoughtRoot,
  route: { view: "thoughts", query: {} },
  signal: new AbortController().signal
});
assert.equal(thoughtController.isAnnotationRootLoaded("root-new"), true, "公开loader透传已加载完整快照证明");
const clickAnswer = () => rootListeners.get("click")({
  target: { closest: selector => selector === "button" ? thoughtButton : null }
});
await clickAnswer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(operationToasts[0].message, THOUGHT_ANSWER_UNKNOWN_MESSAGE);
assert.equal(operationToasts[0].message.includes("private"), false);
await clickAnswer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(thoughtButton.disabled, true,
  "a confirmed queued task keeps the existing answer action disabled");
assert.equal(operationRequestBodies[0], operationRequestBodies[1],
  "the thoughts retry entry confirms the same outstanding enqueue request");
assert.equal(operationSnapshot.aiTasks[0].id, "thought-operation-task");
assert.equal(scheduledOperationPolls, 1,
  "a confirmed queued task keeps notification polling active after refresh failure");
assert.match(operationToasts[1].message, /^回答已进入后台队列。/);
assert.ok(operationToasts[1].message.includes(THOUGHT_ANSWER_NOTIFICATIONS_STALE_MESSAGE));
assert.equal(operationToasts[1].message.includes("private"), false);

const runtime = await readFile(
  new URL("../public/frontend/app/runtime.mjs", import.meta.url),
  "utf8"
);
const descriptorRuntime = await readFile(
  new URL("../public/frontend/app/runtime/page-descriptors-insights.mjs", import.meta.url),
  "utf8"
);
for (const removed of [
  "function renderThoughts(",
  "function thoughtChains(",
  "function patchThoughtTaskTarget(",
  "function openThoughtBlockEditor(",
  "function loadMoreThoughts("
]) {
  assert.equal(runtime.includes(removed), false, `runtime retains thought implementation: ${removed}`);
}
assert.match(runtime, /import\("\.\.\/features\/thoughts\/index\.mjs"\)/);
assert.match(descriptorRuntime, /descriptors\.thoughts=.*loadThoughtsPage\("thoughts"\)/);
assert.match(descriptorRuntime, /descriptors\.together=.*loadThoughtsPage\("together"\)/);

console.log(
  "Frontend thoughts feature checks passed: hierarchy, search, route presentation, "
  + "source-versioned speech and legacy runtime removal."
);

// F4窗口只保留相邻100摘要；真实游标由正式领域生成，不在客户端解码。
{
  const { thoughtChainListPage } = await import("../src/modules/thoughts/index.mjs");
  const { THOUGHT_PAGING } = await import("../public/generated/thought-pagination-config.mjs");
  const { seedThoughtWindow, extendThoughtWindow, thoughtWindowProjection, saveThoughtCheckpoint } = await import("../public/generated/thought-page-window.mjs");
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `window-${String(i).padStart(4, "0")}`, type: "question", content: "summary", occurredAt: "2026-10-01" }));
  const fetchPage = (afterId = "", direction = "next") => {
    const p = thoughtChainListPage(rows, { afterId, direction });
    return { requestCursor: afterId, direction, items: p.items, nextCursor: p.nextId, prevCursor: p.prevId };
  };
  const first = fetchPage(); let w = seedThoughtWindow(first.items, first, "owner", "route", THOUGHT_PAGING), seen = new Set(first.items.map(i => i.id));
  while (thoughtWindowProjection(w).nextCursor) {
    const page = fetchPage(thoughtWindowProjection(w).nextCursor);
    page.items.forEach(i => seen.add(i.id)); w = extendThoughtWindow(w, page, "next", THOUGHT_PAGING);
    assert.ok(w.pages.length <= 5); assert.ok(thoughtWindowProjection(w).items.length <= 100);
  }
  assert.equal(seen.size, 1001);
  while (thoughtWindowProjection(w).prevCursor) {
    const page = fetchPage(thoughtWindowProjection(w).prevCursor, "prev"); w = extendThoughtWindow(w, page, "prev", THOUGHT_PAGING);
    assert.ok(w.pages.length <= 5);
  }
  assert.equal(thoughtWindowProjection(w).items[0].id, first.items[0].id);
  assert.throws(() => extendThoughtWindow({ ...w, stale: true }, first, "next", THOUGHT_PAGING), /变化/);
  const memory = new Map(), storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
  for (let i = 0; i < 20; i++) saveThoughtCheckpoint(storage, "owner", String(i), { cursor: String(i), direction: "next", anchorId: String(i), offset: 0 }, 10);
  assert.equal(JSON.parse([...memory.values()][0]).length, 10);
}

// F4实际operations：迟到请求及旧finally不接管新ticket，存储禁用不改判成功。
{
  const { THOUGHT_PAGING } = await import("../public/generated/thought-pagination-config.mjs");
  let route = { view: "thoughts", kind: "page", query: {} }, life = {}, owner = "a";
  let state = { thoughts: [{ id: "first" }], thoughtPage: { kind: "list", nextCursor: "edge-a", prevCursor: null } };
  const deferred = [], writeDeferred = [];
  const status = { isConnected: true, textContent: "" };
  const fakeDocument = { querySelectorAll: () => [], querySelector: selector => selector === "#thought-pagination-status" ? status : null, activeElement: null };
  const fakeWindow = Object.defineProperty({}, "sessionStorage", { get() { throw new Error("storage unavailable"); } });
  const listeners = new Map(), root = { ...thoughtRoot, replaceChildren() {}, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  fakeDocument.querySelector = selector => selector === "#all-thoughts" ? root : selector === "#thought-pagination-status" ? status : null;
  const controller = createThoughtsFeatureController({
    data: { getSnapshot: () => state, getThoughtPaging: () => ({ ...THOUGHT_PAGING, enabled: true }), getAccountId: () => owner, getSessionSerial: () => 1,
      isRouteDataReady: () => true, isFullRouteStateLoaded: () => false, request: async () => new Promise(resolve => writeDeferred.push(resolve)), requestBlob() {}, requestHeadStatus() {}, refresh() {}, applyPendingProjection() {},
      requestV1: async (_url, options) => new Promise(resolve => deferred.push({ resolve, signal: options.signal })) },
    navigation: { currentRoute: () => route, replaceQuery: query => { route = { ...route, query }; }, openDetail() {}, backToList() {}, showUnavailable() {}, clearResult() {} },
    media: { resetEditor() {}, persistDraft() {}, submitDraft() {}, completeDraft() {}, rollbackDraft() {}, uncertainSubmission() {}, contentImagesMarkup: () => "", hasDraftItems: () => false },
    annotations: { tagTargets() {}, applyAnchors() {}, scheduleLayout() {}, openPanel() {}, rootKey: () => "" },
    crossDomain: { getActiveDate: () => "2026-10-01", openComposer() {}, scheduleNotificationPoll() {} },
    view: { appUrl: value => value, contextReceiptMarkup: () => "", contentState: () => "", renderLatex() {}, showToast() {}, resetOccurrenceInput() {}, occurrenceFields: () => ({}), presentError() {} },
    platform: { document: fakeDocument, window: fakeWindow, requestFrame() {}, escapeSelector: value => value, createRequestId: () => "test", confirm: () => true, prompt: () => "", setTimer: () => 1, clearTimer() {}, getComputedStyle: () => ({ getPropertyValue: () => "420" }), matchesMedia: () => false, audio: { claim() {}, stopAll() {} } }
  });
  const mount = () => controller.mount({ root, route, signal: new AbortController().signal });
  const click = () => listeners.get("click")({ target: { closest: selector => selector === "button" ? { id: "thought-load-more", dataset: {}, matches: () => false } : null } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await mount();
  click();
  await controller.unmount();
  assert.equal(deferred[0].signal.aborted, true);
  route = { view: "thoughts", kind: "page", query: { q: "new" } };
  state = { thoughts: [{ id: "new-first" }], thoughtPage: { kind: "list", query: "new", nextCursor: "edge-b", prevCursor: null } };
  await mount();
  click();
  deferred[0].resolve({ data: [{ id: "obsolete" }], meta: { nextCursor: null, prevCursor: "a" } });
  await tick();
  click();
  await tick();
  assert.equal(deferred.length, 2);
  deferred[1].resolve({ data: [{ id: "new-second" }], meta: { nextCursor: "edge-c", prevCursor: "b" } });
  await tick();
  assert.deepEqual(state.thoughts.map(item => item.id), ["new-first", "new-second"]);
  click(); owner = "other"; life = {};
  deferred[2].resolve({ data: [{ id: "wrong-owner" }], meta: { nextCursor: null, prevCursor: "c" } });
  await tick();
  assert.equal(state.thoughts.some(item => item.id === "wrong-owner"), false);
  state.thoughts = [{ id: "edit-root", type: "question", content: "saved", followUps: [{ id: "edit-follow", question: "old", answer: "", version: 1 }] }];
  const submitButton = { disabled: false, isConnected: true };
  const form = {
    id: "", dataset: { rootId: "edit-root", followupEdit: "edit-follow", version: "1" },
    elements: { question: { value: "new" }, answer: { value: "" } },
    matches: () => true, closest: () => null,
    querySelector: () => submitButton
  };
  listeners.get("submit")({ target: form, preventDefault() {} });
  assert.equal(writeDeferred.length, 1);
  owner = "switched-again";
  writeDeferred[0]({ id: "edit-follow", question: "new", answer: "", version: 2 });
  await tick();
  assert.equal(state.thoughts[0].followUps[0].question, "old", "旧账户的追问ACK不能进入新账户快照");
  // 通过公开控制器提交路径验证ACK，分页摘要不能因根ID/版本相同而获得追问正文。
  state = {
    thoughts: [{ id: "ack-root", type: "question", content: "摘要", version: 3, blockCount: 0 }],
    thoughtPage: { kind: "list" }
  };
  const saved = { id: "ack-follow", question: "追问正文", answer: "", version: 1 };
  const createForm = {
    ...form,
    dataset: { followUpRoot: "ack-root" },
    elements: { question: { value: saved.question }, answer: { value: "" } }
  };
  const acknowledge = async () => {
    listeners.get("submit")({ target: createForm, preventDefault() {} });
    writeDeferred.at(-1)(saved);
    await tick();
  };
  const summaryBeforeAck = structuredClone(state);
  await acknowledge();
  assert.deepEqual(state, summaryBeforeAck, "列表摘要不能接入追问ACK正文");
  state = {
    thoughts: [{ id: "ack-root", type: "question", version: 3, followUps: [] }],
    thoughtPage: { kind: "detail" }
  };
  await acknowledge();
  assert.deepEqual(state.thoughts[0].followUps, [saved]);
  assert.equal(state.thoughts[0].version, 4);
  await acknowledge();
  assert.equal(state.thoughts[0].followUps.length, 1, "重复ACK不增加追问");
  assert.equal(state.thoughts[0].version, 4);
  listeners.get("submit")({ target: createForm, preventDefault() {} });
  state.thoughts[0].followUps = [];
  state.thoughts[0].version = 5;
  writeDeferred.at(-1)(saved);
  await tick();
  assert.equal(state.thoughts[0].followUps.length, 0, "已删除追问不因旧ACK复活");
  // 跨页窗口中激活的记录决定返回游标，不能使用视口首条的游标。
  const cards = ["visible", "activated"].map((id, index) => ({
    dataset: { chainId: id },
    getBoundingClientRect: () => ({ top: index ? 2000 : 50, bottom: index ? 2100 : 150 })
  }));
  route = { view: "thoughts", kind: "page", query: {} };
  state = { thoughts: cards.map(card => ({ id: card.dataset.chainId, type: "question", content: "摘要", createdAt: "2026-10-19T00:00:00.000Z" })), thoughtPage: {
    kind: "list", window: { ownerKey: `${owner}|1`, routeKey: JSON.stringify(["thoughts", "page", "", "", []]),
      generation: 0, stale: false, pages: [
        { items: [{ id: "visible" }], requestCursor: "visible-cursor", direction: "next" },
        { items: [{ id: "activated" }], requestCursor: "activated-cursor", direction: "next" }
      ] }
  } };
  fakeWindow.innerHeight = 800;
  fakeDocument.querySelectorAll = selector => selector === "#all-thoughts [data-chain-id]" ? cards : [];
  fakeDocument.querySelector = selector => selector.includes('[data-chain-id="activated"]') ? cards[1]
    : selector === "#all-thoughts" ? root : selector === "#thought-pagination-status" ? status : null;
  await mount();
  const summary = { closest: () => cards[1] };
  listeners.get("click")({ preventDefault() {}, target: {
    closest: selector => selector === ".chain-summary" ? summary : null
  } });
  await tick();
  assert.equal(route.query.cursor, "activated-cursor");
  await assert.doesNotReject(() => controller.resetSession());
}

{
  const { summarizeThoughtWindowItems } = await import("../public/generated/thought-page-window.mjs");
  const { THOUGHT_PAGING } = await import("../public/generated/thought-pagination-config.mjs");
  const raw = [{ id: "pending", type: "question", content: "x".repeat(10000), _sync: { status: "pending", operationId: "queued" } }, { id: "idea", type: "idea", relatedTo: "pending", content: "y".repeat(1000) }];
  const summary = summarizeThoughtWindowItems(raw, THOUGHT_PAGING, thoughtListPreview);
  assert.equal(summary.length, 1); assert.equal(summary[0].content.length, THOUGHT_PAGING.questionPreviewLimit);
  assert.equal(summary[0].preview.content.length, THOUGHT_PAGING.userPreviewLimit);
  assert.equal(summary[0]._sync.operationId, "queued"); assert.equal(raw[0].content.length, 10000);
}

{
  const { reconcileThoughtWindowMutation } = await import("../public/frontend/features/thoughts/index.mjs");
  const { THOUGHT_PAGING } = await import("../public/generated/thought-pagination-config.mjs");
  const root = { id: "semantic", type: "question", content: "q", tags: ["root"], blockCount: 3, answerCount: 2, preview: { kind: "idea", content: "old", truncated: true }, _sync: { status: "pending" } };
  const state = { thoughtPage: { window: { pages: [], stale: false, generation: 0 } }, thoughts: [root] };
  const route = { view: "thoughts", kind: "page" };
  reconcileThoughtWindowMutation(state, route, true, THOUGHT_PAGING);
  assert.equal(state.thoughts[0].preview.truncated, true); assert.equal(state.thoughts[0].blockCount, 3);
  assert.equal(state.thoughts[0]._sync.status, "pending");
  state.thoughts.push(
    { id: "ai", relatedTo: root.id, type: "answer", content: "AI cannot be mine", authorType: "ai", occurredAt: "2026-10-16", tags: ["child"] },
    { id: "discarded", relatedTo: root.id, type: "answer", content: "discarded", disposition: "discarded", authorType: "user", occurredAt: "2026-10-16" },
    { id: "user", relatedTo: root.id, type: "answer", content: "核心判断：我的回答", authorType: "user", occurredAt: "2026-10-15" }
  );
  reconcileThoughtWindowMutation(state, route, true, THOUGHT_PAGING);
  assert.equal(state.thoughts[0].preview.content, "我的回答");
  assert.deepEqual(state.thoughts[0].tags, ["root", "child"]);
  assert.equal(state.thoughtPage.window.generation, 1, "restoring the same already stale window is not a new generation");
}

// F7同一阅读恢复批次：真实用户意图/账户/路由变化撤销迟到帧，程序恢复不自行增长意图。
{
  const { createThoughtReadingState } = await import("../public/generated/thought-page-window.mjs");
  let scope = "owner-a:session-1:detail-a";
  const reading = createThoughtReadingState(() => scope);
  const first = reading.beginRender();
  assert.equal(reading.isCurrent(first), true);
  reading.interact();
  assert.equal(reading.isCurrent(first), false);
  const second = reading.beginRender();
  assert.equal(reading.isCurrent(second), true);
  reading.beginRender();
  assert.equal(reading.isCurrent(second), false);
  const beforeAccountSwitch = reading.capture();
  scope = "owner-b:session-2:detail-a";
  assert.equal(reading.isCurrent(beforeAccountSwitch), false);
  const beforeLeaving = reading.capture();
  reading.invalidate();
  assert.equal(reading.isCurrent(beforeLeaving), false);
}

// F9完整同步域经公开有界端口更新列表，不驻留批注/追问/模型正文。
{
  const { applyThoughtWindowSync } = await import('../public/frontend/features/thoughts/index.mjs');
  const limits = { pageSize: 20, maxPages: 5, maxCheckpoints: 10, questionPreviewLimit: 600, userPreviewLimit: 600 };
  const roots = Array.from({ length: 100 }, (_, i) => ({ id: `sync-${i}`, type: 'question', content: `原问题${i}`, createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, 100 - i)).toISOString(), version: 1, tags: [], blockCount: 0 }));
  const createSnapshot = (deep = false) => ({ thoughts: structuredClone(roots), thoughtPage: { kind: 'list', sort: 'created', window: { generation: 0, stale: false, ownerKey: 'owner', routeKey: 'route', pages: Array.from({ length: 5 }, (_, i) => ({ requestCursor: i || deep ? `opaque-${i}` : '', prevCursor: i || deep ? 'opaque-prev' : '', nextCursor: 'opaque-next', direction: 'next', items: structuredClone(roots.slice(i * 20, i * 20 + 20)) })) } } });
  const addition = { id: 'new-sync', type: 'question', content: '新问题'.repeat(600), createdAt: '2026-10-21T00:00:00.000Z', version: 1, tags: [], annotations: [{ text: '不得驻留批注正文' }], annotationDrift: [{ text: '不得驻留漂流' }], followUps: [{ answer: '不得驻留追问全文' }], modelDraft: '不得驻留模型草稿', modelReasoning: '不得驻留推理' };
  const incoming = [...structuredClone(roots), addition, { id: 'ai-block', relatedTo: addition.id, type: 'answer', authorType: 'ai', content: 'AI不得冒充我的结论' }, { id: 'user-idea', relatedTo: addition.id, type: 'idea', authorType: 'user', content: '真实用户想法' }];
  const changes = [{ domain: 'thoughts', resourceId: addition.id, changeType: 'create' }];
  const protectedSnapshot = createSnapshot();
  applyThoughtWindowSync(protectedSnapshot, incoming, { query: { sort: 'created' } }, limits, () => false, changes);
  assert.equal(protectedSnapshot.thoughts.length, 100);
  assert.equal(protectedSnapshot.thoughts.some(item => item.id === addition.id), false, '阅读目标不可为了新根被强制淘汰');
  assert.equal(protectedSnapshot.thoughtPage.window.pages.length, 5);
  const current = createSnapshot();
  applyThoughtWindowSync(current, incoming, { query: { sort: 'created' } }, limits, () => true, changes);
  assert.equal(current.thoughts.length, 100);
  const summary = current.thoughts[0];
  assert.equal(summary.id, addition.id);
  assert.equal(summary.content.length, 600);
  assert.equal(summary.preview.kind, 'idea');
  for (const key of ['annotations', 'annotationDrift', 'followUps', 'modelDraft', 'modelReasoning', 'attachmentPaths']) assert.equal(Object.hasOwn(summary, key), false, key);
  assert.equal(current.thoughtPage.stale, true);
  assert.equal(current.thoughtPage.window.pages.length, 5, '旧定位凭据仍保留，但stale禁止继续旧cursor');
  const pending = createSnapshot();
  pending.thoughts[0]._sync = { status: 'sending', operationId: 'pending-edit' };
  pending.thoughts[0].content = '正在编辑的新原文';
  applyThoughtWindowSync(pending, incoming, { query: { sort: 'created' } }, limits, () => false, changes);
  assert.equal(pending.thoughts.find(item => item.id === 'sync-0').content, '正在编辑的新原文', '旧同步不得先覆盖pending再重放');
  const locallyChangedHead = createSnapshot();
  locallyChangedHead.thoughtPage.window.pages = [];
  locallyChangedHead.thoughtPage.requestCursor = '';
  locallyChangedHead.thoughtPage.prevCursor = '';
  applyThoughtWindowSync(locallyChangedHead, incoming, { query: { sort: 'created' } }, limits, () => true, changes);
  assert.equal(locallyChangedHead.thoughts[0].id, addition.id, '本地变更后仍依据真实页头凭据接入新根');
  const outsideUpdate = createSnapshot(true);
  const movedOutside = { ...addition, id: 'outside-updated', occurredAt: '2027-01-01T00:00:00.000Z' };
  applyThoughtWindowSync(outsideUpdate, [...incoming, movedOutside], { query: { cursor: 'opaque-deep' } }, limits, () => false, [{ domain: 'thoughts', resourceId: movedOutside.id, changeType: 'update' }]);
  assert.equal(outsideUpdate.thoughtPage.stale, true, '窗口外根update可能移入范围，必须停止旧游标');
  assert.equal(outsideUpdate.thoughts.some(item => item.id === movedOutside.id), false, '不能猜排序插入深页');
  const deep = createSnapshot(true);
  applyThoughtWindowSync(deep, incoming, { query: { sort: 'created', cursor: 'opaque-deep' } }, limits, () => true, changes);
  assert.equal(deep.thoughts.some(item => item.id === addition.id), false, '深窗口不擅自插入新根');
  assert.equal(deep.thoughtPage.stale, true);
  const updated = incoming.filter(item => item.id !== 'sync-2').map(item => item.id === 'sync-1' ? { ...item, version: 2, content: '权威更新', annotations: [{ text: '不驻留' }] } : item);
  applyThoughtWindowSync(deep, updated, { query: { sort: 'created', cursor: 'opaque-deep' } }, limits, () => false, [{ domain: 'thoughts', resourceId: 'sync-1', changeType: 'update' }]);
  assert.equal(deep.thoughts.find(item => item.id === 'sync-1').content, '权威更新');
  assert.equal(deep.thoughts.some(item => item.id === 'sync-2'), false, '只在完整权威域明确缺失时移除已加载对象');
}

// 在途增量不能把已读较新详情/未确认编辑回退，完整域权威删除仍有效。
{
  const { applyThoughtDetailSync } = await import('../public/frontend/features/thoughts/index.mjs');
  const current = [{ id: 'r', type: 'question', version: 3, content: '新正文' }, { id: 'b', relatedTo: 'r', type: 'idea', version: 2, content: '新想法' }];
  const old = [{ id: 'r', type: 'question', version: 2, content: '旧正文' }];
  assert.deepEqual(applyThoughtDetailSync(current, old, 'r'), current);
  assert.deepEqual(applyThoughtDetailSync(current, [], 'r'), []);
  const summary = [{ id: 'r', type: 'question', version: 3, blockCount: 0, content: '摘要' }];
  assert.equal(applyThoughtDetailSync(summary, current, 'r')[0].content, '新正文');
}
