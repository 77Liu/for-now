import assert from "node:assert/strict";
import {
  STORE_VERSION, TRASH_RETENTION_DAYS, createEmptyStore, emptyStore,
  createStoreNormalizer, normalizeCommercialization, normalizeStore
} from "../src/app/index.mjs";
import { mapStoreObjects, rebuildStoreObjects } from "../src/shared/persistence/index.mjs";
import {
  buildHistoricalUserSupplementInput,
  emptyHistoricalUserSupplement,
  HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  parseHistoricalUserSupplementOutput
} from "../src/modules/record-compressions/index.mjs";
import { migrationStore } from "./fixtures/migration-store.mjs";

process.env.TZ = "Asia/Shanghai";

const STORE_COLLECTION_KEYS = [
  "checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books",
  "keepsakes", "quotes", "experiments", "analyses", "recordCompressions", "customMetrics", "trash",
  "attachmentCleanup", "speechCache", "aiTasks", "notifications", "actions", "habits",
  "habitCheckins", "feedback", "validationLedger", "userClaims", "modelUnknowns",
  "evidenceSources", "evidencePermissions", "perceptionEvents"
];
const fixedNow = "2026-10-05T01:02:03.000Z";
const fixedCurrentTime = Date.parse("2026-10-05T04:05:06.000Z");
const normalizeWithFixedClock = createStoreNormalizer({
  now: () => fixedNow,
  today: () => "2026-10-05",
  currentTime: () => fixedCurrentTime
});

assert.equal(STORE_VERSION, 18);
assert.equal(TRASH_RETENTION_DAYS, 30);
assert.equal(emptyStore.version, STORE_VERSION);
assert.equal(normalizeStore({ version: STORE_VERSION }).version, STORE_VERSION);
for (const key of STORE_COLLECTION_KEYS) assert.deepEqual(emptyStore[key], []);
const isolatedDefault = createEmptyStore();
isolatedDefault.checkins.push({ id: "local-only" });
assert.deepEqual(createEmptyStore().checkins, []);
assert.deepEqual(createEmptyStore().recordCompressions, []);
assert.deepEqual(createEmptyStore().historicalUserSupplement, emptyHistoricalUserSupplement());

const supplementSource = {
  sourceId: "capture:capture:supplement-source",
  origin: "user_original",
  occurredOn: "2026-10-04",
  sourceHash: "c".repeat(64),
  permissionRevision: 3,
  text: "我会按优先级逐项推进。"
};
const supplementInput = buildHistoricalUserSupplementInput({ userSources: [supplementSource] });
const historicalUserSupplement = parseHistoricalUserSupplementOutput({
  schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  candidates: [{
    statement: "按优先级逐项推进。",
    exactQuote: "按优先级逐项推进",
    sourceId: supplementSource.sourceId
  }]
}, { input: supplementInput });

