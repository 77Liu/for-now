import assert from "node:assert/strict";
import {
  DISCOVERY_GENRES,
  createThoughtDiscoveryService
} from "../src/modules/discovery/index.mjs";
import {
  ANNOTATION_KINDS,
  annotationTaskResult,
  createAnnotationService,
  sortAnnotationsByPosition
} from "../src/modules/annotations/index.mjs";
import { thoughtTaskResult } from "../src/modules/thoughts/index.mjs";
import { createAnnotationHttp, createDiscoveryHttp, openApiV1 } from "../src/http/index.mjs";
import {
  createThoughtDiscoveryController
} from "../public/frontend/features/thought-discovery/index.mjs";
import {
  backgroundResultFromSnapshot,
  createBackgroundResultController,
  mergeBackgroundTaskResult
} from "../public/frontend/features/background-results/index.mjs";
import {
  annotationMenuItems,
  annotationPresentation,
  commentSubmissionIntent,
  copyAnnotationContent,
  groupAnnotationLineCounts,
  submitAnnotationAssistantTask,
  sortAnnotationItemsByPosition
} from "../public/frontend/features/annotations/index.mjs";

const timestamp = value => `2026-09-29T${value}:00.000Z`;
const document = {
  thoughts: [
    {
      id: "shared-id",
      type: "question",
      content: "共同词：思绪原文",
      authorType: "user",
      origin: "manual",
      occurredAt: timestamp("10:00"),
      createdAt: timestamp("10:00"),
      version: 1,
      tags: ["思绪标签"],
      remarks: [],
      followUps: [],
      annotations: [],
      annotationDrift: []
    },
    {
      id: "thought-ai",
      type: "answer",
      relatedTo: "shared-id",
      content: "共同词：模型回答",
      modelDraft: "共同词：模型回答",
      authorType: "ai",
      origin: "deepseek",
      occurredAt: timestamp("10:01"),
      createdAt: timestamp("10:01"),
      version: 1,
      tags: []
    }
  ],
  captures: [{
    id: "shared-id",
    content: "共同词：捕念原文",
    occurredAt: timestamp("09:00"),
    createdAt: timestamp("09:00"),
    tags: ["捕念标签"]
  }],
  journals: [{
    id: "journal-1",
    title: "共同词日记",
    content: "用户写下的日记正文",
    occurredAt: timestamp("08:00"),
    createdAt: timestamp("08:00"),
    tags: ["日记标签"],
    reflections: [{
      id: "reflection-1",
      content: "共同词：AI 回望",
      authorType: "ai",
      origin: "deepseek",
      createdAt: timestamp("08:30"),
      reasoningContent: "不可检索的私有推理"
    }]
  }],
  books: [{
    id: "book-1",
    title: "共同词书名",
    author: "作者",
    createdAt: timestamp("07:00"),
    tags: ["阅读标签"],
    notes: [{
      id: "note-1",
      content: "共同词：用户书摘",
      authorType: "user",
      occurredAt: timestamp("07:30"),
      createdAt: timestamp("07:30"),
      tags: ["书摘标签"]
    }]
  }],
  quotes: [{
    id: "shared-id",
    source: "AI总结",
    content: "共同词：用户收藏的善言",
    occurredAt: timestamp("06:00"),
    createdAt: timestamp("06:00"),
    tags: ["善言标签"]
  }]
};
const repository = {
  async read() {
    return structuredClone(document);
  },
  async update(mutator) {
    return mutator(document);
  }
};
const discovery = createThoughtDiscoveryService({
  repository,
  now: () => timestamp("12:00"),
  random: () => 0
});

assert.deepEqual(DISCOVERY_GENRES, ["thought", "capture", "journal", "bookExcerpt", "quote"]);
const legacy = await discovery.search({ query: "共同词" });
assert.deepEqual(legacy.items.map(item => item.genre), ["thought"], "existing callers stay thought-only");

