import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  aiBudgetComponents,
  aiBudgetOpenApiFragment,
  aiBudgetPaths,
  createAiBudgetHttp,
  createApiV1Http,
  createJsonHttp,
  openApiV1
} from "../src/http/index.mjs";
import {
  AI_BUDGET_POLICY,
  createAiBudgetService
} from "../src/modules/ai/index.mjs";
import { createAtomicRepository } from "./fixtures/atomic-json-repository.mjs";

class Response {
  constructor() {
    this.headers = new Map();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.body = "";
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  end(chunk = "") {
    this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.writableEnded = true;
  }
}

const repository = createAtomicRepository();
let id = 0;
const budget = createAiBudgetService({
  repository,
  policy: {
    ...AI_BUDGET_POLICY,
    userDailyKnownCostCny: 1000,
    userDailyCalls: 1000
  },
  now: () => "2026-10-02T01:00:00.000Z",
  createId: () => `http-${++id}`
});
let context = {};
let actorLookups = 0;
const { bodyJson, sendJson } = createJsonHttp({
  getContext: () => context,
  maxBodyBytes: 4096
});
const v1 = createApiV1Http({
  sendJson,
  getContext: () => context,
  openApi: {}
});
const http = createAiBudgetHttp({
  budget,
  bodyJson,
  getActorId: async () => {
    actorLookups += 1;
    return "server-owner";
  }
});
v1.register("owner-ai-budget", http.handleV1);

async function request(method, { headers = {}, body } = {}) {
  context = { traceId: `trace-${method.toLowerCase()}`, method, secrets: [] };
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  const res = new Response();
  let handled;
  try {
    handled = await v1.handle(req, res, new URL("http://localhost/api/v1/owner/ai-budget"));
  } catch (error) {
    v1.error(
      res,
      error.statusCode || 500,
      error.message || "服务暂时不可用",
      error.code,
      error.details
    );
    handled = true;
  }
  return {
    handled,
    status: res.statusCode,
    headers: Object.fromEntries(res.headers),
    body: res.body ? JSON.parse(res.body) : null
  };
}

const safeStatus = value => {
  assert.deepEqual(Object.keys(value).sort(), [
    "activeReservations",
    "controlVersion",
    "day",
    "eventCount",
    "month",
    "policy"
  ]);
  assert.equal(Object.hasOwn(value, "events"), false);
  assert.equal(Object.hasOwn(value, "reservations"), false);
  assert.equal(Object.hasOwn(value, "user"), false);
  assert.equal(JSON.stringify(value).includes("actorId"), false);
  assert.equal(JSON.stringify(value).includes("reason"), false);
};

const initial = await request("GET");
assert.equal(initial.handled, true);
assert.equal(initial.status, 200);
assert.equal(initial.headers.etag, "\"1\"");
assert.equal(initial.headers["cache-control"], "no-store");
assert.equal(initial.body.data.controlVersion, 1);
safeStatus(initial.body.data);
assert.equal(actorLookups, 0);

const unsupportedMethod = await request("POST", {
  body: { command: "recover", scope: "dailyKnownCost", reason: "not allowed" }
});
assert.equal(unsupportedMethod.handled, false);
assert.equal(unsupportedMethod.body, null);

const missingIfMatch = await request("PATCH", {
  body: { command: "recover", scope: "dailyKnownCost", reason: "missing precondition" }
});
assert.equal(missingIfMatch.status, 428);
assert.equal(missingIfMatch.body.error.code, "PRECONDITION_REQUIRED");
assert.equal(actorLookups, 0);

const invalidIfMatch = await request("PATCH", {
  headers: { "if-match": "1" },
  body: { command: "recover", scope: "dailyKnownCost", reason: "invalid precondition" }
});
assert.equal(invalidIfMatch.status, 400);
assert.equal(invalidIfMatch.body.error.code, "INVALID_IF_MATCH");
assert.equal(actorLookups, 0);

const invalidCommand = await request("PATCH", {
  headers: { "if-match": "\"1\"" },
  body: { command: "replacePolicy", reason: "not allowed" }
});
assert.equal(invalidCommand.status, 400);
assert.equal(invalidCommand.body.error.code, "AI_BUDGET_COMMAND_INVALID");
assert.equal(actorLookups, 0);

const addition = await request("PATCH", {
  headers: { "if-match": "\"1\"" },
  body: {
    command: "addTemporaryBudget",
    scope: "daily",
    amountCny: 10,
    reason: "approved test window",
    actorId: "spoofed-client"
  }
});
assert.equal(addition.status, 200);
assert.equal(addition.headers.etag, "\"2\"");
assert.equal(addition.headers["cache-control"], "no-store");
assert.equal(addition.body.data.controlVersion, 2);
assert.equal(addition.body.data.day.effectiveKnownCostLimitCny, 110);
safeStatus(addition.body.data);
const additionEvent = (await budget.read()).events.find(
  event => event.type === "ai.budget.owner_temporary_addition"
);
assert.equal(additionEvent.actorId, "server-owner");
assert.equal(JSON.stringify(addition.body).includes("server-owner"), false);
assert.equal(JSON.stringify(addition.body).includes("spoofed-client"), false);

const stale = await request("PATCH", {
  headers: { "if-match": "\"1\"" },
  body: {
    command: "recover",
    scope: "dailyKnownCost",
    reason: "stale command"
  }
});
assert.equal(stale.status, 412);
assert.equal(stale.body.error.code, "PRECONDITION_FAILED");
assert.deepEqual(stale.body.error.details, { currentVersion: 2 });
assert.equal((await budget.status()).controlVersion, 2);

const recovery = await request("PATCH", {
  headers: { "if-match": "\"2\"" },
  body: {
    command: "recover",
    scope: "dailyKnownCost",
    reason: "approved recovery"
  }
});
assert.equal(recovery.status, 200);
assert.equal(recovery.headers.etag, "\"3\"");
assert.equal(recovery.body.data.controlVersion, 3);
safeStatus(recovery.body.data);
assert.equal(actorLookups, 3);

const finalStatus = await request("GET");
assert.equal(finalStatus.headers.etag, "\"3\"");
assert.equal(finalStatus.body.data.controlVersion, 3);
safeStatus(finalStatus.body.data);

assert.strictEqual(aiBudgetOpenApiFragment.paths, aiBudgetPaths);
assert.strictEqual(aiBudgetOpenApiFragment.components, aiBudgetComponents);
assert.deepEqual(Object.keys(aiBudgetPaths), ["/owner/ai-budget"]);
assert.deepEqual(
  Object.keys(aiBudgetPaths["/owner/ai-budget"]).sort(),
  ["get", "patch"]
);
assert.equal(
  aiBudgetPaths["/owner/ai-budget"].patch.parameters[0].$ref,
  "#/components/parameters/IfMatch"
);
assert.deepEqual(
  aiBudgetComponents.schemas.AiBudgetAddTemporaryBudgetCommand.properties.command,
  { const: "addTemporaryBudget" }
);
assert.deepEqual(
  aiBudgetComponents.schemas.AiBudgetRecoverCommand.properties.command,
  { const: "recover" }
);
assert.deepEqual(openApiV1.paths["/owner/ai-budget"], aiBudgetPaths["/owner/ai-budget"]);

const assembled = {
  ...openApiV1,
  paths: { ...openApiV1.paths, ...aiBudgetPaths },
  components: {
    ...openApiV1.components,
    parameters: {
      ...openApiV1.components.parameters,
      ...aiBudgetComponents.parameters
    },
    schemas: {
      ...openApiV1.components.schemas,
      ...aiBudgetComponents.schemas
    }
  }
};
const refs = [];
const collectRefs = value => {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const nested of Object.values(value)) collectRefs(nested);
};
collectRefs(aiBudgetOpenApiFragment);
for (const ref of refs) {
  assert.match(ref, /^#\//);
  const resolved = ref.slice(2).split("/").reduce(
    (value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
    assembled
  );
  assert.ok(resolved, `Unresolved OpenAPI reference: ${ref}`);
}

console.log("AI budget HTTP checks passed: safe status projection, ETags, no-store, conditional Owner commands, server actor injection, error projection and standalone OpenAPI composition.");
