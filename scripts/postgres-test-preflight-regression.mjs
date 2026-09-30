import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preflight = path.join(root, "scripts/postgres-test-preflight.mjs");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-postgres-preflight-"));

function invoke(binDirectory) {
  return spawnSync(process.execPath, [preflight, "--json"], {
    cwd: root,
    env: { ...process.env, PG_TEST_BIN: binDirectory },
    encoding: "utf8"
  });
}

async function createBin(name, version, omitted = "") {
  const directory = path.join(temporary, name);
  await fs.mkdir(directory, { recursive: true });
  for (const binary of ["postgres", "initdb", "pg_ctl"]) {
    if (binary === omitted) continue;
    const file = path.join(directory, binary);
    await fs.writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${binary} (PostgreSQL) ${version}'\n`);
    await fs.chmod(file, 0o755);
  }
  return directory;
}

try {
  const valid = await createBin("valid", "16.14");
  const validResult = invoke(valid);
  assert.equal(validResult.status, 0, validResult.stderr);
  const output = JSON.parse(validResult.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.pgTestBin, valid);
  assert.match(output.version, /PostgreSQL\) 16\.14/);

  const wrongVersion = await createBin("wrong-version", "15.9");
  const wrongVersionResult = invoke(wrongVersion);
  assert.equal(wrongVersionResult.status, 1);
  assert.match(wrongVersionResult.stderr, /expected PostgreSQL 16/);

  const incomplete = await createBin("incomplete", "16.14", "pg_ctl");
  const incompleteResult = invoke(incomplete);
  assert.equal(incompleteResult.status, 1);
  assert.match(incompleteResult.stderr, /missing executable: pg_ctl/);

  console.log("PostgreSQL preflight regression passed: valid, wrong-version, and incomplete toolchains.");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
