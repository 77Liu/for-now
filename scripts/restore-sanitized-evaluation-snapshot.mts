/**
 * 将有界脱敏导出恢复到回环 PostgreSQL，用于真实账户模式评估。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：默认 dry-run；凭据只来自环境变量，且绝不进入输出。
 */

import crypto from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type QueryResult = { rowCount: number | null; rows: JsonObject[] };
type QueryClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
};

type SnapshotManifest = {
  schemaVersion: 1;
  sanitized: true;
  sourceVersion: string;
  accountIds: string[];
};

export type EvaluationSnapshotPlan = Readonly<{
  snapshotDir: string;
  sourceVersion: string;
  sourceSha256: string;
  contentSha256: string;
  accountIds: string[];
  targetAccountId: string;
  accountCount: number;
}>;

type Options = {
  snapshotDir: string;
  manifestFile: string;
  apply: boolean;
  initSchema: boolean;
  maxAccounts: number;
  expectedTargetSha256: string;
};

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  Client: new (options: { connectionString: string }) => QueryClient;
};
const persistence = await import(pathToFileURL(
  path.resolve(process.cwd(), "src/shared/persistence/index.mjs")
).href) as {
  applyPostgresBundle(
    client: QueryClient,
    bundle: JsonObject,
    options: { expectedTargetSha256: string }
  ): Promise<{ sourceSha256: string; contentSha256: string }>;
  discoverJsonBundle(directory: string): Promise<JsonObject>;
  initializePostgresSchema(client: QueryClient): Promise<void>;
};
const {
  applyPostgresBundle,
  discoverJsonBundle,
  initializePostgresSchema
} = persistence;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--apply", "--init-schema"].includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (![
      "--snapshot-dir", "--manifest", "--max-accounts",
      "--expected-target-sha256"
    ].includes(argument) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Invalid evaluation snapshot option");
    }
    values.set(argument, argv[++index]);
  }
  const snapshotDir = path.resolve(values.get("--snapshot-dir") || "");
  if (!values.get("--snapshot-dir")) throw new Error("--snapshot-dir is required");
  const maxAccounts = Number(values.get("--max-accounts") || 25);
  if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 100) {
    throw new Error("--max-accounts must be between 1 and 100");
  }
  return {
    snapshotDir,
    manifestFile: path.resolve(
      values.get("--manifest") || path.join(snapshotDir, "evaluation-manifest.json")
    ),
    apply: flags.has("--apply"),
    initSchema: flags.has("--init-schema"),
    maxAccounts,
    expectedTargetSha256: values.get("--expected-target-sha256") || ""
  };
}

function loopbackDatabaseUrl(value: string, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be a PostgreSQL URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !LOOPBACK.has(url.hostname.replace(/^\[|\]$/gu, "").toLowerCase())) {
    throw new Error(`${name} must target loopback PostgreSQL`);
  }
  return value;
}

async function readManifest(file: string): Promise<SnapshotManifest> {
  const value = JSON.parse(await fs.readFile(file, "utf8")) as JsonObject;
  if (value.schemaVersion !== 1 || value.sanitized !== true
    || typeof value.sourceVersion !== "string" || !value.sourceVersion
    || !Array.isArray(value.accountIds)
    || value.accountIds.some(id => typeof id !== "string" || !/^[\w-]+$/u.test(id))) {
    throw new Error("Evaluation snapshot manifest is invalid");
  }
  const accountIds = value.accountIds as string[];
  if (!accountIds.length || new Set(accountIds).size !== accountIds.length) {
    throw new Error("Evaluation snapshot account IDs are missing or duplicated");
  }
  return {
    schemaVersion: 1,
    sanitized: true,
    sourceVersion: value.sourceVersion,
    accountIds
  };
}

/**
 * Validates sanitization declarations and bounds before any database connection.
 * @since unreleased
 */
