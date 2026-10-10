import {
  ACCOUNT_SELECTORS,
  renderAccountIdentity,
  renderAccountRoles
} from "./presentation.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Account feature controller requires ${name}`);
  }
}

function formControl(form, name) {
  return form?.elements?.[name] || form?.elements?.namedItem?.(name) || null;
}

export function createAccountFeatureController({
  auth = {},
  request,
  currentUser = {},
  hasCapability,
  showToast,
  confirmAction
} = {}) {
  for (const [name, value] of Object.entries({
    "auth.request": auth.request,
    "auth.reset": auth.reset,
    "auth.logout": auth.logout,
    request,
    "currentUser.get": currentUser.get,
    "currentUser.set": currentUser.set,
    hasCapability,
    showToast,
    confirmAction
  })) requireFunction(value, name);

  let activation = null;
  let session = {};
  let loadSerial = 0;
  let users = [];
  let loadState = "idle";
  let roleStatus = "";
  let identityKey = "";
  const roots = new Set();

  const user = () => currentUser.get() || null;
  const ownerId = () => String(user()?.id || "");
  const active = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.session === session
    && !candidate.signal?.aborted
  );
  const sameSession = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.owner === ownerId()
  );
  const current = ticket => sameSession(ticket) && active(ticket.activation);
  const ticket = candidate => ({ activation: candidate, owner: ownerId(), session });
  const query = (candidate, selector) => (
    active(candidate) ? candidate.root.querySelector(selector) : null
  );

  function renderIdentity(candidate = activation, { force = false } = {}) {
    if (!active(candidate)) return false;
    const currentUserValue = user();
    const nextKey = `${currentUserValue?.id || ""}:${currentUserValue?.username || ""}:${currentUserValue?.recordTimezone || ""}`;
    if (!force && nextKey === identityKey) return false;
    identityKey = nextKey;
    renderAccountIdentity(candidate.root, currentUserValue);
    const timezone = query(candidate, ACCOUNT_SELECTORS.recordTimezone);
    if (timezone) timezone.value = currentUserValue?.recordTimezone || "";
    return true;
  }

  function renderRoles(candidate = activation) {
    if (!active(candidate)) return false;
    if (!hasCapability("account-roles")) {
      const list = query(candidate, ACCOUNT_SELECTORS.roleList);
      const status = query(candidate, ACCOUNT_SELECTORS.roleStatus);
      if (list) list.innerHTML = "";
      if (status) status.textContent = "";
      return false;
    }
    return renderAccountRoles(candidate.root, {
      users,
      loadState,
      currentUserId: ownerId(),
      statusMessage: roleStatus
    });
  }

  async function load(candidate = activation) {
    if (!active(candidate) || !ownerId() || !hasCapability("account-roles")) return false;
    const operation = { ...ticket(candidate), serial: ++loadSerial };
    loadState = "loading";
    roleStatus = "";
    renderRoles(candidate);
    try {
      const result = await request("/api/auth/users", {
        signal: candidate.signal
      });
      if (!current(operation) || operation.serial !== loadSerial) return false;
      users = Array.isArray(result?.users) ? result.users : [];
      loadState = "ready";
      renderRoles(candidate);
      return true;
    } catch (error) {
      if (!current(operation) || operation.serial !== loadSerial) return false;
      loadState = "failure";
      roleStatus = error?.message || "账户读取失败";
      renderRoles(candidate);
      return false;
    }
  }

  async function submitUsername(candidate, form) {
    const operation = ticket(candidate);
    const button = form.querySelector?.('[type="submit"]');
    const status = query(candidate, ACCOUNT_SELECTORS.usernameStatus);
    if (button) button.disabled = true;
    if (status) status.textContent = "正在修改…";
    try {
      const result = await auth.request("/api/auth/username", {
        username: formControl(form, "username")?.value || ""
      }, "PATCH");
      if (!sameSession(operation)) return false;
      currentUser.set(result.user);
      if (current(operation)) {
        identityKey = "";
        renderIdentity(candidate, { force: true });
        const nextStatus = query(candidate, ACCOUNT_SELECTORS.usernameStatus);
        if (nextStatus) nextStatus.textContent = "用户名已更新。";
      }
      showToast("用户名已更新");
      return true;
    } catch (error) {
      if (current(operation) && status) status.textContent = error?.message || "用户名修改失败";
      return false;
    } finally {
      if (current(operation) && button && button.isConnected !== false) button.disabled = false;
    }
  }

  async function submitPassword(candidate, form) {
    const currentPassword = formControl(form, "currentPassword");
    const newPassword = formControl(form, "newPassword");
    const confirmPassword = formControl(form, "confirmPassword");
    confirmPassword?.setCustomValidity?.(
      newPassword?.value === confirmPassword?.value ? "" : "两次输入的新密码不一致"
    );
    if (form.reportValidity?.() === false) return false;

    const operation = ticket(candidate);
    const button = form.querySelector?.('[type="submit"]');
    const status = query(candidate, ACCOUNT_SELECTORS.passwordStatus);
    if (button) button.disabled = true;
    if (status) status.textContent = "正在修改…";
    try {
      await auth.request("/api/auth/password", {
        currentPassword: currentPassword?.value || "",
        newPassword: newPassword?.value || ""
      }, "PATCH");
      if (!sameSession(operation)) return false;
      if (current(operation)) {
        form.reset?.();
        const nextStatus = query(candidate, ACCOUNT_SELECTORS.passwordStatus);
        if (nextStatus) nextStatus.textContent = "密码已更新，其他设备上的登录已退出。";
      }
      showToast("密码已更新");
      return true;
    } catch (error) {
      if (current(operation) && status) status.textContent = error?.message || "密码修改失败";
      return false;
    } finally {
      if (current(operation) && button && button.isConnected !== false) button.disabled = false;
    }
  }

  async function submitRecordTimezone(candidate, form) {
    const operation = ticket(candidate);
    const button = form.querySelector?.('[type="submit"]');
    const status = query(candidate, ACCOUNT_SELECTORS.recordTimezoneStatus);
    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存…";
    try {
      const result = await auth.request("/api/auth/timezone", {
        timezone: formControl(form, "timezone")?.value || ""
      }, "PATCH");
      if (!sameSession(operation)) return false;
      currentUser.set(result.user);
      if (current(operation)) {
        identityKey = "";
        renderIdentity(candidate, { force: true });
        const nextStatus = query(candidate, ACCOUNT_SELECTORS.recordTimezoneStatus);
        if (nextStatus) nextStatus.textContent = "记录时区已更新。";
      }
      showToast("记录时区已更新");
      return true;
    } catch (error) {
      if (current(operation) && status) status.textContent = error?.message || "记录时区保存失败";
      return false;
    } finally {
      if (current(operation) && button && button.isConnected !== false) button.disabled = false;
    }
  }

  async function changeRole(candidate, button) {
    if (!active(candidate) || !hasCapability("account-roles")) return false;
    const userId = String(button.dataset?.accountRoleSave || "");
    const account = users.find(item => item?.id === userId);
    const row = button.closest?.("[data-account-user]");
    const select = row?.querySelector?.("[data-account-role]");
    const role = String(select?.value || "");
    if (!account || !["user", "owner"].includes(role) || role === account.role) return false;
    if (
      account.role === "owner"
      && role === "user"
      && !confirmAction(`撤销 ${account.username} 的 Owner 权限？该账户需要重新登录。`)
    ) {
      select.value = account.role;
      return false;
    }

    const operation = { ...ticket(candidate), userId, previousRole: account.role, role };
    button.disabled = true;
    roleStatus = "正在更新角色…";
    const status = query(candidate, ACCOUNT_SELECTORS.roleStatus);
    if (status) status.textContent = roleStatus;
    try {
      const result = await auth.request(
        `/api/auth/users/${encodeURIComponent(userId)}/role`,
        { role },
        "PATCH"
      );
      if (!sameSession(operation)) return false;
      if (userId === operation.owner && operation.previousRole === "owner" && role === "user") {
        auth.reset("账户权限已变更，请重新登录。");
        return true;
      }
      users = users.map(item => item.id === userId ? result.user : item);
      roleStatus = "角色已更新；该账户需要重新登录。";
      if (current(operation)) renderRoles(candidate);
      return true;
    } catch (error) {
      if (current(operation)) {
        if (select) select.value = account.role;
        roleStatus = error?.message || "角色更新失败";
        renderRoles(candidate);
      }
      return false;
    } finally {
      if (current(operation) && button.isConnected !== false) button.disabled = false;
    }
  }

  function handleSubmit(event) {
    const candidate = activation;
    if (!active(candidate)) return;
    if (event.target === query(candidate, ACCOUNT_SELECTORS.usernameForm)) {
      event.preventDefault?.();
      void submitUsername(candidate, event.target);
    } else if (event.target === query(candidate, ACCOUNT_SELECTORS.recordTimezoneForm)) {
      event.preventDefault?.();
      void submitRecordTimezone(candidate, event.target);
    } else if (event.target === query(candidate, ACCOUNT_SELECTORS.passwordForm)) {
      event.preventDefault?.();
      void submitPassword(candidate, event.target);
    }
  }

  function handleInput(event) {
    const candidate = activation;
    const form = query(candidate, ACCOUNT_SELECTORS.passwordForm);
    if (form && event.target === formControl(form, "confirmPassword")) {
      event.target.setCustomValidity?.("");
    }
  }

  function closest(candidate, event, selector) {
    if (!active(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    return element && (
      typeof candidate.root.contains !== "function" || candidate.root.contains(element)
    ) ? element : null;
  }

  function handleClick(event) {
    const candidate = activation;
    const retry = closest(candidate, event, ACCOUNT_SELECTORS.retryRoles);
    const save = closest(candidate, event, ACCOUNT_SELECTORS.roleSave);
    const logout = closest(candidate, event, ACCOUNT_SELECTORS.logout);
    if (!retry && !save && !logout) return;
    event.preventDefault?.();
    if (retry) void load(candidate);
    else if (save) void changeRole(candidate, save);
    else void auth.logout();
  }

  const listeners = Object.freeze({
    submit: handleSubmit,
    input: handleInput,
    click: handleClick
  });

  function detach(candidate) {
    if (activation !== candidate) return false;
    activation = null;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [type, listener] of Object.entries(listeners)) {
      candidate.root.removeEventListener(type, listener);
    }
    return true;
  }

  function mount({ root, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Account feature mount requires a root event target");
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
    identityKey = "";
    renderIdentity(candidate, { force: true });
    renderRoles(candidate);
    void load(candidate);
    return dispose;
  }

  function render() {
    const candidate = activation;
    if (!active(candidate)) return false;
    const identityRendered = renderIdentity(candidate);
    return renderRoles(candidate) || identityRendered;
  }

  function unmount() {
    return activation ? detach(activation) : false;
  }

  function resetSession() {
    unmount();
    session = {};
    loadSerial += 1;
    users = [];
    loadState = "idle";
    roleStatus = "";
    identityKey = "";
    for (const root of roots) {
      for (const selector of [
        ACCOUNT_SELECTORS.currentName,
        ACCOUNT_SELECTORS.pageName,
        ACCOUNT_SELECTORS.username,
        ACCOUNT_SELECTORS.usernameStatus,
        ACCOUNT_SELECTORS.recordTimezone,
        ACCOUNT_SELECTORS.recordTimezoneStatus,
        ACCOUNT_SELECTORS.passwordStatus,
        ACCOUNT_SELECTORS.roleList,
        ACCOUNT_SELECTORS.roleStatus
      ]) {
        const element = root.querySelector?.(selector);
        if (!element) continue;
        if (selector === ACCOUNT_SELECTORS.username) element.value = "";
        else if (selector === ACCOUNT_SELECTORS.roleList) element.innerHTML = "";
        else element.textContent = "";
      }
      for (const selector of [
        ACCOUNT_SELECTORS.usernameForm,
        ACCOUNT_SELECTORS.recordTimezoneForm,
        ACCOUNT_SELECTORS.passwordForm
      ]) {
        const form = root.querySelector?.(selector);
        form?.reset?.();
        const button = form?.querySelector?.('[type="submit"]');
        if (button) button.disabled = false;
      }
    }
    roots.clear();
  }

  return Object.freeze({
    mount,
    render,
    load,
    unmount,
    resetSession
  });
}
