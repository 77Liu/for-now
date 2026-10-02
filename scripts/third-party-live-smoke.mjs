import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig, loadAttachmentConfig } from "../src/config/index.mjs";
import {
  createAliyunSegmentationTransport,
  createDeepSeekTransport,
  createVolcengineSpeechTransport,
  createVolcengineVisionTransport
} from "../src/infrastructure/ai-providers/index.mjs";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";
import { prepareFontconfigCache } from "./fontconfig-cache.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIVE = process.argv.includes("--live");
const MAX_ALLOWED_BUDGET_CNY = 3;
const requestedBudgetCny = Number(process.env.THIRD_PARTY_TEST_MAX_CNY || MAX_ALLOWED_BUDGET_CNY);
if (!Number.isFinite(requestedBudgetCny) || requestedBudgetCny <= 0 || requestedBudgetCny > MAX_ALLOWED_BUDGET_CNY) {
  throw new Error(`THIRD_PARTY_TEST_MAX_CNY 必须大于 0 且不超过 ${MAX_ALLOWED_BUDGET_CNY}`);
}

const reservations = Object.freeze({
  deepseek: 0.3,
  volcengineSpeech: 0.5,
  volcengineVision: 0.5,
  aliyunSegmentation: 0.8,
  aliyunOss: 0.2
});
const plannedReservationCny = Number(Object.values(reservations).reduce((sum, value) => sum + value, 0).toFixed(2));
if (plannedReservationCny > requestedBudgetCny) {
  throw new Error(`固定实测矩阵需预留 ¥${plannedReservationCny.toFixed(2)}，超过本轮预算 ¥${requestedBudgetCny.toFixed(2)}`);
}

async function deepSeekApiKey() {
  const direct = String(process.env.DEEPSEEK_API_KEY || process.env.E2E_DEEPSEEK_API_KEY || "").trim();
  if (direct) return direct;
  const settingsFile = String(process.env.THIRD_PARTY_DEEPSEEK_SETTINGS_FILE || "").trim();
  if (!settingsFile) return "";
  const settings = JSON.parse(await fs.readFile(path.resolve(settingsFile), "utf8"));
  return String(settings?.apiKey || "").trim();
}

const secretValues = [
  process.env.DEEPSEEK_API_KEY,
  process.env.E2E_DEEPSEEK_API_KEY,
  process.env.VOLCENGINE_SPEECH_API_KEY,
  process.env.VOLCENGINE_ACCESS_KEY_ID,
  process.env.VOLCENGINE_SECRET_ACCESS_KEY,
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
].filter(value => String(value || "").length >= 6).map(String);

function safeError(error) {
  let message = String(error?.publicMessage || error?.message || "第三方服务调用失败");
  for (const secret of secretValues) message = message.split(secret).join("[REDACTED]");
  message = message
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?key|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 300);
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: String(error?.code || error?.statusCode || error?.httpStatus || "UNKNOWN").slice(0, 120),
    message
  };
}

const results = [];
async function runService({ id, label, configured, coverage, run }) {
  const startedAt = Date.now();
  if (!configured) {
    results.push({ id, label, status: "not_configured", coverage, reservationCny: reservations[id], durationMs: 0 });
    return;
  }
  if (!LIVE) {
    results.push({ id, label, status: "ready", coverage, reservationCny: reservations[id], durationMs: 0 });
    return;
  }
  try {
    const evidence = await run();
    results.push({ id, label, status: "passed", coverage, reservationCny: reservations[id], durationMs: Date.now() - startedAt, evidence });
  } catch (error) {
    results.push({ id, label, status: "failed", coverage, reservationCny: reservations[id], durationMs: Date.now() - startedAt, error: safeError(error) });
  }
}

