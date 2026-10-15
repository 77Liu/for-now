/**
 * 按QPS和并发发放许可，等待项可独立取消、到期并有界离队。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：仅grant消费QPS；等待终态和许可归还各执行一次，无参调用保留既有语义。
 */
import { performance } from "node:perf_hooks";
type WaitOptions = { signal?: AbortSignal | null; deadline?: number };
type Release = () => void;
type Waiter = { state: "pending" | "granted" | "cancelled" | "expired"; signal?: AbortSignal | null;
  deadline: number; resolve: (release: Release) => void; reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>; abort?: () => void };
const failure = (code: string, statusCode: number) => Object.assign(new Error(code === "AI_TASK_CANCELLED" ? "AI任务已取消" : code === "AI_QUEUE_FULL" ? "AI队列繁忙，请稍后重试" : "AI排队等待超时"), { code, statusCode });
/**
 * 创建兼容无参acquire的速率/并发gate。deadline是本进程performance.now()绝对毫秒。
 * 取消和到期主动移除等待项，不等待现有占用者归还；调用者负责已grant后的再次检查。
 * 新增signal/deadline/maxPending选项：unreleased；既有接口首次发布版本未知。
 */
export function createRateGate(qps: number, concurrency: number, { maxPending = Infinity }: { maxPending?: number } = {}) {
  let active = 0;
  let starts: number[] = [];
  let wake: ReturnType<typeof setTimeout> | null = null;
  const pending: Waiter[] = [];
  const cancelled = (signal?: AbortSignal | null) => /^AI_/.test(signal?.reason?.code || "") ? signal!.reason : failure("AI_TASK_CANCELLED", 409);
  const finish = (waiter: Waiter, state: Waiter["state"]) => {
    if (waiter.state !== "pending") return false;
    waiter.state = state;
    const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    return true;
  };
  const reject = (waiter: Waiter, state: "cancelled" | "expired") => {
    if (!finish(waiter, state)) return;
    waiter.reject(state === "cancelled" ? cancelled(waiter.signal) : failure("AI_QUEUE_TIMEOUT", 504));
    pump();
  };
  const pump = () => {
    if (wake) clearTimeout(wake); wake = null;
    const timestamp = performance.now();
    starts = starts.filter(value => timestamp - value < 1000);
    while (pending.length && active < concurrency && starts.length < qps) {
      const waiter = pending[0];
      if (waiter.signal?.aborted) { reject(waiter, "cancelled"); continue; }
      if (performance.now() >= waiter.deadline) { reject(waiter, "expired"); continue; }
      if (!finish(waiter, "granted")) continue;
      active++; starts.push(performance.now());
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; active--; pump(); });
    }
    if (pending.length && active < concurrency && !wake) {
      wake = setTimeout(pump, Math.max(1, 1000 - (performance.now() - starts[0]))); wake.unref?.();
    }
  };
  return Object.freeze({
    acquire({ signal, deadline = Infinity }: WaitOptions = {}): Promise<Release> {
      if (signal?.aborted) return Promise.reject(cancelled(signal));
      if (performance.now() >= deadline) return Promise.reject(failure("AI_QUEUE_TIMEOUT", 504));
      starts = starts.filter(value => performance.now() - value < 1000);
      if (pending.length >= maxPending && !(active < concurrency && starts.length < qps && !pending.length)) return Promise.reject(failure("AI_QUEUE_FULL", 429));
      return new Promise((resolve, rejectPromise) => {
        const waiter: Waiter = { state: "pending", signal, deadline, resolve, reject: rejectPromise };
        waiter.abort = () => reject(waiter, "cancelled");
        pending.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        if (Number.isFinite(deadline)) waiter.timer = setTimeout(() => reject(waiter, "expired"), Math.max(0, deadline - performance.now()));
        pump();
      });
    }
  });
}
