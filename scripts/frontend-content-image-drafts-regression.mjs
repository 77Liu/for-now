import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  uploadPendingMediaItems,
  validatedImageFiles
} from "../public/frontend/media/index.mjs";
import {
  createContentImageDraftManager,
  isUncertainContentImageSubmission,
  rotateContentImageFile
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
  const createdFiles = [];
  const revoked = [];
  return {
    created,
    createdFiles,
    revoked,
    createObjectURL(file) {
      const value = `blob:test-${++sequence}-${file.name}`;
      created.push(value);
      createdFiles.push(file);
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
  rotateFile,
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
    ...(rotateFile ? { rotateFile } : {}),
    createFile,
    createId: () => `upload-${++id}`,
    now: () => Date.parse("2026-10-06T08:00:00.000Z")
  });
}

{
  const transforms = [];
  const bitmap = {
    width: 2,
    height: 3,
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    }
  };
  const canvas = {
    width: 3,
    height: 2,
    getContext() {
      return {
        translate(x, y) {
          transforms.push(["translate", x, y]);
        },
        rotate(radians) {
          transforms.push(["rotate", radians]);
        },
        drawImage(source, x, y) {
          transforms.push(["drawImage", source, x, y]);
        }
      };
    }
  };
  const normalized = await rotateContentImageFile(
    { ...image("exif-portrait.jpg"), type: "image/jpeg" },
    {
      async decodeImage(file, options) {
        assert.equal(file.name, "exif-portrait.jpg");
        assert.deepEqual(options, { imageOrientation: "from-image" });
        return bitmap;
      },
      createCanvas(width, height) {
        assert.deepEqual([width, height], [3, 2]);
        return canvas;
      },
      async encodeCanvas(value, options) {
        assert.equal(value, canvas);
        assert.deepEqual(options, { type: "image/jpeg" });
        return { type: "image/jpeg", size: 24, pixels: "exif-normalized-east" };
      },
      createFile(parts, name, options) {
        return { blob: parts[0], name, ...options, size: parts[0].size };
      }
    }
  );
  assert.deepEqual(transforms, [
    ["translate", 3, 0],
    ["rotate", Math.PI / 2],
    ["drawImage", bitmap, 0, 0]
  ]);
  assert.equal(normalized.blob.pixels, "exif-normalized-east");
  assert.equal(normalized.name, "exif-portrait.jpg");
  assert.equal(normalized.type, "image/jpeg");
  assert.equal(bitmap.closeCalls, 1);
}

{
  const rotationStore = createStore();
  const rotationUrls = createObjectUrls();
  const rotationCalls = [];
  const uploadedDirections = [];
  const rotationManager = createManager({
    store: rotationStore,
    objectUrls: rotationUrls,
    draftKeys: ["thoughtRoot"],
    async rotateFile(file) {
      rotationCalls.push([file.name, file.direction]);
      const directions = ["north", "east", "south", "west"];
      return {
        ...file,
        direction: directions[(directions.indexOf(file.direction) + 1) % directions.length],
        pixels: `${file.pixels}>clockwise`
      };
    },
    async uploadItem(file) {
      uploadedDirections.push([file.name, file.direction, file.pixels]);
      return `/attachments/${file.name}-${file.direction}.png`;
    }
  });
  await rotationManager.restore("rotation-owner");
  await rotationManager.select("thoughtRoot", [
    { ...image("first.png"), direction: "north", pixels: "first-original" },
    { ...image("second.png"), direction: "west", pixels: "second-original" }
  ]);
  const initialPreviews = rotationManager.snapshot("thoughtRoot").items.map(
    item => item.preview
  );

  const firstTurn = rotationManager.rotate("thoughtRoot", 0);
  const secondTurn = rotationManager.rotate("thoughtRoot", 0);
  await Promise.all([firstTurn, secondTurn]);
  await rotationManager.rotate("thoughtRoot", 1);
  assert.deepEqual(rotationCalls, [
    ["first.png", "north"],
    ["first.png", "east"],
    ["second.png", "west"]
  ]);
  assert.deepEqual(
    rotationManager.snapshot("thoughtRoot").items.map(item => item.file.direction),
    ["south", "north"],
    "each draft item must continue from its own current direction"
  );
  assert.deepEqual(
    rotationManager.snapshot("thoughtRoot").items.map(item => item.file.pixels),
    [
      "first-original>clockwise>clockwise",
      "second-original>clockwise"
    ]
  );
  assert.ok(initialPreviews.every(value => rotationUrls.revoked.includes(value)));
  assert.deepEqual(
    rotationUrls.createdFiles.slice(-2).map(file => file.direction),
    ["south", "north"],
    "preview URLs must use each item's final rotated file"
  );
  assert.deepEqual(
    rotationStore.record("rotation-owner", "thoughtRoot").items.map(
      item => item.blob.direction
    ),
    ["south", "north"],
    "the durable draft must contain the same final pixels as the preview"
  );

  const submission = await rotationManager.submit("thoughtRoot");
  assert.deepEqual(uploadedDirections, [
    ["first.png", "south", "first-original>clockwise>clockwise"],
    ["second.png", "north", "second-original>clockwise"]
  ]);
  assert.deepEqual(submission.attachmentPaths, [
    "/attachments/first.png-south.png",
    "/attachments/second.png-north.png"
  ]);

  await rotationManager.replaceExisting(
    "thoughtRoot",
    ["/attachments/historical.png"]
  );
  assert.equal(await rotationManager.rotate("thoughtRoot", 0), false);
  assert.equal(
    rotationCalls.length,
    3,
    "historical attachment paths must never enter draft pixel rotation"
  );
}

