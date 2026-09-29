export const feedbackTypeLabels = Object.freeze({
  bug: "问题",
  feature: "功能建议",
  experience: "体验反馈",
  other: "其他"
});

export const feedbackStatusLabels = Object.freeze({
  submitted: "已提交",
  reviewing: "处理中",
  planned: "已纳入计划",
  resolved: "已解决",
  closed: "已关闭",
  reopened: "已重新打开"
});

export const validationStatusLabels = Object.freeze({
  planned: "计划中",
  invited: "已邀请",
  consented: "已同意",
  in_progress: "验证中",
  follow_up: "待回访",
  closed: "已关闭",
  withdrawn: "已退出"
});

const text = (value, max) => String(value ?? "").trim().slice(0, max);
const stringList = (values, maxItems, maxLength) => (Array.isArray(values) ? values : [])
  .map(value => text(value, maxLength))
  .filter(Boolean)
  .slice(0, maxItems);
const minor = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
const records = value => Array.isArray(value) ? value : [];
const sum = (items, predicate = () => true) => items
  .filter(predicate)
  .reduce((total, item) => total + minor(item.amountMinor), 0);

export function feedbackSubmissionPayload(input = {}, defaults = {}) {
  const source = input.context && typeof input.context === "object" ? input.context : {};
  const selected = input.includeContext === true || source.selected === true;
  const appVersion = text(input.appVersion, 40) || text(defaults.appVersion, 40);
  return {
    type: text(input.type, 40),
    feature: text(input.feature, 120),
    appVersion,
    body: text(input.body, 12000),
    context: {
      selected,
      summary: selected ? text(input.contextSummary ?? source.summary, 2000) : ""
    }
  };
}

export function feedbackViewModel(item = {}) {
  const context = item.context && typeof item.context === "object" ? item.context : {};
  const contextIncluded = context.selected === true && Boolean(text(context.summary, 2000));
  return {
    id: text(item.id, 120),
    type: text(item.type, 40),
    typeLabel: feedbackTypeLabels[item.type] || feedbackTypeLabels.other,
    feature: text(item.feature, 120),
    appVersion: text(item.appVersion, 40),
    body: text(item.body, 12000),
    status: text(item.status, 20),
    statusLabel: feedbackStatusLabels[item.status] || "未知状态",
    version: Math.max(1, Math.round(Number(item.version) || 1)),
    createdAt: text(item.createdAt, 40),
    updatedAt: text(item.updatedAt, 40),
    contextIncluded,
    contextSummary: contextIncluded ? text(context.summary, 2000) : "",
    contextLabel: contextIncluded ? "已主动附带上下文摘要" : "未附带私人记录"
  };
}

export function validationPlanSubmissionPayload(input = {}) {
  const source = input.plan && typeof input.plan === "object" ? input.plan : input;
  return {
    participantRef: text(input.participantRef, 120),
    plan: {
      cohort: text(source.cohort, 80),
      goal: text(source.goal, 500),
      tasks: stringList(source.tasks, 20, 240),
      plannedStartOn: text(source.plannedStartOn, 10),
      plannedEndOn: text(source.plannedEndOn, 10),
      compensationBudgetMinor: minor(source.compensationBudgetMinor),
      rewardBudgetMinor: minor(source.rewardBudgetMinor),
      notes: text(source.notes, 2000)
    }
  };
}

export const consentSubmissionPayload = input => ({
  noticeVersion: text(input?.noticeVersion, 80)
});

export const withdrawalSubmissionPayload = input => ({
  reason: text(input?.reason, 1000)
});

export function financialRecordSubmissionPayload(kind, input = {}) {
  const status = text(input.status, 20) || "planned";
  return {
    kind: kind === "reward" ? "reward" : "compensation",
    amountMinor: minor(input.amountMinor),
    status,
    basis: text(input.basis, 500),
    paidAt: status === "paid" ? text(input.paidAt, 40) : "",
    reference: status === "paid" ? text(input.reference, 240) : "",
    note: text(input.note, 1000)
  };
}

export function participationRecordSubmissionPayload(input = {}) {
  return {
    type: text(input.type, 40),
    occurredAt: text(input.occurredAt, 40),
    evidenceRef: text(input.evidenceRef, 500),
    outcome: text(input.outcome, 2000)
  };
}

function moneyView(items) {
  return {
    recordCount: items.length,
    plannedMinor: sum(items, item => item.status !== "cancelled"),
    paidMinor: sum(items, item => item.status === "paid")
  };
}

export function validationLedgerViewModel(item = {}) {
  const participationRecords = records(item.participationRecords);
  const compensation = moneyView(records(item.compensationRecords));
  const reward = moneyView(records(item.rewardRecords));
  const consent = item.consent && typeof item.consent === "object" ? item.consent : {};
  const actualParticipation = participationRecords.length > 0;
  return {
    id: text(item.id, 120),
    participantRef: text(item.participantRef, 120),
    status: text(item.status, 20),
    statusLabel: validationStatusLabels[item.status] || "未知状态",
    version: Math.max(1, Math.round(Number(item.version) || 1)),
    consentStatus: text(consent.status, 20) || "pending",
    consentLabel: consent.status === "agreed" ? `已同意 ${text(consent.noticeVersion, 80)}` : consent.status === "withdrawn" ? "已退出" : "待同意",
    plan: {
      cohort: text(item.plan?.cohort, 80),
      goal: text(item.plan?.goal, 500),
      tasks: stringList(item.plan?.tasks, 20, 240),
      plannedStartOn: text(item.plan?.plannedStartOn, 10),
      plannedEndOn: text(item.plan?.plannedEndOn, 10)
    },
    compensation,
    reward,
    actualParticipation,
    actualResultCount: participationRecords.length,
    resultLabel: actualParticipation ? `${participationRecords.length} 条有证据的参与记录` : "仅有计划，暂无真实参与结果"
  };
}

export const buildFeedbackPayload = feedbackSubmissionPayload;
export const createFeedbackViewModel = feedbackViewModel;
export const buildValidationPlanPayload = validationPlanSubmissionPayload;
export const createValidationLedgerViewModel = validationLedgerViewModel;
