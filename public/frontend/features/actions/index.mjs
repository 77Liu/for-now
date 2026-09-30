const ACTION_STATUS_META = Object.freeze({
  todo: Object.freeze({ label: "待办", order: 0 }),
  doing: Object.freeze({ label: "进行中", order: 1 }),
  done: Object.freeze({ label: "已完成", order: 2 })
});
const PRIORITY_META = Object.freeze({
  P0: Object.freeze({ label: "P0", order: 0 }),
  P1: Object.freeze({ label: "P1", order: 1 }),
  P2: Object.freeze({ label: "P2", order: 2 }),
  P3: Object.freeze({ label: "P3", order: 3 }),
  none: Object.freeze({ label: "未分级", order: 4 })
});

const copy = value => {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  return value;
};

const deepFreeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const command = value => deepFreeze(copy(value));
const text = value => typeof value === "string" ? value.trim() : "";
const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

function requiredId(value, label) {
  const id = text(value);
  if (!id) throw new TypeError(`${label}不能为空`);
  return id;
}

function optionalVersion(value) {
  if (value == null || value === "") return undefined;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new TypeError("版本必须是正整数");
  return version;
}

function withVersion(value, version) {
  const parsed = optionalVersion(version);
  return parsed == null ? value : { ...value, expectedVersion: parsed };
}

function actionInput(input = {}, partial = false) {
  const value = {};
  if (!partial || Object.hasOwn(input, "title")) value.title = text(input.title);
  if (!partial || Object.hasOwn(input, "priority")) value.priority = text(input.priority) || "none";
  if (Object.hasOwn(input, "status")) value.status = text(input.status);
  if (Object.hasOwn(input, "sourceRef") || Object.hasOwn(input, "source")) {
    const source = input.sourceRef ?? input.source;
    value.sourceRef = source == null
      ? null
      : { type: text(source.type ?? source.resourceType), id: text(source.id ?? source.resourceId), label: text(source.label) };
  }
  return value;
}

function habitInput(input = {}, partial = false) {
  const value = {};
  if (!partial || Object.hasOwn(input, "title")) value.title = text(input.title);
  if (Object.hasOwn(input, "frequency")) value.frequency = copy(input.frequency);
  if (Object.hasOwn(input, "status")) value.status = text(input.status);
  if (Object.hasOwn(input, "enabled")) value.enabled = input.enabled;
  if (Object.hasOwn(input, "adjustment")) value.adjustment = text(input.adjustment);
  return value;
}

function checkinInput(input = {}) {
  const value = {};
  if (Object.hasOwn(input, "occurredOn") || Object.hasOwn(input, "date")) {
    value.occurredOn = text(input.occurredOn ?? input.date);
  }
  if (Object.hasOwn(input, "feeling")) value.feeling = text(input.feeling);
  if (Object.hasOwn(input, "adjustment")) value.adjustment = text(input.adjustment);
  return value;
}

function sourceLabel(sourceRef) {
  if (!sourceRef) return "独立行动";
  return sourceRef.label || `${sourceRef.type}:${sourceRef.id}`;
}

function actionViewModel(action) {
  const status = ACTION_STATUS_META[action.status] ? action.status : "todo";
  const priority = PRIORITY_META[action.priority] ? action.priority : "none";
  return {
    id: action.id,
    title: action.title || "",
    priority,
    priorityLabel: PRIORITY_META[priority].label,
    status,
    statusLabel: ACTION_STATUS_META[status].label,
    source: action.sourceRef ? copy(action.sourceRef) : null,
    sourceLabel: sourceLabel(action.sourceRef),
    version: Number(action.version) || 1,
    createdAt: action.createdAt || "",
    updatedAt: action.updatedAt || action.createdAt || "",
    completedAt: action.completedAt || "",
    sync: action._sync ? copy(action._sync) : null,
    transitionCount: Array.isArray(action.statusHistory) ? action.statusHistory.length : 0,
    canComplete: status !== "done",
    canUndoCompletion: status === "done"
  };
}

function compareActions(left, right) {
  const priority = PRIORITY_META[left.priority].order - PRIORITY_META[right.priority].order;
  if (priority) return priority;
  return String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);
}

