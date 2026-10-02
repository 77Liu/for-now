import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import { createAiTaskTargets, createBackgroundAi, createUserModelExtractionService } from "../src/app/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { defaultOnboarding, normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import {
  CLAIM_EXTRACTION_MAX_CANDIDATES,
  parseClaimExtractionOutput
} from "../src/modules/user-model/index.mjs";

const clone = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const original = "最近在适应新的工作节奏";
const onboarding = (text = original, revision = 1) => normalizeOnboardingV2({
  session: {
    status: "completed",
    step: "firstAction",
    revision,
    answers: {
      currentContext: {
        rawText: text,
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:00:00.000Z",
        version: revision,
        contextAllowed: true
      }
    },
    startedAt: "2026-10-02T01:00:00.000Z",
    completedAt: "2026-10-02T01:00:00.000Z",
    updatedAt: "2026-10-02T01:00:00.000Z"
  },
  migration: { selectedFlow: "v2" }
}, defaultOnboarding);

let store = {
  onboarding: clone(defaultOnboarding),
  onboardingV2: onboarding(),
  userClaims: [],
  modelUnknowns: [],
  aiTasks: [],
  notifications: []
};
const ledger = new Map();
const repository = {
  async read() {
    return clone(store);
  },
  async update(mutate) {
    const draft = clone(store);
    const result = await mutate(draft);
    store = draft;
    return clone(result);
  },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`;
    const prior = ledger.get(key);
    if (prior) {
      if (prior.requestHash !== request.requestHash) {
        throw Object.assign(new Error("idempotency conflict"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return clone(onReplay(clone(prior.response)));
    }
    const draft = clone(store);
    const response = await operation(draft);
    store = draft;
    ledger.set(key, { requestHash: request.requestHash, response: clone(response) });
    return clone(response);
  }
};

let id = 0;
let second = 0;
let generated = JSON.stringify({
  claims: [{
    domain: "context",
    statement: "最近正在适应新的工作节奏",
    scope: "最近",
    epistemic: "known",
    evidenceStrength: "self_report",
    evidence: [{ sourceId: "currentContext", span: [0, original.length] }]
  }],
  unknowns: [{
    question: "目前最需要调整的是哪一部分节奏？",
    domain: "behavior",
    reason: "这会影响下一步建议",
    impactOnNextAnswer: "决定建议先处理时间还是任务切换",
    relatedClaimIndexes: [0]
  }]
});
const scheduled = [];
const targets = createAiTaskTargets({
  thoughts: {},
  annotations: {},
  hash: digest,
  now: () => new Date(Date.UTC(2026, 9, 2, 2, 0, second++)).toISOString()
});
const backgroundAi = createBackgroundAi({
  repository,
  tasks: createTaskLifecycle({
    createId: () => `task-${++id}`,
    now: () => new Date(Date.UTC(2026, 9, 2, 2, 0, second++)).toISOString(),
    hash: digest
  }),
  notifications: createNotificationService({
    createId: () => `notification-${++id}`,
    now: () => new Date(Date.UTC(2026, 9, 2, 2, 0, second++)).toISOString()
  }),
  targets,
  generate: async work => {
    assert.equal(work.scene, "onboardingClaimExtraction");
    assert.equal(work.json, true);
    assert.equal(work.auditPrompt, false);
    return { content: generated, reasoningContent: "must not be persisted" };
  },
  dispatch: callback => scheduled.push(callback),
  contextKey: () => "account-a",
  onError: error => { throw error; }
});
const extractions = createUserModelExtractionService({ repository, backgroundAi });

assert.deepEqual(await extractions.enqueue({
  sourceRevision: 0,
  clientRequestId: "invalid"
}), {
  invalid: true,
  fields: { sourceRevision: "必须是当前五问 revision" }
});
assert.equal((await extractions.enqueue({
  sourceRevision: 2,
  clientRequestId: "wrong-version"
})).versionConflict, true);

const created = await extractions.enqueue({
  sourceRevision: 1,
  clientRequestId: "extract-1"
});
assert.equal(created.duplicate, false);
assert.equal(created.task.status, "queued");
assert.equal(created.task.kind, "onboardingClaimExtraction");
assert.equal(created.task.inputVersion, 1);
assert.equal(scheduled.length, 1);
const replay = await extractions.enqueue({
  sourceRevision: 1,
  clientRequestId: "extract-1"
});
assert.equal(replay.duplicate, true);
assert.equal(replay.task.id, created.task.id);
assert.equal(scheduled.length, 1);

await backgroundAi.run(created.task.id);
assert.equal(store.aiTasks.find(item => item.id === created.task.id).status, "succeeded");
assert.equal(store.userClaims.length, 1);
assert.equal(store.userClaims[0].lifecycle, "candidate");
assert.equal(store.userClaims[0].sourceTaskId, created.task.id);
assert.equal(store.userClaims[0].evidence[0].contentSha256, digest(original));
assert.equal(store.modelUnknowns[0].sourceTaskId, created.task.id);
assert.deepEqual(store.modelUnknowns[0].relatedEvidence, [store.userClaims[0].id]);
const result = await backgroundAi.getResult(created.task.id);
assert.equal(result.result.claims.length, 1);
assert.equal(result.result.unknowns.length, 1);
assert.equal((await extractions.get(created.task.id)).task.status, "succeeded");

store.onboardingV2 = onboarding("原文已经变化", 2);
const staleTask = await extractions.enqueue({
  sourceRevision: 2,
  clientRequestId: "extract-stale"
});
store.onboardingV2 = onboarding("任务创建后再次变化", 3);
await backgroundAi.run(staleTask.task.id);
assert.equal(store.aiTasks.find(item => item.id === staleTask.task.id).status, "stale");
assert.equal(store.userClaims.filter(item => item.sourceTaskId === staleTask.task.id).length, 0);

store.onboardingV2 = onboarding("用于失败测试的原文", 4);
generated = "{\"claims\":[{\"domain\":\"context\",\"statement\":\"无来源\",\"scope\":\"\",\"epistemic\":\"known\",\"evidenceStrength\":\"self_report\",\"evidence\":[{\"sourceId\":\"currentContext\",\"span\":[0,999]}]}],\"unknowns\":[]}";
const failedTask = await extractions.enqueue({
  sourceRevision: 4,
  clientRequestId: "extract-invalid-result"
});
await backgroundAi.run(failedTask.task.id);
assert.equal(store.aiTasks.find(item => item.id === failedTask.task.id).status, "failed");
assert.match(store.aiTasks.find(item => item.id === failedTask.task.id).error, /来源/);
assert.equal(store.userClaims.filter(item => item.sourceTaskId === failedTask.task.id).length, 0);

const source = {
  id: "currentContext",
  text: original,
  version: 1,
  contentSha256: digest(original)
};
assert.throws(() => parseClaimExtractionOutput(JSON.stringify({
  claims: Array.from({ length: CLAIM_EXTRACTION_MAX_CANDIDATES + 1 }, () => ({
    domain: "context",
    statement: "x",
    epistemic: "known",
    evidenceStrength: "self_report",
    evidence: [{ sourceId: source.id, span: [0, 1] }]
  })),
  unknowns: []
}), { sources: [source], sourceTaskId: "too-many" }), error => error.code === "CLAIM_EXTRACTION_INVALID");
assert.throws(() => parseClaimExtractionOutput(JSON.stringify({
  claims: [{
    domain: "context",
    statement: "x",
    epistemic: "known",
    evidenceStrength: "self_report",
    evidence: [{ sourceId: source.id, span: [0, 1] }],
    confidence: 0.9
  }],
  unknowns: []
}), { sources: [source], sourceTaskId: "extra-field" }), error => error.code === "CLAIM_EXTRACTION_INVALID");

store.onboardingV2 = onboarding("取消时保留的原文", 5);
const cancellable = await extractions.enqueue({
  sourceRevision: 5,
  clientRequestId: "extract-cancel"
});
const cancelled = await extractions.cancel(cancellable.task.id);
assert.equal(cancelled.status, "cancelled");
await backgroundAi.run(cancellable.task.id);
assert.equal(store.aiTasks.find(item => item.id === cancellable.task.id).status, "cancelled");
assert.equal(store.onboardingV2.session.answers.currentContext.rawText, "取消时保留的原文");
assert.equal(store.userClaims.filter(item => item.sourceTaskId === cancellable.task.id).length, 0);

store.onboardingV2 = onboarding("等待重启恢复", 6);
generated = JSON.stringify({ claims: [], unknowns: [] });
const recoverable = await extractions.enqueue({
  sourceRevision: 6,
  clientRequestId: "extract-recover"
});
scheduled.length = 0;
await backgroundAi.resume();
assert.deepEqual(scheduled.length, 1);
await backgroundAi.run(recoverable.task.id);
assert.equal(store.aiTasks.find(item => item.id === recoverable.task.id).status, "succeeded");

console.log("User model extraction checks passed: durable queueing, idempotency, strict JSON/span validation, candidate persistence, stale-source rejection, failure isolation, result lookup and restart recovery.");
