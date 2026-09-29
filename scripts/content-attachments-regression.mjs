import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import "./prompt-test-setup.mjs";
import {
  CONTENT_ATTACHMENT_MAX_IMAGES,
  CONTENT_ATTACHMENT_TARGET_TYPES,
  CONTENT_ATTACHMENT_TRASH_TYPE,
  contentOriginalPayload,
  createContentAttachmentService
} from "../src/modules/content-attachments/index.mjs";
import { createTrashService } from "../src/modules/trash/index.mjs";
import { createTaskLifecycle, publicAiTask } from "../src/modules/tasks/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { collectAttachmentPaths } from "../src/shared/attachments/index.mjs";
import { mapStoreObjects, rebuildStoreObjects } from "../src/shared/persistence/index.mjs";
import { buildExportManifest } from "../src/modules/exports/index.mjs";
import { createAiTaskTargets, createBackgroundAi } from "../src/app/index.mjs";
import {
  createContentAttachmentsHttp,
  contentAttachmentComponents,
  contentAttachmentPaths,
  openApiV1
} from "../src/http/index.mjs";
import {
  imageRecordPayload,
  imageUnderstandingPayload
} from "../public/frontend/media/index.mjs";

const PATHS = {
  a1: "/attachments/account-a-1.png",
  a2: "/attachments/account-a-2.webp",
  a3: "/attachments/account-a-3.jpg",
  b1: "/attachments/account-b-1.png"
};
const now = () => "2026-09-29T12:34:56.000Z";
const AFTER_COMMIT = Symbol.for("for-now.after-commit");
let sequence = 0;
const createId = () => `content-attachment-${++sequence}`;
const hash = value => `hash:${value}`;
const context = new AsyncLocalStorage();
const accountId = () => context.getStore()?.accountId || "";

const documents = new Map([
  ["account-a", {
    version: 15,
    captures: [
      {
        id: "capture-image-only",
        content: "",
        attachmentPaths: [PATHS.a1],
        annotations: [],
        annotationDrift: [],
        version: 1
      },
      {
        id: "capture-text",
        content: "用户写下的原文",
        attachmentPaths: [],
        annotations: [{
          id: "comment-image-only",
          kind: "comment",
          targetKey: "content",
          quote: "原文",
          text: "",
          attachmentPaths: [PATHS.a2],
          replies: [],
          version: 1
        }],
        annotationDrift: [],
        version: 1
      }
    ],
    thoughts: [
      {
        id: "thought-root",
        type: "question",
        content: "思绪根原文",
        attachmentPaths: [PATHS.a1],
        relatedTo: null,
        annotations: [],
        annotationDrift: [],
        version: 1
      },
      {
        id: "thought-block",
        type: "record",
        content: "",
        attachmentPaths: [PATHS.a2],
        relatedTo: "thought-root",
        version: 1
      }
    ],
    trash: [],
    attachmentCleanup: [],
    aiTasks: [],
    notifications: []
  }],
  ["account-b", {
    version: 15,
    captures: [{
      id: "private-b",
      content: "账户 B 的私有原文",
      attachmentPaths: [PATHS.b1],
      annotations: [],
      annotationDrift: [],
      version: 1
    }],
    thoughts: [],
    trash: [],
    attachmentCleanup: [],
    aiTasks: [],
    notifications: []
  }]
]);

const inventories = new Map([
  ["account-a", [
    { path: PATHS.a1, bytes: 101, sha256: "a".repeat(64), state: "verified" },
    { path: PATHS.a2, bytes: 202, sha256: "b".repeat(64), state: "verified" },
    { path: PATHS.a3, bytes: 303, sha256: "c".repeat(64), state: "verified" }
  ]],
  ["account-b", [
    { path: PATHS.b1, bytes: 404, sha256: "d".repeat(64), state: "verified" }
  ]]
]);

let failNextCommit = false;
const repository = {
  async read() {
    return structuredClone(documents.get(accountId()));
  },
  async update(mutator) {
    const id = accountId();
    const document = structuredClone(documents.get(id));
    const result = await mutator(document);
    if (failNextCommit) {
      failNextCommit = false;
      throw new Error("injected commit failure");
    }
    documents.set(id, document);
    await result?.[AFTER_COMMIT]?.();
    return structuredClone(result);
  }
};

