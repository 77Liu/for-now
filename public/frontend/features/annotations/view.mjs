import { annotationCountLabel } from "../../../generated/annotation-counts.mjs";
import { pendingAiTaskMessage } from "../../shared/ai-task-status.mjs";
import { annotationMenuItems, annotationPresentation, groupAnnotationLineCounts, sortAnnotationItemsByPosition } from "./presentation.mjs";
import { annotationRootKey, parseAnnotationRootKey } from "./model.mjs";

export function createAnnotationView({
  model,
  document,
  window,
  escapeHtml,
  escapeSelector,
  renderMarkdown,
  renderLatex,
  contextReceiptMarkup,
  emptyStateMarkup,
  formatDate,
  contentImagesMarkup,
  persistCommentDraft,
  requestFrame,
  cancelFrame,
  matchesMedia,
  isMounted
}) {
  const { ui } = model; let lineFrame = 0;
  const frames = new Set();
  const query = selector => document.querySelector(selector);
  const queryAll = selector => [...document.querySelectorAll(selector)];
  const nextFrame = callback => {
    let frame;
    frame = requestFrame(() => { frames.delete(frame); callback(); });
    frames.add(frame);
    return frame;
  };

  /** 从同一确认集合窄刷新入口/面板数量；未知仍可打开恢复，不重绘草稿或改变阅读状态。 @since unreleased */
  function refreshCounts(rootKey = ui.activeRootKey) {
    const counts = model.counts(rootKey);
    const label = annotationCountLabel(counts);
    queryAll(`[data-annotation-count-root="${escapeSelector(rootKey)}"]`).forEach(button => {
      button.textContent = label;
      button.dataset.annotationCountState = counts.loaded ? "loaded" : "unknown";
      button.disabled = false;
    });
    if (rootKey === ui.activeRootKey) {
      const title = query("#comment-panel")?.querySelector("header h2");
      if (title) title.textContent = `${model.rootLabel(rootKey)} · ${label}`;
    }
    const reopen = query("#comment-panel-reopen");
    const oldCount = query("#comment-panel-reopen-count");
    if (oldCount) { oldCount.textContent = ""; oldCount.hidden = true; }
    if (reopen) {
      const text = reopen.querySelector("span");
      if (text) text.textContent = "返回批注";
      reopen.setAttribute("aria-label", "返回上次批注面板");
    }
    return counts;
  }

  function textNodes(container) {
    const walker = document.createTreeWalker(container, window.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.length) return window.NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("button, textarea, input")
          || parent.closest('.katex-html[aria-hidden="true"]')) {
          return window.NodeFilter.FILTER_REJECT;
        }
        return window.NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }
  const textContent = container => textNodes(container)
    .map(node => node.nodeValue)
    .join("");

  function wrapRange(container, start, end, rootKey, annotationId, kind = "comment") {
    let offset = 0;
    for (const node of textNodes(container)) {
      const nodeStart = offset;
      const nodeEnd = offset + node.nodeValue.length;
      offset = nodeEnd;
      if (end <= nodeStart || start >= nodeEnd) continue;
      const from = Math.max(0, start - nodeStart);
      const to = Math.min(node.nodeValue.length, end - nodeStart);
      if (to <= from) continue;
      const selected = node.splitText(from);
      const after = selected.splitText(to - from);
      const mark = document.createElement("mark");
      const presentation = annotationPresentation({ kind });
      mark.className = `comment-anchor ${presentation.className}`.trim();
      mark.dataset.commentRoot = rootKey;
      mark.dataset.annotationId = annotationId;
      selected.parentNode.insertBefore(mark, selected);
      mark.append(selected);
      void after;
    }
  }
  function applyAnchor(rootKey, annotation) {
    refreshCounts(rootKey);
    const current = model.rootFor(rootKey)?.annotations?.find(item => item.id === annotation.id);
    if (!current) return;
    annotation = current;
    queryAll(
      `.commentable[data-comment-root="${escapeSelector(rootKey)}"]`
      + `[data-comment-target="${escapeSelector(annotation.targetKey)}"]`
    ).forEach(element => {
      if (element.querySelector(
        `.comment-anchor[data-annotation-id="${escapeSelector(annotation.id)}"]`
      )) return;
      const text = textContent(element);
      let start = Number(annotation.start) || 0;
      let end = Number(annotation.end) || start;
      if (text.slice(start, end) !== annotation.quote) {
        start = text.indexOf(annotation.quote);
        end = start + annotation.quote.length;
      }
      if (start >= 0 && end > start) {
        wrapRange(element, start, end, rootKey, annotation.id, annotation.kind);
      }
    });
    scheduleLayout();
  }
  function removeAnchors(annotationId) {
    queryAll(
      `.comment-anchor[data-annotation-id="${escapeSelector(annotationId)}"]`
    ).forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    });
    scheduleLayout();
  }
  function applyAnchors(container) {
    const roots = new Set([...container?.querySelectorAll(".commentable") || []].map(item => item.dataset.commentRoot));
    for (const rootKey of roots) refreshCounts(rootKey);
    container?.querySelectorAll(".commentable").forEach(element => {
      const rootKey = element.dataset.commentRoot;
      const annotations = (model.rootFor(rootKey)?.annotations || [])
        .filter(item => item.targetKey === element.dataset.commentTarget)
        .sort((left, right) => right.start - left.start);
      for (const annotation of annotations) {
        const text = textContent(element);
        let start = Number(annotation.start) || 0;
        let end = Number(annotation.end) || start;
        if (text.slice(start, end) !== annotation.quote) {
          start = text.indexOf(annotation.quote);
          end = start + annotation.quote.length;
        }
        if (start >= 0 && end > start) {
          wrapRange(element, start, end, rootKey, annotation.id, annotation.kind);
        }
      }
    });
    scheduleLayout();
  }
  function renderLineCounts() {
    lineFrame = 0;
    const layer = query("#annotation-line-counts");
    layer?.setAttribute("aria-label", "行级批注导航");
    if (!layer || !isMounted()) return;
    const entries = [];
    const hosts = new Map();
    const rootTargets = new Map();
    queryAll(".commentable").forEach((host, hostIndex) => {
      if (!host.offsetParent) return;
      const rootKey = host.dataset.commentRoot;
      if (!rootTargets.has(rootKey)) {
        const targets = new Map();
        for (const item of model.counts(rootKey).threads) {
          const items = targets.get(item.targetKey) || [];
          items.push(item); targets.set(item.targetKey, items);
        }
        rootTargets.set(rootKey, targets);
      }
      const comments = rootTargets.get(rootKey).get(host.dataset.commentTarget) || [];
      if (!comments.length) return;
      const hostKey = `${host.dataset.commentRoot}|${host.dataset.commentTarget}|${hostIndex}`;
      hosts.set(hostKey, host);
      for (const annotation of comments) {
        const rects = [...host.querySelectorAll(
          `.comment-anchor[data-annotation-id="${escapeSelector(annotation.id)}"]`
        )].flatMap(mark => [...mark.getClientRects()]
          .map(rect => ({ top: rect.top, left: rect.left, height: rect.height })));
        entries.push({ hostKey, annotationId: annotation.id, rects });
      }
    });
    const groups = groupAnnotationLineCounts(entries);
    layer.innerHTML = groups.map((group, index) => {
      const host = hosts.get(group.hostKey);
      const rect = host?.getBoundingClientRect();
      const left = Math.min(
        window.scrollX + window.innerWidth - 34,
        window.scrollX + (rect?.right || 0) + 7
      );
      const top = window.scrollY + group.top - 1;
      return `<button type="button" style="left:${Math.max(window.scrollX + 2, left)}px;top:${Math.max(window.scrollY + 2, top)}px" data-comment-line="${index}" data-comment-root="${escapeHtml(host?.dataset.commentRoot || "")}" data-annotation-id="${escapeHtml(group.annotationIds[0])}" aria-label="定位本行批注" title="定位本行批注">↗</button>`;
    }).join("");
    layer.hidden = !groups.length;
  }
  function scheduleLayout() {
    if (!isMounted()) return;
    if (lineFrame) cancelFrame(lineFrame);
    lineFrame = nextFrame(renderLineCounts);
  }
  function cancelLayout() {
    for (const frame of frames) cancelFrame(frame);
    frames.clear();
    lineFrame = 0;
  }

  function selectionValue() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer;
    const endElement = range.endContainer.nodeType === 3
      ? range.endContainer.parentElement
      : range.endContainer;
    const startTarget = startElement?.closest?.(".commentable");
    const endTarget = endElement?.closest?.(".commentable");
    if (!startTarget || startTarget !== endTarget) return null;
    const quote = selection.toString().trim();
    if (!quote || quote.length > 1000) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(startTarget);
    prefix.setEnd(range.startContainer, range.startOffset);
    const raw = selection.toString();
    const start = prefix.toString().length + raw.length - raw.trimStart().length;
    return {
      rootKey: startTarget.dataset.commentRoot,
      targetKey: startTarget.dataset.commentTarget,
      start,
      end: start + quote.length,
      quote,
      rect: range.getBoundingClientRect()
    };
  }
  function showSelectionTools() {
    if (!isMounted()) return;
    const found = selectionValue();
    const tools = query("#selection-tools");
    if (!found) {
      if (tools) tools.hidden = true;
      return;
    }
    ui.pendingSelection = found;
    tools.hidden = false;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const x = Math.max(left + 8, Math.min(
      left + width - tools.offsetWidth - 8,
      found.rect.left + found.rect.width / 2 - tools.offsetWidth / 2
    ));
    const above = found.rect.top - tools.offsetHeight - 9;
    const y = above >= top + 8
      ? above
      : Math.min(top + height - tools.offsetHeight - 8, found.rect.bottom + 9);
    tools.style.left = `${x}px`;
    tools.style.top = `${Math.max(top + 8, y)}px`;
  }
  function hideSelectionTools() {
    const tools = query("#selection-tools");
    if (tools) tools.hidden = true;
  }

  function menuMarkup(annotation) {
    return `<details class="annotation-menu"><summary title="更多操作" aria-label="更多操作">⋯</summary><div role="menu">${annotationMenuItems(annotation).map(item => `<button type="button" role="menuitem" class="${item.destructive ? "danger" : ""}" ${item.id === "delete" ? `data-comment-delete="${escapeHtml(annotation.id)}"` : `data-annotation-menu="${escapeHtml(item.id)}" data-annotation-id="${escapeHtml(annotation.id)}"`}>${escapeHtml(item.label)}</button>`).join("")}</div></details>`;
  }
  function annotationCard(annotation) {
    const presentation = annotationPresentation(annotation);
    const mark = ["highlight", "emphasis"].includes(annotation.kind);
    const { id: targetId } = parseAnnotationRootKey(ui.activeRootKey);
    const pending = model.pendingTask("annotationShenji", targetId, annotation.id);
    const assistant = (annotation.shenji || []).map(item => (
      `<div class="shenji-turn">${item.message ? `<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>` : ""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${renderMarkdown(item.answer)}</div>${contextReceiptMarkup(item.contextReceipt, item.citations, item.citationStatus, item.providedReferences)}<small>${formatDate(item.createdAt)}</small></div>`
    )).join("");
    const images = contentImagesMarkup(annotation, "comment");
    const replyMarkup = mark ? "" : `
      ${annotation.text ? `<p>${escapeHtml(annotation.text)}</p>` : ""}
      <small>${formatDate(annotation.createdAt)}</small>
      ${(annotation.replies || []).map(reply => (
        `<div class="comment-reply"><p>${escapeHtml(reply.text)}</p><small>${formatDate(reply.createdAt)}</small></div>`
      )).join("")}
      <form class="comment-reply-form" data-comment-reply="${annotation.id}">
        <input placeholder="回复这条评论…" required><button type="submit">回复</button>
      </form>`;
    const pendingMessage = pending
      ? escapeHtml(pendingAiTaskMessage(pending, "回复正在后台生成，可继续使用其他功能。"))
      : "";
    const assistantForm = `<form class="shenji-form" data-shenji-form="${annotation.id}" data-comment-root="${escapeHtml(ui.activeRootKey)}" ${ui.activeAssistantComposer === annotation.id ? "" : "hidden"}>
      <div>
        <span class="shenji-label">@神鸡</span>
        <textarea name="message" rows="3" placeholder="可留空直接询问标记内容，也可补充你的问题…"></textarea>
      </div>
      <button type="submit" ${pending ? "disabled" : ""}>发送</button>
      <p class="shenji-status" role="status">${pendingMessage}</p>
    </form>`;
    return `<article class="comment-card ${mark ? `${presentation.kind}-card` : ""} ${ui.activeAnnotationId === annotation.id ? "active" : ""}" data-comment-card="${annotation.id}">
      ${mark ? `<span class="annotation-kind">${escapeHtml(presentation.label)}</span>` : ""}
      <blockquote>${escapeHtml(annotation.quote)}</blockquote>
      ${replyMarkup}${images}
      ${assistant ? `<div class="shenji-thread">${assistant}</div>` : ""}
      ${assistantForm}
      <div class="annotation-actions">
        <button type="button" class="shenji-toggle" data-shenji-toggle="${annotation.id}">@神鸡</button>
        ${menuMarkup(annotation)}
      </div>
    </article>`;
  }
  function driftCard(annotation) {
    const context = annotation.originalContext
      || { before: "", focus: annotation.quote, after: "" };
    const replies = (annotation.replies || []).map(item => (
      `<div class="comment-reply"><p>${escapeHtml(item.text)}</p><small>${formatDate(item.createdAt)}</small></div>`
    )).join("");
    const assistant = (annotation.shenji || []).map(item => (
      `<div class="shenji-turn">${item.message ? `<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>` : ""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${renderMarkdown(item.answer)}</div>${contextReceiptMarkup(item.contextReceipt, item.citations, item.citationStatus, item.providedReferences)}</div>`
    )).join("");
    return `<article class="drift-card" data-drift-card="${annotation.id}"><div class="drift-meta"><span>${annotation.kind === "highlight" ? "失效划线" : "失效评论"}</span><small>${escapeHtml(annotation.driftReason || "原文已变化")}</small></div><div class="drift-context"><span>${escapeHtml(context.before)}</span><mark>${escapeHtml(context.focus || annotation.quote)}</mark><span>${escapeHtml(context.after)}</span></div>${annotation.text ? `<p>${escapeHtml(annotation.text)}</p>` : ""}${replies}${assistant}<button type="button" class="comment-delete" data-drift-delete="${annotation.id}">删除漂流记录</button></article>`;
  }
  function visibleNode(selector, quote = "") {
    const visible = queryAll(selector).filter(node => node.getClientRects().length);
    return visible.find(node => !quote || textContent(node).includes(quote))
      || visible[0]
      || null;
  }
  function layoutAnchor() {
    const active = ui.activeAnnotationId
      ? visibleNode(
        `.comment-anchor[data-comment-root="${escapeSelector(ui.activeRootKey)}"]`
        + `[data-annotation-id="${escapeSelector(ui.activeAnnotationId)}"]`
      )
      : null;
    const selected = ui.pendingSelection?.rootKey === ui.activeRootKey
      ? visibleNode(
        `.commentable[data-comment-root="${escapeSelector(ui.activeRootKey)}"]`
        + `[data-comment-target="${escapeSelector(ui.pendingSelection.targetKey)}"]`,
        ui.pendingSelection.quote
      )
      : null;
    return active
      || selected
      || visibleNode(`.commentable[data-comment-root="${escapeSelector(ui.activeRootKey)}"]`);
  }
  function stabilizeAnchor(anchor, top, attempt = 0) {
    if (!Number.isFinite(top) || !matchesMedia("(min-width:1200px)")
      || !anchor?.isConnected) return scheduleLayout();
    const current = anchor.getBoundingClientRect().top;
    if (Math.abs(current - top) > 0.5) window.scrollBy(0, current - top);
    if (attempt < 5) {
      return nextFrame(() => stabilizeAnchor(anchor, top, attempt + 1));
    }
    scheduleLayout();
  }
  function setPanelVisibility(open) {
    const panel = query("#comment-panel");
    const reopen = query("#comment-panel-reopen");
    const anchor = layoutAnchor();
    const before = anchor?.getBoundingClientRect().top;
    ui.panelOpen = Boolean(open && ui.activeRootKey);
    if (panel) panel.hidden = !ui.panelOpen;
    document.body.classList.toggle("comment-panel-open", ui.panelOpen);
    if (reopen) reopen.hidden = ui.panelOpen || !ui.activeRootKey;
    nextFrame(() => stabilizeAnchor(anchor, before));
  }
  function closePanel() {
    queryAll("#comment-panel [data-shenji-form]").forEach(model.stashAssistantDraft);
    void persistCommentDraft();
    setPanelVisibility(false);
    hideSelectionTools();
    window.getSelection()?.removeAllRanges();
  }
  function renderPanel({ focusActive = false } = {}) {
    const panel = query("#comment-panel");
    if (!panel) return false;
    const sameRoot = panel.dataset.commentRoot === ui.activeRootKey;
    const scrollTop = sameRoot ? panel.scrollTop : 0;
    panel.querySelectorAll("[data-shenji-form]").forEach(model.stashAssistantDraft);
    const root = model.rootFor(ui.activeRootKey);
    if (!ui.activeRootKey || !root) {
      Object.assign(ui, {
        activeRootKey: "",
        activeAnnotationId: "",
        activeAssistantComposer: ""
      });
      setPanelVisibility(false);
      return false;
    }
    panel.dataset.commentRoot = ui.activeRootKey;
    panel.querySelector("header h2").textContent = `${model.rootLabel(ui.activeRootKey)}批注`;
    const composer = query("#comment-composer");
    if (composer) composer.hidden = ui.pendingSelection?.rootKey !== ui.activeRootKey;
    if (ui.pendingSelection?.rootKey === ui.activeRootKey) {
      query("#comment-quote").textContent = ui.pendingSelection.quote;
    }
    const counts = refreshCounts(ui.activeRootKey);
    const annotations = sortAnnotationItemsByPosition(counts.entries);
    const drift = [...counts.drift]
      .sort((left, right) => (
        right.driftedAt || right.createdAt
      ).localeCompare(left.driftedAt || left.createdAt));
    const live = annotations.length
      ? annotations.map(annotationCard).join("")
      : emptyStateMarkup(counts.loaded
        ? "还没有有效评论或标记。选中正文后即可添加。"
        : "批注尚未完整加载，请打开完整详情后查看。数量暂未知。");
    const driftSection = drift.length
      ? `<section class="drift-box"><header><h3>评论漂流箱</h3><span>${drift.length}</span></header><p class="drift-help">原文被改写或删除后，无法可靠定位的批注会保留在这里。</p>${drift.map(driftCard).join("")}</section>`
      : "";
    const warning = ui.refreshFailureRoot === ui.activeRootKey
      ? '<p class="status" role="status">批注已保存，当前呈现尚未同步。<button type="button" class="subtle-action" data-annotation-refresh>重试读取批注</button></p>'
      : "";
    query("#comment-panel-list").innerHTML = warning + live + driftSection;
    panel.querySelectorAll("[data-shenji-form]").forEach(model.hydrateAssistantForm);
    renderLatex(query("#comment-panel-list"));
    setPanelVisibility(ui.panelOpen);
    nextFrame(() => {
      if (focusActive && ui.activeAnnotationId) {
        const card = panel.querySelector(
          `[data-comment-card="${escapeSelector(ui.activeAnnotationId)}"]`
        );
        if (card) panel.scrollTop = Math.max(0, card.offsetTop - panel.clientHeight / 3);
      } else if (sameRoot) {
        panel.scrollTop = scrollTop;
      }
    });
    return true;
  }
  function refreshAnnotation(annotation) {
    annotation = model.rootFor(ui.activeRootKey)?.annotations?.find(item => item.id === annotation.id);
    if (!annotation) return renderPanel();
    const current = query(
      `[data-comment-card="${escapeSelector(annotation.id)}"]`
    );
    if (!current) return renderPanel();
    refreshCounts(ui.activeRootKey);
    model.stashAssistantDraft(current.querySelector("[data-shenji-form]"));
    const composerOpen = !current.querySelector("[data-shenji-form]")?.hidden;
    const template = document.createElement("template");
    template.innerHTML = annotationCard(annotation).trim();
    const next = template.content.firstElementChild;
    current.replaceWith(next);
    const composer = next.querySelector("[data-shenji-form]");
    model.hydrateAssistantForm(composer);
    if (composer) composer.hidden = !composerOpen;
    renderLatex(next);
    scheduleLayout();
    return true;
  }
  function openPanel(rootKey, annotationId = "") {
    ui.activeRootKey = rootKey;
    ui.activeAnnotationId = annotationId;
    ui.panelOpen = true;
    return renderPanel({ focusActive: Boolean(annotationId) });
  }
  function markTarget(element, rootKey, targetKey) {
    if (!element) return false;
    element.classList.add("commentable");
    element.dataset.commentRoot = rootKey;
    element.dataset.commentTarget = targetKey;
    return true;
  }
  function tagThoughtTargets(container, chains) {
    [...(container?.querySelectorAll(".chain-record") || [])].forEach((card, index) => {
      const chain = chains[index];
      if (!chain || chain.question._sync) return;
      const rootId = chain.question.id;
      const rootKey = annotationRootKey("thought", rootId);
      markTarget(card.querySelector(".thought-question-content"), rootKey, `question:${rootId}`);
      card.querySelectorAll("[data-thought-block-id]").forEach(element => {
        const item = chain.children.find(
          value => value.id === element.dataset.thoughtBlockId
        );
        if (item) {
          markTarget(
            element.querySelector(".thought-block-content"),
            rootKey,
            `${item.type}:${item.id}`
          );
        }
      });
      card.querySelectorAll(".response-entry[data-followup-id]").forEach(entry => {
        const id = entry.dataset.followupId;
        markTarget(
          entry.querySelector(".followup-question .markdown-content"),
          rootKey,
          `followup-question:${id}`
        );
        markTarget(
          entry.querySelector(".followup-answer .model-answer-content > .markdown-content"),
          rootKey,
          `followup-answer:${id}`
        );
      });
    });
  }
  function commentDraftContext() {
    if (!ui.pendingSelection) return null;
    return {
      selection: { ...ui.pendingSelection },
      text: query("#comment-text")?.value || "",
      requestId: query("#comment-composer")?.dataset.requestId || "",
      assistantClientRequestId:
        query("#comment-composer")?.dataset.assistantClientRequestId || ""
    };
  }
  function restoreCommentDraft(context) {
    const selection = context?.selection;
    if (!selection) return "invalid";
    const root = model.rootFor(selection.rootKey);
    const target = root ? query(
      `.commentable[data-comment-root="${escapeSelector(selection.rootKey)}"]`
      + `[data-comment-target="${escapeSelector(selection.targetKey)}"]`
    ) : null;
    if (!root || !target) return false;
    const source = textContent(target);
    const start = source.slice(selection.start, selection.end) === selection.quote
      ? selection.start
      : source.indexOf(selection.quote);
    if (start < 0) return "invalid";
    ui.pendingSelection = {
      ...selection,
      start,
      end: start + selection.quote.length
    };
    ui.activeRootKey = selection.rootKey;
    ui.panelOpen = true;
    query("#comment-text").value = context.text || "";
    const form = query("#comment-composer");
    if (context.requestId) form.dataset.requestId = context.requestId;
    if (context.assistantClientRequestId) {
      form.dataset.assistantClientRequestId = context.assistantClientRequestId;
    }
    renderPanel();
    return true;
  }
  function resetDom() {
    for (const selector of ["#comment-panel", "#comment-panel-reopen",
      "#selection-tools", "#annotation-line-counts"]) {
      const element = query(selector);
      if (element) element.hidden = true;
    }
    const list = query("#comment-panel-list");
    if (list) list.replaceChildren();
    const panel = query("#comment-panel");
    if (panel) delete panel.dataset.commentRoot;
    document.body.classList.remove("comment-panel-open");
  }

  return Object.freeze({
    query,
    textContent,
    applyAnchor,
    removeAnchors,
    applyAnchors,
    scheduleLayout,
    cancelLayout,
    showSelectionTools,
    hideSelectionTools,
    closePanel,
    renderPanel,
    refreshCounts,
    refreshAnnotation,
    openPanel,
    markTarget,
    tagThoughtTargets,
    commentDraftContext,
    restoreCommentDraft,
    resetDom
  });
}
