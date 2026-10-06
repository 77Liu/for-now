import assert from "node:assert/strict";
import { createPageAudioCoordinator } from "../public/frontend/media/page-audio.mjs";
import {
  ACCOUNT_SELECTORS,
  SETTINGS_SELECTORS,
  createAccountFeatureController,
  createAccountSettingsFeatureControllers,
  createSettingsFeatureController,
  normalizeAccountSettings,
  settingsPayload
} from "../public/frontend/features/account-settings/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
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

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  toggle(name, force) {
    const active = force === undefined ? !this.values.has(name) : Boolean(force);
    if (active) this.values.add(name);
    else this.values.delete(name);
    return active;
  }
}

function dataName(attribute) {
  return attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_, value) => value.toUpperCase());
}

class FakeElement {
  constructor({ id = "", tagName = "DIV", dataset = {}, name = "" } = {}) {
    this.id = id;
    this.tagName = tagName;
    this.dataset = { ...dataset };
    this.name = name;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
    this.innerHTML = "";
    this.textContent = "";
    this.title = "";
    this.options = [];
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = { values: new Map(), setProperty: (key, value) => this.style.values.set(key, value) };
    this.parent = null;
    this.root = null;
    this.queries = new Map();
    this.validationMessage = "";
  }
  setQuery(selector, value) {
    this.queries.set(selector, value);
    if (value) value.parent = this;
    return value;
  }
  querySelector(selector) {
    return this.queries.get(selector) || null;
  }
  querySelectorAll(selector) {
    const value = this.queries.get(selector);
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  setCustomValidity(message) {
    this.validationMessage = String(message);
  }
  focus() {}
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === "button") return this.tagName === "BUTTON";
    if (selector === '[type="submit"]') return this.type === "submit";
    if (selector === "[aria-hidden]") return this.attributes.has("aria-hidden");
    const match = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!match || !match[1].startsWith("data-")) return false;
    const name = dataName(match[1]);
    return Object.hasOwn(this.dataset, name)
      && (match[2] === undefined || String(this.dataset[name]) === match[2]);
  }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parent?.closest?.(selector) || null;
  }
}

class FakeForm extends FakeElement {
  constructor(id, fields) {
    super({ id, tagName: "FORM" });
    this.elements = fields;
    this.submit = new FakeElement({ tagName: "BUTTON" });
    this.submit.type = "submit";
    this.setQuery('[type="submit"]', this.submit);
  }
  reportValidity() {
    return !Object.values(this.elements).some(field => field.validationMessage);
  }
  reset() {
    for (const field of Object.values(this.elements)) {
      field.value = "";
      field.checked = false;
      field.validationMessage = "";
    }
  }
}

