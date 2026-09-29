export function validatedImageFiles(files, maxFiles = 1) {
  const list = [...files].slice(0, maxFiles);
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!list.length) throw new Error("没有找到可用图片");
  if ([...files].length > maxFiles) throw new Error(`最多选择 ${maxFiles} 张图片`);
  if (list.some(file => !allowed.has(file.type))) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  if (list.some(file => file.size > 8 * 1024 * 1024) || list.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) {
    throw new Error("单张及本次图片总大小均不得超过 8 MB");
  }
  return list;
}

export function imageRecordPayload({ content = "", attachmentPaths = [] } = {}, maxAttachments = 2) {
  const paths = [...new Set((Array.isArray(attachmentPaths) ? attachmentPaths : [])
    .filter(value => typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value)))];
  if (paths.length > maxAttachments) throw new Error(`最多插入 ${maxAttachments} 张图片`);
  if (!String(content).trim() && !paths.length) throw new Error("请填写文字或插入图片");
  return { content: String(content), attachmentPaths: paths };
}

export async function uploadOriginalImages({ request, images, idempotencyKey = "" }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new TypeError("An idempotency key is required");
  }
  if (!Array.isArray(images) || !images.length || images.some(image => typeof image !== "string" || !image)) {
    throw new TypeError("At least one image data URL is required");
  }
  const result = await request("/api/images/upload", {
    method: "POST",
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    body: JSON.stringify({ purpose: "original", images })
  });
  const attachmentPaths = Array.isArray(result?.attachmentPaths)
    ? result.attachmentPaths
    : result?.attachmentPath ? [result.attachmentPath] : [];
  if (attachmentPaths.length !== images.length || attachmentPaths.some(path => !/^\/attachments\/[\w.-]+$/.test(path))) {
    throw new Error("服务端未返回完整的原图附件路径");
  }
  return attachmentPaths;
}

export async function uploadOriginalImage({ request, image, idempotencyKey }) {
  return (await uploadOriginalImages({ request, images: [image], idempotencyKey }))[0];
}

export function imageUnderstandingPayload({ attachmentPaths, targetType, targetId = "", inputVersion = 0 }) {
  const record = imageRecordPayload({ attachmentPaths });
  if (typeof targetType !== "string" || !targetType.trim()) throw new TypeError("An explicit image-understanding target type is required");
  return {
    attachmentPaths: record.attachmentPaths,
    targetType: targetType.trim(),
    targetId: String(targetId || ""),
    inputVersion: Number.isSafeInteger(Number(inputVersion)) && Number(inputVersion) >= 0 ? Number(inputVersion) : 0
  };
}
