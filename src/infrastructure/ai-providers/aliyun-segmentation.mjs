import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import Imageseg from "@alicloud/imageseg20191230";
import Viapi from "@alicloud/viapi20230117";
import OpenApi from "@alicloud/openapi-client";
import Credential from "@alicloud/credentials";
import Util from "@alicloud/tea-util";
import { readImageFile } from "../../shared/attachments/index.mjs";
import { safeText } from "../../shared/validation/index.mjs";

const REGION = "cn-shanghai";
const SEGMENT_TIMEOUT_MS = 60_000;
const RESULT_MAX_BYTES = 24 * 1024 * 1024;
const SUBMIT_PARAMETERS = { connectTimeout: 10_000, readTimeout: 30_000, autoretry: false, maxAttempts: 1 };
const POLL_PARAMETERS = { connectTimeout: 10_000, readTimeout: 20_000, autoretry: false, maxAttempts: 1 };

function parseResult(value) {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return safeText(parsed.imageUrl || parsed.ImageUrl || parsed.imageURL || parsed.ImageURL, 4000);
  } catch {
    throw new Error("主体识别服务返回了无法解析的结果");
  }
}

function publicErrorMessage(error) {
  if (/图片|轮廓|主体识别|测试轮廓/.test(error.message || "")) return error.message;
  if (/InvalidCredentials|AccessKey|credential|Forbidden|Unauthorized|403/i.test(error.message || error.code || "")) {
    return "主体识别服务尚未配置完成，请联系管理员";
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(error.message || error.code || "")) return "主体识别服务响应超时，请稍后重试";
  return "主体识别服务暂时不可用，请稍后重试";
}

export function createAliyunSegmentationTransport({
  roleName = "", disableIMDSv1 = true, mockResult = "", mockDelayMs = 0,
  fetchImpl = fetch, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  clock = Date.now, getClients: suppliedClients,
  auditCall = (action, group, request, invoke) => invoke()
} = {}) {
  let clients;
  function getClients() {
    if (clients) return clients;
    if (suppliedClients) return clients = suppliedClients();
    const credential = roleName
      ? new Credential.default({ type: "ecs_ram_role", roleName, disableIMDSv1 })
      : new Credential.default();
    const config = endpoint => new OpenApi.Config({ credential, endpoint, regionId: REGION });
    clients = {
      imageseg: new Imageseg.default(config(`imageseg.${REGION}.aliyuncs.com`)),
      viapi: new Viapi.default(config(`viapi.${REGION}.aliyuncs.com`))
    };
    return clients;
  }

  async function waitForResult(client, jobId, callGroupId) {
    const startedAt = clock(), runtime = new Util.RuntimeOptions(POLL_PARAMETERS);
    while (clock() - startedAt < SEGMENT_TIMEOUT_MS) {
      const response = await auditCall("GetAsyncJobResult", callGroupId, { jobId, parameters: POLL_PARAMETERS },
        () => client.getAsyncJobResultWithOptions(new Viapi.GetAsyncJobResultRequest({ jobId }), runtime));
      const data = response?.body?.data || {};
      if (data.status === "PROCESS_SUCCESS") {
        const imageUrl = parseResult(data.result);
        if (!imageUrl) throw new Error("主体识别服务没有返回透明轮廓");
        return imageUrl;
      }
      if (["PROCESS_FAILED", "TIMEOUT_FAILED", "LIMIT_RETRY_FAILED"].includes(data.status)) {
        throw new Error(`主体识别失败${data.errorMessage ? `：${safeText(data.errorMessage, 160)}` : ""}`);
      }
      await sleep(1000);
    }
    throw new Error("主体识别等待超时，请稍后重试");
  }

  async function download(imageUrl) {
    let url;
    try { url = new URL(imageUrl); } catch { throw new Error("主体识别服务返回了无效的图片地址"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("主体识别服务返回了无效的图片地址");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`透明轮廓下载失败（HTTP ${response.status}）`);
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > RESULT_MAX_BYTES) throw new Error("透明轮廓图片过大");
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length || data.length > RESULT_MAX_BYTES) throw new Error("透明轮廓图片大小无效");
      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("主体识别服务没有返回 PNG 图片");
      return `data:image/png;base64,${data.toString("base64")}`;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("透明轮廓下载超时，请稍后重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function segment(file, { callGroupId }) {
    try {
      const image = (await readImageFile(file)).audit;
      if (mockResult) {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(mockResult)) throw new Error("测试轮廓不是有效的 PNG Data URL");
        if (mockDelayMs) await sleep(mockDelayMs);
        return await auditCall("SegmentHDCommonImage", callGroupId, { images: [image], mocked: true },
          async () => ({ cutout: mockResult, provider: "aliyun-segment-hd" }), () => ({ mocked: true }));
      }
      const { imageseg, viapi } = getClients();
      const runtime = new Util.RuntimeOptions(SUBMIT_PARAMETERS);
      const response = await auditCall("SegmentHDCommonImage", callGroupId, {
        images: [image], region: REGION, parameters: SUBMIT_PARAMETERS
      }, async () => {
        const stream = createReadStream(file);
        try {
          return await imageseg.segmentHDCommonImageAdvance(new Imageseg.SegmentHDCommonImageAdvanceRequest({ imageUrlObject: stream }), runtime);
        } finally {
          stream.destroy();
        }
      });
      let imageUrl = safeText(response?.body?.data?.imageUrl, 4000);
      if (!imageUrl) {
        const jobId = safeText(response?.body?.requestId, 200);
        if (!jobId) throw new Error("主体识别服务没有返回任务编号");
        imageUrl = await waitForResult(viapi, jobId, callGroupId);
      }
      const cutout = await auditCall("DownloadSegmentResult", callGroupId, { imageUrl },
        () => download(imageUrl), result => {
          const data = Buffer.from(result.split(",")[1], "base64");
          return { mimeType: "image/png", bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
        });
      return { cutout, provider: "aliyun-segment-hd" };
    } catch (error) {
      // Raw SDK diagnostics stay available to private audit; callers receive
      // only the established user-facing projection.
      error.publicMessage = publicErrorMessage(error);
      throw error;
    }
  }
  return { segment };
}
