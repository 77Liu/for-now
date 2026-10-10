import { safeText } from "../validation/index.mjs";

export const DEFAULT_RECORD_TIMEZONE = "Asia/Shanghai";

export const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const shiftDateKey = (dateKey, days) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return dateKey;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

export const strictDateKey = value => {
  const text = safeText(value, 20);
  if (!text) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? text : null;
};

export const localDateTimeOn = (dateKey, clockValue = new Date()) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
  if (!match || Number.isNaN(clock.getTime())) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds());
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const currentDate = now => {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const validManualDateTime = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ""));
  if (!match) return true;
  const parsed = new Date(value);
  const expected = match.slice(1).map((part, index) => index === 5 && part == null ? 0 : Number(part));
  const actual = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(), parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()];
  return !Number.isNaN(parsed.getTime()) && expected.every((part, index) => part === actual[index]);
};

export const eventTimeFields = (input = {}, existing = null, { now = () => new Date() } = {}) => {
  const hasOwn = key => Object.prototype.hasOwnProperty.call(input || {}, key);
  const timeMode = hasOwn("timeMode") ? safeText(input.timeMode, 20) : "";
  if (timeMode && !["now", "manual"].includes(timeMode)) return null;
  if (timeMode === "now") {
    const date = currentDate(now);
    if (!date) return null;
    const occurredAt = date.toISOString();
    return { occurredAt, occurredOn: localDateKey(date) };
  }
  if (timeMode === "manual" && !hasOwn("occurredAt") && !hasOwn("occurredOn")) return null;
  let occurredAt = "";
  if (hasOwn("occurredAt")) {
    if (timeMode === "manual" && !validManualDateTime(input.occurredAt)) return null;
    const parsed = new Date(String(input.occurredAt || ""));
    if (Number.isNaN(parsed.getTime())) return null;
    occurredAt = parsed.toISOString();
  } else if (hasOwn("occurredOn")) {
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || "") ? input.occurredOn : "";
    if (!dateKey) return null;
    const clock = existing?.occurredAt || currentDate(now);
    if (!clock) return null;
    occurredAt = localDateTimeOn(dateKey, clock);
  } else if (existing?.occurredAt) {
    const parsed = new Date(existing.occurredAt);
    if (!Number.isNaN(parsed.getTime())) occurredAt = parsed.toISOString();
  } else {
    const date = currentDate(now);
    if (!date) return null;
    occurredAt = date.toISOString();
  }
  return occurredAt ? { occurredAt, occurredOn: localDateKey(occurredAt) } : null;
};
