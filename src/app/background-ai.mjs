import { taskInputMatches, publicAiTask, WAITING_FOR_USER_MODEL_STATUS } from "../modules/tasks/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import { compactPersonalContextReceipt } from "./personal-context.mjs";

const INTERNAL_RECOVERY_LIMIT = 2;

export function createBackgroundAi({
  repository,
  tasks,
  notifications,
  targets,
  generate,
  dispatch,
  contextKey,
  onError,
  shouldWaitForModel = () => false,
  inspectIntent = targets?.inspectIntent
}) {
  const internalKinds = new Set(["perceptionExtraction"]);
  const taskHandlers = new Map();
  const running = new Set();
  const controllers = new Map();
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
  const inspectRequestedIntent = (store, input) => {
    const inspector = taskHandlers.get(input?.kind)?.inspectIntent || inspectIntent;
    if (typeof inspector !== "function") return null;
    const value = inspector(store, input);
    return value && typeof value === "object" ? value : null;
  };
  const targetFor = task => taskHandlers.get(task?.kind) || targets;
  const prepareTarget = (store, task) => targetFor(task).prepare(store, task);
  const requestedIntentMatches = (task, intent) => {
    const hasIntent = Object.hasOwn(task, "requestedIntentInputVersion")
      || Object.hasOwn(task, "requestedIntentSubtargetVersion")
      || Object.hasOwn(task, "requestedIntentInputHash");
    if (!intent || typeof intent !== "object") return false;
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
    if (hasInputVersion && Math.max(0, Number(intent.inputVersion) || 0) !== expectedInputVersion) return false;
    if (hasSubtargetVersion && Math.max(0, Number(intent.subtargetVersion) || 0) !== expectedSubtargetVersion) return false;
    if (hasIntent && Object.hasOwn(task, "requestedIntentInputHash")
      && String(intent.inputHash ?? "") !== task.requestedIntentInputHash) return false;
    return true;
  };
  const createInStore = (store, input = {}) => {
    const waiting = Boolean(shouldWaitForModel(store, input));
    const requestedIntent = waiting ? inspectRequestedIntent(store, input) : null;
    if (waiting && !requestedIntent) return { missing: true };
    return notifyCreated(store, tasks.create(
      store.aiTasks,
      input,
      task => prepareTarget(store, task),
      { deferTargetInspection: waiting, requestedIntent }
    ));
  };
  const schedule = taskId => dispatch(() => void run(taskId).catch(error => onError(taskId, error)));
  const stale = (store, task, message) => {
    tasks.complete(task, "stale", {
      error: "目标已修改或删除",
      errorCode: "AI_TASK_STALE"
    });
    notify(store, task, "stale", message);
  };
  const cancelled = (store, task) => {
    tasks.complete(task, "cancelled", {
      error: "目标已删除，生成结果未写入",
      errorCode: "AI_TASK_CANCELLED"
    });
    notify(store, task, "cancelled", task.error);
  };
  const currentWork = async (taskId, expectedWork) => {
    const store = await repository.read();
    const task = store.aiTasks.find(item => item.id === taskId);
    if (!task || task.status !== "running") return null;
    const work = prepareTarget(store, task);
    if (!taskInputMatches(task, work)) return null;
    if (expectedWork.contextFingerprint
      && expectedWork.contextFingerprint !== work?.contextFingerprint) return null;
    return work;
  };

  async function run(taskId) {
    const key = `${contextKey()}:${taskId}`;
    if (running.has(key)) return;
    running.add(key);
    const controller = new AbortController();
    controllers.set(key, controller);
    try {
      const claimed = await repository.update(store => {
        const task = store.aiTasks.find(item => item.id === taskId);
        if (!task || task.status !== "queued") return false;
        if (shouldWaitForModel(store, task)) {
          const intent = inspectRequestedIntent(store, task);
          if (typeof inspectIntent === "function" && !requestedIntentMatches(task, intent)) {
            stale(store, task, "等待核心用户模型期间，目标已变化");
            return false;
          }
          const waiting = tasks.waitForUserModel(store.aiTasks, taskId);
          if (waiting) notify(store, waiting, WAITING_FOR_USER_MODEL_STATUS, "等待核心用户模型就绪");
          return false;
        }
        const claimedTask = tasks.claim(store.aiTasks, taskId);
        if (!claimedTask) return false;
        targetFor(claimedTask).started?.(store, claimedTask);
        notify(store, claimedTask, "running", "正在生成");
        return true;
      });
      if (!claimed) return;
      const store = await repository.read(), task = store.aiTasks.find(item => item.id === taskId);
      const work = task && prepareTarget(store, task);
      if (!task || !taskInputMatches(task, work)) {
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
        isCurrent: async () => Boolean(await currentWork(taskId, work))
      });
      const result = work.contextReceipt && generated && typeof generated === "object" && !Array.isArray(generated)
        ? { ...generated, contextReceipt: compactPersonalContextReceipt(work.contextReceipt) }
        : generated;
      const extractionSucceeded = await repository.update(value => {
        const currentTask = value.aiTasks.find(item => item.id === taskId);
        if (!currentTask) return false;
        if (["cancelled", "cancelling"].includes(currentTask.status)) {
          cancelled(value, currentTask);
          return false;
        }
        const currentWork = prepareTarget(value, currentTask);
        const contextChanged = work.contextFingerprint
          && work.contextFingerprint !== currentWork?.contextFingerprint;
        if (!taskInputMatches(task, currentWork) || contextChanged) {
          stale(value, currentTask, "目标已经变化，生成结果未写入");
          return false;
        }
        const resultId = targetFor(currentTask).save(value, currentWork, task, result);
        if (work.contextFingerprint) currentTask.contextFingerprint = work.contextFingerprint;
        tasks.complete(currentTask, "succeeded", { resultId });
        notify(value, currentTask, "succeeded");
        return currentTask.kind === "onboardingClaimExtraction";
      });
      if (extractionSucceeded) {
        try {
          await releaseWaiting();
        } catch (releaseError) {
          try { onError(taskId, releaseError); } catch {}
        }
      }
    } catch (error) {
      await repository.update(store => {
        const task = store.aiTasks.find(item => item.id === taskId);
        if (!task) return;
        if (["cancelled", "cancelling"].includes(task.status)) cancelled(store, task);
        else if (error?.code === "AI_TASK_STALE") {
          stale(store, task, "目标已变化，未调用外部模型");
        }
        else {
          targetFor(task).fail?.(store, task, error);
          tasks.complete(task, "failed", {
            error: error.message,
            errorCode: error.code || "AI_TASK_FAILED"
          });
          notify(store, task, "failed", task.error || "生成失败");
        }
      });
    } finally {
      controllers.delete(key);
      running.delete(key);
    }
  }

  async function retryTask(id, { includeInternal = false } = {}) {
    const created = await repository.update(store => {
      const source = store.aiTasks.find(item => item.id === id);
      if (source?.internal === true && !includeInternal) return { missing: true };
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

  async function releaseWaiting() {
    const scheduledIds = await repository.update(store => {
      const scheduled = [];
      for (const task of store.aiTasks) {
        if (task.status !== WAITING_FOR_USER_MODEL_STATUS) continue;
        const intent = inspectRequestedIntent(store, task);
        if (typeof inspectIntent === "function" && !requestedIntentMatches(task, intent)) {
          stale(store, task, "等待核心用户模型期间，目标已变化");
          continue;
        }
        if (shouldWaitForModel(store, task)) continue;
        const work = prepareTarget(store, task);
        const promoted = tasks.promoteWaiting(store.aiTasks, task.id, work, intent);
        if (promoted.queued) {
          notify(store, task, "queued", "核心用户模型已就绪，任务已进入后台队列");
          scheduled.push(task.id);
        } else if (promoted.stale) {
          notify(store, task, "stale", task.error);
        }
      }
      return scheduled;
    });
    for (const id of scheduledIds) schedule(id);
    return scheduledIds.length;
  }

  return {
    registerHandler(kind, handler) {
      if (!kind || !handler?.prepare || !handler?.save || !handler?.result) {
        throw new TypeError("A background task handler requires prepare(), save(), and result()");
      }
      const existing = taskHandlers.get(kind);
      if (existing && existing !== handler) throw new Error(`A handler is already registered for ${kind}`);
      taskHandlers.set(kind, handler);
      return true;
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
      const value = await repository.update(store => {
        const task = store.aiTasks.find(item => item.id === taskId);
        if (!task || !["queued", "running", WAITING_FOR_USER_MODEL_STATUS].includes(task.status)) return null;
        tasks.complete(task, "cancelled", { error: "用户取消了本次生成" });
        notify(store, task, "cancelled", task.error);
        return publicAiTask(task);
      });
      const controller = controllers.get(`${contextKey()}:${taskId}`);
      controller?.abort();
      return value;
    },
    async enqueue(input) {
      if (internalKinds.has(String(input?.kind ?? "").trim())) {
        return { unsupported: true };
      }
      const idempotency = tasks.idempotency?.(input);
      let created;
      if (idempotency && typeof repository.executeIdempotent === "function") {
        try {
          created = await repository.executeIdempotent(
            idempotency,
            store => {
              const result = createInStore(store, input);
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
        created = await repository.update(store => createInStore(store, input));
      }
      if (!created.duplicate && created.task?.status === "queued") schedule(created.task.id);
      return created;
    },
    retry: id => retryTask(id),
    retryInternal: id => retryTask(id, { includeInternal: true }),
    async resume() {
      const ids = await repository.update(store => {
        const { queued, interrupted } = tasks.recover(store.aiTasks);
        const recovered = [];
        for (const task of interrupted) {
          targetFor(task).fail?.(store, task, { code: "TASK_INTERRUPTED" });
          notify(store, task, "failed", task.error);
          const recoveryAttempt = Math.max(0, Math.round(Number(task.recoveryAttempt) || 0));
          if (task.internal === true && recoveryAttempt < INTERNAL_RECOVERY_LIMIT) {
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
              recovered.push(retry.task.id);
            }
          }
        }
        return [...queued, ...recovered];
      });
      for (const id of ids) schedule(id);
      await releaseWaiting();
    },
    releaseWaiting,
    async list() {
      return {
        items: (await repository.read()).aiTasks
          .filter(task => task.internal !== true)
          .map(publicAiTask)
      };
    },
    async get(id) {
      const task = (await repository.read()).aiTasks.find(item => item.id === id);
      return task && task.internal !== true ? publicAiTask(task) : null;
    },
    async getResult(id) {
      const store = await repository.read();
      const task = store.aiTasks.find(item => item.id === id);
      if (!task || task.internal === true) return null;
      return { task: publicAiTask(task), result: task.status === "succeeded" ? targetFor(task).result(store, task) : null };
    },
    async listNotifications() {
      const { notifications: items } = await repository.read();
      return { unread: notificationUnread(items), items };
    },
    readNotification(id) {
      return repository.update(store => notifications.read(store.notifications, id));
    },
    readAllNotifications() {
      return repository.update(store => notifications.readAll(store.notifications));
    }
  };
}
