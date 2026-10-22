import crypto from "node:crypto";
import { readDispatchProof } from "../../../.build/typescript/backend/modules/ai/dispatch-proof.mjs";
import { safeIso, safeText } from "../../shared/validation/index.mjs";

export const AI_BUDGET_VERSION = 1;
export const AI_BUDGET_ALERT_THRESHOLDS = Object.freeze([30, 50, 60, 70, 80, 90, 95, 99, 100]);
export const AI_BUDGET_POLICY = Object.freeze({
  userDailyKnownCostCny: 14.4,
  userDailyCalls: 200,
  siteDailyKnownCostCny: 100,
  siteMonthlyKnownCostCny: 2000,
  siteDailyUnknownCalls: 10,
  dailyAdditionMaxCny: 100,
  monthlyAdditionMaxCny: 2000,
  alertThresholds: AI_BUDGET_ALERT_THRESHOLDS
});

const MICROS_PER_CNY = 1_000_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const RECOVERY_SCOPES = new Set(["dailyKnownCost", "monthlyKnownCost", "dailyUnknownCost"]);

const integer = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const positiveInteger = (value, fallback) => Math.max(1, Math.round(positiveNumber(value, fallback)));
const costMicros = value => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError("AI budget cost must be a non-negative finite CNY amount");
  const micros = Math.ceil(parsed * MICROS_PER_CNY - Number.EPSILON);
  if (!Number.isSafeInteger(micros)) throw new RangeError("AI budget cost is too large");
  return micros;
};
const cny = micros => integer(micros) / MICROS_PER_CNY;
const text = (value, limit = 160) => safeText(value, limit);
const requiredText = (value, field, limit = 160) => {
  const normalized = text(value, limit);
  if (!normalized) throw new TypeError(`AI budget ${field} is required`);
  return normalized;
};
const timestampKeys = timestamp => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new TypeError("AI budget requires a valid UTC timestamp");
  const day = date.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
};
const replaceDocument = (target, source) => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
};

export function normalizeAiBudgetPolicy(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const thresholds = [...new Set((Array.isArray(source.alertThresholds)
    ? source.alertThresholds
    : AI_BUDGET_ALERT_THRESHOLDS)
    .map(item => Math.round(Number(item)))
    .filter(item => item > 0 && item <= 100))]
    .sort((left, right) => left - right);
  return {
    userDailyKnownCostCny: positiveNumber(source.userDailyKnownCostCny, AI_BUDGET_POLICY.userDailyKnownCostCny),
    userDailyCalls: positiveInteger(source.userDailyCalls, AI_BUDGET_POLICY.userDailyCalls),
    siteDailyKnownCostCny: positiveNumber(source.siteDailyKnownCostCny, AI_BUDGET_POLICY.siteDailyKnownCostCny),
    siteMonthlyKnownCostCny: positiveNumber(source.siteMonthlyKnownCostCny, AI_BUDGET_POLICY.siteMonthlyKnownCostCny),
    siteDailyUnknownCalls: positiveInteger(source.siteDailyUnknownCalls, AI_BUDGET_POLICY.siteDailyUnknownCalls),
    dailyAdditionMaxCny: positiveNumber(source.dailyAdditionMaxCny, AI_BUDGET_POLICY.dailyAdditionMaxCny),
    monthlyAdditionMaxCny: positiveNumber(source.monthlyAdditionMaxCny, AI_BUDGET_POLICY.monthlyAdditionMaxCny),
    alertThresholds: thresholds.length ? thresholds : [...AI_BUDGET_ALERT_THRESHOLDS]
  };
}

function normalizeUsers(value) {
  const users = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const accountId = text(item?.accountId, 100);
    if (!accountId) continue;
    const current = users.get(accountId) || { accountId, calls: 0, knownCostMicros: 0 };
    current.calls += integer(item.calls);
    current.knownCostMicros += integer(item.knownCostMicros);
    users.set(accountId, current);
  }
  return [...users.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
}

function normalizeDay(item) {
  const key = text(item?.key, 10);
  if (!DAY_PATTERN.test(key)) return null;
  return {
    key,
    knownCostMicros: integer(item.knownCostMicros),
    unknownCalls: integer(item.unknownCalls),
    additionalKnownCostMicros: integer(item.additionalKnownCostMicros),
    blocked: {
      knownCost: Boolean(item.blocked?.knownCost),
      unknownCost: Boolean(item.blocked?.unknownCost)
    },
    alertedThresholds: [...new Set((Array.isArray(item.alertedThresholds) ? item.alertedThresholds : [])
      .map(value => text(value, 80))
      .filter(Boolean))],
    users: normalizeUsers(item.users)
  };
}

function normalizeMonth(item) {
  const key = text(item?.key, 7);
  if (!MONTH_PATTERN.test(key)) return null;
  return {
    key,
    knownCostMicros: integer(item.knownCostMicros),
    additionalKnownCostMicros: integer(item.additionalKnownCostMicros),
    blocked: { knownCost: Boolean(item.blocked?.knownCost) },
    alertedThresholds: [...new Set((Array.isArray(item.alertedThresholds) ? item.alertedThresholds : [])
      .map(value => text(value, 80))
      .filter(Boolean))]
  };
}

/** 结合持久化未调用证明判断阶段是否可能计费；缺少新字段保守沿用startedAt。
 * @since unreleased
 */
export const stageHasBillableDispatch = stage => Boolean(stage?.startedAt && stage.dispatchState !== "not_invoked");

function normalizeStage(item) {
  const id = text(item?.id, 100);
  if (!id) return null;
  let dispatch = {};
  if (["dispatchAttemptId", "dispatchState", "noIoAt"].some(key => Object.hasOwn(item, key))) {
    if (typeof item.dispatchAttemptId !== "string" || !item.dispatchAttemptId || item.dispatchAttemptId !== text(item.dispatchAttemptId, 100)
      || !["may_have_started", "not_invoked"].includes(item.dispatchState) || !safeIso(item.startedAt)
      || (item.dispatchState === "not_invoked" && !safeIso(item.noIoAt))
      || (item.dispatchState === "may_have_started" && Object.hasOwn(item, "noIoAt"))) throw new Error("AI预算阶段派发证明无效，保留原账本");
    dispatch = { dispatchAttemptId: item.dispatchAttemptId, dispatchState: item.dispatchState,
      ...(item.dispatchState === "not_invoked" ? { noIoAt: safeIso(item.noIoAt) } : {}) };
  }
  return {
    id,
    provider: text(item.provider, 80),
    service: text(item.service, 100),
    action: text(item.action, 120),
    scene: text(item.scene, 120),
    costKnown: item.costKnown === true,
    estimatedCostMicros: item.costKnown === true ? integer(item.estimatedCostMicros) : 0,
    billingGap: item.costKnown === true ? "" : text(item.billingGap, 500),
    startedAt: safeIso(item.startedAt),
    ...dispatch
  };
}

