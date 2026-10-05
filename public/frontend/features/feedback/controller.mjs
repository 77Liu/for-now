import { feedbackSubmissionPayload, feedbackViewModel } from "./model.mjs";

export const FEEDBACK_ENDPOINT = "/api/v1/feedback";

export const FEEDBACK_SELECTORS = Object.freeze({
  form: "#feedback-form",
  feature: "#feedback-feature",
  contextField: "#feedback-context-field",
  status: "#feedback-status",
  count: "#feedback-count",
  list: "#feedback-list",
  submit: '[type="submit"]',
  retry: '[data-content-action="retry-feedback"]',
  focus: '[data-content-focus="feedback-feature"]'
});

const emptyDraft = () => ({
  type: "bug",
  feature: "",
  body: "",
  includeContext: false,
  contextSummary: ""
});

const copyDraft = value => ({
  type: String(value?.type ?? ""),
  feature: String(value?.feature ?? ""),
  body: String(value?.body ?? ""),
  includeContext: value?.includeContext === true,
  contextSummary: String(value?.contextSummary ?? "")
});

const sameDraft = (left, right) => (
  left.type === right.type
  && left.feature === right.feature
  && left.body === right.body
  && left.includeContext === right.includeContext
  && left.contextSummary === right.contextSummary
);

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
}[character]));

