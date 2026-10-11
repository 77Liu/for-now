import path from "node:path";
import { cleanupTemporaryFiles } from "../../shared/attachments/index.mjs";
import { errorMetadata } from "../../shared/observability/index.mjs";
import { safeText } from "../../shared/validation/index.mjs";
import { systemPrompt } from "../../modules/ai/index.mjs";
import { createNotificationService } from "../../modules/notifications/index.mjs";
import {
  activeTaskForInput,
  createTaskLifecycle,
  publicAiTask
} from "../../modules/tasks/index.mjs";
import {
  createThoughtTaskTarget,
  stripThoughtAnswerLead
} from "../../modules/thoughts/index.mjs";
import { createAiTaskTargets } from "../ai-task-targets.mjs";
import { createBackgroundAi } from "../background-ai.mjs";
import { userModelRequiresCoreReady } from "../user-model.mjs";
import { parseVerifiedAnswer } from "../answer-citations.mjs";

const taskFailure = (message, statusCode, code) => Object.assign(
  new Error(message),
  { statusCode, code }
);

export async function enqueueContentImageUnderstanding(backgroundAi, work) {
  if (!backgroundAi) throw new Error("Content background runtime is not initialized");
  const created = await backgroundAi.enqueue({
    kind: "contentImageUnderstanding",
    resourceType: work.taskResourceType,
    targetId: work.taskTargetId,
    subtargetId: work.taskSubtargetId,
    inputVersion: work.inputVersion,
    payload: {
      targetType: work.targetType,
      targetId: work.targetId,
      attachmentPaths: work.attachmentPaths
    },
    clientRequestId: work.clientRequestId
  });
  if (created.unsupported) {
    throw taskFailure("不支持这种后台任务", 400, "UNSUPPORTED_AI_TASK");
  }
  if (created.missing) {
    throw taskFailure(
      "图片原文目标不存在或已经变化",
      404,
      "CONTENT_ATTACHMENT_TARGET_NOT_FOUND"
    );
  }
  if (created.invalid) {
    throw taskFailure(
      "图片理解请求缺少幂等标识",
      400,
      "IDEMPOTENCY_KEY_REQUIRED"
    );
  }
  if (created.conflict) {
    throw taskFailure(
      "同一幂等键不能用于不同图片理解请求",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }
  if (created.versionConflict) {
    throw taskFailure("图片原文已变化，请刷新后重试", 409, "VERSION_CONFLICT");
  }
  return publicAiTask(created.task);
}

export function createContentBackground({
  repository,
  annotationService,
  contentAttachments,
  perception,
  recordCompressionTarget = null,
  getRecentTrend = () => null,
  mediaRuntime,
  getAccountId,
  backgroundContextKey,
  dispatchBackground,
  runDeepSeek,
  now,
  createId,
  hash,
  logEvent,
  debugServerUrl,
  debugRunId,
  debugFetch
}) {
  const taskTargets = createAiTaskTargets({
    thoughts: createThoughtTaskTarget({
      createId,
      now,
      stripThoughtAnswerLead
    }),
    annotations: annotationService,
    contentAttachments,
    perception,
    recordCompressionTarget,
    getRecentTrend,
    getAccountId,
    hash,
    now
  });
  const backgroundAi = createBackgroundAi({
    repository,
    tasks: createTaskLifecycle({ createId, now, hash }),
    notifications: createNotificationService({ createId, now }),
    now,
    targets: taskTargets,
    shouldWaitForModel: (store, input) => (
      // 已提交的补充问答必须等整理结果；未提交时，思绪回答走缺省模型上下文。
      [
        "thoughtAnswer",
        "followUpAnswer",
        "annotationShenji",
        "thoughtDraft",
        "thoughtPrompt",
        "journalAssist",
        "journalReflection",
        "chat",
        "analysis"
      ].includes(input?.kind)
      && userModelRequiresCoreReady(store, input?.kind)
    ),
    inspectIntent: taskTargets.inspectIntent,
    generate: async (work, { signal, isCurrent } = {}) => {
      if (work.preflightError) {
        throw Object.assign(new Error(work.preflightError.message), {
          code: work.preflightError.code || "AI_TASK_INPUT_INVALID",
          statusCode: 400
        });
      }
      if (work.kind === "captureTranscription") {
        if (typeof isCurrent === "function" && !await isCurrent()) {
          throw Object.assign(new Error("目标已变化，未调用外部模型"), {
            code: "AI_TASK_STALE"
          });
        }
        return mediaRuntime.transcribeCapture(work, { signal });
      }
      const imagePaths = work.attachmentPaths?.length
        ? await mediaRuntime.materializeAttachmentFiles(work.attachmentPaths)
        : [];
      try {
        if (typeof isCurrent === "function" && !await isCurrent()) {
          throw Object.assign(new Error("目标已变化，未调用外部模型"), {
            code: "AI_TASK_STALE"
          });
        }
        const result = await runDeepSeek(work.prompt, {
          scene: work.scene,
          systemPrompt: work.systemPrompt || systemPrompt(),
          captureReasoning: work.captureReasoning !== false,
          json: work.json === true,
          maxTokens: work.maxTokens || 16000,
          auditPrompt: work.auditPrompt !== false,
          contextReceipt: work.contextReceipt || null,
          imagePaths,
          isCurrent,
          signal
        });
        if (work.citationsEnabled && typeof isCurrent === "function" && !await isCurrent()) {
          throw Object.assign(new Error("目标或来源已变化，回答未写入"), {
            code: "AI_TASK_STALE"
          });
        }
        const verifiedAnswer = work.citationsEnabled
          ? parseVerifiedAnswer(result.content, work.citationSources)
          : null;
        return {
          ...result,
          ...(verifiedAnswer || {}),
          ...(work.scene === "contentImageUnderstanding" ? { model: "deepseek-flash" } : {})
        };
      } finally {
        await cleanupTemporaryFiles(imagePaths);
      }
    },
    contextKey: backgroundContextKey,
    now,
    dispatch: dispatchBackground,
    onError: (taskId, error) => logEvent("system", "ai_task.failed", {
      level: "error",
      taskId,
      error: errorMetadata(error)
    })
  });

  async function requestCaptureTranscription(capture, { force = false } = {}) {
    const { speechProvider } = mediaRuntime;
    if (!speechProvider.configured || !capture?.audio?.attachmentPath) return null;
    if (!speechProvider.supportedAsrMimeTypes.includes(capture.audio.mimeType)) {
      if (!force) return null;
      throw taskFailure(
        "当前 WebM 原件不能直接转写，请改用 M4A、Ogg 或 WAV",
        422,
        "ASR_UNSUPPORTED_AUDIO_FORMAT"
      );
    }
    const audio = {
      attachmentPath: safeText(capture.audio.attachmentPath, 300),
      mimeType: safeText(capture.audio.mimeType, 100),
      bytes: Math.max(0, Math.round(Number(capture.audio.bytes) || 0)),
      durationMs: Math.max(0, Math.round(Number(capture.audio.durationMs) || 0))
    };
    debugFetch(debugServerUrl, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "login-audio-production",
        runId: debugRunId,
        hypothesisId: "C-E",
        location: "src/app/content/background.mjs:requestCaptureTranscription",
        msg: "[DEBUG] Transcription input selected",
        data: {
          targetId: safeText(capture.id, 100),
          extension: path.extname(audio.attachmentPath),
          mimeType: audio.mimeType,
          bytes: audio.bytes,
          durationMs: audio.durationMs,
          force
        },
        ts: Date.now()
      })
    }).catch(() => {});
    const inputHash = hash(JSON.stringify({ targetId: capture.id, audio }));
    const active = activeTaskForInput((await repository.read()).aiTasks, {
      kind: "captureTranscription",
      targetId: capture.id,
      inputHash
    });
    if (active) return publicAiTask(active);
    const audioKey = hash(JSON.stringify(capture.audio)).slice(0, 24);
    const created = await backgroundAi.enqueue({
      kind: "captureTranscription",
      resourceType: "capture",
      targetId: capture.id,
      clientRequestId: force
        ? `capture-transcription:${capture.id}:${audioKey}:${createId()}`
        : `capture-transcription:${capture.id}:${audioKey}`
    });
    if (!created.task) {
      if (created.alreadyAnswered) return null;
      throw taskFailure(
        "语音转写任务无法创建",
        created.missing ? 404 : created.versionConflict ? 409 : 400,
        created.versionConflict
          ? "VERSION_CONFLICT"
          : "TRANSCRIPTION_TASK_REJECTED"
      );
    }
    return publicAiTask(created.task);
  }

  return { backgroundAi, requestCaptureTranscription };
}
