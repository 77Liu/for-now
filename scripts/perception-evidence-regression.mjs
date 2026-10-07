import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  EVIDENCE_ERROR_CODES,
  EVIDENCE_INFORMATION_TYPES,
  EVIDENCE_ORIGINS,
  EVIDENCE_PURPOSES,
  PERCEPTION_EVENT_KINDS,
  deduplicateEvidenceByEvent,
  evaluateEvidence,
  evidenceEventKey,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  normalizePerceptionEvent
} from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceRef = {
  resourceType: "capture",
  resourceId: "capture-1",
  rootId: "",
  targetKey: "",
  version: 3
};
const sourceKey = JSON.stringify(["capture", "capture-1", "", ""]);
const permission = {
  schemaVersion: 1,
  accountId: "account-a",
  sourceKey,
  contextAllowed: true,
  learningAllowed: false,
  revision: 4,
  updatedAt: "2026-10-07T08:01:00.000Z"
};
const dependency = {
  sourceKey: JSON.stringify(["journal", "journal-1", "", ""]),
  version: 2,
  contentSha256: hash("supporting journal"),
  permissionRevision: 5
};
const secondDependency = {
  sourceKey: JSON.stringify(["thought", "thought-2", "", "question:thought-2"]),
  version: 1,
  contentSha256: hash("supporting thought"),
  permissionRevision: 2
};
const rawEvidence = {
  schemaVersion: 1,
  id: "evidence-1",
  accountId: "account-a",
  sourceRef,
  eventId: "event-1",
  origin: "user",
  informationType: "user_viewpoint",
  contentSha256: hash("current source"),
  contentLength: "current source".length,
  span: [0, 7],
  occurredAt: "2026-10-06T08:00:00+08:00",
  recordedAt: "2026-10-07T08:00:00+08:00",
  permissionRevision: 4,
  derivedFrom: [secondDependency, dependency]
};

assert.deepEqual(EVIDENCE_ORIGINS, ["user", "device", "ai", "system", "third_party"]);
assert.deepEqual(EVIDENCE_INFORMATION_TYPES, [
  "user_fact",
  "user_viewpoint",
  "measured_fact",
  "device_guidance",
  "model_derived"
]);
assert.deepEqual(EVIDENCE_PURPOSES, ["context", "learning"]);
assert.deepEqual(PERCEPTION_EVENT_KINDS, [
  "created",
  "updated",
  "deleted",
  "restored",
  "permission_changed"
]);
assert.equal(EVIDENCE_ERROR_CODES.INVALID, "EVIDENCE_INVALID");

for (const invalid of [
  null,
  [],
  {},
  { ...rawEvidence, accountId: "" },
  { ...rawEvidence, sourceRef: { ...sourceRef, resourceType: "" } },
  { ...rawEvidence, sourceRef: { ...sourceRef, rootId: 42 } },
  { ...rawEvidence, sourceRef: { ...sourceRef, targetKey: "x".repeat(121) } },
  { ...rawEvidence, sourceRef: { ...sourceRef, version: 0 } },
  { ...rawEvidence, sourceRef: { ...sourceRef, version: 1.5 } },
  { ...rawEvidence, contentSha256: "ABC" },
  { ...rawEvidence, contentLength: -1 },
  { ...rawEvidence, occurredAt: "not-a-date" },
  { ...rawEvidence, occurredAt: "2026-02-30T08:00:00Z" },
  { ...rawEvidence, occurredAt: "2026-10-06T08:00:00" },
  { ...rawEvidence, occurredAt: "2026-10-08T08:00:00Z" },
  { ...rawEvidence, recordedAt: "" },
  { ...rawEvidence, span: [-1, 3] },
  { ...rawEvidence, span: [3, 3] },
  { ...rawEvidence, span: [0, 99] },
  { ...rawEvidence, span: [1] },
  { ...rawEvidence, origin: "model" },
  { ...rawEvidence, informationType: "personality" },
  { ...rawEvidence, permissionRevision: 0 },
  { ...rawEvidence, derivedFrom: null },
  { ...rawEvidence, derivedFrom: [{ ...dependency, sourceKey: "capture:capture-1" }] },
  { ...rawEvidence, derivedFrom: [{ ...dependency, sourceKey: JSON.stringify(["capture", "capture-1", "", "", "extra"]) }] },
  { ...rawEvidence, informationType: "model_derived", derivedFrom: [] },
  {
    ...rawEvidence,
    derivedFrom: [{
      ...dependency,
      sourceKey
    }]
  },
  {
    ...rawEvidence,
    derivedFrom: [{
      ...dependency,
      sourceKey: '[ "capture", "capture-1", "", "" ]'
    }]
  },
  { ...rawEvidence, derivedFrom: [dependency, dependency] }
]) {
  assert.equal(normalizeEvidenceSource(invalid), null);
}

