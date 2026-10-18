import {
  isInternalAiTask,
  taskInputMatches,
  publicAiTask,
  WAITING_FOR_BUDGET_STATUS,
  WAITING_FOR_USER_MODEL_STATUS
} from "../modules/tasks/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import {
  RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT,
  RECORD_COMPRESSION_TASK_KIND
} from "../modules/record-compressions/index.mjs";
import { compactPersonalContextReceipt } from "./personal-context.mjs";
import { aiTaskTargetReference } from "../shared/persistence/index.mjs";

const INTERNAL_RECOVERY_LIMIT = 2;

export function createBackgroundAi({
  repository,
  tasks,
  notifications,
  targets,
  generate,
  dispatch,
  contextKey,
  now = () => new Date().toISOString(),
  onError,
  shouldWaitForModel = () => false,
  beforePrepare = async () => {},
  inspectIntent = targets?.inspectIntent,
  cleanupExistingTask = null,
  recordCommands = null
}) {
  const internalKinds = new Set(["perceptionExtraction", RECORD_COMPRESSION_TASK_KIND]);
  const taskHandlers = new Map();
  const dynamicRecordCommands = new Map();
  const running = new Set();
  const controllers = new Map();
  const recordWritebackFor = kind => {
    if (["thoughtAnswer", "followUpAnswer"].includes(kind)) {
      return dynamicRecordCommands.get("thought.aiWriteback");
    }
    if (["contentImageUnderstanding", "annotationShenji"].includes(kind)) {
      return dynamicRecordCommands.get("content.aiWriteback");
    }
    return null;
  };
  const enabledRecordCommand = (name, command) => {
    if (!recordCommands?.enabled?.(name)) return null;
    if (typeof command !== "function") {
      throw new TypeError(`Record command ${name} is enabled without an implementation`);
    }
    return command;
  };
  const readNotificationRecord = enabledRecordCommand(
    "notification.read",
    recordCommands?.notifications?.read
  );
  const readAllNotificationsRecord = enabledRecordCommand(
    "notification.readAll",
    recordCommands?.notifications?.readAll
  );
  const cancelTaskRecord = enabledRecordCommand(
    "task.status",
    recordCommands?.tasks?.cancel
  );
  const bindTaskInputRecord = [
    "thought.create",
    "thought.aiWriteback",
    "task.status"
  ].some(name => recordCommands?.enabled?.(name))
    ? recordCommands?.tasks?.bindInput
    : null;
  if (bindTaskInputRecord !== null && typeof bindTaskInputRecord !== "function") {
    throw new TypeError("Deferred task input binding is enabled without an implementation");
  }
  const notify = (store, task, status, message) => (
    task.internal === true
      ? null
      : notifications.upsertTask(store.notifications, task, status, message)
  );
  const notifyCreated = (store, created) => {
    if (created.task && !created.duplicate) {
      const waiting = created.task.status === WAITING_FOR_USER_MODEL_STATUS;
      notify(
        store,
        created.task,
        waiting ? WAITING_FOR_USER_MODEL_STATUS : "queued",
        waiting ? "等待核心用户模型就绪" : "已进入后台队列"
      );
    }
    return created;
  };
  const visibleNotifications = store => {
    const internalTaskIds = new Set((store.aiTasks || [])
      .filter(isInternalAiTask)
      .map(task => task.id));
    return (store.notifications || []).filter(item => !internalTaskIds.has(item.taskId));
  };
  const inspectRequestedIntent = (store, input) => {
    const inspector = taskHandlers.get(input?.kind)?.inspectIntent || inspectIntent;
    if (typeof inspector !== "function") return null;
    const value = inspector(store, input);
    return value && typeof value === "object" ? value : null;
  };
  const targetFor = task => taskHandlers.get(task?.kind) || targets;
  const prepareTarget = (store, task) => targetFor(task).prepare(store, task);
  const taskInputsCurrent = (store, task) => {
    try {
      return taskInputMatches(task, prepareTarget(store, task));
    } catch {
      return false;
    }
  };
  const refreshQueuedTaskInputs = (store, taskIds) => {
    for (const taskId of taskIds) {
      const task = store.aiTasks.find(item => item.id === taskId);
      if (!task || task.status !== "queued") continue;
      const work = prepareTarget(store, task);
      if (!work
        || (work.inputVersion || 0) !== task.inputVersion
        || (work.subtargetVersion || 0) !== (task.subtargetVersion || 0)) continue;
      task.inputHash = work.inputHash || "";
      task.requestedInputHash = work.inputHash || "";
    }
  };
  const requestedIntentMatchState = (task, intent) => {
    const hasIntent = Object.hasOwn(task, "requestedIntentInputVersion")
      || Object.hasOwn(task, "requestedIntentSubtargetVersion")
      || Object.hasOwn(task, "requestedIntentInputHash");
    if (!intent || typeof intent !== "object") return "uninspectable";
    const expectedInputVersion = hasIntent && Object.hasOwn(task, "requestedIntentInputVersion")
      ? task.requestedIntentInputVersion
      : task.requestedInputVersion;
    const expectedSubtargetVersion = hasIntent && Object.hasOwn(task, "requestedIntentSubtargetVersion")
      ? task.requestedIntentSubtargetVersion
      : task.requestedSubtargetVersion;
    const hasInputVersion = (hasIntent && Object.hasOwn(task, "requestedIntentInputVersion"))
      || Object.hasOwn(task, "requestedInputVersion");
    const hasSubtargetVersion = (hasIntent && Object.hasOwn(task, "requestedIntentSubtargetVersion"))
      || Object.hasOwn(task, "requestedSubtargetVersion");
    if (hasInputVersion && Math.max(0, Number(intent.inputVersion) || 0) !== expectedInputVersion) return "input-version-mismatch";
    if (hasSubtargetVersion && Math.max(0, Number(intent.subtargetVersion) || 0) !== expectedSubtargetVersion) return "subtarget-version-mismatch";
    if (hasIntent && Object.hasOwn(task, "requestedIntentInputHash")
      && String(intent.inputHash ?? "") !== task.requestedIntentInputHash) return "input-hash-mismatch";
    return "matched";
  };
  const requestedIntentMatches = (task, intent) => requestedIntentMatchState(task, intent) === "matched";
  const createInStore = (
    store,
    input = {},
    { waitingBudget = false, deferInputBinding = false } = {}
  ) => {
    if (waitingBudget) {
      const existing = store.aiTasks.find(task => task.clientRequestId === input?.clientRequestId);
      const pending = store.aiTasks.filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
        && task.status === WAITING_FOR_BUDGET_STATUS).length;
      if (!existing && pending >= RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT) {
        return { budgetQueueFull: true };
      }
    }
    const waiting = Boolean(shouldWaitForModel(store, input));
    const requestedIntent = waiting ? inspectRequestedIntent(store, input) : null;
    if (waiting && !requestedIntent) return { missing: true };
    return notifyCreated(store, tasks.create(
      store.aiTasks,
      input,
      task => prepareTarget(store, task),
      {
        deferTargetInspection: waiting,
        deferInputBinding: deferInputBinding && !waiting,
        requestedIntent,
        waitingBudget,
        allocateIdentity: task => targetFor(task).allocateIdentity?.(store, task) }
    ));
  };
  const schedule = taskId => dispatch(() => run(taskId).catch(error => onError(taskId, error)));
  const stale = (store, task, message) => {
    targetFor(task).stale?.(store, task);
    tasks.complete(task, "stale", {
      error: "目标已修改或删除",
      errorCode: "AI_TASK_STALE"
    });
    notify(store, task, "stale", message);
  };
  const taskHasRequiredTarget = (store, task) => {
    const target = aiTaskTargetReference(store, task);
    return (!target?.requiresExistingTarget || target.exists)
      && (!target?.requiresExistingSubtarget || target.subtargetExists);
  };
  const cancelled = (store, task) => {
    targetFor(task).stale?.(store, task);
    tasks.complete(task, "cancelled", {
      error: "目标已删除，生成结果未写入",
      errorCode: "AI_TASK_CANCELLED"
    });
    notify(store, task, "cancelled", task.error);
  };
  const currentWork = async (taskId, expectedWork, kind) => {
    await beforePrepare({ kind });
    const store = await repository.read();
    const task = store.aiTasks.find(item => item.id === taskId);
    if (!task || task.status !== "running") return null;
    const work = prepareTarget(store, task);
    if (!taskInputMatches(task, work)) return null;
    if (expectedWork.contextFingerprint
      && expectedWork.contextFingerprint !== work?.contextFingerprint) return null;
    return work;
  };
  const stableTaskWriteback = async (taskId, expectedWork) => {
    const unitOfWork = repository.accountUnitOfWork;
    if (!unitOfWork?.readRevision) {
      throw new TypeError("Content AI writeback requires AccountUnitOfWork revision reads");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await unitOfWork.readRevision();
      const store = await repository.read();
      const after = await unitOfWork.readRevision();
      if (before !== after) continue;
      const task = store.aiTasks.find(item => item.id === taskId);
      const work = task && prepareTarget(store, task);
      const contextChanged = expectedWork.contextFingerprint
        && expectedWork.contextFingerprint !== work?.contextFingerprint;
      if (!task || task.status !== "running"
        || !taskInputMatches(task, work) || contextChanged) return null;
      return { revision: after };
    }
    return null;
  };
  const claimQueuedTask = (store, taskId) => {
    const task = store.aiTasks.find(item => item.id === taskId);
    if (!task || task.status !== "queued") return null;
    if (shouldWaitForModel(store, task)) {
      const intent = inspectRequestedIntent(store, task);
      if (typeof inspectIntent === "function" && !requestedIntentMatches(task, intent)) {
        stale(store, task, "等待核心用户模型期间，目标已变化");
        return null;
      }
      const waiting = tasks.waitForUserModel(store.aiTasks, taskId);
      if (waiting) notify(store, waiting, WAITING_FOR_USER_MODEL_STATUS, "等待核心用户模型就绪");
      return null;
    }
    if (task.kind === RECORD_COMPRESSION_TASK_KIND && !taskInputsCurrent(store, task)) {
      stale(store, task, "日压缩已完成、越界或来源已变化，未调用模型");
      return null;
    }
    const claimedTask = tasks.claim(store.aiTasks, taskId);
    if (!claimedTask) return null;
    targetFor(claimedTask).started?.(store, claimedTask);
    notify(store, claimedTask, "running", "正在生成");
    return { identity: { id: claimedTask.id, attempt: claimedTask.attempt }, kind: claimedTask.kind };
  };
  const saveLegacyTaskResult = (value, task, work, result) => {
    const currentTask = value.aiTasks.find(item => item.id === task.id);
    if (!currentTask) return false;
    if (["cancelled", "cancelling"].includes(currentTask.status)) {
      cancelled(value, currentTask);
      return false;
    }
    const resultTarget = targetFor(currentTask);
    const current = resultTarget.prepareResult
      ? resultTarget.prepareResult(value, currentTask) : prepareTarget(value, currentTask);
    const contextChanged = work.contextFingerprint
      && work.contextFingerprint !== current?.contextFingerprint;
    if (!taskInputMatches(task, current) || contextChanged) {
      stale(value, currentTask, "目标已经变化，生成结果未写入");
      return false;
    }
    const resultId = targetFor(currentTask).save(value, current, task, result);
    if (work.contextFingerprint) currentTask.contextFingerprint = work.contextFingerprint;
    tasks.complete(currentTask, "succeeded", { resultId });
    notify(value, currentTask, "succeeded");
    return true;
  };
  const failLegacyTask = (store, taskId, error) => {
    const task = store.aiTasks.find(item => item.id === taskId);
    if (!task) return;
    if (["cancelled", "cancelling"].includes(task.status)) cancelled(store, task);
    else if (error?.code === "AI_TASK_STALE"
      || (error?.code === "AI_TASK_CANCELLED" && !taskInputsCurrent(store, task))) {
      stale(store, task, "目标已变化，未调用外部模型");
    } else if (task.kind === RECORD_COMPRESSION_TASK_KIND && error?.budgetAdmissionRejected === true) {
      const waiting = tasks.waitForBudget(store.aiTasks, task.id, prepareTarget(store, task), error.code);
      if (waiting.waiting) targetFor(task).waitingBudget?.(store, task);
      else if (waiting.stale) stale(store, task, "预算等待前来源或权限已变化");
    } else {
      targetFor(task).fail?.(store, task, error);
      tasks.complete(task, "failed", { error: error.message, errorCode: error.code || "AI_TASK_FAILED" });
      notify(store, task, "failed", task.error || "生成失败");
    }
  };
  const settleAfterRun = async (taskId, executed) => {
    try {
      const store = await repository.read();
      const task = store.aiTasks.find(item => item.id === taskId);
      if (!task || !["succeeded", "failed", "cancelled", "stale"].includes(task.status)) return;
      if (executed || task.kind === "importanceScoring") await targetFor(task).settled?.(task);
      // 所有抽取终态都重新评估队列；门禁自行判定最新合法来源是否仍在途。
      if (task.kind === "onboardingClaimExtraction") await releaseWaiting();
    } catch (releaseError) {
      try { onError(taskId, releaseError); } catch {}
    }
  };

  async function run(taskId) {
    const key = `${contextKey()}:${taskId}`;
    if (running.has(key)) return;
    running.add(key);
    const controller = new AbortController();
    controllers.set(key, controller);
    let executed = false;
    let claimedIdentity = null;
    let claimedKind = "";
    try {
      const initial = await repository.read();
      await beforePrepare(initial.aiTasks.find(item => item.id === taskId));
      const claimed = await repository.update(store => claimQueuedTask(store, taskId));
      if (!claimed) return;
      claimedIdentity = claimed.identity;
      claimedKind = claimed.kind;
      executed = true;
      const store = await repository.read(), task = store.aiTasks.find(item => item.id === taskId);
      if (task) {
        claimedIdentity = { id: task.id, attempt: task.attempt };
        claimedKind = task.kind;
      }
      const work = task && prepareTarget(store, task);
      if (task?.deferredInputBinding === true) {
        if (!bindTaskInputRecord) {
          throw new TypeError("Deferred task input binding has no record command");
        }
        const bound = await bindTaskInputRecord(task.id, work);
        if (!bound) {
          throw Object.assign(new Error("目标已变化，未调用外部模型"), {
            code: "AI_TASK_STALE"
          });
        }
        Object.assign(task, bound);
      }
      if (!task || !taskInputMatches(task, work)) {
        const recordWriteback = recordWritebackFor(task?.kind);
        if (recordWriteback) {
          await recordWriteback.failWriteback(taskId, Object.assign(
            new Error("目标已变化，未调用外部模型"), { code: "AI_TASK_STALE" }
          ));
          return;
        }
        await repository.update(value => {
          const current = value.aiTasks.find(item => item.id === taskId);
          if (current) {
            if (["cancelled", "cancelling"].includes(current.status)) cancelled(value, current);
            else stale(value, current, "目标已变化，结果未写入");
          }
        });
        return;
      }
      const generated = await generate(work, {
        signal: controller.signal,
        isCurrent: async () => Boolean(await currentWork(taskId, work, task.kind))
      });
      const result = work.contextReceipt && generated && typeof generated === "object" && !Array.isArray(generated)
        ? { ...generated, contextReceipt: { ...compactPersonalContextReceipt(work.contextReceipt),
          ...(generated.referenceReceipt ? { referenceRequest: structuredClone(generated.referenceReceipt) } : {}) } }
        : generated;
      if (task.kind === "importanceScoring") await beforePrepare({ kind: task.kind });
      const recordWriteback = recordWritebackFor(task.kind);
      if (recordWriteback) {
        const current = await stableTaskWriteback(taskId, work);
        if (!current) {
          await recordWriteback.failWriteback(taskId, Object.assign(
            new Error("目标已变化，结果未写入"),
            { code: "AI_TASK_STALE" }
          ));
          return;
        }
        await recordWriteback.writeback({
          taskId,
          result,
          expectedRevision: current.revision,
          contextFingerprint: work.contextFingerprint
        });
        return;
      }
      await repository.update(value => saveLegacyTaskResult(value, task, work, result));
    } catch (error) {
      if (claimedIdentity && cleanupExistingTask && await cleanupExistingTask(claimedIdentity, error)) return;
      const recordWriteback = recordWritebackFor(claimedKind);
      if (claimedIdentity && recordWriteback) {
        const terminalError = error?.code === "VERSION_CONFLICT"
          ? Object.assign(new Error("目标已变化，结果未写入"), { code: "AI_TASK_STALE" })
          : error;
        await recordWriteback.failWriteback(taskId, terminalError);
        return;
      }
      await repository.update(store => failLegacyTask(store, taskId, error));
    } finally {
      controllers.delete(key);
      running.delete(key);
      await settleAfterRun(taskId, executed);
    }
  }

  async function retryTask(id, { includeInternal = false } = {}) {
    const created = await repository.update(store => {
      const source = store.aiTasks.find(item => item.id === id);
      if (isInternalAiTask(source)
        && (!includeInternal || source.kind === RECORD_COMPRESSION_TASK_KIND)) {
        return { missing: true };
      }
      if (source && !taskHasRequiredTarget(store, source)) return { missing: true };
      const retryInput = source && {
        kind: source.kind,
        resourceType: source.resourceType,
        targetId: source.targetId,
        subtargetId: source.subtargetId,
        payload: source.payload,
        clientRequestId: `retry:${source.id}`
      };
      const waiting = retryInput && Boolean(shouldWaitForModel(store, retryInput));
      const requestedIntent = waiting ? inspectRequestedIntent(store, retryInput) : null;
      if (waiting && !requestedIntent) return { missing: true };
      return notifyCreated(
        store,
        tasks.retry(store.aiTasks, id, task => prepareTarget(store, task), {
          deferTargetInspection: waiting,
          requestedIntent
        })
      );
    });
    if (!created.duplicate && created.task?.status === "queued") schedule(created.task.id);
    return created;
  }

  async function enqueueTask(input, { internal = false, waitingBudget = false } = {}) {
    await beforePrepare(input);
    const kind = String(input?.kind ?? "").trim();
    if (internal ? kind !== RECORD_COMPRESSION_TASK_KIND : internalKinds.has(kind)) {
      return { unsupported: true };
    }
    if (waitingBudget && (!internal || kind !== RECORD_COMPRESSION_TASK_KIND)) {
      return { unsupported: true };
    }
    const idempotency = tasks.idempotency?.(input);
    let created;
    if (idempotency && typeof repository.executeIdempotent === "function") {
      try {
        created = await repository.executeIdempotent(
          idempotency,
          store => {
            const result = createInStore(store, input, { waitingBudget });
            if (!result.task) throw Object.assign(new Error("AI task was not created"), { taskResult: result });
            return result;
          },
          { onReplay: result => ({ ...result, duplicate: true }) }
        );
      } catch (error) {
        if (error.taskResult) created = error.taskResult;
        else if (error.code === "IDEMPOTENCY_KEY_REUSED") created = { conflict: true };
        else throw error;
      }
    } else {
      created = await repository.update(store => createInStore(store, input, { waitingBudget }));
    }
    if (!created.duplicate && created.task?.status === "queued") schedule(created.task.id);
    return created;
  }

  async function promoteInternalBudgetWaiting(limit = 0, { operation = "", localDate = "", windowKey = "" } = {}) {
    const promotionLimit = Number(limit) === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(Number(limit))
      ? Math.max(0, Math.floor(Number(limit)))
      : 0;
    const result = await repository.update(store => {
      const scheduled = [];
      let invalidatedCount = 0;
      const waiting = store.aiTasks
        .filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
          && task.status === WAITING_FOR_BUDGET_STATUS
          && (!operation || task.payload?.operation === operation)
          && (!localDate || task.payload?.localDate === localDate)
          && (!windowKey || task.payload?.windowKey === windowKey))
        .sort((left, right) => (
          String(right.payload?.localDate || right.payload?.windowEnd || "")
            .localeCompare(String(left.payload?.localDate || left.payload?.windowEnd || ""))
          || String(right.payload?.windowStart || "").localeCompare(String(left.payload?.windowStart || ""))
          || String(left.createdAt).localeCompare(String(right.createdAt))
        ));
      for (const task of waiting) {
        const work = prepareTarget(store, task);
        if (!taskInputMatches(task, work)) {
          stale(store, task, "预算等待期间来源或权限已变化，等待任务已失效");
          invalidatedCount += 1;
          continue;
        }
        if (store.aiTasks.some(other => other.id !== task.id && other.kind === task.kind
          && ["queued", "running"].includes(other.status)
          && other.payload?.operation === task.payload?.operation
          && other.payload?.timezone === task.payload?.timezone
          && other.payload?.sourceManifestHash === task.payload?.sourceManifestHash)) continue;
        if (scheduled.length >= promotionLimit) continue;
        const promoted = tasks.promoteBudgetWaiting(store.aiTasks, task.id, work);
        if (promoted.queued) {
          notify(store, task, "queued", "预算已恢复，任务已重新校验并进入后台队列");
          scheduled.push(task.id);
        }
      }
      return {
        taskIds: scheduled,
        invalidatedCount,
        waitingBudgetCount: store.aiTasks.filter(task => task.kind === RECORD_COMPRESSION_TASK_KIND
          && task.status === WAITING_FOR_BUDGET_STATUS).length
      };
    });
    for (const id of result.taskIds) schedule(id);
    return { ...result, queuedCount: result.taskIds.length };
  }

  async function releaseWaiting() {
    const scheduledIds = await repository.update(store => {
      const scheduled = [];
      for (const task of store.aiTasks) {
        if (task.status !== WAITING_FOR_USER_MODEL_STATUS) continue;
        if (!taskHasRequiredTarget(store, task)) {
          stale(store, task, "等待任务的目标当前不可用，任务已终止");
          continue;
        }
        const intent = inspectRequestedIntent(store, task);
        if (typeof inspectIntent === "function" && !requestedIntentMatches(task, intent)) {
          stale(store, task, "等待核心用户模型期间，目标已变化");
          continue;
        }
        if (shouldWaitForModel(store, task)) continue;
        // Every task in this branch was held behind the core-model gate. Fix a
        // single context timestamp at release so date-sensitive trend windows
        // do not drift between promotion, retry, and the eventual save check.
        task.contextGeneratedAt = now();
        const work = prepareTarget(store, task);
        const promoted = tasks.promoteWaiting(store.aiTasks, task.id, work, intent);
        if (promoted.queued) {
          notify(store, task, "queued", "前置整理已结束，任务已进入后台队列");
          scheduled.push(task.id);
        } else if (promoted.stale) {
          delete task.contextGeneratedAt;
          notify(store, task, "stale", task.error);
        } else {
          delete task.contextGeneratedAt;
        }
      }
      return scheduled;
    });
    for (const id of scheduledIds) schedule(id);
    return scheduledIds.length;
  }

  return {
    registerRecordCommand(name, handler) {
      const flag = name === "content.aiWriteback" ? "thought.aiWriteback" : name;
      if (!recordCommands?.enabled?.(flag)) return false;
      if (!["thought.aiWriteback", "content.aiWriteback"].includes(name)
        || !handler?.writeback
        || !handler?.failWriteback) {
        throw new TypeError(`Record command ${name} implementation is invalid`);
      }
      const existing = dynamicRecordCommands.get(name);
      if (existing && existing !== handler) {
        throw new Error(`A record command is already registered for ${name}`);
      }
      dynamicRecordCommands.set(name, handler);
      return true;
    },
    assertRecordCommandsReady() {
      if (recordCommands?.enabled?.("thought.aiWriteback")
        && !dynamicRecordCommands.has("thought.aiWriteback")) {
        throw new TypeError("Record command thought.aiWriteback is enabled without an implementation");
      }
      return true;
    },
    registerHandler(kind, handler) {
      if (!kind || !handler?.prepare || !handler?.save || !handler?.result) {
        throw new TypeError("A background task handler requires prepare(), save(), and result()");
      }
      const existing = taskHandlers.get(kind);
      if (existing && existing !== handler) throw new Error(`A handler is already registered for ${kind}`);
      taskHandlers.set(kind, handler);
      return true;
    },
    /** 只读观察任务恢复目标与候选意图，不读写仓库，也不触发调度或生成。 */
    inspectRecoveryIntent(store, task) {
      const target = aiTaskTargetReference(store, task);
      const intent = inspectRequestedIntent(store, task);
      return {
        target: target && {
          targetOptional: target.targetOptional,
          requiresExistingTarget: target.requiresExistingTarget,
          requiresExistingSubtarget: target.requiresExistingSubtarget,
          exists: target.exists,
          subtargetExists: target.subtargetExists
        },
        intent: intent && {
          inputVersion: intent.inputVersion,
          subtargetVersion: intent.subtargetVersion,
          alreadyAnswered: intent.alreadyAnswered === true,
          inputHash: intent.inputHash
        },
        intentMatch: requestedIntentMatchState(task, intent)
      };
    },
    createInStore,
    schedule,
    run,
    cancel(taskId) {
      const controller = controllers.get(`${contextKey()}:${taskId}`);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    async cancelPersisted(taskId) {
      if (cancelTaskRecord) {
        const task = await cancelTaskRecord(taskId);
        const controller = controllers.get(`${contextKey()}:${taskId}`);
        controller?.abort();
        if (task?.kind === "onboardingClaimExtraction") await releaseWaiting();
        return task ? publicAiTask(task) : null;
      }
      const value = await repository.update(store => {
        const task = store.aiTasks.find(item => item.id === taskId);
        if (!task || !["queued", "running", WAITING_FOR_USER_MODEL_STATUS].includes(task.status)) return null;
        targetFor(task).stale?.(store, task);
        tasks.complete(task, "cancelled", { error: "用户取消了本次生成" });
        notify(store, task, "cancelled", task.error);
        return publicAiTask(task);
      });
      const controller = controllers.get(`${contextKey()}:${taskId}`);
      controller?.abort();
      if (value?.kind === "onboardingClaimExtraction") await releaseWaiting();
      return value;
    },
    enqueue: input => enqueueTask(input),
    enqueueInternal: input => enqueueTask(input, { internal: true }),
    enqueueBudgetWaiting: input => enqueueTask(input, { internal: true, waitingBudget: true }),
    promoteInternalBudgetWaiting,
    retry: id => retryTask(id),
    retryInternal: id => retryTask(id, { includeInternal: true }),
    abortAll() { for (const controller of controllers.values()) controller.abort(); },
    abortCurrentAccount() {
      const prefix = `${contextKey()}:`;
      for (const [key, controller] of controllers) if (key.startsWith(prefix)) controller.abort();
    },
    async resume() {
      await beforePrepare({ kind: "importanceScoring" });
      const ids = await repository.update(store => {
        const { interrupted } = tasks.recover(store.aiTasks);
        for (const task of interrupted) {
          targetFor(task).fail?.(store, task, { code: "TASK_INTERRUPTED" });
          notify(store, task, "failed", task.error);
          const recoveryAttempt = Math.max(0, Math.round(Number(task.recoveryAttempt) || 0));
          if (isInternalAiTask(task)
            && task.kind !== RECORD_COMPRESSION_TASK_KIND
            && !(task.kind === "importanceScoring" && task.clientRequestId?.startsWith("importance-range:"))
            && taskHasRequiredTarget(store, task)
            && recoveryAttempt < INTERNAL_RECOVERY_LIMIT) {
            const retry = notifyCreated(
              store,
              tasks.retry(
                store.aiTasks,
                task.id,
                candidate => prepareTarget(store, candidate)
              )
            );
            if (!retry.duplicate && retry.task?.status === "queued") {
              retry.task.recoveryAttempt = recoveryAttempt + 1;
            }
          }
        }
        const queued = [];
        for (const task of store.aiTasks) {
          if (task.status !== "queued") continue;
          if (!task.inputHash
            && task.deferredInputBinding !== true
            && task.kind !== RECORD_COMPRESSION_TASK_KIND) {
            stale(store, task, "旧排队任务缺少可验证输入绑定，未调用模型");
            continue;
          }
          if (!taskHasRequiredTarget(store, task)) {
            stale(store, task, "排队任务的目标当前不可用，任务已终止");
            continue;
          }
          queued.push(task.id);
        }
        return queued;
      });
      for (const id of ids) schedule(id);
      await releaseWaiting();
    },
    releaseWaiting,
    refreshQueuedTaskInputs,
    async list() {
      return {
        items: (await repository.read()).aiTasks
          .filter(task => !isInternalAiTask(task))
          .map(publicAiTask)
      };
    },
    async get(id) {
      const task = (await repository.read()).aiTasks.find(item => item.id === id);
      return task && !isInternalAiTask(task) ? publicAiTask(task) : null;
    },
    async getResult(id) {
      const store = await repository.read();
      const task = store.aiTasks.find(item => item.id === id);
      if (!task || isInternalAiTask(task)) return null;
      return { task: publicAiTask(task), result: task.status === "succeeded" ? targetFor(task).result(store, task) : null };
    },
    async listNotifications() {
      const store = await repository.read();
      const items = visibleNotifications(store);
      return { unread: notificationUnread(items), items };
    },
    readNotification(id) {
      if (readNotificationRecord) return readNotificationRecord(id);
      return repository.update(store => {
        const item = (store.notifications || []).find(value => value.id === id);
        if (!item || visibleNotifications(store).every(value => value.id !== id)) return null;
        return notifications.read(store.notifications, id);
      });
    },
    readAllNotifications() {
      if (readAllNotificationsRecord) return readAllNotificationsRecord();
      return repository.update(store => notifications.readAll(visibleNotifications(store)));
    }
  };
}
