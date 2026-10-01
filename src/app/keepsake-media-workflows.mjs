import crypto from "node:crypto";

const MEDIA_KEYS = ["thumbPath", "displayPath", "editPath", "alphaMaskPath"];
const requestDigest = input => crypto.createHash("sha256").update(JSON.stringify({
  ...input,
  image: crypto.createHash("sha256").update(String(input.image || "")).digest("hex"),
  alphaMask: crypto.createHash("sha256").update(String(input.alphaMask || "")).digest("hex")
})).digest("hex");

const generatedPaths = (paths, includeOriginal) => [
  ...(includeOriginal ? [paths.originalPath] : []),
  ...MEDIA_KEYS.map(key => paths[key])
].filter(Boolean);

const replacedPaths = item => [
  item.cutoutPath,
  ...MEDIA_KEYS.map(key => item[key])
].filter(Boolean);

export function createKeepsakeMediaWorkflows({
  repository,
  attachments,
  cleanup,
  parse,
  createId,
  now
}) {
  if (!repository?.read || !repository?.update || !attachments?.saveKeepsakeSet
    || !attachments?.deriveKeepsakeSet || !cleanup?.enqueue || !cleanup?.resume
    || !cleanup?.cleanFailedUploads || typeof parse !== "function") {
    throw new TypeError("Keepsake media workflows require repository, attachments, cleanup and parser");
  }

  async function discardGenerated(paths, includeOriginal) {
    await cleanup.cleanFailedUploads(generatedPaths(paths, includeOriginal));
  }

  return {
    async create(input, { clientRequestId = "" } = {}) {
      const idempotency = clientRequestId ? {
        scope: "keepsakeMedia.create",
        key: clientRequestId,
        requestHash: requestDigest(input)
      } : null;
      if (idempotency && typeof repository.readIdempotent === "function") {
        try {
          const replay = await repository.readIdempotent(idempotency);
          if (replay !== undefined) return { ...replay, duplicate: true };
        } catch (error) {
          if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
          throw error;
        }
      }
      const uploaded = await attachments.saveKeepsakeSet({
        image: input.image,
        alphaMask: input.alphaMask
      });
      try {
        const parsed = parse({ ...input, ...uploaded.paths, cutoutPath: "" });
        if (parsed.error) {
          await discardGenerated(uploaded.paths, true);
          return parsed;
        }
        const createRecord = store => {
          const value = {
            id: createId(),
            createdAt: now(),
            ...parsed.value,
            mediaVersion: 1,
            ...(clientRequestId ? { clientRequestId, requestHash: idempotency.requestHash } : {})
          };
          store.keepsakes.unshift(value);
          return { value, duplicate: false };
        };
        const result = idempotency && typeof repository.executeIdempotent === "function"
          ? await repository.executeIdempotent(idempotency, createRecord, { onReplay: value => ({ ...value, duplicate: true }) })
          : await repository.update(createRecord);
        if (result.duplicate) await discardGenerated(uploaded.paths, true).catch(() => {});
        return result;
      } catch (error) {
        await discardGenerated(uploaded.paths, true).catch(() => {});
        if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
        throw error;
      }
    },

    async update(id, input) {
      const before = (await repository.read()).keepsakes.find(item => item.id === id);
      if (!before) return { missing: true };
      const replacingOriginal = Boolean(input.image);
      const uploaded = replacingOriginal
        ? await attachments.saveKeepsakeSet({ image: input.image, alphaMask: input.alphaMask })
        : await attachments.deriveKeepsakeSet({
            originalPath: before.originalPath,
            alphaMask: input.alphaMask
          });
      try {
        const result = await repository.update(store => {
          const current = store.keepsakes.find(item => item.id === id);
          if (!current) return { missing: true };
          if (current.originalPath !== before.originalPath
            || Number(current.mediaVersion || 0) !== Number(before.mediaVersion || 0)) {
            return { conflict: true };
          }
          const parsed = parse({ ...input, ...uploaded.paths, cutoutPath: "" }, current);
          if (parsed.error) return parsed;
          const oldPaths = [
            ...(replacingOriginal ? [current.originalPath] : []),
            ...replacedPaths(current)
          ].filter(Boolean);
          Object.assign(current, parsed.value, {
            mediaVersion: Math.max(0, Number(current.mediaVersion) || 0) + 1,
            updatedAt: now()
          });
          cleanup.enqueue(store, new Set(oldPaths));
          return { value: current };
        });
        if (result.missing || result.conflict || result.error) {
          await discardGenerated(uploaded.paths, replacingOriginal);
          return result;
        }
        await cleanup.resume();
        return result;
      } catch (error) {
        await discardGenerated(uploaded.paths, replacingOriginal).catch(() => {});
        throw error;
      }
    }
  };
}
