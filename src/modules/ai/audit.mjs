import crypto from "node:crypto";
import { safeText } from "../../shared/validation/index.mjs";
import { errorMetadata, redact } from "../../shared/observability/index.mjs";
import { deepSeekUsageEntry, providerUsageEntry } from "./usage.mjs";

const AI_AUDIT_VERSION = 2;

export function usageEntryFromAudit(entry) {
  const value = entry?.usageRecovery;
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : null;
}

export function createAiAudit({ textLimit, getContext, append, updateUsage, logEvent, now = () => new Date().toISOString(), createId = () => crypto.randomUUID() }) {
  const pendingUsage = new Map();
  const pendingAudit = new Map();
  const text = value => {
    const content = String(value ?? "");
    return content.length <= textLimit ? content : `${content.slice(0, textLimit)}\n[TRUNCATED ${content.length - textLimit} CHARS]`;
  };
  const message = (value = {}) => {
    const role = ["system", "user", "assistant", "tool"].includes(value.role) ? value.role : "unknown";
    if (typeof value.content === "string") return { role, content: text(value.content) };
    if (!Array.isArray(value.content)) return { role, content: "" };
    return {
      role,
      content: value.content.map(item => item?.type === "text"
        ? { type: "text", text: text(item.text) }
        : { type: safeText(item?.type, 40) || "unknown", omitted: true })
    };
  };
  const record = async entry => {
    const date = new Date(entry.startedAt ?? now());
    const day = Number.isNaN(date.getTime()) ? now().slice(0, 10) : date.toISOString().slice(0, 10);
    await append(day, redact({ schemaVersion: AI_AUDIT_VERSION, type: "ai.invocation", ...entry }, getContext()?.secrets || []));
  };
  const safeLog = async (scope, event, fields) => {
    try {
      await logEvent(scope, event, fields);
    } catch {}
  };
  const contextScope = () => {
    const context = getContext() || {};
    return safeText(context.user?.id || context.account || "local", 100) || "local";
  };
  const entryScope = entry => safeText(entry?.actor?.userId, 100) || contextScope();
  const auditKey = entry => `${entry.callId || entry.id}:${entry.status || entry.type || "unknown"}`;
  const queueAudit = (entry, scope = entryScope(entry)) => pendingAudit.set(`${scope}\u0000${auditKey(entry)}`, { entry, scope });
  const pendingCount = (values, scope) => [...values].filter(item => item.scope === scope).length;
  const persistUsage = entry => updateUsage(value => {
    if (!Array.isArray(value.entries)) value.entries = [];
    const callId = entry.callId || entry.id;
    if (!value.entries.some(item => (item.callId || item.id) === callId)) value.entries.push(entry);
  });
  const usageRecoveredAudit = pending => ({
    id: `${pending.entry.callId}:usage-recovered`,
    type: "ai.usage_recovered",
    callId: pending.entry.callId,
    callGroupId: pending.entry.callGroupId,
    traceId: pending.entry.traceId,
    actor: pending.audit.actor,
    provider: pending.entry.provider || "deepseek",
    scene: pending.entry.scene,
    startedAt: pending.audit.startedAt,
    completedAt: now(),
    status: "recovered",
    usageRecovery: pending.entry
  });
  const recoverPending = async () => {
    const scope = contextScope();
    let recoveredUsage = 0, recoveredAudit = 0;
    for (const [key, pending] of [...pendingAudit]) {
      if (pending.scope !== scope) continue;
      const { entry } = pending;
      try {
        await record(entry);
        pendingAudit.delete(key);
        recoveredAudit += 1;
      } catch (error) {
        await safeLog("system", "ai.log_failed", { level: "error", callId: entry.callId, target: "audit_recovery", error: errorMetadata(error) });
      }
    }
    for (const [key, pending] of [...pendingUsage]) {
      if (pending.scope !== scope) continue;
      try {
        await persistUsage(pending.entry);
        pendingUsage.delete(key);
        pending.reservation?.commit?.();
        recoveredUsage += 1;
        const recovery = usageRecoveredAudit(pending);
        try {
          await record(recovery);
        } catch (error) {
          queueAudit(recovery);
          await safeLog("system", "ai.log_failed", { level: "error", callId: pending.entry.callId, target: "audit_recovery", error: errorMetadata(error) });
        }
      } catch (error) {
        await safeLog("system", "ai.log_failed", { level: "error", callId: pending.entry.callId, target: "usage_recovery", error: errorMetadata(error) });
      }
    }
    return {
      recoveredUsage,
      recoveredAudit,
      pendingUsage: pendingCount(pendingUsage.values(), scope),
      pendingAudit: pendingCount(pendingAudit.values(), scope)
    };
  };
  const start = async entry => {
    const started = { ...entry, status: "started" };
    try {
      await record(started);
    } catch (error) {
      queueAudit(started);
      await safeLog("system", "ai.log_failed", { level: "error", callId: entry.callId, target: "audit_start", error: errorMetadata(error) });
    }
  };
  const recordDeepSeekAttempt = async ({ usage, audit, usageMetadata, reservation = null }) => {
    const usageEntry = deepSeekUsageEntry({ usage, ...usageMetadata });
    const scope = entryScope(audit);
    reservation?.retain?.(usageEntry);
    let usagePersisted = false, auditPersisted = false;
    try {
      await persistUsage(usageEntry);
      usagePersisted = true;
      reservation?.commit?.();
    } catch (error) {
      pendingUsage.set(`${scope}\u0000${usageEntry.callId || usageEntry.id}`, { entry: usageEntry, audit, reservation, scope });
      await safeLog("system", "ai.log_failed", { level: "error", callId: audit.callId, target: "usage", error: errorMetadata(error) });
    }
    const auditEntry = {
      ...audit,
      persistence: { usage: usagePersisted ? "persisted" : "pending" },
      ...(!usagePersisted ? { usageRecovery: usageEntry } : {}),
      usage: {
        known: usageEntry.usageKnown,
        normalized: usageEntry.tokens,
        raw: usageEntry.rawUsage,
        pricingPeriod: usageEntry.pricingPeriod,
        ratesUsdPerMillion: usageEntry.ratesUsdPerMillion,
        costsUsd: usageEntry.costsUsd
      }
    };
    try {
      await record(auditEntry);
      auditPersisted = true;
    } catch (error) {
      queueAudit(auditEntry, scope);
      await safeLog("system", "ai.log_failed", { level: "error", callId: audit.callId, target: "audit", error: errorMetadata(error) });
    }
    await safeLog("system", "ai.completed", {
      level: audit.status === "success" ? "info" : "error", callId: audit.callId,
      callGroupId: audit.callGroupId, scene: audit.scene, status: audit.status, attempt: audit.attempt,
      durationMs: audit.durationMs, statusCode: audit.response.httpStatus, retryScheduled: audit.retryScheduled,
      errorCode: audit.error?.code || ""
    });
    return {
      usagePersisted,
      auditPersisted,
      pendingUsage: pendingCount(pendingUsage.values(), scope),
      pendingAudit: pendingCount(pendingAudit.values(), scope)
    };
  };
  const providerCall = async ({
    provider,
    service,
    scene,
    action,
    request = {},
    model = "",
    modality = "unknown",
    imageCount = 0,
    imageBytes = 0,
    imageTypes = [],
    imageDimensions = [],
    requestChars = 0,
    responseChars = 0,
    unitType = "call",
    units = 1,
    costCny = 0,
    costKnown = false,
    costSource = "",
    reservation = null,
    callGroupId = createId()
  }, invoke, summarize = result => ({ providerRequestId: result?.requestId || "" })) => {
    const context = getContext() || {}, startedAt = now(), startedMs = Date.now(), callId = createId();
    const base = {
      id: callId,
      callId,
      callGroupId,
      traceId: context.traceId || "",
      actor: { userId: context.user?.id || "local" },
      provider,
      service,
      scene,
      action,
      model,
      modality,
      imageCount,
      imageBytes,
      imageTypes,
      imageDimensions,
      requestChars,
      responseChars,
      startedAt,
      attempt: 1,
      maxAttempts: 1,
      request
    };
    await start(base);
    let response = {}, failure = null;
    try {
      const result = await invoke();
      response = summarize(result) || {};
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const completedAt = now(), durationMs = Date.now() - startedMs;
      const status = failure ? (failure.name === "AbortError" ? "cancelled" : "failed") : "success";
      const usageEntry = providerUsageEntry({
        ...base,
        createdAt: startedAt,
        completedAt,
        durationMs,
        durationKnown: true,
        status,
        httpStatus: Number(response.httpStatus || failure?.statusCode || failure?.status || 0),
        errorCode: failure ? safeText(failure.code || failure.name, 120) : "",
        providerRequestId: safeText(response.providerRequestId || response.requestId, 200),
        unitType,
        units,
        costCny,
        costKnown,
        costSource
      });
      const scope = entryScope(base);
      reservation?.retain?.(usageEntry);
      let usagePersisted = false;
      try {
        await persistUsage(usageEntry);
        usagePersisted = true;
        reservation?.commit?.();
      } catch (error) {
        pendingUsage.set(`${scope}\u0000${callId}`, {
          entry: usageEntry,
          audit: base,
          reservation,
          scope
        });
        await safeLog("system", "ai.log_failed", {
          level: "error",
          callId,
          target: "usage",
          error: errorMetadata(error)
        });
      }
      try {
        await record({
          ...base,
          completedAt,
          durationMs,
          status,
          response,
          error: failure ? errorMetadata(failure) : null,
          persistence: { usage: usagePersisted ? "persisted" : "pending" },
          ...(!usagePersisted ? { usageRecovery: usageEntry } : {}),
          usage: {
            known: usageEntry.costKnown,
            unitType: usageEntry.unitType,
            units: usageEntry.units,
            costCny: usageEntry.costCny,
            costSource: usageEntry.costSource
          }
        });
      } catch (error) {
        queueAudit({ ...base, completedAt, durationMs, status, response, error: failure ? errorMetadata(failure) : null }, scope);
        await safeLog("system", "ai.log_failed", { level: "error", callId, target: "audit", error: errorMetadata(error) });
      }
      await safeLog("system", "dependency.completed", {
        level: failure ? "error" : "info",
        provider,
        service,
        action,
        scene,
        callId,
        callGroupId,
        durationMs,
        status,
        error: failure ? errorMetadata(failure) : null
      });
    }
  };
  const segmentationCall = (action, callGroupId, request, invoke, summarize = result => ({
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
    unitType: action === "SegmentHDCommonImage" ? "image" : "call",
    units: 1,
    costKnown: false,
    costSource: "Aliyun billing not configured"
  }, invoke, summarize);
  return { text, message, start, recordDeepSeekAttempt, recoverPending, providerCall, segmentationCall };
}
