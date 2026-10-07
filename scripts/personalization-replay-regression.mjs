import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./prompt-test-setup.mjs";
import {
  REPLAY_OUTPUT_SCHEMA_VERSION,
  REPLAY_VARIANTS,
  createLegacyReplayAdapter,
  runReplaySuite,
  validateReplayFixtureSet
} from "./lib/personalization-replay.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, "scripts", "fixtures", "personalization-replay-v1.json");
const manifestPath = path.join(root, "scripts", "fixtures", "personalization-replay-manifest-v1.json");
const fixtureSet = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const replayManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

assert.equal(validateReplayFixtureSet(fixtureSet), fixtureSet);
assert.equal(
  execFileSync("git", ["show", "-s", "--format=%T", replayManifest.baseline.commit], {
    cwd: root,
    encoding: "utf8"
  }).trim(),
  replayManifest.baseline.tree
);
assert.equal(fixtureSet.fixtures.length, 16);
assert.deepEqual(
  fixtureSet.fixtures.map(fixture => fixture.dimension),
  fixtureSet.dimensions
);
assert.equal(JSON.stringify(fixtureSet).includes("bytedance"), false);
assert.equal(JSON.stringify(fixtureSet).includes("/Users/"), false);

const report = runReplaySuite(fixtureSet, { manifest: replayManifest });
assert.equal(report.schemaVersion, REPLAY_OUTPUT_SCHEMA_VERSION);
assert.deepEqual(REPLAY_VARIANTS, ["general", "legacy", "new"]);
assert.equal(
  report.fixtureSetFingerprint,
  "64af56c52e888f97919f190e072e02a9fdf957b03dc864283e392b2255c12a69"
);
assert.equal(
  report.replayManifestFingerprint,
  "4d6e399c507e655cab909a7d1feda41dbdd36399049d063d5436191b63e730d8"
);
assert.equal(report.variants.general.status, "baseline-observed");
assert.equal(report.variants.legacy.status, "baseline-observed");
assert.equal(report.variants.general.gateEligible, false);
assert.equal(report.variants.legacy.gateEligible, false);
assert.equal(report.variants.general.qualityStatus, "not-evaluable");
assert.equal(report.variants.legacy.qualityStatus, "known-baseline-gaps");
assert.equal(report.variants.new.status, "not-run");
assert.equal(report.variants.new.reason, "new-orchestrator-not-implemented");
assert.equal(report.realModelEvaluation.status, "not-run");
assert.equal(report.coverage.productionBehavior, "not-run");
assert.equal(report.realModelEvaluation.fixtureIds.length, 8);
assert.deepEqual(report.realModelEvaluation.fixtureIds, [
  "extraction-source-identity",
  "historical-event-not-current-state",
  "new-version-supersedes-old",
  "unknown-relationship-identity",
  "concept-review-excludes-health-dump",
  "device-guidance-is-not-user-fact",
  "failed-advice-reason-affects-next-answer",
  "same-task-three-way-comparison"
]);

assert.deepEqual(report.variants.general.aggregate, {
  fixtureCount: 16,
  failingFixtureCount: 10,
  materialRelevanceRate: null,
  criticalEvidenceMissRate: 1,
  evidenceSupportRate: null,
  freshnessMisstatementRate: null,
  forbiddenSourceUseCount: 0,
  duplicateEventUseCount: 0,
  currentMaterialLossCount: 0
});
assert.deepEqual(report.variants.legacy.aggregate, {
  fixtureCount: 16,
  failingFixtureCount: 11,
  materialRelevanceRate: 0.652174,
  criticalEvidenceMissRate: 0,
  evidenceSupportRate: 0.6,
  freshnessMisstatementRate: 1,
  forbiddenSourceUseCount: 2,
  duplicateEventUseCount: 1,
  currentMaterialLossCount: 0
});
assert.equal(
  report.variants.general.fingerprint,
  "f36209cdae42ebb7b9dcde7130af9bf2269e83f0d40ad34333c90e7c97a97797"
);
assert.equal(
  report.variants.legacy.fingerprint,
  "7d8d97b948c49d2d4ad02e996681205428b3b7515fd83780dc818ec7418086a2"
);
assert.match(
  report.variants.legacy.fixtures[0].adapterEvidence.promptSha256,
  /^[a-f0-9]{64}$/
);

const extraction = report.variants.legacy.fixtures.find(
  fixture => fixture.fixtureId === "extraction-source-identity"
);
assert.deepEqual(extraction.failureCodes, [
  "evidence-support-below-100",
  "forbidden-source-used",
  "material-relevance-below-85",
  "semantic-assertion-mismatch"
]);
assert.equal(extraction.selectedSourceIds.includes("thought-ai:extraction-draft"), false);

