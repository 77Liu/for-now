/**
 * 当前账户与工作区的增量读取、取消和前台续接调度。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：持久游标仅在当前作用域应用成功后推进；只取消读取，不撤销已提交写入。
 */
type Snapshot = Record<string, unknown>;
type Operation = { owner: string; operationId?: string; id?: string; status: string; domains?: string[]; createdAt?: string };
type Status = Record<string, unknown>;
type Target = {
  visibilityState?: string;
  addEventListener?(name: string, listener: () => void): void;
  removeEventListener?(name: string, listener: () => void): void;
};
type Failure = Error & { code?: string; status?: number; details?: { currentCursor?: number }; syncStatus?: string };
/** 供异步消费者在每次await后复验归属；不是可持久化的数据或授权。 @since unreleased */
export type SyncConsumption = { owner: string; workspace: string; scope: string; isCurrent(): boolean };
type Options = {
  coordinator: {
    resume(owner: string, options: { force: boolean }): Promise<PromiseSettledResult<unknown>[]>;
    subscribe(listener: (record: Operation) => void): () => void;
    prune?(owner: string): Promise<unknown>;
  };
  request(url: string, options: { signal: AbortSignal }): Promise<unknown>;
  applySnapshot(snapshot: Snapshot, changes: unknown[], context: SyncConsumption): Promise<unknown>;
  resnapshot?(context: SyncConsumption): Promise<unknown>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  channel: { publish(message: Status): void; subscribe(listener: (message: Status) => void): () => void };
  locks?: { request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T> } | null;
  windowTarget?: Target | null;
  documentTarget?: Target | null;
  pollMs?: number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  onStatus?: (event: Status) => void;
  getScope?: () => string;
  getWorkspace?: () => string;
  getSignal?: () => AbortSignal | undefined;
};
type PendingRead = { promise: Promise<boolean>; controller: AbortController; wait: boolean; serial: number; dispatched: boolean };

/**
 * 原增量同步接口的有界生命周期实现，原公开入口提供默认跨标签通道。
 * 调用方必须透传signal，并在异步接入内部复验context；工作区标识须来自实际配置。
 * resnapshot可选以兼容旧入口；若遇游标/终态恢复而缺该端口或明确返回false，保留旧游标并退避。
 * @since unreleased
 */
