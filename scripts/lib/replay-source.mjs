import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function verifyFrozenReplaySource(root, tree) {
  assert.match(tree, /^[a-f0-9]{40}$/);
  const manifest = execFileSync("git", ["ls-tree", "-rz", "--full-tree", tree], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const entries = manifest.split("\0").filter(Boolean).map(line => {
    const [metadata, relative] = line.split("\t"), [mode, type, blob] = metadata.split(" ");
    assert.equal(type, "blob"); assert.ok(relative && !relative.startsWith("/") && !relative.split("/").includes(".."));
    return { mode, blob, relative };
  });
  assert.ok(entries.some(entry => entry.relative === "scripts/personalization-live-replay.mjs"), "Tree does not contain the replay tool");
  for (let offset = 0; offset < entries.length; offset += 32) {
    await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
      const file = path.join(root, entry.relative), stat = await fs.lstat(file);
      const content = entry.mode === "120000" ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
      assert.ok(entry.mode === "120000" ? stat.isSymbolicLink() : stat.isFile(), `Source type drift: ${entry.relative}`);
      if (entry.mode !== "120000") assert.equal(Boolean(stat.mode & 0o111), entry.mode === "100755", `Source mode drift: ${entry.relative}`);
      const actual = crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
      assert.equal(actual, entry.blob, `Frozen source drift: ${entry.relative}`);
    }));
  }
  return { tree, fileCount: entries.length, manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex") };
}
