import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const modelRequests = [];

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
    if (!input.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      const messages = JSON.stringify(input.messages);
      if (messages.includes("同一次睡眠记录")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ date: "2026-09-27", bedtime: "2026-09-27T02:58:00", wakeTime: "2026-09-27T10:40:00", totalMinutes: 462, deepMinutes: 134, deepPercent: 29, lightMinutes: 221, lightPercent: 48, remMinutes: 107, remPercent: 23, awakeCount: null, awakeMinutes: null, averageHeartRate: 49, averageOxygen: 98, respiratoryRate: 15, verification: "两张图已合并" }) } }] }));
      if (messages.includes("心率日视图")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ date: "2026-09-26", minimum: 46, maximum: 82, average: 60, resting: 52, sleepAverage: 50, trendAnalysis: "凌晨下降，午后与晚间出现两次抬升，夜间回落。", trendSegments: [{ period: "00:00-06:00", direction: "下降", approximateRange: "约46-64" }], verification: "今日概览可直接核对" }) } }] }));
      if (messages.includes("书籍截图")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "测试书", author: "测试作者", verification: "图片已识别" }) } }] }));
      if (messages.includes("纸质实物数字留存")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestedTitle: "测试票券", category: "纸品", subjectDescription: "一张纸质票券", includeHand: true, confidence: .82, polygons: [[[120, 90], [880, 110], [850, 900], [140, 880]]] }) } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: "同步回答", reasoning_content: "同步模型思考" } }] }));
    }
    assert.equal(input.stream, true);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const isDiaryTopic = JSON.stringify(input.messages).includes("只输出一个主题句和一个问句");
    if (isDiaryTopic && input.thinking?.type === "enabled") {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考已经耗尽首轮输出预算。" }, finish_reason: "length" }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    const events = [
      { choices: [{ delta: { reasoning_content: "先核对问题。" } }] },
      { choices: [{ delta: { reasoning_content: "再形成判断。" } }] },
      { choices: [{ delta: { content: "**结论**：" } }] },
      { choices: [{ delta: { content: "流式回答已完成。" } }] }
    ];
    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      await sleep(60);
    }
    res.end("data: [DONE]\n\n");
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`应用服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/state`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(50);
  }
  throw new Error("等待应用服务启动超时");
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

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-regression-"));
const mock = mockDeepSeek();
const mockPort = await freePort(), appPort = await freePort();
await new Promise((resolve, reject) => mock.once("error", reject).listen(mockPort, "127.0.0.1", resolve));
await fs.writeFile(path.join(dataDir, "store.json"), `${JSON.stringify({
  version: 3,
  checkins: [{ id: "checkin-1", createdAt: "2026-09-26T16:56:18.237Z", occurredOn: "2026-09-26", mood: 3, energy: 3, stress: 3, sleep: 3 }],
  thoughts: [
    { id: "question-1", createdAt: "2026-09-26T16:56:18.237Z", occurredOn: "2026-09-26", type: "question", content: "测试后台生成", tags: [], relatedTo: null },
    { id: "markdown-question", createdAt: "2026-09-26T15:30:00.000Z", occurredOn: "2026-09-26", type: "question", content: "历史**问题**", tags: [], relatedTo: null },
    { id: "context-answer", createdAt: "2026-09-26T15:01:00.000Z", occurredOn: "2026-09-26", type: "answer", content: "前段**加粗内容**后段", reasoningContent: "DO_NOT_LEAK_REASONING", tags: [], relatedTo: "context-question" },
    { id: "context-question", createdAt: "2026-09-26T15:00:00.000Z", occurredOn: "2026-09-26", type: "question", content: "历史问题", tags: [], relatedTo: null }
  ],
  chats: [], books: [{ id: "legacy-book", createdAt: "2026-09-26T15:00:00.000Z", title: "旧书", notes: [{ id: "legacy-note", createdAt: "2026-09-26T15:10:11.000Z", content: "旧笔记" }] }], quotes: [], experiments: [], analyses: [], customMetrics: []
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
  apiKey: "test-key"
}, null, 2)}\n`);

const app = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, TZ: "Asia/Shanghai", PORT: String(appPort), DATA_DIR: dataDir, DEEPSEEK_API_URL: `http://127.0.0.1:${mockPort}/chat/completions` },
  stdio: ["ignore", "pipe", "pipe"]
});
let appError = "";
app.stderr.on("data", chunk => { appError += chunk; });

