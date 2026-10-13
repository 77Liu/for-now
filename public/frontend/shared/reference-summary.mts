/**
 * 展示本次确实发送的参考数量与目录标签，与已核验引用分开。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：不展示模型证据或原文详情，不为历史无目录回答编造参考。
 */
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/**
 * 提供目录只证明材料已发送，不证明模型因果依赖，也不增加实际脚注数量。
 * @since unreleased
 */
export function providedReferenceMarkup(references: unknown, receipt?: { providedCount?: number; coreModelProvided?: boolean; trendBudgetLevel?: string; evidenceBudgetLevel?: string; truncatedSources?: number }): string {
  if (!Array.isArray(references)) return "";
  const modelNote = receipt?.coreModelProvided ? "<p>你的专属用户模型已携带。</p>" : "";
  const budgetNote = receipt?.trendBudgetLevel === "warn" || receipt?.evidenceBudgetLevel === "warn"
    ? "<p>内部上下文预算已触发 WARN；合法材料仍在预算范围内发送。</p>" : "";
  const excerptNote = receipt?.truncatedSources
    ? `<p>${receipt.truncatedSources} 条原文提供了有界连续摘录。</p>` : "";
  const items = references.map(item => (
    `<li>${escape(item?.recordType || "原记录")} · 版本 ${Number(item?.version) || 0}</li>`
  )).join("");
  return `<details class="provided-references"><summary>提供给模型的参考（${receipt?.providedCount ?? references.length}）</summary>`
    + `<p>这些材料已提供给模型；回答实际引用以逐字核验结果为准。</p>${modelNote}${budgetNote}${excerptNote}`
    + `<ul>${items}</ul></details>`;
}
