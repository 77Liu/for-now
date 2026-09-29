import { canonicalJson, storeContentSha256 } from "./store-mapping.mjs";

export const ACCOUNT_DOCUMENT_FILES = {
  settings: "llm-settings.json", usage: "ai-usage.json", costPlan: "ai-cost-plan.json"
};
const GROUPS = {
  settings: { profiles: "object", scenarios: "object", responseStyles: "object" },
  usage: { entries: "array" },
  costPlan: { scenarios: "array" }
};
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
    if (typeof username !== "string" || !username || usernames.has(username.toLocaleLowerCase())) throw new Error("Invalid or duplicate username");
    if (typeof passwordHash !== "string" || !passwordHash) throw new Error("Missing password hash");
    userIds.add(id);
    usernames.add(username.toLocaleLowerCase());
    return { id, username, usernameKey: username.toLocaleLowerCase(), passwordHash, position, payload };
  });
  const sessions = source.sessions.map((item, position) => {
    const { tokenHash, userId, ...payload } = item;
    if (typeof tokenHash !== "string" || !tokenHash || tokens.has(tokenHash)) throw new Error("Invalid or duplicate session digest");
    if (!userIds.has(userId)) throw new Error("Session references missing account");
    tokens.add(tokenHash);
    return { tokenHash, userId, position, payload };
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
  const ordered = rows => rows.toSorted((a, b) => a.position - b.position).map((row, index) => {
    if (row.position !== index) throw new Error("Invalid auth ordering");
    return row;
  });
  result.users = ordered(users).map(({ id, username, passwordHash, payload }) => ({ ...structuredClone(payload), id, username, passwordHash }));
  result.sessions = ordered(sessions).map(({ tokenHash, userId, payload }) => ({ ...structuredClone(payload), tokenHash, userId }));
  return result;
}
