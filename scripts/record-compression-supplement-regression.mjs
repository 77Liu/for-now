import assert from "node:assert/strict";
import {
  buildHistoricalUserSupplementInput,
  emptyHistoricalUserSupplement,
  estimateHistoricalUserSupplementTokens,
  estimateHistoricalUserSupplementOutputTokens,
  HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET,
  HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS,
  HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
  HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
  HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
  HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET,
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  normalizeHistoricalUserSupplement,
  parseHistoricalUserSupplementOutput,
  validateHistoricalUserSupplement
} from "../src/modules/record-compressions/index.mjs";

const source = {
  sourceId: "capture:capture:user-source-1",
  origin: "user_original",
  occurredOn: "2026-10-04",
  sourceHash: "a".repeat(64),
  permissionRevision: 3,
  text: "我会先确定优先级，再按步骤完成重要事项。"
};
const sourceInput = buildHistoricalUserSupplementInput({ userSources: [source] });

assert.equal(HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS, 3);
assert.match(HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION, /^historical-user-supplement\.v\d+$/);
assert.match(HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION, /^historical-user-supplement\.v\d+$/);
assert.equal(HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET, RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens);
assert.equal(HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET, 12_000);
assert.deepEqual(Object.keys(sourceInput), ["input", "sourceManifest", "coverage"]);
assert.deepEqual(Object.keys(sourceInput.input), ["schemaVersion", "userSources"]);
assert.deepEqual(sourceInput.input.userSources, [{
  sourceId: source.sourceId,
  localDate: source.occurredOn,
  text: source.text
}]);
assert.deepEqual(sourceInput.sourceManifest, [{
  sourceId: source.sourceId,
  localDate: source.occurredOn,
  sourceHash: source.sourceHash,
  permissionRevision: source.permissionRevision
}]);
assert.deepEqual(sourceInput.coverage, {
  windowDays: 7,
  availableSources: 1,
  includedSources: 1,
  complete: true
});
assert.ok(estimateHistoricalUserSupplementTokens(sourceInput.input) <= HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET);

for (const invalid of [
  { ...source, origin: "ai_generated" },
  { ...source, occurredOn: "2026-02-30" },
  { ...source, sourceHash: "not-a-sha256" },
  { ...source, permissionRevision: -1 },
  { ...source, sourceId: "" },
  { ...source, text: "  " }
]) {
  assert.throws(() => buildHistoricalUserSupplementInput({ userSources: [invalid] }), error => (
    error.code === "HISTORICAL_USER_SUPPLEMENT_INPUT_INVALID"
  ));
}
assert.throws(() => buildHistoricalUserSupplementInput({
  userSources: [source],
  aiReferences: [{ sourceId: "ai-1" }]
}), /输入无效/);
assert.throws(() => buildHistoricalUserSupplementInput({ userSources: [source, source] }), /重复来源/);

const baseDate = Date.parse("2026-10-01T00:00:00.000Z");
const oversizedSources = Array.from({ length: 12 }, (_, index) => {
  const dayOffset = Math.floor(index / 2);
  return {
    sourceId: `journal:journal:balanced-${index}`,
    origin: "user_original",
    occurredOn: new Date(baseDate + dayOffset * 86_400_000).toISOString().slice(0, 10),
    sourceHash: (`0${(index + 1).toString(16)}`).slice(-2).repeat(32),
    permissionRevision: index % 3,
    text: `source-${index}-` + "x".repeat(4_000)
  };
});
const partialInput = buildHistoricalUserSupplementInput({ userSources: oversizedSources, windowDays: 7 });
assert.equal(partialInput.coverage.availableSources, oversizedSources.length);
assert.ok(partialInput.coverage.includedSources < oversizedSources.length);
assert.equal(partialInput.coverage.complete, false);
assert.ok(estimateHistoricalUserSupplementTokens(partialInput.input) <= HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET);
assert.equal(new Set(partialInput.input.userSources.map(item => item.localDate)).size, 6,
  "round-robin source retention covers every available date before adding a second source for any date");
assert.deepEqual(
  buildHistoricalUserSupplementInput({ userSources: oversizedSources, windowDays: 7 }),
  partialInput,
  "source balancing is deterministic"
);

