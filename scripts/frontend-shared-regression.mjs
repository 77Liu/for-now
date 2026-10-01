import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  escapeHtml,
  inlineMarkdown,
  plainPreview,
  renderMarkdown
} from "../public/frontend/content/index.mjs";
import {
  createOccurrenceDraft,
  entryKeyIntent,
  eventDate,
  eventTimestamp,
  formatDate,
  formatDateKey,
  formatTime,
  localDateKey,
  localDateTimeForDate,
  occurrenceSubmission,
  persistedDateTimeInput,
  toLocalDateTimeInput
} from "../public/frontend/time/index.mjs";
import {
  AUDIO_MAX_BYTES,
  captureAudioIdentity,
  captureAudioPresentation,
  captureRecordPayload,
  captureSpeechIdentity,
  createIndexedDbMediaDraftStore,
  createMemoryMediaDraftStore,
  IMAGE_MAX_BYTES,
  IMAGE_SELECTION_MAX_BYTES,
  imageRecordPayload,
  imageUnderstandingPayload,
  preferredRecorderMime,
  uploadPendingMediaItems,
  uploadOriginalAudio,
  uploadOriginalImages,
  validatedAudioBlob,
  validatedImageFiles,
  TTS_PLAYBACK_RATES,
  normalizeTtsPlaybackRate
} from "../public/frontend/media/index.mjs";
import {
  WEIGHT_BATCH_MAX_ITEMS,
  applyWeightBatchRecognition,
  changeWeightBatchDate,
  createWeightBatchItems,
  nextWeightBatchIndex,
  weightBatchRecordInput
} from "../public/frontend/features/index.mjs";

const volatileMediaStore = createIndexedDbMediaDraftStore({ indexedDBImpl: null });
assert.equal(volatileMediaStore.durable, false);
await volatileMediaStore.put({ owner: "account-a", id: "draft", value: "kept for this session" });
assert.equal((await volatileMediaStore.get("account-a", "draft")).value, "kept for this session");

function verifyTimeZoneCase() {
  if (process.env.TZ === "Asia/Shanghai") {
    const beforeMidnight = "2026-09-28T15:59:59.999Z";
    const atMidnight = "2026-09-28T16:00:00.000Z";
    assert.equal(localDateKey(beforeMidnight), "2026-09-28");
    assert.equal(localDateKey(atMidnight), "2026-09-29");
    assert.equal(toLocalDateTimeInput(beforeMidnight), "2026-09-28T23:59:59");
    assert.equal(toLocalDateTimeInput(atMidnight), "2026-09-29T00:00:00");
    assert.equal(formatDate(atMidnight), "9月29日 00:00");
    assert.equal(formatTime(atMidnight), "00:00:00");
    assert.equal(localDateTimeForDate("2026-09-30", "2026-09-28T16:00:01.000Z"), "2026-09-30T00:00:01");
    assert.equal(eventDate({ createdAt: atMidnight }), "2026-09-29");
    assert.equal(eventDate({ occurredOn: "2026-09-27", occurredAt: atMidnight }), "2026-09-27");
    assert.equal(eventTimestamp({ occurredAt: atMidnight, createdAt: beforeMidnight }), atMidnight);
    assert.equal(persistedDateTimeInput({ createdAt: atMidnight }), "2026-09-29T00:00:00");
    assert.equal(persistedDateTimeInput({ occurredAt: "invalid" }), "");
    return;
  }
  if (process.env.TZ === "America/Los_Angeles") {
    const utcMidnight = "2026-09-29T00:00:00.000Z";
    assert.equal(localDateKey(utcMidnight), "2026-09-28");
    assert.equal(toLocalDateTimeInput(utcMidnight), "2026-09-28T17:00:00");
    assert.equal(formatDate(utcMidnight), "9月28日 17:00");
    assert.equal(formatTime(utcMidnight), "17:00:00");
    return;
  }
  assert.fail(`Unexpected timezone case: ${process.env.TZ}`);
}

