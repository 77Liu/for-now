import { errorMetadata } from "../../shared/observability/index.mjs";
import { publicAiTask } from "../../modules/tasks/index.mjs";
import { createCaptureJournalWorkflows } from "../capture-journal-workflows.mjs";
import {
  personalContextProjection,
  personalContextReceiptMatches
} from "../personal-context.mjs";
import { withoutOwnerMetadata } from "../public-state.mjs";
import { createReviewChatWorkflows } from "../review-chat-workflows.mjs";
import { createThoughtWorkflows } from "../thought-workflows.mjs";
import {
  createUserModelExtractionService,
  USER_MODEL_DOMAIN_LABELS,
  userModelCoreReadiness,
  userModelProjection
} from "../user-model.mjs";

export function createContentWorkflows({
  repository,
  sourceRepository = repository,
  records,
  backgroundAi,
  trashMutations,
  runDeepSeek,
  getAccountId,
  materializeAttachmentFiles,
  workflowContextKey,
  getRecentTrend = () => null,
  now,
  today,
  currentTime,
  createId,
  hash,
  logEvent
}) {
  const thoughtWorkflows = createThoughtWorkflows({
    repository: sourceRepository,
    thoughts: records.thoughtService,
    backgroundAi,
    removeChain: (store, id) => (
      trashMutations.moveThoughtChainToTrash(store, id)
    ),
    removeBlock: (store, id) => (
      trashMutations.moveThoughtBlockToTrash(store, id)
    ),
    generate: runDeepSeek,
    hash,
    publicTask: publicAiTask,
    coreModelReadiness: userModelCoreReadiness,
    getAccountId,
    getRecentTrend,
    materializeAttachmentFiles,
    contextKey: workflowContextKey,
    now
  });
  const captureJournalWorkflows = createCaptureJournalWorkflows({
    repository,
    journals: records.journalRecords,
    backgroundAi,
    generate: runDeepSeek,
    hash,
    createId,
    coreModelReadiness: userModelCoreReadiness,
    getRecentTrend,
    currentTime,
    contextKey: workflowContextKey,
    today
  });
  const reviewChatWorkflows = createReviewChatWorkflows({
    repository,
    chats: records.chatRecords,
    reviews: records.reviewRecords,
    backgroundAi,
    generate: runDeepSeek,
    hash,
    coreModelReadiness: userModelCoreReadiness,
    contextKey: workflowContextKey,
    getAccountId,
    getRecentTrend,
    currentTime,
    createId
  });
  backgroundAi.registerHandler("thoughtDraft", thoughtWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("thoughtPrompt", thoughtWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("journalAssist", captureJournalWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("journalReflection", captureJournalWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("chat", reviewChatWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("analysis", reviewChatWorkflows.personalizedTaskHandler);

  return {
    thoughtWorkflows,
    captureJournalWorkflows,
    reviewChatWorkflows,
    userModelExtractions: createUserModelExtractionService({
      repository,
      backgroundAi
    }),
    projectPersonalContext(store, { includeOwnerMetadata = false } = {}) {
      const projection = personalContextProjection(store, { generatedAt: now() });
      const userModel = userModelProjection(store);
      const governed = {
        ...projection,
        overview: {
          ...projection.overview,
          userModel: {
            ...userModel,
            claims: userModel.claims.map(claim => ({
              ...claim,
              domainLabel: USER_MODEL_DOMAIN_LABELS[claim.domain] || claim.domain
            }))
          },
          periodicSyntheses: (Array.isArray(store?.analyses) ? store.analyses : [])
            .filter(item => ["manual", "weekly-background"].includes(item?.reason))
            .slice(0, 5)
            .map(item => {
              const stale = item.reviewStatus === "confirmed"
                && (
                  item.contextReceipt?.permissionPurpose !== "learning"
                  || !personalContextReceiptMatches(store, item.contextReceipt)
                );
              return {
                id: String(item.id || ""),
                content: String(item.content || "").slice(0, 1200),
                reason: item.reason,
                reviewStatus: stale ? "stale" : item.reviewStatus || "legacy",
                reviewedAt: item.reviewedAt || "",
                reviewDisposition: item.reviewDisposition || "",
                createdAt: item.createdAt || "",
                version: Math.max(1, Math.round(Number(item.version) || 1))
              };
            })
        }
      };
      return includeOwnerMetadata ? governed : withoutOwnerMetadata(governed);
    },
    async maybeRunPeriodicAnalysis() {
      try {
        const result = await reviewChatWorkflows.maybeRunPeriodicAnalysis();
        if (result) {
          await logEvent("system", "analysis.completed", { level: "info" });
        }
        return result;
      } catch (error) {
        await logEvent("system", "analysis.failed", {
          level: "error",
          error: errorMetadata(error)
        });
        return null;
      }
    }
  };
}
