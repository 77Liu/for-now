import { createRateGate } from "../src/shared/concurrency/index.mjs";
import { createAiBudgetRuntime } from "../src/app/index.mjs";
import { createAiBudgetService } from "../src/modules/ai/index.mjs";
import { createAtomicRepository } from "./fixtures/atomic-json-repository.mjs";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./prompt-test-setup.mjs";
import { createDeepSeekTransport } from "../src/infrastructure/ai-providers/index.mjs";
import {
  conservativeDeepSeekInputTokenUpperBound,
  createAiGenerator,
  createAiAudit,
  createAiUsageService,
  normalizeLlmSettings,
  llmSettingsForScene
} from "../src/modules/ai/index.mjs";

const promptManifest = JSON.parse(await fs.readFile(
  new URL("../prompts/manifest.json", import.meta.url),
  "utf8"
));
const activePromptVersion = promptManifest.versions.find(item => (
  item.version === promptManifest.activeVersion
));
assert.ok(activePromptVersion, "the active prompt version must exist in the catalog");

const usage = { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } };
const jsonResponse = (content = "回答", finish = "stop") => new Response(JSON.stringify({
  id: "body-id", model: "deepseek-v4-pro", created: 1790643600, system_fingerprint: "fingerprint", usage,
  choices: [{ message: { content, reasoning_content: "思考" }, finish_reason: finish }]
}), { headers: { "x-request-id": "header-id" } });
const sseResponse = text => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      // Deliberately split each UTF-8 character and the CRLF/data framing.
      for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.slice(index, index + 1));
      controller.close();
    }
  }), { headers: { "x-request-id": "header-id" } });
};
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const reasoning = event({ id: "stream-id", choices: [{ delta: { reasoning_content: "思考" } }] });
const answer = event({ choices: [{ delta: { content: "回答" } }] });
const terminal = finish => event({ choices: [{ delta: {}, finish_reason: finish }], usage });
let responseFactory = () => jsonResponse(), transportCalls = [];
const provider = createDeepSeekTransport({
  endpoint: "https://provider.invalid/chat/completions",
  fetchImpl: async (endpoint, options) => { transportCalls.push({ endpoint, ...options, body: JSON.parse(options.body) }); return responseFactory(options); }
});
const params = { apiKey: "private-test-key", parameters: { model: "deepseek-v4-pro" }, messages: [], signal: new AbortController().signal };
const json = await provider.complete(params);
assert.equal(json.content, "回答");
assert.equal(json.providerRequestId, "body-id");
assert.equal(json.httpStatus, 200);
assert.deepEqual(json.usage, usage);
const deltas = [];
responseFactory = () => sseResponse(`: keepalive\r\n${reasoning}${answer}${terminal("stop")}data: [DONE]\r\n\r\n`);
const stream = await provider.complete({ ...params, onDelta: delta => deltas.push(delta) });
assert.equal(stream.content, json.content);
assert.equal(stream.reasoningContent, json.reasoningContent);
assert.equal(stream.providerRequestId, "header-id");
assert.deepEqual(deltas, [{ type: "reasoning", delta: "思考" }, { type: "content", delta: "回答" }]);
assert.deepEqual(stream.usage, usage);
for (const [text, code, partial] of [
  [reasoning + answer, "INCOMPLETE_STREAM", "回答"],
  [reasoning + answer + "data: {bad}\n", "INVALID_STREAM", "回答"],
  [reasoning + terminal("stop"), "EMPTY_DEEPSEEK_CONTENT", ""],
  [reasoning + answer + terminal("length"), "LENGTH_LIMIT", "回答"],
  [reasoning + terminal("content_filter"), "CONTENT_FILTER", ""],
  [reasoning + answer + event({ error: { code: "PROVIDER_STREAM_FAIL", message: "private provider detail" } }), "PROVIDER_STREAM_FAIL", "回答"]
]) {
  responseFactory = () => sseResponse(text);
  await assert.rejects(provider.complete({ ...params, onDelta() {} }), error => {
    assert.equal(error.code, code); assert.equal(error.partialContent, partial);
    assert.equal(error.partialReasoningContent, "思考"); assert.equal(error.httpStatus, 200);
    return true;
  });
}
for (const [content, finish, code] of [["", "length", "EMPTY_DEEPSEEK_CONTENT"], ["回答", "length", "LENGTH_LIMIT"], ["", "content_filter", "CONTENT_FILTER"]]) {
  responseFactory = () => jsonResponse(content, finish);
  await assert.rejects(provider.complete(params), error => {
    assert.equal(error.code, code); assert.deepEqual(error.usage, usage);
    assert.equal(error.partialReasoningContent, "思考"); assert.equal(error.providerRequestId, "body-id");
    return true;
  });
}
responseFactory = () => new Response(JSON.stringify({ error: { code: "RATE_LIMIT", message: "private provider detail" } }), { status: 429 });
await assert.rejects(provider.complete(params), error => error.httpStatus === 429 && error.code === "RATE_LIMIT" && !error.message.includes("private provider detail"));

