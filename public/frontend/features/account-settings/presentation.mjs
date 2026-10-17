import {
  LLM_EFFORTS,
  LLM_TIERS,
  RESPONSE_STYLE_OPTIONS,
  accountTtsVoice,
  normalizeAccountSettings,
  normalizeTtsGenerationRate,
  ttsGenerationRateText
} from "./model.mjs";

export const ACCOUNT_SELECTORS = Object.freeze({
  usernameForm: "#username-form",
  usernameStatus: "#username-status",
  recordTimezoneForm: "#record-timezone-form",
  recordTimezone: "#account-record-timezone",
  recordTimezoneStatus: "#record-timezone-status",
  passwordForm: "#password-form",
  passwordStatus: "#password-status",
  currentName: "#account-current-name",
  pageName: "#account-page-name",
  username: "#account-username",
  roleList: "#account-role-list",
  roleStatus: "#account-role-status",
  roleSave: "[data-account-role-save]",
  retryRoles: '[data-content-action="retry-account-users"]',
  moreRoles: '[data-content-action="load-more-account-users"]',
  logout: "#logout-button-account"
});

export const SETTINGS_SELECTORS = Object.freeze({
  form: "#llm-settings-form",
  status: "#llm-settings-status",
  resetStyles: "#reset-response-styles",
  test: "#test-llm",
  testTier: "#llm-test-tier",
  apiKey: "#llm-api-key",
  voice: "#tts-default-voice",
  voicePreview: "#tts-voice-preview",
  voiceStatus: "#tts-voice-preview-status",
  generationRate: "#tts-generation-rate",
  generationRateValue: "#tts-generation-rate-value",
  localPanel: "#local-test-settings",
  localBadge: "#local-test-badge",
  localSummary: "#local-test-summary",
  localStatus: "#local-test-status",
  localMode: "[data-local-test-mode]"
});

