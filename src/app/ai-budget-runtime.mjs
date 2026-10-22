import { createDispatchAttempt, stageHasBillableDispatch, OFFICIAL_PROVIDER_PRICING } from "../modules/ai/index.mjs";

const MICROS_PER_CNY = 1_000_000;
const DEEPSEEK_SERVICE = "chat-completions";

// 仅这些额度拒绝可等待；未知价格、格式、reservation冲突及结算错误不在此列。
const ADMISSION_QUOTA_CODES = new Set([
  "AI_DAILY_CALL_LIMIT", "AI_DAILY_COST_LIMIT", "AI_SITE_DAILY_COST_LIMIT",
  "AI_SITE_MONTHLY_COST_LIMIT", "AI_SITE_DAILY_UNKNOWN_COST_LIMIT", "AI_RECORD_COMPRESSION_DAILY_LIMIT"
]);
const admissionFailure = (error, beforeProvider) => {
  if (error && typeof error === "object") {
    delete error.budgetAdmissionRejected;
    if (beforeProvider && ADMISSION_QUOTA_CODES.has(error.code)) error.budgetAdmissionRejected = true;
  }
  return error;
};

const requiredText = (value, field) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`AI budget runtime ${field} is required`);
  return normalized;
};

const tokenCount = (value, field) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`AI budget runtime ${field} must be a non-negative safe integer`);
  }
  return normalized;
};

const attemptCount = value => {
  const normalized = Number(value);
  if (normalized !== 1 && normalized !== 2) {
    throw new TypeError("AI budget runtime maxAttempts must be 1 or 2");
  }
  return normalized;
};

const knownUsageCost = entry => {
  if (!entry || entry.costKnown !== true) return null;
  const value = Object.hasOwn(entry, "costCny")
    ? Number(entry.costCny)
    : Number(entry.costsCny?.total);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("AI budget runtime usage entry requires a non-negative actual CNY cost");
  }
  return value;
};

const combinedFailure = (executionError, finalizationError, action) => Object.assign(new AggregateError(
  [executionError, finalizationError],
  `AI task failed and budget ${action} also failed`,
  { cause: executionError }
), { code: executionError?.code || "AI_BUDGET_FINALIZATION_FAILED", statusCode: executionError?.statusCode || 503, cleanupFailed: true });

export function estimateDeepSeekPeakCostCny({
  model,
  maxInputTokens,
  maxOutputTokens
}) {
  const pricing = OFFICIAL_PROVIDER_PRICING.deepseek;
  const rates = pricing.models[requiredText(model, "model")]?.peak;
  if (!rates) throw new TypeError("AI budget runtime DeepSeek model pricing is unavailable");
  const input = tokenCount(maxInputTokens, "maxInputTokens");
  const output = tokenCount(maxOutputTokens, "maxOutputTokens");
  const rawCost = (
    input * rates.cacheMiss
    + output * rates.output
  ) / pricing.unitTokens;
  const micros = Math.ceil(rawCost * MICROS_PER_CNY - Number.EPSILON);
  if (!Number.isSafeInteger(micros)) throw new RangeError("AI budget runtime DeepSeek estimate is too large");
  return micros / MICROS_PER_CNY;
}

export function deepSeekBudgetStages({
  model,
  scene,
  maxInputTokens,
  maxOutputTokens,
  maxAttempts = 1,
  action = "complete",
  stageIdPrefix = "deepseek-attempt"
}) {
  const attempts = attemptCount(maxAttempts);
  const estimatedCostCny = estimateDeepSeekPeakCostCny({
    model,
    maxInputTokens,
    maxOutputTokens
  });
  const normalizedScene = requiredText(scene, "scene");
  const normalizedAction = requiredText(action, "action");
  const prefix = requiredText(stageIdPrefix, "stageIdPrefix");
  return Array.from({ length: attempts }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    provider: "deepseek",
    service: DEEPSEEK_SERVICE,
    action: normalizedAction,
    scene: normalizedScene,
    costKnown: true,
    estimatedCostCny
  }));
}

