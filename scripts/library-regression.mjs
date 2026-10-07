import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bookNotePayload,
  bookPayload,
  createBookRecords,
  normalizeBookRecognition
} from "../src/modules/books/index.mjs";
import {
  createQuoteRecords,
  quotePayload
} from "../src/modules/quotes/index.mjs";
import { createLibraryWorkflows } from "../src/app/index.mjs";
import {
  createApiV1Http,
  createLibraryHttp,
  libraryComponents,
  libraryOpenApiFragment,
  libraryPaths,
  openApiV1
} from "../src/http/index.mjs";
import { recordVersion } from "../src/shared/validation/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const context = new AsyncLocalStorage();
const stores = new Map([
  ["account-a", { books: [], quotes: [], trash: [] }],
  ["account-b", { books: [], quotes: [], trash: [] }]
]);
const failedAccounts = new Set();
const run = (accountId, operation) => context.run(accountId, operation);
const accountId = () => {
  const value = context.getStore();
  assert.ok(stores.has(value), "repository operations require an account context");
  return value;
};
const repository = {
  async read() {
    return structuredClone(stores.get(accountId()));
  },
  async update(mutate) {
    const id = accountId();
    const next = structuredClone(stores.get(id));
    const result = await mutate(next);
    if (failedAccounts.has(id)) throw new Error("commit unavailable");
    stores.set(id, next);
    return result;
  }
};
const collectionRepository = collection => ({
  async read() {
    return (await repository.read())[collection];
  },
  update(mutate) {
    return repository.update(store => mutate(store[collection], store.trash));
  }
});
const durableLedger = new Map();
const durableRequests = [];
const durableRepository = {
  read: () => repository.read(),
  update: mutate => repository.update(mutate),
  async executeIdempotent(request, operation) {
    const id = accountId();
    durableRequests.push({ accountId: id, ...request });
    const ledger = durableLedger.get(id) || new Map();
    durableLedger.set(id, ledger);
    const ledgerKey = `${request.scope}\u0000${request.key}`;
    const existing = ledger.get(ledgerKey);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("同一幂等键不能用于不同内容"), {
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return structuredClone(existing.response);
    }
    const next = structuredClone(stores.get(id));
    const response = await operation(next);
    stores.set(id, next);
    ledger.set(ledgerKey, {
      requestHash: request.requestHash,
      response: structuredClone(response)
    });
    return structuredClone(response);
  }
};
const durableCollectionRepository = collection => ({
  async read() {
    return (await durableRepository.read())[collection];
  },
  update(mutate) {
    return durableRepository.update(store => mutate(store[collection], store.trash));
  },
  executeIdempotent(request, mutate) {
    return durableRepository.executeIdempotent(
      request,
      store => mutate(store[collection], store.trash)
    );
  }
});

let idSequence = 0;
let trashSequence = 0;
const reanchors = [];
const now = () => "2026-09-29T08:00:00.000Z";
const createId = () => `library-${++idSequence}`;
const reanchorAnnotations = (root, targetKey, oldSource, newSource) => {
  reanchors.push({ rootId: root.id, targetKey, oldSource, newSource });
  for (const annotation of root.annotations || []) {
    if (annotation.targetKey !== targetKey) continue;
    const index = newSource.indexOf(annotation.quote);
    if (index >= 0) {
      annotation.start = index;
      annotation.end = index + annotation.quote.length;
    }
  }
};

const books = createBookRecords({
  repository: collectionRepository("books"),
  reanchorAnnotations,
  now,
  createId
});
const quotes = createQuoteRecords({
  repository: collectionRepository("quotes"),
  reanchorAnnotations,
  now,
  createId
});
const durableBooks = createBookRecords({
  repository: durableCollectionRepository("books"),
  reanchorAnnotations,
  now,
  createId
});
const durableQuotes = createQuoteRecords({
  repository: durableCollectionRepository("quotes"),
  reanchorAnnotations,
  now,
  createId
});

function findTrash(store, type, resourceId) {
  return store.trash.find(item => item.type === type && item.resourceId === resourceId) || null;
}

function moveCollectionItemToTrash(store, collection, type, id) {
  const index = store[collection].findIndex(item => item.id === id);
  if (index < 0) return findTrash(store, type, id);
  const [payload] = store[collection].splice(index, 1);
  const entry = {
    id: `trash-${++trashSequence}`,
    type,
    resourceId: id,
    payload,
    location: { kind: "collection", collection, index }
  };
  store.trash.unshift(entry);
  return entry;
}

function moveNestedItemToTrash(store, input) {
  const parent = store[input.parentCollection].find(item => item.id === input.parentId);
  if (!parent) return findTrash(store, input.type, input.id);
  const index = (parent[input.field] || []).findIndex(item => item.id === input.id);
  if (index < 0) return findTrash(store, input.type, input.id);
  const [payload] = parent[input.field].splice(index, 1);
  const targetKeys = new Set(input.annotationTargetKeys || []);
  const dependents = {
    annotations: (parent.annotations || []).filter(item => targetKeys.has(item.targetKey)),
    annotationDrift: (parent.annotationDrift || []).filter(item => (
      targetKeys.has(item.targetKey) || targetKeys.has(item.originalTargetKey)
    ))
  };
  parent.annotations = (parent.annotations || []).filter(item => !targetKeys.has(item.targetKey));
  parent.annotationDrift = (parent.annotationDrift || []).filter(item => (
    !targetKeys.has(item.targetKey) && !targetKeys.has(item.originalTargetKey)
  ));
  parent.version = recordVersion(parent.version) + 1;
  parent.updatedAt = now();
  const entry = {
    id: `trash-${++trashSequence}`,
    type: input.type,
    resourceId: input.id,
    payload,
    dependents,
    location: {
      kind: "nested",
      parentCollection: input.parentCollection,
      parentId: input.parentId,
      field: input.field,
      index
    }
  };
  store.trash.unshift(entry);
  return entry;
}

