import {
  DISCOVERY_GENRES,
  THOUGHT_DISCOVERY_TYPES,
  createThoughtDiscoveryController
} from "./headless.mjs";

export const DISCOVERY_ENDPOINT = "/api/v1/discovery";
export const DISCOVERY_RANDOM_ENDPOINT = "/api/v1/discovery/random";

export const DISCOVERY_SELECTORS = Object.freeze({
  form: "#discovery-form",
  query: "#discovery-query",
  count: "#discovery-count",
  status: "#discovery-status",
  list: "#discovery-list",
  more: "#discovery-more",
  random: "#discovery-random",
  retry: '[data-content-action="retry-discovery"]',
  focusQuery: '[data-content-focus="discovery-query"]',
  action: "[data-discovery-action]",
  open: "[data-discovery-open]",
  snooze: "[data-discovery-snooze]"
});

const DEFAULT_FILTERS = Object.freeze({
  query: "",
  types: THOUGHT_DISCOVERY_TYPES,
  genres: DISCOVERY_GENRES,
  freshOnly: false
});

const RELEVANT_DOMAINS = new Set([
  "application",
  "discovery",
  "thoughts",
  "captures",
  "journals",
  "books",
  "quotes"
]);

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
})[character]);

const itemKey = item => item?.key || `${item?.genre || "thought"}:${item?.id || ""}`;

function discoveryQuery(input) {
  const params = new URLSearchParams();
  if (input.query) params.set("q", input.query);
  for (const genre of input.genres || []) params.append("genre", genre);
  for (const type of input.types || []) params.append("type", type);
  if (input.freshOnly) params.set("fresh", "1");
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", "20");
  return params.toString();
}

