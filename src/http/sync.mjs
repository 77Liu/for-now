import { performance } from "node:perf_hooks";
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
  const snapshot = {};
  for (const domain of domains) {
    if (PUBLIC_DOMAINS.has(domain) && Object.hasOwn(state, domain)) {
      snapshot[domain] = structuredClone(state[domain]);
    }
  }
  if (domains.has("trash")) snapshot.trashCount = state.trashCount;
  if (domains.has("notifications") || domains.has("aiTasks")) {
    snapshot.notifications = structuredClone(state.notifications);
    snapshot.aiTasks = structuredClone(state.aiTasks);
    snapshot.notificationUnread = state.notificationUnread;
  }
  if (domains.has("speechCache")) {
    snapshot.speech = structuredClone(state.speech);
  }
  if ([...domains].some(domain => INSIGHT_DOMAINS.has(domain))) {
    snapshot.clusters = structuredClone(state.clusters);
    snapshot.insights = structuredClone(state.insights);
  }
  return snapshot;
}

/**
 * 同步游标/回执HTTP消费者，沿用持久状态与原错误协议。
 * 新增notifier/getAccountId/assertAccess（unreleased）只控制等待与资格复验；
 * 账户及存储作用域来自受信运行时，断连不撤销已经提交的写入。
 */
export function createSyncHttp({ repository, publicState, notifier = null, getAccountId, assertAccess = async () => {} }) {
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

  return { handleV1 };
}