const evidenceInput = structuredClone(rawEvidence);
const evidence = normalizeEvidenceSource(evidenceInput);
assert.notEqual(evidence, evidenceInput);
assert.deepEqual(evidenceInput, rawEvidence);
assert.equal(evidence.occurredAt, "2026-10-06T00:00:00.000Z");
assert.equal(evidence.recordedAt, "2026-10-07T00:00:00.000Z");
assert.equal(evidenceSourceKey(evidence.sourceRef), sourceKey);
assert.equal(evidenceSourceKey({ ...sourceRef, version: 99 }), sourceKey);
assert.equal(evidenceSourceKey({ resourceType: "capture", resourceId: "a:b", version: 1 }), JSON.stringify(["capture", "a:b", "", ""]));
assert.equal(evidenceSourceKey({ resourceType: "", resourceId: "capture-1", version: 1 }), "");

for (const invalid of [
  null,
  {},
  { ...permission, accountId: "" },
  { ...permission, sourceKey: "" },
  { ...permission, sourceKey: "capture:capture-1" },
  { ...permission, sourceKey: JSON.stringify(["capture", "capture-1", "", "", "extra"]) },
  { ...permission, contextAllowed: "yes" },
  { ...permission, learningAllowed: null },
  { ...permission, revision: 0 },
  { ...permission, updatedAt: "invalid" }
]) {
  assert.equal(normalizeEvidencePermission(invalid), null);
}
assert.deepEqual(normalizeEvidencePermission(permission), permission);
assert.equal(
  normalizeEvidencePermission({ ...permission, sourceKey: '[ "capture", "capture-1", "", "" ]' }).sourceKey,
  sourceKey
);

const event = {
  schemaVersion: 1,
  id: "perception-event-1",
  accountId: "account-a",
  kind: "updated",
  sourceRef,
  eventId: "event-1",
  contentSha256: hash("current source"),
  occurredAt: "2026-10-06T08:00:00+08:00",
  recordedAt: "2026-10-07T08:00:00+08:00",
  permissionRevision: 4,
  perceptionVersion: "perception-v1"
};
for (const invalid of [
  null,
  {},
  { ...event, kind: "changed" },
  { ...event, eventId: "" },
  { ...event, sourceRef: { ...sourceRef, version: 0 } },
  { ...event, contentSha256: "invalid" },
  { ...event, occurredAt: "" },
  { ...event, occurredAt: "2026-02-30T08:00:00Z" },
  { ...event, occurredAt: "2026-10-08T08:00:00Z" },
  { ...event, recordedAt: "invalid" },
  { ...event, permissionRevision: -1 },
  { ...event, perceptionVersion: "" }
]) {
  assert.equal(normalizePerceptionEvent(invalid), null);
}
const normalizedEvent = normalizePerceptionEvent(event);
assert.equal(normalizedEvent.kind, "updated");
assert.equal(evidenceEventKey(normalizedEvent), JSON.stringify([
  "account-a",
  "event-1",
  "updated",
  sourceKey,
  3,
  hash("current source"),
  4,
  "perception-v1"
]));
assert.equal(evidenceEventKey({ ...normalizedEvent, accountId: "" }), "");
assert.notEqual(
  evidenceEventKey(normalizedEvent),
  evidenceEventKey({
    ...normalizedEvent,
    id: "retry-with-new-id",
    sourceRef: { ...normalizedEvent.sourceRef, version: 4 }
  })
);
assert.equal(
  evidenceEventKey(normalizedEvent),
  evidenceEventKey({ ...normalizedEvent, id: "retry-with-new-id" })
);

