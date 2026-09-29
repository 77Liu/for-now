import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import {
  createFeedbackService,
  feedbackPayload,
  financialRecordPayload,
  participationRecordPayload,
  validationPlanPayload
} from "../src/modules/feedback/index.mjs";
import {
  feedbackSubmissionPayload,
  feedbackViewModel,
  financialRecordSubmissionPayload,
  participationRecordSubmissionPayload,
  validationLedgerViewModel,
  validationPlanSubmissionPayload
} from "../public/frontend/features/feedback/index.mjs";

const context = new AsyncLocalStorage();
const emptyStore = () => ({ feedback: [], validationLedger: [] });
const accounts = new Map([
  ["account-a", emptyStore()],
  ["account-b", emptyStore()]
]);
const failedCommits = new Set();
const updateAttempts = new Map();
const repository = {
  async read() {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires account context");
    return structuredClone(accounts.get(accountId));
  },
  async update(mutate) {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires account context");
    const next = structuredClone(accounts.get(accountId));
    const result = await mutate(next);
    updateAttempts.set(accountId, (updateAttempts.get(accountId) || 0) + 1);
    if (failedCommits.delete(accountId)) throw new Error("simulated commit failure");
    accounts.set(accountId, next);
    return result;
  }
};
const run = (accountId, operation) => context.run(accountId, operation);

let sequence = 0;
let clock = Date.parse("2026-09-29T08:00:00.000Z");
const service = createFeedbackService({
  repository,
  createId: () => `feedback-domain-${++sequence}`,
  now: () => new Date(clock++).toISOString()
});

const baseFeedback = {
  type: "bug",
  feature: "思绪回答",
  appVersion: "0.2.0",
  body: "重复提交后不应产生两条反馈",
  context: { selected: false, summary: "不得在未选择时保存" },
  privateRecords: [{ id: "private-journal", body: "私人原文" }],
  accountId: "attempted-cross-account"
};

const attemptsBeforeInvalid = updateAttempts.get("account-a") || 0;
assert.equal(feedbackPayload({ ...baseFeedback, type: "unknown" }).code, "FEEDBACK_TYPE_INVALID");
assert.equal(feedbackPayload({ ...baseFeedback, feature: "" }).code, "FEEDBACK_FEATURE_REQUIRED");
assert.equal(feedbackPayload({ ...baseFeedback, appVersion: "" }).code, "FEEDBACK_APP_VERSION_REQUIRED");
assert.equal(feedbackPayload({ ...baseFeedback, body: "" }).code, "FEEDBACK_BODY_REQUIRED");
assert.equal(feedbackPayload({
  ...baseFeedback,
  context: { selected: true, summary: "" }
}).code, "FEEDBACK_CONTEXT_SUMMARY_REQUIRED");
assert.equal((await run("account-a", () => service.submitFeedback(baseFeedback))).code, "IDEMPOTENCY_KEY_REQUIRED");
assert.equal(updateAttempts.get("account-a") || 0, attemptsBeforeInvalid);

const submitted = await run("account-a", () => service.submitFeedback(baseFeedback, {
  clientRequestId: "same-feedback"
}));
assert.equal(submitted.duplicate, false);
assert.equal(submitted.value.status, "submitted");
assert.equal(submitted.value.version, 1);
assert.deepEqual(submitted.value.context, { selected: false, summary: "" });
for (const forbidden of ["privateRecords", "accountId"]) {
  assert.equal(Object.hasOwn(submitted.value, forbidden), false);
}
assert.doesNotMatch(JSON.stringify(accounts.get("account-a")), /私人原文|attempted-cross-account/);

const duplicate = await run("account-a", () => service.submitFeedback({
  ...baseFeedback,
  privateRecords: [{ body: "不同的私人原文也不参与请求摘要" }]
}, {
  clientRequestId: "same-feedback"
}));
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.value.id, submitted.value.id);
assert.equal(accounts.get("account-a").feedback.length, 1);
const reused = await run("account-a", () => service.submitFeedback({
  ...baseFeedback,
  body: "同键不同内容"
}, { clientRequestId: "same-feedback" }));
assert.deepEqual({ conflict: reused.conflict, code: reused.code }, {
  conflict: true,
  code: "IDEMPOTENCY_KEY_REUSED"
});
assert.equal(accounts.get("account-a").feedback.length, 1);

