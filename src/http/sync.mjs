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
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

export function createSyncHttp({ repository, publicState }) {
  if (!repository?.readSyncSnapshot || typeof publicState !== "function") {
    throw new TypeError("Sync HTTP requires a sync-capable repository and public state projector");
  }

  async function snapshotAfter(after, waitMs) {
    const snapshot = await repository.readSyncSnapshot();
    if (snapshot.metadata.sync.cursor > after || waitMs === 0) return snapshot;

    // 长轮询等待期间不反复占用数据库连接；写入后的即时拉取仍使用 waitMs=0。
    await pause(waitMs);
    return repository.readSyncSnapshot();
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/sync") {
      const hasCursor = url.searchParams.has("cursor");
      const after = integer(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
      const waitMs = integer(url.searchParams.get("waitMs"), 0, 0, MAX_WAIT_MS);
      if (after == null || waitMs == null) {
        return v1.error(res, 400, "同步游标或等待时间无效", "INVALID_SYNC_CURSOR");
      }
      const snapshot = await snapshotAfter(after, waitMs);
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
      const state = publicState(snapshot.document);
      return v1.success(res, 200, {
        cursor,
        changes: pending,
        snapshot: publicSnapshot(state, pending)
      });
    }

    const operation = url.pathname.match(/^\/api\/v1\/sync\/operations\/([A-Za-z0-9_.:-]{1,100})$/);
    if (req.method === "GET" && operation) {
      const snapshot = await repository.readSyncSnapshot();
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
      const receipt = snapshot.metadata.sync.operations.find(item => item.operationId === operationId);
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
