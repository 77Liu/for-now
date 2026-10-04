const attachmentPath = value => (
  typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value) ? value : ""
);

export const KEEPSAKE_BATCH_MAX_ITEMS = 8;
export {
  KEEPSAKE_ALPHA_THRESHOLD,
  KEEPSAKE_BOUNDS_PADDING_RATIO,
  keepsakePlacementCss,
  scanKeepsakeAlpha
} from "./placement.mjs";

export function applyKeepsakeImageCandidates(current = {}, baseline = {}, candidates = {}, {
  existingTags = []
} = {}) {
  const value = {
    title: String(current.title || ""),
    tags: String(current.tags || ""),
    note: String(current.note || "")
  };
  const applied = [];
  const apply = (field, candidate, eligible) => {
    if (!eligible || !candidate || candidate === value[field]
      || value[field] !== String(baseline[field] || "")) return;
    value[field] = candidate;
    applied.push(field);
  };
  apply("title", String(candidates.title || "").trim(), !String(baseline.title || "").trim());
  const knownByKey = new Map((Array.isArray(existingTags) ? existingTags : [])
    .map(tag => String(tag || "").trim())
    .filter(Boolean)
    .map(tag => [tag.toLocaleLowerCase("zh-CN"), tag]));
  const candidateTags = [...new Set((Array.isArray(candidates.tags) ? candidates.tags : [])
    .map(tag => knownByKey.get(String(tag || "").trim().toLocaleLowerCase("zh-CN")))
    .filter(Boolean))]
    .slice(0, 3)
    .join(" ");
  apply("tags", candidateTags, !String(baseline.tags || "").trim());
  apply("note", String(candidates.description || "").trim(), !String(baseline.note || "").trim());
  return { value, applied };
}

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
    note: "",
    tags: "",
    edgeExpansion: 8,
    backgroundOpacityPct: 15,
    source: "manual",
    alphaMask: "",
    status: "waiting",
    understandingState: "waiting",
    candidateRequestId: "",
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
  const originalPath = attachmentPath(item.originalPath);
  const publicPath = value => {
    const path = attachmentPath(value);
    return path && path !== originalPath ? path : "";
  };
  if (mode === "original") {
    const imagePath = originalPath;
    if (!imagePath) throw new Error("原图不可用");
    return { imagePath };
  }
  if (mode === "edit") {
    const imagePath = publicPath(item.editPath);
    const alphaMaskPath = publicPath(item.alphaMaskPath);
    if (!imagePath || !alphaMaskPath) throw new Error("编辑派生图或蒙版不可用");
    return { imagePath, alphaMaskPath };
  }
  const manifest = item.media && typeof item.media === "object" ? item.media : null;
  if (manifest && manifest.status !== "ready") throw new Error("展示派生图不可用");
  if (mode === "detail") {
    const imagePath = manifest
      ? publicPath(manifest.detail?.imagePath)
      : publicPath(item.displayPath) || publicPath(item.cutoutPath);
    if (!imagePath) throw new Error("详情图不可用");
    return {
      imagePath,
      backgroundPath: manifest
        ? publicPath(manifest.detail?.backgroundPath)
        : publicPath(item.editPath)
    };
  }
  if (!["list", "home"].includes(mode)) throw new TypeError(`Unsupported keepsake media mode: ${mode}`);
  const imagePath = manifest
    ? publicPath(manifest.list?.imagePath)
    : publicPath(item.thumbPath) || publicPath(item.cutoutPath);
  if (!imagePath) throw new Error("缩略图不可用");
  return {
    imagePath,
    backgroundPath: manifest
      ? publicPath(manifest.list?.backgroundPath)
      : publicPath(item.editPath)
  };
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
  for (const key of ["originalPath", "alphaMaskPath"]) {
    paths[key] = attachmentPath(result?.[key]);
    if (!paths[key]) throw new Error(`服务端未返回 ${key}`);
  }
  const attachmentPaths = Array.isArray(result?.attachmentPaths)
    ? result.attachmentPaths.map(attachmentPath).filter(Boolean)
    : Object.values(paths);
  if (attachmentPaths.length !== 2) throw new Error("服务端未返回完整的小物原图与蒙版路径");
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
