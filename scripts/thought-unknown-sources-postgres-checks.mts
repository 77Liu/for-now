/**
 * 未知发生时间的元数据分页、父许可与各槽计数等价验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成来源；未知历史正文不进入投影，全部候选计数保持领域口径。
 */
import assert from "node:assert/strict";
import path from "node:path";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordStore, StoreMapping } from "../src/shared/persistence/record-command-types.mjs";
import { rebuildTaskCollections } from "../src/app/record-commands/task-preparation.mjs";
import { taskTrendUnknownPages } from "../src/app/record-commands/task-trend-sources.mjs";
import { readMaterialPermissions } from "../src/app/record-commands/task-material-sources.mjs";

/** 比较完整领域输入与独立未知候选扫描，包括空槽、跨页父子及拒绝许可。 @since unreleased */
export async function runThoughtUnknownSourcesPostgresChecks(database: QueryClient, mapping: StoreMapping) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const { createRecordCompressionService } = await import(path.resolve("src/app/record-compressions.mjs"));
  const { taskContextSourcePermission } = await import(path.resolve("src/app/task-context.mjs"));
  const { buildRecordCompressionInput, recordCompressionWindow, RECORD_COMPRESSION_PROMPT_VERSION } = await import(
    path.resolve("src/modules/record-compressions/index.mjs")
  );
  const accountId = "unknown-source-parity";
  const asOf = "2026-10-19T00:00:00Z";
  const body = "未知历史原文".repeat(400);
  const store: RecordStore = {
    captures: Array.from({ length: 510 }, (_, index) => ({
      id: `unknown-${index}`, content: body, eventTimePrecision: "unknown", version: 1,
      transcription: { status: "ready", rawText: body, polishedText: body, condensedText: body },
      imageUnderstandings: [{ id: "image", text: body }]
    })),
    thoughts: [
      { id: "unknown-root", type: "question", content: "", version: 1,
        followUps: Array.from({ length: 510 }, (_, index) => ({
          id: `child-${index}`, question: body, answer: body, version: 1
        })) },
      { id: "denied-root", type: "question", content: body, version: 1,
        remarks: [{ id: "remark", text: body }],
        followUps: [{ id: "child", question: body, answer: body }] },
      { id: "dated-root", type: "question", content: body, occurredOn: "2024-01-01", version: 1,
        followUps: [
          { id: "one-unknown", question: body, answer: body, questionOccurredAt: "2024-01-01T00:00:00Z" },
          { id: "both-dated", question: body, answer: body, questionOccurredAt: "2024-01-01T00:00:00Z",
            answerOccurredAt: "2024-01-02T00:00:00Z" }
        ] },
      { id: "disabled-thought", type: "question", content: body, contextAllowed: false }
    ],
    journals: [
      { id: "unknown-journal", content: "", reflections: [{ id: "unknown", content: body }] },
      { id: "denied-journal", content: body, reflections: [{ id: "unknown", answer: body }] },
      { id: "dated-journal", occurredOn: "2024-01-01", reflections: [
        { id: "generated", content: body, generatedAt: "2024-01-01T00:00:00Z" },
        { id: "unknown", content: " ", answer: body }
      ] }
    ],
    checkins: [{ id: "empty" }, { id: "invalid", validationState: "invalid" }],
    dailyRecords: [{ id: "health", type: "weight", recognitionDescription: body, trendAnalysis: body,
      verification: "\t\n　" }],
    quotes: [{ id: "empty" }, { id: "deleted", deletedAt: "2026-10-01" }],
    keepsakes: [{ id: "disabled", contextAllowed: false }, { id: "empty" }],
    evidencePermissions: []
  };
  for (const [type, id, root, target] of [
    ["thought", "denied-root", "denied-root", "question:denied-root"],
    ["journal", "denied-journal", "", ""]
  ]) {
    const key = JSON.stringify([type, id, root, target]);
    store.evidencePermissions.push({
      id: key, sourceKey: key, accountId, revision: 1,
      contextAllowed: false, learningAllowed: false, updatedAt: asOf
    });
  }
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1)", [accountId]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  const service = createRecordCompressionService({
    repository: { read: async () => store, update: async () => {} },
    getAccountId: () => accountId, now: () => asOf
  });
  const projection = service.createTrendInputProjection(accountId, asOf);
  projection.addUnknownSources({});
  let pages = 0;
  let bytes = 0;
  await database.query("BEGIN");
  try {
    await database.query("SET LOCAL ROLE runtime_data");
    await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
    for await (const page of taskTrendUnknownPages({ client: database, accountId })) {
      pages++;
      bytes += Buffer.byteLength(JSON.stringify(page.rows));
      assert.ok(!JSON.stringify(page.rows).includes(body), "unknown scan must not load source body");
      const source = rebuildTaskCollections(mapping, page.rows);
      const permissionKeys = [
        ...(source.thoughts || []).filter(row => row.type === "question").map(row => (
          JSON.stringify(["thought", row.id, row.id, `question:${row.id}`])
        )),
        ...(source.journals || []).map(row => JSON.stringify(["journal", row.id, "", ""]))
      ];
      await readMaterialPermissions({ client: database, accountId }, source, permissionKeys);
      projection.addUnknownSources(source, page.ignoredRoots);
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
  projection.seal();
  assert.ok(pages > 2, "fixture must span pages with an unknown parent and its children");
  for (const localDate of ["2026-10-17", "2026-10-18"]) {
    for (const slot of ["morning", "evening"]) {
      const window = recordCompressionWindow(localDate, slot);
      const options = { accountId, asOf, localDate, timezone: window.timezone,
        windowKey: window.windowKey, promptVersion: RECORD_COMPRESSION_PROMPT_VERSION };
      const expected = buildRecordCompressionInput(store, {
        ...options, sourcePermission: ({ sourceRef }: { sourceRef: unknown }) => (
          taskContextSourcePermission(store, sourceRef, accountId)
        )
      });
      assert.deepEqual(projection.inputForDate(options), expected);
    }
  }
  console.log("THOUGHT_UNKNOWN_METADATA_PARITY " + JSON.stringify({
    pages, bytes, checks: ["empty slots", "parent permission denial", "cross-page counts", "separate follow-up times",
      "generated reflection times", "empty valid candidates", "no historical body"]
  }));
}
