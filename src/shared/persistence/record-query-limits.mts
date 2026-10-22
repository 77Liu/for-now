/**
 * 记录闭包与 SQL 参数批量的共同边界。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：限制单次必要闭包，不限制账户历史总量。
 */
export const RECORD_QUERY_LIMITS = Object.freeze({
  keyBatch: 500,
  closureRows: 5000
});

/** 将必要身份分批查询，避免把 SQL 参数批量误作业务闭包上限。 @since unreleased */
export function recordKeyBatches(keys: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < keys.length; offset += RECORD_QUERY_LIMITS.keyBatch) {
    batches.push(keys.slice(offset, offset + RECORD_QUERY_LIMITS.keyBatch));
  }
  return batches;
}
