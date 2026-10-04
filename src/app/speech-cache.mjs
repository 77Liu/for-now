import { recordVersion, safeText } from "../shared/validation/index.mjs";
import {
  normalizeTtsGenerationRate,
  readableSpeechText,
  speechTextForCapture
} from "../shared/speech/index.mjs";
import { optionalPromptText, renderPrompt } from "../shared/prompts/index.mjs";
import { thoughtChainSpeechSource } from "../modules/thoughts/index.mjs";

const ATTACHMENT_PATH = /^\/attachments\/[\w.-]+$/;
const SOURCE_TYPES = new Set(["capture", "thoughtAnswer", "thoughtChain"]);
export const SPEECH_CACHE_RETENTION_DAYS = 30;
const SPEECH_CACHE_RETENTION_MS = SPEECH_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const CACHE_PROFILE = Object.freeze({
  provider: "volcengine",
  format: "mp3",
  sampleRate: 24000
});

const failure = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });
const missingAttachment = error => (
  ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404
);
const list = value => Array.isArray(value) ? value : [];
const cachePath = entry => (
  ATTACHMENT_PATH.test(entry?.attachmentPath || "") ? entry.attachmentPath : ""
);
const entryId = entry => safeText(entry?.id || entry?.cacheKey, 160);
const generationRateOf = entry => normalizeTtsGenerationRate(
  entry?.generationRate ?? entry?.generation?.rate
);
const sourceKey = (sourceType, sourceId) => `${sourceType}\u0000${sourceId}`;
const sourceVersionsOf = value => Object.fromEntries(
  ["question", "conclusion", "answer"].flatMap(role => {
    const item = value?.[role];
    const id = safeText(item?.id, 160);
    return id ? [[role, { id, version: recordVersion(item.version) }]] : [];
  })
);
const sameSourceVersions = (left, right) => (
  JSON.stringify(sourceVersionsOf(left)) === JSON.stringify(sourceVersionsOf(right))
);

function normalizedEntry(entry, defaults = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const sourceType = SOURCE_TYPES.has(entry.sourceType) ? entry.sourceType : defaults.sourceType;
  const sourceId = safeText(entry.sourceId || defaults.sourceId, 160);
  const id = entryId(entry);
  if (!id || !sourceType || !sourceId) return null;
  const normalized = {
    ...entry,
    id,
    cacheKey: safeText(entry.cacheKey || id, 160),
    sourceType,
    sourceId,
    sourceVersion: recordVersion(entry.sourceVersion || defaults.sourceVersion),
    generationRate: generationRateOf(entry),
    attachmentPath: cachePath(entry),
    mimeType: safeText(entry.mimeType, 100) || "audio/mpeg",
    bytes: Math.max(0, Math.round(Number(entry.bytes) || 0)),
    createdAt: safeText(entry.createdAt, 100),
    expiresAt: safeText(entry.expiresAt, 100),
    retentionDays: SPEECH_CACHE_RETENTION_DAYS
  };
  const sourceVersions = sourceVersionsOf(entry.sourceVersions);
  if (Object.keys(sourceVersions).length) normalized.sourceVersions = sourceVersions;
  else delete normalized.sourceVersions;
  return normalized;
}

function legacyCaptureEntries(store) {
  return [
    ...list(store?.captures).map(capture => ({ capture, entries: list(capture?.speechCache) })),
    ...list(store?.trash)
      .filter(item => item?.type === "capture" && item.payload)
      .map(item => ({ capture: item.payload, entries: list(item.payload?.speechCache) }))
  ];
}

export function normalizeSpeechCacheStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return store;
  const entries = list(store.speechCache)
    .map(entry => normalizedEntry(entry))
    .filter(Boolean);
  for (const { capture, entries: legacyEntries } of legacyCaptureEntries(store)) {
    for (const entry of legacyEntries) {
      const normalized = normalizedEntry(entry, {
        sourceType: "capture",
        sourceId: capture.id,
        sourceVersion: capture.version
      });
      if (normalized) entries.push(normalized);
    }
    delete capture.speechCache;
  }
  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.id}\u0000${entry.attachmentPath}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  store.speechCache = [...unique.values()];
  return store;
}

