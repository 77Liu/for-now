import { safeText, recordVersion } from "../shared/validation/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { annotationExcerpt, annotationPrompt, shenjiSystemPrompt } from "../modules/annotations/index.mjs";
import { thoughtChainContext, thoughtTaskResult } from "../modules/thoughts/index.mjs";
import { personalContextProjection, personalContextReceiptFingerprint, thoughtAnswerPrompt } from "./personal-context.mjs";
import { annotationResource, annotationResourceSource, annotationResourceContext } from "./annotation-resources.mjs";

export function createAiTaskTargets({
  thoughts,
  annotations,
  contentAttachments = null,
  hash,
  now = () => new Date().toISOString()
}) {
  function captureTranscriptionWork(store, task) {
    const capture = store.captures?.find(item => item.id === task.targetId);
    if (!capture?.audio?.attachmentPath) return null;
    const inputVersion = 0;
    const audio = {
      attachmentPath: safeText(capture.audio.attachmentPath, 300),
      mimeType: safeText(capture.audio.mimeType, 100),
      bytes: Math.max(0, Math.round(Number(capture.audio.bytes) || 0)),
      durationMs: Math.max(0, Math.round(Number(capture.audio.durationMs) || 0))
    };
    const alreadyAnswered = capture.transcription?.status === "ready"
      && Boolean(safeText(capture.transcription?.rawText, 120_000));
    return {
      kind: "captureTranscription",
      capture,
      audio,
      alreadyAnswered,
      inputVersion,
      inputHash: hash(JSON.stringify({ targetId: capture.id, audio })),
      markQueued() {
        capture.transcription = {
          status: "queued",
          provider: "volcengine-seedasr-2.0",
          rawText: safeText(capture.transcription?.rawText, 120_000),
          polishedText: safeText(capture.transcription?.polishedText, 120_000),
          updatedAt: capture.transcription?.updatedAt || "",
          errorCode: ""
        };
      }
    };
  }

  function annotationWork(store, task) {
    const resourceType = safeText(task.resourceType, 40), root = annotationResource(store, resourceType, task.targetId);
    const annotation = root?.annotations?.find(item => item.id === task.subtargetId);
    if (!root || !annotation) return null;
    const source = annotationResourceSource(store, resourceType, root, annotation.targetKey);
    if (!source || !source.includes(annotation.quote)) return null;
    const message = safeText(task.payload?.message, 6000), excerpt = annotationExcerpt(source, annotation), context = annotationResourceContext(resourceType, root);
    const previousItems = (annotation.shenji || []).map(item => ({ id: item.id, message: item.message || "", answer: item.answer || "", reasoningContent: item.reasoningContent || "" }));
    const rootContext = resourceType === "thought" ? `<original_question>${root.content}</original_question>` : `<source_type>${context.label}</source_type>\n<source_title>${context.title}</source_title>`;
    const personalContext = personalContextProjection(store);
    const prompt = annotationPrompt({ personalContext: personalContext.prompt, rootContext, annotation, excerpt, previousItems, message });
    const inputHash = hash(JSON.stringify({
      resourceType, targetId: task.targetId, annotationId: annotation.id, targetKey: annotation.targetKey,
      source, quote: annotation.quote, text: annotation.text || "", previous: previousItems, message
    }));
    return {
      annotation,
      prompt,
      inputHash,
      inputVersion: recordVersion(root.version),
      scene: "annotationShenji",
      systemPrompt: shenjiSystemPrompt(),
      contextReceipt: personalContext.receipt,
      contextFingerprint: personalContextReceiptFingerprint(personalContext.receipt)
    };
  }

  function contentImageWork(store, task) {
    if (!contentAttachments) return null;
    const prepared = contentAttachments.prepareUnderstandingInStore(store, {
      targetType: task.payload?.targetType,
      targetId: task.payload?.targetId,
      attachmentPaths: task.payload?.attachmentPaths,
      inputVersion: task.inputVersion
    });
    if (!prepared.value) return null;
    const { located, ...work } = prepared.value;
    if (task.resourceType !== work.taskResourceType
      || task.targetId !== work.taskTargetId
      || (task.subtargetId || "") !== work.taskSubtargetId) return null;
    const targetLabel = {
      comment: "评论",
      capture: "捕念",
      thoughtRoot: "思绪问题",
      thoughtBlock: "思绪内容块"
    }[work.targetType] || "内容记录";
    const prompt = renderPrompt("content.image.understanding", {
      targetType: targetLabel,
      originalText: work.originalText || "（无文字原文）"
    });
    return {
      ...work,
      inputHash: hash(JSON.stringify({
        targetType: work.targetType,
        targetId: work.targetId,
        inputVersion: work.inputVersion,
        attachmentPaths: work.attachmentPaths,
        originalText: work.originalText
      })),
      prompt,
      scene: "contentImageUnderstanding"
    };
  }

  return {
    result(store, task) {
      if (task.kind === "captureTranscription") {
        return store.captures?.find(item => item.id === task.targetId) || null;
      }
      if (task.kind === "contentImageUnderstanding") {
        return contentAttachments?.taskResult(store, task) || null;
      }
      if (task.kind === "thoughtAnswer" || task.kind === "followUpAnswer") {
        return thoughtTaskResult(store.thoughts, task);
      }
      if (task.kind !== "annotationShenji") return null;
      return annotations.taskResult(annotationResource(store, task.resourceType, task.targetId), task);
    },
    prepare(store, task) {
      if (task.kind === "captureTranscription") return captureTranscriptionWork(store, task);
      if (task.kind === "contentImageUnderstanding") return contentImageWork(store, task);
      if (task.kind === "annotationShenji") return annotationWork(store, task);
      if (!["thoughtAnswer", "followUpAnswer"].includes(task.kind)) return null;
      const work = thoughts.inspect(store.thoughts, task);
      if (!work) return null;
      const { root, followUp, inputVersion, subtargetVersion } = work;
      const personalContext = personalContextProjection(store);
      if (task.kind === "thoughtAnswer") {
        const prompt = thoughtAnswerPrompt(personalContext.prompt, thoughtChainContext(store.thoughts, root));
        const attachmentPaths = Array.isArray(root.attachmentPaths) ? root.attachmentPaths : [];
        return {
          ...work,
          attachmentPaths,
          inputHash: hash(JSON.stringify({ targetId: root.id, inputVersion, attachmentPaths })),
          prompt,
          scene: "thoughtAnswer",
          contextReceipt: personalContext.receipt,
          contextFingerprint: personalContextReceiptFingerprint(personalContext.receipt)
        };
      }
      const chain = thoughtChainContext(store.thoughts, root, followUp.id);
      const prompt = thoughtAnswerPrompt(personalContext.prompt, chain, true);
      const inputHash = hash(JSON.stringify({ targetId: root.id, inputVersion, subtargetId: followUp.id, subtargetVersion, chain }));
      return {
        ...work,
        inputHash,
        prompt,
        scene: "followUpAnswer",
        contextReceipt: personalContext.receipt,
        contextFingerprint: personalContextReceiptFingerprint(personalContext.receipt)
      };
    },
    save(store, work, task, result) {
      if (task.kind === "captureTranscription") {
        const capture = store.captures?.find(item => item.id === task.targetId);
        if (!capture || capture.audio?.attachmentPath !== work.audio.attachmentPath) {
          throw Object.assign(new Error("语音原件已经变化，转写结果未写入"), { code: "TRANSCRIPTION_STALE" });
        }
        capture.transcription = {
          status: "ready",
          provider: safeText(result.provider, 100) || "volcengine-seedasr-2.0",
          rawText: safeText(result.rawText, 120_000),
          polishedText: safeText(result.polishedText, 120_000),
          updatedAt: safeText(result.updatedAt, 100) || now(),
          errorCode: safeText(result.polishErrorCode, 120)
        };
        capture.updatedAt = capture.transcription.updatedAt;
        capture.version = recordVersion(capture.version) + 1;
        return capture.id;
      }
      if (task.kind === "contentImageUnderstanding") {
        const saved = contentAttachments.saveUnderstandingInStore(store, {
          targetType: work.targetType,
          targetId: work.targetId,
          inputVersion: work.inputVersion,
          attachmentPaths: work.attachmentPaths,
          content: result.content,
          model: result.model || "deepseek-flash",
          sourceTaskId: task.id,
          clientRequestId: task.clientRequestId
        });
        if (!saved.value) {
          throw Object.assign(new Error(saved.error || "图片原文已变化，理解结果未写入"), {
            code: saved.code || "IMAGE_UNDERSTANDING_STALE"
          });
        }
        return saved.value.id;
      }
      if (task.kind === "thoughtAnswer") return thoughts.saveAnswer(store.thoughts, work, task, result);
      if (task.kind === "followUpAnswer") return thoughts.saveFollowUp(work, task, result);
      return annotations.saveTaskReply(work.annotation, task, result);
    },
    started(store, task) {
      if (task.kind !== "captureTranscription") return;
      const work = captureTranscriptionWork(store, task);
      if (work && task.inputHash === work.inputHash) work.capture.transcription.status = "transcribing";
    },
    fail(store, task, error) {
      if (task.kind !== "captureTranscription") return;
      const capture = store.captures?.find(item => item.id === task.targetId);
      if (!capture?.audio?.attachmentPath) return;
      capture.transcription = {
        status: "failed",
        provider: "volcengine-seedasr-2.0",
        rawText: safeText(capture.transcription?.rawText, 120_000),
        polishedText: safeText(capture.transcription?.polishedText, 120_000),
        updatedAt: now(),
        errorCode: safeText(error?.code, 120) || "ASR_FAILED"
      };
    }
  };
}
