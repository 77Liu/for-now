/**
 * 分页生产者硬门的正式运行时装配验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅装配；缺口在首次 SQL、供应商或后台调度前拒绝。
 */
import assert from "node:assert/strict";
import type { ThoughtQueryRepository } from "../src/modules/thoughts/query-runtime.mjs";

type Runtime = {
  thoughtQueries: {
    list(input: Record<string, unknown>): Promise<unknown>;
    assertProducersReady(bindings: Record<string, unknown>): unknown;
  };
  thoughtRecordCommands: unknown;
  thoughtService: { recordProducerCommands: unknown };
  annotationCommands: { recordProducerCommands: unknown };
  trashCommands: { recordProducerCommands: unknown };
  contentAttachmentService: { recordProducerCommands: unknown };
  backgroundAi: { recordProducerCommand(name: string): unknown };
};
type Factory = (options: Record<string, unknown>) => Runtime;
const code = "THOUGHT_INDEX_PRODUCER_COVERAGE_INCOMPLETE";
const flags = ["thought.create", "thought.update", "thought.delete", "thought.aiWriteback", "task.status"];

function repository(): ThoughtQueryRepository {
  return {
    accountUnitOfWork: {
      readRevision: async () => { throw new Error("Gate must not read revision"); },
      run: async () => { throw new Error("Gate must not mutate"); }
    },
    recordProjectionCoverage: {
      recordTransactions: true, legacyCommits: true, initialization: true, offlineImportInvalidates: true
    },
    queryRecords: async () => { throw new Error("Prepared query reached SQL"); },
    installRecordProjection() {},
    rebuildRecordProjection: async () => { throw new Error("Gate must not rebuild"); }
  };
}

function bindings(runtime: Runtime) {
  return {
    roots: runtime.thoughtRecordCommands,
    local: runtime.thoughtService.recordProducerCommands,
    annotations: runtime.annotationCommands.recordProducerCommands,
    trash: runtime.trashCommands.recordProducerCommands,
    attachments: runtime.contentAttachmentService.recordProducerCommands,
    contentAi: runtime.backgroundAi.recordProducerCommand("content.aiWriteback")
  };
}

/** 用正式内容运行时逐项移除必需开关、维护声明和实际命令。 @since unreleased */
export async function runThoughtProducerGateChecks(
  createRuntime: Factory,
  createQueries: (repository: ThoughtQueryRepository) => Runtime["thoughtQueries"]
) {
  const configured = (overrides: Record<string, unknown> = {}) => ({
    repository: repository(),
    thoughtPagingConfig: { enabled: true },
    recordCommandConfig: { enabled: (name: string) => flags.includes(name) },
    ...overrides
  });
  for (const flag of flags) {
    assert.throws(() => createRuntime(configured({
      recordCommandConfig: { enabled: (name: string) => flags.includes(name) && name !== flag }
    })), error => (error as { code: string }).code === code);
  }
  assert.throws(() => createRuntime(configured({ recordCommandConfig: null })), { code });
  for (const name of ["recordTransactions", "legacyCommits", "initialization", "offlineImportInvalidates"]) {
    const repo = repository();
    repo.recordProjectionCoverage = {
      ...repo.recordProjectionCoverage!,
      [name]: false
    };
    assert.throws(() => createRuntime(configured({ repository: repo })), { code });
  }
  const empty = repository();
  empty.recordProjectionCoverage = {} as NonNullable<ThoughtQueryRepository["recordProjectionCoverage"]>;
  assert.throws(() => createRuntime(configured({ repository: empty })), { code });
  const missingTransactions = repository();
  delete missingTransactions.accountUnitOfWork;
  assert.throws(() => createRuntime(configured({ repository: missingTransactions })), { code });
  const missingRebuild = repository();
  delete missingRebuild.rebuildRecordProjection;
  assert.throws(() => createRuntime(configured({ repository: missingRebuild })), { code });
  assert.throws(() => createQueries(repository()).list({}), { code });
  const complete = createRuntime(configured());
  await assert.rejects(complete.thoughtQueries.list({}), /Prepared query reached SQL/u);
  const actual = bindings(complete);
  const required = complete.thoughtQueries.assertProducersReady(actual) as Record<string, string[]>;
  for (const family of Object.keys(actual) as Array<keyof typeof actual>) {
    const commands = actual[family] as Record<string, unknown>;
    for (const name of required[family]) {
      assert.throws(() => complete.thoughtQueries.assertProducersReady({
        ...actual, [family]: { ...commands, [name]: null }
      }), { code }, `${family}.${name}`);
      assert.throws(() => complete.thoughtQueries.list({}), { code });
    }
  }
  const compatible = createRuntime(configured({
    thoughtPagingConfig: { enabled: false },
    recordCommandConfig: null
  }));
  assert.equal(compatible.thoughtService.recordProducerCommands, null);
  console.log("Thought producer gate passed: missing flags, partial/empty maintenance coverage and missing actual commands rejected; complete runtime prepares queries; paging-off compatibility retained.");
}
