import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatisticsRuntime } from "../src/app/index.mjs";
import {
  apiV1RegistrationIds,
  createAdminHttp,
  createLegacyApi,
  createOwnerHttp,
  createUpstreamProxy,
  ownerCapabilityFor,
  registerApiV1
} from "../src/http/index.mjs";

const sendJson = (res, status, body) => {
  res.status = status;
  res.body = body;
  return true;
};
const response = () => ({
  headers: new Map(),
  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }
});
const request = ({ method = "GET", headers = {}, remoteAddress = "127.0.0.1", chunks = [] } = {}) => ({
  method,
  headers,
  socket: { remoteAddress },
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }
});

const platformToken = "platform-token-with-at-least-thirty-two-characters";
const platformTokenHash = crypto.createHash("sha256").update(platformToken).digest("hex");
let snapshotInput;
const admin = createAdminHttp({
  serviceTokenHash: platformTokenHash,
  buildSnapshot: async input => {
    snapshotInput = input;
    return { source: "snapshot" };
  },
  snapshotOptions: { dataDir: "/private/data" },
  sendJson
});
let res = response();
assert.equal(
  await admin.handle(request(), res, new URL("http://local/api/unknown")),
  false
);
await admin.handle(request({ method: "POST" }), res = response(), new URL("http://local/api/admin/v1/snapshot"));
assert.deepEqual([res.status, res.body], [405, { error: "Method not allowed" }]);
await admin.handle(
  request({ headers: { authorization: `Bearer ${platformToken}`, "x-forwarded-for": "203.0.113.5" } }),
  res = response(),
  new URL("http://local/api/admin/v1/snapshot")
);
assert.equal(res.status, 403);
await admin.handle(request(), res = response(), new URL("http://local/api/admin/v1/snapshot"));
assert.equal(res.status, 401);
await admin.handle(
  request({ headers: { authorization: `Bearer ${platformToken}` }, remoteAddress: "::ffff:127.0.0.1" }),
  res = response(),
  new URL("http://local/api/admin/v1/snapshot")
);
assert.deepEqual([res.status, res.body, snapshotInput], [
  200,
  { source: "snapshot" },
  { dataDir: "/private/data" }
]);
const disabledAdmin = createAdminHttp({
  serviceTokenHash: "",
  buildSnapshot: async () => ({}),
  snapshotOptions: {},
  sendJson
});
await disabledAdmin.handle(request(), res = response(), new URL("http://local/api/admin/v1/snapshot"));
assert.equal(res.status, 404);

const ownerStore = {
  commercialization: {
    assumptions: { existing: true },
    updatedAt: "old"
  }
};
const ownerCalls = [];
const owner = createOwnerHttp({
  architectureSurface: () => ({ surface: "architecture" }),
  commercializationSurface: input => ({ surface: "commercialization", ...input }),
  normalizeCommercialization: value => ({ ...value, normalized: true }),
  statistics: {
    dashboard: async (range, options) => {
      ownerCalls.push({ range, options });
      return { value: { records: { total: 1 } } };
    }
  },
  readStore: async () => ownerStore,
  updateStore: async mutate => mutate(ownerStore),
  bodyJson: async req => req.body || {},
  sendJson,
  now: () => "2026-10-06T00:00:00.000Z",
  today: () => "2026-10-06"
});
await owner.handle(request(), res = response(), new URL("http://local/api/owner/surfaces/architecture"));
assert.equal(res.body.surface, "architecture");
assert.equal(res.headers.get("cache-control"), "private, no-store");
await owner.handle(
  { ...request({ method: "POST" }), body: { assumptions: { changed: true }, mode: "subscription" } },
  res = response(),
  new URL("http://local/api/owner/surfaces/commercialization/preview?from=2026-10-01&to=2026-10-06")
);
assert.equal(res.body.surface, "commercialization");
assert.equal(res.body.report.normalized, true);
assert.equal(res.body.mode, "subscription");
assert.deepEqual(ownerCalls.at(-1), {
  range: { from: "2026-10-01", to: "2026-10-06" },
  options: { includeOwner: true }
});
await owner.handle(
  { ...request({ method: "PATCH" }), body: { assumptions: { saved: true } } },
  res = response(),
  new URL("http://local/api/commercialization")
);
assert.equal(res.body.updatedAt, "2026-10-06T00:00:00.000Z");
assert.equal(ownerStore.commercialization.assumptions.saved, true);
assert.equal(ownerCapabilityFor(new URL("http://local/api/settings/test")), "ai-configuration");
assert.equal(ownerCapabilityFor(new URL("http://local/api/state")), "");

