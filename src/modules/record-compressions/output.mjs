import { estimateInternalTokens as estimateRecordCompressionTokens } from "../../../.build/typescript/backend/shared/ai-context/index.mjs";
/**
 * 校验日压缩派生摘要、来源引用与模型摘要预算，完整保留程序统计。
 * 建立时间：2026-10-10
 * 状态：active
 * 边界：摘要预算不包含程序统计；实际回答上下文由消费者另行限制。
 */
import { safeText } from "../../shared/validation/index.mjs";
import {
  RECORD_COMPRESSION_OUTPUT_BUDGETS,
  RECORD_COMPRESSION_INPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_PROMPT_VERSION
} from "./contract.mjs";

export const RECORD_COMPRESSION_OUTPUT_SCHEMA = RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION;
export { RECORD_COMPRESSION_PROMPT_VERSION, RECORD_COMPRESSION_OUTPUT_BUDGETS };

const objectValue = value => value !== null
  && typeof value === "object"
  && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const uniqueIds = values => [...new Set(list(values)
  .filter(value => typeof value === "string" && value.trim())
  .map(value => value.trim()))];
const sourceMap = values => new Map(list(values)
  .filter(item => objectValue(item) && typeof item.sourceId === "string")
  .map(item => [item.sourceId, item]));
const warningText = value => safeText(value, 120_000);
const jsonClone = value => structuredClone(value);

export { estimateRecordCompressionTokens };

const nonContentKeys = new Set([
  "sourceId", "sourceIds", "derivedFrom", "origin", "nature", "scope",
  "status", "schemaVersion", "promptVersion"
]);

function estimateTextBudgetTokens(value) {
  if (typeof value === "string") return estimateRecordCompressionTokens(value);
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTextBudgetTokens(item), 0);
  }
  if (!objectValue(value)) return 0;
  return Object.entries(value).reduce((sum, [key, item]) => (
    sum + (nonContentKeys.has(key) ? 0 : estimateTextBudgetTokens(item))
  ), 0);
}

function sourceIdsFor(items, allowedSources, { quotedExternal = false } = {}) {
  return uniqueIds(items).filter(sourceId => {
    const source = allowedSources.get(sourceId);
    return source && (quotedExternal
      ? source.origin === "quoted_external"
      : source.origin !== "quoted_external");
  });
}

function normalizeRows(values, allowedSources, { quotedExternal = false } = {}) {
  return list(values).flatMap(item => {
    if (!objectValue(item)) return [];
    const text = safeText(item.text ?? item.statement, 120_000);
    const sourceIds = sourceIdsFor(item.sourceIds, allowedSources, { quotedExternal });
    if (!text || !sourceIds.length) return [];
    return [{
      text,
      ...(typeof item.nature === "string" ? { nature: safeText(item.nature, 40) } : {}),
      sourceIds
    }];
  });
}

function normalizeStableCandidates(values, userSources) {
  const candidates = [];
  for (const item of list(values).slice(0, RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateItems)) {
    if (!objectValue(item)) continue;
    const statement = safeText(item.statement, 240);
    const exactQuote = safeText(item.exactQuote, 180);
    const sourceIds = sourceIdsFor(item.sourceIds, userSources);
    const exactSource = sourceIds.find(sourceId => (
      safeText(userSources.get(sourceId)?.text, 120_000).includes(exactQuote)
    ));
    if (!statement || !exactQuote || !exactSource) continue;
    candidates.push({
      statement,
      nature: "user_subjective",
      sourceIds: [exactSource],
      exactQuote,
      scope: "historical_supplement"
    });
  }
  return candidates;
}

function normalizeAiReferences(values, aiSources) {
  return list(values).flatMap(item => {
    if (!objectValue(item)) return [];
    const text = safeText(item.text, 120_000);
    const sourceIds = sourceIdsFor(item.sourceIds, aiSources);
    if (!text || !sourceIds.length) return [];
    const derivedFrom = uniqueIds(item.derivedFrom).filter(sourceId => (
      sourceIds.some(aiSourceId => list(aiSources.get(aiSourceId)?.derivedFrom).includes(sourceId))
    ));
    const origins = [...new Set(sourceIds.map(sourceId => (
      safeText(aiSources.get(sourceId)?.origin, 80) || "ai_generated"
    )))];
    return [{
      text,
      origin: origins.length === 1 ? origins[0] : "mixed",
      sourceIds,
      derivedFrom
    }];
  });
}