const trash = createTrashService({ createId, now, hash, retentionDays: 30 });
const understandingRequests = [];
const cancelledTasks = [];
const service = createContentAttachmentService({
  repository,
  trash,
  attachmentInventory: async () => structuredClone(inventories.get(accountId()) || []),
  getAccountId: accountId,
  cancelTask: taskId => cancelledTasks.push(taskId),
  requestImageUnderstanding: async work => {
    understandingRequests.push(structuredClone(work));
    return { taskId: `image-task-${understandingRequests.length}`, status: "queued" };
  },
  now,
  createId
});

assert.deepEqual(CONTENT_ATTACHMENT_TARGET_TYPES, [
  "comment",
  "capture",
  "thoughtRoot",
  "thoughtBlock"
]);
assert.equal(CONTENT_ATTACHMENT_MAX_IMAGES, 2);
assert.deepEqual(
  contentOriginalPayload("capture", { content: "", attachmentPaths: [PATHS.a1] }).value,
  { content: "", attachmentPaths: [PATHS.a1] }
);
assert.deepEqual(
  contentOriginalPayload("comment", { text: "", attachmentPaths: [PATHS.a2] }).value,
  { text: "", attachmentPaths: [PATHS.a2] }
);
assert.equal(contentOriginalPayload("thoughtBlock", { content: "", attachmentPaths: [] }).code, "CONTENT_OR_IMAGE_REQUIRED");
assert.equal(contentOriginalPayload("capture", {
  content: "too many",
  attachmentPaths: [PATHS.a1, PATHS.a2, PATHS.a3]
}).code, "TOO_MANY_IMAGES");
assert.equal(contentOriginalPayload("capture", {
  content: "unsafe",
  attachmentPaths: ["/attachments/../secret.png"]
}).code, "INVALID_ATTACHMENT_PATH");
assert.deepEqual(
  imageRecordPayload({ content: "", attachmentPaths: [PATHS.a1] }),
  { content: "", attachmentPaths: [PATHS.a1] },
  "backend creation validation must remain compatible with the frozen frontend media helper"
);
assert.deepEqual(imageUnderstandingPayload({
  attachmentPaths: [PATHS.a1],
  targetType: "capture",
  targetId: "capture-image-only",
  inputVersion: 1
}), {
  attachmentPaths: [PATHS.a1],
  targetType: "capture",
  targetId: "capture-image-only",
  inputVersion: 1
});

