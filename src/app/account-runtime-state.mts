/**
 * 当前进程的账户恢复状态、运行资格、受控重试与受限任务收尾能力。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：注册表不保存用户正文；恢复和清理能力仅在内部异步作用域有效，不能由请求参数开启。
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

type Status = "unknown" | "recovering" | "ready" | "quarantined";
type State = { accountId: string; bootId: string; epoch: number; status: Status; phase: string;
  attemptId: string | null; startedAt: string | null; finishedAt: string | null; reasonCode: string | null;
  retryAfter: string | null };
type Token = { bootId: string; accountId: string; epoch: number };
type Config = { enabled: boolean; concurrency: number; accountDeadlineMs: number; retryCooldownMs: number };
type Context = { user?: { id?: string }; accountRunToken?: Token };
type Scope = { token: Token; mode: "recovery" | "provision" | "cleanup"; operationId?: string; attempt?: number; allowCreate?: boolean; usageEntry?: Record<string, unknown> };
type Failure = Error & { recoveryScope?: string; accountId?: string; reasonCode?: string; code?: string };
const problem = (code: string, statusCode = 503, details?: object) => Object.assign(
  new Error("账户数据暂不可用，请稍后重试"), { code, statusCode, ...(details ? { details } : {}) }
);

/**
 * 创建账户资格唯一入口。请求和后台任务捕获的 token 绑定启动及 epoch，提交前必须重新检查。
 * @since unreleased
 */