const crossGenre = await discovery.search({
  query: "共同词",
  genres: DISCOVERY_GENRES,
  limit: 10
});
assert.deepEqual(
  crossGenre.items.map(item => item.genre),
  ["thought", "capture", "journal", "bookExcerpt", "quote"]
);
assert.equal(new Set(crossGenre.items.map(item => item.key)).size, 5, "same IDs in different genres stay distinct");
assert.deepEqual(crossGenre.items.map(item => item.genreLabel), ["思绪", "捕念", "日记", "书摘", "善言"]);
assert.equal(
  crossGenre.items.find(item => item.genre === "quote").matches[0].sourceBoundary,
  "user_original",
  "a bibliographic source named AI总结 is still user-collected original content"
);
assert.equal(
  crossGenre.items.find(item => item.genre === "journal").matches.find(item => item.id === "reflection-1").sourceBoundary,
  "ai_derived"
);
assert.equal((await discovery.search({
  query: "不可检索的私有推理",
  genres: DISCOVERY_GENRES
})).total, 0);

const firstPage = await discovery.search({ query: "共同词", genres: DISCOVERY_GENRES, limit: 2 });
document.captures.unshift({
  id: "newer",
  content: "共同词：分页后插入",
  occurredAt: timestamp("11:00"),
  createdAt: timestamp("11:00"),
  tags: []
});
const secondPage = await discovery.search({
  query: "共同词",
  genres: DISCOVERY_GENRES,
  limit: 2,
  cursor: firstPage.nextCursor
});
assert.deepEqual(secondPage.items.map(item => item.key), ["journal:journal-1", "bookExcerpt:book-1"]);
assert.ok(secondPage.items.every(item => !firstPage.items.some(previous => previous.key === item.key)));
assert.deepEqual(await discovery.search({
  query: "共同词",
  genres: ["capture"],
  cursor: firstPage.nextCursor
}), { invalidCursor: true });

const discoveryResponses = [];
const discoveryHttp = createDiscoveryHttp({
  discovery,
  bodyJson: async request => request.input
});
assert.equal(await discoveryHttp.handleV1(
  { method: "GET" },
  {},
  new URL("http://local/api/v1/discovery?q=%E5%85%B1%E5%90%8C%E8%AF%8D&genre=capture&genre=quote"),
  {
    success: (response, status, data, options) => {
      discoveryResponses.push({ status, data, options });
      return true;
    },
    error: () => false
  }
), true);
assert.deepEqual(discoveryResponses[0].data.map(item => item.genre), ["capture", "capture", "quote"]);
assert.deepEqual(
  openApiV1.paths["/discovery"].get.parameters
    .find(parameter => parameter.name === "genre").schema.items,
  { $ref: "#/components/schemas/DiscoveryGenre" }
);
assert.deepEqual(
  openApiV1.components.schemas.DiscoveryGenre.enum,
  DISCOVERY_GENRES
);

const discoveryCalls = [];
const discoveryController = createThoughtDiscoveryController({
  transport: {
    search: async input => {
      discoveryCalls.push(input);
      return { items: [], nextCursor: "", total: 0, untracedCount: 0, totalUntracedCount: 0 };
    },
    markRead: async () => ({ missing: true }),
    snooze: async () => ({ missing: true }),
    openRandomDoor: async () => ({ value: null, total: 0 })
  }
});
await discoveryController.setGenres(["capture", "journal", "bookExcerpt", "quote"]);
assert.deepEqual(discoveryCalls[0].genres, ["capture", "journal", "bookExcerpt", "quote"]);

