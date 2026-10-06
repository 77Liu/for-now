import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createOwnerConsoleFeatureController,
  estimateAiCostScenario,
  OWNER_CONSOLE_VIEWS
} from "../public/frontend/features/owner-console/index.mjs";

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

const dataKey = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor({ id = "", dataset = {}, owner = null, type = "" } = {}) {
    this.id = id;
    this.dataset = { ...dataset };
    this.owner = owner;
    this.parent = null;
    this.type = type;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.children = [];
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.selectors = new Map();
    this.selectorLists = new Map();
    this._innerHTML = "";
    this._textContent = "";
    this.resetCount = 0;
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.owner) this.owner.writes += 1;
  }
  get textContent() {
    return this._textContent;
  }
  set textContent(value) {
    this._textContent = String(value);
    if (this.owner) this.owner.writes += 1;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (this.owner) this.owner.writes += 1;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (this.owner) this.owner.writes += 1;
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const candidate = part.trim();
      if (candidate.startsWith("#")) return this.id === candidate.slice(1);
      if (candidate === '[type="submit"]') return this.type === "submit";
      const match = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(candidate);
      if (!match) return false;
      const key = dataKey(match[1]);
      return Object.hasOwn(this.dataset, key)
        && (match[2] === undefined || String(this.dataset[key]) === match[2]);
    });
  }
  closest(selector) {
    for (let current = this; current; current = current.parent) {
      if (current.matches(selector)) return current;
    }
    return null;
  }
  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }
  querySelectorAll(selector) {
    return this.selectorLists.get(selector) || [];
  }
  map(selector, element) {
    element.owner ||= this.owner;
    this.selectors.set(selector, element);
    return element;
  }
  mapAll(selector, elements) {
    for (const element of elements) element.owner ||= this.owner;
    this.selectorLists.set(selector, elements);
    return elements;
  }
  reset() {
    this.resetCount += 1;
  }
  replaceChildren() {
    this._innerHTML = "";
    this.children = [];
    if (this.owner) this.owner.writes += 1;
  }
}

