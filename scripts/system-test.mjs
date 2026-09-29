import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestedSuite = process.argv[2] || "all";
const ISOLATION_PROBE = "__isolation-probe";
const productionEnvironmentKey = key => (
  ["DATABASE_URL", "AUTH_DATABASE_URL", "APP_URL", "UPSTREAM_ORIGIN"].includes(key)
  || /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_)/.test(key)
  || /^(?:PG_BACKUP_DATABASE_URL|PG_SCHEMA_DATABASE_URL)$/.test(key)
);
const isolatedEnvironment = source => {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !productionEnvironmentKey(key)));
  return {
    ...environment,
    NODE_ENV: "test",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    UPSTREAM_ORIGIN: ""
  };
};

if (requestedSuite === ISOLATION_PROBE) {
  for (const key of [
    "DATABASE_URL", "AUTH_DATABASE_URL", "PG_BACKUP_DATABASE_URL", "PG_SCHEMA_DATABASE_URL",
    "APP_URL", "OSS_ENDPOINT", "OSS_BUCKET", "ALIYUN_ACCESS_KEY_ID", "DEEPSEEK_API_KEY",
    "FEISHU_ALERT_WEBHOOK"
  ]) {
    assert.equal(process.env[key], undefined, `system test child inherited ${key}`);
  }
  assert.equal(process.env.PERSISTENCE_BACKEND, "json");
  assert.equal(process.env.ATTACHMENT_STORAGE, "local");
  assert.equal(process.env.UPSTREAM_ORIGIN, "");
  assert.equal(process.env.SYSTEM_TEST_ISOLATION_PROBE, "poisoned-parent");
  process.stdout.write("System test environment isolation probe passed.\n");
  process.exit(0);
}

const suites = {
  isolation: [
    ["production environment isolation", ["scripts/system-test.mjs", ISOLATION_PROBE]]
  ],
  backend: [
    ["production environment isolation", ["scripts/system-test.mjs", ISOLATION_PROBE]],
    ["module boundaries", ["scripts/check-modules.mjs"]],
    ["local feat commit gate", ["scripts/commit-gate-regression.mjs"]],
    ["versioned prompt catalog", ["scripts/prompt-catalog-regression.mjs"]],
    ["server syntax", ["--check", "server.mjs"]],
    ["runtime configuration, context and logging contracts", ["scripts/runtime-infrastructure-regression.mjs"]],
    ["frontend syntax", ["--check", "public/app.js"]],
    ["system runner syntax", ["--check", "scripts/system-test.mjs"]],
    ["load test syntax", ["--check", "scripts/load-regression.mjs"]],
    ["local test mode syntax", ["--check", "scripts/local-test-mode-regression.mjs"]],
    ["local test launcher syntax", ["--check", "scripts/local-test-preview.mjs"]],
    ["persistence adapters and migration mapping", ["scripts/persistence-regression.mjs"]],
    ["identity, configuration and attachment migration", ["scripts/document-migration-regression.mjs"]],
    ["thought domain service", ["scripts/thought-service-regression.mjs"]],
    ["check-in and health record domains", ["scripts/checkin-health-regression.mjs"]],
    ["capture and journal domains", ["scripts/capture-journal-regression.mjs"]],
    ["book and quote domains", ["scripts/library-regression.mjs"]],
    ["review, chat and statistics domains", ["scripts/reviews-chat-regression.mjs"]],
    ["cross-genre content attachments", ["scripts/content-attachments-regression.mjs"]],
    ["keepsake media workflows", ["scripts/keepsake-media-workflows-regression.mjs"]],
    ["keepsake derivative generation and transport", ["scripts/attachment-derivatives-regression.mjs"]],
    ["API v1 public contract and thought vertical slice", ["scripts/api-v1-contract-regression.mjs"]],
    ["API v1 check-in and health vertical slices", ["scripts/record-v1-regression.mjs"]],
    ["API v1 OpenAPI fragments", ["scripts/api-v1-openapi-fragment-regression.mjs"]],
    ["G2 thought discovery", ["scripts/g2-discovery-regression.mjs"]],
    ["G2 account export", ["scripts/g2-export-regression.mjs"]],
    ["G2 actions and habits", ["scripts/g2-actions-regression.mjs"]],
    ["G2 feedback and validation ledger", ["scripts/g2-feedback-regression.mjs"]],
    ["G2 integrated API and persistence", ["scripts/g2-integration-regression.mjs"]],
    ["AI settings, costs, usage and audit contracts", ["scripts/ai-domain-regression.mjs"]],
    ["AI provider transport and attempt policy", ["scripts/ai-provider-regression.mjs"]],
    ["segmentation transport, audit and temporary lifecycle", ["scripts/segmentation-regression.mjs"]],
    ["keepsake records and event time contracts", ["scripts/keepsake-time-regression.mjs"]],
    ["onboarding, business prompts and personal context", ["scripts/personal-context-regression.mjs"]],
    ["annotations, background tasks and notifications", ["scripts/collaboration-regression.mjs"]],
    ["trash, restore and durable attachment cleanup", ["scripts/trash-regression.mjs"]],
    ["backend regression", ["scripts/regression.mjs"]],
    ["authentication and server deployment shape", ["scripts/auth-regression.mjs"]],
    ["authentication concurrency", ["scripts/auth-concurrency-regression.mjs"]],
    ["local test data modes", ["scripts/local-test-mode-regression.mjs"]],
    ["observability", ["scripts/observability-regression.mjs"]],
    ["attachment storage", ["scripts/attachment-storage-regression.mjs"]],
    ["attachment uploads, quotas and recovery", ["scripts/attachment-upload-regression.mjs"]],
    ["capacity boundaries", ["scripts/boundaries-regression.mjs"]],
    ["monitoring", ["scripts/monitor-regression.mjs"]],
    ["restore validation", ["scripts/restore-validation-regression.mjs"]],
    ["deployment rollback", ["scripts/deploy-regression.mjs"]]
  ],
  load: [
    ["isolated load regression", ["scripts/load-regression.mjs"]]
  ],
  frontend: [
    ["frontend API, session and state contracts", ["scripts/frontend-contract-regression.mjs"]],
    ["frontend content, time and media contracts", ["scripts/frontend-shared-regression.mjs"]],
    ["frontend application shell and page lifecycle", ["scripts/frontend-shell-regression.mjs"]],
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
    const sourceEnvironment = args[1] === ISOLATION_PROBE ? {
      ...process.env,
      DATABASE_URL: "postgresql://production.invalid/live",
      AUTH_DATABASE_URL: "postgresql://production.invalid/auth",
      APP_URL: "https://production.invalid/now/",
      OSS_ENDPOINT: "oss-production.invalid",
      OSS_BUCKET: "production-bucket",
      ALIYUN_ACCESS_KEY_ID: "production-secret",
      DEEPSEEK_API_KEY: "production-secret",
      FEISHU_ALERT_WEBHOOK: "https://production.invalid/hook",
      PG_BACKUP_DATABASE_URL: "postgresql://production.invalid/backup",
      PG_SCHEMA_DATABASE_URL: "postgresql://production.invalid/schema",
      SYSTEM_TEST_ISOLATION_PROBE: "poisoned-parent"
    } : process.env;
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: isolatedEnvironment(sourceEnvironment),
      stdio: "inherit"
    });
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
