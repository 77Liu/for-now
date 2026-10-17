/**
 * Coordinates one-row AI attempt auditing, usage persistence, and legacy projections.
 * Established: unknown
 * Status: active
 * Boundary: a durable started fact is mandatory before provider I/O; compatibility files are never authoritative.
 */
import crypto from "node:crypto";
import { resolveInvocationContract } from "../../../.build/typescript/backend/modules/ai/invocation-contracts.mjs";
import { safeText } from "../../shared/validation/index.mjs";
import { errorMetadata, redact } from "../../shared/observability/index.mjs";
import { deepSeekUsageEntry, providerUsageEntry } from "./usage.mjs";

const AI_AUDIT_VERSION = 4;
const TERMINAL_RETRIES = 3;

export function usageEntryFromAudit(entry) {
  const value = entry?.usageRecovery;
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value)
    : null;
}

const auditUnavailable = cause => Object.assign(
  new Error("AI 审计存储暂不可用，请稍后重试", { cause }),
  { code: "AI_AUDIT_UNAVAILABLE", statusCode: 503 }
);

function createSanitizers(textLimit) {
  const text = value => {
    const content = String(value ?? "");
    return content.length <= textLimit
      ? content
      : `${content.slice(0, textLimit)}\n[TRUNCATED ${content.length - textLimit} CHARS]`;
  };
  const message = (value = {}) => {
    const role = ["system", "user", "assistant", "tool"].includes(value.role)
      ? value.role
      : "unknown";
    if (typeof value.content === "string") return { role, content: text(value.content) };
    if (!Array.isArray(value.content)) return { role, content: "" };
    return {
      role,
      content: value.content.map(item => item?.type === "text"
        ? { type: "text", text: text(item.text) }
        : { type: safeText(item?.type, 40) || "unknown", omitted: true })
    };
  };
  return { text, message };
}

function requestPayload(entry) {
  const request = entry.request && typeof entry.request === "object"
    ? structuredClone(entry.request)
    : {};
  if (entry.provider === "deepseek") return request;
  return {
    systemPrompt: { notApplicable: true },
    userPrompt: { notApplicable: true },
    history: [],
    parameters: {},
    ...request
  };
}

function responsePayload(entry) {
  const response = entry.response && typeof entry.response === "object"
    ? structuredClone(entry.response)
    : {};
  if (entry.provider === "deepseek") return response;
  return {
    content: null,
    reasoningContent: null,
    model: null,
    finishReason: null,
    ...response
  };
}

function startedRow(entry) {
  const contract = entry.invocationContract
    || resolveInvocationContract(entry.scene, entry.triggerType);
  return {
    callId: entry.callId || entry.id,
    callGroupId: entry.callGroupId,
    traceId: entry.traceId || "",
    provider: entry.provider,
    service: entry.service || (entry.provider === "deepseek" ? "chat-completions" : "unknown"),
    scene: entry.scene || "unknown",
    action: entry.action || (entry.provider === "deepseek" ? "complete" : "unknown"),
    ...contract,
    attempt: Math.max(1, Number(entry.attempt) || 1),
    maxAttempts: Math.max(1, Number(entry.maxAttempts) || 1),
    startedAt: entry.startedAt,
    requestPayload: requestPayload(entry),
    truncation: entry.truncation || {},
    schemaVersion: AI_AUDIT_VERSION
  };
}

function terminalRow(entry) {
  return {
    status: entry.status,
    completedAt: entry.completedAt,
    dispatchState: entry.dispatchState === "not_invoked" ? "not_invoked" : "invoked",
    responsePayload: responsePayload(entry),
    errorPayload: entry.error || null,
    usagePayload: entry.usage || null
  };
}

