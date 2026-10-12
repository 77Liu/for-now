import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import "./prompt-test-setup.mjs";
import {
  createCaptureJournalHttp,
  captureJournalComponents,
  captureJournalPaths,
  capturesJournalsOpenApiFragment,
  createApiV1Http,
  openApiV1
} from "../src/http/index.mjs";
import { createCaptureJournalWorkflows } from "../src/app/index.mjs";
import { captureAudioPayload, capturePayload, createCaptureRecords } from "../src/modules/captures/index.mjs";
import { createJournalRecords } from "../src/modules/journals/index.mjs";
import { contentOriginalPayload } from "../src/modules/content-attachments/index.mjs";
import { recordVersion } from "../src/shared/validation/index.mjs";

const context = new AsyncLocalStorage();
const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const derivedAudio = {
  attachmentPath: "/attachments/voice.m4a",
  mimeType: "audio/mp4",
  bytes: 4096,
  durationMs: 1250,
  asrAttachmentPath: "/attachments/voice.asr.wav",
  asrMimeType: "audio/wav",
  asrBytes: 40044
};
assert.deepEqual(captureAudioPayload(derivedAudio), { value: derivedAudio });
assert.equal(captureAudioPayload({
  ...derivedAudio,
  asrAttachmentPath: "/attachments/foreign.wav"
}).code, "INVALID_ASR_DERIVATIVE");
const pureAudio = capturePayload({
  audio: {
    attachmentPath: derivedAudio.attachmentPath,
    mimeType: derivedAudio.mimeType,
    bytes: derivedAudio.bytes,
    durationMs: derivedAudio.durationMs
  },
  occurredAt: "2026-10-03T00:00:00.000Z"
}).value;
assert.equal(pureAudio.title, `${pureAudio.occurredOn} 录音`);
assert.equal(pureAudio.content, "", "the default title stays separate from user content");
assert.equal(capturePayload({
  title: "我的语音标题",
  audio: {
    attachmentPath: derivedAudio.attachmentPath,
    mimeType: derivedAudio.mimeType,
    bytes: derivedAudio.bytes,
    durationMs: derivedAudio.durationMs
  },
  occurredAt: "2026-10-03T00:00:00.000Z"
}).value.title, "我的语音标题");
assert.equal(capturePayload({ audio: derivedAudio }, {
  ...pureAudio,
  title: undefined,
  audio: derivedAudio
}).value.title, undefined, "legacy audio captures are not backfilled during edits");
assert.equal(capturePayload({ content: "更新转写" }, {
  ...pureAudio,
  title: "我的语音标题",
  audio: derivedAudio
}).value.title, "我的语音标题", "late transcription edits preserve user title");
assert.deepEqual(
  capturePayload({ content: "编辑文字", audio: {
    attachmentPath: derivedAudio.attachmentPath,
    mimeType: derivedAudio.mimeType,
    bytes: derivedAudio.bytes,
    durationMs: derivedAudio.durationMs
  } }, {
    ...derivedAudio,
    content: "原文字",
    audio: derivedAudio,
    occurredAt: "2026-10-03T00:00:00.000Z",
    occurredOn: "2026-10-03"
  }).value.audio,
  derivedAudio
);
const emptyStore = () => ({
  checkins: [],
  dailyRecords: [],
  captures: [],
  journals: [],
  journalDraft: null,
  thoughts: [],
  trash: [],
  onboarding: {}
});
const stores = new Map([
  ["account-a", emptyStore()],
  ["account-b", emptyStore()]
]);
const ledgers = new Map([
  ["account-a", new Map()],
  ["account-b", new Map()]
]);
const ledgerEvents = [];
let activeWriteTransactions = 0;
const run = (accountId, operation) => context.run(
  { accountId, traceId: `trace-${accountId}` },
  operation
);
const accountStore = () => stores.get(context.getStore().accountId);
const replaceStore = value => stores.set(context.getStore().accountId, value);
const accountLedger = () => ledgers.get(context.getStore().accountId);
const ledgerKey = request => `${request.scope}\u0000${request.key}`;
const idempotencyConflict = () => Object.assign(
  new Error("同一幂等键不能用于不同内容"),
  { code: "IDEMPOTENCY_KEY_REUSED", statusCode: 409 }
);
const readIdempotent = async request => {
  ledgerEvents.push({ type: "read", ...request });
  const entry = accountLedger().get(ledgerKey(request));
  if (!entry) return undefined;
  if (entry.requestHash !== request.requestHash) throw idempotencyConflict();
  return structuredClone(entry.response);
};
const executeIdempotent = async (request, operation, { onReplay = value => value } = {}) => {
  ledgerEvents.push({ type: "execute", ...request });
  const entry = accountLedger().get(ledgerKey(request));
  if (entry) {
    if (entry.requestHash !== request.requestHash) throw idempotencyConflict();
    return structuredClone(onReplay(structuredClone(entry.response)));
  }
  activeWriteTransactions += 1;
  try {
    const store = structuredClone(accountStore());
    const response = await operation(store);
    replaceStore(store);
    accountLedger().set(ledgerKey(request), {
      requestHash: request.requestHash,
      response: structuredClone(response)
    });
    return structuredClone(response);
  } finally {
    activeWriteTransactions -= 1;
  }
};

