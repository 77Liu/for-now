import crypto from "node:crypto";
import {
  DEFAULT_RECORD_TIMEZONE,
  RECORD_COMPRESSION_INPUT_JSON_BUDGET_BYTES,
  RECORD_COMPRESSION_INPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_INPUT_TEXT_BUDGET,
  RECORD_COMPRESSION_MAX_SOURCE_ITEMS,
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET
} from "./contract.mjs";

export { RECORD_COMPRESSION_INPUT_SCHEMA_VERSION } from "./contract.mjs";
export const DEFAULT_RECORD_COMPRESSION_TEXT_BUDGET = RECORD_COMPRESSION_INPUT_TEXT_BUDGET;

const USER_TEXT_RATIO = 0.9;
const PER_SOURCE_TEXT_LIMIT = 2_000;
const PER_AI_REFERENCE_TEXT_LIMIT = 500;
const DAILY_METRIC_FIELDS = Object.freeze({
  sleep: Object.freeze({
    totalMinutes: "minute",
    deepMinutes: "minute",
    lightMinutes: "minute",
    remMinutes: "minute",
    awakeMinutes: "minute",
    awakeCount: "count",
    averageHeartRate: "bpm",
    averageOxygen: "percent",
    respiratoryRate: "breaths_per_minute"
  }),
  heartRate: Object.freeze({
    minimum: "bpm",
    maximum: "bpm",
    average: "bpm",
    resting: "bpm",
    sleepAverage: "bpm"
  }),
  weight: Object.freeze({
    measuredWeight: "kg",
    bmi: "bmi",
    bodyFatMass: "kg",
    bodyFatPercent: "percent",
    bodyWaterMass: "kg",
    bodyWaterPercent: "percent",
    proteinMass: "kg",
    proteinPercent: "percent",
    boneMineralMass: "kg",
    boneMineralPercent: "percent",
    muscleMass: "kg",
    musclePercent: "percent",
    skeletalMuscleMass: "kg",
    visceralFatLevel: "level",
    basalMetabolism: "kcal_per_day",
    waistHipRatio: "ratio",
    bodyAge: "year"
  }),
  exercise: Object.freeze({
    durationSeconds: "second",
    activeCalories: "kcal",
    totalCalories: "kcal",
    averageHeartRate: "bpm",
    maximumHeartRate: "bpm",
    distanceKm: "km",
    warmUpSeconds: "second",
    fatBurnSeconds: "second",
    aerobicSeconds: "second",
    anaerobicSeconds: "second",
    extremeSeconds: "second"
  })
});
const CHECKIN_METRIC_FIELDS = Object.freeze({
  mood: "rating_1_to_5",
  energy: "rating_1_to_5",
  stress: "rating_1_to_5",
  sleep: "rating_1_to_5"
});
const MODULE_ORDER = Object.freeze(["daily", "thought", "journal", "capture", "other"]);
const list = value => Array.isArray(value) ? value : [];
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = value => typeof value === "string" ? value.trim().slice(0, 100) : "";
const safeText = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
const recordVersion = value => {
  const parsed = Math.round(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
};
const parseDateKey = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
};
const parseInstant = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const canonicalSourceKey = sourceRef => JSON.stringify([
  sourceRef.resourceType,
  sourceRef.resourceId,
  sourceRef.rootId || "",
  sourceRef.targetKey || ""
]);
const cleanOrigin = value => safeText(value).slice(0, 80);
const isDeleted = item => Boolean(
  item?.deleted === true
  || item?.tombstone === true
  || item?.deletedAt
  || item?.status === "deleted"
  || item?.validationState === "invalid"
);
const isDiscarded = item => item?.disposition === "discarded";
const isContextDisabled = item => item?.contextAllowed === false || item?.allowInContext === false;
const isModelAuthored = item => (
  item?.authorType === "ai"
  || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item?.origin || ""))
  || Boolean(item?.modelDraft)
  || Boolean(item?.reasoningContent)
  || Boolean(item?.sourceTaskId)
  || Boolean(item?.contextReceipt)
);
const isExplicitlyUserAuthored = item => item?.authorType === "user"
  || /^(?:manual|user|user_original)$/i.test(String(item?.origin || ""));
const isValidRecord = item => objectValue(item)
  && !isDeleted(item)
  && !isDiscarded(item)
  && !isContextDisabled(item);

const formatterCache = new Map();
function dateFormatter(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(timezone, new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }));
  }
  return formatterCache.get(timezone);
}

