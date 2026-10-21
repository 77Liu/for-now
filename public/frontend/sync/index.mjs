import { workspaceSyncStore } from "../../generated/workspace-sync-store.mjs";
import {
  createRecordSyncLoop as createRecordSyncLoopImpl,
  createScopedIncrementalSync
} from "../../generated/incremental-sync.mjs";
import { BUSINESS_ID_BYTES, encodeBusinessId, isBusinessCreationPath, isBusinessId } from "../../generated/business-identifiers.mjs";
import { remapBusinessReferences, remapBusinessUrl } from "../../generated/business-id-remap.mjs";

const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const CONFLICT_STATUSES = new Set([409, 412]);
export const SYNC_RETRY_MAX_ATTEMPTS = 8;
export const SYNC_CLIENT_CONTRACT_VERSION = "1.0.0";
const SYNC_RETRY_BASE_MS = 1000;
const SYNC_RETRY_MAX_MS = 60_000;
const SYNC_RETRY_AFTER_MAX_MS = 5 * 60_000;

const clone = value => value == null ? value : structuredClone(value);
const recordKey = record => `${record.owner}:${record.queueId || record.id}`;
const mappingKey = owner => `${owner}:$business-id-mappings`;
const sameSnapshot = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha256Hex = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const lowerCaseHeaders = headers => {
  const normalized = {};
  for (const [name, value] of new Headers(headers || {}).entries()) normalized[name.toLowerCase()] = value;
  return normalized;
};
const equalHeaders = (left, right) => {
  const leftEntries = Object.entries(left || {}), rightEntries = Object.entries(right || {});
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, value]) => right[name] === value);
};
const defaultResourceKey = url => {
  const parsed = new URL(url, "https://local.invalid");
  return `${parsed.pathname}${parsed.search}`;
};
const businessCreation = (method, url) => method === "POST"
  && isBusinessCreationPath(method, new URL(url, "https://local.invalid").pathname);
const remapQueuedRecord = async (record, mappings) => {
  const dependencies = record.dependsOn || [];
  let url = record.url, resourceKey = record.resourceKey, projection = record.projection;
  let body = record.body;
  for (const dependency of dependencies) {
    const mapping = mappings.find(item => item.operationId === dependency.operationId);
    if (!mapping) continue;
    url = remapBusinessUrl(url, mapping, dependency.urlSegments);
    resourceKey = remapBusinessUrl(resourceKey, mapping, dependency.urlSegments);
    if (typeof body === "string" && dependency.bodyPointers?.length) {
      body = JSON.stringify(remapBusinessReferences(JSON.parse(body), mapping, dependency.bodyPointers));
    }
    if (projection && dependency.projectionPointers?.length) {
      projection = remapBusinessReferences(projection, mapping, dependency.projectionPointers);
    }
  }
  const requestChanged = url !== record.url || body !== record.body;
  if (!requestChanged && resourceKey === record.resourceKey && sameSnapshot(projection, record.projection)) return record;
  if (requestChanged && Number(record.attempts || 0)) throw Object.assign(new Error("已发送的依赖请求需要先恢复回执"), { code: "DEPENDENCY_ALREADY_SENT" });
  const fingerprint = requestChanged ? await syncOperationFingerprint({ ...record, url, body }) : record.fingerprint;
  return { ...record, url, ...(Object.hasOwn(record, "body") ? { body } : {}), fingerprint,
    resourceKey,
    headers: { ...record.headers, "x-client-operation-fingerprint": fingerprint },
    ...(projection ? { projection } : {}) };
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
  const mappings = new Map();
  return {
    durable: false,
    async readMappings(owner) { return clone(mappings.get(owner) || []); },
    async atomicWrite(owner, expectedRows, expectedMappings, nextRows, nextMappings) {
      const rows = [...records.values()].filter(row => row.owner === owner)
        .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id)).map(clone);
      if (!sameSnapshot(rows, expectedRows) || !sameSnapshot(mappings.get(owner) || [], expectedMappings)) return false;
      for (const row of nextRows) records.set(recordKey(row), clone(row));
      mappings.set(owner, clone(nextMappings));
      return true;
    },
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
      mappings.delete(owner);
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
    async readMappings(owner) {
      if (unavailable) throw new Error("业务映射持久化不可用");
      return (await withStore("readonly", store => requestResult(store.get(mappingKey(owner)))))?.mappings || [];
    },
    async atomicWrite(owner, expectedRows, expectedMappings, nextRows, nextMappings) {
      // 指纹计算已在事务外完成；这里仅执行读校验与同步入队的 IDB 请求。
      return withStore("readwrite", async store => {
        const all = await requestResult(store.getAll());
        const rows = all.filter(row => row.owner === owner && !row.mappingRegistry).map(row => {
          const value = { ...row }; delete value.key; return value;
        }).sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id));
        const saved = all.find(row => row.key === mappingKey(owner))?.mappings || [];
        if (!sameSnapshot(rows, expectedRows) || !sameSnapshot(saved, expectedMappings)) return false;
        const writes = nextRows.map(row => requestResult(store.put({ ...clone(row), key: recordKey(row) })));
        writes.push(requestResult(store.put({ key: mappingKey(owner), owner, mappingRegistry: true, mappings: clone(nextMappings) })));
        await Promise.all(writes);
        return true;
      });
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
        .filter(record => !record.mappingRegistry && record.owner === owner && (!accepted.size || accepted.has(record.status)))
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

