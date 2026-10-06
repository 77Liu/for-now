import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLibraryFeatureController } from "../public/frontend/features/library/index.mjs";
import { createLibraryMedia } from "../public/frontend/features/library/media.mjs";
import {
  bookMatchesSearch,
  normalizeLibrarySearch,
  sortedBookNotes
} from "../public/frontend/features/library/model.mjs";
import { createLibraryOperations } from "../public/frontend/features/library/operations.mjs";
import { createLibraryPresentation } from "../public/frontend/features/library/presentation.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

assert.equal(normalizeLibrarySearch("  原子   习惯 "), "原子 习惯");
assert.equal(bookMatchesSearch({
  title: "原子习惯",
  author: "James Clear",
  notes: [{ content: "每天改进百分之一" }]
}, "JAMES 百分之一"), true);
assert.equal(bookMatchesSearch({ title: "原子习惯" }, "不存在"), false);
assert.deepEqual(
  sortedBookNotes({
    notes: [
      { id: "old", occurredAt: "2026-10-01T08:00:00.000Z" },
      { id: "new", occurredAt: "2026-10-02T08:00:00.000Z" }
    ]
  }, item => item.occurredAt).map(item => item.id),
  ["new", "old"]
);
const presentation = createLibraryPresentation({
  appUrl: value => `/now${value}`,
  contentState: ({ title }) => `<empty>${title}</empty>`,
  escapeMarkup: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
  plainPreview: value => String(value || "").replaceAll("*", ""),
  renderMarkdown: value => `<markdown>${value}</markdown>`,
  eventDate: item => item.occurredAt.slice(0, 10),
  eventTimestamp: item => item.occurredAt,
  formatDate: value => `date:${value}`,
  formatDateKey: value => `day:${value}`,
  formatTime: value => `time:${value}`
});
const presentedBook = {
  id: "book-render",
  title: "书名",
  author: "作者",
  imagePath: "/attachments/cover.webp",
  readingStartedOn: "2026-10-01",
  description: "**简介**",
  notes: [
    {
      id: "note-old",
      type: "record",
      favorite: "star",
      content: "旧记录",
      occurredAt: "2026-10-01T08:00:00.000Z"
    },
    {
      id: "note-new",
      type: "thought",
      favorite: "sprout",
      content: "新思考",
      occurredAt: "2026-10-02T08:00:00.000Z"
    }
  ]
};
const detailMarkup = presentation.detail(presentedBook, presentedBook.notes[1]);
assert.match(detailMarkup, /\/now\/attachments\/cover\.webp/);
assert.match(detailMarkup, /<markdown>\*\*简介\*\*<\/markdown>/);
assert.match(detailMarkup, /data-book-note-favorite="note-new"/);
assert.match(detailMarkup, /data-next-favorite="none"/);
assert.ok(
  detailMarkup.indexOf("note-new") < detailMarkup.indexOf("note-old"),
  "book timeline must render newest notes first"
);
assert.match(presentation.cards([presentedBook]), /data-open-book="book-render"/);
assert.equal(
  presentation.searchEmpty(),
  "<empty>没有匹配的书目</empty>"
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) || new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ type, target: this, ...event });
    }
  }
}

