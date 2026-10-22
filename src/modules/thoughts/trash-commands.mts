/**
 * 思绪内容块、子项回收与清单恢复的公开记录命令。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅加载目标所属链及回收清单，不访问账户大文档。
 */
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, SourceMutationEffects
} from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { TrashEntry } from "./record-contracts.mjs";
import { commitThoughtCommand, afterThoughtCommandCommit } from "./command-commit.mjs";

export type ThoughtNestedDeleteInput = {
  parentCollection: string;
  parentId: string;
  field: string;
  type: string;
  id: string;
  annotationTargetKeys?: string[];
};
type RestoreResult = {
  value?: RecordEntity;
  missing?: boolean;
  invalid?: boolean;
  conflict?: boolean;
  parentMissing?: boolean;
};
type Services = {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  effects?: SourceMutationEffects | null;
  now(): string;
  trash: { find(entries: RecordEntity[], type: string, resourceId: string): TrashEntry | null };
  mutations: {
    moveThoughtBlockToTrash(store: RecordStore, id: string): TrashEntry | null;
    moveNestedItemToTrash(store: RecordStore, input: ThoughtNestedDeleteInput): TrashEntry | null;
    restoreTrashEntry(store: RecordStore, id: string): RestoreResult;
  };
};

/** 同步、来源权限和回收状态与业务修改共用一次账户事务。 @since unreleased */
export function createThoughtTrashCommands(services: Services) {
  const { unitOfWork, repository, effects, mutations, trash, now } = services;
  async function remove(input: ThoughtNestedDeleteInput | { id: string }) {
    const nested = "parentId" in input;
    const type = nested ? input.type : "thoughtBlock";
    let observation: Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
    const entries: TrashEntry[] = [];
    const committed = await unitOfWork.run({
      commandId: nested ? `thought.${input.field === "remarks" ? "remark" : "followUp"}.delete` : "thought.block.delete"
    }, async ports => {
      const duplicate = await ports.objects.findTrash(type, input.id, nested ? input.parentId : null);
      const closure = await repository.readThoughtTargetClosure(ports, nested ? input.parentId : input.id, {
        forDeletion: !effects
      });
      const store = closure?.store || { thoughts: [], trash: [] };
      if (duplicate) store.trash = repository.rebuildRecordCollections([duplicate], ["trash"]).trash;
      if (!closure) return trash.find(store.trash, type, input.id);
      const state = { rows: [...closure.rows, ...(duplicate ? [duplicate] : [])], store };
      observation = await effects?.prepare(ports, state);
      const result = nested
        ? mutations.moveNestedItemToTrash(state.store, input)
        : mutations.moveThoughtBlockToTrash(state.store, input.id);
      if (!result || result.id === duplicate?.id) return result;
      entries.push(result);
      await commitThoughtCommand(ports, repository, state, JSON.parse(closure.rootKey)[1], {
        observation, trashEntries: entries
      });
      return result;
    });
    if (entries.length) afterThoughtCommandCommit(observation, entries);
    return committed.value;
  }

  async function restore(id: string) {
    let observation: Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
    let changed = false;
    const committed = await unitOfWork.run({ commandId: "thought.trash.restore" }, async ports => {
      const closure = await repository.readThoughtRestoreClosure(ports, id, {
        includeSourceDependents: !effects
      });
      if (!closure) return { missing: true };
      if (!closure.supported) return { unsupported: true };
      const state = {
        rows: closure.rows,
        store: closure.store,
        restoredSourceKeys: closure.archivedKeys,
        restoredRootId: closure.rootId,
        restoredRows: closure.archivedRows
      };
      observation = await effects?.prepare(ports, state);
      const result = mutations.restoreTrashEntry(state.store, id);
      if (!result.value) return result;
      repository.advanceRestoredVersions(ports.accountId, state.store, closure.rows, closure.archivedRows);
      await commitThoughtCommand(ports, repository, state, closure.rootId, { observation, restoredAt: now() });
      changed = true;
      return result;
    });
    if (changed) afterThoughtCommandCommit(observation);
    return committed.value;
  }
  return {
    removeBlock: (id: string) => remove({ id }),
    removeNested: (input: ThoughtNestedDeleteInput) => remove(input),
    restore
  };
}
export type ThoughtTrashCommands = ReturnType<typeof createThoughtTrashCommands>;
