import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import "./prompt-test-setup.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import { collectAttachmentPaths } from "../src/shared/attachments/index.mjs";
import { createTrashService } from "../src/modules/trash/index.mjs";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import {
  evaluateStoredEvidenceChecks,
  evidenceFingerprint,
  normalizeEvidenceSource,
  normalizePerceptionEvent
} from "../src/modules/user-model/index.mjs";
import { createTrashMutations, createTrashCommands, createAttachmentCleanup, createAiTaskTargets } from "../src/app/index.mjs";
import { createTrashHttp } from "../src/http/index.mjs";
import { taskInputMatches } from "../src/modules/tasks/index.mjs";

const now = () => "2026-09-29T04:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
let sequence = 0;
const createId = () => `trash-${++sequence}`;
const annotations = createAnnotationService({ createId, now });
const trash = createTrashService({ createId, now, hash, retentionDays: 30 });
const cancelledRunningTasks = [];
const mutations = createTrashMutations({
  trash,
  annotations,
  now,
  getAccountId: () => account(),
  cancelTask: id => cancelledRunningTasks.push(id)
});
const annotation = (id, targetKey) => ({ id, targetKey, quote: "正文", text: "评论", replies: [{ id: "reply", text: "原回复" }] });
const journalSourceKey = JSON.stringify(["journal", "journal", "", ""]);
const journalHash = hash("正文");
const journalEvidence = normalizeEvidenceSource({
  schemaVersion: 1,
  id: "journal-evidence",
  accountId: "a",
  sourceRef: {
    resourceType: "journal",
    resourceId: "journal",
    rootId: "",
    targetKey: "",
    version: 2
  },
  eventId: "journal-event",
  origin: "user",
  informationType: "user_viewpoint",
  contentSha256: journalHash,
  contentLength: "正文".length,
  span: [0, "正文".length],
  occurredAt: "2026-09-02T01:02:03.000Z",
  recordedAt: "2026-09-29T03:00:00.000Z",
  permissionRevision: 1,
  derivedFrom: []
});
const journalEvidenceCheck = {
  evidenceId: journalEvidence.id,
  evidenceFingerprint: evidenceFingerprint(journalEvidence),
  purpose: "context"
};
const empty = () => ({
  trash: [], attachmentCleanup: [],
  books: [{ id: "book", title: "书名", version: 3, notes: [{ id: "note", content: "笔记正文" }], annotations: [annotation("mark", "note:note")], annotationDrift: [{ ...annotation("drift", "old"), originalTargetKey: "note:note", originalContext: { focus: "正文" } }] }],
  thoughts: [{ id: "root", type: "question", version: 4, content: "正文", annotations: [annotation("thought-mark", "answer:answer")], annotationDrift: [] }, { id: "answer", relatedTo: "root", type: "answer", content: "正文" }],
  journals: [{ id: "journal", version: 2, content: "正文", createdAt: "2026-09-01T01:02:03.000Z", occurredAt: "2026-09-02T01:02:03.000Z", annotations: [annotation("journal-mark", "content")], annotationDrift: [] }],
  journalDraft: { journalId: "journal", title: "编辑中的标题", content: "编辑中的正文" },
  evidencePermissions: [{
    schemaVersion: 1,
    accountId: "a",
    sourceKey: journalSourceKey,
    contextAllowed: true,
    learningAllowed: true,
    revision: 1,
    updatedAt: "2026-09-29T03:00:00.000Z"
  }],
  evidenceSources: [journalEvidence],
  perceptionEvents: [normalizePerceptionEvent({
    schemaVersion: 1,
    id: "journal-created",
    accountId: "a",
    kind: "created",
    sourceRef: journalEvidence.sourceRef,
    eventId: journalEvidence.eventId,
    contentSha256: journalHash,
    occurredAt: journalEvidence.occurredAt,
    recordedAt: journalEvidence.recordedAt,
    permissionRevision: 1,
    perceptionVersion: "perception-v1"
  })],
  aiTasks: [],
  notifications: [],
  actions: [],
  habits: [],
  habitCheckins: [],
  keepsakes: [], captures: [], checkins: [], dailyRecords: []
});
const context = new AsyncLocalStorage(), account = () => context.getStore() || "a";
const documents = new Map(), commits = [], removals = [], scheduled = [];
let rejectCommit = 0, commitAttempts = 0, remove = async () => {};
const repository = createJsonStoreRepository({
  getFile: account, normalize: value => value, emptyDocument: {},
  readDocument: async key => structuredClone(documents.get(key)),
  writeDocument: async (key, value) => {
    if (++commitAttempts === rejectCommit) throw new Error("injected commit failure");
    documents.set(key, structuredClone(value));
    commits.push(structuredClone(value));
  }
});
const cleanup = createAttachmentCleanup({
  repository, now, contextKey: account,
  remove: async resourcePath => { removals.push({ account: account(), path: resourcePath }); await remove(resourcePath); },
  dispatch: callback => { const owner = account(); scheduled.push(() => context.run(owner, callback)); },
  onRetryFailure: error => { throw error; }, onResult: async () => {}
});
const commands = createTrashCommands({ repository, trash, mutations, cleanup });
const reset = () => {
  documents.set("a", empty()); commits.length = 0; removals.length = 0;
  cancelledRunningTasks.length = 0; commitAttempts = 0; rejectCommit = 0; remove = async () => {};
};
const move = (collection, type, id) => repository.update(store => mutations.moveCollectionItemToTrash(store, collection, type, id));
const purge = async id => {
  const plan = await commands.preview([id]);
  return commands.purge([id], plan.planHash);
};

