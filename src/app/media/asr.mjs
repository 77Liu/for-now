import { errorMetadata } from "../../shared/observability/index.mjs";
import { renderPrompt } from "../../shared/prompts/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const missingAttachment = error => (
  ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404
);
const fireAndForget = operation => {
  try {
    Promise.resolve(operation()).catch(() => {});
  } catch {}
};

export function createAsrWorkflows({
  repository,
  attachments,
  cleanup,
  speechProvider,
  speechGate,
  aiBudgetRuntime,
  providerBudgetStage,
  conservativeDeepSeekStage,
  currentBudgetAccountId,
  meteredProviderCall,
  runDeepSeek,
  audioMaxDurationMs,
  now,
  logEvent,
  emitDebug = () => {}
}) {
  if (!repository?.update || !attachments?.read || !attachments?.saveAsrAudio
    || !cleanup?.cleanFailedUploads
    || typeof speechProvider?.prepareAsrAudio !== "function"
    || typeof speechProvider?.transcribe !== "function"
    || typeof speechGate?.acquire !== "function") {
    throw new TypeError("ASR workflows require repository, attachments, provider and gate");
  }
  if (typeof aiBudgetRuntime?.executeTask !== "function"
    || typeof providerBudgetStage !== "function"
    || typeof conservativeDeepSeekStage !== "function"
    || typeof currentBudgetAccountId !== "function"
    || typeof meteredProviderCall !== "function"
    || typeof runDeepSeek !== "function") {
    throw new TypeError("ASR workflows require explicit AI budget and generation ports");
  }
  if (typeof now !== "function" || typeof logEvent !== "function") {
    throw new TypeError("ASR workflows require clock and logging functions");
  }

  async function prepareCaptureAsrAudio(work, signal) {
    if (work.audio.asrAttachmentPath) {
      try {
        return {
          audio: await attachments.read(work.audio.asrAttachmentPath),
          mimeType: work.audio.asrMimeType || "audio/wav"
        };
      } catch (error) {
        if (!missingAttachment(error)) throw error;
      }
    }
    const source = await attachments.read(work.audio.attachmentPath);
    const prepared = await speechProvider.prepareAsrAudio({
      audio: source,
      mimeType: work.audio.mimeType,
      signal
    });
    if (prepared.audio === source && prepared.mimeType === work.audio.mimeType) {
      return prepared;
    }
    const derived = await attachments.saveAsrAudio({
      sourcePath: work.audio.attachmentPath,
      data: prepared.audio,
      mimeType: prepared.mimeType
    });
    const attached = await repository.update(store => {
      const capture = store.captures?.find(item => item.id === work.capture.id);
      if (!capture || capture.audio?.attachmentPath !== work.audio.attachmentPath) {
        return false;
      }
      capture.audio = {
        ...capture.audio,
        asrAttachmentPath: derived.attachmentPath,
        asrMimeType: derived.mimeType,
        asrBytes: derived.bytes
      };
      capture.updatedAt = now();
      capture.version = recordVersion(capture.version) + 1;
      return true;
    });
    if (!attached) {
      await cleanup.cleanFailedUploads([derived.attachmentPath]).catch(() => {});
      throw Object.assign(
        new Error("语音原件已经变化，转写派生物未保留"),
        { code: "TRANSCRIPTION_STALE" }
      );
    }
    fireAndForget(() => emitDebug({
      hypothesisId: "E",
      location: "media/asr.mjs:prepareCaptureAsrAudio",
      msg: "[DEBUG] ASR derivative persisted",
      data: {
        targetId: safeText(work.capture.id, 100),
        sourcePath: work.audio.attachmentPath,
        derivedPath: derived.attachmentPath,
        mimeType: derived.mimeType,
        bytes: derived.bytes
      }
    }));
    return { audio: prepared.audio, mimeType: prepared.mimeType };
  }

  async function transcribeCapture(work, { signal } = {}) {
    const preparedAudio = await prepareCaptureAsrAudio(work, signal);
    const audio = preparedAudio.audio;
    const audioMimeType = preparedAudio.mimeType;
    const asrStageId = "speech-recognition";
    const polishStageId = "deepseek-polish";
    const condenseStageId = "deepseek-condense";
    return aiBudgetRuntime.executeTask({
      accountId: currentBudgetAccountId(),
      taskId: `capture-transcription:${work.taskId}`,
      stages: [
        providerBudgetStage({
          provider: "volcengine",
          service: "speech",
          scene: "speechRecognition",
          action: "streamingAsr",
          unitType: "audioMillisecond",
          units: audioMaxDurationMs
        }, asrStageId),
        conservativeDeepSeekStage({
          id: polishStageId,
          scene: "capturePolish"
        }),
        conservativeDeepSeekStage({
          id: condenseStageId,
          scene: "capturePolish"
        })
      ]
    }, async budgetExecution => {
      const release = await speechGate.acquire();
      let transcription;
      try {
        transcription = await meteredProviderCall({
          provider: "volcengine",
          service: "speech",
          scene: "speechRecognition",
          action: "streamingAsr",
          request: { audioBytes: audio.length, mimeType: audioMimeType },
          modality: "audio",
          unitType: "audioMillisecond",
          units: audioMaxDurationMs
        }, () => speechProvider.transcribe({
          audio,
          mimeType: audioMimeType,
          signal
        }), result => {
          const durationMs = Math.min(
            audioMaxDurationMs,
            Math.max(0, Math.round(Number(result?.durationMs) || 0))
          );
          return durationMs
            ? {
                providerRequestId: result?.providerRequestId || "",
                unitType: "audioMillisecond",
                units: durationMs
              }
            : {
                providerRequestId: result?.providerRequestId || "",
                unitType: "audioMillisecond",
                units: 0,
                costKnown: false,
                costSource: "Provider response did not include a measured audio duration"
              };
        }, {
          execution: budgetExecution,
          stageId: asrStageId
        });
      } finally {
        release();
      }
      let polishedText = "";
      let polishErrorCode = "";
      try {
        polishedText = await runDeepSeek(
          renderPrompt("capture.transcription.polish", {
            rawText: transcription.rawText
          }),
          {
            scene: "capturePolish",
            maxTokens: 4000,
            signal,
            budgetExecution,
            budgetStageIds: [polishStageId]
          }
        );
      } catch (error) {
        polishErrorCode = safeText(error.code, 120) || "POLISH_FAILED";
        await logEvent("system", "capture.transcription_polish_failed", {
          level: "warn",
          captureId: work.capture.id,
          error: errorMetadata(error)
        });
      }
      let condensedText = "";
      let condenseErrorCode = "";
      try {
        condensedText = await runDeepSeek(
          renderPrompt("capture.transcription.condense", {
            rawText: transcription.rawText,
            polishedText
          }),
          {
            scene: "capturePolish",
            maxTokens: 4000,
            signal,
            budgetExecution,
            budgetStageIds: [condenseStageId]
          }
        );
      } catch (error) {
        condenseErrorCode = safeText(error.code, 120) || "CONDENSE_FAILED";
        await logEvent("system", "capture.transcription_condense_failed", {
          level: "warn",
          captureId: work.capture.id,
          error: errorMetadata(error)
        });
      }
      return {
        ...transcription,
        polishedText,
        polishErrorCode,
        condensedText,
        condenseErrorCode,
        updatedAt: now()
      };
    });
  }

  return { prepareCaptureAsrAudio, transcribeCapture };
}