const legacyOrder = [];
const legacy = createLegacyApi({
  beforeStateHandlers: [
    async () => {
      legacyOrder.push("before-1");
      return false;
    },
    async (req, target) => {
      legacyOrder.push("before-2");
      if (req.method !== "POST") return false;
      sendJson(target, 201, { created: true });
      return true;
    }
  ],
  afterStateHandlers: [
    async () => {
      legacyOrder.push("after-1");
      return false;
    }
  ],
  readMeta: async () => ({ version: "test" }),
  readState: async () => ({ captures: [] }),
  sendJson
});
await legacy.handle(request(), res = response(), new URL("http://local/api/meta"));
assert.deepEqual(res.body, { version: "test" });
assert.deepEqual(legacyOrder, []);
await legacy.handle(request(), res = response(), new URL("http://local/api/state"));
assert.deepEqual(res.body, { captures: [] });
assert.deepEqual(legacyOrder, ["before-1", "before-2"]);
legacyOrder.length = 0;
await legacy.handle(request({ method: "POST" }), res = response(), new URL("http://local/api/example"));
assert.deepEqual([res.status, res.body], [201, { created: true }]);
assert.deepEqual(legacyOrder, ["before-1", "before-2"]);
legacyOrder.length = 0;
await legacy.handle(request(), res = response(), new URL("http://local/api/unknown"));
assert.deepEqual([res.status, res.body], [404, { error: "Not found" }]);
assert.deepEqual(legacyOrder, ["before-1", "before-2", "after-1"]);

const registered = [];
const handlers = Object.fromEntries([
  "startup", "sync", "personalContext", "aiBudget", "onboardingV2", "userModel",
  "thoughts", "checkins", "health", "discovery", "exports", "actions", "feedback",
  "capturesJournals", "library", "reviewsChat", "contentAttachments", "importance"
].map(key => [key, async () => false]));
const apiV1 = {
  register(id, handler) {
    registered.push([id, handler]);
  }
};
assert.equal(registerApiV1(apiV1, handlers), apiV1);
assert.deepEqual(registered.map(([id]) => id), apiV1RegistrationIds);
await assert.rejects(
  async () => registerApiV1(apiV1, { ...handlers, health: null }),
  /requires health handler/
);

let upstreamRequest;
const proxy = createUpstreamProxy({
  origin: "https://upstream.example",
  maxBodyBytes: 8,
  uploadMaxBodyBytes: 16,
  sendJson,
  getTraceId: () => "trace-123",
  upstreamCookie: () => "session=upstream",
  rewriteResponse: async () => false,
  fetchImpl: async (url, init) => {
    upstreamRequest = { url, init };
    return {
      status: 206,
      headers: {
        get: name => ({
          "content-type": "audio/mpeg",
          "content-range": "bytes 0-2/3",
          "set-cookie": "session=remote"
        })[name] || null,
        getSetCookie: () => ["session=remote"]
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("abc");
        }
      }
    };
  }
});
const proxyResponse = Object.assign(new EventEmitter(), {
  chunks: [],
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  },
  end(chunk) {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
});
await proxy(
  request({
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    chunks: ["{}"]
  }),
  proxyResponse,
  new URL("http://local/api/example?mode=one")
);
assert.equal(upstreamRequest.url, "https://upstream.example/api/example?mode=one");
assert.equal(upstreamRequest.init.headers.cookie, "session=upstream");
assert.equal(upstreamRequest.init.headers["x-request-id"], "trace-123");
assert.equal(proxyResponse.status, 206);
assert.equal(proxyResponse.headers["set-cookie"][0], "session=remote");
assert.equal(Buffer.concat(proxyResponse.chunks).toString("utf8"), "abc");
await proxy(
  request({ method: "POST", chunks: ["123456789"] }),
  res = response(),
  new URL("http://local/api/example")
);
assert.deepEqual([res.status, res.body.code], [413, "BODY_TOO_LARGE"]);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "statistics-runtime-"));
try {
  await fs.writeFile(path.join(temporary, "operation-2026-10-05.ndjson"), [
    JSON.stringify({ event: "request.completed", result: "success", action: "POST /api/captures" }),
    JSON.stringify({ event: "request.completed", result: "failed", action: "POST /api/captures" }),
    "{invalid",
    ""
  ].join("\n"));
  await fs.writeFile(
    path.join(temporary, "operation-2026-09-01.ndjson"),
    `${JSON.stringify({ event: "request.completed", result: "success" })}\n`
  );
  const { statisticsService } = createStatisticsRuntime({
    repository: { read: async () => ({ captures: [{ id: "capture-1" }] }) },
    ensureAiUsage: async () => {},
    readAiUsage: async () => ({ entries: [] }),
    logsDirectory: () => temporary,
    aiDashboard: () => ({ summary: { calls: 0 } }),
    today: () => "2026-10-06"
  });
  const dashboard = await statisticsService.dashboard({
    from: "2026-10-01",
    to: "2026-10-06"
  });
  assert.equal(dashboard.value.records.content.find(item => item.key === "captures").count, 1);
  assert.equal(dashboard.value.service.completedWrites, 1);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

process.stdout.write("HTTP orchestration regression passed.\n");
