import crypto from "node:crypto";
import { createExecutionControl, createAiAdmission } from "../../../.build/typescript/backend/modules/ai/execution-control.mjs";
import { resolveInvocationContract } from "../../../.build/typescript/backend/modules/ai/invocation-contracts.mjs";
import { safeText, safeIso } from "../../shared/validation/index.mjs";
import { redact } from "../../shared/observability/index.mjs";
import { promptCatalogMetadata } from "../../shared/prompts/index.mjs";
import { llmSettingsForScene, LLM_MODELS, LLM_EFFORTS } from "./settings.mjs";
import { systemPrompt, systemPromptForScene } from "./prompts.mjs";

function aiErrorDetails(error, httpStatus = 0) {
  const message = safeText(error?.message || "AI 调用失败", 1000);
  if (error?.cancelled) return { category: "cancelled", code: "AI_TASK_CANCELLED", message };
  if (["AI_QUEUE_TIMEOUT", "AI_REQUEST_TIMEOUT"].includes(error?.code)) return { category: "timeout", code: error.code, message };
  if (error?.name === "AbortError") return { category: "timeout", code: "TIMEOUT", message };
  if (error?.code === "EMPTY_DEEPSEEK_CONTENT") return { category: "empty_response", code: error.code, message };
  if (["LENGTH_LIMIT", "CONTENT_FILTER", "INCOMPLETE_STREAM", "INVALID_STREAM"].includes(error?.code)) return { category: error.code.toLowerCase(), code: error.code, message };
  if (httpStatus >= 400) return { category: "provider_http", code: safeText(error?.code, 120) || `HTTP_${httpStatus}`, message };
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message)) return { category: "network", code: safeText(error?.code, 120), message };
  return { category: "unknown", code: safeText(error?.code, 120), message };
}

const withoutSiteBudget = async (_details, execute) => execute({
  runStage: async (_stageId, operation) => operation({ recordUsage: () => false })
});

const textContentForBudget = content => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
};

export function conservativeDeepSeekInputTokenUpperBound(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const encoder = new TextEncoder();
  return Math.max(1, list.reduce((total, message) => {
    const textMessage = {
      role: typeof message?.role === "string" ? message.role : "unknown",
      content: textContentForBudget(message?.content)
    };
    // JSON escaping makes this byte count at least as large as the source text;
    // add generous room for provider chat-template and per-message tokens.
    return total + encoder.encode(JSON.stringify(textMessage)).length + 256;
  }, 0));
}

