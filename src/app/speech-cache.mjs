import { recordVersion, safeText } from "../shared/validation/index.mjs";
import { normalizeTtsGenerationRate, speechTextForCapture } from "../shared/speech/index.mjs";

const ATTACHMENT_PATH = /^\/attachments\/[\w.-]+$/;
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
const cacheEntries = capture => (
  Array.isArray(capture?.speechCache) ? capture.speechCache : []
);
const cachePath = entry => (
  ATTACHMENT_PATH.test(entry?.attachmentPath || "") ? entry.attachmentPath : ""
);

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
  const expiredEntry = entry => {
    const explicit = Date.parse(entry?.expiresAt);
    const derived = Date.parse(entry?.createdAt) + SPEECH_CACHE_RETENTION_MS;
    const cutoff = Number.isFinite(explicit) ? explicit : derived;
    return !Number.isFinite(cutoff) || cutoff <= Date.parse(now());
  };

  const ownerIdentity = () => {
    const ownerId = safeText(getOwnerId(), 160);
    if (!ownerId) throw failure("朗读缺少账户上下文", "SPEECH_OWNER_REQUIRED", 500);
    return { ownerId, ownerHash: hash(ownerId) };
  };

  const obsoleteEntry = (entry, capture, ownerHash, predicate) => (
    entry?.ownerHash !== ownerHash
    || Number(entry?.sourceVersion) !== recordVersion(capture.version)
    || entry?.textHash !== hash(speechTextForCapture(capture))
    || !cachePath(entry)
    || Boolean(predicate?.(entry))
  );

  const sourceIdentity = (capture, ownerHash, voice, generationRate) => {
    const text = speechTextForCapture(capture);
    if (!text) throw failure("朗读文本不能为空", "INVALID_TTS_TEXT", 400);
    const sourceVersion = recordVersion(capture.version);
    const textHash = hash(text);
    const generation = { ...CACHE_PROFILE, rate: normalizeTtsGenerationRate(generationRate) };
    const cacheKey = hash(JSON.stringify({
      schemaVersion: 1,
      ownerHash,
      source: {
        type: "capture",
        id: capture.id,
        version: sourceVersion,
        textHash
      },
      voice,
      generation
    }));
    return { text, textHash, sourceVersion, generation, cacheKey };
  };

  async function prune(captureId, ownerHash, predicate = null, snapshot = null) {
    if (snapshot && !cacheEntries(snapshot).some(
      entry => obsoleteEntry(entry, snapshot, ownerHash, candidate => expiredEntry(candidate) || predicate?.(candidate))
    )) return [];
    const result = await repository.update(store => {
      const capture = store.captures?.find(item => item.id === captureId);
      if (!capture) return { removed: [] };
      const removed = [], retained = [];
      for (const entry of cacheEntries(capture)) {
        if (obsoleteEntry(entry, capture, ownerHash, candidate => expiredEntry(candidate) || predicate?.(candidate))) removed.push(entry);
        else retained.push(entry);
      }
      capture.speechCache = retained;
      const paths = new Set(removed.map(cachePath).filter(Boolean));
      cleanup.enqueue(store, paths);
      return { removed, paths: [...paths] };
    });
    if (result.paths?.length) await cleanup.resume();
    return result.removed || [];
  }

  async function readSource(captureId, requestedVersion, ownerHash, voice, generationRate) {
    const store = await repository.read();
    const capture = store.captures?.find(item => item.id === captureId);
    if (!capture) throw failure("朗读来源不存在", "SPEECH_SOURCE_MISSING", 404);
    const identity = sourceIdentity(capture, ownerHash, voice, generationRate);
    if (Number(requestedVersion) !== identity.sourceVersion) {
      throw failure("朗读来源已经变化，请重试", "SPEECH_SOURCE_STALE", 409);
    }
    return { capture, identity };
  }

  async function readCached(entry, voice) {
    try {
      return {
        audio: await attachments.read(entry.attachmentPath),
        mimeType: entry.mimeType,
        voice,
        attachmentPath: entry.attachmentPath,
        cacheStatus: "hit"
      };
    } catch (error) {
      if (!missingAttachment(error)) throw error;
      return null;
    }
  }

  async function generateAndPersist({
    captureId,
    ownerHash,
    voice,
    identity,
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
      cacheKey: identity.cacheKey,
      ownerHash,
      sourceType: "capture",
      sourceId: captureId,
      sourceVersion: identity.sourceVersion,
      textHash: identity.textHash,
      voice,
      generation: identity.generation,
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
        const capture = store.captures?.find(item => item.id === captureId);
        if (!capture) return { missing: true };
        const liveVersion = recordVersion(capture.version);
        const liveTextHash = hash(speechTextForCapture(capture));
        if (liveVersion !== identity.sourceVersion || liveTextHash !== identity.textHash) {
          return { stale: true };
        }
        const existing = cacheEntries(capture).find(item => item.cacheKey === identity.cacheKey);
        if (existing) return { existing };
        capture.speechCache = [...cacheEntries(capture), entry];
        return { entry };
      });
    } catch (error) {
      await cleanup.cleanFailedUploads([saved.attachmentPath]).catch(() => {});
      throw error;
    }

    if (outcome.missing || outcome.stale || outcome.existing) {
      await cleanup.cleanFailedUploads([saved.attachmentPath]);
    }
    if (outcome.missing) throw failure("朗读来源不存在", "SPEECH_SOURCE_MISSING", 404);
    if (outcome.stale) throw failure("朗读来源已经变化，请重试", "SPEECH_SOURCE_STALE", 409);
    if (outcome.existing) {
      const cached = await readCached(outcome.existing, voice);
      if (cached) return cached;
    }
    return {
      audio: Buffer.from(generated.audio),
      mimeType: generated.mimeType,
      voice: generated.voice || voice,
      attachmentPath: saved.attachmentPath,
      cacheStatus: "miss"
    };
  }

  async function synthesizeCapture({
    captureId,
    sourceVersion,
    voice,
    generationRate
  }, generate) {
    if (typeof generate !== "function") throw new TypeError("Speech cache requires a synthesis callback");
    const normalizedCaptureId = safeText(captureId, 160);
    const normalizedVoice = safeText(voice, 160);
    if (!normalizedCaptureId) throw failure("朗读来源无效", "INVALID_SPEECH_SOURCE", 400);
    const { ownerHash } = ownerIdentity();

    let source = await readSource(
      normalizedCaptureId,
      sourceVersion,
      ownerHash,
      normalizedVoice,
      generationRate
    );
    await prune(normalizedCaptureId, ownerHash, null, source.capture);
    source = await readSource(
      normalizedCaptureId,
      sourceVersion,
      ownerHash,
      normalizedVoice,
      generationRate
    );

    const matching = cacheEntries(source.capture).find(
      entry => entry.cacheKey === source.identity.cacheKey
    );
    if (matching) {
      const cached = await readCached(matching, normalizedVoice);
      if (cached) return cached;
      await prune(
        normalizedCaptureId,
        ownerHash,
        entry => entry.cacheKey === source.identity.cacheKey,
        source.capture
      );
    }

    const pending = inFlight.get(source.identity.cacheKey);
    if (pending) {
      return pending.then(result => ({ ...result, cacheStatus: "hit" }));
    }
    const operation = generateAndPersist({
      captureId: normalizedCaptureId,
      ownerHash,
      voice: normalizedVoice,
      identity: source.identity,
      generate
    });
    inFlight.set(source.identity.cacheKey, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(source.identity.cacheKey) === operation) {
        inFlight.delete(source.identity.cacheKey);
      }
    }
  }

  return { synthesizeCapture };
}
