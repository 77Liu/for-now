/**
 * 保守日期索引与正式领域日期解析的边界对照。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：索引只排除已证明不相关日期；不替代领域日期和时区规则。
 */
import assert from "node:assert/strict";
import path from "node:path";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";

/** 每个领域接受的日期都必须命中 hints 或保守通配符。 @since unreleased */
export async function runThoughtCalendarBoundariesPostgresChecks(database: QueryClient) {
  const { sourceLocalDates } = await import(path.resolve("src/app/record-compression-context.mjs"));
  const values = [
    "2026-10-18T00:00:00Z",
    "2026-10-18T23:59:59-1200",
    "2026-10-18T00:00:00+14:00",
    " \t2026-10-18T00:00:00Z\n",
    "\u00a02026-10-18T00:00:00Z\u3000",
    "2026-02-30T00:00:00Z",
    "2026-10-18T24:00:00Z",
    "October 18, 2026 00:00:00 +0000",
    "2026/10/18 00:00:00 +0000",
    "2026-10-18",
    "invalidZ",
    "",
    "2026-10-18T00:00:00",
    "2026-10-18T00:00:00+99:00"
  ];
  let accepted = 0;
  for (const occurredAt of values) {
    const document = { id: "boundary", content: "日期边界", occurredAt, version: 1 };
    const result = await database.query<{ hints: string[] }>(
      "SELECT for_now.source_calendar_hints($1::jsonb) AS hints",
      [JSON.stringify(document)]
    );
    const hints = result.rows[0].hints;
    for (const timezone of ["Asia/Shanghai", "America/New_York", "Pacific/Honolulu", "Pacific/Kiritimati"]) {
      const dates: string[] = sourceLocalDates(
        { captures: [document] }, timezone, "2027-01-01T00:00:00Z"
      );
      for (const date of dates) {
        accepted++;
        assert.ok(hints.includes(date) || hints.includes("*"),
          `domain date omitted from candidate index: ${JSON.stringify(occurredAt)} ${timezone}`);
      }
    }
  }
  for (const occurredOn of ["2026-10-18", "2026-02-30", "invalid"]) {
    const document = { id: "date-only", content: "日期", occurredOn, eventTimePrecision: "date" };
    const result = await database.query<{ hints: string[] }>(
      "SELECT for_now.source_calendar_hints($1::jsonb) AS hints",
      [JSON.stringify(document)]
    );
    const dates: string[] = sourceLocalDates(
      { captures: [document] }, "Asia/Shanghai", "2027-01-01T00:00:00Z"
    );
    for (const date of dates) {
      assert.ok(result.rows[0].hints.includes(date) || result.rows[0].hints.includes("*"));
    }
  }
  console.log("THOUGHT_CALENDAR_BOUNDARIES " + JSON.stringify({
    candidates: values.length + 3, acceptedInstantDates: accepted,
    checks: ["timezone offsets", "ASCII/Unicode trim", "rollover", "non-ISO fallback",
      "invalid instant", "date-only"]
  }));
}
