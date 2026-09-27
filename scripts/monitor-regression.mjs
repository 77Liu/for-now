import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { collectHealth, runMonitor, sendFeishu, validateFeishuWebhook } from "./monitor-health.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-monitor-"));
const dataDir = path.join(root, "data"), logsDir = path.join(dataDir, "logs"), backupDir = path.join(root, "backups");
const stateFile = path.join(root, "state", "monitor.json"), backupStamp = path.join(root, "backup-success");
await Promise.all([
  fs.mkdir(logsDir, { recursive: true }),
  fs.mkdir(path.join(dataDir, "users"), { recursive: true }),
  fs.mkdir(backupDir, { recursive: true })
]);
let isReady = false;
const messages = [];
const mock = http.createServer(async (req, res) => {
  if (req.url === "/readyz") {
    res.writeHead(isReady ? 200 : 503);
    return res.end(JSON.stringify({ ok: isReady }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  res.setHeader("content-type", "application/json");
  if (req.url === "/empty") return res.end("{}");
  messages.push(JSON.parse(raw));
  res.end(JSON.stringify({ code: 0 }));
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => nativeFetch(
  String(input).includes("/hook/empty-hook") ? `${base}/empty`
    : String(input).startsWith("https://open.feishu.cn/open-apis/bot/v2/hook/test-hook") ? `${base}/webhook`
      : input,
  options
);
try {
  assert.equal(validateFeishuWebhook("https://open.feishu.cn/open-apis/bot/v2/hook/test-hook"), "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook");
  assert.equal(validateFeishuWebhook("https://open.larksuite.com/open-apis/bot/v2/hook/test-hook"), "https://open.larksuite.com/open-apis/bot/v2/hook/test-hook");
  assert.throws(() => validateFeishuWebhook(`${base}/webhook`), error => error.code === "FEISHU_INVALID_WEBHOOK");
  assert.throws(() => validateFeishuWebhook("https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/test"), error => error.code === "FEISHU_INVALID_WEBHOOK");
  await assert.rejects(sendFeishu("test", "https://open.feishu.cn/open-apis/bot/v2/hook/empty-hook"), error => error.code === "FEISHU_DELIVERY_FAILED");
  const now = Date.now();
  await fs.writeFile(path.join(logsDir, "system-2026-09-27.ndjson"), Array.from({ length: 5 }, (_, index) => JSON.stringify({
    timestamp: new Date(now - (5 - index) * 1000).toISOString(),
    event: "ai.completed",
    status: "failed"
  })).join("\n"));
  await fs.writeFile(path.join(dataDir, "ai-usage.json"), JSON.stringify({
    entries: [{ createdAt: new Date(now).toISOString(), costsUsd: { total: 6 } }]
  }));
  await fs.writeFile(path.join(backupDir, "for-now-old.tar.gz"), "backup");
  await fs.utimes(path.join(backupDir, "for-now-old.tar.gz"), new Date(now - 30 * 3600000), new Date(now - 30 * 3600000));

  Object.assign(process.env, {
    NODE_ENV: "test",
    MONITOR_TEST_SERVICE_ACTIVE: "1",
    DATA_DIR: dataDir,
    BACKUP_DIR: backupDir,
    BACKUP_SUCCESS_STAMP: backupStamp,
    MONITOR_READY_URL: `${base}/readyz`,
    MONITOR_STATE_FILE: stateFile,
    FEISHU_ALERT_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook",
    FEISHU_ALERT_SECRET: "test-secret",
    ALERT_DISK_WARNING_PERCENT: "0",
    ALERT_DISK_CRITICAL_PERCENT: "101",
    ALERT_BACKUP_MAX_AGE_HOURS: "26",
    ALERT_AI_CONSECUTIVE_FAILURES: "5",
    ALERT_DAILY_AI_COST_USD: "5",
    ALERT_REPEAT_MINUTES: "60"
  });
  const unhealthy = await collectHealth({ now, dataDir, backupDir, backupStamp, readyUrl: `${base}/readyz` });
  assert.deepEqual(unhealthy.issues.map(item => item.key).sort(), ["ai-cost", "ai-failures", "backup", "disk", "service"]);
  await runMonitor();
  process.exitCode = 0;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg_type, "text");
  assert.match(messages[0].content.text, /严重告警/);
  assert.ok(messages[0].timestamp && messages[0].sign);
  await runMonitor();
  process.exitCode = 0;
  assert.equal(messages.length, 1);

  isReady = true;
  process.env.ALERT_DISK_WARNING_PERCENT = "101";
  await fs.writeFile(backupStamp, "");
  await fs.writeFile(path.join(logsDir, "system-2026-09-27.ndjson"), JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "ai.completed",
    status: "success"
  }));
  await fs.writeFile(path.join(dataDir, "ai-usage.json"), JSON.stringify({ entries: [] }));
  const healthy = await collectHealth({ dataDir, backupDir, backupStamp, readyUrl: `${base}/readyz` });
  assert.deepEqual(healthy.issues, []);
  await runMonitor();
  assert.equal(messages.length, 2);
  assert.match(messages[1].content.text, /已恢复/);
  console.log("Monitor checks passed: service, disk, stale backup, consecutive AI failures, daily cost, Feishu signing, deduplication and recovery.");
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
