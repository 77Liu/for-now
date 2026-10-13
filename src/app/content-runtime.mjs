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
  dispatchBackground,
  runDeepSeek,
  readAiUsage = async () => ({ entries: [] }),
  recordCompressionDailyBudgetCny = 0,
  recordCompressionPerCallBudgetCny = 0,
  recordCompressionMaxBackfillDatesPerScan = 1,
  recordCompressionStartDate = "",
  now = () => new Date().toISOString(),
  today,
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID(),
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
    createId,
    now,
    hash
  });
  const recordCompressionService = createRecordCompressionService({
    repository,
    getAccountId,
    getTimezone,
    now,
    createId,
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
  const contentRepository = createPerceptionAwareRepository({
    repository,
    perception: perceptionRuntime,
    createTask: (store, input) => backgroundAi?.createInStore(store, input),
    scheduleTask: taskId => backgroundAi?.schedule(taskId),
    refreshTaskInputs: (store, taskIds) => backgroundAi?.refreshQueuedTaskInputs(store, taskIds),
    onStoreMutation: (store, beforeStore) => {
      const staleRunningTaskIds = recordCompressionService.invalidateChangedSources(store, beforeStore);
      for (const taskId of staleRunningTaskIds) backgroundAi?.cancel(taskId);
    }
  });
  const foundation = createContentFoundation({
    repository: contentRepository,
    trashRetentionDays,
    getAccountId,
    cancelTask: taskId => backgroundAi?.cancel(taskId) || false,
    now,
    createId,
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
    createId
  });
  const records = createContentRecords({
    repository,
    sourceRepository: contentRepository,
    foundation,
    contentAttachments: contentAttachmentService,
    getCursorScope,
    now,
    createId
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
  const background = createContentBackground({
    repository: contentRepository,
    annotationService: foundation.annotationService,
    contentAttachments: contentAttachmentService,
    perception: perceptionRuntime,
    recordCompressionTarget: recordCompressionService.target,
    getRecentTrend,
    mediaRuntime,
    getAccountId,
    backgroundContextKey,
    dispatchBackground,
    runDeepSeek: observedRunDeepSeek,
    now,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch: observedDebugFetch
  });
  backgroundAi = background.backgroundAi;
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
    now,
    today,
    currentTime,
    createId,
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
    perception,
    updateSourceStore: operation => contentRepository.update(operation),
    trashCommands
  };
}
