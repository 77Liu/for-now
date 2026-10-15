/**
 * 账户与存储作用域内的提交提示订阅，保留读取期间的通知代数。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：提示不可靠且不含正文；持久游标是事实源，等待不占用数据库连接。
 */
import { performance } from "node:perf_hooks";
type Scope = { accountId: string; storageScope: string };
type Entry = { scope: Scope; generation: number; subscriptions: Set<Subscription> };
type Subscription = { finish: ((reason: "changed" | Error) => void) | null; close: (error?: Error) => void };
const failure = (code: string, statusCode: number) => Object.assign(new Error("同步等待已结束"), { code, statusCode });

/**
 * 创建当前应用实例的非持久提交提示端口；存储作用域必须来自受信仓储，不接受客户端指定。
 * 丢失提示由等待截止后的持久读取补偿，stop终止并释放所有在途订阅。
 * @since unreleased
 */
export function createAccountCommitNotifier() {
  const entries = new Map<string, Entry>();
  let stopped: Error | null = null;
  const notify = (entry: Entry) => {
    entry.generation += 1;
    for (const subscription of entry.subscriptions) subscription.finish?.("changed");
  };
  return Object.freeze({
    /** 先订阅再读游标；每次等待消费调用方读取前捕获的generation，防止查询期间丢唤醒。 @since unreleased */
    subscribeAccountCommits(scope: Scope) {
      if (stopped) throw stopped;
      if (!scope.accountId || !scope.storageScope) throw new TypeError("Sync subscription requires account and storage scope");
      const key = JSON.stringify([scope.accountId, scope.storageScope]);
      let entry = entries.get(key);
      if (!entry) { entry = { scope: { ...scope }, generation: 0, subscriptions: new Set() }; entries.set(key, entry); }
      const current = entry;
      let closed: Error | null = null;
      const subscription: Subscription = {
        finish: null,
        close(error = failure("SYNC_WAIT_CLOSED", 499)) {
          if (closed) return;
          closed = error; subscription.finish?.(error); current.subscriptions.delete(subscription);
          if (!current.subscriptions.size) entries.delete(key);
        }
      };
      current.subscriptions.add(subscription);
      return Object.freeze({
        generation: () => current.generation,
        /** deadline是本进程单调毫秒绝对值；取消/关闭清除timer与signal监听。 @since unreleased */
        waitForChange(observed: number, deadline: number, signal?: AbortSignal): Promise<"changed" | "timeout"> {
          if (closed || stopped) return Promise.reject(closed || stopped);
          if (signal?.aborted) return Promise.reject(failure("SYNC_WAIT_ABORTED", 499));
          if (current.generation !== observed) return Promise.resolve("changed");
          const remaining = deadline - performance.now();
          if (remaining <= 0) return Promise.resolve("timeout");
          if (subscription.finish) return Promise.reject(new Error("Sync subscription already waiting"));
          return new Promise((resolve, reject) => {
            const finish = (reason: "changed" | "timeout" | Error) => {
              if (!subscription.finish) return;
              subscription.finish = null; clearTimeout(timer); signal?.removeEventListener("abort", abort);
              if (reason instanceof Error) reject(reason); else resolve(reason);
            };
            const abort = () => finish(failure("SYNC_WAIT_ABORTED", 499));
            const timer = setTimeout(() => finish("timeout"), remaining);
            subscription.finish = finish; signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        },
        close: subscription.close
      });
    },
    /** 仅在真实持久提交后发送；没有订阅时无需保存提示或游标。 @since unreleased */
    notifyAccountCommitted(scope: Scope) { const entry = entries.get(JSON.stringify([scope.accountId, scope.storageScope])); if (entry) notify(entry); },
    /** 权限或运行资格变化只触发重新鉴权，不将提示当作已提交数据。 @since unreleased */
    invalidateAccount(accountId: string) { for (const entry of entries.values()) if (entry.scope.accountId === accountId) notify(entry); },
    /** 排空不再允许新订阅；等待者结束不撤销任何已提交事实。 @since unreleased */
    stop() { stopped ||= failure("ACCOUNT_DEPENDENCIES_UNAVAILABLE", 503); for (const entry of entries.values()) for (const subscription of [...entry.subscriptions]) subscription.close(stopped); },
    /** 在每次异步读取后复验当前实例仍接受同步，防止排空期间返回迟到结果。 @since unreleased */
    assertActive() { if (stopped) throw stopped; },
    /** 当前在途订阅数，用于确认断连/排空后的资源回收，不含账户标识。 @since unreleased */
    activeSubscriptions() { return [...entries.values()].reduce((total, entry) => total + entry.subscriptions.size, 0); }
  });
}