const context = new AsyncLocalStorage(), accounts = new Map(), auditRecords = [];
const ledger = () => accounts.get(context.getStore().user.id);
const quota = createAiUsageService({
  repository: { read: async () => ledger(), update: async mutate => mutate(ledger()) },
  getAccountKey: () => context.getStore().user.id, dailyCallLimit: 10, dailyCostLimitCny: 100, cnyPerUsd: 7.2
});
const audit = createAiAudit({
  textLimit: 10000, getContext: () => context.getStore(), updateUsage: quota.update,
  append: async (day, entry) => auditRecords.push(entry), logEvent: async () => {}
});
let active = 0, capacityFails = false;
const gate = { acquire: async () => {
  if (capacityFails) throw new Error("capacity unavailable");
  active += 1; return () => { active -= 1; };
} };
const settings = normalizeLlmSettings({ apiKey: "private-test-key" });
const generate = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, gate, audit });
const run = (id, callback) => {
  if (!accounts.has(id)) accounts.set(id, { entries: [] });
  return context.run({ user: { id }, traceId: `trace-${id}`, secrets: [] }, callback);
};
let attempt = 0;
responseFactory = () => jsonResponse(attempt++ ? "重试回答" : "", attempt === 1 ? "length" : "stop");
assert.equal(await run("retry", () => generate("合成思绪问题", { scene: "thoughtAnswer" })), "重试回答");
assert.equal(attempt, 2);
assert.deepEqual(transportCalls.slice(-2).map(call => call.body.thinking.type), ["enabled", "disabled"]);
assert.deepEqual(accounts.get("retry").entries.map(entry => [entry.status, entry.retryScheduled]), [["failed", true], ["success", false]]);
assert.equal(new Set(accounts.get("retry").entries.map(entry => entry.callGroupId)).size, 1);
assert.equal(new Set(accounts.get("retry").entries.map(entry => entry.callId)).size, 2);
assert.equal(active, 0);

// 精确复现已观察到的空答响应形态：HTTP 200、length、仅思考正文。
let extractionAttempts = 0;
responseFactory = () => {
  const first = extractionAttempts++ === 0;
  return new Response(JSON.stringify({
    model: "deepseek-flash", usage,
    choices: [{ message: {
      content: first ? "" : '{"claims":[],"unknowns":[]}',
      reasoning_content: first ? "思".repeat(6809) : ""
    }, finish_reason: first ? "length" : "stop" }]
  }));
};
assert.equal(await run("extraction-retry", () => generate("合成五问原文", {
  scene: "onboardingClaimExtraction", json: true, maxTokens: 4000, retryWithoutThinking: true
})), '{"claims":[],"unknowns":[]}');
assert.equal(extractionAttempts, 2);
assert.deepEqual(transportCalls.slice(-2).map(call => call.body.thinking.type), ["enabled", "disabled"]);
assert.deepEqual(accounts.get("extraction-retry").entries.map(entry => entry.status), ["failed", "success"]);
assert.equal(accounts.get("extraction-retry").entries.every(entry => entry.maxAttempts === 2), true);

