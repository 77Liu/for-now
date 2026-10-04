import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import { createTrashService } from "../src/modules/trash/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import { installPromptCatalog } from "../src/shared/prompts/index.mjs";
import {
  SPEECH_CACHE_RETENTION_DAYS,
  createAttachmentCleanup,
  createSpeechCache,
  createSpeechCacheSweep,
  createTrashCommands,
  createTrashMutations,
  normalizeSpeechCacheStore,
  publicSpeechAssets
} from "../src/app/index.mjs";

installPromptCatalog({
  version: "speech-cache-test",
  sha256: "speech-cache-test",
  prompts: {
    "thought.speech.wrapper": "问题：{{question}}\n回答：{{answer}}"
  }
});

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
let activeThoughtChainAsset = null;
let accountBThoughtChainAsset = null;

const now = () => clock.toISOString();
const accountId = () => context.getStore();
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
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
  thoughts: [{
    id: "question-1",
    type: "question",
    content: "为什么要记录？",
    authorType: "user",
    version: 4,
    createdAt: "2026-10-02T00:00:00.000Z",
    occurredAt: "2026-10-02T00:00:00.000Z"
  }, {
    id: "answer-1",
    type: "answer",
    relatedTo: "question-1",
    content: "**为了**看见变化。",
    modelDraft: "不得进入整链朗读的模型草稿",
    reasoningContent: "不得进入整链朗读的模型思考",
    authorType: "ai",
    version: 1,
    createdAt: "2026-10-02T03:00:00.000Z",
    occurredAt: "2026-10-02T03:00:00.000Z"
  }, {
    id: "conclusion-1",
    type: "answer",
    relatedTo: "question-1",
    content: "持续记录，而不是追求一次想清楚。",
    authorType: "user",
    version: 2,
    createdAt: "2026-10-02T02:00:00.000Z",
    occurredAt: "2026-10-02T02:00:00.000Z"
  }, {
    id: "answer-draft-only",
    type: "answer",
    relatedTo: "question-1",
    content: "",
    modelDraft: "只有草稿的回答不得进入整链朗读",
    reasoningContent: "草稿私有思考",
    authorType: "ai",
    version: 7,
    createdAt: "2026-10-02T04:00:00.000Z",
    occurredAt: "2026-10-02T04:00:00.000Z"
  }],
  speechCache: [],
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
  hash: digest
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
const request = (overrides = {}, generate = synthesize) => cache.synthesize({
  sourceType: "capture",
  sourceId: "capture-1",
  sourceVersion: 2,
  voice: "voice-a",
  generationRate: -10,
  ...overrides
}, generate);
const thoughtChainRequest = (overrides = {}, generate = synthesize) => cache.synthesizeThoughtChain({
  thoughtChainId: "question-1",
  sourceVersion: 4,
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
  const entries = (await repository.read()).speechCache;
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
  document.captures[0].version = 3;
  stores.set("account-a", document);

  const versionOnly = await request({ sourceVersion: 3 });
  assert.equal(versionOnly.cacheStatus, "hit", "a version-only change must reuse identical speech text");
  assert.equal(providerCalls.length, 5);
  assert.ok((await repository.read()).speechCache.every(entry => entry.sourceVersion === 3));

  const changed = structuredClone(stores.get("account-a"));
  changed.captures[0].content = "升版后的朗读文字";
  changed.captures[0].version = 4;
  stores.set("account-a", changed);

  await assert.rejects(request({ sourceVersion: 3 }), error => error.code === "SPEECH_SOURCE_STALE" && error.statusCode === 409);
  const regenerated = await request({ sourceVersion: 4 });
  assert.equal(regenerated.cacheStatus, "miss");
  assert.equal(providerCalls.length, 6, "a speech text change must miss");
  assert.ok(removedAudio.some(item => item.accountId === "account-a"), "stale text attachments must enter cleanup");

  const beforeRegenerate = (await repository.read()).speechCache.find(entry => entry.id === regenerated.assetId);
  const forced = await request({ sourceVersion: 4, regenerate: true });
  assert.equal(forced.cacheStatus, "miss");
  assert.equal(providerCalls.length, 7);
  const afterRegenerate = (await repository.read()).speechCache.filter(entry => (
    entry.sourceType === "capture"
    && entry.sourceId === "capture-1"
    && entry.textHash === beforeRegenerate.textHash
    && entry.voice === beforeRegenerate.voice
    && entry.generationRate === beforeRegenerate.generationRate
  ));
  assert.equal(afterRegenerate.length, 1, "regeneration must replace the active cache variant");
  assert.notEqual(afterRegenerate[0].attachmentPath, beforeRegenerate.attachmentPath);
  assert.equal(accountFiles().has(beforeRegenerate.attachmentPath), false);

  const audio = await cache.readAudio({ id: forced.assetId });
  assert.deepEqual(audio.audio, forced.audio);
  const assets = publicSpeechAssets(await repository.read(), {
    ownerHash: digest("account-a"),
    currentTime: now(),
    hash: digest
  });
  assert.ok(assets.some(asset => asset.id === forced.assetId));
  assert.deepEqual(
    Object.keys(assets[0]).sort(),
    ["bytes", "createdAt", "expiresAt", "generationRate", "id", "mimeType", "sourceId", "sourceType", "sourceVersion", "voice"]
  );
  const projectedStore = await repository.read();
  const projectedEntry = projectedStore.speechCache.find(entry => entry.id === forced.assetId);
  const storedSourceVersion = projectedEntry.sourceVersion;
  projectedStore.captures[0].version = storedSourceVersion + 1;
  projectedStore.speechCache.push({
    ...projectedEntry,
    id: "foreign-owner-asset",
    cacheKey: "foreign-owner-asset",
    ownerHash: digest("account-b")
  });
  const projectedAssets = publicSpeechAssets(projectedStore, {
    ownerHash: digest("account-a"),
    currentTime: now(),
    hash: digest
  });
  assert.equal(projectedAssets.find(asset => asset.id === forced.assetId).sourceVersion, storedSourceVersion + 1);
  assert.equal(projectedEntry.sourceVersion, storedSourceVersion, "public projection must not mutate persisted metadata");
  assert.equal(projectedAssets.some(asset => asset.id === "foreign-owner-asset"), false);
  projectedStore.captures[0].content = "公开状态中的当前朗读文本已变化";
  assert.equal(publicSpeechAssets(projectedStore, {
    ownerHash: digest("account-a"),
    currentTime: now(),
    hash: digest
  }).some(asset => asset.sourceType === "capture"), false);

  const thought = await cache.synthesize({
    sourceType: "thoughtAnswer",
    sourceId: "answer-1",
    sourceVersion: 1,
    voice: "voice-a",
    generationRate: -10
  }, synthesize);
  assert.equal(thought.cacheStatus, "miss");
  assert.equal(providerCalls.at(-1).text, "问题：为什么要记录？ 回答：为了看见变化。");
  const thoughtDocument = structuredClone(stores.get("account-a"));
  thoughtDocument.thoughts.find(item => item.id === "answer-1").version = 2;
  stores.set("account-a", thoughtDocument);
  assert.equal((await cache.synthesize({
    sourceType: "thoughtAnswer",
    sourceId: "answer-1",
    sourceVersion: 2,
    voice: "voice-a",
    generationRate: -10
  }, synthesize)).cacheStatus, "hit");
  assert.equal(providerCalls.length, 8);
  const thoughtProjectionStore = await repository.read();
  thoughtProjectionStore.thoughts.find(item => item.id === "answer-1").version = 3;
  const projectedThought = publicSpeechAssets(thoughtProjectionStore, {
    ownerHash: digest("account-a"),
    currentTime: now(),
    hash: digest
  }).find(asset => asset.id === thought.assetId);
  assert.equal(projectedThought.sourceVersion, 3);
  thoughtProjectionStore.thoughts.find(item => item.id === "question-1").content = "关联问题已经变化";
  assert.equal(publicSpeechAssets(thoughtProjectionStore, {
    ownerHash: digest("account-a"),
    currentTime: now(),
    hash: digest
  }).some(asset => asset.id === thought.assetId), false);

  const changedQuestion = structuredClone(stores.get("account-a"));
  changedQuestion.thoughts.find(item => item.id === "question-1").content = "现在为什么要记录？";
  stores.set("account-a", changedQuestion);
  assert.equal((await cache.synthesize({
    sourceType: "thoughtAnswer",
    sourceId: "answer-1",
    sourceVersion: 2,
    voice: "voice-a",
    generationRate: -10
  }, synthesize)).cacheStatus, "miss");
  assert.equal(providerCalls.length, 9, "question text participates in the final thought speech hash");
});

