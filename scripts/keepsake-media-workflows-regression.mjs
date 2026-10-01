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
const sourcePaths = prefix => ({
  originalPath: `/attachments/${prefix}.original.jpg`,
  alphaMaskPath: `/attachments/${prefix}.source-mask.png`
});
const parse = (input, existing = {}) => input.title
  ? {
      value: {
        ...existing,
        title: input.title,
        occurredAt: input.occurredAt || existing.occurredAt || now(),
        occurredOn: (input.occurredAt || existing.occurredAt || now()).slice(0, 10),
        derivativeState: input.derivativeState || existing.derivativeState || "ready",
        derivativeErrorCode: input.derivativeErrorCode || existing.derivativeErrorCode || "",
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
const saved = [], derived = [], cleaned = [], enqueued = [], scheduled = [], errors = [];
let failNextDerivation = false;
let resumes = 0;
const attachments = {
  async saveKeepsakeSources(input) {
    saved.push(structuredClone(input));
    const paths = sourcePaths(`create-${saved.length}`);
    return { paths, attachmentPaths: Object.values(paths) };
  },
  async read(resourcePath) {
    if (!resourcePath.startsWith("/attachments/")) throw new Error("missing");
    return Buffer.from("fixture");
  },
  async deriveKeepsakeSet(input) {
    if (failNextDerivation) {
      failNextDerivation = false;
      throw Object.assign(new Error("injected derivative failure"), { code: "DERIVATIVE_FAILED" });
    }
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
const workflows = createKeepsakeMediaWorkflows({
  repository, attachments, cleanup, parse, createId, now,
  dispatch: callback => scheduled.push(callback),
  contextKey: () => "test",
  onError: (id, error) => errors.push({ id, error })
});

const created = await workflows.create({
  title: "旧票根",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
});
assert.equal(created.value.id, "keepsake-1");
assert.equal(store.keepsakes[0].originalPath, "/attachments/create-1.original.jpg");
assert.equal(store.keepsakes[0].mediaVersion, 1);
assert.equal(store.keepsakes[0].derivativeState, "pending");
assert.equal(store.keepsakes[0].thumbPath, "");
assert.equal(saved.length, 1);
assert.equal(derived.length, 0);
assert.equal(scheduled.length, 1);
assert.equal(cleaned.length, 0);
await scheduled.shift()();
assert.equal(store.keepsakes[0].derivativeState, "ready");
assert.equal(store.keepsakes[0].thumbPath, "/attachments/edit-1.thumb.webp");
assert.equal(store.keepsakes[0].mediaVersion, 2);
assert.equal(derived.length, 1);
assert.deepEqual(enqueued.shift(), ["/attachments/create-1.source-mask.png"]);
assert.equal(resumes, 1);

const invalid = await workflows.create({
  title: "",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
});
assert.equal(invalid.error, "请填写小物名称");
assert.deepEqual(cleaned.at(-1), Object.values(sourcePaths("create-2")));
assert.equal(store.keepsakes.length, 1);

failCommit = true;
await assert.rejects(workflows.create({
  title: "提交失败",
  occurredAt: "2026-09-29T10:20:30.000Z",
  image: "data:image/jpeg;base64,source",
  alphaMask: "data:image/png;base64,mask"
}), /commit failed/);
assert.deepEqual(cleaned.at(-1), Object.values(sourcePaths("create-3")));
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
failNextDerivation = true;
await scheduled.shift()();
assert.equal(store.keepsakes.find(item => item.id === firstIdempotent.value.id).derivativeState, "failed");
assert.equal(errors.at(-1).id, firstIdempotent.value.id);
assert.equal(cleaned.flat().includes(firstIdempotent.value.originalPath), false);
const derivedBeforeRetry = derived.length;
await Promise.all([workflows.retry(firstIdempotent.value.id), workflows.retry(firstIdempotent.value.id)]);
assert.equal(scheduled.length, 2);
await Promise.all([scheduled.shift()(), scheduled.shift()()]);
assert.equal(store.keepsakes.find(item => item.id === firstIdempotent.value.id).derivativeState, "ready");
assert.equal(derived.length, derivedBeforeRetry + 1, "duplicate retries must share one running derivation");
await repository.update(document => {
  document.keepsakes.find(item => item.id === firstIdempotent.value.id).derivativeState = "failed";
});
assert.deepEqual(await workflows.resume(), [firstIdempotent.value.id]);
await scheduled.shift()();
assert.equal(store.keepsakes.find(item => item.id === firstIdempotent.value.id).derivativeState, "ready");
await repository.update(document => {
  document.keepsakes.push({ id: "legacy", derivativeState: "legacy", originalPath: "/attachments/legacy.png" });
});
assert.deepEqual(await workflows.retry("legacy"), { invalid: true });

const before = structuredClone(store.keepsakes.find(item => item.id === created.value.id));
const derivedBeforeUpdate = derived.length, resumesBeforeUpdate = resumes;
const updated = await workflows.update(before.id, {
  title: "修订票根",
  occurredAt: before.occurredAt,
  alphaMask: "data:image/png;base64,new-mask"
});
assert.equal(updated.value.title, "修订票根");
assert.equal(saved.length, savedBeforeIdempotent + 1);
assert.equal(derived.length, derivedBeforeUpdate + 1);
assert.deepEqual(derived.at(-1), {
  originalPath: before.originalPath,
  alphaMask: "data:image/png;base64,new-mask"
});
assert.equal(updated.value.originalPath, before.originalPath);
assert.equal(updated.value.mediaVersion, before.mediaVersion + 1);
assert.deepEqual(new Set(enqueued.at(-1)), new Set([
  before.thumbPath,
  before.displayPath,
  before.editPath,
  before.alphaMaskPath
]));
assert.equal(resumes, resumesBeforeUpdate + 1);

const conflictPrefix = `edit-${derived.length + 1}`;
const conflictPaths = { ...readyPaths(conflictPrefix), originalPath: before.originalPath };
const originalUpdate = repository.update;
repository.update = async mutator => {
  store.keepsakes.find(item => item.id === before.id).mediaVersion += 1;
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
