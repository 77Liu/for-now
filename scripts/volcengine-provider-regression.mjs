import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { loadAppConfig } from "../src/config/index.mjs";
import {
  canonicalQuery,
  createAsrAudioRequest,
  createAsrFullRequest,
  createVolcengineSpeechTransport,
  createVolcengineVisionTransport,
  parseAsrServerFrame,
  signVolcengineRequest,
  VOLCENGINE_TTS_VOICES
} from "../src/infrastructure/ai-providers/index.mjs";

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers }
});

assert.equal(canonicalQuery({ Version: "2020-08-26", Action: "OCR Normal", Empty: "" }), "Action=OCR%20Normal&Empty=&Version=2020-08-26");
const signed = signVolcengineRequest({
  method: "POST",
  pathname: "/",
  params: { Action: "OCRNormal", Version: "2020-08-26" },
  body: "image_base64=YWJj&mode=text_block",
  headers: {
    host: "visual.volcengineapi.com",
    "content-type": "application/x-www-form-urlencoded"
  },
  accessKeyId: "AKLTEXAMPLE",
  secretAccessKey: "secret-example",
  region: "cn-north-1",
  service: "cv",
  date: new Date("2026-10-01T02:03:04Z")
});
assert.equal(signed.signature, "a5b3a392e3138f80be9a3a94bbbb983c9e84762ecd1ccaf9894feeed34f45d39");
assert.match(signed.headers.authorization, /^HMAC-SHA256 Credential=AKLTEXAMPLE\/20261001\/cn-north-1\/cv\/request,/);
assert.equal(signed.headers["x-date"], "20261001T020304Z");

const visionCalls = [];
const vision = createVolcengineVisionTransport({
  accessKeyId: "AKLTEXAMPLE",
  secretAccessKey: "secret-example",
  now: () => new Date("2026-10-01T02:03:04Z"),
  fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    const body = new URLSearchParams(options.body);
    visionCalls.push({ parsed, options, body });
    if (parsed.searchParams.get("Action") === "OCRNormal") {
      return jsonResponse({
        code: 10000,
        data: {
          line_texts: ["第一行", "第二行"],
          line_rects: [{ x: 1, y: 2, width: 3, height: 4 }],
          line_probs: [0.99]
        },
        request_id: "ocr-request"
      });
    }
    return jsonResponse({
      code: 10000,
      data: {
        markdown: "# 标题\n\n正文",
        detail: JSON.stringify([{ page_id: 0, page_md: "# 标题" }])
      },
      request_id: "document-request"
    });
  }
});
assert.equal(vision.configured, true);
assert.deepEqual(await vision.recognizeText({ data: Buffer.from("image") }), {
  provider: "volcengine-ocr",
  text: "第一行\n第二行",
  lines: ["第一行", "第二行"],
  lineRects: [{ x: 1, y: 2, width: 3, height: 4 }],
  lineProbabilities: [0.99],
  providerRequestId: "ocr-request"
});
assert.deepEqual(await vision.parseDocument({ data: Buffer.from("%PDF"), mimeType: "application/pdf" }), {
  provider: "volcengine-document",
  markdown: "# 标题\n\n正文",
  detail: [{ page_id: 0, page_md: "# 标题" }],
  providerRequestId: "document-request"
});
assert.equal(visionCalls[0].parsed.searchParams.get("Version"), "2020-08-26");
assert.equal(visionCalls[0].body.get("image_base64"), Buffer.from("image").toString("base64"));
assert.match(visionCalls[0].options.headers.authorization, /SignedHeaders=content-type;host;x-date/);
assert.equal(visionCalls[1].parsed.searchParams.get("Action"), "OCRPdf");
assert.equal(visionCalls[1].body.get("version"), "v3");
assert.equal(visionCalls[1].body.get("file_type"), "pdf");
assert.throws(() => vision.parseDocumentDataUrl("data:text/plain;base64,SGk="), /PDF/);
await assert.rejects(createVolcengineVisionTransport().recognizeText({ data: Buffer.from("x") }), {
  code: "VISUAL_NOT_CONFIGURED",
  statusCode: 503
});