await context.run("account-a", async () => {
  installPromptCatalog({
    version: "2026.10.04.1",
    sha256: "catalog-without-thought-speech",
    prompts: {}
  });
  try {
    const assets = publicSpeechAssets(await repository.read(), {
      ownerHash: digest("account-a"),
      currentTime: now(),
      hash: digest
    });
    assert.ok(assets.some(asset => asset.sourceType === "capture"));
    assert.equal(
      assets.some(asset => asset.sourceType === "thoughtAnswer"),
      false,
      "unsupported thought speech assets must be omitted from public state"
    );
    await assert.rejects(cache.synthesize({
      sourceType: "thoughtAnswer",
      sourceId: "answer-1",
      sourceVersion: 2,
      voice: "voice-a",
      generationRate: -10
    }, synthesize), error => (
      error.code === "SPEECH_PROMPT_UNAVAILABLE"
      && error.statusCode === 503
    ));
    assert.equal(
      (await request({ sourceVersion: 4 })).cacheStatus,
      "hit",
      "capture speech remains available without the thought wrapper prompt"
    );
    assert.equal(providerCalls.length, 9);
  } finally {
    installPromptCatalog({
      version: "speech-cache-test",
      sha256: "speech-cache-test",
      prompts: {
        "thought.speech.wrapper": "问题：{{question}}\n回答：{{answer}}"
      }
    });
  }
});

