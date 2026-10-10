import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LLM_SETTINGS_VERSION, LLM_SCENARIOS, defaultLlmSettings, normalizeLlmSettings, mergeLlmSettings, publicLlmSettings,
  mergeUserAiPreferences, publicUserAiPreferences, llmSettingsForScene, createLlmSettingsService,
  normalizeAiUsage, deepSeekUsageEntry, createAiUsageService, createAiAudit,
  automaticAnswerDecision, defaultAiCostPlan, normalizeAiCostPlan, createAiCostService, usageDashboard,
  usageEntryFromAudit, providerUsageEntry, resolveOfficialProviderPricing
} from "../src/modules/ai/index.mjs";
import { createAiSettingsHttp, createSpeechHttp } from "../src/http/index.mjs";
import { createAccountDocumentRepository } from "../src/shared/persistence/index.mjs";
import { localDateKey, shiftDateKey } from "../src/shared/time/index.mjs";

const now = () => "2026-09-29T01:00:00.000Z";
const legacy = { version: 2, profiles: defaultLlmSettings.profiles, scenarios: Object.fromEntries(LLM_SCENARIOS.map(scene => [scene, "ultra"])), apiKey: "private-test-value" };
assert.deepEqual(normalizeLlmSettings(legacy).scenarios, defaultLlmSettings.scenarios);
assert.equal(normalizeLlmSettings({ ...legacy, version: 3 }).scenarios.thoughtPrompt, "ultra");
for (const [model, effort, tier] of [["deepseek-flash", "none", "lite"], ["deepseek-flash", "max", "mid"], ["deepseek-v4-pro", "none", "high"], ["deepseek-v4-pro", "max", "ultra"]]) {
  const settings = normalizeLlmSettings({ model, effort, apiKey: "test" });
  assert.deepEqual(settings.profiles[tier], { model, effort });
}
const initial = normalizeLlmSettings({ apiKey: "private-test-value" });
assert.equal(initial.scenarios.perceptionExtraction, "lite");
assert.equal(initial.sceneEfforts.perceptionExtraction, "none");
assert.deepEqual(initial.speech, { defaultVoice: "", generationRate: -10 });
assert.equal(normalizeLlmSettings({ speech: { generationRate: -80 } }).speech.generationRate, -50);
assert.equal(normalizeLlmSettings({ speech: { generationRate: 140 } }).speech.generationRate, 100);
assert.equal(normalizeLlmSettings({ speech: { defaultVoice: " voice-a " } }).speech.defaultVoice, "voice-a");
const edited = mergeLlmSettings(initial, { model: "deepseek-flash", effort: "none", responseStyles: { chat: "concise" }, assistantName: " 新名字 " });
assert.equal(llmSettingsForScene(edited).model, "deepseek-flash");
assert.equal(llmSettingsForScene(edited, "chat").responseStyle, "concise");
assert.equal(edited.assistantName, "新名字");
assert.equal(edited.apiKey, initial.apiKey);
assert.equal(mergeLlmSettings(edited, { clearApiKey: true }).apiKey, "");
assert.equal(publicLlmSettings(edited).apiKey, undefined);
assert.doesNotMatch(JSON.stringify(publicLlmSettings(edited)), /private-test-value/);
assert.deepEqual(publicLlmSettings(edited).speech, { defaultVoice: "", generationRate: -10 });
assert.equal(mergeLlmSettings(edited, { speech: { generationRate: 25 } }).speech.generationRate, 25);
assert.equal(mergeLlmSettings(edited, { speech: { defaultVoice: "voice-a" } }).speech.defaultVoice, "voice-a");
assert.deepEqual(initial.automaticAnswers, { thoughtAnswer: false });
assert.equal(publicLlmSettings(initial).automaticAnswers.thoughtAnswer, false);
const userPreferenceBaseline = normalizeLlmSettings({
  ...initial,
  sceneEfforts: { ...initial.sceneEfforts, thoughtDraft: "none" }
});
const userPreferences = mergeUserAiPreferences(userPreferenceBaseline, {
  assistantName: "普通账户助手",
  sceneEfforts: { thoughtAnswer: "none" },
  speech: { defaultVoice: "voice-user" },
  apiKey: "must-not-change",
  profiles: { ultra: { model: "deepseek-flash", effort: "none" } }
});
assert.equal(userPreferences.assistantName, "普通账户助手");
assert.equal(userPreferences.sceneEfforts.thoughtAnswer, "none");
assert.equal(userPreferences.sceneEfforts.thoughtDraft, "none");
assert.equal(userPreferences.apiKey, initial.apiKey);
assert.deepEqual(userPreferences.profiles, initial.profiles);
assert.equal(userPreferences.speech.defaultVoice, "voice-user");
assert.equal(llmSettingsForScene(userPreferences, "thoughtAnswer").effort, "none");
assert.doesNotMatch(JSON.stringify(publicUserAiPreferences(userPreferences)), /apiKey|provider|profiles|private-test-value/);
assert.deepEqual(automaticAnswerDecision(initial, { requested: true, hasAnswer: false }), {
  enabled: false,
  generateAnswer: false,
  reason: "account_disabled"
});
const automaticEnabled = mergeLlmSettings(initial, { automaticAnswers: { thoughtAnswer: true } });
assert.equal(automaticEnabled.automaticAnswers.thoughtAnswer, true);
assert.deepEqual(automaticAnswerDecision(automaticEnabled, { requested: true, hasAnswer: false }), {
  enabled: true,
  generateAnswer: true,
  reason: "enabled"
});
assert.equal(automaticAnswerDecision(automaticEnabled, { requested: false, hasAnswer: false }).generateAnswer, true);
assert.equal(automaticAnswerDecision(automaticEnabled, { requested: true, hasAnswer: true }).reason, "answer_present");
let settingsDocument = structuredClone(initial), settingsResponse = null, settingsInput = {};
const settingsHttp = createAiSettingsHttp({
  settings: {
    read: async () => settingsDocument,
    update: async mutate => {
      settingsDocument = await mutate(settingsDocument);
      return settingsDocument;
    }
  },
  speech: {
    defaultVoice: "voice-default",
    voices: [{ id: "voice-default" }, { id: "voice-user" }]
  },
  generate: async () => "连接成功",
  bodyJson: async () => settingsInput,
  sendJson: (response, status, body) => { settingsResponse = { response, status, body }; }
});
assert.equal(await settingsHttp.handle({ method: "GET" }, {}, new URL("http://local/api/settings")), true);
assert.equal(settingsResponse.body.automaticAnswers.thoughtAnswer, false);
settingsInput = { automaticAnswers: { thoughtAnswer: true } };
assert.equal(await settingsHttp.handle({ method: "POST" }, {}, new URL("http://local/api/settings")), true);
assert.equal(settingsResponse.body.automaticAnswers.thoughtAnswer, true);
settingsInput = { sceneEfforts: { thoughtAnswer: "none" }, apiKey: "must-not-change" };
assert.equal(await settingsHttp.handle({ method: "PATCH" }, {}, new URL("http://local/api/preferences")), true);
assert.equal(settingsResponse.body.sceneEfforts.thoughtAnswer, "none");
assert.equal(settingsDocument.apiKey, initial.apiKey);
settingsInput = { speech: { defaultVoice: "not-a-real-voice" } };
assert.equal(await settingsHttp.handle({ method: "POST" }, {}, new URL("http://local/api/settings")), true);
assert.equal(settingsResponse.body.speech.defaultVoice, "voice-default");
assert.equal(settingsDocument.speech.defaultVoice, "voice-default");
settingsInput = { speech: { defaultVoice: "not-a-real-voice" } };
assert.equal(await settingsHttp.handle({ method: "PATCH" }, {}, new URL("http://local/api/preferences")), true);
assert.equal(settingsResponse.body.speech.defaultVoice, "voice-default");
assert.equal(settingsDocument.speech.defaultVoice, "voice-default");
settingsDocument.speech.defaultVoice = "not-a-real-voice";
assert.equal(await settingsHttp.handle({ method: "GET" }, {}, new URL("http://local/api/settings")), true);
assert.equal(settingsResponse.body.speech.defaultVoice, "voice-default");
assert.equal(await settingsHttp.handle({ method: "GET" }, {}, new URL("http://local/api/preferences")), true);
assert.equal(settingsResponse.body.speech.defaultVoice, "voice-default");
assert.equal((await settingsHttp.automaticAnswer({ requested: true })).generateAnswer, true);

