import { openingPreferences } from "../../public/frontend/shared/opening/index.mjs";
import path from "node:path";
import {
  createApiV1Http,
  createContentAttachmentsHttp,
  createLegacyApi,
  createOwnerHttp,
  createPersonalContextHttp,
  createReviewsChatHttp,
  createStartupHttp,
  createSyncHttp,
  openApiV1,
  registerApiV1
} from "../http/index.mjs";
import {
  capabilitiesFor,
  isOwner,
  publicUser
} from "../modules/auth/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import {
  architectureOwnerSurface,
  commercializationOwnerSurface
} from "../modules/owner-surfaces/index.mjs";
import { pruneLogs } from "../shared/observability/index.mjs";
import { eventTimeFields } from "../shared/time/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import {
  recordCompressionAccountQueueAllowance,
  recordCompressionSlotQueueAllowance
} from "../config/index.mjs";
import { createRuntimeContentHttp } from "./runtime-content-http.mjs";
import { createRuntimePlatformHttp } from "./runtime-platform-http.mjs";
import { createStatisticsRuntime } from "./statistics-runtime.mjs";
import { normalizeCommercialization } from "./store-normalization.mjs";
import {
  DEFAULT_RECORD_TIMEZONE,
  recordCompressionAccountOrder,
  RECORD_COMPRESSION_TASK_KIND
} from "./record-compressions.mjs";
import {
  routeStateProjection,
  startupProjection
} from "./startup-projections.mjs";

export function createRetryableSlotRunner() {
  let lastCompletedSlot = "";
  let runningSlot = "";
  return async (slotKey, operation) => {
    if (slotKey === lastCompletedSlot || runningSlot) return { skipped: "outside-slot" };
    runningSlot = slotKey;
    try {
      const result = await operation();
      lastCompletedSlot = slotKey;
      return result;
    } finally {
      if (runningSlot === slotKey) runningSlot = "";
    }
  };
}

