import crypto from "node:crypto";
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

function normalizeStage(item) {
  const id = text(item?.id, 100);
  if (!id) return null;
  return {
    id,
    provider: text(item.provider, 80),
    service: text(item.service, 100),
    action: text(item.action, 120),
    scene: text(item.scene, 120),
    costKnown: item.costKnown === true,
    estimatedCostMicros: item.costKnown === true ? integer(item.estimatedCostMicros) : 0,
    billingGap: item.costKnown === true ? "" : text(item.billingGap, 500),
    startedAt: safeIso(item.startedAt)
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
    events: normalizeEvents(source.events)
  };
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
      startedAt: stage.startedAt
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
  return appendEvent(state, {
    type: "ai.budget.reservation_released",
    severity: "info",
    createdAt: timestamp,
    accountId: reservation.accountId,
    taskId: reservation.taskId,
    reservationId: reservation.id,
    periodKey: reservation.day,
    reason,
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
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("AI budget service requires an atomic repository with read() and update()");
  }
  const policy = normalizeAiBudgetPolicy(configuredPolicy);
  const normalize = value => normalizeAiBudgetState(value, { policy });
  const update = mutator => repository.update(document => {
    const state = normalize(document);
    const result = mutator(state);
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
        const reservation = {
          ...plan,
          createdAt: timestamp,
          day: keys.day,
          month: keys.month
        };
        state.reservations.push(reservation);
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
        throw budgetError(primary.code, rejectionMessage(primary.code), {
          reasons: result.rejection.reasons,
          eventId: result.rejection.eventId
        });
      }
      return result;
    },

    async startStage({ reservationId, stageId }) {
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
        if (stage.startedAt) return { reservation: publicReservation(reservation), event: null, duplicate: true };
        if (reservation.day !== keys.day || reservation.month !== keys.month) {
          const hasStartedStage = reservation.stages.some(item => item.startedAt);
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
        const event = stage.costKnown
          ? null
          : unknownWarning(state, reservation, stage, ensureDay(state, reservation.day), timestamp, createId);
        return { reservation: publicReservation(reservation), event, duplicate: false };
      });
      if (result.expiration) throw expiredReservationError(result.expiration);
      return result;
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
          const hasStartedStage = reservation.stages.some(stage => stage.startedAt);
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
          const started = Boolean(stage.startedAt || (!crossedPeriod && stageResult?.started === true));
          if (!started) {
            settledStages.push({ stageId: stage.id, started: false, costKnown: stage.costKnown, actualCostCny: 0 });
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
            settledStages.push({ stageId: stage.id, started: true, costKnown: true, actualCostCny: cny(actual) });
          } else {
            unknownCalls += 1;
            settledStages.push({ stageId: stage.id, started: true, costKnown: false, actualCostCny: 0 });
          }
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
        if (reservation.stages.some(stage => stage.startedAt)) {
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
