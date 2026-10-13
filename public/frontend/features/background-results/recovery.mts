/**
 * 职责：按任务结果身份限制自动重试、区分永久失效与临时同步失败。
 * 边界：仅当前账户会话，切换账户清空；显式重试开启新周期。
 * 建立日期：2026-10-13；状态：active。
 */
type SyncError = { status?: number; code?: string };
type Failure = { attempts: number; terminal: boolean };
const AUTOMATIC_ATTEMPT_LIMIT = 3;

/** 结果接口明确不存在时停止自动请求，不推断原文是否还在。 @since unreleased */
export function isUnavailableResult(error: SyncError | null): boolean {
  return error?.status === 404 || error?.status === 410
    || error?.code === "TASK_RESULT_UNAVAILABLE";
}

/** 创建当前账户会话的恢复账；手动重试和退出账户由调用方显式清除。 @since unreleased */
export function createResultRecovery() {
  const failures = new Map<string, Failure>();
  return {
    canAttempt(key: string): boolean {
      const failure = failures.get(key);
      return !failure || (!failure.terminal && failure.attempts < AUTOMATIC_ATTEMPT_LIMIT);
    },
    fail(key: string, error: SyncError): boolean {
      const previous = failures.get(key);
      failures.set(key, {
        attempts: (previous?.attempts || 0) + 1,
        terminal: isUnavailableResult(error)
      });
      return !previous;
    },
    forget(key: string): void {
      failures.delete(key);
    },
    forgetTask(taskId: string): void {
      for (const key of failures.keys()) {
        if (key.startsWith(`${taskId}:`)) failures.delete(key);
      }
    },
    needsRetry(): boolean {
      return [...failures.values()].some(value => !value.terminal
        && value.attempts < AUTOMATIC_ATTEMPT_LIMIT);
    },
    reset(): void {
      failures.clear();
    }
  };
}