class FakeRoot extends FakeElement {
  constructor() {
    super();
    this.root = this;
    this.listeners = new Map();
    this.all = new Map();
  }
  register(selector, element) {
    element.root = this;
    this.queries.set(selector, element);
    return element;
  }
  registerAll(selector, elements) {
    for (const element of elements) element.root = this;
    this.all.set(selector, elements);
    return elements;
  }
  querySelectorAll(selector) {
    return this.all.get(selector) || super.querySelectorAll(selector);
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
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  dispatch(type, target) {
    let prevented = false;
    const event = {
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return prevented;
  }
}

const element = options => new FakeElement(options);
function createAccountRoot() {
  const root = new FakeRoot();
  const username = element({ id: "account-username", name: "username" });
  const usernameForm = new FakeForm("username-form", { username });
  const currentPassword = element({ name: "currentPassword" });
  const newPassword = element({ name: "newPassword" });
  const confirmPassword = element({ name: "confirmPassword" });
  const passwordForm = new FakeForm("password-form", {
    currentPassword,
    newPassword,
    confirmPassword
  });
  const values = {
    username,
    usernameForm,
    currentPassword,
    newPassword,
    confirmPassword,
    passwordForm,
    currentName: element({ id: "account-current-name" }),
    pageName: element({ id: "account-page-name" }),
    usernameStatus: element({ id: "username-status" }),
    passwordStatus: element({ id: "password-status" }),
    roleList: element({ id: "account-role-list" }),
    roleStatus: element({ id: "account-role-status" }),
    logout: element({ id: "logout-button-account", tagName: "BUTTON" })
  };
  root.register(ACCOUNT_SELECTORS.usernameForm, usernameForm);
  root.register(ACCOUNT_SELECTORS.passwordForm, passwordForm);
  root.register(ACCOUNT_SELECTORS.username, username);
  root.register(ACCOUNT_SELECTORS.currentName, values.currentName);
  root.register(ACCOUNT_SELECTORS.pageName, values.pageName);
  root.register(ACCOUNT_SELECTORS.usernameStatus, values.usernameStatus);
  root.register(ACCOUNT_SELECTORS.passwordStatus, values.passwordStatus);
  root.register(ACCOUNT_SELECTORS.roleList, values.roleList);
  root.register(ACCOUNT_SELECTORS.roleStatus, values.roleStatus);
  root.register(ACCOUNT_SELECTORS.logout, values.logout);
  return { root, ...values };
}

function select(dataset = {}) {
  const value = element({ tagName: "SELECT", dataset });
  value.options = [];
  return value;
}

function createSettingsRoot() {
  const root = new FakeRoot();
  const assistant = element({ id: "assistant-name" });
  const automatic = element({ id: "automatic-thought-answer" });
  const form = new FakeForm("llm-settings-form", {});
  const voice = select();
  voice.id = "tts-default-voice";
  const voiceButton = element({ id: "tts-voice-preview", tagName: "BUTTON" });
  const voiceIcon = element();
  voiceIcon.setAttribute("aria-hidden", "true");
  voiceButton.setQuery("[aria-hidden]", voiceIcon);
  const rate = element({ id: "tts-generation-rate" });
  const resetStyles = element({ id: "reset-response-styles", tagName: "BUTTON" });
  const test = element({ id: "test-llm", tagName: "BUTTON" });
  const localSimulation = element({
    tagName: "BUTTON",
    dataset: { localTestMode: "simulation" }
  });
  const localCold = element({ tagName: "BUTTON", dataset: { localTestMode: "cold" } });
  const responseStyles = [
    select({ responseStyle: "thoughtDraft" }),
    select({ responseStyle: "chat" })
  ];
  const efforts = [
    select({ aiEffort: "thoughtPrompt" }),
    select({ aiEffort: "thoughtAnswer" })
  ];
  const scenarios = [
    select({ aiScenario: "thoughtPrompt" }),
    select({ aiScenario: "thoughtAnswer" })
  ];
  const profiles = Object.fromEntries(["lite", "mid", "high", "ultra"].map(tier => [
    tier,
    select({ profileModel: tier })
  ]));
  const values = {
    form,
    assistant,
    automatic,
    voice,
    voiceButton,
    voiceIcon,
    voiceStatus: element({ id: "tts-voice-preview-status" }),
    rate,
    rateValue: element({ id: "tts-generation-rate-value" }),
    resetStyles,
    test,
    testTier: select(),
    apiKey: element({ id: "llm-api-key" }),
    keyState: element({ id: "llm-key-state" }),
    keyHint: element({ id: "llm-key-hint" }),
    status: element({ id: "llm-settings-status" }),
    localPanel: element({ id: "local-test-settings" }),
    localBadge: element({ id: "local-test-badge" }),
    localSummary: element({ id: "local-test-summary" }),
    localStatus: element({ id: "local-test-status" }),
    localSimulation,
    localCold,
    responseStyles,
    efforts,
    scenarios,
    profiles
  };
  for (const [selector, value] of [
    [SETTINGS_SELECTORS.form, form],
    [SETTINGS_SELECTORS.status, values.status],
    [SETTINGS_SELECTORS.resetStyles, resetStyles],
    [SETTINGS_SELECTORS.test, test],
    [SETTINGS_SELECTORS.testTier, values.testTier],
    [SETTINGS_SELECTORS.apiKey, values.apiKey],
    [SETTINGS_SELECTORS.voice, voice],
    [SETTINGS_SELECTORS.voicePreview, voiceButton],
    [SETTINGS_SELECTORS.voiceStatus, values.voiceStatus],
    [SETTINGS_SELECTORS.generationRate, rate],
    [SETTINGS_SELECTORS.generationRateValue, values.rateValue],
    [SETTINGS_SELECTORS.localPanel, values.localPanel],
    [SETTINGS_SELECTORS.localBadge, values.localBadge],
    [SETTINGS_SELECTORS.localSummary, values.localSummary],
    [SETTINGS_SELECTORS.localStatus, values.localStatus],
    ["#assistant-name", assistant],
    ["#automatic-thought-answer", automatic],
    ["#llm-key-state", values.keyState],
    ["#llm-key-hint", values.keyHint]
  ]) root.register(selector, value);
  for (const [tier, value] of Object.entries(profiles)) {
    root.register(`[data-profile-model="${tier}"]`, value);
  }
  root.registerAll("[data-response-style]", responseStyles);
  root.registerAll("[data-ai-effort]", efforts);
  root.registerAll("[data-ai-scenario]", scenarios);
  root.registerAll(SETTINGS_SELECTORS.localMode, [localSimulation, localCold]);
  root.registerAll("button", [
    form.submit,
    voiceButton,
    resetStyles,
    test,
    localSimulation,
    localCold
  ]);
  return { root, ...values };
}

const baseSettings = () => normalizeAccountSettings({
  assistantName: "小助手",
  hasApiKey: true,
  keyHint: "sk-***",
  automaticAnswers: { thoughtAnswer: true },
  speech: { defaultVoice: "voice-a", generationRate: 20 },
  responseStyles: { thoughtDraft: "deep", chat: "concise" }
});
const baseSpeech = () => ({
  configured: true,
  defaultVoice: "voice-a",
  voices: [
    { id: "voice-a", label: "音色 A" },
    { id: "voice-b", label: "音色 B", samplePath: "/samples/voice-b.mp3" }
  ]
});

function createSettingsHarness(overrides = {}) {
  let user = { id: "account-a", username: "甲", role: "user" };
  let value = baseSettings();
  let speechValue = baseSpeech();
  let localConfig = null;
  const calls = [];
  const toasts = [];
  const summaries = [];
  const navigations = [];
  let sessionResets = 0;
  let scopeClears = 0;
  let reloads = 0;
  const request = {
    async json(path, options = {}) {
      calls.push(["json", path, options]);
      if (path === "/api/settings/test") return { reply: "连接正常" };
      if (path === "/api/local-test-mode") {
        return { ...localConfig, mode: JSON.parse(options.body).mode };
      }
      return { ...value, ...JSON.parse(options.body || "{}") };
    },
    async blob(path, options = {}) {
      calls.push(["blob", path, options]);
      return new Blob(["audio"], { type: "audio/mpeg" });
    }
  };
  const pageAudio = {
    playBlob: async load => (await load({ signal: new AbortController().signal }), new EventTarget()),
    stop() {},
    stopAll() {}
  };
  const state = {
    get user() { return user; },
    set user(next) { user = next; },
    get settings() { return value; },
    set settings(next) { value = next; },
    get speech() { return speechValue; },
    set speech(next) { speechValue = next; },
    get localConfig() { return localConfig; },
    set localConfig(next) { localConfig = next; }
  };
  const ports = {
    request,
    currentUser: { get: () => user },
    settings: { get: () => value, set: next => { value = next; } },
    speech: { get: () => speechValue },
    localTest: {
      get: () => localConfig,
      set: next => { localConfig = next; },
      clearScopes: () => { scopeClears += 1; },
      reload: async () => { reloads += 1; },
      navigate: view => navigations.push(view),
      setSummary: summary => summaries.push(summary)
    },
    session: { reset: () => { sessionResets += 1; } },
    pageAudio,
    hasCapability: capability => user.role === "owner" && [
      "ai-configuration",
      "local-testing"
    ].includes(capability),
    showToast: message => toasts.push(message),
    confirmAction: () => true,
    ...overrides
  };
  return {
    controller: createSettingsFeatureController(ports),
    ports,
    state,
    calls,
    toasts,
    summaries,
    navigations,
    counters: {
      sessionResets: () => sessionResets,
      scopeClears: () => scopeClears,
      reloads: () => reloads
    }
  };
}

{
  const normalized = normalizeAccountSettings({});
  assert.equal(normalized.profiles.ultra.model, "deepseek-v4-pro");
  assert.equal(normalized.sceneEfforts.onboardingClaimExtraction, "high");
  assert.deepEqual(normalized.speech, { defaultVoice: "", generationRate: -10 });
  const fixture = createSettingsRoot();
  fixture.assistant.value = "普通账户助手";
  fixture.automatic.checked = true;
  fixture.voice.value = "voice-a";
  fixture.rate.value = "150";
  fixture.efforts[0].value = "none";
  fixture.responseStyles[0].value = "structured";
  const payload = settingsPayload(fixture.root, {
    owner: false,
    settings: normalized,
    speech: baseSpeech()
  });
  assert.equal(payload.speech.generationRate, 100);
  assert.equal(payload.sceneEfforts.thoughtPrompt, "none");
  assert.equal(Object.hasOwn(payload, "profiles"), false);
  assert.equal(Object.hasOwn(payload, "apiKey"), false);
}

{
  let user = { id: "account-a", username: "甲", role: "user" };
  let listRequests = 0;
  const account = createAccountFeatureController({
    auth: { request: async () => ({}), reset() {}, logout() {} },
    request: async () => {
      listRequests += 1;
      return { users: [] };
    },
    currentUser: { get: () => user, set: next => { user = next; } },
    hasCapability: () => false,
    showToast() {},
    confirmAction: () => true
  });
  const fixture = createAccountRoot();
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = account.mount({
      root: fixture.root,
      signal: new AbortController().signal
    });
    assert.equal(fixture.root.listenerCount("submit"), 1);
    assert.equal(fixture.root.listenerCount("input"), 1);
    assert.equal(fixture.root.listenerCount("click"), 1);
    assert.equal(dispose(), true);
    assert.equal(dispose(), false);
    assert.equal(fixture.root.listenerCount("submit"), 0);
    assert.equal(fixture.root.listenerCount("input"), 0);
    assert.equal(fixture.root.listenerCount("click"), 0);
  }
  assert.equal(listRequests, 0, "regular accounts must not request the role list");
  account.mount({ root: fixture.root });
  fixture.usernameStatus.textContent = "private";
  account.resetSession();
  assert.equal(fixture.username.value, "");
  assert.equal(fixture.usernameStatus.textContent, "");
  assert.equal(fixture.roleList.innerHTML, "");
}

{
  let user = { id: "account-a", username: "旧账户", role: "owner" };
  const oldGate = deferred();
  const calls = [];
  const controller = createAccountFeatureController({
    auth: { request: async () => ({}), reset() {}, logout() {} },
    request: path => {
      calls.push([user.id, path]);
      return user.id === "account-a"
        ? oldGate.promise
        : Promise.resolve({ users: [{ id: "account-b", username: "新账户", role: "owner" }] });
    },
    currentUser: { get: () => user, set: next => { user = next; } },
    hasCapability: () => true,
    showToast() {},
    confirmAction: () => true
  });
  const oldRoot = createAccountRoot();
  controller.mount({ root: oldRoot.root });
  controller.resetSession();
  user = { id: "account-b", username: "新账户", role: "owner" };
  const nextRoot = createAccountRoot();
  controller.mount({ root: nextRoot.root });
  await waitFor(() => /新账户/.test(nextRoot.roleList.innerHTML), "new account list did not load");
  const newMarkup = nextRoot.roleList.innerHTML;
  oldGate.resolve({ users: [{ id: "account-a", username: "旧账户", role: "owner" }] });
  await flush();
  assert.equal(nextRoot.roleList.innerHTML, newMarkup);
  assert.doesNotMatch(nextRoot.roleList.innerHTML, /旧账户/);
  assert.deepEqual(calls.map(call => call[0]), ["account-a", "account-b"]);
  controller.unmount();
}

{
  let user = { id: "owner-a", username: "Owner A", role: "owner" };
  const authCalls = [];
  const resets = [];
  const toasts = [];
  let logouts = 0;
  const controller = createAccountFeatureController({
    auth: {
      async request(path, body, method) {
        authCalls.push([path, body, method]);
        if (path === "/api/auth/username") {
          return { user: { ...user, username: body.username } };
        }
        if (path.includes("/role")) {
          return { user: { id: path.split("/").at(-2), username: "更新账户", role: body.role } };
        }
        return {};
      },
      reset: message => resets.push(message),
      logout: () => { logouts += 1; }
    },
    request: async () => ({
      users: [
        { id: "owner-a", username: "Owner A", role: "owner" },
        { id: "user-b", username: "User B", role: "user" }
      ]
    }),
    currentUser: { get: () => user, set: next => { user = next; } },
    hasCapability: capability => capability === "account-roles",
    showToast: message => toasts.push(message),
    confirmAction: () => true
  });
  const fixture = createAccountRoot();
  controller.mount({ root: fixture.root });
  await waitFor(() => /User B/.test(fixture.roleList.innerHTML), "owner role list did not load");

  fixture.username.value = "Owner 新名";
  fixture.root.dispatch("submit", fixture.usernameForm);
  await waitFor(() => toasts.includes("用户名已更新"), "username request did not settle");
  assert.deepEqual(authCalls[0], [
    "/api/auth/username",
    { username: "Owner 新名" },
    "PATCH"
  ]);
  assert.equal(fixture.pageName.textContent, "Owner 新名");

  fixture.currentPassword.value = "old-password";
  fixture.newPassword.value = "new-password-1";
  fixture.confirmPassword.value = "new-password-1";
  fixture.root.dispatch("submit", fixture.passwordForm);
  await waitFor(() => toasts.includes("密码已更新"), "password request did not settle");
  assert.equal(authCalls[1][0], "/api/auth/password");
  assert.equal(authCalls[1][2], "PATCH");

  const roleRow = element({ dataset: { accountUser: "user-b" } });
  roleRow.root = fixture.root;
  const roleSelect = select({ accountRole: "user-b" });
  roleSelect.value = "owner";
  roleSelect.root = fixture.root;
  roleRow.setQuery("[data-account-role]", roleSelect);
  const roleButton = element({ tagName: "BUTTON", dataset: { accountRoleSave: "user-b" } });
  roleButton.root = fixture.root;
  roleButton.parent = roleRow;
  fixture.root.dispatch("click", roleButton);
  await waitFor(
    () => authCalls.some(([path]) => path === "/api/auth/users/user-b/role"),
    "role update was not requested"
  );
  assert.match(fixture.roleStatus.textContent, /角色已更新/);

  const selfRow = element({ dataset: { accountUser: "owner-a" } });
  selfRow.root = fixture.root;
  const selfSelect = select({ accountRole: "owner-a" });
  selfSelect.value = "user";
  selfSelect.root = fixture.root;
  selfRow.setQuery("[data-account-role]", selfSelect);
  const selfButton = element({ tagName: "BUTTON", dataset: { accountRoleSave: "owner-a" } });
  selfButton.root = fixture.root;
  selfButton.parent = selfRow;
  fixture.root.dispatch("click", selfButton);
  await waitFor(() => resets.length === 1, "self-demotion did not force reauthentication");
  assert.equal(resets[0], "账户权限已变更，请重新登录。");

  fixture.root.dispatch("click", fixture.logout);
  assert.equal(logouts, 1);
  controller.unmount();
}

{
  const harness = createSettingsHarness();
  const fixture = createSettingsRoot();
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const dispose = harness.controller.mount({
      root: fixture.root,
      signal: new AbortController().signal
    });
    assert.equal(fixture.root.listenerCount("submit"), 1);
    assert.equal(fixture.root.listenerCount("input"), 1);
    assert.equal(fixture.root.listenerCount("change"), 1);
    assert.equal(fixture.root.listenerCount("click"), 3);
    assert.equal(dispose(), true);
    assert.equal(dispose(), false);
    assert.equal(fixture.root.listenerCount("submit"), 0);
    assert.equal(fixture.root.listenerCount("input"), 0);
    assert.equal(fixture.root.listenerCount("change"), 0);
    assert.equal(fixture.root.listenerCount("click"), 0);
  }
  harness.controller.mount({ root: fixture.root });
  fixture.status.textContent = "private";
  harness.controller.resetSession();
  assert.equal(fixture.status.textContent, "");
  assert.equal(fixture.root.listenerCount("click"), 0);
}