const collisionEntries = [
  {
    id: "trash-collision-book",
    type: "book",
    resourceId: "shared-id",
    payload: { id: "shared-id" },
    location: { kind: "collection", collection: "books" }
  },
  {
    id: "trash-unrelated-thought-remark",
    type: "thoughtRemark",
    resourceId: "remark",
    payload: { id: "remark" },
    location: {
      kind: "nested",
      parentCollection: "thoughts",
      parentId: "shared-id",
      field: "remarks"
    }
  }
];
const collisionPlan = trash.expanded(collisionEntries, ["trash-collision-book"]);
assert.deepEqual(collisionPlan.map(item => item.id), ["trash-collision-book"]);
trash.purge(collisionPlan);
assert.equal(collisionEntries[0].permanentlyPurged, true);
assert.equal(collisionEntries[1].permanentlyPurged, undefined);

// 旧记录缺少所属集合时，必须对全部候选身份核对唯一归属；同 ID 的未选思绪不能被忽略。
const ambiguousLegacyEntries = [
  {
    id: "ambiguous-book",
    type: "book",
    resourceId: "ambiguous-id",
    payload: { id: "ambiguous-id" },
    location: { kind: "collection", collection: "books" }
  },
  {
    id: "ambiguous-thought",
    type: "thoughtChain",
    resourceId: "ambiguous-id",
    payload: { id: "ambiguous-id" },
    location: { kind: "thoughtChain" }
  },
  {
    id: "ambiguous-legacy-remark",
    type: "thoughtRemark",
    resourceId: "ambiguous-remark",
    payload: { id: "ambiguous-remark" },
    location: { kind: "nested", parentId: "ambiguous-id", field: "remarks" }
  }
];
const ambiguousPlan = trash.expanded(ambiguousLegacyEntries, ["ambiguous-book"]);
assert.deepEqual(ambiguousPlan.map(item => item.id), ["ambiguous-book"]);
trash.purge(ambiguousPlan);
assert.equal(ambiguousLegacyEntries[0].permanentlyPurged, true);
assert.equal(ambiguousLegacyEntries[1].permanentlyPurged, undefined);
assert.equal(ambiguousLegacyEntries[2].permanentlyPurged, undefined);

