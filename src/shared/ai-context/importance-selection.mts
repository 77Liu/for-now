/**
 * 重要性补齐的冻结选材计划与相关材料预算分配。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：输入必须先通过来源许可和版本门；计划不保存原文。
 */
import { IMPORTANCE_SCORING_VERSION, importanceWeight, weightedImportanceOrder,
  type ImportanceMaterial, type ImportanceScore } from "./importance.mjs";
import { estimateInternalTokens, readInternalBudgets } from "./internal-budgets.mjs";
export interface SelectionMaterial extends ImportanceMaterial { relevanceScore: number }
export interface ImportanceSelectionPlan {
  scoringVersion: string;
  model: string;
  effort: string;
  seed: string;
  requestedCount?: number;
  limitReason?: "overall_byte_budget";
  sources: { sourceKey: string; version: number; contentSha256: string;
    characters: number; related: boolean; score: number; kind: string }[];
}
/** 相关证据的实际 token 占比上限。 @since unreleased */
export const RELATED_REFERENCE_SHARE_MAX = 0.35;

function excerptCharacters(text: string, tokenBudget: number): number {
  let low = 0;
  let high = Math.min(text.length, readInternalBudgets().sourceCharacterMax);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateInternalTokens(text.slice(0, mid)) <= tokenBudget) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * 先保留相关材料，余位按重要性无放回补齐；相关原文不超过证据预算35%。
 * 同任务应持久保存返回计划，重试只按计划校验版本，不重新抽样。
 * @since unreleased
 */
export function createImportanceSelectionPlan(materials: SelectionMaterial[], scores: ImportanceScore[], {
  seed, model, effort, count = readInternalBudgets().minimumReferences,
  evidenceBudget = readInternalBudgets().evidenceHard
}: { seed: string; model: string; effort: string; count?: number; evidenceBudget?: number }): ImportanceSelectionPlan {
  const unique = [...new Map(materials.filter(item => item.text.trim()).map(item => [item.sourceKey, item])).values()];
  count = Math.min(unique.length, Math.max(0, Math.min(50, Math.floor(count))));
  const matchingScores = scores.filter(item => item.kind === "correction" || (item.model === model && item.effort === effort));
  const related = unique.filter(item => item.relevanceScore >= 6).sort((a, b) => b.relevanceScore - a.relevanceScore
    || a.sourceKey.localeCompare(b.sourceKey)).slice(0, Math.floor(count * RELATED_REFERENCE_SHARE_MAX));
  const relatedKeys = new Set(related.map(item => item.sourceKey));
  const sampled = weightedImportanceOrder(unique.filter(item => !relatedKeys.has(item.sourceKey)), matchingScores, [seed, model, effort, IMPORTANCE_SCORING_VERSION].join("\0"), { model, effort })
    .slice(0, count - related.length);
  const relatedBudget = Math.floor(evidenceBudget * RELATED_REFERENCE_SHARE_MAX);
  const sampledBudget = evidenceBudget - (related.length ? relatedBudget : 0);
  const sampledCharacters = new Map(sampled.map(material => [material.sourceKey,
    excerptCharacters(material.text, Math.floor(sampledBudget / sampled.length))]));
  const actualSampledTokens = sampled.reduce((total, material) => total
    + estimateInternalTokens(material.text.slice(0, sampledCharacters.get(material.sourceKey))), 0);
  const actualRelatedBudget = Math.min(relatedBudget,
    Math.floor(actualSampledTokens * RELATED_REFERENCE_SHARE_MAX / (1 - RELATED_REFERENCE_SHARE_MAX)));
  const sources = [...related, ...sampled].map(material => {
    const isRelated = relatedKeys.has(material.sourceKey);
    const share = isRelated ? actualRelatedBudget / related.length : sampledBudget / sampled.length;
    const weight = importanceWeight(material, matchingScores, { model, effort });
    return { sourceKey: material.sourceKey, version: material.version, contentSha256: material.contentSha256,
      characters: excerptCharacters(material.text, Math.floor(share)), related: isRelated,
      score: weight.score, kind: weight.kind };
  });
  // 极短补齐材料可能不足以为每条相关来源分配一个完整字符。
  // 此时取消相关优先槽位，统一按重要性抽样，保留足够真实来源。
  if (sources.some(item => item.characters < 1) && related.length) {
    return createImportanceSelectionPlan(materials.map(item => ({ ...item, relevanceScore: 0 })), scores,
      { seed, model, effort, count, evidenceBudget });
  }
  return { scoringVersion: IMPORTANCE_SCORING_VERSION, model, effort, seed, sources };
}

/** 冻结计划只消费仍合法且版本/hash一致的原始来源；任何失效使整份计划失效。
 * @since unreleased
 */
export function applyImportanceSelectionPlan<T extends SelectionMaterial>(materials: T[], plan: ImportanceSelectionPlan): T[] | null {
  if (plan.scoringVersion !== IMPORTANCE_SCORING_VERSION || new Set(plan.sources.map(item => item.sourceKey)).size !== plan.sources.length) return null;
  const byKey = new Map(materials.map(item => [item.sourceKey, item]));
  const result: T[] = [];
  for (const item of plan.sources) {
    const material = byKey.get(item.sourceKey);
    if (!material || material.version !== item.version || material.contentSha256 !== item.contentSha256
      || !Number.isSafeInteger(item.characters) || item.characters < 1 || item.characters > material.text.length) return null;
    result.push({ ...material, text: material.text.slice(0, item.characters) });
  }
  return result;
}
