import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cike-release-metadata-"));
const fixtureScript = path.join(tempRoot, "scripts", "sync-release-metadata.mjs");
const packagePath = path.join(tempRoot, "package.json");
const lockPath = path.join(tempRoot, "package-lock.json");

try {
  await fs.mkdir(path.dirname(fixtureScript), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "public"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "ios"), { recursive: true });
  await fs.copyFile(path.join(root, "scripts/sync-release-metadata.mjs"), fixtureScript);
  await fs.writeFile(packagePath, `${JSON.stringify({
    name: "release-metadata-fixture",
    version: "0.5.10+hotfix.1",
    release: { iosBuildNumber: 7 }
  }, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({
    name: "release-metadata-fixture",
    version: "0.5.10+hotfix.1",
    packages: {
      "": { name: "release-metadata-fixture", version: "0.5.10+hotfix.1" }
    }
  }, null, 2)}\n`);

  const run = (...args) => spawnSync(process.execPath, [fixtureScript, ...args], {
    encoding: "utf8"
  });
  const firstSet = run("--set", "0.5.11");
  assert.equal(firstSet.status, 0, firstSet.stderr);
  const changedPackage = JSON.parse(await fs.readFile(packagePath, "utf8"));
  const changedLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(changedPackage.version, "0.5.11");
  assert.equal(changedPackage.release.iosBuildNumber, 8);
  assert.equal(changedLock.version, "0.5.11");
  assert.equal(changedLock.packages[""].version, "0.5.11");
  assert.match(
    await fs.readFile(path.join(tempRoot, "ios/release-version.xcconfig"), "utf8"),
    /APP_MARKETING_VERSION = 0\.5\.11\nAPP_BUILD_NUMBER = 8\n/
  );

  const sameVersionSet = run("--set", "0.5.11");
  assert.equal(sameVersionSet.status, 0, sameVersionSet.stderr);
  const repeatedPackage = JSON.parse(await fs.readFile(packagePath, "utf8"));
  assert.equal(repeatedPackage.release.iosBuildNumber, 8);

  const packageBeforeInvalidSet = await fs.readFile(packagePath, "utf8");
  const lockBeforeInvalidSet = await fs.readFile(lockPath, "utf8");
  const invalidSet = run("--set", "0.5.12-01");
  assert.notEqual(invalidSet.status, 0);
  assert.match(invalidSet.stderr, /无效的 package\.json version/);
  assert.equal(await fs.readFile(packagePath, "utf8"), packageBeforeInvalidSet);
  assert.equal(await fs.readFile(lockPath, "utf8"), lockBeforeInvalidSet);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("Release metadata checks passed: version change bumps iOS build once, repeated set is stable, and invalid SemVer writes nothing.");
