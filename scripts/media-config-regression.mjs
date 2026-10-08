import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { installReleaseFenceFixture, issueReleaseFenceFixture } from "./lib/release-fence-fixture.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-media-config-"));
const profile = path.join(dir, "profile.json"), env = path.join(dir, "env"), key = path.join(dir, "key");
const release = path.join(dir, "candidate");
const helper = path.join(dir, "apply-media-config.mjs");
const persistentProfile = path.join(dir, "persisted-profile.json");
const baseline = "1".repeat(40), candidate = "2".repeat(40);
const installed = await installReleaseFenceFixture(root, dir);
const approval = issueReleaseFenceFixture(installed, {target:"production",candidateSha:candidate,baselineSha:baseline});
await installed.fence.claim({target:"production",attemptId:approval.attemptId,candidateSha:candidate,actualSha:baseline,action:"deploy",pid:process.pid});
await fs.writeFile(helper, (await fs.readFile(path.join(root,"deploy/apply-media-config.mjs"),"utf8"))
  .replace("/usr/local/lib/for-now-release/lib/release-fence.mjs",path.join(dir,"usr/local/lib/for-now-release/lib/release-fence.mjs"))
  .replace("/var/lib/for-now-release",installed.directory)
  .replace("/etc/for-now-media-delivery.json",persistentProfile));
