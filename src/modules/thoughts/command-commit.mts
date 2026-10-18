/**
 * 思绪聚合命令的事务提交与来源副作用管道。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只提交调用方加载的记录闭包；外部任务动作由提交成功后的调用方执行。
 */
import type {
  RecordEntity, RecordTransaction, SourceMutationEffects, SourceMutationState
} from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { TrashEntry } from "./record-contracts.mjs";
import { addThoughtClosureChanges } from "./local-changes.mjs";
import {
  ensureThoughtLifecycles, markThoughtLifecycleDeleted, markThoughtLifecycleRestored
} from "./record-lifecycle.mjs";

type Observation = Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;

function resourceIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) resourceIds(item, ids);
  } else if (value && typeof value === "object") {
    if ("id" in value && typeof value.id === "string") ids.add(value.id);
    for (const child of Object.values(value)) resourceIds(child, ids);
  }
  return ids;
}

/** 业务、来源、索引、生命周期和同步变化在同一事务内提交。 @since unreleased */
export async function commitThoughtCommand(
  ports: RecordTransaction,
  repository: ThoughtRecordRepository,
  state: SourceMutationState,
  rootId: string,
  {
    observation,
    trashEntries = [],
    restoredAt = ""
  }: {
    observation?: Observation;
    trashEntries?: RecordEntity[];
    restoredAt?: string;
  } = {}
) {
  await observation?.apply();
  // capture 仅供创建时校验来源；观察新增集合后再确定实际写集。
  const managed = new Set(Object.keys(state.store)
    .filter(collection => collection !== "captures"));
  const beforeRows = state.rows.filter(row => managed.has(row.collection));
  const rows = await repository.persistMappedClosure(
    ports, ports.accountId, beforeRows, state.store, {
      managedCollections: [...managed],
      refreshIndexesForCollections: ["aiTasks", "notifications"],
      restoredRows: state.restoredRows
    }
  );
  const thoughtRows = rows.filter(row => row.collection === "thoughts");
  await ensureThoughtLifecycles(ports.lifecycles, thoughtRows);
  if (restoredAt) {
    const previous = new Set(beforeRows.map(row => row.objectKey));
    await markThoughtLifecycleRestored(
      ports.lifecycles,
      thoughtRows.filter(row => !previous.has(row.objectKey)),
      restoredAt,
      thoughtRows
    );
  }
  const keys = new Set(thoughtRows.map(row => row.objectKey));
  const removed = beforeRows.filter(row => row.collection === "thoughts" && !keys.has(row.objectKey));
  for (const entry of trashEntries) {
    const ids = resourceIds([entry.payload, entry.dependents]);
    await markThoughtLifecycleDeleted(
      ports.lifecycles,
      removed.filter(row => ids.has(row.id)),
      entry as TrashEntry,
      beforeRows.filter(row => row.collection === "thoughts")
    );
  }
  addThoughtClosureChanges(ports, beforeRows, rows, rootId);
  return rows;
}

/** 成功提交后执行已登记的来源调度和删除传播。 @since unreleased */
export function afterThoughtCommandCommit(observation: Observation, entries: RecordEntity[] = []) {
  observation?.afterCommit();
  for (const entry of entries) entry[AFTER_COMMIT]?.();
}