/** 构造带实际PCM参数的合成WAV，验证音频字节与发送时间，不含用户原音。 */
function wavFixture({ durationMs = 450, rate = 16000, channel = 1, unknownDataLength = false } = {}) {
  const blockAlign = channel * 2;
  const data = Buffer.alloc(Math.round(rate * durationMs / 1000) * blockAlign, 0x35);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(unknownDataLength ? 0xffffffff : data.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channel, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(unknownDataLength ? 0xffffffff : data.length, 40);
  return Buffer.concat([header, data]);
}

function serverFrame(payload, { final = true } = {}) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const sequence = Buffer.allocUnsafe(4);
  sequence.writeInt32BE(final ? -1 : 1);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([
    Buffer.from([0x11, 0x90 | (final ? 0x3 : 0x1), 0x11, 0x00]),
    sequence,
    size,
    compressed
  ]);
}

function serverErrorFrame(code, message) {
  const compressed = gzipSync(Buffer.from(JSON.stringify({ error: message })));
  const errorCode = Buffer.allocUnsafe(4);
  errorCode.writeUInt32BE(code);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x01, 0x00]),
    errorCode,
    size,
    compressed
  ]);
}

const fullRequest = createAsrFullRequest({ audio: { format: "wav" }, request: { model_name: "bigmodel" } });
assert.equal(fullRequest[0], 0x11);
assert.equal(fullRequest[1], 0x10);
assert.deepEqual(JSON.parse(gunzipSync(fullRequest.subarray(8)).toString("utf8")), {
  audio: { format: "wav" },
  request: { model_name: "bigmodel" }
});
assert.equal(createAsrAudioRequest(Buffer.from("abc"), { final: true })[1], 0x22);
const parsedFrame = parseAsrServerFrame(serverFrame({ code: 0, result: { text: "识别结果" } }));
assert.equal(parsedFrame.final, true);
assert.deepEqual(JSON.parse(parsedFrame.payload.toString("utf8")), { code: 0, result: { text: "识别结果" } });

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    });
  }

  send(data, _options, callback) {
    this.sent.push(Buffer.from(data));
    callback();
    if ((data[1] & 0x0f) === 0x2) {
      queueMicrotask(() => this.emit("message", serverFrame({
        code: 0,
        result: {
          text: "今天想把重要的事情先做完。",
          additions: { log_id: "asr-log-id" },
          utterances: [{ start_time: 0, end_time: 1250 }]
        }
      })));
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }

  terminate() {
    this.close();
  }
}
MockWebSocket.instances = [];

