import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./prompt-test-setup.mjs";
import { loadPromptCatalog } from "../src/infrastructure/prompt-catalog/index.mjs";
import { installPromptCatalog } from "../src/shared/prompts/index.mjs";
import {
  REPLAY_ANSWER_GRADER_VERSION,
  REPLAY_OUTPUT_SCHEMA_VERSION,
  REPLAY_VARIANTS,
  createDeterministicCitationGrader,
  createGeneralReplayAdapter,
  createLegacyReplayAdapter,
  createNewReplayAdapter,
  runReplaySuite,
  validateReplayFixtureSet
} from "./lib/personalization-replay.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, "scripts", "fixtures", "personalization-replay-v1.json");
const manifestPath = path.join(root, "scripts", "fixtures", "personalization-replay-manifest-v1.json");
const fixtureText = await fs.readFile(fixturePath, "utf8");
const fixtureSet = JSON.parse(fixtureText);
const replayManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
installPromptCatalog(await loadPromptCatalog({
  rootDir: root,
  requestedVersion: replayManifest.promptCatalog.version,
  allowHistorical: true
}));

assert.equal(validateReplayFixtureSet(fixtureSet), fixtureSet);
assert.equal(
  replayManifest.fixtureBaseline.commit,
  "fb1961b28f27e9708fa15ddf38506747db6879e0"
);
assert.equal(
  execFileSync("git", [
    "rev-parse",
    `${replayManifest.fixtureBaseline.commit}:scripts/fixtures/personalization-replay-v1.json`
  ], { cwd: root, encoding: "utf8" }).trim(),
  replayManifest.fixtureBaseline.blob
);
assert.equal(
  crypto.createHash("sha256").update(fixtureText).digest("hex"),
  replayManifest.fixtureBaseline.sha256
);
assert.equal(
  execFileSync("git", [
    "show",
    `${replayManifest.fixtureBaseline.commit}:scripts/fixtures/personalization-replay-v1.json`
  ], { cwd: root, encoding: "utf8" }),
  fixtureText
);
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
assert.equal(report.gateEligible, false);
assert.deepEqual(REPLAY_VARIANTS, ["general", "legacy", "new"]);
assert.equal(
  report.fixtureSetFingerprint,
  "64af56c52e888f97919f190e072e02a9fdf957b03dc864283e392b2255c12a69"
);
assert.equal(
  report.replayManifestFingerprint,
  "f1213f9497c58ec364bfdc7f7a040a519bc59630525936213da3e7073e139c55"
);
assert.equal(report.variants.general.status, "baseline-observed");
assert.equal(report.variants.legacy.status, "baseline-observed");
assert.equal(report.variants.general.gateEligible, false);
assert.equal(report.variants.legacy.gateEligible, false);
assert.equal(report.variants.general.qualityStatus, "not-evaluable");
assert.equal(report.variants.legacy.qualityStatus, "known-baseline-gaps");
assert.equal(report.variants.new.status, "not-run");
assert.equal(report.variants.new.reason, "not-selected-for-baseline-phase");
assert.equal(report.realModelEvaluation.status, "not-run");
assert.equal(report.coverage.productionBehavior, "not-run");
assert.equal(report.realModelEvaluation.fixtureIds.length, 8);
assert.throws(
  () => runReplaySuite(fixtureSet, { manifest: replayManifest, adapters: [] }),
  /Replay adapters do not match the baseline manifest contract/
);
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [
      createGeneralReplayAdapter(),
      createGeneralReplayAdapter(),
      createLegacyReplayAdapter()
    ]
  }),
  /Replay adapters do not match the baseline manifest contract/
);
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
const baselineAdapters = legacyAdapter => [
  createGeneralReplayAdapter(),
  legacyAdapter
];
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
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: baselineAdapters(driftedLegacy)
  }),
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
const invalidThresholds = structuredClone(fixtureSet);
invalidThresholds.thresholds.materialRelevanceRate = null;
assert.throws(
  () => validateReplayFixtureSet(invalidThresholds),
  /thresholds do not match/
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
  adapters: baselineAdapters(selfGradingAdapter)
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
    adapters: baselineAdapters(emptyAssertionAdapter)
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
    adapters: baselineAdapters(spoofedModeAdapter)
  }),
  /Replay adapter identity mismatch/
);

assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [createNewReplayAdapter({
      taskBindings: replayManifest.candidate.taskBindings
    })],
    phase: "candidate"
  }),
  /Replay prompt catalog does not match the active catalog/
);

const staleManifest = structuredClone(replayManifest);
staleManifest.promptCatalog.sha256 = "0".repeat(64);
assert.throws(
  () => runReplaySuite(fixtureSet, { manifest: staleManifest }),
  /Replay prompt catalog does not match/
);

installPromptCatalog(await loadPromptCatalog({
  rootDir: root,
  requestedVersion: replayManifest.candidate.promptCatalog.version,
  allowHistorical: true
}));
const candidateAdapter = createNewReplayAdapter({
  taskBindings: replayManifest.candidate.taskBindings
});
const citationGrader = createDeterministicCitationGrader();
assert.equal(citationGrader.id, REPLAY_ANSWER_GRADER_VERSION);
const candidateReport = runReplaySuite(fixtureSet, {
  manifest: replayManifest,
  adapters: [candidateAdapter],
  phase: "candidate"
});
assert.equal(candidateReport.gateEligible, false);
assert.equal(candidateReport.variants.general.status, "not-run");
assert.equal(candidateReport.variants.legacy.status, "not-run");
assert.equal(candidateReport.variants.new.status, "candidate-observed");
assert.equal(candidateReport.variants.new.gateEligible, false);
assert.equal(candidateReport.variants.new.selectionReceiptGateEligible, true);
assert.equal(
  candidateReport.variants.new.qualityStatus,
  "semantic-and-freshness-model-evaluation-pending"
);
assert.deepEqual(candidateReport.variants.new.pendingEvaluations, [
  "semantic-correctness",
  "freshness",
  "personalization-benefit"
]);
assert.equal(
  candidateReport.variants.new.fingerprint,
  replayManifest.candidate.resultFingerprint
);
assert.deepEqual(candidateReport.variants.new.aggregate, {
  fixtureCount: 16,
  failingFixtureCount: 0,
  materialRelevanceRate: 1,
  criticalEvidenceMissRate: 0,
  evidenceSupportRate: 1,
  freshnessMisstatementRate: null,
  forbiddenSourceUseCount: 0,
  duplicateEventUseCount: 0,
  currentMaterialLossCount: 0
});
assert.equal(
  candidateReport.coverage.productionBehavior,
  "selection-and-receipt-contract-executed"
);
assert.equal(candidateReport.realModelEvaluation.status, "not-run");
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [],
    phase: "candidate"
  }),
  /Replay adapters do not match the candidate manifest contract/
);
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: replayManifest,
    adapters: [candidateAdapter, candidateAdapter],
    phase: "candidate"
  }),
  /Replay adapters do not match the candidate manifest contract/
);
const unfrozenCandidate = structuredClone(replayManifest);
unfrozenCandidate.candidate.status = "not-frozen";
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: unfrozenCandidate,
    adapters: [candidateAdapter],
    phase: "candidate"
  }),
  /requires local-evaluated manifest status/
);
const forgedCandidateCatalog = structuredClone(replayManifest);
forgedCandidateCatalog.candidate.promptCatalog.sha256 = "0".repeat(64);
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: forgedCandidateCatalog,
    adapters: [candidateAdapter],
    phase: "candidate"
  }),
  /Replay prompt catalog does not match/
);
const forgedCandidateRequest = structuredClone(replayManifest);
forgedCandidateRequest.candidate.requestContract.model = "bogus-model";
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: forgedCandidateRequest,
    adapters: [candidateAdapter],
    phase: "candidate"
  }),
  /Replay request contract mismatch: model/
);
const forgedTaskBinding = structuredClone(replayManifest);
forgedTaskBinding.candidate.taskBindings["same-event-across-two-records"].sourceMaterialId =
  "capture:not-in-fixture";
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: forgedTaskBinding,
    adapters: [candidateAdapter],
    phase: "candidate"
  }),
  /Replay candidate task binding is invalid/
);
const missingTaskBinding = structuredClone(replayManifest);
delete missingTaskBinding.candidate.taskBindings["same-event-across-two-records"];
assert.throws(
  () => runReplaySuite(fixtureSet, {
    manifest: missingTaskBinding,
    adapters: [candidateAdapter],
    phase: "candidate"
  }),
  /Replay candidate task bindings are incomplete/
);
for (const result of candidateReport.variants.new.fixtures) {
  assert.match(result.adapterEvidence.receiptFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.adapterEvidence.receiptStatus, "complete");
  assert.equal(result.adapterEvidence.historyRetrievalStatus, "ok");
  assert.equal(result.adapterEvidence.promptContract.mode, "structured-json");
  assert.equal(
    result.adapterEvidence.promptCatalog.version,
    replayManifest.candidate.promptCatalog.version
  );
}