export async function planEvaluationSnapshot(
  options: Pick<Options, "snapshotDir" | "manifestFile" | "maxAccounts">,
  targetAccountId: string
): Promise<{ plan: EvaluationSnapshotPlan; bundle: JsonObject }> {
  const [manifest, bundle] = await Promise.all([
    readManifest(options.manifestFile),
    discoverJsonBundle(options.snapshotDir)
  ]);
  const bundleRecord = bundle as JsonObject;
  const auth = bundleRecord.auth as { users?: JsonObject[]; sessions?: JsonObject[] } | null;
  const accountIds = (bundleRecord.accounts as Array<{ plan: { accountId: string } }>)
    .map(account => account.plan.accountId)
    .sort();
  const declared = [...manifest.accountIds].sort();
  const authIds = (auth?.users || []).map(user => String(user.id || "")).sort();
  if (accountIds.length > options.maxAccounts
    || JSON.stringify(accountIds) !== JSON.stringify(declared)
    || JSON.stringify(accountIds) !== JSON.stringify(authIds)) {
    throw new Error("Evaluation snapshot account set exceeds or differs from its manifest");
  }
  if ((auth?.sessions || []).length) {
    throw new Error("Evaluation snapshot must not contain production sessions");
  }
  if (!accountIds.includes(targetAccountId)) {
    throw new Error("EVALUATION_ACCOUNT_ID is not present in the snapshot");
  }
  return {
    bundle: bundleRecord,
    plan: Object.freeze({
      snapshotDir: options.snapshotDir,
      sourceVersion: manifest.sourceVersion,
      sourceSha256: String(bundleRecord.sourceSha256 || ""),
      contentSha256: String(bundleRecord.contentSha256 || ""),
      accountIds,
      targetAccountId,
      accountCount: accountIds.length
    })
  };
}

async function passwordDigest(password: string): Promise<string> {
  if (password.length < 8 || password.length > 128
    || !/[A-Za-z]/u.test(password) || !/\d/u.test(password)) {
    throw new Error("EVALUATION_PASSWORD must satisfy the application password policy");
  }
  const salt = crypto.randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, value) => (
      error ? reject(error) : resolve(value)
    ));
  });
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function installTestIdentity(
  client: QueryClient,
  accountId: string,
  username: string,
  password: string
): Promise<void> {
  const usernameKey = username.toLocaleLowerCase();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new Error("EVALUATION_USERNAME is invalid");
  }
  const digest = await passwordDigest(password);
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))"
    );
    const result = await client.query(`
      UPDATE for_now_auth.users
      SET username=$2, username_key=$3, password_hash=$4, role='owner',
          session_version=session_version+1, updated_at=now()
      WHERE id=$1
      RETURNING id
    `, [accountId, username, usernameKey, digest]);
    if (result.rowCount !== 1) throw new Error("Evaluation target identity is missing");
    await client.query("DELETE FROM for_now_auth.sessions");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function execute(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (argv.includes("--help")) {
    console.log("Usage: restore-sanitized-evaluation-snapshot --snapshot-dir PATH [--manifest FILE] [--max-accounts 25] [--init-schema] [--apply] [--expected-target-sha256 HASH]");
    console.log("Apply requires loopback DATABASE_URL plus EVALUATION_ACCOUNT_ID, EVALUATION_USERNAME and EVALUATION_PASSWORD; schema initialization additionally requires loopback PG_SCHEMA_DATABASE_URL.");
    return;
  }
  const options = parseOptions(argv);
  const targetAccountId = String(env.EVALUATION_ACCOUNT_ID || "");
  if (!targetAccountId) throw new Error("EVALUATION_ACCOUNT_ID is required");
  const { plan, bundle } = await planEvaluationSnapshot(options, targetAccountId);
  if (!options.apply) {
    console.log(JSON.stringify({ mode: "dry-run", ...plan }, null, 2));
    return;
  }
  const databaseUrl = loopbackDatabaseUrl(String(env.DATABASE_URL || ""), "DATABASE_URL");
  if (options.initSchema) {
    const schemaUrl = loopbackDatabaseUrl(
      String(env.PG_SCHEMA_DATABASE_URL || ""),
      "PG_SCHEMA_DATABASE_URL"
    );
    const schemaClient = new Client({ connectionString: schemaUrl });
    await schemaClient.connect();
    try { await initializePostgresSchema(schemaClient); }
    finally { await schemaClient.end(); }
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await applyPostgresBundle(client, bundle, {
      expectedTargetSha256: options.expectedTargetSha256
    });
    await installTestIdentity(
      client,
      targetAccountId,
      String(env.EVALUATION_USERNAME || ""),
      String(env.EVALUATION_PASSWORD || "")
    );
    console.log(JSON.stringify({
      mode: "applied",
      sourceVersion: plan.sourceVersion,
      accountCount: plan.accountCount,
      targetAccountId,
      sourceSha256: result.sourceSha256,
      contentSha256: result.contentSha256
    }, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  execute(process.argv.slice(2), process.env).catch(() => {
    console.error("Evaluation snapshot restore failed; verify sanitization, bounds, loopback database roles, target identity and source integrity.");
    process.exitCode = 1;
  });
}
