import {
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_WINDOW_DAYS
} from "./contract.mjs";

const SUMMARY_SCHEMA_VERSION = RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION;
const AI_REFERENCE_ORIGINS = Object.freeze(["ai_generated", "ai_prediction"]);
const USER_ORIGINS = new Set(["user_original"]);
const QUOTE_ORIGINS = new Set(["quoted_external"]);

const objectValue = value => value !== null
  && typeof value === "object"
  && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function sevenLocalDatesForTimezone(timezone, asOf) {
  if (typeof timezone !== "string" || !timezone) {
    throw new TypeError("A valid IANA timezone is required");
  }
  const endDate = localDateInTimezone(asOf, timezone);
  if (!endDate) throw new TypeError("A valid asOf timestamp is required");
  return Array.from({ length: RECORD_COMPRESSION_WINDOW_DAYS }, (_, index) => (
    shiftDateKey(endDate, index - RECORD_COMPRESSION_WINDOW_DAYS + 1)
  ));
}

function summaryDate(summary) {
  return summary?.window?.localDate || summary?.localDate || "";
}

function summaryTimezone(summary) {
  return summary?.timezone || summary?.window?.timezone || "";
}

function summaryTimestamp(summary) {
  const value = summary?.generatedAt
    || summary?.createdAt
    || summary?.updatedAt
    || summary?.window?.asOf;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function summaryRevision(summary) {
  const revision = Number(summary?.revision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function compareSummaryRecency(left, right) {
  return summaryTimestamp(left) - summaryTimestamp(right)
    || summaryRevision(left) - summaryRevision(right)
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function isEligibleSummary(summary, timezone, promptVersion, dateSet) {
  const date = summaryDate(summary);
  return objectValue(summary)
    && summary.status === "ready"
    && summary.schemaVersion === SUMMARY_SCHEMA_VERSION
    && summaryTimezone(summary) === timezone
    && summary.promptVersion === promptVersion
    && validDateKey(date)
    && dateSet.has(date)
    && !summary.invalidatedAt;
}

function warningRows(days) {
  return days.flatMap(day => day.warnings.map(warning => ({
    localDate: day.localDate,
    warning: clone(warning)
  })));
}

function sourceManifest(summary) {
  if (!Array.isArray(summary?.sourceManifest)) return null;
  return new Map(summary.sourceManifest
    .filter(source => objectValue(source) && typeof source.sourceId === "string")
    .map(source => [source.sourceId, source]));
}

function sourceIdsOf(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(sourceId => typeof sourceId === "string" && sourceId.trim())
    .map(sourceId => sourceId.trim()))];
}

function hasOnlyOrigins(sourceIds, manifest, allowedOrigins) {
  if (!manifest) return true;
  const ids = sourceIdsOf(sourceIds);
  return ids.length > 0 && ids.every(sourceId => (
    allowedOrigins.has(manifest.get(sourceId)?.origin)
  ));
}

function userMetricRows(summary, manifest = sourceManifest(summary)) {
  const metrics = Array.isArray(summary?.metrics) ? summary.metrics : [];
  return metrics.filter(metric => (
    objectValue(metric)
    && hasOnlyOrigins(metric.sourceIds, manifest, USER_ORIGINS)
  ));
}

function projectUserRows(rows, manifest, allowedOrigins = USER_ORIGINS) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => (
    objectValue(row)
    && hasOnlyOrigins(row.sourceIds, manifest, allowedOrigins)
  )).map(row => clone(row));
}