let compressionGateHeld = false, compressionGateAcquisitions = 0, compressionGateReleases = 0;
const compressionGate = {
  async acquire() {
    assert.equal(compressionGateHeld, false, "a compression slot cannot be acquired twice");
    compressionGateHeld = true;
    compressionGateAcquisitions += 1;
    return () => {
      compressionGateHeld = false;
      compressionGateReleases += 1;
    };
  }
};
const compressionAwareGenerate = createAiGenerator({
  provider,
  readSettings: async () => settings,
  getContext: () => context.getStore(),
  reserveAttempt: quota.reserveAttempt,
  gate: {
    async acquire() {
      assert.equal(compressionGateHeld, true,
        "the compression slot must be held before entering the shared AI queue");
      return () => {};
    }
  },
  sceneGates: { recordCompression: compressionGate },
  audit
});
responseFactory = () => jsonResponse("压缩完成");
assert.equal(await run("compression-gate", () => compressionAwareGenerate("日压缩合成输入", {
  scene: "recordCompression",
  retryWithoutThinking: false
})), "压缩完成");
assert.equal(compressionGateAcquisitions, 1);
assert.equal(compressionGateReleases, 1);
assert.equal(compressionGateHeld, false);
const callsBeforeStaleGate = transportCalls.length;
await assert.rejects(run("compression-gate-stale", () => compressionAwareGenerate("已撤权的合成输入", {
  scene: "recordCompression",
  retryWithoutThinking: false,
  isCurrent: async () => false
})), { code: "AI_TASK_STALE" });
assert.equal(transportCalls.length, callsBeforeStaleGate,
  "inputs that change while waiting for a provider slot must not be sent");
assert.equal(compressionGateAcquisitions, 2);
assert.equal(compressionGateReleases, 2);
assert.equal(compressionGateHeld, false);

let compressionBudgetDetails;
const boundedCompressionGenerate = createAiGenerator({
  provider,
  readSettings: async () => settings,
  getContext: () => context.getStore(),
  reserveAttempt: quota.reserveAttempt,
  gate,
  audit,
  executeBudgetTask: async (details, execute) => {
    compressionBudgetDetails = details;
    return execute({ runStage: async (_id, operation) => operation({ recordUsage: () => false }) });
  }
});
responseFactory = () => jsonResponse("预算上界合成完成");
const unicodeCompressionPrompt = "中文🧭\u0000\u001f\ud800";
await run("compression-token-bound", () => boundedCompressionGenerate(unicodeCompressionPrompt, {
  scene: "recordCompression",
  retryWithoutThinking: false,
  history: [{ role: "user", content: "多字节历史 e\u0301" }]
}));
const compressionRequestMessages = transportCalls.at(-1).body.messages;
assert.equal(compressionBudgetDetails.scene, "recordCompression");
assert.equal(compressionBudgetDetails.maxInputTokens,
  conservativeDeepSeekInputTokenUpperBound(compressionRequestMessages),
  "record compression must pass the escaped UTF-8 upper bound to budget estimation");

function queuedGate() {
  let held = false;
  let acquisitionCount = 0;
  const queued = [];
  const acquisitionListeners = [];
  const release = () => {
    const next = queued.shift();
    if (next) next(makeRelease());
    else held = false;
  };
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  return {
    get acquisitionCount() { return acquisitionCount; },
    waitForAcquisitions(count) {
      if (acquisitionCount >= count) return Promise.resolve();
      return new Promise(resolve => acquisitionListeners.push({ count, resolve }));
    },
    async acquire() {
      acquisitionCount += 1;
      for (let index = acquisitionListeners.length - 1; index >= 0; index -= 1) {
        if (acquisitionListeners[index].count <= acquisitionCount) {
          acquisitionListeners.splice(index, 1)[0].resolve();
        }
      }
      if (!held) {
        held = true;
        return makeRelease();
      }
      return new Promise(resolve => queued.push(resolve));
    }
  };
}

