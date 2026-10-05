import assert from "node:assert/strict";
import {
  LOCAL_TEST_ALL_COLLECTIONS,
  LOCAL_TEST_COLLECTION_ENDPOINTS,
  LOCAL_TEST_MODES,
  LOCAL_TEST_SCOPE_COLLECTIONS,
  isLocalTestCollection,
  isLocalTestMode,
  isLocalTestScope,
  localTestRecordCount,
  localTestSnapshot,
  mergeLocalTestCollection,
  normalizeLocalTestControl,
  createStoreNormalizer,
  emptyStore
} from "../src/app/index.mjs";

process.env.TZ = "Asia/Shanghai";

const expectedAllCollections = [
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "journalDraft",
  "thoughts",
  "chats",
  "books",
  "keepsakes",
  "quotes",
  "experiments",
  "analyses",
  "customMetrics",
  "actions",
  "habits",
  "habitCheckins",
  "feedback",
  "validationLedger",
  "userClaims",
  "modelUnknowns",
  "commercialization"
];
const expectedScopes = {
  today: ["checkins", "dailyRecords", "captures", "thoughts", "books", "quotes", "keepsakes", "actions", "habits", "habitCheckins"],
  daily: ["dailyRecords"],
  captures: ["captures"],
  books: ["books"],
  quotes: ["quotes"],
  keepsakes: ["keepsakes"],
  journals: ["journals", "journalDraft"],
  thoughts: ["thoughts"],
  discovery: ["captures", "journals", "thoughts", "books", "quotes"],
  together: ["chats"],
  review: ["checkins", "dailyRecords", "journals", "thoughts", "chats", "experiments", "analyses", "customMetrics"],
  statistics: expectedAllCollections,
  "personal-context": ["checkins", "dailyRecords", "captures", "journals", "thoughts", "books", "quotes", "userClaims", "modelUnknowns"],
  feedback: ["feedback"],
  export: expectedAllCollections,
  trash: ["trash"]
};
const expectedEndpoints = {
  checkins: "/api/v1/checkins",
  dailyRecords: "/api/v1/daily-records",
  captures: "/api/v1/captures",
  journals: "/api/v1/journals",
  thoughts: "/api/v1/thought-chains",
  chats: "/api/v1/chats",
  books: "/api/v1/books",
  quotes: "/api/v1/quotes",
  experiments: "/api/v1/experiments",
  analyses: "/api/v1/analyses",
  customMetrics: "/api/v1/custom-metrics",
  actions: "/api/v1/actions",
  habits: "/api/v1/habits",
  feedback: "/api/v1/feedback",
  validationLedger: "/api/v1/validation-ledger"
};

assert.deepEqual(LOCAL_TEST_MODES, ["simulation", "cold"]);
assert.deepEqual(LOCAL_TEST_ALL_COLLECTIONS, expectedAllCollections);
assert.deepEqual(LOCAL_TEST_SCOPE_COLLECTIONS, expectedScopes);
assert.deepEqual(LOCAL_TEST_COLLECTION_ENDPOINTS, expectedEndpoints);
assert.strictEqual(LOCAL_TEST_SCOPE_COLLECTIONS.statistics, LOCAL_TEST_ALL_COLLECTIONS);
assert.strictEqual(LOCAL_TEST_SCOPE_COLLECTIONS.export, LOCAL_TEST_ALL_COLLECTIONS);

for (const mode of LOCAL_TEST_MODES) assert.equal(isLocalTestMode(mode), true);
for (const scope of Object.keys(expectedScopes)) assert.equal(isLocalTestScope(scope), true);
for (const collection of [...expectedAllCollections, "trash"]) {
  assert.equal(isLocalTestCollection(collection), true);
}
for (const unknown of ["", "unknown", "Simulation", null, undefined]) {
  assert.equal(isLocalTestMode(unknown), false);
  assert.equal(isLocalTestScope(unknown), false);
  assert.equal(isLocalTestCollection(unknown), false);
}

