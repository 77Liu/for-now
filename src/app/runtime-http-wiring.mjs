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
import { createRuntimeContentHttp } from "./runtime-content-http.mjs";
import { createRuntimePlatformHttp } from "./runtime-platform-http.mjs";
import { createStatisticsRuntime } from "./statistics-runtime.mjs";
import { normalizeCommercialization } from "./store-normalization.mjs";
import {
  routeStateProjection,
  startupProjection
} from "./startup-projections.mjs";

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
  const { requestStorage } = observability;
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
    runSpeechCacheSweep
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
    onboardingV2: platformHttp.onboardingV2Http.handleV1,
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
    runSpeechCacheSweep
  };
}