const applyArgs = ["--apply-fenced","production",approval.attemptId,candidate,baseline,String(process.pid)];
const approved = JSON.parse(await fs.readFile(path.join(root, "deploy/media-delivery.production.json"), "utf8"));
const secret = "FixtureOnlyKey123456789";
const original = "# preserve me\nATTACHMENT_STORAGE=oss\nOSS_ATTACHMENT_BUCKET=for-now\nOSS_REGION=cn-beijing\nALIBABA_CLOUD_ECS_RAM_ROLE=ForNowEcsBackupRole\nUNCHANGED=yes\nMEDIA_CDN_AUTH_KEY=old\nexport MEDIA_CDN_AUTH_KEY=duplicate\nMEDIA_DELIVERY_MODE=proxy\n";
const run = (...extra) => {
  const result = spawnSync(process.execPath, [helper, profile, env, key, release, ...(extra.length ? extra : applyArgs)], { encoding: "utf8" });
  assert.ok(!(result.stdout + result.stderr).includes(secret), "secret must never appear in output");
  return result;
};
try {
  await fs.mkdir(path.join(release, "src/config"), { recursive: true });
  await fs.mkdir(path.join(release, "src/shared/attachments"), { recursive: true });
  // Contract fixture stands in for a reviewed release; test the deployment helper's behavior.
  await fs.writeFile(path.join(release, "src/config/index.mjs"), `export function loadAttachmentConfig(e) { return {
    mode:e.ATTACHMENT_STORAGE,bucket:e.OSS_ATTACHMENT_BUCKET,region:e.OSS_REGION,roleName:e.ALIBABA_CLOUD_ECS_RAM_ROLE,
    delivery:{mode:e.MEDIA_DELIVERY_MODE,bucket:e.MEDIA_DELIVERY_BUCKET,endpoint:e.MEDIA_DELIVERY_OSS_ENDPOINT,cdnOrigin:e.MEDIA_CDN_ORIGIN,cdnKey:e.MEDIA_CDN_AUTH_KEY}
  }};`);
  await fs.writeFile(path.join(release, "src/shared/attachments/delivery.mjs"), `export function validateDeliveryConfig(c,b) { if(c.bucket===b) throw new Error('source bucket'); return c; }`);
  await fs.writeFile(profile, JSON.stringify(approved), { mode: 0o600 });
  await fs.writeFile(env, original, { mode: 0o600 });
  await fs.writeFile(key, secret + "\n", { mode: 0o600 });
  assert.equal(run("--check").status, 0);
  assert.equal(await fs.readFile(env, "utf8"), original, "check is read-only");
  assert.equal(spawnSync(process.execPath,[helper,profile,env,key,release]).status,1,"unfenced apply rejected");
  assert.equal(run().status, 0);
  assert.equal(await fs.readFile(persistentProfile,"utf8"),JSON.stringify(approved));
  const applied = await fs.readFile(env, "utf8");
  assert.match(applied, /# preserve me\n/);
  assert.match(applied, /UNCHANGED=yes\n/);
  assert.equal((applied.match(/MEDIA_CDN_AUTH_KEY=/g) || []).length, 1);
  assert.ok(applied.includes(`MEDIA_CDN_AUTH_KEY=${secret}\n`));
  assert.equal((await fs.stat(env)).mode & 0o777, 0o600);
  assert.equal(run().status, 0);
  assert.equal(await fs.readFile(env, "utf8"), applied, "idempotent application");
  for (const bad of [
    { ...approved, MEDIA_CDN_AUTH_KEY: secret },
    { ...approved, MEDIA_CDN_ORIGIN: "https://evil.example" },
    { ...approved, MEDIA_DELIVERY_BUCKET: "for-now" },
    { ...approved, MEDIA_DELIVERY_MODE: "cdn-signed\nEVIL=1" }
  ]) {
    await fs.writeFile(profile, JSON.stringify(bad));
    assert.equal(run().status, 1);
    assert.equal(await fs.readFile(env, "utf8"), applied, "invalid profile preserves env");
  }
  await fs.writeFile(profile, JSON.stringify(approved));
  await fs.chmod(key, 0o644);
  assert.equal(run().status, 1);
  await fs.chmod(key, 0o600);
  await fs.rename(key, `${key}.protected`);
  await fs.symlink(`${key}.protected`, key);
  assert.equal(run().status, 1, "symlink key rejected");
  await fs.unlink(key);
  await fs.rename(`${key}.protected`, key);
  await fs.chmod(env, 0o644);
  assert.equal(run().status, 1, "public env rejected");
  await fs.chmod(env, 0o600);
  await fs.writeFile(path.join(release, "src/config/index.mjs"), "export function loadAttachmentConfig(){return {mode:'oss',bucket:'for-now'}};");
  assert.equal(run().status, 1, "old candidate must fail closed");
  assert.equal(await fs.readFile(env, "utf8"), applied);
  assert.equal((await fs.readdir(dir)).some(name => name.startsWith(".for-now-media.")), false);
  // Deterministic scheduling barrier: revoke after candidate import has started,
  // before the helper can stage and commit either protected configuration file.
  const entered = path.join(dir,"import-entered"), resume = path.join(dir,"import-resume");
  await fs.writeFile(path.join(release,"src/config/index.mjs"), `import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(entered)},"entered");
    while(!fs.existsSync(${JSON.stringify(resume)})) await new Promise(r=>setTimeout(r,5));
    export function loadAttachmentConfig(e){return {mode:e.ATTACHMENT_STORAGE,bucket:e.OSS_ATTACHMENT_BUCKET,region:e.OSS_REGION,roleName:e.ALIBABA_CLOUD_ECS_RAM_ROLE,
    delivery:{mode:e.MEDIA_DELIVERY_MODE,bucket:e.MEDIA_DELIVERY_BUCKET,endpoint:e.MEDIA_DELIVERY_OSS_ENDPOINT,cdnOrigin:e.MEDIA_CDN_ORIGIN,cdnKey:e.MEDIA_CDN_AUTH_KEY}}};`);
  await fs.writeFile(env,original);
  const profileBefore = await fs.readFile(persistentProfile,"utf8");
  const child = spawn(process.execPath,[helper,profile,env,key,release,...applyArgs]);
  let output="";child.stdout.on("data",v=>output+=v);child.stderr.on("data",v=>output+=v);
  const terminal=new Promise(resolve=>child.on("close",resolve));
  const deadline=Date.now()+5000;
  while(!(await fs.access(entered).then(()=>true,()=>false)) && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
  assert.ok(await fs.access(entered).then(()=>true,()=>false),"import barrier reached");
  await installed.fence.invalidate({target:"production",expectedAttemptId:approval.attemptId});
  await fs.writeFile(resume,"resume");
  assert.equal(await terminal,1,"in-flight revoked helper rejected");
  assert.equal(await fs.readFile(env,"utf8"),original,"revocation preserves environment");
  assert.equal(await fs.readFile(persistentProfile,"utf8"),profileBefore,"revocation preserves profile");
  assert.ok(!output.includes(secret));
  assert.equal((await fs.readdir(dir)).some(name=>name.startsWith(".for-now-media.")),false);
  console.log("Media config checks passed: read-only preflight, atomic/idempotent apply, duplicate removal, unrelated config preservation, private permissions, symlink/injection rejection, old candidate refusal, and no secret output. No remote commands executed.");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
