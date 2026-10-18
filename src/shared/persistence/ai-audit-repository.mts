/**
 * Implements record-level PostgreSQL operations for private AI request audits.
 * Established: 2026-10-18
 * Status: active
 * Boundary: callers provide a trusted account transaction; provider I/O never runs inside these operations.
 */

type QueryResult = {
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
};

export type PgQueryClient = {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
};

export type AiAuditStartedRow = {
  callId: string;
  callGroupId: string;
  traceId: string;
  provider: string;
  service: string;
  scene: string;
  action: string;
  triggerType: string;
  resultAudience: string;
  reasoningVisibility: string;
  persistenceMode: string;
  contractSchemaVersion: number;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  requestPayload: Record<string, unknown>;
  truncation: Record<string, unknown>;
  schemaVersion: number;
};

export type AiAuditTerminalRow = {
  status: "success" | "failed" | "timeout" | "cancelled" | "interrupted";
  completedAt: string;
  dispatchState: "invoked" | "not_invoked";
  responsePayload: Record<string, unknown>;
  errorPayload: Record<string, unknown> | null;
  usagePayload: Record<string, unknown> | null;
};

const json = (value: unknown): string => JSON.stringify(value ?? null);
const repositoryError = (code: string, message: string) => Object.assign(new Error(message), { code });

function validateStarted(row: AiAuditStartedRow): void {
  const textFields = [
    "callId", "callGroupId", "provider", "service", "scene", "action",
    "triggerType", "resultAudience", "reasoningVisibility", "persistenceMode", "startedAt"
  ] as const;
  for (const field of textFields) {
    if (typeof row[field] !== "string" || !row[field]) {
      throw new TypeError(`AI audit ${field} is required`);
    }
  }
  if (!Number.isSafeInteger(row.attempt) || row.attempt < 1
    || !Number.isSafeInteger(row.maxAttempts) || row.maxAttempts < row.attempt
    || !Number.isSafeInteger(row.contractSchemaVersion) || row.contractSchemaVersion < 1
    || !Number.isSafeInteger(row.schemaVersion) || row.schemaVersion < 1) {
    throw new TypeError("AI audit numeric metadata is invalid");
  }
}

/**
 * Inserts the started fact. A reused call ID is always a conflict, never a second row.
 * @since unreleased
 */
export async function beginAiAuditAttempt(
  client: PgQueryClient,
  accountId: string,
  row: AiAuditStartedRow
): Promise<"inserted"> {
  validateStarted(row);
  const result = await client.query(`
    INSERT INTO for_now.ai_request_audit (
      account_id, call_id, call_group_id, trace_id, provider, service, scene, action,
      trigger_type, result_audience, reasoning_visibility, persistence_mode,
      contract_schema_version, attempt, max_attempts, status, dispatch_state,
      started_at, request_payload, response_payload, error_payload, usage_payload,
      truncation, schema_version
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'started','pending',
      $16::timestamptz,$17::jsonb,'{}'::jsonb,NULL,NULL,$18::jsonb,$19
    )
    ON CONFLICT (call_id) DO NOTHING
    RETURNING call_id
  `, [
    accountId, row.callId, row.callGroupId, row.traceId, row.provider, row.service,
    row.scene, row.action, row.triggerType, row.resultAudience,
    row.reasoningVisibility, row.persistenceMode, row.contractSchemaVersion,
    row.attempt, row.maxAttempts, row.startedAt, json(row.requestPayload),
    json(row.truncation), row.schemaVersion
  ]);
  if (result.rowCount === 1) return "inserted";
  throw repositoryError("AI_AUDIT_CALL_ID_CONFLICT", "AI audit call ID is already in use");
}

/**
 * Conditionally finalizes one started row; identical retries are accepted without mutation.
 * @since unreleased
 */
