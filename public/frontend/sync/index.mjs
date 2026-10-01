const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const CONFLICT_STATUSES = new Set([409, 412]);
export const SYNC_RETRY_MAX_ATTEMPTS = 8;
const SYNC_RETRY_BASE_MS = 1000;
const SYNC_RETRY_MAX_MS = 60_000;
const SYNC_RETRY_AFTER_MAX_MS = 5 * 60_000;

const clone = value => value == null ? value : structuredClone(value);
const recordKey = record => `${record.owner}:${record.queueId || record.id}`;
const sha256Hex = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const lowerCaseHeaders = headers => {
  const normalized = {};
  for (const [name, value] of new Headers(headers || {}).entries()) normalized[name.toLowerCase()] = value;
  return normalized;
};
const defaultResourceKey = url => {
  const parsed = new URL(url, "https://local.invalid");
  return `${parsed.pathname}${parsed.search}`;
};
const replayOptions = record => ({
  method: record.method,
  headers: { ...record.headers },
  ...(Object.hasOwn(record, "body") ? { body: record.body } : {})
});
const retryable = error => {
  const status = Number(error?.status || 0);
  return !status || status >= 500 || RETRYABLE_STATUSES.has(status);
};
const retryDelay = (error, attempts) => {
  const retryAfterMs = error?.retryAfterMs == null ? NaN : Number(error.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(SYNC_RETRY_AFTER_MAX_MS, Math.round(retryAfterMs));
  }
  return Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)));
};

export async function syncOperationFingerprint({ method = "POST", url, headers = {}, body = "" }) {
  const normalizedHeaders = lowerCaseHeaders(headers);
  const resource = defaultResourceKey(url);
  const requestBodySha256 = await sha256Hex(String(body ?? ""));
  return sha256Hex(JSON.stringify({
    method: String(method).toUpperCase(),
    resource,
    contentType: String(normalizedHeaders["content-type"] || "").toLowerCase(),
    ifMatch: String(normalizedHeaders["if-match"] || ""),
    requestBodySha256
  }));
}

export function createMemorySyncStore(initial = []) {
  const records = new Map(initial.map(record => [recordKey(record), clone(record)]));
  return {
    durable: false,
    async put(record) {
      records.set(recordKey(record), clone(record));
      return clone(record);
    },
    async get(owner, id) {
      return clone(records.get(`${owner}:${id}`) || null);
    },
    async delete(owner, id) {
      records.delete(`${owner}:${id}`);
    },
    async list(owner, statuses = []) {
      const accepted = new Set(statuses);
      return [...records.values()]
        .filter(record => record.owner === owner && (!accepted.size || accepted.has(record.status)))
        .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id))
        .map(clone);
    },
    async clear(owner) {
      for (const [key, record] of records) if (record.owner === owner) records.delete(key);
    }
  };
}

const requestResult = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.addEventListener("complete", resolve, { once: true });
  transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  transaction.addEventListener("error", () => reject(transaction.error), { once: true });
});

export function createIndexedDbSyncStore({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = "cike-sync",
  storeName = "operations"
} = {}) {
  if (!indexedDBImpl) return createMemorySyncStore();
  const fallback = createMemorySyncStore();
  let unavailable = false;
  const opening = indexedDBImpl.open(databaseName, 1);
  opening.addEventListener("upgradeneeded", () => {
    const db = opening.result;
    if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
  }, { once: true });
  const ready = new Promise(resolve => {
    opening.addEventListener("success", () => {
      const db = opening.result;
      db.addEventListener("versionchange", () => {
        unavailable = true;
        db.close();
      });
      resolve(db);
    }, { once: true });
    opening.addEventListener("error", () => {
      unavailable = true;
      resolve(null);
    }, { once: true });
    opening.addEventListener("blocked", () => {
      unavailable = true;
      resolve(null);
    }, { once: true });
  });
  const withStore = async (mode, action) => {
    const db = await ready;
    if (!db || unavailable) throw new Error("IndexedDB unavailable");
    const transaction = db.transaction(storeName, mode);
    const done = transactionDone(transaction);
    try {
      const result = await action(transaction.objectStore(storeName));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  };
  return {
    get durable() {
      return !unavailable;
    },
    async put(record) {
      const value = { ...clone(record), key: recordKey(record) };
      try {
        await withStore("readwrite", store => requestResult(store.put(value)));
      } catch {
        unavailable = true;
        return fallback.put(record);
      }
      delete value.key;
      return value;
    },
    async get(owner, id) {
      if (unavailable) return fallback.get(owner, id);
      let value;
      try {
        value = await withStore("readonly", store => requestResult(store.get(`${owner}:${id}`)));
      } catch {
        unavailable = true;
        return fallback.get(owner, id);
      }
      if (!value) return null;
      delete value.key;
      return value;
    },
    async delete(owner, id) {
      if (unavailable) return fallback.delete(owner, id);
      try {
        await withStore("readwrite", store => requestResult(store.delete(`${owner}:${id}`)));
      } catch {
        unavailable = true;
        await fallback.delete(owner, id);
      }
    },
    async list(owner, statuses = []) {
      const accepted = new Set(statuses);
      let values;
      try {
        values = unavailable
          ? await fallback.list(owner, statuses)
          : await withStore("readonly", store => requestResult(store.getAll()));
      } catch {
        unavailable = true;
        return fallback.list(owner, statuses);
      }
      return values
        .filter(record => record.owner === owner && (!accepted.size || accepted.has(record.status)))
        .map(record => {
          delete record.key;
          return record;
        })
        .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id));
    },
    async clear(owner) {
      if (!unavailable) {
        try {
          await withStore("readwrite", async store => {
            const values = await requestResult(store.getAll());
            await Promise.all(values.filter(record => record.owner === owner).map(record => requestResult(store.delete(record.key))));
          });
        } catch {
          unavailable = true;
        }
      }
      await fallback.clear(owner);
    }
  };
}

