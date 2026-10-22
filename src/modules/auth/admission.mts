/**
 * 认证尝试的有界准入、失败保护与独立密码计算队列。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：计数仅驻留当前进程；取消计算不提前归还 KDF 许可，未提交请求不得签发会话。
 */
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

/** 启动解析后的认证限额；不携带账户数据。
 * @since unreleased
 */
export type AuthAdmissionConfig = Readonly<{
  globalRatePerSecond: number; globalBurst: number; ipRatePerMinute: number; ipBurst: number;
  accountFailures: number; failureWindowMs: number; kdfConcurrency: number; kdfMaxPending: number;
  kdfQueueTimeoutMs: number; requestTimeoutMs: number; failureDelayMs: number;
  maxCounterKeys: number; counterTtlMs: number;
}>;
type RequestBudget = { signal?: AbortSignal; deadline: number };
type Bucket = { tokens: number; updated: number };
type Counter = { active: number; touched: number; failures: number[]; bucket?: Bucket };
type Waiter = { grant: () => void; reject: (error: Error) => void };
const timeout = () => Object.assign(new Error("认证请求超时，请重新提交"), { statusCode: 503, code: "AUTH_REQUEST_TIMEOUT" });
const limited = (retryAfterMs: number) => Object.assign(new Error("请求较多，请稍后重试"), {
  statusCode: 429, code: "AUTH_RATE_LIMITED", retryAfterMs: Math.max(1, Math.ceil(retryAfterMs))
});

/** 检查单调截止时间与客户端取消；调用方须在写事务中再次检查。
 * @since unreleased
 */
export function assertAuthRequestActive({ signal, deadline }: RequestBudget): void {
  if (signal?.aborted || performance.now() >= deadline) throw timeout();
}

/**
 * 创建进程级认证准入器；参数由应用配置解析，不能以参数缺失绕过容量限制。
 * 返回的尝试必须在 finally 结算；KDF release 必须在密码计算实际完成后调用。
 * @since unreleased
 */
