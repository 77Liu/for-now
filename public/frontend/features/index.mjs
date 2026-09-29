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
    statistics: () => void loadStatistics(),
    "ai-cost": () => void loadAiCostPlan(),
    commercialization: () => void loadCommercialization(),
    notifications: () => void loadNotifications().then(() => scheduleNotificationPoll()),
    trash: () => void loadTrash()
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
  buildDeleteHabitCheckinCommand
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
  keepsakeMediaSources,
  keepsakeUploadPayload,
  uploadKeepsakeMedia
} from "./keepsakes-media/index.mjs";
