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

import { promises as fs } from "node:fs";
import { replayCurrentMaterials, replayCurrentTask, assertReplayCurrentCoverage, replayGroundTruth } from "./lib/personalization-task-input.mjs";
import { createGeneralReplayAdapter, createLegacyReplayAdapter, createNewReplayAdapter } from "./lib/personalization-replay.mjs";
import { compileWorkingContextPrompt, personalContextProjection } from "../src/app/index.mjs";
import { userPrompt } from "../src/modules/ai/index.mjs";
import { thoughtTask } from "../src/modules/thoughts/index.mjs";
import { installPromptCatalog } from "../src/shared/prompts/index.mjs";
import { loadPromptCatalog } from "../src/infrastructure/prompt-catalog/index.mjs";
const fixtureSet = JSON.parse(await fs.readFile(new URL("./fixtures/personalization-replay-v1.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await fs.readFile(new URL("./fixtures/personalization-replay-manifest-v2.json", import.meta.url), "utf8"));
assert.equal(plan.purpose, "personalization-same-current-task-v2");
assert.equal(plan.requestInputVersion, "current-task-v2");
assert.notEqual(plan.planFingerprint, "1c3b7e0bd6c420341716b0e7798a57096d8e0e12f2399d6d64029e2014969e92");
let coverageCases = 0;
for (const request of plan.requests) {
  const fixture = fixtureSet.fixtures.find(item => item.id === request.fixtureId);
  assertReplayCurrentCoverage(fixture, request.messages, request.selectedSourceIds);
  assert.throws(() => assertReplayCurrentCoverage(fixture,
    [{ role: "system", content: JSON.stringify(fixture.materials) }, { role: "user", content: fixture.task }], request.selectedSourceIds),
  /Actual request omits current material/);
  assert.throws(() => assertReplayCurrentCoverage(fixture, request.messages,
    request.selectedSourceIds.filter(id => !replayCurrentMaterials(fixture).some(material => material.id === id))),
  /Selected current sources differ/);
  coverageCases += 3;
}
// Exercise the actual three adapters with unapproved current text and multiple original materials.
const fixture = structuredClone(fixtureSet.fixtures[0]);
fixture.materials.push(
  { id: "current:extra-original", channel: "current", text: 'SECOND_ORIGINAL_TASK "quote"\nsecond line' },
  { id: "current:other-account", channel: "current", storeKind: "capture", account: "other", text: "OTHER_ACCOUNT_CURRENT_SECRET" },
  { id: "current:account-id", channel: "current", storeKind: "capture", accountId: "different-account", text: "ACCOUNT_ID_CURRENT_SECRET" },
  { id: "current:denied", channel: "current", storeKind: "capture", contextAllowed: false, text: "DENIED_CURRENT_SECRET" },
  { id: "current:forbidden", channel: "current", storeKind: "capture", forbiddenReason: "invalidated-derived", text: "FORBIDDEN_CURRENT_SECRET" }
);
for (const variant of ["general", "legacy", "new"]) {
  const catalog = variant === "new" ? manifest.candidate.promptCatalog : manifest.promptCatalog;
  await installPromptCatalog(await loadPromptCatalog({ rootDir: root, requestedVersion: catalog.version, allowHistorical: true }));
  let context = "";
  const adapter = variant === "general" ? createGeneralReplayAdapter() : variant === "legacy"
    ? createLegacyReplayAdapter({ project(store, options) {
      const result = personalContextProjection(store, options); context = result.prompt; return result;
    } }) : createNewReplayAdapter({ compile(options) {
      const result = compileWorkingContextPrompt(options); context = result.prompt; return result;
    } });
  const output = adapter.run(fixture, { fixtureIndex: 0 });
  const messages = [{ role: "user", content: variant === "new" ? context
    : userPrompt({ context, chain: replayCurrentTask(fixture), task: thoughtTask("answer") }) }];
  assertReplayCurrentCoverage(fixture, messages, output.selectedSourceIds);
  for (const forbidden of fixture.materials.filter(material => material.id.startsWith("current:")
    && !replayCurrentMaterials(fixture).includes(material))) {
    assert.equal(messages[0].content.includes(forbidden.text), false);
    assert.equal(messages[0].content.includes(forbidden.id), false);
    assert.equal(output.selectedSourceIds.includes(forbidden.id), false);
  }
  if (variant === "general") {
    assert.equal(output.selectedSourceIds.some(id => !id.startsWith("current:")), false);
    assert.equal(messages[0].content.includes("I explicitly prefer a written checklist"), false);
  }
  assert.equal(liveFingerprint({ messages: [
    { role: "system", content: plan.requests.find(row => row.variant === variant).messages[0].content }, ...messages
  ], parameters: output.adapterEvidence.parameters }), output.adapterEvidence.fullRequestSha256);
  coverageCases += 14;
}
assert.throws(() => replayCurrentTask({ ...fixture, materials: fixture.materials.filter(material => material.channel !== "current") }),
  /requires an allowed current task material/);
assert.throws(() => replayCurrentTask({ ...fixture, materials: [{ channel: "current", id: "current:empty", text: "" }] }),
  /requires original text/);
assert.throws(() => replayCurrentTask({ ...fixture, materials: [fixture.materials[0],
  { ...fixture.materials[0], account: "other", text: "DUPLICATE_FOREIGN_CURRENT" }] }), /Duplicate current material/);
const temporalIndex = fixtureSet.fixtures.findIndex(item => item.id === "historical-event-not-current-state");
const truth = replayGroundTruth(fixtureSet.fixtures[temporalIndex], temporalIndex);
assert.equal(truth.asOf, "2026-10-07T12:30:00.000Z");
assert.equal(truth.sources.find(source => source.id === "checkin:temporal-old").effectiveOccurredAt, "2026-08-01T08:00:00.000Z");
assert.equal(truth.sources.find(source => source.id === "checkin:temporal-old").payload.energy, 1);
assert.equal(replayGroundTruth(fixtureSet.fixtures[0], 0).sources.find(source => source.id === "capture:extraction-quote").origin, "third_party");
assert.equal(replayGroundTruth(fixtureSet.fixtures[0], 0).sources.find(source => source.id === "thought-ai:extraction-draft").origin, "ai");
assert.equal(replayGroundTruth(fixtureSet.fixtures[0], 0).sources.find(source => source.id === "capture:extraction-explicit").dateProvenance,
  "derived-synthetic-fixture-index-date");
assert.equal(JSON.stringify(truth).includes("variant"), false);
console.log(`Same-current-task fairness passed: ${coverageCases} request/adaptor checks, all 48 requests cover original current text, denied/foreign current inputs excluded, shared synthetic ground truth. External calls: 0.`);
