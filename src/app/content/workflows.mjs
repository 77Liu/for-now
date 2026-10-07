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
  now,
  today,
  currentTime,
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
    getAccountId,
    materializeAttachmentFiles,
    contextKey: workflowContextKey,
    now
  });
  const captureJournalWorkflows = createCaptureJournalWorkflows({
    repository,
    journals: records.journalRecords,
    generate: runDeepSeek,
    hash,
    contextKey: workflowContextKey,
    today
  });
  const reviewChatWorkflows = createReviewChatWorkflows({
    repository,
    chats: records.chatRecords,
    reviews: records.reviewRecords,
    generate: runDeepSeek,
    hash,
    contextKey: workflowContextKey,
    getAccountId,
    currentTime
  });

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