const imageCalls = {
  saved: [],
  discarded: [],
  cleaned: [],
  recognized: []
};
let recognitionResult = JSON.stringify({
  title: "  被识别的书  ",
  author: " 作者 ",
  publisher: "出版社",
  isbn: "9780000000000",
  description: "简介",
  verification: "待核对",
  ignored: "不会进入结果"
});
const library = createLibraryWorkflows({
  repository,
  books,
  quotes,
  async saveImages(images, maxImages, options) {
    imageCalls.saved.push({ images, maxImages, options });
    if (!images.length) throw new Error("请选择图片");
    return {
      files: ["/tmp/book-input.png"],
      attachmentPaths: ["/attachments/book-input.png"],
      cleanupFiles: ["/tmp/book-input.png"]
    };
  },
  async discardAttachments(paths) {
    imageCalls.discarded.push(paths);
  },
  async cleanupTemporaryFiles(files) {
    imageCalls.cleaned.push(files);
  },
  async recognizeBook(files) {
    imageCalls.recognized.push(files);
    return recognitionResult;
  },
  moveCollectionItemToTrash,
  moveNestedItemToTrash
});

assert.deepEqual(normalizeBookRecognition({
  title: ` ${"书".repeat(301)} `,
  author: " 作者 ",
  publisher: null,
  isbn: 123,
  description: " 简介 ",
  verification: " 核对 "
}), {
  title: "书".repeat(300),
  author: "作者",
  publisher: "",
  isbn: "123",
  description: "简介",
  verification: "核对"
});
assert.equal(bookPayload({ title: "", readingStartedOn: "2026-09-01" }).error, "书名不能为空");
assert.equal(bookPayload({ title: "书", readingStartedOn: "" }).error, "请填写有效的阅读开始日期");
assert.equal(bookPayload({
  title: "书",
  readingStartedOn: "2026-09-02",
  readingFinishedOn: "2026-09-01"
}).error, "阅读结束日期不能早于开始日期");
assert.equal(bookNotePayload({ content: " ", occurredAt: "bad" }).error, "内容不能为空");
assert.equal(quotePayload({ source: "出处", content: "", occurredAt: "bad" }).error, "来源和内容都必须填写");

const legacyBook = (await run("account-a", () => library.createBook({
  title: " 旧书 ",
  author: "旧作者",
  publisher: "旧出版社",
  isbn: "old-isbn",
  description: "原始简介里有锚点",
  readingStartedOn: "2026-09-01",
  readingFinishedOn: "",
  imagePath: "https://invalid.example/cover.png"
}))).value;
assert.equal(legacyBook.title, "旧书");
assert.equal(legacyBook.imagePath, "");
assert.equal(Object.hasOwn(legacyBook, "version"), false, "legacy create must preserve its response shape");
stores.get("account-a").books[0].annotations.push({
  id: "book-annotation",
  targetKey: "description",
  quote: "锚点",
  start: 6,
  end: 8
});
const legacyBookUpdated = (await run("account-a", () => library.updateBook(legacyBook.id, {
  title: "旧接口更新",
  description: "新增文字后的锚点",
  readingFinishedOn: "2026-09-28"
}))).value;
assert.equal(legacyBookUpdated.author, "", "legacy PATCH continues clearing omitted text fields");
assert.equal(legacyBookUpdated.readingStartedOn, "2026-09-01");
assert.equal(legacyBookUpdated.version, 2);
assert.equal(legacyBookUpdated.annotations[0].start, 6);
assert.ok(reanchors.some(item => item.rootId === legacyBook.id && item.targetKey === "description"));
assert.deepEqual(await run("account-a", () => library.updateBook(legacyBook.id, {
  title: "日期倒置",
  readingStartedOn: "2026-09-29",
  readingFinishedOn: "2026-09-28"
})), { error: "阅读结束日期不能早于开始日期" });

const v1BookInput = {
  title: "版本书目",
  author: "作者甲",
  publisher: "出版甲",
  isbn: "isbn-a",
  description: "版本简介",
  readingStartedOn: "2026-09-10",
  readingFinishedOn: "",
  imagePath: "/attachments/cover.png"
};
const v1Book = await run("account-a", () => library.createBook(v1BookInput, {
  clientRequestId: "book-create-key"
}));
assert.equal(v1Book.value.version, 1);
assert.equal(v1Book.duplicate, false);
assert.equal((await run("account-a", () => library.createBook(v1BookInput, {
  clientRequestId: "book-create-key"
}))).duplicate, true);
assert.equal((await run("account-a", () => library.createBook({
  ...v1BookInput,
  title: "冲突书目"
}, {
  clientRequestId: "book-create-key"
}))).conflict, true);

const accountBBook = await run("account-b", () => library.createBook({
  ...v1BookInput,
  title: "账户乙书目"
}, {
  clientRequestId: "book-create-key"
}));
assert.equal(accountBBook.value.version, 1, "idempotency keys are scoped by account repository");
assert.equal(await run("account-b", () => library.getBook(v1Book.value.id)), null);