/**
 * 持久写入协调入口；可选getWorkspace/getScope自unreleased起隔离测试空间及会话异步归属。
 * 对外owner和业务映射保持真实账户，旧无工作区存储与调用保持兼容。
 */
export function createRequestCoordinator(options) {
  const getWorkspace = options.getWorkspace || (() => "");
  const instances = new Map(), listeners = new Set();
  const current = () => {
    const workspace = getWorkspace();
    if (!instances.has(workspace)) {
      const instance = createWorkspaceRequestCoordinator({ ...options,
        store: workspaceSyncStore(options.store, workspace),
        send: (url, requestOptions) => {
          if (workspace !== getWorkspace()) throw Object.assign(new Error("工作区已变化"), { name: "AbortError" });
          return options.send(url, requestOptions);
        }
      });
      instance.subscribe(record => {
        if (workspace !== getWorkspace()) return;
        for (const listener of listeners) listener({ ...record, ...(workspace ? { workspace } : {}) });
      });
      instances.clear();
      instances.set(workspace, instance);
    }
    return instances.get(workspace);
  };
  return {
    request: input => current().request(input),
    resume: (...args) => current().resume(...args),
    list: (...args) => current().list(...args),
    metrics: (...args) => current().metrics(...args),
    prune: (...args) => current().prune(...args),
    clear: (...args) => current().clear(...args),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

function createWorkspaceRequestCoordinator({
  store,
  send,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  resourceKey = defaultResourceKey,
  getScope = () => ""
}) {
  if (!store || typeof send !== "function") throw new Error("同步协调器缺少存储或发送实现");
  const tails = new Map();
  const deliveries = new Map();
  const generations = new Map();
  const subscribers = new Set();
  const generation = owner => `${generations.get(owner) || 0}:${getScope()}`;
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
    if (generation(record.owner) !== expectedGeneration) return null;
    notify(next);
    return next;
  };
  const normalizeOperationFingerprint = async (record, expectedGeneration, changes = {}) => {
    const headers = lowerCaseHeaders(record.headers);
    headers["content-type"] ||= "application/json";
    headers["x-client-contract-version"] ||= SYNC_CLIENT_CONTRACT_VERSION;
    const operationId = String(
      record.operationId
      || headers["x-client-operation-id"]
      || headers["idempotency-key"]
      || ""
    );
    if (operationId) headers["x-client-operation-id"] = operationId;
    const fingerprint = await syncOperationFingerprint({
      method: record.method,
      url: record.url,
      headers,
      body: Object.hasOwn(record, "body") ? record.body : ""
    });
    headers["x-client-operation-fingerprint"] = fingerprint;
    if (generation(record.owner) !== expectedGeneration) return null;
    const normalized = {
      operationId,
      fingerprint,
      headers,
      ...changes
    };
    if (record.operationId === normalized.operationId
      && record.fingerprint === normalized.fingerprint
      && equalHeaders(record.headers, normalized.headers)
      && Object.entries(changes).every(([key, value]) => record[key] === value)) {
      return record;
    }
    return update(record, normalized, expectedGeneration);
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
      const mapping = ack?.businessIdMapping;
      if (current.headers?.["x-client-provisional-id"] && (!mapping || ack.status !== "committed")) {
        throw Object.assign(new Error("创建回执缺少持久业务映射"), { code: "BUSINESS_MAPPING_ACK_REQUIRED" });
      }
      if (mapping) {
        if (mapping.accountId !== current.owner || !isBusinessId(mapping.provisionalId)
          || mapping.operationId !== current.operationId || !isBusinessId(mapping.canonicalId)
          || mapping.provisionalId !== current.headers?.["x-client-provisional-id"]) {
          throw Object.assign(new Error("业务映射与账户或操作不匹配"), { code: "INVALID_BUSINESS_MAPPING" });
        }
        let saved = false;
        for (let attempt = 0; attempt < SYNC_RETRY_MAX_ATTEMPTS && !saved; attempt += 1) {
          const rows = await store.list(current.owner);
          const mappings = await store.readMappings(current.owner);
          const previous = mappings.find(item => item.operationId === mapping.operationId);
          if (previous && previous.canonicalId !== mapping.canonicalId) throw new Error("业务映射不能更换正式身份");
          const nextMappings = previous ? mappings : [...mappings, mapping];
          const nextRows = await Promise.all(rows.map(row => row.id === current.id ? committed
            : ["pending", "sending"].includes(row.status) ? remapQueuedRecord(row, nextMappings) : row));
          if (generation(current.owner) !== expectedGeneration) throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
          saved = await store.atomicWrite(current.owner, rows, mappings, nextRows, nextMappings);
        }
        if (!saved) throw new Error("业务映射原子保存冲突，请重试");
      } else await store.put(committed);
      if (generation(current.owner) !== expectedGeneration) return result;
      notify(committed);
      await pruneRecords(current.owner);
    }
    return result;
  };
  const recoverCommitted = async (current, expectedGeneration) => {
    if (!current.recoverCommitted || !current.fingerprint) return null;
    try {
      if (generation(current.owner) !== expectedGeneration) throw Object.assign(new Error("同步作用域已变化"), { name: "AbortError" });
      const query = new URLSearchParams({ fingerprint: current.fingerprint });
      const result = await send(`/api/v1/sync/operations/${encodeURIComponent(current.operationId)}?${query}`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (generation(current.owner) !== expectedGeneration) throw Object.assign(new Error("同步作用域已变化"), { name: "AbortError" });
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
      if (error?.code === "OPERATION_ID_REUSED" || error?.name === "AbortError") throw error;
      return null;
    }
  };
  const deliver = async (record, expectedGeneration) => {
    if (generation(record.owner) !== expectedGeneration) throw Object.assign(new Error("同步作用域已变化"), { name: "AbortError" });
    const pending = await store.list(record.owner, ["pending", "sending"]);
    const mappings = store.readMappings ? await store.readMappings(record.owner) : [];
    for (const dependency of record.dependsOn || []) {
      if (mappings.some(mapping => mapping.operationId === dependency.operationId)) continue;
      const parent = pending.find(row => row.operationId === dependency.operationId && row.id !== record.id);
      if (!parent?.headers?.["x-client-provisional-id"]) {
        throw Object.assign(new Error("依赖创建尚未提交"), { code: "BUSINESS_DEPENDENCY_PENDING", syncStatus: "pending" });
      }
      const delivery = deliveries.get(`${parent.owner}:${parent.id}`);
      if (!delivery) throw Object.assign(new Error("依赖创建尚未提交"), { code: "BUSINESS_DEPENDENCY_PENDING", syncStatus: "pending" });
      try { await delivery; } catch {
        throw Object.assign(new Error("依赖创建尚未提交"), { code: "BUSINESS_DEPENDENCY_PENDING", syncStatus: "pending" });
      }
    }
    record = await store.get(record.owner, record.queueId || record.id) || record;
    // A resume snapshot can become stale while its fingerprint is normalized.
    // A committed row has intentionally discarded request headers/body.
    if (record.status === "committed") {
      return { data: null, meta: { operation: { ...record.ack, recovered: true } } };
    }
    if (["failed", "conflict"].includes(record.status)) {
      throw Object.assign(new Error(record.lastError?.message || "请求已终止"),
        record.lastError || {}, { syncStatus: record.status });
    }
    const startedAt = now();
    let current = await update(record, {
      status: "sending",
      attempts: Number(record.attempts || 0) + 1,
      lastError: null,
      requestStartedAt: startedAt
    }, expectedGeneration);
    if (!current) throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
    try {
      if (generation(current.owner) !== expectedGeneration) throw Object.assign(new Error("同步作用域已变化"), { name: "AbortError" });
      const result = await send(current.url, replayOptions(current));
      return await commit(current, result, startedAt, expectedGeneration);
    } catch (error) {
      if (generation(current.owner) !== expectedGeneration) throw error;
      if (error?.code === "INVALID_OPERATION_FINGERPRINT"
        && Number(current.fingerprintRetryCount || 0) < 1) {
        current = await normalizeOperationFingerprint(current, expectedGeneration, {
          fingerprintRetryCount: 1
        });
        if (!current) throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
        try {
          if (generation(current.owner) !== expectedGeneration) throw Object.assign(new Error("同步作用域已变化"), { name: "AbortError" });
          const result = await send(current.url, replayOptions(current));
          return await commit(current, result, startedAt, expectedGeneration);
        } catch (retryError) {
          error = retryError;
        }
      }
      const status = Number(error?.status || 0), mayHaveCommitted = !status || [...CONFLICT_STATUSES, 404].includes(status);
      let terminalError = error;
      if (mayHaveCommitted) {
        try {
          const recovered = await recoverCommitted(current, expectedGeneration);
          if (recovered) return await commit(current, recovered, startedAt, expectedGeneration, true);
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
  const schedule = (record, expectedGeneration = generation(record.owner), ready = Promise.resolve()) => {
    const deliveryKey = `${record.owner}:${record.id}`;
    if (deliveries.has(deliveryKey)) return deliveries.get(deliveryKey);
    const key = `${record.owner}:${record.resourceKey}`;
    const previous = tails.get(key) || Promise.resolve();
    const execution = previous.catch(() => {}).then(() => ready).then(() => deliver(record, expectedGeneration));
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
      allocateBusinessId = false,
      provisionalId = "",
      dependsOn = [],
      onQueued = () => {}
    }) {
      if (!owner) throw new Error("写请求缺少账户标识");
      const expectedGeneration = generation(owner), expectedScope = getScope();
      const method = String(options.method || "POST").toUpperCase();
      const headers = lowerCaseHeaders(options.headers);
      headers["content-type"] ||= "application/json";
      const operationId = headers["x-client-operation-id"] || headers["idempotency-key"] || createId();
      headers["x-client-operation-id"] = operationId;
      headers["idempotency-key"] ||= operationId;
      headers["x-client-contract-version"] ||= SYNC_CLIENT_CONTRACT_VERSION;
      if (allocateBusinessId && businessCreation(method, url)) {
        if (provisionalId && !isBusinessId(provisionalId)) throw new Error("临时业务身份格式无效");
        headers["x-client-provisional-id"] ||= provisionalId || encodeBusinessId(crypto.getRandomValues(new Uint8Array(BUSINESS_ID_BYTES)));
      }
      const operationResource = resource || resourceKey(url, options);
      const fingerprint = await syncOperationFingerprint({ method, url, headers, body: options.body });
      headers["x-client-operation-fingerprint"] = fingerprint;
      const timestamp = now();
      let record = {
        id: `${method}:${operationResource}:${operationId}`,
        owner,
        operationId,
        dependsOn: dependsOn.map(dependency => {
          if (!dependency || typeof dependency.operationId !== "string") throw new Error("业务依赖需要创建操作和引用位置");
          return { operationId: dependency.operationId, urlSegments: [...(dependency.urlSegments || [])],
            bodyPointers: [...(dependency.bodyPointers || [])], projectionPointers: [...(dependency.projectionPointers || [])] };
        }),
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
        fingerprintRetryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (store.readMappings && store.atomicWrite) {
        let saved = false;
        for (let attempt = 0; attempt < SYNC_RETRY_MAX_ATTEMPTS && !saved; attempt += 1) {
          const rows = await store.list(owner);
          const mappings = await store.readMappings(owner);
          record = await remapQueuedRecord(record, mappings);
          saved = await store.atomicWrite(owner, rows, mappings, [...rows.filter(row => row.id !== record.id), record], mappings);
        }
        if (!saved) throw new Error("离线请求入队冲突，请重试");
      } else await store.put(record);
      // Reserve delivery before publishing the queued state: resume must share
      // this promise while asynchronous projection/draft persistence finishes.
      let releaseQueued;
      const queued = new Promise(resolve => { releaseQueued = resolve; });
      const delivery = schedule(record, expectedGeneration, queued);
      notify(record);
      try {
        try { await onQueued(clone(record)); } catch {}
        if (generation(owner) !== expectedGeneration && expectedScope === getScope()) await store.clear(owner);
      } finally {
        releaseQueued();
      }
      return delivery;
    },
    async resume(owner, { force = false } = {}) {
      if (!owner) return [];
      const expectedGeneration = generation(owner);
      const records = await store.list(owner, ["pending", "sending"]);
      const normalized = (await Promise.all(records.map(record => (
        normalizeOperationFingerprint(record, expectedGeneration)
      )))).filter(Boolean);
      const currentTime = new Date(now()).getTime();
      const due = normalized.filter(record => {
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
      generations.set(owner, (generations.get(owner) || 0) + 1);
      const expectedGeneration = generation(owner);
      await store.clear(owner);
      if (generation(owner) === expectedGeneration) notify({ owner, status: "cleared", domains: [] });
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

/** 增量同步公开入口；可选作用域/取消端口自unreleased起由有界TS实现提供。 */
export function createIncrementalSync(options = {}) {
  return createScopedIncrementalSync({ ...options, channel: options.channel ?? createSyncChannel() });
}

export function createRecordSyncLoop(options = {}) {
  return createRecordSyncLoopImpl(options);
}
