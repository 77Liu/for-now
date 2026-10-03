import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function prepareTestNodeBinary(workspace) {
  if (process.platform !== "darwin") return process.execPath;
  const copy = path.join(workspace, "node-adhoc");
  await fs.copyFile(process.execPath, copy);
  await fs.chmod(copy, 0o755);
  await execFile("/usr/bin/codesign", ["--force", "--sign", "-", copy]);
  return copy;
}