function summaryForTrend(summary) {
  const projected = clone(summary);
  const manifest = sourceManifest(summary);
  const metrics = userMetricRows(summary, manifest);
  // AI references have a dedicated top-level projection. Stable candidates
  // remain separate and are retained only when their provenance is verifiably
  // user-authored.
  delete projected.aiReference;
  delete projected.aiReferences;
  if (manifest) {
    projected.stableUserCandidates = projectUserRows(
      projected.stableUserCandidates,
      manifest
    );
  } else {
    delete projected.stableUserCandidates;
  }
  projected.metrics = clone(metrics);

  if (objectValue(projected.daily)) {
    projected.daily.observations = projectUserRows(
      projected.daily.observations,
      manifest
    );
    if (manifest) {
      const allowedMetricKeys = new Set(metrics.map(metric => metric.metric));
      projected.daily.metricKeys = (Array.isArray(projected.daily.metricKeys)
        ? projected.daily.metricKeys
        : []).filter(key => allowedMetricKeys.has(key));
    }
  }
  if (objectValue(projected.thoughtsIdeas)) {
    for (const key of ["focus", "changes", "openQuestions"]) {
      projected.thoughtsIdeas[key] = projectUserRows(
        projected.thoughtsIdeas[key],
        manifest
      );
    }
  }
  if (objectValue(projected.other)) {
    projected.other.themes = projectUserRows(projected.other.themes, manifest);
    projected.other.collectedQuotes = projectUserRows(
      projected.other.collectedQuotes,
      manifest,
      QUOTE_ORIGINS
    );
  }
  if (Array.isArray(projected.conflicts)) {
    projected.conflicts = projectUserRows(projected.conflicts, manifest);
  }
  return projected;
}

function aiReferencesForDay(summary, localDate) {
  const manifest = sourceManifest(summary);
  if (!manifest || !Array.isArray(summary?.aiReference)) return [];
  const rows = [];
  for (const reference of summary.aiReference) {
    if (!objectValue(reference) || typeof reference.text !== "string" || !reference.text.trim()) {
      continue;
    }
    const sourceIds = sourceIdsOf(reference.sourceIds);
    const byOrigin = new Map();
    for (const sourceId of sourceIds) {
      const origin = manifest.get(sourceId)?.origin;
      if (!AI_REFERENCE_ORIGINS.includes(origin)) continue;
      const ids = byOrigin.get(origin) || [];
      ids.push(sourceId);
      byOrigin.set(origin, ids);
    }
    for (const origin of AI_REFERENCE_ORIGINS) {
      const ownedSourceIds = byOrigin.get(origin) || [];
      if (!ownedSourceIds.length) continue;
      const derivedFrom = sourceIdsOf(reference.derivedFrom).filter(sourceId => (
        manifest.get(sourceId)?.origin === "user_original"
      ));
      rows.push({
        localDate,
        text: reference.text,
        origin,
        originLabel: origin === "ai_prediction" ? "AI prediction" : "AI generated",
        disclaimer: "仅供参考，非用户事实",
        isUserFact: false,
        sourceIds: ownedSourceIds,
        derivedFrom
      });
    }
  }
  return rows;
}

function metricCandidates(days) {
  const candidates = new Map();
  for (const day of days) {
    const manifest = sourceManifest(day.summary);
    const metrics = userMetricRows(day.summary, manifest);
    const allowedMetricKeys = manifest
      ? new Set(metrics.map(metric => metric.metric))
      : null;
    for (const key of Array.isArray(day.summary?.daily?.metricKeys)
      ? day.summary.daily.metricKeys.filter(metricKey => (
        !allowedMetricKeys || allowedMetricKeys.has(metricKey)
      ))
      : []) {
      if (typeof key === "string" && key && !candidates.has(key)) candidates.set(key, []);
    }
    for (const metric of metrics) {
      if (!objectValue(metric) || typeof metric.metric !== "string" || !metric.metric) continue;
      if (!candidates.has(metric.metric)) candidates.set(metric.metric, []);
      candidates.get(metric.metric).push({ localDate: day.localDate, metric });
    }
  }
  return candidates;
}

