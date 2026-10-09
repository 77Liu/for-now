import assert from "node:assert/strict";
import { parseVerifiedAnswer } from "../src/app/index.mjs";

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

console.log("Answer citation regression passed: exact prompt-source quotes are retained and fabricated or altered references are discarded.");
