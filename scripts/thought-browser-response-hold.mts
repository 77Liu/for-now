/**
 * 为阅读状态浏览器验收暂留一次隔离应用写入响应，服务端仍执行真实 PostgreSQL 写入。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只连接回环 Chrome 和应用；检查点不保存响应正文、Cookie 或凭据。
 */
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Socket = require("ws") as typeof WebSocket;
const [debugOrigin, appBase, method, checkpoint] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(debugOrigin || "")
  || !/^http:\/\/127\.0\.0\.1:\d+\/now$/u.test(appBase || "")
  || !["POST", "PATCH", "DELETE"].includes(method)
  || !/^\/tmp\/for-now-stage7-[\w-]+$/u.test(checkpoint || "")) {
  throw new Error("Response hold requires isolated Chrome/app and a stage7 temporary checkpoint");
}
const pages = await fetch(`${debugOrigin}/json/list`).then(response => response.json()) as {
  url: string;
  webSocketDebuggerUrl: string;
}[];
const page = pages.find(value => value.url.startsWith(`${appBase}/thoughts/`));
if (!page) throw new Error("Isolated thought detail page missing");
const socket = new Socket(page.webSocketDebuggerUrl);
const pending = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();
let serial = 0;
let held = "";
let finishing = false;
let timer: ReturnType<typeof setInterval> | undefined;

/** 向已连接的浏览器发出一个 CDP 命令；连接断开时拒绝等待。 @since unreleased */
function send(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: name, params }));
  });
}

async function receive(raw: string) {
  const value = JSON.parse(raw);
  if (value.id) {
    const callback = pending.get(value.id);
    pending.delete(value.id);
    if (value.error) callback?.reject(new Error(value.error.message));
    else callback?.resolve(value.result);
  }
  if (value.method !== "Fetch.requestPaused") return;
  const event = value.params;
  if (event.request.method === method && !held) {
    held = event.requestId;
    await fs.writeFile(`${checkpoint}-held.json`, JSON.stringify({
      method,
      status: event.responseStatusCode,
      path: new URL(event.request.url).pathname
    }));
  } else await send("Fetch.continueResponse", { requestId: event.requestId });
}

socket.addEventListener("message", event => {
  void receive(String(event.data)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    socket.close();
  });
});
socket.addEventListener("close", () => {
  clearInterval(timer);
  for (const callback of pending.values()) callback.reject(new Error("Response hold browser disconnected"));
  pending.clear();
});
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Response hold connection failed")), { once: true });
});
await send("Fetch.enable", { patterns: [{
  urlPattern: `${appBase}/api/thoughts/*/follow-ups*`,
  requestStage: "Response"
}] });
await fs.writeFile(`${checkpoint}-ready`, "ready");
const deadline = Date.now() + 120_000;
timer = setInterval(() => {
  void finishWhenRequested().catch(error => {
    clearInterval(timer);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    socket.close();
  });
}, 100);
async function finishWhenRequested() {
  const expired = Date.now() >= deadline;
  const released = await fs.stat(`${checkpoint}-release`).then(() => true, () => false);
  if (finishing || (!expired && (!held || !released))) return;
  finishing = true;
  clearInterval(timer);
  if (held) await send("Fetch.continueResponse", { requestId: held });
  await send("Fetch.disable");
  await fs.writeFile(`${checkpoint}-exit.json`, JSON.stringify({ held: Boolean(held), released, expired }));
  socket.close();
}
