import {
  createTagMultiSelectState,
  handleTagMultiSelectKey,
  reduceTagMultiSelectState
} from "../../components/tag-multiselect/index.mjs";
import { eventTimestamp } from "../../time/index.mjs";
import {
  quoteSkyMarkup,
  quoteTimelineMarkup
} from "./presentation.mjs";

const noop = () => {};
const normalizedSearch = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/\s+/g, " ")
  .trim();
const searchableText = values => {
  const parts = [];
  const append = value => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(append);
    if (typeof value === "object") return Object.values(value).forEach(append);
    parts.push(String(value));
  };
  values.forEach(append);
  return normalizedSearch(parts.join(" "));
};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Quotes feature ${group} requires ${name}`);
    }
  }
}

export function createQuotesFeatureController({
  data = {},
  annotations = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    requestV1: data.requestV1,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection,
    publish: data.publish
  });
  requireFunctions("annotation port", {
    markTarget: annotations.markTarget,
    applyAnchors: annotations.applyAnchors,
    scheduleLayout: annotations.scheduleLayout,
    rootKey: annotations.rootKey
  });
  requireFunctions("view port", {
    contentState: view.contentState,
    resetOccurrenceInput: view.resetOccurrenceInput,
    occurrenceFields: view.occurrenceFields,
    showToast: view.showToast,
    escapeMarkup: view.escapeMarkup
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    requestFrame: platform.requestFrame,
    cancelFrame: platform.cancelFrame,
    repeat: platform.repeat,
    cancelRepeat: platform.cancelRepeat,
    getComputedStyle: platform.getComputedStyle,
    matchesMedia: platform.matchesMedia,
    confirm: platform.confirm,
    performanceNow: platform.performanceNow,
    random: platform.random,
    escapeSelector: platform.escapeSelector
  });
  if (!platform.document || !platform.window) {
    throw new TypeError("Quotes feature requires document and window");
  }

  const { document, window } = platform;
  let activation = null;
  let surface = null;
  let session = {};
  let searchQuery = "";
  let skyIndex = 0;
  let rotateTimer = 0;
  let scrollFrame = 0;
  let submissionPromise = null;
  let tagState = createTagMultiSelectState();
  const scrollStates = new WeakMap();
  const expandedKeys = new Set();
  const root = () => activation?.root || surface;
  const query = selector => root()?.querySelector(selector) || null;
  const queryAll = selector => [...(root()?.querySelectorAll(selector) || [])];
  const sessionTicket = () => ({
    session,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial()
  });
  const sameSession = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.owner === String(data.getAccountId() || "")
    && ticket.serial === data.getSessionSerial()
  );
  const isActive = () => Boolean(activation && !activation.signal?.aborted);
  const tagElements = () => ({
    root: query('[data-tag-multiselect="quote"]'),
    input: query("#quote-tags"),
    selected: query("#quote-selected-tags"),
    options: query("#quote-tag-options"),
    toggle: query("#quote-tag-toggle"),
    status: query("#quote-tag-status")
  });

  function tagCandidates() {
    const snapshot = data.getSnapshot();
    return [...(snapshot.quoteTags || []), ...(snapshot.quotes || []).flatMap(item => item.tags || [])];
  }

  function renderTagPicker() {
    const elements = tagElements();
    if (!elements.root || !elements.input || !elements.selected
      || !elements.options || !elements.toggle || !elements.status) return false;
    const open = elements.root.dataset.open === "true"
      && !tagState.atLimit
      && tagState.options.length > 0;
    elements.input.value = tagState.input;
    elements.input.setAttribute("aria-expanded", String(open));
    elements.input.setAttribute(
      "aria-activedescendant",
      open && tagState.activeIndex >= 0 ? `quote-tag-option-${tagState.activeIndex}` : ""
    );
    elements.toggle.setAttribute("aria-expanded", String(open));
    elements.selected.innerHTML = tagState.selected.map(tag => (
      `<span>#${view.escapeMarkup(tag)}<button type="button" data-quote-tag-remove="${view.escapeMarkup(tag)}" aria-label="移除标签 ${view.escapeMarkup(tag)}">×</button></span>`
    )).join("");
    elements.options.innerHTML = tagState.options.map((option, index) => (
      `<button id="quote-tag-option-${index}" type="button" role="option" aria-selected="${index === tagState.activeIndex}" data-quote-tag-option="${view.escapeMarkup(option.value)}">${option.type === "create" ? `创建 “${view.escapeMarkup(option.value)}”` : view.escapeMarkup(option.value)}</button>`
    )).join("");
    elements.options.hidden = !open;
    elements.status.textContent = tagState.overflow.length
      ? `已有 ${tagState.selected.length} 个标签，请先移除一个再添加。`
      : tagState.atLimit ? "已达到 8 个标签上限。" : "";
    return true;
  }

  function updateTags(action, { open } = {}) {
    tagState = reduceTagMultiSelectState(tagState, action);
    const elements = tagElements();
    if (elements.root && open !== undefined) elements.root.dataset.open = String(open);
    renderTagPicker();
    return tagState;
  }

  function setTags(selected = []) {
    tagState = createTagMultiSelectState({ candidates: tagCandidates(), selected });
    const elements = tagElements();
    if (elements.root) elements.root.dataset.open = "false";
    renderTagPicker();
  }

  function tagsForSubmission() {
    const elements = tagElements();
    tagState = reduceTagMultiSelectState(tagState, {
      type: "input",
      value: elements.input?.value || ""
    });
    if (tagState.query) tagState = reduceTagMultiSelectState(tagState, { type: "commit" });
    renderTagPicker();
    return [...tagState.selected];
  }

  function stopBubbleScroll() {
    if (scrollFrame) platform.cancelFrame(scrollFrame);
    scrollFrame = 0;
  }

  function runBubbleScroll(now) {
    if (!isActive() || document.hidden) {
      scrollFrame = 0;
      return;
    }
    let active = false;
    queryAll(".quote-bubble p.is-auto-scrolling").forEach(viewport => {
      const state = scrollStates.get(viewport);
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      if (!state || maximum <= 1) return;
      active = true;
      const elapsed = Math.min(64, now - state.lastTime) / 1000;
      state.lastTime = now;
      if (now < state.resumeAt) {
        state.position = viewport.scrollTop;
        state.velocity = 0;
        viewport.classList.toggle("is-user-scrolling", state.userPaused);
        return;
      }
      state.userPaused = false;
      viewport.classList.remove("is-user-scrolling");
      if (now < state.holdUntil) {
        state.velocity = 0;
        return;
      }
      const remaining = state.direction > 0 ? maximum - state.position : state.position;
      if (remaining <= 0.25) {
        state.position = state.direction > 0 ? maximum : 0;
        viewport.scrollTop = state.position;
        state.direction *= -1;
        state.velocity = 0;
        state.holdUntil = now + 800;
        return;
      }
      const acceleration = 18;
      const targetSpeed = Math.min(14, Math.sqrt(2 * acceleration * remaining));
      const currentSpeed = Math.abs(state.velocity);
      const speedStep = acceleration * elapsed;
      const speed = currentSpeed < targetSpeed
        ? Math.min(targetSpeed, currentSpeed + speedStep)
        : Math.max(targetSpeed, currentSpeed - speedStep);
      state.velocity = state.direction * speed;
      const next = state.position + state.velocity * elapsed;
      if (next >= maximum || next <= 0) {
        state.position = state.direction > 0 ? maximum : 0;
        viewport.scrollTop = state.position;
        state.direction *= -1;
        state.velocity = 0;
        state.holdUntil = now + 800;
      } else {
        state.position = next;
        viewport.scrollTop = next;
      }
    });
    scrollFrame = active ? platform.requestFrame(runBubbleScroll) : 0;
  }

  function setupBubbleScroll() {
    stopBubbleScroll();
    const now = platform.performanceNow();
    const reduceMotion = platform.matchesMedia("(prefers-reduced-motion: reduce)");
    queryAll(".quote-bubble p").forEach(viewport => {
      viewport.classList.remove("is-auto-scrolling");
      viewport.removeAttribute("tabindex");
      viewport.scrollTop = 0;
      if (viewport.scrollHeight - viewport.clientHeight <= 1) return;
      viewport.classList.add("is-auto-scrolling");
      viewport.tabIndex = 0;
      scrollStates.set(viewport, {
        direction: 1,
        position: 0,
        velocity: 0,
        lastTime: now,
        resumeAt: now + 1200,
        holdUntil: 0,
        userPaused: false
      });
    });
    if (!reduceMotion && isActive() && queryAll(".quote-bubble p.is-auto-scrolling").length) {
      scrollFrame = platform.requestFrame(runBubbleScroll);
    }
  }

  function deferBubbleScroll(viewport) {
    const state = scrollStates.get(viewport);
    if (!state) return false;
    const now = platform.performanceNow();
    Object.assign(state, {
      direction: 1,
      position: viewport.scrollTop,
      velocity: 0,
      lastTime: now,
      resumeAt: now + 5000,
      holdUntil: 0,
      userPaused: true
    });
    viewport.classList.add("is-user-scrolling");
    return true;
  }

  function renderSky(advance = false) {
    const sky = query("#quote-sky-content");
    if (!sky) return false;
    const previousIds = new Set(
      [...sky.querySelectorAll(".quote-bubble")].map(item => item.dataset.quoteId)
    );
    if (advance) skyIndex += 1;
    const snapshot = data.getSnapshot();
    const result = quoteSkyMarkup({
      quotes: snapshot.quotes || [],
      index: skyIndex,
      previousIds,
      advance,
      escapeMarkup: view.escapeMarkup,
      emptyState: view.contentState,
      random: platform.random
    });
    sky.innerHTML = result.markup;
    result.items.forEach(item => annotations.markTarget(
      sky.querySelector(
        `[data-quote-id="${platform.escapeSelector(item.id)}"] .quote-content`
      ),
      annotations.rootKey("quote", item.id),
      "content"
    ));
    annotations.applyAnchors(sky);
    platform.requestFrame(setupBubbleScroll);
    return true;
  }

  function syncOverflow() {
    queryAll(".quote-entry").forEach(entry => {
      const viewport = entry.querySelector(".quote-content-viewport");
      const button = entry.querySelector("[data-quote-expand]");
      if (!viewport || !button) return;
      const wasExpanded = expandedKeys.has(viewport.dataset.expandKey);
      viewport.classList.remove("expanded");
      const overflows = viewport.scrollHeight > viewport.clientHeight + 1;
      viewport.classList.toggle("expanded", wasExpanded && overflows);
      button.hidden = !overflows;
      button.textContent = wasExpanded && overflows ? "收起" : "展开";
      button.setAttribute("aria-expanded", String(wasExpanded && overflows));
    });
    annotations.scheduleLayout();
  }

  function render() {
    if (!root()) return false;
    const snapshot = data.getSnapshot();
    const allItems = [...(snapshot.quotes || [])]
      .sort((left, right) => eventTimestamp(right).localeCompare(eventTimestamp(left)));
    const terms = normalizedSearch(searchQuery).split(" ").filter(Boolean);
    const items = allItems.filter(item => {
      if (!terms.length) return true;
      const text = searchableText([item.source, item.content, item.tags]);
      return terms.every(term => text.includes(term));
    });
    renderSky();
    const timeline = query("#quote-timeline");
    if (!timeline) return false;
    timeline.innerHTML = quoteTimelineMarkup({
      items,
      allItems,
      escapeMarkup: view.escapeMarkup,
      emptySearchState: label => view.contentState({
        title: `没有匹配的${label}`,
        body: "换一个关键词，原有记录不会受到影响。"
      })
    });
    items.filter(item => !item._sync).forEach(item => annotations.markTarget(
      timeline.querySelector(
        `[data-quote-id="${platform.escapeSelector(item.id)}"] blockquote`
      ),
      annotations.rootKey("quote", item.id),
      "content"
    ));
    annotations.applyAnchors(timeline);
    tagState = reduceTagMultiSelectState(tagState, {
      type: "set-candidates",
      values: tagCandidates()
    });
    renderTagPicker();
    platform.requestFrame(syncOverflow);
    platform.cancelRepeat(rotateTimer);
    rotateTimer = 0;
    if ((snapshot.quotes || []).length > 3) {
      rotateTimer = platform.repeat(() => {
        if (isActive() && !document.hidden && !query("#quote-sky")?.matches(":hover")) {
          renderSky(true);
        }
      }, 24000);
    }
    return true;
  }

  function resetForm() {
    const form = query("#quote-form");
    form?.reset();
    setTags();
    const id = query("#quote-id");
    if (id) id.value = "";
    view.resetOccurrenceInput(query("#quote-datetime"));
    const submit = query("#quote-submit");
    if (submit) submit.textContent = "收藏";
    const cancel = query("#quote-cancel");
    if (cancel) cancel.hidden = true;
    const status = query("#quote-status");
    if (status) status.textContent = "";
    return true;
  }

  function editQuote(id) {
    const quote = (data.getSnapshot().quotes || []).find(item => item.id === id);
    if (!quote) return false;
    query("#quote-id").value = id;
    query("#quote-source").value = quote.source;
    query("#quote-content").value = quote.content;
    setTags(quote.tags || []);
    view.resetOccurrenceInput(query("#quote-datetime"), quote);
    query("#quote-submit").textContent = "保存修改";
    query("#quote-cancel").hidden = false;
    query("#quote-status").textContent = "正在编辑已有善言";
    query("#quote-form").scrollIntoView({ behavior: "smooth", block: "center" });
    query("#quote-content").focus();
    return true;
  }

  async function submit(form) {
    const ticket = sessionTicket();
    const id = query("#quote-id").value;
    const existing = id
      ? (data.getSnapshot().quotes || []).find(item => item.id === id)
      : null;
    const button = query("#quote-submit");
    const status = query("#quote-status");
    const payload = {
      ...view.occurrenceFields(query("#quote-datetime")),
      source: query("#quote-source").value,
      content: query("#quote-content").value,
      tags: tagsForSubmission()
    };
    const requestId = form.dataset.requestId || platform.createRequestId();
    const temporaryId = `pending:${requestId}`;
    if (!id) form.dataset.requestId = requestId;
    button.disabled = true;
    status.textContent = id ? "正在保存修改…" : "正在收藏…";
    try {
      if (id) {
        const result = await data.requestV1(
          `/api/v1/quotes/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${existing?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            domains: ["quotes"],
            recoverCommitted: true,
            projection: { kind: "record.update", domain: "quotes", id, payload },
            onQueued: record => data.applyPendingProjection(record)
          }
        );
        if (sameSession(ticket) && result.data) {
          data.getSnapshot().quotes = (data.getSnapshot().quotes || [])
            .map(item => item.id === id ? result.data : item);
        }
      } else {
        const result = await data.requestV1(
          "/api/v1/quotes",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["quotes"],
            projection: { kind: "record.create", domain: "quotes", temporaryId, payload },
            onQueued: record => data.applyPendingProjection(record)
          }
        );
        if (sameSession(ticket)) {
          data.getSnapshot().quotes = (data.getSnapshot().quotes || [])
            .map(item => item.id === temporaryId ? result.data : item);
        }
      }
      if (!sameSession(ticket)) return false;
      data.publish(["quotes"]);
      delete form.dataset.requestId;
      resetForm();
      void data.refresh("quotes").catch(error => (
        sameSession(ticket)
          ? view.showToast(`善言已保存，但列表刷新失败：${error.message}`, "error")
          : false
      ));
      view.showToast(id ? "善言已更新" : "善言已收藏");
      return true;
    } catch (error) {
      if (!sameSession(ticket)) return false;
      if (error.syncStatus === "pending") {
        resetForm();
        status.textContent = "已收藏，网络恢复后自动同步。";
        view.showToast(id ? "善言修改将在网络恢复后同步" : "善言已进入待同步队列");
      } else {
        if (id) await data.refresh("quotes").catch(noop);
        status.textContent = error.message;
      }
      return false;
    } finally {
      if (sameSession(ticket) && button.isConnected) button.disabled = false;
    }
  }

  async function removeQuote(button) {
    const ticket = sessionTicket();
    const id = button.dataset.quoteDelete;
    const item = (data.getSnapshot().quotes || []).find(value => value.id === id);
    if (!item || !platform.confirm("将这条善言及其批注移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.requestV1(
        `/api/v1/quotes/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${item.version || 1}"` }
        },
        {
          domains: ["quotes"],
          recoverCommitted: true,
          projection: { kind: "record.delete", domain: "quotes", id },
          onQueued: record => data.applyPendingProjection(record)
        }
      );
      if (!sameSession(ticket)) return false;
      if (query("#quote-id")?.value === id) resetForm();
      void data.refresh("quotes").catch(error => (
        sameSession(ticket)
          ? view.showToast(`善言已移除，但列表刷新失败：${error.message}`, "error")
          : false
      ));
      view.showToast("善言已移入回收站");
      return true;
    } catch (error) {
      if (!sameSession(ticket)) return false;
      if (error.syncStatus === "pending") view.showToast("善言将在网络恢复后移入回收站");
      else {
        await data.refresh("quotes").catch(noop);
        view.showToast(error.message, "error");
        if (button.isConnected) button.disabled = false;
      }
      return false;
    }
  }

  function toggleOverflow(button) {
    const viewport = button.closest(".quote-entry-card")?.querySelector(
      ".quote-content-viewport"
    );
    if (!viewport) return false;
    const expanded = !viewport.classList.contains("expanded");
    if (expanded) expandedKeys.add(viewport.dataset.expandKey);
    else expandedKeys.delete(viewport.dataset.expandKey);
    viewport.classList.toggle("expanded", expanded);
    button.textContent = expanded ? "收起" : "展开";
    button.setAttribute("aria-expanded", String(expanded));
    annotations.scheduleLayout();
    return true;
  }

  async function handleClick(event) {
    const option = event.target.closest("[data-quote-tag-option]");
    const removeTag = event.target.closest("[data-quote-tag-remove]");
    const elements = tagElements();
    if (elements.root && !elements.root.contains(event.target)
      && elements.root.dataset.open === "true") {
      elements.root.dataset.open = "false";
      renderTagPicker();
    }
    if (option) {
      updateTags({ type: "select", value: option.dataset.quoteTagOption }, { open: false });
      elements.input?.focus();
      elements.status.textContent = "已添加标签。";
      return true;
    }
    if (removeTag) {
      updateTags({ type: "remove", value: removeTag.dataset.quoteTagRemove }, { open: false });
      elements.input?.focus();
      elements.status.textContent = "已移除标签。";
      return true;
    }
    const button = event.target.closest("button");
    if (!button) {
      if (elements.root && !elements.root.contains(event.target)) {
        elements.root.dataset.open = "false";
        renderTagPicker();
      }
      return false;
    }
    if (button.id === "quote-tag-toggle") {
      const open = elements.root.dataset.open !== "true";
      updateTags({ type: "set-candidates", values: tagCandidates() }, { open });
      if (open) elements.input.focus();
      return true;
    }
    if (button.id === "quote-refresh") return renderSky(true);
    if (button.id === "quote-cancel") return resetForm();
    if (button.dataset.quoteExpand != null) return toggleOverflow(button);
    if (button.dataset.quoteEdit) return editQuote(button.dataset.quoteEdit);
    if (button.dataset.quoteDelete) return removeQuote(button);
    if (button.dataset.contentFocus) {
      const target = document.getElementById(button.dataset.contentFocus);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
      return true;
    }
    return false;
  }

  function handleInput(event) {
    if (event.target.matches("[data-feed-search='quotes']")) {
      searchQuery = event.target.value;
      render();
      return;
    }
    if (event.target.id === "quote-tags") {
      updateTags({ type: "input", value: event.target.value }, { open: true });
    }
  }

  function handleFocus(event) {
    if (event.target.id === "quote-tags") {
      updateTags({ type: "set-candidates", values: tagCandidates() }, { open: true });
    }
  }

  function handleKeydown(event) {
    const viewport = event.target.closest?.(".quote-bubble p.is-auto-scrolling");
    if (viewport) deferBubbleScroll(viewport);
    if (event.target.id !== "quote-tags") return;
    const result = handleTagMultiSelectKey(tagState, {
      key: event.key,
      isComposing: event.isComposing,
      selectionStart: event.target.selectionStart,
      selectionEnd: event.target.selectionEnd
    });
    if (!result.handled || event.key === "Enter" && result.intent === "none") return;
    event.preventDefault();
    tagState = result.state;
    const elements = tagElements();
    elements.root.dataset.open = String(result.intent === "move");
    renderTagPicker();
    if (["create", "select", "remove"].includes(result.intent)) {
      elements.status.textContent = result.intent === "remove"
        ? "已移除标签。"
        : "已添加标签。";
    }
  }

  async function mount(context = {}) {
    await unmount();
    if (!context.root || typeof context.root !== "object") {
      throw new TypeError("Quotes feature requires a root");
    }
    if (context.signal?.aborted) {
      throw Object.assign(new Error("Feature activation changed"), { name: "AbortError" });
    }
    const current = {
      root: context.root,
      signal: context.signal,
      listeners: [],
      unlink: noop
    };
    activation = current;
    surface = context.root;
    const listen = (target, type, listener, options) => {
      target?.addEventListener?.(type, listener, options);
      current.listeners.push([target, type, listener, options]);
    };
    listen(current.root, "click", event => void handleClick(event));
    listen(current.root, "input", handleInput);
    listen(current.root, "focusin", handleFocus);
    listen(current.root, "keydown", handleKeydown);
    listen(current.root, "submit", event => {
      if (!event.target.matches("#quote-form")) return;
      event.preventDefault();
      if (submissionPromise) return;
      const pending = submit(event.target);
      submissionPromise = pending;
      void pending.finally(() => {
        if (submissionPromise === pending) submissionPromise = null;
      });
    });
    for (const type of ["wheel", "pointerdown", "pointermove", "touchstart", "touchmove"]) {
      listen(current.root, type, event => {
        const viewport = event.target.closest?.(".quote-bubble p.is-auto-scrolling");
        if (viewport) deferBubbleScroll(viewport);
      }, { passive: true });
    }
    listen(document, "visibilitychange", () => {
      if (!document.hidden) setupBubbleScroll();
    });
    listen(window, "resize", () => platform.requestFrame(() => {
      syncOverflow();
      setupBubbleScroll();
    }), { passive: true });
    const abort = () => {
      if (activation === current) void unmount();
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    current.unlink = () => {
      for (const [target, type, listener, options] of current.listeners) {
        target?.removeEventListener?.(type, listener, options);
      }
      context.signal?.removeEventListener("abort", abort);
    };
    if (!query("#quote-id")?.value) view.resetOccurrenceInput(query("#quote-datetime"));
    setTags(tagState.selected);
    render();
    return () => activation === current ? unmount() : false;
  }

  function unmount() {
    const current = activation;
    if (!current) return false;
    activation = null;
    current.unlink();
    stopBubbleScroll();
    platform.cancelRepeat(rotateTimer);
    rotateTimer = 0;
    return true;
  }

  return Object.freeze({
    mount,
    render(context = {}) {
      if (!isActive()) return false;
      const changed = context.changedDomains == null
        ? null
        : new Set(typeof context.changedDomains === "string"
          ? [context.changedDomains]
          : context.changedDomains);
      return changed === null || changed.has("quotes") || changed.has("comments")
        ? render()
        : false;
    },
    unmount,
    async resetSession() {
      session = {};
      await unmount();
      searchQuery = "";
      skyIndex = 0;
      submissionPromise = null;
      tagState = createTagMultiSelectState();
      expandedKeys.clear();
      resetForm();
    },
    openItem(id) {
      if (!isActive()) return false;
      platform.requestFrame(() => (
        query(`[data-quote-id="${platform.escapeSelector(id)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" })
      ));
      return true;
    },
    syncOverflow,
    setupBubbleScroll
  });
}