export function createRuntimeHttpWiring({
  appConfig,
  releaseVersion,
  paths,
  httpLimits,
  clock,
  identifiers,
  observability,
  persistence,
  aiRuntime,
  contentRuntime,
  domainServices,
  publicStateFromStore,
  access
}) {
  const { now, today } = clock;
  const { createId } = identifiers;
  const { requestStorage, logEvent } = observability;
  const {
    storeRepository,
    storagePaths,
    readStore,
    updateStore
  } = persistence;
  const {
    ensureAiUsage,
    readAiUsage,
    aiCosts,
    ensureAuditLogs
  } = aiRuntime;
  const {
    chatRecords,
    reviewRecords,
    contentAttachmentService,
    reviewChatWorkflows,
    projectPersonalContext,
    maybeRunPeriodicAnalysis,
    runSpeechCacheSweep,
    runRecordCompressionScan
  } = contentRuntime;
  const {
    sendJson,
    bodyJson,
    userDataDir,
    readAuth
  } = access;
  const platformHttp = createRuntimePlatformHttp({
    appConfig,
    httpLimits,
    clock,
    identifiers,
    observability,
    persistence,
    aiRuntime,
    contentRuntime,
    access
  });
  const contentHttp = createRuntimeContentHttp({
    clock,
    identifiers,
    observability,
    persistence,
    contentRuntime,
    domainServices,
    publicStateFromStore,
    access,
    platformHttp
  });
  const { statisticsService } = createStatisticsRuntime({
    repository: storeRepository,
    ensureAiUsage,
    readAiUsage,
    logsDirectory: () => storagePaths().logsDir,
    aiDashboard: (usage, from, to, cnyPerUsd) => (
      aiCosts.dashboard(usage, from, to, cnyPerUsd)
    ),
    today
  });
  const ownerHttp = createOwnerHttp({
    architectureSurface: architectureOwnerSurface,
    commercializationSurface: commercializationOwnerSurface,
    normalizeCommercialization,
    statistics: statisticsService,
    readStore,
    updateStore,
    bodyJson,
    sendJson,
    now,
    today
  });
  const reviewsChatHttp = createReviewsChatHttp({
    chatRecords,
    reviewRecords,
    workflows: reviewChatWorkflows,
    statistics: statisticsService,
    remove: contentHttp.removeVersionedCollection,
    eventTimeFields,
    bodyJson,
    sendJson,
    sendTrashResult: platformHttp.sendTrashResult,
    canAccessOwner: () => isOwner(requestStorage.getStore()?.user)
  });
  const contentAttachmentsHttp = createContentAttachmentsHttp({
    contentAttachments: contentAttachmentService,
    bodyJson
  });
  const apiV1 = createApiV1Http({
    sendJson,
    getContext: () => requestStorage.getStore(),
    openApi: openApiV1
  });
  const onboardingV2Handler = async (req, res, url, v1) => {
    const handled = await platformHttp.onboardingV2Http.handleV1(req, res, url, v1);
    if (handled !== false
      && req.method === "PATCH"
      && url.pathname === "/api/v1/onboarding-v2/session"
      && Number(res.statusCode || 200) < 400) {
      try {
        await contentRuntime.backgroundAi?.releaseWaiting?.();
      } catch (error) {
        await logEvent("system", "ai_task.waiting_release_failed", {
          level: "error",
          message: error?.message || String(error)
        });
      }
    }
    return handled;
  };
  const runRecordCompressionSlot = createRetryableSlotRunner();
  async function runRecordCompressionScheduler() {
    if (!appConfig.recordCompressionEnabled) return { disabled: true };
    const timestamp = now();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
      timeZone: DEFAULT_RECORD_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    const slotKey = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    const due = (parts.hour === "06" && parts.minute === "00")
      || (parts.hour === "18" && parts.minute === "05");
    if (!due) return { skipped: "outside-slot" };
    return runRecordCompressionSlot(slotKey, async () => {
      const users = appConfig.authRequired
        ? (await readAuth()).users
        : [{ id: "local" }];
      const eligibleUsers = Array.isArray(users) ? users : [];
      let knownCalls = 0;
      let reservedCalls = 0;
      let knownSpentCny = 0;
      let reservedCny = 0;
      let queued = 0;
      let skipped = 0;
      let waitingBudgetCount = 0;
      let promotedBudgetWaitCount = 0;
      let invalidatedBudgetWaitCount = 0;
      let skippedBudgetWaitCount = 0;
      const accountUsageById = new Map();
      const globalDay = `${parts.year}-${parts.month}-${parts.day}`;
      const contextFor = user => ({
        user,
        traceId: createId(),
        dataDir: appConfig.authRequired ? userDataDir(user) : paths.dataDir,
        secrets: [],
        route: "background/record-compression"
      });
      for (const user of eligibleUsers) {
        const accountUsage = await requestStorage.run(contextFor(user), async () => {
          const [usage, store] = await Promise.all([readAiUsage(), readStore()]);
          const dailyEntries = (Array.isArray(usage?.entries) ? usage.entries : [])
            .filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
              && Number.isFinite(Date.parse(entry.createdAt))
              && new Intl.DateTimeFormat("en-CA", {
                timeZone: DEFAULT_RECORD_TIMEZONE,
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
              }).format(new Date(entry.createdAt)) === globalDay);
          const accountSpent = dailyEntries
            .reduce((sum, entry) => {
              if (entry.costKnown !== true || !Number.isFinite(entry.costCny)) {
                return Number.POSITIVE_INFINITY;
              }
              return sum + entry.costCny;
            }, 0);
          const activeTasks = (Array.isArray(store?.aiTasks) ? store.aiTasks : [])
            .filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
              && ["queued", "running"].includes(task.status)).length;
          return { accountSpent, activeTasks, invocations: dailyEntries.length };
        });
        accountUsageById.set(String(user.id || "local"), accountUsage);
        knownSpentCny += accountUsage.accountSpent;
        knownCalls += accountUsage.invocations;
        reservedCny += accountUsage.activeTasks * appConfig.recordCompressionPerCallBudgetCny;
        reservedCalls += accountUsage.activeTasks;
      }
      const dailyCapacity = appConfig.recordCompressionDailyInvocationLimit;
      const perCallBudgetCny = appConfig.recordCompressionPerCallBudgetCny;
      const maxCallsForBudget = remainingCny => {
        if (!(perCallBudgetCny > 0) || !Number.isFinite(remainingCny)) return 0;
        const remainingMicros = Math.floor(Math.max(0, remainingCny) * 1_000_000);
        const perCallMicros = Math.ceil(perCallBudgetCny * 1_000_000);
        return perCallMicros > 0 ? Math.floor(remainingMicros / perCallMicros) : 0;
      };
      const { orderedUsers } = recordCompressionAccountOrder(eligibleUsers, {
        globalDay,
        knownCalls,
        reservedCalls
      });
      for (let index = 0; index < orderedUsers.length; index += 1) {
        const user = orderedUsers[index];
        const accountUsage = accountUsageById.get(String(user.id || "local")) || {
          invocations: 0,
          activeTasks: 0
        };
        const remainingCalls = Math.max(0, dailyCapacity - knownCalls - reservedCalls);
        const accountRemainingCalls = recordCompressionAccountQueueAllowance({
          dailyLimit: appConfig.recordCompressionAccountDailyInvocationLimit,
          knownCalls: accountUsage.invocations,
          reservedCalls: accountUsage.activeTasks
        });
        const remainingBudget = appConfig.recordCompressionDailyBudgetCny
          - knownSpentCny - reservedCny;
        const availableQueueAllowance = Math.min(
          remainingCalls,
          accountRemainingCalls,
          maxCallsForBudget(remainingBudget)
        );
        const slot = parts.hour === "06" ? "morning" : "evening";
        const maxQueued = recordCompressionSlotQueueAllowance(slot, availableQueueAllowance);
        const scanResult = await requestStorage.run(contextFor(user), () => (
          runRecordCompressionScan({ asOf: timestamp, slot, maxQueued })
        ));
        waitingBudgetCount += Number.isSafeInteger(scanResult?.waitingBudgetCount)
          ? Math.max(0, scanResult.waitingBudgetCount)
          : 0;
        promotedBudgetWaitCount += Number.isSafeInteger(scanResult?.promotedBudgetWaitCount)
          ? Math.max(0, scanResult.promotedBudgetWaitCount)
          : 0;
        invalidatedBudgetWaitCount += Number.isSafeInteger(scanResult?.invalidatedBudgetWaitCount)
          ? Math.max(0, scanResult.invalidatedBudgetWaitCount)
          : 0;
        skippedBudgetWaitCount += Number.isSafeInteger(scanResult?.skippedBudgetWaitCount)
          ? Math.max(0, scanResult.skippedBudgetWaitCount)
          : 0;
        const accountQueued = Number.isSafeInteger(scanResult?.queuedCount)
          ? Math.max(0, scanResult.queuedCount)
          : (scanResult?.queued || scanResult?.retried ? 1 : 0);
        if (accountQueued) {
          queued += accountQueued;
          reservedCalls += accountQueued;
          reservedCny += accountQueued * perCallBudgetCny;
        } else if (!scanResult?.waitingBudgetCount) {
          skipped += 1;
        }
      }
      return {
        slotKey,
        queued,
        queuedCount: queued,
        waitingBudgetCount,
        promotedBudgetWaitCount,
        invalidatedBudgetWaitCount,
        skippedBudgetWaitCount,
        skipped,
        knownCalls,
        reservedCalls,
        knownSpentCny,
        reservedCny
      };
    });
  }
  const readOpeningPreferences = async user => {
    if (!isOwner(user)) return undefined;
    try { return openingPreferences((await aiRuntime.readLlmSettings()).opening); }
    catch { return openingPreferences(); }
  };
  const startupHttp = createStartupHttp({
    readStartup: async () => {
      const store = await readStore();
      const user = requestStorage.getStore()?.user;
      return startupProjection({
        store,
        user: publicUser(user),
        version: appConfig.version,
        releaseVersion,
        openingPreferences: await readOpeningPreferences(user),
        capabilities: capabilitiesFor(user),
        features: appConfig.features,
        governanceUrl: isOwner(user) && appConfig.platform.serviceTokenHash
          ? "/platform/"
          : "",
        unread: notificationUnread(store.notifications)
      });
    },
    readRouteState: async route => ({
      ...routeStateProjection(
        publicStateFromStore(await readStore()),
        {
          ...route,
          currentDate: today(),
          cursorScope: safeText(requestStorage.getStore()?.user?.id, 100) || "local"
        }
      ),
      _routeProjection: { view: route.view, complete: false }
    })
  });
  const syncHttp = createSyncHttp({
    repository: storeRepository,
    publicState: publicStateFromStore
  });
  const personalContextHttp = createPersonalContextHttp({
    readStore,
    project: store => projectPersonalContext(store, {
      includeOwnerMetadata: isOwner(requestStorage.getStore()?.user)
    })
  });
  registerApiV1(apiV1, {
    startup: startupHttp.handleV1,
    sync: syncHttp.handleV1,
    personalContext: personalContextHttp.handleV1,
    aiBudget: platformHttp.aiBudgetHttp.handleV1,
    onboardingV2: onboardingV2Handler,
    userModel: platformHttp.userModelHttp.handleV1,
    thoughts: contentHttp.thoughtHttp.handleV1,
    checkins: contentHttp.checkinHttp.handleV1,
    health: contentHttp.healthRecordHttp.handleV1,
    discovery: contentHttp.discoveryHttp.handleV1,
    exports: contentHttp.exportHttp.handleV1,
    actions: contentHttp.actionsHttp.handleV1,
    feedback: contentHttp.feedbackHttp.handleV1,
    capturesJournals: contentHttp.captureJournalHttp.handleV1,
    library: contentHttp.libraryHttp.handleV1,
    reviewsChat: reviewsChatHttp.handleV1,
    contentAttachments: contentAttachmentsHttp.handleV1
  });

  async function runPeriodicAnalyses() {
    const users = appConfig.authRequired
      ? (await readAuth()).users
      : [{ id: "local" }];
    for (const user of users) {
      await requestStorage.run({
        user,
        traceId: createId(),
        dataDir: appConfig.authRequired ? userDataDir(user) : paths.dataDir,
        secrets: [],
        route: "background/analysis"
      }, async () => {
        await ensureAuditLogs();
        await maybeRunPeriodicAnalysis();
      });
    }
    await pruneLogs(
      path.join(paths.dataDir, "logs"),
      appConfig.audit.retentionDays
    );
  }

  const legacyApi = createLegacyApi({
    beforeStateHandlers: [
      reviewsChatHttp.handle,
      contentHttp.captureJournalHttp.handle,
      contentHttp.libraryHttp.handle,
      platformHttp.speechHttp.handle,
      platformHttp.visionHttp.handle,
      platformHttp.aiCostHttp.handle,
      platformHttp.aiSettingsHttp.handle,
      platformHttp.onboardingHttp.handle,
      platformHttp.taskHttp.handle,
      platformHttp.trashHttp.handle,
      platformHttp.attachmentHttp.handle,
      platformHttp.keepsakeHttp.handle
    ],
    afterStateHandlers: [
      contentHttp.imageRecognitionHttp.handle,
      contentHttp.healthRecordHttp.handle,
      contentHttp.checkinHttp.handle,
      contentHttp.thoughtHttp.handle,
      platformHttp.annotationHttp
    ],
    readMeta: async () => {
      const user = requestStorage.getStore()?.user;
      return {
        version: appConfig.version,
        releaseVersion,
        user: publicUser(user),
        ...(isOwner(user) ? { openingPreferences: await readOpeningPreferences(user) } : {}),
        capabilities: capabilitiesFor(user),
        features: appConfig.features,
        governanceUrl: isOwner(user) && appConfig.platform.serviceTokenHash
          ? "/platform/"
          : ""
      };
    },
    readState: async () => publicStateFromStore(await readStore()),
    sendJson
  });

  return {
    apiV1,
    isOwner,
    ownerHttp,
    legacyApi,
    attachmentHttp: platformHttp.attachmentHttp,
    runPeriodicAnalyses,
    runRecordCompressionScheduler,
    runSpeechCacheSweep
  };
}
