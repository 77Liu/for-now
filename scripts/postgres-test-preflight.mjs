#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareTestNodeBinary } from "./test-node-binary.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requiredBinaries = ["postgres", "initdb", "pg_ctl"];
const expectedMajor = 16;

function fail(message, diagnostics = []) {
  process.stderr.write(`PostgreSQL test preflight failed: ${message}\n`);
  for (const diagnostic of diagnostics) {
    process.stderr.write(`- ${diagnostic}\n`);
  }
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || `exit ${result.status}`).trim()
    };
  }
  return { ok: true, output: (result.stdout || result.stderr || "").trim() };
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(value => path.resolve(root, value)))];
}

async function inspectCandidate(binDirectory) {
  const missing = [];
  for (const binary of requiredBinaries) {
    const file = path.join(binDirectory, binary);
    try {
      await fs.access(file, fsConstants.X_OK);
    } catch {
      missing.push(binary);
    }
  }
  if (missing.length) {
    return { ok: false, binDirectory, reason: `missing executable: ${missing.join(", ")}` };
  }

  const versionResult = run(path.join(binDirectory, "postgres"), ["--version"]);
  if (!versionResult.ok) {
    return { ok: false, binDirectory, reason: versionResult.detail };
  }
  const match = /PostgreSQL\)\s+(\d+)(?:\.(\d+))?/u.exec(versionResult.output);
  if (!match || Number(match[1]) !== expectedMajor) {
    return {
      ok: false,
      binDirectory,
      reason: `expected PostgreSQL ${expectedMajor}, received ${versionResult.output || "unknown version"}`
    };
  }
  return {
    ok: true,
    binDirectory,
    version: versionResult.output
  };
}

function parseArguments(argv) {
  const unknown = argv.filter(value => value !== "--run" && value !== "--json");
  if (unknown.length) fail(`unknown argument ${JSON.stringify(unknown[0])}`);
  return {
    runTests: argv.includes("--run"),
    json: argv.includes("--json")
  };
}

const options = parseArguments(process.argv.slice(2));
const explicit = process.env.PG_TEST_BIN?.trim();
const candidates = unique(explicit
  ? [explicit]
  : [
      path.join(root, "data/pg-integration-tools/postgresql-16.14/bin"),
      "/tmp/for-now-postgresql-16.14/bin",
      path.join(
        root,
        "data/pg-integration-tools/node_modules/@embedded-postgres",
        `${process.platform}-${process.arch}`,
        "native/bin"
      )
    ]);

const diagnostics = [];
let selected = null;
for (const candidate of candidates) {
  const result = await inspectCandidate(candidate);
  if (result.ok) {
    selected = result;
    break;
  }
  diagnostics.push(`${candidate}: ${result.reason}`);
}

if (!selected) {
  fail("no usable PostgreSQL 16 binary directory was found", diagnostics);
}

const summary = {
  ok: true,
  pgTestBin: selected.binDirectory,
  version: selected.version,
  source: explicit ? "PG_TEST_BIN" : "project-candidate",
  testsStarted: options.runTests
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(`[postgres-preflight] ${selected.version}\n`);
  process.stdout.write(`[postgres-preflight] PG_TEST_BIN=${selected.binDirectory}\n`);
}

if (options.runTests) {
  const npmCli = process.env.npm_execpath;
  let testNodeWorkspace;
  try {
    testNodeWorkspace = npmCli
      ? await fs.mkdtemp(path.join(os.tmpdir(), "for-now-postgres-test-node-"))
      : null;
    const executable = npmCli
      ? await prepareTestNodeBinary(testNodeWorkspace)
      : "npm";
    if (testNodeWorkspace) {
      await fs.symlink(path.basename(executable), path.join(testNodeWorkspace, "node"));
    }
    const args = npmCli ? [npmCli, "run", "test:postgres"] : ["run", "test:postgres"];
    const result = spawnSync(executable, args, {
      cwd: root,
      env: {
        ...process.env,
        PG_TEST_BIN: selected.binDirectory,
        ...(testNodeWorkspace
          ? { PATH: `${testNodeWorkspace}${path.delimiter}${process.env.PATH || ""}` }
          : {})
      },
      stdio: "inherit"
    });
    if (result.error) fail(result.error.message);
    process.exitCode = result.status ?? 1;
  } finally {
    if (testNodeWorkspace) await fs.rm(testNodeWorkspace, { recursive: true, force: true });
  }
}
