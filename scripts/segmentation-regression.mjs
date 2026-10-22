import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createAliyunSegmentationTransport, deepSeekImageInput } from "../src/infrastructure/ai-providers/index.mjs";
import { createAiAudit } from "../src/modules/ai/index.mjs";
import {
  createKeepsakeImageUnderstanding,
  createKeepsakeSegmentation
} from "../src/modules/keepsakes/index.mjs";
import { createKeepsakeHttp } from "../src/http/index.mjs";
import { createAttachmentStorage, createImageAttachments, cleanupTemporaryFiles, readImageFile } from "../src/shared/attachments/index.mjs";
import { createRateGate } from "../src/shared/concurrency/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "segmentation-contract-"));
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const bytes = Buffer.from(pixel.split(",")[1], "base64");
const imageUrl = "https://result.invalid/cutout.png";
const context = new AsyncLocalStorage();
const run = (id, operation) => context.run({ user: { id }, traceId: `trace-${id}`, secrets: [] }, operation);
const location = () => {
  const ownerId = context.getStore().user.id, dataDir = path.join(root, ownerId);
  return { ownerId, dataDir, attachmentsDir: path.join(dataDir, "attachments") };
};
const attachments = createImageAttachments({
  storage: createAttachmentStorage({ mode: "local" }), getContext: location,
  quotaBytes: 1024 * 1024, defaultMaxBytes: 1024 * 1024
});
const records = [], usageRecords = [], failures = [];
let logsFail = false, usageWrites = 0;
const audit = createAiAudit({
  textLimit: 10000, getContext: () => context.getStore(),
  append: async (day, entry) => { if (logsFail) throw new Error("audit unavailable"); records.push(entry); },
  updateUsage: async mutate => { usageWrites += 1; mutate({ entries: usageRecords }); }, logEvent: async () => {}
});
function transport(options = {}) {
  const calls = [], streams = [], sleeps = [];
  let time = 0, clientLoads = 0;
  const provider = createAliyunSegmentationTransport({
    auditCall: audit.providerCall,
    clock: () => time, sleep: async ms => { sleeps.push(ms); time += ms; },
    getClients: () => {
      clientLoads += 1;
      return {
        imageseg: { async segmentHDCommonImageAdvance(request, runtime) {
          streams.push(request.imageUrlObject);
          const chunks = [];
          for await (const chunk of request.imageUrlObject) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), bytes);
          calls.push({ action: "submit", runtime });
          return options.submit ? options.submit() : { body: { requestId: "job-1", data: { imageUrl } } };
        } },
        viapi: { async getAsyncJobResultWithOptions(request, runtime) {
          assert.equal(request.jobId, "job-1");
          calls.push({ action: "poll", runtime });
          return { body: { data: options.poll ? options.poll() : { status: "PROCESS_SUCCESS", result: JSON.stringify({ ImageURL: imageUrl }) } } };
        } }
      };
    },
    fetchImpl: async (url, { signal }) => {
      assert.equal(url.href, imageUrl);
      assert.equal(signal.aborted, false);
      calls.push({ action: "download" });
      return options.download ? options.download(signal) : new Response(bytes);
    },
    ...options.provider
  });
  return { provider, calls, streams, sleeps, clientLoads: () => clientLoads };
}
function workflow(provider, gate = createRateGate(100, 100)) {
  return createKeepsakeSegmentation({
    saveImages: attachments.save, cleanupFiles: cleanupTemporaryFiles, provider, gate,
    onFailure: async (error, callGroupId) => failures.push({ error, callGroupId })
  });
}
const noTemporaryFiles = async id => assert.deepEqual(await fs.readdir(path.join(root, id, "tmp")).catch(() => []), []);
const runtimeShape = runtime => Object.fromEntries(["connectTimeout", "readTimeout", "autoretry", "maxAttempts"].map(key => [key, runtime[key]]));

