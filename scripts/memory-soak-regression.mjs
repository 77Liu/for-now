import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["scripts/memory-soak.mjs"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "",
      MEMORY_SOAK_STATE_READS: "4",
      MEMORY_SOAK_ADMIN_SNAPSHOTS: "2",
      MEMORY_SOAK_ANALYSES: "2",
      MEMORY_SOAK_ATTACHMENTS: "1",
      MEMORY_SOAK_CONCURRENCY: "2",
      MEMORY_SOAK_SAMPLE_INTERVAL_MS: "50",
      MEMORY_SOAK_SETTLE_MS: "100",
      MEMORY_SOAK_IDLE_MS: "300"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("memory soak regression timed out"));
  }, 60_000);
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", code => {
    clearTimeout(timeout);
    resolve({ code, stdout, stderr });
  });
});

assert.equal(result.code, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);
assert.equal(report.schemaVersion, 1);
assert.equal(report.ok, true);
assert.deepEqual(Object.keys(report.phases), [
  "coldStart",
  "stateReads",
  "adminSnapshot",
  "analyses",
  "attachmentsSharp",
  "idleReclamation"
]);
for (const phase of Object.values(report.phases)) {
  assert.ok(phase.durationMs >= 0);
  assert.ok(phase.sampleCount >= 1);
  assert.ok(phase.after.rss > 0);
  assert.ok(phase.peak.rss >= phase.after.rss || phase.peak.rss > 0);
  assert.equal(typeof phase.delta.rss, "number");
}
assert.equal(report.provider.calls, 2);
assert.ok(report.provider.peakConcurrency >= 1);
assert.equal(report.phases.stateReads.operation.requests, 4);
assert.equal(report.phases.adminSnapshot.operation.requests, 2);
assert.equal(report.phases.analyses.operation.created, 2);
assert.equal(report.phases.attachmentsSharp.operation.ready, 1);
assert.equal(report.phases.idleReclamation.operation.idleMs, 300);
assert.equal(typeof report.summary.plateauCandidate, "boolean");
assert.doesNotMatch(result.stdout, /PRIVATE|MEMORY_SOAK_CAPTURE|\/Users\/|dataDir|apiKey/);
assert.equal(result.stderr, "");
console.log("Memory soak checks passed: isolated mock provider, six memory segments, Sharp derivatives, idle trend and machine JSON privacy.");
