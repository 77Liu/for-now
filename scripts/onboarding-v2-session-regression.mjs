import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createOnboardingV2Service,
  defaultOnboarding,
  defaultOnboardingV2,
  normalizeOnboarding,
  normalizeOnboardingV2
} from "../src/modules/onboarding/index.mjs";
import {
  createApiV1Http,
  createOnboardingV2Http,
  onboardingV2OpenApiFragment,
  openApiV1
} from "../src/http/index.mjs";

const context = new AsyncLocalStorage();
const legacyAnswers = {
  evidence: "evidence",
  revision: "revise",
  truth_harmony: "gentle_truth",
  autonomy: "balance",
  stability: "small_bet",
  achievement: "sustainable",
  control: "act",
  meaning: "plural"
};
const legacyCompleted = normalizeOnboarding({
  ...defaultOnboarding,
  status: "completed",
  answers: legacyAnswers,
  understanding: "旧模型摘要"
});
const stores = new Map([
  ["account-a", {
    onboarding: structuredClone(defaultOnboarding),
    onboardingV2: structuredClone(defaultOnboardingV2)
  }],
  ["account-b", {
    onboarding: structuredClone(defaultOnboarding),
    onboardingV2: structuredClone(defaultOnboardingV2)
  }],
  ["account-legacy", {
    onboarding: legacyCompleted,
    onboardingV2: normalizeOnboardingV2(undefined, legacyCompleted)
  }]
]);
const ledgers = new Map();
const nowValues = [
  "2026-10-02T01:00:00.000Z",
  "2026-10-02T01:01:00.000Z",
  "2026-10-02T01:02:00.000Z",
  "2026-10-02T01:03:00.000Z",
  "2026-10-02T01:04:00.000Z",
  "2026-10-02T01:05:00.000Z"
];
let nowIndex = 0;

const repository = {
  async read() {
    return structuredClone(stores.get(context.getStore().accountId));
  },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const accountId = context.getStore().accountId;
    const ledger = ledgers.get(accountId) || new Map();
    ledgers.set(accountId, ledger);
    const ledgerKey = `${request.scope}:${request.key}`;
    const prior = ledger.get(ledgerKey);
    if (prior) {
      if (prior.requestHash !== request.requestHash) {
        throw Object.assign(new Error("同一幂等键不能用于不同内容"), {
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return structuredClone(onReplay(structuredClone(prior.response)));
    }
    const store = structuredClone(stores.get(accountId));
    const response = await operation(store);
    stores.set(accountId, store);
    ledger.set(ledgerKey, {
      requestHash: request.requestHash,
      response: structuredClone(response)
    });
    return structuredClone(response);
  }
};

const onboardingV2 = createOnboardingV2Service({
  repository,
  now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)]
});
const sendJson = (res, status, value) => {
  res.status = status;
  res.body = value;
  res.headersSent = true;
  return value;
};
const extractionRequests = [];
const http = createOnboardingV2Http({
  onboardingV2,
  extractions: {
    async enqueue(input) {
      extractionRequests.push(structuredClone(input));
      return {
        task: {
          id: "extraction-task-1",
          kind: "onboardingClaimExtraction",
          resourceType: "onboardingV2",
          targetId: "onboarding-v2",
          inputVersion: input.sourceRevision,
          status: "queued",
          createdAt: "2026-10-02T01:10:00.000Z"
        },
        duplicate: false
      };
    }
  },
  bodyJson: async req => req.body || {}
});
const api = createApiV1Http({
  sendJson,
  getContext: () => context.getStore(),
  openApi: openApiV1
});
api.register("onboarding-v2", http.handleV1);

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

let response = await request("account-a", "GET", "/api/v1/onboarding-v2/schema");
assert.equal(response.status, 200);
assert.equal(response.body.data.schemaVersion, 2);
assert.deepEqual(response.body.data.questions.map(item => item.questionId), [
  "currentContext",
  "desiredChanges",
  "recentObstacles",
  "dailyRhythm",
  "collaboration"
]);
assert.ok(response.body.data.questions.every(item => item.canSkip === true));
assert.equal(response.body.data.questions[0].limits.maxLength, 2000);
assert.equal(response.body.data.questions[1].limits.maxItems, 3);
assert.equal(response.body.data.questions[1].limits.itemMaxLength, 300);

