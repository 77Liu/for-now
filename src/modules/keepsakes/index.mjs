import crypto from "node:crypto";
import { keepsakeImageCandidates } from "./records.mjs";

export {
  normalizeKeepsake,
  keepsakeImageCandidates,
  keepsakePayload,
  keepsakeMediaManifest,
  createKeepsakeRecords,
  publicKeepsake,
  originalKeepsakeMedia
} from "./records.mjs";

export function createKeepsakeImageUnderstanding({ saveImages, cleanupFiles, generate }) {
  if (typeof saveImages !== "function" || typeof cleanupFiles !== "function" || typeof generate !== "function") {
    throw new TypeError("Keepsake image understanding requires image storage, cleanup and generation");
  }
  return async input => {
    const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
    if (images.length !== 1) throw new Error("请选择 1 张图片");
    const { files } = await saveImages(images, 1, { persist: false, needsLocalFiles: true });
    try {
      const existingTags = Array.isArray(input.existingTags) ? input.existingTags : [];
      const raw = String(await generate(files[0], { existingTags }) || "");
      let parsed;
      try {
        parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "");
      } catch {
        throw new Error("图片已读取，但候选格式无法解析，请重试或手动填写");
      }
      return keepsakeImageCandidates(parsed, { existingTags });
    } finally {
      await cleanupFiles(files);
    }
  };
}

export function createKeepsakeSegmentation({ saveImages, cleanupFiles, provider, gate, onFailure, createId = () => crypto.randomUUID() }) {
  return async input => {
    const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
    if (images.length !== 1) throw new Error("请选择 1 张图片");
    const release = await gate.acquire();
    try {
      const { files } = await saveImages(images, 1, { persist: false, needsLocalFiles: true });
      const callGroupId = createId();
      try {
        return await provider.segment(files[0], { callGroupId });
      } catch (error) {
        await onFailure(error, callGroupId);
        throw new Error(error.publicMessage || "主体识别服务暂时不可用，请稍后重试");
      } finally {
        await cleanupFiles(files);
      }
    } finally {
      release();
    }
  };
}
