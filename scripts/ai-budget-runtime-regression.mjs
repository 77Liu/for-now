import { createAiBudgetService, createExecutionControl, createDispatchAttempt } from "../src/modules/ai/index.mjs";
import { createAtomicRepository } from "./fixtures/atomic-json-repository.mjs";
import assert from "node:assert/strict";
import {
  createAiBudgetRuntime,
  deepSeekBudgetStages,
  estimateDeepSeekPeakCostCny
} from "../src/app/index.mjs";

const clone = value => structuredClone(value);

function createBudgetDouble({
  reservations = [],
  reserveError = null,
  settlementErrors = new Map()
} = {}) {
  const calls = [];
  const active = clone(reservations);
  return {
    calls,
    async read() {
      calls.push({ type: "read" });
      return { reservations: clone(active) };
    },
    async reserveTask(plan) {
      calls.push({ type: "reserve", plan: clone(plan) });
      if (reserveError) throw reserveError;
      const reservation = {
        id: `reservation-${plan.taskId}`,
        accountId: plan.accountId,
        taskId: plan.taskId,
        stages: plan.stages.map(stage => ({ ...clone(stage), startedAt: "" }))
      };
      active.push(reservation);
      return { reservation: clone(reservation), events: [] };
    },
    async startStage(input) {
      calls.push({ type: "start", input: clone(input) });
      const reservation = active.find(item => item.id === input.reservationId);
      const stage = reservation?.stages.find(item => item.id === input.stageId);
      if (!stage) throw new Error("test stage missing");
      stage.startedAt = "2026-10-02T09:00:00.000Z";
      return { reservation: clone(reservation) };
    },
    async settleTask(input) {
      calls.push({ type: "settle", input: clone(input) });
      const failure = settlementErrors.get(input.reservationId);
      if (failure) throw failure;
      const index = active.findIndex(item => item.id === input.reservationId);
      if (index >= 0) active.splice(index, 1);
      return { settlement: { stages: clone(input.stages) } };
    },
    async releaseTask(input) {
      calls.push({ type: "release", input: clone(input) });
      const index = active.findIndex(item => item.id === input.reservationId);
      if (index >= 0) active.splice(index, 1);
      return { released: index >= 0 };
    }
  };
}

const baseStages = overrides => deepSeekBudgetStages({
  model: "deepseek-flash",
  scene: "thoughtAnswer",
  maxInputTokens: 1_000,
  maxOutputTokens: 100,
  ...overrides
});

const plan = (taskId, stages = baseStages()) => ({
  accountId: "account-a",
  taskId,
  stages
});

assert.equal(estimateDeepSeekPeakCostCny({
  model: "deepseek-flash",
  maxInputTokens: 1_000,
  maxOutputTokens: 100
}), 0.0028);
const retryEstimate = baseStages({ maxAttempts: 2 });
assert.deepEqual(retryEstimate.map(stage => ({
  id: stage.id,
  estimatedCostCny: stage.estimatedCostCny
})), [
  { id: "deepseek-attempt-1", estimatedCostCny: 0.0028 },
  { id: "deepseek-attempt-2", estimatedCostCny: 0.0028 }
]);

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  const result = await runtime.executeTask(plan("success"), async ({ runStage }) => (
    runStage("deepseek-attempt-1", async ({ recordUsage }) => {
      assert.equal(budget.calls.at(-1).type, "start");
      assert.equal(recordUsage({ costKnown: true, costCny: 0.00125 }), true);
      return "provider-result";
    })
  ));
  assert.equal(result, "provider-result");
  assert.deepEqual(budget.calls.filter(call => call.type !== "reserve").map(call => call.type), [
    "start",
    "settle"
  ]);
  assert.deepEqual(budget.calls.find(call => call.type === "settle").input, {
    reservationId: "reservation-success",
    stages: [{
      stageId: "deepseek-attempt-1",
      started: true,
      actualCostCny: 0.00125
    }],
    outcome: "completed"
  });
}

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  await runtime.executeTask(plan("actual-unknown"), async ({ runStage }) => (
    runStage("deepseek-attempt-1", async ({ recordUsage }) => {
      assert.equal(recordUsage({ costKnown: false }), true);
    })
  ));
  assert.deepEqual(budget.calls.find(call => call.type === "settle").input, {
    reservationId: "reservation-actual-unknown",
    stages: [{
      stageId: "deepseek-attempt-1",
      started: true,
      costKnown: false
    }],
    outcome: "completed"
  });
}

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  await runtime.executeTask(plan("usage-omitted"), async ({ runStage }) => (
    runStage("deepseek-attempt-1", async () => {})
  ));
  assert.deepEqual(budget.calls.find(call => call.type === "settle").input, {
    reservationId: "reservation-usage-omitted",
    stages: [{
      stageId: "deepseek-attempt-1",
      started: true
    }],
    outcome: "completed"
  });
}

