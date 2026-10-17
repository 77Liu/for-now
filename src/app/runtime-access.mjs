import path from "node:path";
import { promises as fs } from "node:fs";
import { withoutReferenceOwnerMetadata } from "./public-state.mjs";
import { buildAdminSnapshot } from "../../admin-snapshot.mjs";
import {
  createAuthService,
  normalizeAuthDocument,
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
import { mapAuthDocument, createAuthRepository } from "../shared/persistence/index.mjs";
import { errorMetadata } from "../shared/observability/index.mjs";
import { createAccountLifecycle } from "./account-lifecycle.mjs";
import { createLocalTestRuntime } from "./local-test-runtime.mjs";
import { emptyStore } from "./store-schema.mjs";

const LOCAL_TEST_SESSION_COOKIE = "for_now_local_test_session";
const LOCAL_TEST_SESSION_MAX_AGE_SECONDS = 30 * 60;

export async function createRuntimeAccess({
  appConfig,
  accountRuntime,
  syncNotifier,
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
    ensureStore,
    validateCurrentStorage
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
    accountRuntime,
    validateCurrentStorage,
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
    runWorkspaceInitialization: operation => accountRuntime?.enabled ? accountRuntime.provision(accountRuntime.currentAccountId(), operation) : operation(),
    onWorkspaceCommitted: ({ dataDir: targetDir }) => {
      if (appConfig.syncAccountWakeEnabled) syncNotifier.notifyAccountCommitted({
        accountId: accountRuntime.currentAccountId(), storageScope: path.join(targetDir, "store.json")
      });
    },
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

  let readAuth, scanAuthUsers;
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
      readAuthData: null,
      readAuthPage: postgresRuntime ? query => scanAuthUsers(query) : null,
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

  const auditAuthChange = async event => {
    // 提交事件直接携带目标行；提示失败不回滚或重判数据库权限事实。
    for (const id of event.revokedUserIds || (
      event.type === "session-deleted" ? [event.userId] : []
    )) {
      try { syncNotifier?.invalidateAccount(id); } catch {}
    }
    if (event.type === "registered" && accountRuntime?.enabled) {
      await accountLifecycle.registerCommittedUser(event.user);
    }
    const before = event.beforeUser ? { users: [event.beforeUser] } : { users: [] };
    const afterUser = event.afterUser
      || (event.type === "registered" ? event.user : null);
    const after = afterUser ? { users: [afterUser] } : { users: [] };
    if (!event.beforeUser && !afterUser) return;
    const current = requestStorage.getStore() || {};
    const actor = current.user || afterUser;
    if (!actor) return auditChanges(before, after);
    return requestStorage.run(
      { ...current, user: actor, dataDir: userDataDir(actor) },
      () => auditChanges(before, after)
    );
  };
  const authRepository = createAuthRepository({
    runtime: postgresRuntime,
    queryMode: appConfig.auth.queryMode,
    normalizeDocument: normalizeAuthDocument,
    file: authFile,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    onCommitted: auditAuthChange,
    // 旧根目录数据仍允许首个Owner导入；已有账户目录则不能证明是全新实例。
    canInitialize: async () => {
      try { return (await fs.readdir(usersDir)).length === 0; }
      catch (error) { if (error.code === "ENOENT") return true; throw error; }
    },
    onInvalid: async error => {
      accountRuntime?.failGlobal(error);
      await logEvent("system", "storage.read_failed", {
        level: "error", file: "auth.json", error: errorMetadata(error)
      });
    }
  });
  readAuth = () => authRepository.readDocument();
  const authService = createAuthService({
    repository: authRepository,
    authAdmission: appConfig.authAdmission,
    authRequired,
    inviteCodeHash,
    initializeUserStorage
  });
  scanAuthUsers = query => authService.scanUsersPage(query);
  const probeAuth = async () => {
    if (authRepository.mode === "row") {
      const result = await authService.verify();
      if (!result?.valid) {
        throw Object.assign(
          new Error("认证持久化数据无效，原数据已保留"),
          { code: "AUTH_STORAGE_INVALID" }
        );
      }
      return result;
    }
    const raw = await readAuth();
    const invalid = () => { throw Object.assign(new Error("认证持久化数据无效，原文件已保留"), { code: "AUTH_STORAGE_INVALID" }); };
    mapAuthDocument(normalizeAuthDocument(raw));
    for (const user of raw.users) {
      if (user.role !== undefined && !["owner", "user"].includes(user.role)) invalid();
      if (user.sessionVersion !== undefined && (!Number.isSafeInteger(user.sessionVersion) || user.sessionVersion < 1)) invalid();
      const parts = String(user.passwordHash || "").split("$");
      if (parts[0] !== "scrypt" || parts.length !== 3 || Buffer.from(parts[1], "base64").length !== 16 || Buffer.from(parts[2], "base64").length !== 64) invalid();
    }
    for (const session of raw.sessions) {
      if (!/^[a-f0-9]{64}$/.test(session.tokenHash) || !Number.isFinite(Date.parse(session.expiresAt))) invalid();
      if (session.sessionVersion !== undefined && (!Number.isSafeInteger(session.sessionVersion) || session.sessionVersion < 1)) invalid();
    }
    return raw;
  };
  if (authRequired) {
    if (accountRuntime?.enabled) await probeAuth();
    await authService.migrate();
  }
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
    const owner = await authService.findFirstOwner();
    if (!owner) return userSettings;
    const ownerSettings = await aiRuntime.readSharedSettings({ accountId: owner.id, file: path.join(userDataDir(owner), "llm-settings.json") });
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
    probeAuth,
    authService,
    requestAuthentication,
    authApi
  };
}
