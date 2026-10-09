export function installAuthEvents({
  $, $$, runtime, onboardingV2Controller, clearDurableDraft, mediaDraftStore,
  setAuthTab, setAuthBusy, authRequest, restartApplicationForUser, showAuthGate
} = {}) {
  $$('[data-auth-tab]').forEach(button => {
    button.addEventListener("click", () => setAuthTab(button.dataset.authTab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = $$('[data-auth-tab]').filter(item => !item.hidden && !item.disabled);
      if (tabs.length < 2) return;
      event.preventDefault();
      const current = Math.max(0, tabs.indexOf(button));
      const next = event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs.at(-1)
          : tabs[(current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      setAuthTab(next.dataset.authTab);
      next.focus();
    });
  });

  for (const [formId, endpoint] of [
    ["login-form", "/api/auth/login"],
    ["register-form", "/api/auth/register"]
  ]) {
    $(`#${formId}`).addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = new FormData(form);
      const status = $("#auth-status");
      const operation = ++runtime.authOperationSerial;
      setAuthBusy(true);
      status.textContent = formId === "login-form" ? "正在登录…" : "正在创建账户…";
      try {
        const result = await authRequest(endpoint, Object.fromEntries(fields));
        if (operation !== runtime.authOperationSerial) return;
        form.reset();
        await restartApplicationForUser(result.user);
      } catch (error) {
        if (operation === runtime.authOperationSerial) status.textContent = error.message;
      } finally {
        if (operation === runtime.authOperationSerial) setAuthBusy(false);
      }
    });
  }

  const logout = async () => {
    if (onboardingV2Controller.hasUnsynced()
      && !confirm("当前有尚未同步的五问草稿。退出会从此设备清除这份草稿，仍要退出？")) {
      return;
    }
    const operation = ++runtime.authOperationSerial;
    const owner = runtime.currentUser?.id;
    clearDurableDraft();
    const clearing = owner
      ? Promise.all([mediaDraftStore.clear(owner), onboardingV2Controller.clearOwner(owner)])
      : Promise.resolve();
    showAuthGate();
    setAuthTab("login");
    setAuthBusy(true);
    $("#auth-status").textContent = "正在退出…";
    try {
      await Promise.all([clearing, authRequest("/api/auth/logout", {})]);
    } catch (error) {
      if (operation === runtime.authOperationSerial) {
        $("#auth-status").textContent = `本地内容已锁定；服务端退出失败：${error.message}`;
      }
    } finally {
      if (operation === runtime.authOperationSerial) {
        setAuthBusy(false);
        if ($("#auth-status").textContent === "正在退出…") $("#auth-status").textContent = "";
      }
    }
  };

  $("#logout-button").addEventListener("click", logout);
  return logout;
}
