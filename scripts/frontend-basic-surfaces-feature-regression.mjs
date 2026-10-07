import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createAboutFeatureController,
  createMineFeatureController,
  createPermissionFeatureController,
  notificationUnread,
  syncHealthPresentation
} from "../public/frontend/features/mine-shell/index.mjs";
import {
  EVIDENCE_PERMISSIONS_ENDPOINT,
  PERSONAL_CONTEXT_ENDPOINT,
  PERSONAL_CONTEXT_SELECTORS,
  createPersonalContextFeatureController,
  currentContextSource
} from "../public/frontend/features/personal-context/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

class FakeNode {
  constructor(root, dataset = {}) {
    this.root = root;
    this.id = dataset.id || "";
    this.dataset = { ...dataset };
    this.hidden = false;
    this.href = "";
    this.open = false;
    this.scrolls = [];
    this.children = new Map();
    this._innerHTML = "";
    this._textContent = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.root?.recordWrite();
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.root?.recordWrite();
  }

  removeAttribute(name) {
    if (name === "href") this.href = "";
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  closest(selector) {
    if (selector.startsWith("#") && this.id === selector.slice(1)) return this;
    if (
      selector === PERSONAL_CONTEXT_SELECTORS.retry
      && this.dataset.contentAction === "retry-personal-context"
    ) {
      return this;
    }
    if (
      selector === PERSONAL_CONTEXT_SELECTORS.source
      && Object.hasOwn(this.dataset, "contextSource")
    ) {
      return this;
    }
    if (
      selector === PERSONAL_CONTEXT_SELECTORS.claimAction
      && Object.hasOwn(this.dataset, "claimAction")
    ) {
      return this;
    }
    if (
      selector === PERSONAL_CONTEXT_SELECTORS.permissionToggle
      && Object.hasOwn(this.dataset, "permissionField")
    ) {
      return this;
    }
    if (selector === "[data-chain-id]") return this.chain || null;
    return null;
  }

  querySelector(selector) {
    return this.children.get(selector) || null;
  }

  querySelectorAll() {
    return [];
  }

  scrollIntoView(options) {
    this.scrolls.push(options);
  }
}

class FakeRoot {
  constructor(selectors = []) {
    this.nodes = new Map(selectors.map(selector => {
      const node = new FakeNode(this);
      if (selector.startsWith("#")) node.id = selector.slice(1);
      return [selector, node];
    }));
    this.listeners = new Map();
    this.writes = 0;
    this.queries = 0;
    this.isConnected = false;
  }

  recordWrite() {
    this.writes += 1;
  }

  querySelector(selector) {
    this.queries += 1;
    return this.nodes.get(selector) || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  contains(element) {
    return element?.root === this;
  }

  listenerCount(type = "click") {
    return this.listeners.get(type)?.size || 0;
  }

  click(dataset) {
    const target = new FakeNode(this, dataset);
    let prevented = false;
    const event = {
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get("click") || [])]) listener(event);
    return prevented;
  }

  node(selector) {
    return this.nodes.get(selector);
  }
}

const mineSelectors = [
  "#mine-account-name",
  "#mine-notification-count",
  "#mine-governance-link",
  ".sync-health-row",
  "#mine-sync-status",
  "#mine-sync-count",
  "#mine-app-version"
];
const permissionSelectors = ["#permission-title", "#permission-copy"];
const personalContextSelectors = [
  PERSONAL_CONTEXT_SELECTORS.status,
  PERSONAL_CONTEXT_SELECTORS.meta,
  PERSONAL_CONTEXT_SELECTORS.disclosure,
  PERSONAL_CONTEXT_SELECTORS.summary,
  PERSONAL_CONTEXT_SELECTORS.claims,
  PERSONAL_CONTEXT_SELECTORS.permissions,
  PERSONAL_CONTEXT_SELECTORS.permissionsMore,
  PERSONAL_CONTEXT_SELECTORS.syntheses,
  PERSONAL_CONTEXT_SELECTORS.synthesisStatus,
  PERSONAL_CONTEXT_SELECTORS.runSynthesis,
  PERSONAL_CONTEXT_SELECTORS.sourceCount,
  PERSONAL_CONTEXT_SELECTORS.sourceList
];

