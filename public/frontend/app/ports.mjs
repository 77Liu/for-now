const clone = value => structuredClone(value);

function abortFailure(message) {
  return new DOMException(message, "AbortError");
}

function linkedController(signal) {
  const controller = new AbortController();
  let unlink = () => {};
  if (signal) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      unlink = () => signal.removeEventListener("abort", abort);
    }
  }
  return { controller, unlink };
}

export function createSessionPort() {
  let serial = 0;
  let accountId = "";
  let controller = new AbortController();

  const capture = () => Object.freeze({
    serial,
    accountId,
    signal: controller.signal
  });
  const isCurrent = ticket => (
    ticket?.serial === serial
    && ticket?.accountId === accountId
    && ticket?.signal === controller.signal
    && !ticket.signal.aborted
  );
  const assertCurrent = ticket => {
    if (!isCurrent(ticket)) throw abortFailure("Session changed");
  };
  const resetSession = () => {
    controller.abort();
    controller = new AbortController();
    accountId = "";
    serial += 1;
    return capture();
  };
  const activate = value => {
    resetSession();
    accountId = String(value || "");
    return capture();
  };

  return Object.freeze({
    activate,
    capture,
    isCurrent,
    assertCurrent,
    resetSession
  });
}

export function createStatePort({
  emptyState,
  load = async initial => initial,
  cloneValue = clone
} = {}) {
  if (!emptyState || typeof emptyState !== "object" || Array.isArray(emptyState)) {
    throw new TypeError("State port requires an object emptyState");
  }
  if (typeof load !== "function" || typeof cloneValue !== "function") {
    throw new TypeError("State port requires load and clone functions");
  }

  let value = cloneValue(emptyState);
  let generation = 0;
  let active = null;
  let stopped = false;
  const subscribers = new Set();
  const publish = (domains, options = {}) => {
    for (const listener of subscribers) listener(value, domains, options);
  };
  const invalidate = candidate => {
    if (!candidate || candidate.disposed) return;
    candidate.disposed = true;
    candidate.controller.abort();
    candidate.unlink();
    if (active === candidate) active = null;
  };
  const start = async (initial, signal) => {
    if (stopped) throw new Error("State port has stopped");
    if (active) throw new Error("State port has already started");
    const linked = linkedController(signal);
    const candidate = {
      generation: ++generation,
      ...linked,
      disposed: false
    };
    active = candidate;
    try {
      const loaded = await load(initial, {
        signal: candidate.controller.signal,
        generation: candidate.generation
      });
      if (active !== candidate || candidate.controller.signal.aborted) {
        throw abortFailure("State start was invalidated");
      }
      value = cloneValue(loaded ?? emptyState);
      return () => invalidate(candidate);
    } catch (error) {
      invalidate(candidate);
      throw error;
    }
  };
  const subscribe = listener => {
    if (typeof listener !== "function") {
      throw new TypeError("State subscriber must be a function");
    }
    let subscribed = true;
    subscribers.add(listener);
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(listener);
    };
  };
  const replace = (next, domains = [], options = {}) => {
    if (stopped) return false;
    value = cloneValue(next ?? emptyState);
    publish(new Set(domains), options);
    return true;
  };
  const merge = (patch, domains = Object.keys(patch || {}), options = {}) => (
    replace({ ...value, ...cloneValue(patch || {}) }, domains, options)
  );
  const resetSession = () => {
    generation += 1;
    invalidate(active);
    value = cloneValue(emptyState);
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    resetSession();
    subscribers.clear();
  };

  return Object.freeze({
    start,
    subscribe,
    snapshot: () => value,
    replace,
    merge,
    resetSession,
    stop
  });
}