const speechCalls = [];
const ttsAudio = Buffer.from([0x49, 0x44, 0x33, 0x04]);
const speech = createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  sleep: async () => {},
  fetchImpl: async (url, options) => {
    speechCalls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith("/tts/unidirectional")) {
      return jsonResponse({ code: 0, message: "OK", data: ttsAudio.toString("base64"), usage: { text_words: 4 } }, 200, {
        "x-tt-logid": "tts-log-id"
      });
    }
    if (url.endsWith("/tts/submit")) {
      return jsonResponse({ code: 20000000, message: "ok", data: { task_id: "long-task", task_status: 1 } });
    }
    if (url.endsWith("/tts/query")) {
      return jsonResponse({ code: 20000000, message: "ok", data: { task_id: "long-task", task_status: 2, audio_url: "https://audio.example/result.mp3", url_expire_time: 42 } });
    }
    if (url.endsWith("/auc/bigmodel/submit")) {
      return jsonResponse({ task_id: "asr-file-task", "X-Api-Status-Code": "20000000" });
    }
    return jsonResponse({ result: { text: "文件识别结果", utterances: [] } }, 200, {
      "x-api-status-code": "20000000"
    });
  }
});
assert.equal(speech.voices.length, 4);
assert.ok(speech.voices.every(voice => voice.sampleText === "此刻，听见自己的想法，也看见正在发生的生活。"));
assert.ok(speech.voices.every(voice => voice.samplePath === `/assets/audio/voice-previews/${voice.id}.mp3`));
assert.equal(speech.defaultVoice, "zh_male_shaonianzixin_uranus_bigtts");
const synthesized = await speech.synthesize({ text: "测试朗读" });
assert.deepEqual(synthesized.audio, ttsAudio);
assert.equal(synthesized.mimeType, "audio/mpeg");
assert.equal(speechCalls[0].options.headers["x-api-key"], "speech-secret");
assert.equal(speechCalls[0].body.req_params.audio_params.speech_rate, -10);
assert.equal(speechCalls[0].body.req_params.post_process.pitch, 0);
assert.equal(speechCalls[0].body.req_params.audio_params.loudness_rate, 0);
await speech.synthesize({ text: "账户默认生成语速", generationRate: 25 });
assert.equal(speechCalls[1].body.req_params.audio_params.speech_rate, 25);
assert.deepEqual(await speech.submitLongText({
  text: "长文本",
  generationRate: -25,
  userId: "account-a"
}), { taskId: "long-task", status: 1 });
assert.equal(speechCalls[2].body.req_params.audio_params.speech_rate, -25);
assert.deepEqual(await speech.queryLongText({ taskId: "long-task" }), {
  taskId: "long-task",
  status: 2,
  audioUrl: "https://audio.example/result.mp3",
  expiresAt: 42
});
assert.deepEqual(await speech.submitRecording({
  audioUrl: "https://audio.example/voice.m4a",
  mimeType: "audio/mp4"
}), { taskId: "asr-file-task" });
assert.deepEqual(await speech.queryRecording({ taskId: "asr-file-task" }), {
  taskId: "asr-file-task",
  statusCode: "20000000",
  rawText: "文件识别结果",
  utterances: []
});
assert.deepEqual(await speech.transcribe({ audio: wavFixture(), mimeType: "audio/wav" }), {
  provider: "volcengine-seedasr-2.0",
  rawText: "今天想把重要的事情先做完。",
  providerRequestId: "asr-log-id",
  durationMs: 1250
});
assert.equal(MockWebSocket.instances[0].options.headers["X-Api-Key"], "speech-secret");
assert.equal(MockWebSocket.instances[0].options.headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
// 使用虚拟等待检查时序，同时逐字节核对原WAV、尾音与唯一终包。
const packetSleeps = [];
let packetClock = 0;
class PacedWebSocket extends MockWebSocket {
  send(data, options, callback) {
    (this.sendTimes ||= []).push(packetClock);
    super.send(data, options, callback);
  }
}
const pacedInput = wavFixture({ durationMs: 450, unknownDataLength: true });
const pacedSpeech = createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret", WebSocketImpl: PacedWebSocket,
  sleep: async milliseconds => {
    packetSleeps.push(milliseconds);
    packetClock += milliseconds;
  }
});
await pacedSpeech.transcribe({ audio: pacedInput, mimeType: "audio/wav" });
const pacedSocket = MockWebSocket.instances.at(-1);
const audioFrames = pacedSocket.sent.filter(frame => (frame[1] >> 4) === 2);
assert.deepEqual(packetSleeps, [200, 200, 50]);
assert.deepEqual(pacedSocket.sendTimes, [0, 0, 200, 400, 450]);
assert.deepEqual(Buffer.concat(audioFrames.map(frame => gunzipSync(frame.subarray(8)))), pacedInput);
assert.equal(audioFrames.filter(frame => (frame[1] & 0xf) === 2).length, 1);
assert.equal(gunzipSync(audioFrames.at(-1).subarray(8)).length, 0);
const pacedPayload = JSON.parse(gunzipSync(pacedSocket.sent[0].subarray(8)));
assert.deepEqual(pacedPayload.audio, { format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1 });
assert.equal(pacedPayload.request.result_type, "full");