await context.run("account-a", async () => {
  const callsBeforeChain = providerCalls.length;
  const first = await thoughtChainRequest();
  assert.equal(first.cacheStatus, "miss");
  assert.equal(
    providerCalls.at(-1).text,
    "我的问题：现在为什么要记录？ 我的结论：持续记录，而不是追求一次想清楚。 专属回答：为了看见变化。"
  );
  assert.doesNotMatch(providerCalls.at(-1).text, /模型草稿|模型思考|草稿私有思考/);
  assert.equal(providerCalls.length, callsBeforeChain + 1);
  const firstEntry = (await repository.read()).speechCache.find(entry => entry.id === first.assetId);
  assert.deepEqual(firstEntry.sourceVersions, {
    question: { id: "question-1", version: 4 },
    conclusion: { id: "conclusion-1", version: 2 },
    answer: { id: "answer-1", version: 2 }
  });
  assert.deepEqual(
    publicSpeechAssets(await repository.read(), {
      ownerHash: digest("account-a"),
      currentTime: now(),
      hash: digest
    }).find(asset => asset.id === first.assetId),
    {
      id: first.assetId,
      sourceType: "thoughtChain",
      sourceId: "question-1",
      sourceVersion: 4,
      voice: "voice-a",
      generationRate: -10,
      mimeType: "audio/mpeg",
      bytes: first.audio.length,
      createdAt: firstEntry.createdAt,
      expiresAt: firstEntry.expiresAt
    },
    "current thought-chain audio must be exposed through public speech assets"
  );

  const repeated = await thoughtChainRequest();
  assert.equal(repeated.cacheStatus, "hit");
  assert.equal(repeated.attachmentPath, first.attachmentPath);
  assert.equal(providerCalls.length, callsBeforeChain + 1, "repeated chain synthesis must not add provider or metered usage calls");

  const privateOnlyChange = structuredClone(stores.get("account-a"));
  Object.assign(privateOnlyChange.thoughts.find(item => item.id === "answer-1"), {
    modelDraft: "已变化但不得朗读的模型草稿",
    reasoningContent: "已变化但不得朗读的模型思考",
    version: 3
  });
  stores.set("account-a", privateOnlyChange);
  assert.equal((await thoughtChainRequest()).cacheStatus, "hit");
  assert.equal(providerCalls.length, callsBeforeChain + 1);
  assert.equal(
    (await repository.read()).speechCache.find(entry => entry.id === first.assetId).sourceVersions.answer.version,
    3,
    "a text-identical hit must refresh the bound content versions"
  );

  const contentChange = structuredClone(stores.get("account-a"));
  Object.assign(contentChange.thoughts.find(item => item.id === "conclusion-1"), {
    content: "持续记录，也要定期形成自己的结论。",
    version: 3
  });
  contentChange.thoughts.find(item => item.id === "question-1").version = 5;
  stores.set("account-a", contentChange);
  await assert.rejects(
    thoughtChainRequest({ sourceVersion: 4 }),
    error => error.code === "SPEECH_SOURCE_STALE" && error.statusCode === 409
  );
  await assert.rejects(
    cache.readAudio({ id: first.assetId }),
    error => error.code === "SPEECH_ASSET_INVALID" && error.statusCode === 410
  );
  const changed = await thoughtChainRequest({ sourceVersion: 5 });
  assert.equal(changed.cacheStatus, "miss");
  assert.equal(providerCalls.length, callsBeforeChain + 2, "included content changes must invalidate chain audio");
  assert.equal(accountFiles().has(first.attachmentPath), false);

  const beforeRegenerate = (await repository.read()).speechCache.find(entry => entry.id === changed.assetId);
  const regenerated = await thoughtChainRequest({ sourceVersion: 5, regenerate: true });
  assert.equal(regenerated.cacheStatus, "miss");
  assert.equal(providerCalls.length, callsBeforeChain + 3);
  assert.notEqual(regenerated.attachmentPath, beforeRegenerate.attachmentPath);
  assert.equal(accountFiles().has(beforeRegenerate.attachmentPath), false);
  activeThoughtChainAsset = regenerated;
});

