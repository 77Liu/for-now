import {
  normalizeAccountSettings,
  settingsPayload
} from "./model.mjs";
import {
  SETTINGS_SELECTORS,
  renderGenerationRate,
  renderSettingsForm
} from "./presentation.mjs";
import { createLocalTestController } from "./local-test.mjs";
import { createVoicePreviewController } from "./voice-preview.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Settings feature controller requires ${name}`);
  }
}

function domainsRelevant(value) {
  if (value == null) return true;
  const domains = typeof value === "string" ? [value] : [...value];
  return domains.some(domain => ["settings", "speech", "localTest"].includes(domain));
}

export function createSettingsFeatureController({
  request = {},
  currentUser = {},
  settings = {},
  speech = {},
  localTest = {},
  session: sessionPort = {},
  pageAudio,
  hasCapability,
  showToast,
  confirmAction
} = {}) {
  for (const [name, value] of Object.entries({
    "request.json": request.json,
    "request.blob": request.blob,
    "currentUser.get": currentUser.get,
    "settings.get": settings.get,
    "settings.set": settings.set,
    "speech.get": speech.get,
    "localTest.get": localTest.get,
    "localTest.set": localTest.set,
    "localTest.clearScopes": localTest.clearScopes,
    "localTest.reload": localTest.reload,
    "localTest.navigate": localTest.navigate,
    "localTest.setSummary": localTest.setSummary,
    "session.reset": sessionPort.reset,
    hasCapability,
    showToast,
    confirmAction
  })) requireFunction(value, name);

  const voicePreview = createVoicePreviewController({
    requestBlob: request.blob,
    getSpeech: speech.get,
    pageAudio
  });
  const localTestController = createLocalTestController({
    request: request.json,
    getCurrentUser: currentUser.get,
    getConfig: localTest.get,
    setConfig: localTest.set,
    resetSession: sessionPort.reset,
    clearScopes: localTest.clearScopes,
    reload: localTest.reload,
    navigate: localTest.navigate,
    setSummary: localTest.setSummary,
    showToast,
    confirmAction
  });

  let activation = null;
  let session = {};
  let pendingSave = null;
  let pendingTest = null;
  const roots = new Set();

  const ownerId = () => String(currentUser.get()?.id || "");
  const active = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.session === session
    && !candidate.signal?.aborted
  );
  const current = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.owner === ownerId()
    && active(ticket.activation)
  );
  const query = (candidate, selector) => (
    active(candidate) ? candidate.root.querySelector(selector) : null
  );
  const ticket = candidate => ({ activation: candidate, owner: ownerId(), session });

  function render(candidate = activation) {
    if (!active(candidate)) return false;
    renderSettingsForm(candidate.root, settings.get(), speech.get());
    voicePreview.render();
    localTestController.render();
    return true;
  }

  function clearApiKey(candidate) {
    const key = query(candidate, SETTINGS_SELECTORS.apiKey);
    if (key) key.value = "";
  }

  async function save(candidate, form) {
    if (!active(candidate) || pendingSave || pendingTest) return false;
    voicePreview.stop({ clearStatus: true });
    const owner = hasCapability("ai-configuration");
    const operation = ticket(candidate);
    pendingSave = operation;
    const button = form.querySelector?.('[type="submit"]');
    const status = query(candidate, SETTINGS_SELECTORS.status);
    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存…";
    try {
      const next = await request.json(owner ? "/api/settings" : "/api/preferences", {
        method: owner ? "POST" : "PATCH",
        body: JSON.stringify(settingsPayload(candidate.root, {
          owner,
          settings: settings.get(),
          speech: speech.get()
        })),
        signal: candidate.signal
      });
      if (!current(operation) || pendingSave !== operation) return false;
      settings.set(next);
      clearApiKey(candidate);
      render(candidate);
      const nextStatus = query(candidate, SETTINGS_SELECTORS.status);
      if (nextStatus) {
        nextStatus.textContent = owner
          ? "模型、场景与语音设置已保存。"
          : "思考、回答与语音偏好已保存。";
      }
      showToast("设置已保存");
      return true;
    } catch (error) {
      if (current(operation) && status) status.textContent = error?.message || "设置保存失败";
      return false;
    } finally {
      if (pendingSave === operation) pendingSave = null;
      if (current(operation) && button && button.isConnected !== false) button.disabled = false;
    }
  }

  async function testConnection(candidate, button) {
    if (
      !active(candidate)
      || !hasCapability("ai-configuration")
      || pendingSave
      || pendingTest
    ) return false;
    voicePreview.stop({ clearStatus: true });
    const tier = String(query(candidate, SETTINGS_SELECTORS.testTier)?.value || "lite");
    const operation = { ...ticket(candidate), tier };
    pendingTest = operation;
    const status = query(candidate, SETTINGS_SELECTORS.status);
    button.disabled = true;
    if (status) {
      status.textContent = `正在保存并测试 ${tier[0].toUpperCase() + tier.slice(1)}…`;
    }
    try {
      const next = await request.json("/api/settings", {
        method: "POST",
        body: JSON.stringify(settingsPayload(candidate.root, {
          owner: true,
          settings: settings.get(),
          speech: speech.get()
        })),
        signal: candidate.signal
      });
      if (!current(operation) || pendingTest !== operation) return false;
      settings.set(next);
      clearApiKey(candidate);
      render(candidate);
      const result = await request.json("/api/settings/test", {
        method: "POST",
        body: JSON.stringify({ tier }),
        signal: candidate.signal
      });
      if (!current(operation) || pendingTest !== operation) return false;
      const profile = normalizeAccountSettings(settings.get()).profiles[tier];
      const nextStatus = query(candidate, SETTINGS_SELECTORS.status);
      if (nextStatus) {
        nextStatus.textContent = `连接成功 · ${profile.model === "deepseek-v4-pro" ? "DeepSeek Pro" : "DeepSeek Flash"} · ${profile.effort === "none" ? "思考关闭" : `思考 ${profile.effort.toUpperCase()}`}`;
      }
      showToast(result?.reply || "DeepSeek 连接成功");
      return true;
    } catch (error) {
      if (current(operation) && status) {
        status.textContent = `连接失败：${error?.message || "请求失败"}`;
      }
      return false;
    } finally {
      if (pendingTest === operation) pendingTest = null;
      if (current(operation) && button.isConnected !== false) button.disabled = false;
    }
  }

  function closest(candidate, event, selector) {
    if (!active(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    return element && (
      typeof candidate.root.contains !== "function" || candidate.root.contains(element)
    ) ? element : null;
  }

  function handleSubmit(event) {
    const candidate = activation;
    const form = query(candidate, SETTINGS_SELECTORS.form);
    if (!form || event.target !== form) return;
    event.preventDefault?.();
    void save(candidate, form);
  }

  function handleClick(event) {
    const candidate = activation;
    const reset = closest(candidate, event, SETTINGS_SELECTORS.resetStyles);
    const test = closest(candidate, event, SETTINGS_SELECTORS.test);
    if (!reset && !test) return;
    event.preventDefault?.();
    if (reset) {
      const assistant = query(candidate, "#assistant-name");
      if (assistant) assistant.value = "神鸡";
      for (const select of candidate.root.querySelectorAll?.("[data-response-style]") || []) {
        select.value = "standard";
      }
      const status = query(candidate, SETTINGS_SELECTORS.status);
      if (status) status.textContent = "已恢复默认称呼与风格，保存后生效。";
    } else {
      void testConnection(candidate, test);
    }
  }

  function handleInput(event) {
    const candidate = activation;
    if (event.target === query(candidate, SETTINGS_SELECTORS.generationRate)) {
      renderGenerationRate(candidate.root, event.target.value);
    }
  }

  const listeners = Object.freeze({
    submit: handleSubmit,
    click: handleClick,
    input: handleInput
  });

  function detach(candidate) {
    if (activation !== candidate) return false;
    if (pendingSave || pendingTest) {
      const status = candidate.root.querySelector?.(SETTINGS_SELECTORS.status);
      if (status) status.textContent = "";
    }
    activation = null;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [type, listener] of Object.entries(listeners)) {
      candidate.root.removeEventListener(type, listener);
    }
    voicePreview.unmount();
    localTestController.unmount();
    pendingSave = null;
    pendingTest = null;
    return true;
  }

  function mount({ root, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Settings feature mount requires a root event target");
    }
    let disposed = false;
    let candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, signal, session, dispose };
    activation = candidate;
    roots.add(root);
    for (const [type, listener] of Object.entries(listeners)) {
      root.addEventListener(type, listener);
    }
    signal?.addEventListener?.("abort", dispose, { once: true });
    voicePreview.mount({ root, signal });
    localTestController.mount({ root, signal });
    render(candidate);
    return dispose;
  }

  function unmount() {
    return activation ? detach(activation) : false;
  }

  function resetSession() {
    unmount();
    session = {};
    pendingSave = null;
    pendingTest = null;
    voicePreview.resetSession();
    localTestController.resetSession();
    for (const root of roots) {
      root.querySelector?.(SETTINGS_SELECTORS.form)?.reset?.();
      for (const selector of [
        SETTINGS_SELECTORS.status,
        SETTINGS_SELECTORS.voiceStatus,
        SETTINGS_SELECTORS.localStatus
      ]) {
        const element = root.querySelector?.(selector);
        if (element) element.textContent = "";
      }
      for (const button of root.querySelectorAll?.("button") || []) button.disabled = false;
    }
    roots.clear();
  }

  return Object.freeze({
    mount,
    render({ changedDomains } = {}) {
      return domainsRelevant(changedDomains) ? render() : false;
    },
    stopAudio: () => voicePreview.stop({ clearStatus: true }),
    unmount,
    resetSession
  });
}
