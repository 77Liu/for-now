import { normalizeBookRecognition } from "../modules/books/index.mjs";
import { recordVersion } from "../shared/validation/index.mjs";

const FORMAT_ERROR = "截图已读取，但模型返回格式无法解析，请重试或手动填写";

function parsedRecognition(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const match = String(value || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error(FORMAT_ERROR);
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(FORMAT_ERROR);
  }
}

export function createLibraryWorkflows({
  repository,
  books,
  quotes,
  saveImages,
  discardAttachments,
  cleanupTemporaryFiles,
  recognizeBook,
  moveCollectionItemToTrash,
  moveNestedItemToTrash
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Library workflows require an account-scoped repository");
  }
  if (!books || typeof books.list !== "function" || typeof books.createNote !== "function") {
    throw new TypeError("Library workflows require the books domain service");
  }
  if (!quotes || typeof quotes.list !== "function" || typeof quotes.create !== "function") {
    throw new TypeError("Library workflows require the quotes domain service");
  }
  if (typeof saveImages !== "function" || typeof discardAttachments !== "function"
    || typeof cleanupTemporaryFiles !== "function" || typeof recognizeBook !== "function") {
    throw new TypeError("Library workflows require image and recognition adapters");
  }
  if (typeof moveCollectionItemToTrash !== "function" || typeof moveNestedItemToTrash !== "function") {
    throw new TypeError("Library workflows require trash mutation adapters");
  }

  async function parseBook(input = {}) {
    const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
    const { files, attachmentPaths, cleanupFiles } = await saveImages(images, 1, {
      needsLocalFiles: true
    });
    try {
      const raw = await recognizeBook(files);
      return { ...normalizeBookRecognition(parsedRecognition(raw)), attachmentPaths };
    } catch (error) {
      await discardAttachments(attachmentPaths);
      throw error;
    } finally {
      await cleanupTemporaryFiles(cleanupFiles);
    }
  }

  function removeVersioned({ collection, type, id, expectedVersion = null }) {
    return repository.update(store => {
      const record = store[collection]?.find(item => item.id === id);
      if (record && expectedVersion != null) {
        const currentVersion = recordVersion(record.version);
        if (Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
      }
      return moveCollectionItemToTrash(store, collection, type, id);
    });
  }

  function removeBookNote(bookId, noteId, expectedVersion = null) {
    return repository.update(store => {
      const book = store.books?.find(item => item.id === bookId);
      const note = book?.notes?.find(item => item.id === noteId);
      if (note && expectedVersion != null) {
        const currentVersion = recordVersion(note.version);
        if (Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
      }
      return moveNestedItemToTrash(store, {
        parentCollection: "books",
        parentId: bookId,
        field: "notes",
        type: "bookNote",
        id: noteId,
        annotationTargetKeys: [`note:${noteId}`]
      });
    });
  }

  return {
    listBooks: options => books.list(options),
    getBook: id => books.get(id),
    createBook: (input, options) => books.create(input, options),
    updateBook: (id, input, options) => books.update(id, input, options),
    listBookNotes: (bookId, options) => books.listNotes(bookId, options),
    getBookNote: (bookId, noteId) => books.getNote(bookId, noteId),
    createBookNote: (bookId, input, options) => books.createNote(bookId, input, options),
    updateBookNote: (bookId, noteId, input, options) => books.updateNote(bookId, noteId, input, options),
    removeBook: (id, expectedVersion = null) => removeVersioned({
      collection: "books",
      type: "book",
      id,
      expectedVersion
    }),
    removeBookNote,
    parseBook,
    listQuotes: options => quotes.list(options),
    getQuote: id => quotes.get(id),
    createQuote: (input, options) => quotes.create(input, options),
    updateQuote: (id, input, options) => quotes.update(id, input, options),
    removeQuote: (id, expectedVersion = null) => removeVersioned({
      collection: "quotes",
      type: "quote",
      id,
      expectedVersion
    })
  };
}
