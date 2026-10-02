import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import "./prompt-test-setup.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import { markdownText } from "../src/shared/content/index.mjs";
import { createAnnotationService } from "../src/modules/annotations/index.mjs";
import { createThoughtTaskTarget } from "../src/modules/thoughts/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { createAnnotationCommands, createAiTaskTargets, createBackgroundAi } from "../src/app/index.mjs";
import { createAnnotationHttp } from "../src/http/index.mjs";

const now = () => "2026-09-29T03:00:00.000Z";
let sequence = 0;
const createId = () => `generated-${++sequence}`;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const annotations = createAnnotationService({ createId, now });
const thoughts = createThoughtTaskTarget({ createId, now, stripThoughtAnswerLead: text => text });
const tasks = createTaskLifecycle({ createId, now, hash });
const notifications = createNotificationService({ createId, now });
const context = new AsyncLocalStorage();
const account = () => context.getStore() || "a";
const empty = () => ({
  thoughts: [{ id: "root", type: "question", version: 1, content: "原问题", tags: [], followUps: [{ id: "follow-up", question: "为什么", answer: "", version: 1 }], annotations: [], annotationDrift: [] }],
  captures: [], journals: [], books: [], chats: [], analyses: [], quotes: [], aiTasks: [], notifications: [], checkins: [], dailyRecords: []
});
const documents = new Map([["a", empty()], ["b", empty()]]);
const commits = [];
let rejectCompletion = false;
const repository = createJsonStoreRepository({
  getFile: account,
  readDocument: async key => structuredClone(documents.get(key)),
  normalize: document => document,
  emptyDocument: {},
  writeDocument: async (key, document) => {
    if (rejectCompletion && document.aiTasks.some(task => task.status === "succeeded")) {
      rejectCompletion = false;
      throw new Error("simulated commit failure");
    }
    documents.set(key, structuredClone(document));
    commits.push({ key, document: structuredClone(document) });
  }
});
const targets = createAiTaskTargets({ thoughts, annotations, hash });
const scheduled = [], calls = [];
let generate = async () => ({ content: "生成回答", reasoningContent: "私有思考" });
const background = createBackgroundAi({
  repository, tasks, notifications, targets, contextKey: account,
  dispatch: callback => scheduled.push({ account: account(), callback }),
  generate: async work => { calls.push({ account: account(), scene: work.scene, prompt: work.prompt, contextReceipt: work.contextReceipt }); return generate(work); },
  onError: (id, error) => { throw error; }
});
const commands = createAnnotationCommands({ repository, annotations, moveNestedItemToTrash: () => { throw new Error("unexpected delete"); } });

assert.equal(markdownText("# 标题\n\n**粗体** $x$\n\n- 甲\n- 乙\n\n> 引用"), "标题粗体 x甲乙引用");
assert.equal(markdownText("| 项 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n$$a+b$$"), "项值甲1a+b");
const source = "**甲🙂相同**中间**乙🙂相同**后文";
await repository.update(store => {
  store.journals.push({ id: "journal", content: source, annotations: [], annotationDrift: [], reflections: [{ id: "reflection", content: "回望**文字**" }] });
  store.books.push({ id: "book", description: "", notes: [{ id: "note", content: "笔记**文字**" }] });
});
const focus = "🙂相同", start = markdownText(source).lastIndexOf(focus);
const mark = await commands.create("journal", "journal", { kind: "comment", targetKey: "content", quote: focus, start, end: start + focus.length, text: "保留评论" });
assert.equal(mark.value.rawStart, start);
const idempotentInput = { kind: "comment", targetKey: "content", quote: focus, start, end: start + focus.length, text: "幂等评论" };
const idempotentComment = await commands.create("journal", "journal", idempotentInput, { clientRequestId: "comment-request-1" });
const replayedComment = await commands.create("journal", "journal", idempotentInput, { clientRequestId: "comment-request-1" });
assert.equal(replayedComment.value.id, idempotentComment.value.id);
assert.equal((await repository.read()).journals[0].annotations.filter(item => item.text === "幂等评论").length, 1);
await assert.rejects(
  commands.create("journal", "journal", { ...idempotentInput, text: "复用请求 ID 的不同评论" }, { clientRequestId: "comment-request-1" }),
  { code: "IDEMPOTENCY_KEY_REUSED" }
);
await commands.reply("journal", "journal", mark.value.id, { text: "保留回复" });
const movedSource = "前文" + source;
await repository.update(store => {
  const journal = store.journals[0];
  annotations.reanchorAnnotations(journal, "content", journal.content, movedSource);
  journal.content = movedSource;
});
assert.equal((await repository.read()).journals[0].annotations[0].start, start + 2);
await repository.update(store => {
  const journal = store.journals[0];
  annotations.reanchorAnnotations(journal, "content", journal.content, "正文全部替换");
  journal.content = "正文全部替换";
});
const drift = (await repository.read()).journals[0].annotationDrift[0];
assert.equal(drift.id, mark.value.id);
assert.equal(drift.replies[0].text, "保留回复");
assert.equal(drift.originalContext.focus, focus);
assert.equal((await commands.create("book", "book", { kind: "highlight", targetKey: "note:note", quote: "笔记文字", start: 0, end: 4 })).value.quote, "笔记文字");
assert.equal((await commands.create("journal", "journal", { kind: "highlight", targetKey: "reflection:reflection", quote: "回望文字", start: 0, end: 4 })).value.quote, "回望文字");

