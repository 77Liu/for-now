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
const PRIORITY_LEVEL = new Map([
  ["0", "emergency"], ["1", "alert"], ["2", "critical"], ["3", "error"],
  ["4", "warning"], ["5", "notice"], ["6", "info"], ["7", "debug"]
]);

function safeField(value) {
  return typeof value === "string" && SAFE_FIELD.test(value) ? value : "";
}

function parseMessage(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function timestampFromJournal(value) {
  const micros = Number(value);
  return Number.isSafeInteger(micros) && micros > 0
    ? new Date(Math.floor(micros / 1000)).toISOString()
    : "";
}

function summarizeJournalRecord(record, sinceMs, untilMs) {
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
  const error = event.error && typeof event.error === "object" ? event.error : {};
  const status = Number(event.statusCode || event.httpStatus);
  const duration = Number(event.durationMs);
  const summary = {
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

/** 只查询固定中台 unit，并将 journal 内容投影成不含原始消息的白名单摘要。 */
export function summarizePlatformJournal(text, { now = Date.now(), lookbackMs = LOOKBACK_MS } = {}) {
  const sinceMs = now - lookbackMs;
  const entries = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    try {
      const summary = summarizeJournalRecord(JSON.parse(line), sinceMs, now);
      if (summary) entries.push(summary);
    } catch {}
  }
  return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-MAX_ENTRIES);
}

/** 以 root 读取固定 unit 的 journal，但只落盘脱敏后的 10 分钟快照。 */
export async function collectPlatformJournalContext({
  now = () => Date.now(),
  outputFile = OUTPUT_FILE,
  queryJournal = async args => execFile("/usr/bin/journalctl", args, {
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 512 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  })
} = {}) {
  const endedAt = now();
  const since = new Date(endedAt - LOOKBACK_MS).toISOString();
  const until = new Date(endedAt).toISOString();
  let snapshot;
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
    snapshot = {
      schemaVersion: 1,
      available: false,
      generatedAt: new Date(endedAt).toISOString(),
      errorCode: /^[A-Z0-9_]{1,80}$/.test(error?.code || "") ? error.code : "JOURNAL_QUERY_FAILED",
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