const captureRepository = {
  async read() {
    return structuredClone(accountStore().captures);
  },
  async update(mutate) {
    const store = structuredClone(accountStore());
    const result = await mutate(store.captures, store.trash, store);
    replaceStore(store);
    await result?.[AFTER_COMMIT]?.();
    return result;
  },
  readIdempotent,
  executeIdempotent(request, operation, options) {
    return executeIdempotent(request, store => operation(store.captures, store.trash), options);
  }
};
const journalRepository = {
  async read() {
    const store = accountStore();
    return structuredClone({
      journals: store.journals,
      journalDraft: store.journalDraft,
      trash: store.trash
    });
  },
  async update(mutate) {
    const store = structuredClone(accountStore());
    const state = {
      journals: store.journals,
      journalDraft: store.journalDraft,
      trash: store.trash
    };
    const result = await mutate(state);
    store.journals = state.journals;
    store.journalDraft = state.journalDraft;
    store.trash = state.trash;
    replaceStore(store);
    return result;
  },
  readIdempotent,
  executeIdempotent(request, operation, options) {
    return executeIdempotent(request, async store => {
      const state = {
        journals: store.journals,
        journalDraft: store.journalDraft,
        trash: store.trash
      };
      const result = await operation(state);
      store.journals = state.journals;
      store.journalDraft = state.journalDraft;
      store.trash = state.trash;
      return result;
    }, options);
  }
};
const storeRepository = {
  async read() {
    return structuredClone(accountStore());
  },
  readIdempotent
};

let idSequence = 0;
let clockSequence = 0;
const now = () => `2026-09-29T08:00:${String(clockSequence++).padStart(2, "0")}.000Z`;
const reanchors = [];
const audioCleanup = [];
const reanchorAnnotations = (record, field, before, after) => {
  reanchors.push({ id: record.id, field, before, after });
};
const captures = createCaptureRecords({
  repository: captureRepository,
  reanchorAnnotations,
  reconcileAudioAttachment: (_store, { previousAudio, nextAudio }) => {
    if (!previousAudio?.attachmentPath || previousAudio.attachmentPath === nextAudio?.attachmentPath) return null;
    audioCleanup.push(previousAudio.attachmentPath);
    return { trashId: "trash-audio-1" };
  },
  now,
  createId: () => `capture-${++idSequence}`
});
let audioReplayTime = "2026-10-12T08:00:00.000Z";
const audioReplayCaptures = createCaptureRecords({
  repository: captureRepository,
  reanchorAnnotations,
  now: () => audioReplayTime,
  createId: () => `capture-audio-replay-${++idSequence}`
});
const audioReplayInput = { audio: {
  attachmentPath: "/attachments/replay.m4a",
  mimeType: "audio/mp4",
  bytes: 2048,
  durationMs: 1000
} };
const firstAudioReplay = await run("account-a", () => audioReplayCaptures.create(
  audioReplayInput,
  { clientRequestId: "pure-audio-cross-day-replay" }
));
audioReplayTime = "2026-10-13T08:01:00.000Z";
const retriedAudioReplay = await run("account-a", () => audioReplayCaptures.create(
  audioReplayInput,
  { clientRequestId: "pure-audio-cross-day-replay" }
));
assert.equal(retriedAudioReplay.duplicate, true);
assert.equal(retriedAudioReplay.value.id, firstAudioReplay.value.id);
assert.equal(retriedAudioReplay.value.title, "2026-10-12 录音");
assert.equal(retriedAudioReplay.value.occurredOn, "2026-10-12");
await assert.rejects(
  run("account-a", () => audioReplayCaptures.create(
    { ...audioReplayInput, title: "用户指定标题" },
    { clientRequestId: "pure-audio-cross-day-replay" }
  )),
  error => error.code === "IDEMPOTENCY_KEY_REUSED",
  "an explicit user title remains part of the idempotency request"
);
const journals = createJournalRecords({
  repository: journalRepository,
  reanchorAnnotations,
  now,
  createId: () => `journal-resource-${++idSequence}`
});

const generationCalls = [];
const formatGeneratedAnswer = (content, options) => options?.json === true
  ? JSON.stringify({ answer: content, citations: [] })
  : content;
const generate = async (prompt, options) => {
  assert.equal(activeWriteTransactions, 0, "model generation must not run inside a repository write transaction");
  ledgerEvents.push({ type: "generate", scene: options.scene });
  generationCalls.push({ prompt, options });
  options.onDelta?.({ type: "delta", content: "增量" });
  return options.scene === "diaryReflection"
    ? { content: formatGeneratedAnswer("回望正文", options), reasoningContent: "模型思考" }
    : { content: "第一行\n\n第二行", reasoningContent: "" };
};
const workflows = createCaptureJournalWorkflows({
  repository: storeRepository,
  journals,
  generate,
  hash: value => crypto.createHash("sha256").update(value).digest("hex"),
  contextKey: () => context.getStore().accountId,
  today: () => "2026-09-29"
});