const peak = deepSeekUsageEntry({
  callId: "peak", createdAt: now(), model: "deepseek-flash",
  usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 40 }, secret: "drop", invalid: Infinity }
});
assert.equal(peak.pricingPeriod, "peak");
assert.deepEqual(peak.tokens, { input: 1000, cacheHit: 200, cacheMiss: 800, reasoning: 40, answer: 60, output: 100 });
assert.ok(Math.abs(peak.costCny - 0.002408) < 1e-12);
assert.equal(peak.costsCny.total, peak.costCny);
assert.deepEqual(peak.ratesCnyPerMillion, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
assert.equal(peak.costKnown, true);
assert.equal(peak.rawUsage.secret, undefined);
assert.equal(peak.rawUsage.invalid, undefined);
assert.equal(deepSeekUsageEntry({ createdAt: "2026-09-27T01:00:00Z", model: "deepseek-flash", usage: { prompt_tokens: 1000, completion_tokens: 100 } }).pricingPeriod, "offPeak");
for (const usage of [null, {}, { prompt_tokens: 1000 }, { completion_tokens: 100 }, { prompt_tokens: "100", completion_tokens: 100 }]) {
  const entry = deepSeekUsageEntry({ model: "deepseek-flash", createdAt: now(), usage });
  assert.equal(entry.usageKnown, false);
  assert.equal(entry.costCny, 0);
  assert.equal(entry.costKnown, false);
  assert.equal(entry.tokens.input, 0);
}
const historical = normalizeAiUsage({ entries: [{ id: "legacy", createdAt: now(), model: "deepseek-flash", costsUsd: { total: 0.125 } }] }).entries[0];
assert.equal(historical.costsUsd.total, 0.125);
assert.equal(historical.status, "unknown");
assert.equal(historical.modality, "unknown");
assert.equal(historical.durationKnown, false);
assert.equal(normalizeAiUsage({
  entries: [{ id: "capture-polish", createdAt: now(), model: "deepseek-flash", scene: "capturePolish" }]
}).entries[0].scene, "capturePolish");
for (const [details, expected] of [
  [
    { provider: "volcengine", service: "speech", action: "synthesize", unitType: "character", units: 20_000 },
    { unitType: "character", units: 20_000, costCny: 6 }
  ],
  [
    { provider: "volcengine", service: "speech", action: "streamingAsr", unitType: "audioMillisecond", units: 1_800_000 },
    { unitType: "audioMillisecond", units: 1_800_000, costCny: 0.5 }
  ],
  [
    { provider: "volcengine", service: "vision", action: "OCRNormal", unitType: "image", units: 2 },
    { unitType: "call", units: 2, costCny: 0.01 }
  ],
  [
    { provider: "volcengine", service: "vision", action: "OCRPdf", unitType: "document", units: 3 },
    { unitType: "page", units: 3, costCny: 0.06 }
  ],
  [
    { provider: "aliyun", service: "segmentation", action: "SegmentHDCommonImage", unitType: "image", units: 2 },
    { unitType: "call", units: 2, costCny: 0.014 }
  ],
  [
    { provider: "aliyun", service: "segmentation", action: "GetAsyncJobResult", unitType: "call", units: 1 },
    { unitType: "call", units: 1, costCny: 0 }
  ],
  [
    { provider: "aliyun", service: "segmentation", action: "DownloadSegmentResult", unitType: "call", units: 1 },
    { unitType: "call", units: 1, costCny: 0 }
  ]
]) {
  const resolved = resolveOfficialProviderPricing(details);
  assert.equal(resolved.costKnown, true);
  assert.equal(resolved.unitType, expected.unitType);
  assert.equal(resolved.units, expected.units);
  assert.ok(Math.abs(resolved.costCny - expected.costCny) < 1e-12);
  assert.match(resolved.costSource, /^https:\/\/.+#2026-10-02$/);
}
assert.deepEqual(
  resolveOfficialProviderPricing({
    provider: "volcengine",
    service: "speech",
    action: "unmappedAction",
    unitType: "call",
    units: 1
  }),
  {
    unitType: "call",
    units: 1,
    costKnown: false,
    costCny: 0,
    costSource: ""
  }
);
const providerEntry = providerUsageEntry({
  callId: "provider-call",
  createdAt: now(),
  completedAt: now(),
  provider: "volcengine",
  service: "speech",
  scene: "speechRecognition",
  action: "streamingAsr",
  status: "success",
  durationMs: 120,
  durationKnown: true,
  modality: "audio",
  unitType: "audioMillisecond",
  units: 1250,
  costSource: "billing pending"
});
assert.equal(providerEntry.provider, "volcengine");
assert.equal(providerEntry.scene, "speechRecognition");
assert.equal(providerEntry.units, 1250);
assert.equal(providerEntry.usageKnown, true);
assert.equal(providerEntry.costKnown, true);
assert.ok(Math.abs(providerEntry.costCny - (1250 / 3_600_000)) < 1e-12);
assert.equal(normalizeAiUsage({
  version: 4,
  entries: [{
    id: "legacy-measured-provider",
    createdAt: now(),
    provider: "volcengine",
    service: "speech",
    model: "volcengine-speech",
    scene: "speechSynthesis",
    unitType: "character",
    units: 12,
    usageKnown: false
  }]
}).entries[0].usageKnown, true);
const inferredProviderUsage = normalizeAiUsage({ entries: [
  { ...providerEntry, id: "legacy-speech", callId: "legacy-speech", modality: "unknown" },
  { ...providerEntry, id: "legacy-vision", callId: "legacy-vision", service: "vision", scene: "visionOcr", modality: "unknown", unitType: "image", units: 2 },
  { ...providerEntry, id: "legacy-document", callId: "legacy-document", service: "vision", action: "OCRPdf", scene: "documentParsing", modality: "unknown", unitType: "page", units: 3 },
  { ...providerEntry, id: "legacy-segmentation", callId: "legacy-segmentation", provider: "aliyun", service: "segmentation", scene: "keepsakeSegmentation", modality: "unknown", unitType: "image", units: 1 }
] }).entries;
assert.deepEqual(inferredProviderUsage.map(item => [item.modality, item.imageCount]), [
  ["audio", 0],
  ["vision", 2],
  ["document", 0],
  ["vision", 1]
]);

assert.equal(localDateKey(new Date(2026, 8, 29, 0, 0, 0)), "2026-09-29");
assert.equal(localDateKey("invalid"), "");
assert.equal(shiftDateKey("2024-03-01", -1), "2024-02-29");
assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
const sampleUsage = normalizeAiUsage({ trackingStartedAt: now(), entries: [
  { ...peak, scene: "chat", status: "success", durationKnown: true, durationMs: 40, modality: "vision", imageCount: 1 },
  { ...historical, scene: "chat", createdAt: now(), status: "failed" },
  { ...peak, scene: "chat", createdAt: "2026-07-01T12:00:00Z" }
] });
assert.equal(normalizeAiUsage({
  trackingStartedAt: now(),
  entries: [{ ...peak, id: "perception", callId: "perception", scene: "perceptionExtraction" }]
}).entries[0].scene, "perceptionExtraction");
const costOptions = { date: "2026-09-29", cnyPerUsd: 7.2 };
const costDefault = defaultAiCostPlan(initial, sampleUsage, costOptions);
const chat = costDefault.scenarios.find(item => item.scene === "chat");
assert.equal(chat.callsPerMonth, 2);
assert.equal(chat.avgInputTokens, 1000); // Unknown usage counts as a call, not as observed zero tokens.
assert.equal(chat.avgAnswerTokens, 60);
assert.equal(chat.cacheHitPct, 20);
const costNormalized = normalizeAiCostPlan({ monthlyBudgetCny: -1, scenarios: [{ scene: "chat", cacheHitPct: 120, avgInputTokens: 1.6, model: "invalid" }] }, initial, sampleUsage, costOptions);
assert.equal(costNormalized.monthlyBudgetCny, 0);
assert.equal(costNormalized.scenarios.find(item => item.scene === "chat").cacheHitPct, 100);
assert.equal(costNormalized.scenarios.find(item => item.scene === "chat").avgInputTokens, 2);
assert.equal(costNormalized.scenarios.length, LLM_SCENARIOS.length);
assert.equal(
  costNormalized.scenarios.find(item => item.scene === "perceptionExtraction").callsPerMonth,
  100
);
const dashboard = usageDashboard(sampleUsage, "2026-09-28", "2026-09-29", 6.5, 7.2);
assert.equal(dashboard.summary.calls, 2);
assert.equal(dashboard.summary.usageUnknownCalls, 1);
assert.equal(dashboard.summary.failedCalls, 1);
assert.equal(dashboard.summary.durationKnownCalls, 1);
assert.equal(dashboard.summary.visionCalls, 1);
assert.equal(dashboard.daily[0].calls, 0);
assert.equal(dashboard.calibration.activeDays, 1);
assert.equal(dashboard.summary.costsUsd.total, historical.costsUsd.total);
assert.equal(dashboard.summary.costCny, peak.costCny);
assert.equal(dashboard.summary.costsCny.total, peak.costCny);
assert.equal(dashboard.calibration.maxCostCny, 0.125 * 6.5); // Preserve historical price snapshots.
const providerDashboard = usageDashboard(normalizeAiUsage({ trackingStartedAt: now(), entries: [
  providerEntry,
  { ...providerEntry, id: "provider-known", callId: "provider-known", service: "vision", action: "OCRNormal", scene: "visionOcr", modality: "vision", unitType: "image", units: 1, costKnown: true, costCny: 2.5 }
] }), "2026-09-29", "2026-09-29", 6.5, 7.2);
assert.equal(providerDashboard.summary.calls, 2);
assert.equal(providerDashboard.summary.costCny, 2.5 + providerEntry.costCny);
assert.equal(providerDashboard.summary.costUnknownCalls, 0);
assert.deepEqual(providerDashboard.providers.map(item => [item.provider, item.calls, item.costCny, item.costUnknownCalls]), [
  ["volcengine", 2, 2.5 + providerEntry.costCny, 0]
]);
assert.equal(providerDashboard.modalities.find(item => item.modality === "audio").costUnknownCalls, 0);
assert.equal(providerDashboard.scenes.find(item => item.scene === "visionOcr").costCny, 2.5);
assert.equal(providerDashboard.calibration.p90CostCny, 2.5);
assert.deepEqual(providerDashboard.services.map(item => item.label), [
  "DeepSeek 文本",
  "DeepSeek 图片理解",
  "豆包语音合成",
  "豆包语音识别",
  "火山文字识别",
  "火山文档解析",
  "阿里云图片分割"
]);
assert.deepEqual(providerDashboard.services.find(item => item.key === "volcengineAsr").unitUsage, [
  { unitType: "audioMillisecond", units: 1250 }
]);
assert.deepEqual(providerDashboard.services.find(item => item.key === "volcengineOcr").unitUsage, [
  { unitType: "image", units: 1 }
]);
assert.equal(providerDashboard.daily[0].services.volcengineAsr.calls, 1);
assert.equal(providerDashboard.daily[0].services.volcengineOcr.calls, 1);
assert.equal(providerDashboard.pricing.providerRates.length, 6);
assert.ok(providerDashboard.pricing.providerRates.every(item => (
  item.priceCny > 0
  && item.checkedAt === "2026-10-02"
  && /^https:\/\//.test(item.source)
)));
assert.equal(normalizeAiUsage({
  entries: [{
    id: "segmentation",
    createdAt: now(),
    provider: "aliyun",
    service: "segmentation",
    scene: "keepsakeSegmentation"
  }]
}).entries[0].scene, "keepsakeSegmentation");

let speechAuditDetails = null, synthesizedText = "", speechStatus = 0;
const speechHttp = createSpeechHttp({
  speech: {
    configured: true,
    defaultVoice: "voice-a",
    voices: [{ id: "voice-a", sampleText: "试听" }],
    async synthesize({ text }) {
      synthesizedText = text;
      return { audio: Buffer.from("audio"), mimeType: "audio/mpeg", voice: "voice-a" };
    }
  },
  gate: { acquire: async () => () => {} },
  auditCall: async (details, invoke) => {
    speechAuditDetails = details;
    return invoke();
  },
  bodyJson: async () => ({ text: "  测试朗读  ", sourceVersion: 1 }),
  sendJson: () => {}
});
await speechHttp.handle(
  { method: "POST", headers: {} },
  {
    writeHead(status) { speechStatus = status; },
    end() {}
  },
  new URL("http://local/api/speech/synthesize")
);
assert.equal(speechStatus, 200);
assert.equal(synthesizedText, "测试朗读");
assert.equal(speechAuditDetails.requestChars, 4);
assert.equal(speechAuditDetails.units, 4);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-ai-domain-"));
const context = new AsyncLocalStorage();
const run = (account, callback) => context.run({ account, secrets: ["private-test-value"] }, callback);
const getFile = () => path.join(directory, `${context.getStore().account}.json`);
let failWrite = false;
const changes = [];
const readDocument = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
};
const writeDocument = async (file, value) => {
  if (failWrite) throw Object.assign(new Error("injected write failure"), { code: "EIO" });
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
};
try {
  const repository = createAccountDocumentRepository({
    getFile, readDocument, writeDocument, name: "settings", normalize: normalizeLlmSettings,
    emptyDocument: defaultLlmSettings, now, onCommit: async (before, after) => changes.push({ account: context.getStore().account, before, after: structuredClone(after) })
  });
  const settings = createLlmSettingsService({ repository });
  await run("a", async () => {
    await fs.writeFile(getFile(), JSON.stringify(legacy));
    await settings.ensure();
    assert.equal((await fs.stat(`${getFile()}.v2-pre-v${LLM_SETTINGS_VERSION}.20260929010000.bak`)).mode & 0o777, 0o600);
    await Promise.all([
      settings.update(current => mergeLlmSettings(current, { assistantName: "并发名称" })),
      settings.update(current => mergeLlmSettings(current, { apiKey: "next-test-value" }))
    ]);
    assert.equal((await settings.read()).assistantName, "并发名称");
    assert.equal((await settings.read()).apiKey, "next-test-value");
    failWrite = true;
    const count = changes.length;
    await assert.rejects(settings.update(current => mergeLlmSettings(current, { assistantName: "未提交" })), { code: "EIO" });
    assert.equal(changes.length, count);
    assert.equal((await settings.read()).assistantName, "并发名称");
    failWrite = false;
    await settings.update(current => mergeLlmSettings(current, { assistantName: "恢复" }));
  });
  await Promise.all(["a", "b"].map((account, index) => run(account, () => settings.update(current => mergeLlmSettings(current, {
    assistantName: account,
    speech: { defaultVoice: `voice-${account}`, generationRate: index ? 40 : -20 }
  })))));
  for (const [account, generationRate] of [["a", -20], ["b", 40]]) {
    const accountSettings = await run(account, settings.read);
    assert.equal(accountSettings.assistantName, account);
    assert.equal(accountSettings.speech.defaultVoice, `voice-${account}`);
    assert.equal(accountSettings.speech.generationRate, generationRate);
  }
  await run("broken", async () => {
    await fs.writeFile(getFile(), "{CORRUPT");
    await assert.rejects(settings.ensure());
    assert.equal(await fs.readFile(getFile(), "utf8"), "{CORRUPT");
  });

  let costSettingsFail = false, costReads = 0, costWrites = 0;
  const costRepository = createAccountDocumentRepository({
    name: "costPlan", getFile: () => path.join(directory, `${context.getStore().account}-cost.json`),
    readDocument, writeDocument: async (...args) => { costWrites += 1; await writeDocument(...args); },
    normalize: value => value, emptyDocument: null,
    onCommit: async (before, after) => changes.push({ account: context.getStore().account, before, after })
  });
  const costs = createAiCostService({
    repository: costRepository, cnyPerUsd: 7.2, now,
    readSettings: async () => { costReads += 1; if (costSettingsFail && costReads % 2 === 0) throw new Error("settings read failed"); return initial; },
    readUsage: async () => sampleUsage
  });
  const unchangedSettings = structuredClone(initial), unchangedUsage = structuredClone(sampleUsage);
  await Promise.all(["a", "b"].map((account, index) => run(account, () => costs.save({ monthlyBudgetCny: 50 + index }))));
  assert.equal((await run("a", costs.read)).monthlyBudgetCny, 50);
  assert.equal((await run("b", costs.read)).monthlyBudgetCny, 51);
  await run("a", () => costs.save({ contingencyPct: 25 }));
  assert.equal((await run("a", costs.read)).monthlyBudgetCny, 30); // PATCH remains a full replacement.
  const previousWrites = costWrites, previousChanges = changes.length;
  costSettingsFail = true; costReads = 0;
  await assert.rejects(run("a", () => costs.save({ monthlyBudgetCny: 77 })), /settings read failed/);
  assert.equal(costWrites, previousWrites); // Fallible normalization happens before the commit.
  assert.equal(changes.length, previousChanges);
  costSettingsFail = false;
  assert.equal((await run("a", costs.read)).monthlyBudgetCny, 30);
  assert.deepEqual(initial, unchangedSettings);
  assert.deepEqual(sampleUsage, unchangedUsage);

  // Runtime adapter: no file I/O, normalized update, audit only after successful commit.
  let persisted = structuredClone(initial), rollback = false;
  const runtimeChanges = [];
  const runtimeRepository = createAccountDocumentRepository({
    name: "settings", normalize: normalizeLlmSettings, emptyDocument: defaultLlmSettings,
    getFile: () => { throw new Error("runtime must not read a file"); },
    runtime: { documents: {
      read: async () => structuredClone(persisted),
      update: async (name, fallback, mutate, normalize) => {
        assert.equal(name, "settings");
        const next = normalize(structuredClone(persisted));
        const result = await mutate(next);
        if (rollback) throw new Error("commit failed");
        persisted = next;
        return result;
      }
    } },
    onCommit: async (...args) => runtimeChanges.push(args)
  });
  const runtimeSettings = createLlmSettingsService({ repository: runtimeRepository });
  await runtimeSettings.update(current => mergeLlmSettings(current, { assistantName: "已提交" }));
  rollback = true;
  await assert.rejects(runtimeSettings.update(current => mergeLlmSettings(current, { assistantName: "未提交" })), /commit failed/);
  assert.equal((await runtimeSettings.read()).assistantName, "已提交");
  assert.equal(runtimeChanges.length, 1);

  const entries = [];
  const quota = createAiUsageService({
    repository: { read: async () => ({ entries }), update: async mutate => mutate({ entries }) },
    getAccountKey: () => context.getStore().account, dailyCallLimit: 1, dailyCostLimitCny: 1, cnyPerUsd: 7.2, now
  });
  const attempts = await run("quota-a", () => Promise.allSettled([quota.reserveAttempt(), quota.reserveAttempt()]));
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(attempts.find(item => item.status === "rejected").reason.code, "AI_DAILY_CALL_LIMIT");
  const releaseOther = await run("quota-b", quota.reserveAttempt);
  releaseOther();
  const release = attempts.find(item => item.status === "fulfilled").value;
  release(); release();
  (await run("quota-a", quota.reserveAttempt))();
  entries.push({ createdAt: now(), costsUsd: { total: 1 } });
  const costQuota = createAiUsageService({
    repository: { read: async () => ({ entries }) }, getAccountKey: () => "cost", dailyCallLimit: 100, dailyCostLimitCny: 1, cnyPerUsd: 7.2, now
  });
  await assert.rejects(costQuota.reserveAttempt(), { code: "AI_DAILY_COST_LIMIT" });
  const unlimitedCostQuota = createAiUsageService({
    repository: { read: async () => ({ entries }) }, getAccountKey: () => "unlimited-cost", dailyCallLimit: 100, dailyCostLimitCny: null, cnyPerUsd: 7.2, now
  });
  (await unlimitedCostQuota.reserveAttempt()).release();
  let reservationNow = now();
  const pendingCostQuota = createAiUsageService({
    repository: { read: async () => ({ entries: [] }) },
    getAccountKey: () => "pending-cost",
    dailyCallLimit: 100,
    dailyCostLimitCny: 1,
    cnyPerUsd: 7.2,
    now: () => reservationNow
  });
  const pendingCost = await pendingCostQuota.reserveAttempt();
  pendingCost.retain({ costsUsd: { total: 1 } });
  await assert.rejects(pendingCostQuota.reserveAttempt(), { code: "AI_DAILY_COST_LIMIT" });
  reservationNow = "2026-09-30T01:00:00.000Z";
  (await pendingCostQuota.reserveAttempt()).release();
  pendingCost.commit();

  let auditFails = false, usageFails = false;
  const auditRecords = [], usageRecords = [], events = [];
  const audit = createAiAudit({
    textLimit: 10, getContext: () => context.getStore(), now,
    append: async (day, entry) => { if (auditFails) throw new Error("audit failed"); auditRecords.push({ day, entry }); },
    updateUsage: async mutate => { if (usageFails) throw new Error("usage failed"); mutate({ entries: usageRecords }); },
    logEvent: async (...args) => events.push(args)
  });
  assert.equal(audit.text("123456789012"), "1234567890\n[TRUNCATED 2 CHARS]");
  assert.deepEqual(audit.message({ role: "bad", content: [{ type: "image_url", image_url: { url: "data:private" } }] }), { role: "unknown", content: [{ type: "image_url", omitted: true }] });
  const terminal = { callId: "audit-test", status: "success", startedAt: now(), response: { httpStatus: 200, content: "private-test-value" } };
  await run("audit-a", async () => {
    await audit.start(terminal);
    await audit.recordDeepSeekAttempt({ usage: null, audit: terminal, usageMetadata: { model: "deepseek-flash", createdAt: now() } });
    auditFails = true;
    await audit.start(terminal);
    await audit.recordDeepSeekAttempt({ audit: terminal, usageMetadata: { model: "deepseek-flash", createdAt: now() } });
    auditFails = false;
    usageFails = true;
    await audit.recordDeepSeekAttempt({ audit: terminal, usageMetadata: { model: "deepseek-flash", createdAt: now() } });
    auditFails = true;
    await audit.recordDeepSeekAttempt({ audit: terminal, usageMetadata: { model: "deepseek-flash", createdAt: now() } });
    assert.equal(await audit.segmentationCall("mock", "group", {}, async () => "success", () => ({})), "success");
    await assert.rejects(audit.segmentationCall("mock", "group", {}, async () => { throw Object.assign(new Error("provider failed"), { code: "PROVIDER_FAIL" }); }), { code: "PROVIDER_FAIL" });
  });
  assert.equal(usageRecords.length, 1);
  assert.equal(auditRecords.length, 3);
  assert.doesNotMatch(JSON.stringify(auditRecords), /private-test-value/);
  for (const target of ["usage", "audit", "audit_start"]) assert.ok(events.some(([, name, fields]) => name === "ai.log_failed" && fields.target === target));
  assert.equal(events.filter(([, name]) => name === "ai.completed").length, 4);

  let recoveryUsageFails = true, recoveryAuditFails = true, retained = 0, committed = 0;
  const recoveredUsage = [], recoveredAudits = [];
  const recoverableAudit = createAiAudit({
    textLimit: 100, getContext: () => context.getStore(), now,
    append: async (day, entry) => {
      if (recoveryAuditFails) throw new Error("audit unavailable");
      recoveredAudits.push({ day, entry });
    },
    updateUsage: async mutate => {
      if (recoveryUsageFails) throw new Error("usage unavailable");
      mutate({ entries: recoveredUsage });
    },
    logEvent: async (...args) => events.push(args)
  });
  const recoverableTerminal = {
    callId: "recoverable-success",
    callGroupId: "recoverable-group",
    status: "success",
    startedAt: now(),
    response: { httpStatus: 200, content: "answer" }
  };
  const persistence = await run("recovery-a", () => recoverableAudit.recordDeepSeekAttempt({
    usage: { prompt_tokens: 20, completion_tokens: 5 },
    audit: { ...recoverableTerminal, actor: { userId: "recovery-a" } },
    usageMetadata: { model: "deepseek-flash", createdAt: now(), scene: "thoughtAnswer", status: "success" },
    reservation: {
      retain() { retained += 1; },
      commit() { committed += 1; }
    }
  }));
  assert.deepEqual(persistence, { usagePersisted: false, auditPersisted: false, pendingUsage: 1, pendingAudit: 1 });
  assert.equal(retained, 1);
  assert.equal(committed, 0);
  recoveryUsageFails = false;
  recoveryAuditFails = false;
  assert.deepEqual(await run("recovery-b", recoverableAudit.recoverPending), {
    recoveredUsage: 0,
    recoveredAudit: 0,
    pendingUsage: 0,
    pendingAudit: 0
  });
  assert.equal(committed, 0);
  assert.deepEqual(await run("recovery-a", recoverableAudit.recoverPending), {
    recoveredUsage: 1,
    recoveredAudit: 1,
    pendingUsage: 0,
    pendingAudit: 0
  });
  assert.equal(committed, 1);
  assert.equal(recoveredUsage.length, 1);
  assert.equal(recoveredAudits.length, 2);
  assert.equal(recoveredAudits[0].entry.usage.costKnown, true);
  assert.equal(recoveredAudits[0].entry.usage.costCny, recoveredUsage[0].costCny);
  assert.deepEqual(recoveredAudits[0].entry.usage.ratesCnyPerMillion, recoveredUsage[0].ratesCnyPerMillion);
  assert.deepEqual(recoveredAudits[0].entry.usage.costsCny, recoveredUsage[0].costsCny);
  assert.equal(recoveredAudits.at(-1).entry.type, "ai.usage_recovered");
  assert.deepEqual(
    usageEntryFromAudit(recoveredAudits[0].entry),
    recoveredUsage[0]
  );

  const providerUsage = [], providerAudits = [], providerEvents = [];
  const providerAudit = createAiAudit({
    textLimit: 100,
    getContext: () => ({ user: { id: "provider-account" }, traceId: "provider-trace", secrets: [] }),
    now,
    append: async (_day, entry) => providerAudits.push(entry),
    updateUsage: async mutate => mutate({ entries: providerUsage }),
    logEvent: async (...args) => providerEvents.push(args),
    createId: () => "provider-call"
  });
  let retainedProviderUsage = null, committedProviderUsage = 0;
  const providerResult = await providerAudit.providerCall({
    provider: "volcengine",
    service: "vision",
    scene: "visionOcr",
    action: "OCRNormal",
    request: { imageBytes: 1024 },
    modality: "vision",
    imageCount: 1,
    imageBytes: 1024,
    imageTypes: ["image/png"],
    imageDimensions: [{ width: 32, height: 24 }],
    unitType: "image",
    units: 1,
    costSource: "billing pending",
    reservation: {
      retain(entry) { retainedProviderUsage = entry; },
      commit() { committedProviderUsage += 1; }
    }
  }, async () => ({ requestId: "provider-request", text: "private OCR text" }));
  assert.equal(providerResult.requestId, "provider-request");
  assert.equal(providerUsage.length, 1);
  assert.equal(providerUsage[0].scene, "visionOcr");
  assert.equal(providerUsage[0].modality, "vision");
  assert.equal(providerUsage[0].imageCount, 1);
  assert.equal(providerUsage[0].imageBytes, 1024);
  assert.deepEqual(providerUsage[0].imageTypes, ["image/png"]);
  assert.deepEqual(providerUsage[0].imageDimensions, [{ width: 32, height: 24 }]);
  assert.equal(providerUsage[0].unitType, "call");
  assert.equal(providerUsage[0].usageKnown, true);
  assert.equal(providerUsage[0].costKnown, true);
  assert.equal(providerUsage[0].costCny, 0.005);
  assert.equal(retainedProviderUsage.callId, "provider-call");
  assert.equal(committedProviderUsage, 1);
  assert.equal(providerAudits.length, 2);
  assert.doesNotMatch(JSON.stringify(providerAudits), /private OCR text/);
  assert.ok(providerEvents.some(([, name]) => name === "dependency.completed"));
  const documentUsage = [];
  const documentAudit = createAiAudit({
    textLimit: 100,
    getContext: () => ({ user: { id: "document-account" }, traceId: "document-trace", secrets: [] }),
    now,
    append: async () => {},
    updateUsage: async mutate => mutate({ entries: documentUsage }),
    logEvent: async () => {},
    createId: () => "document-call"
  });
  await documentAudit.providerCall({
    provider: "volcengine",
    service: "vision",
    scene: "documentParsing",
    action: "OCRPdf",
    unitType: "page",
    units: 16
  }, async () => ({
    requestId: "document-request",
    detail: [{ page_id: 0 }, { page_id: 1 }, { page_id: 2 }]
  }), result => ({
    providerRequestId: result.requestId,
    unitType: "page",
    units: result.detail.length
  }));
  assert.equal(documentUsage[0].unitType, "page");
  assert.equal(documentUsage[0].units, 3);
  assert.equal(documentUsage[0].costKnown, true);
  assert.equal(documentUsage[0].costCny, 0.06);
  const failedProviderUsage = [], failedProviderEvents = [];
  const failedProviderAudit = createAiAudit({
    textLimit: 100,
    getContext: () => ({ user: { id: "provider-account" }, traceId: "provider-trace", secrets: [] }),
    now,
    append: async () => {},
    updateUsage: async mutate => mutate({ entries: failedProviderUsage }),
    logEvent: async (...args) => failedProviderEvents.push(args),
    createId: () => "provider-failed-call"
  });
  await assert.rejects(failedProviderAudit.providerCall({
    provider: "volcengine",
    service: "speech",
    scene: "speechRecognition",
    action: "streamingAsr"
  }, async () => {
    throw Object.assign(new Error("public message"), {
      code: "ASR_UNSUPPORTED_AUDIO_FORMAT",
      providerCode: "45000151",
      providerRequestId: "provider-error-request",
      statusCode: 422
    });
  }), { code: "ASR_UNSUPPORTED_AUDIO_FORMAT" });
  assert.equal(failedProviderUsage[0].providerRequestId, "provider-error-request");
  assert.equal(failedProviderUsage[0].usageKnown, true);
  assert.equal(failedProviderUsage[0].costKnown, false);
  assert.match(failedProviderUsage[0].costSource, /invoice verification/);
  const failedDependency = failedProviderEvents.find(([, name]) => name === "dependency.completed")?.[2];
  assert.equal(failedDependency.providerRequestId, "provider-error-request");
  assert.equal(failedDependency.providerErrorCode, "45000151");
  console.log("AI domain checks passed: settings, cost replacement/account isolation, local dates, unknown-usage aggregation, pre-commit normalization failure, backups, rollback/recovery, price snapshots, quotas and independent audit failures.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
