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
import {
  applicationRouteUrl,
  canonicalPagePaths,
  createPageRouter,
  createUnavailableRouteResult,
  detailRoute,
  isApplicationRoutePath,
  ownerViewCapabilities,
  resolveApplicationRoute,
  viewSections
} from "../public/frontend/pages/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appEntry = await fs.readFile(path.join(ROOT, "public/app.js"), "utf8");
const appBootstrap = await fs.readFile(path.join(ROOT, "public/frontend/app/bootstrap.mjs"), "utf8");
const appRuntime = await fs.readFile(path.join(ROOT, "public/frontend/app/runtime.mjs"), "utf8");
const applicationStyles = await fs.readFile(path.join(ROOT, "public/frontend/styles/application.css"), "utf8");
const r8Styles = await fs.readFile(path.join(ROOT, "public/frontend/styles/r8.css"), "utf8");
const html = await fs.readFile(path.join(ROOT, "public/index.html"), "utf8");
async function publicSourceFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await publicSourceFiles(file));
    else if (/\.(?:html|m?js)$/.test(entry.name)) output.push(file);
  }
  return output;
}
const downloadableSource = (await Promise.all((await publicSourceFiles(path.join(ROOT, "public"))).map(file => fs.readFile(file, "utf8")))).join("\n");

