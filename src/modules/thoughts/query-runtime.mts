/**
 * 装配思绪公开 query 与投影维护命令，兼容写路径共用同事务维护边界。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：不允许请求失败后全读回退；历史回填必须由明确维护动作调用。
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵待完成；查询、事务及桌面浏览器的局部通过证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { AccountUnitOfWork } from "../../shared/persistence/account-unit-of-work.mjs";
import type { RecordEntity } from "../../shared/persistence/record-command-types.mjs";
import type { ProjectionContext, ThoughtProjection, ThoughtQueryDependencies, ThoughtPageInput, ThoughtDiscoveryInput, SpeechSourceReceipt } from "./query-contracts.mjs";
import { createThoughtProjection } from "./projection.mjs";
import { queryThoughtDiscoveryCandidates } from "./discovery-query.mjs";
import { THOUGHT_PAGING } from "../../shared/thought-pagination/index.mjs";
import { assertThoughtIndexReady, getThoughtChainDetail, listThoughtChainsPage } from "./query.mjs";
export type ThoughtQueryRepository = {
  accountUnitOfWork?: AccountUnitOfWork;
  recordProjectionCoverage?: {
    recordTransactions: boolean; legacyCommits: boolean;
    initialization: boolean; offlineImportInvalidates: boolean;
  };
  queryRecords?: <T>(operation: (context: ProjectionContext) => Promise<T>) => Promise<T>;
  installRecordProjection?: (projection: ThoughtProjection) => void;
  rebuildRecordProjection?: (afterRootId?: string) => Promise<{ afterRootId: string; done: boolean; processed: number }>;
};
function discoveryMutation(repository: ThoughtQueryRepository, dependencies: ThoughtQueryDependencies) {
  const graph = createThoughtRecordRepository(dependencies);
  const commandIds = {
    markRead: "thought.discovery.markRead",
    snooze: "thought.discovery.snooze",
    clearSnooze: "thought.discovery.clearSnooze"
  } as const;
  return async <T,>(rootId: string, operation: (root: RecordEntity, blocks: RecordEntity[]) => T,
    action: keyof typeof commandIds): Promise<T | { missing: true }> => {
    if (!repository.accountUnitOfWork) throw new Error("Discovery mutation requires record transactions");
    const commandId = commandIds[action];
    if (!commandId) throw new TypeError("Discovery mutation action is invalid");
    const committed = await repository.accountUnitOfWork.run({ commandId }, async ports => {
      const closure = await graph.readThoughtClosure(ports.objects, ports.relations, rootId);
      if (!closure) return { missing: true } as const;
      const root = closure.thoughts.find(item => item.id === rootId && item.type === "question")!;
      const result = operation(root, closure.thoughts.filter(item => item.relatedTo === rootId));
      if (!result || typeof result !== "object" || !("value" in result)) return result;
      const row = closure.rows.find(item => item.id === rootId && item.parentKey === null)!;
      // Discovery owns a separate version; viewing a result must not invalidate answer inputs.
      const payload = { ...row.payload, discovery: root.discovery };
      if (!await ports.objects.update({ ...row, payload }, row.version)) {
        throw Object.assign(new Error("发现状态已变化"), { statusCode: 409, code: "VERSION_CONFLICT" });
      }
      const discovery = root.discovery as { version: number };
      ports.addChange({ entityType: "thoughtDiscovery", entityId: rootId, version: discovery.version,
        operation: "update", changedFields: ["discovery"], scopeKeys: ["thought:list", `thought:${rootId}`] });
      return result;
    });
    return committed.value;
  };
}

/** 注册唯一维护命令；读取开关只选择已准备的数据库读者，不触发回填。 @since unreleased
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵待完成；查询、事务及桌面浏览器的局部通过证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
export function createThoughtQueryRuntime({ repository, dependencies, enabled }: {
  repository: ThoughtQueryRepository;
  dependencies: ThoughtQueryDependencies;
  enabled: boolean;
}) {
  const query = repository.queryRecords;
  if (!query || !repository.installRecordProjection) {
    if (enabled) throw new Error("THOUGHT_PAGING_ENABLED requires the database query adapter");
    return null;
  }
  if (enabled && (!repository.recordProjectionCoverage
    || Object.values(repository.recordProjectionCoverage).some(covered => covered !== true))) {
    throw Object.assign(new Error("思绪索引生产者维护边界不完整，禁止启用"), {
      code: "THOUGHT_INDEX_PRODUCER_COVERAGE_INCOMPLETE"
    });
  }
  repository.installRecordProjection(createThoughtProjection(dependencies));
  return {
    enabled,
    speechSources: (rootIds: string[]) => query(async context => {
      if (rootIds.length > THOUGHT_PAGING.pageSize) throw new RangeError("Speech sources require at most one thought page");
      await assertThoughtIndexReady(context);
      const result = await context.client.query<{ speech_sources: SpeechSourceReceipt[] }>(`
        SELECT speech_sources FROM for_now.thought_chain_index
        WHERE account_id=$1 AND root_id=ANY($2::text[])
      `, [context.accountId, rootIds]);
      return result.rows.flatMap(row => row.speech_sources);
    }),
    mutateDiscovery: discoveryMutation(repository, dependencies),
    list: (input: ThoughtPageInput) => query(context => listThoughtChainsPage(context, input)),
    discovery: (input: ThoughtDiscoveryInput) => query(context => queryThoughtDiscoveryCandidates(context, input, dependencies)),
    detail: (rootId: string) => query(context => getThoughtChainDetail(context, rootId, dependencies)),
    async rebuild() {
      let afterRootId = "";
      let processed = 0;
      while (true) {
        const batch = await repository.rebuildRecordProjection!(afterRootId);
        processed += batch.processed;
        if (batch.done) return { processed };
        afterRootId = batch.afterRootId;
      }
    }
  };
}