const escapeMarkup = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
}[character]));

const contentState = ({
  kind = "empty",
  title,
  body,
  action = null
}) => {
  const attribute = action?.view
    ? `data-view="${escapeMarkup(action.view)}"`
    : action?.command
      ? `data-content-action="${escapeMarkup(action.command)}"`
      : "";
  const button = action?.label && attribute
    ? `<button ${attribute}>${escapeMarkup(action.label)}</button>`
    : "";
  return `<section class="${kind}"><strong>${escapeMarkup(title)}</strong><p>${
    escapeMarkup(body)
  }</p>${button}</section>`;
};

function sampleContext(label = "A") {
  return {
    version: `context-${label}`,
    generatedAt: "2026-10-06T08:00:00.000Z",
    disclosure: `仅使用已允许的来源 ${label}`,
    timeWindow: { from: "2026-10-01", to: "2026-10-06" },
    sourceCount: 3,
    tokenBudget: { estimatedUsed: 18, limit: 80 },
    sources: [
      {
        id: "source-thought",
        resourceType: "thought",
        resourceId: "thought-root",
        recordType: "思绪",
        occurredOn: "2026-10-06",
        version: 2,
        location: {
          view: "thoughts",
          targetId: "thought-block",
          rootId: "thought-root",
          targetKey: "idea:block-1"
        }
      },
      {
        id: "source-deleted",
        resourceType: "capture",
        resourceId: "missing",
        recordType: "捕念",
        occurredOn: "2026-10-05",
        version: 1,
        location: { view: "captures", targetId: "missing" }
      },
      {
        id: "source-snapshot",
        resourceType: "capture",
        resourceId: "not-loaded",
        recordType: "捕念",
        occurredOn: "2026-10-04",
        version: 1,
        excerpt: `<保留摘录 ${label}>`,
        location: { view: "captures", targetId: "not-loaded" }
      }
    ],
    conclusions: [
      {
        informationType: "user_fact",
        informationTypeLabel: "用户事实",
        title: `结论 ${label}`,
        text: `第一行 ${label}\n第二行`,
        sampleNote: "可由来源核对",
        sourceIds: ["source-thought", "source-deleted"]
      }
    ],
    userModel: {
      readiness: "usable",
      activeClaimCount: 1,
      disputedClaimCount: 1,
      candidateCount: 1,
      staleCandidateCount: 0,
      unknowns: [],
      claims: [
        {
          id: "claim-active",
          domain: "goals",
          statement: "持续完成关键任务",
          scope: "本月",
          epistemic: "known",
          lifecycle: "active",
          contextAllowed: true,
          version: 2
        },
        {
          id: "claim-candidate",
          domain: "behavior",
          statement: "午后更适合专注工作",
          scope: "",
          epistemic: "hypothesis",
          lifecycle: "candidate",
          contextAllowed: true,
          version: 1
        },
        {
          id: "claim-disputed",
          domain: "context",
          statement: "已变化的理解",
          scope: "",
          epistemic: "hypothesis",
          lifecycle: "disputed",
          contextAllowed: false,
          version: 3
        }
      ]
    },
    sourcePermissions: [{
      sourceKey: JSON.stringify(["capture", "capture-a", "", ""]),
      sourceRef: {
        resourceType: "capture",
        resourceId: "capture-a",
        rootId: "",
        targetKey: "",
        version: 2
      },
      recordType: "念起",
      excerpt: "当前可管理的来源",
      status: "active",
      contextAllowed: true,
      learningAllowed: false,
      learningStatus: "off",
      revision: 1
    }],
    periodicSyntheses: [
      {
        id: "synthesis-1",
        content: "本周完成了一项行动，但效果仍待继续观察。",
        reason: "manual",
        reviewStatus: "candidate",
        reviewedAt: "",
        reviewDisposition: "",
        createdAt: "2026-10-06T08:00:00.000Z",
        version: 1
      },
      {
        id: "synthesis-stale",
        content: "来源变化后不可继续使用。",
        reason: "manual",
        reviewStatus: "stale",
        reviewedAt: "2026-10-06T09:00:00.000Z",
        reviewDisposition: "",
        createdAt: "2026-10-06T08:30:00.000Z",
        version: 2
      }
    ]
  };
}

