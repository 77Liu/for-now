/**
 * 图片原文入口的目标闭包、库存校验与事务提交。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：应用层组合领域纯修改；只加载目标所属记录和指定图片路径。
 */
import type {
  AccountUnitOfWork, ObjectRow, RecordEntity, RecordStore, RecordTransaction, SourceMutationEffects
} from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT, recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import { commitThoughtCommand, afterThoughtCommandCommit } from "../../modules/thoughts/command-commit.mjs";

type Owner = { collection: string; id: string } | null;
type Result = Record<string, unknown> & { [AFTER_COMMIT]?: () => void };
type Operation = {
  commandId: string;
  targetType?: string;
  targetId?: string;
  owner?: Owner;
  trashId?: string;
  paths?: string[];
  readOnly?: boolean;
  mutate(store: RecordStore, inventory: Map<string, unknown>): Result;
};
type Closure = { rows: ObjectRow[]; store: RecordStore; rootId: string };

async function targetClosure(
  ports: RecordTransaction, repository: ThoughtRecordRepository,
  targetType: string, targetId: string, owner: Owner
): Promise<Closure | null> {
  let collection = targetType === "capture" ? "captures" : "thoughts";
  let ownerId = targetId;
  if (targetType === "comment") {
    const annotation = await ports.objects.findAnnotation(targetId, owner);
    if (!annotation?.parentKey) return null;
    [collection, ownerId] = JSON.parse(annotation.parentKey) as string[];
  }
  if (collection === "thoughts") {
    const closure = await repository.readThoughtTargetClosure(ports, ownerId);
    return closure ? {
      rows: closure.rows, store: closure.store, rootId: String(JSON.parse(closure.rootKey)[1])
    } : null;
  }
  const rows = await ports.objects.findTree([recordObjectKey(collection, ownerId)], { lock: true });
  if (!rows.length) return null;
  return { rows, store: repository.rebuildRecordCollections(rows, [collection]), rootId: "" };
}

async function commandClosure(
  ports: RecordTransaction, repository: ThoughtRecordRepository, input: Operation
) {
  let entry: ObjectRow | null = null;
  let { targetType = "", targetId = "", owner = null } = input;
  if (input.trashId) {
    entry = await ports.objects.find(recordObjectKey("trash", input.trashId), { lock: true });
    if (!entry || entry.payload.type !== "contentAttachment") return { missing: true };
    if (entry.payload.permanentlyPurged === true) {
      throw Object.assign(new Error("该图片已永久清理，禁止恢复"), {
        statusCode: 409, code: "RESOURCE_PERMANENTLY_PURGED"
      });
    }
    const location = entry.payload.location as { targetType?: string; targetId?: string; owner?: Owner } | undefined;
    if (!location || !["comment", "capture", "thoughtRoot", "thoughtBlock"].includes(location.targetType || "")
      || typeof location.targetId !== "string" || !location.targetId) return { invalid: true };
    targetType = location.targetType!;
    targetId = location.targetId;
    owner = location.owner || null;
  }
  const closure = await targetClosure(ports, repository, targetType, targetId, owner);
  if (!closure) return entry ? { parentMissing: true } : { missing: true };
  if (entry) {
    closure.rows.push(entry);
    closure.store.trash = repository.rebuildRecordCollections([entry], ["trash"]).trash;
  }
  return { closure, targetType, targetId, owner };
}

/** 库存与业务写集持有同一账户锁；外部取消仅在提交成功后触发。 @since unreleased */
export function createContentAttachmentRecordCommands({
  unitOfWork, repository, effects
}: {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  effects?: SourceMutationEffects | null;
}) {
  return {
    async run(input: Operation) {
      let observation: Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
      let resultAfterCommit: (() => void) | undefined;
      const committed = await unitOfWork.run({ commandId: input.commandId }, async ports => {
        const loaded = await commandClosure(ports, repository, input);
        if (!loaded.closure) return loaded;
        const state = loaded.closure;
        const allPaths = new Set(input.paths || []);
        const relevantRows = state.rows.filter(row => row.collection === "trash"
          || (row.id === loaded.targetId && (loaded.targetType !== "comment"
            ? row.parentKey === null
            : ["annotation", "annotationDrift"].includes(row.kind)
              && (!loaded.owner || row.parentKey === recordObjectKey(loaded.owner.collection, loaded.owner.id)))));
        for (const row of relevantRows) {
          const resource = row.collection === "trash" ? row.payload.payload as RecordEntity : row.payload;
          for (const path of (resource?.attachmentPaths || []) as string[]) allPaths.add(path);
          for (const item of (resource?.imageUnderstandings || []) as RecordEntity[]) {
            for (const path of (item.sourceAttachmentPaths || []) as string[]) allPaths.add(path);
          }
        }
        const inventory = new Map((await ports.attachments.findMany([...allPaths]))
          .map(row => [row.path, row]));
        if (!input.readOnly) observation = await effects?.prepare(ports, state);
        const result = input.mutate(state.store, inventory);
        if (!input.readOnly && result.value && !result.unchanged && !result.duplicate) {
          await commitThoughtCommand(ports, repository, state, state.rootId, {
            observation, includeCaptures: true
          });
          resultAfterCommit = result[AFTER_COMMIT];
        } else observation = undefined;
        return result;
      });
      afterThoughtCommandCommit(observation);
      resultAfterCommit?.();
      return committed.value;
    }
  };
}