const currentState = {
  source: {
    accountId: "account-a",
    sourceKey,
    exists: true,
    deleted: false,
    version: 3,
    contentSha256: hash("current source")
  },
  permission,
  dependencies: [{
    accountId: "account-a",
    ...dependency,
    exists: true,
    deleted: false,
    contextAllowed: true,
    learningAllowed: true
  }, {
    accountId: "account-a",
    ...secondDependency,
    exists: true,
    deleted: false,
    contextAllowed: true,
    learningAllowed: true
  }]
};
assert.deepEqual(evaluateEvidence(evidence, currentState, {
  accountId: "account-a",
  purpose: "context"
}), {
  usable: true,
  reasons: [],
  currentVersion: 3,
  currentPermissionRevision: 4
});
assert.equal(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, sourceKey: '[ "capture", "capture-1", "", "" ]' }
}, {
  accountId: "account-a",
  purpose: "context"
}).usable, true);
assert.deepEqual(evaluateEvidence(evidence, currentState, {
  accountId: "account-a",
  purpose: "learning"
}).reasons, ["EVIDENCE_PERMISSION_DENIED"]);
assert.deepEqual(evaluateEvidence(evidence, currentState, {
  accountId: "account-b",
  purpose: "context"
}).reasons, ["EVIDENCE_ACCOUNT_MISMATCH"]);
assert.deepEqual(evaluateEvidence(null, currentState, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_INVALID"]);
assert.deepEqual(evaluateEvidence(evidence, { ...currentState, source: null }, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_SOURCE_MISSING"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, deleted: true }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_SOURCE_DELETED"]);
for (const deleted of [undefined, "true", 0]) {
  const source = { ...currentState.source, deleted };
  if (deleted === undefined) delete source.deleted;
  assert.deepEqual(evaluateEvidence(evidence, {
    ...currentState,
    source
  }, {
    accountId: "account-a",
    purpose: "context"
  }).reasons, ["EVIDENCE_SOURCE_MISSING"]);
}
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, version: 4 }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_VERSION_STALE"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, contentSha256: hash("edited source") }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_CONTENT_CHANGED"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  permission: { ...permission, revision: 5 }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_PERMISSION_STALE"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  permission: { ...permission, contextAllowed: false }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_PERMISSION_DENIED"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  permission: { ...permission, contextAllowed: false, learningAllowed: true }
}, {
  accountId: "account-a",
  purpose: "learning"
}).reasons, []);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, accountId: "account-b" }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_ACCOUNT_MISMATCH"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  source: { ...currentState.source, accountId: "" }
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_ACCOUNT_MISMATCH"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  dependencies: [{ ...currentState.dependencies[0], deleted: true }]
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_DEPENDENCY_STALE"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  dependencies: [{ ...currentState.dependencies[0], permissionRevision: 6 }]
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_DEPENDENCY_STALE"]);
assert.deepEqual(evaluateEvidence(evidence, {
  ...currentState,
  dependencies: currentState.dependencies.map((item, index) => (
    index === 0 ? { ...item, contentSha256: hash("changed dependency") } : item
  ))
}, {
  accountId: "account-a",
  purpose: "context"
}).reasons, ["EVIDENCE_DEPENDENCY_STALE"]);
for (const deleted of [undefined, "true", 1]) {
  const malformed = { ...currentState.dependencies[0], deleted };
  if (deleted === undefined) delete malformed.deleted;
  assert.deepEqual(evaluateEvidence(evidence, {
    ...currentState,
    dependencies: [malformed, currentState.dependencies[1]]
  }, {
    accountId: "account-a",
    purpose: "context"
  }).reasons, ["EVIDENCE_DEPENDENCY_STALE"]);
}
const deniedDependency = {
  ...currentState.dependencies[0],
  contextAllowed: false
};
const allowedDependency = {
  ...currentState.dependencies[0],
  contextAllowed: true
};
for (const dependencies of [
  [deniedDependency, allowedDependency, currentState.dependencies[1]],
  [allowedDependency, deniedDependency, currentState.dependencies[1]]
]) {
  assert.deepEqual(evaluateEvidence(evidence, {
    ...currentState,
    dependencies
  }, {
    accountId: "account-a",
    purpose: "context"
  }).reasons, ["EVIDENCE_DEPENDENCY_STALE"]);
}

