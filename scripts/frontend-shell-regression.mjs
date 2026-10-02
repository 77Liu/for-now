import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHomeMoodSeries,
  createHomeMemoryPool,
  createPageEffects,
  selectHomeMemories
} from "../public/frontend/features/index.mjs";
import { createPageRouter, viewSections } from "../public/frontend/pages/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appEntry = await fs.readFile(path.join(ROOT, "public/app.js"), "utf8");
const appRuntime = await fs.readFile(path.join(ROOT, "public/frontend/app/runtime.mjs"), "utf8");
const rootStyles = await fs.readFile(path.join(ROOT, "public/styles.css"), "utf8");
const applicationStyles = await fs.readFile(path.join(ROOT, "public/frontend/styles/application.css"), "utf8");
const html = await fs.readFile(path.join(ROOT, "public/index.html"), "utf8");

assert.match(appEntry, /^import \{ startApplication \} from "\.\/frontend\/app\/index\.mjs";\s+startApplication\(\);\s*$/);
assert.ok(appEntry.split("\n").length <= 5, "public/app.js must remain a thin bootstrap");
assert.match(appRuntime, /export function startApplication\(\)/);
assert.doesNotMatch(appRuntime, /^bootstrap\(\)\.catch/m);
assert.doesNotMatch(appRuntime, /from "\.\/frontend\//);
assert.match(appRuntime, /operation=\+\+authOperationSerial;setAuthBusy\(true\)/);
assert.match(appRuntime, /requestSerial!==actionsRequestSerial\|\|owner!==currentUser\?\.id\|\|session!==sessionSerial/);
assert.match(appRuntime, /LOCAL_TEST_RESPONSE_MISMATCH/);
assert.match(appRuntime, /提交时的行动已保存；等待期间的新输入已保留。/);
assert.match(appRuntime, /已保存，但行动列表刷新失败/);
assert.match(appRuntime, /function contentState\(/);
assert.match(appRuntime, /data-content-action/);
assert.doesNotMatch(appRuntime, /reasoningDisclosure|saved-reasoning|ai-answer-reasoning/);
assert.equal(rootStyles.trim(), '@import url("./frontend/styles/application.css");');
assert.match(applicationStyles, /:root\{/);
assert.match(applicationStyles, /(?:^|\n)\[hidden\]\{display:none!important\}/);
assert.match(applicationStyles, /env\(safe-area-inset-bottom\)/);
assert.match(applicationStyles, /\.home-v02\{/);
assert.match(applicationStyles, /assets\/home-v0\.2\/desktop-background\.png/);
assert.match(applicationStyles, /\.content-state\.failure/);
assert.doesNotMatch(applicationStyles, /\.saved-reasoning|\.answer-reasoning/);
assert.match(html, /id="home-open-thought"/);
assert.match(html, /id="home-mood-sparkline"/);
assert.match(html, /id="discovery-query"/);
assert.doesNotMatch(html, /id="ai-answer-reasoning|DeepSeek 回答|模型思考/);
for (const phrase of ["图片原文", "语音原件", "原音频与转写分层保存", "需要时展开麦克风控制", "碎片收集箱", "日记助手", "DeepSeek 长期对话", "每周自动尝试，服务需运行"]) {
  assert.doesNotMatch(html, new RegExp(phrase), `implementation or placeholder copy must not remain visible: ${phrase}`);
}
for (const phrase of ["ASR 服务尚未配置", "内容时间线", "最新在前"]) {
  assert.doesNotMatch(appRuntime, new RegExp(phrase), `runtime copy must use the content design vocabulary: ${phrase}`);
}

const homePool = createHomeMemoryPool({
  thoughts: [
    { id: "question-1", type: "question", content: "真实问题", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:00:00.000Z" },
    { id: "idea-1", type: "idea", relatedTo: "question-1", content: "用户自己的想法", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:01:00.000Z" },
    { id: "answer-1", type: "answer", relatedTo: "question-1", content: "模型回答", authorType: "ai", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:02:00.000Z" },
    { id: "discarded", type: "question", content: "已舍弃问题", disposition: "discarded", occurredOn: "2026-09-26" }
  ],
  books: [{ id: "book-1", title: "书名", notes: [{ id: "note-1", content: "读者笔记", occurredOn: "2026-09-26" }] }],
  quotes: [
    { id: "quote-ai", source: "AI总结", content: "不应混入", occurredOn: "2026-09-26" },
    { id: "quote-1", source: "作者", content: "收藏原句", occurredOn: "2026-09-25" }
  ]
});
assert.deepEqual(homePool.map(item => item.type).sort(), ["book", "quote", "thought"]);
assert.equal(homePool.find(item => item.type === "thought").text, "用户自己的想法");
assert.equal(homePool.some(item => item.id === "quote-ai" || item.id === "discarded"), false);
assert.equal(selectHomeMemories(homePool, { random: () => 0 }).length, 3);
assert.deepEqual(
  buildHomeMoodSeries([
    { occurredOn: "2026-09-27", mood: 2 },
    { occurredOn: "2026-09-27", mood: 4 },
    { occurredOn: "2026-09-25", mood: 5 }
  ], "2026-09-27", 3),
  [
    { date: "2026-09-25", count: 1, value: 5 },
    { date: "2026-09-26", count: 0, value: null },
    { date: "2026-09-27", count: 2, value: 3 }
  ]
);

const htmlViews = [...html.matchAll(/<section class="[^"]*\bview\b[^"]*" id="view-([^"]+)"/g)].map(match => match[1]).sort();
assert.deepEqual(Object.keys(viewSections).sort(), htmlViews);

const element = ({ id = "", dataset = {} } = {}) => {
  const classes = new Set();
  return {
    id,
    dataset,
    hidden: false,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains: name => classes.has(name)
    },
    setAttribute(name, value) {
      this[name] = value;
    }
  };
};
const views = [element({ id: "view-today" }), element({ id: "view-quotes" }), element({ id: "view-settings" })];
const nav = [
  element({ dataset: { section: "today" } }),
  element({ dataset: { section: "seen" } }),
  element({ dataset: { section: "mine" } })
];
const groups = [
  element({ dataset: { sectionLinks: "today" } }),
  element({ dataset: { sectionLinks: "seen" } }),
  element({ dataset: { sectionLinks: "mine" } })
];
const tabs = [
  element({ dataset: { view: "today" } }),
  element({ dataset: { view: "quotes" } })
];
const sectionNav = element();
const calls = [];
const router = createPageRouter({
  query: selector => selector === "#section-nav" ? sectionNav : null,
  queryAll: selector => ({
    ".view": views,
    ".nav-button": nav,
    "[data-section-links]": groups,
    ".section-nav button": tabs
  })[selector] || [],
  effects: {
    quotes: () => calls.push("quotes"),
    leaveQuotes: () => calls.push("leave-quotes"),
    settings: () => calls.push("settings")
  },
  scrollTo: options => calls.push(["scroll", options])
});
router.switchView("quotes");
assert.equal(views[1].classList.contains("active"), true);
assert.equal(nav[1].classList.contains("active"), true);
assert.equal(groups[1].hidden, false);
assert.equal(sectionNav.hidden, false);
assert.equal(tabs[1]["aria-current"], "page");
router.switchView("settings");
assert.equal(views[2].classList.contains("active"), true);
assert.equal(nav[2].classList.contains("active"), true);
assert.equal(sectionNav.hidden, true);
router.restoreView("missing-old-route");
assert.equal(views[0].classList.contains("active"), true);
assert.equal(nav[0].classList.contains("active"), true);
assert.equal(groups[0].hidden, false);
assert.equal(sectionNav.hidden, false);
assert.equal(tabs[0]["aria-current"], "page");
assert.equal(calls.length, 5, "restoring a view must not rerun effects or scroll");
assert.deepEqual(calls.slice(0, 3), ["quotes", ["scroll", { top: 0, behavior: "smooth" }], "leave-quotes"]);

const effects = createPageEffects({
  requestFrame: callback => {
    calls.push("frame");
    callback();
  },
  syncCaptureOverflow: () => calls.push("captures"),
  syncQuoteOverflow: () => calls.push("quote-overflow"),
  setupQuoteBubbleScroll: () => calls.push("quote-scroll"),
  stopQuoteBubbleScroll: () => calls.push("quote-stop"),
  loadStatistics: async () => calls.push("statistics"),
  loadAiCostPlan: async () => calls.push("ai-cost"),
  loadCommercialization: async () => calls.push("commercialization"),
  loadNotifications: async () => calls.push("notifications"),
  scheduleNotificationPoll: () => calls.push("notification-poll"),
  loadTrash: async () => calls.push("trash")
});
effects.captures();
effects.quotes();
effects.leaveQuotes();
effects.notifications();
await new Promise(resolve => setTimeout(resolve, 0));
for (const expected of ["frame", "captures", "quote-overflow", "quote-scroll", "quote-stop", "notifications", "notification-poll"]) {
  assert.ok(calls.includes(expected), `missing page effect: ${expected}`);
}

console.log(`Frontend shell contracts passed: ${htmlViews.length} registered views, thin JS/CSS entries, page routing and feature lifecycle effects.`);
