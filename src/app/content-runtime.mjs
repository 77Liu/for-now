import { thoughtSpeechProjection } from "./speech-cache.mjs";
import { thoughtDiscoveryProjection } from "../modules/discovery/index.mjs";
import { createThoughtQueries } from "../modules/thoughts/index.mjs";
import { createNotificationService } from "../modules/notifications/index.mjs";
import { cancelExistingTaskForAccountRecovery } from "../modules/tasks/index.mjs";
import { promptText, renderPrompt } from "../shared/prompts/index.mjs";
import { createImportanceService } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import { legalImportanceMaterial, legalImportanceSources } from "./task-context.mjs";
import crypto from "node:crypto";
import { createContentAttachmentService } from "../modules/content-attachments/index.mjs";
import { keepsakePayload } from "../modules/keepsakes/index.mjs";
import { createContentBackground, enqueueContentImageUnderstanding } from "./content/background.mjs";
import { createContentFoundation, createContentRecords } from "./content/resources.mjs";
import { createContentWorkflows } from "./content/workflows.mjs";
import { createMediaRuntime } from "./media-runtime.mjs";
import {
  createPerceptionAwareRepository,
  createPerceptionRuntime,
  createPerceptionService
} from "./perception.mjs";
import { createTrashCommands } from "./trash.mjs";
import {
  createRecordCompressionService,
  DEFAULT_RECORD_TIMEZONE
} from "./record-compressions.mjs";

const requiredFunction = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`Content runtime ${name} is required`);
};