class FakeRoot extends FakeEventTarget {
  constructor() {
    super();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

const lifecycleWindow = new FakeEventTarget();
const lifecycleDocument = new FakeEventTarget();
lifecycleDocument.createElement = () => ({});
const lifecycleUrls = [];
const lifecycleFrames = new Map();
let lifecycleFrameSequence = 0;
let lifecycleAccount = "account-a";
let lifecycleSession = 1;
const lifecycleController = createLibraryFeatureController({
  data: {
    getSnapshot: () => ({ books: [] }),
    getAccountId: () => lifecycleAccount,
    getSessionSerial: () => lifecycleSession,
    request: async () => ({}),
    requestV1: async () => ({ data: {} }),
    refresh: async () => {},
    applyPendingProjection() {},
    publish() {}
  },
  navigation: { scrollTo() {} },
  media: {
    validateImages: files => files,
    imageDataUrls: async () => [],
    uploadOriginalImages: async () => [],
    discardUploadedImagePath: async () => false,
    readBlob: async () => new Blob()
  },
  annotations: {
    rootKey: (type, id) => `${type}:${id}`,
    markTarget() {},
    applyAnchors() {}
  },
  view: {
    appUrl: value => value,
    contentState: () => "",
    escapeMarkup: value => String(value ?? ""),
    plainPreview: value => String(value ?? ""),
    renderMarkdown: value => String(value ?? ""),
    renderLatex() {},
    eventDate: item => item.occurredOn || "",
    eventTimestamp: item => item.occurredAt || item.createdAt || "",
    formatDate: value => String(value),
    formatDateKey: value => String(value),
    formatTime: value => String(value),
    localDateKey: () => "2026-10-06",
    resetOccurrenceInput() {},
    occurrenceFields: () => ({ timeMode: "now" }),
    showToast() {},
    entryKeyIntent: () => "none"
  },
  platform: {
    document: lifecycleDocument,
    window: lifecycleWindow,
    objectUrls: {
      createObjectURL: () => "blob:lifecycle",
      revokeObjectURL: value => lifecycleUrls.push(value)
    },
    createFile: (blob, name, type) => ({ blob, name, type }),
    createRequestId: () => "lifecycle-request",
    requestFrame(callback) {
      const frame = ++lifecycleFrameSequence;
      lifecycleFrames.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) {
      lifecycleFrames.delete(frame);
    },
    getComputedStyle: () => ({ lineHeight: "16" }),
    createRange: () => ({}),
    random: () => 0.5,
    confirm: () => true,
    escapeSelector: value => String(value),
    now: () => "2026-10-06T08:00:00.000Z"
  }
});

const lifecycleRoot = new FakeRoot();
const rootEvents = [
  "click", "submit", "input", "change", "focusin", "pointerdown", "keydown",
  "dragenter", "dragover", "dragleave", "drop"
];
let staleDispose = null;
for (let cycle = 0; cycle < 20; cycle += 1) {
  const dispose = await lifecycleController.mount({
    root: lifecycleRoot,
    route: { view: "books" },
    signal: new AbortController().signal
  });
  for (const type of rootEvents) assert.equal(lifecycleRoot.listenerCount(type), 1);
  assert.equal(lifecycleWindow.listenerCount("scroll"), 1);
  assert.equal(lifecycleWindow.listenerCount("resize"), 1);
  assert.equal(lifecycleDocument.listenerCount("paste"), 1);
  if (staleDispose) assert.equal(await staleDispose(), false);
  staleDispose = dispose;
}
assert.equal(await staleDispose(), true);
assert.equal(await staleDispose(), false);
for (const type of rootEvents) assert.equal(lifecycleRoot.listenerCount(type), 0);
assert.equal(lifecycleWindow.listenerCount("scroll"), 0);
assert.equal(lifecycleWindow.listenerCount("resize"), 0);
assert.equal(lifecycleDocument.listenerCount("paste"), 0);

await lifecycleController.mount({
  root: lifecycleRoot,
  route: { view: "books" },
  signal: new AbortController().signal
});
lifecycleWindow.dispatch("resize");
assert.equal(lifecycleFrames.size, 1);
lifecycleAccount = "account-b";
lifecycleSession += 1;
await lifecycleController.resetSession();
assert.equal(lifecycleFrames.size, 0, "unmount must cancel scheduled animation frames");
for (const type of rootEvents) assert.equal(lifecycleRoot.listenerCount(type), 0);
assert.equal(lifecycleWindow.listenerCount("scroll"), 0);
assert.equal(lifecycleController.openBook("missing"), false);

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    }
  };
}

function fakeNode(extra = {}) {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    classList: fakeClassList(),
    removeAttribute(name) {
      delete this[name];
    },
    ...extra
  };
}