// 中间帧不能提前结算；最终全量正文、provider实测总时长都必须返回。
const completeText = "合成验收文本。".repeat(500);
class FinalResultWebSocket extends MockWebSocket {
  send(data, _options, callback) {
    this.sent.push(Buffer.from(data));
    callback();
    queueMicrotask(() => this.emit("message", serverFrame({
      code: 0, audio_info: { duration: 450 },
      result: {
        text: (data[1] & 0xf) === 2 ? completeText : "中间片段",
        utterances: [{ start_time: 20, end_time: 300 }]
      }
    }, { final: (data[1] & 0xf) === 2 })));
  }
}
const finalResult = await createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret", WebSocketImpl: FinalResultWebSocket, sleep: async () => {}
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav" });
assert.equal(finalResult.rawText, completeText);
assert.equal(finalResult.durationMs, 450);

// 取消可能发生在send回调或等待中；完成态之后不允许多发音频或尾包。
for (const cancelStage of ["before-prepare", "full-request", "audio-send", "pacing"]) {
  const controller = new AbortController();
  let prepareCalls = 0;
  class CancelWebSocket extends MockWebSocket {
    send(data, options, callback) {
      super.send(data, options, callback);
      if ((cancelStage === "full-request" && (data[1] >> 4) === 1)
        || (cancelStage === "audio-send" && (data[1] >> 4) === 2)) controller.abort();
    }
  }
  const beforeInstances = MockWebSocket.instances.length;
  if (cancelStage === "before-prepare") controller.abort();
  const operation = createVolcengineSpeechTransport({ asrMode: "streaming",
    apiKey: "speech-secret", WebSocketImpl: CancelWebSocket,
    prepareStreamingAudio: async value => { prepareCalls += 1; return value; },
    sleep: async () => { if (cancelStage === "pacing") controller.abort(); }
  }).transcribe({ audio: wavFixture(), mimeType: "audio/wav", signal: controller.signal });
  await assert.rejects(operation, { name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  if (cancelStage === "before-prepare") {
    assert.equal(prepareCalls, 0);
    assert.equal(MockWebSocket.instances.length, beforeInstances);
  } else {
    const socket = MockWebSocket.instances.at(-1);
    assert.equal(socket.sent.length, cancelStage === "full-request" ? 1 : 2);
    assert.equal(socket.sent.some(frame => (frame[1] & 0xf) === 2), false);
  }
}

// provider在全部音频/终包前提前结束，不能把中间片段当完整成功。
class EarlyFinalWebSocket extends MockWebSocket {
  send(data, _options, callback) {
    this.sent.push(Buffer.from(data));
    callback();
    queueMicrotask(() => this.emit("message", serverFrame({ code: 0, result: { text: "提前结果" } })));
  }
}
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret", WebSocketImpl: EarlyFinalWebSocket, sleep: async () => {}
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav" }), { code: "ASR_EARLY_FINAL" });
assert.equal(MockWebSocket.instances.at(-1).sent.length, 1);

// 默认有取消能力的等待也必须被立即清理；同步close不能覆盖取消归属。
const defaultPacingAbort = new AbortController();
class AbortDuringDefaultWait extends MockWebSocket {
  send(data, options, callback) {
    super.send(data, options, callback);
    if ((data[1] >> 4) === 2) setImmediate(() => defaultPacingAbort.abort());
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }
}
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret", WebSocketImpl: AbortDuringDefaultWait
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav", signal: defaultPacingAbort.signal }), { name: "AbortError" });
await new Promise(resolve => setImmediate(resolve));
assert.equal(MockWebSocket.instances.at(-1).sent.length, 2);

class NeverFinalWebSocket extends MockWebSocket {
  send(data, _options, callback) {
    this.sent.push(Buffer.from(data));
    callback();
  }
}
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret", WebSocketImpl: NeverFinalWebSocket, timeoutMs: 20, sleep: async () => {}
}).transcribe({ audio: wavFixture({ durationMs: 2 }), mimeType: "audio/wav" }), { code: "SPEECH_TIMEOUT", statusCode: 504 });
assert.equal(MockWebSocket.instances.at(-1).sent.filter(frame => (frame[1] & 0xf) === 2).length, 1);
const invalidWave = wavFixture();
invalidWave.writeUInt16LE(3, 20);
const beforeInvalidWave = MockWebSocket.instances.length;
await assert.rejects(speech.transcribe({ audio: invalidWave, mimeType: "audio/wav" }), { code: "ASR_TRANSCODE_INVALID" });
assert.equal(MockWebSocket.instances.length, beforeInvalidWave);
assert.equal(invalidWave.readUInt16LE(20), 3, "unsupported PCM original remains unchanged");

