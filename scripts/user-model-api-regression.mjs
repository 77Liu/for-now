import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { userModelEvidenceCurrent } from "../src/app/index.mjs";
import { defaultOnboarding, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import { createUserModelService, normalizeUserClaim } from "../src/modules/user-model/index.mjs";
import {
  createApiV1Http,
  createUserModelHttp,
  openApiV1,
  userModelOpenApiFragment
} from "../src/http/index.mjs";

const context = new AsyncLocalStorage();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const onboarding = (text, version = 1) => normalizeOnboardingV2({
  session: {
    status: "completed",
    step: "firstAction",
    revision: version,
    answers: {
      currentContext: {
        rawText: text,
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:00:00.000Z",
        version,
        contextAllowed: true
      }
    }
  },
  migration: { selectedFlow: "v2" }
}, defaultOnboarding);
const candidate = (id, text) => normalizeUserClaim({
  id,
  domain: "context",
  statement: text,
  scope: "最近",
  epistemic: "known",
  lifecycle: "candidate",
  evidenceStrength: "self_report",
  evidence: [{
    sourceType: "onboardingV2Answer",
    sourceId: "currentContext",
    sourceVersion: 1,
    contentSha256: hash(text),
    span: [0, text.length]
  }],
  contextAllowed: true,
  createdAt: "2026-10-02T01:01:00.000Z",
  updatedAt: "2026-10-02T01:01:00.000Z",
  version: 1
});
const stores = new Map([
  ["account-a", {
    onboardingV2: onboarding("正在适应新的工作节奏"),
    userClaims: [candidate("claim-a", "正在适应新的工作节奏")],
    modelUnknowns: []
  }],
  ["account-b", {
    onboardingV2: onboarding("另一个账户"),
    userClaims: [],
    modelUnknowns: []
  }]
]);
const repository = {
  async read() {
    return structuredClone(stores.get(context.getStore().accountId));
  },
  async update(mutate) {
    const account = context.getStore().accountId;
    const draft = structuredClone(stores.get(account));
    const result = await mutate(draft);
    stores.set(account, draft);
    return structuredClone(result);
  }
};
let id = 0;
let second = 0;
const userModel = createUserModelService({
  repository,
  isEvidenceCurrent: userModelEvidenceCurrent,
  createId: () => `claim-revision-${++id}`,
  now: () => new Date(Date.UTC(2026, 9, 2, 3, 0, second++)).toISOString()
});
const sendJson = (res, status, value) => {
  res.status = status;
  res.body = value;
  res.headersSent = true;
  return value;
};
const http = createUserModelHttp({
  userModel,
  bodyJson: async req => req.body || {}
});
const api = createApiV1Http({
  sendJson,
  getContext: () => context.getStore(),
  openApi: openApiV1
});
api.register("user-model", http.handleV1);

async function request(accountId, method, pathname, { body = {}, headers = {} } = {}) {
  const responseHeaders = new Map();
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), String(value));
    }
  };
  const handled = await context.run(
    { accountId, traceId: `trace-${accountId}`, method },
    () => api.handle({ method, headers, body }, res, new URL(`http://local${pathname}`))
  );
  return { handled, status: res.status, body: res.body, headers: responseHeaders };
}

let response = await request("account-a", "GET", "/api/v1/user-model");
assert.equal(response.status, 200);
assert.equal(response.body.data.candidateCount, 1);
assert.equal(response.body.data.claims[0].statement, "正在适应新的工作节奏");
assert.equal(response.body.meta.traceId, "trace-account-a");

response = await request("account-b", "GET", "/api/v1/user-model");
assert.equal(response.status, 200);
assert.deepEqual(response.body.data.claims, []);

await assert.rejects(
  request("account-a", "PATCH", "/api/v1/user-model/claims/claim-a", {
    body: { action: "confirm" }
  }),
  error => error.code === "PRECONDITION_REQUIRED" && error.statusCode === 428
);

response = await request("account-b", "PATCH", "/api/v1/user-model/claims/claim-a", {
  headers: { "if-match": "\"1\"" },
  body: { action: "confirm" }
});
assert.equal(response.status, 404);
assert.equal(response.body.error.code, "CLAIM_NOT_FOUND");

response = await request("account-a", "PATCH", "/api/v1/user-model/claims/claim-a", {
  headers: { "if-match": "\"1\"" },
  body: { action: "confirm", contextAllowed: true }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.claim.lifecycle, "active");
assert.equal(response.body.data.claim.version, 2);
assert.equal(response.headers.get("etag"), "\"2\"");

response = await request("account-a", "PATCH", "/api/v1/user-model/claims/claim-a", {
  headers: { "if-match": "\"1\"" },
  body: { action: "retract" }
});
assert.equal(response.status, 412);
assert.equal(response.body.error.details.currentVersion, 2);

response = await request("account-a", "PATCH", "/api/v1/user-model/claims/claim-a", {
  headers: { "if-match": "\"2\"" },
  body: {
    action: "revise",
    statement: "正在适应新的工作节奏，并需要减少频繁切换",
    epistemic: "hypothesis"
  }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.previous.lifecycle, "superseded");
assert.equal(response.body.data.claim.supersedes, "claim-a");
assert.equal(response.body.data.claim.lifecycle, "active");

stores.get("account-a").userClaims.unshift(candidate("claim-stale", "准备调整作息"));
stores.get("account-a").onboardingV2 = onboarding("原文已经改变", 2);
response = await request("account-a", "GET", "/api/v1/user-model");
assert.equal(response.body.data.claims.find(item => item.id === "claim-stale").lifecycle, "stale");
response = await request("account-a", "PATCH", "/api/v1/user-model/claims/claim-stale", {
  headers: { "if-match": "\"1\"" },
  body: { action: "confirm" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "CLAIM_SOURCE_STALE");
assert.equal(response.body.error.details.claim.lifecycle, "stale");

response = await request("account-a", "PATCH", "/api/v1/user-model/claims/claim-stale", {
  headers: { "if-match": "\"2\"" },
  body: { action: "unsupported" }
});
assert.equal(response.status, 422);
assert.equal(response.body.error.code, "CLAIM_ACTION_INVALID");

assert.strictEqual(openApiV1.paths["/user-model"], userModelOpenApiFragment.paths["/user-model"]);
assert.ok(openApiV1.paths["/user-model/claims/{id}"]);
assert.ok(openApiV1.components.schemas.UserClaim);
assert.equal(
  openApiV1.paths["/user-model/claims/{id}"].patch.parameters.some(parameter => (
    parameter.$ref === "#/components/parameters/IfMatch"
  )),
  true
);

console.log("User model API checks passed: envelopes, account isolation, ETag preconditions, confirmation, correction, stale-source conflicts and OpenAPI.");