const mediaNodes = new Map();
for (const selector of [
  "#book-cover-image", "#book-cover-preview", "#book-cover-upload-box",
  "#book-cover-upload-title", "#book-cover-upload-hint", "#book-cover-remove",
  "#book-recognition-image", "#book-recognition-preview",
  "#book-recognition-upload-box", "#book-recognition-upload-title",
  "#book-recognition-upload-hint", "#book-recognition-remove", "#parse-book",
  "#book-image-swap", "#book-parse-status", "#book-image-path", "#book-title",
  "#book-author", "#book-publisher", "#book-isbn", "#book-description"
]) {
  mediaNodes.set(selector, fakeNode());
}
const mediaRequests = [];
const mediaCreatedUrls = [];
const mediaRevokedUrls = [];
let mediaOwner = "account-a";
let mediaSession = 1;
let mediaActivation = {};
let mediaGeneration = 1;
const mediaState = { editingBookId: "", activation: mediaActivation };
const mediaTicket = () => ({
  activation: mediaActivation,
  generation: mediaGeneration,
  owner: mediaOwner,
  serial: mediaSession
});
const mediaSameSession = ticket => ticket.owner === mediaOwner
  && ticket.serial === mediaSession;
const mediaCurrent = ticket => mediaSameSession(ticket)
  && ticket.activation === mediaActivation
  && ticket.generation === mediaGeneration;
const mediaWorkflow = createLibraryMedia({
  data: {
    request(url, options) {
      const gate = deferred();
      mediaRequests.push({ url, options, gate });
      return gate.promise;
    }
  },
  media: {
    validateImages: files => files,
    imageDataUrls: async files => files.map(file => `data:${file.name}`),
    uploadOriginalImages: async () => [],
    discardUploadedImagePath: async () => false,
    readBlob: async () => new Blob(["cover"], { type: "image/png" })
  },
  platform: {
    createRequestId: (() => {
      let sequence = 0;
      return () => `ocr-${++sequence}`;
    })(),
    createFile: (blob, name, type) => ({ blob, name, type }),
    objectUrls: {
      createObjectURL(file) {
        const value = `blob:${file.name}`;
        mediaCreatedUrls.push(value);
        return value;
      },
      revokeObjectURL(value) {
        mediaRevokedUrls.push(value);
      }
    }
  },
  state: mediaState,
  libraryView: {
    query: selector => mediaNodes.get(selector) || null
  },
  createTicket: mediaTicket,
  isCurrent: mediaCurrent,
  isSameSession: mediaSameSession
});

const recognitionA = { name: "a.png", type: "image/png", size: 10 };
const recognitionB = { name: "b.png", type: "image/png", size: 11 };
assert.equal(mediaWorkflow.setImage("recognition", recognitionA, "测试"), true);
const staleRecognition = mediaWorkflow.recognize();
await waitFor(() => mediaRequests.length === 1, "first OCR request must start");
assert.equal(mediaWorkflow.setImage("recognition", recognitionB, "替换"), true);
mediaRequests[0].gate.resolve({
  requestId: "ocr-1",
  targetId: "book-draft",
  inputVersion: 2,
  title: "迟到标题"
});
assert.equal(await staleRecognition, false);
assert.equal(mediaNodes.get("#book-title").value, "");
assert.ok(mediaRevokedUrls.includes("blob:a.png"));

const accountStale = mediaWorkflow.recognize();
await waitFor(() => mediaRequests.length === 2, "second OCR request must start");
mediaOwner = "account-b";
mediaSession += 1;
mediaRequests[1].gate.resolve({
  requestId: "ocr-2",
  targetId: "book-draft",
  title: "旧账户标题"
});
assert.equal(await accountStale, false);
assert.equal(mediaNodes.get("#book-title").value, "");

