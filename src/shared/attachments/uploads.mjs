import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { decodeImages } from "./images.mjs";
import { createKeepsakeImageDerivatives } from "./derivatives.mjs";

export const cleanupTemporaryFiles = files => Promise.all(files.map(file => fs.unlink(file).catch(() => {})));

// Context and inventory are injected so neither account lookup nor a concrete
// repository leaks into the storage module.
export function createImageAttachments({
  storage, getContext, quotaBytes, defaultMaxBytes, inventory = null,
  cleanFailedUploads, onCleanupDeferred, createId = () => crypto.randomUUID(),
  deriveKeepsakeImages = createKeepsakeImageDerivatives
}) {
  const writeQueues = new Map();
  const location = (resourcePath, context) => {
    const name = resourcePath.slice("/attachments/".length);
    return { ownerId: context.ownerId, name, localFile: path.join(context.attachmentsDir, name) };
  };

  async function remove(resourcePath) {
    await storage.remove(location(resourcePath, getContext()));
    if (inventory) await inventory.removed(resourcePath);
  }

  async function discard(paths, context = getContext()) {
    if (!paths.length) return;
    if (inventory) {
      await cleanFailedUploads(paths).catch(onCleanupDeferred);
    } else {
      await Promise.all(paths.map(resourcePath => storage.remove(location(resourcePath, context)).catch(() => {})));
    }
  }

  async function recover() {
    if (!inventory) return;
    const context = getContext();
    for (const { path: resourcePath } of await inventory.pending()) {
      try {
        await inventory.confirm({ path: resourcePath, ...await storage.inspect(location(resourcePath, context)) });
      } catch (error) {
        if (!["ENOENT", "NoSuchKey"].includes(error.code) && Number(error.status) !== 404) throw error;
        await inventory.removed(resourcePath);
      }
    }
  }

  async function prepareDirectory() {
    const { attachmentsDir } = getContext();
    await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(attachmentsDir, 0o700);
    for (const entry of await fs.readdir(attachmentsDir, { withFileTypes: true })) {
      if (entry.isFile()) await fs.chmod(path.join(attachmentsDir, entry.name), 0o600);
    }
  }

  async function persistPrepared(decoded, { persist = true, needsLocalFiles = false } = {}) {
    const context = getContext(), { dataDir, attachmentsDir, ownerId } = context;
    const totalBytes = decoded.reduce((sum, item) => sum + item.data.length, 0);
    const operation = async () => {
      if (persist) {
        const used = await storage.usageBytes({ ownerId, localDir: attachmentsDir });
        if (used + totalBytes > quotaBytes) {
          throw Object.assign(new Error("附件空间已达到当前账户上限，请删除不再需要的图片后重试"), { statusCode: 413, code: "ATTACHMENT_QUOTA_EXCEEDED" });
        }
      }
      const files = [], attachmentPaths = [], stored = [];
      try {
        for (const item of decoded) {
          if (!persist || (storage.mode !== "local" && needsLocalFiles)) {
            const tempDir = path.join(dataDir, "tmp");
            await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
            await fs.chmod(tempDir, 0o700);
            const file = path.join(tempDir, item.name);
            // Track before writing so a partial write is also cleaned up.
            files.push(file);
            await fs.writeFile(file, item.data, { mode: 0o600 });
          }
          if (persist) {
            const resourcePath = `/attachments/${item.name}`;
            if (inventory) await inventory.record({
              path: resourcePath, storage: storage.mode,
              objectKey: storage.mode === "local" ? item.name : storage.objectKey(ownerId, item.name),
              bytes: item.data.length, sha256: crypto.createHash("sha256").update(item.data).digest("hex")
            });
            stored.push(resourcePath);
            await storage.put({ ownerId, name: item.name, data: item.data, mimeType: item.mimeType, localFile: item.file });
            if (inventory) await inventory.confirm({ path: resourcePath, ...await storage.inspect(location(resourcePath, context)) });
            attachmentPaths.push(resourcePath);
            if (storage.mode === "local" && needsLocalFiles) files.push(item.file);
          }
        }
        return { files, attachmentPaths, cleanupFiles: storage.mode === "local" && persist ? [] : files };
      } catch (error) {
        await discard(stored, context);
        // Persisted local files belong to the durable cleanup queue on failure.
        // Only transient files may be unlinked without updating inventory.
        if (storage.mode !== "local" || !persist) await cleanupTemporaryFiles(files);
        throw error;
      }
    };
    if (!persist) return operation();
    if (inventory) return inventory.lock(operation);
    const key = `${dataDir}:${ownerId}`, queue = writeQueues.get(key) || Promise.resolve();
    const result = queue.then(operation), settled = result.catch(() => {});
    writeQueues.set(key, settled);
    try {
      return await result;
    } finally {
      if (writeQueues.get(key) === settled) writeQueues.delete(key);
    }
  }

  async function save(images, maxImages = 1, { persist = true, needsLocalFiles = false, maxBytes = defaultMaxBytes } = {}) {
    const { attachmentsDir } = getContext();
    const decoded = decodeImages(images, { maxImages, maxBytes }).map(item => {
      const name = `${createId()}.${item.extension}`;
      return { ...item, name, file: path.join(attachmentsDir, name) };
    });
    return persistPrepared(decoded, { persist, needsLocalFiles });
  }

  async function saveKeepsakeSet({ image, alphaMask, maxBytes = defaultMaxBytes }) {
    const { attachmentsDir } = getContext();
    const [source] = decodeImages([image], { maxImages: 1, maxBytes });
    const [mask] = decodeImages([alphaMask], { maxImages: 1, maxBytes });
    const derivatives = await deriveKeepsakeImages({ original: source.data, alphaMask: mask.data });
    const id = createId();
    const prepared = [
      { ...source, name: `${id}.original.${source.extension}` },
      ...Object.entries(derivatives).map(([kind, item]) => ({ ...item, name: `${id}.${kind}.webp` }))
    ].map(item => ({ ...item, file: path.join(attachmentsDir, item.name) }));
    const saved = await persistPrepared(prepared);
    const [originalPath, thumbPath, displayPath, editPath, alphaMaskPath] = saved.attachmentPaths;
    return {
      ...saved,
      paths: { originalPath, thumbPath, displayPath, editPath, alphaMaskPath },
      derivatives: Object.fromEntries(Object.entries(derivatives).map(([kind, { data, ...metadata }]) => [kind, metadata]))
    };
  }

  async function deriveKeepsakeSet({ originalPath, alphaMaskPath = "", alphaMask: alphaMaskData = "" }) {
    if (!/^\/attachments\/[\w.-]+$/.test(originalPath || "")
      || (!/^\/attachments\/[\w.-]+$/.test(alphaMaskPath || "") && !alphaMaskData)) {
      throw new TypeError("Existing original and an Alpha mask are required");
    }
    const context = getContext();
    const original = await storage.get(location(originalPath, context));
    const alphaMask = alphaMaskData
      ? decodeImages([alphaMaskData], { maxImages: 1, maxBytes: defaultMaxBytes })[0].data
      : await storage.get(location(alphaMaskPath, context));
    const derivatives = await deriveKeepsakeImages({ original, alphaMask });
    const { attachmentsDir } = context, id = createId();
    const prepared = Object.entries(derivatives).map(([kind, item]) => {
      const name = `${id}.${kind}.webp`;
      return { ...item, name, file: path.join(attachmentsDir, name) };
    });
    const saved = await persistPrepared(prepared);
    const [thumbPath, displayPath, editPath, derivedAlphaMaskPath] = saved.attachmentPaths;
    return {
      ...saved,
      paths: {
        originalPath,
        thumbPath,
        displayPath,
        editPath,
        alphaMaskPath: derivedAlphaMaskPath
      },
      replacedPaths: alphaMaskPath ? [alphaMaskPath] : [],
      derivatives: Object.fromEntries(Object.entries(derivatives).map(([kind, { data, ...metadata }]) => [kind, metadata]))
    };
  }

  return {
    save, saveKeepsakeSet, deriveKeepsakeSet, discard, remove, recover, prepareDirectory,
    read: resourcePath => storage.get(location(resourcePath, getContext()))
  };
}
