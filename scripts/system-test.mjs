import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestedSuite = process.argv[2] || "all";
const suites = {
  backend: [
    ["server syntax", ["--check", "server.mjs"]],
    ["logging syntax", ["--check", "logging.mjs"]],
    ["frontend syntax", ["--check", "public/app.js"]],
    ["system runner syntax", ["--check", "scripts/system-test.mjs"]],
    ["load test syntax", ["--check", "scripts/load-regression.mjs"]],
    ["local test mode syntax", ["--check", "scripts/local-test-mode-regression.mjs"]],
    ["local test launcher syntax", ["--check", "scripts/local-test-preview.mjs"]],
    ["backend regression", ["scripts/regression.mjs"]],
    ["authentication and server deployment shape", ["scripts/auth-regression.mjs"]],
    ["local test data modes", ["scripts/local-test-mode-regression.mjs"]],
    ["observability", ["scripts/observability-regression.mjs"]],
    ["attachment storage", ["scripts/attachment-storage-regression.mjs"]],
    ["capacity boundaries", ["scripts/boundaries-regression.mjs"]],
    ["monitoring", ["scripts/monitor-regression.mjs"]],
    ["restore validation", ["scripts/restore-validation-regression.mjs"]],
    ["deployment rollback", ["scripts/deploy-regression.mjs"]]
  ],
  load: [
    ["isolated load regression", ["scripts/load-regression.mjs"]]
  ],
  frontend: [
    ["desktop and responsive UI", ["scripts/ui-regression.mjs"]],
    ["mobile platform simulation", ["scripts/mobile-platform-regression.mjs"]]
  ],
  exploration: [
    ["exploration UI isolation", ["scripts/exploration-regression.mjs"]]
  ]
};

if (![...Object.keys(suites), "all"].includes(requestedSuite)) {
  throw new Error(`未知系统测试分组：${requestedSuite}。可选值：backend、load、frontend、exploration、all`);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`node ${args.join(" ")} 失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}

const selected = requestedSuite === "all" ? ["backend", "frontend"] : [requestedSuite];
const results = [];
const totalStartedAt = Date.now();

for (const suite of selected) {
  for (const [name, args] of suites[suite]) {
    const startedAt = Date.now();
    process.stdout.write(`\n[system:${suite}] ${name}\n`);
    try {
      await runNode(args);
      results.push({ suite, name, status: "passed", durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ suite, name, status: "failed", durationMs: Date.now() - startedAt, error: error.message });
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(`${JSON.stringify({ suite: requestedSuite, status: "failed", durationMs: Date.now() - totalStartedAt, results }, null, 2)}\n`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode) break;
}

if (!process.exitCode) {
  process.stdout.write(`\n${JSON.stringify({ suite: requestedSuite, status: "passed", durationMs: Date.now() - totalStartedAt, results }, null, 2)}\n`);
}
