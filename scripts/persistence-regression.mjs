import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPostgresMigrationPlan,
  canonicalJson,
  createAuthRepository,
  createJsonStoreRepository,
  discoverJsonStores,
  publicPersistenceDocument,
  rebuildStoreObjects,
  storeContentSha256
} from "../src/shared/persistence/index.mjs";
import { migrationStore } from "./fixtures/migration-store.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-persistence-"));
const storeFile = path.join(root, "store.json");
const emptyStore = { version: 14, thoughts: [], captures: [] };
const readDocument = async (file, fallback) => {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid document");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
};
const writeDocument = async (file, value) => {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
};
const commits = [];
const repository = createJsonStoreRepository({
  getFile: () => storeFile,
  readDocument,
  writeDocument,
  normalize: value => ({ ...structuredClone(emptyStore), ...value }),
  emptyDocument: emptyStore,
  onCommit: async (before, after) => commits.push([before.captures.length, after.captures.length])
});

await Promise.all(Array.from({ length: 20 }, (_, index) => repository.update(store => {
  store.captures.push({ id: `capture-${index}` });
})));
assert.equal((await repository.read()).captures.length, 20);
assert.equal(commits.length, 20);

let releaseQueuedUpdate;
let queuedUpdateEntered;
const queuedUpdateStarted = new Promise(resolve => { queuedUpdateEntered = resolve; });
const queuedUpdateReleased = new Promise(resolve => { releaseQueuedUpdate = resolve; });
const queuedUpdate = repository.update(async store => {
  store.captures.push({ id: "before-replace" });
  queuedUpdateEntered();
  await queuedUpdateReleased;
});
await queuedUpdateStarted;
let replaceSawQueuedUpdate = false;
const replacement = repository.replace({
  version: 14,
  thoughts: [],
  captures: [{ id: "replacement" }]
}, {
  beforeWrite: current => {
    replaceSawQueuedUpdate = current.captures.some(item => item.id === "before-replace");
  }
});
const trailingUpdate = repository.update(store => {
  store.captures.push({ id: "after-replace" });
});
releaseQueuedUpdate();
await Promise.all([queuedUpdate, replacement, trailingUpdate]);
assert.equal(replaceSawQueuedUpdate, true);
assert.deepEqual(
  (await repository.read()).captures.map(item => item.id),
  ["replacement", "after-replace"]
);

let runtimeAuth = { version: 1, users: [], sessions: [] };
const runtimeAuthCommits = [], provisions = [];
const runtimeAuthRepository = createAuthRepository({
  runtime: {
    auth: {
      read: async () => structuredClone(runtimeAuth),
      update: async mutator => {
        const next = structuredClone(runtimeAuth);
        const result = await mutator(next);
        runtimeAuth = next;
        return result;
      },
      provision: (...args) => provisions.push(args)
    }
  },
  onCommit: async (before, after) => runtimeAuthCommits.push([before, after])
});
await runtimeAuthRepository.update(auth => {
  auth.users.push({ id: "runtime-user" });
});
runtimeAuthRepository.provision("runtime-user", { version: 16 }, {});
assert.equal(runtimeAuthCommits.length, 1);
assert.deepEqual(runtimeAuthCommits[0][0].users, []);
assert.deepEqual(runtimeAuthCommits[0][1].users, [{ id: "runtime-user" }]);
assert.equal(provisions.length, 1);