const bookPage = await run("account-a", () => library.listBooks({ limit: 1 }));
assert.equal(bookPage.items.length, 1);
assert.ok(bookPage.nextId);
assert.equal((await run("account-a", () => library.listBooks({
  limit: 10,
  afterId: bookPage.nextId
}))).invalidCursor, undefined);
assert.equal((await run("account-a", () => library.listBooks({
  limit: 10,
  afterId: "unknown-book"
}))).invalidCursor, true);
assert.deepEqual(await run("account-a", () => library.updateBook(
  v1Book.value.id,
  { title: "不会生效" },
  { expectedVersion: 7, partial: true }
)), { versionConflict: true, currentVersion: 1 });
const partialBook = await run("account-a", () => library.updateBook(
  v1Book.value.id,
  { title: "局部更新书目" },
  { expectedVersion: 1, partial: true }
));
assert.equal(partialBook.value.version, 2);
assert.equal(partialBook.value.author, "作者甲");
assert.equal(partialBook.value.description, "版本简介");

const legacyNote = (await run("account-a", () => library.createBookNote(legacyBook.id, {
  occurredAt: "2026-09-27T09:10:11",
  type: "thought",
  favorite: "star",
  content: "原始读书笔记含有重点"
}))).value;
assert.equal(legacyNote.type, "thought");
assert.equal(legacyNote.favorite, "star");
assert.equal(legacyNote.occurredAt, new Date("2026-09-27T09:10:11").toISOString());
assert.equal(Object.hasOwn(legacyNote, "version"), false);
stores.get("account-a").books.find(item => item.id === legacyBook.id).annotations.push({
  id: "note-annotation",
  targetKey: `note:${legacyNote.id}`,
  quote: "重点",
  start: 8,
  end: 10
});
const legacyNoteUpdated = (await run("account-a", () => library.updateBookNote(
  legacyBook.id,
  legacyNote.id,
  {
    occurredAt: "2026-09-27T10:11:12",
    type: "record",
    favorite: "sprout",
    content: "增加前缀后的原始读书笔记含有重点"
  }
))).value;
assert.equal(legacyNoteUpdated.type, "record");
assert.equal(legacyNoteUpdated.favorite, "sprout");
assert.equal(legacyNoteUpdated.version, 2);
assert.ok(reanchors.some(item => item.targetKey === `note:${legacyNote.id}`));
assert.equal((await run("account-a", () => library.updateBookNote(
  legacyBook.id,
  legacyNote.id,
  { occurredAt: "bad", content: "不保存" }
))).error, "发生时间格式不正确");

const v1NoteInput = {
  occurredAt: "2026-09-28T01:02:03.000Z",
  type: "thought",
  favorite: "star",
  content: "有版本的笔记"
};
const v1Note = await run("account-a", () => library.createBookNote(
  v1Book.value.id,
  v1NoteInput,
  { clientRequestId: "note-create-key" }
));
assert.equal(v1Note.value.version, 1);
assert.equal((await run("account-a", () => library.createBookNote(
  v1Book.value.id,
  v1NoteInput,
  { clientRequestId: "note-create-key" }
))).duplicate, true);
assert.equal((await run("account-a", () => library.createBookNote(
  v1Book.value.id,
  { ...v1NoteInput, content: "冲突笔记" },
  { clientRequestId: "note-create-key" }
))).conflict, true);
assert.equal((await run("account-a", () => library.listBookNotes(v1Book.value.id, {
  limit: 1
}))).items[0].version, 1);
const v1NoteUpdated = await run("account-a", () => library.updateBookNote(
  v1Book.value.id,
  v1Note.value.id,
  { favorite: "sprout" },
  { expectedVersion: 1, partial: true }
));
assert.equal(v1NoteUpdated.value.version, 2);
assert.equal(v1NoteUpdated.value.content, v1NoteInput.content);
assert.deepEqual(await run("account-a", () => library.updateBookNote(
  v1Book.value.id,
  v1Note.value.id,
  { content: "过期写入" },
  { expectedVersion: 1, partial: true }
)), { versionConflict: true, currentVersion: 2 });
assert.equal(await run("account-b", () => library.getBookNote(
  v1Book.value.id,
  v1Note.value.id
)), null);

const legacyQuote = (await run("account-a", () => library.createQuote({
  occurredAt: "2026-09-27T12:13:14",
  source: " 测试来源 ",
  content: "测试善言含锚点",
  tags: [" 修行 ", "", "传统", ...Array(8).fill("越界")]
}))).value;
assert.deepEqual(legacyQuote.tags, ["修行", "传统", ...Array(6).fill("越界")]);
assert.equal(Object.hasOwn(legacyQuote, "version"), false);
stores.get("account-a").quotes[0].annotations.push({
  id: "quote-annotation",
  targetKey: "content",
  quote: "锚点",
  start: 6,
  end: 8
});
const legacyQuoteUpdated = (await run("account-a", () => library.updateQuote(legacyQuote.id, {
  source: "更新来源",
  content: "增加文字的测试善言含锚点"
}))).value;
assert.deepEqual(legacyQuoteUpdated.tags, [], "legacy PATCH continues clearing omitted tags");
assert.equal(legacyQuoteUpdated.version, 2);
assert.ok(reanchors.some(item => item.rootId === legacyQuote.id && item.targetKey === "content"));
assert.equal((await run("account-a", () => library.updateQuote(legacyQuote.id, {
  occurredAt: "bad",
  source: "更新来源",
  content: "不会保存"
}))).error, "发生时间格式不正确");

