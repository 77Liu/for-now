#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILES = 16;
const MAX_CHANGED_LINES = 1200;
const MAX_FILE_BYTES = 512 * 1024;
const PROTECTED_BRANCH = /^(?:main|master|production|release(?:\/|$)|hotfix(?:\/|$))/;
const TASK_BRANCH = /^(?:feat|feature|fix|test|docs)\//;
const ALLOWED_COMMIT_TYPES = new Set(["feat", "fix", "test", "docs"]);
const SECRET_ENV_KEY = /^(?:DATABASE_URL|AUTH_DATABASE_URL|PG_BACKUP_DATABASE_URL|PG_SCHEMA_DATABASE_URL|APP_URL|UPSTREAM_ORIGIN)$/;
const SECRET_ENV_PREFIX = /^(?:OSS_|ALIYUN_|ALIBABA_CLOUD_|DEEPSEEK_|FEISHU_|VOLCENGINE_)/;

const moduleScopes = new Map([
  ["actions", "actions"],
  ["books", "library"],
  ["captures", "captures-journals"],
  ["chats", "reviews-chat"],
  ["checkins", "records"],
  ["discovery", "discovery"],
  ["health", "records"],
  ["journals", "captures-journals"],
  ["keepsakes", "keepsakes"],
  ["onboarding", "onboarding"],
  ["quotes", "library"],
  ["reviews", "reviews-chat"],
  ["statistics", "reviews-chat"],
  ["thoughts", "thoughts"]
]);

const frontendScopes = new Map([
  ["actions", "actions"],
  ["home", "home"],
  ["keepsakes-media", "keepsakes"],
  ["thought-discovery", "discovery"]
]);

const allFrontendScopes = [...new Set(frontendScopes.values())];
const regressionScopes = new Map([
  ["capture-journal-regression.mjs", ["captures-journals"]],
  ["checkin-health-regression.mjs", ["records"]],
  ["frontend-contract-regression.mjs", allFrontendScopes],
  ["frontend-shell-regression.mjs", allFrontendScopes],
  ["g2-a-r2-regression.mjs", ["thoughts"]],
  ["g2-actions-regression.mjs", ["actions"]],
  ["g2-discovery-regression.mjs", ["discovery"]],
  ["keepsake-media-workflows-regression.mjs", ["keepsakes"]],
  ["keepsake-time-regression.mjs", ["keepsakes"]],
  ["library-regression.mjs", ["library"]],
  ["mobile-platform-regression.mjs", allFrontendScopes],
  ["personal-context-regression.mjs", ["onboarding"]],
  ["record-v1-regression.mjs", ["records"]],
  ["reviews-chat-regression.mjs", ["reviews-chat"]],
  ["thought-service-regression.mjs", ["thoughts"]],
  ["ui-regression.mjs", allFrontendScopes]
]);

function fail(message) {
  process.stderr.write(`commit gate rejected: ${message}\n`);
  process.exit(1);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio || ["pipe", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${commandName} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function git(args, options = {}) {
  return command("git", args, options);
}

function parseArguments(argv) {
  let dryRun = false;
  let message = "";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--message" || value === "-m") {
      message = argv[index + 1] || "";
      index += 1;
    } else if (value === "--help" || value === "-h") {
      process.stdout.write("Usage: npm run commit:task -- --message \"<feat|fix|test|docs>(scope): summary\" [--dry-run]\n");
      process.exit(0);
    } else {
      fail(`unknown argument ${JSON.stringify(value)}`);
    }
  }
  return { dryRun, message };
}

