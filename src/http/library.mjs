function sendV1Mutation(res, v1, result, {
  missingMessage,
  missingCode,
  created = false
}) {
  if (result.missing) return v1.error(res, 404, missingMessage, missingCode);
  if (result.versionConflict) {
    return v1.error(
      res,
      412,
      "资源版本已变化，请重新读取后再提交",
      "PRECONDITION_FAILED",
      { currentVersion: result.currentVersion }
    );
  }
  if (result.conflict) {
    return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
  }
  if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
  return v1.success(res, created ? (result.duplicate ? 200 : 201) : 200, result.value, {
    etag: result.value?.version ? v1.versionEtag(result.value.version) : ""
  });
}

function sendV1Removal(res, v1, entry, message, code) {
  if (entry?.versionConflict) {
    return v1.error(
      res,
      412,
      "资源版本已变化，请重新读取后再提交",
      "PRECONDITION_FAILED",
      { currentVersion: entry.currentVersion }
    );
  }
  return entry
    ? v1.success(res, 200, { trashId: entry.id })
    : v1.error(res, 404, message, code);
}

function sendV1Page(res, v1, page, { missingMessage = "", missingCode = "" } = {}) {
  if (page.missing) return v1.error(res, 404, missingMessage, missingCode);
  if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
  return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
}

