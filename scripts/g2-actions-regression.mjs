import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import {
  actionCompletionFeedback,
  actionPayload,
  assertActionsData,
  createActionsService,
  habitCheckinPayload,
  habitPayload,
  normalizeHabitFrequency,
  normalizeSourceRef
} from "../src/modules/actions/index.mjs";
import {
  buildCompleteActionCommand,
  buildCreateActionCommand,
  buildCreateHabitCommand,
  buildDeleteActionCommand,
  buildDeleteHabitCommand,
  buildHabitAdjustmentCommand,
  buildHabitCheckinCommand,
  buildSetHabitEnabledCommand,
  buildUndoActionCompletionCommand,
  buildUpdateActionCommand,
  buildUpdateHabitCheckinCommand,
  createActionsViewModel,
  projectActionCommand
} from "../public/frontend/features/actions/index.mjs";

const clone = value => structuredClone(value);
const context = new AsyncLocalStorage();
const accounts = new Map([
  ["account-a", { actions: [], habits: [], habitCheckins: [], trash: [] }],
  ["account-b", { actions: [], habits: [], habitCheckins: [], trash: [] }],
  ["account-c", { actions: [], habits: [], habitCheckins: [], trash: [] }]
]);
const tails = new Map();
const attempts = new Map();
const failures = new Map();

function accountKey() {
  const accountId = context.getStore();
  assert.ok(accounts.has(accountId), "actions repository requires an account context");
  return accountId;
}

const repository = {
  async read() {
    return clone(accounts.get(accountKey()));
  },
  update(mutate) {
    const accountId = accountKey();
    const previous = tails.get(accountId) || Promise.resolve();
    const operation = previous.then(async () => {
      const draft = clone(accounts.get(accountId));
      const result = await mutate(draft);
      attempts.set(accountId, (attempts.get(accountId) || 0) + 1);
      const remainingFailures = failures.get(accountId) || 0;
      if (remainingFailures) {
        failures.set(accountId, remainingFailures - 1);
        throw new Error("commit unavailable");
      }
      accounts.set(accountId, draft);
      return result;
    });
    tails.set(accountId, operation.catch(() => {}));
    return operation;
  }
};

const run = (accountId, operation) => context.run(accountId, operation);
const failNextCommit = accountId => failures.set(accountId, (failures.get(accountId) || 0) + 1);
const snapshot = accountId => clone(accounts.get(accountId));

assert.deepEqual(actionCompletionFeedback({ learningAllowed: true }), {
  value: {
    outcome: "unsure",
    note: "",
    learningAllowed: true
  }
});

let idSequence = 0;
let timeSequence = 0;
const service = createActionsService({
  repository,
  createId: () => `g2-${++idSequence}`,
  now: () => new Date(Date.UTC(2026, 8, 29, 8, 0, timeSequence++)).toISOString(),
  today: () => "2026-09-29"
});

// Strict canonical payloads reject malformed values and emit only domain fields.
assert.deepEqual(actionPayload({
  title: "  写完   专项\n回归  ",
  priority: "p1",
  status: "in_progress",
  sourceRef: { resourceType: "thought", resourceId: " thought-1 ", label: "  来源思绪 " },
  ignored: "must not leak"
}), {
  value: {
    title: "写完 专项 回归",
    priority: "P1",
    status: "doing",
    sourceRef: { type: "thought", id: "thought-1", label: "来源思绪" }
  }
});
assert.deepEqual(actionPayload({ title: "x", status: "unknown" }), { error: "行动状态无效" });
assert.deepEqual(actionPayload({ title: 42 }), { error: "行动标题必须是文本" });
assert.deepEqual(actionPayload({ title: "x", sourceRef: { type: "../thought", id: "1" } }), { error: "来源类型格式无效" });
assert.deepEqual(normalizeSourceRef({ type: "journal", id: "journal-1" }), {
  value: { type: "journal", id: "journal-1", label: "" }
});
assert.deepEqual(normalizeHabitFrequency("day"), { value: { cadence: "daily", target: 1 } });
assert.deepEqual(normalizeHabitFrequency({ period: "week", times: 3 }), {
  value: { cadence: "weekly", target: 3 }
});
assert.deepEqual(normalizeHabitFrequency({ cadence: "daily", target: 2 }), { error: "每日习惯目标只能是 1 次" });
assert.deepEqual(habitPayload({
  title: "  晚间阅读 ",
  frequency: { cadence: "weekly", target: 5 },
  enabled: false,
  adjustment: "  先减少频次 "
}), {
  value: {
    title: "晚间阅读",
    frequency: { cadence: "weekly", target: 5 },
    status: "paused",
    adjustment: "先减少频次"
  }
});
assert.deepEqual(habitCheckinPayload({
  date: " 2026-09-29 ",
  feeling: "  平静 ",
  adjustment: " 提前十分钟 "
}), {
  value: { occurredOn: "2026-09-29", feeling: "平静", adjustment: "提前十分钟" }
});
assert.deepEqual(habitCheckinPayload({ occurredOn: "2026-02-30" }), { error: "打卡日期格式不正确" });
assert.throws(() => assertActionsData({ actions: [], habits: [] }), /actions, habits and habitCheckins/);