const v1QuoteInput = {
  occurredAt: "2026-09-29T04:05:06.000Z",
  source: "版本来源",
  content: "版本拾句",
  tags: ["标签"]
};
const v1Quote = await run("account-a", () => library.createQuote(v1QuoteInput, {
  clientRequestId: "quote-create-key"
}));
assert.equal(v1Quote.value.version, 1);
assert.equal((await run("account-a", () => library.createQuote(v1QuoteInput, {
  clientRequestId: "quote-create-key"
}))).duplicate, true);
assert.equal((await run("account-a", () => library.createQuote({
  ...v1QuoteInput,
  content: "冲突拾句"
}, {
  clientRequestId: "quote-create-key"
}))).conflict, true);
const v1QuoteUpdated = await run("account-a", () => library.updateQuote(
  v1Quote.value.id,
  { content: "局部更新拾句" },
  { expectedVersion: 1, partial: true }
));
assert.equal(v1QuoteUpdated.value.version, 2);
assert.equal(v1QuoteUpdated.value.source, v1QuoteInput.source);
assert.deepEqual(v1QuoteUpdated.value.tags, v1QuoteInput.tags);
assert.equal(await run("account-b", () => library.getQuote(v1Quote.value.id)), null);

const beforeFailedCommit = structuredClone(stores.get("account-a"));
failedAccounts.add("account-a");
await assert.rejects(run("account-a", () => library.updateQuote(
  v1Quote.value.id,
  { content: "不应提交" },
  { expectedVersion: 2, partial: true }
)), /commit unavailable/);
failedAccounts.delete("account-a");
assert.deepEqual(stores.get("account-a"), beforeFailedCommit);

const parsedBook = await run("account-a", () => library.parseBook({
  image: "data:image/png;base64,AAAA"
}));
assert.deepEqual(parsedBook, {
  title: "被识别的书",
  author: "作者",
  publisher: "出版社",
  isbn: "9780000000000",
  description: "简介",
  verification: "待核对",
  attachmentPaths: ["/attachments/book-input.png"]
});
assert.deepEqual(imageCalls.saved[0], {
  images: ["data:image/png;base64,AAAA"],
  maxImages: 1,
  options: { needsLocalFiles: true }
});
assert.deepEqual(imageCalls.cleaned[0], ["/tmp/book-input.png"]);
assert.equal(imageCalls.discarded.length, 0);

recognitionResult = "not-json";
await assert.rejects(
  run("account-a", () => library.parseBook({ images: ["data:image/png;base64,BBBB"] })),
  /模型返回格式无法解析/
);
assert.deepEqual(imageCalls.discarded.at(-1), ["/attachments/book-input.png"]);
assert.deepEqual(imageCalls.cleaned.at(-1), ["/tmp/book-input.png"]);
recognitionResult = JSON.stringify({ title: "恢复识别" });

assert.deepEqual(await run("account-a", () => library.removeBookNote(
  v1Book.value.id,
  v1Note.value.id,
  1
)), { versionConflict: true, currentVersion: 2 });
const removedNote = await run("account-a", () => library.removeBookNote(
  v1Book.value.id,
  v1Note.value.id,
  2
));
assert.equal(removedNote.type, "bookNote");
assert.equal((await run("account-a", () => library.createBookNote(
  v1Book.value.id,
  v1NoteInput,
  { clientRequestId: "note-create-key" }
))).duplicate, true, "deleted notes must still block idempotent recreation");
assert.equal(await run("account-b", () => library.removeBook(v1Book.value.id, 1)), null);

assert.deepEqual(await run("account-a", () => library.removeQuote(
  v1Quote.value.id,
  1
)), { versionConflict: true, currentVersion: 2 });
const removedQuote = await run("account-a", () => library.removeQuote(v1Quote.value.id, 2));
assert.equal(removedQuote.type, "quote");
assert.equal((await run("account-a", () => library.createQuote(v1QuoteInput, {
  clientRequestId: "quote-create-key"
}))).duplicate, true, "deleted quotes must still block idempotent recreation");

const durableKey = "durable-library-key";
const durableBookInput = {
  title: "持久账本书目",
  author: "账本作者",
  publisher: "",
  isbn: "",
  description: "永久清理后仍可重放",
  readingStartedOn: "2026-09-29",
  readingFinishedOn: "",
  imagePath: ""
};
const durableBook = await run("account-a", () => durableBooks.create(durableBookInput, {
  clientRequestId: durableKey
}));
assert.equal(durableBook.duplicate, false);
const durableBookReplay = await run("account-a", () => durableBooks.create(durableBookInput, {
  clientRequestId: durableKey
}));
assert.equal(durableBookReplay.duplicate, true);
assert.equal(durableBookReplay.value.id, durableBook.value.id);
assert.deepEqual(await run("account-a", () => durableBooks.create({
  ...durableBookInput,
  title: "持久账本冲突书目"
}, {
  clientRequestId: durableKey
})), { conflict: true });

const durableNoteInput = {
  occurredAt: "2026-09-29T07:10:00.000Z",
  type: "record",
  favorite: "none",
  content: "持久账本笔记"
};
const durableNote = await run("account-a", () => durableBooks.createNote(
  durableBook.value.id,
  durableNoteInput,
  { clientRequestId: durableKey }
));
assert.equal(durableNote.duplicate, false);
const durableNoteReplay = await run("account-a", () => durableBooks.createNote(
  durableBook.value.id,
  durableNoteInput,
  { clientRequestId: durableKey }
));
assert.equal(durableNoteReplay.duplicate, true);
assert.equal(durableNoteReplay.value.id, durableNote.value.id);
assert.deepEqual(await run("account-a", () => durableBooks.createNote(
  durableBook.value.id,
  { ...durableNoteInput, content: "持久账本冲突笔记" },
  { clientRequestId: durableKey }
)), { conflict: true });

