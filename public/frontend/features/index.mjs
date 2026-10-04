export function createPageEffects({
  requestFrame = globalThis.requestAnimationFrame,
  syncCaptureOverflow,
  syncQuoteOverflow,
  setupQuoteBubbleScroll,
  stopQuoteBubbleScroll,
  loadStatistics,
  loadAiCostPlan,
  loadArchitecture,
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
    architecture: () => loadArchitecture(),
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
  commentSubmissionIntent,
  copyAnnotationContent,
  groupAnnotationLineCounts,
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
  KEEPSAKE_ALPHA_THRESHOLD,
  KEEPSAKE_BOUNDS_PADDING_RATIO,
  applyKeepsakeImageCandidates,
  createKeepsakeBatchItems,
  discardKeepsakeMedia,
  keepsakePlacementCss,
  keepsakeMediaSources,
  keepsakeUploadPayload,
  nextKeepsakeBatchIndex,
  scanKeepsakeAlpha,
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
export {
  createOnboardingV2Controller,
  mergeOnboardingV2Conflict,
  onboardingV2ConflictRows,
  onboardingV2DraftFromState,
  onboardingV2PendingResolution,
  onboardingV2PatchFromDraft
} from "./onboarding-v2/index.mjs";
export {
  notificationEntryMarkup,
  notificationEntryState,
  transitionNotificationRetry
} from "./notifications/index.mjs";
