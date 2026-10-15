import {
  createThoughtChains,
  normalizeThoughtSearch,
  thoughtDate,
  visibleThoughtChains
} from "./model.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Thought view requires ${name}`);
  }
  return value;
}

export function createThoughtView({
  getSnapshot,
  getActiveDate,
  isFullRouteStateLoaded,
  contentState,
  renderLatex,
  tagCommentableTargets,
  applyCommentAnchors,
  scheduleAnnotationLayout,
  requestFrame,
  getComputedStyle,
  escapeSelector,
  document,
  presentation,
  audioLifecycle,
  audioScope = () => null,
  readingState,
  captureReadingPosition = () => null,
  restoreReadingPosition = () => {}
} = {}) {
  for (const [name, value] of Object.entries({
    getSnapshot,
    getActiveDate,
    isFullRouteStateLoaded,
    contentState,
    renderLatex,
    tagCommentableTargets,
    applyCommentAnchors,
    scheduleAnnotationLayout,
    requestFrame,
    getComputedStyle,
    escapeSelector
  })) requireFunction(value, name);
  if (!document || !presentation) {
    throw new TypeError("Thought view requires document and presentation");
  }

  let surface = null;
  let route = null;
  let filter = "all";
  let sortMode = "occurred";
  let query = "";
  let routeResult = null;
  const expandedContent = new Set();
  let renderedScope = "";
  let renderToken = null;
  const currentFrame = (root, callback, token = renderToken) => requestFrame(() => {
    if (root?.isConnected !== false && readingState.isCurrent(token)) callback();
  });
  const queryOne = selector => document.querySelector(selector);

  function formIdentity(form, index) {
    if (form.dataset.followUpRoot) {
      return `follow-up:${form.dataset.followUpRoot}:create:`;
    }
    if (form.dataset.followupManualAnswer) {
      return `follow-up:${form.dataset.rootId || ""}:manual-answer:${form.dataset.followupManualAnswer}`;
    }
    if (form.dataset.followupEdit) {
      return `follow-up:${form.dataset.rootId || ""}:edit:${form.dataset.followupEdit}`;
    }
    return `form:${index}`;
  }

  const fieldIdentity = (field, index) => (
    field.type === "radio" && field.name
      ? `name:${field.name}:value:${field.value}`
      : field.name ? `name:${field.name}` : field.id ? `id:${field.id}` : `field:${index}`
  );

  function captureFormDrafts(root) {
    const active = document.activeElement;
    return [...root.querySelectorAll("form")].map((form, index) => ({
      key: formIdentity(form, index),
      hidden: form.hidden,
      requestId: form.dataset.requestId || "",
      submitting: Boolean(form.querySelector('button[type="submit"]')?.disabled),
      fields: [...form.querySelectorAll("input,textarea,select")].map((field, fieldIndex) => ({
        key: fieldIdentity(field, fieldIndex),
        value: field.value,
        checked: ["checkbox", "radio"].includes(field.type) ? field.checked : null,
        focused: field === active,
        selectionStart: typeof field.selectionStart === "number" ? field.selectionStart : null,
        selectionEnd: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
        selectionDirection: field.selectionDirection || "none"
      }))
    }));
  }

  function restoreFormDrafts(root, drafts) {
    let focused = null;
    root.querySelectorAll("form").forEach((form, index) => {
      const draft = drafts.find(item => item.key === formIdentity(form, index));
      if (!draft) return;
      form.hidden = draft.hidden;
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = draft.submitting;
      if (draft.requestId) form.dataset.requestId = draft.requestId;
      if (form.dataset.followUpRoot) {
        form.closest("[data-chain-id]")?.querySelector("[data-followup-compose]")
          ?.setAttribute("aria-expanded", String(!form.hidden));
      }
      form.querySelectorAll("input,textarea,select").forEach((field, fieldIndex) => {
        const saved = draft.fields.find(item => item.key === fieldIdentity(field, fieldIndex));
        if (!saved) return;
        if (saved.checked !== null) field.checked = saved.checked;
        else field.value = saved.value;
        if (saved.focused) focused = { field, saved };
      });
    });
    if (focused) {
      focused.field.focus({ preventScroll: true });
      if (focused.saved.selectionStart !== null
        && typeof focused.field.setSelectionRange === "function") {
        focused.field.setSelectionRange(
          focused.saved.selectionStart,
          focused.saved.selectionEnd,
          focused.saved.selectionDirection
        );
      }
    }
    return focused?.field || null;
  }

  function captureFocus(root) {
    const active = document.activeElement;
    if (!active || !root.contains?.(active) || !active.matches?.("button,summary,a")) return null;
    return {
      rootId: active.closest("[data-chain-id]")?.dataset.chainId,
      followUpId: active.closest("[data-followup-id]")?.dataset.followupId,
      tagName: active.tagName,
      className: active.className,
      type: active.type,
      formKey: active.closest("form") ? formIdentity(active.closest("form"), 0) : "",
      id: active.id,
      data: Object.entries(active.dataset)
    };
  }

  function restoreFocus(root, focus) {
    if (!focus) return;
    const chain = focus.rootId
      ? root.querySelector(`[data-chain-id="${escapeSelector(focus.rootId)}"]`)
      : root;
    const parent = focus.followUpId
      ? chain?.querySelector(`[data-followup-id="${escapeSelector(focus.followUpId)}"]`)
      : chain;
    const focusParent = focus.formKey
      ? [...(parent?.querySelectorAll("form") || [])].find(form => formIdentity(form, 0) === focus.formKey)
      : parent;
    const target = [...(focusParent?.querySelectorAll("button,summary,a") || [])].find(item => (
      item.tagName === focus.tagName && item.id === focus.id
      && item.className === focus.className && item.type === focus.type
      && focus.data.every(([key, value]) => item.dataset[key] === value)
    ));
    if (target) {
      target.focus({ preventScroll: true });
      currentFrame(root, () => target.isConnected && target.focus({ preventScroll: true }));
    }
  }

  function openState(root) {
    const roots = new Map();
    const followUps = new Map();
    if (renderedScope !== renderToken.scope) return { roots, followUps };
    root?.querySelectorAll(".chain-record[data-chain-id]").forEach(card => {
      roots.set(card.dataset.chainId, card.open);
      card.querySelectorAll("[data-followup-id]").forEach(entry => {
        followUps.set(`${card.dataset.chainId}:${entry.dataset.followupId}`, entry.open);
      });
    });
    return { roots, followUps };
  }

  function restoreOpenState(root, state) {
    root?.querySelectorAll("[data-chain-id]").forEach(card => {
      if (state.roots.has(card.dataset.chainId)) card.open = state.roots.get(card.dataset.chainId);
      card.querySelectorAll("[data-followup-id]").forEach(entry => {
        const key = `${card.dataset.chainId}:${entry.dataset.followupId}`;
        if (state.followUps.has(key)) entry.open = state.followUps.get(key);
      });
    });
  }

  function extraOpenState(state, extra) {
    if (extra.chainId && state.roots.get(extra.chainId) !== false) state.roots.set(extra.chainId, true);
    const key = `${extra.chainId}:${extra.followUpId}`;
    if (extra.followUpId && state.followUps.get(key) !== false) state.followUps.set(key, true);
  }

  function syncOverflow(root = surface) {
    root?.querySelectorAll(".thought-content-block:not(.followup-block)")
      .forEach(card => {
        const frame = card.querySelector(".thought-block-content-frame");
        const button = card.querySelector("[data-thought-block-expand]");
        if (!frame || !button) return;
        const expanded = expandedContent.has(button.dataset.expandKey);
        card.classList.remove("is-collapsible");
        const limit = parseFloat(
          getComputedStyle(frame).getPropertyValue("--thought-block-collapsed-height")
        ) || 420;
        const overflows = frame.scrollHeight > limit + 1;
        card.classList.toggle("is-collapsible", overflows);
        card.classList.toggle("is-expanded", overflows && expanded);
        button.hidden = !overflows;
        button.setAttribute("aria-expanded", String(overflows && expanded));
        const label = button.querySelector("span");
        if (label) label.textContent = overflows && expanded ? "收起" : "展开全文";
      });
    scheduleAnnotationLayout();
  }

  function decorate(root, chains) {
    tagCommentableTargets(root, chains);
    renderLatex(root);
    applyCommentAnchors(root);
    currentFrame(root, () => syncOverflow(root));
  }

  function renderTogether(snapshot, extraOpen) {
    const root = queryOne("#today-thoughts");
    if (!root) return false;
    const drafts = renderedScope === renderToken.scope ? captureFormDrafts(root) : [];
    const open = openState(root);
    extraOpenState(open, extraOpen);
    const items = createThoughtChains(snapshot.thoughts, "occurred")
      .filter(chain => thoughtDate(chain) === getActiveDate())
      .slice(0, 5);
    root.innerHTML = items.length
      ? presentation.cardsMarkup(items, "occurred")
      : contentState({
        title: "这一天还没有思绪",
        body: "日期里没有记录很正常，已有内容仍在其他日期。",
        action: { command: "new-thought", label: "记录一个问题" }
      });
    restoreOpenState(root, open);
    const focused = restoreFormDrafts(root, drafts);
    decorate(root, items);
    if (focused) currentFrame(root, () => focused.isConnected && focused.focus({ preventScroll: true }));
    return true;
  }

  function renderThoughtPage(snapshot, extraOpen) {
    const root = queryOne("#all-thoughts");
    if (!root) return false;
    const drafts = renderedScope === renderToken.scope ? captureFormDrafts(root) : [];
    const open = openState(root);
    extraOpenState(open, extraOpen);
    document.querySelectorAll("[data-thought-sort]").forEach(button => {
      const active = button.dataset.thoughtSort === sortMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const { chains, items } = visibleThoughtChains({
      records: snapshot.thoughts,
      mode: sortMode,
      tag: filter,
      query,
      complete: isFullRouteStateLoaded()
    });
    const activeId = route?.kind === "detail"
      && route.resourceType === "thought-chain"
      ? route.resourceId
      : "";
    const selected = activeId
      ? chains.find(chain => chain.question.id === activeId)
      : null;
    const detailMode = Boolean(selected);
    const filters = queryOne("#thought-filters");
    const sortControls = surface?.querySelector(".thought-sort");
    const searchControl = queryOne("#thought-search-control");
    const pagination = queryOne("#thought-pagination");
    surface?.classList.toggle("thought-detail-mode", detailMode);
    if (filters) filters.hidden = detailMode;
    if (sortControls) sortControls.hidden = detailMode;
    if (searchControl) searchControl.hidden = detailMode;
    root.dataset.routeMode = detailMode ? "detail" : "list";
    if (pagination) {
      const status = pagination.querySelector("#thought-pagination-status");
      status?.setAttribute("role", "status"); status?.setAttribute("aria-live", "polite");
      const page = snapshot.thoughtPage;
      pagination.hidden = detailMode || (!page?.nextCursor && !page?.stale);
      let top = surface.querySelector("#thought-pagination-top");
      if (!top) { top = document.createElement("div"); top.id = "thought-pagination-top"; top.className = "thought-pagination"; root.before(top); }
      top.hidden = detailMode || !page?.window || !page?.prevCursor;
      let previous = top.querySelector("#thought-load-previous");
      if (!previous) { previous = document.createElement("button"); previous.id = "thought-load-previous"; previous.type = "button"; previous.className = "quiet-button"; previous.textContent = "加载较新内容"; top.append(previous); }
      previous.hidden = !page?.window || !page?.prevCursor;
      let refresh = pagination.querySelector("#thought-refresh-window");
      if (!refresh) { refresh = document.createElement("button"); refresh.id = "thought-refresh-window"; refresh.type = "button"; refresh.className = "quiet-button"; refresh.textContent = "内容已变化，刷新列表"; pagination.append(refresh); }
      refresh.hidden = !page?.stale;
      const next = pagination.querySelector("#thought-load-more");
      if (next) { next.hidden = !page?.nextCursor; next.disabled = Boolean(page?.stale); }
      previous.disabled = Boolean(page?.stale);
    }
    if (detailMode) {
      root.innerHTML = presentation.cardsMarkup([selected], sortMode, { detail: true });
      if (!open.roots.has(activeId)) open.roots.set(activeId, true);
    } else {
      if (filters) {
        filters.hidden = false;
        filters.innerHTML = presentation.filtersMarkup(
          chains,
          filter,
          snapshot.thoughtPage?.kind === "list" ? snapshot.thoughtPage.tags : []
        );
      }
      if (sortControls) sortControls.hidden = false;
      if (searchControl) searchControl.hidden = false;
      const notice = routeResult?.error?.code === "RESOURCE_UNAVAILABLE"
        ? presentation.unavailableRouteMarkup(routeResult)
        : "";
      let list;
      if (items.length) {
        list = presentation.cardsMarkup(items, sortMode, { groupMonths: true });
      } else if (normalizeThoughtSearch(query)) {
        list = contentState({
          title: "没有匹配的思绪",
          body: "换一个关键词，原有记录不会受到影响。"
        });
      } else if (filter === "all") {
        list = contentState({
          title: "还没有思绪",
          body: "从一个真实问题开始，初步想法可以稍后补充。",
          action: { command: "new-thought", label: "记录第一个问题" }
        });
      } else {
        list = contentState({
          title: `#${filter} 下还没有记录`,
          body: "其他标签的思绪仍然保留。",
          action: { command: "clear-thought-filter", label: "查看全部思绪" }
        });
      }
      root.innerHTML = notice + list;
    }
    restoreOpenState(root, open);
    const focused = restoreFormDrafts(root, drafts);
    decorate(root, detailMode ? [selected] : items);
    const status = queryOne("#thought-pagination-status");
    if (status && pagination && !pagination.hidden) {
      status.textContent = `已加载 ${(snapshot.thoughts || []).length} 条`;
    }
    if (focused) currentFrame(root, () => focused.isConnected && focused.focus({ preventScroll: true }));
    return true;
  }

  function render(extraOpen = {}) {
    if (!surface || !route) return false;
    renderToken = readingState.beginRender();
    if (renderedScope !== renderToken.scope) expandedContent.clear();
    const position = renderedScope === renderToken.scope ? captureReadingPosition(surface) : null;
    const focus = renderedScope === renderToken.scope ? captureFocus(surface) : null;
    const snapshot = getSnapshot();
    const scope = audioScope();
    if (scope) audioLifecycle.beforeRender(surface, scope);
    const rendered = route.view === "together"
      ? renderTogether(snapshot, extraOpen)
      : renderThoughtPage(snapshot, extraOpen);
    if (scope) audioLifecycle.afterRender(surface, scope);
    renderedScope = renderToken.scope;
    const available = new Set([...surface.querySelectorAll("[data-expand-key]")].map(item => item.dataset.expandKey));
    for (const key of expandedContent) if (!available.has(key)) expandedContent.delete(key);
    restoreFocus(surface, focus);
    restoreReadingPosition(surface, position, renderToken);
    return rendered;
  }

  function updateRoute(nextRoute, result = null) {
    route = nextRoute;
    routeResult = result;
    if (route?.view === "thoughts") {
      filter = route.query?.tag || "all";
      sortMode = route.query?.sort === "created" ? "created" : "occurred";
      query = route.query?.q || "";
      const search = queryOne("#thought-search");
      if (search) search.value = query;
    }
  }

  function toggleExpanded(button) {
    const card = button?.closest(".thought-content-block");
    if (!card?.classList.contains("is-collapsible")) return false;
    const expanded = !card.classList.contains("is-expanded");
    if (expanded) expandedContent.add(button.dataset.expandKey);
    else expandedContent.delete(button.dataset.expandKey);
    card.classList.toggle("is-expanded", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    const label = button.querySelector("span");
    if (label) label.textContent = expanded ? "收起" : "展开全文";
    scheduleAnnotationLayout();
    if (!expanded) card.scrollIntoView({ block: "nearest" });
    return true;
  }

  function followUpFormIdentity(form) {
    if (form.dataset.followUpRoot) {
      return { rootId: form.dataset.followUpRoot, kind: "create", followUpId: "" };
    }
    if (form.dataset.followupManualAnswer) {
      return {
        rootId: form.dataset.rootId || "",
        kind: "manual-answer",
        followUpId: form.dataset.followupManualAnswer
      };
    }
    if (form.dataset.followupEdit) {
      return {
        rootId: form.dataset.rootId || "",
        kind: "edit",
        followUpId: form.dataset.followupEdit
      };
    }
    return null;
  }

  const followUpFormKey = identity => (
    `follow-up:${identity.rootId}:${identity.kind}:${identity.followUpId || ""}`
  );

  function patchTarget(target) {
    if (!surface || !route) return false;
    renderToken = readingState.beginRender();
    if (renderedScope !== renderToken.scope) expandedContent.clear();
    const position = renderedScope === renderToken.scope ? captureReadingPosition(surface) : null;
    const focus = renderedScope === renderToken.scope ? captureFocus(surface) : null;
    const chain = createThoughtChains(getSnapshot().thoughts, sortMode)
      .find(item => item.question.id === target.targetId);
    if (!chain) return false;
    const cards = [...surface.querySelectorAll(
      `[data-chain-id="${escapeSelector(target.targetId)}"]`
    )];
    if (!cards.length) return true;
    const consumedKey = target.consumeFollowUp
      ? followUpFormKey(target.consumeFollowUp)
      : "";
    for (const current of cards) {
      const drafts = captureFormDrafts(current).flatMap(draft => {
        if (draft.key !== consumedKey) return [draft];
        const submitted = target.consumeFollowUp?.submitted;
        const changed = submitted && draft.fields.some(field => {
          const name = field.key.startsWith("name:") ? field.key.slice(5) : "";
          return Object.hasOwn(submitted, name) && field.value !== submitted[name];
        });
        // ACK只消费本次提交的文本；等待期间新输入仍是用户草稿。
        return changed ? [{ ...draft, submitting: false, requestId: "" }] : [];
      });
      const open = openState(current.parentElement);
      const template = document.createElement("template");
      const detail = current.classList.contains("thought-detail-record");
      template.innerHTML = presentation.card(chain, false, sortMode, { detail }).trim();
      const next = template.content.querySelector(".chain-record");
      if (!next) continue;
      const scope = audioScope();
      if (scope) audioLifecycle.beforeRender(current, scope);
      current.replaceWith(next);
      if (scope) audioLifecycle.afterRender(next, scope);
      restoreOpenState(next.parentElement, open);
      restoreFormDrafts(next, drafts);
      decorate(next.parentElement, [chain]);
    }
    renderedScope = renderToken.scope;
    restoreFocus(surface, focus);
    restoreReadingPosition(surface, position, renderToken);
    return true;
  }

  function applySavedFollowUp(rootId, saved, { kind, followUpId = "", submitted, rootVersion }) {
    const root = (getSnapshot().thoughts || [])
      .find(item => item.id === rootId && item.type === "question");
    if (!root) return false;
    root.followUps ||= [];
    const current = root.followUps.find(item => item.id === saved.id);
    // 同步可能先于ACK接入同版或新版；事实不回退，但本次表单仍须结算。
    const changed = current
      ? Number(current.version) < Number(saved.version)
      : kind === "create" && root.version === rootVersion;
    if (changed) {
      if (current) Object.assign(current, saved);
      else root.followUps.push({ ...saved });
      root.version = Math.max(1, Number(root.version) || 1) + 1;
      root.updatedAt = saved.updatedAt || saved.createdAt || new Date().toISOString();
    }
    return patchTarget({
      targetId: rootId,
      consumeFollowUp: { rootId, kind, followUpId, submitted }
    });
  }

  return Object.freeze({
    mount(root, nextRoute, result) {
      surface = root;
      updateRoute(nextRoute, result);
    },
    updateRoute,
    render,
    syncOverflow,
    toggleExpanded,
    clear() {
      audioLifecycle?.dispose(surface);
      expandedContent.clear();
      renderedScope = "";
      readingState.invalidate();
      queryOne("#all-thoughts")?.replaceChildren();
      queryOne("#today-thoughts")?.replaceChildren();
      surface = null;
      route = null;
      routeResult = null;
    },
    route: () => route,
    sortMode: () => sortMode,
    filter: () => filter,
    query: () => query,
    setQuery(value) {
      query = String(value || "");
    },
    patchTarget,
    applySavedFollowUp,
    chains: mode => createThoughtChains(getSnapshot().thoughts, mode || sortMode),
    findChain: id => createThoughtChains(getSnapshot().thoughts, sortMode)
      .find(chain => chain.question.id === id) || null
  });
}