function summarizeMetric(metric, entries) {
  const sourceIds = [...new Set(entries.flatMap(({ metric: item }) => (
    Array.isArray(item.sourceIds) ? item.sourceIds : []
  )).filter(value => typeof value === "string" && value))].sort();
  const validEntries = entries.filter(({ metric: item }) => (
    Number.isFinite(item.sum)
    && Number.isSafeInteger(item.count)
    && item.count > 0
    && typeof item.unit === "string"
    && item.unit.trim()
  ));
  const units = [...new Set(validEntries.map(({ metric: item }) => item.unit.trim()))].sort();
  const days = [...new Set(validEntries.map(item => item.localDate))].length;
  if (validEntries.length === 0 || units.length !== 1) {
    return {
      metric,
      status: "unknown",
      reason: validEntries.length === 0 ? "no_compatible_points" : "incompatible_units",
      unit: units.length === 1 ? units[0] : "unknown",
      sourceIds,
      units,
      sum: null,
      count: null,
      days,
      average: null,
      min: null,
      max: null,
      range: null
    };
  }

  const sum = validEntries.reduce((total, { metric: item }) => total + item.sum, 0);
  const count = validEntries.reduce((total, { metric: item }) => total + item.count, 0);
  const hasExtrema = validEntries.every(({ metric: item }) => (
    Number.isFinite(item.min)
    && Number.isFinite(item.max)
    && item.min <= item.max
  ));
  const min = hasExtrema
    ? Math.min(...validEntries.map(({ metric: item }) => item.min))
    : null;
  const max = hasExtrema
    ? Math.max(...validEntries.map(({ metric: item }) => item.max))
    : null;
  return {
    metric,
    status: "ready",
    reason: hasExtrema ? "" : "raw_extrema_unavailable",
    unit: units[0],
    sourceIds,
    units,
    sum,
    count,
    days,
    average: count > 0 ? sum / count : null,
    min,
    max,
    range: hasExtrema ? max - min : null
  };
}

export function deriveSevenDayTrend({
  summaries = [],
  localDates = [],
  timezone,
  promptVersion,
  asOf
} = {}) {
  if (typeof timezone !== "string" || !timezone) {
    throw new TypeError("A valid IANA timezone is required");
  }
  if (typeof promptVersion !== "string" || !promptVersion) {
    throw new TypeError("A current promptVersion is required");
  }
  // Intl validates the IANA zone even when no date helper was used by the caller.
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const dates = [...new Set((Array.isArray(localDates) ? localDates : [])
    .filter(validDateKey))].sort();
  const dateSet = new Set(dates);
  const latestByDate = new Map();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!isEligibleSummary(summary, timezone, promptVersion, dateSet)) continue;
    const date = summaryDate(summary);
    const previous = latestByDate.get(date);
    if (!previous || compareSummaryRecency(summary, previous) > 0) {
      latestByDate.set(date, summary);
    }
  }

  const days = dates.map(localDate => {
    const summary = latestByDate.get(localDate);
    if (!summary) {
      return {
        localDate,
        status: "missing",
        completeness: "unknown",
        summary: null,
        coverage: null,
        warnings: []
      };
    }
    return {
      localDate,
      status: "ready",
      completeness: summary.window?.completeness || summary.completeness || "unknown",
      summary: summaryForTrend(summary),
      coverage: clone(summary.coverage ?? null),
      warnings: Array.isArray(summary.warnings) ? clone(summary.warnings) : []
    };
  });
  const readyDays = days.filter(day => day.status === "ready");
  const missingDates = days.filter(day => day.status === "missing").map(day => day.localDate);
  const metrics = [...metricCandidates(readyDays).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, entries]) => summarizeMetric(metric, entries));
  const aiReferences = readyDays.flatMap(day => (
    aiReferencesForDay(latestByDate.get(day.localDate), day.localDate)
  ));

  return {
    timezone,
    asOf: asOf instanceof Date ? asOf.toISOString() : String(asOf || ""),
    localDates: dates,
    coverage: {
      windowDays: dates.length,
      summaryDays: readyDays.length,
      missingDays: missingDates.length,
      missingDates,
      partialDays: readyDays.filter(day => day.completeness === "partial").length,
      truncatedDays: readyDays.filter(day => day.coverage?.truncated === true).length
    },
    days,
    metrics,
    aiReferences,
    warnings: warningRows(readyDays)
  };
}
