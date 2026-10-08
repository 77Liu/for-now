import { OPENING_DEFAULTS, RAIN_LIMITS, openingPreferences, openingEtag } from "../../shared/opening/index.mjs";

export function createOpeningPreferencesController({ request, currentUser, hasCapability,
  storage = globalThis.sessionStorage } = {}) {
  let activation = null, generation = 0, cachedOwner = "";
  const roots = new Map();
  const busy = (ticket, value) => { for (const control of Array.from(ticket.form.elements)) control.disabled = value; };
  const key = owner => `cike:opening-draft:${owner}`;
  const ownerId = () => String(currentUser.get()?.id || "");
  const allowed = () => currentUser.get()?.role === "owner" && hasCapability("ai-configuration");
  const current = ticket => activation === ticket && ticket.generation === generation
    && ticket.owner === ownerId() && allowed() && !ticket.signal?.aborted;
  const status = (ticket, message) => {
    if (current(ticket)) ticket.statusElement.textContent = message;
  };
  const clearDraft = owner => { try { if (owner) storage?.removeItem(key(owner)); } catch {} };
  const readDraft = owner => {
    try { const value = JSON.parse(storage?.getItem(key(owner)) || "null");
      return value?.draft === true ? openingPreferences(value) : null;
    } catch { return null; }
  };
  function render(ticket, value) {
    for (const name of ["enabled", "showBrand"]) ticket.form.elements[name].checked = value[name];
    ticket.form.elements.protectBrand.checked = value.config.protectBrand;
    for (const name of Object.keys(RAIN_LIMITS)) ticket.form.elements[name].value = value.config[name];
    ticket.value = value;
  }
  function capture(ticket) {
    return openingPreferences({ revision: ticket.value.revision,
      enabled: ticket.form.elements.enabled.checked, showBrand: ticket.form.elements.showBrand.checked,
      config: { ...Object.fromEntries(Object.keys(RAIN_LIMITS).map(name => [name, ticket.form.elements[name].value])),
        protectBrand: ticket.form.elements.protectBrand.checked } });
  }
  function remember(ticket) {
    ticket.value = capture(ticket); ticket.dirty = true;
    try { storage?.setItem(key(ticket.owner), JSON.stringify({ ...ticket.value, draft: true })); } catch {}
  }
  async function load(ticket, preserveDraft = false) {
    if (!current(ticket) || ticket.pending) return false;
    ticket.pending = true; busy(ticket, true); status(ticket, "正在读取开场设置…");
    try {
      const value = openingPreferences(await request.json("/api/opening-preferences", { signal: ticket.signal }));
      if (!current(ticket)) return false;
      // An explicit reload adopts the latest revision while retaining the user's draft.
      const draft = ticket.dirty ? capture(ticket) : readDraft(ticket.owner);
      const next = draft ? { ...draft, revision: preserveDraft ? value.revision : draft.revision } : value;
      render(ticket, next); ticket.loaded = true; ticket.dirty = Boolean(draft);
      if (draft) {
        remember(ticket);
        status(ticket, next.revision !== value.revision
          ? "已恢复草稿；设置已在别处更新。请读取最新版本后再保存。"
          : "草稿已恢复，保存后生效。");
      } else status(ticket, "设置已加载，修改后保存。");
      return true;
    } catch (error) {
      if (current(ticket)) {
        // Defaults remain active; draft content is never applied to the opening before saving.
        status(ticket, error?.message || "读取失败，开场继续使用默认设置；草稿已保留。");
      }
      return false;
    } finally { if (current(ticket)) { ticket.pending = false; busy(ticket, false); } }
  }
  async function save(ticket) {
    if (!current(ticket) || ticket.pending || !ticket.loaded) return false;
    remember(ticket); const input = capture(ticket);
    ticket.pending = true; busy(ticket, true);
    status(ticket, "正在保存开场设置…");
    try {
      const value = await request.json("/api/opening-preferences", {
        method: "PUT", body: JSON.stringify(input), signal: ticket.signal,
        headers: { "if-match": openingEtag(input) }
      });
      if (!current(ticket)) return false;
      render(ticket, openingPreferences(value)); ticket.dirty = false; clearDraft(ticket.owner);
      status(ticket, "开场设置已保存，下次打开时生效。"); return true;
    } catch (error) {
      status(ticket, error?.status === 409
        ? "设置已在别处更新，草稿已保留。请读取最新版本后再保存。"
        : (error?.message || "保存失败，草稿已保留。"));
      return false;
    } finally {
      if (current(ticket)) { ticket.pending = false; busy(ticket, false); }
    }
  }
  function unmount() {
    const ticket = activation;
    if (!ticket) return false;
    activation = null; generation += 1;
    for (const [type, listener] of Object.entries(ticket.listeners)) ticket.root.removeEventListener(type, listener);
    ticket.parentSignal?.removeEventListener("abort", ticket.dispose);
    ticket.abort.abort(); busy(ticket, false);
    return true;
  }
  function mount({ root, signal } = {}) {
    unmount();
    const form = root?.querySelector("#opening-preferences-form");
    if (!form || !allowed() || signal?.aborted) return () => false;
    const owner = ownerId();
    if (cachedOwner && cachedOwner !== owner) clearDraft(cachedOwner);
    cachedOwner = owner;
    const abort = new AbortController();
    const ticket = { root, form, owner, statusElement: root.querySelector("#opening-preferences-status"), generation: ++generation, signal: abort.signal,
      parentSignal: signal, abort, loaded: false, dirty: false, pending: false, value: openingPreferences() };
    activation = ticket; roots.set(root, ticket); render(ticket, openingPreferences());
    const draft = readDraft(owner); if (draft) { render(ticket, draft); ticket.dirty = true; }
    ticket.listeners = {
      input(event) { if (current(ticket) && !ticket.pending && form.contains(event.target)) remember(ticket); },
      submit(event) { if (event.target !== form) return; event.preventDefault(); void save(ticket); },
      click(event) {
        const button = event.target.closest?.("[data-opening-action]");
        if (!button || !form.contains(button) || !current(ticket) || ticket.pending) return;
        event.preventDefault();
        if (button.dataset.openingAction === "reload") void load(ticket, true);
        if (button.dataset.openingAction === "reset") {
          render(ticket, { ...OPENING_DEFAULTS, revision: ticket.value.revision }); remember(ticket);
          status(ticket, "已恢复默认，保存后生效。");
        }
      }
    };
    ticket.dispose = () => { if (activation === ticket) unmount(); };
    for (const [type, listener] of Object.entries(ticket.listeners)) root.addEventListener(type, listener);
    signal?.addEventListener("abort", ticket.dispose, { once: true });
    void load(ticket); return ticket.dispose;
  }
  return Object.freeze({ mount, unmount, resetSession() {
    unmount(); clearDraft(cachedOwner); cachedOwner = "";
    for (const old of roots.values()) { render(old, openingPreferences()); old.statusElement.textContent = ""; busy(old, false); }
    roots.clear();
  } });
}
