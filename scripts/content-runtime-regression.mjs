import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createContentRuntime,
  createEmptyStore
} from "../src/app/index.mjs";

const clone = value => structuredClone(value);
const now = () => "2026-10-06T12:00:00.000Z";
const today = () => "2026-10-06";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const scope = new AsyncLocalStorage();
const accountId = () => scope.getStore() || "account-a";
const stores = new Map([
  ["account-a", createEmptyStore()],
  ["account-b", createEmptyStore()]
]);
const ledgers = new Map();
const scheduled = [];
const logs = [];
const debugEvents = [];
const inventory = new Map([
  ["account-a", [{
    path: "/attachments/account-a.png",
    state: "verified",
    bytes: 100,
    sha256: "a".repeat(64)
  }]],
  ["account-b", []]
]);
let sequence = 0;
const createId = () => `content-${++sequence}`;

const repository = {
  async read() {
    return clone(stores.get(accountId()));
  },
  async update(operation) {
    const id = accountId();
    const document = stores.get(id);
    const result = await operation(document);
    await result?.[Symbol.for("for-now.after-commit")]?.();
    stores.set(id, document);
    return result;
  },
  async transact(operation) {
    const id = accountId();
    const document = stores.get(id);
    const result = await operation({
      document,
      async commit() {
        stores.set(id, document);
      }
    });
    stores.set(id, document);
    return result;
  },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const id = accountId();
    const key = `${id}:${request.scope}:${request.key}`;
    const existing = ledgers.get(key);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("same key, different request"), {
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return clone(onReplay(clone(existing.response)));
    }
    const response = await operation(stores.get(id));
    ledgers.set(key, {
      requestHash: request.requestHash,
      response: clone(response)
    });
    return response;
  },
  async readIdempotent(request) {
    const existing = ledgers.get(
      `${accountId()}:${request.scope}:${request.key}`
    );
    if (!existing) return undefined;
    if (existing.requestHash !== request.requestHash) {
      throw Object.assign(new Error("same key, different request"), {
        code: "IDEMPOTENCY_KEY_REUSED"
      });
    }
    return clone(existing.response);
  }
};

let mediaDependencies;
const mediaFactory = options => {
  mediaDependencies = options;
  return {
    attachmentCleanup: {
      enqueue() {},
      async drain() {
        return { attempted: 0, pending: 0, removed: [] };
      },
      schedule() {}
    },
    speechProvider: {
      configured: true,
      supportedAsrMimeTypes: ["audio/mp4", "audio/ogg", "audio/wav"]
    },
    visionProvider: { configured: true },
    async listAttachmentInventory() {
      return clone(inventory.get(accountId()) || []);
    },
    async materializeAttachmentFiles() {
      return [];
    },
    async transcribeCapture() {
      return {
        provider: "speech-double",
        rawText: "原始转写",
        polishedText: "润色转写",
        condensedText: "精简转写",
        updatedAt: now()
      };
    }
  };
};

const runtime = createContentRuntime({
  repository,
  mediaOptions: {},
  trashRetentionDays: 30,
  getAccountId: accountId,
  getCursorScope: accountId,
  backgroundContextKey: accountId,
  workflowContextKey: accountId,
  dispatchBackground: callback => scheduled.push({
    accountId: accountId(),
    callback
  }),
  runDeepSeek: async (_prompt, options = {}) => ({
    content: options.scene === "perceptionExtraction"
      ? JSON.stringify({
          evidence: [{
            origin: "user",
            informationType: "user_viewpoint",
            span: [0, 4]
          }]
        })
      : "生成内容",
    reasoningContent: "推理内容"
  }),
  now,
  today,
  currentTime: () => Date.parse(now()),
  createId,
  hash,
  async logEvent(type, event, fields) {
    logs.push({ type, event, fields: clone(fields) });
  },
  debugServerUrl: "http://debug.invalid/events",
  debugRunId: "content-runtime-regression",
  async debugFetch(url, options) {
    debugEvents.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  },
  mediaFactory
});

assert.throws(
  () => createContentRuntime(),
  /Content runtime repository is required/
);
assert.equal(typeof mediaDependencies.books.createNote, "function");
assert.equal(typeof mediaDependencies.quotes.create, "function");
assert.equal(typeof mediaDependencies.moveCollectionItemToTrash, "function");
assert.equal(typeof mediaDependencies.moveNestedItemToTrash, "function");

