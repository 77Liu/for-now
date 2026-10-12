import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public/generated/personalized-ai-task.mjs");
const legacyDestination = path.join(root, "public/frontend/shared/personalized-ai-task.mjs");

await fs.access(source);
const emitted = await fs.readFile(source, "utf8");
await fs.writeFile(source, emitted.replaceAll('"../shared/ai-task-status.mjs"', '"../frontend/shared/ai-task-status.mjs"'));
await fs.rm(legacyDestination, { force: true });
console.log("已组装 TypeScript 运行产物至 public/generated/ 和 .build/。");
