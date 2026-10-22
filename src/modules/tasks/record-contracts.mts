/**
 * 任务状态命令与通知协作的输入服务契约。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { RecordEntity, AccountUnitOfWork } from "../../shared/persistence/record-command-types.mjs";
export interface TaskWork {
  inputVersion?: number;
  subtargetVersion?: number;
  inputHash?: string;
  alreadyAnswered?: boolean;
  [key: string]: unknown;
}
export interface NotificationServices {
  read(items: RecordEntity[], id: string): RecordEntity | null;
  readAll(items: RecordEntity[]): number;
  upsertTask(items: RecordEntity[], task: RecordEntity, status: string, message?: string): RecordEntity;
}
export interface TaskCommandServices {
  tasks: { complete(task: RecordEntity, status: string, details: { resultId?: string; error?: string; errorCode?: string }): void };
  notifications: NotificationServices;
}
export type TaskCommandDependencies = TaskCommandServices & {
  unitOfWork: AccountUnitOfWork;
  waitingStatus: string;
};