const invalidAttemptCount = attempts.get("account-a") || 0;
assert.deepEqual(await run("account-a", () => service.createAction({ title: "", priority: "P9" })), {
  error: "行动标题不能为空"
});
assert.equal(attempts.get("account-a") || 0, invalidAttemptCount);

// Persisted idempotency keys survive request retries for all create operations.
const idempotentAction = await run("account-c", () => service.createAction(
  { title: "幂等行动", priority: "P1" },
  { clientRequestId: "action-idempotency-1" }
));
const replayedAction = await run("account-c", () => service.createAction(
  { title: "幂等行动", priority: "P1" },
  { clientRequestId: "action-idempotency-1" }
));
assert.equal(replayedAction.duplicate, true);
assert.equal(replayedAction.value.id, idempotentAction.value.id);
accounts.get("account-c").trash.push({ type: "action", payload: accounts.get("account-c").actions.shift() });
const replayedDeletedAction = await run("account-c", () => service.createAction(
  { title: "幂等行动", priority: "P1" },
  { clientRequestId: "action-idempotency-1" }
));
assert.equal(replayedDeletedAction.duplicate, true);
assert.equal(replayedDeletedAction.value.id, idempotentAction.value.id);
assert.equal(accounts.get("account-c").actions.length, 0);
assert.equal((await run("account-c", () => service.createAction(
  { title: "不同内容", priority: "P1" },
  { clientRequestId: "action-idempotency-1" }
))).conflict, true);
const idempotentHabit = await run("account-c", () => service.createHabit(
  { title: "幂等习惯", frequency: "daily" },
  { clientRequestId: "habit-idempotency-1" }
));
assert.equal((await run("account-c", () => service.createHabit(
  { title: "幂等习惯", frequency: "daily" },
  { clientRequestId: "habit-idempotency-1" }
))).value.id, idempotentHabit.value.id);
const idempotentCheckin = await run("account-c", () => service.checkInHabit(
  idempotentHabit.value.id,
  { occurredOn: "2026-09-29", feeling: "稳定" },
  { clientRequestId: "habit-checkin-idempotency-1" }
));
const replayedCheckin = await run("account-c", () => service.checkInHabit(
  idempotentHabit.value.id,
  { occurredOn: "2026-09-29", feeling: "稳定" },
  { clientRequestId: "habit-checkin-idempotency-1" }
));
assert.equal(replayedCheckin.duplicate, true);
assert.equal(replayedCheckin.value.id, idempotentCheckin.value.id);
accounts.get("account-c").trash.push({ type: "habitCheckin", payload: accounts.get("account-c").habitCheckins.shift() });
const replayedDeletedCheckin = await run("account-c", () => service.checkInHabit(
  idempotentHabit.value.id,
  { occurredOn: "2026-09-29", feeling: "稳定" },
  { clientRequestId: "habit-checkin-idempotency-1" }
));
assert.equal(replayedDeletedCheckin.duplicate, true);
assert.equal(replayedDeletedCheckin.value.id, idempotentCheckin.value.id);
assert.equal(accounts.get("account-c").habitCheckins.length, 0);
assert.equal((await run("account-c", () => service.checkInHabit(
  idempotentHabit.value.id,
  { occurredOn: "2026-09-30", feeling: "改变" },
  { clientRequestId: "habit-checkin-idempotency-1" }
))).conflict, true);

