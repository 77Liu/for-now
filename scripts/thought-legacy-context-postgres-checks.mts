/**
 * 旧回执与确认分析的真实消费、许可变化和累计读取上限验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成账户；比较正式 matcher 和查询装配，不递归读取分析历史。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type {
  RecordStore, StoreMapping
} from "../src/shared/persistence/record-command-types.mjs";
import { createTaskPreparationQueries } from "../src/app/record-commands/task-preparation.mjs";
import { createTaskMaterialAssembly } from "../src/app/record-commands/task-materials.mjs";
import { createTaskTrendAssembly } from "../src/app/record-commands/task-trend.mjs";

/** 旧分析只消费学习投影；不完整闭包保留失败和原数据。 @since unreleased */
export async function runThoughtLegacyContextPostgresChecks(
  database: QueryClient, mapping: StoreMapping
) {
  const { writeStoreObjects } = await import(
    path.resolve("src/shared/persistence/postgres-objects.mjs")
  );
  const { createAiTaskTargets } = await import(path.resolve("src/app/ai-task-targets.mjs"));
  const { createThoughtTaskTarget } = await import(
    path.resolve("src/modules/thoughts/index.mjs")
  );
  const {
    legalImportanceSources, importanceSourcePermissionKeys, contextDerivedOutputAllowed
  } = await import(path.resolve("src/app/task-context.mjs"));
  const { parseEvidenceSourceKey } = await import(
    path.resolve("src/modules/user-model/index.mjs")
  );
  const {
    personalContextProjection, personalContextRecordSelection, personalContextReceiptMatches
  } = await import(path.resolve("src/app/personal-context.mjs"));
  const accountId = "legacy-context-consumer";
  const now = () => "2026-10-19T00:00:00.000Z";
  const sourceKey = JSON.stringify(["capture", "source", "", ""]);
  const store: RecordStore = {
    thoughts: [{
      id: "root", type: "question", content: "怎样阅读？", authorType: "user", version: 1,
      followUps: [{ id: "followup", question: "怎样持续？", version: 1 }]
    }],
    captures: [{
      id: "source", content: "每天读十分钟", authorType: "user", version: 1
    }],
    analyses: [],
    evidenceSources: [],
    perceptionEvents: [],
    userClaims: [],
    evidencePermissions: [{
      id: sourceKey, sourceKey, accountId, revision: 1,
      contextAllowed: true, learningAllowed: true
    }],
    aiTasks: [{
      id: "consumer", kind: "followUpAnswer", resourceType: "thought", targetId: "root",
      subtargetId: "followup", status: "running", createdAt: now(),
      clientRequestId: "legacy-context-request", version: 1
    }]
  };
  const learningReceipt = personalContextProjection(store, {
    generatedAt: now(), permissionPurpose: "learning"
  }).receipt;
  store.analyses = Array.from({ length: 8 }, (_, index) => ({
    id: `analysis-${index}`, reason: "manual", reviewStatus: "confirmed",
    content: `阅读回望${index}`, version: 1, contextReceipt: learningReceipt
  }));
  const legacyReceipt = personalContextProjection(store, { generatedAt: now() }).receipt;
  const answer = {
    id: "answer", type: "answer", relatedTo: "root", authorType: "ai",
    content: "先从十分钟开始", version: 1, contextReceipt: legacyReceipt
  };
  store.thoughts.push(answer);
  assert.equal(contextDerivedOutputAllowed(store, answer, accountId), true);
  assert.equal(personalContextReceiptMatches(store, learningReceipt), true);
  const targets = createAiTaskTargets({
    thoughts: createThoughtTaskTarget({ createId: () => "unused", now }),
    getAccountId: () => accountId,
    hash: (value: string) => crypto.createHash("sha256").update(value).digest("hex"),
    now
  });
  const expected = targets.prepare(store, store.aiTasks[0]);
  assert.ok(expected);
  store.aiTasks[0].importanceSelectionPlan = expected.contextReceipt.importanceSelectionPlan;
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position, child_fields,
      content, status, author_type, version, payload
    ) SELECT $1, '["analyses","noise-' || n || '"]', 'analyses', 'analysis',
      'noise-' || n, 'analyses', 8 + n, '[]', '非学习回执', '', 'ai', 1,
      jsonb_build_object('id', 'noise-' || n, 'reason', 'manual',
        'reviewStatus', 'confirmed', 'content', '非学习回执', 'version', 1,
        'contextReceipt', jsonb_build_object('permissionPurpose', 'context'))
    FROM generate_series(1, 10000) n
  `, [accountId]);
  const trend = createTaskTrendAssembly({
    mapping, permissionKeys: importanceSourcePermissionKeys,
    legacySelection: personalContextRecordSelection, project: () => null, now
  });
  const purposes: string[][] = [];
  const trace: { rows: number; bytes: number; sql: string }[] = [];
  const queries = createTaskPreparationQueries({
    mapping, onboardingPermissionKeys: () => [], modelInputHash: () => "",
    queryRecords: async operation => {
      await database.query("BEGIN");
      try {
        await database.query("SET LOCAL ROLE runtime_data");
        await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
        const value = await operation({
          accountId,
          client: {
            async query<Row>(sql: string, values?: unknown[]) {
              const result = await database.query<Row>(sql, values);
              trace.push({
                sql, rows: result.rows.length,
                bytes: Buffer.byteLength(JSON.stringify(result.rows))
              });
              return result;
            }
          }
        });
        await database.query("COMMIT");
        return value;
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }
    },
    materialContext: createTaskMaterialAssembly({
      mapping, legalSources: legalImportanceSources,
      permissionKeys: importanceSourcePermissionKeys, parseSourceKey: parseEvidenceSourceKey,
      legacyContext: async (context, reader, requested) => {
        purposes.push(requested);
        await trend.legacyContext(context, reader, requested);
      }
    })
  });
  const assembled = (await queries.materialContext("consumer"))!.snapshot;
  assert.deepEqual(purposes, [["context"], ["learning"]]);
  assert.equal(assembled.analyses.length, 5, "confirmed synthesis consumes only five candidates");
  assert.equal(contextDerivedOutputAllowed(assembled, answer, accountId), true);
  const actual = targets.prepare(assembled, assembled.aiTasks[0]);
  assert.equal(actual.prompt, expected.prompt);
  assert.equal(actual.inputHash, expected.inputHash);
  assert.ok(trace.length < 100, "legacy projection must not recurse through analyses");
  const firstRead = {
    queries: trace.length,
    rows: trace.reduce((sum, query) => sum + query.rows, 0),
    bytes: trace.reduce((sum, query) => sum + query.bytes, 0)
  };
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{learningAllowed}', 'false')
    WHERE account_id = $1 AND collection = 'evidencePermissions' AND id = $2
  `, [accountId, sourceKey]);
  const denied = (await queries.materialContext("consumer"))!.snapshot;
  assert.equal(contextDerivedOutputAllowed(denied, answer, accountId), false);
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{learningAllowed}', 'true')
    WHERE account_id = $1 AND collection = 'evidencePermissions' AND id = $2
  `, [accountId, sourceKey]);
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{content}', '"编辑后原文"'),
      version = version + 1
    WHERE account_id = $1 AND collection = 'captures' AND id = 'source'
  `, [accountId]);
  const changed = (await queries.materialContext("consumer"))!.snapshot;
  assert.equal(contextDerivedOutputAllowed(changed, answer, accountId), false);
  console.log("THOUGHT_LEGACY_CONSUMER " + JSON.stringify({
    firstRead, analysisCandidates: assembled.analyses.length,
    checks: ["two finite purposes", "five analysis candidates", "prompt/hash parity",
      "learning permission revocation", "source mutation"]
  }));
  await cumulativeLimitChecks(database, mapping, trend);
}

