/**
 * 首次全池与冻结资料的真实 PostgreSQL 等价验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：合成来源；比较实际领域 prompt/hash，拒绝静默丢来源和重新抽样。
 */
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordStore, StoreMapping } from "../src/shared/persistence/record-command-types.mjs";
import { createTaskPreparationQueries, rebuildTaskCollections } from "../src/app/record-commands/task-preparation.mjs";
import type { ObjectRow } from "../src/shared/persistence/record-command-types.mjs";
import { createTaskMaterialAssembly } from "../src/app/record-commands/task-materials.mjs";
import { createTaskTrendAssembly } from "../src/app/record-commands/task-trend.mjs";
import { runThoughtUnknownSourcesPostgresChecks } from "./thought-unknown-sources-postgres-checks.mjs";
import { runThoughtMaterialDependenciesPostgresChecks } from "./thought-material-dependencies-postgres-checks.mjs";
import { runThoughtLegacyContextPostgresChecks } from "./thought-legacy-context-postgres-checks.mjs";
import { runThoughtScoreIndexPostgresChecks } from "./thought-score-index-postgres-checks.mjs";
import { runThoughtCalendarBoundariesPostgresChecks } from "./thought-calendar-boundaries-postgres-checks.mjs";

/** 同一输入的全快照和查询装配必须生成相同上下文。 @since unreleased */
export async function runThoughtMaterialsPostgresChecks(database: QueryClient, mapping: StoreMapping) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const { legalImportanceSources, importanceSourcePermissionKeys } = await import(path.resolve("src/app/task-context.mjs"));
  const { parseEvidenceSourceKey } = await import(path.resolve("src/modules/user-model/index.mjs"));
  const { createAiTaskTargets } = await import(path.resolve("src/app/ai-task-targets.mjs"));
  const { createThoughtTaskTarget } = await import(path.resolve("src/modules/thoughts/index.mjs"));
  const accountId = "materials-parity";
  const now = () => "2026-10-19T00:00:00.000Z";
  const store: RecordStore = {
    thoughts: [
      { id: "root", type: "question", authorType: "user", content: "怎样保持读书习惯？", version: 1,
        remarks: [{ id: "remark", text: "试过睡前阅读", version: 1 }],
        followUps: [{ id: "followup", question: "怎样持续？", version: 1 }] },
      { id: "learning-root", type: "question", authorType: "user", content: "学习根", version: 1,
        followUps: Array.from({ length: 90 }, (_, n) => ({
            id: `learning-${n}`, question: `学习问题${n}`, answer: `亲自回答${n}`,
            authorType: "user", version: 1
        })) },
      { id: "idea", relatedTo: "root", type: "idea", content: "从十分钟开始", authorType: "user", version: 1 },
      { id: "remark", type: "question", content: "同名顶层不能代替备注", authorType: "user", version: 1 }
    ],
    captures: [
      ...Array.from({ length: 130 }, (_, n) => ({
        id: `denied-${String(n).padStart(4, "0")}`, version: 1, content: "拒绝上下文",
        authorType: "user", occurredAt: "2026-10-18T00:00:00.000Z"
      })),
      ...Array.from({ length: 510 }, (_, n) => ({
      id: `capture-${String(n).padStart(4, "0")}`, version: 1, content: `第${n}条读书记录`,
      authorType: "user", occurredAt: "2026-10-18T00:00:00.000Z"
      }))
    ],
    books: [{ id: "book", version: 1, notes: [{ id: "note", type: "thought", content: "书中启发", version: 1 }] }],
    actions: Array.from({ length: 60 }, (_, n) => ({
      id: `action-${n}`, title: `行动${n}`, status: "done", version: 1,
      completionFeedback: { learningAllowed: true, outcome: "helpful", note: `反馈${n}` }
    })),
    evidencePermissions: [],
    evidenceSources: [],
    perceptionEvents: [],
    userClaims: [],
    aiTasks: [{ id: "task", kind: "thoughtAnswer", resourceType: "thought", targetId: "root",
      status: "running", createdAt: now(), clientRequestId: "materials-request", version: 1 }]
  };
  const permissionKey = JSON.stringify(["capture", "capture-0001", "", ""]);
  store.evidencePermissions.push({
    id: permissionKey, accountId, sourceKey: permissionKey, revision: 2,
    contextAllowed: false, learningAllowed: false, updatedAt: now()
  });
  for (const capture of store.captures.filter(item => item.id.startsWith("denied-"))) {
    const key = JSON.stringify(["capture", capture.id, "", ""]);
    store.evidencePermissions.push({
      id: key, accountId, sourceKey: key, revision: 1,
      contextAllowed: false, learningAllowed: false, updatedAt: now()
    });
  }
  for (const followUp of store.thoughts[1].followUps as { id: string }[]) {
    for (const type of ["followup-question", "followup-answer"]) {
      const key = JSON.stringify(["thought", followUp.id, "learning-root", `${type}:${followUp.id}`]);
      store.evidencePermissions.push({
        id: key, accountId, sourceKey: key, revision: 1,
        contextAllowed: true, learningAllowed: true, updatedAt: now()
      });
    }
  }
  const scoreSource = store.captures.find(item => item.id === "capture-0010")!;
  const validScore = {
    accountId, sourceKey: JSON.stringify(["capture", scoreSource.id, "", ""]),
    sourceVersion: 1,
    contentSha256: crypto.createHash("sha256").update(scoreSource.content!).digest("hex"),
    scoringVersion: "importance-score.v1", kind: "correction", score: 99,
    reasons: ["explicit_importance"], generatedAt: now()
  };
  store.importanceScores = [
    ...Array.from({ length: 6000 }, (_, index) => ({
      ...validScore, sourceKey: JSON.stringify(["capture", `score-noise-${index}`, "", ""])
    })),
    { ...validScore, sourceVersion: 2 },
    validScore
  ] as unknown as RecordStore["importanceScores"];
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  const trace: { sql: string; rows: number; bytes: number }[] = [];
  const scorePlans: unknown[] = [];
  const queryRecords = async <Result,>(operation: (context: { client: QueryClient; accountId: string }) => Promise<Result>) => {
    await database.query("BEGIN");
    try {
      await database.query("SET LOCAL ROLE runtime_data");
      await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
      const client: QueryClient = {
        async query<Row>(sql: string, values?: unknown[]) {
          const result = await database.query<Row>(sql, values);
          trace.push({ sql, rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
          if (sql.includes("for_now.importance_score_index")) {
            const explained = await database.query(
              "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values
            );
            scorePlans.push(explained.rows[0]["QUERY PLAN"]);
          }
          return result;
        }
      };
      const value = await operation({ client, accountId });
      await database.query("COMMIT");
      return value;
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  };
  const queries = createTaskPreparationQueries({
    queryRecords, mapping, onboardingPermissionKeys: () => [], modelInputHash: () => "",
    materialContext: createTaskMaterialAssembly({
      mapping, legalSources: legalImportanceSources, permissionKeys: importanceSourcePermissionKeys,
      parseSourceKey: parseEvidenceSourceKey
    })
  });
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const targets = createAiTaskTargets({
    thoughts: createThoughtTaskTarget({ createId: () => "unused", now }),
    getAccountId: () => accountId, hash, now
  });
  const initial = (await queries.materialContext("task"))!;
  assert.ok(Object.isFrozen(initial.snapshot.thoughts[0]));
  assert.deepEqual(initial.snapshot.importanceScores, [validScore],
    "only current eligible source scores may cross the field projection");
  const scoreReads = trace.filter(item => item.sql.includes("for_now.importance_score_index"));
  assert.equal(scoreReads.length, 1);
  assert.ok(scoreReads[0].bytes < 1000, "unrelated and stale scores must remain in PostgreSQL");
  const inspectScores = (value: unknown): number => {
    if (!value || typeof value !== "object") return 0;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + inspectScores(item), 0);
    const plan = value as Record<string, unknown>;
    const scanned = plan["Relation Name"] === "importance_score_index"
      ? Number(plan["Actual Loops"]) * (
          Number(plan["Actual Rows"]) + Number(plan["Rows Removed by Filter"] || 0) + 1
        )
      : 0;
    if (plan["Relation Name"] === "importance_score_index") {
      assert.equal(plan["Index Name"], "importance_score_source_idx");
    }
    return scanned + Object.values(plan).reduce<number>((sum, item) => sum + inspectScores(item), 0);
  };
  // EXPLAIN rounds per-loop averages. One extra row per loop is a conservative
  // bound; never interpret a displayed zero across many probes as zero work.
  assert.ok(inspectScores(scorePlans) <= initial.snapshot.taskRawMaterials.length * 2,
    "score lookup must remain bounded by requested source probes");
  assert.deepEqual(
    initial.snapshot.taskRawMaterials.map(item => item.sourceKey).sort(),
    legalImportanceSources(store, accountId).map((item: { sourceKey: string }) => item.sourceKey).sort()
  );
  assert.ok(initial.snapshot.taskRawMaterials.length > 500, "key batch cannot truncate the legal pool");
  const full = targets.prepare(store, store.aiTasks[0]);
  const assembled = targets.prepare(initial.snapshot, initial.snapshot.aiTasks[0]);
  assert.equal(assembled.prompt, full.prompt);
  assert.equal(assembled.inputHash, full.inputHash);
  assert.deepEqual(assembled.contextReceipt.currentMaterial, full.contextReceipt.currentMaterial);
  const plan = assembled.contextReceipt.importanceSelectionPlan;
  const task = { ...store.aiTasks[0], importanceSelectionPlan: plan };
  await database.query(`
    UPDATE for_now.store_objects SET payload=$3::jsonb
    WHERE account_id=$1 AND object_key=$2
  `, [accountId, JSON.stringify(["aiTasks", "task"]), JSON.stringify(task)]);
  trace.length = 0;
  const frozen = (await queries.materialContext("task"))!;
  const frozenWork = targets.prepare(frozen.snapshot, frozen.snapshot.aiTasks[0]);
  assert.equal(frozenWork.prompt, full.prompt);
  assert.equal(frozenWork.inputHash, full.inputHash);
  assert.ok(frozen.snapshot.taskRawMaterials.length < 50);
  assert.ok(trace.every(item => !item.sql.includes("for_now.importance_score_index")));
  assert.ok(trace.reduce((sum, item) => sum + item.rows, 0) < 100);
  const frozenMetrics = {
    queries: trace.length,
    rows: trace.reduce((sum, item) => sum + item.rows, 0),
    bytes: trace.reduce((sum, item) => sum + item.bytes, 0)
  };
  await trendProjectionChecks(database, queryRecords, mapping, store, accountId, now, hash);
  const selected = plan.sources.map((item: { sourceKey: string }) => parseEvidenceSourceKey(item.sourceKey))
    .find((ref: { resourceType: string }) => ref.resourceType === "capture");
  assert.ok(selected, "fixture must exercise a frozen capture source");
  await database.query(`
    UPDATE for_now.store_objects SET payload=jsonb_set(payload,'{content}','"来源改变"'),version=version+1
    WHERE account_id=$1 AND collection='captures' AND id=$2
  `, [accountId, selected.resourceId]);
  const changed = (await queries.materialContext("task"))!;
  assert.equal(targets.prepare(changed.snapshot, changed.snapshot.aiTasks[0]), null);
  console.log("THOUGHT_MATERIAL_FROZEN_PARITY " + JSON.stringify({
    pool: initial.snapshot.taskRawMaterials.length,
    scoreRowUpperBound: inspectScores(scorePlans),
    frozen: frozenMetrics,
    checks: ["full pool", "nested identity", "permission denial", "prompt/hash parity", "frozen selected reads", "selected mutation rejected"]
  }));
  await trendCalendarScaleChecks(database, mapping, now, hash);
  await runThoughtUnknownSourcesPostgresChecks(database, mapping);
  await runThoughtMaterialDependenciesPostgresChecks(database, mapping);
  await runThoughtLegacyContextPostgresChecks(database, mapping);
  await runThoughtScoreIndexPostgresChecks(database);
  await runThoughtCalendarBoundariesPostgresChecks(database);
}

async function trendCalendarScaleChecks(
  database: QueryClient, mapping: StoreMapping, now: () => string, hash: (value: string) => string
) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const { createRecordCompressionService } = await import(path.resolve("src/app/record-compressions.mjs"));
  const { importanceSourcePermissionKeys } = await import(path.resolve("src/app/task-context.mjs"));
  const { sourceLocalDates } = await import(path.resolve("src/app/record-compression-context.mjs"));
  const {
    buildRecordCompressionInput, parseRecordCompressionOutput,
    RECORD_COMPRESSION_PROMPT_VERSION, RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION, recordCompressionWindow
  } = await import(path.resolve("src/modules/record-compressions/index.mjs"));
  const { taskContextSourcePermission } = await import(path.resolve("src/app/task-context.mjs"));
  const accountId = "trend-calendar-scale";
  const store: RecordStore = {
    captures: [
      { id: "recent", content: "当前原文", occurredAt: "2026-10-18T00:00:00Z", version: 1 },
      { id: "old", content: "历史原文", occurredOn: "2026-09-26", eventTimePrecision: "date", version: 1 },
      { id: "unknown", content: "", eventTimePrecision: "unknown", version: 1 }
    ],
    thoughts: [{
      id: "old-parent", type: "question", authorType: "user", content: "旧根",
      occurredAt: "2025-01-01T00:00:00Z", version: 1,
      remarks: [{ id: "inherited", text: "继承旧日期", version: 1 }],
      followUps: [{
        id: "new-child", question: "近期追问", answer: "近期回答",
        questionOccurredAt: "2026-10-17T00:00:00Z", answeredAt: "2026-10-18T00:00:00Z",
        authorType: "user", version: 1
      }]
    }],
    evidencePermissions: [], recordCompressions: [], aiTasks: []
  };
  const payload = {
    operation: "daily", localDate: "2026-09-26", timezone: "Pacific/Honolulu",
    promptVersion: "synthetic-old-version", sourceManifestHash: "a".repeat(64)
  };
  store.aiTasks.push({
    id: "old-failure", kind: "recordCompression", status: "failed", payload,
    requestedInputHash: hash(JSON.stringify({
      accountId: hash(`account:${accountId}`).slice(0, 32),
      localDate: payload.localDate, timezone: payload.timezone,
      promptVersion: payload.promptVersion, sourceManifestHash: payload.sourceManifestHash
    })), version: 1
  });
  const historicalPayload = {
    operation: "historicalSupplement", localDate: "2026-09-26", timezone: "Pacific/Honolulu",
    windowStart: "2026-09-20", windowEnd: "2026-09-26",
    promptVersion: "synthetic-old-version", sourceManifestHash: "b".repeat(64), batchIndex: 0
  };
  store.aiTasks.push({
    id: "old-historical-failure", kind: "recordCompression", status: "failed",
    payload: historicalPayload,
    requestedInputHash: hash(JSON.stringify({
      operation: historicalPayload.operation, accountId, timezone: historicalPayload.timezone,
      promptVersion: historicalPayload.promptVersion,
      windowStart: historicalPayload.windowStart, windowEnd: historicalPayload.windowEnd,
      batchIndex: 0, sourceManifestHash: historicalPayload.sourceManifestHash
    })), version: 1
  });
  store.aiTasks.push({
    id: "old-historical-success", kind: "recordCompression", status: "succeeded",
    payload: historicalPayload, version: 1
  }, {
    id: "other-zone-coverage", kind: "recordCompression", status: "succeeded", version: 1,
    payload: {
      operation: "historicalSupplement", localDate: "2026-10-01",
      timezone: "Pacific/Honolulu", promptVersion: "historical-user-supplement.v1"
    }
  }, {
    id: "current-zone-coverage", kind: "recordCompression", status: "succeeded", version: 1,
    payload: {
      operation: "historicalSupplement", localDate: "2026-10-01",
      timezone: "America/New_York", promptVersion: "historical-user-supplement.v1"
    }
  });
  const window = recordCompressionWindow("2026-10-18", "evening");
  const input = buildRecordCompressionInput(store, {
    accountId, localDate: window.localDate, timezone: window.timezone,
    windowKey: window.windowKey, asOf: now(), promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    hash, sourcePermission: ({ sourceRef }: { sourceRef: unknown }) => (
      taskContextSourcePermission(store, sourceRef, accountId)
    )
  });
  const cited = input.userSources.find((row: { recordId: string }) => row.recordId === "recent");
  assert.ok(cited);
  const summary = parseRecordCompressionOutput({
    schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
    daily: { observations: [{ text: "当前观察", nature: "user_subjective", sourceIds: [cited.sourceId] }],
      metricKeys: [], missing: [] },
    thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
    other: { themes: [], collectedQuotes: [] }, aiReference: [],
    stableUserCandidates: [], conflicts: [], warnings: []
  }, { input, id: "recent-summary", generatedAt: now() });
  Object.assign(summary, {
    localDate: window.localDate, timezone: window.timezone, windowKey: window.windowKey,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    periodStart: window.start, periodEnd: window.endExclusive
  });
  store.recordCompressions.push(summary);
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  await database.query(`
    UPDATE for_now.store_objects SET position = NULL
    WHERE account_id = $1 AND collection = 'aiTasks' AND id = 'old-historical-success'
  `, [accountId]);
  const service = createRecordCompressionService({
    repository: { read: async () => store, update: async () => {} },
    getAccountId: () => accountId, getTimezone: () => "America/New_York",
    now, hash, startDate: "2026-09-25"
  });
  const trend = createTaskTrendAssembly({
    mapping, permissionKeys: importanceSourcePermissionKeys,
    createInputProjection: service.createTrendInputProjection,
    readRequirements: service.trendReadRequirements,
    project: service.getCurrentTrend,
    sourceDates: sourceLocalDates, timezones: service.trendTimezones, now
  });
  const measure = async () => {
    const trace: { sql: string; rows: number; bytes: number }[] = [];
    const plans: unknown[] = [];
    await database.query("BEGIN");
    try {
      await database.query("SET LOCAL ROLE runtime_data");
      await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
      const client: QueryClient = {
        async query<Row>(sql: string, values?: unknown[]) {
          const result = await database.query<Row>(sql, values);
          trace.push({ sql, rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
          if (sql.includes("source_calendar_hints &&") || sql.includes("source_occurrence_may_be_unknown")
            || sql.includes("compression_task_timezone = $2")) {
            const explained = await database.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values);
            plans.push(explained.rows[0]["QUERY PLAN"]);
          }
          return result;
        }
      };
      const actual = await trend.trendContext({ client, accountId }, {
        id: "probe", kind: "thoughtAnswer", createdAt: now()
      });
      const rows = await database.query<ObjectRow>(`
        SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
          field, position, child_fields AS "childFields", payload, content, status, version
        FROM for_now.store_objects WHERE account_id = $1
      `, [accountId]);
      assert.deepEqual(actual, service.getCurrentTrend(rebuildTaskCollections(mapping, rows.rows), now()));
      await database.query("COMMIT");
      return {
        queries: trace.length, rows: trace.reduce((sum, row) => sum + row.rows, 0),
        bytes: trace.reduce((sum, row) => sum + row.bytes, 0), plans
      };
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  };
  const before = await measure();
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["thoughts","dated-noise-' || n || '"]', 'thoughts', 'thought',
      'dated-noise-' || n, 'thoughts', NULL, '["followUps"]', '旧思绪', '', 'user', 1,
      jsonb_build_object('id', 'dated-noise-' || n, 'type', 'question', 'content', '旧思绪',
        'occurredAt', '2024-01-01T00:00:00Z', 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, parent_key, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["thoughts","dated-noise-' || n || '","followUps","child"]', 'thoughts',
      'thoughtFollowUp', 'child', '["thoughts","dated-noise-' || n || '"]', 'followUps',
      0, '[]', '旧追问', '', 'user', 1,
      jsonb_build_object('id', 'child', 'question', '旧追问', 'answer', '旧回答',
        'questionOccurredAt', '2024-01-01T00:00:00Z',
        'answeredAt', '2024-01-02T00:00:00Z', 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["captures","calendar-noise-' || n || '"]', 'captures', 'capture',
      'calendar-noise-' || n, 'captures', NULL, '[]', '旧原文', '', '', 1,
      jsonb_build_object('id', 'calendar-noise-' || n, 'content', '旧原文',
        'occurredAt', '2024-01-01T00:00:00Z', 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query("ANALYZE for_now.store_objects");
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["recordCompressions","summary-noise-' || n || '"]',
      'recordCompressions', 'recordCompression', 'summary-noise-' || n,
      'recordCompressions', NULL, '[]', '', 'invalidated', '', 1,
      jsonb_build_object('id', 'summary-noise-' || n, 'localDate', '2024-01-01',
        'status', 'invalidated', 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["aiTasks","task-noise-' || n || '"]',
      'aiTasks', 'aiTask', 'task-noise-' || n, 'aiTasks', NULL, '[]', '', 'succeeded', '', 1,
      jsonb_build_object('id', 'task-noise-' || n, 'kind', 'recordCompression', 'status', 'succeeded',
        'payload', jsonb_build_object('operation', 'daily', 'localDate', '2024-01-01'), 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  for (const noise of [
    { timezone: "America/New_York", localDate: "2024-01-01", promptVersion: "historical-user-supplement.v1" },
    { timezone: "Asia/Tokyo", localDate: "2026-10-18", promptVersion: "historical-user-supplement.v1" },
    { timezone: "America/New_York", localDate: "2026-10-18", promptVersion: "obsolete-version" }
  ]) {
    await database.query(`
      INSERT INTO for_now.store_objects(
        account_id, object_key, collection, kind, id, field, position,
        child_fields, content, status, author_type, version, payload
      ) SELECT $1, '["aiTasks","historical-noise-' || $2::text || '-' || n || '"]',
        'aiTasks', 'aiTask', 'historical-noise-' || $2::text || '-' || n,
        'aiTasks', NULL, '[]', '', 'succeeded', '', 1,
        jsonb_build_object('id', 'historical-noise-' || $2::text || '-' || n,
          'kind', 'recordCompression', 'status', 'succeeded', 'version', 1,
          'payload', $3::jsonb || '{"operation":"historicalSupplement"}'::jsonb)
      FROM generate_series(1, 10000) n
    `, [accountId, noise.timezone + noise.localDate + noise.promptVersion, JSON.stringify(noise)]);
  }
  await database.query("ANALYZE for_now.store_objects");
  const after = await measure();
  assert.equal(after.rows, before.rows, "unrelated history must not increase returned source rows");
  assert.equal(after.bytes, before.bytes, "unrelated history must not increase returned source bytes");
  const inspect = (value: unknown): number => {
    if (!value || typeof value !== "object") return 0;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + inspect(item), 0);
    const plan = value as Record<string, unknown>;
    const scanned = plan["Relation Name"] === "store_objects"
      ? Number(plan["Actual Loops"]) * (Number(plan["Actual Rows"]) + Number(plan["Rows Removed by Filter"] || 0))
      : 0;
    return scanned + Object.values(plan).reduce<number>((sum, item) => sum + inspect(item), 0);
  };
  const scanned = inspect(after.plans);
  console.log("THOUGHT_TREND_CALENDAR_SCALE " + JSON.stringify({ before, after, scanned }));
  assert.ok(scanned < 200, "calendar lookup must not scan unrelated history");
  await database.query(`
    UPDATE for_now.store_objects SET payload = jsonb_set(payload, '{content}', '"编辑后原文"'),
      version = version + 1
    WHERE account_id = $1 AND object_key = '["captures","recent"]'
  `, [accountId]);
  await measure();
}

async function trendProjectionChecks(
  database: QueryClient,
  queryRecords: <Result>(operation: (context: { client: QueryClient; accountId: string }) => Promise<Result>) => Promise<Result>,
  mapping: StoreMapping, store: RecordStore, accountId: string,
  now: () => string, hash: (value: string) => string
) {
  const { createRecordCompressionService } = await import(path.resolve("src/app/record-compressions.mjs"));
  const { taskContextSourcePermission, importanceSourcePermissionKeys } = await import(path.resolve("src/app/task-context.mjs"));
  const { sourceLocalDates } = await import(path.resolve("src/app/record-compression-context.mjs"));
  const {
    buildRecordCompressionInput, recordCompressionWindow, RECORD_COMPRESSION_PROMPT_VERSION
  } = await import(path.resolve("src/modules/record-compressions/index.mjs"));
  const { personalContextProjection, personalContextRecordSelection } = await import(
    path.resolve("src/app/personal-context.mjs")
  );
  const service = createRecordCompressionService({
    repository: { read: async () => store, update: async () => {} },
    getAccountId: () => accountId, getTimezone: () => "America/New_York",
    now, hash, startDate: "2026-09-25"
  });
  const projected = service.createTrendInputProjection(accountId, now());
  for (const capture of store.captures) projected.add({ captures: [capture], evidencePermissions: store.evidencePermissions });
  projected.add({ thoughts: store.thoughts, books: store.books, evidencePermissions: store.evidencePermissions });
  const extra: RecordStore = {
    thoughts: [{ id: "dated-root", type: "question", content: "日期根", authorType: "user",
      occurredAt: "2026-10-17T12:00:00Z", version: 1,
      remarks: [{ id: "unknown", text: "没有发生时间", createdAt: "2026-10-18T00:00:00Z" }],
      followUps: [{ id: "dual", question: "当日问题", answer: "次日回答", authorType: "user",
        questionOccurredAt: "2026-10-17T12:00:00Z", answerOccurredAt: "2026-10-18T03:00:00Z",
        answeredAt: "2026-10-18T03:00:00Z", version: 1 }] }],
    captures: [
      { id: "old", content: "历史日期", authorType: "user", occurredOn: "2026-09-26", eventTimePrecision: "date" },
      { id: "empty-unknown", content: "", eventTimePrecision: "unknown" },
      { id: "transcribed", content: "原文", occurredOn: "2026-10-18", eventTimePrecision: "date",
        transcription: { status: "ready", rawText: "逐字稿", polishedText: "整理稿" } }
    ],
    dailyRecords: [{ id: "metric", type: "weight", measuredWeight: 60, occurredAt: "2026-10-18T00:00:00Z" }],
    evidencePermissions: store.evidencePermissions
  };
  projected.add(extra);
  projected.seal();
  const full: RecordStore = {
    ...store,
    thoughts: [...store.thoughts, ...extra.thoughts],
    captures: [...store.captures, ...extra.captures],
    dailyRecords: extra.dailyRecords
  };
  for (const timezone of service.trendTimezones()) {
    for (const localDate of ["2026-09-26", "2026-10-17", "2026-10-18", "2026-10-19"]) {
      for (const windowKey of [
        "", ...(timezone === "Asia/Shanghai"
          ? ["morning", "evening"].map(slot => recordCompressionWindow(localDate, slot).windowKey) : [])
      ]) {
        const options = { accountId, asOf: now(), timezone, localDate, windowKey,
          hash, promptVersion: RECORD_COMPRESSION_PROMPT_VERSION };
        const expected = buildRecordCompressionInput(full, {
          ...options, sourcePermission: ({ sourceRef }: { sourceRef: unknown }) => (
            taskContextSourcePermission(full, sourceRef, accountId)
          )
        });
        const actual = projected.inputForDate(options);
        assert.deepEqual(actual, expected, `paged domain input differs: ${timezone} ${localDate} ${windowKey}`);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      }
    }
  }
  const trend = createTaskTrendAssembly({
    mapping, permissionKeys: importanceSourcePermissionKeys,
    createInputProjection: service.createTrendInputProjection,
    readRequirements: service.trendReadRequirements,
    sourceDates: sourceLocalDates, timezones: service.trendTimezones,
    legacySelection: personalContextRecordSelection,
    project: service.getCurrentTrend, now
  });
  const actualTrend = await queryRecords(context => trend.trendContext(context, store.aiTasks[0]));
  assert.deepEqual(actualTrend, service.getCurrentTrend(store, now()));
  const legacyRows = new Map<string, ObjectRow>();
  await queryRecords(context => trend.legacyContext(context, {
    read: async () => [],
    include: row => { legacyRows.set(row.objectKey, row); },
    rows: () => [...legacyRows.values()]
  }));
  const legacySnapshot = rebuildTaskCollections(mapping, [...legacyRows.values()]);
  for (const permissionPurpose of ["context", "learning"]) {
    const options = { generatedAt: now(), permissionPurpose };
    const actual = personalContextProjection(legacySnapshot, options);
    const expected = personalContextProjection(store, options);
    assert.equal(actual.prompt, expected.prompt);
    assert.deepEqual(actual.receipt, expected.receipt);
  }
  const contextRows = new Map<string, ObjectRow>();
  let captureRows = 0;
  const capturePlans: unknown[] = [];
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["aiTasks","legacy-noise-' || n || '"]', 'aiTasks', 'aiTask',
      'legacy-noise-' || n, 'aiTasks', NULL, '[]', '', 'succeeded', '', 1,
      jsonb_build_object('id', 'legacy-noise-' || n, 'kind', 'thoughtAnswer', 'status', 'succeeded')
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query("ANALYZE for_now.store_objects");
  await queryRecords(context => trend.legacyContext({
    ...context,
    client: {
      async query<Row>(sql: string, values?: unknown[]) {
        const result = await context.client.query<Row>(sql, values);
        if (values?.[1] === "captures" && sql.includes("parent_key IS NULL")) {
          captureRows += result.rows.filter(row => (row as ObjectRow).collection === "captures").length;
          if (sql.includes("LIMIT")) {
            const plan = await context.client.query<{ "QUERY PLAN": unknown }>(
              "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values
            );
            capturePlans.push(plan.rows[0]["QUERY PLAN"]);
          }
        }
        return result;
      }
    }
  }, {
    read: async () => [],
    include: row => { contextRows.set(row.objectKey, row); },
    rows: () => [...contextRows.values()]
  }, ["context"]));
  assert.ok(captureRows <= 100, "context must stop once its permitted prefix is complete");
  const summarizePlan = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(summarizePlan);
    const plan = value as Record<string, unknown>;
    const current = plan["Relation Name"] ? [{
      relation: plan["Relation Name"], alias: plan.Alias,
      index: plan["Index Name"] || "", loops: plan["Actual Loops"],
      rows: plan["Actual Rows"], filtered: plan["Rows Removed by Filter"] || 0
    }] : [];
    return [...current, ...Object.values(plan).flatMap(summarizePlan)];
  };
  console.log("THOUGHT_LEGACY_POSITION_PLAN " + JSON.stringify(summarizePlan(capturePlans)));
  assert.ok(JSON.stringify(capturePlans).includes("store_objects_context_position_idx"),
    "legacy positioned reads need the actual prefix index");
  for (const row of summarizePlan(capturePlans) as Record<string, unknown>[]) {
    if (row.alias === "permission") {
      assert.ok(Number(row.filtered) <= 1, "permission lookup must use its exact source identity");
    }
  }
  await learningPrefixChecks(database, queryRecords, mapping, trend, accountId, now);
  assert.deepEqual(
    personalContextProjection(rebuildTaskCollections(mapping, [...contextRows.values()]), {
      generatedAt: now()
    }).receipt,
    personalContextProjection(store, { generatedAt: now() }).receipt
  );
  for (const capture of store.captures.filter(item => item.id.startsWith("capture-")).slice(0, 90)) {
    const key = JSON.stringify(["capture", capture.id, "", ""]);
    await database.query(`
      INSERT INTO for_now.store_objects(
        account_id, object_key, collection, kind, id, parent_key, field,
        position, child_fields, content, status, author_type, version, payload, lifecycle, tombstone
      ) VALUES ($1, $2, 'evidencePermissions', 'evidencePermission', $3, NULL,
        'evidencePermissions', NULL, '[]', '', '', '', 1, $4::jsonb, 'formal', false)
      ON CONFLICT (account_id, object_key) DO UPDATE SET payload = EXCLUDED.payload
    `, [accountId, JSON.stringify(["evidencePermissions", key]), key,
      JSON.stringify({ id: key, accountId, sourceKey: key, revision: 3,
        contextAllowed: false, learningAllowed: false, updatedAt: now() })]);
  }
  const fullRows = (await database.query<ObjectRow>(`
    SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
      field, position, child_fields AS "childFields", payload, content, status, version
    FROM for_now.store_objects WHERE account_id = $1
  `, [accountId])).rows;
  const fullRevoked = rebuildTaskCollections(mapping, fullRows);
  contextRows.clear();
  await queryRecords(context => trend.legacyContext(context, {
    read: async () => [],
    include: row => { contextRows.set(row.objectKey, row); },
    rows: () => [...contextRows.values()]
  }, ["context"]));
  assert.deepEqual(
    personalContextProjection(rebuildTaskCollections(mapping, [...contextRows.values()]), {
      generatedAt: now()
    }).receipt,
    personalContextProjection(fullRevoked, { generatedAt: now() }).receipt
  );
  assert.ok([...contextRows.values()].filter(row => row.collection === "captures").length <= 30,
    "legacy output must include only its necessary capture prefix");
  // Return fixture permissions to their initial state before the frozen mutation assertion.
  await database.query(`
    DELETE FROM for_now.store_objects
    WHERE account_id = $1 AND collection = 'evidencePermissions'
      AND id = ANY($2::text[])
  `, [accountId, store.captures.filter(item => item.id.startsWith("capture-"))
    .slice(0, 90).filter(item => item.id !== "capture-0001")
    .map(item => JSON.stringify(["capture", item.id, "", ""]))]);
  await database.query(`
    UPDATE for_now.store_objects SET payload = $3::jsonb
    WHERE account_id = $1 AND collection = 'evidencePermissions' AND id = $2
  `, [accountId, JSON.stringify(["capture", "capture-0001", "", ""]),
    JSON.stringify(store.evidencePermissions[0])]);
  await database.query(`
    UPDATE for_now.store_objects SET position = NULL
    WHERE account_id = $1 AND collection IN ('thoughts', 'captures', 'books')
  `, [accountId]);
  const recentRows = (await database.query<ObjectRow>(`
    SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
      field, position, child_fields AS "childFields", payload, content, status, version
    FROM for_now.store_objects WHERE account_id = $1
  `, [accountId])).rows;
  contextRows.clear();
  await queryRecords(context => trend.legacyContext(context, {
    read: async () => [],
    include: row => { contextRows.set(row.objectKey, row); },
    rows: () => [...contextRows.values()]
  }, ["context"]));
  assert.deepEqual(
    personalContextProjection(rebuildTaskCollections(mapping, [...contextRows.values()]), {
      generatedAt: now()
    }).receipt,
    personalContextProjection(rebuildTaskCollections(mapping, recentRows), { generatedAt: now() }).receipt
  );
  console.log("THOUGHT_LEGACY_PREFIX " + JSON.stringify({
    captureRows, selectedCaptureRows: [...contextRows.values()]
      .filter(row => row.collection === "captures").length,
    checks: ["130 denied prefix", "permission revoked", "legacy position", "recent ordering",
      "prompt/receipt parity", "database prefix index"],
    plans: summarizePlan(capturePlans)
  }));
  console.log("Thought trend projection parity passed: daily/slots, unknown occurrence, nested dates, permissions, historical timezone and full PostgreSQL trend.");
  console.log("Thought legacy projection PostgreSQL parity passed: original order and context/learning permissions.");
}

async function learningPrefixChecks(
  database: QueryClient,
  queryRecords: <Result>(operation: (context: { client: QueryClient; accountId: string }) => Promise<Result>) => Promise<Result>,
  mapping: StoreMapping, trend: ReturnType<typeof createTaskTrendAssembly>,
  accountId: string, now: () => string
) {
  const { personalContextProjection } = await import(path.resolve("src/app/personal-context.mjs"));
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["thoughts","learning-noise-' || n || '"]', 'thoughts', 'thought',
      'learning-noise-' || n, 'thoughts', NULL, '[]', '没有学习许可', '', 'user', 1,
      jsonb_build_object('id', 'learning-noise-' || n, 'type', 'idea',
        'authorType', 'user', 'content', '没有学习许可', 'version', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  const directId = "learning-direct";
  const directKey = JSON.stringify(["thought", directId, directId, `question:${directId}`]);
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) VALUES ($1, $2, 'thoughts', 'thought', $3, 'thoughts', 100,
      '[]', '较新的学习原文', '', 'user', 1, $4::jsonb),
      ($1, $5, 'evidencePermissions', 'evidencePermission', $6, 'evidencePermissions', NULL,
      '[]', '', '', '', 1, $7::jsonb)
  `, [accountId, JSON.stringify(["thoughts", directId]), directId,
    JSON.stringify({ id: directId, type: "question", authorType: "user",
      content: "较新的学习原文", occurredAt: "2026-10-18T00:00:00Z", version: 1 }),
    JSON.stringify(["evidencePermissions", directKey]), directKey,
    JSON.stringify({ id: directKey, sourceKey: directKey, accountId,
      contextAllowed: true, learningAllowed: true, revision: 1 })]);
  await database.query("ANALYZE for_now.store_objects");
  const selected = new Map<string, ObjectRow>();
  const plans: Record<string, unknown>[] = [];
  let rootRows = 0;
  await queryRecords(context => trend.legacyContext({
    ...context,
    client: {
      async query<Row>(sql: string, values?: unknown[]) {
        const result = await context.client.query<Row>(sql, values);
        if (values?.[1] === "thoughts" && sql.includes("WITH learning_roots AS MATERIALIZED")) {
          rootRows += result.rows.length;
          const explained = await context.client.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values
          );
          plans.push(explained.rows[0]["QUERY PLAN"][0].Plan);
        }
        return result;
      }
    }
  }, {
    read: async () => [],
    include: row => { selected.set(row.objectKey, row); },
    rows: () => [...selected.values()]
  }, ["learning"]));
  assert.equal(rootRows, 2, "only permitted original text and follow-up roots belong to this pool");
  const fullRows = (await database.query<ObjectRow>(`
    SELECT object_key AS "objectKey", collection, kind, id, parent_key AS "parentKey",
      field, position, child_fields AS "childFields", payload, content, status, version
    FROM for_now.store_objects WHERE account_id = $1
  `, [accountId])).rows;
  const options = { generatedAt: now(), permissionPurpose: "learning" };
  assert.deepEqual(
    personalContextProjection(rebuildTaskCollections(mapping, [...selected.values()]), options).receipt,
    personalContextProjection(rebuildTaskCollections(mapping, fullRows), options).receipt
  );
  let scanned = 0;
  const inspect = (plan: Record<string, unknown>) => {
    if (plan["Relation Name"] === "store_objects" && plan.Alias === "store_objects") {
      scanned += Number(plan["Actual Loops"]) * (
        Number(plan["Actual Rows"]) + Number(plan["Rows Removed by Filter"] || 0)
      );
      assert.ok(String(plan["Index Cond"] || "").includes("object_key")
        && ["Index Scan", "Index Only Scan"].includes(String(plan["Node Type"])),
        "learning roots must use exact object keys");
    }
    for (const child of (plan.Plans || []) as Record<string, unknown>[]) inspect(child);
  };
  for (const plan of plans) inspect(plan);
  console.log("THOUGHT_LEARNING_PREFIX " + JSON.stringify({ rootRows, scanned, plans }));
  assert.ok(scanned <= 100, "learning read must not scan unrelated thought history");
  await database.query(`
    INSERT INTO for_now.store_objects(
      account_id, object_key, collection, kind, id, field, position,
      child_fields, content, status, author_type, version, payload
    ) SELECT $1, '["evidencePermissions",' || to_json(
        jsonb_build_array('thought', 'learning-noise-' || n, 'learning-noise-' || n,
          'question:learning-noise-' || n)::text)::text || ']',
      'evidencePermissions', 'evidencePermission',
      jsonb_build_array('thought', 'learning-noise-' || n, 'learning-noise-' || n,
        'question:learning-noise-' || n)::text,
      'evidencePermissions', NULL, '[]', '', '', '', 1,
      jsonb_build_object(
        'sourceKey', jsonb_build_array('thought', 'learning-noise-' || n,
          'learning-noise-' || n, 'question:learning-noise-' || n)::text,
        'accountId', $1::text, 'learningAllowed', true, 'revision', 1)
    FROM generate_series(1, 10000) n
  `, [accountId]);
  await database.query("ANALYZE for_now.store_objects");
  const scaleRows = new Map<string, ObjectRow>();
  const scalePlans: Record<string, unknown>[] = [];
  let scaleRootRows = 0;
  await queryRecords(context => trend.legacyContext({
    ...context,
    client: {
      async query<Row>(sql: string, values?: unknown[]) {
        const result = await context.client.query<Row>(sql, values);
        if (sql.includes("WITH learning_roots AS MATERIALIZED")) {
          scaleRootRows += result.rows.length;
          const explained = await context.client.query<{
            "QUERY PLAN": { Plan: Record<string, unknown> }[]
          }>(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values
          );
          scalePlans.push(explained.rows[0]["QUERY PLAN"][0].Plan);
        }
        return result;
      }
    }
  }, {
    read: async () => [], include: row => { scaleRows.set(row.objectKey, row); },
    rows: () => [...scaleRows.values()]
  }, ["learning"]));
  assert.ok(scaleRootRows <= 100, "permitted root sorting must not return all source bodies");
  assert.deepEqual(
    personalContextProjection(rebuildTaskCollections(mapping, [...scaleRows.values()]), options).receipt,
    personalContextProjection(rebuildTaskCollections(mapping, fullRows), options).receipt
  );
  let bodyRows = 0;
  const inspectBodies = (plan: Record<string, unknown>) => {
    if (plan["Relation Name"] === "store_objects" && plan.Alias === "store_objects"
      && Number(plan["Plan Width"]) > 200) {
      bodyRows += Number(plan["Actual Rows"]) * Number(plan["Actual Loops"]);
    }
    for (const child of (plan.Plans || []) as Record<string, unknown>[]) inspectBodies(child);
  };
  for (const plan of scalePlans) inspectBodies(plan);
  assert.ok(bodyRows <= 100, "only a page of permitted bodies may precede domain selection");
  console.log("THOUGHT_LEARNING_PERMITTED_SCALE " + JSON.stringify({
    permittedRoots: 10002, returnedRootRows: scaleRootRows, bodyRows,
    limitation: "all permitted root metadata is sorted; bodies load only after paging"
  }));
  await database.query(`
    DELETE FROM for_now.store_objects
    WHERE account_id = $1 AND (
      (collection = 'thoughts' AND (id LIKE 'learning-noise-%' OR id = $2))
      OR (collection = 'evidencePermissions'
        AND (id = $3 OR permission_resource_id LIKE 'learning-noise-%'))
    )
  `, [accountId, directId, directKey]);
}
