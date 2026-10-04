import {
  speechCacheAttachmentPath,
  speechCacheEntryExpired
} from "./speech-cache.mjs";

export const SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS = 5_000;
export const SPEECH_CACHE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const cacheEntries = value => (
  Array.isArray(value?.speechCache) ? value.speechCache : []
);

function cacheOwners(store) {
  return [
    store,
    ...(Array.isArray(store?.captures) ? store.captures : []),
    ...(Array.isArray(store?.trash)
      ? store.trash
        .filter(entry => entry?.type === "capture" && entry.payload)
        .map(entry => entry.payload)
      : [])
  ];
}

const hasExpiredEntries = (store, sweptAt) => cacheOwners(store).some(
  owner => cacheEntries(owner).some(entry => speechCacheEntryExpired(entry, sweptAt))
);

export function createSpeechCacheSweep({
  listAccountIds,
  runWithAccount,
  repository,
  cleanup,
  now = () => new Date().toISOString(),
  onAccountError = async () => {}
}) {
  if (typeof listAccountIds !== "function" || typeof runWithAccount !== "function"
    || !repository?.read || !repository?.update || !cleanup?.enqueue || !cleanup?.resume
    || typeof now !== "function" || typeof onAccountError !== "function") {
    throw new TypeError("Speech cache sweep requires account context, repository, cleanup and clock");
  }

  let inFlight = null;

  async function sweep() {
    const sweptAt = now();
    if (!Number.isFinite(Date.parse(sweptAt))) {
      throw new TypeError("Speech cache sweep clock must return an ISO timestamp");
    }
    const listed = await listAccountIds();
    if (!Array.isArray(listed) || listed.some(id => typeof id !== "string" || !/^[\w-]+$/.test(id))) {
      throw new TypeError("Speech cache sweep requires valid account identifiers");
    }
    const accountIds = [...new Set(listed)];
    const summary = {
      accounts: accountIds.length,
      succeeded: 0,
      failed: 0,
      entriesRemoved: 0,
      attachmentCandidates: 0,
      attachmentsQueued: 0,
      attachmentsRemoved: 0,
      attachmentCleanupPending: 0
    };

    for (const accountId of accountIds) {
      try {
        const accountResult = await runWithAccount(accountId, async () => {
          let mutation = {
            entriesRemoved: 0,
            attachmentCandidates: 0,
            attachmentsQueued: 0
          };
          let accountError = null;
          try {
            const snapshot = await repository.read();
            if (hasExpiredEntries(snapshot, sweptAt)) {
              mutation = await repository.update(store => {
                const paths = new Set();
                let entriesRemoved = 0;
                const queueBefore = Array.isArray(store.attachmentCleanup)
                  ? store.attachmentCleanup.length
                  : 0;
                for (const owner of cacheOwners(store)) {
                  const entries = cacheEntries(owner);
                  if (!entries.length) continue;
                  const retained = [];
                  for (const entry of entries) {
                    if (!speechCacheEntryExpired(entry, sweptAt)) {
                      retained.push(entry);
                      continue;
                    }
                    entriesRemoved += 1;
                    const attachmentPath = speechCacheAttachmentPath(entry);
                    if (attachmentPath) paths.add(attachmentPath);
                  }
                  if (retained.length !== entries.length) owner.speechCache = retained;
                }
                cleanup.enqueue(store, paths);
                return {
                  entriesRemoved,
                  attachmentCandidates: paths.size,
                  attachmentsQueued: Math.max(
                    0,
                    (Array.isArray(store.attachmentCleanup) ? store.attachmentCleanup.length : 0) - queueBefore
                  )
                };
              });
            }
          } catch (error) {
            accountError = error;
          }
          let cleanupResult = { removed: [], pending: 0 };
          try {
            cleanupResult = await cleanup.resume();
          } catch (error) {
            accountError ||= error;
          }
          if (accountError) throw accountError;
          return {
            ...mutation,
            attachmentsRemoved: cleanupResult.removed?.length || 0,
            attachmentCleanupPending: cleanupResult.pending || 0
          };
        });
        summary.succeeded += 1;
        for (const key of [
          "entriesRemoved",
          "attachmentCandidates",
          "attachmentsQueued",
          "attachmentsRemoved",
          "attachmentCleanupPending"
        ]) summary[key] += accountResult[key];
      } catch (error) {
        summary.failed += 1;
        await Promise.resolve(onAccountError(error, { accountId })).catch(() => {});
      }
    }
    return summary;
  }

  return {
    run() {
      if (inFlight) return inFlight;
      inFlight = sweep().finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}
