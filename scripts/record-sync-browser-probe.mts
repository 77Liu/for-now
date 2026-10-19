/**
 * Keeps an isolated PostgreSQL application alive for real-browser v2 sync checks.
 * Created: 2026-10-19
 * Status: active
 */
import { promises as fs } from "node:fs";

export async function holdRecordSyncBrowserProbe({
  base,
  username
}: {
  base: string;
  username: string;
}): Promise<void> {
  const output = process.env.RECORD_SYNC_BROWSER_PROBE;
  if (!output) return;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/now$/u.test(base)) {
    throw new Error("Record sync browser probe requires an isolated loopback app");
  }
  const deadline = Date.now() + 30 * 60 * 1000;
  await fs.writeFile(output, JSON.stringify({
    base,
    username,
    mode: "isolated-record-sync-v2"
  }), { mode: 0o600, flag: "wx" });
  while (Date.now() < deadline) {
    if (await fs.stat(`${output}.continue`).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Isolated record sync browser probe timed out");
}
