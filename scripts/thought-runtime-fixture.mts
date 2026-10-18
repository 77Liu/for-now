/**
 * 思绪验收共用正式内容运行时，替代人工拼装生产者。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户；供应商与媒体均为拒调用端口。
 */
import crypto from "node:crypto";

type Runtime = {
  thoughtQueries: unknown;
  thoughtService: Record<string, unknown>;
  thoughtRecordCommands: unknown;
  contentAttachmentService: unknown;
  annotationCommands: unknown;
  trashCommands: unknown;
  backgroundAi: {
    recordProducerCommand(name: string): unknown;
    schedule(taskId: string): void;
    cancel(taskId: string): boolean;
    enqueue(input: Record<string, unknown>): Promise<{ task?: Record<string, unknown>; duplicate?: boolean; [key: string]: unknown }>;
    retry(taskId: string): Promise<{ task?: Record<string, unknown>; duplicate?: boolean; [key: string]: unknown }>;
  };
};
type Factory = (options: Record<string, unknown>) => Runtime;

/** 提供真正运行时的可复用夹具；不在测试中伪造 coverage=true。 @since unreleased */
export function createThoughtRuntimeFixture(
  createRuntime: Factory, repository: unknown, accountId: string, overrides: Record<string, unknown> = {}
) {
  const scheduledTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const runtime = createRuntime({
    repository,
    getAccountId: () => accountId,
    backgroundContextKey: () => accountId,
    workflowContextKey: () => accountId,
    dispatchBackground: () => {},
    runDeepSeek: async () => { throw new Error("Producer fixture must not invoke a provider"); },
    today: () => "2026-10-19",
    now: () => "2026-10-19T00:00:00.000Z",
    createId: () => crypto.randomUUID(),
    hash: (value: string) => crypto.createHash("sha256").update(value).digest("hex"),
    logEvent: () => {},
    trashRetentionDays: 30,
    thoughtPagingConfig: { enabled: true },
    recordCommandConfig: { enabled: (name: string) => [
      "thought.create", "thought.update", "thought.delete", "thought.aiWriteback", "task.status"
    ].includes(name) },
    mediaFactory: () => ({
      attachmentCleanup: {},
      listAttachmentInventory: () => { throw new Error("Producer fixture must not enumerate inventory"); },
      materializeAttachmentFiles: () => { throw new Error("Producer fixture must not read media"); }
    }),
    ...overrides
  });
  runtime.backgroundAi.schedule = taskId => scheduledTaskIds.push(taskId);
  runtime.backgroundAi.cancel = taskId => {
    cancelledTaskIds.push(taskId);
    return true;
  };
  return {
    ...runtime.thoughtService,
    queries: runtime.thoughtQueries,
    rootCommands: runtime.thoughtRecordCommands,
    annotationCommands: runtime.annotationCommands,
    trashCommands: runtime.trashCommands,
    attachments: runtime.contentAttachmentService,
    contentAi: runtime.backgroundAi.recordProducerCommand("content.aiWriteback"),
    backgroundAi: runtime.backgroundAi,
    thoughtService: runtime.thoughtService,
    producerRepository: repository,
    scheduledTaskIds,
    cancelledTaskIds
  };
}
