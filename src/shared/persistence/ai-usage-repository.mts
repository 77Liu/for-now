/**
 * Implements record-level PostgreSQL operations for AI usage attempts and bounded aggregates.
 * Established: 2026-10-18
 * Status: active
 * Boundary: one call ID is one immutable usage fact; aggregate rows are derived query accelerators.
 */

import type { PgQueryClient } from "./ai-audit-repository.mjs";

export type AiUsageAttempt = Record<string, unknown> & {
  callId?: string;
  id?: string;
  provider?: string;
  service?: string;
  scene?: string;
  model?: string;
  status?: string;
  createdAt?: string;
  usageKnown?: boolean;
  costKnown?: boolean;
  costCny?: number;
};

export type AiUsageReadOptions = {
  from?: string;
  to?: string;
  timezone?: string;
  limit?: number;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_READ_ROWS = 50_000;
const json = (value: unknown): string => JSON.stringify(value ?? null);
const conflict = () => Object.assign(
  new Error("AI usage call ID already has different data"),
  { code: "AI_USAGE_ATTEMPT_CONFLICT" }
);

function dateOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_KEY.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new TypeError(`AI usage ${field} must be YYYY-MM-DD`);
  }
  return value;
}

function usageIdentity(entry: AiUsageAttempt) {
  const callId = String(entry.callId || entry.id || "").trim();
  const provider = String(entry.provider || "").trim();
  const scene = String(entry.scene || "").trim();
  const occurredAt = String(entry.createdAt || "").trim();
  if (!callId || !provider || !scene || Number.isNaN(Date.parse(occurredAt))) {
    throw new TypeError("AI usage attempt identity is incomplete");
  }
  const costCny = Number(entry.costCny);
  if (!Number.isFinite(costCny) || costCny < 0) {
    throw new TypeError("AI usage attempt cost must be a non-negative number");
  }
  const costMicros = Math.round(costCny * 1_000_000);
  if (!Number.isSafeInteger(costMicros)) {
    throw new RangeError("AI usage attempt cost is too large");
  }
  return {
    callId,
    provider,
    service: String(entry.service || ""),
    scene,
    model: String(entry.model || ""),
    status: String(entry.status || "unknown"),
    occurredAt,
    usageKnown: entry.usageKnown === true,
    costKnown: entry.costKnown === true,
    costMicros
  };
}

/**
 * Inserts an immutable usage fact and advances exactly one UTC aggregate row.
 * @since unreleased
 */
export async function recordAiUsageAttempt(
  client: PgQueryClient,
  accountId: string,
  entry: AiUsageAttempt
): Promise<"inserted" | "already_same"> {
  const identity = usageIdentity(entry);
  const payload = json(entry);
  const inserted = await client.query(`
    INSERT INTO for_now.ai_usage_attempts (
      account_id, call_id, provider, service, scene, model, status, occurred_at,
      usage_known, cost_known, cost_micros, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb)
    ON CONFLICT (account_id, call_id) DO NOTHING
    RETURNING call_id
  `, [
    accountId, identity.callId, identity.provider, identity.service, identity.scene,
    identity.model, identity.status, identity.occurredAt, identity.usageKnown,
    identity.costKnown, identity.costMicros, payload
  ]);
  if (inserted.rowCount === 0) {
    const existing = await client.query(`
      SELECT payload=$3::jsonb AS same
      FROM for_now.ai_usage_attempts
      WHERE account_id=$1 AND call_id=$2
    `, [accountId, identity.callId, payload]);
    if (existing.rows[0]?.same === true) return "already_same";
    throw conflict();
  }
  await client.query(`
    INSERT INTO for_now.ai_usage_aggregates (
      account_id, period_date, provider, model, calls, known_cost_micros, unknown_cost_calls
    ) VALUES (
      $1, ($2::timestamptz AT TIME ZONE 'UTC')::date, $3, $4, 1, $5, $6
    )
    ON CONFLICT (account_id, period_date, provider, model)
    DO UPDATE SET
      calls=for_now.ai_usage_aggregates.calls + 1,
      known_cost_micros=for_now.ai_usage_aggregates.known_cost_micros + EXCLUDED.known_cost_micros,
      unknown_cost_calls=for_now.ai_usage_aggregates.unknown_cost_calls + EXCLUDED.unknown_cost_calls
  `, [
    accountId, identity.occurredAt, identity.provider, identity.model,
    identity.costKnown ? identity.costMicros : 0, identity.costKnown ? 0 : 1
  ]);
  return "inserted";
}

/**
 * Reads a bounded account/time slice. Omitting dates returns the latest 30 UTC days.
 * @since unreleased
 */
export async function readAiUsageAttempts(
  client: PgQueryClient,
  accountId: string,
  options: AiUsageReadOptions = {}
): Promise<{ version: 5; trackingStartedAt: string; entries: AiUsageAttempt[] }> {
  const from = dateOrNull(options.from, "from");
  const to = dateOrNull(options.to, "to");
  if (from && to && from > to) throw new TypeError("AI usage range is invalid");
  const timezone = String(options.timezone || "UTC").trim() || "UTC";
  const limit = Math.max(1, Math.min(MAX_READ_ROWS, Math.trunc(options.limit || MAX_READ_ROWS)));
  const rows = (await client.query(`
    SELECT payload
    FROM for_now.ai_usage_attempts
    WHERE account_id=$1
      AND (occurred_at AT TIME ZONE $4)::date >= COALESCE($2::date, (now() AT TIME ZONE $4)::date - 29)
      AND (occurred_at AT TIME ZONE $4)::date <= COALESCE($3::date, (now() AT TIME ZONE $4)::date)
    ORDER BY occurred_at, call_id
    LIMIT $5
  `, [accountId, from, to, timezone, limit + 1])).rows;
  if (rows.length > limit) {
    throw Object.assign(new Error("AI usage range exceeds the bounded query limit"), {
      code: "AI_USAGE_RANGE_TOO_LARGE"
    });
  }
  const first = await client.query(`
    SELECT min(occurred_at)::text AS started_at
    FROM for_now.ai_usage_attempts
    WHERE account_id=$1
  `, [accountId]);
  return {
    version: 5,
    trackingStartedAt: String(first.rows[0]?.started_at || new Date(0).toISOString()),
    entries: rows.map(row => structuredClone(row.payload) as AiUsageAttempt)
  };
}

/**
 * Returns the persisted UTC-day quota facts without scanning attempt payloads.
 * @since unreleased
 */
export async function readAiUsageDaySummary(
  client: PgQueryClient,
  accountId: string,
  day: string
): Promise<{ calls: number; knownCostCny: number; unknownCostCalls: number }> {
  const date = dateOrNull(day, "day");
  if (!date) throw new TypeError("AI usage day is required");
  const result = await client.query(`
    SELECT COALESCE(sum(calls),0)::int AS calls,
      COALESCE(sum(known_cost_micros),0)::float8 / 1000000 AS known_cost_cny,
      COALESCE(sum(unknown_cost_calls),0)::int AS unknown_cost_calls
    FROM for_now.ai_usage_aggregates
    WHERE account_id=$1 AND period_date=$2::date
  `, [accountId, date]);
  return {
    calls: Number(result.rows[0]?.calls) || 0,
    knownCostCny: Number(result.rows[0]?.known_cost_cny) || 0,
    unknownCostCalls: Number(result.rows[0]?.unknown_cost_calls) || 0
  };
}
