import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeText } from "../validation/index.mjs";

export async function readImageFile(file, index = 0) {
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const data = await fs.readFile(file), dimensions = imageDimensions(data, mimeType);
  return {
    data, mimeType,
    audit: {
      index, mimeType, bytes: data.length, width: dimensions.width, height: dimensions.height,
      sha256: crypto.createHash("sha256").update(data).digest("hex")
    }
  };
}

export function cleanAttachmentPaths(value, maxImages = 2) {
  return (Array.isArray(value) ? value : []).map(item => safeText(item, 300)).filter(item => /^\/attachments\/[\w.-]+$/.test(item)).slice(0, maxImages);
}

export function imageDimensions(data, mimeType) {
  if (mimeType === "image/png" && data.length >= 24 && data.subarray(12, 16).toString("ascii") === "IHDR") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg" && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (mimeType === "image/webp" && data.length >= 30 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    const format = data.subarray(12, 16).toString("ascii");
    if (format === "VP8X") {
      return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (format === "VP8 ") {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (format === "VP8L" && data[20] === 0x2f) {
      return {
        width: 1 + (((data[22] & 0x3f) << 8) | data[21]),
        height: 1 + (((data[24] & 0x0f) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6))
      };
    }
  }
  return { width: 0, height: 0 };
}

export function decodeImages(images, { maxImages, maxBytes }) {
  if (!images.length || images.length > maxImages) throw new Error(maxImages > 1 ? `请选择 1～${maxImages} 张图片` : "请选择 1 张图片");
  let totalBytes = 0;
  return images.map(image => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(image || "");
    if (!match) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
    const data = Buffer.from(match[2], "base64");
    totalBytes += data.length;
    if (!data.length || data.length > maxBytes || totalBytes > maxBytes) {
      throw new Error(`单张及本次图片总大小均不得超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    const dimensions = imageDimensions(data, match[1]);
    if (!dimensions.width || !dimensions.height) throw new Error("图片内容与格式不匹配");
    const extension = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
    return { data, mimeType: match[1], extension };
  });
}
