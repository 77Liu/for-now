import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { runAiBudgetPostgresChecks } from "./ai-budget-postgres-checks.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const binaryDir = process.env.PG_TEST_BIN
  || path.join(ROOT, "data/pg-integration-tools/node_modules/@embedded-postgres", `${process.platform}-${process.arch}`, "native/bin");
const binaryEnvironment = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
const libraryDir = path.resolve(binaryDir, "../lib");
if (process.platform === "darwin" && await fs.access(libraryDir).then(() => true, () => false)) {
  binaryEnvironment.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
}
for (const name of ["postgres", "pg_ctl", "initdb"]) {
  await fs.access(path.join(binaryDir, name)).catch(() => {
    throw new Error("Real PostgreSQL binaries are required. Set PG_TEST_BIN to their bin directory.");
  });
}

const run = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ai-budget-pg-"));
const cluster = path.join(temporary, "cluster");
const passwordFile = path.join(temporary, "password");
const password = crypto.randomBytes(24).toString("hex");
const clients = [];
let started = false;
let runtime;
let peer;
const command = (name, args) => run(path.join(binaryDir, name), args, {
  timeout: 30_000,
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

  const connect = async (user, database = "postgres") => {
    const client = new pg.Client({
      host: "127.0.0.1",
      port,
      database,
      user,
      password
    });
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
  assert.deepEqual(
    (await admin.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'for_now' AND c.relname = 'site_ai_budget'
    `)).rows[0],
    { relrowsecurity: false, relforcerowsecurity: false }
  );
  await admin.query("UPDATE for_now.site_ai_budget SET document = '{}'::jsonb WHERE id = true");
  await admin.query(`CREATE ROLE budget_data LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE budget_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE budget_writer LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`
    GRANT USAGE ON SCHEMA for_now TO budget_data;
    GRANT USAGE ON SCHEMA for_now_auth TO budget_auth;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now_auth TO budget_auth;
    GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO budget_auth;
    GRANT USAGE ON SCHEMA for_now TO budget_writer;
    GRANT SELECT, UPDATE ON TABLE for_now.site_ai_budget TO budget_writer
  `);
  const url = role => `postgresql://${role}:${password}@127.0.0.1:${port}/postgres`;
  const runtimeOptions = {
    connectionString: url("budget_data"),
    authConnectionString: url("budget_auth"),
    budgetConnectionString: url("budget_writer"),
    getAccountId: () => "unused-account"
  };
  runtime = await createPostgresRuntime(runtimeOptions);
  peer = await createPostgresRuntime(runtimeOptions);
  const checks = await runAiBudgetPostgresChecks({
    admin,
    connect,
    database: "postgres",
    dataRole: "budget_data",
    authRole: "budget_auth",
    budgetRole: "budget_writer",
    runtime,
    peer,
    runtimeOptions
  });
  console.log(`AI budget PostgreSQL persistence checks passed: ${checks.join(", ")}.`);
} finally {
  await Promise.all([runtime?.close(), peer?.close()].filter(Boolean));
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  if (started) {
    await command("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "-t", "20", "stop"]);
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
