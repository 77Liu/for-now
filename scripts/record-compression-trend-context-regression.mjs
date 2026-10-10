import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createEmptyStore,
  currentRecordCompressionTrend,
  DEFAULT_RECORD_TIMEZONE,
  parseVerifiedAnswer
} from "../src/app/index.mjs";
import {
  buildRecordCompressionInput,
  estimateRecordCompressionTokens,
  parseRecordCompressionOutput,
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_PROMPT_VERSION,
  RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET,
  RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET,
  RECORD_COMPRESSION_WINDOW_DAYS,
  sevenLocalDatesForTimezone
} from "../src/modules/record-compressions/index.mjs";

const asOf = "2026-10-10T12:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const localDates = sevenLocalDatesForTimezone(DEFAULT_RECORD_TIMEZONE, asOf);
const store = createEmptyStore();
const authorizedUserSourceIds = new Set();
const unsentTailPhrase = "UNSENT_TREND_SOURCE_TAIL_7F3C91";

for (const localDate of localDates) {
  const occurredAt = `${localDate}T08:00:00.000Z`;
  const questionId = `question-${localDate}`;
  const remarks = localDate === localDates.at(-1) ? Array.from({ length: 1 }, (_, index) => ({
    id: `ai-remark-${localDate}-${index}`,
    text: `模型生成的趋势参考${index}，未经用户确认。`.repeat(4),
    authorType: "ai",
    origin: "ai_generated",
    occurredAt,
    occurredOn: localDate,
    version: 1
  })) : [];
  store.thoughts.push({
    id: questionId,
    type: "question",
    content: localDate === localDates.at(-1)
      ? `${"可发送的趋势来源前缀。".repeat(40)}${unsentTailPhrase}`
      : `用户当天的合成记录 ${localDate}。`,
    authorType: "user",
    origin: "manual",
    occurredAt,
    occurredOn: localDate,
    version: 1,
    remarks
  });
}

const quoteDate = localDates.at(-1);
const quoteId = `quote-${quoteDate}`;
store.quotes.push({
  id: quoteId,
  content: "合成外部引文原文。",
  source: "合成资料",
  occurredAt: `${quoteDate}T08:00:00.000Z`,
  occurredOn: quoteDate,
  version: 1
});

for (const localDate of localDates) {
  const input = buildRecordCompressionInput(store, {
    accountId: "account-a",
    localDate,
    timezone: DEFAULT_RECORD_TIMEZONE,
    asOf,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    sourcePermission: () => true,
    hash
  });
  const userSource = input.userSources.find(source => source.recordId === `question-${localDate}`);
  const quoteSource = input.userSources.find(source => source.recordId === quoteId);
  const aiSources = input.aiReferences.filter(source => source.origin === "ai_generated");
  assert.ok(userSource);
  authorizedUserSourceIds.add(userSource.sourceId);
  assert.equal(aiSources.length, localDate === localDates.at(-1) ? 1 : 0);
  const output = {
    schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
    daily: {
      observations: localDate === quoteDate ? [{
        text: `用户事实摘要 ${localDate}`,
        nature: "user_fact",
        sourceIds: [userSource.sourceId]
      }] : [],
      metricKeys: [],
      missing: []
    },
    thoughtsIdeas: {
      focus: localDate === quoteDate ? [{
        text: "用户主观认为需要持续整理。",
        nature: "user_subjective",
        sourceIds: [userSource.sourceId]
      }] : [],
      changes: [],
      openQuestions: []
    },
    other: {
      themes: [],
      collectedQuotes: localDate === quoteDate && quoteSource
        ? [{ text: "外部引文摘要。", sourceIds: [quoteSource.sourceId] }]
        : []
    },
    aiReference: aiSources.map((source, index) => ({
      text: `AI参考${index}-${localDate}。`,
      origin: "ai_generated",
      sourceIds: [source.sourceId],
      derivedFrom: source.derivedFrom
    })),
    stableUserCandidates: [],
    conflicts: [],
    warnings: []
  };
  const summary = parseRecordCompressionOutput(output, {
    input,
    id: `summary-${localDate}`,
    generatedAt: asOf
  });
  Object.assign(summary, {
    localDate,
    timezone: DEFAULT_RECORD_TIMEZONE,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    periodStart: input.window.start,
    periodEnd: input.window.endExclusive,
    sourceRefs: input.sourceManifest.map(source => ({
      sourceId: source.sourceId,
      resourceType: source.resourceType,
      recordId: source.recordId,
      rootId: source.rootId,
      targetKey: source.targetKey,
      version: source.version,
      sourceHash: source.sourceHash,
      permissionRevision: source.permissionRevision
    }))
  });
  store.recordCompressions.push(summary);
}

