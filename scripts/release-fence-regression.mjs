import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as syncFs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createReleaseFence } from "./lib/release-fence.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-fence-regression-"));
let time = 1000000;
const fence = createReleaseFence({ directory, now: () => time });
const baseline = "a".repeat(40), candidate = "b".repeat(40), different = "c".repeat(40);
const approval = (expectedAttemptId, overrides = {}) => ({ target: "production", action: "deploy", baselineSha: baseline,
  candidateSha: candidate, ttlSeconds: 60, expectedAttemptId, ...overrides });
const worker = state => ({ target: state.target, action: state.action, attemptId: state.attemptId,
  candidateSha: state.candidateSha, actualSha: state.baselineSha, pid: process.pid });
const rejected = operation => assert.rejects(operation, { code: "RELEASE_FENCE_REJECTED" });
const waitFor = async condition => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fence test barrier timed out");
};
const syncWaitFor = condition => {
  const until = Date.now() + 5000, signal = new Int32Array(new SharedArrayBuffer(4));
  while (!condition()) {
    assert.ok(Date.now() < until, "Fence synchronous test barrier timed out");
    Atomics.wait(signal, 0, 0, 10);
  }
};
try {
  const first = await fence.issue(approval(null));
  assert.equal((await fs.stat(path.join(directory, "production.json"))).mode & 0o777, 0o600);
  await rejected(fence.issue(approval(null)));
  await rejected(fence.claim({ ...worker(first), actualSha: different }));
  await rejected(fence.claim({ ...worker(first), action: "rollback" }));
  const claims = await Promise.allSettled([fence.claim(worker(first)), fence.claim(worker(first))]);
  assert.equal(claims.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(claims.filter(row => row.status === "rejected").length, 1);
  await fence.verify(worker(first));
  await rejected(fence.verify({ ...worker(first), pid: process.pid + 1 }));
  await rejected(fence.complete(worker(first)));
  const rollback = await fence.rollback({ ...worker(first), actualSha: candidate });
  assert.notEqual(rollback.attemptId, first.attemptId); assert.equal(rollback.candidateSha, baseline);
  await rejected(fence.verify(worker(first)));
  await rejected(fence.claim(worker(first)));
  await fence.verify(worker(rollback));
  await fence.complete({ ...worker(rollback), actualSha: baseline });
  await rejected(fence.verify(worker(rollback)));
  await fence.verify({ ...worker(rollback), actualSha: baseline, observe: true });
  // The same failed SHA needs a new decision and cannot be revived by an old command.
  const second = await fence.issue(approval(rollback.attemptId));
  await rejected(fence.claim(worker(first)));
  await fence.claim(worker(second));
  const invalidated = await fence.invalidate({ target: "production", expectedAttemptId: second.attemptId });
  await rejected(fence.verify(worker(second)));
  await rejected(fence.rollback(worker(second)));
  await rejected(fence.verify({ ...worker(rollback), actualSha: baseline, observe: true }));
  const third = await fence.issue(approval(invalidated.attemptId));
  await rejected(fence.claim(worker(third))); // Superseding a decision never steals an execution lock.
  await fence.abandon(worker(second));
  await fence.claim(worker(third));
  time += 61000;
  await rejected(fence.verify(worker(third)));
  // An expired attempt can recover only its preauthorized rollback target.
  const timeoutRollback = await fence.rollback(worker(third));
  await fence.complete({ ...worker(timeoutRollback), actualSha: baseline });
  const preview = await fence.issue(approval(null, { target: "preview" }));
  await fence.claim(worker(preview));
  await fence.verify(worker(preview));
  await rejected(fence.verify({ ...worker(preview), target: "production" }));
  await fence.abandon(worker(preview));
  await rejected(fence.claim(worker(preview)));
  const effects = await fence.issue(approval(timeoutRollback.attemptId));
  await fence.claim(worker(effects));
  const effectEnv = path.join(directory, "effect.env"), effectProfile = path.join(directory, "effect.profile");
  await fs.writeFile(effectEnv, "old-env", { mode: 0o600 });
  await fs.writeFile(effectProfile, "old-profile", { mode: 0o600 });
  const originalDecision = await fence.read("production");
  assert.equal(await fence.effect(worker(effects), () => {
    syncFs.writeFileSync(effectEnv, "authorized-env");
    syncFs.writeFileSync(effectProfile, "authorized-profile");
    return "committed";
  }), "committed");
  assert.deepEqual(await fence.read("production"), originalDecision); // No new claim/nonce or consumed approval.
  assert.equal((await fs.readFile(effectEnv, "utf8")), "authorized-env");
  assert.equal((await fs.readFile(effectProfile, "utf8")), "authorized-profile");
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls += 1; };
  await rejected(fence.effect({ ...worker(effects), pid: process.pid + 1 }, forbidden));
  await rejected(fence.effect({ ...worker(effects), actualSha: different }, forbidden));
  await rejected(fence.effect({ ...worker(effects), candidateSha: different }, forbidden));
  await rejected(fence.effect({ ...worker(effects), action: "rollback" }, forbidden));
  time += 61000;
  await rejected(fence.effect(worker(effects), forbidden));
  time -= 61000;
  const ownerPath = path.join(directory, "production.json.execution/owner.json");
  const owner = await fs.readFile(ownerPath, "utf8");
  await fs.writeFile(ownerPath, JSON.stringify({ attemptId: effects.attemptId, pid: process.pid + 1 }));
  await rejected(fence.effect(worker(effects), forbidden));
  await fs.writeFile(ownerPath, owner);
  assert.equal(forbiddenCalls, 0);
  await assert.rejects(fence.effect(worker(effects), () => { throw new Error("effect-failed"); }), /effect-failed/);
  assert.equal(syncFs.existsSync(path.join(directory, "production.json.lock")), false);
  await fence.effect(worker(effects), () => { syncFs.writeFileSync(effectEnv, "after-error"); });
  const beforeRevocation = await fs.readFile(effectEnv, "utf8");
  const effectRevoked = await fence.invalidate({ target: "production", expectedAttemptId: effects.attemptId });
  await rejected(fence.effect(worker(effects), () => { syncFs.writeFileSync(effectEnv, "stale-import-result"); }));
  assert.equal(await fs.readFile(effectEnv, "utf8"), beforeRevocation);
  await rejected(fence.rollback(worker(effects))); // Old helper failure cannot authorize stale rollback.
  const effectFresh = await fence.issue(approval(effectRevoked.attemptId)); // Same candidate SHA, new decision.
  await rejected(fence.effect(worker(effects), forbidden));
  await rejected(fence.claim(worker(effectFresh))); // No stealing old execution receipt.
  await fence.abandon(worker(effects));
  await fence.claim(worker(effectFresh));
  await fence.effect(worker(effectFresh), () => { syncFs.writeFileSync(effectEnv, "fresh-same-sha"); });
  assert.equal(await fs.readFile(effectEnv, "utf8"), "fresh-same-sha");
  await rejected(fence.effect(worker(effectFresh), async () => { forbiddenCalls += 1; }));
  assert.equal(forbiddenCalls, 0); // Declared async callback rejected before invocation.
  await rejected(fence.effect(worker(effectFresh), () => ({ then(resolve) {
    assert.equal(syncFs.existsSync(path.join(directory, "production.json.lock")), true);
    resolve();
  } })));
  assert.equal(syncFs.existsSync(path.join(directory, "production.json.lock")), false);
  await fence.effect(worker(effectFresh), () => "still-authorized");
  // A separate real Node process requests invalidation while the parent holds the decision lock.
  const wanted = path.join(directory, "invalidate-wanted"), done = path.join(directory, "invalidate-done");
  const callbackEnd = path.join(directory, "effect-callback-end"), childGo = path.join(directory, "child-go");
  const stagedEnv = path.join(directory, "staged.env"), stagedProfile = path.join(directory, "staged.profile");
  await fs.writeFile(stagedEnv, "env-in-atomic-effect", { mode: 0o600 });
  await fs.writeFile(stagedProfile, "profile-in-same-effect", { mode: 0o600 });
  const childSource = `
    import { promises as fs } from "node:fs";
    import { createReleaseFence } from ${JSON.stringify(new URL("./lib/release-fence.mjs", import.meta.url).href)};
    const [directory, attemptId, go, wanted, done, callbackEnd] = process.argv.slice(1);
    while (true) { try { await fs.access(go); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    const mkdir = fs.mkdir.bind(fs);
    fs.mkdir = async (...args) => {
      try { return await mkdir(...args); }
      catch (error) {
        if (args[0] === directory + "/production.json.lock" && error.code === "EEXIST")
          await fs.writeFile(wanted, "real-decision-lock-contention");
        throw error;
      }
    };
    const fence = createReleaseFence({ directory });
    await fence.invalidate({ target: "production", expectedAttemptId: attemptId });
    await fs.access(callbackEnd);
    await fs.writeFile(done, "invalidated-after-effect");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource,
    directory, effectFresh.attemptId, childGo, wanted, done, callbackEnd], { stdio: "ignore" });
  const childExit = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    await fence.effect(worker(effectFresh), () => {
      syncFs.writeFileSync(childGo, "lock-held");
      syncWaitFor(() => syncFs.existsSync(wanted));
      assert.equal(syncFs.existsSync(path.join(directory, "production.json.lock")), true);
      assert.equal(syncFs.existsSync(done), false);
      syncFs.renameSync(stagedEnv, effectEnv);
      syncFs.renameSync(stagedProfile, effectProfile);
      const descriptor = syncFs.openSync(directory, "r");
      try { syncFs.fsyncSync(descriptor); } finally { syncFs.closeSync(descriptor); }
      syncFs.writeFileSync(callbackEnd, "both-effects-finished");
    });
    await waitFor(() => syncFs.existsSync(done));
    assert.deepEqual(await childExit, { code: 0, signal: null });
    assert.equal(await fs.readFile(effectEnv, "utf8"), "env-in-atomic-effect");
    assert.equal(await fs.readFile(effectProfile, "utf8"), "profile-in-same-effect");
    await rejected(fence.effect(worker(effectFresh), forbidden));
    assert.equal(forbiddenCalls, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; }
  }
  await fence.abandon(worker(effectFresh));
  const effectsLatest = await fence.read("production");
  const independentPreview = await fence.issue(approval((await fence.read("preview")).attemptId, { target: "preview" }));
  await fence.claim(worker(independentPreview));
  await fence.effect(worker(independentPreview), () => { syncFs.writeFileSync(effectProfile, "preview-effect"); });
  assert.deepEqual(await fence.read("production"), effectsLatest);
  await fence.abandon(worker(independentPreview));
  const concurrent = await Promise.allSettled([
    fence.issue(approval(effectsLatest.attemptId)), fence.issue(approval(effectsLatest.attemptId))
  ]);
  assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
  await fs.chmod(path.join(directory, "production.json"), 0o644);
  await rejected(fence.read("production"));
  console.log("Release fence checks passed: decision CAS, unique generations, single worker, stale same-SHA rejection, rollback invalidation, revoked/expired attempts, observation binding, isolated targets, private state and atomic effect versus real-process invalidation. No remote actions.");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
