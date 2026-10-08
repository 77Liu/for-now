import crypto from "node:crypto";
import { Readable } from "node:stream";
import { evaluateByteRange } from "./byte-range.mjs";

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
  signDelivery = null,
  debugServerUrl = "",
  debugRunId = "pre-fix"
}) {
  const openRead = async resourcePath => {
    if (typeof attachments.openRead === "function") return attachments.openRead(resourcePath);
    const data = await attachments.read(resourcePath);
    return {
      bytes: data.length,
      etag: `"${crypto.createHash("sha256").update(data).digest("base64url")}"`,
      createReadStream({ start = 0, end = data.length - 1 } = {}) {
        return Readable.from([data.subarray(start, end + 1)]);
      }
    };
  };
  const isMissing = error => ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404;
  const closeSource = source => Promise.resolve(source?.close?.()).catch(() => {});
  const ifRangeMatches = (value, source) => {
    const input = String(value || "").trim();
    if (!input) return true;
    if (/^W\//i.test(input)) return false;
    if (input.startsWith("\"")) return Boolean(source.etag) && input === source.etag;
    const conditionTime = Date.parse(input);
    const modifiedTime = Date.parse(String(source.lastModified || ""));
    return Number.isFinite(conditionTime) && Number.isFinite(modifiedTime) && modifiedTime <= conditionTime;
  };

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
          const loadSource = async () => {
            try {
              return await openRead(url.pathname);
            } catch (error) {
              if (isMissing(error) && await onMissing?.(req, res, url)) return null;
              throw error;
            }
          };
          let source = await loadSource();
          if (!source) return true;
          let allowRange = req.method === "GET";
          let sourceChanged = false;
          let sourceFallback = false;
          while (source) {
            const total = source.bytes;
            if (!Number.isSafeInteger(total) || total < 0 || typeof source.createReadStream !== "function") {
              await closeSource(source);
              throw new Error("Attachment read source is invalid");
            }
            const responseContentType = contentType(name);
            // #region debug-point B-D:audio-read
            if (debugServerUrl && /\.(?:m4a|mp4|webm|ogg|wav)$/i.test(name)) fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:"login-audio-production",runId:debugRunId,hypothesisId:"B-D",location:"src/http/attachments.mjs:read",msg:"[DEBUG] Audio attachment served",data:{method:req.method,nameExtension:name.split(".").at(-1)?.toLowerCase(),contentType:responseContentType,bytes:total,rangeRequested:Boolean(req.headers.range),rangeHeader:String(req.headers.range||"").slice(0,100)},ts:Date.now()})}).catch(()=>{});
            // #endregion
            const headers = {
              "content-type": responseContentType,
              "cache-control": "private, no-store",
              "accept-ranges": "bytes",
              ...(source.etag ? { etag: source.etag } : {}),
              ...(source.lastModified ? { "last-modified": source.lastModified } : {})
            };
            let range = null;
            if (allowRange && req.headers.range && ifRangeMatches(req.headers["if-range"], source)) {
              const evaluated = evaluateByteRange(req.headers.range, total);
              if (evaluated.kind === "unsatisfiable") {
                await closeSource(source);
                res.writeHead(416, {
                  ...headers,
                  "content-range": `bytes */${total}`,
                  "content-length": "0"
                });
                res.end();
                return true;
              }
              if (evaluated.kind === "range") {
                range = { start: evaluated.start, end: evaluated.end };
              }
            }
            if (typeof signDelivery === "function" && !req.headers["if-range"] && !req.aborted && !res.destroyed) {
              let signed = null;
              try { signed = await signDelivery(url.pathname, { method: req.method, bytes: total }); }
              catch { /* A cloud signing failure keeps the existing authenticated proxy path. */ }
              if (signed?.url) {
                await closeSource(source);
                if (!req.aborted && !res.destroyed) {
                  res.writeHead(302, {
                    location: signed.url, "cache-control": "private, no-store",
                    "referrer-policy": "no-referrer", "content-length": "0"
                  });
                  res.end();
                }
                return true;
              }
            }
            const status = range ? 206 : 200;
            const length = range ? range.end - range.start + 1 : total;
            const responseHeaders = {
              ...headers,
              ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${total}` } : {}),
              "content-length": String(length)
            };
            if (req.method === "HEAD") {
              await closeSource(source);
              res.writeHead(200, { ...responseHeaders, "content-length": String(total) });
              res.end();
              return true;
            }
            let stream;
            try {
              stream = await source.createReadStream(range || {});
            } catch (error) {
              await closeSource(source);
              if (isMissing(error) && !sourceFallback && typeof source.fallback === "function") {
                sourceFallback = true;
                try {
                  source = await source.fallback();
                } catch (fallbackError) {
                  if (isMissing(fallbackError) && await onMissing?.(req, res, url)) return true;
                  throw fallbackError;
                }
                continue;
              }
              if (error?.code === "ATTACHMENT_SOURCE_CHANGED" && !sourceChanged) {
                sourceChanged = true;
                allowRange = false;
                source = await loadSource();
                if (!source) return true;
                continue;
              }
              if (isMissing(error) && await onMissing?.(req, res, url)) return true;
              throw error;
            }
            if (!stream || typeof stream.pipe !== "function" || typeof stream.destroy !== "function") {
              await closeSource(source);
              throw new Error("Attachment storage returned no readable stream");
            }
            if (req.aborted || res.destroyed) {
              stream.destroy();
              await closeSource(source);
              return true;
            }
            res.writeHead(status, responseHeaders);
            let completed = false;
            let released = false;
            const cleanup = () => {
              req.off("aborted", cancel);
              res.off("close", cancel);
            };
            const release = () => {
              if (released) return;
              released = true;
              cleanup();
              void closeSource(source);
            };
            const cancel = () => {
              if (!completed && !stream.destroyed) stream.destroy();
              release();
            };
            req.once("aborted", cancel);
            res.once("close", cancel);
            stream.once("end", () => {
              completed = true;
              release();
            });
            stream.once("close", release);
            stream.once("error", error => {
              completed = true;
              release();
              if (!res.destroyed) res.destroy(error);
            });
            stream.pipe(res);
            break;
          }
        }
      }
    } else return false;
    return true;
  }
  return { handle };
}
