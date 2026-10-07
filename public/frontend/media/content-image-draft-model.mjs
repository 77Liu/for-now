export const CONTENT_IMAGE_DRAFT_KEYS = Object.freeze(
  ["capture", "thoughtRoot", "thoughtBlock", "comment"]
);

export function copyDraftContext(value) {
  return value == null ? value : structuredClone(value);
}

export function copyDraftItem(item) {
  return {
    ...item,
    ...(item.lastError ? { lastError: { ...item.lastError } } : {})
  };
}

function defaultImageDecoder(file, options) {
  if (typeof globalThis.createImageBitmap !== "function") {
    throw new Error("当前浏览器不支持图片旋转");
  }
  return globalThis.createImageBitmap(file, options);
}

function defaultCanvas(width, height) {
  if (typeof globalThis.OffscreenCanvas === "function") {
    return new globalThis.OffscreenCanvas(width, height);
  }
  const canvas = globalThis.document?.createElement?.("canvas");
  if (!canvas) throw new Error("当前浏览器不支持图片旋转");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultCanvasEncoder(canvas, options) {
  if (typeof canvas?.convertToBlob === "function") {
    return canvas.convertToBlob(options);
  }
  if (typeof canvas?.toBlob !== "function") {
    throw new Error("当前浏览器无法保存旋转后的图片");
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob
        ? resolve(blob)
        : reject(new Error("无法保存旋转后的图片")),
      options.type,
      options.quality
    );
  });
}

export async function rotateContentImageFile(file, {
  quarterTurns = 1,
  decodeImage = defaultImageDecoder,
  createCanvas = defaultCanvas,
  encodeCanvas = defaultCanvasEncoder,
  createFile = (parts, name, options) => new File(parts, name, options)
} = {}) {
  if (!file) throw new TypeError("A content image file is required");
  if (!Number.isSafeInteger(quarterTurns)) {
    throw new TypeError("Content image quarterTurns must be an integer");
  }
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return file;
  const image = await decodeImage(file, { imageOrientation: "from-image" });
  try {
    const width = Math.round(Number(image?.width));
    const height = Math.round(Number(image?.height));
    if (!Number.isSafeInteger(width) || width < 1
      || !Number.isSafeInteger(height) || height < 1) {
      throw new Error("无法读取图片尺寸");
    }
    const swapsDimensions = turns % 2 === 1;
    const canvas = createCanvas(
      swapsDimensions ? height : width,
      swapsDimensions ? width : height
    );
    const context = canvas?.getContext?.("2d");
    if (!context) throw new Error("当前浏览器不支持图片旋转");
    if (turns === 1) {
      context.translate(height, 0);
      context.rotate(Math.PI / 2);
    } else if (turns === 2) {
      context.translate(width, height);
      context.rotate(Math.PI);
    } else {
      context.translate(0, width);
      context.rotate(-Math.PI / 2);
    }
    context.drawImage(image, 0, 0);
    const requestedType = ["image/png", "image/jpeg", "image/webp"].includes(file.type)
      ? file.type
      : "image/png";
    const encoding = { type: requestedType };
    if (["image/jpeg", "image/webp"].includes(requestedType)) {
      encoding.quality = 0.92;
    }
    const blob = await encodeCanvas(canvas, encoding);
    if (!blob || !Number.isFinite(Number(blob.size)) || Number(blob.size) < 1) {
      throw new Error("旋转后的图片内容为空");
    }
    return createFile([blob], file.name || "image", {
      type: blob.type || requestedType,
      lastModified: Number(file.lastModified) || Date.now()
    });
  } finally {
    image?.close?.();
  }
}

export function emptyContentImageDraft() {
  return {
    items: [],
    uploadRequestId: "",
    context: null,
    revision: 0
  };
}

export function hasContentImageDraft(draft) {
  return Boolean(
    draft
    && (draft.items.length || draft.uploadRequestId || draft.context != null)
  );
}

export function contentImageLeaseIdentity(owner, item, fallbackRequestId = "") {
  const path = String(item?.uploadedPath || "");
  const requestId = String(item?.uploadRequestId || fallbackRequestId || "");
  return path && requestId ? JSON.stringify([owner, path, requestId]) : "";
}

export function isUncertainContentImageSubmission(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return !status || [408, 425, 429].includes(status) || status >= 500;
}
