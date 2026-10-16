import { readInternalBudgets } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
/**
 * 从当前有效压缩记录构建历史与七天趋势上下文，并校验来源及序列化限额。
 * 建立时间：未知
 * 状态：active
 * 边界：完整统计供显示与聚合；模型上下文仅投影预算内且仍可引用的来源。
 */
import {
  buildHistoricalUserSupplementInput,
  DEFAULT_RECORD_TIMEZONE,
  buildRecordCompressionInput,
  deriveSevenDayTrend,
  estimateRecordCompressionTokens,
  isRecordCompressionRecordEnvelope,
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_SLOT_OUTPUT_SCHEMA_VERSION,
  recordCompressionWindow,
  RECORD_COMPRESSION_PROMPT_VERSION,
  RECORD_COMPRESSION_TASK_KIND,
  RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET,
  RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET,
  RECORD_COMPRESSION_WINDOW_DAYS,
  HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
  sevenLocalDatesForTimezone,
  validateHistoricalUserSupplement
} from "../modules/record-compressions/index.mjs";
import { taskContextSourcePermission } from "./task-context.mjs";

const HISTORICAL_SUPPLEMENT_OPERATION = "historicalSupplement";
const DAILY_OPERATION = "daily";
const TREND_CONTEXT_DAY_ITEM_LIMIT = 2;
const MAX_TREND_CITATIONS = 32;
const RECORD_COMPRESSION_DAY_MS = 86_400_000;
const TREND_AI_REFERENCE_TOKEN_BUDGET = RECORD_COMPRESSION_OUTPUT_BUDGETS.aiReferenceTokens
  * RECORD_COMPRESSION_WINDOW_DAYS;
// Leave room for serialized field names and metadata while keeping the reference block bounded.
const TREND_AI_REFERENCE_BYTE_BUDGET = TREND_AI_REFERENCE_TOKEN_BUDGET * 8;
// UTF-8 serialization stays within the existing character envelope for ordinary text.
const TREND_CONTEXT_BYTE_BUDGET = RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET * 3;
const TREND_AI_REFERENCE_ORIGIN_LABELS = Object.freeze({
  ai_generated: "AI generated",
  ai_prediction: "AI prediction"
});

const list = value => Array.isArray(value) ? value : [];
const objectValue = value => value !== null
  && typeof value === "object"
  && !Array.isArray(value);
