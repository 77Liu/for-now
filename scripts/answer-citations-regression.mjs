import { estimateInternalTokens } from "../.build/typescript/backend/shared/ai-context/index.mjs";
import assert from "node:assert/strict";
import { parseVerifiedAnswer } from "../src/app/index.mjs";
import { prepareReferenceRequest, verifyReferenceAnswer } from "../src/app/index.mjs";
import { decodeReferenceAnswer } from "../.build/typescript/backend/shared/ai-context/index.mjs";

const sources = [
  {
    citationId: "core:onboarding:currentContext",
    text: "我正在适应新的工作节奏。",
    source: {
      recordType: "当前处境",
      resourceType: "onboardingV2",
      resourceId: "currentContext",
      version: 2
    }
  },
  {
    citationId: "context:current:thought:question-1",
    text: "我想知道如何更专注。",
    source: {
      recordType: "当前思绪",
      resourceType: "thought",
      resourceId: "question-1",
      version: 3
    }
  }
];

const projected = parseVerifiedAnswer(JSON.stringify({
  answer: "近期节奏变化值得纳入判断。",
  citations: [
    {
      citationId: "core:onboarding:currentContext",
      exactQuote: "我正在适应新的工作节奏"
    },
    {
      citationId: "context:current:thought:question-1",
      exactQuote: "我想知道如何更专注。"
    },
    {
      citationId: "core:onboarding:forged",
      exactQuote: "伪造来源"
    },
    {
      citationId: "core:onboarding:currentContext",
      exactQuote: "我已经完全解决"
    }
  ]
}), sources);
assert.equal(projected.content, "近期节奏变化值得纳入判断。");
assert.equal(projected.citationStatus, "matched");
assert.deepEqual(projected.citations.map(item => [item.citationId, item.exactQuote]), [
  ["core:onboarding:currentContext", "我正在适应新的工作节奏"],
  ["context:current:thought:question-1", "我想知道如何更专注。"]
]);
assert.equal(projected.citations[0].recordType, "当前处境");

const oppositeClaim = parseVerifiedAnswer(JSON.stringify({
  answer: "你喜欢跑步。",
  citations: [{ citationId: "core:onboarding:currentContext", exactQuote: "我正在适应新的工作节奏。" }]
}), sources);
assert.equal(oppositeClaim.citationStatus, "matched",
  "the server validates exact source text, not whether that text semantically supports the answer");

const noCitation = parseVerifiedAnswer(JSON.stringify({
  answer: "现有原文不足以支持具体引用。",
  citations: [{ citationId: "core:onboarding:forged", exactQuote: "随意内容" }]
}), sources);
assert.equal(noCitation.citationStatus, "none");
assert.deepEqual(noCitation.citations, []);
assert.throws(() => parseVerifiedAnswer("普通回答", sources), {
  code: "ANSWER_CITATION_FORMAT_INVALID"
});

