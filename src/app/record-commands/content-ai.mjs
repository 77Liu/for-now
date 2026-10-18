/**
 * 图片与批注 AI 写回的业务目标适配。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：编排领域纯操作；个人语境校验留在事务外并以修订号绑定。
 */
import { createContentAiRecordCommands as create } from "../../../.build/typescript/backend/app/record-commands/content-ai.mjs";
import { createThoughtRecordRepository } from "../../../.build/typescript/backend/shared/persistence/thought-record-repository.mjs";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects } from "../../shared/persistence/index.mjs";
import { recordVersion } from "../../shared/validation/index.mjs";
import { taskInputMatches } from "../../modules/tasks/index.mjs";
import { annotationResource, annotationResourceSource } from "../annotation-resources.mjs";

const collections = {
  thought: "thoughts", capture: "captures", journal: "journals", chat: "chats",
  analysis: "analyses", book: "books", quote: "quotes"
};

/** 复用既有目标保存规则，仅替换持久化边界。 @since unreleased */
export function createContentAiRecordCommands({ targets, ...options }) {
  return create({
    ...options,
    taskInputMatches,
    repository: createThoughtRecordRepository({ canonicalJson, mapStoreObjects, rebuildStoreObjects }),
    owner: task => collections[task.resourceType]
      ? { collection: collections[task.resourceType], id: task.targetId } : null,
    inspect: (store, task) => {
      if (task.kind === "contentImageUnderstanding") return targets.prepare(store, task);
      if (task.kind !== "annotationShenji") return null;
      const root = annotationResource(store, task.resourceType, task.targetId);
      const annotation = root?.annotations?.find(item => item.id === task.subtargetId);
      const source = annotation && annotationResourceSource(store, task.resourceType, root, annotation.targetKey);
      if (!source?.includes(annotation.quote)) return null;
      return {
        annotation, inputVersion: recordVersion(root.version),
        subtargetVersion: recordVersion(annotation.version), inputHash: task.inputHash
      };
    },
    save: (store, work, task, result) => targets.save(store, work, task, result)
  });
}