function localDateKey(instant, timezone) {
  const parts = Object.fromEntries(
    dateFormatter(timezone).formatToParts(instant)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  return parts.year + "-" + parts.month + "-" + parts.day;
}

function localDateStart(dateKey, timezone) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  // Find the first UTC millisecond whose calendar date in this timezone is dateKey.
  // This handles timezone offsets and daylight-saving changes without using the host timezone.
  let low = parsed.getTime() - 36 * 60 * 60 * 1000;
  let high = parsed.getTime() + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateKey(new Date(middle), timezone) < dateKey) low = middle + 1;
    else high = middle;
  }
  if (localDateKey(new Date(low), timezone) !== dateKey) {
    throw new RangeError("localDate does not exist in the requested timezone");
  }
  return new Date(low);
}

function nextDateKey(dateKey) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function sourceDate(item, timezone, occurredAt = item?.occurredAt) {
  const explicitDate = typeof item?.occurredOn === "string" && parseDateKey(item.occurredOn)
    ? item.occurredOn
    : "";
  if (explicitDate) return explicitDate;
  const occurred = parseInstant(occurredAt);
  if (occurred) return localDateKey(occurred, timezone);
  const created = parseInstant(item?.createdAt);
  if (created) return localDateKey(created, timezone);
  const updated = parseInstant(item?.updatedAt);
  return updated ? localDateKey(updated, timezone) : "";
}

function sourceInstant(item, occurredAtOverride) {
  const occurred = parseInstant(occurredAtOverride || item?.occurredAt);
  if (occurred) return occurred;
  if (typeof item?.occurredOn === "string" && parseDateKey(item.occurredOn)) return null;
  return parseInstant(item?.createdAt) || parseInstant(item?.updatedAt);
}

function sourceTimes(item, timezone, occurredAtOverride) {
  const occurredAt = parseInstant(occurredAtOverride || item?.occurredAt)
    || parseInstant(item?.createdAt)
    || parseInstant(item?.updatedAt);
  const updatedAt = parseInstant(item?.updatedAt);
  return {
    occurredAt: occurredAt ? occurredAt.toISOString() : "",
    occurredOn: occurredAt
      ? localDateKey(occurredAt, timezone)
      : (parseDateKey(item?.occurredOn) ? item.occurredOn : ""),
    updatedAt: updatedAt ? updatedAt.toISOString() : ""
  };
}

function permissionResult(store, accountId, sourceRef, sourcePermission) {
  const sourceKey = canonicalSourceKey(sourceRef);
  const matching = list(store?.evidencePermissions)
    .filter(item => item?.sourceKey === sourceKey);
  if (matching.length > 1) return { allowed: false, permissionRevision: 0 };
  const stored = matching[0] || null;
  if (stored && stored.accountId !== accountId) {
    return { allowed: false, permissionRevision: 0 };
  }
  if (stored && stored.contextAllowed !== true) {
    return {
      allowed: false,
      permissionRevision: Math.max(0, Math.round(Number(stored.revision) || 0))
    };
  }
  const storedRevision = Math.max(0, Math.round(Number(stored?.revision) || 0));
  if (typeof sourcePermission !== "function") {
    return {
      allowed: stored?.contextAllowed === true,
      permissionRevision: storedRevision
    };
  }
  const external = sourcePermission({ accountId, sourceRef: structuredClone(sourceRef), sourceKey });
  if (external !== true && external?.allowed !== true && external?.contextAllowed !== true) {
    return { allowed: false, permissionRevision: storedRevision };
  }
  const externalRevision = Number.isSafeInteger(external?.permissionRevision)
    ? Math.max(0, external.permissionRevision)
    : Number.isSafeInteger(external?.revision)
      ? Math.max(0, external.revision)
      : storedRevision;
  return { allowed: true, permissionRevision: Math.max(storedRevision, externalRevision) };
}

function sourceIdentity(module, recordId, targetKey = "", resourceType = module) {
  return module + ":" + resourceType + ":" + encodeURIComponent(recordId)
    + (targetKey ? ":" + encodeURIComponent(targetKey) : "");
}

