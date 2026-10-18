/**
 * 思绪记录命令中的来源感知与压缩失效编排。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅加载本次来源的证据、关联任务及受影响日期的派生记录。
 */
import type { ObjectRow, RecordStore, SourceMutationEffects } from "../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../shared/persistence/thought-record-repository.mjs";
type Dependencies = {
  repository: ThoughtRecordRepository;
  sourceDates(store: RecordStore): string[];
  observe(before: RecordStore, store: RecordStore): string[];
  invalidate(store: RecordStore, before: RecordStore): string[];
  schedule(taskId: string): void;
  cancel(taskId: string): unknown;
};

const sourceCollections = ["evidencePermissions", "perceptionEvents", "evidenceSources", "aiTasks"];
const deduplicate = (rows: ObjectRow[]) => (
  [...new Map(rows.map(row => [row.objectKey, row])).values()]
);

/** 将既有感知与压缩规则组合进账户内短事务。 @since unreleased */
export function createSourceMutationEffects(dependencies: Dependencies): SourceMutationEffects {
  const { repository, sourceDates, observe, invalidate, schedule, cancel } = dependencies;
  return {
    async prepare(ports, state) {
      const sourceKeys = state.rows
        .filter(row => ["thoughts", "captures", "journals"].includes(row.collection))
        .map(row => row.objectKey);
      const restored = state.restoredSourceKeys || [];
      const rootId = state.restoredRootId || null;
      const relatedKeys: string[] = [];
      for (const collection of sourceCollections) {
        relatedKeys.push(...await ports.relations.findSources([...new Set([...sourceKeys, ...restored])], {
          sourceCollection: collection,
          historicalRootId: rootId
        }));
      }
      const existing = new Set(state.rows.map(row => row.objectKey));
      const relatedRows = await ports.objects.findTree(
        [...new Set(relatedKeys)].filter(key => !existing.has(key)),
        { lock: true }
      );
      const notificationKeys = await ports.relations.findSources(
        relatedRows.filter(row => row.collection === "aiTasks").map(row => row.objectKey),
        { sourceCollection: "notifications", relation: "task" }
      );
      const notifications = await ports.objects.findTree(
        notificationKeys.filter(key => !existing.has(key)),
        { lock: true }
      );
      const historical = await ports.objects.find('["historicalUserSupplement"]', { lock: true });
      state.rows = deduplicate([...state.rows, ...relatedRows, ...notifications]);
      const supplementalCollections = [...sourceCollections, "notifications", "trash"];
      const supplemental = repository.rebuildRecordCollections(
        state.rows.filter(row => supplementalCollections.includes(row.collection)),
        supplementalCollections
      );
      Object.assign(state.store, supplemental);
      if (historical) {
        state.rows.push(historical);
        Object.assign(state.store, { historicalUserSupplement: structuredClone(historical.payload) });
      }
      const before = structuredClone(state.store);
      const taskIds: string[] = [];
      const staleTaskIds: string[] = [];
      return {
        async apply() {
          const dates = [...new Set([...sourceDates(before), ...sourceDates(state.store)])];
          const compressionRows = await ports.objects.findForLocalDates("recordCompressions", dates);
          const runningRows = await ports.objects.findForLocalDates("aiTasks", dates, { runningOnly: true });
          const loaded = deduplicate([...compressionRows, ...runningRows]);
          state.rows = deduplicate([...state.rows, ...loaded]);
          const selected = repository.rebuildRecordCollections(loaded, ["recordCompressions", "aiTasks"]);
          state.store.recordCompressions = selected.recordCompressions;
          const tasks = new Map(state.store.aiTasks.map(task => [task.id, task]));
          for (const task of selected.aiTasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
          state.store.aiTasks = [...tasks.values()];
          taskIds.push(...observe(before, state.store));
          staleTaskIds.push(...invalidate(state.store, before));
        },
        afterCommit() {
          for (const taskId of new Set(staleTaskIds)) cancel(taskId);
          for (const taskId of new Set(taskIds)) {
            try {
              schedule(taskId);
            } catch {
              // 已持久化的排队任务由启动恢复处理。
            }
          }
        }
      };
    }
  };
}