const controlInput = {
  mode: "simulation",
  switchedAt: "2026-10-05T08:30:00+08:00",
  snapshotAt: "not-a-date",
  sourceUser: {
    id: "  owner-1  ",
    username: "  local owner  ",
    role: "owner",
    privateToken: "drop"
  },
  recordCount: "4.6",
  loadedScopes: ["review", "unknown", "today", "review", null],
  loadedCollections: ["captures", "trash", "unknown", "captures", null],
  unknownField: "drop"
};
const controlInputBefore = structuredClone(controlInput);
const control = normalizeLocalTestControl(controlInput);
assert.deepEqual(controlInput, controlInputBefore);
assert.deepEqual(control, {
  mode: "simulation",
  switchedAt: "2026-10-05T00:30:00.000Z",
  snapshotAt: "",
  sourceUser: {
    id: "owner-1",
    username: "local owner"
  },
  recordCount: 5,
  loadedScopes: ["review", "today"],
  loadedCollections: ["captures", "trash"]
});
assert.deepEqual(normalizeLocalTestControl({
  mode: "unknown",
  sourceUser: "owner",
  recordCount: -2,
  loadedScopes: "today",
  loadedCollections: {}
}), {
  mode: "cold",
  switchedAt: "",
  snapshotAt: "",
  sourceUser: null,
  recordCount: 0,
  loadedScopes: [],
  loadedCollections: []
});

const fixedNow = "2026-10-05T01:02:03.000Z";
const normalizeWithFixedClock = createStoreNormalizer({
  now: () => fixedNow,
  today: () => "2026-10-05",
  currentTime: () => Date.parse(fixedNow)
});
const snapshotState = {
  version: 1,
  checkins: [{
    id: "checkin-1",
    occurredAt: "2026-10-05T00:00:00.000Z",
    occurredOn: "2026-10-05",
    mood: 4,
    energy: 3,
    stress: 2,
    sleep: 4
  }],
  journals: [{
    id: "journal-1",
    occurredAt: "2026-10-05T00:00:00.000Z",
    occurredOn: "2026-10-05",
    title: "Journal"
  }],
  journalDraft: {
    journalId: "journal-1",
    title: "  Draft  ",
    content: "  Local content  ",
    updatedAt: "invalid",
    privateField: "drop"
  },
  onboarding: {
    ...structuredClone(emptyStore.onboarding),
    status: "completed",
    understanding: "Preserved onboarding"
  },
  onboardingV2: structuredClone(emptyStore.onboardingV2),
  commercialization: structuredClone(emptyStore.commercialization),
  trash: [{ id: "state-trash-must-not-win" }],
  aiTasks: [{ id: "private-task", kind: "analysis" }],
  notifications: [{ id: "private-notification" }],
  attachmentCleanup: [{ path: "/attachments/private.png" }],
  speechCache: [{ id: "private-speech-cache" }],
  unknownTopLevel: { private: true }
};
snapshotState.commercialization.updatedAt = "2026-10-05T00:00:00.000Z";
snapshotState.commercialization.assumptions.validation.participants = 9;
const snapshotTrash = {
  items: [{
    id: "trash-1",
    type: "capture",
    payload: { id: "deleted-capture" },
    deletedAt: "2026-10-05T00:00:00.000Z",
    purgeAfter: "2026-11-04T00:00:00.000Z"
  }],
  privateCursor: "drop"
};
const snapshotStateBefore = structuredClone(snapshotState);
const snapshotTrashBefore = structuredClone(snapshotTrash);
const snapshot = localTestSnapshot(snapshotState, snapshotTrash, normalizeWithFixedClock);