// 单一候选身份时，旧记录仍按既有机制正常扩展；但类型与父集合不匹配的条目不得被串选。
const uniqueLegacyEntries = [
  {
    id: "unique-book",
    type: "book",
    resourceId: "unique-id",
    payload: { id: "unique-id" },
    location: { kind: "collection", collection: "books" }
  },
  {
    id: "unique-legacy-note",
    type: "bookNote",
    resourceId: "unique-note",
    payload: { id: "unique-note" },
    location: { kind: "nested", parentId: "unique-id", field: "notes" }
  },
  {
    id: "unique-legacy-remark",
    type: "thoughtRemark",
    resourceId: "unique-remark",
    payload: { id: "unique-remark" },
    location: { kind: "nested", parentId: "unique-id", field: "remarks" }
  }
];
assert.deepEqual(
  trash.expanded(uniqueLegacyEntries, ["unique-book"]).map(item => item.id),
  ["unique-book", "unique-legacy-note"]
);


reset();
const note = await repository.update(store => mutations.moveNestedItemToTrash(store, {
  parentCollection: "books", parentId: "book", field: "notes", type: "bookNote", id: "note", annotationTargetKeys: ["note:note"]
}));
assert.equal((await repository.read()).books[0].annotations.length, 0);
assert.equal((await repository.read()).books[0].annotationDrift.length, 0);
assert.equal(note.dependents.annotations[0].replies[0].text, "原回复");
assert.equal(note.dependents.annotationDrift[0].originalContext.focus, "正文");
assert.equal(note.purgeAfter, "2026-10-29T04:00:00.000Z");
const book = await move("books", "book", "book");
assert.equal((await commands.restore(note.id)).parentMissing, true);
assert.equal((await move("books", "book", "book")).id, book.id);
await commands.restore(book.id);
await commands.restore(note.id);
const restoredBook = (await repository.read()).books[0];
assert.equal(restoredBook.notes[0].content, "笔记正文");
assert.equal(restoredBook.annotations[0].replies[0].text, "原回复");
assert.equal(restoredBook.annotationDrift[0].originalContext.focus, "正文");
assert.equal(restoredBook.version, 6);
assert.equal((await commands.restore(note.id)).missing, true);

// N4：漂移区批注随子项移入回收站时，相关任务同样必须取消。
reset();
await repository.update(store => {
  store.aiTasks.push(
    { id: "running-note-mark", kind: "annotationShenji", resourceType: "book", targetId: "book", subtargetId: "mark", status: "running" },
    { id: "running-note-drift", kind: "annotationShenji", resourceType: "book", targetId: "book", subtargetId: "drift", status: "running" }
  );
});
const driftNote = await repository.update(store => mutations.moveNestedItemToTrash(store, {
  parentCollection: "books", parentId: "book", field: "notes", type: "bookNote", id: "note", annotationTargetKeys: ["note:note"]
}));
assert.deepEqual(driftNote.dependents.annotations.map(item => item.id), ["mark"]);
assert.deepEqual(driftNote.dependents.annotationDrift.map(item => item.id), ["drift"]);
const afterDriftDelete = await repository.read();
assert.equal(afterDriftDelete.aiTasks.find(item => item.id === "running-note-mark").status, "cancelling");
assert.equal(afterDriftDelete.aiTasks.find(item => item.id === "running-note-drift").status, "cancelling");
assert.deepEqual(cancelledRunningTasks, ["running-note-mark", "running-note-drift"]);

const block = await repository.update(store => mutations.moveThoughtBlockToTrash(store, "answer"));
assert.equal((await repository.read()).thoughts[0].annotations.length, 0);
const chain = await repository.update(store => mutations.moveThoughtChainToTrash(store, "root"));
assert.equal((await commands.restore(block.id)).parentMissing, true);
await commands.restore(chain.id);
await commands.restore(block.id);
assert.deepEqual((await repository.read()).thoughts.map(item => item.id), ["root", "answer"]);
assert.equal((await repository.read()).thoughts[0].version, 7);
assert.equal((await repository.read()).thoughts[0].annotations[0].id, "thought-mark");

