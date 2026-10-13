import crypto from "node:crypto";
import { promptText, renderPrompt } from "../shared/prompts/index.mjs";
import {
  DEFAULT_RECORD_TIMEZONE,
  emptyHistoricalUserSupplement,
  estimateHistoricalUserSupplementOutputTokens,
  estimateHistoricalUserSupplementTokens,
  HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET,
  HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS,
  HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
  HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET,
  parseHistoricalUserSupplementOutput,
  parseRecordCompressionOutput,
  RECORD_COMPRESSION_INPUT_TEXT_BUDGET,
  RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN,
  RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT,
  RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
  RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET,
  RECORD_COMPRESSION_PROMPT_VERSION,
  RECORD_COMPRESSION_TASK_KIND,
  RECORD_COMPRESSION_WINDOW_DAYS,
  validateHistoricalUserSupplement
} from "../modules/record-compressions/index.mjs";
import { taskInputMatches, WAITING_FOR_BUDGET_STATUS } from "../modules/tasks/index.mjs";
import {
  COMPRESSION_SOURCE_COLLECTIONS,
  DAILY_OPERATION,
  HISTORICAL_SUPPLEMENT_OPERATION,
  RECORD_COMPRESSION_DAY_MS,
  currentHistoricalUserSources,
  currentTrendFrom,
  dateKeyInTimezone,
  dateKeyOffset,
  eligibleReadySummary,
  historicalCoverageAfterSave,
  historicalSupplementInputFrom,
  historicalTaskRange,
  inputForDate,
  list,
  objectValue,
  permittedHistoricalTextDates,
  sourceLocalDates,
  validLocalDate,
  validTimezone
} from "./record-compression-context.mjs";

export { DEFAULT_RECORD_TIMEZONE, RECORD_COMPRESSION_TASK_KIND };
const RECORD_COMPRESSION_SYSTEM_PROMPT_ID = "recordCompression.system.daily";
const RECORD_COMPRESSION_TASK_PROMPT_ID = "recordCompression.task.daily";
const HISTORICAL_SUPPLEMENT_SYSTEM_PROMPT_ID = "recordCompression.system.historicalSupplement";
const HISTORICAL_SUPPLEMENT_TASK_PROMPT_ID = "recordCompression.task.historicalSupplement";
export function recordCompressionAccountOrder(users, {
  globalDay,
  knownCalls = 0,
  reservedCalls = 0
} = {}) {
  const eligibleUsers = Array.isArray(users) ? users : [];
  if (!eligibleUsers.length) return { startingOffset: 0, orderedUsers: [] };

  const dayOrdinal = Math.floor(
    Date.parse(`${globalDay}T00:00:00.000Z`) / RECORD_COMPRESSION_DAY_MS
  );
  if (!Number.isFinite(dayOrdinal)) throw new TypeError("日压缩调度需要有效日期");
  const usedCallCount = [knownCalls, reservedCalls]
    .filter(Number.isFinite)
    .reduce((sum, count) => sum + Math.max(0, Math.trunc(count)), 0);
  const dateOffset = ((dayOrdinal % eligibleUsers.length) + eligibleUsers.length)
    % eligibleUsers.length;
  const callOffset = usedCallCount % eligibleUsers.length;
  const startingOffset = (dateOffset + callOffset) % eligibleUsers.length;

  return {
    startingOffset,
    orderedUsers: [
      ...eligibleUsers.slice(startingOffset),
      ...eligibleUsers.slice(0, startingOffset)
    ]
  };
}