try {
  const sync = transport(), segment = workflow(sync.provider);
  assert.deepEqual(await run("sync", () => segment({ image: pixel })), { cutout: pixel, provider: "aliyun-segment-hd" });
  assert.deepEqual(sync.calls.map(call => call.action), ["submit", "download"]);
  assert.deepEqual(runtimeShape(sync.calls[0].runtime), { connectTimeout: 10000, readTimeout: 30000, autoretry: false, maxAttempts: 1 });
  assert.ok(sync.streams.every(stream => stream.destroyed));
  await run("sync", () => segment({ images: [pixel] }));
  assert.equal(sync.clientLoads(), 1);
  await noTemporaryFiles("sync");

  let polls = 0;
  const asyncResult = transport({
    submit: () => ({ body: { requestId: "job-1" } }),
    poll: () => ++polls === 1 ? { status: "PROCESSING" } : { status: "PROCESS_SUCCESS", result: { ImageUrl: imageUrl } }
  });
  assert.equal((await run("async", () => workflow(asyncResult.provider)({ image: pixel }))).cutout, pixel);
  assert.deepEqual(asyncResult.calls.map(call => call.action), ["submit", "poll", "poll", "download"]);
  assert.deepEqual(asyncResult.sleeps, [1000]);
  assert.deepEqual(runtimeShape(asyncResult.calls[1].runtime), { connectTimeout: 10000, readTimeout: 20000, autoretry: false, maxAttempts: 1 });
  const asyncRecords = records.filter(entry => entry.actor.userId === "async");
  assert.equal(asyncRecords.length, 8);
  assert.equal(new Set(asyncRecords.map(entry => entry.callGroupId)).size, 1);
  assert.equal(new Set(asyncRecords.map(entry => entry.callId)).size, 4);
  for (const entry of asyncRecords) {
    assert.equal(entry.traceId, "trace-async");
    assert.equal(entry.maxAttempts, 1);
  }
  for (const entry of asyncRecords.filter(entry => entry.status !== "started")) {
    assert.equal(entry.usage.known, true);
    assert.equal(entry.usage.costKnown, true);
    assert.match(entry.usage.costSource, /^https:\/\/help\.aliyun\.com\/.+#2026-10-02$/);
  }
  const source = asyncRecords.find(entry => entry.action === "SegmentHDCommonImage").request.images[0];
  assert.deepEqual(source, { index: 0, mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  const output = asyncRecords.find(entry => entry.action === "DownloadSegmentResult" && entry.status === "success").response;
  assert.deepEqual(output, { mimeType: source.mimeType, bytes: source.bytes, sha256: source.sha256 });
  assert.ok(!JSON.stringify(asyncRecords).includes(pixel));
  assert.ok(!JSON.stringify(asyncRecords).includes(imageUrl));
  const asyncUsage = usageRecords.filter(entry => entry.traceId === "trace-async");
  assert.equal(asyncUsage.length, 4);
  assert.ok(asyncUsage.every(entry => (
    entry.provider === "aliyun"
    && entry.service === "segmentation"
    && entry.scene === "keepsakeSegmentation"
    && entry.modality === "vision"
    && entry.costKnown === true
  )));
  const segmentUsage = asyncUsage.find(entry => entry.action === "SegmentHDCommonImage");
  assert.equal(segmentUsage.imageCount, 1);
  assert.equal(segmentUsage.imageBytes, bytes.length);
  assert.equal(segmentUsage.unitType, "call");
  assert.equal(segmentUsage.costCny, 0.007);
  assert.ok(asyncUsage.filter(entry => entry.action !== "SegmentHDCommonImage").every(entry => entry.costCny === 0));

  const cases = [
    ["no-job", { submit: () => ({ body: {} }) }, /任务编号/],
    ["malformed", { poll: () => ({ status: "PROCESS_SUCCESS", result: "{bad" }) }, /无法解析/],
    ["no-url", { poll: () => ({ status: "PROCESS_SUCCESS", result: "{}" }) }, /没有返回透明轮廓/],
    ...["PROCESS_FAILED", "TIMEOUT_FAILED", "LIMIT_RETRY_FAILED"].map(status => [status, { poll: () => ({ status }) }, /主体识别失败/]),
    ["poll-timeout", { poll: () => ({ status: "PROCESSING" }) }, /等待超时/],
    ["credentials", { submit: () => { throw new Error("InvalidCredentials private-key"); } }, /尚未配置/],
    ["timeout", { submit: () => { throw new Error("ETIMEDOUT private-host"); } }, /响应超时/],
    ["unknown", { submit: () => { throw new Error("private provider detail"); } }, /暂时不可用/],
    ["bad-url", { submit: () => ({ body: { data: { imageUrl: "file:///private" } } }) }, /无效的图片地址/],
    ["http", { download: () => new Response("", { status: 403 }) }, /HTTP 403/],
    ["oversize-header", { download: () => new Response(bytes, { headers: { "content-length": String(25 * 1024 * 1024) } }) }, /图片过大/],
    ["oversize-body", { download: () => new Response(Buffer.alloc(24 * 1024 * 1024 + 1)) }, /大小无效/],
    ["empty", { download: () => new Response("") }, /大小无效/],
    ["not-png", { download: () => new Response("not a png") }, /没有返回 PNG/],
    ["download-timeout", { download: () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } }, /下载超时/]
  ];
  for (const [id, options, message] of cases) {
    const scenario = transport({ submit: () => ({ body: { requestId: "job-1" } }), ...options });
    await assert.rejects(run(id, () => workflow(scenario.provider)({ image: pixel })), error => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes("private"));
      return true;
    });
    assert.equal(scenario.calls.filter(call => call.action === "submit").length, 1);
    assert.ok(scenario.streams.every(stream => stream.destroyed));
    if (id === "poll-timeout") assert.equal(scenario.calls.filter(call => call.action === "poll").length, 60);
    await noTemporaryFiles(id);
  }
  assert.equal(records.filter(entry => entry.actor.userId === "credentials" && entry.status === "failed").length, 1);
  const credentialFailure = usageRecords.find(entry => entry.traceId === "trace-credentials" && entry.status === "failed");
  assert.equal(credentialFailure.costKnown, false);
  assert.equal(credentialFailure.costCny, 0);
  assert.match(credentialFailure.costSource, /invoice verification/);

  logsFail = true;
  const unlogged = transport();
  await assert.rejects(
    run("audit-fail", () => workflow(unlogged.provider)({ image: pixel })),
    /主体识别服务暂时不可用/
  );
  assert.deepEqual(unlogged.calls, [], "audit begin failure must block provider dispatch");
  await noTemporaryFiles("audit-fail");
  logsFail = false;
  const mock = transport({ provider: { mockResult: pixel, mockDelayMs: 25 } });
  assert.equal((await run("mock", () => workflow(mock.provider)({ image: pixel }))).cutout, pixel);
  assert.deepEqual(mock.calls, []); assert.deepEqual(mock.sleeps, [25]);
  assert.equal(mock.clientLoads(), 0);
  assert.equal(records.find(entry => entry.actor.userId === "mock").request.mocked, true);
  assert.equal(usageRecords.find(entry => entry.traceId === "trace-mock").costKnown, true);
  await assert.rejects(run("bad-mock", () => workflow(transport({ provider: { mockResult: "invalid" } }).provider)({ image: pixel })), /测试轮廓不是有效/);
  await noTemporaryFiles("bad-mock");
  assert.ok(usageWrites > 0);
  assert.ok(!JSON.stringify(records).includes(imageUrl));
  assert.ok(!JSON.stringify(usageRecords).includes(pixel));

  // Shared queue must preserve account context, FIFO, and both independent limits.
  const gate = createRateGate(2, 1), entered = [], active = new Set();
  let peak = 0, releaseCount = 0;
  const concurrent = workflow({
    async segment(file) {
      const id = context.getStore().user.id;
      assert.ok(file.startsWith(path.join(root, id)));
      active.add(id); peak = Math.max(peak, active.size); entered.push(id);
      await new Promise(resolve => setTimeout(resolve, 10));
      active.delete(id);
      return { cutout: pixel, provider: "aliyun-segment-hd" };
    }
  }, { acquire: async () => { const release = await gate.acquire(); return () => { releaseCount += 1; release(); release(); }; } });
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await Promise.all(["account-a", "account-b", "account-c"].map(id => run(id, () => concurrent({ image: pixel }))));
  } finally { clearInterval(keepAlive); }
  assert.deepEqual(entered, ["account-a", "account-b", "account-c"]);
  assert.equal(peak, 1); assert.equal(releaseCount, 3);
  assert.ok(Date.now() - started >= 950);
  await assert.rejects(run("invalid", () => concurrent({ images: [] })), /请选择/);
  assert.equal(releaseCount, 3, "preflight validation must not consume shared provider capacity");
  for (const id of entered) await noTemporaryFiles(id);

  const file = path.join(root, "fixture.png");
  await fs.writeFile(file, bytes);
  assert.deepEqual((await deepSeekImageInput(file, 2)).audit, (await readImageFile(file, 2)).audit);
  const candidateInputs = [];
  const understand = createKeepsakeImageUnderstanding({
    saveImages: attachments.save,
    cleanupFiles: cleanupTemporaryFiles,
    generate: async (filePath, options) => {
      candidateInputs.push({ account: context.getStore().user.id, filePath, options });
      return JSON.stringify({
        title: " 展览票根 ",
        tags: ["纪念", "展览", "纪念", ""],
        description: "画面中可见一张带日期的纸质票根。"
      });
    }
  });
  assert.deepEqual(await run("understand", () => understand({ image: pixel, existingTags: ["展览", "纪念", "旅行"] })), {
    title: "展览票根",
    tags: ["纪念", "展览"],
    description: "画面中可见一张带日期的纸质票根。"
  });
  assert.equal(candidateInputs.length, 1);
  assert.ok(candidateInputs[0].filePath.startsWith(path.join(root, "understand")));
  assert.deepEqual(candidateInputs[0].options, { existingTags: ["展览", "纪念", "旅行"] });
  await noTemporaryFiles("understand");
  const invalidCandidate = createKeepsakeImageUnderstanding({
    saveImages: attachments.save,
    cleanupFiles: cleanupTemporaryFiles,
    generate: async () => JSON.stringify({
      title: "未知物品",
      tags: ["一", "二", "三", "四", "五", "六", "七", "八", "九"],
      description: ""
    })
  });
  assert.deepEqual(await run("understand-invalid", () => invalidCandidate({ image: pixel, existingTags: ["二", "四", "六", "八"] })), {
    title: "未知物品",
    tags: ["二", "四", "六"],
    description: ""
  });
  await assert.rejects(
    run("understand-malformed", () => createKeepsakeImageUnderstanding({
      saveImages: attachments.save,
      cleanupFiles: cleanupTemporaryFiles,
      generate: async () => "not-json"
    })({ image: pixel })),
    /候选格式无法解析/
  );
  await noTemporaryFiles("understand-malformed");
  let response;
  const http = createKeepsakeHttp({
    segment, understand, bodyJson: async req => req.input,
    sendJson: (res, status, value) => { response = { status, value }; },
    requestBinding: input => ({ requestId: input.requestId, targetId: input.targetId, inputVersion: input.inputVersion })
  });
  await run("http", () => http.handle({ method: "POST", input: { image: pixel, requestId: "r1", targetId: "new", inputVersion: 3 } }, {}, new URL("http://local/api/keepsakes/segment")));
  assert.deepEqual(response, { status: 200, value: { cutout: pixel, provider: "aliyun-segment-hd", requestId: "r1", targetId: "new", inputVersion: 3 } });
  await run("http", () => http.handle({ method: "POST", input: { image: pixel, existingTags: ["纪念", "展览"], requestId: "r2", targetId: "draft-1", inputVersion: 4 } }, {}, new URL("http://local/api/keepsakes/understand")));
  assert.deepEqual(response, {
    status: 200,
    value: {
      title: "展览票根",
      tags: ["纪念", "展览"],
      description: "画面中可见一张带日期的纸质票根。",
      requestId: "r2",
      targetId: "draft-1",
      inputVersion: 4
    }
  });
  await run("http", () => http.handle({ method: "POST", input: {} }, {}, new URL("http://local/api/keepsakes/segment")));
  assert.equal(response.status, 400);
  assert.equal(await http.handle({ method: "GET" }, {}, new URL("http://local/api/keepsakes/segment")), false);
  // F5：占用者不归还时，等待者也必须独立取消/到期；取消项不能消费QPS或泄漏许可。
{
  const gate = createRateGate(10000, 1, { maxPending: 1 });
  const release = await gate.acquire();
  const controller = new AbortController();
  const cancelled = gate.acquire({ signal: controller.signal });
  const cancelledAssertion = assert.rejects(cancelled, { code: "AI_TASK_CANCELLED" });
  await assert.rejects(gate.acquire(), { code: "AI_QUEUE_FULL" });
  controller.abort(); await cancelledAssertion;
  await assert.rejects(gate.acquire({ deadline: performance.now() + 10 }), { code: "AI_QUEUE_TIMEOUT" });
  release(); release(); (await gate.acquire())();
  for (let index = 0; index < 1000; index++) {
    const owner = await gate.acquire(); const abort = new AbortController();
    const waiting = gate.acquire({ signal: abort.signal });
    const check = assert.rejects(waiting, { code: "AI_TASK_CANCELLED" }); abort.abort(); await check; owner();
  }
  (await gate.acquire())();
}

console.log("Keepsake vision contracts passed: segmentation, editable metadata candidates, account context, HTTP binding and temporary cleanup.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
