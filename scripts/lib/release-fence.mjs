import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const sha = value => /^[a-f0-9]{40}$/.test(value || "");
const id = value => /^[a-f0-9]{32}$/.test(value || "");
const fail = message => Object.assign(new Error(message), { code: "RELEASE_FENCE_REJECTED" });
export function createReleaseFence({ directory, now = () => Date.now() }) {
  assert.ok(path.isAbsolute(directory));
  const file = target => {
    if (!["production", "preview"].includes(target)) throw fail("Unknown release target");
    return path.join(directory, `${target}.json`);
  };
  const execution = target => `${file(target)}.execution`;
  const privateJson = async name => {
    const stat = await fs.lstat(name);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw fail("Fence file must be an owned private regular file");
    return JSON.parse(await fs.readFile(name, "utf8"));
  };
  const read = async target => {
    const value = await privateJson(file(target));
    if (value.schemaVersion !== 1 || value.target !== target || !id(value.attemptId)
      || !sha(value.candidateSha) || !sha(value.baselineSha) || !sha(value.rollbackSha)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !Number.isSafeInteger(value.expiresAt) || !["deploy", "rollback"].includes(value.action)
      || !["approved", "executing", "complete", "invalidated"].includes(value.phase)) throw fail("Invalid fence state");
    return value;
  };
  const write = async (name, value) => {
    const temporary = `${name}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, name);
    } finally { await fs.rm(temporary, { force: true }); }
  };
  const serialize = async (target, operation) => {
    file(target); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077)) throw fail("Fence directory must be private and owned");
    const lock = `${file(target)}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) { if (error.code !== "EEXIST") throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!acquired) throw fail("Fence writer is busy; locks are never automatically stolen");
    try { return await operation(); } finally { await fs.rmdir(lock); }
  };
  const prior = async target => { try { return await read(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const cas = (value, expected) => { if ((value?.attemptId || null) !== (expected || null)) throw fail("Release decision changed"); };
  const validate = (value, options, phase = "executing", allowExpired = false) => {
    if (value.attemptId !== options.attemptId || value.candidateSha !== options.candidateSha
      || value.action !== options.action || value.phase !== phase || (!allowExpired && value.expiresAt <= now())) throw fail("Stale, consumed, expired or mismatched release attempt");
    if (!sha(options.actualSha) || ![value.baselineSha, value.candidateSha].includes(options.actualSha)) throw fail("Active release changed outside this attempt");
    if (phase === "executing" && value.pid !== options.pid) throw fail("Release attempt belongs to another process");
    return value;
  };
  const receipt = async (target, value) => {
    const lock = await privateJson(path.join(execution(target), "owner.json"));
    if (lock.attemptId !== value.attemptId || lock.pid !== value.pid) throw fail("Execution ownership changed");
  };
  const clearExecution = async (target, attemptId, pid) => {
    let lock; try { lock = await privateJson(path.join(execution(target), "owner.json")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (lock.attemptId !== attemptId || lock.pid !== pid) throw fail("Cannot release another process's execution lock");
    await fs.unlink(path.join(execution(target), "owner.json")); await fs.rmdir(execution(target));
  };
  return Object.freeze({ read,
    issue: options => serialize(options.target, async () => {
      const value = await prior(options.target); cas(value, options.expectedAttemptId);
      if (!sha(options.candidateSha) || !sha(options.baselineSha) || !["deploy", "rollback"].includes(options.action)
        || !Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 60 || options.ttlSeconds > 3600) throw fail("Invalid release approval");
      const next = { schemaVersion: 1, target: options.target, attemptId: crypto.randomBytes(16).toString("hex"),
        generation: (value?.generation || 0) + 1, supersedes: value?.attemptId || null,
        candidateSha: options.candidateSha, baselineSha: options.baselineSha, rollbackSha: options.baselineSha,
        action: options.action, phase: "approved", approvedAt: now(), expiresAt: now() + options.ttlSeconds * 1000 };
      await write(file(options.target), next); return next;
    }),
    invalidate: options => serialize(options.target, async () => {
      const value = await read(options.target); cas(value, options.expectedAttemptId);
      const next = { ...value, attemptId: crypto.randomBytes(16).toString("hex"), generation: value.generation + 1,
        supersedes: value.attemptId, phase: "invalidated", invalidatedAt: now() };
      await write(file(options.target), next); return next;
    }),
    claim: options => serialize(options.target, async () => {
      const value = validate(await read(options.target), options, "approved");
      if (options.actualSha !== value.baselineSha || !Number.isSafeInteger(options.pid) || options.pid < 1) throw fail("Invalid deployment baseline or worker PID");
      try { await fs.mkdir(execution(options.target), { mode: 0o700 }); }
      catch (error) { if (error.code === "EEXIST") throw fail("Another deployment owns this target"); throw error; }
      try {
        await write(path.join(execution(options.target), "owner.json"), { attemptId: value.attemptId, pid: options.pid });
        const next = { ...value, phase: "executing", pid: options.pid, startedAt: now() };
        await write(file(options.target), next); return next;
      } catch (error) { await clearExecution(options.target, value.attemptId, options.pid); throw error; }
    }),
    verify: async options => {
      const value = validate(await read(options.target), options, options.observe ? "complete" : "executing");
      if (!options.observe) await receipt(options.target, value);
      else if (options.actualSha !== value.candidateSha) throw fail("Observation is not for the active candidate");
      return value;
    },
    rollback: options => serialize(options.target, async () => {
      const value = validate(await read(options.target), options, "executing", true); await receipt(options.target, value);
      const next = { ...value, attemptId: crypto.randomBytes(16).toString("hex"), generation: value.generation + 1,
        supersedes: value.attemptId, candidateSha: value.rollbackSha, baselineSha: options.actualSha,
        action: "rollback", phase: "executing", startedAt: now(), expiresAt: now() + 3600000 };
      await write(path.join(execution(options.target), "owner.json"), { attemptId: next.attemptId, pid: next.pid });
      await write(file(options.target), next); return next;
    }),
    complete: options => serialize(options.target, async () => {
      const value = validate(await read(options.target), options); await receipt(options.target, value);
      if (options.actualSha !== value.candidateSha) throw fail("Cannot complete before target activation");
      const next = { ...value, phase: "complete", completedAt: now() };
      await write(file(options.target), next); await clearExecution(options.target, value.attemptId, value.pid); return next;
    }),
    abandon: options => serialize(options.target, async () => {
      const value = await read(options.target);
      await clearExecution(options.target, options.attemptId, options.pid);
      if (value.attemptId === options.attemptId && value.phase === "executing") {
        const next = { ...value, attemptId: crypto.randomBytes(16).toString("hex"), generation: value.generation + 1,
          supersedes: value.attemptId, phase: "invalidated", invalidatedAt: now() };
        await write(file(options.target), next);
      }
    })
  });
}