mediaOwner = "account-a";
mediaSession += 1;
mediaActivation = {};
mediaGeneration += 1;
mediaState.activation = mediaActivation;
mediaWorkflow.setImage("recognition", recognitionA, "重新选择");
const successfulRecognition = mediaWorkflow.recognize();
await waitFor(() => mediaRequests.length === 3, "third OCR request must start");
const requestBody = JSON.parse(mediaRequests[2].options.body);
mediaRequests[2].gate.resolve({
  requestId: requestBody.requestId,
  targetId: requestBody.targetId,
  inputVersion: requestBody.inputVersion,
  title: "有效标题",
  verification: "请核对"
});
assert.equal(await successfulRecognition, true);
assert.equal(mediaNodes.get("#book-title").value, "有效标题");
assert.equal(mediaNodes.get("#book-parse-status").textContent, "请核对");
mediaWorkflow.setImage("recognition", recognitionB, "离页前");
const activationStale = mediaWorkflow.recognize();
await waitFor(() => mediaRequests.length === 4, "fourth OCR request must start");
mediaWorkflow.resume();
assert.equal(mediaNodes.get("#parse-book").disabled, false);
assert.equal(
  mediaNodes.get("#book-parse-status").textContent,
  "识别图已就绪，可以回填书目信息。"
);
mediaRequests[3].gate.resolve({ title: "失效 activation 标题" });
assert.equal(await activationStale, false);
assert.equal(mediaNodes.get("#book-title").value, "有效标题");
mediaWorkflow.setImage("cover", {
  name: "cover.png",
  type: "image/png",
  size: 12
});
mediaWorkflow.resetSession();
assert.deepEqual(
  [...new Set(mediaRevokedUrls)].sort(),
  [...new Set(mediaCreatedUrls)].sort(),
  "session reset must release every preview Blob URL"
);

function createBookForm() {
  return {
    dataset: {},
    resetCalled: 0,
    reset() {
      this.resetCalled += 1;
    }
  };
}

function createNoteForm({
  bookId = "book-1",
  noteId = "",
  content = "保留这段笔记",
  requestId = ""
} = {}) {
  const button = fakeNode();
  const status = fakeNode();
  const form = {
    dataset: { bookEntryForm: bookId, ...(requestId ? { requestId } : {}) },
    elements: {
      noteId: { value: noteId },
      occurredAt: { value: "2026-10-06T08:00:00" },
      type: { value: "record" },
      favorite: { value: "none" },
      content: { value: content }
    },
    querySelector(selector) {
      if (selector === '[type="submit"]') return button;
      if (selector === ".status") return status;
      return null;
    },
    button,
    status
  };
  return form;
}

function createOperationsHarness({
  snapshot,
  requestV1,
  editingBookId = "",
  session = { token: 1, current: true }
}) {
  const fields = new Map([
    ["#book-submit", fakeNode()],
    ["#book-title", fakeNode({ value: "一本书" })],
    ["#book-author", fakeNode({ value: "作者" })],
    ["#book-publisher", fakeNode({ value: "出版社" })],
    ["#book-isbn", fakeNode({ value: "isbn" })],
    ["#book-reading-start", fakeNode({ value: "2026-10-01" })],
    ["#book-reading-end", fakeNode({ value: "" })],
    ["#book-description", fakeNode({ value: "简介" })],
    ["#book-parse-status", fakeNode()]
  ]);
  const calls = [];
  const toasts = [];
  const restoredDrafts = [];
  const state = {
    editingBookId,
    activeBookId: editingBookId,
    activeBookFeatureNoteId: "",
    pendingBookNoteId: "",
    bookCreatorOpen: true,
    bookDetailCondensed: false
  };
  let requestSequence = 0;
  let renders = 0;
  let resets = 0;
  let projections = 0;
  let retryForm = null;
  const data = {
    getSnapshot: () => snapshot,
    async requestV1(url, options, coordination) {
      calls.push({ url, options, coordination });
      return requestV1(url, options, coordination, calls.length);
    },
    refresh: async () => {},
    applyPendingProjection() {
      projections += 1;
    },
    publish() {}
  };
  const libraryView = {
    query: selector => fields.get(selector) || null,
    findBook: id => snapshot.books.find(item => item.id === id),
    resetBookForm() {
      resets += 1;
    },
    render() {
      renders += 1;
    },
    restoreNoteDraft(draft, message) {
      restoredDrafts.push({ draft: structuredClone(draft), message });
      retryForm = createNoteForm({
        bookId: draft.bookId,
        noteId: draft.noteId,
        content: draft.payload.content,
        requestId: draft.requestId
      });
      retryForm.status.textContent = message;
      return true;
    }
  };
  const operations = createLibraryOperations({
    data,
    media: {
      uploadCover: async () => ({
        imagePath: "",
        uploadedPath: "",
        uploadRequestId: ""
      }),
      discardUpload: async () => false
    },
    view: {
      occurrenceFields: input => ({
        timeMode: "manual",
        occurredAt: input.value
      }),
      showToast: (...args) => toasts.push(args),
      eventTimestamp: item => item.occurredAt || item.createdAt
    },
    platform: {
      createRequestId: () => `request-${++requestSequence}`,
      now: () => "2026-10-06T09:00:00.000Z",
      confirm: () => true
    },
    state,
    libraryView,
    createTicket: () => ({ token: session.token }),
    isCurrent: ticket => ticket?.token === session.token && session.current,
    isSameSession: ticket => ticket?.token === session.token
  });
  return {
    operations,
    calls,
    toasts,
    restoredDrafts,
    retryForm: () => retryForm,
    renders: () => renders,
    resets: () => resets,
    projections: () => projections,
    session,
    fields,
    state
  };
}

