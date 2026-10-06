import {
  bookMatchesSearch,
  normalizeLibrarySearch,
  randomBookMemories,
  sortedBookNotes
} from "./model.mjs";
import { createLibraryPresentation } from "./presentation.mjs";

export function createLibraryView({
  data,
  navigation,
  annotations,
  view,
  platform,
  state,
  getMedia
} = {}) {
  const presentation = createLibraryPresentation(view);
  const root = () => state.activation?.root || state.surface;
  const query = selector => root()?.querySelector?.(selector) || null;
  const queryAll = selector => [...(root()?.querySelectorAll?.(selector) || [])];
  const books = () => data.getSnapshot().books || [];
  const findBook = id => books().find(item => item.id === id);

  function syncReadingDates() {
    const start = query("#book-reading-start");
    const end = query("#book-reading-end");
    if (!start || !end) return false;
    end.min = start.value;
    end.setCustomValidity(
      start.value && end.value && end.value < start.value
        ? "结束日期不能早于开始日期"
        : ""
    );
    return true;
  }

  function resetBookForm() {
    state.editingBookId = "";
    const form = query("#book-form");
    if (!form) return false;
    delete form.dataset.requestId;
    form.reset();
    const start = query("#book-reading-start");
    if (start) start.value = view.localDateKey();
    syncReadingDates();
    const imagePath = query("#book-image-path");
    if (imagePath) imagePath.value = "";
    getMedia().resetImage("cover");
    getMedia().resetImage("recognition");
    query("#book-form-title").textContent = "创建书目";
    query("#book-submit").textContent = "创建书目";
    query("#book-edit-cancel").hidden = true;
    query("#book-parse-status").textContent = "";
    return true;
  }

  function openBookEditor(book) {
    state.editingBookId = book.id;
    state.activeBookId = "";
    state.activeBookFeatureNoteId = "";
    state.bookDetailCondensed = false;
    state.bookCreatorOpen = true;
    for (const key of ["title", "author", "publisher", "isbn", "description"]) {
      const input = query(`#book-${key}`);
      if (input) input.value = book[key] || "";
    }
    query("#book-reading-start").value = book.readingStartedOn || "";
    query("#book-reading-end").value = book.readingFinishedOn || "";
    syncReadingDates();
    query("#book-image-path").value = book.imagePath || "";
    getMedia().resetImage("cover", { existingPath: book.imagePath || "" });
    getMedia().resetImage("recognition");
    query("#book-form-title").textContent = "编辑书目";
    query("#book-submit").textContent = "保存修改";
    query("#book-edit-cancel").hidden = false;
    query("#book-parse-status").textContent = "可修改资料或替换封面。";
    render();
    platform.requestFrame(() => {
      query("#book-create-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      query("#book-title")?.focus();
    });
    return true;
  }

  function featuredNote(book) {
    const notes = sortedBookNotes(book, view.eventTimestamp);
    let note = notes.find(item => item.id === state.activeBookFeatureNoteId);
    if (!note && notes.length) {
      note = notes[Math.floor(platform.random() * notes.length)];
      state.activeBookFeatureNoteId = note.id;
    }
    return note;
  }

  function renderDetail(book) {
    const detail = query("#book-detail");
    detail.innerHTML = presentation.detail(book, featuredNote(book));
    const rootKey = annotations.rootKey("book", book.id);
    annotations.markTarget(detail.querySelector(".book-description"), rootKey, "description");
    for (const note of sortedBookNotes(book, view.eventTimestamp)) {
      if (note._sync) continue;
      annotations.markTarget(
        detail.querySelector(
          `[data-note-id="${platform.escapeSelector(note.id)}"] .book-note`
        ),
        rootKey,
        `note:${note.id}`
      );
    }
    view.renderLatex(detail);
    annotations.applyAnchors(detail);
    view.resetOccurrenceInput(detail.querySelector("[data-book-entry-form] [name='occurredAt']"));
    if (state.pendingBookNoteId) {
      const noteId = state.pendingBookNoteId;
      state.pendingBookNoteId = "";
      platform.requestFrame(() => detail.querySelector(
        `#book-note-${platform.escapeSelector(noteId)}`
      )?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
    return true;
  }

  function setupTitlePans() {
    for (const frame of queryAll(".book-title-frame")) {
      const title = frame.dataset.title || "";
      const text = frame.querySelector(".book-title");
      if (!text) continue;
      text.textContent = title;
      frame.classList.remove("is-overflowing");
      frame.style.removeProperty("--book-title-travel");
      frame.style.removeProperty("--book-title-duration");
      const lineHeight = parseFloat(platform.getComputedStyle(text).lineHeight);
      if (!lineHeight || text.scrollHeight <= lineHeight * 2 + 0.5) continue;
      const node = text.firstChild;
      const range = platform.createRange();
      const firstTop = text.getBoundingClientRect().top;
      let secondLineStart = title.length;
      for (let offset = 0; offset < title.length; offset += 1) {
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        if (range.getBoundingClientRect().top > firstTop + lineHeight * 0.5) {
          secondLineStart = offset;
          break;
        }
      }
      const firstLine = title.slice(0, secondLineStart).trimEnd();
      const remainder = title.slice(secondLineStart).trimStart();
      if (!remainder) continue;
      const viewport = platform.document.createElement("span");
      const track = platform.document.createElement("span");
      const first = platform.document.createElement("span");
      const second = platform.document.createElement("span");
      viewport.className = "book-title-scroll";
      track.className = "book-title-scroll-track";
      first.className = "book-title-scroll-line";
      second.className = "book-title-scroll-line";
      first.textContent = firstLine;
      second.textContent = remainder;
      track.append(first, second);
      viewport.append(track);
      text.replaceChildren(viewport);
      const travel = Math.max(0, Math.ceil(track.scrollWidth - viewport.clientWidth));
      if (!travel) continue;
      frame.style.setProperty("--book-title-travel", `${-travel}px`);
      frame.style.setProperty(
        "--book-title-duration",
        `${Math.min(9, Math.max(4, 3.5 + travel / 40)).toFixed(1)}s`
      );
      frame.classList.add("is-overflowing");
    }
  }

  function setDetailCondensed(value) {
    state.bookDetailCondensed = Boolean(value && state.activeBookId);
    root()?.classList?.toggle("book-detail-condensed", state.bookDetailCondensed);
    query("#book-detail")?.classList.toggle("is-condensed", state.bookDetailCondensed);
  }

  function syncDetailCondensed() {
    if (state.activeBookId && !state.bookDetailCondensed && platform.window.scrollY > 48) {
      setDetailCondensed(true);
    }
  }

  function render() {
    if (!root() || !query("#book-form") || !query("#book-detail")) return false;
    const allBooks = books();
    const hasBooks = allBooks.length > 0;
    const active = findBook(state.activeBookId);
    const visible = allBooks.filter(book => bookMatchesSearch(book, state.searchQuery));
    if (!state.editingBookId && !query("#book-reading-start")?.value) {
      query("#book-reading-start").value = view.localDateKey();
    }
    if (state.activeBookId && !active) {
      state.activeBookId = "";
      state.activeBookFeatureNoteId = "";
      state.bookDetailCondensed = false;
    }
    const detailBook = findBook(state.activeBookId);
    const inDetail = Boolean(detailBook);
    const creator = query("#book-create-panel");
    const library = query("#book-library");
    const detail = query("#book-detail");
    const toggle = query("#book-create-toggle");
    root().classList?.toggle("book-detail-mode", inDetail);
    root().classList?.toggle(
      "book-detail-condensed",
      inDetail && state.bookDetailCondensed
    );
    detail.classList.toggle("is-condensed", inDetail && state.bookDetailCondensed);
    query("#book-search-control").hidden = inDetail;
    query("#book-count").textContent = hasBooks
      ? (normalizeLibrarySearch(state.searchQuery)
        ? `${visible.length} / ${allBooks.length} 本`
        : `${allBooks.length} 本`)
      : "";
    query("#book-note-count").textContent =
      `${allBooks.reduce((sum, item) => sum + (item.notes || []).length, 0)} 条笔记`;
    toggle.hidden = !hasBooks || inDetail;
    toggle.textContent = state.bookCreatorOpen ? "收起创建" : "＋ 添加书目";
    creator.hidden = inDetail || (hasBooks && !state.bookCreatorOpen);
    creator.classList.toggle("cold-start", !hasBooks);
    library.hidden = inDetail || !hasBooks;
    detail.hidden = !inDetail;
    if (inDetail) return renderDetail(detailBook);
    detail.innerHTML = "";
    if (!hasBooks) {
      query("#book-grid").innerHTML = "";
      return true;
    }
    query("#book-memory-sky").innerHTML = presentation.memorySky(
      randomBookMemories(allBooks, platform.random)
    );
    query("#book-grid").innerHTML = visible.length
      ? presentation.cards(visible)
      : presentation.searchEmpty();
    platform.requestFrame(setupTitlePans);
    return true;
  }

  function openBook(bookId, noteId = "") {
    if (!findBook(bookId)) return false;
    navigation.scrollTo({ top: 0, behavior: "auto" });
    state.activeBookId = bookId;
    state.activeBookFeatureNoteId = noteId;
    state.pendingBookNoteId = noteId;
    state.bookDetailCondensed = false;
    state.bookCreatorOpen = false;
    render();
    return true;
  }

  function editNote(note) {
    const form = query("#book-detail [data-book-entry-form]");
    if (!note || !form) return false;
    form.elements.noteId.value = note.id;
    form.elements.type.value = note.type || "record";
    form.elements.favorite.value = note.favorite || "none";
    view.resetOccurrenceInput(form.elements.occurredAt, note);
    form.elements.content.value = note.content;
    form.querySelector("[data-book-entry-heading]").textContent = "编辑记录";
    form.querySelector("[data-book-entry-cancel]").hidden = false;
    form.querySelector('[type="submit"]').textContent = "保存修改";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    form.elements.content.focus();
    return true;
  }

  function restoreNoteDraft(draft, message) {
    const form = query("#book-detail [data-book-entry-form]");
    if (!form || form.dataset.bookEntryForm !== draft.bookId) return false;
    form.dataset.requestId = draft.requestId;
    form.elements.noteId.value = draft.noteId;
    form.elements.type.value = draft.payload.type;
    form.elements.favorite.value = draft.payload.favorite;
    view.resetOccurrenceInput(form.elements.occurredAt, draft.payload);
    form.elements.content.value = draft.payload.content;
    form.querySelector(".status").textContent = message;
    if (draft.noteId) {
      form.querySelector("[data-book-entry-heading]").textContent = "编辑记录";
      form.querySelector("[data-book-entry-cancel]").hidden = false;
      form.querySelector('[type="submit"]').textContent = "保存修改";
    }
    return true;
  }

  function clearSurface() {
    query("#book-memory-sky")?.replaceChildren();
    query("#book-grid")?.replaceChildren();
    query("#book-detail")?.replaceChildren();
    const search = query("#book-search");
    if (search) search.value = "";
    const count = query("#book-count");
    if (count) count.textContent = "";
    const noteCount = query("#book-note-count");
    if (noteCount) noteCount.textContent = "";
    const library = query("#book-library");
    if (library) library.hidden = true;
    const detail = query("#book-detail");
    if (detail) detail.hidden = true;
    const toggle = query("#book-create-toggle");
    if (toggle) toggle.hidden = true;
    root()?.classList?.remove("book-detail-mode", "book-detail-condensed");
  }

  return Object.freeze({
    query,
    queryAll,
    books,
    findBook,
    render,
    openBook,
    openBookEditor,
    resetBookForm,
    syncReadingDates,
    setupTitlePans,
    setDetailCondensed,
    syncDetailCondensed,
    editNote,
    restoreNoteDraft,
    clearSurface
  });
}