const firstFixture = fixtureSet.fixtures[0];
const honestOutput = candidateAdapter.run(firstFixture, { fixtureIndex: 0 });
const selfGradedClaim = structuredClone(honestOutput);
selfGradedClaim.answerClaims[0].supported = true;
assert.throws(
  () => citationGrader.grade(firstFixture, selfGradedClaim, { fixtureIndex: 0 }),
  /answer claim is invalid/
);
const unselectedCitation = structuredClone(honestOutput);
unselectedCitation.answerClaims[0].sourceIds = ["capture:extraction-quote"];
assert.throws(
  () => citationGrader.grade(firstFixture, unselectedCitation, { fixtureIndex: 0 }),
  /unknown or unselected source/
);
const unsupportedCitation = structuredClone(honestOutput);
const unsupportedText = "X".repeat(unsupportedCitation.answerClaims[0].text.length);
unsupportedCitation.answerText = `${unsupportedText}${unsupportedCitation.answerText.slice(
  unsupportedCitation.answerClaims[0].answerSpan[1]
)}`;
unsupportedCitation.answerClaims[0].text = unsupportedText;
assert.equal(
  citationGrader.grade(firstFixture, unsupportedCitation, { fixtureIndex: 0 })[0].supported,
  false
);
const fragmentCitation = {
  ...honestOutput,
  answerText: "I",
  answerClaims: [{
    id: "fragment",
    text: "I",
    answerSpan: [0, 1],
    sourceIds: [honestOutput.selectedSourceIds[0]]
  }]
};
assert.equal(
  citationGrader.grade(firstFixture, fragmentCitation, { fixtureIndex: 0 })[0].supported,
  false
);
assert.throws(
  () => citationGrader.grade(firstFixture, {
    ...honestOutput,
    answerText: `${honestOutput.answerText}\nUNSUPPORTED FABRICATION`
  }, { fixtureIndex: 0 }),
  /contains ungraded content/
);
assert.throws(
  () => citationGrader.grade(firstFixture, {
    ...honestOutput,
    answerText: "",
    answerClaims: []
  }, { fixtureIndex: 0 }),
  /requires non-empty claims/
);
assert.throws(
  () => citationGrader.grade(firstFixture, {
    ...honestOutput,
    answerText: "   ",
    answerClaims: [{
      id: "whitespace",
      text: "   ",
      answerSpan: [0, 3],
      sourceIds: [honestOutput.selectedSourceIds[0]]
    }]
  }, { fixtureIndex: 0 }),
  /requires non-empty claims/
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
  new: {
    fingerprint: candidateReport.variants.new.fingerprint,
    aggregate: candidateReport.variants.new.aggregate,
    selectionReceiptGateEligible: candidateReport.variants.new.selectionReceiptGateEligible
  },
  realModelEvaluation: report.realModelEvaluation
}, null, 2));