function shiftDateKey(dateKey, days) {
  if (!dateKeyPattern.test(dateKey)) return "";
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function weeklyStart(dateKey) {
  if (!dateKeyPattern.test(dateKey)) return "";
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return "";
  const offset = (date.getUTCDay() + 6) % 7;
  return shiftDateKey(dateKey, -offset);
}

function habitViewModel(habit, checkins, today) {
  const cadence = habit.frequency?.cadence === "weekly" ? "weekly" : "daily";
  const target = cadence === "weekly"
    ? Math.max(1, Math.min(7, Number(habit.frequency?.target) || 1))
    : 1;
  const periodStart = cadence === "weekly" ? weeklyStart(today) : today;
  const periodEnd = cadence === "weekly" ? shiftDateKey(periodStart, 6) : today;
  const ownCheckins = checkins
    .filter(item => item.habitId === habit.id)
    .sort((left, right) => String(right.occurredOn).localeCompare(String(left.occurredOn)));
  const periodCheckins = ownCheckins.filter(item => (
    periodStart && item.occurredOn >= periodStart && item.occurredOn <= periodEnd
  ));
  const todayCheckin = ownCheckins.find(item => item.occurredOn === today) || null;
  const count = new Set(periodCheckins.map(item => item.occurredOn)).size;
  const status = habit.status === "paused" ? "paused" : "active";
  return {
    id: habit.id,
    title: habit.title || "",
    status,
    statusLabel: status === "active" ? "进行中" : "已暂停",
    enabled: status === "active",
    version: Number(habit.version) || 1,
    sync: habit._sync ? copy(habit._sync) : null,
    frequency: { cadence, target },
    frequencyLabel: cadence === "daily" ? "每天" : `每周 ${target} 天`,
    checkedToday: Boolean(todayCheckin),
    todayCheckin: todayCheckin ? copy(todayCheckin) : null,
    canCheckIn: status === "active" && !todayCheckin,
    period: {
      start: periodStart,
      end: periodEnd,
      count,
      target,
      remaining: Math.max(0, target - count),
      complete: count >= target
    },
    latestFeeling: ownCheckins.find(item => item.feeling)?.feeling || "",
    latestAdjustment: ownCheckins.find(item => item.adjustment)?.adjustment
      || habit.adjustmentHistory?.at(-1)?.note
      || "",
    adjustmentCount: Array.isArray(habit.adjustmentHistory) ? habit.adjustmentHistory.length : 0,
    checkins: ownCheckins.map(copy)
  };
}

export function projectActionCommand(data = {}, pendingCommand = {}, sync = {}) {
  const value = {
    ...copy(data),
    actions: Array.isArray(data.actions) ? data.actions.map(copy) : [],
    habits: Array.isArray(data.habits) ? data.habits.map(copy) : [],
    habitCheckins: Array.isArray(data.habitCheckins) ? data.habitCheckins.map(copy) : []
  };
  const marker = {
    status: sync.status === "pending" || sync.status === "committed" ? sync.status : "sending",
    operationId: text(sync.operationId),
    command: text(pendingCommand.type)
  };
  const mark = item => ({ ...item, _sync: marker });
  const update = (items, id, transform) => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return false;
    items[index] = mark(transform(items[index]));
    return true;
  };
  let changed = false;

  if (pendingCommand.type === "actions.update") {
    changed = update(value.actions, pendingCommand.id, item => ({ ...item, ...copy(pendingCommand.input) }));
  } else if (pendingCommand.type === "actions.setStatus") {
    changed = update(value.actions, pendingCommand.id, item => ({ ...item, status: pendingCommand.status }));
  } else if (pendingCommand.type === "actions.complete") {
    changed = update(value.actions, pendingCommand.id, item => ({
      ...item,
      statusBeforeCompletion: item.status === "done" ? item.statusBeforeCompletion : item.status,
      status: "done",
      completedAt: sync.createdAt || item.completedAt || ""
    }));
  } else if (pendingCommand.type === "actions.undoCompletion") {
    changed = update(value.actions, pendingCommand.id, item => ({
      ...item,
      status: ["todo", "doing"].includes(item.statusBeforeCompletion) ? item.statusBeforeCompletion : "todo",
      completedAt: ""
    }));
  } else if (pendingCommand.type === "actions.delete") {
    const count = value.actions.length;
    value.actions = value.actions.filter(item => item.id !== pendingCommand.id);
    changed = value.actions.length !== count;
  } else if (pendingCommand.type === "habits.setEnabled") {
    changed = update(value.habits, pendingCommand.id, item => ({
      ...item,
      status: pendingCommand.enabled ? "active" : "paused"
    }));
  } else if (pendingCommand.type === "habits.recordAdjustment") {
    changed = update(value.habits, pendingCommand.id, item => ({
      ...item,
      ...(pendingCommand.input?.frequency ? { frequency: copy(pendingCommand.input.frequency) } : {})
    }));
  } else if (pendingCommand.type === "habits.delete") {
    const count = value.habits.length;
    value.habits = value.habits.filter(item => item.id !== pendingCommand.id);
    value.habitCheckins = value.habitCheckins.filter(item => item.habitId !== pendingCommand.id);
    changed = value.habits.length !== count;
  } else if (pendingCommand.type === "habitCheckins.delete") {
    const count = value.habitCheckins.length;
    value.habitCheckins = value.habitCheckins.filter(item => item.id !== pendingCommand.id);
    changed = value.habitCheckins.length !== count;
  }

  return { value, changed };
}

