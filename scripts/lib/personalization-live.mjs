import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateReplayFixtureSet } from "./personalization-replay.mjs";
import { assertReplayCurrentCoverage, REPLAY_INPUT_VERSION, REPLAY_PURPOSE } from "./personalization-task-input.mjs";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const liveFingerprint = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/**
 * 读取真实生成后冻结的合成付费请求材料；该计划不代表当前候选的选材行为。
 * 业务选材更新不重写历史付费合同；当前候选另由 replay/importance 专项执行。
 */
export async function buildPersonalizationLivePlan(rootDir, { manifestVersion = "v2" } = {}) {
  assert.ok(typeof manifestVersion === "string" && ["v2", "v3", "v4"].includes(manifestVersion), "Unknown replay manifest selector");
  const inputVersion = manifestVersion === "v2" ? REPLAY_INPUT_VERSION
    : manifestVersion === "v3" ? "source-time-boundaries-v3" : "source-time-interpretation-v4";
  const purpose = manifestVersion === "v2" ? REPLAY_PURPOSE
    : manifestVersion === "v3" ? "personalization-source-time-boundaries-v3" : "personalization-source-time-interpretation-v4";
  const fixtureText = await fs.readFile(path.join(rootDir, "scripts/fixtures/personalization-replay-v1.json"), "utf8");
  const fixtures = validateReplayFixtureSet(JSON.parse(fixtureText));
  const manifest = JSON.parse(await fs.readFile(path.join(rootDir, `scripts/fixtures/personalization-replay-manifest-${manifestVersion}.json`), "utf8"));
  const archive = JSON.parse(await fs.readFile(path.join(rootDir, "scripts/fixtures/personalization-frozen-live.json"), "utf8"));
  assert.equal(archive.schemaVersion, 1);
  const stored = archive.plans[manifestVersion];
  assert.ok(stored, "Missing frozen historical request material");
  const plan = { ...stored, requests: stored.requests.map(({ messagesRef, ...request }) => {
    const messages = archive.messages[messagesRef];
    assert.ok(Array.isArray(messages), "Missing frozen request messages");
    assert.equal(messagesRef, request.requestSha256);
    assert.equal(liveFingerprint({ messages, parameters: request.parameters }), request.requestSha256,
      "Frozen request content differs from its identity");
    return { ...request, messages };
  }) };
  assert.equal(crypto.createHash("sha256").update(fixtureText).digest("hex"), manifest.fixtureBaseline.sha256);
  assert.equal(plan.fixtureSha256, manifest.fixtureBaseline.sha256);
  assert.equal(plan.fixtureSetFingerprint, manifest.fixtureSetFingerprint);
  assert.equal(plan.manifestFingerprint, liveFingerprint(manifest));
  assert.equal(plan.requestInputVersion, inputVersion);
  assert.equal(plan.purpose, purpose);
  assert.equal(plan.planFingerprint, liveFingerprint(plan.requests));
  assert.equal(plan.requests.length, 48);
  for (const request of plan.requests) {
    const fixture = fixtures.fixtures[request.fixtureIndex];
    assert.equal(fixture.id, request.fixtureId);
    assertReplayCurrentCoverage(fixture, request.messages, request.selectedSourceIds);
    assert.equal(request.parameters.maxOutputTokens, 16000);
    assert.equal(request.parameters.reasoningEffort, "max");
    const catalog = request.variant === "new" ? manifest.candidate.promptCatalog : manifest.promptCatalog;
    assert.deepEqual(request.promptCatalog, catalog);
  }
  assert.ok(plan.reservedCny <= 30, "Frozen plan exceeds original CNY30 ceiling");
  return plan;
}
