/**
 * 验证有界脱敏评估快照计划，不执行数据库写入。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：只使用合成临时 JSON，不使用凭据、数据库或供应商调用。
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planEvaluationSnapshot } from "./restore-sanitized-evaluation-snapshot.mjs";

const fixtureModule = await import(pathToFileURL(
  path.resolve(process.cwd(), "scripts/fixtures/migration-bundle.mjs")
).href) as {
  writeMigrationBundleFixture(directory: string): Promise<{
    users: Array<{ id: string }>;
    sessions: unknown[];
  }>;
};

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "auth-evaluation-"));
try {
  const auth = await fixtureModule.writeMigrationBundleFixture(directory);
  const manifestFile = path.join(directory, "evaluation-manifest.json");
  const options = { snapshotDir: directory, manifestFile, maxAccounts: 2 };
  await fs.writeFile(manifestFile, JSON.stringify({
    schemaVersion: 1,
    sanitized: true,
    sourceVersion: "synthetic-v1",
    accountIds: auth.users.map(user => user.id)
  }));
  await assert.rejects(
    planEvaluationSnapshot(options, "bundle-a"),
    /must not contain production sessions/
  );
  const authFile = path.join(directory, "auth.json");
  await fs.writeFile(authFile, JSON.stringify({ ...auth, sessions: [] }));
  const planned = await planEvaluationSnapshot(options, "bundle-a");
  assert.deepEqual(planned.plan.accountIds, ["bundle-a", "bundle-b"]);
  assert.equal(planned.plan.accountCount, 2);
  assert.equal(planned.plan.sourceVersion, "synthetic-v1");
  assert.match(planned.plan.sourceSha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    planEvaluationSnapshot({ ...options, maxAccounts: 1 }, "bundle-a"),
    /exceeds or differs/
  );
  await assert.rejects(
    planEvaluationSnapshot(options, "missing"),
    /not present/
  );
  await fs.writeFile(manifestFile, JSON.stringify({
    schemaVersion: 1,
    sanitized: true,
    sourceVersion: "synthetic-v1",
    accountIds: ["bundle-a"]
  }));
  await assert.rejects(
    planEvaluationSnapshot(options, "bundle-a"),
    /exceeds or differs/
  );
  console.log("Auth evaluation snapshot checks passed: manifest identity, account bounds, session stripping, target mapping and source hashes.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
