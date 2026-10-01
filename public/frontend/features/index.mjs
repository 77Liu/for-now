export function createPageEffects({
  requestFrame = globalThis.requestAnimationFrame,
  syncCaptureOverflow,
  syncQuoteOverflow,
  setupQuoteBubbleScroll,
  stopQuoteBubbleScroll,
  loadStatistics,
  loadAiCostPlan,
  loadCommercialization,
  loadNotifications,
  scheduleNotificationPoll,
  loadTrash
}) {
  return Object.freeze({
    captures: () => requestFrame(syncCaptureOverflow),
    quotes: () => requestFrame(() => {
      syncQuoteOverflow();
      setupQuoteBubbleScroll();
    }),
    leaveQuotes: () => stopQuoteBubbleScroll(),
    statistics: () => loadStatistics(),
    "ai-cost": () => loadAiCostPlan(),
    commercialization: () => loadCommercialization(),
    notifications: () => loadNotifications().then(() => scheduleNotificationPoll()),
    trash: () => loadTrash()
  });
}

export {
  DISCOVERY_GENRES,
  createThoughtDiscoveryController,
  backgroundResultFromSnapshot,
  backgroundTaskTarget,
  createBackgroundResultController,
  mergeBackgroundTaskResult,
  annotationMenuItems,
  annotationPresentation,
  copyAnnotationContent,
  sortAnnotationItemsByPosition
} from "./thought-discovery/index.mjs";
export { createDownloadDescriptor } from "./export/index.mjs";
export {
  createActionsViewModel,
  buildCreateActionCommand,
  buildUpdateActionCommand,
  buildSetActionStatusCommand,
  buildCompleteActionCommand,
  buildUndoActionCompletionCommand,
  buildDeleteActionCommand,
  buildCreateHabitCommand,
  buildSetHabitEnabledCommand,
  buildHabitAdjustmentCommand,
  buildHabitCheckinCommand,
  buildDeleteHabitCommand,
  buildDeleteHabitCheckinCommand,
  projectActionCommand
} from "./actions/index.mjs";
export {
  feedbackSubmissionPayload,
  feedbackViewModel,
  validationLedgerViewModel
} from "./feedback/index.mjs";
export {
  buildHomeMoodSeries,
  createHomeMemoryPool,
  isAiDerivedHomeContent,
  selectHomeMemories
} from "./home/index.mjs";
export {
  KEEPSAKE_BATCH_MAX_ITEMS,
  applyKeepsakeImageCandidates,
  createKeepsakeBatchItems,
  discardKeepsakeMedia,
  keepsakeMediaSources,
  keepsakeUploadPayload,
  nextKeepsakeBatchIndex,
  uploadKeepsakeMedia
} from "./keepsakes-media/index.mjs";
export {
  WEIGHT_BATCH_MAX_ITEMS,
  applyWeightBatchRecognition,
  changeWeightBatchDate,
  createWeightBatchItems,
  nextWeightBatchIndex,
  recognizedWeightDate,
  validWeightBatchDate,
  weightBatchRecordInput
} from "./health/weight-batch.mjs";
