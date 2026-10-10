import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { healthImageFixtures } from "./fixtures/health-images.mjs";
import { normalizeHealthImage, describeHealthDetails } from "../src/modules/health/index.mjs";
import { LLM_SCENARIOS, LLM_SETTINGS_VERSION } from "../src/modules/ai/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const modelRequests = [];
let nextHealthReply = null;
const mockSegmentCutout = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR2nWQAAAABJRU5ErkJggg==";

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function mockDeepSeek() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.doesNotMatch(JSON.stringify(input.messages), /DO_NOT_LEAK_REASONING/);
    modelRequests.push(input);
    const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 300 } };
    if (!input.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      const messages = JSON.stringify(input.messages);
      if (messages.includes("版本竞态问题")) await sleep(250);
      const healthKind = messages.includes("转录这张体重/体成分报告") ? "weight" : messages.includes("转录这张运动详情截图") ? "exercise" : "";
      if (healthKind) {
        const content = nextHealthReply ?? JSON.stringify(healthImageFixtures[healthKind]);
        nextHealthReply = null;
        return res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
      }
      if (messages.includes("同一次睡眠记录")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ date: "2026-09-27", bedtime: "2026-09-27T02:58:00", wakeTime: "2026-09-27T10:40:00", totalMinutes: 462, deepMinutes: 134, deepPercent: 29, lightMinutes: 221, lightPercent: 48, remMinutes: 107, remPercent: 23, awakeCount: null, awakeMinutes: null, averageHeartRate: 49, averageOxygen: 98, respiratoryRate: 15, verification: "两张图已合并" }) } }], usage }));
      if (messages.includes("心率日视图")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ date: "2026-09-26", minimum: 46, maximum: 82, average: 60, resting: 52, sleepAverage: 50, trendAnalysis: "凌晨下降，午后与晚间出现两次抬升，夜间回落。", trendSegments: [{ period: "00:00-06:00", direction: "下降", approximateRange: "约46-64" }], verification: "今日概览可直接核对" }) } }], usage }));
      if (messages.includes("书籍截图")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "测试书", author: "测试作者", verification: "图片已识别" }) } }], usage }));
      if (input.response_format?.type === "json_object" && messages.includes("citationId")) {
        return res.end(JSON.stringify({ choices: [{ message: {
          content: JSON.stringify({ answer: "同步回答", citations: [] }),
          reasoning_content: "同步模型思考"
        } }], usage }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: "同步回答", reasoning_content: "同步模型思考" } }], usage }));
    }
    assert.equal(input.stream, true);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const serializedMessages = JSON.stringify(input.messages);
    const isDiaryAssist = serializedMessages.includes("<current_draft priority");
    const isDiaryTopic = serializedMessages.includes("只输出一个主题句和一个问句");
    const isVerifiedAnswer = input.response_format?.type === "json_object"
      && serializedMessages.includes("citationId");
    if (isDiaryTopic && input.thinking?.type === "enabled") {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考已经耗尽首轮输出预算。" }, finish_reason: "length" }], usage })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    const contentDeltas = isDiaryAssist
      ? ["第一行写作锚点。", "\n第二行写作锚点。"]
      : isVerifiedAnswer
        ? ['{"answer":"流式回答', '已完成。","citations":[]}']
        : ["**结论**：", "流式回答已完成。"];
    const events = [
      { choices: [{ delta: { reasoning_content: "先核对问题。" } }] },
      { choices: [{ delta: { reasoning_content: "再形成判断。" } }] },
      ...contentDeltas.map(content => ({ choices: [{ delta: { content } }] }))
    ];
    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      await sleep(60);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`应用服务提前退出，退出码 ${child.exitCode}\n${appError.trim()}`);
    try {
      const response = await fetch(`${url}/api/state`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(50);
  }
  throw new Error(`等待应用服务启动超时\n${appError.trim()}`);
}

async function readEvents(response) {
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.match(/\r?\n\r?\n/);
    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim();
      if (data) events.push(JSON.parse(data));
      boundary = buffer.match(/\r?\n\r?\n/);
    }
  }
  return events;
}

async function waitForTask(base, taskId, attempts = 80) {
  let task;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    task = await (await fetch(`${base}/api/ai-tasks/${taskId}`)).json();
    if (!["queued", "running"].includes(task.status)) return task;
    await sleep(25);
  }
  throw new Error(`后台任务 ${taskId} 未在限定时间内结束，最后状态为 ${task?.status}`);
}

async function waitForBackgroundIdle(base, attempts = 120) {
  let activeTasks = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${base}/api/ai-tasks`);
    const value = await response.json();
    activeTasks = (value.items || []).filter(task => (
      ["queued", "running", "waiting_for_user_model"].includes(task.status)
    ));
    if (activeTasks.length === 0) return;
    await sleep(25);
  }
  throw new Error(`后台任务未收敛：${JSON.stringify(activeTasks)}`);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-regression-"));
const mock = mockDeepSeek();
const mockPort = await freePort(), appPort = await freePort();
await new Promise((resolve, reject) => mock.once("error", reject).listen(mockPort, "127.0.0.1", resolve));
await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify({
  version: 3,
  checkins: [{ id: "checkin-1", createdAt: "2026-09-26T16:56:18.237Z", occurredOn: "2026-09-26", mood: 3, energy: 3, stress: 3, sleep: 3, factors: ["冷启动因素"] }],
  thoughts: [
    { id: "question-1", createdAt: "2026-09-26T16:56:18.237Z", occurredOn: "2026-09-26", type: "question", content: "测试后台生成", tags: [], relatedTo: null },
    { id: "markdown-question", createdAt: "2026-09-26T15:30:00.000Z", occurredOn: "2026-09-26", type: "question", content: "历史**问题**", tags: [], relatedTo: null },
    { id: "context-answer", createdAt: "2026-09-26T15:01:00.000Z", occurredOn: "2026-09-26", type: "answer", content: "前段**加粗内容**后段", reasoningContent: "DO_NOT_LEAK_REASONING", tags: [], relatedTo: "context-question" },
    { id: "context-question", createdAt: "2026-09-26T15:00:00.000Z", occurredOn: "2026-09-26", type: "question", content: "历史问题", tags: [], relatedTo: null }
  ],
  chats: [], books: [{ id: "legacy-book", createdAt: "2026-09-26T15:00:00.000Z", title: "旧书", notes: [{ id: "legacy-note", createdAt: "2026-09-26T15:10:11.000Z", content: "旧笔记" }] }], quotes: [], experiments: [], analyses: [], customMetrics: [],
  aiTasks: [{ id: "interrupted-task", kind: "thoughtAnswer", targetId: "question-1", inputVersion: 1, clientRequestId: "interrupted-request", requestHash: "legacy", status: "running", createdAt: "2026-09-26T17:00:00.000Z", startedAt: "2026-09-26T17:00:01.000Z" }],
  notifications: [],
  commercialization: {
    version: 2,
    assumptions: {
      subscription: { payingUsers: 20, simulationMonths: 6, monthlyPriceCny: 39, activeDaysPerMonth: 31, aiCallsPerActiveDay: 99, imageCallsPerUserMonth: 77 },
      delivery: { ordersPerMonth: 4, pricePerOrderCny: 299, aiCallsPerOrder: 999, imageCallsPerOrder: 88 }
    }
  }
}, null, 2)}\n`);
await fs.writeFile(path.join(dataDir, "llm-settings.json"), `${JSON.stringify({
  version: 2,
  provider: "deepseek",
  profiles: {
    lite: { model: "deepseek-flash", effort: "none" },
    mid: { model: "deepseek-flash", effort: "high" },
    high: { model: "deepseek-v4-pro", effort: "high" },
    ultra: { model: "deepseek-v4-pro", effort: "max" }
  },
  scenarios: Object.fromEntries(["thoughtDraft", "thoughtAnswer", "followUpAnswer", "chat", "diaryLead", "diaryStructure", "diaryTopic", "diaryReflection", "annotationShenji", "analysis", "bookRecognition"].map(scene => [scene, "ultra"])),
  automaticAnswers: { thoughtAnswer: true },
  apiKey: "test-key"
}, null, 2)}\n`);

let appError = "";
const startApp = () => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test", TEST_CURRENT_DATE: "2026-10-02", TZ: "Asia/Shanghai", PORT: String(appPort), DATA_DIR: dataDir, DEEPSEEK_API_URL: `http://127.0.0.1:${mockPort}/chat/completions`, KEEPSAKE_SEGMENT_MOCK_RESULT: mockSegmentCutout, PERIODIC_ANALYSIS_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => { appError += chunk; });
  return child;
};
let app = startApp();

