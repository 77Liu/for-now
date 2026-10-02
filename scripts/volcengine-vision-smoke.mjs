import { promises as fs } from "node:fs";
import path from "node:path";
import { createVolcengineVisionTransport } from "../src/infrastructure/ai-providers/index.mjs";
import { prepareFontconfigCache } from "./fontconfig-cache.mjs";

const accessKeyId = String(process.env.VOLCENGINE_ACCESS_KEY_ID || "").trim();
const secretAccessKey = String(process.env.VOLCENGINE_SECRET_ACCESS_KEY || "").trim();
if (!accessKeyId || !secretAccessKey) {
  throw new Error("缺少 VOLCENGINE_ACCESS_KEY_ID 或 VOLCENGINE_SECRET_ACCESS_KEY；请先从受保护环境文件加载后再运行");
}

await prepareFontconfigCache();
const { default: sharp } = await import("sharp");
const sourcePath = process.argv.find(value => !value.startsWith("-") && value !== process.argv[0] && value !== process.argv[1]);
const source = sourcePath
  ? await fs.readFile(path.resolve(sourcePath))
  : await sharp({
      create: {
        width: 1200,
        height: 500,
        channels: 3,
        background: "#ffffff"
      }
    })
      .composite([{
        input: Buffer.from('<svg width="1200" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="500" fill="white"/><text x="80" y="285" font-size="112" font-family="Arial" fill="black">OCR TEST 2026</text></svg>')
      }])
      .png()
      .toBuffer();

const vision = createVolcengineVisionTransport({
  accessKeyId,
  secretAccessKey,
  sessionToken: process.env.VOLCENGINE_SESSION_TOKEN,
  endpoint: process.env.VOLCENGINE_VISUAL_ENDPOINT,
  region: process.env.VOLCENGINE_VISUAL_REGION
});
const ocr = await vision.recognizeText({ data: source });
if (!ocr.text) throw new Error("通用 OCR 未返回文字");
const document = await vision.parseDocument({ data: source, mimeType: "image/png" });
if (!document.markdown) throw new Error("智能文档解析未返回 Markdown");

console.log(JSON.stringify({
  ocr: {
    ok: true,
    lines: ocr.lines.length,
    characters: ocr.text.length,
    providerRequestId: ocr.providerRequestId
  },
  document: {
    ok: true,
    pages: document.detail.length,
    characters: document.markdown.length,
    providerRequestId: document.providerRequestId
  }
}, null, 2));
