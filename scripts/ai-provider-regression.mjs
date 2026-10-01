import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./prompt-test-setup.mjs";
import { createDeepSeekTransport } from "../src/infrastructure/ai-providers/index.mjs";
import { createAiGenerator, createAiAudit, createAiUsageService, normalizeLlmSettings } from "../src/modules/ai/index.mjs";

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
assert.equal(await run("retry", () => generate("短辅助", { retryWithoutThinking: true })), "重试回答");
assert.equal(attempt, 2);
assert.deepEqual(transportCalls.slice(-2).map(call => call.body.thinking.type), ["enabled", "disabled"]);
assert.deepEqual(accounts.get("retry").entries.map(entry => [entry.status, entry.retryScheduled]), [["failed", true], ["success", false]]);
assert.equal(new Set(accounts.get("retry").entries.map(entry => entry.callGroupId)).size, 1);
assert.equal(new Set(accounts.get("retry").entries.map(entry => entry.callId)).size, 2);
assert.equal(active, 0);
responseFactory = () => jsonResponse("", "stop");
attempt = transportCalls.length;
await assert.rejects(run("once", () => generate("只调用一次")), { code: "EMPTY_DEEPSEEK_CONTENT" });
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
  assert.equal(terminalAudit.schemaVersion, 2);
  assert.equal(terminalAudit.traceId, `trace-${id}`);
  assert.equal(terminalAudit.request.userPrompt, `account-${id}`);
  assert.equal(terminalAudit.request.promptCatalog.version, "2026.10.01.1");
  assert.match(terminalAudit.request.promptCatalog.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(terminalAudit.request.contextReceipt, startedAudit.request.contextReceipt);
  assert.equal(terminalAudit.request.contextReceipt.sources[0].resourceId, `source-${id}`);
}

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
console.log("AI provider checks passed: JSON/SSE contracts, byte fragmentation, partial failures, retry accounting/limits, capacity release, timeout, account context and image audit isolation.");
