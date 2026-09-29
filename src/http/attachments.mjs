export function createAttachmentHttp({
  attachments,
  uploadOriginals = null,
  discardUploads = null,
  bodyJson,
  sendJson,
  uploadBodyMaxBytes,
  uploadImageMaxBytes,
  contentType,
  onMissing
}) {
  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/images/upload") {
      const input = await bodyJson(req, uploadBodyMaxBytes), images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
      try {
        if (input.purpose === "keepsake") {
          if (typeof input.image !== "string" || !input.image || typeof input.alphaMask !== "string" || !input.alphaMask) {
            sendJson(res, 400, { error: "请同时提供小物原图和 Alpha 蒙版" });
            return true;
          }
          const { paths } = await attachments.saveKeepsakeSet({
            image: input.image,
            alphaMask: input.alphaMask,
            maxBytes: uploadImageMaxBytes
          });
          sendJson(res, 201, { attachmentPath: paths.originalPath, ...paths });
          return true;
        }
        if (input.purpose && input.purpose !== "original") {
          sendJson(res, 400, { error: "图片上传用途无效", code: "INVALID_IMAGE_PURPOSE" });
          return true;
        }
        const maxImages = input.purpose === "original" ? 2 : 1;
        const { attachmentPaths } = input.purpose === "original" && typeof uploadOriginals === "function"
          ? await uploadOriginals(req, images)
          : await attachments.save(images, maxImages, { maxBytes: uploadImageMaxBytes });
        sendJson(res, 201, { attachmentPath: attachmentPaths[0], attachmentPaths });
      } catch (error) {
        if (error.code === "IDEMPOTENCY_KEY_REUSED") sendJson(res, 409, { error: "同一幂等键不能用于不同图片", code: error.code });
        else if (error.statusCode) sendJson(res, error.statusCode, { error: error.message, code: error.code });
        else if (/请选择|图片|大小/.test(error.message || "")) sendJson(res, 400, { error: error.message });
        else throw error;
      }
    } else if (req.method === "POST" && url.pathname === "/api/images/discard" && typeof discardUploads === "function") {
      const input = await bodyJson(req);
      const result = await discardUploads(input.attachmentPaths, input.uploadRequestId);
      sendJson(res, 200, result);
    } else if (url.pathname.startsWith("/attachments/")) {
      if (!["GET", "HEAD"].includes(req.method || "GET")) {
        sendJson(res, 405, { error: "Method not allowed" });
      } else {
        const name = url.pathname.slice("/attachments/".length);
        if (!/^[\w.-]+$/.test(name)) sendJson(res, 403, { error: "Forbidden" });
        else {
          let data;
          try {
            data = await attachments.read(url.pathname);
          } catch (error) {
            const missing = ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404;
            if (missing && await onMissing?.(req, res, url)) return true;
            throw error;
          }
          res.writeHead(200, { "content-type": contentType(name), "cache-control": "private, no-store" });
          res.end(req.method === "HEAD" ? undefined : data);
        }
      }
    } else return false;
    return true;
  }
  return { handle };
}