function personalPorts({
  requestV1,
  getSnapshot,
  getAccountId = () => "account-a",
  getSessionSerial = () => 1,
  navigationLog = [],
  frames = [],
  destinations = new Map()
} = {}) {
  return {
    data: {
      getSnapshot: getSnapshot || (() => ({
        thoughts: [{
          id: "thought-root",
          version: 2,
          content: "当前思绪",
          occurredAt: "2026-10-06T08:00:00.000Z"
        }]
      })),
      getAccountId,
      getSessionSerial,
      requestV1: requestV1 || (async () => ({ data: sampleContext() }))
    },
    navigation: {
      activateDate(date, dailyType) {
        navigationLog.push(["date", date, dailyType]);
      },
      switchView(nextView) {
        navigationLog.push(["view", nextView]);
      },
      openThoughtDetail(id) {
        navigationLog.push(["thought", id]);
      }
    },
    view: {
      contentState,
      escapeMarkup,
      plainPreview: value => String(value ?? "").slice(0, 160),
      formatDate: () => "2026年10月6日"
    },
    platform: {
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      queryDestination(selector) {
        navigationLog.push(["query", selector]);
        return destinations.get(selector) || null;
      },
      escapeSelector: value => String(value).replaceAll('"', '\\"'),
      isDetailsElement: element => element?.details === true,
      confirm: () => true,
      createRequestId: () => "personal-context-request"
    }
  };
}

assert.equal(notificationUnread({
  notificationUnread: 0,
  notifications: [
    { status: "succeeded", readAt: "" },
    { status: "running", readAt: "" },
    { status: "failed", readAt: "read" }
  ]
}, 9), 1);
assert.equal(syncHealthPresentation({ status: "disabled" }).copy, "增量同步已关闭，继续使用写后刷新");
assert.equal(syncHealthPresentation({ status: "conflict", conflicts: 2 }).count, "2 冲突");
assert.match(syncHealthPresentation({
  status: "pending",
  pending: 3,
  oldestAgeMs: 31000
}).copy, /超过 30 秒/);
assert.equal(syncHealthPresentation({
  status: "synced",
  lastPullMs: 21,
  enqueueToAckP95Ms: 44
}).copy, "已与服务端对齐 · 拉取 21 ms · 写确认 P95 44 ms");

{
  let reads = 0;
  const shellVersions = [];
  const root = new FakeRoot(mineSelectors);
  const controller = createMineFeatureController({
    getUser() {
      reads += 1;
      return { username: "账户 A" };
    },
    getSnapshot: () => ({
      notifications: [{ status: "failed", readAt: "" }]
    }),
    getNotificationUnreadCount: () => 0,
    getSyncHealth: () => ({ status: "error", failed: 2 }),
    getGovernanceUrl: () => "/platform/private",
    getReleaseVersion: () => "0.5.8",
    setShellVersion: value => shellVersions.push(value)
  });
  assert.equal(root.queries, 0, "mine root must be injected at mount time");
  const abort = new AbortController();
  const dispose = controller.mount({ root, route: { view: "mine" }, signal: abort.signal });
  assert.equal(reads, 1);
  assert.equal(root.node("#mine-account-name").textContent, "账户 A");
  assert.equal(root.node("#mine-notification-count").textContent, "1 条未读");
  assert.equal(root.node("#mine-governance-link").hidden, false);
  assert.equal(root.node("#mine-governance-link").href, "/platform/private");
  assert.equal(root.node(".sync-health-row").dataset.syncStatus, "error");
  assert.equal(root.node("#mine-sync-count").textContent, "2 失败");
  assert.equal(root.node("#mine-app-version").textContent, "v0.5.8");
  assert.equal(shellVersions.at(-1), "v0.5.8");
  assert.equal(controller.render({ snapshot: { notificationUnread: 4 } }), true);
  assert.equal(root.node("#mine-notification-count").textContent, "4 条未读");
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);

  controller.mount({ root, signal: abort.signal });
  assert.equal(root.node("#mine-account-name").textContent, "账户 A");
  controller.resetSession();
  assert.equal(root.node("#mine-account-name").textContent, "本机使用");
  assert.equal(root.node("#mine-notification-count").textContent, "");
  assert.equal(root.node("#mine-governance-link").hidden, true);
  assert.equal(root.node("#mine-governance-link").href, "");
  assert.equal(root.node(".sync-health-row").dataset.syncStatus, "idle");
  assert.equal(root.node("#mine-sync-count").textContent, "");
  assert.equal(root.node("#mine-app-version").textContent, "");
  assert.equal(shellVersions.at(-1), "");
}

