/**
 * 编译请求内短引用及逐字核验目录，不改变业务身份或用户原文。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：映射只属于当前账户/任务回执；解码不能绕过现有来源新鲜度校验。
 */
import crypto from "node:crypto";
import { readInternalBudgets, estimateInternalTokens } from "./internal-budgets.mjs";
/** 当前账户许可过滤后的真实来源；textSpans 是真实连续片段，不得拼接造原文。 */
export interface CitationSource {
  citationId: string;
  text: string;
  textSpans?: string[];
  source?: Record<string, unknown>;
}
interface AliasEntry {
  alias: string;
  original: CitationSource;
  originals: CitationSource[];
  sentText: string[];
}
/** 请求内私密映射；只允许保存 receipt 摘要，不能直接返回该对象给浏览器。 */
export interface ReferenceRequest {
  prompt: string;
  binding: string;
  entries: AliasEntry[];
  sources: CitationSource[];
  receipt: { schemaVersion: number; binding: string; aliasMapSha256: string; promptSha256: string;
    promptBytes: number; promptByteLimit: number; unit: string; providedCount: number; coreModelProvided: boolean; trendTokens: number; evidenceTokens: number;
    trendBudgetLevel: string; evidenceBudgetLevel: string; truncatedSources: number;
    selectionLimit?: { reason: string; requestedCount: number; providedHistoricalCount: number } };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);
const identityKeys = new Set([
  "id", "sourceKey", "resourceId", "rootId", "targetId", "subtargetId",
  "eventId", "evidenceId", "contentSha256", "sourceHash", "fingerprint", "targetKey", "accountId", "accountKey"
]);

/**
 * 从真实上下文 JSON 创建核心在先的引用别名，保留本次实际发送的可引用原文。
 * 不替换用户文本中的 ID 字符串；未进入请求的目录项不计为提供的参考。
 * @since unreleased
 */
