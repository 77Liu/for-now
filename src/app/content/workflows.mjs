import { errorMetadata } from "../../shared/observability/index.mjs";
import { publicAiTask } from "../../modules/tasks/index.mjs";
import { createCaptureJournalWorkflows } from "../capture-journal-workflows.mjs";
import { personalContextProjection } from "../personal-context.mjs";
import { withoutOwnerMetadata } from "../public-state.mjs";
import { createReviewChatWorkflows } from "../review-chat-workflows.mjs";
import { createThoughtWorkflows } from "../thought-workflows.mjs";
import { createUserModelExtractionService } from "../user-model.mjs";

export function createContentWorkflows({
  repository,
  records,
  backgroundAi,
  trashMutations,
  runDeepSeek,
  workflowContextKey,
  now,
  today,
  currentTime,
  hash,
  logEvent
}) {
  const thoughtWorkflows = createThoughtWorkflows({
    repository,
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
    contextKey: workflowContextKey
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
      return includeOwnerMetadata ? projection : withoutOwnerMetadata(projection);
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