const durableQuoteInput = {
  occurredAt: "2026-09-29T07:20:00.000Z",
  source: "持久账本来源",
  content: "持久账本善言",
  tags: ["账本"]
};
const durableQuote = await run("account-a", () => durableQuotes.create(durableQuoteInput, {
  clientRequestId: durableKey
}));
assert.equal(durableQuote.duplicate, false);
const durableQuoteReplay = await run("account-a", () => durableQuotes.create(durableQuoteInput, {
  clientRequestId: durableKey
}));
assert.equal(durableQuoteReplay.duplicate, true);
assert.equal(durableQuoteReplay.value.id, durableQuote.value.id);
assert.deepEqual(await run("account-a", () => durableQuotes.create({
  ...durableQuoteInput,
  content: "持久账本冲突善言"
}, {
  clientRequestId: durableKey
})), { conflict: true });
assert.deepEqual(
  [...new Set(durableRequests.map(item => item.scope))].sort(),
  ["books.create", "books.notes.create", "quotes.create"],
  "library create scopes must remain stable and separate"
);

await run("account-a", () => durableRepository.update(store => {
  moveNestedItemToTrash(store, {
    parentCollection: "books",
    parentId: durableBook.value.id,
    field: "notes",
    type: "bookNote",
    id: durableNote.value.id,
    annotationTargetKeys: [`note:${durableNote.value.id}`]
  });
  moveCollectionItemToTrash(store, "books", "book", durableBook.value.id);
  moveCollectionItemToTrash(store, "quotes", "quote", durableQuote.value.id);
}));
await run("account-a", () => durableRepository.update(store => {
  const purged = new Set([durableBook.value.id, durableNote.value.id, durableQuote.value.id]);
  store.trash = store.trash.filter(item => !purged.has(item.resourceId));
}));
assert.equal(stores.get("account-a").trash.some(item => (
  item.resourceId === durableBook.value.id
  || item.resourceId === durableNote.value.id
  || item.resourceId === durableQuote.value.id
)), false);

const restartedDurableBooks = createBookRecords({
  repository: durableCollectionRepository("books"),
  reanchorAnnotations,
  now,
  createId
});
const restartedDurableQuotes = createQuoteRecords({
  repository: durableCollectionRepository("quotes"),
  reanchorAnnotations,
  now,
  createId
});
const bookAfterPurge = await run("account-a", () => restartedDurableBooks.create(durableBookInput, {
  clientRequestId: durableKey
}));
const noteAfterPurge = await run("account-a", () => restartedDurableBooks.createNote(
  durableBook.value.id,
  durableNoteInput,
  { clientRequestId: durableKey }
));
const quoteAfterPurge = await run("account-a", () => restartedDurableQuotes.create(durableQuoteInput, {
  clientRequestId: durableKey
}));
assert.deepEqual(
  [bookAfterPurge, noteAfterPurge, quoteAfterPurge].map(result => ({
    id: result.value.id,
    duplicate: result.duplicate
  })),
  [
    { id: durableBook.value.id, duplicate: true },
    { id: durableNote.value.id, duplicate: true },
    { id: durableQuote.value.id, duplicate: true }
  ]
);
assert.equal(stores.get("account-a").books.some(item => item.id === durableBook.value.id), false);
assert.equal(stores.get("account-a").quotes.some(item => item.id === durableQuote.value.id), false);
assert.deepEqual(await run("account-a", () => restartedDurableBooks.create({
  ...durableBookInput,
  title: "永久清理后的冲突书目"
}, {
  clientRequestId: durableKey
})), { conflict: true });
assert.deepEqual(await run("account-a", () => restartedDurableBooks.createNote(
  durableBook.value.id,
  { ...durableNoteInput, content: "永久清理后的冲突笔记" },
  { clientRequestId: durableKey }
)), { conflict: true });
assert.deepEqual(await run("account-a", () => restartedDurableQuotes.create({
  ...durableQuoteInput,
  content: "永久清理后的冲突善言"
}, {
  clientRequestId: durableKey
})), { conflict: true });

function createResponse() {
  return {
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    }
  };
}

function sendJson(res, status, value) {
  res.status = status;
  res.value = value;
  res.headersSent = true;
  res.writableEnded = true;
  return value;
}

const libraryHttp = createLibraryHttp({
  library,
  bodyJson: async req => req.body || {},
  sendJson,
  async sendTrashResult(res, entry, message) {
    sendJson(res, entry ? 200 : 404, entry
      ? { removed: 1, trashId: entry.id }
      : { error: message });
  }
});

async function legacyRequest(method, pathname, body = {}) {
  const res = createResponse();
  const handled = await run("account-a", () => libraryHttp.handle(
    { method, headers: {}, body },
    res,
    new URL(`http://local${pathname}`)
  ));
  return { handled, res };
}

let legacyResponse = await legacyRequest("POST", "/api/books", {
  title: " ",
  readingStartedOn: "2026-09-01"
});
assert.equal(legacyResponse.handled, true);
assert.deepEqual([legacyResponse.res.status, legacyResponse.res.value], [400, { error: "书名不能为空" }]);
legacyResponse = await legacyRequest("PATCH", "/api/books/missing", {
  title: "存在格式的缺失书目"
});
assert.deepEqual([legacyResponse.res.status, legacyResponse.res.value], [404, { error: "书目不存在" }]);
legacyResponse = await legacyRequest("PATCH", `/api/books/${legacyBook.id}/notes/${legacyNote.id}`, {
  occurredAt: "bad",
  content: "时间错误"
});
assert.deepEqual(
  [legacyResponse.res.status, legacyResponse.res.value],
  [404, { error: "书目记录不存在或时间格式不正确" }]
);
legacyResponse = await legacyRequest("POST", "/api/quotes", {
  source: "",
  content: "内容"
});
assert.deepEqual(
  [legacyResponse.res.status, legacyResponse.res.value],
  [400, { error: "来源和内容都必须填写" }]
);
legacyResponse = await legacyRequest("PATCH", `/api/quotes/${legacyQuote.id}`, {
  occurredAt: "bad",
  source: "来源",
  content: "内容"
});
assert.deepEqual(
  [legacyResponse.res.status, legacyResponse.res.value],
  [404, { error: "善言不存在或时间格式不正确" }]
);
legacyResponse = await legacyRequest("POST", "/api/books/parse", {
  image: "data:image/png;base64,CCCC"
});
assert.equal(legacyResponse.res.status, 200);
assert.equal(legacyResponse.res.value.title, "恢复识别");

