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
import { createEmptyStore } from "../src/app/index.mjs";
import {
  clearStoreObjects,
  initializePostgresSchema,
  mapStoreObjects,
  readPostgresStoreObjects,
  rebuildStoreObjects,
  writeStoreObjects
} from "../src/shared/persistence/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaryDir = process.env.PG_TEST_BIN
  || path.join(ROOT, "data/pg-integration-tools/node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
const binaryEnv = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
const libraryDir = path.resolve(binaryDir, "../lib");
if (process.platform === "darwin" && await fs.access(libraryDir).then(() => true, () => false)) {
  binaryEnv.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
}
for (const name of ["postgres", "pg_ctl", "initdb"]) {
  await fs.access(path.join(binaryDir, name)).catch(() => {
    throw new Error("Real PostgreSQL binaries are required. Set PG_TEST_BIN to their bin directory.");
  });
}

const run = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-compression-rollback-pg-"));
const cluster = path.join(temporary, "cluster");
const passwordFile = path.join(temporary, "password");
const password = crypto.randomBytes(24).toString("hex");
const clients = [];
let started = false;
const command = (name, args) => run(path.join(binaryDir, name), args, {
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
  env: binaryEnv
});
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

async function replaceAccountMapping(client, accountId, mapping) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    await clearStoreObjects(client, accountId);
    await writeStoreObjects(client, mapping);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// Previous mapping versions treated unknown root fields as JSON value fields.
// This adapter models that behavior while leaving every other field on the
// current mapper, so the test exercises actual PostgreSQL row serialization.
function mapWithPreviousFieldRegistry(accountId, store) {
  const { recordCompressions, historicalUserSupplement, ...knownFields } = structuredClone(store);
  const mapping = mapStoreObjects(accountId, knownFields);
  mapping.fields.push(
    { accountId, field: "recordCompressions", shape: "value", payload: recordCompressions },
    { accountId, field: "historicalUserSupplement", shape: "value", payload: historicalUserSupplement }
  );
  return mapping;
}

try {
  const port = await freePort();
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  await command("initdb", [
    "-D", cluster,
    "-U", "postgres",
    "-A", "scram-sha-256",
    "--pwfile", passwordFile,
    "--locale=C",
    "--encoding=UTF8"
  ]);
  await fs.appendFile(
    path.join(cluster, "postgresql.conf"),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`
  );
  await command("pg_ctl", [
    "-D", cluster,
    "-l", path.join(temporary, "postgres.log"),
    "-w",
    "-t", "20",
    "start"
  ]);
  started = true;

  const client = new pg.Client({
    host: "127.0.0.1",
    port,
    database: "postgres",
    user: "postgres",
    password
  });
  clients.push(client);
  await client.connect();
  await initializePostgresSchema(client);

  const accountId = "compression-rollback-fixture";
  await client.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [accountId]);
  const expectedCompression = {
    id: "compression-fixture-v1",
    status: "ready",
    schemaVersion: "record-compression-output.v1",
    promptVersion: "daily-record-compression.v1",
    localDate: "2026-10-09",
    timezone: "Asia/Shanghai",
    sourceManifestHash: "a".repeat(64),
    sourceManifest: [{ sourceId: "source-1", sourceHash: "b".repeat(64), origin: "user_original" }],
    daily: { observations: [{ text: "fixture note", nature: "user_subjective", sourceIds: ["source-1"] }] },
    revision: 1
  };
  const expectedSupplement = {
    schemaVersion: "historical-user-supplement.v1",
    records: [{ exactQuote: "fixture stable wording", source: { sourceId: "source-1", sourceHash: "b".repeat(64) } }],
    coverage: { complete: false, nextBatchIndex: 2 },
    tokenUsage: { estimated: true, scope: "model_output", tokens: 18 }
  };
  const store = createEmptyStore();
  store.version = 18;
  store._persistence = { version: 1, lifecycles: [], idempotency: [] };
  store.checkins.push({ id: "unrelated-checkin", occurredOn: "2026-10-09", mood: "steady" });
  store.recordCompressions = [structuredClone(expectedCompression)];
  store.historicalUserSupplement = structuredClone(expectedSupplement);

  const readStore = async () => rebuildStoreObjects(await readPostgresStoreObjects(client, accountId));
  await replaceAccountMapping(client, accountId, mapStoreObjects(accountId, store));
  assert.deepEqual((await readStore()).recordCompressions, [expectedCompression]);
  assert.deepEqual((await readStore()).historicalUserSupplement, expectedSupplement);

  const previousVersionRead = await readStore();
  assert.deepEqual(previousVersionRead.recordCompressions, [expectedCompression]);
  assert.deepEqual(previousVersionRead.historicalUserSupplement, expectedSupplement);
  previousVersionRead.checkins[0].mood = "updated by previous release";
  previousVersionRead.checkins.push({ id: "unrelated-checkin-2", occurredOn: "2026-10-10", mood: "calm" });
  await replaceAccountMapping(
    client,
    accountId,
    mapWithPreviousFieldRegistry(accountId, previousVersionRead)
  );
  const afterPreviousVersionWrite = await readStore();
  assert.deepEqual(afterPreviousVersionWrite.recordCompressions, [expectedCompression]);
  assert.deepEqual(afterPreviousVersionWrite.historicalUserSupplement, expectedSupplement);
  assert.deepEqual(afterPreviousVersionWrite.checkins.map(item => item.mood), [
    "updated by previous release",
    "calm"
  ]);

  await replaceAccountMapping(
    client,
    accountId,
    mapStoreObjects(accountId, afterPreviousVersionWrite)
  );
  const afterCurrentVersionRewrite = await readStore();
  assert.deepEqual(afterCurrentVersionRewrite.recordCompressions, [expectedCompression]);
  assert.deepEqual(afterCurrentVersionRewrite.historicalUserSupplement, expectedSupplement);
  assert.deepEqual(afterCurrentVersionRewrite.checkins, afterPreviousVersionWrite.checkins);
  console.log("PostgreSQL compression rollback mapping regression passed: current write/read, previous-version unknown-field rewrite, and current rewrite.");
} finally {
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  if (started) {
    await command("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "-t", "20", "stop"]);
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
