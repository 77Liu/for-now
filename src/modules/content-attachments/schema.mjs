import { safeText } from "../../shared/validation/index.mjs";
import { businessReasoning } from "../ai/index.mjs";

export const CONTENT_ATTACHMENT_TARGET_TYPES = Object.freeze([
  "comment",
  "capture",
  "thoughtRoot",
  "thoughtBlock"
]);
export const CONTENT_ATTACHMENT_MAX_IMAGES = 2;

const TARGET_TYPE_SET = new Set(CONTENT_ATTACHMENT_TARGET_TYPES);
const ATTACHMENT_PATH = /^\/attachments\/[\w.-]+$/;

export function normalizeContentAttachmentTarget(targetType, targetId) {
  const normalizedType = safeText(targetType, 40);
  const normalizedId = safeText(targetId, 100);
  if (!TARGET_TYPE_SET.has(normalizedType)) {
    return {
      error: "图片原文目标类型无效",
      code: "INVALID_CONTENT_ATTACHMENT_TARGET"
    };
  }
  if (!normalizedId || String(targetId ?? "").trim().length > 100) {
    return {
      error: "图片原文目标 ID 无效",
      code: "INVALID_CONTENT_ATTACHMENT_TARGET"
    };
  }
  return { value: { targetType: normalizedType, targetId: normalizedId } };
}

export function normalizeOriginalImagePaths(value, { maxImages = CONTENT_ATTACHMENT_MAX_IMAGES, requireImages = false } = {}) {
  if (!Array.isArray(value)) {
    return { error: "attachmentPaths 必须是数组", code: "INVALID_ATTACHMENT_PATHS" };
  }
  const paths = [];
  for (const item of value) {
    if (typeof item !== "string" || !ATTACHMENT_PATH.test(item)) {
      return { error: "图片引用格式无效", code: "INVALID_ATTACHMENT_PATH" };
    }
    if (!paths.includes(item)) paths.push(item);
  }
  if (requireImages && !paths.length) {
    return { error: "请至少选择一张原始图片", code: "IMAGE_REQUIRED" };
  }
  if (paths.length > maxImages) {
    return { error: `最多插入 ${maxImages} 张图片`, code: "TOO_MANY_IMAGES" };
  }
  return { value: paths };
}

export function contentOriginalPayload(targetType, input = {}, options = {}) {
  const normalizedType = safeText(targetType, 40);
  if (!TARGET_TYPE_SET.has(normalizedType)) {
    return {
      error: "图片原文目标类型无效",
      code: "INVALID_CONTENT_ATTACHMENT_TARGET"
    };
  }
  const field = normalizedType === "comment" ? "text" : "content";
  const text = String(input[field] ?? "");
  const paths = normalizeOriginalImagePaths(input.attachmentPaths ?? [], options);
  if (paths.error) return paths;
  if (!text.trim() && !paths.value.length) {
    return { error: "请填写文字或插入图片", code: "CONTENT_OR_IMAGE_REQUIRED" };
  }
  return { value: { [field]: text, attachmentPaths: paths.value } };
}

export function imageUnderstandingResult(input = {}, options = {}) {
  const paths = normalizeOriginalImagePaths(input.attachmentPaths ?? input.sourceAttachmentPaths ?? [], {
    ...options,
    requireImages: true
  });
  if (paths.error) return paths;
  const content = safeText(input.content, 50000);
  if (!content) {
    return { error: "图片理解结果不能为空", code: "IMAGE_UNDERSTANDING_REQUIRED" };
  }
  const sourceTaskId = safeText(input.sourceTaskId, 100);
  const clientRequestId = safeText(input.clientRequestId, 100);
  if (!sourceTaskId && !clientRequestId) {
    return { error: "图片理解结果缺少可追溯请求标识", code: "IMAGE_UNDERSTANDING_SOURCE_REQUIRED" };
  }
  return {
    value: {
      content,
      ...businessReasoning("contentImageUnderstanding", input.reasoningContent, 50000),
      sourceAttachmentPaths: paths.value,
      model: safeText(input.model, 120),
      sourceTaskId,
      clientRequestId
    }
  };
}
