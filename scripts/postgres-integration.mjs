import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  applyPostgresMigration, buildPostgresMigrationPlan, initializePostgresSchema,
  readPostgresStoreObjects, rebuildStoreObjects
} from "../src/shared/persistence/index.mjs";
import { migrationStore } from "./fixtures/migration-store.mjs";
import { runAiMigrationPostgresChecks } from "./ai-audit-migration-postgres-checks.mjs";
import { runBundleChecks } from "./postgres-bundle-checks.mjs";
import { runRuntimeChecks } from "./postgres-runtime-checks.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaryDir = process.env.PG_TEST_BIN || path.join(ROOT, "data/pg-integration-tools/node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
const binaryEnv = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
const libraryDir = path.resolve(binaryDir, "../lib");
// macOS sandbox execution may relocate the executable without its sibling libraries.
if (process.platform === "darwin" && await fs.access(libraryDir).then(() => true, () => false)) {
  binaryEnv.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
}
const run = promisify(execFile);
for (const name of ["postgres", "pg_ctl", "initdb"]) {
  await fs.access(path.join(binaryDir, name)).catch(() => {
    throw new Error("Real PostgreSQL binaries are required. Set PG_TEST_BIN to their bin directory (see knowledge/system-testing.md).");
  });
}
// Always create a fresh local cluster. DATABASE_URL and production data are never used.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-pg-"));
const cluster = path.join(temporary, "cluster");
const password = crypto.randomBytes(24).toString("hex");
const passwordFile = path.join(temporary, "password");
let started = false;
const clients = [];
const command = (name, args) => run(path.join(binaryDir, name), args, { timeout: 30000, maxBuffer: 1024 * 1024, env: binaryEnv });
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const inAccount = async (client, accountId, action) => {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

try {
  const version = (await command("postgres", ["--version"])).stdout.trim();
  assert.match(version, /^postgres \(PostgreSQL\) 16(?:\.|$)/, "PostgreSQL 16 is required for this release gate");
  const port = await freePort();
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  await command("initdb", ["-D", cluster, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordFile, "--locale=C", "--encoding=UTF8"]);
  await fs.appendFile(path.join(cluster, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  try {
    await command("pg_ctl", ["-D", cluster, "-l", path.join(temporary, "postgres.log"), "-w", "-t", "20", "start"]);
  } catch (error) {
    const log = await fs.readFile(path.join(temporary, "postgres.log"), "utf8").catch(() => "");
    if (log) process.stderr.write(log);
    throw error;
  }
  started = true;
  const connect = async (user, database = "postgres") => {
    const client = new pg.Client({ host: "127.0.0.1", port, database, user, password });
    clients.push(client);
    await client.connect();
    return client;
  };
  const admin = await connect("postgres");
  await initializePostgresSchema(admin);
  await admin.query("UPDATE for_now.site_ai_budget SET document = '{\"schemaRepeat\":true}'::jsonb WHERE id = true");
  await initializePostgresSchema(admin);
  assert.deepEqual(
    (await admin.query("SELECT document FROM for_now.site_ai_budget WHERE id = true")).rows[0].document,
    { schemaRepeat: true }
  );
  await admin.query("UPDATE for_now.site_ai_budget SET document = '{}'::jsonb WHERE id = true");
  // The generated hex password is only for this throwaway cluster.
  await admin.query(`CREATE ROLE migration_app LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query("GRANT USAGE ON SCHEMA for_now TO migration_app");
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now TO migration_app");
  const client = await connect("migration_app");
  const peer = await connect("migration_app");
  const source = buildPostgresMigrationPlan({
    accountId: "account-a",
    store: migrationStore("account-a")
  }).snapshot;
  source._persistence.futureMetadata = { retained: true };
  source._persistence.lifecycles[0].futureLifecycle = { retained: true };
  source._persistence.idempotency.push({
    scope: "migration.null-response",
    key: "null-response",
    requestHash: "null-response-request",
    response: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-12-28T00:00:00.000Z",
    futureLedger: { retained: true }
  });
  const plan = buildPostgresMigrationPlan({ accountId: "account-a", store: source });
  const other = migrationStore("account-b");
  other.captures[0].content = "账户 B 的原文";
  other.captures.push({ id: "only-b", content: "B 独有" });
  const otherPlan = buildPostgresMigrationPlan({ accountId: "account-b", store: other });
  const read = (connection, accountId) => inAccount(connection, accountId, async () =>
    rebuildStoreObjects(await readPostgresStoreObjects(connection, accountId)));

  await assert.rejects(applyPostgresMigration(admin, plan), /non-superuser/);
  const imported = await applyPostgresMigration(client, plan);
  await applyPostgresMigration(client, otherPlan);
  assert.equal(imported.reused, false);
  assert.deepEqual(await read(client, "account-a"), plan.snapshot);
  assert.deepEqual(await read(client, "account-b"), otherPlan.snapshot);
  const evidenceRows = await inAccount(client, "account-a", () => client.query(`
    SELECT kind, id, version
    FROM for_now.store_objects
    WHERE collection IN ('evidenceSources', 'evidencePermissions', 'perceptionEvents')
    ORDER BY kind, id
  `));
  assert.deepEqual(
    evidenceRows.rows.reduce((counts, row) => ({
      ...counts,
      [row.kind]: (counts[row.kind] || 0) + 1
    }), {}),
    { evidencePermission: 2, evidenceSource: 2, perceptionEvent: 1 }
  );
  assert.ok(evidenceRows.rows
    .filter(row => row.kind === "evidencePermission")
    .every(row => row.id.startsWith("[") && row.version >= 1));
  const evidenceRelations = await inAccount(client, "account-a", () => client.query(`
    SELECT relation, target_id, resolution
    FROM for_now.store_relations
    WHERE object_key LIKE '["evidenceSources"%'
       OR object_key LIKE '["evidencePermissions"%'
       OR object_key LIKE '["perceptionEvents"%'
    ORDER BY object_key, relation
  `));
  assert.ok(evidenceRelations.rows.some(row => (
    row.relation === "source"
    && row.target_id === "shared-id"
    && row.resolution === "live"
  )));
  assert.ok(evidenceRelations.rows.some(row => (
    row.relation === "derivedFrom:0"
    && row.target_id === "shared-id"
    && row.resolution === "live"
  )));
  assert.equal(
    await inAccount(client, "account-b", async () => {
      const result = await client.query(`
        SELECT count(*)::int AS count
        FROM for_now.store_objects
        WHERE collection IN ('evidenceSources', 'evidencePermissions', 'perceptionEvents')
          AND payload->>'accountId' = 'account-a'
      `);
      return result.rows[0].count;
    }),
    0
  );
  await admin.query(`
    UPDATE for_now.store_fields
    SET payload = jsonb_build_object('version', payload->'version')
    WHERE field = '_persistence';
    ALTER TABLE for_now.resource_lifecycle DROP COLUMN position, DROP COLUMN payload;
    ALTER TABLE for_now.idempotency_ledger DROP COLUMN position, DROP COLUMN payload
  `);
  await initializePostgresSchema(admin);
  assert.deepEqual(await read(client, "account-a"), plan.snapshot);
  assert.deepEqual(await read(client, "account-b"), otherPlan.snapshot);
  const repeated = await applyPostgresMigration(client, plan);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.runId, imported.runId);
  const both = await Promise.all([applyPostgresMigration(client, plan), applyPostgresMigration(peer, plan)]);
  assert.ok(both.every(result => result.reused));
  const freshPlan = buildPostgresMigrationPlan({
    accountId: "concurrent-account",
    store: migrationStore("concurrent-account")
  });
  const firstImports = await Promise.all([applyPostgresMigration(client, freshPlan), applyPostgresMigration(peer, freshPlan)]);
  assert.equal(firstImports.filter(result => !result.reused).length, 1);

  const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'for_now' ORDER BY tablename")).rows.map(row => row.tablename);
  const tenantTables = tables.filter(table => table !== "site_ai_budget");
  const policies = (await admin.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'for_now' AND c.relkind = 'r' AND c.relname <> 'site_ai_budget'
  `)).rows;
  assert.ok(policies.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const globalSecurity = (await admin.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'for_now' AND c.relname = 'site_ai_budget'
  `)).rows[0];
  assert.deepEqual(globalSecurity, { relrowsecurity: false, relforcerowsecurity: false });
  for (const table of tenantTables) {
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM for_now.${table}`)).rows[0].count, 0);
    await inAccount(client, "account-a", async () => {
      const rows = (await client.query(`SELECT DISTINCT account_id FROM for_now.${table}`)).rows;
      assert.ok(rows.every(row => row.account_id === "account-a"));
      assert.equal((await client.query(`DELETE FROM for_now.${table} WHERE account_id = 'account-b'`)).rowCount, 0);
    });
  }
  await assert.rejects(inAccount(client, "account-a", () => client.query(
    "INSERT INTO for_now.store_fields(account_id,field,shape) VALUES ('account-b','illegal','value')"
  )), error => error.code === "42501");
  await assert.rejects(inAccount(client, "account-a", async () => {
    await client.query(`
      INSERT INTO for_now.store_objects(account_id,object_key,collection,kind,id,parent_key,field,position,child_fields,content,status,author_type,version,payload)
      VALUES ('account-a','invalid-parent','captures','annotation','bad','["captures","only-b"]','annotations',0,'[]','','','',1,'{}')
    `);
  }), error => error.code === "23503");

  const updatedSource = structuredClone(source);
  updatedSource.captures[0].content = "合法新快照";
  const updated = buildPostgresMigrationPlan({ accountId: plan.accountId, store: updatedSource });
  await assert.rejects(applyPostgresMigration(client, updated), /different snapshot/);
  await assert.rejects(applyPostgresMigration(client, updated, { expectedTargetSha256: "wrong" }), /different snapshot/);
  const modifiedPlan = structuredClone(plan);
  modifiedPlan.entryBlocks[0].content = "篡改投影";
  await assert.rejects(applyPostgresMigration(client, modifiedPlan), /Modified migration plan/);

  // Failure after fields, objects, relations and snapshots have already been written.
  await admin.query(`
    CREATE FUNCTION for_now.fail_import() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected import failure'; END $$;
    CREATE TRIGGER fail_import BEFORE INSERT ON for_now.store_attachment_refs FOR EACH ROW EXECUTE FUNCTION for_now.fail_import()
  `);
  await assert.rejects(applyPostgresMigration(client, updated, { expectedTargetSha256: plan.sourceSha256 }), /injected import failure/);
  assert.deepEqual(await read(client, "account-a"), plan.snapshot);
  await admin.query("DROP TRIGGER fail_import ON for_now.store_attachment_refs");
  assert.equal((await admin.query("SELECT count(*)::int AS count FROM for_now.migration_runs WHERE account_id = 'account-a'")).rows[0].count, 1);

  // Keep counts identical but change one value in PostgreSQL: verification must roll back.
  await admin.query(`
    CREATE FUNCTION for_now.corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.content := 'corrupted'; RETURN NEW; END $$;
    CREATE TRIGGER corrupt_import BEFORE INSERT ON for_now.store_objects FOR EACH ROW EXECUTE FUNCTION for_now.corrupt_import()
  `);
  await assert.rejects(applyPostgresMigration(client, updated, { expectedTargetSha256: plan.sourceSha256 }), /content mismatch/);
  assert.deepEqual(await read(client, "account-a"), plan.snapshot);
  await admin.query("DROP TRIGGER corrupt_import ON for_now.store_objects");
  assert.equal((await admin.query("SELECT to_regclass('for_now.entry_blocks') AS projection")).rows[0].projection, null);
  assert.deepEqual(await read(client, "account-a"), plan.snapshot);
  await applyPostgresMigration(client, updated, { expectedTargetSha256: plan.sourceSha256 });
  assert.deepEqual(await read(client, "account-a"), updated.snapshot);
  assert.deepEqual(await read(client, "account-b"), otherPlan.snapshot);
  await admin.query("UPDATE for_now.store_objects SET content = 'tampered' WHERE account_id = 'account-a' AND kind = 'capture'");
  await assert.rejects(applyPostgresMigration(client, updated), /content mismatch/);
  await admin.query("UPDATE for_now.store_objects SET content = $1 WHERE account_id = 'account-a' AND kind = 'capture'", [updatedSource.captures[0].content]);
  const snapshot = (await admin.query("DELETE FROM for_now.account_snapshots WHERE account_id = 'account-a' RETURNING *")).rows;
  await assert.rejects(applyPostgresMigration(client, updated), /without a migration snapshot/);
  await admin.query("INSERT INTO for_now.account_snapshots SELECT * FROM jsonb_populate_recordset(NULL::for_now.account_snapshots, $1::jsonb)", [JSON.stringify(snapshot)]);

  // A disconnected transaction must not persist a partial replacement.
  const disconnected = await connect("migration_app");
  await disconnected.query("BEGIN");
  await disconnected.query("SELECT set_config('app.account_id', 'account-a', true)");
  await disconnected.query("UPDATE for_now.store_objects SET content = 'uncommitted'");
  await disconnected.end();
  assert.deepEqual(await read(client, "account-a"), updated.snapshot);
  assert.equal((await applyPostgresMigration(client, updated)).reused, true);

  // Rebuild without the evidence snapshot, then import the export to a fresh account.
  let exported;
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.account_id', 'account-a', true)");
    await client.query("DELETE FROM for_now.account_snapshots");
    exported = rebuildStoreObjects(await readPostgresStoreObjects(client, "account-a"));
  } finally {
    await client.query("ROLLBACK");
  }
  assert.deepEqual(exported, updated.snapshot);
  const restoredStore = structuredClone(exported);
  for (const collection of ["evidenceSources", "evidencePermissions", "perceptionEvents"]) {
    for (const item of restoredStore[collection]) item.accountId = "restored-account";
  }
  const restorePlan = buildPostgresMigrationPlan({
    accountId: "restored-account",
    store: restoredStore
  });
  await applyPostgresMigration(client, restorePlan);
  assert.deepEqual(await read(client, "restored-account"), restorePlan.snapshot);
  const bundleChecks = await runBundleChecks({ admin, client, connect, temporary });
  const aiMigrationChecks = await runAiMigrationPostgresChecks({ admin, client });
  const runtimeChecks = await runRuntimeChecks({ admin, connect, temporary, password, port, freePort });
  console.log(JSON.stringify({
    status: "passed", postgres: version, role: "non-owner / NOSUPERUSER / NOBYPASSRLS",
    counts: imported.counts,
    checks: ["schema repeat", "legacy metadata position/payload upgrade", "all-domain round-trip", "RLS all tables", "cross-account FK rejection",
      "idempotent concurrent imports", "snapshot replacement and missing-evidence guards", "corrupt repeat rejection", "mid-write rollback",
      "same-count corruption rollback", "legacy projections removed", "disconnect rollback", "export without snapshot and restore",
      ...bundleChecks, aiMigrationChecks, ...runtimeChecks]
  }, null, 2));
} finally {
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  if (started) await command("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "-t", "20", "stop"]);
  await fs.rm(temporary, { recursive: true, force: true });
}
