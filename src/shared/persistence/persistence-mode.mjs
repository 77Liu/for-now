import { promises as fs } from "node:fs";
import path from "node:path";

export async function checkPersistenceMarker(dataDir, mode) {
  let marker;
  try { marker = JSON.parse(await fs.readFile(path.join(dataDir, ".persistence-mode.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (marker && marker.backend !== mode) {
    throw new Error("Data directory has switched persistence backend; restore and verify a fresh directory before rollback");
  }
}

export async function markPostgresDirectory(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, ".persistence-mode.json");
  try { await fs.writeFile(file, `${JSON.stringify({ backend: "postgres" })}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

export async function hasJsonData(dataDir) {
  for (const name of ["auth.json", "store.json", "llm-settings.json", "ai-usage.json", "ai-cost-plan.json"]) {
    try { await fs.access(path.join(dataDir, name)); return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try {
    const users = await fs.readdir(path.join(dataDir, "users"));
    for (const user of users) if (await hasJsonData(path.join(dataDir, "users", user))) return true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return false;
}