function validateMessage(message) {
  if (!message) fail("use --message to provide a Conventional Commit subject");
  if (/[\r\n]/.test(message)) fail("the subject must be a single line");
  const match = /^(feat|fix|test|docs)(?:\(([a-z0-9][a-z0-9._/-]*)\))?: (\S.+)$/u.exec(message);
  if (!match || !ALLOWED_COMMIT_TYPES.has(match[1])) {
    fail("the subject must use feat, fix, test, or docs");
  }
  if ([...message].length > 72) fail("the subject must not exceed 72 characters");
  return { type: match[1], scope: match[2] || "" };
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function isDocumentation(file) {
  return (
    /^(?:README(?:-TODO)?|one-mistake-one-rule)\.md$/.test(file)
    || /^(?:knowledge|reports)\/.+\.md$/.test(file)
  );
}

function blockedReason(file) {
  const lower = file.toLowerCase();
  if (
    /(^|\/)\.env(?:\.|$)/.test(lower)
    || /(^|\/)(?:data|logs?|secrets?|credentials?|private)(\/|$)/.test(lower)
    || /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|dump|log)$/i.test(file)
  ) return "sensitive, runtime, or private data";
  if (
    file === ".gitmodules"
    || file === "package.json"
    || file === "package-lock.json"
    || file === "server.mjs"
    || file === "admin-snapshot.mjs"
    || file === "PROJECT_RULES.md"
    || file === "knowledge/engineering-rules.md"
    || file === "knowledge/pre-launch-confirmation.md"
    || file === "knowledge/development-release-checklist.md"
    || /^(?:deploy|prompts)\//.test(file)
    || /^src\/(?:app|config|http|infrastructure|shared)\//.test(file)
    || /^src\/modules\/(?:ai|annotations|auth|content-attachments|exports|feedback|notifications|tasks|trash)\//.test(file)
    || /^public\/(?:app\.js|index\.html|styles\.css|manifest\.webmanifest|assets|vendor)(?:\/|$)/.test(file)
    || /^public\/frontend\/(?:api|app|content|media|pages|session|state|styles|time)(?:\/|$)/.test(file)
    || file === "public/frontend/features/index.mjs"
    || /^scripts\/commit-gate(?:-regression)?\.mjs$/.test(file)
    || /^scripts\/(?:aliyun|deploy|export-postgres|exploration|load|local-test-preview|migrate|monitor-health|oss|postgres|restore|stage-backup|system-test|validate-restored-data)/.test(file)
    || /^(?:\.github|\.gitee)\//.test(file)
  ) return "shared, security-sensitive, migration, dependency, deployment, or release surface";
  if (
    /^public\/explore/.test(file)
    || /^reports\/(?:exploration|feature-atlas)/.test(file)
  ) return "exploration assets are outside the automatic feat gate";
  return "";
}

function classifyPath(file) {
  const blocked = blockedReason(file);
  if (blocked) return { kind: "blocked", reason: blocked };
  if (isDocumentation(file)) return { kind: "documentation" };

  const moduleMatch = /^src\/modules\/([^/]+)\//.exec(file);
  if (moduleMatch && moduleScopes.has(moduleMatch[1])) {
    return { kind: "product", scope: moduleScopes.get(moduleMatch[1]), surface: "backend" };
  }

  const frontendMatch = /^public\/frontend\/features\/([^/]+)\//.exec(file);
  if (frontendMatch && frontendScopes.has(frontendMatch[1])) {
    return { kind: "product", scope: frontendScopes.get(frontendMatch[1]), surface: "frontend" };
  }

  const regressionMatch = /^scripts\/([^/]+-regression\.mjs)$/.exec(file);
  if (regressionMatch && regressionScopes.has(regressionMatch[1])) {
    const name = regressionMatch[1];
    const surface = /^(?:frontend|mobile-platform|ui)-/.test(name) ? "frontend" : "backend";
    return { kind: "test", scopes: regressionScopes.get(name), surface };
  }

  return { kind: "blocked", reason: "path is outside the explicit low-risk allowlist" };
}

