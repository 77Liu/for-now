import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const AI_BUDGET_DOCUMENT_FILE = "ai-budget.json";

const queues = new Map();
const clone = value => structuredClone(value);
const storageError = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

async function lockOwner(lockDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function reclaimAbandonedLock(lockDirectory, staleMs) {
  let stat;
  try {
    stat = await fs.stat(lockDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const owner = await lockOwner(lockDirectory);
  if (owner?.hostname === os.hostname() && processIsAlive(owner.pid)) return false;
  if (owner?.hostname !== os.hostname() && Date.now() - stat.mtimeMs < staleMs) return false;
  const abandoned = `${lockDirectory}.abandoned-${randomUUID()}`;
  try {
    await fs.rename(lockDirectory, abandoned);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  await fs.rm(abandoned, { recursive: true, force: true });
  return true;
}

async function acquireFileLock(lockDirectory, { timeoutMs, staleMs, retryMs }) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString()
        })}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockDirectory, now, now).catch(() => {});
      }, Math.max(50, Math.floor(staleMs / 3)));
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        const owner = await lockOwner(lockDirectory);
        if (owner?.token !== token) {
          throw storageError("STORAGE_LOCK_LOST", "AI 预算写入锁已失效，拒绝继续保存");
        }
        await fs.rm(lockDirectory, { recursive: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (error.code?.startsWith("STORAGE_")) throw error;
        throw storageError("STORAGE_LOCK_FAILED", "AI 预算写入锁无法取得，请联系管理员", error);
      }
      if (await reclaimAbandonedLock(lockDirectory, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw storageError("STORAGE_LOCK_TIMEOUT", "AI 预算正在由其他进程更新，请稍后重试");
      }
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function readJsonDocument(file, fallback) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid AI budget document");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return clone(fallback);
    throw storageError(
      "STORAGE_READ_FAILED",
      "AI 预算数据无法读取，已保留原文件，请联系管理员",
      error
    );
  }
}

async function writeJsonDocument(file, value) {
  const directory = path.dirname(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } catch (error) {
    throw storageError("STORAGE_WRITE_FAILED", "AI 预算数据保存失败，请稍后重试", error);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function createJsonAiBudgetRepository(dataRoot, lockOptions = {}) {
  if (typeof dataRoot !== "string" || !dataRoot.trim()) {
    throw new TypeError("JSON AI budget repository requires dataRoot");
  }
  const file = path.join(path.resolve(dataRoot), AI_BUDGET_DOCUMENT_FILE);
  const lockDirectory = `${file}.lock`;
  const emptyDocument = {};
  const lock = {
    timeoutMs: positiveInteger(lockOptions.timeoutMs, 15_000, "AI budget lock timeout"),
    staleMs: positiveInteger(lockOptions.staleMs, 10_000, "AI budget stale lock threshold"),
    retryMs: positiveInteger(lockOptions.retryMs, 25, "AI budget lock retry interval")
  };

  const exclusive = operation => {
    const previous = queues.get(file) || Promise.resolve();
    const current = previous.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const release = await acquireFileLock(lockDirectory, lock);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    const settled = current.catch(() => {});
    queues.set(file, settled);
    void settled.then(() => {
      if (queues.get(file) === settled) queues.delete(file);
    });
    return current;
  };

  return {
    async read() {
      await (queues.get(file) || Promise.resolve());
      return clone(await readJsonDocument(file, emptyDocument));
    },
    update(mutator) {
      if (typeof mutator !== "function") throw new TypeError("AI budget update requires a mutator");
      return exclusive(async () => {
        const document = clone(await readJsonDocument(file, emptyDocument));
        const result = await mutator(document);
        await writeJsonDocument(file, document);
        return result;
      });
    }
  };
}

export function createAiBudgetRepository({
  runtime = null,
  dataRoot = "",
  lockTimeoutMs,
  lockStaleMs,
  lockRetryMs
} = {}) {
  if (runtime) {
    if (!runtime.aiBudget
      || typeof runtime.aiBudget.read !== "function"
      || typeof runtime.aiBudget.update !== "function") {
      throw new TypeError("PostgreSQL runtime does not provide an AI budget repository");
    }
    return runtime.aiBudget;
  }
  return createJsonAiBudgetRepository(dataRoot, {
    timeoutMs: lockTimeoutMs,
    staleMs: lockStaleMs,
    retryMs: lockRetryMs
  });
}
