import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveHeadlessBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    path.join(os.homedir(), ".local/share/for-now-browser/current/chrome-headless-shell"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  const executable = candidates.find(candidate => candidate && existsSync(candidate));
  if (!executable) {
    throw new Error("No headless browser found. Set CHROME_BIN or install the shared for-now browser runtime.");
  }
  return executable;
}
