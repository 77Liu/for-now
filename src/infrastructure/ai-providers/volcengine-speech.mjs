import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { normalizeTtsGenerationRate, TTS_GENERATION_RATE_DEFAULT } from "../../shared/speech/index.mjs";
import { safeText } from "../../shared/validation/index.mjs";

const DEFAULT_TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DEFAULT_TTS_SUBMIT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/submit";
const DEFAULT_TTS_QUERY_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/query";
const DEFAULT_ASR_STREAM_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const DEFAULT_ASR_SUBMIT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const DEFAULT_ASR_QUERY_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const TTS_RESOURCE_ID = "seed-tts-2.0";
const ASR_FILE_RESOURCE_ID = "volc.seedasr.auc";
const ASR_STREAM_RESOURCE_ID = "volc.seedasr.sauc.duration";
const MAX_TTS_TEXT_LENGTH = 5000;
const MAX_TTS_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_ASR_STREAM_AUDIO_BYTES = 24 * 1024 * 1024;
const ASR_CHUNK_BYTES = 256 * 1024;
const SUCCESS_CODES = new Set([0, 1000, 20000000]);
const SUPPORTED_ASR_MIME_TYPES = Object.freeze(["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav"]);
const TTS_SAMPLE_TEXT = "此刻，听见自己的想法，也看见正在发生的生活。";
const samplePath = id => `/assets/audio/voice-previews/${id}.mp3`;

const MESSAGE_FULL_CLIENT_REQUEST = 0x1;
const MESSAGE_AUDIO_ONLY_REQUEST = 0x2;
const MESSAGE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_ERROR = 0xf;
const FLAG_NO_SEQUENCE = 0x0;
const FLAG_POSITIVE_SEQUENCE = 0x1;
const FLAG_FINAL_NO_SEQUENCE = 0x2;
const FLAG_NEGATIVE_SEQUENCE = 0x3;
const SERIALIZATION_NONE = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_NONE = 0x0;
const COMPRESSION_GZIP = 0x1;

