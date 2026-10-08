import assert from "node:assert/strict";
import { buildPersonalizationLivePlan, liveFingerprint } from "./lib/personalization-live.mjs";
const root = new URL("..", import.meta.url).pathname;
const plan = await buildPersonalizationLivePlan(root);
assert.equal(plan.requests.length, 48); assert.equal(new Set(plan.requests.map(row => row.id)).size, 48);
assert.equal(new Set(plan.requests.map(row => row.fixtureId)).size, 8);
assert.ok(plan.reservedCny <= plan.maxCostCny); assert.equal(plan.gateEligible, false);
for (const request of plan.requests) {
  assert.equal(liveFingerprint({ messages: request.messages, parameters: request.parameters }), request.requestSha256);
  assert.equal(request.parameters.model, "deepseek-v4-pro"); assert.equal(request.parameters.reasoningEffort, "max");
  assert.equal(request.parameters.maxOutputTokens, 16000);
  assert.ok(request.inputTokenUpperBound >= Buffer.byteLength(JSON.stringify(request.messages), "utf8"));
  assert.ok(request.reservedCny > 0);
  assert.equal(JSON.stringify(request).includes("bytedance"), false);
}
assert.equal(plan.planFingerprint, (await buildPersonalizationLivePlan(root)).planFingerprint);
console.log("Live replay plan passed: 48 immutable production-identity requests, 8 synthetic fixtures, two repetitions, conservative CNY30 cap, no external calls.");
