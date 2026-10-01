import assert from "node:assert/strict";
import { createKeepsakeMediaWorkflows } from "../src/app/index.mjs";

const now = () => "2026-09-29T12:00:00.000Z";
let sequence = 0;
const createId = () => `keepsake-${++sequence}`;
const readyPaths = prefix => ({
  originalPath: `/attachments/${prefix}.original.jpg`,
  thumbPath: `/attachments/${prefix}.thumb.webp`,
  displayPath: `/attachments/${prefix}.display.webp`,
  editPath: `/attachments/${prefix}.edit.webp`,
  alphaMaskPath: `/attachments/${prefix}.alphaMask.webp`
});
const parse = (input, existing = {}) => input.title
  ? {
      value: {
        ...existing,
        title: input.title,
        occurredAt: input.occurredAt || existing.occurredAt || now(),
        occurredOn: (input.occurredAt || existing.occurredAt || now()).slice(0, 10),
        ...Object.fromEntries(Object.entries(readyPaths("unused")).map(([key]) => [key, input[key] || existing[key] || ""]))
      }
    }
  : { error: "请填写小物名称" };

const store = { keepsakes: [] }, idempotency = new Map();
let failCommit = false;
const repository = {
  async read() {
    return structuredClone(store);
  },
  async update(mutator) {
    const draft = structuredClone(store);
    const result = await mutator(draft);
    if (failCommit) {
      failCommit = false;
      throw new Error("commit failed");
    }
    Object.assign(store, draft);
    return structuredClone(result);
  },
  async readIdempotent(request) {
    const entry = idempotency.get(`${request.scope}:${request.key}`);
    if (!entry) return undefined;
    if (entry.requestHash !== request.requestHash) throw Object.assign(new Error("reused"), { code: "IDEMPOTENCY_KEY_REUSED" });
    return structuredClone(entry.response);
  },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`, entry = idempotency.get(key);
    if (entry) {
      if (entry.requestHash !== request.requestHash) throw Object.assign(new Error("reused"), { code: "IDEMPOTENCY_KEY_REUSED" });
      return onReplay(structuredClone(entry.response));
    }
    const draft = structuredClone(store), result = await operation(draft);
    if (failCommit) {
      failCommit = false;
      throw new Error("commit failed");
    }
    Object.assign(store, draft);
    idempotency.set(key, { requestHash: request.requestHash, response: structuredClone(result) });
    return structuredClone(result);
  }
};
const saved = [], derived = [], cleaned = [], enqueued = [];
let resumes = 0;
const attachments = {
  async saveKeepsakeSet(input) {
    saved.push(structuredClone(input));
    return { paths: readyPaths(`create-${saved.length}`) };
  },
  async deriveKeepsakeSet(input) {
    derived.push(structuredClone(input));
    return {
      paths: { ...readyPaths(`edit-${derived.length}`), originalPath: input.originalPath },
      replacedPaths: input.alphaMaskPath ? [input.alphaMaskPath] : []
    };
  }
};
const cleanup = {
  async cleanFailedUploads(paths) {
    cleaned.push([...paths]);
  },
  enqueue(document, paths) {
    enqueued.push([...paths]);
    document.attachmentCleanup = [...(document.attachmentCleanup || []), ...[...paths].map(path => ({ path }))];
  },
  async resume() {
    resumes += 1;
  }
};
const workflows = createKeepsakeMediaWorkflows({ repository, attachments, cleanup, parse, createId, now });

const created = await workflows.create({
  title: "旧票根",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
});
assert.equal(created.value.id, "keepsake-1");
assert.equal(store.keepsakes[0].originalPath, "/attachments/create-1.original.jpg");
assert.equal(store.keepsakes[0].mediaVersion, 1);
assert.equal(saved.length, 1);
assert.equal(cleaned.length, 0);

const invalid = await workflows.create({
  title: "",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
});
assert.equal(invalid.error, "请填写小物名称");
assert.deepEqual(cleaned.at(-1), Object.values(readyPaths("create-2")));
assert.equal(store.keepsakes.length, 1);

failCommit = true;
await assert.rejects(workflows.create({
  title: "提交失败",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
}), /commit failed/);
assert.deepEqual(cleaned.at(-1), Object.values(readyPaths("create-3")));
assert.equal(store.keepsakes.length, 1);

const idempotentInput = {
  title: "幂等票根",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,idempotent-source",
  alphaMask: "data:image/png;base64,idempotent-mask"
};
const savedBeforeIdempotent = saved.length;
const firstIdempotent = await workflows.create(idempotentInput, { clientRequestId: "keepsake-media-create-1" });
const replayedIdempotent = await workflows.create(idempotentInput, { clientRequestId: "keepsake-media-create-1" });
assert.equal(replayedIdempotent.value.id, firstIdempotent.value.id);
assert.equal(replayedIdempotent.duplicate, true);
assert.equal(saved.length, savedBeforeIdempotent + 1);
assert.deepEqual(
  await workflows.create({ ...idempotentInput, title: "不同小物" }, { clientRequestId: "keepsake-media-create-1" }),
  { conflict: true }
);

const before = structuredClone(store.keepsakes[0]);
const updated = await workflows.update(before.id, {
  title: "修订票根",
  occurredAt: before.occurredAt,
  alphaMask: "data:image/png;base64,new-mask"
});
assert.equal(updated.value.title, "修订票根");
assert.equal(saved.length, savedBeforeIdempotent + 1);
assert.equal(derived.length, 1);
assert.deepEqual(derived[0], {
  originalPath: before.originalPath,
  alphaMask: "data:image/png;base64,new-mask"
});
assert.equal(updated.value.originalPath, before.originalPath);
assert.equal(updated.value.mediaVersion, 2);
assert.deepEqual(new Set(enqueued[0]), new Set([
  before.thumbPath,
  before.displayPath,
  before.editPath,
  before.alphaMaskPath
]));
assert.equal(resumes, 1);

const conflictPaths = { ...readyPaths("edit-2"), originalPath: before.originalPath };
const originalUpdate = repository.update;
repository.update = async mutator => {
  store.keepsakes[0].mediaVersion += 1;
  return originalUpdate(mutator);
};
const conflict = await workflows.update(before.id, {
  title: "竞态修改",
  occurredAt: before.occurredAt,
  alphaMask: "data:image/png;base64,conflict-mask"
});
assert.equal(conflict.conflict, true);
assert.deepEqual(cleaned.at(-1), Object.values(conflictPaths).filter(value => value !== conflictPaths.originalPath));

console.log("Keepsake media workflows passed: single-source creation, compensating cleanup, derivative replacement and version conflict handling.");