export function createRecordCompressionService({
  repository,
  getAccountId = () => "local",
  getTimezone = () => DEFAULT_RECORD_TIMEZONE,
  now = () => new Date().toISOString(),
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  createId = () => crypto.randomUUID(),
  dailyBudgetCny = 0,
  perCallBudgetCny = 0,
  maxBackfillDatesPerScan = 1,
  startDate = "",
  readAiUsage = async () => ({ entries: [] }),
  maxTextChars = RECORD_COMPRESSION_INPUT_TEXT_BUDGET
} = {}) {
  if (!repository?.read || !repository?.update) {
    throw new TypeError("日压缩需要账户记录仓库");
  }
  if (!validTimezone(getTimezone())) {
    throw new TypeError("账户记录时区无效");
  }
  if (startDate && !validLocalDate(startDate)) throw new TypeError("日压缩起点日期无效");
  let settlementObserver = async () => {};
  const inRange = localDate => validLocalDate(localDate) && (!startDate || localDate >= startDate);
  const boundedStart = localDate => startDate && localDate < startDate ? startDate : localDate;
  const accountId = () => String(getAccountId() || "local");
  const timezone = () => {
    const value = getTimezone();
    return validTimezone(value) ? value : DEFAULT_RECORD_TIMEZONE;
  };
  const buildInput = (store, localDate, requestedTimezone = timezone(), asOf = now()) => {
    if (!validTimezone(requestedTimezone) || !inRange(localDate)
      || localDate > dateKeyInTimezone(asOf, requestedTimezone)) return null;
    return inputForDate(store, {
      accountId: accountId(),
      localDate,
      timezone: requestedTimezone,
      asOf,
      hash,
      maxTextChars
    });
  };
  const sourceStateFingerprint = store => hash(JSON.stringify({
    sources: COMPRESSION_SOURCE_COLLECTIONS.map(collection => [
      collection,
      list(store?.[collection]).map(({ audio, attachmentPaths, imageFiles, ...item }) => item)
    ]),
    permissions: list(store?.evidencePermissions)
      .filter(permission => permission?.accountId === accountId())
      .map(({ accountId: _accountId, sourceKey, contextAllowed, revision }) => ({
        sourceKey,
        contextAllowed,
        revision
      }))
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
  }));
  const taskBelongsToCurrentAccount = (store, task) => {
    const payload = task?.payload || {};
    let expectedInputHash;
    if (payload.operation === HISTORICAL_SUPPLEMENT_OPERATION) {
      expectedInputHash = hash(JSON.stringify({
        operation: HISTORICAL_SUPPLEMENT_OPERATION,
        accountId: accountId(),
        timezone: payload.timezone,
        promptVersion: payload.promptVersion,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
        batchIndex: Number.isSafeInteger(payload.batchIndex) ? payload.batchIndex : 0,
        sourceManifestHash: payload.sourceManifestHash
      }));
    } else {
      const input = buildInput(store, payload.localDate, payload.timezone, now());
      if (!input) return false;
      expectedInputHash = hash(JSON.stringify({
        accountId: input.accountKey,
        localDate: payload.localDate,
        timezone: payload.timezone,
        promptVersion: payload.promptVersion,
        sourceManifestHash: payload.sourceManifestHash
      }));
    }
    return task.requestedInputHash === expectedInputHash;
  };

  const target = {
    async settled(task) {
      const budgetDay = dateKeyInTimezone(now(), DEFAULT_RECORD_TIMEZONE);
      let entries;
      try {
        const usage = await readAiUsage();
        entries = list(usage?.entries).filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
          && dateKeyInTimezone(entry.createdAt, DEFAULT_RECORD_TIMEZONE) === budgetDay);
      } catch {
        await settlementObserver({ status: task.status, operation: task.payload?.operation || DAILY_OPERATION,
          localDate: task.payload?.localDate, taskId: task.id, costReadFailed: true });
        return;
      }
      const known = entries.filter(entry => entry.costKnown === true && Number.isFinite(entry.costCny));
      await settlementObserver({
        status: task.status, operation: task.payload?.operation || DAILY_OPERATION,
        localDate: task.payload?.localDate, taskId: task.id, errorCode: task.errorCode || "",
        knownSpentCny: known.reduce((sum, entry) => sum + entry.costCny, 0),
        knownCalls: entries.length, unknownCostCalls: entries.length - known.length
      });
    },
    prepare(store, task) {
      const operation = task?.payload?.operation || DAILY_OPERATION;
      if (operation === HISTORICAL_SUPPLEMENT_OPERATION) {
        const taskTimezone = task?.payload?.timezone;
        const promptVersion = task?.payload?.promptVersion;
        const localDate = task?.payload?.localDate;
        if (!inRange(localDate)
          || !validTimezone(taskTimezone)
          || taskTimezone !== timezone()
          || promptVersion !== HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION) return null;
        const windowEnd = validLocalDate(task?.payload?.windowEnd)
          ? task.payload.windowEnd
          : localDate;
        const windowStart = validLocalDate(task?.payload?.windowStart)
          ? task.payload.windowStart
          : dateKeyOffset(windowEnd, -(RECORD_COMPRESSION_WINDOW_DAYS - 1));
        if (!inRange(windowStart) || !inRange(windowEnd) || windowStart > windowEnd
          || windowEnd > dateKeyInTimezone(now(), taskTimezone)) return null;
        const batchIndex = Number.isSafeInteger(task?.payload?.batchIndex)
          ? task.payload.batchIndex
          : 0;
        const snapshotAsOf = typeof task?.payload?.inputAsOf === "string"
          && Number.isFinite(Date.parse(task.payload.inputAsOf))
          ? task.payload.inputAsOf
          : now();
        const snapshot = historicalSupplementInputFrom(store, {
          accountId: accountId(),
          timezone: taskTimezone,
          asOf: snapshotAsOf,
          hash,
          maxTextChars,
          windowStart,
          windowEnd,
          batchIndex
        });
        if (snapshot.input.input.userSources.length === 0
          || estimateHistoricalUserSupplementTokens(snapshot.input.input)
            > HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET
          || snapshot.sourceManifestHash !== task.payload.sourceManifestHash) return null;
        return {
          kind: RECORD_COMPRESSION_TASK_KIND,
          targetId: task.targetId,
          inputVersion: 1,
          inputHash: hash(JSON.stringify({
            operation,
            accountId: accountId(),
            timezone: taskTimezone,
            promptVersion,
            windowStart,
            windowEnd,
            batchIndex,
            sourceManifestHash: snapshot.sourceManifestHash
          })),
          prompt: renderPrompt(HISTORICAL_SUPPLEMENT_TASK_PROMPT_ID, {
            input: JSON.stringify(snapshot.input.input)
          }),
          systemPrompt: promptText(HISTORICAL_SUPPLEMENT_SYSTEM_PROMPT_ID),
          scene: RECORD_COMPRESSION_TASK_KIND,
          json: true,
          captureReasoning: false,
          maxTokens: HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET,
          historicalSupplementInput: snapshot.input,
          sourceManifestHash: snapshot.sourceManifestHash
        };
      }
      if (operation !== DAILY_OPERATION) return null;
      const localDate = task?.payload?.localDate;
      const taskTimezone = task?.payload?.timezone;
      const promptVersion = task?.payload?.promptVersion;
      if (!inRange(localDate)
        || !validTimezone(taskTimezone)
        || taskTimezone !== timezone()
        || promptVersion !== RECORD_COMPRESSION_PROMPT_VERSION) return null;
      const input = buildInput(store, localDate, taskTimezone, now());
      if (!input || !input.sourceManifest.some(source => ["user_original", "quoted_external"].includes(source.origin))) return null;
      if (eligibleReadySummary(store, localDate, taskTimezone, input)) return null;
      if (task.payload.sourceManifestHash !== input.sourceManifestHash) return null;
      const inputHash = hash(JSON.stringify({
        accountId: input.accountKey,
        localDate,
        timezone: taskTimezone,
        promptVersion,
        sourceManifestHash: input.sourceManifestHash
      }));
      return {
        kind: RECORD_COMPRESSION_TASK_KIND,
        targetId: task.targetId,
        inputVersion: 1,
        inputHash,
        prompt: renderPrompt(RECORD_COMPRESSION_TASK_PROMPT_ID, {
          input: JSON.stringify(input)
        }),
        systemPrompt: promptText(RECORD_COMPRESSION_SYSTEM_PROMPT_ID),
        scene: RECORD_COMPRESSION_TASK_KIND,
        json: true,
        captureReasoning: false,
        maxTokens: RECORD_COMPRESSION_OUTPUT_TOKEN_BUDGET,
        compressionInput: input,
        compressionId: task.payload.recordId,
        sourceManifestHash: input.sourceManifestHash,
        markQueued() {
          upsertCompression(store, {
            id: task.payload.recordId,
            localDate,
            timezone: taskTimezone,
            promptVersion,
            sourceManifestHash: input.sourceManifestHash,
            status: "queued",
            schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
            generatedAt: "",
            revision: 1,
            window: input.window,
            coverage: input.coverage,
            metrics: input.metrics,
            sourceManifest: input.sourceManifest
          });
        }
      };
    },
    waitingBudget(store, task) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) return;
      updateCompressionStatus(store, task, "queued", now);
    },
    started(store, task) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) return;
      updateCompressionStatus(store, task, "running", now);
    },
    save(store, work, task, generated) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) {
        const parsed = parseHistoricalUserSupplementOutput(generated?.content, {
          input: work.historicalSupplementInput,
          generatedAt: now()
        });
        const timezone = task.payload.timezone;
        const asOf = typeof task.payload.inputAsOf === "string"
          && Number.isFinite(Date.parse(task.payload.inputAsOf))
          ? task.payload.inputAsOf
          : now();
        const existingRecords = list(store?.historicalUserSupplement?.records);
        const validationSources = currentHistoricalUserSources(store, {
          accountId: accountId(), timezone, asOf, hash, maxTextChars
        }, [
          ...existingRecords.map(record => record?.source?.localDate),
          ...list(work.historicalSupplementInput?.input?.userSources)
            .map(source => source?.localDate)
        ]);
        const previous = validateHistoricalUserSupplement(store?.historicalUserSupplement, {
          userSources: validationSources.currentUserSources
        });
        const records = [];
        const identities = new Set();
        for (const record of [...previous.records, ...parsed.records]) {
          const identity = JSON.stringify([record.source.sourceId, record.exactQuote]);
          if (identities.has(identity) || records.length >= HISTORICAL_USER_SUPPLEMENT_MAX_RECORDS) continue;
          const candidate = [...records, record];
          if (estimateHistoricalUserSupplementOutputTokens(candidate) > HISTORICAL_USER_SUPPLEMENT_TOKEN_BUDGET) continue;
          identities.add(identity);
          records.push(record);
        }
        const coverage = historicalCoverageAfterSave(store, task, {
          accountId: accountId(), timezone, asOf, hash, maxTextChars, startDate
        });
        store.historicalUserSupplement = {
          ...parsed,
          records,
          coverage,
          tokenUsage: {
            estimated: true,
            scope: "model_output",
            tokens: estimateHistoricalUserSupplementOutputTokens(records)
          }
        };
        return HISTORICAL_SUPPLEMENT_OPERATION;
      }
      const previous = list(store.recordCompressions).find(item => item.id === task.payload.recordId);
      const revision = Math.max(1, Number(previous?.revision) || 1);
      const summary = parseRecordCompressionOutput(generated?.content, {
        input: work.compressionInput,
        id: task.payload.recordId,
        revision,
        generatedAt: now()
      });
      Object.assign(summary, {
        localDate: work.compressionInput.window.localDate,
        timezone: work.compressionInput.window.timezone,
        promptVersion: work.compressionInput.promptVersion,
        periodStart: work.compressionInput.window.start,
        periodEnd: work.compressionInput.window.endExclusive,
        sourceRefs: work.compressionInput.sourceManifest.map(source => ({
          sourceId: source.sourceId,
          resourceType: source.resourceType,
          recordId: source.recordId,
          rootId: source.rootId,
          targetKey: source.targetKey,
          version: source.version,
          sourceHash: source.sourceHash,
          permissionRevision: source.permissionRevision
        }))
      });
      upsertCompression(store, summary);
      return summary.id;
    },
    stale(store, task) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) return;
      const summary = list(store.recordCompressions).find(item => item.id === task.payload?.recordId);
      if (summary?.status === "failed") return;
      if (summary?.status === "ready") {
        if (!inRange(summary.localDate)) return;
        const input = buildInput(store, summary.localDate, summary.timezone, now());
        if (input && eligibleReadySummary(store, summary.localDate, summary.timezone, input)?.id === summary.id) return;
      }
      updateCompressionStatus(store, task, "invalidated", now);
    },
    fail(store, task) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) return;
      updateCompressionStatus(store, task, "failed", now);
    },
    result(store, task) {
      if (task?.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION) {
        return store.historicalUserSupplement || emptyHistoricalUserSupplement();
      }
      return list(store.recordCompressions).find(item => (
        item.id === task.resultId && item.status === "ready"
      )) || null;
    }
  };

  function attach(backgroundAi) {
    if (!backgroundAi?.enqueueInternal || !backgroundAi?.enqueueBudgetWaiting
      || !backgroundAi?.promoteInternalBudgetWaiting || !backgroundAi?.registerHandler) {
      throw new TypeError("日压缩需要后台 AI 队列");
    }
    backgroundAi.registerHandler(RECORD_COMPRESSION_TASK_KIND, target);
    const persistBudgetWait = async input => {
      const created = await backgroundAi.enqueueBudgetWaiting(input);
      if (created.task?.status === WAITING_FOR_BUDGET_STATUS) {
        return { waiting: true, taskId: created.task.id, registered: !created.duplicate };
      }
      if (created.duplicate) return { skipped: ["queued", "running"].includes(created.task?.status)
        ? "queued" : "previous-attempt-terminal", taskId: created.task?.id || "" };
      if (created.budgetQueueFull) return { skipped: "budget-wait-queue-full" };
      if (created.missing) return { skipped: "source-changed" };
      if (created.unsupported || created.invalid || created.conflict) {
        throw new Error("日压缩预算等待任务未能持久化");
      }
      return { skipped: "not-waiting" };
    };
    const remainingBudgetQueueCapacity = async () => {
      if (!(dailyBudgetCny > 0) || !Number.isFinite(dailyBudgetCny)
        || !(perCallBudgetCny > 0) || !Number.isFinite(perCallBudgetCny)) return 0;
      const current = await repository.read();
      const activeTasks = list(current.aiTasks).filter(task => (
        task.kind === RECORD_COMPRESSION_TASK_KIND
        && ["queued", "running"].includes(task.status)
      )).length;
      const budgetDay = dateKeyInTimezone(now(), DEFAULT_RECORD_TIMEZONE);
      const usage = await readAiUsage();
      const spent = list(usage?.entries)
        .filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
          && dateKeyInTimezone(entry.createdAt, DEFAULT_RECORD_TIMEZONE) === budgetDay)
        .reduce((sum, entry) => {
          if (entry.costKnown !== true || !Number.isFinite(entry.costCny)) return Number.POSITIVE_INFINITY;
          return sum + entry.costCny;
        }, 0);
      if (!Number.isFinite(spent)) return 0;
      const dailyBudgetMicros = Math.floor(dailyBudgetCny * 1_000_000);
      const perCallBudgetMicros = Math.ceil(perCallBudgetCny * 1_000_000);
      const spentMicros = Math.ceil(Math.max(0, spent) * 1_000_000);
      const reservedMicros = activeTasks * perCallBudgetMicros;
      return Math.max(0, Math.floor(
        (dailyBudgetMicros - spentMicros - reservedMicros) / perCallBudgetMicros
      ));
    };
    async function enqueueDate(localDate, taskTimezone = timezone(), { waitForBudget = false } = {}) {
      if (!inRange(localDate) || !validTimezone(taskTimezone)) return { skipped: "invalid-window" };
      const store = await repository.read();
      const input = buildInput(store, localDate, taskTimezone, now());
      if (!input || !input.sourceManifest.some(source => ["user_original", "quoted_external"].includes(source.origin))) return { skipped: "empty" };
      const staleSummaryIds = list(store.recordCompressions)
        .filter(summary => summary?.status === "ready"
          && summary.localDate === localDate
          && summary.timezone === taskTimezone
          && summary.sourceManifestHash !== input.sourceManifestHash)
        .map(summary => summary.id);
      if (staleSummaryIds.length) {
        await repository.update(current => {
          const staleIds = new Set(staleSummaryIds);
          for (const summary of list(current.recordCompressions)) {
            if (staleIds.has(summary.id)) invalidateCompressionSummary(summary, now());
          }
        });
      }
      const ready = eligibleReadySummary(store, localDate, taskTimezone, input);
      if (ready) return { skipped: "unchanged", summaryId: ready.id };
      const matchingTasks = list(store.aiTasks).filter(task => (
        task.kind === RECORD_COMPRESSION_TASK_KIND
        && task.payload?.operation === DAILY_OPERATION
        && task.payload?.localDate === localDate
        && task.payload?.timezone === taskTimezone
        && task.payload?.sourceManifestHash === input.sourceManifestHash
      ));
      const active = matchingTasks.find(task => ["queued", "running"].includes(task.status));
      if (active) return { skipped: "queued", taskId: active.id };
      const waiting = matchingTasks.find(task => task.status === WAITING_FOR_BUDGET_STATUS);
      if (waiting) return { waiting: true, taskId: waiting.id };
      const requestHash = hash(JSON.stringify({
        accountId: input.accountKey,
        localDate,
        timezone: taskTimezone,
        promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
        sourceManifestHash: input.sourceManifestHash
      }));
      const repairKey = `record-compression-repair-v1:${requestHash}`;
      const terminal = matchingTasks.find(task => ["failed", "stale", "cancelled", "succeeded"].includes(task.status));
      const repair = matchingTasks.find(task => task.clientRequestId === repairKey);
      if (repair) return { skipped: "previous-attempt-terminal", taskId: repair.id, errorCode: repair.errorCode || "" };
      const generationHash = terminal ? hash(repairKey) : requestHash;
      const compressionId = `rc-${generationHash.slice(0, 48)}`;
      const taskInput = {
        kind: RECORD_COMPRESSION_TASK_KIND,
        resourceType: RECORD_COMPRESSION_TASK_KIND,
        targetId: compressionId,
        inputVersion: 1,
        clientRequestId: terminal ? repairKey : `record-compression:${requestHash}`,
        payload: {
          operation: DAILY_OPERATION,
          localDate,
          timezone: taskTimezone,
          promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
          sourceManifestHash: input.sourceManifestHash,
          recordId: compressionId
        }
      };
      if (waitForBudget) return persistBudgetWait(taskInput);
      const activeTasks = list(store.aiTasks).filter(task => (
        task.kind === RECORD_COMPRESSION_TASK_KIND
        && ["queued", "running"].includes(task.status)
      ));
      const budgetDay = dateKeyInTimezone(now(), DEFAULT_RECORD_TIMEZONE);
      const usage = await readAiUsage();
      const spent = list(usage?.entries)
        .filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
          && dateKeyInTimezone(entry.createdAt, DEFAULT_RECORD_TIMEZONE) === budgetDay)
        .reduce((sum, entry) => {
          if (entry.costKnown !== true || !Number.isFinite(entry.costCny)) return Number.POSITIVE_INFINITY;
          return sum + entry.costCny;
        }, 0);
      const dailyBudgetMicros = Math.floor(dailyBudgetCny * 1_000_000);
      const perCallBudgetMicros = Math.ceil(perCallBudgetCny * 1_000_000);
      const spentMicros = Number.isFinite(spent)
        ? Math.ceil(Math.max(0, spent) * 1_000_000)
        : Number.POSITIVE_INFINITY;
      const reservedMicros = activeTasks.length * perCallBudgetMicros;
      if (!(dailyBudgetCny > 0) || !Number.isFinite(dailyBudgetCny)
        || !(perCallBudgetCny > 0) || !Number.isFinite(perCallBudgetCny)
        || spentMicros + reservedMicros + perCallBudgetMicros > dailyBudgetMicros) {
        return persistBudgetWait(taskInput);
      }
      const created = await backgroundAi.enqueueInternal(taskInput);
      if (created.task?.status === "queued" && !created.duplicate) return { queued: true, taskId: created.task.id };
      if (created.duplicate) return { skipped: ["queued", "running"].includes(created.task?.status)
        ? "queued" : "previous-attempt-terminal", taskId: created.task?.id || "" };
      if (created.missing) return { skipped: "source-changed" };
      if (created.unsupported || created.invalid || created.conflict) {
        throw new Error("日压缩任务未能加入后台队列");
      }
      return { skipped: "not-enqueued" };
    }

    async function enqueueHistoricalSupplement(taskTimezone = timezone(), scanAsOf = now(), {
      waitForBudget = false
    } = {}) {
      if (!validTimezone(taskTimezone) || taskTimezone !== timezone()) {
        return { skipped: "invalid-window" };
      }
      const store = await repository.read();
      const options = {
        accountId: accountId(),
        timezone: taskTimezone,
        asOf: scanAsOf,
        hash,
        maxTextChars
      };
      const tasks = list(store.aiTasks).filter(task => (
        task.kind === RECORD_COMPRESSION_TASK_KIND
        && task.payload?.operation === HISTORICAL_SUPPLEMENT_OPERATION
        && task.payload?.timezone === taskTimezone
        && task.payload?.promptVersion === HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION
        && inRange(task.payload?.localDate)
        && (() => {
          const range = historicalTaskRange(task, taskTimezone);
          return range && inRange(range.windowStart) && inRange(range.windowEnd)
            && range.windowEnd <= dateKeyInTimezone(scanAsOf, taskTimezone);
        })()
      ));
      const active = tasks.find(task => ["queued", "running"].includes(task.status));
      if (active) return { skipped: "queued", taskId: active.id };
      const waiting = tasks.find(task => task.status === WAITING_FOR_BUDGET_STATUS);
      if (waiting) return { waiting: true, taskId: waiting.id };
      const today = dateKeyInTimezone(scanAsOf, taskTimezone);
      if (!inRange(today)) return { skipped: "before-start-date" };
      const recentRange = {
        windowStart: boundedStart(dateKeyOffset(today, -(RECORD_COMPRESSION_WINDOW_DAYS - 1))),
        windowEnd: today,
        timezone: taskTimezone
      };
      const rangeMap = new Map([[JSON.stringify([recentRange.windowStart, recentRange.windowEnd]), recentRange]]);
      for (const task of tasks) {
        const range = historicalTaskRange(task, taskTimezone);
        if (range) rangeMap.set(JSON.stringify([range.windowStart, range.windowEnd]), range);
      }

      const enqueueSnapshot = async (snapshot, range, batchIndex, forceBudgetWait = false) => {
        if (!snapshot.input.input.userSources.length) return { skipped: "empty" };
        if (estimateHistoricalUserSupplementTokens(snapshot.input.input)
          > HISTORICAL_USER_SUPPLEMENT_INPUT_TOKEN_BUDGET) {
          return { skipped: "input-budget-exhausted" };
        }
        const localDate = today;
        const requestHash = hash(JSON.stringify({
          accountId: accountId(),
          operation: HISTORICAL_SUPPLEMENT_OPERATION,
          timezone: taskTimezone,
          promptVersion: HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
          windowStart: range.windowStart,
          windowEnd: range.windowEnd,
          batchIndex,
          sourceManifestHash: snapshot.sourceManifestHash
        }));
        const supplementId = `hus-${requestHash.slice(0, 48)}`;
        const taskInput = {
          kind: RECORD_COMPRESSION_TASK_KIND,
          resourceType: RECORD_COMPRESSION_TASK_KIND,
          targetId: supplementId,
          inputVersion: 1,
          clientRequestId: `historical-user-supplement:${requestHash}`,
          payload: {
            operation: HISTORICAL_SUPPLEMENT_OPERATION,
            localDate,
            timezone: taskTimezone,
            promptVersion: HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
            windowStart: range.windowStart,
            windowEnd: range.windowEnd,
            batchIndex,
            inputAsOf: scanAsOf,
            sourceManifestHash: snapshot.sourceManifestHash,
            recordId: supplementId
          }
        };
        if (forceBudgetWait) return persistBudgetWait(taskInput);
        const activeTasks = list(store.aiTasks).filter(task => (
          task.kind === RECORD_COMPRESSION_TASK_KIND
          && ["queued", "running"].includes(task.status)
        ));
        const budgetDay = dateKeyInTimezone(now(), DEFAULT_RECORD_TIMEZONE);
        const usage = await readAiUsage();
        const spent = list(usage?.entries)
          .filter(entry => entry?.scene === RECORD_COMPRESSION_TASK_KIND
            && dateKeyInTimezone(entry.createdAt, DEFAULT_RECORD_TIMEZONE) === budgetDay)
          .reduce((sum, entry) => {
            if (entry.costKnown !== true || !Number.isFinite(entry.costCny)) return Number.POSITIVE_INFINITY;
            return sum + entry.costCny;
          }, 0);
        const dailyBudgetMicros = Math.floor(dailyBudgetCny * 1_000_000);
        const perCallBudgetMicros = Math.ceil(perCallBudgetCny * 1_000_000);
        const spentMicros = Number.isFinite(spent)
          ? Math.ceil(Math.max(0, spent) * 1_000_000)
          : Number.POSITIVE_INFINITY;
        const reservedMicros = activeTasks.length * perCallBudgetMicros;
        if (!(dailyBudgetCny > 0) || !Number.isFinite(dailyBudgetCny)
          || !(perCallBudgetCny > 0) || !Number.isFinite(perCallBudgetCny)
          || spentMicros + reservedMicros + perCallBudgetMicros > dailyBudgetMicros) {
          return persistBudgetWait(taskInput);
        }
        const created = await backgroundAi.enqueueInternal(taskInput);
        if (created.task?.status === "queued" && !created.duplicate) return { queued: true, taskId: created.task.id };
        if (created.duplicate) return { skipped: ["queued", "running"].includes(created.task?.status)
          ? "queued" : "previous-attempt-terminal", taskId: created.task?.id || "" };
        if (created.missing) return { skipped: "source-changed" };
        if (created.unsupported || created.invalid || created.conflict) {
          throw new Error("历史稳定表达任务未能加入后台队列");
        }
        return { skipped: "not-enqueued" };
      };

      const completedRanges = [];
      for (const range of [...rangeMap.values()].sort((left, right) => (
        right.windowEnd.localeCompare(left.windowEnd)
        || right.windowStart.localeCompare(left.windowStart)
      ))) {
        const first = historicalSupplementInputFrom(store, { ...options, ...range, batchIndex: 0 });
        if (!first.allSourceIds.length) {
          completedRanges.push(range);
          continue;
        }
        const covered = new Set();
        let upstreamComplete = true;
        for (let batchIndex = 0; batchIndex < 1024; batchIndex += 1) {
          const snapshot = historicalSupplementInputFrom(store, {
            ...options,
            ...range,
            batchIndex
          });
          const batchSources = snapshot.input.input.userSources;
          if (!batchSources.length) break;
          upstreamComplete &&= snapshot.upstreamCoverageComplete;
          const exactTasks = tasks.filter(task => {
            const taskRange = historicalTaskRange(task, taskTimezone);
            return taskRange?.windowStart === range.windowStart
              && taskRange?.windowEnd === range.windowEnd
              && (Number.isSafeInteger(task.payload?.batchIndex) ? task.payload.batchIndex : 0) === batchIndex
              && task.payload?.sourceManifestHash === snapshot.sourceManifestHash;
          });
          if (exactTasks.some(task => task.status === "succeeded")) {
            for (const source of batchSources) covered.add(source.sourceId);
          } else {
            const terminal = exactTasks.find(task => ["failed", "stale"].includes(task.status));
            if (terminal) return { skipped: "previous-attempt-terminal", taskId: terminal.id };
            if (exactTasks.some(task => ["queued", "running"].includes(task.status))) {
              const activeTask = exactTasks.find(task => ["queued", "running"].includes(task.status));
              return { skipped: "queued", taskId: activeTask.id };
            }
          return enqueueSnapshot(snapshot, range, batchIndex, waitForBudget);
          }
          if (!snapshot.hasMoreBatches) break;
          if (batchIndex === 1023) return { skipped: "batch-limit" };
        }
        if (covered.size !== first.allSourceIds.length || !upstreamComplete) {
          return { skipped: "partial-source-coverage" };
        }
        completedRanges.push(range);
      }

      const deepestStart = completedRanges.length
        ? completedRanges.reduce((earliest, range) => (
          range.windowStart < earliest ? range.windowStart : earliest
        ), recentRange.windowStart)
        : recentRange.windowStart;
      const textDates = permittedHistoricalTextDates(store, options)
        .filter(localDate => localDate < deepestStart);
      if (!textDates.length) return { skipped: "unchanged" };
      const boundedTextDates = textDates.filter(inRange);
      if (!boundedTextDates.length) return { skipped: "unchanged" };
      const olderDate = boundedTextDates.at(-1);
      const candidateStart = dateKeyOffset(olderDate, -364);
      const range = {
        windowStart: boundedStart(candidateStart < boundedTextDates[0] ? boundedTextDates[0] : candidateStart),
        windowEnd: olderDate,
        timezone: taskTimezone
      };
      const snapshot = historicalSupplementInputFrom(store, { ...options, ...range, batchIndex: 0 });
      return enqueueSnapshot(snapshot, range, 0, waitForBudget);
    }

    async function scan({
      asOf = now(),
      slot = "evening",
      backfillDates = maxBackfillDatesPerScan,
      maxQueued = Number.POSITIVE_INFINITY
    } = {}) {
      const taskTimezone = timezone();
      const today = dateKeyInTimezone(asOf, taskTimezone);
      if (!inRange(today)) return { queued: false, queuedCount: 0, waitingBudgetCount: 0, skipped: "before-start-date" };
      const backfillCount = Math.max(0, Math.min(
        RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN,
        Math.floor(Number(backfillDates) || 0)
      ));
      const requestedQueueLimit = Number(maxQueued);
      const queueLimit = Number.isFinite(requestedQueueLimit)
        ? Math.max(0, Math.floor(requestedQueueLimit))
        : requestedQueueLimit === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : 0;
      const dateAtOffset = offset => {
        return dateKeyOffset(today, offset);
      };
      const existingTodaySummary = slot === "morning"
        && list((await repository.read()).recordCompressions).some(summary => (
          summary?.localDate === today && summary?.timezone === taskTimezone
        ));
      const primaryCandidates = (slot === "morning"
        ? [
          { localDate: dateAtOffset(-1) },
          ...(existingTodaySummary ? [{ localDate: today }] : [])
        ]
        : slot === "evening"
          ? [{ localDate: today }]
          : []).filter(candidate => inRange(candidate.localDate));
      const primaryDates = new Set(primaryCandidates.map(candidate => candidate.localDate));
      const queuedTaskIds = [];
      const waitingBudgetTaskIds = new Set();
      let promotedBudgetWaitCount = 0;
      let invalidatedBudgetWaitCount = 0;
      let primaryQueuedCount = 0;
      let backfillQueuedCount = 0;
      let backfillRegisteredCount = 0;
      let historicalSupplementQueuedCount = 0;
      let skippedBudgetWaitCount = 0;
      const observeBudgetWait = async result => {
        if (result?.skipped === "budget-wait-queue-full") {
          skippedBudgetWaitCount += 1;
          return;
        }
        if (!result?.waiting || !result.taskId) return;
        waitingBudgetTaskIds.add(result.taskId);
      };
      const waitingBudgetCount = async () => {
        const current = await repository.read();
        return list(current.aiTasks).filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
          && task.status === WAITING_FOR_BUDGET_STATUS).length;
      };

      // 即使预算为零，也先失效越界/来源变化的旧等待，避免占满等待登记容量。
      const validatedWaiting = await backgroundAi.promoteInternalBudgetWaiting(0);
      invalidatedBudgetWaitCount += validatedWaiting.invalidatedCount || 0;

      for (const candidate of primaryCandidates) {
        const candidatePromotions = await backgroundAi.promoteInternalBudgetWaiting(
          Math.min(
            Math.max(0, queueLimit - queuedTaskIds.length),
            await remainingBudgetQueueCapacity()
          ),
          { operation: DAILY_OPERATION, localDate: candidate.localDate }
        );
        const candidateTaskIds = list(candidatePromotions.taskIds);
        queuedTaskIds.push(...candidateTaskIds);
        primaryQueuedCount += candidateTaskIds.length;
        promotedBudgetWaitCount += candidatePromotions.queuedCount || 0;
        invalidatedBudgetWaitCount += candidatePromotions.invalidatedCount || 0;

        const waitForBudget = queuedTaskIds.length >= queueLimit;
        if (waitForBudget && await waitingBudgetCount() >= RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT) {
          skippedBudgetWaitCount += 1;
          continue;
        }
        const result = await enqueueDate(candidate.localDate, taskTimezone, { waitForBudget });
        if (result.queued || result.retried) {
          queuedTaskIds.push(result.taskId);
          primaryQueuedCount += 1;
        }
        await observeBudgetWait(result);
      }

      const candidateStore = await repository.read();
      const recentDates = Array.from({ length: RECORD_COMPRESSION_WINDOW_DAYS }, (_, offset) => dateAtOffset(-offset));
      const waitingDates = list(candidateStore.aiTasks)
        .filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND && task.status === WAITING_FOR_BUDGET_STATUS
          && task.payload?.operation === DAILY_OPERATION).map(task => task.payload.localDate);
      const backfillCandidates = [...new Set([
        ...recentDates, ...sourceLocalDates(candidateStore, taskTimezone, asOf), ...waitingDates
      ])].filter(localDate => inRange(localDate) && localDate <= today && !primaryDates.has(localDate))
        .sort((left, right) => right.localeCompare(left));
      for (const localDate of backfillCandidates) {
        if (backfillRegisteredCount >= backfillCount) break;
        const promotions = await backgroundAi.promoteInternalBudgetWaiting(
          Math.min(Math.max(0, queueLimit - queuedTaskIds.length), await remainingBudgetQueueCapacity(),
            backfillCount - backfillRegisteredCount),
          { operation: DAILY_OPERATION, localDate }
        );
        const promotedIds = list(promotions.taskIds);
        queuedTaskIds.push(...promotedIds);
        promotedBudgetWaitCount += promotions.queuedCount || 0;
        invalidatedBudgetWaitCount += promotions.invalidatedCount || 0;
        if (promotedIds.length) {
          backfillQueuedCount += promotedIds.length;
          backfillRegisteredCount += 1;
        }
        const waitForBudget = queuedTaskIds.length >= queueLimit;
        if (waitForBudget && await waitingBudgetCount() >= RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT) {
          skippedBudgetWaitCount += 1;
          break;
        }
        const result = await enqueueDate(localDate, taskTimezone, { waitForBudget });
        if (result.queued || result.retried) {
          queuedTaskIds.push(result.taskId);
          backfillQueuedCount += 1;
        }
        if (!promotedIds.length && (result.queued || result.retried || result.registered)) backfillRegisteredCount += 1;
        await observeBudgetWait(result);
      }

      const supplementPromotions = await backgroundAi.promoteInternalBudgetWaiting(
        Math.min(
          Math.max(0, queueLimit - queuedTaskIds.length),
          await remainingBudgetQueueCapacity()
        ),
        { operation: HISTORICAL_SUPPLEMENT_OPERATION }
      );
      queuedTaskIds.push(...list(supplementPromotions.taskIds));
      promotedBudgetWaitCount += supplementPromotions.queuedCount || 0;
      invalidatedBudgetWaitCount += supplementPromotions.invalidatedCount || 0;
      historicalSupplementQueuedCount += supplementPromotions.queuedCount || 0;

      if (queuedTaskIds.length < queueLimit
        || await waitingBudgetCount() < RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT) {
        const result = await enqueueHistoricalSupplement(taskTimezone, asOf, {
          waitForBudget: queuedTaskIds.length >= queueLimit
        });
        if (result.queued || result.retried) {
          queuedTaskIds.push(result.taskId);
          historicalSupplementQueuedCount += 1;
        }
        await observeBudgetWait(result);
      } else {
        skippedBudgetWaitCount += 1;
      }

      const queuedCount = queuedTaskIds.length;
      const pendingBudgetCount = await waitingBudgetCount();
      return {
        queued: queuedCount > 0,
        queuedCount,
        taskId: queuedTaskIds[0] || "",
        taskIds: queuedTaskIds,
        waitingBudgetCount: pendingBudgetCount,
        waitingBudgetTaskIds: [...waitingBudgetTaskIds],
        promotedBudgetWaitCount,
        invalidatedBudgetWaitCount,
        skippedBudgetWaitCount,
        primaryQueuedCount,
        backfillQueuedCount,
        backfillRegisteredCount,
        historicalSupplementQueuedCount,
        ...(queuedCount ? {} : { skipped: "no-work" })
      };
    }

    return { enqueueDate, enqueueHistoricalSupplement, scan };
  }

  return {
    target,
    attach,
    /**
     * 注册或替换真实终态观察器；在持久化之后调用，通知失败不改变已保存结果。
     * @since unreleased
     */
    observeSettlements(observer) {
      if (typeof observer !== "function") throw new TypeError("压缩终态观察需要函数");
      settlementObserver = async outcome => {
        try { await observer(outcome); } catch { /* 观察失败不得把已保存成功改成任务失败。 */ }
      };
    },
    buildInput,
    invalidateChangedSources(store, beforeStore) {
      if (sourceStateFingerprint(store) === sourceStateFingerprint(beforeStore)) return [];
      const staleRunningTaskIds = list(store?.aiTasks)
        .filter(task => task?.kind === RECORD_COMPRESSION_TASK_KIND && task.status === "running")
        .filter(task => taskBelongsToCurrentAccount(store, task))
        .filter(task => {
          try {
            return !taskInputMatches(task, target.prepare(store, task));
          } catch {
            return true;
          }
        })
        .map(task => task.id);
      const timestamp = now();
      const currentTimezone = timezone();
      const currentSupplementSources = currentHistoricalUserSources(store, {
        accountId: accountId(),
        timezone: currentTimezone,
        asOf: timestamp,
        hash,
        maxTextChars
      }, list(store?.historicalUserSupplement?.records).map(record => record?.source?.localDate))
        .currentUserSources;
      const historicalSupplement = validateHistoricalUserSupplement(
        store?.historicalUserSupplement,
        { userSources: currentSupplementSources }
      );
      if (historicalSupplement.invalidated.length) {
        store.historicalUserSupplement = {
          ...(store.historicalUserSupplement || emptyHistoricalUserSupplement()),
          records: historicalSupplement.records,
          coverage: {
            ...(store.historicalUserSupplement?.coverage || emptyHistoricalUserSupplement().coverage),
            complete: false
          },
          tokenUsage: {
            estimated: true,
            scope: "model_output",
            tokens: estimateHistoricalUserSupplementOutputTokens(historicalSupplement.records)
          }
        };
      }
      for (const summary of list(store?.recordCompressions)) {
        if (!summary || ["invalidated", "failed"].includes(summary.status) || !validLocalDate(summary.localDate)) continue;
        if (!inRange(summary.localDate)) continue;
        if (summary.timezone !== currentTimezone) {
          invalidateCompressionSummary(summary, timestamp);
          continue;
        }
        const previousInput = buildInput(beforeStore, summary.localDate, summary.timezone, timestamp);
        const currentInput = buildInput(store, summary.localDate, summary.timezone, timestamp);
        if (!currentInput
          || currentInput.sourceManifestHash !== summary.sourceManifestHash
          || (previousInput?.sourceManifestHash === summary.sourceManifestHash
            && previousInput.sourceManifestHash !== currentInput.sourceManifestHash)) {
          invalidateCompressionSummary(summary, timestamp);
        }
      }
      return staleRunningTaskIds;
    },
    getCurrentTrend(store, asOf = now()) {
      const currentAccountId = accountId();
      const currentTimezone = timezone();
      const result = currentTrendFrom(store, {
        accountId: currentAccountId,
        timezone: currentTimezone,
        asOf,
        hash,
        maxTextChars,
        startDate
      });
      return result;
    }
  };
}