function removeCollection(collection, type) {
  return async (id, expectedVersion = null) => {
    const store = structuredClone(accountStore());
    const index = store[collection].findIndex(item => item.id === id);
    if (index < 0) return store.trash.find(item => item.type === type && item.resourceId === id) || null;
    const item = store[collection][index];
    const currentVersion = recordVersion(item.version);
    if (expectedVersion != null && currentVersion !== expectedVersion) {
      return { versionConflict: true, currentVersion };
    }
    store[collection].splice(index, 1);
    if (collection === "journals" && store.journalDraft?.journalId === id) store.journalDraft.journalId = "";
    const entry = {
      id: `trash-${type}-${id}`,
      type,
      resourceId: id,
      payload: item,
      location: { kind: "collection", collection }
    };
    store.trash.unshift(entry);
    replaceStore(store);
    return entry;
  };
}

async function removeReflection(journalId, reflectionId, expectedVersion = null) {
  const store = structuredClone(accountStore());
  const journal = store.journals.find(item => item.id === journalId);
  const index = journal?.reflections?.findIndex(item => item.id === reflectionId) ?? -1;
  if (index < 0) {
    return store.trash.find(item => item.type === "journalReflection" && item.resourceId === reflectionId) || null;
  }
  const reflection = journal.reflections[index];
  const currentVersion = recordVersion(reflection.version);
  if (expectedVersion != null && currentVersion !== expectedVersion) {
    return { versionConflict: true, currentVersion };
  }
  journal.reflections.splice(index, 1);
  const entry = {
    id: `trash-reflection-${reflectionId}`,
    type: "journalReflection",
    resourceId: reflectionId,
    payload: reflection,
    location: { kind: "nested", parentId: journalId, field: "reflections" }
  };
  store.trash.unshift(entry);
  replaceStore(store);
  return entry;
}

const sendJson = (res, status, value) => {
  res.status = status;
  res.body = value;
  res.headersSent = true;
  return value;
};
const bodyJson = async req => req.body || {};
const sendTrashResult = (res, entry, missingMessage) => sendJson(
  res,
  entry ? 200 : 404,
  entry ? { removed: 1, trashId: entry.id, tombstone: true } : { error: missingMessage }
);
const respondModel = async (req, res, {
  run: operation,
  status = 200,
  formatResult = value => value
}) => sendJson(res, status, formatResult(await operation(req.onDelta)));
const requestedTranscriptions = [];

const http = createCaptureJournalHttp({
  captures,
  journals,
  workflows,
  prepareContentAttachments: async (targetType, input) => {
    const parsed = contentOriginalPayload(targetType, input);
    if (parsed.error) return parsed;
    return parsed.value.attachmentPaths.some(value => value.includes("foreign"))
      ? { forbidden: true, error: "图片附件不属于当前账户", code: "ATTACHMENT_NOT_OWNED" }
      : parsed;
  },
  prepareCaptureAudio: async input => {
    const parsed = captureAudioPayload(input.audio);
    if (parsed.error || !parsed.value) return parsed;
    return parsed.value.attachmentPath.includes("foreign")
      ? { forbidden: true, error: "语音附件不属于当前账户", code: "ATTACHMENT_NOT_OWNED" }
      : { value: { audio: parsed.value } };
  },
  requestCaptureTranscription: async (capture, options = {}) => {
    requestedTranscriptions.push({ id: capture.id, ...options });
    return {
      id: `transcription-${capture.id}`,
      kind: "captureTranscription",
      resourceType: "capture",
      targetId: capture.id,
      inputVersion: capture.version,
      status: "queued",
      createdAt: "2026-09-29T01:01:16.000Z"
    };
  },
  removeCapture: removeCollection("captures", "capture"),
  removeJournal: removeCollection("journals", "journal"),
  removeReflection,
  sendTrashResult,
  bodyJson,
  sendJson,
  respondModel
});
const api = createApiV1Http({
  sendJson,
  getContext: () => context.getStore(),
  openApi: {}
});
api.register("captures-journals", http.handleV1);