export function compileReferenceRequest(prompt: string, sources: CitationSource[], binding: string): ReferenceRequest {
  const matches = [...prompt.matchAll(/(<(?:working_context_data|reference_context_data) format="application\/json">)([\s\S]*?)(<\/(?:working_context_data|reference_context_data)>)/g)];
  if (!matches.length || !binding) throw Object.assign(new Error("引用请求缺少结构化上下文或绑定"), {
    code: "REFERENCE_CONTEXT_INVALID"
  });
  const payloads: unknown[] = matches.map(match => JSON.parse(match[2]!));
  const entries: AliasEntry[] = [];
  const byCitation = new Map<string, AliasEntry>();
  const byIdentity = new Map<string, AliasEntry>();
  const identity = (source: CitationSource) => {
    const metadata = source.source || {};
    const location = object(metadata.location) ? metadata.location : {};
    if (!metadata.resourceType || !metadata.resourceId || !metadata.version) return `legacy:${source.citationId}`;
    // 来源必须先经过当前账户/版本/许可门；同一真实字段的不同摘录与引用前缀共用身份。
    // 各消费链的 contentSha256 算法不同，保留原始hash进映射摘要，不把不同算法当主键。
    const type = String(metadata.resourceType);
    let rootId = location.rootId || "";
    let targetKey = location.targetKey || "";
    if (["capture", "journal", "quote", "keepsake"].includes(type)) {
      rootId ||= metadata.resourceId;
      targetKey ||= "content";
    }
    if (type === "onboardingV2") targetKey ||= `answer:${metadata.resourceId}`;
    if (type === "thought" && String(targetKey).startsWith("question:")) rootId ||= metadata.resourceId;
    const origin = ["user", "user_original", "manual"].includes(String(metadata.origin || "user"))
      ? "user" : ["third_party", "quoted_external"].includes(String(metadata.origin))
        ? "external" : metadata.origin;
    return JSON.stringify([type, metadata.resourceId, rootId, targetKey, metadata.version, origin]);
  };
  // 调用方目录的核心证据在先；附加材料不会改变未变化核心的别名。
  for (const source of sources) {
    if (!source.citationId || !source.text || byCitation.has(source.citationId)) continue;
    const key = identity(source);
    let entry = byIdentity.get(key);
    if (!entry) {
      entry = { alias: `r${entries.length + 1}`, original: structuredClone(source),
        originals: [], sentText: [] };
      entries.push(entry);
      byIdentity.set(key, entry);
    }
    entry.originals.push(structuredClone(source));
    byCitation.set(source.citationId, entry);
  }
  const identityAliases = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!object(value)) return;
    const entry = typeof value.citationId === "string" ? byCitation.get(value.citationId) : undefined;
    if (entry) {
      if (typeof value.sourceId === "string") identityAliases.set(value.sourceId, entry.alias);
    }
    Object.values(value).forEach(collect);
  };
  payloads.forEach(collect);
  const aliasFor = (value: unknown) => typeof value === "string"
    ? byCitation.get(value)?.alias || identityAliases.get(value) : undefined;
  const transform = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(transform);
    if (!object(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (identityKeys.has(key)) continue;
      if (key === "citationId" || key === "sourceId") {
        const alias = key === "sourceId" && typeof value.citationId === "string"
          ? byCitation.get(value.citationId)?.alias : aliasFor(item);
        if (alias) result[key] = alias;
      } else if (key === "sourceIds" || key === "citations") {
        result[key] = Array.isArray(item) ? item.flatMap(part => {
          if (object(part)) return [transform(part)];
          const alias = aliasFor(part);
          return alias ? [alias] : [];
        }) : [];
      } else result[key] = transform(item);
    }
    return result;
  };
  const byAlias = new Map(entries.map(entry => [entry.alias, entry]));
  const collectSent = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectSent);
      return;
    }
    if (!object(value)) return;
    const entry = typeof value.citationId === "string" ? byAlias.get(value.citationId) : undefined;
    if (entry) {
      for (const key of ["text", "exactQuote", "content", "question", "answer", "note", "outcome", "title"]) {
        const text = value[key];
        if (typeof text === "string" && text && entry.originals.some(source => (source.textSpans || [source.text]).some(span => span.includes(text)))
          && !entry.sentText.includes(text)) entry.sentText.push(text);
      }
    }
    Object.values(value).forEach(collectSent);
  };
  const transformed = payloads.map(transform);
  const budgets = readInternalBudgets();
  const groups = transformed.filter(object).map(value => {
    const evidence = Array.isArray(value.referenceEvidence) ? [...value.referenceEvidence] : [];
    if (Array.isArray(value.relevantEpisodes)) {
      value.relevantEpisodes = value.relevantEpisodes.map(row => {
        if (!object(row) || typeof row.citationId !== "string" || typeof row.text !== "string") return row;
        const { text, ...metadata } = row;
        evidence.push({ citationId: row.citationId, text, origin: row.origin, informationType: row.informationType });
        return metadata;
      });
    }
    return { value, evidence, omitted: 0, trendClipped: false };
  });
  // 配额属于整请求，不属于某个 JSON 块。先为所有目录保留结构额度，
  // 再统一分配连续原文；可选目录自身过大时有界省略，不拒绝必需正文。
  const emptyEvidenceTokens = () => groups.reduce((sum, group) => sum + estimateInternalTokens(
    group.evidence.map(row => object(row) ? { ...row, text: "" } : row)
  ), 0);
  while (emptyEvidenceTokens() > budgets.evidenceHard) {
    const group = [...groups].reverse().find(item => item.evidence.length);
    if (!group) break;
    group.evidence.pop();
    group.omitted += 1;
  }
  const rowCount = groups.reduce((sum, group) => sum + group.evidence.length, 0);
  const maximumPrefix = Math.min(budgets.sourceCharacterMax,
    Math.max(0, Math.floor((budgets.evidenceHard - emptyEvidenceTokens()) / Math.max(1, rowCount) / 2)));
  const projectEvidence = (characters: number) => groups.map(group => group.evidence.map(row => {
    if (!object(row) || typeof row.text !== "string") return row;
    return { ...row, text: Array.from(row.text).slice(0, characters).join("") };
  }));
  let low = 0;
  let high = maximumPrefix;
  let fittedEvidence = projectEvidence(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = projectEvidence(middle);
    if (candidate.reduce((sum, rows) => sum + estimateInternalTokens(rows), 0) <= budgets.evidenceHard) {
      fittedEvidence = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  groups.forEach((group, index) => {
    const rows = fittedEvidence[index]!;
    const clipped = group.omitted + rows.filter((row, rowIndex) => object(row) && (
      row.excerptTruncated === true || row.text !== (group.evidence[rowIndex] as Record<string, unknown>)?.text
    )).length;
    group.value.referenceEvidence = rows;
    group.value.referenceEvidenceBudget = { estimatedTokens: estimateInternalTokens(rows),
      budgetLevel: clipped ? "warn" : "ok", warnTokens: budgets.evidenceWarn,
      hardTokens: budgets.evidenceHard, truncatedSources: clipped, omittedSources: group.omitted };
  });
  const trendTotal = () => groups.reduce((sum, group) => sum + (
    object(group.value.sevenDayTrend) ? estimateInternalTokens(group.value.sevenDayTrend) : 0
  ), 0);
  // 多个趋势块共用二级配额；只裁可选投影，保留 core/current 和持久统计。
  while (trendTotal() > budgets.trendHard) {
    const group = [...groups].reverse().find(item => object(item.value.sevenDayTrend));
    if (!group) break;
    const trend = group.value.sevenDayTrend as Record<string, unknown>;
    group.trendClipped = true;
    trend.contextTruncated = true;
    let removed = false;
    for (const key of ["aiReferences", "metrics", "collectedQuotes", "userSubjective", "userFacts", "days"]) {
      if (Array.isArray(trend[key]) && trend[key].length) {
        (trend[key] as unknown[]).pop();
        removed = true;
        break;
      }
    }
    if (removed) {
      const references = new Set<string>();
      const collectReferences = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collectReferences);
          return;
        }
        if (!object(value)) return;
        for (const key of ["sourceIds", "citations"]) {
          if (Array.isArray(value[key])) for (const reference of value[key] as unknown[]) {
            if (typeof reference === "string") references.add(reference);
          }
        }
        Object.entries(value).filter(([key]) => key !== "sources").forEach(([, child]) => collectReferences(child));
      };
      collectReferences(trend);
      if (Array.isArray(trend.sources)) trend.sources = trend.sources.filter(source => object(source)
        && (references.has(String(source.sourceId)) || references.has(String(source.citationId))));
      if (object(trend.metricsCoverage)) {
        trend.metricsCoverage.included = Array.isArray(trend.metrics) ? trend.metrics.length : 0;
        trend.metricsCoverage.truncated = true;
      }
    } else {
      delete group.value.sevenDayTrend;
      group.value.trendOmitted = true;
    }
  }
  const totalEvidenceTokens = fittedEvidence.reduce((sum, rows) => sum + estimateInternalTokens(rows), 0);
  if (totalEvidenceTokens > budgets.evidenceHard || trendTotal() > budgets.trendHard) {
    throw Object.assign(new Error("整请求可选上下文超过二级预算"), { code: "WORKING_CONTEXT_BUDGET_EXCEEDED" });
  }
  for (const group of groups) {
    const layer = group.value.referenceEvidenceBudget as Record<string, unknown>;
    if (totalEvidenceTokens > budgets.evidenceWarn) layer.budgetLevel = "warn";
    if (object(group.value.sevenDayTrend) || group.trendClipped) {
      group.value.trendBudget = { estimatedTokens: object(group.value.sevenDayTrend)
        ? estimateInternalTokens(group.value.sevenDayTrend) : 0,
        budgetLevel: trendTotal() > budgets.trendWarn || group.trendClipped ? "warn" : "ok",
        warnTokens: budgets.trendWarn, hardTokens: budgets.trendHard, truncated: group.trendClipped };
    }
  }
  transformed.forEach(collectSent);
  let compiledPrompt = prompt;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const compiled = JSON.stringify(transformed[index]).replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
    compiledPrompt = compiledPrompt.slice(0, match.index!) + match[1] + compiled + match[3]
      + compiledPrompt.slice(match.index! + match[0].length);
  }
  if (Buffer.byteLength(compiledPrompt, "utf8") > readInternalBudgets().promptByteHard) {
    throw Object.assign(new Error("实际模型请求超过UTF-8字节硬限"), {
      code: "CURRENT_MATERIAL_BUDGET_EXCEEDED"
    });
  }
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const requestBinding = digest(binding + "\0" + compiledPrompt);
  const retained = entries.filter(entry => entry.sentText.length);
  const partialSourceCount = retained.filter(entry => entry.originals.some(source =>
    (source.textSpans || [source.text]).some(span => !entry.sentText.some(sent => sent.includes(span))))).length;
  const layerValues = (key: string) => transformed.filter(object).map(value => value[key]).filter(object);
  const trendTokens = layerValues("trendBudget").reduce((sum, layer) => sum + Number(layer.estimatedTokens || 0), 0);
  const evidenceTokens = layerValues("referenceEvidenceBudget").reduce((sum, layer) => sum + Number(layer.estimatedTokens || 0), 0);
  return {
    prompt: compiledPrompt, binding: requestBinding, entries,
    sources: retained.map(entry => ({ ...structuredClone(entry.original),
      textSpans: entry.originals.flatMap(source => source.textSpans || [source.text]) })),
    receipt: {
      schemaVersion: 1, binding: requestBinding,
      aliasMapSha256: digest(JSON.stringify(retained.map(entry => [
        entry.alias, entry.originals.map(source => [source.citationId, source.source]), entry.sentText
      ]))),
      promptSha256: digest(compiledPrompt), promptBytes: Buffer.byteLength(compiledPrompt, "utf8"),
      promptByteLimit: budgets.promptByteHard,
      unit: "UTF-8 bytes", providedCount: retained.length,
      coreModelProvided: transformed.some(value => object(value) && object(value.coreUserModel)),
      trendTokens, evidenceTokens,
      trendBudgetLevel: trendTokens > budgets.trendWarn || groups.some(group => group.trendClipped) ? "warn" : "ok",
      evidenceBudgetLevel: evidenceTokens > budgets.evidenceWarn || partialSourceCount > 0 ? "warn" : "ok",
      truncatedSources: partialSourceCount
    }
  };
}

