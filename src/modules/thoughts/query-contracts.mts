/**
 * 思绪索引查询、游标与当前状态投影的类型契约。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：账户来自受信事务，不接受请求自报账户；列表不承载完整正文。
 * @partial 阶段 6 候选接入，尚未宣布完整出口验收。
 * @partialScope 全部生产者逐入口矩阵和真实浏览器消费者验收待完成；基础 PG 查询与事务证据另见正式回执。
 * @partialVersion v0.5.16 阶段 6 未发布候选。
 * @partialReason 当前切片仅完成已记录的局部及 PostgreSQL 验证。
 * @partialAuthorization Owner 2026-10-19「继续持续推进开发」。
 * @partialUsage 默认关闭 THOUGHT_PAGING_ENABLED；仅供隔离验收，不开启生产查询。
 */
import type { ObjectRow } from "../../shared/persistence/account-unit-of-work.mjs";
import type { RecordEntity, StoreMapping } from "../../shared/persistence/record-command-types.mjs";
export type SqlClient = {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{
    rows: Row[];
    rowCount: number | null;
  }>;
};
export type ProjectionContext = { client: SqlClient; accountId: string };
export type ThoughtProjection = {
  provisionedVersion(rows: ObjectRow[]): number;
  initialize(context: ProjectionContext): Promise<void>;
  changed(context: ProjectionContext, rows: ObjectRow[]): Promise<void>;
  rebuild(context: ProjectionContext, afterRootId?: string): Promise<{
    afterRootId: string; done: boolean; processed: number;
  }>;
};
export type DiscoveryProjection = {
  sortTime: number;
  status: Record<string, unknown>;
  search: Array<{ type: string; texts: string[] }>;
};
export type SpeechSourceReceipt = {
  sourceType: string; sourceId: string; sourceVersion: number; textHash: string;
};
export type ThoughtQueryDependencies = StoreMapping & {
  speechProjection?: (thoughts: RecordEntity[]) => SpeechSourceReceipt[];
  discoveryProjection?: (thoughts: RecordEntity[]) => DiscoveryProjection | null;
  summary(root: RecordEntity, blocks: RecordEntity[]): Record<string, unknown>;
  searchText(root: RecordEntity, blocks: RecordEntity[]): string;
  detail(thoughts: RecordEntity[], rootId: string): Record<string, unknown> | null;
};
export type ThoughtPageInput = {
  limit?: number;
  afterId?: string;
  direction?: "next" | "prev";
  query?: string;
  tag?: string;
  sort?: "occurred" | "created";
};
export type ThoughtPageRow = {
  rootId: string;
  primary: string;
  created: string;
  sourceVersion: number;
  rootVersion: number;
  summary: Record<string, unknown>;
};
export type ThoughtCursor = { v: 4; scope: string; primary: string; created: string; id: string };
export const THOUGHT_INDEX_SCHEMA = Object.freeze({ version: 1, searchMode: "normalized_index" });
export const normalizeThoughtSearch = (value: string): string => value.normalize("NFKC")
  .toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
/** 1–3 字符词元保持现有中文/英文子串语义，SQL另做精确匹配。 @since unreleased */
export function thoughtSearchGrams(value: string): string[] {
  const chars = [...normalizeThoughtSearch(value)];
  const result = new Set<string>();
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index + size <= chars.length; index += 1) {
      result.add(chars.slice(index, index + size).join(""));
    }
  }
  return [...result];
}

export type ThoughtDiscoveryInput = {
  query: string; types: string[]; freshOnly: boolean; limit: number;
  includeTotals?: boolean;
  now: number; before: { sortTime: number; key: string } | null;
};
