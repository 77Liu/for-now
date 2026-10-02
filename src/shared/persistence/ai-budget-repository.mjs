import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const AI_BUDGET_DOCUMENT_FILE = "ai-budget.json";

const queues = new Map();
const clone = value => structuredClone(value);
const storageError = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

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

function createJsonAiBudgetRepository(dataRoot) {
  if (typeof dataRoot !== "string" || !dataRoot.trim()) {
    throw new TypeError("JSON AI budget repository requires dataRoot");
  }
  const file = path.join(path.resolve(dataRoot), AI_BUDGET_DOCUMENT_FILE);
  const emptyDocument = {};

  const exclusive = operation => {
    const previous = queues.get(file) || Promise.resolve();
    const current = previous.then(operation);
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

export function createAiBudgetRepository({ runtime = null, dataRoot = "" } = {}) {
  if (runtime) {
    if (!runtime.aiBudget
      || typeof runtime.aiBudget.read !== "function"
      || typeof runtime.aiBudget.update !== "function") {
      throw new TypeError("PostgreSQL runtime does not provide an AI budget repository");
    }
    return runtime.aiBudget;
  }
  return createJsonAiBudgetRepository(dataRoot);
}
