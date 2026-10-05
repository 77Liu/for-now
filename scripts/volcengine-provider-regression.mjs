import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
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
const speech = createVolcengineSpeechTransport({
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
assert.deepEqual(await speech.transcribe({ audio: Buffer.from("RIFF....WAVE"), mimeType: "audio/wav" }), {
  provider: "volcengine-seedasr-2.0",
  rawText: "今天想把重要的事情先做完。",
  providerRequestId: "asr-log-id",
  durationMs: 1250
});
assert.equal(MockWebSocket.instances[0].options.headers["X-Api-Key"], "speech-secret");
assert.equal(MockWebSocket.instances[0].options.headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
let m4aConversions = 0;
const m4aSpeech = createVolcengineSpeechTransport({
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  sleep: async () => {},
  prepareStreamingAudio: async ({ audio, mimeType }) => {
    m4aConversions += 1;
    assert.equal(mimeType, "audio/mp4");
    assert.equal(audio.toString("ascii", 4, 8), "ftyp");
    return { audio: Buffer.from("RIFF....WAVE"), mimeType: "audio/wav" };
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
await fs.writeFile(fakeFfmpeg, "#!/bin/sh\nprintf 'RIFF'\nhead -c 60 /dev/zero\n", { mode: 0o700 });
await fs.writeFile(slowFfmpeg, "#!/bin/sh\nsleep 1\n", { mode: 0o700 });
assert.equal((await createVolcengineSpeechTransport({
  apiKey: "speech-secret",
  WebSocketImpl: MockWebSocket,
  sleep: async () => {},
  ffmpegPath: fakeFfmpeg,
  timeoutMs: 1_000
}).transcribe({
  audio: Buffer.from("\0\0\0\u001cftypM4A "),
  mimeType: "audio/mp4"
})).rawText, "今天想把重要的事情先做完。");
await assert.rejects(createVolcengineSpeechTransport({
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
await assert.rejects(createVolcengineSpeechTransport({
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
await assert.rejects(createVolcengineSpeechTransport({
  apiKey: "speech-secret",
  WebSocketImpl: ErrorWebSocket,
  sleep: async () => {}
}).transcribe({ audio: Buffer.from("RIFF....WAVE"), mimeType: "audio/wav" }), error => {
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
await assert.rejects(createVolcengineSpeechTransport({
  apiKey: "speech-secret",
  fetchImpl: async () => jsonResponse({
    header: { code: 45000030, message: "[resource_id=seed-tts-2.0] requested resource not granted" }
  }, 403)
}).synthesize({ text: "测试" }), {
  code: "SPEECH_RESOURCE_NOT_GRANTED",
  statusCode: 503
});

console.log("Volcengine provider checks passed: V4 signing, OCR/document contracts, TTS defaults and long-text jobs, private streaming ASR frames and error boundaries.");
