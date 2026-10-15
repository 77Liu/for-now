import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`Refusing unsafe Fontconfig cache directory: ${directory}`), {
      code: "FONTCONFIG_CACHE_UNSAFE"
    });
  }
  await fs.chmod(directory, 0o700);
}

export async function prepareFontconfigCache({
  dataDir = process.env.DATA_DIR || "data",
  env = process.env
} = {}) {
  const cacheHome = path.join(path.resolve(PROJECT_ROOT, dataDir), "cache");
  const fontconfigDir = path.join(cacheHome, "fontconfig");
  await ensurePrivateDirectory(cacheHome);
  await ensurePrivateDirectory(fontconfigDir);
  env.XDG_CACHE_HOME = cacheHome;
  return Object.freeze({ cacheHome, fontconfigDir });
}
