import assert from "node:assert/strict";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import Credential from "@alicloud/credentials";
import Imageseg from "@alicloud/imageseg20191230";
import Viapi from "@alicloud/viapi20230117";
import OpenApi from "@alicloud/openapi-client";
import Util from "@alicloud/tea-util";

const imageFile = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/aliyun-segmentation-smoke.mjs <image-file>");
const source = await fs.stat(imageFile);
if (!source.isFile() || !source.size) throw new Error("Segmentation smoke image is empty or missing");

const region = "cn-shanghai";
const roleName = String(process.env.ALIBABA_CLOUD_ECS_RAM_ROLE || "").trim();
const credential = roleName
  ? new Credential.default({
      type: "ecs_ram_role",
      roleName,
      disableIMDSv1: String(process.env.ALIBABA_CLOUD_IMDSV1_DISABLED || "true").toLowerCase() !== "false"
    })
  : new Credential.default();
const imageseg = new Imageseg.default(new OpenApi.Config({
  credential,
  endpoint: `imageseg.${region}.aliyuncs.com`,
  regionId: region
}));
const viapi = new Viapi.default(new OpenApi.Config({
  credential,
  endpoint: `viapi.${region}.aliyuncs.com`,
  regionId: region
}));
const runtime = new Util.RuntimeOptions({
  connectTimeout: 10_000,
  readTimeout: 30_000,
  autoretry: false,
  maxAttempts: 1
});

const started = Date.now();
const response = await imageseg.segmentHDCommonImageAdvance(
  new Imageseg.SegmentHDCommonImageAdvanceRequest({ imageUrlObject: createReadStream(imageFile) }),
  runtime
);
const jobId = response?.body?.requestId || "";
let imageUrl = response?.body?.data?.imageUrl || "";
let polls = 0;
while (!imageUrl && Date.now() - started < 60_000) {
  assert.ok(jobId, "SegmentHDCommonImage returned neither imageUrl nor requestId");
  await new Promise(resolve => setTimeout(resolve, 1000));
  polls += 1;
  const result = await viapi.getAsyncJobResultWithOptions(
    new Viapi.GetAsyncJobResultRequest({ jobId }),
    runtime
  );
  const data = result?.body?.data || {};
  if (data.status === "PROCESS_SUCCESS") {
    const parsed = JSON.parse(data.result || "{}");
    imageUrl = parsed.ImageUrl || parsed.imageUrl || "";
  } else if (["PROCESS_FAILED", "TIMEOUT_FAILED", "LIMIT_RETRY_FAILED"].includes(data.status)) {
    throw new Error(`SegmentHDCommonImage failed: ${data.errorCode || data.status}`);
  }
}
assert.ok(imageUrl, "SegmentHDCommonImage timed out without imageUrl");

const result = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
assert.equal(result.ok, true, `Segmentation result download failed with HTTP ${result.status}`);
const output = Buffer.from(await result.arrayBuffer());
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
