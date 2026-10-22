/**
 * 文本生成的总截止、首次终止原因与全局/账户在途准入。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：准入覆盖清理结束；取消不抛弃不可中断的持久化；各次重试共用同一总截止。
 */
import { performance } from "node:perf_hooks";
type QueueConfig = { enabled: boolean; maxOutstanding: number; maxOutstandingPerAccount: number; maxQueueWaitMs: number; overloadRetryAfterMs: number };
/** 创建首次原因固定的执行控制，清理工作可在截止后继续完成。
 * @since unreleased
 */
export function createExecutionControl({ signal, timeoutMs }: { signal?: AbortSignal | null; timeoutMs: number }) {
  const controller = new AbortController();
  const totalDeadline = performance.now() + timeoutMs;
  let reason: Error | null = null;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = (code: string) => {
    if (reason) return;
    const messages: Record<string, string> = { AI_TASK_CANCELLED: "AI任务已取消", AI_REQUEST_TIMEOUT: "AI请求总时限已到，已停止", AI_QUEUE_TIMEOUT: "AI排队等待超时" };
    reason = Object.assign(new Error(messages[code] || code), { code, statusCode: code === "AI_TASK_CANCELLED" ? 409 : 504, cancelled: code === "AI_TASK_CANCELLED" });
    controller.abort(reason);
  };
  const abort = () => stop("AI_TASK_CANCELLED");
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("AI_REQUEST_TIMEOUT"), Math.max(0, timeoutMs));
  return Object.freeze({
    signal: controller.signal, totalDeadline,
    throwIfStopped() { if (!reason && performance.now() >= totalDeadline) stop("AI_REQUEST_TIMEOUT"); if (reason) throw reason; },
    queueDeadline(waitMs: number) {
      if (queueTimer) clearTimeout(queueTimer);
      const deadline = Math.min(totalDeadline, performance.now() + waitMs);
      queueTimer = setTimeout(() => stop(deadline >= totalDeadline ? "AI_REQUEST_TIMEOUT" : "AI_QUEUE_TIMEOUT"), Math.max(0, deadline - performance.now()));
      return deadline;
    },
    endQueue() { if (queueTimer) clearTimeout(queueTimer); queueTimer = null; },
    expireQueue(deadline: number) { stop(deadline >= totalDeadline ? "AI_REQUEST_TIMEOUT" : "AI_QUEUE_TIMEOUT"); },
    // 普通失败也在确定不再重试时锁为首因；后续清理的timeout/abort不能改写429/409。
    terminate(error: unknown) {
      if (!reason) { reason = error instanceof Error ? error : new Error(String(error)); controller.abort(reason); }
    },
    get reason() { return reason; },
    dispose() { clearTimeout(timer); if (queueTimer) clearTimeout(queueTimer); signal?.removeEventListener("abort", abort); }
  });
}
/** 在任何预算分配前同步申请在途名额；归还幂等，账户归零即删除。
 * @since unreleased
 */
export function createAiAdmission(config: QueueConfig) {
  let total = 0; const accounts = new Map<string, number>();
  return (accountId: string) => {
    if (!config.enabled) return () => {};
    if (total >= config.maxOutstanding || (accounts.get(accountId) || 0) >= config.maxOutstandingPerAccount) throw Object.assign(new Error("AI队列繁忙，请稍后重试"), { code: "AI_QUEUE_FULL", statusCode: 429, retryAfterMs: config.overloadRetryAfterMs });
    total++; accounts.set(accountId, (accounts.get(accountId) || 0) + 1); let released = false;
    return () => { if (released) return; released = true; total--; const left = (accounts.get(accountId) || 1) - 1; if (left) accounts.set(accountId, left); else accounts.delete(accountId); };
  };
}
