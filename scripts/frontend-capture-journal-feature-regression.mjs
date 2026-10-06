import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMemoryMediaDraftStore } from "../public/frontend/media/index.mjs";
import { createCaptureAudioDraft } from "../public/frontend/features/capture-journal/capture-audio.mjs";
import { createCaptureDraftStore } from "../public/frontend/features/capture-journal/capture-drafts.mjs";
import {
  captureCardMarkup,
  journalCardMarkup,
  matchesFeedSearch
} from "../public/frontend/features/capture-journal/presentation.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

assert.equal(matchesFeedSearch("  原始   转写 ", "一段原始转写内容"), true);
assert.equal(matchesFeedSearch("不存在", ["标题", "正文"]), false);

const captureMarkup = captureCardMarkup({
  item: {
    id: "capture-1",
    content: "正文",
    tags: ["记录"],
    occurredAt: "2026-10-06T08:00:00.000Z",
    version: 2,
    audio: {
      attachmentPath: "/attachments/voice.webm",
      mimeType: "audio/webm",
      bytes: 1024,
      durationMs: 1200
    },
    transcription: {
      status: "failed",
      rawText: "原始转写",
      polishedText: "整理稿"
    }
  },
  snapshot: {
    thoughts: [],
    aiTasks: [],
    speech: {
      configured: true,
      supportedAsrMimeTypes: ["audio/webm"],
      voices: [],
      assets: []
    }
  },
  appUrl: value => `/now${value}`,
  contentImagesMarkup: () => ""
});
assert.match(captureMarkup, /data-capture-id="capture-1"/);
assert.match(captureMarkup, /data-capture-transcribe="capture-1"/);
assert.match(captureMarkup, /原始转写/);
assert.match(captureMarkup, /AI 整理稿/);
assert.match(captureMarkup, /data-speech-source-version="2"/);

const journalMarkup = journalCardMarkup({
  item: {
    id: "journal-1",
    title: "一天",
    content: "原文",
    occurredAt: "2026-10-06T08:00:00.000Z",
    createdAt: "2026-10-06T08:00:00.000Z",
    updatedAt: "2026-10-06T09:00:00.000Z",
    reflections: [{
      id: "reflection-1",
      content: "回望",
      sourceUpdatedAt: "2026-10-06T08:00:00.000Z",
      createdAt: "2026-10-06T10:00:00.000Z"
    }]
  },
  contextReceiptMarkup: () => ""
});
assert.match(journalMarkup, /data-journal-id="journal-1"/);
assert.match(journalMarkup, /基于修改前版本/);
assert.match(journalMarkup, /再次回望/);

const objectUrls = {
  sequence: 0,
  revoked: [],
  createObjectURL() {
    return `blob:test-${++this.sequence}`;
  },
  revokeObjectURL(value) {
    this.revoked.push(value);
  }
};
let accountId = "account-a";
let uploadGate = null;
const requests = [];
const store = createMemoryMediaDraftStore();
const changes = [];
const audio = createCaptureAudioDraft({
  store,
  getAccountId: () => accountId,
  isEditing: () => false,
  presentError: error => ({ message: error.message }),
  onChange: snapshot => changes.push(snapshot),
  encodeAudio: async () => "data:audio/webm;base64,dGVzdA==",
  readDuration: async () => 1200,
  request: async (url, options) => {
    requests.push([url, options]);
    if (url === "/api/audio/upload") return uploadGate
      ? uploadGate.promise
      : {
          audio: {
            attachmentPath: "/attachments/voice.webm",
            mimeType: "audio/webm",
            bytes: 5,
            durationMs: 1200
          }
        };
    if (url === "/api/audio/discard") {
      return { discarded: [JSON.parse(options.body).attachmentPath] };
    }
    throw new Error(`Unexpected request: ${url}`);
  },
  objectUrls,
  createId: () => "audio-request-1",
  now: () => 1000,
  setTimer: () => 1,
  clearTimer: () => {},
  confirmReplace: () => true
});

