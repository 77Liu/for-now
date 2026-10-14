/**
 * 上海增量日压缩窗口与日期精度归属。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：只读发生时间决定槽；创建/更新时间仅由调用方用于来源修订，不参与归属。
 */
export const RECORD_SLOT_SCHEMA_VERSION = "record-compression-window.v2";
export const RECORD_SLOT_INPUT_SCHEMA_VERSION = "record-compression-input.v2";
export const RECORD_SLOT_OUTPUT_SCHEMA_VERSION = "record-compression-output.v2";
export const RECORD_SLOT_DAY_VIEW_SCHEMA_VERSION = "record-compression-day-view.v2";
export const RECORD_SLOT_START_DATE = "2026-09-25";
export type RecordSlot = "morning" | "evening";

/** 以结束日期命名的上海半开窗口；旧全天记录不使用此身份。 @since unreleased */
export interface RecordCompressionWindow {
  schemaVersion: typeof RECORD_SLOT_SCHEMA_VERSION;
  windowKey: string;
  localDate: string;
  timezone: "Asia/Shanghai";
  slot: RecordSlot;
  start: string;
  endExclusive: string;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function shiftDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
function shanghaiDate(instant: number): string {
  return new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 创建前日18:05→当日06:00或当日06:00→18:05窗口，边界不含结束点。 @since unreleased */
export function recordCompressionWindow(localDate: string, slot: RecordSlot): RecordCompressionWindow {
  if (!validDate(localDate) || !["morning", "evening"].includes(slot)) throw new TypeError("压缩窗口日期或槽无效");
  const startDate = slot === "morning" ? shiftDate(localDate, -1) : localDate;
  return {
    schemaVersion: RECORD_SLOT_SCHEMA_VERSION,
    windowKey: `${RECORD_SLOT_SCHEMA_VERSION}:${localDate}:${slot}`,
    localDate, timezone: "Asia/Shanghai", slot,
    start: new Date(`${startDate}T${slot === "morning" ? "18:05" : "06:00"}:00+08:00`).toISOString(),
    endExclusive: new Date(`${localDate}T${slot === "morning" ? "06:00" : "18:05"}:00+08:00`).toISOString()
  };
}

/** 从合法 windowKey 还原唯一窗口；不按旧 localDate 猜测槽。 @since unreleased */
export function recordCompressionWindowFromKey(value: unknown): RecordCompressionWindow | null {
  if (typeof value !== "string") return null;
  const match = /^record-compression-window\.v2:(\d{4}-\d{2}-\d{2}):(morning|evening)$/.exec(value);
  if (!match || !validDate(match[1])) return null;
  return recordCompressionWindow(match[1], match[2] as RecordSlot);
}

/** 可靠发生时刻按半开边界归槽；仅日期归当日傍晚槽且不制造发生时刻。 @since unreleased */
export function recordOccurrenceWindow(record: {
  occurredAt?: unknown; occurredOn?: unknown; eventTimePrecision?: unknown;
}): { window: RecordCompressionWindow; precision: "instant" | "date"; occurredAt: string; occurredOn: string } | null {
  if (record.eventTimePrecision === "unknown") return null;
  const at = typeof record.occurredAt === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(record.occurredAt)
    ? Date.parse(record.occurredAt) : NaN;
  const dateOnly = ["date", "day", "date_only"].includes(String(record.eventTimePrecision || ""));
  if (Number.isFinite(at) && !dateOnly) {
    const date = shanghaiDate(at);
    const morning = recordCompressionWindow(date, "morning"), evening = recordCompressionWindow(date, "evening");
    const window = at < Date.parse(morning.endExclusive) ? morning
      : at < Date.parse(evening.endExclusive) ? evening : recordCompressionWindow(shiftDate(date, 1), "morning");
    return { window, precision: "instant", occurredAt: new Date(at).toISOString(), occurredOn: date };
  }
  if (typeof record.occurredOn === "string" && validDate(record.occurredOn)) {
    return { window: recordCompressionWindow(record.occurredOn, "evening"), precision: "date", occurredAt: "", occurredOn: record.occurredOn };
  }
  return null;
}

/** 返回截至 asOf 已闭合的槽，按新到旧排列；起点后的晚到记录仍修订原槽。 @since unreleased */
export function closedRecordCompressionWindows(asOf: string, startDate: string): RecordCompressionWindow[] {
  const instant = Date.parse(asOf);
  if (!Number.isFinite(instant) || !validDate(startDate)) throw new TypeError("压缩扫描时间或起点无效");
  const result: RecordCompressionWindow[] = [];
  for (let date = shanghaiDate(instant); date >= startDate; date = shiftDate(date, -1)) {
    for (const slot of ["evening", "morning"] as const) {
      const window = recordCompressionWindow(date, slot);
      if (Date.parse(window.endExclusive) <= instant) result.push(window);
    }
  }
  return result;
}
