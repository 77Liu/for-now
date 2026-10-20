import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/index.mjs";
import { isApplicationRoutePath } from "../../public/frontend/pages/index.mjs";
import { createHttpApplication } from "../http/index.mjs";
import { createRuntimeAccess } from "./runtime-access.mjs";
import { createRuntimeFoundation } from "./runtime-foundation.mjs";
import { createRuntimeHttpWiring } from "./runtime-http-wiring.mjs";
import { createServerLifecycle } from "./server-lifecycle.mjs";

export function createServerRuntime({
  rootUrl,
  processRef = process,
  startupGate = null
} = {}) {
  // 启动门仅允许独立临时目录、测试模式和回环 PostgreSQL，避免把生产依赖接入验收进程。
  if (startupGate) {
    if (typeof startupGate.holdDispatch !== "function"
      || typeof startupGate.observeEffect !== "function"
      || typeof startupGate.tempRoot !== "string") {
      throw new TypeError("Startup gate requires local effect guards and a temporary root");
    }
    const rootDir = path.dirname(fileURLToPath(rootUrl));
    const config = loadAppConfig({ rootDir });
    const temporaryRoot = path.resolve(startupGate.tempRoot);
    const dataDir = path.resolve(config.dataDir);
    const inside = (base, target) => {
      const relative = path.relative(base, target);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const isLoopback = value => {
      try {
        const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].includes(host);
      } catch {
        return false;
      }
    };
    if (!inside(path.resolve(os.tmpdir()), temporaryRoot)
      || !inside(temporaryRoot, dataDir)
      || config.persistenceBackend !== "postgres"
      || config.localTestMode
      || config.upstreamOrigin
      || processRef !== process
      || config.attachments.testMode !== true
      || ![config.databaseUrl, config.authDatabaseUrl, config.aiBudgetDatabaseUrl].every(isLoopback)) {
      throw new Error("Startup gate only accepts an isolated temporary directory and loopback PostgreSQL in test mode");
    }
  }
  let lifecyclePromise;

  const lifecycle = () => {
    lifecyclePromise ||= (async () => {
      const accountAccess = {};
      const foundation = await createRuntimeFoundation({
        rootUrl,
        processRef,
        accountAccess,
        startupGate
      });
      try {
      const access = await createRuntimeAccess(foundation);
      Object.assign(accountAccess, {
        authService: access.authService,
        userDataDir: access.userDataDir
      });
      const wiring = createRuntimeHttpWiring({
        ...foundation,
        access
      });
      const application = createHttpApplication({
        requestStorage: foundation.observability.requestStorage,
        dataDir: foundation.paths.dataDir,
        publicDir: foundation.paths.publicDir,
        basePath: foundation.appConfig.basePath,
        version: foundation.appConfig.version,
        upstreamOrigin: foundation.appConfig.upstreamOrigin,
        localTestMode: foundation.appConfig.localTestMode,
        postgresRuntime: foundation.persistence.postgresRuntime,
        accountRuntime: foundation.accountRuntime,
        accountLifecycle: access.accountLifecycle,
        findAuthUserById: access.authService.findUserById,
        bodyJson: access.bodyJson,
        logEvent: foundation.observability.logEvent,
        sendJson: access.sendJson,
        apiV1: wiring.apiV1,
        localTestRuntime: access.localTestRuntime,
        localTestHttp: access.localTestHttp,
        adminHttp: access.adminHttp,
        proxyToUpstream: access.proxyToUpstream,
        requestAuthentication: access.requestAuthentication,
        authApi: access.authApi,
        bindAuthenticatedUser: access.bindAuthenticatedUser,
        isOwner: wiring.isOwner,
        ownerHttp: wiring.ownerHttp,
        legacyApi: wiring.legacyApi,
        attachmentHttp: wiring.attachmentHttp,
        isApplicationRoutePath
      });
      return createServerLifecycle({
        appConfig: foundation.appConfig,
        application,
        accountLifecycle: access.accountLifecycle,
        accountRuntime: foundation.accountRuntime,
        localTestRuntime: access.localTestRuntime,
        scanUsersPage: access.authService.scanUsersPage,
        verifyAuth: access.authService.verify,
        probeDependencies: async () => {
          await foundation.persistence.postgresRuntime?.ready();
          await foundation.aiRuntime.validateGlobalBudget();
          if (foundation.appConfig.authRequired) await access.probeAuth();
        },
        runPeriodicAnalyses: wiring.runPeriodicAnalyses,
        runRecordCompressionScheduler: wiring.runRecordCompressionScheduler,
        runRecordSyncMaintenance: wiring.runRecordSyncMaintenance,
        runSpeechCacheSweep: wiring.runSpeechCacheSweep,
        observability: foundation.observability,
        postgresRuntime: foundation.persistence.postgresRuntime,
        processRef
      });
      } catch (error) {
        foundation.accountRuntime.failGlobal();
        await foundation.persistence.postgresRuntime?.close().catch(() => {});
        throw error;
      }
    })();
    return lifecyclePromise;
  };

  return {
    async start() {
      return (await lifecycle()).start();
    },
    async ready() {
      return (await lifecycle()).ready();
    },
    async stop(options) {
      return (await lifecycle()).stop(options);
    }
  };
}
