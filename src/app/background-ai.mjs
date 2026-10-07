import { taskInputMatches, publicAiTask } from "../modules/tasks/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import { compactPersonalContextReceipt } from "./personal-context.mjs";

export function createBackgroundAi({ repository, tasks, notifications, targets, generate, dispatch, contextKey, onError }) {
  const running = new Set();
  const controllers = new Map();
  const notifyCreated = (store, created) => {
    if (created.task && !created.duplicate) notifications.upsertTask(store.notifications, created.task, "queued", "已进入后台队列");
    return created;
  };
  const createInStore = (store, input = {}) => notifyCreated(store, tasks.create(store.aiTasks, input, task => targets.prepare(store, task)));
  const schedule = taskId => dispatch(() => void run(taskId).catch(error => onError(taskId, error)));
  const stale = (store, task, message) => {
    tasks.complete(task, "stale", { error: "目标已修改或删除" });
    notifications.upsertTask(store.notifications, task, "stale", message);
  };
  const cancelled = (store, task) => {
    tasks.complete(task, "cancelled", { error: "目标已删除，生成结果未写入" });
    notifications.upsertTask(store.notifications, task, "cancelled", task.error);
  };

  async function run(taskId) {
    const key = `${contextKey()}:${taskId}`;
    if (running.has(key)) return;
    running.add(key);
    const controller = new AbortController();
    controllers.set(key, controller);
    try {
      const claimed = await repository.update(store => {
        const task = tasks.claim(store.aiTasks, taskId);
        if (!task) return false;
        targets.started?.(store, task);
        notifications.upsertTask(store.notifications, task, "running", "正在生成");
        return true;
      });
      if (!claimed) return;
      const store = await repository.read(), task = store.aiTasks.find(item => item.id === taskId);
      const work = task && targets.prepare(store, task);
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
      const generated = await generate(work, { signal: controller.signal });
      const result = work.contextReceipt && generated && typeof generated === "object" && !Array.isArray(generated)
        ? { ...generated, contextReceipt: compactPersonalContextReceipt(work.contextReceipt) }
        : generated;
      await repository.update(value => {
        const currentTask = value.aiTasks.find(item => item.id === taskId);
        if (!currentTask) return;
        if (["cancelled", "cancelling"].includes(currentTask.status)) {
          cancelled(value, currentTask);
          return;
        }
        const currentWork = targets.prepare(value, currentTask);
        const contextChanged = work.contextFingerprint
          && work.contextFingerprint !== currentWork?.contextFingerprint;
        if (!taskInputMatches(task, currentWork) || contextChanged) {
          stale(value, currentTask, "目标已经变化，生成结果未写入");
          return;
        }
        const resultId = targets.save(value, currentWork, task, result);
        if (work.contextFingerprint) currentTask.contextFingerprint = work.contextFingerprint;
        tasks.complete(currentTask, "succeeded", { resultId });
        notifications.upsertTask(value.notifications, currentTask, "succeeded");
      });
    } catch (error) {
      await repository.update(store => {
        const task = store.aiTasks.find(item => item.id === taskId);
        if (!task) return;
        if (["cancelled", "cancelling"].includes(task.status)) cancelled(store, task);
        else {
          targets.fail?.(store, task, error);
          tasks.complete(task, "failed", { error: error.message });
          notifications.upsertTask(store.notifications, task, "failed", task.error || "生成失败");
        }
      });
    } finally {
      controllers.delete(key);
      running.delete(key);
    }
  }

  return {
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
        if (!task || !["queued", "running"].includes(task.status)) return null;
        tasks.complete(task, "cancelled", { error: "用户取消了本次生成" });
        notifications.upsertTask(store.notifications, task, "cancelled", task.error);
        return publicAiTask(task);
      });
      const controller = controllers.get(`${contextKey()}:${taskId}`);
      controller?.abort();
      return value;
    },
    async enqueue(input) {
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
    async retry(id) {
      const created = await repository.update(store => notifyCreated(store, tasks.retry(store.aiTasks, id, task => targets.prepare(store, task))));
      if (!created.duplicate && created.task) schedule(created.task.id);
      return created;
    },
    async resume() {
      const ids = await repository.update(store => {
        const { queued, interrupted } = tasks.recover(store.aiTasks);
        for (const task of interrupted) {
          targets.fail?.(store, task, { code: "TASK_INTERRUPTED" });
          notifications.upsertTask(store.notifications, task, "failed", task.error);
        }
        return queued;
      });
      for (const id of ids) schedule(id);
    },
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
      return { task: publicAiTask(task), result: task.status === "succeeded" ? targets.result(store, task) : null };
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