await context.run({ accountId: "account-a" }, async () => {
  assert.deepEqual((await service.prepareOriginalContent("thoughtRoot", {
    content: "",
    attachmentPaths: [PATHS.a1]
  })).value, {
    content: "",
    attachmentPaths: [PATHS.a1]
  });
  assert.deepEqual((await service.prepareOriginalContent("capture", {
    content: "仅文字也合法",
    attachmentPaths: []
  })).value, {
    content: "仅文字也合法",
    attachmentPaths: []
  });
  assert.equal((await service.prepareOriginalContent("capture", {
    content: "",
    attachmentPaths: [PATHS.b1]
  })).forbidden, true);

  const imageOnly = await service.get("capture", "capture-image-only");
  assert.equal(imageOnly.value.originalImages[0].state, "verified");
  assert.equal(imageOnly.value.originalImages[0].bytes, 101);

  const comment = await service.get("comment", "comment-image-only");
  assert.equal(comment.value.originalImages[0].path, PATHS.a2);
  const expandedComment = await service.replaceOriginalImages(
    "comment",
    "comment-image-only",
    [PATHS.a2, PATHS.a3],
    { expectedVersion: 1 }
  );
  assert.equal(expandedComment.value.version, 2);
  assert.deepEqual(expandedComment.value.originalImages.map(item => item.path), [PATHS.a2, PATHS.a3]);
  assert.equal(documents.get("account-a").captures.find(item => item.id === "capture-text").content, "用户写下的原文");
  assert.equal(documents.get("account-a").captures.find(item => item.id === "capture-text").version, 2);

  const rootUpdate = await service.replaceOriginalImages(
    "thoughtRoot",
    "thought-root",
    [PATHS.a1, PATHS.a3],
    { expectedVersion: 1 }
  );
  assert.equal(rootUpdate.value.version, 2);
  const blockUpdate = await service.replaceOriginalImages(
    "thoughtBlock",
    "thought-block",
    [PATHS.a2, PATHS.a3],
    { expectedVersion: 1 }
  );
  assert.equal(blockUpdate.value.version, 2);
  assert.equal(documents.get("account-a").thoughts.find(item => item.id === "thought-root").version, 3);

  const prepared = await service.requestUnderstanding({
    targetType: "thoughtBlock",
    targetId: "thought-block",
    attachmentPaths: [PATHS.a2, PATHS.a3],
    inputVersion: 2
  }, { clientRequestId: "understand-1" });
  assert.deepEqual(prepared.value, { taskId: "image-task-1", status: "queued" });
  assert.deepEqual(understandingRequests[0], {
    accountId: "account-a",
    targetType: "thoughtBlock",
    targetId: "thought-block",
    inputVersion: 2,
    attachmentPaths: [PATHS.a2, PATHS.a3],
    originalText: "",
    taskResourceType: "thought",
    taskTargetId: "thought-block",
    taskSubtargetId: "",
    clientRequestId: "understand-1"
  });

  const saved = await service.saveUnderstanding({
    targetType: "thoughtBlock",
    targetId: "thought-block",
    inputVersion: 2,
    attachmentPaths: [PATHS.a2, PATHS.a3],
    content: "图片中是一张手写计划，日期为 9 月 29 日。",
    model: "vision-test",
    sourceTaskId: "image-task-1",
    clientRequestId: "understand-1"
  });
  assert.equal(saved.value.origin, "ai-derived");
  assert.equal(saved.value.sourceVersion, 2);
  assert.deepEqual(saved.value.sourceAttachmentPaths, [PATHS.a2, PATHS.a3]);
  const blockAfterUnderstanding = documents.get("account-a").thoughts.find(item => item.id === "thought-block");
  assert.equal(blockAfterUnderstanding.content, "", "derived understanding must not overwrite the image-only user original");
  assert.equal(blockAfterUnderstanding.version, 3);
  assert.equal(blockAfterUnderstanding.imageUnderstandings[0].content, saved.value.content);

  const duplicate = await service.saveUnderstanding({
    targetType: "thoughtBlock",
    targetId: "thought-block",
    inputVersion: 2,
    attachmentPaths: [PATHS.a2, PATHS.a3],
    content: "重复回调不应新增内容",
    sourceTaskId: "image-task-1",
    clientRequestId: "understand-1"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(blockAfterUnderstanding.imageUnderstandings.length, 1);

  const stale = await service.saveUnderstanding({
    targetType: "thoughtBlock",
    targetId: "thought-block",
    inputVersion: 2,
    attachmentPaths: [PATHS.a2],
    content: "迟到结果",
    sourceTaskId: "image-task-stale"
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.currentVersion, 3);
  assert.equal((await service.saveUnderstanding({
    targetType: "thoughtBlock",
    targetId: "thought-block",
    inputVersion: 3,
    attachmentPaths: [PATHS.a2],
    content: "缺少来源标识"
  })).code, "IMAGE_UNDERSTANDING_SOURCE_REQUIRED");

  const foreign = await service.replaceOriginalImages(
    "capture",
    "capture-text",
    [PATHS.b1],
    { expectedVersion: 2 }
  );
  assert.equal(foreign.forbidden, true);
  assert.deepEqual(documents.get("account-a").captures.find(item => item.id === "capture-text").attachmentPaths, []);

  const exportedWithUnderstanding = buildExportManifest({
    accountId: "account-a",
    store: await repository.read(),
    inventory: inventories.get("account-a")
  });
  const blockResource = exportedWithUnderstanding.resources.find(item => item.id === "thought-block");
  assert.ok(blockResource, "an image-only thought block must remain in the account export");
  assert.equal(blockResource.body.some(item => (
    item.fieldPath === "imageUnderstandings[0].content"
    && item.value === saved.value.content
  )), true);
  assert.deepEqual(
    blockResource.attachmentReferences.map(item => item.path),
    [PATHS.a2, PATHS.a3]
  );
  assert.ok(exportedWithUnderstanding.attachmentReferences.some(item => (
    item.fieldPath === "annotations[0].attachmentPaths[0]"
    && item.path === PATHS.a2
  )), "comment originals must be traceable through the parent export resource");
  const mapped = mapStoreObjects("account-a", await repository.read());
  assert.equal(mapped.attachmentRefs.every(item => item.accountId === "account-a"), true);
  assert.ok(mapped.attachmentRefs.some(item => item.path === PATHS.a3));
  const rebuilt = rebuildStoreObjects(mapped);
  assert.equal(
    rebuilt.thoughts.find(item => item.id === "thought-block").imageUnderstandings[0].content,
    saved.value.content,
    "generic PostgreSQL mapping must preserve derived image understanding"
  );
  await repository.update(store => {
    store.aiTasks.push(
      {
        id: "queued-image-task",
        kind: "contentImageUnderstanding",
        resourceType: "thought",
        targetId: "thought-block",
        status: "queued",
        payload: { targetType: "thoughtBlock", targetId: "thought-block", attachmentPaths: [PATHS.a2] }
      },
      {
        id: "running-image-task",
        kind: "contentImageUnderstanding",
        resourceType: "thought",
        targetId: "thought-block",
        status: "running",
        payload: { targetType: "thoughtBlock", targetId: "thought-block", attachmentPaths: [PATHS.a2] }
      }
    );
    store.notifications.push(
      { id: "queued-notification", taskId: "queued-image-task", status: "queued" },
      { id: "running-notification", taskId: "running-image-task", status: "running" }
    );
  });

  const removed = await service.removeOriginalImage(
    "thoughtBlock",
    "thought-block",
    PATHS.a2,
    { expectedVersion: 3 }
  );
  assert.ok(removed.trashId);
  assert.equal(removed.value.version, 4);
  const afterRemoval = await repository.read();
  const attachmentTrash = afterRemoval.trash.find(item => item.id === removed.trashId);
  assert.equal(attachmentTrash.type, CONTENT_ATTACHMENT_TRASH_TYPE);
  assert.deepEqual(attachmentTrash.payload.attachmentPaths, [PATHS.a2]);
  assert.equal(attachmentTrash.payload.imageUnderstandings[0].id, saved.value.id);
  assert.equal(afterRemoval.thoughts.find(item => item.id === "thought-block").imageUnderstandings.length, 0);
  assert.equal(afterRemoval.aiTasks.find(item => item.id === "queued-image-task").status, "cancelled");
  assert.equal(afterRemoval.aiTasks.find(item => item.id === "running-image-task").status, "cancelling");
  assert.deepEqual(cancelledTasks, ["running-image-task"]);
  assert.ok(collectAttachmentPaths(afterRemoval).has(PATHS.a2), "trash payload must retain the attachment cleanup reference");

  const exportWhileDeleted = buildExportManifest({
    accountId: "account-a",
    store: afterRemoval,
    inventory: inventories.get("account-a")
  });
  assert.ok(exportWhileDeleted.attachmentReferences.some(item => (
    item.resourceType === "trash" && item.path === PATHS.a2
  )), "a deleted image reference must remain visible to export and inventory reconciliation");

  const restored = await service.restoreOriginalImages(removed.trashId, { expectedVersion: 4 });
  assert.equal(restored.value.version, 5);
  assert.deepEqual(restored.value.originalImages.map(item => item.path), [PATHS.a3, PATHS.a2]);
  assert.equal(restored.value.imageUnderstandings[0].id, saved.value.id);
  assert.equal((await repository.read()).trash.length, 0);

  const blockedLastImageRemoval = await service.removeOriginalImage(
    "capture",
    "capture-image-only",
    PATHS.a1,
    { expectedVersion: 1 }
  );
  assert.equal(blockedLastImageRemoval.code, "CONTENT_OR_IMAGE_REQUIRED");
  assert.deepEqual(
    documents.get("account-a").captures.find(item => item.id === "capture-image-only").attachmentPaths,
    [PATHS.a1]
  );

  const wrongVersion = await service.replaceOriginalImages(
    "thoughtRoot",
    "thought-root",
    [PATHS.a1],
    { expectedVersion: 1 }
  );
  assert.equal(wrongVersion.versionConflict, true);
  assert.equal(wrongVersion.currentVersion, 6);

  await repository.update(store => {
    store.captures.push({
      id: "commit-failure-target",
      content: "仍有文字",
      attachmentPaths: [PATHS.a1],
      annotations: [],
      annotationDrift: [],
      version: 1
    });
    store.aiTasks.push({
      id: "commit-failure-task",
      kind: "contentImageUnderstanding",
      resourceType: "capture",
      targetId: "commit-failure-target",
      status: "running",
      payload: {
        targetType: "capture",
        targetId: "commit-failure-target",
        attachmentPaths: [PATHS.a1]
      }
    });
  });
  const cancelledBeforeFailure = [...cancelledTasks];
  failNextCommit = true;
  await assert.rejects(
    service.removeOriginalImage("capture", "commit-failure-target", PATHS.a1, { expectedVersion: 1 }),
    /injected commit failure/
  );
  assert.deepEqual(cancelledTasks, cancelledBeforeFailure, "a failed commit must not abort the provider call");
  const afterFailedCommit = await repository.read();
  assert.deepEqual(
    afterFailedCommit.captures.find(item => item.id === "commit-failure-target").attachmentPaths,
    [PATHS.a1]
  );
  assert.equal(afterFailedCommit.aiTasks.find(item => item.id === "commit-failure-task").status, "running");
});

await context.run({ accountId: "account-a" }, async () => {
  assert.equal((await service.get("capture", "private-b")).missing, true);
});
let accountBTrashId;
await context.run({ accountId: "account-b" }, async () => {
  const privateRecord = await service.get("capture", "private-b");
  assert.equal(privateRecord.value.originalImages[0].path, PATHS.b1);
  assert.equal((await service.get("capture", "capture-image-only")).missing, true);
  const removed = await service.removeOriginalImage("capture", "private-b", PATHS.b1, {
    expectedVersion: 1
  });
  accountBTrashId = removed.trashId;
  assert.ok(accountBTrashId);
});
await context.run({ accountId: "account-a" }, async () => {
  assert.equal((await service.restoreOriginalImages(accountBTrashId, { expectedVersion: 2 })).missing, true);
});
await context.run({ accountId: "account-b" }, async () => {
  assert.equal((await service.restoreOriginalImages(accountBTrashId, { expectedVersion: 2 })).value.version, 3);
});
await context.run({ accountId: "account-a" }, async () => {
  const taskService = createContentAttachmentService({
    repository,
    trash,
    attachmentInventory: async () => structuredClone(inventories.get(accountId()) || []),
    getAccountId: accountId,
    now,
    createId
  });
  const scheduled = [], generated = [];
  const background = createBackgroundAi({
    repository,
    tasks: createTaskLifecycle({ createId, now, hash }),
    notifications: createNotificationService({ createId, now }),
    targets: createAiTaskTargets({
      thoughts: null,
      annotations: null,
      contentAttachments: taskService,
      hash
    }),
    generate: async work => {
      generated.push(structuredClone(work));
      return { content: "图片中是一份可核对的计划。", reasoningContent: "", model: "vision-test" };
    },
    dispatch: callback => scheduled.push(callback),
    contextKey: accountId,
    onError: error => { throw error; }
  });
  const input = {
    kind: "contentImageUnderstanding",
    resourceType: "thought",
    targetId: "thought-root",
    inputVersion: 6,
    payload: {
      targetType: "thoughtRoot",
      targetId: "thought-root",
      attachmentPaths: [PATHS.a1, PATHS.a3]
    },
    clientRequestId: "background-image-understanding"
  };
  const queued = await background.enqueue(input);
  assert.equal(queued.task.status, "queued");
  assert.deepEqual(publicAiTask(queued.task), {
    id: queued.task.id,
    kind: "contentImageUnderstanding",
    resourceType: "thought",
    targetId: "thought-root",
    subtargetId: "",
    inputVersion: 6,
    subtargetVersion: 0,
    status: "queued",
    createdAt: now(),
    startedAt: "",
    completedAt: "",
    resultId: "",
    error: "",
    retryOf: "",
    contentTargetType: "thoughtRoot",
    contentTargetId: "thought-root"
  });
  assert.equal((await background.enqueue(input)).duplicate, true);
  assert.equal(scheduled.length, 1);
  await background.run(queued.task.id);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].scene, "contentImageUnderstanding");
  assert.deepEqual(generated[0].attachmentPaths, [PATHS.a1, PATHS.a3]);
  assert.match(generated[0].prompt, /思绪问题/);
  const completed = await background.getResult(queued.task.id);
  assert.equal(completed.task.status, "succeeded");
  assert.equal(completed.result.content, "图片中是一份可核对的计划。");
  assert.equal(completed.result.sourceTaskId, queued.task.id);
  assert.equal(documents.get("account-a").thoughts.find(item => item.id === "thought-root").content, "思绪根原文");
});
await assert.rejects(
  service.get("capture", "capture-image-only"),
  error => error?.code === "AUTH_REQUIRED"
);

function v1Adapter(req, response) {
  return {
    success(_res, status, data, options = {}) {
      response.status = status;
      response.data = data;
      response.options = options;
      if (options.etag) response.headers.etag = options.etag;
    },
    error(_res, status, message, code, details) {
      response.status = status;
      response.error = { message, code, details };
    },
    versionEtag(version) {
      return `"${version}"`;
    },
    expectedVersion() {
      const match = String(req.headers?.["if-match"] || "").match(/^"([1-9]\d*)"$/);
      if (!match) throw new Error("missing test If-Match");
      return Number(match[1]);
    },
    idempotencyKey() {
      const value = String(req.headers?.["idempotency-key"] || "");
      if (!value) throw new Error("missing test Idempotency-Key");
      return value;
    }
  };
}

const contentAttachmentHttp = createContentAttachmentsHttp({
  contentAttachments: service,
  bodyJson: async req => req.body
});
async function httpRequest(account, pathname, { method = "GET", body, headers = {} } = {}) {
  const req = { method, body, headers };
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    }
  };
  const handled = await context.run({ accountId: account }, () => contentAttachmentHttp.handleV1(
    req,
    response,
    new URL(`http://local${pathname}`),
    v1Adapter(req, response)
  ));
  return { handled, response };
}