response = await request("account-a", "GET", "/api/v1/onboarding-v2/session");
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 0);
assert.equal(response.body.data.session.step, "welcome");
assert.equal(response.headers.get("etag"), "\"1\"");

await assert.rejects(
  request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
    headers: { "idempotency-key": "missing-if-match" },
    body: { step: "q1" }
  }),
  error => error.code === "PRECONDITION_REQUIRED" && error.statusCode === 428
);

const firstPatch = {
  status: "draft",
  step: "q2",
  answers: {
    currentContext: {
      rawText: "我正在适应新的工作节奏。",
      occurredAt: "2026-10-02T00:30:00.000Z",
      contextAllowed: true
    }
  }
};
response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-a-1" },
  body: firstPatch
});
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 1);
assert.equal(response.body.data.session.answers.currentContext.version, 1);
assert.equal(response.body.data.session.answers.currentContext.rawText, "我正在适应新的工作节奏。");
assert.equal(response.headers.get("etag"), "\"2\"");
const firstReplayBody = structuredClone(response.body);

response = await request("account-a", "POST", "/api/v1/onboarding-v2/extractions", {
  headers: { "idempotency-key": "extract-account-a-1" },
  body: { sourceRevision: 1 }
});
assert.equal(response.status, 202);
assert.equal(response.body.data.kind, "onboardingClaimExtraction");
assert.deepEqual(extractionRequests, [{
  sourceRevision: 1,
  clientRequestId: "extract-account-a-1"
}]);

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-a-1" },
  body: firstPatch
});
assert.equal(response.status, 200);
assert.deepEqual(response.body, firstReplayBody);
assert.equal(response.headers.get("etag"), "\"2\"");

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"2\"", "idempotency-key": "onboarding-a-1" },
  body: { ...firstPatch, step: "q3" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-a-stale" },
  body: { step: "q3" }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "ONBOARDING_SESSION_CONFLICT");
assert.equal(response.body.error.details.currentRevision, 1);
assert.equal(response.body.error.details.currentEtag, "\"2\"");
assert.equal(
  response.body.error.details.currentSession.answers.currentContext.rawText,
  "我正在适应新的工作节奏。"
);

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"2\"", "idempotency-key": "onboarding-a-2" },
  body: {
    status: "paused",
    step: "q3",
    answers: {
      desiredChanges: {
        structuredValue: [
          { text: "建立稳定的写作节奏", horizon: "3m" },
          { text: "推进当前项目", horizon: "unknown" }
        ],
        contextAllowed: true
      }
    }
  }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 2);
assert.equal(response.body.data.session.status, "paused");
assert.equal(response.body.data.session.answers.currentContext.version, 1);
assert.equal(response.body.data.session.answers.desiredChanges.version, 1);
assert.equal(response.body.data.session.answers.desiredChanges.structuredValue.length, 2);

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"3\"", "idempotency-key": "onboarding-a-3" },
  body: {
    status: "draft",
    step: "review",
    answers: {
      currentContext: {
        rawText: "我正在适应新的工作节奏，也希望减少频繁切换。",
        occurredAt: "2026-10-02T00:30:00.000Z",
        contextAllowed: true
      }
    },
    collaboration: {
      responseLength: { value: "concise", source: "user" },
      challengeStyle: { value: "direct", source: "user" },
      additionalBoundary: "不要替我做心理诊断。",
      contextAllowed: true
    }
  }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 3);
assert.equal(response.body.data.session.answers.currentContext.version, 2);
assert.equal(response.body.data.session.answers.desiredChanges.version, 1);
assert.deepEqual(response.body.data.session.collaboration.responseLength, {
  value: "concise",
  source: "user"
});
assert.deepEqual(response.body.data.session.collaboration.suggestionMode, {
  value: "actionFirst",
  source: "system_default"
});

const answersBeforeDiscard = structuredClone(response.body.data.session.answers);
const collaborationBeforeDiscard = structuredClone(response.body.data.session.collaboration);
response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"4\"", "idempotency-key": "onboarding-a-discard" },
  body: {
    selectedFlow: "v2",
    status: "skipped",
    step: "firstAction"
  }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 4);
