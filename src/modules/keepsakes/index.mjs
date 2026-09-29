import crypto from "node:crypto";

export {
  normalizeKeepsake,
  keepsakePayload,
  createKeepsakeRecords,
  publicKeepsake,
  originalKeepsakeMedia
} from "./records.mjs";

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
