import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "growth-backup-")));
const source = await fs.readFile(path.join(root, "deploy/backup-to-oss.sh"), "utf8");
const scenarios = ["delayed-ready", "ready-timeout", "upload-failure", "archive-failure", "stop-failure", "inactive"];

try {
  for (const scenario of scenarios) {
    const dir = path.join(fixture, scenario);
    const bin = path.join(dir, "bin");
    const marker = path.join(dir, "var/lib/for-now-monitor/last-backup-success");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(dir, "run/lock"), { recursive: true });
    await fs.mkdir(path.join(dir, "etc"), { recursive: true });
    await fs.mkdir(path.join(dir, "data"), { recursive: true });
    await fs.mkdir(path.join(dir, "usr/local/bin"), { recursive: true });
    const failedScenario = ["ready-timeout", "upload-failure", "archive-failure", "stop-failure"].includes(scenario);
    let previousMarkerMtime = 0;
    if (failedScenario) {
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, "previous-success\n");
      const previousMarkerTime = new Date("2026-01-01T00:00:00.000Z");
      await fs.utimes(marker, previousMarkerTime, previousMarkerTime);
      previousMarkerMtime = (await fs.stat(marker)).mtimeMs;
    }
    await fs.writeFile(path.join(dir, "etc/for-now.env"), [
      `DATA_DIR=${path.join(dir, "data")}`,
      "PERSISTENCE_BACKEND=json",
      "ATTACHMENT_STORAGE=local",
      "OSS_DESTINATION=oss://fixture/backups",
      "OSS_ENDPOINT=https://oss-fixture.invalid",
      "OSS_REGION=fixture-region",
      `BACKUP_READY_TIMEOUT_SECONDS=${scenario === "delayed-ready" ? 4 : 2}`,
      ""
    ].join("\n"));

    const shim = path.join(bin, "shim.mjs");
    await fs.writeFile(shim, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const dir = process.env.BACKUP_FIXTURE;
const scenario = process.env.BACKUP_SCENARIO;
const stateFile = path.join(dir, "state.json");
const state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
  : { curls: 0, uploads: 0, starts: 0, failureSeen: false };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
fs.appendFileSync(path.join(dir, "commands.log"), name + " " + args.join(" ") + "\\n");

if (name === "flock") process.exit(0);
if (name === "systemctl") {
  if (args[0] === "is-active") process.exit(scenario === "inactive" ? 3 : 0);
  if (args[0] === "stop" && scenario === "stop-failure") {
    state.failureSeen = true;
    save();
    process.exit(13);
  }
  if (args[0] === "start") {
    state.starts += 1;
    save();
    if (state.failureSeen || (scenario === "ready-timeout" && state.curls >= 2)) process.exit(29);
  }
  process.exit(0);
}
if (name === "node") {
  const outputIndex = args.indexOf("--output-dir");
  const output = args[outputIndex + 1];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "fixture.json"), "{}\\n");
  process.exit(0);
}
if (name === "tar") {
  if (scenario === "archive-failure") {
    state.failureSeen = true;
    save();
    process.exit(23);
  }
  const archive = args[args.indexOf("-czf") + 1];
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "archive");
  process.exit(0);
}
if (name === "sha256sum") {
  console.log("fixture-sha256  " + args[0]);
  process.exit(0);
}
if (name === "curl") {
  state.curls += 1;
  save();
  if (scenario === "ready-timeout" || (scenario === "delayed-ready" && state.curls < 3)) process.exit(22);
  process.exit(0);
}
if (name === "ossutil") {
  state.uploads += 1;
  if (scenario === "upload-failure" && state.uploads === 1) {
    state.failureSeen = true;
    save();
    process.exit(17);
  }
  save();
  process.exit(0);
}
if (name === "install") {
  if (args.includes("-d")) fs.mkdirSync(args.at(-1), { recursive: true });
  process.exit(0);
}
if (name === "touch") {
  fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true });
  fs.closeSync(fs.openSync(args.at(-1), "a"));
  process.exit(0);
}
if (name === "mv") {
  fs.renameSync(args.at(-2), args.at(-1));
  process.exit(0);
}
if (name === "chown" || name === "chmod" || name === "find") process.exit(0);
`, { mode: 0o755 });

    for (const command of [
      "flock", "systemctl", "tar", "sha256sum", "curl", "ossutil",
      "install", "touch", "mv", "chown", "chmod", "find"
    ]) {
      await fs.symlink(shim, path.join(bin, command));
    }
    await fs.symlink(shim, path.join(dir, "usr/local/bin/node"));

    let script = source;
    for (const [from, to] of [
      ["/run/lock/", `${dir}/run/lock/`],
      ["/etc/for-now.env", `${dir}/etc/for-now.env`],
      ["/var/backups/for-now", `${dir}/var/backups/for-now`],
      ["/var/lib/for-now-monitor", `${dir}/var/lib/for-now-monitor`],
      ["/usr/local/bin/node", `${dir}/usr/local/bin/node`],
      ["/opt/for-now/app", `${dir}/opt/for-now/app`]
    ]) {
      script = script.replaceAll(from, to);
    }
    const scriptFile = path.join(dir, "backup-to-oss.sh");
    await fs.writeFile(scriptFile, script, { mode: 0o755 });

    const result = spawnSync("/bin/bash", [scriptFile], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        BACKUP_FIXTURE: dir,
        BACKUP_SCENARIO: scenario
      },
      encoding: "utf8",
      timeout: 15000
    });
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    const commands = (await fs.readFile(path.join(dir, "commands.log"), "utf8")).trim().split("\n");
    const markerExists = await fs.access(marker).then(() => true, () => false);
    const markerContent = markerExists ? await fs.readFile(marker, "utf8") : "";
    const markerMtime = markerExists ? (await fs.stat(marker)).mtimeMs : 0;
    const markerWriteIndex = commands.findIndex(command => (
      command === `touch ${marker}` || command.endsWith(` ${marker}`)
    ));
    const lastUploadIndex = commands.findLastIndex(command => command.startsWith("ossutil cp "));
    const lastCurlIndex = commands.findLastIndex(command => command.startsWith("curl "));
    const lastStartIndex = commands.findLastIndex(command => command === "systemctl start for-now.service");
    const lastStopIndex = commands.findLastIndex(command => command === "systemctl stop for-now.service");

    if (scenario === "delayed-ready") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(state.curls, 3);
      assert.equal(state.uploads, 2);
      assert.equal(state.starts, 1);
      assert.equal(markerExists, true);
      assert.ok(markerWriteIndex > lastCurlIndex, "success marker must follow service readiness");
      assert.ok(markerWriteIndex > lastUploadIndex, "success marker must follow both OSS uploads");
    } else if (scenario === "ready-timeout") {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /did not become ready within 2 seconds/);
      assert.ok(state.curls >= 1 && state.curls <= 2, "readiness attempts must stay within the timeout");
      assert.equal(state.uploads, 0);
      assert.equal(state.starts, 2, "timeout must trigger a second recovery attempt");
      assert.equal(markerContent, "previous-success\n");
      assert.equal(markerMtime, previousMarkerMtime);
    } else if (scenario === "upload-failure") {
      assert.equal(result.status, 17, result.stderr);
      assert.equal(state.uploads, 1);
      assert.ok(lastStartIndex > lastUploadIndex, "upload failure must trigger service recovery");
      assert.equal(markerContent, "previous-success\n");
      assert.equal(markerMtime, previousMarkerMtime);
    } else if (scenario === "archive-failure") {
      const archiveIndex = commands.findIndex(command => command.startsWith("tar "));
      assert.equal(result.status, 23, result.stderr);
      assert.ok(lastStartIndex > archiveIndex, "archive failure must trigger service recovery");
      assert.equal(state.uploads, 0);
      assert.equal(markerContent, "previous-success\n");
      assert.equal(markerMtime, previousMarkerMtime);
    } else if (scenario === "stop-failure") {
      assert.equal(result.status, 13, result.stderr);
      assert.ok(lastStartIndex > lastStopIndex, "stop failure must trigger service recovery");
      assert.equal(state.uploads, 0);
      assert.equal(markerContent, "previous-success\n");
      assert.equal(markerMtime, previousMarkerMtime);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(state.curls, 0);
      assert.equal(state.uploads, 2);
      assert.equal(state.starts, 0);
      assert.equal(commands.some(command => command === "systemctl stop for-now.service"), false);
      assert.equal(markerExists, true);
      assert.ok(markerWriteIndex > lastUploadIndex);
    }
  }
  console.log("Backup checks passed: delayed readiness, bounded timeout, stop/upload/archive recovery, original exit codes, success marker ordering, and inactive-service preservation.");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
