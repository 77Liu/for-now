/**
 * 请求内引用编译与核验的公共入口。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：真实身份留在服务端，调用方传入本次已核验目录与账户/任务回执绑定。
 */
export { compileReferenceRequest, decodeReferenceAnswer } from "./reference-aliases.mjs";
export type { CitationSource, ReferenceRequest } from "./reference-aliases.mjs";
export { readInternalBudgets, estimateInternalTokens, boundedReferenceEvidence } from "./internal-budgets.mjs";
export type { InternalBudgets } from "./internal-budgets.mjs";
