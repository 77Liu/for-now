/**
 * 为思绪领域 typed command 装配既有服务、图映射与任务输入策略。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：仅应用编排；业务规则、仓库及生命周期由类型检查覆盖。
 */
import { createThoughtRecordCommands as create } from "../../../.build/typescript/backend/modules/thoughts/record-commands.mjs";
import { createThoughtRecordRepository } from "../../../.build/typescript/backend/shared/persistence/thought-record-repository.mjs";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects } from "../../shared/persistence/index.mjs";
import { taskInputMatches } from "../../modules/tasks/index.mjs";
/** Wires the thought domain command to the transaction-scoped repository. @since unreleased */
export const createThoughtRecordCommands = options => create({
  ...options,
  taskInputMatches,
  repository: createThoughtRecordRepository({ canonicalJson, mapStoreObjects, rebuildStoreObjects })
});