function createAuditPersistence({
  repository,
  append,
  getContext,
  logEvent,
  now,
  sleep
}) {
  const pending = new Map();
  const safeLog = async (event, fields) => {
    try { await logEvent("system", event, fields); } catch {}
  };
  const scope = entry => safeText(entry?.actor?.userId, 100)
    || safeText(getContext()?.user?.id || getContext()?.account || "local", 100)
    || "local";
  const compatibilityRecord = async entry => {
    const date = new Date(entry.startedAt ?? now());
    const day = Number.isNaN(date.getTime())
      ? now().slice(0, 10)
      : date.toISOString().slice(0, 10);
    await append(day, redact(
      { schemaVersion: AI_AUDIT_VERSION, type: "ai.invocation", ...entry },
      getContext()?.secrets || []
    ));
  };
  const compatibilityProjection = async (stage, entry) => {
    try { await compatibilityRecord(entry); }
    catch (error) {
      await safeLog("ai.log_failed", {
        level: "warn",
        callId: entry.callId,
        target: `audit_compatibility_${stage}`,
        error: errorMetadata(error)
      });
    }
  };
  const begin = async entry => {
    const persisted = redact(entry, getContext()?.secrets || []);
    if (!repository) return compatibilityRecord({ ...persisted, status: "started" });
    await repository.beginAttempt(startedRow(persisted));
    await compatibilityProjection("started", { ...persisted, status: "started" });
  };
  const finishOnce = async entry => {
    const persisted = redact(entry, getContext()?.secrets || []);
    if (!repository) return compatibilityRecord(persisted);
    await repository.finishAttempt(persisted.callId || persisted.id, terminalRow(persisted));
    await compatibilityProjection("terminal", persisted);
  };
  const finish = async entry => {
    let failure;
    for (let attempt = 0; attempt < TERMINAL_RETRIES; attempt += 1) {
      try { await finishOnce(entry); return true; }
      catch (error) {
        failure = error;
        if (["AI_AUDIT_STATE_CONFLICT", "AI_AUDIT_ATTEMPT_MISSING"].includes(error.code)) break;
        if (attempt + 1 < TERMINAL_RETRIES) await sleep(5 * (attempt + 1));
      }
    }
    const key = `${scope(entry)}\u0000${entry.callId || entry.id}`;
    pending.set(key, { entry, scope: scope(entry) });
    await safeLog("ai.log_failed", {
      level: "error",
      callId: entry.callId,
      target: "audit_finish",
      error: errorMetadata(failure)
    });
    return false;
  };
  const recover = async () => {
    const activeScope = scope({});
    let recovered = 0;
    for (const [key, item] of [...pending]) {
      if (item.scope !== activeScope) continue;
      try {
        await finishOnce(item.entry);
        pending.delete(key);
        recovered += 1;
      } catch (error) {
        await safeLog("ai.log_failed", {
          level: "error",
          callId: item.entry.callId,
          target: "audit_recovery",
          error: errorMetadata(error)
        });
      }
    }
    return { recovered, pending: [...pending.values()].filter(item => item.scope === activeScope).length };
  };
  return { begin, finish, recover, safeLog };
}

function createUsagePersistence({
  recordUsageAttempt,
  updateUsage,
  finalizeUsage,
  getContext,
  logEvent
}) {
  const pending = new Map();
  const scope = entry => safeText(entry?.actor?.userId, 100)
    || safeText(getContext()?.user?.id || getContext()?.account || "local", 100)
    || "local";
  const persist = entry => finalizeUsage(entry, () => (
    recordUsageAttempt
      ? recordUsageAttempt(entry)
      : updateUsage(value => {
          if (!Array.isArray(value.entries)) value.entries = [];
          const callId = entry.callId || entry.id;
          if (!value.entries.some(item => (item.callId || item.id) === callId)) {
            value.entries.push(entry);
          }
        })
  ));
  const save = async (entry, audit, reservation) => {
    const activeScope = scope(audit);
    reservation?.retain?.(entry);
    try {
      await persist(entry);
      reservation?.commit?.();
      return true;
    } catch (error) {
      pending.set(`${activeScope}\u0000${entry.callId || entry.id}`, {
        entry,
        audit,
        reservation,
        scope: activeScope
      });
      try {
        await logEvent("system", "ai.log_failed", {
          level: "error",
          callId: audit.callId,
          target: "usage",
          error: errorMetadata(error)
        });
      } catch {}
      return false;
    }
  };
  const recover = async () => {
    const activeScope = scope({});
    let recovered = 0;
    for (const [key, item] of [...pending]) {
      if (item.scope !== activeScope) continue;
      try {
        await persist(item.entry);
        pending.delete(key);
        item.reservation?.commit?.();
        recovered += 1;
      } catch (error) {
        try {
          await logEvent("system", "ai.log_failed", {
            level: "error",
            callId: item.entry.callId,
            target: "usage_recovery",
            error: errorMetadata(error)
          });
        } catch {}
      }
    }
    return { recovered, pending: [...pending.values()].filter(item => item.scope === activeScope).length };
  };
  return { save, recover };
}