let result = await httpRequest("account-a", "/api/v1/content-attachments/capture/capture-text");
assert.equal(result.response.status, 200);
assert.equal(result.response.headers.etag, "\"2\"");

result = await httpRequest("account-a", "/api/v1/content-attachments/capture/capture-text", {
  method: "PUT",
  headers: { "if-match": "\"2\"" },
  body: { attachmentPaths: [PATHS.a1] }
});
assert.equal(result.response.status, 200);
assert.equal(result.response.headers.etag, "\"3\"");

result = await httpRequest("account-a", "/api/v1/content-attachments/capture/capture-text/originals/account-a-1.png", {
  method: "DELETE",
  headers: { "if-match": "\"3\"" }
});
assert.equal(result.response.status, 200);
assert.equal(result.response.headers.etag, "\"4\"");
const httpTrashId = result.response.options.meta.trashId;

result = await httpRequest("account-a", `/api/v1/content-attachments/trash/${httpTrashId}/restore`, {
  method: "POST",
  headers: { "if-match": "\"4\"" }
});
assert.equal(result.response.status, 200);
assert.equal(result.response.headers.etag, "\"5\"");

result = await httpRequest("account-a", "/api/v1/content-attachments/understandings", {
  method: "POST",
  headers: { "idempotency-key": "http-understanding-1" },
  body: {
    targetType: "capture",
    targetId: "capture-text",
    attachmentPaths: [PATHS.a1],
    inputVersion: 5
  }
});
assert.equal(result.response.status, 202);
assert.equal(result.response.data.status, "queued");
assert.equal(understandingRequests.at(-1).clientRequestId, "http-understanding-1");

