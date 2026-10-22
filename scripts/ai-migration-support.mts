/**
 * Shared account discovery and transaction helpers for offline AI audit migrations.
 * Established: 2026-10-18
 * Status: active
 * Boundary: credentials stay in environment variables; reports never include private prompt or response bodies.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type MigrationOptions = {
  apply: boolean;
  dataDir: string;
  accountId: string;
};

export type AccountDirectory = {
  accountId: string;
  directory: string;
};

export type QueryClient = {
  query(sql: string, values?: unknown[]): Promise<{
    rowCount: number | null;
    rows: Array<Record<string, unknown>>;
  }>;
};

export const MIGRATION_BATCH_SIZE = 200;

/**
 * Parses non-secret CLI options. DATABASE_URL is deliberately environment-only.
 * @since unreleased
 */
export function parseMigrationOptions(argv: string[], cwd = process.cwd()): MigrationOptions {
  const options: MigrationOptions = {
    apply: false,
    dataDir: path.resolve(cwd, "data"),
    accountId: ""
  };
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") explicitDryRun = true;
    else if (argument === "--data-dir" && argv[index + 1]) {
      options.dataDir = path.resolve(cwd, argv[++index]);
    } else if (argument === "--account-id" && argv[index + 1]) {
      options.accountId = argv[++index];
    } else {
      throw new Error(`Unknown or incomplete migration option: ${argument}`);
    }
  }
  if (options.apply && explicitDryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (options.accountId && !/^[\w-]+$/u.test(options.accountId)) {
    throw new Error("Migration account ID is invalid");
  }
  return options;
}

async function optionalJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid JSON migration source: ${file}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolves account directories from auth.json without scanning arbitrary paths.
 * @since unreleased
 */
export async function discoverAccountDirectories(
  dataDir: string,
  accountFilter = ""
): Promise<AccountDirectory[]> {
  const auth = await optionalJson(path.join(dataDir, "auth.json"));
  const users = Array.isArray(auth?.users) ? auth.users : [];
  const accounts = users.length
    ? users.map(value => {
        const user = value as { id?: unknown };
        const accountId = String(user.id || "");
        if (!/^[\w-]+$/u.test(accountId)) throw new Error("Unsafe account ID in auth migration source");
        return { accountId, directory: path.join(dataDir, "users", accountId) };
      })
    : [{ accountId: "local", directory: dataDir }];
  if (new Set(accounts.map(account => account.accountId)).size !== accounts.length) {
    throw new Error("Duplicate account ID in auth migration source");
  }
  const selected = accountFilter
    ? accounts.filter(account => account.accountId === accountFilter)
    : accounts;
  if (!selected.length) throw new Error(`Migration account not found: ${accountFilter}`);
  return selected;
}

export async function readOptionalObject(file: string): Promise<Record<string, unknown> | null> {
  return optionalJson(file);
}

export function migrationBatches<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += MIGRATION_BATCH_SIZE) {
    batches.push(values.slice(index, index + MIGRATION_BATCH_SIZE));
  }
  return batches;
}

/**
 * Refuses an apply run while the PostgreSQL-backed application owns its session lock.
 * @since unreleased
 */
export async function claimOfflineMigration(client: QueryClient): Promise<void> {
  const result = await client.query(
    "SELECT pg_try_advisory_lock(hashtextextended('for-now-application', 0)) AS acquired"
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error("Stop the PostgreSQL application before applying the AI migration");
  }
}

/**
 * Reads account NDJSON files in lexical day order and rejects malformed non-empty lines.
 * @since unreleased
 */
export async function readAuditLines(directory: string): Promise<Record<string, unknown>[]> {
  const logsDir = path.join(directory, "logs");
  let names: string[];
  try {
    names = (await fs.readdir(logsDir))
      .filter(name => /^ai-audit-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: Record<string, unknown>[] = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(logsDir, name), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid audit row at ${name}:${index + 1}`);
      }
      rows.push(value as Record<string, unknown>);
    }
  }
  return rows;
}

/**
 * Runs one account-scoped migration transaction under RLS.
 * @since unreleased
 */
export async function withAccountTransaction<T>(
  client: QueryClient,
  accountId: string,
  operation: () => Promise<T>
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