export const VOLCENGINE_TTS_VOICES = Object.freeze([
  Object.freeze({ id: "zh_male_shaonianzixin_uranus_bigtts", label: "少年梓辛 2.0", gender: "male", age: "young", sampleText: TTS_SAMPLE_TEXT, samplePath: samplePath("zh_male_shaonianzixin_uranus_bigtts") }),
  Object.freeze({ id: "zh_male_m191_uranus_bigtts", label: "云舟 2.0", gender: "male", age: "mature", sampleText: TTS_SAMPLE_TEXT, samplePath: samplePath("zh_male_m191_uranus_bigtts") }),
  Object.freeze({ id: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0", gender: "female", age: "young", sampleText: TTS_SAMPLE_TEXT, samplePath: samplePath("zh_female_vv_uranus_bigtts") }),
  Object.freeze({ id: "zh_female_cancan_uranus_bigtts", label: "知性灿灿 2.0", gender: "female", age: "mature", sampleText: TTS_SAMPLE_TEXT, samplePath: samplePath("zh_female_cancan_uranus_bigtts") })
]);

const VOICE_IDS = new Set(VOLCENGINE_TTS_VOICES.map(voice => voice.id));
const failure = (message, code, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

function providerError(message, code, response = null, raw = "") {
  const error = failure(message, safeText(code, 120) || `HTTP_${response?.status || 502}`);
  error.httpStatus = response?.status || 0;
  error.privateMessage = safeText(raw, 4000);
  error.providerRequestId = safeText(response?.headers?.get?.("x-tt-logid"), 200);
  return error;
}

function publicSpeechError(error, service) {
  const details = `${error?.code || ""} ${error?.message || ""} ${error?.privateMessage || ""}`;
  const projected = (message, code, statusCode) => Object.assign(failure(message, code, statusCode), {
    httpStatus: error?.httpStatus || 0,
    providerRequestId: safeText(error?.providerRequestId, 200),
    providerCode: safeText(error?.code, 120)
  });
  if (/SPEECH_NOT_CONFIGURED/.test(details)) return failure("火山语音服务尚未配置，请联系管理员", "SPEECH_NOT_CONFIGURED", 503);
  if (/ASR_UNSUPPORTED_AUDIO_FORMAT/.test(details)) return error;
  if (/resource.*not granted/i.test(details)) return projected(`火山${service}资源尚未开通或未授权给当前 API Key`, "SPEECH_RESOURCE_NOT_GRANTED", 503);
  if (/AbortError|timeout|timed out/i.test(details)) return projected(`火山${service}响应超时，请稍后重试`, "SPEECH_TIMEOUT", 504);
  if (/401|403|50400|unauthor|forbidden|authentication|invalid.*key/i.test(details)) {
    return projected("火山语音服务鉴权失败，请检查 API Key 与资源授权", "SPEECH_AUTH_FAILED", 503);
  }
  if (/429|quota|qps|limit/i.test(details)) return projected("火山语音服务请求较多，请稍后重试", "SPEECH_RATE_LIMITED", 503);
  if (/^ASR_TRANSCODE_/.test(error?.code || "")) return error;
  if (/45000151|unsupported format/i.test(details)) {
    return projected("当前录音格式无法直接转写，请保留原音并重新尝试", "ASR_UNSUPPORTED_AUDIO_FORMAT", 422);
  }
  if (/文本|音频|音色|格式/.test(error?.message || "")) return error;
  return projected(`火山${service}暂时不可用，请稍后重试`, "SPEECH_UNAVAILABLE", 503);
}

function requestHeaders(apiKey, resourceId, requestId) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "x-api-resource-id": resourceId,
    "x-api-request-id": requestId
  };
}

async function jsonRequest(fetchImpl, endpoint, {
  apiKey,
  resourceId,
  requestId = crypto.randomUUID(),
  body,
  signal,
  timeoutMs
}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let response, raw = "", result = {};
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: requestHeaders(apiKey, resourceId, requestId),
      body: JSON.stringify(body)
    });
    raw = await response.text();
    try { result = JSON.parse(raw); } catch {}
    if (!response.ok) throw providerError(
      "火山语音请求失败",
      result?.code || result?.header?.code,
      response,
      result?.message || result?.header?.message || raw
    );
    return { response, result, raw, requestId };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function ttsPayloads(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  try { return [JSON.parse(trimmed)]; } catch {}
  return trimmed.split(/\r?\n/)
    .map(line => line.trim().replace(/^data:\s*/, ""))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function decodeTtsAudio(raw, response) {
  let payloads;
  try { payloads = ttsPayloads(raw); }
  catch { throw providerError("火山语音合成返回格式无效", "INVALID_TTS_RESPONSE", response, raw); }
  const chunks = [];
  for (const payload of payloads) {
    const code = Number(payload?.code ?? payload?.header?.code);
    if (!SUCCESS_CODES.has(code)) {
      throw providerError("火山语音合成失败", code, response, payload?.message || payload?.header?.message || raw);
    }
    if (typeof payload.data === "string" && payload.data) {
      const chunk = Buffer.from(payload.data, "base64");
      if (chunk.length) chunks.push(chunk);
    }
  }
  const audio = Buffer.concat(chunks);
  if (!audio.length || audio.length > MAX_TTS_AUDIO_BYTES) {
    throw providerError("火山语音合成没有返回有效音频", "INVALID_TTS_AUDIO", response, raw);
  }
  return {
    audio,
    usage: payloads.at(-1)?.usage || null,
    providerRequestId: safeText(response.headers.get("x-tt-logid"), 200)
  };
}

function asrAudioParameters(mimeType) {
  return {
    "audio/mp4": { format: "m4a", codec: "raw" },
    "audio/mpeg": { format: "mp3", codec: "raw" },
    "audio/ogg": { format: "ogg", codec: "opus" },
    "audio/wav": { format: "wav", codec: "raw" }
  }[String(mimeType || "").toLowerCase()] || null;
}

function measuredAsrDurationMs(result) {
  const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
  return utterances.reduce((maximum, utterance) => {
    const end = Number(utterance?.end_time ?? utterance?.endTime);
    return Number.isFinite(end) && end > maximum ? Math.round(end) : maximum;
  }, 0);
}

async function transcodeM4aForStreaming({
  audio,
  mimeType,
  signal,
  ffmpegPath = "/usr/bin/ffmpeg",
  timeoutMs = 90_000
}) {
  if (mimeType !== "audio/mp4") return { audio, mimeType };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-asr-"));
  const inputFile = path.join(directory, "input.m4a");
  try {
    await fs.writeFile(inputFile, audio, { flag: "wx", mode: 0o600 });
    const converted = await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", inputFile, "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let settled = false;
      let total = 0;
      let stderr = "";
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("语音识别已取消"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("录音转换超时，请保留原音后重试"), {
          code: "ASR_TRANSCODE_TIMEOUT",
          statusCode: 504
        }));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_ASR_STREAM_AUDIO_BYTES) {
          child.kill("SIGKILL");
          finish(Object.assign(new Error("转换后的录音超过转写上限"), {
            code: "ASR_TRANSCODE_TOO_LARGE",
            statusCode: 413
          }));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        if (settled) return;
        stderr = safeText(`${stderr}${chunk}`, 4000);
      });
      child.on("error", error => finish(Object.assign(new Error("服务器暂时无法转换这段录音，请稍后重试"), {
        code: "ASR_TRANSCODE_UNAVAILABLE",
        statusCode: 503,
        privateMessage: safeText(error?.message, 500)
      })));
      child.on("close", code => {
        if (settled) return;
        if (code !== 0) {
          finish(Object.assign(new Error("这段录音暂时无法转换，请保留原音后重试"), {
            code: "ASR_TRANSCODE_FAILED",
            statusCode: 422,
            privateMessage: stderr
          }));
          return;
        }
        const result = Buffer.concat(chunks);
        if (result.length <= 44) {
          finish(Object.assign(new Error("这段录音没有可转写的音频内容"), {
            code: "ASR_TRANSCODE_EMPTY",
            statusCode: 422,
            privateMessage: stderr
          }));
          return;
        }
        finish(null, { audio: result, mimeType: "audio/wav" });
      });
      if (signal?.aborted) abort();
    });
    return converted;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function protocolHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ]);
}

