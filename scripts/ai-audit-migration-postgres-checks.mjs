/**
 * Runs AI audit/usage migration checks against the isolated PostgreSQL integration cluster.
 * Established: 2026-10-18
 * Status: active
 * Boundary: synthetic rows only; the caller owns schema setup, accounts, and connection cleanup.
 */
import assert from "node:assert/strict";
import {
  applyAuditMigration,
  planAuditMigration
} from "../.build/typescript/ai-migrations/scripts/migrate-ai-audit.mjs";
import {
  applyUsageMigration,
  planUsageMigration
} from "../.build/typescript/ai-migrations/scripts/migrate-ai-usage.mjs";

const auditSource = [
  {
    schemaVersion: 3,
    type: "ai.invocation",
    id: "migration-audit-complete",
    callId: "migration-audit-complete",
    callGroupId: "migration-group",
    provider: "deepseek",
    scene: "thoughtAnswer",
    status: "started",
    startedAt: "2026-10-01T00:00:00.000Z",
    request: {
      systemPrompt: "synthetic system prompt",
      userPrompt: "synthetic user prompt",
      history: [],
      parameters: {}
    }
  },
  {
    schemaVersion: 3,
    type: "ai.invocation",
    id: "migration-audit-complete",
    callId: "migration-audit-complete",
    callGroupId: "migration-group",
    provider: "deepseek",
    scene: "thoughtAnswer",
    status: "success",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:01.000Z",
    response: { content: "synthetic result", reasoningContent: "synthetic reasoning" },
    usage: { known: true, costKnown: true, costCny: 0.1 }
  },
  {
    schemaVersion: 3,
    type: "ai.invocation",
    id: "migration-audit-interrupted",
    callId: "migration-audit-interrupted",
    callGroupId: "migration-group",
    provider: "deepseek",
    scene: "thoughtAnswer",
    status: "started",
    startedAt: "2026-10-01T00:01:00.000Z",
    request: {
      systemPrompt: "synthetic interrupted prompt",
      userPrompt: "synthetic interrupted input",
      history: [],
      parameters: {}
    }
  }
];

const usageDocument = {
  version: 5,
  entries: [
    {
      id: "migration-usage-known",
      callId: "migration-usage-known",
      provider: "deepseek",
      service: "chat-completions",
      scene: "thoughtAnswer",
      model: "deepseek-flash",
      status: "success",
      createdAt: "2026-10-01T00:00:01.000Z",
      usageKnown: true,
      costKnown: true,
      costCny: 0.125
    },
    {
      id: "migration-usage-unknown",
      callId: "migration-usage-unknown",
      provider: "volcengine",
      service: "vision",
      scene: "visionOcr",
      model: "volcengine-vision",
      status: "failed",
      createdAt: "2026-10-01T00:00:02.000Z",
      usageKnown: true,
      costKnown: false,
      costCny: 0
    }
  ]
};

export async function runAiMigrationPostgresChecks({ admin, client }) {
  const accountId = "account-a";
  const documentsBefore = Number((await admin.query(`
    SELECT count(*) AS count
    FROM for_now.account_documents
    WHERE account_id=$1 AND document='usage'
  `, [accountId])).rows[0].count);
  const auditPlan = planAuditMigration(
    accountId,
    auditSource,
    "2026-10-18T00:00:00.000Z"
  );
  const usagePlan = planUsageMigration(accountId, usageDocument);
  assert.deepEqual(await applyAuditMigration(client, auditPlan), {
    inserted: 2,
    completed_existing: 0,
    already_same: 0,
    target_conflict: 0
  });
  assert.deepEqual(await applyUsageMigration(client, usagePlan), {
    inserted: 2,
    already_same: 0,
    target_conflict: 0
  });

  const replanned = planAuditMigration(
    accountId,
    auditSource,
    "2026-10-19T00:00:00.000Z"
  );
  assert.deepEqual(await applyAuditMigration(client, replanned), {
    inserted: 0,
    completed_existing: 0,
    already_same: 2,
    target_conflict: 0
  });
  assert.deepEqual(await applyUsageMigration(client, usagePlan), {
    inserted: 0,
    already_same: 2,
    target_conflict: 0
  });

  const rows = (await admin.query(`
    SELECT call_id, status, response_payload, usage_payload
    FROM for_now.ai_request_audit
    WHERE account_id=$1 AND call_id LIKE 'migration-audit-%'
    ORDER BY call_id
  `, [accountId])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.call_id.endsWith("complete")).status, "success");
  const interrupted = rows.find(row => row.call_id.endsWith("interrupted"));
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(interrupted.response_payload, {});
  assert.equal(interrupted.usage_payload, null);

  const aggregates = (await admin.query(`
    SELECT sum(calls)::int AS calls, sum(known_cost_micros)::bigint AS known_cost_micros,
      sum(unknown_cost_calls)::int AS unknown_cost_calls
    FROM for_now.ai_usage_aggregates
    WHERE account_id=$1 AND period_date='2026-10-01'
  `, [accountId])).rows[0];
  assert.equal(aggregates.calls, 2);
  assert.equal(Number(aggregates.known_cost_micros), 125000);
  assert.equal(aggregates.unknown_cost_calls, 1);
  assert.equal(Number((await admin.query(`
    SELECT count(*) AS count
    FROM for_now.account_documents
    WHERE account_id=$1 AND document='usage'
  `, [accountId])).rows[0].count), documentsBefore);

  const conflictingUsage = planUsageMigration(accountId, {
    version: 5,
    entries: [{ ...usageDocument.entries[0], costCny: 9 }]
  });
  assert.deepEqual(await applyUsageMigration(client, conflictingUsage), {
    inserted: 0,
    already_same: 0,
    target_conflict: 1
  });
  return "AI audit/usage legacy migration idempotence, conflict and zero document rewrite";
}
