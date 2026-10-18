import { errorMetadata } from "../../shared/observability/index.mjs";
import {
  createTaskLifecycle,
  publicAiTask
} from "../../modules/tasks/index.mjs";
import { createNotificationService } from "../../modules/notifications/index.mjs";
import {
  createThoughtTaskTarget,
  stripThoughtAnswerLead
} from "../../modules/thoughts/index.mjs";
import { createCaptureJournalWorkflows } from "../capture-journal-workflows.mjs";
import {
  personalContextProjection,
  personalContextReceiptMatches
} from "../personal-context.mjs";
import { withoutOwnerMetadata } from "../public-state.mjs";
import { createReviewChatWorkflows } from "../review-chat-workflows.mjs";
import { createThoughtWorkflows } from "../thought-workflows.mjs";
import { createThoughtRecordCommands } from "../record-commands/thoughts.mjs";
import {
  createUserModelExtractionService,
  USER_MODEL_DOMAIN_LABELS,
  userModelCoreReadiness,
  userModelProjection
} from "../user-model.mjs";

const list = value => Array.isArray(value) ? value : [];
const COMPRESSION_SOURCE_VIEWS = Object.freeze({
  checkin: "today",
  dailyRecord: "daily",
  thought: "thoughts",
  journal: "journals",
  capture: "captures",
  quote: "quotes",
  keepsake: "keepsakes"
});

