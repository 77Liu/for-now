import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const queues = new Map();
const secretField = /password|api.?key|authorization|cookie|tokenHash|invitation|access.?key|security.?token|^(?:token|accessToken|refreshToken|sessionToken)$/i;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

export function redact(value, secrets = []) {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(String(secret)).join("[REDACTED]");
    return text
      .replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/g, "[IMAGE OMITTED]")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(/((?:api[_-]?key|password|cookie|authorization|invitation|access[_-]?key|security[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi, "$1[REDACTED]")
      .replace(/https?:\/\/[^\s"'<>]+/g, url => {
        try {
          const parsed = new URL(url);
          if (parsed.username || parsed.password || /signature|token|key|credential/i.test(parsed.search)) {
            return `${parsed.origin}${parsed.pathname}?[REDACTED]`;
          }
        } catch {}
        return url;
      });
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, secretField.test(key) ? "[REDACTED]" : redact(item, secrets)
  ]));
  return value;
}

// Error messages and attached payloads can contain model output or credentials.
// System logs retain only machine codes and stack locations.
export function errorMetadata(error) {
  const code = String(error?.code || error?.cause?.code || "");
  const stack = String(error?.stack || "").split("\n").flatMap(line => {
    const match = /(?:^|\()(?:(?:file:\/\/)?[^():\s]+\/)?([A-Za-z0-9_.-]+\.(?:mjs|cjs|js|json)):(\d+):(\d+)\)?$/.exec(line.trim());
    return match ? [`at ${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 12);
  return {
    name: /^[A-Za-z]+Error$/.test(error?.name || "") ? error.name : "Error",
    code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : "UNCLASSIFIED",
    stack
  };
}

export function appendPrivateJsonLine(file, value) {
  const operation = (queues.get(file) || Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    await fs.appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(file, 0o600);
  });
  const settled = operation.catch(() => {});
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return operation;
}

export function createLogger({ rootDir, getContext }) {
  return async function logEvent(type, event, fields = {}) {
    const context = getContext() || {}, timestamp = new Date().toISOString();
    const entry = {
      schemaVersion: 1, id: crypto.randomUUID(), timestamp, type, event, module: event.split(".")[0],
      version: process.env.APP_VERSION || "development",
      traceId: context.traceId || "", userId: context.user?.id || null,
      method: context.method || "", route: context.route || "",
      ...fields
    };
    const safe = redact(entry, context.secrets || []);
    const dir = type === "system" ? rootDir : context.dataDir || rootDir;
    try {
      await appendPrivateJsonLine(path.join(dir, "logs", `${type}-${timestamp.slice(0, 10)}.ndjson`), safe);
    } catch (error) {
      // Report logging failure without throwing over an already committed write.
      console.error(JSON.stringify({ timestamp, type: "system", event: "logging.failed", traceId: context.traceId || "", target: type, error: errorMetadata(error) }));
      return false;
    }
    if (type === "system" && fields.level === "error") console.error(JSON.stringify(safe));
    return true;
  };
}

export async function pruneLogs(logsDir, retentionDays) {
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(logsDir, 0o700);
  // Keep the whole boundary UTC day, including requests that cross midnight.
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
  for (const name of await fs.readdir(logsDir)) {
    const match = /^(?:ai-audit|system|operation)-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (!match) continue;
    const file = path.join(logsDir, name);
    await fs.chmod(file, 0o600);
    if (match[1] < cutoff) await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export function changedResources(before, after) {
  const changes = [];
  for (const collection of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (["version", "sessions", "apiKey"].includes(collection)) continue;
    const a = before[collection], b = after[collection];
    const records = Array.isArray(a) || Array.isArray(b);
    const left = new Map(records ? (a || []).map(item => [item.id, item]) : [[collection, a]]);
    const right = new Map(records ? (b || []).map(item => [item.id, item]) : [[collection, b]]);
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      const old = left.get(id), next = right.get(id);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      const fields = [...new Set([...Object.keys(old || {}), ...Object.keys(next || {})])]
        .filter(key => JSON.stringify(old?.[key]) !== JSON.stringify(next?.[key]));
      changes.push({
        resourceType: collection, resourceId: String(id || ""),
        action: old == null ? "create" : next == null ? "delete" : "update",
        fields,
        // Never hash credentials: even hashed secrets do not belong in audit logs.
        beforeHash: digest(redact(old)), afterHash: digest(redact(next))
      });
    }
  }
  if (before.apiKey !== after.apiKey) changes.push({ resourceType: "settings", resourceId: "apiKey", action: "update", fields: ["apiKey"], configured: Boolean(after.apiKey) });
  return changes;
}