{
  let sensitiveLoads = 0;
  const root = new FakeRoot(permissionSelectors);
  const controller = createPermissionFeatureController({
    getDeniedAccess: () => ({
      view: "ai-cost",
      capability: "ai-costs"
    }),
    loadSensitiveModule() {
      sensitiveLoads += 1;
    }
  });
  const dispose = controller.mount({ root, route: { view: "permission" } });
  assert.equal(root.node("#permission-title").textContent, "AI 成本仅 Owner 可访问");
  assert.match(root.node("#permission-copy").textContent, /（ai-costs）/);
  assert.equal(sensitiveLoads, 0, "permission surface must not load a sensitive module");
  assert.equal(dispose(), true);
  controller.resetSession();
  assert.equal(root.node("#permission-title").textContent, "此页面仅 Owner 可访问");
  assert.doesNotMatch(root.node("#permission-copy").textContent, /ai-costs/);

  const directRoot = new FakeRoot(permissionSelectors);
  const direct = createPermissionFeatureController();
  direct.mount({ root: directRoot, route: { view: "permission" } });
  assert.equal(directRoot.node("#permission-title").textContent, "此页面仅 Owner 可访问");
  assert.doesNotMatch(directRoot.node("#permission-copy").textContent, /（）/);
  direct.unmount();

  const source = await readFile(
    new URL("../public/frontend/features/mine-shell/controller.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /\bimport\s*\(/, "permission controller must not lazy-load owner code");
}

{
  const root = { marker: "detached-about-root" };
  const controller = createAboutFeatureController();
  const dispose = controller.mount({ root, route: { view: "about" } });
  assert.equal(controller.render(), true);
  assert.equal(dispose(), true);
  assert.equal(controller.render(), false);
}

assert.deepEqual(
  currentContextSource({
    resourceType: "journal",
    resourceId: "journal-1"
  }, {
    journals: [{
      id: "journal-1",
      title: "标题",
      content: "正文",
      version: 3,
      occurredAt: "2026-10-05T08:00:00.000Z"
    }]
  }),
  {
    exists: true,
    version: 3,
    occurredAt: "2026-10-05T08:00:00.000Z",
    text: "标题：正文"
  }
);
assert.equal(
  currentContextSource({
    resourceType: "onboarding",
    location: { targetKey: "understanding" }
  }, {
    onboarding: {
      status: "completed",
      understanding: "长期理解",
      updatedAt: "2026-10-06T07:00:00.000Z"
    }
  }).text,
  "长期理解"
);

{
  const request = deferred();
  const calls = [];
  const navigationLog = [];
  const frames = [];
  const destinations = new Map();
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    requestV1(path, options) {
      calls.push([path, options]);
      return request.promise;
    },
    navigationLog,
    frames,
    destinations
  }));
  assert.equal(root.queries, 0, "personal-context root must be injected at mount time");
  const abort = new AbortController();
  const dispose = controller.mount({
    root,
    route: { view: "personal-context" },
    signal: abort.signal
  });
  assert.equal(root.listenerCount(), 1);
  assert.equal(calls[0][0], PERSONAL_CONTEXT_ENDPOINT);
  assert.equal(calls[0][1].signal, abort.signal);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.status).textContent, /正在核对/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML, /正在核对个人概要/);

  request.resolve({ data: sampleContext("success") });
  await waitFor(
    () => /结论 success/.test(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML),
    "personal context response did not render"
  );
  assert.equal(
    root.node(PERSONAL_CONTEXT_SELECTORS.meta).innerHTML.match(/<div>/g)?.length,
    4
  );
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.sourceCount).textContent, /3 条/);
  assert.match(
    root.node(PERSONAL_CONTEXT_SELECTORS.sourceList).innerHTML,
    /&lt;保留摘录 success&gt;/
  );
  assert.match(
    root.node(PERSONAL_CONTEXT_SELECTORS.sourceList).innerHTML,
    /来源已删除或当前不可用/
  );
  assert.match(
    root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML,
    /第一行 success<br>第二行/
  );
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.claims).innerHTML, /data-claim-action="revise"/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.claims).innerHTML, /来源已变化/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.permissions).innerHTML, /用于后续回答/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.permissions).innerHTML, /允许形成或更新理解/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.syntheses).innerHTML, /本周完成了一项行动/);
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.syntheses).innerHTML, /来源已变化/);

  const thoughtDetails = new FakeNode(null);
  thoughtDetails.details = true;
  const thought = new FakeNode(null);
  const block = new FakeNode(null);
  thought.chain = thoughtDetails;
  thought.children.set('[data-thought-block-id="block-1"]', block);
  destinations.set('[data-chain-id="thought-root"]', thought);
  assert.equal(root.click({
    contextSource: "",
    contextView: "thoughts",
    contextTarget: "thought-block",
    contextRoot: "thought-root",
    contextKey: "idea:block-1",
    contextDate: "",
    contextDailyType: ""
  }), true);
  assert.deepEqual(navigationLog.shift(), ["thought", "thought-root"]);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(navigationLog.shift(), ["query", '[data-chain-id="thought-root"]']);
  assert.equal(thoughtDetails.open, true);
  assert.deepEqual(block.scrolls, [{ behavior: "smooth", block: "center" }]);

  const daily = new FakeNode(null);
  destinations.set('[data-daily-record-id="daily-1"]', daily);
  root.click({
    contextSource: "",
    contextView: "daily",
    contextTarget: "daily-1",
    contextRoot: "",
    contextKey: "",
    contextDate: "2026-10-02",
    contextDailyType: "sleep"
  });
  assert.deepEqual(navigationLog.splice(0, 2), [
    ["date", "2026-10-02", "sleep"],
    ["view", "daily"]
  ]);
  frames.shift()();
  assert.deepEqual(navigationLog.shift(), ["query", '[data-daily-record-id="daily-1"]']);
  assert.equal(daily.scrolls.length, 1);
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  assert.equal(root.listenerCount(), 0);
}

