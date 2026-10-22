import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAuthenticatedJsonRuntime } from "../.build/typescript/backend/shared/testing/authenticated-runtime.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-boundaries-"));
const mockDir = await fs.mkdtemp(path.join(os.tmpdir(), "growth-oss-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const largeImageBytes = 9 * 1024 * 1024;
const pixelBytes = Buffer.from(pixel.split(",")[1], "base64");
const largePixelBytes = Buffer.concat([pixelBytes, Buffer.alloc(largeImageBytes - pixelBytes.length)]);
const largePixel = `data:image/png;base64,${largePixelBytes.toString("base64")}`;
let providerActive = 0, providerPeak = 0;
const providerStarts = [];
const provider = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  providerStarts.push(Date.now());
  providerActive += 1;
  providerPeak = Math.max(providerPeak, providerActive);
  await delay(120);
  providerActive -= 1;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    choices: [{ message: { content: "连接成功" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2 }
  }));
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const free = http.createServer();
await new Promise(resolve => free.listen(0, "127.0.0.1", resolve));
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
await fs.writeFile(path.join(dataDir, "llm-settings.json"), JSON.stringify({ version: 4, apiKey: "test-key" }));
const authFixture = await installAuthenticatedJsonRuntime(dataDir);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: String(port),
    ...authFixture.env,
    DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}`,
    ATTACHMENT_STORAGE: "mock",
    OSS_MOCK_DIR: mockDir,
    OSS_ATTACHMENT_PREFIX: "attachments",
    ATTACHMENT_USER_QUOTA_BYTES: String(largeImageBytes + 10),
    AI_GLOBAL_QPS: "2",
    AI_GLOBAL_CONCURRENCY: "2",
    AI_USER_DAILY_CALL_LIMIT: "3",
    AI_COST_CNY_PER_USD: "7.2",
    AI_USER_DAILY_COST_LIMIT_CNY: "72",
    SEGMENTATION_GLOBAL_QPS: "2",
    SEGMENTATION_GLOBAL_CONCURRENCY: "2",
    KEEPSAKE_SEGMENT_MOCK_RESULT: pixel,
    KEEPSAKE_SEGMENT_MOCK_DELAY_MS: "80"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;
const post = (route, body = {}) => fetch(`${base}${route}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: authFixture.cookie
  },
  body: JSON.stringify(body)
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch {}
    if (ready || child.exitCode != null) break;
    await delay(50);
  }
  assert.equal(ready, true, stderr);

  const aiStarted = Date.now();
  const aiResponses = await Promise.all([post("/api/settings/test"), post("/api/settings/test"), post("/api/settings/test")]);
  assert.deepEqual(aiResponses.map(response => response.status), [200, 200, 200]);
  assert.ok(Date.now() - aiStarted >= 900);
  assert.ok(providerStarts[2] - providerStarts[0] >= 850);
  assert.ok(providerPeak <= 2);
  const limited = await post("/api/settings/test");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "AI_DAILY_CALL_LIMIT");

  const segmentStarted = Date.now();
  const segments = await Promise.all([
    post("/api/keepsakes/segment", { image: pixel }),
    post("/api/keepsakes/segment", { image: pixel }),
    post("/api/keepsakes/segment", { image: pixel })
  ]);
  assert.deepEqual(segments.map(response => response.status), [200, 200, 200]);
  assert.ok(Date.now() - segmentStarted >= 900);

  const firstUpload = await post("/api/images/upload", { image: largePixel });
  assert.equal(firstUpload.status, 201);
  const attachmentPath = (await firstUpload.json()).attachmentPath;
  const name = attachmentPath.split("/").at(-1);
  const stored = path.join(mockDir, "attachments", authFixture.userId, name);
  assert.deepEqual(await fs.readFile(stored), largePixelBytes);
  await assert.rejects(fs.access(path.join(dataDir, "attachments", name)));
  const fetched = await fetch(`${base}${attachmentPath}`, {
    headers: { cookie: authFixture.cookie }
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), await fs.readFile(stored));
  const secondUpload = await post("/api/images/upload", { image: pixel });
  assert.equal(secondUpload.status, 413);
  assert.equal((await secondUpload.json()).code, "ATTACHMENT_QUOTA_EXCEEDED");

  console.log("Boundary checks passed: AI 2 QPS/2 concurrency test gate, daily call quota, segmentation 2 QPS gate, 9 MB attachment upload, mock OSS write/read, local omission and attachment quota.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => provider.close(resolve));
  await Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(mockDir, { recursive: true, force: true })
  ]);
}
