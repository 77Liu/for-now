import { isWaitingForUserModelTask, pendingAiTaskMessage } from "../../shared/ai-task-status.mjs";
import {
  annotationPresentation,
  commentSubmissionIntent,
  copyAnnotationContent,
  submitAnnotationAssistantTask
} from "./presentation.mjs";
import { parseAnnotationRootKey } from "./model.mjs";

export function createAnnotationOperations({
  model,
  annotationView,
  data,
  media,
  platform,
  showToast,
  ticket,
  isCurrent,
  assertCurrent
}) {
  const { ui } = model;
  const {
    request,
    refreshNotifications,
    scheduleNotificationPoll,
    clearThoughtTracePending
  } = data;
  const {
    resetDraft,
    startDraft,
    persistDraft,
    submitDraft,
    buildPayload,
    clearDraft,
    discardUploads,
    uncertainSubmission
  } = media;
  const { createRequestId, confirm, prompt, writeClipboard, window } = platform;

  async function acceptCreated(rootKey, annotation, originRoot, originAnnotations, operation) {
    if (model.mergeConfirmed(rootKey, annotation, { create: true, originRoot, originAnnotations })) return true;
    try {
      if (!data.refreshRoot || await data.refreshRoot(rootKey) === false) throw new Error("读取未完成");
      assertCurrent(operation);
      if (ui.refreshFailureRoot === rootKey) ui.refreshFailureRoot = "";
      if (!model.counts(rootKey).loaded) throw new Error("完整批注尚未读取");
      return true;
    } catch (error) {
      assertCurrent(operation);
      ui.refreshFailureRoot = rootKey;
      annotationView.refreshCounts(rootKey);
      return false;
    }
  }

  /** 仅重读已保存但呈现未同步的当前根；账户生命周期失效不得发布，未完整读取仍保留恢复提示。 @since unreleased */
  async function retryRefresh(candidate) {
    const operation = ticket(candidate), rootKey = ui.refreshFailureRoot;
    if (!rootKey) return;
    try {
      if (!data.refreshRoot || await data.refreshRoot(rootKey) === false) throw new Error("读取未完成");
      assertCurrent(operation);
      ui.refreshFailureRoot = "";
      if (!model.counts(rootKey).loaded) throw new Error("完整批注尚未读取");
      if (ui.activeRootKey === rootKey) annotationView.renderPanel();
      annotationView.refreshCounts(rootKey);
      showToast("批注已重新读取");
    } catch (error) {
      if (isCurrent(operation)) {
        ui.refreshFailureRoot = rootKey;
        annotationView.refreshCounts(rootKey);
        showToast("批注已保存，完整内容仍未读取；请打开该记录详情后重试读取。", "error");
      }
    }
  }

  async function enqueueAssistant({
    rootKey,
    annotationId,
    message = "",
    clientRequestId,
    status,
    operation
  }) {
    const result = await submitAnnotationAssistantTask({
      clientRequestId,
      createRequestId,
      persistDraft: requestId => {
        assertCurrent(operation);
        model.saveAssistantDraft(rootKey, annotationId, message, requestId);
      },
      submitTask: async requestId => {
        assertCurrent(operation);
        const { type: resourceType, id: targetId } = parseAnnotationRootKey(rootKey);
        const task = await request("/api/ai-tasks", {
          method: "POST",
          body: JSON.stringify({
            kind: "annotationShenji",
            resourceType,
            targetId,
            subtargetId: annotationId,
            payload: { message },
            clientRequestId: requestId
          })
        });
        assertCurrent(operation);
        const tasks = (data.getSnapshot() || {}).aiTasks || [];
        if (!tasks.some(item => item.id === task.id)) tasks.unshift(task);
        return task;
      },
      refreshNotifications: async () => {
        assertCurrent(operation);
        await refreshNotifications();
        assertCurrent(operation);
      },
      scheduleNotificationPoll: () => {
        assertCurrent(operation);
        scheduleNotificationPoll();
      }
    });
    if (isCurrent(operation) && status) {
      const taskMessage = pendingAiTaskMessage(result.task, "已进入后台队列，可继续使用其他功能。");
      status.textContent = result.notificationRefreshError
        ? `${taskMessage} 通知刷新失败，稍后会自动重试刷新。`
        : taskMessage;
    }
    return result;
  }

  async function selectionAction(candidate, button) {
    if (!ui.pendingSelection) return;
    const operation = ticket(candidate);
    const selection = { ...ui.pendingSelection };
    annotationView.hideSelectionTools();
    const action = button.dataset.selectionAction;
    if (action === "comment") {
      resetDraft();
      annotationView.query("#comment-text").value = "";
      const form = annotationView.query("#comment-composer");
      delete form.dataset.requestId;
      delete form.dataset.assistantClientRequestId;
      startDraft(selection);
      annotationView.openPanel(selection.rootKey);
      annotationView.query("#comment-text").focus();
      return;
    }
    if (action === "quote") {
      data.openSelectionQuote(selection);
      ui.pendingSelection = null;
      window.getSelection()?.removeAllRanges();
      return;
    }
    try {
      const originRoot = model.rootFor(selection.rootKey);
      const originAnnotations = originRoot?.annotations;
      const annotation = await request(model.endpoint(selection.rootKey), {
        method: "POST",
        body: JSON.stringify({ ...selection, kind: action, text: "" })
      });
      assertCurrent(operation);
      const presentationSynced = await acceptCreated(selection.rootKey, annotation, originRoot, originAnnotations, operation);
      assertCurrent(operation);
      clearThoughtTracePending(selection.rootKey);
      ui.pendingSelection = null;
      window.getSelection()?.removeAllRanges();
      annotationView.applyAnchor(selection.rootKey, annotation);
      if (!presentationSynced) annotationView.openPanel(selection.rootKey);
      showToast(presentationSynced
        ? action === "emphasis" ? "已添加红色加重" : "已添加绿色划线"
        : "标记已保存，当前呈现尚未同步；可在批注面板重试读取。",
      presentationSynced ? "success" : "error");
    } catch (error) {
      if (isCurrent(operation)) showToast(error.message, "error");
    }
  }

  async function commentSubmit(candidate, form) {
    if (!ui.pendingSelection) return;
    const operation = ticket(candidate);
    const button = form.querySelector('button[type="submit"]');
    const status = annotationView.query("#comment-status");
    const selection = { ...ui.pendingSelection };
    const requestId = form.dataset.requestId || createRequestId();
    const intent = commentSubmissionIntent(annotationView.query("#comment-text").value);
    const assistantClientRequestId = intent.asksAssistant
      ? form.dataset.assistantClientRequestId || createRequestId()
      : "";
    let uploadedPaths = [];
    form.dataset.requestId = requestId;
    if (assistantClientRequestId) {
      form.dataset.assistantClientRequestId = assistantClientRequestId;
    }
    button.disabled = true;
    status.textContent = "正在保存…";
    await persistDraft();
    try {
      const submission = await submitDraft();
      assertCurrent(operation);
      uploadedPaths = submission.uploadedPaths;
      const original = buildPayload({
        content: intent.text,
        attachmentPaths: submission.attachmentPaths
      });
      const originRoot = model.rootFor(selection.rootKey);
      const originAnnotations = originRoot?.annotations;
      const annotation = await request(model.endpoint(selection.rootKey), {
        method: "POST",
        headers: { "idempotency-key": requestId },
        body: JSON.stringify({
          ...selection,
          text: original.content,
          attachmentPaths: original.attachmentPaths
        })
      });
      assertCurrent(operation);
      const presentationSynced = await acceptCreated(selection.rootKey, annotation, originRoot, originAnnotations, operation);
      assertCurrent(operation);
      clearThoughtTracePending(selection.rootKey);
      ui.activeAnnotationId = annotation.id;
      annotationView.applyAnchor(selection.rootKey, annotation);
      let assistantQueued = false;
      let notificationRefreshFailed = false;
      if (intent.asksAssistant) {
        try {
          const result = await enqueueAssistant({
            rootKey: selection.rootKey,
            annotationId: annotation.id,
            message: intent.message,
            clientRequestId: assistantClientRequestId,
            status,
            operation
          });
          assertCurrent(operation);
          assistantQueued = true;
          notificationRefreshFailed = Boolean(result.notificationRefreshError);
          model.clearAssistantDraft(selection.rootKey, annotation.id);
        } catch (error) {
          if (!isCurrent(operation)) return;
          ui.activeAssistantComposer = annotation.id;
          status.textContent = `评论已保存，神鸡请求未能排队：${error.message}`;
        }
      }
      assertCurrent(operation);
      annotationView.query("#comment-text").value = "";
      delete form.dataset.requestId;
      delete form.dataset.assistantClientRequestId;
      await clearDraft();
      assertCurrent(operation);
      ui.pendingSelection = null;
      window.getSelection()?.removeAllRanges();
      annotationView.renderPanel({ focusActive: true });
      const message = !presentationSynced
        ? "评论已保存，当前呈现尚未同步；可在批注面板重试读取。"
        : !intent.asksAssistant
        ? "评论已保存"
        : !assistantQueued
          ? "评论已保存，可在批注中重试神鸡"
          : notificationRefreshFailed
            ? "评论已保存，神鸡任务已提交，但通知刷新失败"
            : "评论已保存，神鸡回复已在后台排队";
      showToast(message, presentationSynced && (assistantQueued || !intent.asksAssistant) ? "success" : "error");
    } catch (error) {
      if (!isCurrent(operation)) return;
      if (!uncertainSubmission(error)) await discardUploads(uploadedPaths);
      else await persistDraft();
      if (isCurrent(operation)) {
        status.textContent = !Number(error?.status)
          ? "提交状态尚未确认，图片和评论已保留；联网后请再次提交。"
          : error.message;
      }
    } finally {
      if (isCurrent(operation) && button.isConnected) button.disabled = false;
    }
  }

  async function reply(candidate, form) {
    const operation = ticket(candidate);
    const rootKey = ui.activeRootKey;
    const input = form.querySelector("input");
    const button = form.querySelector("button");
    const annotationId = form.dataset.commentReply;
    button.disabled = true;
    try {
      const saved = await request(
        model.endpoint(rootKey, `/${annotationId}/replies`),
        { method: "POST", body: JSON.stringify({ text: input.value }) }
      );
      assertCurrent(operation);
      const annotation = model.mergeReply(rootKey, annotationId, saved);
      if (annotation) {
        if (ui.activeRootKey === rootKey) {
          ui.activeAnnotationId = annotationId;
          annotationView.refreshAnnotation(annotation);
        }
      }
      showToast("回复已保存");
    } catch (error) {
      if (isCurrent(operation)) {
        showToast(error.message, "error");
        button.disabled = false;
      }
    }
  }

  async function assistantSubmit(candidate, form) {
    const operation = ticket(candidate);
    const annotationId = form.dataset.shenjiForm;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector(".shenji-status");
    const message = form.elements.message.value;
    const rootKey = form.dataset.commentRoot || ui.activeRootKey;
    const clientRequestId = form.dataset.requestId || createRequestId();
    form.dataset.requestId = clientRequestId;
    model.stashAssistantDraft(form);
    button.disabled = true;
    let queued = false;
    try {
      const result = await enqueueAssistant({
        rootKey,
        annotationId,
        message,
        clientRequestId,
        status,
        operation
      });
      assertCurrent(operation);
      queued = true;
      form.elements.message.value = "";
      delete form.dataset.requestId;
      model.clearAssistantDraft(rootKey, annotationId);
      showToast(
        result.notificationRefreshError
          ? "神鸡任务已提交，但通知刷新失败"
          : isWaitingForUserModelTask(result.task)
            ? "神鸡回复等待核心用户模型就绪"
            : "神鸡回复已在后台排队",
        result.notificationRefreshError ? "error" : "success"
      );
    } catch (error) {
      if (isCurrent(operation)) {
        status.textContent = `未能排队：${error.message}`;
        model.stashAssistantDraft(form);
      }
    } finally {
      if (isCurrent(operation) && !queued) button.disabled = false;
    }
  }

  async function menu(candidate, button) {
    const operation = ticket(candidate);
    const rootKey = ui.activeRootKey;
    const annotation = model.rootFor(rootKey)?.annotations
      ?.find(item => item.id === button.dataset.annotationId);
    if (!annotation) return;
    const action = button.dataset.annotationMenu;
    try {
      if (action === "copy-quote" || action === "copy-comment") {
        await copyAnnotationContent(
          annotation,
          action === "copy-comment" ? "comment" : "quote",
          writeClipboard
        );
        assertCurrent(operation);
        showToast("已复制");
        return;
      }
      const kind = {
        "to-comment": "comment",
        "to-highlight": "highlight",
        "to-emphasis": "emphasis"
      }[action];
      if (!kind) return;
      const text = kind === "comment" && !annotation.text
        ? prompt("写下这条评论的内容", "")
        : "";
      if (kind === "comment" && !String(text || annotation.text || "").trim()) return;
      const updated = await request(
        model.endpoint(rootKey, `/${annotation.id}/convert`),
        {
          method: "PATCH",
          body: JSON.stringify({ kind, ...(text ? { text } : {}) })
        }
      );
      assertCurrent(operation);
      const current = model.mergeConfirmed(rootKey, updated);
      if (ui.activeRootKey === rootKey) {
        annotationView.removeAnchors(annotation.id);
        if (current) annotationView.applyAnchor(rootKey, current);
        ui.activeAnnotationId = current?.id || "";
        annotationView.renderPanel();
      }
      showToast(`已转为${annotationPresentation(current || updated).label}`);
    } catch (error) {
      if (isCurrent(operation)) showToast(error.message, "error");
    }
  }

  async function remove(candidate, button) {
    const operation = ticket(candidate);
    const rootKey = ui.activeRootKey;
    const annotationId = button.dataset.commentDelete;
    const root = model.rootFor(rootKey);
    const annotation = root?.annotations?.find(item => item.id === annotationId);
    const label = annotationPresentation(annotation).label;
    const warning = `将这条${label}${annotation?.shenji?.length ? "及其神鸡对话" : ""}移入回收站？`;
    if (!confirm(warning)) return;
    try {
      await request(
        model.endpoint(rootKey, `/${annotationId}`),
        { method: "DELETE" }
      );
      assertCurrent(operation);
      const currentRoot = model.rootFor(rootKey);
      if (Array.isArray(currentRoot?.annotations)) {
        currentRoot.annotations = currentRoot.annotations.filter(item => item.id !== annotationId);
      }
      annotationView.refreshCounts(rootKey);
      model.clearAssistantDraft(rootKey, annotationId);
      if (ui.activeRootKey === rootKey) {
        annotationView.removeAnchors(annotationId);
        ui.activeAnnotationId = "";
        if (ui.activeAssistantComposer === annotationId) {
          ui.activeAssistantComposer = "";
        }
        annotationView.renderPanel();
      }
      showToast(`${label}已移入回收站`);
    } catch (error) {
      if (isCurrent(operation)) showToast(error.message, "error");
    }
  }

  async function removeDrift(candidate, button) {
    if (!confirm("将这条漂流批注及其评论记录移入回收站？")) return;
    const operation = ticket(candidate);
    const rootKey = ui.activeRootKey;
    const driftId = button.dataset.driftDelete;
    try {
      await request(
        model.endpoint(rootKey, `/drift/${driftId}`),
        { method: "DELETE" }
      );
      assertCurrent(operation);
      const root = model.rootFor(rootKey);
      if (Array.isArray(root?.annotationDrift)) {
        root.annotationDrift = root.annotationDrift.filter(item => item.id !== driftId);
      }
      annotationView.refreshCounts(rootKey);
      if (ui.activeRootKey === rootKey) annotationView.renderPanel();
      showToast("漂流批注已移入回收站");
    } catch (error) {
      if (isCurrent(operation)) showToast(error.message, "error");
    }
  }

  return Object.freeze({
    selectionAction,
    retryRefresh,
    commentSubmit,
    reply,
    assistantSubmit,
    menu,
    remove,
    removeDrift
  });
}
