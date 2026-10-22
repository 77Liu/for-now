/**
 * Synthetic regression for legacy AI audit and usage record-level migrations.
 * Established: 2026-10-18
 * Status: active
 * Boundary: temporary private fixtures and an in-memory SQL contract; no production data or provider calls.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyAuditMigration,
  planAuditMigration
} from "./migrate-ai-audit.mjs";
import {
  applyUsageMigration,
  planUsageMigration
} from "./migrate-ai-usage.mjs";
import {
  claimOfflineMigration,
  discoverAccountDirectories,
  parseMigrationOptions,
  readAuditLines,
  readOptionalObject,
  type QueryClient
} from "./ai-migration-support.mjs";

type Row = Record<string, unknown>;

const jsonValue = (value: unknown): unknown => (
  typeof value === "string" ? JSON.parse(value) : value
);

class MemoryMigrationClient implements QueryClient {
  audit = new Map<string, Row>();
  usage = new Map<string, Row>();
  aggregates = new Map<string, { calls: number; knownCostMicros: number; unknownCostCalls: number }>();
  accountDocumentQueries = 0;

  private auditStarted(values: unknown[]): Row {
    return {
      accountId: values[0], callId: values[1], callGroupId: values[2], traceId: values[3],
      provider: values[4], service: values[5], scene: values[6], action: values[7],
      triggerType: values[8], resultAudience: values[9], reasoningVisibility: values[10],
      persistenceMode: values[11], contractSchemaVersion: values[12], attempt: values[13],
      maxAttempts: values[14], startedAt: values[15], requestPayload: jsonValue(values[16]),
      truncation: jsonValue(values[17]), schemaVersion: values[18], status: "started",
      dispatchState: "pending", completedAt: null, responsePayload: {}, errorPayload: null,
      usagePayload: null
    };
  }

  private startedSame(row: Row | undefined, values: unknown[]): boolean {
    return Boolean(row) && isDeepStrictEqual(
      Object.fromEntries(Object.entries(this.auditStarted(values)).filter(
        ([key]) => !["status", "dispatchState", "completedAt", "responsePayload", "errorPayload", "usagePayload"].includes(key)
      )),
      Object.fromEntries(Object.entries(row || {}).filter(
        ([key]) => !["status", "dispatchState", "completedAt", "responsePayload", "errorPayload", "usagePayload"].includes(key)
      ))
    );
  }

  private terminalSame(
    row: Row | undefined,
    values: unknown[],
    offset: number,
    ignoreCompletedAt = false
  ): boolean {
    return Boolean(row)
      && row?.status === values[offset]
      && (ignoreCompletedAt || row?.completedAt === values[offset + 1])
      && row?.dispatchState === values[offset + 2]
      && isDeepStrictEqual(row?.responsePayload, jsonValue(values[offset + 3]))
      && isDeepStrictEqual(row?.errorPayload, jsonValue(values[offset + 4]))
      && isDeepStrictEqual(row?.usagePayload, jsonValue(values[offset + 5]));
  }

  private auditQuery(sql: string, values: unknown[]) {
    const key = String(values[1]);
    const row = this.audit.get(key);
    if (sql.includes("INSERT INTO for_now.ai_request_audit")) {
      if (row) return { rowCount: 0, rows: [] };
      this.audit.set(key, this.auditStarted(values));
      return { rowCount: 1, rows: [{ call_id: key }] };
    }
    if (sql.includes("UPDATE for_now.ai_request_audit")) {
      if (!row || row.accountId !== values[0] || row.status !== "started") {
        return { rowCount: 0, rows: [] };
      }
      Object.assign(row, {
        status: values[2], completedAt: values[3], dispatchState: values[4],
        responsePayload: jsonValue(values[5]), errorPayload: jsonValue(values[6]),
        usagePayload: jsonValue(values[7])
      });
      return { rowCount: 1, rows: [{ call_id: key }] };
    }
    if (values.length === 8) {
      return {
        rowCount: row ? 1 : 0,
        rows: row ? [{ same: this.terminalSame(row, values, 2) }] : []
      };
    }
    const same = this.startedSame(row, values)
      && (values.length === 19 || this.terminalSame(row, values, 19, values[25] === true));
    return { rowCount: row ? 1 : 0, rows: row ? [{ same }] : [] };
  }

  private usageQuery(sql: string, values: unknown[]) {
    const key = `${String(values[0])}\u0000${String(values[1])}`;
    if (sql.includes("INSERT INTO for_now.ai_usage_attempts")) {
      if (this.usage.has(key)) return { rowCount: 0, rows: [] };
      this.usage.set(key, { payload: jsonValue(values[11]) });
      return { rowCount: 1, rows: [{ call_id: values[1] }] };
    }
    if (sql.includes("SELECT payload=$3::jsonb AS same")) {
      const row = this.usage.get(key);
      return {
        rowCount: row ? 1 : 0,
        rows: row ? [{ same: isDeepStrictEqual(row.payload, jsonValue(values[2])) }] : []
      };
    }
    const period = String(values[1]).slice(0, 10);
    const aggregateKey = `${values[0]}\u0000${period}\u0000${values[2]}\u0000${values[3]}`;
    const current = this.aggregates.get(aggregateKey) || {
      calls: 0, knownCostMicros: 0, unknownCostCalls: 0
    };
    current.calls += 1;
    current.knownCostMicros += Number(values[4]);
    current.unknownCostCalls += Number(values[5]);
    this.aggregates.set(aggregateKey, current);
    return { rowCount: 1, rows: [] };
  }

  async query(sql: string, values: unknown[] = []) {
    if (/account_documents|document_records/u.test(sql)) this.accountDocumentQueries += 1;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql.trim()) || sql.includes("set_config")) {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes("ai_request_audit")) return this.auditQuery(sql, values);
    if (sql.includes("ai_usage_")) return this.usageQuery(sql, values);
    throw new Error(`Unexpected migration SQL: ${sql.trim().slice(0, 80)}`);
  }
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ai-migration-"));
try {
  const accountId = "migration-account";
  const accountDir = path.join(directory, "users", accountId);
  const logsDir = path.join(accountDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(directory, "auth.json"), JSON.stringify({
    users: [{ id: accountId }]
  }));
  const base = {
    schemaVersion: 3,
    type: "ai.invocation",
    callGroupId: "migration-group",
    provider: "deepseek",
    scene: "thoughtAnswer",
    startedAt: "2026-10-01T00:00:00.000Z",
    request: {
      systemPrompt: "PRIVATE_SYSTEM_PROMPT",
      userPrompt: "PRIVATE_USER_PROMPT",
      history: [],
      parameters: {}
    }
  };
  const auditRows = [
    { ...base, id: "complete", callId: "complete", status: "started" },
    {
      ...base, id: "complete", callId: "complete", status: "success",
      completedAt: "2026-10-01T00:00:01.000Z",
      response: { content: "PRIVATE_RESULT", reasoningContent: "PRIVATE_REASONING" },
      usage: { known: true, costCny: 0.1 }
    },
    { ...base, id: "interrupted", callId: "interrupted", status: "started" },
    {
      ...base, id: "terminal-only", callId: "terminal-only", status: "failed",
      completedAt: "2026-10-01T00:00:02.000Z", error: { code: "FIXTURE_FAILURE" }
    },
    { ...base, id: "conflict", callId: "conflict", status: "started" },
    {
      ...base, id: "conflict", callId: "conflict", status: "success",
      completedAt: "2026-10-01T00:00:03.000Z", response: { content: "PRIVATE_A" }
    },
    {
      ...base, id: "conflict", callId: "conflict", status: "failed",
      completedAt: "2026-10-01T00:00:04.000Z", response: { content: "PRIVATE_B" }
    },
    { type: "ai.usage_recovered", callId: "ignored" }
  ];
  await fs.writeFile(
    path.join(logsDir, "ai-audit-2026-10-01.ndjson"),
    `${auditRows.map(row => JSON.stringify(row)).join("\n")}\n`
  );
  const usageA = {
    id: "usage-a", callId: "usage-a", provider: "deepseek", service: "chat-completions",
    scene: "thoughtAnswer", model: "deepseek-flash", status: "success",
    createdAt: "2026-10-01T00:00:01.000Z", usageKnown: true, costKnown: true, costCny: 0.1
  };
  const usageB = {
    id: "usage-b", provider: "volcengine", service: "speech", scene: "speechSynthesis",
    model: "volcengine-speech", status: "success", createdAt: "2026-10-01T00:00:02.000Z",
    unitType: "character", units: 10, usageKnown: true, costKnown: false
  };
  await fs.writeFile(path.join(accountDir, "ai-usage.json"), JSON.stringify({
    version: 5,
    entries: [
      usageA,
      structuredClone(usageA),
      usageB,
      { ...usageB, id: "usage-conflict", callId: "usage-conflict", units: 1 },
      { ...usageB, id: "usage-conflict", callId: "usage-conflict", units: 2 }
    ]
  }));

  assert.equal(parseMigrationOptions([], directory).apply, false);
  assert.equal(parseMigrationOptions(["--dry-run"], directory).apply, false);
  assert.equal(parseMigrationOptions(["--apply"], directory).apply, true);
  assert.throws(() => parseMigrationOptions(["--dry-run", "--apply"], directory));
  assert.throws(() => parseMigrationOptions(["--database-url", "private"], directory));
  await claimOfflineMigration({
    query: async () => ({ rowCount: 1, rows: [{ acquired: true }] })
  });
  await assert.rejects(claimOfflineMigration({
    query: async () => ({ rowCount: 1, rows: [{ acquired: false }] })
  }), /Stop the PostgreSQL application/u);
  const accounts = await discoverAccountDirectories(directory);
  assert.deepEqual(accounts, [{ accountId, directory: accountDir }]);

  const auditPlan = planAuditMigration(
    accountId,
    await readAuditLines(accountDir),
    "2026-10-18T00:00:00.000Z"
  );
  assert.equal(auditPlan.attempts.length, 3);
  assert.equal(auditPlan.ignoredRows, 1);
  assert.equal(auditPlan.conflicts.length, 1);
  assert.equal(auditPlan.conflicts[0].callId, "conflict");
  assert.equal(auditPlan.attempts.find(row => row.callId === "complete")?.terminal.status, "success");
  assert.equal(auditPlan.attempts.find(row => row.callId === "interrupted")?.terminal.status, "interrupted");
  assert.equal(auditPlan.attempts.find(row => row.callId === "terminal-only")?.terminal.status, "failed");
  assert.doesNotMatch(JSON.stringify(auditPlan.conflicts), /PRIVATE_/u);

  const usageDocument = await readOptionalObject(path.join(accountDir, "ai-usage.json"));
  const usagePlan = planUsageMigration(accountId, usageDocument);
  assert.equal(usagePlan.sourceEntries, 5);
  assert.equal(usagePlan.attempts.length, 2);
  assert.equal(usagePlan.conflicts.length, 1);
  assert.equal(usagePlan.conflicts[0].callId, "usage-conflict");
  assert.doesNotMatch(JSON.stringify(usagePlan.conflicts), /PRIVATE_/u);

  const client = new MemoryMigrationClient();
  assert.deepEqual(await applyAuditMigration(client, auditPlan), {
    inserted: 3, completed_existing: 0, already_same: 0, target_conflict: 0
  });
  assert.deepEqual(await applyAuditMigration(client, auditPlan), {
    inserted: 0, completed_existing: 0, already_same: 3, target_conflict: 0
  });
  const replannedAudit = planAuditMigration(
    accountId,
    await readAuditLines(accountDir),
    "2026-10-19T00:00:00.000Z"
  );
  assert.deepEqual(await applyAuditMigration(client, replannedAudit), {
    inserted: 0, completed_existing: 0, already_same: 3, target_conflict: 0
  });
  assert.equal(client.audit.size, 3);
  assert.equal(client.audit.get("complete")?.requestPayload
    && (client.audit.get("complete")?.requestPayload as Row).systemPrompt, "PRIVATE_SYSTEM_PROMPT");
  assert.equal(client.audit.get("interrupted")?.responsePayload
    && Object.keys(client.audit.get("interrupted")?.responsePayload as Row).length, 0);
  assert.equal(client.audit.get("interrupted")?.usagePayload, null);

  assert.deepEqual(await applyUsageMigration(client, usagePlan), {
    inserted: 2, already_same: 0, target_conflict: 0
  });
  assert.deepEqual(await applyUsageMigration(client, usagePlan), {
    inserted: 0, already_same: 2, target_conflict: 0
  });
  assert.equal(planUsageMigration(accountId, {}).conflicts[0].code, "SOURCE_USAGE_ENTRIES_INVALID");
  assert.equal(client.usage.size, 2);
  assert.equal([...client.aggregates.values()].reduce((sum, row) => sum + row.calls, 0), 2);
  assert.equal(client.accountDocumentQueries, 0);
  console.log("AI audit migration checks passed: dual-row merge, terminal-only recovery, interrupted state, redacted conflicts, idempotent usage aggregates and zero account-document writes.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