function createDeepSeekAttemptRecorder({ usagePersistence, persistence, endUninvokedCall, logEvent, now }) {
  return async ({ usage, audit, usageMetadata, reservation = null, invoked = true }) => {
    if (!invoked) {
      const entry = {
        ...audit,
        completedAt: audit.completedAt || now(),
        dispatchState: "not_invoked",
        persistence: { usage: "not_applicable" }
      };
      const auditPersisted = await persistence.finish(entry);
      endUninvokedCall(audit.callId || audit.id);
      return { usagePersisted: false, usageRequired: false, auditPersisted };
    }
    const usageEntry = deepSeekUsageEntry({
      callId: audit.callId || audit.id,
      callGroupId: audit.callGroupId,
      traceId: audit.traceId,
      scene: audit.scene,
      ...usageMetadata,
      usage
    });
    const usagePersisted = await usagePersistence.save(usageEntry, audit, reservation);
    const entry = {
      ...audit,
      dispatchState: "invoked",
      persistence: { usage: usagePersisted ? "persisted" : "pending" },
      usage: {
        known: usageEntry.usageKnown,
        normalized: usageEntry.tokens,
        raw: usageEntry.rawUsage,
        pricingPeriod: usageEntry.pricingPeriod,
        costKnown: usageEntry.costKnown,
        costCny: usageEntry.costCny,
        costSource: usageEntry.costSource,
        ratesCnyPerMillion: usageEntry.ratesCnyPerMillion,
        costsCny: usageEntry.costsCny,
        ratesUsdPerMillion: usageEntry.ratesUsdPerMillion,
        costsUsd: usageEntry.costsUsd
      }
    };
    const auditPersisted = await persistence.finish(entry);
    try {
      await logEvent("system", "ai.completed", {
        level: audit.status === "success" ? "info" : "error",
        callId: audit.callId,
        callGroupId: audit.callGroupId,
        scene: audit.scene,
        status: audit.status,
        attempt: audit.attempt,
        durationMs: audit.durationMs,
        statusCode: audit.response.httpStatus,
        retryScheduled: audit.retryScheduled,
        errorCode: audit.error?.code || ""
      });
    } catch {}
    return { usagePersisted, auditPersisted };
  };
}

const defaultProviderSummary = result => ({
  providerRequestId: result?.providerRequestId || result?.requestId || ""
});

function providerAttemptBase(details, context, now, createId) {
  const callId = createId();
  return {
    id: callId,
    callId,
    callGroupId: details.callGroupId || createId(),
    traceId: context.traceId || "",
    actor: { userId: context.user?.id || "local" },
    provider: details.provider,
    service: details.service,
    scene: details.scene,
    action: details.action,
    model: details.model || "",
    modality: details.modality || "unknown",
    imageCount: details.imageCount || 0,
    imageBytes: details.imageBytes || 0,
    imageTypes: details.imageTypes || [],
    imageDimensions: details.imageDimensions || [],
    requestChars: details.requestChars || 0,
    responseChars: details.responseChars || 0,
    attempt: 1,
    maxAttempts: 1,
    request: details.request || {},
    invocationContract: resolveInvocationContract(details.scene, details.triggerType),
    startedAt: now()
  };
}

