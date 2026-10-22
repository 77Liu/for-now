import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAuthenticatedJsonRuntime } from "../.build/typescript/backend/shared/testing/authenticated-runtime.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function integerSetting(name, fallback, minimum = 1, maximum = 10000) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
}

const config = {
  concurrency: integerSetting("LOAD_CONCURRENCY", 20, 1, 200),
  readRequests: integerSetting("LOAD_READ_REQUESTS", 200, 1, 10000),
  writeRequests: integerSetting("LOAD_WRITE_REQUESTS", 80, 1, 2000),
  mixedRequests: integerSetting("LOAD_MIXED_REQUESTS", 160, 1, 10000),
  aiTasks: integerSetting("LOAD_AI_TASKS", 24, 1, 200),
  readP95Ms: integerSetting("LOAD_READ_P95_MS", 500, 1, 60000),
  writeP95Ms: integerSetting("LOAD_WRITE_P95_MS", 500, 1, 60000),
  mixedP95Ms: integerSetting("LOAD_MIXED_P95_MS", 750, 1, 60000),
  aiTaskP95Ms: integerSetting("LOAD_AI_TASK_P95_MS", 2000, 1, 120000)
};

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`压测服务提前退出：${child.exitCode}\n${stderr()}`);
    try {
      if ((await fetch(`${base}/readyz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`压测服务启动超时\n${stderr()}`);
}

async function runPool(count, concurrency, operation) {
  const results = new Array(count);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      results[index] = await operation(index);
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] || 0;
}

function metrics(samples, elapsedMs) {
  const latencies = samples.map(sample => sample.durationMs);
  return {
    requests: samples.length,
    failures: samples.filter(sample => !sample.ok).length,
    requestsPerSecond: Number((samples.length / Math.max(elapsedMs / 1000, 0.001)).toFixed(1)),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...latencies, 0).toFixed(1))
  };
}

async function timedRequest(url, options, expectedStatus = 200) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, options);
    const body = await response.arrayBuffer();
    return { ok: response.status === expectedStatus, status: response.status, bytes: body.byteLength, durationMs: performance.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, bytes: 0, durationMs: performance.now() - startedAt, error: error.message };
  }
}

function assertPhase(name, result, thresholdMs) {
  assert.equal(result.failures, 0, `${name} 出现 ${result.failures} 个失败请求`);
  assert.ok(result.p95Ms <= thresholdMs, `${name} P95 ${result.p95Ms}ms 超过阈值 ${thresholdMs}ms`);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-load-"));
const appPort = await freePort();
const providerPort = await freePort();
let providerCalls = 0;
let providerActive = 0;
let providerPeak = 0;
const provider = http.createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  providerCalls += 1;
  providerActive += 1;
  providerPeak = Math.max(providerPeak, providerActive);
  await sleep(50);
  providerActive -= 1;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `load-provider-${providerCalls}`,
    model: "deepseek-flash",
    choices: [{
      message: {
        content: JSON.stringify({ answer: "隔离压测回答", citations: [] })
      },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 120, completion_tokens: 20 }
  }));
});
await new Promise((resolve, reject) => provider.once("error", reject).listen(providerPort, "127.0.0.1", resolve));
const authFixture = await installAuthenticatedJsonRuntime(dataDir);

let stderr = "";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    DATA_DIR: dataDir,
    ...authFixture.env,
    UPSTREAM_ORIGIN: "",
    DEEPSEEK_API_URL: `http://127.0.0.1:${providerPort}/chat/completions`,
    AI_GLOBAL_QPS: "100",
    AI_GLOBAL_CONCURRENCY: "8",
    AI_USER_DAILY_CALL_LIMIT: String(config.aiTasks + 20),
    AI_USER_DAILY_COST_LIMIT_CNY: "1000"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
child.stderr.on("data", chunk => { stderr += chunk; });

const base = `http://127.0.0.1:${appPort}`;
const systemFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const target = String(input instanceof Request ? input.url : input);
  if (!target.startsWith(base)) return systemFetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", authFixture.cookie);
  return systemFetch(input, { ...init, headers });
};
const jsonHeaders = { "content-type": "application/json" };
const report = { config, phases: {}, provider: {} };

try {
  await waitForServer(base, child, () => stderr);
  const settings = await fetch(`${base}/api/settings`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ apiKey: "load-test-key" }) });
  assert.equal(settings.status, 200);
  await runPool(10, 5, () => timedRequest(`${base}/api/state`, {}, 200));

  let startedAt = performance.now();
  const reads = await runPool(config.readRequests, config.concurrency, () => timedRequest(`${base}/api/state`, {}, 200));
  report.phases.read = metrics(reads, performance.now() - startedAt);
  assertPhase("并发读取", report.phases.read, config.readP95Ms);

  startedAt = performance.now();
  const writes = await runPool(config.writeRequests, config.concurrency, index => timedRequest(`${base}/api/captures`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ occurredAt: "2026-09-28T12:00:00", content: `压测捕念 ${index} ${"x".repeat(64)}`, tags: ["系统压测"] })
  }, 201));
  report.phases.write = metrics(writes, performance.now() - startedAt);
  assertPhase("并发写入", report.phases.write, config.writeP95Ms);

  let state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.captures.length, config.writeRequests);
  assert.equal(new Set(state.captures.map(item => item.id)).size, config.writeRequests);

  startedAt = performance.now();
  const mixed = await runPool(config.mixedRequests, config.concurrency, index => {
    if (index % 5) return timedRequest(`${base}/api/state`, {}, 200);
    const target = state.captures[Math.floor(index / 5) % state.captures.length];
    return timedRequest(`${base}/api/captures/${target.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ occurredAt: "2026-09-28T12:00:00", content: `${target.content} 更新-${index}`, tags: ["系统压测", "混合负载"] })
    }, 200);
  });
  report.phases.mixed = metrics(mixed, performance.now() - startedAt);
  assertPhase("读写混合", report.phases.mixed, config.mixedP95Ms);
  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.captures.filter(item => item.tags.includes("混合负载")).length, Math.min(config.writeRequests, Math.ceil(config.mixedRequests / 5)));

  const questions = await runPool(config.aiTasks, config.concurrency, async index => {
    const response = await fetch(`${base}/api/thoughts`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ type: "question", occurredAt: "2026-09-28T12:00:00", content: `后台任务压测问题 ${index}`, tags: ["系统压测"] })
    });
    assert.equal(response.status, 201);
    return response.json();
  });
  const submittedAt = Date.now();
  const submittedTasks = await runPool(config.aiTasks, config.concurrency, async index => {
    const response = await fetch(`${base}/api/ai-tasks`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ kind: "thoughtAnswer", targetId: questions[index].id, inputVersion: questions[index].version, clientRequestId: `load-task-${index}` })
    });
    assert.equal(response.status, 202);
    return response.json();
  });
  const submittedTaskIds = new Set(submittedTasks.map(task => task.id));
  assert.equal(submittedTaskIds.size, config.aiTasks);

  let tasks = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    tasks = (await (await fetch(`${base}/api/ai-tasks`)).json()).items.filter(item => submittedTaskIds.has(item.id));
    if (tasks.length === config.aiTasks && tasks.every(item => !["queued", "running"].includes(item.status))) break;
    await sleep(25);
  }
  assert.equal(tasks.length, config.aiTasks);
  assert.deepEqual(
    [...new Set(tasks.map(item => item.status))],
    ["succeeded"],
    JSON.stringify(tasks)
  );
  const taskDurations = tasks.map(task => new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime());
  report.phases.aiTasks = {
    tasks: tasks.length,
    elapsedMs: Date.now() - submittedAt,
    p50Ms: percentile(taskDurations, 0.5),
    p95Ms: percentile(taskDurations, 0.95),
    maxMs: Math.max(...taskDurations)
  };
  assert.ok(report.phases.aiTasks.p95Ms <= config.aiTaskP95Ms, `后台任务 P95 ${report.phases.aiTasks.p95Ms}ms 超过阈值 ${config.aiTaskP95Ms}ms`);
  assert.equal(providerCalls, config.aiTasks);
  assert.ok(providerPeak > 1 && providerPeak <= 8, `模拟供应商峰值并发异常：${providerPeak}`);

  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.thoughts.filter(item => item.sourceTaskId && tasks.some(task => task.id === item.sourceTaskId)).length, config.aiTasks);
  assert.equal(new Set(state.thoughts.filter(item => item.sourceTaskId).map(item => item.sourceTaskId)).size, config.aiTasks);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  assert.equal(stored.captures.length, config.writeRequests);
  report.provider = { calls: providerCalls, peakConcurrency: providerPeak };
  report.storeBytes = (await fs.stat(path.join(dataDir, "store.json"))).size;
  report.ok = true;

  if (process.env.LOAD_REPORT_PATH) await fs.writeFile(path.resolve(process.env.LOAD_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log("Load regression passed: isolated concurrent reads, serialized writes, mixed traffic, persistent AI queue throughput and data integrity.");
} catch (error) {
  if (stderr.trim()) error.message = `${error.message}\nApplication stderr:\n${stderr.trim()}`;
  throw error;
} finally {
  globalThis.fetch = systemFetch;
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}