{
  const snapshot = { books: [] };
  let fail = true;
  const harness = createOperationsHarness({
    snapshot,
    requestV1: async () => {
      if (fail) throw new Error("书目保存失败");
      return {
        data: {
          id: "book-created",
          title: "一本书",
          notes: [],
          version: 1
        }
      };
    }
  });
  const form = createBookForm();
  assert.equal(await harness.operations.submitBook(form), false);
  assert.equal(form.dataset.requestId, "request-1");
  assert.equal(harness.fields.get("#book-title").value, "一本书");
  assert.equal(harness.fields.get("#book-parse-status").textContent, "书目保存失败");
  fail = false;
  assert.equal(await harness.operations.submitBook(form), true);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].options.headers["idempotency-key"], "request-1");
  assert.equal(harness.calls[1].options.headers["idempotency-key"], "request-1");
  assert.deepEqual(snapshot.books.map(book => book.id), ["book-created"]);
}

{
  const gate = deferred();
  const snapshot = { books: [] };
  const harness = createOperationsHarness({
    snapshot,
    requestV1: () => gate.promise
  });
  const form = createBookForm();
  const first = harness.operations.submitBook(form);
  const second = harness.operations.submitBook(form);
  assert.equal(first, second, "duplicate book submissions must share one request");
  await waitFor(() => harness.calls.length === 1, "book create request must start once");
  gate.resolve({
    data: { id: "book-once", title: "一本书", notes: [], version: 1 }
  });
  assert.equal(await first, true);
  assert.equal(harness.calls.length, 1);
}

{
  const gate = deferred();
  const snapshot = { books: [] };
  const harness = createOperationsHarness({
    snapshot,
    requestV1: () => gate.promise
  });
  const pending = harness.operations.submitBook(createBookForm());
  await waitFor(() => harness.calls.length === 1, "stale book request must start");
  harness.session.current = false;
  gate.resolve({
    data: { id: "book-stale", title: "旧 activation", notes: [], version: 1 }
  });
  assert.equal(await pending, false);
  assert.deepEqual(snapshot.books, []);
  assert.deepEqual(harness.toasts, []);
}

{
  const snapshot = { books: [] };
  let harness;
  harness = createOperationsHarness({
    snapshot,
    requestV1: async (url, options, coordination) => {
      harness.session.token += 1;
      coordination.onQueued({
        operationId: "old-account-operation",
        projection: coordination.projection
      });
      throw Object.assign(new Error("offline"), { syncStatus: "pending" });
    }
  });
  assert.equal(await harness.operations.submitBook(createBookForm()), false);
  assert.equal(
    harness.projections(),
    0,
    "late queued projections must not cross the account/session boundary"
  );
  assert.deepEqual(snapshot.books, []);
}

