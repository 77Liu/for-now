import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-media-transfer-"));
const log = path.join(dir, "calls.jsonl");
const git = (...args) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  await fs.mkdir(path.join(dir, "deploy"));
  await fs.mkdir(path.join(dir, ".secrets"), { mode: 0o700 });
  await fs.mkdir(path.join(dir, "bin"));
  await fs.writeFile(path.join(dir, ".secrets/for-now-deploy"), "SYNTHETIC_IDENTITY_NEVER_UPLOADED", { mode: 0o600 });
  for (const file of ["deploy.sh", "apply-media-config.mjs", "media-delivery.production.json", "deploy-with-media.sh"]) {
    await fs.copyFile(path.join(root, "deploy", file), path.join(dir, "deploy", file));
  }
  git("init", "-q"); git("add", "deploy"); git("commit", "--no-gpg-sign", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const shim = path.join(dir, "bin/shim.mjs");
  await fs.writeFile(shim, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
fs.appendFileSync(process.env.TRANSFER_LOG,JSON.stringify({name,args})+'\\n');
if(name==='ssh' && args.at(-1).includes('mktemp -d')) console.log('/root/for-now-media-stage.ABCDEFGH');
if(name==='scp' && process.env.TRANSFER_SCENARIO==='scp-failure') process.exit(1);
`, { mode: 0o755 });
  await fs.symlink(shim, path.join(dir, "bin/ssh"));
  await fs.symlink(shim, path.join(dir, "bin/scp"));
  const attempt = "1".repeat(32);
  const run = (scenario, branch = "release/v0.5.16") => spawnSync("/bin/bash", [path.join(dir, "deploy/deploy-with-media.sh"), commit, attempt, branch], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TRANSFER_LOG: log, TRANSFER_SCENARIO: scenario }
  });
  for (const branch of ["", "feat/not-a-release", "release/bad'ref", "release/../invalid"]) {
    assert.equal(run("invalid", branch).status, 1);
    assert.equal(await fs.access(log).then(() => true, () => false), false, "invalid candidate branch must stop before SSH");
  }
  assert.equal(run("success").status, 0);
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(c => c.name === "scp").length, 2);
  for (const call of calls) {
    assert.ok(call.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(call.args.includes("BatchMode=yes"));
    assert.ok(!call.args.join(" ").includes("SYNTHETIC_IDENTITY_NEVER_UPLOADED"));
  }
  const upload = calls.filter(c => c.name === "scp").flatMap(c => c.args);
  assert.ok(upload.some(s => s.endsWith("/media-delivery.production.json")));
  for (const call of calls.filter(c => c.name === "scp")) {
    const identity = path.join(dir, ".secrets/for-now-deploy");
    assert.equal(call.args.filter(arg => arg === identity).length, 1);
    assert.equal(call.args.indexOf(identity), call.args.indexOf("-i") + 1, "identity only appears as SSH -i argument");
  }
  const execution = calls.find(c => c.name === "ssh" && c.args.at(-1).includes("DEPLOY_EXPECTED_COMMIT="));
  assert.ok(execution.args.at(-1).includes(`DEPLOY_EXPECTED_COMMIT='${commit}'`));
  assert.ok(execution.args.at(-1).includes("DEPLOY_BRANCH='release/v0.5.16'"), "release branch must reach the installed deployer without main promotion");
  assert.match(execution.args.at(-1), /sha256sum -c SHA256SUMS && test/);
  assert.ok(execution.args.at(-1).includes(`RELEASE_ATTEMPT_ID='${attempt}'`));
  assert.ok(execution.args.at(-1).includes(`RELEASE_CANDIDATE_SHA='${commit}'`));
  assert.ok(execution.args.at(-1).endsWith("/usr/local/sbin/for-now-deploy"));
  assert.ok(!upload.some(s => s.endsWith("/deploy.sh")), "never upload a candidate deployer that could bypass the installed guard");
  assert.ok(calls.at(-1).args.at(-1).startsWith("rm -rf -- '/root/for-now-media-stage."));
  await fs.unlink(log);
  assert.equal(run("scp-failure").status, 1);
  const failed = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(!failed.some(c => c.args.at(-1).includes("DEPLOY_EXPECTED_COMMIT=")), "no deployment after failed transfer");
  assert.match(failed.at(-1).args.at(-1), /rm -rf/);
  await fs.unlink(log);
  await fs.appendFile(path.join(dir, "deploy/deploy.sh"), "\n# unreviewed change\n");
  assert.equal(run("dirty").status, 1);
  assert.equal(await fs.access(log).then(() => true, () => false), false, "unreviewed bootstrap rejected before SSH");
  console.log("Media transfer checks passed: reviewed file pinning, strict SSH, non-secret uploads, hash/commit guards, failed-transfer stop, and remote staging cleanup. SSH/SCP were mocked; no remote commands executed.");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