function makeCandidate({
  state,
  accountId,
  timezone,
  localDate,
  asOf,
  record,
  resourceType,
  module,
  subtype,
  targetKey = "",
  permissionTargetKey,
  rootId = "",
  origin = "user_original",
  derivedFrom,
  text = "",
  occurredAt,
  measurements = [],
  sourcePermission
}) {
  const recordId = safeId(record?.id);
  if (!recordId || !isValidRecord(record)) return;
  if (sourceDate(record, timezone, occurredAt) !== localDate) return;
  const eventInstant = sourceInstant(record, occurredAt);
  if (eventInstant && eventInstant.getTime() > asOf.getTime()) return;
  const fullText = safeText(text);
  const filteredMeasurements = measurements.filter(item => (
    item && typeof item.metric === "string" && typeof item.unit === "string"
      && Number.isFinite(item.value)
  ));
  if (!fullText && !filteredMeasurements.length) return;
  const sourceRef = {
    resourceType,
    resourceId: recordId,
    rootId: safeId(rootId),
    targetKey: safeText(targetKey).slice(0, 120),
    version: recordVersion(record.version)
  };
  const permissionRef = permissionTargetKey === undefined
    ? sourceRef
    : { ...sourceRef, targetKey: safeText(permissionTargetKey).slice(0, 120) };
  state.coverage.total += 1;
  const permission = permissionResult(state.store, accountId, permissionRef, sourcePermission);
  if (!permission.allowed) {
    state.coverage.excluded += 1;
    return;
  }
  const sourceId = sourceIdentity(module, recordId, targetKey, resourceType);
  const times = sourceTimes(record, timezone, occurredAt);
  const sourceHash = state.hash(JSON.stringify({
    text: fullText,
    occurredAt: times.occurredAt,
    occurredOn: times.occurredOn,
    updatedAt: times.updatedAt,
    measurements: filteredMeasurements.map(item => ({
      metric: item.metric,
      unit: item.unit,
      value: item.value
    })).sort((left, right) => (
      left.metric.localeCompare(right.metric)
      || left.unit.localeCompare(right.unit)
      || left.value - right.value
    ))
  }));
  const manifestItem = {
    sourceId,
    recordId,
    resourceType,
    rootId: sourceRef.rootId,
    targetKey: sourceRef.targetKey,
    version: sourceRef.version,
    module,
    subtype,
    origin: cleanOrigin(origin),
    occurredAt: times.occurredAt,
    occurredOn: times.occurredOn,
    updatedAt: times.updatedAt,
    permissionRevision: permission.permissionRevision,
    sourceHash
  };
  state.manifest.push(manifestItem);
  if (origin === "unknown_origin") {
    state.warnings.add("来源作者未验证: " + subtype);
  }
  const candidate = {
    ...manifestItem,
    sourceRef,
    text: fullText,
    measurements: filteredMeasurements,
    derivedFrom: Array.isArray(derivedFrom)
      ? derivedFrom.filter(value => typeof value === "string" && value)
      : []
  };
  if (!candidate.derivedFrom.length && origin !== "user_original" && origin !== "quoted_external") {
    if (resourceType === "thought" && record.relatedTo) {
      candidate.derivedFrom = [
        sourceIdentity("thought", safeId(record.relatedTo), "question:" + safeId(record.relatedTo), "thought")
      ];
    } else if (resourceType === "journal" && rootId) {
      candidate.derivedFrom = [sourceIdentity("journal", safeId(rootId), "", "journal")];
    } else if (resourceType === "dailyRecord" || resourceType === "capture") {
      candidate.derivedFrom = [sourceIdentity(module, recordId, "", resourceType)];
    }
  }
  state.groups[module] ||= [];
  state.groups[module].push(candidate);
}

function textForCheckin(item) {
  const text = [];
  if (Array.isArray(item.factors) && item.factors.length) text.push("因素：" + item.factors.join("、"));
  for (const [key, value] of Object.entries(objectValue(item.custom) ? item.custom : {})) {
    if (Number.isFinite(Number(value))) continue;
    if (typeof value === "string" && value.trim()) text.push(key + "：" + value.trim());
  }
  for (const [key, value] of Object.entries(objectValue(item.notes) ? item.notes : {})) {
    if (typeof value === "string" && value.trim()) text.push(key + "：" + value.trim());
  }
  return text.join("；");
}

function numericMeasurements(item, fields, prefix) {
  return Object.entries(fields).flatMap(([field, unit]) => {
    const value = item?.[field];
    return typeof value === "number" && Number.isFinite(value)
      ? [{ metric: prefix + field, unit, value }]
      : [];
  });
}

function healthText(item) {
  const parts = [];
  if (item.type === "exercise" && item.source !== "screenshot" && item.description) {
    parts.push(item.description);
  } else if (item.type === "weight" && item.source !== "screenshot" && item.description) {
    parts.push(item.description);
  }
  if (item.exerciseType && item.type === "exercise" && item.source !== "screenshot") {
    parts.push("运动项目：" + item.exerciseType);
  }
  return parts.join("；");
}

