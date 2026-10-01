import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import { createTrashService } from "../src/modules/trash/index.mjs";
import {
  createAttachmentCleanup,
  createSpeechCache,
  createTrashCommands,
  createTrashMutations
} from "../src/app/index.mjs";

const context = new AsyncLocalStorage();
const stores = new Map();
const files = new Map();
const providerCalls = [];
const savedAudio = [];
const removedAudio = [];
const scheduled = [];
let clock = new Date("2026-10-02T01:00:00.000Z");
let attachmentSequence = 0;
let trashSequence = 0;

const now = () => clock.toISOString();
const accountId = () => context.getStore();
const accountFiles = () => {
  if (!files.has(accountId())) files.set(accountId(), new Map());
  return files.get(accountId());
};
const capture = (content = "同一段朗读文字") => ({
  id: "capture-1",
  version: 2,
  content,
  tags: [],
  attachmentPaths: [],
  annotations: [],
  annotationDrift: []
});
const emptyStore = (content = "同一段朗读文字") => ({
  captures: [capture(content)],
  trash: [],
  attachmentCleanup: [],
  aiTasks: [],
  notifications: []
});

for (const id of ["account-a", "account-b", "account-c"]) stores.set(id, emptyStore());

const repository = {
  async read() {
    return structuredClone(stores.get(accountId()));
  },
  async update(mutate) {
    const document = structuredClone(stores.get(accountId()));
    const result = await mutate(document);
    stores.set(accountId(), document);
    await result?.[Symbol.for("for-now.after-commit")]?.();
    return result;
  },
  async transact(operation) {
    const document = structuredClone(stores.get(accountId()));
    const commit = async () => stores.set(accountId(), structuredClone(document));
    return operation({ document, commit });
  }
};

const attachments = {
  async saveSpeechAudio({ data, mimeType }) {
    assert.equal(mimeType, "audio/mpeg");
    const attachmentPath = `/attachments/tts-${accountId()}-${++attachmentSequence}.mp3`;
    accountFiles().set(attachmentPath, Buffer.from(data));
    savedAudio.push({ accountId: accountId(), attachmentPath });
    return {
      attachmentPath,
      attachmentPaths: [attachmentPath],
      mimeType,
      bytes: data.length
    };
  },
  async read(attachmentPath) {
    const data = accountFiles().get(attachmentPath);
    if (!data) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(data);
  }
};

const cleanup = createAttachmentCleanup({
  repository,
  remove: async attachmentPath => {
    removedAudio.push({ accountId: accountId(), attachmentPath });
    accountFiles().delete(attachmentPath);
  },
  now,
  contextKey: accountId,
  dispatch: callback => {
    const owner = accountId();
    scheduled.push(() => context.run(owner, callback));
  },
  onRetryFailure: error => {
    throw error;
  },
  onResult: async () => {}
});

const cache = createSpeechCache({
  repository,
  attachments,
  cleanup,
  getOwnerId: accountId,
  now,
  hash: value => crypto.createHash("sha256").update(value).digest("hex")
});

const synthesize = async request => {
  providerCalls.push({ accountId: accountId(), ...request });
  await new Promise(resolve => setTimeout(resolve, 10));
  return {
    audio: Buffer.from(`ID3:${accountId()}:${request.voice}:${request.generationRate}:${request.text}`),
    mimeType: "audio/mpeg",
    voice: request.voice
  };
};
const request = (overrides = {}, generate = synthesize) => cache.synthesizeCapture({
  captureId: "capture-1",
  sourceVersion: 2,
  voice: "voice-a",
  generationRate: -10,
  ...overrides
}, generate);

await context.run("account-a", async () => {
  const [first, coalesced] = await Promise.all([
    request({ playbackRate: 0.5 }),
    request({ playbackRate: 2 })
  ]);
  assert.deepEqual(first.audio, coalesced.audio);
  assert.equal(providerCalls.length, 1, "concurrent identical synthesis must invoke the provider once");
  assert.equal(savedAudio.length, 1, "concurrent identical synthesis must persist one attachment");
  assert.equal(first.cacheStatus, "miss");

  const hit = await request({ playbackRate: 1.5 });
  assert.equal(hit.cacheStatus, "hit");
  assert.deepEqual(hit.audio, first.audio);
  assert.equal(providerCalls.length, 1, "a cache hit must not add provider or metered usage calls");

  clock = new Date("2027-11-06T01:00:00.000Z");
  assert.equal((await request()).cacheStatus, "hit", "retention must not silently hard-code a 30-day TTL");
  assert.equal(providerCalls.length, 1);

  await request({ voice: "voice-b" });
  await request({ generationRate: 25 });
  assert.equal(providerCalls.length, 3, "voice and generation parameters must partition cache entries");
  const entries = (await repository.read()).captures[0].speechCache;
  assert.equal(entries.length, 3);
  assert.ok(entries.every(entry => entry.sourceVersion === 2));
  assert.ok(entries.every(entry => !Object.hasOwn(entry, "retentionDays") && !Object.hasOwn(entry, "expiresAt")));
  assert.ok(entries.every(entry => entry.cacheKey && entry.ownerHash && entry.textHash));
});

