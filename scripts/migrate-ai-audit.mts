/**
 * Migrates legacy private AI audit projections into one PostgreSQL row per provider attempt.
 * Established: 2026-10-18
 * Status: active
 * Boundary: source bodies stay in memory/DB; CLI reports contain identifiers and classifications only.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  beginAiAuditAttempt,
  finishAiAuditAttempt,
  type AiAuditStartedRow,
  type AiAuditTerminalRow
} from "../src/shared/persistence/ai-audit-repository.mjs";
import { resolveInvocationContract } from "../src/modules/ai/invocation-contracts.mjs";
import {
  claimOfflineMigration,
  discoverAccountDirectories,
  migrationBatches,
  parseMigrationOptions,
  readAuditLines,
  withAccountTransaction,
  type QueryClient
} from "./ai-migration-support.mjs";

type SourceRow = Record<string, unknown>;
type TerminalStatus = AiAuditTerminalRow["status"];

export type AuditMigrationConflict = {
  accountId: string;
  callId: string;
  code: string;
  sourceRows: number;
  statuses: string[];
};

export type PlannedAuditAttempt = {
  callId: string;
  started: AiAuditStartedRow;
  terminal: AiAuditTerminalRow;
  sourceRows: number;
  inferredInterrupted: boolean;
};

export type AuditMigrationPlan = {
  accountId: string;
  sourceRows: number;
  ignoredRows: number;
  attempts: PlannedAuditAttempt[];
  conflicts: AuditMigrationConflict[];
};

type AuditWriteResult = "inserted" | "completed_existing" | "already_same" | "target_conflict";

const TERMINAL_STATUSES = new Set<TerminalStatus>([
  "success", "failed", "timeout", "cancelled", "interrupted"
]);
const object = (value: unknown): SourceRow => (
  value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as SourceRow)
    : {}
);
const optionalObject = (value: unknown): SourceRow | null => (
  value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as SourceRow)
    : null
);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const positiveInteger = (value: unknown, fallback = 1): number => {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};
const validIso = (value: unknown): value is string => (
  typeof value === "string" && Number.isFinite(Date.parse(value))
);
const errorCode = (error: unknown): string => text((error as { code?: unknown })?.code);

function conflict(
  accountId: string,
  callId: string,
  code: string,
  rows: readonly SourceRow[]
): AuditMigrationConflict {
  return {
    accountId,
    callId,
    code,
    sourceRows: rows.length,
    statuses: [...new Set(rows.map(row => text(row.status) || "unknown"))].sort()
  };
}

function equivalentCandidate(rows: readonly SourceRow[]): SourceRow | null {
  const first = rows[0];
  return first && rows.every(row => isDeepStrictEqual(row, first)) ? first : null;
}

function requestPayload(source: SourceRow, started: SourceRow | null): SourceRow {
  const initial = object(started?.request);
  const terminal = object(source.request);
  const schemaVersion = Math.max(
    positiveInteger(started?.schemaVersion),
    positiveInteger(source.schemaVersion)
  );
  const request = schemaVersion >= 4 && started
    ? initial
    : { ...initial, ...terminal };
  if (text(source.provider) === "deepseek") return request;
  return {
    systemPrompt: { notApplicable: true },
    userPrompt: { notApplicable: true },
    history: [],
    parameters: {},
    ...request
  };
}

function responsePayload(source: SourceRow): SourceRow {
  const response = object(source.response);
  if (text(source.provider) === "deepseek") return response;
  return {
    content: null,
    reasoningContent: null,
    model: null,
    finishReason: null,
    ...response
  };
}

function buildAttempt(
  callId: string,
  started: SourceRow | null,
  terminal: SourceRow | null,
  interruptedAt: string
): PlannedAuditAttempt {
  const source = { ...(started || {}), ...(terminal || {}) };
  const provider = text(source.provider);
  const scene = text(source.scene);
  const startedAt = source.startedAt;
  if (!provider || !scene || !validIso(startedAt)) {
    throw Object.assign(new Error("Legacy audit identity is incomplete"), {
      code: "SOURCE_IDENTITY_INVALID"
    });
  }
  const contractSource = object(source.invocationContract);
  const contract = resolveInvocationContract(
    scene,
    contractSource.triggerType ?? source.triggerType
  );
  const attempt = positiveInteger(source.attempt);
  const maxAttempts = Math.max(attempt, positiveInteger(source.maxAttempts, attempt));
  const status = terminal ? text(terminal.status) as TerminalStatus : "interrupted";
  const completedAt = terminal?.completedAt ?? interruptedAt;
  if (!TERMINAL_STATUSES.has(status) || !validIso(completedAt)) {
    throw Object.assign(new Error("Legacy audit terminal state is invalid"), {
      code: "SOURCE_TERMINAL_INVALID"
    });
  }
  return {
    callId,
    sourceRows: Number(Boolean(started)) + Number(Boolean(terminal)),
    inferredInterrupted: !terminal,
    started: {
      callId,
      callGroupId: text(source.callGroupId) || callId,
      traceId: text(source.traceId),
      provider,
      service: text(source.service) || (provider === "deepseek" ? "chat-completions" : "unknown"),
      scene,
      action: text(source.action) || (provider === "deepseek" ? "complete" : "unknown"),
      ...contract,
      attempt,
      maxAttempts,
      startedAt,
      requestPayload: requestPayload(source, started),
      truncation: object(source.truncation),
      schemaVersion: 4
    },
    terminal: {
      status,
      completedAt,
      dispatchState: terminal?.dispatchState === "not_invoked" ? "not_invoked" : "invoked",
      responsePayload: terminal ? responsePayload(source) : {},
      errorPayload: terminal ? optionalObject(source.error) : null,
      usagePayload: terminal ? optionalObject(source.usage) : null
    }
  };
}

function planGroup(
  accountId: string,
  callId: string,
  rows: readonly SourceRow[],
  interruptedAt: string
): { attempt?: PlannedAuditAttempt; conflict?: AuditMigrationConflict } {
  const startedRows = rows.filter(row => row.status === "started");
  const terminalRows = rows.filter(row => TERMINAL_STATUSES.has(text(row.status) as TerminalStatus));
  if (startedRows.length + terminalRows.length !== rows.length || !terminalRows.length && !startedRows.length) {
    return { conflict: conflict(accountId, callId, "SOURCE_STATUS_INVALID", rows) };
  }
  const started = startedRows.length ? equivalentCandidate(startedRows) : null;
  const terminal = terminalRows.length ? equivalentCandidate(terminalRows) : null;
  if (startedRows.length && !started || terminalRows.length && !terminal) {
    return { conflict: conflict(accountId, callId, "SOURCE_ROWS_CONFLICT", rows) };
  }
  try {
    const attempt = buildAttempt(callId, started, terminal, interruptedAt);
    attempt.sourceRows = rows.length;
    return { attempt };
  } catch (error) {
    return {
      conflict: conflict(accountId, callId, errorCode(error) || "SOURCE_ROW_INVALID", rows)
    };
  }
}

/**
 * Merges legacy started/terminal projections without exposing their private bodies in conflicts.
 * @since unreleased
 */
