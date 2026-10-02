import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AI_BUDGET_POLICY,
  createAiBudgetService
} from "../src/modules/ai/index.mjs";
import {
  AI_BUDGET_DOCUMENT_FILE,
  createAiBudgetRepository
} from "../src/shared/persistence/index.mjs";

const RESTART_PROBE = "--restart-probe";

if (process.argv[2] === RESTART_PROBE) {
  const repository = createAiBudgetRepository({ dataRoot: process.argv[3] });
  process.stdout.write(`${JSON.stringify(await repository.read())}\n`);
  process.exit(0);
}

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ai-budget-"));
const file = path.join(root, AI_BUDGET_DOCUMENT_FILE);
const accountDirectory = path.join(root, "users", "account-a");
const policy = {
  ...AI_BUDGET_POLICY,
  userDailyKnownCostCny: 1000,
  userDailyCalls: 1000
};
const stage = id => ({
  id,
  provider: "deepseek",
  service: "chat-completions",
  scene: "thoughtAnswer",
  costKnown: true,
  estimatedCostCny: 60
});
const service = (repository, prefix) => {
  let sequence = 0;
  return createAiBudgetService({
    repository,
    policy,
    now: () => "2026-10-02T01:00:00.000Z",
    createId: () => `${prefix}-${++sequence}`
  });
};

try {
  await fs.mkdir(accountDirectory, { recursive: true });
  const firstRepository = createAiBudgetRepository({ dataRoot: root });
  const secondRepository = createAiBudgetRepository({ dataRoot: root });
  const firstService = service(firstRepository, "first");
  const secondService = service(secondRepository, "second");

  const reservations = await Promise.allSettled([
    firstService.reserveTask({
      accountId: "account-a",
      taskId: "account-a-task",
      stages: [stage("account-a-stage")]
    }),
    secondService.reserveTask({
      accountId: "account-b",
      taskId: "account-b-task",
      stages: [stage("account-b-stage")]
    })
  ]);
  assert.equal(reservations.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(
    reservations.find(item => item.status === "rejected").reason.code,
    "AI_SITE_DAILY_COST_LIMIT"
  );

  const state = await firstRepository.read();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.events.filter(item => item.type === "ai.budget.reservation_rejected").length, 1);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(path.join(accountDirectory, AI_BUDGET_DOCUMENT_FILE)));

  const beforeRollback = await fs.readFile(file, "utf8");
  await assert.rejects(firstRepository.update(document => {
    document.rollbackProbe = true;
    throw new Error("abort JSON budget mutation");
  }), /abort JSON budget mutation/);
  assert.equal(await fs.readFile(file, "utf8"), beforeRollback);

  const restarted = await run(process.execPath, [import.meta.filename, RESTART_PROBE, root], {
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 10_000
  });
  const restartedState = JSON.parse(restarted.stdout);
  assert.equal(restartedState.reservations.length, 1);
  assert.equal(restartedState.reservations[0].accountId, state.reservations[0].accountId);

  const corrupt = "{CORRUPT_AI_BUDGET_KEEP_ME";
  await fs.writeFile(file, corrupt, { mode: 0o600 });
  await assert.rejects(firstRepository.read(), error => error.code === "STORAGE_READ_FAILED");
  await assert.rejects(secondRepository.update(document => {
    document.mustNotReplaceCorruption = true;
  }), error => error.code === "STORAGE_READ_FAILED");
  assert.equal(await fs.readFile(file, "utf8"), corrupt);
  assert.deepEqual(
    (await fs.readdir(root)).filter(name => name.includes(`${AI_BUDGET_DOCUMENT_FILE}.`)),
    []
  );

  console.log("AI budget JSON persistence checks passed: root-level 0600 storage, cross-request serialization, atomic rollback, process restart and corrupt-file preservation.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
