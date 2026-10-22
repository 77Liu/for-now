import http from "node:http";
import { errorMetadata } from "../shared/observability/index.mjs";
import {
  SPEECH_CACHE_SWEEP_INTERVAL_MS,
  SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
} from "./speech-cache-sweep.mjs";

const RECORD_SYNC_MAINTENANCE_STARTUP_DELAY_MS = 10_000;
const RECORD_SYNC_MAINTENANCE_INTERVAL_MS = 3_600_000;

export function createServerLifecycle({
  appConfig,
  application,
  accountLifecycle,
  accountRuntime = null,
  probeDependencies = async () => {},
  localTestRuntime,
  readAuth = null,
  scanUsersPage = null,
  verifyAuth = null,
  runPeriodicAnalyses,
  runRecordCompressionScheduler,
  runRecordSyncMaintenance = async () => ({ disabled: true }),
  recordSyncMaintenanceStartupDelayMs = RECORD_SYNC_MAINTENANCE_STARTUP_DELAY_MS,
  recordSyncMaintenanceIntervalMs = RECORD_SYNC_MAINTENANCE_INTERVAL_MS,
  runSpeechCacheSweep,
  observability,
  postgresRuntime,
  processRef = process
}) {
  const { logEvent, runtimeMemorySampler } = observability;
  const server = http.createServer(application.handle);
  const timers = new Set();
  const signalHandlers = new Map();
  let startPromise = null;
  let stopPromise = null;
  let listening = false;
  let startedSuccessfully = false;
  let fatalExitStarted = false;
  let removeGlobalFailureListener = () => {};
  const readUserPage = scanUsersPage || (async ({ limit, after }) => {
    const users = (await readAuth()).users || [];
    const start = after ? users.findIndex(user => user.id === after.id) + 1 : 0;
    const selected = users.slice(start, start + limit);
    const more = start + selected.length < users.length;
    const tail = more ? selected.at(-1) : null;
    return {
      users: selected,
      next: tail ? { createdAt: String(tail.createdAt || ""), id: tail.id } : null
    };
  });
  const verifyIdentity = verifyAuth || readAuth || (async () => ({ valid: true }));

  const schedule = (callback, delay, repeat = false) => {
    const timer = repeat
      ? setInterval(callback, delay)
      : setTimeout(callback, delay);
    timer.unref();
    timers.add(timer);
    return timer;
  };
  const periodicFailure = error => logEvent("system", "scheduler.failed", {
    level: "error",
    error: errorMetadata(error)
  });
  const startSchedulers = () => {
    if (accountRuntime?.enabled) {
      schedule(() => void (async () => {
        await probeDependencies();
        await verifyIdentity();
      })().catch(error => { accountRuntime.failGlobal(error); periodicFailure(error); }), appConfig.accountRecovery.dependencyProbeMs, true);
    }
    if (!appConfig.localTestMode && appConfig.periodicAnalysisEnabled) {
      schedule(() => void runPeriodicAnalyses().catch(periodicFailure), 5000);
      schedule(
        () => void runPeriodicAnalyses().catch(periodicFailure),
        3_600_000,
        true
      );
    }
    if (appConfig.recordCompressionEnabled) {
      schedule(
        () => void runRecordCompressionScheduler().catch(periodicFailure),
        5_000
      );
      schedule(
        () => void runRecordCompressionScheduler().catch(periodicFailure),
        30_000,
        true
      );
    }
    if (Number.isSafeInteger(appConfig.syncV2?.retentionDays)
      && Number.isSafeInteger(appConfig.syncV2?.retentionRowsPerAccount)) {
      schedule(
        () => void runRecordSyncMaintenance().catch(periodicFailure),
        recordSyncMaintenanceStartupDelayMs
      );
      schedule(
        () => void runRecordSyncMaintenance().catch(periodicFailure),
        recordSyncMaintenanceIntervalMs,
        true
      );
    }
    if (appConfig.speechCacheSweepEnabled) {
      schedule(
        () => void runSpeechCacheSweep().catch(periodicFailure),
        SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
      );
      schedule(
        () => void runSpeechCacheSweep().catch(periodicFailure),
        SPEECH_CACHE_SWEEP_INTERVAL_MS,
        true
      );
    }
  };
  const clearSchedulers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
  };
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      processRef.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };

  async function stop({ signal = "manual" } = {}) {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      clearSchedulers();
      removeGlobalFailureListener();
      removeSignalHandlers();
      await runtimeMemorySampler.stop();
      await accountRuntime?.stop();
      if (listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
        listening = false;
      }
      await postgresRuntime?.close();
      await logEvent("system", "server.stopped", { level: "info", signal });
    })();
    return stopPromise;
  }

  const handleSignal = signal => {
    const forcedExit = setTimeout(() => processRef.exit(1), 10_000);
    forcedExit.unref();
    void stop({ signal }).then(
      () => {
        clearTimeout(forcedExit);
        processRef.exit(0);
      },
      error => {
        console.error(JSON.stringify({
          type: "system",
          event: "server.stop_failed",
          signal,
          error: errorMetadata(error)
        }));
        clearTimeout(forcedExit);
        processRef.exit(1);
      }
    );
  };
  // 共享故障先停止准入并排空真实执行器；沿既有十秒强退边界关闭资源，以非零状态交给服务管理器恢复。
  const handleGlobalFailure = error => {
    if (!startedSuccessfully || fatalExitStarted) return;
    fatalExitStarted = true;
    void logEvent("system", "server.dependency_failed", { level: "error", error: errorMetadata(error) });
    const forcedExit = setTimeout(() => processRef.exit(1), 10_000);
    forcedExit.unref();
    void stop({ signal: "dependency-failed" }).finally(() => {
      clearTimeout(forcedExit);
      processRef.exit(1);
    }).catch(() => {});
  };
  removeGlobalFailureListener = accountRuntime?.onGlobalFailure(handleGlobalFailure) || (() => {});
  const installSignalHandlers = () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => handleSignal(signal);
      signalHandlers.set(signal, handler);
      processRef.once(signal, handler);
    }
  };

  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!accountRuntime?.enabled) {
      await accountLifecycle.recoverAtStartup({
        localTestRuntime,
        readUsersPage: readUserPage
      });
      }
      installSignalHandlers();
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          listening = true;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(appConfig.port, "127.0.0.1");
      });
      if (accountRuntime?.enabled) {
      await accountLifecycle.recoverAtStartup({
        localTestRuntime,
        readUsersPage: readUserPage
      });
      }
      if (accountRuntime?.enabled && !accountRuntime.health().dependenciesHealthy) throw Object.assign(new Error("共享依赖在启动期间失效"), { code: "ACCOUNT_DEPENDENCIES_UNAVAILABLE" });
      startedSuccessfully = true;
      startSchedulers();
      void (async () => {
        await logEvent("system", "server.started", {
          level: "info",
          port: server.address().port
        });
        await runtimeMemorySampler.start();
      })().catch(error => logEvent("system", "runtime.memory_sample_failed", {
        level: "error",
        error: errorMetadata(error)
      }));
      return {
        port: server.address().port,
        version: appConfig.version
      };
    })().catch(async error => {
      accountRuntime?.failGlobal();
      await stop({ signal: "startup-failed" }).catch(() => {});
      throw error;
    });
    return startPromise;
  }

  async function ready() {
    await start();
    await postgresRuntime?.ready();
    if (accountRuntime?.enabled && !accountRuntime.health().ready) throw Object.assign(new Error("账户恢复尚未就绪"), { code: "ACCOUNT_RECOVERY_NOT_READY" });
  }

  return { start, ready, stop };
}