// Both public URL families must reach the same validation and visible-text rules.
const handle = createAnnotationHttp({ commands, backgroundAi: background, sendTaskCreation: () => {}, bodyJson: async req => req.input, sendJson: (res, status, body) => Object.assign(res, { status, body }), sendTrashResult: () => {} });
for (const pathname of ["/api/thoughts/root/annotations", "/api/annotations/thought/root"]) {
  const res = {};
  assert.equal(await handle({ method: "POST", input: { kind: "comment", targetKey: "question:root", quote: "原问题", start: 0, end: 3, text: "评论" } }, res, { pathname }), true);
  assert.equal(res.status, 201);
  assert.equal(res.body.rawStart, 0);
  const reply = {};
  await handle({ method: "POST", input: { text: "回复" } }, reply, { pathname: `${pathname}/${res.body.id}/replies` });
  assert.equal(reply.status, 201);
  const invalid = {};
  await handle({ method: "POST", input: {} }, invalid, { pathname });
  assert.equal(invalid.status, 400);
}
const idempotentHttpInput = { kind: "comment", targetKey: "question:root", quote: "原问题", start: 0, end: 3, text: "HTTP 幂等评论" };
const firstHttpComment = {}, replayedHttpComment = {};
await handle({ method: "POST", headers: { "idempotency-key": "comment-http-1" }, input: idempotentHttpInput }, firstHttpComment, { pathname: "/api/annotations/thought/root" });
await handle({ method: "POST", headers: { "idempotency-key": "comment-http-1" }, input: idempotentHttpInput }, replayedHttpComment, { pathname: "/api/annotations/thought/root" });
assert.equal(firstHttpComment.body.id, replayedHttpComment.body.id);
assert.equal((await repository.read()).thoughts[0].annotations.filter(item => item.text === "HTTP 幂等评论").length, 1);

const input = { kind: "thoughtAnswer", targetId: "root", inputVersion: 1, clientRequestId: "same-request" };
const created = await Promise.all([background.enqueue(input), background.enqueue(input)]);
assert.equal(created[0].task.id, created[1].task.id);
assert.deepEqual(created.map(item => item.duplicate), [false, true]);
assert.equal(scheduled.length, 1);
assert.equal((await background.enqueue({ ...input, targetId: "changed" })).conflict, true);
assert.equal((await background.listNotifications()).unread, 0);
const queuedNotification = (await background.listNotifications()).items[0];
await background.readNotification(queuedNotification.id);
await Promise.all([background.run(created[0].task.id), background.run(created[0].task.id)]);
assert.equal(calls.length, 1);
assert.equal((await background.get(created[0].task.id)).status, "succeeded");
assert.equal((await background.listNotifications()).unread, 1);
assert.equal((await repository.read()).thoughts.filter(item => item.sourceTaskId === created[0].task.id).length, 1);
const persistedAnswer = (await repository.read()).thoughts.find(item => item.sourceTaskId === created[0].task.id);
assert.equal(persistedAnswer.contextReceipt.version, "2026.10.02.1");
assert.ok(persistedAnswer.contextReceipt.sources.some(source => source.resourceId === "root"));
assert.equal(persistedAnswer.contextReceipt.sources.some(source => Object.hasOwn(source, "excerpt")), false);
assert.equal(persistedAnswer.contextReceipt.promptSha256, calls[0].contextReceipt.promptSha256);
assert.equal(await background.readAllNotifications(), 1);
assert.equal((await background.listNotifications()).unread, 0);
assert.ok(commits.some(({ document }) => document.aiTasks[0]?.status === "succeeded"
  && document.thoughts.some(item => item.sourceTaskId === created[0].task.id)
  && document.notifications[0]?.status === "succeeded"), "Result, task and notification commit together");