legacyResponse = await legacyRequest("POST", "/api/books", {
  title: "旧路由书目",
  author: "旧路由作者",
  description: "旧路由简介",
  readingStartedOn: "2026-09-21",
  readingFinishedOn: ""
});
assert.equal(legacyResponse.res.status, 201);
const legacyHttpBook = legacyResponse.res.value;
legacyResponse = await legacyRequest("PATCH", `/api/books/${legacyHttpBook.id}`, {
  title: "旧路由更新书目",
  author: "更新作者",
  description: "更新简介"
});
assert.equal(legacyResponse.res.status, 200);
assert.equal(legacyResponse.res.value.title, "旧路由更新书目");
legacyResponse = await legacyRequest("POST", `/api/books/${legacyHttpBook.id}/notes`, {
  occurredAt: "2026-09-29T03:00:00.000Z",
  type: "thought",
  favorite: "star",
  content: "旧路由笔记"
});
assert.equal(legacyResponse.res.status, 201);
const legacyHttpNote = legacyResponse.res.value;
legacyResponse = await legacyRequest(
  "PATCH",
  `/api/books/${legacyHttpBook.id}/notes/${legacyHttpNote.id}`,
  {
    occurredAt: "2026-09-29T03:30:00.000Z",
    type: "record",
    favorite: "sprout",
    content: "旧路由更新笔记"
  }
);
assert.equal(legacyResponse.res.status, 200);
assert.equal(legacyResponse.res.value.favorite, "sprout");

legacyResponse = await legacyRequest("POST", "/api/quotes", {
  occurredAt: "2026-09-29T04:00:00.000Z",
  source: "旧路由来源",
  content: "旧路由拾句",
  tags: ["旧路由"]
});
assert.equal(legacyResponse.res.status, 201);
const legacyHttpQuote = legacyResponse.res.value;
legacyResponse = await legacyRequest("PATCH", `/api/quotes/${legacyHttpQuote.id}`, {
  occurredAt: "2026-09-29T04:30:00.000Z",
  source: "旧路由更新来源",
  content: "旧路由更新拾句",
  tags: ["更新"]
});
assert.equal(legacyResponse.res.status, 200);
assert.deepEqual(legacyResponse.res.value.tags, ["更新"]);
legacyResponse = await legacyRequest("DELETE", `/api/quotes/${legacyHttpQuote.id}`);
assert.equal(legacyResponse.res.status, 200);
legacyResponse = await legacyRequest(
  "DELETE",
  `/api/books/${legacyHttpBook.id}/notes/${legacyHttpNote.id}`
);
assert.equal(legacyResponse.res.status, 200);
legacyResponse = await legacyRequest("DELETE", `/api/books/${legacyHttpBook.id}`);
assert.equal(legacyResponse.res.status, 200);
assert.equal((await legacyRequest("GET", "/api/books")).handled, false);

const apiV1 = createApiV1Http({
  sendJson,
  getContext: () => ({ traceId: `trace-${context.getStore()}` }),
  openApi: {}
});
apiV1.register("library", libraryHttp.handleV1);

async function v1Request(account, method, pathname, body = {}, headers = {}) {
  const res = createResponse();
  const handled = await run(account, () => apiV1.handle(
    { method, headers, body },
    res,
    new URL(`http://local${pathname}`)
  ));
  return { handled, res };
}

const httpBookInput = {
  title: "HTTP v1 书目",
  author: "HTTP 作者",
  description: "HTTP 简介",
  readingStartedOn: "2026-09-20",
  readingFinishedOn: ""
};
await assert.rejects(
  v1Request("account-a", "POST", "/api/v1/books", httpBookInput),
  error => error.code === "IDEMPOTENCY_KEY_REQUIRED" && error.statusCode === 400
);
let v1Response = await v1Request(
  "account-a",
  "POST",
  "/api/v1/books",
  httpBookInput,
  { "idempotency-key": "http-book-key" }
);
assert.equal(v1Response.handled, true);
assert.equal(v1Response.res.status, 201);
assert.equal(v1Response.res.headers.etag, "\"1\"");
assert.equal(v1Response.res.value.error, null);
assert.equal(v1Response.res.value.meta.traceId, "trace-account-a");
const httpBook = v1Response.res.value.data;
v1Response = await v1Request(
  "account-a",
  "POST",
  "/api/v1/books",
  httpBookInput,
  { "idempotency-key": "http-book-key" }
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.value.data.id, httpBook.id);

