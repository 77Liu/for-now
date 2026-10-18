import crypto from "node:crypto";
import { readThoughtSpeechAssets } from "./speech-cache.mjs";
import { readNotificationUnread } from "../modules/notifications/index.mjs";
import { openingPreferences } from "../../public/frontend/shared/opening/index.mjs";
import path from "node:path";
import {
  createApiV1Http,
  createContentAttachmentsHttp,
  createLegacyApi,
  createOwnerHttp,
  createPersonalContextHttp,
  createReviewsChatHttp,
  createStartupHttp,
  createSyncHttp,
  openApiV1,
  registerApiV1
} from "../http/index.mjs";
import {
  capabilitiesFor,
  isOwner,
  publicUser
} from "../modules/auth/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import {
  architectureOwnerSurface,
  commercializationOwnerSurface
} from "../modules/owner-surfaces/index.mjs";
import { errorMetadata, pruneLogs } from "../shared/observability/index.mjs";
import {
  dateKeyInTimezone,
  eventTimeFields
} from "../shared/time/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import {
  recordCompressionAccountQueueAllowance,
  recordCompressionSlotQueueAllowance
} from "../config/index.mjs";
import { createRuntimeContentHttp } from "./runtime-content-http.mjs";
import { createRuntimePlatformHttp } from "./runtime-platform-http.mjs";
import { createStatisticsRuntime } from "./statistics-runtime.mjs";
import { normalizeCommercialization } from "./store-normalization.mjs";
import {
  DEFAULT_RECORD_TIMEZONE,
  recordCompressionAccountOrder,
  RECORD_COMPRESSION_TASK_KIND
} from "./record-compressions.mjs";
import {
  routeStateProjection,
  startupProjection
} from "./startup-projections.mjs";

export function createRetryableSlotRunner() {
  let lastCompletedSlot = "";
  let runningSlot = "";
  return async (slotKey, operation) => {
    if (slotKey === lastCompletedSlot || runningSlot) return { skipped: "outside-slot" };
    runningSlot = slotKey;
    try {
      const result = await operation();
      lastCompletedSlot = slotKey;
      return result;
    } finally {
      if (runningSlot === slotKey) runningSlot = "";
    }
  };
}

const countMetric = value => Number.isSafeInteger(value) ? Math.max(0, value) : 0;

