import { AsyncLocalStorage } from "node:async_hooks";
import { changedResources, createLogger } from "./logging.mjs";

export { appendPrivateJsonLine, changedResources, createLogger, errorMetadata, pruneLogs, redact } from "./logging.mjs";

export function createObservability({ rootDir, version }) {
  const storage = new AsyncLocalStorage();
  const context = Object.freeze({
    getStore: () => storage.getStore(),
    run: (value, callback) => storage.run(value, callback)
  });
  const logEvent = createLogger({ rootDir, version, getContext: context.getStore });
  async function auditChanges(before, after) {
    const current = context.getStore();
    if (!current?.traceId) return;
    const changes = changedResources(before, after);
    if (!changes.length) return;
    current.changeCount = (current.changeCount || 0) + changes.length;
    await logEvent("operation", "data.changed", { result: "committed", changes });
  }
  return { context, logEvent, auditChanges };
}
