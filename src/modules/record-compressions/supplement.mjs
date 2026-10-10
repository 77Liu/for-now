import { strictDateKey } from "../../shared/time/index.mjs";
import { RECORD_COMPRESSION_OUTPUT_BUDGETS } from "./contract.mjs";
import { estimateRecordCompressionTokens } from "./output.mjs";

export const HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION = "historical-user-supplement.v1";
export const HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION = "historical-user-supplement.v1";
export const HISTORICAL_USER_SUPPLEMENT_INPUT_SCHEMA_VERSION = "historical-user-supplement-input.v1";
export const HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION = "historical-user-supplement-output.v1";
export const HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION = 1;
export const HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS = 3;
export const HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET = RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens;
export const HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET = 12_000;
export const HISTORICAL_USER_SUPPLEMENT_DEFAULT_WINDOW_DAYS = 7;

const STATEMENT_MAX_CHARS = 240;
const EXACT_QUOTE_MAX_CHARS = 180;
const SOURCE_ID_MAX_CHARS = 240;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const hasExactKeys = (value, keys) => objectValue(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const fail = (message, code = "HISTORICAL_USER_SUPPLEMENT_OUTPUT_INVALID") => {
  throw Object.assign(new Error(message), { code });
};
const textValue = (value, maxChars) => typeof value === "string"
  && value.trim() === value
  && value.length > 0
  && value.length <= maxChars;
const localDateValue = value => typeof value === "string" && strictDateKey(value) === value;
const permissionRevisionValue = value => Number.isSafeInteger(value) && value >= 0;

export function estimateHistoricalUserSupplementTokens(value) {
  return estimateRecordCompressionTokens(value);
}

export function estimateHistoricalUserSupplementOutputTokens(records) {
  if (!Array.isArray(records)) return Number.POSITIVE_INFINITY;
  return estimateHistoricalUserSupplementTokens({
    schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
    candidates: records.map(record => ({
      statement: record?.statement,
      exactQuote: record?.exactQuote,
      sourceId: record?.source?.sourceId ?? record?.sourceId
    }))
  });
}

function validateCoverage(value) {
  return hasExactKeys(value, ["windowDays", "availableSources", "includedSources", "complete"])
    && Number.isSafeInteger(value.windowDays) && value.windowDays > 0 && value.windowDays <= 365
    && Number.isSafeInteger(value.availableSources) && value.availableSources >= 0
    && Number.isSafeInteger(value.includedSources) && value.includedSources >= 0
    && value.includedSources <= value.availableSources
    && typeof value.complete === "boolean"
    && (!value.complete || value.includedSources === value.availableSources);
}

function normalizeInputSource(item) {
  if (!objectValue(item) || item.origin !== "user_original") return null;
  const sourceId = item.sourceId;
  const localDate = item.localDate ?? item.occurredOn;
  if (!textValue(sourceId, SOURCE_ID_MAX_CHARS)
    || !localDateValue(localDate)
    || typeof item.sourceHash !== "string"
    || !SOURCE_HASH.test(item.sourceHash)
    || !permissionRevisionValue(item.permissionRevision)
    || typeof item.text !== "string"
    || !item.text.trim()) return null;
  return {
    sourceId,
    localDate,
    sourceHash: item.sourceHash,
    permissionRevision: item.permissionRevision,
    text: item.text
  };
}

function modelInput(userSources) {
  return {
    schemaVersion: HISTORICAL_USER_SUPPLEMENT_INPUT_SCHEMA_VERSION,
    userSources: userSources.map(source => ({
      sourceId: source.sourceId,
      localDate: source.localDate,
      text: source.text
    }))
  };
}

function sourceMetadata(userSources) {
  return userSources.map(source => ({
    sourceId: source.sourceId,
    localDate: source.localDate,
    sourceHash: source.sourceHash,
    permissionRevision: source.permissionRevision
  }));
}

/**
 * Build the only model-visible input for historical stable-expression extraction.
 * The caller supplies user sources that have already passed app-level permission
 * filtering; this function independently checks their user origin and provenance.
 */
export function buildHistoricalUserSupplementInput(options = {}) {
  const { userSources, windowDays = HISTORICAL_USER_SUPPLEMENT_DEFAULT_WINDOW_DAYS } = options;
  if (!Array.isArray(userSources)
    || Object.keys(options).some(key => !["userSources", "windowDays"].includes(key))
    || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) {
    fail("历史稳定表达输入无效", "HISTORICAL_USER_SUPPLEMENT_INPUT_INVALID");
  }
  const sources = userSources.map(normalizeInputSource);
  if (sources.some(source => !source)) {
    fail("历史稳定表达只接受带完整权限证据的 user_original 来源", "HISTORICAL_USER_SUPPLEMENT_INPUT_INVALID");
  }
  const sourceIds = sources.map(source => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    fail("历史稳定表达输入包含重复来源", "HISTORICAL_USER_SUPPLEMENT_INPUT_INVALID");
  }

  const byDate = new Map();
  for (const source of sources) {
    const rows = byDate.get(source.localDate) || [];
    rows.push(source);
    byDate.set(source.localDate, rows);
  }
  const dateBuckets = [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([, rows]) => rows.sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
  const included = [];
  const remaining = dateBuckets.map(rows => [...rows]);
  while (remaining.some(rows => rows.length)) {
    let addedThisRound = false;
    for (const rows of remaining) {
      while (rows.length) {
        const candidate = rows.shift();
        const trial = modelInput([...included, candidate]);
        if (estimateHistoricalUserSupplementTokens(trial) > HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET) {
          continue;
        }
        included.push(candidate);
        addedThisRound = true;
        break;
      }
    }
    if (!addedThisRound) break;
  }

  const coverage = {
    windowDays,
    availableSources: sources.length,
    includedSources: included.length,
    complete: included.length === sources.length
  };
  const input = modelInput(included);
  return {
    input,
    sourceManifest: sourceMetadata(included),
    coverage
  };
}

function validateBuildResult(value) {
  if (!hasExactKeys(value, ["input", "sourceManifest", "coverage"])
    || !validateCoverage(value.coverage)
    || !hasExactKeys(value.input, ["schemaVersion", "userSources"])
    || value.input.schemaVersion !== HISTORICAL_USER_SUPPLEMENT_INPUT_SCHEMA_VERSION
    || !Array.isArray(value.input.userSources)
    || !Array.isArray(value.sourceManifest)
    || value.input.userSources.length !== value.sourceManifest.length
    || value.input.userSources.length !== value.coverage.includedSources
    || estimateHistoricalUserSupplementTokens(value.input) > HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET) return false;

  const seen = new Set();
  return value.input.userSources.every((source, index) => {
    const manifest = value.sourceManifest[index];
    if (!hasExactKeys(source, ["sourceId", "localDate", "text"])
      || !textValue(source.sourceId, SOURCE_ID_MAX_CHARS)
      || !localDateValue(source.localDate)
      || typeof source.text !== "string" || !source.text.trim()
      || !hasExactKeys(manifest, ["sourceId", "localDate", "sourceHash", "permissionRevision"])
      || manifest.sourceId !== source.sourceId
      || manifest.localDate !== source.localDate
      || !SOURCE_HASH.test(manifest.sourceHash || "")
      || !permissionRevisionValue(manifest.permissionRevision)
      || seen.has(source.sourceId)) return false;
    seen.add(source.sourceId);
    return true;
  });
}

function sourceQuoteMatches(source, exactQuote) {
  return typeof source?.text === "string" && source.text.includes(exactQuote);
}

function normalizedRecord(item) {
  if (!hasExactKeys(item, ["recordVersion", "statement", "exactQuote", "source"])
    || item.recordVersion !== HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION
    || !textValue(item.statement, STATEMENT_MAX_CHARS)
    || !textValue(item.exactQuote, EXACT_QUOTE_MAX_CHARS)
    || !hasExactKeys(item.source, ["localDate", "sourceId", "sourceHash", "permissionRevision"])
    || !localDateValue(item.source.localDate)
    || !textValue(item.source.sourceId, SOURCE_ID_MAX_CHARS)
    || typeof item.source.sourceHash !== "string"
    || !SOURCE_HASH.test(item.source.sourceHash)
    || !permissionRevisionValue(item.source.permissionRevision)) return null;
  return {
    recordVersion: HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
    statement: item.statement,
    exactQuote: item.exactQuote,
    source: {
      localDate: item.source.localDate,
      sourceId: item.source.sourceId,
      sourceHash: item.source.sourceHash,
      permissionRevision: item.source.permissionRevision
    }
  };
}

function exactQuoteSource(input, sourceId, exactQuote) {
  const matches = input.input.userSources.filter(source => sourceQuoteMatches(source, exactQuote));
  if (matches.length !== 1 || matches[0].sourceId !== sourceId) return null;
  return input.sourceManifest.find(source => source.sourceId === sourceId) || null;
}

function outputInvalid(message) {
  fail(message, "HISTORICAL_USER_SUPPLEMENT_OUTPUT_INVALID");
}

/** Validate a model result and attach the exact current-source provenance locally. */
export function parseHistoricalUserSupplementOutput(value, { input, generatedAt: _generatedAt } = {}) {
  if (!validateBuildResult(input)) {
    fail("历史稳定表达输入快照无效", "HISTORICAL_USER_SUPPLEMENT_INPUT_INVALID");
  }
  let output = value;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      outputInvalid("历史稳定表达结果不是有效 JSON");
    }
  }
  if (!hasExactKeys(output, ["schemaVersion", "candidates"])
    || output.schemaVersion !== HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION
    || !Array.isArray(output.candidates)
    || output.candidates.length > HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS) {
    outputInvalid("历史稳定表达结果版本或条目数量无效");
  }

  const seen = new Set();
  const records = output.candidates.map(candidate => {
    if (!hasExactKeys(candidate, ["statement", "exactQuote", "sourceId"])
      || !textValue(candidate.statement, STATEMENT_MAX_CHARS)
      || !textValue(candidate.exactQuote, EXACT_QUOTE_MAX_CHARS)
      || !textValue(candidate.sourceId, SOURCE_ID_MAX_CHARS)) {
      outputInvalid("历史稳定表达候选字段无效");
    }
    const identity = JSON.stringify([candidate.sourceId, candidate.exactQuote]);
    if (seen.has(identity)) outputInvalid("历史稳定表达包含重复候选");
    seen.add(identity);
    const source = exactQuoteSource(input, candidate.sourceId, candidate.exactQuote);
    if (!source) outputInvalid("历史稳定表达原文必须唯一命中一个当前 user source");
    return {
      recordVersion: HISTORICAL_USER_SUPPLEMENT_RECORD_VERSION,
      statement: candidate.statement,
      exactQuote: candidate.exactQuote,
      source: {
        localDate: source.localDate,
        sourceId: source.sourceId,
        sourceHash: source.sourceHash,
        permissionRevision: source.permissionRevision
      }
    };
  });
  const tokens = estimateHistoricalUserSupplementTokens(output);
  if (tokens > HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET) {
    outputInvalid(`历史稳定表达候选超过${HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET}-token预算`);
  }
  return {
    schemaVersion: HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
    records,
    coverage: structuredClone(input.coverage),
    tokenUsage: { estimated: true, scope: "model_output", tokens }
  };
}

