import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run the real Bash control flow with all privileged/network commands replaced.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "growth-deploy-")));
const commit = "abcdef0123456789abcdef0123456789abcdef01";
const source = await fs.readFile(path.join(root, "deploy/deploy.sh"), "utf8");
const nginx = await fs.readFile(path.join(root, "deploy/nginx-for-now.conf"), "utf8");
const envExample = await fs.readFile(path.join(root, "deploy/for-now.env.example"), "utf8");
assert.match(nginx, /location = \/now\/api\/admin\/v1\/snapshot\s*\{\s*return 404;/);
assert.match(nginx, /location \/platform\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4280\//);
assert.match(envExample, /^PLATFORM_SERVICE_TOKEN_HASH=$/m);
const files = [
  "/etc/for-now.env", "/etc/systemd/system/for-now.service", "/etc/systemd/system/for-now-backup.service",
  "/etc/systemd/system/for-now-backup.timer", "/etc/systemd/system/for-now-monitor.service",
  "/etc/systemd/system/for-now-monitor.timer", "/usr/local/sbin/for-now-backup", "/usr/local/sbin/for-now-restore-drill",
  "/usr/local/sbin/for-now-migrate-attachments",
  "/var/www/app-portal/index.html", "/etc/nginx/snippets/for-now.conf",
  "/etc/nginx/snippets/acme-challenge.conf", "/etc/nginx/sites-available/dysf", "/usr/local/sbin/for-now-deploy"
];
try {
  for (const scenario of ["success", "restart", "health", "nginx", "dependencies", "same_commit_dependencies", "exploration"]) {
    const dir = path.join(fixture, scenario), bin = path.join(dir, "bin"), base = path.join(dir, "opt/for-now");
    const exactRelease = path.join(base, "releases", commit);
    const previous = scenario === "same_commit_dependencies" ? exactRelease : path.join(base, "releases", "previous");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(previous, { recursive: true });
    await fs.writeFile(path.join(previous, "active-sentinel"), "unchanged\n");
    await fs.mkdir(path.join(base, "repository.git"));
    await fs.mkdir(path.join(dir, "archive/public"), { recursive: true });
    await fs.mkdir(path.join(dir, "archive/scripts"), { recursive: true });
    await fs.cp(path.join(root, "deploy"), path.join(dir, "archive/deploy"), { recursive: true });
    for (const file of ["server.mjs", "admin-snapshot.mjs", "logging.mjs", "attachment-storage.mjs", "package.json", "package-lock.json"]) await fs.copyFile(path.join(root, file), path.join(dir, "archive", file));
    for (const file of ["monitor-health.mjs", "validate-restored-data.mjs", "oss-attachment-smoke.mjs", "aliyun-segmentation-smoke.mjs"]) {
      await fs.copyFile(path.join(root, "scripts", file), path.join(dir, "archive/scripts", file));
    }
    await fs.copyFile(path.join(root, "public/app.js"), path.join(dir, "archive/public/app.js"));
    if (scenario === "exploration") await fs.writeFile(path.join(dir, "archive/public/explore.html"), "local exploration only\n");
    await fs.symlink(previous, path.join(base, "app"));
    for (const file of [...files, "/home/for-now/.ssh/gitee_deploy", "/usr/local/bin/npm", "/usr/local/bin/node"]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), file.endsWith(".env")
        ? "APP_VERSION=old-version\nOSS_ATTACHMENT_BUCKET=for-now\nOSS_ENDPOINT=https://oss-cn-beijing-internal.aliyuncs.com\nOSS_REGION=cn-beijing\nFEISHU_ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/test\nPLATFORM_SERVICE_TOKEN_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUNCHANGED=yes\n"
        : `old:${file}\n`);
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
if(name==="id")console.log("0");
if(name==="git"&&args.includes("rev-parse"))console.log("${commit}");
if(name==="git"&&args.includes("archive")){const r=spawnSync("/usr/bin/tar",["-cf","-","-C",path.join(dir,"archive"),"."],{stdio:["ignore","inherit","inherit"]});process.exit(r.status??1)}
if(name==="npm"&&["dependencies","same_commit_dependencies"].includes(scenario))process.exit(1);
if(name==="systemctl"&&args[0]==="restart"&&isNew&&scenario==="restart")process.exit(1);
if(name==="curl"&&isNew&&scenario==="health")process.exit(1);
if(name==="nginx"&&scenario==="nginx")process.exit(1);
if(name==="mv")fs.renameSync(args.at(-2),args.at(-1));
if(name==="readlink")console.log(current);
if(name==="install"){const src=args.at(-2),dst=args.at(-1);fs.copyFileSync(src,dst)}
if(name==="sed"){const file=args.at(-1),version=args[1].split("APP_VERSION=")[2].slice(0,-1);fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace(/^APP_VERSION=.*$/m,"APP_VERSION="+version))}
`, { mode: 0o755 });
    for (const command of ["sudo", "id", "git", "chown", "systemctl", "curl", "nginx", "install", "sleep", "find", "mv", "readlink", "sed"]) {
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
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DEPLOY_FIXTURE: dir, DEPLOY_SCENARIO: scenario },
      encoding: "utf8", timeout: 60000
    });
    assert.equal(result.status, scenario === "success" ? 0 : 1, `${scenario}: ${result.stderr}`);
    const active = await fs.realpath(path.join(base, "app"));
    if (scenario === "success") assert.equal(path.basename(active), commit);
    else assert.equal(active, previous);
    const env = await fs.readFile(path.join(dir, "etc/for-now.env"), "utf8");
    assert.equal(env, `APP_VERSION=${scenario === "success" ? commit.slice(0, 12) : "old-version"}\nOSS_ATTACHMENT_BUCKET=for-now\nOSS_ENDPOINT=https://oss-cn-beijing-internal.aliyuncs.com\nOSS_REGION=cn-beijing\nFEISHU_ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/test\nPLATFORM_SERVICE_TOKEN_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nUNCHANGED=yes\n`);
    if (scenario !== "success") {
      for (const file of files.filter(file => !file.endsWith(".env"))) {
        assert.equal(await fs.readFile(path.join(dir, file), "utf8"), `old:${file}\n`, `${scenario}: restore ${file}`);
      }
    }
    assert.equal(await fs.readFile(path.join(previous, "active-sentinel"), "utf8"), "unchanged\n");
    assert.equal((await fs.readdir(base)).some(name => name.startsWith(".deploy-rollback.")), false);
    assert.equal((await fs.readdir(path.join(base, "releases"))).some(name => name.startsWith(`.${commit}.`)), false);
  }
  console.log("Deploy checks passed: isolated candidate build, same-commit safety, restart/health/nginx/dependency failures, and code/config/version restoration. No remote commands executed.");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