export function projectRecordCompressionTrendForUser(trend) {
  if (!trend || !Array.isArray(trend.displayDays)) return null;

  const eligibleSources = new Map();
  for (const day of trend.displayDays) {
    const manifest = new Map(list(day?.summary?.sourceManifest)
      .filter(source => source?.origin === "user_original" && source?.sourceId)
      .map(source => [source.sourceId, source]));
    for (const source of list(trend.displaySources)) {
      if (source?.localDate !== day.localDate || !manifest.has(source.sourceId)) continue;
      const sourceRef = manifest.get(source.sourceId);
      eligibleSources.set(`${day.localDate}:${source.sourceId}`, {
        id: `${day.localDate}:${source.sourceId}`,
        resourceType: sourceRef.resourceType,
        resourceId: sourceRef.recordId,
        recordType: sourceRef.subtype,
        informationType: "user_original",
        occurredOn: day.localDate,
        version: sourceRef.version,
        excerpt: source.text,
        location: {
          view: COMPRESSION_SOURCE_VIEWS[sourceRef.resourceType] || "",
          targetId: sourceRef.recordId,
          rootId: sourceRef.rootId || "",
          targetKey: sourceRef.targetKey || "",
          occurredOn: day.localDate
        }
      });
    }
  }

  const projectRows = (rows, localDate) => list(rows).flatMap(row => {
    const sourceIds = [...new Set(list(row?.sourceIds))];
    if (typeof row?.text !== "string" || !row.text.trim() || !sourceIds.length
      || sourceIds.some(id => !eligibleSources.has(`${localDate}:${id}`))) return [];
    return [{
      text: row.text,
      sources: sourceIds.map(id => eligibleSources.get(`${localDate}:${id}`))
    }];
  });

  return {
    timezone: String(trend.timezone || ""),
    failureState: trend.failureState,
    localDates: list(trend.localDates).slice(),
    coverage: {
      windowDays: Math.max(0, Number(trend.coverage?.windowDays) || 0),
      summaryDays: Math.max(0, Number(trend.coverage?.summaryDays) || 0),
      missingDays: Math.max(0, Number(trend.coverage?.missingDays) || 0),
      missingDates: list(trend.coverage?.missingDates).slice(),
      partialDays: Math.max(0, Number(trend.coverage?.partialDays) || 0),
      truncatedDays: Math.max(0, Number(trend.coverage?.truncatedDays) || 0)
    },
    disclosure: "以下是 AI 对当前获准原始记录的整理，可能有遗漏或误读，不代表你直接说过这些话。每条整理均附可核对的原始来源。",
    days: trend.displayDays.map(day => {
      const summary = day?.summary;
      const localDate = String(day?.localDate || "");
      if (!summary) return {
        localDate,
        ...(day.slots ? { slots: day.slots, missingSlots: day.missingSlots } : {}),
        status: "missing",
        completeness: "unknown",
        daily: [],
        thoughts: [],
        themes: [],
        metrics: []
      };
      const metrics = list(summary.metrics).flatMap(metric => {
        const sourceIds = [...new Set(list(metric?.sourceIds))];
        if (!sourceIds.length
          || sourceIds.some(id => !eligibleSources.has(`${localDate}:${id}`))) return [];
        return [{
          name: String(metric.metric || ""),
          value: metric.value,
          unit: String(metric.unit || ""),
          sources: sourceIds.map(id => eligibleSources.get(`${localDate}:${id}`))
        }];
      });
      return {
        localDate,
        ...(summary.incrementalSlots ? { window: summary.window, incrementalSlots: summary.incrementalSlots,
          summaryIds: summary.summaryIds, sourceManifestHashes: summary.sourceManifestHashes } : {}),
        ...(day.slots ? { slots: day.slots, missingSlots: day.missingSlots } : {}),
        status: "ready",
        completeness: String(day.completeness || "unknown"),
        daily: projectRows(summary.daily?.observations, localDate),
        thoughts: [
          ...projectRows(summary.thoughtsIdeas?.focus, localDate),
          ...projectRows(summary.thoughtsIdeas?.changes, localDate)
        ],
        themes: projectRows(summary.other?.themes, localDate),
        metrics
      };
    })
  };
}

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
  getImportanceModelSnapshot = () => null,
  recordCommandConfig = null,
  now,
  today,
  currentTime,
  createId,
  createBusinessId = createId,
  hash,
  logEvent
}) {
  const recordTaskService = createTaskLifecycle({
    createId: createBusinessId,
    now,
    hash
  });
  const recordNotificationService = createNotificationService({
    createId: createBusinessId,
    now
  });
  const recordThoughtTarget = createThoughtTaskTarget({
    createId: createBusinessId,
    now,
    stripThoughtAnswerLead
  });
  const thoughtRecordCommands = sourceRepository.accountUnitOfWork?.run
    ? createThoughtRecordCommands({
        unitOfWork: sourceRepository.accountUnitOfWork,
        effects: sourceRepository.sourceMutationEffects,
        thoughts: records.thoughtService,
        removeChain: (store, id) => trashMutations.moveThoughtChainToTrash(store, id),
        removeBlock: (store, id) => trashMutations.moveThoughtBlockToTrash(store, id),
        createTaskInStore: (store, input, options) => (
          backgroundAi.createInStore(store, input, options)
        ),
        tasks: recordTaskService,
        notifications: recordNotificationService,
        thoughtTarget: recordThoughtTarget,
        now
      })
    : null;
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
    getImportanceModelSnapshot,
    materializeAttachmentFiles,
    recordCommands: {
      enabled: name => recordCommandConfig?.enabled?.(name) === true,
      thoughts: thoughtRecordCommands
    },
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
    getImportanceModelSnapshot,
    getAccountId,
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
    getImportanceModelSnapshot,
    currentTime,
    createId
  });
  backgroundAi.registerHandler("thoughtDraft", thoughtWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("thoughtPrompt", thoughtWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("journalAssist", captureJournalWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("journalReflection", captureJournalWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("chat", reviewChatWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("analysis", reviewChatWorkflows.personalizedTaskHandler);
  backgroundAi.registerRecordCommand("thought.aiWriteback", thoughtRecordCommands);
  backgroundAi.assertRecordCommandsReady();

  return {
    thoughtRecordCommands,
    thoughtWorkflows,
    captureJournalWorkflows,
    reviewChatWorkflows,
    userModelExtractions: createUserModelExtractionService({
      repository,
      backgroundAi
    }),
    projectPersonalContext(store, { includeOwnerMetadata = false } = {}) {
      const generatedAt = now();
      const projection = personalContextProjection(store, { generatedAt });
      const recordCompressionTrend = projectRecordCompressionTrendForUser(
        getRecentTrend(store, generatedAt)
      );
      const userModel = userModelProjection(store);
      const governed = {
        ...projection,
        overview: {
          ...projection.overview,
          recordCompressionTrend,
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
