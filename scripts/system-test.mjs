import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestNodeBinary } from "./test-node-binary.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestedSuite = process.argv[2] || "all";
const ISOLATION_PROBE = "__isolation-probe";
const productionEnvironmentKey = key => (
  ["DATABASE_URL", "AUTH_DATABASE_URL", "AI_BUDGET_DATABASE_URL", "APP_URL", "UPSTREAM_ORIGIN"].includes(key)
  || /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/.test(key)
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
    "DATABASE_URL", "AUTH_DATABASE_URL", "AI_BUDGET_DATABASE_URL", "PG_BACKUP_DATABASE_URL", "PG_SCHEMA_DATABASE_URL",
    "APP_URL", "OSS_ENDPOINT", "OSS_BUCKET", "ALIYUN_ACCESS_KEY_ID", "DEEPSEEK_API_KEY",
    "VOLCENGINE_SPEECH_API_KEY", "VOLCENGINE_ACCESS_KEY_ID", "VOLCENGINE_SECRET_ACCESS_KEY",
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
    ["module boundary checker regression", ["scripts/module-boundary-regression.mjs"]],
    ["entrypoint boundary contracts", ["scripts/entrypoint-boundary-regression.mjs"]],
    ["user journey coverage matrix", ["scripts/user-journey-regression.mjs", "validate"]],
    ["local task commit gate", ["scripts/commit-gate-regression.mjs"]],
    ["PostgreSQL test preflight", ["scripts/postgres-test-preflight-regression.mjs"]],
    ["versioned prompt catalog", ["scripts/prompt-catalog-regression.mjs"]],
    ["server syntax", ["--check", "server.mjs"]],
    ["runtime configuration, context and logging contracts", ["scripts/runtime-infrastructure-regression.mjs"]],
    ["frontend syntax", ["--check", "public/app.js"]],
    ["system runner syntax", ["--check", "scripts/system-test.mjs"]],
    ["load test syntax", ["--check", "scripts/load-regression.mjs"]],
    ["memory soak syntax", ["--check", "scripts/memory-soak.mjs"]],
    ["account lifecycle syntax", ["--check", "scripts/account-lifecycle-regression.mjs"]],
    ["local test control syntax", ["--check", "scripts/local-test-control-regression.mjs"]],
    ["local test runtime syntax", ["--check", "scripts/local-test-runtime-regression.mjs"]],
    ["local test HTTP syntax", ["--check", "scripts/local-test-http-regression.mjs"]],
    ["local test mode syntax", ["--check", "scripts/local-test-mode-regression.mjs"]],
    ["local test launcher syntax", ["--check", "scripts/local-test-preview.mjs"]],
    ["Store v16 defaults and compatibility normalization", ["scripts/store-normalization-regression.mjs"]],
    ["cross-domain derived statistics", ["scripts/derived-statistics-regression.mjs"]],
    ["role-aware public Store projection", ["scripts/public-state-regression.mjs"]],
    ["account initialization and startup recovery", ["scripts/account-lifecycle-regression.mjs"]],
    ["local test control and workspace rules", ["scripts/local-test-control-regression.mjs"]],
    ["local test workspace switching and recovery", ["scripts/local-test-runtime-regression.mjs"]],
    ["local test sessions and read-only upstream", ["scripts/local-test-http-regression.mjs"]],
    ["persistence adapters and migration mapping", ["scripts/persistence-regression.mjs"]],
    ["identity, configuration and attachment migration", ["scripts/document-migration-regression.mjs"]],
    ["thought domain service", ["scripts/thought-service-regression.mjs"]],
    ["check-in and health record domains", ["scripts/checkin-health-regression.mjs"]],
    ["capture and journal domains", ["scripts/capture-journal-regression.mjs"]],
    ["recoverable capture transcription workflow", ["scripts/capture-transcription-regression.mjs"]],
    ["private recoverable capture speech cache", ["scripts/speech-cache-regression.mjs"]],
    ["book and quote domains", ["scripts/library-regression.mjs"]],
    ["review, chat and statistics domains", ["scripts/reviews-chat-regression.mjs"]],
    ["cross-genre content attachments", ["scripts/content-attachments-regression.mjs"]],
    ["keepsake media workflows", ["scripts/keepsake-media-workflows-regression.mjs"]],
    ["keepsake derivative generation and transport", ["scripts/attachment-derivatives-regression.mjs"]],
    ["private Fontconfig cache for synthetic image smoke", ["scripts/fontconfig-cache-regression.mjs"]],
    ["keepsake historical media migration", ["scripts/keepsake-media-migration-regression.mjs"]],
    ["keepsake connected-component placement", ["scripts/keepsake-placement-regression.mjs"]],
    ["startup and current-route projections", ["scripts/startup-projection-regression.mjs"]],
    ["API v1 public contract and thought vertical slice", ["scripts/api-v1-contract-regression.mjs"]],
    ["API v1 check-in and health vertical slices", ["scripts/record-v1-regression.mjs"]],
    ["API v1 OpenAPI fragments", ["scripts/api-v1-openapi-fragment-regression.mjs"]],
    ["G2 thought discovery", ["scripts/g2-discovery-regression.mjs"]],
    ["G2 account export", ["scripts/g2-export-regression.mjs"]],
    ["G2 actions and habits", ["scripts/g2-actions-regression.mjs"]],
    ["G2 feedback and validation ledger", ["scripts/g2-feedback-regression.mjs"]],
    ["G2 integrated API and persistence", ["scripts/g2-integration-regression.mjs"]],
    ["AI settings, costs, usage and audit contracts", ["scripts/ai-domain-regression.mjs"]],
    ["AI site budget domain contracts", ["scripts/ai-budget-regression.mjs"]],
    ["AI site budget JSON persistence", ["scripts/ai-budget-persistence-regression.mjs"]],
    ["AI site budget runtime lifecycle", ["scripts/ai-budget-runtime-regression.mjs"]],
    ["AI application runtime composition", ["scripts/ai-runtime-regression.mjs"]],
    ["media application runtime composition", ["scripts/media-runtime-regression.mjs"]],
    ["content application runtime composition", ["scripts/content-runtime-regression.mjs"]],
    ["server HTTP orchestration adapters", ["scripts/http-orchestration-regression.mjs"]],
    ["server composition and lifecycle", ["scripts/server-runtime-regression.mjs"]],
    ["AI site budget Owner concurrency", ["scripts/ai-budget-control-version-regression.mjs"]],
    ["AI site budget Owner HTTP contract", ["scripts/ai-budget-http-regression.mjs"]],
    ["AI provider transport and attempt policy", ["scripts/ai-provider-regression.mjs"]],
    ["Volcengine speech, OCR and document transports", ["scripts/volcengine-provider-regression.mjs"]],
    ["Volcengine authenticated server integration", ["scripts/volcengine-server-regression.mjs"]],
    ["segmentation transport, audit and temporary lifecycle", ["scripts/segmentation-regression.mjs"]],
    ["keepsake records and event time contracts", ["scripts/keepsake-time-regression.mjs"]],
    ["onboarding, business prompts and personal context", ["scripts/personal-context-regression.mjs"]],
    ["onboarding v2 data compatibility", ["scripts/onboarding-v2-regression.mjs"]],
    ["onboarding v2 session API", ["scripts/onboarding-v2-session-regression.mjs"]],
    ["onboarding v2 frontend state", ["scripts/onboarding-v2-frontend-regression.mjs"]],
    ["user model claims and source lifecycle", ["scripts/user-model-claims-regression.mjs"]],
    ["user model API", ["scripts/user-model-api-regression.mjs"]],
    ["user model extraction tasks", ["scripts/user-model-extraction-regression.mjs"]],
    ["annotations, background tasks and notifications", ["scripts/collaboration-regression.mjs"]],
    ["trash, restore and durable attachment cleanup", ["scripts/trash-regression.mjs"]],
    ["backend regression", ["scripts/regression.mjs"]],
    ["authentication roles and versioned sessions", ["scripts/auth-role-regression.mjs"]],
    ["authentication and server deployment shape", ["scripts/auth-regression.mjs"]],
    ["authentication concurrency", ["scripts/auth-concurrency-regression.mjs"]],
    ["local test data modes", ["scripts/local-test-mode-regression.mjs"]],
    ["observability", ["scripts/observability-regression.mjs"]],
    ["attachment storage", ["scripts/attachment-storage-regression.mjs"]],
    ["attachment byte range streaming", ["scripts/attachment-range-regression.mjs"]],
    ["attachment uploads, quotas and recovery", ["scripts/attachment-upload-regression.mjs"]],
    ["capacity boundaries", ["scripts/boundaries-regression.mjs"]],
    ["backup recovery and readiness", ["scripts/backup-regression.mjs"]],
    ["monitoring", ["scripts/monitor-regression.mjs"]],
    ["restore validation", ["scripts/restore-validation-regression.mjs"]],
    ["deployment rollback", ["scripts/deploy-regression.mjs"]],
    ["isolated online Preview deployment", ["scripts/preview-deploy-regression.mjs"]]
  ],
  load: [
    ["isolated load regression", ["scripts/load-regression.mjs"]],
    ["isolated memory soak", ["scripts/memory-soak-regression.mjs"]]
  ],
  performance: [
    ["fixed-condition web performance gate", ["scripts/web-first-screen-budget-regression.mjs"]],
    ["attachment byte range streaming contract", ["scripts/attachment-range-regression.mjs"]]
  ],
  frontend: [
    ["browser application lifecycle", ["scripts/frontend-application-regression.mjs"]],
    ["browser session, state, sync and shell ports", ["scripts/frontend-app-ports-regression.mjs"]],
    ["disposable page router lifecycle", ["scripts/page-router-lifecycle-regression.mjs"]],
    ["frontend API, session and state contracts", ["scripts/frontend-contract-regression.mjs"]],
    ["durable mutation log and request coordinator", ["scripts/sync-coordinator-regression.mjs"]],
    ["frontend content, time and media contracts", ["scripts/frontend-shared-regression.mjs"]],
    ["opening lifecycle, rain and cleanup contracts", ["scripts/opening-controller-regression.mjs"]],
    ["frontend application shell and page lifecycle", ["scripts/frontend-shell-regression.mjs"]],
    ["frontend feature lifecycle", ["scripts/frontend-feature-lifecycle-regression.mjs"]],
    ["literal lazy descriptor and hidden-module boundaries", ["scripts/frontend-lazy-descriptor-regression.mjs"]],
    ["F2 actions coordinator and on-demand workspace", ["scripts/frontend-actions-feature-regression.mjs"]],
    ["F2 lazy export controller", ["scripts/frontend-export-feature-regression.mjs"]],
    ["F2 lazy feedback controller", ["scripts/frontend-feedback-feature-regression.mjs"]],
    ["F2 lazy discovery controller", ["scripts/frontend-discovery-feature-regression.mjs"]],
    ["F2 explicit legacy page adapters", ["scripts/frontend-legacy-page-feature-regression.mjs"]],
    ["F3 annotations lifecycle and account isolation", ["scripts/frontend-annotations-feature-regression.mjs"]],
    ["F3 background result lifecycle and cross-content location", ["scripts/frontend-background-results-feature-regression.mjs"]],
    ["F3 lazy notifications controller", ["scripts/frontend-notifications-feature-regression.mjs"]],
    ["notification entry states and retry interactions", ["scripts/notification-entry-regression.mjs"]],
    ["F4 check-in presentation lifecycle", ["scripts/frontend-checkins-feature-regression.mjs"]],
    ["F4 health media draft lifecycle", ["scripts/frontend-health-feature-regression.mjs"]],
    ["shared content image draft lifecycle", ["scripts/frontend-content-image-drafts-regression.mjs"]],
    ["shared page audio lifecycle", ["scripts/frontend-page-audio-regression.mjs"]],
    ["F5 thought presentation and runtime isolation", ["scripts/frontend-thoughts-feature-regression.mjs"]],
    ["F6 capture, audio and journal lifecycle", ["scripts/frontend-capture-journal-feature-regression.mjs"]],
    ["F7 library presentation and lifecycle", ["scripts/frontend-library-feature-regression.mjs"]],
    ["F7 quote presentation and lifecycle", ["scripts/frontend-quotes-feature-regression.mjs"]],
    ["F7 review insights and statistics lifecycle", ["scripts/frontend-review-insights-feature-regression.mjs"]],
    ["URL and browser history contracts", ["scripts/url-history-regression.mjs"]],
    ["PWA shell cache and private-data boundaries", ["scripts/pwa-regression.mjs"]],
    ["desktop and responsive UI", ["scripts/ui-regression.mjs"]],
    ["mobile platform simulation", ["scripts/mobile-platform-regression.mjs"]]
  ],
  exploration: [
    ["exploration UI isolation", ["scripts/exploration-regression.mjs"]]
  ]
};

