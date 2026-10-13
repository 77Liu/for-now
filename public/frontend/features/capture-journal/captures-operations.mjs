import {
  captureAudioIdentity,
  captureRecordPayload,
  speechAssetForSource,
  speechSynthesisPayload
} from "../../media/index.mjs";

const noop = () => {};
const abortFailure = () => Object.assign(new Error("Capture session changed"), {
  name: "AbortError"
});

export function createCaptureOperations({
  data,
  media,
  audio,
  crossDomain,
  view,
  platform,
  captureView,
  query,
  getDraftTags,
  commitTags,
  resetForm,
  sessionTicket,
  sameSession
} = {}) {
  function publicValidation(callback) {
    try {
      return callback();
    } catch (error) {
      const wrapped = new Error(String(error?.message || "输入不符合要求"), { cause: error });
      wrapped.publicValidation = true;
      throw wrapped;
    }
  }

  function submissionError(error, stage) {
    const context = {
      images: {
        operation: "上传捕念图片",
        object: "这些图片",
        phase: "捕念图片上传",
        retained: "捕念草稿和待上传图片仍保存在当前页面"
      },
      audio: {
        operation: "上传捕念语音",
        object: "这段语音",
        phase: "捕念语音上传",
        retained: "捕念草稿和待提交语音仍保存在当前页面"
      },
      validation: {
        operation: "保存这条捕念",
        object: "这条捕念",
        retained: "当前表单内容仍保留"
      },
      save: {
        operation: "保存这条捕念",
        object: "这条捕念",
        retained: "当前表单内容和待提交媒体仍保留"
      }
    }[stage] || {
      operation: "保存这条捕念",
      object: "这条捕念",
      retained: "当前表单内容仍保留"
    };
    return view.presentError(error, {
      ...context,
      publicValidation: error?.publicValidation === true
    }).message;
  }

  async function submit(form) {
    const ticket = sessionTicket();
    const pendingStartedAt = platform.performance.now();
    if (query("#capture-tags")?.value.trim()) commitTags();
    const id = query("#capture-id")?.value || "";
    const existing = id
      ? (data.getSnapshot().captures || []).find(item => item.id === id)
      : null;
    const button = query("#capture-submit");
    const requestId = form.dataset.requestId || platform.createRequestId();
    const temporaryId = `pending:${requestId}`;
    let uploadedPaths = [];
    let uploadedAudioPath = "";
    let projected = false;
    let stage = "images";
    if (!id) form.dataset.requestId = requestId;
    button.disabled = true;
    captureView.showStatus("#capture-status", id ? "正在保存修改…" : "正在收下…");
    if (platform.performanceEnabled()) {
      const label = `提交等待 ${(platform.performance.now() - pendingStartedAt).toFixed(1)} 毫秒`;
      captureView.showStatus("#capture-pending-metric", label);
      platform.setTimer(() => {
        if (query("#capture-pending-metric")?.textContent === label) {
          captureView.showStatus("#capture-pending-metric", "");
        }
      }, 5000);
    }
    try {
      stage = "audio";
      await audio.prepareSubmission();
      if (!sameSession(ticket)) throw abortFailure();
      stage = "images";
      const submission = await media.submitDraft("capture");
      uploadedPaths = submission.uploadedPaths;
      if (!sameSession(ticket)) throw abortFailure();
      if (uploadedPaths.length) {
        captureView.showStatus("#capture-status", "图片已上传，正在同步记录…");
      }
      stage = "audio";
      const audioResult = await audio.forSubmission();
      if (!sameSession(ticket)) throw abortFailure();
      if (audioResult && !audio.isCurrentSubmission(audioResult)) throw abortFailure();
      if (audioResult?.attachmentPath === audio.snapshot().uploadedPath) {
        uploadedAudioPath = audioResult.attachmentPath;
        captureView.showStatus("#capture-status", "语音已上传，正在同步记录…");
      }
      stage = "validation";
      if (audioResult && !audio.isCurrentSubmission(audioResult)) throw abortFailure();
      const payload = publicValidation(() => ({
        title: query("#capture-title")?.value || "",
        ...view.occurrenceFields(query("#capture-date")),
        ...captureRecordPayload({
          content: query("#capture-content").value,
          attachmentPaths: submission.attachmentPaths,
          audio: audioResult
        }),
        tags: [...getDraftTags()]
      }));
      stage = "save";
      if (id) {
        const result = await data.requestV1(
          `/api/v1/captures/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${existing?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            domains: ["captures"],
            recoverCommitted: true,
            projection: { kind: "record.update", domain: "captures", id, payload },
            onQueued: record => {
              projected = data.applyPendingProjection(record);
            }
          }
        );
        if (sameSession(ticket) && result.data) {
          data.getSnapshot().captures = (data.getSnapshot().captures || [])
            .map(item => item.id === id ? result.data : item);
        }
      } else {
        const result = await data.requestV1(
          "/api/v1/captures",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["captures"],
            projection: { kind: "capture.create", temporaryId, payload },
            onQueued: record => {
              const snapshot = data.getSnapshot();
              snapshot.captures = [
                {
                  id: temporaryId,
                  ...payload,
                  createdAt: record.createdAt,
                  _sync: { status: "sending", operationId: record.operationId }
                },
                ...(snapshot.captures || []).filter(item => item.id !== temporaryId)
              ];
              projected = true;
              data.publish(["captures"]);
              captureView.showStatus("#capture-status", "已记下，正在同步…");
            }
          }
        );
        if (sameSession(ticket)) {
          const snapshot = data.getSnapshot();
          snapshot.captures = (snapshot.captures || [])
            .map(item => item.id === temporaryId ? result.data : item);
        }
      }
      if (!sameSession(ticket)) return false;
      data.publish(["captures"]);
      const refreshing = data.refresh("captures");
      await resetForm({ submitted: true });
      void refreshing.catch(error => view.showToast(view.presentError(error, {
        operation: "刷新捕念列表",
        object: "捕念列表",
        phase: "捕念列表刷新",
        retained: "刚才的捕念已经保存"
      }).message, "error"));
      view.showToast(id ? "捕念已更新" : "已收进捕念");
      return true;
    } catch (error) {
      if (!sameSession(ticket) || error.name === "AbortError") return false;
      if (projected && error.syncStatus === "pending") {
        const pending = (data.getSnapshot().captures || [])
          .find(item => item.id === temporaryId);
        if (pending) pending._sync.status = "pending";
        data.publish(["captures"]);
        await resetForm({ submitted: true });
        captureView.showStatus("#capture-status", "已记下，网络恢复后自动同步。");
        view.showToast("捕念已进入待同步队列");
      } else if (projected && error.syncStatus === "conflict") {
        if (id) await data.refresh("captures").catch(noop);
        else {
          data.getSnapshot().captures = (data.getSnapshot().captures || [])
            .filter(item => item.id !== temporaryId);
          data.publish(["captures"]);
        }
        await Promise.all([
          media.rollbackDraft("capture", uploadedPaths),
          audio.rollback(uploadedAudioPath)
        ]);
        captureView.showStatus("#capture-status", view.presentError(error, {
          operation: "保存这条捕念",
          object: "这条捕念",
          retained: "当前表单内容仍保留，已有记录没有被覆盖"
        }).message);
        view.showToast("捕念同步发生冲突", "error");
      } else {
        if (projected) {
          if (id) await data.refresh("captures").catch(noop);
          else {
            data.getSnapshot().captures = (data.getSnapshot().captures || [])
              .filter(item => item.id !== temporaryId);
            data.publish(["captures"]);
          }
        }
        await Promise.all([
          media.rollbackDraft("capture", uploadedPaths),
          audio.rollback(uploadedAudioPath)
        ]);
        captureView.showStatus("#capture-status", submissionError(error, stage));
      }
      return false;
    } finally {
      if (sameSession(ticket) && button?.isConnected) button.disabled = false;
    }
  }

  async function transcribe(button) {
    const ticket = sessionTicket();
    const snapshot = data.getSnapshot();
    const capture = (snapshot.captures || [])
      .find(item => item.id === button.dataset.captureTranscribe);
    const audioKey = button.dataset.captureAudioKey;
    if (!capture || !audioKey || captureAudioIdentity(capture) !== audioKey) {
      view.showToast("原音已经变化，请在当前记录上重新开始转写。", "error");
      return false;
    }
    button.disabled = true;
    try {
      const task = await data.request(
        `/api/captures/${encodeURIComponent(capture.id)}/transcription`,
        { method: "POST", body: "{}" }
      );
      if (!sameSession(ticket)) return false;
      const current = (data.getSnapshot().captures || [])
        .find(item => item.id === capture.id);
      if (task?.targetId !== capture.id || captureAudioIdentity(current) !== audioKey) return false;
      if (!snapshot.aiTasks.some(item => item.id === task.id)) snapshot.aiTasks.unshift(task);
      if (current?.transcription) current.transcription.status = "queued";
      data.publish(["captures", "aiTasks"]);
      await data.refresh("notifications");
      if (!sameSession(ticket)) return false;
      crossDomain.scheduleNotificationPoll();
      view.showToast("语音已进入后台转写队列");
      return true;
    } catch (error) {
      if (!sameSession(ticket)) return false;
      view.showToast(view.presentError(error, {
        operation: "开始语音转写",
        object: "这段录音",
        phase: "语音转写排队",
        retained: "原音已经保存"
      }).message, "error");
      if (button.isConnected) button.disabled = false;
      return false;
    }
  }

  async function synthesize(button) {
    const ticket = sessionTicket();
    const controls = button.closest(".speech-asset-controls");
    const sourceId = controls?.dataset.speechSourceId;
    const sourceVersion = Number(controls?.dataset.speechSourceVersion);
    const snapshot = data.getSnapshot();
    const source = (snapshot.captures || []).find(item => item.id === sourceId);
    const status = controls?.querySelector(".speech-asset-status");
    if (!source || Number(source.version || 1) !== sourceVersion) {
      if (status) status.textContent = "文字来源已经变化，请在当前版本上重新生成。";
      return false;
    }
    const asset = speechAssetForSource(snapshot.speech.assets, {
      sourceType: "capture",
      sourceId,
      sourceVersion
    });
    const regenerate = button.dataset.speechRegenerate === "true" && Boolean(asset);
    const payload = speechSynthesisPayload({
      sourceType: "capture",
      sourceId,
      sourceVersion,
      regenerate,
      generationRate: controls?.querySelector("[data-speech-generation-rate]")?.value
    });
    platform.audio.stopAll();
    button.disabled = true;
    if (status) status.textContent = regenerate ? "正在重新生成…" : "正在生成…";
    let generated = false;
    try {
      await data.requestBlob("/api/speech/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }, { fallback: "语音合成失败" });
      if (!sameSession(ticket)) return false;
      generated = true;
      await data.refresh(["speech", "captures"]);
      if (!sameSession(ticket)) return false;
      view.showToast(regenerate ? "文字朗读已重新生成" : "文字朗读已生成");
      return true;
    } catch (error) {
      if (!sameSession(ticket)) return false;
      if (generated) {
        if (status?.isConnected) status.textContent = "音频已生成，但列表刷新失败，请稍后重试读取。";
        view.showToast("音频已生成，但列表刷新失败", "error");
      } else if (status) {
        status.textContent = view.presentError(error, {
          operation: "生成文字朗读",
          object: "这次文字朗读",
          phase: "文字朗读生成",
          retained: "原音和文字记录没有变化"
        }).message;
      }
      return false;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function remove(button) {
    const ticket = sessionTicket();
    const id = button.dataset.captureDelete;
    const item = (data.getSnapshot().captures || []).find(value => value.id === id);
    if (!item || !platform.confirm("将这条捕念移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.requestV1(
        `/api/v1/captures/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${item.version || 1}"` }
        },
        {
          domains: ["captures"],
          recoverCommitted: true,
          projection: { kind: "record.delete", domain: "captures", id },
          onQueued: record => data.applyPendingProjection(record)
        }
      );
      if (!sameSession(ticket)) return false;
      void data.refresh("captures").catch(error => (
        sameSession(ticket)
          ? view.showToast(`捕念已移除，但列表刷新失败：${error.message}`, "error")
          : false
      ));
      view.showToast("捕念已移入回收站");
      return true;
    } catch (error) {
      if (!sameSession(ticket)) return false;
      if (error.syncStatus === "pending") view.showToast("捕念将在网络恢复后移入回收站");
      else {
        await data.refresh("captures").catch(noop);
        view.showToast(error.message, "error");
        if (button.isConnected) button.disabled = false;
      }
      return false;
    }
  }

  return Object.freeze({ submit, transcribe, synthesize, remove });
}