const metadataFile = path.join(root, "metadata-store.json");
await fs.writeFile(metadataFile, `${JSON.stringify({
  version: 15,
  thoughts: [],
  captures: [],
  journals: [{
    id: "journal-lifecycle",
    title: "正式日记",
    content: "正文",
    version: 1,
    createdAt: "2026-09-29T01:00:00.000Z"
  }],
  journalDraft: {
    journalId: "journal-lifecycle",
    title: "未提交修改",
    content: "草稿正文",
    updatedAt: "2026-09-29T01:01:00.000Z"
  },
  trash: []
}, null, 2)}\n`);
const metadataRepository = () => createJsonStoreRepository({
  getFile: () => metadataFile,
  readDocument,
  writeDocument,
  normalize: value => value,
  emptyDocument: {},
  getContext: () => ({ clientOperationId: "sync-test-operation", traceId: "sync-test-trace" })
});
const firstMetadataRepository = metadataRepository();
let idempotentExecutions = 0;
const request = { scope: "checkins.create", key: "persistent-key", requestHash: "request-hash" };
const originalResponse = { statusCode: 201, body: { id: "stable-record", value: 4 } };
const createOnce = store => {
  idempotentExecutions += 1;
  store.captures.push({ id: "stable-record", clientRequestId: request.key, requestHash: request.requestHash });
  return structuredClone(originalResponse);
};
assert.deepEqual(await firstMetadataRepository.executeIdempotent(request, createOnce), originalResponse);
const initialSyncMetadata = await firstMetadataRepository.readPersistenceMetadata();
assert.equal(initialSyncMetadata.sync.cursor, 1);
assert.deepEqual(initialSyncMetadata.sync.changes.map(change => ({
  domain: change.domain,
  resourceId: change.resourceId,
  operationId: change.operationId,
  changeType: change.changeType
})), [{
  domain: "captures",
  resourceId: "stable-record",
  operationId: "sync-test-operation",
  changeType: "create"
}]);
assert.deepEqual((await firstMetadataRepository.readSyncSnapshot()).document.captures, [{
  id: "stable-record",
  clientRequestId: request.key,
  requestHash: request.requestHash
}]);
assert.deepEqual(await firstMetadataRepository.executeIdempotent(request, () => {
  throw new Error("same request must replay without executing");
}), originalResponse);
assert.equal(idempotentExecutions, 1);
await assert.rejects(
  firstMetadataRepository.executeIdempotent({ ...request, requestHash: "different-request" }, () => null),
  error => error.code === "IDEMPOTENCY_KEY_REUSED" && error.statusCode === 409
);
assert.deepEqual(await firstMetadataRepository.executeIdempotent(request, () => null, {
  onReplay: response => ({ ...response, duplicate: true })
}), { ...originalResponse, duplicate: true });

const expiryFile = path.join(root, "idempotency-expiry.json");
let expiryNow = "2026-01-01T00:00:00.000Z";
const expiryRepository = createJsonStoreRepository({
  getFile: () => expiryFile,
  readDocument,
  writeDocument,
  normalize: value => ({ version: 15, thoughts: [], captures: [], trash: [], ...value }),
  emptyDocument: { version: 15, thoughts: [], captures: [], trash: [] },
  now: () => expiryNow
});
let expiryExecutions = 0;
const expiringRequest = { scope: "captures.create", key: "expires-after-90-days", requestHash: "expiry-hash" };
const expiringOperation = store => {
  expiryExecutions += 1;
  const response = { value: { id: `expiry-record-${expiryExecutions}` }, duplicate: false };
  store.captures.push(response.value);
  return response;
};
assert.equal((await expiryRepository.executeIdempotent(expiringRequest, expiringOperation)).value.id, "expiry-record-1");
assert.equal((await expiryRepository.readPersistenceMetadata()).idempotency[0].expiresAt, "2026-04-01T00:00:00.000Z");
expiryNow = "2026-03-31T23:59:59.000Z";
assert.equal((await expiryRepository.executeIdempotent(expiringRequest, expiringOperation)).value.id, "expiry-record-1");
expiryNow = "2026-04-01T00:00:00.000Z";
assert.equal((await expiryRepository.executeIdempotent(expiringRequest, expiringOperation)).value.id, "expiry-record-2");
assert.equal(expiryExecutions, 2);

await firstMetadataRepository.update(store => {
  const [capture] = store.captures.splice(0, 1);
  store.trash.push({
    id: "trash-stable-record",
    type: "capture",
    resourceId: capture.id,
    deletedAt: "2026-09-29T02:00:00.000Z",
    purgeAfter: "2026-10-29T02:00:00.000Z",
    location: { kind: "collection", collection: "captures", index: 0 },
    payload: capture
  });
});
await firstMetadataRepository.update(store => {
  store.trash = store.trash.filter(item => item.resourceId !== "stable-record");
});
const restartedMetadataRepository = metadataRepository();
assert.deepEqual(await restartedMetadataRepository.executeIdempotent(request, () => {
  throw new Error("purge and restart must not forget an idempotency response");
}), originalResponse);
let concurrentExecutions = 0;
const concurrentRequest = { scope: "actions.create", key: "concurrent-key", requestHash: "concurrent-hash" };
const concurrentResponses = await Promise.all([metadataRepository(), metadataRepository()].map(instance =>
  instance.executeIdempotent(concurrentRequest, async store => {
    concurrentExecutions += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    const response = { statusCode: 201, body: { id: "one-concurrent-record" } };
    store.captures.push({ id: response.body.id });
    return response;
  })
));
assert.equal(concurrentExecutions, 1);
assert.deepEqual(concurrentResponses[0], concurrentResponses[1]);