// Actions retain source links, use monotonic versions and record completion/undo transitions.
const createdAction = (await run("account-a", () => service.createAction({
  title: "  完成 G2-C 专项  ",
  priority: "p1",
  sourceRef: { type: "thought", id: "thought-42", label: "版本计划" }
}))).value;
assert.deepEqual({
  title: createdAction.title,
  priority: createdAction.priority,
  status: createdAction.status,
  sourceRef: createdAction.sourceRef,
  version: createdAction.version
}, {
  title: "完成 G2-C 专项",
  priority: "P1",
  status: "todo",
  sourceRef: { type: "thought", id: "thought-42", label: "版本计划" },
  version: 1
});
assert.equal(await run("account-b", () => service.getAction(createdAction.id)), null);
assert.deepEqual(await run("account-b", () => service.updateAction(
  createdAction.id,
  { title: "越权修改" },
  { expectedVersion: 1 }
)), { missing: true });

const doingAction = (await run("account-a", () => service.updateAction(
  createdAction.id,
  { title: "  完成 G2-C 全量专项 ", status: "doing" },
  { expectedVersion: 1 }
))).value;
assert.equal(doingAction.version, 2);
assert.equal(doingAction.status, "doing");
assert.equal(doingAction.sourceRef.id, "thought-42");
assert.deepEqual(doingAction.statusHistory.at(-1), {
  from: "todo",
  to: "doing",
  reason: "statusChange",
  changedAt: doingAction.updatedAt
});

