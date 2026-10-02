import crypto from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIB = 1024 * 1024;
const execFile = promisify(execFileCallback);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const setting = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
};
const config = {
  stateReads: setting("MEMORY_SOAK_STATE_READS", 120, 1, 100_000),
  adminSnapshots: setting("MEMORY_SOAK_ADMIN_SNAPSHOTS", 12, 1, 10_000),
  analyses: setting("MEMORY_SOAK_ANALYSES", 6, 1, 1_000),
  attachments: setting("MEMORY_SOAK_ATTACHMENTS", 3, 1, 100),
  concurrency: setting("MEMORY_SOAK_CONCURRENCY", 6, 1, 50),
  sampleIntervalMs: setting("MEMORY_SOAK_SAMPLE_INTERVAL_MS", 250, 50, 60_000),
  settleMs: 0,
  idleMs: setting("MEMORY_SOAK_IDLE_MS", 15_000, 150, 3_600_000)
};
config.settleMs = Math.max(
  config.sampleIntervalMs * 2,
  setting("MEMORY_SOAK_SETTLE_MS", 750, 50, 60_000)
);

let currentStage = "setup";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii"), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}
function syntheticPng(mask = false) {
  const width = 640, height = 480, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4, inside = x > 40 && x < width - 40 && y > 40 && y < height - 40;
      raw[pixel] = mask ? 255 : (x * 13 + y * 7) % 256;
      raw[pixel + 1] = mask ? 255 : (x * 3 + y * 17) % 256;
      raw[pixel + 2] = mask ? 255 : (x * 19 + y * 5) % 256;
      raw[pixel + 3] = mask ? (inside ? 255 : 0) : 255;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function nodeBinary(workspace) {
  const configured = String(process.env.MEMORY_SOAK_NODE_BINARY || "").trim();
  if (configured) return { path: configured, mode: "configured" };
  if (process.platform !== "darwin") return { path: process.execPath, mode: "current" };
  const copy = path.join(workspace, "node-adhoc");
  await fs.copyFile(process.execPath, copy);
  await fs.chmod(copy, 0o755);
  await execFile("/usr/bin/codesign", ["--force", "--sign", "-", copy]);
  return { path: copy, mode: "temporary-adhoc-copy" };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function runPool(count, concurrency, operation) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (cursor < count) {
      const index = cursor++;
      await operation(index);
    }
  }));
}

const nonnegative = value => Math.max(0, Number(value) || 0);
function memoryPoint(value) {
  const categories = Object.fromEntries(Object.entries(value?.activeHandles?.categories || {})
    .map(([key, count]) => [key, nonnegative(count)])
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    sampledAt: String(value?.sampledAt || ""),
    rss: nonnegative(value?.rss),
    heapTotal: nonnegative(value?.heapTotal),
    heapUsed: nonnegative(value?.heapUsed),
    external: nonnegative(value?.external),
    arrayBuffers: nonnegative(value?.arrayBuffers),
    heapSpaces: Object.fromEntries((Array.isArray(value?.heapSpaces) ? value.heapSpaces : [])
      .map(space => [String(space?.name || "").slice(0, 80), nonnegative(space?.used)])
      .sort(([left], [right]) => left.localeCompare(right))),
    eventLoopDelayP95Ms: nonnegative(value?.eventLoopDelay?.p95Ms),
    activeHandles: { total: nonnegative(value?.activeHandles?.total), categories }
  };
}

async function runtimeSamples(directory) {
  const logsDir = path.join(directory, "logs");
  let names = [];
  try {
    names = (await fs.readdir(logsDir)).filter(name => /^system-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
  } catch {}
  const samples = [];
  for (const name of names) {
    const content = await fs.readFile(path.join(logsDir, name), "utf8");
    for (const line of content.split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.event === "runtime.memory_sample" && entry.sample?.rss) samples.push(memoryPoint(entry.sample));
      } catch {}
    }
  }
  return samples;
}

