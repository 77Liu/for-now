import { performance } from "node:perf_hooks";
import {
  readRecordChangePage,
  readRecordSyncHead
} from "../../.build/typescript/backend/shared/persistence/record-sync-repository.mjs";
import {
  createRecordSyncEntityRegistry,
  projectRecordChanges
} from "../../.build/typescript/backend/app/sync-projection.mjs";
import {
  rebaseRecordSyncScopes
} from "../../.build/typescript/backend/app/sync-rebase.mjs";
const MAX_WAIT_MS = 1500;
const MAX_INCREMENTAL_CHANGES = 500;
const PUBLIC_DOMAINS = new Set([
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "journalDraft",
  "thoughts",
  "chats",
  "books",
  "keepsakes",
  "quotes",
  "experiments",
  "analyses",
  "customMetrics",
  "aiTasks",
  "notifications",
  "actions",
  "habits",
  "habitCheckins",
  "feedback",
  "validationLedger",
  "userClaims",
  "modelUnknowns",
  "onboarding",
  "onboardingV2",
  "commercialization"
]);
const INSIGHT_DOMAINS = new Set([
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "thoughts",
  "books",
  "quotes",
  "experiments",
  "analyses"
]);
const aborted = () => Object.assign(new Error("同步请求已断开"), { code: "SYNC_WAIT_ABORTED", statusCode: 499 });
function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
    const abort = () => finish(aborted());
    const timer = setTimeout(() => finish(), Math.max(0, milliseconds));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function integer(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function publicSnapshot(state, changes) {
  const domains = new Set(changes.map(change => change.domain));
  // 本函数结果只在当前同步调用栈交给success→sendJson序列化，不逃逸到业务写入。
  // 权限投影已经完成；只组装响应字段，不再深复制整份正文。
  const snapshot = {};
  for (const domain of domains) {
    if (PUBLIC_DOMAINS.has(domain) && Object.hasOwn(state, domain)) {
      snapshot[domain] = state[domain];
    }
  }
  if (domains.has("trash")) snapshot.trashCount = state.trashCount;
  if (domains.has("notifications") || domains.has("aiTasks")) {
    snapshot.notifications = state.notifications;
    snapshot.aiTasks = state.aiTasks;
    snapshot.notificationUnread = state.notificationUnread;
  }
  if (domains.has("speechCache")) {
    snapshot.speech = state.speech;
  }
  if ([...domains].some(domain => INSIGHT_DOMAINS.has(domain))) {
    snapshot.clusters = state.clusters;
    snapshot.insights = state.insights;
  }
  return snapshot;
}

/**
 * 同步游标/回执HTTP消费者，沿用持久状态与原错误协议。
 * 新增notifier/getAccountId/assertAccess（unreleased）只控制等待与资格复验；
 * 账户及存储作用域来自受信运行时，断连不撤销已经提交的写入。
 */
export function createSyncHttp({
  repository,
  publicState,
  notifier = null,
  getAccountId,
  assertAccess = async () => {},
  bodyJson = null,
  recordSync = null,
  syncV2 = null
}) {
  if (!repository?.readSyncSnapshot || typeof publicState !== "function") {
    throw new TypeError("Sync HTTP requires a sync-capable repository and public state projector");
  }

  async function snapshotAfter(after, waitMs, hasCursor, req, signal) {
    const read = async () => {
      if (signal.aborted) throw aborted();
      await assertAccess(req);
      const snapshot = repository.readSyncChanges
        ? await repository.readSyncChanges({ cursor: after, hasCursor, limit: MAX_INCREMENTAL_CHANGES, fieldsForDomains: publicState.syncProjectionFields })
        : await repository.readSyncSnapshot();
      if (signal.aborted) throw aborted();
      await assertAccess(req);
      if (signal.aborted) throw aborted();
      notifier?.assertActive();
      return snapshot;
    };
    // 注册先于持久读取；通知代数在查询期间也保留，等待不持有仓储事务或连接。
    const subscription = waitMs > 0 && notifier ? notifier.subscribeAccountCommits({
      accountId: getAccountId(), storageScope: repository.syncScope()
    }) : null;
    const deadline = performance.now() + waitMs;
    let generation = subscription?.generation();
    try {
      let snapshot = await read();
      // 未来游标应立即409；过期游标由原消费者410，不为错误游标挂等待。
      if (snapshot.metadata.sync.cursor !== after || waitMs === 0) return snapshot;
      if (!subscription) {
        await pause(deadline - performance.now(), signal);
        return read();
      }
      for (;;) {
        const reason = await subscription.waitForChange(generation, deadline, signal);
        generation = subscription.generation();
        snapshot = await read();
        if (reason === "timeout" || snapshot.metadata.sync.cursor !== after) return snapshot;
        // 重复或无业务变化提示不能前移游标、提前伪报同步；沿原截止继续等待。
      }
    } finally { subscription?.close(); }
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/sync") {
      const hasCursor = url.searchParams.has("cursor");
      const after = integer(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
      const waitMs = integer(url.searchParams.get("waitMs"), 0, 0, MAX_WAIT_MS);
      if (after == null || waitMs == null) {
        return v1.error(res, 400, "同步游标或等待时间无效", "INVALID_SYNC_CURSOR");
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!res.writableEnded) abort(); };
      req.once?.("aborted", abort); res.once?.("close", close);
      if (req.aborted || res.destroyed) abort();
      let snapshot;
      try { snapshot = await snapshotAfter(after, waitMs, hasCursor, req, controller.signal); }
      catch (error) { if (controller.signal.aborted) return true; throw error; }
      finally { req.off?.("aborted", abort); res.off?.("close", close); }
      notifier?.assertActive();
      const { cursor, changes } = snapshot.metadata.sync;
      const oldest = changes[0]?.cursor || cursor + 1;
      if (after > cursor) {
        return v1.error(res, 409, "同步游标领先于服务器", "SYNC_CURSOR_AHEAD", { currentCursor: cursor });
      }
      if (hasCursor && after < oldest - 1) {
        return v1.error(res, 410, "同步游标已过期，需要重新读取完整状态", "SYNC_CURSOR_EXPIRED", {
          currentCursor: cursor,
          oldestCursor: oldest
        });
      }
      const pending = hasCursor ? changes.filter(change => change.cursor > after) : [];
      if (pending.length > MAX_INCREMENTAL_CHANGES) {
        return v1.error(res, 409, "待同步变更过多，需要重新读取完整状态", "SYNC_RESNAPSHOT_REQUIRED", {
          currentCursor: cursor,
          changeCount: pending.length
        });
      }
      const state = pending.length ? publicState(snapshot.document, undefined, pending.map(change => change.domain)) : {};
      return v1.success(res, 200, {
        cursor,
        changes: pending,
        snapshot: publicSnapshot(state, pending)
      });
    }

    const operation = url.pathname.match(/^\/api\/v1\/sync\/operations\/([A-Za-z0-9_.:-]{1,100})$/);
    if (req.method === "GET" && operation) {
      const operationId = operation[1];
      const fingerprint = url.searchParams.get("fingerprint") || "";
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        return v1.error(
          res,
          400,
          "操作指纹无效",
          "INVALID_OPERATION_FINGERPRINT",
          v1.operationFingerprintErrorDetails("format")
        );
      }
      const receipt = repository.readOperationReceipt
        ? await repository.readOperationReceipt(operationId)
        : (await repository.readSyncSnapshot()).metadata.sync.operations.find(item => item.operationId === operationId);
      if (receipt && receipt.fingerprint !== fingerprint) {
        return v1.error(res, 409, "同一操作标识不能用于不同请求", "OPERATION_ID_REUSED");
      }
      return v1.success(res, 200, {
        operationId,
        status: receipt ? "committed" : "unknown",
        ...(receipt ? {
          method: receipt.method,
          resource: receipt.resource,
          firstCursor: receipt.firstCursor,
          lastCursor: receipt.lastCursor,
          committedAt: receipt.committedAt,
          ...(receipt.businessIdMapping ? { businessIdMapping: receipt.businessIdMapping } : {}),
          responseAvailable: false
        } : {})
      });
    }
    return false;
  }

  const recordRegistry = createRecordSyncEntityRegistry({
    thoughtsComplete: Boolean(syncV2?.enabled && recordSync)
  });
  const recordRead = async (after, limit) => recordSync(async reader => {
    const page = await readRecordChangePage(reader.context, { after, limit });
    if (page.oversized) {
      throw Object.assign(new Error("单次记录变化超过批次上限，需要恢复当前范围"), {
        statusCode: 409,
        code: "SYNC_REBASE_REQUIRED",
        details: {
          currentCursor: page.highWaterCursor,
          rebaseRequired: true
        }
      });
    }
    const changes = await projectRecordChanges({
      rows: page.rows,
      reader,
      registry: recordRegistry
    });
    return {
      fromCursor: page.fromCursor,
      nextCursor: page.nextCursor,
      highWaterCursor: page.highWaterCursor,
      hasMore: page.hasMore,
      changes
    };
  });
  const recordRebase = input => recordSync(async reader => {
    const highWaterCursor = await readRecordSyncHead(reader.context);
    return rebaseRecordSyncScopes({
      reader,
      scopes: input.scopes,
      activeScopeKey: input.activeScopeKey,
      highWaterCursor,
      maximumScopes: syncV2.rebaseMaxScopes
    });
  });
  const assertRecordEnabled = () => {
    if (!syncV2?.enabled || typeof recordSync !== "function"
      || !syncV2.accountEnabled(getAccountId())) {
      throw Object.assign(new Error("记录级同步未对当前账户启用"), {
        statusCode: 404,
        code: "SYNC_V2_DISABLED"
      });
    }
  };
  const recordAfter = async (after, limit, waitMs, req, signal) => {
    const read = async () => {
      if (signal.aborted) throw aborted();
      await assertAccess(req);
      assertRecordEnabled();
      const batch = await recordRead(after, limit);
      await assertAccess(req);
      notifier?.assertActive();
      return batch;
    };
    const subscription = waitMs > 0 && notifier ? notifier.subscribeAccountCommits({
      accountId: getAccountId(),
      storageScope: repository.syncScope()
    }) : null;
    const deadline = performance.now() + waitMs;
    let generation = subscription?.generation();
    try {
      let batch = await read();
      if (batch.highWaterCursor !== after || waitMs === 0) return batch;
      if (!subscription) {
        await pause(deadline - performance.now(), signal);
        return read();
      }
      for (;;) {
        const reason = await subscription.waitForChange(generation, deadline, signal);
        generation = subscription.generation();
        batch = await read();
        if (reason === "timeout" || batch.highWaterCursor !== after) return batch;
      }
    } finally {
      subscription?.close();
    }
  };
  const recordError = (res, v1, error) => v1.error(
    res,
    Number(error.statusCode) || 500,
    error.message || "记录级同步失败",
    error.code || "SYNC_V2_FAILED",
    error.details
  );
  const withRecordAbort = async (req, res, operation) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once?.("aborted", abort);
    res.once?.("close", close);
    if (req.aborted || res.destroyed) abort();
    try {
      return await operation(controller.signal);
    } finally {
      req.off?.("aborted", abort);
      res.off?.("close", close);
    }
  };
  async function handleV2(req, res, url, v1) {
    if (!url.pathname.startsWith("/api/v2/sync")) return false;
    try {
      assertRecordEnabled();
      if (req.method === "GET" && url.pathname === "/api/v2/sync") {
        if (!url.searchParams.has("cursor")) {
          const currentCursor = await recordSync(reader => readRecordSyncHead(reader.context));
          return v1.error(res, 410, "同步游标缺失，需要恢复当前范围", "SYNC_CURSOR_MISSING", {
            currentCursor,
            rebaseRequired: true
          });
        }
        const after = integer(url.searchParams.get("cursor"), null, 0, Number.MAX_SAFE_INTEGER);
        const limit = integer(
          url.searchParams.get("limit"),
          syncV2.batchLimit,
          1,
          syncV2.batchHardLimit
        );
        const waitMs = integer(
          url.searchParams.get("waitMs"),
          0,
          0,
          syncV2.waitMsMax
        );
        if (after == null || limit == null || waitMs == null) {
          return v1.error(res, 400, "记录级同步参数无效", "INVALID_SYNC_CURSOR");
        }
        const batch = await withRecordAbort(req, res, signal => (
          recordAfter(after, limit, waitMs, req, signal)
        ));
        if (!batch) return true;
        return v1.success(res, 200, batch);
      }
      if (req.method === "POST" && url.pathname === "/api/v2/sync/rebase") {
        if (typeof bodyJson !== "function") {
          throw Object.assign(new Error("同步恢复读取器未装配"), {
            statusCode: 503,
            code: "SYNC_V2_UNAVAILABLE"
          });
        }
        await assertAccess(req);
        const input = await bodyJson(req);
        if (!input || typeof input !== "object" || Array.isArray(input)
          || !Array.isArray(input.scopes)) {
          return v1.error(res, 400, "同步恢复请求无效", "SYNC_REBASE_SCOPE_INVALID");
        }
        const response = await recordRebase({
          scopes: input.scopes,
          activeScopeKey: String(input.activeScopeKey || "")
        });
        await assertAccess(req);
        return v1.success(res, 200, response);
      }
      return false;
    } catch (error) {
      if (error?.code === "SYNC_WAIT_ABORTED") return true;
      return recordError(res, v1, error);
    }
  }

  return {
    handleV1: async (...args) => (
      await handleV2(...args) || handleV1(...args)
    )
  };
}