const trend = currentRecordCompressionTrend(store, {
  accountId: "account-a",
  timezone: DEFAULT_RECORD_TIMEZONE,
  asOf,
  hash
});
assert.equal(trend.payload.availableDays, RECORD_COMPRESSION_WINDOW_DAYS);
assert.ok(trend.payload.aiReferences.length > 0);
assert.ok(trend.payload.aiReferences.every(reference => (
  reference.origin === "ai_generated"
  && reference.originLabel === "AI generated"
  && reference.disclaimer === "仅供参考，非用户事实"
  && reference.isUserFact === false
  && !("sourceIds" in reference)
  && !("derivedFrom" in reference)
  && !("citationId" in reference)
  && !("citations" in reference)
)));
assert.equal(trend.payload.userFacts.length, 1);
assert.ok(trend.payload.userFacts.every(row => (
  row.localDate === quoteDate && row.module === "daily"
  && row.nature === "user_fact" && row.sourceIds.length > 0 && row.citations.length > 0
)));
assert.equal(trend.payload.userSubjective.length, 1);
assert.equal(trend.payload.userSubjective[0].nature, "user_subjective");
assert.equal(trend.payload.userSubjective[0].module, "thought");
assert.ok(trend.payload.days.every(day => !("daily" in day) && !("thoughts" in day)));
assert.equal(trend.payload.collectedQuotes.length, 1);
assert.equal(trend.payload.collectedQuotes[0].origin, "quoted_external");
assert.match(trend.payload.collectedQuotes[0].label, /不代表用户观点/);
assert.ok(trend.payload.sources.every(source => authorizedUserSourceIds.has(source.sourceId)));
assert.ok(trend.citationSources.some(source => source.source.informationType === "quoted_external"));
assert.ok(trend.citationSources.filter(source => source.source.informationType !== "quoted_external")
  .every(source => source.source.informationType === "user_original"));
for (const promptSource of trend.payload.sources) {
  const citationSource = trend.citationSources.find(source => source.citationId === promptSource.citationId);
  assert.ok(citationSource, `missing citation source ${promptSource.citationId}`);
  assert.equal(citationSource.text, promptSource.text,
    "citation validation text must equal the exact source text included in the prompt payload");
}
for (const promptSource of trend.payload.collectedQuotes) {
  const citationSource = trend.citationSources.find(source => source.citationId === promptSource.citationId);
  assert.ok(citationSource, `missing quote citation source ${promptSource.citationId}`);
  assert.equal(citationSource.text, promptSource.text,
    "quote citation validation text must equal the exact quote text included in the prompt payload");
}
assert.equal(JSON.stringify(trend.payload).includes(unsentTailPhrase), false,
  "the unique tail phrase must be absent from the model prompt payload");
const truncatedSource = trend.citationSources.find(source => source.source.resourceId === `question-${quoteDate}`);
assert.ok(truncatedSource);
const tailCitation = parseVerifiedAnswer(JSON.stringify({
  answer: "请按原文补充这一点。",
  citations: [{ citationId: truncatedSource.citationId, exactQuote: unsentTailPhrase }]
}), trend.citationSources);
assert.equal(tailCitation.citationStatus, "none",
  "a citation cannot quote a source tail that was truncated from the prompt");
assert.deepEqual(tailCitation.citations, []);
assert.equal(trend.payload.sources.some(source => (
  trend.payload.aiReferences.some(reference => reference.citationId === source.citationId)
)), false, "AI references do not acquire user citation IDs");

const aiReferenceTokenBudget = RECORD_COMPRESSION_OUTPUT_BUDGETS.aiReferenceTokens
  * RECORD_COMPRESSION_WINDOW_DAYS;
assert.ok(estimateRecordCompressionTokens(trend.payload.aiReferences) <= aiReferenceTokenBudget);
assert.ok(estimateRecordCompressionTokens(trend.payload) <= RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET);
assert.ok(JSON.stringify(trend.payload).length <= RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET);
assert.ok(Buffer.byteLength(JSON.stringify(trend.payload), "utf8")
  <= RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET * 3);

console.log("Record-compression trend context source separation and AI-reference regression passed.");