const PROCESS_FIELDS = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];
function peakPoint(samples) {
  const peak = {
    ...Object.fromEntries(PROCESS_FIELDS.map(field => [field, Math.max(...samples.map(sample => sample[field]), 0)])),
    heapSpaces: {},
    eventLoopDelayP95Ms: Math.max(...samples.map(sample => sample.eventLoopDelayP95Ms), 0),
    activeHandles: { total: Math.max(...samples.map(sample => sample.activeHandles.total), 0), categories: {} }
  };
  for (const sample of samples) {
    for (const [name, used] of Object.entries(sample.heapSpaces)) peak.heapSpaces[name] = Math.max(peak.heapSpaces[name] || 0, used);
    for (const [name, count] of Object.entries(sample.activeHandles.categories)) {
      peak.activeHandles.categories[name] = Math.max(peak.activeHandles.categories[name] || 0, count);
    }
  }
  return peak;
}

function phaseReport({ startedAt, started, before, samples, operation }) {
  const after = samples.at(-1);
  if (!after) throw Object.assign(new Error("runtime samples unavailable"), { code: "MEMORY_SAMPLES_UNAVAILABLE" });
  const elapsedMinutes = Math.max((Date.parse(after.sampledAt) - Date.parse(samples[0].sampledAt)) / 60_000, 0.001);
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    sampleCount: samples.length,
    before,
    after,
    peak: peakPoint(samples),
    delta: Object.fromEntries(PROCESS_FIELDS.map(field => [field, after[field] - (before?.[field] || 0)])),
    trend: {
      firstRss: samples[0].rss,
      lastRss: after.rss,
      rssDelta: after.rss - samples[0].rss,
      rssBytesPerMinute: Math.round((after.rss - samples[0].rss) / elapsedMinutes)
    },
    operation
  };
}

