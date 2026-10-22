/**
 * 图片原文 typed 命令的应用层装配。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：绑定既有账户事务、图映射与来源副作用。
 */
import { createContentAttachmentRecordCommands as create } from "../../../.build/typescript/backend/app/record-commands/content-attachments.mjs";
import { createThoughtRecordRepository } from "../../../.build/typescript/backend/shared/persistence/thought-record-repository.mjs";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects } from "../../shared/persistence/index.mjs";

export const createContentAttachmentRecordCommands = repository => create({
  unitOfWork: repository.accountUnitOfWork,
  effects: repository.sourceMutationEffects,
  repository: createThoughtRecordRepository({ canonicalJson, mapStoreObjects, rebuildStoreObjects })
});
