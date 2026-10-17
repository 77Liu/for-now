import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPostgresSchemaRegistry } from "../../../.build/typescript/backend/shared/persistence/migrations/registry.mjs";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects, storeContentSha256 } from "./store-mapping.mjs";
import { clearStoreObjects, verifyStoreObjects, writeStoreObjects } from "./postgres-objects.mjs";
import { preparePersistenceDocument } from "./persistence-metadata.mjs";

const SCHEMA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres-schema.sql");

const isoOrNull = value => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const versionOf = value => Math.max(1, Math.round(Number(value) || 1));
const json = value => JSON.stringify(value ?? null);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const parseSource = text => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON migration source");
  }
};
const requireUniqueIds = (items, label) => {
  const ids = new Set();
  for (const item of items) {
    if (!item?.id) throw new Error(`${label} contains an item without id`);
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    ids.add(item.id);
  }
};

function thoughtBlockKind(item) {
  if (item.type === "question") return "user_question";
  if (item.type === "idea") return "user_idea";
  if (item.type === "record") return "user_record";
  return item.authorType === "user" ? "user_answer" : "ai_answer";
}

function migrationCounts(store) {
  const roots = (store.thoughts || []).filter(item => item.type === "question");
  return {
    storeCollections: Object.fromEntries(Object.entries(store).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    thoughtEntries: roots.length,
    thoughtBlocks: (store.thoughts || []).length,
    thoughtFollowUps: roots.reduce((sum, item) => sum + (item.followUps?.length || 0), 0),
    thoughtRemarks: roots.reduce((sum, item) => sum + (item.remarks?.length || 0), 0),
    thoughtAnnotations: roots.reduce((sum, item) => sum + (item.annotations?.length || 0) + (item.annotationDrift?.length || 0), 0)
  };
}

export function buildPostgresMigrationPlan({ accountId, store, sourceText, sourcePath = "", accountCreatedAt = "" }) {
  if (typeof accountId !== "string" || !accountId) throw new Error("Migration accountId is required");
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error(`Invalid JSON store: ${sourcePath || accountId}`);
  if (!Array.isArray(store.thoughts)) throw new Error(`Store has no thoughts array: ${sourcePath || accountId}`);
  const canonicalSource = sourceText ?? `${JSON.stringify(store, null, 2)}\n`;
  if (canonicalJson(parseSource(canonicalSource)) !== canonicalJson(store)) throw new Error("Source text does not match store");
  store = preparePersistenceDocument(
    structuredClone(store),
    () => isoOrNull(accountCreatedAt) || "1970-01-01T00:00:00.000Z",
    { force: true }
  );

  requireUniqueIds(store.thoughts, "Thought blocks");
  const roots = store.thoughts.filter(item => item.type === "question");
  const rootIds = new Set(roots.map(item => item.id));
  const orphanIds = store.thoughts
    .filter(item => item?.id && item.type !== "question" && !rootIds.has(item.relatedTo))
    .map(item => item.id);
  if (orphanIds.length) throw new Error(`Thought blocks without a root: ${orphanIds.join(", ")}`);

  const entries = roots.map(item => ({
    accountId,
    id: item.id,
    kind: "thought",
    authorType: item.authorType || "user",
    occurredAt: isoOrNull(item.occurredAt),
    occurredOn: item.occurredOn || null,
    createdAt: isoOrNull(item.createdAt),
    updatedAt: isoOrNull(item.updatedAt),
    version: versionOf(item.version),
    tags: item.tags || [],
    payload: item
  }));

  const entryBlocks = store.thoughts.map((item, position) => ({
    accountId,
    id: item.id,
    entryId: item.type === "question" ? item.id : item.relatedTo,
    kind: thoughtBlockKind(item),
    authorType: item.authorType || (item.type === "answer" ? "ai" : "user"),
    content: String(item.content || ""),
    position,
    occurredAt: isoOrNull(item.occurredAt),
    occurredOn: item.occurredOn || null,
    createdAt: isoOrNull(item.createdAt),
    updatedAt: isoOrNull(item.updatedAt),
    version: versionOf(item.version),
    payload: item
  }));

  const followUpItems = roots.flatMap(root => root.followUps || []);
  const remarkItems = roots.flatMap(root => root.remarks || []);
  const annotationItems = roots.flatMap(root => [...(root.annotations || []), ...(root.annotationDrift || [])]);
  requireUniqueIds(followUpItems, "Thought follow-ups");
  requireUniqueIds(remarkItems, "Thought remarks");
  requireUniqueIds(annotationItems, "Thought annotations");

  const followUps = roots.flatMap(root => (root.followUps || []).map(item => ({
    accountId,
    id: item.id,
    entryId: root.id,
    question: String(item.question || ""),
    answer: String(item.answer || ""),
    questionAuthorType: "user",
    answerAuthorType: item.answer ? (item.authorType || (item.modelDraft ? "ai" : "user")) : null,
    createdAt: isoOrNull(item.createdAt),
    updatedAt: isoOrNull(item.updatedAt),
    version: versionOf(item.version),
    payload: item
  })));

  const remarks = roots.flatMap(root => (root.remarks || []).map(item => ({
    accountId,
    id: item.id,
    entryId: root.id,
    content: String(item.text || item.content || ""),
    createdAt: isoOrNull(item.createdAt),
    updatedAt: isoOrNull(item.updatedAt),
    version: versionOf(item.version),
    payload: item
  })));

  const annotations = roots.flatMap(root => [
    ...(root.annotations || []).map(item => ({ item, kind: item.kind || "comment" })),
    ...(root.annotationDrift || []).map(item => ({ item, kind: "drift" }))
  ].map(({ item, kind }) => ({
    accountId,
    id: item.id,
    entryId: root.id,
    kind,
    targetKey: String(item.targetKey || item.originalTargetKey || ""),
    quote: String(item.quote || ""),
    content: String(item.text || ""),
    createdAt: isoOrNull(item.createdAt),
    payload: item
  })));

  const business = mapStoreObjects(accountId, store);
  const contentSha256 = storeContentSha256(store);
  if (storeContentSha256(rebuildStoreObjects(business)) !== contentSha256) throw new Error("Mapping round-trip hash mismatch");
  return {
    accountId,
    accountCreatedAt: isoOrNull(accountCreatedAt),
    sourcePath,
    sourceVersion: Math.max(1, Math.round(Number(store.version) || 1)),
    sourceSha256: sha256(canonicalSource),
    contentSha256,
    sourceCounts: {
      ...migrationCounts(store),
      businessFields: business.fields.length,
      businessObjects: business.objects.length,
      businessRelations: business.relations.length,
      attachmentReferences: business.attachmentRefs.length,
      lifecycleRecords: business.lifecycles.length,
      idempotencyRecords: business.idempotency.length
    },
    business,
    snapshot: store,
    entries,
    entryBlocks,
    followUps,
    remarks,
    annotations
  };
}

export async function discoverJsonStores(dataDir, accountFilter = "") {
  const authFile = path.join(dataDir, "auth.json");
  let users = [];
  try {
    const auth = parseSource(await fs.readFile(authFile, "utf8"));
    if (!Array.isArray(auth.users) || !auth.users.length) throw new Error("Auth document has no users; refusing local-store fallback");
    requireUniqueIds(auth.users, "Accounts");
    users = auth.users;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sources = users.length
    ? users.map(user => {
      if (typeof user.id !== "string" || !/^[\w-]+$/.test(user.id)) throw new Error("Unsafe account directory id");
      return { accountId: user.id, accountCreatedAt: user.createdAt, sourcePath: path.join(dataDir, "users", user.id, "store.json") };
    })
    : [{ accountId: accountFilter || "local", accountCreatedAt: "", sourcePath: path.join(dataDir, "store.json") }];
  const selected = accountFilter ? sources.filter(item => item.accountId === accountFilter) : sources;
  if (!selected.length) throw new Error(`Account not found in JSON data: ${accountFilter}`);

  return Promise.all(selected.map(async source => {
    const sourceText = await fs.readFile(source.sourcePath, "utf8");
    const store = parseSource(sourceText);
    return buildPostgresMigrationPlan({ ...source, store, sourceText });
  }));
}

async function targetCounts(client, accountId) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM for_now.store_fields WHERE account_id = $1) AS "businessFields",
      (SELECT count(*)::int FROM for_now.store_objects WHERE account_id = $1) AS "businessObjects",
      (SELECT count(*)::int FROM for_now.store_relations WHERE account_id = $1) AS "businessRelations",
      (SELECT count(*)::int FROM for_now.store_attachment_refs WHERE account_id = $1) AS "attachmentReferences",
      (SELECT count(*)::int FROM for_now.resource_lifecycle WHERE account_id = $1) AS "lifecycleRecords",
      (SELECT count(*)::int FROM for_now.idempotency_ledger WHERE account_id = $1) AS "idempotencyRecords"
  `, [accountId]);
  return result.rows[0];
}

export async function applyPostgresMigration(client, plan, { expectedTargetSha256 = "", transaction = true } = {}) {
  // A caller cannot change mapped rows after dry-run while retaining its hash.
  const rebuiltPlan = buildPostgresMigrationPlan({ accountId: plan.accountId, store: plan.snapshot });
  for (const key of ["contentSha256", "sourceCounts", "business", "entries", "entryBlocks", "followUps", "remarks", "annotations"]) {
    if (canonicalJson(plan[key]) !== canonicalJson(rebuiltPlan[key])) throw new Error(`Modified migration plan: ${key}`);
  }
  const runId = crypto.randomUUID();
  if (transaction) await client.query("BEGIN");
  try {
    const role = await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) throw new Error("Migration requires a non-superuser, non-BYPASSRLS role");
    const ownership = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('for_now', 'for_now_auth') AND c.relkind = 'r' AND pg_has_role(current_user, c.relowner, 'USAGE')
      ) AS owns_tables
    `);
    if (ownership.rows[0].owns_tables) throw new Error("Migration role must not own the store tables");
    await client.query("SELECT set_config('app.account_id', $1, true)", [plan.accountId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`for-now-account:${plan.accountId}`]);
    const runtime = (await client.query("SELECT runtime_started_at FROM for_now.accounts WHERE account_id = $1", [plan.accountId])).rows[0];
    if (runtime?.runtime_started_at) throw new Error("Account has entered runtime; JSON migration cannot overwrite live data");
    const previous = (await client.query(
      "SELECT source_sha256, migration_run_id, snapshot FROM for_now.account_snapshots WHERE account_id = $1 FOR UPDATE",
      [plan.accountId]
    )).rows[0];
    if (previous?.source_sha256 === plan.sourceSha256) {
      if (storeContentSha256(previous.snapshot) !== plan.contentSha256) throw new Error("Stored snapshot hash mismatch");
      await verifyStoreObjects(client, plan);
      const counts = await targetCounts(client, plan.accountId);
      if (transaction) await client.query("COMMIT");
      return { runId: previous.migration_run_id, accountId: plan.accountId, sourceSha256: plan.sourceSha256, contentSha256: plan.contentSha256, reused: true, counts };
    }
    if (previous && previous.source_sha256 !== expectedTargetSha256) {
      throw new Error("Target already contains a different snapshot; expectedTargetSha256 is required");
    }
    if (!previous && expectedTargetSha256) throw new Error("Expected target snapshot is missing");
    if (!previous) {
      const occupied = await client.query(`
        SELECT EXISTS (SELECT 1 FROM for_now.store_fields WHERE account_id = $1) AS occupied
      `, [plan.accountId]);
      if (occupied.rows[0].occupied) throw new Error("Target has data without a migration snapshot; refusing replacement");
    }
    await client.query(
      `INSERT INTO for_now.accounts (account_id, source_created_at, imported_at)
       VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE
       SET source_created_at = COALESCE(EXCLUDED.source_created_at, for_now.accounts.source_created_at),
           imported_at = now()`,
      [plan.accountId, plan.accountCreatedAt]
    );
    await client.query(
      `INSERT INTO for_now.migration_runs
       (run_id, account_id, source_format, source_version, source_sha256, source_counts, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'running')`,
      [runId, plan.accountId, `json-v${plan.sourceVersion}`, plan.sourceVersion, plan.sourceSha256, json(plan.sourceCounts)]
    );
    await client.query(
      `INSERT INTO for_now.account_snapshots
       (account_id, schema_version, source_sha256, snapshot, migration_run_id, imported_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())
       ON CONFLICT (account_id) DO UPDATE
       SET schema_version = EXCLUDED.schema_version,
           source_sha256 = EXCLUDED.source_sha256,
           snapshot = EXCLUDED.snapshot,
           migration_run_id = EXCLUDED.migration_run_id,
           imported_at = now()`,
      [plan.accountId, plan.sourceVersion, plan.sourceSha256, json(plan.snapshot), runId]
    );

    await clearStoreObjects(client, plan.accountId);
    await writeStoreObjects(client, plan.business);

    const counts = await targetCounts(client, plan.accountId);
    for (const key of Object.keys(counts)) {
      if (counts[key] !== plan.sourceCounts[key]) throw new Error(`Migration count mismatch for ${key}: ${counts[key]} != ${plan.sourceCounts[key]}`);
    }
    await verifyStoreObjects(client, plan);
    await client.query(
      `UPDATE for_now.migration_runs
       SET target_counts = $2::jsonb, status = 'verified', completed_at = now()
       WHERE run_id = $1`,
      [runId, json(counts)]
    );
    if (transaction) await client.query("COMMIT");
    return { runId, accountId: plan.accountId, sourceSha256: plan.sourceSha256, contentSha256: plan.contentSha256, reused: false, counts };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK");
    throw error;
  }
}

export async function initializePostgresSchema(client) {
  await client.query("BEGIN");
  try {
    const schema = await fs.readFile(SCHEMA_FILE, "utf8");
    assertPostgresSchemaRegistry(schema);
    await client.query(schema);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateJsonStoresToPostgres({ dataDir, connectionString, accountId = "", expectedTargetSha256 = "" }) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (expectedTargetSha256 && !accountId) throw new Error("Replacing a shadow snapshot requires one explicit accountId");
  const plans = await discoverJsonStores(dataDir, accountId);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const results = [];
    for (const plan of plans) results.push(await applyPostgresMigration(client, plan, { expectedTargetSha256 }));
    return results;
  } finally {
    await client.end();
  }
}
