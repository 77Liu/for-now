/**
 * Migrates legacy account AI usage documents into immutable PostgreSQL attempt rows.
 * Established: 2026-10-18
 * Status: active
 * Boundary: the source document is read-only; one attempt and one bounded aggregate row are written per call ID.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  recordAiUsageAttempt,
  type AiUsageAttempt
} from "../src/shared/persistence/ai-usage-repository.mjs";
import {
  claimOfflineMigration,
  discoverAccountDirectories,
  migrationBatches,
  parseMigrationOptions,
  readOptionalObject,
  withAccountTransaction,
  type QueryClient
} from "./ai-migration-support.mjs";

type SourceRow = Record<string, unknown>;

export type UsageMigrationConflict = {
  accountId: string;
  callId: string;
  code: string;
  sourceRows: number;
};

export type UsageMigrationPlan = {
  accountId: string;
  sourcePresent: boolean;
  sourceEntries: number;
  attempts: AiUsageAttempt[];
  conflicts: UsageMigrationConflict[];
};

type UsageWriteResult = "inserted" | "already_same" | "target_conflict";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const finiteNonNegative = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
const validIso = (value: unknown): value is string => (
  typeof value === "string" && Number.isFinite(Date.parse(value))
);
const errorCode = (error: unknown): string => text((error as { code?: unknown })?.code);
const sourceCallId = (row: SourceRow): string => text(row.callId || row.id).trim();

function migrationConflict(
  accountId: string,
  callId: string,
  code: string,
  sourceRows = 1
): UsageMigrationConflict {
  return { accountId, callId, code, sourceRows };
}

function normalizeUsageEntry(row: SourceRow): AiUsageAttempt {
  const callId = sourceCallId(row);
  const createdAt = row.createdAt;
  if (!callId || !validIso(createdAt)) {
    throw Object.assign(new Error("Legacy usage identity is incomplete"), {
      code: "SOURCE_USAGE_IDENTITY_INVALID"
    });
  }
  const provider = text(row.provider).trim() || "deepseek";
  const scene = text(row.scene).trim() || "unknown";
  const costCny = finiteNonNegative(row.costCny);
  const tokens = row.tokens && typeof row.tokens === "object" && !Array.isArray(row.tokens)
    ? row.tokens as SourceRow
    : {};
  return {
    ...structuredClone(row),
    id: text(row.id).trim() || callId,
    callId,
    provider,
    service: text(row.service).trim(),
    scene,
    model: text(row.model).trim(),
    status: text(row.status).trim() || "unknown",
    createdAt,
    usageKnown: row.usageKnown === true
      || row.usageKnown == null && Boolean(Number(tokens.input) || Number(tokens.output)),
    costKnown: row.costKnown === true || row.costKnown == null && costCny > 0,
    costCny
  };
}

/**
 * Validates and deduplicates one legacy usage document without mutating it.
 * @since unreleased
 */
export function planUsageMigration(
  accountId: string,
  document: SourceRow | null
): UsageMigrationPlan {
  if (!document) {
    return {
      accountId,
      sourcePresent: false,
      sourceEntries: 0,
      attempts: [],
      conflicts: []
    };
  }
  if (!Array.isArray(document.entries)) {
    return {
      accountId,
      sourcePresent: true,
      sourceEntries: 0,
      attempts: [],
      conflicts: [migrationConflict(accountId, "", "SOURCE_USAGE_ENTRIES_INVALID")]
    };
  }
  const entries = document.entries;
  const groups = new Map<string, AiUsageAttempt[]>();
  const conflicts: UsageMigrationConflict[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      conflicts.push(migrationConflict(accountId, "", "SOURCE_USAGE_ROW_INVALID"));
      continue;
    }
    const row = value as SourceRow;
    try {
      const normalized = normalizeUsageEntry(row);
      const group = groups.get(normalized.callId as string) || [];
      group.push(normalized);
      groups.set(normalized.callId as string, group);
    } catch (error) {
      conflicts.push(migrationConflict(
        accountId,
        sourceCallId(row),
        errorCode(error) || "SOURCE_USAGE_ROW_INVALID"
      ));
    }
  }
  const attempts: AiUsageAttempt[] = [];
  for (const [callId, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (!rows.every(row => isDeepStrictEqual(row, rows[0]))) {
      conflicts.push(migrationConflict(
        accountId,
        callId,
        "SOURCE_USAGE_ROWS_CONFLICT",
        rows.length
      ));
      continue;
    }
    attempts.push(rows[0]);
  }
  return {
    accountId,
    sourcePresent: true,
    sourceEntries: entries.length,
    attempts,
    conflicts
  };
}

async function writeUsageAttempt(
  client: QueryClient,
  accountId: string,
  entry: AiUsageAttempt
): Promise<UsageWriteResult> {
  try {
    return await recordAiUsageAttempt(client, accountId, entry);
  } catch (error) {
    if (errorCode(error) === "AI_USAGE_ATTEMPT_CONFLICT") return "target_conflict";
    throw error;
  }
}

export async function applyUsageMigration(
  client: QueryClient,
  plan: UsageMigrationPlan
): Promise<Record<UsageWriteResult, number>> {
  const summary: Record<UsageWriteResult, number> = {
    inserted: 0,
    already_same: 0,
    target_conflict: 0
  };
  for (const batch of migrationBatches(plan.attempts)) {
    await withAccountTransaction(client, plan.accountId, async () => {
      for (const entry of batch) {
        summary[await writeUsageAttempt(client, plan.accountId, entry)] += 1;
      }
    });
  }
  return summary;
}

function publicPlan(plan: UsageMigrationPlan) {
  return {
    accountId: plan.accountId,
    sourcePresent: plan.sourcePresent,
    sourceEntries: plan.sourceEntries,
    attempts: plan.attempts.length,
    conflicts: plan.conflicts
  };
}

async function loadPlans(dataDir: string, accountId: string): Promise<UsageMigrationPlan[]> {
  const accounts = await discoverAccountDirectories(dataDir, accountId);
  return Promise.all(accounts.map(async account => planUsageMigration(
    account.accountId,
    await readOptionalObject(path.join(account.directory, "ai-usage.json"))
  )));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run migrate:ai-usage -- [--dry-run] [--data-dir PATH] [--account-id ID]");
    console.log("       npm run migrate:ai-usage -- --apply [--data-dir PATH] [--account-id ID]");
    console.log("Apply reads DATABASE_URL from the environment and requires the PostgreSQL application to be stopped. Dry-run is the default.");
    return;
  }
  const options = parseMigrationOptions(process.argv.slice(2));
  if (!options.apply) {
    const plans = await loadPlans(options.dataDir, options.accountId);
    console.log(JSON.stringify({ mode: "dry-run", accounts: plans.map(publicPlan) }, null, 2));
    if (plans.some(plan => plan.conflicts.length)) process.exitCode = 2;
  } else {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for --apply");
    const { Client } = createRequire(import.meta.url)("pg") as {
      Client: new (options: { connectionString: string }) => QueryClient & {
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await claimOfflineMigration(client);
      const plans = await loadPlans(options.dataDir, options.accountId);
      const reports = plans.map(publicPlan);
      const applied = [];
      for (const plan of plans) {
        applied.push({ accountId: plan.accountId, ...await applyUsageMigration(client, plan) });
      }
      console.log(JSON.stringify({ mode: "apply", accounts: reports, applied }, null, 2));
      if (applied.some(result => result.target_conflict)) process.exitCode = 2;
      if (plans.some(plan => plan.conflicts.length)) process.exitCode = 2;
    } finally {
      await client.end();
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