function validStoredSupplement(value) {
  if (!hasExactKeys(value, ["schemaVersion", "records", "coverage", "tokenUsage"])
    || value.schemaVersion !== HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION
    || !Array.isArray(value.records)
    || value.records.length > HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS
    || !validateCoverage(value.coverage)
    || !hasExactKeys(value.tokenUsage, ["estimated", "scope", "tokens"])
    || value.tokenUsage.estimated !== true
    || value.tokenUsage.scope !== "model_output"
    || !Number.isSafeInteger(value.tokenUsage.tokens) || value.tokenUsage.tokens < 0) return false;
  const records = value.records.map(normalizedRecord);
  if (records.some(record => !record)) return false;
  const identities = records.map(record => JSON.stringify([record.source.sourceId, record.exactQuote]));
  if (new Set(identities).size !== identities.length) return false;
  return value.tokenUsage.tokens === estimateHistoricalUserSupplementOutputTokens(records)
    && value.tokenUsage.tokens <= HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET;
}

/**
 * Revalidate persisted records against the currently permitted user sources.
 * Invalidated results contain only source ids and reasons, never source text.
 */
export function validateHistoricalUserSupplement(value, { userSources } = {}) {
  const empty = { records: [], invalidated: [] };
  if (!validStoredSupplement(value)) {
    const sourceIds = list(value?.records).map(item => textValue(item?.source?.sourceId, SOURCE_ID_MAX_CHARS)
      ? item.source.sourceId : "");
    return {
      records: [],
      invalidated: sourceIds.map(sourceId => ({ sourceId, reason: "invalid_supplement" }))
    };
  }
  if (userSources === undefined) return { records: structuredClone(value.records), invalidated: [] };
  if (!Array.isArray(userSources)) return { records: [], invalidated: value.records.map(item => ({
    sourceId: item.source.sourceId,
    reason: "current_sources_invalid"
  })) };

  const normalizedSources = userSources.map(item => normalizeInputSource(item));
  const sourceMap = new Map(normalizedSources.filter(Boolean).map(source => [source.sourceId, source]));
  const invalidated = [];
  const records = [];
  for (const record of value.records) {
    const reference = record.source;
    const current = sourceMap.get(reference.sourceId);
    const quoteMatches = userSources.filter(source => sourceQuoteMatches(source, record.exactQuote));
    const currentHash = current?.sourceHash;
    const currentPermissionRevision = current?.permissionRevision;
    if (!current || current.localDate !== reference.localDate
      || currentHash !== reference.sourceHash
      || currentPermissionRevision !== reference.permissionRevision
      || quoteMatches.length !== 1
      || quoteMatches[0]?.sourceId !== reference.sourceId) {
      invalidated.push({ sourceId: reference.sourceId, reason: "source_changed_or_unavailable" });
      continue;
    }
    records.push(structuredClone(record));
  }
  return { records, invalidated };
}

export function emptyHistoricalUserSupplement() {
  const records = [];
  return {
    schemaVersion: HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
    records,
    coverage: {
      windowDays: HISTORICAL_USER_SUPPLEMENT_DEFAULT_WINDOW_DAYS,
      availableSources: 0,
      includedSources: 0,
      complete: true
    },
    tokenUsage: {
      estimated: true,
      scope: "model_output",
      tokens: estimateHistoricalUserSupplementOutputTokens(records)
    }
  };
}

/** Normalize only the versioned store contract; malformed persisted data is rejected. */
export function normalizeHistoricalUserSupplement(value) {
  if (value == null) return emptyHistoricalUserSupplement();
  if (!validStoredSupplement(value)) {
    fail("持久化的历史稳定表达格式无效", "HISTORICAL_USER_SUPPLEMENT_STORAGE_INVALID");
  }
  return {
    schemaVersion: HISTORICAL_USER_SUPPLEMENT_SCHEMA_VERSION,
    records: value.records.map(normalizedRecord),
    coverage: structuredClone(value.coverage),
    tokenUsage: structuredClone(value.tokenUsage)
  };
}