function addAiText({
  state,
  accountId,
  timezone,
  localDate,
  asOf,
  record,
  resourceType,
  module,
  subtype,
  targetKey,
  permissionTargetKey,
  rootId,
  text,
  origin = "ai_generated",
  occurredAt,
  sourcePermission
}) {
  makeCandidate({
    state,
    accountId,
    timezone,
    localDate,
    asOf,
    record,
    resourceType,
    module,
    subtype,
    targetKey,
    permissionTargetKey,
    rootId,
    origin,
    text,
    occurredAt,
    sourcePermission
  });
}

function collectCheckins(store, options, state) {
  for (const item of list(store?.checkins)) {
    const measurements = numericMeasurements(item, CHECKIN_METRIC_FIELDS, "checkin_");
    makeCandidate({
      state, ...options, record: item, resourceType: "checkin", module: "daily",
      subtype: "checkin", text: textForCheckin(item), measurements
    });
  }
}

function collectDailyRecords(store, options, state) {
  for (const item of list(store?.dailyRecords)) {
    const fields = DAILY_METRIC_FIELDS[item?.type] || {};
    // Screenshot OCR values are usable only after a durable confirmation marker exists.
    // The current daily-record API stores no such marker, so exclude these measurements.
    const measurements = item?.source === "screenshot"
      ? []
      : numericMeasurements(item, fields, item?.type + "_");
    makeCandidate({
      state, ...options, record: item, resourceType: "dailyRecord", module: "daily",
      subtype: item?.type || "health", text: healthText(item), measurements
    });
    for (const field of ["recognitionDescription", "trendAnalysis", "verification"]) {
      const value = safeText(item?.[field]);
      if (!value) continue;
      addAiText({
        state, ...options, record: item, resourceType: "dailyRecord", module: "daily",
        subtype: "health_" + field, targetKey: "ai:" + field, rootId: "",
        permissionTargetKey: "", text: value, origin: "ai_generated"
      });
    }
  }
}

function thoughtOrigin(item) {
  if (item?.authorType === "system") return "system_generated";
  if (isModelAuthored(item)) return "ai_generated";
  return isExplicitlyUserAuthored(item) ? "user_original" : "unknown_origin";
}

function collectThoughts(store, options, state) {
  for (const item of list(store?.thoughts)) {
    if (item?.type === "question" || item?.type === "idea" || item?.type === "record" || item?.type === "answer") {
      const origin = thoughtOrigin(item);
      const relatedTo = safeId(item.relatedTo);
      makeCandidate({
        state, ...options, record: item, resourceType: "thought", module: "thought",
        subtype: item.type || "thought",
        targetKey: item.type === "question" ? "question:" + safeId(item.id) : item.type + ":" + safeId(item.id),
        rootId: item.type === "question" ? safeId(item.id) : relatedTo,
        origin,
        text: item.content,
        measurements: []
      });
    }
    if (item?.type !== "question") continue;
    const rootId = safeId(item.id);
    if (!isValidRecord(item)) continue;
    const parentPermissionRef = {
      resourceType: "thought",
      resourceId: rootId,
      rootId,
      targetKey: `question:${rootId}`,
      version: recordVersion(item.version)
    };
    if (!rootId || !permissionResult(
      store,
      options.accountId,
      parentPermissionRef,
      options.sourcePermission
    ).allowed) continue;
    for (const remark of list(item.remarks)) {
      makeCandidate({
        state, ...options, record: { ...remark, occurredAt: remark.occurredAt || remark.createdAt || item.occurredAt },
        resourceType: "thought", module: "thought", subtype: "remark",
        targetKey: "remark:" + safeId(remark.id), rootId,
        origin: thoughtOrigin(remark), text: remark.text
      });
    }
    for (const followUp of list(item.followUps)) {
      if (safeText(followUp.question)) {
        makeCandidate({
          state, ...options,
          record: { ...followUp, occurredAt: followUp.questionOccurredAt || followUp.createdAt || item.occurredAt },
          resourceType: "thought", module: "thought", subtype: "follow_up_question",
          targetKey: "followup-question:" + safeId(followUp.id), rootId,
          origin: "user_original", text: followUp.question
        });
      }
      if (safeText(followUp.answer)) {
        makeCandidate({
          state, ...options,
          record: {
            ...followUp,
            relatedTo: rootId,
            occurredAt: followUp.answeredAt || followUp.updatedAt || followUp.createdAt || item.occurredAt
          },
          resourceType: "thought", module: "thought", subtype: "follow_up_answer",
          targetKey: "followup-answer:" + safeId(followUp.id), rootId,
          origin: thoughtOrigin(followUp), text: followUp.answer
        });
      }
    }
  }
}