const appConfig = loadAppConfig({ rootDir: ROOT });
await prepareFontconfigCache({ dataDir: appConfig.dataDir });
const { default: sharp } = await import("sharp");
const attachmentConfig = loadAttachmentConfig();
const deepSeekKey = await deepSeekApiKey();
const aliyunCredentialConfigured = Boolean(
  attachmentConfig.roleName
  || (process.env.ALIBABA_CLOUD_ACCESS_KEY_ID && process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
);
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-third-party-"));
const fixtureFile = path.join(fixtureDir, "synthetic-object.png");
const fixture = await sharp({
  create: { width: 1000, height: 700, channels: 3, background: "#ffffff" }
}).composite([{
  input: Buffer.from(
    '<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">'
    + '<rect width="1000" height="700" fill="white"/>'
    + '<rect x="260" y="210" width="480" height="300" rx="24" fill="#b53b32"/>'
    + '<text x="310" y="385" font-size="72" font-family="Arial" fill="white">TEST 2026</text>'
    + '</svg>'
  )
}]).png().toBuffer();
await fs.writeFile(fixtureFile, fixture, { mode: 0o600 });

try {
  await runService({
    id: "deepseek",
    label: "DeepSeek",
    configured: Boolean(deepSeekKey),
    coverage: ["文本生成", "官方 usage"],
    run: async () => {
      const transport = createDeepSeekTransport({ endpoint: appConfig.deepSeekApiUrl });
      const response = await transport.complete({
        apiKey: deepSeekKey,
        parameters: {
          model: "deepseek-flash",
          thinking: { type: "disabled" },
          reasoning_effort: "none",
          max_tokens: 16,
          stream: false
        },
        messages: [{ role: "user", content: "只回复 OK" }],
        signal: AbortSignal.timeout(30_000)
      });
      assert.ok(response.content);
      return {
        model: response.modelReturned || "deepseek-flash",
        characters: response.content.length,
        inputTokens: Number(response.usage?.prompt_tokens || 0),
        outputTokens: Number(response.usage?.completion_tokens || 0),
        providerRequestId: response.providerRequestId || ""
      };
    }
  });

  await runService({
    id: "volcengineSpeech",
    label: "火山豆包语音",
    configured: Boolean(appConfig.speech.apiKey),
    coverage: ["TTS 2.0", "流式 ASR 2.0"],
    run: async () => {
      const speech = createVolcengineSpeechTransport(appConfig.speech);
      const synthesized = await speech.synthesize({ text: "这是一次第三方服务连通性测试。" });
      assert.ok(synthesized.audio.length >= 100);
      const transcript = await speech.transcribe({ audio: synthesized.audio, mimeType: "audio/mpeg" });
      assert.ok(transcript.rawText);
      return {
        ttsBytes: synthesized.audio.length,
        ttsVoice: synthesized.voice,
        ttsRequestId: synthesized.providerRequestId || "",
        asrCharacters: transcript.rawText.length,
        asrRequestId: transcript.providerRequestId || ""
      };
    }
  });

  await runService({
    id: "volcengineVision",
    label: "火山智能视觉",
    configured: Boolean(appConfig.vision.accessKeyId && appConfig.vision.secretAccessKey),
    coverage: ["通用 OCR", "智能文档解析"],
    run: async () => {
      const vision = createVolcengineVisionTransport(appConfig.vision);
      const ocr = await vision.recognizeText({ data: fixture });
      const document = await vision.parseDocument({ data: fixture, mimeType: "image/png" });
      assert.ok(ocr.text);
      assert.ok(document.markdown);
      return {
        ocrLines: ocr.lines.length,
        ocrCharacters: ocr.text.length,
        ocrRequestId: ocr.providerRequestId || "",
        documentPages: document.detail.length,
        documentCharacters: document.markdown.length,
        documentRequestId: document.providerRequestId || ""
      };
    }
  });

  await runService({
    id: "aliyunSegmentation",
    label: "阿里云图片分割",
    configured: aliyunCredentialConfigured,
    coverage: ["SegmentHDCommonImage", "异步结果查询", "PNG 下载"],
    run: async () => {
      let calls = 0;
      const segmentation = createAliyunSegmentationTransport({
        roleName: attachmentConfig.roleName,
        disableIMDSv1: attachmentConfig.disableIMDSv1,
        auditCall: async (_details, invoke) => {
          calls += 1;
          return invoke();
        }
      });
      const response = await segmentation.segment(fixtureFile, { callGroupId: crypto.randomUUID() });
      const output = Buffer.from(response.cutout.split(",")[1], "base64");
      assert.deepEqual(output.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { calls, sourceBytes: fixture.length, outputBytes: output.length, provider: response.provider };
    }
  });

  await runService({
    id: "aliyunOss",
    label: "阿里云 OSS",
    configured: Boolean(aliyunCredentialConfigured && attachmentConfig.bucket && attachmentConfig.endpoint),
    coverage: ["私有写入", "鉴权读取", "匿名拒绝", "删除确认"],
    run: async () => {
      const storage = createAttachmentStorage({ ...attachmentConfig, mode: "oss" });
      const ownerId = "__third_party_smoke__";
      const name = `probe-${Date.now()}-${crypto.randomUUID()}.bin`;
      const localFile = path.join(fixtureDir, name);
      const data = crypto.randomBytes(48);
      let uploaded = false;
      try {
        await storage.put({ ownerId, name, data, mimeType: "application/octet-stream", localFile });
        uploaded = true;
        assert.deepEqual(await storage.get({ ownerId, name, localFile, allowLocalFallback: false }), data);
        const endpoint = new URL(attachmentConfig.endpoint);
        const key = storage.objectKey(ownerId, name).split("/").map(encodeURIComponent).join("/");
        const anonymous = await fetch(new URL(`/${key}`, `${endpoint.protocol}//${attachmentConfig.bucket}.${endpoint.host}`), {
          signal: AbortSignal.timeout(8_000)
        });
        assert.notEqual(anonymous.status, 200, "OSS 测试对象可被匿名读取");
        await storage.remove({ ownerId, name, localFile });
        uploaded = false;
        await assert.rejects(
          storage.get({ ownerId, name, localFile, allowLocalFallback: false }),
          error => ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404
        );
        return { bytes: data.length, anonymousStatus: anonymous.status, deleted: true };
      } finally {
        if (uploaded) await storage.remove({ ownerId, name, localFile }).catch(() => {});
      }
    }
  });
} finally {
  await fs.rm(fixtureDir, { recursive: true, force: true });
}

const summary = {
  live: LIVE,
  maxBudgetCny: requestedBudgetCny,
  plannedReservationCny,
  actualCostCny: null,
  actualCostNote: "供应商账单存在延迟；脚本以固定最小调用矩阵控量，实际金额需在供应商控制台核对。",
  passed: results.filter(result => result.status === "passed").length,
  ready: results.filter(result => result.status === "ready").length,
  notConfigured: results.filter(result => result.status === "not_configured").length,
  failed: results.filter(result => result.status === "failed").length,
  services: results
};
console.log(JSON.stringify(summary, null, 2));
if (LIVE && results.some(result => result.status !== "passed")) process.exitCode = 2;
