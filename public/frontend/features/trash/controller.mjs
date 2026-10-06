import { createTrashModel } from "./model.mjs";
import { createTrashPresentation } from "./presentation.mjs";

export const TRASH_SELECTORS = Object.freeze({
  list: "#trash-list",
  status: "#trash-status",
  retention: "#trash-retention",
  purge: "#trash-purge-selected",
  select: "[data-trash-select]",
  restore: "[data-trash-restore]",
  retry: '[data-content-action="retry-trash"]'
});

export const TRASH_RESTORE_DOMAINS = Object.freeze([
  "dailyRecords",
  "captures",
  "journals",
  "thoughts",
  "checkins",
  "chat",
  "review",
  "books",
  "keepsakes",
  "quotes"
]);

export const TRASH_PURGE_CONFIRMATION = "永久删除";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Trash feature ${group} requires ${name}`);
    }
  }
}

export function createTrashFeatureController({
  data = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    request: data.request,
    refresh: data.refresh
  });
  requireFunctions("view port", {
    formatDate: view.formatDate,
    contentState: view.contentState,
    escapeMarkup: view.escapeMarkup,
    plainPreview: view.plainPreview,
    renderMarkdown: view.renderMarkdown,
    renderLatex: view.renderLatex,
    showToast: view.showToast
  });
  requireFunctions("platform port", {
    confirm: platform.confirm,
    prompt: platform.prompt
  });

  const model = createTrashModel();
  const presentation = createTrashPresentation(view);
  const roots = new Set();
  let activation = null;
  let generation = 0;
  let session = {};
  let pendingPurge = null;

  const accountId = () => String(data.getAccountId() || "");
  const sessionSerial = () => data.getSessionSerial();
  const isActive = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.session === session
    && candidate.generation === generation
    && candidate.accountId === accountId()
    && candidate.sessionSerial === sessionSerial()
    && !candidate.signal?.aborted
  );
  const capture = candidate => ({
    activation: candidate,
    session,
    generation,
    accountId: accountId(),
    sessionSerial: sessionSerial()
  });
  const isCurrent = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.generation === generation
    && ticket.accountId === accountId()
    && ticket.sessionSerial === sessionSerial()
    && isActive(ticket.activation)
  );
  const queryRoot = (root, selector) => root?.querySelector?.(selector) || null;
  const query = (candidate, selector) => (
    isActive(candidate) ? queryRoot(candidate.root, selector) : null
  );

  function setStatus(candidate, message) {
    const status = query(candidate, TRASH_SELECTORS.status);
    if (status) status.textContent = String(message ?? "");
  }

  function syncPurgeControl(candidate) {
    const button = query(candidate, TRASH_SELECTORS.purge);
    if (button) button.disabled = Boolean(pendingPurge) || !model.hasSelection();
  }

  function paint(candidate) {
    if (!isActive(candidate)) return false;
    const retention = query(candidate, TRASH_SELECTORS.retention);
    const list = query(candidate, TRASH_SELECTORS.list);
    if (retention) retention.textContent = "默认保留 30 天";
    if (!list) {
      syncPurgeControl(candidate);
      return false;
    }
    list.innerHTML = presentation.list(model.snapshot());
    Promise.resolve(presentation.enhance(list)).catch(() => {});
    syncPurgeControl(candidate);
    return true;
  }

  function paintFailure(candidate) {
    if (!isActive(candidate)) return false;
    const list = query(candidate, TRASH_SELECTORS.list);
    if (list) list.innerHTML = presentation.failure();
    syncPurgeControl(candidate);
    return Boolean(list);
  }

  function scrubRoot(root) {
    const list = queryRoot(root, TRASH_SELECTORS.list);
    const status = queryRoot(root, TRASH_SELECTORS.status);
    const retention = queryRoot(root, TRASH_SELECTORS.retention);
    const purge = queryRoot(root, TRASH_SELECTORS.purge);
    if (list) list.innerHTML = "";
    if (status) status.textContent = "";
    if (retention) retention.textContent = "保留 30 天";
    if (purge) purge.disabled = true;
  }

  async function loadCandidate(candidate, { force = false } = {}) {
    if (!isActive(candidate)) return false;
    if (candidate.loadPromise && !force) return candidate.loadPromise;
    const ticket = {
      ...capture(candidate),
      serial: ++candidate.loadSerial
    };
    setStatus(candidate, "正在读取回收站…");
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await data.request("/api/trash");
        if (!isCurrent(ticket) || ticket.serial !== candidate.loadSerial) return false;
        model.replaceItems(result?.items);
        paint(candidate);
        setStatus(candidate, "");
        return true;
      } catch {
        if (!isCurrent(ticket) || ticket.serial !== candidate.loadSerial) return false;
        model.clear();
        setStatus(candidate, "");
        paintFailure(candidate);
        return false;
      }
    });
    candidate.loadPromise = operation;
    return operation.finally(() => {
      if (candidate.loadPromise === operation) candidate.loadPromise = null;
    });
  }

  function closest(candidate, event, selector) {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    return typeof candidate.root.contains !== "function"
      || candidate.root.contains(element) ? element : null;
  }

  async function restore(candidate, button) {
    const id = String(button?.dataset?.trashRestore || "");
    if (
      !isActive(candidate)
      || !id
      || !model.has(id)
      || candidate.restoring.has(id)
    ) return false;
    const ticket = capture(candidate);
    candidate.restoring.add(id);
    button.disabled = true;
    setStatus(candidate, "正在恢复…");
    try {
      await data.request(`/api/trash/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        body: "{}"
      });
      if (!isCurrent(ticket)) return false;
      await data.refresh(TRASH_RESTORE_DOMAINS);
      if (!isCurrent(ticket)) return false;
      await loadCandidate(candidate, { force: true });
      if (!isCurrent(ticket)) return false;
      view.showToast("记录已完整恢复");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      setStatus(candidate, error?.message || "恢复失败，请稍后重试");
      if (button.isConnected !== false) button.disabled = false;
      return false;
    } finally {
      if (ticket.session === session && ticket.generation === generation) {
        candidate.restoring.delete(id);
      }
    }
  }

  async function purge(candidate, button) {
    if (!isActive(candidate) || pendingPurge) return false;
    const ids = [...model.snapshot().selectedIds];
    if (!ids.length) return false;
    const ticket = capture(candidate);
    pendingPurge = ticket;
    button.disabled = true;
    setStatus(candidate, "正在生成永久清理清单…");
    try {
      const plan = await data.request("/api/trash/purge-preview", {
        method: "POST",
        body: JSON.stringify({ ids })
      });
      if (!isCurrent(ticket)) return false;
      const count = Array.isArray(plan?.items) ? plan.items.length : 0;
      const confirmation = platform.prompt(
        `将永久清理 ${count} 条记录，且无法恢复。请输入“${TRASH_PURGE_CONFIRMATION}”继续：`
      );
      if (!isCurrent(ticket)) return false;
      if (confirmation !== TRASH_PURGE_CONFIRMATION) {
        setStatus(candidate, "已取消永久清理。");
        return false;
      }
      const result = await data.request("/api/trash/purge", {
        method: "POST",
        body: JSON.stringify({
          ids,
          planHash: plan?.planHash,
          confirmation
        })
      });
      if (!isCurrent(ticket)) return false;
      await loadCandidate(candidate, { force: true });
      if (!isCurrent(ticket)) return false;
      view.showToast(`已永久清理 ${result?.purged} 条记录`);
      return true;
    } catch (error) {
      if (isCurrent(ticket)) {
        setStatus(candidate, error?.message || "永久清理失败，请稍后重试");
      }
      return false;
    } finally {
      if (pendingPurge === ticket) pendingPurge = null;
      if (isActive(candidate)) syncPurgeControl(candidate);
    }
  }

  function handleClick(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const retry = closest(candidate, event, TRASH_SELECTORS.retry);
    const restoreButton = closest(candidate, event, TRASH_SELECTORS.restore);
    const purgeButton = closest(candidate, event, TRASH_SELECTORS.purge);
    if (!retry && !restoreButton && !purgeButton) return;
    event.preventDefault?.();
    if (retry) void loadCandidate(candidate, { force: true });
    else if (restoreButton) void restore(candidate, restoreButton);
    else void purge(candidate, purgeButton);
  }

  function handleChange(event) {
    const candidate = activation;
    const input = closest(candidate, event, TRASH_SELECTORS.select);
    if (!input) return;
    model.select(input.value, input.checked === true);
    syncPurgeControl(candidate);
  }

  function detach(candidate) {
    if (!candidate || activation !== candidate) return false;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    candidate.root.removeEventListener("click", handleClick);
    candidate.root.removeEventListener("change", handleChange);
    activation = null;
    generation += 1;
    pendingPurge = null;
    model.clear();
    scrubRoot(candidate.root);
    return true;
  }

  function unmount() {
    return activation ? detach(activation) : false;
  }

  function mount({ root, route, signal } = {}) {
    unmount();
    if (
      !root
      || !["querySelector", "addEventListener", "removeEventListener"]
        .every(name => typeof root[name] === "function")
    ) {
      throw new TypeError("Trash feature mount requires a root event target");
    }
    if (signal?.aborted) return () => false;
    const candidate = {
      root,
      route,
      signal,
      session,
      generation: ++generation,
      accountId: accountId(),
      sessionSerial: sessionSerial(),
      loadSerial: 0,
      loadPromise: null,
      restoring: new Set(),
      dispose: null
    };
    let disposed = false;
    candidate.dispose = () => {
      if (disposed) return false;
      disposed = true;
      return detach(candidate);
    };
    activation = candidate;
    roots.add(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("change", handleChange);
    signal?.addEventListener?.("abort", candidate.dispose, { once: true });
    model.clear();
    syncPurgeControl(candidate);
    void loadCandidate(candidate);
    return candidate.dispose;
  }

  function render({ changedDomains } = {}) {
    const candidate = activation;
    if (!isActive(candidate)) return false;
    if (changedDomains != null) {
      const domains = new Set(
        typeof changedDomains === "string" ? [changedDomains] : changedDomains
      );
      if (domains.has("trash") || domains.has("trashCount")) {
        void loadCandidate(candidate, { force: true });
        return true;
      }
      return false;
    }
    return paint(candidate);
  }

  function resetSession() {
    unmount();
    session = {};
    generation += 1;
    pendingPurge = null;
    model.clear();
    for (const root of roots) scrubRoot(root);
    roots.clear();
  }

  return Object.freeze({
    mount,
    render,
    unmount,
    resetSession,
    load: () => activation ? loadCandidate(activation, { force: true }) : Promise.resolve(false)
  });
}