function contentStateMarkup({ kind = "empty", title, body, action = "" }) {
  const role = kind === "failure"
    ? ' role="alert"'
    : kind === "loading"
      ? ' role="status"'
      : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${action}</section>`;
}

function loadingMarkup() {
  return contentStateMarkup({
    kind: "loading",
    title: "正在查找记录",
    body: "结果会保留在当前页面，不需要重复提交。"
  });
}

function failureMarkup() {
  return contentStateMarkup({
    kind: "failure",
    title: "暂时无法查找旧记录",
    body: "已有记录没有变化。请检查网络后重试。",
    action: '<button class="quiet-button content-state-action" type="button" data-content-action="retry-discovery">重新查找</button>'
  });
}

function emptyMarkup() {
  return contentStateMarkup({
    title: "没有符合条件的记录",
    body: "这不会改变原有记录，可以调整条件后重新查找。",
    action: '<button class="quiet-button content-state-action" type="button" data-content-focus="discovery-query">调整查找条件</button>'
  });
}

function changedDomainsAreRelevant(changedDomains) {
  if (changedDomains == null) return true;
  const values = typeof changedDomains === "string" ? [changedDomains] : [...changedDomains];
  return values.includes("*") || values.some(value => RELEVANT_DOMAINS.has(value));
}

function dateFromNow(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Discovery feature now() returned an invalid date");
  return date;
}

export function createDiscoveryFeatureController({
  requestV1,
  createAction,
  navigate,
  showToast,
  formatDate,
  plainPreview,
  createRequestId,
  now,
  restorePendingStatuses = null
} = {}) {
  for (const [name, operation] of Object.entries({
    requestV1,
    createAction,
    navigate,
    showToast,
    formatDate,
    plainPreview,
    createRequestId,
    now
  })) {
    if (typeof operation !== "function") {
      throw new TypeError(`Discovery feature controller requires ${name}`);
    }
  }
  if (restorePendingStatuses !== null && typeof restorePendingStatuses !== "function") {
    throw new TypeError("Discovery feature controller restorePendingStatuses must be a function");
  }

  let activation = null;
  let headless;
  const actionRequestIds = new Map();
  const sessionRoots = new Set();

  const isCurrentActivation = candidate => (
    candidate !== null
    && activation === candidate
    && candidate.root === activation.root
    && candidate.route === activation.route
    && candidate.signal === activation.signal
  );

  const isActive = candidate => (
    isCurrentActivation(candidate) && !candidate.signal?.aborted
  );

  const query = (candidate, selector) => (
    isActive(candidate) ? candidate.root.querySelector(selector) : null
  );

  const contains = (candidate, element) => (
    isActive(candidate) && candidate.root.contains(element)
  );

  const findItem = key => (
    headless.getState().items.find(item => itemKey(item) === key)
  );

  const statusProjectionOptions = (candidate, id, value) => ({
    resource: `thought-chain:${id}`,
    domains: ["thoughts"],
    recoverCommitted: true,
    projection: { kind: "discovery.status", id, value },
    onQueued() {
      if (isActive(candidate)) headless.applyStatus(id, value);
    }
  });

  const discoveryStatusRequest = async (id, action, until = "") => {
    const candidate = activation;
    const item = headless.getState().items.find(value => (
      (value.genre || "thought") === "thought" && value.id === id
    ));
    const value = {
      id,
      status: {
        ...(item?.status || {}),
        ...(action === "read"
          ? {
              read: true,
              readAt: dateFromNow(now).toISOString(),
              snoozed: false,
              snoozedUntil: null
            }
          : {
              snoozed: true,
              snoozedUntil: until
            })
      },
      fresh: false,
      untraced: Boolean(item?.untraced)
    };
    const result = await requestV1(
      `/api/v1/thought-chains/${encodeURIComponent(id)}/discovery`,
      {
        method: "PATCH",
        headers: { "if-match": `"${item?.status?.version || 1}"` },
        body: JSON.stringify(action === "read" ? { action } : { action, until })
      },
      statusProjectionOptions(candidate, id, value)
    );
    return { value: result?.data || value };
  };

  const transport = {
    async search(input) {
      const candidate = activation;
      const result = await requestV1(
        `${DISCOVERY_ENDPOINT}?${discoveryQuery(input)}`,
        { signal: candidate?.signal }
      );
      return {
        items: Array.isArray(result?.data) ? result.data : [],
        nextCursor: result?.meta?.nextCursor || "",
        total: result?.meta?.total || 0,
        untracedCount: result?.meta?.untracedCount || 0,
        totalUntracedCount: result?.meta?.totalUntracedCount || 0
      };
    },
    markRead(id) {
      return discoveryStatusRequest(id, "read");
    },
    snooze(id, until) {
      return discoveryStatusRequest(id, "snooze", until);
    },
    async openRandomDoor(input) {
      const candidate = activation;
      const result = await requestV1(
        `${DISCOVERY_RANDOM_ENDPOINT}?${discoveryQuery(input)}`,
        { signal: candidate?.signal }
      );
      return {
        value: result?.data || null,
        total: result?.meta?.total || 0
      };
    }
  };

  headless = createThoughtDiscoveryController({
    transport,
    onNavigate(item) {
      const candidate = activation;
      if (isActive(candidate)) navigate(item);
    }
  });
  headless.reset(DEFAULT_FILTERS);

  const cardMarkup = item => {
    const primary = item.matches?.[0] || item.question || {};
    const sources = [...new Set((item.matches || []).map(match => match.sourceLabel))].join(" · ");
    const key = itemKey(item);
    const thought = (item.genre || "thought") === "thought";
    const status = thought
      ? item.fresh
        ? "待回访"
        : item.status?.snoozed
          ? "已稍后"
          : "已读"
      : item.genreLabel || "原始记录";
    const title = plainPreview(
      item.title || item.question?.content || primary.content || "无标题记录"
    );
    const preview = plainPreview(primary.content || "").slice(0, 220);
    return `<article class="discovery-entry" data-discovery-id="${escapeHtml(key)}"><header><div><span>${escapeHtml(status)}</span><small>${escapeHtml([item.genreLabel, sources || item.sourceLabel || "用户原文"].filter(Boolean).join(" · "))}</small></div><time>${escapeHtml(formatDate(item.occurredAt || item.createdAt))}</time></header><h2>${escapeHtml(title)}</h2><p>${escapeHtml(preview)}</p><footer><span>${escapeHtml(item.matchCount || 0)} 处命中</span><div><button class="subtle-action" type="button" data-discovery-action="${escapeHtml(key)}">转为行动</button>${thought ? `<button class="subtle-action" type="button" data-discovery-snooze="${escapeHtml(key)}">明天再看</button>` : ""}<button class="quiet-button" type="button" data-discovery-open="${escapeHtml(key)}">查看原记录</button></div></footer></article>`;
  };

  const renderSnapshot = (candidate, snapshot) => {
    if (!isActive(candidate)) return false;
    const count = query(candidate, DISCOVERY_SELECTORS.count);
    const status = query(candidate, DISCOVERY_SELECTORS.status);
    const list = query(candidate, DISCOVERY_SELECTORS.list);
    const more = query(candidate, DISCOVERY_SELECTORS.more);
    if (count) {
      count.textContent = `${snapshot.total} 条 · ${snapshot.totalUntracedCount} 条尚无你的后续痕迹`;
    }
    if (status) {
      status.textContent = snapshot.loading
        ? "正在查找记录…"
        : snapshot.error && snapshot.items.length
          ? "结果暂未更新，可以重新查找。"
          : "";
    }
    if (list) {
      list.innerHTML = snapshot.items.length
        ? snapshot.items.map(cardMarkup).join("")
        : snapshot.loading
          ? loadingMarkup()
          : snapshot.error
            ? failureMarkup()
            : emptyMarkup();
    }
    if (more) {
      more.hidden = !snapshot.nextCursor;
      more.disabled = snapshot.loadingMore;
      more.textContent = snapshot.loadingMore ? "正在加载…" : "继续加载";
    }
    return Boolean(list);
  };

  const syncFilterControls = (root, filters) => {
    const queryInput = root.querySelector(DISCOVERY_SELECTORS.query);
    const freshOnly = root.querySelector(`${DISCOVERY_SELECTORS.form} input[name="freshOnly"]`);
    if (queryInput) queryInput.value = filters.query;
    if (freshOnly) freshOnly.checked = filters.freshOnly;
    for (const input of root.querySelectorAll(`${DISCOVERY_SELECTORS.form} input[name="type"]`)) {
      input.checked = filters.types.includes(input.value);
    }
    for (const input of root.querySelectorAll(`${DISCOVERY_SELECTORS.form} input[name="genre"]`)) {
      input.checked = filters.genres.includes(input.value);
    }
  };

  const clearResultDom = root => {
    const count = root.querySelector(DISCOVERY_SELECTORS.count);
    const status = root.querySelector(DISCOVERY_SELECTORS.status);
    const list = root.querySelector(DISCOVERY_SELECTORS.list);
    const more = root.querySelector(DISCOVERY_SELECTORS.more);
    if (count) count.textContent = "";
    if (status) status.textContent = "";
    if (list) list.innerHTML = "";
    if (more) {
      more.hidden = true;
      more.disabled = false;
      more.textContent = "继续加载";
    }
  };

  const maybeRestorePendingStatuses = candidate => {
    if (
      !isActive(candidate)
      || !restorePendingStatuses
      || !candidate.stateNotified
      || !candidate.readReady
      || candidate.pendingRestoreUsed
    ) {
      return;
    }
    candidate.pendingRestoreUsed = true;
    void Promise.resolve().then(() => {
      if (isActive(candidate)) return restorePendingStatuses();
    }).then(records => {
      if (!isActive(candidate)) return;
      for (const record of Array.isArray(records) ? records : []) {
        const projection = record?.projection?.kind === "discovery.status"
          ? record.projection
          : record;
        if (projection?.id && projection?.value) {
          headless.applyStatus(projection.id, projection.value);
        }
      }
    }).catch(() => {});
  };

  const refreshCurrent = candidate => (
    headless.refresh().then(result => {
      if (!isActive(candidate) || result !== true) return false;
      candidate.readReady = true;
      maybeRestorePendingStatuses(candidate);
      return true;
    })
  );

  const maybeRecoverStartupRead = candidate => {
    if (
      !isActive(candidate)
      || !candidate.stateNotified
      || !candidate.startupReadFailed
      || candidate.startupRecoveryUsed
    ) {
      return;
    }
    candidate.startupRecoveryUsed = true;
    void refreshCurrent(candidate).catch(() => {});
  };

  const startInitialRefresh = candidate => {
    void refreshCurrent(candidate).catch(() => {
      if (!isActive(candidate)) return;
      candidate.startupReadFailed = true;
      maybeRecoverStartupRead(candidate);
    });
  };

  const selectedValues = (candidate, name) => (
    [...candidate.root.querySelectorAll(
      `${DISCOVERY_SELECTORS.form} input[name="${name}"]:checked`
    )].map(input => input.value)
  );

  const closestWithin = (candidate, event, selector) => {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    return element && contains(candidate, element) ? element : null;
  };

  const setButtonBusy = (candidate, button, busy) => {
    if (contains(candidate, button)) button.disabled = busy;
  };

  const handleSubmit = event => {
    const candidate = activation;
    const form = closestWithin(candidate, event, DISCOVERY_SELECTORS.form);
    if (!form) return;
    event.preventDefault?.();
    const queryInput = query(candidate, DISCOVERY_SELECTORS.query);
    const freshOnly = query(
      candidate,
      `${DISCOVERY_SELECTORS.form} input[name="freshOnly"]`
    );
    try {
      void headless.setFilters({
        query: queryInput?.value || "",
        types: selectedValues(candidate, "type"),
        genres: selectedValues(candidate, "genre"),
        freshOnly: Boolean(freshOnly?.checked)
      }).then(result => {
        if (!isActive(candidate) || result !== true) return;
        candidate.readReady = true;
        maybeRestorePendingStatuses(candidate);
      }).catch(() => {});
    } catch (error) {
      if (isActive(candidate)) showToast(error?.message || "查找条件无效", "error");
    }
  };

  const createActionFromItem = async (candidate, button, item) => {
    const key = itemKey(item);
    setButtonBusy(candidate, button, true);
    try {
      let requestId = actionRequestIds.get(key) || button.dataset?.requestId || "";
      if (!requestId) {
        requestId = String(createRequestId() || "");
        if (!requestId) {
          throw new TypeError("Discovery feature createRequestId returned an empty value");
        }
        actionRequestIds.set(key, requestId);
        if (button.dataset) button.dataset.requestId = requestId;
      }
      await createAction({
        title: plainPreview(item.title || item.question?.content || "回访记录"),
        priority: "none",
        sourceRef: {
          type: item.resourceType || "thought",
          id: item.resourceId || item.id,
          label: "寻迹"
        }
      }, { idempotencyKey: requestId });
      if (!isActive(candidate)) return;
      actionRequestIds.delete(key);
      if (button.dataset) delete button.dataset.requestId;
      showToast("已转为行动");
    } catch (error) {
      if (isActive(candidate)) showToast(error?.message || "暂时无法转为行动", "error");
    } finally {
      setButtonBusy(candidate, button, false);
    }
  };

  const openItem = async (candidate, button, item) => {
    setButtonBusy(candidate, button, true);
    let updateError = null;
    if ((item.genre || "thought") === "thought") {
      try {
        await headless.markRead(item.id);
      } catch (error) {
        updateError = error;
      }
    }
    if (!isActive(candidate)) return;
    if (updateError) {
      showToast(
        `原记录已打开，但回访状态更新失败：${updateError?.message || "未知错误"}`,
        "error"
      );
    }
    navigate(item);
    setButtonBusy(candidate, button, false);
  };

  const snoozeItem = async (candidate, button, item) => {
    setButtonBusy(candidate, button, true);
    try {
      const until = new Date(dateFromNow(now).getTime() + 86400000).toISOString();
      await headless.snooze(item.id, until);
      if (isActive(candidate)) showToast("已安排明天再看");
    } catch (error) {
      if (isActive(candidate)) {
        showToast(
          `暂时无法安排明天再看：${error?.message || "未知错误"}`,
          "error"
        );
        void headless.refresh().catch(() => {});
      }
    } finally {
      setButtonBusy(candidate, button, false);
    }
  };

  const handleClick = event => {
    const candidate = activation;
    if (!isActive(candidate)) return;

    if (closestWithin(candidate, event, DISCOVERY_SELECTORS.retry)) {
      event.preventDefault?.();
      void refreshCurrent(candidate).catch(() => {});
      return;
    }
    if (closestWithin(candidate, event, DISCOVERY_SELECTORS.focusQuery)) {
      event.preventDefault?.();
      query(candidate, DISCOVERY_SELECTORS.query)?.focus?.();
      return;
    }
    if (closestWithin(candidate, event, DISCOVERY_SELECTORS.more)) {
      event.preventDefault?.();
      void headless.loadMore().catch(() => {});
      return;
    }
    if (closestWithin(candidate, event, DISCOVERY_SELECTORS.random)) {
      event.preventDefault?.();
      void headless.openRandomDoor().catch(() => {});
      return;
    }

    const action = closestWithin(candidate, event, DISCOVERY_SELECTORS.action);
    if (action) {
      const item = findItem(String(action.dataset?.discoveryAction || ""));
      if (item) void createActionFromItem(candidate, action, item);
      return;
    }
    const open = closestWithin(candidate, event, DISCOVERY_SELECTORS.open);
    if (open) {
      const item = findItem(String(open.dataset?.discoveryOpen || ""));
      if (item) void openItem(candidate, open, item);
      return;
    }
    const snooze = closestWithin(candidate, event, DISCOVERY_SELECTORS.snooze);
    if (snooze) {
      const item = findItem(String(snooze.dataset?.discoverySnooze || ""));
      if (item) void snoozeItem(candidate, snooze, item);
    }
  };

  const detach = candidate => {
    if (!isCurrentActivation(candidate)) return false;
    candidate.root.removeEventListener("submit", handleSubmit);
    candidate.root.removeEventListener("click", handleClick);
    if (candidate.abortListener && candidate.signal?.removeEventListener) {
      candidate.signal.removeEventListener("abort", candidate.abortListener);
    }
    candidate.unsubscribe?.();
    const filters = headless.getState().filters;
    activation = null;
    headless.reset(filters);
    clearResultDom(candidate.root);
    return true;
  };

  function mount(context = {}) {
    unmount();
    const root = context.root;
    if (
      !root
      || typeof root.querySelector !== "function"
      || typeof root.querySelectorAll !== "function"
      || typeof root.contains !== "function"
      || typeof root.addEventListener !== "function"
      || typeof root.removeEventListener !== "function"
    ) {
      throw new TypeError("Discovery feature mount requires a root event target");
    }
    if (context.signal?.aborted) return () => {};

    const candidate = {
      root,
      route: context.route,
      signal: context.signal,
      abortListener: null,
      unsubscribe: null,
      stateNotified: false,
      readReady: false,
      startupReadFailed: false,
      startupRecoveryUsed: false,
      pendingRestoreUsed: false
    };
    activation = candidate;
    sessionRoots.add(root);
    syncFilterControls(root, headless.getState().filters);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("click", handleClick);
    candidate.unsubscribe = headless.subscribe(snapshot => {
      renderSnapshot(candidate, snapshot);
    });
    if (candidate.signal?.addEventListener) {
      candidate.abortListener = () => detach(candidate);
      candidate.signal.addEventListener("abort", candidate.abortListener, { once: true });
    }
    startInitialRefresh(candidate);
    return () => detach(candidate);
  }

  function render({ snapshot, changedDomains } = {}) {
    const candidate = activation;
    if (!isActive(candidate)) return false;
    void snapshot;
    const relevant = changedDomainsAreRelevant(changedDomains);
    if (relevant) renderSnapshot(candidate, headless.getState());
    if (!candidate.stateNotified) {
      candidate.stateNotified = true;
      maybeRecoverStartupRead(candidate);
      maybeRestorePendingStatuses(candidate);
    }
    return relevant;
  }

  function unmount() {
    if (activation) detach(activation);
  }

  function resetSession() {
    unmount();
    actionRequestIds.clear();
    headless.reset(DEFAULT_FILTERS);
    for (const root of sessionRoots) {
      clearResultDom(root);
      syncFilterControls(root, DEFAULT_FILTERS);
    }
    sessionRoots.clear();
  }

  return Object.freeze({
    mount,
    render,
    unmount,
    resetSession
  });
}