await restartedMetadataRepository.update(store => {
  const [journal] = store.journals.splice(0, 1);
  store.journalDraft.journalId = "";
  store.trash.push({
    id: "trash-journal",
    type: "journal",
    resourceId: journal.id,
    deletedAt: "2026-09-29T03:00:00.000Z",
    purgeAfter: "2026-10-29T03:00:00.000Z",
    location: { kind: "collection", collection: "journals", index: 0 },
    payload: journal
  });
});
let metadata = await restartedMetadataRepository.readPersistenceMetadata();
assert.equal(metadata.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal-lifecycle").state, "deleted");
const draftLifecycle = metadata.lifecycles.find(item => item.resourceType === "journalDraft");
assert.equal(draftLifecycle.lifecycle, "draft");
assert.equal(draftLifecycle.state, "active");
assert.equal(draftLifecycle.tombstone, false);
assert.ok(draftLifecycle.history.some(item => item.event === "association_detached"));
assert.equal((await restartedMetadataRepository.read()).journalDraft.content, "草稿正文");

await restartedMetadataRepository.update(store => {
  const entry = store.trash.find(item => item.resourceId === "journal-lifecycle");
  store.journals.push(entry.payload);
  store.trash = store.trash.filter(item => item !== entry);
});
metadata = await restartedMetadataRepository.readPersistenceMetadata();
assert.equal(metadata.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal-lifecycle").state, "active");
assert.ok(metadata.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal-lifecycle").history.some(item => item.event === "restored"));

await restartedMetadataRepository.update(store => {
  const [journal] = store.journals.splice(0, 1);
  store.trash.push({
    id: "trash-journal-again",
    type: "journal",
    resourceId: journal.id,
    deletedAt: "2026-09-29T04:00:00.000Z",
    purgeAfter: "2026-10-29T04:00:00.000Z",
    location: { kind: "collection", collection: "journals", index: 0 },
    payload: journal
  });
});
await restartedMetadataRepository.update(store => {
  store.trash = store.trash.filter(item => item.resourceId !== "journal-lifecycle");
});
metadata = await restartedMetadataRepository.readPersistenceMetadata();
const purgedJournal = metadata.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal-lifecycle");
assert.equal(purgedJournal.state, "purged");
assert.equal(purgedJournal.tombstone, true);
assert.ok(purgedJournal.purgedAt);
assert.equal((await restartedMetadataRepository.read()).journalDraft.content, "草稿正文");
const durableStore = JSON.parse(await fs.readFile(metadataFile, "utf8"));
const durablePlan = buildPostgresMigrationPlan({ accountId: "metadata-account", store: durableStore });
assert.equal(durablePlan.business.idempotency.length, 2);
assert.ok(durablePlan.business.lifecycles.some(item => item.resourceId === "journal-lifecycle" && item.state === "purged"));
assert.deepEqual(rebuildStoreObjects(durablePlan.business), durablePlan.snapshot);
assert.deepEqual(
  rebuildStoreObjects(durablePlan.business)._persistence.sync,
  durablePlan.snapshot._persistence.sync
);
assert.deepEqual(durablePlan.business.lifecycles.map(item => item.position), durablePlan.business.lifecycles.map((_, index) => index));
assert.deepEqual(durablePlan.business.idempotency.map(item => item.position), [0, 1]);
const unorderedMetadata = structuredClone(durablePlan.business);
unorderedMetadata.lifecycles.reverse();
unorderedMetadata.idempotency.reverse();
assert.deepEqual(rebuildStoreObjects(unorderedMetadata), durablePlan.snapshot);
const badMetadataPosition = structuredClone(durablePlan.business);
badMetadataPosition.lifecycles[1].position = badMetadataPosition.lifecycles[0].position;
assert.throws(() => rebuildStoreObjects(badMetadataPosition), /Non-contiguous positions: lifecycles/);
const extendedMetadataStore = structuredClone(durablePlan.snapshot);
extendedMetadataStore._persistence.futureMetadata = { retained: true };
extendedMetadataStore._persistence.lifecycles[0].futureLifecycle = { retained: true };
extendedMetadataStore._persistence.idempotency[0].response = null;
extendedMetadataStore._persistence.idempotency[0].futureLedger = { retained: true };
const extendedMetadataPlan = buildPostgresMigrationPlan({ accountId: "metadata-extensions", store: extendedMetadataStore });
assert.deepEqual(rebuildStoreObjects(extendedMetadataPlan.business), extendedMetadataPlan.snapshot);
const schema = await fs.readFile(path.join(ROOT, "src/shared/persistence/postgres-schema.sql"), "utf8");
assert.match(schema, /CREATE TABLE IF NOT EXISTS for_now\.resource_lifecycle/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS for_now\.idempotency_ledger/);
assert.match(schema, /PRIMARY KEY \(account_id, scope, idempotency_key\)/);
assert.match(schema, /resource_lifecycle_position_idx/);
assert.match(schema, /idempotency_ledger_position_idx/);
assert.match(schema, /ALTER COLUMN response DROP NOT NULL/);

const sourceStore = {
  version: 14,
  thoughts: [
    {
      id: "question-1",
      type: "question",
      content: "问题",
      authorType: "user",
      tags: ["forNow"],
      createdAt: "2026-09-28T01:00:00.000Z",
      occurredAt: "2026-09-28T01:00:00.000Z",
      occurredOn: "2026-09-28",
      version: 2,
      sourceRef: { type: "capture", id: "capture-1", version: 1 },
      remarks: [{ id: "remark-1", text: "备注", createdAt: "2026-09-28T01:01:00.000Z", version: 1 }],
      followUps: [{ id: "follow-1", question: "追问", answer: "", createdAt: "2026-09-28T01:02:00.000Z", version: 1 }],
      annotations: [{ id: "annotation-1", kind: "comment", targetKey: "question:question-1", quote: "问题", text: "评论", createdAt: "2026-09-28T01:03:00.000Z" }]
    },
    {
      id: "idea-1",
      type: "idea",
      relatedTo: "question-1",
      content: "想法",
      authorType: "user",
      createdAt: "2026-09-28T01:04:00.000Z",
      occurredAt: "2026-09-28T01:04:00.000Z",
      occurredOn: "2026-09-28",
      version: 1
    },
    {
      id: "answer-1",
      type: "answer",
      relatedTo: "question-1",
      content: "回答",
      authorType: "ai",
      createdAt: "2026-09-28T01:05:00.000Z",
      occurredAt: "2026-09-28T01:05:00.000Z",
      occurredOn: "2026-09-28",
      version: 1
    }
  ],
  captures: [{ id: "capture-1" }]
};
const sourceText = `${JSON.stringify(sourceStore, null, 2)}\n`;
const plan = buildPostgresMigrationPlan({ accountId: "account-1", store: sourceStore, sourceText });
assert.equal(plan.sourceVersion, 14);
assert.equal(plan.sourceSha256.length, 64);
assert.deepEqual(plan.sourceCounts, {
  storeCollections: { thoughts: 3, captures: 1 },
  thoughtEntries: 1,
  thoughtBlocks: 3,
  thoughtFollowUps: 1,
  thoughtRemarks: 1,
  thoughtAnnotations: 1,
  businessFields: 4,
  businessObjects: 7,
  businessRelations: 3,
  attachmentReferences: 0,
  lifecycleRecords: 7,
  idempotencyRecords: 0
});
assert.deepEqual(plan.entryBlocks.map(item => item.kind), ["user_question", "user_idea", "ai_answer"]);
assert.equal(plan.entries[0].payload.content, "问题");

await fs.writeFile(storeFile, sourceText);
const discovered = await discoverJsonStores(root);
assert.equal(discovered.length, 1);
assert.equal(discovered[0].accountId, "local");
assert.equal(discovered[0].sourceSha256, plan.sourceSha256);

assert.throws(() => buildPostgresMigrationPlan({
  accountId: "broken",
  store: { version: 14, thoughts: [{ id: "orphan", type: "record", relatedTo: "missing" }] }
}), /without a root/);

const fixture = migrationStore();
const fullPlan = buildPostgresMigrationPlan({ accountId: "fixture-account", store: fixture });
assert.deepEqual(publicPersistenceDocument(rebuildStoreObjects(fullPlan.business)), fixture);
assert.ok(fullPlan.business.lifecycles.some(row => (
  row.resourceType === "capture" && row.resourceId === "deleted-1"
  && row.state === "deleted" && row.tombstone === true
)));
assert.ok(fullPlan.business.objects.every(row => ["draft", "formal"].includes(row.lifecycle)));
assert.equal(fullPlan.business.objects.find(row => row.kind === "journalDraft").lifecycle, "draft");
assert.equal(fullPlan.business.objects.find(row => row.kind === "trash").tombstone, true);
assert.equal(fullPlan.business.fields.length, Object.keys(fixture).length + 1);
assert.equal(fullPlan.business.objects.filter(row => row.parentKey).length, 9);
assert.equal(fullPlan.business.attachmentRefs.length, 6);
assert.ok(fullPlan.business.relations.some(row => row.targetId === "deleted-root" && row.resolution === "historical"));
assert.equal(fullPlan.business.relations.filter(row => row.relation === "subtarget" && row.resolution === "live").length, 2);
assert.ok(plan.business.relations.some(row => row.relation === "source" && row.targetId === "capture-1" && row.resolution === "live"));
assert.ok(fullPlan.business.relations.some(row => row.relation === "result" && row.targetId === "exchange-1" && row.resolution === "live"));
assert.ok(fullPlan.business.objects.some(row => row.kind === "annotationExchange" && row.parentKey));
assert.ok(fullPlan.business.objects.some(row => row.kind === "thought" && !Object.hasOwn(row.payload, "followUps")));
fixture.captures[0].content = "后续内存修改";
assert.equal(fullPlan.snapshot.captures[0].content, "原始捕念");
assert.equal(storeContentSha256(rebuildStoreObjects(fullPlan.business)), fullPlan.contentSha256);
assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
assert.notEqual(storeContentSha256([1, 2]), storeContentSha256([2, 1]));

const speechStore = {
  version: 16,
  captures: [{ id: "speech-capture", content: "朗读来源", version: 2 }],
  thoughts: [
    { id: "speech-question", type: "question", content: "问题", version: 1 },
    { id: "speech-answer", type: "answer", relatedTo: "speech-question", content: "回答", version: 1 }
  ],
  speechCache: [{
    id: "speech-asset",
    cacheKey: "speech-asset",
    ownerHash: "private-owner-hash",
    sourceType: "thoughtAnswer",
    sourceId: "speech-answer",
    sourceVersion: 1,
    textHash: "private-text-hash",
    voice: "voice-a",
    generationRate: -10,
    attachmentPath: "/attachments/speech.tts.mp3",
    mimeType: "audio/mpeg",
    bytes: 128,
    createdAt: "2026-10-04T00:00:00.000Z",
    expiresAt: "2026-11-03T00:00:00.000Z"
  }]
};
const speechPlan = buildPostgresMigrationPlan({ accountId: "speech-account", store: speechStore });
assert.deepEqual(publicPersistenceDocument(rebuildStoreObjects(speechPlan.business)), speechStore);
assert.ok(speechPlan.business.attachmentRefs.some(reference => (
  reference.fieldName === "speechCache"
  && reference.ownerKey === null
  && reference.path === "/attachments/speech.tts.mp3"
)));

const g2Store = {
  version: 15,
  thoughts: [],
  journalDraft: { journalId: "", title: "未绑定日记的草稿", content: "仍需保留" },
  actions: [{ id: "action-g2", title: "行动", sourceRef: { type: "thought", id: "historical-thought" }, version: 1 }],
  habits: [{ id: "habit-g2", title: "习惯", version: 1 }],
  habitCheckins: [{ id: "habit-checkin-g2", habitId: "habit-g2", occurredOn: "2026-09-29", version: 1 }],
  feedback: [{ id: "feedback-g2", body: "反馈", version: 1 }],
  validationLedger: [{ id: "validation-g2", participantRef: "成员-01", version: 1 }]
};
const g2Plan = buildPostgresMigrationPlan({ accountId: "g2-account", store: g2Store });
assert.deepEqual(publicPersistenceDocument(rebuildStoreObjects(g2Plan.business)), g2Store);
assert.deepEqual(
  new Set(g2Plan.business.objects.map(row => row.kind)),
  new Set(["journalDraft", "action", "habit", "habitCheckin", "feedback", "validationLedger"])
);
assert.equal(g2Plan.business.relations.some(row => row.objectKey === JSON.stringify(["journalDraft"])), false);
assert.ok(g2Plan.business.relations.some(row => row.relation === "habit" && row.resolution === "live"));
assert.ok(g2Plan.business.relations.some(row => row.relation === "source" && row.resolution === "historical"));
const cancelledTaskStore = {
  version: 15,
  thoughts: [],
  aiTasks: [
    { id: "cancelled-task", kind: "thoughtAnswer", resourceType: "thought", targetId: "deleted-target", status: "cancelled" },
    { id: "cancelling-task", kind: "annotationShenji", resourceType: "journal", targetId: "deleted-journal", subtargetId: "deleted-annotation", status: "cancelling" }
  ]
};
const cancelledTaskPlan = buildPostgresMigrationPlan({ accountId: "cancelled-task-account", store: cancelledTaskStore });
assert.deepEqual(publicPersistenceDocument(rebuildStoreObjects(cancelledTaskPlan.business)), cancelledTaskStore);
assert.equal(cancelledTaskPlan.business.relations.filter(row => row.relation === "target" && row.resolution === "historical").length, 2);
assert.throws(() => buildPostgresMigrationPlan({
  accountId: "broken-g2",
  store: { ...g2Store, habitCheckins: [{ id: "orphan-checkin", habitId: "missing" }] }
}), /Unresolved habit reference/);

assert.throws(() => buildPostgresMigrationPlan({
  accountId: "mismatch", store: sourceStore, sourceText: '{"thoughts":[]}'
}), /Source text does not match/);
assert.throws(() => buildPostgresMigrationPlan({
  accountId: "malformed", store: sourceStore, sourceText: '{"content":"PRIVATE_TEST_TEXT'
}), error => error.message === "Invalid JSON migration source");
for (const corrupt of [
  store => { store.books[0].notes.push(structuredClone(store.books[0].notes[0])); },
  store => { store.captures = {}; },
  store => { store.journalDraft.journalId = "missing"; },
  store => { store.books[0].notes[0].id = ""; },
  store => { store.captures[0].annotations = null; },
  store => { store.aiTasks[2].subtargetId = "missing"; },
  store => { store.aiTasks[2].targetId = ""; }
]) {
  const broken = migrationStore();
  corrupt(broken);
  assert.throws(() => buildPostgresMigrationPlan({ accountId: "broken", store: broken }));
}
const badPosition = structuredClone(fullPlan.business);
badPosition.objects.find(row => row.kind === "bookNote").position = 3;
assert.throws(() => rebuildStoreObjects(badPosition), /Non-contiguous positions/);
const orphan = structuredClone(fullPlan.business);
orphan.objects.find(row => row.kind === "bookNote").parentKey = "missing";
assert.throws(() => rebuildStoreObjects(orphan), /Orphan/);
const blank = { version: 14, thoughts: [], journalDraft: null, unknown: [] };
assert.deepEqual(publicPersistenceDocument(rebuildStoreObjects(buildPostgresMigrationPlan({ accountId: "blank", store: blank }).business)), blank);
await fs.writeFile(path.join(root, "auth.json"), '{"users":[]}');
await assert.rejects(discoverJsonStores(root), /refusing local-store fallback/);

await fs.writeFile(storeFile, "{broken");
await assert.rejects(repository.read(), /JSON/);
assert.equal(await fs.readFile(storeFile, "utf8"), "{broken");

await fs.rm(root, { recursive: true, force: true });
console.log("Persistence checks passed: serialized JSON writes, all-domain round-trip, nested ownership, attachment refs, source integrity and corrupt-data rejection.");