export function createContentRuntime({
  repository,
  mediaOptions = {},
  trashRetentionDays,
  getAccountId,
  getTimezone = () => DEFAULT_RECORD_TIMEZONE,
  getCursorScope = getAccountId,
  backgroundContextKey,
  workflowContextKey,
  accountRuntime = null,
  dispatchBackground,
  runDeepSeek,
  readAiUsage = async () => ({ entries: [] }),
  getImportanceModelChoice = async () => null,
  getImportanceModelSnapshot = () => null,
  recordCompressionDailyBudgetCny = 0,
  recordCompressionPerCallBudgetCny = 0,
  recordCompressionMaxBackfillDatesPerScan = 1,
  recordCompressionStartDate = "",
  recordCommandConfig = null,
  thoughtPagingConfig = null,
  now = () => new Date().toISOString(),
  today,
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID(),
  createBusinessId = createId,
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  logEvent,
  debugServerUrl = "",
  debugRunId = "",
  debugFetch = fetch,
  mediaFactory = createMediaRuntime,
  effectObserver = null
} = {}) {
  if (!repository?.read || !repository?.update || !repository?.executeIdempotent) {
    throw new TypeError("Content runtime repository is required");
  }
  for (const [value, name] of [
    [getAccountId, "getAccountId"],
    [getCursorScope, "getCursorScope"],
    [backgroundContextKey, "backgroundContextKey"],
    [workflowContextKey, "workflowContextKey"],
    [dispatchBackground, "dispatchBackground"],
    [runDeepSeek, "runDeepSeek"],
    [today, "today"],
    [createId, "createId"],
    [createBusinessId, "createBusinessId"],
    [hash, "hash"],
    [logEvent, "logEvent"],
    [debugFetch, "debugFetch"],
    [mediaFactory, "mediaFactory"]
  ]) requiredFunction(value, name);
  if (effectObserver !== null && typeof effectObserver !== "function") {
    throw new TypeError("Content runtime effectObserver must be a function");
  }

  const observedRunDeepSeek = effectObserver
    ? (...args) => {
        effectObserver("provider", "deepseek");
        return runDeepSeek(...args);
      }
    : runDeepSeek;
  const observedDebugFetch = effectObserver
    ? (...args) => {
        effectObserver("outbound", "debug");
        return debugFetch(...args);
      }
    : debugFetch;

  let backgroundAi;
  let mediaRuntime;
  const perceptionRuntime = createPerceptionRuntime({
    getAccountId,
    createId: createBusinessId,
    now,
    hash
  });
  const recordCompressionService = createRecordCompressionService({
    repository,
    getAccountId,
    getTimezone,
    now,
    createId: createBusinessId,
    hash,
    readAiUsage,
    dailyBudgetCny: recordCompressionDailyBudgetCny,
    perCallBudgetCny: recordCompressionPerCallBudgetCny,
    maxBackfillDatesPerScan: recordCompressionMaxBackfillDatesPerScan,
    startDate: recordCompressionStartDate
  });
  const getRecentTrend = (store, asOf) => (
    recordCompressionService.getCurrentTrend(store, asOf)
  );
  const thoughtQueries = createThoughtQueries({
    repository,
    enabled: thoughtPagingConfig?.enabled === true,
    speechProjection: thoughts => thoughtSpeechProjection(thoughts, hash),
    discoveryProjection: thoughtDiscoveryProjection
  });
  const contentRepository = createPerceptionAwareRepository({
    repository,
    perception: perceptionRuntime,
    createTask: (store, input) => backgroundAi?.createInStore(store, input),
    scheduleTask: taskId => backgroundAi?.schedule(taskId),
    refreshTaskInputs: (store, taskIds) => backgroundAi?.refreshQueuedTaskInputs(store, taskIds),
    onStoreMutation: (store, beforeStore) => {
      const staleRunningTaskIds = recordCompressionService.invalidateChangedSources(store, beforeStore);
      for (const taskId of staleRunningTaskIds) backgroundAi?.cancel(taskId);
    },
    recordEffects: {
      sourceDates: store => recordCompressionService.sourceMutationDates(store),
      invalidate: (store, beforeStore) => recordCompressionService.invalidateSourceClosure(store, beforeStore),
      cancel: taskId => backgroundAi?.cancel(taskId)
    }
  });
  const foundation = createContentFoundation({
    repository: contentRepository,
    trashRetentionDays,
    getAccountId,
    cancelTask: taskId => backgroundAi?.cancel(taskId) || false,
    now,
    createId: createBusinessId,
    hash
  });
  const contentAttachmentService = createContentAttachmentService({
    repository: contentRepository,
    trash: foundation.trashService,
    attachmentInventory: (...args) => {
      if (!mediaRuntime) throw new Error("Content media runtime is not initialized");
      return mediaRuntime.listAttachmentInventory(...args);
    },
    getAccountId,
    cancelTask: taskId => backgroundAi?.cancel(taskId) || false,
    requestImageUnderstanding: work => (
      enqueueContentImageUnderstanding(backgroundAi, work)
    ),
    now,
    createId: createBusinessId
  });
  const records = createContentRecords({
    repository,
    sourceRepository: contentRepository,
    thoughtQueries,
    foundation,
    contentAttachments: contentAttachmentService,
    getCursorScope,
    now,
    createId: createBusinessId
  });
  mediaRuntime = mediaFactory({
    ...mediaOptions,
    repository: contentRepository,
    books: records.bookRecords,
    quotes: records.quoteRecords,
    parseKeepsake: keepsakePayload,
    moveCollectionItemToTrash: foundation.trashMutations.moveCollectionItemToTrash,
    moveNestedItemToTrash: foundation.trashMutations.moveNestedItemToTrash,
    runDeepSeek: observedRunDeepSeek,
    now,
    today,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch: observedDebugFetch
  });
  if (effectObserver) {
    // 启动门通过代理记录媒体端口的实际调用，方法仍绑定原端口对象。
    mediaRuntime = new Proxy(mediaRuntime, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return (...args) => {
          effectObserver("media", String(property));
          return value.apply(target, args);
        };
      }
    });
  }
  const prepareImportanceContext = async () => {
    try {
      return await getImportanceModelChoice();
    } catch {
      return null;
    }
  };
  const importanceService = createImportanceService({ repository: contentRepository,
    accountId: getAccountId, createBusinessId, list: store => legalImportanceSources(store, getAccountId()),
    resolve: (store, sourceRef) => legalImportanceMaterial(store, sourceRef, getAccountId()),
    modelChoice: getImportanceModelChoice, currentChoice: getImportanceModelSnapshot, hash, now, promptText, renderPrompt });
  const background = createContentBackground({
    createBusinessId,
    cleanupExistingTask: accountRuntime?.enabled ? async task => {
      try { accountRuntime.authorize(); return false; } catch (error) { if (!String(error.code || "").startsWith("ACCOUNT_")) throw error; }
      await accountRuntime.cleanupTask(task, () => repository.update(store => {
        if (!cancelExistingTaskForAccountRecovery(store.aiTasks, task.id, task.attempt, now)) return;
        const current = store.aiTasks.find(item => item.id === task.id);
        if (store.notifications.some(item => item.taskId === task.id)) {
          createNotificationService({ createId: createBusinessId, now }).upsertTask(store.notifications, current, "cancelled", current.error);
        }
      }));
      return true;
    } : null,
    repository: contentRepository,
    annotationService: foundation.annotationService,
    contentAttachments: contentAttachmentService,
    perception: perceptionRuntime,
    recordCompressionTarget: recordCompressionService.target,
    importanceTarget: importanceService.target,
    getImportanceModelSnapshot,
    prepareImportanceContext,
    getRecentTrend,
    mediaRuntime,
    getAccountId,
    backgroundContextKey,
    dispatchBackground,
    runDeepSeek: observedRunDeepSeek,
    now,
    createId,
    recordCommandConfig,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch: observedDebugFetch
  });
  backgroundAi = background.backgroundAi;
  importanceService.attach(backgroundAi);
  const resumeBackground = backgroundAi.resume.bind(backgroundAi);
  backgroundAi.resume = async () => {
    await resumeBackground();
    await importanceService.batches?.pump();
  };
  const recordCompressionJobs = recordCompressionService.attach(backgroundAi);
  const perception = createPerceptionService({
    repository: contentRepository,
    runtime: perceptionRuntime,
    backgroundAi
  });
  const workflows = createContentWorkflows({
    repository,
    sourceRepository: contentRepository,
    records,
    backgroundAi,
    trashMutations: foundation.trashMutations,
    runDeepSeek: observedRunDeepSeek,
    getAccountId,
    materializeAttachmentFiles: mediaRuntime.materializeAttachmentFiles,
    workflowContextKey,
    getRecentTrend,
    getImportanceModelSnapshot,
    recordCommandConfig,
    now,
    today,
    currentTime,
    createId,
    createBusinessId,
    hash,
    logEvent
  });
  const trashCommands = createTrashCommands({
    repository: contentRepository,
    trash: foundation.trashService,
    mutations: foundation.trashMutations,
    cleanup: mediaRuntime.attachmentCleanup
  });

  return {
    ...foundation,
    thoughtQueries,
    ...records,
    ...mediaRuntime,
    ...background,
    ...workflows,
    runRecordCompressionScan: options => recordCompressionJobs.scan(options),
    /**
     * 注册或替换日压缩真实终态观察器；持久化后调用，通知错误不改任务状态。
     * @since unreleased
     */
    observeRecordCompressionTasks: observer => recordCompressionService.observeSettlements(observer),
    contentAttachmentService,
    importanceService,
    getImportanceModelSnapshot,
    prepareImportanceContext,
    perception,
    updateSourceStore: operation => contentRepository.update(operation),
    trashCommands
  };
}