let sequence = 0;
const annotations = createAnnotationService({
  createId: () => `annotation-${++sequence}`,
  now: () => timestamp(`12:0${sequence}`)
});
assert.deepEqual(ANNOTATION_KINDS, ["comment", "highlight", "emphasis"]);
const root = { annotations: [] };
const source = "第一处引文；第二处引文；第三处引文";
const emphasisInput = annotations.creationInput({
  kind: "emphasis",
  targetKey: "content",
  quote: "第三处",
  start: source.indexOf("第三处"),
  end: source.indexOf("第三处") + 3
});
assert.equal(emphasisInput.value.kind, "emphasis");
const emphasis = annotations.create(root, source, emphasisInput.value).value;
assert.equal(annotations.reply(root, emphasis.id, "不可递归回复").missing, true);
const comment = annotations.create(root, source, annotations.creationInput({
  kind: "comment",
  targetKey: "content",
  quote: "第一处",
  text: "先保留评论",
  start: source.indexOf("第一处"),
  end: source.indexOf("第一处") + 3
}).value).value;
comment.replies.push({ id: "reply-1", text: "已有回复" });
assert.deepEqual(
  sortAnnotationsByPosition(root.annotations).map(item => item.id),
  [comment.id, emphasis.id],
  "annotations follow excerpt order instead of creation time"
);
assert.deepEqual(
  sortAnnotationItemsByPosition(root.annotations).map(item => item.id),
  [comment.id, emphasis.id]
);
const converted = annotations.convert(root, comment.id, { kind: "highlight" });
assert.equal(converted.value.id, comment.id);
assert.equal(converted.value.kind, "highlight");
assert.equal(converted.value.text, "先保留评论");
assert.equal(converted.value.replies[0].id, "reply-1");
assert.equal(annotations.convert(root, comment.id, { kind: "comment" }).value.text, "先保留评论");
const bareHighlight = annotations.create(root, source, annotations.creationInput({
  kind: "highlight",
  targetKey: "content",
  quote: "第二处",
  start: source.indexOf("第二处"),
  end: source.indexOf("第二处") + 3
}).value).value;
assert.equal(annotations.convert(root, bareHighlight.id, { kind: "comment" }).invalid, true);

const httpCalls = [];
const annotationHttp = createAnnotationHttp({
  commands: {
    convert: async (...args) => {
      httpCalls.push(args);
      return { value: { id: args[2], kind: args[3].kind } };
    }
  },
  backgroundAi: {},
  sendTaskCreation() {},
  bodyJson: async request => request.input,
  sendJson: (response, status, body) => Object.assign(response, { status, body }),
  sendTrashResult() {}
});
const conversionResponse = {};
assert.equal(await annotationHttp(
  { method: "PATCH", input: { kind: "emphasis" } },
  conversionResponse,
  { pathname: "/api/annotations/thought/root/annotation-1/convert" }
), true);
assert.equal(conversionResponse.status, 200);
assert.deepEqual(httpCalls[0], ["thought", "root", "annotation-1", { kind: "emphasis" }]);

const originalSnapshot = {
  thoughts: [{
    id: "root-1",
    type: "question",
    content: "原问题",
    tags: ["必须保留"],
    followUps: [{ id: "follow-1", question: "追问", answer: "", localFlag: "keep" }],
    annotations: []
  }],
  captures: [{
    id: "capture-1",
    content: "捕念",
    attachmentPaths: ["/attachments/capture.png"],
    imageUnderstandings: [],
    version: 2,
    annotations: [{ id: "mark-1", kind: "emphasis", quote: "捕念", shenji: [] }]
  }],
  unrelated: { keep: true }
};
const answerTask = {
  id: "task-answer",
  kind: "thoughtAnswer",
  resourceType: "thought",
  targetId: "root-1",
  resultId: "answer-1",
  status: "succeeded"
};
assert.deepEqual(thoughtTaskResult([
  originalSnapshot.thoughts[0],
  {
    id: "answer-1",
    type: "answer",
    relatedTo: "root-1",
    content: "后台回答",
    sourceTaskId: "task-answer"
  }
], answerTask), {
  id: "answer-1",
  type: "answer",
  relatedTo: "root-1",
  content: "后台回答",
  sourceTaskId: "task-answer"
});
let merged = mergeBackgroundTaskResult(originalSnapshot, answerTask, {
  id: "answer-1",
  type: "answer",
  relatedTo: "root-1",
  content: "后台回答",
  authorType: "ai",
  sourceTaskId: "task-answer"
});
assert.equal(merged.changed, true);
assert.deepEqual(merged.value.thoughts.find(item => item.id === "root-1").tags, ["必须保留"]);
assert.equal(merged.value.unrelated, originalSnapshot.unrelated);
assert.equal(merged.value.thoughts.filter(item => item.id === "answer-1").length, 1);
assert.equal(backgroundResultFromSnapshot(merged.value, answerTask).content, "后台回答");
merged = mergeBackgroundTaskResult(merged.value, answerTask, {
  id: "answer-1",
  type: "answer",
  relatedTo: "root-1",
  content: "后台回答",
  authorType: "ai",
  sourceTaskId: "task-answer"
});
assert.equal(merged.value.thoughts.filter(item => item.id === "answer-1").length, 1);

