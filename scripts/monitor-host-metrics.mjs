#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_INTERVAL_MS = 1000;
const HISTORY_SIZE = 30;
const METRICS_FILE = process.env.MONITOR_HOST_METRICS_FILE || "/var/lib/for-now-monitor/host-metrics.json";
const CPU_COUNT = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
let previousHostCpu = null;
let previousServices = new Map();

function parseCpuCounters(text) {
  const line = String(text).split("\n").find(value => value.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 8 || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  // Linux 的 guest/guest_nice 已计入 user/nice，不能再加入总量。
  return { total: values.slice(0, 8).reduce((sum, value) => sum + value, 0), idle: values[3] + (values[4] || 0) };
}

function cpuPercent(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (total - idle) / total * 100)) * 10) / 10;
}

function parseMemory(text) {
  const values = Object.fromEntries(String(text).split("\n").flatMap(line => {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line);
    return match ? [[match[1], Number(match[2]) * 1024]] : [];
  }));
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) return null;
  const used = Math.max(0, values.MemTotal - values.MemAvailable);
  return {
    memoryTotalBytes: values.MemTotal,
    memoryUsedBytes: used,
    memoryPercent: Math.round(used / values.MemTotal * 1000) / 10
  };
}

async function cgroupSample(unit, sampledAt) {
  const root = path.join("/sys/fs/cgroup/system.slice", unit);
  try {
    const [memoryText, cpuText] = await Promise.all([
      fs.readFile(path.join(root, "memory.current"), "utf8"),
      fs.readFile(path.join(root, "cpu.stat"), "utf8")
    ]);
    const memoryBytes = Number(memoryText.trim());
    const usageLine = cpuText.split("\n").find(line => line.startsWith("usage_usec "));
    const usageUsec = Number(usageLine?.split(/\s+/)[1]);
    if (!Number.isFinite(memoryBytes) || !Number.isFinite(usageUsec)) return null;
    const previous = previousServices.get(unit);
    previousServices.set(unit, { sampledAt, usageUsec });
    let cpu = null;
    if (previous) {
      const elapsedMs = sampledAt - previous.sampledAt;
      const usageDelta = usageUsec - previous.usageUsec;
      if (elapsedMs > 0 && elapsedMs <= 2500 && usageDelta >= 0) {
        const elapsedUsec = elapsedMs * 1000;
        cpu = Math.round(Math.min(100, Math.max(0, usageDelta / elapsedUsec / CPU_COUNT * 100)) * 10) / 10;
      }
    }
    return { cpuPercent: cpu, memoryBytes };
  } catch {
    return null;
  }
}

async function collectSample({ readFile = fs.readFile, now = () => Date.now() } = {}) {
  const sampledAt = now();
  const [cpuText, memoryText, loadText] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/loadavg", "utf8").catch(() => "")
  ]);
  const counters = parseCpuCounters(cpuText);
  const memory = parseMemory(memoryText);
  const load1 = Number(loadText.trim().split(/\s+/)[0]);
  const services = {};
  for (const unit of ["for-now.service", "for-now-platform.service"]) {
    const value = await cgroupSample(unit, sampledAt);
    if (value) services[unit] = value;
  }
  const result = {
    sampledAt: new Date(sampledAt).toISOString(),
    cpuPercent: cpuPercent(previousHostCpu, counters),
    ...(memory || {}),
    load1: Number.isFinite(load1) ? Math.round(load1 * 100) / 100 : null,
    services
  };
  previousHostCpu = counters;
  return result;
}

async function writeSample(sample, metricsFile = METRICS_FILE) {
  let previous = [];
  try {
    const state = JSON.parse(await fs.readFile(metricsFile, "utf8"));
    if (state.schemaVersion === 1 && Array.isArray(state.samples)) previous = state.samples;
  } catch {}
  const samples = [...previous, sample].slice(-HISTORY_SIZE);
  await fs.mkdir(path.dirname(metricsFile), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(metricsFile), 0o700);
  const temporary = `${metricsFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, intervalMs: SAMPLE_INTERVAL_MS, samples })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temporary, metricsFile);
    await fs.chmod(metricsFile, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

/** 主机采样只保留最近 30 秒的资源摘要，不记录进程参数或用户数据。 */
export async function sampleHostMetricsOnce({ metricsFile = METRICS_FILE, readFile = fs.readFile, now = () => Date.now() } = {}) {
  const sample = await collectSample({ readFile, now });
  await writeSample(sample, metricsFile);
  return sample;
}

async function runSampler() {
  let running = true;
  const stop = () => { running = false; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (running) {
    const startedAt = Date.now();
    try {
      await sampleHostMetricsOnce();
    } catch (error) {
      const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || "") ? error.code : "HOST_METRICS_SAMPLE_FAILED";
      process.stderr.write(`${JSON.stringify({ event: "host_metrics.sample_failed", code })}\n`);
    }
    if (running) await new Promise(resolve => setTimeout(resolve, Math.max(50, SAMPLE_INTERVAL_MS - (Date.now() - startedAt))));
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runSampler().catch(() => { process.exitCode = 1; });
}
