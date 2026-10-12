import { DEFAULT_RECORD_TIMEZONE } from "../../shared/time/index.mjs";

export const RECORD_COMPRESSION_INPUT_SCHEMA_VERSION = "record-compression-input.v1";
export const RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION = "record-compression-output.v1";
export const RECORD_COMPRESSION_PROMPT_VERSION = "daily-record-compression.v1";
export const RECORD_COMPRESSION_TASK_KIND = "recordCompression";
export { DEFAULT_RECORD_TIMEZONE };
export const RECORD_COMPRESSION_WINDOW_DAYS = 7;
export const RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET = 900;
export const RECORD_COMPRESSION_INPUT_TEXT_BUDGET = 12_000;
export const RECORD_COMPRESSION_INPUT_JSON_BUDGET_BYTES = 256_000;
export const RECORD_COMPRESSION_MAX_SOURCE_ITEMS = 96;
export const RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN = 4;
export const RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT = 8;
export const RECORD_COMPRESSION_TREND_CONTEXT_TOKEN_BUDGET = 4_900;
export const RECORD_COMPRESSION_TREND_CONTEXT_CHARACTER_BUDGET = 4_200;
export const RECORD_COMPRESSION_OUTPUT_BUDGETS = Object.freeze({
  totalTokens: RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET,
  userTrendTokens: 700,
  dailyTokens: 245,
  thoughtsIdeasTokens: 315,
  otherTokens: 105,
  aiReferenceTokens: 35,
  metadataTokens: 200,
  stableCandidateItems: 3,
  stableCandidateTokens: 120
});

export function isRecordCompressionRecordEnvelope(value, { ready = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (value.schemaVersion !== RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION
    || value.promptVersion !== RECORD_COMPRESSION_PROMPT_VERSION) return false;
  if (typeof value.sourceManifestHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceManifestHash)) return false;
  if (typeof value.localDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.localDate)) return false;
  if (typeof value.timezone !== "string" || !value.timezone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  } catch {
    return false;
  }
  if (!value.window || typeof value.window !== "object" || Array.isArray(value.window)) return false;
  if (value.window.localDate !== value.localDate || value.window.timezone !== value.timezone) return false;
  const windowStart = Date.parse(value.window.start || "");
  const windowEnd = Date.parse(value.window.endExclusive || "");
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowStart >= windowEnd) return false;
  if (!Array.isArray(value.sourceManifest)) return false;
  if (ready || value.status === "ready") {
    if (value.status !== "ready"
      || !Number.isFinite(Date.parse(value.generatedAt || ""))
      || !value.daily || typeof value.daily !== "object"
      || !value.thoughtsIdeas || typeof value.thoughtsIdeas !== "object"
      || !value.other || typeof value.other !== "object"
      || !Array.isArray(value.metrics)
      || !Array.isArray(value.sourceRefs)
      || !["complete", "partial"].includes(value.window.completeness)
      || value.tokenUsage?.estimated !== true
      || !Number.isSafeInteger(value.revision)
      || value.revision < 1) return false;
    const outputTokens = Number(value.tokenUsage?.outputTokens);
    if (!Number.isSafeInteger(outputTokens)
      || outputTokens < 0
      || outputTokens > RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET) return false;
  }
  return true;
}