const heldSceneGate = queuedGate();
const heldGlobalGate = queuedGate();
const releaseHeldScene = await heldSceneGate.acquire();
const releaseHeldGlobal = await heldGlobalGate.acquire();
const staleAfterGateGenerate = createAiGenerator({
  provider,
  readSettings: async () => settings,
  getContext: () => context.getStore(),
  reserveAttempt: quota.reserveAttempt,
  gate: heldGlobalGate,
  sceneGates: { recordCompression: heldSceneGate },
  audit
});
let sourceStillCurrent = true;
const isCurrent = async () => sourceStillCurrent;
const callsBeforePermissionChange = transportCalls.length;
const gatedAttempt = run("compression-gate-permission-race", async () => {
  assert.equal(await isCurrent(), true, "the task starts with a current source snapshot");
  return staleAfterGateGenerate("已撤权的合成输入", {
    scene: "recordCompression",
    retryWithoutThinking: false,
    isCurrent
  });
});
await heldSceneGate.waitForAcquisitions(2);
sourceStillCurrent = false;
releaseHeldScene();
await heldGlobalGate.waitForAcquisitions(2);
releaseHeldGlobal();
await assert.rejects(gatedAttempt, { code: "AI_TASK_STALE" });
assert.equal(transportCalls.length, callsBeforePermissionChange,
  "permission changes while waiting on scene/global gates must prevent the provider send");

// 同模型的 effort 更新也不能被旧 override 越过容量等待后的有效配置。
const importanceGate = queuedGate();
const releaseImportanceGate = await importanceGate.acquire();
const requestedImportanceChoice = llmSettingsForScene(settings, "importanceScoring");
const importanceGenerate = createAiGenerator({ provider, readSettings: async () => settings,
  getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, gate: importanceGate, audit });
const beforeImportanceSend = transportCalls.length;
const pendingImportance = run("importance-effective-config-race", () => importanceGenerate("合成评分材料", {
  scene: "importanceScoring", modelOverride: { model: requestedImportanceChoice.model, effort: requestedImportanceChoice.effort },
  retryWithoutThinking: false
}));
await importanceGate.waitForAcquisitions(2);
settings.sceneEfforts.importanceScoring = requestedImportanceChoice.effort === "none" ? "high" : "none";
releaseImportanceGate();
await assert.rejects(pendingImportance, { code: "AI_TASK_STALE" });
assert.equal(transportCalls.length, beforeImportanceSend);
settings.sceneEfforts.importanceScoring = requestedImportanceChoice.effort;

const siteBudgetExecutions = [];
const siteBudgetGenerate = createAiGenerator({
  provider,
  readSettings: async () => settings,
  getContext: () => context.getStore(),
  reserveAttempt: quota.reserveAttempt,
  gate,
  audit,
  executeBudgetTask: async (details, execute) => {
    const execution = { details, started: [], usage: [] };
    siteBudgetExecutions.push(execution);
    return execute({
      runStage: async (stageId, operation) => {
        execution.started.push(stageId);
        return operation({ recordUsage: entry => execution.usage.push(entry) });
      }
    });
  }
});
attempt = 0;
responseFactory = () => jsonResponse(attempt++ ? "预算重试回答" : "", attempt === 1 ? "length" : "stop");
assert.equal(await run("site-budget", () => siteBudgetGenerate("全链路预算", {
  retryWithoutThinking: true,
  maxTokens: 200
})), "预算重试回答");
assert.equal(siteBudgetExecutions.length, 1);
assert.equal(siteBudgetExecutions[0].details.maxAttempts, 2);
assert.equal(siteBudgetExecutions[0].details.maxOutputTokens, 200);
assert.deepEqual(siteBudgetExecutions[0].started, ["deepseek-attempt-1", "deepseek-attempt-2"]);
assert.equal(siteBudgetExecutions[0].usage.length, 2);
assert.ok(siteBudgetExecutions[0].usage.every(entry => entry.costKnown && entry.costCny > 0));

const rejectedBySiteBudget = Object.assign(new Error("site budget rejected"), {
  statusCode: 429,
  code: "AI_SITE_DAILY_COST_LIMIT"
});
const siteRejectedGenerate = createAiGenerator({
  provider,
  readSettings: async () => settings,
  getContext: () => context.getStore(),
  reserveAttempt: quota.reserveAttempt,
  gate,
  audit,
  executeBudgetTask: async () => { throw rejectedBySiteBudget; }
});
const callsBeforeSiteRejection = transportCalls.length;
await assert.rejects(
  run("site-rejected", () => siteRejectedGenerate("不应调用供应商")),
  error => error === rejectedBySiteBudget
);
assert.equal(transportCalls.length, callsBeforeSiteRejection);