{
  const rejection = Object.assign(new Error("budget rejected"), {
    code: "AI_SITE_DAILY_COST_LIMIT"
  });
  const budget = createBudgetDouble({ reserveError: rejection });
  const runtime = createAiBudgetRuntime({ budget });
  let executed = false;
  await assert.rejects(
    runtime.executeTask(plan("rejected"), async () => {
      executed = true;
    }),
    error => error === rejection
  );
  assert.equal(executed, false);
  assert.deepEqual(budget.calls.map(call => call.type), ["reserve"]);
}

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  assert.equal(await runtime.executeTask(plan("no-io"), async () => "cached"), "cached");
  assert.deepEqual(budget.calls.find(call => call.type === "release").input, {
    reservationId: "reservation-no-io",
    reason: "completed_without_io"
  });

  const failedBudget = createBudgetDouble();
  const failedRuntime = createAiBudgetRuntime({ budget: failedBudget });
  const preflightError = new Error("preflight failed");
  await assert.rejects(
    failedRuntime.executeTask(plan("preflight"), async () => {
      throw preflightError;
    }),
    error => error === preflightError
  );
  assert.equal(failedBudget.calls.some(call => call.type === "settle"), false);
  assert.deepEqual(failedBudget.calls.find(call => call.type === "release").input, {
    reservationId: "reservation-preflight",
    reason: "failed_before_io"
  });
}

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  const providerError = new Error("provider failed");
  await assert.rejects(
    runtime.executeTask(plan("failed-io"), async ({ runStage }) => {
      await runStage("deepseek-attempt-1", async ({ recordUsage }) => {
        recordUsage({ costKnown: true, costCny: 0.0007 });
        throw providerError;
      });
    }),
    error => error === providerError
  );
  assert.equal(budget.calls.some(call => call.type === "release"), false);
  assert.deepEqual(budget.calls.find(call => call.type === "settle").input, {
    reservationId: "reservation-failed-io",
    stages: [{
      stageId: "deepseek-attempt-1",
      started: true,
      actualCostCny: 0.0007
    }],
    outcome: "failed"
  });
}

{
  const budget = createBudgetDouble();
  const runtime = createAiBudgetRuntime({ budget });
  const stages = baseStages({ maxAttempts: 2 });
  const result = await runtime.executeTask(plan("retry", stages), async ({ runStage }) => {
    await assert.rejects(
      runStage("deepseek-attempt-1", async ({ recordUsage }) => {
        recordUsage({ costKnown: true, costCny: 0.0004 });
        throw new Error("retryable");
      }),
      /retryable/
    );
    return runStage("deepseek-attempt-2", async ({ recordUsage }) => {
      recordUsage({ costKnown: true, costsCny: { total: 0.0009 } });
      return "retried";
    });
  });
  assert.equal(result, "retried");
  assert.deepEqual(
    budget.calls.filter(call => call.type === "start").map(call => call.input.stageId),
    ["deepseek-attempt-1", "deepseek-attempt-2"]
  );
  assert.deepEqual(budget.calls.find(call => call.type === "settle").input.stages, [
    { stageId: "deepseek-attempt-1", started: true, actualCostCny: 0.0004 },
    { stageId: "deepseek-attempt-2", started: true, actualCostCny: 0.0009 }
  ]);
}

{
  const settlementError = new Error("settlement unavailable");
  const budget = createBudgetDouble({
    settlementErrors: new Map([["reservation-settlement-failure", settlementError]])
  });
  const runtime = createAiBudgetRuntime({ budget });
  await assert.rejects(
    runtime.executeTask(plan("settlement-failure"), async ({ runStage }) => (
      runStage("deepseek-attempt-1", async () => "completed")
    )),
    error => error === settlementError
  );
  assert.equal(budget.calls.filter(call => call.type === "settle").length, 1);
  assert.equal(budget.calls.some(call => call.type === "release"), false);
}

