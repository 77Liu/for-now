import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gateSource = path.join(root, "scripts/commit-gate.mjs");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-commit-gate-regression-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function git(directory, args, options = {}) {
  return run("git", args, { cwd: directory, ...options });
}

async function makeRepository(name, { failingCheck = false, delayedCheck = false } = {}) {
  const directory = path.join(temporary, name);
  await fs.mkdir(path.join(directory, "src/modules/actions"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/features/actions"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/features/keepsakes"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/features/home"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/features/personal-context"), { recursive: true });
  await fs.mkdir(path.join(directory, "scripts"), { recursive: true });
  await fs.mkdir(path.join(directory, "reports"), { recursive: true });
  const checkSource = [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "assert.equal(fs.readFileSync('outside.txt', 'utf8'), 'base\\n');",
    failingCheck ? "process.exit(7);" : "",
    delayedCheck
      ? "if (process.env.GATE_DRIFT_MARKER) { fs.writeFileSync(process.env.GATE_DRIFT_MARKER, 'ready'); await new Promise(resolve => setTimeout(resolve, 600)); }"
      : ""
  ].filter(Boolean).join("\n");
  await fs.writeFile(path.join(directory, "check.mjs"), `${checkSource}\n`);
  await fs.writeFile(path.join(directory, "outside.txt"), "base\n");
  await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 1;\n");
  for (const name of [
    "frontend-actions-feature-regression.mjs",
    "frontend-basic-surfaces-feature-regression.mjs",
    "frontend-contract-regression.mjs",
    "context-source-route-regression.mjs",
    "frontend-keepsakes-feature-regression.mjs",
    "frontend-shell-regression.mjs",
    "g2-actions-regression.mjs",
    "home-chat-citation-renderer-regression.mjs",
    "mobile-platform-regression.mjs",
    "ui-regression.mjs",
    "url-history-regression.mjs"
  ]) {
    const source = name === "g2-actions-regression.mjs"
      ? [
          'import assert from "node:assert/strict";',
          'assert.equal(process.env.MEDIA_CDN_AUTH_KEY, undefined);',
          `process.stdout.write("ran:${name}\\n");`
        ].join("\n")
      : `process.stdout.write("ran:${name}\\n");`;
    await fs.writeFile(
      path.join(directory, "scripts", name),
      `${source}\n`
    );
  }
  await fs.copyFile(gateSource, path.join(directory, "scripts/commit-gate.mjs"));
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: `commit-gate-${name}`,
    private: true,
    type: "module",
    scripts: {
      check: "node check.mjs",
      "test:backend": "node -e \"console.log('broad-backend')\"",
      "test:frontend": "node -e \"console.log('broad-frontend')\"",
      "test:system": "node -e \"console.log('broad-system')\""
    }
  }, null, 2) + "\n");
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.name", "Commit Gate Regression"]);
  git(directory, ["config", "user.email", "commit-gate@example.invalid"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "test: initialize fixture"]);
  return directory;
}