const blob = new Blob(["voice"], { type: "audio/webm" });
await audio.importFile(blob);
assert.equal(audio.snapshot().blob, blob);
assert.equal((await store.get("account-a", "capture-audio")).audio.blob.size, blob.size);
uploadGate = deferred();
const concurrentFirst = audio.forSubmission();
const concurrentSecond = audio.forSubmission();
while (requests.filter(([url]) => url === "/api/audio/upload").length < 1) {
  await new Promise(resolve => setImmediate(resolve));
}
assert.equal(
  requests.filter(([url]) => url === "/api/audio/upload").length,
  1,
  "concurrent submissions must share one upload lease"
);
uploadGate.resolve({
  audio: {
    attachmentPath: "/attachments/voice.webm",
    mimeType: "audio/webm",
    bytes: 5,
    durationMs: 1200
  }
});
const [firstUpload, secondUpload] = await Promise.all([concurrentFirst, concurrentSecond]);
assert.deepEqual(firstUpload, secondUpload);
uploadGate = null;
assert.equal(audio.snapshot().uploadedPath, "/attachments/voice.webm");
await audio.complete();
assert.equal(await store.get("account-a", "capture-audio"), null);
assert.equal(objectUrls.revoked.includes("blob:test-1"), true);

await audio.importFile(blob);
uploadGate = deferred();
const previousUploadCount = requests.filter(([url]) => url === "/api/audio/upload").length;
const staleUpload = audio.forSubmission();
while (requests.filter(([url]) => url === "/api/audio/upload").length === previousUploadCount) {
  await new Promise(resolve => setImmediate(resolve));
}
accountId = "account-b";
audio.resetSession();
uploadGate.resolve({
  audio: {
    attachmentPath: "/attachments/late.webm",
    mimeType: "audio/webm",
    bytes: 5,
    durationMs: 1200
  }
});
await assert.rejects(staleUpload, { name: "AbortError" });
assert.equal(audio.snapshot().uploadedPath, "");
assert.ok(requests.some(([url, options]) => (
  url === "/api/audio/discard"
  && JSON.parse(options.body).attachmentPath === "/attachments/late.webm"
)));

const permissionGate = deferred();
let stoppedTracks = 0;
const pendingAudio = createCaptureAudioDraft({
  store: createMemoryMediaDraftStore(),
  getAccountId: () => accountId,
  isEditing: () => false,
  presentError: error => ({ message: error.message }),
  encodeAudio: async () => "data:audio/webm;base64,dGVzdA==",
  readDuration: async () => 1200,
  request: async () => ({ discarded: [] }),
  mediaDevices: { getUserMedia: () => permissionGate.promise },
  MediaRecorderConstructor: class {},
  objectUrls,
  createId: () => "pending-request",
  now: () => 1000,
  setTimer: () => 1,
  clearTimer: () => {},
  confirmReplace: () => true
});
const pendingStart = pendingAudio.start();
pendingAudio.resetSession();
permissionGate.resolve({
  getTracks: () => [{ stop: () => { stoppedTracks += 1; } }]
});
assert.equal(await pendingStart, false);
assert.equal(stoppedTracks, 1);
assert.equal(pendingAudio.snapshot().active, false);

await store.put({
  owner: "account-a",
  id: "capture-audio",
  audio: {
    blob,
    mimeType: "audio/webm",
    bytes: blob.size,
    durationMs: 1200
  }
});
assert.equal(await audio.restore("account-a"), false, "foreign owner restore must be ignored");
accountId = "account-a";
audio.resetSession();
assert.equal(await audio.restore("account-a"), true);
assert.equal(audio.snapshot().blob.size, blob.size);

let recorderClock = 1000;
let timerCallback = null;
const clearedTimers = [];
let recorderTrackStops = 0;
const recorderUrls = {
  sequence: 0,
  revoked: [],
  createObjectURL() {
    return `blob:recorder-${++this.sequence}`;
  },
  revokeObjectURL(value) {
    this.revoked.push(value);
  }
};
class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }

  constructor(stream, { mimeType = "audio/webm" } = {}) {
    super();
    this.stream = stream;
    this.mimeType = mimeType;
    this.state = "inactive";
  }

  start(interval) {
    this.interval = interval;
    this.state = "recording";
  }

  pause() {
    this.state = "paused";
  }

  resume() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    const data = new Event("dataavailable");
    Object.defineProperty(data, "data", {
      value: new Blob(["recorded"], { type: this.mimeType })
    });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}
