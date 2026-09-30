import { safeText, recordVersion } from "../shared/validation/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { annotationExcerpt, annotationPrompt, shenjiSystemPrompt } from "../modules/annotations/index.mjs";
import { thoughtChainContext, thoughtTaskResult } from "../modules/thoughts/index.mjs";
import { userAnswerContext, thoughtAnswerPrompt } from "./personal-context.mjs";
import { annotationResource, annotationResourceSource, annotationResourceContext } from "./annotation-resources.mjs";

export function createAiTaskTargets({ thoughts, annotations, contentAttachments = null, hash }) {
  function annotationWork(store, task) {
    const resourceType = safeText(task.resourceType, 40), root = annotationResource(store, resourceType, task.targetId);
    const annotation = root?.annotations?.find(item => item.id === task.subtargetId);
    if (!root || !annotation) return null;
    const source = annotationResourceSource(store, resourceType, root, annotation.targetKey);
    if (!source || !source.includes(annotation.quote)) return null;
    const message = safeText(task.payload?.message, 6000), excerpt = annotationExcerpt(source, annotation), context = annotationResourceContext(resourceType, root);
    const previousItems = (annotation.shenji || []).map(item => ({ id: item.id, message: item.message || "", answer: item.answer || "", reasoningContent: item.reasoningContent || "" }));
    const rootContext = resourceType === "thought" ? `<original_question>${root.content}</original_question>` : `<source_type>${context.label}</source_type>\n<source_title>${context.title}</source_title>`;
    const prompt = annotationPrompt({ personalContext: userAnswerContext(store), rootContext, annotation, excerpt, previousItems, message });
    const inputHash = hash(JSON.stringify({
      resourceType, targetId: task.targetId, annotationId: annotation.id, targetKey: annotation.targetKey,
      source, quote: annotation.quote, text: annotation.text || "", previous: previousItems, message
    }));
    return { annotation, prompt, inputHash, inputVersion: recordVersion(root.version), scene: "annotationShenji", systemPrompt: shenjiSystemPrompt() };
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
      if (task.kind === "contentImageUnderstanding") return contentImageWork(store, task);
      if (task.kind === "annotationShenji") return annotationWork(store, task);
      if (!["thoughtAnswer", "followUpAnswer"].includes(task.kind)) return null;
      const work = thoughts.inspect(store.thoughts, task);
      if (!work) return null;
      const { root, followUp, inputVersion, subtargetVersion } = work;
      if (task.kind === "thoughtAnswer") {
        const prompt = thoughtAnswerPrompt(userAnswerContext(store), thoughtChainContext(store.thoughts, root));
        const attachmentPaths = Array.isArray(root.attachmentPaths) ? root.attachmentPaths : [];
        return { ...work, attachmentPaths, inputHash: hash(JSON.stringify({ targetId: root.id, inputVersion, attachmentPaths })), prompt, scene: "thoughtAnswer" };
      }
      const chain = thoughtChainContext(store.thoughts, root, followUp.id);
      const prompt = thoughtAnswerPrompt(userAnswerContext(store), chain, true);
      const inputHash = hash(JSON.stringify({ targetId: root.id, inputVersion, subtargetId: followUp.id, subtargetVersion, chain }));
      return { ...work, inputHash, prompt, scene: "followUpAnswer" };
    },
    save(store, work, task, result) {
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
    }
  };
}