async function finalizeProviderAttempt({
  details,
  started,
  startedMs,
  response,
  failure,
  usagePersistence,
  finish,
  logEvent,
  now
}) {
  const completedAt = now();
  const durationMs = Date.now() - startedMs;
  const status = failure
    ? (failure.name === "AbortError" ? "cancelled" : "failed")
    : "success";
  const usageEntry = providerUsageEntry({
    ...started,
    createdAt: started.startedAt,
    completedAt,
    durationMs,
    durationKnown: true,
    status,
    httpStatus: Number(response.httpStatus || failure?.statusCode || failure?.status || 0),
    errorCode: failure ? safeText(failure.code || failure.name, 120) : "",
    providerRequestId: safeText(response.providerRequestId || response.requestId || failure?.providerRequestId, 200),
    unitType: response.unitType || details.unitType || "call",
    units: response.units ?? details.units ?? 1,
    costCny: response.costCny ?? details.costCny ?? 0,
    costKnown: response.costKnown ?? details.costKnown,
    costSource: response.costSource || details.costSource || ""
  });
  const usagePersisted = await usagePersistence.save(usageEntry, started, details.reservation);
  await finish({
    ...started,
    completedAt,
    durationMs,
    status,
    dispatchState: "invoked",
    response,
    error: failure ? errorMetadata(failure) : null,
    persistence: { usage: usagePersisted ? "persisted" : "pending" },
    usage: {
      known: usageEntry.usageKnown,
      unitType: usageEntry.unitType,
      units: usageEntry.units,
      costKnown: usageEntry.costKnown,
      costCny: usageEntry.costCny,
      costSource: usageEntry.costSource
    }
  });
  try {
    await logEvent("system", "dependency.completed", {
      level: failure ? "error" : "info",
      provider: details.provider,
      service: details.service,
      action: details.action,
      scene: details.scene,
      callId: started.callId,
      callGroupId: started.callGroupId,
      durationMs,
      status,
      providerRequestId: safeText(response.providerRequestId || response.requestId || failure?.providerRequestId, 200),
      providerErrorCode: failure ? safeText(failure.providerCode || failure.code, 120) : "",
      error: failure ? errorMetadata(failure) : null
    });
  } catch {}
}

async function finishUninvokedProviderAttempt({
  started,
  startedMs,
  failure,
  finish,
  endUninvokedCall,
  now
}) {
  try {
    return await finish({
      ...started,
      completedAt: now(),
      durationMs: Date.now() - startedMs,
      status: failure?.name === "AbortError" ? "cancelled" : "failed",
      dispatchState: "not_invoked",
      response: {},
      error: failure ? errorMetadata(failure) : null,
      persistence: { usage: "not_applicable" },
      usage: null
    });
  } finally {
    endUninvokedCall(started.callId || started.id);
  }
}

function createProviderCaller(dependencies) {
  const prepareProviderCall = async (details, summarize = defaultProviderSummary) => {
    const base = providerAttemptBase(
      details,
      dependencies.getContext() || {},
      dependencies.now,
      dependencies.createId
    );
    const startedMs = Date.now();
    const started = await dependencies.start(base);
    let state = "prepared";
    const invoke = async operation => {
      if (state !== "prepared") {
        throw Object.assign(new Error("AI provider attempt is already finalized"), {
          code: "AI_AUDIT_ATTEMPT_ALREADY_FINALIZED"
        });
      }
      state = "invoked";
      let response = {};
      let failure = null;
      try {
        const result = await operation();
        response = summarize(result) || {};
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await finalizeProviderAttempt({
          ...dependencies,
          details,
          started,
          startedMs,
          response,
          failure
        });
      }
    };
    const finishUninvoked = async failure => {
      if (state !== "prepared") return false;
      state = "not_invoked";
      return finishUninvokedProviderAttempt({
        ...dependencies,
        started,
        startedMs,
        failure
      });
    };
    return { invoke, finishUninvoked };
  };
  const providerCall = async (details, invoke, summarize = defaultProviderSummary) => {
    const prepared = await prepareProviderCall(details, summarize);
    return prepared.invoke(invoke);
  };
  return { prepareProviderCall, providerCall };
}

