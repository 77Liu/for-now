import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  createPostgresRuntime,
  initializePostgresSchema
} from "../src/shared/persistence/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKER_FLAG = "--worker";
const emptyStore = () => ({
  version: 15,
  thoughts: [],
  captures: [],
  journals: [],
  journalDraft: null,
  trash: []
});
const cleanEnvironment = source => Object.fromEntries(Object.entries(source).filter(([key]) => (
  !["DATABASE_URL", "AUTH_DATABASE_URL", "APP_URL", "UPSTREAM_ORIGIN"].includes(key)
  && !/^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/.test(key)
)));

if (process.argv[2] === WORKER_FLAG) {
  const runtime = await createPostgresRuntime({
    connectionString: process.env.TEST_DATABASE_URL,
    authConnectionString: process.env.TEST_AUTH_DATABASE_URL,
    getAccountId: () => process.env.TEST_ACCOUNT_ID
  });
  try {
    const repository = runtime.createStoreRepository({ normalize: value => value, emptyDocument: emptyStore() });
    const response = await repository.executeIdempotent({
      scope: "captures.create",
      key: "cross-process-key",
      requestHash: "cross-process-request"
    }, async store => {
      await new Promise(resolve => setTimeout(resolve, 100));
      const body = { id: `created-by-${process.pid}`, content: "single execution" };
      store.captures.push(body);
      return { statusCode: 201, body };
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    await runtime.close();
  }
  process.exit(0);
}

const run = promisify(execFile);
const binaryDir = process.env.PG_TEST_BIN
  || path.join(ROOT, "data/pg-integration-tools/node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
const binaryEnvironment = { ...cleanEnvironment(process.env), LC_ALL: "C", LANG: "C", TZ: "UTC" };
const libraryDir = path.resolve(binaryDir, "../lib");
if (process.platform === "darwin" && await fs.access(libraryDir).then(() => true, () => false)) {
  binaryEnvironment.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
}
for (const name of ["postgres", "pg_ctl", "initdb"]) {
  await fs.access(path.join(binaryDir, name)).catch(() => {
    throw new Error("Real PostgreSQL binaries are required. Set PG_TEST_BIN to their bin directory.");
  });
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ledger-pg-"));
const cluster = path.join(temporary, "cluster");
const passwordFile = path.join(temporary, "password");
const password = crypto.randomBytes(24).toString("hex");
const clients = [];
let started = false;
const command = (name, args) => run(path.join(binaryDir, name), args, {
  timeout: 30000,
  maxBuffer: 1024 * 1024,
  env: binaryEnvironment
});
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const childResponse = environment => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [import.meta.filename, WORKER_FLAG], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  child.once("error", reject);
  child.once("exit", code => {
    if (code !== 0) reject(new Error(`ledger worker failed (${code}): ${stderr}`));
    else {
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`ledger worker returned invalid JSON: ${stdout}`)); }
    }
  });
});

try {
  const port = await freePort();
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  await command("initdb", ["-D", cluster, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordFile, "--locale=C", "--encoding=UTF8"]);
  await fs.appendFile(path.join(cluster, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  await command("pg_ctl", ["-D", cluster, "-l", path.join(temporary, "postgres.log"), "-w", "-t", "20", "start"]);
  started = true;
  const connect = async user => {
    const client = new pg.Client({ host: "127.0.0.1", port, database: "postgres", user, password });
    clients.push(client);
    await client.connect();
    return client;
  };
  const admin = await connect("postgres");
  await initializePostgresSchema(admin);
  await admin.query(`CREATE ROLE ledger_data LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE ledger_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`
    GRANT USAGE ON SCHEMA for_now TO ledger_data;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now TO ledger_data;
    REVOKE INSERT, DELETE ON TABLE for_now.site_ai_budget FROM ledger_data;
    GRANT USAGE ON SCHEMA for_now_auth TO ledger_auth;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now_auth TO ledger_auth;
    GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO ledger_auth
  `);
  const url = role => `postgresql://${role}:${password}@127.0.0.1:${port}/postgres`;
  const runtimeOptions = {
    connectionString: url("ledger_data"),
    authConnectionString: url("ledger_auth"),
    getAccountId: () => "ledger-account"
  };
  let runtime = await createPostgresRuntime(runtimeOptions);
  let repository = runtime.createStoreRepository({ normalize: value => value, emptyDocument: emptyStore() });
  await repository.initialize({ allowCreate: true });
  await runtime.close();

  const workerEnvironment = {
    ...cleanEnvironment(process.env),
    NODE_ENV: "test",
    TEST_DATABASE_URL: url("ledger_data"),
    TEST_AUTH_DATABASE_URL: url("ledger_auth"),
    TEST_ACCOUNT_ID: "ledger-account"
  };
  const responses = await Promise.all([childResponse(workerEnvironment), childResponse(workerEnvironment)]);
  assert.deepEqual(responses[0], responses[1]);

  runtime = await createPostgresRuntime(runtimeOptions);
  repository = runtime.createStoreRepository({ normalize: value => value, emptyDocument: emptyStore() });
  assert.equal((await repository.read()).captures.length, 1);
  const replay = await repository.executeIdempotent({
    scope: "captures.create",
    key: "cross-process-key",
    requestHash: "cross-process-request"
  }, () => {
    throw new Error("restart must replay without executing");
  });
  assert.deepEqual(replay, responses[0]);
  await assert.rejects(repository.executeIdempotent({
    scope: "captures.create",
    key: "cross-process-key",
    requestHash: "different-request"
  }, () => null), error => error.code === "IDEMPOTENCY_KEY_REUSED" && error.statusCode === 409);

  await repository.update(store => {
    const [capture] = store.captures.splice(0, 1);
    store.trash.push({
      id: "capture-trash",
      type: "capture",
      resourceId: capture.id,
      deletedAt: "2026-09-29T04:00:00.000Z",
      purgeAfter: "2026-10-29T04:00:00.000Z",
      location: { kind: "collection", collection: "captures", index: 0 },
      payload: capture
    });
  });
  await repository.update(store => {
    store.trash = [];
  });
  assert.equal((await repository.readPersistenceMetadata()).lifecycles.find(item => item.resourceType === "capture").state, "purged");
  await runtime.close();

  runtime = await createPostgresRuntime(runtimeOptions);
  repository = runtime.createStoreRepository({ normalize: value => value, emptyDocument: emptyStore() });
  assert.deepEqual(await repository.executeIdempotent({
    scope: "captures.create",
    key: "cross-process-key",
    requestHash: "cross-process-request"
  }, () => {
    throw new Error("permanent purge must not allow duplicate execution");
  }), responses[0]);
  assert.equal((await repository.read()).captures.length, 0);
  const counts = (await admin.query(`
    SELECT
      (SELECT count(*)::int FROM for_now.idempotency_ledger WHERE account_id = 'ledger-account') AS idempotency,
      (SELECT count(*)::int FROM for_now.resource_lifecycle WHERE account_id = 'ledger-account' AND state = 'purged') AS purged
  `)).rows[0];
  assert.deepEqual(counts, { idempotency: 1, purged: 1 });
  await runtime.close();
  console.log("PostgreSQL lifecycle/idempotency checks passed: exact replay, conflict, permanent purge, restart and cross-process serialization.");
} finally {
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  if (started) await command("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "-t", "20", "stop"]);
  await fs.rm(temporary, { recursive: true, force: true });
}