export function createAsrFullRequest(payload) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([
    protocolHeader(MESSAGE_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP),
    size,
    compressed
  ]);
}

export function createAsrAudioRequest(audio, { final = false } = {}) {
  const compressed = gzipSync(audio);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([
    protocolHeader(
      MESSAGE_AUDIO_ONLY_REQUEST,
      final ? FLAG_FINAL_NO_SEQUENCE : FLAG_NO_SEQUENCE,
      SERIALIZATION_NONE,
      COMPRESSION_GZIP
    ),
    size,
    compressed
  ]);
}

export function parseAsrServerFrame(value) {
  const data = Buffer.from(value);
  if (data.length < 4) throw new Error("ASR 响应帧长度不足");
  const headerBytes = (data[0] & 0x0f) * 4;
  if (headerBytes < 4 || data.length < headerBytes) throw new Error("ASR 响应帧头无效");
  const messageType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const compression = data[2] & 0x0f;
  let offset = headerBytes;
  if (messageType === MESSAGE_ERROR) {
    if (data.length < offset + 8) throw new Error("ASR 错误帧无效");
    const errorCode = data.readUInt32BE(offset);
    offset += 4;
    const size = data.readUInt32BE(offset);
    offset += 4;
    let payload = data.subarray(offset, offset + size);
    if (compression === COMPRESSION_GZIP) payload = gunzipSync(payload);
    return { messageType, flags, errorCode, payload, final: true };
  }
  let sequence = null;
  if ([FLAG_POSITIVE_SEQUENCE, FLAG_NEGATIVE_SEQUENCE].includes(flags)) {
    if (data.length < offset + 4) throw new Error("ASR 响应帧缺少序号");
    sequence = data.readInt32BE(offset);
    offset += 4;
  }
  if (data.length < offset + 4) throw new Error("ASR 响应帧缺少负载长度");
  const size = data.readUInt32BE(offset);
  offset += 4;
  if (data.length < offset + size) throw new Error("ASR 响应帧负载不完整");
  let payload = data.subarray(offset, offset + size);
  if (compression === COMPRESSION_GZIP) payload = gunzipSync(payload);
  return {
    messageType,
    flags,
    sequence,
    payload,
    final: [FLAG_FINAL_NO_SEQUENCE, FLAG_NEGATIVE_SEQUENCE].includes(flags) || Number(sequence) < 0
  };
}