export function createSyncPort({
  controller,
  close = () => {},
  onError = () => {}
} = {}) {
  if (!controller
      || typeof controller.start !== "function"
      || typeof controller.stop !== "function"
      || typeof close !== "function"
      || typeof onError !== "function") {
    throw new TypeError("Sync port requires controller, close and error callbacks");
  }

  let generation = 0;
  let cycle = null;
  let stopped = false;
  let stopPromise = null;
  let stopBarrier = Promise.resolve();
  const dispose = candidate => {
    if (!candidate) return;
    if (candidate.stopPromise) return candidate.stopPromise;
    candidate.disposed = true;
    candidate.signal?.removeEventListener("abort", candidate.abort);
    if (cycle === candidate) {
      cycle = null;
      generation += 1;
    }
    candidate.stopPromise = stopBarrier = stopBarrier.then(() => controller.stop());
    return candidate.stopPromise;
  };
  const start = (initial = {}, signal) => {
    if (stopped) throw new Error("Sync port has stopped");
    const priorStop = dispose(cycle) || stopBarrier;
    const candidate = {
      generation: ++generation,
      signal,
      abort: null,
      disposed: false,
      stopPromise: null
    };
    cycle = candidate;
    candidate.abort = () => dispose(candidate);
    signal?.addEventListener("abort", candidate.abort, { once: true });
    Promise.resolve(priorStop)
      .then(() => {
        if (cycle !== candidate || candidate.disposed || stopped) return false;
        return controller.start(
          String(initial.owner || ""),
          { incremental: initial.incremental !== false }
        );
      })
      .catch(error => {
        if (cycle === candidate && !candidate.disposed && !stopped) onError(error);
      });
    return () => dispose(candidate);
  };
  const resetSession = async () => {
    generation += 1;
    const candidate = cycle;
    cycle = null;
    if (candidate) await dispose(candidate);
    else await (stopBarrier = stopBarrier.then(() => controller.stop()));
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = Promise.resolve(resetSession()).then(() => close());
    return stopPromise;
  };

  return Object.freeze({ start, resetSession, stop });
}

export function createShellPort({
  mount,
  reset,
  stop: stopShell
} = {}) {
  if (typeof mount !== "function"
      || typeof reset !== "function"
      || typeof stopShell !== "function") {
    throw new TypeError("Shell port requires mount, reset and stop callbacks");
  }

  let generation = 0;
  let active = null;
  let stopped = false;
  let stopPromise = null;
  const dispose = async candidate => {
    if (!candidate) return;
    if (candidate.cleanupPromise) return candidate.cleanupPromise;
    candidate.disposed = true;
    candidate.controller.abort();
    candidate.unlink();
    if (active === candidate) active = null;
    candidate.cleanupPromise = (async () => {
      await candidate.mountDone;
      const disposer = candidate.disposer;
      candidate.disposer = null;
      if (typeof disposer === "function") await disposer();
    })();
    return candidate.cleanupPromise;
  };
  const start = async (initial, signal) => {
    if (stopped) throw new Error("Shell port has stopped");
    if (active) throw new Error("Shell port has already started");
    const linked = linkedController(signal);
    let resolveMount;
    const candidate = {
      generation: ++generation,
      ...linked,
      disposer: null,
      disposed: false,
      cleanupPromise: null,
      mountDone: new Promise(resolve => { resolveMount = resolve; })
    };
    active = candidate;
    try {
      const disposer = await mount(initial, {
        signal: candidate.controller.signal,
        generation: candidate.generation
      });
      if (disposer != null && typeof disposer !== "function") {
        throw new TypeError("Shell mount must return a disposer or undefined");
      }
      candidate.disposer = disposer || null;
      resolveMount();
      if (candidate.disposed) {
        await candidate.cleanupPromise;
        throw abortFailure("Shell start was invalidated");
      }
      if (active !== candidate || candidate.controller.signal.aborted) {
        await dispose(candidate);
        throw abortFailure("Shell start was invalidated");
      }
      return () => dispose(candidate);
    } catch (error) {
      resolveMount();
      await dispose(candidate);
      throw error;
    }
  };
  const resetSession = async () => {
    generation += 1;
    await dispose(active);
    await reset();
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = resetSession().then(() => stopShell());
    return stopPromise;
  };

  return Object.freeze({ start, resetSession, stop });
}
