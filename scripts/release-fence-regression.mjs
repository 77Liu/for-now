import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
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
  const concurrent = await Promise.allSettled([
    fence.issue(approval(timeoutRollback.attemptId)), fence.issue(approval(timeoutRollback.attemptId))
  ]);
  assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
  await fs.chmod(path.join(directory, "production.json"), 0o644);
  await rejected(fence.read("production"));
  console.log("Release fence checks passed: decision CAS, unique generations, single worker, stale same-SHA rejection, rollback invalidation, revoked/expired attempts, observation binding, isolated targets and private state. No remote actions.");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
