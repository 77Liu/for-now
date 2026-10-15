import { createAiBudgetRuntime } from "../src/app/index.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AI_BUDGET_POLICY,
  createAiBudgetService, createDispatchAttempt
} from "../src/modules/ai/index.mjs";
import {
  AI_BUDGET_DOCUMENT_FILE,
  createAiBudgetRepository
} from "../src/shared/persistence/index.mjs";

const RESTART_PROBE = "--restart-probe";
const LOCK_WORKER = "--lock-worker";

if (process.argv[2] === RESTART_PROBE) {
  const repository = createAiBudgetRepository({ dataRoot: process.argv[3] });
  process.stdout.write(`${JSON.stringify(await repository.read())}\n`);
  process.exit(0);
}

if (process.argv[2] === LOCK_WORKER) {
  const repository = createAiBudgetRepository({
    dataRoot: process.argv[3],
    lockTimeoutMs: Number(process.env.TEST_LOCK_TIMEOUT_MS) || undefined,
    lockStaleMs: Number(process.env.TEST_LOCK_STALE_MS) || undefined,
    lockRetryMs: 10
  });
  await repository.update(async document => {
    process.stdout.write("LOCKED\n");
    await new Promise(resolve => setTimeout(resolve, Number(process.argv[5]) || 0));
    const field = process.argv[4];
    document[field] = Number(document[field] || 0) + 1;
  });
  process.stdout.write("DONE\n");
  process.exit(0);
}

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-ai-budget-"));
const file = path.join(root, AI_BUDGET_DOCUMENT_FILE);
const lockDirectory = `${file}.lock`;
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
const startLockWorker = (field, delayMs, environment = {}) => {
  const child = spawn(process.execPath, [
    import.meta.filename,
    LOCK_WORKER,
    root,
    field,
    String(delayMs)
  ], {
    env: { ...process.env, NODE_ENV: "test", ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let lockedResolve;
  const locked = new Promise(resolve => { lockedResolve = resolve; });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.includes("LOCKED\n")) lockedResolve();
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`AI budget lock worker exited with ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, locked, done };
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

  const workers = [
    startLockWorker("crossProcessUpdates", 100),
    startLockWorker("crossProcessUpdates", 100)
  ];
  await Promise.all(workers.map(worker => worker.done));
  assert.equal((await firstRepository.read()).crossProcessUpdates, 2);

  const crashed = startLockWorker("mustNotCommitAfterCrash", 30_000);
  const crashedDone = crashed.done.catch(error => error);
  await crashed.locked;
  crashed.child.kill("SIGKILL");
  await once(crashed.child, "exit");
  assert.match((await crashedDone).message, /exited with/);
  assert.equal((await fs.stat(lockDirectory)).isDirectory(), true);
  const recoveryRepository = createAiBudgetRepository({
    dataRoot: root,
    lockTimeoutMs: 2_000,
    lockStaleMs: 500,
    lockRetryMs: 10
  });
  await recoveryRepository.update(document => {
    document.recoveredAfterCrash = true;
  });
  assert.equal((await recoveryRepository.read()).recoveredAfterCrash, true);
  await assert.rejects(fs.access(lockDirectory));

  const holder = startLockWorker("timeoutHolderCommitted", 500, {
    TEST_LOCK_STALE_MS: "2000"
  });
  await holder.locked;
  const timeoutRepository = createAiBudgetRepository({
    dataRoot: root,
    lockTimeoutMs: 100,
    lockStaleMs: 2_000,
    lockRetryMs: 10
  });
  await assert.rejects(
    timeoutRepository.update(document => {
      document.mustNotCommitAfterTimeout = true;
    }),
    error => error.code === "STORAGE_LOCK_TIMEOUT"
  );
  await holder.done;
  const afterTimeout = await firstRepository.read();
  assert.equal(afterTimeout.timeoutHolderCommitted, 1);
  assert.equal(afterTimeout.mustNotCommitAfterTimeout, undefined);

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

  // F5证明经过原子JSON、独立进程读取和新runtime恢复，不能仅在内存中有效。
  const proofRoot = path.join(root, "proof");
  const proofRepository = createAiBudgetRepository({ dataRoot: proofRoot });
  const proofService = service(proofRepository, "proof");
  const pending = await proofService.reserveTask({ accountId: "f5-account", taskId: "f5-json-proof", stages: [stage("text")] });
  const dispatch = createDispatchAttempt(); const reservationId = pending.reservation.id;
  await proofService.startStage({ reservationId, stageId: "text", dispatchAttemptId: dispatch.id });
  dispatch.close(); await proofService.markStageNotInvoked({ reservationId, stageId: "text", dispatchAttemptId: dispatch.id }, dispatch.proof(reservationId, "text", "cancelled"));
  const proofRestart = await run(process.execPath, [import.meta.filename, RESTART_PROBE, proofRoot], { timeout: 10000 });
  const persisted = JSON.parse(proofRestart.stdout).reservations[0].stages[0];
  assert.equal(persisted.dispatchState, "not_invoked"); assert.ok(persisted.startedAt && persisted.noIoAt); assert.equal(persisted.dispatchAttemptId, dispatch.id);
  const proofRecovery = await createAiBudgetRuntime({ budget: service(createAiBudgetRepository({ dataRoot: proofRoot }), "recover-proof") }).recover();
  assert.deepEqual(proofRecovery.released, [reservationId]);
  const proofAfter = await proofService.read(); assert.equal(proofAfter.days[0].knownCostMicros, 0);
  assert.ok(proofAfter.events.some(event => event.type === "ai.budget.reservation_released" && event.stages[0].dispatchState === "not_invoked"));

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

  console.log("AI budget JSON persistence checks passed: root-level 0600 storage, cross-request and cross-process serialization, crash-lock recovery, bounded timeout, atomic rollback, process restart and corrupt-file preservation.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
