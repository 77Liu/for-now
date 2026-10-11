import assert from "node:assert/strict";
import {
  AI_BUDGET_POLICY,
  createAiBudgetService,
  normalizeAiBudgetState
} from "../src/modules/ai/index.mjs";
import { createAtomicRepository } from "./fixtures/atomic-json-repository.mjs";

let id = 0;
const repository = createAtomicRepository();
const service = createAiBudgetService({
  repository,
  policy: {
    ...AI_BUDGET_POLICY,
    userDailyKnownCostCny: 1000,
    userDailyCalls: 1000
  },
  now: () => "2026-10-02T01:00:00.000Z",
  createId: () => `control-${++id}`
});

assert.equal(normalizeAiBudgetState({}).controlVersion, 1);
assert.equal(normalizeAiBudgetState({ controlVersion: 7 }).controlVersion, 7);
assert.equal(normalizeAiBudgetState({ controlVersion: 0 }).controlVersion, 1);
assert.equal((await service.status()).controlVersion, 1);

const reservation = (await service.reserveTask({
  accountId: "account-a",
  taskId: "ordinary-lifecycle",
  stages: [{
    id: "model",
    provider: "deepseek",
    service: "chat-completions",
    scene: "thoughtAnswer",
    costKnown: true,
    estimatedCostCny: 1
  }]
})).reservation;
assert.equal((await service.status()).controlVersion, 1);
await service.startStage({ reservationId: reservation.id, stageId: "model" });
assert.equal((await service.status()).controlVersion, 1);
await service.settleTask({
  reservationId: reservation.id,
  stages: [{ stageId: "model", actualCostCny: 1 }]
});
assert.equal((await service.status()).controlVersion, 1);

const stateBeforeErrors = await service.read();
await assert.rejects(service.ownerRecover({
  scope: "dailyKnownCost",
  actorId: "owner-a",
  reason: "missing version"
}), error => {
  assert.equal(error.statusCode, 428);
  assert.equal(error.code, "PRECONDITION_REQUIRED");
  return true;
});
await assert.rejects(service.ownerRecover({
  scope: "dailyKnownCost",
  actorId: "owner-a",
  reason: "invalid version",
  expectedVersion: "1"
}), error => {
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "INVALID_EXPECTED_VERSION");
  return true;
});
await assert.rejects(service.ownerRecover({
  scope: "dailyKnownCost",
  actorId: "owner-a",
  reason: "future version",
  expectedVersion: 2
}), error => {
  assert.equal(error.statusCode, 412);
  assert.equal(error.code, "PRECONDITION_FAILED");
  assert.deepEqual(error.details, { currentVersion: 1 });
  return true;
});
assert.deepEqual(await service.read(), stateBeforeErrors);

const addition = await service.ownerAddTemporaryBudget({
  scope: "daily",
  amountCny: 10,
  actorId: "owner-a",
  reason: "controlled increase",
  expectedVersion: 1
});
assert.equal(addition.controlVersion, 2);
assert.equal(addition.status.controlVersion, 2);
assert.equal(addition.event.controlVersion, 2);

const held = (await service.reserveTask({
  accountId: "account-b",
  taskId: "ordinary-after-owner-command",
  stages: [{
    id: "model",
    provider: "deepseek",
    service: "chat-completions",
    scene: "thoughtAnswer",
    costKnown: true,
    estimatedCostCny: 1
  }]
})).reservation;
await service.releaseTask({ reservationId: held.id });
assert.equal((await service.status()).controlVersion, 2);

const recovery = await service.ownerRecover({
  scope: "dailyKnownCost",
  actorId: "owner-a",
  reason: "controlled recovery",
  expectedVersion: 2
});
assert.equal(recovery.controlVersion, 3);
assert.equal(recovery.status.controlVersion, 3);
assert.equal(recovery.event.controlVersion, 3);

const concurrent = await Promise.allSettled([
  service.ownerAddTemporaryBudget({
    scope: "monthly",
    amountCny: 20,
    actorId: "owner-a",
    reason: "concurrent addition",
    expectedVersion: 3
  }),
  service.ownerRecover({
    scope: "dailyUnknownCost",
    actorId: "owner-b",
    reason: "concurrent recovery",
    expectedVersion: 3
  })
]);
assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
const rejected = concurrent.find(result => result.status === "rejected").reason;
assert.equal(rejected.statusCode, 412);
assert.equal(rejected.code, "PRECONDITION_FAILED");
assert.deepEqual(rejected.details, { currentVersion: 4 });

const finalState = await service.read();
assert.equal(finalState.controlVersion, 4);
assert.equal((await service.status()).controlVersion, 4);
assert.equal(
  finalState.events.filter(event => event.type.startsWith("ai.budget.owner_")).length,
  3
);

console.log("AI budget control version checks passed: defaulting, ordinary lifecycle stability, atomic preconditions, successful increments and concurrent stale-write rejection.");
