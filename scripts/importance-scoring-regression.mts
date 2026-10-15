/**
 * 重要性评分、冻结选材及真实发送引用的合成回归。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：复用公开入口；不访问生产数据或调用付费模型。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ImportanceScore, ImportanceMaterial } from "../src/shared/ai-context/index.mjs";
import { projectRoot } from "./project-root.mjs";
const root = projectRoot(import.meta.url);
const fromRoot = (file: string) => pathToFileURL(path.join(root, file)).href;
const { createImportanceService, importanceScoreFor, importanceWeight, parseImportanceScores,
  weightedImportanceOrder, createImportanceHttp, createImportanceSelectionPlan, applyImportanceSelectionPlan, estimateInternalTokens }
  = await import(fromRoot(".build/typescript/backend/shared/ai-context/index.mjs")) as typeof import("../src/shared/ai-context/index.mjs");
const { legalImportanceMaterial, legalImportanceSources, createEmptyStore, thoughtTaskCurrentMaterial, workingContextProjection,
  workingContextReceiptFingerprint, workingContextReceiptMatches, compileWorkingContextPrompt, prepareReferenceRequest,
  createStoreNormalizer, supplementalImportanceContext } = await import(fromRoot("src/app/index.mjs"));
const { evidenceSourceKey } = await import(fromRoot("src/modules/user-model/index.mjs"));
const { createTaskLifecycle } = await import(fromRoot("src/modules/tasks/index.mjs"));
const { mapStoreObjects, rebuildStoreObjects } = await import(fromRoot("src/shared/persistence/index.mjs"));
await import(fromRoot("scripts/prompt-test-setup.mjs"));

const { createBusinessId: allocateJobId, withBusinessIdTransaction } = await import(fromRoot(".build/typescript/backend/shared/persistence/business-identifiers.mjs"));

const material = { accountId: "fixture-owner", sourceKey: "fixture-source", version: 1,
  permissionRevision: 0, contentSha256: "a".repeat(64), text: "合成重要性材料", favorite: true };
const sourceRef = { resourceType: "capture", resourceId: "fixture", rootId: "fixture", targetKey: "content", version: 1 };
let allowed = true;
let choice = { model: "deepseek-flash", effort: "none" };
const store = { importanceScores: [] as ImportanceScore[], captures: [{ id: "fixture", content: material.text, version: 1 }] };
const service = createImportanceService({
  repository: { read: async () => store, update: async mutate => mutate(store) },
  resolve: (_store, ref) => allowed && ref?.version === material.version ? material : null,
  modelChoice: async () => choice,
  currentChoice: () => choice,
  hash: value => crypto.createHash("sha256").update(value).digest("hex"),
  now: () => "2026-10-14T00:00:00.000Z", promptText: () => "合成系统提示",
  renderPrompt: (_id, values) => values.input
});
let enqueued = 0;
service.attach({ enqueue: async input => { enqueued += 1; return input; } });
const intent = await service.enqueue([sourceRef], "fixture-operation") as Parameters<typeof service.target.prepare>[1] & { kind: string };
assert.equal(intent.kind, "importanceScoring");
assert.equal(intent.targetId, "fixture");
assert.ok(!JSON.stringify(intent).includes(material.text), "queued task stores references, not original text");
const lifecycle = createTaskLifecycle({ createId: () => "fixture-task", now: () => "2026-10-14T00:00:00.000Z",
  hash: (value: string) => crypto.createHash("sha256").update(value).digest("hex") });
const created = lifecycle.create([], intent, (candidate: Parameters<typeof service.target.prepare>[1]) => service.target.prepare(store, candidate));
assert.equal(created.task.resourceType, "capture");
assert.deepEqual(created.task.payload.sourceRefs, [sourceRef]);
assert.equal(created.task.payload.model, choice.model);
const retryPlan = { scoringVersion: "importance-score.v1", model: choice.model, effort: choice.effort, seed: "original-task", sources: [] };
created.task.importanceSelectionPlan = retryPlan;
created.task.status = "failed";
const retried = lifecycle.retry([created.task], created.task.id,
  (candidate: { importanceSelectionPlan: typeof retryPlan }) => {
    assert.deepEqual(candidate.importanceSelectionPlan, retryPlan);
    return { inputVersion: 1, subtargetVersion: 0, inputHash: "retry-fixture" };
  });
assert.deepEqual(retried.task.importanceSelectionPlan, retryPlan);
const task = created.task;
const work = service.target.prepare(store, task);
assert.ok(work);
assert.equal(work.modelOverride.model, choice.model);
assert.equal(work.auditPrompt, false);
allowed = false;
assert.equal(service.target.prepare(store, task), null);
assert.throws(() => service.target.save(store, work, task, { content: '{"scores":[{"reference":"r1","score":80,"reason":"关注"}]}' }), /撤权/);
assert.equal(store.importanceScores.length, 0);
allowed = true;
for (const invalid of ["invalid", "null", '{"scores":[null]}', '{"scores":[{"reference":"r2","score":80,"reason":"未知"}]}']) {
  assert.throws(() => parseImportanceScores(invalid, [material], choice, "now"), (error: unknown) => (error as { code?: string }).code === "IMPORTANCE_OUTPUT_INVALID");
}
assert.throws(() => service.target.save(store, work, task, { content: '{"scores":[]}' }), /完整请求/);
assert.equal(importanceWeight(material, store.importanceScores).kind, "rule_fallback");
const privateReason = parseImportanceScores(JSON.stringify({ scores: [{ reference: "r1", score: 70,
  reason: material.text }] }), [material], choice, "2026-10-14T00:00:00.000Z");
assert.deepEqual(privateReason[0].reasons, ["model_importance_assessment"]);
assert.ok(!JSON.stringify(privateReason).includes(material.text));
service.target.save(store, work, task, { content: '{"scores":[{"reference":"r1","score":80,"reason":"关注"}]}' });
assert.equal(((await service.enqueue([sourceRef], "cached-operation")) as { cached: boolean }).cached, true);
assert.equal(enqueued, 1);
const oldEffortScore = { ...store.importanceScores[0] };
delete oldEffortScore.effort;
assert.equal(importanceScoreFor(material, [oldEffortScore], choice), null, "legacy unknown effort is not a current model score");
const sameModelNewEffort = { ...choice, effort: "high" };
assert.equal(importanceScoreFor(material, store.importanceScores, sameModelNewEffort), null);
choice = sameModelNewEffort;
assert.equal((await service.enqueue([sourceRef], "changed-effort" ) as { cached?: boolean }).cached, undefined);
assert.equal(service.target.prepare(store, task), null);
choice = { ...choice, effort: "none" };
material.permissionRevision += 1;
assert.equal(service.target.prepare(store, task), null, "re-allow revision invalidates an in-flight scoring intent");
assert.equal(importanceScoreFor(material, store.importanceScores, choice), null);
material.permissionRevision -= 1;
choice = { model: "deepseek-v4-pro", effort: "high" };
assert.equal(service.target.prepare(store, task), null, "changed effective Owner model cannot be bypassed by an old task override");
assert.equal(importanceScoreFor(material, store.importanceScores, choice), null);
assert.equal(((await service.enqueue([sourceRef], "new-model")) as { payload: { model: string } }).payload.model, choice.model);
await service.correct(sourceRef, 25);
assert.equal(importanceScoreFor(material, store.importanceScores, choice)?.score, 25);
assert.equal(((await service.enqueue([sourceRef], "corrected-operation")) as { cached: boolean }).cached, true);
assert.equal(importanceScoreFor({ ...material, version: 2 }, store.importanceScores), null);
const mapped = mapStoreObjects(material.accountId, store);
const restored = rebuildStoreObjects(mapped);
assert.deepEqual(restored.importanceScores, store.importanceScores, "Postgres object mapping roundtrip preserves cache bindings");
const normalizeStore = createStoreNormalizer({ now: () => "2026-10-14T00:00:00.000Z", today: () => "2026-10-14", currentTime: () => Date.parse("2026-10-14T00:00:00.000Z") });
assert.deepEqual(normalizeStore(restored).importanceScores, store.importanceScores);
assert.throws(() => normalizeStore({ importanceScores: [{ ...store.importanceScores[0], text: "原文不得混入缓存" }] }), /importanceScores/);
const candidates = Array.from({ length: 12 }, (_, index) => ({ ...material, sourceKey: `fixture-${index}` }));
const ordered = weightedImportanceOrder([...candidates, candidates[0]], [], "stable-task");
assert.equal(ordered.length, candidates.length);
assert.deepEqual(ordered, weightedImportanceOrder(candidates, [], "stable-task"));
assert.notDeepEqual(ordered, weightedImportanceOrder(candidates, [], "other-task"));
const selectionMaterials = candidates.map((item, index) => ({ ...item, text: "甲".repeat(8000), relevanceScore: index < 5 ? 10 : 0 }));
const plan = createImportanceSelectionPlan(selectionMaterials, [], { seed: "stable-task", model: choice.model, effort: choice.effort });
const selected = applyImportanceSelectionPlan(selectionMaterials, plan);
assert.ok(selected);
assert.equal(selected.length, 10);
assert.ok(plan.sources.every(item => item.kind === "rule_fallback"));
assert.ok(!JSON.stringify(plan).includes("甲"), "frozen plan stores identity and excerpt length only");
const relatedTokens = selected.filter(item => plan.sources.some(row => row.sourceKey === item.sourceKey && row.related))
  .reduce((total, item) => total + estimateInternalTokens(item.text), 0);
assert.ok(relatedTokens <= 5000 * 0.35);
assert.ok(selected.reduce((total, item) => total + estimateInternalTokens(item.text), 0) <= 5000);
assert.deepEqual(applyImportanceSelectionPlan(selectionMaterials, plan), selected, "fixed plan reuses choices without reading later scores");
assert.equal(applyImportanceSelectionPlan(selectionMaterials.map((item, index) => index === 0 ? { ...item, version: 2 } : item),
  { ...plan, sources: [{ ...plan.sources[0], sourceKey: selectionMaterials[0].sourceKey, version: 1 }, ...plan.sources.slice(1).filter(item => item.sourceKey !== selectionMaterials[0].sourceKey)] }), null);
const sourceStore = {
  captures: [{ id: "capture-user", content: "原始捕捉", version: 1, accountId: "fixture-owner" },
    { id: "capture-other", content: "其他账户", version: 1, accountId: "other" },
    { id: "capture-disabled", content: "撤权捕捉", version: 1, contextAllowed: false }],
  thoughts: [{ id: "question", type: "question", content: "原始问题", version: 1,
    followUps: [{ id: "follow-up", question: "用户追问", answer: "模型回答不能进入原文池", authorType: "ai", version: 1 }] },
    { id: "answer", type: "answer", content: "模型根回答", authorType: "ai", version: 1 }],
  chats: [{ id: "chat", message: "用户对话", answer: "模型对话答案", version: 1 }],
  journals: [{ id: "journal-revoked", content: "获准材料", version: 1 }],
  evidencePermissions: [{ accountId: "fixture-owner", sourceKey: evidenceSourceKey({ resourceType: "journal",
    resourceId: "journal-revoked", rootId: "", targetKey: "", version: 1 }),
    contextAllowed: false, learningAllowed: false, revision: 1 }]
};
const pool = legalImportanceSources(sourceStore, "fixture-owner") as ImportanceMaterial[];
assert.equal(pool.length, 4);
assert.ok(pool.some(item => item.text === "用户追问"));
assert.ok(pool.some(item => item.text === "用户对话"));
assert.ok(!pool.some(item => /模型|撤权|其他账户|获准/.test(item.text)));
assert.equal(legalImportanceMaterial(sourceStore, { resourceType: "journal", resourceId: "journal-revoked",
  rootId: "", targetKey: "", version: 1 }, "fixture-owner"), null, "whole-source coordinate aliases cannot bypass the canonical permission");
sourceStore.evidencePermissions.push({ accountId: "fixture-owner", sourceKey: evidenceSourceKey({ resourceType: "thought",
  resourceId: "question", rootId: "question", targetKey: "question:question", version: 1 }),
  contextAllowed: false, learningAllowed: false, revision: 1 });
assert.equal(legalImportanceMaterial(sourceStore, { resourceType: "thought", resourceId: "question",
  rootId: "question", targetKey: "content", version: 1 }, "fixture-owner"), null);
sourceStore.evidencePermissions.pop();
const provenanceStore = createEmptyStore();
provenanceStore.quotes.push({ id: "foreign-quote", content: "外引原文不得成为用户观点", source: "某书",
  version: 1, annotations: [{ id: "own-note", text: "这是我的不同判断", quote: "外引句子", version: 1 },
    { id: "quotation-only", quote: "没有用户批注的引文", version: 1 }] });
provenanceStore.captures.push({ id: "mixed-capture", content: "我的原始文字", answer: "模型回答不得拼入", version: 1 });
provenanceStore.dailyRecords.push({ id: "outlier", type: "heartRate", average: 999, source: "manual",
  trendAnalysis: "模型设备建议不得拼入", version: 1 });
const provenance = legalImportanceSources(provenanceStore, material.accountId) as (ImportanceMaterial & { sourceRef: { resourceId: string } })[];
assert.equal(provenance.length, 3);
assert.ok(!provenance.some(item => /外引|模型/.test(item.text)));
assert.equal(provenance.find(item => item.sourceRef.resourceId === "outlier")?.informationType, "measured_fact");
assert.ok(provenance.find(item => item.sourceRef.resourceId === "outlier")?.text.includes("999"), "legal outlier values remain intact");
const provenanceContext = supplementalImportanceContext(provenanceStore, { accountId: material.accountId, text: "判断",
  seed: "provenance-request", choice });
assert.ok(provenanceContext.prompt.includes('"informationType":"measured_fact"'));
assert.ok(provenanceContext.prompt.includes('"informationType":"user_viewpoint"'));
const selectionStore = createEmptyStore();
const question = { id: "current", type: "question", content: "合成当前问题", authorType: "user", version: 1 };
selectionStore.thoughts.push(question);
for (let index = 0; index < 12; index += 1) selectionStore.captures.push({ id: `original-${index}`,
  content: `背景原文 ${index}。` + "甲".repeat(8000), authorType: "user", version: 1 });
const contextOptions = {
  accountId: material.accountId, scene: "thoughtAnswer", generatedAt: "2026-10-14T00:00:00.000Z",
  task: { kind: "thoughtAnswer", text: question.content, targetId: question.id },
  currentMaterial: thoughtTaskCurrentMaterial(selectionStore, question, { accountId: material.accountId }),
  importanceChoice: choice, selectionSeed: "fixture-idempotency-and-core-model",
  compilePrompt: (sections: Record<string, unknown>) => compileWorkingContextPrompt({ ...sections, scene: "thoughtAnswer" })
};
const projected = workingContextProjection(selectionStore, contextOptions);
const sent = prepareReferenceRequest(projected.prompt, projected.citationSources, "fixture-binding");
assert.deepEqual(
  JSON.parse(JSON.stringify(projected.receipt)),
  projected.receipt,
  "importance working-context receipts must round-trip through JSON without loss"
);
const reorderedReceipt = structuredClone(projected.receipt);
reorderedReceipt.importanceSelectionPlan = Object.fromEntries(
  Object.entries(reorderedReceipt.importanceSelectionPlan).reverse()
);
reorderedReceipt.importanceSelectionPlan.sources = reorderedReceipt.importanceSelectionPlan.sources.map(
  (source: Record<string, unknown>) => Object.fromEntries(Object.entries(source).reverse())
);
assert.equal(
  workingContextReceiptFingerprint(reorderedReceipt),
  workingContextReceiptFingerprint(projected.receipt),
  "working-context fingerprints ignore JSON object key order"
);
assert.equal(sent.receipt.providedCount, 10, "ten distinct actual source excerpts reach the model prompt");
assert.equal(projected.receipt.rawSourceChecks.length, 9);
assert.ok(workingContextReceiptMatches(selectionStore, projected.receipt, contextOptions));
selectionStore.importanceScores = (legalImportanceSources(selectionStore, material.accountId) as ImportanceMaterial[]).map((item, index) => ({
  ...parseImportanceScores(JSON.stringify({ scores: [{ reference: "r1", score: index % 2 ? 0 : 100, reason: "新的合成评分" }] }),
    [item], choice, "2026-10-14T01:00:00.000Z")[0]
}));
assert.ok(workingContextReceiptMatches(selectionStore, projected.receipt, contextOptions), "later scores do not reshuffle the frozen request");
const requiredPrefix = "x".repeat(28000);
const nearLimit = workingContextProjection(selectionStore, { ...contextOptions,
  compilePrompt: (sections: Record<string, unknown>) => requiredPrefix
    + '<reference_context_data format="application/json">' + JSON.stringify({
      currentMaterial: (sections.currentMaterial as { id: string; text: string }[]).map(item => ({ citationId: `context:${item.id}`, text: item.text })),
      referenceEvidence: (sections.historicalMaterial as { id: string; text: string }[]).map(item => ({ citationId: `context:${item.id}`, text: item.text }))
    }) + '</reference_context_data>' });
assert.ok(nearLimit.prompt.startsWith(requiredPrefix));
assert.ok(Buffer.byteLength(nearLimit.prompt) <= 32000);
assert.equal(nearLimit.receipt.importanceSelectionPlan.limitReason, "overall_byte_budget");
const nearLimitSent = prepareReferenceRequest(nearLimit.prompt, nearLimit.citationSources, "actual-near-limit", nearLimit.receipt);
assert.equal(nearLimitSent.receipt.providedCount, 10);
assert.ok(nearLimitSent.receipt.truncatedSources > 0);
assert.equal(nearLimitSent.receipt.selectionLimit.reason, "overall_byte_budget");
assert.ok(nearLimitSent.prompt.startsWith(requiredPrefix), "real alias compilation retains required bytes");
const selectedRef = projected.receipt.rawSourceChecks[0];
const selectedId = JSON.parse(selectedRef.sourceKey)[1];
selectionStore.captures.find((item: { id: string; version: number }) => item.id === selectedId).version = 2;
assert.equal(workingContextReceiptMatches(selectionStore, projected.receipt, contextOptions), false);
const shortMixed = selectionMaterials.slice(0, 10).map((item, index) => ({ ...item,
  text: index < 3 ? "甲".repeat(8000) : "a", relevanceScore: index < 3 ? 10 : 0 }));
const mixedPlan = createImportanceSelectionPlan(shortMixed, [], { seed: "mixed-budget", model: choice.model, effort: choice.effort });
assert.equal(applyImportanceSelectionPlan(shortMixed, mixedPlan)?.length, 10);
assert.ok(mixedPlan.sources.every(item => item.characters > 0));
const http = createImportanceHttp(service, async () => ({ sourceRefs: [sourceRef] }));
const v1 = { success: (_res: unknown, status: number, result: unknown) => ({ status, result }),
  error: (_res: unknown, status: number, message: string, code: string) => ({ status, message, code }), idempotencyKey: () => "http-task" };
allowed = false;
assert.equal(((await http.handleV1({ method: "POST" }, {}, new URL("http://fixture/api/v1/importance/read"), v1)) as { status: number }).status, 400);
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://fixture/api/v1/importance/read"), v1), false);
console.log("Importance scoring checks passed: asynchronous intent, model/version cache, revoked save, correction, invalid output, persistence and stable sampling.");

// 持久范围使用真实 prepare/save 和任务账；合成供应商不触网。
const bulkStore = createEmptyStore();
for (let index = 0; index < 19; index += 1) bulkStore.captures.push({
  id: `bulk-${String(index).padStart(2, "0")}`, accountId: "fixture-owner", version: 1,
  content: `合成历史材料 ${index}`, createdAt: "2026-10-01T00:00:00.000Z",
  occurredAt: "2026-10-01T00:00:00.000Z", contextAllowed: true
});
let bulkChoice = { model: "deepseek-flash", effort: "none" };
let account = "fixture-owner";
const bulkLifecycle = createTaskLifecycle({ createId: () => crypto.randomUUID(), now: () => "2026-10-14T00:00:00.000Z",
  hash: (value: string) => crypto.createHash("sha256").update(value).digest("hex") });
const makeBulk = () => {
  const bulk = createImportanceService({
    repository: { read: async () => bulkStore, update: async mutate => withBusinessIdTransaction(bulkStore, () => mutate(bulkStore)) },
    accountId: () => account, createBusinessId: allocateJobId, list: value => legalImportanceSources(value, account),
    resolve: (value, ref) => legalImportanceMaterial(value, ref, account),
    modelChoice: async () => bulkChoice, currentChoice: () => bulkChoice,
    hash: value => crypto.createHash("sha256").update(value).digest("hex"),
    now: () => "2026-10-14T00:00:00.000Z", promptText: () => "合成",
    renderPrompt: (_id, values) => values.input
  });
  bulk.attach({ enqueue: async input => bulkLifecycle.create(bulkStore.aiTasks, input, (task: Parameters<typeof bulk.target.prepare>[1]) => bulk.target.prepare(bulkStore, task)) });
  return bulk;
};
let bulk = makeBulk();
await bulk.correct(legalImportanceSources(bulkStore, account).at(-1).sourceRef, 85);
const batchJob = await bulk.batches!.start({ from: "2026-10-01", to: "2026-10-01", maxCalls: 3 }, "bulk-range") as { id: string; total: number };
assert.equal(batchJob.total, 19);
assert.match(batchJob.id, /^[A-Za-z0-9_-]{16}$/);
assert.equal(bulkStore.aiTasks.length, 1);
const finishBulkTask = async (fail = false) => {
  const task = bulkStore.aiTasks.find((item: { status: string }) => item.status === "queued");
  assert.ok(task);
  const work = bulk.target.prepare(bulkStore, task)!;
  assert.ok(work, JSON.stringify({task, job: await bulk.batches!.read(batchJob.id)}));
  if (!fail) bulk.target.save(bulkStore, work, task, { content: JSON.stringify({ scores: work.importanceMaterials.map((_: unknown, index: number) => ({ reference: `r${index + 1}`, score: 60, reason: "long_term_value" })) }) });
  task.status = fail ? "failed" : "succeeded";
  await bulk.target.settled();
};
await finishBulkTask(true);
assert.equal(bulkStore.aiTasks.length, 2, "failure continues the persisted range");
bulk = makeBulk(); // 进程内服务重建，持久范围和当前批次不丢失。
await bulk.batches!.pump();
assert.equal(bulkStore.aiTasks.length, 2, "restart reconnects an existing pending batch");
await finishBulkTask();
await finishBulkTask();
const completeBulk = await bulk.batches!.read(batchJob.id) as { status: string; cursor: number };
assert.equal(completeBulk.status, "partial");
assert.equal(completeBulk.cursor, 19);
assert.equal((completeBulk as unknown as { pendingSources: number }).pendingSources, 8);
assert.equal((completeBulk as unknown as { failedSources: number }).failedSources, 8);
assert.equal(bulkStore.importanceScores.length, 11);
await bulk.batches!.control(batchJob.id, "resume", 1);
assert.equal(bulkStore.aiTasks.length, 4, "explicit continuation rescores failed sources and skips valid scores");
await bulk.batches!.control(batchJob.id, "pause");
const paused = bulkStore.aiTasks.find((item: { status: string }) => item.status === "queued");
assert.equal(bulk.target.prepare(bulkStore, paused), null, "paused range cannot call or save model output");
paused.status = "stale";
await bulk.batches!.control(batchJob.id, "resume", 1);
await finishBulkTask();
assert.equal(bulkStore.importanceScores.length, 19);
assert.ok(!JSON.stringify(bulkStore.importanceJobs).includes("合成历史材料"));
account = "other-account";
assert.equal((await bulk.batches!.read(batchJob.id) as { missing: boolean }).missing, true);
account = "fixture-owner";
bulkChoice = { model: "deepseek-flash", effort: "high" };
await bulk.batches!.control(batchJob.id, "resume", 1);
assert.equal(bulkStore.aiTasks.find((item: { status: string }) => item.status === "queued").payload.effort, "high");
bulkChoice = { model: "deepseek-flash", effort: "none" };
await bulk.batches!.pump();
assert.equal((await bulk.batches!.read(batchJob.id) as { status: string }).status, "configuration_changed");
assert.equal(bulk.target.prepare(bulkStore, bulkStore.aiTasks.find((item: { status: string }) => item.status === "queued")), null);
console.log("Persistent importance range checks passed: batches, failure continuation, restart, pause, cache skip, explicit rescore and account/model gates.");

const { readFile } = await import("node:fs/promises");
const { createNewReplayAdapter, validateReplayFixtureSet } = await import(fromRoot("scripts/lib/personalization-replay.mjs"));
const replayFixtures = validateReplayFixtureSet(JSON.parse(await readFile(path.join(root, "scripts/fixtures/personalization-replay-v1.json"), "utf8")));
for (const [fixtureIndex, fixture] of replayFixtures.fixtures.entries()) {
  const output = createNewReplayAdapter().run(fixture, { fixtureIndex });
  assert.ok(output.selectedSourceIds.every((id: string) => fixture.materials.some((item: { id: string }) => item.id === id)));
}
const unmapped = createNewReplayAdapter({ project: (value: unknown, options: unknown) => {
  const projection = workingContextProjection(value, options);
  for (const source of projection.receipt.sources) if (source.channel === "history") source.version += 1;
  return projection;
} });
assert.throws(() => unmapped.run(replayFixtures.fixtures[0], { fixtureIndex: 0 }), /unmapped source/);
const reconstructed = rebuildStoreObjects(mapStoreObjects("fixture-owner", bulkStore));
assert.deepEqual(reconstructed.importanceJobs, bulkStore.importanceJobs, "Postgres object mapper preserves the entire progress ledger");
console.log("Current replay candidate checks passed: exact source coordinates/version, unknown mapping rejection and persisted range mapper.");

const { createBackgroundAi } = await import(fromRoot("src/app/background-ai.mjs"));
const liveStore = createEmptyStore();
liveStore.captures = structuredClone(bulkStore.captures.slice(0, 9));
const liveRepository = { read: async () => liveStore, update: async (mutate: (value: typeof liveStore) => unknown) => withBusinessIdTransaction(liveStore, () => mutate(liveStore)) };
const liveImportance = createImportanceService({ repository: liveRepository,
  accountId: () => "fixture-owner", createBusinessId: allocateJobId, list: value => legalImportanceSources(value, "fixture-owner"),
  resolve: (value, ref) => legalImportanceMaterial(value, ref, "fixture-owner"),
  modelChoice: async () => bulkChoice, currentChoice: () => bulkChoice,
  hash: value => crypto.createHash("sha256").update(value).digest("hex"),
  now: () => "2026-10-14T00:00:00.000Z", promptText: () => "合成", renderPrompt: (_id, values) => values.input });
let fakeModelCalls = 0;
let modelBlock: Promise<void> | null = null;
let markDispatched: (() => void) | null = null;
const liveBackground = createBackgroundAi({ repository: liveRepository, tasks: bulkLifecycle,
  notifications: { upsertTask: () => { throw new Error("Internal task should not notify"); } },
  targets: liveImportance.target, dispatch: () => {}, contextKey: () => "fixture-owner",
  onError: (_id: string, error: Error) => { throw error; },
  generate: async (prepared: { importanceMaterials: ImportanceMaterial[] }) => {
    fakeModelCalls += 1;
    markDispatched?.();
    if (modelBlock) await modelBlock;
    return { content: JSON.stringify({ scores: prepared.importanceMaterials.map((_: unknown, index: number) => ({
      reference: `r${index + 1}`, score: 60, reason: "long_term_value" })) }) };
  } });
liveImportance.attach(liveBackground);
const liveHttp = createImportanceHttp(liveImportance, async () => ({ range: { from: "2026-10-01", to: "2026-10-01" }, maxCalls: 2 }));
const liveResponse = await liveHttp.handleV1({ method: "POST" }, {}, new URL("http://fixture/api/v1/importance/score"), v1) as { status: number; result: { id: string } };
assert.equal(liveResponse.status, 202);
await liveBackground.run(liveStore.aiTasks[0].id);
assert.equal(liveStore.aiTasks.length, 2, "actual background terminal callback continues the second batch");
await liveBackground.run(liveStore.aiTasks[0].id);
assert.equal(fakeModelCalls, 2);
assert.equal((await liveImportance.batches!.read(liveResponse.result.id) as { status: string }).status, "completed");
await liveImportance.batches!.control(liveResponse.result.id, "resume", 1, "resume-once");
const attempts = liveStore.importanceJobs[0].attempt;
await liveImportance.batches!.control(liveResponse.result.id, "resume", 1, "resume-once");
assert.equal(liveStore.importanceJobs[0].attempt, attempts, "control retry does not authorize additional calls");
assert.equal((await liveImportance.batches!.control(liveResponse.result.id, "pause", undefined, "resume-once") as { conflict: boolean }).conflict, true);
assert.equal((await liveImportance.batches!.start({ from: "2026-10-01", to: "2026-10-01", maxCalls: 2 }, "http-task") as { id: string }).id, liveResponse.result.id);
console.log("Real HTTP/background consumer checks passed: automatic second batch, bounded model stub calls and range/control idempotency.");

liveStore.captures.push({ id: "late-date", accountId: "fixture-owner", version: 1, content: "迟到补录",
  createdAt: "2026-10-14T00:00:00.000Z", occurredAt: "", occurredOn: "2026-09-20", eventTimePrecision: "date" });
const occurredRange = await liveImportance.batches!.start({ from: "2026-09-20", to: "2026-09-20", dateBasis: "occurred", maxCalls: 1 }, "occurred-late") as { total: number; dateBasis: string };
assert.equal(occurredRange.total, 1, "occurrence scope includes date-only late entries");
assert.equal(occurredRange.dateBasis, "occurred");
const recordedRange = await liveImportance.batches!.start({ from: "2026-09-20", to: "2026-09-20", dateBasis: "recorded", maxCalls: 1 }, "recorded-late") as { total: number };
assert.equal(recordedRange.total, 0, "recorded and occurred ranges are distinct and explicit");
assert.deepEqual(normalizeStore(liveStore).importanceJobs, liveStore.importanceJobs);
assert.throws(() => normalizeStore({ importanceJobs: [{ ...liveStore.importanceJobs[0], cursor: -1 }] }), /importanceJobs/);
console.log("Range date contract checks passed: recorded/occurred distinction, date-only late entries and normalization validation.");
for (const pending of bulkStore.aiTasks) if (pending.status === "queued") pending.status = "stale";
for (const capture of bulkStore.captures) capture.version += 1;
const limitedJob = await bulk.batches!.start({ from: "2026-10-01", to: "2026-10-01", maxCalls: 1 }, "bounded-rescore") as { id: string };
await finishBulkTask();
const limitedProgress = await bulk.batches!.read(limitedJob.id) as { status: string; scoredSources: number; pendingSources: number; allSourcesScored: boolean };
assert.equal(limitedProgress.status, "limit");
assert.equal(limitedProgress.scoredSources, 8);
assert.equal(limitedProgress.pendingSources, 11);
assert.equal(limitedProgress.allSourcesScored, false);
bulkStore.captures.at(-1).contextAllowed = false;
assert.equal((await bulk.batches!.read(limitedJob.id) as { invalidSources: number }).invalidSources, 1);
console.log("Bounded stale-version rescore checks passed: one-call limit, outstanding source count and revoked-source visibility.");

for (const capture of liveStore.captures.slice(0, 9)) capture.version += 1;
const pauseJob = await liveImportance.batches!.start({ from: "2026-10-01", to: "2026-10-01", maxCalls: 2 }, "pause-in-flight") as { id: string };
let returnModel!: () => void;
modelBlock = new Promise<void>(resolve => { returnModel = resolve; });
const dispatched = new Promise<void>(resolve => { markDispatched = resolve; });
const runningPauseTask = liveStore.aiTasks.find((item: { clientRequestId: string }) => item.clientRequestId.startsWith(`importance-range:${pauseJob.id}:`));
const callsBeforePause = fakeModelCalls;
const inFlight = liveBackground.run(runningPauseTask.id);
await dispatched;
await liveImportance.batches!.control(pauseJob.id, "pause", undefined, "pause-flight");
returnModel();
await inFlight;
modelBlock = null;
markDispatched = null;
assert.equal(runningPauseTask.status, "succeeded", "issued valid result is saved while its range is paused");
const pausedProgress = await liveImportance.batches!.read(pauseJob.id) as { status: string; scoredSources: number; batches: unknown[] };
assert.equal(pausedProgress.status, "paused");
assert.equal(pausedProgress.scoredSources, 8);
assert.equal(pausedProgress.batches.length, 1, "pause prevents the next batch");
assert.equal(fakeModelCalls, callsBeforePause + 1);
await liveImportance.batches!.control(pauseJob.id, "resume", 1, "resume-flight");
const resumedPauseTask = liveStore.aiTasks.find((item: { clientRequestId: string; status: string }) => item.clientRequestId.startsWith(`importance-range:${pauseJob.id}:`) && item.status === "queued");
assert.equal(resumedPauseTask.payload.sourceRefs.length, 1, "resume skips eight already-paid valid results");
await liveBackground.run(resumedPauseTask.id);
assert.equal((await liveImportance.batches!.read(pauseJob.id) as { status: string }).status, "completed");
assert.equal(fakeModelCalls, callsBeforePause + 2);
console.log("Actual in-flight pause checks passed: issued result saves, next batch stops and resumed range skips paid cache.");
