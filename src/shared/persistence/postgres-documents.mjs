import { canonicalJson } from "./store-mapping.mjs";
import { mapAccountDocument, rebuildAccountDocument, mapAuthDocument, rebuildAuthDocument } from "./document-mapping.mjs";

const DOCUMENT_TABLES = {
  fields: ["document_fields", { accountId: "account_id", document: "document", field: "field", shape: "shape", payload: "payload" }],
  records: ["document_records", {
    accountId: "account_id", document: "document", field: "field", key: "key",
    position: "position", model: "model", scene: "scene", status: "status", payload: "payload"
  }],
  secrets: ["document_secrets", { accountId: "account_id", document: "document", field: "field", payload: "payload" }]
};
const AUTH_TABLES = {
  fields: ["document_fields", { field: "field", payload: "payload" }],
  users: ["users", { id: "id", username: "username", usernameKey: "username_key", passwordHash: "password_hash", position: "position", payload: "payload" }],
  sessions: ["sessions", { tokenHash: "token_hash", userId: "user_id", position: "position", payload: "payload" }]
};

export const documentSqlMapping = mapping => ({
  document: mapping.document,
  ...Object.fromEntries(Object.entries(DOCUMENT_TABLES).map(([key, [, columns]]) => [
    key, mapping[key].map(row => Object.fromEntries(Object.entries(columns).map(([name, column]) => [column, row[name]])))
  ]))
});

async function insertMapping(client, schema, tables, mapping) {
  for (const [key, [table, columns]] of Object.entries(tables)) {
    const rows = mapping[key].map(row => Object.fromEntries(Object.entries(columns).map(([key, column]) => [column, row[key]])));
    if (rows.length) await client.query(
      `INSERT INTO ${schema}.${table} SELECT * FROM jsonb_populate_recordset(NULL::${schema}.${table}, $1::jsonb)`,
      [JSON.stringify(rows)]
    );
  }
}

async function selectMapping(client, schema, tables, where = "", values = []) {
  const result = {};
  for (const [key, [table, columns]] of Object.entries(tables)) {
    const select = Object.entries(columns).map(([key, column]) => `${column} AS "${key}"`).join(", ");
    result[key] = (await client.query(`SELECT ${select} FROM ${schema}.${table} ${where}`, values)).rows;
  }
  return result;
}

const equalRows = (actual, expected) => canonicalJson(actual.map(canonicalJson).sort()) === canonicalJson(expected.map(canonicalJson).sort());
function verifyMapping(actual, expected, keys) {
  for (const key of keys) if (!equalRows(actual[key], expected[key])) throw new Error(`Document content mismatch: ${key}`);
}

// All operations below use the caller's transaction and account context.
export async function writeAccountDocument(client, accountId, document, value) {
  const mapping = mapAccountDocument(accountId, document, value);
  await client.query("DELETE FROM for_now.account_documents WHERE account_id = $1 AND document = $2", [accountId, document]);
  await client.query("INSERT INTO for_now.account_documents(account_id, document) VALUES ($1, $2)", [accountId, document]);
  await insertMapping(client, "for_now", DOCUMENT_TABLES, mapping);
}

export async function readAccountDocument(client, accountId, document, fallback = null) {
  const exists = (await client.query("SELECT 1 FROM for_now.account_documents WHERE account_id = $1 AND document = $2", [accountId, document])).rowCount;
  if (!exists) return structuredClone(fallback);
  const actual = await selectMapping(client, "for_now", DOCUMENT_TABLES, "WHERE account_id = $1 AND document = $2", [accountId, document]);
  const value = rebuildAccountDocument(actual);
  verifyMapping(actual, mapAccountDocument(accountId, document, value), Object.keys(DOCUMENT_TABLES));
  return value;
}

export async function verifyAccountDocument(client, mapping) {
  const actual = await selectMapping(client, "for_now", DOCUMENT_TABLES, "WHERE account_id = $1 AND document = $2", [mapping.accountId, mapping.document]);
  verifyMapping(actual, mapping, Object.keys(DOCUMENT_TABLES));
  const present = (await client.query("SELECT 1 FROM for_now.account_documents WHERE account_id = $1 AND document = $2", [mapping.accountId, mapping.document])).rowCount;
  if (!present) throw new Error("Missing account document");
}

export async function writeAuthDocument(client, value) {
  const mapping = mapAuthDocument(value);
  for (const table of ["sessions", "users", "document_fields"]) await client.query(`DELETE FROM for_now_auth.${table}`);
  await insertMapping(client, "for_now_auth", AUTH_TABLES, mapping);
}

export async function readAuthDocument(client) {
  const mapping = await selectMapping(client, "for_now_auth", AUTH_TABLES);
  if (!mapping.fields.length && !mapping.users.length && !mapping.sessions.length) return null;
  const value = rebuildAuthDocument(mapping);
  verifyMapping(mapping, mapAuthDocument(value), Object.keys(AUTH_TABLES));
  return value;
}

export async function verifyAuthDocument(client, mapping) {
  verifyMapping(await selectMapping(client, "for_now_auth", AUTH_TABLES), mapping, Object.keys(AUTH_TABLES));
}

export async function writeAttachmentInventory(client, accountId, inventory) {
  await client.query("DELETE FROM for_now.attachment_inventory WHERE account_id = $1", [accountId]);
  if (inventory.length) await client.query(`
    INSERT INTO for_now.attachment_inventory
    SELECT * FROM jsonb_populate_recordset(NULL::for_now.attachment_inventory, $1::jsonb)
  `, [JSON.stringify(inventory.map(row => ({
    account_id: accountId, path: row.path, storage: row.storage, object_key: row.objectKey,
    bytes: row.bytes, sha256: row.sha256, state: row.state
  })))]);
}

export async function readAttachmentInventory(client, accountId) {
  return (await client.query(`
    SELECT path, storage, object_key AS "objectKey", bytes::float8 AS bytes, sha256, state
    FROM for_now.attachment_inventory WHERE account_id = $1 ORDER BY path
  `, [accountId])).rows;
}

export async function verifyAttachmentInventory(client, accountId, inventory) {
  if (!equalRows(await readAttachmentInventory(client, accountId), inventory)) throw new Error("Attachment inventory mismatch");
}
