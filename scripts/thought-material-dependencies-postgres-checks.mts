/**
 * 生产者回执的真实消费闭包与正文伪依赖隔离验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成账户；用实际回答准备和资格 matcher 比较完整快照与定向查询。
 */
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordEntity, RecordStore, StoreMapping } from "../src/shared/persistence/record-command-types.mjs";
import { createTaskPreparationQueries } from "../src/app/record-commands/task-preparation.mjs";
import { createTaskMaterialAssembly } from "../src/app/record-commands/task-materials.mjs";

/** 任意嵌套正文不扩张读取；来源版本或许可改变仍使派生回答失效。 @since unreleased */
export async function runThoughtMaterialDependenciesPostgresChecks(
  database: QueryClient, mapping: StoreMapping
) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const { createAiTaskTargets } = await import(path.resolve("src/app/ai-task-targets.mjs"));
  const { createThoughtTaskTarget } = await import(path.resolve("src/modules/thoughts/index.mjs"));
  const {
    legalImportanceSources, importanceSourcePermissionKeys, contextDerivedOutputAllowed
  } = await import(path.resolve("src/app/task-context.mjs"));
  const { parseEvidenceSourceKey } = await import(path.resolve("src/modules/user-model/index.mjs"));
  const accountId = "material-dependencies";
  const now = () => "2026-10-19T00:00:00.000Z";
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const targets = createAiTaskTargets({
    thoughts: createThoughtTaskTarget({ createId: () => "unused", now }),
    getAccountId: () => accountId, hash, now
  });
  const noise = {
    sourceTaskId: "body-only-task",
    contextReceipt: { permissionPurpose: "learning" },
    sourceKey: JSON.stringify(["capture", "body-only-source", "", ""])
  };
  const store: RecordStore = {
    thoughts: [{ id: "root", type: "question", content: "怎样读书？", authorType: "user", version: 1,
      metadata: noise, followUps: [{ id: "followup", question: "怎样坚持？", version: 1 }] }],
    captures: [{ id: "source", content: "每天阅读十分钟", authorType: "user", version: 1 }],
    evidenceSources: [], evidencePermissions: [], perceptionEvents: [], userClaims: [],
    aiTasks: [{ id: "producer", kind: "thoughtAnswer", resourceType: "thought", targetId: "root",
      status: "running", createdAt: now(), clientRequestId: "producer-request", version: 1 }]
  };
  const produced = targets.prepare(store, store.aiTasks[0]);
  assert.ok(produced.contextReceipt.rawSourceChecks.some((check: { sourceKey: string }) => (
    parseEvidenceSourceKey(check.sourceKey)?.resourceId === "source"
  )));
  const answer = {
    id: "answer", relatedTo: "root", type: "answer", authorType: "ai",
    content: "先从十分钟开始。", version: 1, sourceTaskId: "producer",
    contextReceipt: produced.contextReceipt, metadata: noise
  };
  store.thoughts.push(answer);
  Object.assign(store.aiTasks[0], {
    status: "succeeded", resultId: answer.id, contextFingerprint: produced.contextFingerprint,
    importanceSelectionPlan: { sources: Array.from({ length: 6000 }, () => noise) }
  });
  const consumer: RecordEntity = {
    id: "consumer", kind: "followUpAnswer", resourceType: "thought", targetId: "root",
    subtargetId: "followup", status: "running", createdAt: now(),
    clientRequestId: "consumer-request", version: 1
  };
  store.aiTasks.push(consumer);
  const expected = { kind: "thoughtAnswer", targetId: "root", subtargetId: "" };
  assert.equal(contextDerivedOutputAllowed(store, answer, accountId, expected), true);
  const full = targets.prepare(store, consumer);
  consumer.importanceSelectionPlan = full.contextReceipt.importanceSelectionPlan;
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  const trace: { sql: string; values?: unknown[] }[] = [];
  const queries = createTaskPreparationQueries({
    mapping, onboardingPermissionKeys: () => [], modelInputHash: () => "",
    queryRecords: async operation => {
      await database.query("BEGIN");
      try {
        await database.query("SET LOCAL ROLE runtime_data");
        await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
        const result = await operation({
          accountId,
          client: {
            async query<Row>(sql: string, values?: unknown[]) {
              trace.push({ sql, values });
              return database.query<Row>(sql, values);
            }
          }
        });
        await database.query("COMMIT");
        return result;
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }
    },
    materialContext: createTaskMaterialAssembly({
      mapping, legalSources: legalImportanceSources,
      permissionKeys: importanceSourcePermissionKeys, parseSourceKey: parseEvidenceSourceKey
    })
  });
  const assembled = (await queries.materialContext(consumer.id))!.snapshot;
  const producer = assembled.aiTasks.find(task => task.id === "producer");
  assert.ok(producer);
  assert.equal(Object.hasOwn(producer, "importanceSelectionPlan"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(producer)) < 1000);
  assert.equal(contextDerivedOutputAllowed(assembled, answer, accountId, expected), true);
  const actual = targets.prepare(assembled, assembled.aiTasks.find(task => task.id === consumer.id));
  assert.equal(actual.prompt, full.prompt);
  assert.equal(actual.inputHash, full.inputHash);
  assert.ok(trace.every(query => !JSON.stringify(query.values).includes("body-only")));
  assert.ok(trace.length < 60);
  const firstReadQueries = trace.length;
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{contextFingerprint}', '"invalid"')
    WHERE account_id = $1 AND collection = 'aiTasks' AND id = 'producer'
  `, [accountId]);
  const invalidProducer = (await queries.materialContext(consumer.id))!.snapshot;
  assert.equal(contextDerivedOutputAllowed(invalidProducer, answer, accountId, expected), false);
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{contextFingerprint}', $2::jsonb)
    WHERE account_id = $1 AND collection = 'aiTasks' AND id = 'producer'
  `, [accountId, JSON.stringify(produced.contextFingerprint)]);
  const sourceKey = JSON.stringify(["capture", "source", "", ""]);
  const permission = {
    id: sourceKey, sourceKey, accountId, contextAllowed: false,
    learningAllowed: false, revision: 2, updatedAt: now()
  };
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, child_fields,
      content, status, author_type, version, payload
    ) VALUES ($1, $2, 'evidencePermissions', 'evidencePermission', $3,
      'evidencePermissions', '[]', '', '', '', 2, $4::jsonb)
  `, [accountId, JSON.stringify(["evidencePermissions", sourceKey]), sourceKey, JSON.stringify(permission)]);
  const denied = (await queries.materialContext(consumer.id))!.snapshot;
  assert.equal(contextDerivedOutputAllowed(denied, answer, accountId, expected), false);
  await database.query(`
    DELETE FROM for_now.store_objects
    WHERE account_id = $1 AND collection = 'evidencePermissions' AND id = $2
  `, [accountId, sourceKey]);
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{content}', '"变更来源"'),
      version = version + 1
    WHERE account_id = $1 AND collection = 'captures' AND id = 'source'
  `, [accountId]);
  const changed = (await queries.materialContext(consumer.id))!.snapshot;
  assert.equal(contextDerivedOutputAllowed(changed, answer, accountId, expected), false);
  console.log("THOUGHT_MATERIAL_DEPENDENCIES " + JSON.stringify({
    checks: ["producer identity", "consumed receipt closure", "prompt/hash parity",
      "nested body ignored", "producer audit pool ignored", "producer fingerprint rejected",
      "permission revocation rejected", "source mutation rejected"],
    firstReadQueries
  }));
}
