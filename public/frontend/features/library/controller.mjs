import { createLibraryMedia } from "./media.mjs";
import { createLibraryOperations } from "./operations.mjs";
import { createLibraryView } from "./view.mjs";

const noop = () => {};

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Library feature ${group} requires ${name}`);
    }
  }
}

export function createLibraryFeatureController({
  data = {},
  navigation = {},
  media: mediaPort = {},
  annotations = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    request: data.request,
    requestV1: data.requestV1,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection,
    publish: data.publish
  });
  requireFunctions("navigation port", { scrollTo: navigation.scrollTo });
  requireFunctions("media port", {
    validateImages: mediaPort.validateImages,
    imageDataUrls: mediaPort.imageDataUrls,
    uploadOriginalImages: mediaPort.uploadOriginalImages,
    discardUploadedImagePath: mediaPort.discardUploadedImagePath,
    readBlob: mediaPort.readBlob
  });
  requireFunctions("annotations port", {
    rootKey: annotations.rootKey,
    markTarget: annotations.markTarget,
    applyAnchors: annotations.applyAnchors
  });
  requireFunctions("view port", {
    appUrl: view.appUrl,
    contentState: view.contentState,
    escapeMarkup: view.escapeMarkup,
    plainPreview: view.plainPreview,
    renderMarkdown: view.renderMarkdown,
    renderLatex: view.renderLatex,
    eventDate: view.eventDate,
    eventTimestamp: view.eventTimestamp,
    formatDate: view.formatDate,
    formatDateKey: view.formatDateKey,
    formatTime: view.formatTime,
    localDateKey: view.localDateKey,
    resetOccurrenceInput: view.resetOccurrenceInput,
    occurrenceFields: view.occurrenceFields,
    showToast: view.showToast,
    entryKeyIntent: view.entryKeyIntent
  });
  requireFunctions("platform port", {
    createFile: platform.createFile,
    createRequestId: platform.createRequestId,
    requestFrame: platform.requestFrame,
    cancelFrame: platform.cancelFrame,
    getComputedStyle: platform.getComputedStyle,
    createRange: platform.createRange,
    random: platform.random,
    confirm: platform.confirm,
    escapeSelector: platform.escapeSelector,
    now: platform.now
  });
  if (!platform.document || !platform.window || !platform.objectUrls) {
    throw new TypeError("Library feature requires document, window and objectUrls");
  }

  const local = {
    activation: null,
    surface: null,
    session: {},
    generation: 0,
    searchQuery: "",
    editingBookId: "",
    activeBookId: "",
    activeBookFeatureNoteId: "",
    pendingBookNoteId: "",
    bookCreatorOpen: false,
    bookDetailCondensed: false
  };
  const createTicket = () => ({
    activation: local.activation,
    session: local.session,
    generation: local.generation,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial()
  });
  const isSameSession = ticket => Boolean(
    ticket
    && ticket.session === local.session
    && ticket.owner === String(data.getAccountId() || "")
    && ticket.serial === data.getSessionSerial()
  );
  const isCurrent = ticket => Boolean(
    isSameSession(ticket)
    && ticket.activation
    && ticket.activation === local.activation
    && ticket.generation === local.generation
    && !ticket.activation.signal?.aborted
  );
  const scheduledFrames = new Set();
  const requestFeatureFrame = callback => {
    const activation = local.activation;
    let frame;
    let fired = false;
    frame = platform.requestFrame(() => {
      fired = true;
      if (frame != null) scheduledFrames.delete(frame);
      if (local.activation === activation && !activation?.signal?.aborted) callback();
    });
    if (!fired && frame != null) scheduledFrames.add(frame);
    return frame;
  };
  const cancelFeatureFrames = () => {
    for (const frame of scheduledFrames) platform.cancelFrame(frame);
    scheduledFrames.clear();
  };
  const featurePlatform = { ...platform, requestFrame: requestFeatureFrame };

  let media;
  const libraryView = createLibraryView({
    data,
    navigation,
    annotations,
    view,
    platform: featurePlatform,
    state: local,
    getMedia: () => media
  });
  media = createLibraryMedia({
    data,
    media: mediaPort,
    platform,
    state: local,
    libraryView,
    createTicket,
    isCurrent,
    isSameSession
  });
  const operations = createLibraryOperations({
    data,
    media,
    view,
    platform,
    state: local,
    libraryView,
    createTicket,
    isCurrent,
    isSameSession
  });

  const imageRole = target => target?.id?.includes("cover")
    ? "cover"
    : target?.id?.includes("recognition") ? "recognition" : "";

  async function handleClick(event) {
    const button = event.target?.closest?.("button");
    if (!button) return false;
    if (button.id === "parse-book") return media.recognize(button);
    if (button.id === "book-cover-remove") {
      libraryView.query("#book-image-path").value = "";
      media.resetImage("cover");
      libraryView.query("#book-parse-status").textContent =
        "封面已移除，保存后生效。";
      return true;
    }
    if (button.id === "book-recognition-remove") {
      media.resetImage("recognition");
      libraryView.query("#book-parse-status").textContent = "";
      return true;
    }
    if (button.id === "book-image-swap") return media.swap(button);
    if (button.id === "book-create-toggle") {
      if (local.bookCreatorOpen) {
        local.bookCreatorOpen = false;
        libraryView.resetBookForm();
      } else {
        libraryView.resetBookForm();
        local.bookCreatorOpen = true;
      }
      libraryView.render();
      if (local.bookCreatorOpen) {
        libraryView.query("#book-create-panel")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return true;
    }
    if (button.id === "book-edit-cancel") {
      const bookId = local.editingBookId;
      libraryView.resetBookForm();
      local.bookCreatorOpen = false;
      local.activeBookId = bookId;
      local.activeBookFeatureNoteId = "";
      local.bookDetailCondensed = false;
      navigation.scrollTo({ top: 0, behavior: "auto" });
      libraryView.render();
      return true;
    }
    const openId = button.dataset.openBook || button.dataset.bookMemory;
    if (openId) return libraryView.openBook(openId, button.dataset.bookNote || "");
    if (button.dataset.bookBack != null) {
      local.activeBookId = "";
      local.activeBookFeatureNoteId = "";
      local.pendingBookNoteId = "";
      libraryView.setDetailCondensed(false);
      libraryView.render();
      navigation.scrollTo({ top: 0, behavior: "smooth" });
      return true;
    }
    if (button.dataset.bookAddNote != null) {
      libraryView.query("#book-detail [data-book-entry-form]")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
    if (button.dataset.bookFeatureNote) {
      libraryView.query(
        `#book-note-${platform.escapeSelector(button.dataset.bookFeatureNote)}`
      )?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
    if (button.dataset.bookEntryCancel != null) return libraryView.render();
    if (button.dataset.bookEdit) {
      const book = libraryView.findBook(button.dataset.bookEdit);
      return book ? libraryView.openBookEditor(book) : false;
    }
    if (button.dataset.bookDelete) return operations.deleteBook(button);
    const book = libraryView.findBook(local.activeBookId);
    if (!book) return false;
    if (button.dataset.bookNoteEdit) {
      return libraryView.editNote(
        (book.notes || []).find(item => item.id === button.dataset.bookNoteEdit)
      );
    }
    if (button.dataset.bookNoteFavorite) return operations.setFavorite(button);
    if (button.dataset.bookNoteDelete) return operations.deleteNote(button);
    return false;
  }

  function handleSubmit(event) {
    const form = event.target;
    if (form?.id === "book-form") {
      event.preventDefault();
      void operations.submitBook(form);
      return true;
    }
    if (form?.matches?.("[data-book-entry-form]")) {
      event.preventDefault();
      void operations.submitNote(form);
      return true;
    }
    return false;
  }

  function handleInput(event) {
    if (event.target?.matches?.("[data-feed-search='books']")) {
      local.searchQuery = event.target.value;
      libraryView.render();
      return;
    }
    if (event.target?.closest?.("#book-form")) media.invalidateRecognition();
    if (event.target?.id === "book-reading-start"
        || event.target?.id === "book-reading-end") {
      libraryView.syncReadingDates();
    }
  }

  function handleChange(event) {
    const role = imageRole(event.target);
    if (!role || event.target?.type !== "file") return;
    const file = event.target.files?.[0];
    media.setPasteTarget(role);
    if (file && !media.setImage(role, file, "本地文件")) event.target.value = "";
  }

  function handleKeydown(event) {
    const role = imageRole(event.target);
    if (role && event.target?.classList?.contains("upload-box")
        && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      libraryView.query(`#book-${role}-image`)?.click();
      return;
    }
    const field = event.target?.closest?.("input,textarea");
    const form = field?.closest?.("[data-book-entry-form]");
    if (!field || !form) return;
    const inputKind = field.tagName === "TEXTAREA" ? "multiline" : "field";
    const intent = view.entryKeyIntent(event, { inputKind });
    if (intent === "submit") {
      event.preventDefault();
      form.requestSubmit();
    } else if (intent === "block-submit") {
      event.preventDefault();
    }
  }

  function handleDrag(event) {
    const box = event.target?.closest?.("#book-cover-upload-box,#book-recognition-upload-box");
    if (!box) return;
    const role = imageRole(box);
    if (event.type === "dragenter" || event.type === "dragover") {
      event.preventDefault();
      media.setPasteTarget(role);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      box.classList.add("dragging");
    } else if (event.type === "dragleave") {
      if (!box.contains(event.relatedTarget)) box.classList.remove("dragging");
    } else if (event.type === "drop") {
      event.preventDefault();
      box.classList.remove("dragging");
      const file = [...(event.dataTransfer?.files || [])]
        .find(item => item.type.startsWith("image/"));
      if (!file) {
        libraryView.query("#book-parse-status").textContent =
          "拖入的内容里没有可用图片。";
      } else {
        media.setImage(role, file, "拖入图片");
      }
    }
  }

  function handlePaste(event) {
    const panel = libraryView.query("#book-create-panel");
    if (!panel || panel.hidden
        || event.target?.closest?.('input:not([type="file"]),textarea,[contenteditable=true]')) {
      return;
    }
    const file = [...(event.clipboardData?.files || [])]
      .find(item => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    media.setImage(media.pasteTarget(), file, "剪贴板");
  }

  async function unmount() {
    const current = local.activation;
    if (!current) return false;
    local.activation = null;
    cancelFeatureFrames();
    current.unlink();
    return true;
  }

  function clearLocalState() {
    local.searchQuery = "";
    local.editingBookId = "";
    local.activeBookId = "";
    local.activeBookFeatureNoteId = "";
    local.pendingBookNoteId = "";
    local.bookCreatorOpen = false;
    local.bookDetailCondensed = false;
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Library feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const current = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        listeners: [],
        unlink: noop
      };
      local.surface = context.root;
      local.activation = current;
      local.generation += 1;
      const listen = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        current.listeners.push([target, type, listener, options]);
      };
      listen(current.root, "click", event => void handleClick(event));
      listen(current.root, "submit", handleSubmit);
      listen(current.root, "input", handleInput);
      listen(current.root, "change", handleChange);
      listen(current.root, "focusin", event => {
        const role = imageRole(event.target);
        if (role) media.setPasteTarget(role);
      });
      listen(current.root, "pointerdown", event => {
        const role = imageRole(event.target);
        if (role) media.setPasteTarget(role);
      });
      listen(current.root, "keydown", handleKeydown);
      for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
        listen(current.root, type, handleDrag);
      }
      listen(platform.document, "paste", handlePaste);
      listen(platform.window, "scroll", libraryView.syncDetailCondensed, { passive: true });
      listen(platform.window, "resize", () => {
        requestFeatureFrame(libraryView.setupTitlePans);
      }, { passive: true });
      const abort = () => {
        if (local.activation === current) void unmount();
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      current.unlink = () => {
        for (const [target, type, listener, options] of current.listeners) {
          target?.removeEventListener?.(type, listener, options);
        }
        context.signal?.removeEventListener("abort", abort);
      };
      media.resume();
      libraryView.render();
      return () => local.activation === current ? unmount() : false;
    },
    render(context = {}) {
      if (!local.activation || local.activation.signal?.aborted) return false;
      const changed = context.changedDomains == null
        ? null
        : new Set(typeof context.changedDomains === "string"
          ? [context.changedDomains]
          : context.changedDomains);
      return changed === null || changed.has("books") ? libraryView.render() : false;
    },
    unmount,
    async resetSession() {
      local.session = {};
      local.generation += 1;
      await unmount();
      operations.resetSession();
      clearLocalState();
      media.resetSession();
      libraryView.resetBookForm();
      libraryView.clearSurface();
    },
    openBook(bookId, { noteId = "" } = {}) {
      return local.activation ? libraryView.openBook(bookId, noteId) : false;
    }
  });
}