{
  const permissionPages = [
    {
      data: sampleContext("page-1").sourcePermissions,
      meta: { nextCursor: "next-page", total: 2 }
    },
    {
      data: [{
        ...sampleContext("page-2").sourcePermissions[0],
        sourceKey: JSON.stringify(["journal", "journal-b", "", ""]),
        sourceRef: {
          resourceType: "journal",
          resourceId: "journal-b",
          rootId: "",
          targetKey: "",
          version: 1
        },
        recordType: "日记",
        excerpt: "第二页来源"
      }],
      meta: { nextCursor: null, total: 2 }
    }
  ];
  const overview = sampleContext("paged");
  delete overview.sourcePermissions;
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    async requestV1(path) {
      if (path === PERSONAL_CONTEXT_ENDPOINT) return { data: overview };
      assert.match(path, new RegExp(`^${EVIDENCE_PERMISSIONS_ENDPOINT.replaceAll("/", "\\/")}`));
      return permissionPages.shift();
    }
  }));
  controller.mount({ root, signal: new AbortController().signal });
  await waitFor(
    () => /当前可管理的来源/.test(root.node(PERSONAL_CONTEXT_SELECTORS.permissions).innerHTML),
    "first permission page did not render"
  );
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.permissionsMore).hidden, false);
  assert.equal(root.click({ id: "personal-context-permissions-more" }), true);
  await waitFor(
    () => /第二页来源/.test(root.node(PERSONAL_CONTEXT_SELECTORS.permissions).innerHTML),
    "second permission page did not render"
  );
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.permissionsMore).hidden, true);
  controller.unmount();
}

{
  const requests = [];
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    requestV1() {
      const gate = deferred();
      requests.push(gate);
      return gate.promise;
    }
  }));
  controller.mount({ root, signal: new AbortController().signal });
  requests[0].reject(new Error("offline"));
  await waitFor(
    () => /暂时无法核对个人概要/.test(
      root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML
    ),
    "personal context failure did not render"
  );
  assert.match(
    root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML,
    /data-content-action="retry-personal-context"/
  );
  assert.equal(root.click({ contentAction: "retry-personal-context" }), true);
  assert.equal(requests.length, 2);
  requests[1].resolve({ data: sampleContext("retry") });
  await waitFor(
    () => /结论 retry/.test(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML),
    "personal context retry did not render"
  );
  controller.unmount();
}

