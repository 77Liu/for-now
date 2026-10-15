import { canonicalJson, rebuildStoreObjects, storeContentSha256 } from "./store-mapping.mjs";

// Identifiers are fixed here, never taken from imported JSON or CLI arguments.
const TABLES = {
  fields: ["store_fields", { accountId: "account_id", field: "field", shape: "shape", payload: "payload" }],
  objects: ["store_objects", {
    accountId: "account_id", objectKey: "object_key", collection: "collection", kind: "kind", id: "id",
    parentKey: "parent_key", field: "field", position: "position", childFields: "child_fields",
    content: "content", status: "status", authorType: "author_type", version: "version",
    lifecycle: "lifecycle", tombstone: "tombstone", deletedAt: "deleted_at", payload: "payload"
  }],
  relations: ["store_relations", {
    accountId: "account_id", objectKey: "object_key", relation: "relation", targetKey: "target_key",
    targetCollection: "target_collection", targetId: "target_id", resolution: "resolution"
  }],
  attachmentRefs: ["store_attachment_refs", {
    accountId: "account_id", ownerKey: "owner_key", fieldName: "field_name", valuePath: "value_path", path: "path"
  }],
  lifecycles: ["resource_lifecycle", {
    accountId: "account_id", position: "position", resourceKey: "resource_key", resourceType: "resource_type", resourceId: "resource_id",
    lifecycle: "lifecycle", state: "state", tombstone: "tombstone", createdAt: "created_at",
    updatedAt: "updated_at", deletedAt: "deleted_at", restoredAt: "restored_at",
    purgedAt: "purged_at", trashId: "trash_id", history: "history", payload: "payload"
  }],
  idempotency: ["idempotency_ledger", {
    accountId: "account_id", position: "position", scope: "scope", key: "idempotency_key",
    requestHash: "request_hash", response: "response", createdAt: "created_at", expiresAt: "expires_at",
    payload: "payload"
  }]
};
const sqlRows = (rows, columns) => rows.map(row => Object.fromEntries(Object.entries(columns).map(([key, column]) => [column, row[key]])));
const sorted = rows => rows.map(canonicalJson).sort();

export const storeSqlMapping = mapping => Object.fromEntries(
  Object.entries(TABLES).map(([key, [, columns]]) => [key, sqlRows(mapping[key], columns)])
);

export async function writeStoreObjects(client, mapping) {
  for (const [key, [table, columns]] of Object.entries(TABLES)) {
    if (!mapping[key].length) continue;
    await client.query(
      `INSERT INTO for_now.${table} SELECT * FROM jsonb_populate_recordset(NULL::for_now.${table}, $1::jsonb)`,
      [JSON.stringify(sqlRows(mapping[key], columns))]
    );
  }
}

// Caller owns a transaction and has set app.account_id locally.
export async function readPostgresStoreObjects(client, accountId) {
  const mapping = {};
  for (const [key, [table, columns]] of Object.entries(TABLES)) {
    const select = Object.entries(columns).map(([key, column]) => `${column} AS "${key}"`).join(", ");
    mapping[key] = (await client.query(`SELECT ${select} FROM for_now.${table} WHERE account_id = $1`, [accountId])).rows;
  }
  if (!mapping.fields.length) throw Object.assign(new Error("账户存储映射缺失"), {
    statusCode: 503, code: "ACCOUNT_DATA_INVALID", recoveryScope: "account", accountId, reasonCode: "ACCOUNT_STORE_MAPPING_MISSING"
  });
  return mapping;
}

export async function verifyStoreObjects(client, plan) {
  const actual = await readPostgresStoreObjects(client, plan.accountId);
  for (const key of Object.keys(TABLES)) {
    if (canonicalJson(sorted(actual[key])) !== canonicalJson(sorted(plan.business[key]))) {
      throw new Error(`Migration content mismatch: ${key}`);
    }
  }
  const rebuilt = rebuildStoreObjects(actual);
  if (storeContentSha256(rebuilt) !== plan.contentSha256) {
    const field = Object.keys(plan.snapshot).find(key => canonicalJson(rebuilt[key]) !== canonicalJson(plan.snapshot[key]));
    const metadataField = field === "_persistence"
      ? Object.keys(plan.snapshot._persistence).find(key => canonicalJson(rebuilt._persistence[key]) !== canonicalJson(plan.snapshot._persistence[key]))
      : "";
    throw new Error(`Migration round-trip hash mismatch${field ? `: ${field}${metadataField ? `.${metadataField}` : ""}` : ""}`);
  }
  return rebuilt;
}

export async function clearStoreObjects(client, accountId) {
  for (const table of [
    "store_attachment_refs", "store_relations", "store_objects",
    "resource_lifecycle", "idempotency_ledger", "store_fields"
  ]) {
    await client.query(`DELETE FROM for_now.${table} WHERE account_id = $1`, [accountId]);
  }
}
