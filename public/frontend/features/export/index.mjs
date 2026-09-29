const MIME_TYPES = Object.freeze({
  json: "application/json;charset=utf-8",
  markdown: "text/markdown;charset=utf-8",
  md: "text/markdown;charset=utf-8"
});

function safeFilename(value, format) {
  const extension = format === "markdown" || format === "md" ? "md" : "json";
  const fallback = `for-now-export.${extension}`;
  const filename = String(value || fallback).replace(/[\u0000-\u001f/\\:]+/g, "-").trim();
  return filename || fallback;
}

export function createExportBlob(content, mimeType, BlobConstructor = globalThis.Blob) {
  if (typeof BlobConstructor !== "function") throw new TypeError("Blob is not available");
  return new BlobConstructor([String(content ?? "")], { type: String(mimeType || "application/octet-stream") });
}

export function createDownloadDescriptor(file, options = {}) {
  if (!file || typeof file !== "object") throw new TypeError("Export file is required");
  const format = file.format === "md" ? "markdown" : file.format;
  if (!["json", "markdown"].includes(format)) throw new TypeError(`Unsupported export format: ${file.format}`);
  const mimeType = file.mimeType || MIME_TYPES[format];
  const filename = safeFilename(file.filename, format);
  const blob = createExportBlob(file.content, mimeType, options.BlobConstructor);
  return Object.freeze({
    format,
    filename,
    download: filename,
    mimeType,
    size: blob.size,
    blob
  });
}

export function createDownloadDescriptors(files, options = {}) {
  const values = Array.isArray(files) ? files : Object.values(files || {});
  return values.map(file => createDownloadDescriptor(file, options));
}
