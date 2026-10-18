import { collectAttachmentPaths, enqueueAttachmentCleanup, drainAttachmentCleanup } from "../shared/attachments/index.mjs";

export function createAttachmentCleanup({ repository, remove, now, contextKey, dispatch, onRetryFailure, onResult }) {
  const timers = new Map();
  const references = store => {
    const { _persistence, attachmentCleanup, ...visibleStore } = store;
    return collectAttachmentPaths({
      ...visibleStore,
      trash: (visibleStore.trash || []).filter(entry => entry.permanentlyPurged !== true)
    });
  };
  const enqueue = (store, candidates) => enqueueAttachmentCleanup(store.attachmentCleanup, candidates, references(store), now);
  const drain = store => drainAttachmentCleanup(store.attachmentCleanup, references(store), { remove, now });

  function schedule() {
    const key = contextKey();
    if (timers.has(key)) return;
    timers.set(key, dispatch(() => {
      timers.delete(key);
      return resume().catch(error => { onRetryFailure(error); schedule(); });
    }, 60_000));
  }

  function resume() {
    return repository.transact(async ({ document: store, commit }) => {
      if (!store.attachmentCleanup.length) return { removed: [], pending: 0 };
      const result = await drain(store);
      await commit();
      await onResult(result);
      if (result.pending) schedule();
      return result;
    });
  }

  async function cleanFailedUploads(paths) {
    const requested = new Set(paths);
    await repository.update(store => enqueue(store, requested));
    const result = await resume();
    return { ...result, removed: result.removed.filter(resourcePath => requested.has(resourcePath)) };
  }

  return { enqueue, drain, resume, schedule, cleanFailedUploads };
}
