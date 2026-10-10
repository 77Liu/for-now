import assert from "node:assert/strict";
import { conservativeDeepSeekInputTokenUpperBound } from "../src/modules/ai/index.mjs";
import { estimateDeepSeekPeakCostCny } from "../src/app/index.mjs";

const basicMessages = [
  { role: "system", content: "system" },
  { role: "user", content: "user" }
];
const basicBound = conservativeDeepSeekInputTokenUpperBound(basicMessages);
assert.ok(basicBound > "system".length + "user".length,
  "budget must include message framing in addition to text characters");

const multilingual = [
  { role: "system", content: "中文提示" },
  { role: "user", content: "🧭 e\u0301 \u0000\u001f \ud800" }
];
const multilingualBound = conservativeDeepSeekInputTokenUpperBound(multilingual);
const serializedBytes = multilingual.reduce((total, message) => (
  total + new TextEncoder().encode(JSON.stringify({
    role: message.role,
    content: message.content
  })).length
), 0);
assert.ok(multilingualBound >= serializedBytes + multilingual.length * 256,
  "Unicode, combining marks, control characters, and lone surrogates must be budgeted by escaped UTF-8 size");
assert.ok(multilingualBound > "中文提示🧭 e\u0301 \u0000\u001f \ud800".length * 2,
  "multibyte text must not be priced using JavaScript character count");

const multimodal = conservativeDeepSeekInputTokenUpperBound([{
  role: "user",
  content: [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,large-image-payload" } }
  ]
}]);
assert.equal(multimodal, conservativeDeepSeekInputTokenUpperBound([
  { role: "user", content: "看图" }
]), "image tokens remain covered by the existing explicit image allowance, not base64 bytes");

const estimate = estimateDeepSeekPeakCostCny({
  model: "deepseek-flash",
  maxInputTokens: multilingualBound,
  maxOutputTokens: 900
});
assert.ok(estimate > estimateDeepSeekPeakCostCny({
  model: "deepseek-flash",
  maxInputTokens: "中文提示🧭 e\u0301 \u0000\u001f \ud800".length,
  maxOutputTokens: 900
}), "single-call peak cost must use the conservative token upper bound");

console.log("record-compression token-bound regression passed");
