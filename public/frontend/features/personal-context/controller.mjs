import { openContextSource } from "./navigation.mjs";
import {
  PERSONAL_CONTEXT_SELECTORS,
  renderPersonalContextSurface,
  scrubPersonalContextSurface
} from "./presentation.mjs";

export const PERSONAL_CONTEXT_ENDPOINT = "/api/v1/personal-context";
export const EVIDENCE_PERMISSIONS_ENDPOINT = "/api/v1/user-model/evidence-permissions";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Personal context feature ${group} requires ${name}`);
    }
  }
}

export function createPersonalContextFeatureController({
  data = {},
  navigation = {},
  view = {},
  platform = {}
} = {}) {
  // A cached app shell can pair this controller with an older descriptor. Keep
  // the overview readable, but decline destructive actions without confirmation.
  const confirm = typeof platform.confirm === "function" ? platform.confirm : () => false;
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    requestV1: data.requestV1
  });
  requireFunctions("navigation port", {
    activateDate: navigation.activateDate,
    switchView: navigation.switchView,
    openThoughtDetail: navigation.openThoughtDetail
  });
  requireFunctions("view port", {
    contentState: view.contentState,
    escapeMarkup: view.escapeMarkup,
    plainPreview: view.plainPreview,
    formatDate: view.formatDate
  });
  requireFunctions("platform port", {
    requestFrame: platform.requestFrame,
    queryDestination: platform.queryDestination,
    escapeSelector: platform.escapeSelector,
    isDetailsElement: platform.isDetailsElement,
    createRequestId: platform.createRequestId
  });

  let activation = null;
  let generation = 0;
  let session = {};
  let requestSerial = 0;
  let contextData = null;
  let loadState = "idle";
  let latestSnapshot = null;
  let synthesisRequestId = "";
  const writes = new Map();
  const claimDrafts = new Map();
  const sessionRoots = new Set();

  const isCurrent = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.generation === generation
    && candidate.session === session
  );
  const isActive = candidate => Boolean(
    isCurrent(candidate)
    && !candidate.signal?.aborted
  );
  const currentSnapshot = () => latestSnapshot || data.getSnapshot() || {};
  const query = (candidate, selector) => (
    isActive(candidate) ? candidate.root.querySelector(selector) : null
  );

  const rememberClaimDraft = form => {
    const id = form?.dataset?.claimForm;
    if (!id) return;
    claimDrafts.set(id, {
      statement: form.elements?.statement?.value || "",
      scope: form.elements?.scope?.value || "",
      epistemic: form.elements?.epistemic?.value || "hypothesis",
      contextAllowed: form.elements?.contextAllowed?.checked !== false
    });
  };
  const restoreClaimDrafts = root => {
    for (const form of root?.querySelectorAll?.(PERSONAL_CONTEXT_SELECTORS.claimForm) || []) {
      const draft = claimDrafts.get(form.dataset?.claimForm);
      if (!draft) continue;
      if (form.elements?.statement) form.elements.statement.value = draft.statement;
      if (form.elements?.scope) form.elements.scope.value = draft.scope;
      if (form.elements?.epistemic) form.elements.epistemic.value = draft.epistemic;
      if (form.elements?.contextAllowed) {
        form.elements.contextAllowed.checked = draft.contextAllowed;
      }
    }
  };

  const paint = candidate => {
    if (!isActive(candidate)) return false;
    const rendered = renderPersonalContextSurface({
      root: candidate.root,
      data: contextData,
      loadState,
      snapshot: currentSnapshot(),
      contentState: view.contentState,
      escapeMarkup: view.escapeMarkup,
      plainPreview: view.plainPreview,
      formatDate: view.formatDate
    });
    restoreClaimDrafts(candidate.root);
    return rendered;
  };

  const currentRequest = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.accountId === String(data.getAccountId() || "")
    && ticket.sessionSerial === data.getSessionSerial()
    && ticket.generation === generation
    && ticket.requestSerial === requestSerial
    && isActive(ticket.activation)
  );

  const load = async candidate => {
    if (!isActive(candidate)) return false;
    const ticket = {
      activation: candidate,
      session,
      accountId: String(data.getAccountId() || ""),
      sessionSerial: data.getSessionSerial(),
      generation,
      requestSerial: ++requestSerial
    };
    loadState = "loading";
    const status = query(candidate, PERSONAL_CONTEXT_SELECTORS.status);
    if (status) status.textContent = "正在核对当前记录与来源…";
    paint(candidate);
    try {
      const response = await data.requestV1(PERSONAL_CONTEXT_ENDPOINT, {
        signal: candidate.signal
      });
      if (!currentRequest(ticket)) return false;
      const next = { ...(response?.data || {}) };
      if (!Array.isArray(next.sourcePermissions)) {
        const permissions = await data.requestV1(
          `${EVIDENCE_PERMISSIONS_ENDPOINT}?limit=50`,
          { signal: candidate.signal }
        );
        if (!currentRequest(ticket)) return false;
        next.sourcePermissions = Array.isArray(permissions?.data) ? permissions.data : [];
        next.sourcePermissionNextCursor = permissions?.meta?.nextCursor || "";
        next.sourcePermissionTotal = Number(permissions?.meta?.total) || next.sourcePermissions.length;
      }
      contextData = next;
      loadState = "ready";
      paint(candidate);
      return true;
    } catch {
      if (!currentRequest(ticket)) return false;
      contextData = null;
      loadState = "failure";
      const currentStatus = query(candidate, PERSONAL_CONTEXT_SELECTORS.status);
      if (currentStatus) currentStatus.textContent = "";
      paint(candidate);
      return false;
    }
  };

  const closestWithin = (candidate, event, selector) => {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    if (
      typeof candidate.root.contains === "function"
      && !candidate.root.contains(element)
    ) {
      return null;
    }
    return element;
  };

  const claimById = id => (
    contextData?.userModel?.claims?.find?.(claim => claim.id === id) || null
  );

  const setCardBusy = (card, busy) => {
    if (!card) return;
    card.setAttribute?.("aria-busy", String(busy));
    for (const control of card.querySelectorAll?.("button,input,select,textarea") || []) {
      control.disabled = busy;
    }
  };

  async function runClaimAction(candidate, button, form = button?.form) {
    const card = button?.closest?.("[data-claim-id]")
      || form?.closest?.("[data-claim-id]");
    const claimId = card?.dataset?.claimId || "";
    const claim = claimById(claimId);
    const action = button?.dataset?.claimAction || form?.dataset?.claimPrimaryAction || "";
    const key = `claim:${claimId}`;
    if (!claim || writes.has(key)) return false;
    if (["reject", "retract"].includes(action)
      && !confirm(action === "reject"
        ? "不用这条理解？"
        : "撤回后，这条理解不会再用于后续回答。仍要撤回？")) {
      return false;
    }
    const status = card.querySelector?.("[data-claim-status]");
    const payload = ["confirm", "revise"].includes(action)
      ? {
          action,
          statement: form?.elements?.statement
            ? form.elements.statement.value
            : claim.statement,
          scope: form?.elements?.scope?.value || "",
          epistemic: form?.elements?.epistemic?.value || claim.epistemic,
          contextAllowed: form?.elements?.contextAllowed?.checked !== false
        }
      : { action };
    const pending = (async () => {
      setCardBusy(card, true);
      if (status) status.textContent = "正在保存…";
      try {
        await data.requestV1(
          `/api/v1/user-model/claims/${encodeURIComponent(claimId)}`,
          {
            method: "PATCH",
            headers: {
              "if-match": `"${Number(button?.dataset?.version || card?.dataset?.claimVersion) || claim.version}"`
            },
            body: JSON.stringify(payload),
            signal: candidate.signal
          },
          { domains: ["userClaims"] }
        );
        if (!isActive(candidate)) return false;
        if (status) status.textContent = action === "retract" || action === "reject"
          ? "已停止使用"
          : "已保存";
        claimDrafts.delete(claimId);
        await load(candidate);
        return true;
      } catch (error) {
        if (!isActive(candidate)) return false;
        if (status) {
          status.dataset.state = "error";
          status.textContent = error?.code === "PRECONDITION_FAILED"
            ? "这条理解已在其他会话更新，请保留当前输入并重新核对。"
            : error?.code === "CLAIM_SOURCE_STALE"
              ? "对应原文已变化，这条理解已停止使用。"
              : `保存失败：${error?.message || "请稍后重试"}`;
        }
        if (["PRECONDITION_FAILED", "CLAIM_SOURCE_STALE"].includes(error?.code)) {
          await load(candidate);
          const currentStatus = candidate.root.querySelector?.(
            `[data-claim-id="${platform.escapeSelector(claimId)}"] [data-claim-status]`
          );
          if (isActive(candidate) && currentStatus) {
            currentStatus.dataset.state = "error";
            currentStatus.textContent = error.code === "PRECONDITION_FAILED"
              ? "这条理解已在其他会话更新；当前输入仍保留。"
              : "对应原文已变化，这条理解已停止使用。";
          }
        }
        return false;
      } finally {
        if (isActive(candidate)) setCardBusy(card, false);
      }
    })();
    writes.set(key, pending);
    pending.finally(() => {
      if (writes.get(key) === pending) writes.delete(key);
    }).catch(noop);
    return pending;
  }

  async function updatePermission(candidate, input) {
    const card = input?.closest?.("[data-permission-index]");
    const index = Number(card?.dataset?.permissionIndex);
    const permission = contextData?.sourcePermissions?.[index];
    const key = `permission:${permission?.sourceKey || ""}`;
    if (!permission || !Number.isInteger(index) || writes.has(key)) return false;
    const status = card.querySelector?.("[data-permission-status]");
    const contextInput = card.querySelector?.('[data-permission-field="contextAllowed"]');
    const learningInput = card.querySelector?.('[data-permission-field="learningAllowed"]');
    const previous = {
      contextAllowed: permission.contextAllowed === true,
      learningAllowed: permission.learningAllowed === true
    };
    const pending = (async () => {
      setCardBusy(card, true);
      if (status) status.textContent = "正在更新许可…";
      try {
        const response = await data.requestV1(
          "/api/v1/user-model/evidence-permissions",
          {
            method: "PATCH",
            headers: { "if-match": `"${permission.revision}"` },
            body: JSON.stringify({
              sourceRef: permission.sourceRef,
              contextAllowed: contextInput?.checked === true,
              learningAllowed: learningInput?.checked === true
            }),
            signal: candidate.signal
          }
        );
        if (!isActive(candidate)) return false;
        if (status) {
          status.textContent = response?.data?.learningRefreshQueued
            ? "许可已更新，正在按新许可整理"
            : "许可已更新";
        }
        await load(candidate);
        return true;
      } catch (error) {
        if (!isActive(candidate)) return false;
        if (contextInput) contextInput.checked = previous.contextAllowed;
        if (learningInput) learningInput.checked = previous.learningAllowed;
        if (error?.code === "PRECONDITION_FAILED") {
          await load(candidate);
          const currentStatus = candidate.root.querySelector?.(
            `[data-permission-index="${index}"] [data-permission-status]`
          );
          if (isActive(candidate) && currentStatus) {
            currentStatus.dataset.state = "error";
            currentStatus.textContent = "许可已在其他会话更新，已显示服务端状态。";
          }
          return false;
        }
        if (status) {
          status.dataset.state = "error";
          status.textContent = `许可更新失败：${error?.message || "请稍后重试"}`;
        }
        return false;
      } finally {
        if (isActive(candidate)) setCardBusy(card, false);
      }
    })();
    writes.set(key, pending);
    pending.finally(() => {
      if (writes.get(key) === pending) writes.delete(key);
    }).catch(noop);
    return pending;
  }

  async function loadMorePermissions(candidate, button) {
    const cursor = contextData?.sourcePermissionNextCursor;
    const key = "permission:list-more";
    if (!cursor || writes.has(key)) return false;
    const pending = (async () => {
      button.disabled = true;
      try {
        const response = await data.requestV1(
          `${EVIDENCE_PERMISSIONS_ENDPOINT}?limit=50&cursor=${encodeURIComponent(cursor)}`,
          { signal: candidate.signal }
        );
        if (!isActive(candidate)) return false;
        const known = new Set(contextData.sourcePermissions.map(item => item.sourceKey));
        contextData.sourcePermissions.push(
          ...(Array.isArray(response?.data) ? response.data : [])
            .filter(item => !known.has(item.sourceKey))
        );
        contextData.sourcePermissionNextCursor = response?.meta?.nextCursor || "";
        contextData.sourcePermissionTotal = Number(response?.meta?.total)
          || contextData.sourcePermissions.length;
        paint(candidate);
        return true;
      } catch (error) {
        if (!isActive(candidate)) return false;
        const status = query(candidate, PERSONAL_CONTEXT_SELECTORS.status);
        if (status) status.textContent = `来源许可加载失败：${error?.message || "请稍后重试"}`;
        return false;
      } finally {
        if (isActive(candidate)) button.disabled = false;
      }
    })();
    writes.set(key, pending);
    pending.finally(() => {
      if (writes.get(key) === pending) writes.delete(key);
    }).catch(noop);
    return pending;
  }

  async function runSynthesis(candidate, button) {
    const key = "synthesis:create";
    if (writes.has(key)) return writes.get(key);
    const status = query(candidate, PERSONAL_CONTEXT_SELECTORS.synthesisStatus);
    synthesisRequestId ||= String(platform.createRequestId() || "");
    if (!synthesisRequestId) throw new TypeError("无法创建周期回望请求标识");
    const pending = (async () => {
      button.disabled = true;
      if (status) status.textContent = "正在生成周期回望…";
      try {
        await data.requestV1(
          "/api/v1/analyses",
          {
            method: "POST",
            headers: { "idempotency-key": synthesisRequestId },
            body: "{}",
            signal: candidate.signal
          },
          { domains: ["analyses"] }
        );
        if (!isActive(candidate)) return false;
        if (status) status.textContent = "回望已生成，请核对后确认";
        const loaded = await load(candidate);
        if (loaded) synthesisRequestId = "";
        return loaded;
      } catch (error) {
        if (!isActive(candidate)) return false;
        if (status) {
          status.dataset.state = "error";
          status.textContent = `生成失败：${error?.message || "请稍后重试"}`;
        }
        return false;
      } finally {
        if (isActive(candidate)) button.disabled = false;
      }
    })();
    writes.set(key, pending);
    pending.finally(() => {
      if (writes.get(key) === pending) writes.delete(key);
    }).catch(noop);
    return pending;
  }

  async function reviewSynthesis(candidate, button) {
    const id = button?.dataset?.synthesisId || "";
    const action = button?.dataset?.synthesisAction || "";
    const item = contextData?.periodicSyntheses?.find?.(value => value.id === id);
    const key = `synthesis:${id}`;
    if (!item || !["confirm", "reject"].includes(action) || writes.has(key)) return false;
    if (action === "reject" && !confirm("拒绝这份回望？它不会成为长期理解。")) {
      return false;
    }
    const card = button.closest?.("[data-synthesis-id]");
    const status = card?.querySelector?.("[data-synthesis-item-status]");
    const pending = (async () => {
      setCardBusy(card, true);
      if (status) status.textContent = "正在保存…";
      try {
        await data.requestV1(
          `/api/v1/analyses/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${Number(button.dataset.version) || item.version}"` },
            body: JSON.stringify({ decision: action }),
            signal: candidate.signal
          },
          { domains: ["analyses"] }
        );
        if (!isActive(candidate)) return false;
        await load(candidate);
        return true;
      } catch (error) {
        if (!isActive(candidate)) return false;
        if (error?.code === "PRECONDITION_FAILED") {
          await load(candidate);
          const currentStatus = candidate.root.querySelector?.(
            `[data-synthesis-id="${platform.escapeSelector(id)}"] [data-synthesis-item-status]`
          );
          if (isActive(candidate) && currentStatus) {
            currentStatus.dataset.state = "error";
            currentStatus.textContent = "这份回望已在其他会话处理，已显示最新状态。";
          }
          return false;
        }
        if (status) {
          status.dataset.state = "error";
          status.textContent = `保存失败：${error?.message || "请稍后重试"}`;
        }
        return false;
      } finally {
        if (isActive(candidate)) setCardBusy(card, false);
      }
    })();
    writes.set(key, pending);
    pending.finally(() => {
      if (writes.get(key) === pending) writes.delete(key);
    }).catch(noop);
    return pending;
  }

  const handleClick = event => {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const retry = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.retry
    );
    if (retry) {
      event.preventDefault?.();
      void load(candidate);
      return;
    }
    const claimAction = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.claimAction
    );
    if (claimAction) {
      if (claimAction.type === "submit") return;
      event.preventDefault?.();
      void runClaimAction(candidate, claimAction);
      return;
    }
    const run = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.runSynthesis
    );
    if (run) {
      event.preventDefault?.();
      void runSynthesis(candidate, run);
      return;
    }
    const permissionsMore = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.permissionsMore
    );
    if (permissionsMore) {
      event.preventDefault?.();
      void loadMorePermissions(candidate, permissionsMore);
      return;
    }
    const synthesisAction = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.synthesisAction
    );
    if (synthesisAction) {
      event.preventDefault?.();
      void reviewSynthesis(candidate, synthesisAction);
      return;
    }
    const source = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.source
    );
    if (!source) return;
    event.preventDefault?.();
    openContextSource(source, {
      activateDate: navigation.activateDate,
      switchView: navigation.switchView,
      openThoughtDetail: navigation.openThoughtDetail,
      requestFrame: platform.requestFrame,
      queryDestination: platform.queryDestination,
      escapeSelector: platform.escapeSelector,
      isDetailsElement: platform.isDetailsElement
    });
  };

  const handleSubmit = event => {
    const candidate = activation;
    const form = closestWithin(candidate, event, PERSONAL_CONTEXT_SELECTORS.claimForm);
    if (!form) return;
    event.preventDefault?.();
    if (form.reportValidity?.() === false) return;
    rememberClaimDraft(form);
    void runClaimAction(candidate, event.submitter, form);
  };

  const handleChange = event => {
    const candidate = activation;
    const input = closestWithin(
      candidate,
      event,
      PERSONAL_CONTEXT_SELECTORS.permissionToggle
    );
    if (input) {
      void updatePermission(candidate, input);
      return;
    }
    rememberClaimDraft(event?.target?.closest?.(PERSONAL_CONTEXT_SELECTORS.claimForm));
  };

  const handleInput = event => {
    const candidate = activation;
    if (!isActive(candidate)) return;
    rememberClaimDraft(event?.target?.closest?.(PERSONAL_CONTEXT_SELECTORS.claimForm));
  };

  const detach = candidate => {
    if (!isCurrent(candidate)) return false;
    activation = null;
    generation += 1;
    candidate.root.removeEventListener("click", handleClick);
    candidate.root.removeEventListener("submit", handleSubmit);
    candidate.root.removeEventListener("change", handleChange);
    candidate.root.removeEventListener("input", handleInput);
    candidate.unlink();
    return true;
  };

  const unmount = () => activation ? detach(activation) : false;

  const mount = ({ root, route, signal } = {}) => {
    unmount();
    if (
      !root
      || !["querySelector", "addEventListener", "removeEventListener"]
        .every(name => typeof root[name] === "function")
    ) {
      throw new TypeError("Personal context feature mount requires a root event target");
    }
    if (signal?.aborted) return () => false;

    const candidate = {
      root,
      route,
      signal,
      session,
      generation: ++generation,
      unlink: noop
    };
    const abort = () => {
      if (activation === candidate) detach(candidate);
    };
    if (signal?.addEventListener) {
      signal.addEventListener("abort", abort, { once: true });
      candidate.unlink = () => signal.removeEventListener?.("abort", abort);
    }
    activation = candidate;
    sessionRoots.add(root);
    latestSnapshot = data.getSnapshot() || {};
    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleInput);
    void load(candidate);

    let disposed = false;
    return () => {
      if (disposed) return false;
      disposed = true;
      return detach(candidate);
    };
  };

  const resetSession = () => {
    unmount();
    generation += 1;
    requestSerial += 1;
    session = {};
    contextData = null;
    loadState = "idle";
    latestSnapshot = null;
    synthesisRequestId = "";
    writes.clear();
    claimDrafts.clear();
    for (const root of sessionRoots) scrubPersonalContextSurface(root);
    sessionRoots.clear();
  };

  return Object.freeze({
    mount,
    render(context = {}) {
      if (!isActive(activation)) return false;
      latestSnapshot = context.snapshot || data.getSnapshot() || {};
      return paint(activation);
    },
    unmount,
    resetSession
  });
}
