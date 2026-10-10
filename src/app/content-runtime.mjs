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
  now = () => new Date().toISOString(),
  today,
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID(),
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  logEvent,
  debugServerUrl = "",
  debugRunId = "",
  debugFetch = fetch,
  mediaFactory = createMediaRuntime
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
    maxBackfillDatesPerScan: recordCompressionMaxBackfillDatesPerScan
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
    runDeepSeek,
    now,
    today,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch
  });
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
    runDeepSeek,
    now,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch
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
    runDeepSeek,
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
    contentAttachmentService,
    perception,
    updateSourceStore: operation => contentRepository.update(operation),
    trashCommands
  };
}
