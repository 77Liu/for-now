import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const listen = server => new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const json = (response, value, headers = {}) => {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};
const serverFrame = payload => {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const sequence = Buffer.allocUnsafe(4);
  sequence.writeInt32BE(-1);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([Buffer.from([0x11, 0x93, 0x11, 0x00]), sequence, size, compressed]);
};
const bodyOf = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const providerCalls = [];
const provider = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://provider.local");
  const raw = await bodyOf(request);
  providerCalls.push({ pathname: url.pathname, search: url.search, headers: request.headers, raw });
  if (url.pathname === "/tts") {
    return json(response, {
      code: 0,
      message: "OK",
      data: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]).toString("base64")
    }, { "x-tt-logid": "tts-server-test" });
  }
  if (url.pathname === "/visual") {
    const action = url.searchParams.get("Action");
    return json(response, action === "OCRNormal"
      ? { code: 10000, data: { line_texts: ["OCR TEST 2026"], line_rects: [], line_probs: [0.99] }, request_id: "ocr-server-test" }
      : { code: 10000, data: { markdown: "# OCR TEST 2026", detail: "[]" }, request_id: "document-server-test" });
  }
  if (url.pathname === "/deepseek") {
    const requestBody = JSON.parse(raw);
    const promptText = JSON.stringify(requestBody.messages?.at(-1)?.content || "");
    const content = promptText.includes("可编辑候选")
      ? JSON.stringify({
          title: "测试票根",
          tags: ["测试", "票根", "测试"],
          description: "画面中是一张测试用票根。"
        })
      : requestBody.response_format?.type === "json_object"
      ? JSON.stringify({ measuredWeight: 70, clothing: "none", verification: "请核对" })
      : promptText.includes("凝练为更短")
        ? "这是凝练后的转写。"
        : "这是整理后的转写。";
    return json(response, {
      id: "deepseek-server-test",
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content, reasoning_content: "" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
  }
  response.writeHead(404);
  response.end();
});
await listen(provider);

const websocketServer = http.createServer();
const websocket = new WebSocketServer({ server: websocketServer });
let asrConnections = 0;
websocket.on("connection", socket => {
  asrConnections += 1;
  socket.on("message", data => {
    const frame = Buffer.from(data);
    if ((frame[1] & 0x0f) === 0x2) {
      socket.send(serverFrame({
        code: 0,
        result: {
          text: "这是语音识别原文。",
          additions: { log_id: "asr-server-test" }
        }
      }));
    }
  });
});
await listen(websocketServer);

const appPort = await freePort();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-volcengine-server-"));
const app = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    DATA_DIR: dataDir,
    AUTH_REQUIRED: "0",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    AI_USER_DAILY_CALL_LIMIT: "13",
    DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}/deepseek`,
    VOLCENGINE_SPEECH_API_KEY: "speech-test-key",
    VOLCENGINE_TTS_ENDPOINT: `http://127.0.0.1:${provider.address().port}/tts`,
    VOLCENGINE_ASR_STREAM_ENDPOINT: `ws://127.0.0.1:${websocketServer.address().port}/asr`,
    VOLCENGINE_ACCESS_KEY_ID: "visual-test-ak",
    VOLCENGINE_SECRET_ACCESS_KEY: "visual-test-sk",
    VOLCENGINE_VISUAL_ENDPOINT: `http://127.0.0.1:${provider.address().port}/visual`
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
app.stderr.on("data", chunk => { stderr += chunk; });
const base = `http://127.0.0.1:${appPort}`;
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`应用未在等待窗口内达到预期状态\n${stderr}`);
};