const otherAccount = await run("account-b", () => service.submitFeedback(baseFeedback, {
  clientRequestId: "same-feedback"
}));
assert.equal(otherAccount.duplicate, false);
assert.notEqual(otherAccount.value.id, submitted.value.id);
assert.equal((await run("account-b", () => service.getFeedback(submitted.value.id))), null);
assert.deepEqual(await run("account-b", () => service.transitionFeedback(
  submitted.value.id,
  "reviewing",
  { expectedVersion: 1 }
)), { missing: true });

const optedIn = await run("account-a", () => service.submitFeedback({
  ...baseFeedback,
  type: "experience",
  body: "主动附带当前页面摘要",
  context: {
    selected: true,
    summary: "当前页面：思绪详情；操作：生成回答；不含日记正文",
    records: [{ body: "即使放在 context 内也不能保存" }]
  }
}, { clientRequestId: "feedback-with-context" }));
assert.deepEqual(optedIn.value.context, {
  selected: true,
  summary: "当前页面：思绪详情；操作：生成回答；不含日记正文"
});
assert.doesNotMatch(JSON.stringify(optedIn.value), /即使放在 context/);

const versionRequired = await run("account-a", () => service.transitionFeedback(submitted.value.id, "reviewing"));
assert.equal(versionRequired.code, "VERSION_REQUIRED");
assert.equal((await run("account-a", () => service.getFeedback(submitted.value.id))).version, 1);
const reviewing = await run("account-a", () => service.transitionFeedback(
  submitted.value.id,
  "reviewing",
  { expectedVersion: 1 }
));
assert.equal(reviewing.value.version, 2);
assert.equal(reviewing.value.status, "reviewing");
assert.deepEqual(await run("account-a", () => service.transitionFeedback(
  submitted.value.id,
  "planned",
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });
assert.equal((await run("account-a", () => service.transitionFeedback(
  submitted.value.id,
  "reopened",
  { expectedVersion: 2 }
))).code, "FEEDBACK_STATUS_TRANSITION_INVALID");

const beforeFailedFeedbackTransition = structuredClone(accounts.get("account-a"));
failedCommits.add("account-a");
await assert.rejects(run("account-a", () => service.transitionFeedback(
  submitted.value.id,
  "planned",
  { expectedVersion: 2 }
)), /simulated commit failure/);
assert.deepEqual(accounts.get("account-a"), beforeFailedFeedbackTransition);

const beforeFailedSubmission = structuredClone(accounts.get("account-a"));
failedCommits.add("account-a");
await assert.rejects(run("account-a", () => service.submitFeedback({
  ...baseFeedback,
  body: "第一次提交失败"
}, { clientRequestId: "retry-after-failure" })), /simulated commit failure/);
assert.deepEqual(accounts.get("account-a"), beforeFailedSubmission);
const retryAfterFailure = await run("account-a", () => service.submitFeedback({
  ...baseFeedback,
  body: "第一次提交失败"
}, { clientRequestId: "retry-after-failure" }));
assert.equal(retryAfterFailure.duplicate, false);

const maliciousPlan = {
  participantRef: "成员-07",
  plan: {
    cohort: "项目成员首轮",
    goal: "验证核心记录流程",
    tasks: ["完成一次状态记录", "提交一条功能反馈"],
    plannedStartOn: "2026-10-01",
    plannedEndOn: "2026-10-07",
    compensationBudgetMinor: 10000,
    rewardBudgetMinor: 2000,
    notes: "仅为安排，不是参与证据"
  },
  status: "closed",
  consent: { status: "agreed", noticeVersion: "fake" },
  actualParticipation: true,
  participationRecords: [{ evidenceRef: "fabricated" }],
  compensationRecords: [{ status: "paid", amountMinor: 10000 }]
};
assert.equal(validationPlanPayload({
  ...maliciousPlan,
  plan: { ...maliciousPlan.plan, plannedEndOn: "2026-09-30" }
}).code, "VALIDATION_PLAN_DATE_ORDER");
assert.equal(validationPlanPayload({
  ...maliciousPlan,
  plan: { ...maliciousPlan.plan, compensationBudgetMinor: 1.5 }
}).code, "VALIDATION_PLAN_BUDGET_INVALID");

const validation = await run("account-a", () => service.createValidationPlan(maliciousPlan, {
  clientRequestId: "validation-member-07"
}));
assert.equal(validation.value.status, "planned");
assert.equal(validation.value.version, 1);
assert.equal(validation.value.consent.status, "pending");
assert.deepEqual(validation.value.participationRecords, []);
assert.deepEqual(validation.value.compensationRecords, []);
assert.deepEqual(validation.value.rewardRecords, []);
assert.equal(Object.hasOwn(validation.value, "actualParticipation"), false);
assert.equal((await run("account-a", () => service.createValidationPlan(
  maliciousPlan,
  { clientRequestId: "validation-member-07" }
))).duplicate, true);
assert.equal((await run("account-a", () => service.createValidationPlan(
  { ...maliciousPlan, participantRef: "成员-08" },
  { clientRequestId: "validation-member-07" }
))).code, "IDEMPOTENCY_KEY_REUSED");
assert.equal(await run("account-b", () => service.getValidation(validation.value.id)), null);
const otherAccountValidation = await run("account-b", () => service.createValidationPlan(
  maliciousPlan,
  { clientRequestId: "validation-member-07" }
));
assert.equal(otherAccountValidation.duplicate, false);
assert.notEqual(otherAccountValidation.value.id, validation.value.id);

const noConsentEvidence = await run("account-a", () => service.recordParticipation(
  validation.value.id,
  {
    type: "session",
    occurredAt: "2026-10-01T01:00:00.000Z",
    evidenceRef: "session-note-01",
    outcome: "完成状态记录"
  },
  { expectedVersion: 1 }
));
assert.equal(noConsentEvidence.code, "PARTICIPATION_CONSENT_REQUIRED");
assert.equal((await run("account-a", () => service.getValidation(validation.value.id))).version, 1);
assert.equal((await run("account-a", () => service.transitionValidation(
  validation.value.id,
  "consented",
  { expectedVersion: 1 }
))).code, "CONSENT_ACTION_REQUIRED");

const consented = await run("account-a", () => service.recordConsent(
  validation.value.id,
  { noticeVersion: "privacy-v1.0" },
  { expectedVersion: 1 }
));
assert.equal(consented.value.status, "consented");
assert.equal(consented.value.consent.status, "agreed");
assert.equal(consented.value.version, 2);
assert.deepEqual(await run("account-a", () => service.transitionValidation(
  validation.value.id,
  "in_progress",
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });
const inProgress = await run("account-a", () => service.transitionValidation(
  validation.value.id,
  "in_progress",
  { expectedVersion: 2 }
));
assert.equal(inProgress.value.status, "in_progress");
assert.equal(inProgress.value.version, 3);
assert.equal(validationLedgerViewModel(inProgress.value).actualParticipation, false);
assert.equal(validationLedgerViewModel(inProgress.value).resultLabel, "仅有计划，暂无真实参与结果");

const compensation = await run("account-a", () => service.recordCompensation(
  validation.value.id,
  {
    amountMinor: 10000,
    status: "planned",
    basis: "访谈补偿"
  },
  { expectedVersion: 3 }
));
assert.equal(compensation.value.kind, "compensation");
assert.equal(compensation.ledger.version, 4);
assert.equal(financialRecordPayload("reward", {
  amountMinor: 2000,
  status: "paid"
}).code, "FINANCIAL_RECORD_PAYMENT_EVIDENCE_REQUIRED");
assert.equal((await run("account-a", () => service.recordReward(
  validation.value.id,
  {
    amountMinor: 2000,
    status: "paid",
    paidAt: "2026-10-08T09:30:00.000Z",
    reference: "payment-ledger-02",
    basis: "D7 使用奖励"
  },
  { expectedVersion: 4 }
))).ledger.version, 5);
assert.equal(participationRecordPayload({
  type: "session",
  occurredAt: "2026-10-02T02:00:00.000Z"
}).code, "PARTICIPATION_EVIDENCE_REQUIRED");

const participation = await run("account-a", () => service.recordParticipation(
  validation.value.id,
  {
    type: "session",
    occurredAt: "2026-10-02T02:00:00.000Z",
    evidenceRef: "session-note-01",
    outcome: "完成一次状态记录并提交过程反馈"
  },
  { expectedVersion: 5 }
));
assert.equal(participation.ledger.version, 6);
assert.equal(participation.ledger.participationRecords.length, 1);
const ledgerView = validationLedgerViewModel(participation.ledger);
assert.equal(ledgerView.actualParticipation, true);
assert.equal(ledgerView.actualResultCount, 1);
assert.deepEqual(ledgerView.compensation, {
  recordCount: 1,
  plannedMinor: 10000,
  paidMinor: 0
});
assert.deepEqual(ledgerView.reward, {
  recordCount: 1,
  plannedMinor: 2000,
  paidMinor: 2000
});

const withdrawn = await run("account-a", () => service.withdrawValidation(
  validation.value.id,
  { reason: "参与者主动退出" },
  { expectedVersion: 6 }
));
assert.equal(withdrawn.value.status, "withdrawn");
assert.equal(withdrawn.value.consent.status, "withdrawn");
assert.equal(withdrawn.value.version, 7);
assert.deepEqual(withdrawn.value.statusHistory.map(item => item.version), [1, 2, 3, 7]);
assert.equal((await run("account-a", () => service.recordParticipation(
  validation.value.id,
  {
    type: "feedback",
    occurredAt: "2026-10-03T02:00:00.000Z",
    evidenceRef: "after-withdrawal"
  },
  { expectedVersion: 7 }
))).code, "PARTICIPATION_CONSENT_REQUIRED");

const beforeFailedFinancialRecord = structuredClone(accounts.get("account-a"));
failedCommits.add("account-a");
await assert.rejects(run("account-a", () => service.recordReward(
  validation.value.id,
  {
    amountMinor: 500,
    status: "approved",
    basis: "不应提交"
  },
  { expectedVersion: 7 }
)), /simulated commit failure/);
assert.deepEqual(accounts.get("account-a"), beforeFailedFinancialRecord);

const secondPlan = await run("account-a", () => service.createValidationPlan({
  participantRef: "成员-09",
  plan: { goal: "验证同意回滚", tasks: ["查看说明"] }
}, { clientRequestId: "validation-member-09" }));
const beforeFailedConsent = structuredClone(accounts.get("account-a"));
failedCommits.add("account-a");
await assert.rejects(run("account-a", () => service.recordConsent(
  secondPlan.value.id,
  { noticeVersion: "privacy-v1.0" },
  { expectedVersion: 1 }
)), /simulated commit failure/);
assert.deepEqual(accounts.get("account-a"), beforeFailedConsent);

const frontendSource = await fs.readFile(
  new URL("../public/frontend/features/feedback/index.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(frontendSource, /\b(?:fetch|XMLHttpRequest|document|window)\b/);

const privateDraft = {
  type: "feature",
  feature: "小物",
  body: "希望支持批量录入",
  privateRecords: [{ body: "日记原文" }],
  contextSummary: "这段摘要也需要明确选择后才能发送"
};
assert.deepEqual(feedbackSubmissionPayload(privateDraft, { appVersion: "0.2.0" }), {
  type: "feature",
  feature: "小物",
  appVersion: "0.2.0",
  body: "希望支持批量录入",
  context: { selected: false, summary: "" }
});
assert.deepEqual(feedbackSubmissionPayload({
  ...privateDraft,
  includeContext: true
}, { appVersion: "0.2.0" }).context, {
  selected: true,
  summary: "这段摘要也需要明确选择后才能发送"
});
const feedbackView = feedbackViewModel(submitted.value);
assert.equal(feedbackView.contextIncluded, false);
assert.equal(feedbackView.contextLabel, "未附带私人记录");
assert.equal(Object.hasOwn(feedbackView, "requestHash"), false);

const frontendPlan = validationPlanSubmissionPayload(maliciousPlan);
assert.deepEqual(Object.keys(frontendPlan).sort(), ["participantRef", "plan"]);
assert.equal(Object.hasOwn(frontendPlan.plan, "status"), false);
assert.equal(Object.hasOwn(frontendPlan, "participationRecords"), false);
assert.deepEqual(financialRecordSubmissionPayload("reward", {
  amountMinor: 2000,
  status: "planned",
  paidAt: "must-not-leak",
  reference: "must-not-leak"
}), {
  kind: "reward",
  amountMinor: 2000,
  status: "planned",
  basis: "",
  paidAt: "",
  reference: "",
  note: ""
});
assert.deepEqual(participationRecordSubmissionPayload({
  type: "interview",
  occurredAt: "2026-10-08T09:00:00.000Z",
  evidenceRef: "interview-note-01",
  outcome: "完成访谈",
  planned: true,
  status: "completed"
}), {
  type: "interview",
  occurredAt: "2026-10-08T09:00:00.000Z",
  evidenceRef: "interview-note-01",
  outcome: "完成访谈"
});
assert.equal(validationLedgerViewModel({
  ...validation.value,
  status: "in_progress",
  participationRecords: []
}).actualParticipation, false);

assert.equal((await run("account-a", () => service.listFeedback())).items.length, 3);
assert.equal((await run("account-b", () => service.listFeedback())).items.length, 1);
assert.equal((await run("account-a", () => service.listValidation())).items.length, 2);
assert.equal((await run("account-b", () => service.listValidation())).items.length, 1);

console.log("G2-D feedback regression passed: explicit context privacy, idempotency, versioned transitions, consent/withdrawal, evidence-only participation, financial separation, account isolation and rollback.");