await context.run("account-b", async () => {
  const result = await request();
  assert.equal(result.cacheStatus, "miss");
  assert.equal(providerCalls.length, 4, "accounts with identical source ids must remain isolated");
  assert.match(result.attachmentPath, /account-b/);
});

await context.run("account-a", async () => {
  const document = structuredClone(stores.get("account-a"));
  document.captures[0].content = "升版后的朗读文字";
  document.captures[0].version = 3;
  stores.set("account-a", document);

  await assert.rejects(request(), error => error.code === "SPEECH_SOURCE_STALE" && error.statusCode === 409);
  const regenerated = await request({ sourceVersion: 3 });
  assert.equal(regenerated.cacheStatus, "miss");
  assert.equal(providerCalls.length, 5, "a source version change must miss");
  assert.ok(removedAudio.some(item => item.accountId === "account-a"), "stale source attachments must enter cleanup");
});

const trash = createTrashService({
  createId: () => `trash-${++trashSequence}`,
  now,
  hash: value => crypto.createHash("sha256").update(value).digest("hex"),
  retentionDays: 30
});
const annotations = createAnnotationService({
  createId: () => `annotation-${trashSequence}`,
  now
});
const mutations = createTrashMutations({ trash, annotations, now });
const commands = createTrashCommands({ repository, trash, mutations, cleanup });

await context.run("account-a", async () => {
  const beforeDelete = await repository.read();
  const cachedPath = beforeDelete.captures[0].speechCache[0].attachmentPath;
  const entry = await repository.update(store => (
    mutations.moveCollectionItemToTrash(store, "captures", "capture", "capture-1")
  ));
  assert.equal(accountFiles().has(cachedPath), true, "recoverable deletion must retain cached audio");
  assert.ok((await repository.read()).trash[0].payload.speechCache.length);
  await assert.rejects(
    request({ sourceVersion: 3 }),
    error => error.code === "SPEECH_SOURCE_MISSING" && error.statusCode === 404
  );

  await commands.restore(entry.id);
  const restored = (await repository.read()).captures[0];
  assert.equal(restored.version, 4);
  assert.ok(restored.speechCache.length, "restore must recover cache metadata before version validation");
  const afterRestore = await request({ sourceVersion: 4 });
  assert.equal(afterRestore.cacheStatus, "miss", "restore advances source version and must not reuse stale audio");
  assert.equal(accountFiles().has(cachedPath), false, "stale restored audio must be cleaned after replacement");

  const deletedAgain = await repository.update(store => (
    mutations.moveCollectionItemToTrash(store, "captures", "capture", "capture-1")
  ));
  const paths = [...new Set(deletedAgain.payload.speechCache.map(item => item.attachmentPath))];
  const preview = await commands.preview([deletedAgain.id]);
  const purged = await commands.purge([deletedAgain.id], preview.planHash);
  assert.deepEqual(new Set(purged.attachments), new Set(paths));
  assert.ok(paths.every(attachmentPath => !accountFiles().has(attachmentPath)));
});

await context.run("account-c", async () => {
  await assert.rejects(request({}, async input => {
    const document = structuredClone(stores.get("account-c"));
    Object.assign(document.captures[0], {
      content: "",
      attachmentPaths: ["/attachments/image-only.png"],
      version: 3
    });
    stores.set("account-c", document);
    return {
      audio: Buffer.from(`ID3:stale:${input.text}`),
      mimeType: "audio/mpeg",
      voice: input.voice
    };
  }), error => error.code === "SPEECH_SOURCE_STALE" && error.statusCode === 409);
  assert.equal(accountFiles().size, 0, "late stale synthesis must clean its unlinked attachment");
});

console.log("Speech cache checks passed: private keys, coalesced hits, parameter isolation, version invalidation and recoverable cleanup.");
