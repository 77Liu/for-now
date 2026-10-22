/**
 * Verifies periodic review consent before repository reads and queued provider dispatch.
 * Established: 2026-10-19
 * Status: active
 * Boundary: isolated workflow ports, no provider network or persisted account data.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const source = (path: string) => pathToFileURL(`${process.cwd()}/${path}`).href;
await import(source("scripts/prompt-test-setup.mjs"));
const { createReviewChatWorkflows } = await import(source("src/app/review-chat-workflows.mjs"));
const { normalizeLlmSettings, publicUserAiPreferences, mergeUserAiPreferences } =
  await import(source("src/modules/ai/index.mjs"));

for (const deploymentEnabled of [false, true]) {
  for (const accountEnabled of [false, true]) {
    let reads = 0;
    const workflows = createReviewChatWorkflows({
      repository: {
        read: async () => { reads += 1; return { thoughts: [], analyses: [] }; },
        update: async () => { throw new Error("No persistence in gate fixture"); }
      },
      generate: async () => { throw new Error("No provider in gate fixture"); },
      chats: {},
      reviews: {},
      hash: (text: string) => text,
      periodicAnalysisEnabled: deploymentEnabled,
      readPeriodicPreferences: async () => ({
        periodicReviews: { analysisEnabled: accountEnabled }
      })
    });
    assert.equal(await workflows.maybeRunPeriodicAnalysis(), null);
    assert.equal(reads, deploymentEnabled && accountEnabled ? 1 : 0,
      "closed deployment or account gate must stop before reading business history");
    if (!deploymentEnabled || !accountEnabled) {
      await assert.rejects(workflows.runAnalysis({ reason: "weekly-background" }),
        { code: "PERIODIC_ANALYSIS_CONSENT_REQUIRED" });
      assert.equal(await workflows.personalizedTaskHandler.canExecute(
        { kind: "analysis", payload: { reason: "weekly-background" } }
      ), false, "queued scheduled work cannot dispatch without consent");
    }
  }
}

assert.equal(normalizeLlmSettings({}).periodicReviews.analysisEnabled, false);
const original = normalizeLlmSettings({ apiKey: "isolated-only" });
const enabled = mergeUserAiPreferences(original, { periodicReviews: { analysisEnabled: true } });
assert.equal(publicUserAiPreferences(enabled).periodicReviews.analysisEnabled, true);
assert.equal(mergeUserAiPreferences(enabled, {}).periodicReviews.analysisEnabled, true);
assert.equal(mergeUserAiPreferences(enabled, { periodicReviews: { analysisEnabled: false } })
  .periodicReviews.analysisEnabled, false);
console.log("Periodic review gates passed: deployment/account consent, queued preparation and preference round trip.");