assert.match(appEntry, /^import \{ startApplication \} from "\.\/frontend\/app\/index\.mjs";\s+startApplication\(\);\s*$/);
assert.ok(appEntry.split("\n").length <= 5, "public/app.js must remain a thin bootstrap");
assert.match(appBootstrap, /requestJson\("\/api\/v1\/startup"\)/);
assert.match(appBootstrap, /requestJson\(routeStateUrl\(route\)\)/);
assert.match(appBootstrap, /const runtime = await import\("\.\/runtime\.mjs"\)/);
assert.match(appBootstrap, /await loadR8Styles\(\)/);
assert.match(appBootstrap, /timeout = setTimeout\(finish, 1500\)/);
assert.match(appBootstrap, /link\.addEventListener\("error", finish, \{ once: true \}\)/);
assert.doesNotMatch(appBootstrap, /from "\.\/runtime\.mjs"/);
assert.match(appBootstrap, /requestJson\("\/api\/auth\/me", \{ allowUnauthorized: true \}\)/);
for (const endpoint of ["/api/auth/me", "/api/v1/startup"]) {
  assert.equal(appBootstrap.split(`"${endpoint}"`).length - 1, 1, `bootstrap must request ${endpoint} once`);
}
assert.doesNotMatch(appBootstrap, /requestJson\("\/api\/state"\)|requestJson\("\/api\/meta"\)/);
assert.match(appRuntime, /export async function startApplication\(initial = null\)/);
assert.doesNotMatch(appRuntime, /^bootstrap\(\)\.catch/m);
assert.doesNotMatch(appRuntime, /from "\.\/frontend\//);
assert.doesNotMatch(appRuntime, /function render\(\)/);
assert.match(appRuntime, /button\.tabIndex=active\?0:-1/);
assert.match(appRuntime, /\["ArrowLeft","ArrowRight","Home","End"\]/);
assert.match(appRuntime, /operation=\+\+authOperationSerial;setAuthBusy\(true\)/);
assert.match(appRuntime, /requestSerial!==actionsRequestSerial\|\|owner!==currentUser\?\.id\|\|session!==sessionSerial/);
assert.match(appRuntime, /LOCAL_TEST_RESPONSE_MISMATCH/);
assert.match(appRuntime, /ownerSurfaceVault\.append\(entry\.node\)/);
assert.match(appRuntime, /AUTH_REAUTH_REQUIRED/);
assert.match(appRuntime, /function onboardingBlocksPrivateShell\(/);
assert.match(appRuntime, /await afterVisibleShellPaint\(\)/);
assert.match(appRuntime, /load\(\{visibleShell:true,initialSnapshot\}\)/);
assert.match(appRuntime, /initialSnapshot\s*\?\s*\[initialSnapshot\.state,initialSnapshot\.meta\]/);
assert.match(appRuntime, /document\.documentElement\.dataset\.runtimeReady\s*=\s*"1"/);
assert.doesNotMatch(appRuntime, /syncChainRecordKind\(\);await loadActionsWorkspace\(\)/);
assert.match(appRuntime, /提交时的行动已保存；等待期间的新输入已保留。/);
assert.match(appRuntime, /已保存，但行动列表刷新失败/);
assert.match(appRuntime, /function contentState\(/);
assert.match(appRuntime, /data-content-action/);
assert.doesNotMatch(appRuntime, /reasoningDisclosure|saved-reasoning|ai-answer-reasoning/);
assert.match(appRuntime, /createLatexRenderer\(\{createAsset:createLatexAsset,getKatex:\(\)=>window\.katex,resolveAssetUrl:appUrl\}\)/);
assert.match(applicationStyles, /:root\{/);
assert.match(applicationStyles, /(?:^|\n)\[hidden\]\{display:none!important\}/);
assert.match(applicationStyles, /env\(safe-area-inset-bottom\)/);
assert.match(r8Styles, /\.home-v02\{/);
assert.match(r8Styles, /assets\/r8\/app-background-desktop\.[a-f0-9]{12}\.avif/);
assert.match(r8Styles, /\.app-atmosphere\{/);
assert.match(applicationStyles, /\.auth-tabs button\{min-height:44px/);
assert.match(applicationStyles, /\.auth-form input\{[^}]*min-height:44px[^}]*font-size:1rem/);
assert.match(applicationStyles, /\.auth-form \.primary-button\{min-height:44px/);
assert.match(applicationStyles, /\.content-state\.failure/);
assert.doesNotMatch(applicationStyles, /\.saved-reasoning|\.answer-reasoning/);
assert.match(html, /id="home-open-thought"/);
assert.match(html, /id="home-mood-sparkline"/);
assert.match(html, /<base href="\/">/);
assert.doesNotMatch(html, /const routeRoots = new Set/);
assert.match(html, /<link rel="stylesheet" href="frontend\/styles\/application\.css">/);
assert.match(html, /<link rel="preload" href="frontend\/styles\/r8\.css" as="style">/);
assert.match(html, /<link rel="modulepreload" href="frontend\/app\/index\.mjs">/);
assert.match(html, /<link rel="modulepreload" href="frontend\/app\/bootstrap\.mjs">/);
assert.doesNotMatch(html, /<link rel="modulepreload" href="frontend\/app\/runtime\.mjs">/);
assert.match(html, /id="auth-tab-login"[^>]+aria-controls="login-form"[^>]+tabindex="0"/);
assert.match(html, /id="auth-tab-register"[^>]+aria-controls="register-form"[^>]+tabindex="-1"/);
assert.match(html, /id="login-form" role="tabpanel" aria-labelledby="auth-tab-login"/);
assert.equal((html.match(/<script src="app\.js" type="module"><\/script>/g) || []).length, 1);
assert.ok(html.indexOf('<base href="/">') < html.indexOf('rel="stylesheet" href="frontend/styles/application.css"'));
assert.ok(html.indexOf('rel="modulepreload" href="frontend/app/bootstrap.mjs"') < html.indexOf('<script src="app.js" type="module"></script>'));
assert.ok(html.indexOf('<script src="app.js" type="module"></script>') < html.indexOf("</head>"));
assert.doesNotMatch(html, /(?:href|src)="(?:styles\.css|vendor\/katex\/katex\.min\.(?:css|js))"/);
assert.match(html, /id="discovery-query"/);
assert.match(html, /id="view-permission"/);
assert.match(html, /data-owner-surface-root="architecture"/);
assert.match(html, /data-owner-surface-root="commercialization"/);
assert.doesNotMatch(html, /id="architecture-stage-tabs"|id="commercial-assumptions-form"/);
assert.equal((html.match(/data-ai-effort=/g) || []).length, 16);
assert.ok((html.match(/data-owner-capability=/g) || []).length >= 10);
assert.doesNotMatch(html, /id="ai-answer-reasoning|DeepSeek 回答|模型思考/);
for (const phrase of ["图片原文", "语音原件", "原音频与转写分层保存", "需要时展开麦克风控制", "碎片收集箱", "日记助手", "DeepSeek 长期对话", "每周自动尝试，服务需运行"]) {
  assert.doesNotMatch(html, new RegExp(phrase), `implementation or placeholder copy must not remain visible: ${phrase}`);
}
for (const phrase of ["ASR 服务尚未配置", "内容时间线", "最新在前"]) {
  assert.doesNotMatch(appRuntime, new RegExp(phrase), `runtime copy must use the content design vocabulary: ${phrase}`);
}
for (const phrase of ["2 vCPU / 1.57 GiB", "MAU 18.4 万", "约 ¥290k–730k/月", "先付费招募体验者", "自带密钥 BYOK"]) {
  assert.doesNotMatch(downloadableSource, new RegExp(phrase), `owner-only content leaked into a public HTML/JS asset: ${phrase}`);
}
assert.match(appRuntime, /request\("\/api\/owner\/surfaces\/architecture"\)/);
assert.doesNotMatch(appRuntime, /const architectureStages=|commercialPaymentFactPattern|commercialStageScales/);

const homePool = createHomeMemoryPool({
  thoughts: [
    { id: "question-1", type: "question", content: "真实问题", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:00:00.000Z" },
    { id: "idea-1", type: "idea", relatedTo: "question-1", content: "用户自己的想法", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:01:00.000Z" },
    { id: "discarded-idea", type: "idea", relatedTo: "question-1", content: "已舍弃的后续想法", disposition: "discarded", occurredOn: "2026-09-27", occurredAt: "2026-09-27T08:03:00.000Z" },
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
assert.deepEqual(Object.keys(canonicalPagePaths).sort(), htmlViews);
assert.equal(new Set(Object.values(canonicalPagePaths)).size, htmlViews.length);
assert.deepEqual(
  resolveApplicationRoute(new URL("https://example.test/now/thoughts/root%3A1?tag=%E5%A4%8D%E7%9B%98&sort=created&page=2"), { basePath: "/now" }),
  {
    kind: "detail",
    view: "thoughts",
    resourceType: "thought-chain",
    resourceId: "root:1",
    query: { tag: "复盘", sort: "created", page: 2 },
    matched: true,
    legacy: false,
    canonicalUrl: "/now/thoughts/root%3A1?tag=%E5%A4%8D%E7%9B%98&sort=created&page=2"
  }
);
assert.equal(resolveApplicationRoute(new URL("https://example.test/now/?view=books"), { basePath: "/now" }).canonicalUrl, "/now/seen/books");
assert.equal(resolveApplicationRoute(new URL("https://example.test/now/view/settings"), { basePath: "/now" }).canonicalUrl, "/now/mine/settings");
assert.equal(applicationRouteUrl(detailRoute("thought-chain", "root:1", { tag: "复盘" }), "/now"), "/now/thoughts/root%3A1?tag=%E5%A4%8D%E7%9B%98");
assert.equal(isApplicationRoutePath("/thoughts/root-1"), true);
assert.equal(isApplicationRoutePath("/not-an-app-route"), false);
assert.deepEqual(createUnavailableRouteResult({ resourceType: "thought-chain", resourceId: "deleted" }), {
  data: null,
  error: {
    code: "RESOURCE_UNAVAILABLE",
    message: "这条思绪已不可用",
    details: { resourceType: "thought-chain", resourceId: "deleted" }
  },
  meta: { fallback: { view: "thoughts", path: "/thoughts" } }
});

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
const views = [
  element({ id: "view-today" }),
  element({ id: "view-quotes" }),
  element({ id: "view-settings" }),
  element({ id: "view-architecture" }),
  element({ id: "view-permission" })
];
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
const denied = [];
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
  canAccessView: (view, capability) => view !== "architecture" && Boolean(capability),
  onDenied: (view, capability) => denied.push([view, capability]),
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
router.switchView("architecture");
assert.equal(views[4].classList.contains("active"), true);
assert.deepEqual(denied, [["architecture", ownerViewCapabilities.architecture]]);

const routeListeners = new Map();
const routeLocation = { pathname: "/now/", search: "?view=thoughts&tag=%E5%A4%8D%E7%9B%98", hash: "" };
const routeEntries = [{ url: "/now/?view=thoughts&tag=%E5%A4%8D%E7%9B%98", state: null }];
let routeIndex = 0;
const updateRouteLocation = value => {
  const url = new URL(value, "https://route.test");
  routeLocation.pathname = url.pathname;
  routeLocation.search = url.search;
  routeLocation.hash = url.hash;
};
const routeHistory = {
  state: null,
  scrollRestoration: "auto",
  get length() { return routeEntries.length; },
  replaceState(state, _title, url) {
    this.state = state;
    routeEntries[routeIndex] = { state, url };
    updateRouteLocation(url);
  },
  pushState(state, _title, url) {
    routeEntries.splice(routeIndex + 1);
    routeEntries.push({ state, url });
    routeIndex += 1;
    this.state = state;
    updateRouteLocation(url);
  },
  move(offset) {
    routeIndex += offset;
    const entry = routeEntries[routeIndex];
    this.state = entry.state;
    updateRouteLocation(entry.url);
    routeListeners.get("popstate")?.({ state: entry.state });
  }
};
let browserScroll = { x: 0, y: 0 };
const browserRouteEvents = [];
const browserRouter = createPageRouter({
  query: selector => selector === "#section-nav" ? sectionNav : null,
  queryAll: selector => ({
    ".view": views,
    ".nav-button": nav,
    "[data-section-links]": groups,
    ".section-nav button": tabs
  })[selector] || [],
  location: routeLocation,
  history: routeHistory,
  eventTarget: { addEventListener: (name, listener) => routeListeners.set(name, listener) },
  basePath: "/now",
  requestFrame: callback => { callback(); return 1; },
  readScroll: () => browserScroll,
  scrollTo: options => {
    browserScroll = { x: Number(options.left) || 0, y: Number(options.top) || 0 };
  },
  onRoute: (route, context) => browserRouteEvents.push({ route, source: context.source })
});
assert.equal(`${routeLocation.pathname}${routeLocation.search}`, "/now/thoughts?tag=%E5%A4%8D%E7%9B%98");
assert.equal(routeHistory.length, 1, "legacy canonicalization must replace the current entry");
browserScroll = { x: 0, y: 420 };
browserRouter.replaceQuery({ sort: "created", page: 2 });
assert.equal(routeHistory.length, 1, "same-page query changes must use replaceState");
assert.equal(`${routeLocation.pathname}${routeLocation.search}`, "/now/thoughts?tag=%E5%A4%8D%E7%9B%98&sort=created&page=2");
browserRouter.openDetail("thought-chain", "root:1");
assert.equal(routeHistory.length, 2, "opening a detail must push a history entry");
assert.equal(`${routeLocation.pathname}${routeLocation.search}`, "/now/thoughts/root%3A1?tag=%E5%A4%8D%E7%9B%98&sort=created&page=2");
routeHistory.move(-1);
assert.equal(browserRouter.currentRoute().kind, "page");
assert.deepEqual(browserScroll, { x: 0, y: 420 });
routeHistory.move(1);
assert.equal(browserRouter.currentRoute().resourceId, "root:1");
const unavailable = createUnavailableRouteResult({ resourceType: "thought-chain", resourceId: "root:1" });
browserRouter.showUnavailable(unavailable);
assert.equal(routeHistory.length, 2, "unavailable details must replace the stale detail entry");
assert.equal(routeLocation.pathname, "/now/thoughts");
assert.equal(browserRouter.currentRoute().result.error.code, "RESOURCE_UNAVAILABLE");
assert.equal(routeHistory.scrollRestoration, "manual");
assert.ok(browserRouteEvents.some(event => event.source === "pop"));
browserRouter.restoreCurrentScroll({ x: 0, y: 300 });
assert.deepEqual(browserScroll, { x: 0, y: 300 });
browserScroll = { x: 0, y: 125 };
routeListeners.get("pointerdown")?.({ type: "pointerdown" });
await new Promise(resolve => setTimeout(resolve, 120));
assert.deepEqual(browserScroll, { x: 0, y: 125 }, "user input must cancel a delayed scroll restore");

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
  loadArchitecture: async () => calls.push("architecture"),
  loadCommercialization: async () => calls.push("commercialization"),
  loadNotifications: async () => calls.push("notifications"),
  scheduleNotificationPoll: () => calls.push("notification-poll"),
  loadTrash: async () => calls.push("trash")
});
effects.captures();
effects.quotes();
effects.leaveQuotes();
effects.architecture();
effects.notifications();
await new Promise(resolve => setTimeout(resolve, 0));
for (const expected of ["frame", "captures", "quote-overflow", "quote-scroll", "quote-stop", "architecture", "notifications", "notification-poll"]) {
  assert.ok(calls.includes(expected), `missing page effect: ${expected}`);
}

console.log(`Frontend shell contracts passed: ${htmlViews.length} registered views, thin JS/CSS entries, page routing and feature lifecycle effects.`);
