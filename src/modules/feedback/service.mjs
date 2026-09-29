import crypto from "node:crypto";
import { recordVersion, safeIso, safeText } from "../../shared/validation/index.mjs";

export const FEEDBACK_TYPES = Object.freeze(["bug", "feature", "experience", "other"]);
export const FEEDBACK_STATUSES = Object.freeze(["submitted", "reviewing", "planned", "resolved", "closed", "reopened"]);
export const VALIDATION_STATUSES = Object.freeze(["planned", "invited", "consented", "in_progress", "follow_up", "closed", "withdrawn"]);
export const FINANCIAL_RECORD_STATUSES = Object.freeze(["planned", "approved", "paid", "cancelled"]);
export const PARTICIPATION_RECORD_TYPES = Object.freeze(["session", "feedback", "interview", "retention"]);

const feedbackTransitions = Object.freeze({
  submitted: ["reviewing", "closed"],
  reviewing: ["planned", "resolved", "closed"],
  planned: ["reviewing", "resolved", "closed"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["reviewing", "planned", "resolved", "closed"]
});

const validationTransitions = Object.freeze({
  planned: ["invited", "closed"],
  invited: ["closed"],
  consented: ["in_progress", "follow_up", "closed"],
  in_progress: ["follow_up", "closed"],
  follow_up: ["closed"],
  closed: [],
  withdrawn: []
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const objectValue = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const failure = (code, error, details = undefined) => ({
  error,
  code,
  ...(details === undefined ? {} : { details })
});
const cleanList = (values, maxItems, maxLength) => (Array.isArray(values) ? values : [])
  .map(value => safeText(value, maxLength))
  .filter(Boolean)
  .slice(0, maxItems);

function dateKey(value) {
  const text = safeText(value, 10);
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? text
    : null;
}

function moneyMinor(value) {
  if (value === "" || value == null) return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function readStore(value) {
  const store = objectValue(value);
  return {
    feedback: Array.isArray(store.feedback) ? store.feedback : [],
    validationLedger: Array.isArray(store.validationLedger) ? store.validationLedger : []
  };
}

function writableStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("feedback repository must update an object");
  }
  if (!Array.isArray(value.feedback)) value.feedback = [];
  if (!Array.isArray(value.validationLedger)) value.validationLedger = [];
  return value;
}

function expectedRecordVersion(entry, options) {
  const currentVersion = recordVersion(entry.version);
  const expectedVersion = Number(options?.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return failure("VERSION_REQUIRED", "需要提供当前版本", { currentVersion });
  }
  if (expectedVersion !== currentVersion) return { versionConflict: true, currentVersion };
  return { currentVersion };
}

function nextVersion(entry, currentVersion, now) {
  entry.version = currentVersion + 1;
  entry.updatedAt = now();
}

export function feedbackPayload(input = {}) {
  const type = safeText(input.type, 40);
  const feature = safeText(input.feature, 120);
  const appVersion = safeText(input.appVersion, 40);
  const body = safeText(input.body, 12000);
  if (!FEEDBACK_TYPES.includes(type)) return failure("FEEDBACK_TYPE_INVALID", "反馈类型无效");
  if (!feature) return failure("FEEDBACK_FEATURE_REQUIRED", "请选择相关功能");
  if (!appVersion) return failure("FEEDBACK_APP_VERSION_REQUIRED", "缺少应用版本");
  if (!body) return failure("FEEDBACK_BODY_REQUIRED", "请填写反馈正文");

  const contextInput = objectValue(input.context);
  const selected = contextInput.selected === true;
  const summary = selected ? safeText(contextInput.summary, 2000) : "";
  if (selected && !summary) {
    return failure("FEEDBACK_CONTEXT_SUMMARY_REQUIRED", "选择附带上下文时必须提供摘要");
  }
  return {
    value: {
      type,
      feature,
      appVersion,
      body,
      context: { selected, summary }
    }
  };
}

export function validationPlanPayload(input = {}) {
  const participantRef = safeText(input.participantRef, 120);
  if (!participantRef) return failure("VALIDATION_PARTICIPANT_REQUIRED", "请填写参与者代号");
  const source = objectValue(input.plan);
  const plannedStartOn = dateKey(source.plannedStartOn);
  const plannedEndOn = dateKey(source.plannedEndOn);
  if (plannedStartOn === null || plannedEndOn === null) {
    return failure("VALIDATION_PLAN_DATE_INVALID", "计划日期格式不正确");
  }
  if (plannedStartOn && plannedEndOn && plannedEndOn < plannedStartOn) {
    return failure("VALIDATION_PLAN_DATE_ORDER", "计划结束日期不能早于开始日期");
  }
  const compensationBudgetMinor = moneyMinor(source.compensationBudgetMinor);
  const rewardBudgetMinor = moneyMinor(source.rewardBudgetMinor);
  if (compensationBudgetMinor === null || rewardBudgetMinor === null) {
    return failure("VALIDATION_PLAN_BUDGET_INVALID", "计划金额必须是非负整数分");
  }
  return {
    value: {
      participantRef,
      plan: {
        cohort: safeText(source.cohort, 80),
        goal: safeText(source.goal, 500),
        tasks: cleanList(source.tasks, 20, 240),
        plannedStartOn,
        plannedEndOn,
        compensationBudgetMinor,
        rewardBudgetMinor,
        notes: safeText(source.notes, 2000)
      }
    }
  };
}

export function financialRecordPayload(kind, input = {}) {
  if (!["compensation", "reward"].includes(kind)) {
    return failure("FINANCIAL_RECORD_TYPE_INVALID", "记录类型无效");
  }
  const amountMinor = moneyMinor(input.amountMinor);
  const status = safeText(input.status, 20) || "planned";
  if (amountMinor === null || amountMinor < 1) {
    return failure("FINANCIAL_RECORD_AMOUNT_INVALID", "金额必须是正整数分");
  }
  if (!FINANCIAL_RECORD_STATUSES.includes(status)) {
    return failure("FINANCIAL_RECORD_STATUS_INVALID", "金额记录状态无效");
  }
  const paidAt = safeIso(input.paidAt);
  const reference = safeText(input.reference, 240);
  if (hasOwn(input, "paidAt") && input.paidAt && !paidAt) {
    return failure("FINANCIAL_RECORD_PAID_AT_INVALID", "支付时间格式不正确");
  }
  if (status === "paid" && (!paidAt || !reference)) {
    return failure("FINANCIAL_RECORD_PAYMENT_EVIDENCE_REQUIRED", "已支付记录需要支付时间和凭据");
  }
  return {
    value: {
      kind,
      amountMinor,
      currency: "CNY",
      status,
      basis: safeText(input.basis, 500),
      paidAt: status === "paid" ? paidAt : "",
      reference: status === "paid" ? reference : "",
      note: safeText(input.note, 1000)
    }
  };
}

export function participationRecordPayload(input = {}) {
  const type = safeText(input.type, 40);
  const occurredAt = safeIso(input.occurredAt);
  const evidenceRef = safeText(input.evidenceRef, 500);
  if (!PARTICIPATION_RECORD_TYPES.includes(type)) {
    return failure("PARTICIPATION_RECORD_TYPE_INVALID", "参与记录类型无效");
  }
  if (!occurredAt) return failure("PARTICIPATION_OCCURRED_AT_REQUIRED", "真实参与记录需要有效发生时间");
  if (!evidenceRef) return failure("PARTICIPATION_EVIDENCE_REQUIRED", "真实参与记录需要证据引用");
  return {
    value: {
      type,
      occurredAt,
      evidenceRef,
      outcome: safeText(input.outcome, 2000)
    }
  };
}

export function createFeedbackService({
  repository,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID(),
  hash = digest
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("feedback repository must provide read and update");
  }
  const createIdempotently = (scope, key, requestHash, mutate) => (
    typeof repository.executeIdempotent === "function"
      ? repository.executeIdempotent(
          { scope, key, requestHash },
          document => mutate(document, false),
          { onReplay: result => ({ ...result, duplicate: true }) }
        )
      : repository.update(document => mutate(document, true))
  );

  async function listFeedback({ status = "" } = {}) {
    const items = readStore(await repository.read()).feedback;
    return { items: status ? items.filter(item => item.status === status) : items };
  }

  async function getFeedback(id) {
    return readStore(await repository.read()).feedback.find(item => item.id === id) || null;
  }

  async function submitFeedback(input, options = {}) {
    const clientRequestId = safeText(options.clientRequestId ?? input?.clientRequestId, 120);
    if (!clientRequestId) return failure("IDEMPOTENCY_KEY_REQUIRED", "提交反馈需要幂等标识");
    const parsed = feedbackPayload(input);
    if (parsed.error) return parsed;
    const requestHash = hash(JSON.stringify(parsed.value));
    return createIdempotently("feedback.create", clientRequestId, requestHash, (document, useLegacyLookup) => {
      const items = writableStore(document).feedback;
      const duplicate = useLegacyLookup && items.find(item => item.clientRequestId === clientRequestId);
      if (duplicate) {
        return duplicate.requestHash === requestHash
          ? { value: duplicate, duplicate: true }
          : { conflict: true, code: "IDEMPOTENCY_KEY_REUSED" };
      }
      const createdAt = now();
      const entry = {
        id: createId(),
        ...parsed.value,
        status: "submitted",
        version: 1,
        clientRequestId,
        requestHash,
        createdAt,
        updatedAt: createdAt,
        statusHistory: [{ from: "", to: "submitted", version: 1, changedAt: createdAt }]
      };
      items.unshift(entry);
      return { value: entry, duplicate: false };
    });
  }

  function transitionFeedback(id, nextStatus, options = {}) {
    const target = safeText(nextStatus, 20);
    if (!FEEDBACK_STATUSES.includes(target)) {
      return Promise.resolve(failure("FEEDBACK_STATUS_INVALID", "反馈状态无效"));
    }
    return repository.update(document => {
      const entry = writableStore(document).feedback.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      if (entry.status === target) return { value: entry, unchanged: true };
      if (!(feedbackTransitions[entry.status] || []).includes(target)) {
        return failure("FEEDBACK_STATUS_TRANSITION_INVALID", "不允许该反馈状态流转", {
          currentStatus: entry.status,
          requestedStatus: target
        });
      }
      const changedAt = now();
      entry.statusHistory.push({
        from: entry.status,
        to: target,
        version: checked.currentVersion + 1,
        changedAt
      });
      entry.status = target;
      nextVersion(entry, checked.currentVersion, () => changedAt);
      return { value: entry };
    });
  }

  async function listValidation({ status = "" } = {}) {
    const items = readStore(await repository.read()).validationLedger;
    return { items: status ? items.filter(item => item.status === status) : items };
  }

  async function getValidation(id) {
    return readStore(await repository.read()).validationLedger.find(item => item.id === id) || null;
  }

  async function createValidationPlan(input, options = {}) {
    const clientRequestId = safeText(options.clientRequestId ?? input?.clientRequestId, 120);
    if (!clientRequestId) return failure("IDEMPOTENCY_KEY_REQUIRED", "创建验证计划需要幂等标识");
    const parsed = validationPlanPayload(input);
    if (parsed.error) return parsed;
    const requestHash = hash(JSON.stringify(parsed.value));
    return createIdempotently("validationPlans.create", clientRequestId, requestHash, (document, useLegacyLookup) => {
      const items = writableStore(document).validationLedger;
      const duplicate = useLegacyLookup && items.find(item => item.clientRequestId === clientRequestId);
      if (duplicate) {
        return duplicate.requestHash === requestHash
          ? { value: duplicate, duplicate: true }
          : { conflict: true, code: "IDEMPOTENCY_KEY_REUSED" };
      }
      const createdAt = now();
      const entry = {
        id: createId(),
        ...parsed.value,
        consent: {
          status: "pending",
          noticeVersion: "",
          agreedAt: "",
          withdrawnAt: "",
          withdrawalReason: ""
        },
        status: "planned",
        version: 1,
        compensationRecords: [],
        rewardRecords: [],
        participationRecords: [],
        clientRequestId,
        requestHash,
        createdAt,
        updatedAt: createdAt,
        statusHistory: [{ from: "", to: "planned", version: 1, changedAt: createdAt }]
      };
      items.unshift(entry);
      return { value: entry, duplicate: false };
    });
  }

  function recordConsent(id, input = {}, options = {}) {
    const noticeVersion = safeText(input.noticeVersion, 80);
    if (!noticeVersion) {
      return Promise.resolve(failure("CONSENT_NOTICE_VERSION_REQUIRED", "同意记录需要隐私说明版本"));
    }
    return repository.update(document => {
      const entry = writableStore(document).validationLedger.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      if (entry.status === "withdrawn" || entry.consent.status === "withdrawn") {
        return failure("CONSENT_ALREADY_WITHDRAWN", "参与者已退出，不能重新标记同意");
      }
      if (entry.status === "closed") return failure("VALIDATION_CLOSED", "已关闭的验证计划不能修改同意状态");
      if (entry.consent.status === "agreed") {
        return entry.consent.noticeVersion === noticeVersion
          ? { value: entry, unchanged: true }
          : failure("CONSENT_ALREADY_RECORDED", "已记录其他版本的同意");
      }
      const changedAt = now();
      entry.consent = {
        status: "agreed",
        noticeVersion,
        agreedAt: changedAt,
        withdrawnAt: "",
        withdrawalReason: ""
      };
      if (entry.status !== "consented") {
        entry.statusHistory.push({
          from: entry.status,
          to: "consented",
          version: checked.currentVersion + 1,
          changedAt
        });
        entry.status = "consented";
      }
      nextVersion(entry, checked.currentVersion, () => changedAt);
      return { value: entry };
    });
  }

  function withdrawValidation(id, input = {}, options = {}) {
    const reason = safeText(input.reason, 1000);
    return repository.update(document => {
      const entry = writableStore(document).validationLedger.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      if (entry.status === "withdrawn" && entry.consent.status === "withdrawn") {
        return { value: entry, unchanged: true };
      }
      if (entry.status === "closed") return failure("VALIDATION_CLOSED", "已关闭的验证计划不能再退出");
      const changedAt = now();
      entry.consent = {
        ...entry.consent,
        status: "withdrawn",
        withdrawnAt: changedAt,
        withdrawalReason: reason
      };
      entry.statusHistory.push({
        from: entry.status,
        to: "withdrawn",
        version: checked.currentVersion + 1,
        changedAt
      });
      entry.status = "withdrawn";
      nextVersion(entry, checked.currentVersion, () => changedAt);
      return { value: entry };
    });
  }

  function transitionValidation(id, nextStatus, options = {}) {
    const target = safeText(nextStatus, 20);
    if (!VALIDATION_STATUSES.includes(target)) {
      return Promise.resolve(failure("VALIDATION_STATUS_INVALID", "验证状态无效"));
    }
    if (target === "consented") {
      return Promise.resolve(failure("CONSENT_ACTION_REQUIRED", "同意状态必须通过同意记录建立"));
    }
    if (target === "withdrawn") {
      return Promise.resolve(failure("WITHDRAWAL_ACTION_REQUIRED", "退出状态必须通过退出操作建立"));
    }
    return repository.update(document => {
      const entry = writableStore(document).validationLedger.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      if (entry.status === target) return { value: entry, unchanged: true };
      if (!(validationTransitions[entry.status] || []).includes(target)) {
        return failure("VALIDATION_STATUS_TRANSITION_INVALID", "不允许该验证状态流转", {
          currentStatus: entry.status,
          requestedStatus: target
        });
      }
      if (["in_progress", "follow_up"].includes(target) && entry.consent.status !== "agreed") {
        return failure("VALIDATION_CONSENT_REQUIRED", "开始验证前必须记录有效同意");
      }
      const changedAt = now();
      entry.statusHistory.push({
        from: entry.status,
        to: target,
        version: checked.currentVersion + 1,
        changedAt
      });
      entry.status = target;
      nextVersion(entry, checked.currentVersion, () => changedAt);
      return { value: entry };
    });
  }

  function addFinancialRecord(id, kind, input = {}, options = {}) {
    const parsed = financialRecordPayload(kind, input);
    if (parsed.error) return Promise.resolve(parsed);
    return repository.update(document => {
      const entry = writableStore(document).validationLedger.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      const createdAt = now();
      const record = { id: createId(), ...parsed.value, createdAt };
      const collection = kind === "compensation" ? entry.compensationRecords : entry.rewardRecords;
      collection.push(record);
      nextVersion(entry, checked.currentVersion, () => createdAt);
      return { value: record, ledger: entry };
    });
  }

  function recordParticipation(id, input = {}, options = {}) {
    const parsed = participationRecordPayload(input);
    if (parsed.error) return Promise.resolve(parsed);
    return repository.update(document => {
      const entry = writableStore(document).validationLedger.find(item => item.id === id);
      if (!entry) return { missing: true };
      const checked = expectedRecordVersion(entry, options);
      if (!hasOwn(checked, "currentVersion") || checked.versionConflict) return checked;
      if (entry.status === "closed") {
        return failure("VALIDATION_CLOSED", "已关闭的验证计划不能新增参与结果");
      }
      if (entry.consent.status !== "agreed" || entry.status === "withdrawn") {
        return failure("PARTICIPATION_CONSENT_REQUIRED", "没有有效同意时不能记录真实参与结果");
      }
      const existing = entry.participationRecords.find(item => item.evidenceRef === parsed.value.evidenceRef);
      if (existing) {
        return JSON.stringify({
          type: existing.type,
          occurredAt: existing.occurredAt,
          evidenceRef: existing.evidenceRef,
          outcome: existing.outcome
        }) === JSON.stringify(parsed.value)
          ? { value: existing, ledger: entry, duplicate: true }
          : { conflict: true, code: "PARTICIPATION_EVIDENCE_REUSED" };
      }
      const createdAt = now();
      const record = { id: createId(), ...parsed.value, recordedAt: createdAt };
      entry.participationRecords.push(record);
      nextVersion(entry, checked.currentVersion, () => createdAt);
      return { value: record, ledger: entry, duplicate: false };
    });
  }

  const feedback = Object.freeze({
    list: listFeedback,
    get: getFeedback,
    submit: submitFeedback,
    transition: transitionFeedback
  });
  const validation = Object.freeze({
    list: listValidation,
    get: getValidation,
    createPlan: createValidationPlan,
    consent: recordConsent,
    withdraw: withdrawValidation,
    transition: transitionValidation,
    recordCompensation: (id, input, options) => addFinancialRecord(id, "compensation", input, options),
    recordReward: (id, input, options) => addFinancialRecord(id, "reward", input, options),
    recordParticipation
  });

  return Object.freeze({
    feedback,
    validation,
    listFeedback,
    getFeedback,
    submitFeedback,
    transitionFeedback,
    listValidation,
    getValidation,
    createValidationPlan,
    recordConsent,
    withdrawValidation,
    transitionValidation,
    recordCompensation: validation.recordCompensation,
    recordReward: validation.recordReward,
    recordParticipation
  });
}