assert.deepEqual(snapshotState, snapshotStateBefore);
assert.deepEqual(snapshotTrash, snapshotTrashBefore);
assert.equal(snapshot.version, emptyStore.version);
assert.equal(snapshot.checkins[0].id, "checkin-1");
assert.deepEqual(snapshot.journalDraft, {
  journalId: "journal-1",
  title: "Draft",
  content: "Local content",
  updatedAt: fixedNow
});
assert.equal(snapshot.onboarding.status, "completed");
assert.equal(snapshot.onboarding.understanding, "Preserved onboarding");
assert.equal(snapshot.commercialization.assumptions.validation.participants, 9);
assert.deepEqual(snapshot.trash.map(item => item.id), ["trash-1"]);
assert.deepEqual(snapshot.aiTasks, []);
assert.deepEqual(snapshot.notifications, []);
assert.deepEqual(snapshot.attachmentCleanup, []);
assert.deepEqual(snapshot.speechCache, []);
assert.equal(Object.hasOwn(snapshot, "unknownTopLevel"), false);
assert.equal(Object.hasOwn(snapshot.journalDraft, "privateField"), false);
assert.equal(localTestSnapshot({}, {}).version, emptyStore.version);

const countedCollections = [
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "thoughts",
  "chats",
  "books",
  "keepsakes",
  "quotes",
  "experiments",
  "analyses",
  "actions",
  "habits",
  "habitCheckins",
  "feedback",
  "validationLedger"
];
const countStore = Object.fromEntries(countedCollections.map(key => [key, [{ id: key }]]));
Object.assign(countStore, {
  journalDraft: { id: "not-counted" },
  customMetrics: [{ id: "not-counted" }],
  trash: [{ id: "not-counted" }],
  userClaims: [{ id: "not-counted" }],
  modelUnknowns: [{ id: "not-counted" }],
  commercialization: { length: 99 }
});
const countStoreBefore = structuredClone(countStore);
assert.equal(localTestRecordCount(countStore), countedCollections.length);
assert.deepEqual(countStore, countStoreBefore);

const currentRecords = [{
  id: "local-only",
  value: "local",
  nested: { owner: "local" }
}, {
  id: "shared",
  value: "local-write"
}, {
  id: "",
  value: "local-without-id"
}];
const upstreamRecords = [{
  id: " shared ",
  value: "remote-must-not-overwrite"
}, {
  id: "remote-only",
  value: "remote"
}, {
  id: "",
  value: "remote-without-id"
}];
const currentRecordsBefore = structuredClone(currentRecords);
const upstreamRecordsBefore = structuredClone(upstreamRecords);
const mergedRecords = mergeLocalTestCollection("captures", currentRecords, upstreamRecords);
assert.deepEqual(mergedRecords.map(item => item.value), [
  "local",
  "local-write",
  "local-without-id",
  "remote",
  "remote-without-id"
]);
assert.notStrictEqual(mergedRecords[0], currentRecords[0]);
assert.notStrictEqual(mergedRecords[3], upstreamRecords[1]);
mergedRecords[0].nested.owner = "changed-result";
assert.deepEqual(currentRecords, currentRecordsBefore);
assert.deepEqual(upstreamRecords, upstreamRecordsBefore);

const upstreamDraft = { journalId: "journal-1", title: "Remote draft" };
const mergedEmptyDraft = mergeLocalTestCollection("journalDraft", null, upstreamDraft);
assert.deepEqual(mergedEmptyDraft, upstreamDraft);
assert.notStrictEqual(mergedEmptyDraft, upstreamDraft);
const localDraft = { journalId: "journal-1", title: "Local draft" };
const retainedDraft = mergeLocalTestCollection("journalDraft", localDraft, upstreamDraft);
assert.deepEqual(retainedDraft, localDraft);
assert.notStrictEqual(retainedDraft, localDraft);

const upstreamCommercialization = {
  ...structuredClone(emptyStore.commercialization),
  updatedAt: "2026-10-05T00:00:00.000Z"
};
assert.deepEqual(
  mergeLocalTestCollection(
    "commercialization",
    structuredClone(emptyStore.commercialization),
    upstreamCommercialization
  ),
  upstreamCommercialization
);
const localCommercialization = {
  ...structuredClone(emptyStore.commercialization),
  updatedAt: "2026-10-04T00:00:00.000Z"
};
assert.deepEqual(
  mergeLocalTestCollection("commercialization", localCommercialization, upstreamCommercialization),
  localCommercialization
);

console.log("Local test control checks passed.");