if (![...Object.keys(suites), "all"].includes(requestedSuite)) {
  throw new Error(`未知系统测试分组：${requestedSuite}。可选值：backend、load、performance、frontend、exploration、all`);
}

let testNode = process.execPath;
let testNodeWorkspace;
if (process.platform === "darwin") {
  testNodeWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-system-test-node-"));
  try {
    testNode = await prepareTestNodeBinary(testNodeWorkspace);
  } catch (error) {
    await fs.rm(testNodeWorkspace, { recursive: true, force: true });
    throw error;
  }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const sourceEnvironment = args[1] === ISOLATION_PROBE ? {
      ...process.env,
      DATABASE_URL: "postgresql://production.invalid/live",
      AUTH_DATABASE_URL: "postgresql://production.invalid/auth",
      AI_BUDGET_DATABASE_URL: "postgresql://production.invalid/budget",
      APP_URL: "https://production.invalid/now/",
      OSS_ENDPOINT: "oss-production.invalid",
      OSS_BUCKET: "production-bucket",
      ALIYUN_ACCESS_KEY_ID: "production-secret",
      DEEPSEEK_API_KEY: "production-secret",
      VOLCENGINE_SPEECH_API_KEY: "production-secret",
      VOLCENGINE_ACCESS_KEY_ID: "production-secret",
      VOLCENGINE_SECRET_ACCESS_KEY: "production-secret",
      FEISHU_ALERT_WEBHOOK: "https://production.invalid/hook",
      PG_BACKUP_DATABASE_URL: "postgresql://production.invalid/backup",
      PG_SCHEMA_DATABASE_URL: "postgresql://production.invalid/schema",
      SYSTEM_TEST_ISOLATION_PROBE: "poisoned-parent"
    } : process.env;
    const child = spawn(testNode, args, {
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

const selected = requestedSuite === "all" ? ["backend", "frontend", "performance"] : [requestedSuite];
const results = [];
const totalStartedAt = Date.now();

try {
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
} finally {
  if (testNodeWorkspace) await fs.rm(testNodeWorkspace, { recursive: true, force: true });
}