function createPendingRecovery(persistence, usagePersistence) {
  return async () => {
    const audit = await persistence.recover();
    const usage = await usagePersistence.recover();
    return {
      recoveredUsage: usage.recovered,
      recoveredAudit: audit.recovered,
      pendingUsage: usage.pending,
      pendingAudit: audit.pending
    };
  };
}

function createAuditMaintenance(repository, now) {
  return async ({ retentionDays }) => {
    if (!repository) return { interrupted: 0, deleted: 0 };
    const timestamp = Date.parse(now());
    if (!Number.isFinite(timestamp)) throw new Error("AI audit maintenance clock is invalid");
    const interrupted = typeof repository.markInterrupted === "function"
      ? await repository.markInterrupted(new Date(timestamp - 10 * 60_000).toISOString(), 200)
      : 0;
    const days = Math.max(1, Math.min(3650, Math.trunc(retentionDays)));
    const deleted = typeof repository.deleteExpired === "function"
      ? await repository.deleteExpired(new Date(timestamp - days * 86_400_000).toISOString(), 500)
      : 0;
    return { interrupted, deleted };
  };
}

function createSegmentationCall(providerCall) {
  return (action, callGroupId, request, invoke, summarize = result => ({
    providerRequestId: result?.body?.requestId || result?.requestId || ""
  })) => providerCall({
    provider: "aliyun",
    service: "segmentation",
    scene: "keepsakeSegmentation",
    action,
    callGroupId,
    request,
    modality: "vision",
    imageCount: Array.isArray(request?.images) ? request.images.length : 0,
    imageBytes: Array.isArray(request?.images)
      ? request.images.reduce((sum, image) => sum + (Number(image?.bytes) || 0), 0)
      : 0,
    unitType: "call",
    units: 1
  }, invoke, summarize);
}

export function createAiAudit({
  textLimit,
  getContext,
  append,
  updateUsage,
  repository = null,
  recordUsageAttempt = null,
  logEvent,
  beginCall = () => {},
  endUninvokedCall = () => {},
  finalizeUsage = (_entry, operation) => operation(),
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
  const { text, message } = createSanitizers(textLimit);
  const persistence = createAuditPersistence({
    repository,
    append,
    getContext,
    logEvent,
    now,
    sleep
  });
  const usagePersistence = createUsagePersistence({
    recordUsageAttempt,
    updateUsage,
    finalizeUsage,
    getContext,
    logEvent
  });
  const start = async entry => {
    const started = {
      ...entry,
      invocationContract: entry.invocationContract
        || resolveInvocationContract(entry.scene, entry.triggerType),
      status: "started"
    };
    beginCall(started.callId || started.id);
    try {
      await persistence.begin(started);
      return started;
    } catch (error) {
      endUninvokedCall(started.callId || started.id);
      await persistence.safeLog("ai.log_failed", {
        level: "error",
        callId: started.callId,
        target: "audit_start",
        error: errorMetadata(error)
      });
      throw auditUnavailable(error);
    }
  };
  const finish = entry => persistence.finish(entry);
  const recordDeepSeekAttempt = createDeepSeekAttemptRecorder({
    usagePersistence,
    persistence,
    endUninvokedCall,
    logEvent,
    now
  });
  const { prepareProviderCall, providerCall } = createProviderCaller({
    getContext,
    start,
    finish,
    usagePersistence,
    logEvent,
    endUninvokedCall,
    now,
    createId
  });
  return {
    text,
    message,
    start,
    recordDeepSeekAttempt,
    recoverPending: createPendingRecovery(persistence, usagePersistence),
    maintain: createAuditMaintenance(repository, now),
    prepareProviderCall,
    providerCall,
    segmentationCall: createSegmentationCall(providerCall)
  };
}
