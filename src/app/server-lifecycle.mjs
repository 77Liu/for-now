import http from "node:http";
import { errorMetadata } from "../shared/observability/index.mjs";
import {
  SPEECH_CACHE_SWEEP_INTERVAL_MS,
  SPEECH_CACHE_SWEEP_STARTUP_DELAY_MS
} from "./speech-cache-sweep.mjs";

export function createServerLifecycle({
  appConfig,
  application,
  accountLifecycle,
  localTestRuntime,
  readAuth,
  runPeriodicAnalyses,
  runRecordCompressionScheduler,
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
      removeSignalHandlers();
      await runtimeMemorySampler.stop();
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
      await accountLifecycle.recoverAtStartup({
        localTestRuntime,
        readUsers: async () => (await readAuth()).users
      });
      startSchedulers();
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
    })().catch(error => {
      clearSchedulers();
      removeSignalHandlers();
      throw error;
    });
    return startPromise;
  }

  async function ready() {
    await start();
    await postgresRuntime?.ready();
  }

  return { start, ready, stop };
}