export function createRecordCompressionScanObserver({
  logEvent,
  requestStorage,
  notify,
  now = () => Date.now()
} = {}) {
  if (typeof logEvent !== "function") throw new TypeError("压缩扫描观测需要 logEvent");
  const emit = (...args) => requestStorage?.run
    ? requestStorage.run({ secrets: [] }, () => logEvent(...args))
    : logEvent(...args);
  const send = async (title, lines) => {
    if (typeof notify !== "function") return;
    try {
      await notify({ title, lines });
    } catch (error) {
      await emit("system", "record_compression.notification_failed", {
        level: "warn",
        error: errorMetadata(error)
      });
    }
  };
  const observe = async function observe(scan) {
    const startedAt = now();
    await emit("system", "record_compression.scan_started", { level: "info" });
    await send("日压缩已启动", [`时间（上海）：${new Intl.DateTimeFormat("zh-CN", {
      timeZone: DEFAULT_RECORD_TIMEZONE,
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date(startedAt))}`]);
    try {
      const { result, metrics = {} } = await scan();
      const counts = {
        candidateCount: countMetric(metrics.candidateCount),
        queuedCount: countMetric(metrics.queuedCount),
        waitingCount: countMetric(metrics.waitingCount),
        skippedCount: countMetric(metrics.skippedCount),
        failureCount: 0,
        budgetExhaustedCount: countMetric(metrics.budgetExhaustedCount),
        durationMs: Math.max(0, countMetric(now() - startedAt))
      };
      if (counts.budgetExhaustedCount > 0) {
        await emit("system", "record_compression.budget_exhausted", {
          level: "warn",
          candidateCount: counts.candidateCount,
          budgetExhaustedCount: counts.budgetExhaustedCount
        });
      }
      await emit("system", "record_compression.scan_finished", {
        level: "info",
        ...counts
      });
      const summary = result || {};
      await send("日压缩扫描登记完成", [
        `排队：${countMetric(summary.queuedCount ?? summary.queued)}`,
        `等待预算：${countMetric(summary.waitingBudgetCount)}`,
        `跳过：${countMetric(summary.skippedCount ?? summary.skipped)}`,
        `耗时：${counts.durationMs}ms`
      ]);
      await send("日压缩扫描费用快照", [
        `扫描时已记录费用：¥${Number.isFinite(summary.knownSpentCny) ? summary.knownSpentCny.toFixed(4) : "未知"}`,
        `扫描时已预留预算：¥${Number.isFinite(summary.reservedCny) ? summary.reservedCny.toFixed(4) : "未知"}`,
        `已知调用：${countMetric(summary.knownCalls)}；预留调用：${countMetric(summary.reservedCalls)}`,
        countMetric(summary.queuedCount ?? summary.queued) || countMetric(summary.waitingBudgetCount)
          ? "任务待执行，生成结果与更新费用以真实终态通知为准。" : "本轮无生成任务。"
      ]);
      return result;
    } catch (error) {
      await emit("system", "record_compression.scan_failed", {
        level: "error",
        failureCount: 1,
        error: errorMetadata(error)
      });
      await send("日压缩扫描失败", ["请查看服务端观测日志。"]);
      throw error;
    }
  };
  // 此回调只在真实任务终态持久化后触发，费用来自完成后的实际usage读取。
  observe.settled = async outcome => {
    await emit("system", "record_compression.task_finished", { level: outcome.status === "succeeded" && outcome.summaryBudgetLevel !== "warn" ? "info" : "warn", ...outcome });
    const label = outcome.operation === "historicalSupplement" ? "历史补充" : "日摘要";
    const phase = outcome.status === "succeeded" ? "生成完成" : outcome.status === "failed" ? "生成失败" : "生成未完成";
    await send(`${label}${phase}`, [
      `日期：${outcome.localDate || "未知"}`,
      ...(outcome.windowKey ? [`增量窗口：${outcome.windowKey}`] : []),
      `状态：${outcome.status}`,
      ...(outcome.summaryBudgetLevel === "warn" ? [
        `内部摘要预算：WARN；合法结果已保存，估算${outcome.summaryTokens} tokens（一级${outcome.summaryWarnTokens}/二级${outcome.summaryHardTokens}）。资金预算不变。`
      ] : []),
      `该账户当日日压缩已记录费用：¥${Number.isFinite(outcome.knownSpentCny) ? outcome.knownSpentCny.toFixed(4) : "未知"}`,
      outcome.costReadFailed ? "当日费用记录读取失败，调用次数未知；已保存的任务终态不变。"
        : `该账户当日调用：${countMetric(outcome.knownCalls)}；费用未知调用：${countMetric(outcome.unknownCostCalls)}`
    ]);
  };
  return observe;
}

