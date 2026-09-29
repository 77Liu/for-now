import { safeText, safeIso } from "../../shared/validation/index.mjs";
import { readImageFile } from "../../shared/attachments/index.mjs";

export async function deepSeekImageInput(file, index) {
  const { data, mimeType, audit } = await readImageFile(file, index);
  return {
    content: { type: "image_url", image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` } },
    audit
  };
}

async function readDeepSeekStream(response, onDelta) {
  if (!response.body) throw new Error("DeepSeek 未返回可读取的流");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", reasoningContent = "", finishReason = "", usage = null, finished = false;
  let providerRequestId = safeText(response.headers.get("x-request-id") || response.headers.get("request-id"), 200);
  let modelReturned = "", providerCreatedAt = "", systemFingerprint = "";
  const consumeLine = line => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.startsWith("data:")) return;
    const payload = normalized.slice(5).trim();
    if (!payload || payload === "[DONE]") { if (payload === "[DONE]") finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { throw Object.assign(new Error("DeepSeek 流式数据格式错误"), { code: "INVALID_STREAM" }); }
    if (!chunk || typeof chunk !== "object") throw Object.assign(new Error("DeepSeek 流式数据格式错误"), { code: "INVALID_STREAM" });
    if (chunk.error) {
      throw Object.assign(new Error("DeepSeek 流式请求失败"), {
        code: safeText(chunk.error.code, 120), privateMessage: safeText(chunk.error.message, 10000)
      });
    }
    if (chunk.usage) usage = chunk.usage;
    providerRequestId ||= safeText(chunk.id, 200);
    modelReturned ||= safeText(chunk.model, 100);
    systemFingerprint ||= safeText(chunk.system_fingerprint, 200);
    if (!providerCreatedAt && Number.isFinite(chunk.created)) providerCreatedAt = safeIso(chunk.created * 1000);
    const choice = chunk.choices?.[0] || {}, delta = choice.delta || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoning) { reasoningContent += reasoning; onDelta({ type: "reasoning", delta: reasoning }); }
    if (typeof delta.content === "string" && delta.content) { content += delta.content; onDelta({ type: "content", delta: delta.content }); }
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (finished) break;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !finished) consumeLine(buffer);
    if (!finished && !finishReason) throw Object.assign(new Error("DeepSeek 回答中途断开，请重试"), { code: "INCOMPLETE_STREAM" });
    if (finishReason === "content_filter") throw Object.assign(new Error("DeepSeek 回答被内容过滤，未保存"), { code: "CONTENT_FILTER" });
    if (!content) throw Object.assign(new Error("DeepSeek 没有返回可显示的回答"), { code: "EMPTY_DEEPSEEK_CONTENT" });
    if (finishReason === "length") throw Object.assign(new Error("DeepSeek 回答达到长度上限，未保存，请重试"), { code: "LENGTH_LIMIT" });
    return { content, reasoningContent, usage, finishReason, providerRequestId, modelReturned, providerCreatedAt, systemFingerprint };
  } catch (error) {
    error.finishReason ||= finishReason;
    error.usage ||= usage;
    error.partialContent ||= content;
    error.partialReasoningContent ||= reasoningContent;
    error.providerRequestId ||= providerRequestId;
    error.modelReturned ||= modelReturned;
    error.providerCreatedAt ||= providerCreatedAt;
    error.systemFingerprint ||= systemFingerprint;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createDeepSeekTransport({ endpoint, fetchImpl = fetch }) {
  let endpointHost;
  try { endpointHost = new URL(endpoint).host; } catch { endpointHost = "invalid"; }
  return {
    endpointHost,
    imageInput: deepSeekImageInput,
    async complete({ apiKey, parameters, messages, signal, onDelta }) {
      let response = null, raw = "", result = null;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ ...parameters, messages })
        });
        const responseRequestId = safeText(response.headers.get("x-request-id") || response.headers.get("request-id"), 200);
        if (onDelta && response.ok) return {
          ...await readDeepSeekStream(response, onDelta), httpStatus: response.status
        };
        raw = await response.text();
        try { result = JSON.parse(raw); } catch { result = {}; }
        if (!result || typeof result !== "object") result = {};
        if (!response.ok) {
          throw Object.assign(new Error(`DeepSeek 请求失败（HTTP ${response.status}）`), {
            code: safeText(result.error?.code, 120), privateMessage: safeText(result.error?.message, 10000)
          });
        }
        const content = typeof result.choices?.[0]?.message?.content === "string" ? result.choices[0].message.content : "";
        const reasoningContent = String(result.choices?.[0]?.message?.reasoning_content || result.choices?.[0]?.message?.reasoning || "");
        const finishReason = safeText(result.choices?.[0]?.finish_reason, 80);
        if (!content || ["length", "content_filter"].includes(finishReason)) {
          throw Object.assign(new Error(finishReason === "content_filter" ? "DeepSeek 回答被内容过滤，未保存" : !content ? "DeepSeek 没有返回可显示的回答" : "DeepSeek 回答达到长度上限，未保存，请重试"), {
            code: finishReason === "content_filter" ? "CONTENT_FILTER" : !content ? "EMPTY_DEEPSEEK_CONTENT" : "LENGTH_LIMIT",
            partialContent: content, partialReasoningContent: reasoningContent
          });
        }
        return {
          content, reasoningContent, finishReason, usage: result.usage, httpStatus: response.status,
          providerRequestId: result.id || responseRequestId, modelReturned: result.model,
          providerCreatedAt: Number.isFinite(result.created) ? safeIso(result.created * 1000) : "",
          systemFingerprint: result.system_fingerprint
        };
      } catch (error) {
        error.httpStatus = response?.status || 0;
        error.rawErrorBody = raw;
        error.usage ||= result?.usage;
        error.finishReason ||= result?.choices?.[0]?.finish_reason;
        error.providerRequestId ||= safeText(result?.id || response?.headers.get("x-request-id") || response?.headers.get("request-id"), 200);
        error.modelReturned ||= result?.model;
        if (!error.providerCreatedAt && Number.isFinite(result?.created)) error.providerCreatedAt = safeIso(result.created * 1000);
        error.systemFingerprint ||= result?.system_fingerprint;
        throw error;
      }
    }
  };
}