// Wait on explicit provider boundaries so this race test never relies on timing.
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const contextEntered = gate(), contextOutput = gate();
generate = async () => {
  contextEntered.resolve();
  return contextOutput.promise;
};
const contextDriftTask = await background.enqueue({
  kind: "thoughtAnswer",
  targetId: "root",
  inputVersion: 1,
  clientRequestId: "context-drift"
});
const contextDriftRun = background.run(contextDriftTask.task.id);
await contextEntered.promise;
await repository.update(store => {
  store.captures.push({
    id: "late-context",
    content: "生成期间新增的来源",
    occurredAt: now(),
    occurredOn: now().slice(0, 10),
    version: 1
  });
});
contextOutput.resolve({ content: "不得采用失效上下文" });
await contextDriftRun;
assert.equal((await background.get(contextDriftTask.task.id)).status, "stale");
assert.equal((await repository.read()).thoughts.some(item => item.sourceTaskId === contextDriftTask.task.id), false);

const annotationEntered = gate(), annotationOutput = gate();
generate = async () => { annotationEntered.resolve(); return annotationOutput.promise; };
const annotationId = (await repository.read()).thoughts.find(item => item.id === "root").annotations[0].id;
const queuedCancellation = await background.enqueue({
  kind: "annotationShenji", resourceType: "thought", targetId: "root", subtargetId: annotationId,
  clientRequestId: "annotation-cancelled-before-call"
});
await repository.update(store => {
  const task = store.aiTasks.find(item => item.id === queuedCancellation.task.id);
  task.status = "cancelled";
  task.completedAt = now();
});
const callsBeforeQueuedCancellation = calls.length;
await background.run(queuedCancellation.task.id);
assert.equal(calls.length, callsBeforeQueuedCancellation);
assert.equal((await background.get(queuedCancellation.task.id)).status, "cancelled");
const annotationTask = await background.enqueue({
  kind: "annotationShenji", resourceType: "thought", targetId: "root", subtargetId: annotationId,
  clientRequestId: "annotation-delete-restore"
});
const annotationRunning = background.run(annotationTask.task.id);
await annotationEntered.promise;
await repository.update(store => {
  const root = store.thoughts.find(item => item.id === "root");
  const task = store.aiTasks.find(item => item.id === annotationTask.task.id);
  task.status = "cancelling";
  task.cancellationRequestedAt = now();
  const [deleted] = root.annotations.splice(0, 1);
  root.version += 1;
  root.annotations.unshift(structuredClone(deleted));
  root.version += 1;
});
annotationOutput.resolve({ content: "删除前启动的批注回答" });
await annotationRunning;
assert.equal((await background.get(annotationTask.task.id)).status, "cancelled");
assert.equal((await background.listNotifications()).items.find(item => item.taskId === annotationTask.task.id).status, "cancelled");
assert.equal((await repository.read()).thoughts.find(item => item.id === "root").annotations[0].shenji, undefined);
// The following race starts from the version current after restoration.
const followUpVersion = (await repository.read()).thoughts.find(item => item.id === "root").version;
const entered = gate(), output = gate();
generate = async () => { entered.resolve(); return output.promise; };
const followUp = await background.enqueue({ kind: "followUpAnswer", targetId: "root", subtargetId: "follow-up", inputVersion: followUpVersion, subtargetVersion: 1, clientRequestId: "follow-up" });
const running = background.run(followUp.task.id);
await entered.promise;
await repository.update(store => { store.thoughts.find(item => item.id === "root").version += 1; });
output.resolve({ content: "迟到回答" });
await running;
assert.equal((await background.get(followUp.task.id)).status, "stale");
assert.equal((await repository.read()).thoughts.find(item => item.id === "root").followUps[0].answer, "");
const retries = await Promise.all([background.retry(followUp.task.id), background.retry(followUp.task.id)]);
assert.equal(retries[0].task.id, retries[1].task.id);
assert.deepEqual(retries.map(item => item.duplicate), [false, true]);
generate = async () => ({ content: "追问新回答", reasoningContent: "私有思考" });
await background.run(retries[0].task.id);
assert.equal((await background.get(retries[0].task.id)).status, "succeeded");
assert.equal((await repository.read()).thoughts.find(item => item.id === "root").followUps[0].sourceTaskId, retries[0].task.id);