const input = {
  version: 1,
  checkins: [{
    id: "checkin-legacy",
    createdAt: "2026-01-01T23:30:00.000Z",
    occurredOn: "2026-01-01",
    mood: 4,
    stress: 2,
    futureRecordField: { retained: true }
  }, {
    id: "checkin-fixed-clock",
    mood: 3,
    stress: 3
  }],
  captures: [{
    id: "capture-extension",
    createdAt: "2026-10-05T00:00:00.000Z",
    content: "原文",
    futureCaptureField: ["keep"]
  }],
  journals: [{
    id: "journal-1",
    createdAt: "2026-10-05T00:00:00.000Z",
    title: "已存在日记"
  }],
  journalDraft: {
    journalId: "journal-1",
    title: "  草稿标题  ",
    content: "  草稿正文  ",
    updatedAt: "not-an-iso-date",
    internalOnly: "drop"
  },
  recordCompressions: [{
    id: "compression-day-2026-10-05",
    version: 0,
    revision: 2,
    status: "ready",
    schemaVersion: "record-compression-output.v1",
    localDate: "2026-10-05",
    timezone: "Asia/Shanghai",
    periodStart: "2026-10-04T16:00:00.000Z",
    periodEnd: "2026-10-05T16:00:00.000Z",
    promptVersion: "daily-record-compression.v1",
    sourceManifestHash: "a".repeat(64),
    generatedAt: "2026-10-05T16:10:00.000Z",
    window: {
      start: "2026-10-04T16:00:00.000Z",
      endExclusive: "2026-10-05T16:00:00.000Z",
      localDate: "2026-10-05",
      asOf: "2026-10-05T16:00:00.000Z",
      timezone: "Asia/Shanghai",
      completeness: "complete"
    },
    daily: { observations: [{ text: "睡眠时间比昨天更规律。", nature: "user_subjective", sourceIds: ["source-1"] }], metricKeys: [], missing: [] },
    thoughtsIdeas: { focus: [{ text: "完成项目收尾", nature: "user_subjective", sourceIds: ["source-1"] }], changes: [], openQuestions: [] },
    other: { themes: [], collectedQuotes: [] },
    aiReference: [{ text: "仅供参考", origin: "ai_generated", sourceIds: [] }],
    stableUserCandidates: [],
    conflicts: [],
    coverage: { total: 1, included: 1, excluded: 0, truncated: false },
    metrics: [],
    warnings: [],
    tokenUsage: { estimated: true, method: "test", outputTokens: 10, moduleTokens: {}, stableCandidatesTokens: 0, truncated: false },
    sourceManifest: [{ sourceId: "source-1", recordId: "daily-record-1", sourceHash: "b".repeat(64) }],
    sourceRefs: [{
      sourceId: "source-1",
      recordId: "daily-record-1",
      version: 3,
      permissionRevision: 2,
      contentSha256: "b".repeat(64)
    }],
    futureMetadata: { retained: [null, "unknown-field"] }
  }],
  historicalUserSupplement,
  bookDraft: { content: "legacy draft" },
  trash: [
    {
      id: "trash-capture",
      type: "capture",
      payload: {
        id: "capture-deleted",
        transcription: {
          rawText: "  原始转写  ",
          polishedText: "  整理稿  ",
          condensedText: "  凝练稿  ",
          errorCode: "  ASR_FAILED  ",
          condenseErrorCode: "  CONDENSE_FAILED  ",
          provider: "legacy-provider"
        },
        speechCache: [{
          id: "legacy-speech",
          sourceVersion: 2,
          attachmentPath: "/attachments/legacy.mp3"
        }]
      }
    },
    {
      id: "trash-keepsake",
      type: "keepsake",
      payload: {
        id: "keepsake-deleted",
        category: "legacy-category",
        extension: "keep"
      },
      deletedAt: "2026-09-01T00:00:00.000Z",
      purgeAfter: "2026-10-01T00:00:00.000Z"
    },
    { id: "", type: "capture", payload: {} }
  ],
  attachmentCleanup: [
    { path: "/attachments/orphan.png", attempts: "2.4", errorCode: "  RETRY  " },
    { path: "../private", attempts: 1 }
  ],
  commercialization: {
    version: 1,
    assumptions: {
      validation: {
        participants: 7,
        feePerParticipantCny: 321
      },
      subscription: {
        payingUsers: 20,
        activeDaysPerMonth: 31,
        aiCallsPerActiveDay: 99,
        imageCallsPerUserMonth: 77
      },
      delivery: {
        ordersPerMonth: 4,
        pricePerOrderCny: 654,
        aiCallsPerOrder: 999,
        imageCallsPerOrder: 88
      }
    }
  },
  publicExtension: {
    nested: [null, false, 0, ""],
    path: "/attachments/extension.png"
  }
};
const originalInput = structuredClone(input);
const normalized = normalizeWithFixedClock(input);

