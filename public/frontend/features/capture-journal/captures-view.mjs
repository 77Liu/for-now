import { eventDate, eventTimestamp } from "../../time/index.mjs";
import {
  captureCardMarkup,
  formatAudioDuration,
  formatBytes,
  matchesFeedSearch
} from "./presentation.mjs";

export function createCapturesView({
  data,
  media,
  annotations,
  view,
  platform,
  getRoot,
  getAudio,
  getDraftTags,
  getSearchQuery,
  isEditorOpen,
  isSubmitting
} = {}) {
  const expandedKeys = new Set();
  const query = selector => getRoot()?.querySelector(selector) || null;
  const queryAll = selector => [...(getRoot()?.querySelectorAll(selector) || [])];

  function showStatus(selector, message) {
    const element = query(selector);
    if (element) element.textContent = message;
  }

  function renderAudio() {
    if (!getRoot()) return false;
    const audio = getAudio();
    const state = audio.snapshot();
    const preview = query("#capture-audio-preview");
    const player = query("#capture-audio-player");
    if (!preview || !player) return false;
    const source = state.preview
      || (state.path ? view.appUrl(state.path) : "")
      || (state.uploadedPath ? view.appUrl(state.uploadedPath) : "");
    const recorder = query("#capture-audio-recorder");
    if ((state.active || state.startPending) && recorder) recorder.open = true;
    const record = query("#capture-audio-record");
    const pause = query("#capture-audio-pause");
    const stop = query("#capture-audio-stop");
    const remove = query("#capture-audio-remove");
    const file = query("#capture-audio-file");
    const paused = state.recordingState === "paused";
    const submitting = isSubmitting();
    if (record) {
      record.hidden = state.active;
      record.disabled = state.startPending || submitting;
    }
    if (pause) {
      pause.hidden = !state.active;
      pause.disabled = submitting;
      pause.textContent = paused ? "▶" : "Ⅱ";
      pause.title = paused ? "继续录音" : "暂停录音";
      pause.setAttribute("aria-label", pause.title);
    }
    if (stop) {
      stop.hidden = !state.active;
      stop.disabled = submitting;
    }
    if (file) file.disabled = state.active || state.startPending || submitting;
    if (remove) {
      remove.hidden = !state.active && !source;
      remove.disabled = state.startPending || submitting;
      remove.title = state.active ? "取消录音" : "移除语音";
      remove.setAttribute("aria-label", remove.title);
    }
    preview.hidden = !source;
    if (source) {
      const absolute = new URL(source, platform.location.href).href;
      if (player.src !== absolute) player.src = source;
    } else {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    showStatus(
      "#capture-audio-meta",
      source ? `${formatAudioDuration(state.durationMs)} · ${formatBytes(state.bytes)}` : ""
    );
    const elapsed = platform.now() - state.startedAt - state.pausedTotal
      - (paused ? platform.now() - state.pausedAt : 0);
    let status = "";
    if (state.startPending) status = "正在请求麦克风权限…";
    else if (state.active) {
      status = `${paused ? "录音已暂停" : "正在录音"} ${formatAudioDuration(elapsed)} / 10:00`;
    } else if (state.notice) status = state.notice.includes("恢复")
      ? `已恢复 ${formatAudioDuration(state.durationMs)} 的待提交语音。`
      : state.notice;
    else if (state.lastError) status = state.lastError;
    else if (source) {
      status = data.getSnapshot().speech?.configured
        ? "录音已保留；提交后可在后台转成文字。"
        : "录音已保留；暂时不能转成文字。";
    } else if (typeof platform.MediaRecorder !== "function") {
      status = "当前浏览器不支持直接录音，可导入音频文件。";
    }
    showStatus("#capture-audio-status", status);
    return true;
  }

  function renderTags() {
    const list = query("#capture-tag-list");
    const suggestions = query("#capture-tag-suggestions");
    if (!list || !suggestions) return false;
    const draftTags = getDraftTags();
    list.innerHTML = draftTags.map(tag => (
      `<span class="tag-chip">#${view.escapeMarkup(tag)}<button type="button" data-remove-capture-tag="${view.escapeMarkup(tag)}" aria-label="移除关键词 ${view.escapeMarkup(tag)}">×</button></span>`
    )).join("");
    const snapshot = data.getSnapshot();
    const known = [...new Set([
      ...(snapshot.captures || []),
      ...(snapshot.thoughts || [])
    ].flatMap(item => item.tags || []))].filter(tag => !draftTags.includes(tag));
    suggestions.innerHTML = known.map(tag => (
      `<option value="${view.escapeMarkup(tag)}"></option>`
    )).join("");
    return true;
  }

  function syncSpeechOverflow(scope = getRoot()) {
    scope?.querySelectorAll("[data-speech-text-lines]").forEach(layer => {
      const frame = layer.querySelector(".speech-text-frame");
      const content = frame?.firstElementChild;
      const button = layer.querySelector("[data-speech-text-expand]");
      if (!frame || !content || !button) return;
      const expanded = layer.classList.contains("is-expanded");
      const lines = Math.max(1, Number(layer.dataset.speechTextLines) || 1);
      const lineHeight = Number.parseFloat(platform.getComputedStyle(content).lineHeight) || 20;
      const overflows = frame.scrollHeight > lines * lineHeight + 1;
      layer.classList.toggle("is-collapsible", overflows);
      layer.classList.toggle("is-expanded", overflows && expanded);
      button.hidden = !overflows;
      button.textContent = overflows && expanded ? "收起" : "展开";
      button.setAttribute("aria-expanded", String(overflows && expanded));
      button.setAttribute(
        "aria-label",
        `${overflows && expanded ? "收起" : "展开"}${layer.dataset.speechTextLabel || "文稿"}`
      );
    });
  }

  function syncOverflow() {
    queryAll(".capture-item").forEach(card => {
      const viewport = card.querySelector(".capture-content-viewport");
      const button = card.querySelector("[data-capture-expand]");
      if (!viewport || !button) return;
      const wasExpanded = expandedKeys.has(card.dataset.expandKey);
      viewport.classList.remove("expanded");
      const overflows = viewport.scrollHeight > viewport.clientHeight + 1;
      const expanded = wasExpanded && overflows;
      viewport.classList.toggle("expanded", expanded);
      card.classList.toggle("is-expandable", overflows);
      card.classList.toggle("is-expanded", expanded);
      button.hidden = !overflows;
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", expanded ? "收起捕念" : "展开捕念");
    });
    annotations.scheduleLayout();
  }

  function renderList() {
    if (!getRoot()) return false;
    const snapshot = data.getSnapshot();
    const allItems = [...(snapshot.captures || [])]
      .sort((left, right) => eventTimestamp(right).localeCompare(eventTimestamp(left)));
    const searchQuery = getSearchQuery();
    const items = allItems.filter(item => matchesFeedSearch(
      searchQuery,
      item.content,
      item.tags,
      item.transcription?.rawText,
      item.transcription?.polishedText,
      item.transcription?.condensedText
    ));
    const form = query("#capture-form");
    const editor = query("#capture-editor");
    const toggle = query("#capture-create-toggle");
    const editing = Boolean(query("#capture-id")?.value);
    if (form) form.hidden = !isEditorOpen();
    if (editor) editor.hidden = !isEditorOpen();
    showStatus("#capture-editor-title", editing ? "编辑念起" : "记录念起");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(isEditorOpen()));
      toggle.textContent = isEditorOpen() ? "收起" : "＋ 捕念";
      toggle.disabled = isSubmitting();
    }
    showStatus(
      "#capture-count",
      searchQuery ? `${items.length} / ${allItems.length} 条` : `${allItems.length} 条`
    );
    const list = query("#capture-list");
    if (!list) return false;
    list.innerHTML = items.length
      ? items.map((item, index) => captureCardMarkup({
        item,
        showDate: index === 0 || eventDate(item) !== eventDate(items[index - 1]),
        snapshot,
        appUrl: view.appUrl,
        contentImagesMarkup: media.contentImagesMarkup
      })).join("")
      : allItems.length
        ? view.contentState({
          title: "没有匹配的念起",
          body: "换一个关键词，原有记录不会受到影响。"
        })
        : view.contentState({
          title: "还没有捕念",
          body: "刚开始为空很正常。文字、图片或录音都可以单独留下。",
          action: { command: "new-capture", label: "留下第一条" }
        });
    for (const item of items.filter(value => !value._sync)) {
      annotations.markTarget(
        list.querySelector(
          `[data-capture-id="${platform.escapeSelector(item.id)}"] .capture-copy .markdown-content`
        ),
        annotations.rootKey("capture", item.id),
        "content"
      );
    }
    view.renderLatex(list);
    annotations.applyAnchors(list);
    platform.requestFrame(() => {
      syncSpeechOverflow(list);
      syncOverflow();
    });
    return true;
  }

  function render() {
    renderList();
    renderTags();
    renderAudio();
    media.renderEditor("capture");
    return true;
  }

  function toggleCard(card) {
    if (!card?.classList.contains("is-expandable")) return false;
    const viewport = card.querySelector(".capture-content-viewport");
    const button = card.querySelector("[data-capture-expand]");
    const expanded = !viewport.classList.contains("expanded");
    if (expanded) expandedKeys.add(card.dataset.expandKey);
    else expandedKeys.delete(card.dataset.expandKey);
    viewport.classList.toggle("expanded", expanded);
    card.classList.toggle("is-expanded", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", expanded ? "收起捕念" : "展开捕念");
    annotations.scheduleLayout();
    return true;
  }

  return Object.freeze({
    query,
    showStatus,
    renderAudio,
    renderTags,
    renderList,
    render,
    syncSpeechOverflow,
    syncOverflow,
    toggleCard,
    resetSession() {
      expandedKeys.clear();
    }
  });
}