export const speechCacheAttachmentPath = cachePath;
export function speechCacheEntryExpired(entry, currentTime) {
  const explicit = Date.parse(entry?.expiresAt);
  const derived = Date.parse(entry?.createdAt) + SPEECH_CACHE_RETENTION_MS;
  const cutoff = Number.isFinite(explicit) ? explicit : derived;
  return !Number.isFinite(cutoff) || cutoff <= Date.parse(currentTime);
}

function resolveSpeechSource(store, sourceType, sourceId) {
  if (sourceType === "capture") {
    const capture = list(store.captures).find(item => item?.id === sourceId);
    if (!capture) return null;
    return {
      source: capture,
      text: speechTextForCapture(capture),
      sourceVersion: recordVersion(capture.version)
    };
  }
  if (sourceType === "thoughtChain") {
    const resolved = thoughtChainSpeechSource(list(store.thoughts), sourceId);
    if (!resolved) return null;
    const text = readableSpeechText(resolved.sections.flatMap(section => {
      const content = readableSpeechText(section.content);
      return content ? [`${section.label}：${content}`] : [];
    }).join("\n"));
    if (!text) return null;
    return { ...resolved, text };
  }
  const answer = list(store.thoughts).find(item => (
    item?.id === sourceId && item.type === "answer"
  ));
  if (!answer) return null;
  const question = list(store.thoughts).find(item => (
    item?.id === answer.relatedTo && item.type === "question"
  ));
  if (!question) return null;
  if (!optionalPromptText("thought.speech.wrapper")) {
    return {
      source: answer,
      sourceVersion: recordVersion(answer.version),
      promptUnavailable: true
    };
  }
  const text = readableSpeechText(renderPrompt("thought.speech.wrapper", {
    question: safeText(question.content, 120_000),
    answer: safeText(answer.content || answer.modelDraft, 120_000)
  }));
  if (!text) return null;
  return { source: answer, text, sourceVersion: recordVersion(answer.version) };
}

export function publicSpeechAssets(store, {
  ownerHash = "",
  currentTime = new Date().toISOString(),
  hash
} = {}) {
  if (typeof hash !== "function") throw new TypeError("Public speech assets require a hash function");
  const snapshot = normalizeSpeechCacheStore(structuredClone(store || {}));
  return list(snapshot.speechCache)
    .flatMap(entry => {
      if (!cachePath(entry)
        || (ownerHash && entry.ownerHash !== ownerHash)
        || speechCacheEntryExpired(entry, currentTime)) return [];
      const current = resolveSpeechSource(
        snapshot,
        entry.sourceType,
        entry.sourceId
      );
      if (!current?.text || entry.textHash !== hash(current.text)) return [];
      return [{
        id: entryId(entry),
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceVersion: current.sourceVersion,
        voice: safeText(entry.voice, 160),
        generationRate: generationRateOf(entry),
        mimeType: safeText(entry.mimeType, 100) || "audio/mpeg",
        bytes: Math.max(0, Math.round(Number(entry.bytes) || 0)),
        createdAt: safeText(entry.createdAt, 100),
        expiresAt: safeText(entry.expiresAt, 100)
      }];
    });
}

