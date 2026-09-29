const pad = number => String(number).padStart(2, "0");

export const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const formatDate = iso => new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
}).format(new Date(iso));

export const formatTime = iso => new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
}).format(new Date(iso));

export const formatDateKey = value => {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return year && month && day ? `${year}年${month}月${day}日` : "";
};

export const toLocalDateTimeInput = iso => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const localDateTimeForDate = (dateKey, value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return `${dateKey}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const eventTimestamp = item => item?.occurredAt || item?.createdAt;

export const persistedDateTimeInput = item => {
  const value = item?.occurredAt || item?.createdAt;
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return toLocalDateTimeInput(value);
};

export const eventDate = item => item?.occurredOn || localDateKey(eventTimestamp(item));

const validDate = value => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const manualDateTime = value => {
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const date = match ? validDate(text) : null;
  if (!date) return "";
  const expected = match.slice(1).map((part, index) => index === 5 && part == null ? 0 : Number(part));
  const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  if (expected.some((part, index) => part !== actual[index])) return "";
  return match[6] == null ? `${text}:00` : text;
};

export function createOccurrenceDraft({ selectedDate = "", existing = null, now = new Date() } = {}) {
  const existingValue = persistedDateTimeInput(existing);
  if (existingValue) return { mode: "manual", manualValue: existingValue };
  const date = validDate(now);
  if (!date) throw new TypeError("当前时间无效");
  const dateKey = localDateKey(date);
  if (selectedDate && selectedDate !== dateKey) {
    return { mode: "manual", manualValue: localDateTimeForDate(selectedDate, date) };
  }
  return { mode: "now", manualValue: toLocalDateTimeInput(date) };
}

export function occurrenceSubmission(draft = {}, { now = new Date() } = {}) {
  if (draft.mode === "now") {
    const date = validDate(now);
    if (!date) throw new TypeError("当前时间无效");
    return { timeMode: "now" };
  }
  if (draft.mode === "manual") {
    const occurredAt = manualDateTime(draft.manualValue);
    if (!occurredAt) throw new TypeError("请手动指定发生时间");
    return { timeMode: "manual", occurredAt };
  }
  throw new TypeError("请选择现在或手动指定发生时间");
}

export function entryKeyIntent(event = {}, { inputKind = "field" } = {}) {
  if (event.isComposing || event.keyCode === 229) return "none";
  if (inputKind === "tag" && ["Enter", ",", "，"].includes(event.key)) return "commit-tag";
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) return "submit";
  if (event.key !== "Enter") return "none";
  return inputKind === "multiline" ? "newline" : "block-submit";
}
