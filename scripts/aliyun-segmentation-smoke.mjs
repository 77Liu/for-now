import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createAliyunSegmentationTransport } from "../src/infrastructure/ai-providers/index.mjs";
import { loadAttachmentConfig } from "../src/config/index.mjs";

const imageFile = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/aliyun-segmentation-smoke.mjs <image-file>");
const source = await fs.stat(imageFile);
if (!source.isFile() || !source.size) throw new Error("Segmentation smoke image is empty or missing");

const started = Date.now();
let jobId = "", polls = 0;
const { roleName, disableIMDSv1 } = loadAttachmentConfig();
const provider = createAliyunSegmentationTransport({
  roleName, disableIMDSv1,
  auditCall: async (details, invoke) => {
    if (details.action === "GetAsyncJobResult") polls += 1;
    const response = await invoke();
    if (details.action === "SegmentHDCommonImage") jobId = response?.body?.requestId || "";
    return response;
  }
});
const result = await provider.segment(imageFile, { callGroupId: crypto.randomUUID() });
const output = Buffer.from(result.cutout.split(",")[1], "base64");
assert.ok(output.length > 8 && output.length <= 24 * 1024 * 1024, "Segmentation result size is invalid");
assert.deepEqual(output.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "Segmentation result is not PNG");

console.log(JSON.stringify({
  ok: true,
  action: "SegmentHDCommonImage",
  requestId: jobId,
  polls,
  sourceBytes: source.size,
  outputBytes: output.length,
  durationMs: Date.now() - started
}));
