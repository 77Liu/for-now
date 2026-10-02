import crypto from "node:crypto";
import { safeText, safeIso } from "../../shared/validation/index.mjs";
import { redact } from "../../shared/observability/index.mjs";
import { promptCatalogMetadata } from "../../shared/prompts/index.mjs";
import { llmSettingsForScene } from "./settings.mjs";
import { systemPrompt, systemPromptForScene } from "./prompts.mjs";

function aiErrorDetails(error, httpStatus = 0) {
  const message = safeText(error?.message || "AI 调用失败", 1000);
  if (error?.cancelled) return { category: "cancelled", code: "AI_TASK_CANCELLED", message };
  if (error?.name === "AbortError") return { category: "timeout", code: "TIMEOUT", message };
  if (error?.code === "EMPTY_DEEPSEEK_CONTENT") return { category: "empty_response", code: error.code, message };
  if (["LENGTH_LIMIT", "CONTENT_FILTER", "INCOMPLETE_STREAM", "INVALID_STREAM"].includes(error?.code)) return { category: error.code.toLowerCase(), code: error.code, message };
  if (httpStatus >= 400) return { category: "provider_http", code: safeText(error?.code, 120) || `HTTP_${httpStatus}`, message };
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message)) return { category: "network", code: safeText(error?.code, 120), message };
  return { category: "unknown", code: safeText(error?.code, 120), message };
}