const output = {
  schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  candidates: [{
    statement: "先排优先级",
    exactQuote: "优先级",
    sourceId: source.sourceId
  }]
};
const parsed = parseHistoricalUserSupplementOutput(output, { input: sourceInput });
assert.equal(parsed.schemaVersion, HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION);
assert.deepEqual(parsed.records, [{
  recordVersion: HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
  statement: output.candidates[0].statement,
  exactQuote: output.candidates[0].exactQuote,
  source: {
    localDate: source.occurredOn,
    sourceId: source.sourceId,
    sourceHash: source.sourceHash,
    permissionRevision: source.permissionRevision
  }
}]);
assert.deepEqual(parsed.coverage, sourceInput.coverage);
assert.equal(parsed.tokenUsage.estimated, true);
assert.equal(parsed.tokenUsage.scope, "model_output");
assert.equal(parsed.tokenUsage.tokens, estimateHistoricalUserSupplementOutputTokens(parsed.records));
assert.ok(parsed.tokenUsage.tokens <= HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET);
assert.ok(estimateHistoricalUserSupplementTokens(parsed.records) > HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET,
  "local source hash, date, and permission metadata do not consume the model output budget");
assert.deepEqual(normalizeHistoricalUserSupplement(parsed), parsed);
assert.deepEqual(validateHistoricalUserSupplement(parsed, { userSources: [source] }), {
  records: parsed.records,
  invalidated: []
});

for (const invalidOutput of [
  { ...output, extra: true },
  { ...output, schemaVersion: "wrong-version" },
  { ...output, candidates: Array.from({ length: 4 }, () => output.candidates[0]) },
  { ...output, candidates: [{ ...output.candidates[0], sourceId: "missing-source" }] },
  { ...output, candidates: [{ ...output.candidates[0], exactQuote: "原文中不存在" }] },
  { ...output, candidates: [{ ...output.candidates[0], extra: "unknown" }] }
]) {
  assert.throws(() => parseHistoricalUserSupplementOutput(invalidOutput, { input: sourceInput }), error => (
    error.code === "HISTORICAL_USER_SUPPLEMENT_OUTPUT_INVALID"
  ));
}

const ambiguousSources = [
  source,
  {
    ...source,
    sourceId: "journal:journal:user-source-2",
    sourceHash: "b".repeat(64),
    text: `另一条记录包含 ${output.candidates[0].exactQuote}`
  }
];
const ambiguousInput = buildHistoricalUserSupplementInput({ userSources: ambiguousSources });
assert.throws(() => parseHistoricalUserSupplementOutput(output, { input: ambiguousInput }), /唯一命中一个当前 user source/);

const tooLargeOutput = {
  schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  candidates: Array.from({ length: 3 }, (_, index) => ({
    statement: "。".repeat(240),
    exactQuote: `事项${index}`,
    sourceId: source.sourceId
  }))
};
const largeSource = { ...source, text: `事项0 事项1 事项2` };
const largeInput = buildHistoricalUserSupplementInput({ userSources: [largeSource] });
assert.throws(() => parseHistoricalUserSupplementOutput(tooLargeOutput, { input: largeInput }), new RegExp(`${HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET}-token预算`));

const changedSources = [
  { ...source, sourceHash: "d".repeat(64) },
  { ...source, permissionRevision: source.permissionRevision + 1 },
  { ...source, occurredOn: "2026-10-05" },
  { ...source, text: "其他用户原文。" }
];
for (const currentSource of changedSources) {
  const result = validateHistoricalUserSupplement(parsed, { userSources: [currentSource] });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.invalidated, [{ sourceId: source.sourceId, reason: "source_changed_or_unavailable" }]);
}
const duplicateCurrentQuote = validateHistoricalUserSupplement(parsed, { userSources: ambiguousSources });
assert.deepEqual(duplicateCurrentQuote.records, []);
assert.equal(duplicateCurrentQuote.invalidated[0].sourceId, source.sourceId);

const invalidStored = validateHistoricalUserSupplement({ ...parsed, tokenUsage: { estimated: true, scope: "model_output", tokens: 0 } });
assert.deepEqual(invalidStored.records, []);
assert.equal(invalidStored.invalidated[0].reason, "invalid_supplement");
assert.throws(() => normalizeHistoricalUserSupplement({ ...parsed, records: parsed.records.concat(parsed.records) }), error => (
  error.code === "HISTORICAL_USER_SUPPLEMENT_STORAGE_INVALID"
));
assert.deepEqual(emptyHistoricalUserSupplement(), {
  schemaVersion: HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
  records: [],
  coverage: { windowDays: 7, availableSources: 0, includedSources: 0, complete: true },
  tokenUsage: {
    estimated: true,
    scope: "model_output",
    tokens: estimateHistoricalUserSupplementOutputTokens([])
  }
});

console.log(`Historical user supplement contract passed: synthetic-only sources, date-balanced 12k input cap, strict quote/source binding, 3-record/${HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET}-token output, current-source revalidation.`);