async function execute() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "growth-memory-soak-"));
  const directory = path.join(workspace, "data");
  await fs.mkdir(directory, { mode: 0o700 });
  const appPort = await freePort(), providerPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  const serviceToken = "local-memory-soak-service-token-00000001";
  let providerCalls = 0, providerActive = 0, providerPeak = 0, child = null;
  const provider = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    providerCalls += 1;
    providerActive += 1;
    providerPeak = Math.max(providerPeak, providerActive);
    await sleep(20);
    providerActive -= 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `mock-${providerCalls}`,
      model: "local-memory-mock",
      choices: [{ message: { content: "本地模拟复盘", reasoning_content: "本地模拟摘要" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 12 }
    }));
  });

  const requestJson = async (pathname, { method = "GET", headers = {}, body, statuses = [200] } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!statuses.includes(response.status)) {
      throw Object.assign(new Error("unexpected local response"), { code: `LOCAL_HTTP_${response.status}` });
    }
    return response.json();
  };
  const waitForReady = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child?.exitCode != null) throw Object.assign(new Error("application exited"), { code: "LOCAL_APP_EXITED" });
      try {
        if ((await fetch(`${base}/readyz`)).ok) return;
      } catch {}
      await sleep(50);
    }
    throw Object.assign(new Error("application readiness timeout"), { code: "LOCAL_APP_TIMEOUT" });
  };
  const phases = {};
  let executable;
  const runPhase = async (name, operation) => {
    currentStage = name;
    const existing = await runtimeSamples(directory);
    const before = existing.at(-1) || null;
    const startedAt = new Date().toISOString(), started = performance.now();
    const result = await operation();
    await sleep(config.settleMs);
    const all = await runtimeSamples(directory);
    const segment = all.filter(sample => Date.parse(sample.sampledAt) >= Date.parse(startedAt));
    phases[name] = phaseReport({ startedAt, started, before, samples: segment, operation: result });
  };

  try {
    executable = await nodeBinary(workspace);
    await new Promise((resolve, reject) => provider.once("error", reject).listen(providerPort, "127.0.0.1", resolve));
    await runPhase("coldStart", async () => {
      child = spawn(executable.path, ["server.mjs"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || "",
          TMPDIR: process.env.TMPDIR || "",
          LANG: process.env.LANG || "C.UTF-8",
          NODE_ENV: "test",
          PERSISTENCE_BACKEND: "json",
          ATTACHMENT_STORAGE: "local",
          UPSTREAM_ORIGIN: "",
          AUTH_REQUIRED: "0",
          INVITE_CODE_HASH: "",
          APP_BASE_PATH: "",
          DATA_DIR: directory,
          PORT: String(appPort),
          PERIODIC_ANALYSIS_ENABLED: "0",
          DEEPSEEK_API_URL: `http://127.0.0.1:${providerPort}/chat/completions`,
          PLATFORM_SERVICE_TOKEN_HASH: crypto.createHash("sha256").update(serviceToken).digest("hex"),
          AI_USER_DAILY_CALL_LIMIT: String(config.analyses + 20),
          AI_USER_DAILY_COST_LIMIT_CNY: "1000",
          RUNTIME_MEMORY_SAMPLE_INTERVAL_MS: String(config.sampleIntervalMs)
        },
        stdio: ["ignore", "ignore", "pipe"]
      });
      child.stderr.resume();
      await waitForReady();
      await requestJson("/api/settings", { method: "POST", body: { apiKey: "local-mock-key" } });
      return { ready: true };
    });

    await runPhase("stateReads", async () => {
      await runPool(config.stateReads, config.concurrency, () => requestJson("/api/state"));
      return { requests: config.stateReads };
    });
    await runPhase("adminSnapshot", async () => {
      await runPool(config.adminSnapshots, config.concurrency, () => requestJson("/api/admin/v1/snapshot", {
        headers: { authorization: `Bearer ${serviceToken}` }
      }));
      return { requests: config.adminSnapshots };
    });
    await runPhase("analyses", async () => {
      await requestJson("/api/captures", {
        method: "POST",
        statuses: [201],
        body: { occurredAt: "2026-10-03T09:00:00", content: "MEMORY_SOAK_CAPTURE", tags: ["local-soak"] }
      });
      await runPool(config.analyses, config.concurrency, index => requestJson("/api/v1/analyses", {
        method: "POST",
        statuses: [201],
        headers: { "idempotency-key": `memory-soak-analysis-${index}` },
        body: {}
      }));
      return { created: config.analyses };
    });

    currentStage = "attachmentFixture";
    const image = syntheticPng();
    const mask = syntheticPng(true);
    const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
    const maskUrl = `data:image/png;base64,${mask.toString("base64")}`;
    await runPhase("attachmentsSharp", async () => {
      for (let index = 0; index < config.attachments; index += 1) {
        await requestJson("/api/keepsakes", {
          method: "POST",
          statuses: [201],
          headers: { "idempotency-key": `memory-soak-keepsake-${index}` },
          body: {
            title: `local-soak-${index}`,
            occurredAt: "2026-10-03T09:00:00",
            image: imageUrl,
            alphaMask: maskUrl
          }
        });
      }
      let ready = 0;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const state = await requestJson("/api/state");
        ready = state.keepsakes.filter(item => item.derivativeState === "ready").length;
        if (ready === config.attachments) break;
        if (state.keepsakes.some(item => item.derivativeState === "failed")) {
          throw Object.assign(new Error("Sharp derivative failed"), { code: "SHARP_DERIVATIVE_FAILED" });
        }
        await sleep(50);
      }
      if (ready !== config.attachments) throw Object.assign(new Error("Sharp derivative timeout"), { code: "SHARP_DERIVATIVE_TIMEOUT" });
      return { created: config.attachments, ready };
    });
    await runPhase("idleReclamation", async () => {
      await sleep(config.idleMs);
      return { idleMs: config.idleMs };
    });

    const idle = phases.idleReclamation;
    return {
      schemaVersion: 1,
      ok: true,
      startedAt: phases.coldStart.startedAt,
      completedAt: new Date().toISOString(),
      runtime: { platform: process.platform, arch: process.arch, node: process.version, nodeExecutableMode: executable.mode },
      config,
      phases,
      provider: { mode: "loopback-mock", calls: providerCalls, peakConcurrency: providerPeak },
      summary: {
        peakRss: Math.max(...Object.values(phases).map(phase => phase.peak.rss)),
        finalRss: idle.after.rss,
        idleRssDelta: idle.trend.rssDelta,
        plateauToleranceBytes: 16 * MIB,
        plateauCandidate: idle.sampleCount >= 3 && Math.abs(idle.trend.rssDelta) <= 16 * MIB
      }
    };
  } finally {
    if (child?.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
    await new Promise(resolve => provider.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

let output;
try {
  output = await execute();
} catch (error) {
  const code = String(error?.code || "");
  output = {
    schemaVersion: 1,
    ok: false,
    stage: currentStage,
    error: { code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : "MEMORY_SOAK_FAILED" }
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(output)}\n`);
