import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compileWorkingContextPrompt, personalContextProjection } from "../../src/app/index.mjs";
import { defaultLlmSettings, llmSettingsForScene, systemPrompt, systemPromptForScene, userPrompt } from "../../src/modules/ai/index.mjs";
import { thoughtTask } from "../../src/modules/thoughts/index.mjs";
import { installPromptCatalog } from "../../src/shared/prompts/index.mjs";
import { loadPromptCatalog } from "../../src/infrastructure/prompt-catalog/index.mjs";
import { createGeneralReplayAdapter, createLegacyReplayAdapter, createNewReplayAdapter, validateReplayFixtureSet } from "./personalization-replay.mjs";
import { replayCurrentTask, assertReplayCurrentCoverage, REPLAY_INPUT_VERSION, REPLAY_PURPOSE } from "./personalization-task-input.mjs";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const liveFingerprint = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export async function buildPersonalizationLivePlan(rootDir) {
  const text = await fs.readFile(path.join(rootDir, "scripts/fixtures/personalization-replay-v1.json"), "utf8");
  const fixtures = validateReplayFixtureSet(JSON.parse(text));
  const manifest = JSON.parse(await fs.readFile(path.join(rootDir, "scripts/fixtures/personalization-replay-manifest-v2.json"), "utf8"));
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), manifest.fixtureBaseline.sha256);
  assert.equal(manifest.requestInputContract.version, REPLAY_INPUT_VERSION);
  assert.equal(manifest.requestInputContract.purpose, REPLAY_PURPOSE);
  const requests = [];
  for (const variant of ["general", "legacy", "new"]) {
    const catalog = variant === "new" ? manifest.candidate.promptCatalog : manifest.promptCatalog;
    await installPromptCatalog(await loadPromptCatalog({ rootDir, requestedVersion: catalog.version, allowHistorical: true }));
    for (const [fixtureIndex, fixture] of fixtures.fixtures.entries()) {
      if (!fixture.requiresRealModel) continue;
      let context = "";
      const adapter = variant === "general" ? createGeneralReplayAdapter() : variant === "legacy"
        ? createLegacyReplayAdapter({ project(store, options) {
          const result = personalContextProjection(store, options); context = result.prompt; return result;
        } }) : createNewReplayAdapter({ taskBindings: manifest.candidate.taskBindings,
          compile(options) { const result = compileWorkingContextPrompt(options); context = result.prompt; return result; } });
      const output = adapter.run(fixture, { fixtureIndex });
      const parameters = output.adapterEvidence.parameters;
      const settings = llmSettingsForScene(defaultLlmSettings, "thoughtAnswer");
      const messages = [{ role: "system", content: systemPromptForScene(systemPrompt(), "thoughtAnswer", settings) },
        { role: "user", content: variant === "new" ? context : userPrompt({ context, chain: replayCurrentTask(fixture), task: thoughtTask("answer") }) }];
      assertReplayCurrentCoverage(fixture, messages, output.selectedSourceIds);
      assert.equal(liveFingerprint({ messages, parameters }), output.adapterEvidence.fullRequestSha256,
        `Live request differs from frozen replay identity: ${fixture.id}/${variant}`);
      assert.equal(parameters.maxOutputTokens, 16000); assert.equal(parameters.reasoningEffort, "max");
      for (let repetition = 1; repetition <= 2; repetition += 1) requests.push({
        id: `${fixture.id}/${variant}/${repetition}`, fixtureId: fixture.id, fixtureIndex, variant, repetition,
        selectedSourceIds: output.selectedSourceIds, requestSha256: output.adapterEvidence.fullRequestSha256,
        promptCatalog: catalog, parameters, messages,
        inputTokenUpperBound: Buffer.byteLength(JSON.stringify(messages), "utf8") + 128
      });
    }
  }
  assert.equal(requests.length, 48);
  const pricing = { source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", currency: "CNY",
    inputPerMillion: 9, outputPerMillion: 27, policy: "conservative peak; cache discount ignored" };
  for (const request of requests) request.reservedCny = (request.inputTokenUpperBound * pricing.inputPerMillion
    + request.parameters.maxOutputTokens * pricing.outputPerMillion) / 1e6;
  const reservedCny = requests.reduce((sum, row) => sum + row.reservedCny, 0);
  assert.ok(reservedCny <= 30, "Live plan exceeds frozen CNY30 ceiling");
  return { schemaVersion: 1, purpose: REPLAY_PURPOSE, requestInputVersion: REPLAY_INPUT_VERSION, fixtureSha256: manifest.fixtureBaseline.sha256,
    fixtureSetFingerprint: manifest.fixtureSetFingerprint, manifestFingerprint: liveFingerprint(manifest),
    planFingerprint: liveFingerprint(requests), fixtureCount: 8, maxCalls: 48, maxCostCny: 30,
    reservedCny, concurrency: 1, retries: 0, timeoutMs: 90000, pricing,
    semanticEvaluation: "pending-blind-owner-review", gateEligible: false, requests };
}