export function planAuditMigration(
  accountId: string,
  sourceRows: readonly SourceRow[],
  interruptedAt: string
): AuditMigrationPlan {
  if (!validIso(interruptedAt)) throw new TypeError("Audit migration clock is invalid");
  const groups = new Map<string, SourceRow[]>();
  const conflicts: AuditMigrationConflict[] = [];
  let ignoredRows = 0;
  for (const row of sourceRows) {
    if (row.type !== "ai.invocation") {
      ignoredRows += 1;
      continue;
    }
    const callId = text(row.callId || row.id);
    if (!callId) {
      conflicts.push(conflict(accountId, "", "SOURCE_CALL_ID_MISSING", [row]));
      continue;
    }
    const group = groups.get(callId) || [];
    group.push(row);
    groups.set(callId, group);
  }
  const attempts: PlannedAuditAttempt[] = [];
  for (const [callId, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const planned = planGroup(accountId, callId, rows, interruptedAt);
    if (planned.attempt) attempts.push(planned.attempt);
    if (planned.conflict) conflicts.push(planned.conflict);
  }
  return { accountId, sourceRows: sourceRows.length, ignoredRows, attempts, conflicts };
}

function startedValues(accountId: string, row: AiAuditStartedRow): unknown[] {
  return [
    accountId, row.callId, row.callGroupId, row.traceId, row.provider, row.service,
    row.scene, row.action, row.triggerType, row.resultAudience, row.reasoningVisibility,
    row.persistenceMode, row.contractSchemaVersion, row.attempt, row.maxAttempts,
    row.startedAt, JSON.stringify(row.requestPayload), JSON.stringify(row.truncation),
    row.schemaVersion
  ];
}

async function startedMatches(
  client: QueryClient,
  accountId: string,
  row: AiAuditStartedRow
): Promise<boolean> {
  const result = await client.query(`
    SELECT (
      call_group_id=$3 AND trace_id=$4 AND provider=$5 AND service=$6 AND scene=$7
      AND action=$8 AND trigger_type=$9 AND result_audience=$10
      AND reasoning_visibility=$11 AND persistence_mode=$12
      AND contract_schema_version=$13 AND attempt=$14 AND max_attempts=$15
      AND started_at=$16::timestamptz AND request_payload=$17::jsonb
      AND truncation=$18::jsonb AND schema_version=$19
    ) AS same
    FROM for_now.ai_request_audit
    WHERE account_id=$1 AND call_id=$2
  `, startedValues(accountId, row));
  return result.rows[0]?.same === true;
}

async function completeMatches(
  client: QueryClient,
  accountId: string,
  attempt: PlannedAuditAttempt
): Promise<boolean> {
  const terminal = attempt.terminal;
  const result = await client.query(`
    SELECT (
      status=$20 AND ($26 OR completed_at=$21::timestamptz) AND dispatch_state=$22
      AND response_payload=$23::jsonb
      AND error_payload IS NOT DISTINCT FROM $24::jsonb
      AND usage_payload IS NOT DISTINCT FROM $25::jsonb
    ) AS same
    FROM for_now.ai_request_audit
    WHERE account_id=$1 AND call_id=$2
      AND call_group_id=$3 AND trace_id=$4 AND provider=$5 AND service=$6 AND scene=$7
      AND action=$8 AND trigger_type=$9 AND result_audience=$10
      AND reasoning_visibility=$11 AND persistence_mode=$12
      AND contract_schema_version=$13 AND attempt=$14 AND max_attempts=$15
      AND started_at=$16::timestamptz AND request_payload=$17::jsonb
      AND truncation=$18::jsonb AND schema_version=$19
  `, [
    ...startedValues(accountId, attempt.started),
    terminal.status,
    terminal.completedAt,
    terminal.dispatchState,
    JSON.stringify(terminal.responsePayload),
    JSON.stringify(terminal.errorPayload),
    JSON.stringify(terminal.usagePayload),
    attempt.inferredInterrupted
  ]);
  return result.rows[0]?.same === true;
}

async function finishExisting(
  client: QueryClient,
  accountId: string,
  attempt: PlannedAuditAttempt
): Promise<AuditWriteResult> {
  if (await completeMatches(client, accountId, attempt)) return "already_same";
  if (!await startedMatches(client, accountId, attempt.started)) return "target_conflict";
  try {
    await finishAiAuditAttempt(client, accountId, attempt.callId, attempt.terminal);
    return "completed_existing";
  } catch (error) {
    if (["AI_AUDIT_STATE_CONFLICT", "AI_AUDIT_ATTEMPT_MISSING"].includes(errorCode(error))) {
      return "target_conflict";
    }
    throw error;
  }
}

async function writeAuditAttempt(
  client: QueryClient,
  accountId: string,
  attempt: PlannedAuditAttempt
): Promise<AuditWriteResult> {
  try {
    await beginAiAuditAttempt(client, accountId, attempt.started);
  } catch (error) {
    if (errorCode(error) === "AI_AUDIT_CALL_ID_CONFLICT") {
      return finishExisting(client, accountId, attempt);
    }
    throw error;
  }
  await finishAiAuditAttempt(client, accountId, attempt.callId, attempt.terminal);
  return "inserted";
}

export async function applyAuditMigration(
  client: QueryClient,
  plan: AuditMigrationPlan
): Promise<Record<AuditWriteResult, number>> {
  const summary: Record<AuditWriteResult, number> = {
    inserted: 0,
    completed_existing: 0,
    already_same: 0,
    target_conflict: 0
  };
  for (const batch of migrationBatches(plan.attempts)) {
    await withAccountTransaction(client, plan.accountId, async () => {
      for (const attempt of batch) summary[await writeAuditAttempt(
        client,
        plan.accountId,
        attempt
      )] += 1;
    });
  }
  return summary;
}

function publicPlan(plan: AuditMigrationPlan) {
  return {
    accountId: plan.accountId,
    sourceRows: plan.sourceRows,
    ignoredRows: plan.ignoredRows,
    attempts: plan.attempts.length,
    interrupted: plan.attempts.filter(item => item.terminal.status === "interrupted").length,
    conflicts: plan.conflicts
  };
}

async function loadPlans(
  dataDir: string,
  accountId: string,
  interruptedAt: string
): Promise<AuditMigrationPlan[]> {
  const accounts = await discoverAccountDirectories(dataDir, accountId);
  return Promise.all(accounts.map(async account => planAuditMigration(
    account.accountId,
    await readAuditLines(account.directory),
    interruptedAt
  )));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run migrate:ai-audit -- [--dry-run] [--data-dir PATH] [--account-id ID]");
    console.log("       npm run migrate:ai-audit -- --apply [--data-dir PATH] [--account-id ID]");
    console.log("Apply reads DATABASE_URL from the environment and requires the PostgreSQL application to be stopped. Dry-run is the default.");
    return;
  }
  const options = parseMigrationOptions(process.argv.slice(2));
  const interruptedAt = new Date().toISOString();
  if (!options.apply) {
    const plans = await loadPlans(options.dataDir, options.accountId, interruptedAt);
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
      const plans = await loadPlans(options.dataDir, options.accountId, interruptedAt);
      const reports = plans.map(publicPlan);
      const applied = [];
      for (const plan of plans) {
        applied.push({ accountId: plan.accountId, ...await applyAuditMigration(client, plan) });
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