async function request(accountId, method, pathname, { body = {}, headers = {}, onDelta } = {}) {
  const responseHeaders = new Map();
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), String(value));
    }
  };
  return run(accountId, async () => {
    try {
      const url = new URL(`http://local${pathname}`);
      const handled = pathname.startsWith("/api/v1/")
        ? await api.handle({ method, headers, body, onDelta }, res, url)
        : await http.handle({ method, headers, body, onDelta }, res, url);
      return { handled, status: res.status, body: res.body, headers: responseHeaders };
    } catch (error) {
      if (pathname.startsWith("/api/v1/")) {
        api.error(res, error.statusCode || 500, error.message, error.code, error.details);
      } else {
        sendJson(res, error.statusCode || 500, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      return { handled: true, status: res.status, body: res.body, headers: responseHeaders };
    }
  });
}

let response = await request("account-a", "POST", "/api/captures", { body: { content: "   " } });
assert.equal(response.status, 400);
assert.deepEqual(response.body, { error: "请填写文字或插入图片", code: "CONTENT_OR_IMAGE_REQUIRED" });

response = await request("account-a", "POST", "/api/captures", {
  body: {
    content: "",
    attachmentPaths: ["/attachments/image-only.png"],
    occurredAt: "2026-09-29T01:01:00.000Z"
  }
});
assert.equal(response.status, 201);
assert.equal(response.body.content, "");
assert.deepEqual(response.body.attachmentPaths, ["/attachments/image-only.png"]);

response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "audio-capture-1" },
  body: {
    content: "",
    attachmentPaths: [],
    audio: {
      attachmentPath: "/attachments/voice.m4a",
      mimeType: "audio/mp4",
      bytes: 4096,
      durationMs: 1250
    },
    occurredAt: "2026-09-29T01:01:15.000Z"
  }
});
assert.equal(response.status, 201);
assert.equal(response.body.data.content, "");
assert.equal(response.body.data.audio.attachmentPath, "/attachments/voice.m4a");
assert.equal(response.body.data.title, `${response.body.data.occurredOn} 录音`);
assert.deepEqual(response.body.data.transcription, {
  status: "unconfigured",
  provider: "",
  rawText: "",
  polishedText: "",
  condensedText: "",
  updatedAt: "",
  errorCode: "ASR_NOT_CONFIGURED",
  condenseErrorCode: ""
});
const audioCaptureId = response.body.data.id;
assert.deepEqual(requestedTranscriptions, [{ id: audioCaptureId }]);
response = await request("account-a", "POST", `/api/v1/captures/${audioCaptureId}/transcription`, {
  body: {}
});
assert.equal(response.status, 202);
assert.equal(response.body.data.kind, "captureTranscription");
assert.deepEqual(requestedTranscriptions.at(-1), { id: audioCaptureId, force: true });
response = await request("account-a", "PATCH", `/api/v1/captures/${audioCaptureId}`, {
  headers: { "if-match": "\"1\"" },
  body: { content: "保留文字，移除语音", audio: null }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.audio, null);
assert.equal(response.body.data.transcription, null);
assert.deepEqual(audioCleanup, ["/attachments/voice.m4a"]);

response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "audio-capture-invalid" },
  body: {
    audio: {
      attachmentPath: "/attachments/voice.m4a",
      mimeType: "audio/mp4",
      bytes: 4096,
      durationMs: 10
    }
  }
});
assert.equal(response.status, 400);
assert.equal(response.body.error.code, "INVALID_AUDIO_DURATION");

response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "audio-capture-foreign" },
  body: {
    audio: {
      attachmentPath: "/attachments/foreign.m4a",
      mimeType: "audio/mp4",
      bytes: 4096,
      durationMs: 1250
    }
  }
});
assert.equal(response.status, 403);
assert.equal(response.body.error.code, "ATTACHMENT_NOT_OWNED");

response = await request("account-a", "POST", "/api/captures", {
  body: {
    content: "伪造图片",
    attachmentPaths: ["/attachments/foreign.png"],
    occurredAt: "2026-09-29T01:01:30.000Z"
  }
});
assert.equal(response.status, 403);
assert.equal(response.body.code, "ATTACHMENT_NOT_OWNED");

response = await request("account-a", "POST", "/api/captures", {
  body: {
    content: "第一条捕念",
    tags: ["观察", "观察", ""],
    occurredAt: "2026-09-29T01:02:03.000Z"
  }
});
assert.equal(response.status, 201);
assert.equal(response.body.content, "第一条捕念");
assert.equal(response.body.version, undefined);
const legacyCaptureId = response.body.id;
const legacyCaptureCreatedAt = response.body.createdAt;

response = await request("account-a", "PATCH", `/api/captures/${legacyCaptureId}`, {
  body: { content: "修订后的捕念", occurredOn: "2026-09-28" }
});
assert.equal(response.status, 200);
assert.deepEqual(response.body.tags, []);
assert.equal(response.body.createdAt, legacyCaptureCreatedAt);
assert.equal(response.body.occurredOn, "2026-09-28");
assert.equal(reanchors.at(-1).id, legacyCaptureId);

const captureInput = {
  content: "v1 捕念",
  tags: ["接口"],
  occurredAt: "2026-09-29T02:03:04.000Z"
};
const transcriptionsBeforeTextCapture = requestedTranscriptions.length;
response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "capture-create-1" },
  body: captureInput
});
assert.equal(response.status, 201);
assert.equal(response.body.meta.traceId, "trace-account-a");
assert.equal(response.headers.get("etag"), "\"1\"");
assert.equal(
  requestedTranscriptions.length,
  transcriptionsBeforeTextCapture,
  "a pure text capture must not enqueue ASR"
);
const captureId = response.body.data.id;

response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "capture-create-1" },
  body: captureInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, captureId);

