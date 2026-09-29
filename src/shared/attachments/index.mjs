import { safeText } from "../validation/index.mjs";

export { createAttachmentStorage } from "./storage.mjs";
export { createImageAttachments, cleanupTemporaryFiles } from "./uploads.mjs";
export { cleanAttachmentPaths, imageDimensions, readImageFile } from "./images.mjs";
export {
  KEEPSAKE_DERIVATIVE_PROFILES,
  createKeepsakeImageDerivatives,
  createSharpImageProcessor
} from "./derivatives.mjs";
export { ATTACHMENT_BACKUP_FORMAT, stageAttachmentCompleteBackup } from "./backup.mjs";

export function collectAttachmentPaths(value, output = new Set()) {
  if (typeof value === "string") {
    if (/^\/attachments\/[\w.-]+$/.test(value)) output.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAttachmentPaths(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectAttachmentPaths(item, output);
  }
  return output;
}

export function enqueueAttachmentCleanup(queue, candidates, referenced, now) {
  for (const resourcePath of candidates) {
    if (!referenced.has(resourcePath) && !queue.some(item => item.path === resourcePath)) {
      queue.push({ path: resourcePath, createdAt: now(), lastAttemptAt: "", attempts: 0, errorCode: "" });
    }
  }
}

export async function drainAttachmentCleanup(queue, referenced, { remove, now }) {
  const removed = [], pending = [], attempted = queue.length > 0;
  for (const item of queue) {
    if (referenced.has(item.path)) continue;
    try {
      await remove(item.path);
      removed.push(item.path);
    } catch (error) {
      pending.push({ ...item, attempts: item.attempts + 1, lastAttemptAt: now(), errorCode: safeText(error.code || error.name || "ATTACHMENT_DELETE_FAILED", 100) });
    }
  }
  queue.splice(0, queue.length, ...pending);
  return { removed, pending: pending.length, attempted };
}
