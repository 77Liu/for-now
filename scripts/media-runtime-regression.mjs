import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaRuntime } from "../src/app/index.mjs";
import {
  createHealthImageConfig,
  normalizeHealthImage
} from "../src/modules/health/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import { installPromptCatalog } from "../src/shared/prompts/index.mjs";

installPromptCatalog({
  version: "media-runtime-regression",
  sha256: "media-runtime-regression",
  prompts: {
    "health.image.common": "COMMON",
    "health.image.weight": "WEIGHT {{common}} {{units}} {{schema}}",
    "health.image.exercise": "EXERCISE {{common}} {{units}} {{schema}}",
    "health.image.sleep": "SLEEP",
    "health.image.heartRate": "HEART",
    "health.image.book": "BOOK",
    "health.image.referenceDate": " REFERENCE={{referenceDate}}",
    "capture.transcription.polish": "POLISH {{rawText}}",
    "capture.transcription.condense": "CONDENSE {{rawText}} {{polishedText}}",
    "keepsake.image.candidates": "KEEPSAKE {{existingTags}}",
    "thought.speech.wrapper": "QUESTION {{question}} ANSWER {{answer}}"
  }
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-media-runtime-"));
const accountScope = new AsyncLocalStorage();
const stores = new Map();
const logs = [];
const debugCalls = [];
const scheduled = [];
const failedReads = new Set();
const sweepControl = {
  accountIds: ["account-a", "account-b"],
  barrier: null,
  error: null,
  calls: 0
};
const clone = value => structuredClone(value);
const emptyStore = () => ({
  version: 16,
  captures: [],
  keepsakes: [],
  books: [],
  quotes: [],
  speechCache: [],
  trash: [],
  attachmentCleanup: []
});
const accountId = () => {
  const value = accountScope.getStore();
  if (!value) throw new Error("test account context is required");
  return value;
};
const accountContext = () => {
  const ownerId = accountId();
  const dataDir = path.join(root, ownerId);
  return {
    ownerId,
    dataDir,
    attachmentsDir: path.join(dataDir, "attachments")
  };
};
const runAs = (id, operation) => accountScope.run(id, operation);

const repository = createJsonStoreRepository({
  getFile: accountId,
  async readDocument(file, fallback) {
    if (failedReads.has(file)) throw new Error(`read failed for ${file}`);
    return clone(stores.get(file) || fallback);
  },
  async writeDocument(file, document) {
    stores.set(file, clone(document));
  },
  normalize: value => value,
  emptyDocument: emptyStore(),
  now: () => "2026-10-06T12:00:00.000Z",
  getContext: () => ({ accountId: accountId() })
});

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const m4a = Buffer.from([
  0, 0, 0, 20,
  0x66, 0x74, 0x79, 0x70,
  0x4d, 0x34, 0x41, 0x20
]);
const audioDataUrl = `data:audio/mp4;base64,${m4a.toString("base64")}`;
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(36)
]);
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
let idSequence = 0;
const createId = () => `media-${++idSequence}`;

const books = {
  list: async () => [],
  get: async () => null,
  create: async () => ({}),
  update: async () => ({}),
  listNotes: async () => [],
  getNote: async () => null,
  createNote: async () => ({}),
  updateNote: async () => ({})
};
const quotes = {
  list: async () => [],
  get: async () => null,
  create: async () => ({}),
  update: async () => ({})
};
const fullAsrText = "完整的合成转写内容。".repeat(500);
const speechProvider = {
  configured: true,
  supportedAsrMimeTypes: ["audio/mp4", "audio/ogg", "audio/wav"],
  async prepareAsrAudio() {
    return { audio: wav, mimeType: "audio/wav" };
  },
  async transcribe(options) {
    assert.equal(options.maxDurationMs, 600000, "pass the existing application duration budget to the transport");
    return {
      provider: "speech-double",
      rawText: fullAsrText,
      providerRequestId: "speech-request",
      durationMs: 1234
    };
  },
  async synthesize() {
    throw new Error("speech provider must not be called by this regression");
  }
};
const segmentationProvider = {
  async segment() {
    throw new Error("segmentation provider must not be called by this regression");
  }
};

