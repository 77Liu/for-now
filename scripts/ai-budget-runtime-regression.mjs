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

console.log("AI budget runtime regression passed: peak estimates, execution lifecycle, retries, actual usage costs, settlement safety and startup recovery.");