v1Response = await v1Request("account-a", "GET", "/api/v1/books?limit=1");
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.value.data.length, 1);
assert.ok(v1Response.res.value.meta.nextCursor);
const nextBookCursor = v1Response.res.value.meta.nextCursor;
v1Response = await v1Request(
  "account-a",
  "GET",
  `/api/v1/books?limit=1&cursor=${encodeURIComponent(nextBookCursor)}`
);
assert.equal(v1Response.res.status, 200);
await assert.rejects(
  v1Request("account-a", "GET", "/api/v1/books?cursor=not-a-cursor"),
  error => error.code === "INVALID_CURSOR"
);
v1Response = await v1Request("account-b", "GET", `/api/v1/books/${httpBook.id}`);
assert.equal(v1Response.res.status, 404);
v1Response = await v1Request("account-a", "GET", `/api/v1/books/${httpBook.id}`);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.headers.etag, "\"1\"");
await assert.rejects(
  v1Request("account-a", "PATCH", `/api/v1/books/${httpBook.id}`, { title: "无条件更新" }),
  error => error.code === "PRECONDITION_REQUIRED" && error.statusCode === 428
);
v1Response = await v1Request(
  "account-a",
  "PATCH",
  `/api/v1/books/${httpBook.id}`,
  { title: "过期更新" },
  { "if-match": "\"9\"" }
);
assert.equal(v1Response.res.status, 412);
assert.equal(v1Response.res.value.error.code, "PRECONDITION_FAILED");
v1Response = await v1Request(
  "account-a",
  "PATCH",
  `/api/v1/books/${httpBook.id}`,
  { title: "HTTP 局部更新" },
  { "if-match": "\"1\"" }
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.headers.etag, "\"2\"");
assert.equal(v1Response.res.value.data.author, "HTTP 作者");

const httpNoteInput = {
  occurredAt: "2026-09-29T06:00:00.000Z",
  type: "record",
  favorite: "star",
  content: "HTTP 笔记"
};
v1Response = await v1Request(
  "account-a",
  "POST",
  `/api/v1/books/${httpBook.id}/notes`,
  httpNoteInput,
  { "idempotency-key": "http-note-key" }
);
assert.equal(v1Response.res.status, 201);
assert.equal(v1Response.res.headers.etag, "\"1\"");
const httpNote = v1Response.res.value.data;
v1Response = await v1Request(
  "account-a",
  "GET",
  `/api/v1/books/${httpBook.id}/notes/${httpNote.id}`
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.headers.etag, "\"1\"");
v1Response = await v1Request(
  "account-a",
  "PATCH",
  `/api/v1/books/${httpBook.id}/notes/${httpNote.id}`,
  { favorite: "sprout" },
  { "if-match": "\"1\"" }
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.headers.etag, "\"2\"");
v1Response = await v1Request(
  "account-a",
  "DELETE",
  `/api/v1/books/${httpBook.id}/notes/${httpNote.id}`,
  {},
  { "if-match": "\"1\"" }
);
assert.equal(v1Response.res.status, 412);
v1Response = await v1Request(
  "account-a",
  "DELETE",
  `/api/v1/books/${httpBook.id}/notes/${httpNote.id}`,
  {},
  { "if-match": "\"2\"" }
);
assert.equal(v1Response.res.status, 200);
assert.match(v1Response.res.value.data.trashId, /^trash-/);

const httpQuoteInput = {
  occurredAt: "2026-09-29T07:00:00.000Z",
  source: "HTTP 来源",
  content: "HTTP 拾句",
  tags: ["HTTP"]
};
v1Response = await v1Request(
  "account-a",
  "POST",
  "/api/v1/quotes",
  httpQuoteInput,
  { "idempotency-key": "http-quote-key" }
);
assert.equal(v1Response.res.status, 201);
const httpQuote = v1Response.res.value.data;
v1Response = await v1Request("account-a", "GET", "/api/v1/quotes?limit=1");
assert.equal(v1Response.res.status, 200);
v1Response = await v1Request("account-b", "GET", `/api/v1/quotes/${httpQuote.id}`);
assert.equal(v1Response.res.status, 404);
v1Response = await v1Request(
  "account-a",
  "PATCH",
  `/api/v1/quotes/${httpQuote.id}`,
  { content: "HTTP 更新拾句" },
  { "if-match": "\"1\"" }
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.headers.etag, "\"2\"");
v1Response = await v1Request(
  "account-a",
  "DELETE",
  `/api/v1/quotes/${httpQuote.id}`,
  {},
  { "if-match": "\"2\"" }
);
assert.equal(v1Response.res.status, 200);
v1Response = await v1Request(
  "account-a",
  "POST",
  "/api/v1/books/parse",
  { image: "data:image/png;base64,DDDD" }
);
assert.equal(v1Response.res.status, 200);
assert.equal(v1Response.res.value.data.title, "恢复识别");

const currentHttpBook = await run("account-a", () => library.getBook(httpBook.id));
v1Response = await v1Request(
  "account-a",
  "DELETE",
  `/api/v1/books/${httpBook.id}`,
  {},
  { "if-match": `"${currentHttpBook.version}"` }
);
assert.equal(v1Response.res.status, 200);

assert.deepEqual(Object.keys(libraryOpenApiFragment).sort(), ["components", "paths"]);
assert.strictEqual(libraryOpenApiFragment.paths, libraryPaths);
assert.strictEqual(libraryOpenApiFragment.components, libraryComponents);
assert.deepEqual(Object.keys(libraryPaths).sort(), [
  "/books",
  "/books/parse",
  "/books/{bookId}",
  "/books/{bookId}/notes",
  "/books/{bookId}/notes/{noteId}",
  "/quotes",
  "/quotes/{quoteId}"
]);

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const operations = Object.entries(libraryPaths).flatMap(([route, pathItem]) => Object.entries(pathItem)
  .filter(([method]) => HTTP_METHODS.has(method))
  .map(([method, operation]) => ({ route, method, operation, pathItem })));
assert.equal(operations.length, 16);
assert.equal(new Set(operations.map(item => item.operation.operationId)).size, operations.length);