const COMPRESSION_SOURCE_COLLECTIONS = Object.freeze([
  "checkins", "dailyRecords", "thoughts", "journals", "captures", "quotes", "keepsakes"
]);
const validTimezone = value => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return typeof value === "string" && Boolean(value);
  } catch {
    return false;
  }
};
const validLocalDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const dateKeyInTimezone = (value, timezone) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("日压缩需要有效时间");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const dateKeyOffset = (dateKey, offset) => {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const inclusiveDateCount = (startDate, endDate) => {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end
    ? Math.floor((end - start) / RECORD_COMPRESSION_DAY_MS) + 1
    : 0;
};
function localDateRange(startDate, endDate, maximumDays = 365) {
  const count = inclusiveDateCount(startDate, endDate);
  if (!count || count > maximumDays) return [];
  return Array.from({ length: count }, (_, index) => dateKeyOffset(startDate, index));
}
function sourceLocalDate(record, timezone, occurredAtOverride) {
  if (validLocalDate(record?.occurredOn)) return record.occurredOn;
  for (const value of [occurredAtOverride || record?.occurredAt, record?.createdAt, record?.updatedAt]) {
    const instant = value instanceof Date ? value : new Date(value || "");
    if (Number.isFinite(instant.getTime())) return dateKeyInTimezone(instant, timezone);
  }
  return "";
}
function sourceLocalDates(store, timezone, asOf) {
  const dates = new Set();
  const add = (record, occurredAtOverride) => {
    const localDate = sourceLocalDate(record, timezone, occurredAtOverride);
    if (localDate && localDate <= dateKeyInTimezone(asOf, timezone)) dates.add(localDate);
  };
  for (const collection of COMPRESSION_SOURCE_COLLECTIONS) {
    for (const record of list(store?.[collection])) add(record);
  }
  for (const thought of list(store?.thoughts)) {
    for (const remark of list(thought?.remarks)) {
      add(remark, remark?.occurredAt || remark?.createdAt || thought?.occurredAt);
    }
    for (const followUp of list(thought?.followUps)) {
      add(followUp, followUp?.questionOccurredAt || followUp?.createdAt || thought?.occurredAt);
      add(followUp, followUp?.answeredAt || followUp?.updatedAt || followUp?.createdAt || thought?.occurredAt);
    }
  }
  for (const journal of list(store?.journals)) {
    for (const reflection of list(journal?.reflections)) {
      add(reflection, reflection?.occurredAt || reflection?.createdAt || journal?.occurredAt);
    }
  }
  return [...dates].sort();
}
const sourceRefFor = source => ({
  resourceType: source.resourceType,
  resourceId: source.recordId,
  rootId: source.rootId || "",
  targetKey: source.targetKey || "",
  version: source.version
});
const textForCitation = source => {
  if (typeof source?.text === "string" && source.text.trim()) return source.text.trim();
  const measurements = list(source?.measurements)
    .filter(item => Number.isFinite(item?.value) && item.metric && item.unit)
    .map(item => `${item.metric}：${item.value} ${item.unit}`);
  return measurements.join("；");
};

function inputForDate(store, {
  accountId,
  localDate,
  timezone,
  asOf,
  hash,
  maxTextChars,
  startDate = "",
  windowKey = ""
}) {
  if (startDate && localDate < startDate) return null;
  return buildRecordCompressionInput(store, {
    windowKey,
    accountId,
    localDate,
    timezone,
    asOf,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    maxTextChars,
    hash,
    sourcePermission: ({ sourceRef }) => (
      taskContextSourcePermission(store, sourceRef, accountId)
    )
  });
}

function historicalSupplementInputFrom(store, {
  accountId,
  timezone,
  asOf,
  hash,
  maxTextChars,
  windowStart,
  windowEnd,
  batchIndex = 0,
  startDate = ""
}) {
  const endDate = validLocalDate(windowEnd)
    ? windowEnd
    : dateKeyInTimezone(asOf, timezone);
  const requestedStart = validLocalDate(windowStart)
    ? windowStart
    : dateKeyOffset(endDate, -(RECORD_COMPRESSION_WINDOW_DAYS - 1));
  const boundedStart = startDate && requestedStart < startDate ? startDate : requestedStart;
  const localDates = localDateRange(boundedStart, endDate);
  if (!localDates.length || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new TypeError("历史稳定表达窗口无效");
  }
  const dateInputs = localDates.map(localDate => ({
    localDate,
    input: inputForDate(store, {
      accountId,
      localDate,
      timezone,
      asOf,
      hash,
      maxTextChars
    })
  }));
  const sourceRows = new Map();
  const sourceMetadata = new Map();
  const textUserManifest = new Map();
  for (const { localDate, input } of dateInputs) {
    const manifestById = new Map(list(input?.sourceManifest).map(source => [source.sourceId, source]));
    for (const source of list(input?.userSources)) {
      const manifest = manifestById.get(source.sourceId);
      if (!manifest || manifest.origin !== "user_original") continue;
      // Daily compression also carries metric-only user sources. Historical
      // expression extraction is text-only, so keep those out of its manifest,
      // coverage, fingerprint, and provider input while preserving strict
      // validation in buildHistoricalUserSupplementInput for actual text rows.
      if (typeof source.text !== "string" || !source.text.trim()) continue;
      textUserManifest.set(manifest.sourceId, manifest);
      sourceRows.set(source.sourceId, {
        sourceId: source.sourceId,
        localDate: manifest.occurredOn || localDate,
        sourceHash: manifest.sourceHash,
        permissionRevision: manifest.permissionRevision,
        origin: manifest.origin,
        text: source.text
      });
      sourceMetadata.set(source.sourceId, manifest);
    }
  }
  const allSources = [...sourceRows.values()].sort((left, right) => (
    right.localDate.localeCompare(left.localDate)
    || left.sourceId.localeCompare(right.sourceId)
  ));
  let remainingSources = allSources;
  let built = buildHistoricalUserSupplementInput({ userSources: [], windowDays: localDates.length });
  let selectedIds = new Set();
  for (let index = 0; index <= batchIndex; index += 1) {
    built = buildHistoricalUserSupplementInput({
      userSources: remainingSources,
      windowDays: localDates.length
    });
    selectedIds = new Set(built.input.userSources.map(source => source.sourceId));
    if (!selectedIds.size || index === batchIndex) break;
    remainingSources = remainingSources.filter(source => !selectedIds.has(source.sourceId));
  }
  const batchSources = built.input.userSources;
  const upstreamCoverageComplete = dateInputs.every(({ input }) => (
    input?.coverage?.truncated !== true
    && input?.coverage?.text?.completeness === "complete"
  ));
  const availableSources = allSources.length;
  const remainingAfterBatch = remainingSources.filter(source => !selectedIds.has(source.sourceId));
  built.coverage = {
    ...built.coverage,
    availableSources,
    includedSources: batchSources.length,
    complete: batchIndex === 0
      && batchSources.length === availableSources
      && built.coverage.complete
      && upstreamCoverageComplete
  };
  const currentUserSources = built.input.userSources.map(source => {
    const manifest = built.sourceManifest.find(item => item.sourceId === source.sourceId);
    const detail = sourceMetadata.get(source.sourceId);
    return {
      ...source,
      localDate: manifest?.localDate || source.localDate,
      sourceHash: manifest?.sourceHash || "",
      permissionRevision: manifest?.permissionRevision ?? -1,
      origin: "user_original",
      text: source.text,
      recordId: detail?.recordId || "",
      resourceType: detail?.resourceType || "",
      rootId: detail?.rootId || "",
      targetKey: detail?.targetKey || "",
      version: detail?.version || 0
    };
  });
  const sourceManifestHash = hash(JSON.stringify({
    sources: [...textUserManifest.values()].map(source => ({
      sourceId: source.sourceId,
      localDate: source.occurredOn,
      sourceHash: source.sourceHash,
      permissionRevision: source.permissionRevision
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    window: { start: boundedStart, end: endDate },
    batchIndex,
    input: built.input,
    coverage: built.coverage
  }));
  return {
    input: built,
    currentUserSources,
    sourceMetadata,
    sourceManifestHash,
    coverage: built.coverage,
    windowStart: boundedStart,
    windowEnd: endDate,
    batchIndex,
    allSourceIds: allSources.map(source => source.sourceId),
    upstreamCoverageComplete,
    hasMoreBatches: remainingAfterBatch.length > 0
  };
}

function currentHistoricalUserSources(store, options, extraDates = []) {
  const dates = new Set([
    ...sevenLocalDatesForTimezone(options.timezone, options.asOf),
    ...extraDates.filter(validLocalDate)
  ]);
  const sources = new Map();
  const sourceMetadata = new Map();
  for (const localDate of dates) {
    const input = inputForDate(store, { ...options, localDate });
    const manifestById = new Map(list(input?.sourceManifest).map(source => [source.sourceId, source]));
    for (const source of list(input?.userSources)) {
      const manifest = manifestById.get(source.sourceId);
      if (!manifest || manifest.origin !== "user_original"
        || typeof source.text !== "string" || !source.text.trim()) continue;
      sources.set(source.sourceId, {
        sourceId: source.sourceId,
        localDate: manifest.occurredOn || localDate,
        sourceHash: manifest.sourceHash,
        permissionRevision: manifest.permissionRevision,
        origin: "user_original",
        text: source.text,
        recordId: manifest.recordId || "",
        resourceType: manifest.resourceType || "",
        rootId: manifest.rootId || "",
        targetKey: manifest.targetKey || "",
        version: manifest.version || 0
      });
      sourceMetadata.set(source.sourceId, manifest);
    }
  }
  return { currentUserSources: [...sources.values()], sourceMetadata };
}

function permittedHistoricalTextDates(store, options) {
  const dates = sourceLocalDates(store, options.timezone, options.asOf);
  return dates.filter(localDate => {
    const input = inputForDate(store, { ...options, localDate });
    const manifestById = new Map(list(input?.sourceManifest).map(source => [source.sourceId, source]));
    return list(input?.userSources).some(source => (
      typeof source.text === "string"
      && source.text.trim()
      && manifestById.get(source.sourceId)?.origin === "user_original"
    ));
  });
}

function historicalTaskRange(task, timezone, startDate = "") {
  const payload = task?.payload || {};
  const windowEnd = validLocalDate(payload.windowEnd)
    ? payload.windowEnd
    : validLocalDate(payload.localDate) ? payload.localDate : "";
  if (!windowEnd) return null;
  const windowStart = validLocalDate(payload.windowStart)
    ? payload.windowStart
    : dateKeyOffset(windowEnd, -(RECORD_COMPRESSION_WINDOW_DAYS - 1));
  if (startDate && windowStart < startDate) return null;
  const dates = localDateRange(windowStart, windowEnd);
  if (!dates.length) return null;
  return { windowStart, windowEnd, timezone };
}

function historicalCoverageAfterSave(store, currentTask, options) {
  const today = dateKeyInTimezone(options.asOf, options.timezone);
  const recentRange = {
    windowStart: options.startDate && dateKeyOffset(today, -(RECORD_COMPRESSION_WINDOW_DAYS - 1)) < options.startDate
      ? options.startDate : dateKeyOffset(today, -(RECORD_COMPRESSION_WINDOW_DAYS - 1)),
    windowEnd: today,
    timezone: options.timezone
  };
  const taskRows = [
    ...list(store?.aiTasks),
    ...(currentTask ? [currentTask] : [])
  ].filter(task => (
    task.kind === RECORD_COMPRESSION_TASK_KIND
    && task.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION
    && task.payload?.timezone === options.timezone
    && task.payload?.promptVersion === HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION
    && (task.status === "succeeded" || task.id === currentTask?.id)
  ));
  const ranges = new Map([[JSON.stringify([recentRange.windowStart, recentRange.windowEnd]), recentRange]]);
  for (const task of taskRows) {
    const range = historicalTaskRange(task, options.timezone, options.startDate);
    if (range) ranges.set(JSON.stringify([range.windowStart, range.windowEnd]), range);
  }
  const succeeded = (snapshot, range, batchIndex) => taskRows.some(task => {
    const taskRange = historicalTaskRange(task, options.timezone, options.startDate);
    const current = task.id === currentTask?.id;
    return taskRange?.windowStart === range.windowStart
      && taskRange?.windowEnd === range.windowEnd
      && (Number.isSafeInteger(task.payload?.batchIndex) ? task.payload.batchIndex : 0) === batchIndex
      && task.payload?.sourceManifestHash === snapshot.sourceManifestHash
      && (current || task.status === "succeeded");
  });
  const rangeState = new Map();
  const availableIdsByRange = new Map();
  const includedIdsByRange = new Map();
  for (const range of ranges.values()) {
    const rangeKey = JSON.stringify([range.windowStart, range.windowEnd]);
    const availableIds = new Set();
    const includedIds = new Set();
    let upstreamComplete = true;
    let rangeComplete = true;
    for (let batchIndex = 0; batchIndex < 1024; batchIndex += 1) {
      const snapshot = historicalSupplementInputFrom(store, {
        ...options,
        windowStart: range.windowStart,
        windowEnd: range.windowEnd,
        batchIndex
      });
      for (const sourceId of snapshot.allSourceIds) availableIds.add(sourceId);
      upstreamComplete &&= snapshot.upstreamCoverageComplete;
      const batchSources = snapshot.input.input.userSources;
      if (!batchSources.length) {
        if (snapshot.allSourceIds.length && includedIds.size < availableIds.size) rangeComplete = false;
        break;
      }
      if (!succeeded(snapshot, range, batchIndex)) rangeComplete = false;
      else for (const source of batchSources) includedIds.add(source.sourceId);
      if (!snapshot.hasMoreBatches) break;
      if (batchIndex === 1023) rangeComplete = false;
    }
    rangeComplete &&= upstreamComplete && includedIds.size === availableIds.size;
    rangeState.set(rangeKey, { range, complete: rangeComplete });
    availableIdsByRange.set(rangeKey, availableIds);
    includedIdsByRange.set(rangeKey, includedIds);
  }

  const sourceDates = permittedHistoricalTextDates(store, options);
  let coveredStart = recentRange.windowStart;
  const currentRangeState = rangeState.get(JSON.stringify([
    recentRange.windowStart, recentRange.windowEnd
  ]));
  if (currentRangeState?.complete) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const state of rangeState.values()) {
        if (!state.complete || state.range.windowStart >= coveredStart) continue;
        if (state.range.windowEnd < dateKeyOffset(coveredStart, -1)
          && sourceDates.some(date => date > state.range.windowEnd && date < coveredStart)) continue;
        coveredStart = state.range.windowStart;
        moved = true;
      }
    }
  }
  const availableIds = new Set();
  const includedIds = new Set();
  for (const [rangeKey, state] of rangeState) {
    if (state.range.windowEnd < coveredStart
      || state.range.windowStart > today) continue;
    for (const sourceId of availableIdsByRange.get(rangeKey) || []) availableIds.add(sourceId);
    for (const sourceId of includedIdsByRange.get(rangeKey) || []) includedIds.add(sourceId);
  }
  const olderUnprocessed = !coveredStart || sourceDates.some(date => date < coveredStart);
  const windowDays = coveredStart
    ? Math.min(365, inclusiveDateCount(coveredStart, today))
    : RECORD_COMPRESSION_WINDOW_DAYS;
  return {
    windowDays: Math.max(RECORD_COMPRESSION_WINDOW_DAYS, windowDays),
    availableSources: availableIds.size,
    includedSources: [...includedIds].filter(sourceId => availableIds.has(sourceId)).length,
    complete: Boolean(currentRangeState?.complete && coveredStart && !olderUnprocessed
      && includedIds.size === availableIds.size)
  };
}

function historicalSupplementContextFrom(store, options) {
  if (options.startDate && dateKeyInTimezone(options.asOf, options.timezone) < options.startDate) {
    return { payload: { scope: "historical_user_supplement", records: [], invalidatedCount: 0,
      coverage: { windowDays: 0, availableSources: 0, includedSources: 0, complete: false } },
      citationSources: [], fingerprint: options.hash(JSON.stringify(["before-start-date", options.startDate])), input: null };
  }
  const recentSnapshot = historicalSupplementInputFrom(store, options);
  const storedRecordDates = list(store?.historicalUserSupplement?.records)
    .map(record => record?.source?.localDate);
  const currentSources = currentHistoricalUserSources(store, options, storedRecordDates);
  const validated = validateHistoricalUserSupplement(store?.historicalUserSupplement, {
    userSources: currentSources.currentUserSources
  });
  const records = [];
  const citationSources = [];
  for (const record of validated.records) {
    const detail = currentSources.sourceMetadata.get(record.source.sourceId);
    if (!detail) continue;
    const citationId = `historical-supplement:${record.source.sourceId}:${options.hash(record.exactQuote).slice(0, 12)}`;
    records.push({
      statement: record.statement,
      exactQuote: record.exactQuote,
      sourceId: record.source.sourceId,
      localDate: record.source.localDate,
      citationId
    });
    const currentSource = currentSources.currentUserSources.find(item => (
      item.sourceId === record.source.sourceId
    ));
    if (!currentSource?.text.includes(record.exactQuote)) continue;
    citationSources.push({
      citationId,
      text: record.exactQuote,
      source: {
        id: citationId,
        resourceType: detail.resourceType,
        resourceId: detail.recordId,
        recordType: detail.subtype,
        origin: "user",
        informationType: "user_original",
        version: detail.version,
        contentSha256: record.source.sourceHash,
        location: {
          view: "historical-user-supplement",
          targetId: detail.recordId,
          rootId: detail.rootId || "",
          targetKey: detail.targetKey || "",
          occurredOn: record.source.localDate
        }
      }
    });
  }
  return {
    payload: {
      scope: "historical_user_supplement",
      coverage: options.startDate
        ? historicalCoverageAfterSave(store, null, options)
        : structuredClone(store?.historicalUserSupplement?.coverage || recentSnapshot.coverage),
      records,
      invalidatedCount: validated.invalidated.length
    },
    citationSources,
    fingerprint: options.hash(JSON.stringify({
      sourceManifestHash: recentSnapshot.sourceManifestHash,
      records,
      invalidated: validated.invalidated
    })),
    input: recentSnapshot
  };
}

// 预筛与最终选择共享封装/窗口条件；仅来源哈希依赖实际输入构建。
function matchesReadySummary(summary, localDate, timezone, windowKey) {
  return summary?.status === "ready"
    && isRecordCompressionRecordEnvelope(summary, { ready: true })
    && [RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION, RECORD_SLOT_OUTPUT_SCHEMA_VERSION].includes(summary?.schemaVersion)
    && summary?.promptVersion === RECORD_COMPRESSION_PROMPT_VERSION
    && summary?.localDate === localDate
    && summary?.timezone === timezone
    && (summary.windowKey || "") === windowKey
    && summary?.invalidatedAt == null;
}

function eligibleReadySummary(store, localDate, timezone, input) {
  if (input.window.windowKey && Date.parse(input.window.endExclusive) > Date.parse(input.window.asOf)) return null;
  return list(store.recordCompressions)
    .filter(summary => (
      matchesReadySummary(summary, localDate, timezone, input.window.windowKey || "")
      && summary.sourceManifestHash === input.sourceManifestHash
    ))
    .sort((left, right) => (
      String(right.generatedAt || "").localeCompare(String(left.generatedAt || ""))
      || Number(right.revision || 0) - Number(left.revision || 0)
    ))[0] || null;
}

function readyInputsForDate(store, options) {
  const hasCandidate = windowKey => list(store.recordCompressions).some(summary => (
    matchesReadySummary(summary, options.localDate, options.timezone, windowKey)
  ));
  const incremental = [];
  if (options.timezone === DEFAULT_RECORD_TIMEZONE) {
    for (const slot of ["morning", "evening"]) {
      const window = recordCompressionWindow(options.localDate, slot);
      if (Date.parse(window.endExclusive) > Date.parse(options.asOf)) continue;
      if (!hasCandidate(window.windowKey)) continue;
      const input = inputForDate(store, { ...options, windowKey: window.windowKey });
      const summary = input && eligibleReadySummary(store, options.localDate, options.timezone, input);
      if (summary) incremental.push({ input, summary });
    }
  }
  if (incremental.length) return incremental;
  if (!hasCandidate(options.windowKey || "")) return [];
  const input = inputForDate(store, options);
  const summary = input && eligibleReadySummary(store, options.localDate, options.timezone, input);
  return summary ? [{ input, summary }] : [];
}

/** 核对任务原始输入哈希的账户绑定；不以赞助账户或当前终态猜测归属。 @since unreleased */
function compressionTaskAccountMatches(task, { accountId, hash }) {
  const payload = task?.payload || {};
  const range = payload.operation === HISTORICAL_SUPPLEMENT_OPERATION ? historicalTaskRange(task, payload.timezone) : null;
  const expected = payload.operation === HISTORICAL_SUPPLEMENT_OPERATION ? {
    operation: HISTORICAL_SUPPLEMENT_OPERATION, accountId, timezone: payload.timezone, promptVersion: payload.promptVersion,
    windowStart: range?.windowStart || payload.windowStart, windowEnd: range?.windowEnd || payload.windowEnd,
    batchIndex: Number.isSafeInteger(payload.batchIndex) ? payload.batchIndex : 0, sourceManifestHash: payload.sourceManifestHash
  } : {
    accountId: hash(`account:${String(accountId).trim().slice(0, 100)}`).slice(0, 32), localDate: payload.localDate,
    timezone: payload.timezone, promptVersion: payload.promptVersion,
    ...(payload.windowKey ? { windowKey: payload.windowKey } : {}), sourceManifestHash: payload.sourceManifestHash
  };
  return task.requestedInputHash === hash(JSON.stringify(expected));
}

/** 活动失败为只读派生视图；只有同能力/精确窗口且当前可消费的替代才能退出活动。 @since unreleased */
function compressionFailureView(store, options) {
  const active = [], replaced = [];
  for (const task of list(store.aiTasks)) {
    if (task.kind !== RECORD_COMPRESSION_TASK_KIND || task.status !== "failed"
      || !compressionTaskAccountMatches(task, options)) continue;
    const payload = task.payload || {};
    let replacementId = "";
    try {
      if (payload.operation === DAILY_OPERATION) {
        const input = inputForDate(store, { ...options, localDate: payload.localDate, timezone: payload.timezone, windowKey: payload.windowKey || "" });
        const summary = eligibleReadySummary(store, payload.localDate, payload.timezone, input);
        const permitted = new Set(list(input.sourceManifest).filter(source => ["user_original", "quoted_external"].includes(source.origin)).map(source => source.sourceId));
        const rows = summary ? [
          ...list(summary.daily?.observations), ...list(summary.thoughtsIdeas?.focus), ...list(summary.thoughtsIdeas?.changes),
          ...list(summary.thoughtsIdeas?.openQuestions), ...list(summary.other?.themes), ...list(summary.other?.collectedQuotes), ...list(summary.metrics)
        ] : [];
        if (rows.some(row => list(row.sourceIds).length && row.sourceIds.every(sourceId => permitted.has(sourceId)))) replacementId = summary.id;
      } else if (payload.operation === HISTORICAL_SUPPLEMENT_OPERATION) {
        const range = historicalTaskRange(task, payload.timezone);
        if (range) {
          const current = historicalSupplementInputFrom(store, { ...options, ...range, batchIndex: payload.batchIndex || 0 });
          const sources = currentHistoricalUserSources(store, { ...options, timezone: payload.timezone }, list(store.historicalUserSupplement?.records).map(row => row.source?.localDate));
          const actualContext = historicalSupplementContextFrom(store, { ...options, timezone: payload.timezone });
          const consumed = validateHistoricalUserSupplement(store.historicalUserSupplement, { userSources: sources.currentUserSources }).records
            .filter(record => actualContext.payload.records.some(row => row.sourceId === record.source.sourceId && row.exactQuote === record.exactQuote));
          replacementId = list(store.aiTasks).find(candidate => candidate.kind === task.kind && candidate.status === "succeeded"
            && candidate.payload?.operation === payload.operation && candidate.payload?.timezone === payload.timezone
            && historicalTaskRange(candidate, payload.timezone)?.windowStart === range.windowStart
            && historicalTaskRange(candidate, payload.timezone)?.windowEnd === range.windowEnd
            && (candidate.payload?.batchIndex || 0) === (payload.batchIndex || 0)
            && candidate.payload?.sourceManifestHash === current.sourceManifestHash
            && compressionTaskAccountMatches(candidate, options)
            && list(candidate.replacementReceipt?.sources).some(reference => consumed.some(record => record.source.sourceId === reference.sourceId
              && record.source.sourceHash === reference.sourceHash && record.source.permissionRevision === reference.permissionRevision
              && options.hash(record.exactQuote) === reference.quoteSha256)))?.id || "";
        }
      }
    } catch { /* 无法证明合法、当前可消费的替代，原失败继续保持活动。 */ }
    const row = { taskId: task.id, operation: payload.operation, localDate: payload.localDate,
      windowKey: payload.windowKey || "", windowStart: payload.windowStart || "", windowEnd: payload.windowEnd || "",
      state: replacementId ? "replaced" : "pendingFault", ...(replacementId ? { replacementId } : {}) };
    (replacementId ? replaced : active).push(row);
  }
  return { active, replaced, pendingFaultCount: active.length };
}

function narrativeRows(summary, section, field, maximum = TREND_CONTEXT_DAY_ITEM_LIMIT) {
  return list(summary?.[section]?.[field])
    .slice(0, maximum)
    .map(item => ({
      text: String(item?.text || "").slice(0, 180),
      ...(typeof item?.nature === "string" ? { nature: item.nature } : {}),
      sourceIds: list(item?.sourceIds).slice(0, 4)
    }))
    .filter(item => item.text && item.sourceIds.length);
}

function fitTrendAiReferences(references) {
  const fitted = [];
  let truncated = false;
  for (const reference of list(references)) {
    const originLabel = TREND_AI_REFERENCE_ORIGIN_LABELS[reference?.origin];
    if (!originLabel || typeof reference?.text !== "string" || !reference.text.trim()) {
      truncated = true;
      continue;
    }
    const row = {
      localDate: reference.localDate,
      text: reference.text,
      origin: reference.origin,
      originLabel,
      disclaimer: "仅供参考，非用户事实",
      isUserFact: false
    };
    const candidate = [...fitted, row];
    const serialized = JSON.stringify(candidate);
    if (estimateRecordCompressionTokens(candidate) > TREND_AI_REFERENCE_TOKEN_BUDGET
      || Buffer.byteLength(serialized, "utf8") > TREND_AI_REFERENCE_BYTE_BUDGET) {
      return { rows: fitted, truncated: true };
    }
    fitted.push(row);
  }
  return { rows: fitted, truncated };
}

function pruneTrendSources(payload) {
  const sourceIds = new Set(list(payload.days).flatMap(day => [
    ...list(day.daily), ...list(day.thoughts), ...list(day.themes)
  ]).flatMap(row => list(row.sourceIds)));
  const citationIds = new Set([
    ...list(payload.userFacts), ...list(payload.userSubjective), ...list(payload.metrics)
  ].flatMap(row => list(row.citations)));
  payload.sources = list(payload.sources).filter(source => (
    sourceIds.has(source.sourceId) || citationIds.has(source.citationId)
  ));
  if (payload.metricsCoverage) {
    payload.metricsCoverage.included = payload.metrics.length;
    payload.metricsCoverage.truncated = payload.metrics.length < payload.metricsCoverage.available;
  }
}

function contextTrendFrom(store, {
  accountId,
  timezone,
  asOf,
  hash,
  maxTextChars,
  startDate = ""
}) {
  const localDates = sevenLocalDatesForTimezone(timezone, asOf).filter(date => !startDate || date >= startDate);
  const currentInputs = new Map();
  const summaries = [];
  for (const localDate of localDates) {
    const selected = readyInputsForDate(store, {
      accountId,
      localDate,
      timezone,
      asOf,
      hash,
      maxTextChars
    });
    currentInputs.set(localDate, {
      sourceManifest: selected.flatMap(row => row.input.sourceManifest),
      userSources: selected.flatMap(row => row.input.userSources)
    });
    summaries.push(...selected.map(row => row.summary));
  }
  const trend = deriveSevenDayTrend({
    summaries,
    localDates,
    timezone,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
    asOf
  });
  const dayRows = trend.days.filter(day => day.summary).map(day => ({
    localDate: day.localDate,
    ...(day.slots ? { slots: day.slots, missingSlots: day.missingSlots } : {}),
    completeness: day.completeness,
    daily: narrativeRows(day.summary, "daily", "observations"),
    thoughts: [
      ...narrativeRows(day.summary, "thoughtsIdeas", "focus", 1),
      ...narrativeRows(day.summary, "thoughtsIdeas", "changes", 1),
      ...narrativeRows(day.summary, "thoughtsIdeas", "openQuestions", 1)
    ],
    themes: narrativeRows(day.summary, "other", "themes", 1)
  }));
  const metricRows = trend.metrics.slice(0, 24);
  const referencedSourceIds = new Set();
  for (const day of trend.days) {
    const summary = day.summary;
    if (!summary) continue;
    for (const rows of [
      narrativeRows(summary, "daily", "observations"),
      narrativeRows(summary, "thoughtsIdeas", "focus", 1),
      narrativeRows(summary, "thoughtsIdeas", "changes", 1),
      narrativeRows(summary, "thoughtsIdeas", "openQuestions", 1),
      narrativeRows(summary, "other", "themes", 1)
    ]) {
      for (const row of rows) for (const sourceId of row.sourceIds) referencedSourceIds.add(sourceId);
    }
    for (const metric of list(summary.metrics)) {
      for (const sourceId of list(metric?.sourceIds)) referencedSourceIds.add(sourceId);
    }
  }

  const sources = [];
  const displaySources = [];
  const citationSources = [];
  for (const localDate of localDates) {
    const input = currentInputs.get(localDate);
    const byId = new Map(list(input?.userSources).map(source => [source.sourceId, source]));
    const sourceManifest = new Map(list(input?.sourceManifest).map(source => [source.sourceId, source]));
    for (const sourceId of referencedSourceIds) {
      if (sources.length >= MAX_TREND_CITATIONS) break;
      const source = byId.get(sourceId);
      const manifest = sourceManifest.get(sourceId);
      if (!source || !manifest || manifest.origin !== "user_original") continue;
      const text = textForCitation(source);
      if (!text) continue;
      const citationId = `trend:${localDate}:${sourceId}`;
      const promptText = text.slice(0, readInternalBudgets().sourceCharacterMax);
      sources.push({ citationId, sourceId, localDate });
      displaySources.push({
        sourceId,
        localDate,
        text: promptText,
        recordId: manifest.recordId,
        resourceType: manifest.resourceType,
        subtype: manifest.subtype,
        version: manifest.version,
        rootId: manifest.rootId || "",
        targetKey: manifest.targetKey || ""
      });
      citationSources.push({
        citationId,
        text: promptText,
        source: {
          id: citationId,
          resourceType: manifest.resourceType,
          resourceId: manifest.recordId,
          recordType: manifest.subtype,
          origin: "user",
          informationType: "user_original",
          version: manifest.version,
          contentSha256: manifest.sourceHash,
          location: {
            view: "daily-record-compression",
            targetId: manifest.recordId,
            rootId: manifest.rootId || "",
            targetKey: manifest.targetKey || "",
            occurredOn: localDate
          }
        }
      });
    }
  }

  const payload = {
    scope: "historical_supplement",
    timezone,
    localDates,
    availableDays: trend.coverage.summaryDays,
    missingDates: trend.coverage.missingDates,
    days: dayRows,
    metricsCoverage: { available: trend.metrics.length, included: 0, truncated: false },
    metrics: metricRows.map(({ sourceIds = [], ...metric }) => ({
      ...metric,
      citations: []
    })),
    aiReferences: [],
    aiReferencesTruncated: false,
    contextTruncated: false,
    sources
  };
  const fittedAiReferences = fitTrendAiReferences(trend.aiReferences);
  payload.aiReferences = fittedAiReferences.rows;
  payload.aiReferencesTruncated = fittedAiReferences.truncated;
  const citationsBySource = new Map();
  for (const source of sources) {
    const citations = citationsBySource.get(source.sourceId) || [];
    citations.push(source.citationId);
    citationsBySource.set(source.sourceId, citations);
  }
  payload.metrics = metricRows.map(({ sourceIds = [], ...metric }) => ({
    ...metric,
    citations: [...new Set(sourceIds.flatMap(sourceId => (
      citationsBySource.get(sourceId) || []
    )))].slice(0, 8)
  })).filter(metric => metric.citations.length > 0);
  payload.contextTruncated = payload.metrics.length < trend.metrics.length;
  const retainReferencedSources = () => pruneTrendSources(payload);
  retainReferencedSources();
  const exceedsTrendBudget = () => {
    const serialized = JSON.stringify(payload);
    return serialized.length > RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET
      || Buffer.byteLength(serialized, "utf8") > TREND_CONTEXT_BYTE_BUDGET
      || estimateRecordCompressionTokens(payload) > RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET;
  };
  while (exceedsTrendBudget()) {
    payload.contextTruncated = true;
    if (payload.aiReferences.length) {
      payload.aiReferences.pop();
      payload.aiReferencesTruncated = true;
    } else if (payload.metrics.length) {
      // 完整统计仍保存并供显示；优先裁模型统计投影，避免挤掉
      // 所有可核验来源的用户日正文。
      payload.metrics.pop();
    } else {
      const lastDay = payload.days.at(-1);
      if (!lastDay) break;
      if (lastDay.themes.length) lastDay.themes.pop();
      else if (lastDay.thoughts.length) lastDay.thoughts.pop();
      else if (lastDay.daily.length) lastDay.daily.pop();
      else payload.days.pop();
    }
    retainReferencedSources();
  }
  const retainedCitationIds = new Set(payload.sources.map(source => source.citationId));
  payload.metrics = payload.metrics.map(metric => ({
    ...metric,
    citations: metric.citations.filter(citationId => retainedCitationIds.has(citationId))
  })).filter(metric => metric.citations.length > 0);
  retainReferencedSources();
  const citationIds = new Set(payload.sources.map(source => source.citationId));
  return {
    timezone,
    localDates,
    coverage: structuredClone(trend.coverage),
    displayDays: structuredClone(trend.days),
    displaySources,
    payload,
    citationSources: citationSources.filter(source => citationIds.has(source.citationId)),
    fingerprint: hash(JSON.stringify({
      dates: localDates,
      summaries: summaries.map(summary => [summary.localDate, summary.sourceManifestHash, summary.revision]),
      payload
    }))
  };
}

function separateTrendContext(store, trendResult, {
  accountId,
  timezone,
  asOf,
  hash,
  maxTextChars
}) {
  const payload = structuredClone(trendResult.payload);
  const sourceById = new Map(list(payload.sources).map(source => [source.sourceId, source]));
  const facts = [];
  const subjective = [];
  for (const day of list(payload.days)) {
    for (const [module, rows] of [
      ["daily", list(day.daily)],
      ["thought", list(day.thoughts)],
      ["other", list(day.themes)]
    ]) {
      for (const row of rows) {
        const sourceIds = list(row.sourceIds).filter(sourceId => sourceById.has(sourceId));
        if (sourceIds.length !== list(row.sourceIds).length) payload.contextTruncated = true;
        if (!sourceIds.length || !row.text) continue;
        const item = {
          localDate: day.localDate,
          module,
          text: row.text,
          nature: row.nature === "user_fact" ? "user_fact" : "user_subjective",
          sourceIds,
          citations: [...new Set(sourceIds.map(sourceId => sourceById.get(sourceId).citationId))]
        };
        (item.nature === "user_fact" ? facts : subjective).push(item);
      }
    }
  }

  const quoteSources = [];
  const quoteCitationSources = [];
  for (const localDate of sevenLocalDatesForTimezone(timezone, asOf)) {
    const selected = readyInputsForDate(store, {
      accountId,
      localDate,
      timezone,
      asOf,
      hash,
      maxTextChars
    });
    for (const { input, summary } of selected) {
    const sourceManifest = new Map(list(input.sourceManifest).map(source => [source.sourceId, source]));
    const inputSources = new Map(list(input.userSources).map(source => [source.sourceId, source]));
    for (const row of list(summary.other?.collectedQuotes)) {
      const sourceIds = list(row?.sourceIds).filter(sourceId => (
        sourceManifest.get(sourceId)?.origin === "quoted_external"
        && inputSources.has(sourceId)
      ));
      for (const sourceId of sourceIds) {
        if (quoteSources.length + payload.sources.length >= MAX_TREND_CITATIONS) break;
        const source = inputSources.get(sourceId);
        const manifest = sourceManifest.get(sourceId);
        const text = textForCitation(source);
        if (!text) continue;
        const citationId = `trend-quote:${localDate}:${sourceId}`;
        const promptText = text.slice(0, readInternalBudgets().sourceCharacterMax);
        quoteSources.push({
          citationId,
          sourceId,
          localDate,
          origin: "quoted_external",
          label: "外部引文/用户收藏，不代表用户观点"
        });
        quoteCitationSources.push({
          citationId,
          text: promptText,
          source: {
            id: citationId,
            resourceType: manifest.resourceType,
            resourceId: manifest.recordId,
            recordType: manifest.subtype,
            origin: "third_party",
            informationType: "quoted_external",
            version: manifest.version,
            contentSha256: manifest.sourceHash,
            location: {
              view: "daily-record-compression",
              targetId: manifest.recordId,
              rootId: manifest.rootId || "",
              targetKey: manifest.targetKey || "",
              occurredOn: localDate
            }
          }
        });
      }
    }
    }
  }

  payload.userFacts = facts;
  payload.userSubjective = subjective;
  payload.collectedQuotes = quoteSources;
  payload.days = list(payload.days).map(({ localDate, completeness, slots, missingSlots }) => ({ localDate, completeness,
    ...(slots ? { slots, missingSlots } : {}) }));

  const userTrendBudget = RECORD_COMPRESSION_OUTPUT_BUDGETS.userTrendTokens
    * RECORD_COMPRESSION_WINDOW_DAYS;
  const trendTooLarge = () => (
    JSON.stringify(payload).length > RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET
    || Buffer.byteLength(JSON.stringify(payload), "utf8") > TREND_CONTEXT_BYTE_BUDGET
    || estimateRecordCompressionTokens(payload) > RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET
  );
  const userTrendTooLarge = () => estimateRecordCompressionTokens({
    userFacts: payload.userFacts,
    userSubjective: payload.userSubjective,
    collectedQuotes: payload.collectedQuotes
  }) > userTrendBudget;
  pruneTrendSources(payload);
  while (userTrendTooLarge()) {
    payload.contextTruncated = true;
    if (payload.collectedQuotes.length) {
      payload.collectedQuotes.pop();
    } else if (payload.userSubjective.length) {
      payload.userSubjective.pop();
    } else if (payload.userFacts.length) {
      payload.userFacts.pop();
    } else break;
    pruneTrendSources(payload);
  }
  while (trendTooLarge()) {
    payload.contextTruncated = true;
    if (payload.aiReferences.length) {
      payload.aiReferences.pop();
      payload.aiReferencesTruncated = true;
    } else if (payload.metrics.length) {
      payload.metrics.pop();
    } else if (payload.collectedQuotes.length) {
      payload.collectedQuotes.pop();
    } else if (payload.userSubjective.length) {
      payload.userSubjective.pop();
    } else if (payload.userFacts.length) {
      payload.userFacts.pop();
    } else break;
    pruneTrendSources(payload);
  }

  const usedCitationIds = new Set([
    ...payload.userFacts,
    ...payload.userSubjective
  ].flatMap(row => row.citations));
  for (const metric of payload.metrics) {
    for (const citationId of list(metric.citations)) usedCitationIds.add(citationId);
  }
  const usedQuoteCitationIds = new Set(payload.collectedQuotes.map(source => source.citationId));
  payload.sources = list(payload.sources).filter(source => usedCitationIds.has(source.citationId));
  return {
    payload,
    citationSources: [
      ...trendResult.citationSources.filter(source => usedCitationIds.has(source.citationId)),
      ...quoteCitationSources.filter(source => usedQuoteCitationIds.has(source.citationId))
    ]
  };
}

function currentTrendFrom(store, options) {
  const trend = contextTrendFrom(store, options);
  const trendContext = separateTrendContext(store, trend, options);
  const historicalSupplement = historicalSupplementContextFrom(store, { ...options, timezone: options.historicalTimezone || options.timezone });
  return {
    ...trend,
    failureState: compressionFailureView(store, options),
    payload: trendContext.payload,
    citationSources: trendContext.citationSources,
    historicalUserSupplement: historicalSupplement.payload,
    historicalUserSupplementCitationSources: historicalSupplement.citationSources,
    fingerprint: options.hash(JSON.stringify({
      trend: trend.fingerprint,
      payload: trendContext.payload,
      historicalSupplement: historicalSupplement.fingerprint
    }))
  };
}

export {
  COMPRESSION_SOURCE_COLLECTIONS,
  compressionTaskAccountMatches,
  compressionFailureView,
  DAILY_OPERATION,
  HISTORICAL_SUPPLEMENT_OPERATION,
  MAX_TREND_CITATIONS,
  RECORD_COMPRESSION_DAY_MS,
  TREND_AI_REFERENCE_BYTE_BUDGET,
  TREND_AI_REFERENCE_ORIGIN_LABELS,
  TREND_AI_REFERENCE_TOKEN_BUDGET,
  TREND_CONTEXT_BYTE_BUDGET,
  TREND_CONTEXT_DAY_ITEM_LIMIT,
  contextTrendFrom,
  currentHistoricalUserSources,
  currentTrendFrom,
  dateKeyInTimezone,
  dateKeyOffset,
  eligibleReadySummary,
  fitTrendAiReferences,
  historicalCoverageAfterSave,
  historicalSupplementContextFrom,
  historicalSupplementInputFrom,
  historicalTaskRange,
  inclusiveDateCount,
  inputForDate,
  list,
  localDateRange,
  narrativeRows,
  objectValue,
  permittedHistoricalTextDates,
  separateTrendContext,
  sourceLocalDate,
  sourceLocalDates,
  sourceRefFor,
  textForCitation,
  validLocalDate,
  validTimezone
};