const restoredState = {
  ...currentState,
  source: { ...currentState.source, deleted: false, version: 4 },
  permission: { ...permission, contextAllowed: false, revision: 5 }
};
assert.deepEqual(evaluateEvidence(evidence, restoredState, {
  accountId: "account-a",
  purpose: "context"
}).reasons, [
  "EVIDENCE_VERSION_STALE",
  "EVIDENCE_PERMISSION_STALE",
  "EVIDENCE_PERMISSION_DENIED"
]);

const sameEvent = normalizeEvidenceSource({
  ...rawEvidence,
  id: "evidence-2",
  sourceRef: { ...sourceRef, resourceType: "journal", resourceId: "journal-event-copy" }
});
const sameHashDifferentEvent = normalizeEvidenceSource({
  ...rawEvidence,
  id: "evidence-3",
  sourceRef: { ...sourceRef, resourceId: "capture-2" },
  eventId: "event-2"
});
const dedupeInput = [sameHashDifferentEvent, sameEvent, evidence];
const dedupeBefore = structuredClone(dedupeInput);
const deduped = deduplicateEvidenceByEvent(dedupeInput);
assert.deepEqual(dedupeInput, dedupeBefore);
assert.equal(deduped.eventCount, 2);
assert.equal(deduped.duplicateEvidenceCount, 1);
assert.deepEqual(deduped.groups.map(group => group.eventId), ["event-1", "event-2"]);
assert.deepEqual(deduped.groups[0].evidenceIds, ["evidence-1", "evidence-2"]);
assert.deepEqual(deduped.groups[1].evidenceIds, ["evidence-3"]);
assert.equal(deduplicateEvidenceByEvent([evidence, null]).code, "EVIDENCE_INVALID");
for (const invalid of [null, {}, "evidence"]) {
  assert.deepEqual(deduplicateEvidenceByEvent(invalid), {
    invalid: true,
    code: "EVIDENCE_INVALID",
    eventCount: 0,
    duplicateEvidenceCount: 0,
    groups: []
  });
}

const reordered = normalizeEvidenceSource({
  ...rawEvidence,
  derivedFrom: [dependency, secondDependency]
});
assert.equal(evidenceFingerprint(evidence), evidenceFingerprint(reordered));
const unicodeDependencies = [
  {
    sourceKey: JSON.stringify(["capture", "ä-source", "", ""]),
    version: 1,
    contentSha256: hash("umlaut"),
    permissionRevision: 1
  },
  {
    sourceKey: JSON.stringify(["capture", "z-source", "", ""]),
    version: 1,
    contentSha256: hash("latin"),
    permissionRevision: 1
  }
];
const unicodeEvidence = normalizeEvidenceSource({
  ...rawEvidence,
  id: "unicode-evidence",
  derivedFrom: unicodeDependencies
});
const reversedUnicodeEvidence = normalizeEvidenceSource({
  ...rawEvidence,
  id: "unicode-evidence",
  derivedFrom: [...unicodeDependencies].reverse()
});
assert.deepEqual(
  unicodeEvidence.derivedFrom.map(item => item.sourceKey),
  [...unicodeEvidence.derivedFrom].map(item => item.sourceKey).sort()
);
assert.equal(evidenceFingerprint(unicodeEvidence), evidenceFingerprint(reversedUnicodeEvidence));
assert.equal(
  evidenceFingerprint(evidence),
  evidenceFingerprint({ ...evidence, id: "retry-evidence-id", recordedAt: "2026-10-07T00:01:00.000Z" })
);
assert.match(evidenceFingerprint(evidence), /^[a-f0-9]{64}$/);
assert.equal(evidenceFingerprint(null), "");

console.log("Perception evidence checks passed: strict source/event/permission normalization, account and permission isolation, version/hash invalidation, restore safety, dependency invalidation, deterministic fingerprinting and event deduplication.");
