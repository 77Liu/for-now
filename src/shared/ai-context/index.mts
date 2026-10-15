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
export { IMPORTANCE_SCORING_VERSION, isImportanceScore, importanceScoreFor, importanceWeight, weightedImportanceOrder, parseImportanceScores } from "./importance.mjs";
export type { ImportanceMaterial, ImportanceScore, ImportanceModelChoice } from "./importance.mjs";
export { createImportanceService, IMPORTANCE_BATCH_SIZE } from "./importance-runtime.mjs";
export type { ImportanceSourceRef } from "./importance-runtime.mjs";
export { createImportanceHttp } from "./importance-http.mjs";
export { createImportanceSelectionPlan, applyImportanceSelectionPlan, RELATED_REFERENCE_SHARE_MAX } from "./importance-selection.mjs";
export type { ImportanceSelectionPlan, SelectionMaterial } from "./importance-selection.mjs";

export { isImportanceJob } from "./importance-batches.mjs";