export function createScopedIncrementalSync({
  coordinator, request, applySnapshot, resnapshot,
  storage = globalThis.localStorage, channel, locks = globalThis.navigator?.locks,
  windowTarget = globalThis.window, documentTarget = globalThis.document,
  pollMs = 1500, setTimer = globalThis.setTimeout,
  clearTimer = timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  now = () => Date.now(), onStatus = () => {},
  getScope = () => '', getWorkspace = () => '', getSignal = () => undefined
}: Options) {
  if (!coordinator || typeof request !== 'function' || typeof applySnapshot !== 'function') {
    throw new TypeError('增量同步缺少协调器、请求或快照应用器');
  }
  let owner = '', workspace = '', scope = '';
  let cursor: number | null = null;
  let timer: unknown = null;
  let pending: PendingRead | null = null;
  let recovering: { context: SyncConsumption; promise: Promise<unknown> } | null = null;
  let immediateQueued = false;
  let stopped = true, enabled = true;
  let lifecycle = 0, readSerial = 0, failures = 0;
  let unsubscribeChannel = () => {}, unsubscribeCoordinator = () => {}, unsubscribeScope = () => {};
  const visible = () => !documentTarget || documentTarget.visibilityState !== 'hidden';
  const context = (): SyncConsumption => {
    const expectedOwner = owner, expectedWorkspace = workspace, expectedScope = scope, expectedLifecycle = lifecycle;
    return { owner: expectedOwner, workspace: expectedWorkspace, scope: expectedScope,
      isCurrent: () => !stopped && owner === expectedOwner && lifecycle === expectedLifecycle
        && expectedScope === getScope() && expectedWorkspace === getWorkspace() };
  };
  const cursorKey = () => `cike-sync-cursor:${owner}${workspace ? `:workspace:${encodeURIComponent(workspace)}` : ''}`;
  const storeCursor = (value: number, reset = false) => {
    cursor = reset ? value : Math.max(cursor ?? 0, value);
    try { storage?.setItem(cursorKey(), String(cursor)); } catch {}
  };
  const readCursor = () => {
    try {
      const raw = storage?.getItem(cursorKey());
      const value = Number(raw);
      return raw != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  };
  const clearPoll = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };
  const cancelRead = () => {
    readSerial += 1;
    const previous = pending;
    pending = null;
    previous?.controller.abort();
  };
  const schedule = (delay: number) => {
    if (stopped || !enabled || timer != null || !context().isCurrent() || recovering?.context.isCurrent()) return;
    timer = setTimer(async () => {
      timer = null;
      if (!visible()) { schedule(pollMs); return; }
      await drain({ wait: true }).catch(() => {});
    }, delay);
  };
  const recoverSnapshot = (consumer: SyncConsumption, cancelPrevious = false): Promise<unknown> => {
    if (recovering?.context.isCurrent()) return recovering.promise;
    // 可取消的read ticket失效不代表真实完整读取已结束；屏障覆盖同一会话的整个恢复promise。
    const recovery = { context: context(), promise: Promise.resolve() as Promise<unknown> };
    recovering = recovery;
    clearPoll();
    // 先建立恢复屏障再撤旧read，恢复期间任何timer/广播都只能登记后续拉取。
    if (cancelPrevious) cancelRead();
    recovery.promise = Promise.resolve().then(async () => {
      if (!consumer.isCurrent()) return false;
      if (!resnapshot) throw new Error('同步恢复缺少重读端口');
      const applied = await resnapshot(consumer);
      if (!consumer.isCurrent()) return false;
      if (applied === false) throw new Error('同步重读尚未应用');
      return true;
    }).finally(() => {
      if (recovering === recovery) {
        recovering = null;
        if (recovery.context.isCurrent() && !pending) {
          immediateQueued = false;
          schedule(failures ? retryWait() : 0);
        }
      }
    });
    return recovery.promise;
  };
  const retryWait = () => Math.min(60_000, Math.max(1000, pollMs) * 2 ** Math.min(6, Math.max(0, failures - 1)));
  const pull = ({ wait = false } = {}): Promise<boolean> => {
    if (!owner || stopped || !enabled || !context().isCurrent()) return Promise.resolve(false);
    if (recovering?.context.isCurrent()) { immediateQueued = true; return Promise.resolve(false); }
    if (pending) {
      if (wait || !pending.wait) {
        if (!wait && pending.dispatched) immediateQueued = true;
        return pending.promise;
      }
      // 主动读取不排在旧长等待后；先失效旧代数，再发只读取消。
      cancelRead();
    }
    clearPoll();
    const current = context(), serial = ++readSerial, controller = new AbortController();
    const consumer = { ...current, isCurrent: () => current.isCurrent() && serial === readSerial && !controller.signal.aborted };
    const startedAt = now();
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(new DOMException('同步读取已取消', 'AbortError'));
      controller.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', abort);
    });
    void aborted.catch(() => {});
    const execution = (async () => {
      // Promise微任务让pending在同步抛错或立即返回的transport前就绪。
      await Promise.resolve();
      try {
        if (!consumer.isCurrent()) return false;
        const query = new URLSearchParams({ waitMs: String(wait ? Math.min(1500, pollMs) : 0) });
        if (cursor != null) query.set('cursor', String(cursor));
        if (pending?.serial === serial) pending.dispatched = true;
        const response = await Promise.race([request(`/api/v1/sync?${query}`, { signal: controller.signal }), aborted]);
        if (!consumer.isCurrent()) return false;
        const result = response as { data?: unknown };
        const payload = (result?.data || result) as { cursor: number; changes?: unknown[]; snapshot?: Snapshot };
        if (!payload || !Number.isSafeInteger(payload.cursor) || payload.cursor < 0 || !Array.isArray(payload.changes)) {
          throw new Error('同步响应无效');
        }
        if (payload.changes.length) {
          if (!payload.snapshot || typeof payload.snapshot !== 'object' || Array.isArray(payload.snapshot)) throw new Error('同步变化缺少快照');
          const applied = await applySnapshot(payload.snapshot, payload.changes, consumer);
          if (applied === false && consumer.isCurrent()) throw new Error('同步快照尚未应用');
        }
        if (!consumer.isCurrent()) return false;
        storeCursor(payload.cursor);
        failures = 0;
        onStatus({ type: 'pull', owner, workspace, scope, cursor, changes: payload.changes.length, durationMs: now() - startedAt });
        return Boolean(payload.changes.length);
      } catch (caught) {
        if (!consumer.isCurrent()) return false;
        const error = caught as Failure;
        if (['SYNC_CURSOR_EXPIRED', 'SYNC_RESNAPSHOT_REQUIRED', 'SYNC_CURSOR_AHEAD'].includes(error.code || '')) {
          try {
            await recoverSnapshot(consumer);
            if (!consumer.isCurrent()) return false;
            const next = error.details?.currentCursor;
            if (!Number.isSafeInteger(next) || next! < 0) throw new Error('同步恢复游标无效');
            storeCursor(next!, true);
          } catch (recoveryError) {
            if (consumer.isCurrent()) {
              failures += 1;
              onStatus({ type: 'error', owner, workspace, scope, cursor, code: 'SYNC_RECOVERY_FAILED', durationMs: now() - startedAt });
            }
            throw recoveryError;
          }
          if (!consumer.isCurrent()) return false;
          failures = 0;
          onStatus({ type: 'resnapshot', owner, workspace, scope, cursor, code: error.code, durationMs: now() - startedAt });
          return true;
        }
        failures += 1;
        onStatus({ type: 'error', owner, workspace, scope, cursor, code: error.code || '', durationMs: now() - startedAt });
        throw error;
      } finally {
        removeAbort();
        if (pending?.serial === serial) {
          pending = null;
          const follow = immediateQueued;
          immediateQueued = false;
          if (current.isCurrent()) {
            if (follow && !failures) void pull().catch(() => {});
            // 真实长等待成功立即续接；旧服务端意外立即返回时保留最小让步，避免热循环。
            else schedule(failures ? retryWait() : wait ? Math.max(0, 50 - (now() - startedAt)) : 0);
          }
        }
      }
    })();
    pending = { promise: execution, controller, wait, serial, dispatched: false };
    return execution;
  };
  const drain = async ({ forceRetry = false, wait = false } = {}) => {
    if (!owner || stopped || !context().isCurrent()) return [];
    const current = context();
    const previousFailures = failures;
    // 写入恢复可能等待未知提交；只读续接独立启动，不占用写队列的完成承诺。
    const reading = enabled ? pull({ wait }) : null;
    void reading?.catch(() => {});
    try {
      const run = () => current.isCurrent() ? coordinator.resume(current.owner, { force: forceRetry }) : Promise.resolve([]);
      const result = locks?.request
        ? await locks.request(`cike-sync-drain:${owner}:${workspace}`, { ifAvailable: true }, lock => lock ? run() : Promise.resolve([]))
        : await run();
      if (!current.isCurrent()) return [];
      const terminalFailure = result.some(item => item.status === 'rejected'
        && ['failed', 'conflict'].includes((item.reason as Failure)?.syncStatus || ''));
      if ((!enabled && result.some(item => item.status === 'fulfilled')) || terminalFailure) {
        await recoverSnapshot(current, enabled);
        if (!current.isCurrent()) return [];
        if (enabled) {
          immediateQueued = false;
          await pull();
        }
      }
      if (reading) await reading;
      else onStatus({ type: 'disabled', owner, workspace, scope, cursor });
      return result;
    } catch (caught) {
      if (current.isCurrent() && failures === previousFailures) {
        failures += 1;
        onStatus({ type: 'error', owner, workspace, scope, cursor, code: (caught as Failure)?.code || 'SYNC_DRAIN_FAILED' });
        clearPoll();
        schedule(retryWait());
      }
      throw caught;
    }
  };
  const onOnline = () => { clearPoll(); void pull().catch(() => {}); void drain({ forceRetry: true, wait: true }).catch(() => {}); };
  const onPageShow = () => { clearPoll(); void pull().catch(() => {}); void drain({ wait: true }).catch(() => {}); };
  const onVisibility = () => {
    clearPoll();
    if (visible()) { void pull().catch(() => {}); void drain({ wait: true }).catch(() => {}); }
    else { cancelRead(); schedule(pollMs); }
  };
  const stop = () => {
    lifecycle += 1;
    stopped = true;
    clearPoll();
    cancelRead();
    immediateQueued = false;
    recovering = null;
    unsubscribeChannel(); unsubscribeCoordinator(); unsubscribeScope();
    unsubscribeChannel = () => {}; unsubscribeCoordinator = () => {}; unsubscribeScope = () => {};
    windowTarget?.removeEventListener?.('online', onOnline);
    windowTarget?.removeEventListener?.('pageshow', onPageShow);
    documentTarget?.removeEventListener?.('visibilitychange', onVisibility);
    owner = ''; workspace = ''; scope = ''; cursor = null; failures = 0;
  };
  return {
    async start(nextOwner: string, { incremental = true } = {}) {
      stop();
      owner = String(nextOwner || '');
      if (!owner) return false;
      workspace = getWorkspace(); scope = getScope(); cursor = readCursor();
      enabled = Boolean(incremental); stopped = false;
      const current = context(), signal = getSignal();
      if (signal?.aborted) { stop(); return false; }
      signal?.addEventListener('abort', stop, { once: true });
      unsubscribeScope = () => signal?.removeEventListener('abort', stop);
      unsubscribeChannel = channel.subscribe(message => {
        if (current.isCurrent() && enabled && message?.owner === owner && (message.workspace || '') === workspace && message.type === 'committed') {
          void pull().catch(() => {});
        }
      });
      unsubscribeCoordinator = coordinator.subscribe(record => {
        if (!current.isCurrent() || record.owner !== owner) return;
        onStatus({ type: 'operation', owner, workspace, scope, operationId: record.operationId || record.id || '',
          status: record.status, domains: record.domains || [], ageMs: record.createdAt ? Math.max(0, now() - Date.parse(record.createdAt)) : 0 });
        if (enabled && record.status === 'committed') {
          channel.publish({ type: 'committed', owner, workspace, operationId: record.operationId, domains: record.domains || [] });
          void pull().catch(() => {});
        }
      });
      windowTarget?.addEventListener?.('online', onOnline);
      windowTarget?.addEventListener?.('pageshow', onPageShow);
      documentTarget?.addEventListener?.('visibilitychange', onVisibility);
      try {
        if (enabled) await pull();
        if (!current.isCurrent()) return false;
        await drain();
        if (!current.isCurrent()) return false;
        await coordinator.prune?.(owner);
        return current.isCurrent();
      } finally {
        if (current.isCurrent() && enabled) schedule(failures ? retryWait() : 0);
      }
    },
    stop, pull, drain,
    cursor: () => cursor || 0
  };
}

