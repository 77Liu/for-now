import { safeText } from "../../shared/validation/index.mjs";
import { signVolcengineRequest } from "./volcengine-signing.mjs";

const DEFAULT_ENDPOINT = "https://visual.volcengineapi.com";
const MAX_ENCODED_BODY_BYTES = 8 * 1024 * 1024;
const SUCCESS_CODE = 10000;

const failure = (message, code, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

function publicError(error) {
  const details = `${error?.code || ""} ${error?.message || ""}`;
  if (/VISUAL_NOT_CONFIGURED/.test(details)) return failure("火山视觉服务尚未配置，请联系管理员", "VISUAL_NOT_CONFIGURED", 503);
  if (/AbortError|timeout|timed out/i.test(details)) return failure("火山视觉服务响应超时，请稍后重试", "VISUAL_TIMEOUT", 504);
  if (/401|403|50400|Access denied|authentication/i.test(details)) return failure("火山视觉服务鉴权失败，请检查访问密钥和服务授权", "VISUAL_AUTH_FAILED", 503);
  if (/429|RequestLimit|FlowLimit|QPS/i.test(details)) return failure("火山视觉服务请求较多，请稍后重试", "VISUAL_RATE_LIMITED", 503);
  if (/文件|图片|PDF|8 MB|格式/.test(error?.message || "")) return error;
  return failure("火山视觉服务暂时不可用，请稍后重试", "VISUAL_UNAVAILABLE", 503);
}

function encodedBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== "") body.set(key, String(value));
  }
  const serialized = body.toString();
  if (Buffer.byteLength(serialized) > MAX_ENCODED_BODY_BYTES) {
    throw failure("图片或文档编码后不得超过 8 MB", "VISUAL_INPUT_TOO_LARGE", 413);
  }
  return serialized;
}

function parseDataUrl(value, { document = false } = {}) {
  const pattern = document
    ? /^data:(application\/pdf|image\/(?:png|jpeg|bmp|webp));base64,([A-Za-z0-9+/=\s]+)$/i
    : /^data:(image\/(?:png|jpeg|bmp|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
  const match = pattern.exec(String(value || ""));
  if (!match) {
    throw failure(
      document ? "请选择 PDF、PNG、JPEG、BMP 或 WebP 文件" : "请选择 PNG、JPEG、BMP 或 WebP 图片",
      document ? "INVALID_DOCUMENT" : "INVALID_IMAGE",
      400
    );
  }
  const data = Buffer.from(match[2], "base64");
  if (!data.length) throw failure(document ? "文档内容为空" : "图片内容为空", "EMPTY_VISUAL_INPUT", 400);
  return { data, mimeType: match[1].toLowerCase() };
}

function normalizedProviderError(response, result, action) {
  const code = Number(result?.code ?? result?.status ?? 0);
  const error = failure(`火山视觉 ${action} 请求失败`, safeText(code || `HTTP_${response.status}`, 80));
  error.httpStatus = response.status;
  error.privateMessage = safeText(result?.message || result?.ResponseMetadata?.Error?.Message, 2000);
  error.providerRequestId = safeText(result?.request_id || result?.ResponseMetadata?.RequestId, 200);
  return error;
}

export function createVolcengineVisionTransport({
  accessKeyId = "",
  secretAccessKey = "",
  sessionToken = "",
  endpoint = DEFAULT_ENDPOINT,
  region = "cn-north-1",
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 30_000
} = {}) {
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); }
  catch { throw new Error("火山视觉服务地址无效"); }
  const configured = Boolean(accessKeyId && secretAccessKey);

  async function invoke(action, version, fields, { signal } = {}) {
    if (!configured) throw failure("火山视觉服务尚未配置", "VISUAL_NOT_CONFIGURED", 503);
    const body = encodedBody(fields);
    const signed = signVolcengineRequest({
      method: "POST",
      pathname: endpointUrl.pathname || "/",
      params: { Action: action, Version: version },
      body,
      headers: {
        host: endpointUrl.host,
        "content-type": "application/x-www-form-urlencoded"
      },
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
      service: "cv",
      date: now()
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response, raw = "", result = {};
    try {
      const url = new URL(endpointUrl);
      url.search = signed.query;
      response = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: signed.headers,
        body
      });
      raw = await response.text();
      try { result = JSON.parse(raw); } catch {}
      if (!response.ok || Number(result?.code ?? result?.status) !== SUCCESS_CODE) {
        throw normalizedProviderError(response, result, action);
      }
      return {
        data: result.data || {},
        providerRequestId: safeText(result.request_id || response.headers.get("x-request-id"), 200)
      };
    } catch (error) {
      error.httpStatus ||= response?.status || 0;
      error.privateMessage ||= safeText(raw, 2000);
      throw publicError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    configured,
    async recognizeText({ data, signal } = {}) {
      if (!Buffer.isBuffer(data) || !data.length) throw failure("图片内容为空", "EMPTY_VISUAL_INPUT", 400);
      const result = await invoke("OCRNormal", "2020-08-26", {
        image_base64: data.toString("base64"),
        mode: "text_block",
        filter_thresh: "80"
      }, { signal });
      const lines = Array.isArray(result.data.line_texts)
        ? result.data.line_texts.map(value => safeText(value, 5000)).filter(Boolean)
        : [];
      return {
        provider: "volcengine-ocr",
        text: lines.join("\n"),
        lines,
        lineRects: Array.isArray(result.data.line_rects) ? result.data.line_rects : [],
        lineProbabilities: Array.isArray(result.data.line_probs) ? result.data.line_probs : [],
        providerRequestId: result.providerRequestId
      };
    },
    async parseDocument({ data, mimeType = "application/pdf", signal } = {}) {
      if (!Buffer.isBuffer(data) || !data.length) throw failure("文档内容为空", "EMPTY_VISUAL_INPUT", 400);
      const fileType = mimeType === "application/pdf" ? "pdf" : "image";
      const result = await invoke("OCRPdf", "2021-08-23", {
        image_base64: data.toString("base64"),
        version: "v3",
        file_type: fileType,
        page_start: 0,
        page_num: 16,
        table_mode: "markdown",
        filter_header: "true"
      }, { signal });
      let detail = result.data.detail;
      if (typeof detail === "string") {
        try { detail = JSON.parse(detail); } catch { detail = []; }
      }
      return {
        provider: "volcengine-document",
        markdown: safeText(result.data.markdown, 1_000_000),
        detail: Array.isArray(detail) ? detail : [],
        providerRequestId: result.providerRequestId
      };
    },
    parseImageDataUrl(value) {
      return parseDataUrl(value);
    },
    parseDocumentDataUrl(value) {
      return parseDataUrl(value, { document: true });
    }
  };
}
