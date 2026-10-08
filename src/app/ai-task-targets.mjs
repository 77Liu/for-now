import { safeText, recordVersion } from "../shared/validation/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { annotationExcerpt, shenjiSystemPrompt } from "../modules/annotations/index.mjs";
import { thoughtTaskResult } from "../modules/thoughts/index.mjs";
import { parseClaimExtractionOutput } from "../modules/user-model/index.mjs";
import { annotationResource, annotationResourceSource, annotationResourceContext } from "./annotation-resources.mjs";
import { compileWorkingContextPrompt } from "./prompt-context.mjs";
import { prepareUserModelExtraction } from "./user-model.mjs";
import {
  contextDerivedOutputAllowed,
  contextDerivedLegacyDependencies,
  taskContextSourcePermission,
  thoughtTaskCurrentMaterial,
  workingContextProjection,
  workingContextReceiptFingerprint
} from "./task-context.mjs";

export function createAiTaskTargets({
  thoughts,
  annotations,
  contentAttachments = null,
  perception = null,
  getAccountId = () => "local",
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
      durationMs: Math.max(0, Math.round(Number(capture.audio.durationMs) || 0)),
      ...(capture.audio.asrAttachmentPath ? {
        asrAttachmentPath: safeText(capture.audio.asrAttachmentPath, 300),
        asrMimeType: safeText(capture.audio.asrMimeType, 100),
        asrBytes: Math.max(0, Math.round(Number(capture.audio.asrBytes) || 0))
      } : {})
    };
    const alreadyAnswered = capture.transcription?.status === "ready"
      && Boolean(safeText(capture.transcription?.rawText, 120_000));
    const sourceAudio = {
      attachmentPath: audio.attachmentPath,
      mimeType: audio.mimeType,
      bytes: audio.bytes,
      durationMs: audio.durationMs
    };
    return {
      kind: "captureTranscription",
      taskId: task.id,
      capture,
      audio,
      alreadyAnswered,
      inputVersion,
      inputHash: hash(JSON.stringify({ targetId: capture.id, audio: sourceAudio })),
      markQueued() {
        capture.transcription = {
          status: "queued",
          provider: "volcengine-seedasr-2.0",
          rawText: safeText(capture.transcription?.rawText, 120_000),
          polishedText: safeText(capture.transcription?.polishedText, 120_000),
          condensedText: safeText(capture.transcription?.condensedText, 120_000),
          updatedAt: capture.transcription?.updatedAt || "",
          errorCode: "",
          condenseErrorCode: "",
          ...(Number.isSafeInteger(capture.transcription?.version)
            && capture.transcription.version > 0
            ? { version: capture.transcription.version }
            : {})
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
    const accountId = getAccountId();
    const message = safeText(task.payload?.message, 6000), excerpt = annotationExcerpt(source, annotation), context = annotationResourceContext(resourceType, root);
    const validPreviousItems = (annotation.shenji || [])
      .filter(item => contextDerivedOutputAllowed(store, item, accountId, {
        kind: "annotationShenji",
        targetId: root.id,
        subtargetId: annotation.id
      }));
    const previousItems = validPreviousItems
      .map(item => ({ id: item.id, message: item.message || "", answer: item.answer || "", reasoningContent: item.reasoningContent || "" }));
    const previousEvidenceChecks = validPreviousItems.flatMap(item => (
      Array.isArray(item.contextReceipt?.evidenceChecks)
        ? item.contextReceipt.evidenceChecks
        : []
    ));
    const previousPermissionChecks = validPreviousItems.flatMap(item => item.contextReceipt?.permissionChecks || []);
    const previousLegacyDependencies = validPreviousItems.flatMap(item => contextDerivedLegacyDependencies(store, item));
    const baseRootContext = resourceType === "thought"
      ? `<original_question>${root.content}</original_question>`
      : `<source_type>${context.label}</source_type>\n<source_title>${context.title}</source_title>`;
    const targetMatch = /^(idea|record|answer|followup-question|followup-answer|reflection|note):(.+)$/
      .exec(annotation.targetKey);
    const targetType = targetMatch?.[1] || "";
    const targetId = targetMatch?.[2] || root.id;
    const target = targetId === root.id
      ? root
      : resourceType === "thought"
        ? ["followup-question", "followup-answer"].includes(targetType)
          ? (root.followUps || []).find(item => item.id === targetId)
          : store.thoughts.find(item => item.id === targetId && item.relatedTo === root.id)
        : [
            ...(root.reflections || []),
            ...(root.notes || []),
            ...(root.followUps || [])
          ].find(item => item.id === targetId);
    if (!target) return null;
    const rootSourceRef = {
      resourceType, resourceId: root.id,
      rootId: ["capture", "journal"].includes(resourceType) ? "" : root.id,
      targetKey: resourceType === "thought" ? `question:${root.id}` : "",
      version: recordVersion(root.version)
    };
    const targetSourceRef = targetId === root.id ? rootSourceRef : {
      resourceType, resourceId: targetId, rootId: root.id,
      targetKey: annotation.targetKey, version: recordVersion(target.version)
    };
    const annotationSourceRef = {
      resourceType, resourceId: annotation.id, rootId: root.id,
      targetKey: `annotation:${annotation.id}`, version: recordVersion(annotation.version)
    };
    const rootAllowed = root.contextAllowed !== false && root.disposition !== "discarded"
      && taskContextSourcePermission(store, rootSourceRef, accountId).contextAllowed;
    if (target.contextAllowed === false || target.disposition === "discarded"
      || annotation.contextAllowed === false
      || !taskContextSourcePermission(store, targetSourceRef, accountId).contextAllowed
      || !taskContextSourcePermission(store, annotationSourceRef, accountId).contextAllowed) return null;
    const userTarget = target.authorType === "user" || targetType === "followup-question"
      || (targetId === root.id && resourceType !== "analysis"
        && !(resourceType === "chat" && annotation.targetKey === "answer"));
    const modelTarget = !userTarget && (target.authorType === "ai" || Boolean(target.modelDraft || target.reasoningContent)
      || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(target.origin || "")));
    const targetTask = modelTarget && store.aiTasks?.find(item => item.id === target.sourceTaskId);
    if (modelTarget && !contextDerivedOutputAllowed(store, target, accountId, targetTask && {
      kind: targetTask.kind, targetId: targetTask.targetId, subtargetId: targetTask.subtargetId || ""
    })) return null;
    const requestId = safeText(task.clientRequestId || task.id, 100) || `${annotation.id}:message`;
    const currentMaterial = [...(targetId !== root.id && rootAllowed ? [{
      id: `current:${resourceType}:${root.id}:root`,
      accountId,
      text: baseRootContext,
      attachmentPaths: root.attachmentPaths,
      recordType: "当前记录",
      contextAllowed: root.contextAllowed !== false,
      validation: "version",
      occurredAt: root.occurredAt || root.createdAt,
      sourceRef: rootSourceRef
    }] : []), {
      id: `current:${resourceType}:${root.id}:${annotation.targetKey}`,
      accountId,
      text: source,
      attachmentPaths: target.attachmentPaths,
      recordType: `${context.label}·被批注正文`,
      contextAllowed: target.contextAllowed !== false && target.disposition !== "discarded",
      validation: "version",
      occurredAt: root.occurredAt || root.createdAt,
      sourceRef: targetSourceRef,
      evidenceChecks: modelTarget ? target.contextReceipt?.evidenceChecks || [] : [],
      permissionChecks: modelTarget ? target.contextReceipt?.permissionChecks || [] : [],
      legacyDependencies: modelTarget ? contextDerivedLegacyDependencies(store, target) : []
    }, {
      id: `current:${resourceType}:${root.id}:annotation:${annotation.id}`,
      accountId,
      text: [
        annotation.quote,
        annotation.text,
        ...previousItems.flatMap(item => [item.message, item.answer])
      ].filter(Boolean).join("\n"),
      attachmentPaths: annotation.attachmentPaths,
      recordType: "当前批注对话",
      contextAllowed: annotation.contextAllowed !== false,
      validation: "version",
      evidenceChecks: previousEvidenceChecks,
      permissionChecks: previousPermissionChecks,
      legacyDependencies: previousLegacyDependencies,
      occurredAt: annotation.createdAt || root.occurredAt || root.createdAt,
      sourceRef: annotationSourceRef
    }, {
      id: `current:annotation-request:${requestId}`,
      accountId,
      text: message || "回应当前批注",
      recordType: "当前追问",
      validation: "immutable",
      authorization: "current-request",
      sourceRef: {
        resourceType: "annotationRequest",
        resourceId: requestId,
        rootId: root.id,
        targetKey: "message",
        version: 1
      }
    }];
    const workingContext = workingContextProjection(store, {
      accountId,
      scene: "annotationShenji",
      task: {
        kind: "annotationShenji",
        text: message || annotation.text || annotation.quote || "回应当前批注",
        targetId: task.targetId,
        subtargetId: annotation.id
      },
      generatedAt: task.createdAt || now(),
      currentMaterial,
      compilePrompt: sections => compileWorkingContextPrompt({
        ...sections,
        scene: "annotationShenji",
        taskDetails: {
          resource: {
            type: resourceType,
            label: context.label,
            title: rootAllowed ? context.title : ""
          },
          annotation: {
            kind: annotation.kind || "comment",
            before: excerpt.before,
            focus: excerpt.focus,
            after: excerpt.after,
            comment: annotation.text || "",
            turns: previousItems.map(item => ({
              message: item.message,
              answer: item.answer
            })),
            message
          }
        }
      })
    });
    const inputHash = hash(JSON.stringify({
      resourceType, targetId: task.targetId, annotationId: annotation.id, targetKey: annotation.targetKey,
      source, quote: annotation.quote, text: annotation.text || "", previous: previousItems, message
    }));
    return {
      annotation,
      attachmentPaths: workingContext.attachmentPaths,
      prompt: workingContext.prompt,
      inputHash,
      inputVersion: recordVersion(root.version),
      subtargetVersion: recordVersion(annotation.version),
      scene: "annotationShenji",
      systemPrompt: shenjiSystemPrompt(),
      contextReceipt: workingContext.receipt,
      contextFingerprint: workingContextReceiptFingerprint(workingContext.receipt)
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

  function onboardingClaimExtractionWork(store, task) {
    const prepared = prepareUserModelExtraction(store, {
      sourceRevision: task.inputVersion || task.requestedInputVersion
    });
    return prepared.value || null;
  }

  return {
    result(store, task) {
      if (task.kind === "perceptionExtraction") {
        return perception?.result(store, task) || null;
      }
      if (task.kind === "captureTranscription") {
        return store.captures?.find(item => item.id === task.targetId) || null;
      }
      if (task.kind === "contentImageUnderstanding") {
        return contentAttachments?.taskResult(store, task) || null;
      }
      if (task.kind === "onboardingClaimExtraction") {
        return {
          claims: (store.userClaims || []).filter(item => item.sourceTaskId === task.id),
          unknowns: (store.modelUnknowns || []).filter(item => item.sourceTaskId === task.id)
        };
      }
      if (task.kind === "thoughtAnswer" || task.kind === "followUpAnswer") {
        return thoughtTaskResult(store.thoughts, task);
      }
      if (task.kind !== "annotationShenji") return null;
      return annotations.taskResult(annotationResource(store, task.resourceType, task.targetId), task);
    },
    prepare(store, task) {
      if (task.kind === "perceptionExtraction") {
        return perception?.prepare(store, task) || null;
      }
      if (task.kind === "captureTranscription") return captureTranscriptionWork(store, task);
      if (task.kind === "contentImageUnderstanding") return contentImageWork(store, task);
      if (task.kind === "onboardingClaimExtraction") return onboardingClaimExtractionWork(store, task);
      if (task.kind === "annotationShenji") return annotationWork(store, task);
      if (!["thoughtAnswer", "followUpAnswer"].includes(task.kind)) return null;
      const work = thoughts.inspect(store.thoughts, task);
      if (!work) return null;
      const { root, followUp, inputVersion, subtargetVersion } = work;
      const accountId = getAccountId();
      const workingContext = workingContextProjection(store, {
        accountId,
        scene: task.kind,
        task: {
          kind: task.kind,
          text: task.kind === "followUpAnswer"
            ? followUp.question
            : root.content || "请结合当前图片回答。",
          targetId: root.id,
          subtargetId: followUp?.id || ""
        },
        generatedAt: task.createdAt || now(),
        currentMaterial: thoughtTaskCurrentMaterial(store, root, {
          accountId,
          currentFollowUpId: followUp?.id || ""
        }),
        compilePrompt: sections => compileWorkingContextPrompt({
          ...sections,
          scene: task.kind
        })
      });
      if (task.kind === "thoughtAnswer") {
        const attachmentPaths = workingContext.attachmentPaths;
        return {
          ...work,
          attachmentPaths,
          inputHash: hash(JSON.stringify({ targetId: root.id, inputVersion, attachmentPaths })),
          prompt: workingContext.prompt,
          scene: "thoughtAnswer",
          contextReceipt: workingContext.receipt,
          contextFingerprint: workingContextReceiptFingerprint(workingContext.receipt)
        };
      }
      const inputHash = hash(JSON.stringify({
        targetId: root.id,
        inputVersion,
        subtargetId: followUp.id,
        subtargetVersion,
        currentMaterial: workingContext.receipt.currentMaterial
      }));
      return {
        ...work,
        attachmentPaths: workingContext.attachmentPaths,
        inputHash,
        prompt: workingContext.prompt,
        scene: "followUpAnswer",
        contextReceipt: workingContext.receipt,
        contextFingerprint: workingContextReceiptFingerprint(workingContext.receipt)
      };
    },
    save(store, work, task, result) {
      if (task.kind === "perceptionExtraction") {
        if (!perception) throw new Error("Perception task target is unavailable");
        return perception.save(store, work, task, result);
      }
      if (task.kind === "captureTranscription") {
        const capture = store.captures?.find(item => item.id === task.targetId);
        if (!capture || capture.audio?.attachmentPath !== work.audio.attachmentPath) {
          throw Object.assign(new Error("语音原件已经变化，转写结果未写入"), { code: "TRANSCRIPTION_STALE" });
        }
        const previousTranscriptionVersion = Number.isSafeInteger(capture.transcription?.version)
          && capture.transcription.version > 0
          ? capture.transcription.version
          : 0;
        capture.transcription = {
          status: "ready",
          version: previousTranscriptionVersion + 1,
          provider: safeText(result.provider, 100) || "volcengine-seedasr-2.0",
          rawText: safeText(result.rawText, 120_000),
          polishedText: safeText(result.polishedText, 120_000),
          condensedText: safeText(result.condensedText, 120_000),
          updatedAt: safeText(result.updatedAt, 100) || now(),
          errorCode: safeText(result.polishErrorCode, 120),
          condenseErrorCode: safeText(result.condenseErrorCode, 120)
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
      if (task.kind === "onboardingClaimExtraction") {
        if ((store.userClaims || []).some(item => item.sourceTaskId === task.id)
          || (store.modelUnknowns || []).some(item => item.sourceTaskId === task.id)) {
          return task.id;
        }
        const extracted = parseClaimExtractionOutput(result.content, {
          sources: work.sources,
          sourceTaskId: task.id,
          now
        });
        store.userClaims ||= [];
        store.modelUnknowns ||= [];
        store.userClaims.unshift(...extracted.claims);
        store.modelUnknowns.unshift(...extracted.unknowns.map(item => ({
          ...item,
          sourceTaskId: task.id
        })));
        return task.id;
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
        condensedText: safeText(capture.transcription?.condensedText, 120_000),
        updatedAt: now(),
        errorCode: safeText(error?.code, 120) || "ASR_FAILED",
          condenseErrorCode: safeText(capture.transcription?.condenseErrorCode, 120),
          ...(Number.isSafeInteger(capture.transcription?.version)
            && capture.transcription.version > 0
            ? { version: capture.transcription.version }
            : {})
      };
    }
  };
}
