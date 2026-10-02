import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFontconfigCache } from "./fontconfig-cache.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-fontconfig-"));
const mode = async directory => (await fs.stat(directory)).mode & 0o777;

try {
  const dataDir = path.join(temporary, "data");
  const environment = { XDG_CACHE_HOME: path.join(temporary, "unusable-cache") };
  await fs.mkdir(dataDir, { mode: 0o755 });
  const prepared = await prepareFontconfigCache({ dataDir, env: environment });
  assert.equal(environment.XDG_CACHE_HOME, path.join(dataDir, "cache"));
  assert.equal(prepared.cacheHome, environment.XDG_CACHE_HOME);
  assert.equal(await mode(prepared.cacheHome), 0o700);
  assert.equal(await mode(prepared.fontconfigDir), 0o700);
  assert.equal(await mode(dataDir), 0o755, "不得改变项目数据目录本身的权限");

  const outside = path.join(temporary, "outside-cache");
  const linkedData = path.join(temporary, "linked-data");
  await fs.mkdir(outside, { mode: 0o755 });
  await fs.mkdir(linkedData, { mode: 0o700 });
  await fs.symlink(outside, path.join(linkedData, "cache"));
  await assert.rejects(
    prepareFontconfigCache({ dataDir: linkedData, env: {} }),
    error => error?.code === "FONTCONFIG_CACHE_UNSAFE"
  );
  assert.equal(await mode(outside), 0o755, "不得通过符号链接修改外部目录权限");

  const lockedHome = path.join(temporary, "locked-home");
  const planDataDir = path.join(temporary, "plan-data");
  await fs.mkdir(lockedHome, { mode: 0o500 });
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !(
      ["DATABASE_URL", "AUTH_DATABASE_URL", "AI_BUDGET_DATABASE_URL"].includes(key)
      || /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/.test(key)
    ))
  );
  Object.assign(childEnvironment, {
    HOME: lockedHome,
    DATA_DIR: planDataDir,
    XDG_CACHE_HOME: path.join(lockedHome, "unwritable-cache")
  });
  const node = process.env.FONTCONFIG_TEST_NODE || process.execPath;
  const result = spawnSync(node, [path.join(ROOT, "scripts/third-party-live-smoke.mjs")], {
    cwd: ROOT,
    env: childEnvironment,
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "", "第三方 plan-only 不应输出 stderr 警告");
  assert.equal(JSON.parse(result.stdout).live, false);
  assert.equal(await mode(path.join(planDataDir, "cache")), 0o700);
  assert.equal(await mode(path.join(planDataDir, "cache", "fontconfig")), 0o700);

  console.log("Fontconfig cache checks passed: private project cache, inherited XDG environment, symlink refusal, and warning-free third-party plan-only.");
} finally {
  await fs.chmod(path.join(temporary, "locked-home"), 0o700).catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
