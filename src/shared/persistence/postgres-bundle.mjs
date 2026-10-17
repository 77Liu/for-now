import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AI_BUDGET_DOCUMENT_FILE } from "./ai-budget-repository.mjs";
import { canonicalJson, storeContentSha256 } from "./store-mapping.mjs";
import { buildPostgresMigrationPlan, applyPostgresMigration } from "./postgres-migration.mjs";
import { ACCOUNT_DOCUMENT_FILES, mapAccountDocument, mapAuthDocument } from "./document-mapping.mjs";
import {
  readAccountDocument, writeAccountDocument, verifyAccountDocument, readAuthDocument,
  writeAuthDocument, verifyAuthDocument, writeAttachmentInventory, verifyAttachmentInventory,
  readAttachmentInventory
} from "./postgres-documents.mjs";
import { readPostgresStoreObjects } from "./postgres-objects.mjs";
import { rebuildStoreObjects } from "./store-mapping.mjs";

export const RECORD_COMPRESSION_QUOTA_FILE = "record-compression-quota.json";
export const AI_AUDIT_EXPORT_FILE = "ai-audit-attempts.json";
export const AI_USAGE_ATTEMPTS_EXPORT_FILE = "ai-usage-attempts.json";
export const EMPTY_RECORD_COMPRESSION_QUOTA = Object.freeze({ days: [] });

export function validateRecordCompressionQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.days)) {
    throw new Error("Invalid record compression quota bundle");
  }
  for (const day of value.days) {
    if (!day || typeof day !== "object" || Array.isArray(day)
      || !/^\d{4}-\d{2}-\d{2}$/.test(day.key)
      || !Number.isSafeInteger(day.calls) || day.calls < 0
      || !Number.isSafeInteger(day.costMicros) || day.costMicros < 0
      || !Array.isArray(day.reservations)) {
      throw new Error("Invalid record compression quota bundle");
    }
    for (const reservation of day.reservations) {
      if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)
        || !["reservationId", "accountId", "taskId"].every(key => typeof reservation[key] === "string")
        || !Number.isSafeInteger(reservation.calls) || reservation.calls < 0
        || !Number.isSafeInteger(reservation.costMicros) || reservation.costMicros < 0) {
        throw new Error("Invalid record compression quota bundle");
      }
    }
  }
  return value;
}

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const defaultInspect = async ({ name, localFile }) => {
  const stat = await fs.lstat(localFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment must be a regular file");
  const data = await fs.readFile(localFile);
  return { storage: "local", objectKey: name, bytes: data.length, sha256: digest(data), state: "verified" };
};

function createBundleReader(sources) {
  return async (file, optional = false, { array = false } = {}) => {
    let text;
    try { text = await fs.readFile(file, "utf8"); } catch (error) {
      if (optional && error.code === "ENOENT") {
        sources.push({ file, sha256: null });
        return null;
      }
      throw error;
    }
    sources.push({ file, sha256: digest(text) });
    try {
      const value = JSON.parse(text);
      if (array ? !Array.isArray(value) : (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error();
      }
      return value;
    } catch { throw new Error(`Invalid migration document: ${path.basename(file)}`); }
  };
}

function validateAiAttemptRows(rows, accountId) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || row.account_id !== accountId || typeof row.call_id !== "string" || !row.call_id
      || ids.has(row.call_id)) {
      throw new Error(`Invalid AI attempt export for account ${accountId}`);
    }
    ids.add(row.call_id);
  }
}

async function discoverAiAttemptSources(directory, accountId, read) {
  const auditValue = await read(path.join(directory, AI_AUDIT_EXPORT_FILE), true, { array: true });
  const usageValue = await read(path.join(directory, AI_USAGE_ATTEMPTS_EXPORT_FILE), true, { array: true });
  if ((auditValue === null) !== (usageValue === null)) {
    throw new Error(`AI audit and usage exports must be provided together for account ${accountId}`);
  }
  const auditAttempts = auditValue || [];
  const usageAttempts = usageValue || [];
  validateAiAttemptRows(auditAttempts, accountId);
  validateAiAttemptRows(usageAttempts, accountId);
  return {
    auditAttempts,
    usageAttempts,
    auditAttemptsPresent: auditValue !== null,
    usageAttemptsPresent: usageValue !== null
  };
}