function invokeGate(directory, message, extra = [], options = {}) {
  return run(process.execPath, [path.join(directory, "scripts/commit-gate.mjs"), "--message", message, ...extra], {
    cwd: directory,
    env: options.env,
    allowFailure: true
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", status => resolve({ status, stdout, stderr }));
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

try {
  {
    const directory = await makeRepository("allowed");
    git(directory, ["switch", "-c", "feature/actions"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    await fs.writeFile(path.join(directory, "outside.txt"), "unstaged workspace value\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const before = git(directory, ["rev-parse", "HEAD"]).stdout.trim();
    const stagedTree = git(directory, ["write-tree"]).stdout.trim();
    const result = invokeGate(directory, "feat(actions): update local action behavior", [], {
      env: { ...process.env, MEDIA_CDN_AUTH_KEY: "poisoned-media-key" }
    });
    assert.equal(result.status, 0, result.stderr);
    const after = git(directory, ["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(after, before);
    assert.equal(git(directory, ["rev-parse", "HEAD^{tree}"]).stdout.trim(), stagedTree);
    assert.match(git(directory, ["show", "-s", "--format=%B", "HEAD"]).stdout, /Commit-Type: feat/);
    assert.match(git(directory, ["show", "-s", "--format=%B", "HEAD"]).stdout, /Commit-Gate: local-task-v2/);
    assert.match(result.stdout, /ran:g2-actions-regression\.mjs/);
    assert.doesNotMatch(result.stdout, /broad-(?:backend|frontend|system)/);
    assert.equal(git(directory, ["show", "HEAD:outside.txt"]).stdout, "base\n");
    assert.equal(git(directory, ["status", "--short"]).stdout, " M outside.txt\n");
  }

  {
    const directory = await makeRepository("fix");
    git(directory, ["switch", "-c", "fix/actions"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const result = invokeGate(directory, "fix(actions): preserve action state");
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(directory, ["show", "-s", "--format=%B", "HEAD"]).stdout, /Commit-Type: fix/);
  }

  {
    const directory = await makeRepository("test-only");
    git(directory, ["switch", "-c", "test/records"]);
    await fs.appendFile(path.join(directory, "scripts/frontend-actions-feature-regression.mjs"), "// frontend case changed\n");
    await fs.appendFile(path.join(directory, "scripts/g2-actions-regression.mjs"), "// backend case changed\n");
    git(directory, ["add", "scripts/frontend-actions-feature-regression.mjs", "scripts/g2-actions-regression.mjs"]);
    const result = invokeGate(directory, "test(actions): cover action regressions");
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(directory, ["show", "-s", "--format=%B", "HEAD"]).stdout, /Commit-Type: test/);
    assert.match(result.stdout, /ran:frontend-actions-feature-regression\.mjs/);
    assert.match(result.stdout, /ran:g2-actions-regression\.mjs/);
    assert.doesNotMatch(result.stdout, /broad-(?:backend|frontend|system)/);
  }

  {
    const directory = await makeRepository("mixed-actions");
    git(directory, ["switch", "-c", "feature/mixed-actions"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    await fs.writeFile(path.join(directory, "public/frontend/features/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs", "public/frontend/features/actions/index.mjs"]);
    const result = invokeGate(directory, "feat(actions): update action behavior");
    assert.equal(result.status, 0, result.stderr);
    for (const name of [
      "g2-actions-regression.mjs",
      "frontend-actions-feature-regression.mjs",
      "frontend-contract-regression.mjs"
    ]) {
      assert.match(result.stdout, new RegExp(`ran:${name.replaceAll(".", "\\.")}`));
      assert.equal(result.stdout.split(`ran:${name}`).length - 1, 1, `${name} should run once`);
    }
    assert.doesNotMatch(result.stdout, /broad-(?:backend|frontend|system)/);
  }

  {
    const directory = await makeRepository("home-feature");
    git(directory, ["switch", "-c", "feature/home"]);
    await fs.writeFile(path.join(directory, "public/frontend/features/home/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "public/frontend/features/home/index.mjs"]);
    const result = invokeGate(directory, "feat(home): update home behavior");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ran:home-chat-citation-renderer-regression\.mjs/);
    assert.doesNotMatch(result.stdout, /broad-(?:backend|frontend|system)/);
  }

  {
    const directory = await makeRepository("context-source-feature");
    git(directory, ["switch", "-c", "feature/context-source"]);
    await fs.writeFile(path.join(directory, "public/frontend/features/personal-context/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "public/frontend/features/personal-context/index.mjs"]);
    const result = invokeGate(directory, "feat(basic-surfaces): preserve source navigation");
    assert.equal(result.status, 0, result.stderr);
    for (const name of [
      "frontend-basic-surfaces-feature-regression.mjs",
      "context-source-route-regression.mjs",
      "frontend-contract-regression.mjs",
      "frontend-shell-regression.mjs",
      "url-history-regression.mjs"
    ]) {
      assert.match(result.stdout, new RegExp(`ran:${name.replaceAll(".", "\\.")}`));
      assert.equal(result.stdout.split(`ran:${name}`).length - 1, 1, `${name} should run once`);
    }
    assert.doesNotMatch(result.stdout, /mobile-platform-regression|ui-regression|broad-(?:backend|frontend|system)/);
  }

  {
    const directory = await makeRepository("docs-only");
    git(directory, ["switch", "-c", "docs/task"]);
    await fs.writeFile(path.join(directory, "reports/task.md"), "# Task record\n");
    git(directory, ["add", "reports/task.md"]);
    const result = invokeGate(directory, "docs(task): record local delivery");
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(directory, ["show", "-s", "--format=%B", "HEAD"]).stdout, /Commit-Type: docs/);
  }

  {
    const directory = await makeRepository("docs-with-code");
    git(directory, ["switch", "-c", "docs/code"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const result = invokeGate(directory, "docs(actions): reject product code");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /documentation only/);
  }

  {
    const directory = await makeRepository("protected");
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const result = invokeGate(directory, "feat(actions): reject protected branch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /branch main is protected/);
  }

  {
    const directory = await makeRepository("non-task-branch");
    git(directory, ["switch", "-c", "archive/history"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const result = invokeGate(directory, "feat(actions): reject archive branch");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not an explicit task branch/);
  }

  {
    const directory = await makeRepository("risky");
    git(directory, ["switch", "-c", "feature/risky"]);
    await fs.mkdir(path.join(directory, "src/shared/persistence"), { recursive: true });
    await fs.writeFile(path.join(directory, "src/shared/persistence/risky.mjs"), "export const unsafe = true;\n");
    git(directory, ["add", "src/shared/persistence/risky.mjs"]);
    const result = invokeGate(directory, "feat(storage): reject risky persistence change");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shared, security-sensitive, migration/);
  }

  {
    const directory = await makeRepository("self-change");
    git(directory, ["switch", "-c", "feature/self-change"]);
    const fixtureGate = path.join(directory, "scripts/commit-gate.mjs");
    const trustedGate = await fs.readFile(fixtureGate);
    await fs.writeFile(fixtureGate, `${trustedGate.toString("utf8")}\n// staged policy change\n`);
    git(directory, ["add", "scripts/commit-gate.mjs"]);
    const result = invokeGate(directory, "feat(tooling): reject gate self change");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /differs from HEAD/);
  }

  {
    const directory = await makeRepository("governance");
    git(directory, ["switch", "-c", "feature/governance"]);
    await fs.writeFile(path.join(directory, "PROJECT_RULES.md"), "# Weakened rules\n");
    git(directory, ["add", "PROJECT_RULES.md"]);
    const result = invokeGate(directory, "feat(tooling): reject governance change");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shared, security-sensitive, migration/);
  }

  {
    const directory = await makeRepository("unstaged");
    git(directory, ["switch", "-c", "feature/unstaged"]);
    const file = path.join(directory, "src/modules/actions/index.mjs");
    await fs.writeFile(file, "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    await fs.appendFile(file, "export const later = true;\n");
    const result = invokeGate(directory, "feat(actions): reject split staged content");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /also have unstaged edits/);
  }

  {
    const directory = await makeRepository("failure", { failingCheck: true });
    git(directory, ["switch", "-c", "feature/failure"]);
    await fs.writeFile(path.join(directory, "src/modules/actions/index.mjs"), "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const before = git(directory, ["rev-parse", "HEAD"]).stdout.trim();
    const result = invokeGate(directory, "feat(actions): reject failed validation");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed/);
    assert.equal(git(directory, ["rev-parse", "HEAD"]).stdout.trim(), before);
  }

  {
    const directory = await makeRepository("drift", { delayedCheck: true });
    git(directory, ["switch", "-c", "feature/drift"]);
    const source = path.join(directory, "src/modules/actions/index.mjs");
    const marker = path.join(temporary, "drift-ready");
    await fs.writeFile(source, "export const value = 2;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const before = git(directory, ["rev-parse", "HEAD"]).stdout.trim();
    const child = spawn(process.execPath, [path.join(directory, "scripts/commit-gate.mjs"), "--message", "feat(actions): reject staged tree drift"], {
      cwd: directory,
      env: { ...process.env, GATE_DRIFT_MARKER: marker },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const completion = waitForExit(child);
    await waitForFile(marker);
    await fs.writeFile(source, "export const value = 3;\n");
    git(directory, ["add", "src/modules/actions/index.mjs"]);
    const result = await completion;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /staged tree changed/);
    assert.equal(git(directory, ["rev-parse", "HEAD"]).stdout.trim(), before);
  }

  console.log("Commit gate regression passed: feat/fix/test/docs commits, isolated candidates, protected/risky/self-integrity/partial rejection, failed tests, and staged-tree drift.");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