for (const variant of [{ rate: 8000 }, { rate: 48000 }, { channel: 2 }]) {
  const source = wavFixture(variant);
  const sourceBefore = Buffer.from(source);
  await assert.rejects(speech.transcribe({ audio: source, mimeType: "audio/wav" }), { code: "ASR_TRANSCODE_INVALID" });
  assert.deepEqual(source, sourceBefore);
}
const beforeTooLong = MockWebSocket.instances.length;
await assert.rejects(speech.transcribe({
  audio: wavFixture({ durationMs: 600002 }), mimeType: "audio/wav", maxDurationMs: 600000
}), { code: "ASR_AUDIO_TOO_LONG", statusCode: 413 });
assert.equal(MockWebSocket.instances.length, beforeTooLong, "real PCM duration must be rejected before paid provider connection");

// 10分钟音频的3,000个200ms包可用虚拟等待验证；专用ASR计时器包含发送时长。
const originalSetTimeout = globalThis.setTimeout;
const timerDurations = [];
let longPacingMs = 0;
try {
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    timerDurations.push(milliseconds);
    return originalSetTimeout(callback, milliseconds, ...args);
  };
  await createVolcengineSpeechTransport({ asrMode: "streaming",
    apiKey: "speech-secret", WebSocketImpl: MockWebSocket, timeoutMs: 90000,
    sleep: async milliseconds => { longPacingMs += milliseconds; }
  }).transcribe({ audio: wavFixture({ durationMs: 600000 }), mimeType: "audio/wav", maxDurationMs: 600000 });
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
assert.equal(longPacingMs, 600000);
assert.ok(timerDurations.includes(690000));
assert.equal(MockWebSocket.instances.at(-1).sent.length, 3002);