const permission = report.variants.legacy.fixtures.find(
  fixture => fixture.fixtureId === "denied-and-cross-account-sources"
);
assert.deepEqual(permission.failureCodes, []);
assert.deepEqual(permission.selectedSourceIds, ["current:permission-task"]);
assert.equal(permission.executableCases.length, 4);
assert.equal(permission.executableCases.every(testCase => testCase.status === "passed"), true);
const concurrency = report.variants.legacy.fixtures.find(
  fixture => fixture.fixtureId === "late-v2-cannot-overwrite-v3"
);
assert.equal(concurrency.executableCases.length, 2);
assert.equal(concurrency.executableCases.every(testCase => testCase.status === "passed"), true);
const restraint = report.variants.general.fixtures.find(
  fixture => fixture.fixtureId === "unknown-relationship-identity"
);
assert.equal(restraint.metrics.materialRelevanceRate, null);

const legacy = createLegacyReplayAdapter();
const driftedLegacy = {
  ...legacy,
  run(fixture, context) {
    const output = legacy.run(fixture, context);
    if (fixture.id === "new-version-supersedes-old") {
      output.selectedSourceIds = output.selectedSourceIds.filter(id => id !== "capture:update-new");
    }
    return output;
  }
};
assert.throws(
  () => runReplaySuite(fixtureSet, { manifest: replayManifest, adapters: [driftedLegacy] }),
  /Replay baseline drift for new-version-supersedes-old\/legacy/
);

const invalid = structuredClone(fixtureSet);
invalid.fixtures[0].stubAssertions.legacy[0].sourceIds = ["capture:missing"];
assert.throws(
  () => validateReplayFixtureSet(invalid),
  /references unknown source capture:missing/
);
const emptyTask = structuredClone(fixtureSet);
emptyTask.fixtures[0].task = "";
assert.throws(
  () => validateReplayFixtureSet(emptyTask),
  /must have a non-empty task/
);

const selfGradingAdapter = {
  ...legacy,
  run(fixture, context) {
    const output = legacy.run(fixture, context);
    output.assertions = output.assertions.map(assertion => ({
      ...assertion,
      supported: true,
      semanticallyCorrect: true,
      freshnessMisstatement: false
    }));
    return output;
  }
};
const selfGradingReport = runReplaySuite(fixtureSet, {
  manifest: replayManifest,
  adapters: [selfGradingAdapter]
});
assert.deepEqual(
  selfGradingReport.variants.legacy.aggregate,
  report.variants.legacy.aggregate,
  "adapter self-grading fields must not affect oracle-derived metrics"
);

const emptyAssertionAdapter = {
  ...legacy,
  run(fixture, context) {
    return { ...legacy.run(fixture, context), assertions: [] };
  }
};
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [emptyAssertionAdapter]
  }),
  /Replay deterministic assertions drift/
);

const spoofedModeAdapter = {
  ...legacy,
  run(fixture, context) {
    return {
      ...legacy.run(fixture, context),
      executionMode: "model",
      assertions: []
    };
  }
};
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [spoofedModeAdapter]
  }),
  /Replay adapter identity mismatch/
);

assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [{
      id: "new",
      executionMode: "model",
      run: fixture => ({
        schemaVersion: 1,
        variant: "new",
        executionMode: "model",
        fixtureId: fixture.id,
        selectedSourceIds: fixture.materials.filter(item => item.required).map(item => item.id),
        assertions: []
      })
    }]
  }),
  /requires the trusted 10b answer grader/
);

const staleManifest = structuredClone(replayManifest);
staleManifest.promptCatalog.sha256 = "0".repeat(64);
assert.throws(
  () => runReplaySuite(fixtureSet, { manifest: staleManifest }),
  /Replay prompt catalog does not match/
);

console.log(JSON.stringify({
  fixtureSetVersion: report.fixtureSetVersion,
  fixtureSetFingerprint: report.fixtureSetFingerprint,
  replayManifestFingerprint: report.replayManifestFingerprint,
  general: {
    fingerprint: report.variants.general.fingerprint,
    aggregate: report.variants.general.aggregate
  },
  legacy: {
    fingerprint: report.variants.legacy.fingerprint,
    aggregate: report.variants.legacy.aggregate
  },
  new: report.variants.new,
  realModelEvaluation: report.realModelEvaluation
}, null, 2));