function createHarness({ visionConfigured }) {
  const budgetPlans = [];
  const providerCalls = [];
  const generations = [];
  const visionCalls = [];
  const visionProvider = {
    configured: visionConfigured,
    async recognizeText({ data }) {
      visionCalls.push(data.length);
      return { text: "provider recognized text" };
    }
  };
  const aiBudgetRuntime = {
    async executeTask(plan, operation) {
      budgetPlans.push(clone(plan));
      return operation({ id: `execution-${budgetPlans.length}` });
    }
  };
  const runDeepSeek = async (prompt, options) => {
    generations.push({ prompt, options: clone(options) });
    if (options.scene === "bookRecognition") {
      return JSON.stringify({ title: "媒体系统", author: "测试作者" });
    }
    if (options.scene === "capturePolish") {
      return prompt.startsWith("POLISH") ? "润色转写" : "精简转写";
    }
    if (prompt.includes("HEART")) {
      return JSON.stringify({
        date: "2026-10-05",
        minimum: 52,
        maximum: 123,
        average: 70,
        trendSegments: [
          { period: "上午", direction: "下降", approximateRange: "52-80" }
        ]
      });
    }
    return JSON.stringify({
      date: "2026-10-05",
      measuredWeight: 70.5,
      bodyFatPercent: 18
    });
  };
  const runtime = createMediaRuntime({
    repository,
    attachmentStorageConfig: { mode: "local" },
    attachmentQuotaBytes: 64 * 1024 * 1024,
    defaultImageMaxBytes: 8 * 1024 * 1024,
    uploadImageMaxBytes: 24 * 1024 * 1024,
    uploadAudioMaxBytes: 16 * 1024 * 1024,
    audioMaxDurationMs: 10 * 60 * 1000,
    getAttachmentContext: accountContext,
    getOwnerId: accountId,
    cleanupContextKey: accountId,
    keepsakeContextKey: accountId,
    dispatchCleanup: (callback, delay) => {
      scheduled.push({ callback, delay, accountId: accountId() });
      return scheduled.length;
    },
    dispatchKeepsake: callback => {
      scheduled.push({ callback, accountId: accountId() });
    },
    async listAccountIds() {
      sweepControl.calls += 1;
      if (sweepControl.barrier) await sweepControl.barrier;
      if (sweepControl.error) throw sweepControl.error;
      return [...sweepControl.accountIds];
    },
    runWithAccount: (id, operation) => runAs(id, operation),
    books,
    quotes,
    parseKeepsake: value => ({ value }),
    moveCollectionItemToTrash: () => ({ missing: true }),
    moveNestedItemToTrash: () => ({ missing: true }),
    speechQps: 100,
    speechConcurrency: 10,
    ocrQps: 100,
    ocrConcurrency: 10,
    documentQps: 100,
    documentConcurrency: 10,
    segmentationQps: 100,
    segmentationConcurrency: 10,
    aiBudgetRuntime,
    providerBudgetStage: (details, id = "provider-call") => ({
      ...details,
      id,
      costKnown: true,
      estimatedCostCny: 0
    }),
    conservativeDeepSeekStage: ({ id, scene, model = "deepseek-v4-pro" }) => ({
      id,
      provider: "deepseek",
      scene,
      model
    }),
    currentBudgetAccountId: accountId,
    async meteredProviderCall(details, invoke, summarize, budgetContext) {
      const call = { details: clone(details), budgetContext: clone(budgetContext) };
      providerCalls.push(call);
      const result = await invoke();
      call.summary = summarize?.(result);
      return result;
    },
    runDeepSeek,
    now: () => "2026-10-06T12:00:00.000Z",
    today: () => "2026-10-06",
    createId,
    hash,
    async logEvent(type, event, fields) {
      logs.push({ type, event, fields: clone(fields) });
    },
    debugServerUrl: "http://debug.invalid/events",
    debugRunId: "media-regression",
    async debugFetch(url, options) {
      debugCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
    speechProvider,
    visionProvider,
    segmentationProvider
  });
  return {
    runtime,
    budgetPlans,
    providerCalls,
    generations,
    visionCalls
  };
}

try {
  assert.throws(
    () => createMediaRuntime(),
    /Media runtime repository is required/
  );
  assert.throws(
    () => createMediaRuntime({
      repository: { read() {}, update() {} }
    }),
    /getAttachmentContext is required/
  );

  const configured = createHarness({ visionConfigured: true });
  const runtime = configured.runtime;
  for (const id of ["account-a", "account-b"]) {
    await runAs(id, () => runtime.imageAttachments.prepareDirectory());
  }

  await runAs("account-a", async () => {
    const first = await runtime.saveOriginalImages([pixel], {
      idempotencyKey: "image-replay"
    });
    const replay = await runtime.saveOriginalImages([pixel], {
      idempotencyKey: "image-replay"
    });
    assert.deepEqual(replay, first);
    assert.equal((await runtime.listAttachmentInventory()).length, 1);

    const stale = await runtime.saveOriginalImages([pixel, pixel], {
      idempotencyKey: "image-stale"
    });
    await runtime.imageAttachments.remove(stale.attachmentPaths[0]);
    await assert.rejects(
      runtime.saveOriginalImages([pixel, pixel], {
        idempotencyKey: "image-stale"
      }),
      error => error.code === "IDEMPOTENCY_RESULT_STALE"
        && error.statusCode === 409
        && error.message === "原图上传的幂等结果仅部分可用，请更换请求标识后重试"
    );

    const replace = await runtime.saveOriginalImages([pixel], {
      idempotencyKey: "image-replace"
    });
    await runtime.imageAttachments.remove(replace.attachmentPaths[0]);
    const regenerated = await runtime.saveOriginalImages([pixel], {
      idempotencyKey: "image-replace"
    });
    assert.notEqual(regenerated.attachmentPaths[0], replace.attachmentPaths[0]);
  });

  let accountAPaths;
  await runAs("account-a", async () => {
    accountAPaths = (await runtime.listAttachmentInventory()).map(item => item.path);
  });
  await runAs("account-b", async () => {
    assert.deepEqual(await runtime.listAttachmentInventory(), []);
    await runtime.saveOriginalImages([pixel], {
      idempotencyKey: "account-b-image"
    });
    const ownPaths = (await runtime.listAttachmentInventory()).map(item => item.path);
    assert.ok(ownPaths.length === 1);
    assert.ok(ownPaths.every(resourcePath => !accountAPaths.includes(resourcePath)));
  });

  let accountAAudio;
  await runAs("account-a", async () => {
    accountAAudio = (await runtime.saveOriginalAudio({
      audio: audioDataUrl,
      durationMs: 2500
    }, {
      idempotencyKey: "account-a-audio"
    })).audio;
    const prepared = await runtime.prepareCaptureAudio({ audio: accountAAudio });
    assert.equal(prepared.value.audio.attachmentPath, accountAAudio.attachmentPath);
    assert.equal(prepared.value.audio.bytes, m4a.length);
  });
  await runAs("account-b", async () => {
    const denied = await runtime.prepareCaptureAudio({ audio: accountAAudio });
    assert.deepEqual(denied, {
      forbidden: true,
      error: "语音附件不属于当前账户",
      code: "ATTACHMENT_NOT_OWNED"
    });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(debugCalls.some(call => (
    call.body.hypothesisId === "B-D"
    && call.body.data.durationMs === 2500
  )));

  await runAs("account-a", async () => {
    const heart = await runtime.parseImageRequest({ image: pixel }, "heartRate");
    assert.equal(heart.minimum, 52);
    assert.equal(heart.trendSegments[0].direction, "下降");
    const plan = configured.budgetPlans.at(-1);
    assert.deepEqual(plan.stages.map(stage => [
      stage.id,
      stage.scene,
      stage.model || ""
    ]), [
      ["ocr-1", "visionOcr", ""],
      ["deepseek-extraction", "healthRecognition", "deepseek-v4-pro"]
    ]);
    assert.equal(configured.providerCalls.at(-1).details.action, "OCRNormal");
    assert.equal(configured.providerCalls.at(-1).budgetContext.stageId, "ocr-1");
    assert.equal(configured.generations.at(-1).options.imagePaths, undefined);

    const book = await runtime.libraryWorkflows.parseBook({ image: pixel });
    assert.equal(book.title, "媒体系统");
    assert.deepEqual(
      configured.budgetPlans.at(-1).stages.map(stage => stage.id),
      ["ocr-1", "deepseek-book"]
    );
  });

  const fallback = createHarness({ visionConfigured: false });
  await runAs("account-b", async () => {
    const beforeOcrCalls = fallback.providerCalls.length;
    const weight = await fallback.runtime.parseImageRequest({
      image: pixel,
      referenceDate: "2026-10-05"
    }, "weight");
    assert.equal(weight.measuredWeight, 70.5);
    assert.equal(fallback.providerCalls.length, beforeOcrCalls);
    assert.deepEqual(
      fallback.budgetPlans.at(-1).stages.map(stage => [
        stage.id,
        stage.model
      ]),
      [["deepseek-extraction", "deepseek-flash"]]
    );
    assert.equal(fallback.generations.at(-1).options.imagePaths.length, 1);
  });

  const sleep = normalizeHealthImage("sleep", {
    date: "2026-10-05",
    bedtime: "2026-10-05 23:02",
    wakeTime: "2026-10-06T07:10:22+08:00",
    deepMinutes: "80",
    lightMinutes: 240,
    remMinutes: 60,
    totalMinutes: "",
    averageOxygen: 101,
    verification: " 已核对 "
  });
  assert.deepEqual({
    date: sleep.date,
    bedtime: sleep.bedtime,
    wakeTime: sleep.wakeTime,
    totalMinutes: sleep.totalMinutes,
    averageOxygen: sleep.averageOxygen,
    verification: sleep.verification
  }, {
    date: "2026-10-05",
    bedtime: "2026-10-05T23:02:00",
    wakeTime: "2026-10-06T07:10:22",
    totalMinutes: 380,
    averageOxygen: 100,
    verification: "已核对"
  });
  const heart = normalizeHealthImage("heartRate", {
    date: "invalid",
    minimum: 19,
    maximum: "120",
    average: 70,
    trendAnalysis: " 稳定 ",
    trendSegments: [
      { period: " 夜间 ", direction: "未知", approximateRange: " 55-70 " },
      { period: "", direction: "下降" }
    ],
    verification: " 人工复核 "
  });
  assert.deepEqual(heart, {
    date: "",
    minimum: 20,
    maximum: 120,
    average: 70,
    resting: null,
    sleepAverage: null,
    trendAnalysis: "稳定",
    trendSegments: [{
      period: "夜间",
      direction: "波动",
      approximateRange: "55-70"
    }],
    verification: "人工复核"
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(createHealthImageConfig()).map(([kind, config]) => [
      kind,
      [config.scene, config.maxImages]
    ])),
    {
      sleep: ["healthRecognition", 2],
      heartRate: ["healthRecognition", 1],
      weight: ["healthRecognition", 1],
      exercise: ["healthRecognition", 1]
    }
  );

  await runAs("account-a", async () => {
    const document = stores.get("account-a");
    document.captures = [{
      id: "capture-stale",
      version: 2,
      audio: {
        ...accountAAudio,
        attachmentPath: "/attachments/replaced.m4a"
      }
    }];
    stores.set("account-a", document);
    await assert.rejects(
      runtime.prepareCaptureAsrAudio({
        capture: { id: "capture-stale" },
        audio: accountAAudio
      }),
      error => error.code === "TRANSCRIPTION_STALE"
        && error.message === "语音原件已经变化，转写派生物未保留"
    );
    const inventory = await runtime.listAttachmentInventory();
    assert.equal(
      inventory.some(item => item.path === accountAAudio.attachmentPath.replace(
        /\.m4a$/,
        ".asr.wav"
      )),
      false
    );

    const documentAfterStale = stores.get("account-a");
    documentAfterStale.captures.push({
      id: "capture-ready",
      version: 3,
      audio: accountAAudio
    });
    stores.set("account-a", documentAfterStale);
    const transcription = await runtime.transcribeCapture({
      taskId: "task-ready",
      capture: { id: "capture-ready" },
      audio: accountAAudio
    });
    assert.deepEqual({
      rawText: transcription.rawText,
      polishedText: transcription.polishedText,
      condensedText: transcription.condensedText
    }, {
      rawText: fullAsrText,
      polishedText: "润色转写",
      condensedText: "精简转写"
    });
    const asrCall = configured.providerCalls.at(-1);
    assert.equal(asrCall.details.action, "flashAsr");
    assert.equal(asrCall.details.units, 600000, "reserve the existing maximum recording duration");
    assert.deepEqual(asrCall.summary, {
      providerRequestId: "speech-request", unitType: "audioMillisecond", units: 1234
    }, "bill the measured provider duration and preserve its request identity");
    assert.deepEqual(
      configured.budgetPlans.at(-1).stages.map(stage => [
        stage.id,
        stage.scene,
        stage.model || ""
      ]),
      [
        ["speech-recognition", "speechRecognition", ""],
        ["deepseek-polish", "capturePolish", "deepseek-v4-pro"],
        ["deepseek-condense", "capturePolish", "deepseek-v4-pro"]
      ]
    );
  });

  let expiredSpeechPath;
  await runAs("account-a", async () => {
    expiredSpeechPath = (await runtime.imageAttachments.saveSpeechAudio({
      data: Buffer.from("ID3-expired-speech"),
      mimeType: "audio/mpeg"
    })).attachmentPath;
    const document = stores.get("account-a");
    document.speechCache = [{
      id: "expired-speech",
      cacheKey: "expired-speech",
      sourceType: "capture",
      sourceId: "capture-expired",
      attachmentPath: expiredSpeechPath,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z"
    }];
    stores.set("account-a", document);
  });

  let releaseSweep;
  sweepControl.barrier = new Promise(resolve => { releaseSweep = resolve; });
  const firstSweep = runtime.speechCacheSweep.run();
  const coalescedSweep = runtime.speechCacheSweep.run();
  assert.equal(firstSweep, coalescedSweep);
  releaseSweep();
  const sweepResult = await firstSweep;
  assert.equal(sweepResult.failed, 0);
  assert.equal(sweepResult.entriesRemoved, 1);
  assert.equal(sweepResult.attachmentsRemoved, 1);
  sweepControl.barrier = null;
  await runAs("account-a", async () => {
    assert.equal(
      (await runtime.listAttachmentInventory()).some(item => (
        item.path === expiredSpeechPath
      )),
      false
    );
  });

  sweepControl.error = new Error("account listing unavailable");
  const failedSweep = runtime.speechCacheSweep.run();
  await assert.rejects(
    failedSweep,
    error => error === sweepControl.error
  );
  sweepControl.error = null;
  assert.equal((await runtime.speechCacheSweep.run()).failed, 0);

  failedReads.add("account-b");
  const partialSweep = await runtime.runSpeechCacheSweep();
  assert.equal(partialSweep.failed, 1);
  assert.ok(logs.some(entry => (
    entry.event === "speech_cache.sweep_account_failed"
    && entry.fields.accountHash === hash("account-b")
  )));
  failedReads.delete("account-b");

  assert.equal(
    configured.visionCalls.length >= 2,
    true,
    "configured health and book recognition must both use the OCR provider double"
  );
  console.log(
    "Media runtime regression passed: dependency validation, isolated inventory, upload replay/staleness, OCR fallback and budget stages, ASR cleanup, health normalization, and speech sweep single-flight/errors."
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
