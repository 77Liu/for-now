import {
  backgroundResultFromSnapshot,
  backgroundTaskTarget,
  mergeBackgroundTaskResult
} from "./model.mjs";
import {
  backgroundNavigationTarget,
  backgroundTargetSelector
} from "./locator.mjs";

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Background results feature ${group} requires ${name}`);
    }
  }
}

export function createBackgroundResultController({
  loadResult,
  applyResult,
  captureViewState = () => null,
  restoreViewState = () => {},
  onError = () => {}
}) {
  if (typeof loadResult !== "function" || typeof applyResult !== "function") {
    throw new TypeError("Background result controller requires loadResult and applyResult");
  }
  let epoch = 0;
  const applied = new Set();
  const failed = new Set();
  const inFlight = new Set();

  async function applyTask(task, generation) {
    const target = backgroundTaskTarget(task);
    if (!target) return false;
    const fingerprint = `${task.id}:${task.resultId}`;
    if (applied.has(fingerprint) || inFlight.has(fingerprint)) return false;
    inFlight.add(fingerprint);
    try {
      const result = await loadResult(task, target);
      if (generation !== epoch) return false;
      if (result == null) throw new Error("Background task result is not available");
      const viewState = captureViewState(target);
      let resultApplied;
      try {
        resultApplied = await applyResult({ task, target, result });
      } finally {
        if (generation === epoch) restoreViewState(viewState, target);
      }
      if (generation !== epoch || resultApplied === false) return false;
      applied.add(fingerprint);
      failed.delete(fingerprint);
      return true;
    } catch (error) {
      if (generation === epoch) {
        failed.add(fingerprint);
        onError(error, task, target);
      }
      return false;
    } finally {
      inFlight.delete(fingerprint);
    }
  }

  return Object.freeze({
    async sync(tasks = []) {
      const generation = epoch;
      let changed = false;
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (await applyTask(task, generation)) changed = true;
        if (generation !== epoch) return false;
      }
      return changed;
    },
    forget(taskId) {
      const prefix = `${taskId}:`;
      for (const fingerprint of applied) {
        if (fingerprint.startsWith(prefix)) applied.delete(fingerprint);
      }
      for (const fingerprint of failed) {
        if (fingerprint.startsWith(prefix)) failed.delete(fingerprint);
      }
    },
    needsRetry: () => failed.size > 0,
    reset() {
      epoch += 1;
      applied.clear();
      failed.clear();
      inFlight.clear();
    }
  });
}

export function createBackgroundResultsFeatureController({
  data = {},
  navigation = {},
  annotations = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    replaceSnapshot: data.replaceSnapshot,
    request: data.request,
    refresh: data.refresh,
    publish: data.publish
  });
  requireFunctions("navigation port", {
    openThoughtDetail: navigation.openThoughtDetail,
    switchView: navigation.switchView
  });
  requireFunctions("annotations port", {
    openTarget: annotations.openTarget,
    refreshTarget: annotations.refreshTarget
  });
  requireFunctions("view port", {
    patchThoughtTarget: view.patchThoughtTarget,
    scheduleAnnotationLayout: view.scheduleAnnotationLayout,
    showToast: view.showToast
  });
  requireFunctions("platform port", {
    requestFrame: platform.requestFrame,
    escapeSelector: platform.escapeSelector
  });
  if (!platform.document || !platform.window) {
    throw new TypeError("Background results feature requires document and window");
  }

  let session = {};
  let navigationEpoch = 0;
  const ticket = () => ({
    session,
    accountId: String(data.getAccountId() || ""),
    navigationEpoch: ++navigationEpoch
  });
  const current = value => value?.session === session
    && value.accountId === String(data.getAccountId() || "")
    && value.navigationEpoch === navigationEpoch;

  function refreshAppliedTarget(task, target) {
    if (target.kind === "captureTranscription") {
      data.publish(["captures"]);
      return true;
    }
    if (target.kind === "annotationShenji") {
      annotations.refreshTarget(target);
      return true;
    }
    if (target.kind === "contentImageUnderstanding") {
      if (target.contentTargetType === "capture") {
        data.publish(["captures"]);
        return true;
      }
      if (target.contentTargetType === "comment") {
        annotations.refreshTarget({
          ...target,
          subtargetId: target.contentTargetId || target.subtargetId
        });
        return true;
      }
      const location = backgroundNavigationTarget(task, null, data.getSnapshot());
      return view.patchThoughtTarget({
        ...target,
        targetId: location?.rootId || target.targetId
      });
    }
    return view.patchThoughtTarget(target);
  }

  const results = createBackgroundResultController({
    loadResult: async task => (
      backgroundResultFromSnapshot(data.getSnapshot(), task)
      || (await data.request(`/api/ai-tasks/${encodeURIComponent(task.id)}/result`)).result
    ),
    applyResult: ({ task, target, result }) => {
      const snapshot = data.getSnapshot();
      if (backgroundResultFromSnapshot(snapshot, task)) return true;
      const merged = mergeBackgroundTaskResult(snapshot, task, result);
      if (!merged.changed) return false;
      data.replaceSnapshot(merged.value);
      return refreshAppliedTarget(task, target);
    },
    captureViewState: () => ({
      x: platform.window.scrollX,
      y: platform.window.scrollY,
      commentScroll: platform.document.querySelector("#comment-panel")?.scrollTop || 0
    }),
    restoreViewState: saved => {
      if (!saved) return;
      platform.window.scrollTo(saved.x, saved.y);
      const panel = platform.document.querySelector("#comment-panel");
      if (panel) panel.scrollTop = saved.commentScroll;
      view.scheduleAnnotationLayout();
    },
    onError: (error, task) => view.showToast(
      task?.kind === "thoughtAnswer"
        ? "思绪原文已保存，后台回答结果暂未同步；可在通知中再次查看重试。"
        : `后台结果同步失败：${error.message}`,
      "error"
    )
  });

  function scrollToTarget(target, value) {
    const selector = value || backgroundTargetSelector(target, platform.escapeSelector);
    if (!selector) return false;
    platform.requestFrame(() => {
      if (!current(target.ticket)) return;
      const element = platform.document.querySelector(selector);
      const DetailsElement = globalThis.HTMLDetailsElement;
      if (typeof DetailsElement === "function" && element instanceof DetailsElement) {
        element.open = true;
      }
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return true;
  }

  async function openTarget(task, notification) {
    const operation = ticket();
    let target = backgroundNavigationTarget(task, notification, data.getSnapshot());
    if (!target) return false;
    if (target.resourceType === "thought") navigation.openThoughtDetail(target.rootId);
    else navigation.switchView(target.view);
    await data.refresh(
      [target.domain, "notifications"],
      target.resourceType === "thought"
        ? {
            chainId: target.rootId,
            followUpId: target.kind === "followUpAnswer" ? target.subtargetId : ""
          }
        : {}
    );
    if (!current(operation)) return false;
    if (task?.kind === "thoughtAnswer" && task.status === "succeeded" && task.resultId) {
      await results.sync([task]);
      if (!current(operation)) return false;
    }
    const refreshedTarget = backgroundNavigationTarget(task, notification, data.getSnapshot());
    if (!refreshedTarget) return false;
    target = { ...refreshedTarget, ticket: operation };
    if (target.annotationId) {
      const opened = await annotations.openTarget(target, () => current(operation));
      if (!current(operation) || opened === false) return false;
      return scrollToTarget(
        target,
        `[data-comment-card="${platform.escapeSelector(target.annotationId)}"]`
      );
    }
    return scrollToTarget(target);
  }

  return Object.freeze({
    sync: tasks => results.sync(tasks),
    forget: taskId => results.forget(taskId),
    needsRetry: () => results.needsRetry(),
    openTarget,
    resetSession() {
      session = {};
      navigationEpoch += 1;
      results.reset();
    }
  });
}