try {
  await waitFor(async () => (await fetch(`${base}/readyz`)).ok);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.speech.configured, true);
  assert.equal(state.vision.configured, true);
  assert.equal(state.speech.voices.length, 4);
  assert.ok(state.speech.voices.every(voice => voice.sampleText === "此刻，听见自己的想法，也看见正在发生的生活。"));
  assert.ok(state.speech.voices.every(voice => voice.samplePath === `/assets/audio/voice-previews/${voice.id}.mp3`));
  const settings = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiKey: "deepseek-test-key",
      scenarios: { capturePolish: "lite" },
      sceneEfforts: { capturePolish: "none" },
      speech: { defaultVoice: "zh_female_vv_uranus_bigtts", generationRate: 25 }
    })
  });
  assert.equal(settings.status, 200);
  assert.deepEqual((await settings.json()).speech, { defaultVoice: "zh_female_vv_uranus_bigtts", generationRate: 25 });
  const invalidOwnerVoice = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speech: { defaultVoice: "not-a-real-voice" } })
  });
  assert.equal(invalidOwnerVoice.status, 200);
  assert.equal((await invalidOwnerVoice.json()).speech.defaultVoice, "zh_male_shaonianzixin_uranus_bigtts");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dataDir, "llm-settings.json"), "utf8")).speech.defaultVoice,
    "zh_male_shaonianzixin_uranus_bigtts"
  );
  const invalidPreferenceVoice = await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speech: { defaultVoice: "not-a-real-voice" } })
  });
  assert.equal(invalidPreferenceVoice.status, 200);
  assert.equal((await invalidPreferenceVoice.json()).speech.defaultVoice, "zh_male_shaonianzixin_uranus_bigtts");
  const historicalSettings = JSON.parse(await fs.readFile(path.join(dataDir, "llm-settings.json"), "utf8"));
  historicalSettings.speech.defaultVoice = "not-a-real-voice";
  await fs.writeFile(path.join(dataDir, "llm-settings.json"), `${JSON.stringify(historicalSettings, null, 2)}\n`);
  for (const endpoint of ["/api/settings", "/api/preferences"]) {
    const historicalResponse = await fetch(`${base}${endpoint}`);
    assert.equal(historicalResponse.status, 200);
    assert.equal((await historicalResponse.json()).speech.defaultVoice, "zh_male_shaonianzixin_uranus_bigtts");
  }

  const speechSourceResponse = await fetch(`${base}/api/v1/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "volcengine-speech-source" },
    body: JSON.stringify({ content: "测试朗读" })
  });
  assert.equal(speechSourceResponse.status, 201);
  const speechSource = (await speechSourceResponse.json()).data;
  const synthesized = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      captureId: speechSource.id,
      sourceVersion: speechSource.version,
      voice: "zh_female_vv_uranus_bigtts"
    })
  });
  assert.equal(synthesized.status, 200);
  assert.equal(synthesized.headers.get("content-type"), "audio/mpeg");
  assert.equal(synthesized.headers.get("x-speech-cache"), "miss");
  assert.equal(synthesized.headers.get("x-speech-voice"), "zh_male_shaonianzixin_uranus_bigtts");
  const speechAssetId = synthesized.headers.get("x-speech-asset-id");
  assert.ok(speechAssetId);
  assert.equal(Buffer.from(await synthesized.arrayBuffer()).subarray(0, 3).toString("ascii"), "ID3");
  const ttsRequest = JSON.parse(providerCalls.find(call => call.pathname === "/tts").raw);
  assert.equal(ttsRequest.req_params.audio_params.speech_rate, 25);
  assert.equal(ttsRequest.req_params.speaker, "zh_male_shaonianzixin_uranus_bigtts");
  const cached = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceType: "capture",
      sourceId: speechSource.id,
      sourceVersion: speechSource.version,
      voice: "zh_male_shaonianzixin_uranus_bigtts",
      playbackRate: 2
    })
  });
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("x-speech-cache"), "hit");
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 1);
  const stale = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      captureId: speechSource.id,
      sourceVersion: speechSource.version + 1,
      voice: "zh_male_shaonianzixin_uranus_bigtts"
    })
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "SPEECH_SOURCE_STALE");
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 1);
  assert.ok((await fs.readdir(path.join(dataDir, "attachments"))).some(name => name.endsWith(".tts.mp3")));
  const speechState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(Object.hasOwn(speechState, "speechCache"), false);
  assert.equal(Object.hasOwn(speechState.captures[0], "speechCache"), false);
  assert.deepEqual(Object.keys(speechState.speech.assets[0]).sort(), [
    "bytes", "createdAt", "expiresAt", "generationRate", "id",
    "mimeType", "sourceId", "sourceType", "sourceVersion", "voice"
  ]);
  assert.equal(speechState.speech.assets[0].id, speechAssetId);
  assert.equal(JSON.stringify(speechState.speech.assets).includes("attachmentPath"), false);
  assert.equal(JSON.stringify(speechState.speech.assets).includes("ownerHash"), false);
  assert.equal(JSON.stringify(speechState.speech.assets).includes("textHash"), false);
  const cachedAudio = await fetch(`${base}/api/speech/audio?id=${encodeURIComponent(speechAssetId)}`);
  assert.equal(cachedAudio.status, 200);
  assert.equal(cachedAudio.headers.get("x-speech-cache"), "hit");
  assert.equal(cachedAudio.headers.get("accept-ranges"), "bytes");
  const cachedAudioBytes = Buffer.from(await cachedAudio.arrayBuffer());
  assert.equal(cachedAudioBytes.subarray(0, 3).toString("ascii"), "ID3");
  const cachedAudioHead = await fetch(`${base}/api/speech/audio?id=${encodeURIComponent(speechAssetId)}`, {
    method: "HEAD"
  });
  assert.equal(cachedAudioHead.status, 200);
  assert.equal(cachedAudioHead.headers.get("accept-ranges"), "bytes");
  assert.equal(cachedAudioHead.headers.get("content-length"), String(cachedAudioBytes.length));
  assert.equal((await cachedAudioHead.arrayBuffer()).byteLength, 0);
  const cachedAudioRange = await fetch(`${base}/api/speech/audio?id=${encodeURIComponent(speechAssetId)}`, {
    headers: { range: "bytes=1-3" }
  });
  assert.equal(cachedAudioRange.status, 206);
  assert.equal(cachedAudioRange.headers.get("content-range"), `bytes 1-3/${cachedAudioBytes.length}`);
  assert.equal(cachedAudioRange.headers.get("content-length"), "3");
  assert.deepEqual(Buffer.from(await cachedAudioRange.arrayBuffer()), cachedAudioBytes.subarray(1, 4));
  const cachedAudioRangeHead = await fetch(`${base}/api/speech/audio?id=${encodeURIComponent(speechAssetId)}`, {
    method: "HEAD",
    headers: { range: "bytes=-3" }
  });
  assert.equal(cachedAudioRangeHead.status, 206);
  assert.equal(
    cachedAudioRangeHead.headers.get("content-range"),
    `bytes ${cachedAudioBytes.length - 3}-${cachedAudioBytes.length - 1}/${cachedAudioBytes.length}`
  );
  assert.equal(cachedAudioRangeHead.headers.get("content-length"), "3");
  assert.equal((await cachedAudioRangeHead.arrayBuffer()).byteLength, 0);
  for (const range of ["bytes=0-1,3-4", `bytes=${cachedAudioBytes.length}-`]) {
    const rejectedRange = await fetch(`${base}/api/speech/audio?id=${encodeURIComponent(speechAssetId)}`, {
      headers: { range }
    });
    assert.equal(rejectedRange.status, 416);
    assert.equal(rejectedRange.headers.get("content-range"), `bytes */${cachedAudioBytes.length}`);
    assert.equal(rejectedRange.headers.get("content-length"), "0");
  }
  const missingAudio = await fetch(`${base}/api/speech/audio?id=missing-asset`);
  assert.equal(missingAudio.status, 404);
  assert.equal((await missingAudio.json()).code, "SPEECH_ASSET_NOT_FOUND");

  const regenerated = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceType: "capture",
      sourceId: speechSource.id,
      sourceVersion: speechSource.version,
      regenerate: true
    })
  });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.headers.get("x-speech-cache"), "miss");
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 2);
  await regenerated.arrayBuffer();

  const voiceResponse = await fetch(`${base}/api/speech/voices`);
  const voicePayload = await voiceResponse.json();
  assert.equal(voiceResponse.status, 200);
  assert.ok(voicePayload.voices.every(voice => voice.sampleText));
  const invalidPreview = await fetch(`${base}/api/speech/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      voice: "zh_male_shaonianzixin_uranus_bigtts",
      text: "客户端不能指定试听正文"
    })
  });
  assert.equal(invalidPreview.status, 400);
  assert.equal((await invalidPreview.json()).code, "INVALID_SPEECH_PREVIEW");
  const preview = await fetch(`${base}/api/speech/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice: "zh_male_shaonianzixin_uranus_bigtts" })
  });
  assert.equal(preview.status, 200);
  assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 3).toString("ascii"), "ID3");
  const previewAgain = await fetch(`${base}/api/speech/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice: "zh_male_shaonianzixin_uranus_bigtts" })
  });
  assert.equal(previewAgain.status, 200);
  await previewAgain.arrayBuffer();
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 3);
  const previewRequest = JSON.parse(providerCalls.filter(call => call.pathname === "/tts").at(-1).raw);
  assert.equal(previewRequest.req_params.text, voicePayload.voices[0].sampleText);

  const thoughtResponse = await fetch(`${base}/api/v1/thought-chains`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "speech-thought-source"
    },
    body: JSON.stringify({
      question: "测试问题？",
      answer: "**测试回答**",
      occurredAt: "2026-10-04T08:00:00.000Z"
    })
  });
  assert.equal(thoughtResponse.status, 201);
  const thoughtItems = (await thoughtResponse.json()).data.items;
  const thoughtRoot = thoughtItems.find(item => item.type === "question");
  const thoughtAnswer = thoughtItems.find(item => item.type === "answer");
  const thoughtSpeech = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceType: "thoughtAnswer",
      sourceId: thoughtAnswer.id,
      sourceVersion: thoughtAnswer.version
    })
  });
  assert.equal(thoughtSpeech.status, 200);
  await thoughtSpeech.arrayBuffer();
  const thoughtTtsRequest = JSON.parse(providerCalls.filter(call => call.pathname === "/tts").at(-1).raw);
  assert.equal(thoughtTtsRequest.req_params.text, "你的问题是：测试问题？，你的专属答复是测试回答");
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 4);
  const thoughtChainSpeech = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceType: "thoughtChain",
      sourceId: thoughtRoot.id,
      sourceVersion: thoughtRoot.version
    })
  });
  assert.equal(thoughtChainSpeech.status, 200);
  assert.equal(thoughtChainSpeech.headers.get("x-speech-cache"), "miss");
  const thoughtChainAssetId = thoughtChainSpeech.headers.get("x-speech-asset-id");
  assert.ok(thoughtChainAssetId);
  await thoughtChainSpeech.arrayBuffer();
  const thoughtChainTtsRequest = JSON.parse(providerCalls.filter(call => call.pathname === "/tts").at(-1).raw);
  assert.equal(thoughtChainTtsRequest.req_params.text, "我的问题：测试问题？ 我的结论：测试回答");
  assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, 5);
  const thoughtChainState = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(
    thoughtChainState.speech.assets.find(asset => asset.id === thoughtChainAssetId),
    {
      id: thoughtChainAssetId,
      sourceType: "thoughtChain",
      sourceId: thoughtRoot.id,
      sourceVersion: thoughtRoot.version,
      voice: "zh_male_shaonianzixin_uranus_bigtts",
      generationRate: 25,
      mimeType: "audio/mpeg",
      bytes: Number(thoughtChainSpeech.headers.get("content-length")),
      createdAt: thoughtChainState.speech.assets.find(asset => asset.id === thoughtChainAssetId)?.createdAt,
      expiresAt: thoughtChainState.speech.assets.find(asset => asset.id === thoughtChainAssetId)?.expiresAt
    },
    "the public state must expose the current thought-chain speech asset"
  );

  const imageBytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#ffffff" }
  }).png().toBuffer();
  const image = `data:image/png;base64,${imageBytes.toString("base64")}`;
  const candidates = await (await fetch(`${base}/api/keepsakes/understand`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      image,
      requestId: "keepsake-understanding",
      targetId: "keepsake-draft",
      inputVersion: 1,
      existingTags: ["测试", "票根", "其他"]
    })
  })).json();
  assert.deepEqual(candidates, {
    title: "测试票根",
    tags: ["测试", "票根"],
    description: "画面中是一张测试用票根。",
    requestId: "keepsake-understanding",
    targetId: "keepsake-draft",
    inputVersion: 1
  });
  const ocr = await (await fetch(`${base}/api/vision/ocr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image })
  })).json();
  assert.equal(ocr.text, "OCR TEST 2026");
  const document = await (await fetch(`${base}/api/vision/document`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: image })
  })).json();
  assert.equal(document.markdown, "# OCR TEST 2026");
  const parsedImage = await (await fetch(`${base}/api/images/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "weight", referenceDate: "2026-10-01", images: [image] })
  })).json();
  assert.equal(parsedImage.measuredWeight, 70, `${JSON.stringify(parsedImage)}\n${stderr}`);
  const structuredCall = providerCalls.find(call => {
    const request = call.pathname === "/deepseek" ? JSON.parse(call.raw) : null;
    return request?.response_format?.type === "json_object"
      && typeof request.messages.at(-1).content === "string";
  });
  assert.equal(typeof JSON.parse(structuredCall.raw).messages.at(-1).content, "string");
  assert.match(JSON.parse(structuredCall.raw).messages.at(-1).content, /OCR TEST 2026/);

  const wav = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.alloc(128)
  ]);
  const uploaded = await (await fetch(`${base}/api/audio/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "volcengine-audio-upload" },
    body: JSON.stringify({ audio: `data:audio/wav;base64,${wav.toString("base64")}`, durationMs: 1250 })
  })).json();
  const createdResponse = await fetch(`${base}/api/v1/captures`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "volcengine-capture-create" },
    body: JSON.stringify({ content: "", audio: uploaded.audio })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.transcription.status, "queued");
  const ready = await waitFor(async () => {
    const next = await (await fetch(`${base}/api/state`)).json();
    return next.captures.find(item => item.id === created.id)?.transcription?.status === "ready" ? next : null;
  });
  const capture = ready.captures.find(item => item.id === created.id);
  assert.equal(capture.transcription.rawText, "这是语音识别原文。");
  assert.equal(capture.transcription.polishedText, "这是整理后的转写。");
  assert.equal(capture.transcription.condensedText, "这是凝练后的转写。");
  assert.equal(capture.transcription.condenseErrorCode, "");
  assert.equal(asrConnections, 1);
  const usage = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"), "utf8"));
  assert.equal(usage.version, 4);
  assert.equal(usage.entries.filter(item => item.provider === "volcengine" && item.scene === "speechSynthesis" && item.unitType === "character").length, 4);
  assert.equal(usage.entries.filter(item => item.provider === "volcengine" && item.scene === "speechPreview" && item.unitType === "character").length, 1);
  assert.ok(usage.entries.some(item => item.provider === "volcengine" && item.scene === "speechRecognition" && item.unitType === "audioMillisecond"));
  assert.ok(usage.entries.some(item => item.provider === "volcengine" && item.scene === "visionOcr" && item.unitType === "image"));
  assert.ok(usage.entries.some(item => item.provider === "volcengine" && item.scene === "documentParsing" && item.unitType === "document"));
  const transcriptionUsage = usage.entries.filter(item => (
    item.provider === "deepseek" && item.scene === "capturePolish"
  ));
  assert.equal(transcriptionUsage.length, 2);
  assert.ok(transcriptionUsage.every(item => (
    item.model === "deepseek-flash" && item.tier === "lite" && item.effort === "none"
  )));
  assert.equal(usage.entries.filter(item => item.provider === "deepseek" && item.scene === "captureCondense").length, 0);
  const budget = JSON.parse(await fs.readFile(path.join(dataDir, "ai-budget.json"), "utf8"));
  assert.equal(budget.reservations.length, 0);
  assert.equal(budget.days[0].unknownCalls, 9);
  assert.equal(budget.days[0].users[0].calls, 13);
  assert.ok(budget.days[0].knownCostMicros > 0);
  assert.equal(budget.events.filter(item => item.type === "ai.budget.unknown_cost_warning").length, 9);
  const imageSettlement = budget.events.find(item => (
    item.type === "ai.budget.reservation_settled"
    && item.taskId.startsWith("image-parse:")
  ));
  assert.equal(imageSettlement.calls, 2);
  assert.equal(imageSettlement.unknownCalls, 1);
  assert.equal(imageSettlement.stages.length, 2);
  const transcriptionSettlement = budget.events.find(item => (
    item.type === "ai.budget.reservation_settled"
    && item.taskId.startsWith("capture-transcription:")
  ));
  assert.equal(transcriptionSettlement.calls, 3);
  assert.equal(transcriptionSettlement.unknownCalls, 1);
  assert.equal(transcriptionSettlement.stages.length, 3);
  assert.deepEqual(
    transcriptionSettlement.stages.map(item => item.stageId),
    ["speech-recognition", "deepseek-polish", "deepseek-condense"]
  );

  const changedVoice = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speech: { defaultVoice: "zh_female_vv_uranus_bigtts" } })
  });
  assert.equal(changedVoice.status, 200);
  budget.days[0].blocked.unknownCost = true;
  await fs.writeFile(path.join(dataDir, "ai-budget.json"), `${JSON.stringify(budget, null, 2)}\n`);
  const callsBeforeBudgetRejection = providerCalls.length;
  const siteRejected = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      captureId: speechSource.id,
      sourceVersion: speechSource.version,
      voice: "zh_female_vv_uranus_bigtts"
    })
  });
  assert.equal(siteRejected.status, 429);
  assert.equal((await siteRejected.json()).code, "AI_SITE_DAILY_UNKNOWN_COST_LIMIT");
  assert.equal(providerCalls.length, callsBeforeBudgetRejection, "site budget rejection must happen before provider I/O");

  const ownerBudget = await fetch(`${base}/api/v1/owner/ai-budget`);
  assert.equal(ownerBudget.status, 200);
  const recoveredBudget = await fetch(`${base}/api/v1/owner/ai-budget`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "if-match": ownerBudget.headers.get("etag")
    },
    body: JSON.stringify({
      command: "recover",
      scope: "dailyUnknownCost",
      reason: "server regression recovery"
    })
  });
  assert.equal(recoveredBudget.status, 200);
  assert.equal((await recoveredBudget.json()).data.day.blocked.unknownCost, false);

  const rejected = await fetch(`${base}/api/speech/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      captureId: speechSource.id,
      sourceVersion: speechSource.version,
      voice: "zh_female_vv_uranus_bigtts"
    })
  });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, "AI_DAILY_CALL_LIMIT");
  assert.equal(providerCalls.length, callsBeforeBudgetRejection, "account budget rejection must happen before provider I/O");
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "ai-budget.json"), "utf8")).reservations.length, 0);
  assert.ok(providerCalls.some(call => call.pathname === "/tts" && call.headers["x-api-key"] === "speech-test-key"));
  assert.ok(providerCalls.some(call => call.pathname === "/visual" && /Credential=visual-test-ak\//.test(call.headers.authorization || "")));
  assert.ok(providerCalls.some(call => call.pathname === "/deepseek"));
  assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT/);

  const oldCatalogPort = await freePort();
  const oldCatalogDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-old-speech-catalog-"));
  const ownerHash = crypto.createHash("sha256").update("local").digest("hex");
  await fs.writeFile(path.join(oldCatalogDataDir, "store.json"), `${JSON.stringify({
    version: 16,
    captures: [{
      id: "old-catalog-capture",
      version: 1,
      content: "旧目录下捕念朗读仍然可用",
      tags: [],
      attachmentPaths: [],
      annotations: [],
      annotationDrift: []
    }],
    thoughts: [{
      id: "old-catalog-question",
      type: "question",
      content: "旧目录为什么不能生成思绪朗读？",
      version: 1
    }, {
      id: "old-catalog-answer",
      type: "answer",
      relatedTo: "old-catalog-question",
      content: "因为缺少对应提示词。",
      version: 1
    }],
    speechCache: [{
      id: "old-thought-asset",
      cacheKey: "old-thought-asset",
      ownerHash,
      sourceType: "thoughtAnswer",
      sourceId: "old-catalog-answer",
      sourceVersion: 1,
      textHash: "historical-thought-text",
      voice: "zh_male_shaonianzixin_uranus_bigtts",
      generationRate: -10,
      attachmentPath: "/attachments/old-thought.tts.mp3",
      mimeType: "audio/mpeg",
      bytes: 64,
      createdAt: "2026-10-04T00:00:00.000Z",
      expiresAt: "2026-11-03T00:00:00.000Z"
    }],
    trash: [],
    attachmentCleanup: []
  }, null, 2)}\n`);
  const oldCatalogApp = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(oldCatalogPort),
      DATA_DIR: oldCatalogDataDir,
      AUTH_REQUIRED: "0",
      PERSISTENCE_BACKEND: "json",
      ATTACHMENT_STORAGE: "local",
      PROMPT_CATALOG_VERSION: "2026.10.04.1",
      VOLCENGINE_SPEECH_API_KEY: "speech-test-key",
      VOLCENGINE_TTS_ENDPOINT: `http://127.0.0.1:${provider.address().port}/tts`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let oldCatalogStderr = "";
  oldCatalogApp.stderr.on("data", chunk => { oldCatalogStderr += chunk; });
  const oldCatalogBase = `http://127.0.0.1:${oldCatalogPort}`;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`${oldCatalogBase}/readyz`).then(response => response.ok).catch(() => false)) break;
      if (attempt === 99) throw new Error(`旧 prompt catalog 服务未就绪\n${oldCatalogStderr}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const oldStateResponse = await fetch(`${oldCatalogBase}/api/state`);
    assert.equal(oldStateResponse.status, 200, oldCatalogStderr);
    const oldState = await oldStateResponse.json();
    assert.equal(oldState.speech.assets.some(asset => asset.sourceType === "thoughtAnswer"), false);

    const callsBeforeOldCatalogSpeech = providerCalls.filter(call => call.pathname === "/tts").length;
    const oldCaptureSpeech = await fetch(`${oldCatalogBase}/api/speech/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "capture",
        sourceId: "old-catalog-capture",
        sourceVersion: 1
      })
    });
    assert.equal(oldCaptureSpeech.status, 200, oldCatalogStderr);
    await oldCaptureSpeech.arrayBuffer();
    assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, callsBeforeOldCatalogSpeech + 1);

    const unavailableThoughtSpeech = await fetch(`${oldCatalogBase}/api/speech/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "thoughtAnswer",
        sourceId: "old-catalog-answer",
        sourceVersion: 1
      })
    });
    assert.equal(unavailableThoughtSpeech.status, 503);
    assert.equal((await unavailableThoughtSpeech.json()).code, "SPEECH_PROMPT_UNAVAILABLE");
    assert.equal(providerCalls.filter(call => call.pathname === "/tts").length, callsBeforeOldCatalogSpeech + 1);
    const oldStateAfterCapture = await (await fetch(`${oldCatalogBase}/api/state`)).json();
    assert.ok(oldStateAfterCapture.speech.assets.some(asset => asset.sourceType === "capture"));
    assert.equal(oldStateAfterCapture.speech.assets.some(asset => asset.sourceType === "thoughtAnswer"), false);
  } finally {
    oldCatalogApp.kill("SIGTERM");
    await once(oldCatalogApp, "exit").catch(() => {});
    await fs.rm(oldCatalogDataDir, { recursive: true, force: true });
  }
} finally {
  app.kill("SIGTERM");
  await once(app, "exit").catch(() => {});
  await new Promise(resolve => websocket.close(() => resolve()));
  await new Promise(resolve => websocketServer.close(() => resolve()));
  await new Promise(resolve => provider.close(() => resolve()));
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log("Volcengine server integration checks passed: TTS/vision, keepsake candidates and private recoverable capture transcription.");