async function cumulativeLimitChecks(
  database: QueryClient, mapping: StoreMapping, trend: ReturnType<typeof createTaskTrendAssembly>
) {
  const accountId = "legacy-context-cumulative-limit";
  const { writeStoreObjects } = await import(
    path.resolve("src/shared/persistence/postgres-objects.mjs")
  );
  const store: RecordStore = {
    thoughts: Array.from({ length: 2600 }, (_, index) => ({
      id: `blank-${index}`, type: "question", content: "\t", authorType: "user", version: 1
    })),
    evidencePermissions: Array.from({ length: 2600 }, (_, index) => {
      const id = `blank-${index}`;
      const sourceKey = JSON.stringify(["thought", id, id, `question:${id}`]);
      return { id: sourceKey, sourceKey, accountId, learningAllowed: true, revision: 1 };
    })
  };
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  const before = (await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM for_now.store_objects WHERE account_id=$1",
    [accountId]
  )).rows[0].count;
  await database.query("BEGIN");
  try {
    await database.query("SET LOCAL ROLE runtime_data");
    await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
    await assert.rejects(
      trend.legacyContext({ client: database, accountId }, {
        read: async () => [], include: () => {}, rows: () => []
      }, ["learning"]),
      /Legacy task context closure limit exceeded/
    );
  } finally {
    await database.query("ROLLBACK");
  }
  const after = (await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM for_now.store_objects WHERE account_id=$1",
    [accountId]
  )).rows[0].count;
  assert.equal(after, before, "overflow must preserve every source and permission");
  console.log("THOUGHT_LEGACY_CUMULATIVE_LIMIT " + JSON.stringify({
    rowsPreserved: Number(after), checks: ["cumulative roots/permissions", "explicit failure", "no truncation"]
  }));
}
