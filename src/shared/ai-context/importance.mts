/**
 * 来源版本绑定的重要性评分缓存与稳定无放回抽样。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：调用方先执行账户、来源许可与当前版本门；评分不是用户事实。
 */
import crypto from "node:crypto";
export const IMPORTANCE_SCORING_VERSION = "importance-score.v1";
const MODEL_REASON_CODES = new Set(["long_term_value", "explicit_attention", "user_feedback",
  "correction", "counterevidence", "baseline", "insufficient_context"]);
export interface ImportanceModelChoice {
  model: string;
  effort: string;
}
export interface ImportanceMaterial {
  accountId: string;
  sourceKey: string;
  version: number;
  contentSha256: string;
  text: string;
  origin?: string;
  informationType?: string;
  favorite?: boolean;
  feedback?: boolean;
  explicitImportance?: number;
  permissionRevision?: number;
}
export interface ImportanceScore {
  accountId: string;
  sourceKey: string;
  sourceVersion: number;
  contentSha256: string;
  scoringVersion: string;
  model: string;
  effort?: string;
  score: number;
  reasons: string[];
  kind: "model" | "correction";
  generatedAt: string;
  permissionRevision?: number;
}

/** 验证持久缓存的绑定和有限分数，禁止把原文混入评分记录。
 * @since unreleased
 */
export function isImportanceScore(value: unknown): value is ImportanceScore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const fields = ["accountId", "sourceKey", "sourceVersion", "contentSha256", "scoringVersion", "model", "score", "reasons", "kind", "generatedAt", "permissionRevision", "effort"];
  return Object.keys(item).every(key => fields.includes(key))
    && ["accountId", "sourceKey", "scoringVersion", "model", "generatedAt"].every(key => typeof item[key] === "string" && Boolean(item[key]))
    && typeof item.contentSha256 === "string" && /^[a-f0-9]{64}$/.test(item.contentSha256)
    && Number.isSafeInteger(item.sourceVersion) && Number(item.sourceVersion) > 0
    && (item.permissionRevision === undefined || (Number.isSafeInteger(item.permissionRevision) && Number(item.permissionRevision) >= 0))
    && (item.effort === undefined || (typeof item.effort === "string" && Boolean(item.effort)))
    && typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= 100
    && ["model", "correction"].includes(String(item.kind))
    && Array.isArray(item.reasons) && item.reasons.length > 0
    && item.reasons.every(reason => typeof reason === "string" && Boolean(reason.trim()) && reason.length <= 240)
    && Number.isFinite(Date.parse(String(item.generatedAt)));
}

/** 校验缓存只匹配当前来源版本；过期、未知或非有限分数不能作为已评分。
 * @since unreleased
 */
export function importanceScoreFor(material: ImportanceMaterial, records: ImportanceScore[], choice?: ImportanceModelChoice): ImportanceScore | null {
  const matches = records.filter(record => record.accountId === material.accountId
    && record.sourceKey === material.sourceKey && record.sourceVersion === material.version
    && record.contentSha256 === material.contentSha256 && record.scoringVersion === IMPORTANCE_SCORING_VERSION
    && (record.kind === "correction" || (record.permissionRevision ?? 0) === (material.permissionRevision ?? 0))
    && (record.kind === "correction" || Boolean(choice && record.model === choice.model
      && typeof record.effort === "string" && record.effort === choice.effort))
    && Number.isFinite(record.score) && record.score >= 0 && record.score <= 100);
  return matches.find(record => record.kind === "correction") || matches.at(-1) || null;
}

/** 可解释规则只作为尚未模型评分或失败后的回退，不冒称 AI 评分。
 * @since unreleased
 */
export function importanceWeight(material: ImportanceMaterial, records: ImportanceScore[], choice?: ImportanceModelChoice): {
  weight: number; score: number; kind: "model" | "correction" | "rule_fallback"; reasons: string[];
} {
  const cached = importanceScoreFor(material, records, choice);
  if (cached) return { weight: Math.max(0.01, cached.score / 100), score: cached.score,
    kind: cached.kind, reasons: [...cached.reasons] };
  const reasons: string[] = [];
  let score = 50;
  if (Number.isFinite(material.explicitImportance) && material.explicitImportance! >= 0
    && material.explicitImportance! <= 100) {
    score = material.explicitImportance!;
    reasons.push("explicit_importance");
  } else {
    if (material.favorite) {
      score += 20;
      reasons.push("favorite");
    }
    if (material.feedback) {
      score += 10;
      reasons.push("user_feedback");
    }
  }
  if (!reasons.length) reasons.push("unscored_equal_weight");
  return { score, weight: Math.max(0.01, score / 100), kind: "rule_fallback", reasons };
}

/** 固定种子的重要性加权无放回排序；同一来源键只出现一次。
 * @since unreleased
 */
export function weightedImportanceOrder<T extends ImportanceMaterial>(materials: T[], records: ImportanceScore[], seed: string, choice?: ImportanceModelChoice): T[] {
  const unique = new Map(materials.map(material => [material.sourceKey, material]));
  return [...unique.values()].map(material => {
    const bytes = crypto.createHash("sha256").update(seed).update("\0").update(material.sourceKey).digest();
    const unit = (bytes.readUIntBE(0, 6) + 1) / (2 ** 48 + 1);
    return { material, rank: -Math.log(unit) / importanceWeight(material, records, choice).weight };
  }).sort((left, right) => left.rank - right.rank
    || left.material.sourceKey.localeCompare(right.material.sourceKey)).map(item => item.material);
}

/** 模型只回请求内 r 别名；未知/重复/越界分数拒绝，合法分数绑定原来源。
 * @since unreleased
 */
export function parseImportanceScores(raw: string, materials: ImportanceMaterial[], choice: ImportanceModelChoice, generatedAt: string): ImportanceScore[] {
  let document: { scores?: unknown } | null;
  try {
    document = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("重要性评分 JSON 无效"), { code: "IMPORTANCE_OUTPUT_INVALID" });
  }
  if (!document || !Array.isArray(document.scores)) throw Object.assign(new Error("重要性评分格式无效"), { code: "IMPORTANCE_OUTPUT_INVALID" });
  const seen = new Set<string>();
  return document.scores.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("重要性评分条目无效"), { code: "IMPORTANCE_OUTPUT_INVALID" });
    }
    const item = value as { reference?: unknown; score?: unknown; reason?: unknown };
    const index = typeof item.reference === "string" && /^r[1-9]\d*$/.test(item.reference)
      ? Number(item.reference.slice(1)) - 1 : -1;
    const material = materials[index];
    if (!material || seen.has(material.sourceKey) || typeof item.score !== "number"
      || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
      || typeof item.reason !== "string" || !item.reason.trim()) {
      throw Object.assign(new Error("重要性评分来源或范围无效"), { code: "IMPORTANCE_OUTPUT_INVALID" });
    }
    seen.add(material.sourceKey);
    return { accountId: material.accountId, sourceKey: material.sourceKey, sourceVersion: material.version,
      contentSha256: material.contentSha256, scoringVersion: IMPORTANCE_SCORING_VERSION, model: choice.model, effort: choice.effort,
      permissionRevision: material.permissionRevision ?? 0,
      score: item.score, reasons: [MODEL_REASON_CODES.has(item.reason.trim())
        ? item.reason.trim() : "model_importance_assessment"], kind: "model", generatedAt };
  });
}