async function assertRejectedLateResult(kind, mutate) {
  let account = "account-a";
  let serial = 10;
  const gate = deferred();
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    requestV1: () => gate.promise,
    getAccountId: () => account,
    getSessionSerial: () => serial
  }));
  controller.mount({ root, signal: new AbortController().signal });
  const writes = root.writes;
  mutate({
    setAccount(value) {
      account = value;
    },
    setSession(value) {
      serial = value;
    },
    unmount: controller.unmount
  });
  gate.resolve({ data: sampleContext(`stale-${kind}`) });
  await flush();
  await flush();
  assert.equal(root.writes, writes, `${kind} stale response wrote to the old root`);
  assert.doesNotMatch(
    root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML,
    new RegExp(`stale-${kind}`)
  );
  controller.unmount();
}

await assertRejectedLateResult("account", controls => controls.setAccount("account-b"));
await assertRejectedLateResult("session", controls => controls.setSession(11));
await assertRejectedLateResult("generation", controls => controls.unmount());

{
  const requests = [];
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    requestV1() {
      const gate = deferred();
      requests.push(gate);
      return gate.promise;
    }
  }));
  controller.mount({ root, signal: new AbortController().signal });
  root.click({ contentAction: "retry-personal-context" });
  assert.equal(requests.length, 2);
  requests[1].resolve({ data: sampleContext("newer-request") });
  await waitFor(
    () => /newer-request/.test(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML),
    "newer personal context request did not render"
  );
  requests[0].resolve({ data: sampleContext("older-request") });
  await flush();
  await flush();
  assert.match(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML, /newer-request/);
  assert.doesNotMatch(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML, /older-request/);
  controller.unmount();
}

{
  const requests = [];
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    requestV1() {
      const gate = deferred();
      requests.push(gate);
      return gate.promise;
    }
  }));
  controller.mount({ root, signal: new AbortController().signal });
  requests[0].resolve({ data: sampleContext("private-account-a") });
  await waitFor(
    () => /private-account-a/.test(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML),
    "reset fixture did not render account A"
  );
  root.click({ contentAction: "retry-personal-context" });
  assert.equal(requests.length, 2);
  controller.resetSession();
  assert.equal(root.listenerCount(), 0);
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.status).textContent, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.meta).innerHTML, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.disclosure).textContent, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.summary).innerHTML, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.claims).innerHTML, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.permissions).innerHTML, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.syntheses).innerHTML, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.synthesisStatus).textContent, "");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.sourceCount).textContent, "0 条");
  assert.equal(root.node(PERSONAL_CONTEXT_SELECTORS.sourceList).innerHTML, "");
  const writes = root.writes;
  requests[1].resolve({ data: sampleContext("must-not-return") });
  await flush();
  await flush();
  assert.equal(root.writes, writes, "late response wrote after session reset");
}

{
  let requests = 0;
  const root = new FakeRoot(personalContextSelectors);
  const controller = createPersonalContextFeatureController(personalPorts({
    async requestV1() {
      requests += 1;
      return { data: sampleContext(`cycle-${requests}`) };
    }
  }));
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = controller.mount({
      root,
      route: { view: "personal-context", cycle },
      signal: new AbortController().signal
    });
    assert.equal(root.listenerCount(), 1);
    assert.equal(dispose(), true);
    assert.equal(dispose(), false);
    assert.equal(root.listenerCount(), 0);
  }
  await flush();
  assert.equal(requests, 20);
}

{
  const root = new FakeRoot(personalContextSelectors);
  const abort = new AbortController();
  const controller = createPersonalContextFeatureController(personalPorts());
  controller.mount({ root, signal: abort.signal });
  assert.equal(root.listenerCount(), 1);
  abort.abort();
  assert.equal(root.listenerCount(), 0);
}

console.log(
  "Frontend basic surfaces checks passed: mine/permission/about rendering, delayed roots, "
  + "20-cycle listener cleanup, personal-context retry/reset/stale isolation and source location."
);
