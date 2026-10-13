/**
 * 火山极速版整文件HTTP识别：一次提交完整音频，一次返回最终结果。
 * 建立时间：2026-10-13
 * 状态：active
 * 边界：不分包、不轮询、不自动重试或回退；取消/失败不得返回成功正文。
 * @partial 验收未全部完成，单次请求和保存恢复已有实际成功证据。
 * @partialScope 逐字准确率、广泛口音/噪声样本及真机录音链尚未完整验收。
 * @partialVersion v0.5.14未发布候选。
 * @partialReason 历史原音与首尾样例已核对，但无完整人工逐字真值和全面设备样本。
 * @partialAuthorization Owner本聊天2026-10-14注释6授权保留并显式标注。
 * @partialUsage 本地默认整文件HTTP可用；不代表生产已切换或转写逐字保真已通过。
 */
import { randomUUID } from "node:crypto";

/**
 * 官方极速版整文件单请求端点，不使用WS分包或submit/query轮询。
 * @partial 验收未全部完成，单次请求和保存恢复已有实际成功证据。
 * @partialScope 逐字准确率、广泛口音/噪声样本及真机录音链尚未完整验收。
 * @partialVersion v0.5.14未发布候选。
 * @partialReason 历史原音与首尾样例已核对，但无完整人工逐字真值和全面设备样本。
 * @partialAuthorization Owner本聊天2026-10-14注释6授权保留并显式标注。
 * @partialUsage 本地默认整文件HTTP可用；不代表生产已切换或转写逐字保真已通过。
 * @since unreleased
 */
export const DEFAULT_VOLCENGINE_FILE_ASR_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const RESOURCE_ID = "volc.bigasr.auc_turbo";

type FileAsrOptions = Readonly<{
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}>;
type FileAsrInput = Readonly<{ audio: Buffer; signal?: AbortSignal; maxDurationMs?: number }>;
type FileAsrResult = Readonly<{
  provider: string;
  rawText: string;
  providerRequestId: string;
  durationMs: number;
  utterances: unknown[];
}>;
const failure = (message: string, code: string, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const cancelled = () => Object.assign(new Error("语音识别已取消"), { name: "AbortError" });

/**
 * 创建整文件HTTP识别边界；调用方先验证PCM参数及实际录音时长。
 * @param options 凭据、官方端点覆盖及本次请求的有界超时，不改变其他语音请求。
 * @returns 一次请求完整Base64音频的识别函数；返回完整文字、分句和provider实测毫秒。
 * @throws 请求失败、空答或计量字段无效时拒绝；用户取消保留AbortError。
 * @partial 验收未全部完成，单次请求和保存恢复已有实际成功证据。
 * @partialScope 逐字准确率、广泛口音/噪声样本及真机录音链尚未完整验收。
 * @partialVersion v0.5.14未发布候选。
 * @partialReason 历史原音与首尾样例已核对，但无完整人工逐字真值和全面设备样本。
 * @partialAuthorization Owner本聊天2026-10-14注释6授权保留并显式标注。
 * @partialUsage 本地默认整文件HTTP可用；不代表生产已切换或转写逐字保真已通过。
 * @since unreleased
 */
export function createVolcengineFileAsrTransport({
  apiKey, endpoint = DEFAULT_VOLCENGINE_FILE_ASR_ENDPOINT, fetchImpl = fetch, timeoutMs
}: FileAsrOptions): (input: FileAsrInput) => Promise<FileAsrResult> {
  return async ({ audio, signal, maxDurationMs }) => {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const requestId = randomUUID();
    let providerRequestId: string = requestId;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "X-Api-Key": apiKey,
          "X-Api-Resource-Id": RESOURCE_ID,
          "X-Api-Request-Id": requestId,
          "X-Api-Sequence": "-1"
        },
        body: JSON.stringify({
          user: { uid: "for-now" },
          audio: { data: audio.toString("base64") },
          request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: false, show_utterances: true }
        })
      });
      providerRequestId = (response.headers.get("x-tt-logid") || requestId).trim().slice(0, 200);
      const code = response.headers.get("x-api-status-code") || "ASR_FILE_MISSING_STATUS";
      if (!response.ok || code !== "20000000") {
        throw Object.assign(failure("火山整文件语音识别请求失败", response.ok ? code : `HTTP_${response.status}`), {
          httpStatus: response.status, providerRequestId, providerCode: code,
          privateMessage: (response.headers.get("x-api-message") || "").slice(0, 500)
        });
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw failure("整文件识别返回格式无效", "ASR_FILE_INVALID_RESPONSE");
      }
      if (!value || typeof value !== "object") throw failure("整文件识别返回格式无效", "ASR_FILE_INVALID_RESPONSE");
      const payload = value as { audio_info?: { duration?: unknown }; result?: { text?: unknown; utterances?: unknown } };
      const text = payload.result?.text;
      const durationMs = payload.audio_info?.duration;
      if (typeof text !== "string" || !text.trim()) throw failure("整文件识别没有返回文字", "ASR_FILE_EMPTY_TEXT");
      if (text.trim().length > 120000 || typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0
        || (maxDurationMs !== undefined && durationMs > maxDurationMs)
        || !Array.isArray(payload.result?.utterances)
        || payload.result.utterances.some(item => !item || typeof item !== "object"
          || typeof item.text !== "string" || !Number.isFinite(item.start_time) || !Number.isFinite(item.end_time)
          || item.start_time < 0 || item.end_time <= item.start_time || item.end_time > durationMs)) {
        throw failure("整文件识别返回的文字、分句或实测时长无效", "ASR_FILE_INVALID_RESPONSE");
      }
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw failure("火山整文件语音识别响应超时", "SPEECH_TIMEOUT", 504);
      return { provider: "volcengine-flash-asr", rawText: text.trim(), providerRequestId, durationMs: Math.round(durationMs), utterances: payload.result.utterances };
    } catch (error) {
      if (signal?.aborted) throw Object.assign(cancelled(), { providerRequestId });
      if (timedOut) throw Object.assign(failure("火山整文件语音识别响应超时", "SPEECH_TIMEOUT", 504), { providerRequestId });
      if (error instanceof Error) Object.assign(error, { providerRequestId });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}