async function discoverAttachmentInventory(directory, accountId, references, inspectAttachment) {
  const attachmentDir = path.join(directory, "attachments");
  try {
    for (const entry of await fs.readdir(attachmentDir, { withFileTypes: true })) {
      if (!/^[\w.-]+$/.test(entry.name) || !entry.isFile()) throw new Error("Unsafe attachment inventory entry");
      const resourcePath = `/attachments/${entry.name}`;
      if (!references.has(resourcePath)) references.set(resourcePath, []);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const inventory = [];
  for (const [resourcePath, refs] of [...references.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = resourcePath.slice("/attachments/".length);
    try {
      inventory.push({ path: resourcePath, ...await inspectAttachment({
        ownerId: accountId,
        name,
        localFile: path.join(attachmentDir, name)
      }) });
    } catch (error) {
      if (["ENOENT", "NoSuchKey"].includes(error.code) || Number(error.status) === 404) {
        if (refs.length && refs.every(ref => ref.fieldName === "attachmentCleanup")) {
          inventory.push({
            path: resourcePath,
            storage: "unknown",
            objectKey: name,
            bytes: null,
            sha256: null,
            state: "missing_cleanup"
          });
        } else throw new Error(`Missing referenced attachment for account ${accountId}: ${name}`);
      } else throw error;
    }
  }
  return inventory;
}

async function discoverBundleAccount({ dataDir, user, accountMode, read, inspectAttachment }) {
  const directory = accountMode ? path.join(dataDir, "users", user.id) : dataDir;
  const storePath = path.join(directory, "store.json");
  const store = await read(storePath);
  const plan = buildPostgresMigrationPlan({
    accountId: user.id,
    accountCreatedAt: user.createdAt,
    store,
    sourcePath: storePath
  });
  const documents = {};
  for (const [document, filename] of Object.entries(ACCOUNT_DOCUMENT_FILES)) {
    const value = await read(path.join(directory, filename), true);
    if (value !== null) {
      mapAccountDocument(user.id, document, value);
      documents[document] = value;
    }
  }
  const attempts = await discoverAiAttemptSources(directory, user.id, read);
  const references = new Map();
  for (const reference of plan.business.attachmentRefs) {
    if (!references.has(reference.path)) references.set(reference.path, []);
    references.get(reference.path).push(reference);
  }
  const inventory = await discoverAttachmentInventory(
    directory,
    user.id,
    references,
    inspectAttachment
  );
  return { plan, documents, inventory, ...attempts };
}

export async function discoverJsonBundle(dataDir, { inspectAttachment = defaultInspect } = {}) {
  const sources = [];
  const read = createBundleReader(sources);
  const auth = await read(path.join(dataDir, "auth.json"), true);
  if (auth) mapAuthDocument(auth);
  const aiBudget = await read(path.join(dataDir, AI_BUDGET_DOCUMENT_FILE), true) || {};
  const quotaFile = path.join(dataDir, RECORD_COMPRESSION_QUOTA_FILE);
  const quotaValue = await read(quotaFile, true);
  const recordCompressionQuota = validateRecordCompressionQuota(quotaValue ?? EMPTY_RECORD_COMPRESSION_QUOTA);
  const owners = auth?.users.length ? auth.users : [{ id: "local", createdAt: "" }];
  const accounts = [];
  for (const user of owners) accounts.push(await discoverBundleAccount({
    dataDir,
    user,
    accountMode: Boolean(auth?.users.length),
    read,
    inspectAttachment
  }));
  const recordCompressionQuotaPresent = quotaValue !== null;
  const contentSha256 = bundleContentHash({ aiBudget, recordCompressionQuota, recordCompressionQuotaPresent, auth, accounts });
  // Relative filenames make copied snapshots reproducible.
  const sourceSha256 = storeContentSha256({
    sources: sources.map(({ file, sha256 }) => ({ file: path.relative(dataDir, file), sha256 })),
    contentSha256
  });
  return { aiBudget, recordCompressionQuota, recordCompressionQuotaPresent, auth, accounts, sources, sourceSha256, contentSha256 };
}

const bundleContentHash = ({ aiBudget, recordCompressionQuota, recordCompressionQuotaPresent, auth, accounts }) => storeContentSha256({
  aiBudget,
  recordCompressionQuota,
  recordCompressionQuotaPresent,
  auth,
  accounts: accounts.map(({
    plan,
    documents,
    inventory,
    auditAttempts = [],
    usageAttempts = [],
    auditAttemptsPresent = false,
    usageAttemptsPresent = false
  }) => ({
    accountId: plan.accountId,
    store: plan.snapshot,
    documents,
    inventory,
    auditAttempts,
    usageAttempts,
    auditAttemptsPresent,
    usageAttemptsPresent
  }))
});

export async function verifyJsonBundleSources(bundle) {
  for (const { file, sha256 } of bundle.sources) {
    let actual = null;
    try { actual = digest(await fs.readFile(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (actual !== sha256) throw new Error("Migration source changed; freeze writes and rebuild the plan");
  }
}

async function verifyAttachmentSources(bundle, inspectAttachment) {
  for (const { plan, inventory } of bundle.accounts) {
    for (const item of inventory) {
      const name = item.path.slice("/attachments/".length);
      let actual;
      try {
        actual = { path: item.path, ...await inspectAttachment({
          ownerId: plan.accountId, name, localFile: path.join(path.dirname(plan.sourcePath), "attachments", name)
        }) };
      } catch (error) {
        if (item.state === "missing_cleanup" && (["ENOENT", "NoSuchKey"].includes(error.code) || Number(error.status) === 404)) actual = item;
        else throw error;
      }
      if (!equal(actual, item)) throw new Error("Attachment source changed; rebuild the migration plan");
    }
  }
}

async function readAiAttemptRows(client, accountId) {
  const auditAttempts = (await client.query(`
    SELECT * FROM for_now.ai_request_audit
    WHERE account_id=$1
    ORDER BY call_id
  `, [accountId])).rows;
  const usageAttempts = (await client.query(`
    SELECT * FROM for_now.ai_usage_attempts
    WHERE account_id=$1
    ORDER BY call_id
  `, [accountId])).rows;
  return {
    auditAttempts: JSON.parse(JSON.stringify(auditAttempts)),
    usageAttempts: JSON.parse(JSON.stringify(usageAttempts))
  };
}

async function replaceAiAttemptRows(client, accountId, auditAttempts, usageAttempts) {
  await client.query("DELETE FROM for_now.ai_usage_aggregates WHERE account_id=$1", [accountId]);
  await client.query("DELETE FROM for_now.ai_usage_attempts WHERE account_id=$1", [accountId]);
  await client.query("DELETE FROM for_now.ai_request_audit WHERE account_id=$1", [accountId]);
  if (auditAttempts.length) {
    await client.query(`
      INSERT INTO for_now.ai_request_audit
      SELECT * FROM jsonb_populate_recordset(NULL::for_now.ai_request_audit, $1::jsonb)
    `, [JSON.stringify(auditAttempts)]);
  }
  if (usageAttempts.length) {
    await client.query(`
      INSERT INTO for_now.ai_usage_attempts
      SELECT * FROM jsonb_populate_recordset(NULL::for_now.ai_usage_attempts, $1::jsonb)
    `, [JSON.stringify(usageAttempts)]);
    await client.query(`
      INSERT INTO for_now.ai_usage_aggregates (
        account_id, period_date, provider, model, calls, known_cost_micros, unknown_cost_calls
      )
      SELECT account_id, (occurred_at AT TIME ZONE 'UTC')::date, provider, model,
        count(*)::int,
        sum(CASE WHEN cost_known THEN cost_micros ELSE 0 END)::bigint,
        count(*) FILTER (WHERE NOT cost_known)::int
      FROM for_now.ai_usage_attempts
      WHERE account_id=$1
      GROUP BY account_id, (occurred_at AT TIME ZONE 'UTC')::date, provider, model
    `, [accountId]);
  }
}

async function verifyAiAttemptRows(client, accountId, auditAttempts, usageAttempts) {
  const actual = await readAiAttemptRows(client, accountId);
  const comparable = value => JSON.parse(JSON.stringify(value));
  if (!equal(comparable(actual.auditAttempts), comparable(auditAttempts))
    || !equal(comparable(actual.usageAttempts), comparable(usageAttempts))) {
    throw new Error("AI attempt export content mismatch");
  }
}

async function applyBundleAccount(client, account, { previous, reused }) {
  const {
    plan,
    documents,
    inventory,
    auditAttempts = [],
    usageAttempts = [],
    auditAttemptsPresent = false,
    usageAttemptsPresent = false
  } = account;
  await client.query("SELECT set_config('app.account_id', $1, true)", [plan.accountId]);
  const old = (await client.query(
    "SELECT source_sha256 FROM for_now.account_snapshots WHERE account_id = $1",
    [plan.accountId]
  )).rows[0];
  const result = await applyPostgresMigration(client, plan, {
    transaction: false,
    expectedTargetSha256: previous && !reused ? old?.source_sha256 : ""
  });
  const actualDocuments = (await client.query(
    "SELECT document FROM for_now.account_documents WHERE account_id = $1 ORDER BY document",
    [plan.accountId]
  )).rows.map(row => row.document);
  if (reused) {
    if (!equal(actualDocuments, Object.keys(documents).sort())) {
      throw new Error("Account document set mismatch");
    }
  } else {
    if (!previous && actualDocuments.length) {
      throw new Error("Account documents exist without bundle evidence");
    }
    await client.query("DELETE FROM for_now.account_documents WHERE account_id = $1", [plan.accountId]);
    for (const [document, value] of Object.entries(documents)) {
      await writeAccountDocument(client, plan.accountId, document, value);
    }
    await writeAttachmentInventory(client, plan.accountId, inventory);
  }
  const existingAi = await readAiAttemptRows(client, plan.accountId);
  const hasExistingAi = existingAi.auditAttempts.length || existingAi.usageAttempts.length;
  if (!reused && (!auditAttemptsPresent || !usageAttemptsPresent) && hasExistingAi) {
    throw new Error("Legacy bundle cannot replace existing AI audit or usage attempts");
  }
  if (!reused && auditAttemptsPresent && usageAttemptsPresent) {
    await replaceAiAttemptRows(client, plan.accountId, auditAttempts, usageAttempts);
  }
  for (const [document, value] of Object.entries(documents)) {
    await verifyAccountDocument(client, mapAccountDocument(plan.accountId, document, value));
  }
  await verifyAttachmentInventory(client, plan.accountId, inventory);
  if (auditAttemptsPresent && usageAttemptsPresent) {
    await verifyAiAttemptRows(client, plan.accountId, auditAttempts, usageAttempts);
  }
  return result;
}

export async function applyPostgresBundle(client, bundle, { expectedTargetSha256 = "", inspectAttachment = defaultInspect } = {}) {
  if (bundleContentHash(bundle) !== bundle.contentSha256) throw new Error("Modified migration bundle");
  await verifyJsonBundleSources(bundle);
  await verifyAttachmentSources(bundle, inspectAttachment);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))");
    if ((await client.query("SELECT 1 FROM for_now_auth.runtime_state")).rowCount) {
      throw new Error("Database has entered runtime; JSON migration cannot overwrite live data");
    }
    const previous = (await client.query("SELECT * FROM for_now_auth.migration_state WHERE id = 'bundle' FOR UPDATE")).rows[0];
    const reused = previous?.source_sha256 === bundle.sourceSha256;
    if (previous && !reused && previous.source_sha256 !== expectedTargetSha256) throw new Error("Bundle target differs; expectedTargetSha256 is required");
    if (!previous && expectedTargetSha256) throw new Error("Expected bundle target is missing");
    if (!previous && await readAuthDocument(client)) throw new Error("Auth data exists without bundle evidence");
    if (reused && previous.content_sha256 !== bundle.contentSha256) throw new Error("Bundle evidence mismatch");
    if (previous && !reused) {
      const oldAuth = await readAuthDocument(client);
      if (!equal((oldAuth?.users || []).map(user => user.id).sort(), (bundle.auth?.users || []).map(user => user.id).sort())) {
        throw new Error("Bundle replacement cannot change the account set");
      }
    }
    const budgetRow = (await client.query(
      "SELECT document, record_compression_quota AS \"recordCompressionQuota\" FROM for_now.site_ai_budget WHERE id = true FOR UPDATE"
    )).rows[0];
    if (!budgetRow) throw new Error("AI budget singleton is missing");
    const currentQuota = validateRecordCompressionQuota(budgetRow.recordCompressionQuota);
    if (!previous && !equal(currentQuota, EMPTY_RECORD_COMPRESSION_QUOTA) && !equal(currentQuota, bundle.recordCompressionQuota)) {
      throw new Error("Record compression quota exists without bundle evidence; refusing legacy bundle reset");
    }
    if (previous && !reused && !bundle.recordCompressionQuotaPresent
      && !equal(currentQuota, EMPTY_RECORD_COMPRESSION_QUOTA)) {
      throw new Error("Legacy bundle cannot replace existing record compression quota");
    }
    if (reused) {
      if (!equal(budgetRow.document, bundle.aiBudget)) throw new Error("AI budget content mismatch");
      if (!equal(currentQuota, bundle.recordCompressionQuota)) throw new Error("Record compression quota content mismatch");
    } else {
      if (!previous && !equal(budgetRow.document, {})) {
        throw new Error("AI budget data exists without bundle evidence");
      }
    }
    const results = [];
    for (const account of bundle.accounts) {
      results.push(await applyBundleAccount(client, account, { previous, reused }));
    }
    if (bundle.auth) {
      if (!reused) await writeAuthDocument(client, bundle.auth);
      await verifyAuthDocument(client, mapAuthDocument(bundle.auth));
    } else if (await readAuthDocument(client)) throw new Error("Unexpected auth data");
    if (!reused) {
      await client.query(
        "UPDATE for_now.site_ai_budget SET document = $1::jsonb, record_compression_quota = $2::jsonb WHERE id = true",
        [JSON.stringify(bundle.aiBudget), JSON.stringify(bundle.recordCompressionQuota)]
      );
    }
    if (!equal((await client.query(
      "SELECT document FROM for_now.site_ai_budget WHERE id = true"
    )).rows[0]?.document, bundle.aiBudget)) {
      throw new Error("AI budget content mismatch");
    }
    if (!equal((await client.query(
      "SELECT record_compression_quota FROM for_now.site_ai_budget WHERE id = true"
    )).rows[0]?.record_compression_quota, bundle.recordCompressionQuota)) {
      throw new Error("Record compression quota content mismatch");
    }
    await verifyJsonBundleSources(bundle);
    await verifyAttachmentSources(bundle, inspectAttachment);
    await client.query(`
      INSERT INTO for_now_auth.migration_state(id, source_sha256, content_sha256)
      VALUES ('bundle', $1, $2) ON CONFLICT (id) DO UPDATE
      SET source_sha256 = EXCLUDED.source_sha256, content_sha256 = EXCLUDED.content_sha256, imported_at = now()
    `, [bundle.sourceSha256, bundle.contentSha256]);
    await client.query("COMMIT");
    return { reused, sourceSha256: bundle.sourceSha256, contentSha256: bundle.contentSha256, accounts: results };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// A consistent relational export, independent of all migration snapshots.
// Caller owns the transaction (REPEATABLE READ for an online export).
export async function readPostgresBundle(client, accountIds) {
  const auth = await readAuthDocument(client), accounts = [];
  const budgetRow = (await client.query(
    "SELECT document, record_compression_quota AS \"recordCompressionQuota\" FROM for_now.site_ai_budget WHERE id = true"
  )).rows[0];
  if (!budgetRow) throw new Error("AI budget singleton is missing");
  for (const accountId of accountIds) {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const store = rebuildStoreObjects(await readPostgresStoreObjects(client, accountId));
    const documents = {};
    for (const document of Object.keys(ACCOUNT_DOCUMENT_FILES)) {
      const value = await readAccountDocument(client, accountId, document);
      if (value !== null) documents[document] = value;
    }
    const attempts = await readAiAttemptRows(client, accountId);
    if (attempts.usageAttempts.length) {
      const existing = Array.isArray(documents.usage?.entries)
        ? documents.usage.entries
        : [];
      const entries = new Map(existing.map(entry => [entry.callId || entry.id, entry]));
      for (const row of attempts.usageAttempts) {
        entries.set(row.call_id, structuredClone(row.payload));
      }
      const values = [...entries.values()].sort((left, right) => (
        String(left.createdAt).localeCompare(String(right.createdAt))
        || String(left.callId || left.id).localeCompare(String(right.callId || right.id))
      ));
      documents.usage = {
        ...(documents.usage || {}),
        version: 5,
        trackingStartedAt: values[0]?.createdAt || documents.usage?.trackingStartedAt || "",
        entries: values
      };
    }
    accounts.push({
      accountId,
      store,
      documents,
      inventory: await readAttachmentInventory(client, accountId),
      ...attempts,
      auditAttemptsPresent: true,
      usageAttemptsPresent: true
    });
  }
  return {
    aiBudget: budgetRow.document,
    recordCompressionQuota: validateRecordCompressionQuota(budgetRow.recordCompressionQuota),
    auth,
    accounts
  };
}
