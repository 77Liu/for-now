import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Run the real Preview Bash control flow with privileged and network commands shimmed.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "for-now-preview-deploy-")));
const firstCommit = "1111111111111111111111111111111111111111";
const secondCommit = "2222222222222222222222222222222222222222";
const deploySource = await fs.readFile(path.join(root, "deploy/deploy-preview.sh"), "utf8");
const serviceSource = await fs.readFile(path.join(root, "deploy/for-now-preview.service"), "utf8");
const nginxSource = await fs.readFile(path.join(root, "deploy/nginx-for-now-preview.conf"), "utf8");
const siteSource = await fs.readFile(path.join(root, "deploy/nginx-dysf.conf"), "utf8");
const envExample = await fs.readFile(path.join(root, "deploy/for-now-preview.env.example"), "utf8");
const readme = await fs.readFile(path.join(root, "deploy/README-preview.md"), "utf8");

assert.match(serviceSource, /^User=for-now-preview$/m);
assert.match(serviceSource, /^Group=for-now-preview$/m);
assert.match(serviceSource, /^WorkingDirectory=\/opt\/for-now-preview\/app$/m);
assert.match(serviceSource, /^EnvironmentFile=\/etc\/for-now-preview\.env$/m);
assert.match(serviceSource, /^ReadWritePaths=\/srv\/for-now-preview\/data$/m);
assert.match(serviceSource, /^MemoryHigh=384M$/m);
assert.match(serviceSource, /^MemoryMax=512M$/m);
assert.doesNotMatch(serviceSource, /^Memory(?:High|Max)=768M$/m);
assert.doesNotMatch(serviceSource, /\/srv\/for-now\/data|EnvironmentFile=\/etc\/for-now\.env|^User=for-now$/m);
assert.match(nginxSource, /location = \/preview\/api\/admin\/v1\/snapshot[\s\S]*return 404;/);
assert.match(nginxSource, /location ~ \^\/preview\/[\s\S]*gzip_static on;/);
assert.match(nginxSource, /types \{[\s\S]*application\/javascript js mjs;[\s\S]*\}/);
assert.match(nginxSource, /proxy_pass http:\/\/127\.0\.0\.1:4175;/);
assert.match(nginxSource, /location \/preview\/[\s\S]*gzip on;[\s\S]*gzip_proxied any;[\s\S]*gzip_types application\/json application\/problem\+json;/);
assert.match(nginxSource, /X-Robots-Tag "noindex, nofollow, noarchive" always;/);
assert.doesNotMatch(nginxSource, /127\.0\.0\.1:4173|\/opt\/for-now\/app/);
assert.match(siteSource, /include \/etc\/nginx\/snippets\/for-now-preview\*\.conf;/);
assert.match(await fs.readFile(path.join(root, "deploy/nginx-for-now.conf"), "utf8"), /proxy_pass http:\/\/127\.0\.0\.1:4173;/);
assert.match(deploySource, /preview\/\*/);
assert.match(deploySource, /^export PATH=.*\/usr\/sbin$/m);
assert.match(deploySource, /\/bin\/sh -c 'cd "\$HOME" && exec "\$@"'/);
assert.match(deploySource, /chown -R "\$runtime_user:\$runtime_user" "\$candidate"[\s\S]*preview_run npm/);
assert.match(deploySource, /preview_run npm[\s\S]*chown -R "root:root" "\$candidate"[\s\S]*chmod 0755 "\$candidate"/);
assert.match(deploySource, /npm --prefix "\$candidate" ci --omit=dev/);
assert.match(deploySource, /prompt-catalog-regression\.mjs/);
assert.match(deploySource, /FFmpeg is required for M4A speech transcription/);
assert.match(deploySource, /gzip -n -6/);
assert.match(deploySource, /127\.0\.0\.1:4175\/preview\/readyz/);
assert.doesNotMatch(deploySource, /\/opt\/for-now(?:\/|$)|\/etc\/for-now\.env|for-now\.service|\/srv\/for-now(?:\/|$)/);
for (const value of [
  "APP_BASE_PATH=/preview", "PORT=4175", "PERSISTENCE_BACKEND=json",
  "ATTACHMENT_STORAGE=local", "AUTH_REQUIRED=1", "COOKIE_SECURE=1"
]) {
  assert.match(envExample, new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(deploySource, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
for (const forbidden of ["DATABASE_URL", "AUTH_DATABASE_URL", "AI_BUDGET_DATABASE_URL", "UPSTREAM_ORIGIN"]) {
  assert.doesNotMatch(envExample, new RegExp(`^${forbidden}=`, "m"));
  assert.match(deploySource, new RegExp(forbidden));
}
assert.match(deploySource, /is forbidden in the Preview environment/);
assert.match(readme, /are never rollback\s+targets/i);

const validEnvironment = version => [
  "NODE_ENV=production",
  "PORT=4175",
  "TZ=Asia/Shanghai",
  "DATA_DIR=/srv/for-now-preview/data",
  "APP_BASE_PATH=/preview",
  `APP_VERSION=${version}`,
  "PERSISTENCE_BACKEND=json",
  "ATTACHMENT_STORAGE=local",
  "AUTH_REQUIRED=1",
  "COOKIE_SECURE=1",
  `INVITE_CODE_HASH=${"a".repeat(64)}`,
  "PERIODIC_ANALYSIS_ENABLED=0",
  "SPEECH_CACHE_SWEEP_ENABLED=0",
  "DEEPSEEK_API_KEY=preview-only-key",
  ""
].join("\n");

async function copyArchive(directory) {
  const archive = path.join(directory, "archive");
  await fs.mkdir(archive, { recursive: true });
  for (const name of ["deploy", "src", "prompts", "public", "scripts"]) {
    await fs.cp(path.join(root, name), path.join(archive, name), { recursive: true });
  }
  for (const name of ["server.mjs", "admin-snapshot.mjs", "package.json", "package-lock.json"]) {
    await fs.copyFile(path.join(root, name), path.join(archive, name));
  }
  return archive;
}

async function preseedRelease(directory, commit) {
  const release = path.join(directory, "opt/for-now-preview/releases", commit);
  await fs.mkdir(path.join(release, "deploy"), { recursive: true });
  for (const name of ["deploy-preview.sh", "for-now-preview.service", "nginx-for-now-preview.conf"]) {
    await fs.copyFile(path.join(root, "deploy", name), path.join(release, "deploy", name));
  }
  await fs.writeFile(path.join(release, ".preview-deploy-ready"), `preview-deploy-v1 ${commit}\n`);
  return release;
}

async function productionSnapshot(directory) {
  const production = path.join(directory, "opt/for-now");
  return {
    active: await fs.realpath(path.join(production, "app")),
    environment: await fs.readFile(path.join(directory, "etc/for-now.env"), "utf8"),
    service: await fs.readFile(path.join(directory, "etc/systemd/system/for-now.service"), "utf8"),
    data: await fs.readFile(path.join(directory, "srv/for-now/data/production-sentinel"), "utf8")
  };
}

async function optionalRead(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function previewSnapshot(directory) {
  const base = path.join(directory, "opt/for-now-preview");
  const realpath = async file => {
    try {
      return await fs.realpath(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    active: await realpath(path.join(base, "app")),
    previous: await realpath(path.join(base, "previous")),
    environment: await optionalRead(path.join(directory, "etc/for-now-preview.env")),
    service: await optionalRead(path.join(directory, "etc/systemd/system/for-now-preview.service")),
    nginx: await optionalRead(path.join(directory, "etc/nginx/snippets/for-now-preview.conf")),
    deployer: await optionalRead(path.join(directory, "usr/local/sbin/for-now-preview-deploy"))
  };
}

async function writeShim(directory, bin) {
  const shim = path.join(bin, "shim.mjs");
  await fs.writeFile(shim, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const dir = ${JSON.stringify(directory)};
const control = JSON.parse(fs.readFileSync(path.join(dir, "shim-control.json"), "utf8"));
const scenario = control.scenario;
const targetCommit = control.targetCommit;
const log = path.join(dir, "commands.log");
fs.appendFileSync(log, name + " " + args.join(" ") + "\\n");
const stateFile = path.join(dir, "systemd-state.json");
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const saveState = value => fs.writeFileSync(stateFile, JSON.stringify(value));
const currentCommit = () => {
  try { return path.basename(fs.realpathSync(path.join(dir, "opt/for-now-preview/app"))).slice(0, 40); }
  catch { return ""; }
};
if (name === "id") {
  if (args[0] === "-u") console.log("0");
  process.exit(0);
}
if (name === "stat") {
  console.log("root:root 600");
  process.exit(0);
}
if (name === "runuser") {
  const split = args.indexOf("--");
  const chdirIndex = args.indexOf("--chdir");
  const cwd = chdirIndex >= 0 ? args[chdirIndex + 1] : undefined;
  const result = spawnSync(args[split + 1], args.slice(split + 2), { cwd, env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (name === "git") {
  if (args.includes("clone")) {
    fs.mkdirSync(args.at(-1), { recursive: true });
    fs.writeFileSync(path.join(args.at(-1), "HEAD"), "ref: refs/heads/main\\n");
    process.exit(0);
  }
  if (args.includes("rev-parse")) {
    console.log(targetCommit);
    process.exit(0);
  }
  if (args.includes("archive")) {
    const result = spawnSync("/usr/bin/tar", ["-cf", "-", "-C", path.join(dir, "archive"), "."], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    process.exit(result.status ?? 1);
  }
  process.exit(0);
}
if (name === "npm") {
  if (scenario === "dependencies") process.exit(1);
  process.exit(0);
}
if (name === "node") {
  if (args[0] === "--check" && !fs.existsSync(args[1])) process.exit(1);
  if (args[0]?.endsWith("/scripts/prompt-catalog-regression.mjs") && scenario === "prompt") process.exit(1);
  process.exit(0);
}
if (name === "systemctl") {
  const value = state();
  if (args[0] === "is-enabled") process.exit(value.enabled ? 0 : 1);
  if (args[0] === "is-active") process.exit(value.active ? 0 : 1);
  if (args[0] === "enable") value.enabled = true;
  if (args[0] === "disable") value.enabled = false;
  if (args[0] === "stop") value.active = false;
  if (args[0] === "restart") {
    if (scenario === "restart" && currentCommit() === targetCommit) process.exit(1);
    value.active = true;
  }
  saveState(value);
  process.exit(0);
}
if (name === "curl") {
  if (control.failHealthCommit === currentCommit()) process.exit(22);
  process.exit(0);
}
if (name === "nginx") {
  if (scenario === "nginx") process.exit(1);
  process.exit(0);
}
if (name === "install") {
  const source = args.at(-2);
  const destination = args.at(-1);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  process.exit(0);
}
if (name === "mv") {
  const source = args.at(-2);
  const destination = args.at(-1);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(source, destination);
  process.exit(0);
}
if (name === "readlink") {
  try { console.log(fs.realpathSync(args.at(-1))); process.exit(0); }
  catch { process.exit(1); }
}
if (["chown", "sleep"].includes(name)) process.exit(0);
process.exit(0);
`, { mode: 0o755 });
  for (const command of [
    "chown", "curl", "git", "id", "install", "mv", "nginx", "npm", "node",
    "readlink", "runuser", "sleep", "stat", "systemctl"
  ]) {
    await fs.symlink(shim, path.join(bin, command));
  }
  for (const command of ["node", "npm"]) {
    await fs.mkdir(path.join(directory, "usr/local/bin"), { recursive: true });
    await fs.symlink(shim, path.join(directory, "usr/local/bin", command));
  }
}

async function setupScenario(name, {
  activeCommit = "",
  previousCommit = "",
  targetCommit = secondCommit,
  previewManaged = Boolean(activeCommit),
  systemd = { enabled: Boolean(activeCommit), active: Boolean(activeCommit) }
} = {}) {
  const directory = path.join(temporary, name);
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin, { recursive: true });
  await copyArchive(directory);
  await fs.mkdir(path.join(directory, "opt/for-now-preview/releases"), { recursive: true });
  await fs.mkdir(path.join(directory, "opt/for-now-preview/repository.git"), { recursive: true });
  await fs.mkdir(path.join(directory, "srv/for-now-preview/data"), { recursive: true });
  await fs.mkdir(path.join(directory, "home/for-now-preview/.ssh"), { recursive: true });
  await fs.writeFile(path.join(directory, "home/for-now-preview/.ssh/gitee_deploy"), "preview deploy key fixture\n");
  await fs.mkdir(path.join(directory, "etc"), { recursive: true });
  const environment = validEnvironment(activeCommit ? activeCommit.slice(0, 12) : "not-deployed")
    .replace("DATA_DIR=/srv/for-now-preview/data", `DATA_DIR=${directory}/srv/for-now-preview/data`);
  await fs.writeFile(path.join(directory, "etc/for-now-preview.env"), environment);
  await fs.mkdir(path.join(directory, "etc/systemd/system"), { recursive: true });
  await fs.mkdir(path.join(directory, "etc/nginx/snippets"), { recursive: true });
  await fs.mkdir(path.join(directory, "usr/local/sbin"), { recursive: true });
  await fs.mkdir(path.join(directory, "usr/bin"), { recursive: true });
  await fs.writeFile(path.join(directory, "usr/bin/ffmpeg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (previewManaged) {
    await fs.writeFile(path.join(directory, "etc/systemd/system/for-now-preview.service"), "old preview service\n");
    await fs.writeFile(path.join(directory, "etc/nginx/snippets/for-now-preview.conf"), "old preview nginx\n");
    await fs.writeFile(path.join(directory, "usr/local/sbin/for-now-preview-deploy"), "old preview deployer\n");
  }
  if (activeCommit) {
    const active = await preseedRelease(directory, activeCommit);
    await fs.symlink(active, path.join(directory, "opt/for-now-preview/app"));
  }
  if (previousCommit) {
    const previous = await preseedRelease(directory, previousCommit);
    await fs.symlink(previous, path.join(directory, "opt/for-now-preview/previous"));
  }

  const productionRelease = path.join(directory, "opt/for-now/releases/production");
  await fs.mkdir(productionRelease, { recursive: true });
  await fs.symlink(productionRelease, path.join(directory, "opt/for-now/app"));
  await fs.writeFile(path.join(directory, "etc/for-now.env"), "PRODUCTION_ENV_UNCHANGED=yes\n");
  await fs.writeFile(path.join(directory, "etc/systemd/system/for-now.service"), "production service unchanged\n");
  await fs.mkdir(path.join(directory, "srv/for-now/data"), { recursive: true });
  await fs.writeFile(path.join(directory, "srv/for-now/data/production-sentinel"), "production data unchanged\n");
  await fs.writeFile(path.join(directory, "systemd-state.json"), JSON.stringify(systemd));
  await fs.writeFile(path.join(directory, "commands.log"), "");
  await writeShim(directory, bin);

  let script = deploySource.replace(
    "export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin",
    `export PATH=${bin}:/usr/local/bin:/usr/bin:/bin`
  );
  for (const prefix of ["/opt/for-now-preview", "/home/for-now-preview", "/srv/for-now-preview", "/etc/", "/usr/local/"]) {
    script = script.replaceAll(prefix, `${directory}${prefix}`);
  }
  script = script.replaceAll("/usr/bin/stat", path.join(bin, "stat"));
  script = script.replaceAll("/usr/bin/ffmpeg", path.join(directory, "usr/bin/ffmpeg"));
  const scriptFile = path.join(directory, "deploy-preview.sh");
  await fs.writeFile(scriptFile, script, { mode: 0o755 });
  return { directory, bin, scriptFile, targetCommit };
}

function invoke(fixture, args = ["deploy"], environment = {}) {
  fsSync.writeFileSync(path.join(fixture.directory, "shim-control.json"), JSON.stringify({
    scenario: environment.scenario || "success",
    targetCommit: environment.targetCommit || fixture.targetCommit,
    failHealthCommit: environment.failHealthCommit || ""
  }));
  return spawnSync("/bin/bash", [fixture.scriptFile, ...args], {
    env: {
      ...process.env,
      DEPLOY_BRANCH: environment.branch || "preview/v0.5.0"
    },
    encoding: "utf8",
    timeout: 120000
  });
}

try {
  {
    const fixture = await setupScenario("install-idempotent", { targetCommit: firstCommit });
    const productionBefore = await productionSnapshot(fixture.directory);
    const first = invoke(fixture);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(path.basename(await fs.realpath(path.join(fixture.directory, "opt/for-now-preview/app"))), firstCommit);
    assert.equal(
      await fs.readFile(path.join(fixture.directory, "etc/systemd/system/for-now-preview.service"), "utf8"),
      serviceSource
    );
    assert.equal(
      await fs.readFile(path.join(fixture.directory, "etc/nginx/snippets/for-now-preview.conf"), "utf8"),
      nginxSource
    );
    assert.match(await fs.readFile(path.join(fixture.directory, "etc/for-now-preview.env"), "utf8"), /^APP_VERSION=111111111111$/m);
    const state = JSON.parse(await fs.readFile(path.join(fixture.directory, "systemd-state.json"), "utf8"));
    assert.deepEqual(state, { enabled: true, active: true });
    const active = await fs.realpath(path.join(fixture.directory, "opt/for-now-preview/app"));
    const runtime = await fs.readFile(path.join(active, "public/frontend/app/runtime.mjs"));
    const compressedRuntime = await fs.readFile(path.join(active, "public/frontend/app/runtime.mjs.gz"));
    assert.deepEqual(gunzipSync(compressedRuntime), runtime);
    assert.ok(compressedRuntime.length < runtime.length);

    const second = invoke(fixture);
    assert.equal(second.status, 0, second.stderr);
    const commands = await fs.readFile(path.join(fixture.directory, "commands.log"), "utf8");
    assert.equal(commands.match(/^npm /gm)?.length, 1, "same commit must not rerun npm ci");
    assert.match(commands, /node .*\/scripts\/prompt-catalog-regression\.mjs/);
    assert.match(commands, /curl -fsS http:\/\/127\.0\.0\.1:4175\/preview\/readyz/);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
  }

  {
    const fixture = await setupScenario("health-rollback", { activeCommit: firstCommit, targetCommit: secondCommit });
    await preseedRelease(fixture.directory, secondCommit);
    const productionBefore = await productionSnapshot(fixture.directory);
    const previewBefore = await previewSnapshot(fixture.directory);
    const result = invoke(fixture, ["deploy"], { failHealthCommit: secondCommit });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /only Preview code\/configuration was rolled back/);
    assert.deepEqual(await previewSnapshot(fixture.directory), previewBefore);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
  }

  {
    const fixture = await setupScenario("explicit-rollback", {
      activeCommit: secondCommit,
      previousCommit: firstCommit,
      targetCommit: secondCommit
    });
    const productionBefore = await productionSnapshot(fixture.directory);
    const result = invoke(fixture, ["rollback"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.basename(await fs.realpath(path.join(fixture.directory, "opt/for-now-preview/app"))), firstCommit);
    assert.equal(path.basename(await fs.realpath(path.join(fixture.directory, "opt/for-now-preview/previous"))), secondCommit);
    assert.match(await fs.readFile(path.join(fixture.directory, "etc/for-now-preview.env"), "utf8"), /^APP_VERSION=111111111111$/m);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
  }

  {
    const fixture = await setupScenario("rollback-health", {
      activeCommit: secondCommit,
      previousCommit: firstCommit,
      targetCommit: secondCommit
    });
    const productionBefore = await productionSnapshot(fixture.directory);
    const previewBefore = await previewSnapshot(fixture.directory);
    const result = invoke(fixture, ["rollback"], { failHealthCommit: firstCommit });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(await previewSnapshot(fixture.directory), previewBefore);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
  }

  for (const scenario of ["dependencies", "prompt"]) {
    const fixture = await setupScenario(scenario, { activeCommit: firstCommit, targetCommit: secondCommit });
    const productionBefore = await productionSnapshot(fixture.directory);
    const previewBefore = await previewSnapshot(fixture.directory);
    const result = invoke(fixture, ["deploy"], { scenario });
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.deepEqual(await previewSnapshot(fixture.directory), previewBefore);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
    const releases = await fs.readdir(path.join(fixture.directory, "opt/for-now-preview/releases"));
    assert.equal(releases.some(name => name.startsWith(`.${secondCommit}.`)), false);
  }

  {
    const fixture = await setupScenario("branch-rejection", { activeCommit: firstCommit });
    const productionBefore = await productionSnapshot(fixture.directory);
    const previewBefore = await previewSnapshot(fixture.directory);
    const result = invoke(fixture, ["deploy"], { branch: "main" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only accepts preview\/\* branches/);
    assert.deepEqual(await previewSnapshot(fixture.directory), previewBefore);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
    assert.doesNotMatch(await fs.readFile(path.join(fixture.directory, "commands.log"), "utf8"), /^git /m);
  }

  for (const [name, mutate, expected] of [
    ["forbidden-env", value => `${value}DATABASE_URL=\n`, /DATABASE_URL is forbidden/],
    ["forced-env", value => value.replace("PORT=4175", "PORT=4173"), /must contain exactly PORT=4175/],
    ["unknown-env", value => `${value}NODE_OPTIONS=--inspect\n`, /NODE_OPTIONS is not in the Preview environment allowlist/]
  ]) {
    const fixture = await setupScenario(name, { activeCommit: firstCommit });
    const productionBefore = await productionSnapshot(fixture.directory);
    const previewBefore = await previewSnapshot(fixture.directory);
    const envFile = path.join(fixture.directory, "etc/for-now-preview.env");
    await fs.writeFile(envFile, mutate(await fs.readFile(envFile, "utf8")));
    const result = invoke(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.deepEqual(await productionSnapshot(fixture.directory), productionBefore);
    const after = await previewSnapshot(fixture.directory);
    assert.deepEqual({ ...after, environment: previewBefore.environment }, previewBefore);
  }

  console.log(
    "Preview deploy checks passed: installation, isolated candidate validation, static gzip, same-commit idempotency, " +
    "explicit/failed rollback, preview-only branch and environment gates, and unchanged production code/service/env/data. " +
    "No remote commands, provider calls, push, or deployment executed."
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