export function createRequestCoordinator({
  store,
  send,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  resourceKey = defaultResourceKey
}) {
  if (!store || typeof send !== "function") throw new Error("同步协调器缺少存储或发送实现");
  const tails = new Map();
  const deliveries = new Map();
  const generations = new Map();
  const subscribers = new Set();
  const generation = owner => generations.get(owner) || 0;
  const elapsed = (from, to) => {
    const start = new Date(from || "").getTime(), end = new Date(to || "").getTime();
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  };
  const notify = record => {
    const value = clone(record);
    for (const subscriber of subscribers) {
      try {
        subscriber(value);
      } catch {}
    }
  };
  const update = async (record, changes, expectedGeneration) => {
    if (generation(record.owner) !== expectedGeneration) return null;
    const next = { ...record, ...changes, updatedAt: now() };
    await store.put(next);
    notify(next);
    return next;
  };
  const pruneRecords = async (owner, { keepCommitted = 200, keepTerminal = 50 } = {}) => {
    if (typeof store.delete !== "function") return 0;
    const records = await store.list(owner);
    const staleCommitted = records
      .filter(record => record.status === "committed")
      .sort((left, right) => String(right.committedAt || right.updatedAt || "").localeCompare(String(left.committedAt || left.updatedAt || "")))
      .slice(Math.max(0, keepCommitted));
    const staleTerminal = records
      .filter(record => ["conflict", "failed"].includes(record.status))
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(Math.max(0, keepTerminal));
    const stale = [...staleCommitted, ...staleTerminal];
    await Promise.all(stale.map(record => store.delete(owner, record.id)));
    return stale.length;
  };
  const commit = async (current, result, startedAt, expectedGeneration, recovered = false) => {
    const ack = result?.meta?.operation;
    const acknowledgedAt = now();
    const committed = {
      id: current.id,
      owner: current.owner,
      operationId: current.operationId,
      fingerprint: current.fingerprint,
      resourceKey: current.resourceKey,
      method: current.method,
      url: current.url,
      status: "committed",
      attempts: current.attempts,
      createdAt: current.createdAt,
      updatedAt: acknowledgedAt,
      committedAt: acknowledgedAt,
      enqueueToAckMs: elapsed(current.createdAt, acknowledgedAt),
      requestMs: elapsed(startedAt, acknowledgedAt),
      domains: [...(current.domains || [])],
      ...(recovered ? { responseAvailable: false } : {}),
      ...(ack ? { ack: clone(ack) } : {})
    };
    if (generation(current.owner) === expectedGeneration) {
      await store.put(committed);
      notify(committed);
      await pruneRecords(current.owner);
    }
    return result;
  };
  const recoverCommitted = async current => {
    if (!current.recoverCommitted || !current.fingerprint) return null;
    try {
      const query = new URLSearchParams({ fingerprint: current.fingerprint });
      const result = await send(`/api/v1/sync/operations/${encodeURIComponent(current.operationId)}?${query}`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (result?.data?.status !== "committed") return null;
      return {
        data: null,
        meta: {
          operation: {
            ...result.data,
            recovered: true
          }
        }
      };
    } catch (error) {
      if (error?.code === "OPERATION_ID_REUSED") throw error;
      return null;
    }
  };
  const deliver = async (record, expectedGeneration) => {
    const startedAt = now();
    let current = await update(record, {
      status: "sending",
      attempts: Number(record.attempts || 0) + 1,
      lastError: null,
      requestStartedAt: startedAt
    }, expectedGeneration);
    if (!current) throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
    try {
      const result = await send(current.url, replayOptions(current));
      return commit(current, result, startedAt, expectedGeneration);
    } catch (error) {
      const status = Number(error?.status || 0), mayHaveCommitted = !status || [...CONFLICT_STATUSES, 404].includes(status);
      let terminalError = error;
      if (mayHaveCommitted) {
        try {
          const recovered = await recoverCommitted(current);
          if (recovered) return commit(current, recovered, startedAt, expectedGeneration, true);
        } catch (recoveryError) {
          terminalError = recoveryError;
        }
      }
      const terminalStatus = Number(terminalError?.status || status || 0);
      const canRetry = retryable(terminalError) && current.attempts < SYNC_RETRY_MAX_ATTEMPTS;
      const nextStatus = CONFLICT_STATUSES.has(terminalStatus) ? "conflict" : canRetry ? "pending" : "failed";
      const delayMs = nextStatus === "pending" ? retryDelay(terminalError, current.attempts) : 0;
      const retryAt = delayMs ? new Date(new Date(now()).getTime() + delayMs).toISOString() : null;
      const updated = await update(current, {
        status: nextStatus,
        nextAttemptAt: retryAt,
        lastError: {
          status: terminalStatus,
          code: terminalError?.code || "",
          message: terminalError?.message || "请求失败",
          retryExhausted: retryable(terminalError) && !canRetry
        }
      }, expectedGeneration);
      if (updated && ["conflict", "failed"].includes(updated.status)) await pruneRecords(current.owner);
      try {
        terminalError.syncStatus = nextStatus;
      } catch {}
      throw terminalError;
    }
  };
  const schedule = (record, expectedGeneration = generation(record.owner)) => {
    const deliveryKey = `${record.owner}:${record.id}`;
    if (deliveries.has(deliveryKey)) return deliveries.get(deliveryKey);
    const key = `${record.owner}:${record.resourceKey}`;
    const previous = tails.get(key) || Promise.resolve();
    const execution = previous.catch(() => {}).then(() => deliver(record, expectedGeneration));
    deliveries.set(deliveryKey, execution);
    tails.set(key, execution);
    void execution.finally(() => {
      if (deliveries.get(deliveryKey) === execution) deliveries.delete(deliveryKey);
      if (tails.get(key) === execution) tails.delete(key);
    }).catch(() => {});
    return execution;
  };
  return {
    async request({
      owner,
      url,
      options = {},
      resource = "",
      domains = [],
      projection = null,
      recoverCommitted = false,
      onQueued = () => {}
    }) {
      if (!owner) throw new Error("写请求缺少账户标识");
      const expectedGeneration = generation(owner);
      const method = String(options.method || "POST").toUpperCase();
      const headers = lowerCaseHeaders(options.headers);
      headers["content-type"] ||= "application/json";
      const operationId = headers["x-client-operation-id"] || headers["idempotency-key"] || createId();
      headers["x-client-operation-id"] = operationId;
      headers["idempotency-key"] ||= operationId;
      const operationResource = resource || resourceKey(url, options);
      const fingerprint = await syncOperationFingerprint({ method, url, headers, body: options.body });
      headers["x-client-operation-fingerprint"] = fingerprint;
      const timestamp = now();
      const record = {
        id: `${method}:${operationResource}:${operationId}`,
        owner,
        operationId,
        fingerprint,
        resourceKey: operationResource,
        recoverCommitted: Boolean(recoverCommitted),
        method,
        url,
        headers,
        ...(Object.hasOwn(options, "body") ? { body: options.body } : {}),
        domains: [...new Set(domains.map(String).filter(Boolean))],
        ...(projection ? { projection: clone(projection) } : {}),
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await store.put(record);
      notify(record);
      try {
        await onQueued(clone(record));
      } catch {}
      if (generation(owner) !== expectedGeneration) {
        await store.clear(owner);
        throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
      }
      return schedule(record, expectedGeneration);
    },
    async resume(owner, { force = false } = {}) {
      if (!owner) return [];
      const expectedGeneration = generation(owner);
      const records = await store.list(owner, ["pending", "sending"]);
      const currentTime = new Date(now()).getTime();
      const due = records.filter(record => {
        const nextAttemptTime = new Date(record.nextAttemptAt || "").getTime();
        return force
          || record.status === "sending"
          || !Number.isFinite(nextAttemptTime)
          || nextAttemptTime <= currentTime;
      });
      return Promise.allSettled(due.map(record => schedule({ ...record, status: "pending" }, expectedGeneration)));
    },
    list(owner, statuses = []) {
      return store.list(owner, statuses);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async metrics(owner) {
      const records = await store.list(owner);
      const pending = records.filter(record => ["pending", "sending"].includes(record.status));
      const committed = records.filter(record => record.status === "committed");
      const sortedDurations = committed.map(record => Number(record.enqueueToAckMs) || 0).sort((a, b) => a - b);
      const percentile = value => sortedDurations.length
        ? sortedDurations[Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * value) - 1)]
        : 0;
      return {
        durable: store.durable !== false,
        pending: pending.length,
        conflicts: records.filter(record => record.status === "conflict").length,
        failed: records.filter(record => record.status === "failed").length,
        oldestPendingAt: pending[0]?.createdAt || "",
        enqueueToAckP95Ms: percentile(0.95)
      };
    },
    async prune(owner, { keepCommitted = 200 } = {}) {
      return pruneRecords(owner, { keepCommitted });
    },
    async clear(owner) {
      generations.set(owner, generation(owner) + 1);
      await store.clear(owner);
      notify({ owner, status: "cleared", domains: [] });
    }
  };
}

export function createSyncChannel({
  name = "cike-account-sync",
  BroadcastChannelImpl = globalThis.BroadcastChannel
} = {}) {
  if (!BroadcastChannelImpl) {
    return { publish() {}, subscribe() { return () => {}; }, close() {} };
  }
  const channel = new BroadcastChannelImpl(name);
  const listeners = new Set();
  channel.addEventListener("message", event => {
    for (const listener of listeners) listener(clone(event.data));
  });
  return {
    publish(message) {
      channel.postMessage(clone(message));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel.close();
    }
  };
}

export function createIncrementalSync({
  coordinator,
  request,
  applySnapshot,
  resnapshot,
  storage = globalThis.localStorage,
  channel = createSyncChannel(),
  locks = globalThis.navigator?.locks,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  pollMs = 1500,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  now = () => Date.now(),
  onStatus = () => {}
}) {
  if (!coordinator || typeof request !== "function" || typeof applySnapshot !== "function") {
    throw new TypeError("增量同步缺少协调器、请求或快照应用器");
  }
  let owner = "";
  let cursor = null;
  let timer = null;
  let pulling = null;
  let stopped = true;
  let pullEnabled = true;
  let lifecycle = 0;
  let unsubscribeChannel = () => {};
  let unsubscribeCoordinator = () => {};
  const active = (expectedOwner, expectedLifecycle) => (
    !stopped && owner === expectedOwner && lifecycle === expectedLifecycle
  );
  const cursorKey = value => `cike-sync-cursor:${value}`;
  const storeCursor = (value, { reset = false } = {}) => {
    const next = Math.max(0, Number(value) || 0);
    cursor = reset ? next : Math.max(cursor || 0, next);
    try {
      storage?.setItem(cursorKey(owner), String(cursor));
    } catch {}
  };
  const readCursor = value => {
    try {
      const parsed = Number(storage?.getItem(cursorKey(value)) || 0);
      return Number.isSafeInteger(parsed) && parsed >= 0 && storage?.getItem(cursorKey(value)) != null
        ? parsed
        : null;
    } catch {
      return 0;
    }
  };
  const visible = () => !documentTarget || documentTarget.visibilityState !== "hidden";
  const schedulePoll = delay => {
    if (stopped || timer != null) return;
    timer = setTimer(async () => {
      timer = null;
      if (visible()) await drain().catch(() => {});
      schedulePoll(pollMs);
    }, delay);
  };
  const withDrainLock = (lockOwner, operation) => {
    if (!locks?.request) return operation();
    return locks.request(`cike-sync-drain:${lockOwner}`, { ifAvailable: true }, lock => (
      lock ? operation() : []
    ));
  };
  const pull = ({ wait = false } = {}) => {
    if (!owner || stopped || !pullEnabled) return Promise.resolve(false);
    if (pulling) return pulling;
    const expectedOwner = owner;
    const expectedLifecycle = lifecycle;
    const startedAt = now();
    const execution = (async () => {
      try {
        const query = new URLSearchParams({ waitMs: String(wait ? Math.min(1500, pollMs) : 0) });
        if (cursor != null) query.set("cursor", String(cursor));
        const result = await request(`/api/v1/sync?${query}`);
        if (!active(expectedOwner, expectedLifecycle)) return false;
        const payload = result?.data || result;
        if (!payload || !Number.isSafeInteger(payload.cursor)) throw new Error("同步响应无效");
        if (payload.changes?.length) await applySnapshot(payload.snapshot || {}, payload.changes);
        if (!active(expectedOwner, expectedLifecycle)) return false;
        storeCursor(payload.cursor);
        onStatus({
          type: "pull",
          owner: expectedOwner,
          cursor,
          changes: payload.changes?.length || 0,
          durationMs: now() - startedAt
        });
        return Boolean(payload.changes?.length);
      } catch (error) {
        if (!active(expectedOwner, expectedLifecycle)) return false;
        if (["SYNC_CURSOR_EXPIRED", "SYNC_RESNAPSHOT_REQUIRED", "SYNC_CURSOR_AHEAD"].includes(error?.code)) {
          await resnapshot?.();
          if (!active(expectedOwner, expectedLifecycle)) return false;
          storeCursor(error.details?.currentCursor || 0, { reset: true });
          onStatus({ type: "resnapshot", owner: expectedOwner, cursor, code: error.code, durationMs: now() - startedAt });
          return true;
        }
        onStatus({ type: "error", owner: expectedOwner, cursor, code: error?.code || "", durationMs: now() - startedAt });
        throw error;
      } finally {
        if (pulling === execution) pulling = null;
      }
    })();
    pulling = execution;
    return execution;
  };
  const drain = async ({ forceRetry = false } = {}) => {
    if (!owner || stopped) return [];
    const expectedOwner = owner;
    const expectedLifecycle = lifecycle;
    const result = await withDrainLock(expectedOwner, () => coordinator.resume(expectedOwner, { force: forceRetry }));
    if (!active(expectedOwner, expectedLifecycle)) return [];
    const terminalFailure = result.some(item => item.status === "rejected"
      && ["failed", "conflict"].includes(item.reason?.syncStatus));
    if (result.some(item => item.status === "fulfilled") || terminalFailure) {
      await resnapshot?.();
      if (!active(expectedOwner, expectedLifecycle)) return [];
    }
    if (pullEnabled) await pull();
    else onStatus({ type: "disabled", owner: expectedOwner, cursor });
    return result;
  };
  const onOnline = () => void drain({ forceRetry: true }).catch(() => {});
  const onPageShow = () => void drain().catch(() => {});
  const onVisibility = () => {
    if (visible()) void drain().catch(() => {});
  };

  return {
    async start(nextOwner, { incremental = true } = {}) {
      this.stop();
      owner = String(nextOwner || "");
      if (!owner) return false;
      cursor = readCursor(owner);
      pullEnabled = Boolean(incremental);
      stopped = false;
      const expectedOwner = owner;
      const expectedLifecycle = lifecycle;
      unsubscribeChannel = channel.subscribe(message => {
        if (pullEnabled && message?.owner === owner && message?.type === "committed") void pull().catch(() => {});
      });
      unsubscribeCoordinator = coordinator.subscribe(record => {
        if (record.owner !== owner) return;
        onStatus({
          type: "operation",
          owner,
          operationId: record.operationId || record.id || "",
          status: record.status,
          domains: record.domains || [],
          ageMs: record.createdAt ? Math.max(0, now() - new Date(record.createdAt).getTime()) : 0
        });
        if (pullEnabled && record.status === "committed") {
          channel.publish({
            type: "committed",
            owner,
            operationId: record.operationId,
            domains: record.domains || []
          });
          void pull().catch(() => {});
        }
      });
      windowTarget?.addEventListener?.("online", onOnline);
      windowTarget?.addEventListener?.("pageshow", onPageShow);
      documentTarget?.addEventListener?.("visibilitychange", onVisibility);
      try {
        if (pullEnabled) await pull();
        if (!active(expectedOwner, expectedLifecycle)) return false;
        await drain();
        if (!active(expectedOwner, expectedLifecycle)) return false;
        await coordinator.prune?.(owner);
        return true;
      } finally {
        if (active(expectedOwner, expectedLifecycle) && pullEnabled) schedulePoll(pollMs);
      }
    },
    stop() {
      lifecycle += 1;
      stopped = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      pulling = null;
      pullEnabled = true;
      unsubscribeChannel();
      unsubscribeCoordinator();
      unsubscribeChannel = () => {};
      unsubscribeCoordinator = () => {};
      windowTarget?.removeEventListener?.("online", onOnline);
      windowTarget?.removeEventListener?.("pageshow", onPageShow);
      documentTarget?.removeEventListener?.("visibilitychange", onVisibility);
      owner = "";
      cursor = null;
    },
    pull,
    drain,
    cursor: () => cursor || 0
  };
}
