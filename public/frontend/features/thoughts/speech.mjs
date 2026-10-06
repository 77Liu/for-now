import {
  speechAssetForSource,
  speechSynthesisPayload
} from "../../media/index.mjs";

export function createThoughtSpeech({
  getSnapshot,
  requestBlob,
  refresh,
  createTicket,
  isCurrent,
  audio,
  showToast,
  presentError
} = {}) {
  const sourceFor = controls => {
    const sourceType = controls?.dataset.speechSourceType;
    const sourceId = controls?.dataset.speechSourceId;
    const sourceVersion = Number(controls?.dataset.speechSourceVersion);
    const source = (getSnapshot().thoughts || []).find(item => (
      item.id === sourceId
      && item.type === (sourceType === "thoughtChain" ? "question" : "answer")
    ));
    return { sourceType, sourceId, sourceVersion, source };
  };

  return Object.freeze({
    async synthesize(button) {
      const controls = button.closest(".speech-asset-controls");
      const status = controls?.querySelector(".speech-asset-status");
      const {
        sourceType,
        sourceId,
        sourceVersion,
        source
      } = sourceFor(controls);
      if (!source || Number(source.version || 1) !== sourceVersion) {
        if (status) {
          status.textContent = "文字来源已经变化，请在当前版本上重新生成。";
        }
        return false;
      }
      const asset = speechAssetForSource(getSnapshot().speech.assets, {
        sourceType,
        sourceId,
        sourceVersion
      });
      const regenerate = button.dataset.speechRegenerate === "true" && Boolean(asset);
      const payload = speechSynthesisPayload({
        sourceType,
        sourceId,
        sourceVersion,
        regenerate
      });
      const ticket = createTicket();
      audio.stopAll();
      button.disabled = true;
      if (status) status.textContent = regenerate ? "正在重新生成…" : "正在生成…";
      let generated = false;
      try {
        await requestBlob("/api/speech/synthesize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }, { fallback: "语音合成失败" });
        generated = true;
        if (!isCurrent(ticket) || Number(source.version || 1) !== sourceVersion) {
          return false;
        }
        await refresh(["speech", "thoughts"], {
          chainId: sourceType === "thoughtAnswer" ? source.relatedTo : source.id
        });
        if (isCurrent(ticket)) {
          showToast(regenerate ? "文字朗读已重新生成" : "文字朗读已生成");
        }
        return true;
      } catch (error) {
        if (!isCurrent(ticket)) return false;
        if (generated) {
          if (status?.isConnected) {
            status.textContent = "音频已生成，但列表刷新失败，请稍后重试读取。";
          }
          showToast("音频已生成，但列表刷新失败", "error");
        } else if (status) {
          status.textContent = presentError(error, {
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
  });
}