function normalizeReservation(item) {
  const id = text(item?.id, 100);
  const accountId = text(item?.accountId, 100);
  const taskId = text(item?.taskId, 160);
  const day = text(item?.day, 10);
  const month = text(item?.month, 7);
  const stages = (Array.isArray(item?.stages) ? item.stages : []).map(normalizeStage).filter(Boolean);
  if (!id || !accountId || !taskId || !DAY_PATTERN.test(day) || !MONTH_PATTERN.test(month)
    || month !== day.slice(0, 7) || !stages.length || new Set(stages.map(stage => stage.id)).size !== stages.length) {
    return null;
  }
  return {
    id,
    accountId,
    taskId,
    createdAt: safeIso(item.createdAt),
    day,
    month,
    stages
  };
}

function normalizeRecordCompressionQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const days = (Array.isArray(value.days) ? value.days : []).map(item => {
    const key = text(item?.key, 10);
    if (!DAY_PATTERN.test(key)) return null;
    const reservations = (Array.isArray(item.reservations) ? item.reservations : [])
      .map(row => ({
        reservationId: text(row?.reservationId, 100),
        accountId: text(row?.accountId, 100),
        taskId: text(row?.taskId, 160),
        calls: integer(row?.calls),
        costMicros: integer(row?.costMicros)
      }))
      .filter(row => row.reservationId);
    return {
      key,
      calls: integer(item.calls),
      costMicros: integer(item.costMicros),
      reservations: [...new Map(reservations.map(row => [row.reservationId, row])).values()]
    };
  }).filter(Boolean).sort((left, right) => left.key.localeCompare(right.key)).slice(-32);
  return { days };
}

function normalizeEvents(value) {
  const events = [];
  const ids = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const id = text(item?.id, 100);
    const type = text(item?.type, 100);
    const createdAt = safeIso(item?.createdAt);
    if (!id || !type || !createdAt || ids.has(id)) continue;
    try {
      const event = JSON.parse(JSON.stringify(item));
      event.id = id;
      event.type = type;
      event.createdAt = createdAt;
      events.push(event);
      ids.add(id);
    } catch {}
  }
  return events;
}

