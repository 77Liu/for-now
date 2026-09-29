import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const portAvailable = port => new Promise(resolve => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});
async function choosePort() {
  if (process.env.LOCAL_TEST_PORT) return Number(process.env.LOCAL_TEST_PORT);
  for (let port = 4174; port <= 4199; port += 1) if (await portAvailable(port)) return port;
  throw new Error("4174-4199 没有可用的本地测试端口");
}
const port = await choosePort();
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: port,
    DATA_DIR: process.env.LOCAL_TEST_DATA_DIR || path.join(ROOT, "data", "local-test"),
    LOCAL_TEST_MODE: "1",
    AUTH_REQUIRED: "0",
    INVITE_CODE_HASH: "",
    COOKIE_SECURE: "0",
    ATTACHMENT_STORAGE: "local",
    UPSTREAM_ORIGIN: process.env.UPSTREAM_ORIGIN || "https://77liu.top/now"
  },
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

console.log(`Local test mode: http://127.0.0.1:${port}/`);
