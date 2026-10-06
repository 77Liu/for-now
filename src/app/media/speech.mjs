import { errorMetadata } from "../../shared/observability/index.mjs";
import { createSpeechCache } from "../speech-cache.mjs";
import { createSpeechCacheSweep } from "../speech-cache-sweep.mjs";
import { createAsrWorkflows } from "./asr.mjs";

export function createSpeechRuntime({
  repository,
  attachments,
  cleanup,
  getOwnerId,
  hash,
  now,
  listAccountIds,
  runWithAccount,
  speechProvider,
  speechGate,
  aiBudgetRuntime,
  providerBudgetStage,
  conservativeDeepSeekStage,
  currentBudgetAccountId,
  meteredProviderCall,
  runDeepSeek,
  audioMaxDurationMs,
  logEvent,
  emitDebug
}) {
  if (typeof logEvent !== "function") {
    throw new TypeError("Speech runtime requires logEvent");
  }

  const asr = createAsrWorkflows({
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
    emitDebug
  });
  const speechCache = createSpeechCache({
    repository,
    attachments,
    cleanup,
    getOwnerId,
    hash,
    now
  });
  const speechCacheSweep = createSpeechCacheSweep({
    listAccountIds,
    runWithAccount,
    repository,
    cleanup,
    now,
    onAccountError: (error, { accountId }) => logEvent(
      "system",
      "speech_cache.sweep_account_failed",
      {
        level: "error",
        accountHash: hash(accountId),
        error: errorMetadata(error)
      }
    )
  });

  async function runSpeechCacheSweep() {
    const result = await speechCacheSweep.run();
    await logEvent("system", "speech_cache.sweep_completed", {
      level: result.failed ? "error" : "info",
      ...result
    });
    return result;
  }

  return {
    ...asr,
    speechCache,
    speechCacheSweep,
    runSpeechCacheSweep
  };
}
