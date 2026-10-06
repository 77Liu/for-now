import {
  SETTINGS_SELECTORS,
  renderLocalTest
} from "./presentation.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Local test controller requires ${name}`);
  }
}

function timeoutFailure(error) {
  return ["AbortError", "TimeoutError"].includes(error?.name)
    || /aborted due to timeout|timed out/i.test(error?.message || "");
}

export function createLocalTestController({
  request,
  getCurrentUser,
  getConfig,
  setConfig,
  resetSession,
  clearScopes,
  reload,
  navigate,
  setSummary,
  showToast,
  confirmAction
} = {}) {
  for (const [name, value] of Object.entries({
    request,
    getCurrentUser,
    getConfig,
    setConfig,
    resetSession,
    clearScopes,
    reload,
    navigate,
    setSummary,
    showToast,
    confirmAction
  })) requireFunction(value, name);

  let activation = null;
  let session = {};
  let pending = null;
  let statusMessage = "";
  const roots = new Set();

  const currentOwner = () => String(getCurrentUser()?.id || "");
  const active = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.session === session
    && !candidate.signal?.aborted
  );
  const current = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.owner === currentOwner()
    && active(ticket.activation)
  );

  function render(candidate = activation) {
    if (!active(candidate)) return false;
    const summary = renderLocalTest(candidate.root, getConfig(), {
      statusMessage,
      pending: Boolean(pending)
    });
    setSummary(summary);
    return true;
  }

  async function switchMode(mode, candidate = activation) {
    if (!active(candidate) || pending || !["simulation", "cold"].includes(mode)) {
      return false;
    }
    const label = mode === "simulation" ? "使用模拟" : "冷启测试";
    const message = mode === "simulation"
      ? "切换到使用模拟？记录会在打开对应页面时只读加载，线上不会收到任何业务写入。"
      : "清空冷启测试账户并重新开始？";
    if (!confirmAction(message)) return false;

    resetSession();
    const ticket = {
      activation: candidate,
      owner: currentOwner(),
      session,
      mode
    };
    pending = ticket;
    statusMessage = mode === "simulation"
      ? "正在切换到使用模拟…"
      : "正在创建空账户…";
    render(candidate);
    try {
      const nextConfig = await request("/api/local-test-mode", {
        method: "POST",
        body: JSON.stringify({ mode }),
        signal: candidate.signal
      });
      if (!current(ticket) || pending !== ticket) return false;
      if (nextConfig?.mode !== mode) {
        throw Object.assign(
          new Error("已忽略不属于当前账户或模式的响应"),
          { code: "LOCAL_TEST_RESPONSE_MISMATCH" }
        );
      }
      setConfig(nextConfig);
      clearScopes();
      await reload();
      if (!current(ticket) || pending !== ticket) return false;
      navigate(mode === "cold" ? "today" : "settings");
      statusMessage = mode === "simulation"
        ? "已切换；打开页面时读取对应记录。"
        : "已切换到冷启测试。";
      pending = null;
      render(candidate);
      showToast(`已切换到${label}`);
      return true;
    } catch (error) {
      if (!current(ticket) || pending !== ticket) return false;
      pending = null;
      statusMessage = timeoutFailure(error)
        ? "线上数据读取超时，请检查网络后重试。"
        : error?.message || "本地测试模式切换失败";
      render(candidate);
      return false;
    } finally {
      if (current(ticket) && pending === ticket) {
        pending = null;
        render(candidate);
      }
    }
  }

  function handleClick(event) {
    const candidate = activation;
    if (!active(candidate)) return;
    const button = event?.target?.closest?.(SETTINGS_SELECTORS.localMode);
    if (!button || (
      typeof candidate.root.contains === "function" && !candidate.root.contains(button)
    )) return;
    event.preventDefault?.();
    void switchMode(String(button.dataset?.localTestMode || ""), candidate);
  }

  function detach(candidate) {
    if (activation !== candidate) return false;
    activation = null;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    candidate.root.removeEventListener("click", handleClick);
    if (pending) {
      const status = candidate.root.querySelector?.(SETTINGS_SELECTORS.localStatus);
      if (status) status.textContent = "";
      statusMessage = "";
    }
    pending = null;
    return true;
  }

  function mount({ root, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Local test mount requires a root event target");
    }
    let disposed = false;
    let candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, signal, session, dispose };
    activation = candidate;
    roots.add(root);
    root.addEventListener("click", handleClick);
    signal?.addEventListener?.("abort", dispose, { once: true });
    render(candidate);
    return dispose;
  }

  function unmount() {
    return activation ? detach(activation) : false;
  }

  function resetControllerSession() {
    unmount();
    session = {};
    pending = null;
    statusMessage = "";
    for (const root of roots) {
      const status = root.querySelector?.(SETTINGS_SELECTORS.localStatus);
      if (status) status.textContent = "";
    }
    roots.clear();
    setSummary("配置助手称呼、回答风格与思考强度");
  }

  return Object.freeze({
    mount,
    render,
    switchMode,
    unmount,
    resetSession: resetControllerSession
  });
}