const openApiDocument = {
  paths: libraryPaths,
  components: {
    parameters: {
      IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true },
      IfMatch: { name: "If-Match", in: "header", required: true },
      Cursor: { name: "cursor", in: "query" },
      Limit: { name: "limit", in: "query" },
      ...libraryComponents.parameters
    },
    schemas: {
      SuccessEnvelope: { type: "object" },
      TrashReference: { type: "object" },
      ...libraryComponents.schemas
    },
    responses: {
      BadRequest: { description: "bad request" },
      Unauthorized: { description: "unauthorized" },
      NotFound: { description: "not found" },
      Conflict: { description: "conflict" },
      PreconditionFailed: { description: "precondition failed" },
      PreconditionRequired: { description: "precondition required" }
    }
  }
};

function collectRefs(value, refs = []) {
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const nested of Object.values(value)) collectRefs(nested, refs);
  return refs;
}

function resolveRef(document, ref) {
  assert.match(ref, /^#\//);
  return ref.slice(2).split("/").reduce((value, encodedPart) => {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value && Object.hasOwn(value, part), `Unresolved OpenAPI reference: ${ref}`);
    return value[part];
  }, document);
}

for (const ref of collectRefs(openApiDocument)) resolveRef(openApiDocument, ref);

function resolvedParameters(operation) {
  return [...(operation.pathItem.parameters || []), ...(operation.operation.parameters || [])]
    .map(parameter => parameter.$ref ? resolveRef(openApiDocument, parameter.$ref) : parameter);
}

for (const [route, method, header] of [
  ["/books", "post", "Idempotency-Key"],
  ["/books/{bookId}/notes", "post", "Idempotency-Key"],
  ["/quotes", "post", "Idempotency-Key"],
  ["/books/{bookId}", "patch", "If-Match"],
  ["/books/{bookId}", "delete", "If-Match"],
  ["/books/{bookId}/notes/{noteId}", "patch", "If-Match"],
  ["/books/{bookId}/notes/{noteId}", "delete", "If-Match"],
  ["/quotes/{quoteId}", "patch", "If-Match"],
  ["/quotes/{quoteId}", "delete", "If-Match"]
]) {
  const entry = operations.find(item => item.route === route && item.method === method);
  const parameter = resolvedParameters(entry)
    .find(item => item.in === "header" && item.name.toLowerCase() === header.toLowerCase());
  assert.ok(parameter, `${method.toUpperCase()} ${route} must declare ${header}`);
  assert.equal(parameter.required, true);
}

const routeCalls = [];
const routeLibrary = {
  listBooks: async () => ({ items: [], nextId: "" }),
  createBook: async () => ({ value: { id: "book", version: 1 } }),
  parseBook: async () => ({ title: "" }),
  getBook: async () => ({ id: "book", version: 1 }),
  updateBook: async () => ({ value: { id: "book", version: 2 } }),
  removeBook: async () => ({ id: "trash-book" }),
  listBookNotes: async () => ({ items: [], nextId: "" }),
  createBookNote: async () => ({ value: { id: "note", version: 1 } }),
  getBookNote: async () => ({ id: "note", version: 1 }),
  updateBookNote: async () => ({ value: { id: "note", version: 2 } }),
  removeBookNote: async () => ({ id: "trash-note" }),
  listQuotes: async () => ({ items: [], nextId: "" }),
  createQuote: async () => ({ value: { id: "quote", version: 1 } }),
  getQuote: async () => ({ id: "quote", version: 1 }),
  updateQuote: async () => ({ value: { id: "quote", version: 2 } }),
  removeQuote: async () => ({ id: "trash-quote" })
};
for (const key of Object.keys(routeLibrary)) {
  const operation = routeLibrary[key];
  routeLibrary[key] = async (...args) => {
    routeCalls.push(key);
    return operation(...args);
  };
}
const routeHttp = createLibraryHttp({
  library: routeLibrary,
  bodyJson: async () => ({}),
  sendJson,
  sendTrashResult: async () => {}
});
const routeV1 = {
  pagination: () => ({ limit: 20, afterId: "" }),
  nextCursor: () => null,
  idempotencyKey: () => "route-key",
  expectedVersion: () => 1,
  versionEtag: version => `"${version}"`,
  success: (res, status, value) => sendJson(res, status, value),
  error: (res, status, message, code) => sendJson(res, status, { message, code })
};
const workflowForOperation = {
  parseBookImage: "parseBook",
  deleteBook: "removeBook",
  deleteBookNote: "removeBookNote",
  deleteQuote: "removeQuote"
};
for (const { route, method, operation } of operations) {
  const pathname = `/api/v1${route.replace("{bookId}", "book").replace("{noteId}", "note").replace("{quoteId}", "quote")}`;
  const res = createResponse();
  await routeHttp.handleV1(
    { method: method.toUpperCase(), headers: {}, body: {} },
    res,
    new URL(`http://local${pathname}`),
    routeV1
  );
  assert.equal(res.headersSent, true, `No runtime route for ${method.toUpperCase()} ${route}`);
  assert.equal(
    routeCalls.at(-1),
    workflowForOperation[operation.operationId] || operation.operationId,
    `Wrong workflow for ${operation.operationId}`
  );
}

for (const relative of [
  "src/modules/books/records.mjs",
  "src/modules/quotes/records.mjs",
  "src/app/library-workflows.mjs",
  "src/http/library.mjs"
]) {
  const source = await fs.readFile(path.join(ROOT, relative), "utf8");
  assert.doesNotMatch(source, /store\.json|node:fs|readFile|writeFile/, `${relative} must not depend on JSON files`);
}

console.log(
  `Library contracts passed: legacy compatibility, ${operations.length} v1 operations, cursors, ETags, idempotency, account isolation, recognition cleanup and closed OpenAPI references.`
);