export function escapeMarkup(value) {
  return String(value ?? "").replace(/[&<>"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[character]);
}

function contentState({ kind = "empty", title, body, action = "" }) {
  const role = kind === "failure"
    ? ' role="alert"'
    : kind === "loading"
      ? ' role="status"'
      : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${escapeMarkup(title)}</strong><p>${escapeMarkup(body)}</p>${action}</section>`;
}

export function renderAccountIdentity(root, user) {
  const username = String(user?.username || "");
  for (const selector of [
    ACCOUNT_SELECTORS.currentName,
    ACCOUNT_SELECTORS.pageName,
    ACCOUNT_SELECTORS.username
  ]) {
    const element = root.querySelector(selector);
    if (element) {
      if (selector === ACCOUNT_SELECTORS.username) element.value = username;
      else element.textContent = username;
    }
  }
}

export function renderAccountRoles(root, {
  users = [],
  loadState = "idle",
  nextCursor = "",
  currentUserId = "",
  statusMessage = ""
} = {}) {
  const list = root.querySelector(ACCOUNT_SELECTORS.roleList);
  const status = root.querySelector(ACCOUNT_SELECTORS.roleStatus);
  if (!list) return false;
  if (loadState === "loading") {
    list.innerHTML = contentState({
      kind: "loading",
      title: "正在读取账户",
      body: "角色只包含普通用户与 Owner。"
    });
  } else if (loadState === "failure") {
    list.innerHTML = contentState({
      kind: "failure",
      title: "暂时无法读取账户",
      body: "现有角色没有变化。",
      action: '<button class="quiet-button content-state-action" type="button" data-content-action="retry-account-users">重新读取</button>'
    });
  } else {
    list.innerHTML = users.length
      ? `${users.map(user => `<article class="account-role-row" data-account-user="${escapeMarkup(user.id)}"><div><strong>${escapeMarkup(user.username)}</strong><small>${user.id === currentUserId ? "当前账户 · " : ""}${user.role === "owner" ? "Owner" : "普通用户"}</small></div><select data-account-role="${escapeMarkup(user.id)}" aria-label="${escapeMarkup(`${user.username} 的角色`)}"><option value="user" ${user.role === "user" ? "selected" : ""}>普通用户</option><option value="owner" ${user.role === "owner" ? "selected" : ""}>Owner</option></select><button class="quiet-button" type="button" data-account-role-save="${escapeMarkup(user.id)}">保存</button></article>`).join("")}${nextCursor ? `<button class="quiet-button content-state-action" type="button" data-content-action="load-more-account-users" ${loadState === "loading-more" ? "disabled" : ""}>${loadState === "loading-more" ? "正在读取…" : "加载更多"}</button>` : ""}`
      : contentState({
        title: "还没有可管理的账户",
        body: "新账户注册后会显示在这里。"
      });
  }
  if (status) status.textContent = statusMessage;
  return true;
}

function setOptions(select, options) {
  if (!select || select.options?.length) return;
  select.innerHTML = options.map(([value, label]) => (
    `<option value="${escapeMarkup(value)}">${escapeMarkup(label)}</option>`
  )).join("");
}

export function renderGenerationRate(root, value) {
  const rate = normalizeTtsGenerationRate(value);
  const text = ttsGenerationRateText(rate);
  const control = root.querySelector(SETTINGS_SELECTORS.generationRate);
  const output = root.querySelector(SETTINGS_SELECTORS.generationRateValue);
  if (control) {
    control.value = String(rate);
    control.setAttribute?.("aria-valuetext", text.replace("×", "倍"));
    control.style?.setProperty?.("--fill", `${((rate + 50) / 1.5).toFixed(2)}%`);
  }
  if (output) output.textContent = text;
}

export function renderSettingsForm(root, value, speech = {}) {
  const form = root.querySelector(SETTINGS_SELECTORS.form);
  if (!form) return normalizeAccountSettings(value);
  const settings = normalizeAccountSettings(value);
  const automatic = root.querySelector("#automatic-thought-answer");
  const assistantName = root.querySelector("#assistant-name");
  if (automatic) automatic.checked = settings.automaticAnswers.thoughtAnswer;
  if (assistantName) assistantName.value = settings.assistantName || "神鸡";

  const voiceControl = root.querySelector(SETTINGS_SELECTORS.voice);
  const voices = Array.isArray(speech.voices) ? speech.voices : [];
  const voice = accountTtsVoice(settings, speech);
  if (voiceControl) {
    voiceControl.innerHTML = voices.length
      ? voices.map(item => `<option value="${escapeMarkup(item.id)}">${escapeMarkup(item.label)}</option>`).join("")
      : '<option value="">语音服务未配置</option>';
    voiceControl.disabled = !voices.length;
    if (voices.some(item => item?.id === voice)) voiceControl.value = voice;
  }
  renderGenerationRate(root, settings.speech.generationRate);

  for (const tier of LLM_TIERS) {
    const select = root.querySelector(`[data-profile-model="${tier}"]`);
    if (select) select.value = settings.profiles[tier].model;
  }
  for (const select of root.querySelectorAll?.("[data-ai-scenario]") || []) {
    setOptions(select, LLM_TIERS.map(tier => [tier, tier[0].toUpperCase() + tier.slice(1)]));
    select.value = settings.scenarios[select.dataset.aiScenario];
  }
  for (const select of root.querySelectorAll?.("[data-ai-effort]") || []) {
    setOptions(select, LLM_EFFORTS.map(effort => [
      effort,
      effort === "none" ? "关闭" : effort === "high" ? "High" : "Max"
    ]));
    select.value = settings.sceneEfforts[select.dataset.aiEffort];
  }
  for (const select of root.querySelectorAll?.("[data-response-style]") || []) {
    setOptions(select, RESPONSE_STYLE_OPTIONS);
    select.value = settings.responseStyles[select.dataset.responseStyle] || "standard";
  }

  const badge = root.querySelector("#llm-key-state");
  const hint = root.querySelector("#llm-key-hint");
  if (badge) {
    badge.textContent = settings.hasApiKey ? "密钥已配置" : "未配置密钥";
    badge.classList?.toggle?.("ready", settings.hasApiKey === true);
  }
  if (hint) {
    hint.textContent = settings.hasApiKey
      ? `${settings.keyHint} · 留空保留原密钥`
      : "仅保存在 Owner 账户";
  }
  return settings;
}

export function renderLocalTest(root, config, {
  statusMessage = "",
  pending = false
} = {}) {
  const panel = root.querySelector(SETTINGS_SELECTORS.localPanel);
  if (!panel) return "配置助手称呼、回答风格与思考强度";
  panel.hidden = !config?.enabled;
  if (panel.hidden) return "配置助手称呼、回答风格与思考强度";

  const simulation = config.mode === "simulation";
  const modeLabel = simulation ? "使用模拟" : "冷启测试";
  for (const button of root.querySelectorAll?.(SETTINGS_SELECTORS.localMode) || []) {
    const active = button.dataset.localTestMode === config.mode;
    button.classList?.toggle?.("active", active);
    button.setAttribute?.("aria-pressed", String(active));
    button.disabled = pending
      || active
      || (button.dataset.localTestMode === "simulation" && !config.upstreamConfigured);
  }
  const badge = root.querySelector(SETTINGS_SELECTORS.localBadge);
  const summary = root.querySelector(SETTINGS_SELECTORS.localSummary);
  const status = root.querySelector(SETTINGS_SELECTORS.localStatus);
  if (badge) badge.textContent = modeLabel;
  if (summary) {
    const loadedCount = config.loadedScopes?.length || 0;
    summary.textContent = simulation
      ? `${config.sourceUser?.username || "线上主账户"} · ${config.recordCount || 0} 条已载入 · ${loadedCount ? `${loadedCount} 个页面已读取` : "打开页面后读取记录"}`
      : "空账户工作区；每次切换都会重新清空。";
  }
  if (status) {
    status.textContent = statusMessage || (
      simulation
        ? "当前为使用模拟；记录将在打开页面时读取。"
        : "当前为冷启测试。"
    );
  }
  return `本地测试：使用模拟 / 冷启测试 · 当前${modeLabel}`;
}
