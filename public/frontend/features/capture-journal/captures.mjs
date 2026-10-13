import { normalizeTtsPlaybackRate } from "../../media/index.mjs";
import { createCaptureAudioDraft } from "./capture-audio.mjs";
import { createCaptureDraftStore } from "./capture-drafts.mjs";
import { createCaptureOperations } from "./captures-operations.mjs";
import { createCapturesView } from "./captures-view.mjs";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Captures feature ${group} requires ${name}`);
    }
  }
}

export function createCapturesFeatureController({
  data = {},
  navigation = {},
  media = {},
  drafts = {},
  annotations = {},
  crossDomain = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    request: data.request,
    requestV1: data.requestV1,
    requestHeadStatus: data.requestHeadStatus,
    requestBlob: data.requestBlob,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection,
    publish: data.publish
  });
  requireFunctions("navigation port", {
    openThoughtDetail: navigation.openThoughtDetail
  });
  requireFunctions("media port", {
    snapshot: media.snapshot,
    activateDraft: media.activateDraft,
    renderEditor: media.renderEditor,
    resetEditor: media.resetEditor,
    replaceTransient: media.replaceTransient,
    persistDraft: media.persistDraft,
    submitDraft: media.submitDraft,
    completeDraft: media.completeDraft,
    rollbackDraft: media.rollbackDraft,
    selectFiles: media.selectFiles,
    removeItem: media.removeItem,
    contentImagesMarkup: media.contentImagesMarkup
  });
  requireFunctions("draft port", {
    getItem: drafts.storage?.getItem,
    setItem: drafts.storage?.setItem,
    removeItem: drafts.storage?.removeItem,
    getAccountId: drafts.getAccountId
  });
  requireFunctions("annotation port", {
    markTarget: annotations.markTarget,
    applyAnchors: annotations.applyAnchors,
    scheduleLayout: annotations.scheduleLayout,
    rootKey: annotations.rootKey
  });
  requireFunctions("cross-domain port", {
    promoteToThought: crossDomain.promoteToThought,
    scheduleNotificationPoll: crossDomain.scheduleNotificationPoll
  });
  requireFunctions("view port", {
    appUrl: view.appUrl,
    contentState: view.contentState,
    renderLatex: view.renderLatex,
    showToast: view.showToast,
    presentError: view.presentError,
    resetOccurrenceInput: view.resetOccurrenceInput,
    occurrenceFields: view.occurrenceFields,
    trapFocus: view.trapFocus,
    escapeMarkup: view.escapeMarkup,
    entryKeyIntent: view.entryKeyIntent
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    requestFrame: platform.requestFrame,
    setTimer: platform.setTimer,
    clearTimer: platform.clearTimer,
    getComputedStyle: platform.getComputedStyle,
    confirm: platform.confirm,
    encodeAudio: platform.encodeAudio,
    readAudioDuration: platform.readAudioDuration,
    repeat: platform.repeat,
    cancelRepeat: platform.cancelRepeat,
    now: platform.now,
    performanceNow: platform.performance?.now,
    performanceEnabled: platform.performanceEnabled,
    escapeSelector: platform.escapeSelector
  });
  if (!platform.document || !platform.window || !platform.audio || !platform.draftStore) {
    throw new TypeError("Captures feature requires document, window, audio and draftStore");
  }

  const { document, window } = platform;
  const draftStore = createCaptureDraftStore(drafts);
  let activation = null;
  let surface = null;
  let unmountPromise = null;
  let submissionPromise = null;
  let session = {};
  let editorSerial = 0;
  let editorOpen = false;
  let editorTrigger = null;
  let suspendedCreateDraft = null;
  let draftTags = [];
  let searchQuery = "";
  let draftRestored = false;
  let audio;
  const root = () => activation?.root || surface;
  const query = selector => root()?.querySelector(selector) || null;
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

  const captureView = createCapturesView({
    data,
    media,
    annotations,
    view,
    platform,
    getRoot: root,
    getAudio: () => audio,
    requestHeadStatus: data.requestHeadStatus,
    getDraftTags: () => draftTags,
    getSearchQuery: () => searchQuery,
    getGenerationRate: () => data.getSpeechGenerationRate?.(),
    getPlayerScope: () => ({
      accountId: String(data.getAccountId() || ""),
      sessionId: data.getSessionSerial(),
      pageToken: activation || session
    }),
    isEditorOpen: () => editorOpen,
    isSubmitting: () => Boolean(submissionPromise)
  });

  audio = createCaptureAudioDraft({
    store: platform.draftStore,
    request: data.request,
    getAccountId: data.getAccountId,
    isEditing: () => Boolean(query("#capture-id")?.value),
    presentError: view.presentError,
    onChange: () => captureView.renderAudio(),
    encodeAudio: platform.encodeAudio,
    readDuration: platform.readAudioDuration,
    mediaDevices: platform.mediaDevices,
    MediaRecorderConstructor: platform.MediaRecorder,
    BlobConstructor: platform.Blob,
    objectUrls: platform.objectUrls,
    createId: platform.createRequestId,
    now: platform.now,
    setTimer: platform.repeat,
    clearTimer: platform.cancelRepeat,
    confirmReplace: platform.confirm
  });

  function commitTags() {
    const input = query("#capture-tags");
    const values = String(input?.value || "").split(/[,，#\s]+/)
      .map(value => value.trim()).filter(Boolean);
    for (const value of values) if (!draftTags.includes(value)) draftTags.push(value);
    if (input) input.value = "";
    captureView.renderTags();
  }

  function focusTarget(trigger = editorTrigger) {
    if (trigger?.element?.isConnected) return trigger.element;
    if (trigger?.captureId) {
      return root()?.querySelector(
        `[data-capture-id="${platform.escapeSelector(trigger.captureId)}"] [data-capture-edit]`
      );
    }
    return query("#capture-create-toggle");
  }

  function snapshotCreateDraft() {
    const imageDraft = media.snapshot("capture");
    return {
      form: draftStore.captureForm(query("#capture-form")),
      tags: [...draftTags],
      images: {
        uploadRequestId: imageDraft.uploadRequestId,
        context: imageDraft.context,
        items: imageDraft.items.map(item => ({ ...item, preview: "" }))
      },
      audio: audio.exportDraft()
    };
  }

  async function restoreSuspendedDraft() {
    const snapshot = suspendedCreateDraft;
    if (!snapshot) return false;
    media.replaceTransient("capture", snapshot.images);
    await audio.replaceDraft(snapshot.audio);
    draftTags = [...snapshot.tags];
    draftStore.restoreForm(query("#capture-form"), snapshot.form);
    media.renderEditor("capture");
    captureView.renderAudio();
    captureView.renderTags();
    suspendedCreateDraft = null;
    return true;
  }

  function openEditor(trigger = null) {
    if (submissionPromise) {
      view.showToast("上一条捕念仍在保存，请稍候。", "error");
      return false;
    }
    if (query("#capture-id")?.value) void resetForm({ restoreFocus: false });
    editorSerial += 1;
    editorTrigger = {
      element: trigger?.isConnected ? trigger : query("#capture-create-toggle"),
      captureId: ""
    };
    editorOpen = true;
    captureView.render();
    document.body.classList.add("capture-editor-open");
    platform.requestFrame(() => query("#capture-content")?.focus());
    return true;
  }

  async function closeEditor({ restoreFocus = true } = {}) {
    if (!editorOpen) return false;
    const serial = ++editorSerial;
    const editingId = query("#capture-id")?.value;
    const trigger = editorTrigger;
    audio.invalidatePendingStart();
    editorOpen = false;
    document.body.classList.remove("capture-editor-open");
    captureView.renderList();
    if (submissionPromise) return true;
    await audio.stop();
    draftStore.save(query("#capture-form"), draftTags, { editing: Boolean(editingId) });
    await Promise.all([media.persistDraft("capture"), audio.persist()]).catch(noop);
    if (serial !== editorSerial) return false;
    if (!audio.snapshot().blob && !audio.snapshot().path && !audio.snapshot().uploadedPath) {
      const recorder = query("#capture-audio-recorder");
      if (recorder) recorder.open = false;
    }
    if (editingId) await resetForm({ restoreFocus: false });
    else editorTrigger = null;
    const target = focusTarget(trigger);
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
    return true;
  }

  async function resetForm({
    preserveUploads = false,
    restoreFocus = true,
    submitted = false
  } = {}) {
    editorSerial += 1;
    const form = query("#capture-form");
    const editingId = query("#capture-id")?.value;
    const trigger = editorTrigger;
    editorOpen = false;
    form?.reset();
    if (form) delete form.dataset.requestId;
    if (query("#capture-id")) query("#capture-id").value = "";
    if (submitted) {
      await Promise.all([media.completeDraft("capture"), audio.complete()]);
    } else {
      await Promise.all([
        media.resetEditor("capture", [], {
          forget: !preserveUploads,
          preserveStored: Boolean(editingId)
        }),
        audio.clear({
          forget: !preserveUploads,
          preserveStored: Boolean(editingId)
        })
      ]);
    }
    draftTags = [];
    captureView.renderTags();
    view.resetOccurrenceInput(query("#capture-date"));
    captureView.showStatus("#capture-submit", "收下");
    const cancel = query("#capture-cancel");
    if (cancel) cancel.hidden = true;
    captureView.showStatus("#capture-status", "");
    const editor = query("#capture-editor");
    if (editor) editor.hidden = true;
    document.body.classList.remove("capture-editor-open");
    if (editingId) {
      if (await restoreSuspendedDraft()) {
        await Promise.all([media.persistDraft("capture"), audio.persist()]);
      } else {
        draftStore.clear();
      }
    } else {
      draftStore.clear();
    }
    editorTrigger = null;
    captureView.render();
    const target = focusTarget(trigger);
    if (restoreFocus && target?.isConnected) {
      platform.requestFrame(() => target.focus({ preventScroll: true }));
    }
    return true;
  }

  async function editCapture(id, trigger) {
    const item = (data.getSnapshot().captures || []).find(value => value.id === id);
    if (!item) return false;
    if (query("#capture-id")?.value === item.id) return openEditor(trigger);
    if (query("#capture-id")?.value) await resetForm({ restoreFocus: false });
    editorSerial += 1;
    draftStore.save(query("#capture-form"), draftTags);
    suspendedCreateDraft = snapshotCreateDraft();
    const persistCreateDraft = Promise.all([
      media.persistDraft("capture"),
      audio.persist()
    ]).catch(noop);
    editorTrigger = { element: trigger, captureId: item.id };
    editorOpen = true;
    query("#capture-id").value = item.id;
    if (query("#capture-title")) query("#capture-title").value = item.title || "";
    query("#capture-content").value = item.content;
    const resetImages = media.resetEditor("capture", item.attachmentPaths || [], {
      forget: false,
      preserveStored: true
    });
    const resetAudio = audio.setExisting(item.audio, { preserveStored: true });
    draftTags = [...(item.tags || [])];
    query("#capture-tags").value = "";
    view.resetOccurrenceInput(query("#capture-date"), item);
    captureView.showStatus("#capture-submit", "保存修改");
    query("#capture-cancel").hidden = false;
    captureView.showStatus("#capture-status", "正在编辑已有捕念");
    document.body.classList.add("capture-editor-open");
    captureView.render();
    query("#capture-content")?.focus();
    await Promise.all([persistCreateDraft, resetImages, resetAudio]);
    captureView.renderAudio();
    media.renderEditor("capture");
    return true;
  }

  const operations = createCaptureOperations({
    data,
    media,
    audio,
    crossDomain,
    view,
    platform,
    captureView,
    query,
    getDraftTags: () => draftTags,
    commitTags,
    resetForm,
    sessionTicket,
    sameSession
  });

  async function handleClick(event) {
    const button = event.target.closest("button");
    const editor = query("#capture-editor");
    if (event.target === editor) return closeEditor();
    if (!button) {
      const card = event.target.closest(".capture-item");
      if (!card?.classList.contains("is-expandable")) return false;
      if (event.target.closest("a,input,textarea,select,audio,video,.capture-audio-record,.speech-asset-controls,.comment-anchor")) return false;
      if (!window.getSelection()?.isCollapsed) return false;
      return captureView.toggleCard(card);
    }
    if (button.id === "capture-create-toggle") {
      return editorOpen ? closeEditor() : openEditor(button);
    }
    if (submissionPromise && [
      "capture-editor-close",
      "capture-cancel",
      "capture-audio-record",
      "capture-audio-pause",
      "capture-audio-stop",
      "capture-audio-remove"
    ].includes(button.id)) return false;
    if (button.id === "capture-editor-close") return closeEditor();
    if (button.id === "capture-cancel") return resetForm();
    if (button.id === "capture-audio-record") return audio.start();
    if (button.id === "capture-audio-pause") return audio.togglePause();
    if (button.id === "capture-audio-stop") return audio.stop();
    if (button.id === "capture-audio-remove") return audio.cancel();
    if (button.dataset.contentAction === "new-capture") return openEditor(button);
    if (button.dataset.removeCaptureTag != null) {
      draftTags = draftTags.filter(tag => tag !== button.dataset.removeCaptureTag);
      captureView.renderTags();
      draftStore.save(query("#capture-form"), draftTags);
      return true;
    }
    if (button.dataset.contentImageRemove != null
      && button.closest("[data-content-image-editor]")?.dataset.contentImageEditor === "capture") {
      const draft = media.snapshot("capture");
      const index = Number(button.dataset.contentImageRemove);
      if (!Number.isSafeInteger(index) || !draft.items[index]) return false;
      await media.removeItem("capture", index);
      media.renderEditor("capture");
      return true;
    }
    if (button.dataset.captureExpand != null) {
      return captureView.toggleCard(button.closest(".capture-item"));
    }
    if (button.matches("[data-capture-audio-retry]")) {
      return captureView.retryAudio(button);
    }
    if (button.matches("[data-capture-speech-retry]")) return captureView.retryAudio(button);
    if (button.dataset.speechTextExpand != null) {
      const layer = button.closest("[data-speech-text-lines]");
      if (!layer?.classList.contains("is-collapsible")) return false;
      const expanded = !layer.classList.contains("is-expanded");
      layer.classList.toggle("is-expanded", expanded);
      button.textContent = expanded ? "收起" : "展开";
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute(
        "aria-label",
        `${expanded ? "收起" : "展开"}${layer.dataset.speechTextLabel || "文稿"}`
      );
      platform.requestFrame(captureView.syncOverflow);
      return true;
    }
    if (button.dataset.captureEdit) return editCapture(button.dataset.captureEdit, button);
    if (button.dataset.captureThought) {
      navigation.openThoughtDetail(button.dataset.captureThought);
      return true;
    }
    if (button.dataset.capturePromote) {
      const item = (data.getSnapshot().captures || [])
        .find(value => value.id === button.dataset.capturePromote);
      return item ? crossDomain.promoteToThought(item, button) : false;
    }
    if (button.dataset.captureDelete) return operations.remove(button);
    if (button.dataset.captureTranscribe) return operations.transcribe(button);
    if (button.dataset.speechSynthesize != null
      && button.closest(".speech-asset-controls")?.dataset.speechSourceType === "capture") {
      return operations.synthesize(button);
    }
    return false;
  }

  async function handleChange(event) {
    if (event.target.id === "capture-audio-file") {
      if (submissionPromise) {
        event.target.value = "";
        return;
      }
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await audio.importFile(file);
        const recorder = query("#capture-audio-recorder");
        if (recorder) recorder.open = false;
        delete query("#capture-form").dataset.requestId;
      } catch (error) {
        captureView.showStatus("#capture-audio-status", view.presentError(error, {
          operation: "添加录音",
          object: "这段录音",
          retained: "当前捕念正文和已有录音仍保留在页面",
          publicValidation: error?.publicValidation === true
        }).message);
      } finally {
        event.target.value = "";
      }
      return;
    }
    if (event.target.matches(
      "[data-content-image-editor='capture'] input[type='file']"
    )) {
      const status = event.target.closest("form")?.querySelector(".status");
      try {
        delete event.target.closest("form")?.dataset.requestId;
        await media.selectFiles("capture", event.target.files);
        media.renderEditor("capture");
        if (status) status.textContent = "";
      } catch (error) {
        const message = view.presentError(error, {
          operation: "添加图片",
          object: "这些图片",
          retained: error?.publicValidation
            ? "已经选择的图片没有变化"
            : "当前页面中的图片仍然保留",
          publicValidation: error?.publicValidation === true
        }).message;
        if (status) status.textContent = message;
      } finally {
        event.target.value = "";
      }
      return;
    }
    if (event.target.matches("[data-speech-playback-rate]")) {
      const player = event.target.closest(".speech-asset-controls")
        ?.querySelector("[data-speech-player]");
      if (player) player.playbackRate = normalizeTtsPlaybackRate(event.target.value);
    }
    if (event.target.matches("[data-speech-generation-rate]")) {
      const output = event.target.closest("label")?.querySelector("output");
      if (output) output.textContent = `${(1 + Number(event.target.value) / 100).toFixed(2)}×`;
    }
    draftStore.save(query("#capture-form"), draftTags, {
      editing: Boolean(query("#capture-id")?.value)
    });
  }

  function handleInput(event) {
    if (event.target.matches("[data-feed-search='captures']")) {
      searchQuery = event.target.value;
      captureView.renderList();
      return;
    }
    if (event.target.matches("[data-speech-generation-rate]")) {
      const output = event.target.closest("label")?.querySelector("output");
      if (output) output.textContent = `${(1 + Number(event.target.value) / 100).toFixed(2)}×`;
    }
    if (event.target.closest("#capture-form")) {
      draftStore.save(query("#capture-form"), draftTags, {
        editing: Boolean(query("#capture-id")?.value)
      });
    }
  }

  function handleKeydown(event) {
    if (event.target.id === "capture-tags"
      && view.entryKeyIntent(event, { inputKind: "tag" }) === "commit-tag") {
      event.preventDefault();
      commitTags();
      draftStore.save(query("#capture-form"), draftTags);
      return;
    }
    const editor = query("#capture-editor");
    if (!editor?.hidden && event.key === "Tab") view.trapFocus(event, editor);
    if (!editor?.hidden && event.key === "Escape") {
      event.preventDefault();
      void closeEditor();
      return;
    }
    const field = event.target.closest?.("input,textarea");
    const form = field?.closest?.("#capture-form");
    if (!field || !form || field.id === "capture-tags") return;
    const inputKind = field.tagName === "TEXTAREA" ? "multiline" : "field";
    const intent = view.entryKeyIntent(event, { inputKind });
    if (intent === "submit") {
      event.preventDefault();
      form.requestSubmit();
    } else if (intent === "block-submit") {
      event.preventDefault();
    }
  }

  async function mount(context = {}) {
    await unmount();
    if (!context.root || typeof context.root !== "object") {
      throw new TypeError("Captures feature requires a root");
    }
    if (context.signal?.aborted) throw Object.assign(new Error("Feature activation changed"), {
      name: "AbortError"
    });
    const current = {
      root: context.root,
      route: context.route,
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
    listen(current.root, "submit", event => {
      if (!event.target?.matches?.("#capture-form")) return;
      event.preventDefault();
      if (submissionPromise) return;
      const pending = operations.submit(event.target);
      submissionPromise = pending;
      captureView.renderList();
      captureView.renderAudio();
      void pending.finally(() => {
        if (submissionPromise === pending) submissionPromise = null;
        if (isActive()) captureView.render();
      });
    });
    listen(current.root, "input", handleInput);
    listen(current.root, "change", event => void handleChange(event));
    listen(document, "keydown", handleKeydown);
    listen(window, "resize", () => platform.requestFrame(() => {
      captureView.syncSpeechOverflow();
      captureView.syncOverflow();
    }), { passive: true });
    listen(document, "visibilitychange", () => {
      if (document.hidden) {
        draftStore.save(query("#capture-form"), draftTags);
        void audio.stop().then(() => audio.persist());
        platform.audio.stopAll();
      }
    });
    listen(window, "pagehide", () => {
      draftStore.save(query("#capture-form"), draftTags);
      void audio.stop().then(() => audio.persist());
      platform.audio.stopAll();
    });
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
    if (!draftRestored) {
      const restored = draftStore.restore(query("#capture-form"));
      draftTags = restored?.tags || [];
      draftRestored = true;
      if (!restored?.restored) view.resetOccurrenceInput(query("#capture-date"));
    }
    await audio.restore(data.getAccountId());
    if (activation !== current || context.signal?.aborted) {
      await unmount();
      throw Object.assign(new Error("Feature activation changed"), { name: "AbortError" });
    }
    media.activateDraft("capture");
    captureView.render();
    return () => activation === current ? unmount() : false;
  }

  function unmount() {
    if (unmountPromise) return unmountPromise;
    const current = activation;
    if (!current) return Promise.resolve(false);
    unmountPromise = (async () => {
      if (editorOpen) await closeEditor({ restoreFocus: false });
      else {
        audio.invalidatePendingStart();
        await audio.stop();
        await audio.persist().catch(noop);
      }
      current.unlink();
      if (activation === current) activation = null;
      platform.audio.stopAll();
      captureView.disposeAudio();
      return true;
    })().finally(() => {
      unmountPromise = null;
    });
    return unmountPromise;
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
      if (changed === null
        || ["captures", "thoughts", "speech", "aiTasks", "activeDate"]
          .some(domain => changed.has(domain))) return captureView.render();
      return false;
    },
    unmount,
    async resetSession() {
      session = {};
      await unmount().catch(noop);
      audio.resetSession();
      editorOpen = false;
      editorTrigger = null;
      suspendedCreateDraft = null;
      draftTags = [];
      draftRestored = false;
      searchQuery = "";
      captureView.resetSession();
      submissionPromise = null;
      for (const selector of ["#capture-create-toggle", "#capture-submit"]) {
        const button = surface?.querySelector(selector);
        if (button) button.disabled = false;
      }
      document.body.classList.remove("capture-editor-open");
    },
    openComposer(trigger) {
      return isActive() ? openEditor(trigger) : false;
    },
    async openQuickVoice(trigger) {
      if (!isActive()) return false;
      if (!openEditor(trigger)) return false;
      const recorder = query("#capture-audio-recorder");
      if (recorder) recorder.open = true;
      return audio.start();
    },
    clearLocalDraft: draftStore.clear,
    syncOverflow: captureView.syncOverflow
  });
}