export function createAiGenerator({ readSettings, provider, getContext, reserveAttempt, gate, audit, now = () => new Date().toISOString(), createId = () => crypto.randomUUID() }) {
  return async function generate(prompt, { imagePath = null, imagePaths = null, history = [], settingsOverride = null, scene = "thoughtAnswer", json = false, systemPrompt: requestedSystemPrompt = "", onDelta = null, captureReasoning = false, contextReceipt = null, maxTokens = 16000, retryWithoutThinking = false, timeoutMs = 300000, signal = null, auditPrompt = true } = {}) {
    const settings = llmSettingsForScene(settingsOverride || await readSettings(), scene);
    if (!settings.apiKey) throw new Error("尚未配置 DeepSeek API 密钥，请先到“设置”中填写并保存");
    const effectiveSystemPrompt = systemPromptForScene(requestedSystemPrompt || systemPrompt(), scene, settings);
    const promptCatalog = promptCatalogMetadata();
    const visualPaths = [...(Array.isArray(imagePaths) ? imagePaths : []), ...(imagePath ? [imagePath] : [])];
    const imageInputs = await Promise.all(visualPaths.map(provider.imageInput));
    const imageAudit = imageInputs.map(item => item.audit);
    const userContent = imageInputs.length ? [{ type: "text", text: prompt }, ...imageInputs.map(item => item.content)] : prompt;
    const context = getContext() || {};
    const receipt = contextReceipt && typeof contextReceipt === "object" && !Array.isArray(contextReceipt)
      ? structuredClone(contextReceipt)
      : null;
    const auditText = value => auditPrompt
      ? audit.text(value)
      : { omitted: true, characters: String(value ?? "").length };
    const auditMessage = value => auditPrompt
      ? audit.message(value)
      : { role: safeText(value?.role, 20) || "unknown", omitted: true };
    if (context.secrets) context.secrets.push(settings.apiKey);
    const traceId = safeText(context.traceId, 128) || createId(), callGroupId = createId();
    const userId = safeText(context.user?.id, 100) || "local", endpointHost = provider.endpointHost;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const efforts = [settings.effort, ...(retryWithoutThinking && settings.effort !== "none" ? ["none"] : [])];
      for (let attempt = 0; attempt < efforts.length; attempt += 1) {
        await audit.recoverPending?.();
        const reservation = await reserveAttempt();
        const releaseQuota = typeof reservation?.release === "function" ? reservation.release : reservation;
        const commitQuota = typeof reservation?.commit === "function" ? reservation.commit : reservation;
        const usageReservation = {
          retain: typeof reservation?.retain === "function" ? entry => reservation.retain(entry) : () => {},
          commit: typeof commitQuota === "function" ? () => commitQuota() : () => {}
        };
        let releaseCapacity, providerStarted = false;
        try {
          releaseCapacity = await gate.acquire();
          const effort = efforts[attempt], createdAt = now(), startedMs = Date.now();
          const callId = createId(), model = visualPaths.length ? "deepseek-flash" : settings.model;
          const parameters = {
            model, thinking: { type: effort === "none" ? "disabled" : "enabled" }, reasoning_effort: effort,
            max_tokens: maxTokens, stream: Boolean(onDelta),
            ...(onDelta ? { stream_options: { include_usage: true } } : {}),
            ...(json ? { response_format: { type: "json_object" } } : {})
          };
          const messages = [{ role: "system", content: effectiveSystemPrompt }, ...history, { role: "user", content: userContent }];
          const requestChars = effectiveSystemPrompt.length + String(prompt).length + history.reduce((sum, message) => sum + (typeof message?.content === "string" ? message.content.length : 0), 0);
          await audit.start({
            id: callId, callId, callGroupId, traceId, actor: { userId }, provider: "deepseek",
            scene, startedAt: createdAt, attempt: attempt + 1, maxAttempts: efforts.length,
            request: {
              endpointHost,
              images: imageAudit,
              promptCatalog,
              systemPrompt: auditText(effectiveSystemPrompt),
              userPrompt: auditText(prompt),
              history: history.map(auditMessage),
              parameters,
              ...(receipt ? { contextReceipt: receipt } : {})
            }
          });
          let recorded = false;
          const finishAttempt = async ({ status, httpStatus = 0, usage = null, content = "", reasoningContent = "", finishReason = "", error = null, providerRequestId = "", modelReturned = "", providerCreatedAt = "", systemFingerprint = "", retryScheduled = false } = {}) => {
            if (recorded) return;
            recorded = true;
            const completedAt = now(), durationMs = Date.now() - startedMs;
            const failure = error ? aiErrorDetails(error, httpStatus) : { category: "", code: "", message: "" };
            const responseRequestId = safeText(providerRequestId, 200);
            const common = {
              callId, callGroupId, traceId, completedAt, durationMs, durationKnown: true, status, httpStatus,
              errorCategory: failure.category, errorCode: failure.code, providerRequestId: responseRequestId,
              modelReturned: safeText(modelReturned, 100), scene, tier: settings.tier, effort,
              attempt: attempt + 1, maxAttempts: efforts.length,
              retryReason: attempt ? "empty_response_without_thinking" : "", retryScheduled,
              stream: Boolean(onDelta), responseFormat: json ? "json_object" : "text", maxTokens,
              finishReason: safeText(finishReason, 80), modality: imageAudit.length ? "vision" : "text",
              imageCount: imageAudit.length, imageBytes: imageAudit.reduce((sum, image) => sum + image.bytes, 0),
              imageTypes: [...new Set(imageAudit.map(image => image.mimeType))],
              imageDimensions: imageAudit.map(({ width, height }) => ({ width, height })),
              historyMessageCount: history.length, requestChars,
              responseChars: String(content || "").length, reasoningChars: String(reasoningContent || "").length
            };
            await audit.recordDeepSeekAttempt({
              usage, usageMetadata: { ...common, model, createdAt },
              reservation: usageReservation,
              audit: {
                id: callId, callId, callGroupId, traceId, actor: { userId }, provider: "deepseek",
                scene, tier: settings.tier, attempt: attempt + 1, maxAttempts: efforts.length,
                retryReason: common.retryReason, retryScheduled, startedAt: createdAt, completedAt, durationMs, status,
                error: error ? { ...failure, message: audit.text(error.privateMessage || failure.message) } : null,
                request: {
                  endpointHost, modality: common.modality, images: imageAudit, promptCatalog,
                  systemPrompt: auditText(effectiveSystemPrompt), userPrompt: auditText(prompt),
                  history: history.map(auditMessage), messageCount: messages.length,
                  characterCounts: {
                    systemPrompt: effectiveSystemPrompt.length, userPrompt: String(prompt).length,
                    history: requestChars - effectiveSystemPrompt.length - String(prompt).length, total: requestChars
                  },
                  parameters,
                  ...(receipt ? { contextReceipt: receipt } : {})
                },
                response: {
                  httpStatus, providerRequestId: responseRequestId, model: safeText(modelReturned, 100),
                  createdAt: safeIso(providerCreatedAt), systemFingerprint: safeText(systemFingerprint, 200),
                  finishReason: safeText(finishReason, 80), content: audit.text(content), reasoningContent: audit.text(reasoningContent),
                  rawErrorBody: error?.rawErrorBody ? audit.text(redact(error.rawErrorBody, [settings.apiKey]).slice(0, 10000)) : ""
                }
              }
            });
          };
          try {
            providerStarted = true;
            const { httpStatus, ...result } = await provider.complete({ apiKey: settings.apiKey, parameters, messages, signal: controller.signal, onDelta });
            await finishAttempt({ status: "success", httpStatus, ...result });
            return captureReasoning ? (onDelta ? result : { content: result.content, reasoningContent: result.reasoningContent }) : result.content;
          } catch (error) {
            const retryScheduled = error.code === "EMPTY_DEEPSEEK_CONTENT" && attempt + 1 < efforts.length;
            const cancelledByCaller = error.name === "AbortError" && signal?.aborted && !timedOut;
            if (cancelledByCaller) error.cancelled = true;
            await finishAttempt({
              status: error.name === "AbortError" ? (cancelledByCaller ? "cancelled" : "timeout") : "failed", httpStatus: error.httpStatus,
              usage: error.usage, content: error.partialContent, reasoningContent: error.partialReasoningContent,
              finishReason: error.finishReason, error, providerRequestId: error.providerRequestId,
              modelReturned: error.modelReturned, providerCreatedAt: error.providerCreatedAt,
              systemFingerprint: error.systemFingerprint, retryScheduled
            });
            if (retryScheduled) continue;
            throw error;
          }
        } finally {
          releaseCapacity?.();
          if (!providerStarted) releaseQuota?.();
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        if (signal?.aborted && !timedOut) throw Object.assign(new Error("AI 任务已取消"), { code: "AI_TASK_CANCELLED" });
        throw new Error(`DeepSeek 请求超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`);
      }
      if (/fetch failed|ENOTFOUND|ECONN/i.test(error.message)) throw new Error("无法连接 DeepSeek API，请检查网络后重试");
      error.message = redact(error.message, [settings.apiKey]);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
