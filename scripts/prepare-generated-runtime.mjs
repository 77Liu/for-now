import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".build/typescript/frontend/personalized-ai-task.mjs");
const destination = path.join(root, "public/frontend/shared/personalized-ai-task.mjs");

await fs.access(source);
await fs.copyFile(source, destination);
console.log("已组装 1 个 TypeScript 前端运行产物；产物路径受 .gitignore 保护。");