try {
  const base = `http://127.0.0.1:${appPort}`;
  const addHighlight = (type, id, targetKey, quote, start = 0) => fetch(`${base}/api/annotations/${type}/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "highlight", targetKey, start, end: start + quote.length, quote, text: "" })
  });
  const migrated = await waitForServer(base, app);
  assert.equal(migrated.version, 12);
  assert.deepEqual(migrated.dailyRecords, []);
  assert.deepEqual(migrated.captures, []);
  assert.deepEqual(migrated.journals, []);
  assert.deepEqual(migrated.keepsakes, []);
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
    answeredRoots30: migrated.insights.weekly.answeredRoots30,
    closureRate30: migrated.insights.weekly.closureRate30,
    correctionActions30: migrated.insights.weekly.correctionActions30,
    reviewAgeDays: migrated.insights.weekly.reviewAgeDays,
    analysisCount: migrated.insights.weekly.analysisCount
  }, {
    activeDays7: 2,
    pairedDays30: 0,
    rootCount30: 3,
    answeredRoots30: 1,
    closureRate30: 33,
    correctionActions30: 0,
    reviewAgeDays: null,
    analysisCount: 0
  });
  assert.equal((await fs.readdir(dataDir)).some(name => name.includes("v3-pre-v12") && name.endsWith(".bak")), true);
  const migratedSettings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(migratedSettings.version, 4);
  assert.deepEqual(Object.keys(migratedSettings.profiles), ["lite", "mid", "high", "ultra"]);
  assert.deepEqual(migratedSettings.scenarios, {
    thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high",
    diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra",
    annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid"
  });
  const storedSettings = JSON.parse(await fs.readFile(path.join(dataDir, "llm-settings.json"), "utf8"));
  assert.equal(storedSettings.version, 4);
  assert.equal(storedSettings.apiKey, "test-key");
  assert.equal((await fs.readdir(dataDir)).some(name => name.includes("v2-pre-v4") && name.endsWith(".bak")), true);

  const profileSettings = {
    profiles: {
      lite: { model: "deepseek-flash", effort: "none" },
      mid: { model: "deepseek-flash", effort: "high" },
      high: { model: "deepseek-v4-pro", effort: "high" },
      ultra: { model: "deepseek-v4-pro", effort: "max" }
    },
    scenarios: {
      thoughtDraft: "high", thoughtAnswer: "ultra", followUpAnswer: "ultra", chat: "high",
      diaryLead: "lite", diaryStructure: "mid", diaryTopic: "high", diaryReflection: "ultra",
      annotationShenji: "high", analysis: "ultra", bookRecognition: "mid", healthRecognition: "mid"
    },
    apiKey: ""
  };
  const savedSettings = await (await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profileSettings)
  })).json();
  assert.equal(savedSettings.scenarios.diaryTopic, "high");
  assert.equal(savedSettings.hasApiKey, true);

  for (const mode of ["lead", "structure", "topic"]) {
    const response = await fetch(`${base}/api/journals/assist`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ mode, occurredAt: "2026-09-27T08:00:00", title: "今天", content: "我已经写下的文字。" })
    });
    const assistEvents = await readEvents(response);
    assert.equal(assistEvents.at(-1).result.mode, mode);
    assert.equal(assistEvents.at(-1).result.content, "**结论**：流式回答已完成。");
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
  for (const request of assistRequests) assert.match(JSON.stringify(request.messages), /我已经写下的文字/);

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

  const createdJournal = await (await fetch(`${base}/api/journals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T21:22:23", title: "测试日记", content: "今天发生了一件事，我还在分辨事实和解释。", tags: ["复盘"] })
  })).json();
  assert.equal(createdJournal.occurredAt, "2026-09-27T13:22:23.000Z");
  const journalCreatedAt = createdJournal.createdAt;
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
    body: JSON.stringify({ question: "测试流式顺序", idea: "" })
  });
  const events = await readEvents(draftResponse);
  const types = events.map(event => event.type);
  assert.ok(types.indexOf("reasoning") >= 0);
  assert.ok(types.indexOf("content") > types.lastIndexOf("reasoning"));
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.draft, "流式回答已完成。");
  assert.equal(events.at(-1).result.reasoningContent, "先核对问题。再形成判断。");
  const draftRequest = modelRequests.at(-1);
  assert.deepEqual([draftRequest.model, draftRequest.reasoning_effort], ["deepseek-v4-pro", "high"]);
  assert.match(draftRequest.messages[0].content, /250～450/);
  assert.match(draftRequest.messages[0].content, /哲学、价值、意义/);
  assert.match(draftRequest.messages[0].content, /禁止用“核心判断”/);
  assert.match(draftRequest.messages.at(-1).content, /不能因此回避给观点/);

  const answerResponse = await fetch(`${base}/api/thoughts/question-1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: "{}"
  });
  const reader = answerResponse.body.getReader(), decoder = new TextDecoder();
  let partial = "";
  while (!partial.includes('"type":"reasoning"')) partial += decoder.decode((await reader.read()).value, { stream: true });
  await reader.cancel();
  await sleep(500);
  const persisted = await (await fetch(`${base}/api/state`)).json();
  const answer = persisted.thoughts.find(item => item.relatedTo === "question-1" && item.type === "answer");
  assert.equal(answer?.content, "流式回答已完成。");
  assert.equal(answer?.reasoningContent, "先核对问题。再形成判断。");
  assert.equal(answer?.occurredOn, "2026-09-27");
  assert.equal(answer?.occurredAt, persisted.thoughts.find(item => item.id === "question-1").occurredAt);
  const answerRequest = modelRequests.at(-1);
  assert.deepEqual([answerRequest.model, answerRequest.reasoning_effort], ["deepseek-v4-pro", "max"]);
  assert.match(answerRequest.messages[0].content, /禁止用“核心判断”/);
  assert.match(answerRequest.messages[0].content, /500～900/);
  assert.match(answerRequest.messages.at(-1).content, /哲学或抽象主题先补足/);
  assert.equal((await addHighlight("thought", "question-1", "question:question-1", "测试")).status, 201);

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
  const shenjiResponse = await fetch(`${base}/api/annotations/analysis/${firstAnalysis.id}/${analysisAnnotation.id}/shenji`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "这条复盘判断可能遗漏了什么？" })
  });
  assert.equal(shenjiResponse.status, 201);
  assert.equal((await shenjiResponse.json()).answer, "同步回答");
  const analysisAfterAnnotation = (await (await fetch(`${base}/api/state`)).json()).analyses.find(item => item.id === firstAnalysis.id);
  assert.equal(analysisAfterAnnotation.annotations[0].text, "需要核对这条总判断的反证。");
  assert.equal(analysisAfterAnnotation.annotations[0].shenji[0].reasoningContent, "同步模型思考");
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /认知复盘/);
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /这条复盘判断可能遗漏了什么/);
  assert.match(modelRequests.at(-1).messages[0].content, /第一段直接判断标记内容/);

  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const uploadedCoverResponse = await fetch(`${base}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: pixel })
  });
  assert.equal(uploadedCoverResponse.status, 201);
  const uploadedCover = await uploadedCoverResponse.json();
  assert.match(uploadedCover.attachmentPath, /^\/attachments\/.+\.png$/);

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
  assert.equal(bookAfterDelete.annotationDrift.some(item => item.originalTargetKey === `note:${note.id}`), true);

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
  const parsedSleep = await parsedSleepResponse.json();
  assert.equal(parsedSleep.totalMinutes, 462);
  assert.equal(parsedSleep.deepPercent, 29);
  assert.equal(parsedSleep.awakeMinutes, null);
  assert.equal(parsedSleep.attachmentPaths.length, 2);
  const sleepModelRequest = modelRequests.at(-1);
  assert.equal(sleepModelRequest.model, "deepseek-flash");
  assert.equal(sleepModelRequest.messages.at(-1).content.filter(item => item.type === "image_url").length, 2);

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

  const segmented = await (await fetch(`${base}/api/keepsakes/segment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: pixel })
  })).json();
  assert.equal(segmented.suggestedTitle, "测试票券");
  assert.equal(segmented.includeHand, true);
  assert.deepEqual(segmented.polygons[0][0], [120, 90]);
  const keepsake = await (await fetch(`${base}/api/keepsakes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T10:20:30", title: "展览票券", category: "纸品", note: "测试留存", originalPath: "/attachments/original.png", cutoutPath: "/attachments/cutout.png", source: "auto", edgeExpansion: 8 })
  })).json();
  assert.equal(keepsake.occurredOn, "2026-09-27");
  assert.equal(keepsake.source, "auto");
  const keepsakeCreatedAt = keepsake.createdAt;
  const editedKeepsake = await (await fetch(`${base}/api/keepsakes/${keepsake.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ occurredAt: "2026-09-27T11:22:33", title: "修改后的票券", category: "其他", note: "", originalPath: keepsake.originalPath, cutoutPath: keepsake.cutoutPath, source: "manual", edgeExpansion: 5 })
  })).json();
  assert.equal(editedKeepsake.createdAt, keepsakeCreatedAt);
  assert.equal(editedKeepsake.title, "修改后的票券");
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

  assert.equal((await fetch(`${base}/api/captures/${createdCapture.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/journals/${createdJournal.id}`, { method: "DELETE" })).status, 200);

  const midnight = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(new Date("2026-09-26T16:56:18.237Z"));
  assert.equal(midnight, "00:56:18");
  console.log("Regression checks passed: v12 keepsakes, quote tags, daily records, shared image parsing, local dates, and reasoning isolation.");
} finally {
  app.kill("SIGTERM");
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}

if (appError) process.stderr.write(appError);
