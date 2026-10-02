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

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const defaultInspect = async ({ name, localFile }) => {
  const stat = await fs.lstat(localFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment must be a regular file");
  const data = await fs.readFile(localFile);
  return { storage: "local", objectKey: name, bytes: data.length, sha256: digest(data), state: "verified" };
};

export async function discoverJsonBundle(dataDir, { inspectAttachment = defaultInspect } = {}) {
  const sources = [];
  const read = async (file, optional = false) => {
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
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error(`Invalid migration document: ${path.basename(file)}`); }
  };
  const auth = await read(path.join(dataDir, "auth.json"), true);
  if (auth) mapAuthDocument(auth);
  const aiBudget = await read(path.join(dataDir, AI_BUDGET_DOCUMENT_FILE), true) || {};
  const owners = auth?.users.length ? auth.users : [{ id: "local", createdAt: "" }];
  const accounts = [];
  for (const user of owners) {
    const directory = auth?.users.length ? path.join(dataDir, "users", user.id) : dataDir;
    const storePath = path.join(directory, "store.json");
    const store = await read(storePath);
    const plan = buildPostgresMigrationPlan({ accountId: user.id, accountCreatedAt: user.createdAt, store, sourcePath: storePath });
    const documents = {};
    for (const [document, filename] of Object.entries(ACCOUNT_DOCUMENT_FILES)) {
      const value = await read(path.join(directory, filename), true);
      if (value !== null) {
        mapAccountDocument(user.id, document, value);
        documents[document] = value;
      }
    }
    const references = new Map();
    for (const reference of plan.business.attachmentRefs) {
      if (!references.has(reference.path)) references.set(reference.path, []);
      references.get(reference.path).push(reference);
    }
    // Include unreferenced local files in the manifest as recovery assets.
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
        inventory.push({ path: resourcePath, ...await inspectAttachment({ ownerId: user.id, name, localFile: path.join(attachmentDir, name) }) });
      } catch (error) {
        if (["ENOENT", "NoSuchKey"].includes(error.code) || Number(error.status) === 404) {
          if (refs.length && refs.every(ref => ref.fieldName === "attachmentCleanup")) {
            inventory.push({ path: resourcePath, storage: "unknown", objectKey: name, bytes: null, sha256: null, state: "missing_cleanup" });
          } else throw new Error(`Missing referenced attachment for account ${user.id}: ${name}`);
        } else throw error;
      }
    }
    accounts.push({ plan, documents, inventory });
  }
  const contentSha256 = bundleContentHash({ aiBudget, auth, accounts });
  // Relative filenames make copied snapshots reproducible.
  const sourceSha256 = storeContentSha256({
    sources: sources.map(({ file, sha256 }) => ({ file: path.relative(dataDir, file), sha256 })),
    contentSha256
  });
  return { aiBudget, auth, accounts, sources, sourceSha256, contentSha256 };
}

const bundleContentHash = ({ aiBudget, auth, accounts }) => storeContentSha256({
  aiBudget,
  auth,
  accounts: accounts.map(({ plan, documents, inventory }) => ({ accountId: plan.accountId, store: plan.snapshot, documents, inventory }))
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
      "SELECT document FROM for_now.site_ai_budget WHERE id = true FOR UPDATE"
    )).rows[0];
    if (!budgetRow) throw new Error("AI budget singleton is missing");
    if (reused) {
      if (!equal(budgetRow.document, bundle.aiBudget)) throw new Error("AI budget content mismatch");
    } else {
      if (!previous && !equal(budgetRow.document, {})) {
        throw new Error("AI budget data exists without bundle evidence");
      }
    }
    const results = [];
    for (const { plan, documents, inventory } of bundle.accounts) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [plan.accountId]);
      const old = (await client.query("SELECT source_sha256 FROM for_now.account_snapshots WHERE account_id = $1", [plan.accountId])).rows[0];
      results.push(await applyPostgresMigration(client, plan, { transaction: false, expectedTargetSha256: previous && !reused ? old?.source_sha256 : "" }));
      const actualDocuments = (await client.query("SELECT document FROM for_now.account_documents WHERE account_id = $1 ORDER BY document", [plan.accountId])).rows.map(row => row.document);
      if (reused) {
        if (!equal(actualDocuments, Object.keys(documents).sort())) throw new Error("Account document set mismatch");
      } else {
        if (!previous && actualDocuments.length) throw new Error("Account documents exist without bundle evidence");
        await client.query("DELETE FROM for_now.account_documents WHERE account_id = $1", [plan.accountId]);
        for (const [document, value] of Object.entries(documents)) await writeAccountDocument(client, plan.accountId, document, value);
        await writeAttachmentInventory(client, plan.accountId, inventory);
      }
      for (const [document, value] of Object.entries(documents)) await verifyAccountDocument(client, mapAccountDocument(plan.accountId, document, value));
      await verifyAttachmentInventory(client, plan.accountId, inventory);
    }
    if (bundle.auth) {
      if (!reused) await writeAuthDocument(client, bundle.auth);
      await verifyAuthDocument(client, mapAuthDocument(bundle.auth));
    } else if (await readAuthDocument(client)) throw new Error("Unexpected auth data");
    if (!reused) {
      await client.query(
        "UPDATE for_now.site_ai_budget SET document = $1::jsonb WHERE id = true",
        [JSON.stringify(bundle.aiBudget)]
      );
    }
    if (!equal((await client.query(
      "SELECT document FROM for_now.site_ai_budget WHERE id = true"
    )).rows[0]?.document, bundle.aiBudget)) {
      throw new Error("AI budget content mismatch");
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
    "SELECT document FROM for_now.site_ai_budget WHERE id = true"
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
    accounts.push({ accountId, store, documents, inventory: await readAttachmentInventory(client, accountId) });
  }
  return { aiBudget: budgetRow.document, auth, accounts };
}
