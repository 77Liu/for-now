import { canonicalJson, storeContentSha256 } from "./store-mapping.mjs";

export const ACCOUNT_DOCUMENT_FILES = {
  settings: "llm-settings.json", usage: "ai-usage.json", costPlan: "ai-cost-plan.json"
};
const GROUPS = {
  settings: { profiles: "object", scenarios: "object", responseStyles: "object" },
  usage: { entries: "array" },
  costPlan: { scenarios: "array" }
};
/** 保留旧认证文档字段存在性，导出时移除。 @since unreleased */
export const AUTH_DOCUMENT_FIELDS_MARKER = "__forNowAuthDocumentFieldsV1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const define = (target, key, value) => Object.defineProperty(target, key, {
  value, enumerable: true, writable: true, configurable: true
});
const validDocument = value => {
  if (!object(value)) throw new Error("Expected a JSON document");
  if (canonicalJson(value) !== canonicalJson(JSON.parse(JSON.stringify(value)))) throw new Error("Lossy document value");
};

// Each profile, scene and invocation is a row. Token/cost/price snapshots stay
// with their invocation; extensions retain their exact original JSON values.
export function mapAccountDocument(accountId, document, source) {
  if (!Object.hasOwn(GROUPS, document)) throw new Error("Unknown account document");
  validDocument(source);
  const fields = [], records = [], secrets = [];
  for (const [field, value] of Object.entries(source)) {
    const base = { accountId, document, field };
    if (document === "settings" && field === "apiKey") {
      fields.push({ ...base, shape: "secret", payload: null });
      secrets.push({ ...base, payload: structuredClone(value) });
      continue;
    }
    const shape = Object.hasOwn(GROUPS[document], field) ? GROUPS[document][field] : "value";
    if (shape === "value") {
      fields.push({ ...base, shape, payload: structuredClone(value) });
      continue;
    }
    if (shape === "array" ? !Array.isArray(value) : !object(value)) throw new Error(`Invalid ${document}.${field}`);
    fields.push({ ...base, shape, payload: null });
    const entries = shape === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    const keys = new Set();
    entries.forEach(([name, item], position) => {
      const key = shape === "object" ? name : document === "usage" ? item?.id : item?.scene;
      if (typeof key !== "string" || !key || keys.has(key)) throw new Error(`Invalid or duplicate identity in ${document}.${field}`);
      if (shape === "array" && !object(item)) throw new Error(`Invalid row in ${document}.${field}`);
      keys.add(key);
      records.push({
        ...base, key, position,
        model: typeof item?.model === "string" ? item.model : "",
        scene: typeof item?.scene === "string" ? item.scene : (document === "settings" && field !== "profiles" ? key : ""),
        status: typeof item?.status === "string" ? item.status : "",
        payload: structuredClone(item)
      });
    });
  }
  const mapping = { accountId, document, fields, records, secrets };
  if (storeContentSha256(rebuildAccountDocument(mapping)) !== storeContentSha256(source)) throw new Error("Document round-trip mismatch");
  return mapping;
}

export function rebuildAccountDocument({ fields, records, secrets }) {
  const result = {}, used = new Set(), usedSecrets = new Set();
  for (const row of fields) {
    if (Object.hasOwn(result, row.field)) throw new Error("Duplicate document field");
    const children = records.filter(item => item.field === row.field).sort((a, b) => a.position - b.position);
    let value;
    if (row.shape === "value") value = structuredClone(row.payload);
    else if (row.shape === "secret") {
      const matches = secrets.filter(item => item.field === row.field);
      if (matches.length !== 1) throw new Error("Missing or duplicate document secret");
      usedSecrets.add(matches[0]);
      value = structuredClone(matches[0].payload);
    } else if (["array", "object"].includes(row.shape)) {
      value = row.shape === "array" ? [] : {};
      const keys = new Set();
      children.forEach((child, index) => {
        if (child.position !== index || keys.has(child.key)) throw new Error("Invalid document row ordering");
        keys.add(child.key);
        used.add(child);
        if (Array.isArray(value)) value.push(structuredClone(child.payload));
        else define(value, child.key, structuredClone(child.payload));
      });
    } else throw new Error("Invalid document shape");
    define(result, row.field, value);
  }
  if (used.size !== records.length || usedSecrets.size !== secrets.length) throw new Error("Orphan document records");
  return result;
}