assert.deepEqual(input, originalInput, "normalization must not modify its input");
assert.equal(normalized.version, STORE_VERSION);
assert.equal(normalized.checkins[0].occurredOn, "2026-01-02");
assert.equal(normalized.checkins[0].occurredAt, "");
assert.equal(normalized.checkins[0].eventTimePrecision, "date");
assert.equal(normalized.checkins[0].stress, 4);
assert.deepEqual(normalized.checkins[0].futureRecordField, { retained: true });
assert.equal(normalized.checkins[1].occurredOn, "");
assert.equal(normalized.checkins[1].occurredAt, "");
assert.equal(normalized.checkins[1].eventTimePrecision, "unknown");
assert.deepEqual(normalized.captures[0].futureCaptureField, ["keep"]);
assert.equal(normalized.recordCompressions[0].version, 1);
assert.equal(normalized.recordCompressions[0].revision, 2);
assert.equal(normalized.recordCompressions[0].status, "ready");
assert.equal(normalized.recordCompressions[0].timezone, "Asia/Shanghai");
assert.deepEqual(normalized.recordCompressions[0].daily, input.recordCompressions[0].daily);
assert.deepEqual(normalized.recordCompressions[0].sourceRefs, input.recordCompressions[0].sourceRefs);
assert.deepEqual(normalized.recordCompressions[0].futureMetadata, input.recordCompressions[0].futureMetadata);
assert.deepEqual(normalized.historicalUserSupplement, historicalUserSupplement);
assert.deepEqual(normalized.publicExtension, input.publicExtension);
assert.notStrictEqual(normalized.publicExtension, input.publicExtension);
assert.equal(normalized.onboarding.status, "completed");
assert.equal(normalized.onboardingV2.session.status, "skipped");

assert.deepEqual(normalized.journalDraft, {
  journalId: "journal-1",
  title: "草稿标题",
  content: "草稿正文",
  updatedAt: fixedNow
});
assert.equal(Object.hasOwn(normalized, "bookDraft"), false);

assert.equal(normalized.trash.length, 2);
const captureTrash = normalized.trash.find(item => item.id === "trash-capture");
assert.equal(captureTrash.deletedAt, fixedNow);
assert.equal(
  captureTrash.purgeAfter,
  new Date(fixedCurrentTime + 30 * 86400000).toISOString()
);
assert.equal(captureTrash.payload.transcription.rawText, "原始转写");
assert.equal(captureTrash.payload.transcription.provider, "legacy-provider");
assert.equal(Object.hasOwn(captureTrash.payload, "speechCache"), false);
assert.equal(normalized.speechCache[0].sourceType, "capture");
assert.equal(normalized.speechCache[0].sourceId, "capture-deleted");
const keepsakeTrash = normalized.trash.find(item => item.id === "trash-keepsake");
assert.equal(Object.hasOwn(keepsakeTrash.payload, "category"), false);
assert.equal(keepsakeTrash.payload.extension, "keep");
assert.equal(keepsakeTrash.deletedAt, "2026-09-01T00:00:00.000Z");
assert.deepEqual(normalized.attachmentCleanup, [{
  path: "/attachments/orphan.png",
  createdAt: fixedNow,
  lastAttemptAt: "",
  attempts: 2,
  errorCode: "RETRY"
}]);

const commercialization = normalized.commercialization;
assert.equal(commercialization.version, 3);
assert.equal(commercialization.assumptions.validation.participants, 7);
assert.equal(commercialization.assumptions.validation.rewardPerParticipantCny, 321);
assert.equal(commercialization.assumptions.delivery.serviceFeePerOrderCny, 654);
assert.equal(commercialization.assumptions.usageProfiles.low.activeDaysPerMonth, 31);
assert.equal(commercialization.assumptions.usageProfiles.high.foregroundAiCallsPerActiveDay, 99);
assert.equal(commercialization.assumptions.usageProfiles.full.imageCallsPerMonth, 77);
assert.deepEqual(commercialization.legacyV2, {
  migratedFromVersion: 1,
  subscription: {
    activeDaysPerMonth: 31,
    aiCallsPerActiveDay: 99,
    imageCallsPerUserMonth: 77
  },
  delivery: {
    aiCallsPerOrder: 999,
    imageCallsPerOrder: 88
  }
});
assert.deepEqual(normalizeCommercialization(commercialization), commercialization);
assert.deepEqual(normalizeWithFixedClock(normalized), normalized);
const compressionJsonRoundTrip = normalizeWithFixedClock(JSON.parse(JSON.stringify(normalized)));
assert.deepEqual(compressionJsonRoundTrip.recordCompressions, normalized.recordCompressions);
const referenceRecordStore = structuredClone(normalized);
const actualReferenceReceipt = { schemaVersion: 1, binding: "b".repeat(64),
  aliasMapSha256: "a".repeat(64), promptSha256: "c".repeat(64), promptBytes: 2000,
  promptByteLimit: 32000, unit: "UTF-8 bytes", providedCount: 10, coreModelProvided: true };
