import { state } from "../../state/index.mjs";

/** 绑定记录、思考和聊天表单事件；注入的请求端口必须使用当前会话状态。 */
export function installRecordSubmissionEvents({
  runtime,
  $,
  showToast,
  requestV1,
  refreshState,
  applyPendingProjection,
  clearDurableDraft,
  resetOccurrenceInput,
  occurrenceFields,
  contentImagePaths,
  imageRecordPayload,
  captureRecordPayload,
  publishDomains,
  clearSubmittedContentImageDraft,
  discardContentImageUploads,
  renderTagComposer,
  closeHomeEditors,
  request,
  runAnswerInModal,
  requestStream,
  resolvePersonalizedTask,
  startBackgroundChainAnswer,
  commitDraftTags,
  chainRecordKind,
  syncChainRecordKind,
} = {}) {
  // 任务响应可能晚于用户编辑；输入版本、表单重置和会话快照共同阻止旧结果覆盖草稿。
  $("#thought-prompt-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const question = $("#chain-question");
    const status = $("#thought-prompt-status");
    const selectedDate = runtime.activeDate;
    const owner = runtime.currentUser?.id;
    const session = runtime.sessionSerial;
    const requestId = crypto.randomUUID();
    const targetId = $("#chain-form").dataset.draftId || crypto.randomUUID();
    const inputVersion = runtime.chainDraftVersion;
    $("#chain-form").dataset.draftId = targetId;
    if (question.value.trim()) {
      status.textContent = "问题框已有内容，清空后再生成新的引子。";
      question.focus();
      return;
    }

    let changed = false;
    const markChanged = () => {
      changed = true;
    };
    question.addEventListener("input", markChanged);
    $("#chain-form").addEventListener("reset", markChanged);
    button.disabled = true;
    button.textContent = "正在想…";
    status.textContent = "正在找一个可以接住的开头…";
    try {
      const initialResponse = await request("/api/thought-prompts", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          targetId,
          inputVersion,
          ...occurrenceFields($("#chain-datetime")),
        }),
      });
      const settled = await resolvePersonalizedTask(initialResponse, {
        operationLabel: "引子",
        expectedKind: "thoughtPrompt",
        onStatus: (message) => {
          if (
            owner === runtime.currentUser?.id &&
            session === runtime.sessionSerial
          )
            status.textContent = message;
        },
      });
      if (settled.abandoned) return false;
      const result = settled.result;
      const taskMismatch =
        settled.task &&
        (settled.task.targetId !== targetId ||
          (settled.task.inputVersion != null &&
            Number(settled.task.inputVersion) !== Number(inputVersion)));
      const resultMismatch =
        (result.requestId && result.requestId !== requestId) ||
        (result.targetId && result.targetId !== targetId) ||
        (result.inputVersion != null &&
          Number(result.inputVersion) !== Number(inputVersion));
      if (taskMismatch || resultMismatch) {
        status.textContent =
          "引子任务与当前请求不匹配，结果未填入。请重新发起。";
        return false;
      }
      const inputChanged =
        changed ||
        question.value.trim() ||
        runtime.activeDate !== selectedDate ||
        runtime.currentUser?.id !== owner ||
        runtime.sessionSerial !== session ||
        runtime.chainDraftVersion !== inputVersion;
      if (inputChanged) {
        status.textContent = `引子已生成，当前输入已变化，未覆盖。结果：${result.prompt || ""}`;
        return;
      }
      question.value = result.prompt || "";
      question.focus();
      question.setSelectionRange(question.value.length, question.value.length);
      status.textContent = result.hasHistory
        ? "从之前的记录接了一步；它只是引子，可以随手改。"
        : "先抛来一个轻巧的问题；它只是引子，可以随手改。";
    } catch (error) {
      status.textContent = `生成失败：${error.message}`;
    } finally {
      question.removeEventListener("input", markChanged);
      $("#chain-form").removeEventListener("reset", markChanged);
      button.disabled = false;
      button.textContent = "✦ 给个引子";
    }
  });

  // 回答草稿只有在问题、想法和会话快照仍匹配时才应用，过期结果留给用户当前编辑。
  $("#draft-answer-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const form = $("#chain-form");
    const question = $("#chain-question");
    const idea = $("#chain-idea");
    const questionText = question.value.trim();
    if (!questionText) {
      $("#chain-status").textContent = "先写下问题，我才能结合你的记录回答。";
      question.focus();
      return;
    }
    const targetId = form.dataset.draftId || crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const inputVersion = runtime.chainDraftVersion;
    const owner = runtime.currentUser?.id;
    const session = runtime.sessionSerial;
    const ideaSnapshot = idea.value;
    form.dataset.draftId = targetId;
    let applied = false;
    const isCurrent = () =>
      runtime.chainDraftVersion === inputVersion &&
      runtime.currentUser?.id === owner &&
      runtime.sessionSerial === session &&
      question.value.trim() === questionText &&
      idea.value === ideaSnapshot;
    button.disabled = true;
    try {
      await runAnswerInModal({
        title: "生成可编辑回答草稿",
        scene: "thoughtDraft",
        expectedTaskKind: "thoughtDraft",
        expectedTaskTargetId: targetId,
        expectedTaskInputVersion: inputVersion,
        expectedTaskRequestId: requestId,
        isSessionCurrent: () =>
          runtime.currentUser?.id === owner &&
          runtime.sessionSerial === session,
        isCurrent,
        requestCall: (onEvent) =>
          requestStream(
            "/api/answer-drafts",
            {
              method: "POST",
              body: JSON.stringify({
                requestId,
                targetId,
                inputVersion,
                question: questionText,
                idea: ideaSnapshot,
              }),
            },
            onEvent,
          ),
        onDone: (result) => {
          if (
            result.requestId !== requestId ||
            result.targetId !== targetId ||
            Number(result.inputVersion) !== inputVersion
          )
            return;
          applied = true;
          runtime.answerDraft = result.draft;
          runtime.answerReasoningDraft = result.reasoningContent || "";
          $("#chain-answer").value = result.draft;
          $("#chain-status").textContent =
            "草稿已填入回答框。请按你的判断修改，再提交整套思考。";
        },
      });
      showToast(
        applied
          ? "回答草稿已生成，可直接修改"
          : "旧草稿已完成，但没有覆盖当前输入",
        applied ? "success" : "error",
      );
    } catch (error) {
      $("#chain-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  // 保留同一 requestId 供不确定提交重试使用，服务端据此保证写入幂等。
  $("#chain-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    if ($("#chain-tags").value.trim()) commitDraftTags();
    const recordKind = chainRecordKind();
    const requestId = form.dataset.requestId || crypto.randomUUID();
    const temporaryId = `pending:${requestId}`;
    const owner = runtime.currentUser?.id;
    const session = runtime.sessionSerial;
    const answer = $("#chain-answer").value;
    const questionText = $("#chain-question").value;
    const idea = $("#chain-idea").value;
    const draftTagText = $("#chain-tags").value;
    const modelDraft = runtime.answerDraft;
    const modelReasoning = runtime.answerReasoningDraft;
    const tags = [...runtime.draftTags];
    const timeInput = $("#chain-datetime");
    const timeMode = timeInput.dataset.occurrenceMode || "";
    const manualTimeValue = timeInput.value || "";
    const activeDate = runtime.activeDate;
    const chainDraftVersion = runtime.chainDraftVersion;
    const draftId = form.dataset.draftId;
    const submittedImageDraftItems = { value: null };
    const currentImageDraftItems = () =>
      runtime.contentImageDraftManager?.snapshot?.("thoughtRoot")?.items ?? null;
    const imageDraftMatches = (expected) => {
      if (expected === null) return true;
      const current = currentImageDraftItems();
      return Array.isArray(current) && current.length === expected.length &&
        current.every((item, index) => {
          const before = expected[index];
          return item.file === before.file && item.path === before.path &&
            item.uploadedPath === before.uploadedPath &&
            item.uploadRequestId === before.uploadRequestId &&
            item.preview === before.preview;
        });
    };
    const sourceCaptureId = form.elements.sourceCaptureId.value;
    const sourceCaptureVersion =
      Number(form.elements.sourceCaptureVersion.value) || 0;
    // 保存提交快照：旧响应只清理仍与提交时一致的草稿，未确认请求则保留原 requestId 供安全重试。
    const isCurrentSession = () =>
      owner === runtime.currentUser?.id && session === runtime.sessionSerial;
    const isUnchangedDraftWithoutImages = () =>
      isCurrentSession() &&
      form.dataset.requestId === requestId &&
      chainRecordKind() === recordKind &&
      runtime.activeDate === activeDate &&
      runtime.chainDraftVersion === chainDraftVersion &&
      form.dataset.draftId === draftId &&
      $("#chain-question").value === questionText &&
      $("#chain-idea").value === idea &&
      $("#chain-tags").value === draftTagText &&
      $("#chain-answer").value === answer &&
      (timeInput.dataset.occurrenceMode || "") === timeMode &&
      timeInput.value === manualTimeValue &&
      runtime.answerDraft === modelDraft &&
      runtime.answerReasoningDraft === modelReasoning &&
      JSON.stringify(runtime.draftTags) === JSON.stringify(tags) &&
      form.elements.sourceCaptureId.value === sourceCaptureId &&
      (Number(form.elements.sourceCaptureVersion.value) || 0) ===
        sourceCaptureVersion;
    const isUnchangedDraft = () =>
      isUnchangedDraftWithoutImages() &&
      imageDraftMatches(submittedImageDraftItems.value);
    const clearSubmittedDraft = async () => {
      if (!isUnchangedDraft()) return false;
      await clearSubmittedContentImageDraft("thoughtRoot");
      if (!isUnchangedDraftWithoutImages() || !imageDraftMatches([])) return false;
      runtime.chainDraftVersion += 1;
      form.reset();
      clearDurableDraft("chain-form");
      resetOccurrenceInput($("#chain-datetime"));
      runtime.draftTags = [];
      renderTagComposer();
      runtime.answerDraft = "";
      runtime.answerReasoningDraft = "";
      delete form.dataset.requestId;
      delete form.dataset.draftId;
      return true;
    };
    let uploadedPaths = [];
    let eventTime;
    form.dataset.requestId = requestId;
    button.disabled = true;
    button.textContent = "正在保存…";
    $("#chain-status").textContent =
      recordKind === "capture" ? "正在收进念起…" : "正在保存整套思考…";
    try {
      eventTime = occurrenceFields(timeInput);
      const submission = await contentImagePaths("thoughtRoot");
      if (!isCurrentSession()) return;
      uploadedPaths = submission.uploadedPaths;
      submittedImageDraftItems.value = currentImageDraftItems();
      const original = imageRecordPayload({
        content: questionText,
        attachmentPaths: submission.attachmentPaths,
      });
      if (recordKind === "capture") {
        const payload = {
          ...eventTime,
          ...captureRecordPayload(original),
          tags,
        };
        const result = (
          await requestV1(
            "/api/v1/captures",
            {
              method: "POST",
              headers: { "idempotency-key": requestId },
              body: JSON.stringify(payload),
            },
            {
              domains: ["captures"],
              projection: { kind: "capture.create", temporaryId, payload },
              onQueued: (record) => {
                if (isCurrentSession()) applyPendingProjection(record);
              },
            },
          )
        ).data;
        if (!isCurrentSession()) return;
        state.captures = (state.captures || []).map((item) =>
          item.id === temporaryId ? result : item,
        );
        publishDomains(new Set(["captures"]));
        const cleared = await clearSubmittedDraft();
        if (!isCurrentSession()) return;
        if (cleared) {
          $("#chain-status").textContent = "已收进念起。";
          closeHomeEditors();
        }
        void refreshState("captures").catch(() =>
          isCurrentSession() && showToast("念起已保存，但页面刷新失败。重新进入页面即可读取。", "error"),
        );
        showToast("已收进念起");
        return;
      }

      const needsAnswer =
        Boolean(original.content.trim() || original.attachmentPaths.length) &&
        !answer.trim() &&
        runtime.llmSettings.automaticAnswers?.thoughtAnswer === true;
      const payload = {
        ...eventTime,
        question: original.content,
        attachmentPaths: original.attachmentPaths,
        idea,
        answer,
        modelDraft,
        modelReasoning,
        tags,
        generateAnswer: needsAnswer,
        ...(sourceCaptureId
          ? {
              sourceRef: {
                type: "capture",
                id: sourceCaptureId,
                version: sourceCaptureVersion,
              },
            }
          : {}),
      };
      const result = (
        await requestV1(
          "/api/v1/thought-chains",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload),
          },
          {
            domains: ["thoughts", "aiTasks", "notifications"],
            projection: { kind: "thought.chain.create", temporaryId, payload },
            onQueued: (record) => {
              if (isCurrentSession()) applyPendingProjection(record);
            },
          },
        )
      ).data;
      if (!isCurrentSession()) return;
      const question = result.items.find((item) => item.type === "question");
      state.thoughts = [
        ...result.items,
        ...(state.thoughts || []).filter(
          (item) => !String(item.id).startsWith(`${temporaryId}:`),
        ),
      ];
      publishDomains(new Set(["thoughts"]));
      const cleared = await clearSubmittedDraft();
      if (!isCurrentSession()) return;
      if (cleared) {
        $("#chain-status").textContent = needsAnswer
          ? "思考已保存，后台生成一条图文合并回答。"
          : answer.trim()
            ? "已保存为一套完整思考。"
            : "思考已保存，未自动调用 AI。";
        closeHomeEditors();
      }
      void refreshState(["thoughts", "review", "notifications"], {
        chainId: question?.id,
      }).catch(() => isCurrentSession() &&
        showToast("思考已保存，但最新状态暂未刷新。重新进入页面即可读取。", "error"),
      );
      if (needsAnswer && question)
        void startBackgroundChainAnswer(question, result.task);
      showToast(
        needsAnswer ? "思考已保存，可继续记录" : "整套思考已保存，不会重复记录",
      );
    } catch (error) {
      if (!isCurrentSession()) return;
      if (error.syncStatus === "pending") {
        // 待同步队列接管附件后清空表单；其他失败才回收本次上传资源。
        const cleared = await clearSubmittedDraft();
        if (!isCurrentSession()) return;
        $("#chain-status").textContent =
          recordKind === "capture"
            ? "念起已留存，网络恢复后自动同步。"
            : "思考已留存，网络恢复后自动同步。";
        if (cleared) {
          closeHomeEditors();
        }
        showToast(
          recordKind === "capture"
            ? "念起已进入待同步队列"
            : "思考已进入待同步队列",
        );
      } else {
        if (recordKind === "capture" && isCurrentSession())
          await discardContentImageUploads("thoughtRoot", uploadedPaths);
        if (!isCurrentSession()) return;
        // 未确认的思考提交可能已落库；保留附件以支持同 requestId 恢复。
        if (error?.syncStatus === "failed") {
          $("#chain-status").textContent = "保存失败，内容仍保留。检查网络后可用原请求安全重试。";
        } else if (
          recordKind === "thought" &&
          sourceCaptureId &&
          error?.syncStatus === "conflict" &&
          error?.code === "PRECONDITION_FAILED"
        ) {
          $("#chain-status").textContent =
            "来源念起已变化，请重新打开后再提交。当前内容仍保留。";
        } else if (error?.syncStatus === "conflict") {
          $("#chain-status").textContent = "保存状态冲突，内容仍保留。请先重新读取思考列表，再决定是否重试。";
        } else {
          $("#chain-status").textContent = "提交状态尚未确认，内容仍保留。请先重新读取思考列表；重试会继续使用同一请求编号。";
        }
      }
    } finally {
      if (isCurrentSession()) {
        button.disabled = false;
        syncChainRecordKind();
      }
    }
  });

  $("#chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const requestId = form.dataset.requestId || crypto.randomUUID();
    const payload = {
      ...occurrenceFields($("#chat-datetime")),
      message: $("#chat-input").value,
    };
    form.dataset.requestId = requestId;
    button.disabled = true;
    $("#chat-status").textContent = "正在结合你已保存的记录…";
    try {
      const owner = runtime.currentUser?.id;
      const session = runtime.sessionSerial;
      const initialResponse = await requestV1(
        "/api/v1/chats",
        {
          method: "POST",
          headers: { "idempotency-key": requestId },
          body: JSON.stringify(payload),
        },
        { domains: ["chats"] },
      );
      const settled = await resolvePersonalizedTask(initialResponse, {
        operationLabel: "对话回答",
        expectedKind: "chat",
        onStatus: (message) => {
          if (
            owner === runtime.currentUser?.id &&
            session === runtime.sessionSerial
          )
            $("#chat-status").textContent = message;
        },
      });
      if (settled.abandoned) return;
      if (
        owner !== runtime.currentUser?.id ||
        session !== runtime.sessionSerial
      )
        return;
      const saved = settled.result;
      if (
        saved.message !== payload.message ||
        saved.occurredAt !== payload.occurredAt ||
        saved.occurredOn !== payload.occurredOn
      ) {
        throw new Error("后台对话结果与本次问题不匹配，输入已保留。");
      }
      const unchanged =
        JSON.stringify({
          ...occurrenceFields($("#chat-datetime")),
          message: $("#chat-input").value,
        }) === JSON.stringify(payload);
      delete form.dataset.requestId;
      if (unchanged) {
        $("#chat-input").value = "";
        resetOccurrenceInput($("#chat-datetime"));
      }
      void refreshState("chat").catch((error) =>
        showToast(`回答已保存，但页面刷新失败：${error.message}`, "error"),
      );
      $("#chat-status").textContent = unchanged
        ? "回答已生成并保存。"
        : "回答已生成；你后来修改的输入已保留。";
    } catch (error) {
      if (error.taskId) {
        delete form.dataset.requestId;
      }
      $("#chat-status").textContent =
        error.syncStatus === "pending"
          ? "问题已留存，网络恢复后自动处理。"
          : error.message;
    } finally {
      button.disabled = false;
    }
  });
}
