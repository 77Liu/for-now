import { createVolcengineSpeechTransport } from "../src/infrastructure/ai-providers/index.mjs";

const apiKey = String(process.env.VOLCENGINE_SPEECH_API_KEY || "").trim();
if (!apiKey) {
  throw new Error("缺少 VOLCENGINE_SPEECH_API_KEY；请先从受保护环境文件加载后再运行");
}

const speech = createVolcengineSpeechTransport({
  apiKey,
  defaultVoice: process.env.VOLCENGINE_TTS_DEFAULT_VOICE,
  ttsEndpoint: process.env.VOLCENGINE_TTS_ENDPOINT,
  ttsSubmitEndpoint: process.env.VOLCENGINE_TTS_SUBMIT_ENDPOINT,
  ttsQueryEndpoint: process.env.VOLCENGINE_TTS_QUERY_ENDPOINT,
  asrStreamEndpoint: process.env.VOLCENGINE_ASR_STREAM_ENDPOINT,
  asrSubmitEndpoint: process.env.VOLCENGINE_ASR_SUBMIT_ENDPOINT,
  asrQueryEndpoint: process.env.VOLCENGINE_ASR_QUERY_ENDPOINT
});

const text = "这是一次火山语音服务连通性测试。";
const synthesized = await speech.synthesize({ text });
if (synthesized.audio.length < 100) throw new Error("TTS 返回音频过短");
const transcript = await speech.transcribe({
  audio: synthesized.audio,
  mimeType: "audio/mpeg"
});
if (!transcript.rawText) throw new Error("流式 ASR 未返回文字");

const result = {
  tts: {
    ok: true,
    voice: synthesized.voice,
    bytes: synthesized.audio.length,
    providerRequestId: synthesized.providerRequestId
  },
  streamingAsr: {
    ok: true,
    characters: transcript.rawText.length,
    providerRequestId: transcript.providerRequestId
  }
};

if (process.env.VOLCENGINE_ASR_TEST_AUDIO_URL) {
  const submitted = await speech.submitRecording({
    audioUrl: process.env.VOLCENGINE_ASR_TEST_AUDIO_URL,
    mimeType: process.env.VOLCENGINE_ASR_TEST_AUDIO_MIME || "audio/mpeg"
  });
  let queried = { taskId: submitted.taskId, statusCode: "20000001", rawText: "" };
  for (let attempt = 0; attempt < 30 && queried.statusCode !== "20000000"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    queried = await speech.queryRecording({ taskId: submitted.taskId });
  }
  if (queried.statusCode !== "20000000" || !queried.rawText) {
    throw new Error("录音文件 ASR 未在等待窗口内完成");
  }
  result.fileAsr = {
    ok: true,
    taskId: submitted.taskId,
    characters: queried.rawText.length
  };
}

if (process.argv.includes("--long-text")) {
  const submitted = await speech.submitLongText({ text, userId: "for-now-smoke" });
  let queried = { ...submitted, audioUrl: "" };
  for (let attempt = 0; attempt < 30 && queried.status === 1; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    queried = await speech.queryLongText({ taskId: submitted.taskId });
  }
  if (queried.status !== 2 || !queried.audioUrl) throw new Error("异步长文本语音合成未在等待窗口内完成");
  result.longTextTts = { ok: true, taskId: queried.taskId, expiresAt: queried.expiresAt };
}

console.log(JSON.stringify(result, null, 2));