await scope.run("account-a", async () => {
  const created = await runtime.captureRecords.create({
    content: "账户 A 的语音捕念",
    occurredAt: "2026-10-06T08:00:00.000Z",
    occurredOn: "2026-10-06",
    attachmentPaths: ["/attachments/account-a.png"],
    audio: {
      attachmentPath: "/attachments/account-a.m4a",
      mimeType: "audio/mp4",
      bytes: 1024,
      durationMs: 2500
    }
  }, { clientRequestId: "capture-a" });
  assert.equal(created.value.content, "账户 A 的语音捕念");
  assert.equal(stores.get("account-a").perceptionEvents.length, 1);
  assert.equal(stores.get("account-a").evidencePermissions.length, 1);
  assert.equal(stores.get("account-a").evidencePermissions[0].learningAllowed, false);
  const attachments = await runtime.contentAttachmentService.get(
    "capture",
    created.value.id
  );
  assert.deepEqual(attachments.value.originalImages, [{
    path: "/attachments/account-a.png",
    state: "verified",
    bytes: 100,
    sha256: "a".repeat(64)
  }]);

  const first = await runtime.requestCaptureTranscription(created.value);
  const duplicate = await runtime.requestCaptureTranscription(created.value);
  assert.equal(first.id, duplicate.id);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].accountId, "account-a");
  await runtime.backgroundAi.run(first.id);
  const stored = stores.get("account-a").captures.find(
    item => item.id === created.value.id
  );
  assert.equal(stored.transcription.status, "ready");
  assert.equal(stored.transcription.version, 1);
  assert.equal(stored.transcription.polishedText, "润色转写");
  assert.ok(stores.get("account-a").perceptionEvents.some(item => (
    item.sourceRef.resourceId === created.value.id
    && item.sourceRef.targetKey === "transcription"
  )));

  const audioOnly = await runtime.captureRecords.create({
    content: "",
    occurredAt: "2026-10-06T08:30:00.000Z",
    occurredOn: "2026-10-06",
    attachmentPaths: [],
    audio: {
      attachmentPath: "/attachments/account-a-audio-only.m4a",
      mimeType: "audio/mp4",
      bytes: 2048,
      durationMs: 3000
    }
  }, { clientRequestId: "capture-audio-only" });
  assert.equal(stores.get("account-a").perceptionEvents.some(item => (
    item.sourceRef.resourceId === audioOnly.value.id
  )), false);
  const audioOnlyTask = await runtime.requestCaptureTranscription(audioOnly.value);
  await runtime.backgroundAi.run(audioOnlyTask.id);
  assert.deepEqual(
    stores.get("account-a").perceptionEvents
      .filter(item => item.sourceRef.resourceId === audioOnly.value.id)
      .map(item => item.sourceRef.targetKey),
    ["transcription"]
  );
  const transcriptPermission = await runtime.perception.observe({
    sourceRef: {
      resourceType: "capture",
      resourceId: audioOnly.value.id,
      rootId: "",
      targetKey: "transcription",
      version: 1
    },
    learningAllowed: true,
    eventKind: "permission_changed"
  });
  await runtime.backgroundAi.run(transcriptPermission.task.id);
  assert.ok(stores.get("account-a").evidenceSources.some(item => (
    item.sourceRef.resourceId === audioOnly.value.id
    && item.sourceRef.targetKey === "transcription"
  )));

  const journal = await runtime.journalRecords.create({
    title: "今天",
    content: "完成了一次可靠的接线",
    occurredAt: "2026-10-06T09:00:00.000Z",
    occurredOn: "2026-10-06"
  }, { clientRequestId: "journal-a" });
  const thought = await runtime.thoughtWorkflows.createChain({
    questionText: "怎样验证持续感知？",
    eventTime: {
      occurredAt: "2026-10-06T10:00:00.000Z",
      occurredOn: "2026-10-06"
    },
    eventTimeHash: "2026-10-06T10:00:00.000Z",
    tags: [],
    clientRequestId: "thought-a",
    generateAnswer: false,
    attachmentPaths: [],
    idea: "",
    answer: "",
    modelDraft: "",
    modelReasoning: "",
    sourceRef: {
      type: "capture",
      id: created.value.id,
      version: stored.version
    }
  });
  const root = thought.items.find(item => item.type === "question");
  const annotation = await runtime.annotationCommands.create(
    "thought",
    root.id,
    {
      kind: "comment",
      targetKey: `question:${root.id}`,
      quote: "持续感知",
      start: 4,
      end: 8,
      text: "这里需要保留来源版本"
    },
    { clientRequestId: "annotation-a" }
  );
  assert.ok(journal.value.id);
  assert.ok(annotation.value.id);
  const reply = await runtime.annotationCommands.reply(
    "thought",
    root.id,
    annotation.value.id,
    { text: "补充一条用户回复" }
  );
  assert.ok(reply.value.id);
  assert.deepEqual(
    new Set(stores.get("account-a").perceptionEvents.map(item => item.sourceRef.resourceType)),
    new Set(["capture", "journal", "thought"])
  );
  assert.equal(stores.get("account-a").perceptionEvents.length, 9);
  assert.ok(stores.get("account-a").perceptionEvents.some(item => (
    item.sourceRef.resourceId === reply.value.id
    && item.sourceRef.targetKey === `annotation-reply:${annotation.value.id}`
  )));
  const internalTasks = stores.get("account-a").aiTasks.filter(task => task.internal === true);
  assert.equal(internalTasks.length, 1);
  assert.equal((await runtime.backgroundAi.list()).items.some(task => (
    task.kind === "perceptionExtraction"
  )), false);
  assert.equal(stores.get("account-a").notifications.some(item => (
    item.taskId === internalTasks[0].id
  )), false);
  const sourceEvents = stores.get("account-a").perceptionEvents;
  assert.equal(
    sourceEvents.findLast(item => item.sourceRef.resourceId === root.id).eventId,
    sourceEvents.findLast(item => (
      item.sourceRef.resourceId === created.value.id
      && item.sourceRef.targetKey === ""
    )).eventId
  );
  const removedAnnotation = await runtime.annotationCommands.remove(
    "thought",
    root.id,
    annotation.value.id
  );
  assert.equal(stores.get("account-a").perceptionEvents.length, 12);
  assert.equal(stores.get("account-a").perceptionEvents.filter(item => (
    item.kind === "deleted"
    && [annotation.value.id, reply.value.id].includes(item.sourceRef.resourceId)
  )).length, 2);
  const nestedPermissions = stores.get("account-a").evidencePermissions.filter(item => (
    item.sourceKey.includes(annotation.value.id)
    || item.sourceKey.includes(reply.value.id)
  ));
  assert.equal(nestedPermissions.length, 2);
  assert.ok(nestedPermissions.every(item => (
    item.contextAllowed === false && item.learningAllowed === false
  )));
  await runtime.trashCommands.restore(removedAnnotation.id);
  assert.equal(stores.get("account-a").perceptionEvents.length, 15);
  assert.equal(stores.get("account-a").perceptionEvents.filter(item => (
    item.kind === "restored"
    && [annotation.value.id, reply.value.id].includes(item.sourceRef.resourceId)
  )).length, 2);
  const restoredPermissions = stores.get("account-a").evidencePermissions.filter(item => (
    item.sourceKey.includes(annotation.value.id)
    || item.sourceKey.includes(reply.value.id)
  ));
  assert.ok(restoredPermissions.every(item => (
    item.contextAllowed === false && item.learningAllowed === false
  )));
});

