#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LOOKBACK_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10;
const JOURNAL_LINES = 200;
const JOURNAL_UNIT = "for-now-platform.service";
const OUTPUT_DIR = "/var/lib/for-now-monitor-journal";
const OUTPUT_FILE = `${OUTPUT_DIR}/platform-context.json`;
const SAFE_FIELD = /^[A-Za-z0-9_.:-]{1,80}$/;
type JournalRecord = Record<string, unknown>;
type JournalEvent = Record<string, unknown>;
type JournalSummary = {
  timestamp: string;
  source: "platform-journal";
  event: string;
  module: string;
  level?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  error?: string;
};
type JournalSnapshot = {
  schemaVersion: 1;
  available: boolean;
  generatedAt: string;
  entries: JournalSummary[];
  errorCode?: string;
};
type JournalQuery = (args: string[]) => Promise<{ stdout: string }>;
const PRIORITY_LEVEL = new Map([
  ["0", "emergency"], ["1", "alert"], ["2", "critical"], ["3", "error"],
  ["4", "warning"], ["5", "notice"], ["6", "info"], ["7", "debug"]
]);

function safeField(value: unknown): string {
  return typeof value === "string" && SAFE_FIELD.test(value) ? value : "";
}

function parseMessage(value: unknown): JournalEvent {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JournalEvent
      : {};
  } catch {
    return {};
  }
}

function timestampFromJournal(value: unknown): string {
  const micros = Number(value);
  return Number.isSafeInteger(micros) && micros > 0
    ? new Date(Math.floor(micros / 1000)).toISOString()
    : "";
}

function summarizeJournalRecord(record: JournalRecord, sinceMs: number, untilMs: number): JournalSummary | null {
  const timestamp = timestampFromJournal(record.__REALTIME_TIMESTAMP);
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || time < sinceMs || time > untilMs) return null;
  const event = parseMessage(record.MESSAGE);
  const message = typeof record.MESSAGE === "string" ? record.MESSAGE : "";
  const systemdEvent = message.startsWith("Failed to start") || message.includes("Failed with result")
    ? "systemd.service.failed"
    : message.includes("Main process exited")
      ? "systemd.process.exited"
      : message.startsWith("Starting ")
        ? "systemd.service.starting"
        : message.startsWith("Started ")
          ? "systemd.service.started"
          : "";
  const error = event.error && typeof event.error === "object" && !Array.isArray(event.error)
    ? event.error as JournalEvent
    : {};
  const status = Number(event.statusCode || event.httpStatus);
  const duration = Number(event.durationMs);
  const summary: JournalSummary = {
    timestamp,
    source: "platform-journal",
    event: safeField(event.event) || systemdEvent || "journal.event",
    module: safeField(event.module) || "platform"
  };
  const level = safeField(event.level) || PRIORITY_LEVEL.get(String(record.PRIORITY || "")) || "";
  const errorCode = safeField(error.code || event.errorCode);
  const errorName = safeField(error.name);
  if (level) summary.level = level;
  if (Number.isFinite(status) && status > 0) summary.status = status;
  if (Number.isFinite(duration) && duration >= 0) summary.durationMs = Math.round(duration);
  if (errorCode) summary.errorCode = errorCode;
  if (errorName) summary.error = errorName;
  return summary;
}

/**
 * 只查询固定中台 unit，并将 journal 内容投影成不含原始消息的白名单摘要。
 * @param text journalctl 的 JSON 行输出。
 * @param options 参考时刻与查询窗口；默认只接受最近 10 分钟。
 */
export function summarizePlatformJournal(
  text: string,
  { now = Date.now(), lookbackMs = LOOKBACK_MS }: { now?: number; lookbackMs?: number } = {}
): JournalSummary[] {
  const sinceMs = now - lookbackMs;
  const entries = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    try {
      const summary = summarizeJournalRecord(JSON.parse(line) as JournalRecord, sinceMs, now);
      if (summary) entries.push(summary);
    } catch {}
  }
  return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-MAX_ENTRIES);
}

/**
 * 以 root 读取固定 unit 的 journal，但只落盘脱敏后的 10 分钟快照。
 * @param options 注入时钟、输出位置和固定命令的执行器，便于无 root 权限测试。
 */
export async function collectPlatformJournalContext({
  now = () => Date.now(),
  outputFile = OUTPUT_FILE,
  queryJournal = async (args: string[]) => execFile("/usr/bin/journalctl", args, {
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 512 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  })
}: {
  now?: () => number;
  outputFile?: string;
  queryJournal?: JournalQuery;
} = {}): Promise<JournalSnapshot> {
  const endedAt = now();
  const since = new Date(endedAt - LOOKBACK_MS).toISOString();
  const until = new Date(endedAt).toISOString();
  let snapshot: JournalSnapshot;
  try {
    const result = await queryJournal([
      `--unit=${JOURNAL_UNIT}`,
      `--since=${since}`,
      `--until=${until}`,
      `--lines=${JOURNAL_LINES}`,
      "--output=json",
      "--no-pager"
    ]);
    snapshot = {
      schemaVersion: 1,
      available: true,
      generatedAt: new Date(endedAt).toISOString(),
      entries: summarizePlatformJournal(result.stdout, { now: endedAt })
    };
  } catch (error) {
    const candidateCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
    snapshot = {
      schemaVersion: 1,
      available: false,
      generatedAt: new Date(endedAt).toISOString(),
      errorCode: typeof candidateCode === "string" && /^[A-Z0-9_]{1,80}$/.test(candidateCode)
        ? candidateCode
        : "JOURNAL_QUERY_FAILED",
      entries: []
    };
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true, mode: 0o750 });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o640 });
    await fs.chmod(temporary, 0o640);
    await fs.rename(temporary, outputFile);
    await fs.chmod(outputFile, 0o640);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return snapshot;
}

if (process.argv[1] && process.argv[1].endsWith("monitor-journal-context.mjs")) {
  collectPlatformJournalContext()
    .then(snapshot => process.stdout.write(`${JSON.stringify({ available: snapshot.available, entries: snapshot.entries.length })}\n`))
    .catch(() => { process.exitCode = 1; });
}