export function createAuthAdmission(config: AuthAdmissionConfig) {
  const counters = new Map<string, Counter>();
  const salt = crypto.randomBytes(32);
  const keyFor = (kind: string, value: string) => crypto.createHmac("sha256", salt).update(`${kind}:${value}`).digest("hex");
  const global: Bucket = { tokens: config.globalBurst, updated: performance.now() };
  const pending: Waiter[] = [];
  let computing = 0;
  const refill = (bucket: Bucket, rate: number, burst: number, now: number) => {
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updated) * rate);
    bucket.updated = now;
  };
  const sweep = (now: number) => {
    for (const [key, counter] of counters) {
      counter.failures = counter.failures.filter(at => now - at < config.failureWindowMs);
      if (counter.bucket) refill(counter.bucket, config.ipRatePerMinute / 60000, config.ipBurst, now);
      if (!counter.active && !counter.failures.length && (!counter.bucket || counter.bucket.tokens >= config.ipBurst)
        && now - counter.touched >= config.counterTtlMs) counters.delete(key);
    }
  };
  const pump = () => {
    while (computing < config.kdfConcurrency && pending.length) pending.shift()!.grant();
  };
  const releasePermit = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      computing -= 1;
      pump();
    };
  };
  return Object.freeze({
    /** 预占来源、全局速率与账户失败名额；失败确认和结算各自幂等。
 * @since unreleased
 */
    reserve(source: string, account: string, signal?: AbortSignal) {
      const now = performance.now();
      const budget: RequestBudget = { signal, deadline: now + config.requestTimeoutMs };
      assertAuthRequestActive(budget);
      sweep(now);
      const sourceKey = keyFor("source", source || "unknown");
      const accountKey = keyFor("account", account);
      const missing = Number(!counters.has(sourceKey)) + Number(!counters.has(accountKey));
      if (counters.size + missing > config.maxCounterKeys) throw limited(config.counterTtlMs);
      const sourceCounter = counters.get(sourceKey) || { active: 0, touched: now, failures: [], bucket: { tokens: config.ipBurst, updated: now } };
      const accountCounter = counters.get(accountKey) || { active: 0, touched: now, failures: [] };
      refill(global, config.globalRatePerSecond / 1000, config.globalBurst, now);
      refill(sourceCounter.bucket!, config.ipRatePerMinute / 60000, config.ipBurst, now);
      if (global.tokens < 1) throw limited((1 - global.tokens) * 1000 / config.globalRatePerSecond);
      if (sourceCounter.bucket!.tokens < 1) throw limited((1 - sourceCounter.bucket!.tokens) * 60000 / config.ipRatePerMinute);
      if (accountCounter.failures.length + accountCounter.active >= config.accountFailures) {
        throw limited(accountCounter.failures.length ? config.failureWindowMs - (now - accountCounter.failures[0]) : config.requestTimeoutMs);
      }
      global.tokens -= 1;
      sourceCounter.bucket!.tokens -= 1;
      sourceCounter.active += 1;
      accountCounter.active += 1;
      sourceCounter.touched = accountCounter.touched = now;
      counters.set(sourceKey, sourceCounter);
      counters.set(accountKey, accountCounter);
      let settled = false, failed = false;
      return Object.freeze({
        ...budget,
        confirmFailure() {
          if (settled || failed) return;
          failed = true;
          accountCounter.failures.push(performance.now());
          // 已确认失败占正式额度，不再重复占用在途失败名额。
          accountCounter.active -= 1;
        },
        settle() {
          if (settled) return;
          settled = true;
          sourceCounter.active -= 1;
          if (!failed) accountCounter.active -= 1;
          sourceCounter.touched = accountCounter.touched = performance.now();
        }
      });
    },
    /** 等待计算许可；取消仅移除等待者，运行中的许可由实际计算 finally 释放。
 * @since unreleased
 */
    async acquireKdf(budget: RequestBudget): Promise<() => void> {
      assertAuthRequestActive(budget);
      if (computing < config.kdfConcurrency && !pending.length) {
        computing += 1;
        return releasePermit();
      }
      if (pending.length >= config.kdfMaxPending) throw limited(config.kdfQueueTimeoutMs);
      const queueDeadline = Math.min(budget.deadline, performance.now() + config.kdfQueueTimeoutMs);
      const queueExpiry = () => queueDeadline === budget.deadline || performance.now() >= budget.deadline
        ? timeout() : limited(config.kdfQueueTimeoutMs);
      return new Promise((resolve, reject) => {
        let done = false;
        const cleanup = () => {
          clearTimeout(timer);
          budget.signal?.removeEventListener("abort", abort);
        };
        const waiter: Waiter = {
          grant() {
            if (done) return;
            try { assertAuthRequestActive(budget); } catch (error) { waiter.reject(error as Error); return; }
            if (performance.now() >= queueDeadline) { waiter.reject(queueExpiry()); return; }
            done = true;
            cleanup();
            computing += 1;
            resolve(releasePermit());
          },
          reject(error) {
            if (done) return;
            done = true;
            cleanup();
            const index = pending.indexOf(waiter);
            if (index >= 0) pending.splice(index, 1);
            reject(error);
          }
        };
        const abort = () => waiter.reject(timeout());
        const timer = setTimeout(() => waiter.reject(queueExpiry()), Math.max(0, Math.ceil(queueDeadline - performance.now())));
        pending.push(waiter);
        budget.signal?.addEventListener("abort", abort, { once: true });
        if (budget.signal?.aborted) abort();
      });
    },
    /** 失败延时不占计算许可或仓储锁；结束后仍检查总预算。
 * @since unreleased
 */
    async delayFailure(budget: RequestBudget): Promise<void> {
      assertAuthRequestActive(budget);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); budget.signal?.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(timeout()); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(config.failureDelayMs, budget.deadline - performance.now()));
        budget.signal?.addEventListener("abort", abort, { once: true });
        if (budget.signal?.aborted) abort();
      });
      assertAuthRequestActive(budget);
    },
    /** 仅提供无身份维度的容量计数，供运行观测及既有专项使用。
 * @since unreleased
 */
    statistics() { return { computing, pending: pending.length, counterKeys: counters.size }; }
  });
}