// 默认是整文件HTTP：一次Base64提交、最终形态、计量与原件保护。
const fileCalls = [];
const fileInput = wavFixture({ unknownDataLength: true });
const fileOriginal = Buffer.from(fileInput);
const fileSocketCount = MockWebSocket.instances.length;
const fileResponse = { audio_info: { duration: 450 }, result: { text: completeText, utterances: [{ text: completeText, start_time: 0, end_time: 450 }] } };
const successHeaders = { "x-api-status-code": "20000000", "x-tt-logid": "flash-log" };
const fileSpeech = createVolcengineSpeechTransport({
  apiKey: "speech-secret", WebSocketImpl: MockWebSocket,
  fetchImpl: async (url, options) => {
    fileCalls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse(fileResponse, 200, successHeaders);
  }
});
const fileResult = await fileSpeech.transcribe({ audio: fileInput, mimeType: "audio/wav", maxDurationMs: 600000 });
assert.equal(fileSpeech.asrMode, "file");
assert.equal(fileSpeech.asrAction, "flashAsr");
assert.equal(speech.asrMode, "streaming");
assert.equal(speech.asrAction, "streamingAsr");
assert.equal(fileCalls.length, 1);
assert.equal(MockWebSocket.instances.length, fileSocketCount);
assert.equal(fileCalls[0].url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
assert.equal(fileCalls[0].options.headers["X-Api-Resource-Id"], "volc.bigasr.auc_turbo");
assert.equal(fileCalls[0].options.headers["X-Api-Sequence"], "-1");
assert.match(fileCalls[0].options.headers["X-Api-Request-Id"], /^[a-f0-9-]{36}$/);
const postedWav = Buffer.from(fileCalls[0].body.audio.data, "base64");
assert.equal(postedWav.readUInt32LE(4), postedWav.length - 8);
assert.equal(postedWav.readUInt32LE(40), postedWav.length - 44);
assert.deepEqual(postedWav.subarray(44), fileInput.subarray(44));
assert.deepEqual(fileInput, fileOriginal);
assert.equal(fileResult.rawText, completeText);
assert.equal(fileResult.durationMs, 450);
assert.equal(fileResult.providerRequestId, "flash-log");
assert.deepEqual(fileResult.utterances, fileResponse.result.utterances);
const appSpeechConfig = loadAppConfig({ rootDir: path.resolve("."), env: { NODE_ENV: "test" } }).speech;
assert.equal(appSpeechConfig.asrMode, "file");
assert.equal(loadAppConfig({ rootDir: path.resolve("."), env: { NODE_ENV: "test", VOLCENGINE_ASR_MODE: "streaming" } }).speech.asrMode, "streaming");
assert.throws(() => createVolcengineSpeechTransport({ asrMode: "nostream" }), { code: "INVALID_ASR_MODE" });
for (const [makeResponse, expectedCode] of [
  [() => jsonResponse({ audio_info: { duration: 450 }, result: { text: "", utterances: [] } }, 200, successHeaders), "ASR_FILE_EMPTY_TEXT"],
  [() => jsonResponse({ result: { text: "没有计量", utterances: [] } }, 200, successHeaders), "ASR_FILE_INVALID_RESPONSE"],
  [() => new Response("not JSON", { status: 200, headers: successHeaders }), "ASR_FILE_INVALID_RESPONSE"],
  [() => jsonResponse(fileResponse, 200, { ...successHeaders, "x-api-status-code": "45000001" }), "SPEECH_UNAVAILABLE"],
  [() => jsonResponse({}, 403, { ...successHeaders, "x-api-status-code": "403" }), "SPEECH_AUTH_FAILED"]
]) {
  let calls = 0;
  await assert.rejects(createVolcengineSpeechTransport({
    apiKey: "speech-secret", WebSocketImpl: MockWebSocket,
    fetchImpl: async () => { calls += 1; return makeResponse(); }
  }).transcribe({ audio: wavFixture(), mimeType: "audio/wav" }), error => {
    assert.equal(error.code, expectedCode);
    assert.equal(error.providerRequestId, "flash-log");
    return true;
  });
  assert.equal(calls, 1, "failure must not retry or fall back to another paid transport");
  assert.equal(MockWebSocket.instances.length, fileSocketCount);
}
const fileAbort = new AbortController();
await assert.rejects(createVolcengineSpeechTransport({
  apiKey: "speech-secret", fetchImpl: async () => { fileAbort.abort(); return jsonResponse(fileResponse, 200, successHeaders); }
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav", signal: fileAbort.signal }), { name: "AbortError" });
await assert.rejects(createVolcengineSpeechTransport({
  apiKey: "speech-secret", timeoutMs: 20,
  fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled fetch"), { name: "AbortError" })), { once: true });
  })
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav" }), { code: "SPEECH_TIMEOUT", statusCode: 504 });

let m4aConversions = 0;
const m4aSpeech = createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  sleep: async () => {},
  prepareStreamingAudio: async ({ audio, mimeType }) => {
    m4aConversions += 1;
    assert.equal(mimeType, "audio/mp4");
    assert.equal(audio.toString("ascii", 4, 8), "ftyp");
    return { audio: wavFixture(), mimeType: "audio/wav" };
  }
});
assert.deepEqual(await m4aSpeech.transcribe({
  audio: Buffer.from("\0\0\0\u001cftypM4A "),
  mimeType: "audio/mp4"
}), {
  provider: "volcengine-seedasr-2.0",
  rawText: "今天想把重要的事情先做完。",
  providerRequestId: "asr-log-id",
  durationMs: 1250
});
assert.equal(m4aConversions, 1);
const transcodeFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ffmpeg-test-"));
const fakeFfmpeg = path.join(transcodeFixtureDir, "ffmpeg");
const slowFfmpeg = path.join(transcodeFixtureDir, "slow-ffmpeg");
const transcodeWav = wavFixture({ unknownDataLength: true });
const transcodeWavPath = path.join(transcodeFixtureDir, "output.wav");
await fs.writeFile(transcodeWavPath, transcodeWav);
await fs.writeFile(fakeFfmpeg, `#!/bin/sh\ncat '${transcodeWavPath}'\n`, { mode: 0o700 });
await fs.writeFile(slowFfmpeg, "#!/bin/sh\nsleep 1\n", { mode: 0o700 });
// Prepare the generated executable before measuring the transport's own timeout.
const fixtureOutput = await new Promise((resolve, reject) => {
  execFile(fakeFfmpeg, [], { timeout: 5_000, encoding: "buffer" }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
assert.deepEqual(fixtureOutput, transcodeWav);
assert.equal((await createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  sleep: async () => {},
  ffmpegPath: fakeFfmpeg,
  timeoutMs: 1_000
}).transcribe({
  audio: Buffer.from("\0\0\0\u001cftypM4A "),
  mimeType: "audio/mp4"
})).rawText, "今天想把重要的事情先做完。");
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  ffmpegPath: path.join(transcodeFixtureDir, "missing-ffmpeg"),
  timeoutMs: 1_000
}).transcribe({
  audio: Buffer.from("\0\0\0\u001cftypM4A "),
  mimeType: "audio/mp4"
}), {
  code: "ASR_TRANSCODE_UNAVAILABLE",
  statusCode: 503
});
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  ffmpegPath: slowFfmpeg,
  timeoutMs: 20
}).transcribe({
  audio: Buffer.from("\0\0\0\u001cftypM4A "),
  mimeType: "audio/mp4"
}), {
  code: "ASR_TRANSCODE_TIMEOUT",
  statusCode: 504
});
for (const mimeType of ["audio/mpeg", "audio/ogg"]) {
  const converted = await createVolcengineSpeechTransport({ asrMode: "streaming",
    apiKey: "speech-secret", ffmpegPath: fakeFfmpeg, timeoutMs: 1000
  }).prepareAsrAudio({ audio: Buffer.from("compressed synthetic input"), mimeType });
  assert.equal(converted.mimeType, "audio/wav");
  assert.deepEqual(converted.audio, transcodeWav);
}
await fs.rm(transcodeFixtureDir, { recursive: true, force: true });
class ErrorWebSocket extends MockWebSocket {
  send(data, _options, callback) {
    this.sent.push(Buffer.from(data));
    callback();
    if ((data[1] & 0x0f) === 0x0) {
      queueMicrotask(() => this.emit(
        "message",
        serverErrorFrame(45000151, "[Invalid audio format] unsupported format m4a")
      ));
    }
  }
}
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  WebSocketImpl: ErrorWebSocket,
  sleep: async () => {}
}).transcribe({ audio: wavFixture(), mimeType: "audio/wav" }), error => {
  assert.equal(error.code, "ASR_UNSUPPORTED_AUDIO_FORMAT");
  assert.equal(error.statusCode, 422);
  assert.equal(error.providerCode, "45000151");
  assert.match(error.providerRequestId, /^[a-f0-9-]{36}$/);
  return true;
});
await assert.rejects(speech.transcribe({ audio: Buffer.from("webm"), mimeType: "audio/webm" }), {
  code: "ASR_UNSUPPORTED_AUDIO_FORMAT",
  statusCode: 422
});
await assert.rejects(createVolcengineSpeechTransport().synthesize({ text: "测试" }), {
  code: "SPEECH_NOT_CONFIGURED",
  statusCode: 503
});
await assert.rejects(createVolcengineSpeechTransport({ asrMode: "streaming",
  apiKey: "speech-secret",
  fetchImpl: async () => jsonResponse({
    header: { code: 45000030, message: "[resource_id=seed-tts-2.0] requested resource not granted" }
  }, 403)
}).synthesize({ text: "测试" }), {
  code: "SPEECH_RESOURCE_NOT_GRANTED",
  statusCode: 503
});

console.log("Volcengine provider checks passed: V4 signing, OCR/document contracts, TTS defaults and long-text jobs, private streaming ASR frames and error boundaries.");
