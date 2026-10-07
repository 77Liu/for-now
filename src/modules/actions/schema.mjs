import { strictDateKey } from "../../shared/time/index.mjs";

export const ACTION_PRIORITIES = Object.freeze(["none", "P0", "P1", "P2", "P3"]);
export const ACTION_STATUSES = Object.freeze(["todo", "doing", "done"]);
export const HABIT_STATUSES = Object.freeze(["active", "paused"]);
export const HABIT_CADENCES = Object.freeze(["daily", "weekly"]);
export const ACTION_FEEDBACK_OUTCOMES = Object.freeze([
  "helpful",
  "mixed",
  "unhelpful",
  "unsure"
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizedText(value, { field, max, required = false, singleLine = false }) {
  if (value == null) {
    if (required) return { error: `${field}不能为空` };
    return { value: "" };
  }
  if (typeof value !== "string") return { error: `${field}必须是文本` };
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const text = singleLine ? normalized.replace(/\s+/g, " ") : normalized;
  if (required && !text) return { error: `${field}不能为空` };
  if (text.length > max) return { error: `${field}不能超过 ${max} 个字符` };
  return { value: text };
}

function enumValue(value, values, field, aliases = {}) {
  if (typeof value !== "string") return { error: `${field}无效` };
  const text = value.trim();
  const normalized = aliases[text.toLowerCase()] || text;
  return values.includes(normalized) ? { value: normalized } : { error: `${field}无效` };
}

export function normalizeIdentifier(value, field = "ID") {
  return normalizedText(value, { field, max: 100, required: true, singleLine: true });
}

export function normalizeExpectedVersion(value) {
  if (value == null || value === "") return { value: null };
  const number = Number(value);
  return Number.isInteger(number) && number > 0
    ? { value: number }
    : { error: "版本必须是正整数" };
}

export function normalizeActionPriority(value) {
  if (value == null || value === "") return { value: "none" };
  return enumValue(value, ACTION_PRIORITIES, "行动优先级", {
    none: "none",
    p0: "P0",
    p1: "P1",
    p2: "P2",
    p3: "P3"
  });
}

export function normalizeActionStatus(value) {
  return enumValue(value, ACTION_STATUSES, "行动状态", {
    pending: "todo",
    in_progress: "doing",
    completed: "done"
  });
}

export function normalizeSourceRef(value) {
  if (value == null || value === "") return { value: null };
  if (!isObject(value)) return { error: "来源关联必须是对象" };
  const type = normalizedText(value.type ?? value.resourceType, {
    field: "来源类型",
    max: 40,
    required: true,
    singleLine: true
  });
  if (type.error) return type;
  if (!/^[a-z][a-z0-9-]*$/.test(type.value)) return { error: "来源类型格式无效" };
  const id = normalizeIdentifier(value.id ?? value.resourceId, "来源 ID");
  if (id.error) return id;
  const label = normalizedText(value.label, {
    field: "来源名称",
    max: 120,
    singleLine: true
  });
  if (label.error) return label;
  return { value: { type: type.value, id: id.value, label: label.value } };
}

export function actionPayload(input, existing = null) {
  if (!isObject(input)) return { error: "行动输入必须是对象" };
  const title = normalizedText(hasOwn(input, "title") ? input.title : existing?.title, {
    field: "行动标题",
    max: 120,
    required: true,
    singleLine: true
  });
  if (title.error) return title;
  const priority = normalizeActionPriority(hasOwn(input, "priority") ? input.priority : existing?.priority);
  if (priority.error) return priority;
  const status = normalizeActionStatus(hasOwn(input, "status") ? input.status : existing?.status || "todo");
  if (status.error) return status;
  const sourceInput = hasOwn(input, "sourceRef")
    ? input.sourceRef
    : hasOwn(input, "source")
      ? input.source
      : existing?.sourceRef;
  const sourceRef = normalizeSourceRef(sourceInput);
  if (sourceRef.error) return sourceRef;
  return {
    value: {
      title: title.value,
      priority: priority.value,
      status: status.value,
      sourceRef: sourceRef.value
    }
  };
}

export function actionCompletionFeedback(input = {}) {
  if (!isObject(input)) return { error: "行动反馈必须是对象" };
  const hasFeedback = hasOwn(input, "outcome")
    || hasOwn(input, "note")
    || hasOwn(input, "learningAllowed");
  if (!hasFeedback) return { value: null };
  const outcome = enumValue(
    input.outcome || "unsure",
    ACTION_FEEDBACK_OUTCOMES,
    "行动结果"
  );
  if (outcome.error) return outcome;
  const note = normalizedText(input.note, {
    field: "行动反馈",
    max: 1000
  });
  if (note.error) return note;
  return {
    value: {
      outcome: outcome.value,
      note: note.value,
      learningAllowed: input.learningAllowed === true
    }
  };
}

export function normalizeHabitStatus(value) {
  return enumValue(value, HABIT_STATUSES, "习惯状态", {
    enabled: "active",
    disabled: "paused",
    inactive: "paused"
  });
}

export function normalizeHabitFrequency(value) {
  if (value == null || value === "") return { value: { cadence: "daily", target: 1 } };
  let cadence;
  let target;
  if (typeof value === "string") {
    cadence = value;
    target = 1;
  } else if (isObject(value)) {
    cadence = value.cadence ?? value.period;
    target = value.target ?? value.times ?? 1;
  } else {
    return { error: "习惯频次无效" };
  }
  const parsedCadence = enumValue(cadence, HABIT_CADENCES, "习惯频次", {
    day: "daily",
    week: "weekly"
  });
  if (parsedCadence.error) return parsedCadence;
  const parsedTarget = Number(target);
  const maximum = parsedCadence.value === "daily" ? 1 : 7;
  if (!Number.isInteger(parsedTarget) || parsedTarget < 1 || parsedTarget > maximum) {
    return { error: parsedCadence.value === "daily" ? "每日习惯目标只能是 1 次" : "每周习惯目标必须是 1 到 7 次" };
  }
  return { value: { cadence: parsedCadence.value, target: parsedTarget } };
}

export function habitPayload(input, existing = null) {
  if (!isObject(input)) return { error: "习惯输入必须是对象" };
  const title = normalizedText(hasOwn(input, "title") ? input.title : existing?.title, {
    field: "习惯标题",
    max: 120,
    required: true,
    singleLine: true
  });
  if (title.error) return title;
  const frequency = normalizeHabitFrequency(hasOwn(input, "frequency") ? input.frequency : existing?.frequency);
  if (frequency.error) return frequency;
  let statusInput = hasOwn(input, "status") ? input.status : existing?.status || "active";
  if (hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") return { error: "习惯启停值必须是布尔值" };
    const enabledStatus = input.enabled ? "active" : "paused";
    if (hasOwn(input, "status")) {
      const explicitStatus = normalizeHabitStatus(input.status);
      if (explicitStatus.error) return explicitStatus;
      if (explicitStatus.value !== enabledStatus) return { error: "习惯状态与启停值冲突" };
    }
    statusInput = enabledStatus;
  }
  const status = normalizeHabitStatus(statusInput);
  if (status.error) return status;
  const adjustment = normalizedText(input.adjustment, {
    field: "习惯调整",
    max: 2000
  });
  if (adjustment.error) return adjustment;
  return {
    value: {
      title: title.value,
      frequency: frequency.value,
      status: status.value,
      adjustment: adjustment.value
    }
  };
}

export function habitCheckinPayload(input, { today, existing = null } = {}) {
  if (!isObject(input)) return { error: "习惯打卡输入必须是对象" };
  const rawDate = hasOwn(input, "occurredOn")
    ? input.occurredOn
    : hasOwn(input, "date")
      ? input.date
      : existing?.occurredOn || today;
  if (typeof rawDate !== "string") return { error: "打卡日期格式不正确" };
  const occurredOn = strictDateKey(rawDate.trim());
  if (!occurredOn) return { error: "打卡日期格式不正确" };
  const feeling = normalizedText(hasOwn(input, "feeling") ? input.feeling : existing?.feeling, {
    field: "打卡感受",
    max: 1000
  });
  if (feeling.error) return feeling;
  const adjustment = normalizedText(hasOwn(input, "adjustment") ? input.adjustment : existing?.adjustment, {
    field: "打卡调整",
    max: 2000
  });
  if (adjustment.error) return adjustment;
  return { value: { occurredOn, feeling: feeling.value, adjustment: adjustment.value } };
}

export function habitAdjustmentPayload(input) {
  if (!isObject(input)) return { error: "习惯调整输入必须是对象" };
  const note = normalizedText(input.note ?? input.adjustment, {
    field: "习惯调整",
    max: 2000,
    required: true
  });
  if (note.error) return note;
  const frequency = hasOwn(input, "frequency") ? normalizeHabitFrequency(input.frequency) : { value: null };
  if (frequency.error) return frequency;
  return { value: { note: note.value, frequency: frequency.value } };
}

export function assertActionsData(value) {
  if (!isObject(value)
    || !Array.isArray(value.actions)
    || !Array.isArray(value.habits)
    || !Array.isArray(value.habitCheckins)) {
    throw new TypeError("Actions repository data must contain actions, habits and habitCheckins arrays");
  }
  return value;
}

export const sameFrequency = (left, right) => (
  left?.cadence === right?.cadence && Number(left?.target) === Number(right?.target)
);