export function mapAuthDocument(source) {
  validDocument(source);
  if (!Array.isArray(source.users) || !Array.isArray(source.sessions)) throw new Error("Invalid auth collections");
  const userIds = new Set(), usernames = new Set(), tokens = new Set();
  const users = source.users.map((item, position) => {
    const { id, username, passwordHash, ...payload } = item;
    if (typeof id !== "string" || !/^[\w-]+$/.test(id) || userIds.has(id)) throw new Error("Invalid or duplicate account identity");
    const usernameKey = typeof username === "string"
      ? username.toLocaleLowerCase()
      : "";
    if (!usernameKey || usernames.has(usernameKey)) throw new Error("Invalid or duplicate username");
    if (typeof passwordHash !== "string" || !passwordHash) throw new Error("Missing password hash");
    userIds.add(id);
    usernames.add(usernameKey);
    return {
      id,
      username,
      usernameKey,
      passwordHash,
      role: ["user", "owner"].includes(item.role)
        ? item.role
        : position === 0 ? "owner" : "user",
      sessionVersion: Number.isSafeInteger(item.sessionVersion) && item.sessionVersion > 0
        ? item.sessionVersion : 1,
      recordTimezone: String(item.recordTimezone || "Asia/Shanghai"),
      createdAt: item.createdAt || "1970-01-01T00:00:00.000Z",
      updatedAt: item.updatedAt || null,
      position,
      payload,
      promoted: {
        role: Object.hasOwn(item, "role"),
        sessionVersion: Object.hasOwn(item, "sessionVersion"),
        recordTimezone: Object.hasOwn(item, "recordTimezone"),
        createdAt: Object.hasOwn(item, "createdAt"),
        updatedAt: Object.hasOwn(item, "updatedAt")
      }
    };
  });
  const usersById = new Map(users.map(user => [user.id, user]));
  const sessions = source.sessions.map((item, position) => {
    const { tokenHash, userId, ...payload } = item;
    if (typeof tokenHash !== "string" || !tokenHash || tokens.has(tokenHash)) throw new Error("Invalid or duplicate session digest");
    if (!userIds.has(userId)) throw new Error("Session references missing account");
    tokens.add(tokenHash);
    return {
      tokenHash,
      userId,
      sessionVersion: Number.isSafeInteger(item.sessionVersion) && item.sessionVersion > 0
        ? item.sessionVersion : usersById.get(userId).sessionVersion,
      createdAt: item.createdAt || "1970-01-01T00:00:00.000Z",
      expiresAt: item.expiresAt,
      position,
      payload,
      promoted: {
        sessionVersion: Object.hasOwn(item, "sessionVersion"),
        createdAt: Object.hasOwn(item, "createdAt"),
        expiresAt: Object.hasOwn(item, "expiresAt")
      }
    };
  });
  const fields = Object.entries(source).filter(([field]) => !["users", "sessions"].includes(field))
    .map(([field, payload]) => ({ field, payload: structuredClone(payload) }));
  return { fields, users, sessions };
}

export function rebuildAuthDocument({ fields, users, sessions }) {
  const result = {};
  for (const { field, payload } of fields) {
    if (Object.hasOwn(result, field) || ["users", "sessions"].includes(field)) throw new Error("Duplicate auth field");
    define(result, field, structuredClone(payload));
  }
  const ordered = (rows, stableKey) => rows.toSorted((a, b) => {
    if (Number.isInteger(a.position) && Number.isInteger(b.position)) {
      return a.position - b.position;
    }
    return stableKey(a).localeCompare(stableKey(b));
  }).map((row, index, sorted) => {
    if (sorted.every(item => Number.isInteger(item.position))
      && row.position !== index) throw new Error("Invalid auth ordering");
    return row;
  });
  const projectedPayload = (payload, promoted) => {
    const value = structuredClone(payload);
    const fields = promoted || value[AUTH_DOCUMENT_FIELDS_MARKER] || {};
    delete value[AUTH_DOCUMENT_FIELDS_MARKER];
    return { value, fields };
  };
  const iso = value => value instanceof Date ? value.toISOString() : value;
  result.users = ordered(users, row => `${row.createdAt || ""}\u0000${row.id}`)
    .map(({ id, username, passwordHash, role, sessionVersion, recordTimezone, createdAt, updatedAt, payload, promoted }) => {
      const projected = projectedPayload(payload, promoted);
      return {
        ...projected.value,
        id,
        username,
        passwordHash,
        ...((projected.fields.role ?? true) ? { role } : {}),
        ...((projected.fields.sessionVersion ?? true) ? { sessionVersion } : {}),
        ...((projected.fields.recordTimezone ?? true) ? { recordTimezone } : {}),
        ...((projected.fields.createdAt ?? true) ? { createdAt: iso(createdAt) } : {}),
        ...((projected.fields.updatedAt ?? true) && updatedAt ? { updatedAt: iso(updatedAt) } : {})
      };
    });
  result.sessions = ordered(
    sessions,
    row => `${row.createdAt || ""}\u0000${row.tokenHash}`
  ).map(({ tokenHash, userId, sessionVersion, createdAt, expiresAt, payload, promoted }) => {
    const projected = projectedPayload(payload, promoted);
    return {
      ...projected.value,
      tokenHash,
      userId,
      ...((projected.fields.sessionVersion ?? true) ? { sessionVersion } : {}),
      ...((projected.fields.createdAt ?? true) ? { createdAt: iso(createdAt) } : {}),
      ...((projected.fields.expiresAt ?? true) ? { expiresAt: iso(expiresAt) } : {})
    };
  });
  return result;
}
