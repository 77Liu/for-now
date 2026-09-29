import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  discoverJsonBundle, applyPostgresBundle, readPostgresBundle, initializePostgresSchema
} from "../src/shared/persistence/index.mjs";
import { writeMigrationBundleFixture } from "./fixtures/migration-bundle.mjs";

export async function runBundleChecks({ admin, client, connect, temporary }) {
  const directory = path.join(temporary, "bundle");
  const auth = await writeMigrationBundleFixture(directory);
  const bundle = await discoverJsonBundle(directory);
  await admin.query("GRANT USAGE ON SCHEMA for_now_auth TO migration_app");
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now_auth TO migration_app");
  await admin.query(`
    CREATE FUNCTION for_now.corrupt_document() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.model := 'corrupted'; RETURN NEW; END $$;
    CREATE TRIGGER corrupt_document BEFORE INSERT ON for_now.document_records FOR EACH ROW EXECUTE FUNCTION for_now.corrupt_document()
  `);
  await assert.rejects(applyPostgresBundle(client, bundle), /Document content mismatch/);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM for_now.accounts WHERE account_id = 'bundle-a'")).rows[0].n, 0);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM for_now_auth.users")).rows[0].n, 0);
  await admin.query("DROP TRIGGER corrupt_document ON for_now.document_records");
  const result = await applyPostgresBundle(client, bundle);
  assert.equal(result.reused, false);
  assert.equal((await applyPostgresBundle(client, bundle)).reused, true);
  const read = async connection => {
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      const exported = await readPostgresBundle(connection, auth.users.map(user => user.id));
      await connection.query("COMMIT");
      return exported;
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
  };
  const exported = await read(client);
  assert.deepEqual(exported.auth, auth);
  for (const [index, row] of exported.accounts.entries()) {
    assert.deepEqual(row.store, bundle.accounts[index].plan.snapshot);
    assert.deepEqual(row.documents, bundle.accounts[index].documents);
    assert.deepEqual(row.inventory, bundle.accounts[index].inventory.toSorted((a, b) => a.path.localeCompare(b.path)));
  }
  // Secrets have no duplicate in normal settings rows or migration snapshots.
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM for_now.document_records WHERE payload::text LIKE '%synthetic-only-key%'")).rows[0].n, 0);
  await admin.query("CREATE ROLE tenant_only NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT USAGE ON SCHEMA for_now TO tenant_only");
  await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA for_now TO tenant_only");
  await admin.query("SET ROLE tenant_only");
  await assert.rejects(admin.query("SELECT * FROM for_now_auth.users"), error => error.code === "42501");
  await admin.query("RESET ROLE");

  await admin.query("UPDATE for_now.document_records SET payload = '\"tampered\"'::jsonb WHERE account_id = 'bundle-a' AND field = 'scenarios' AND document = 'settings'");
  await assert.rejects(applyPostgresBundle(client, bundle), /Document content mismatch/);
  await admin.query("UPDATE for_now.document_records SET payload = '\"lite\"'::jsonb WHERE account_id = 'bundle-a' AND field = 'scenarios' AND document = 'settings'");
  const changed = structuredClone(bundle);
  changed.accounts[0].documents.settings.assistantName = "changed";
  await assert.rejects(applyPostgresBundle(client, changed), /Modified migration bundle/);
  const attachmentFile = path.join(directory, "users/bundle-a/attachments/orphan.png");
  const attachmentBytes = await fs.readFile(attachmentFile);
  await fs.writeFile(attachmentFile, "changed bytes");
  await assert.rejects(applyPostgresBundle(client, bundle), /Attachment source changed/);
  await fs.writeFile(attachmentFile, attachmentBytes);
  const file = path.join(directory, "users/bundle-a/ai-cost-plan.json");
  const originalText = await fs.readFile(file, "utf8");
  await fs.writeFile(file, `${originalText}\n`);
  await assert.rejects(applyPostgresBundle(client, bundle), /source changed/);
  const newBundle = await discoverJsonBundle(directory);
  await assert.rejects(applyPostgresBundle(client, newBundle), /Bundle target differs/);
  await applyPostgresBundle(client, newBundle, { expectedTargetSha256: bundle.sourceSha256 });
  assert.deepEqual(await read(client), exported);

  // Build an independent database from relational output and copied binaries.
  const restoreDir = path.join(temporary, "bundle-restore");
  await fs.mkdir(restoreDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(restoreDir, "auth.json"), JSON.stringify(exported.auth), { mode: 0o600 });
  for (const row of exported.accounts) {
    const root = path.join(restoreDir, "users", row.accountId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, "store.json"), JSON.stringify(row.store), { mode: 0o600 });
    for (const [key, filename] of Object.entries({ settings: "llm-settings.json", usage: "ai-usage.json", costPlan: "ai-cost-plan.json" })) {
      await fs.writeFile(path.join(root, filename), JSON.stringify(row.documents[key]), { mode: 0o600 });
    }
    await fs.cp(path.join(directory, "users", row.accountId, "attachments"), path.join(root, "attachments"), { recursive: true });
  }
  await admin.query("CREATE DATABASE bundle_restore");
  const restoreAdmin = await connect("postgres", "bundle_restore");
  await initializePostgresSchema(restoreAdmin);
  await restoreAdmin.query("GRANT USAGE ON SCHEMA for_now, for_now_auth TO migration_app");
  await restoreAdmin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now, for_now_auth TO migration_app");
  const restoreClient = await connect("migration_app", "bundle_restore");
  await applyPostgresBundle(restoreClient, await discoverJsonBundle(restoreDir));
  assert.deepEqual(await read(restoreClient), exported);
  return ["full bundle atomic rollback", "auth/config/usage/cost/attachment round-trip", "secret partition and auth schema grants",
    "bundle repeat corruption guard", "source drift guard", "independent database restore"];
}