{
  const recoverySettlementError = new Error("recovery settlement unavailable");
  const budget = createBudgetDouble({
    reservations: [
      {
        id: "recovery-unstarted",
        stages: [{ id: "attempt-1", estimatedCostMicros: 2_800, startedAt: "" }]
      },
      {
        id: "recovery-started",
        stages: [
          { id: "attempt-1", estimatedCostMicros: 2_800, startedAt: "2026-10-02T08:00:00.000Z" },
          { id: "attempt-2", estimatedCostMicros: 2_800, startedAt: "" }
        ]
      },
      {
        id: "recovery-settlement-failure",
        stages: [{ id: "attempt-1", estimatedCostMicros: 2_800, startedAt: "2026-10-02T08:00:00.000Z" }]
      }
    ],
    settlementErrors: new Map([
      ["recovery-settlement-failure", recoverySettlementError]
    ])
  });
  const reported = [];
  const runtime = createAiBudgetRuntime({
    budget,
    onRecoveryError: (error, context) => {
      reported.push({ error, context });
    }
  });
  const report = await runtime.recover();
  assert.equal(report.scanned, 3);
  assert.deepEqual(report.released, ["recovery-unstarted"]);
  assert.deepEqual(report.settled, ["recovery-started"]);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].error, recoverySettlementError);
  assert.deepEqual(reported, [{
    error: recoverySettlementError,
    context: {
      action: "settle",
      reservationId: "recovery-settlement-failure"
    }
  }]);
  assert.deepEqual(
    budget.calls.filter(call => call.type === "release").map(call => call.input.reservationId),
    ["recovery-unstarted"]
  );
  const recoverySettlements = budget.calls.filter(call => call.type === "settle");
  assert.deepEqual(recoverySettlements.map(call => call.input), [
    {
      reservationId: "recovery-started",
      stages: [{ stageId: "attempt-1", started: true }],
      outcome: "interrupted"
    },
    {
      reservationId: "recovery-settlement-failure",
      stages: [{ stageId: "attempt-1", started: true }],
      outcome: "interrupted"
    }
  ]);
  assert.equal(recoverySettlements.some(call => (
    call.input.stages.some(stage => Object.hasOwn(stage, "actualCostCny"))
  )), false);
}

// 仅证明未启动provider的已知额度拒绝才带等待标记。
for (const code of ["AI_DAILY_CALL_LIMIT", "AI_RECORD_COMPRESSION_DAILY_LIMIT", "AI_SITE_DAILY_COST_LIMIT"]) {
  const error = Object.assign(new Error("quota admission"), { code });
  const budget = createBudgetDouble({ reserveError: error });
  let executed = false;
  await assert.rejects(createAiBudgetRuntime({ budget }).executeTask(plan(`admission-${code}`), async () => { executed = true; }), caught => {
    assert.equal(caught.budgetAdmissionRejected, true);
    return true;
  });
  assert.equal(executed, false);
  assert.deepEqual(budget.calls.map(call => call.type), ["reserve"]);
}
for (const code of ["AI_BUDGET_RESERVATION_CONFLICT", "AI_RECORD_COMPRESSION_COST_UNKNOWN", "INVALID_PLAN"]) {
  const error = Object.assign(new Error("not quota"), { code });
  await assert.rejects(createAiBudgetRuntime({ budget: createBudgetDouble({ reserveError: error }) })
    .executeTask(plan(`nonquota-${code}`), async () => {}), caught => {
      assert.equal(caught.budgetAdmissionRejected, undefined);
      return true;
    });
}
const preStageBudget = createBudgetDouble();
await assert.rejects(createAiBudgetRuntime({ budget: preStageBudget }).executeTask(plan("quota-before-stage"), async () => {
  throw Object.assign(new Error("generation reserveAttempt quota"), { code: "AI_DAILY_CALL_LIMIT" });
}), error => { assert.equal(error.budgetAdmissionRejected, true); return true; });
assert.deepEqual(preStageBudget.calls.map(call => call.type), ["reserve", "release"]);
const paidStageBudget = createBudgetDouble();
await assert.rejects(createAiBudgetRuntime({ budget: paidStageBudget }).executeTask(plan("quota-after-stage"), async ({ runStage }) => {
  await runStage("deepseek-attempt-1", async () => {
    throw Object.assign(new Error("paid/unknown result"), { code: "AI_DAILY_CALL_LIMIT", budgetAdmissionRejected: true });
  });
}), error => { assert.equal(error.budgetAdmissionRejected, undefined); return true; });
assert.deepEqual(paidStageBudget.calls.map(call => call.type), ["reserve", "start", "settle"]);
const failedReleaseBudget = createBudgetDouble();
failedReleaseBudget.releaseTask = async () => { throw new Error("release failed"); };
await assert.rejects(createAiBudgetRuntime({ budget: failedReleaseBudget }).executeTask(plan("quota-release-failed"), async () => {
  throw Object.assign(new Error("quota before IO"), { code: "AI_DAILY_CALL_LIMIT" });
}), error => { assert.ok(error instanceof AggregateError); assert.equal(error.budgetAdmissionRejected, undefined); return true; });

