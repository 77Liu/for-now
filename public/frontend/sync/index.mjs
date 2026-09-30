const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const CONFLICT_STATUSES = new Set([409, 412]);

const clone = value => value == null ? value : structuredClone(value);
const recordKey = record => `${record.owner}:${record.id}`;
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

export function createMemorySyncStore(initial = []) {
  const records = new Map(initial.map(record => [recordKey(record), clone(record)]));
  return {
    async put(record) {
      records.set(recordKey(record), clone(record));
      return clone(record);
    },
    async get(owner, id) {
      return clone(records.get(`${owner}:${id}`) || null);
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
  if (!indexedDBImpl) throw new Error("当前环境不支持 IndexedDB");
  const opening = indexedDBImpl.open(databaseName, 1);
  opening.addEventListener("upgradeneeded", () => {
    const db = opening.result;
    if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
  }, { once: true });
  const ready = requestResult(opening);
  void ready.catch(() => {});
  const withStore = async (mode, action) => {
    const db = await ready;
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
    async put(record) {
      const value = { ...clone(record), key: recordKey(record) };
      await withStore("readwrite", store => requestResult(store.put(value)));
      delete value.key;
      return value;
    },
    async get(owner, id) {
      const value = await withStore("readonly", store => requestResult(store.get(`${owner}:${id}`)));
      if (!value) return null;
      delete value.key;
      return value;
    },
    async list(owner, statuses = []) {
      const accepted = new Set(statuses);
      const values = await withStore("readonly", store => requestResult(store.getAll()));
      return values
        .filter(record => record.owner === owner && (!accepted.size || accepted.has(record.status)))
        .map(record => {
          delete record.key;
          return record;
        })
        .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id));
    },
    async clear(owner) {
      await withStore("readwrite", async store => {
        const values = await requestResult(store.getAll());
        await Promise.all(values.filter(record => record.owner === owner).map(record => requestResult(store.delete(record.key))));
      });
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
  const generations = new Map();
  const generation = owner => generations.get(owner) || 0;
  const update = async (record, changes, expectedGeneration) => {
    if (generation(record.owner) !== expectedGeneration) return null;
    const next = { ...record, ...changes, updatedAt: now() };
    await store.put(next);
    return next;
  };
  const deliver = async (record, expectedGeneration) => {
    let current = await update(record, {
      status: "sending",
      attempts: Number(record.attempts || 0) + 1,
      lastError: null
    }, expectedGeneration);
    if (!current) throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
    try {
      const result = await send(current.url, replayOptions(current));
      const ack = result?.meta?.operation;
      const committed = {
        id: current.id,
        owner: current.owner,
        operationId: current.operationId,
        resourceKey: current.resourceKey,
        method: current.method,
        url: current.url,
        status: "committed",
        attempts: current.attempts,
        createdAt: current.createdAt,
        updatedAt: now(),
        committedAt: now(),
        ...(ack ? { ack: clone(ack) } : {})
      };
      if (generation(current.owner) === expectedGeneration) await store.put(committed);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      const nextStatus = CONFLICT_STATUSES.has(status) ? "conflict" : retryable(error) ? "pending" : "failed";
      await update(current, {
        status: nextStatus,
        lastError: { status, code: error?.code || "", message: error?.message || "请求失败" }
      }, expectedGeneration);
      throw error;
    }
  };
  const schedule = (record, expectedGeneration = generation(record.owner)) => {
    const key = `${record.owner}:${record.resourceKey}`;
    const previous = tails.get(key) || Promise.resolve();
    const execution = previous.catch(() => {}).then(() => deliver(record, expectedGeneration));
    tails.set(key, execution);
    void execution.finally(() => {
      if (tails.get(key) === execution) tails.delete(key);
    }).catch(() => {});
    return execution;
  };
  return {
    async request({ owner, url, options = {}, resource = "" }) {
      if (!owner) throw new Error("写请求缺少账户标识");
      const expectedGeneration = generation(owner);
      const method = String(options.method || "POST").toUpperCase();
      const headers = lowerCaseHeaders(options.headers);
      const operationId = headers["x-client-operation-id"] || headers["idempotency-key"] || createId();
      headers["x-client-operation-id"] = operationId;
      headers["idempotency-key"] ||= operationId;
      const timestamp = now();
      const record = {
        id: operationId,
        owner,
        operationId,
        resourceKey: resource || resourceKey(url, options),
        method,
        url,
        headers,
        ...(Object.hasOwn(options, "body") ? { body: options.body } : {}),
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await store.put(record);
      if (generation(owner) !== expectedGeneration) {
        await store.clear(owner);
        throw Object.assign(new Error("账户同步队列已清理"), { name: "AbortError" });
      }
      return schedule(record, expectedGeneration);
    },
    async resume(owner) {
      if (!owner) return [];
      const expectedGeneration = generation(owner);
      const records = await store.list(owner, ["pending", "sending"]);
      return Promise.allSettled(records.map(record => schedule({ ...record, status: "pending" }, expectedGeneration)));
    },
    async clear(owner) {
      generations.set(owner, generation(owner) + 1);
      await store.clear(owner);
    }
  };
}
