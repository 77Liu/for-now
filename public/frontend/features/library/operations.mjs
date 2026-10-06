const noop = () => {};

export function createLibraryOperations({
  data,
  media,
  view,
  platform,
  state,
  libraryView,
  createTicket,
  isCurrent,
  isSameSession
} = {}) {
  let bookFlight = null;
  const noteFlights = new Map();

  const publish = () => data.publish(["books"]);
  const applyQueued = (record, ticket) => (
    isSameSession(ticket) ? data.applyPendingProjection(record) : false
  );
  const refreshLater = (domains, ticket, message) => {
    void data.refresh(domains).catch(error => {
      if (isCurrent(ticket)) view.showToast(`${message}：${error.message}`, "error");
    });
  };

  async function runBookSubmission(form) {
    const button = libraryView.query("#book-submit");
    const bookId = state.editingBookId;
    const existing = bookId ? libraryView.findBook(bookId) : null;
    const requestId = form.dataset.requestId || platform.createRequestId();
    const temporaryId = `pending:${requestId}`;
    const ticket = createTicket();
    let uploadedPath = "";
    let uploadRequestId = "";
    if (!bookId) form.dataset.requestId = requestId;
    button.disabled = true;
    try {
      const uploaded = await media.uploadCover(requestId, ticket);
      ({ uploadedPath, uploadRequestId } = uploaded);
      if (!isCurrent(ticket)) return false;
      const payload = {
        title: libraryView.query("#book-title").value,
        author: libraryView.query("#book-author").value,
        publisher: libraryView.query("#book-publisher").value,
        isbn: libraryView.query("#book-isbn").value,
        readingStartedOn: libraryView.query("#book-reading-start").value,
        readingFinishedOn: libraryView.query("#book-reading-end").value,
        description: libraryView.query("#book-description").value,
        imagePath: uploaded.imagePath
      };
      if (bookId) {
        const result = await data.requestV1(
          `/api/v1/books/${encodeURIComponent(bookId)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${existing?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            resource: `book:${bookId}`,
            domains: ["books"],
            recoverCommitted: true,
            projection: { kind: "record.update", domain: "books", id: bookId, payload },
            onQueued: record => applyQueued(record, ticket)
          }
        );
        if (!isCurrent(ticket)) return false;
        const book = libraryView.findBook(bookId);
        if (book) {
          Object.assign(book, result.data || payload, { updatedAt: platform.now() });
          delete book._sync;
        }
      } else {
        const result = await data.requestV1(
          "/api/v1/books",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["books"],
            projection: {
              kind: "record.create",
              domain: "books",
              temporaryId,
              payload: { ...payload, notes: [] }
            },
            onQueued: record => applyQueued(record, ticket)
          }
        );
        if (!isCurrent(ticket)) return false;
        data.getSnapshot().books = [
          result.data,
          ...(data.getSnapshot().books || []).filter(item => (
            item.id !== temporaryId && item.id !== result.data.id
          ))
        ];
      }
      publish();
      libraryView.resetBookForm();
      state.bookCreatorOpen = false;
      state.activeBookId = bookId || "";
      libraryView.render();
      refreshLater("books", ticket, "书目已保存，但列表刷新失败");
      view.showToast(bookId ? "书目信息已更新" : "书目已加入书架");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (error.syncStatus === "pending") {
        libraryView.resetBookForm();
        state.bookCreatorOpen = false;
        state.activeBookId = bookId || "";
        libraryView.render();
        view.showToast(bookId ? "书目修改将在网络恢复后同步" : "书目已进入待同步队列");
      } else {
        if (!bookId) {
          data.getSnapshot().books = (data.getSnapshot().books || [])
            .filter(item => item.id !== temporaryId);
          publish();
          libraryView.render();
        } else {
          await data.refresh("books").catch(noop);
        }
        await media.discardUpload(uploadedPath, uploadRequestId, ticket);
        if (isCurrent(ticket)) {
          libraryView.query("#book-parse-status").textContent = error.message;
        }
      }
      return false;
    } finally {
      if ((isCurrent(ticket) || isSameSession(ticket))
          && button.isConnected !== false) button.disabled = false;
    }
  }

  function submitBook(form) {
    if (bookFlight) return bookFlight;
    const pending = runBookSubmission(form);
    bookFlight = pending;
    const clear = () => {
      if (bookFlight === pending) bookFlight = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  async function runNoteSubmission(form) {
    const bookId = form.dataset.bookEntryForm;
    const noteId = form.elements.noteId.value;
    const button = form.querySelector('[type="submit"]');
    const status = form.querySelector(".status");
    const requestId = form.dataset.requestId || platform.createRequestId();
    const temporaryId = `pending:${requestId}`;
    const ticket = createTicket();
    let savedNoteId = noteId;
    let payload = null;
    if (!noteId) form.dataset.requestId = requestId;
    button.disabled = true;
    status.textContent = noteId ? "正在保存修改…" : "正在写入时间线…";
    try {
      payload = {
        ...view.occurrenceFields(form.elements.occurredAt),
        type: form.elements.type.value,
        favorite: form.elements.favorite.value,
        content: form.elements.content.value
      };
      if (noteId) {
        const book = libraryView.findBook(bookId);
        const note = book?.notes?.find(item => item.id === noteId);
        const result = await data.requestV1(
          `/api/v1/books/${encodeURIComponent(bookId)}/notes/${encodeURIComponent(noteId)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${note?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            resource: `book:${bookId}`,
            domains: ["books"],
            recoverCommitted: true,
            projection: { kind: "book.note.update", bookId, id: noteId, payload },
            onQueued: record => applyQueued(record, ticket)
          }
        );
        if (!isCurrent(ticket)) return false;
        if (note) {
          Object.assign(note, result.data || payload, { updatedAt: platform.now() });
          delete note._sync;
        }
      } else {
        const result = await data.requestV1(
          `/api/v1/books/${encodeURIComponent(bookId)}/notes`,
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["books"],
            resource: `book:${bookId}`,
            projection: {
              kind: "book.note.create",
              bookId,
              temporaryId,
              payload
            },
            onQueued: record => applyQueued(record, ticket)
          }
        );
        if (!isCurrent(ticket)) return false;
        savedNoteId = result.data.id;
        const book = libraryView.findBook(bookId);
        if (book) {
          book.notes = [
            result.data,
            ...(book.notes || []).filter(item => (
              item.id !== temporaryId && item.id !== result.data.id
            ))
          ];
        }
      }
      publish();
      state.pendingBookNoteId = savedNoteId;
      libraryView.render();
      refreshLater("books", ticket, "读书记录已保存，但列表刷新失败");
      view.showToast(noteId ? "读书记录已更新" : "读书记录已保存");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (error.syncStatus === "pending") {
        libraryView.render();
        view.showToast("读书记录已进入待同步队列");
      } else {
        if (!payload) {
          status.textContent = error.message;
          return false;
        }
        if (!noteId) {
          const book = libraryView.findBook(bookId);
          if (book) {
            book.notes = (book.notes || []).filter(item => item.id !== temporaryId);
          }
          publish();
        } else {
          await data.refresh("books").catch(noop);
        }
        if (isCurrent(ticket)) {
          libraryView.render();
          libraryView.restoreNoteDraft(
            { bookId, noteId, payload, requestId },
            error.message
          );
        }
      }
      return false;
    } finally {
      if (isCurrent(ticket) && button.isConnected !== false) button.disabled = false;
    }
  }

  function submitNote(form) {
    const key = `${form.dataset.bookEntryForm}:${form.elements.noteId.value || "create"}`;
    if (noteFlights.has(key)) return noteFlights.get(key);
    const pending = runNoteSubmission(form);
    noteFlights.set(key, pending);
    const clear = () => {
      if (noteFlights.get(key) === pending) noteFlights.delete(key);
    };
    void pending.then(clear, clear);
    return pending;
  }

  async function deleteBook(button) {
    const id = button.dataset.bookDelete;
    const book = libraryView.findBook(id);
    if (!book || !platform.confirm("将这条书目移入回收站？")) return false;
    const requestId = button.dataset.requestId || platform.createRequestId();
    button.dataset.requestId = requestId;
    button.disabled = true;
    state.activeBookId = "";
    state.activeBookFeatureNoteId = "";
    state.bookDetailCondensed = false;
    const ticket = createTicket();
    try {
      await data.requestV1(
        `/api/v1/books/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            "if-match": `"${book.version || 1}"`,
            "idempotency-key": requestId
          }
        },
        {
          domains: ["books", "review"],
          resource: `book:${id}`,
          recoverCommitted: true,
          projection: { kind: "record.delete", domain: "books", id },
          onQueued: record => applyQueued(record, ticket)
        }
      );
      if (!isCurrent(ticket)) return false;
      refreshLater(["books", "review"], ticket, "书目已移除，但列表刷新失败");
      view.showToast("书目已移入回收站");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (error.syncStatus === "pending") view.showToast("书目将在网络恢复后移入回收站");
      else {
        await data.refresh(["books", "review"]).catch(noop);
        if (isCurrent(ticket)) view.showToast(error.message, "error");
      }
      return false;
    } finally {
      if (isCurrent(ticket) && button.isConnected !== false) button.disabled = false;
    }
  }

  async function setFavorite(button) {
    const book = libraryView.findBook(state.activeBookId);
    const note = book?.notes?.find(item => item.id === button.dataset.bookNoteFavorite);
    if (!note) return false;
    const payload = {
      occurredAt: view.eventTimestamp(note),
      type: note.type,
      content: note.content,
      favorite: button.dataset.nextFavorite
    };
    const ticket = createTicket();
    button.disabled = true;
    try {
      await data.requestV1(
        `/api/v1/books/${encodeURIComponent(book.id)}/notes/${encodeURIComponent(note.id)}`,
        {
          method: "PATCH",
          headers: { "if-match": `"${note.version || 1}"` },
          body: JSON.stringify(payload)
        },
        {
          resource: `book:${book.id}`,
          domains: ["books"],
          recoverCommitted: true,
          projection: { kind: "book.note.update", bookId: book.id, id: note.id, payload },
          onQueued: record => applyQueued(record, ticket)
        }
      );
      if (!isCurrent(ticket)) return false;
      state.pendingBookNoteId = note.id;
      refreshLater("books", ticket, "收藏状态已更新，但列表刷新失败");
      view.showToast(payload.favorite === "star"
        ? "已标为星标"
        : payload.favorite === "sprout" ? "已标为萌芽" : "已取消收藏");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (error.syncStatus === "pending") view.showToast("收藏状态将在网络恢复后同步");
      else {
        await data.refresh("books").catch(noop);
        if (isCurrent(ticket)) {
          view.showToast(error.message, "error");
          if (button.isConnected !== false) button.disabled = false;
        }
      }
      return false;
    }
  }

  async function deleteNote(button) {
    const book = libraryView.findBook(state.activeBookId);
    const note = book?.notes?.find(item => item.id === button.dataset.bookNoteDelete);
    if (!note || !platform.confirm(
      `将这条${note.type === "thought" ? "附加思考" : "记录"}移入回收站？`
    )) return false;
    const ticket = createTicket();
    button.disabled = true;
    try {
      await data.requestV1(
        `/api/v1/books/${encodeURIComponent(book.id)}/notes/${encodeURIComponent(note.id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${note.version || 1}"` }
        },
        {
          resource: `book:${book.id}`,
          domains: ["books"],
          recoverCommitted: true,
          projection: { kind: "book.note.delete", bookId: book.id, id: note.id },
          onQueued: record => applyQueued(record, ticket)
        }
      );
      if (!isCurrent(ticket)) return false;
      refreshLater("books", ticket, "读书记录已移除，但列表刷新失败");
      view.showToast("读书记录已移入回收站");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (error.syncStatus === "pending") {
        view.showToast("读书记录将在网络恢复后移入回收站");
      } else {
        await data.refresh("books").catch(noop);
        if (isCurrent(ticket)) {
          view.showToast(error.message, "error");
          if (button.isConnected !== false) button.disabled = false;
        }
      }
      return false;
    }
  }

  return Object.freeze({
    submitBook,
    submitNote,
    deleteBook,
    setFavorite,
    deleteNote,
    resetSession() {
      bookFlight = null;
      noteFlights.clear();
    }
  });
}