{
  const harness = createSettingsHarness();
  const fixture = createSettingsRoot();
  harness.controller.mount({ root: fixture.root });
  fixture.assistant.value = "普通账户助手";
  fixture.rate.value = "25";
  fixture.apiKey.value = "must-not-send";
  fixture.root.dispatch("submit", fixture.form);
  await waitFor(() => harness.toasts.length === 1, "regular settings save did not settle");
  const [, path, options] = harness.calls.find(call => call[0] === "json");
  const body = JSON.parse(options.body);
  assert.equal(path, "/api/preferences");
  assert.equal(options.method, "PATCH");
  assert.equal(body.assistantName, "普通账户助手");
  assert.equal(Object.hasOwn(body, "apiKey"), false);
  assert.equal(Object.hasOwn(body, "profiles"), false);
  assert.equal(fixture.status.textContent, "思考、回答与语音偏好已保存。");
  harness.controller.unmount();
}

{
  const harness = createSettingsHarness();
  harness.state.user = { id: "owner-a", username: "Owner", role: "owner" };
  const fixture = createSettingsRoot();
  harness.controller.mount({ root: fixture.root });
  fixture.apiKey.value = "sk-owner";
  fixture.profiles.ultra.value = "deepseek-v4-pro";
  fixture.root.dispatch("submit", fixture.form);
  await waitFor(() => harness.toasts.length === 1, "owner settings save did not settle");
  const ownerSave = harness.calls.find(([, path]) => path === "/api/settings");
  assert.equal(ownerSave[2].method, "POST");
  assert.equal(JSON.parse(ownerSave[2].body).apiKey, "sk-owner");
  assert.equal(fixture.apiKey.value, "");

  harness.calls.length = 0;
  harness.toasts.length = 0;
  fixture.testTier.value = "ultra";
  fixture.root.dispatch("click", fixture.test);
  await waitFor(() => harness.toasts.length === 1, "owner settings test did not settle");
  assert.deepEqual(
    harness.calls.filter(call => call[0] === "json").map(([, path, options]) => [path, options.method]),
    [["/api/settings", "POST"], ["/api/settings/test", "POST"]]
  );
  assert.match(fixture.status.textContent, /连接成功 · DeepSeek Pro/);
  harness.controller.unmount();
}

