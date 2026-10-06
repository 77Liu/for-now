import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  uploadPendingMediaItems,
  validatedImageFiles
} from "../public/frontend/media/index.mjs";
import {
  createContentImageDraftManager,
  isUncertainContentImageSubmission
} from "../public/frontend/media/content-image-drafts.mjs";

const moduleSource = await readFile(
  new URL("../public/frontend/media/content-image-drafts.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(moduleSource, /\b(?:document|window|router)\b|state\.thoughts/);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createStore(initial = [], getOverride = null) {
  const records = new Map();
  const calls = [];
  const recordKey = (owner, id) => JSON.stringify([owner, id]);
  for (const record of initial) {
    records.set(recordKey(record.owner, record.id), structuredClone(record));
  }
  return {
    calls,
    records,
    async get(owner, id) {
      calls.push(["get", owner, id]);
      const overridden = getOverride?.(owner, id);
      if (overridden) return overridden;
      return structuredClone(records.get(recordKey(owner, id)) || null);
    },
    async put(record) {
      calls.push(["put", record.owner, record.id]);
      records.set(recordKey(record.owner, record.id), structuredClone(record));
    },
    async delete(owner, id) {
      calls.push(["delete", owner, id]);
      records.delete(recordKey(owner, id));
    },
    record(owner, id) {
      return structuredClone(records.get(recordKey(owner, id)) || null);
    }
  };
}

const image = name => ({
  name,
  type: "image/png",
  size: 12,
  lastModified: 1
});
const storedImage = (name, extra = {}) => ({
  blob: image(name),
  name,
  type: "image/png",
  lastModified: 1,
  ...extra
});
const createFile = (parts, name, options) => ({
  blob: parts[0],
  name,
  type: options.type,
  lastModified: options.lastModified,
  size: parts[0]?.size || 0
});

function createObjectUrls() {
  let sequence = 0;
  const created = [];
  const revoked = [];
  return {
    created,
    revoked,
    createObjectURL(file) {
      const value = `blob:test-${++sequence}-${file.name}`;
      created.push(value);
      return value;
    },
    revokeObjectURL(value) {
      revoked.push(value);
    }
  };
}

function createManager({
  store,
  objectUrls,
  uploadItem = async file => `/attachments/${file.name}`,
  discardItem = async () => true,
  draftKeys = ["thoughtRoot", "thoughtBlock"]
}) {
  let id = 0;
  return createContentImageDraftManager({
    store,
    objectUrls,
    draftKeys,
    validateFiles: validatedImageFiles,
    uploadPendingItems: uploadPendingMediaItems,
    uploadItem,
    discardItem,
    createFile,
    createId: () => `upload-${++id}`,
    now: () => Date.parse("2026-10-06T08:00:00.000Z")
  });
}

const accountAGate = deferred();
const accountARecord = {
  owner: "account-a",
  id: "thoughtRoot",
  items: [storedImage("account-a-root.png")]
};
const isolatedStore = createStore([
  {
    owner: "account-b",
    id: "thoughtRoot",
    context: { rootId: "root-b" },
    items: [storedImage("account-b-root.png")]
  },
  {
    owner: "account-b",
    id: "thoughtBlock",
    context: { rootId: "root-b", blockId: "block-b" },
    items: [storedImage("account-b-block.png")]
  }
], (owner, id) => (
  owner === "account-a" && id === "thoughtRoot"
    ? accountAGate.promise
    : null
));
const isolatedUrls = createObjectUrls();
const isolated = createManager({
  store: isolatedStore,
  objectUrls: isolatedUrls
});

const lateAccountA = isolated.restore("account-a");
await Promise.resolve();
assert.equal(await isolated.restore("account-b"), true);
assert.equal(isolated.snapshot().owner, "account-b");
assert.equal(
  isolated.snapshot("thoughtRoot").items[0].file.name,
  "account-b-root.png"
);
assert.equal(
  isolated.snapshot("thoughtBlock").items[0].file.name,
  "account-b-block.png"
);
accountAGate.resolve(accountARecord);
assert.equal(await lateAccountA, false);
assert.equal(isolated.snapshot().owner, "account-b");
assert.equal(
  isolated.snapshot("thoughtRoot").items[0].file.name,
  "account-b-root.png"
);
assert.equal(
  isolatedStore.calls.filter(call => call[0] === "put").length,
  0,
  "a late account A restore must not write account B"
);

await isolated.persist("thoughtRoot", { rootId: "root-b-updated" });
assert.deepEqual(
  isolatedStore.record("account-b", "thoughtRoot").context,
  { rootId: "root-b-updated" }
);
assert.deepEqual(
  isolatedStore.record("account-b", "thoughtBlock").context,
  { rootId: "root-b", blockId: "block-b" }
);
assert.equal(isolated.resetSession(), true);
assert.equal(isolated.resetSession(), false);
assert.equal(isolated.snapshot().owner, "");
assert.deepEqual(
  isolatedUrls.revoked.sort(),
  isolatedUrls.created.sort(),
  "account switch cleanup must revoke each restored Blob URL"
);
assert.equal(
  isolatedUrls.revoked.length,
  new Set(isolatedUrls.revoked).size,
  "restored Blob URLs must be revoked exactly once"
);

const store = createStore();
const objectUrls = createObjectUrls();
const uploadCalls = [];
const attempts = new Map();
const discardCalls = [];
const manager = createManager({
  store,
  objectUrls,
  async uploadItem(file, requestId, index) {
    uploadCalls.push([file.name, requestId, index]);
    const attempt = (attempts.get(file.name) || 0) + 1;
    attempts.set(file.name, attempt);
    if (file.name === "two.png" && attempt === 1) {
      throw Object.assign(new Error("second upload failed"), { status: 503 });
    }
    return `/attachments/${file.name}`;
  },
  async discardItem(item, fallbackRequestId) {
    discardCalls.push([
      item.uploadedPath,
      item.uploadRequestId || fallbackRequestId
    ]);
    return true;
  }
});

assert.equal(await manager.restore("account-main"), true);
await manager.select("thoughtRoot", [image("one.png"), image("two.png")]);
await manager.select("thoughtBlock", [image("block.png")]);
await manager.persist("thoughtBlock", {
  rootId: "thought-root-1",
  blockId: "thought-block-1"
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.file.name),
  ["one.png", "two.png"]
);
assert.deepEqual(
  manager.snapshot("thoughtBlock").items.map(item => item.file.name),
  ["block.png"]
);
assert.deepEqual(
  store.record("account-main", "thoughtBlock").context,
  { rootId: "thought-root-1", blockId: "thought-block-1" }
);
assert.deepEqual(
  store.calls.filter(call => call[0] === "put").map(call => call[2]).slice(0, 3),
  ["thoughtRoot", "thoughtBlock", "thoughtBlock"],
  "thoughtRoot and thoughtBlock must remain separate store keys"
);

await assert.rejects(
  manager.submit("thoughtRoot"),
  error => error instanceof AggregateError
    && error.failedIndexes.length === 1
    && error.failedIndexes[0] === 1
);
assert.deepEqual(
  uploadCalls.map(call => call[0]),
  ["one.png", "two.png"]
);
assert.equal(
  manager.snapshot("thoughtRoot").items[0].uploadedPath,
  "/attachments/one.png"
);
assert.equal(
  manager.snapshot("thoughtRoot").items[1].lastError.message,
  "second upload failed"
);

const rootSubmission = await manager.submit("thoughtRoot");
assert.deepEqual(
  uploadCalls.map(call => call[0]),
  ["one.png", "two.png", "two.png"],
  "retry must upload only the failed item"
);
assert.deepEqual(rootSubmission, {
  attachmentPaths: [
    "/attachments/one.png",
    "/attachments/two.png"
  ],
  uploadedPaths: [
    "/attachments/one.png",
    "/attachments/two.png"
  ]
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.file.name),
  ["one.png", "two.png"],
  "partial retry must preserve item order"
);

const rollback = await manager.rollback(
  "thoughtRoot",
  Object.assign(new Error("validation failed"), { status: 400 }),
  { uploadedPaths: rootSubmission.uploadedPaths }
);
assert.deepEqual(rollback, {
  retained: false,
  compensated: [
    "/attachments/one.png",
    "/attachments/two.png"
  ],
  failed: []
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.uploadedPath),
  ["", ""]
);
const discardCountAfterRollback = discardCalls.length;
await manager.rollback(
  "thoughtRoot",
  Object.assign(new Error("validation failed"), { status: 400 }),
  { uploadedPaths: rootSubmission.uploadedPaths }
);
assert.equal(
  discardCalls.length,
  discardCountAfterRollback,
  "repeated rollback must not compensate the same leases twice"
);

const blockSubmission = await manager.submit("thoughtBlock");
assert.deepEqual(blockSubmission.attachmentPaths, ["/attachments/block.png"]);
const uncertainErrors = [
  new Error("network failed"),
  Object.assign(new Error("timeout"), { status: 408 }),
  Object.assign(new Error("too early"), { status: 425 }),
  Object.assign(new Error("limited"), { status: 429 }),
  Object.assign(new Error("server failed"), { status: 503 })
];
for (const error of uncertainErrors) {
  assert.equal(isUncertainContentImageSubmission(error), true);
  assert.equal((await manager.rollback("thoughtBlock", error)).retained, true);
}
assert.equal(
  manager.snapshot("thoughtBlock").items[0].uploadedPath,
  "/attachments/block.png"
);
assert.equal(discardCalls.length, discardCountAfterRollback);
assert.equal(
  isUncertainContentImageSubmission(
    Object.assign(new Error("bad request"), { status: 400 })
  ),
  false
);

const blockDeletesBefore = store.calls.filter(
  call => call[0] === "delete" && call[2] === "thoughtBlock"
).length;
assert.equal(await manager.complete("thoughtBlock"), true);
assert.equal(await manager.complete("thoughtBlock"), false);
assert.equal(
  store.calls.filter(
    call => call[0] === "delete" && call[2] === "thoughtBlock"
  ).length,
  blockDeletesBefore + 1,
  "repeated complete must delete the stored draft once"
);

await manager.replaceExisting("thoughtRoot", [
  "/attachments/existing.png",
  "/attachments/existing.png"
]);
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.path),
  ["/attachments/existing.png"]
);
await manager.select("thoughtRoot", [image("replacement.png")]);
const replacementSubmission = await manager.submit("thoughtRoot");
assert.deepEqual(replacementSubmission.attachmentPaths, [
  "/attachments/existing.png",
  "/attachments/replacement.png"
]);
const discardBeforeReplace = discardCalls.length;
await manager.replaceExisting(
  "thoughtRoot",
  ["/attachments/committed.png"]
);
assert.deepEqual(
  discardCalls.slice(discardBeforeReplace),
  [["/attachments/replacement.png", uploadCalls.at(-1)[1]]],
  "replaceExisting must compensate a replaced pending upload"
);
await manager.replaceExisting(
  "thoughtRoot",
  ["/attachments/committed.png"]
);
assert.equal(discardCalls.length, discardBeforeReplace + 1);
assert.equal(await manager.abandon("thoughtRoot"), true);
assert.equal(await manager.abandon("thoughtRoot"), false);

await manager.persist("thoughtBlock", { rootId: "abandon-root" });
await manager.select("thoughtBlock", [image("abandon.png")]);
await manager.submit("thoughtBlock");
const discardBeforeAbandon = discardCalls.length;
assert.equal(await manager.abandon("thoughtBlock"), true);
assert.equal(await manager.abandon("thoughtBlock"), false);
assert.equal(discardCalls.length, discardBeforeAbandon + 1);
assert.equal(discardCalls.at(-1)[0], "/attachments/abandon.png");

await manager.select("thoughtRoot", [image("session.png")]);
const storedBeforeReset = store.record("account-main", "thoughtRoot");
assert.equal(manager.resetSession(), true);
assert.equal(manager.resetSession(), false);
assert.deepEqual(
  store.record("account-main", "thoughtRoot"),
  storedBeforeReset,
  "session reset must preserve the durable draft"
);
assert.equal(objectUrls.revoked.length, objectUrls.created.length);
assert.equal(
  objectUrls.revoked.length,
  new Set(objectUrls.revoked).size,
  "every Blob URL must be revoked exactly once"
);

console.log(
  "Content image draft manager checks passed: account generations, isolated keys, partial retry order, rollback classification, compensation, durable reset and idempotent Blob URL cleanup."
);