// F5使用真实预算消费者，分别确认start已持久化/未发、证明失败与崩溃恢复，不能用空白账本模拟通过。
{
  const make = () => {
    const repository = createAtomicRepository({}); let sequence = 0;
    const budget = createAiBudgetService({ repository, now: () => "2026-10-16T01:00:00.000Z", createId: () => `f5-${++sequence}` });
    return { budget, repository };
  };
  const plan = taskId => ({ accountId: "f5-account", taskId, stages: [{ id: "text", provider: "deepseek", service: "chat-completions", scene: "thoughtAnswer", costKnown: true, estimatedCostCny: 0.1 }] });
  for (const proofFails of [false, true]) {
    const { budget } = make(); const controller = new AbortController();
    const control = createExecutionControl({ signal: controller.signal, timeoutMs: 1000 });
    let proofSnapshot, callbacks = 0;
    const guardedBudget = { ...budget,
      startStage: async input => { const value = await budget.startStage(input); controller.abort(); return value; },
      markStageNotInvoked: async (...args) => { if (proofFails) throw new Error("proof persistence failed"); const value = await budget.markStageNotInvoked(...args); proofSnapshot = await budget.read(); return value; }
    };
    const runtime = createAiBudgetRuntime({ budget: guardedBudget });
    await assert.rejects(runtime.executeTask(plan(`cancel-${proofFails}`), execution => execution.runStage("text", () => { callbacks++; }, { control, dispatchGuard: () => control.throwIfStopped() }), { control }), error => error.code === "AI_TASK_CANCELLED" && (!proofFails || error instanceof AggregateError && error.cleanupFailed));
    control.dispose(); assert.equal(callbacks, 0);
    const after = await budget.read(); assert.equal(after.reservations.length, 0);
    assert.equal(after.days[0].knownCostMicros, proofFails ? 100000 : 0);
    if (!proofFails) { const stage = proofSnapshot.reservations[0].stages[0]; assert.ok(stage.startedAt); assert.equal(stage.dispatchState, "not_invoked"); assert.ok(stage.noIoAt); }
  }
  {
    const { budget } = make(); const reserved = await budget.reserveTask(plan("proof-recovery"));
    const attempt = createDispatchAttempt(); const id = reserved.reservation.id;
    await budget.startStage({ reservationId: id, stageId: "text", dispatchAttemptId: attempt.id });
    await assert.rejects(budget.markStageNotInvoked({ reservationId: id, stageId: "text", dispatchAttemptId: attempt.id }, {}), { code: "AI_BUDGET_PROOF_INVALID" });
    attempt.close(); const capability = attempt.proof(id, "text", "cancelled");
    const proof = { reservationId: id, stageId: "text", dispatchAttemptId: attempt.id };
    await budget.markStageNotInvoked(proof, capability); assert.equal((await budget.markStageNotInvoked(proof, capability)).duplicate, true);
    const recovery = await createAiBudgetRuntime({ budget }).recover(); assert.deepEqual(recovery.released, [id]);
    assert.equal((await budget.read()).days[0].knownCostMicros, 0);
    assert.equal((await budget.markStageNotInvoked(proof, capability)).duplicate, true);
    assert.equal((await createAiBudgetRuntime({ budget }).recover()).scanned, 0);
  }
  {
    const { budget } = make(); const reserved = await budget.reserveTask(plan("legacy-unknown"));
    await budget.startStage({ reservationId: reserved.reservation.id, stageId: "text" });
    const recovery = await createAiBudgetRuntime({ budget }).recover(); assert.equal(recovery.settled.length, 1);
    assert.equal((await budget.read()).days[0].knownCostMicros, 100000, "legacy or unknown start must remain conservative");
    const invoked = createDispatchAttempt(); invoked.invoke(() => {}, () => {}); invoked.close();
    assert.throws(() => invoked.proof("reservation", "stage", "cancelled"), /不能证明未调用/);
  }
}

console.log("AI budget runtime regression passed: peak estimates, execution lifecycle, retries, actual usage costs, settlement safety and startup recovery.");
