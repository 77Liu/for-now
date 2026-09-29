import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields, strictDateKey } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathValue = value => cleanAttachmentPaths([value])[0] || "";
const BOOK_CREATE_SCOPE = "books.create";
const BOOK_NOTE_CREATE_SCOPE = "books.notes.create";

async function executeCreate(repository, request, mutate) {
  if (!request.key || typeof repository.executeIdempotent !== "function") {
    return repository.update(mutate);
  }
  let executed = false;
  try {
    const result = await repository.executeIdempotent(request, (...args) => {
      executed = true;
      const response = mutate(...args);
      if (response?.conflict) {
        throw Object.assign(new Error("同一幂等键不能用于不同内容"), {
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return response;
    });
    return executed ? result : { ...result, duplicate: true };
  } catch (error) {
    if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
    throw error;
  }
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

function priorBook(items, trashItems, clientRequestId) {
  return items.find(item => item.clientRequestId === clientRequestId)
    || trashItems.find(item => item.type === "book" && item.payload?.clientRequestId === clientRequestId)?.payload;
}

function priorBookNote(items, trashItems, clientRequestId) {
  return items.flatMap(item => item.notes || []).find(item => item.clientRequestId === clientRequestId)
    || trashItems.find(item => item.type === "bookNote" && item.payload?.clientRequestId === clientRequestId)?.payload
    || trashItems
      .filter(item => item.type === "book")
      .flatMap(item => item.payload?.notes || [])
      .find(item => item.clientRequestId === clientRequestId);
}

function noteIdempotencyPayload(input, bookId, value) {
  const canonical = { bookId, ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

export function normalizeBookRecognition(value = {}) {
  return {
    title: safeText(value.title, 300),
    author: safeText(value.author, 200),
    publisher: safeText(value.publisher, 200),
    isbn: safeText(value.isbn, 80),
    description: safeText(value.description, 2000),
    verification: safeText(value.verification, 500)
  };
}

export function normalizeBookNote(note = {}) {
  return {
    type: "record",
    favorite: "none",
    ...note,
    type: note.type === "thought" ? "thought" : "record",
    favorite: ["none", "star", "sprout"].includes(note.favorite) ? note.favorite : "none",
    version: recordVersion(note.version)
  };
}

export function normalizeBook(book = {}) {
  return {
    notes: [],
    annotations: [],
    annotationDrift: [],
    ...book,
    readingStartedOn: strictDateKey(book.readingStartedOn) || "",
    readingFinishedOn: strictDateKey(book.readingFinishedOn) || "",
    imagePath: pathValue(book.imagePath),
    notes: (Array.isArray(book.notes) ? book.notes : []).map(normalizeBookNote),
    version: recordVersion(book.version)
  };
}

export function bookPayload(input = {}, existing = null, { partial = false } = {}) {
  const field = (key, max) => (
    partial && existing && !hasOwn(input, key)
      ? safeText(existing[key], max)
      : safeText(input[key], max)
  );
  const title = field("title", 300);
  if (!title) return { error: "书名不能为空" };

  const hasStartedOn = hasOwn(input, "readingStartedOn");
  const hasFinishedOn = hasOwn(input, "readingFinishedOn");
  const readingStartedOn = existing && !hasStartedOn
    ? strictDateKey(existing.readingStartedOn) || ""
    : strictDateKey(input.readingStartedOn);
  const readingFinishedOn = existing && !hasFinishedOn
    ? strictDateKey(existing.readingFinishedOn) || ""
    : strictDateKey(input.readingFinishedOn);

  if (existing && (readingStartedOn === null || readingFinishedOn === null)) {
    return { error: "阅读日期格式不正确" };
  }
  if (!readingStartedOn) return { error: "请填写有效的阅读开始日期" };
  if (readingFinishedOn === null) return { error: "阅读结束日期格式不正确" };
  if (readingFinishedOn && readingFinishedOn < readingStartedOn) {
    return { error: "阅读结束日期不能早于开始日期" };
  }

  return {
    value: {
      title,
      author: field("author", 200),
      publisher: field("publisher", 200),
      isbn: field("isbn", 80),
      description: field("description", 2000),
      readingStartedOn,
      readingFinishedOn,
      imagePath: hasOwn(input, "imagePath") ? pathValue(input.imagePath) : existing?.imagePath || ""
    }
  };
}

export function bookNotePayload(input = {}, existing = null, { partial = false } = {}) {
  const content = partial && existing && !hasOwn(input, "content")
    ? safeText(existing.content)
    : safeText(input.content);
  if (!content) return { error: "内容不能为空" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  const noteType = partial && existing && !hasOwn(input, "type") ? existing.type : input.type;
  const favorite = hasOwn(input, "favorite") ? input.favorite : existing?.favorite;
  return {
    value: {
      ...eventTime,
      type: noteType === "thought" ? "thought" : "record",
      favorite: ["none", "star", "sprout"].includes(favorite) ? favorite : existing?.favorite || "none",
      content
    }
  };
}

export function createBookRecords({
  repository,
  reanchorAnnotations = () => {},
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Book records require a repository with read() and update()");
  }
  if (typeof reanchorAnnotations !== "function") {
    throw new TypeError("Book records require an annotation reanchor function");
  }

  return {
    async list(options) {
      const page = pageOf(await repository.read(), options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(normalizeBook) };
    },

    async get(id) {
      const book = (await repository.read()).find(item => item.id === id);
      return book ? normalizeBook(book) : null;
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = bookPayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(parsed.value) : "";
      return executeCreate(repository, {
        scope: BOOK_CREATE_SCOPE,
        key: clientRequestId,
        requestHash
      }, (items, trashItems = []) => {
        if (clientRequestId) {
          const duplicate = priorBook(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: normalizeBook(duplicate), duplicate: true }
              : { conflict: true };
          }
        }
        const book = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          notes: [],
          annotations: [],
          annotationDrift: [],
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(book);
        return { value: book, duplicate: false };
      });
    },

    update(id, input, { expectedVersion = null, partial = false } = {}) {
      if (!partial) {
        const title = safeText(input?.title, 300);
        if (!title) return Promise.resolve({ error: "书名不能为空" });
        const startedOn = hasOwn(input, "readingStartedOn") ? strictDateKey(input.readingStartedOn) : undefined;
        const finishedOn = hasOwn(input, "readingFinishedOn") ? strictDateKey(input.readingFinishedOn) : undefined;
        if (startedOn === null || finishedOn === null) return Promise.resolve({ error: "阅读日期格式不正确" });
        if (hasOwn(input, "readingStartedOn") && !startedOn) {
          return Promise.resolve({ error: "请填写有效的阅读开始日期" });
        }
      }
      return repository.update(items => {
        const book = items.find(item => item.id === id);
        if (!book) return { missing: true };
        const currentVersion = recordVersion(book.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = bookPayload(input, book, { partial });
        if (parsed.error) return parsed;
        reanchorAnnotations(book, "description", book.description || "", parsed.value.description);
        Object.assign(book, parsed.value, {
          updatedAt: now(),
          ...(expectedVersion != null ? { version: currentVersion + 1 } : {})
        });
        return { value: book };
      });
    },

    async listNotes(bookId, options) {
      const book = (await repository.read()).find(item => item.id === bookId);
      if (!book) return { missing: true };
      const page = pageOf(Array.isArray(book.notes) ? book.notes : [], options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(normalizeBookNote) };
    },

    async getNote(bookId, noteId) {
      const book = (await repository.read()).find(item => item.id === bookId);
      const note = book?.notes?.find(item => item.id === noteId);
      return note ? normalizeBookNote(note) : null;
    },

    async createNote(bookId, input, { clientRequestId = "" } = {}) {
      const parsed = bookNotePayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId
        ? requestDigest(noteIdempotencyPayload(input, bookId, parsed.value))
        : "";
      return executeCreate(repository, {
        scope: BOOK_NOTE_CREATE_SCOPE,
        key: clientRequestId,
        requestHash
      }, (items, trashItems = []) => {
        if (clientRequestId) {
          const duplicate = priorBookNote(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: normalizeBookNote(duplicate), duplicate: true }
              : { conflict: true };
          }
        }
        const book = items.find(item => item.id === bookId);
        if (!book) return { missing: true };
        const note = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        book.notes ||= [];
        book.notes.unshift(note);
        if (clientRequestId) {
          book.version = recordVersion(book.version) + 1;
          book.updatedAt = now();
        }
        return { value: note, duplicate: false };
      });
    },

    updateNote(bookId, noteId, input, { expectedVersion = null, partial = false } = {}) {
      if (!partial && !safeText(input?.content)) return Promise.resolve({ error: "内容不能为空" });
      return repository.update(items => {
        const book = items.find(item => item.id === bookId);
        const note = book?.notes?.find(item => item.id === noteId);
        if (!book || !note) return { missing: true };
        const currentVersion = recordVersion(note.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = bookNotePayload(input, note, { partial });
        if (parsed.error) return parsed;
        reanchorAnnotations(book, `note:${noteId}`, note.content || "", parsed.value.content);
        Object.assign(note, parsed.value, {
          updatedAt: now(),
          ...(expectedVersion != null ? { version: currentVersion + 1 } : {})
        });
        if (expectedVersion != null) {
          book.version = recordVersion(book.version) + 1;
          book.updatedAt = now();
        }
        return { value: note };
      });
    }
  };
}