function upsertCompression(store, value) {
  if (!Array.isArray(store.recordCompressions)) store.recordCompressions = [];
  const index = store.recordCompressions.findIndex(item => item.id === value.id);
  if (index < 0) store.recordCompressions.unshift(value);
  else store.recordCompressions[index] = value;
}

function invalidateCompressionSummary(summary, timestamp = new Date().toISOString()) {
  if (!summary || typeof summary !== "object") return;
  const retainedKeys = [
    "id", "version", "schemaVersion", "promptVersion", "localDate", "timezone",
    "revision", "generatedAt", "sourceManifestHash", "window", "periodStart", "periodEnd"
  ];
  const metadata = Object.fromEntries(retainedKeys
    .filter(key => Object.hasOwn(summary, key))
    .map(key => [key, summary[key]]));
  for (const key of Object.keys(summary)) delete summary[key];
  Object.assign(summary, metadata, {
    status: "invalidated",
    updatedAt: timestamp,
    invalidatedAt: timestamp,
    sourceManifest: [],
    sourceRefs: [],
    daily: { observations: [], metricKeys: [], missing: [] },
    thoughtsIdeas: { focus: [], changes: [], openQuestions: [] },
    other: { themes: [], collectedQuotes: [] },
    aiReference: [],
    stableUserCandidates: [],
    conflicts: [],
    warnings: [],
    coverage: {},
    metrics: [],
    tokenUsage: {}
  });
}

function updateCompressionStatus(store, task, status, now = () => new Date().toISOString()) {
  const recordId = task?.payload?.recordId;
  const summary = list(store.recordCompressions).find(item => item.id === recordId);
  if (!summary) return;
  if (status === "invalidated") {
    invalidateCompressionSummary(summary, now());
    return;
  }
  summary.status = status;
  summary.updatedAt = now();
  if (status === "failed") summary.invalidatedAt = "";
}

export function currentRecordCompressionTrend(store, options = {}) {
  const {
    accountId,
    timezone = DEFAULT_RECORD_TIMEZONE,
    asOf = new Date().toISOString(),
    hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
    maxTextChars = RECORD_COMPRESSION_INPUT_TEXT_BUDGET
  } = options;
  if (!objectValue(store) || !accountId || !validTimezone(timezone)) {
    throw new TypeError("七天趋势需要账户、存储和有效时区");
  }
  return currentTrendFrom(store, {
    accountId,
    timezone,
    asOf,
    hash,
    maxTextChars
  });
}