try {
  const base = `http://127.0.0.1:${appPort}`;
  const addHighlight = (type, id, targetKey, quote, start = 0) => fetch(`${base}/api/annotations/${type}/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey, start, end: start + quote.length, quote, text: "" })
  });
  const migratedState = await waitForServer(base, app);
  const migratedCommercializationResponse = await fetch(`${base}/api/owner/surfaces/commercialization`);
  assert.equal(migratedCommercializationResponse.status, 200);
  const migratedCommercializationSurface = await migratedCommercializationResponse.json();
  assert.equal(migratedCommercializationSurface.report.version, 3);
  const migrated = {
    ...migratedState,
    commercialization: JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).commercialization
  };
  assert.equal(migrated.version, 18);
  assert.equal(migrated.commercialization.version, 3);
  assert.equal(migrated.commercialization.assumptions.validation.participants, 5);
  assert.equal(migrated.commercialization.assumptions.validation.rewardPerParticipantCny, 100);
  assert.equal(migrated.commercialization.assumptions.subscription.monthlyPriceCny, 39);
  assert.equal(migrated.commercialization.assumptions.subscription.simulationMonths, 6);
  assert.equal(migrated.commercialization.assumptions.delivery.ordersPerMonth, 4);
  assert.equal(migrated.commercialization.assumptions.delivery.serviceFeePerOrderCny, 299);
  assert.equal(migrated.commercialization.assumptions.usagePack.buyersPerMonth, 10);
  assert.deepEqual(migrated.commercialization.assumptions.stageByModel, { validation: 0, subscription: 0, delivery: 0, usagePack: 0 });
  assert.deepEqual(Object.keys(migrated.commercialization.assumptions.usageProfiles), ["low", "medium", "high", "full"]);
  assert.equal(migrated.commercialization.assumptions.usageProfiles.low.activeDaysPerMonth, 31);
  assert.equal(migrated.commercialization.assumptions.usageProfiles.medium.foregroundAiCallsPerActiveDay, 99);
  assert.equal(migrated.commercialization.assumptions.usageProfiles.full.backgroundAiCallsPerActiveDay, 0);
  assert.equal(migrated.commercialization.assumptions.usageProfiles.high.imageCallsPerMonth, 77);
  assert.deepEqual(migrated.commercialization.legacyV2, {
    migratedFromVersion: 2,
    subscription: { activeDaysPerMonth: 31, aiCallsPerActiveDay: 99, imageCallsPerUserMonth: 77 },
    delivery: { aiCallsPerOrder: 999, imageCallsPerOrder: 88 }
  });
  assert.equal(migrated.commercialization.assumptions.stagePresets.subscription.length, 5);
  assert.deepEqual(migrated.dailyRecords, []);
  assert.deepEqual(migrated.captures, []);
  assert.deepEqual(migrated.journals, []);
  assert.deepEqual(migrated.keepsakes, []);
  assert.equal(migrated.journalDraft, null);
  assert.equal(migrated.onboarding.status, "completed");
  assert.equal(migrated.onboardingV2.schemaVersion, 2);
  assert.equal(migrated.onboardingV2.session.status, "skipped");
  assert.equal(migrated.onboardingV2.migration.selectedFlow, "legacy");
  assert.equal(migrated.onboardingV2.migration.entryPolicy, "already_onboarded");
  assert.equal(migrated.onboardingV2.readiness, "empty");
  assert.equal(migrated.aiTasks.find(item => item.id === "interrupted-task").status, "failed");
  assert.match(migrated.aiTasks.find(item => item.id === "interrupted-task").error, /避免重复计费/);
  assert.equal(modelRequests.length, 0);
  assert.equal(Object.hasOwn(migrated, "bookDraft"), false);
  assert.equal(migrated.checkins[0].occurredOn, "2026-09-27");
  assert.equal(migrated.checkins[0].occurredAt, "2026-09-26T16:56:18.237Z");
  assert.equal(migrated.thoughts[0].occurredOn, "2026-09-27");
  assert.equal(migrated.thoughts[0].occurredAt, "2026-09-26T16:56:18.237Z");
  assert.equal(migrated.books[0].notes[0].type, "record");
  assert.equal(migrated.books[0].notes[0].favorite, "none");
  assert.equal(migrated.books[0].notes[0].occurredOn, "2026-09-26");
  assert.equal(migrated.books[0].readingStartedOn, "");
  assert.equal(migrated.books[0].readingFinishedOn, "");
  assert.deepEqual({
    activeDays7: migrated.insights.weekly.activeDays7,
    pairedDays30: migrated.insights.weekly.pairedDays30,
    rootCount30: migrated.insights.weekly.rootCount30,
    tracedRoots30: migrated.insights.weekly.tracedRoots30,
    traceRate30: migrated.insights.weekly.traceRate30,
    correctionActions30: migrated.insights.weekly.correctionActions30,
    reviewAgeDays: migrated.insights.weekly.reviewAgeDays,
    analysisCount: migrated.insights.weekly.analysisCount
  }, {
    activeDays7: 2,
    pairedDays30: 0,
    rootCount30: 3,
    tracedRoots30: 1,
    traceRate30: 33,
    correctionActions30: 0,
    reviewAgeDays: null,
    analysisCount: 0
  });
  assert.deepEqual(migrated.insights.aiOnlyThoughtIds, []);
  assert.deepEqual(migrated.insights.trends.map(item => [item.metric, item.currentCount, item.previousCount]), [
    ["mood", 1, 0], ["energy", 1, 0], ["stress", 1, 0], ["sleep", 1, 0]
  ]);
  assert.deepEqual(migrated.insights.associations.map(item => [item.factor, item.withCount, item.confidence]), [["冷启动因素", 1, "单日观察"]]);
  assert.equal((await fs.readdir(dataDir)).some(name => name.includes("v3-pre-v18") && name.endsWith(".bak")), true);
  const migratedSettings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(migratedSettings.version, LLM_SETTINGS_VERSION);
  assert.deepEqual(Object.keys(migratedSettings.profiles), ["lite", "mid", "high", "ultra"]);
  assert.deepEqual(migratedSettings.scenarios, {
    thoughtPrompt: "lite", thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high",
    diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra",
    annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid",
    contentImageUnderstanding: "mid", capturePolish: "mid", onboardingClaimExtraction: "mid",
    perceptionExtraction: "lite", recordCompression: "lite"
  });
  assert.equal(migratedSettings.sceneEfforts.thoughtAnswer, "max");
  assert.equal(migratedSettings.sceneEfforts.diaryLead, "none");
  assert.equal(migratedSettings.assistantName, "神鸡");
  assert.equal(migratedSettings.responseStyles.thoughtAnswer, "standard");
  assert.deepEqual(migratedSettings.speech, {
    defaultVoice: "zh_male_shaonianzixin_uranus_bigtts",
    generationRate: -10
  });
  const storedSettings = JSON.parse(await fs.readFile(path.join(dataDir, "llm-settings.json"), "utf8"));
  assert.equal(storedSettings.version, LLM_SETTINGS_VERSION);
  assert.equal(storedSettings.apiKey, "test-key");
  assert.equal((await fs.readdir(dataDir)).some(name => name.includes(`v2-pre-v${LLM_SETTINGS_VERSION}`) && name.endsWith(".bak")), true);
  const initialStatistics = await (await fetch(`${base}/api/statistics`)).json();
  assert.equal(initialStatistics.ai.summary.calls, 0);
  assert.equal(initialStatistics.ai.daily.length, 7);
  assert.equal(initialStatistics.records.content.find(item => item.key === "thoughts").count, 3);
  assert.equal(initialStatistics.records.content.find(item => item.key === "bookNotes").count, 1);
  assert.equal(initialStatistics.records.interactions.find(item => item.key === "shenji").count, 0);
  assert.deepEqual(initialStatistics.records.groups.map(item => item.label), ["今日", "所见", "所思", "互动"]);
  assert.deepEqual(
    initialStatistics.records.groups.find(item => item.key === "today").modules.find(item => item.key === "daily").items.map(item => item.label),
    ["睡眠", "心率", "体重", "运动"]
  );
  assert.equal(initialStatistics.ai.pricing.displayCurrency, "CNY");
  assert.equal(initialStatistics.ai.pricing.cnyPerUsd, 7.2);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"), "utf8")).version, 5);
  const initialAiCostPlan = await (await fetch(`${base}/api/ai-cost-plan`)).json();
  assert.equal(initialAiCostPlan.version, 1);
  assert.equal(initialAiCostPlan.scenarios.length, LLM_SCENARIOS.length);
  assert.equal(initialAiCostPlan.scenarios.find(item => item.scene === "thoughtAnswer").model, "deepseek-v4-pro");
  const savedAiCostPlan = await (await fetch(`${base}/api/ai-cost-plan`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      monthlyBudgetCny: 66,
      contingencyPct: 900,
      cnyPerUsd: 7.1,
      scenarios: [{ scene: "thoughtPrompt", enabled: false, model: "invalid", pricingPeriod: "offPeak", callsPerMonth: 12, avgInputTokens: 8888, cacheHitPct: 120, avgReasoningTokens: 10, avgAnswerTokens: 20 }]
    })
  })).json();
  assert.equal(savedAiCostPlan.monthlyBudgetCny, 66);
  assert.equal(savedAiCostPlan.contingencyPct, 500);
  assert.equal(savedAiCostPlan.cnyPerUsd, 7.1);
  assert.equal(savedAiCostPlan.scenarios.length, LLM_SCENARIOS.length);
  assert.deepEqual(savedAiCostPlan.scenarios.find(item => item.scene === "thoughtPrompt"), { scene: "thoughtPrompt", enabled: false, model: "deepseek-flash", pricingPeriod: "offPeak", callsPerMonth: 12, avgInputTokens: 8888, cacheHitPct: 100, avgReasoningTokens: 10, avgAnswerTokens: 20 });
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "ai-cost-plan.json"), "utf8")).monthlyBudgetCny, 66);
  const onboardingSchema = await (await fetch(`${base}/api/onboarding/schema`)).json();
  assert.equal(onboardingSchema.version, 1);
  assert.equal(onboardingSchema.modes.find(item => item.id === "quick").questionCount, 8);
  assert.equal(onboardingSchema.modes.find(item => item.id === "detailed").questionCount, 18);
  const incompleteOnboarding = await fetch(`${base}/api/onboarding`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "completed", questionnaireMode: "quick", answers: {}, profile: {}, interests: [] })
  });
  assert.equal(incompleteOnboarding.status, 400);
  assert.equal((await incompleteOnboarding.json()).code, "ONBOARDING_ANSWERS_REQUIRED");
  const quickAnswers = Object.fromEntries(onboardingSchema.questions.filter(item => item.tier === "quick").map(item => [item.id, item.options[0].value]));
  const incompleteDetailed = await fetch(`${base}/api/onboarding/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionnaireMode: "detailed", answers: quickAnswers, profile: {}, interests: [] })
  });
  assert.equal(incompleteDetailed.status, 400);
  assert.equal((await incompleteDetailed.json()).missing.length, 10);
  const dismissedOnboarding = await fetch(`${base}/api/onboarding`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "dismissed" })
  });
  assert.equal(dismissedOnboarding.status, 400);
  const onboardingPreview = await (await fetch(`${base}/api/onboarding/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionnaireMode: "quick", answers: quickAnswers, profile: {}, interests: [] })
  })).json();
  assert.match(onboardingPreview.understanding, /快速版/);
  assert.match(onboardingPreview.understanding, /不是人格定论/);
  const onboarding = await (await fetch(`${base}/api/onboarding`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "completed", questionnaireMode: "quick", answers: quickAnswers, profile: { occupation: "测试职业" }, interests: ["学习成长"], material: "ONBOARDING_PRIVATE_MATERIAL", understanding: onboardingPreview.understanding })
  })).json();
  assert.equal(onboarding.status, "completed");
  assert.equal(Object.keys(onboarding.answers).length, 8);
  assert.equal(onboarding.profile.occupation, "测试职业");
  assert.deepEqual(onboarding.interests, ["学习成长"]);
  const stateAfterLegacyOnboarding = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterLegacyOnboarding.onboarding.material, "ONBOARDING_PRIVATE_MATERIAL");
  assert.equal(stateAfterLegacyOnboarding.onboardingV2.migration.selectedFlow, "legacy");

  const onboardingV2Schema = await (await fetch(`${base}/api/v1/onboarding-v2/schema`)).json();
  const onboardingV2SessionResponse = await fetch(`${base}/api/v1/onboarding-v2/session`);
  const onboardingV2Session = await onboardingV2SessionResponse.json();
  const declinedAnswers = Object.fromEntries(onboardingV2Schema.data.questions
    .filter(question => question.questionId !== "collaboration")
    .map(question => [question.questionId, { answerDisposition: "declined", contextAllowed: false }]));
  const completedV2Response = await fetch(`${base}/api/v1/onboarding-v2/session`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "if-match": onboardingV2SessionResponse.headers.get("etag"),
      "idempotency-key": "regression-v2-onboarding-ready"
    },
    body: JSON.stringify({
      selectedFlow: "v2",
      status: "completed",
      answers: declinedAnswers,
      collaboration: { answerDisposition: "declined", contextAllowed: false }
    })
  });
  assert.equal(completedV2Response.status, 200, await completedV2Response.clone().text());
  const completedV2 = await completedV2Response.json();
  const readyExtractionResponse = await fetch(`${base}/api/v1/onboarding-v2/extractions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "regression-v2-extraction-ready" },
    body: JSON.stringify({ sourceRevision: completedV2.data.session.revision })
  });
  assert.equal(readyExtractionResponse.status, 200, await readyExtractionResponse.clone().text());
  assert.equal((await readyExtractionResponse.json()).data.status, "ready");

  const commercializationResponse = await fetch(`${base}/api/commercialization`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assumptions: {
        validation: { participants: 7, rewardPerParticipantCny: 149, developmentHoursTotal: 16 },
        subscription: { monthlyPriceCny: 49, paymentFeePct: 140, simulationMonths: 18, developmentHoursPerMonth: 24 },
        delivery: { ordersPerMonth: 6, serviceFeePerOrderCny: 399, byokPct: 65, maintenanceMarkupPct: 25 },
        usagePack: { buyersPerMonth: 12, pricePerPackCny: 35 },
        usageProfiles: { high: { sharePct: 25, backgroundAiCallsPerActiveDay: 3 } },
        common: { usdCny: 7.1, aiCostFloorPerCallCny: 0.04 }
      }
    })
  });
  assert.equal(commercializationResponse.status, 200);
  const savedCommercialization = await commercializationResponse.json();
  assert.equal(savedCommercialization.assumptions.validation.participants, 7);
  assert.equal(savedCommercialization.assumptions.validation.rewardPerParticipantCny, 149);
  assert.equal(savedCommercialization.assumptions.validation.developmentHoursTotal, 16);
  assert.equal(savedCommercialization.assumptions.subscription.monthlyPriceCny, 49);
  assert.equal(savedCommercialization.assumptions.subscription.paymentFeePct, 100);
  assert.equal(savedCommercialization.assumptions.subscription.simulationMonths, 18);
  assert.equal(savedCommercialization.assumptions.subscription.developmentHoursPerMonth, 24);
  assert.equal(savedCommercialization.assumptions.delivery.ordersPerMonth, 6);
  assert.equal(savedCommercialization.assumptions.delivery.serviceFeePerOrderCny, 399);
  assert.equal(savedCommercialization.assumptions.delivery.byokPct, 65);
  assert.equal(savedCommercialization.assumptions.delivery.maintenanceMarkupPct, 25);
  assert.equal(savedCommercialization.assumptions.usagePack.pricePerPackCny, 35);
  assert.equal(savedCommercialization.assumptions.usageProfiles.high.sharePct, 25);
  assert.equal(savedCommercialization.assumptions.usageProfiles.high.backgroundAiCallsPerActiveDay, 3);
  assert.equal(savedCommercialization.assumptions.common.usdCny, 7.1);
  assert.deepEqual(savedCommercialization.legacyV2, migrated.commercialization.legacyV2);
  assert.ok(savedCommercialization.updatedAt);
  const persistedCommercialization = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).commercialization;
  assert.deepEqual(persistedCommercialization, savedCommercialization);
  const stagedAssumptions = structuredClone(savedCommercialization.assumptions);
  stagedAssumptions.stageByModel.subscription = 2;
  stagedAssumptions.subscription = { ...stagedAssumptions.stagePresets.subscription[2], monthlyPriceCny: 69 };
  const stagedCommercialization = await (await fetch(`${base}/api/commercialization`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assumptions: stagedAssumptions })
  })).json();
  assert.equal(stagedCommercialization.assumptions.stageByModel.subscription, 2);
  assert.equal(stagedCommercialization.assumptions.subscription.dailyActiveUsers, 10000);
  assert.equal(stagedCommercialization.assumptions.subscription.monthlyPriceCny, 69);
  assert.equal(stagedCommercialization.assumptions.stagePresets.subscription[0].monthlyPriceCny, 49);
  assert.equal(stagedCommercialization.assumptions.stagePresets.subscription[2].monthlyPriceCny, 69);

  const profileSettings = {
    profiles: {
      lite: { model: "deepseek-flash", effort: "none" },
      mid: { model: "deepseek-flash", effort: "high" },
      high: { model: "deepseek-v4-pro", effort: "high" },
      ultra: { model: "deepseek-v4-pro", effort: "max" }
    },
    scenarios: {
      thoughtPrompt: "lite", thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high",
      diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra",
      annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid"
    },
    assistantName: "照见",
    responseStyles: { thoughtDraft: "deep", thoughtAnswer: "structured", followUpAnswer: "concise", chat: "exploratory", diaryReflection: "standard", annotationShenji: "structured", analysis: "deep" },
    apiKey: ""
  };
  const savedSettings = await (await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profileSettings)
  })).json();
  assert.equal(savedSettings.scenarios.diaryTopic, "high");
  assert.equal(savedSettings.assistantName, "照见");
  assert.equal(savedSettings.responseStyles.thoughtAnswer, "structured");
  assert.equal(savedSettings.hasApiKey, true);

  const originalCheckinCreatedAt = migrated.checkins[0].createdAt;
  const checkinEditResponse = await fetch(`${base}/api/checkins/checkin-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T09:08:07", mood: 4, energy: 2, stress: 5, sleep: 3, factors: ["补记因素", "散步"], custom: {}, notes: { mood: "实际比刚才轻松" } })
  });
  assert.equal(checkinEditResponse.status, 200);
  const editedCheckin = await checkinEditResponse.json();
  assert.equal(editedCheckin.createdAt, originalCheckinCreatedAt);
  assert.equal(editedCheckin.occurredAt, "2026-09-27T01:08:07.000Z");
  assert.equal(editedCheckin.occurredOn, "2026-09-27");
  assert.deepEqual(editedCheckin.factors, ["补记因素", "散步"]);
  assert.equal(editedCheckin.notes.mood, "实际比刚才轻松");

  const journalAssistMarkers = { lead: "🗃", structure: "🏷", topic: "💬" };
  for (const mode of ["lead", "structure", "topic"]) {
    const response = await fetch(`${base}/api/journals/assist`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ mode, occurredAt: "2026-09-27T08:00:00", title: "今天", content: "我已经写下的文字。" })
    });
    const assistEvents = await readEvents(response);
    assert.equal(assistEvents.at(-1).result.mode, mode);
    assert.equal(assistEvents.at(-1).result.content, `${journalAssistMarkers[mode]} 第一行写作锚点。\n${journalAssistMarkers[mode]} 第二行写作锚点。`);
    assert.equal(assistEvents.at(-1).result.content.split("\n").every(line => line.startsWith(`${journalAssistMarkers[mode]} `)), true);
  }
  const assistRequests = modelRequests.slice(-4);
  assert.deepEqual(assistRequests.map(item => [item.model, item.reasoning_effort]), [
    ["deepseek-flash", "none"],
    ["deepseek-flash", "high"],
    ["deepseek-v4-pro", "high"],
    ["deepseek-v4-pro", "none"]
  ]);
  assert.equal(assistRequests[2].max_tokens, 2000);
  assert.equal(assistRequests[3].thinking.type, "disabled");
  assert.equal(assistRequests.every(item => item.stream_options?.include_usage === true), true);
  for (const request of assistRequests) assert.match(JSON.stringify(request.messages), /我已经写下的文字/);
  const usageAfterAssist = (await (await fetch(`${base}/api/statistics`)).json()).ai;
  assert.equal(usageAfterAssist.summary.calls, 4);
  assert.equal(usageAfterAssist.summary.successfulCalls, 3);
  assert.equal(usageAfterAssist.summary.failedCalls, 1);
  assert.deepEqual(usageAfterAssist.summary.tokens, { input: 4000, cacheHit: 800, cacheMiss: 3200, reasoning: 1200, answer: 800, output: 2000 });
  assert.deepEqual(usageAfterAssist.models.map(item => [item.model, item.calls]), [["deepseek-flash", 2], ["deepseek-v4-pro", 2]]);
  assert.equal(usageAfterAssist.summary.costsUsd.total, 0);
  assert.ok(usageAfterAssist.summary.costCny > 0);

  const thoughtPromptResponse = await fetch(`${base}/api/thought-prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T20:00:00" })
  });
  assert.equal(thoughtPromptResponse.status, 200);
  const thoughtPromptResult = await thoughtPromptResponse.json();
  assert.deepEqual(
    { prompt: thoughtPromptResult.prompt, hasHistory: thoughtPromptResult.hasHistory },
    { prompt: "同步回答", hasHistory: true }
  );
  assert.equal(typeof thoughtPromptResult.requestId, "string");
  assert.ok(thoughtPromptResult.requestId);
  const thoughtPromptRequest = modelRequests.at(-1);
  assert.deepEqual([thoughtPromptRequest.model, thoughtPromptRequest.reasoning_effort, thoughtPromptRequest.max_tokens], ["deepseek-flash", "none", 400]);
  assert.match(thoughtPromptRequest.messages[0].content, /18～55/);
  assert.match(JSON.stringify(thoughtPromptRequest.messages), /曾经的问题|状态因素/);

  const questionAnnotationResponse = await fetch(`${base}/api/thoughts/markdown-question/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey: "question:markdown-question", start: 0, end: 4, quote: "历史问题", text: "" })
  });
  assert.equal(questionAnnotationResponse.status, 201);
  const questionAnnotation = await questionAnnotationResponse.json();
  const questionEditResponse = await fetch(`${base}/api/thought-chains/markdown-question`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "新增历史**问题**", idea: "", answer: "", tags: [] })
  });
  assert.equal(questionEditResponse.status, 200);
  const questionReanchored = await (await fetch(`${base}/api/state`)).json();
  const movedQuestionAnnotation = questionReanchored.thoughts.find(item => item.id === "markdown-question").annotations.find(item => item.id === questionAnnotation.id);
  assert.equal(movedQuestionAnnotation.start, 2);
  assert.equal(movedQuestionAnnotation.end, 6);

  const createdCapture = await (await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T08:09:10", content: "一个还没想完整的念头", tags: ["灵感", "待展开"] })
  })).json();
  assert.equal(createdCapture.content, "一个还没想完整的念头");
  assert.deepEqual(createdCapture.tags, ["灵感", "待展开"]);
  assert.equal(createdCapture.occurredAt, "2026-09-27T00:09:10.000Z");
  const captureAnnotation = await fetch(`${base}/api/annotations/capture/${createdCapture.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey: "content", start: 2, end: 7, quote: "还没想完整", text: "" })
  });
  assert.equal(captureAnnotation.status, 201);
  const captureCreatedAt = createdCapture.createdAt;
  const captureEdit = await fetch(`${base}/api/captures/${createdCapture.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-26T23:45:12", content: "补充后的碎片", tags: ["待展开", "夜间"] })
  });
  assert.equal(captureEdit.status, 200);
  const editedCapture = await captureEdit.json();
  assert.equal(editedCapture.occurredOn, "2026-09-26");
  assert.equal(editedCapture.occurredAt, "2026-09-26T15:45:12.000Z");
  assert.equal(editedCapture.createdAt, captureCreatedAt);
  const captureAfterEdit = (await (await fetch(`${base}/api/state`)).json()).captures.find(item => item.id === createdCapture.id);
  assert.equal(captureAfterEdit.annotations.length, 0);
  assert.equal(captureAfterEdit.annotationDrift.length, 1);

  const newJournalDraftResponse = await fetch(`${base}/api/journal-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ journalId: "", title: "尚未完成的标题", content: "跨端继续写的正文。", occurredAt: "2020-01-01T00:00:00", tags: ["不应保存"] })
  });
  assert.equal(newJournalDraftResponse.status, 200);
  const newJournalDraft = await newJournalDraftResponse.json();
  assert.deepEqual(Object.keys(newJournalDraft).sort(), ["content", "journalId", "title", "updatedAt"]);
  assert.equal(newJournalDraft.title, "尚未完成的标题");
  assert.equal((await (await fetch(`${base}/api/state`)).json()).journalDraft.content, "跨端继续写的正文。");

  const createdJournal = await (await fetch(`${base}/api/journals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T21:22:23", title: "测试日记", content: "今天发生了一件事，我还在分辨事实和解释。", tags: ["复盘"] })
  })).json();
  assert.equal(createdJournal.occurredAt, "2026-09-27T13:22:23.000Z");
  assert.equal((await (await fetch(`${base}/api/state`)).json()).journalDraft, null);
  const journalCreatedAt = createdJournal.createdAt;
  const editJournalDraft = await (await fetch(`${base}/api/journal-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ journalId: createdJournal.id, title: "测试日记（草稿）", content: "尚未正式保存的修改。" })
  })).json();
  assert.equal(editJournalDraft.journalId, createdJournal.id);
  const reflectionResponse = await fetch(`${base}/api/journals/${createdJournal.id}/reflect`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: "{}"
  });
  const reflectionEvents = await readEvents(reflectionResponse);
  assert.equal(reflectionEvents.at(-1).type, "done");
  assert.equal(reflectionEvents.at(-1).result.content, "**结论**：流式回答已完成。");
  assert.equal(reflectionEvents.at(-1).result.reasoningContent, "先核对问题。再形成判断。");
  const reflectionRequest = modelRequests.at(-1);
  assert.deepEqual([reflectionRequest.model, reflectionRequest.reasoning_effort], ["deepseek-v4-pro", "max"]);
  assert.match(reflectionRequest.messages[0].content, /350～700/);
  assert.match(reflectionRequest.messages[0].content, /必须给出自己的综合判断/);
  assert.equal((await addHighlight("journal", createdJournal.id, `reflection:${reflectionEvents.at(-1).result.id}`, "结论")).status, 201);
  const journalEdit = await fetch(`${base}/api/journals/${createdJournal.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T22:23:24", title: "测试日记（修改）", content: "修改后的原文。", tags: [] })
  });
  assert.equal(journalEdit.status, 200);
  const afterJournal = await (await fetch(`${base}/api/state`)).json();
  const persistedJournal = afterJournal.journals.find(item => item.id === createdJournal.id);
  assert.equal(afterJournal.journalDraft, null);
  assert.equal(persistedJournal.reflections.length, 1);
  assert.equal(persistedJournal.occurredAt, "2026-09-27T14:23:24.000Z");
  assert.equal(persistedJournal.createdAt, journalCreatedAt);
  assert.notEqual(persistedJournal.reflections[0].sourceUpdatedAt, persistedJournal.updatedAt);

  const annotationResponse = await fetch(`${base}/api/thoughts/context-question/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey: "answer:context-answer", start: 0, end: 8, quote: "前段加粗内容后段", text: "" })
  });
  assert.equal(annotationResponse.status, 201);
  const annotation = await annotationResponse.json();
  assert.equal(annotation.rawStart, 0);
  const editResponse = await fetch(`${base}/api/thought-chains/context-question`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-25T22:11:10", question: "历史问题", idea: "", answer: "新增前段**加粗内容**后段", tags: [] })
  });
  assert.equal(editResponse.status, 200);
  const reanchored = await (await fetch(`${base}/api/state`)).json();
  const editedQuestion = reanchored.thoughts.find(item => item.id === "context-question");
  const movedAnnotation = editedQuestion.annotations.find(item => item.id === annotation.id);
  assert.equal(editedQuestion.createdAt, "2026-09-26T15:00:00.000Z");
  assert.equal(editedQuestion.occurredAt, "2026-09-25T14:11:10.000Z");
  assert.equal(editedQuestion.occurredOn, "2026-09-25");
  assert.equal(movedAnnotation.start, 2);
  assert.equal(movedAnnotation.end, 10);

  const draftResponse = await fetch(`${base}/api/answer-drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ question: "测试流式顺序", idea: "", requestId: "draft-regression-1", targetId: "chain-form", inputVersion: 1 })
  });
  const events = await readEvents(draftResponse);
  const types = events.map(event => event.type);
  assert.ok(types.indexOf("reasoning") >= 0);
  assert.ok(types.indexOf("content") > types.lastIndexOf("reasoning"));
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.draft, "流式回答已完成。");
  assert.equal(events.at(-1).result.reasoningContent, "先核对问题。再形成判断。");
  assert.deepEqual([events.at(-1).result.requestId, events.at(-1).result.targetId, events.at(-1).result.inputVersion], ["draft-regression-1", "chain-form", 1]);
  const draftRequest = modelRequests.at(-1);
  assert.deepEqual([draftRequest.model, draftRequest.reasoning_effort], ["deepseek-v4-pro", "high"]);
  assert.match(draftRequest.messages[0].content, /250～450/);
  assert.match(draftRequest.messages[0].content, /哲学、价值、意义/);
  assert.match(draftRequest.messages[0].content, /禁止用“核心判断”/);
  assert.match(draftRequest.messages[0].content, /你的称呼是“照见”/);
  assert.match(draftRequest.messages[0].content, /深入分析关键前提/);
  assert.match(draftRequest.messages.at(-1).content, /不能因此回避给观点/);
  assert.doesNotMatch(draftRequest.messages.at(-1).content, /前段加粗内容后段/);
  assert.match(JSON.stringify(draftRequest.messages), /ONBOARDING_PRIVATE_MATERIAL/);
  assert.match(JSON.stringify(draftRequest.messages), /职业：测试职业/);
  assert.match(JSON.stringify(draftRequest.messages), /用户问卷原始选择/);

  const answerResponse = await fetch(`${base}/api/thoughts/question-1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ clientRequestId: "question-1-generation-1" })
  });
  const answerEvents = await readEvents(answerResponse);
  assert.equal(answerEvents.at(-1).type, "done");
  assert.equal(answerEvents.at(-1).result.content, "流式回答已完成。");
  assert.equal(answerEvents.at(-1).result.reasoningContent, "先核对问题。再形成判断。");
  const persisted = await (await fetch(`${base}/api/state`)).json();
  const answer = persisted.thoughts.find(item => item.relatedTo === "question-1" && item.type === "answer");
  assert.equal(answer?.content, "流式回答已完成。");
  assert.equal(answer?.reasoningContent, "先核对问题。再形成判断。");
  assert.equal(answer?.authorType, "ai");
  assert.equal(answer?.occurredOn, "2026-09-27");
  assert.equal(answer?.occurredAt, persisted.thoughts.find(item => item.id === "question-1").occurredAt);
  const answerStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  const answerSourceTask = answerStore.aiTasks.find(item => item.id === answer?.sourceTaskId);
  assert.equal(answerSourceTask?.internal, true);
  assert.equal(answerSourceTask?.status, "succeeded");
  assert.equal(answerSourceTask?.resultId, answer.id);
  assert.match(answerSourceTask?.contextFingerprint || "", /^[a-f0-9]{64}$/);
  assert.equal(persisted.aiTasks.some(item => item.id === answer.sourceTaskId), false);
  assert.equal((await fetch(`${base}/api/ai-tasks/${answer.sourceTaskId}`)).status, 404);
  const answerRequest = modelRequests.at(-1);
  assert.deepEqual([answerRequest.model, answerRequest.reasoning_effort], ["deepseek-v4-pro", "max"]);
  assert.match(answerRequest.messages[0].content, /禁止用“核心判断”/);
  assert.match(answerRequest.messages[0].content, /500～900/);
  assert.match(answerRequest.messages.at(-1).content, /哲学或抽象主题先补足/);
  assert.deepEqual(persisted.insights.aiOnlyThoughtIds, ["question-1"]);
  assert.equal(persisted.insights.weekly.tracedRoots30, 2);
  assert.equal(persisted.insights.weekly.traceRate30, 67);
  assert.equal((await addHighlight("thought", "question-1", "question:question-1", "测试")).status, 201);
  const tracedAfterHighlight = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(tracedAfterHighlight.insights.aiOnlyThoughtIds, []);
  assert.equal(tracedAfterHighlight.insights.weekly.tracedRoots30, 3);
  assert.equal(tracedAfterHighlight.insights.weekly.traceRate30, 100);
  const secondAnswerResponse = await fetch(`${base}/api/thoughts/question-1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ clientRequestId: "question-1-generation-2" })
  });
  const secondAnswerEvents = await readEvents(secondAnswerResponse);
  assert.equal(secondAnswerEvents.at(-1).type, "done");
  const afterSecondAnswer = await (await fetch(`${base}/api/state`)).json();
  const generatedAnswers = afterSecondAnswer.thoughts.filter(item => item.relatedTo === "question-1" && item.type === "answer");
  assert.equal(generatedAnswers.length, 2);
  assert.deepEqual(generatedAnswers.map(item => item.generation).sort(), [1, 2]);

  const concurrentQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T14:20:00", content: "并发幂等回答问题", tags: [] })
  })).json();
  const concurrentModelCount = modelRequests.length;
  const concurrentResponses = await Promise.all([0, 1].map(() => fetch(`${base}/api/thoughts/${concurrentQuestion.id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ clientRequestId: "concurrent-thought-answer" })
  })));
  const concurrentEvents = await Promise.all(concurrentResponses.map(readEvents));
  assert.equal(modelRequests.length - concurrentModelCount, 1);
  assert.equal(concurrentEvents[0].at(-1).type, "done");
  assert.equal(concurrentEvents[1].at(-1).type, "done");
  assert.equal(concurrentEvents[0].at(-1).result.id, concurrentEvents[1].at(-1).result.id);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.filter(item => item.relatedTo === concurrentQuestion.id && item.clientRequestId === "concurrent-thought-answer").length, 1);

  const concurrentFollowUp = await (await fetch(`${base}/api/thoughts/${concurrentQuestion.id}/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "concurrent-follow-up-create" },
    body: JSON.stringify({ question: "并发追问如何处理？", answer: "" })
  })).json();
  const replayedFollowUpResponse = await fetch(`${base}/api/thoughts/${concurrentQuestion.id}/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "concurrent-follow-up-create" },
    body: JSON.stringify({ question: "并发追问如何处理？", answer: "" })
  });
  assert.equal(replayedFollowUpResponse.status, 200);
  assert.equal((await replayedFollowUpResponse.json()).id, concurrentFollowUp.id);
  const conflictingFollowUpResponse = await fetch(`${base}/api/thoughts/${concurrentQuestion.id}/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "concurrent-follow-up-create" },
    body: JSON.stringify({ question: "同一个键不能改写追问", answer: "" })
  });
  assert.equal(conflictingFollowUpResponse.status, 409);
  assert.equal((await conflictingFollowUpResponse.json()).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.find(item => item.id === concurrentQuestion.id).followUps.length, 1);
  const concurrentFollowUpModelCount = modelRequests.length;
  const concurrentFollowUpResponses = await Promise.all([0, 1].map(() => fetch(`${base}/api/thoughts/${concurrentQuestion.id}/follow-ups/${concurrentFollowUp.id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "concurrent-follow-up-answer", inputVersion: concurrentQuestion.version + 1, subtargetVersion: concurrentFollowUp.version })
  })));
  assert.deepEqual(concurrentFollowUpResponses.map(response => response.status).sort(), [200, 202]);
  const concurrentFollowUpTasks = await Promise.all(concurrentFollowUpResponses.map(response => response.json()));
  assert.equal(concurrentFollowUpTasks[0].id, concurrentFollowUpTasks[1].id);
  const concurrentFollowUpResult = await waitForTask(base, concurrentFollowUpTasks[0].id);
  assert.equal(concurrentFollowUpResult.status, "succeeded", JSON.stringify(concurrentFollowUpResult));
  assert.equal(modelRequests.length - concurrentFollowUpModelCount, 1);
  const stateAfterConcurrentFollowUp = await (await fetch(`${base}/api/state`)).json();
  const savedConcurrentFollowUp = stateAfterConcurrentFollowUp.thoughts.find(item => item.id === concurrentQuestion.id).followUps.find(item => item.id === concurrentFollowUp.id);
  assert.equal(savedConcurrentFollowUp.sourceTaskId, concurrentFollowUpTasks[0].id);
  assert.equal(savedConcurrentFollowUp.answer, "同步回答");

  const staleFollowUpQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T14:25:00", content: "追问版本竞态问题", tags: [] })
  })).json();
  const staleFollowUp = await (await fetch(`${base}/api/thoughts/${staleFollowUpQuestion.id}/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "修改期间不应写入旧回答", answer: "" })
  })).json();
  const staleFollowUpTask = await (await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "followUpAnswer", targetId: staleFollowUpQuestion.id, subtargetId: staleFollowUp.id, inputVersion: 2, subtargetVersion: 1, clientRequestId: "stale-follow-up-task" })
  })).json();
  assert.equal((await fetch(`${base}/api/thoughts/${staleFollowUpQuestion.id}/follow-ups/${staleFollowUp.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, question: "修改期间必须拒绝写入旧回答" })
  })).status, 200);
  assert.equal((await waitForTask(base, staleFollowUpTask.id)).status, "stale");
  let staleFollowUpState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(staleFollowUpState.thoughts.find(item => item.id === staleFollowUpQuestion.id).followUps[0].answer, "");
  const retryModelCount = modelRequests.length;
  const retryResponses = await Promise.all([0, 1].map(() => fetch(`${base}/api/ai-tasks/${staleFollowUpTask.id}/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  })));
  assert.deepEqual(retryResponses.map(response => response.status).sort(), [200, 202]);
  const retriedTasks = await Promise.all(retryResponses.map(response => response.json()));
  assert.equal(retriedTasks[0].id, retriedTasks[1].id);
  const retriedFollowUp = retriedTasks[0];
  assert.equal((await waitForTask(base, retriedFollowUp.id)).status, "succeeded");
  assert.equal(modelRequests.length - retryModelCount, 1);
  staleFollowUpState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(staleFollowUpState.thoughts.find(item => item.id === staleFollowUpQuestion.id).followUps[0].sourceTaskId, retriedFollowUp.id);

  const dispositionQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T14:30:00", content: "回答期间改变保留状态", tags: [] })
  })).json();
  const dispositionResponse = await fetch(`${base}/api/thoughts/${dispositionQuestion.id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ clientRequestId: "disposition-stale-answer" })
  });
  assert.equal((await fetch(`${base}/api/thoughts/${dispositionQuestion.id}/disposition`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disposition: "discarded" })
  })).status, 200);
  const dispositionEvents = await readEvents(dispositionResponse);
  assert.equal(dispositionEvents.at(-1).type, "error");
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.some(item => item.relatedTo === dispositionQuestion.id && item.clientRequestId === "disposition-stale-answer"), false);

  const unsafeChainEdit = await fetch(`${base}/api/thought-chains/question-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "测试后台生成", answer: "不得合并", tags: [] })
  });
  assert.equal(unsafeChainEdit.status, 409);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.filter(item => item.relatedTo === "question-1" && item.type === "answer").length, 2);
  const manualRecord = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "record", relatedTo: "question-1", occurredAt: "2026-09-27T15:20:00", content: "一条独立记录", tags: ["验证"] })
  })).json();
  const editedRecord = await (await fetch(`${base}/api/thoughts/${manualRecord.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: manualRecord.version, occurredAt: "2026-09-27T15:21:00", content: "一条独立更新记录" })
  })).json();
  assert.equal(editedRecord.version, 2);
  const staleBlockEdit = await fetch(`${base}/api/thoughts/${manualRecord.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, content: "不应覆盖" })
  });
  assert.equal(staleBlockEdit.status, 409);
  assert.equal((await fetch(`${base}/api/thoughts/${manualRecord.id}`, { method: "DELETE" })).status, 200);
  const blockTrash = await (await fetch(`${base}/api/trash`)).json();
  const deletedBlock = blockTrash.items.find(item => item.type === "thoughtBlock" && item.resourceId === manualRecord.id);
  assert.ok(deletedBlock);
  assert.equal((await fetch(`${base}/api/trash/${deletedBlock.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.find(item => item.id === manualRecord.id).content, "一条独立更新记录");

  const chat = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ occurredAt: "2026-09-27T11:12:13", message: "测试同步回答" }) })).json();
  assert.equal(chat.answer, "同步回答");
  assert.equal(chat.reasoningContent, "同步模型思考");
  assert.equal(chat.occurredAt, "2026-09-27T03:12:13.000Z");
  const chatRequest = modelRequests.at(-1);
  assert.deepEqual([chatRequest.model, chatRequest.reasoning_effort], ["deepseek-v4-pro", "high"]);
  assert.match(chatRequest.messages[0].content, /200～600/);
  const withChat = await (await fetch(`${base}/api/state`)).json();
  assert.equal(withChat.chats[0]?.reasoningContent, "同步模型思考");
  assert.equal((await addHighlight("chat", chat.id, "answer", "同步")).status, 201);

  const quote = await (await fetch(`${base}/api/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ occurredAt: "2026-09-27T12:13:14", source: "测试来源", content: "测试善言", tags: ["修行", "传统"] }) })).json();
  assert.equal(quote.occurredOn, "2026-09-27");
  assert.equal(quote.occurredAt, "2026-09-27T04:13:14.000Z");
  assert.deepEqual(quote.tags, ["修行", "传统"]);
  assert.equal((await addHighlight("quote", quote.id, "content", "测试")).status, 201);
  const editedQuote = await (await fetch(`${base}/api/quotes/${quote.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ occurredAt: "2026-09-27T12:13:14", source: "更新来源", content: "测试\n更新善言", tags: ["更新"] }) })).json();
  assert.equal(editedQuote.content, "测试\n更新善言");
  assert.deepEqual(editedQuote.tags, ["更新"]);
  assert.equal(editedQuote.annotations[0].quote, "测试");

  const synthesisAction = await (await fetch(`${base}/api/v1/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "analysis-feedback-source"
    },
    body: JSON.stringify({ title: "验证复盘输入" })
  })).json();
  const synthesisFeedback = await fetch(`${base}/api/v1/actions/${synthesisAction.data.id}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "if-match": "\"1\""
    },
    body: JSON.stringify({
      outcome: "unsure",
      learningAllowed: true
    })
  });
  assert.equal(synthesisFeedback.status, 200);
  const firstAnalysis = await (await fetch(`${base}/api/analysis/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const secondAnalysis = await (await fetch(`${base}/api/analysis/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const persistedAnalyses = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).analyses;
  assert.equal(persistedAnalyses.length, 2);
  assert.equal(persistedAnalyses[0].id, secondAnalysis.id);
  assert.equal(persistedAnalyses[1].id, firstAnalysis.id);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).analyses.length, 2);
  const analysisAnnotationResponse = await fetch(`${base}/api/annotations/analysis/${firstAnalysis.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "comment", targetKey: "content", start: 0, end: 2, quote: "同步", text: "需要核对这条总判断的反证。" })
  });
  assert.equal(analysisAnnotationResponse.status, 201, await analysisAnnotationResponse.clone().text());
  const analysisAnnotation = await analysisAnnotationResponse.json();
  const shenjiModelCount = modelRequests.length;
  const shenjiResponses = await Promise.all([0, 1].map(() => fetch(`${base}/api/annotations/analysis/${firstAnalysis.id}/${analysisAnnotation.id}/shenji`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "这条复盘判断可能遗漏了什么？", clientRequestId: "analysis-shenji-1" })
  })));
  assert.deepEqual(shenjiResponses.map(response => response.status).sort(), [200, 202]);
  const shenjiTasks = await Promise.all(shenjiResponses.map(response => response.json()));
  assert.equal(shenjiTasks[0].id, shenjiTasks[1].id);
  const shenjiTask = shenjiTasks[0];
  assert.equal((await waitForTask(base, shenjiTask.id)).status, "succeeded");
  assert.equal(modelRequests.length - shenjiModelCount, 1);
  const analysisAfterAnnotation = (await (await fetch(`${base}/api/state`)).json()).analyses.find(item => item.id === firstAnalysis.id);
  assert.equal(analysisAfterAnnotation.annotations[0].shenji[0].answer, "同步回答");
  assert.equal(analysisAfterAnnotation.annotations[0].shenji[0].sourceTaskId, shenjiTask.id);
  assert.equal(analysisAfterAnnotation.annotations[0].text, "需要核对这条总判断的反证。");
  assert.equal(analysisAfterAnnotation.annotations[0].shenji[0].reasoningContent, "同步模型思考");
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /认知复盘/);
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /这条复盘判断可能遗漏了什么/);
  assert.match(modelRequests.at(-1).messages[0].content, /第一段直接判断标记内容/);
  const interactionStatistics = (await (await fetch(`${base}/api/statistics`)).json()).records.interactions;
  assert.ok(interactionStatistics.find(item => item.key === "highlights").count >= 4);
  assert.ok(interactionStatistics.find(item => item.key === "comments").count >= 1);
  assert.equal(interactionStatistics.find(item => item.key === "shenji").count, 1);

  const annotationRaceQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T14:28:00", content: "批注版本竞态问题", tags: [] })
  })).json();
  const annotationRace = await (await fetch(`${base}/api/annotations/thought/${annotationRaceQuestion.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey: `question:${annotationRaceQuestion.id}`, start: 2, end: 8, quote: "版本竞态问题", text: "" })
  })).json();
  const annotationRaceTask = await (await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "annotationShenji", resourceType: "thought", targetId: annotationRaceQuestion.id, subtargetId: annotationRace.id, payload: { message: "检查竞态" }, clientRequestId: "stale-annotation-task" })
  })).json();
  assert.equal((await fetch(`${base}/api/thought-chains/${annotationRaceQuestion.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "批注版本竞态问题（已经修改）", tags: [] })
  })).status, 200);
  assert.equal((await waitForTask(base, annotationRaceTask.id)).status, "stale");
  const annotationRaceState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(annotationRaceState.thoughts.find(item => item.id === annotationRaceQuestion.id).annotations[0].shenji?.length || 0, 0);
  const retriedAnnotation = await (await fetch(`${base}/api/ai-tasks/${annotationRaceTask.id}/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  })).json();
  assert.equal((await waitForTask(base, retriedAnnotation.id)).status, "succeeded");
  const retriedAnnotationState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(retriedAnnotationState.thoughts.find(item => item.id === annotationRaceQuestion.id).annotations[0].shenji[0].sourceTaskId, retriedAnnotation.id);

  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const uploadedCoverResponse = await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: pixel })
  });
  assert.equal(uploadedCoverResponse.status, 201);
  const uploadedCover = await uploadedCoverResponse.json();
  assert.match(uploadedCover.attachmentPath, /^\/attachments\/.+\.png$/);
  const keepsakePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const keepsakeMediaResponse = await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "keepsake-media-upload" },
    body: JSON.stringify({ purpose: "keepsake", image: keepsakePixel, alphaMask: keepsakePixel })
  });
  assert.equal(keepsakeMediaResponse.status, 201, await keepsakeMediaResponse.clone().text());
  const keepsakeMedia = await keepsakeMediaResponse.json();
  assert.equal(keepsakeMedia.attachmentPaths.length, 2);
  const replayedKeepsakeMedia = await (await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "keepsake-media-upload" },
    body: JSON.stringify({ purpose: "keepsake", image: keepsakePixel, alphaMask: keepsakePixel })
  })).json();
  assert.deepEqual(replayedKeepsakeMedia.attachmentPaths, keepsakeMedia.attachmentPaths);
  assert.equal((await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "keepsake-media-upload" },
    body: JSON.stringify({ purpose: "keepsake", image: `${keepsakePixel}A`, alphaMask: keepsakePixel })
  })).status, 409);
  const discardedKeepsakeMedia = await (await fetch(`${base}/api/images/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "keepsake", attachmentPaths: keepsakeMedia.attachmentPaths, uploadRequestId: "keepsake-media-upload" })
  })).json();
  assert.deepEqual(discardedKeepsakeMedia.discarded, keepsakeMedia.attachmentPaths);
  assert.equal((await fetch(`${base}${keepsakeMedia.originalPath}`)).status, 404);
  const missingUploadKeyResponse = await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "original", images: [pixel] })
  });
  assert.equal(missingUploadKeyResponse.status, 400);
  assert.equal((await missingUploadKeyResponse.json()).code, "IDEMPOTENCY_KEY_REQUIRED");
  const originalUploadResponse = await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "content-original-upload" },
    body: JSON.stringify({ purpose: "original", images: [pixel, pixel] })
  });
  assert.equal(originalUploadResponse.status, 201);
  const originalUpload = await originalUploadResponse.json();
  assert.equal(originalUpload.attachmentPaths.length, 2);
  const replayedOriginalUpload = await (await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "content-original-upload" },
    body: JSON.stringify({ purpose: "original", images: [pixel, pixel] })
  })).json();
  assert.deepEqual(replayedOriginalUpload.attachmentPaths, originalUpload.attachmentPaths);
  const failedUpload = await (await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "content-original-failed" },
    body: JSON.stringify({ purpose: "original", images: [pixel] })
  })).json();
  assert.equal((await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", attachmentPaths: failedUpload.attachmentPaths, occurredAt: "invalid" })
  })).status, 400);
  const discardedUpload = await (await fetch(`${base}/api/images/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attachmentPaths: failedUpload.attachmentPaths,
      uploadRequestId: "content-original-failed"
    })
  })).json();
  assert.deepEqual(discardedUpload.discarded, failedUpload.attachmentPaths);
  assert.equal((await fetch(`${base}${failedUpload.attachmentPaths[0]}`)).status, 404);
  const partialUpload = await (await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "content-original-partial" },
    body: JSON.stringify({ purpose: "original", images: [pixel, pixel] })
  })).json();
  assert.equal((await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "只引用批次中的第一张",
      attachmentPaths: [partialUpload.attachmentPaths[0]],
      occurredAt: "2026-09-27T12:00:30"
    })
  })).status, 201);
  const partialDiscard = await (await fetch(`${base}/api/images/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attachmentPaths: partialUpload.attachmentPaths,
      uploadRequestId: "content-original-partial"
    })
  })).json();
  assert.deepEqual(partialDiscard.discarded, [partialUpload.attachmentPaths[1]]);
  assert.equal((await fetch(`${base}${partialUpload.attachmentPaths[0]}`)).status, 200);
  assert.equal((await fetch(`${base}${partialUpload.attachmentPaths[1]}`)).status, 404);
  assert.equal((await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "content-original-partial" },
    body: JSON.stringify({ purpose: "original", images: [pixel, pixel] })
  })).status, 409);
  const imageOnlyCaptureResponse = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", attachmentPaths: originalUpload.attachmentPaths, occurredAt: "2026-09-27T12:01:00" })
  });
  assert.equal(imageOnlyCaptureResponse.status, 201, await imageOnlyCaptureResponse.clone().text());
  const imageOnlyCapture = await imageOnlyCaptureResponse.json();
  assert.equal(imageOnlyCapture.content, "");
  assert.deepEqual(imageOnlyCapture.attachmentPaths, originalUpload.attachmentPaths);
  const imageOnlyCaptureEdit = await fetch(`${base}/api/captures/${imageOnlyCapture.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", attachmentPaths: [originalUpload.attachmentPaths[0]] })
  });
  assert.equal(imageOnlyCaptureEdit.status, 200, await imageOnlyCaptureEdit.clone().text());
  assert.deepEqual((await imageOnlyCaptureEdit.json()).attachmentPaths, [originalUpload.attachmentPaths[0]]);
  const attachmentTrash = (await (await fetch(`${base}/api/trash`)).json()).items.find(item => (
    item.type === "contentAttachment" && item.location?.targetId === imageOnlyCapture.id
  ));
  assert.deepEqual(attachmentTrash.payload.attachmentPaths, [originalUpload.attachmentPaths[1]]);
  const imageOnlyThoughtResponse = await fetch(`${base}/api/thought-chains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientRequestId: "image-only-thought",
      question: "",
      attachmentPaths: [originalUpload.attachmentPaths[0]],
      occurredAt: "2026-09-27T12:02:00",
      generateAnswer: true
    })
  });
  assert.equal(imageOnlyThoughtResponse.status, 201, await imageOnlyThoughtResponse.clone().text());
  const imageOnlyThought = await imageOnlyThoughtResponse.json();
  const imageOnlyRoot = imageOnlyThought.items.find(item => item.type === "question");
  assert.equal(imageOnlyRoot.content, "");
  assert.deepEqual(imageOnlyRoot.attachmentPaths, [originalUpload.attachmentPaths[0]]);
  assert.equal(imageOnlyThought.task.kind, "thoughtAnswer");
  assert.equal((await waitForTask(base, imageOnlyThought.task.id)).status, "succeeded");
  assert.equal(modelRequests.at(-1).messages.at(-1).content.some(item => item.type === "image_url"), true);
  const imageOnlyBlockResponse = await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "record",
      relatedTo: imageOnlyRoot.id,
      content: "",
      attachmentPaths: [originalUpload.attachmentPaths[1]],
      occurredAt: "2026-09-27T12:03:00"
    })
  });
  assert.equal(imageOnlyBlockResponse.status, 201, await imageOnlyBlockResponse.clone().text());
  const imageOnlyBlock = await imageOnlyBlockResponse.json();
  assert.equal(imageOnlyBlock.content, "");
  const imageCommentHost = await (await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "图片评论锚点", occurredAt: "2026-09-27T12:04:00" })
  })).json();
  const imageOnlyCommentResponse = await fetch(`${base}/api/annotations/capture/${imageCommentHost.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "comment",
      targetKey: "content",
      quote: "图片评论",
      start: 0,
      end: 4,
      text: "",
      attachmentPaths: [originalUpload.attachmentPaths[0]]
    })
  });
  assert.equal(imageOnlyCommentResponse.status, 201, await imageOnlyCommentResponse.clone().text());
  assert.deepEqual((await imageOnlyCommentResponse.json()).attachmentPaths, [originalUpload.attachmentPaths[0]]);
  const beforeUnderstanding = await (await fetch(`${base}/api/state`)).json();
  const currentImageOnlyCapture = beforeUnderstanding.captures.find(item => item.id === imageOnlyCapture.id);
  const understandingResponse = await fetch(`${base}/api/v1/content-attachments/understandings`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "image-understanding-capture" },
    body: JSON.stringify({
      targetType: "capture",
      targetId: imageOnlyCapture.id,
      inputVersion: currentImageOnlyCapture.version,
      attachmentPaths: currentImageOnlyCapture.attachmentPaths
    })
  });
  assert.equal(understandingResponse.status, 202, await understandingResponse.clone().text());
  const understandingTask = (await understandingResponse.json()).data;
  assert.equal(understandingTask.kind, "contentImageUnderstanding");
  assert.equal((await waitForTask(base, understandingTask.id)).status, "succeeded");
  const understandingResult = await (await fetch(`${base}/api/ai-tasks/${understandingTask.id}/result`)).json();
  assert.equal(understandingResult.result.sourceTaskId, understandingTask.id);
  assert.equal(understandingResult.result.content, "同步回答");
  const afterUnderstanding = await (await fetch(`${base}/api/state`)).json();
  const understoodCapture = afterUnderstanding.captures.find(item => item.id === imageOnlyCapture.id);
  assert.equal(understoodCapture.content, "");
  assert.equal(understoodCapture.imageUnderstandings[0].content, "同步回答");
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /作为捕念原文保存/);
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /image_url/);

  const missingReadingStartResponse = await fetch(`${base}/api/books`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "缺少阅读日期" })
  });
  assert.equal(missingReadingStartResponse.status, 400);
  assert.match((await missingReadingStartResponse.json()).error, /开始日期/);
  const book = await (await fetch(`${base}/api/books`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "测试书目", author: "作者", readingStartedOn: "2026-09-01", readingFinishedOn: "", description: "一段可复用批注的简介。", imagePath: uploadedCover.attachmentPath })
  })).json();
  assert.equal(book.imagePath, uploadedCover.attachmentPath);
  assert.equal(book.readingStartedOn, "2026-09-01");
  assert.equal(book.readingFinishedOn, "");
  const note = await (await fetch(`${base}/api/books/${book.id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T09:10:11", type: "thought", favorite: "star", content: "一段可复用批注的读书笔记。" })
  })).json();
  assert.equal(note.type, "thought");
  assert.equal(note.favorite, "star");
  assert.equal(note.occurredAt, "2026-09-27T01:10:11.000Z");
  assert.equal((await addHighlight("book", book.id, "description", "简介", 8)).status, 201);
  assert.equal((await addHighlight("book", book.id, `note:${note.id}`, "读书笔记", 8)).status, 201);
  const editedBookResponse = await fetch(`${base}/api/books/${book.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "更新后的书目", author: "新作者", publisher: "新出版社", isbn: "9780000000001", readingStartedOn: "2026-09-01", readingFinishedOn: "2026-09-27", description: "新增一段可复用批注的简介。", imagePath: uploadedCover.attachmentPath })
  });
  assert.equal(editedBookResponse.status, 200);
  const editedBook = await editedBookResponse.json();
  assert.equal(editedBook.title, "更新后的书目");
  assert.equal(editedBook.readingFinishedOn, "2026-09-27");
  assert.equal(editedBook.annotations.find(item => item.targetKey === "description").start, 10);
  const reversedReadingRangeResponse = await fetch(`${base}/api/books/${book.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "更新后的书目", readingStartedOn: "2026-09-28", readingFinishedOn: "2026-09-27" })
  });
  assert.equal(reversedReadingRangeResponse.status, 400);
  assert.match((await reversedReadingRangeResponse.json()).error, /不能早于/);
  const editedBookNoteResponse = await fetch(`${base}/api/books/${book.id}/notes/${note.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T10:11:12", type: "record", favorite: "sprout", content: "新增一段可复用批注的读书笔记。" })
  });
  assert.equal(editedBookNoteResponse.status, 200);
  const editedBookNote = await editedBookNoteResponse.json();
  assert.equal(editedBookNote.type, "record");
  assert.equal(editedBookNote.favorite, "sprout");
  const bookAfterEdit = (await (await fetch(`${base}/api/state`)).json()).books.find(item => item.id === book.id);
  assert.equal(bookAfterEdit.annotations.find(item => item.targetKey === `note:${note.id}`).start, 10);
  assert.equal((await fetch(`${base}/api/books/${book.id}/notes/${note.id}`, { method: "DELETE" })).status, 200);
  const bookAfterDelete = (await (await fetch(`${base}/api/state`)).json()).books.find(item => item.id === book.id);
  assert.equal(bookAfterDelete.notes.length, 0);
  assert.equal(bookAfterDelete.annotations.some(item => item.targetKey === `note:${note.id}`), false);
  const trashAfterBookNoteDelete = await (await fetch(`${base}/api/trash`)).json();
  const deletedBookNote = trashAfterBookNoteDelete.items.find(item => item.type === "bookNote" && item.resourceId === note.id);
  assert.ok(deletedBookNote);
  assert.equal(deletedBookNote.dependents.annotations[0].targetKey, `note:${note.id}`);
  assert.equal((await fetch(`${base}/api/trash/${deletedBookNote.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  const bookAfterRestore = (await (await fetch(`${base}/api/state`)).json()).books.find(item => item.id === book.id);
  assert.equal(bookAfterRestore.notes[0].content, "新增一段可复用批注的读书笔记。");
  assert.equal(bookAfterRestore.annotations.some(item => item.targetKey === `note:${note.id}`), true);

  const parsedBookImage = await fetch(`${base}/api/books/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" })
  });
  assert.equal(parsedBookImage.status, 200);
  const parsedBook = await parsedBookImage.json();
  assert.match(parsedBook.attachmentPaths[0], /^\/attachments\/.+\.png$/);
  assert.equal("imagePath" in parsedBook, false);

  const parsedSleepResponse = await fetch(`${base}/api/images/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "sleep", images: [pixel, pixel] })
  });
  assert.equal(parsedSleepResponse.status, 200);
  const sleepTraceId = parsedSleepResponse.headers.get("x-request-id");
  assert.match(sleepTraceId, /^[a-f0-9-]{36}$/);
  const parsedSleep = await parsedSleepResponse.json();
  assert.equal(parsedSleep.totalMinutes, 462);
  assert.equal(parsedSleep.deepPercent, 29);
  assert.equal(parsedSleep.awakeMinutes, null);
  assert.equal(parsedSleep.attachmentPaths.length, 2);
  const sleepModelRequest = modelRequests.at(-1);
  assert.equal(sleepModelRequest.model, "deepseek-flash");
  assert.equal(sleepModelRequest.messages.at(-1).content.filter(item => item.type === "image_url").length, 2);

  const healthLeaseUpload = await (await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "health-lease-upload" },
    body: JSON.stringify({ purpose: "original", images: [pixel] })
  })).json();
  const parsedHealthLeaseResponse = await fetch(`${base}/api/images/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "weight", attachmentPaths: healthLeaseUpload.attachmentPaths })
  });
  assert.equal(parsedHealthLeaseResponse.status, 200);
  const parsedHealthLease = await parsedHealthLeaseResponse.json();
  assert.deepEqual(parsedHealthLease.attachmentPaths, healthLeaseUpload.attachmentPaths);
  const discardedHealthLease = await (await fetch(`${base}/api/images/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attachmentPaths: healthLeaseUpload.attachmentPaths,
      uploadRequestId: "health-lease-upload"
    })
  })).json();
  assert.deepEqual(discardedHealthLease.discarded, healthLeaseUpload.attachmentPaths);

  const sleepRecord = await (await fetch(`${base}/api/daily-records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "sleep", source: "screenshot", occurredAt: parsedSleep.wakeTime, ...parsedSleep })
  })).json();
  assert.equal(sleepRecord.occurredOn, "2026-09-27");
  assert.equal(sleepRecord.totalMinutes, 462);
  assert.equal(sleepRecord.source, "screenshot");

  const heartParsed = await (await fetch(`${base}/api/images/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "heartRate", images: [pixel] })
  })).json();
  assert.deepEqual([heartParsed.minimum, heartParsed.maximum, heartParsed.average, heartParsed.resting, heartParsed.sleepAverage], [46, 82, 60, 52, 50]);
  assert.match(heartParsed.trendAnalysis, /午后与晚间/);
  const imageUsage = JSON.parse(await fs.readFile(path.join(dataDir, "ai-usage.json"), "utf8"));
  const sleepUsage = imageUsage.entries.find(item => item.traceId === sleepTraceId);
  assert.deepEqual({
    version: imageUsage.version,
    status: sleepUsage.status,
    modality: sleepUsage.modality,
    imageCount: sleepUsage.imageCount,
    imageTypes: sleepUsage.imageTypes,
    imageDimensions: sleepUsage.imageDimensions,
    scene: sleepUsage.scene,
    stream: sleepUsage.stream,
    responseFormat: sleepUsage.responseFormat,
    usageKnown: sleepUsage.usageKnown
  }, {
    version: 5,
    status: "success",
    modality: "vision",
    imageCount: 2,
    imageTypes: ["image/png"],
    imageDimensions: [{ width: 1, height: 1 }, { width: 1, height: 1 }],
    scene: "healthRecognition",
    stream: false,
    responseFormat: "json_object",
    usageKnown: true
  });
  assert.ok(sleepUsage.imageBytes > 0);
  assert.ok(sleepUsage.durationMs >= 0);
  assert.deepEqual(sleepUsage.rawUsage, { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 300 } });
  const imageStatistics = (await (await fetch(`${base}/api/statistics`)).json()).ai;
  assert.equal(imageStatistics.summary.visionCalls, 6);
  assert.equal(imageStatistics.summary.imageCount, 7);
  assert.equal(imageStatistics.modalities.find(item => item.modality === "vision").calls, 6);
  const auditFiles = (await fs.readdir(path.join(dataDir, "logs"))).filter(name => name.startsWith("ai-audit-"));
  const auditEntries = (await Promise.all(auditFiles.map(async name => (await fs.readFile(path.join(dataDir, "logs", name), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
  const sleepAudit = auditEntries.find(item => item.traceId === sleepTraceId && item.status !== "started");
  assert.ok(auditEntries.some(item => item.callId === sleepAudit.callId && item.status === "started"));
  assert.equal(sleepAudit.schemaVersion, 3);
  assert.equal(sleepAudit.actor.userId, "local");
  assert.equal(sleepAudit.request.images.length, 2);
  assert.equal(sleepAudit.request.images[0].sha256.length, 64);
  assert.match(sleepAudit.request.userPrompt, /同一次睡眠记录/);
  assert.match(sleepAudit.response.content, /totalMinutes/);
  const diaryTopicAudits = auditEntries.filter(item => item.scene === "diaryTopic" && item.status !== "started");
  assert.equal(diaryTopicAudits.length, 2);
  assert.equal(new Set(diaryTopicAudits.map(item => item.callGroupId)).size, 1);
  assert.deepEqual(diaryTopicAudits.map(item => [item.attempt, item.status, item.retryScheduled]), [[1, "failed", true], [2, "success", false]]);
  assert.doesNotMatch(JSON.stringify(auditEntries), /test-key|data:image/);

  const segmentedResponse = await fetch(`${base}/api/keepsakes/segment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: pixel })
  });
  assert.equal(segmentedResponse.status, 200);
  const segmented = await segmentedResponse.json();
  assert.deepEqual(segmented, { cutout: mockSegmentCutout, provider: "aliyun-segment-hd" });
  const keepsake = await (await fetch(`${base}/api/keepsakes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T10:20:30", title: "展览票券", category: "纸品", note: "测试留存", tags: ["展览", "票券"], originalPath: "/attachments/original.png", cutoutPath: "/attachments/cutout.png", source: "auto", edgeExpansion: 8 })
  })).json();
  assert.equal(keepsake.occurredOn, "2026-09-27");
  assert.equal(keepsake.source, "auto");
  assert.deepEqual(keepsake.tags, ["展览", "票券"]);
  const keepsakeCreatedAt = keepsake.createdAt;
  const editedKeepsake = await (await fetch(`${base}/api/keepsakes/${keepsake.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T11:22:33", title: "修改后的票券", category: "其他", note: "", tags: ["纪念"], originalPath: keepsake.originalPath, cutoutPath: keepsake.cutoutPath, source: "manual", edgeExpansion: 5 })
  })).json();
  assert.equal(editedKeepsake.createdAt, keepsakeCreatedAt);
  assert.equal(editedKeepsake.title, "修改后的票券");
  assert.deepEqual(editedKeepsake.tags, ["纪念"]);
  assert.equal((await fetch(`${base}/api/keepsakes/${keepsake.id}`, { method: "DELETE" })).status, 200);

  const weightRecord = await (await fetch(`${base}/api/daily-records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "weight", occurredAt: "2026-09-27T08:00:00", measuredWeight: 70, clothing: "light" })
  })).json();
  assert.deepEqual({ adjusted: weightRecord.adjustedWeight, lower: weightRecord.lower95, upper: weightRecord.upper95 }, { adjusted: 69.5, lower: 69.1, upper: 69.9 });
  const weightCreatedAt = weightRecord.createdAt;
  const editedWeight = await (await fetch(`${base}/api/daily-records/${weightRecord.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "weight", occurredAt: "2026-09-27T09:00:00", measuredWeight: 71, clothing: "heavy" })
  })).json();
  assert.equal(editedWeight.adjustedWeight, 69.5);
  assert.deepEqual([editedWeight.lower95, editedWeight.upper95], [68.5, 70.5]);
  assert.equal(editedWeight.createdAt, weightCreatedAt);
  assert.equal((await fetch(`${base}/api/daily-records/${weightRecord.id}`, { method: "DELETE" })).status, 200);

  // Missing total weight must never be reconstructed from body composition.
  const imageParse = kind => fetch(`${base}/api/images/parse`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, images: [pixel], referenceDate: "2026-09-27", requestId: `health-${kind}`, targetId: `daily:${kind}`, inputVersion: 3 })
  });
  const saveDaily = (payload, id = "") => fetch(`${base}/api/daily-records${id ? `/${id}` : ""}`, {
    method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const bodyParsedResponse = await imageParse("weight");
  assert.equal(bodyParsedResponse.status, 200);
  const bodyParsed = await bodyParsedResponse.json();
  assert.deepEqual(Object.fromEntries(Object.keys(healthImageFixtures.weight).map(key => [key, bodyParsed[key]])), healthImageFixtures.weight);
  assert.equal(bodyParsed.requestId, "health-weight");
  assert.equal(bodyParsed.inputVersion, 3);
  assert.equal(bodyParsed.attachmentPaths.length, 1);
  assert.equal(modelRequests.at(-1).model, "deepseek-flash");
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /不能把体水分/);
  const bodyRecordResponse = await saveDaily({ ...bodyParsed, type: "weight", source: "screenshot", occurredAt: "2026-09-23T08:00:00" });
  assert.equal(bodyRecordResponse.status, 201);
  const bodyRecord = await bodyRecordResponse.json();
  assert.deepEqual([bodyRecord.measuredWeight, bodyRecord.adjustedWeight, bodyRecord.lower95, bodyRecord.upper95], [null, null, null, null]);
  assert.equal(bodyRecord.bodyWaterMass, 42.2);
  assert.equal(bodyRecord.measuredAt, "");
  assert.doesNotMatch(describeHealthDetails("weight", bodyRecord), /nullkg|undefined|NaN/);
  assert.match(describeHealthDetails("weight", bodyRecord), /总重量未填写/);
  const bodyEdited = await (await saveDaily({ description: "修改体成分描述", musclePercent: null }, bodyRecord.id)).json();
  assert.equal(bodyEdited.bodyWaterMass, 42.2, "Partial edits preserve recognized metrics");
  assert.equal(bodyEdited.musclePercent, null);
  assert.deepEqual(bodyEdited.attachmentPaths, bodyParsed.attachmentPaths);
  const withWeight = await (await saveDaily({ measuredWeight: 68, clothing: "light" }, bodyRecord.id)).json();
  assert.deepEqual([withWeight.adjustedWeight, withWeight.lower95, withWeight.upper95], [67.5, 67.1, 67.9]);
  const clearedWeight = await (await saveDaily({ measuredWeight: null }, bodyRecord.id)).json();
  assert.equal(clearedWeight.adjustedWeight, null);
  assert.equal(clearedWeight.skeletalMuscleMass, 30.4);

  const exerciseParsedResponse = await imageParse("exercise");
  assert.equal(exerciseParsedResponse.status, 200);
  const exerciseParsed = await exerciseParsedResponse.json();
  assert.deepEqual(Object.fromEntries(Object.keys(healthImageFixtures.exercise).map(key => [key, exerciseParsed[key]])), healthImageFixtures.exercise);
  assert.equal(modelRequests.at(-1).model, "deepseek-flash");
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /截断的区间不能填零/);
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /手机状态栏/);
  const exerciseResponse = await saveDaily({ ...exerciseParsed, type: "exercise", source: "screenshot", occurredAt: exerciseParsed.startedAt });
  assert.equal(exerciseResponse.status, 201);
  const exerciseRecord = await exerciseResponse.json();
  assert.equal(exerciseRecord.startedAt, "2026-09-23T09:12:34.000Z");
  assert.equal(exerciseRecord.occurredOn, "2026-09-23");
  assert.equal(exerciseRecord.durationSeconds, 1987);
  assert.equal(exerciseRecord.aerobicSeconds, 0);
  assert.equal(exerciseRecord.anaerobicSeconds, null);
  assert.match(describeHealthDetails("exercise", exerciseRecord), /力量训练；运动时长1987秒；活动热量184kcal；总热量231kcal/);
  assert.doesNotMatch(describeHealthDetails("exercise", exerciseRecord), /AI解析/);
  assert.match(describeHealthDetails("exercise", exerciseRecord, { includeDerived: true }), /AI解析：力量训练期间心率多次升降/);
  assert.equal((await saveDaily({ averageHeartRate: 180 }, exerciseRecord.id)).status, 400);
  assert.equal((await saveDaily({ totalCalories: 100 }, exerciseRecord.id)).status, 400);
  assert.equal((await saveDaily({ durationSeconds: 10 }, exerciseRecord.id)).status, 400);
  const exerciseEdited = await (await saveDaily({ description: "自行补充的运动感受", maximumHeartRate: null }, exerciseRecord.id)).json();
  assert.equal(exerciseEdited.maximumHeartRate, null);
  assert.equal(exerciseEdited.durationSeconds, 1987);
  assert.equal(exerciseEdited.description, "自行补充的运动感受");
  assert.equal(exerciseEdited.recognitionDescription, healthImageFixtures.exercise.recognitionDescription);
  assert.equal(exerciseEdited.createdAt, exerciseRecord.createdAt);
  assert.equal((await saveDaily({ type: "exercise", description: "散步，旧版纯描述仍可用" })).status, 201);
  assert.equal((await saveDaily({ type: "exercise", recognitionDescription: "仅有截图解析也可保存" })).status, 201);
  for (const type of ["weight", "exercise"]) {
    assert.equal((await saveDaily({ type })).status, 400);
    assert.equal((await fetch(`${base}/api/images/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: type, images: [pixel, pixel] }) })).status, 400);
  }
  const invalidHealth = normalizeHealthImage("weight", { measuredWeight: "", muscleMass: true, bodyFatPercent: 101, bodyAge: -1, measuredAt: "2026-02-30T09:00:00", date: "2026-02-30" });
  assert.deepEqual([invalidHealth.measuredWeight, invalidHealth.muscleMass, invalidHealth.bodyFatPercent, invalidHealth.bodyAge, invalidHealth.date, invalidHealth.measuredAt], [null, null, null, null, "", ""]);
  const invalidExercise = normalizeHealthImage("exercise", { durationSeconds: 2.5, activeCalories: " ", totalCalories: false, aerobicSeconds: 0 });
  assert.deepEqual([invalidExercise.durationSeconds, invalidExercise.activeCalories, invalidExercise.totalCalories, invalidExercise.aerobicSeconds], [null, null, null, 0]);
  const legacyExerciseRecognition = normalizeHealthImage("exercise", { description: "旧模型返回的运动解析" });
  assert.equal(legacyExerciseRecognition.description, "旧模型返回的运动解析");
  assert.equal(legacyExerciseRecognition.recognitionDescription, "旧模型返回的运动解析");
  const attachmentsBeforeFailure = (await fs.readdir(path.join(dataDir, "attachments"))).sort();
  nextHealthReply = "not JSON";
  assert.equal((await imageParse("exercise")).status, 400);
  assert.deepEqual((await fs.readdir(path.join(dataDir, "attachments"))).sort(), attachmentsBeforeFailure);
  for (const entry of [bodyRecord, exerciseRecord]) {
    assert.equal((await fetch(`${base}/api/daily-records/${entry.id}`, { method: "DELETE" })).status, 200);
    const deleted = (await (await fetch(`${base}/api/trash`)).json()).items.find(item => item.resourceId === entry.id);
    assert.deepEqual(deleted.payload.attachmentPaths, entry.attachmentPaths);
    assert.equal((await fetch(`${base}/api/trash/${deleted.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
    assert.equal((await fetch(`${base}${entry.attachmentPaths[0]}`)).status, 200);
  }

  const reflectionId = reflectionEvents.at(-1).result.id;
  assert.equal((await fetch(`${base}/api/journals/${createdJournal.id}/reflections/${reflectionId}`, { method: "DELETE" })).status, 200);
  const reflectionTrash = await (await fetch(`${base}/api/trash`)).json();
  const deletedReflection = reflectionTrash.items.find(item => item.type === "journalReflection" && item.resourceId === reflectionId);
  assert.equal(deletedReflection.dependents.annotations[0].targetKey, `reflection:${reflectionId}`);
  assert.equal((await fetch(`${base}/api/trash/${deletedReflection.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  const journalAfterReflectionRestore = (await (await fetch(`${base}/api/state`)).json()).journals.find(item => item.id === createdJournal.id);
  assert.equal(journalAfterReflectionRestore.reflections[0].id, reflectionId);
  assert.equal(journalAfterReflectionRestore.annotations.some(item => item.targetKey === `reflection:${reflectionId}`), true);

  assert.equal((await fetch(`${base}/api/captures/${createdCapture.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/journals/${createdJournal.id}`, { method: "DELETE" })).status, 200);
  const trashAfterDeletes = await (await fetch(`${base}/api/trash`)).json();
  const deletedCapture = trashAfterDeletes.items.find(item => item.type === "capture" && item.resourceId === createdCapture.id);
  const deletedJournal = trashAfterDeletes.items.find(item => item.type === "journal" && item.resourceId === createdJournal.id);
  assert.ok(deletedCapture);
  assert.ok(deletedJournal);
  const stateAfterSoftDelete = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterSoftDelete.captures.some(item => item.id === createdCapture.id), false);
  assert.equal(stateAfterSoftDelete.journals.some(item => item.id === createdJournal.id), false);
  assert.equal(Object.hasOwn(stateAfterSoftDelete, "trash"), false);
  assert.equal((await fetch(`${base}/api/trash/${deletedCapture.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${base}/api/trash/${deletedJournal.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  const stateAfterRestore = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterRestore.captures.find(item => item.id === createdCapture.id).content, "补充后的碎片");
  assert.equal(stateAfterRestore.journals.find(item => item.id === createdJournal.id).content, "修改后的原文。");

  const concurrentTaskQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T14:50:00", content: "后台任务并发幂等", tags: [] })
  })).json();
  const concurrentTaskModelCount = modelRequests.length;
  const concurrentTaskResponses = await Promise.all([0, 1].map(() => fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "thoughtAnswer", targetId: concurrentTaskQuestion.id, inputVersion: concurrentTaskQuestion.version, clientRequestId: "background-task-concurrent" })
  })));
  assert.deepEqual(concurrentTaskResponses.map(response => response.status).sort(), [200, 202]);
  const concurrentTasks = await Promise.all(concurrentTaskResponses.map(response => response.json()));
  assert.equal(concurrentTasks[0].id, concurrentTasks[1].id);
  let concurrentTaskResult;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    concurrentTaskResult = await (await fetch(`${base}/api/ai-tasks/${concurrentTasks[0].id}`)).json();
    if (!["queued", "running"].includes(concurrentTaskResult.status)) break;
    await sleep(25);
  }
  assert.equal(concurrentTaskResult.status, "succeeded");
  assert.equal(modelRequests.length - concurrentTaskModelCount, 1);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.filter(item => item.sourceTaskId === concurrentTasks[0].id).length, 1);

  const backgroundQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T15:00:00", content: "后台任务问题", tags: [] })
  })).json();
  const backgroundTaskResponse = await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "thoughtAnswer", targetId: backgroundQuestion.id, inputVersion: backgroundQuestion.version, clientRequestId: "background-task-1" })
  });
  assert.equal(backgroundTaskResponse.status, 202);
  const backgroundTask = await backgroundTaskResponse.json();
  const duplicateTask = await (await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "thoughtAnswer", targetId: backgroundQuestion.id, inputVersion: backgroundQuestion.version, clientRequestId: "background-task-1" })
  })).json();
  assert.equal(duplicateTask.id, backgroundTask.id);
  let completedTask;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    completedTask = await (await fetch(`${base}/api/ai-tasks/${backgroundTask.id}`)).json();
    if (!["queued", "running"].includes(completedTask.status)) break;
    await sleep(50);
  }
  assert.equal(completedTask.status, "succeeded");
  const stateAfterBackground = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterBackground.thoughts.filter(item => item.sourceTaskId === backgroundTask.id).length, 1);
  const notifications = await (await fetch(`${base}/api/notifications`)).json();
  assert.ok(notifications.items.some(item => item.taskId === backgroundTask.id && item.status === "succeeded" && !item.readAt));

  const staleQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T15:10:00", content: "版本竞态问题", tags: [] })
  })).json();
  const staleTask = await (await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "thoughtAnswer", targetId: staleQuestion.id, inputVersion: staleQuestion.version, clientRequestId: "background-task-stale" })
  })).json();
  assert.equal((await fetch(`${base}/api/thought-chains/${staleQuestion.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "版本竞态问题（已修改）", tags: [] })
  })).status, 200);
  let staleResult;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    staleResult = await (await fetch(`${base}/api/ai-tasks/${staleTask.id}`)).json();
    if (!["queued", "running"].includes(staleResult.status)) break;
    await sleep(50);
  }
  assert.equal(staleResult.status, "stale");
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.some(item => item.sourceTaskId === staleTask.id), false);
  const retriedTaskResponse = await fetch(`${base}/api/ai-tasks/${staleTask.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(retriedTaskResponse.status, 202);
  const retriedTask = await retriedTaskResponse.json();
  let retriedResult;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    retriedResult = await (await fetch(`${base}/api/ai-tasks/${retriedTask.id}`)).json();
    if (!["queued", "running"].includes(retriedResult.status)) break;
    await sleep(50);
  }
  assert.equal(retriedResult.status, "succeeded");

  const restoredRaceQuestion = await (await fetch(`${base}/api/thoughts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "question", occurredAt: "2026-09-27T15:20:00", content: "版本竞态问题（删除恢复）", tags: [] })
  })).json();
  const restoredRaceTask = await (await fetch(`${base}/api/ai-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "thoughtAnswer", targetId: restoredRaceQuestion.id, inputVersion: restoredRaceQuestion.version, clientRequestId: "background-task-delete-restore" })
  })).json();
  let restoredRaceWasRunning = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const task = await (await fetch(`${base}/api/ai-tasks/${restoredRaceTask.id}`)).json();
    if (task.status === "running") { restoredRaceWasRunning = Boolean(task.startedAt); break; }
    await sleep(10);
  }
  assert.equal(restoredRaceWasRunning, true);
  assert.equal((await fetch(`${base}/api/thought-chains/${restoredRaceQuestion.id}`, { method: "DELETE" })).status, 200);
  const restoreRaceTrash = await (await fetch(`${base}/api/trash`)).json();
  const restoreRaceEntry = restoreRaceTrash.items.find(item => item.type === "thoughtChain" && item.resourceId === restoredRaceQuestion.id);
  assert.ok(restoreRaceEntry);
  assert.equal((await fetch(`${base}/api/trash/${restoreRaceEntry.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  let restoredRaceResult;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    restoredRaceResult = await (await fetch(`${base}/api/ai-tasks/${restoredRaceTask.id}`)).json();
    if (!["queued", "running", "cancelling"].includes(restoredRaceResult.status)) break;
    await sleep(25);
  }
  assert.equal(restoredRaceResult.status, "cancelled");
  const stateAfterRestoreRace = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterRestoreRace.thoughts.find(item => item.id === restoredRaceQuestion.id).version, restoredRaceQuestion.version + 1);
  assert.equal(stateAfterRestoreRace.thoughts.some(item => item.sourceTaskId === restoredRaceTask.id), false);

  const notificationStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  notificationStore.notifications = Array.from({ length: 105 }, (_, index) => ({ id: `notification-${index}`, taskId: backgroundTask.id, kind: "aiTask", targetId: backgroundQuestion.id, status: "succeeded", title: "思绪回答", message: `完成 ${index}`, createdAt: "2026-09-27T16:00:00.000Z", updatedAt: "2026-09-27T16:00:00.000Z", readAt: "" }));
  await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify(notificationStore, null, 2)}\n`);
  const notificationPage = await (await fetch(`${base}/api/notifications`)).json();
  assert.equal(notificationPage.items.length, 105);
  assert.equal(notificationPage.unread, 105);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).notificationUnread, 105);

  const trashBeforeComplexRestore = await (await fetch(`${base}/api/trash`)).json();
  const deletedKeepsake = trashBeforeComplexRestore.items.find(item => item.type === "keepsake" && item.resourceId === keepsake.id);
  const deletedWeight = trashBeforeComplexRestore.items.find(item => item.type === "dailyRecord" && item.resourceId === weightRecord.id);
  assert.ok(deletedKeepsake);
  assert.ok(deletedWeight);
  assert.equal((await fetch(`${base}/api/trash/${deletedKeepsake.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${base}/api/trash/${deletedWeight.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  const restoredMediaState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(restoredMediaState.keepsakes.find(item => item.id === keepsake.id).title, "修改后的票券");
  assert.equal(restoredMediaState.dailyRecords.find(item => item.id === weightRecord.id).adjustedWeight, 69.5);

  const contextChainBeforeDelete = (await (await fetch(`${base}/api/state`)).json()).thoughts.filter(item => item.id === "context-question" || item.relatedTo === "context-question");
  assert.equal((await fetch(`${base}/api/thought-chains/context-question`, { method: "DELETE" })).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughts.some(item => item.id === "context-question" || item.relatedTo === "context-question"), false);
  const chainTrash = await (await fetch(`${base}/api/trash`)).json();
  const deletedChain = chainTrash.items.find(item => item.type === "thoughtChain" && item.resourceId === "context-question");
  assert.equal(deletedChain.payload.items.length, contextChainBeforeDelete.length);
  assert.equal((await fetch(`${base}/api/trash/${deletedChain.id}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  const contextChainAfterRestore = (await (await fetch(`${base}/api/state`)).json()).thoughts.filter(item => item.id === "context-question" || item.relatedTo === "context-question");
  assert.deepEqual(contextChainAfterRestore.map(item => item.id).sort(), contextChainBeforeDelete.map(item => item.id).sort());
  assert.equal(contextChainAfterRestore.find(item => item.id === "context-question").annotations.length, 1);

  const disposableQuote = await (await fetch(`${base}/api/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T16:00:00", source: "清理测试", content: "只用于永久清理测试", tags: [] })
  })).json();
  assert.equal((await fetch(`${base}/api/quotes/${disposableQuote.id}`, { method: "DELETE" })).status, 200);
  const purgeTrash = await (await fetch(`${base}/api/trash`)).json();
  const purgeEntry = purgeTrash.items.find(item => item.type === "quote" && item.resourceId === disposableQuote.id);
  const purgePlan = await (await fetch(`${base}/api/trash/purge-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [purgeEntry.id] })
  })).json();
  assert.equal((await fetch(`${base}/api/trash/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [purgeEntry.id], planHash: purgePlan.planHash, confirmation: "永久删除" })
  })).status, 200);
  assert.equal((await (await fetch(`${base}/api/trash`)).json()).items.some(item => item.id === purgeEntry.id), false);

  assert.equal((await fetch(`${base}/api/books/${book.id}/notes/${note.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/books/${book.id}`, { method: "DELETE" })).status, 200);
  const parentTrash = await (await fetch(`${base}/api/trash`)).json();
  const deletedBook = parentTrash.items.find(item => item.type === "book" && item.resourceId === book.id);
  const dependentBookNote = parentTrash.items.find(item => item.type === "bookNote" && item.resourceId === note.id);
  assert.ok(deletedBook);
  assert.ok(dependentBookNote);
  const parentPurgePlan = await (await fetch(`${base}/api/trash/purge-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [deletedBook.id] })
  })).json();
  assert.deepEqual(new Set(parentPurgePlan.items.map(item => item.id)), new Set([deletedBook.id, dependentBookNote.id]));
  assert.equal((await fetch(`${base}/api/trash/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [deletedBook.id], planHash: parentPurgePlan.planHash, confirmation: "删除" })
  })).status, 400);
  assert.equal((await (await fetch(`${base}/api/trash`)).json()).items.some(item => item.id === deletedBook.id), true);
  const uploadedCoverFile = path.join(dataDir, uploadedCover.attachmentPath.replace(/^\/attachments\//, "attachments/"));
  const savedCoverFile = `${uploadedCoverFile}.saved`;
  await fs.rename(uploadedCoverFile, savedCoverFile);
  await fs.mkdir(uploadedCoverFile);
  const parentPurge = await (await fetch(`${base}/api/trash/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [deletedBook.id], planHash: parentPurgePlan.planHash, confirmation: "永久删除" })
  })).json();
  assert.equal(parentPurge.purged, 2);
  assert.equal(parentPurge.attachmentsPurged, 0);
  assert.equal(parentPurge.attachmentCleanupPending, 1);
  assert.equal(Object.hasOwn(await (await fetch(`${base}/api/state`)).json(), "attachmentCleanup"), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).attachmentCleanup[0].path, uploadedCover.attachmentPath);
  await fs.rm(uploadedCoverFile, { recursive: true, force: true });
  await fs.rename(savedCoverFile, uploadedCoverFile);
  app.kill("SIGTERM");
  if (app.exitCode == null) await new Promise(resolve => app.once("exit", resolve));
  app = startApp();
  const restartedState = await waitForServer(base, app);
  const restartedBody = restartedState.dailyRecords.find(item => item.id === bodyRecord.id);
  const restartedExercise = restartedState.dailyRecords.find(item => item.id === exerciseRecord.id);
  assert.equal(restartedBody.adjustedWeight, null);
  assert.equal(restartedBody.bodyWaterMass, 42.2);
  assert.equal(restartedExercise.durationSeconds, 1987);
  assert.equal(restartedExercise.maximumHeartRate, null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).attachmentCleanup, []);
  assert.equal((await fetch(`${base}${uploadedCover.attachmentPath}`)).status, 404);

  const lowSampleStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  delete lowSampleStore._persistence;
  lowSampleStore.thoughts = lowSampleStore.thoughts.filter(item => item.id === "question-1");
  lowSampleStore.analyses = [];
  lowSampleStore.checkins = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10);
    const factors = [
      ...(index < 10 ? ["高置信因素"] : []),
      ...(index < 5 ? ["中样本因素"] : []),
      ...([10, 11].includes(index) ? ["强差异因素"] : []),
      ...(index === 12 ? ["单日因素"] : [])
    ];
    return { id: `ranking-${index}`, createdAt: `${date}T08:00:00.000Z`, occurredAt: `${date}T08:00:00.000Z`, occurredOn: date, mood: index < 10 ? 5 : [10, 11].includes(index) ? 1 : 3, energy: 3, stress: 3, sleep: 3, factors };
  });
  await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify(lowSampleStore, null, 2)}\n`);
  const lowSampleAnalysis = await fetch(`${base}/api/analysis/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(lowSampleAnalysis.status, 201, await lowSampleAnalysis.clone().text());
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /冷启动低样本/);
  const rankedAssociations = (await (await fetch(`${base}/api/state`)).json()).insights.associations;
  assert.deepEqual(rankedAssociations.map(item => [item.factor, item.confidence]), [
    ["高置信因素", "可观察"],
    ["中样本因素", "初步线索"],
    ["强差异因素", "初步线索"]
  ]);
  assert.equal(rankedAssociations.some(item => item.factor === "单日因素"), false);

  await waitForBackgroundIdle(base);
  const automaticChainModelCount = modelRequests.length;
  const automaticChainInput = {
    clientRequestId: "automatic-chain-answer",
    occurredAt: "2026-09-27T20:05:00",
    question: "收集页自动回答回归",
    idea: "保存思绪时创建后台回答任务",
    answer: "",
    tags: ["回归"],
    generateAnswer: true
  };
  const automaticChainResponse = await fetch(`${base}/api/thought-chains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(automaticChainInput)
  });
  assert.equal(automaticChainResponse.status, 201);
  const automaticChain = await automaticChainResponse.json();
  assert.equal(automaticChain.task.kind, "thoughtAnswer");
  const duplicateAutomaticChainResponse = await fetch(`${base}/api/thought-chains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(automaticChainInput)
  });
  assert.equal(duplicateAutomaticChainResponse.status, 200);
  const duplicateAutomaticChain = await duplicateAutomaticChainResponse.json();
  assert.equal(duplicateAutomaticChain.task.id, automaticChain.task.id);
  let completedAutomaticAnswerTask = await waitForTask(base, automaticChain.task.id);
  if (completedAutomaticAnswerTask.status === "stale") {
    assert.equal(completedAutomaticAnswerTask.errorCode, "AI_TASK_STALE");
    const retryResponse = await fetch(`${base}/api/ai-tasks/${automaticChain.task.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 202);
    const retryTask = await retryResponse.json();
    completedAutomaticAnswerTask = await waitForTask(base, retryTask.id);
  }
  assert.equal(completedAutomaticAnswerTask.status, "succeeded", JSON.stringify(completedAutomaticAnswerTask));
  assert.equal(modelRequests.length - automaticChainModelCount, 1);
  const stateAfterAutomaticChain = await (await fetch(`${base}/api/state`)).json();
  assert.equal(stateAfterAutomaticChain.thoughts.filter(item => item.sourceTaskId === completedAutomaticAnswerTask.id).length, 1);

  const midnight = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(new Date("2026-09-26T16:56:18.237Z"));
  assert.equal(midnight, "00:56:18");
  console.log("Regression checks passed: v15 onboarding, trash recovery, retryable attachment cleanup, concurrent AI idempotency, target-version invalidation, thought blocks, image parsing, local dates, and reasoning isolation.");
} finally {
  app.kill("SIGTERM");
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

if (appError) process.stderr.write(appError);