function contentStateMarkup({ kind = "empty", title, body, action = "" }) {
  const role = kind === "failure"
    ? ' role="alert"'
    : kind === "loading"
      ? ' role="status"'
      : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${action}</section>`;
}

function feedbackListMarkup(items, loadState, formatDate) {
  if (items.length) {
    return items.map(item => {
      const view = feedbackViewModel(item);
      return `<article class="feedback-entry"><header><span>${escapeHtml(view.typeLabel)}</span><b>${escapeHtml(view.statusLabel)}</b></header><h3>${escapeHtml(view.feature)}</h3><p>${escapeHtml(view.body)}</p><footer><small>${escapeHtml(formatDate(view.createdAt))} · ${escapeHtml(view.appVersion)}</small><span>${escapeHtml(view.contextLabel)}</span></footer></article>`;
    }).join("");
  }
  if (loadState === "failure") {
    return contentStateMarkup({
      kind: "failure",
      title: "暂时无法读取反馈记录",
      body: "已经提交的内容没有被删除。请检查网络后重试。",
      action: '<button class="quiet-button content-state-action" type="button" data-content-action="retry-feedback">重新读取</button>'
    });
  }
  if (loadState === "loading") {
    return contentStateMarkup({
      kind: "loading",
      title: "正在读取反馈记录",
      body: "提交记录加载期间仍可继续填写反馈。"
    });
  }
  return contentStateMarkup({
    title: "还没有提交记录",
    body: "问题或建议提交后会留在这里，方便继续核对。",
    action: '<button class="quiet-button content-state-action" type="button" data-content-focus="feedback-feature">写一条反馈</button>'
  });
}

function changedFeedback(changedDomains) {
  if (changedDomains == null) return true;
  if (typeof changedDomains === "string") return changedDomains === "feedback";
  try {
    return [...changedDomains].includes("feedback");
  } catch {
    return false;
  }
}

function formControl(form, name) {
  return form?.elements?.[name] || form?.elements?.namedItem?.(name) || null;
}

function readDraft(form) {
  return {
    type: String(formControl(form, "type")?.value ?? ""),
    feature: String(formControl(form, "feature")?.value ?? ""),
    body: String(formControl(form, "body")?.value ?? ""),
    includeContext: formControl(form, "includeContext")?.checked === true,
    contextSummary: String(formControl(form, "contextSummary")?.value ?? "")
  };
}

function writeDraft(form, value) {
  const draft = copyDraft(value);
  const type = formControl(form, "type");
  const feature = formControl(form, "feature");
  const body = formControl(form, "body");
  const includeContext = formControl(form, "includeContext");
  const contextSummary = formControl(form, "contextSummary");
  if (type) type.value = draft.type;
  if (feature) feature.value = draft.feature;
  if (body) body.value = draft.body;
  if (includeContext) includeContext.checked = draft.includeContext;
  if (contextSummary) contextSummary.value = draft.contextSummary;
}

function listResult(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.data) ? value.data : [];
}

export function createFeedbackFeatureController({
  requestV1,
  listAllV1,
  getAppVersion,
  createRequestId,
  formatDate,
  showToast
} = {}) {
  for (const [name, value] of Object.entries({
    requestV1,
    listAllV1,
    getAppVersion,
    createRequestId,
    formatDate,
    showToast
  })) {
    if (typeof value !== "function") {
      throw new TypeError(`Feedback feature controller requires ${name}`);
    }
  }

  let activation = null;
  let activationSerial = 0;
  let session = {};
  let readSerial = 0;
  let items = [];
  let loadState = "idle";
  let draft = emptyDraft();
  let draftInitialized = false;
  let requestId = "";
  let requestFingerprint = "";
  let pendingSubmit = null;
  let submitMessage = "";
  let stateObserved = false;
  let stateRecoveryUsed = false;
  let successfulRead = false;
  const sessionRoots = new Set();

  const isCurrentSession = candidate => candidate?.session === session;
  const isActive = candidate => (
    candidate !== null
    && activation === candidate
    && isCurrentSession(candidate)
    && !candidate.signal?.aborted
  );

  const queryRoot = (root, selector) => root?.querySelector?.(selector) || null;
  const query = (candidate, selector) => (
    isActive(candidate) ? queryRoot(candidate.root, selector) : null
  );

  const payloadFor = value => feedbackSubmissionPayload(value, {
    appVersion: getAppVersion()
  });
  const fingerprintFor = value => JSON.stringify(payloadFor(value));

  const renderList = candidate => {
    const list = query(candidate, FEEDBACK_SELECTORS.list);
    if (!list) return false;
    list.innerHTML = feedbackListMarkup(items, loadState, formatDate);
    const count = query(candidate, FEEDBACK_SELECTORS.count);
    if (count) count.textContent = `${items.length} 条`;
    return true;
  };

  const syncForm = (candidate, { restoreDraft = false } = {}) => {
    const form = query(candidate, FEEDBACK_SELECTORS.form);
    if (!form) return false;
    if (!draftInitialized) {
      draft = readDraft(form);
      draftInitialized = true;
    } else if (restoreDraft) {
      writeDraft(form, draft);
    }
    const contextField = query(candidate, FEEDBACK_SELECTORS.contextField);
    if (contextField) contextField.hidden = !formControl(form, "includeContext")?.checked;
    const button = form.querySelector?.(FEEDBACK_SELECTORS.submit) || null;
    if (button) button.disabled = Boolean(pendingSubmit);
    const status = query(candidate, FEEDBACK_SELECTORS.status);
    if (status) status.textContent = submitMessage;
    if (form.dataset) {
      const currentDraft = readDraft(form);
      let matchesRequest = false;
      if (requestId) {
        try {
          matchesRequest = fingerprintFor(currentDraft) === requestFingerprint;
        } catch {}
      }
      if (matchesRequest) form.dataset.requestId = requestId;
      else delete form.dataset.requestId;
    }
    return true;
  };

  const renderCurrent = candidate => {
    if (!isActive(candidate)) return false;
    const rendered = renderList(candidate);
    syncForm(candidate);
    return rendered;
  };

  const currentRead = ticket => (
    isCurrentSession(ticket)
    && readSerial === ticket.serial
    && isActive(ticket.activation)
  );

  const loadFeedback = async candidate => {
    if (!isActive(candidate)) return false;
    const ticket = {
      session,
      activation: candidate,
      serial: ++readSerial
    };
    loadState = "loading";
    renderList(candidate);
    try {
      const result = await listAllV1(FEEDBACK_ENDPOINT, {
        signal: candidate.signal
      });
      if (!currentRead(ticket)) return false;
      items = listResult(result);
      loadState = "ready";
      successfulRead = true;
      renderList(candidate);
      return true;
    } catch {
      if (!currentRead(ticket)) return false;
      loadState = "failure";
      renderList(candidate);
      if (stateObserved && !stateRecoveryUsed && !successfulRead) {
        stateRecoveryUsed = true;
        void loadFeedback(candidate);
      }
      return false;
    }
  };

  const clearRequestId = form => {
    requestId = "";
    requestFingerprint = "";
    if (form?.dataset) delete form.dataset.requestId;
  };

  const updateDraft = form => {
    draft = readDraft(form);
    draftInitialized = true;
    if (!pendingSubmit && requestId) {
      try {
        if (fingerprintFor(draft) !== requestFingerprint) clearRequestId(form);
      } catch {
        clearRequestId(form);
      }
    } else if (pendingSubmit && form?.dataset) {
      delete form.dataset.requestId;
    }
  };

  const settleSubmitUi = () => {
    const candidate = activation;
    if (isActive(candidate)) syncForm(candidate, { restoreDraft: true });
  };

  const submitFeedback = async (candidate, form) => {
    if (!isActive(candidate) || pendingSubmit) return false;
    updateDraft(form);
    const submittedDraft = copyDraft(draft);
    let payload;
    let fingerprint;
    try {
      payload = payloadFor(submittedDraft);
      fingerprint = JSON.stringify(payload);
      if (!requestId || requestFingerprint !== fingerprint) {
        requestId = String(createRequestId() ?? "");
        if (!requestId) throw new TypeError("无法创建反馈请求标识");
        requestFingerprint = fingerprint;
      }
    } catch (error) {
      submitMessage = error?.message || "反馈提交失败，请稍后重试";
      syncForm(candidate);
      return false;
    }

    const ticket = {
      session,
      activation: candidate,
      requestId,
      fingerprint,
      submittedDraft
    };
    pendingSubmit = ticket;
    submitMessage = "正在提交…";
    if (form.dataset) form.dataset.requestId = requestId;
    syncForm(candidate);

    try {
      await requestV1(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "idempotency-key": ticket.requestId },
        body: JSON.stringify(payload)
      });
      if (!isCurrentSession(ticket) || pendingSubmit !== ticket) return false;

      const unchanged = sameDraft(draft, ticket.submittedDraft);
      clearRequestId(isActive(ticket.activation) ? form : null);
      if (unchanged) {
        draft = emptyDraft();
        draftInitialized = true;
        const currentForm = query(activation, FEEDBACK_SELECTORS.form);
        if (currentForm) writeDraft(currentForm, draft);
      }

      let refreshed = true;
      const refreshActivation = isActive(ticket.activation) ? ticket.activation : null;
      if (refreshActivation) refreshed = await loadFeedback(refreshActivation);
      if (!isCurrentSession(ticket) || pendingSubmit !== ticket) return false;

      const refreshFailedWhileActive = refreshActivation
        && isActive(refreshActivation)
        && !refreshed;
      pendingSubmit = null;
      submitMessage = refreshFailedWhileActive
        ? "反馈已提交，但列表刷新失败，请稍后重试同步。"
        : unchanged
          ? "反馈已提交。"
          : "提交时的反馈已保存；等待期间的新输入已保留。";
      settleSubmitUi();
      if (refreshActivation && isActive(refreshActivation)) showToast("反馈已提交");
      return true;
    } catch (error) {
      if (!isCurrentSession(ticket) || pendingSubmit !== ticket) return false;
      pendingSubmit = null;
      let unchanged = false;
      try {
        unchanged = fingerprintFor(draft) === ticket.fingerprint;
      } catch {}
      if (unchanged) {
        requestId = ticket.requestId;
        requestFingerprint = ticket.fingerprint;
      } else {
        clearRequestId(null);
      }
      submitMessage = error?.message || "反馈提交失败，请稍后重试";
      settleSubmitUi();
      return false;
    }
  };

  function closestWithin(candidate, event, selector) {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    if (typeof candidate.root.contains === "function" && !candidate.root.contains(element)) return null;
    return element;
  }

  function handleInput(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const form = query(candidate, FEEDBACK_SELECTORS.form);
    if (!form || (typeof candidate.root.contains === "function" && !candidate.root.contains(event?.target))) return;
    updateDraft(form);
  }

  function handleChange(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const form = query(candidate, FEEDBACK_SELECTORS.form);
    if (!form || (typeof candidate.root.contains === "function" && !candidate.root.contains(event?.target))) return;
    const includeContext = formControl(form, "includeContext");
    const contextSummary = formControl(form, "contextSummary");
    if (event?.target === includeContext && includeContext?.checked && !contextSummary?.value) {
      contextSummary.value = `页面：产品反馈；应用版本：${getAppVersion()}`;
    }
    const contextField = query(candidate, FEEDBACK_SELECTORS.contextField);
    if (contextField) contextField.hidden = !includeContext?.checked;
    updateDraft(form);
  }

  function handleSubmit(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const form = query(candidate, FEEDBACK_SELECTORS.form);
    if (!form || event?.target !== form) return;
    event.preventDefault?.();
    void submitFeedback(candidate, form);
  }

  function handleClick(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const retry = closestWithin(candidate, event, FEEDBACK_SELECTORS.retry);
    if (retry) {
      event.preventDefault?.();
      void loadFeedback(candidate);
      return;
    }
    const focus = closestWithin(candidate, event, FEEDBACK_SELECTORS.focus);
    if (!focus) return;
    event.preventDefault?.();
    query(candidate, FEEDBACK_SELECTORS.feature)?.focus?.();
  }

  const listeners = Object.freeze({
    change: handleChange,
    input: handleInput,
    submit: handleSubmit,
    click: handleClick
  });

  const detach = (candidate, { preserveDraft = true } = {}) => {
    if (activation !== candidate) return false;
    const form = queryRoot(candidate.root, FEEDBACK_SELECTORS.form);
    if (preserveDraft && form) updateDraft(form);
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [type, listener] of Object.entries(listeners)) {
      candidate.root.removeEventListener(type, listener);
    }
    activation = null;
    readSerial += 1;
    if (loadState === "loading") loadState = items.length ? "ready" : "idle";
    return true;
  };

  const scrubRoot = root => {
    const form = queryRoot(root, FEEDBACK_SELECTORS.form);
    if (form) {
      try {
        form.reset?.();
      } catch {}
      writeDraft(form, emptyDraft());
      if (form.dataset) delete form.dataset.requestId;
      const button = form.querySelector?.(FEEDBACK_SELECTORS.submit) || null;
      if (button) button.disabled = false;
    }
    const contextField = queryRoot(root, FEEDBACK_SELECTORS.contextField);
    if (contextField) contextField.hidden = true;
    const status = queryRoot(root, FEEDBACK_SELECTORS.status);
    if (status) status.textContent = "";
    const count = queryRoot(root, FEEDBACK_SELECTORS.count);
    if (count) count.textContent = "";
    const list = queryRoot(root, FEEDBACK_SELECTORS.list);
    if (list) list.innerHTML = "";
  };

  function mount(context = {}) {
    unmount();
    const root = context.root;
    if (
      !root
      || typeof root.querySelector !== "function"
      || typeof root.addEventListener !== "function"
      || typeof root.removeEventListener !== "function"
    ) {
      throw new TypeError("Feedback feature mount requires a root event target");
    }

    let disposed = false;
    let candidate = null;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (candidate) detach(candidate);
    };
    if (context.signal?.aborted) return dispose;

    candidate = Object.freeze({
      id: ++activationSerial,
      root,
      route: context.route,
      signal: context.signal,
      session,
      dispose
    });
    activation = candidate;
    sessionRoots.add(root);
    for (const [type, listener] of Object.entries(listeners)) {
      root.addEventListener(type, listener);
    }
    candidate.signal?.addEventListener?.("abort", dispose, { once: true });
    syncForm(candidate, { restoreDraft: true });
    void loadFeedback(candidate);
    return dispose;
  }

  function render({ snapshot, changedDomains } = {}) {
    const candidate = activation;
    if (!isActive(candidate) || !changedFeedback(changedDomains)) return false;
    stateObserved = true;
    if (Array.isArray(snapshot?.feedback)) {
      items = snapshot.feedback;
      loadState = "ready";
      successfulRead = true;
    }
    renderCurrent(candidate);
    if (!stateRecoveryUsed && !successfulRead && ["failure", "idle"].includes(loadState)) {
      stateRecoveryUsed = true;
      void loadFeedback(candidate);
    }
    return true;
  }

  function unmount() {
    if (activation) detach(activation);
  }

  function resetSession() {
    if (activation) detach(activation, { preserveDraft: false });
    session = {};
    readSerial = 0;
    items = [];
    loadState = "idle";
    draft = emptyDraft();
    draftInitialized = false;
    requestId = "";
    requestFingerprint = "";
    pendingSubmit = null;
    submitMessage = "";
    stateObserved = false;
    stateRecoveryUsed = false;
    successfulRead = false;
    for (const root of sessionRoots) scrubRoot(root);
    sessionRoots.clear();
  }

  return Object.freeze({
    mount,
    render,
    unmount,
    resetSession
  });
}
