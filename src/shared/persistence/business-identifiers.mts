/**
 * 完整账户文档事务内的新业务身份分配。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：账户锁由仓储持有；历史身份仅占用、不迁移，随机耗尽不得提交。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { BUSINESS_ID_ATTEMPTS, BUSINESS_ID_BYTES, encodeBusinessId, isBusinessId } from "../business-identifiers/index.mjs";

interface RequestContext {
  user?: { id?: string };
  clientProvisionalId?: string;
  clientOperationId?: string;
  businessIdMapping?: { accountId: string; operationId: string; provisionalId: string; canonicalId: string };
}

/** 将创建结果的映射绑定到账户回执；仅处理明确携带临时身份的请求。 @since unreleased */
export function bindBusinessIdResponse<T>(response: T, context: RequestContext): T {
  if (!context.clientProvisionalId || !response || typeof response !== "object") return response;
  const row = response as Record<string, unknown>;
  const saved = row.businessIdMapping as RequestContext["businessIdMapping"];
  if (saved) {
    if (saved.accountId !== (context.user?.id || "local") || saved.provisionalId !== context.clientProvisionalId
      || saved.operationId !== context.clientOperationId) {
      throw Object.assign(new Error("同一幂等操作不能更换临时身份"), { code: "PROVISIONAL_ID_REUSED", statusCode: 409 });
    }
    context.businessIdMapping = saved;
    return response;
  }
  const value = (row.value || (Array.isArray(row.items)
    ? row.items.find(item => item?.type === "question") : undefined)) as { id?: unknown } | undefined;
  if (!isBusinessId(value?.id)) return response;
  const mapping = { accountId: context.user?.id || "local", operationId: context.clientOperationId || "", provisionalId: context.clientProvisionalId, canonicalId: value.id };
  context.businessIdMapping = mapping;
  return { ...response, businessIdMapping: mapping };
}

interface AllocationScope {
  occupied: Set<string>;
  allocated: Set<string>;
  document: unknown;
  random: (size: number) => Uint8Array;
}
const scopes = new AsyncLocalStorage<AllocationScope>();

function collectIds(value: unknown, result = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const child of value) collectIds(child, result);
    return result;
  }
  const row = value as Record<string, unknown>;
  // 回收站 payload、所有层级子项以及生命周期 tombstone 都参与占用检查。
  for (const key of ["id", "resourceId", "recordId"]) {
    if (typeof row[key] === "string" && row[key]) result.add(row[key]);
  }
  for (const child of Object.values(row)) collectIds(child, result);
  return result;
}

/** 在已锁定的完整账户文档上建立异步分配作用域；不自行提交或持有仓储锁。 @since unreleased */
export function withBusinessIdTransaction<T>(
  document: unknown,
  operation: () => T,
  random: (size: number) => Uint8Array = randomBytes
): T {
  return scopes.run({ document, occupied: collectIds(document), allocated: new Set(), random }, operation);
}

/** 创建账户内未占用的业务身份；最多尝试 8 次，失败抛出可重试错误。 @since unreleased */
export function createBusinessId(): string {
  const scope = scopes.getStore();
  if (!scope) {
    throw Object.assign(new Error("业务身份只能在账户事务内创建"), { code: "BUSINESS_ID_TRANSACTION_REQUIRED" });
  }
  // 同一事务内可能导入/还原对象；每次分配也检查当前文档。
  collectIds(scope.document, scope.occupied);
  for (let attempt = 0; attempt < BUSINESS_ID_ATTEMPTS; attempt += 1) {
    const id = encodeBusinessId(scope.random(BUSINESS_ID_BYTES));
    if (scope.occupied.has(id) || scope.allocated.has(id)) continue;
    scope.allocated.add(id);
    return id;
  }
  throw Object.assign(new Error("业务身份分配暂时失败，请重试"), {
    code: "BUSINESS_ID_COLLISION_EXHAUSTED", statusCode: 503
  });
}