assert.equal(response.body.data.session.status, "skipped");
assert.equal(response.body.data.session.step, "firstAction");
assert.deepEqual(response.body.data.session.answers, answersBeforeDiscard);
assert.deepEqual(response.body.data.session.collaboration, collaborationBeforeDiscard);
assert.equal(response.body.data.session.pausedAt, "");
assert.equal(response.body.data.migration.selectedFlow, "v2");

response = await request("account-b", "GET", "/api/v1/onboarding-v2/session");
assert.equal(response.status, 200);
assert.equal(response.body.data.session.revision, 0);
assert.deepEqual(response.body.data.session.answers, {});
assert.equal(response.headers.get("etag"), "\"1\"");

response = await request("account-b", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"1\"", "idempotency-key": "onboarding-b-skip-all" },
  body: { status: "completed", step: "firstAction" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.session.status, "completed");
assert.equal(response.body.data.session.step, "firstAction");
assert.equal(response.body.data.readiness, "empty");
assert.deepEqual(response.body.data.session.answers, {});

response = await request("account-legacy", "GET", "/api/v1/onboarding-v2/session");
assert.equal(response.status, 200);
assert.equal(response.body.data.session.status, "skipped");
assert.equal(response.body.data.session.step, "firstAction");
assert.equal(response.body.data.migration.entryPolicy, "already_onboarded");
assert.equal(response.body.data.migration.legacy.modelSummaryType, "model_summary");

response = await request("account-a", "PATCH", "/api/v1/onboarding-v2/session", {
  headers: { "if-match": "\"5\"", "idempotency-key": "onboarding-a-invalid" },
  body: {
    answers: {
      currentContext: { rawText: "x".repeat(2001) }
    }
  }
});
assert.equal(response.status, 422);
assert.equal(response.body.error.code, "ONBOARDING_SESSION_INVALID");
assert.deepEqual(response.body.error.details.fields, {
  "answers.currentContext.rawText": "最多 2000 个字符"
});

assert.strictEqual(
  openApiV1.paths["/onboarding-v2/session"],
  onboardingV2OpenApiFragment.paths["/onboarding-v2/session"]
);
assert.ok(openApiV1.paths["/onboarding-v2/schema"]);
assert.ok(openApiV1.paths["/onboarding-v2/extractions"]);
assert.ok(openApiV1.components.schemas.OnboardingV2Session);
assert.equal(
  openApiV1.paths["/onboarding-v2/session"].patch.parameters.some(parameter => (
    parameter.$ref === "#/components/parameters/IfMatch"
  )),
  true
);
assert.equal(
  openApiV1.paths["/onboarding-v2/extractions"].post.parameters.some(parameter => (
    parameter.$ref === "#/components/parameters/IdempotencyKey"
  )),
  true
);
assert.equal(
  openApiV1.paths["/onboarding-v2/session"].patch.parameters.some(parameter => (
    parameter.$ref === "#/components/parameters/IdempotencyKey"
  )),
  true
);


// 完成问答与抽取创建同事务可见；事务提交后才允许调度。
let atomicStore = { onboardingV2: structuredClone(defaultOnboardingV2), aiTasks: [] };
let committed = false;
let scheduledAfterCommit = false;
const atomicService = createOnboardingV2Service({
  repository: {
    async read() { return structuredClone(atomicStore); },
    async executeIdempotent(_request, mutate) {
      const draft = structuredClone(atomicStore);
      const result = mutate(draft);
      assert.equal(draft.onboardingV2.session.status, "completed");
      assert.equal(draft.aiTasks.length, 1, "completed不可先于整理任务落盘");
      atomicStore = draft;
      committed = true;
      return structuredClone(result);
    }
  },
  onCompleted(store, session) {
    assert.equal(committed, false);
    const task = { id: "atomic-extraction", status: "queued", inputVersion: session.session.revision };
    store.aiTasks.push(task);
    return { task };
  },
  async afterCompleted(result) {
    assert.equal(committed, true);
    assert.equal(result.task.id, "atomic-extraction");
    scheduledAfterCommit = true;
  }
});
await atomicService.patch({ status: "completed", step: "firstAction" }, {
  expectedVersion: 1, clientRequestId: "atomic-complete"
});
assert.equal(scheduledAfterCommit, true);

console.log("Onboarding v2 session contracts passed: stable schema, partial recovery, non-destructive discard, answer versions, ETag conflicts, idempotency and account isolation.");
