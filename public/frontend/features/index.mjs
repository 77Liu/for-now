export function createPageEffects({
  loadStatistics,
  loadAiCostPlan,
  loadArchitecture,
  loadCommercialization,
  loadTrash
}) {
  return Object.freeze({
    statistics: () => loadStatistics(),
    "ai-cost": () => loadAiCostPlan(),
    architecture: () => loadArchitecture(),
    commercialization: () => loadCommercialization(),
    trash: () => loadTrash()
  });
}

export {
  createActionsCoordinator,
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
  createHomeFeatureController,
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
  createOnboardingV2Controller,
  mergeOnboardingV2Conflict,
  onboardingV2ConflictRows,
  onboardingV2DraftFromState,
  onboardingV2PendingResolution,
  onboardingV2PatchFromDraft
} from "./onboarding-v2/index.mjs";