result = await httpRequest("account-a", "/api/v1/content-attachments/capture/missing");
assert.equal(result.response.status, 404);
assert.equal(result.response.error.code, "CONTENT_ATTACHMENT_TARGET_NOT_FOUND");
result = await httpRequest("account-a", "/api/v1/not-content-attachments");
assert.equal(result.handled, false);

assert.ok(contentAttachmentPaths["/content-attachments/{targetType}/{targetId}"].put);
assert.ok(contentAttachmentPaths["/content-attachments/{targetType}/{targetId}/originals/{name}"].delete);
assert.ok(contentAttachmentPaths["/content-attachments/trash/{trashId}/restore"].post);
assert.ok(contentAttachmentPaths["/content-attachments/understandings"].post);
assert.deepEqual(
  contentAttachmentComponents.schemas.ContentAttachmentTargetType.enum,
  CONTENT_ATTACHMENT_TARGET_TYPES
);
assert.equal(
  contentAttachmentComponents.schemas.ContentAttachmentReplaceInput
    .properties.attachmentPaths.maxItems,
  CONTENT_ATTACHMENT_MAX_IMAGES
);
const mergedOpenApi = structuredClone(openApiV1);
Object.assign(mergedOpenApi.paths, contentAttachmentPaths);
Object.assign(mergedOpenApi.components.parameters, contentAttachmentComponents.parameters);
Object.assign(mergedOpenApi.components.schemas, contentAttachmentComponents.schemas);
const openApiRefs = JSON.stringify(mergedOpenApi).match(/#\/components\/(?:parameters|responses|schemas)\/[A-Za-z0-9]+/g) || [];
for (const reference of openApiRefs) {
  const [, , group, name] = reference.split("/");
  assert.ok(mergedOpenApi.components[group]?.[name], `unresolved OpenAPI reference: ${reference}`);
}

for (const file of [
  "../src/modules/content-attachments/schema.mjs",
  "../src/modules/content-attachments/service.mjs"
]) {
  const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:fetch|process\.env|node:fs|node:http)\b/);
}

console.log("Content attachment checks passed: image-only originals, all four target types, account inventory isolation, ETag updates, trash/restore, export tracking and non-destructive derived understanding.");