referenceRecordStore.thoughts.push({ id: "new-reference-root", type: "question", content: "合成问题", version: 1,
  authorType: "user", origin: "manual", createdAt: fixedNow });
referenceRecordStore.thoughts.push({ id: "new-reference-answer", type: "answer", content: "合成回答", version: 1,
  relatedTo: "new-reference-root", authorType: "ai", origin: "deepseek", createdAt: fixedNow,
  providedReferences: [{ citationId: "real-record-citation", resourceType: "thought", resourceId: "new-reference-root", version: 1, recordType: "用户原文" }],
  contextReceipt: { referenceRequest: actualReferenceReceipt },
  rejectedReferences: [{ citationId: "r99", reason: "unknown_request_reference" }] });
const normalizedReferenceStore = normalizeWithFixedClock(referenceRecordStore);
const referenceMapping = mapStoreObjects("compression-account", normalizedReferenceStore);
const restoredReferenceStore = normalizeWithFixedClock(rebuildStoreObjects(referenceMapping));
const restoredReference = restoredReferenceStore.thoughts.find(item => item.id === "new-reference-answer");
assert.deepEqual(restoredReference.contextReceipt.referenceRequest, actualReferenceReceipt);
assert.deepEqual(restoredReference.providedReferences, referenceRecordStore.thoughts.at(-1).providedReferences);
assert.deepEqual(restoredReference.rejectedReferences, referenceRecordStore.thoughts.at(-1).rejectedReferences);

const compressionPostgresMap = mapStoreObjects("compression-account", normalized);
const mappedCompression = compressionPostgresMap.objects.find(row => row.kind === "recordCompression");
assert.equal(mappedCompression.collection, "recordCompressions");
assert.deepEqual(mappedCompression.payload.daily, normalized.recordCompressions[0].daily);
assert.deepEqual(mappedCompression.payload.sourceRefs, normalized.recordCompressions[0].sourceRefs);
const mappedHistoricalSupplement = compressionPostgresMap.objects.find(row => row.kind === "historicalUserSupplement");
assert.equal(compressionPostgresMap.fields.find(field => field.field === "historicalUserSupplement").shape, "object");
assert.equal(mappedHistoricalSupplement.collection, "historicalUserSupplement");
assert.deepEqual(mappedHistoricalSupplement.payload, normalized.historicalUserSupplement);
assert.deepEqual(rebuildStoreObjects(compressionPostgresMap), normalized);

const malformedCollections = Object.fromEntries(
  STORE_COLLECTION_KEYS
    .filter(key => !["evidenceSources", "evidencePermissions", "perceptionEvents"].includes(key))
    .map((key, index) => [key, [null, "bad", { nope: true }][index % 3]])
);
const recovered = normalizeWithFixedClock({
  version: STORE_VERSION,
  ...malformedCollections,
  journalDraft: "bad",
  onboarding: {},
  onboardingV2: [],
  commercialization: "bad"
});
for (const key of STORE_COLLECTION_KEYS) assert.deepEqual(recovered[key], []);
assert.equal(recovered.journalDraft, null);
assert.equal(recovered.commercialization.version, 3);

const defaultClockStore = createStoreNormalizer()({ version: STORE_VERSION });
assert.equal(defaultClockStore.version, STORE_VERSION);

const allDomainInput = migrationStore();
const allDomainSnapshot = structuredClone(allDomainInput);
const allDomainNormalized = normalizeWithFixedClock(allDomainInput);
assert.deepEqual(allDomainInput, allDomainSnapshot);
assert.deepEqual(normalizeWithFixedClock(allDomainNormalized), allDomainNormalized);
assert.deepEqual(allDomainNormalized.unknownExtension, allDomainInput.unknownExtension);
for (const key of STORE_COLLECTION_KEYS) assert.ok(Array.isArray(allDomainNormalized[key]));
assert.equal(allDomainNormalized.evidenceSources.length, 2);
assert.equal(allDomainNormalized.evidencePermissions.length, 2);
assert.equal(allDomainNormalized.perceptionEvents.length, 1);
assert.equal(allDomainNormalized.evidenceSources[0].accountId, "fixture-account");
assert.deepEqual(
  allDomainNormalized.evidencePermissions.map(item => item.revision),
  [2, 1]
);

