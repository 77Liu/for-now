import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { verifyFrozenReplaySource } from "./lib/replay-source.mjs";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "replay-source-test-"));
const git = args => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
try {
  git(["init", "--quiet"]); await fs.mkdir(path.join(temporary, "scripts"));
  const tool = path.join(temporary, "scripts/personalization-live-replay.mjs");
  await fs.writeFile(tool, "// frozen fixture\n", { mode: 0o644 });
  await fs.symlink("personalization-live-replay.mjs", path.join(temporary, "scripts/link.mjs"));
  git(["add", "scripts"]); const tree = git(["write-tree"]);
  assert.equal((await verifyFrozenReplaySource(temporary, tree)).fileCount, 2);
  await fs.chmod(tool, 0o755); await assert.rejects(verifyFrozenReplaySource(temporary, tree), /Source mode drift/);
  await fs.chmod(tool, 0o644); await fs.writeFile(tool, "// changed\n");
  await assert.rejects(verifyFrozenReplaySource(temporary, tree), /Frozen source drift/);
  await assert.rejects(verifyFrozenReplaySource(temporary, "a".repeat(40)));
  console.log("Replay frozen source passed: full blob, mode and symlink identity; changed files and forged trees rejected.");
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
