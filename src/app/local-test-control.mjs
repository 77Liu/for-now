import { safeIso, safeText } from "../shared/validation/index.mjs";
import { normalizeStore } from "./store-normalization.mjs";
import { emptyStore } from "./store-schema.mjs";

const clone = value => structuredClone(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export const LOCAL_TEST_MODES = Object.freeze(["simulation", "cold"]);
export const LOCAL_TEST_ALL_COLLECTIONS = Object.freeze([
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
]);

export const LOCAL_TEST_SCOPE_COLLECTIONS = Object.freeze({
  today: Object.freeze(["checkins", "dailyRecords", "captures", "thoughts", "books", "quotes", "keepsakes", "actions", "habits", "habitCheckins"]),
  daily: Object.freeze(["dailyRecords"]),
  captures: Object.freeze(["captures"]),
  books: Object.freeze(["books"]),
  quotes: Object.freeze(["quotes"]),
  keepsakes: Object.freeze(["keepsakes"]),
  journals: Object.freeze(["journals", "journalDraft"]),
  thoughts: Object.freeze(["thoughts"]),
  discovery: Object.freeze(["captures", "journals", "thoughts", "books", "quotes"]),
  together: Object.freeze(["chats"]),
  review: Object.freeze(["checkins", "dailyRecords", "journals", "thoughts", "chats", "experiments", "analyses", "customMetrics"]),
  statistics: LOCAL_TEST_ALL_COLLECTIONS,
  "personal-context": Object.freeze(["checkins", "dailyRecords", "captures", "journals", "thoughts", "books", "quotes", "userClaims", "modelUnknowns"]),
  feedback: Object.freeze(["feedback"]),
  export: LOCAL_TEST_ALL_COLLECTIONS,
  trash: Object.freeze(["trash"])
});

export const LOCAL_TEST_COLLECTION_ENDPOINTS = Object.freeze({
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
});

const localTestModeSet = new Set(LOCAL_TEST_MODES);
const localTestScopeSet = new Set(Object.keys(LOCAL_TEST_SCOPE_COLLECTIONS));
const localTestCollectionSet = new Set([...LOCAL_TEST_ALL_COLLECTIONS, "trash"]);
const localTestSnapshotKeys = Object.freeze([
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
  "onboarding",
  "onboardingV2",
  "commercialization"
]);
const localTestRecordCollections = Object.freeze([
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
]);

export const isLocalTestMode = value => localTestModeSet.has(value);
export const isLocalTestScope = value => localTestScopeSet.has(value);
export const isLocalTestCollection = value => localTestCollectionSet.has(value);

export function normalizeLocalTestControl(value = {}) {
  return {
    mode: isLocalTestMode(value.mode) ? value.mode : "cold",
    switchedAt: safeIso(value.switchedAt),
    snapshotAt: safeIso(value.snapshotAt),
    sourceUser: value.sourceUser && typeof value.sourceUser === "object" ? {
      id: safeText(value.sourceUser.id, 100),
      username: safeText(value.sourceUser.username, 100)
    } : null,
    recordCount: Math.max(0, Math.round(Number(value.recordCount) || 0)),
    loadedScopes: [...new Set(Array.isArray(value.loadedScopes) ? value.loadedScopes : [])].filter(isLocalTestScope),
    loadedCollections: [...new Set(Array.isArray(value.loadedCollections) ? value.loadedCollections : [])].filter(isLocalTestCollection)
  };
}

export function localTestSnapshot(state, trash, normalizer = normalizeStore) {
  const snapshot = clone(emptyStore);
  for (const key of localTestSnapshotKeys) {
    if (hasOwn(state, key)) snapshot[key] = clone(state[key]);
  }
  snapshot.trash = clone(Array.isArray(trash?.items) ? trash.items : []);
  snapshot.aiTasks = [];
  snapshot.notifications = [];
  snapshot.attachmentCleanup = [];
  return normalizer(snapshot);
}

export function localTestRecordCount(store) {
  return localTestRecordCollections.reduce((sum, key) => sum + (store[key]?.length || 0), 0);
}

export function mergeLocalTestCollection(collection, current, upstream) {
  if (Array.isArray(current) && Array.isArray(upstream)) {
    const localIds = new Set(current.map(item => safeText(item?.id, 100)).filter(Boolean));
    return [...clone(current), ...clone(upstream).filter(item => !localIds.has(safeText(item?.id, 100)))];
  }
  return JSON.stringify(current) === JSON.stringify(emptyStore[collection])
    ? clone(upstream)
    : clone(current);
}