type RecordScopeRequest = {
  activeScopeKey: string;
  scopes: Record<string, unknown>[];
};
type RecordConsumption = SyncConsumption & { generation: number };
type RecordSyncLoopOptions = {
  request(url: string, options: {
    method?: string;
    body?: string;
    signal: AbortSignal;
  }): Promise<unknown>;
  applyBatch(batch: Record<string, unknown>, context: RecordConsumption): Promise<{
    committed: boolean;
    staleScopeKeys: string[];
  }> | {
    committed: boolean;
    staleScopeKeys: string[];
  };
  rebaseScopes(payload: Record<string, unknown>, context: RecordConsumption): Promise<unknown> | unknown;
  hydrateScopes?(cursor: number, context: RecordConsumption): Promise<boolean> | boolean;
  getScopes(): RecordScopeRequest;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  windowTarget?: Target | null;
  documentTarget?: Target | null;
  pollMs?: number;
  getScope?: () => string;
  getWorkspace?: () => string;
  getSignal?: () => AbortSignal | undefined;
  onStatus?: (event: Status) => void;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
};

/** Independent v2 read loop; v1 keeps serving entity types that have not migrated. @since unreleased */
export function createRecordSyncLoop(options: RecordSyncLoopOptions) {
  const request = options.request;
  const storage = options.storage ?? globalThis.localStorage;
  const windowTarget = options.windowTarget ?? globalThis.window;
  const documentTarget = options.documentTarget ?? globalThis.document;
  const pollMs = options.pollMs ?? 1500;
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer
    ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const getScope = options.getScope ?? (() => "");
  const getWorkspace = options.getWorkspace ?? (() => "");
  const getSignal = options.getSignal ?? (() => undefined);
  const onStatus = options.onStatus ?? (() => {});
  const now = options.now ?? (() => Date.now());
  let owner = "", workspace = "", scope = "", cursor = 0;
  let lifecycle = 0, failures = 0, readSerial = 0, timer: unknown = null;
  let pending: { serial: number; controller: AbortController; promise: Promise<boolean> } | null = null;
  let recovery: {
    context: RecordConsumption;
    controller: AbortController;
    promise: Promise<boolean>;
  } | null = null;
  let stopped = true, enabled = false;
  let unsubscribeSignal = () => {};
  const context = (): RecordConsumption => {
    const expected = { owner, workspace, scope, generation: lifecycle };
    return {
      ...expected,
      isCurrent: () => !stopped && owner === expected.owner
        && workspace === getWorkspace() && scope === getScope()
        && lifecycle === expected.generation
    };
  };
  const cursorKey = () => `cike-record-sync-v2:${owner}:${encodeURIComponent(workspace)}`;
  const saveCursor = (value: number) => {
    cursor = value;
    try { storage?.setItem(cursorKey(), String(value)); } catch {}
  };
  const readCursor = () => {
    try {
      const raw = storage?.getItem(cursorKey());
      const value = Number(raw);
      return raw != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const clearPoll = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };
  const cancel = () => {
    readSerial += 1;
    pending?.controller.abort();
    pending = null;
  };
  const retryWait = () => Math.min(60_000, Math.max(1000, pollMs)
    * 2 ** Math.min(6, Math.max(0, failures - 1)));
  const visible = () => !documentTarget || documentTarget.visibilityState !== "hidden";
  const schedule = (delay: number) => {
    if (!enabled || stopped || timer != null || !context().isCurrent()) return;
    timer = setTimer(() => {
      timer = null;
      if (!visible()) return schedule(pollMs);
      void pull(true).catch(() => {});
    }, delay);
  };
  const runRebase = async (consumer: RecordConsumption, controller: AbortController) => {
    if (!consumer.isCurrent()) return false;
    const requestScopes = options.getScopes();
    const signal = AbortSignal.any([controller.signal, getSignal() || new AbortController().signal]);
    const response = await request("/api/v2/sync/rebase", {
      method: "POST",
      body: JSON.stringify(requestScopes),
      signal
    });
    if (!consumer.isCurrent()) return false;
    const payload = (response as { data?: Record<string, unknown> })?.data
      || response as Record<string, unknown>;
    await options.rebaseScopes(payload, consumer);
    if (!consumer.isCurrent()) return false;
    const next = Number(payload.highWaterCursor);
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("同步恢复游标无效");
    saveCursor(next);
    failures = 0;
    onStatus({ type: "record-rebase", owner, workspace, scope, cursor });
    return true;
  };
  const rebase = (consumer = context()): Promise<boolean> => {
    if (!consumer.isCurrent()) return Promise.resolve(false);
    if (recovery?.context.isCurrent()) return recovery.promise;
    clearPoll();
    cancel();
    const controller = new AbortController();
    const current = { context: consumer, controller, promise: Promise.resolve(false) };
    recovery = current;
    current.promise = runRebase(consumer, controller).finally(() => {
      if (recovery === current) {
        recovery = null;
        if (consumer.isCurrent()) schedule(failures ? retryWait() : 0);
      }
    });
    return current.promise;
  };
  const finishPull = (serial: number, startedAt: number) => {
    if (pending?.serial !== serial) return;
    pending = null;
    if (context().isCurrent()) {
      schedule(failures ? retryWait() : Math.max(0, 50 - (now() - startedAt)));
    }
  };
  const pull = (wait = false): Promise<boolean> => {
    if (!enabled || stopped || !context().isCurrent()) return Promise.resolve(false);
    if (recovery?.context.isCurrent()) return Promise.resolve(false);
    if (pending) return pending.promise;
    clearPoll();
    const consumer = context(), controller = new AbortController();
    const serial = ++readSerial;
    const startedAt = now();
    const execution = (async () => {
      try {
        const query = new URLSearchParams({
          cursor: String(cursor),
          waitMs: String(wait ? Math.min(1500, pollMs) : 0)
        });
        const response = await request(`/api/v2/sync?${query}`, { signal: controller.signal });
        if (!consumer.isCurrent()) return false;
        const batch = (response as { data?: Record<string, unknown> })?.data
          || response as Record<string, unknown>;
        const applied = await options.applyBatch(batch, consumer);
        if (!consumer.isCurrent()) return false;
        const next = Number(batch.nextCursor);
        if (!Number.isSafeInteger(next) || next < cursor) throw new Error("记录同步游标无效");
        const changes = Array.isArray(batch.changes) ? batch.changes as Array<Record<string, unknown>> : [];
        const serverRequiresRebase = changes.some(change => (
          change.refetch === "page"
          || change.refetch === "detail"
          || change.operation === "create"
          || change.operation === "delete"
        ));
        if (applied.staleScopeKeys.length || serverRequiresRebase) await rebase(consumer);
        else saveCursor(next);
        failures = 0;
        onStatus({
          type: "record-pull",
          owner,
          workspace,
          scope,
          cursor,
          changes: changes.length,
          durationMs: now() - startedAt
        });
        return Boolean((batch.changes as unknown[])?.length);
      } catch (caught) {
        if (!consumer.isCurrent()) return false;
        const error = caught as Failure;
        if (["SYNC_CURSOR_MISSING", "SYNC_CURSOR_EXPIRED", "SYNC_CURSOR_AHEAD", "SYNC_REBASE_REQUIRED"]
          .includes(error.code || "")) {
          await rebase(consumer);
          return true;
        }
        failures += 1;
        onStatus({
          type: "record-error",
          owner,
          workspace,
          scope,
          cursor,
          code: error.code || "SYNC_V2_FAILED"
        });
        throw error;
      } finally {
        finishPull(serial, startedAt);
      }
    })();
    pending = { serial, controller, promise: execution };
    return execution;
  };
  const onForeground = () => {
    clearPoll();
    void pull(false).catch(() => {});
  };
  const onVisibility = () => {
    if (visible()) onForeground();
    else {
      clearPoll();
      cancel();
    }
  };
  const stop = () => {
    lifecycle += 1;
    stopped = true;
    clearPoll();
    cancel();
    recovery?.controller.abort();
    recovery = null;
    unsubscribeSignal();
    unsubscribeSignal = () => {};
    windowTarget?.removeEventListener?.("online", onForeground);
    windowTarget?.removeEventListener?.("pageshow", onForeground);
    documentTarget?.removeEventListener?.("visibilitychange", onVisibility);
    owner = "";
    workspace = "";
    scope = "";
    cursor = 0;
    failures = 0;
  };
  return {
    async start(nextOwner: string, { recordSync = false } = {}) {
      stop();
      owner = String(nextOwner || "");
      enabled = Boolean(owner && recordSync);
      if (!enabled) return false;
      workspace = getWorkspace();
      scope = getScope();
      stopped = false;
      const signal = getSignal();
      if (signal?.aborted) {
        stop();
        return false;
      }
      signal?.addEventListener("abort", stop, { once: true });
      unsubscribeSignal = () => signal?.removeEventListener("abort", stop);
      windowTarget?.addEventListener?.("online", onForeground);
      windowTarget?.addEventListener?.("pageshow", onForeground);
      documentTarget?.addEventListener?.("visibilitychange", onVisibility);
      const savedCursor = readCursor();
      const hydrated = savedCursor != null && options.hydrateScopes
        ? await options.hydrateScopes(savedCursor, context())
        : false;
      if (hydrated) cursor = savedCursor!;
      else await rebase();
      if (!context().isCurrent()) return false;
      await pull(false);
      return context().isCurrent();
    },
    stop,
    pull,
    rebase,
    cursor: () => cursor
  };
}