responseFactory = () => jsonResponse("", "stop");
attempt = transportCalls.length;
await assert.rejects(run("once", () => generate("明确不重试", {
  scene: "thoughtAnswer", retryWithoutThinking: false
})), { code: "EMPTY_DEEPSEEK_CONTENT" });
assert.equal(transportCalls.length - attempt, 1);

const limited = createAiUsageService({ repository: { read: async () => ledger() }, getAccountKey: () => context.getStore().user.id, dailyCallLimit: 1, dailyCostLimitCny: 100, cnyPerUsd: 7.2 });
const limitedGenerate = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: limited.reserveAttempt, gate, audit });
attempt = transportCalls.length;
await assert.rejects(run("limited", () => limitedGenerate("重试也计额度", { retryWithoutThinking: true })), { code: "AI_DAILY_CALL_LIMIT" });
assert.equal(transportCalls.length - attempt, 1);
capacityFails = true;
await assert.rejects(run("release", () => limitedGenerate("容量失败")), /capacity unavailable/);
capacityFails = false;
responseFactory = () => jsonResponse();
assert.equal(await run("release", () => limitedGenerate("额度已释放")), "回答");

responseFactory = ({ signal }) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});
await assert.rejects(run("timeout", () => generate("超时", { timeoutMs: 20 })), /已停止/);
assert.equal(accounts.get("timeout").entries[0].status, "timeout");
assert.equal(active, 0);
const enteredCancellation = new Promise(resolve => {
  responseFactory = ({ signal }) => new Promise((done, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    resolve();
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
});
const externalController = new AbortController();
const cancelledCall = run("cancelled", () => generate("取消", { signal: externalController.signal }));
await enteredCancellation;
externalController.abort();
await assert.rejects(cancelledCall, { code: "AI_TASK_CANCELLED" });
assert.equal(accounts.get("cancelled").entries[0].status, "cancelled");
assert.equal(auditRecords.find(entry => entry.actor.userId === "cancelled" && entry.status === "cancelled").error.code, "AI_TASK_CANCELLED");
assert.equal(active, 0);
responseFactory = () => jsonResponse();
await Promise.all(["a", "b"].map(id => run(id, () => generate(`account-${id}`, {
  contextReceipt: {
    version: "receipt-v1",
    tokenBudget: { limit: 100, estimatedUsed: 20, remaining: 80, estimation: "test" },
    sources: [{ resourceId: `source-${id}` }]
  }
}))));
for (const id of ["a", "b"]) {
  assert.equal(accounts.get(id).entries.length, 1);
  const terminalAudit = auditRecords.find(entry => entry.actor.userId === id && entry.status === "success");
  const startedAudit = auditRecords.find(entry => entry.actor.userId === id && entry.status === "started");
  assert.equal(terminalAudit.schemaVersion, 4);
  assert.equal(terminalAudit.traceId, `trace-${id}`);
  assert.equal(terminalAudit.request.userPrompt, `account-${id}`);
  assert.equal(terminalAudit.request.promptCatalog.version, promptManifest.activeVersion);
  assert.equal(terminalAudit.request.promptCatalog.sha256, activePromptVersion.sha256);
  assert.deepEqual(terminalAudit.request.promptCatalog, startedAudit.request.promptCatalog);
  assert.deepEqual(terminalAudit.request.contextReceipt, startedAudit.request.contextReceipt);
  assert.equal(terminalAudit.request.contextReceipt.sources[0].resourceId, `source-${id}`);
}
await run("private-prompt", () => generate("PRIVATE_ONBOARDING_SOURCE", {
  scene: "onboardingClaimExtraction",
  json: true
}));
const privateAudits = auditRecords.filter(entry => entry.actor.userId === "private-prompt");
assert.ok(privateAudits.length >= 2);
assert.ok(privateAudits.every(entry => entry.request.userPrompt === "PRIVATE_ONBOARDING_SOURCE"));
assert.ok(privateAudits.every(entry => (
  entry.invocationContract.triggerType === "system_internal"
  && entry.invocationContract.resultAudience === "internal"
  && entry.invocationContract.reasoningVisibility === "privileged_only"
  && entry.invocationContract.persistenceMode === "audit_only"
)));

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-provider-"));
try {
  const file = path.join(directory, "one.png");
  await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tm5EAAAAASUVORK5CYII=", "base64"));
  await run("vision", () => generate("识图", { imagePath: file, json: true }));
  const call = transportCalls.at(-1).body, entry = accounts.get("vision").entries[0];
  assert.equal(call.model, "deepseek-flash");
  assert.deepEqual(call.response_format, { type: "json_object" });
  assert.equal(call.messages.at(-1).content[1].type, "image_url");
  assert.deepEqual(entry.imageDimensions, [{ width: 1, height: 1 }]);
  assert.equal(entry.modality, "vision");
  assert.doesNotMatch(JSON.stringify(auditRecords), /iVBORw0KGgo|private-test-key/);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
// F5真实generator/usage/audit/gate链：等待终止不得依赖占用者，且不产生外部调用或收费记录。
{
  const queue = { enabled: true, maxOutstanding: 2, maxOutstandingPerAccount: 1, maxPendingPerGate: 2, maxQueueWaitMs: 40, overloadRetryAfterMs: 5000 };
  const held = createRateGate(10000, 1, { maxPending: 2 }); const release = await held.acquire();
  let entered;
  const acquired = new Promise(resolve => { entered = resolve; });
  const cancellable = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, gate: { acquire: options => { entered(); return held.acquire(options); } }, audit, aiQueue: queue });
  const controller = new AbortController(); const calls = transportCalls.length;
  const waiting = run("f5-cancelled-queue", () => cancellable("排队取消", { signal: controller.signal, retryWithoutThinking: false }));
  await acquired; controller.abort();
  await assert.rejects(waiting, { code: "AI_TASK_CANCELLED", statusCode: 409 });
  await assert.rejects(run("f5-expired-queue", () => cancellable("排队到期", { retryWithoutThinking: false })), { code: "AI_QUEUE_TIMEOUT", statusCode: 504 });
  assert.equal(transportCalls.length, calls); assert.equal(accounts.get("f5-cancelled-queue").entries.length, 0);
  assert.equal(auditRecords.some(entry => entry.actor?.userId === "f5-cancelled-queue"), false);
  release(); responseFactory = () => jsonResponse();
  assert.equal(await run("f5-cancelled-queue", () => cancellable("取消后额度已释放", { retryWithoutThinking: false })), "回答");
  const scene = createRateGate(10000, 1), global = createRateGate(10000, 1);
  const releaseScene = await scene.acquire(), releaseGlobal = await global.acquire(); const deadlines = [];
  const shared = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, audit, aiQueue: queue,
    sceneGates: { recordCompression: { acquire: options => { deadlines.push(options.deadline); return scene.acquire(options); } } },
    gate: { acquire: options => { deadlines.push(options.deadline); return global.acquire(options); } } });
  const sharedWaiting = run("f5-shared-deadline", () => shared("两层同一截止", { scene: "recordCompression", retryWithoutThinking: false }));
  setTimeout(releaseScene, 10);
  await assert.rejects(sharedWaiting, { code: "AI_QUEUE_TIMEOUT" }); assert.equal(deadlines.length, 2); assert.equal(deadlines[0], deadlines[1]); releaseGlobal();
  let releasePreparation; const preparing = new Promise(resolve => { releasePreparation = resolve; }); let reads = 0;
  const bounded = createAiGenerator({ provider, readSettings: async () => { reads++; await preparing; return settings; }, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, gate, audit, aiQueue: queue });
  const a = new AbortController(), b = new AbortController();
  const first = run("f5-limit-a", () => bounded("准备中", { signal: a.signal })); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(run("f5-limit-a", () => bounded("账户超载")), { code: "AI_QUEUE_FULL", retryAfterMs: 5000 });
  const second = run("f5-limit-b", () => bounded("准备中", { signal: b.signal })); await new Promise(resolve => setImmediate(resolve));
  a.abort(); b.abort();
  await assert.rejects(run("f5-limit-c", () => bounded("清理未结束仍占名额")), { code: "AI_QUEUE_FULL" }); assert.equal(reads, 2);
  releasePreparation(); await Promise.all([assert.rejects(first, { code: "AI_TASK_CANCELLED" }), assert.rejects(second, { code: "AI_TASK_CANCELLED" })]);
  assert.equal(await run("f5-limit-c", () => bounded("名额已回收", { retryWithoutThinking: false })), "回答");
  // 子生成器只能证明/清理自己的stage，不能释放父execution其余阶段。
  const repository = createAtomicRepository({}); let sequence = 0;
  const budget = createAiBudgetService({ repository, createId: () => `f5-parent-${++sequence}`, now: () => "2026-10-16T01:00:00.000Z" });
  const runtime = createAiBudgetRuntime({ budget }); const abort = new AbortController(); let currentChecks = 0;
  const child = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, gate, audit, aiQueue: queue });
  const parentStages = ["other", "text"].map(id => ({ id, provider: "deepseek", service: "chat-completions", scene: "thoughtAnswer", costKnown: true, estimatedCostCny: 0.1 }));
  await run("f5-parent", () => runtime.executeTask({ accountId: "f5-parent", taskId: "parent", stages: parentStages }, async execution => {
    await execution.runStage("other", ({ recordUsage }) => { recordUsage({ costKnown: true, costCny: 0.02 }); });
    const before = transportCalls.length;
    await assert.rejects(child("阶段已进入但provider未发", { budgetExecution: execution, budgetStageIds: ["text"], retryWithoutThinking: false, signal: abort.signal, isCurrent: async () => { if (++currentChecks === 2) abort.abort(); return true; } }), { code: "AI_TASK_CANCELLED" });
    assert.equal(transportCalls.length, before); assert.equal(accounts.get("f5-parent").entries.length, 0);
    const pending = await budget.read(); assert.equal(pending.reservations.length, 1); assert.equal(pending.reservations[0].stages.find(stage => stage.id === "text").dispatchState, "not_invoked");
  }));
  const settled = await budget.read(); assert.equal(settled.reservations.length, 0); assert.equal(settled.days[0].knownCostMicros, 20000);
  assert.ok(auditRecords.some(entry => entry.actor?.userId === "f5-parent" && entry.dispatchState === "not_invoked" && entry.persistence.usage === "not_applicable"));
}