export function normalizeAiBudgetState(value = {}, { policy = value?.policy } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const days = (Array.isArray(source.days) ? source.days : []).map(normalizeDay).filter(Boolean);
  const months = (Array.isArray(source.months) ? source.months : []).map(normalizeMonth).filter(Boolean);
  const uniquePeriods = rows => [...new Map(rows.map(row => [row.key, row])).values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  const reservations = (Array.isArray(source.reservations) ? source.reservations : [])
    .map(normalizeReservation)
    .filter(Boolean);
  return {
    version: AI_BUDGET_VERSION,
    controlVersion: Math.max(1, integer(source.controlVersion, 1)),
    policy: normalizeAiBudgetPolicy(policy),
    days: uniquePeriods(days),
    months: uniquePeriods(months),
    reservations: [...new Map(reservations.map(item => [item.id, item])).values()],
    events: normalizeEvents(source.events),
    ...(source.recordCompressionQuota !== undefined
      ? { recordCompressionQuota: normalizeRecordCompressionQuota(source.recordCompressionQuota) || { days: [] } }
      : {})
  };
}

function ensureRecordCompressionQuotaDay(state, dayKey) {
  if (!state.recordCompressionQuota) state.recordCompressionQuota = { days: [] };
  let day = state.recordCompressionQuota.days.find(item => item.key === dayKey);
  if (!day) {
    day = { key: dayKey, calls: 0, costMicros: 0, reservations: [] };
    state.recordCompressionQuota.days.push(day);
    state.recordCompressionQuota.days.sort((left, right) => left.key.localeCompare(right.key));
    state.recordCompressionQuota.days = state.recordCompressionQuota.days.slice(-32);
  }
  return day;
}

function compressionQuotaDayKey(timestamp, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function settleRecordCompressionQuota(state, reservationId, calls, costMicros) {
  for (const day of state.recordCompressionQuota?.days || []) {
    const index = day.reservations.findIndex(item => item.reservationId === reservationId);
    if (index < 0) continue;
    day.reservations.splice(index, 1);
    day.calls += calls;
    day.costMicros += costMicros;
    return true;
  }
  return false;
}

function releaseRecordCompressionQuota(state, reservationId) {
  for (const day of state.recordCompressionQuota?.days || []) {
    const index = day.reservations.findIndex(item => item.reservationId === reservationId);
    if (index >= 0) {
      day.reservations.splice(index, 1);
      return true;
    }
  }
  return false;
}

function ensureDay(state, key) {
  let period = state.days.find(item => item.key === key);
  if (!period) {
    period = normalizeDay({ key });
    state.days.push(period);
    state.days.sort((left, right) => left.key.localeCompare(right.key));
  }
  return period;
}

function ensureMonth(state, key) {
  let period = state.months.find(item => item.key === key);
  if (!period) {
    period = normalizeMonth({ key });
    state.months.push(period);
    state.months.sort((left, right) => left.key.localeCompare(right.key));
  }
  return period;
}

function ensureUser(day, accountId) {
  let user = day.users.find(item => item.accountId === accountId);
  if (!user) {
    user = { accountId, calls: 0, knownCostMicros: 0 };
    day.users.push(user);
    day.users.sort((left, right) => left.accountId.localeCompare(right.accountId));
  }
  return user;
}

const reservationKnownCost = reservation => reservation.stages.reduce(
  (sum, stage) => sum + (stage.costKnown ? stage.estimatedCostMicros : 0),
  0
);
const reservationUnknownCalls = reservation => reservation.stages.filter(stage => !stage.costKnown).length;
const reservationsFor = (state, predicate, excludedId = "") => state.reservations
  .filter(item => item.id !== excludedId && predicate(item));
const sumReservations = (reservations, measure) => reservations.reduce((sum, item) => sum + measure(item), 0);

function periodExposure(state, day, month, accountId = "", excludedId = "") {
  const dayReservations = reservationsFor(state, item => item.day === day.key, excludedId);
  const monthReservations = reservationsFor(state, item => item.month === month.key, excludedId);
  const user = accountId
    ? day.users.find(item => item.accountId === accountId) || { calls: 0, knownCostMicros: 0 }
    : null;
  const userReservations = accountId ? dayReservations.filter(item => item.accountId === accountId) : [];
  return {
    dailyKnownCostMicros: day.knownCostMicros + sumReservations(dayReservations, reservationKnownCost),
    monthlyKnownCostMicros: month.knownCostMicros + sumReservations(monthReservations, reservationKnownCost),
    dailyUnknownCalls: day.unknownCalls + sumReservations(dayReservations, reservationUnknownCalls),
    userCalls: user ? user.calls + sumReservations(userReservations, item => item.stages.length) : 0,
    userKnownCostMicros: user
      ? user.knownCostMicros + sumReservations(userReservations, reservationKnownCost)
      : 0
  };
}

const effectiveDailyLimit = (day, policy) => costMicros(policy.siteDailyKnownCostCny)
  + day.additionalKnownCostMicros;
const effectiveMonthlyLimit = (month, policy) => costMicros(policy.siteMonthlyKnownCostCny)
  + month.additionalKnownCostMicros;

const stageDispatchHistory = stage => stage.dispatchAttemptId ? {
  startedAt: stage.startedAt, dispatchAttemptId: stage.dispatchAttemptId, dispatchState: stage.dispatchState,
  ...(stage.noIoAt ? { noIoAt: stage.noIoAt } : {})
} : {};

function publicReservation(reservation, duplicate = false) {
  return {
    id: reservation.id,
    accountId: reservation.accountId,
    taskId: reservation.taskId,
    createdAt: reservation.createdAt,
    day: reservation.day,
    month: reservation.month,
    duplicate,
    stages: reservation.stages.map(stage => ({
      id: stage.id,
      provider: stage.provider,
      service: stage.service,
      action: stage.action,
      scene: stage.scene,
      costKnown: stage.costKnown,
      estimatedCostCny: cny(stage.estimatedCostMicros),
      billingGap: stage.billingGap,
      startedAt: stage.startedAt,
      ...stageDispatchHistory(stage)
    }))
  };
}

function budgetError(code, message, details = {}) {
  return Object.assign(new Error(message), { statusCode: 429, code, ...details });
}

function normalizePlan(input, createId) {
  const accountId = requiredText(input?.accountId, "accountId", 100);
  const taskId = requiredText(input?.taskId, "taskId", 160);
  const seen = new Set();
  const stages = (Array.isArray(input?.stages) ? input.stages : []).map((item, index) => {
    const id = text(item?.id, 100) || `stage-${index + 1}`;
    if (seen.has(id)) throw new TypeError("AI budget stage ids must be unique");
    seen.add(id);
    const costKnown = item?.costKnown === true;
    const stage = {
      id,
      provider: requiredText(item?.provider, "stage.provider", 80),
      service: requiredText(item?.service, "stage.service", 100),
      action: text(item?.action, 120),
      scene: requiredText(item?.scene, "stage.scene", 120),
      costKnown,
      estimatedCostMicros: costKnown ? costMicros(item?.estimatedCostCny ?? 0) : 0,
      billingGap: costKnown ? "" : requiredText(item?.billingGap, "stage.billingGap", 500),
      startedAt: ""
    };
    return stage;
  });
  if (!stages.length) throw new TypeError("AI budget reservation requires at least one stage");
  return { id: createId(), accountId, taskId, stages };
}

const comparableStages = stages => stages.map(stage => ({
  id: stage.id,
  provider: stage.provider,
  service: stage.service,
  action: stage.action,
  scene: stage.scene,
  costKnown: stage.costKnown,
  estimatedCostMicros: stage.estimatedCostMicros,
  billingGap: stage.billingGap
}));
const samePlan = (reservation, plan) => JSON.stringify(comparableStages(reservation.stages))
  === JSON.stringify(comparableStages(plan.stages));

function appendEvent(state, event, createId) {
  const value = {
    schemaVersion: 1,
    id: createId(),
    createdAt: event.createdAt,
    ...event
  };
  state.events.push(value);
  return value;
}

function releaseReservation(state, index, reservation, {
  timestamp,
  reason,
  createId,
  details = {}
}) {
  state.reservations.splice(index, 1);
  releaseRecordCompressionQuota(state, reservation.id);
  return appendEvent(state, {
    type: "ai.budget.reservation_released",
    severity: "info",
    createdAt: timestamp,
    accountId: reservation.accountId,
    taskId: reservation.taskId,
    reservationId: reservation.id,
    periodKey: reservation.day,
    reason,
    ...(reservation.stages.some(stage => stage.dispatchAttemptId) ? { stages: reservation.stages.map(stage => ({ stageId: stage.id, ...stageDispatchHistory(stage) })) } : {}),
    ...details
  }, createId);
}

function expiredReservationError(expiration) {
  return Object.assign(new Error("AI budget reservation expired before stage start"), {
    statusCode: 409,
    code: "AI_BUDGET_RESERVATION_EXPIRED",
    ...expiration
  });
}

function reservationExpiration(reservation, keys, hasStartedStage) {
  return {
    reservationId: reservation.id,
    reservedDay: reservation.day,
    reservedMonth: reservation.month,
    currentDay: keys.day,
    currentMonth: keys.month,
    released: !hasStartedStage,
    requiresSettlement: hasStartedStage
  };
}

function thresholdEvents(state, {
  scope,
  period,
  exposureMicros,
  limitMicros,
  context,
  timestamp,
  createId
}) {
  const events = [];
  if (limitMicros <= 0) return events;
  for (const thresholdPct of state.policy.alertThresholds) {
    const token = `${limitMicros}:${thresholdPct}`;
    if (period.alertedThresholds.includes(token)
      || exposureMicros * 100 < limitMicros * thresholdPct) continue;
    period.alertedThresholds.push(token);
    events.push(appendEvent(state, {
      type: "ai.budget.threshold_reached",
      severity: thresholdPct === 100 ? "critical" : "warning",
      createdAt: timestamp,
      scope,
      thresholdPct,
      periodKey: period.key,
      exposureCny: cny(exposureMicros),
      effectiveLimitCny: cny(limitMicros),
      ...context
    }, createId));
  }
  return events;
}

function rejectionReasons({ state, day, month, exposure, requested, accountId }) {
  const policy = state.policy;
  const reasons = [];
  const limits = {
    userCalls: policy.userDailyCalls,
    userKnownCostMicros: costMicros(policy.userDailyKnownCostCny),
    dailyKnownCostMicros: effectiveDailyLimit(day, policy),
    monthlyKnownCostMicros: effectiveMonthlyLimit(month, policy),
    dailyUnknownCalls: policy.siteDailyUnknownCalls
  };
  if (exposure.userCalls + requested.calls > limits.userCalls) {
    reasons.push({
      code: "AI_DAILY_CALL_LIMIT",
      scope: "userDailyCalls",
      accountId,
      current: exposure.userCalls,
      requested: requested.calls,
      limit: limits.userCalls
    });
  }
  if (exposure.userKnownCostMicros >= limits.userKnownCostMicros
    || exposure.userKnownCostMicros + requested.knownCostMicros > limits.userKnownCostMicros) {
    reasons.push({
      code: "AI_DAILY_COST_LIMIT",
      scope: "userDailyKnownCost",
      accountId,
      currentCny: cny(exposure.userKnownCostMicros),
      requestedCny: cny(requested.knownCostMicros),
      limitCny: cny(limits.userKnownCostMicros)
    });
  }
  if (day.blocked.knownCost
    || exposure.dailyKnownCostMicros >= limits.dailyKnownCostMicros
    || exposure.dailyKnownCostMicros + requested.knownCostMicros > limits.dailyKnownCostMicros) {
    reasons.push({
      code: "AI_SITE_DAILY_COST_LIMIT",
      scope: "siteDailyKnownCost",
      blocked: day.blocked.knownCost,
      currentCny: cny(exposure.dailyKnownCostMicros),
      requestedCny: cny(requested.knownCostMicros),
      limitCny: cny(limits.dailyKnownCostMicros)
    });
  }
  if (month.blocked.knownCost
    || exposure.monthlyKnownCostMicros >= limits.monthlyKnownCostMicros
    || exposure.monthlyKnownCostMicros + requested.knownCostMicros > limits.monthlyKnownCostMicros) {
    reasons.push({
      code: "AI_SITE_MONTHLY_COST_LIMIT",
      scope: "siteMonthlyKnownCost",
      blocked: month.blocked.knownCost,
      currentCny: cny(exposure.monthlyKnownCostMicros),
      requestedCny: cny(requested.knownCostMicros),
      limitCny: cny(limits.monthlyKnownCostMicros)
    });
  }
  if (requested.unknownCalls > 0
    && (day.blocked.unknownCost || exposure.dailyUnknownCalls + requested.unknownCalls > limits.dailyUnknownCalls)) {
    reasons.push({
      code: "AI_SITE_DAILY_UNKNOWN_COST_LIMIT",
      scope: "siteDailyUnknownCost",
      blocked: day.blocked.unknownCost,
      current: exposure.dailyUnknownCalls,
      requested: requested.unknownCalls,
      limit: limits.dailyUnknownCalls
    });
  }
  return reasons;
}

const rejectionMessage = code => ({
  AI_DAILY_CALL_LIMIT: "今日 AI 调用次数已达到上限，请明天再试",
  AI_DAILY_COST_LIMIT: "今日 AI 费用额度已达到上限，请明天再试",
  AI_SITE_DAILY_COST_LIMIT: "全站今日 AI 已知费用额度不足",
  AI_SITE_MONTHLY_COST_LIMIT: "全站本月 AI 已知费用额度不足",
  AI_SITE_DAILY_UNKNOWN_COST_LIMIT: "全站今日未知费用服务调用次数已达到上限"
})[code] || "AI 预算额度不足";

function unknownWarning(state, reservation, stage, day, timestamp, createId) {
  const exposure = periodExposure(
    state,
    day,
    ensureMonth(state, reservation.month),
    reservation.accountId
  );
  return appendEvent(state, {
    type: "ai.budget.unknown_cost_warning",
    severity: "warning",
    createdAt: timestamp,
    scope: "siteDailyUnknownCost",
    periodKey: reservation.day,
    accountId: reservation.accountId,
    taskId: reservation.taskId,
    reservationId: reservation.id,
    stageId: stage.id,
    provider: stage.provider,
    service: stage.service,
    action: stage.action,
    scene: stage.scene,
    billingGap: stage.billingGap,
    exposureCalls: exposure.dailyUnknownCalls,
    limitCalls: state.policy.siteDailyUnknownCalls
  }, createId);
}

function statusFromState(state, keys, accountId = "") {
  const day = ensureDay(state, keys.day);
  const month = ensureMonth(state, keys.month);
  const exposure = periodExposure(state, day, month, accountId);
  const user = accountId
    ? day.users.find(item => item.accountId === accountId) || {
        accountId,
        calls: 0,
        knownCostMicros: 0
      }
    : null;
  return {
    controlVersion: state.controlVersion,
    policy: structuredClone(state.policy),
    day: {
      key: day.key,
      committedKnownCostCny: cny(day.knownCostMicros),
      reservedKnownCostCny: cny(exposure.dailyKnownCostMicros - day.knownCostMicros),
      effectiveKnownCostLimitCny: cny(effectiveDailyLimit(day, state.policy)),
      committedUnknownCalls: day.unknownCalls,
      reservedUnknownCalls: exposure.dailyUnknownCalls - day.unknownCalls,
      unknownCallLimit: state.policy.siteDailyUnknownCalls,
      blocked: structuredClone(day.blocked)
    },
    month: {
      key: month.key,
      committedKnownCostCny: cny(month.knownCostMicros),
      reservedKnownCostCny: cny(exposure.monthlyKnownCostMicros - month.knownCostMicros),
      effectiveKnownCostLimitCny: cny(effectiveMonthlyLimit(month, state.policy)),
      blocked: structuredClone(month.blocked)
    },
    ...(user ? {
      user: {
        accountId,
        committedCalls: user.calls,
        reservedCalls: exposure.userCalls - user.calls,
        callLimit: state.policy.userDailyCalls,
        committedKnownCostCny: cny(user.knownCostMicros),
        reservedKnownCostCny: cny(exposure.userKnownCostMicros - user.knownCostMicros),
        knownCostLimitCny: state.policy.userDailyKnownCostCny
      }
    } : {}),
    activeReservations: state.reservations.length,
    eventCount: state.events.length
  };
}

function assertExpectedControlVersion(state, expectedVersion) {
  if (expectedVersion == null) {
    throw Object.assign(new Error("AI budget Owner command requires expectedVersion"), {
      statusCode: 428,
      code: "PRECONDITION_REQUIRED"
    });
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw Object.assign(new Error("AI budget expectedVersion must be a positive safe integer"), {
      statusCode: 400,
      code: "INVALID_EXPECTED_VERSION"
    });
  }
  if (expectedVersion !== state.controlVersion) {
    throw Object.assign(new Error("AI budget control state has changed"), {
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      details: { currentVersion: state.controlVersion }
    });
  }
}

function incrementControlVersion(state) {
  if (state.controlVersion >= Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new RangeError("AI budget control version is exhausted"), {
      statusCode: 409,
      code: "AI_BUDGET_CONTROL_VERSION_EXHAUSTED"
    });
  }
  state.controlVersion += 1;
  return state.controlVersion;
}

// repository.update(mutator) must serialize all site-wide writers, commit the
// mutated JSON document atomically, and leave it unchanged when mutator throws.
export function createAiBudgetService({
  repository,
  policy: configuredPolicy = AI_BUDGET_POLICY,
  recordCompressionDailyBudgetCny = 0,
  recordCompressionDailyInvocationLimit = 0,
  recordCompressionScene = "",
  recordCompressionTimezone = "",
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("AI budget service requires an atomic repository with read() and update()");
  }
  const policy = normalizeAiBudgetPolicy(configuredPolicy);
  const compressionBudgetMicros = recordCompressionDailyBudgetCny > 0
    ? costMicros(recordCompressionDailyBudgetCny)
    : 0;
  const compressionCallLimit = Number(recordCompressionDailyInvocationLimit);
  if (compressionBudgetMicros > 0
    && (!Number.isSafeInteger(compressionCallLimit) || compressionCallLimit <= 0)) {
    throw new TypeError("AI budget record-compression invocation limit must be a positive safe integer");
  }
  if (compressionBudgetMicros > 0
    && (typeof recordCompressionScene !== "string" || !recordCompressionScene.trim())) {
    throw new TypeError("AI budget record-compression scene is required");
  }
  if (compressionBudgetMicros > 0
    && (typeof recordCompressionTimezone !== "string" || !recordCompressionTimezone.trim())) {
    throw new TypeError("AI budget record-compression timezone is required");
  }
  if (compressionBudgetMicros > 0) new Intl.DateTimeFormat("en", { timeZone: recordCompressionTimezone });
  const normalize = value => normalizeAiBudgetState(value, { policy });
  const update = mutator => repository.update((document, atomicState = null) => {
    const state = normalize(document);
    if (atomicState?.recordCompressionQuota) {
      state.recordCompressionQuota = normalizeRecordCompressionQuota(atomicState.recordCompressionQuota)
        || { days: [] };
    }
    const result = mutator(state);
    if (atomicState) {
      atomicState.recordCompressionQuota = state.recordCompressionQuota || { days: [] };
      delete state.recordCompressionQuota;
    }
    replaceDocument(document, state);
    return result;
  });

  return {
    async read() {
      return normalize(await repository.read());
    },

    async status({ accountId = "" } = {}) {
      const timestamp = now();
      const keys = timestampKeys(timestamp);
      return statusFromState(normalize(await repository.read()), keys, text(accountId, 100));
    },

    async reserveTask(input) {
      const timestamp = now();
      const keys = timestampKeys(timestamp);
      const plan = normalizePlan(input, createId);
      const result = await update(state => {
        const existing = state.reservations.find(item => item.accountId === plan.accountId && item.taskId === plan.taskId);
        if (existing) {
          if (!samePlan(existing, plan)) {
            throw Object.assign(new Error("AI task already has a different budget reservation"), {
              statusCode: 409,
              code: "AI_BUDGET_RESERVATION_CONFLICT"
            });
          }
          return { reservation: publicReservation(existing, true), events: [] };
        }
        const day = ensureDay(state, keys.day);
        const month = ensureMonth(state, keys.month);
        const exposure = periodExposure(state, day, month, plan.accountId);
        const requested = {
          calls: plan.stages.length,
          knownCostMicros: reservationKnownCost(plan),
          unknownCalls: reservationUnknownCalls(plan)
        };
        const reasons = rejectionReasons({
          state,
          day,
          month,
          exposure,
          requested,
          accountId: plan.accountId
        });
        if (reasons.length) {
          const event = appendEvent(state, {
            type: "ai.budget.reservation_rejected",
            severity: "critical",
            createdAt: timestamp,
            accountId: plan.accountId,
            taskId: plan.taskId,
            periodKey: keys.day,
            reasons
          }, createId);
          return { rejection: { reasons, eventId: event.id } };
        }
        const compressionStages = recordCompressionScene
          ? plan.stages.filter(stage => stage.scene === recordCompressionScene)
          : [];
        let compressionDay = null;
        let compressionCostMicros = 0;
        if (compressionStages.length && compressionBudgetMicros > 0) {
          if (compressionStages.some(stage => !stage.costKnown)) {
            const reason = {
              code: "AI_RECORD_COMPRESSION_COST_UNKNOWN",
              message: "思绪压缩任务缺少可计量的费用上限，已阻止调用"
            };
            const event = appendEvent(state, {
              type: "ai.budget.reservation_rejected",
              severity: "critical",
              createdAt: timestamp,
              accountId: plan.accountId,
              taskId: plan.taskId,
              periodKey: keys.day,
              reasons: [reason]
            }, createId);
            return { rejection: { reasons: [reason], eventId: event.id } };
          }
          const quotaDayKey = compressionQuotaDayKey(timestamp, recordCompressionTimezone);
          compressionDay = ensureRecordCompressionQuotaDay(state, quotaDayKey);
          compressionCostMicros = reservationKnownCost({ stages: compressionStages });
          const heldCalls = compressionDay.reservations.reduce((sum, item) => sum + item.calls, 0);
          const heldCostMicros = compressionDay.reservations.reduce((sum, item) => sum + item.costMicros, 0);
          if (compressionDay.calls + heldCalls + compressionStages.length > compressionCallLimit
            || compressionDay.costMicros + heldCostMicros + compressionCostMicros > compressionBudgetMicros) {
            const reason = {
              code: "AI_RECORD_COMPRESSION_DAILY_LIMIT",
              message: "今日思绪压缩额度已用完，任务未调用模型"
            };
            const event = appendEvent(state, {
              type: "ai.budget.reservation_rejected",
              severity: "critical",
              createdAt: timestamp,
              accountId: plan.accountId,
              taskId: plan.taskId,
              periodKey: quotaDayKey,
              reasons: [reason]
            }, createId);
            return { rejection: { reasons: [reason], eventId: event.id } };
          }
        }
        const reservation = {
          ...plan,
          createdAt: timestamp,
          day: keys.day,
          month: keys.month
        };
        state.reservations.push(reservation);
        if (compressionDay) {
          compressionDay.reservations.push({
            reservationId: plan.id,
            accountId: plan.accountId,
            taskId: plan.taskId,
            calls: compressionStages.length,
            costMicros: compressionCostMicros
          });
        }
        const nextExposure = periodExposure(state, day, month, plan.accountId);
        const context = {
          accountId: plan.accountId,
          taskId: plan.taskId,
          reservationId: plan.id
        };
        const events = [
          ...thresholdEvents(state, {
            scope: "siteDailyKnownCost",
            period: day,
            exposureMicros: nextExposure.dailyKnownCostMicros,
            limitMicros: effectiveDailyLimit(day, state.policy),
            context,
            timestamp,
            createId
          }),
          ...thresholdEvents(state, {
            scope: "siteMonthlyKnownCost",
            period: month,
            exposureMicros: nextExposure.monthlyKnownCostMicros,
            limitMicros: effectiveMonthlyLimit(month, state.policy),
            context,
            timestamp,
            createId
          })
        ];
        return { reservation: publicReservation(reservation), events };
      });
      if (result.rejection) {
        const primary = result.rejection.reasons[0];
        throw budgetError(primary.code, primary.message || rejectionMessage(primary.code), {
          reasons: result.rejection.reasons,
          eventId: result.rejection.eventId
        });
      }
      return result;
    },

    async startStage({ reservationId, stageId, dispatchAttemptId }) {
      const timestamp = now();
      const keys = timestampKeys(timestamp);
      const result = await update(state => {
        const index = state.reservations.findIndex(item => item.id === text(reservationId, 100));
        if (index < 0) throw Object.assign(new Error("AI budget reservation was not found"), {
          statusCode: 404,
          code: "AI_BUDGET_RESERVATION_NOT_FOUND"
        });
        const reservation = state.reservations[index];
        const stage = reservation.stages.find(item => item.id === text(stageId, 100));
        if (!stage) throw Object.assign(new Error("AI budget reservation stage was not found"), {
          statusCode: 404,
          code: "AI_BUDGET_STAGE_NOT_FOUND"
        });
        if (stage.startedAt) {
          if (dispatchAttemptId !== undefined && stage.dispatchAttemptId !== dispatchAttemptId) throw Object.assign(new Error("预算阶段派发attempt冲突"), { code: "AI_BUDGET_STAGE_ALREADY_STARTED", statusCode: 409 });
          return { reservation: publicReservation(reservation), event: null, duplicate: true };
        }
        if (reservation.day !== keys.day || reservation.month !== keys.month) {
          const hasStartedStage = reservation.stages.some(stageHasBillableDispatch);
          const expiration = reservationExpiration(reservation, keys, hasStartedStage);
          if (!hasStartedStage) {
            const event = releaseReservation(state, index, reservation, {
              timestamp,
              reason: "period_expired",
              createId,
              details: {
                reservedMonthKey: reservation.month,
                currentPeriodKey: keys.day,
                currentMonthKey: keys.month
              }
            });
            expiration.eventId = event.id;
          }
          return { expiration };
        }
        stage.startedAt = timestamp;
        if (dispatchAttemptId !== undefined) {
          if (typeof dispatchAttemptId !== "string" || !dispatchAttemptId || dispatchAttemptId !== text(dispatchAttemptId, 100)) throw new TypeError("AI预算派发attempt无效");
          stage.dispatchAttemptId = dispatchAttemptId; stage.dispatchState = "may_have_started";
        }
        const event = stage.costKnown
          ? null
          : unknownWarning(state, reservation, stage, ensureDay(state, reservation.day), timestamp, createId);
        return { reservation: publicReservation(reservation), event, duplicate: false };
      });
      if (result.expiration) throw expiredReservationError(result.expiration);
      return result;
    },

    /** 仅接收活的内部执行能力证明；阶段关闭且从未invoke后条件持久化，不能由HTTP正文声明免费。
     * @since unreleased
     */
    async markStageNotInvoked({ reservationId, stageId, dispatchAttemptId }, capability) {
      const proof = readDispatchProof(capability);
      if (!proof || proof.reservationId !== reservationId || proof.stageId !== stageId || proof.dispatchAttemptId !== dispatchAttemptId) throw Object.assign(new Error("未调用证明能力无效"), { code: "AI_BUDGET_PROOF_INVALID", statusCode: 403 });
      return update(state => {
        const reservation = state.reservations.find(item => item.id === reservationId);
        if (!reservation) return { marked: false, duplicate: true };
        const stage = reservation.stages.find(item => item.id === stageId);
        if (!stage?.startedAt || stage.dispatchAttemptId !== dispatchAttemptId || !["may_have_started", "not_invoked"].includes(stage.dispatchState)) throw Object.assign(new Error("预算阶段证明身份冲突"), { code: "AI_BUDGET_PROOF_CONFLICT", statusCode: 409 });
        if (stage.dispatchState === "not_invoked") return { marked: true, duplicate: true };
        stage.dispatchState = "not_invoked"; stage.noIoAt = now();
        const event = appendEvent(state, { type: "ai.budget.stage_not_invoked", severity: "info", createdAt: stage.noIoAt,
          accountId: reservation.accountId, taskId: reservation.taskId, reservationId, stageId,
          dispatchAttemptId, startedAt: stage.startedAt, noIoAt: stage.noIoAt, reason: proof.reason }, createId);
        return { marked: true, duplicate: false, event };
      });
    },

    async settleTask({ reservationId, stages = [], outcome = "completed" }) {
      const timestamp = now();
      const settlementKeys = timestampKeys(timestamp);
      const supplied = new Map((Array.isArray(stages) ? stages : []).map(item => [text(item?.stageId, 100), item]));
      const result = await update(state => {
        const index = state.reservations.findIndex(item => item.id === text(reservationId, 100));
        if (index < 0) throw Object.assign(new Error("AI budget reservation was not found"), {
          statusCode: 404,
          code: "AI_BUDGET_RESERVATION_NOT_FOUND"
        });
        const reservation = state.reservations[index];
        for (const stageId of supplied.keys()) {
          if (!reservation.stages.some(stage => stage.id === stageId)) {
            throw Object.assign(new Error("AI budget reservation stage was not found"), {
              statusCode: 404,
              code: "AI_BUDGET_STAGE_NOT_FOUND"
            });
          }
        }
        const crossedPeriod = reservation.day !== settlementKeys.day
          || reservation.month !== settlementKeys.month;
        if (crossedPeriod) {
          const hasStartedStage = reservation.stages.some(stageHasBillableDispatch);
          const attemptsLateStart = reservation.stages.some(stage => (
            !stage.startedAt && supplied.get(stage.id)?.started === true
          ));
          if (!hasStartedStage || attemptsLateStart) {
            const expiration = reservationExpiration(reservation, settlementKeys, hasStartedStage);
            if (!hasStartedStage) {
              const event = releaseReservation(state, index, reservation, {
                timestamp,
                reason: "period_expired",
                createId,
                details: {
                  reservedMonthKey: reservation.month,
                  currentPeriodKey: settlementKeys.day,
                  currentMonthKey: settlementKeys.month
                }
              });
              expiration.eventId = event.id;
            }
            return { expiration };
          }
        }
        // Started work remains charged to the UTC period that granted its reservation.
        const day = ensureDay(state, reservation.day);
        const month = ensureMonth(state, reservation.month);
        const user = ensureUser(day, reservation.accountId);
        let calls = 0;
        let unknownCalls = 0;
        let knownCostMicros = 0;
        const events = [];
        const settledStages = [];
        for (const stage of reservation.stages) {
          const stageResult = supplied.get(stage.id);
          const started = stage.dispatchState !== "not_invoked" && Boolean(stage.startedAt || (!crossedPeriod && stageResult?.started === true));
          if (!started) {
            settledStages.push({ stageId: stage.id, started: false, costKnown: stage.costKnown, actualCostCny: 0, ...stageDispatchHistory(stage) });
            continue;
          }
          const costKnown = stage.costKnown && stageResult?.costKnown !== false;
          if (!stage.startedAt) {
            stage.startedAt = timestamp;
            if (!costKnown) events.push(unknownWarning(state, reservation, stage, day, timestamp, createId));
          } else if (stage.costKnown && !costKnown) {
            events.push(unknownWarning(state, reservation, stage, day, timestamp, createId));
          }
          calls += 1;
          if (costKnown) {
            const actual = stageResult && Object.hasOwn(stageResult, "actualCostCny")
              ? costMicros(stageResult.actualCostCny)
              : stage.estimatedCostMicros;
            knownCostMicros += actual;
            settledStages.push({ stageId: stage.id, started: true, costKnown: true, actualCostCny: cny(actual), ...stageDispatchHistory(stage) });
          } else {
            unknownCalls += 1;
            settledStages.push({ stageId: stage.id, started: true, costKnown: false, actualCostCny: 0, ...stageDispatchHistory(stage) });
          }
        }
        const compressionStageIds = new Set(reservation.stages
          .filter(stage => recordCompressionScene && stage.scene === recordCompressionScene)
          .map(stage => stage.id));
        const compressionSettlement = settledStages.filter(stage => (
          compressionStageIds.has(stage.stageId) && stage.started
        ));
        if (compressionSettlement.length) {
          const actualCompressionCostMicros = compressionSettlement.reduce(
            (sum, settledStage) => {
              const reservedStage = reservation.stages.find(stage => stage.id === settledStage.stageId);
              return sum + (settledStage.costKnown
                ? costMicros(settledStage.actualCostCny)
                : (reservedStage?.estimatedCostMicros || 0));
            },
            0
          );
          settleRecordCompressionQuota(
            state,
            reservation.id,
            compressionSettlement.length,
            actualCompressionCostMicros
          );
        } else {
          releaseRecordCompressionQuota(state, reservation.id);
        }
        state.reservations.splice(index, 1);
        day.knownCostMicros += knownCostMicros;
        day.unknownCalls += unknownCalls;
        month.knownCostMicros += knownCostMicros;
        user.calls += calls;
        user.knownCostMicros += knownCostMicros;
        const exposure = periodExposure(state, day, month, reservation.accountId);
        const context = {
          accountId: reservation.accountId,
          taskId: reservation.taskId,
          reservationId: reservation.id
        };
        events.push(
          ...thresholdEvents(state, {
            scope: "siteDailyKnownCost",
            period: day,
            exposureMicros: exposure.dailyKnownCostMicros,
            limitMicros: effectiveDailyLimit(day, state.policy),
            context,
            timestamp,
            createId
          }),
          ...thresholdEvents(state, {
            scope: "siteMonthlyKnownCost",
            period: month,
            exposureMicros: exposure.monthlyKnownCostMicros,
            limitMicros: effectiveMonthlyLimit(month, state.policy),
            context,
            timestamp,
            createId
          })
        );
        if (day.knownCostMicros >= effectiveDailyLimit(day, state.policy)) day.blocked.knownCost = true;
        if (month.knownCostMicros >= effectiveMonthlyLimit(month, state.policy)) month.blocked.knownCost = true;
        if (day.unknownCalls >= state.policy.siteDailyUnknownCalls) day.blocked.unknownCost = true;
        events.push(appendEvent(state, {
          type: "ai.budget.reservation_settled",
          severity: "info",
          createdAt: timestamp,
          accountId: reservation.accountId,
          taskId: reservation.taskId,
          reservationId: reservation.id,
          periodKey: reservation.day,
          monthKey: reservation.month,
          settledAtPeriodKey: settlementKeys.day,
          settledAtMonthKey: settlementKeys.month,
          outcome: text(outcome, 80) || "completed",
          calls,
          knownCostCny: cny(knownCostMicros),
          unknownCalls,
          stages: settledStages
        }, createId));
        return {
          reservation: publicReservation(reservation),
          settlement: {
            accountingDay: reservation.day,
            accountingMonth: reservation.month,
            settledAtDay: settlementKeys.day,
            settledAtMonth: settlementKeys.month,
            calls,
            knownCostCny: cny(knownCostMicros),
            unknownCalls,
            stages: settledStages
          },
          events
        };
      });
      if (result.expiration) throw expiredReservationError(result.expiration);
      return result;
    },

    async releaseTask({ reservationId, reason = "not_started" }) {
      const timestamp = now();
      return update(state => {
        const index = state.reservations.findIndex(item => item.id === text(reservationId, 100));
        if (index < 0) return { released: false, duplicate: true, event: null };
        const reservation = state.reservations[index];
        if (reservation.stages.some(stageHasBillableDispatch)) {
          throw Object.assign(new Error("Started AI budget stages must be settled, not released"), {
            statusCode: 409,
            code: "AI_BUDGET_STAGE_ALREADY_STARTED"
          });
        }
        const event = releaseReservation(state, index, reservation, {
          timestamp,
          reason: text(reason, 200) || "not_started",
          createId
        });
        return { released: true, duplicate: false, reservation: publicReservation(reservation), event };
      });
    },

    // G2/capability authorization belongs to the Owner application layer.
    async ownerAddTemporaryBudget({ scope, amountCny, actorId, reason, expectedVersion }) {
      if (!["daily", "monthly"].includes(scope)) throw new TypeError("AI budget addition scope must be daily or monthly");
      const actor = requiredText(actorId, "owner actorId", 100);
      const explanation = requiredText(reason, "owner reason", 500);
      const amountMicros = costMicros(amountCny);
      if (amountMicros <= 0) throw new TypeError("AI budget addition must be greater than zero");
      const maximum = scope === "daily" ? policy.dailyAdditionMaxCny : policy.monthlyAdditionMaxCny;
      if (amountMicros > costMicros(maximum)) {
        throw Object.assign(new RangeError(`AI budget ${scope} addition exceeds the per-operation maximum`), {
          statusCode: 400,
          code: scope === "daily" ? "AI_DAILY_ADDITION_TOO_LARGE" : "AI_MONTHLY_ADDITION_TOO_LARGE",
          maximumCny: maximum
        });
      }
      const timestamp = now();
      const keys = timestampKeys(timestamp);
      return update(state => {
        assertExpectedControlVersion(state, expectedVersion);
        const period = scope === "daily" ? ensureDay(state, keys.day) : ensureMonth(state, keys.month);
        period.additionalKnownCostMicros += amountMicros;
        if (!Number.isSafeInteger(period.additionalKnownCostMicros)) throw new RangeError("AI budget additions are too large");
        const effectiveLimitMicros = scope === "daily"
          ? effectiveDailyLimit(period, state.policy)
          : effectiveMonthlyLimit(period, state.policy);
        const controlVersion = incrementControlVersion(state);
        const event = appendEvent(state, {
          type: "ai.budget.owner_temporary_addition",
          severity: "warning",
          createdAt: timestamp,
          scope: scope === "daily" ? "siteDailyKnownCost" : "siteMonthlyKnownCost",
          periodKey: period.key,
          actorId: actor,
          reason: explanation,
          amountCny: cny(amountMicros),
          effectiveLimitCny: cny(effectiveLimitMicros),
          controlVersion
        }, createId);
        return {
          scope,
          periodKey: period.key,
          amountCny: cny(amountMicros),
          effectiveLimitCny: cny(effectiveLimitMicros),
          controlVersion,
          event,
          status: statusFromState(state, keys)
        };
      });
    },

    // This clears only the sticky block. It never changes usage or limits.
    async ownerRecover({ scope, actorId, reason, expectedVersion }) {
      if (!RECOVERY_SCOPES.has(scope)) throw new TypeError("AI budget recovery scope is invalid");
      const actor = requiredText(actorId, "owner actorId", 100);
      const explanation = requiredText(reason, "owner reason", 500);
      const timestamp = now();
      const keys = timestampKeys(timestamp);
      return update(state => {
        assertExpectedControlVersion(state, expectedVersion);
        const day = ensureDay(state, keys.day);
        const month = ensureMonth(state, keys.month);
        const period = scope === "monthlyKnownCost" ? month : day;
        const wasBlocked = scope === "dailyKnownCost"
          ? day.blocked.knownCost
          : scope === "dailyUnknownCost"
            ? day.blocked.unknownCost
            : month.blocked.knownCost;
        if (scope === "dailyKnownCost") day.blocked.knownCost = false;
        else if (scope === "dailyUnknownCost") day.blocked.unknownCost = false;
        else month.blocked.knownCost = false;
        const controlVersion = incrementControlVersion(state);
        const event = appendEvent(state, {
          type: "ai.budget.owner_recovery",
          severity: "warning",
          createdAt: timestamp,
          scope,
          periodKey: period.key,
          actorId: actor,
          reason: explanation,
          wasBlocked,
          controlVersion
        }, createId);
        return {
          scope,
          periodKey: period.key,
          wasBlocked,
          controlVersion,
          event,
          status: statusFromState(state, keys)
        };
      });
    }
  };
}
