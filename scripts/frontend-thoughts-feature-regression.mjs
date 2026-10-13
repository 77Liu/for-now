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
await thoughtController.mount({
  root: thoughtRoot,
  route: { view: "thoughts", query: {} },
  signal: new AbortController().signal
});
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
