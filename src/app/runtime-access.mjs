import { withoutReferenceOwnerMetadata } from "./public-state.mjs";
import { buildAdminSnapshot } from "../../admin-snapshot.mjs";
import {
  createAuthService,
  isOwner
} from "../modules/auth/index.mjs";
import {
  normalizeAiUsage,
  normalizeLlmSettings
} from "../modules/ai/index.mjs";
import {
  createAdminHttp,
  createAuthHttp,
  createJsonHttp,
  createLocalTestHttp,
  createLocalTestSessionVault,
  createModelResponseHttp,
  createReadOnlyUpstream,
  createUpstreamProxy
} from "../http/index.mjs";
import { createAuthRepository } from "../shared/persistence/index.mjs";
import { errorMetadata } from "../shared/observability/index.mjs";
import { createAccountLifecycle } from "./account-lifecycle.mjs";
import { createLocalTestRuntime } from "./local-test-runtime.mjs";
import { emptyStore } from "./store-schema.mjs";

const LOCAL_TEST_SESSION_COOKIE = "for_now_local_test_session";
const LOCAL_TEST_SESSION_MAX_AGE_SECONDS = 30 * 60;

export async function createRuntimeAccess({
  appConfig,
  paths,
  httpLimits,
  clock,
  observability,
  persistence,
  aiRuntime,
  contentRuntime,
  publicStateFromStore
}) {
  const {
    authRequired,
    inviteCodeHash,
    cookieSecure,
    basePath,
    upstreamOrigin,
    localTestMode,
    localTestMainUserId,
    localTestResetOnStart
  } = appConfig;
  const { dataDir, usersDir, authFile, localTestControlFile, localTestWorkspacesDir } = paths;
  const { now } = clock;
  const { requestStorage, logEvent, auditChanges } = observability;
  const {
    postgresRuntime,
    storeRepository,
    storagePaths,
    normalizeStore,
    readStoredJson,
    writeJsonAtomic,
    readStore,
    updateStore,
    ensureStore
  } = persistence;
  const {
    settingsRepository,
    costRepository,
    llmSettingsService,
    readLlmSettings,
    writeLlmSettings,
    ensureLlmSettings,
    readAiUsage,
    ensureAiUsage,
    ensureAuditLogs,
    installModelRuntimeSettingsReader
  } = aiRuntime;
  const {
    attachmentStorage,
    imageAttachments,
    resumeAttachmentCleanup,
    backgroundAi,
    keepsakeMediaWorkflows
  } = contentRuntime;

  const projectResponse = value => isOwner(requestStorage.getStore()?.user)
    ? value : withoutReferenceOwnerMetadata(value);
  const { sendJson, bodyJson } = createJsonHttp({
    getContext: () => requestStorage.getStore(),
    maxBodyBytes: httpLimits.standardBodyBytes,
    projectResponse
  });
  const respondModel = createModelResponseHttp({
    getContext: () => requestStorage.getStore(),
    logEvent,
    sendJson,
    projectResponse
  });
  const accountLifecycle = createAccountLifecycle({
    dataDir,
    usersDir,
    authRequired,
    postgresRuntime,
    requestStorage,
    emptyStore,
    normalizeStore,
    normalizeLlmSettings,
    normalizeAiUsage,
    ensureStore,
    ensureLlmSettings,
    ensureAiUsage,
    ensureAuditLogs,
    resumeAttachmentCleanup,
    backgroundAi: { resume: () => backgroundAi.resume() },
    keepsakeMediaWorkflows: { resume: () => keepsakeMediaWorkflows.resume() }
  });
  const {
    userDataDir,
    initializeUserStorage
  } = accountLifecycle;
  const bindAuthenticatedUser = user => {
    const context = requestStorage.getStore();
    if (context) {
      Object.assign(context, {
        user,
        ...(authRequired ? { dataDir: userDataDir(user) } : {})
      });
    }
  };

  const localTestSessions = createLocalTestSessionVault({
    enabled: localTestMode,
    cookieName: LOCAL_TEST_SESSION_COOKIE,
    maxAgeSeconds: LOCAL_TEST_SESSION_MAX_AGE_SECONDS
  });
  const localTestUpstream = createReadOnlyUpstream({
    origin: upstreamOrigin,
    sessions: localTestSessions,
    requestStorage
  });
  let localTestHttp;
  const proxyToUpstream = createUpstreamProxy({
    origin: upstreamOrigin,
    maxBodyBytes: httpLimits.standardBodyBytes,
    uploadMaxBodyBytes: httpLimits.uploadBodyBytes,
    sendJson,
    getTraceId: () => requestStorage.getStore().traceId,
    upstreamCookie: req => localTestHttp.upstreamCookie(req),
    rewriteResponse: input => localTestHttp.rewriteProxyResponse(input)
  });
  const localTestRuntime = createLocalTestRuntime({
    enabled: localTestMode,
    upstreamConfigured: Boolean(upstreamOrigin),
    dataDir,
    controlFile: localTestControlFile,
    workspacesDir: localTestWorkspacesDir,
    resetOnStart: localTestResetOnStart,
    mainUserId: localTestMainUserId,
    requestStorage,
    storeRepository,
    storagePaths,
    emptyStore,
    normalizeStore,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    ensureStore,
    ensureSettings: ensureLlmSettings,
    ensureUsage: ensureAiUsage,
    ensureAuditLogs,
    writeSettings: value => writeLlmSettings(normalizeLlmSettings(value)),
    projectState: publicStateFromStore,
    readStore,
    updateStore,
    sessionForRequest: localTestSessions.get,
    isOwner,
    upstream: localTestUpstream,
    now
  });
  localTestHttp = createLocalTestHttp({
    runtime: localTestRuntime,
    sessions: localTestSessions,
    basePath,
    sendJson,
    bodyJson,
    bindUser: bindAuthenticatedUser,
    proxyToUpstream
  });

  let readAuth;
  const adminHttp = createAdminHttp({
    serviceTokenHash: appConfig.platform.serviceTokenHash,
    buildSnapshot: buildAdminSnapshot,
    snapshotOptions: {
      dataDir,
      version: appConfig.version,
      cnyPerUsd: appConfig.limits.usdCny,
      dailyCostLimitCny: appConfig.limits.aiDailyCostCny,
      attachmentQuotaBytes: appConfig.limits.attachmentBytes,
      attachmentMode: attachmentStorage.mode,
      attachmentUsageBytes: (ownerId, localDir) => attachmentStorage.usageBytes({
        ownerId,
        localDir
      }),
      backupStatusFile: appConfig.platform.backupStatusFile,
      dailyCallLimit: appConfig.limits.aiDailyCalls,
      readAuthData: postgresRuntime ? () => readAuth() : null,
      readAccountData: postgresRuntime
        ? account => requestStorage.run({
            ...(requestStorage.getStore() || {}),
            user: account,
            dataDir: userDataDir(account)
          }, async () => {
            const [store, usage, settings, costPlan] = await Promise.all([
              readStore(),
              readAiUsage(),
              settingsRepository.read(),
              costRepository.read()
            ]);
            return {
              store,
              usage,
              structuredBytes: Buffer.byteLength(JSON.stringify({
                store,
                usage,
                settings,
                costPlan
              })),
              structuredObjects: [store, usage, settings, costPlan]
                .filter(value => value != null).length
            };
          })
        : null
    },
    sendJson
  });

  const auditAuthChanges = async (before, after) => {
    const current = requestStorage.getStore() || {};
    let actor = current.user || null;
    if (!actor) {
      const priorUsers = new Set((before?.users || []).map(user => user.id));
      actor = (after?.users || []).find(user => !priorUsers.has(user.id)) || null;
    }
    if (!actor) {
      const priorSessions = new Set(
        (before?.sessions || []).map(session => session.tokenHash)
      );
      const session = (after?.sessions || [])
        .find(item => !priorSessions.has(item.tokenHash));
      actor = (after?.users || []).find(user => user.id === session?.userId) || null;
    }
    if (!actor) return auditChanges(before, after);
    return requestStorage.run(
      { ...current, user: actor, dataDir: userDataDir(actor) },
      () => auditChanges(before, after)
    );
  };
  const authRepository = createAuthRepository({
    runtime: postgresRuntime,
    file: authFile,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    onCommit: auditAuthChanges,
    onInvalid: () => logEvent("system", "storage.read_failed", {
      level: "error",
      file: "auth.json",
      error: { code: "INVALID_AUTH_DOCUMENT" }
    })
  });
  readAuth = () => authRepository.read();
  const authService = createAuthService({
    repository: authRepository,
    authAdmission: appConfig.authAdmission,
    authRequired,
    inviteCodeHash,
    initializeUserStorage
  });
  if (authRequired) await authService.migrate();
  const { requestAuthentication, authApi } = createAuthHttp({
    service: authService,
    sendJson,
    bodyJson,
    authRequired,
    basePath,
    cookieSecure,
    bindUser: bindAuthenticatedUser
  });
  installModelRuntimeSettingsReader(async () => {
    const context = requestStorage.getStore() || {};
    const userSettings = await readLlmSettings();
    if (!authRequired || isOwner(context.user)) return userSettings;
    const owner = (await readAuth()).users.find(isOwner);
    if (!owner) return userSettings;
    const ownerSettings = await requestStorage.run(
      { ...context, user: owner, dataDir: userDataDir(owner) },
      readLlmSettings
    );
    return normalizeLlmSettings({
      ...userSettings,
      provider: ownerSettings.provider,
      profiles: ownerSettings.profiles,
      scenarios: ownerSettings.scenarios,
      apiKey: ownerSettings.apiKey
    });
  });

  return {
    sendJson,
    bodyJson,
    respondModel,
    accountLifecycle,
    userDataDir,
    bindAuthenticatedUser,
    localTestRuntime,
    localTestHttp,
    proxyToUpstream,
    adminHttp,
    readAuth,
    requestAuthentication,
    authApi
  };
}