function collectJournals(store, options, state) {
  for (const journal of list(store?.journals)) {
    if (!isValidRecord(journal)) continue;
    const parentRef = {
      resourceType: "journal",
      resourceId: safeId(journal.id),
      rootId: "",
      targetKey: "",
      version: recordVersion(journal.version)
    };
    if (!parentRef.resourceId
      || !permissionResult(store, options.accountId, parentRef, options.sourcePermission).allowed) {
      continue;
    }
    makeCandidate({
      state, ...options, record: journal, resourceType: "journal", module: "journal",
      subtype: "journal", text: [journal.title, journal.content].filter(Boolean).join("：")
    });
    for (const reflection of list(journal.reflections)) {
      addAiText({
        state,
        ...options,
        record: {
          ...reflection,
          occurredAt: reflection.occurredAt || reflection.createdAt || journal.occurredAt
        },
        resourceType: "journal",
        module: "journal",
        subtype: "reflection",
        targetKey: "reflection:" + safeId(reflection.id),
        rootId: safeId(journal.id),
        text: reflection.content || reflection.answer || reflection.text,
        origin: thoughtOrigin(reflection)
      });
    }
  }
}

function collectCaptures(store, options, state) {
  for (const capture of list(store?.captures)) {
    makeCandidate({
      state, ...options, record: capture, resourceType: "capture", module: "capture",
      subtype: "capture", text: [capture.content, ...(list(capture.tags))].filter(Boolean).join("；")
    });
    const transcription = capture.transcription;
    if (transcription?.status === "ready") {
      for (const [field, origin] of [
        ["rawText", "machine_transcription"],
        ["polishedText", "machine_transcription"],
        ["condensedText", "ai_generated"]
      ]) {
        const text = safeText(transcription[field]);
        if (!text) continue;
        addAiText({
          state, ...options,
          record: {
            ...capture,
            occurredAt: capture.occurredAt,
            updatedAt: transcription.updatedAt || capture.updatedAt,
            version: transcription.version || capture.version
          },
          resourceType: "capture",
          module: "capture",
          subtype: "transcription_" + field,
          targetKey: "transcription:" + field,
          permissionTargetKey: "",
          rootId: "",
          text,
          origin
        });
      }
    }
    for (const understanding of list(capture.imageUnderstandings)) {
      const text = understanding?.text || understanding?.summary || understanding?.description;
      if (!safeText(text)) continue;
      addAiText({
        state, ...options,
        record: {
          ...capture,
          occurredAt: capture.occurredAt,
          updatedAt: understanding.updatedAt || capture.updatedAt,
          version: understanding.version || capture.version
        },
        resourceType: "capture",
        module: "capture",
        subtype: "image_understanding",
        targetKey: "image_understanding:" + safeId(understanding.id || "current"),
        permissionTargetKey: "",
        rootId: "",
        text,
        origin: "ai_generated"
      });
    }
  }
}

function collectQuotes(store, options, state) {
  for (const quote of list(store?.quotes)) {
    makeCandidate({
      state, ...options, record: quote, resourceType: "quote", module: "other",
      subtype: "quote", origin: "quoted_external",
      text: [quote.content, quote.source ? "来源：" + quote.source : ""].filter(Boolean).join("；")
    });
  }
}

