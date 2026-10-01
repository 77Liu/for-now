const attachmentPath = value => (
  typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value) ? value : ""
);

export const KEEPSAKE_BATCH_MAX_ITEMS = 8;

export function createKeepsakeBatchItems(files, {
  occurredAt,
  createId = () => crypto.randomUUID()
} = {}) {
  const list = [...(files || [])];
  if (!list.length) throw new Error("没有找到可用图片");
  if (list.length > KEEPSAKE_BATCH_MAX_ITEMS) throw new Error(`小物批次最多选择 ${KEEPSAKE_BATCH_MAX_ITEMS} 张图片`);
  return list.map((file, position) => ({
    itemId: createId(),
    position,
    file,
    occurredAt: String(occurredAt || ""),
    title: "",
    category: "其他",
    note: "",
    tags: "",
    edgeExpansion: 8,
    backgroundOpacityPct: 15,
    source: "manual",
    alphaMask: "",
    status: "waiting",
    uploadRequestId: "",
    createRequestId: "",
    mediaPaths: null,
    lastError: null
  }));
}

export function nextKeepsakeBatchIndex(items, removedIndex) {
  if (!Array.isArray(items) || !items.length) return 0;
  return Math.max(0, Math.min(Number(removedIndex) || 0, items.length - 1));
}

export function keepsakeMediaSources(item, mode = "list") {
  if (!item || typeof item !== "object") throw new TypeError("Keepsake media is required");
  if (mode === "original") {
    const imagePath = attachmentPath(item.originalPath);
    if (!imagePath) throw new Error("原图不可用");
    return { imagePath };
  }
  if (mode === "edit") {
    const imagePath = attachmentPath(item.editPath);
    const alphaMaskPath = attachmentPath(item.alphaMaskPath);
    if (!imagePath || !alphaMaskPath) throw new Error("编辑派生图或蒙版不可用");
    return { imagePath, alphaMaskPath };
  }
  if (mode === "detail") {
    const imagePath = attachmentPath(item.displayPath) || attachmentPath(item.cutoutPath);
    if (!imagePath) throw new Error("详情图不可用");
    return { imagePath, backgroundPath: attachmentPath(item.editPath) };
  }
  if (!["list", "home"].includes(mode)) throw new TypeError(`Unsupported keepsake media mode: ${mode}`);
  const imagePath = attachmentPath(item.thumbPath) || attachmentPath(item.cutoutPath);
  if (!imagePath) throw new Error("缩略图不可用");
  return { imagePath, backgroundPath: attachmentPath(item.editPath) };
}

export function keepsakeUploadPayload({ image, alphaMask }) {
  if (typeof image !== "string" || !image || typeof alphaMask !== "string" || !alphaMask) {
    throw new TypeError("Original image and alpha mask are required");
  }
  return { purpose: "keepsake", image, alphaMask };
}

export async function uploadKeepsakeMedia({ request, image, alphaMask, idempotencyKey }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new TypeError("An idempotency key is required");
  const result = await request("/api/images/upload", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(keepsakeUploadPayload({ image, alphaMask }))
  });
  const paths = {};
  for (const key of ["originalPath", "thumbPath", "displayPath", "editPath", "alphaMaskPath"]) {
    paths[key] = attachmentPath(result?.[key]);
    if (!paths[key]) throw new Error(`服务端未返回 ${key}`);
  }
  const attachmentPaths = Array.isArray(result?.attachmentPaths)
    ? result.attachmentPaths.map(attachmentPath).filter(Boolean)
    : Object.values(paths);
  if (attachmentPaths.length !== 5) throw new Error("服务端未返回完整的小物媒体路径");
  return { ...paths, attachmentPaths };
}

export async function discardKeepsakeMedia({ request, attachmentPaths, uploadRequestId }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  if (typeof uploadRequestId !== "string" || !uploadRequestId.trim()) throw new TypeError("An idempotency key is required");
  const paths = [...new Set((Array.isArray(attachmentPaths) ? attachmentPaths : []).map(attachmentPath).filter(Boolean))];
  if (!paths.length || paths.length > 5) throw new TypeError("Keepsake attachment paths are required");
  return request("/api/images/discard", {
    method: "POST",
    body: JSON.stringify({ purpose: "keepsake", attachmentPaths: paths, uploadRequestId })
  });
}