reset();
await repository.update(store => {
  store.captures.push({ id: "capture-source", content: "来源念起", version: 1 });
  store.thoughts[0].sourceRef = { type: "capture", id: "capture-source", version: 1 };
});
const linkedChain = await repository.update(store => mutations.moveThoughtChainToTrash(store, "root"));
await repository.update(store => {
  store.thoughts.unshift({ id: "replacement-root", type: "question", version: 1, content: "新思考", sourceRef: { type: "capture", id: "capture-source", version: 1 } });
});
assert.equal((await commands.restore(linkedChain.id)).conflict, true);

reset();
const targets = createAiTaskTargets({ annotations, getAccountId: account, hash });
const annotationTask = { kind: "annotationShenji", resourceType: "journal", targetId: "journal", subtargetId: "journal-mark" };
const original = targets.prepare(await repository.read(), annotationTask);
assert.ok(original, "允许来源的当前账户应可准备删除前任务");
const beforeJournal = (await repository.read()).journals[0];
await repository.update(store => {
  store.aiTasks.push(
    { id: "queued-journal-task", kind: "annotationShenji", resourceType: "journal", targetId: "journal", subtargetId: "journal-mark", status: "queued" },
    { id: "running-journal-task", kind: "annotationShenji", resourceType: "journal", targetId: "journal", subtargetId: "journal-mark", status: "running" }
  );
  store.notifications.push(
    { id: "queued-notification", taskId: "queued-journal-task", status: "queued", readAt: "" },
    { id: "running-notification", taskId: "running-journal-task", status: "running", readAt: "" }
  );
});
const journal = await move("journals", "journal", "journal");
const afterJournalDelete = await repository.read();
assert.equal(targets.prepare(afterJournalDelete, annotationTask), null);
assert.equal(afterJournalDelete.journalDraft.journalId, "");
assert.equal(journal.tombstone, true);
assert.equal(journal.lifecycleState, "deleted");
let lifecycle = await repository.readPersistenceMetadata();
assert.equal(lifecycle.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal").state, "deleted");
assert.equal(lifecycle.lifecycles.find(item => item.resourceType === "journalDraft").state, "active");
assert.ok(lifecycle.lifecycles.find(item => item.resourceType === "journalDraft").history.some(item => item.event === "association_detached"));
assert.equal(afterJournalDelete.aiTasks.find(item => item.id === "queued-journal-task").status, "cancelled");
assert.equal(afterJournalDelete.aiTasks.find(item => item.id === "running-journal-task").status, "cancelling");
assert.equal(afterJournalDelete.notifications.find(item => item.taskId === "queued-journal-task").status, "cancelled");
assert.equal(afterJournalDelete.notifications.find(item => item.taskId === "running-journal-task").status, "cancelling");
assert.deepEqual(cancelledRunningTasks, ["running-journal-task"]);
assert.deepEqual(afterJournalDelete.evidencePermissions[0], {
  schemaVersion: 1,
  accountId: "a",
  sourceKey: journalSourceKey,
  contextAllowed: false,
  learningAllowed: false,
  revision: 2,
  updatedAt: now()
});
assert.deepEqual(evaluateStoredEvidenceChecks(afterJournalDelete, [journalEvidenceCheck], {
  accountId: "a"
}).reasons, ["EVIDENCE_SOURCE_DELETED"]);
await commands.restore(journal.id);
const restoredJournal = (await repository.read()).journals[0];
lifecycle = await repository.readPersistenceMetadata();
assert.equal(lifecycle.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal").state, "active");
assert.ok(lifecycle.lifecycles.find(item => item.resourceType === "journal" && item.resourceId === "journal").history.some(item => item.event === "restored"));
assert.equal(restoredJournal.version, beforeJournal.version + 1);
assert.equal((await repository.read()).evidencePermissions[0].contextAllowed, false);
assert.equal((await repository.read()).evidencePermissions[0].learningAllowed, false);
assert.equal((await repository.read()).evidencePermissions[0].revision, 2);
assert.deepEqual(evaluateStoredEvidenceChecks(await repository.read(), [journalEvidenceCheck], {
  accountId: "a"
}).reasons, [
  "EVIDENCE_PERMISSION_DENIED",
  "EVIDENCE_PERMISSION_STALE",
  "EVIDENCE_VERSION_STALE"
]);
for (const key of ["id", "content", "createdAt", "occurredAt", "annotations"]) assert.deepEqual(restoredJournal[key], beforeJournal[key]);
const restoredWork = targets.prepare(await repository.read(), annotationTask);
assert.equal(restoredWork, null, "恢复原文不会恢复已撤回的来源许可");
assert.equal(taskInputMatches({ ...annotationTask, inputVersion: original.inputVersion, inputHash: original.inputHash }, restoredWork), false);
const duplicate = await move("journals", "journal", "journal");
await repository.update(store => store.journals.push(structuredClone(beforeJournal)));
assert.equal((await commands.restore(duplicate.id)).conflict, true);
assert.equal((await commands.list()).items.some(item => item.id === duplicate.id), true);
await repository.update(store => trash.add(store.trash, "broken", { id: "broken" }, { kind: "unknown" }));
assert.equal((await commands.restore((await commands.list()).items[0].id)).invalid, true);

reset();
await repository.update(store => {
  store.actions.push({
    id: "feedback-action",
    title: "完成验证",
    status: "done",
    version: 2,
    completionFeedback: {
      outcome: "helpful",
      note: "有效",
      learningAllowed: true,
      recordedAt: now()
    },
    statusHistory: [{
      from: "doing",
      to: "done",
      reason: "complete",
      changedAt: now(),
      feedback: {
        outcome: "helpful",
        note: "有效",
        learningAllowed: true,
        recordedAt: now()
      }
    }]
  });
});
const deletedAction = await move("actions", "action", "feedback-action");
assert.equal(deletedAction.payload.completionFeedback.learningAllowed, false);
assert.equal(deletedAction.payload.statusHistory[0].feedback.learningAllowed, false);
await commands.restore(deletedAction.id);
const restoredAction = (await repository.read()).actions[0];
assert.equal(restoredAction.completionFeedback.learningAllowed, false);
assert.equal(restoredAction.statusHistory[0].feedback.learningAllowed, false);

reset();
await repository.update(store => {
  store.aiTasks.push({ id: "rollback-running-task", kind: "annotationShenji", resourceType: "journal", targetId: "journal", subtargetId: "journal-mark", status: "running" });
});
rejectCommit = commitAttempts + 1;
await assert.rejects(move("journals", "journal", "journal"), /injected commit failure/);
assert.deepEqual(cancelledRunningTasks, []);
assert.equal((await repository.read()).journals[0].id, "journal");
assert.equal((await repository.read()).aiTasks[0].status, "running");
assert.equal((await repository.read()).evidencePermissions[0].contextAllowed, true);
assert.equal((await repository.read()).evidencePermissions[0].revision, 1);

reset();
await repository.update(store => {
  store.books[0].imagePath = "/attachments/shared.png";
  store.keepsakes.push({ id: "keepsake", originalPath: "/attachments/shared.png", cutoutPath: "/attachments/only.png" });
});
const keepsake = await move("keepsakes", "keepsake", "keepsake");
assert.deepEqual(collectAttachmentPaths({ markdown: "before /attachments/not-a-ref.png", bad: "/attachments/../x", good: ["/attachments/shared.png"] }), new Set(["/attachments/shared.png"]));
const firstPurge = await purge(keepsake.id);
assert.deepEqual(firstPurge.attachments, ["/attachments/only.png"]);
assert.ok(commits.some(store => store.trash.every(item => item.permanentlyPurged === true) && store.attachmentCleanup.some(item => item.path === "/attachments/only.png")));
assert.ok(!removals.some(item => item.path === "/attachments/shared.png"));
const parent = await move("books", "book", "book");
const preview = await commands.preview([parent.id]);
await repository.update(store => trash.add(store.trash, "bookNote", { id: "new-child" }, { kind: "nested", parentId: "book" }));
const changed = await commands.purge([parent.id], preview.planHash);
assert.equal(changed.changed, true);
assert.equal(changed.plan.items.length, 2);
assert.equal((await commands.list()).items.length, 2);

// Neither missing confirmation nor a stale plan may delete data.
const handle = createTrashHttp({
  commands, bodyJson: async req => req.input, sendJson: (res, status, body) => Object.assign(res, { status, body }), logEvent: async () => {}
}).handle;
const response = {};
await handle({ method: "POST", input: { ids: [parent.id], planHash: preview.planHash } }, response, { pathname: "/api/trash/purge" });
assert.equal(response.status, 400);
assert.equal((await commands.list()).items.length, 2);
const finalPurge = await purge(parent.id);
assert.equal(finalPurge.entries.length, 2);
assert.deepEqual(finalPurge.attachments, ["/attachments/shared.png"]);

async function pendingFixture() {
  reset();
  await repository.update(store => { store.books[0].imagePath = "/attachments/pending.png"; });
  return move("books", "book", "book");
}
let pending = await pendingFixture();
rejectCommit = commitAttempts + 1;
await assert.rejects(purge(pending.id), /injected commit failure/);
assert.equal(removals.length, 0);
assert.equal((await commands.list()).items.length, 1);

pending = await pendingFixture();
rejectCommit = commitAttempts + 2;
await assert.rejects(purge(pending.id), /injected commit failure/);
assert.equal(removals.length, 1);
assert.equal((await commands.list()).items.length, 0);
assert.equal((await repository.read()).attachmentCleanup[0].path, "/attachments/pending.png");
// A restart sees the durable pre-removal task, and retries even when the object is already gone.
await cleanup.resume();
assert.equal(removals.length, 2);
assert.deepEqual((await repository.read()).attachmentCleanup, []);

pending = await pendingFixture();
remove = async () => { throw Object.assign(new Error("private provider response"), { code: "EACCES" }); };
assert.equal((await purge(pending.id)).attachmentCleanupPending, 1);
assert.equal((await repository.read()).attachmentCleanup[0].attempts, 1);
assert.equal((await repository.read()).attachmentCleanup[0].errorCode, "EACCES");
assert.equal(JSON.stringify((await repository.read()).attachmentCleanup).includes("private provider response"), false);
cleanup.schedule();
assert.equal(scheduled.length, 1);
// Retry retains its owning account even if another account is current at dispatch time.
documents.set("b", empty());
remove = async () => {};
await context.run("b", async () => {
  scheduled.shift()();
  await context.run("a", () => repository.waitForIdle());
  assert.deepEqual((await repository.read()).attachmentCleanup, []);
});
assert.equal(removals.at(-1).account, "a");
assert.deepEqual((await repository.read()).attachmentCleanup, []);

// Referenced objects are rescued from an old cleanup task.
await repository.update(store => {
  store.captures.push({ id: "rescue", image: "/attachments/rescue.png" });
  store.attachmentCleanup.push({ path: "/attachments/rescue.png", attempts: 1 });
});
const beforeRescue = removals.length;
await cleanup.resume();
assert.equal(removals.length, beforeRescue);
assert.deepEqual((await repository.read()).attachmentCleanup, []);

console.log("Trash checks passed: nested and whole restore, versioned late-result rejection, dependent annotations, plan changes, shared references, commit failures, retry recovery and account isolation.");
