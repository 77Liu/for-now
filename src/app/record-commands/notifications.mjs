/**
 * 为通知领域命令注入跨领域任务可见性策略。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：应用层仅装配；业务命令和持久化仓库使用 TypeScript。
 */
import { createNotificationRecordCommands as create } from "../../../.build/typescript/backend/modules/notifications/record-commands.mjs";
import { isInternalAiTask } from "../../modules/tasks/index.mjs";
/** Wires the notification domain command; no business state is owned here. @since unreleased */
export const createNotificationRecordCommands = options => create({ ...options, isInternalAiTask });