function collectKeepsakes(store, options, state) {
  for (const keepsake of list(store?.keepsakes)) {
    const auto = keepsake.source === "auto";
    makeCandidate({
      state, ...options, record: keepsake, resourceType: "keepsake", module: "other",
      subtype: "keepsake", origin: auto ? "ai_generated" : "user_original",
      text: [keepsake.title, keepsake.note, ...(list(keepsake.tags))].filter(Boolean).join("；")
    });
  }
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function aggregateMetrics(candidates) {
  const values = new Map();
  for (const candidate of candidates) {
    for (const measurement of candidate.measurements) {
      const key = JSON.stringify([measurement.metric, measurement.unit]);
      if (!values.has(key)) {
        values.set(key, {
          metric: measurement.metric,
          unit: measurement.unit,
          measurementsBySource: new Map(),
          sourceIds: new Set(),
          days: new Set()
        });
      }
      const aggregate = values.get(key);
      // The persisted source identity, not equal values or calendar dates, defines
      // whether two rows are the same measurement. Import replays that retain the
      // same record ID collapse; independent observations remain separate.
      const measurementIdentity = JSON.stringify([
        candidate.sourceId,
        measurement.metric,
        measurement.unit
      ]);
      if (!aggregate.measurementsBySource.has(measurementIdentity)) {
        aggregate.measurementsBySource.set(measurementIdentity, measurement.value);
      }
      aggregate.sourceIds.add(candidate.sourceId);
      if (candidate.occurredOn) aggregate.days.add(candidate.occurredOn);
    }
  }
  return [...values.values()]
    .map(item => {
      const values = [...item.measurementsBySource.values()];
      return {
        metric: item.metric,
        unit: item.unit,
        count: values.length,
        days: item.days.size,
        min: values.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY),
        max: values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY),
        sum: roundMetric(values.reduce((sum, value) => sum + value, 0)),
        mean: roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length),
        sourceIds: [...item.sourceIds].sort()
      };
    })
    .sort((left, right) => left.metric.localeCompare(right.metric) || left.unit.localeCompare(right.unit));
}

function fairOrder(groups) {
  const modules = MODULE_ORDER.filter(module => list(groups[module]).length);
  const sorted = Object.fromEntries(modules.map(module => [
    module,
    interleaveTime([...groups[module]].sort((left, right) => (
      String(left.occurredAt || "").localeCompare(String(right.occurredAt || ""))
      || left.sourceId.localeCompare(right.sourceId)
    )))
  ]));
  const result = [];
  const length = Math.max(0, ...modules.map(module => sorted[module].length));
  for (let index = 0; index < length; index += 1) {
    for (const module of modules) if (sorted[module][index]) result.push(sorted[module][index]);
  }
  return result;
}

function interleaveTime(values) {
  const result = [];
  let first = 0;
  let last = values.length - 1;
  while (first <= last) {
    result.push(values[first]);
    first += 1;
    if (first <= last) {
      result.push(values[last]);
      last -= 1;
    }
  }
  return result;
}

function stratifiedCandidates(groups, limit) {
  const candidates = Object.fromEntries(MODULE_ORDER.map(module => [
    module,
    [...list(groups[module])].sort((left, right) => (
      String(left.occurredAt || "").localeCompare(String(right.occurredAt || ""))
      || left.sourceId.localeCompare(right.sourceId)
    ))
  ]));
  const quotas = Object.fromEntries(MODULE_ORDER.map(module => [
    module,
    candidates[module].length ? 1 : 0
  ]));
  let remaining = Math.max(0, Math.floor(limit) - Object.values(quotas).reduce((sum, value) => sum + value, 0));
  while (remaining > 0) {
    const nextModule = MODULE_ORDER
      .filter(module => quotas[module] < candidates[module].length)
      .sort((left, right) => (
        candidates[right].length / (quotas[right] + 1)
        - candidates[left].length / (quotas[left] + 1)
        || MODULE_ORDER.indexOf(left) - MODULE_ORDER.indexOf(right)
      ))[0];
    if (!nextModule) break;
    quotas[nextModule] += 1;
    remaining -= 1;
  }
  return MODULE_ORDER.flatMap(module => {
    const values = candidates[module];
    const quota = quotas[module];
    if (!quota) return [];
    if (quota === values.length) return values;
    return Array.from({ length: quota }, (_, index) => {
      const selectedIndex = quota === 1
        ? values.length - 1
        : Math.round(index * (values.length - 1) / (quota - 1));
      return values[selectedIndex];
    });
  });
}

function fitText(candidates, budget, perSourceLimit) {
  let remaining = Math.max(0, Math.floor(budget));
  let truncated = false;
  const output = [];
  for (const candidate of candidates) {
    const candidateLimit = Math.min(perSourceLimit, remaining);
    const text = candidate.text.slice(0, candidateLimit);
    const sourceTruncated = candidate.text.length > text.length;
    if (sourceTruncated) truncated = true;
    if (text.length < candidate.text.length) truncated = true;
    remaining -= text.length;
    output.push({
      ...candidate,
      text,
      truncated: sourceTruncated
    });
  }
  return { output, truncated };
}