const recorderAudio = createCaptureAudioDraft({
  store: createMemoryMediaDraftStore(),
  getAccountId: () => "recorder-account",
  isEditing: () => false,
  presentError: error => ({ message: error.message }),
  encodeAudio: async () => "data:audio/webm;base64,dGVzdA==",
  readDuration: async () => 1200,
  request: async () => ({ discarded: [] }),
  mediaDevices: {
    async getUserMedia() {
      return {
        getTracks: () => [{
          stop() {
            recorderTrackStops += 1;
          }
        }]
      };
    }
  },
  MediaRecorderConstructor: FakeMediaRecorder,
  objectUrls: recorderUrls,
  createId: () => "recorder-request",
  now: () => recorderClock,
  setTimer(callback, interval) {
    assert.equal(interval, 250);
    timerCallback = callback;
    return 9;
  },
  clearTimer(timer) {
    clearedTimers.push(timer);
  },
  confirmReplace: () => true
});
assert.equal(await recorderAudio.start(), true);
assert.equal(recorderAudio.snapshot().active, true);
assert.equal(recorderAudio.snapshot().recordingState, "recording");
recorderClock = 1800;
assert.equal(recorderAudio.togglePause(), true);
assert.equal(recorderAudio.snapshot().recordingState, "paused");
recorderClock = 2300;
timerCallback();
assert.equal(recorderAudio.togglePause(), true);
recorderClock = 4000;
await recorderAudio.stop();
assert.equal(recorderAudio.snapshot().active, false);
assert.equal(recorderAudio.snapshot().durationMs, 2500);
assert.equal(recorderTrackStops, 1);
assert.ok(clearedTimers.includes(9));
assert.equal(recorderAudio.snapshot().preview, "blob:recorder-1");
await recorderAudio.clear();
assert.deepEqual(recorderUrls.revoked, ["blob:recorder-1"]);

const sessionValues = new Map();
const storage = {
  getItem(key) {
    return sessionValues.get(key) || null;
  },
  setItem(key, value) {
    sessionValues.set(key, value);
  },
  removeItem(key) {
    sessionValues.delete(key);
  }
};
let draftAccountId = "draft-a";
const contentField = {
  type: "text",
  name: "content",
  id: "capture-content",
  value: "待恢复正文",
  checked: false,
  selectionStart: 2,
  selectionEnd: 4,
  focusCalled: false,
  focus() {
    this.focusCalled = true;
  },
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
};
const fileField = {
  type: "file",
  name: "images",
  id: "capture-images",
  get value() {
    return "C:\\fakepath\\capture.png";
  },
  set value(next) {
    if (next) throw new DOMException("File inputs reject programmatic values", "InvalidStateError");
  }
};
const captureForm = {
  ownerDocument: { activeElement: contentField },
  hidden: false,
  dataset: { requestId: "capture-request" },
  querySelectorAll: () => [contentField, fileField]
};
const captureDrafts = createCaptureDraftStore({
  storage,
  getAccountId: () => draftAccountId
});
assert.equal(captureDrafts.save(captureForm, ["长期"]), true);
assert.equal(
  JSON.parse(sessionValues.get("cike:session-drafts:draft-a")).captureForm.fields
    .some(field => field.key === "name:images"),
  false
);
contentField.value = "";
contentField.selectionStart = 0;
contentField.selectionEnd = 0;
delete captureForm.dataset.requestId;
assert.deepEqual(captureDrafts.restore(captureForm), {
  restored: true,
  tags: ["长期"]
});
assert.equal(contentField.value, "待恢复正文");
assert.equal(captureForm.dataset.requestId, "capture-request");
assert.equal(contentField.focusCalled, true);
assert.deepEqual([contentField.selectionStart, contentField.selectionEnd], [2, 4]);
draftAccountId = "draft-b";
assert.equal(captureDrafts.restore(captureForm), null);
draftAccountId = "draft-a";
assert.equal(captureDrafts.clear(), true);
assert.deepEqual(captureDrafts.restore(captureForm), { restored: false, tags: [] });

const runtime = await readFile(
  new URL("../public/frontend/app/runtime.mjs", import.meta.url),
  "utf8"
);
for (const removed of [
  "function renderCaptures(",
  "function renderJournals(",
  "function startCaptureAudioRecording(",
  "function captureSubmissionError(",
  "const captureDraftAdapter="
]) {
  assert.equal(runtime.includes(removed), false, `runtime retains F6 implementation: ${removed}`);
}
assert.match(runtime, /import\("\.\.\/features\/capture-journal\/index\.mjs"\)/);
assert.match(runtime, /descriptors\.captures=.*loadCaptureJournalPage\("captures"\)/);
assert.match(runtime, /descriptors\.journals=.*loadCaptureJournalPage\("journals"\)/);
assert.ok(changes.length > 0);

console.log(
  "Frontend capture/journal checks passed: presentation, recording lifecycle, exact URL "
  + "cleanup, upload leases, account-scoped drafts, late compensation and lazy wiring."
);