if (process.argv.includes("--timezone-case")) {
  verifyTimeZoneCase();
} else {
  const moduleUrls = [
    new URL("../public/frontend/content/index.mjs", import.meta.url),
    new URL("../public/frontend/time/index.mjs", import.meta.url),
    new URL("../public/frontend/media/index.mjs", import.meta.url),
    new URL("../public/frontend/features/health/weight-batch.mjs", import.meta.url)
  ];
  for (const url of moduleUrls) {
    const source = await fs.readFile(url, "utf8");
    assert.doesNotMatch(source, /\b(?:document|window|fetch|XMLHttpRequest|FileReader)\b/, `${url.pathname} must stay independent of DOM globals and network I/O`);
  }

  assert.equal(
    escapeHtml('<script>alert("x")</script>&'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;"
  );
  const unsafe = renderMarkdown([
    '<img src=x onerror="alert(1)">',
    "",
    "[脚本](javascript:alert(1)) [数据](data:text/html,x)",
    "",
    "[站内](/safe?q=1&x=2) [站外](https://example.com/path)"
  ].join("\n"));
  assert.doesNotMatch(unsafe, /<(?:img|script)\b/i);
  assert.doesNotMatch(unsafe, /href="(?:javascript|data):/i);
  assert.match(unsafe, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(unsafe, /<a href="\/safe\?q=1&amp;x=2">站内<\/a>/);
  assert.match(unsafe, /<a href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer">站外<\/a>/);

  const markdown = [
    "# 标题",
    "",
    "第一行",
    "第二行",
    "",
    "- **粗体**",
    "- *斜体*",
    "",
    "> 引用",
    "",
    "| A | B |",
    "| --- | --- |",
    "| `x` | ~~y~~ |",
    "",
    "\\(E=mc^2\\) 与 $a_b$",
    "",
    "$$\\int_0^1 x^2 dx$$",
    "",
    "```html",
    '<strong title="literal">代码</strong>',
    "```"
  ].join("\n");
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /^<h1>标题<\/h1>/);
  assert.match(rendered, /<p>第一行<br>第二行<\/p>/);
  assert.match(rendered, /<ul><li><strong>粗体<\/strong><\/li><li><em>斜体<\/em><\/li><\/ul>/);
  assert.match(rendered, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(rendered, /<table>[\s\S]*<code>x<\/code>[\s\S]*<del>y<\/del>[\s\S]*<\/table>/);
  assert.match(rendered, /<pre><code class="language-html">&lt;strong title=&quot;literal&quot;&gt;代码&lt;\/strong&gt;<\/code><\/pre>$/);
  assert.doesNotMatch(rendered, /\u0000/);
  const latex = [...rendered.matchAll(/class="latex-(?:inline|display)" data-tex="([^"]*)"/g)]
    .map(match => decodeURIComponent(match[1]));
  assert.deepEqual(latex, ["E=mc^2", "a_b", "\\int_0^1 x^2 dx"]);
  assert.equal(
    inlineMarkdown("**粗体**、`<b>代码</b>`、\\(E=mc^2\\)"),
    '<strong>粗体</strong>、<code>&lt;b&gt;代码&lt;/b&gt;</code>、<span class="latex-inline" data-tex="E%3Dmc%5E2"></span>'
  );
  assert.equal(
    plainPreview("![封面](cover.png) [链接](https://example.com) **粗体** \\[x+y\\]"),
    "封面 链接 粗体 x+y"
  );

  assert.equal(formatDateKey("2026-09-29"), "2026年9月29日");
  assert.equal(formatDateKey(""), "");
  const openedAt = new Date(2026, 8, 29, 23, 58, 20);
  const afterMinute = new Date(2026, 8, 29, 23, 59, 40);
  const afterMidnight = new Date(2026, 8, 30, 0, 3, 5);
  const currentDraft = createOccurrenceDraft({ now: openedAt });
  assert.equal(currentDraft.mode, "now");
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: afterMinute }), { timeMode: "now" });
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: afterMidnight }), { timeMode: "now" });
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: new Date(2026, 9, 2, 8, 30, 0) }), { timeMode: "now" });
  const historicalDraft = createOccurrenceDraft({ selectedDate: "2026-09-20", now: openedAt });
  assert.deepEqual(historicalDraft, { mode: "manual", manualValue: "2026-09-20T23:58:20" });
  const editDraft = createOccurrenceDraft({ existing: { occurredAt: "2026-09-28T16:04:03.000Z" }, now: openedAt });
  assert.deepEqual(editDraft, { mode: "manual", manualValue: toLocalDateTimeInput("2026-09-28T16:04:03.000Z") });
  const manualDraft = { mode: "manual", manualValue: "2026-09-15T07:06:05" };
  assert.deepEqual(occurrenceSubmission(manualDraft, { now: afterMidnight }), {
    timeMode: "manual",
    occurredAt: "2026-09-15T07:06:05"
  });
  assert.throws(() => occurrenceSubmission({ mode: "manual", manualValue: "" }), /手动指定发生时间/);
  assert.throws(() => occurrenceSubmission({ mode: "manual", manualValue: "2026-02-31T07:06:05" }), /手动指定发生时间/);
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "tag" }), "commit-tag");
  assert.equal(entryKeyIntent({ key: "," }, { inputKind: "tag" }), "commit-tag");
  assert.equal(entryKeyIntent({ key: "Enter", metaKey: true }, { inputKind: "multiline" }), "submit");
  assert.equal(entryKeyIntent({ key: "Enter", ctrlKey: true }, { inputKind: "field" }), "submit");
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "multiline" }), "newline");
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "field" }), "block-submit");
  assert.equal(entryKeyIntent({ key: "Enter", metaKey: true, isComposing: true }, { inputKind: "field" }), "none");
  const script = fileURLToPath(import.meta.url);
  for (const timezone of ["Asia/Shanghai", "America/Los_Angeles"]) {
    execFileSync(process.execPath, [script, "--timezone-case"], {
      env: { ...process.env, TZ: timezone },
      stdio: "pipe"
    });
  }

  const image = (type, size, name = "image") => ({ type, size, name });
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    const file = image(type, 1);
    assert.deepEqual(validatedImageFiles([file]), [file]);
  }
  assert.throws(() => validatedImageFiles([]), { message: "没有找到可用图片" });
  assert.throws(
    () => validatedImageFiles([image("text/plain", 1), image("image/png", 1)], 1),
    { message: "最多选择 1 张图片" }
  );
  assert.throws(() => validatedImageFiles([image("image/gif", 1)]), {
    message: "只支持 PNG、JPEG 或 WebP 图片"
  });
  assert.equal(validatedImageFiles([image("image/png", IMAGE_MAX_BYTES)]).length, 1);
  assert.throws(() => validatedImageFiles([image("image/png", IMAGE_MAX_BYTES + 1)]), {
    message: "单张图片不得超过 8 MB"
  });
  assert.equal(validatedImageFiles([
    ...Array.from({ length: 6 }, (_, index) => image(index % 2 ? "image/png" : "image/webp", IMAGE_MAX_BYTES))
  ], 8).length, 6);
  assert.throws(() => validatedImageFiles([
    ...Array.from({ length: 6 }, (_, index) => image(index % 2 ? "image/png" : "image/webp", IMAGE_MAX_BYTES)),
    image("image/jpeg", 1)
  ], 8), {
    message: "本次图片合计不得超过 48 MB"
  });
  assert.equal(IMAGE_SELECTION_MAX_BYTES, 48 * 1024 * 1024);
  assert.deepEqual(imageRecordPayload({
    content: "",
    attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"]
  }), {
    content: "",
    attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"]
  });
  assert.throws(() => imageRecordPayload({ content: "", attachmentPaths: [] }), {
    message: "请填写文字或插入图片"
  });
  assert.deepEqual(imageUnderstandingPayload({
    targetType: "capture",
    targetId: "capture-1",
    inputVersion: 2,
    attachmentPaths: ["/attachments/a.png"]
  }), {
    targetType: "capture",
    targetId: "capture-1",
    inputVersion: 2,
    attachmentPaths: ["/attachments/a.png"]
  });
  const audioCapture = {
    id: "capture-audio",
    version: 2,
    content: "朗读这段文字",
    audio: {
      attachmentPath: "/attachments/voice.m4a",
      mimeType: "audio/mp4",
      bytes: 4096,
      durationMs: 1250
    },
    transcription: {
      status: "failed",
      rawText: "",
      polishedText: "",
      updatedAt: "2026-10-02T00:00:00.000Z",
      errorCode: "ASR_PROVIDER_FAILED"
    }
  };
  assert.equal(captureAudioIdentity(audioCapture), captureAudioIdentity(structuredClone(audioCapture)));
  assert.notEqual(captureAudioIdentity(audioCapture), captureAudioIdentity({ ...audioCapture, version: 3 }));
  assert.notEqual(
    captureAudioIdentity(audioCapture),
    captureAudioIdentity({ ...audioCapture, audio: { ...audioCapture.audio, attachmentPath: "/attachments/new.m4a" } })
  );
  assert.notEqual(
    captureSpeechIdentity(audioCapture, "voice-a"),
    captureSpeechIdentity({ ...audioCapture, version: 3 }, "voice-a")
  );
  assert.notEqual(captureSpeechIdentity(audioCapture, "voice-a"), captureSpeechIdentity(audioCapture, "voice-b"));
  assert.deepEqual(TTS_PLAYBACK_RATES, [0.5, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 2]);
  assert.equal(normalizeTtsPlaybackRate("1.5"), 1.5);
  assert.equal(normalizeTtsPlaybackRate(1.7), 1);
  assert.deepEqual(
    captureAudioPresentation(audioCapture, {
      configured: true,
      supportedAsrMimeTypes: ["audio/mp4"]
    }, [{
      id: "task-current-audio",
      kind: "captureTranscription",
      targetId: "capture-audio",
      status: "failed",
      createdAt: "2026-10-02T00:01:00.000Z"
    }]),
    {
      audioKey: captureAudioIdentity(audioCapture),
      audioReady: true,
      audioStatus: "原音可播放",
      transcriptionStatus: "failed",
      transcriptionMessage: "转写暂时失败。原音已保留，可以再次尝试。",
      transcriptionTaskId: "task-current-audio",
      canTranscribe: true
    }
  );
  const mediaDraftStore = createMemoryMediaDraftStore();
  const pendingImage = new Blob(["pending-image"], { type: "image/png" });
  await mediaDraftStore.put({
    owner: "account-a",
    id: "capture",
    uploadRequestId: "upload-draft-1",
    items: [{ blob: pendingImage, name: "capture.png", type: pendingImage.type }]
  });
  await mediaDraftStore.put({
    owner: "account-b",
    id: "capture",
    uploadRequestId: "upload-draft-2",
    items: [{ blob: new Blob(["private-b"], { type: "image/png" }), name: "private.png", type: "image/png" }]
  });
  const restoredMediaDraft = await mediaDraftStore.get("account-a", "capture");
  assert.equal(restoredMediaDraft.uploadRequestId, "upload-draft-1");
  assert.equal(restoredMediaDraft.items[0].name, "capture.png");
  assert.equal(await restoredMediaDraft.items[0].blob.text(), "pending-image");
  await mediaDraftStore.delete("account-a", "capture");
  assert.equal(await mediaDraftStore.get("account-a", "capture"), null);
  assert.equal((await mediaDraftStore.get("account-b", "capture")).items[0].name, "private.png");
  await mediaDraftStore.clear("account-b");
  assert.equal(await mediaDraftStore.get("account-b", "capture"), null);
  const uploadAttempts = [];
  let partialItems = [];
  await assert.rejects(uploadPendingMediaItems({
    items: [
      { file: new Blob(["first"], { type: "image/png" }), name: "first.png" },
      { file: new Blob(["second"], { type: "image/png" }), name: "second.png" }
    ],
    createId: (() => {
      let id = 0;
      return () => `media-${++id}`;
    })(),
    upload: async (_file, key) => {
      uploadAttempts.push(key);
      if (key === "media-2") throw new Error("second image failed");
      return "/attachments/first.png";
    },
    onProgress: async items => {
      partialItems = items.map(item => ({ ...item }));
    }
  }), error => {
    assert.deepEqual(error.failedIndexes, [1]);
    assert.match(error.errors[0].message, /second image failed/);
    return true;
  });
  assert.deepEqual(uploadAttempts, ["media-1", "media-2"]);
  assert.equal(partialItems[0].uploadedPath, "/attachments/first.png");
  assert.equal(partialItems[1].uploadedPath, undefined);
  const resumedUpload = await uploadPendingMediaItems({
    items: partialItems,
    upload: async (_file, key) => {
      uploadAttempts.push(key);
      return "/attachments/second.png";
    }
  });
  assert.deepEqual(uploadAttempts, ["media-1", "media-2", "media-2"]);
  assert.deepEqual(resumedUpload.attachmentPaths, ["/attachments/first.png", "/attachments/second.png"]);
  assert.deepEqual(resumedUpload.uploadedPaths, ["/attachments/first.png", "/attachments/second.png"]);
  let isolatedItems = [];
  await assert.rejects(uploadPendingMediaItems({
    items: [
      { file: new Blob(["failed"], { type: "image/png" }), name: "failed.png" },
      { file: new Blob(["saved"], { type: "image/png" }), name: "saved.png" }
    ],
    createId: (() => {
      let id = 0;
      return () => `isolated-${++id}`;
    })(),
    upload: async (_file, key) => {
      if (key === "isolated-1") throw new Error("first image failed");
      return "/attachments/saved.png";
    },
    onProgress: async items => {
      isolatedItems = items.map(item => ({ ...item }));
    }
  }), error => {
    assert.deepEqual(error.failedIndexes, [0]);
    return true;
  });
  assert.equal(isolatedItems[0].uploadedPath, undefined);
  assert.equal(isolatedItems[1].uploadedPath, "/attachments/saved.png");
  const uploadCalls = [];
  assert.deepEqual(await uploadOriginalImages({
    request: async (url, options) => {
      uploadCalls.push({ url, options });
      return { attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"] };
    },
    images: ["data:image/png;base64,AA==", "data:image/webp;base64,AA=="],
    idempotencyKey: "upload-originals-1"
  }), ["/attachments/a.png", "/attachments/b.webp"]);
  assert.equal(uploadCalls[0].url, "/api/images/upload");
  assert.equal(uploadCalls[0].options.headers["idempotency-key"], "upload-originals-1");
  assert.deepEqual(JSON.parse(uploadCalls[0].options.body), {
    purpose: "original",
    images: ["data:image/png;base64,AA==", "data:image/webp;base64,AA=="]
  });
  const audioBlob = new Blob(["audio"], { type: "audio/mp4;codecs=mp4a.40.2" });
  assert.deepEqual(validatedAudioBlob(audioBlob, 1250), {
    blob: audioBlob,
    mimeType: "audio/mp4",
    bytes: 5,
    durationMs: 1250
  });
  assert.throws(() => validatedAudioBlob(new Blob(["bad"], { type: "audio/mpeg" }), 1000), /M4A/);
  assert.throws(() => validatedAudioBlob(new Blob(["large"], { type: "audio/mp4" }), 1000, { maxBytes: 2 }), /大小/);
  assert.throws(() => validatedAudioBlob(audioBlob, 10), /时长/);
  assert.equal(preferredRecorderMime({ isTypeSupported: type => type === "audio/webm;codecs=opus" }), "audio/webm;codecs=opus");
  assert.deepEqual(captureRecordPayload({
    content: "",
    attachmentPaths: [],
    audio: {
      attachmentPath: "/attachments/voice.m4a",
      mimeType: "audio/mp4",
      bytes: AUDIO_MAX_BYTES,
      durationMs: 600000
    }
  }), {
    content: "",
    attachmentPaths: [],
    audio: {
      attachmentPath: "/attachments/voice.m4a",
      mimeType: "audio/mp4",
      bytes: AUDIO_MAX_BYTES,
      durationMs: 600000
    }
  });
  assert.throws(() => captureRecordPayload({ content: "", attachmentPaths: [], audio: null }), /文字、插入图片或录下语音/);
  assert.throws(() => captureRecordPayload({
    audio: { attachmentPath: "/attachments/voice.webm", mimeType: "audio/mp4", bytes: 5, durationMs: 1250 }
  }), /格式不正确/);
  const audioUploadCalls = [];
  assert.deepEqual(await uploadOriginalAudio({
    request: async (url, options) => {
      audioUploadCalls.push({ url, options });
      return {
        audio: {
          attachmentPath: "/attachments/voice.m4a",
          mimeType: "audio/mp4",
          bytes: 5,
          durationMs: 1250
        }
      };
    },
    audio: "data:audio/mp4;base64,AAAA",
    durationMs: 1250,
    idempotencyKey: "upload-audio-1"
  }), {
    attachmentPath: "/attachments/voice.m4a",
    mimeType: "audio/mp4",
    bytes: 5,
    durationMs: 1250
  });
  assert.equal(audioUploadCalls[0].url, "/api/audio/upload");
  assert.equal(audioUploadCalls[0].options.headers["idempotency-key"], "upload-audio-1");

  const weightFiles = [{ name: "day-a.png" }, { name: "day-b.png" }];
  const weightItems = createWeightBatchItems(weightFiles, {
    assignedDate: "2026-09-27",
    createId: (() => { let id = 0; return () => `weight-item-${++id}`; })()
  });
  assert.equal(WEIGHT_BATCH_MAX_ITEMS, 8);
  assert.deepEqual(weightItems.map(item => [item.itemId, item.assignedDate, item.status]), [
    ["weight-item-1", "2026-09-27", "selected"],
    ["weight-item-2", "2026-09-27", "selected"]
  ]);
  assert.throws(() => createWeightBatchItems(new Array(9).fill({}), { assignedDate: "2026-09-27" }), /最多选择 8 张/);
  const recognizedWeight = applyWeightBatchRecognition(weightItems[0], {
    date: "2026-09-26", measuredAt: "2026-09-26T07:30:00", measuredWeight: 70
  }, { requestId: "recognition-1", expectedRevision: 1 });
  assert.equal(recognizedWeight.stale, false);
  assert.equal(recognizedWeight.item.dateMismatch, true);
  const reassignedWeight = changeWeightBatchDate(recognizedWeight.item, "2026-09-26");
  assert.equal(reassignedWeight.dateMismatch, false);
  assert.equal(reassignedWeight.revision, 2);
  assert.equal(applyWeightBatchRecognition(reassignedWeight, {}, { expectedRevision: 1 }).stale, true);
  assert.deepEqual(weightBatchRecordInput({ ...reassignedWeight, uploadedPath: "/attachments/weight-a.png" }, {
    occurredAt: "2026-09-27T08:15:00", measuredWeight: 70
  }), {
    occurredAt: "2026-09-26T08:15:00",
    measuredWeight: 70,
    type: "weight",
    source: "screenshot",
    timeMode: "manual",
    attachmentPaths: ["/attachments/weight-a.png"]
  });
  assert.equal(nextWeightBatchIndex([{}, {}], 2), 1);

  console.log("Frontend shared regression passed: HTML safety, Markdown/LaTeX fidelity, local timezone handling, media validation, recovery helpers and upload contracts.");
}
