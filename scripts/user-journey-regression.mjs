import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MATRIX_PATH = path.join(ROOT, "knowledge/user-journey-matrix.json");
const tiers = ["smoke", "daily", "release"];
const requestedTier = process.argv[2] || "smoke";
const validateOnly = requestedTier === "validate";

if (!validateOnly && !tiers.includes(requestedTier)) {
  throw new Error(`未知用户旅程测试层级：${requestedTier}。可选值：validate、${tiers.join("、")}`);
}

const matrix = JSON.parse(await fs.readFile(MATRIX_PATH, "utf8"));
assert.equal(matrix.version, 1);
assert.ok(Array.isArray(matrix.journeys) && matrix.journeys.length > 0, "用户旅程矩阵不能为空");
assert.equal(new Set(matrix.journeys.map(item => item.id)).size, matrix.journeys.length, "用户旅程 ID 必须唯一");

for (const journey of matrix.journeys) {
  assert.match(journey.id, /^[a-z0-9-]+$/);
  assert.ok(tiers.includes(journey.tier), `${journey.id} 的层级无效`);
  assert.ok(["automated", "partial", "blocked"].includes(journey.status), `${journey.id} 的自动化状态无效`);
  for (const key of ["normalPath", "failureAndRecovery", "assertions", "evidence"]) {
    assert.ok(Array.isArray(journey[key]) && journey[key].length > 0, `${journey.id} 缺少 ${key}`);
  }
  for (const evidence of journey.evidence) {
    const sourcePath = path.join(ROOT, evidence.script);
    const source = await fs.readFile(sourcePath, "utf8");
    assert.ok(source.includes(evidence.anchor), `${journey.id} 的证据锚点已失效：${evidence.script} -> ${evidence.anchor}`);
  }
}

const tierIndex = validateOnly ? -1 : tiers.indexOf(requestedTier);
const selectedJourneys = validateOnly
  ? matrix.journeys
  : matrix.journeys.filter(journey => tiers.indexOf(journey.tier) <= tierIndex);

const commandSets = {
  smoke: [
    ["frontend contracts", process.execPath, ["scripts/frontend-contract-regression.mjs"]],
    ["frontend shared contracts", process.execPath, ["scripts/frontend-shared-regression.mjs"]],
    ["real-browser UI journeys", process.execPath, ["scripts/ui-regression.mjs"]]
  ],
  daily: [
    ["frontend system suite", process.execPath, ["scripts/system-test.mjs", "frontend"]],
    ["authentication and account isolation", process.execPath, ["scripts/auth-regression.mjs"]],
    ["local online snapshot", process.execPath, ["scripts/local-test-mode-regression.mjs"]]
  ],
  release: [
    ["full isolated system suite", process.execPath, ["scripts/system-test.mjs", "all"]],
    ["PostgreSQL stable suite", "npm", ["run", "test:postgres:stable"]],
    ["production dependency audit", "npm", ["audit", "--omit=dev"]]
  ]
};

const productionEnvironmentKey = key => (
  ["DATABASE_URL", "AUTH_DATABASE_URL", "APP_URL", "UPSTREAM_ORIGIN"].includes(key)
  || /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/.test(key)
  || /^(?:PG_BACKUP_DATABASE_URL|PG_SCHEMA_DATABASE_URL)$/.test(key)
);

function isolatedEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !productionEnvironmentKey(key)));
  return {
    ...environment,
    NODE_ENV: "test",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    UPSTREAM_ORIGIN: ""
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: isolatedEnvironment(),
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} 失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(ROOT, "artifacts/user-journeys");
const results = [];
const startedAt = Date.now();

try {
  if (!validateOnly) {
    for (const [name, command, args] of commandSets[requestedTier]) {
      const commandStartedAt = Date.now();
      process.stdout.write(`\n[user-journey:${requestedTier}] ${name}\n`);
      await runCommand(command, args);
      results.push({ tier: requestedTier, name, status: "passed", durationMs: Date.now() - commandStartedAt });
    }
  }
  const summary = {
    runId,
    tier: validateOnly ? "validate" : requestedTier,
    status: "passed",
    durationMs: Date.now() - startedAt,
    journeyCount: selectedJourneys.length,
    automatedCount: selectedJourneys.filter(item => item.status === "automated").length,
    partial: selectedJourneys.filter(item => item.status !== "automated").map(item => item.id),
    results
  };
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, `${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const summary = {
    runId,
    tier: validateOnly ? "validate" : requestedTier,
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: error.message,
    results
  };
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, `${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  throw error;
}