export function createSpeechCache({
  repository,
  attachments,
  cleanup,
  getOwnerId,
  hash,
  now = () => new Date().toISOString()
}) {
  if (!repository?.read || !repository?.update
    || !attachments?.saveSpeechAudio || !attachments?.read
    || !cleanup?.enqueue || !cleanup?.resume || !cleanup?.cleanFailedUploads
    || typeof getOwnerId !== "function" || typeof hash !== "function") {
    throw new TypeError("Speech cache requires repository, attachments, cleanup, owner context and hash");
  }

  const inFlight = new Map();
  const expiresAt = createdAt => new Date(Date.parse(createdAt) + SPEECH_CACHE_RETENTION_MS).toISOString();
  const expiredEntry = entry => speechCacheEntryExpired(entry, now());

  const ownerIdentity = () => {
    const ownerId = safeText(getOwnerId(), 160);
    if (!ownerId) throw failure("朗读缺少账户上下文", "SPEECH_OWNER_REQUIRED", 500);
    return { ownerId, ownerHash: hash(ownerId) };
  };

  const sourceIdentity = (store, sourceType, sourceId, ownerHash, voice, generationRate) => {
    const resolved = resolveSpeechSource(store, sourceType, sourceId);
    if (!resolved) throw failure("朗读来源不存在", "SPEECH_SOURCE_MISSING", 404);
    if (resolved.promptUnavailable) {
      throw failure("当前提示词版本不支持思绪朗读", "SPEECH_PROMPT_UNAVAILABLE", 503);
    }
    if (!resolved.text) throw failure("朗读文本不能为空", "INVALID_TTS_TEXT", 400);
    const textHash = hash(resolved.text);
    const normalizedRate = normalizeTtsGenerationRate(generationRate);
    const generation = { ...CACHE_PROFILE, rate: normalizedRate };
    const cacheKey = hash(JSON.stringify({
      schemaVersion: 2,
      ownerHash,
      source: { type: sourceType, id: sourceId, textHash },
      voice,
      generation
    }));
    return {
      ...resolved,
      sourceType,
      sourceId,
      textHash,
      generation,
      generationRate: normalizedRate,
      cacheKey
    };
  };

  const matchingEntry = (entry, identity, ownerHash, voice) => (
    entry?.ownerHash === ownerHash
    && entry?.sourceType === identity.sourceType
    && entry?.sourceId === identity.sourceId
    && entry?.textHash === identity.textHash
    && entry?.voice === voice
    && generationRateOf(entry) === identity.generationRate
    && Boolean(cachePath(entry))
  );

  const obsoleteEntry = (entry, identity, ownerHash, predicate) => (
    entry?.ownerHash !== ownerHash
    || !cachePath(entry)
    || (
      sourceKey(entry?.sourceType, entry?.sourceId) === sourceKey(identity.sourceType, identity.sourceId)
      && entry?.textHash !== identity.textHash
    )
    || Boolean(predicate?.(entry))
  );

  async function prune(identity, ownerHash, predicate = null, snapshot = null) {
    if (snapshot && !list(snapshot.speechCache).some(
      entry => obsoleteEntry(entry, identity, ownerHash, candidate => expiredEntry(candidate) || predicate?.(candidate))
    )) return [];
    const result = await repository.update(store => {
      normalizeSpeechCacheStore(store);
      const removed = [], retained = [];
      for (const entry of list(store.speechCache)) {
        if (obsoleteEntry(entry, identity, ownerHash, candidate => expiredEntry(candidate) || predicate?.(candidate))) removed.push(entry);
        else retained.push(entry);
      }
      store.speechCache = retained;
      const paths = new Set(removed.map(cachePath).filter(Boolean));
      cleanup.enqueue(store, paths);
      return { removed, paths: [...paths] };
    });
    if (result.paths?.length) await cleanup.resume();
    return result.removed || [];
  }

  async function readSource(sourceType, sourceId, requestedVersion, ownerHash, voice, generationRate) {
    const store = await repository.read();
    normalizeSpeechCacheStore(store);
    const identity = sourceIdentity(store, sourceType, sourceId, ownerHash, voice, generationRate);
    if (Number(requestedVersion) !== identity.sourceVersion) {
      throw failure("朗读来源已经变化，请重试", "SPEECH_SOURCE_STALE", 409);
    }
    return { store, identity };
  }

  async function readCached(entry, voice, missingCode = "") {
    try {
      return {
        audio: await attachments.read(entry.attachmentPath),
        mimeType: entry.mimeType,
        voice,
        assetId: entryId(entry),
        attachmentPath: entry.attachmentPath,
        cacheStatus: "hit"
      };
    } catch (error) {
      if (!missingAttachment(error)) throw error;
      if (missingCode) throw failure("朗读音频不存在", missingCode, 404);
      return null;
    }
  }

  async function generateAndPersist({
    ownerHash,
    voice,
    identity,
    regenerate,
    generate
  }) {
    const generated = await generate({
      text: identity.text,
      voice,
      generationRate: identity.generation.rate
    });
    const saved = await attachments.saveSpeechAudio({
      data: generated.audio,
      mimeType: generated.mimeType
    });
    const createdAt = now();
    const entry = {
      id: identity.cacheKey,
      cacheKey: identity.cacheKey,
      ownerHash,
      sourceType: identity.sourceType,
      sourceId: identity.sourceId,
      sourceVersion: identity.sourceVersion,
      textHash: identity.textHash,
      ...(identity.sourceVersions ? {
        sourceVersions: sourceVersionsOf(identity.sourceVersions)
      } : {}),
      voice,
      generation: identity.generation,
      generationRate: identity.generationRate,
      attachmentPath: saved.attachmentPath,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
      createdAt,
      expiresAt: expiresAt(createdAt),
      retentionDays: SPEECH_CACHE_RETENTION_DAYS
    };

    let outcome;
    try {
      outcome = await repository.update(store => {
        normalizeSpeechCacheStore(store);
        const live = resolveSpeechSource(store, identity.sourceType, identity.sourceId);
        if (!live) return { missing: true };
        if (hash(live.text) !== identity.textHash) return { stale: true };
        const matches = list(store.speechCache).filter(item => (
          matchingEntry(item, identity, ownerHash, voice)
        ));
        if (matches.length && !regenerate) {
          matches[0].sourceVersion = live.sourceVersion;
          if (live.sourceVersions) {
            matches[0].sourceVersions = sourceVersionsOf(live.sourceVersions);
          }
          return { existing: matches[0] };
        }
        const replaced = regenerate ? matches : [];
        const replacedSet = new Set(replaced);
        store.speechCache = [
          ...list(store.speechCache).filter(item => !replacedSet.has(item)),
          {
            ...entry,
            sourceVersion: live.sourceVersion,
            ...(live.sourceVersions ? {
              sourceVersions: sourceVersionsOf(live.sourceVersions)
            } : {})
          }
        ];
        const paths = new Set(replaced.map(cachePath).filter(Boolean));
        cleanup.enqueue(store, paths);
        return { entry, paths: [...paths] };
      });
    } catch (error) {
      await cleanup.cleanFailedUploads([saved.attachmentPath]).catch(() => {});
      throw error;
    }

    if (outcome.missing || outcome.stale) {
      await cleanup.cleanFailedUploads([saved.attachmentPath]);
    }
    if (outcome.missing) throw failure("朗读来源不存在", "SPEECH_SOURCE_MISSING", 404);
    if (outcome.stale) throw failure("朗读来源已经变化，请重试", "SPEECH_SOURCE_STALE", 409);
    if (outcome.existing) {
      const cached = await readCached(outcome.existing, voice);
      if (cached) {
        await cleanup.cleanFailedUploads([saved.attachmentPath]);
        return cached;
      }
      outcome = await repository.update(store => {
        normalizeSpeechCacheStore(store);
        const live = resolveSpeechSource(store, identity.sourceType, identity.sourceId);
        if (!live || hash(live.text) !== identity.textHash) return { stale: true };
        const removed = list(store.speechCache).filter(item => (
          entryId(item) === entryId(outcome.existing)
          && item.attachmentPath === outcome.existing.attachmentPath
        ));
        const removedSet = new Set(removed);
        store.speechCache = [
          ...list(store.speechCache).filter(item => !removedSet.has(item)),
          {
            ...entry,
            sourceVersion: live.sourceVersion,
            ...(live.sourceVersions ? {
              sourceVersions: sourceVersionsOf(live.sourceVersions)
            } : {})
          }
        ];
        const paths = new Set(removed.map(cachePath).filter(Boolean));
        cleanup.enqueue(store, paths);
        return { entry, paths: [...paths] };
      });
      if (outcome.stale) {
        await cleanup.cleanFailedUploads([saved.attachmentPath]);
        throw failure("朗读来源已经变化，请重试", "SPEECH_SOURCE_STALE", 409);
      }
    }
    if (outcome.paths?.length) await cleanup.resume();
    return {
      audio: Buffer.from(generated.audio),
      mimeType: generated.mimeType,
      voice: generated.voice || voice,
      assetId: entry.id,
      attachmentPath: saved.attachmentPath,
      cacheStatus: "miss"
    };
  }

  async function synthesize({
    sourceType,
    sourceId,
    sourceVersion,
    voice,
    generationRate,
    regenerate = false
  }, generate) {
    if (typeof generate !== "function") throw new TypeError("Speech cache requires a synthesis callback");
    const normalizedSourceType = safeText(sourceType, 40);
    const normalizedSourceId = safeText(sourceId, 160);
    const normalizedVoice = safeText(voice, 160);
    if (!SOURCE_TYPES.has(normalizedSourceType) || !normalizedSourceId) {
      throw failure("朗读来源无效", "INVALID_SPEECH_SOURCE", 400);
    }
    const { ownerHash } = ownerIdentity();

    let source = await readSource(
      normalizedSourceType,
      normalizedSourceId,
      sourceVersion,
      ownerHash,
      normalizedVoice,
      generationRate
    );
    await prune(source.identity, ownerHash, null, source.store);
    source = await readSource(
      normalizedSourceType,
      normalizedSourceId,
      sourceVersion,
      ownerHash,
      normalizedVoice,
      generationRate
    );

    const matching = list(source.store.speechCache).find(
      entry => matchingEntry(entry, source.identity, ownerHash, normalizedVoice)
    );
    if (matching && !regenerate) {
      const cached = await readCached(matching, normalizedVoice);
      if (cached) {
        if (recordVersion(matching.sourceVersion) !== source.identity.sourceVersion
          || !sameSourceVersions(matching.sourceVersions, source.identity.sourceVersions)) {
          await repository.update(store => {
            normalizeSpeechCacheStore(store);
            for (const current of list(store.speechCache)) {
              if (current.ownerHash === ownerHash
                && current.sourceType === source.identity.sourceType
                && current.sourceId === source.identity.sourceId
                && current.textHash === source.identity.textHash) {
                current.sourceVersion = source.identity.sourceVersion;
                if (source.identity.sourceVersions) {
                  current.sourceVersions = sourceVersionsOf(source.identity.sourceVersions);
                }
              }
            }
          });
        }
        return cached;
      }
      await prune(
        source.identity,
        ownerHash,
        entry => entryId(entry) === entryId(matching),
        source.store
      );
    }

    const operationKey = `${regenerate ? "regenerate" : "generate"}:${source.identity.cacheKey}`;
    const pending = inFlight.get(operationKey);
    if (pending) {
      return pending.then(result => ({ ...result, cacheStatus: "hit" }));
    }
    const operation = generateAndPersist({
      ownerHash,
      voice: normalizedVoice,
      identity: source.identity,
      regenerate: Boolean(regenerate),
      generate
    });
    inFlight.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(operationKey) === operation) {
        inFlight.delete(operationKey);
      }
    }
  }

  async function readAudio({ id }) {
    const assetId = safeText(id, 160);
    if (!assetId) throw failure("朗读音频标识无效", "INVALID_SPEECH_ASSET", 400);
    const { ownerHash } = ownerIdentity();
    const store = await repository.read();
    normalizeSpeechCacheStore(store);
    const entry = list(store.speechCache).find(item => entryId(item) === assetId);
    if (!entry || entry.ownerHash !== ownerHash || !cachePath(entry)) {
      throw failure("朗读音频不存在", "SPEECH_ASSET_NOT_FOUND", 404);
    }
    if (expiredEntry(entry)) {
      throw failure("朗读音频已经失效", "SPEECH_ASSET_EXPIRED", 410);
    }
    let identity;
    try {
      identity = sourceIdentity(
        store,
        entry.sourceType,
        entry.sourceId,
        ownerHash,
        entry.voice,
        generationRateOf(entry)
      );
    } catch (error) {
      if (error.code === "SPEECH_SOURCE_MISSING") {
        throw failure("朗读来源已经失效", "SPEECH_ASSET_INVALID", 410);
      }
      throw error;
    }
    if (!matchingEntry(entry, identity, ownerHash, entry.voice)) {
      throw failure("朗读来源已经变化", "SPEECH_ASSET_INVALID", 410);
    }
    return readCached(entry, entry.voice, "SPEECH_ASSET_NOT_FOUND");
  }

  const synthesizeCapture = (input, generate) => synthesize({
    ...input,
    sourceType: "capture",
    sourceId: input.captureId
  }, generate);

  const synthesizeThoughtChain = (input, generate) => synthesize({
    ...input,
    sourceType: "thoughtChain",
    sourceId: input.thoughtChainId
  }, generate);

  return { synthesize, synthesizeCapture, synthesizeThoughtChain, readAudio };
}
