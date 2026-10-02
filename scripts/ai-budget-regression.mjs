import assert from "node:assert/strict";
import {
  AI_BUDGET_ALERT_THRESHOLDS,
  AI_BUDGET_POLICY,
  createAiBudgetService,
  normalizeAiBudgetState
} from "../src/modules/ai/index.mjs";

function createAtomicRepository(initial = {}) {
  let document = structuredClone(initial);
  let queue = Promise.resolve();
  return {
    async read() {
      await queue;
      return structuredClone(document);
    },
    update(mutator) {
      const operation = queue.then(async () => {
        const working = structuredClone(document);
        const result = await mutator(working);
        document = structuredClone(working);
        return structuredClone(result);
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

function idFactory(prefix) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

const known = (id, estimatedCostCny, overrides = {}) => ({
  id,
  provider: "deepseek",
  service: "chat-completions",
  scene: "thoughtAnswer",
  costKnown: true,
  estimatedCostCny,
  ...overrides
});
const unknown = (id, overrides = {}) => ({
  id,
  provider: "volcengine",
  service: "speech",
  action: "streamingAsr",
  scene: "speechRecognition",
  costKnown: false,
  billingGap: "合同单价和运行时计量单位尚未完成映射",
  ...overrides
});
const serviceFor = ({
  initial = {},
  policy = AI_BUDGET_POLICY,
  clock = { value: "2026-10-02T01:00:00.000Z" },
  repository = createAtomicRepository(initial),
  prefix = "budget"
} = {}) => ({
  repository,
  clock,
  service: createAiBudgetService({
    repository,
    policy,
    now: () => clock.value,
    createId: idFactory(prefix)
  })
});

assert.equal(AI_BUDGET_POLICY.userDailyKnownCostCny, 14.4);
assert.equal(AI_BUDGET_POLICY.userDailyCalls, 200);
assert.equal(AI_BUDGET_POLICY.siteDailyKnownCostCny, 100);
assert.equal(AI_BUDGET_POLICY.siteMonthlyKnownCostCny, 2000);
assert.equal(AI_BUDGET_POLICY.siteDailyUnknownCalls, 10);
assert.equal(AI_BUDGET_POLICY.dailyAdditionMaxCny, 100);
assert.equal(AI_BUDGET_POLICY.monthlyAdditionMaxCny, 2000);
assert.deepEqual(AI_BUDGET_ALERT_THRESHOLDS, [30, 50, 60, 70, 80, 90, 95, 99, 100]);

const normalized = normalizeAiBudgetState({
  version: 999,
  days: [
    { key: "invalid", knownCostMicros: -1 },
    {
      key: "2026-10-02",
      knownCostMicros: 12,
      users: [{ accountId: "a", calls: 1 }, { accountId: "a", calls: 2 }]
    }
  ],
  months: [{ key: "2026-10", knownCostMicros: 12 }],
  reservations: [{ id: "", stages: [] }],
  events: [{ id: "event-1", type: "test", createdAt: "2026-10-02T01:00:00.000Z" }]
});
assert.equal(normalized.version, 1);
assert.equal(normalized.days.length, 1);
assert.deepEqual(normalized.days[0].users, [{ accountId: "a", calls: 3, knownCostMicros: 0 }]);
assert.doesNotThrow(() => JSON.parse(JSON.stringify(normalized)));

// Budget periods are explicit UTC keys and do not depend on the host timezone.
{
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ["Pacific/Honolulu", "Asia/Shanghai"]) {
      process.env.TZ = timezone;
      const { service } = serviceFor({
        clock: { value: "2026-10-01T00:30:00.000Z" },
        prefix: `timezone-${timezone}`
      });
      const reservation = (await service.reserveTask({
        accountId: `account-${timezone}`,
        taskId: "utc-period",
        stages: [known("model", 1)]
      })).reservation;
      assert.equal(reservation.day, "2026-10-01");
      assert.equal(reservation.month, "2026-10");
      assert.equal((await service.status()).day.key, "2026-10-01");
      assert.equal((await service.status()).month.key, "2026-10");
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
}

// Existing single-user limits remain active alongside the site-wide budget.
{
  const { service } = serviceFor({ prefix: "user-cost" });
  const reservation = (await service.reserveTask({
    accountId: "user-a",
    taskId: "cost-at-limit",
    stages: [known("deepseek", 14.4)]
  })).reservation;
  await service.settleTask({
    reservationId: reservation.id,
    stages: [{ stageId: "deepseek", started: true, actualCostCny: 14.4 }]
  });
  await assert.rejects(service.reserveTask({
    accountId: "user-a",
    taskId: "cost-over-limit",
    stages: [known("deepseek", 0.001)]
  }), { code: "AI_DAILY_COST_LIMIT" });
}
{
  const { service } = serviceFor({ prefix: "user-calls" });
  const stages = Array.from({ length: 200 }, (_, index) => known(`call-${index + 1}`, 0));
  const reservation = (await service.reserveTask({
    accountId: "user-b",
    taskId: "calls-at-limit",
    stages
  })).reservation;
  await service.settleTask({
    reservationId: reservation.id,
    stages: stages.map(stage => ({ stageId: stage.id, started: true, actualCostCny: 0 }))
  });
  await assert.rejects(service.reserveTask({
    accountId: "user-b",
    taskId: "calls-over-limit",
    stages: [known("call-201", 0)]
  }), { code: "AI_DAILY_CALL_LIMIT" });
}

// Concurrent reservations serialize through one durable document.
{
  const { service } = serviceFor({
    prefix: "concurrent",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const results = await Promise.allSettled([
    service.reserveTask({ accountId: "a", taskId: "a-60", stages: [known("a", 60)] }),
    service.reserveTask({ accountId: "b", taskId: "b-60", stages: [known("b", 60)] })
  ]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.code, "AI_SITE_DAILY_COST_LIMIT");
  const state = await service.read();
  assert.equal(state.reservations.length, 1);
  assert.equal((await service.status()).day.reservedKnownCostCny, 60);
  assert.equal(state.events.filter(item => item.type === "ai.budget.reservation_rejected").length, 1);
}

// A composite task either reserves every stage or reserves nothing.
{
  const { service } = serviceFor({
    prefix: "composite",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      siteDailyUnknownCalls: 1
    }
  });
  await service.reserveTask({
    accountId: "first",
    taskId: "holds-unknown-slot",
    stages: [unknown("asr")]
  });
  await assert.rejects(service.reserveTask({
    accountId: "second",
    taskId: "ocr-and-model",
    stages: [
      unknown("ocr", { service: "vision", scene: "visionOcr" }),
      known("model", 10)
    ]
  }), error => {
    assert.equal(error.code, "AI_SITE_DAILY_UNKNOWN_COST_LIMIT");
    assert.ok(error.reasons.some(item => item.scope === "siteDailyUnknownCost"));
    return true;
  });
  const state = await service.read();
  assert.deepEqual(state.reservations.map(item => item.taskId), ["holds-unknown-slot"]);
  assert.equal((await service.status()).day.reservedKnownCostCny, 0);
}

// Persisted holds survive service recreation and can only be released before a stage starts.
{
  const shared = serviceFor({
    prefix: "persistent-a",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const held = (await shared.service.reserveTask({
    accountId: "persisted",
    taskId: "held",
    stages: [known("model", 60)]
  })).reservation;
  const duplicate = (await shared.service.reserveTask({
    accountId: "persisted",
    taskId: "held",
    stages: [known("model", 60)]
  })).reservation;
  assert.equal(duplicate.id, held.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await shared.service.read()).reservations.length, 1);
  const reloaded = createAiBudgetService({
    repository: shared.repository,
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    },
    now: () => shared.clock.value,
    createId: idFactory("persistent-b")
  });
  await assert.rejects(reloaded.reserveTask({
    accountId: "other",
    taskId: "blocked-by-hold",
    stages: [known("model", 50)]
  }), { code: "AI_SITE_DAILY_COST_LIMIT" });
  assert.equal((await reloaded.releaseTask({ reservationId: held.id, reason: "capacity unavailable" })).released, true);
  const next = await reloaded.reserveTask({
    accountId: "other",
    taskId: "after-release",
    stages: [known("model", 50)]
  });
  await reloaded.startStage({ reservationId: next.reservation.id, stageId: "model" });
  await assert.rejects(reloaded.releaseTask({ reservationId: next.reservation.id }), {
    code: "AI_BUDGET_STAGE_ALREADY_STARTED"
  });
}

// An unstarted reservation expires at the UTC day boundary and is released atomically.
{
  const clock = { value: "2026-10-02T23:59:59.999Z" };
  const { service } = serviceFor({
    clock,
    prefix: "expired-day",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const reservation = (await service.reserveTask({
    accountId: "expired-user",
    taskId: "expired-before-start",
    stages: [known("model", 60)]
  })).reservation;
  clock.value = "2026-10-03T00:00:00.000Z";
  await assert.rejects(service.startStage({
    reservationId: reservation.id,
    stageId: "model"
  }), error => {
    assert.equal(error.code, "AI_BUDGET_RESERVATION_EXPIRED");
    assert.equal(error.statusCode, 409);
    assert.equal(error.reservedDay, "2026-10-02");
    assert.equal(error.currentDay, "2026-10-03");
    assert.equal(error.released, true);
    assert.equal(error.requiresSettlement, false);
    assert.ok(error.eventId);
    return true;
  });
  const state = await service.read();
  assert.equal(state.reservations.length, 0);
  assert.ok(state.events.some(item => item.type === "ai.budget.reservation_released"
    && item.reservationId === reservation.id
    && item.reason === "period_expired"
    && item.periodKey === "2026-10-02"
    && item.currentPeriodKey === "2026-10-03"));
  const current = await service.reserveTask({
    accountId: "expired-user",
    taskId: "expired-before-start",
    stages: [known("model", 60)]
  });
  assert.equal(current.reservation.day, "2026-10-03");
}

// Unknown-cost slots are reserved up front, while one warning is emitted per real call.
{
  const clock = { value: "2026-10-02T01:00:00.000Z" };
  const { service } = serviceFor({ clock, prefix: "unknown" });
  const stages = Array.from({ length: 10 }, (_, index) => unknown(`unknown-${index + 1}`));
  const reservation = (await service.reserveTask({
    accountId: "unknown-user",
    taskId: "ten-unknown-calls",
    stages
  })).reservation;
  await assert.rejects(service.reserveTask({
    accountId: "other",
    taskId: "eleventh",
    stages: [unknown("unknown-11")]
  }), { code: "AI_SITE_DAILY_UNKNOWN_COST_LIMIT" });
  for (const stage of stages) {
    const started = await service.startStage({ reservationId: reservation.id, stageId: stage.id });
    assert.equal(started.event.type, "ai.budget.unknown_cost_warning");
    assert.equal(started.event.provider, "volcengine");
    assert.equal(started.event.service, "speech");
    assert.equal(started.event.scene, "speechRecognition");
    assert.match(started.event.billingGap, /合同单价/);
  }
  assert.equal((await service.startStage({
    reservationId: reservation.id,
    stageId: stages[0].id
  })).event, null);
  await service.settleTask({ reservationId: reservation.id });
  const state = await service.read();
  assert.equal(state.events.filter(item => item.type === "ai.budget.unknown_cost_warning").length, 10);
  assert.equal((await service.status()).day.committedUnknownCalls, 10);
  const knownAfterUnknownLimit = (await service.reserveTask({
    accountId: "known-user",
    taskId: "known-cost-still-allowed",
    stages: [known("known-call", 1)]
  })).reservation;
  await service.releaseTask({ reservationId: knownAfterUnknownLimit.id });
  clock.value = "2026-10-03T01:00:00.000Z";
  await assert.doesNotReject(service.reserveTask({
    accountId: "unknown-user",
    taskId: "new-day",
    stages: [unknown("new-day-call")]
  }));
}

// Settlement cannot retroactively start an expired reservation or charge its old period.
// Work started in the new period consumes the new period's capacity.
{
  const clock = { value: "2026-10-31T23:59:59.999Z" };
  const { service } = serviceFor({
    clock,
    prefix: "unstarted-rollover",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const reservation = (await service.reserveTask({
    accountId: "rollover-bypass-user",
    taskId: "unstarted-rollover",
    stages: [known("model", 60)]
  })).reservation;
  clock.value = "2026-11-01T00:00:00.000Z";
  await assert.rejects(service.settleTask({
    reservationId: reservation.id,
    stages: [{ stageId: "model", started: true, actualCostCny: 60 }]
  }), error => {
    assert.equal(error.code, "AI_BUDGET_RESERVATION_EXPIRED");
    assert.equal(error.statusCode, 409);
    assert.equal(error.reservedDay, "2026-10-31");
    assert.equal(error.reservedMonth, "2026-10");
    assert.equal(error.currentDay, "2026-11-01");
    assert.equal(error.currentMonth, "2026-11");
    assert.equal(error.released, true);
    assert.equal(error.requiresSettlement, false);
    assert.ok(error.eventId);
    return true;
  });
  const expired = await service.read();
  assert.equal(expired.reservations.length, 0);
  assert.equal(expired.days.find(day => day.key === "2026-10-31").knownCostMicros, 0);
  assert.equal(expired.months.find(month => month.key === "2026-10").knownCostMicros, 0);
  assert.equal(expired.days.some(day => day.key === "2026-11-01"), false);
  assert.equal(expired.months.some(month => month.key === "2026-11"), false);
  assert.ok(expired.events.some(item => item.type === "ai.budget.reservation_released"
    && item.reservationId === reservation.id
    && item.reason === "period_expired"));

  const current = (await service.reserveTask({
    accountId: "rollover-bypass-user",
    taskId: "current-period-work",
    stages: [known("model", 60)]
  })).reservation;
  await service.startStage({ reservationId: current.id, stageId: "model" });
  await service.settleTask({
    reservationId: current.id,
    stages: [{ stageId: "model", actualCostCny: 60 }]
  });
  await assert.rejects(service.reserveTask({
    accountId: "other-current-user",
    taskId: "current-period-over-limit",
    stages: [known("model", 50)]
  }), { code: "AI_SITE_DAILY_COST_LIMIT" });
}

// A partially started reservation cannot start more work after UTC month rollover.
// Its started work settles against the reservation's original UTC day and month.
{
  const clock = { value: "2026-10-31T23:59:59.999Z" };
  const { service } = serviceFor({
    clock,
    prefix: "started-rollover",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const reservation = (await service.reserveTask({
    accountId: "rollover-user",
    taskId: "partially-started",
    stages: [known("started", 20), known("not-started", 30)]
  })).reservation;
  await service.startStage({ reservationId: reservation.id, stageId: "started" });
  clock.value = "2026-11-01T00:00:00.000Z";
  assert.equal((await service.startStage({
    reservationId: reservation.id,
    stageId: "started"
  })).duplicate, true);
  await assert.rejects(service.startStage({
    reservationId: reservation.id,
    stageId: "not-started"
  }), error => {
    assert.equal(error.code, "AI_BUDGET_RESERVATION_EXPIRED");
    assert.equal(error.reservedDay, "2026-10-31");
    assert.equal(error.reservedMonth, "2026-10");
    assert.equal(error.currentDay, "2026-11-01");
    assert.equal(error.currentMonth, "2026-11");
    assert.equal(error.released, false);
    assert.equal(error.requiresSettlement, true);
    return true;
  });
  await assert.rejects(service.settleTask({
    reservationId: reservation.id,
    stages: [
      { stageId: "started", actualCostCny: 25 },
      { stageId: "not-started", started: true, actualCostCny: 30 }
    ]
  }), error => {
    assert.equal(error.code, "AI_BUDGET_RESERVATION_EXPIRED");
    assert.equal(error.released, false);
    assert.equal(error.requiresSettlement, true);
    return true;
  });
  const retained = await service.read();
  assert.equal(retained.reservations.length, 1);
  assert.ok(retained.reservations[0].stages.find(stage => stage.id === "started").startedAt);
  assert.equal(retained.reservations[0].stages.find(stage => stage.id === "not-started").startedAt, "");
  const settled = await service.settleTask({
    reservationId: reservation.id,
    stages: [{ stageId: "started", actualCostCny: 25 }]
  });
  assert.deepEqual({
    accountingDay: settled.settlement.accountingDay,
    accountingMonth: settled.settlement.accountingMonth,
    settledAtDay: settled.settlement.settledAtDay,
    settledAtMonth: settled.settlement.settledAtMonth
  }, {
    accountingDay: "2026-10-31",
    accountingMonth: "2026-10",
    settledAtDay: "2026-11-01",
    settledAtMonth: "2026-11"
  });
  assert.deepEqual(
    settled.settlement.stages.map(stage => ({ stageId: stage.stageId, started: stage.started })),
    [
      { stageId: "started", started: true },
      { stageId: "not-started", started: false }
    ]
  );
  const state = await service.read();
  assert.equal(state.days.find(day => day.key === "2026-10-31").knownCostMicros, 25_000_000);
  assert.equal(state.months.find(month => month.key === "2026-10").knownCostMicros, 25_000_000);
  assert.equal(state.days.some(day => day.key === "2026-11-01"), false);
  assert.equal(state.months.some(month => month.key === "2026-11"), false);
  const settlementEvent = state.events.find(item => item.type === "ai.budget.reservation_settled"
    && item.reservationId === reservation.id);
  assert.equal(settlementEvent.periodKey, "2026-10-31");
  assert.equal(settlementEvent.monthKey, "2026-10");
  assert.equal(settlementEvent.settledAtPeriodKey, "2026-11-01");
  assert.equal(settlementEvent.settledAtMonthKey, "2026-11");
  const currentStatus = await service.status({ accountId: "rollover-user" });
  assert.equal(currentStatus.day.committedKnownCostCny, 0);
  assert.equal(currentStatus.month.committedKnownCostCny, 0);
  assert.equal(currentStatus.user.committedCalls, 0);
}

// Daily and monthly thresholds are emitted once per effective limit and period.
{
  const clock = { value: "2026-10-01T01:00:00.000Z" };
  const { service } = serviceFor({
    clock,
    prefix: "threshold",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  for (let day = 1; day <= 20; day += 1) {
    clock.value = `2026-10-${String(day).padStart(2, "0")}T01:00:00.000Z`;
    const reservation = (await service.reserveTask({
      accountId: `account-${day}`,
      taskId: `day-${day}`,
      stages: [known("model", 100)]
    })).reservation;
    await service.settleTask({
      reservationId: reservation.id,
      stages: [{ stageId: "model", started: true, actualCostCny: 100 }]
    });
  }
  const state = await service.read();
  assert.deepEqual(
    state.events
      .filter(item => item.type === "ai.budget.threshold_reached"
        && item.scope === "siteDailyKnownCost"
        && item.periodKey === "2026-10-01")
      .map(item => item.thresholdPct),
    AI_BUDGET_ALERT_THRESHOLDS
  );
  assert.deepEqual(
    state.events
      .filter(item => item.type === "ai.budget.threshold_reached"
        && item.scope === "siteMonthlyKnownCost")
      .map(item => item.thresholdPct),
    AI_BUDGET_ALERT_THRESHOLDS
  );
  clock.value = "2026-10-21T01:00:00.000Z";
  await assert.rejects(service.reserveTask({
    accountId: "month-full",
    taskId: "month-full",
    stages: [known("model", 0)]
  }), { code: "AI_SITE_MONTHLY_COST_LIMIT" });
  clock.value = "2026-11-01T01:00:00.000Z";
  await assert.doesNotReject(service.reserveTask({
    accountId: "new-month",
    taskId: "new-month",
    stages: [known("model", 1)]
  }));
}

// Actual cost can exceed the estimate; settlement records it and blocks subsequent work.
{
  const { service } = serviceFor({
    prefix: "actual",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const reservation = (await service.reserveTask({
    accountId: "actual-user",
    taskId: "underestimated",
    stages: [known("model", 20)]
  })).reservation;
  await service.settleTask({
    reservationId: reservation.id,
    stages: [{ stageId: "model", started: true, actualCostCny: 100 }]
  });
  const status = await service.status({ accountId: "actual-user" });
  assert.equal(status.day.committedKnownCostCny, 100);
  assert.equal(status.day.blocked.knownCost, true);
  assert.equal(status.user.committedKnownCostCny, 100);
}

// Owner operations are auditable domain commands. They never authorize a caller or erase usage.
{
  const { service } = serviceFor({
    prefix: "owner",
    policy: {
      ...AI_BUDGET_POLICY,
      userDailyKnownCostCny: 1000,
      userDailyCalls: 1000
    }
  });
  const reservation = (await service.reserveTask({
    accountId: "owner-test",
    taskId: "fill-day",
    stages: [known("model", 100)]
  })).reservation;
  await service.settleTask({
    reservationId: reservation.id,
    stages: [{ stageId: "model", started: true, actualCostCny: 100 }]
  });
  const addition = await service.ownerAddTemporaryBudget({
    scope: "daily",
    amountCny: 100,
    actorId: "owner-account",
    reason: "经 Owner 明确确认的临时测试窗口"
  });
  assert.equal(addition.effectiveLimitCny, 200);
  await assert.rejects(service.reserveTask({
    accountId: "owner-test",
    taskId: "still-blocked",
    stages: [known("model", 1)]
  }), { code: "AI_SITE_DAILY_COST_LIMIT" });
  const recovery = await service.ownerRecover({
    scope: "dailyKnownCost",
    actorId: "owner-account",
    reason: "追加预算后恢复"
  });
  assert.equal(recovery.wasBlocked, true);
  await assert.doesNotReject(service.reserveTask({
    accountId: "owner-test",
    taskId: "after-owner-recovery",
    stages: [known("model", 1)]
  }));
  assert.equal((await service.status()).day.committedKnownCostCny, 100);
  await assert.rejects(service.ownerAddTemporaryBudget({
    scope: "daily",
    amountCny: 100.000001,
    actorId: "owner-account",
    reason: "超过单次上限"
  }), { code: "AI_DAILY_ADDITION_TOO_LARGE" });
  await assert.rejects(service.ownerAddTemporaryBudget({
    scope: "monthly",
    amountCny: 2000.000001,
    actorId: "owner-account",
    reason: "超过单次上限"
  }), { code: "AI_MONTHLY_ADDITION_TOO_LARGE" });
  const monthly = await service.ownerAddTemporaryBudget({
    scope: "monthly",
    amountCny: 2000,
    actorId: "owner-account",
    reason: "月度临时追加"
  });
  assert.equal(monthly.effectiveLimitCny, 4000);
  const events = (await service.read()).events;
  assert.ok(events.some(item => item.type === "ai.budget.owner_temporary_addition"
    && item.actorId === "owner-account"));
  assert.ok(events.some(item => item.type === "ai.budget.owner_recovery"
    && item.reason === "追加预算后恢复"));
}

console.log("AI budget checks passed: UTC periods, user/site limits, atomic holds and expiry, cross-period settlement, thresholds, unknown-cost alerts and Owner domain commands.");