{
  const createdUrls = [];
  const revokedUrls = [];
  const audios = [];
  class FakeAudio extends EventTarget {
    constructor(source) {
      super();
      this.source = source;
      this.currentTime = 0;
      this.pauses = 0;
      this.loads = 0;
      audios.push(this);
    }
    async play() {}
    pause() { this.pauses += 1; }
    removeAttribute(name) {
      if (name === "src") this.source = "";
    }
    load() { this.loads += 1; }
  }
  const pageAudio = createPageAudioCoordinator({
    createAudio: source => new FakeAudio(source),
    createObjectURL: () => {
      const url = `blob:preview-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: url => revokedUrls.push(url)
  });
  const harness = createSettingsHarness({ pageAudio });
  const fixture = createSettingsRoot();
  harness.controller.mount({ root: fixture.root });
  fixture.root.dispatch("click", fixture.voiceButton);
  await waitFor(() => audios.length === 1, "voice preview did not start");
  fixture.root.dispatch("change", fixture.voice);
  assert.deepEqual(revokedUrls, ["blob:preview-1"]);
  assert.equal(audios[0].pauses, 1);
  assert.equal(audios[0].source, "");

  fixture.root.dispatch("click", fixture.voiceButton);
  await waitFor(() => audios.length === 2, "second voice preview did not start");
  harness.controller.unmount();
  assert.deepEqual(revokedUrls, ["blob:preview-1", "blob:preview-2"]);

  const blobGate = deferred();
  const staleHarness = createSettingsHarness({
    pageAudio,
    request: {
      json: async () => ({}),
      blob: () => blobGate.promise
    }
  });
  const staleRoot = createSettingsRoot();
  staleHarness.controller.mount({ root: staleRoot.root });
  staleRoot.root.dispatch("click", staleRoot.voiceButton);
  await flush();
  staleHarness.controller.resetSession();
  blobGate.resolve(new Blob(["late"], { type: "audio/mpeg" }));
  await flush();
  await flush();
  assert.equal(createdUrls.length, 2, "late preview blob created a stale object URL");
}

{
  const harness = createSettingsHarness();
  harness.state.user = { id: "owner-a", username: "Owner", role: "owner" };
  harness.state.localConfig = {
    enabled: true,
    mode: "cold",
    upstreamConfigured: true,
    loadedScopes: []
  };
  const fixture = createSettingsRoot();
  harness.controller.mount({ root: fixture.root });
  fixture.root.dispatch("click", fixture.localSimulation);
  await waitFor(() => harness.toasts.length === 1, "local-test switch did not settle");
  assert.equal(harness.counters.sessionResets(), 1);
  assert.equal(harness.counters.scopeClears(), 1);
  assert.equal(harness.counters.reloads(), 1);
  assert.equal(harness.state.localConfig.mode, "simulation");
  assert.deepEqual(harness.navigations, ["settings"]);
  assert.equal(harness.toasts[0], "已切换到使用模拟");
  harness.controller.unmount();
}

{
  const gate = deferred();
  const applied = [];
  let user = { id: "owner-a", username: "Owner A", role: "owner" };
  let config = {
    enabled: true,
    mode: "simulation",
    upstreamConfigured: true,
    loadedScopes: []
  };
  let reloads = 0;
  const fixture = createSettingsRoot();
  const controller = createSettingsFeatureController({
    request: {
      json: path => path === "/api/local-test-mode" ? gate.promise : Promise.resolve({}),
      blob: async () => new Blob(["audio"])
    },
    currentUser: { get: () => user },
    settings: { get: baseSettings, set() {} },
    speech: { get: baseSpeech },
    localTest: {
      get: () => config,
      set: next => { config = next; applied.push(next); },
      clearScopes() {},
      reload: async () => { reloads += 1; },
      navigate() {},
      setSummary() {}
    },
    session: { reset() {} },
    pageAudio: { async playBlob() {}, stop() {}, stopAll() {} },
    hasCapability: () => true,
    showToast() {},
    confirmAction: () => true
  });
  controller.mount({ root: fixture.root });
  fixture.root.dispatch("click", fixture.localCold);
  await flush();
  user = { id: "owner-b", username: "Owner B", role: "owner" };
  controller.resetSession();
  gate.resolve({ ...config, mode: "cold" });
  await flush();
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(reloads, 0);
  assert.equal(fixture.localStatus.textContent, "");
}

{
  const ports = {
    auth: { request: async () => ({}), reset() {}, logout() {} },
    session: { reset() {} },
    request: {
      json: async () => ({ users: [] }),
      blob: async () => new Blob(["audio"])
    },
    currentUser: { get: () => null, set() {} },
    settings: { get: baseSettings, set() {} },
    speech: { get: baseSpeech },
    localTest: {
      get: () => null,
      set() {},
      clearScopes() {},
      reload: async () => {},
      navigate() {},
      setSummary() {}
    },
    pageAudio: { async playBlob() {}, stop() {}, stopAll() {} },
    capabilities: { has: () => false },
    toast() {},
    confirm: () => true
  };
  const controllers = createAccountSettingsFeatureControllers(ports);
  assert.deepEqual(Object.keys(controllers), ["account", "settings"]);
}

console.log("Frontend account/settings feature checks passed.");