export function createRuntimeHttpWiring({
  appConfig,
  accountRuntime,
  syncNotifier,
  releaseVersion,
  paths,
  httpLimits,
  clock,
  identifiers,
  observability,
  persistence,
  aiRuntime,
  contentRuntime,
  domainServices,
  publicStateFromStore,
  access
}) {
  const { now, today } = clock;
  const { createId } = identifiers;
  const { requestStorage, logEvent } = observability;
  const recordTimezone = () => (
    requestStorage.getStore()?.user?.recordTimezone
    || DEFAULT_RECORD_TIMEZONE
  );
  const {
    storeRepository,
    storagePaths,
    readStore,
    updateStore
  } = persistence;
  const {
    ensureAiUsage,
    readAiUsage,
    readRecordCompressionBudget,
    aiCosts,
    ensureAuditLogs
  } = aiRuntime;
  const {
    chatRecords,
    reviewRecords,
    contentAttachmentService,
    reviewChatWorkflows,
    projectPersonalContext,
    maybeRunPeriodicAnalysis,
    runSpeechCacheSweep,
    runRecordCompressionScan,
    observeRecordCompressionTasks
  } = contentRuntime;
  const {
    sendJson,
    bodyJson,
    userDataDir,
    authService
  } = access;
  const readUsers = async () => {
    if (!appConfig.authRequired) return [{ id: "local" }];
    const users = [];
    let after = null;
    do {
      const page = await authService.scanUsersPage({ limit: 100, after });
      users.push(...page.users);
      after = page.next;
    } while (after);
    return users;
  };
  const platformHttp = createRuntimePlatformHttp({
    appConfig,
    httpLimits,
    clock,
    identifiers,
    observability,
    persistence,
    aiRuntime,
    contentRuntime,
    access
  });
  const contentHttp = createRuntimeContentHttp({
    clock,
    identifiers,
    observability,
    persistence,
    contentRuntime,
    domainServices,
    publicStateFromStore,
    access,
    platformHttp
  });
  const { statisticsService } = createStatisticsRuntime({
    repository: storeRepository,
    ensureAiUsage,
    readAiUsage,
    logsDirectory: () => storagePaths().logsDir,
    aiDashboard: (usage, from, to, cnyPerUsd, timezone) => (
      aiCosts.dashboard(usage, from, to, cnyPerUsd, timezone)
    ),
    today: timezone => dateKeyInTimezone(now(), timezone || recordTimezone()),
    getTimezone: recordTimezone
  });
  const ownerHttp = createOwnerHttp({
    architectureSurface: architectureOwnerSurface,
    commercializationSurface: commercializationOwnerSurface,
    normalizeCommercialization,
    statistics: statisticsService,
    readStore,
    updateStore,
    bodyJson,
    sendJson,
    now,
    today
  });
  const reviewsChatHttp = createReviewsChatHttp({
    chatRecords,
    reviewRecords,
    workflows: reviewChatWorkflows,
    statistics: statisticsService,
    remove: contentHttp.removeVersionedCollection,
    eventTimeFields,
    bodyJson,
    sendJson,
    sendTrashResult: platformHttp.sendTrashResult,
    canAccessOwner: () => isOwner(requestStorage.getStore()?.user)
  });
  const contentAttachmentsHttp = createContentAttachmentsHttp({
    contentAttachments: contentAttachmentService,
    bodyJson
  });
  const apiV1 = createApiV1Http({
    sendJson,
    getContext: () => requestStorage.getStore(),
    openApi: openApiV1,
    beforeHandle: async (req, url) => {
      if (["POST", "PATCH"].includes(req.method) && /^\/api\/v1\/(?:ai-tasks|thought-chains|journals|chats|analyses|annotations|importance)(?:\/|$)/.test(url.pathname)) {
        await contentRuntime.prepareImportanceContext();
      }
    }
  });
  const onboardingV2Handler = async (req, res, url, v1) => {
    const handled = await platformHttp.onboardingV2Http.handleV1(req, res, url, v1);
    if (handled !== false
      && req.method === "PATCH"
      && url.pathname === "/api/v1/onboarding-v2/session"
      && Number(res.statusCode || 200) < 400) {
      try {
        await contentRuntime.backgroundAi?.releaseWaiting?.();
      } catch (error) {
        await logEvent("system", "ai_task.waiting_release_failed", {
          level: "error",
          message: error?.message || String(error)
        });
      }
    }
    return handled;
  };
  const runRecordCompressionSlot = createRetryableSlotRunner();
  const observeRecordCompressionScan = createRecordCompressionScanObserver({
    logEvent,
    requestStorage,
    notify: appConfig.recordCompressionNotificationsEnabled
      && appConfig.feishuAlertWebhook
      ? async message => {
        const { createFeishuNotifier } = await import("../../.build/typescript/backend/shared/observability/feishu.mjs");
        return createFeishuNotifier({
          webhook: appConfig.feishuAlertWebhook,
          secret: appConfig.feishuAlertSecret
        })(message);
      }
      : undefined
  });
  observeRecordCompressionTasks?.(observeRecordCompressionScan.settled);

  async function runRecordCompressionScheduler() {
    if (!appConfig.recordCompressionEnabled) return { disabled: true };
    const timestamp = now();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
      timeZone: DEFAULT_RECORD_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    const slotKey = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    const due = (parts.hour === "06" && parts.minute === "00")
      || (parts.hour === "18" && parts.minute === "05");
    if (!due) return { skipped: "outside-slot" };
    return runRecordCompressionSlot(slotKey, () => observeRecordCompressionScan(async () => {
      const users = await readUsers();
      const eligibleUsers = (Array.isArray(users) ? users : []).filter(user => !accountRuntime?.enabled || accountRuntime.state(user.id)?.status === "ready");
      const globalDay = `${parts.year}-${parts.month}-${parts.day}`;
      const compressionBudgetState = typeof readRecordCompressionBudget === "function"
        ? await readRecordCompressionBudget()
        : null;
      const compressionBudgetDay = compressionBudgetState?.recordCompressionQuota?.days
        ?.find(item => item.key === globalDay);
      const compressionBudgetReservations = Array.isArray(compressionBudgetDay?.reservations)
        ? compressionBudgetDay.reservations
        : [];
      const compressionQuotaCalls = Math.max(0, Number(compressionBudgetDay?.calls) || 0);
      const compressionQuotaCostCny = Math.max(0, Number(compressionBudgetDay?.costMicros) || 0) / 1_000_000;
      const compressionQuotaReservedCalls = compressionBudgetReservations.reduce(
        (sum, item) => sum + Math.max(0, Number(item.calls) || 0),
        0
      );
      const compressionQuotaReservedCny = compressionBudgetReservations.reduce(
        (sum, item) => sum + Math.max(0, Number(item.costMicros) || 0),
        0
      ) / 1_000_000;
      const compressionQuotaTaskIds = new Set(compressionBudgetReservations
        .map(item => String(item.taskId || ""))
        .filter(Boolean));
      let knownCalls = 0;
      let reservedCalls = 0;
      let knownSpentCny = 0;
      let reservedCny = 0;
      let queued = 0;
      let skipped = 0;
      let budgetExhaustedCount = 0;
      let waitingBudgetCount = 0;
      let promotedBudgetWaitCount = 0;
      let invalidatedBudgetWaitCount = 0;
      let skippedBudgetWaitCount = 0;
      const accountUsageById = new Map();
      const activeTaskIds = new Set();
      let newlyQueuedCalls = 0;
      const contextFor = user => ({
        user,
        traceId: createId(),
        dataDir: appConfig.authRequired ? userDataDir(user) : paths.dataDir,
        secrets: [],
        route: "background/record-compression"
      });
      const runAccountScan = (user, operation) => requestStorage.run(contextFor(user), () =>
        accountRuntime?.enabled ? accountRuntime.withOperation(operation) : operation());
      for (const user of eligibleUsers) {
        const accountUsage = await runAccountScan(user, async () => {
          const [usage, store] = await Promise.all([readAiUsage(), readStore()]);
          const dailyEntries = (Array.isArray(usage?.entries) ? usage.entries : [])
            .filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
              && Number.isFinite(Date.parse(entry.createdAt))
              && new Intl.DateTimeFormat("en-CA", {
                timeZone: DEFAULT_RECORD_TIMEZONE,
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
              }).format(new Date(entry.createdAt)) === globalDay);
          const accountSpent = dailyEntries
            .reduce((sum, entry) => {
              if (entry.costKnown !== true || !Number.isFinite(entry.costCny)) {
                return Number.POSITIVE_INFINITY;
              }
              return sum + entry.costCny;
            }, 0);
          const activeTasks = (Array.isArray(store?.aiTasks) ? store.aiTasks : [])
            .filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
              && ["queued", "running"].includes(task.status));
          return {
            accountSpent,
            activeTasks: activeTasks.length,
            activeTaskIds: activeTasks.map(task => String(task.id || "")).filter(Boolean),
            invocations: dailyEntries.length
          };
        });
        accountUsageById.set(String(user.id || "local"), accountUsage);
        for (const taskId of accountUsage.activeTaskIds) activeTaskIds.add(taskId);
        knownSpentCny += accountUsage.accountSpent;
        knownCalls += accountUsage.invocations;
        reservedCny += accountUsage.activeTasks * appConfig.recordCompressionPerCallBudgetCny;
        reservedCalls += accountUsage.activeTasks;
      }
      const dailyCapacity = appConfig.recordCompressionDailyInvocationLimit;
      const perCallBudgetCny = appConfig.recordCompressionPerCallBudgetCny;
      const unreservedActiveTasks = [...activeTaskIds]
        .filter(taskId => !compressionQuotaTaskIds.has(taskId)).length;
      const maxCallsForBudget = remainingCny => {
        if (!(perCallBudgetCny > 0) || !Number.isFinite(remainingCny)) return 0;
        const remainingMicros = Math.floor(Math.max(0, remainingCny) * 1_000_000);
        const perCallMicros = Math.ceil(perCallBudgetCny * 1_000_000);
        return perCallMicros > 0 ? Math.floor(remainingMicros / perCallMicros) : 0;
      };
      const { orderedUsers } = recordCompressionAccountOrder(eligibleUsers, {
        globalDay,
        knownCalls,
        reservedCalls
      });
      for (let index = 0; index < orderedUsers.length; index += 1) {
        const user = orderedUsers[index];
        const accountUsage = accountUsageById.get(String(user.id || "local")) || {
          invocations: 0,
          activeTasks: 0
        };
        const globalReservedCalls = compressionQuotaReservedCalls
          + unreservedActiveTasks + newlyQueuedCalls;
        const remainingCalls = Math.max(0,
          dailyCapacity - Math.max(knownCalls, compressionQuotaCalls) - globalReservedCalls
        );
        const accountRemainingCalls = recordCompressionAccountQueueAllowance({
          dailyLimit: appConfig.recordCompressionAccountDailyInvocationLimit,
          knownCalls: accountUsage.invocations,
          reservedCalls: accountUsage.activeTasks
        });
        const remainingBudget = appConfig.recordCompressionDailyBudgetCny
          - Math.max(knownSpentCny, compressionQuotaCostCny)
          - compressionQuotaReservedCny
          - (unreservedActiveTasks + newlyQueuedCalls) * perCallBudgetCny;
        const availableQueueAllowance = Math.min(
          remainingCalls,
          accountRemainingCalls,
          maxCallsForBudget(remainingBudget)
        );
        if (accountRemainingCalls > 0
          && (remainingCalls === 0 || maxCallsForBudget(remainingBudget) === 0)) {
          budgetExhaustedCount += 1;
        }
        const slot = parts.hour === "06" ? "morning" : "evening";
        const maxQueued = recordCompressionSlotQueueAllowance(slot, availableQueueAllowance);
        const scanResult = await runAccountScan(user, () => (
          runRecordCompressionScan({ asOf: timestamp, slot, maxQueued })
        ));
        waitingBudgetCount += Number.isSafeInteger(scanResult?.waitingBudgetCount)
          ? Math.max(0, scanResult.waitingBudgetCount)
          : 0;
        promotedBudgetWaitCount += Number.isSafeInteger(scanResult?.promotedBudgetWaitCount)
          ? Math.max(0, scanResult.promotedBudgetWaitCount)
          : 0;
        invalidatedBudgetWaitCount += Number.isSafeInteger(scanResult?.invalidatedBudgetWaitCount)
          ? Math.max(0, scanResult.invalidatedBudgetWaitCount)
          : 0;
        skippedBudgetWaitCount += Number.isSafeInteger(scanResult?.skippedBudgetWaitCount)
          ? Math.max(0, scanResult.skippedBudgetWaitCount)
          : 0;
        const accountQueued = Number.isSafeInteger(scanResult?.queuedCount)
          ? Math.max(0, scanResult.queuedCount)
          : (scanResult?.queued || scanResult?.retried ? 1 : 0);
        if (accountQueued) {
          queued += accountQueued;
          newlyQueuedCalls += accountQueued;
          reservedCalls += accountQueued;
          reservedCny += accountQueued * perCallBudgetCny;
        } else if (!scanResult?.waitingBudgetCount) {
          skipped += 1;
        }
      }
      return {
        result: {
          slotKey,
          queued,
          queuedCount: queued,
          waitingBudgetCount,
          promotedBudgetWaitCount,
          invalidatedBudgetWaitCount,
          skippedBudgetWaitCount,
          skipped,
          knownCalls,
          reservedCalls,
          knownSpentCny,
          reservedCny
        },
        metrics: {
          candidateCount: eligibleUsers.length,
          queuedCount: queued,
          waitingCount: waitingBudgetCount,
          skippedCount: skipped + skippedBudgetWaitCount,
          budgetExhaustedCount
        }
      };
    }));
  }
  const readOpeningPreferences = async user => {
    if (!isOwner(user)) return undefined;
    try { return openingPreferences((await aiRuntime.readLlmSettings()).opening); }
    catch { return openingPreferences(); }
  };
  const readThoughtRoute = async route => {
    const queries = contentRuntime.thoughtQueries;
    const query = route.query || {};
    const unread = await storeRepository.queryRecords(readNotificationUnread);
    const speechFor = async ids => {
      const speech = publicStateFromStore({ speechCache: [] }, undefined, ["speechCache"]).speech;
      const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
      const sourceReceipts = await queries.speechSources(ids);
      speech.assets = await readThoughtSpeechAssets(storeRepository, sourceReceipts, {
        ownerHash: hash(safeText(requestStorage.getStore()?.user?.id, 100) || "local"),
        currentTime: now(), hash
      });
      return speech;
    };
    if (route.resourceId) {
      const detail = await queries.detail(route.resourceId);
      const { blocks = [], ...root } = detail || {};
      return { notificationUnread: unread, speech: await speechFor(detail ? [root.id] : []),
        thoughts: detail ? [root, ...blocks] : [],
        thoughtPage: { kind: "detail", found: Boolean(detail), nextId: "", query: query.q || "", page: 1 } };
    }
    const page = await queries.list({
      afterId: query.thoughtAfterId || "", direction: query.direction || "next",
      query: query.q || "", tag: query.tag || "", sort: query.sort,
    });
    return { notificationUnread: unread, speech: await speechFor(page.items.map(item => item.id)),
      thoughts: page.items, thoughtPage: {
      kind: "list", nextId: page.nextId, prevId: page.prevId, tags: page.tags,
      requestCursor: query.cursor || "", direction: query.direction || "next",
      query: query.q || "", tag: query.tag || "", sort: query.sort === "created" ? "created" : "occurred", page: 1
    } };
  };
  const startupHttp = createStartupHttp({
    readStartup: async () => {
      const store = await readStore();
      const user = requestStorage.getStore()?.user;
      return startupProjection({
        store,
        user: publicUser(user),
        version: appConfig.version,
        releaseVersion,
        openingPreferences: await readOpeningPreferences(user),
        capabilities: capabilitiesFor(user),
        features: appConfig.features,
        governanceUrl: isOwner(user) && appConfig.platform.serviceTokenHash
          ? "/platform/"
          : "",
        unread: notificationUnread(store.notifications)
      });
    },
    readRouteState: async route => {
      const projection = route.view === "thoughts" && contentRuntime.thoughtQueries?.enabled
        ? await readThoughtRoute(route)
        : routeStateProjection(publicStateFromStore(await readStore()), {
            ...route, currentDate: today(),
            cursorScope: safeText(requestStorage.getStore()?.user?.id, 100) || "local"
          });
      return { ...projection, _routeProjection: { view: route.view, complete: false } };
    }
  });
  const syncHttp = createSyncHttp({
    repository: storeRepository,
    publicState: publicStateFromStore,
    notifier: syncNotifier,
    getAccountId: () => accountRuntime.currentAccountId(),
    assertAccess: async req => {
      const id = requestStorage.getStore()?.user?.id;
      const auth = access.localTestRuntime.enabled
        ? access.localTestHttp.authentication(req)
        : await access.requestAuthentication(req);
      if (!auth.user || auth.user.id !== id || auth.reauthRequired) throw Object.assign(new Error("会话已失效，请重新登录"), {
        code: auth.reauthRequired ? "AUTH_REAUTH_REQUIRED" : "AUTH_REQUIRED", statusCode: 401
      });
      accountRuntime.authorize();
    }
  });
  const personalContextHttp = createPersonalContextHttp({
    readStore,
    project: store => projectPersonalContext(store, {
      includeOwnerMetadata: isOwner(requestStorage.getStore()?.user)
    })
  });
  registerApiV1(apiV1, {
    startup: startupHttp.handleV1,
    sync: syncHttp.handleV1,
    personalContext: personalContextHttp.handleV1,
    importance: contentHttp.importanceHttp.handleV1,
    aiBudget: platformHttp.aiBudgetHttp.handleV1,
    onboardingV2: onboardingV2Handler,
    userModel: platformHttp.userModelHttp.handleV1,
    thoughts: contentHttp.thoughtHttp.handleV1,
    checkins: contentHttp.checkinHttp.handleV1,
    health: contentHttp.healthRecordHttp.handleV1,
    discovery: contentHttp.discoveryHttp.handleV1,
    exports: contentHttp.exportHttp.handleV1,
    actions: contentHttp.actionsHttp.handleV1,
    feedback: contentHttp.feedbackHttp.handleV1,
    capturesJournals: contentHttp.captureJournalHttp.handleV1,
    library: contentHttp.libraryHttp.handleV1,
    reviewsChat: reviewsChatHttp.handleV1,
    contentAttachments: contentAttachmentsHttp.handleV1
  });

  async function runPeriodicAnalyses() {
    const users = await readUsers();
    for (const user of users) {
      if (accountRuntime?.enabled && accountRuntime.state(user.id)?.status !== "ready") continue;
      const run = async () => { await ensureAuditLogs(); await maybeRunPeriodicAnalysis(); };
      await requestStorage.run({
        user,
        traceId: createId(),
        dataDir: appConfig.authRequired ? userDataDir(user) : paths.dataDir,
        secrets: [],
        route: "background/analysis"
      }, () => accountRuntime?.enabled ? accountRuntime.withOperation(run) : run());
    }
    await pruneLogs(
      path.join(paths.dataDir, "logs"),
      appConfig.audit.retentionDays
    );
  }

  const legacyApi = createLegacyApi({
    beforeHandle: async (req, url) => {
      if (["POST", "PATCH"].includes(req.method) && /^\/api\/(?:ai-tasks|thoughts|journals|chat|analysis|annotations)(?:\/|$)/.test(url.pathname)) {
        await contentRuntime.prepareImportanceContext();
      }
    },
    beforeStateHandlers: [
      reviewsChatHttp.handle,
      contentHttp.captureJournalHttp.handle,
      contentHttp.libraryHttp.handle,
      platformHttp.speechHttp.handle,
      platformHttp.visionHttp.handle,
      platformHttp.aiCostHttp.handle,
      platformHttp.aiSettingsHttp.handle,
      platformHttp.onboardingHttp.handle,
      platformHttp.taskHttp.handle,
      platformHttp.trashHttp.handle,
      platformHttp.attachmentHttp.handle,
      platformHttp.keepsakeHttp.handle
    ],
    afterStateHandlers: [
      contentHttp.imageRecognitionHttp.handle,
      contentHttp.healthRecordHttp.handle,
      contentHttp.checkinHttp.handle,
      contentHttp.thoughtHttp.handle,
      platformHttp.annotationHttp
    ],
    readMeta: async () => {
      const user = requestStorage.getStore()?.user;
      return {
        version: appConfig.version,
        releaseVersion,
        user: publicUser(user),
        ...(isOwner(user) ? { openingPreferences: await readOpeningPreferences(user) } : {}),
        capabilities: capabilitiesFor(user),
        features: appConfig.features,
        governanceUrl: isOwner(user) && appConfig.platform.serviceTokenHash
          ? "/platform/"
          : ""
      };
    },
    readState: async () => publicStateFromStore(await readStore()),
    sendJson
  });

  return {
    apiV1,
    isOwner,
    ownerHttp,
    legacyApi,
    attachmentHttp: platformHttp.attachmentHttp,
    runPeriodicAnalyses,
    runRecordCompressionScheduler,
    runSpeechCacheSweep
  };
}