const legacyV16 = normalizeWithFixedClock({
  version: 16,
  thoughts: [],
  captures: []
});
assert.equal(legacyV16.version, 18);
assert.deepEqual(legacyV16.evidenceSources, []);
assert.deepEqual(legacyV16.evidencePermissions, []);
assert.deepEqual(legacyV16.perceptionEvents, []);
const legacyV17 = normalizeWithFixedClock({ version: 17 });
assert.equal(legacyV17.version, 18);
assert.deepEqual(legacyV17.recordCompressions, []);

const validCompressionEnvelope = (id, status = "ready") => ({
  id,
  version: 1,
  revision: 1,
  status,
  schemaVersion: "record-compression-output.v1",
  localDate: "2026-10-05",
  timezone: "Asia/Shanghai",
  promptVersion: "daily-record-compression.v1",
  sourceManifestHash: "a".repeat(64),
  generatedAt: "2026-10-05T16:10:00.000Z",
  window: {
    start: "2026-10-04T16:00:00.000Z",
    endExclusive: "2026-10-05T16:00:00.000Z",
    localDate: "2026-10-05",
    timezone: "Asia/Shanghai",
    completeness: "complete"
  },
  sourceManifest: [],
  ...(status === "ready" ? {
    daily: { observations: [], metricKeys: [], missing: [] },
    thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
    other: { themes: [], collectedQuotes: [] },
    metrics: [],
    sourceRefs: [],
    tokenUsage: { estimated: true, outputTokens: 0 },
    periodStart: "2026-10-04T16:00:00.000Z",
    periodEnd: "2026-10-05T16:00:00.000Z"
  } : {})
});
const invalidCompressionMetadata = normalizeWithFixedClock({
  version: 18,
  recordCompressions: [
    { ...validCompressionEnvelope("invalid-date"), localDate: "2026-02-30" },
    { ...validCompressionEnvelope("invalid-timezone"), timezone: "Mars/Olympus" },
    { ...validCompressionEnvelope("invalid-status"), status: "pending" },
    validCompressionEnvelope("ready"),
    validCompressionEnvelope("queued", "queued"),
    validCompressionEnvelope("running", "running"),
    validCompressionEnvelope("failed", "failed"),
    validCompressionEnvelope("invalidated", "invalidated"),
    {
      ...validCompressionEnvelope("invalid-period"),
      periodStart: "2026-10-05T12:00:00.000Z",
      periodEnd: "2026-10-05T11:00:00.000Z"
    }
  ]
}).recordCompressions;
assert.deepEqual(invalidCompressionMetadata.map(item => item.status), [
  "invalidated", "invalidated", "invalidated", "ready", "queued", "running", "failed", "invalidated", "invalidated"
]);
assert.equal(invalidCompressionMetadata[0].localDate, "");
assert.equal(invalidCompressionMetadata[1].timezone, "");
assert.equal(invalidCompressionMetadata[2].status, "invalidated");
assert.equal(invalidCompressionMetadata[3].timezone, "Asia/Shanghai");

for (const corrupt of [
  store => { store.evidenceSources = {}; },
  store => { store.evidenceSources.push({ id: "invalid" }); },
  store => { store.evidenceSources.push({ ...store.evidenceSources[0] }); },
  store => { store.evidenceSources.push({ ...store.evidenceSources[0], id: "duplicate-semantic" }); },
  store => { store.evidencePermissions.push({ ...store.evidencePermissions[0] }); },
  store => { store.perceptionEvents.push({ ...store.perceptionEvents[0] }); },
  store => { store.perceptionEvents.push({ ...store.perceptionEvents[0], id: "duplicate-event-input" }); }
]) {
  const invalid = migrationStore();
  corrupt(invalid);
  assert.throws(
    () => normalizeWithFixedClock(invalid),
    error => error.code === "STORAGE_READ_FAILED"
  );
}

console.log("Store normalization regression passed.");