// 首个full/stale发生后，必要预算清理仍等待真实完成；后到timeout/cancel不能改写原429/409。
for (const code of ["AI_QUEUE_FULL", "AI_TASK_STALE"]) {
  let releaseCleanup, enteredCleanup;
  const cleanupStarted = new Promise(resolve => { enteredCleanup = resolve; });
  const cleanupDone = new Promise(resolve => { releaseCleanup = resolve; });
  const repository = createAtomicRepository({}); let sequence = 0;
  const budget = createAiBudgetService({ repository, createId: () => `first-${code}-${++sequence}` });
  const delayed = { ...budget, releaseTask: async input => { enteredCleanup(); await cleanupDone; return budget.releaseTask(input); } };
  const runtime = createAiBudgetRuntime({ budget: delayed }); const abort = new AbortController();
  const first = createAiGenerator({ provider, readSettings: async () => settings, getContext: () => context.getStore(), reserveAttempt: quota.reserveAttempt, audit,
    gate: code === "AI_QUEUE_FULL" ? { acquire: async () => { throw Object.assign(new Error("队列繁忙"), { code, statusCode: 429 }); } } : gate,
    executeBudgetTask: (details, execute, options) => runtime.executeTask({ accountId: details.accountId, taskId: details.taskId, stages: [{ id: "deepseek-attempt-1", provider: "deepseek", service: "chat-completions", scene: "thoughtAnswer", costKnown: true, estimatedCostCny: 0.01 }] }, execute, options) });
  const pending = run(`f5-first-${code}`, () => first("首因保持", { timeoutMs: code === "AI_QUEUE_FULL" ? 20 : 1000, signal: abort.signal, retryWithoutThinking: false, isCurrent: async () => code !== "AI_TASK_STALE" }));
  await cleanupStarted;
  if (code === "AI_QUEUE_FULL") await new Promise(resolve => setTimeout(resolve, 30)); else abort.abort();
  releaseCleanup(); await assert.rejects(pending, { code, statusCode: code === "AI_QUEUE_FULL" ? 429 : 409 });
  assert.equal((await budget.read()).reservations.length, 0);
}

console.log("AI provider checks passed: JSON/SSE contracts, byte fragmentation, partial failures, retry accounting/limits, capacity release, timeout, account context and image audit isolation.");
