import assert from "node:assert/strict";
import {
  STORE_VERSION, TRASH_RETENTION_DAYS, createEmptyStore, emptyStore,
  createStoreNormalizer, normalizeCommercialization, normalizeStore
} from "../src/app/index.mjs";
import { migrationStore } from "./fixtures/migration-store.mjs";

process.env.TZ = "Asia/Shanghai";

const STORE_COLLECTION_KEYS = [
  "checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books",
  "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "trash",
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

assert.equal(STORE_VERSION, 17);
assert.equal(TRASH_RETENTION_DAYS, 30);
assert.equal(emptyStore.version, STORE_VERSION);
assert.equal(normalizeStore({ version: STORE_VERSION }).version, STORE_VERSION);
for (const key of STORE_COLLECTION_KEYS) assert.deepEqual(emptyStore[key], []);
const isolatedDefault = createEmptyStore();
isolatedDefault.checkins.push({ id: "local-only" });
assert.deepEqual(createEmptyStore().checkins, []);

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
assert.equal(normalized.checkins[0].occurredAt, "2026-01-01T23:30:00.000Z");
assert.equal(normalized.checkins[0].stress, 4);
assert.deepEqual(normalized.checkins[0].futureRecordField, { retained: true });
assert.equal(normalized.checkins[1].occurredOn, "2026-10-05");
assert.equal(normalized.checkins[1].occurredAt, "2026-10-05T04:05:06.000Z");
assert.deepEqual(normalized.captures[0].futureCaptureField, ["keep"]);
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
assert.equal(legacyV16.version, 17);
assert.deepEqual(legacyV16.evidenceSources, []);
assert.deepEqual(legacyV16.evidencePermissions, []);
assert.deepEqual(legacyV16.perceptionEvents, []);

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