const followUpTask = {
  id: "task-follow",
  kind: "followUpAnswer",
  resourceType: "thought",
  targetId: "root-1",
  subtargetId: "follow-1",
  resultId: "follow-1",
  status: "succeeded"
};
merged = mergeBackgroundTaskResult(merged.value, followUpTask, {
  id: "follow-1",
  answer: "后台追问回答",
  sourceTaskId: "task-follow"
});
const mergedFollowUp = merged.value.thoughts.find(item => item.id === "root-1").followUps[0];
assert.equal(mergedFollowUp.answer, "后台追问回答");
assert.equal(mergedFollowUp.localFlag, "keep");
assert.equal(backgroundResultFromSnapshot(merged.value, followUpTask).answer, "后台追问回答");

const annotationTask = {
  id: "task-annotation",
  kind: "annotationShenji",
  resourceType: "capture",
  targetId: "capture-1",
  subtargetId: "mark-1",
  resultId: "exchange-1",
  status: "succeeded"
};
assert.deepEqual(annotationTaskResult(originalSnapshot.captures[0], annotationTask), null);
assert.deepEqual(annotationTaskResult({
  annotations: [{
    id: "mark-1",
    shenji: [{ id: "exchange-1", answer: "批注后台回答", sourceTaskId: "task-annotation" }]
  }]
}, annotationTask), {
  id: "exchange-1",
  answer: "批注后台回答",
  sourceTaskId: "task-annotation"
});
merged = mergeBackgroundTaskResult(merged.value, annotationTask, {
  id: "exchange-1",
  answer: "批注后台回答",
  sourceTaskId: "task-annotation"
});
assert.equal(merged.value.captures[0].annotations[0].shenji[0].answer, "批注后台回答");
assert.equal(backgroundResultFromSnapshot(merged.value, annotationTask).answer, "批注后台回答");

const contentImageTask = {
  id: "task-content-image",
  kind: "contentImageUnderstanding",
  resourceType: "capture",
  targetId: "capture-1",
  subtargetId: "",
  contentTargetType: "capture",
  contentTargetId: "capture-1",
  resultId: "understanding-1",
  status: "succeeded"
};
merged = mergeBackgroundTaskResult(merged.value, contentImageTask, {
  id: "understanding-1",
  kind: "imageUnderstanding",
  content: "图片中有一页手写笔记。",
  sourceAttachmentPaths: ["/attachments/capture.png"],
  sourceVersion: 2,
  sourceTaskId: "task-content-image"
});
assert.equal(merged.changed, true);
assert.equal(merged.value.captures[0].version, 3);
assert.equal(merged.value.captures[0].content, "捕念");
assert.equal(merged.value.captures[0].imageUnderstandings[0].content, "图片中有一页手写笔记。");
assert.equal(backgroundResultFromSnapshot(merged.value, contentImageTask).sourceTaskId, "task-content-image");

const lifecycle = [];
let releaseOld;
const oldResult = new Promise(resolve => {
  releaseOld = resolve;
});
const controller = createBackgroundResultController({
  loadResult: task => {
    lifecycle.push(`load:${task.id}`);
    return task.id === "old-task" ? oldResult : Promise.resolve({ id: task.resultId });
  },
  captureViewState: target => {
    lifecycle.push(`capture:${target.kind}`);
    return { expanded: ["root-1", "follow-1"], scrollTop: 420 };
  },
  applyResult: ({ task, result }) => {
    lifecycle.push(`apply:${task.id}:${result.id}`);
  },
  restoreViewState: view => {
    lifecycle.push(`restore:${view.scrollTop}`);
  }
});
assert.equal(await controller.sync([answerTask]), true);
assert.deepEqual(lifecycle, [
  "load:task-answer",
  "capture:thoughtAnswer",
  "apply:task-answer:answer-1",
  "restore:420"
]);
assert.equal(await controller.sync([answerTask]), false, "a completed result is applied once");
const staleSync = controller.sync([{ ...answerTask, id: "old-task", resultId: "old-result" }]);
controller.reset();
releaseOld({ id: "old-result" });
assert.equal(await staleSync, false, "late results after reset are ignored");
assert.ok(!lifecycle.includes("apply:old-task:old-result"));