export function createAccountRuntimeState({ config, getContext, defaultAccount = "local", getAccountKey, onTransition = () => {}, onDispatchError = () => {}, onUnavailable = () => {} }: {
  config: Config; getContext: () => Context | undefined; defaultAccount?: string; getAccountKey?: () => string;
  onTransition?: (state: State) => void; onDispatchError?: (error: unknown) => void; onUnavailable?: () => void;
}) {
  const bootId = crypto.randomBytes(8).toString("hex");
  const states = new Map<string, State>();
  const tokens = new WeakSet<Token>();
  const scope = new AsyncLocalStorage<Scope>();
  const deferred = new Map<string, Array<() => void>>();
  const flights = new Map<string, { expectedEpoch: number; promise: Promise<void> }>();
  const pending: Array<() => void> = [];
  const controllers = new Set<AbortController>();
  const operations = new Map<string, number>();
  const operationCompletions = new Set<Promise<unknown>>();
  const auditCalls = new Map<string, string>();
  const globalFailureListeners = new Set<(error: unknown) => void>();
  let workers = 0, scanComplete = !config.enabled, dependenciesHealthy = true, failed = false;
  const accountId = () => getAccountKey ? getAccountKey() : String(getContext()?.user?.id || defaultAccount);
  const publish = (state: State) => { onTransition({ ...state }); };
  const register = (id: string) => {
    if (!states.has(id)) states.set(id, { accountId: id, bootId, epoch: 0, status: "unknown", phase: "idle",
      attemptId: null, startedAt: null, finishedAt: null, reasonCode: null, retryAfter: null });
    return states.get(id)!;
  };
  const mint = (id: string, epoch: number) => {
    const token = Object.freeze({ bootId, accountId: id, epoch }); tokens.add(token); return token;
  };
  const failGlobal = (error?: unknown) => {
    const first = !failed; failed = true; dependenciesHealthy = false; deferred.clear(); onUnavailable();
    if (first && error && config.enabled) for (const listener of globalFailureListeners) listener(error);
  };
  const currentScope = () => {
    const current = scope.getStore();
    return current?.token.accountId === accountId() ? current : undefined;
  };
  const assertReady = (id: string, token?: Token): Token | null => {
    if (!config.enabled) return null;
    const state = states.get(id);
    if (failed || !dependenciesHealthy) throw problem("ACCOUNT_DEPENDENCIES_UNAVAILABLE");
    if (!state || state.status !== "ready") throw problem(state?.status === "quarantined" ? "ACCOUNT_QUARANTINED" : "ACCOUNT_RECOVERING");
    if (token && (!tokens.has(token) || token.bootId !== bootId || token.accountId !== id || token.epoch !== state.epoch)) {
      throw problem("ACCOUNT_RUNTIME_STALE");
    }
    return token || mint(id, state.epoch);
  };
  const authorize = () => {
    if (!config.enabled) return;
    const id = accountId(), internal = currentScope();
    if (internal && tokens.has(internal.token) && internal.token.bootId === bootId) {
      const state = states.get(id);
      if (internal.mode === "provision" && !failed) return;
      if (internal.mode === "recovery" && !failed && state?.status === "recovering" && state.epoch === internal.token.epoch) return;
      if (internal.mode === "cleanup") return;
    }
    const context = getContext();
    const token = assertReady(id, context?.accountRunToken);
    if (context && token) context.accountRunToken = token;
  };
  const quarantine = (id: string, reasonCode: string) => {
    const state = register(id);
    state.epoch += 1; state.status = "quarantined"; state.phase = "idle";
    state.reasonCode = reasonCode; state.finishedAt = new Date().toISOString();
    state.retryAfter = new Date(Date.now() + config.retryCooldownMs).toISOString();
    deferred.delete(id); publish(state);
  };
  const noteFailure = (error: Failure) => {
    if (!config.enabled) return;
    if (error.recoveryScope === "account" && error.accountId === accountId() && error.reasonCode) {
      quarantine(error.accountId, error.reasonCode);
    }
  };
  const pump = () => { while (workers < config.concurrency && pending.length) pending.shift()!(); };
  const recover = (id: string, operation: (signal: AbortSignal, setPhase: (phase: string) => void) => Promise<void>) => {
    if (!config.enabled) return operation(new AbortController().signal, () => {});
    const prior = flights.get(id);
    if (prior) return prior.promise;
    const state = register(id), expectedEpoch = state.epoch;
    state.epoch += 1; state.status = "recovering"; state.phase = "validate";
    state.attemptId = crypto.randomBytes(8).toString("hex"); state.startedAt = new Date().toISOString();
    state.finishedAt = null; state.reasonCode = null; publish(state);
    const epoch = state.epoch;
    const promise = new Promise<void>((resolve, reject) => {
      pending.push(() => {
        workers += 1;
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), config.accountDeadlineMs);
        void scope.run({ token: mint(id, epoch), mode: "recovery" }, async () => {
          try {
            await operation(controller.signal, phase => { state.phase = phase; publish(state); });
            if (controller.signal.aborted) throw Object.assign(problem("ACCOUNT_RECOVERY_TIMEOUT"), {
              recoveryScope: "account", accountId: id, reasonCode: "ACCOUNT_RECOVERY_TIMEOUT"
            });
            if (failed || state.epoch !== epoch || state.status !== "recovering") throw problem("ACCOUNT_RUNTIME_STALE");
            state.status = "ready"; state.phase = "idle"; state.finishedAt = new Date().toISOString();
            state.retryAfter = null; publish(state);
            const callbacks = deferred.get(id) || []; deferred.delete(id);
            for (const callback of callbacks) callback();
            resolve();
          } catch (value) {
            const error = value as Failure;
            if (error.recoveryScope === "account" && error.accountId === id && error.reasonCode) {
              quarantine(id, error.reasonCode); resolve();
            } else { failGlobal(error); reject(error); }
          } finally {
            clearTimeout(timer); controllers.delete(controller); flights.delete(id); workers -= 1; pump();
          }
        });
      });
    });
    flights.set(id, { expectedEpoch, promise }); pump();
    return promise;
  };
  const withOperation = async <T,>(operation: () => Promise<T>): Promise<T> => {
      if (!config.enabled) return operation();
      const id = accountId();
      if (currentScope()) throw problem("ACCOUNT_OPERATION_NOT_ALLOWED");
      authorize(); operations.set(id, (operations.get(id) || 0) + 1);
      const completion = Promise.resolve().then(() => { authorize(); return operation(); });
      operationCompletions.add(completion);
      try { return await completion; }
      finally {
        operationCompletions.delete(completion);
        const left = (operations.get(id) || 1) - 1; if (left) operations.set(id, left); else operations.delete(id);
      }
  };
  return Object.freeze({
    /**
     * 订阅已确认的共享依赖故障；停止时移除订阅，不把账户隔离升级为退出。
     * @since unreleased
     */
    onGlobalFailure(listener: (error: unknown) => void) { globalFailureListeners.add(listener); return () => globalFailureListeners.delete(listener); },
    enabled: config.enabled, bootId, currentAccountId: accountId, register, recover, authorize, assertReady, noteFailure, failGlobal,
    /** 关闭准入并协作取消恢复；真实操作退出前不提前释放资源。
     * @since unreleased
     */
    async stop() {
      failGlobal();
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...flights.values()].map(flight => flight.promise));
      await Promise.allSettled([...operationCompletions]);
    },
    /** 仅经只读预检确认的新存储可初始化；不能由HTTP参数开启。
     * @since unreleased
     */
    allowInitialization(value: boolean) { const current = currentScope(); if (current?.mode === "recovery") current.allowCreate = value; },
    /** 仅内部新账户/新本地工作区能力可以接收缺失文档默认值。
     * @since unreleased
     */
    canInitialize() { const current = currentScope(); return current?.mode === "provision" || (current?.mode === "recovery" && current.allowCreate === true); },
    /** 外部副作用必须具备普通运行资格；恢复和清理能力都不能启动provider。
     * @since unreleased
     */
    assertDispatch() { if (config.enabled && currentScope()) throw problem("ACCOUNT_OPERATION_NOT_ALLOWED"); authorize(); },
    /** 标记本轮枚举边界；恢复过程不提前宣称扫描就绪。
     * @since unreleased
     */
    beginScan() { if (config.enabled) scanComplete = false; },
    /** 完成本轮扫描；隔离账户仍留在汇总。
     * @since unreleased
     */
    completeScan() { scanComplete = true; },
    /** 仅返回状态与安全原因，不读取或暴露账户正文。
     * @since unreleased
     */
    state(id: string) { return states.has(id) ? { ...states.get(id)! } : null; },
    /** 当前共享健康和账户数量汇总，不输出账户标识。
     * @since unreleased
     */
    health() {
      const rows = [...states.values()];
      const counts = { total: rows.length, ready: rows.filter(row => row.status === "ready").length,
        quarantined: rows.filter(row => row.status === "quarantined").length,
        recovering: rows.filter(row => row.status === "recovering" || row.status === "unknown").length };
      return { bootId, scanComplete, dependenciesHealthy: dependenciesHealthy && !failed,
        ready: !config.enabled || (scanComplete && !failed && dependenciesHealthy && (!counts.total || counts.ready > 0)),
        degraded: counts.quarantined > 0, counts };
    },
    /** 执行生命周期覆盖真实异步结束，隔离后旧执行器未结束不得重入恢复。
     * @since unreleased
     */
    withOperation,
    /** 注册事务内仅允许初始化该账户；不发布运行资格或执行外部任务。
     * @since unreleased
     */
    provision<T>(id: string, operation: () => T): T {
      return scope.run({ token: mint(id, -1), mode: "provision" }, operation);
    },
    /** 派发前与回调执行前重验；恢复阶段仅登记，ready 后按原幂等身份激活。
     * @since unreleased
     */
    dispatch(callback: () => unknown, schedule: (callback: () => void) => unknown) {
      if (!config.enabled) return schedule(callback);
      const id = accountId(), internal = currentScope();
      if (internal?.mode === "cleanup" || internal?.mode === "provision") throw problem("ACCOUNT_OPERATION_NOT_ALLOWED");
      const activate = () => {
        const token = assertReady(id);
        const context = getContext(); if (context && token) context.accountRunToken = token;
        return scope.exit(() => schedule(() => {
          // 派发前资格可能已失效；排队任务保留原状态，修复恢复时按原身份重新领取。
          try { assertReady(id, token || undefined); } catch { return; }
          void withOperation(async () => { await callback(); }).catch(onDispatchError);
        }));
      };
      if (internal?.mode === "recovery") {
        authorize();
        const callbacks = deferred.get(id) || []; callbacks.push(activate); deferred.set(id, callbacks);
        return undefined;
      }
      authorize(); return activate();
    },
    /** 重试遵循 boot/epoch CAS，同一活动尝试合并；不在真实 I/O 结束前腾出重入机会。
     * @since unreleased
     */
    retry(id: string, expectedBoot: string, expectedEpoch: number, operation: (signal: AbortSignal, setPhase: (phase: string) => void) => Promise<void>) {
      const state = states.get(id), flight = flights.get(id);
      if (!state) throw problem("ACCOUNT_RUNTIME_NOT_FOUND", 404);
      if (expectedBoot !== bootId) throw problem("ACCOUNT_RECOVERY_CONFLICT", 409);
      if (flight && flight.expectedEpoch === expectedEpoch) return { ...state };
      if ((operations.get(id) || 0) > 0) throw problem("ACCOUNT_RECOVERY_DRAINING", 409);
      if (state.epoch !== expectedEpoch || state.status !== "quarantined") throw problem("ACCOUNT_RECOVERY_CONFLICT", 409);
      if (state.retryAfter && Date.now() < Date.parse(state.retryAfter)) throw Object.assign(problem("ACCOUNT_RECOVERY_COOLDOWN", 429), { retryAfterMs: Date.parse(state.retryAfter) - Date.now() });
      void recover(id, operation).catch(() => {});
      return { ...state };
    },
    /** 派发前登记真实审计调用身份；隔离后不得登记新的调用。
     * @since unreleased
     */
    beginAuditCall(callId: string) {
      if (!config.enabled) return;
      if (currentScope()) throw problem("ACCOUNT_OPERATION_NOT_ALLOWED");
      authorize();
      if (auditCalls.has(callId)) throw problem("ACCOUNT_AUDIT_ID_REUSED");
      auditCalls.set(callId, accountId());
    },
    /** 仅结算此前登记的同账户调用；损坏账本保留待对账，不允许创建或修改业务内容。
     * @since unreleased
     */
    async finalizeUsage<T>(entry: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
      if (!config.enabled) return operation();
      const id = String(entry.callId || entry.id || ""), owner = accountId();
      if (auditCalls.get(id) !== owner) { authorize(); return operation(); }
      const state = states.get(owner);
      const result = await scope.run({ token: mint(owner, state?.epoch ?? 0), mode: "cleanup", operationId: id, usageEntry: structuredClone(entry) }, operation);
      auditCalls.delete(id);
      return result;
    },
    /** 仅允许同一账户已存在任务的终态收尾；仓储提交还须核对受限字段差分。
     * @since unreleased
     */
    cleanupTask<T>(task: { id: string; attempt: number }, operation: () => T): T {
      if (!task?.id || !Number.isSafeInteger(task.attempt)) throw problem("ACCOUNT_CLEANUP_INVALID");
      const id = accountId(), state = states.get(id);
      return scope.run({ token: mint(id, state?.epoch ?? 0), mode: "cleanup", operationId: task.id, attempt: task.attempt }, operation);
    },
    /** 清理能力不能更改内容、创建任务或改写其他操作；由真实事务持有者传入前后文档。
     * @since unreleased
     */
    assertCommit(before: Record<string, unknown>, after: Record<string, unknown>, document = "store") {
      authorize();
      const internal = currentScope();
      if (internal?.mode !== "cleanup") return;
      const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
      const stringify = (value: unknown) => JSON.stringify(sorted(value));
      if (internal.usageEntry) {
        if (document !== "usage") throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (key !== "entries" && stringify(before[key]) !== stringify(after[key])) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        }
        const prior = before.entries as Array<Record<string, unknown>>, next = after.entries as Array<Record<string, unknown>>;
        if (!Array.isArray(prior) || !Array.isArray(next) || next.length < prior.length || next.length > prior.length + 1) throw problem("ACCOUNT_CLEANUP_INVALID");
        for (let index = 0; index < prior.length; index++) if (stringify(prior[index]) !== stringify(next[index])) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        if (next.length > prior.length && stringify(next[next.length - 1]) !== stringify(internal.usageEntry)) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        return;
      }
      if (document !== "store") throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (key === "aiTasks" || key === "notifications") continue;
        if (stringify(before[key]) !== stringify(after[key])) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
      }
      const oldNotifications = before.notifications as Array<Record<string, unknown>>;
      const newNotifications = after.notifications as Array<Record<string, unknown>>;
      if (JSON.stringify(oldNotifications) !== JSON.stringify(newNotifications)) {
        if (!Array.isArray(oldNotifications) || !Array.isArray(newNotifications) || oldNotifications.length !== newNotifications.length) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        for (let index = 0; index < oldNotifications.length; index++) {
          const a = oldNotifications[index], b = newNotifications[index];
          if (a.taskId !== internal.operationId) { if (stringify(a) !== stringify(b)) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED"); continue; }
          if (a.id !== b.id || b.status !== "cancelled") throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (!["status", "message", "updatedAt", "readAt", "title"].includes(key) && stringify(a[key]) !== stringify(b[key])) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
          }
        }
      }
      const prior = before.aiTasks as Array<Record<string, unknown>>, next = after.aiTasks as Array<Record<string, unknown>>;
      if (!Array.isArray(prior) || !Array.isArray(next) || prior.length !== next.length) throw problem("ACCOUNT_CLEANUP_INVALID");
      for (let index = 0; index < prior.length; index++) {
        const a = prior[index], b = next[index];
        if (stringify(a) === stringify(b)) continue;
        if (a.id !== internal.operationId) { if (stringify(a) !== stringify(b)) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED"); continue; }
        if (a.id !== b.id || a.attempt !== internal.attempt || !["queued", "running", "cancelling"].includes(String(a.status))
          || !["failed", "cancelled"].includes(String(b.status))) throw problem("ACCOUNT_CLEANUP_INVALID");
        const allowed = new Set(["status", "error", "errorCode", "updatedAt", "completedAt"]);
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (!allowed.has(key) && stringify(a[key]) !== stringify(b[key])) throw problem("ACCOUNT_CLEANUP_NOT_ALLOWED");
        }
      }
    }
  });
}