export function createAiBudgetRuntime({ budget, onRecoveryError = () => {}, assertAccountReady = () => {} }) {
  for (const method of ["read", "reserveTask", "startStage", "settleTask", "releaseTask"]) {
    if (typeof budget?.[method] !== "function") {
      throw new TypeError(`AI budget runtime requires budget.${method}()`);
    }
  }
  if (typeof onRecoveryError !== "function") {
    throw new TypeError("AI budget runtime onRecoveryError must be a function");
  }

  async function executeTask(plan, execute, { control } = {}) {
    control?.throwIfStopped();
    assertAccountReady();
    if (typeof execute !== "function") {
      throw new TypeError("AI budget runtime execute callback is required");
    }
    let reserved;
    try {
      reserved = await budget.reserveTask(plan);
    } catch (error) {
      // 最初准入拒绝尚未进入执行回调，不可能启动provider。
      throw admissionFailure(error, true);
    }
    const reservation = reserved?.reservation;
    if (!reservation?.id || !Array.isArray(reservation.stages)) {
      throw new TypeError("AI budget runtime received an invalid reservation");
    }

    const stages = new Map(reservation.stages.map(stage => [stage.id, stage]));
    const started = new Set(
      reservation.stages.filter(stage => stage.startedAt).map(stage => stage.id)
    );
    const actualUsage = new Map();
    const notInvoked = new Set(reservation.stages.filter(stage => stage.dispatchState === "not_invoked").map(stage => stage.id));
    const claimedStages = new Set(started);

    const requireStage = stageId => {
      const normalizedId = requiredText(stageId, "stageId");
      const stage = stages.get(normalizedId);
      if (!stage) throw new TypeError(`AI budget runtime stage "${normalizedId}" is not reserved`);
      return stage;
    };

    const recordUsage = (stageId, usageEntry) => {
      const stage = requireStage(stageId);
      if (!started.has(stage.id) || notInvoked.has(stage.id)) {
        throw new Error(`AI budget runtime stage "${stage.id}" has not started`);
      }
      if (usageEntry?.costKnown === false) {
        actualUsage.set(stage.id, { costKnown: false });
        return true;
      }
      const actualCostCny = knownUsageCost(usageEntry);
      if (actualCostCny == null) return false;
      actualUsage.set(stage.id, { actualCostCny });
      return true;
    };

    const runStage = async (stageId, operation, options = {}) => {
      const stage = requireStage(stageId);
      if (typeof operation !== "function") throw new TypeError("AI budget runtime stage operation is required");
      if (claimedStages.has(stage.id) || stage.startedAt) throw new Error(`AI budget runtime stage "${stage.id}" was already started`);
      claimedStages.add(stage.id);
      const guard = () => { options.control?.throwIfStopped(); assertAccountReady(); options.dispatchGuard?.(); };
      guard();
      // 旧媒体runStage无options时保持保守语义；私有证明只适用于受控文本派发能力。
      const attempt = options.control && typeof options.dispatchGuard === "function" && typeof budget.markStageNotInvoked === "function"
        ? createDispatchAttempt() : null;
      await budget.startStage({ reservationId: reservation.id, stageId: stage.id, ...(attempt ? { dispatchAttemptId: attempt.id } : {}) });
      started.add(stage.id);
      let result, stageError = null;
      try {
        guard();
        result = await operation({ stage, reservation,
          recordUsage: usageEntry => recordUsage(stage.id, usageEntry),
          ...(attempt ? { dispatch: callback => attempt.invoke(callback, guard) } : {}) });
      } catch (error) {
        if (!options.canRetry?.(error)) options.control?.terminate?.(error);
        stageError = error;
      }
      finally { attempt?.close(); }
      if (attempt && !attempt.invoked) {
        try {
          const capability = attempt.proof(reservation.id, stage.id, stageError?.code === "AI_TASK_STALE" ? "stale" : stageError?.code === "AI_TASK_CANCELLED" ? "cancelled" : /TIMEOUT/.test(stageError?.code || "") ? "timeout" : "failed_before_io");
          await budget.markStageNotInvoked({ reservationId: reservation.id, stageId: stage.id, dispatchAttemptId: attempt.id }, capability);
          notInvoked.add(stage.id);
        } catch (proofError) {
          if (stageError) throw combinedFailure(stageError, proofError, "no-I/O proof");
          throw proofError;
        }
      }
      if (stageError) throw stageError;
      return result;
    };

    let value;
    let executionError = null;
    try {
      control?.throwIfStopped();
      value = await execute({ reservation, runStage, recordUsage });
    } catch (error) {
      control?.terminate?.(error);
      executionError = error;
    }

    const effectiveStarted = [...started].filter(id => !notInvoked.has(id));
    if (!effectiveStarted.length) {
      try {
        await budget.releaseTask({
          reservationId: reservation.id,
          reason: executionError ? "failed_before_io" : "completed_without_io"
        });
      } catch (releaseError) {
        if (executionError) throw combinedFailure(executionError, releaseError, "release");
        throw admissionFailure(releaseError, false);
      }
    } else {
      const settlementStages = effectiveStarted.map(stageId => ({
        stageId,
        started: true,
        ...(actualUsage.get(stageId) || {})
      }));
      try {
        await budget.settleTask({
          reservationId: reservation.id,
          stages: settlementStages,
          outcome: executionError ? "failed" : "completed"
        });
      } catch (settlementError) {
        if (executionError) throw combinedFailure(executionError, settlementError, "settlement");
        throw admissionFailure(settlementError, false);
      }
    }

    // 无stage启动且release成功才可等待；已开始/结果未知均不得标记可重跑。
    if (executionError) throw admissionFailure(executionError, effectiveStarted.length === 0);
    return value;
  }

  async function recover() {
    const state = await budget.read();
    const reservations = Array.isArray(state?.reservations) ? state.reservations : [];
    const report = {
      scanned: reservations.length,
      released: [],
      settled: [],
      failures: []
    };
    for (const reservation of reservations) {
      const startedStages = (Array.isArray(reservation?.stages) ? reservation.stages : [])
        .filter(stageHasBillableDispatch)
        .map(stage => ({ stageId: stage.id, started: true }));
      const action = startedStages.length ? "settle" : "release";
      try {
        if (action === "settle") {
          await budget.settleTask({
            reservationId: reservation.id,
            stages: startedStages,
            outcome: "interrupted"
          });
          report.settled.push(reservation.id);
        } else {
          await budget.releaseTask({
            reservationId: reservation.id,
            reason: "startup_recovery_unstarted"
          });
          report.released.push(reservation.id);
        }
      } catch (error) {
        const context = { action, reservationId: reservation?.id || "" };
        let reportingError = null;
        try {
          await onRecoveryError(error, context);
        } catch (failure) {
          reportingError = failure;
        }
        report.failures.push({
          ...context,
          error,
          ...(reportingError ? { reportingError } : {})
        });
      }
    }
    return report;
  }

  return { executeTask, recover };
}
