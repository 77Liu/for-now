export function createAttachmentHttp({
  attachments,
  uploadOriginals = null,
  uploadKeepsake = null,
  discardUploads = null,
  uploadAudio = null,
  discardAudio = null,
  bodyJson,
  sendJson,
  uploadBodyMaxBytes,
  uploadImageMaxBytes,
  contentType,
  onMissing,
  debugServerUrl = "",
  debugRunId = "pre-fix"
}) {
  function byteRange(value, total) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || "").trim());
    if (!match || (!match[1] && !match[2]) || total < 1) return null;
    if (!match[1]) {
      const length = Number(match[2]);
      if (!Number.isSafeInteger(length) || length < 1) return null;
      return { start: Math.max(0, total - length), end: total - 1 };
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= total || requestedEnd < start) return null;
    return { start, end: Math.min(requestedEnd, total - 1) };
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/images/upload") {
      const input = await bodyJson(req, uploadBodyMaxBytes), images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
      try {
        if (input.purpose === "keepsake") {
          if (typeof input.image !== "string" || !input.image || typeof input.alphaMask !== "string" || !input.alphaMask) {
            sendJson(res, 400, { error: "请同时提供小物原图和 Alpha 蒙版" });
            return true;
          }
          const result = typeof uploadKeepsake === "function"
            ? await uploadKeepsake(req, input)
            : await (attachments.saveKeepsakeSources || attachments.saveKeepsakeSet)({
                image: input.image,
                alphaMask: input.alphaMask,
                maxBytes: uploadImageMaxBytes
              });
          const paths = result.paths || result;
          sendJson(res, result.duplicate ? 200 : 201, {
            attachmentPath: paths.originalPath,
            attachmentPaths: result.attachmentPaths || Object.values(paths),
            ...paths,
            ...(result.duplicate ? { duplicate: true } : {})
          });
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
    } else if (req.method === "POST" && url.pathname === "/api/audio/upload" && typeof uploadAudio === "function") {
      try {
        const input = await bodyJson(req, uploadBodyMaxBytes);
        sendJson(res, 201, await uploadAudio(req, input));
      } catch (error) {
        if (error.code === "IDEMPOTENCY_KEY_REUSED") sendJson(res, 409, { error: "同一幂等键不能用于不同音频", code: error.code });
        else if (error.statusCode) sendJson(res, error.statusCode, { error: error.message, code: error.code });
        else if (/音频|录音|M4A|WebM|Ogg|WAV/.test(error.message || "")) sendJson(res, 400, { error: error.message, code: "INVALID_AUDIO" });
        else throw error;
      }
    } else if (req.method === "POST" && url.pathname === "/api/images/discard" && typeof discardUploads === "function") {
      const input = await bodyJson(req);
      const scope = input.purpose === "keepsake" ? "attachments.uploadKeepsake" : "attachments.uploadOriginals";
      const result = await discardUploads(input.attachmentPaths, input.uploadRequestId, scope);
      sendJson(res, 200, result);
    } else if (req.method === "POST" && url.pathname === "/api/audio/discard" && typeof discardAudio === "function") {
      const input = await bodyJson(req);
      const result = await discardAudio(input.attachmentPath, input.uploadRequestId);
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
          const responseContentType = contentType(name);
          // #region debug-point B-D:audio-read
          if (debugServerUrl && /\.(?:m4a|mp4|webm|ogg|wav)$/i.test(name)) fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:"login-audio-production",runId:debugRunId,hypothesisId:"B-D",location:"src/http/attachments.mjs:read",msg:"[DEBUG] Audio attachment served",data:{method:req.method,nameExtension:name.split(".").at(-1)?.toLowerCase(),contentType:responseContentType,bytes:data.length,rangeRequested:Boolean(req.headers.range),rangeHeader:String(req.headers.range||"").slice(0,100)},ts:Date.now()})}).catch(()=>{});
          // #endregion
          const headers = {
            "content-type": responseContentType,
            "cache-control": "private, no-store",
            "accept-ranges": "bytes"
          };
          if (req.headers.range) {
            const range = byteRange(req.headers.range, data.length);
            if (!range) {
              res.writeHead(416, { ...headers, "content-range": `bytes */${data.length}`, "content-length": "0" });
              res.end();
              return true;
            }
            const body = data.subarray(range.start, range.end + 1);
            res.writeHead(206, {
              ...headers,
              "content-range": `bytes ${range.start}-${range.end}/${data.length}`,
              "content-length": String(body.length)
            });
            res.end(req.method === "HEAD" ? undefined : body);
          } else {
            res.writeHead(200, { ...headers, "content-length": String(data.length) });
            res.end(req.method === "HEAD" ? undefined : data);
          }
        }
      }
    } else return false;
    return true;
  }
  return { handle };
}