const actualSource = {
  citationId: "current:" + "x".repeat(160), text: "第一段原文。中间未发送原文。第二段原文。",
  source: { resourceType: "thought", resourceId: "parent-uuid", version: 3,
    location: { rootId: "parent-uuid", targetKey: "followup-question:child-uuid" } }
};
const aliasPrompt = '<working_context_data format="application/json">' + JSON.stringify({
  coreUserModel: { answers: [{ citationId: sources[0].citationId, sourceId: "core-record", text: sources[0].text }] },
  currentMaterial: [{ citationId: actualSource.citationId, sourceId: "child-uuid", text: "第一段原文。" },
    { citationId: actualSource.citationId, sourceId: "child-uuid", text: "第二段原文。" }],
  citations: [{ citationId: actualSource.citationId, exactQuote: "第一段原文。" }],
  currentTask: { targetId: "parent-uuid", subtargetId: "child-uuid", text: "用户原话中提到parent-uuid和child-uuid" }
}) + '</working_context_data>';
const duplicateSource = { ...actualSource, citationId: "trend-prefix:" + actualSource.citationId };
const duplicatePrompt = aliasPrompt.replace('"currentMaterial":', '"historicalUserSupplement":' + JSON.stringify({
  records: [{ citationId: duplicateSource.citationId, sourceId: "child-uuid", exactQuote: "第二段原文。" }]
}) + ',"currentMaterial":');
const deduplicatedRequest = prepareReferenceRequest(duplicatePrompt, [sources[0], actualSource, duplicateSource], "account-a/task-1/version3");
assert.equal(deduplicatedRequest.entries.length, 2, "different long prefixes for one real child share one alias");
assert.equal(deduplicatedRequest.sources.length, 2);
assert.ok(deduplicatedRequest.prompt.includes('"citationId":"r2"'));
const differentChild = { ...actualSource, citationId: "different-child", source: {
  ...actualSource.source, location: { ...actualSource.source.location, targetKey: "followup-question:other-child" }
} };
const differentVersion = { ...actualSource, citationId: "different-version", source: { ...actualSource.source, version: 4 } };
const differentiated = prepareReferenceRequest(aliasPrompt, [sources[0], actualSource, duplicateSource, differentChild, differentVersion], "bound");
assert.equal(differentiated.entries.length, 4, "different children or versions are never merged");
const referenceRequest = prepareReferenceRequest(aliasPrompt, [sources[0], actualSource], "account-a/task-1/version3");
assert.equal(referenceRequest.sources.length, 2);
assert.equal(referenceRequest.receipt.providedCount, 2);
assert.equal(referenceRequest.receipt.promptBytes, Buffer.byteLength(referenceRequest.prompt, "utf8"));
assert.equal(referenceRequest.receipt.unit, "UTF-8 bytes");
assert.ok(!referenceRequest.prompt.includes(actualSource.citationId));
assert.ok(referenceRequest.prompt.includes('用户原话中提到parent-uuid和child-uuid'));
const aliasPayload = JSON.parse(referenceRequest.prompt.match(/>([\s\S]*)<\//)[1]);
assert.equal(aliasPayload.citations[0].citationId, "r2", "citation objects retain their actual sent shape");
assert.equal(aliasPayload.currentMaterial[0].sourceId, "r2");
const aliasAnswer = verifyReferenceAnswer(JSON.stringify({ answer: "合法回答继续保存。", citations: [
  { citationId: "r2", exactQuote: "第一段原文。" },
  { citationId: "r2", exactQuote: "第一段原文。\n第二段原文。" },
  { citationId: "r2", exactQuote: "中间未发送原文。" },
  { citationId: "r999", exactQuote: "伪造别名" }
] }), referenceRequest);
assert.equal(aliasAnswer.citationStatus, "matched");
assert.equal(aliasAnswer.citations.length, 1);
assert.equal(aliasAnswer.citations[0].resourceId, "parent-uuid");
assert.equal(aliasAnswer.citations[0].location.targetKey, "followup-question:child-uuid");
assert.equal(aliasAnswer.rejectedReferences.length, 3);
assert.equal(aliasAnswer.referenceReceipt.binding, referenceRequest.binding);
assert.equal(aliasAnswer.providedReferences.length, 2);
assert.ok(aliasAnswer.providedReferences.every(item => !("text" in item)), "public catalog does not expose model or original details");
const foreign = decodeReferenceAnswer(JSON.stringify({ answer: "仍是合法正文", citations: [
  { citationId: "r2", exactQuote: "第一段原文。" }
] }), referenceRequest, "different-account-or-task-binding");
assert.equal(JSON.parse(foreign.raw).citations.length, 0);
const onlyUnknown = verifyReferenceAnswer(JSON.stringify({ answer: "无引用的合法回答。", citations: [
  { citationId: "r99", exactQuote: "未知" }
] }), referenceRequest);
assert.equal(onlyUnknown.content, "无引用的合法回答。");
assert.equal(onlyUnknown.citationStatus, "none");
assert.throws(() => verifyReferenceAnswer("not JSON", referenceRequest), { code: "ANSWER_CITATION_FORMAT_INVALID" });
const multiSources = [0, 1].map(index => ({
  citationId: `multi-source-${index}`, text: "甲".repeat(1800) + `未发送尾段${index}`,
  source: { resourceType: "capture", resourceId: `multi-record-${index}`, version: 1, origin: "user" }
}));
const multiPayloads = multiSources.map((source, index) => ({
  referenceEvidence: [{ citationId: source.citationId, text: source.text }],
  sevenDayTrend: { scope: "historical_supplement", sources: [{ citationId: source.citationId }],
    userSubjective: [{ text: "趋势摘要".repeat(170), citations: [source.citationId] }], metrics: [] },
  ...(index ? {} : { coreUserModel: { answers: [] }, currentMaterial: [{ text: "必需内容不得裁剪" }] })
}));
const multiPrompt = multiPayloads.map(payload => '<reference_context_data format="application/json">'
  + JSON.stringify(payload) + '</reference_context_data>').join("\n");
assert.ok(multiPayloads.reduce((sum, payload) => sum + estimateInternalTokens(payload.referenceEvidence), 0) > 5000);
assert.ok(multiPayloads.reduce((sum, payload) => sum + estimateInternalTokens(payload.sevenDayTrend), 0) > 2000);
const multiRequest = prepareReferenceRequest(multiPrompt, multiSources, "same-account/multi-block-request");
const suppliedBlocks = [...multiRequest.prompt.matchAll(/<reference_context_data format="application\/json">([\s\S]*?)<\/reference_context_data>/g)]
  .map(match => JSON.parse(match[1]));
const evidenceTotal = suppliedBlocks.reduce((sum, block) => sum + estimateInternalTokens(block.referenceEvidence), 0);
const trendTotal = suppliedBlocks.reduce((sum, block) => sum + (block.sevenDayTrend ? estimateInternalTokens(block.sevenDayTrend) : 0), 0);
assert.ok(evidenceTotal <= 5000, "evidence hard limit is shared across every structured block");
assert.ok(trendTotal <= 2000, "trend hard limit is shared across every structured block");
assert.equal(multiRequest.receipt.evidenceTokens, evidenceTotal);
assert.equal(multiRequest.receipt.trendTokens, trendTotal);
assert.equal(multiRequest.receipt.providedCount, 2, "large optional evidence is clipped rather than rejecting the answer");
assert.equal(multiRequest.receipt.truncatedSources, 2);
assert.equal(multiRequest.receipt.evidenceBudgetLevel, "warn");
assert.equal(multiRequest.receipt.trendBudgetLevel, "warn");
assert.equal(suppliedBlocks[0].currentMaterial[0].text, "必需内容不得裁剪");
assert.deepEqual(suppliedBlocks[0].coreUserModel, multiPayloads[0].coreUserModel);
const clippedAnswer = verifyReferenceAnswer(JSON.stringify({ answer: "合法多块回答", citations: [
  { citationId: "r1", exactQuote: "甲甲甲" },
  { citationId: "r1", exactQuote: "未发送尾段0" }
] }), multiRequest);
assert.equal(clippedAnswer.citations.length, 1);
assert.equal(clippedAnswer.rejectedReferences[0].reason, "quote_not_in_sent_original_span");
console.log("Answer citation regression passed: exact prompt-source quotes are retained and fabricated or altered references are discarded.");