export function createAiGenerator({
  readSettings,
  provider,
  getContext,
  reserveAttempt,
  gate,
  sceneGates = {},
  aiQueue = null,
  assertAccountReady = () => {},
  audit,
  executeBudgetTask = withoutSiteBudget,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  const admit = aiQueue ? createAiAdmission(aiQueue) : () => () => {};
  return async function generate(prompt, {
    imagePath = null,
    imagePaths = null,
    history = [],
    settingsOverride = null,
    modelOverride = null,
    scene = "thoughtAnswer",
    json = false,
    systemPrompt: requestedSystemPrompt = "",
    onDelta = null,
    captureReasoning = false,
    contextReceipt = null,
    maxTokens = 16000,
    retryWithoutThinking = scene === "thoughtAnswer",
    timeoutMs = 300000,
    signal = null,
    isCurrent = async () => true,
    triggerType = undefined,
    budgetExecution = null,
    budgetStageIds = null
  } = {}) {
    const context = getContext() || {};
    const control = createExecutionControl({ signal: signal || context.signal, timeoutMs });
    const guard = () => { control.throwIfStopped(); assertAccountReady(); };
    let releaseAdmission, settings;
    try {
      guard();
      releaseAdmission = admit(safeText(context.user?.id, 100) || "local");
      settings = llmSettingsForScene(settingsOverride || await readSettings(), scene);
      guard();
      if (modelOverride !== null) {
        if (scene !== "importanceScoring" || !LLM_MODELS.includes(modelOverride.model)
          || !LLM_EFFORTS.includes(modelOverride.effort)) {
          throw Object.assign(new Error("重要性模型选择无效"), { code: "IMPORTANCE_MODEL_INVALID" });
        }
        if (settings.model !== modelOverride.model || settings.effort !== modelOverride.effort) {
          throw Object.assign(new Error("有效重要性模型配置已变化"), { code: "AI_TASK_STALE", statusCode: 409 });
        }
      }
      if (!settings.apiKey) throw new Error("尚未配置 DeepSeek API 密钥，请先到“设置”中填写并保存");
      const effectiveSystemPrompt = systemPromptForScene(requestedSystemPrompt || systemPrompt(), scene, settings);
      const promptCatalog = promptCatalogMetadata();
      const visualPaths = [...(Array.isArray(imagePaths) ? imagePaths : []), ...(imagePath ? [imagePath] : [])];
      const imageInputs = await Promise.all(visualPaths.map(provider.imageInput));
      guard();
      const imageAudit = imageInputs.map(item => item.audit);
      const userContent = imageInputs.length ? [{ type: "text", text: prompt }, ...imageInputs.map(item => item.content)] : prompt;
      const messages = [{ role: "system", content: effectiveSystemPrompt }, ...history, { role: "user", content: userContent }];
      const receipt = contextReceipt && typeof contextReceipt === "object" && !Array.isArray(contextReceipt)
        ? structuredClone(contextReceipt)
        : null;
      const auditText = value => audit.text(value);
      const auditMessage = value => audit.message(value);
      if (context.secrets) context.secrets.push(settings.apiKey);
      const traceId = safeText(context.traceId, 128) || createId(), callGroupId = createId();
      const userId = safeText(context.user?.id, 100) || "local", endpointHost = provider.endpointHost;
      const requestChars = effectiveSystemPrompt.length + String(prompt).length
        + history.reduce((sum, message) => sum + (typeof message?.content === "string" ? message.content.length : 0), 0);
      const efforts = [settings.effort, ...(retryWithoutThinking && settings.effort !== "none" ? ["none"] : [])];
      const model = visualPaths.length ? "deepseek-flash" : settings.model;
      const stageIds = Array.isArray(budgetStageIds) && budgetStageIds.length === efforts.length
        ? budgetStageIds.map(value => safeText(value, 100))
        : efforts.map((_, index) => `deepseek-attempt-${index + 1}`);
      const executeAttempts = async execution => {
        guard();
        if (!execution || typeof execution.runStage !== "function") {
          throw new TypeError("AI budget execution requires runStage()");
        }
        for (let attempt = 0; attempt < efforts.length; attempt += 1) {
          guard();
          await audit.recoverPending?.();
          guard();
          const reservation = await reserveAttempt();
          const releaseQuota = typeof reservation?.release === "function" ? reservation.release : reservation;
          const commitQuota = typeof reservation?.commit === "function" ? reservation.commit : reservation;
          let recordBudgetUsage = () => false;
          const usageReservation = {
            retain: entry => {
              reservation?.retain?.(entry);
              recordBudgetUsage(entry);
            },
            commit: typeof commitQuota === "function" ? () => commitQuota() : () => {}
          };
          let releaseSceneCapacity, releaseCapacity, providerStarted = false;
          try {
            guard();
            const queueDeadline = aiQueue?.enabled ? control.queueDeadline(aiQueue.maxQueueWaitMs) : Infinity;
            const waitOptions = aiQueue?.enabled ? { signal: control.signal, deadline: queueDeadline } : undefined;
            const sceneGate = sceneGates?.[scene];
            try {
              if (sceneGate?.acquire) releaseSceneCapacity = await sceneGate.acquire(waitOptions);
              guard();
              releaseCapacity = await gate.acquire(waitOptions);
            } catch (error) {
              if (error.code === "AI_QUEUE_TIMEOUT") control.expireQueue(queueDeadline);
              control.throwIfStopped();
              if (error.code === "AI_QUEUE_FULL" && aiQueue) error.retryAfterMs = aiQueue.overloadRetryAfterMs;
              throw error;
            } finally { control.endQueue(); }
            guard();
            const inputsCurrent = typeof isCurrent !== "function" || await isCurrent();
            guard();
            if (!inputsCurrent) {
              throw Object.assign(new Error("AI task inputs changed while waiting for provider capacity"), {
                code: "AI_TASK_STALE", statusCode: 409
              });
            }
            if (modelOverride !== null) {
              const effective = llmSettingsForScene(await readSettings(), scene);
              guard();
              if (effective.model !== modelOverride.model || effective.effort !== modelOverride.effort) {
                throw Object.assign(new Error("等待容量期间有效重要性模型配置已变化"), { code: "AI_TASK_STALE", statusCode: 409 });
              }
              settings.apiKey = effective.apiKey;
            }
            const effort = efforts[attempt], createdAt = now(), startedMs = Date.now();
            const callId = createId();
            const parameters = {
              model, thinking: { type: effort === "none" ? "disabled" : "enabled" }, reasoning_effort: effort,
              max_tokens: maxTokens, stream: Boolean(onDelta),
              ...(onDelta ? { stream_options: { include_usage: true } } : {}),
              ...(json ? { response_format: { type: "json_object" } } : {})
            };
            const invocationContract = resolveInvocationContract(scene, triggerType);
            const startedAudit = await audit.start({
              id: callId, callId, callGroupId, traceId, actor: { userId }, provider: "deepseek",
              service: "chat-completions", action: "complete", invocationContract,
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
                invoked: providerStarted,
                usage, usageMetadata: { ...common, model, createdAt },
                reservation: usageReservation,
                audit: {
                  ...startedAudit,
                  tier: settings.tier,
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
                  },
                }
              });
            };
            try {
              guard();
              return await execution.runStage(stageIds[attempt], async ({ recordUsage, dispatch }) => {
                recordBudgetUsage = typeof recordUsage === "function" ? recordUsage : () => false;
                guard();
                const stillCurrent = typeof isCurrent !== "function" || await isCurrent();
                guard();
                if (!stillCurrent) throw Object.assign(new Error("AI任务来源已变化"), { code: "AI_TASK_STALE", statusCode: 409 });
                // 最后的同步检查、设置已调用与真实provider入口之间不允许await。
                const invoke = () => { providerStarted = true; return provider.complete({ apiKey: settings.apiKey, parameters, messages, signal: control.signal, onDelta }); };
                const { httpStatus, ...result } = await (dispatch ? dispatch(invoke) : (guard(), invoke()));
                await finishAttempt({ status: "success", httpStatus, ...result });
                control.throwIfStopped();
                return captureReasoning ? (onDelta ? result : { content: result.content, reasoningContent: result.reasoningContent }) : result.content;
              }, { control, dispatchGuard: guard, canRetry: error => !control.reason && error.code === "EMPTY_DEEPSEEK_CONTENT" && attempt + 1 < efforts.length });
            } catch (failure) {
              const error = failure instanceof AggregateError ? failure : control.reason || failure;
              if (error !== failure && !(failure instanceof AggregateError)) {
                for (const key of ["usage", "httpStatus", "partialContent", "partialReasoningContent", "finishReason", "providerRequestId", "modelReturned", "providerCreatedAt", "systemFingerprint"]) {
                  if (failure[key] !== undefined) error[key] = failure[key];
                }
              }
              const retryScheduled = !control.reason && error.code === "EMPTY_DEEPSEEK_CONTENT" && attempt + 1 < efforts.length;
              if (!retryScheduled) control.terminate(error);
              const cancelledByCaller = error.code === "AI_TASK_CANCELLED";
              if (cancelledByCaller) error.cancelled = true;
              await finishAttempt({
                status: cancelledByCaller ? "cancelled" : (["AI_QUEUE_TIMEOUT", "AI_REQUEST_TIMEOUT"].includes(error.code) || error.name === "AbortError" ? "timeout" : "failed"), httpStatus: error.httpStatus,
                usage: error.usage, content: error.partialContent, reasoningContent: error.partialReasoningContent,
                finishReason: error.finishReason, error, providerRequestId: error.providerRequestId,
                modelReturned: error.modelReturned, providerCreatedAt: error.providerCreatedAt,
                systemFingerprint: error.systemFingerprint, retryScheduled
              });
              if (retryScheduled) { control.throwIfStopped(); continue; }
              throw error;
            }
          } catch (error) {
            control.terminate(error);
            throw error;
          } finally {
            releaseCapacity?.();
            releaseSceneCapacity?.();
            if (!providerStarted) releaseQuota?.();
          }
        }
      };
      const budgetDetails = {
        accountId: userId,
        taskId: callGroupId,
        provider: "deepseek",
        service: "chat-completions",
        scene,
        model,
        maxAttempts: efforts.length,
        maxInputTokens: scene === "recordCompression"
          ? conservativeDeepSeekInputTokenUpperBound(messages) + visualPaths.length * 128_000
          : Math.max(1, requestChars + visualPaths.length * 128_000),
        maxOutputTokens: Math.max(0, Math.round(Number(maxTokens) || 0))
      };
      return budgetExecution
        ? await executeAttempts(budgetExecution)
        : await executeBudgetTask(budgetDetails, executeAttempts, { control });
    } catch (failure) {
      control.terminate(failure);
      const error = failure instanceof AggregateError ? failure : control.reason || failure;
      if (/fetch failed|ENOTFOUND|ECONN/i.test(error.message)) throw new Error("无法连接 DeepSeek API，请检查网络后重试");
      error.message = redact(error.message, [settings?.apiKey]);
      throw error;
    } finally {
      control.dispose();
      releaseAdmission?.();
    }
  };
}
