import { isApplicationRoutePath } from "../../public/frontend/pages/index.mjs";
import { createHttpApplication } from "../http/index.mjs";
import { createRuntimeAccess } from "./runtime-access.mjs";
import { createRuntimeFoundation } from "./runtime-foundation.mjs";
import { createRuntimeHttpWiring } from "./runtime-http-wiring.mjs";
import { createServerLifecycle } from "./server-lifecycle.mjs";

export function createServerRuntime({
  rootUrl,
  processRef = process
} = {}) {
  let lifecyclePromise;

  const lifecycle = () => {
    lifecyclePromise ||= (async () => {
      const accountAccess = {};
      const foundation = await createRuntimeFoundation({
        rootUrl,
        processRef,
        accountAccess
      });
      const access = await createRuntimeAccess(foundation);
      Object.assign(accountAccess, {
        readAuth: access.readAuth,
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
        localTestRuntime: access.localTestRuntime,
        readAuth: access.readAuth,
        runPeriodicAnalyses: wiring.runPeriodicAnalyses,
        runRecordCompressionScheduler: wiring.runRecordCompressionScheduler,
        runSpeechCacheSweep: wiring.runSpeechCacheSweep,
        observability: foundation.observability,
        postgresRuntime: foundation.persistence.postgresRuntime,
        processRef
      });
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