function parseAsrPayload(frame, requestId) {
  if (frame.messageType === MESSAGE_ERROR) {
    throw Object.assign(new Error("火山语音识别返回错误"), {
      code: String(frame.errorCode || "ASR_PROVIDER_ERROR"),
      privateMessage: frame.payload.toString("utf8"),
      providerRequestId: requestId
    });
  }
  if (frame.messageType !== MESSAGE_FULL_SERVER_RESPONSE) return null;
  let payload;
  try { payload = frame.payload.length ? JSON.parse(frame.payload.toString("utf8")) : {}; }
  catch { throw failure("火山语音识别返回格式无效", "INVALID_ASR_RESPONSE"); }
  const code = Number(payload.code ?? payload.status_code ?? 0);
  if (!SUCCESS_CODES.has(code)) {
    throw Object.assign(new Error("火山语音识别失败"), {
      code: String(code || "ASR_PROVIDER_ERROR"),
      privateMessage: safeText(payload.message || payload.error, 4000),
      providerRequestId: requestId
    });
  }
  return payload;
}

function sendWebSocket(socket, data) {
  return new Promise((resolve, reject) => {
    socket.send(data, { binary: true }, error => error ? reject(error) : resolve());
  });
}

export function createVolcengineSpeechTransport({
  apiKey = "",
  defaultVoice = VOLCENGINE_TTS_VOICES[0].id,
  ttsEndpoint = DEFAULT_TTS_ENDPOINT,
  ttsSubmitEndpoint = DEFAULT_TTS_SUBMIT_ENDPOINT,
  ttsQueryEndpoint = DEFAULT_TTS_QUERY_ENDPOINT,
  asrStreamEndpoint = DEFAULT_ASR_STREAM_ENDPOINT,
  asrSubmitEndpoint = DEFAULT_ASR_SUBMIT_ENDPOINT,
  asrQueryEndpoint = DEFAULT_ASR_QUERY_ENDPOINT,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  ffmpegPath = "/usr/bin/ffmpeg",
  timeoutMs = 90_000,
  prepareStreamingAudio = options => transcodeM4aForStreaming({ ...options, ffmpegPath, timeoutMs }),
  debugServerUrl = "",
  debugSessionId = "speech-transcription-unavailable",
  debugRunId = "pre-fix"
} = {}) {
  const configured = Boolean(apiKey);
  const selectedDefaultVoice = VOICE_IDS.has(defaultVoice) ? defaultVoice : VOLCENGINE_TTS_VOICES[0].id;
  const requireConfiguration = () => {
    if (!configured) throw failure("火山语音服务尚未配置", "SPEECH_NOT_CONFIGURED", 503);
  };

  async function synthesize({
    text,
    voice = selectedDefaultVoice,
    generationRate = TTS_GENERATION_RATE_DEFAULT,
    signal
  } = {}) {
    requireConfiguration();
    const sourceText = String(text || "").trim();
    const normalizedGenerationRate = normalizeTtsGenerationRate(generationRate);
    if (sourceText.length > MAX_TTS_TEXT_LENGTH) throw failure("单次朗读文本不得超过 5000 字", "TTS_TEXT_TOO_LONG", 400);
    const normalizedText = safeText(sourceText, MAX_TTS_TEXT_LENGTH);
    if (!normalizedText) throw failure("朗读文本不能为空", "INVALID_TTS_TEXT", 400);
    if (!VOICE_IDS.has(voice)) throw failure("朗读音色无效", "INVALID_TTS_VOICE", 400);
    try {
      const requestId = crypto.randomUUID();
      const { response, raw } = await jsonRequest(fetchImpl, ttsEndpoint, {
        apiKey,
        resourceId: TTS_RESOURCE_ID,
        requestId,
        signal,
        timeoutMs,
        body: {
          req_params: {
            text: normalizedText,
            speaker: voice,
            audio_params: {
              format: "mp3",
              sample_rate: 24000,
              speech_rate: normalizedGenerationRate,
              loudness_rate: 0
            },
            post_process: { pitch: 0 },
            disable_markdown_filter: true,
            disable_emoji_filter: true
          }
        }
      });
      return { ...decodeTtsAudio(raw, response), mimeType: "audio/mpeg", voice, requestId };
    } catch (error) {
      throw publicSpeechError(error, "语音合成");
    }
  }

  async function submitLongText({
    text,
    voice = selectedDefaultVoice,
    generationRate = TTS_GENERATION_RATE_DEFAULT,
    userId = "local",
    signal
  } = {}) {
    requireConfiguration();
    const sourceText = String(text || "").trim();
    const normalizedGenerationRate = normalizeTtsGenerationRate(generationRate);
    if (sourceText.length > 100_000) throw failure("长文本朗读不得超过 10 万字", "TTS_TEXT_TOO_LONG", 400);
    const normalizedText = safeText(sourceText, 100_000);
    if (!normalizedText) throw failure("朗读文本不能为空", "INVALID_TTS_TEXT", 400);
    if (!VOICE_IDS.has(voice)) throw failure("朗读音色无效", "INVALID_TTS_VOICE", 400);
    try {
      const uniqueId = crypto.randomUUID();
      const { result } = await jsonRequest(fetchImpl, ttsSubmitEndpoint, {
        apiKey,
        resourceId: TTS_RESOURCE_ID,
        signal,
        timeoutMs,
        body: {
          user: { uid: safeText(userId, 100) || "local" },
          unique_id: uniqueId,
          req_params: {
            text: normalizedText,
            speaker: voice,
            audio_params: {
              format: "mp3",
              sample_rate: 24000,
              speech_rate: normalizedGenerationRate,
              loudness_rate: 0,
              enable_timestamp: true
            }
          }
        }
      });
      if (Number(result.code) !== 20000000 || !safeText(result.data?.task_id, 100)) {
        throw providerError("火山长文本语音任务提交失败", result.code, null, result.message);
      }
      return { taskId: safeText(result.data.task_id, 100), status: Number(result.data.task_status) || 1 };
    } catch (error) {
      throw publicSpeechError(error, "语音合成");
    }
  }

  async function queryLongText({ taskId, signal } = {}) {
    requireConfiguration();
    const normalizedTaskId = safeText(taskId, 100);
    if (!normalizedTaskId) throw failure("语音任务编号不能为空", "INVALID_TTS_TASK", 400);
    try {
      const { result } = await jsonRequest(fetchImpl, ttsQueryEndpoint, {
        apiKey,
        resourceId: TTS_RESOURCE_ID,
        signal,
        timeoutMs,
        body: { task_id: normalizedTaskId }
      });
      if (Number(result.code) !== 20000000) {
        throw providerError("火山长文本语音任务查询失败", result.code, null, result.message);
      }
      return {
        taskId: safeText(result.data?.task_id, 100),
        status: Number(result.data?.task_status) || 0,
        audioUrl: safeText(result.data?.audio_url, 4000),
        expiresAt: Number(result.data?.url_expire_time) || 0
      };
    } catch (error) {
      throw publicSpeechError(error, "语音合成");
    }
  }

  async function submitRecording({ audioUrl, mimeType, signal } = {}) {
    requireConfiguration();
    const format = asrAudioParameters(mimeType);
    let parsedUrl;
    try { parsedUrl = new URL(audioUrl); } catch {}
    if (!parsedUrl || parsedUrl.protocol !== "https:") throw failure("录音文件地址必须是 HTTPS", "INVALID_ASR_URL", 400);
    if (!format) throw failure("该音频格式暂不支持火山语音识别", "ASR_UNSUPPORTED_AUDIO_FORMAT", 400);
    try {
      const requestId = crypto.randomUUID();
      const { response, result } = await jsonRequest(fetchImpl, asrSubmitEndpoint, {
        apiKey,
        resourceId: ASR_FILE_RESOURCE_ID,
        requestId,
        signal,
        timeoutMs,
        body: {
          audio: { url: parsedUrl.toString(), ...format, rate: 16000, bits: 16, channel: 1 },
          request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            enable_ddc: false,
            show_utterances: true
          }
        }
      });
      const taskId = safeText(result.task_id || response.headers.get("x-api-request-id") || requestId, 100);
      const statusCode = safeText(result["X-Api-Status-Code"] || response.headers.get("x-api-status-code"), 80);
      if (!taskId || (statusCode && statusCode !== "20000000")) {
        throw providerError("火山录音文件识别任务提交失败", statusCode, response, result["X-Api-Message"]);
      }
      return { taskId };
    } catch (error) {
      throw publicSpeechError(error, "语音识别");
    }
  }

  async function queryRecording({ taskId, signal } = {}) {
    requireConfiguration();
    const normalizedTaskId = safeText(taskId, 100);
    if (!normalizedTaskId) throw failure("识别任务编号不能为空", "INVALID_ASR_TASK", 400);
    try {
      const { response, result } = await jsonRequest(fetchImpl, asrQueryEndpoint, {
        apiKey,
        resourceId: ASR_FILE_RESOURCE_ID,
        requestId: normalizedTaskId,
        signal,
        timeoutMs,
        body: {}
      });
      const statusCode = safeText(response.headers.get("x-api-status-code") || result["X-Api-Status-Code"], 80);
      if (statusCode && !["20000000", "20000001", "20000002"].includes(statusCode)) {
        throw providerError("火山录音文件识别任务查询失败", statusCode, response, result["X-Api-Message"]);
      }
      return {
        taskId: normalizedTaskId,
        statusCode,
        rawText: safeText(result.result?.text, 120_000),
        utterances: Array.isArray(result.result?.utterances) ? result.result.utterances : []
      };
    } catch (error) {
      throw publicSpeechError(error, "语音识别");
    }
  }

  async function transcribe({ audio, mimeType, signal } = {}) {
    requireConfiguration();
    if (!Buffer.isBuffer(audio) || !audio.length) throw failure("音频内容为空", "INVALID_ASR_AUDIO", 400);
    if (!asrAudioParameters(mimeType)) {
      throw failure("当前 WebM 原件不能直接转写，请在支持 M4A、Ogg 或 WAV 的设备上重新录制", "ASR_UNSUPPORTED_AUDIO_FORMAT", 422);
    }
    const sourceAudio = audio;
    const sourceMimeType = mimeType;
    const prepared = await prepareStreamingAudio({ audio, mimeType, signal });
    audio = prepared?.audio;
    mimeType = prepared?.mimeType;
    const format = asrAudioParameters(mimeType);
    if (!Buffer.isBuffer(audio) || !audio.length || !format) {
      throw failure("录音转换结果无效，请保留原音后重试", "ASR_TRANSCODE_INVALID", 422);
    }
    const requestId = crypto.randomUUID();
    // #region debug-point B-C:audio-container
    (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"B-C",location:"volcengine-speech.mjs:transcribe",msg:"[DEBUG] ASR audio envelope",data:{sourceMimeType:String(sourceMimeType||""),sourceBytes:sourceAudio.length,sourceMagic:sourceAudio.subarray(0,16).toString("hex"),mimeType:String(mimeType||""),bytes:audio.length,magic:audio.subarray(0,16).toString("hex"),format:format.format,codec:format.codec,sha256Prefix:crypto.createHash("sha256").update(sourceAudio).digest("hex").slice(0,16)},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
    // #endregion
    return new Promise((resolve, reject) => {
      let settled = false;
      let rawText = "";
      let providerRequestId = requestId;
      let durationMs = 0;
      let stage = "connecting";
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) {
          try { socket.close(); } catch {}
        }
        // #region debug-point A-D-E:finish
        (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A-D-E",location:"volcengine-speech.mjs:finish",msg:"[DEBUG] ASR finished",data:{stage,ok:!error,errorName:safeText(error?.name,120),errorCode:safeText(error?.code,120),errorMessage:safeText(error?.message,500),privateMessage:safeText(error?.privateMessage,500),httpStatus:Number(error?.httpStatus)||0,providerRequestId:safeText(error?.providerRequestId||result?.providerRequestId,200)},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
        // #endregion
        if (error) reject(publicSpeechError(error, "语音识别"));
        else resolve(result);
      };
      const socket = new WebSocketImpl(asrStreamEndpoint, {
        perMessageDeflate: false,
        handshakeTimeout: Math.min(timeoutMs, 15_000),
        maxPayload: 4 * 1024 * 1024,
        headers: {
          "X-Api-Key": apiKey,
          "X-Api-Resource-Id": ASR_STREAM_RESOURCE_ID,
          "X-Api-Request-Id": requestId,
          "X-Api-Sequence": "-1",
          "X-Api-Connect-Id": crypto.randomUUID()
        }
      });
      const timer = setTimeout(() => {
        try { socket.terminate(); } catch {}
        finish(failure("火山语音识别响应超时", "SPEECH_TIMEOUT", 504));
      }, timeoutMs);
      const abort = () => {
        try { socket.terminate(); } catch {}
        finish(Object.assign(new Error("语音识别已取消"), { name: "AbortError" }));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      socket.on("unexpected-response", (_request, response) => {
        stage = "upgrade-rejected";
        // #region debug-point A-D:upgrade-response
        (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A-D",location:"volcengine-speech.mjs:unexpected-response",msg:"[DEBUG] ASR upgrade rejected",data:{statusCode:Number(response.statusCode)||0,statusMessage:safeText(response.statusMessage,200),apiStatusCode:safeText(response.headers?.["x-api-status-code"],120),apiMessage:safeText(response.headers?.["x-api-message"],500),providerLogId:safeText(response.headers?.["x-tt-logid"],200)},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
        // #endregion
        finish(providerError("火山语音识别连接失败", `HTTP_${response.statusCode}`, null, response.statusMessage));
      });
      socket.on("error", error => {
        stage = "socket-error";
        // #region debug-point A-D:socket-error
        (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A-D",location:"volcengine-speech.mjs:error",msg:"[DEBUG] ASR socket error",data:{name:safeText(error?.name,120),code:safeText(error?.code,120),message:safeText(error?.message,500)},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
        // #endregion
        finish(error);
      });
      socket.on("close", (code, reason) => {
        // #region debug-point A:socket-close
        (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A",location:"volcengine-speech.mjs:close",msg:"[DEBUG] ASR socket closed",data:{stage,code:Number(code)||0,reason:safeText(Buffer.from(reason||"").toString("utf8"),500),settled},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
        // #endregion
        if (!settled) finish(failure("火山语音识别连接意外中断", "ASR_CONNECTION_CLOSED"));
      });
      socket.on("message", data => {
        try {
          stage = "provider-frame";
          const frame = parseAsrServerFrame(data);
          // #region debug-point A-D:provider-frame
          (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A-D",location:"volcengine-speech.mjs:message",msg:"[DEBUG] ASR provider frame",data:{messageType:frame.messageType,flags:frame.flags,errorCode:Number(frame.errorCode)||0,final:Boolean(frame.final),errorPayload:frame.messageType===MESSAGE_ERROR?safeText(frame.payload.toString("utf8"),500):""},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
          // #endregion
          const payload = parseAsrPayload(frame, requestId);
          const result = payload?.result;
          if (result && typeof result === "object") {
            rawText = safeText(result.text, 120_000) || rawText;
            providerRequestId = safeText(result.additions?.log_id, 200) || providerRequestId;
            durationMs = Math.max(durationMs, measuredAsrDurationMs(result));
          }
          if (frame.final) {
            if (!rawText) throw failure("火山语音识别没有返回文字", "EMPTY_ASR_TEXT");
            finish(null, {
              provider: "volcengine-seedasr-2.0",
              rawText,
              providerRequestId,
              durationMs
            });
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.on("open", async () => {
        try {
          stage = "sending";
          // #region debug-point A-B-D-E:socket-open
          (()=>{if(!debugServerUrl)return;fetch(debugServerUrl,{method:"POST",body:JSON.stringify({sessionId:debugSessionId,runId:debugRunId,hypothesisId:"A-B-D-E",location:"volcengine-speech.mjs:open",msg:"[DEBUG] ASR socket opened",data:{endpointPath:new URL(asrStreamEndpoint).pathname,resourceId:ASR_STREAM_RESOURCE_ID,format:format.format,codec:format.codec,audioBytes:audio.length,chunks:Math.ceil(audio.length/ASR_CHUNK_BYTES)},ts:Date.now(),traceId:requestId})}).catch(()=>{})})();
          // #endregion
          await sendWebSocket(socket, createAsrFullRequest({
            user: { uid: "for-now" },
            audio: { ...format },
            request: {
              model_name: "bigmodel",
              enable_nonstream: true,
              enable_itn: true,
              enable_punc: true,
              enable_ddc: false,
              show_utterances: true
            }
          }));
          for (let offset = 0; offset < audio.length; offset += ASR_CHUNK_BYTES) {
            await sendWebSocket(socket, createAsrAudioRequest(audio.subarray(offset, offset + ASR_CHUNK_BYTES)));
          }
          await sleep(500);
          await sendWebSocket(socket, createAsrAudioRequest(Buffer.alloc(0), { final: true }));
        } catch (error) {
          finish(error);
        }
      });
    });
  }

  return {
    configured,
    defaultVoice: selectedDefaultVoice,
    voices: VOLCENGINE_TTS_VOICES,
    supportedAsrMimeTypes: SUPPORTED_ASR_MIME_TYPES,
    prepareAsrAudio: prepareStreamingAudio,
    synthesize,
    submitLongText,
    queryLongText,
    submitRecording,
    queryRecording,
    transcribe
  };
}
