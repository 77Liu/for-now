/**
 * 思绪命令输入、服务与回收记录契约。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import type { RecordEntity, RecordStore, AccountUnitOfWork, CommandError, SourceMutationEffects } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { TaskCommandServices, TaskWork } from "../tasks/record-contracts.mjs";
export type TrashEntry = RecordEntity & {
  deletedAt: string;
  payload: Record<string, unknown>;
  dependents?: Record<string, unknown>;
};
export interface ThoughtCreateInput {
  questionText: string;
  idea?: string;
  answer?: string;
  modelDraft?: string;
  modelReasoning?: string;
  tags?: string[];
  attachmentPaths?: string[];
  eventTime?: { occurredAt?: string; occurredOn?: string };
  clientRequestId?: string;
  requestHash?: string;
  generateAnswer?: boolean;
  sourceRef?: RecordEntity["sourceRef"];
}
export interface ThoughtInput extends ThoughtCreateInput {
  id: string;
  expectedVersion?: number;
  changesEventTime?: boolean;
  eventTimeInput?: Record<string, unknown>;
  hasIdea?: boolean;
  hasAnswer?: boolean;
  hasAttachmentPaths?: boolean;
}
export type ThoughtResult = {
  [AFTER_COMMIT]?: () => void;
  value?: RecordEntity;
  items?: RecordEntity[];
  duplicate?: boolean;
  task?: RecordEntity | null;
  missing?: boolean;
  versionConflict?: boolean;
  currentVersion?: number;
  [key: string]: unknown;
};
export type ThoughtServices = TaskCommandServices & {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  effects?: SourceMutationEffects | null;
  thoughts: {
    createChainInStore(store: RecordStore, input: ThoughtCreateInput): ThoughtResult;
    updateChainInStore(store: RecordStore, input: ThoughtInput & { removeBlock: ThoughtServices["removeBlock"] }): ThoughtResult;
  };
  removeChain(store: RecordStore, id: string): TrashEntry | null;
  removeBlock(store: RecordStore, id: string): TrashEntry | null;
  createTaskInStore(store: RecordStore, input: {
    kind: string; targetId: string; inputVersion?: number;
    payload: { triggerType: string }; clientRequestId: string;
  }, options: { deferInputBinding: boolean }): { task?: RecordEntity; duplicate?: boolean } | null;
  thoughtTarget: {
    inspect(thoughts: RecordEntity[], task: RecordEntity): TaskWork | null;
    saveAnswer(thoughts: RecordEntity[], work: TaskWork, task: RecordEntity, result: unknown): string;
    saveFollowUp(work: TaskWork, task: RecordEntity, result: unknown): string;
  };
  taskInputMatches(task: RecordEntity, work: TaskWork | null): boolean;
  now?: () => string;
};
export type ThoughtWriteback = { taskId: string; result: unknown; expectedRevision?: string };
export type ThoughtFailure = CommandError | null;

export type SettlementServices = Pick<ThoughtServices, "tasks" | "notifications" | "thoughtTarget" | "repository" | "taskInputMatches">;
