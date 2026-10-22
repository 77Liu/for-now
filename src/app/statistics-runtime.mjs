import { promises as fs } from "node:fs";
import path from "node:path";
import { createStatisticsService } from "../modules/statistics/index.mjs";

export async function readOperationEntries(logsDir, from, to) {
  let names = [];
  try {
    names = await fs.readdir(logsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const files = names.filter(name => {
    const match = /^operation-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    return match && match[1] >= from && match[1] <= to;
  });
  const entries = [];
  for (const name of files) {
    const text = await fs.readFile(path.join(logsDir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.event === "request.completed" && item.result === "success") entries.push(item);
      } catch {}
    }
  }
  return entries;
}

export function createStatisticsRuntime({
  repository,
  ensureAiUsage,
  readAiUsage,
  logsDirectory,
  aiDashboard,
  today,
  getTimezone
}) {
  if (typeof logsDirectory !== "function") {
    throw new TypeError("Statistics runtime requires logsDirectory()");
  }
  return {
    statisticsService: createStatisticsService({
      repository,
      ensureAiUsage,
      readAiUsage,
      readOperationEntries: (from, to) => readOperationEntries(logsDirectory(), from, to),
      aiDashboard,
      today,
      getTimezone
    })
  };
}