documents.set("a", empty());
const interrupted = await background.enqueue({ ...input, clientRequestId: "interrupted" });
await repository.update(store => tasks.claim(store.aiTasks, interrupted.task.id));
const queued = await background.enqueue({ ...input, clientRequestId: "queued-on-restart" });
const callsBeforeRestart = calls.length, scheduledBeforeRestart = scheduled.length;
await background.resume();
assert.equal(calls.length, callsBeforeRestart);
assert.equal(scheduled.length, scheduledBeforeRestart + 1);
assert.equal((await background.get(interrupted.task.id)).status, "failed");
assert.match((await background.get(interrupted.task.id)).error, /避免重复计费/);
assert.equal((await background.get(queued.task.id)).status, "queued");
await background.run(queued.task.id);
assert.equal((await background.get(queued.task.id)).status, "succeeded");

documents.set("a", empty());
const commitFailure = await background.enqueue({ ...input, clientRequestId: "commit-failure" });
rejectCompletion = true;
await background.run(commitFailure.task.id);
const failedState = await repository.read();
assert.equal(failedState.aiTasks[0].status, "failed");
assert.equal(failedState.notifications[0].status, "failed");
assert.equal(failedState.thoughts.some(item => item.sourceTaskId === commitFailure.task.id), false);

// Two accounts can run the same persisted task ID without suppressing or mixing work.
documents.set("a", empty());
documents.set("b", empty());
const sharedTask = (await background.enqueue({ ...input, clientRequestId: "shared-id" })).task;
await context.run("b", () => repository.update(store => {
  store.thoughts[0].content = "账户 B 问题";
  const copied = structuredClone(sharedTask);
  copied.inputHash = targets.prepare(store, copied).inputHash;
  store.aiTasks.push(copied);
}));
const bothEntered = gate(), bothOutput = gate();
let inFlight = 0;
generate = async () => { if (++inFlight === 2) bothEntered.resolve(); return bothOutput.promise; };
const accountA = context.run("a", () => background.run(sharedTask.id));
const accountB = context.run("b", () => background.run(sharedTask.id));
await bothEntered.promise;
bothOutput.resolve({ content: "按各自账户保存" });
await Promise.all([accountA, accountB]);
assert.deepEqual(calls.slice(-2).map(call => call.account).sort(), ["a", "b"]);
const accountReceiptHashes = [];
for (const owner of ["a", "b"]) {
  await context.run(owner, async () => {
    assert.equal((await background.get(sharedTask.id)).status, "succeeded");
    const answer = (await repository.read()).thoughts.find(item => item.sourceTaskId === sharedTask.id);
    assert.ok(answer);
    assert.equal(answer.contextReceipt.sources.some(source => Object.hasOwn(source, "excerpt")), false);
    assert.match(answer.contextReceipt.promptSha256, /^[a-f0-9]{64}$/);
    accountReceiptHashes.push(answer.contextReceipt.promptSha256);
  });
}
assert.notEqual(accountReceiptHashes[0], accountReceiptHashes[1]);

console.log("Collaboration checks passed: visible-text anchors, drift preservation, legacy routes, atomic task/notification results, idempotency, late results, retry, restart and account isolation.");