class FakeRoot extends FakeElement {
  constructor(id) {
    super({ id });
    this.owner = this;
    this.isConnected = true;
    this.writes = 0;
    this.listeners = new Map();
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
    return element?.owner === this;
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  dispatch(type, target) {
    let prevented = false;
    const event = {
      type,
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return prevented;
  }
}

function add(root, selector, options = {}) {
  const element = new FakeElement({ ...options, owner: root });
  root.map(selector, element);
  return element;
}

function form(root, selector) {
  const element = add(root, selector, { id: selector.slice(1) });
  const button = new FakeElement({ owner: root, type: "submit" });
  button.parent = element;
  element.map('[type="submit"]', button);
  root.map(`${selector} [type="submit"]`, button);
  return { element, button };
}

function aiRoot() {
  const root = new FakeRoot("view-ai-cost");
  for (const selector of [
    "#ai-cost-status",
    "#ai-budget-status",
    "#ai-budget-period",
    "#ai-budget-kpis",
    "#ai-cost-scenario-rows",
    "#ai-cost-kpis",
    "#ai-cost-recommendations",
    "#ai-cost-observed",
    "#ai-cost-pricing",
    "#ai-cost-plan-state",
    "#ai-cost-updated-at"
  ]) add(root, selector);
  const planForm = form(root, "#ai-cost-form");
  const addForm = form(root, "#ai-budget-add-form");
  const recoverForm = form(root, "#ai-budget-recover-form");
  for (const [selector, value] of [
    ["#ai-cost-budget", "10"],
    ["#ai-cost-contingency", "5"],
    ["#ai-cost-exchange", "7.2"],
    ["#ai-budget-add-scope", "daily"],
    ["#ai-budget-add-amount", "3"],
    ["#ai-budget-add-reason", "临时回归"],
    ["#ai-budget-recover-scope", "dailyKnownCost"],
    ["#ai-budget-recover-reason", "已核对账单"]
  ]) add(root, selector).value = value;
  const calibrate = add(root, "#ai-cost-calibrate", { id: "ai-cost-calibrate" });
  calibrate.parent = planForm.element;
  return { root, planForm, addForm, recoverForm, calibrate };
}

function surfaceRoot(view) {
  const root = new FakeRoot(`view-${view}`);
  const surface = new FakeElement({
    owner: root,
    dataset: { ownerSurfaceRoot: view }
  });
  root.map(`[data-owner-surface-root="${view}"]`, surface);
  return { root, surface };
}

function commercialRoot() {
  const fixture = surfaceRoot("commercialization");
  const { root, surface } = fixture;
  const commercialForm = new FakeElement({
    id: "commercial-assumptions-form",
    owner: root
  });
  const submit = new FakeElement({ owner: root, type: "submit" });
  submit.parent = commercialForm;
  commercialForm.map('[type="submit"]', submit);
  surface.map("#commercial-assumptions-form", commercialForm);
  root.map("#commercial-assumptions-form", commercialForm);
  root.map('#commercial-assumptions-form [type="submit"]', submit);
  const status = new FakeElement({ id: "commercial-save-status", owner: root });
  surface.map("#commercial-save-status", status);
  root.map("#commercial-save-status", status);
  const field = new FakeElement({
    owner: root,
    dataset: { commercialField: "validation.participants" }
  });
  field.value = "5";
  field.parent = commercialForm;
  const profile = new FakeElement({
    owner: root,
    dataset: { commercialProfileField: "high.sharePct" }
  });
  profile.value = "25";
  profile.parent = commercialForm;
  for (const target of [root, surface]) {
    target.mapAll("[data-commercial-field]", [field]);
    target.mapAll("[data-commercial-profile-field]", [profile]);
  }
  const stage = new FakeElement({ id: "commercial-stage-slider", owner: root });
  stage.value = "0";
  stage.parent = commercialForm;
  surface.map("#commercial-stage-slider", stage);
  root.map("#commercial-stage-slider", stage);
  const source = new FakeElement({
    owner: root,
    dataset: {
      commercialSourceView: "captures",
      commercialSourceId: "capture-1",
      commercialSourceDate: "2026-10-01"
    }
  });
  const mode = new FakeElement({
    owner: root,
    dataset: { commercialMode: "subscription" }
  });
  return { ...fixture, commercialForm, submit, status, field, profile, stage, source, mode };
}

function architectureSurface(markup) {
  return {
    markup,
    kpis: [{ label: "阶段", key: "name", note: "当前产品路线" }],
    stages: [{
      tab: "当前",
      name: "单机",
      state: "运行",
      cost: "¥1",
      note: "当前链路",
      mainPath: [["浏览器", "请求", "focus"]],
      supports: [["观测", [["日志", "本地", ""]]]],
      layers: [["界面", "Web", "单页", "足够"]],
      enter: ["进入", "需要时"],
      defer: ["暂缓", "尚不需要"]
    }],
    terms: [{
      key: "queue",
      code: "MQ",
      name: "队列",
      description: "异步处理",
      analogy: "排队",
      timing: "流量上升"
    }]
  };
}

function commercialSurface(overrides = {}) {
  const assumptions = overrides.assumptions || {
    validation: { participants: 5 },
    subscription: {},
    stageByModel: { validation: 0, subscription: 0 },
    stagePresets: {
      validation: [{ participants: 5 }],
      subscription: [{}]
    },
    usageProfiles: { high: { sharePct: 25 } }
  };
  return {
    markup: "<section>commercial</section>",
    report: {
      version: 3,
      updatedAt: "",
      legacyV2: false,
      assumptions
    },
    mode: overrides.mode || "validation",
    view: {
      stageIndex: 0,
      text: {},
      html: {},
      profileCosts: {},
      shareWarning: false,
      cashflowHidden: true
    }
  };
}

const planFixture = () => ({
  monthlyBudgetCny: 10,
  contingencyPct: 5,
  cnyPerUsd: 7.2,
  updatedAt: "",
  scenarios: []
});

const statisticsFixture = () => ({
  ai: {
    summary: { calls: 0, costsUsd: { total: 0 }, costCny: 0 },
    calibration: { averageInputTokens: 0, p90CostCny: 0 },
    scenes: [],
    pricing: { unitTokens: 1e6, models: {}, historicalUsdNote: "" }
  }
});

const budgetFixture = version => ({
  day: {
    key: "2026-10-06",
    committedKnownCostCny: version,
    reservedKnownCostCny: 0,
    effectiveKnownCostLimitCny: 100,
    committedUnknownCalls: 0,
    reservedUnknownCalls: 0,
    unknownCallLimit: 10,
    blocked: {}
  },
  month: {
    key: "2026-10",
    committedKnownCostCny: version,
    reservedKnownCostCny: 0,
    effectiveKnownCostLimitCny: 2000,
    blocked: {}
  },
  activeReservations: 0,
  controlVersion: version
});

class FakeTimer {
  constructor() {
    this.serial = 0;
    this.tasks = new Map();
  }
  schedule(callback, delay) {
    const id = ++this.serial;
    this.tasks.set(id, { callback, delay });
    return id;
  }
  cancel(id) {
    this.tasks.delete(id);
  }
  runAll() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task.callback();
  }
}

function harnessPorts(overrides = {}) {
  let accountId = "account-a";
  let sessionGeneration = 1;
  const capabilities = new Set(["ai-costs", "architecture", "commercialization"]);
  const timer = overrides.timer || new FakeTimer();
  const navigation = [];
  const toasts = [];
  const ports = {
    request: async url => {
      if (url === "/api/ai-cost-plan") return planFixture();
      if (url.startsWith("/api/statistics")) return statisticsFixture();
      if (url.startsWith("/api/owner/surfaces/architecture")) {
        return architectureSurface("architecture");
      }
      if (url.startsWith("/api/owner/surfaces/commercialization")) {
        return commercialSurface();
      }
      if (url === "/api/commercialization") {
        return commercialSurface().report;
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    requestWithMetadata: async () => ({
      data: { data: budgetFixture(1) },
      etag: '"budget-1"'
    }),
    settings: {
      snapshot: () => ({}),
      currentDate: () => "2026-10-06"
    },
    capability: {
      has: value => capabilities.has(value),
      accountId: () => accountId,
      sessionGeneration: () => sessionGeneration
    },
    format: {
      escapeMarkup: value => String(value ?? "").replace(/[&<>"]/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;"
      })[character]),
      escapeSelector: value => String(value),
      cny: value => `¥${(Number(value) || 0).toFixed(2)}`,
      compactNumber: value => String(Number(value) || 0),
      date: value => `date:${value}`,
      shiftDateKey: (date, days) => {
        const value = new Date(`${date}T00:00:00.000Z`);
        value.setUTCDate(value.getUTCDate() + days);
        return value.toISOString().slice(0, 10);
      }
    },
    navigation: {
      openView: view => navigation.push(["view", view]),
      openSource: source => navigation.push(["source", { ...source }])
    },
    toast: message => toasts.push(message),
    confirm: () => true,
    timer: {
      schedule: (callback, delay) => timer.schedule(callback, delay),
      cancel: id => timer.cancel(id)
    },
    ...overrides
  };
  return {
    ports,
    timer,
    navigation,
    toasts,
    setAccount(value) {
      accountId = value;
    },
    setSession(value) {
      sessionGeneration = value;
    },
    capabilities
  };
}

const sourceFiles = [
  "model.mjs",
  "presentation.mjs",
  "lifecycle.mjs",
  "ai-cost-controller.mjs",
  "architecture-controller.mjs",
  "commercialization-controller.mjs",
  "controller.mjs",
  "index.mjs"
];
const sources = await Promise.all(sourceFiles.map(name => readFile(
  new URL(`../public/frontend/features/owner-console/${name}`, import.meta.url),
  "utf8"
)));
assert.deepEqual(OWNER_CONSOLE_VIEWS, ["ai-cost", "architecture", "commercialization"]);
for (const [index, source] of sources.entries()) {
  assert.ok(source.split("\n").length - 1 < 500, `${sourceFiles[index]} became a giant file`);
}
for (const source of sources.slice(0, -2)) {
  assert.doesNotMatch(source, /\b(?:document|window|fetch|setTimeout|clearTimeout|requestAnimationFrame)\b/);
}
assert.equal(estimateAiCostScenario({
  enabled: true,
  model: "deepseek-flash",
  pricingPeriod: "peak",
  callsPerMonth: 2,
  avgInputTokens: 1_000_000,
  cacheHitPct: 50,
  avgReasoningTokens: 100_000,
  avgAnswerTokens: 100_000
}, {
  unitTokens: 1_000_000,
  models: {
    "deepseek-flash": {
      peak: { cacheHit: 1, cacheMiss: 3, output: 5 }
    }
  }
}).total, 6);
assert.throws(
  () => createOwnerConsoleFeatureController({ view: "architecture" }),
  /requires request/
);
assert.throws(
  () => createOwnerConsoleFeatureController({
    view: "unknown",
    ...harnessPorts().ports
  }),
  /Unknown owner console view/
);

// Repeated mounts keep one listener, and a superseded route response cannot win.
{
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const harness = harnessPorts({
    request: () => (++reads === 1 ? first.promise : second.promise)
  });
  const { root, surface } = surfaceRoot("architecture");
  const controller = createOwnerConsoleFeatureController({
    view: "architecture",
    ...harness.ports
  });
  const disposeOld = controller.mount({ root, route: { id: "old" } });
  const disposeNew = controller.mount({ root, route: { id: "new" } });
  assert.equal(root.listenerCount("click"), 1);
  second.resolve(architectureSurface("new-route"));
  await waitFor(() => surface.innerHTML === "new-route", "new architecture route did not render");
  first.resolve(architectureSurface("old-route"));
  await flush();
  assert.equal(surface.innerHTML, "new-route");
  assert.equal(disposeOld(), false);
  assert.equal(disposeNew(), true);
  assert.equal(root.listenerCount("click"), 0);
}

// A detached Owner surface and an account/session change both reject late responses.
for (const staleKind of ["detached", "account", "session"]) {
  const gate = deferred();
  const harness = harnessPorts({ request: () => gate.promise });
  const { root, surface } = surfaceRoot("architecture");
  const controller = createOwnerConsoleFeatureController({
    view: "architecture",
    ...harness.ports
  });
  controller.mount({ root, route: { id: staleKind } });
  if (staleKind === "detached") root.isConnected = false;
  if (staleKind === "account") harness.setAccount("account-b");
  if (staleKind === "session") harness.setSession(2);
  const writes = root.writes;
  gate.resolve(architectureSurface(`stale-${staleKind}`));
  await flush();
  assert.equal(root.writes, writes, `${staleKind} response wrote into the old Owner DOM`);
  assert.notEqual(surface.innerHTML, `stale-${staleKind}`);
  controller.unmount();
}

// Reset clears sensitive markup even after capability management moved it out of the document.
{
  let reads = 0;
  const harness = harnessPorts({
    request: async () => architectureSurface(`architecture-${++reads}`)
  });
  const { root, surface } = surfaceRoot("architecture");
  const controller = createOwnerConsoleFeatureController({
    view: "architecture",
    ...harness.ports
  });
  controller.mount({ root, route: { id: 1 } });
  await waitFor(() => surface.innerHTML === "architecture-1", "architecture did not load");
  root.isConnected = false;
  controller.resetSession();
  assert.equal(surface.innerHTML, "");
  assert.equal(root.listenerCount("click"), 0);
  root.isConnected = true;
  controller.mount({ root, route: { id: 2 } });
  await waitFor(() => surface.innerHTML === "architecture-2", "reset retained architecture state");
  controller.unmount();
}

// Leaving an AI cost page invalidates all three late load responses and removes listeners.
{
  const plan = deferred();
  const statistics = deferred();
  const budget = deferred();
  const harness = harnessPorts({
    request: url => url === "/api/ai-cost-plan" ? plan.promise : statistics.promise,
    requestWithMetadata: () => budget.promise
  });
  const fixture = aiRoot();
  const controller = createOwnerConsoleFeatureController({
    view: "ai-cost",
    ...harness.ports
  });
  controller.mount({ root: fixture.root, route: { id: "cost" } });
  assert.deepEqual(
    ["click", "input", "submit"].map(type => fixture.root.listenerCount(type)),
    [1, 1, 1]
  );
  controller.unmount();
  const writes = fixture.root.writes;
  plan.resolve(planFixture());
  statistics.resolve(statisticsFixture());
  budget.resolve({ data: { data: budgetFixture(1) }, etag: '"budget-1"' });
  await flush();
  assert.equal(fixture.root.writes, writes);
  assert.deepEqual(
    ["click", "input", "submit"].map(type => fixture.root.listenerCount(type)),
    [0, 0, 0]
  );
}

// A 412 budget write refreshes the ETag and exposes the conflict without losing controls.
{
  const metadataCalls = [];
  let budgetReads = 0;
  const harness = harnessPorts({
    requestWithMetadata: async (url, options = {}) => {
      metadataCalls.push([url, options]);
      if (options.method === "PATCH") {
        throw Object.assign(new Error("precondition failed"), {
          status: 412,
          code: "AI_BUDGET_VERSION_CONFLICT"
        });
      }
      budgetReads += 1;
      return {
        data: { data: budgetFixture(budgetReads) },
        etag: `"budget-${budgetReads}"`
      };
    }
  });
  const fixture = aiRoot();
  const controller = createOwnerConsoleFeatureController({
    view: "ai-cost",
    ...harness.ports
  });
  controller.mount({ root: fixture.root, route: { id: "budget" } });
  await waitFor(
    () => controller.snapshot().budgetEtag === '"budget-1"',
    "initial budget did not load"
  );
  assert.equal(fixture.root.dispatch("submit", fixture.addForm.element), true);
  await waitFor(
    () => fixture.root.querySelector("#ai-budget-status").textContent.includes("其他 Owner"),
    "budget conflict was not presented"
  );
  const patch = metadataCalls.find(([, options]) => options.method === "PATCH");
  assert.equal(patch[1].headers["if-match"], '"budget-1"');
  assert.equal(controller.snapshot().budgetEtag, '"budget-2"');
  assert.equal(controller.snapshot().budget.controlVersion, 2);
  assert.equal(fixture.addForm.button.disabled, false);
  controller.resetSession();
  assert.equal(controller.snapshot().budget, null);
  assert.equal(fixture.root.querySelector("#ai-budget-kpis").innerHTML, "");
}

// Commercial preview is debounced, superseded timers are cancelled, and source links use navigation.
{
  const requests = [];
  const harness = harnessPorts({
    request: async (url, options = {}) => {
      requests.push([url, options]);
      if (url === "/api/commercialization") {
        return {
          ...commercialSurface().report,
          assumptions: JSON.parse(options.body).assumptions
        };
      }
      if (options.method === "POST") {
        const payload = JSON.parse(options.body);
        return commercialSurface({
          assumptions: payload.assumptions,
          mode: payload.mode
        });
      }
      return commercialSurface();
    }
  });
  const fixture = commercialRoot();
  const controller = createOwnerConsoleFeatureController({
    view: "commercialization",
    ...harness.ports
  });
  controller.mount({ root: fixture.root, route: { id: "commercial" } });
  await waitFor(
    () => requests.some(([url, options]) => url.includes("/commercialization?") && !options.method),
    "commercialization surface did not load"
  );
  fixture.field.value = "6";
  fixture.root.dispatch("input", fixture.field);
  fixture.field.value = "7";
  fixture.root.dispatch("input", fixture.field);
  assert.equal(harness.timer.tasks.size, 1);
  assert.equal(
    requests.filter(([, options]) => options.method === "POST").length,
    0
  );
  harness.timer.runAll();
  await waitFor(
    () => requests.filter(([, options]) => options.method === "POST").length === 1,
    "debounced commercial preview did not run once"
  );
  const preview = requests.find(([, options]) => options.method === "POST");
  assert.equal(JSON.parse(preview[1].body).assumptions.validation.participants, 7);
  assert.equal(fixture.root.dispatch("click", fixture.source), true);
  assert.deepEqual(harness.navigation.at(-1), ["source", {
    view: "captures",
    id: "capture-1",
    date: "2026-10-01"
  }]);
  fixture.root.dispatch("input", fixture.field);
  assert.equal(harness.timer.tasks.size, 1);
  controller.unmount();
  assert.equal(harness.timer.tasks.size, 0);
  assert.deepEqual(
    ["click", "input", "submit"].map(type => fixture.root.listenerCount(type)),
    [0, 0, 0]
  );
}

// An in-flight preview cannot repaint after the route has left.
{
  const previewGate = deferred();
  let previewStarted = false;
  const harness = harnessPorts({
    request: async (url, options = {}) => {
      if (options.method === "POST") {
        previewStarted = true;
        return previewGate.promise;
      }
      return commercialSurface();
    }
  });
  const fixture = commercialRoot();
  const controller = createOwnerConsoleFeatureController({
    view: "commercialization",
    ...harness.ports
  });
  controller.mount({ root: fixture.root, route: { id: "preview-leave" } });
  await flush();
  fixture.root.dispatch("input", fixture.field);
  harness.timer.runAll();
  await waitFor(() => previewStarted, "commercial preview did not start");
  controller.unmount();
  const writes = fixture.root.writes;
  previewGate.resolve(commercialSurface({
    assumptions: {
      ...commercialSurface().report.assumptions,
      validation: { participants: 99 }
    }
  }));
  await flush();
  assert.equal(fixture.root.writes, writes);
}

// A scheduled preview captures account/session generation and reset clears detached state.
{
  let previewRequests = 0;
  const harness = harnessPorts({
    request: async (url, options = {}) => {
      if (options.method === "POST") previewRequests += 1;
      return commercialSurface();
    }
  });
  const fixture = commercialRoot();
  const controller = createOwnerConsoleFeatureController({
    view: "commercialization",
    ...harness.ports
  });
  controller.mount({ root: fixture.root, route: { id: 1 } });
  await flush();
  fixture.root.dispatch("input", fixture.field);
  harness.setSession(2);
  harness.timer.runAll();
  await flush();
  assert.equal(previewRequests, 0);
  fixture.root.isConnected = false;
  controller.resetSession();
  assert.equal(fixture.surface.innerHTML, "");
  assert.equal(harness.timer.tasks.size, 0);
}

console.log(
  "Frontend Owner console checks passed: fresh split controllers, repeat mounts, detached DOM, "
  + "route/account/session stale guards, reset cleanup, budget ETag conflicts, preview debounce "
  + "cancellation and source navigation."
);
