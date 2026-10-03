import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Run the real Bash control flow with all privileged/network commands replaced.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "growth-deploy-")));
const commit = "abcdef0123456789abcdef0123456789abcdef01";
const source = await fs.readFile(path.join(root, "deploy/deploy.sh"), "utf8");
const nginx = await fs.readFile(path.join(root, "deploy/nginx-for-now.conf"), "utf8");
const envExample = await fs.readFile(path.join(root, "deploy/for-now.env.example"), "utf8");
assert.match(nginx, /location = \/now\/api\/admin\/v1\/snapshot\s*\{\s*return 404;/);
assert.match(nginx, /location ~ \^\/now\/[\s\S]*gzip_static on;[\s\S]*add_header Cache-Control "no-store" always;/);
assert.match(nginx, /types \{[\s\S]*application\/javascript js mjs;[\s\S]*\}/);
assert.match(nginx, /location \/now\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4173;/);
assert.match(nginx, /location \/now\/[\s\S]*gzip on;[\s\S]*gzip_comp_level 2;[\s\S]*gzip_vary on;/);
assert.doesNotMatch(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4173\/;/);
assert.doesNotMatch(nginx, /\bproxy_cache\b|\bexpires\b|max-age/);
assert.match(nginx, /location \/platform\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4280\//);
assert.match(envExample, /^PLATFORM_SERVICE_TOKEN_HASH=$/m);
assert.match(envExample, /^AI_BUDGET_DATABASE_URL=$/m);
assert.match(envExample, /^MONITOR_PLATFORM_ENABLED=0$/m);
assert.match(envExample, /^MONITOR_PLATFORM_SERVICE_NAME=for-now-platform\.service$/m);
assert.match(envExample, /^MONITOR_PLATFORM_READY_URL=http:\/\/127\.0\.0\.1:4280\/readyz$/m);
const successfulScenarios = new Set(["success"]);
const files = [
  "/etc/for-now.env", "/etc/systemd/system/for-now.service", "/etc/systemd/system/for-now-backup.service",
  "/etc/systemd/system/for-now-backup.timer", "/etc/systemd/system/for-now-monitor.service",
  "/etc/systemd/system/for-now-monitor.timer", "/usr/local/sbin/for-now-backup", "/usr/local/sbin/for-now-restore-drill",
  "/usr/local/sbin/for-now-migrate-attachments",
  "/var/www/app-portal/index.html", "/etc/nginx/snippets/for-now.conf",
  "/etc/nginx/snippets/acme-challenge.conf", "/etc/nginx/sites-available/dysf", "/usr/local/sbin/for-now-deploy"
];
const certificateFiles = [
  "/etc/letsencrypt/live/123.57.140.24/fullchain.pem",
  "/etc/letsencrypt/live/123.57.140.24/privkey.pem",
  "/etc/letsencrypt/live/77liu.top/fullchain.pem",
  "/etc/letsencrypt/live/77liu.top/privkey.pem"
];
try {
  for (const scenario of ["success", "restart", "health", "nginx", "dependencies", "same_commit_dependencies", "exploration", "exploration_branch", "checkpoint_branch", "postgres_incompatible", "postgres_preflight"]) {
    const backendEnv = ["postgres_incompatible", "postgres_preflight"].includes(scenario)
      ? "PERSISTENCE_BACKEND=postgres\nDATABASE_URL=postgresql://data\nAUTH_DATABASE_URL=postgresql://auth\nAI_BUDGET_DATABASE_URL=postgresql://budget\n"
      : "";
    const dir = path.join(fixture, scenario), bin = path.join(dir, "bin"), base = path.join(dir, "opt/for-now");
    const exactRelease = path.join(base, "releases", commit);
    const previous = scenario === "same_commit_dependencies" ? exactRelease : path.join(base, "releases", "previous");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(previous, { recursive: true });
    await fs.writeFile(path.join(previous, "active-sentinel"), "unchanged\n");
    if (scenario === "postgres_preflight") {
      await fs.mkdir(path.join(previous, "src/shared/persistence"), { recursive: true });
      await fs.writeFile(path.join(previous, "src/shared/persistence/postgres-runtime.mjs"), "export {};\n");
    }
    await fs.mkdir(path.join(base, "repository.git"));
    await fs.mkdir(path.join(dir, "archive"), { recursive: true });
    await fs.mkdir(path.join(dir, "archive/scripts"), { recursive: true });
    await fs.cp(path.join(root, "deploy"), path.join(dir, "archive/deploy"), { recursive: true });
    await fs.cp(path.join(root, "src"), path.join(dir, "archive/src"), { recursive: true });
    await fs.cp(path.join(root, "prompts"), path.join(dir, "archive/prompts"), { recursive: true });
    await fs.cp(path.join(root, "public"), path.join(dir, "archive/public"), { recursive: true });
    for (const file of ["server.mjs", "package.json", "package-lock.json"]) await fs.copyFile(path.join(root, file), path.join(dir, "archive", file));
    for (const file of ["monitor-health.mjs", "validate-restored-data.mjs", "oss-attachment-smoke.mjs", "aliyun-segmentation-smoke.mjs", "postgres-runtime-preflight.mjs", "prompt-catalog-regression.mjs"]) {
      await fs.copyFile(path.join(root, "scripts", file), path.join(dir, "archive/scripts", file));
    }
    if (scenario === "exploration") await fs.writeFile(path.join(dir, "archive/public/explore-unexpected.txt"), "local exploration only\n");
    await fs.symlink(previous, path.join(base, "app"));
    for (const file of [...files, "/home/for-now/.ssh/gitee_deploy", "/usr/local/bin/npm", "/usr/local/bin/node"]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), file.endsWith(".env")
        ? `APP_VERSION=old-version\nOSS_ATTACHMENT_BUCKET=for-now\nOSS_ENDPOINT=https://oss-cn-beijing-internal.aliyuncs.com\nOSS_REGION=cn-beijing\nFEISHU_ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/test\nPLATFORM_SERVICE_TOKEN_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUNCHANGED=yes\n${backendEnv}`
        : `old:${file}\n`);
    }
    for (const file of certificateFiles) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), "test certificate fixture\n");
    }
    const shim = path.join(bin, "shim.mjs");
    await fs.writeFile(shim, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
const name=path.basename(process.argv[1]), args=process.argv.slice(2), dir=process.env.DEPLOY_FIXTURE, scenario=process.env.DEPLOY_SCENARIO;
fs.appendFileSync(path.join(dir,"commands.log"),name+" "+args.join(" ")+"\\n");
const current=fs.realpathSync(path.join(dir,"opt/for-now/app")), isNew=current.endsWith("${commit}");
if(name==="sudo"){const r=spawnSync(args[2],args.slice(3),{env:process.env,stdio:"inherit"});process.exit(r.status??1)}
if(name==="runuser"){const split=args.indexOf("--"),r=spawnSync(args[split+1],args.slice(split+2),{env:process.env,stdio:"inherit"});process.exit(r.status??1)}
if(name==="id")console.log("0");
if(name==="git"&&args.includes("rev-parse"))console.log("${commit}");
if(name==="git"&&args.includes("archive")){const r=spawnSync("/usr/bin/tar",["-cf","-","-C",path.join(dir,"archive"),"."],{stdio:["ignore","inherit","inherit"]});process.exit(r.status??1)}
if(name==="npm"&&["dependencies","same_commit_dependencies"].includes(scenario))process.exit(1);
if(name==="node"&&args[0]==="--check"&&!fs.existsSync(args[1]))process.exit(1);
if(name==="node"&&args[0]?.endsWith("/scripts/postgres-runtime-preflight.mjs")&&scenario==="postgres_preflight")process.exit(1);
if(name==="systemctl"&&args[0]==="restart"&&isNew&&scenario==="restart")process.exit(1);
if(name==="curl"&&isNew&&scenario==="health")process.exit(1);
if(name==="nginx"&&scenario==="nginx")process.exit(1);
if(name==="mv")fs.renameSync(args.at(-2),args.at(-1));
if(name==="readlink")console.log(current);
if(name==="install"){const src=args.at(-2),dst=args.at(-1);fs.copyFileSync(src,dst)}
if(name==="sed"){const file=args.at(-1),version=args[1].split("APP_VERSION=")[2].slice(0,-1);fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace(/^APP_VERSION=.*$/m,"APP_VERSION="+version))}
`, { mode: 0o755 });
    for (const command of ["sudo", "id", "git", "chown", "systemctl", "curl", "nginx", "install", "sleep", "find", "mv", "readlink", "runuser", "sed"]) {
      await fs.symlink(shim, path.join(bin, command));
    }
    for (const command of ["npm", "node"]) {
      await fs.unlink(path.join(dir, "usr/local/bin", command));
      await fs.symlink(shim, path.join(dir, "usr/local/bin", command));
    }
    let script = source;
    for (const prefix of ["/opt/for-now", "/home/for-now", "/etc/", "/usr/local/", "/var/www/"]) {
      script = script.replaceAll(prefix, `${dir}${prefix}`);
    }
    const scriptFile = path.join(dir, "deploy.sh");
    await fs.writeFile(scriptFile, script);
    const result = spawnSync("/bin/bash", [scriptFile], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        DEPLOY_FIXTURE: dir,
        DEPLOY_SCENARIO: scenario,
        ...(scenario === "exploration_branch" ? { DEPLOY_BRANCH: "explore/nightly-p3-20260928" } : {}),
        ...(scenario === "checkpoint_branch" ? { DEPLOY_BRANCH: "checkpoint/v0.2.0-g2-20260930" } : {})
      },
      encoding: "utf8", timeout: 60000
    });
    if (scenario === "exploration") assert.match(result.stderr, /Production release contains local exploration assets/);
    if (["exploration_branch", "checkpoint_branch"].includes(scenario)) assert.match(result.stderr, /Non-release branches cannot be used/);
    if (scenario === "postgres_incompatible") assert.match(result.stderr, /PostgreSQL deployment requires a database-capable candidate and rollback release/);
    if (scenario === "postgres_preflight") {
      const commands = await fs.readFile(path.join(dir, "commands.log"), "utf8");
      assert.doesNotMatch(commands, /systemctl (?:restart|daemon-reload)|install .*\/etc\/systemd|mv .*\/opt\/for-now\/app/);
    }
    const succeeded = successfulScenarios.has(scenario);
    assert.equal(result.status, succeeded ? 0 : 1, `${scenario}: ${result.stderr}`);
    const active = await fs.realpath(path.join(base, "app"));
    if (succeeded) assert.equal(path.basename(active), commit);
    else assert.equal(active, previous);
    if (succeeded) {
      const commands = await fs.readFile(path.join(dir, "commands.log"), "utf8");
      assert.match(commands, /node --check .*\/src\/shared\/attachments\/storage\.mjs/);
      assert.match(commands, /node --check .*\/src\/config\/index\.mjs/);
      assert.match(commands, /node --check .*\/src\/shared\/observability\/logging\.mjs/);
      assert.match(commands, /node --check .*\/src\/http\/request\.mjs/);
      assert.match(commands, /node --check .*\/public\/frontend\/api\/index\.mjs/);
      assert.match(commands, /node --check .*\/public\/frontend\/app\/runtime\.mjs/);
      assert.match(commands, /node --check .*\/public\/frontend\/pages\/index\.mjs/);
      assert.match(commands, /node --check .*\/public\/frontend\/features\/index\.mjs/);
      assert.match(commands, /node --check .*\/scripts\/postgres-runtime-preflight\.mjs/);
      assert.match(commands, /node .*\/scripts\/prompt-catalog-regression\.mjs/);
      const nginxConfig = await fs.readFile(path.join(dir, "etc/nginx/sites-available/dysf"), "utf8");
      assert.equal(nginxConfig, await fs.readFile(path.join(dir, "archive/deploy/nginx-dysf.conf"), "utf8"));
      assert.match(nginxConfig, /server_name 77liu\.top;/);
      assert.match(nginxConfig, /ssl_certificate \/etc\/letsencrypt\/live\/77liu\.top\/fullchain\.pem;/);
      assert.match(nginxConfig, /return 308 https:\/\/77liu\.top\$request_uri;/);
      const publicEntries = await fs.readdir(path.join(active, "public"));
      assert.deepEqual(publicEntries.filter(name => name.startsWith("explore")), []);
      assert.equal(
        await fs.readFile(path.join(active, "public/index.html"), "utf8"),
        await fs.readFile(path.join(root, "public/index.html"), "utf8")
      );
      const runtime = await fs.readFile(path.join(active, "public/frontend/app/runtime.mjs"));
      const compressedRuntime = await fs.readFile(path.join(active, "public/frontend/app/runtime.mjs.gz"));
      assert.deepEqual(gunzipSync(compressedRuntime), runtime);
      assert.ok(compressedRuntime.length < runtime.length);
    }
    const env = await fs.readFile(path.join(dir, "etc/for-now.env"), "utf8");
    assert.equal(env, `APP_VERSION=${succeeded ? commit.slice(0, 12) : "old-version"}\nOSS_ATTACHMENT_BUCKET=for-now\nOSS_ENDPOINT=https://oss-cn-beijing-internal.aliyuncs.com\nOSS_REGION=cn-beijing\nFEISHU_ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/test\nPLATFORM_SERVICE_TOKEN_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUNCHANGED=yes\n${backendEnv}`);
    if (!succeeded) {
      for (const file of files.filter(file => !file.endsWith(".env"))) {
        assert.equal(await fs.readFile(path.join(dir, file), "utf8"), `old:${file}\n`, `${scenario}: restore ${file}`);
      }
    }
    assert.equal(await fs.readFile(path.join(previous, "active-sentinel"), "utf8"), "unchanged\n");
    assert.equal((await fs.readdir(base)).some(name => name.startsWith(".deploy-rollback.")), false);
    assert.equal((await fs.readdir(path.join(base, "releases"))).some(name => name.startsWith(`.${commit}.`)), false);
  }
  console.log("Deploy checks passed: modular candidate and prompt validation, exploration asset/branch rejection, domain/platform Nginx and monitoring gates, PostgreSQL rollback compatibility, same-commit safety, failure recovery, and code/config/version restoration. No remote commands executed.");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