function validateModesAndSizes(root, stagedPaths) {
  const entries = splitNull(git(["ls-files", "-s", "-z", "--", ...stagedPaths], { cwd: root }).stdout);
  for (const entry of entries) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(entry);
    if (!match) fail(`cannot inspect staged entry ${JSON.stringify(entry)}`);
    const [, mode, object, file] = match;
    if (!["100644", "100755"].includes(mode)) fail(`${file} uses disallowed mode ${mode}`);
    const size = Number(git(["cat-file", "-s", object], { cwd: root }).stdout.trim());
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {
      fail(`${file} exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
  }
}

function validateDiffSize(root) {
  const records = splitNull(git(["diff", "--cached", "--numstat", "--no-renames", "-z"], { cwd: root }).stdout);
  let changedLines = 0;
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    if (added === "-" || deleted === "-") fail("binary changes require manual commit approval");
    changedLines += Number(added) + Number(deleted);
  }
  if (!Number.isSafeInteger(changedLines) || changedLines > MAX_CHANGED_LINES) {
    fail(`staged diff has ${changedLines} changed lines; automatic limit is ${MAX_CHANGED_LINES}`);
  }
  return changedLines;
}

function validateSecretDiff(root) {
  const patch = git(["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff"], { cwd: root }).stdout;
  const additions = patch.split("\n")
    .filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .map(line => line.slice(1))
    .join("\n");
  const signatures = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bLTAI[A-Za-z0-9]{12,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{24,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/
  ];
  if (signatures.some(pattern => pattern.test(additions))) {
    fail("staged additions contain a credential-like value");
  }
}

function activeOperation(root) {
  const gitPath = relative => {
    const value = git(["rev-parse", "--git-path", relative], { cwd: root }).stdout.trim();
    return path.resolve(root, value);
  };
  return [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply"
  ].find(name => {
    try {
      return existsSync(gitPath(name));
    } catch {
      return false;
    }
  });
}

async function validateHooks(root) {
  const hooksValue = git(["rev-parse", "--git-path", "hooks"], { cwd: root }).stdout.trim();
  const hooksDir = path.resolve(root, hooksValue);
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    try {
      const stat = await fs.stat(path.join(hooksDir, name));
      if (stat.isFile() && (stat.mode & 0o111)) {
        fail(`active ${name} hook requires a normal manually authorized commit`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function validateTrustedGate(root) {
  const script = path.resolve(fileURLToPath(import.meta.url));
  const expected = path.join(root, "scripts/commit-gate.mjs");
  if (script !== expected) fail("the gate must run from this repository's scripts/commit-gate.mjs");
  const committed = git(["rev-parse", "HEAD:scripts/commit-gate.mjs"], { cwd: root, allowFailure: true });
  if (committed.status !== 0) fail("the gate must first be added by an explicitly authorized manual commit");
  const working = git(["hash-object", script], { cwd: root }).stdout.trim();
  if (working !== committed.stdout.trim()) {
    fail("scripts/commit-gate.mjs differs from HEAD and requires manual review");
  }
}

function isolatedEnvironment(source) {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => (
    !SECRET_ENV_KEY.test(key) && !SECRET_ENV_PREFIX.test(key)
  )));
  return {
    ...environment,
    NODE_ENV: "test",
    PERSISTENCE_BACKEND: "json",
    ATTACHMENT_STORAGE: "local",
    UPSTREAM_ORIGIN: ""
  };
}

function runNpmScript(candidate, script) {
  const npmCli = process.env.npm_execpath;
  const executable = npmCli ? process.execPath : "npm";
  const args = npmCli ? [npmCli, "run", script] : ["run", script];
  process.stdout.write(`\n[commit-gate] npm run ${script}\n`);
  command(executable, args, {
    cwd: candidate,
    env: isolatedEnvironment(process.env),
    stdio: "inherit"
  });
}

async function validateCandidate(root, tree, scripts) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-commit-gate-"));
  const archive = path.join(temporary, "candidate.tar");
  const candidate = path.join(temporary, "candidate");
  try {
    await fs.mkdir(candidate);
    git(["archive", "--format=tar", `--output=${archive}`, tree], { cwd: root });
    command("tar", ["-xf", archive, "-C", candidate]);
    try {
      const modules = path.join(root, "node_modules");
      if ((await fs.stat(modules)).isDirectory()) {
        await fs.symlink(modules, path.join(candidate, "node_modules"), "dir");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const script of scripts) runNpmScript(candidate, script);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function selectValidation(classifications, subject) {
  const products = classifications.filter(item => item.classification.kind === "product");
  const tests = classifications.filter(item => item.classification.kind === "test");
  const documentation = classifications.filter(item => item.classification.kind === "documentation");

  if (subject.type === "docs") {
    if (documentation.length !== classifications.length) {
      fail("a docs commit may contain documentation only");
    }
    return { scope: subject.scope || "documentation", scripts: [] };
  }

  if (subject.type === "test") {
    if (products.length) fail("a test commit may not contain product implementation changes");
    if (!tests.length) fail("a test commit must include an allowed regression file");
    if (!subject.scope) fail("a test commit must declare its feature scope");
    for (const item of tests) {
      if (!item.classification.scopes.includes(subject.scope)) {
        fail(`${item.file} does not test the declared ${subject.scope} scope`);
      }
    }
    const backend = tests.some(item => item.classification.surface === "backend");
    const frontend = tests.some(item => item.classification.surface === "frontend");
    return {
      scope: subject.scope,
      scripts: ["check", backend && frontend ? "test:system" : backend ? "test:backend" : "test:frontend"]
    };
  }

  const scopes = unique(products.map(item => item.classification.scope));
  if (scopes.length === 0) fail(`${subject.type} commits must include an allowed product change`);
  if (scopes.length > 1) fail(`staged paths span multiple feature scopes: ${scopes.join(", ")}`);

  const scope = scopes[0];
  if (subject.scope && subject.scope !== scope) {
    fail(`commit scope ${subject.scope} does not match staged ${scope} feature scope`);
  }
  for (const item of classifications.filter(entry => entry.classification.kind === "test")) {
    const accepted = item.classification.scopes.includes(scope);
    if (!accepted) fail(`${item.file} does not test the staged ${scope} feature scope`);
  }

  const backend = products.some(item => item.classification.surface === "backend");
  const frontend = products.some(item => item.classification.surface === "frontend");
  return {
    scope,
    scripts: ["check", backend && frontend ? "test:system" : backend ? "test:backend" : "test:frontend"]
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const subject = validateMessage(options.message);

  const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).stdout.trim();
  validateTrustedGate(root);
  const branch = git(["branch", "--show-current"], { cwd: root }).stdout.trim();
  if (!branch) fail("detached HEAD is not eligible for automatic commits");
  if (PROTECTED_BRANCH.test(branch)) fail(`branch ${branch} is protected`);
  if (!TASK_BRANCH.test(branch)) fail(`branch ${branch} is not an explicit task branch`);

  const operation = activeOperation(root);
  if (operation) fail(`Git operation ${operation} is still active`);
  await validateHooks(root);

  const conflicts = splitNull(git(["diff", "--cached", "--name-only", "--diff-filter=U", "-z"], { cwd: root }).stdout);
  if (conflicts.length) fail(`unmerged paths remain: ${conflicts.join(", ")}`);

  const stagedPaths = unique(splitNull(
    git(["diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd: root }).stdout
  ));
  if (!stagedPaths.length) fail("the index is empty");
  if (stagedPaths.length > MAX_FILES) fail(`staged file count ${stagedPaths.length} exceeds limit ${MAX_FILES}`);

  const unstagedOnStagedPaths = splitNull(
    git(["diff", "--name-only", "--no-renames", "-z", "--", ...stagedPaths], { cwd: root }).stdout
  );
  if (unstagedOnStagedPaths.length) {
    fail(`staged paths also have unstaged edits: ${unstagedOnStagedPaths.join(", ")}`);
  }

  const classifications = stagedPaths.map(file => ({ file, classification: classifyPath(file) }));
  const rejected = classifications.filter(item => item.classification.kind === "blocked");
  if (rejected.length) {
    fail(rejected.map(item => `${item.file} (${item.classification.reason})`).join("; "));
  }

  validateModesAndSizes(root, stagedPaths);
  git(["diff", "--cached", "--check"], { cwd: root });
  const changedLines = validateDiffSize(root);
  validateSecretDiff(root);
  const validation = selectValidation(classifications, subject);

  const head = git(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  const ref = git(["symbolic-ref", "-q", "HEAD"], { cwd: root }).stdout.trim();
  const tree = git(["write-tree"], { cwd: root }).stdout.trim();
  process.stdout.write(
    `[commit-gate] branch=${branch} scope=${validation.scope} files=${stagedPaths.length} lines=${changedLines} tree=${tree}\n`
  );
  process.stdout.write(`[commit-gate] staged paths:\n${stagedPaths.map(file => `  ${file}`).join("\n")}\n`);

  await validateCandidate(root, tree, validation.scripts);

  const currentHead = git(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  const currentRef = git(["symbolic-ref", "-q", "HEAD"], { cwd: root }).stdout.trim();
  const currentTree = git(["write-tree"], { cwd: root }).stdout.trim();
  if (currentHead !== head || currentRef !== ref || currentTree !== tree) {
    fail("HEAD, branch, or staged tree changed while validation was running");
  }
  const postTestUnstaged = splitNull(
    git(["diff", "--name-only", "--no-renames", "-z", "--", ...stagedPaths], { cwd: root }).stdout
  );
  if (postTestUnstaged.length) fail(`tested paths changed during validation: ${postTestUnstaged.join(", ")}`);

  if (options.dryRun) {
    process.stdout.write(`[commit-gate] dry run passed; no commit created for tree ${tree}\n`);
    return;
  }

  const commitMessage = [
    options.message,
    "",
    `Validation-Tree: ${tree}`,
    `Validation-Commands: ${validation.scripts.map(script => `npm run ${script}`).join("; ")}`,
    `Commit-Type: ${subject.type}`,
    "Commit-Gate: local-task-v2"
  ].join("\n");
  const commitArgs = ["commit-tree", tree, "-p", head];
  if (git(["config", "--bool", "commit.gpgSign"], { cwd: root, allowFailure: true }).stdout.trim() === "true") {
    commitArgs.push("-S");
  }
  const commit = git(commitArgs, { cwd: root, input: `${commitMessage}\n` }).stdout.trim();
  git(["update-ref", "-m", `commit (commit-gate): ${options.message}`, ref, commit, head], { cwd: root });

  const committedTree = git(["rev-parse", `${commit}^{tree}`], { cwd: root }).stdout.trim();
  if (committedTree !== tree) fail(`created commit ${commit} does not match validated tree ${tree}`);
  process.stdout.write(`[commit-gate] created local commit ${commit}\n`);
  process.stdout.write("[commit-gate] no push, tag, release, deployment, or production write was performed\n");
}

main().catch(error => fail(error.message));
