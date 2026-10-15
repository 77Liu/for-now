/**
 * 内部摘要与上下文的分层预算配置，单位与资金预算分离。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：唯一默认值来源；WARN 不代表结构、来源或权限校验可跳过。
 */
const defaults = Object.freeze({
  dailySummaryWarn: 900,
  dailySummaryHard: 5000,
  trendWarn: 1000,
  trendHard: 2000,
  evidenceWarn: 3500,
  evidenceHard: 5000,
  sourceCharacterMax: 8000,
  minimumReferences: 10,
  promptByteHard: 32000
});
const environmentKeys: Record<keyof typeof defaults, string> = {
  dailySummaryWarn: "INTERNAL_DAILY_SUMMARY_WARN_TOKENS",
  dailySummaryHard: "INTERNAL_DAILY_SUMMARY_HARD_TOKENS",
  trendWarn: "INTERNAL_TREND_WARN_TOKENS",
  trendHard: "INTERNAL_TREND_HARD_TOKENS",
  evidenceWarn: "INTERNAL_EVIDENCE_WARN_TOKENS",
  evidenceHard: "INTERNAL_EVIDENCE_HARD_TOKENS",
  sourceCharacterMax: "INTERNAL_SOURCE_CHARACTER_MAX",
  minimumReferences: "INTERNAL_MINIMUM_REFERENCES",
  promptByteHard: "INTERNAL_PROMPT_HARD_BYTES"
};
export type InternalBudgets = { -readonly [K in keyof typeof defaults]: number };

/**
 * 读取单一环境配置；拒绝非法数字或 WARN 大于硬限的配置。
 * 不修改环境，不改变任何资金或第三方调用额度。
 * @since unreleased
 */
export function readInternalBudgets(env: NodeJS.ProcessEnv = process.env): Readonly<InternalBudgets> {
  const result = {} as InternalBudgets;
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const text = String(env[environmentKeys[key]] ?? "").trim();
    const value = text ? Number(text) : defaults[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${environmentKeys[key]}`);
    result[key] = value;
  }
  for (const [warn, hard] of [
    [result.dailySummaryWarn, result.dailySummaryHard],
    [result.trendWarn, result.trendHard],
    [result.evidenceWarn, result.evidenceHard]
  ]) {
    if (warn > hard) throw new Error("Internal budget WARN must not exceed hard limit");
  }
  // 整体请求与单条原文允许上限不能通过配置越过已冻结的消费者边界。
  if (result.dailySummaryHard > defaults.dailySummaryHard || result.trendHard > defaults.trendHard
    || result.evidenceHard > defaults.evidenceHard || result.minimumReferences > 50
    || result.promptByteHard > defaults.promptByteHard
    || result.sourceCharacterMax > defaults.sourceCharacterMax) {
    throw new Error("Internal configuration exceeds the consumer hard boundary");
  }
  return Object.freeze(result);
}

/**
 * 统一保守估算内部 JSON/文本 token；不是供应商 usage 或资金计量。
 * @since unreleased
 */
export function estimateInternalTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let tokens = 0;
  let asciiRun = 0;
  const flush = () => {
    if (asciiRun) tokens += Math.ceil(asciiRun / 3);
    asciiRun = 0;
  };
  for (const character of text || "") {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f && /[a-zA-Z0-9]/.test(character)) {
      asciiRun += 1;
      continue;
    }
    flush();
    tokens += point > 0x7f ? 2 : character.trim() ? 1 : 0;
  }
  flush();
  return tokens;
}

/**
 * 编译前先有界投影可选证据，防止原文目录把必需当前材料误判为超限。
 * 截取连续原文前缀，不添加省略号；下游仍按最终短请求重新测量。
 * @since unreleased
 */
export function boundedReferenceEvidence<T extends { text?: unknown }>(rows: T[]): T[] {
  const limits = readInternalBudgets();
  const baseline = estimateInternalTokens(rows.map(row => ({ ...row, text: "" })));
  if (baseline > limits.evidenceHard) throw Object.assign(new Error("证据目录结构超过二级预算"), {
    code: "WORKING_CONTEXT_EVIDENCE_BUDGET_EXCEEDED"
  });
  const allowance = Math.min(limits.sourceCharacterMax,
    Math.max(1, Math.floor((limits.evidenceHard - baseline) / Math.max(1, rows.length) / 2)));
  return rows.map(row => typeof row.text === "string"
    ? { ...row, text: Array.from(row.text).slice(0, allowance).join(""),
      originalCharacters: row.text.length,
      excerptTruncated: Array.from(row.text).length > allowance } : { ...row });
}
