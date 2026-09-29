const attachmentPath = value => (
  typeof value === "string" && /^\/attachments\/[\w.-]+$/.test(value) ? value : ""
);

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
    return { imagePath };
  }
  if (!["list", "home"].includes(mode)) throw new TypeError(`Unsupported keepsake media mode: ${mode}`);
  const imagePath = attachmentPath(item.thumbPath) || attachmentPath(item.cutoutPath);
  if (!imagePath) throw new Error("缩略图不可用");
  return { imagePath };
}

export function keepsakeUploadPayload({ image, alphaMask }) {
  if (typeof image !== "string" || !image || typeof alphaMask !== "string" || !alphaMask) {
    throw new TypeError("Original image and alpha mask are required");
  }
  return { purpose: "keepsake", image, alphaMask };
}

export async function uploadKeepsakeMedia({ request, image, alphaMask }) {
  if (typeof request !== "function") throw new TypeError("A request function is required");
  const result = await request("/api/images/upload", {
    method: "POST",
    body: JSON.stringify(keepsakeUploadPayload({ image, alphaMask }))
  });
  const paths = {};
  for (const key of ["originalPath", "thumbPath", "displayPath", "editPath", "alphaMaskPath"]) {
    paths[key] = attachmentPath(result?.[key]);
    if (!paths[key]) throw new Error(`服务端未返回 ${key}`);
  }
  return paths;
}