{
  const failureStore = createStore();
  const failureUrls = createObjectUrls();
  const failureGate = deferred();
  const failureManager = createManager({
    store: failureStore,
    objectUrls: failureUrls,
    draftKeys: ["thoughtRoot"],
    rotateFile: () => failureGate.promise
  });
  await failureManager.restore("failure-owner");
  await failureManager.select("thoughtRoot", [
    { ...image("cancelled.png"), direction: "north" }
  ]);
  const preview = failureManager.snapshot("thoughtRoot").items[0].preview;
  const pendingRotation = failureManager.rotate("thoughtRoot", 0);
  await Promise.resolve();
  assert.equal((await failureManager.remove("thoughtRoot", 0)).items.length, 0);
  failureGate.resolve({
    ...image("cancelled.png"),
    direction: "east"
  });
  assert.equal(await pendingRotation, false);
  assert.deepEqual(failureUrls.created, [preview]);
  assert.deepEqual(failureUrls.revoked, [preview]);
  assert.equal(failureStore.record("failure-owner", "thoughtRoot"), null);

  const expected = new Error("pixel decode failed");
  const rejectManager = createManager({
    store: createStore(),
    objectUrls: createObjectUrls(),
    draftKeys: ["thoughtRoot"],
    rotateFile: async () => {
      throw expected;
    }
  });
  await rejectManager.restore("failure-owner");
  await rejectManager.select("thoughtRoot", [
    { ...image("failed.png"), direction: "south" }
  ]);
  const before = rejectManager.snapshot("thoughtRoot").items[0];
  await assert.rejects(rejectManager.rotate("thoughtRoot", 0), expected);
  assert.deepEqual(rejectManager.snapshot("thoughtRoot").items[0], before);
}

{
  const accountRotationGate = deferred();
  const accountRotationStore = createStore([{
    owner: "rotation-b",
    id: "thoughtRoot",
    items: [storedImage("rotation-b.png", { direction: "west" })]
  }]);
  const accountRotationUrls = createObjectUrls();
  const accountRotationManager = createManager({
    store: accountRotationStore,
    objectUrls: accountRotationUrls,
    draftKeys: ["thoughtRoot"],
    rotateFile: () => accountRotationGate.promise
  });
  await accountRotationManager.restore("rotation-a");
  await accountRotationManager.select("thoughtRoot", [
    { ...image("rotation-a.png"), direction: "north" }
  ]);
  const accountARotation = accountRotationManager.rotate("thoughtRoot", 0);
  await Promise.resolve();
  assert.equal(await accountRotationManager.restore("rotation-b"), true);
  const putsBeforeLateRotation = accountRotationStore.calls.filter(
    call => call[0] === "put"
  ).length;
  accountRotationGate.resolve({
    ...image("rotation-a.png"),
    direction: "east"
  });
  assert.equal(await accountARotation, false);
  assert.equal(accountRotationManager.snapshot().owner, "rotation-b");
  assert.equal(
    accountRotationManager.snapshot("thoughtRoot").items[0].file.name,
    "rotation-b.png"
  );
  assert.equal(
    accountRotationStore.calls.filter(call => call[0] === "put").length,
    putsBeforeLateRotation,
    "a late rotation from account A must not persist into account B"
  );
  assert.equal(
    accountRotationUrls.created.length,
    2,
    "a stale transformed file must not allocate a preview URL"
  );
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

{
  const removeStore = createStore();
  const removeUrls = createObjectUrls();
  const removeManager = createManager({
    store: removeStore,
    objectUrls: removeUrls,
    draftKeys: ["thoughtBlock"]
  });
  await removeManager.restore("remove-owner");
  await removeManager.select("thoughtBlock", [image("remove.png")]);
  assert.equal((await removeManager.remove("thoughtBlock", 0)).items.length, 0);
  assert.equal(await removeManager.remove("thoughtBlock", 0), false);
  assert.deepEqual(removeUrls.revoked, removeUrls.created);
}

console.log(
  "Content image draft manager checks passed: account generations, isolated keys, partial retry order, rollback classification, compensation, item removal, durable reset and idempotent Blob URL cleanup."
);
