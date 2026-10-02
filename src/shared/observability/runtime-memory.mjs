import { monitorEventLoopDelay } from "node:perf_hooks";
import v8 from "node:v8";

const DEFAULT_INTERVAL_MS = 60_000;
const HANDLE_CATEGORIES = new Map([
  ["ChildProcess", "childProcess"],
  ["FSEvent", "fileWatcher"],
  ["FSWatcher", "fileWatcher"],
  ["MessagePort", "messagePort"],
  ["Server", "server"],
  ["Signal", "signal"],
  ["SignalWrap", "signal"],
  ["Socket", "socket"],
  ["TLSSocket", "tlsSocket"],
  ["Immediate", "timer"],
  ["Timeout", "timer"],
  ["ReadStream", "stream"],
  ["WriteStream", "stream"]
]);

const safeInteger = value => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(value) || 0)));
const milliseconds = value => {
  const converted = Number(value) / 1_000_000;
  return Number.isFinite(converted) ? Number(Math.max(0, converted).toFixed(3)) : 0;
};

function activeHandleSummary(activeHandles) {
  const handles = typeof activeHandles === "function" ? activeHandles() : [];
  const counts = new Map();
  for (const handle of Array.isArray(handles) ? handles : []) {
    const name = String(handle?.constructor?.name || "");
    const category = HANDLE_CATEGORIES.get(name) || "other";
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return {
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    categories: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
  };
}

export function collectRuntimeMemorySample({
  now = () => new Date().toISOString(),
  memoryUsage = () => process.memoryUsage(),
  heapSpaceStatistics = () => v8.getHeapSpaceStatistics(),
  eventLoopDelay = null,
  activeHandles = () => process._getActiveHandles?.() || []
} = {}) {
  const memory = memoryUsage();
  return {
    sampledAt: now(),
    rss: safeInteger(memory.rss),
    heapTotal: safeInteger(memory.heapTotal),
    heapUsed: safeInteger(memory.heapUsed),
    external: safeInteger(memory.external),
    arrayBuffers: safeInteger(memory.arrayBuffers),
    heapSpaces: heapSpaceStatistics().map(space => ({
      name: String(space.space_name || "").slice(0, 80),
      size: safeInteger(space.space_size),
      used: safeInteger(space.space_used_size),
      available: safeInteger(space.space_available_size),
      physical: safeInteger(space.physical_space_size)
    })).sort((left, right) => left.name.localeCompare(right.name)),
    eventLoopDelay: {
      meanMs: milliseconds(eventLoopDelay?.mean),
      p50Ms: milliseconds(eventLoopDelay?.percentile?.(50)),
      p95Ms: milliseconds(eventLoopDelay?.percentile?.(95)),
      p99Ms: milliseconds(eventLoopDelay?.percentile?.(99)),
      maxMs: milliseconds(eventLoopDelay?.max)
    },
    activeHandles: activeHandleSummary(activeHandles)
  };
}

export function createRuntimeMemorySampler({
  logEvent,
  intervalMs = DEFAULT_INTERVAL_MS,
  histogram = monitorEventLoopDelay({ resolution: 20 }),
  collect = options => collectRuntimeMemorySample(options)
} = {}) {
  if (typeof logEvent !== "function") throw new TypeError("Runtime memory sampler requires logEvent");
  const interval = Math.max(50, Math.min(3_600_000, Math.round(Number(intervalMs) || DEFAULT_INTERVAL_MS)));
  let timer = null;
  let pending = Promise.resolve();

  const sample = () => {
    const operation = pending.then(async () => {
      const value = collect({ eventLoopDelay: histogram });
      histogram.reset?.();
      await logEvent("system", "runtime.memory_sample", { level: "info", sample: value });
      return value;
    });
    pending = operation.catch(() => {});
    return operation;
  };

  return {
    intervalMs: interval,
    async start() {
      if (timer) return pending;
      histogram.enable?.();
      timer = setInterval(() => void sample().catch(() => {}), interval);
      timer.unref?.();
      return sample();
    },
    async stop() {
      if (!timer) return pending;
      clearInterval(timer);
      timer = null;
      await sample();
      histogram.disable?.();
      return pending;
    },
    sample
  };
}