await context.run("account-b", async () => {
  const callsBeforeAccount = providerCalls.length;
  const isolated = await thoughtChainRequest();
  accountBThoughtChainAsset = isolated;
  assert.equal(isolated.cacheStatus, "miss");
  assert.match(isolated.attachmentPath, /account-b/);
  assert.equal(providerCalls.length, callsBeforeAccount + 1, "thought-chain audio must remain account isolated");
  assert.equal((await thoughtChainRequest()).cacheStatus, "hit");
  assert.equal(providerCalls.length, callsBeforeAccount + 1);
});

await context.run("account-a", async () => {
  await assert.rejects(
    cache.readAudio({ id: accountBThoughtChainAsset.assetId }),
    error => error.code === "SPEECH_ASSET_NOT_FOUND" && error.statusCode === 404,
    "an asset id from another account must not be readable"
  );
  const collisionStore = structuredClone(stores.get("account-a"));
  const ownedEntry = collisionStore.speechCache.find(entry => entry.id === activeThoughtChainAsset.assetId);
  collisionStore.speechCache.unshift({
    ...ownedEntry,
    ownerHash: digest("account-b"),
    attachmentPath: accountBThoughtChainAsset.attachmentPath
  });
  stores.set("account-a", collisionStore);
  assert.equal(
    (await cache.readAudio({ id: activeThoughtChainAsset.assetId })).attachmentPath,
    activeThoughtChainAsset.attachmentPath,
    "asset lookup must scope duplicate ids to the current account"
  );
  const withoutForeignCollision = structuredClone(stores.get("account-a"));
  withoutForeignCollision.speechCache = withoutForeignCollision.speechCache.filter(entry => (
    entry.id !== activeThoughtChainAsset.assetId || entry.ownerHash === digest("account-a")
  ));
  stores.set("account-a", withoutForeignCollision);

  const document = structuredClone(stores.get("account-a"));
  const asset = document.speechCache.find(entry => entry.sourceType === "capture");
  document.captures[0].content = "再次变化";
  document.captures[0].version = 5;
  stores.set("account-a", document);
  await assert.rejects(
    cache.readAudio({ id: asset.id }),
    error => error.code === "SPEECH_ASSET_INVALID" && error.statusCode === 410
  );
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
  await request({ sourceVersion: 5 });
  const beforeDelete = await repository.read();
  const cachedPath = beforeDelete.speechCache.find(entry => entry.sourceType === "capture").attachmentPath;
  const entry = await repository.update(store => (
    mutations.moveCollectionItemToTrash(store, "captures", "capture", "capture-1")
  ));
  assert.equal(accountFiles().has(cachedPath), true, "recoverable deletion must retain cached audio");
  assert.ok((await repository.read()).speechCache.length);
  assert.equal(Object.hasOwn((await repository.read()).trash[0].payload, "speechCache"), false);
  await assert.rejects(
    request({ sourceVersion: 5 }),
    error => error.code === "SPEECH_SOURCE_MISSING" && error.statusCode === 404
  );

  await commands.restore(entry.id);
  const restored = (await repository.read()).captures[0];
  assert.equal(restored.version, 6);
  const afterRestore = await request({ sourceVersion: 6 });
  assert.equal(afterRestore.cacheStatus, "hit", "restore version changes must reuse unchanged speech text");
  assert.equal(accountFiles().has(cachedPath), true);

  const deletedAgain = await repository.update(store => (
    mutations.moveCollectionItemToTrash(store, "captures", "capture", "capture-1")
  ));
  const paths = [...new Set((await repository.read()).speechCache
    .filter(item => item.sourceType === "capture" && item.sourceId === "capture-1")
    .map(item => item.attachmentPath))];
  const preview = await commands.preview([deletedAgain.id]);
  assert.deepEqual(new Set(preview.attachmentPaths), new Set(paths));
  const purged = await commands.purge([deletedAgain.id], preview.planHash);
  assert.deepEqual(new Set(purged.attachments), new Set(paths));
  assert.ok(paths.every(attachmentPath => !accountFiles().has(attachmentPath)));
  assert.equal((await repository.read()).speechCache.some(item => item.sourceId === "capture-1"), false);

  const deletedConclusion = await repository.update(store => (
    mutations.moveThoughtBlockToTrash(store, "conclusion-1")
  ));
  await assert.rejects(
    cache.readAudio({ id: activeThoughtChainAsset.assetId }),
    error => error.code === "SPEECH_ASSET_INVALID" && error.statusCode === 410
  );
  const conclusionPreview = await commands.preview([deletedConclusion.id]);
  assert.ok(
    conclusionPreview.attachmentPaths.includes(activeThoughtChainAsset.attachmentPath),
    "permanently deleting a bound thought block must include its stale chain audio"
  );
  await commands.restore(deletedConclusion.id);
  const restoredRoot = (await repository.read()).thoughts.find(item => item.id === "question-1");
  const restoredChain = await thoughtChainRequest({ sourceVersion: restoredRoot.version });
  assert.equal(restoredChain.cacheStatus, "hit", "recoverable block restoration must reuse text-identical chain audio");
  assert.equal(restoredChain.attachmentPath, activeThoughtChainAsset.attachmentPath);

  const thoughtTrash = await repository.update(store => (
    mutations.moveThoughtChainToTrash(store, "question-1")
  ));
  const thoughtPaths = (await repository.read()).speechCache
    .filter(item => (
      (item.sourceType === "thoughtAnswer" && item.sourceId === "answer-1")
      || (item.sourceType === "thoughtChain" && item.sourceId === "question-1")
    ))
    .map(item => item.attachmentPath);
  const thoughtPreview = await commands.preview([thoughtTrash.id]);
  assert.deepEqual(new Set(thoughtPreview.attachmentPaths), new Set(thoughtPaths));
  const thoughtPurge = await commands.purge([thoughtTrash.id], thoughtPreview.planHash);
  assert.deepEqual(new Set(thoughtPurge.attachments), new Set(thoughtPaths));
  assert.equal((await repository.read()).speechCache.some(item => (
    item.sourceId === "answer-1" || item.sourceId === "question-1"
  )), false);
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

const legacyStore = {
  captures: [{
    id: "legacy-capture",
    version: 7,
    speechCache: [{
      cacheKey: "legacy-cache",
      ownerHash: "legacy-owner",
      sourceVersion: 7,
      textHash: "legacy-text",
      voice: "voice-a",
      generation: { rate: 25 },
      attachmentPath: "/attachments/legacy.tts.mp3",
      mimeType: "audio/mpeg",
      bytes: 32,
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z"
    }]
  }],
  trash: []
};
normalizeSpeechCacheStore(legacyStore);
assert.equal(Object.hasOwn(legacyStore.captures[0], "speechCache"), false);
assert.deepEqual(legacyStore.speechCache.map(entry => ({
  id: entry.id,
  sourceType: entry.sourceType,
  sourceId: entry.sourceId,
  sourceVersion: entry.sourceVersion,
  generationRate: entry.generationRate
})), [{
  id: "legacy-cache",
  sourceType: "capture",
  sourceId: "legacy-capture",
  sourceVersion: 7,
  generationRate: 25
}]);

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
const sweepStore = (entries, speechCache = []) => ({
  captures: [{
    id: "capture-sweep",
    version: 9,
    content: "后台清理不得记录此正文",
    attachmentPaths: [],
    speechCache: entries
  }],
  speechCache,
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
  "account-b": sweepStore([], [
    sweepEntry("expired-b", "/attachments/retry.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-c": sweepStore([], [
    sweepEntry("expired-c", "/attachments/retry.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-d": sweepStore([
    sweepEntry("expired-resume", "/attachments/resume.tts.mp3", "2026-08-01T00:00:00.000Z")
  ]),
  "account-e": sweepStore([], [
    sweepEntry("unexpired-e", "/attachments/unexpired.tts.mp3", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")
  ])
};
for (const [account, document] of Object.entries(sweepSeed)) {
  sweepDocuments.set(sweepFile(account), structuredClone(document));
  sweepFiles.set(account, new Set([
    ...document.speechCache.map(entry => entry.attachmentPath),
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
assert.equal(sweptB.speechCache.length, 0);
assert.equal(unsweptC.speechCache.length, 1, "failed account writes must remain unchanged");
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

console.log("Speech cache checks passed: generic sources, stable text hashes, regeneration, safe assets, legacy migration, purge and 30-day account-isolated sweep.");