assert.deepEqual(annotationPresentation({ kind: "highlight" }), {
  kind: "highlight",
  label: "绿色划线",
  tone: "green",
  className: "highlight-anchor"
});
assert.equal(annotationPresentation({ kind: "emphasis" }).tone, "red");
assert.deepEqual(
  annotationMenuItems({ kind: "comment", text: "评论", quote: "引文" }).map(item => item.id),
  ["copy-quote", "copy-comment", "to-highlight", "to-emphasis", "delete"]
);
let copied = "";
assert.equal(await copyAnnotationContent({ quote: "引文" }, "quote", value => {
  copied = value;
}), true);
assert.equal(copied, "引文");
assert.deepEqual(commentSubmissionIntent("普通评论"), {
  text: "普通评论",
  asksAssistant: false,
  message: ""
});
assert.deepEqual(commentSubmissionIntent("  @神鸡：请核对反例  "), {
  text: "@神鸡：请核对反例",
  asksAssistant: true,
  message: "请核对反例"
});
const assistantSubmissionEvents = [];
const notificationRefreshFailure = new Error("notification refresh failed");
const submittedAssistant = await submitAnnotationAssistantTask({
  createRequestId: () => "assistant-request-1",
  persistDraft: async requestId => assistantSubmissionEvents.push(`persist:${requestId}`),
  submitTask: async requestId => {
    assistantSubmissionEvents.push(`post:${requestId}`);
    return { id: "task-1" };
  },
  refreshNotifications: async () => {
    assistantSubmissionEvents.push("refresh");
    throw notificationRefreshFailure;
  },
  scheduleNotificationPoll: () => assistantSubmissionEvents.push("schedule")
});
assert.deepEqual(assistantSubmissionEvents, [
  "persist:assistant-request-1",
  "post:assistant-request-1",
  "refresh",
  "schedule"
]);
assert.equal(submittedAssistant.task.id, "task-1");
assert.equal(submittedAssistant.clientRequestId, "assistant-request-1");
assert.equal(submittedAssistant.notificationRefreshError, notificationRefreshFailure);

let persistedAssistantRequestId = "";
await assert.rejects(submitAnnotationAssistantTask({
  createRequestId: () => "assistant-request-retry",
  persistDraft: async requestId => { persistedAssistantRequestId = requestId; },
  submitTask: async requestId => {
    assert.equal(requestId, "assistant-request-retry");
    throw new Error("task post failed");
  }
}), /task post failed/);
assert.equal(persistedAssistantRequestId, "assistant-request-retry");
const retriedAssistant = await submitAnnotationAssistantTask({
  clientRequestId: persistedAssistantRequestId,
  createRequestId: () => { throw new Error("retry must reuse the persisted request id"); },
  persistDraft: async requestId => { persistedAssistantRequestId = requestId; },
  submitTask: async requestId => ({ id: "task-retried", clientRequestId: requestId })
});
assert.equal(retriedAssistant.task.clientRequestId, "assistant-request-retry");
assert.deepEqual(groupAnnotationLineCounts([
  { hostKey: "content", annotationId: "comment-a", rects: [{ top: 100, left: 20, height: 20 }, { top: 122, left: 20, height: 20 }] },
  { hostKey: "content", annotationId: "comment-b", rects: [{ top: 102, left: 90, height: 20 }] },
  { hostKey: "content", annotationId: "comment-c", rects: [{ top: 145, left: 20, height: 20 }] },
  { hostKey: "other", annotationId: "comment-d", rects: [{ top: 101, left: 20, height: 20 }] }
]), [
  { hostKey: "content", top: 100, count: 2, annotationIds: ["comment-a", "comment-b"] },
  { hostKey: "content", top: 145, count: 1, annotationIds: ["comment-c"] },
  { hostKey: "other", top: 101, count: 1, annotationIds: ["comment-d"] }
]);

console.log("G2 A R2 regression passed: cross-genre discovery, stable cursors, incremental task results, annotation styles/conversion/order/copy/mentions/line counts.");
