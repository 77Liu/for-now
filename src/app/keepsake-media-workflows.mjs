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
  now,
  dispatch = callback => queueMicrotask(callback),
  contextKey = () => "",
  onError = () => {}
}) {
  if (!repository?.read || !repository?.update || !attachments?.saveKeepsakeSources
    || !attachments?.deriveKeepsakeSet || !cleanup?.enqueue || !cleanup?.resume
    || !cleanup?.cleanFailedUploads || !attachments?.read || typeof parse !== "function") {
    throw new TypeError("Keepsake media workflows require repository, attachments, cleanup and parser");
  }
  const running = new Set();

  async function discardGenerated(paths, includeOriginal) {
    await cleanup.cleanFailedUploads(generatedPaths(paths, includeOriginal));
  }

  async function derive(id) {
    const key = `${contextKey()}:${id}`;
    if (running.has(key)) return { running: true };
    running.add(key);
    try {
      const before = (await repository.read()).keepsakes.find(item => item.id === id);
      if (!before || !["pending", "failed"].includes(before.derivativeState)) return { skipped: true };
      const expected = {
        originalPath: before.originalPath,
        alphaMaskPath: before.alphaMaskPath,
        mediaVersion: Number(before.mediaVersion) || 1
      };
      const generated = await attachments.deriveKeepsakeSet({
        originalPath: expected.originalPath,
        alphaMaskPath: expected.alphaMaskPath
      });
      try {
        const result = await repository.update(store => {
          const current = store.keepsakes.find(item => item.id === id);
          if (!current) return { missing: true };
          if (current.originalPath !== expected.originalPath
            || current.alphaMaskPath !== expected.alphaMaskPath
            || Number(current.mediaVersion || 0) !== expected.mediaVersion
            || !["pending", "failed"].includes(current.derivativeState)) {
            return { conflict: true };
          }
          Object.assign(current, generated.paths, {
            derivativeState: "ready",
            derivativeErrorCode: "",
            mediaVersion: expected.mediaVersion + 1,
            updatedAt: now()
          });
          cleanup.enqueue(store, new Set(generated.replacedPaths || []));
          return { value: current };
        });
        if (result.missing || result.conflict) {
          await cleanup.cleanFailedUploads(generated.attachmentPaths || []);
          return result;
        }
        await cleanup.resume();
        return result;
      } catch (error) {
        await cleanup.cleanFailedUploads(generated.attachmentPaths || []).catch(() => {});
        throw error;
      }
    } catch (error) {
      await repository.update(store => {
        const current = store.keepsakes.find(item => item.id === id);
        if (current && ["pending", "failed"].includes(current.derivativeState)) {
          current.derivativeState = "failed";
          current.derivativeErrorCode = String(error?.code || error?.name || "IMAGE_DERIVATIVE_FAILED").slice(0, 120);
          current.updatedAt = now();
        }
      }).catch(() => {});
      throw error;
    } finally {
      running.delete(key);
    }
  }

  const schedule = id => dispatch(() => derive(id).catch(error => onError(id, error)));

  async function create(input, { clientRequestId = "" } = {}) {
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
      const suppliedPaths = /^\/attachments\/[\w.-]+$/.test(input.originalPath || "")
        && /^\/attachments\/[\w.-]+$/.test(input.alphaMaskPath || "");
      const uploaded = suppliedPaths
        ? {
            paths: { originalPath: input.originalPath, alphaMaskPath: input.alphaMaskPath },
            attachmentPaths: [input.originalPath, input.alphaMaskPath]
          }
        : await attachments.saveKeepsakeSources({
            image: input.image,
            alphaMask: input.alphaMask
          });
      try {
        if (suppliedPaths) await Promise.all(uploaded.attachmentPaths.map(resourcePath => attachments.read(resourcePath)));
        const parsed = parse({
          ...input,
          ...uploaded.paths,
          cutoutPath: "",
          thumbPath: "",
          displayPath: "",
          editPath: "",
          derivativeState: "pending"
        });
        if (parsed.error) {
          await cleanup.cleanFailedUploads(uploaded.attachmentPaths);
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
        if (result.duplicate) await cleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
        else schedule(result.value.id);
        return result;
      } catch (error) {
        await cleanup.cleanFailedUploads(uploaded.attachmentPaths).catch(() => {});
        if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
        throw error;
      }
    }

  return {
    create,
    derive,
    retry: async id => {
      const result = await repository.update(store => {
        const current = store.keepsakes.find(item => item.id === id);
        if (!current) return { missing: true };
        if (current.derivativeState === "ready") return { value: current, unchanged: true };
        if (!["pending", "failed"].includes(current.derivativeState)
          || !current.originalPath
          || !current.alphaMaskPath) return { invalid: true };
        current.derivativeState = "pending";
        current.derivativeErrorCode = "";
        current.updatedAt = now();
        return { value: current };
      });
      if (!result.missing && !result.unchanged && !result.invalid) schedule(id);
      return result;
    },
    resume: async () => {
      const store = await repository.read();
      const ids = store.keepsakes
        .filter(item => ["pending", "failed"].includes(item.derivativeState))
        .map(item => item.id);
      ids.forEach(schedule);
      return ids;
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