function normalizeConflictRows(values, userSources) {
  return list(values).flatMap(item => {
    if (!objectValue(item)) return [];
    const text = safeText(item.text ?? item.description, 120_000);
    const sourceIds = sourceIdsFor(item.sourceIds, userSources);
    return text && sourceIds.length ? [{ text, sourceIds }] : [];
  });
}

function pathValue(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function setPath(value, path, nextValue) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], value);
  parent[path.at(-1)] = nextValue;
}

function textKeyFor(value) {
  if (objectValue(value)) {
    if (typeof value.text === "string") return "text";
    if (typeof value.statement === "string") return "statement";
  }
  return "";
}

function longestFittingPrefix(result, path, item, budget, measure) {
  const key = textKeyFor(item);
  const stringItem = typeof item === "string";
  if (!key && !stringItem) return null;
  const sourceText = stringItem ? item : item[key];
  const characters = Array.from(sourceText);
  let low = 0;
  let high = characters.length;
  let best = null;

  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const clippedText = length < characters.length
      ? characters.slice(0, length).join("") + "…"
      : sourceText;
    const clippedItem = stringItem
      ? clippedText
      : { ...item, [key]: clippedText };
    const candidate = jsonClone(result);
    pathValue(candidate, path).push(clippedItem);
    if (measure(candidate) <= budget && clippedText && length > 0) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function fitRowsToBudget(source, budget, paths, {
  truncatablePaths = [],
  absolute = false,
  measureTextOnly = true
} = {}) {
  const result = jsonClone(source);
  const inputRows = paths.map(path => [path, list(pathValue(source, path))]);
  for (const [path] of inputRows) setPath(result, path, []);

  const estimate = measureTextOnly
    ? estimateTextBudgetTokens
    : estimateRecordCompressionTokens;
  const baseline = estimate(result);
  const measure = value => absolute
    ? estimate(value)
    : Math.max(0, estimate(value) - baseline);
  let truncated = false;
  const allowed = Math.max(0, Math.floor(Number(budget) || 0));

  for (const [path, rows] of inputRows) {
    for (const row of rows) {
      const candidate = jsonClone(result);
      pathValue(candidate, path).push(row);
      if (measure(candidate) <= allowed) {
        Object.assign(result, candidate);
        continue;
      }

      truncated = true;
      const canClip = truncatablePaths.some(item => (
        item.length === path.length && item.every((part, index) => part === path[index])
      ));
      const clipped = canClip
        ? longestFittingPrefix(result, path, row, allowed, measure)
        : null;
      if (clipped) {
        Object.assign(result, clipped);
        return {
          value: result,
          usedTokens: measure(result),
          truncated
        };
      }
    }
  }

  if (inputRows.some(([path, rows]) => rows.length !== pathValue(result, path).length)) {
    truncated = true;
  }
  return {
    value: result,
    usedTokens: measure(result),
    truncated
  };
}

// WARN 仅观察，不裁掉合法摘要；硬限失败不覆盖已有记录。
function buildBudgetedContent({
  schemaVersion, window, coverage, metrics, daily, thoughtsIdeas, other,
  aiReferences, conflicts, warnings
}) {
  const payload = { schemaVersion, daily, thoughtsIdeas, other,
    aiReference: aiReferences, conflicts, warnings };
  const outputTokens = estimateRecordCompressionTokens(payload);
  if (outputTokens > RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens) {
    throw Object.assign(new Error("日压缩摘要超过内部二级token预算"), {
      code: "RECORD_COMPRESSION_OUTPUT_BUDGET_EXCEEDED"
    });
  }
  return {
    ...payload, coverage, metrics,
    tokenUsage: {
      estimated: true,
      method: "conservative-ascii-runs-unicode-v1",
      scope: "model_summary",
      outputTokens,
      budgetLevel: outputTokens > RECORD_COMPRESSION_OUTPUT_BUDGETS.warnTokens ? "warn" : "ok",
      warnTokens: RECORD_COMPRESSION_OUTPUT_BUDGETS.warnTokens,
      hardTokens: RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens,
      serverStatisticsTokens: estimateRecordCompressionTokens({ window, coverage, metrics }),
      moduleTokens: {
        daily: estimateTextBudgetTokens(daily), thoughtsIdeas: estimateTextBudgetTokens(thoughtsIdeas),
        other: estimateTextBudgetTokens(other), aiReference: estimateTextBudgetTokens(aiReferences),
        metadata: estimateTextBudgetTokens({ conflicts, warnings })
      },
      stableCandidatesTokens: 0
    },
    truncated: false
  };
}

function validInput(input) {
  return objectValue(input)
    && input.schemaVersion === RECORD_COMPRESSION_INPUT_SCHEMA_VERSION
    && input.promptVersion === RECORD_COMPRESSION_PROMPT_VERSION
    && objectValue(input.window)
    && typeof input.window.localDate === "string"
    && typeof input.window.timezone === "string"
    && typeof input.sourceManifestHash === "string"
    && /^[a-f0-9]{64}$/.test(input.sourceManifestHash);
}

/**
 * 将模型 JSON 转为可保存的来源绑定摘要；程序统计来自输入，不能被模型覆盖。
 * outputTokens 仅计 model_summary 投影，稳定候选单独计量；不表示存储或回答上下文大小。
 * 输入/JSON/版本无效时抛出对应校验错误；初级超限仅标记 WARN，二级超限拒绝保存；稳定候选仍有独立预算。
 */
export function parseRecordCompressionOutput(value, {
  input,
  id,
  revision = 1,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!validInput(input)) {
    throw Object.assign(new Error("日压缩输入无效或promptVersion不受支持"), {
      code: "RECORD_COMPRESSION_INPUT_INVALID"
    });
  }
  let output = value;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      throw Object.assign(new Error("日压缩结果不是有效 JSON"), { code: "RECORD_COMPRESSION_OUTPUT_INVALID" });
    }
  }
  if (!objectValue(output) || output.schemaVersion !== RECORD_COMPRESSION_OUTPUT_SCHEMA) {
    throw Object.assign(new Error("日压缩结果版本无效"), { code: "RECORD_COMPRESSION_OUTPUT_INVALID" });
  }

  const rawModelPayload = {
    schemaVersion: output.schemaVersion, daily: output.daily, thoughtsIdeas: output.thoughtsIdeas,
    other: output.other, aiReference: output.aiReference, conflicts: output.conflicts, warnings: output.warnings
  };
  if (estimateRecordCompressionTokens(rawModelPayload) > RECORD_COMPRESSION_OUTPUT_BUDGETS.totalTokens) {
    throw Object.assign(new Error("日压缩模型摘要超过内部二级token预算"), {
      code: "RECORD_COMPRESSION_OUTPUT_BUDGET_EXCEEDED"
    });
  }

  const userSources = sourceMap(input.userSources);
  const aiSources = sourceMap(input.aiReferences);
  const validMetricKeys = new Set(list(input.metrics)
    .filter(objectValue)
    .map(item => item.metric)
    .filter(value => typeof value === "string"));
  const daily = objectValue(output.daily) ? output.daily : {};
  const ideas = objectValue(output.thoughtsIdeas) ? output.thoughtsIdeas : {};
  const other = objectValue(output.other) ? output.other : {};
  const normalizedDaily = {
    observations: normalizeRows(daily.observations, userSources),
    metricKeys: uniqueIds(daily.metricKeys).filter(key => validMetricKeys.has(key)),
    missing: list(daily.missing).map(warningText).filter(Boolean)
  };
  const normalizedThoughtsIdeas = {
    focus: normalizeRows(ideas.focus, userSources),
    changes: normalizeRows(ideas.changes, userSources),
    openQuestions: normalizeRows(ideas.openQuestions, userSources)
  };
  const normalizedOther = {
    themes: normalizeRows(other.themes, userSources),
    collectedQuotes: normalizeRows(other.collectedQuotes, userSources, { quotedExternal: true })
  };
  const normalizedAiReferences = normalizeAiReferences(output.aiReference, aiSources);
  const normalizedStableCandidates = normalizeStableCandidates(
    output.stableUserCandidates,
    userSources
  );
  let stableCandidateTruncated = false;
  const normalizedConflicts = normalizeConflictRows(output.conflicts, userSources);
  const allWarnings = [
    ...list(input.warnings).map(warningText),
    ...list(output.warnings).map(warningText)
  ].filter(Boolean);

  const schemaWindow = {
    start: safeText(input.window.start, 40),
    endExclusive: safeText(input.window.endExclusive, 40),
    localDate: input.window.localDate,
    asOf: safeText(input.window.asOf, 40),
    timezone: input.window.timezone,
    completeness: input.window.completeness === "complete" ? "complete" : "partial"
  };
  const budgetInputs = {
    schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA,
    window: schemaWindow,
    coverage: structuredClone(input.coverage || { total: 0, included: 0, excluded: 0, truncated: false }),
    metrics: structuredClone(list(input.metrics)),
    daily: normalizedDaily,
    thoughtsIdeas: normalizedThoughtsIdeas,
    other: normalizedOther,
    aiReferences: normalizedAiReferences,
    conflicts: normalizedConflicts
  };

  const stableBudget = fitRowsToBudget(
    { items: normalizedStableCandidates },
    RECORD_COMPRESSION_OUTPUT_BUDGETS.stableCandidateTokens,
    [["items"]],
    { truncatablePaths: [["items"]], absolute: true, measureTextOnly: false }
  );
  stableCandidateTruncated = stableBudget.truncated
    || normalizedStableCandidates.length !== list(output.stableUserCandidates).length;
  const stableCandidates = stableBudget.value.items;
  const rejectedStableCount = list(output.stableUserCandidates).length - normalizedStableCandidates.length;

  let bounded = buildBudgetedContent({ ...budgetInputs, warnings: allWarnings });
  const budgetWarnings = [];
  if (bounded.truncated || stableCandidateTruncated) {
    budgetWarnings.push("摘要内容已按服务端保守token预算裁剪");
  }
  if (rejectedStableCount > 0) {
    budgetWarnings.push("部分稳定表达候选缺少可核验的用户原文，已剔除");
  }
  if (stableCandidateTruncated) {
    budgetWarnings.push("部分稳定表达候选超出独立预算，已裁剪或剔除");
  }
  if (budgetWarnings.length) {
    bounded = buildBudgetedContent({
      ...budgetInputs,
      warnings: [...budgetWarnings, ...allWarnings]
    });
  }

  const summary = {
    id: safeText(id, 100),
    status: "ready",
    schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA,
    promptVersion: input.promptVersion,
    timezone: input.window.timezone,
    revision: Math.max(1, Math.round(Number(revision) || 1)),
    generatedAt: new Date(generatedAt).toISOString(),
    sourceManifestHash: input.sourceManifestHash,
    sourceManifest: list(input.sourceManifest).map(source => ({
      sourceId: safeText(source?.sourceId, 200),
      recordId: safeText(source?.recordId, 120),
      version: Math.max(1, Math.round(Number(source?.version) || 1)),
      module: safeText(source?.module, 40),
      subtype: safeText(source?.subtype, 60),
      origin: safeText(source?.origin, 40),
      resourceType: safeText(source?.resourceType, 40),
      rootId: safeText(source?.rootId, 120),
      targetKey: safeText(source?.targetKey, 120),
      occurredAt: safeText(source?.occurredAt, 40),
      occurredOn: safeText(source?.occurredOn, 10),
      updatedAt: safeText(source?.updatedAt, 40),
      sourceHash: safeText(source?.sourceHash, 64),
      permissionRevision: Math.max(0, Math.round(Number(source?.permissionRevision) || 0))
    })).filter(source => source.sourceId && source.recordId && source.sourceHash),
    window: schemaWindow,
    daily: bounded.daily,
    thoughtsIdeas: bounded.thoughtsIdeas,
    other: bounded.other,
    aiReference: bounded.aiReference,
    stableUserCandidates: stableCandidates,
    conflicts: bounded.conflicts,
    coverage: bounded.coverage,
    metrics: bounded.metrics,
    warnings: bounded.warnings,
    tokenUsage: {
      ...bounded.tokenUsage,
      stableCandidatesTokens: estimateRecordCompressionTokens(stableCandidates),
      truncated: bounded.truncated || stableCandidateTruncated
    }
  };

  return summary;
}