export function createActionsViewModel(data = {}, { today = "" } = {}) {
  const actions = Array.isArray(data.actions) ? data.actions.map(actionViewModel) : [];
  const habits = Array.isArray(data.habits) ? data.habits : [];
  const checkins = Array.isArray(data.habitCheckins) ? data.habitCheckins : [];
  const actionColumns = Object.entries(ACTION_STATUS_META).map(([status, meta]) => {
    const items = actions.filter(item => item.status === status).sort(compareActions);
    return { status, label: meta.label, count: items.length, items };
  });
  const habitItems = habits.map(habit => habitViewModel(habit, checkins, today));
  return {
    actionColumns,
    habits: habitItems,
    summary: {
      actions: actions.length,
      openActions: actions.filter(item => item.status !== "done").length,
      completedActions: actions.filter(item => item.status === "done").length,
      habits: habitItems.length,
      activeHabits: habitItems.filter(item => item.enabled).length,
      checkedToday: habitItems.filter(item => item.checkedToday).length
    }
  };
}

export const buildCreateActionCommand = input => command({
  type: "actions.create",
  input: actionInput(input)
});

export const buildUpdateActionCommand = (id, input, expectedVersion) => command(withVersion({
  type: "actions.update",
  id: requiredId(id, "行动 ID"),
  input: actionInput(input, true)
}, expectedVersion));

export const buildSetActionStatusCommand = (id, status, expectedVersion) => command(withVersion({
  type: "actions.setStatus",
  id: requiredId(id, "行动 ID"),
  status: text(status)
}, expectedVersion));

export const buildCompleteActionCommand = (id, expectedVersion) => command(withVersion({
  type: "actions.complete",
  id: requiredId(id, "行动 ID")
}, expectedVersion));

export const buildUndoActionCompletionCommand = (id, expectedVersion) => command(withVersion({
  type: "actions.undoCompletion",
  id: requiredId(id, "行动 ID")
}, expectedVersion));

export const buildDeleteActionCommand = (id, expectedVersion) => command(withVersion({
  type: "actions.delete",
  id: requiredId(id, "行动 ID")
}, expectedVersion));

export const buildCreateHabitCommand = input => command({
  type: "habits.create",
  input: habitInput(input)
});

export const buildUpdateHabitCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habits.update",
  id: requiredId(id, "习惯 ID"),
  input: habitInput(input, true)
}, expectedVersion));

export const buildSetHabitEnabledCommand = (id, enabled, expectedVersion) => {
  if (typeof enabled !== "boolean") throw new TypeError("习惯启停值必须是布尔值");
  return command(withVersion({
    type: "habits.setEnabled",
    id: requiredId(id, "习惯 ID"),
    enabled
  }, expectedVersion));
};

export const buildHabitAdjustmentCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habits.recordAdjustment",
  id: requiredId(id, "习惯 ID"),
  input: {
    note: text(input?.note ?? input?.adjustment),
    ...(Object.hasOwn(input || {}, "frequency") ? { frequency: copy(input.frequency) } : {})
  }
}, expectedVersion));

export const buildHabitCheckinCommand = (habitId, input = {}) => command({
  type: "habitCheckins.create",
  habitId: requiredId(habitId, "习惯 ID"),
  input: checkinInput(input)
});

export const buildUpdateHabitCheckinCommand = (id, input, expectedVersion) => command(withVersion({
  type: "habitCheckins.update",
  id: requiredId(id, "习惯打卡 ID"),
  input: checkinInput(input)
}, expectedVersion));

export const buildDeleteHabitCommand = (id, expectedVersion) => command(withVersion({
  type: "habits.delete",
  id: requiredId(id, "习惯 ID")
}, expectedVersion));

export const buildDeleteHabitCheckinCommand = (id, expectedVersion) => command(withVersion({
  type: "habitCheckins.delete",
  id: requiredId(id, "习惯打卡 ID")
}, expectedVersion));

export const actionCommandBuilders = Object.freeze({
  createAction: buildCreateActionCommand,
  updateAction: buildUpdateActionCommand,
  setActionStatus: buildSetActionStatusCommand,
  completeAction: buildCompleteActionCommand,
  undoActionCompletion: buildUndoActionCompletionCommand,
  deleteAction: buildDeleteActionCommand,
  createHabit: buildCreateHabitCommand,
  updateHabit: buildUpdateHabitCommand,
  setHabitEnabled: buildSetHabitEnabledCommand,
  recordHabitAdjustment: buildHabitAdjustmentCommand,
  checkInHabit: buildHabitCheckinCommand,
  updateHabitCheckin: buildUpdateHabitCheckinCommand,
  deleteHabit: buildDeleteHabitCommand,
  deleteHabitCheckin: buildDeleteHabitCheckinCommand
});