export async function finishAiAuditAttempt(
  client: PgQueryClient,
  accountId: string,
  callId: string,
  terminal: AiAuditTerminalRow
): Promise<"updated" | "already_same"> {
  const values = [
    accountId, callId, terminal.status, terminal.completedAt, terminal.dispatchState,
    json(terminal.responsePayload), json(terminal.errorPayload), json(terminal.usagePayload)
  ];
  const result = await client.query(`
    UPDATE for_now.ai_request_audit
    SET status=$3, completed_at=$4::timestamptz, dispatch_state=$5,
      response_payload=$6::jsonb, error_payload=$7::jsonb, usage_payload=$8::jsonb
    WHERE account_id=$1 AND call_id=$2 AND status='started'
    RETURNING call_id
  `, values);
  if (result.rowCount === 1) return "updated";
  const existing = await client.query(`
    SELECT (
      status=$3
      AND completed_at=$4::timestamptz
      AND dispatch_state=$5
      AND response_payload=$6::jsonb
      AND error_payload IS NOT DISTINCT FROM $7::jsonb
      AND usage_payload IS NOT DISTINCT FROM $8::jsonb
    ) AS same
    FROM for_now.ai_request_audit
    WHERE account_id=$1 AND call_id=$2
  `, values);
  if (existing.rows[0]?.same === true) return "already_same";
  if (!existing.rowCount) {
    throw repositoryError("AI_AUDIT_ATTEMPT_MISSING", "AI audit attempt does not exist");
  }
  throw repositoryError("AI_AUDIT_STATE_CONFLICT", "AI audit attempt already has a different terminal state");
}

/**
 * Marks a bounded batch of stale started rows without inventing response or usage data.
 * @since unreleased
 */
export async function markInterruptedAiAuditAttempts(
  client: PgQueryClient,
  accountId: string,
  cutoff: string,
  limit = 200
): Promise<number> {
  const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const result = await client.query(`
    WITH stale AS (
      SELECT call_id
      FROM for_now.ai_request_audit
      WHERE account_id=$1 AND status='started' AND started_at < $2::timestamptz
      ORDER BY started_at, call_id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    UPDATE for_now.ai_request_audit audit
    SET status='interrupted', completed_at=now(), dispatch_state='invoked'
    FROM stale
    WHERE audit.account_id=$1 AND audit.call_id=stale.call_id
  `, [accountId, cutoff, bounded]);
  return result.rowCount ?? 0;
}

/**
 * Deletes one bounded retention batch for the current account.
 * @since unreleased
 */
export async function deleteExpiredAiAuditAttempts(
  client: PgQueryClient,
  accountId: string,
  cutoff: string,
  limit = 500
): Promise<number> {
  const bounded = Math.max(1, Math.min(2000, Math.trunc(limit)));
  const result = await client.query(`
    WITH expired AS (
      SELECT call_id
      FROM for_now.ai_request_audit
      WHERE account_id=$1 AND started_at < $2::timestamptz
        AND (usage_payload IS NULL OR usage_payload='null'::jsonb OR EXISTS (
          SELECT 1 FROM for_now.ai_usage_attempts usage
          WHERE usage.account_id=ai_request_audit.account_id
            AND usage.call_id=ai_request_audit.call_id
        ))
      ORDER BY started_at, call_id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM for_now.ai_request_audit audit
    USING expired
    WHERE audit.account_id=$1 AND audit.call_id=expired.call_id
  `, [accountId, cutoff, bounded]);
  return result.rowCount ?? 0;
}

/**
 * Reads the current account's audit/ledger difference without a mutable recovery flag.
 * @since unreleased
 */
export async function findMissingAiAuditUsage(
  client: PgQueryClient,
  accountId: string,
  afterCallId = "",
  limit = 200
): Promise<Array<{ callId: string; usageRecovery: Record<string, unknown> }>> {
  const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const result = await client.query(`
    SELECT audit.call_id AS "callId", audit.usage_payload->'usageRecovery' AS "usageRecovery"
    FROM for_now.ai_request_audit audit
    WHERE audit.account_id=$1 AND audit.call_id > $2
      AND jsonb_typeof(audit.usage_payload->'usageRecovery')='object'
      AND NOT EXISTS (
        SELECT 1 FROM for_now.ai_usage_attempts usage
        WHERE usage.account_id=audit.account_id AND usage.call_id=audit.call_id
      )
    ORDER BY audit.call_id
    LIMIT $3
  `, [accountId, afterCallId, bounded]);
  return result.rows.map(row => {
    const usageRecovery = row.usageRecovery as Record<string, unknown>;
    if (usageRecovery.callId !== row.callId) {
      throw repositoryError("AI_AUDIT_USAGE_IDENTITY_INVALID", "Audit usage identity differs from call ID");
    }
    return { callId: String(row.callId), usageRecovery };
  });
}