function publicSource(candidate) {
  return {
    sourceId: candidate.sourceId,
    recordId: candidate.recordId,
    version: candidate.version,
    module: candidate.module,
    subtype: candidate.subtype,
    origin: candidate.origin,
    occurredAt: candidate.occurredAt,
    occurredOn: candidate.occurredOn,
    updatedAt: candidate.updatedAt,
    text: candidate.text,
    ...(candidate.truncated ? { truncated: true } : {})
  };
}

function makeHash(hash) {
  if (typeof hash === "function") return value => hash(String(value));
  return value => crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Build a bounded, permission-filtered snapshot for one account-local day.
 * sourcePermission receives { accountId, sourceRef, sourceKey } and must return true
 * or an object with allowed/contextAllowed: true. Missing or malformed answers deny
 * the source. Stored evidencePermissions remain authoritative and cannot be overridden.
 */
export function buildRecordCompressionInput(store, {
  accountId,
  localDate,
  timezone = DEFAULT_RECORD_TIMEZONE,
  asOf,
  promptVersion,
  sourcePermission,
  hash,
  maxTextChars = RECORD_COMPRESSION_INPUT_TEXT_BUDGET
} = {}) {
  if (!objectValue(store)) throw new TypeError("A store object is required");
  if (!safeId(accountId)) throw new TypeError("accountId is required");
  if (!parseDateKey(localDate)) throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  const normalizedTimezone = safeText(timezone) || DEFAULT_RECORD_TIMEZONE;
  const asOfInstant = parseInstant(asOf);
  if (!asOfInstant) throw new TypeError("asOf must be an ISO timestamp with a timezone");
  if (!safeText(promptVersion)) throw new TypeError("promptVersion is required");
  // Validate timezone even when all sources have occurredOn but no timestamp.
  dateFormatter(normalizedTimezone).format(asOfInstant);

  const start = localDateStart(localDate, normalizedTimezone);
  const end = localDateStart(nextDateKey(localDate), normalizedTimezone);
  const maxChars = Math.min(
    RECORD_COMPRESSION_INPUT_TEXT_BUDGET,
    Math.max(0, Math.floor(Number(maxTextChars) || 0))
  );
  const state = {
    store,
    hash: makeHash(hash),
    coverage: { total: 0, included: 0, excluded: 0, truncated: false },
    manifest: [],
    groups: {},
    warnings: new Set()
  };
  const options = {
    accountId,
    timezone: normalizedTimezone,
    localDate,
    asOf: asOfInstant,
    sourcePermission
  };
  collectCheckins(store, options, state);
  collectDailyRecords(store, options, state);
  collectThoughts(store, options, state);
  collectJournals(store, options, state);
  collectCaptures(store, options, state);
  collectQuotes(store, options, state);
  collectKeepsakes(store, options, state);

  const knownOriginGroups = Object.fromEntries(Object.entries(state.groups).map(([module, candidates]) => [
    module,
    list(candidates).filter(candidate => candidate.origin !== "unknown_origin")
  ]));
  const unknownOriginGroups = Object.fromEntries(Object.entries(state.groups).map(([module, candidates]) => [
    module,
    list(candidates).filter(candidate => candidate.origin === "unknown_origin")
  ]));
  const boundedCandidates = stratifiedCandidates(
    knownOriginGroups,
    RECORD_COMPRESSION_MAX_SOURCE_ITEMS
  );
  const unknownCandidates = stratifiedCandidates(
    unknownOriginGroups,
    RECORD_COMPRESSION_MAX_SOURCE_ITEMS - boundedCandidates.length
  );
  boundedCandidates.push(...unknownCandidates);
  const boundedSourceIds = new Set(boundedCandidates.map(candidate => candidate.sourceId));
  const omittedCandidateCount = Math.max(0, state.manifest.length - boundedSourceIds.size);
  const boundedGroups = Object.fromEntries(Object.entries(state.groups).map(([module, candidates]) => [
    module,
    list(candidates).filter(candidate => boundedSourceIds.has(candidate.sourceId))
  ]));
  if (omittedCandidateCount) {
    state.coverage.excluded += omittedCandidateCount;
    state.coverage.truncated = true;
  }

  const userCandidates = [];
  const aiCandidates = [];
  for (const module of MODULE_ORDER) {
    for (const candidate of list(boundedGroups[module])) {
      if (candidate.origin === "user_original" || candidate.origin === "quoted_external") {
        userCandidates.push(candidate);
      } else if (candidate.origin === "unknown_origin") {
        continue;
      } else {
        aiCandidates.push(candidate);
      }
    }
  }
  const userBudget = Math.floor(maxChars * USER_TEXT_RATIO);
  const aiBudget = maxChars - userBudget;
  const fittedUsers = fitText(fairOrder(Object.fromEntries(
    MODULE_ORDER.map(module => [module, userCandidates.filter(item => item.module === module)])
  )), userBudget, PER_SOURCE_TEXT_LIMIT);
  const fittedAi = fitText(fairOrder(Object.fromEntries(
    MODULE_ORDER.map(module => [module, aiCandidates.filter(item => item.module === module)])
  )), aiBudget, PER_AI_REFERENCE_TEXT_LIMIT);

  const includedUsers = fittedUsers.output.filter(item => (
    item.text || item.measurements.length
  ));
  const includedAi = fittedAi.output.filter(item => item.text);
  const includedIds = new Set([...includedUsers, ...includedAi].map(item => item.sourceId));
  const allTextSourceIds = new Set(MODULE_ORDER.flatMap(module => list(state.groups[module]))
    .filter(candidate => candidate.text)
    .map(candidate => candidate.sourceId));
  const includedTextIds = new Set([...includedUsers, ...includedAi]
    .filter(candidate => candidate.text)
    .map(candidate => candidate.sourceId));
  const textOmittedCount = Math.max(0, allTextSourceIds.size - includedTextIds.size);
  const textPartial = textOmittedCount > 0 || fittedUsers.truncated || fittedAi.truncated;
  state.coverage.included = includedIds.size;
  state.coverage.excluded += Math.max(0, state.coverage.total
    - state.coverage.excluded - state.coverage.included);
  state.coverage.truncated ||= textPartial;
  state.coverage.text = {
    total: allTextSourceIds.size,
    included: includedTextIds.size,
    omitted: textOmittedCount,
    completeness: textPartial ? "partial" : "complete"
  };

  const manifest = state.manifest.sort((left, right) => (
    left.module.localeCompare(right.module)
    || left.occurredAt.localeCompare(right.occurredAt)
    || left.sourceId.localeCompare(right.sourceId)
  ));
  const metrics = aggregateMetrics(list(state.groups.daily).filter(item => (
    item.origin === "user_original"
  )));
  const completeness = asOfInstant.getTime() < end.getTime() ? "partial" : "complete";
  const sourceManifestHash = state.hash(JSON.stringify({
    sources: manifest.map(item => ({
      sourceId: item.sourceId,
      recordId: item.recordId,
      resourceType: item.resourceType,
      rootId: item.rootId,
      targetKey: item.targetKey,
      version: item.version,
      module: item.module,
      subtype: item.subtype,
      origin: item.origin,
      occurredAt: item.occurredAt,
      updatedAt: item.updatedAt,
      permissionRevision: item.permissionRevision,
      sourceHash: item.sourceHash
    })),
    metrics,
    coverage: {
      total: state.coverage.total,
      excluded: state.coverage.excluded,
      truncated: state.coverage.truncated,
      text: state.coverage.text
    },
    completeness
  }));

  const result = {
    schemaVersion: RECORD_COMPRESSION_INPUT_SCHEMA_VERSION,
    accountKey: state.hash("account:" + safeId(accountId)).slice(0, 32),
    promptVersion: safeText(promptVersion),
    window: {
      start: start.toISOString(),
      endExclusive: end.toISOString(),
      asOf: asOfInstant.toISOString(),
      timezone: normalizedTimezone,
      localDate,
      completeness
    },
    sourceManifestHash,
    sourceManifest: manifest,
    coverage: state.coverage,
    metrics,
    userSources: includedUsers.map(publicSource),
    aiReferences: includedAi.map(item => ({
      ...publicSource(item),
      derivedFrom: item.derivedFrom
    })),
    limits: {
      inputTextCharacters: RECORD_COMPRESSION_INPUT_TEXT_BUDGET,
      outputTokens: RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET,
      stableCandidateItems: RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateItems,
      textCharacters: maxChars,
      stableCandidateTokens: RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens
    },
    warnings: [...state.warnings].sort()
  };
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value() {
      const { sourceManifest: _sourceManifest, metrics: metricRows, ...promptInput } = result;
      return {
        ...promptInput,
        metrics: metricRows.map(({ sourceIds: _sourceIds, ...metric }) => metric)
      };
    }
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > RECORD_COMPRESSION_INPUT_JSON_BUDGET_BYTES) {
    throw new RangeError("Record-compression prompt input exceeded its serialized byte budget");
  }
  return result;
}