const beforeStaleAction = snapshot("account-a");
assert.deepEqual(await run("account-a", () => service.updateAction(
  createdAction.id,
  { priority: "P0" },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });
assert.deepEqual(snapshot("account-a"), beforeStaleAction);

const completedAction = (await run("account-a", () => service.completeAction(
  createdAction.id,
  {
    outcome: "helpful",
    note: "完成后更清楚下一步",
    learningAllowed: true
  },
  { expectedVersion: 2 }
))).value;
assert.equal(completedAction.status, "done");
assert.equal(completedAction.version, 3);
assert.equal(completedAction.completedAt, completedAction.updatedAt);
assert.equal(completedAction.statusBeforeCompletion, "doing");
assert.equal(completedAction.statusHistory.at(-1).reason, "complete");
assert.deepEqual(completedAction.completionFeedback, {
  outcome: "helpful",
  note: "完成后更清楚下一步",
  learningAllowed: true,
  recordedAt: completedAction.completedAt
});
assert.deepEqual(completedAction.statusHistory.at(-1).feedback, completedAction.completionFeedback);
const repeatedCompletion = await run("account-a", () => service.completeAction(
  createdAction.id,
  { expectedVersion: 3 }
));
assert.equal(repeatedCompletion.unchanged, true);
assert.equal(repeatedCompletion.value.version, 3);
assert.deepEqual(await run("account-a", () => service.undoActionCompletion(
  createdAction.id,
  { expectedVersion: 2 }
)), { versionConflict: true, currentVersion: 3 });
const reopenedAction = (await run("account-a", () => service.undoActionCompletion(
  createdAction.id,
  { expectedVersion: 3 }
))).value;
assert.equal(reopenedAction.status, "doing");
assert.equal(reopenedAction.completedAt, "");
assert.equal(reopenedAction.version, 4);
assert.equal(reopenedAction.statusHistory.at(-1).reason, "undoCompletion");
assert.equal(reopenedAction.completionFeedback.learningAllowed, false);
assert.equal(reopenedAction.statusHistory[1].feedback.learningAllowed, false);
assert.equal(reopenedAction.completionFeedback.revokedAt, reopenedAction.updatedAt);
accounts.get("account-a").actions.unshift({
  ...completedAction,
  id: "direct-status-reopen"
});
const directlyReopened = (await run("account-a", () => service.setActionStatus(
  "direct-status-reopen",
  "doing",
  { expectedVersion: 3 }
))).value;
assert.equal(directlyReopened.completionFeedback.learningAllowed, false);
assert.equal(directlyReopened.statusHistory[1].feedback.learningAllowed, false);
accounts.get("account-a").actions = accounts.get("account-a").actions.filter(
  item => item.id !== "direct-status-reopen"
);
const todoAction = (await run("account-a", () => service.setActionStatus(
  createdAction.id,
  "todo",
  { expectedVersion: 4 }
))).value;
assert.equal(todoAction.version, 5);
assert.deepEqual(await run("account-a", () => service.undoActionCompletion(
  createdAction.id,
  { expectedVersion: 5 }
)), { invalidState: true, currentStatus: "todo" });

const beforeActionDeletion = snapshot("account-a");
assert.deepEqual(await run("account-a", () => service.locateActionDeletion(createdAction.id)), {
  value: {
    type: "action",
    resourceId: createdAction.id,
    version: 5,
    location: { kind: "collection", collection: "actions", index: 0 }
  }
});
assert.deepEqual(await run("account-a", () => service.locateActionDeletion(
  createdAction.id,
  { expectedVersion: 4 }
)), { versionConflict: true, currentVersion: 5 });
assert.deepEqual(snapshot("account-a"), beforeActionDeletion);

const beforeFailedActionCreate = snapshot("account-a");
failNextCommit("account-a");
await assert.rejects(run("account-a", () => service.createAction({ title: "不得半提交" })), /commit unavailable/);
assert.deepEqual(snapshot("account-a"), beforeFailedActionCreate);
const beforeFailedActionUpdate = snapshot("account-a");
failNextCommit("account-a");
await assert.rejects(run("account-a", () => service.updateAction(
  createdAction.id,
  { title: "也不得半提交", status: "done" },
  { expectedVersion: 5 }
)), /commit unavailable/);
assert.deepEqual(snapshot("account-a"), beforeFailedActionUpdate);

const completedFromCreation = (await run("account-a", () => service.createAction({
  title: "高优先级已完成项",
  priority: "P0",
  status: "done"
}))).value;
assert.equal(completedFromCreation.status, "done");
assert.equal(completedFromCreation.statusHistory.at(-1).reason, "createCompleted");

// Habits track frequency/status adjustments. Check-ins are unique per habit and natural day.
const dailyHabit = (await run("account-a", () => service.createHabit({
  title: "每日拉伸",
  frequency: "daily"
}))).value;
const weeklyHabit = (await run("account-a", () => service.createHabit({
  title: "每周阅读",
  frequency: { cadence: "weekly", target: 3 }
}))).value;
assert.equal(dailyHabit.version, 1);
assert.deepEqual(weeklyHabit.frequency, { cadence: "weekly", target: 3 });

const habitAttemptsBeforeInvalid = attempts.get("account-a");
assert.deepEqual(await run("account-a", () => service.createHabit({
  title: "非法频次",
  frequency: { cadence: "weekly", target: 8 }
})), { error: "每周习惯目标必须是 1 到 7 次" });
assert.equal(attempts.get("account-a"), habitAttemptsBeforeInvalid);

const adjustedHabit = (await run("account-a", () => service.updateHabit(
  weeklyHabit.id,
  { frequency: { cadence: "weekly", target: 4 }, adjustment: "本周时间更充裕" },
  { expectedVersion: 1 }
))).value;
assert.equal(adjustedHabit.version, 2);
assert.equal(adjustedHabit.adjustmentHistory.length, 1);
assert.deepEqual(adjustedHabit.adjustmentHistory[0].fromFrequency, { cadence: "weekly", target: 3 });
assert.deepEqual(adjustedHabit.adjustmentHistory[0].toFrequency, { cadence: "weekly", target: 4 });
assert.equal(adjustedHabit.adjustmentHistory[0].note, "本周时间更充裕");
assert.deepEqual(await run("account-a", () => service.updateHabit(
  weeklyHabit.id,
  { title: "过期修改" },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });

const pausedHabit = (await run("account-a", () => service.disableHabit(
  weeklyHabit.id,
  { expectedVersion: 2 }
))).value;
assert.equal(pausedHabit.status, "paused");
assert.equal(pausedHabit.version, 3);
assert.equal(pausedHabit.statusHistory.at(-1).reason, "pause");
assert.deepEqual(await run("account-a", () => service.checkInHabit(
  weeklyHabit.id,
  { occurredOn: "2026-09-29" }
)), { inactive: true });
const activeHabit = (await run("account-a", () => service.enableHabit(
  weeklyHabit.id,
  { expectedVersion: 3 }
))).value;
assert.equal(activeHabit.status, "active");
assert.equal(activeHabit.version, 4);

const firstCheckin = await run("account-a", () => service.checkInHabit(weeklyHabit.id, {
  occurredOn: "2026-09-29",
  feeling: "  开始后很专注 ",
  adjustment: " 下次提前准备书 "
}));
assert.equal(firstCheckin.duplicate, false);
assert.equal(firstCheckin.value.version, 1);
assert.equal(firstCheckin.value.feeling, "开始后很专注");
const duplicateCheckin = await run("account-a", () => service.checkInHabit(weeklyHabit.id, {
  occurredOn: "2026-09-29",
  feeling: "重复请求中的不同文本不会覆盖原记录"
}));
assert.equal(duplicateCheckin.duplicate, true);
assert.equal(duplicateCheckin.value.id, firstCheckin.value.id);
assert.equal(duplicateCheckin.value.feeling, "开始后很专注");
assert.equal((await run("account-a", () => service.listHabitCheckins({
  habitId: weeklyHabit.id,
  occurredOn: "2026-09-29"
}))).length, 1);

const invalidCheckinAttempts = attempts.get("account-a");
assert.deepEqual(await run("account-a", () => service.checkInHabit(
  weeklyHabit.id,
  { occurredOn: "2026-09-31" }
)), { error: "打卡日期格式不正确" });
assert.equal(attempts.get("account-a"), invalidCheckinAttempts);

const concurrentCheckins = await Promise.all([
  run("account-a", () => service.checkInHabit(weeklyHabit.id, {
    occurredOn: "2026-09-30",
    feeling: "稳定"
  })),
  run("account-a", () => service.checkInHabit(weeklyHabit.id, {
    occurredOn: "2026-09-30",
    feeling: "并发重试"
  }))
]);
assert.deepEqual(concurrentCheckins.map(result => result.duplicate).sort(), [false, true]);
assert.equal(concurrentCheckins[0].value.id, concurrentCheckins[1].value.id);
assert.equal((await run("account-a", () => service.listHabitCheckins({
  habitId: weeklyHabit.id,
  occurredOn: "2026-09-30"
}))).length, 1);
const secondCheckin = concurrentCheckins[0].duplicate ? concurrentCheckins[1].value : concurrentCheckins[0].value;

const editedCheckin = (await run("account-a", () => service.updateHabitCheckin(
  firstCheckin.value.id,
  { feeling: "核对后仍然专注", adjustment: "阅读前关闭通知" },
  { expectedVersion: 1 }
))).value;
assert.equal(editedCheckin.version, 2);
assert.equal(editedCheckin.occurredOn, "2026-09-29");
assert.deepEqual(await run("account-a", () => service.updateHabitCheckin(
  firstCheckin.value.id,
  { feeling: "过期覆盖" },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });
assert.deepEqual(await run("account-a", () => service.updateHabitCheckin(
  secondCheckin.id,
  { occurredOn: "2026-09-29" },
  { expectedVersion: 1 }
)), { dateConflict: true, existingId: firstCheckin.value.id });

const adjustmentResult = await run("account-a", () => service.recordHabitAdjustment(
  weeklyHabit.id,
  { note: "降低到每周两天，先稳定执行", frequency: { cadence: "weekly", target: 2 } },
  { expectedVersion: 4 }
));
assert.equal(adjustmentResult.value.version, 5);
assert.deepEqual(adjustmentResult.value.frequency, { cadence: "weekly", target: 2 });
assert.equal(adjustmentResult.value.adjustmentHistory.length, 2);
assert.equal(adjustmentResult.adjustment.note, "降低到每周两天，先稳定执行");

const beforeHabitDeletion = snapshot("account-a");
const habitDeletion = await run("account-a", () => service.locateHabitDeletion(weeklyHabit.id));
assert.equal(habitDeletion.value.type, "habit");
assert.equal(habitDeletion.value.version, 5);
assert.deepEqual(habitDeletion.value.location, { kind: "collection", collection: "habits", index: 0 });
assert.equal(habitDeletion.value.dependents.length, 2);
assert.deepEqual(new Set(habitDeletion.value.dependents.map(item => item.resourceId)), new Set([
  firstCheckin.value.id,
  secondCheckin.id
]));
assert.ok(habitDeletion.value.dependents.every(item => (
  item.location.collection === "habitCheckins"
  && item.location.parentId === weeklyHabit.id
)));
assert.deepEqual(snapshot("account-a"), beforeHabitDeletion);
const checkinDeletion = await run("account-a", () => service.locateHabitCheckinDeletion(firstCheckin.value.id));
assert.equal(checkinDeletion.value.location.parentId, weeklyHabit.id);
assert.deepEqual(await run("account-a", () => service.locateDeletion("unknown", "x")), {
  error: "删除资源类型无效"
});

const beforeFailedHabit = snapshot("account-a");
failNextCommit("account-a");
await assert.rejects(run("account-a", () => service.updateHabit(
  dailyHabit.id,
  { enabled: false, adjustment: "不应写入" },
  { expectedVersion: 1 }
)), /commit unavailable/);
assert.deepEqual(snapshot("account-a"), beforeFailedHabit);
failNextCommit("account-a");
await assert.rejects(run("account-a", () => service.checkInHabit(
  dailyHabit.id,
  { occurredOn: "2026-09-29", feeling: "不应写入" }
)), /commit unavailable/);
assert.deepEqual(snapshot("account-a"), beforeFailedHabit);

// The same domain service cannot escape the account selected by the repository boundary.
const accountBAction = (await run("account-b", () => service.createAction({
  title: "账户 B 行动",
  priority: "P2"
}))).value;
const accountBHabit = (await run("account-b", () => service.createHabit({
  title: "账户 B 习惯",
  frequency: "daily"
}))).value;
await run("account-b", () => service.checkInHabit(accountBHabit.id, {
  occurredOn: "2026-09-29",
  feeling: "账户 B 独立记录"
}));
assert.deepEqual(await run("account-b", () => service.completeAction(
  createdAction.id,
  { expectedVersion: 5 }
)), { missing: true });
assert.deepEqual(await run("account-b", () => service.checkInHabit(
  weeklyHabit.id,
  { occurredOn: "2026-09-29" }
)), { missing: true });
assert.equal((await run("account-b", () => service.listActions())).length, 1);
assert.equal((await run("account-a", () => service.listActions())).some(item => item.id === accountBAction.id), false);
assert.equal((await run("account-a", () => service.listHabitCheckins())).some(item => item.habitId === accountBHabit.id), false);
await assert.rejects(() => service.listActions(), /account context/);

const malformedService = createActionsService({
  repository: {
    read: async () => ({ actions: [], habits: [] }),
    update: async () => {
      throw new Error("unexpected update");
    }
  }
});
await assert.rejects(() => malformedService.listHabits(), /actions, habits and habitCheckins/);
assert.throws(() => createActionsService({ repository: {} }), /read\(\) and update\(\)/);

// Frontend projections are deterministic and commands are immutable data only.
const accountAData = snapshot("account-a");
const beforeViewModel = clone(accountAData);
const viewModel = createActionsViewModel(accountAData, { today: "2026-09-30" });
assert.deepEqual(accountAData, beforeViewModel);
assert.deepEqual(viewModel.actionColumns.map(column => [column.status, column.count]), [
  ["todo", 1],
  ["doing", 0],
  ["done", 1]
]);
assert.equal(viewModel.actionColumns[0].items[0].sourceLabel, "版本计划");
assert.equal(viewModel.actionColumns[2].items[0].canUndoCompletion, true);
const weeklyHabitView = viewModel.habits.find(item => item.id === weeklyHabit.id);
assert.deepEqual(weeklyHabitView.frequency, { cadence: "weekly", target: 2 });
assert.equal(weeklyHabitView.frequencyLabel, "每周 2 天");
assert.equal(weeklyHabitView.period.start, "2026-09-28");
assert.equal(weeklyHabitView.period.end, "2026-10-04");
assert.equal(weeklyHabitView.period.count, 2);
assert.equal(weeklyHabitView.period.complete, true);
assert.equal(weeklyHabitView.checkedToday, true);
assert.equal(weeklyHabitView.canCheckIn, false);
assert.equal(weeklyHabitView.latestFeeling, "稳定");
assert.equal(weeklyHabitView.adjustmentCount, 2);
assert.deepEqual(viewModel.summary, {
  actions: 2,
  openActions: 1,
  completedActions: 1,
  habits: 2,
  activeHabits: 2,
  checkedToday: 1
});

const actionDraft = {
  title: "  前端行动  ",
  priority: "P0",
  sourceRef: { type: "journal", id: " journal-1 ", label: " 日录 " },
  ignored: "not part of command"
};
const createActionCommand = buildCreateActionCommand(actionDraft);
actionDraft.sourceRef.label = "已改变";
assert.deepEqual(createActionCommand, {
  type: "actions.create",
  input: {
    title: "前端行动",
    priority: "P0",
    sourceRef: { type: "journal", id: "journal-1", label: "日录" }
  }
});
assert.equal(Object.isFrozen(createActionCommand), true);
assert.equal(Object.isFrozen(createActionCommand.input.sourceRef), true);
assert.deepEqual(buildUpdateActionCommand("action-1", { title: "更新" }, 3), {
  type: "actions.update",
  id: "action-1",
  input: { title: "更新" },
  expectedVersion: 3
});
assert.deepEqual(buildCompleteActionCommand("action-1", 3), {
  type: "actions.complete",
  id: "action-1",
  expectedVersion: 3
});
assert.deepEqual(buildCompleteActionCommand("action-1", {
  outcome: "mixed",
  note: " 有帮助但仍需调整 ",
  learningAllowed: true
}, 3), {
  type: "actions.complete",
  id: "action-1",
  input: {
    outcome: "mixed",
    note: "有帮助但仍需调整",
    learningAllowed: true
  },
  expectedVersion: 3
});
assert.deepEqual(buildUndoActionCompletionCommand("action-1", 4), {
  type: "actions.undoCompletion",
  id: "action-1",
  expectedVersion: 4
});
assert.deepEqual(buildCreateHabitCommand({
  title: " 阅读 ",
  frequency: { cadence: "weekly", target: 3 }
}), {
  type: "habits.create",
  input: { title: "阅读", frequency: { cadence: "weekly", target: 3 } }
});
assert.deepEqual(buildSetHabitEnabledCommand("habit-1", false, 2), {
  type: "habits.setEnabled",
  id: "habit-1",
  enabled: false,
  expectedVersion: 2
});
assert.deepEqual(buildHabitAdjustmentCommand("habit-1", {
  note: " 调整 ",
  frequency: { cadence: "weekly", target: 2 }
}, 2), {
  type: "habits.recordAdjustment",
  id: "habit-1",
  input: { note: "调整", frequency: { cadence: "weekly", target: 2 } },
  expectedVersion: 2
});
assert.deepEqual(buildHabitCheckinCommand("habit-1", {
  date: "2026-09-29",
  feeling: " 平静 "
}), {
  type: "habitCheckins.create",
  habitId: "habit-1",
  input: { occurredOn: "2026-09-29", feeling: "平静" }
});
assert.deepEqual(buildUpdateHabitCheckinCommand("checkin-1", {
  adjustment: " 提前 "
}, 1), {
  type: "habitCheckins.update",
  id: "checkin-1",
  input: { adjustment: "提前" },
  expectedVersion: 1
});
assert.deepEqual(buildDeleteHabitCommand("habit-1", 5), {
  type: "habits.delete",
  id: "habit-1",
  expectedVersion: 5
});
const projectionSource = {
  actions: [{
    id: "action-1",
    title: "原行动",
    priority: "P1",
    status: "doing",
    version: 3,
    statusHistory: []
  }],
  habits: [{
    id: "habit-1",
    title: "原习惯",
    status: "active",
    version: 2,
    frequency: { cadence: "daily", target: 1 }
  }],
  habitCheckins: [{
    id: "checkin-1",
    habitId: "habit-1",
    occurredOn: "2026-09-30",
    version: 1
  }]
};
const updatedProjection = projectActionCommand(
  projectionSource,
  buildUpdateActionCommand("action-1", { title: "即时标题", priority: "P0" }, 3),
  { operationId: "operation-update", status: "sending" }
);
assert.equal(updatedProjection.changed, true);
assert.deepEqual(updatedProjection.value.actions[0]._sync, {
  status: "sending",
  operationId: "operation-update",
  command: "actions.update"
});
assert.equal(updatedProjection.value.actions[0].title, "即时标题");
assert.equal(updatedProjection.value.actions[0].priority, "P0");
assert.equal(projectionSource.actions[0].title, "原行动", "projection must not mutate the authoritative snapshot");

const completedProjection = projectActionCommand(
  projectionSource,
  buildCompleteActionCommand("action-1", 3),
  { operationId: "operation-complete", status: "pending", createdAt: "2026-09-30T15:00:00.000Z" }
);
assert.equal(completedProjection.value.actions[0].status, "done");
assert.equal(completedProjection.value.actions[0].statusBeforeCompletion, "doing");
assert.equal(completedProjection.value.actions[0]._sync.status, "pending");
const reopenedProjection = projectActionCommand(
  completedProjection.value,
  buildUndoActionCompletionCommand("action-1", 3),
  { operationId: "operation-reopen", status: "sending" }
);
assert.equal(reopenedProjection.value.actions[0].status, "doing");

const deletedActionProjection = projectActionCommand(
  projectionSource,
  buildDeleteActionCommand("action-1", 3),
  { operationId: "operation-delete", status: "sending" }
);
assert.equal(deletedActionProjection.value.actions.length, 0);
const pausedHabitProjection = projectActionCommand(
  projectionSource,
  buildSetHabitEnabledCommand("habit-1", false, 2),
  { operationId: "operation-pause", status: "sending" }
);
assert.equal(pausedHabitProjection.value.habits[0].status, "paused");
const deletedHabitProjection = projectActionCommand(
  projectionSource,
  buildDeleteHabitCommand("habit-1", 2),
  { operationId: "operation-delete-habit", status: "sending" }
);
assert.equal(deletedHabitProjection.value.habits.length, 0);
assert.equal(deletedHabitProjection.value.habitCheckins.length, 0);
assert.throws(() => buildCompleteActionCommand("", 1), /行动 ID不能为空/);
assert.throws(() => buildUpdateActionCommand("action-1", {}, 0), /版本必须是正整数/);
assert.throws(() => buildSetHabitEnabledCommand("habit-1", "false", 1), /布尔值/);

const frontendSource = await readFile(new URL(
  "../public/frontend/features/actions/index.mjs",
  import.meta.url
), "utf8");
for (const forbidden of [/\bfetch\s*\(/, /\bdocument\b/, /\bwindow\b/, /querySelector/, /addEventListener/]) {
  assert.doesNotMatch(frontendSource, forbidden);
}

console.log(
  "G2-C actions checks passed: strict payloads, repository injection, versions, completion undo, source links, "
  + "habit frequency/status, natural-day idempotency, feelings/adjustments, rollback, account isolation, "
  + "trash locators and pure frontend view-model/commands."
);