await scope.run("account-b", async () => {
  assert.equal(stores.get("account-b").captures.length, 0);
  assert.equal((await runtime.backgroundAi.list()).items.length, 0);
  await assert.rejects(
    runtime.requestCaptureTranscription({
      id: "webm-capture",
      audio: {
        attachmentPath: "/attachments/account-b.webm",
        mimeType: "audio/webm",
        bytes: 1000,
        durationMs: 1000
      }
    }, { force: true }),
    error => error.code === "ASR_UNSUPPORTED_AUDIO_FORMAT"
      && error.statusCode === 422
  );
});

stores.get("account-a").analyses.unshift({
  id: "stale-confirmed-synthesis",
  reason: "manual",
  content: "不得继续用于回答的旧综合",
  reviewStatus: "confirmed",
  reviewedAt: "2026-09-29T01:00:00.000Z",
  reviewDisposition: "",
  contextReceipt: {
    version: "2026.10.02.2",
    permissionPurpose: "learning",
    promptSha256: "0".repeat(64),
    tokenBudget: { limit: 20000 },
    sources: []
  },
  createdAt: "2026-09-29T00:00:00.000Z",
  version: 2
});
const publicContext = runtime.projectPersonalContext(
  stores.get("account-a")
);
const ownerContext = runtime.projectPersonalContext(
  stores.get("account-a"),
  { includeOwnerMetadata: true }
);
assert.equal("tokenBudget" in publicContext.receipt, false);
assert.equal("tokenBudget" in ownerContext.receipt, true);
assert.equal(publicContext.overview.periodicSyntheses[0].reviewStatus, "stale");
assert.doesNotMatch(publicContext.prompt, /不得继续用于回答的旧综合/);
assert.ok(debugEvents.some(event => (
  event.body.hypothesisId === "C-E"
  && event.body.location === "src/app/content/background.mjs:requestCaptureTranscription"
)));
assert.deepEqual(logs, []);

console.log(
  "Content runtime regression passed: explicit media wiring, scoped records, transcription deduplication, unsupported audio rejection, and personal-context metadata."
);
