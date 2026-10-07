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
  evaluateStoredEvidenceChecks,
  evidenceEventKey,
  evidenceFingerprint,
  evidenceSourceKey,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  normalizePerceptionEvent,
  revokeEvidencePermissionsForResource
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
  { ...rawEvidence, sourceTaskId: {} },
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
const taskBoundEvidence = normalizeEvidenceSource({
  ...rawEvidence,
  sourceTaskId: "perception-task-1"
});
assert.equal(taskBoundEvidence.sourceTaskId, "perception-task-1");
assert.equal(
  evidenceFingerprint(taskBoundEvidence),
  evidenceFingerprint({ ...taskBoundEvidence, sourceTaskId: "perception-task-2" })
);
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

const stored = {
  evidenceSources: [evidence],
  evidencePermissions: [permission, {
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: dependency.sourceKey,
    contextAllowed: true,
    learningAllowed: true,
    revision: dependency.permissionRevision,
    updatedAt: "2026-10-07T00:00:00.000Z"
  }, {
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: secondDependency.sourceKey,
    contextAllowed: true,
    learningAllowed: true,
    revision: secondDependency.permissionRevision,
    updatedAt: "2026-10-07T00:00:00.000Z"
  }],
  perceptionEvents: [
    normalizedEvent,
    normalizePerceptionEvent({
      ...event,
      id: "late-stale-event",
      sourceRef: { ...sourceRef, version: 2 },
      contentSha256: hash("stale source"),
      recordedAt: "2026-10-07T01:00:00.000Z"
    }),
    normalizePerceptionEvent({
      ...event,
      id: "dependency-event-1",
      sourceRef: {
        resourceType: "journal",
        resourceId: "journal-1",
        rootId: "",
        targetKey: "",
        version: dependency.version
      },
      eventId: "supporting-event-1",
      contentSha256: dependency.contentSha256,
      permissionRevision: dependency.permissionRevision
    }),
    normalizePerceptionEvent({
      ...event,
      id: "dependency-event-2",
      sourceRef: {
        resourceType: "thought",
        resourceId: "thought-2",
        rootId: "",
        targetKey: "question:thought-2",
        version: secondDependency.version
      },
      eventId: "supporting-event-2",
      contentSha256: secondDependency.contentSha256,
      permissionRevision: secondDependency.permissionRevision
    })
  ]
};
const check = {
  evidenceId: evidence.id,
  evidenceFingerprint: evidenceFingerprint(evidence),
  purpose: "context"
};
assert.equal(evaluateStoredEvidenceChecks(stored, [check], {
  accountId: "account-a"
}).usable, true);
const unrelatedTrashCollision = structuredClone(stored);
unrelatedTrashCollision.trash = [{
  id: "trash-unrelated",
  type: "journal",
  resourceId: sourceRef.resourceId,
  location: {
    kind: "collection",
    collection: "journals",
    index: 0
  },
  payload: {
    id: sourceRef.resourceId,
    version: sourceRef.version
  }
}];
assert.equal(evaluateStoredEvidenceChecks(unrelatedTrashCollision, [check], {
  accountId: "account-a"
}).usable, true);
const nestedTrashCollision = structuredClone(stored);
nestedTrashCollision.trash = [{
  id: "trash-nested",
  type: "annotation",
  resourceId: sourceRef.resourceId,
  location: {
    kind: "nested",
    parentCollection: "captures",
    parentId: "other-capture",
    field: "annotations",
    index: 0
  },
  payload: {
    id: sourceRef.resourceId,
    version: sourceRef.version
  }
}];
assert.equal(evaluateStoredEvidenceChecks(nestedTrashCollision, [check], {
  accountId: "account-a"
}).usable, true);
assert.deepEqual(evaluateStoredEvidenceChecks(stored, [{
  ...check,
  purpose: "learning"
}], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_PERMISSION_DENIED"]);
assert.deepEqual(evaluateStoredEvidenceChecks(stored, [{
  ...check,
  evidenceFingerprint: hash("stale evidence snapshot")
}], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_VERSION_STALE"]);
assert.deepEqual(evaluateStoredEvidenceChecks(stored, [
  check,
  check
], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_INVALID"]);
assert.deepEqual(evaluateStoredEvidenceChecks(stored, null, {
  accountId: "account-a"
}).reasons, ["EVIDENCE_INVALID"]);
assert.deepEqual(evaluateStoredEvidenceChecks({
  ...stored,
  evidencePermissions: [...stored.evidencePermissions, stored.evidencePermissions[0]]
}, [check], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_INVALID"]);
assert.deepEqual(evaluateStoredEvidenceChecks({
  ...stored,
  perceptionEvents: [...stored.perceptionEvents, {
    ...stored.perceptionEvents[0],
    id: "duplicate-input"
  }]
}, [check], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_INVALID"]);
assert.deepEqual(evaluateStoredEvidenceChecks({
  ...stored,
  evidenceSources: [...stored.evidenceSources, {
    ...stored.evidenceSources[0],
    id: "other-account-evidence",
    accountId: "account-b"
  }]
}, [check], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_ACCOUNT_MISMATCH"]);
assert.equal(evaluateStoredEvidenceChecks({}, [], {
  accountId: "account-a"
}).usable, true);

const chainSource = (resourceId, content, derivedFrom = []) => normalizeEvidenceSource({
  schemaVersion: 1,
  id: `evidence-${resourceId}`,
  accountId: "account-a",
  sourceRef: {
    resourceType: "capture",
    resourceId,
    rootId: "",
    targetKey: "",
    version: 1
  },
  eventId: `event-${resourceId}`,
  origin: derivedFrom.length ? "ai" : "user",
  informationType: derivedFrom.length ? "model_derived" : "user_viewpoint",
  contentSha256: hash(content),
  contentLength: content.length,
  span: [0, content.length],
  occurredAt: "2026-10-06T00:00:00.000Z",
  recordedAt: "2026-10-07T00:00:00.000Z",
  permissionRevision: 1,
  derivedFrom
});
const chainPermission = evidence => ({
  schemaVersion: 1,
  accountId: "account-a",
  sourceKey: evidenceSourceKey(evidence.sourceRef),
  contextAllowed: true,
  learningAllowed: true,
  revision: 1,
  updatedAt: "2026-10-07T00:00:00.000Z"
});
const chainEvent = evidence => normalizePerceptionEvent({
  schemaVersion: 1,
  id: `perception-${evidence.id}`,
  accountId: "account-a",
  kind: "created",
  sourceRef: evidence.sourceRef,
  eventId: evidence.eventId,
  contentSha256: evidence.contentSha256,
  occurredAt: evidence.occurredAt,
  recordedAt: evidence.recordedAt,
  permissionRevision: 1,
  perceptionVersion: "perception-v1"
});
const chainRoot = chainSource("chain-root", "原始约束");
const chainMiddle = chainSource("chain-middle", "中间摘要", [{
  sourceKey: evidenceSourceKey(chainRoot.sourceRef),
  version: chainRoot.sourceRef.version,
  contentSha256: chainRoot.contentSha256,
  permissionRevision: chainRoot.permissionRevision
}]);
const chainTop = chainSource("chain-top", "最终建议", [{
  sourceKey: evidenceSourceKey(chainMiddle.sourceRef),
  version: chainMiddle.sourceRef.version,
  contentSha256: chainMiddle.contentSha256,
  permissionRevision: chainMiddle.permissionRevision
}]);
const recursiveStore = {
  captures: [
    { id: "chain-root", version: 1, content: "原始约束", origin: "manual" },
    { id: "chain-middle", version: 1, content: "中间摘要", origin: "deepseek" },
    { id: "chain-top", version: 1, content: "最终建议", origin: "deepseek" }
  ],
  evidenceSources: [chainRoot, chainMiddle, chainTop],
  evidencePermissions: [chainRoot, chainMiddle, chainTop].map(chainPermission),
  perceptionEvents: [chainRoot, chainMiddle, chainTop].map(chainEvent)
};
const chainTopCheck = {
  evidenceId: chainTop.id,
  evidenceFingerprint: evidenceFingerprint(chainTop),
  purpose: "context"
};
assert.equal(evaluateStoredEvidenceChecks(recursiveStore, [chainTopCheck], {
  accountId: "account-a"
}).usable, true);
const missingMiddleEvidenceStore = {
  ...recursiveStore,
  evidenceSources: [chainRoot, chainTop]
};
assert.deepEqual(evaluateStoredEvidenceChecks(missingMiddleEvidenceStore, [chainTopCheck], {
  accountId: "account-a"
}).reasons, [EVIDENCE_ERROR_CODES.DEPENDENCY_STALE]);
const revokedRecursiveStore = structuredClone(recursiveStore);
Object.assign(revokedRecursiveStore.evidencePermissions.find(item => (
  item.sourceKey === evidenceSourceKey(chainRoot.sourceRef)
)), {
  contextAllowed: false,
  learningAllowed: false,
  revision: 2
});
assert.deepEqual(evaluateStoredEvidenceChecks(revokedRecursiveStore, [chainTopCheck], {
  accountId: "account-a"
}).reasons, [EVIDENCE_ERROR_CODES.DEPENDENCY_STALE]);

const cycleARef = {
  resourceType: "capture",
  resourceId: "cycle-a",
  rootId: "",
  targetKey: "",
  version: 1
};
const cycleBRef = {
  resourceType: "capture",
  resourceId: "cycle-b",
  rootId: "",
  targetKey: "",
  version: 1
};
const cycleAContent = hash("cycle a");
const cycleBContent = hash("cycle b");
const cycleA = chainSource("cycle-a", "cycle a", [{
  sourceKey: evidenceSourceKey(cycleBRef),
  version: 1,
  contentSha256: cycleBContent,
  permissionRevision: 1
}]);
const cycleB = chainSource("cycle-b", "cycle b", [{
  sourceKey: evidenceSourceKey(cycleARef),
  version: 1,
  contentSha256: cycleAContent,
  permissionRevision: 1
}]);
const cycleStore = {
  captures: [
    { id: "cycle-a", version: 1, content: "cycle a", origin: "deepseek" },
    { id: "cycle-b", version: 1, content: "cycle b", origin: "deepseek" }
  ],
  evidenceSources: [cycleA, cycleB],
  evidencePermissions: [cycleA, cycleB].map(chainPermission),
  perceptionEvents: [cycleA, cycleB].map(chainEvent)
};
assert.deepEqual(evaluateStoredEvidenceChecks(cycleStore, [{
  evidenceId: cycleA.id,
  evidenceFingerprint: evidenceFingerprint(cycleA),
  purpose: "context"
}], {
  accountId: "account-a"
}).reasons, [EVIDENCE_ERROR_CODES.DEPENDENCY_STALE]);

const revokedStore = structuredClone(stored);
assert.equal(revokeEvidencePermissionsForResource(revokedStore, {
  accountId: "account-a",
  resourceType: "capture",
  resourceId: "capture-1"
}, "2026-10-07T01:00:00.000Z"), 1);
assert.deepEqual(revokedStore.evidencePermissions.find(item => item.sourceKey === sourceKey), {
  ...permission,
  contextAllowed: false,
  learningAllowed: false,
  revision: 5,
  updatedAt: "2026-10-07T01:00:00.000Z"
});
assert.deepEqual(evaluateStoredEvidenceChecks(revokedStore, [check], {
  accountId: "account-a"
}).reasons, ["EVIDENCE_PERMISSION_DENIED", "EVIDENCE_PERMISSION_STALE"]);
assert.equal(revokeEvidencePermissionsForResource(revokedStore, {
  accountId: "account-a",
  resourceType: "thought",
  resourceId: "thought-2"
}, "2026-10-07T02:00:00.000Z"), 1);
assert.throws(
  () => revokeEvidencePermissionsForResource(revokedStore, {
    accountId: "account-a",
    resourceType: "capture",
    resourceId: "capture-1"
  }, "not-a-date"),
  /requires a valid store/
);

console.log("Perception evidence checks passed: strict source/event/permission normalization, account and permission isolation, version/hash invalidation, restore safety, dependency invalidation, deterministic fingerprinting and event deduplication.");