response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "capture-create-1" },
  body: { ...captureInput, content: "不同内容" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");
assert.equal((await request("account-b", "GET", `/api/v1/captures/${captureId}`)).status, 404);

response = await request("account-a", "PATCH", `/api/v1/captures/${captureId}`, {
  headers: { "if-match": "\"1\"" },
  body: { tags: ["保留正文"] }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.content, "v1 捕念");
assert.deepEqual(response.body.data.tags, ["保留正文"]);
assert.equal(response.body.data.version, 2);
assert.equal(response.headers.get("etag"), "\"2\"");

response = await request("account-a", "GET", "/api/v1/captures?limit=1");
assert.equal(response.status, 200);
assert.equal(response.body.data.length, 1);
assert.ok(response.body.meta.nextCursor);
response = await request("account-a", "GET", `/api/v1/captures?limit=1&cursor=${encodeURIComponent(response.body.meta.nextCursor)}`);
assert.equal(response.body.data.length, 1);

response = await request("account-a", "DELETE", `/api/v1/captures/${captureId}`, {
  headers: { "if-match": "\"1\"" }
});
assert.equal(response.status, 412);
response = await request("account-a", "DELETE", `/api/v1/captures/${captureId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.trashId, `trash-capture-${captureId}`);
await run("account-a", () => {
  const store = structuredClone(accountStore());
  store.trash = store.trash.filter(item => item.resourceId !== captureId);
  replaceStore(store);
});
const purgedCaptureReplay = await run("account-a", () => captures.create(captureInput, {
  clientRequestId: "capture-create-1"
}));
assert.equal(purgedCaptureReplay.duplicate, true);
assert.equal(purgedCaptureReplay.value.id, captureId);
response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "capture-create-1" },
  body: captureInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, captureId);
assert.equal(await run("account-a", () => captures.get(captureId)), null);
response = await request("account-a", "POST", "/api/v1/captures", {
  headers: { "idempotency-key": "capture-create-1" },
  body: { ...captureInput, content: "永久删除后的不同内容" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

response = await request("account-a", "PUT", "/api/journal-draft", { body: {} });
assert.equal(response.status, 400);
assert.deepEqual(response.body, { error: "先写下一点内容再保存草稿" });
response = await request("account-a", "PUT", "/api/journal-draft", {
  body: { journalId: "missing", title: "未绑定草稿", content: "草稿正文", occurredAt: "ignored" }
});
assert.equal(response.status, 200);
assert.deepEqual(
  { journalId: response.body.journalId, title: response.body.title, content: response.body.content },
  { journalId: "", title: "未绑定草稿", content: "草稿正文" }
);
assert.equal(response.body.occurredAt, undefined);

response = await request("account-a", "POST", "/api/journals", {
  body: {
    title: "旧接口日记",
    content: "今天写了一篇日记",
    tags: ["日常"],
    occurredAt: "2026-09-29T03:04:05.000Z"
  }
});
assert.equal(response.status, 201);
assert.equal(response.body.version, undefined);
const legacyJournalId = response.body.id;
assert.equal(await run("account-a", () => journals.getDraft()), null);

await request("account-a", "PUT", "/api/journal-draft", {
  body: { journalId: legacyJournalId, title: "编辑草稿", content: "待修改" }
});
response = await request("account-a", "PATCH", `/api/journals/${legacyJournalId}`, {
  body: { content: "修改后的日记", occurredOn: "2026-09-28" }
});
assert.equal(response.status, 200);
assert.equal(response.body.title, "");
assert.deepEqual(response.body.tags, []);
assert.equal(response.body.version, 2);
assert.equal(await run("account-a", () => journals.getDraft()), null);

response = await request("account-a", "PUT", "/api/v1/journal-draft", {
  headers: { "idempotency-key": "draft-save-1" },
  body: { title: "v1 草稿", content: "跨设备正文" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.version, 1);
const draftUpdatedAt = response.body.data.updatedAt;
response = await request("account-a", "PUT", "/api/v1/journal-draft", {
  headers: { "idempotency-key": "draft-save-1" },
  body: { title: "v1 草稿", content: "跨设备正文" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.updatedAt, draftUpdatedAt);
response = await request("account-a", "PUT", "/api/v1/journal-draft", {
  headers: { "idempotency-key": "draft-save-1" },
  body: { title: "v1 草稿", content: "不同正文" }
});
assert.equal(response.status, 409);
response = await request("account-a", "GET", "/api/v1/journal-draft");
assert.equal(response.status, 200);
assert.equal(response.headers.get("etag"), "\"1\"");

const journalInput = {
  title: "v1 日记",
  content: "v1 日记正文",
  tags: ["复盘"],
  occurredAt: "2026-09-29T04:05:06.000Z"
};
response = await request("account-a", "POST", "/api/v1/journals", {
  headers: { "idempotency-key": "journal-create-1" },
  body: journalInput
});
assert.equal(response.status, 201);
assert.equal(response.body.data.version, 1);
const journalId = response.body.data.id;
assert.equal(await run("account-a", () => journals.getDraft()), null);
response = await request("account-a", "POST", "/api/v1/journals", {
  headers: { "idempotency-key": "journal-create-1" },
  body: journalInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, journalId);
assert.equal((await request("account-b", "GET", `/api/v1/journals/${journalId}`)).status, 404);

response = await request("account-a", "PATCH", `/api/v1/journals/${journalId}`, {
  headers: { "if-match": "\"1\"" },
  body: { title: "只改标题" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.content, "v1 日记正文");
assert.deepEqual(response.body.data.tags, ["复盘"]);
assert.equal(response.body.data.version, 2);
response = await request("account-a", "GET", "/api/v1/journals?limit=1");
assert.equal(response.status, 200);
assert.equal(response.body.data.length, 1);
assert.ok(response.body.meta.nextCursor);

const assistDeltas = [];
response = await request("account-a", "POST", "/api/journals/assist", {
  body: {
    mode: "lead",
    occurredOn: "2026-09-29",
    title: "辅助中的标题",
    content: "我已写下的正文",
    requestId: "assist-request",
    targetId: "journal-editor",
    inputVersion: 7
  },
  onDelta: event => assistDeltas.push(event)
});
assert.equal(response.status, 200);
assert.equal(response.body.content, "🗃 第一行\n\n🗃 第二行");
assert.deepEqual(
  { requestId: response.body.requestId, targetId: response.body.targetId, inputVersion: response.body.inputVersion },
  { requestId: "assist-request", targetId: "journal-editor", inputVersion: 7 }
);
assert.equal(assistDeltas.length, 1);
const assistCall = generationCalls.at(-1);
assert.equal(assistCall.options.scene, "diaryLead");
assert.equal(assistCall.options.maxTokens, 2000);
assert.equal(assistCall.options.retryWithoutThinking, true);
assert.match(assistCall.prompt, /我已写下的正文/);
assert.match(assistCall.prompt, /修订后的捕念/);
assert.equal((await request("account-a", "POST", "/api/journals/assist", {
  body: { mode: "invalid" }
})).status, 400);
response = await request("account-a", "POST", "/api/v1/journals/assist", {
  body: { mode: "topic", occurredOn: "2026-09-29", content: "继续梳理" }
});
assert.equal(response.status, 400);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
response = await request("account-a", "POST", "/api/v1/journals/assist", {
  headers: { "idempotency-key": "x".repeat(101) },
  body: { mode: "topic", occurredOn: "2026-09-29", content: "继续梳理" }
});
assert.equal(response.status, 400);
assert.equal(response.body.error.code, "INVALID_IDEMPOTENCY_KEY");
response = await request("account-a", "POST", "/api/v1/journals/assist", {
  headers: { "idempotency-key": "journal-assist-1" },
  body: { mode: "topic", occurredOn: "2026-09-29", content: "继续梳理" }
});
assert.equal(response.status, 200);
assert.equal(response.body.error, null);
assert.equal(response.body.data.mode, "topic");
assert.equal(response.body.data.content, "💬 第一行\n\n💬 第二行");

const reflectionCallsBeforeLegacy = generationCalls.length;
response = await request("account-a", "POST", `/api/journals/${legacyJournalId}/reflect`);
assert.equal(response.status, 201, JSON.stringify(response.body));
assert.equal(response.body.content, "回望正文");
assert.equal(response.body.reasoningContent, "模型思考");
assert.equal(response.body.contextReceipt.version, "2026.10.02.2");
assert.equal(generationCalls.length, reflectionCallsBeforeLegacy + 1);
let storedJournal = await run("account-a", () => journals.get(legacyJournalId));
assert.equal(storedJournal.reflections[0].id, response.body.id);
assert.equal(storedJournal.reflections[0].sourceUpdatedAt, storedJournal.updatedAt || storedJournal.createdAt);
assert.equal(storedJournal.reflections[0].contextReceipt.promptSha256, generationCalls.at(-1).options.contextReceipt.promptSha256);
assert.equal(storedJournal.reflections[0].contextReceipt.sources.some(source => Object.hasOwn(source, "excerpt")), false);
assert.equal((await request("account-a", "POST", "/api/journals/missing/reflect")).status, 404);

const reflectionCallsBeforeV1 = generationCalls.length;
const reflectionLedgerStart = ledgerEvents.length;
response = await request("account-a", "POST", `/api/v1/journals/${journalId}/reflections`, {
  headers: { "idempotency-key": "reflection-create-1" }
});
assert.equal(response.status, 201);
assert.equal(response.body.data.version, 1);
assert.equal(response.body.data.duplicate, undefined);
const reflectionId = response.body.data.id;
assert.equal(generationCalls.length, reflectionCallsBeforeV1 + 1);
const reflectionLedgerEvents = ledgerEvents.slice(reflectionLedgerStart)
  .filter(event => event.key === "reflection-create-1" || event.scene === "diaryReflection");
assert.equal(reflectionLedgerEvents[0].type, "read");
assert.equal(reflectionLedgerEvents.find(event => event.type === "generate")?.type, "generate");
assert.equal(reflectionLedgerEvents.at(-1).type, "execute");
response = await request("account-a", "POST", `/api/v1/journals/${journalId}/reflections`, {
  headers: { "idempotency-key": "reflection-create-1" }
});
assert.equal(response.status, 201);
assert.equal(response.body.data.id, reflectionId);
assert.equal(response.body.data.duplicate, true);
assert.equal(generationCalls.length, reflectionCallsBeforeV1 + 1);
response = await request("account-a", "POST", `/api/v1/journals/${legacyJournalId}/reflections`, {
  headers: { "idempotency-key": "reflection-create-1" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

response = await request("account-a", "DELETE", `/api/v1/journals/${journalId}/reflections/${reflectionId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 412);
response = await request("account-a", "DELETE", `/api/v1/journals/${journalId}/reflections/${reflectionId}`, {
  headers: { "if-match": "\"1\"" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.trashId, `trash-reflection-${reflectionId}`);
await run("account-a", () => {
  const store = structuredClone(accountStore());
  store.trash = store.trash.filter(item => item.resourceId !== reflectionId);
  replaceStore(store);
});
response = await request("account-a", "POST", `/api/v1/journals/${journalId}/reflections`, {
  headers: { "idempotency-key": "reflection-create-1" }
});
assert.equal(response.status, 201);
assert.equal(response.body.data.id, reflectionId);
assert.equal(response.body.data.duplicate, true);
assert.equal(generationCalls.length, reflectionCallsBeforeV1 + 1);
response = await request("account-a", "POST", `/api/v1/journals/${legacyJournalId}/reflections`, {
  headers: { "idempotency-key": "reflection-create-1" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

response = await request("account-a", "DELETE", `/api/v1/journals/${journalId}`, {
  headers: { "if-match": "\"1\"" }
});
assert.equal(response.status, 412);
response = await request("account-a", "DELETE", `/api/v1/journals/${journalId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.trashId, `trash-journal-${journalId}`);
await run("account-a", () => {
  const store = structuredClone(accountStore());
  store.trash = store.trash.filter(item => item.resourceId !== journalId);
  replaceStore(store);
});
const purgedJournalReplay = await run("account-a", () => journals.create(journalInput, {
  clientRequestId: "journal-create-1"
}));
assert.equal(purgedJournalReplay.duplicate, true);
assert.equal(purgedJournalReplay.value.id, journalId);
assert.equal(await run("account-a", () => journals.get(journalId)), null);
response = await request("account-a", "POST", "/api/v1/journals", {
  headers: { "idempotency-key": "journal-create-1" },
  body: { ...journalInput, content: "永久删除后的不同日记" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

storedJournal = await run("account-a", () => journals.get(legacyJournalId));
const legacyReflectionId = storedJournal.reflections[0].id;
response = await request("account-a", "DELETE", `/api/journals/${legacyJournalId}/reflections/${legacyReflectionId}`);
assert.equal(response.status, 200);
assert.equal(response.body.tombstone, true);
await request("account-a", "PUT", "/api/journal-draft", {
  body: { journalId: legacyJournalId, title: "删除前草稿", content: "保留正文" }
});
response = await request("account-a", "DELETE", `/api/journals/${legacyJournalId}`);
assert.equal(response.status, 200);
assert.equal((await run("account-a", () => journals.getDraft())).journalId, "");
response = await request("account-a", "DELETE", `/api/captures/${legacyCaptureId}`);
assert.equal(response.status, 200);
assert.equal(response.body.tombstone, true);

let fallbackStore = emptyStore();
const fallbackCaptures = createCaptureRecords({
  repository: {
    read: async () => structuredClone(fallbackStore.captures),
    update: async mutate => {
      const next = structuredClone(fallbackStore);
      const result = await mutate(next.captures, next.trash);
      fallbackStore = next;
      return result;
    }
  },
  reanchorAnnotations: () => {},
  now,
  createId: () => "fallback-capture"
});
const fallbackJournals = createJournalRecords({
  repository: {
    read: async () => structuredClone({
      journals: fallbackStore.journals,
      journalDraft: fallbackStore.journalDraft,
      trash: fallbackStore.trash
    }),
    update: async mutate => {
      const next = structuredClone(fallbackStore);
      const state = {
        journals: next.journals,
        journalDraft: next.journalDraft,
        trash: next.trash
      };
      const result = await mutate(state);
      Object.assign(next, state);
      fallbackStore = next;
      return result;
    }
  },
  reanchorAnnotations: () => {},
  now,
  createId: () => `fallback-journal-${++idSequence}`
});
const fallbackCaptureInput = {
  content: "兼容路径捕念",
  occurredAt: "2026-09-29T08:30:00.000Z"
};
await fallbackCaptures.create(fallbackCaptureInput, { clientRequestId: "fallback-capture-key" });
assert.equal((await fallbackCaptures.create(
  fallbackCaptureInput,
  { clientRequestId: "fallback-capture-key" }
)).duplicate, true);
assert.equal((await fallbackCaptures.create(
  { ...fallbackCaptureInput, content: "兼容路径冲突" },
  { clientRequestId: "fallback-capture-key" }
)).conflict, true);
const fallbackJournalInput = {
  content: "兼容路径日记",
  occurredAt: "2026-09-29T08:31:00.000Z"
};
const fallbackJournal = await fallbackJournals.create(
  fallbackJournalInput,
  { clientRequestId: "fallback-journal-key" }
);
assert.equal((await fallbackJournals.create(
  fallbackJournalInput,
  { clientRequestId: "fallback-journal-key" }
)).duplicate, true);
assert.equal((await fallbackJournals.create(
  { ...fallbackJournalInput, content: "兼容路径日记冲突" },
  { clientRequestId: "fallback-journal-key" }
)).conflict, true);
const fallbackDraftInput = { title: "兼容草稿", content: "兼容草稿正文" };
await fallbackJournals.saveDraft(fallbackDraftInput, { clientRequestId: "fallback-draft-key" });
assert.equal((await fallbackJournals.saveDraft(
  fallbackDraftInput,
  { clientRequestId: "fallback-draft-key" }
)).duplicate, true);
assert.equal((await fallbackJournals.saveDraft(
  { ...fallbackDraftInput, content: "兼容草稿冲突" },
  { clientRequestId: "fallback-draft-key" }
)).conflict, true);
let fallbackGenerationCalls = 0;
const fallbackWorkflows = createCaptureJournalWorkflows({
  repository: { read: async () => structuredClone(fallbackStore) },
  journals: fallbackJournals,
  generate: async (_prompt, options) => {
    fallbackGenerationCalls += 1;
    return {
      content: formatGeneratedAnswer("兼容路径回望", options),
      reasoningContent: ""
    };
  },
  hash: value => crypto.createHash("sha256").update(value).digest("hex")
});
await fallbackWorkflows.reflect({
  id: fallbackJournal.value.id,
  clientRequestId: "fallback-reflection-key"
});
assert.equal((await fallbackWorkflows.reflect({
  id: fallbackJournal.value.id,
  clientRequestId: "fallback-reflection-key"
})).duplicate, true);
assert.equal(fallbackGenerationCalls, 1);

const sharedOperationKey = "same-key-across-create-operations";
const scopedCapture = await run("account-b", () => captures.create({
  content: "scope 捕念",
  occurredAt: "2026-09-29T09:00:00.000Z"
}, { clientRequestId: sharedOperationKey }));
const scopedDraft = await run("account-b", () => journals.saveDraft({
  title: "scope 草稿",
  content: "草稿正文"
}, { clientRequestId: sharedOperationKey }));
const scopedJournal = await run("account-b", () => journals.create({
  title: "scope 日记",
  content: "日记正文",
  occurredAt: "2026-09-29T09:01:00.000Z"
}, { clientRequestId: sharedOperationKey }));
const scopedReflection = await run("account-b", () => workflows.reflect({
  id: scopedJournal.value.id,
  clientRequestId: sharedOperationKey
}));
assert.equal(scopedCapture.conflict, undefined);
assert.equal(scopedDraft.conflict, undefined);
assert.equal(scopedJournal.conflict, undefined);
assert.equal(scopedReflection.duplicate, undefined);
assert.deepEqual(
  [...new Set(ledgerEvents
    .filter(event => event.type === "execute" && event.key === sharedOperationKey)
    .map(event => event.scope))].sort(),
  ["captures.create", "journalDraft.save", "journalReflections.create", "journals.create"]
);
assert.equal(activeWriteTransactions, 0);

assert.deepEqual(Object.keys(capturesJournalsOpenApiFragment).sort(), ["components", "paths"]);
assert.strictEqual(capturesJournalsOpenApiFragment.paths, captureJournalPaths);
assert.strictEqual(capturesJournalsOpenApiFragment.components, captureJournalComponents);
assert.deepEqual(Object.keys(captureJournalPaths).sort(), [
  "/captures",
  "/captures/{id}",
  "/captures/{id}/transcription",
  "/journal-draft",
  "/journals",
  "/journals/assist",
  "/journals/{id}",
  "/journals/{id}/reflections",
  "/journals/{id}/reflections/{reflectionId}"
]);

const assembled = {
  ...openApiV1,
  paths: { ...openApiV1.paths, ...captureJournalPaths },
  components: {
    ...openApiV1.components,
    parameters: { ...openApiV1.components.parameters, ...captureJournalComponents.parameters },
    schemas: { ...openApiV1.components.schemas, ...captureJournalComponents.schemas }
  }
};
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const operations = Object.entries(captureJournalPaths).flatMap(([route, pathItem]) => Object.entries(pathItem)
  .filter(([method]) => HTTP_METHODS.has(method))
  .map(([method, operation]) => ({ route, method, operation })));
assert.equal(operations.length, 16);
assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, operations.length);
const allOperationIds = Object.values(assembled.paths).flatMap(pathItem => Object.entries(pathItem))
  .filter(([method]) => HTTP_METHODS.has(method))
  .map(([, operation]) => operation.operationId);
assert.equal(new Set(allOperationIds).size, allOperationIds.length);

function collectRefs(value, refs = []) {
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const nested of Object.values(value)) collectRefs(nested, refs);
  return refs;
}
function resolveRef(document, ref) {
  assert.match(ref, /^#\//);
  return ref.slice(2).split("/").reduce((value, encodedPart) => {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value && Object.hasOwn(value, part), `Unresolved OpenAPI reference: ${ref}`);
    return value[part];
  }, document);
}
for (const ref of collectRefs(assembled)) resolveRef(assembled, ref);
assert.deepEqual(
  captureJournalComponents.schemas.CaptureTranscription.required,
  [
    "status",
    "provider",
    "rawText",
    "polishedText",
    "condensedText",
    "updatedAt",
    "errorCode",
    "condenseErrorCode"
  ]
);

const operationAt = (route, method) => captureJournalPaths[route][method];
const declaredParameters = (route, method) => [
  ...(captureJournalPaths[route].parameters || []),
  ...(operationAt(route, method).parameters || [])
].map(parameter => parameter.$ref ? resolveRef(assembled, parameter.$ref) : parameter);
for (const [route, method, header] of [
  ["/captures", "post", "Idempotency-Key"],
  ["/captures/{id}", "patch", "If-Match"],
  ["/captures/{id}", "delete", "If-Match"],
  ["/journal-draft", "put", "Idempotency-Key"],
  ["/journals", "post", "Idempotency-Key"],
  ["/journals/{id}", "patch", "If-Match"],
  ["/journals/{id}", "delete", "If-Match"],
  ["/journals/{id}/reflections", "post", "Idempotency-Key"],
  ["/journals/{id}/reflections/{reflectionId}", "delete", "If-Match"]
]) {
  const parameter = declaredParameters(route, method)
    .find(candidate => candidate.in === "header" && candidate.name.toLowerCase() === header.toLowerCase());
  assert.ok(parameter, `${method.toUpperCase()} ${route} must declare ${header}`);
  assert.equal(parameter.required, true);
}

assert.equal((await request("account-a", "GET", "/api/v1/not-capture-or-journal")).handled, false);

console.log("Capture/journal regression passed: legacy compatibility, repository isolation, drafts, assist/reflection workflows, transcription scheduling, v1 idempotency/ETag/pagination/delete and 16-operation OpenAPI fragment.");