/**
 * 恢复本次别名；未知别名作为无效脚注剔除并给出原因，合法回答正文继续核验。
 * 映射不接收外部保存的其他请求目录，历史回答仍由旧长引用读取路径处理。
 * @since unreleased
 */
export function decodeReferenceAnswer(raw: string, request: ReferenceRequest, expectedBinding = request.binding): {
  raw: string; rejected: { citationId: string; reason: string }[];
} {
  let document: unknown;
  try { document = JSON.parse(raw); } catch { return { raw, rejected: [] }; }
  if (!object(document) || !Array.isArray(document.citations) || document.citations.length > 8) return { raw, rejected: [] };
  const known = new Map((request.binding === expectedBinding ? request.entries : []).filter(entry => entry.sentText.length).map(entry => [entry.alias, entry]));
  const rejected: { citationId: string; reason: string }[] = [];
  document.citations = document.citations.flatMap(value => {
    if (!object(value) || typeof value.citationId !== "string") return [value];
    const entry = known.get(value.citationId);
    if (!entry) {
      rejected.push({ citationId: value.citationId.slice(0, 100), reason: "unknown_request_reference" });
      return [];
    }
    if (typeof value.exactQuote === "string"
      && (!entry.originals.some(source => (source.textSpans || [source.text]).some(span => span.includes(value.exactQuote as string)))
        || !entry.sentText.some(text => text.includes(value.exactQuote as string)))) {
      rejected.push({ citationId: value.citationId, reason: "quote_not_in_sent_original_span" });
      return [];
    }
    return [{ ...value, citationId: entry.original.citationId }];
  });
  return { raw: JSON.stringify(document), rejected };
}
