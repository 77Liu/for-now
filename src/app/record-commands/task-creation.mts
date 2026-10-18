/**
 * 思绪、追问、批注与图片任务的入队及重试短事务。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：上下文只读快照由修订号绑定；只新增任务、通知及其关系和同步差分。
 */
import type {
  AccountUnitOfWork, ObjectRow, RecordEntity, RecordStore, RecordTransaction, StoreMapping
} from "../../shared/persistence/record-command-types.mjs";
import { recordObjectKey } from "../../shared/persistence/record-command-types.mjs";
import { createThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import { addThoughtClosureChanges } from "../../modules/thoughts/local-changes.mjs";
import { supportsRecordTask } from "./task-transitions.mjs";

type Result = { task?: RecordEntity; duplicate?: boolean; [key: string]: unknown };
type Request = { scope: string; key: string; requestHash: string };
type Input = {
  input: { kind?: string; [key: string]: unknown };
  retryOf?: string;
  snapshot: RecordStore;
  expectedRevision: string;
  idempotency: Request | null;
  mutate(store: RecordStore): Result;
};
const ownerCollections: Record<string, string> = {
  thought: "thoughts", capture: "captures", journal: "journals", chat: "chats",
  analysis: "analyses", book: "books", quote: "quotes"
};
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
function preparation(input: Input) {
  const source = Object.fromEntries(Object.entries(input.snapshot)
    .filter(([field]) => !["aiTasks", "notifications"].includes(field)));
  const context = structuredClone(source);
  freeze(context);
  const previous = input.retryOf
    ? structuredClone(input.snapshot.aiTasks.filter(task => task.id === input.retryOf)) : [];
  freeze(previous);
  return Object.freeze({
    ...context,
    aiTasks: [...previous],
    notifications: []
  }) as RecordStore;
}
async function findExisting(ports: RecordTransaction, input: Input) {
  const source = input.retryOf
    ? await ports.objects.find(recordObjectKey("aiTasks", input.retryOf), { lock: true }) : null;
  if (input.retryOf && (!source || !["failed", "stale"].includes(source.status))) {
    return { result: { missing: true } };
  }
  const retried = input.retryOf ? await ports.objects.findTaskRequest("retryOf", input.retryOf) : null;
  if (retried) return { result: { task: retried.payload as RecordEntity, duplicate: true } };
  const duplicate = input.idempotency
    ? await ports.objects.findTaskRequest("clientRequestId", input.idempotency.key) : null;
  if (duplicate) return { result: duplicate.payload.requestHash === input.idempotency?.requestHash
    ? { task: duplicate.payload as RecordEntity, duplicate: true } : { conflict: true } };
  return { source };
}

/** 复用任务纯状态机；新记录映射只加载目标树和本次重试来源。 @since unreleased */
export function createTaskCreationCommands({
  unitOfWork, mapping, now = () => new Date().toISOString()
}: { unitOfWork: AccountUnitOfWork; mapping: StoreMapping; now?: () => string }) {
  const graph = createThoughtRecordRepository(mapping);
  async function persist(ports: RecordTransaction, source: ObjectRow | null, task: RecordEntity, notifications: RecordEntity[]) {
    const collection = ownerCollections[String(task.resourceType)];
    if (!collection) throw new TypeError("Task creation target collection is unsupported");
    const thought = collection === "thoughts"
      ? await graph.readThoughtTargetClosure(ports, String(task.targetId)) : null;
    const targetRows = collection === "thoughts" ? thought?.rows || []
      : await ports.objects.findTree([recordObjectKey(collection, String(task.targetId))], { lock: true });
    const rows = [...targetRows, ...(source ? [source] : [])];
    const store = graph.rebuildRecordCollections(rows, [collection, "aiTasks", "notifications"]);
    store.aiTasks.push(task);
    store.notifications.push(...notifications);
    const after = await graph.persistMappedClosure(ports, ports.accountId, rows, store, {
      managedCollections: ["aiTasks", "notifications"]
    });
    addThoughtClosureChanges(ports, source ? [source] : [], after, "");
  }
  async function create(input: Input) {
    if (!supportsRecordTask(input.input)) throw new TypeError("Task creation kind is unsupported");
    const context = preparation(input);
    try {
      const committed = await unitOfWork.run({
        commandId: input.retryOf ? "task.retry" : "task.enqueue",
        expectedRevision: input.expectedRevision,
        idempotency: input.idempotency ? {
          ...input.idempotency,
          expiresAt: new Date(Date.parse(now()) + 90 * 86400000).toISOString()
        } : null
      }, async ports => {
        const existing = await findExisting(ports, input);
        if (existing.result) {
          if (!existing.result.task) throw Object.assign(new Error("Task creation rejected"), { taskResult: existing.result });
          return existing.result;
        }
        const previous = new Set(context.aiTasks.map(task => task.id));
        const result = input.mutate(context);
        if (!result.task) throw Object.assign(new Error("Task creation rejected"), { taskResult: result });
        const added = context.aiTasks.filter(task => !previous.has(task.id));
        if (result.duplicate || added.length !== 1 || added[0] !== result.task
          || context.aiTasks.length !== previous.size + 1
          || context.notifications.length !== 1 || context.notifications[0].taskId !== result.task.id) {
          throw new TypeError("Task creation must add exactly one task and its notification");
        }
        await persist(ports, existing.source || null, result.task, context.notifications);
        return result;
      });
      return committed.replayed ? { ...committed.value, duplicate: true } : committed.value;
    } catch (error) {
      const rejected = error as { code?: string; taskResult?: Result };
      if (rejected.taskResult) return rejected.taskResult;
      if (rejected.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
      throw error;
    }
  }
  return Object.freeze({
    supports: supportsRecordTask,
    prepareSnapshot(snapshot: RecordStore): RecordStore {
      const context = structuredClone(snapshot);
      freeze(context);
      return context;
    },
    create
  });
}