{
  const snapshot = {
    books: [{
      id: "book-1",
      title: "旧标题",
      notes: [],
      version: 4
    }]
  };
  const harness = createOperationsHarness({
    snapshot,
    editingBookId: "book-1",
    requestV1: async (url, options) => {
      if (options.method === "PATCH") {
        return { data: { ...snapshot.books[0], title: "一本书", version: 5 } };
      }
      return { data: {} };
    }
  });
  await harness.operations.submitBook(createBookForm());
  assert.equal(harness.calls[0].url, "/api/v1/books/book-1");
  assert.equal(harness.calls[0].options.method, "PATCH");
  assert.equal(harness.calls[0].options.headers["if-match"], '"4"');
  const deleteButton = fakeNode({
    dataset: { bookDelete: "book-1" }
  });
  await harness.operations.deleteBook(deleteButton);
  assert.equal(harness.calls[1].options.method, "DELETE");
  assert.equal(harness.calls[1].options.headers["if-match"], '"5"');
  assert.equal(harness.calls[1].options.headers["idempotency-key"], "request-2");
}

{
  const snapshot = {
    books: [{ id: "book-1", title: "书", notes: [], version: 1 }]
  };
  let fail = true;
  const harness = createOperationsHarness({
    snapshot,
    requestV1: async () => {
      if (fail) throw new Error("笔记保存失败");
      return {
        data: {
          id: "note-created",
          content: "保留这段笔记",
          type: "record",
          favorite: "none",
          occurredAt: "2026-10-06T08:00:00",
          version: 1
        }
      };
    }
  });
  const form = createNoteForm();
  assert.equal(await harness.operations.submitNote(form), false);
  assert.equal(harness.restoredDrafts.length, 1);
  assert.equal(harness.restoredDrafts[0].draft.payload.content, "保留这段笔记");
  assert.equal(harness.retryForm().dataset.requestId, "request-1");
  fail = false;
  assert.equal(await harness.operations.submitNote(harness.retryForm()), true);
  assert.equal(harness.calls[0].options.headers["idempotency-key"], "request-1");
  assert.equal(harness.calls[1].options.headers["idempotency-key"], "request-1");
  assert.deepEqual(snapshot.books[0].notes.map(note => note.id), ["note-created"]);
}

{
  const note = {
    id: "note-1",
    content: "旧笔记",
    type: "record",
    favorite: "none",
    occurredAt: "2026-10-06T08:00:00",
    version: 3
  };
  const snapshot = {
    books: [{ id: "book-1", title: "书", notes: [note], version: 1 }]
  };
  const harness = createOperationsHarness({
    snapshot,
    editingBookId: "",
    requestV1: async (url, options) => {
      if (options.method === "PATCH") {
        return { data: { ...note, content: "修改后", version: 4 } };
      }
      return { data: {} };
    }
  });
  harness.state.activeBookId = "book-1";
  const editForm = createNoteForm({
    noteId: "note-1",
    content: "修改后"
  });
  await harness.operations.submitNote(editForm);
  assert.equal(
    harness.calls[0].url,
    "/api/v1/books/book-1/notes/note-1"
  );
  assert.equal(harness.calls[0].options.method, "PATCH");
  assert.equal(harness.calls[0].options.headers["if-match"], '"3"');
  const deleteButton = fakeNode({
    dataset: { bookNoteDelete: "note-1" }
  });
  await harness.operations.deleteNote(deleteButton);
  assert.equal(harness.calls[1].options.method, "DELETE");
  assert.equal(harness.calls[1].options.headers["if-match"], '"4"');
}

for (const file of [
  "controller.mjs",
  "media.mjs",
  "model.mjs",
  "operations.mjs",
  "presentation.mjs",
  "view.mjs"
]) {
  const source = await readFile(
    new URL(`../public/frontend/features/library/${file}`, import.meta.url),
    "utf8"
  );
  assert.ok(source.split(/\r?\n/).length <= 500, `${file} exceeds 500 lines`);
  assert.equal(
    source.includes("frontend/app/runtime.mjs"),
    false,
    `${file} must not import runtime internals`
  );
}

console.log(
  "Frontend library feature checks passed: disposable lifecycle, duplicate listener "
  + "protection, OCR account/input staleness, Blob URL cleanup, idempotent book/note "
  + "creates, CRUD contracts and failure draft retention."
);