export function createLibraryHttp({ library, bodyJson, sendJson, sendTrashResult }) {
  if (!library || typeof library.listBooks !== "function" || typeof library.listQuotes !== "function") {
    throw new TypeError("Library HTTP requires library workflows");
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/books") {
      return sendV1Page(res, v1, await library.listBooks(v1.pagination(url)));
    }
    if (req.method === "POST" && url.pathname === "/api/v1/books") {
      return sendV1Mutation(res, v1, await library.createBook(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), {
        missingMessage: "书目不存在",
        missingCode: "BOOK_NOT_FOUND",
        created: true
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/books/parse") {
      return v1.success(res, 200, await library.parseBook(await bodyJson(req)));
    }
    if (req.method === "GET" && /^\/api\/v1\/books\/[^/]+$/.test(url.pathname)) {
      const book = await library.getBook(url.pathname.split("/")[4]);
      return book
        ? v1.success(res, 200, book, { etag: v1.versionEtag(book.version) })
        : v1.error(res, 404, "书目不存在", "BOOK_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/books\/[^/]+$/.test(url.pathname)) {
      return sendV1Mutation(res, v1, await library.updateBook(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req), partial: true }
      ), {
        missingMessage: "书目不存在",
        missingCode: "BOOK_NOT_FOUND"
      });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/books\/[^/]+$/.test(url.pathname)) {
      return sendV1Removal(
        res,
        v1,
        await library.removeBook(url.pathname.split("/")[4], v1.expectedVersion(req)),
        "书目不存在",
        "BOOK_NOT_FOUND"
      );
    }
    if (req.method === "GET" && /^\/api\/v1\/books\/[^/]+\/notes$/.test(url.pathname)) {
      return sendV1Page(
        res,
        v1,
        await library.listBookNotes(url.pathname.split("/")[4], v1.pagination(url)),
        { missingMessage: "书目不存在", missingCode: "BOOK_NOT_FOUND" }
      );
    }
    if (req.method === "POST" && /^\/api\/v1\/books\/[^/]+\/notes$/.test(url.pathname)) {
      return sendV1Mutation(res, v1, await library.createBookNote(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { clientRequestId: v1.idempotencyKey(req) }
      ), {
        missingMessage: "书目不存在",
        missingCode: "BOOK_NOT_FOUND",
        created: true
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const note = await library.getBookNote(parts[4], parts[6]);
      return note
        ? v1.success(res, 200, note, { etag: v1.versionEtag(note.version) })
        : v1.error(res, 404, "书目记录不存在", "BOOK_NOTE_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      return sendV1Mutation(res, v1, await library.updateBookNote(
        parts[4],
        parts[6],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req), partial: true }
      ), {
        missingMessage: "书目记录不存在",
        missingCode: "BOOK_NOTE_NOT_FOUND"
      });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      return sendV1Removal(
        res,
        v1,
        await library.removeBookNote(parts[4], parts[6], v1.expectedVersion(req)),
        "书目记录不存在",
        "BOOK_NOTE_NOT_FOUND"
      );
    }
    if (req.method === "GET" && url.pathname === "/api/v1/quotes") {
      return sendV1Page(res, v1, await library.listQuotes(v1.pagination(url)));
    }
    if (req.method === "POST" && url.pathname === "/api/v1/quotes") {
      return sendV1Mutation(res, v1, await library.createQuote(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), {
        missingMessage: "善言不存在",
        missingCode: "QUOTE_NOT_FOUND",
        created: true
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/quotes\/[^/]+$/.test(url.pathname)) {
      const quote = await library.getQuote(url.pathname.split("/")[4]);
      return quote
        ? v1.success(res, 200, quote, { etag: v1.versionEtag(quote.version) })
        : v1.error(res, 404, "善言不存在", "QUOTE_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/quotes\/[^/]+$/.test(url.pathname)) {
      return sendV1Mutation(res, v1, await library.updateQuote(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req), partial: true }
      ), {
        missingMessage: "善言不存在",
        missingCode: "QUOTE_NOT_FOUND"
      });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/quotes\/[^/]+$/.test(url.pathname)) {
      return sendV1Removal(
        res,
        v1,
        await library.removeQuote(url.pathname.split("/")[4], v1.expectedVersion(req)),
        "善言不存在",
        "QUOTE_NOT_FOUND"
      );
    }
    return false;
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/books/parse") {
      sendJson(res, 200, await library.parseBook(await bodyJson(req)));
    } else if (req.method === "POST" && url.pathname === "/api/books") {
      const result = await library.createBook(await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, result.value);
    } else if (req.method === "PATCH" && /^\/api\/books\/[^/]+$/.test(url.pathname)) {
      const result = await library.updateBook(url.pathname.split("/")[3], await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else if (result.missing) sendJson(res, 404, { error: "书目不存在" });
      else sendJson(res, 200, result.value);
    } else if (req.method === "DELETE" && /^\/api\/books\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await library.removeBook(url.pathname.split("/")[3]),
        "书目不存在"
      );
    } else if (req.method === "POST" && /^\/api\/books\/[^/]+\/notes$/.test(url.pathname)) {
      const result = await library.createBookNote(url.pathname.split("/")[3], await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else if (result.missing) sendJson(res, 404, { error: "书目不存在" });
      else sendJson(res, 201, result.value);
    } else if (req.method === "PATCH" && /^\/api\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const result = await library.updateBookNote(parts[3], parts[5], await bodyJson(req));
      if (result.error === "内容不能为空") sendJson(res, 400, { error: result.error });
      else if (result.error || result.missing) {
        sendJson(res, 404, { error: "书目记录不存在或时间格式不正确" });
      } else sendJson(res, 200, result.value);
    } else if (req.method === "DELETE" && /^\/api\/books\/[^/]+\/notes\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      await sendTrashResult(
        res,
        await library.removeBookNote(parts[3], parts[5]),
        "书目记录不存在"
      );
    } else if (req.method === "POST" && url.pathname === "/api/quotes") {
      const result = await library.createQuote(await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, result.value);
    } else if (req.method === "PATCH" && /^\/api\/quotes\/[^/]+$/.test(url.pathname)) {
      const result = await library.updateQuote(url.pathname.split("/")[3], await bodyJson(req));
      if (result.error === "来源和内容都必须填写") sendJson(res, 400, { error: result.error });
      else if (result.error || result.missing) {
        sendJson(res, 404, { error: "善言不存在或时间格式不正确" });
      } else sendJson(res, 200, result.value);
    } else if (req.method === "DELETE" && /^\/api\/quotes\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await library.removeQuote(url.pathname.split("/")[3]),
        "善言不存在"
      );
    } else return false;
    return true;
  }

  return { handle, handleV1 };
}
