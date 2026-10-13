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
const fromRoot = (file: string) => pathToFileURL(path.join(process.cwd(), file)).href;
const { createImportanceService, importanceScoreFor, importanceWeight, parseImportanceScores,
  weightedImportanceOrder, createImportanceHttp, createImportanceSelectionPlan, applyImportanceSelectionPlan, estimateInternalTokens }
  = await import(fromRoot(".build/typescript/backend/shared/ai-context/index.mjs")) as typeof import("../src/shared/ai-context/index.mjs");
const { legalImportanceMaterial, legalImportanceSources, createEmptyStore, thoughtTaskCurrentMaterial, workingContextProjection,
  workingContextReceiptMatches, compileWorkingContextPrompt, prepareReferenceRequest, createStoreNormalizer, supplementalImportanceContext } = await import(fromRoot("src/app/index.mjs"));
const { evidenceSourceKey } = await import(fromRoot("src/modules/user-model/index.mjs"));
const { createTaskLifecycle } = await import(fromRoot("src/modules/tasks/index.mjs"));
const { mapStoreObjects, rebuildStoreObjects } = await import(fromRoot("src/shared/persistence/index.mjs"));
await import(fromRoot("scripts/prompt-test-setup.mjs"));

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
