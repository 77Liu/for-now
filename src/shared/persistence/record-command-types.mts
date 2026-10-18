/**
 * 首批记录命令的持久化实体与映射边界类型。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：账户短事务内的精确记录闭包；不执行供应商调用或全账户读写。
 */
import type { ObjectRow, AccountUnitOfWork, RecordTransaction } from "./account-unit-of-work.mjs";
export type { ObjectRow, AccountUnitOfWork, RecordTransaction };
export type CommandError = { code?: string; message?: string };
export const AFTER_COMMIT = Symbol.for("for-now.after-commit");
export interface RecordEntity extends Record<string, unknown> {
  id: string;
  type?: string;
  kind?: string;
  status?: string;
  version?: number;
  content?: string;
  message?: string;
  authorType?: string;
  createdAt?: string;
  updatedAt?: string;
  occurredAt?: string;
  occurredOn?: string;
  relatedTo?: string | null;
  taskId?: string;
  targetId?: string;
  subtargetId?: string;
  internal?: boolean;
  readAt?: string;
  resultId?: string;
  error?: string;
  errorCode?: string;
  inputVersion?: number;
  subtargetVersion?: number;
  inputHash?: string;
  requestedInputVersion?: number;
  requestedSubtargetVersion?: number;
  requestedInputHash?: string;
  deferredInputBinding?: boolean;
  sourceRef?: { type: string; id: string; version?: number };
  [AFTER_COMMIT]?: () => void;
}
export type EntityRow = Omit<ObjectRow, "payload"> & { payload: RecordEntity };
export type RecordStore = Record<string, RecordEntity[]>;
export type Mapping = {
  objects: EntityRow[];
  relations: Parameters<RecordTransaction["relations"]["insert"]>[0][];
  attachmentRefs: Parameters<RecordTransaction["attachments"]["insert"]>[0][];
};
export type StoreMapping = {
  canonicalJson(value: unknown): string;
  mapStoreObjects(accountId: string, store: RecordStore): Mapping;
  rebuildStoreObjects(value: {
    fields: { field: string; shape: string; payload: null }[];
    objects: ObjectRow[];
  }): RecordStore;
};
/** Validates a row identity before exposing its lossless payload to domain commands. @since unreleased */
export function entityRow(row: ObjectRow): EntityRow {
  if (row.payload.id !== row.id || typeof row.payload.id !== "string") {
    throw Object.assign(new Error("记录身份异常，原数据已保留"), {
      code: "ACCOUNT_DATA_INVALID", statusCode: 503
    });
  }
  return row as EntityRow;
}
export const recordObjectKey = (collection: string, id: string) => JSON.stringify([collection, id]);
