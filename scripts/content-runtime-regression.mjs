import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import { createContentRuntime } from "../src/app/content-runtime.mjs";
import { createEmptyStore } from "../src/app/index.mjs";

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
  runDeepSeek: async () => ({
    content: "生成内容",
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
  assert.equal(stored.transcription.polishedText, "润色转写");
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

const publicContext = runtime.projectPersonalContext(
  stores.get("account-a")
);
const ownerContext = runtime.projectPersonalContext(
  stores.get("account-a"),
  { includeOwnerMetadata: true }
);
assert.equal("tokenBudget" in publicContext.receipt, false);
assert.equal("tokenBudget" in ownerContext.receipt, true);
assert.ok(debugEvents.some(event => (
  event.body.hypothesisId === "C-E"
  && event.body.location === "src/app/content/background.mjs:requestCaptureTranscription"
)));
assert.deepEqual(logs, []);

console.log(
  "Content runtime regression passed: explicit media wiring, scoped records, transcription deduplication, unsupported audio rejection, and personal-context metadata."
);
