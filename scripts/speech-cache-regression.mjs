import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import { createTrashService } from "../src/modules/trash/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import {
  SPEECH_CACHE_RETENTION_DAYS,
  createAttachmentCleanup,
  createSpeechCache,
  createSpeechCacheSweep,
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
  assert.equal((await request()).cacheStatus, "miss", "expired audio must be regenerated");
  assert.equal(providerCalls.length, 2);
  assert.ok(removedAudio.some(item => item.accountId === "account-a"), "expired audio must enter attachment cleanup");

  await request({ voice: "voice-b" });
  await request({ generationRate: 25 });
  assert.equal(providerCalls.length, 4, "voice and generation parameters must partition cache entries");
  const entries = (await repository.read()).captures[0].speechCache;
  assert.equal(entries.length, 3);
  assert.ok(entries.every(entry => entry.sourceVersion === 2));
  assert.ok(entries.every(entry => entry.retentionDays === SPEECH_CACHE_RETENTION_DAYS));
  assert.ok(entries.every(entry => Date.parse(entry.expiresAt) - Date.parse(entry.createdAt) === 30 * 24 * 60 * 60 * 1000));
  assert.ok(entries.every(entry => entry.cacheKey && entry.ownerHash && entry.textHash));
});

await context.run("account-b", async () => {
  const result = await request();
  assert.equal(result.cacheStatus, "miss");
  assert.equal(providerCalls.length, 5, "accounts with identical source ids must remain isolated");
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
  assert.equal(providerCalls.length, 6, "a source version change must miss");
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

const sweepContext = new AsyncLocalStorage();
const sweepDocuments = new Map();
const sweepFiles = new Map();
const sweepFailures = new Map([["account-a:/attachments/retry.tts.mp3", 1]]);
const sweepResumeFailures = new Map([["account-d", 1]]);
const sweepWriteFailures = new Set(["account-c"]);
const sweepErrors = [];
const sweepScheduled = [];
const sweepClock = new Date("2026-10-02T02:00:00.000Z");
const sweepNow = () => sweepClock.toISOString();
const sweepFile = account => `/virtual/${account}/store.json`;
const sweepEntry = (cacheKey, attachmentPath, createdAt, expiresAt = "") => ({
  cacheKey,
  attachmentPath,
  createdAt,
  ...(expiresAt ? { expiresAt } : {})
});
const sweepStore = entries => ({
  captures: [{
    id: "capture-sweep",
    version: 9,
    content: "后台清理不得记录此正文",
    attachmentPaths: [],
    speechCache: entries
  }],
  trash: [],
  attachmentCleanup: []
});
const sweepSeed = {
  "account-a": {
    ...sweepStore([
      sweepEntry("expired-shared", "/attachments/shared.tts.mp3", "2026-09-02T02:00:00.000Z"),
      sweepEntry("unexpired-stale", "/attachments/shared.tts.mp3", "2025-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"),
      sweepEntry("expired-retry", "/attachments/retry.tts.mp3", "2026-08-01T00:00:00.000Z")
    ]),
    trash: [{
      id: "trash-capture",
      type: "capture",
      payload: {
        id: "capture-in-trash",
        speechCache: [
          sweepEntry("expired-trash", "/attachments/trash.tts.mp3", "2026-08-01T00:00:00.000Z")
        ]
      }
    }]
  },
  "account-b": sweepStore([
    sweepEntry("expired-b", "/attachments/retry.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-c": sweepStore([
    sweepEntry("expired-c", "/attachments/retry.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-d": sweepStore([
    sweepEntry("expired-resume", "/attachments/resume.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-e": sweepStore([
    sweepEntry("unexpired-e", "/attachments/unexpired.tts.mp3", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")
  ])
};
for (const [account, document] of Object.entries(sweepSeed)) {
  sweepDocuments.set(sweepFile(account), structuredClone(document));
  sweepFiles.set(account, new Set([
    ...document.captures.flatMap(item => item.speechCache.map(entry => entry.attachmentPath)),
    ...document.trash.flatMap(item => item.payload.speechCache.map(entry => entry.attachmentPath))
  ]));
}

const persistedSweepRepository = createJsonStoreRepository({
  getFile: () => sweepFile(sweepContext.getStore()),
  readDocument: async (file, fallback) => structuredClone(sweepDocuments.get(file) || fallback),
  writeDocument: async (file, document) => {
    const account = sweepContext.getStore();
    if (sweepWriteFailures.has(account)) {
      throw Object.assign(new Error("injected JSON write failure"), { code: "EIO" });
    }
    sweepDocuments.set(file, structuredClone(document));
  },
  normalize: value => ({
    captures: [],
    trash: [],
    attachmentCleanup: [],
    ...value
  }),
  emptyDocument: sweepStore([]),
  now: sweepNow
});
const sweepUpdateCalls = new Map();
const sweepRepository = {
  ...persistedSweepRepository,
  update(mutate) {
    const account = sweepContext.getStore();
    sweepUpdateCalls.set(account, (sweepUpdateCalls.get(account) || 0) + 1);
    return persistedSweepRepository.update(mutate);
  }
};
const durableSweepCleanup = createAttachmentCleanup({
  repository: sweepRepository,
  now: sweepNow,
  contextKey: () => sweepContext.getStore(),
  remove: async attachmentPath => {
    const account = sweepContext.getStore();
    const failureKey = `${account}:${attachmentPath}`;
    const remaining = sweepFailures.get(failureKey) || 0;
    if (remaining) {
      sweepFailures.set(failureKey, remaining - 1);
      throw Object.assign(new Error("injected attachment removal failure"), { code: "EIO" });
    }
    sweepFiles.get(account).delete(attachmentPath);
  },
  dispatch: callback => {
    const account = sweepContext.getStore();
    const scheduledRetry = () => sweepContext.run(account, callback);
    sweepScheduled.push(scheduledRetry);
    return scheduledRetry;
  },
  onRetryFailure: error => { throw error; },
  onResult: async () => {}
});
const sweepCleanup = {
  enqueue: durableSweepCleanup.enqueue,
  async resume() {
    const account = sweepContext.getStore();
    const remaining = sweepResumeFailures.get(account) || 0;
    if (remaining) {
      sweepResumeFailures.set(account, remaining - 1);
      throw Object.assign(new Error("injected cleanup resume startup failure"), { code: "ERESUME" });
    }
    return durableSweepCleanup.resume();
  }
};
const sweep = createSpeechCacheSweep({
  listAccountIds: async () => [
    "account-a", "account-b", "account-a", "account-c", "account-d", "account-e"
  ],
  runWithAccount: (account, operation) => sweepContext.run(account, operation),
  repository: sweepRepository,
  cleanup: sweepCleanup,
  now: sweepNow,
  onAccountError: (error, { accountId }) => sweepErrors.push({ accountId, code: error.code })
});

const firstSweep = await sweep.run();
assert.deepEqual(firstSweep, {
  accounts: 5,
  succeeded: 3,
  failed: 2,
  entriesRemoved: 4,
  attachmentCandidates: 4,
  attachmentsQueued: 3,
  attachmentsRemoved: 2,
  attachmentCleanupPending: 1
});
const sweptA = await sweepContext.run("account-a", () => sweepRepository.read());
const sweptB = await sweepContext.run("account-b", () => sweepRepository.read());
const unsweptC = await sweepContext.run("account-c", () => sweepRepository.read());
const queuedD = await sweepContext.run("account-d", () => sweepRepository.read());
assert.deepEqual(sweptA.captures[0].speechCache.map(entry => entry.cacheKey), ["unexpired-stale"]);
assert.deepEqual(sweptA.trash[0].payload.speechCache, []);
assert.equal(sweepFiles.get("account-a").has("/attachments/shared.tts.mp3"), true, "shared references must retain physical audio");
assert.equal(sweepFiles.get("account-a").has("/attachments/retry.tts.mp3"), true, "failed removal must remain retryable");
assert.equal(sweepFiles.get("account-a").has("/attachments/trash.tts.mp3"), false);
assert.deepEqual(sweptA.attachmentCleanup.map(item => item.path), ["/attachments/retry.tts.mp3"]);
assert.equal(sweepFiles.get("account-b").has("/attachments/retry.tts.mp3"), false, "same path in another account is isolated");
assert.equal(sweptB.captures[0].speechCache.length, 0);
assert.equal(unsweptC.captures[0].speechCache.length, 1, "failed account writes must remain unchanged");
assert.equal(queuedD.captures[0].speechCache.length, 0, "metadata commit must survive cleanup resume failure");
assert.deepEqual(queuedD.attachmentCleanup.map(item => item.path), ["/attachments/resume.tts.mp3"]);
assert.equal(sweepFiles.get("account-d").has("/attachments/resume.tts.mp3"), true);
assert.equal(sweepUpdateCalls.get("account-d"), 1);
assert.equal(sweepUpdateCalls.get("account-e") || 0, 0, "unexpired accounts must not rewrite the store");
assert.deepEqual(sweepErrors, [
  { accountId: "account-c", code: "EIO" },
  { accountId: "account-d", code: "ERESUME" }
]);
assert.equal(sweepScheduled.length, 1);

sweepScheduled.shift()();
await sweepRepository.waitForIdle(sweepFile("account-a"));
assert.equal(sweepFiles.get("account-a").has("/attachments/retry.tts.mp3"), false);
assert.equal((await sweepContext.run("account-a", () => sweepRepository.read())).attachmentCleanup.length, 0);

sweepWriteFailures.clear();
const retry = sweep.run();
assert.equal(sweep.run(), retry, "overlapping sweeps must coalesce");
const secondSweep = await retry;
assert.deepEqual(secondSweep, {
  accounts: 5,
  succeeded: 5,
  failed: 0,
  entriesRemoved: 1,
  attachmentCandidates: 1,
  attachmentsQueued: 1,
  attachmentsRemoved: 2,
  attachmentCleanupPending: 0
});
assert.equal(sweepFiles.get("account-c").has("/attachments/retry.tts.mp3"), false);
assert.equal(sweepFiles.get("account-d").has("/attachments/resume.tts.mp3"), false);
assert.equal((await sweepContext.run("account-d", () => sweepRepository.read())).attachmentCleanup.length, 0);
assert.equal(sweepUpdateCalls.get("account-d"), 1, "queue recovery must not require another expiry update");
assert.equal(sweepUpdateCalls.get("account-e") || 0, 0);

console.log("Speech cache checks passed: 30-day access and background expiry, JSON account isolation, shared references, retryable cleanup, private keys, coalesced hits and version invalidation.");
